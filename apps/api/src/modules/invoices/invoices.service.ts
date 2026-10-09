import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InvoiceStatus, Prisma } from '@prisma/client';
import { formatPersonName, translateError } from '@sto/shared';

import { getLocale } from '../../common/tenant/tenant-context';
import { kyivToday, addDaysKyiv, dateOnlyRangeFilter } from '../../common/utils/kyiv-date';
import { safeCoeff } from '../../common/utils/math';
import { money, moneyFromDecimal } from '../../common/utils/money';
import { sumLineTotals, calcLineVat } from '../../common/utils/vat';
import {
  buildInvoiceLinesFromWorkOrder,
  WorkOrderTotalsMismatchError,
  type InvoiceLineDraft,
} from './work-order-invoice-lines';
import type { VatMode } from '@prisma/client';
import { calculatePagination, buildSortOrderBy } from '../../common/utils/pagination';
import { assertFsmTransition } from '../../common/utils/fsm';
import { assertCounterpartyRole } from '../../common/utils/counterparty-role';
import { throwIfSerializationConflict } from '../../common/utils/prisma-errors';
import { uniqueDefinedIds, initCountsMap } from '../../common/utils/linked-counts';
import { PrismaService } from '../../prisma/prisma.service';
import { DocumentNumberService } from '../document-number/document-number.service';
import { PdfService } from '../pdf/pdf.service';
import { SettlementsService } from '../settlements/settlements.service';
import { SettingsService } from '../settings/settings.service';
import { AuditService } from '../audit/audit.service';
import { ExchangeRatesService } from '../exchange-rates/exchange-rates.service';
import { INVOICEABLE_STATUSES } from '../work-orders/work-orders.fsm';
import {
  CreateInvoiceDto,
  UpdateInvoiceDto,
  CreateInvoiceLineDto,
  UpdateInvoiceLineDto,
  InvoiceLineResponseDto,
  InvoiceResponseDto,
  InvoiceByWorkOrderResponseDto,
  PaginatedInvoicesDto,
} from './invoices.dto';

type InvStatus = InvoiceStatus;

export const INV_TRANSITIONS: Record<InvStatus, InvStatus[]> = {
  DRAFT: [InvoiceStatus.SENT, InvoiceStatus.CANCELLED],
  SENT: [InvoiceStatus.PAID, InvoiceStatus.CANCELLED],
  // PARTIALLY_PAID виставляється автоматично частковим платежем; вручну можна дозакрити
  // (PAID) або скасувати. Перехід у PARTIALLY_PAID роблять лише платежі, не FSM-endpoint.
  PARTIALLY_PAID: [InvoiceStatus.PAID, InvoiceStatus.CANCELLED],
  PAID: [],
  OVERDUE: [InvoiceStatus.PAID, InvoiceStatus.CANCELLED],
  CANCELLED: [],
};

// sto-optimize (cycle 3/3): sort-field whitelist hoisted from findAll body — static string-map,
// re-allocated on every list request under polling. Sibling to SP_SORT_FIELDS/WO_SORT/PO_SORT/SD_SORT.
const INV_SORT_FIELDS: Record<string, string> = {
  documentDate: 'documentDate',
  createdAt: 'createdAt',
  dueDate: 'dueDate',
  amount: 'amount',
};

/**
 * ПДВ рядка, введеного вручну (addLine / updateLine). Ціна рядка трактується за режимом
 * організації: «ПДВ у ціні» → ПДВ виділяється з суми, інакше — нараховується зверху. Раніше
 * ручний рядок завжди рахувався «зверху», і в організації «ПДВ у ціні» рахунок із наряду після
 * правки одного рядка дорожчав на ставку ПДВ.
 * Режим NONE з явною ставкою в запиті лишається «зверху» — ставку ввів користувач свідомо.
 */
function manualLineVat(
  lineSum: number,
  vatRate: number,
  vatMode: VatMode,
): { priceWithoutVat: number; vatAmount: number; priceWithVat: number } {
  if (vatMode === 'INCLUSIVE') {
    const v = calcLineVat(lineSum, 1, vatRate, 'INCLUSIVE');
    return {
      priceWithVat: v.priceWithVat,
      vatAmount: v.vatAmount,
      priceWithoutVat: money(v.priceWithVat - v.vatAmount),
    };
  }
  const priceWithoutVat = money(lineSum);
  const vatAmount = money(priceWithoutVat * (vatRate / 100));
  return { priceWithoutVat, vatAmount, priceWithVat: money(priceWithoutVat + vatAmount) };
}

@Injectable()
export class InvoicesService {
  private readonly logger = new Logger(InvoicesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly docNumbers: DocumentNumberService,
    private readonly pdf: PdfService,
    private readonly settlements: SettlementsService,
    private readonly settingsService: SettingsService,
    private readonly audit: AuditService,
    private readonly exchangeRates: ExchangeRatesService,
  ) {}

  async findAll(
    orgId: string,
    page = 1,
    limit = 20,
    status?: string,
    q?: string,
    showDeleted = false,
    dateFrom?: string,
    dateTo?: string,
    sortBy?: string,
    sortDir?: 'asc' | 'desc',
  ): Promise<PaginatedInvoicesDto> {
    const where: Prisma.InvoiceWhereInput = {
      orgId,
      deletedAt: showDeleted ? undefined : null,
    };
    if (status) where.status = status as InvStatus;
    if (q) {
      const like = q.trim();
      where.OR = [
        { number: { contains: like, mode: 'insensitive' } },
        {
          counterparty: {
            OR: [
              { firstName: { contains: like, mode: 'insensitive' } },
              { lastName: { contains: like, mode: 'insensitive' } },
              { companyName: { contains: like, mode: 'insensitive' } },
            ],
          },
        },
      ];
    }
    // documentDate - date without time (@db.Date): bounds are calendar dates, no timezone shift.
    const documentDate = dateOnlyRangeFilter(dateFrom, dateTo);
    if (documentDate) where.documentDate = documentDate;

    const { skip, take } = calculatePagination({ page, limit });
    const orderBy = buildSortOrderBy(INV_SORT_FIELDS, sortBy, sortDir);
    const [items, total] = await Promise.all([
      this.prisma.invoice.findMany({
        where,
        skip,
        take,
        orderBy,
        include: {
          counterparty: { select: { firstName: true, lastName: true, companyName: true } },
          workOrder: { select: { number: true } },
          currency: { select: { code: true } },
        },
      }),
      this.prisma.invoice.count({ where }),
    ]);

    return { items: items.map(item => this.toDto(item)), total, page, limit: take };
  }

  async findOne(orgId: string, id: string): Promise<InvoiceResponseDto> {
    const inv = await this.prisma.invoice.findFirst({
      where: { id, orgId, deletedAt: null },
      include: {
        counterparty: { select: { firstName: true, lastName: true, companyName: true } },
        workOrder: { select: { number: true } },
        currency: { select: { code: true } },
        // good.unit + unitOfMeasure required: unitShortName/coefficient were always undefined
        // until includes were updated to match DTO fields.
        lines: {
          orderBy: { sortOrder: 'asc' },
          take: 500,
          include: {
            good: {
              select: {
                unit: true,
                unitOfMeasure: { select: { shortName: true, coefficient: true } },
              },
            },
          },
        },
        payments: { select: { amount: true } },
      },
    });
    if (!inv) throw new NotFoundException(translateError('err.invoice.notFound', getLocale()));
    return this.toDto(inv, true);
  }

