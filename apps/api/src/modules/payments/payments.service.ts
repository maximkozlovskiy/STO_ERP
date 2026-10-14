import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { formatPersonName, TRANSACTION_TIMEOUT_MS, translateError } from '@sto/shared';
import { Queue } from 'bullmq';
import {
  Prisma,
  FiscalReceiptStatus,
  InvoiceStatus,
  SettlementTransactionType,
  WorkOrderStatus,
} from '@prisma/client';
import { getLocale } from '../../common/tenant/tenant-context';
import { kyivDayRangeFilter } from '../../common/utils/kyiv-date';
import { PrismaService } from '../../prisma/prisma.service';
import { SettlementsService } from '../settlements/settlements.service';
import { CashService, type CashOperationExtras } from '../cash/cash.service';
import { NotificationsService } from '../notifications/notifications.service';
import { WorkOrdersService } from '../work-orders/work-orders.service';
import { reopenPaidWorkOrderInTx } from '../work-orders/work-order-status';
import { LoyaltyService, type LoyaltyEarnReversal } from '../loyalty/loyalty.service';
import { AuditService } from '../audit/audit.service';
import { ExchangeRatesService } from '../exchange-rates/exchange-rates.service';
import { money, moneyFromDecimal } from '../../common/utils/money';
import { searchContains } from '../../common/utils/like-pattern';
import {
  CASH_METHOD_CODE,
  CreatePaymentDto,
  PaymentResponseDto,
  PaginatedPaymentsDto,
} from './payments.dto';

// Module-level Intl singleton — `.toLocaleString('uk-UA', {...})` instantiates a fresh
// Intl.NumberFormat under the hood per call. Used on every payment.create when SMS sent.
const UAH_AMOUNT_FMT = new Intl.NumberFormat('uk-UA', { minimumFractionDigits: 2 });

// Допустимі значення фіскального статусу для валідації query-фільтра (enum-driven — без
// хардкоду рядків, автоматично підхоплює нові значення FiscalReceiptStatus).
const FISCAL_STATUS_VALUES = new Set<string>(Object.values(FiscalReceiptStatus));

// Спільний include для findAll/findOne: контрагент (ім'я) + назви рахунку-призначення.
const PAYMENT_INCLUDE = {
  counterparty: { select: { firstName: true, lastName: true, companyName: true } },
  bankAccount: { select: { name: true } },
  cashRegister: { select: { name: true } },
  currency: { select: { code: true } },
} satisfies Prisma.PaymentInclude;

// Примітка фіскального статусу оплати, чий чек зняли з черги сторно (BR-CASH-024).
const REVERSED_FISCAL_NOTE = 'Оплату сторновано';

/** Сторно оплати (BR-CASH-024): рядок каси-сторно, причина й автор. */
export interface PaymentReversalContext {
  cashOperationId: string;
  reason: string;
  userId?: string;
}

