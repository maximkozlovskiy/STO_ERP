import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, BankTransactionMatchType, BankTransactionSource } from '@prisma/client';
import { TRANSACTION_TIMEOUT_MS, translateError } from '@sto/shared';
import { getLocale } from '../../common/tenant/tenant-context';
import { PrismaService } from '../../prisma/prisma.service';
import { ExchangeRatesService } from '../exchange-rates/exchange-rates.service';
import { PaymentsService } from '../payments/payments.service';
import type { PaymentSettlementType } from '../payments/payments.dto';
import { parsePurpose } from './purpose-parser';
import {
  ApplyImportDto,
  BankTransactionResponseDto,
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

@Injectable()
export class BankReconciliationService {
  private readonly logger = new Logger(BankReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly exchangeRates: ExchangeRatesService,
    private readonly payments: PaymentsService,
  ) {}

  /**
   * BULK авто-матч батчу транзакцій БЕЗ N+1 (макс. ~4 findMany на весь батч незалежно від розміру).
   * Пріоритет: (а) payerIban exact-1 → matched 1.0 'iban'; (б) payerEdrpou exact-1 → matched 0.9
   * 'edrpou'; (в) purpose → Invoice/WorkOrder за номером → matched 0.7 'purpose'; інакше notFound.
   * >1 збіг на будь-якому кроці → ambiguous з кандидатами. Повертає Map<externalId, MatchResult>.
   */
  async resolveBatch(orgId: string, txs: RawTx[]): Promise<Map<string, MatchResult>> {
    const result = new Map<string, MatchResult>();
    if (txs.length === 0) return result;

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
        select: { id: true, iban: true, companyName: true, firstName: true, lastName: true },
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
          const cp = matches[0]!;
          markResolved(t.externalId, {
            status: 'matched',
            counterpartyId: cp.id,
            counterpartyName: counterpartyName(cp),
            matchType: 'SERVICE',
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
        select: { id: true, edrpou: true, companyName: true, firstName: true, lastName: true },
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
          const cp = matches[0]!;
          markResolved(externalId, {
            status: 'matched',
            counterpartyId: cp.id,
            counterpartyName: counterpartyName(cp),
            matchType: 'SERVICE',
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

    // ── (в) purpose → Invoice / WorkOrder ────────────────────────────────────────
    const parsedByTx = new Map<string, ReturnType<typeof parsePurpose>>();
    const invoiceNumbers = new Set<string>();
    const workOrderNumbers = new Set<string>();
    for (const t of txs) {
      if (!unresolved.has(t.externalId)) continue;
      const parsed = parsePurpose(t.purpose);
      parsedByTx.set(t.externalId, parsed);
      if (parsed.invoiceNumber) invoiceNumbers.add(parsed.invoiceNumber);
      if (parsed.workOrderNumber) workOrderNumbers.add(parsed.workOrderNumber);
    }

    const [invoices, workOrders] = await Promise.all([
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
    ]);
    const invByNumber = new Map(invoices.map(i => [i.number, i]));
    const woByNumber = new Map(workOrders.map(w => [w.number, w]));

    for (const t of txs) {
      if (!unresolved.has(t.externalId)) continue;
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

    // Дедуп: які externalId вже імпортовано у цей рахунок.
    const externalIds = Array.from(new Set(rows.map(r => r.externalId)));
    const existing = externalIds.length
      ? await this.prisma.bankTransaction.findMany({
          where: { orgId, bankAccountId, externalId: { in: externalIds } },
          select: { externalId: true },
        })
      : [];
    const existingSet = new Set(existing.map(e => e.externalId));

    return rows.map((r, idx) => {
      const m = matches.get(r.externalId);
      const isDuplicate = existingSet.has(r.externalId);
      const matchStatus: PreviewMatchStatus = isDuplicate ? 'duplicate' : (m?.status ?? 'notFound');
      return {
        rowIndex: idx,
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
      select: { id: true, currencyId: true },
    });
    if (!bankAccount) {
      throw new NotFoundException(
        translateError('err.bankStatement.bankAccountNotFound', getLocale()),
      );
    }

    // Обчислюємо amountBase для кожного рядка (валюта = валюта рахунку) ДО транзакції — конвертація
    // читає курси (не мутує), тож поза $transaction (коротша транзакція, менше lock-hold).
    const prepared = await Promise.all(
      dto.rows.map(async row => {
        const operationDate = new Date(row.operationDate);
        const conv = await this.exchangeRates.resolveBaseConversion(
          orgId,
          bankAccount.currencyId,
          operationDate,
          row.amount,
          true, // fallbackToLatest: імпорт виписки — документний потік
        );
        const iban = normalizeIban(row.payerIban);
        return {
          orgId,
          bankAccountId: bankAccount.id,
          direction: 'IN' as const,
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

    const skip = (safePage - 1) * safeLimit;
    const [items, total] = await Promise.all([
      this.prisma.bankTransaction.findMany({
        where,
        skip,
        take: safeLimit,
        orderBy: { operationDate: 'desc' },
        // Назва/IBAN + код валюти нашого рахунку-отримувача — для колонки «Рахунок» і коректного
        // символу валюти суми (multi-bank: рахунок може бути USD/EUR — не хардкодимо ₴).
        include: {
          bankAccount: {
            select: { name: true, ibanUA: true, currency: { select: { code: true } } },
          },
        },
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
        select: { id: true },
      });
      if (!inv) {
        throw new NotFoundException(
          translateError('err.bankStatement.invoiceNotFound', getLocale()),
        );
      }
    }

    // (1) CAS-mark MATCHED — атомарний захват staging-рядка (idempotency проти подвійного match).
    const marked = await this.prisma.bankTransaction.updateMany({
      where: { id: txId, orgId, deletedAt: null, status: 'UNMATCHED', paymentId: null },
      data: { status: 'MATCHED', counterpartyId: dto.counterpartyId, matchedType: dto.type },
    });
    if (marked.count === 0) {
      // Розрізняємо «не існує» vs «вже рознесено».
      const exists = await this.prisma.bankTransaction.findFirst({
        where: { id: txId, orgId, deletedAt: null },
        select: { id: true },
      });
      if (!exists) {
        throw new NotFoundException(translateError('err.bankStatement.txNotFound', getLocale()));
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
          data: { status: 'UNMATCHED', counterpartyId: null, matchedType: null },
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