  async createFromWorkOrder(orgId: string, workOrderId: string): Promise<InvoiceResponseDto> {
    // Pre-tx check WO existence + duplicate for fast 4xx feedback.
    // Race still possible — actual create wrapped in Serializable tx with re-check below.
    const [wo, existingPre] = await Promise.all([
      this.prisma.workOrder.findFirst({
        // sto-optimize: narrow select — використовуються лише id/status/counterpartyId/totalAmount.
        // Full-row guard тягнув би 20+ колонок (vehicle/branch/lift FKs, syncVersion, timestamps)
        // — wire payload зайвий, V8 alloc на гарячому шляху invoice create.
        where: { id: workOrderId, orgId, deletedAt: null },
        // Мультивалюта (Фаза 3): валюта наряду → успадковується рахунком (amount у тій самій валюті).
        select: {
          id: true,
          status: true,
          counterpartyId: true,
          currencyId: true,
        },
      }),
      this.prisma.invoice.findFirst({
        where: { workOrderId, orgId, deletedAt: null, status: { not: InvoiceStatus.CANCELLED } },
        select: { id: true },
      }),
    ]);
    if (!wo)
      throw new NotFoundException(translateError('err.invoice.workOrderNotFound', getLocale()));
    // shared INVOICEABLE_STATUSES: раніше inline `['COMPLETED', 'INVOICED']` — будь-який
    // новий статус у whitelist оновлюється тільки у одному місці.
    if (!INVOICEABLE_STATUSES.includes(wo.status)) {
      throw new BadRequestException(
        translateError('err.invoice.onlyCompletedInvoiceable', getLocale()),
      );
    }
    if (existingPre)
      throw new BadRequestException(translateError('err.invoice.activeExists', getLocale()));

    // docNumbers.next() opens its own $tx (SELECT FOR UPDATE counter) — must run BEFORE
    // the outer Serializable tx to avoid nested-tx deadlock. Trade-off: if outer tx aborts
    // we burn one INVOICE number. Acceptable — invoice numbering tolerates gaps (CANCELLED
    // status reservation already creates similar gaps).
    const number = await this.docNumbers.next(orgId, 'INVOICE');

    // §13: термін оплати від дати документа за invoiceDueDays (обчислюємо ПОЗА Serializable
    // tx — settings-query не має триматись всередині короткої критичної секції).
    const documentDate = kyivToday();
    const dueDate = await this.resolveDueDate(orgId, undefined, documentDate);

    // Налаштування ПДВ читаємо ПОЗА Serializable tx (як і термін оплати). Режим рядків однаково
    // визначає сам наряд (work-order-invoice-lines.ts) — звідси береться лише ставка.
    const settingsVat = await this.settingsService.getDefaultVatRate(orgId);

    // Serializable isolation + re-check `existing` within the tx prevents two concurrent
    // createFromWorkOrder calls from BOTH passing the pre-check and creating duplicate invoices.
    // On Serializable conflict, Prisma throws P2034 → map to BadRequestException.
    try {
      const inv = await this.prisma.$transaction(
        async tx => {
          const existing = await tx.invoice.findFirst({
            where: {
              workOrderId,
              orgId,
              deletedAt: null,
              status: { not: InvoiceStatus.CANCELLED },
            },
            select: { id: true },
          });
          if (existing)
            throw new BadRequestException(translateError('err.invoice.activeExists', getLocale()));

          const created = await tx.invoice.create({
            data: {
              orgId,
              counterpartyId: wo.counterpartyId,
              workOrderId: wo.id,
              number,
              // суми й base-конвертацію одразу нижче пише writeLinesFromWorkOrder
              amount: 0,
              currencyId: wo.currencyId,
              // Явно STANDARD — без цього лягав Prisma-дефолт 'INVOICE' (поза UI-enum
              // STANDARD/PREPAYMENT/CREDIT_NOTE), і web-форма падала на zodResolver при
              // редагуванні рахунку виставленого з наряду (найчастіший шлях створення).
              invoiceType: 'STANDARD',
              dueDate,
              documentDate,
              notes: null,
              status: InvoiceStatus.DRAFT,
            },
            select: { id: true },
          });
          // BR-INV-002: рядки й суми — одразу, у тій самій транзакції. Рахунок без рядків, який
          // треба було окремо «оновити з наряду», більше не існує ні на мить.
          await this.writeLinesFromWorkOrder(tx, orgId, created.id, workOrderId, {
            settingsVat,
            currencyId: wo.currencyId,
            documentDate,
          });
          return tx.invoice.findFirstOrThrow({
            where: { id: created.id, orgId },
            include: {
              counterparty: { select: { firstName: true, lastName: true, companyName: true } },
              workOrder: { select: { number: true } },
              currency: { select: { code: true } },
            },
          });
        },
        { isolationLevel: 'Serializable', timeout: 10_000 },
      );

      return this.toDto(inv);
    } catch (err) {
      throwIfSerializationConflict(
        err,
        translateError('err.invoice.concurrentIssueConflict', getLocale()),
      );
    }
  }

  /**
   * §13 config-over-hardcode: якщо термін оплати явно не заданий, обчислюємо його від
   * дати документа за OrganisationSettings.invoiceDueDays (дефолт 7). Kyiv DST-aware.
   * explicit === null/undefined → застосувати дефолт; explicit заданий → поважати його.
   */
  private async resolveDueDate(
    orgId: string,
    explicit: string | undefined,
    documentDate: Date,
  ): Promise<Date | null> {
    if (explicit) return new Date(explicit);
    let dueDays = 7;
    try {
      const s = await this.settingsService.getOrganisationSettings(orgId);
      const raw = Number((s as { invoiceDueDays?: number }).invoiceDueDays);
      if (Number.isFinite(raw) && raw >= 0) dueDays = Math.trunc(raw);
    } catch {
      /* налаштування недоступні → дефолт 7 днів */
    }
    return addDaysKyiv(documentDate, dueDays);
  }

  async create(orgId: string, dto: CreateInvoiceDto, userId?: string): Promise<InvoiceResponseDto> {
    // Validate counterparty + workOrder in parallel instead of sequential round-trips.
    // Narrow projection — guards перевіряють лише існування (NotFoundException).
    const [counterparty, wo] = await Promise.all([
      this.prisma.counterparty.findFirst({
        where: { id: dto.counterpartyId, orgId, deletedAt: null },
        select: { id: true, type: true },
      }),
      dto.workOrderId
        ? this.prisma.workOrder.findFirst({
            where: { id: dto.workOrderId, orgId, deletedAt: null },
            select: { id: true },
          })
        : Promise.resolve(null),
    ]);
    if (!counterparty)
      throw new NotFoundException(translateError('err.invoice.counterpartyNotFound', getLocale()));
    assertCounterpartyRole(counterparty.type, 'client'); // BR-CP-001
    if (dto.workOrderId && !wo)
      throw new NotFoundException(translateError('err.invoice.workOrderNotFound', getLocale()));

    const number = await this.docNumbers.next(orgId, 'INVOICE');

    const documentDate = dto.documentDate ? new Date(dto.documentDate) : kyivToday();
    const dueDate = await this.resolveDueDate(orgId, dto.dueDate, documentDate);

    // Мультивалюта (Фаза 3): валюта рахунку — з DTO або базова org; base-сума по курсу на дату документа.
    const currencyId = dto.currencyId ?? (await this.exchangeRates.requireBaseCurrencyId(orgId));
    const conv = currencyId
      ? await this.exchangeRates.resolveBaseConversion(
          orgId,
          currencyId,
          documentDate,
          dto.amount,
          true,
        )
      : { rateUsed: 1, amountBase: dto.amount };

    const inv = await this.prisma.invoice.create({
      data: {
        orgId,
        counterpartyId: dto.counterpartyId,
        workOrderId: dto.workOrderId ?? null,
        number,
        amount: dto.amount,
        currencyId,
        totalAmountBase: conv.amountBase,
        rateUsed: conv.rateUsed,
        // 'STANDARD' — узгоджено з UI-enum (INVOICE_TYPE_VALUES); 'INVOICE' (старий Prisma-дефолт)
        // поза enum-ом і ламав zodResolver форми при редагуванні.
        invoiceType: dto.invoiceType ?? 'STANDARD',
        dueDate,
        documentDate,
        notes: dto.notes ?? null,
        status: InvoiceStatus.DRAFT,
      },
      include: {
        counterparty: { select: { firstName: true, lastName: true, companyName: true } },
        workOrder: { select: { number: true } },
        currency: { select: { code: true } },
      },
    });

    // C1: аудит створення рахунку («хто виставив»). Best-effort post-commit.
    if (userId) {
      this.audit
        .record(orgId, 'Invoice', inv.id, 'CREATE', userId, undefined, {
          number: inv.number,
          counterpartyId: dto.counterpartyId,
          amount: Number(inv.amount),
        })
        .catch((e: unknown) =>
          this.logger.warn(`Audit record failed: ${e instanceof Error ? e.message : e}`),
        );
    }

    return this.toDto(inv);
  }