/** Що змінило сторно оплати — для аудиту ПІСЛЯ коміту транзакції викликача (`afterReversal`). */
export interface PaymentReversalResult {
  paymentId: string;
  cashOperationId: string;
  /** Наряд, що повернувся з «Оплачено» у «Виставлено»; null — статус наряду не змінювався. */
  reopenedWorkOrderId: string | null;
  loyalty: LoyaltyEarnReversal;
}

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settlements: SettlementsService,
    private readonly notifications: NotificationsService,
    private readonly workOrders: WorkOrdersService,
    private readonly loyalty: LoyaltyService,
    private readonly audit: AuditService,
    private readonly cash: CashService,
    private readonly exchangeRates: ExchangeRatesService,
    @InjectQueue('checkbox') private readonly checkboxQueue: Queue,
  ) {}

  async findAll(
    orgId: string,
    opts: {
      page?: number;
      limit?: number;
      counterpartyId?: string;
      dateFrom?: string;
      dateTo?: string;
      method?: string;
      fiscalStatus?: string;
      q?: string;
    } = {},
  ): Promise<PaginatedPaymentsDto> {
    // DoS hardening: cap user-controlled pagination params.
    // payments grows monotonically (1 row per money operation); without cap
    // `?limit=999999` could OOM the API on long-running orgs.
    const safeLimit = Math.min(Math.max(opts.limit ?? 20, 1), 200);
    const safePage = Math.max(opts.page ?? 1, 1);

    const where: Prisma.PaymentWhereInput = { orgId };
    if (opts.counterpartyId) {
      // Verify the counterparty belongs to this org to prevent cross-tenant data leaks
      const cp = await this.prisma.counterparty.findFirst({
        where: { id: opts.counterpartyId, orgId, deletedAt: null },
        select: { id: true },
      });
      if (!cp)
        throw new NotFoundException(
          translateError('err.payment.counterpartyNotFound', getLocale()),
        );
      where.counterpartyId = opts.counterpartyId;
    }
    // BR-PAY-018: createdAt is a timestamp, so the day is the KYIV day (as in cash and stock
    // movements). UTC bounds put a payment made at 00:30 Kyiv time into the previous day.
    const createdAt = kyivDayRangeFilter(opts.dateFrom, opts.dateTo);
    if (createdAt) where.createdAt = createdAt;
    if (opts.method) where.method = opts.method;
    // Пошук: клієнт (назва / прізвище / ім'я), номер рахунку, номер наряду, примітка. orgId
    // лишається на верхньому рівні where — OR його не послаблює.
    // Три поля клієнта — ОДНА умова на зв'язок із вкладеним OR. Prisma робить LEFT JOIN на кожну
    // окрему умову `{ counterparty: … }`: три умови давали три з'єднання з тією самою таблицею
    // (5 JOIN замість 3), і планування запиту займало більше, ніж виконання. Виміряно на
    // dev-базі 2026-10-09 (список + count, медіана зі 150): 6,0–7,6 мс → 3,4–4,0 мс, рядки ті самі.
    const contains = searchContains(opts.q);
    if (contains) {
      where.OR = [
        { notes: contains },
        {
          counterparty: {
            OR: [{ companyName: contains }, { lastName: contains }, { firstName: contains }],
          },
        },
        { invoice: { number: contains } },
        { workOrder: { number: contains } },
      ];
    }
    // fiscalStatus: 'none' → фіскалізація не застосовна (null); інакше eq на enum-значенні.
    // Валідуємо проти enum ДО передачі у Prisma: невалідне значення (напр. ?fiscalStatus=garbage)
    // Prisma відхиляє на рівні запиту → HTTP 500 (не-i18n, шум у Sentry). Ігноруємо невідоме
    // значення (фільтр не застосовується), як для будь-якого нерозпізнаного query-параметра.
    if (opts.fiscalStatus === 'none') where.fiscalStatus = null;
    else if (opts.fiscalStatus && FISCAL_STATUS_VALUES.has(opts.fiscalStatus))
      where.fiscalStatus = opts.fiscalStatus as Prisma.PaymentWhereInput['fiscalStatus'];

    const skip = (safePage - 1) * safeLimit;
    const [items, total] = await Promise.all([
      this.prisma.payment.findMany({
        where,
        skip,
        take: safeLimit,
        orderBy: { createdAt: 'desc' },
        include: PAYMENT_INCLUDE,
      }),
      this.prisma.payment.count({ where }),
    ]);

    return { items: items.map(item => this.toDto(item)), total, page: safePage, limit: safeLimit };
  }

  async findOne(orgId: string, id: string): Promise<PaymentResponseDto> {
    const payment = await this.prisma.payment.findFirst({
      where: { id, orgId },
      include: PAYMENT_INCLUDE,
    });
    if (!payment) throw new NotFoundException(translateError('err.payment.notFound', getLocale()));
    return this.toDto(payment);
  }

  /**
   * Повторна фіскалізація невдалого чеку. Дозволено ЛИШЕ для FAILED без fiscalReceiptId
   * (idempotency: якщо чек уже пробито — receiptId заповнено — повтор заборонено, щоб не
   * створити дубль). Скидає статус у QUEUED і ставить job у чергу (як create).
   */
  async retryFiscal(orgId: string, id: string): Promise<PaymentResponseDto> {
    const payment = await this.prisma.payment.findFirst({
      where: { id, orgId },
      select: {
        id: true,
        fiscalStatus: true,
        fiscalReceiptId: true,
        method: true,
        amount: true,
        workOrderId: true,
        reversedAt: true,
      },
    });
    if (!payment) throw new NotFoundException(translateError('err.payment.notFound', getLocale()));
    // Сторнована оплата (BR-CASH-024) чека не має: обробник її пропустить, і статус завис би в QUEUED.
    if (payment.reversedAt) {
      throw new BadRequestException(translateError('err.payment.retryReversed', getLocale()));
    }
    if (payment.fiscalReceiptId) {
      throw new BadRequestException(
        translateError('err.payment.receiptAlreadyIssued', getLocale()),
      );
    }
    if (payment.fiscalStatus !== 'FAILED') {
      throw new BadRequestException(translateError('err.payment.retryOnlyFailed', getLocale()));
    }

    const branchId =
      (payment.workOrderId
        ? (
            await this.prisma.workOrder.findFirst({
              where: { id: payment.workOrderId, orgId },
              select: { branchId: true },
            })
          )?.branchId
        : undefined) ??
      (
        await this.prisma.garageBranch.findFirst({
          where: { orgId, deletedAt: null },
          orderBy: { createdAt: 'asc' },
          select: { id: true },
        })
      )?.id ??
      null;

    // CAS на прочитаному стані: сторно між читанням і записом переводить чек у SKIPPED, і
    // безумовний запис повернув би його в QUEUED — без чека й без шансу вийти з черги.
    const requeued = await this.prisma.payment.updateMany({
      where: { id, orgId, fiscalStatus: 'FAILED', fiscalReceiptId: null, reversedAt: null },
      data: { fiscalStatus: 'QUEUED', fiscalError: null },
    });
    if (requeued.count === 0) {
      throw new BadRequestException(translateError('err.payment.retryOnlyFailed', getLocale()));
    }

    await this.checkboxQueue
      .add(
        'fiscal-receipt',
        { paymentId: id, orgId, branchId, amount: Number(payment.amount), method: payment.method },
        {
          attempts: 288,
          backoff: { type: 'exponential', delay: 300_000 },
          removeOnComplete: true,
          removeOnFail: 200,
        },
      )
      .catch(async (err: unknown) => {
        this.logger.warn(
          `Черга недоступна — повторну фіскалізацію ${id} не поставлено: ${err instanceof Error ? err.message : err}`,
        );
        await this.prisma.payment
          .update({
            where: { id, orgId },
            data: { fiscalStatus: 'FAILED', fiscalError: 'Черга недоступна — чек не поставлено' },
          })
          .catch(() => undefined);
      });

    return this.findOne(orgId, id);
  }

  /**
   * `cashRow` — додатки касового рядка (стаття, документ-підстава, примітка). Внутрішній
   * параметр, НЕ поле DTO: його задає лише каса (`CashDeskService`, BR-CASH-017), коли оплату
   * вносять із картки касової операції. Діє лише для оплати в касу; без нього рядок каси той самий,
   * що й раніше.
   */
  async create(
    orgId: string,
    dto: CreatePaymentDto,
    userId?: string,
    cashRow?: CashOperationExtras,
  ): Promise<PaymentResponseDto> {
    // Single parallel batch — counterparty + workOrder (with both branchId + status
    // selected in one query, replacing the prior duplicate findFirst calls).
    const [counterparty, workOrder, methodConfig] = await Promise.all([
      this.prisma.counterparty.findFirst({
        where: { id: dto.counterpartyId, orgId, deletedAt: null },
        select: {
          id: true,
          phone: true,
          email: true,
          firstName: true,
          lastName: true,
          companyName: true,
        },
      }),
      dto.workOrderId
        ? this.prisma.workOrder.findFirst({
            where: { id: dto.workOrderId, orgId, deletedAt: null },
            // Мультивалюта (Фаза 3): currencyId наряду — оплата має бути у ТІЙ САМІЙ валюті
            // (WO.paidAmount ведеться у валюті наряду; крос-валютна алокація = FX-політика, поза scope).
            select: {
              branchId: true,
              status: true,
              currencyId: true,
              counterpartyId: true,
              totalAmount: true,
              paidAmount: true,
            },
          })
        : Promise.resolve(null),
      // Спосіб оплати: requiresFiscal (для ПРРО) + дефолтний рахунок-призначення (мапінг
      // method→куди лягають гроші). Невідомий метод → фіскалізацію НЕ ставимо.
      this.prisma.paymentMethodConfig.findFirst({
        where: { orgId, code: dto.method, deletedAt: null },
        select: {
          requiresFiscal: true,
          defaultSourceType: true,
          defaultBankAccountId: true,
          defaultCashRegisterId: true,
        },
      }),
    ]);
    if (!counterparty)
      throw new NotFoundException(translateError('err.payment.counterpartyNotFound', getLocale()));

    // Рахунок-призначення: DTO задає явно, інакше дефолт з methodConfig. sourceType↔id узгоджені.
    const resolvedSource = await this.resolveDestinationAccount(orgId, dto, methodConfig);

    // BR-PAY-019: готівка без каси — гроші, яких не видно в жодній касі (борг погашено, а залишок
    // каси й її історія про оплату не знають). Перевірка ПІСЛЯ розв'язання: каса з запиту або каса
    // за замовчуванням способу оплати; застаріле замовчування (касу видалено) теж дає 400.
    if (dto.method === CASH_METHOD_CODE && resolvedSource.sourceType !== 'CASH_REGISTER')
      throw new BadRequestException(
        translateError('err.payment.cashRequiresRegister', getLocale()),
      );

    // Наряд вказано, але його немає (чужа org або видалений) → 404 ДО транзакції. Без цього всі
    // перевірки наряду нижче (`&& workOrder`) мовчали: статус, замовник, валюта й залишок
    // (BR-PAY-001/016/017) не застосовувались, а видалений наряд (читання в транзакції не
    // дивилось на deletedAt) отримував paidAmount.
    if (dto.workOrderId && !workOrder)
      throw new NotFoundException(translateError('err.workOrder.notFound', getLocale()));

    // Pre-validate work order status before opening transaction to avoid partial commit.
    // Status was fetched in the parallel batch above — no extra query needed.
    if (workOrder && workOrder.status !== 'INVOICED') {
      throw new BadRequestException(
        translateError('err.payment.workOrderStatusNoPayment', getLocale(), {
          status: workOrder.status,
        }),
      );
    }

    // BR-PAY-016, пряма оплата наряду (без рахунку): наряд закриває лише його замовник. Без цього
    // платіж контрагента A піднімав paidAmount наряду контрагента B і переводив його в PAID, а
    // гроші лягали на баланс A — та сама діра, що її перевірка платника закриває для рахунку.
    // Якщо рахунок вказано, платника визначає РАХУНОК (його можна виписати на іншого платника,
    // напр. страхову) — тоді ця перевірка мовчить, діє перевірка рахунку нижче.
    if (workOrder && !dto.invoiceId && workOrder.counterpartyId !== dto.counterpartyId) {
      throw new BadRequestException(
        translateError('err.payment.workOrderNotForCounterparty', getLocale()),
      );
    }

    // Тригер чека ПРРО = спосіб оплати вимагає (requiresFiscal) АБО оплата йде у ФІСКАЛЬНУ касу
    // (register.isFiscal). Другий тригер робить фіскальною будь-яку операцію через фіскальну касу,
    // незалежно від методу. Обидва хибні → чек не ставимо, fiscalStatus=null (не застосовно).
    const willFiscalize =
      methodConfig?.requiresFiscal === true ||
      (resolvedSource.sourceType === 'CASH_REGISTER' &&
        resolvedSource.cashRegisterIsFiscal === true);

    // Мультивалюта (Фаза 2): якщо рахунок-призначення має валюту → конвертуємо суму оплати у
    // БАЗОВУ (amountBase по курсу на дату). Ці поля лягають і в Payment, і у settlement-борг
    // (createTransaction отримує currencyId → баланс зводиться у base). Без валюти рахунку →
    // base (rate=1, amountBase=amount): BC для орг без мультивалюти. cash.createOperation
    // конвертує сам (Фаза 1) — тут НЕ дублюємо, лише Payment+settlement.
    const paymentCurrencyId = resolvedSource.currencyId ?? null;
    const conv = paymentCurrencyId
      ? await this.exchangeRates.resolveBaseConversion(
          orgId,
          paymentCurrencyId,
          new Date(),
          dto.amount,
        )
      : { rateUsed: 1, amountBase: dto.amount };

    // Інваріант «фіскальна каса = UAH»: ПРРО (Checkbox/Vchasno) фіскалізує чеки лише у базовій
    // валюті. Оплата у фіскальну касу/метод в іновалюті створила б чек у не-UAH → відхиляємо.
    if (willFiscalize && paymentCurrencyId) {
      const base = await this.exchangeRates.getBaseCurrency(orgId);
      if (paymentCurrencyId !== base.id) {
        throw new BadRequestException(
          translateError('err.payment.fiscalOnlyBaseCurrency', getLocale(), { code: base.code }),
        );
      }
    }

    // Мультивалюта (Фаза 3): пряма оплата наряду (без invoiceId) — валюта оплати мусить збігатися
    // з валютою наряду. WO.paidAmount інкрементується у ВАЛЮТІ наряду (dto.amount), тож оплата у
    // іншій валюті змішала б одиниці у paidAmount (та сама вада, що invoice-guard нижче ловить для
    // рахунку). NULL currencyId (історичні/base) ≡ базова валюта. Дзеркалить invoice-перевірку;
    // для WO-with-invoice invoice-guard спрацьовує додатково (invoice успадковує валюту наряду).
    if (workOrder) {
      if (
        !(await this.exchangeRates.sameCurrency(orgId, paymentCurrencyId, workOrder.currencyId))
      ) {
        throw new BadRequestException(
          translateError('err.payment.currencyMustMatchWorkOrder', getLocale()),
        );
      }
    }

    // BR-PAY-017, швидка відмова ДО транзакції: пряма оплата наряду не може перевищити залишок до
    // сплати (після перевірки валюти вище — суми порівнюються в одній валюті).
    // Це зручність (4xx без відкритої транзакції) — авторитетна перевірка з тим самим
    // правилом стоїть у транзакції нижче, на свіжо прочитаних сумах.
    if (workOrder && !dto.invoiceId) {
      this.assertWithinWorkOrderRemaining(workOrder.totalAmount, workOrder.paidAmount, dto.amount);
    }

    let workOrderFullyPaid = false;
    const payment = await this.prisma.$transaction(
      async tx => {
        // Курсові різниці (Фаза 4): захоплюємо контекст іновалютного рахунку, що став PAID цим платежем,
        // щоб ПІСЛЯ запису Payment+PAYMENT-settlement (paidBase має включати цей платіж) визнати FX.
        let fxContext: { invoiceId: string; chargeDocType: string; chargeDocId: string } | null =
          null;
        // Часткова оплата з захистом від переплати під concurrency (FIN-C1 еволюція):
        // читаємо amount/paidAmount/status; валідуємо суму ≤ залишку; атомарно інкрементуємо
        // paidAmount ЛИШЕ якщо paidAmount не змінився з-під нас (CAS через updateMany where
        // paidAmount=прочитане). count=0 → конкурентний платіж змінив paidAmount → throw/rollback.
        if (dto.invoiceId) {
          const inv = await tx.invoice.findFirst({
            where: { id: dto.invoiceId, orgId, deletedAt: null },
            // Мультивалюта (Фаза 3): currencyId рахунку — оплата має бути у ТІЙ САМІЙ валюті.
            select: {
              id: true,
              status: true,
              workOrderId: true,
              counterpartyId: true,
              amount: true,
              paidAmount: true,
              currencyId: true,
            },
          });
          if (inv) {
            // OVERDUE теж оплачуваний (прострочений рахунок ще належить сплатити); часткова
            // оплата переведе його у PARTIALLY_PAID, повна — у PAID.
            if (
              inv.status !== 'SENT' &&
              inv.status !== 'PARTIALLY_PAID' &&
              inv.status !== 'OVERDUE'
            ) {
              throw new BadRequestException(
                translateError('err.payment.invoiceStatusNoPayment', getLocale(), {
                  status: inv.status,
                }),
              );
            }
            // Рахунок закриває лише його платник. Раніше платіж контрагента A міг закрити рахунок
            // контрагента B: гроші лягали на баланс A, а борг B зникав. Єдине місце правди для
            // ручного платежу, рознесення виписки й онлайн-оплати (усі йдуть через create).
            if (inv.counterpartyId !== dto.counterpartyId) {
              throw new BadRequestException(
                translateError('err.payment.invoiceNotForCounterparty', getLocale()),
              );
            }
            if (dto.workOrderId && inv.workOrderId && inv.workOrderId !== dto.workOrderId) {
              throw new BadRequestException(
                translateError('err.payment.invoiceNotForWorkOrder', getLocale()),
              );
            }
            // Мультивалюта (Фаза 3): валюта оплати мусить збігатися з валютою рахунку — інакше
            // крос-валютна алокація (яким курсом закрити залишок = FX-політика, поза scope).
            // NULL currencyId (історичні/base) вважаємо еквівалентними базовій валюті.
            if (
              !(await this.exchangeRates.sameCurrency(orgId, paymentCurrencyId, inv.currencyId))
            ) {
              throw new BadRequestException(
                translateError('err.payment.currencyMustMatchInvoice', getLocale()),
              );
            }
            const invAmount = Number(inv.amount);
            const prevPaid = Number(inv.paidAmount);
            const remaining = invAmount - prevPaid;
            // Мультивалюта (Фаза 3): invoice.amount/paidAmount тепер у ВАЛЮТІ рахунку, а оплата — у
            // тій самій валюті (перевірено вище) → порівнюємо/накопичуємо dto.amount (у валюті),
            // НЕ conv.amountBase. Борг у леджері все одно лягає у base через settlement.
            if (dto.amount > remaining + 1e-9) {
              throw new BadRequestException(
                translateError('err.payment.amountExceedsInvoiceRemaining', getLocale(), {
                  remaining: remaining.toFixed(2),
                }),
              );
            }
            const newPaid = prevPaid + dto.amount;
            const newStatus = newPaid >= invAmount - 1e-9 ? 'PAID' : 'PARTIALLY_PAID';
            // CAS: оновлюємо лише якщо paidAmount досі == prevPaid (не змінений конкурентом).
            const updated = await tx.invoice.updateMany({
              where: { id: dto.invoiceId, orgId, deletedAt: null, paidAmount: inv.paidAmount },
              data: { paidAmount: newPaid, status: newStatus },
            });
            if (updated.count === 0) {
              throw new BadRequestException(
                translateError('err.payment.invoiceConcurrentChange', getLocale()),
              );
            }
            // Курсові різниці (Фаза 4): рахунок став PAID цим платежем + валюта НЕ базова →
            // після запису PAYMENT-settlement визнаємо realized FX. CHARGE нараховувався проти
            // наряду (WO-рахунок) або самого рахунку (standalone) — реконструюємо base з леджера.
            if (
              newStatus === 'PAID' &&
              !(await this.exchangeRates.sameCurrency(orgId, null, inv.currencyId))
            ) {
              fxContext = {
                invoiceId: inv.id,
                chargeDocType: inv.workOrderId ? 'WorkOrder' : 'Invoice',
                chargeDocId: inv.workOrderId ?? inv.id,
              };
            }
          }
        }

        const created = await tx.payment.create({
          data: {
            orgId,
            counterpartyId: dto.counterpartyId,
            workOrderId: dto.workOrderId ?? null,
            invoiceId: dto.invoiceId ?? null,
            amount: dto.amount,
            // Мультивалюта (Фаза 2): валюта рахунку + base-сума по курсу на дату.
            currencyId: paymentCurrencyId,
            amountBase: conv.amountBase,
            rateUsed: conv.rateUsed,
            method: dto.method,
            notes: dto.notes ?? null,
            // Рахунок-призначення (куди фізично лягли гроші) — з DTO або дефолту methodConfig.
            sourceType: resolvedSource.sourceType,
            bankAccountId: resolvedSource.bankAccountId,
            cashRegisterId: resolvedSource.cashRegisterId,
            // Idempotency-лінк на онлайн-намір (Bug #688): @unique у БД відкидає повторний create
            // того ж наміру (P2002) під час реконсиляції → жодного тихого double-charge.
            onlinePaymentIntentId: dto.onlinePaymentIntentId ?? null,
            // QUEUED коли ставимо в чергу; null коли фіскалізація не застосовна до методу.
            fiscalStatus: willFiscalize ? 'QUEUED' : null,
          },
          include: PAYMENT_INCLUDE,
        });

        await this.settlements.createTransaction(
          orgId,
          {
            counterpartyId: dto.counterpartyId,
            // Тип проводки: дефолт PAYMENT (звичайна оплата). Bank-statement рознесення передає
            // PREPAYMENT (аванс) / REFUND (повернення) — BALANCE_SIGN різний знак. append-only-safe.
            type: dto.settlementType ?? 'PAYMENT',
            amount: dto.amount,
            // Мультивалюта (Фаза 2): передаємо валюту → борг лягає у base (amountBase). createTransaction
            // сам конвертує (спільне джерело курсу). Без currencyId → base (BC для UAH-орг).
            currencyId: paymentCurrencyId ?? undefined,
            documentType: 'Payment',
            documentId: created.id,
            createdBy: userId,
          },
          tx,
        );

        // Курсові різниці (Фаза 4): рахунок повністю сплачено в іновалюті → base-залишок ≠ 0, бо
        // CHARGE брав курс дати документа, а PAYMENT — курс дати оплати. Реалізуємо FX однією
        // проводкою, що обнуляє залишок. paidBase агрегується ПІСЛЯ create цього Payment (включений).
        if (fxContext) {
          const [chargeAgg, paidAgg, fxExisting] = await Promise.all([
            tx.settlementTransaction.aggregate({
              where: {
                orgId,
                type: 'CHARGE',
                documentType: fxContext.chargeDocType,
                documentId: fxContext.chargeDocId,
              },
              _sum: { amountBase: true },
            }),
            tx.payment.aggregate({
              where: { orgId, invoiceId: fxContext.invoiceId, reversedAt: null },
              _sum: { amountBase: true },
            }),
            // Idempotency: якщо FX для цього рахунку вже проведено — не дублюємо (повторний PAID).
            tx.settlementTransaction.count({
              where: {
                orgId,
                type: { in: ['FX_GAIN', 'FX_LOSS'] },
                documentType: 'Invoice',
                documentId: fxContext.invoiceId,
              },
            }),
          ]);
          if (fxExisting === 0) {
            const chargeBase = moneyFromDecimal(chargeAgg._sum.amountBase);
            const paidBase = moneyFromDecimal(paidAgg._sum.amountBase);
            const fx = money(chargeBase - paidBase);
            // EPS 0.005: нижче — копійчаний дрейф округлення / той самий курс → FX не потрібна
            // (і createTransaction відхилив би amount≤0).
            if (Math.abs(fx) >= 0.005) {
              await this.settlements.createTransaction(
                orgId,
                {
                  counterpartyId: dto.counterpartyId,
                  // fx>0: нарахували більше base ніж отримали → збиток (гасить додатний залишок).
                  type: fx > 0 ? 'FX_LOSS' : 'FX_GAIN',
                  amount: Math.abs(fx),
                  // БЕЗ currencyId → base-дельта (rate=1, base=amount); інакше re-конвертація зіпсує суму.
                  documentType: 'Invoice',
                  documentId: fxContext.invoiceId,
                  notes: `Курсова різниця: нараховано ${chargeBase.toFixed(2)} за курсом документа, отримано ${paidBase.toFixed(2)} за курсом оплат`,
                  createdBy: userId,
                },
                tx,
              );
            }
          }
        }

        if (dto.workOrderId) {
          // BR-PAY-017: наряд «Оплачено» лише при ПОВНІЙ оплаті. Читаємо суму до сплати й уже
          // оплачене в транзакції; пряма оплата (без рахунку) не може перевищити залишок; paidAmount
          // пишеться CAS-ом (як у рахунку) — два одночасні платежі не «з'їдять» один одного.
          const woInTx = await tx.workOrder.findFirst({
            where: { id: dto.workOrderId, orgId, deletedAt: null },
            select: { totalAmount: true, paidAmount: true },
          });
          if (!woInTx)
            throw new NotFoundException(translateError('err.workOrder.notFound', getLocale()));
          const woTotal = moneyFromDecimal(woInTx.totalAmount);
          const woPrevPaid = moneyFromDecimal(woInTx.paidAmount);
          if (!dto.invoiceId) {
            this.assertWithinWorkOrderRemaining(woInTx.totalAmount, woInTx.paidAmount, dto.amount);
          }
          // Мультивалюта (Фаза 3): WorkOrder.paidAmount у ВАЛЮТІ наряду; оплата збігається з нею
          // (перевірено вище) → додаємо dto.amount, не conv.amountBase.
          const woNewPaid = money(woPrevPaid + dto.amount);
          const woUpdated = await tx.workOrder.updateMany({
            where: { id: dto.workOrderId, orgId, paidAmount: woInTx.paidAmount },
            data: { paidAmount: woNewPaid },
          });
          if (woUpdated.count === 0) {
            throw new BadRequestException(
              translateError('err.payment.workOrderConcurrentChange', getLocale()),
            );
          }
          workOrderFullyPaid = woNewPaid >= woTotal - 1e-9;
        }

        // Готівкова оплата → рух готівки у касу (cash-in). У ту саму транзакцію, щоб не розсинхронити
        // оплату/розрахунок/касу. Фіскальна каса вимагає відкриту зміну (кине 400 → відкат усього).
        if (resolvedSource.sourceType === 'CASH_REGISTER' && resolvedSource.cashRegisterId) {
          await this.cash.createOperation(
            orgId,
            {
              cashRegisterId: resolvedSource.cashRegisterId,
              direction: 'IN',
              amount: dto.amount,
              reason: 'SALE_PAYMENT',
              counterpartyId: dto.counterpartyId,
              documentType: 'Payment',
              documentId: created.id,
              createdBy: userId,
              ...cashRow,
            },
            tx,
          );
        }

        return created;
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    ); // explicit timeout — payment + settlement + invoice/WO updates

    // FSM INVOICED→PAID outside tx (WorkOrdersService has its own tx). Safe: payment + settlement
    // already committed; if transition fails, operator retries status manually.
    // BR-PAY-017: лише коли наряд оплачено повністю — часткова оплата лишає його INVOICED, і
    // решту можна доплатити наступним платежем через наряд.
    if (dto.workOrderId && workOrderFullyPaid) {
      await this.workOrders
        .transition(orgId, dto.workOrderId, 'PAID', userId)
        .catch((e: unknown) => {
          this.logger.warn(
            `Не вдалось перевести наряд ${dto.workOrderId} у статус PAID після оплати: ${e instanceof Error ? e.message : e}`,
          );
        });
    }

    if (counterparty.phone || counterparty.email) {
      // Bug fix: send() рано виходить без branchId → PAYMENT_RECEIVED раніше НІКОЛИ не слався.
      // Беремо branchId наряду; для standalone-оплати (без наряду) — найстаріша філія org
      // (дзеркалить followup.processor). Резолвимо лениво, лише якщо наряду немає.
      const branchId =
        workOrder?.branchId ??
        (
          await this.prisma.garageBranch.findFirst({
            where: { orgId, deletedAt: null },
            orderBy: { createdAt: 'asc' },
            select: { id: true },
          })
        )?.id;
      this.notifications
        .send(orgId, 'PAYMENT_RECEIVED', {
          branchId,
          phone: counterparty.phone,
          email: counterparty.email,
          amount: UAH_AMOUNT_FMT.format(dto.amount),
          clientName: formatPersonName(
            counterparty.lastName,
            counterparty.firstName,
            counterparty.companyName,
          ),
        })
        .catch((err: unknown) =>
          this.logger.warn(
            `Payment notification failed: ${err instanceof Error ? err.message : err}`,
          ),
        );
    }

    // Enqueue Checkbox fiscal receipt ЛИШЕ для методів з requiresFiscal (offline-first: retry
    // 288× = 24h). Без гейта чек ставився б на КОЖЕН платіж (готівка/безнал/бартер) → зайві
    // job-и + помилкові чеки. fiscalEnabled лишається downstream-гейтом у processor.
    // Offline-first (CLAUDE.md §3): транзакція вже закомічена (платіж + settlement + інвойс→PAID).
    // Якщо Redis недоступний, .add() кине — але фінансова операція вже успішна, тож НЕ валимо запит
    // (дзеркалить loyalty.queueEarn нижче). Знімаємо платіж з QUEUED → FAILED, щоб він не завис
    // навічно у QUEUED без жодного job-а; оператор побачить причину й зможе переставити чек.
    // removeOnFail: 200 — bounded retention (конвенція sms/notifications/webhooks), інакше
    // назавжди-невдалі job-и (attempts=288) осідають у Redis без обмеження.
    if (willFiscalize) {
      await this.checkboxQueue
        .add(
          'fiscal-receipt',
          {
            paymentId: payment.id,
            orgId,
            branchId: workOrder?.branchId ?? null,
            amount: dto.amount,
            method: dto.method,
          },
          {
            attempts: 288,
            backoff: { type: 'exponential', delay: 300_000 }, // 5 min initial
            removeOnComplete: true,
            removeOnFail: 200,
          },
        )
        .catch(async (err: unknown) => {
          this.logger.warn(
            `Не вдалось поставити фіскальний чек у чергу для платежу ${payment.id}: ${err instanceof Error ? err.message : err}`,
          );
          await this.prisma.payment
            .update({
              where: { id: payment.id, orgId },
              data: { fiscalStatus: 'FAILED', fiscalError: 'Черга недоступна — чек не поставлено' },
            })
            .catch(() => undefined);
        });
    }

    // Non-blocking loyalty earn: if queue is down, log warning, payment stands.
    // BullMQ job checks OrganisationSettings.loyaltyEnabled — exits without writing if disabled.
    // Мультивалюта (Фаза 2): бали від amountBase (у base), не dto.amount — інакше 100 USD дали б
    // стільки ж балів, скільки 100 UAH. loyaltyEarnPer трактується у базовій валюті.
    await this.loyalty
      .queueEarn(orgId, dto.counterpartyId, conv.amountBase, payment.id)
      .catch((err: unknown) =>
        this.logger.warn(
          `Loyalty earn enqueue failed: ${err instanceof Error ? err.message : err}`,
        ),
      );

    // C1: аудит створення платежу (money-critical — «хто зареєстрував оплату»). Best-effort
    // post-commit (як work-orders): помилка аудиту не відкочує вже-створений платіж.
    if (userId) {
      this.audit
        .record(orgId, 'Payment', payment.id, 'CREATE', userId, undefined, {
          amount: Number(dto.amount),
          method: dto.method,
          counterpartyId: dto.counterpartyId,
          invoiceId: dto.invoiceId ?? null,
        })
        .catch((e: unknown) =>
          this.logger.warn(`Audit record failed: ${e instanceof Error ? e.message : e}`),
        );
    }

    return this.toDto(payment);
  }

  /**
   * Сторно оплати клієнта (BR-CASH-024) — внутрішній метод без маршруту: викликає лише каса
   * (`CashDeskService.reverse`) у СВОЇЙ транзакції, після запису рядка сторно (його id —
   * `ctx.cashOperationId`). Відкочує все, що зробила оплата: борг (проводка `PAYMENT_CANCEL` /
   * `PREPAYMENT_CANCEL` з курсом оригіналу), «сплачено» й статус рахунку й наряду, чек у черзі,
   * бонуси. Відмова — до першого запису; будь-яка відмова відкочує й рядок сторно.
   *
   * Повторне сторно відсікає CAS `reversedAt: null` (пишеться один раз, як фіскальні поля).
   */
  async reverse(
    orgId: string,
    paymentId: string,
    ctx: PaymentReversalContext,
    tx: Prisma.TransactionClient,
  ): Promise<PaymentReversalResult> {
    const locale = getLocale();
    const payment = await tx.payment.findFirst({
      where: { id: paymentId, orgId },
      select: {
        id: true,
        counterpartyId: true,
        workOrderId: true,
        invoiceId: true,
        amount: true,
        currencyId: true,
        fiscalStatus: true,
        fiscalReceiptId: true,
        reversedAt: true,
      },
    });
    if (!payment) throw new NotFoundException(translateError('err.payment.notFound', locale));
    if (payment.reversedAt) {
      throw new BadRequestException(translateError('err.cash.alreadyReversed', locale));
    }
    // Чека повернення в системі немає: пробитий чек лишився б за оплатою, якої вже немає.
    if (payment.fiscalStatus === FiscalReceiptStatus.DONE || payment.fiscalReceiptId) {
      throw new BadRequestException(translateError('err.cash.reversalFiscalDone', locale));
    }
    // Іновалютна оплата могла закрити рахунок і провести курсову різницю — сторно її не
    // відкочує (питання власнику), тож таку оплату не сторнуємо зовсім.
    if (!(await this.exchangeRates.sameCurrency(orgId, payment.currencyId, null))) {
      throw new BadRequestException(translateError('err.cash.reversalForeignCurrency', locale));
    }

    const [workOrder, invoice] = await Promise.all([
      payment.workOrderId
        ? tx.workOrder.findFirst({
            where: { id: payment.workOrderId, orgId, deletedAt: null },
            select: { status: true, paidAmount: true, totalAmount: true },
          })
        : null,
      payment.invoiceId
        ? tx.invoice.findFirst({
            where: { id: payment.invoiceId, orgId, deletedAt: null },
            select: { status: true, paidAmount: true, amount: true },
          })
        : null,
    ]);
    if (workOrder?.status === WorkOrderStatus.ARCHIVED) {
      throw new BadRequestException(translateError('err.cash.reversalWorkOrderArchived', locale));
    }
    if (invoice?.status === InvoiceStatus.CANCELLED) {
      throw new BadRequestException(translateError('err.cash.reversalInvoiceCancelled', locale));
    }

    // Проводка оплати: її тип визначає тип сторно, її курс — курс сторно (як BR-BANK-039: курс,
    // доданий чи виправлений після оплати, не має лишити різниці в балансі).
    const original = await tx.settlementTransaction.findFirst({
      where: {
        orgId,
        documentType: 'Payment',
        documentId: payment.id,
        type: { in: ['PAYMENT', 'PREPAYMENT', 'REFUND'] },
      },
      orderBy: { createdAt: 'asc' },
      select: { type: true, amount: true, currencyId: true, amountBase: true, rateUsed: true },
    });
    if (!original || original.amountBase == null || original.rateUsed == null) {
      throw new BadRequestException(translateError('err.cash.reversalStateChanged', locale));
    }

    // CAS першим записом: друге сторно (паралельне чи повторне) тут програє, нічого не змінивши.
    // Чек, що ще чекає в черзі, знімаємо тим самим записом — обробник пропускає сторновану оплату.
    const fiscalPending =
      payment.fiscalStatus === FiscalReceiptStatus.QUEUED ||
      payment.fiscalStatus === FiscalReceiptStatus.FAILED;
    // У `where` — і прочитаний стан чека: обробник пише DONE без блокування, і чек, пробитий між
    // читанням вище й цим записом, інакше пройшов би повз відмову «чек уже пробито», а його DONE
    // затерло б SKIPPED (review 2026-10-14).
    const claimed = await tx.payment.updateMany({
      where: {
        id: payment.id,
        orgId,
        reversedAt: null,
        fiscalReceiptId: null,
        fiscalStatus: payment.fiscalStatus,
      },
      data: {
        reversedAt: new Date(),
        reversalCashOperationId: ctx.cashOperationId,
        ...(fiscalPending && {
          fiscalStatus: FiscalReceiptStatus.SKIPPED,
          fiscalError: REVERSED_FISCAL_NOTE,
        }),
      },
    });
    if (claimed.count === 0) {
      // Програв CAS: або оплату вже сторновано, або змінився її чек (його щойно пробито).
      const now = await tx.payment.findFirst({
        where: { id: payment.id, orgId },
        select: { reversedAt: true, fiscalStatus: true, fiscalReceiptId: true },
      });
      if (
        !now?.reversedAt &&
        (now?.fiscalStatus === FiscalReceiptStatus.DONE || now?.fiscalReceiptId)
      ) {
        throw new BadRequestException(translateError('err.cash.reversalFiscalDone', locale));
      }
      throw new BadRequestException(
        translateError(
          now?.reversedAt ? 'err.cash.alreadyReversed' : 'err.cash.reversalStateChanged',
          locale,
        ),
      );
    }

    // REFUND (рознесення виписки) має той самий знак, що й PAYMENT (−1), — його сторно теж +1.
    await this.settlements.createTransaction(
      orgId,
      {
        counterpartyId: payment.counterpartyId,
        type:
          original.type === SettlementTransactionType.PREPAYMENT
            ? 'PREPAYMENT_CANCEL'
            : 'PAYMENT_CANCEL',
        amount: Number(original.amount),
        currencyId: original.currencyId ?? undefined,
        conversion: {
          rateUsed: Number(original.rateUsed),
          amountBase: Number(original.amountBase),
        },
        documentType: 'CashOperation',
        documentId: ctx.cashOperationId,
        notes: ctx.reason,
        createdBy: ctx.userId,
      },
      tx,
    );

    const amount = moneyFromDecimal(payment.amount);

    // «Сплачено» рахунку назад (не нижче нуля); «Оплачено» / «Частково оплачено» → «Частково
    // оплачено» або «Виставлено». Статус — та сама формула, що в create, лише навпаки: сплачене
    // й далі покриває суму рахунку → лишається «Оплачено». CAS на прочитаних сумі й статусі.
    if (invoice && payment.invoiceId) {
      const newPaid = money(Math.max(0, moneyFromDecimal(invoice.paidAmount) - amount));
      const wasPaid =
        invoice.status === InvoiceStatus.PAID || invoice.status === InvoiceStatus.PARTIALLY_PAID;
      const newStatus = !wasPaid
        ? invoice.status
        : newPaid >= moneyFromDecimal(invoice.amount) - 1e-9
          ? InvoiceStatus.PAID
          : newPaid > 0
            ? InvoiceStatus.PARTIALLY_PAID
            : InvoiceStatus.SENT;
      const moved = await tx.invoice.updateMany({
        where: {
          id: payment.invoiceId,
          orgId,
          deletedAt: null,
          paidAmount: invoice.paidAmount,
          status: invoice.status,
        },
        data: { paidAmount: newPaid, status: newStatus },
      });
      if (moved.count === 0) {
        throw new BadRequestException(
          translateError('err.payment.invoiceConcurrentChange', locale),
        );
      }
    }

    // Наряд — лише якщо оплата йшла за ним (`workOrderId`): «сплачено» назад (не нижче нуля),
    // «Оплачено» → «Виставлено», якщо наряд уже не сплачений повністю (BR-PAY-017 навпаки: інші
    // оплати можуть і далі покривати суму наряду — тоді він лишається «Оплачено»). Зворотного переходу в публічній карті (WORK_ORDER_TRANSITIONS)
    // немає і не буде: статус пише окремий внутрішній хелпер модуля нарядів (BR-WO-001).
    let reopenedWorkOrderId: string | null = null;
    if (workOrder && payment.workOrderId) {
      const newPaid = money(Math.max(0, moneyFromDecimal(workOrder.paidAmount) - amount));
      const stillFullyPaid = newPaid >= moneyFromDecimal(workOrder.totalAmount) - 1e-9;
      if (workOrder.status === WorkOrderStatus.PAID && !stillFullyPaid) {
        await reopenPaidWorkOrderInTx(
          tx,
          orgId,
          payment.workOrderId,
          workOrder.paidAmount,
          newPaid,
        );
        reopenedWorkOrderId = payment.workOrderId;
      } else {
        const moved = await tx.workOrder.updateMany({
          where: {
            id: payment.workOrderId,
            orgId,
            deletedAt: null,
            paidAmount: workOrder.paidAmount,
            status: workOrder.status,
          },
          data: { paidAmount: newPaid },
        });
        if (moved.count === 0) {
          throw new BadRequestException(
            translateError('err.payment.workOrderConcurrentChange', locale),
          );
        }
      }
    }

    const loyalty = await this.loyalty.reverseEarn(orgId, payment.id, tx);

    return {
      paymentId: payment.id,
      cashOperationId: ctx.cashOperationId,
      reopenedWorkOrderId,
      loyalty,
    };
  }

  /**
   * Аудит сторно оплати — ПІСЛЯ коміту транзакції викликача, best-effort (як аудит створення):
   * збій журналу аудиту не відкочує вже проведене сторно. Зміну статусу наряду пишемо тим самим
   * записом, що й FSM-перехід (`WorkOrderTransitionedEvent` → `UPDATE status`).
   */
  afterReversal(orgId: string, result: PaymentReversalResult, userId?: string): void {
    if (!userId) return;
    const warn = (e: unknown) =>
      this.logger.warn(`Audit record failed: ${e instanceof Error ? e.message : String(e)}`);
    this.audit
      .record(
        orgId,
        'Payment',
        result.paymentId,
        'UPDATE',
        userId,
        { reversedAt: null },
        {
          reversedAt: new Date().toISOString(),
          reversalCashOperationId: result.cashOperationId,
          loyaltyEarned: result.loyalty.earned,
          loyaltyDeducted: result.loyalty.deducted,
        },
      )
      .catch(warn);
    if (result.reopenedWorkOrderId) {
      this.audit
        .record(
          orgId,
          'WorkOrder',
          result.reopenedWorkOrderId,
          'UPDATE',
          userId,
          { status: WorkOrderStatus.PAID },
          { status: WorkOrderStatus.INVOICED },
        )
        .catch(warn);
    }
  }

  /** BR-PAY-017: пряма оплата наряду не перевищує залишок до сплати (total − paid). */
  private assertWithinWorkOrderRemaining(
    totalAmount: Prisma.Decimal,
    paidAmount: Prisma.Decimal,
    amount: number,
  ): void {
    const remaining = money(moneyFromDecimal(totalAmount) - moneyFromDecimal(paidAmount));
    if (amount > remaining + 1e-9) {
      throw new BadRequestException(
        translateError('err.payment.amountExceedsWorkOrderRemaining', getLocale(), {
          remaining: remaining.toFixed(2),
        }),
      );
    }
  }

  /**
   * Резолвить рахунок-призначення платежу: DTO явно → інакше дефолт з methodConfig → інакше null.
   * Валідує узгодженість sourceType↔id і що рахунок у межах org (не крос-tenant).
   *
   * Ключова відмінність за джерелом (offline-first, CLAUDE.md §3 «система не зупиняється»):
   *  - ЯВНО з DTO → строга валідація: невалідний/чужий/видалений рахунок → кидаємо (4xx). Це
   *    ввід користувача, він мусить бути коректним.
   *  - НЕЯВНО з methodConfig-дефолту → best-effort: якщо дефолтний рахунок з тих пір видалено
   *    (stale config), НЕ валимо легітимний платіж — тихо знімаємо source-link (null). Рахунок-
   *    призначення — опційна метадані (куди фізично лягли гроші), борг/settlement не залежать від
   *    нього; блокувати рух грошей через застарілий конфіг було б неправильно.
   */
  private async resolveDestinationAccount(
    orgId: string,
    dto: CreatePaymentDto,
    methodConfig: {
      defaultSourceType?: 'BANK_ACCOUNT' | 'CASH_REGISTER' | null;
      defaultBankAccountId?: string | null;
      defaultCashRegisterId?: string | null;
    } | null,
  ): Promise<{
    sourceType: 'BANK_ACCOUNT' | 'CASH_REGISTER' | null;
    bankAccountId: string | null;
    cashRegisterId: string | null;
    /** true → каса фіскальна: будь-яка оплата у неї пробиває чек ПРРО (тригер незалежно від методу). */
    cashRegisterIsFiscal?: boolean;
    /** Валюта рахунку-призначення (bank/cash) — валюта Payment (мультивалюта Фаза 2). null → базова. */
    currencyId?: string | null;
  }> {
    // Джерело значень: DTO задав хоч одне поле → explicit; інакше беремо дефолт methodConfig.
    const fromDto = !!(dto.sourceType || dto.bankAccountId || dto.cashRegisterId);
    const sourceType = dto.sourceType ?? methodConfig?.defaultSourceType ?? null;
    const bankAccountId = fromDto
      ? (dto.bankAccountId ?? null)
      : (methodConfig?.defaultBankAccountId ?? null);
    const cashRegisterId = fromDto
      ? (dto.cashRegisterId ?? null)
      : (methodConfig?.defaultCashRegisterId ?? null);

    if (!sourceType) return { sourceType: null, bankAccountId: null, cashRegisterId: null };

    const empty = { sourceType: null, bankAccountId: null, cashRegisterId: null } as const;

    if (sourceType === 'BANK_ACCOUNT') {
      if (!bankAccountId) {
        // Explicit sourceType без id — помилка вводу. Config-дефолт без id — просто ігноруємо.
        if (fromDto)
          throw new BadRequestException(
            translateError('err.payment.bankAccountNotSpecified', getLocale()),
          );
        return empty;
      }
      const acc = await this.prisma.bankAccount.findFirst({
        where: { id: bankAccountId, orgId, deletedAt: null },
        select: { id: true, currencyId: true },
      });
      if (!acc) {
        if (fromDto)
          throw new NotFoundException(
            translateError('err.payment.bankAccountNotFound', getLocale()),
          );
        return empty; // stale config default → degrade, не валимо платіж
      }
      return { sourceType, bankAccountId, cashRegisterId: null, currencyId: acc.currencyId };
    }
    // CASH_REGISTER
    if (!cashRegisterId) {
      if (fromDto)
        throw new BadRequestException(
          translateError('err.payment.cashRegisterNotSpecified', getLocale()),
        );
      return empty;
    }
    const reg = await this.prisma.cashRegister.findFirst({
      where: { id: cashRegisterId, orgId, deletedAt: null },
      select: { id: true, isFiscal: true, currencyId: true },
    });
    if (!reg) {
      if (fromDto)
        throw new NotFoundException(
          translateError('err.payment.cashRegisterNotFound', getLocale()),
        );
      return empty; // stale config default → degrade, не валимо платіж
    }
    return {
      sourceType,
      bankAccountId: null,
      cashRegisterId,
      cashRegisterIsFiscal: reg.isFiscal,
      currencyId: reg.currencyId,
    };
  }

  private toDto(p: {
    id: string;
    orgId: string;
    counterpartyId: string;
    workOrderId: string | null;
    invoiceId: string | null;
    amount: import('@prisma/client').Prisma.Decimal;
    currencyId?: string | null;
    amountBase?: import('@prisma/client').Prisma.Decimal | null;
    rateUsed?: import('@prisma/client').Prisma.Decimal | null;
    method: string;
    notes: string | null;
    fiscalReceiptId: string | null;
    fiscalStatus?: string | null;
    fiscalError?: string | null;
    sourceType?: string | null;
    bankAccountId?: string | null;
    cashRegisterId?: string | null;
    bankAccount?: { name: string } | null;
    cashRegister?: { name: string } | null;
    currency?: { code: string } | null;
    reversedAt?: Date | null;
    reversalCashOperationId?: string | null;
    createdAt: Date;
    counterparty: {
      companyName: string | null;
      lastName: string | null;
      firstName: string | null;
    } | null;
  }): PaymentResponseDto {
    const cp = p.counterparty;
    const counterpartyName = formatPersonName(cp?.lastName, cp?.firstName, cp?.companyName);
    // Назва рахунку-призначення для UI (каса/банк). id лишаються для навігації/редагування.
    const sourceName = p.bankAccount?.name ?? p.cashRegister?.name ?? null;
    return {
      id: p.id,
      orgId: p.orgId,
      counterpartyId: p.counterpartyId,
      counterpartyName,
      workOrderId: p.workOrderId ?? null,
      invoiceId: p.invoiceId ?? null,
      amount: Number(p.amount),
      currencyId: p.currencyId ?? null,
      currencyCode: p.currency?.code ?? null,
      amountBase: p.amountBase != null ? Number(p.amountBase) : null,
      rateUsed: p.rateUsed != null ? Number(p.rateUsed) : null,
      method: p.method,
      notes: p.notes ?? null,
      fiscalReceiptId: p.fiscalReceiptId ?? null,
      fiscalStatus: p.fiscalStatus ?? null,
      fiscalError: p.fiscalError ?? null,
      sourceType: p.sourceType ?? null,
      bankAccountId: p.bankAccountId ?? null,
      cashRegisterId: p.cashRegisterId ?? null,
      sourceName,
      reversedAt: p.reversedAt ? p.reversedAt.toISOString() : null,
      reversalCashOperationId: p.reversalCashOperationId ?? null,
      createdAt: p.createdAt instanceof Date ? p.createdAt.toISOString() : p.createdAt,
    };
  }
}
