import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  BankTransactionDirection,
  BankTransactionMatchType,
  BankTransactionSource,
  CounterpartyType,
} from '@prisma/client';
import { TRANSACTION_TIMEOUT_MS, translateError } from '@sto/shared';
import { getLocale } from '../../common/tenant/tenant-context';
import { dateOnlyRangeFilter, isCalendarDate } from '../../common/utils/kyiv-date';
import { searchContains } from '../../common/utils/like-pattern';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CashService } from '../cash/cash.service';
import { ExchangeRatesService } from '../exchange-rates/exchange-rates.service';
import { PaymentsService } from '../payments/payments.service';
import type { PaymentSettlementType } from '../payments/payments.dto';
import { SettlementsService } from '../settlements/settlements.service';
import { SupplierPaymentsService } from '../supplier-payments/supplier-payments.service';
import {
  NO_OUTGOING_LINKS,
  assertOutgoingDirection,
  resolveOutgoingPlan,
  type OutgoingPlan,
} from './bank-outgoing-refs';
import { extractDocumentNumberCandidates, parsePurpose } from './purpose-parser';
import {
  ApplyImportDto,
  BANK_TX_IN_MATCH_TYPES,
  BankTransactionResponseDto,
  CreateBankTransactionDto,
  ReconcileTransactionDto,
  SupplierPaymentCandidateDto,
  UnreconcileTransactionDto,
  IgnoreTransactionDto,
  ListQueryDto,
  MatchTransactionDto,
  PaginatedBankTransactionsDto,
  PreviewCandidateDto,
  PreviewMatchReason,
  PreviewMatchStatus,
  PreviewRowDto,
  toBankTransactionResponseDto,
} from './bank-statement.dto';

/** Сира транзакція для резолву/імпорту (мінімум полів для авто-матчу). */
export interface RawTx {
  externalId: string;
  operationDate: Date;
  /** BR-BANK-017: напрям рядка; не задано — вхідний. */
  direction?: BankTransactionDirection;
  /** Завжди > 0: знак у базі не зберігається, напрям — у `direction`. */
  amount: number;
  payerName?: string | null;
  payerIban?: string | null;
  payerEdrpou?: string | null;
  purpose?: string | null;
  rawData?: Prisma.InputJsonValue;
}

/** Результат авто-матчу однієї транзакції. */
export interface MatchResult {
  status: PreviewMatchStatus;
  counterpartyId?: string;
  counterpartyName?: string;
  matchType?: BankTransactionMatchType;
  invoiceId?: string;
  confidence?: number;
  reason?: PreviewMatchReason;
  candidates: PreviewCandidateDto[];
}

/** Нормалізація IBAN для порівняння: upper-case + прибрати всі пробіли. */
function normalizeIban(iban: string | null | undefined): string | null {
  if (!iban) return null;
  const norm = iban.toUpperCase().replace(/\s+/g, '');
  return norm.length > 0 ? norm : null;
}

/** Ім'я контрагента для UI (компанія → прізвище+ім'я → '—'). */
function counterpartyName(cp: {
  companyName: string | null;
  firstName: string | null;
  lastName: string | null;
}): string {
  if (cp.companyName) return cp.companyName;
  const parts = [cp.lastName, cp.firstName].filter(Boolean);
  return parts.length ? parts.join(' ') : '—';
}

/** Календарний день `@db.Date`-значення як `YYYY-MM-DD`. */
const ymdOf = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * Підказка виду рознесення для знайденого контрагента. Вхідний рядок — `SERVICE` (BR-BANK-004).
 * Вихідний — `SUPPLIER_PAYMENT`, лише якщо контрагент має роль постачальника (BR-BANK-036);
 * для клієнта підказки немає: повернення це чи щось інше — з виписки не видно.
 */
function hintMatchType(
  direction: BankTransactionDirection,
  type: CounterpartyType,
): BankTransactionMatchType | undefined {
  if (direction === 'IN') return 'SERVICE';
  return type === 'SUPPLIER' || type === 'BOTH' ? 'SUPPLIER_PAYMENT' : undefined;
}

/** Ключ «імовірного ручного дубля»: дата + сума + напрям у межах одного рахунку (BR-BANK-037). */
const manualDuplicateKey = (
  date: Date,
  amount: Prisma.Decimal | number,
  direction: BankTransactionDirection,
): string => `${ymdOf(date)}|${Number(amount).toFixed(2)}|${direction}`;

/**
 * Join-и підписів рядка для списку й відповідей рознесення — один запит, без N+1.
 * Форма збігається з тим, що читає `toBankTransactionResponseDto`.
 */
const BANK_TX_INCLUDE = {
  bankAccount: {
    select: { name: true, ibanUA: true, currency: { select: { code: true } } },
  },
  counterparty: { select: { companyName: true, firstName: true, lastName: true } },
  supplierPayment: { select: { number: true } },
  expenseCategory: { select: { name: true } },
  payrollPeriod: { select: { periodStart: true, periodEnd: true } },
  employee: { select: { firstName: true, lastName: true } },
  transferBankAccount: { select: { name: true } },
} satisfies Prisma.BankTransactionInclude;

/** Стан рядка після скасування рознесення / відкату: без виду, посилань і позначки «хто розніс». */
const UNMATCHED_STATE = {
  status: 'UNMATCHED',
  matchedType: null,
  ...NO_OUTGOING_LINKS,
  cashOperationId: null,
  matchedAt: null,
  matchedBy: null,
} satisfies Prisma.BankTransactionUpdateManyMutationInput &
  Prisma.BankTransactionUncheckedUpdateManyInput;

function isInMatchType(type: BankTransactionMatchType | null): boolean {
  return type != null && (BANK_TX_IN_MATCH_TYPES as readonly string[]).includes(type);
}