  async update(orgId: string, id: string, dto: UpdateInvoiceDto): Promise<InvoiceResponseDto> {
    // sto-optimize: status-only projection — guard перевіряє лише DRAFT, всі інші поля ігноруються.
    // Раніше тягнуло amount/dueDate/notes/totalWithVat/syncVersion + counterpartyId/workOrderId/orgId.
    const inv = await this.prisma.invoice.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { status: true, counterpartyId: true },
    });
    if (!inv) throw new NotFoundException(translateError('err.invoice.notFound', getLocale()));
    if (inv.status !== InvoiceStatus.DRAFT)
      throw new BadRequestException(translateError('err.invoice.onlyDraftEditable', getLocale()));

    // Зміна контрагента: FK з тіла запиту має належати цій org (інакше рахунок можна було
    // переписати на контрагента чужої організації — update нижче перевіряє лише сам рахунок)
    // і проходити BR-CP-001. Той самий контрагент не перевіряється — рахунок, створений до
    // 2026-10-07 на постачальника, лишається редагованим.
    if (dto.counterpartyId && dto.counterpartyId !== inv.counterpartyId) {
      const counterparty = await this.prisma.counterparty.findFirst({
        where: { id: dto.counterpartyId, orgId, deletedAt: null },
        select: { id: true, type: true },
      });
      if (!counterparty)
        throw new NotFoundException(
          translateError('err.invoice.counterpartyNotFound', getLocale()),
        );
      assertCounterpartyRole(counterparty.type, 'client'); // BR-CP-001
    }

    const updated = await this.prisma.invoice.update({
      where: { id, orgId },
      data: {
        amount: dto.amount ?? undefined,
        invoiceType: dto.invoiceType ?? undefined,
        counterpartyId: dto.counterpartyId ?? undefined,
        dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
        documentDate: dto.documentDate ? new Date(dto.documentDate) : undefined,
        notes: dto.notes ?? undefined,
        // Мультивалюта (Фаза 3): totalAmountBase/rateUsed лишаються зі старого курсу до
        // transition() (DRAFT→SENT нараховує CHARGE у base по свіжому currencyId) —
        // не перераховуємо тут, щоб не дублювати conversion-логіку поза FSM.
        // Мультивалюта (TD1): currencyId NOT NULL — не дозволяємо занулити (лише зміна на іншу валюту).
        currencyId: dto.currencyId ?? undefined,
      },
      include: {
        counterparty: { select: { firstName: true, lastName: true, companyName: true } },
        workOrder: { select: { number: true } },
      },
    });

    return this.toDto(updated);
  }

  async transition(
    orgId: string,
    id: string,
    newStatus: InvStatus,
    userId?: string,
  ): Promise<InvoiceResponseDto> {
    const inv = await this.prisma.invoice.findFirst({
      where: { id, orgId, deletedAt: null },
      select: {
        status: true,
        workOrderId: true,
        counterpartyId: true,
        amount: true,
        paidAmount: true,
        // Мультивалюта (Фаза 3): валюта + дата документа для CHARGE/PAYMENT у base.
        currencyId: true,
        documentDate: true,
      },
    });
    if (!inv) throw new NotFoundException(translateError('err.invoice.notFound', getLocale()));

    assertFsmTransition(INV_TRANSITIONS, inv.status, newStatus);

    // FIN-C2: борг (CHARGE) для STANDALONE-рахунку (без наряду) створюється при виставленні
    // (DRAFT→SENT). WO-рахунок НЕ чіпаємо — там CHARGE вже нараховано при COMPLETED наряду
    // (інакше подвійний борг). Оплата пізніше зробить PAYMENT → net-zero. У тій самій tx +
    // CAS-перехід (status:DRAFT у where) проти подвійного CHARGE при concurrent transition.
    const chargesStandaloneOnSend =
      inv.status === InvoiceStatus.DRAFT &&
      newStatus === InvoiceStatus.SENT &&
      inv.workOrderId === null;

    // Bug #675: ручний →PAID для STANDALONE-рахунку мусить закрити CHARGE дзеркальним PAYMENT,
    // інакше у леджері висить борг попри PAID. Тільки standalone (workOrderId=null) отримав CHARGE
    // на SEND; PAID досяжний лише з SENT/PARTIALLY_PAID/OVERDUE — усі пройшли SEND → CHARGE існує.
    // WO-рахунок НЕ чіпаємо (його CHARGE через COMPLETED, оплата йде окремо через payments-модуль).
    // Сума PAYMENT = непокритий залишок (amount − вже сплачене paidAmount), щоб не подвоїти
    // часткові оплати, зроблені раніше через payments-модуль.
    const paymentRemaining = money(moneyFromDecimal(inv.amount) - moneyFromDecimal(inv.paidAmount));
    const settlesStandaloneOnPaid =
      newStatus === InvoiceStatus.PAID && inv.workOrderId === null && paymentRemaining > 1e-9;

    await this.prisma.$transaction(
      async tx => {
        const moved = await tx.invoice.updateMany({
          where: { id, orgId, status: inv.status, deletedAt: null },
          // Ручний перехід у PAID синхронізує paidAmount=amount (щоб «залишок» був 0). CAS
          // (status:inv.status у where) проти подвійного PAYMENT при concurrent transition.
          data:
            newStatus === InvoiceStatus.PAID
              ? { status: newStatus, paidAmount: inv.amount }
              : { status: newStatus },
        });
        if (moved.count === 0) {
          throw new BadRequestException(translateError('err.invoice.statusChanged', getLocale()));
        }
        if (chargesStandaloneOnSend) {
          await this.settlements.createTransaction(
            orgId,
            {
              counterpartyId: inv.counterpartyId,
              type: 'CHARGE',
              amount: Number(inv.amount),
              // Мультивалюта (Фаза 3): борг у base по курсу на дату документа рахунку.
              currencyId: inv.currencyId ?? undefined,
              date: inv.documentDate ?? undefined,
              fallbackToLatest: true,
              documentType: 'Invoice',
              documentId: id,
              createdBy: userId,
            },
            tx,
          );
        }
        if (settlesStandaloneOnPaid) {
          // Дзеркальний PAYMENT на непокритий залишок — закриває CHARGE у леджері (Bug #675).
          // moved.count===1 (CAS вище) гарантує, що це відбувається рівно раз на перехід.
          await this.settlements.createTransaction(
            orgId,
            {
              counterpartyId: inv.counterpartyId,
              type: 'PAYMENT',
              amount: paymentRemaining,
              currencyId: inv.currencyId ?? undefined,
              date: inv.documentDate ?? undefined,
              fallbackToLatest: true,
              documentType: 'Invoice',
              documentId: id,
              createdBy: userId,
            },
            tx,
          );

          // Курсові різниці (Bug #745): ручний →PAID іновалютного standalone-рахунку, який мав
          // ЧАСТКОВІ реальні оплати (payments-модуль, курс дати оплати) → CHARGE брав курс дати
          // документа, часткові PAYMENT — курс дати оплат, дзеркальний PAYMENT (вище) — знову курс
          // документа. Base-залишок НЕ нульовий (Σчасткові×(r_doc−r_pay)). Дзеркалить FX-хук
          // payments.service: одна проводка FX_GAIN/FX_LOSS обнуляє base-залишок. Тільки коли валюта
          // НЕ базова (base → CHARGE/PAYMENT в одному курсі, залишок і так 0). paidBase агрегується
          // ПІСЛЯ дзеркального PAYMENT — але дзеркальний PAYMENT — settlement-only (не Payment-рядок),
          // тож рахуємо base-залишок напряму з леджера цього документа.
          if (!(await this.exchangeRates.sameCurrency(orgId, null, inv.currencyId))) {
            // Idempotency: PAID термінальний (INV_TRANSITIONS PAID:[]), але guard симетричний із
            // payments.service — повторна FX для цього рахунку не дублюється.
            const fxExisting = await tx.settlementTransaction.count({
              where: {
                orgId,
                type: { in: ['FX_GAIN', 'FX_LOSS'] },
                documentType: 'Invoice',
                documentId: id,
              },
            });
            if (fxExisting === 0) {
              // Base-залишок цього рахунку = CHARGE(doc, курс документа) − дзеркальний PAYMENT(doc,
              // курс документа) − Σреальні_часткові_оплати (Payment.amountBase по invoiceId, курс
              // дати оплати). Реальні часткові оплати мають settlement documentType='Payment' (не
              // 'Invoice') → у леджері проти цього рахунку їх немає; беремо з Payment-таблиці. FX
              // обнуляє саме дрейф Σчасткові×(r_doc−r_pay). CHARGE−mirrorPAYMENT дає лише base(remaining).
              const [chargeAgg, payAgg, realPaidAgg] = await Promise.all([
                tx.settlementTransaction.aggregate({
                  where: { orgId, type: 'CHARGE', documentType: 'Invoice', documentId: id },
                  _sum: { amountBase: true },
                }),
                tx.settlementTransaction.aggregate({
                  where: { orgId, type: 'PAYMENT', documentType: 'Invoice', documentId: id },
                  _sum: { amountBase: true },
                }),
                tx.payment.aggregate({
                  where: { orgId, invoiceId: id },
                  _sum: { amountBase: true },
                }),
              ]);
              const chargeBase = moneyFromDecimal(chargeAgg._sum.amountBase);
              const docPaymentBase = moneyFromDecimal(payAgg._sum.amountBase); // дзеркальний PAYMENT (base)
              const realPaidBase = moneyFromDecimal(realPaidAgg._sum.amountBase);
              const fx = money(chargeBase - docPaymentBase - realPaidBase);
              if (Math.abs(fx) >= 0.005) {
                await this.settlements.createTransaction(
                  orgId,
                  {
                    counterpartyId: inv.counterpartyId,
                    // fx>0: нараховано більше base ніж отримано → збиток (гасить додатний залишок).
                    type: fx > 0 ? 'FX_LOSS' : 'FX_GAIN',
                    amount: Math.abs(fx),
                    // БЕЗ currencyId → base-дельта (rate=1); інакше re-конвертація зіпсує суму.
                    documentType: 'Invoice',
                    documentId: id,
                    notes: 'Курсова різниця (ручне закриття рахунку)',
                    createdBy: userId,
                  },
                  tx,
                );
              }
            }
          }
        }
      },
      { timeout: 10_000 },
    ); // updateMany + до 3 settlement-write (CHARGE/PAYMENT/FX) — узгоджено з іншими tx у файлі
    return this.findOne(orgId, id);
  }

  async clone(orgId: string, id: string): Promise<InvoiceResponseDto> {
    const original = await this.prisma.invoice.findFirst({
      where: { id, orgId, deletedAt: null },
      include: {
        counterparty: { select: { firstName: true, lastName: true, companyName: true } },
        workOrder: { select: { number: true } },
        // good.unitOfMeasure required for correct toDto(true) on clone completion.
        lines: {
          orderBy: { sortOrder: 'asc' },
          take: 500,
          include: {
            good: {
              select: {
                unit: true,
                unitOfMeasure: { select: { shortName: true, coefficient: true } },
              },
            },
          },
        },
      },
    });
    if (!original) throw new NotFoundException(translateError('err.invoice.notFound', getLocale()));

    // Validate counterparty still exists (not soft-deleted) BEFORE create:
    // Prisma P2003 would surface as HTTP 500 instead of a friendly 404.
    const counterparty = await this.prisma.counterparty.findFirst({
      where: { id: original.counterpartyId, orgId, deletedAt: null },
      select: { id: true, type: true },
    });
    if (!counterparty)
      throw new NotFoundException(
        translateError('err.invoice.counterpartyDeletedNoClone', getLocale()),
      );
    assertCounterpartyRole(counterparty.type, 'client'); // BR-CP-001

    const number = await this.docNumbers.next(orgId, 'INVOICE');

    // Pre-compute VAT totals from original's lines so the cloned invoice ships consistent
    // totalWithoutVat/totalVat/totalWithVat; Prisma defaults leave them at 0 while
    // lines[].priceWithVat has real values. sumLineTotals — спільний single-pass суматор.
    const { totalWithoutVat, totalVat, totalWithVat } = sumLineTotals(original.lines);
    const clonedAmount =
      original.lines.length > 0 ? totalWithVat : moneyFromDecimal(original.amount);
    // Мультивалюта (Фаза 3): клон успадковує валюту оригіналу; base — по СВІЖОМУ курсу (новий DRAFT).
    const clonedConv = original.currencyId
      ? await this.exchangeRates.resolveBaseConversion(
          orgId,
          original.currencyId,
          new Date(),
          clonedAmount,
          true,
        )
      : { rateUsed: 1, amountBase: clonedAmount };

    // Clone must NOT inherit workOrderId: the same WO would accumulate duplicate invoices
    // and the WO→Invoice 1:1 invariant breaks (auto-invoice on completion creates a 3rd).
    const cloned = await this.prisma.invoice.create({
      data: {
        orgId,
        counterpartyId: original.counterpartyId,
        workOrderId: null,
        number,
        // When the invoice has line items, sync `amount` with their total to
        // avoid mismatch between `amount` and recalculated VAT breakdown.
        // Fall back to `original.amount` when there are no lines.
        amount: clonedAmount,
        currencyId: original.currencyId ?? null,
        totalWithoutVat,
        totalVat,
        totalWithVat,
        totalAmountBase: clonedConv.amountBase,
        rateUsed: clonedConv.rateUsed,
        dueDate: original.dueDate,
        notes: original.notes,
        status: InvoiceStatus.DRAFT,
        lines: {
          create: original.lines.map(l => ({
            orgId,
            goodId: l.goodId,
            workId: l.workId,
            description: l.description,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            vatRate: l.vatRate,
            priceWithoutVat: l.priceWithoutVat,
            vatAmount: l.vatAmount,
            priceWithVat: l.priceWithVat,
            sortOrder: l.sortOrder,
          })),
        },
      },
      include: {
        counterparty: { select: { firstName: true, lastName: true, companyName: true } },
        workOrder: { select: { number: true } },
        currency: { select: { code: true } },
      },
    });

    return this.toDto(cloned);
  }

  async addLine(
    orgId: string,
    invoiceId: string,
    dto: CreateInvoiceLineDto,
  ): Promise<InvoiceLineResponseDto> {
    // Tenant-guard invoice + FK validations (good/work) — all three independent
    // and already orgId-scoped. Saves one RTT vs the previous «invoice-first, then
    // parallel good+work» pattern.
    const [inv, good, work, goodUoM] = await Promise.all([
      this.prisma.invoice.findFirst({
        where: { id: invoiceId, orgId, deletedAt: null },
      }),
      dto.goodId
        ? this.prisma.good.findFirst({
            where: { id: dto.goodId, orgId, deletedAt: null },
            select: { id: true },
          })
        : Promise.resolve(null),
      dto.workId
        ? this.prisma.work.findFirst({
            where: { id: dto.workId, orgId, deletedAt: null },
            select: { id: true },
          })
        : Promise.resolve(null),
      dto.unitOfMeasureId && dto.goodId
        ? this.prisma.goodUoM.findFirst({
            where: { id: dto.unitOfMeasureId, goodId: dto.goodId, orgId },
            select: { id: true, coefficient: true, unitOfMeasure: { select: { shortName: true } } },
          })
        : Promise.resolve(null),
    ]);
    if (!inv) throw new NotFoundException(translateError('err.invoice.notFound', getLocale()));
    if (inv.status !== InvoiceStatus.DRAFT)
      throw new BadRequestException(translateError('err.invoice.linesOnlyDraftAdd', getLocale()));
    if (dto.goodId && !good)
      throw new NotFoundException(translateError('err.invoice.partNotFound', getLocale()));
    if (dto.workId && !work)
      throw new NotFoundException(translateError('err.invoice.workNotFound', getLocale()));
    if (dto.unitOfMeasureId && dto.goodId && !goodUoM)
      throw new NotFoundException(translateError('err.invoice.unitNotFoundForGood', getLocale()));

    // §13: без явного vatRate — дефолт org (getDefaultVatRate вже дає 0 для vatMode NONE),
    // НЕ хардкод 20% (інакше NONE-org отримав би 20% ПДВ на ручному рядку). Дзеркалить
    // createFromWorkOrder/PO/WO.
    const settingsVat = await this.settingsService.getDefaultVatRate(orgId);
    const vatRate = dto.vatRate != null ? dto.vatRate : settingsVat.vatRate;
    const { priceWithoutVat, vatAmount, priceWithVat } = manualLineVat(
      dto.quantity * dto.unitPrice,
      vatRate,
      settingsVat.vatMode,
    );

    const line = await this.prisma.invoiceLine.create({
      data: {
        orgId,
        invoiceId,
        goodId: dto.goodId ?? null,
        workId: dto.workId ?? null,
        description: dto.description,
        quantity: dto.quantity,
        unitPrice: dto.unitPrice,
        vatRate,
        priceWithoutVat,
        vatAmount,
        priceWithVat,
        sortOrder: dto.sortOrder ?? 0,
        unitOfMeasureId: dto.unitOfMeasureId ?? null,
      },
      // good include required for unitShortName/coefficient in response.
      include: {
        good: {
          select: {
            unit: true,
            unitOfMeasure: { select: { shortName: true, coefficient: true } },
          },
        },
      },
    });

    await this.recalcTotals(orgId, invoiceId);
    return this.toLineDto({ ...line, goodUoM });
  }

  async updateLine(
    orgId: string,
    invoiceId: string,
    lineId: string,
    dto: UpdateInvoiceLineDto,
  ): Promise<InvoiceLineResponseDto> {
    // Independent reads: tenant-guard invoice + existing line. Both queries already
    // tenant-scoped via orgId → safe to parallelize. Throw checks stay after Promise.all
    // so the user still gets the "invoice-first" diagnostic message.
    const [inv, existing] = await Promise.all([
      this.prisma.invoice.findFirst({
        where: { id: invoiceId, orgId, deletedAt: null },
      }),
      this.prisma.invoiceLine.findFirst({
        where: { id: lineId, invoiceId, orgId },
      }),
    ]);
    if (!inv) throw new NotFoundException(translateError('err.invoice.notFound', getLocale()));
    if (inv.status !== InvoiceStatus.DRAFT)
      throw new BadRequestException(translateError('err.invoice.linesOnlyDraftEdit', getLocale()));
    if (!existing)
      throw new NotFoundException(translateError('err.invoice.lineNotFound', getLocale()));

    const quantity = dto.quantity ?? existing.quantity;
    const unitPrice =
      dto.unitPrice !== undefined ? money(dto.unitPrice) : moneyFromDecimal(existing.unitPrice);
    const vatRate = dto.vatRate !== undefined ? dto.vatRate : Number(existing.vatRate);
    const { vatMode } = await this.settingsService.getDefaultVatRate(orgId);
    const { priceWithoutVat, vatAmount, priceWithVat } = manualLineVat(
      quantity * unitPrice,
      vatRate,
      vatMode,
    );

    const updated = await this.prisma.invoiceLine.update({
      where: { id: lineId, orgId },
      data: {
        description: dto.description ?? undefined,
        quantity,
        unitPrice,
        vatRate,
        priceWithoutVat,
        vatAmount,
        priceWithVat,
        sortOrder: dto.sortOrder ?? undefined,
      },
      // good include required for unitShortName/coefficient in response.
      include: {
        good: {
          select: {
            unit: true,
            unitOfMeasure: { select: { shortName: true, coefficient: true } },
          },
        },
      },
    });

    await this.recalcTotals(orgId, invoiceId);
    return this.toLineDto(updated);
  }

  async removeLine(orgId: string, invoiceId: string, lineId: string): Promise<void> {
    // Parallelize tenant-guard invoice + existing line fetch — both queries are
    // independent and already tenant-scoped via orgId. Saves one RTT per call.
    // `inv` потрібен повним для status check; `existing` — лише для NotFoundException.
    const [inv, existing] = await Promise.all([
      this.prisma.invoice.findFirst({
        where: { id: invoiceId, orgId, deletedAt: null },
        select: { status: true },
      }),
      this.prisma.invoiceLine.findFirst({
        where: { id: lineId, invoiceId, orgId },
        select: { id: true },
      }),
    ]);
    if (!inv) throw new NotFoundException(translateError('err.invoice.notFound', getLocale()));
    if (inv.status !== InvoiceStatus.DRAFT)
      throw new BadRequestException(
        translateError('err.invoice.linesOnlyDraftRemove', getLocale()),
      );
    if (!existing)
      throw new NotFoundException(translateError('err.invoice.lineNotFound', getLocale()));

    // Defense-in-depth: atomic deleteMany with full compound where (sto-review pattern 2026-05-30).
    // Removes the race-window between the findFirst guard above and a plain delete-by-id.
    const result = await this.prisma.invoiceLine.deleteMany({
      where: { id: lineId, invoiceId, orgId },
    });
    if (result.count === 0)
      throw new NotFoundException(translateError('err.invoice.lineNotFound', getLocale()));
    await this.recalcTotals(orgId, invoiceId);
  }

  /**
   * BR-INV-002: читає рядки наряду В ТРАНЗАКЦІЇ (закриває TOCTOU з конкурентним addLine/removePart),
   * пише рядки рахунку і його суми. Сума рахунку = `wo.totalAmount` — те, що вже нараховано боргом.
   * Спільне для createFromWorkOrder і refreshFromWorkOrder: раніше рядки вмів будувати лише refresh,
   * і щойно створений рахунок лишався порожнім, доки його не «оновлять з наряду».
   */
  private async writeLinesFromWorkOrder(
    tx: Prisma.TransactionClient,
    orgId: string,
    invoiceId: string,
    workOrderId: string,
    ctx: {
      settingsVat: { vatMode: VatMode; vatRate: number };
      currencyId: string | null;
      documentDate: Date;
    },
  ): Promise<void> {
    const wo = await tx.workOrder.findFirst({
      where: { id: workOrderId, orgId, deletedAt: null },
      select: {
        totalNet: true,
        totalAmount: true,
        // Порядок рядків рахунку = порядок рядків наряду (як на екрані й в акті). Без orderBy
        // Postgres віддавав їх довільно, і «останній рядок», що забирає копійку округлення
        // (BR-INV-002), був випадковим (Bug #814).
        lines: {
          where: { deletedAt: null },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: {
            workId: true,
            price: true,
            normoHours: true,
            actualHours: true,
            work: { select: { name: true } },
          },
        },
        parts: {
          where: { deletedAt: null },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: {
            goodId: true,
            price: true,
            quantity: true,
            good: { select: { name: true } },
          },
        },
      },
    });
    if (!wo)
      throw new NotFoundException(translateError('err.invoice.workOrderNotFound', getLocale()));

    let drafts: InvoiceLineDraft[];
    try {
      drafts = buildInvoiceLinesFromWorkOrder(
        {
          totalNet: moneyFromDecimal(wo.totalNet),
          totalAmount: moneyFromDecimal(wo.totalAmount),
          // quantity = actualHours ?? normoHours — те саме, з чого наряд рахує totalActualLabor.
          lines: wo.lines.map(l => ({
            workId: l.workId,
            name: l.work?.name ?? null,
            quantity: Number(l.actualHours ?? l.normoHours ?? 0),
            unitPrice: Number(l.price),
          })),
          parts: wo.parts.map(p => ({
            goodId: p.goodId,
            name: p.good?.name ?? null,
            quantity: Number(p.quantity),
            unitPrice: Number(p.price),
          })),
        },
        ctx.settingsVat,
      );
    } catch (err) {
      if (err instanceof WorkOrderTotalsMismatchError) {
        this.logger.warn(`Наряд ${workOrderId}: ${err.message}`);
        throw new BadRequestException(
          translateError('err.invoice.workOrderTotalsMismatch', getLocale()),
        );
      }
      throw err;
    }

    if (drafts.length > 0) {
      await tx.invoiceLine.createMany({
        data: drafts.map(d => ({ ...d, orgId, invoiceId })),
      });
    }

    const totalWithVat = moneyFromDecimal(wo.totalAmount);
    const totalWithoutVat = moneyFromDecimal(wo.totalNet);
    // Мультивалюта (Фаза 3): рахунок успадковує валюту наряду; base-сума — по курсу на дату рахунку
    // (rate-on-date per event; fallbackToLatest — документний потік). Без валюти → base (rate=1).
    const conv = ctx.currencyId
      ? await this.exchangeRates.resolveBaseConversion(
          orgId,
          ctx.currencyId,
          ctx.documentDate,
          totalWithVat,
          true,
        )
      : { rateUsed: 1, amountBase: totalWithVat };
    await tx.invoice.update({
      where: { id: invoiceId, orgId },
      data: {
        totalWithoutVat,
        totalVat: money(totalWithVat - totalWithoutVat),
        totalWithVat,
        amount: totalWithVat,
        totalAmountBase: conv.amountBase,
        rateUsed: conv.rateUsed,
      },
    });
  }

  private async recalcTotals(orgId: string, invoiceId: string): Promise<void> {
    // sto-optimize: Postgres aggregate замість JS reduce 3× по N рядків.
    // Раніше: findMany(take:1000) тягнув всі invoiceLine рядки + 3× JS reduce.
    // Тепер: prisma.aggregate({_sum: ...}) — 1 row response, Postgres counts.
    // Паралель з паттерном work-orders.recalcTotals (2026-05-31).
    // InvoiceLine uses hard delete (no deletedAt column) — where matches original findMany.
    const [result, inv] = await Promise.all([
      this.prisma.invoiceLine.aggregate({
        where: { invoiceId, orgId },
        _sum: { priceWithoutVat: true, vatAmount: true, priceWithVat: true },
      }),
      // Мультивалюта (Фаза 3): валюта + дата документа для base-конвертації тоталу.
      this.prisma.invoice.findFirst({
        where: { id: invoiceId, orgId },
        select: { currencyId: true, documentDate: true },
      }),
    ]);
    const totalWithoutVat = money(Number(result._sum.priceWithoutVat ?? 0));
    const totalVat = money(Number(result._sum.vatAmount ?? 0));
    const totalWithVat = money(Number(result._sum.priceWithVat ?? 0));

    // Base-сума рахунку по курсу на дату документа (fallbackToLatest — документний потік).
    const conv = inv?.currencyId
      ? await this.exchangeRates.resolveBaseConversion(
          orgId,
          inv.currencyId,
          inv.documentDate ?? new Date(),
          totalWithVat,
          true,
        )
      : { rateUsed: 1, amountBase: totalWithVat };

    await this.prisma.invoice.update({
      where: { id: invoiceId, orgId },
      data: {
        totalWithoutVat,
        totalVat,
        totalWithVat,
        amount: totalWithVat,
        totalAmountBase: conv.amountBase,
        rateUsed: conv.rateUsed,
      },
    });
  }

  async findByWorkOrder(
    orgId: string,
    workOrderId: string,
    // Мультивалюта (Фаза 3): валюта рахунку + base-сума + курс для invoice slot картки наряду —
    // InvoiceSection рендерить foreign+base пару. Без них UI мовчки падав би на base-символ ₴.
    // Крок 4: форма винесена в InvoiceByWorkOrderResponseDto, щоб потрапити у Swagger/кодоген.
  ): Promise<InvoiceByWorkOrderResponseDto | null> {
    const inv = await this.prisma.invoice.findFirst({
      where: { workOrderId, orgId, deletedAt: null, status: { not: InvoiceStatus.CANCELLED } },
      select: {
        id: true,
        number: true,
        status: true,
        amount: true,
        totalAmountBase: true,
        rateUsed: true,
        documentDate: true,
        currency: { select: { code: true } },
      },
    });
    if (!inv) return null;
    return {
      id: inv.id,
      number: inv.number,
      status: inv.status,
      amount: Number(inv.amount),
      currencyCode: inv.currency?.code ?? null,
      totalAmountBase: inv.totalAmountBase != null ? Number(inv.totalAmountBase) : null,
      rateUsed: inv.rateUsed != null ? Number(inv.rateUsed) : null,
      documentDate: inv.documentDate ? inv.documentDate.toISOString() : null,
    };
  }

  async refreshFromWorkOrder(orgId: string, workOrderId: string): Promise<InvoiceResponseDto> {
    // Narrow pre-check outside tx: fast 4xx for missing WO / wrong status / no active invoice.
    // Lines+parts are fetched inside the tx to close the TOCTOU window between reading
    // WO contents and writing invoice lines (a concurrent addLine/removePart would otherwise
    // be silently missed).
    const [woPre, existing] = await Promise.all([
      this.prisma.workOrder.findFirst({
        where: { id: workOrderId, orgId, deletedAt: null },
        select: { id: true, status: true },
      }),
      this.prisma.invoice.findFirst({
        where: { workOrderId, orgId, deletedAt: null, status: { not: InvoiceStatus.CANCELLED } },
        select: { id: true, status: true },
      }),
    ]);
    if (!woPre)
      throw new NotFoundException(translateError('err.invoice.workOrderNotFound', getLocale()));
    if (!INVOICEABLE_STATUSES.includes(woPre.status))
      throw new BadRequestException(
        translateError('err.invoice.onlyCompletedInvoiceable', getLocale()),
      );
    if (!existing)
      throw new NotFoundException(translateError('err.invoice.activeNotFound', getLocale()));
    // Guard: refreshFromWorkOrder must not overwrite SENT/PAID/OVERDUE lines — breaks bookkeeping.
    if (existing.status !== InvoiceStatus.DRAFT)
      throw new BadRequestException(translateError('err.invoice.onlyDraftRefresh', getLocale()));

    // Ставка ПДВ — з налаштувань org (НЕ хардкод 20%); режим рядків визначає сам наряд
    // (work-order-invoice-lines.ts): борг уже нараховано на wo.totalAmount, рахунок мусить вийти
    // рівно на цю суму.
    const settingsVat = await this.settingsService.getDefaultVatRate(orgId);

    // WO lines+parts fetched inside tx to close TOCTOU between pre-check (reads WO contents)
    // and createMany (writes invoice lines). ReadCommitted allows concurrent addLine/refreshFromWorkOrder
    // to silently merge stale state. Serializable + inner re-check status — Postgres SSI catches
    // write-conflict → P2034 → 4xx instead of silent override.
    try {
      await this.prisma.$transaction(
        async tx => {
          const invInTx = await tx.invoice.findFirst({
            where: { id: existing.id, orgId, deletedAt: null },
            select: { status: true, currencyId: true, documentDate: true },
          });
          if (!invInTx)
            throw new NotFoundException(translateError('err.invoice.activeNotFound', getLocale()));
          if (invInTx.status !== InvoiceStatus.DRAFT)
            throw new BadRequestException(
              translateError('err.invoice.onlyDraftRefresh', getLocale()),
            );

          await tx.invoiceLine.deleteMany({
            where: { invoiceId: existing.id, orgId },
          });
          await this.writeLinesFromWorkOrder(tx, orgId, existing.id, workOrderId, {
            settingsVat,
            currencyId: invInTx.currencyId,
            documentDate: invInTx.documentDate ?? new Date(),
          });
        },
        { isolationLevel: 'Serializable', timeout: 10_000 },
      );
    } catch (err) {
      throwIfSerializationConflict(
        err,
        translateError('err.invoice.concurrentRefreshConflict', getLocale()),
      );
    }

    return this.findOne(orgId, existing.id);
  }

  async remove(orgId: string, id: string): Promise<void> {
    // Narrow tenant guard — потрібен лише `status` для business-check.
    const inv = await this.prisma.invoice.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { status: true },
    });
    if (!inv) throw new NotFoundException(translateError('err.invoice.notFound', getLocale()));
    if (inv.status !== InvoiceStatus.DRAFT)
      throw new BadRequestException(translateError('err.invoice.onlyDraftDeletable', getLocale()));
    // Race-safe: updateMany з повним compound where (id+orgId+deletedAt:null)
    // блокує double-delete race.
    await this.prisma.invoice.updateMany({
      where: { id, orgId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
  }

  private toDto(
    inv: {
      id: string;
      orgId: string;
      number: string;
      status: InvoiceStatus;
      counterpartyId: string;
      workOrderId: string | null;
      amount: Prisma.Decimal;
      paidAmount?: Prisma.Decimal | null;
      totalWithoutVat: Prisma.Decimal;
      totalVat: Prisma.Decimal;
      totalWithVat: Prisma.Decimal;
      currencyId?: string | null;
      totalAmountBase?: Prisma.Decimal | null;
      rateUsed?: Prisma.Decimal | null;
      currency?: { code: string } | null;
      invoiceType: string;
      notes: string | null;
      dueDate: Date | null;
      documentDate?: Date | null;
      createdAt: Date;
      updatedAt: Date;
      deletedAt?: Date | null;
      counterparty: {
        firstName: string | null;
        lastName: string | null;
        companyName: string | null;
      } | null;
      workOrder: { number: string } | null;
      payments?: Array<{ amount: Prisma.Decimal }>;
      lines?: Array<{
        id: string;
        invoiceId: string;
        goodId: string | null;
        workId: string | null;
        description: string;
        quantity: number;
        unitPrice: Prisma.Decimal;
        vatRate: Prisma.Decimal;
        priceWithoutVat: Prisma.Decimal;
        vatAmount: Prisma.Decimal;
        priceWithVat: Prisma.Decimal;
        sortOrder: number;
        createdAt: Date;
      }>;
    },
    includeLines = false,
  ): InvoiceResponseDto {
    const cp = inv.counterparty;
    const counterpartyName =
      cp?.companyName ?? [cp?.lastName, cp?.firstName].filter(Boolean).join(' ');
    // paidAmount — авторитетна колонка (оновлюється транзакційно при кожному платежі/ручному
    // PAID). Фолбек на суму payments лише якщо колонки немає у вибірці (старий шлях).
    const paidAmount =
      inv.paidAmount != null
        ? Number(inv.paidAmount)
        : inv.payments
          ? inv.payments.reduce((s, p) => s + Number(p.amount), 0)
          : undefined;
    return {
      id: inv.id,
      orgId: inv.orgId,
      number: inv.number,
      status: inv.status,
      counterpartyId: inv.counterpartyId,
      counterpartyName,
      workOrderId: inv.workOrderId ?? null,
      workOrderNumber: inv.workOrder?.number ?? null,
      amount: Number(inv.amount),
      totalWithoutVat: Number(inv.totalWithoutVat),
      totalVat: Number(inv.totalVat),
      totalWithVat: Number(inv.totalWithVat),
      currencyId: inv.currencyId ?? null,
      currencyCode: inv.currency?.code ?? null,
      totalAmountBase: inv.totalAmountBase != null ? Number(inv.totalAmountBase) : null,
      rateUsed: inv.rateUsed != null ? Number(inv.rateUsed) : null,
      invoiceType: inv.invoiceType,
      notes: inv.notes,
      dueDate: inv.dueDate instanceof Date ? inv.dueDate.toISOString() : (inv.dueDate ?? null),
      documentDate: inv.documentDate ? inv.documentDate.toISOString().slice(0, 10) : null,
      ...(paidAmount !== undefined ? { paidAmount } : {}),
      ...(includeLines && inv.lines ? { lines: inv.lines.map(l => this.toLineDto(l)) } : {}),
      createdAt: inv.createdAt instanceof Date ? inv.createdAt.toISOString() : inv.createdAt,
      updatedAt: inv.updatedAt instanceof Date ? inv.updatedAt.toISOString() : inv.updatedAt,
      deletedAt:
        inv.deletedAt instanceof Date ? inv.deletedAt.toISOString() : (inv.deletedAt ?? null),
    };
  }

  async generatePdf(orgId: string, id: string): Promise<Buffer> {
    const [inv, org] = await Promise.all([
      this.prisma.invoice.findFirst({
        where: { id, orgId, deletedAt: null },
        // PDF select narrow: тягнемо ЛИШЕ поля що реально рендеряться у docDef.
        // Не використовуються в PDF (раніше over-fetched через include): id/orgId/branchId/cashRegisterId/
        // counterpartyName(parent), counterparty.id/orgId/sync*; lines.id/invoiceId/goodId/workId/sortOrder/
        // priceWithoutVat/vatAmount, good.unit/unitOfMeasure.coefficient (PDF використовує лише shortName).
        select: {
          number: true,
          createdAt: true,
          dueDate: true,
          totalWithoutVat: true,
          totalVat: true,
          totalWithVat: true,
          counterparty: {
            select: {
              firstName: true,
              lastName: true,
              companyName: true,
              phone: true,
              edrpou: true,
            },
          },
          lines: {
            orderBy: { sortOrder: 'asc' },
            take: 500,
            select: {
              description: true,
              quantity: true,
              unitPrice: true,
              vatRate: true,
              priceWithVat: true,
              good: {
                select: {
                  unit: true,
                  unitOfMeasure: { select: { shortName: true } },
                },
              },
            },
          },
        },
      }),
      this.prisma.organisation.findFirst({
        where: { id: orgId },
        select: { name: true, edrpou: true },
      }),
    ]);
    if (!inv) throw new NotFoundException(translateError('err.invoice.notFound', getLocale()));

    const cp = inv.counterparty;
    // `companyName ?? [...].join(' ') ?? ''` had dead `?? ''` (join always returns string),
    // and failed when companyName='' (non-nullish → never reached lastName/firstName).
    // formatPersonName(...) || '' correctly handles companyName=null/undefined/''.
    const counterpartyName = formatPersonName(cp?.lastName, cp?.firstName, cp?.companyName) || '';

    return this.pdf.generateInvoicePdf({
      org: { name: org?.name ?? '', edrpou: org?.edrpou },
      counterparty: { name: counterpartyName, phone: cp?.phone, edrpou: cp?.edrpou },
      number: inv.number,
      date: inv.createdAt,
      dueDate: inv.dueDate,
      lines: (inv.lines ?? []).map(l => ({
        description: l.description,
        quantity: l.quantity,
        unit: l.good?.unitOfMeasure?.shortName ?? l.good?.unit ?? 'шт',
        unitPrice: Number(l.unitPrice),
        vatRate: Number(l.vatRate),
        total: Number(l.priceWithVat),
      })),
      subtotal: Number(inv.totalWithoutVat),
      vatTotal: Number(inv.totalVat),
      grandTotal: Number(inv.totalWithVat),
    });
  }

  private toLineDto(l: {
    id: string;
    invoiceId: string;
    goodId: string | null;
    workId: string | null;
    description: string;
    quantity: number;
    unitPrice: Prisma.Decimal;
    vatRate: Prisma.Decimal;
    priceWithoutVat: Prisma.Decimal;
    vatAmount: Prisma.Decimal;
    priceWithVat: Prisma.Decimal;
    sortOrder: number;
    unitOfMeasureId?: string | null;
    createdAt: Date;
    good?: {
      unit: string;
      unitOfMeasure: { shortName: string; coefficient: number } | null;
    } | null;
    goodUoM?: { id: string; coefficient: number; unitOfMeasure: { shortName: string } } | null;
  }): InvoiceLineResponseDto {
    const selectedUoM = l.goodUoM;
    const baseUoM = l.good?.unitOfMeasure;
    return {
      id: l.id,
      invoiceId: l.invoiceId,
      goodId: l.goodId,
      workId: l.workId,
      description: l.description,
      unitOfMeasureId: l.unitOfMeasureId ?? null,
      unitShortName: selectedUoM?.unitOfMeasure.shortName ?? baseUoM?.shortName ?? l.good?.unit,
      // safeCoeff() catches legacy/seed coefficient=0 — множник display↔base (qty_base = qty * coefficient).
      coefficient: safeCoeff(selectedUoM?.coefficient ?? baseUoM?.coefficient),
      quantity: l.quantity,
      unitPrice: Number(l.unitPrice),
      vatRate: Number(l.vatRate),
      priceWithoutVat: Number(l.priceWithoutVat),
      vatAmount: Number(l.vatAmount),
      priceWithVat: Number(l.priceWithVat),
      sortOrder: l.sortOrder,
      createdAt: l.createdAt instanceof Date ? l.createdAt.toISOString() : l.createdAt,
    };
  }

  // ─── Linked Documents ──────────────────────────────────

  async getLinkedDocuments(orgId: string, invoiceId: string) {
    // Один preload щоб дістати workOrderId/counterpartyId (потрібні для двох з трьох
    // секцій). Якщо рахунку немає (або чужий orgId) — повертаємо порожні секції без throw
    // (дзеркало WorkOrdersService.getLinkedDocuments — семантика "нема зв'язків").
    const invoice = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, orgId, deletedAt: null },
      select: { workOrderId: true, counterpartyId: true },
    });
    if (!invoice) {
      return { workOrder: [], payments: [], counterparty: [] };
    }

    // §3.2/§7.1: take: N — захист від OOM при патологічних обсягах (десятки часткових оплат).
    const TAKE = 500;
    const [workOrder, payments, counterparty] = await Promise.all([
      invoice.workOrderId
        ? this.prisma.workOrder.findFirst({
            where: { id: invoice.workOrderId, orgId, deletedAt: null },
            select: { id: true, number: true, status: true },
          })
        : Promise.resolve(null),
      // Payment — append-only модель без deletedAt (schema.prisma: model Payment).
      this.prisma.payment.findMany({
        where: { invoiceId, orgId },
        select: { id: true, amount: true, method: true, createdAt: true, notes: true },
        orderBy: { createdAt: 'desc' },
        take: TAKE,
      }),
      this.prisma.counterparty.findFirst({
        where: { id: invoice.counterpartyId, orgId, deletedAt: null },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          companyName: true,
          phone: true,
        },
      }),
    ]);

    // §13 API Contract: Prisma Decimal → number у DTO.
    return {
      workOrder: workOrder ? [workOrder] : [],
      payments: payments.map(p => ({ ...p, amount: Number(p.amount) })),
      counterparty: counterparty ? [counterparty] : [],
    };
  }

  async getLinkedCounts(orgId: string, ids: string[]) {
    if (!ids.length) return {};

    const [invoices, payments] = await Promise.all([
      // workOrder + counterparty присутність: 1 findMany на всі id.
      this.prisma.invoice.findMany({
        where: { id: { in: ids }, orgId, deletedAt: null },
        select: { id: true, workOrderId: true, counterpartyId: true },
      }),
      // payments — groupBy по invoiceId (Payment без deletedAt).
      this.prisma.payment.groupBy({
        by: ['invoiceId'],
        where: { invoiceId: { in: ids }, orgId },
        _count: { id: true },
      }),
    ]);

    // Bug #A: count має відповідати detail (getLinkedDocuments фільтрує deletedAt:null).
    // Наявність FK ≠ наявність живого запису: контрагента можна soft-delete-нути поки
    // на нього посилається PAID-рахунок (delete-guard блокує лише відкриті рахунки).
    // Без цієї перевірки badge показував би «1 контрагент», а панель — порожню секцію.
    // workOrder-ів у списку рахунків мало посилань → одна findMany на живі workOrderId.
    const woIds = uniqueDefinedIds(invoices.map(i => i.workOrderId));
    const cpIds = uniqueDefinedIds(invoices.map(i => i.counterpartyId));
    const [liveWo, liveCp] = await Promise.all([
      woIds.length
        ? this.prisma.workOrder.findMany({
            where: { id: { in: woIds }, orgId, deletedAt: null },
            select: { id: true },
          })
        : Promise.resolve([]),
      cpIds.length
        ? this.prisma.counterparty.findMany({
            where: { id: { in: cpIds }, orgId, deletedAt: null },
            select: { id: true },
          })
        : Promise.resolve([]),
    ]);
    const liveWoSet = new Set(liveWo.map(w => w.id));
    const liveCpSet = new Set(liveCp.map(c => c.id));

    const result = initCountsMap(ids, ['workOrder', 'payments', 'counterparty'] as const);
    invoices.forEach(inv => {
      const bucket = result[inv.id];
      if (!bucket) return;
      bucket.workOrder = inv.workOrderId && liveWoSet.has(inv.workOrderId) ? 1 : 0;
      bucket.counterparty = inv.counterpartyId && liveCpSet.has(inv.counterpartyId) ? 1 : 0;
    });
    payments.forEach(r => {
      if (r.invoiceId && result[r.invoiceId]) result[r.invoiceId].payments = r._count.id;
    });
    return result;
  }
}