@Injectable()
export class BankReconciliationService {
  private readonly logger = new Logger(BankReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly exchangeRates: ExchangeRatesService,
    private readonly payments: PaymentsService,
    private readonly settlements: SettlementsService,
    private readonly cash: CashService,
    private readonly supplierPayments: SupplierPaymentsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * BULK авто-матч батчу транзакцій БЕЗ N+1 (макс. 5 findMany на весь батч незалежно від розміру).
   * Пріоритет: (а) payerIban exact-1 → matched 1.0 'iban'; (б) payerEdrpou exact-1 → matched 0.9
   * 'edrpou'; (в) purpose → matched 0.7 'purpose': вхідний рядок — Invoice/WorkOrder за номером,
   * вихідний — PurchaseOrder за номером (BR-BANK-036); інакше notFound.
   * >1 збіг на будь-якому кроці → ambiguous з кандидатами. Повертає Map<externalId, MatchResult>.
   * Для вихідного рядка це лише ПІДКАЗКА: вид — `SUPPLIER_PAYMENT` для постачальника, інакше без виду.
   */
  async resolveBatch(orgId: string, txs: RawTx[]): Promise<Map<string, MatchResult>> {
    const result = new Map<string, MatchResult>();
    if (txs.length === 0) return result;
    const directionByTx = new Map(txs.map(t => [t.externalId, t.direction ?? 'IN'] as const));
    const directionOf = (externalId: string): BankTransactionDirection =>
      directionByTx.get(externalId) ?? 'IN';

    // Ті, що ще не розв'язані (проходять далі по каскаду ознак).
    const unresolved = new Set(txs.map(t => t.externalId));
    const markResolved = (externalId: string, r: MatchResult) => {
      result.set(externalId, r);
      unresolved.delete(externalId);
    };

    // ── (а) IBAN ──────────────────────────────────────────────────────────────
    const ibanByTx = new Map<string, string>(); // externalId → normIban
    for (const t of txs) {
      const norm = normalizeIban(t.payerIban);
      if (norm) ibanByTx.set(t.externalId, norm);
    }
    const uniqueIbans = Array.from(new Set(ibanByTx.values()));
    if (uniqueIbans.length) {
      const cps = await this.prisma.counterparty.findMany({
        where: { orgId, deletedAt: null, iban: { in: uniqueIbans } },
        select: {
          id: true,
          iban: true,
          type: true,
          companyName: true,
          firstName: true,
          lastName: true,
        },
      });
      // Групуємо за нормалізованим IBAN (у БД можуть бути з пробілами → нормалізуємо ключ).
      const byIban = new Map<string, typeof cps>();
      for (const cp of cps) {
        const key = normalizeIban(cp.iban);
        if (!key) continue;
        const arr = byIban.get(key);
        if (arr) arr.push(cp);
        else byIban.set(key, [cp]);
      }
      for (const t of txs) {
        if (!unresolved.has(t.externalId)) continue;
        const norm = ibanByTx.get(t.externalId);
        if (!norm) continue;
        const matches = byIban.get(norm) ?? [];
        if (matches.length === 1) {
          const cp = matches[0];
          markResolved(t.externalId, {
            status: 'matched',
            counterpartyId: cp.id,
            counterpartyName: counterpartyName(cp),
            matchType: hintMatchType(directionOf(t.externalId), cp.type),
            confidence: 1,
            reason: 'iban',
            candidates: [],
          });
        } else if (matches.length > 1) {
          markResolved(t.externalId, {
            status: 'ambiguous',
            reason: 'iban',
            candidates: matches.map(cp => ({
              counterpartyId: cp.id,
              counterpartyName: counterpartyName(cp),
            })),
          });
        }
      }
    }

    // ── (б) ЄДРПОУ ────────────────────────────────────────────────────────────
    const edrpouByTx = new Map<string, string>();
    for (const t of txs) {
      if (!unresolved.has(t.externalId)) continue;
      const e = t.payerEdrpou?.trim();
      if (e) edrpouByTx.set(t.externalId, e);
    }
    const uniqueEdrpou = Array.from(new Set(edrpouByTx.values()));
    if (uniqueEdrpou.length) {
      const cps = await this.prisma.counterparty.findMany({
        where: { orgId, deletedAt: null, edrpou: { in: uniqueEdrpou } },
        select: {
          id: true,
          edrpou: true,
          type: true,
          companyName: true,
          firstName: true,
          lastName: true,
        },
      });
      const byEdrpou = new Map<string, typeof cps>();
      for (const cp of cps) {
        const key = cp.edrpou?.trim();
        if (!key) continue;
        const arr = byEdrpou.get(key);
        if (arr) arr.push(cp);
        else byEdrpou.set(key, [cp]);
      }
      for (const [externalId, edrpou] of edrpouByTx) {
        if (!unresolved.has(externalId)) continue;
        const matches = byEdrpou.get(edrpou) ?? [];
        if (matches.length === 1) {
          const cp = matches[0];
          markResolved(externalId, {
            status: 'matched',
            counterpartyId: cp.id,
            counterpartyName: counterpartyName(cp),
            matchType: hintMatchType(directionOf(externalId), cp.type),
            confidence: 0.9,
            reason: 'edrpou',
            candidates: [],
          });
        } else if (matches.length > 1) {
          markResolved(externalId, {
            status: 'ambiguous',
            reason: 'edrpou',
            candidates: matches.map(cp => ({
              counterpartyId: cp.id,
              counterpartyName: counterpartyName(cp),
            })),
          });
        }
      }
    }

    // ── (в) purpose → Invoice / WorkOrder (вхідні) | PurchaseOrder (вихідні) ───────────────
    const parsedByTx = new Map<string, ReturnType<typeof parsePurpose>>();
    const poCandidatesByTx = new Map<string, string[]>();
    const invoiceNumbers = new Set<string>();
    const workOrderNumbers = new Set<string>();
    const purchaseOrderNumbers = new Set<string>();
    for (const t of txs) {
      if (!unresolved.has(t.externalId)) continue;
      if (directionOf(t.externalId) === 'OUT') {
        const candidates = extractDocumentNumberCandidates(t.purpose);
        poCandidatesByTx.set(t.externalId, candidates);
        for (const c of candidates) purchaseOrderNumbers.add(c);
        continue;
      }
      const parsed = parsePurpose(t.purpose);
      parsedByTx.set(t.externalId, parsed);
      if (parsed.invoiceNumber) invoiceNumbers.add(parsed.invoiceNumber);
      if (parsed.workOrderNumber) workOrderNumbers.add(parsed.workOrderNumber);
    }

    const [invoices, workOrders, purchaseOrders] = await Promise.all([
      invoiceNumbers.size
        ? this.prisma.invoice.findMany({
            where: { orgId, deletedAt: null, number: { in: Array.from(invoiceNumbers) } },
            select: {
              id: true,
              number: true,
              counterpartyId: true,
              counterparty: {
                select: { companyName: true, firstName: true, lastName: true },
              },
            },
          })
        : Promise.resolve([]),
      workOrderNumbers.size
        ? this.prisma.workOrder.findMany({
            where: { orgId, deletedAt: null, number: { in: Array.from(workOrderNumbers) } },
            select: {
              id: true,
              number: true,
              counterpartyId: true,
              counterparty: {
                select: { companyName: true, firstName: true, lastName: true },
              },
            },
          })
        : Promise.resolve([]),
      purchaseOrderNumbers.size
        ? this.prisma.purchaseOrder.findMany({
            where: {
              orgId,
              deletedAt: null,
              number: { in: Array.from(purchaseOrderNumbers) },
              supplier: { deletedAt: null },
            },
            select: {
              number: true,
              supplierId: true,
              supplier: {
                select: { type: true, companyName: true, firstName: true, lastName: true },
              },
            },
          })
        : Promise.resolve([]),
    ]);
    const invByNumber = new Map(invoices.map(i => [i.number, i]));
    const woByNumber = new Map(workOrders.map(w => [w.number, w]));
    const poByNumber = new Map(purchaseOrders.map(p => [p.number, p]));

    for (const t of txs) {
      if (!unresolved.has(t.externalId)) continue;
      const poCandidates = poCandidatesByTx.get(t.externalId);
      if (poCandidates) {
        // Постачальники замовлень, чиї номери згадано в призначенні (один постачальник — один раз).
        const suppliers = new Map<string, (typeof purchaseOrders)[number]>();
        for (const number of poCandidates) {
          const po = poByNumber.get(number);
          if (po) suppliers.set(po.supplierId, po);
        }
        const found = Array.from(suppliers.values());
        if (found.length === 1) {
          const po = found[0];
          markResolved(t.externalId, {
            status: 'matched',
            counterpartyId: po.supplierId,
            counterpartyName: counterpartyName(po.supplier),
            matchType: hintMatchType('OUT', po.supplier.type),
            confidence: 0.7,
            reason: 'purpose',
            candidates: [],
          });
        } else if (found.length > 1) {
          markResolved(t.externalId, {
            status: 'ambiguous',
            reason: 'purpose',
            candidates: found.map(po => ({
              counterpartyId: po.supplierId,
              counterpartyName: counterpartyName(po.supplier),
            })),
          });
        } else {
          markResolved(t.externalId, { status: 'notFound', candidates: [] });
        }
        continue;
      }
      const parsed = parsedByTx.get(t.externalId);
      if (!parsed) {
        markResolved(t.externalId, { status: 'notFound', candidates: [] });
        continue;
      }
      const inv = parsed.invoiceNumber ? invByNumber.get(parsed.invoiceNumber) : undefined;
      if (inv?.counterpartyId) {
        markResolved(t.externalId, {
          status: 'matched',
          counterpartyId: inv.counterpartyId,
          counterpartyName: counterpartyName(inv.counterparty),
          matchType: 'INVOICE',
          invoiceId: inv.id,
          confidence: 0.7,
          reason: 'purpose',
          candidates: [],
        });
        continue;
      }
      const wo = parsed.workOrderNumber ? woByNumber.get(parsed.workOrderNumber) : undefined;
      if (wo?.counterpartyId) {
        markResolved(t.externalId, {
          status: 'matched',
          counterpartyId: wo.counterpartyId,
          counterpartyName: counterpartyName(wo.counterparty),
          matchType: 'SERVICE',
          confidence: 0.7,
          reason: 'purpose',
          candidates: [],
        });
        continue;
      }
      markResolved(t.externalId, { status: 'notFound', candidates: [] });
    }

    return result;
  }

  /**
   * Прев'ю імпорту виписки: авто-матч (resolveBatch) + дедуп-check проти вже наявних BankTransaction
   * по externalId (bulk). Нічого не пише. Наявні externalId → matchStatus='duplicate'.
   */
  async previewImport(
    orgId: string,
    bankAccountId: string,
    rows: RawTx[],
  ): Promise<PreviewRowDto[]> {
    const matches = await this.resolveBatch(orgId, rows);

    // Два запити на батч (паралельно), обидва — лише у своєму рахунку:
    //  - дедуп: які externalId вже імпортовано (разом із видаленими — унікальний ключ їх теж тримає);
    //  - BR-BANK-037: внесені ВРУЧНУ живі рядки на дати батчу — у них інший externalId
    //    (`MANUAL-…`), тож ключ ідемпотентності такий дубль не ловить.
    const externalIds = Array.from(new Set(rows.map(r => r.externalId)));
    const dates = Array.from(new Set(rows.map(r => ymdOf(r.operationDate)))).map(
      d => new Date(`${d}T00:00:00.000Z`),
    );
    const [existing, manual] = rows.length
      ? await Promise.all([
          this.prisma.bankTransaction.findMany({
            where: { orgId, bankAccountId, externalId: { in: externalIds } },
            select: { externalId: true },
          }),
          this.prisma.bankTransaction.findMany({
            where: {
              orgId,
              bankAccountId,
              deletedAt: null,
              source: 'MANUAL',
              operationDate: { in: dates },
            },
            select: { operationDate: true, amount: true, direction: true },
          }),
        ])
      : [[], []];
    const existingSet = new Set(existing.map(e => e.externalId));
    const manualKeys = new Set(
      manual.map(e => manualDuplicateKey(e.operationDate, e.amount, e.direction)),
    );

    return rows.map((r, idx) => {
      const m = matches.get(r.externalId);
      const direction = r.direction ?? 'IN';
      const isDuplicate = existingSet.has(r.externalId);
      const matchStatus: PreviewMatchStatus = isDuplicate ? 'duplicate' : (m?.status ?? 'notFound');
      return {
        rowIndex: idx,
        direction,
        possibleManualDuplicate: manualKeys.has(
          manualDuplicateKey(r.operationDate, r.amount, direction),
        ),
        operationDate:
          r.operationDate instanceof Date ? r.operationDate.toISOString() : r.operationDate,
        amount: r.amount,
        payerName: r.payerName ?? null,
        payerIban: r.payerIban ?? null,
        payerEdrpou: r.payerEdrpou ?? null,
        purpose: r.purpose ?? null,
        externalId: r.externalId,
        matchStatus,
        suggestedCounterpartyId: m?.counterpartyId ?? null,
        suggestedCounterpartyName: m?.counterpartyName ?? null,
        suggestedMatchType: m?.matchType ?? null,
        suggestedInvoiceId: m?.invoiceId ?? null,
        matchReason: m?.reason ?? null,
        matchConfidence: m?.confidence ?? null,
        candidates: m?.candidates ?? [],
      };
    });
  }

  /**
   * Guarded-парс operationDate з ApplyRowDto (money-critical: визначає курс для amountBase).
   * Мірорить rollover-guard провайдерів/парсера: '2026-02-31' тихо перекочує у 03-02, 'garbage' →
   * Invalid Date. Приймаємо YYYY-MM-DD (компонентна звірка) та повний ISO з зоною/часом (нативний
   * парсер: V8 відкидає неможливі компоненти у NaN). Невалідне → 400 BadRequest.
   */
  private parseApplyRowDate(value: string): Date {
    const s = (value ?? '').trim();
    const isoDate = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (isoDate) {
      const y = Number(isoDate[1]);
      const mo = Number(isoDate[2]) - 1;
      const day = Number(isoDate[3]);
      const d = new Date(Date.UTC(y, mo, day));
      if (
        !Number.isNaN(d.getTime()) &&
        d.getUTCFullYear() === y &&
        d.getUTCMonth() === mo &&
        d.getUTCDate() === day
      ) {
        return d;
      }
    } else if (/^\d{4}-\d{2}-\d{2}[T ]/.test(s)) {
      // Повний ISO з часом/зоною: неможливі компоненти → V8 дає NaN (не rollover).
      const d = new Date(s);
      if (!Number.isNaN(d.getTime())) return d;
    }
    throw new BadRequestException(
      translateError('err.bankStatement.invalidOperationDate', getLocale(), { value: s }),
    );
  }

  /**
   * Застосувати імпорт виписки: валідація рахунку + createMany UNMATCHED-транзакцій зі
   * skipDuplicates (unique externalId — ідемпотентність повторного імпорту). amountBase рахуємо
   * по валюті рахунку на дату операції. Повертає {created, skipped}.
   */
  async applyImport(
    orgId: string,
    dto: ApplyImportDto,
    source: BankTransactionSource = 'FILE_IMPORT',
  ): Promise<{ created: number; skipped: number }> {
    const bankAccount = await this.prisma.bankAccount.findFirst({
      where: { id: dto.bankAccountId, orgId, deletedAt: null },
      select: { id: true, currencyId: true, ibanUA: true },
    });
    if (!bankAccount) {
      throw new NotFoundException(
        translateError('err.bankStatement.bankAccountNotFound', getLocale()),
      );
    }
    const ownIban = normalizeIban(bankAccount.ibanUA);

    // Обчислюємо amountBase для кожного рядка (валюта = валюта рахунку) ДО транзакції — конвертація
    // читає курси (не мутує), тож поза $transaction (коротша транзакція, менше lock-hold).
    const prepared = await Promise.all(
      dto.rows.map(async row => {
        // MONEY-CRITICAL: operationDate визначає курс для amountBase (resolveBaseConversion).
        // ApplyRowDto.operationDate — лише @IsString (public POST import/apply), тож НЕ можна довіряти
        // нативному `new Date(...)`: '2026-02-31' тихо перекочує у 03-02 → неправильний курс, а
        // 'garbage' → Invalid Date → падіння на @db.Date. Той самий rollover-guard, що й у провайдерах
        // (privat24/parser). Невалідна дата → 400 (не тихе спотворення).
        const operationDate = this.parseApplyRowDate(row.operationDate);
        const conv = await this.exchangeRates.resolveBaseConversion(
          orgId,
          bankAccount.currencyId,
          operationDate,
          row.amount,
          true, // fallbackToLatest: імпорт виписки — документний потік
        );
        // BR-BANK-020: payerIban — IBAN КОНТРАГЕНТА. Виписки часто мають колонку з нашим власним
        // рахунком; збережений як IBAN контрагента, він зводив би авто-матч до пошуку нас самих.
        const normIban = normalizeIban(row.payerIban);
        const iban = normIban && normIban === ownIban ? null : normIban;
        return {
          orgId,
          bankAccountId: bankAccount.id,
          direction: row.direction ?? ('IN' as const),
          amount: row.amount,
          currencyId: bankAccount.currencyId,
          amountBase: conv.amountBase,
          rateUsed: conv.rateUsed,
          operationDate,
          payerName: row.payerName ?? null,
          payerIban: iban,
          payerEdrpou: row.payerEdrpou?.trim() || null,
          purpose: row.purpose ?? null,
          externalId: row.externalId,
          source,
          status: 'UNMATCHED' as const,
          rawData: row.rawData ?? Prisma.JsonNull,
        };
      }),
    );

    const created = await this.prisma.$transaction(
      async tx => {
        const res = await tx.bankTransaction.createMany({
          data: prepared,
          skipDuplicates: true, // unique (orgId, bankAccountId, externalId) — ідемпотентність
        });
        return res.count;
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );

    return { created, skipped: dto.rows.length - created };
  }

  /** Список банк-транзакцій (пагінація, фільтр статусу). orderBy operationDate desc. */
  async list(orgId: string, query: ListQueryDto): Promise<PaginatedBankTransactionsDto> {
    const safeLimit = Math.min(Math.max(query.limit ?? 20, 1), 200);
    const safePage = Math.max(query.page ?? 1, 1);

    const where: Prisma.BankTransactionWhereInput = { orgId, deletedAt: null };
    if (query.status) where.status = query.status;
    if (query.direction) where.direction = query.direction;
    const operationDate = dateOnlyRangeFilter(query.dateFrom, query.dateTo);
    if (operationDate) where.operationDate = operationDate;
    const contains = searchContains(query.q);
    if (contains) {
      where.OR = [
        { payerName: contains },
        { purpose: contains },
        // IBAN зберігається нормалізованим (UPPERCASE, без пробілів — BR-BANK-006): шукаємо так само
        { payerIban: searchContains(query.q?.replace(/\s+/g, '')) },
        { payerEdrpou: contains },
      ];
    }

    const skip = (safePage - 1) * safeLimit;
    const [items, total] = await Promise.all([
      this.prisma.bankTransaction.findMany({
        where,
        skip,
        take: safeLimit,
        orderBy: { operationDate: 'desc' },
        // Назва/IBAN + код валюти нашого рахунку — для колонки «Рахунок» і коректного символу валюти
        // суми (multi-bank: рахунок може бути USD/EUR — не хардкодимо ₴); решта join-ів — підписи
        // колонки «Рознесено як».
        include: BANK_TX_INCLUDE,
      }),
      this.prisma.bankTransaction.count({ where }),
    ]);
    return {
      items: items.map(toBankTransactionResponseDto),
      total,
      page: safePage,
      limit: safeLimit,
    };
  }

  /**
   * Рознесення транзакції на контрагента + створення Payment. Порядок (payments.create відкриває
   * ВЛАСНУ транзакцію — НЕ обгортаємо у зовнішню):
   *  1) CAS-mark MATCHED (updateMany where status=UNMATCHED, paymentId=null) — idempotency-guard;
   *     count===0 → вже рознесено/не існує → Conflict/NotFound.
   *  2) payments.create (з settlementType за matchType) — власна транзакція.
   *  3) update BankTransaction.paymentId = payment.id (idempotency-лінк).
   *  На помилку create — відкат status=UNMATCHED (лишити retriable), проброс помилки.
   */
  async matchTransaction(
    orgId: string,
    txId: string,
    dto: MatchTransactionDto,
    userId?: string,
  ): Promise<BankTransactionResponseDto> {
    if (dto.type === 'INVOICE' && !dto.invoiceId) {
      throw new BadRequestException(
        translateError('err.bankStatement.invoiceRequiredForType', getLocale()),
      );
    }

    // Валідація контрагента (у межах org) — до CAS, щоб не блокувати транзакцію на битому вводі.
    const counterparty = await this.prisma.counterparty.findFirst({
      where: { id: dto.counterpartyId, orgId, deletedAt: null },
      select: { id: true },
    });
    if (!counterparty) {
      throw new NotFoundException(
        translateError('err.bankStatement.counterpartyNotFound', getLocale()),
      );
    }
    if (dto.type === 'INVOICE' && dto.invoiceId) {
      const inv = await this.prisma.invoice.findFirst({
        where: { id: dto.invoiceId, orgId, deletedAt: null },
        select: { id: true, counterpartyId: true },
      });
      if (!inv) {
        throw new NotFoundException(
          translateError('err.bankStatement.invoiceNotFound', getLocale()),
        );
      }
      // BR-BANK-010 / BR-PAY-016: рахунок закриває лише його платник. PaymentsService.create
      // відмовив би так само, але вже після захоплення рядка — тут відмовляємо ДО CAS, щоб не
      // робити захоплення й відкат на завідомо хибному вводі.
      if (inv.counterpartyId !== dto.counterpartyId) {
        throw new BadRequestException(
          translateError('err.payment.invoiceNotForCounterparty', getLocale()),
        );
      }
    }

    // (1) CAS-mark MATCHED — атомарний захват staging-рядка (idempotency проти подвійного match).
    // BR-BANK-025: `direction: 'IN'` у самому CAS — вихідний рядок цей endpoint не захопить ніколи,
    // інакше списання стало б оплатою клієнта.
    const marked = await this.prisma.bankTransaction.updateMany({
      where: {
        id: txId,
        orgId,
        deletedAt: null,
        direction: 'IN',
        status: 'UNMATCHED',
        paymentId: null,
      },
      data: {
        status: 'MATCHED',
        counterpartyId: dto.counterpartyId,
        matchedType: dto.type,
        matchedAt: new Date(),
        matchedBy: userId ?? null,
      },
    });
    if (marked.count === 0) {
      // Розрізняємо «не існує» / «вихідний рядок» / «вже рознесено».
      const exists = await this.prisma.bankTransaction.findFirst({
        where: { id: txId, orgId, deletedAt: null },
        select: { id: true, status: true, direction: true },
      });
      if (!exists) {
        throw new NotFoundException(translateError('err.bankStatement.txNotFound', getLocale()));
      }
      if (exists.status === 'UNMATCHED' && exists.direction === 'OUT') {
        throw new BadRequestException(
          translateError('err.bankStatement.wrongDirection', getLocale()),
        );
      }
      throw new ConflictException(translateError('err.bankStatement.alreadyMatched', getLocale()));
    }

    // Читаємо захоплений рядок (сума + рахунок для Payment).
    const tx = await this.prisma.bankTransaction.findFirst({
      where: { id: txId, orgId },
      select: { id: true, amount: true, bankAccountId: true },
    });
    if (!tx) {
      throw new NotFoundException(translateError('err.bankStatement.txNotFound', getLocale()));
    }

    // (2) payments.create — власна транзакція (settlement + fiscal + ін.). На помилку відкат.
    const settlementType: PaymentSettlementType =
      dto.type === 'PREPAYMENT' ? 'PREPAYMENT' : dto.type === 'REFUND' ? 'REFUND' : 'PAYMENT';
    let paymentId: string;
    try {
      const payment = await this.payments.create(
        orgId,
        {
          counterpartyId: dto.counterpartyId,
          invoiceId: dto.type === 'INVOICE' ? dto.invoiceId : undefined,
          amount: Number(tx.amount),
          method: 'bank',
          sourceType: 'BANK_ACCOUNT',
          bankAccountId: tx.bankAccountId,
          settlementType,
        },
        userId,
      );
      paymentId = payment.id;
    } catch (err: unknown) {
      // Відкат status=UNMATCHED — лишаємо транзакцію retriable (payment НЕ створено).
      await this.prisma.bankTransaction
        .updateMany({
          where: { id: txId, orgId, status: 'MATCHED', paymentId: null },
          data: {
            status: 'UNMATCHED',
            counterpartyId: null,
            matchedType: null,
            matchedAt: null,
            matchedBy: null,
          },
        })
        .catch(e =>
          this.logger.warn(
            `Не вдалось відкотити статус банк-транзакції ${txId}: ${e instanceof Error ? e.message : e}`,
          ),
        );
      // Пробрасуємо оригінальну помилку payments.create (валідні 4xx — валюта/статус рахунку тощо).
      throw err;
    }

    // (3) Лінк paymentId (idempotency — 1 Payment на транзакцію через @unique paymentId).
    await this.prisma.bankTransaction.updateMany({
      where: { id: txId, orgId, status: 'MATCHED' },
      data: { paymentId },
    });

    const updated = await this.prisma.bankTransaction.findFirstOrThrow({
      where: { id: txId, orgId },
    });
    return toBankTransactionResponseDto(updated);
  }

  // ─── Вихідні платежі: ручне внесення, рознесення, скасування ─────────────────────────────

  /** Рядок із підписами (join-и `BANK_TX_INCLUDE`) → response DTO. */
  private async loadResponse(orgId: string, txId: string): Promise<BankTransactionResponseDto> {
    const row = await this.prisma.bankTransaction.findFirstOrThrow({
      where: { id: txId, orgId },
      include: BANK_TX_INCLUDE,
    });
    return toBankTransactionResponseDto(row);
  }

  /** Чому CAS зі статусу `UNMATCHED` нічого не захопив: рядка немає (404) чи він уже оброблений (409). */
  private async captureFailure(
    db: Prisma.TransactionClient | PrismaService,
    orgId: string,
    txId: string,
  ): Promise<NotFoundException | ConflictException> {
    const exists = await db.bankTransaction.findFirst({
      where: { id: txId, orgId, deletedAt: null },
      select: { id: true },
    });
    return exists
      ? new ConflictException(translateError('err.bankStatement.alreadyMatched', getLocale()))
      : new NotFoundException(translateError('err.bankStatement.txNotFound', getLocale()));
  }

  /** BR-BANK-023: ручне внесення платежу (обидва напрямки), `source=MANUAL`, `status=UNMATCHED`. */
  async createManual(
    orgId: string,
    dto: CreateBankTransactionDto,
    userId?: string,
  ): Promise<BankTransactionResponseDto> {
    const bankAccount = await this.prisma.bankAccount.findFirst({
      where: { id: dto.bankAccountId, orgId, deletedAt: null },
      select: { id: true, currencyId: true, ibanUA: true },
    });
    if (!bankAccount) {
      throw new NotFoundException(
        translateError('err.bankStatement.bankAccountNotFound', getLocale()),
      );
    }
    // DTO вже відсіює неіснуючу дату; повтор тут — для викликів повз ValidationPipe: дата визначає
    // курс, а `new Date('2026-02-31T…')` — Invalid Date, що впав би на `@db.Date` із 500.
    if (!isCalendarDate(dto.operationDate)) {
      throw new BadRequestException(
        translateError('err.bankStatement.invalidOperationDate', getLocale(), {
          value: dto.operationDate,
        }),
      );
    }
    // `@db.Date`: календарний день без часу, тому UTC-північ, а не мить із зсувом на пояс.
    const operationDate = new Date(`${dto.operationDate}T00:00:00.000Z`);
    const conv = await this.exchangeRates.resolveBaseConversion(
      orgId,
      bankAccount.currencyId,
      operationDate,
      dto.amount,
      true,
    );
    const normIban = normalizeIban(dto.payerIban);

    const created = await this.prisma.bankTransaction.create({
      data: {
        orgId,
        bankAccountId: bankAccount.id,
        direction: dto.direction,
        amount: dto.amount,
        currencyId: bankAccount.currencyId,
        amountBase: conv.amountBase,
        rateUsed: conv.rateUsed,
        operationDate,
        payerName: dto.payerName?.trim() || null,
        // BR-BANK-020: власний IBAN рахунку не зберігається як IBAN контрагента.
        payerIban: normIban && normIban === normalizeIban(bankAccount.ibanUA) ? null : normIban,
        payerEdrpou: dto.payerEdrpou?.trim() || null,
        purpose: dto.purpose?.trim() || null,
        externalId: `MANUAL-${randomUUID()}`,
        source: 'MANUAL',
        status: 'UNMATCHED',
        createdBy: userId ?? null,
      },
      include: BANK_TX_INCLUDE,
    });
    return toBankTransactionResponseDto(created);
  }

  /** BR-BANK-024: soft delete лише ручного нерознесеного рядка (CAS); інакше 400 / 404 / 409. */
  async removeManual(orgId: string, txId: string): Promise<void> {
    const removed = await this.prisma.bankTransaction.updateMany({
      where: { id: txId, orgId, deletedAt: null, source: 'MANUAL', status: 'UNMATCHED' },
      data: { deletedAt: new Date() },
    });
    if (removed.count > 0) return;

    const exists = await this.prisma.bankTransaction.findFirst({
      where: { id: txId, orgId, deletedAt: null },
      select: { source: true },
    });
    if (!exists) {
      throw new NotFoundException(translateError('err.bankStatement.txNotFound', getLocale()));
    }
    if (exists.source !== 'MANUAL') {
      throw new BadRequestException(translateError('err.bankStatement.notManual', getLocale()));
    }
    throw new ConflictException(translateError('err.bankStatement.notUnmatched', getLocale()));
  }

  /**
   * BR-BANK-027: проведені оплати постачальнику, до яких можна прив'язати цей вихідний рядок —
   * той самий рахунок, валюта й сума, ще не прив'язані до іншого рядка. Для рядка, який
   * прив'язати не можна (вхідний або вже оброблений), — порожній список.
   */
  async listSupplierPaymentCandidates(
    orgId: string,
    txId: string,
  ): Promise<SupplierPaymentCandidateDto[]> {
    const row = await this.prisma.bankTransaction.findFirst({
      where: { id: txId, orgId, deletedAt: null },
      select: {
        direction: true,
        status: true,
        bankAccountId: true,
        currencyId: true,
        amount: true,
      },
    });
    if (!row) {
      throw new NotFoundException(translateError('err.bankStatement.txNotFound', getLocale()));
    }
    if (row.direction !== 'OUT' || row.status !== 'UNMATCHED') return [];

    const payments = await this.prisma.supplierPayment.findMany({
      where: {
        orgId,
        deletedAt: null,
        status: 'CONFIRMED',
        sourceType: 'BANK_ACCOUNT',
        bankAccountId: row.bankAccountId,
        currencyId: row.currencyId,
        amount: row.amount,
        bankTransaction: null,
      },
      orderBy: { documentDate: 'desc' },
      take: 20,
      select: {
        id: true,
        number: true,
        documentDate: true,
        amount: true,
        supplierId: true,
        purchaseOrderId: true,
        supplier: { select: { companyName: true, firstName: true, lastName: true } },
        purchaseOrder: { select: { number: true } },
      },
    });
    return payments.map(p => ({
      id: p.id,
      number: p.number,
      documentDate: ymdOf(p.documentDate),
      amount: Number(p.amount),
      supplierId: p.supplierId,
      supplierName: counterpartyName(p.supplier),
      purchaseOrderId: p.purchaseOrderId ?? null,
      purchaseOrderNumber: p.purchaseOrder?.number ?? null,
    }));
  }

  /**
   * BR-BANK-025…034: рознесення рядка за `dto.type`. Порядок: рядок (404) → напрям проти виду
   * (400) → посилання виду (400 / 404 / 409) → дія. До дії рядок не чіпається.
   *
   * Усі види, крім нової оплати постачальнику, — ОДНА транзакція БД: CAS-захоплення зі статусу
   * `UNMATCHED` разом із посиланнями, потім ефект (проведення / касова операція). Програний CAS →
   * 409 без другого ефекту; помилка ефекту відкочує й захоплення — рядок лишається `UNMATCHED`.
   * Суму, рахунок, валюту й дату бере з рядка, ніколи з запиту (BR-BANK-026).
   */
  async reconcile(
    orgId: string,
    txId: string,
    dto: ReconcileTransactionDto,
    userId: string,
  ): Promise<BankTransactionResponseDto> {
    const row = await this.prisma.bankTransaction.findFirst({
      where: { id: txId, orgId, deletedAt: null },
      select: {
        id: true,
        direction: true,
        bankAccountId: true,
        currencyId: true,
        amount: true,
        operationDate: true,
        purpose: true,
      },
    });
    if (!row) {
      throw new NotFoundException(translateError('err.bankStatement.txNotFound', getLocale()));
    }
    assertOutgoingDirection(row.direction, dto.type);
    const plan = await resolveOutgoingPlan(this.prisma, orgId, row, dto);

    if (plan.kind === 'NEW_SUPPLIER_PAYMENT') {
      await this.reconcileNewSupplierPayment(orgId, row, plan, userId);
      return this.loadResponse(orgId, txId);
    }

    const amount = Number(row.amount);
    try {
      await this.prisma.$transaction(
        async tx => {
          const captured = await tx.bankTransaction.updateMany({
            where: { id: txId, orgId, deletedAt: null, status: 'UNMATCHED' },
            data: {
              status: 'MATCHED',
              matchedType: dto.type,
              ...plan.links,
              matchedAt: new Date(),
              matchedBy: userId,
            },
          });
          if (captured.count === 0) {
            throw await this.captureFailure(tx, orgId, txId);
          }

          if (plan.kind === 'CLIENT_REFUND') {
            // BR-BANK-030: гроші повернуто клієнту → він знову винен / його аванс зменшився.
            // `date` — лише для курсу; саме проведення датується моментом рознесення (BR-BANK-035).
            await this.settlements.createTransaction(
              orgId,
              {
                counterpartyId: plan.counterpartyId,
                type: 'REFUND_OUT',
                amount,
                currencyId: row.currencyId,
                date: row.operationDate,
                fallbackToLatest: true,
                documentType: 'BankTransaction',
                documentId: txId,
                createdBy: userId,
              },
              tx,
            );
          }

          if (plan.kind === 'CASH_WITHDRAWAL') {
            // BR-BANK-034: готівка, знята з рахунку, надходить у касу. Без статті руху коштів —
            // це переміщення власних грошей, а не дохід. Фіскальна каса без відкритої зміни →
            // 400 із CashService, і транзакція відкочує захоплення рядка.
            const operation = await this.cash.createOperation(
              orgId,
              {
                cashRegisterId: plan.cashRegisterId,
                direction: 'IN',
                reason: 'MANUAL_IN',
                amount,
                documentType: 'BankTransaction',
                documentId: txId,
                createdBy: userId,
              },
              tx,
            );
            await tx.bankTransaction.updateMany({
              where: { id: txId, orgId },
              data: { cashOperationId: operation.id },
            });
          }
        },
        { timeout: TRANSACTION_TIMEOUT_MS },
      );
    } catch (e: unknown) {
      // Одна оплата постачальнику ↔ один рядок: друга прив'язка впирається в унікальний індекс.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException(
          translateError('err.bankStatement.supplierPaymentAlreadyLinked', getLocale()),
        );
      }
      throw e;
    }
    return this.loadResponse(orgId, txId);
  }

  /**
   * BR-BANK-028 / 029: нова оплата постачальнику з рядка. `SupplierPaymentsService.create` і
   * `confirm` відкривають ВЛАСНІ транзакції (не обгортати), тому тут «захоплення → дія → відкат»:
   *  1) CAS-захоплення рядка (програний → 409 / 404, оплата не створюється);
   *  2) чернетка оплати: рахунок, сума й валюта рядка, `documentDate = operationDate`;
   *  3) посилання на чернетку в рядку — ДО проведення, щоб проведена оплата не лишилась без рядка;
   *  4) `confirm` із курсом на `operationDate` (усі правила BR-SUPPAY-* — його).
   * Збій на кроках 2–4 → чернетка скасовується, рядок повертається в `UNMATCHED`, клієнт
   * отримує початкову помилку.
   */
  private async reconcileNewSupplierPayment(
    orgId: string,
    row: {
      id: string;
      bankAccountId: string;
      amount: Prisma.Decimal;
      operationDate: Date;
      purpose: string | null;
    },
    plan: Extract<OutgoingPlan, { kind: 'NEW_SUPPLIER_PAYMENT' }>,
    userId: string,
  ): Promise<void> {
    // `matchedAt` of THIS capture doubles as its token: the steps below run outside one DB
    // transaction, and in between the row can be released (unreconcile) and captured again by
    // another request. Every later write is pinned to the token, so it never touches a capture
    // that is no longer ours.
    const capturedAt = new Date();
    const captured = await this.prisma.bankTransaction.updateMany({
      where: { id: row.id, orgId, deletedAt: null, status: 'UNMATCHED' },
      data: {
        status: 'MATCHED',
        matchedType: 'SUPPLIER_PAYMENT',
        counterpartyId: plan.supplierId,
        matchedAt: capturedAt,
        matchedBy: userId,
      },
    });
    if (captured.count === 0) {
      throw await this.captureFailure(this.prisma, orgId, row.id);
    }

    let draftId: string | null = null;
    try {
      const draft = await this.supplierPayments.create(
        orgId,
        {
          supplierId: plan.supplierId,
          sourceType: 'BANK_ACCOUNT',
          bankAccountId: row.bankAccountId,
          amount: Number(row.amount),
          method: 'bank',
          documentDate: ymdOf(row.operationDate),
          purchaseOrderId: plan.purchaseOrderId,
          notes: row.purpose ?? undefined,
        },
        userId,
      );
      draftId = draft.id;
      const linked = await this.prisma.bankTransaction.updateMany({
        where: {
          id: row.id,
          orgId,
          status: 'MATCHED',
          matchedType: 'SUPPLIER_PAYMENT',
          matchedAt: capturedAt,
          supplierPaymentId: null,
        },
        data: { supplierPaymentId: draft.id },
      });
      // Рядок встигли звільнити (скасування рознесення) між захопленням і цим кроком — а може, й
      // захопити знову іншим запитом: проводити оплату для вже не нашого рядка не можна.
      if (linked.count === 0) {
        throw new ConflictException(
          translateError('err.bankStatement.alreadyMatched', getLocale()),
        );
      }
      await this.supplierPayments.confirm(orgId, draft.id, userId, {
        rateDate: row.operationDate,
      });
    } catch (err: unknown) {
      await this.rollbackNewSupplierPayment(orgId, row.id, draftId, capturedAt);
      throw err;
    }
  }

  /**
   * Відкат невдалої нової оплати постачальнику (BR-BANK-029): чернетка → `CANCELLED`, рядок →
   * `UNMATCHED` без посилань. Чернетка, яку не вдалося скасувати, рядок не тримає: вона нічого
   * не провела й лишається чернеткою.
   *
   * Єдиний виняток — оплата, яка ВЖЕ проведена: `confirm` міг упасти після коміту своєї
   * транзакції (на читанні відповіді). Тоді `cancel` відмовляє, а звільнений рядок дозволив би
   * заплатити постачальнику вдруге — тому рядок лишається `MATCHED` із посиланням на оплату.
   */
  private async rollbackNewSupplierPayment(
    orgId: string,
    txId: string,
    draftId: string | null,
    capturedAt: Date,
  ): Promise<void> {
    if (draftId && !(await this.cancelDraftOrDetectPosted(orgId, txId, draftId))) return;
    await this.prisma.bankTransaction
      .updateMany({
        where: {
          id: txId,
          orgId,
          status: 'MATCHED',
          matchedType: 'SUPPLIER_PAYMENT',
          // Лише НАШЕ захоплення: рядок, який тим часом звільнили й захопили знову, не чіпаємо.
          matchedAt: capturedAt,
          supplierPaymentId: draftId,
        },
        data: UNMATCHED_STATE,
      })
      .catch(e =>
        this.logger.warn(
          `Не вдалось відкотити статус банк-транзакції ${txId}: ${e instanceof Error ? e.message : e}`,
        ),
      );
  }

  /**
   * Скасовує чернетку оплати. `true` — рядок можна звільняти (чернетку скасовано або вона так і
   * лишилась непроведеною); `false` — оплата проведена або її стан з'ясувати не вдалося.
   */
  private async cancelDraftOrDetectPosted(
    orgId: string,
    txId: string,
    draftId: string,
  ): Promise<boolean> {
    try {
      await this.supplierPayments.cancel(orgId, draftId);
      return true;
    } catch (cancelError: unknown) {
      const reason = cancelError instanceof Error ? cancelError.message : String(cancelError);
      try {
        const payment = await this.prisma.supplierPayment.findFirst({
          where: { id: draftId, orgId },
          select: { status: true },
        });
        if (payment?.status !== 'CONFIRMED') {
          this.logger.warn(
            `Банк-транзакція ${txId}: чернетку оплати постачальнику ${draftId} не скасовано (${reason}) — рядок звільняю`,
          );
          return true;
        }
      } catch {
        // Стан оплати невідомий — нижче обираємо безпечний бік: рядок не звільняємо.
      }
      this.logger.error(
        `Банк-транзакція ${txId}: оплата постачальнику ${draftId} проведена або її стан невідомий (${reason}) — рядок лишаю рознесеним`,
      );
      return false;
    }
  }

  /**
   * BR-BANK-039 / 040: скасування рознесення з обов'язковою причиною. Лише для рядка, рознесеного
   * через `reconcile`: вхідний, рознесений через `match` (створено Payment), → 400 — сторно оплати
   * клієнта в системі немає; не `MATCHED` → 409.
   *
   * Одна транзакція БД: CAS зі статусу `MATCHED` (програний → 409 без другого зворотного запису),
   * потім зворотний ефект. Його збій (наприклад, у касі вже немає готівки) відкочує й CAS —
   * рядок лишається `MATCHED`.
   */
  async unreconcile(
    orgId: string,
    txId: string,
    dto: UnreconcileTransactionDto,
    userId: string,
  ): Promise<BankTransactionResponseDto> {
    const row = await this.prisma.bankTransaction.findFirst({
      where: { id: txId, orgId, deletedAt: null },
      select: {
        status: true,
        matchedType: true,
        paymentId: true,
        amount: true,
        currencyId: true,
        operationDate: true,
        counterpartyId: true,
        supplierPaymentId: true,
        expenseCategoryId: true,
        payrollPeriodId: true,
        employeeId: true,
        transferBankAccountId: true,
        cashOperationId: true,
        matchedAt: true,
      },
    });
    if (!row) {
      throw new NotFoundException(translateError('err.bankStatement.txNotFound', getLocale()));
    }
    // Вхідний вид без paymentId — `match` у польоті (Payment ще створюється): теж не наш випадок.
    if (row.paymentId || (row.status === 'MATCHED' && isInMatchType(row.matchedType))) {
      throw new BadRequestException(
        translateError('err.bankStatement.unmatchIncomingUnsupported', getLocale()),
      );
    }
    const matchedType = row.matchedType;
    if (row.status !== 'MATCHED' || !matchedType) {
      throw new ConflictException(translateError('err.bankStatement.notMatched', getLocale()));
    }
    const reason = dto.reason.trim();
    const amount = Number(row.amount);
    const notMatched = () =>
      new ConflictException(translateError('err.bankStatement.notMatched', getLocale()));

    await this.prisma.$transaction(
      async tx => {
        const released = await tx.bankTransaction.updateMany({
          where: {
            id: txId,
            orgId,
            deletedAt: null,
            status: 'MATCHED',
            paymentId: null,
            matchedType,
            // Звільняємо саме ТЕ рознесення, яке прочитали вище: між читанням і цим записом рядок
            // могли скасувати й рознести знову тим самим видом на іншого контрагента чи касу —
            // тоді сторно пішло б на старі дані. `matchedAt` — мітка рознесення; посилання, що
            // визначають зворотний запис, звіряються теж.
            matchedAt: row.matchedAt,
            counterpartyId: row.counterpartyId,
            supplierPaymentId: row.supplierPaymentId,
            cashOperationId: row.cashOperationId,
          },
          data: {
            ...UNMATCHED_STATE,
            unmatchReason: reason,
            unmatchedAt: new Date(),
            unmatchedBy: userId,
          },
        });
        if (released.count === 0) {
          throw notMatched();
        }

        if (matchedType === 'CLIENT_REFUND') {
          if (!row.counterpartyId) throw notMatched();
          // Сторно дзеркалить ПОЧАТКОВЕ проведення: його суму, валюту, курс і суму в базовій
          // валюті. Перераховувати за курсом на `operationDate` не можна — курс на цю дату могли
          // додати чи виправити вже після рознесення, і в балансі клієнта лишилась би різниця.
          // Останнє REFUND_OUT цього рядка — саме те, що скасовуємо: кожне попереднє вже має сторно.
          const original = await tx.settlementTransaction.findFirst({
            where: {
              orgId,
              documentType: 'BankTransaction',
              documentId: txId,
              type: 'REFUND_OUT',
            },
            orderBy: { createdAt: 'desc' },
            select: { amount: true, currencyId: true, amountBase: true, rateUsed: true },
          });
          if (!original || original.amountBase == null || original.rateUsed == null) {
            throw notMatched();
          }
          await this.settlements.createTransaction(
            orgId,
            {
              counterpartyId: row.counterpartyId,
              type: 'REFUND_OUT_CANCEL',
              amount: Number(original.amount),
              currencyId: original.currencyId ?? undefined,
              conversion: {
                rateUsed: Number(original.rateUsed),
                amountBase: Number(original.amountBase),
              },
              documentType: 'BankTransaction',
              documentId: txId,
              notes: reason,
              createdBy: userId,
            },
            tx,
          );
        }

        if (matchedType === 'CASH_WITHDRAWAL') {
          // Готівка повертається з ТІЄЇ Ж каси, куди надійшла. Каса append-only: початкова операція
          // лишається, додається зворотна. Овердрафт → 400 із CashService і відкат усієї транзакції.
          const original = row.cashOperationId
            ? await tx.cashOperation.findFirst({
                where: { id: row.cashOperationId, orgId },
                select: { cashRegisterId: true },
              })
            : null;
          if (!original) throw notMatched();
          await this.cash.createOperation(
            orgId,
            {
              cashRegisterId: original.cashRegisterId,
              direction: 'OUT',
              reason: 'MANUAL_OUT',
              amount,
              documentType: 'BankTransaction',
              documentId: txId,
              notes: reason,
              createdBy: userId,
            },
            tx,
          );
        }
        // SUPPLIER_PAYMENT — лише відв'язка: оплата лишається проведеною (її сторно в системі немає).
        // EXPENSE / PAYROLL / TRANSFER — знімається сама класифікація.
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );

    // Рядок зберігає лише ОСТАННЄ скасування; повна історія — у журналі аудиту (поза транзакцією,
    // як у CashService: збій запису аудиту не має відкочувати вже проведене сторно).
    await this.audit
      .record(
        orgId,
        'BankTransaction',
        txId,
        'UPDATE',
        userId,
        {
          status: 'MATCHED',
          matchedType,
          counterpartyId: row.counterpartyId,
          supplierPaymentId: row.supplierPaymentId,
          expenseCategoryId: row.expenseCategoryId,
          payrollPeriodId: row.payrollPeriodId,
          employeeId: row.employeeId,
          transferBankAccountId: row.transferBankAccountId,
          cashOperationId: row.cashOperationId,
          unmatchReason: null,
        },
        {
          status: 'UNMATCHED',
          matchedType: null,
          ...NO_OUTGOING_LINKS,
          cashOperationId: null,
          unmatchReason: reason,
        },
      )
      .catch(e =>
        this.logger.warn(
          `Аудит скасування рознесення ${txId} не записано: ${e instanceof Error ? e.message : e}`,
        ),
      );

    return this.loadResponse(orgId, txId);
  }

  /** Позначити транзакцію IGNORED (CAS UNMATCHED→IGNORED + причина). Payment НЕ створюється. */
  async ignoreTransaction(
    orgId: string,
    txId: string,
    dto: IgnoreTransactionDto,
  ): Promise<BankTransactionResponseDto> {
    const marked = await this.prisma.bankTransaction.updateMany({
      where: { id: txId, orgId, deletedAt: null, status: 'UNMATCHED', paymentId: null },
      data: { status: 'IGNORED', ignoreReason: dto.reason },
    });
    if (marked.count === 0) {
      const exists = await this.prisma.bankTransaction.findFirst({
        where: { id: txId, orgId, deletedAt: null },
        select: { id: true },
      });
      if (!exists) {
        throw new NotFoundException(translateError('err.bankStatement.txNotFound', getLocale()));
      }
      throw new ConflictException(translateError('err.bankStatement.notUnmatched', getLocale()));
    }
    const updated = await this.prisma.bankTransaction.findFirstOrThrow({
      where: { id: txId, orgId },
    });
    return toBankTransactionResponseDto(updated);
  }
}
