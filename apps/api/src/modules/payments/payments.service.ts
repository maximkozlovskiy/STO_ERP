import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import {
  AUTOMATION_PAYMENT_ACTIVE_STATUS,
  AUTOMATION_PAYMENT_REVERSED_STATUS,
  formatPersonName,
  type PaymentReversalFormValues,
  TRANSACTION_TIMEOUT_MS,
  translateError,
  WO_PAYABLE_STATUSES,
  WO_STATUS_LABELS,
  woPaymentKind,
} from '@sto/shared';
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
import { WorkOrdersService } from '../work-orders/work-orders.service';
import {
  isWorkOrderFullyPaid,
  reopenPaidWorkOrderInTx,
  settleIfFullyPaidInTx,
  type WorkOrderStatusStep,
} from '../work-orders/work-order-status';
import { postWorkOrderFxInTx, workOrderFxDocuments } from '../work-orders/work-order-fx';
import { syncWorkOrderInvoicePaid } from '../invoices/work-order-invoice-mirror';
import { invoiceStatusForPaid } from '../invoices/invoice-paid-status';
import { hasNetFx, netFxBalanceEffect, reverseNetFxInTx } from '../settlements/fx-net';
import { LoyaltyService, type LoyaltyEarnReversal } from '../loyalty/loyalty.service';
import { AuditService } from '../audit/audit.service';
import { ExchangeRatesService } from '../exchange-rates/exchange-rates.service';
import { assertMoneyFits, money, moneyFromDecimal } from '../../common/utils/money';
import { searchContains } from '../../common/utils/like-pattern';
import {
  CreatePaymentDto,
  type CreatePaymentInput,
  PaymentResponseDto,
  PaginatedPaymentsDto,
} from './payments.dto';
import { paymentsInCashDesk } from './payment-cash-desk';
import { recordDocumentEvent } from '../automation/record-document-event';

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

// Наряд платежу: перевірки ДО транзакції (статус, платник, валюта, залишок) і філія для сповіщення.
const WORK_ORDER_PAYMENT_SELECT = {
  branchId: true,
  status: true,
  currencyId: true,
  counterpartyId: true,
  totalAmount: true,
  paidAmount: true,
} satisfies Prisma.WorkOrderSelect;

// Примітка фіскального статусу оплати, чий чек зняли з черги сторно (BR-CASH-024).
const REVERSED_FISCAL_NOTE = 'Оплату сторновано';

/** Звідки прийшла оплата: `fromRequest` — `POST /payments` (спосіб обрала людина, BR-PAY-027). */
export interface CreatePaymentOptions {
  fromRequest?: boolean;
}

/**
 * Сторно оплати: причина й автор; `cashOperationId` — рядок каси-сторно (BR-CASH-024). Безготівкове
 * сторно (BR-PAY-024) касового рядка не має — тоді документ проводки сторно сама оплата.
 */
export interface PaymentReversalContext {
  cashOperationId?: string;
  reason: string;
  userId?: string;
}

/** Що змінило сторно оплати — для аудиту ПІСЛЯ коміту транзакції викликача (`afterReversal`). */
export interface PaymentReversalResult {
  paymentId: string;
  cashOperationId: string | null;
  reason: string;
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
    // Bug #963: controller passes `+page`/`+limit`, so `?page=abc` arrives as NaN. `?? 20`
    // only replaces undefined — NaN slips through Math.max/Math.min (both return NaN) into
    // Prisma skip/take → 500. Non-finite → default, same as a missing param (T1.2-003 / #764).
    const rawLimit = Number.isFinite(opts.limit) ? (opts.limit as number) : 20;
    const rawPage = Number.isFinite(opts.page) ? (opts.page as number) : 1;
    const safeLimit = Math.min(Math.max(rawLimit, 1), 200);
    const safePage = Math.max(rawPage, 1);

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
        onlinePaymentIntentId: true,
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

    // Тип оплати в чеку (готівка / безготівка) — за ознакою способу в довіднику (BR-PAY-019), як у
    // create: оплата від шлюзу — безготівкова завжди. Без `deletedAt: null` свідомо: спосіб, який
    // видалили після оплати, тип її чека не змінює (код унікальний в організації — рядок один).
    const methodIsCash =
      !payment.onlinePaymentIntentId &&
      ((
        await this.prisma.paymentMethodConfig.findFirst({
          where: { orgId, code: payment.method },
          select: { isCash: true },
        })
      )?.isCash ??
        false);
    await this.checkboxQueue
      .add(
        'fiscal-receipt',
        {
          paymentId: id,
          orgId,
          branchId,
          amount: Number(payment.amount),
          method: payment.method,
          isCash: methodIsCash,
        },
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
    dto: CreatePaymentInput,
    userId?: string,
    cashRow?: CashOperationExtras,
    opts: CreatePaymentOptions = {},
  ): Promise<PaymentResponseDto> {
    // Один паралельний батч: контрагент, наряд із запиту, наряд рахунку (BR-PAY-021) і спосіб оплати.
    const [counterparty, requestedWorkOrder, invoicePre, methodConfig] = await Promise.all([
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
            select: WORK_ORDER_PAYMENT_SELECT,
          })
        : Promise.resolve(null),
      // BR-PAY-021: наряд платежу — і з рахунку (сторінка рахунків, рознесення виписки, онлайн-оплата
      // дають лише invoiceId). Повне читання рахунку — у транзакції; тут лише його наряд.
      dto.invoiceId
        ? this.prisma.invoice.findFirst({
            where: { id: dto.invoiceId, orgId, deletedAt: null },
            select: { workOrderId: true },
          })
        : Promise.resolve(null),
      // Спосіб оплати: requiresFiscal (для ПРРО) + дефолтний рахунок-призначення (мапінг
      // method→куди лягають гроші). Невідомий метод → фіскалізацію НЕ ставимо.
      this.prisma.paymentMethodConfig.findFirst({
        where: { orgId, code: dto.method, deletedAt: null },
        select: {
          isActive: true,
          isCash: true,
          requiresFiscal: true,
          defaultSourceType: true,
          defaultBankAccountId: true,
          defaultCashRegisterId: true,
        },
      }),
    ]);
    if (!counterparty)
      throw new NotFoundException(translateError('err.payment.counterpartyNotFound', getLocale()));
    // BR-PAY-027: спосіб оплати із запиту людини — лише наявний активний невидалений з довідника.
    // Внутрішні викликачі (каса, рознесення виписки `bank`, онлайн-оплата `<шлюз>_qr`) передають
    // спосіб самі й під правило не підпадають: гроші вже прийнято, відмова їх загубила б.
    if (opts.fromRequest && !methodConfig?.isActive)
      throw new BadRequestException(
        translateError('err.payment.methodUnavailable', getLocale(), { method: dto.method }),
      );
    // BR-PAY-019: «готівка» — ознака способу в довіднику (`isCash`), не код. Невідомий спосіб
    // (внутрішній `bank`) — безготівковий. Оплата від шлюзу (`<шлюз>_qr` з наміром) безготівкова
    // за природою: ознака, помилково ввімкнена на QR-способі, давала б 400 «вкажіть касу» на кожну
    // спробу фіналізації — гроші прийнято, а оплати немає. Наміром із запиту людини це не обійти.
    const viaGateway = !opts.fromRequest && !!dto.onlinePaymentIntentId;
    const isCash = !viaGateway && (methodConfig?.isCash ?? false);

    // Рахунок-призначення: DTO задає явно, інакше дефолт з methodConfig. sourceType↔id узгоджені.
    const resolvedSource = await this.resolveDestinationAccount(orgId, dto, methodConfig);

    // BR-PAY-019: готівка без каси — гроші, яких не видно в жодній касі (борг погашено, а залишок
    // каси й її історія про оплату не знають). Перевірка ПІСЛЯ розв'язання: каса з запиту або каса
    // за замовчуванням способу оплати; застаріле замовчування (касу видалено) теж дає 400.
    if (isCash && resolvedSource.sourceType !== 'CASH_REGISTER')
      throw new BadRequestException(
        translateError('err.payment.cashRequiresRegister', getLocale()),
      );
    // BR-PAY-023: безготівкова оплата без призначення — гроші, яких не видно на жодному рахунку
    // (борг погашено, а банківський рахунок про них не знає). Призначення — з запиту або за
    // замовчуванням способу оплати (картка через термінал може мати касу за замовчуванням);
    // застаріле замовчування (рахунок видалено) теж 400. Онлайн-оплата (QR) приходить від шлюзу
    // зі своїм наміром оплати й під правило не підпадає.
    if (!isCash && !dto.onlinePaymentIntentId && resolvedSource.sourceType === null)
      throw new BadRequestException(
        translateError('err.payment.nonCashRequiresDestination', getLocale()),
      );

    // Наряд вказано, але його немає (чужа org або видалений) → 404 ДО транзакції. Без цього всі
    // перевірки наряду нижче мовчали: статус, замовник, валюта й залишок (BR-PAY-001/016/017) не
    // застосовувались, а видалений наряд отримував paidAmount.
    if (dto.workOrderId && !requestedWorkOrder)
      throw new NotFoundException(translateError('err.workOrder.notFound', getLocale()));
    // Так само рахунок: без цієї відмови оплата з invoiceId видаленого чи чужого рахунку мовчки
    // проходила повз усі перевірки рахунку (статус, платник, валюта, залишок) і писала Payment з
    // посиланням на рахунок, якого немає.
    if (dto.invoiceId && !invoicePre)
      throw new NotFoundException(translateError('err.invoice.notFound', getLocale()));

    // BR-PAY-021: рахунок, що не належить наряду із запиту (зокрема рахунок без наряду), → 400.
    if (dto.workOrderId && invoicePre && invoicePre.workOrderId !== dto.workOrderId) {
      throw new BadRequestException(
        translateError('err.payment.invoiceNotForWorkOrder', getLocale()),
      );
    }
    const workOrderId = dto.workOrderId ?? invoicePre?.workOrderId ?? null;
    const workOrder =
      requestedWorkOrder ??
      (workOrderId
        ? await this.prisma.workOrder.findFirst({
            where: { id: workOrderId, orgId, deletedAt: null },
            select: WORK_ORDER_PAYMENT_SELECT,
          })
        : null);
    if (workOrderId && !workOrder)
      throw new NotFoundException(translateError('err.workOrder.notFound', getLocale()));

    if (workOrder) {
      // BR-PAY-001: швидка відмова ДО транзакції; авторитетна перевірка — у транзакції на свіжому
      // статусі (той самий, з якого береться тип проводки, BR-PAY-020).
      this.assertWorkOrderPayable(workOrder.status);
      // BR-PAY-020: повернення клієнту — касова операція, а не «оплата наряду» зі знаком мінус.
      if (dto.settlementType === 'REFUND') {
        throw new BadRequestException(
          translateError('err.payment.refundWithWorkOrder', getLocale()),
        );
      }
    }

    // BR-PAY-016, пряма оплата наряду (без рахунку): наряд закриває лише його замовник. Без цього
    // платіж контрагента A піднімав paidAmount наряду контрагента B і переводив його в PAID, а
    // гроші лягали на баланс A — та сама діра, що її перевірка платника закриває для рахунку.
    // Якщо рахунок вказано, платника визначає РАХУНОК (його можна виписати на іншого платника,
    // напр. страхову) — тоді ця перевірка мовчить, діє перевірка рахунку в транзакції.
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

    // BR-FIN-MONEYCAP: Payment.amount і Payment.amountBase — Decimal(12,2). Іновалютна сума × курс
    // (conv.amountBase) може перерости колонку, хоч сама сума в межах — тоді 400 з назвою поля,
    // а не 500 numeric field overflow. Дзеркаль settlements F7.
    assertMoneyFits(dto.amount, 'сума оплати');
    assertMoneyFits(conv.amountBase, 'сума оплати');

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

    // Мультивалюта (Фаза 3): оплата наряду — валюта оплати мусить збігатися з валютою наряду.
    // WO.paidAmount інкрементується у ВАЛЮТІ наряду (dto.amount), тож оплата у іншій валюті змішала
    // б одиниці у paidAmount. NULL currencyId (історичні/base) ≡ базова валюта. Рахунок наряду
    // успадковує валюту наряду, тож ця ж перевірка покриває й оплату через рахунок наряду.
    if (workOrder) {
      if (
        !(await this.exchangeRates.sameCurrency(orgId, paymentCurrencyId, workOrder.currencyId))
      ) {
        throw new BadRequestException(
          translateError('err.payment.currencyMustMatchWorkOrder', getLocale()),
        );
      }
      // BR-PAY-017, швидка відмова ДО транзакції: будь-яка оплата наряду (аванс, оплата, через
      // рахунок наряду) не перевищує залишок; наряд на 0 оплати не приймає. Авторитетна перевірка
      // з тим самим правилом — у транзакції, на свіжо прочитаних сумах.
      this.assertWithinWorkOrderRemaining(workOrder.totalAmount, workOrder.paidAmount, dto.amount);
    }

    // Кроки наряду до «Оплачено», зроблені в транзакції (BR-PAY-005) — події для них після коміту.
    let statusSteps: WorkOrderStatusStep[] = [];
    const payment = await this.prisma.$transaction(
      async tx => {
        // Курсові різниці (Фаза 4) рахунку БЕЗ наряду: контекст іновалютного рахунку, що став PAID
        // цим платежем, — FX визнається ПІСЛЯ запису Payment+PAYMENT-settlement.
        let fxInvoiceId: string | null = null;
        // Тип проводки оплати наряду — за статусом, прочитаним нижче в транзакції (BR-PAY-020).
        let woKind: 'PREPAYMENT' | 'PAYMENT' = 'PAYMENT';
        let paymentInvoiceId: string | null = dto.invoiceId ?? null;

        if (workOrderId) {
          // BR-PAY-005: рядок наряду — ПЕРШИЙ запис транзакції (раніше за рахунок; так само в
          // reverse). Статус, сума і сплачене читаються тут і стоять у CAS: аванс, проведений
          // проти статусу, що встиг змінитись, або оплата понад залишок не проскочать.
          const wo = await tx.workOrder.findFirst({
            where: { id: workOrderId, orgId, deletedAt: null },
            select: { status: true, totalAmount: true, paidAmount: true },
          });
          if (!wo)
            throw new NotFoundException(translateError('err.workOrder.notFound', getLocale()));
          this.assertWorkOrderPayable(wo.status);
          woKind = woPaymentKind(wo.status) ?? 'PAYMENT';
          this.assertWithinWorkOrderRemaining(wo.totalAmount, wo.paidAmount, dto.amount);
          // Мультивалюта (Фаза 3): WorkOrder.paidAmount у ВАЛЮТІ наряду; оплата збігається з нею
          // (перевірено вище) → додаємо dto.amount, не conv.amountBase.
          const woUpdated = await tx.workOrder.updateMany({
            where: {
              id: workOrderId,
              orgId,
              deletedAt: null,
              status: wo.status,
              paidAmount: wo.paidAmount,
              totalAmount: wo.totalAmount,
              // BR-WO-015: валюту, з якою звірено валюту оплати ДО транзакції, не змінили.
              currencyId: workOrder?.currencyId,
            },
            data: { paidAmount: money(moneyFromDecimal(wo.paidAmount) + dto.amount) },
          });
          if (woUpdated.count === 0) {
            throw new BadRequestException(
              translateError('err.payment.workOrderConcurrentChange', getLocale()),
            );
          }

          // BR-PAY-021: рахунок із запиту — того ж наряду й того ж платника. Його статус оплату не
          // обмежує (обмежує статус наряду), а сплачене й статус перерахує дзеркало нижче.
          if (dto.invoiceId) {
            const inv = await tx.invoice.findFirst({
              where: { id: dto.invoiceId, orgId, deletedAt: null },
              select: { workOrderId: true, counterpartyId: true },
            });
            if (!inv)
              throw new NotFoundException(translateError('err.invoice.notFound', getLocale()));
            if (inv.workOrderId !== workOrderId) {
              throw new BadRequestException(
                translateError('err.payment.invoiceNotForWorkOrder', getLocale()),
              );
            }
            if (inv.counterpartyId !== dto.counterpartyId) {
              throw new BadRequestException(
                translateError('err.payment.invoiceNotForCounterparty', getLocale()),
              );
            }
          }
          // Оплата наряду отримує invoiceId активного рахунку наряду, якщо платник — його контрагент.
          const active = await tx.invoice.findFirst({
            where: {
              workOrderId,
              orgId,
              deletedAt: null,
              status: { not: InvoiceStatus.CANCELLED },
            },
            select: { id: true, counterpartyId: true },
          });
          paymentInvoiceId =
            active && active.counterpartyId === dto.counterpartyId ? active.id : null;
        } else if (dto.invoiceId) {
          // Рахунок БЕЗ наряду (BR-PAY-003) — шлях не змінювався. Часткова оплата з захистом від
          // переплати під concurrency (FIN-C1): читаємо amount/paidAmount/status; сума ≤ залишку;
          // paidAmount пишеться CAS-ом за прочитаним значенням; count=0 → throw/rollback.
          const inv = await tx.invoice.findFirst({
            where: { id: dto.invoiceId, orgId, deletedAt: null },
            // Мультивалюта (Фаза 3): currencyId рахунку — оплата має бути у ТІЙ САМІЙ валюті.
            select: {
              id: true,
              status: true,
              counterpartyId: true,
              amount: true,
              paidAmount: true,
              currencyId: true,
              dueDate: true,
            },
          });
          // Рахунок видалили між перевіркою і транзакцією → 404 і відкат, а не оплата «у нікуди».
          if (!inv)
            throw new NotFoundException(translateError('err.invoice.notFound', getLocale()));
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
          // Мультивалюта (Фаза 3): валюта оплати мусить збігатися з валютою рахунку — інакше
          // крос-валютна алокація (яким курсом закрити залишок = FX-політика, поза scope).
          // NULL currencyId (історичні/base) вважаємо еквівалентними базовій валюті.
          if (!(await this.exchangeRates.sameCurrency(orgId, paymentCurrencyId, inv.currencyId))) {
            throw new BadRequestException(
              translateError('err.payment.currencyMustMatchInvoice', getLocale()),
            );
          }
          const invAmount = Number(inv.amount);
          const prevPaid = Number(inv.paidAmount);
          const remaining = invAmount - prevPaid;
          // invoice.amount/paidAmount у ВАЛЮТІ рахунку, оплата — у тій самій валюті → порівнюємо
          // dto.amount, НЕ conv.amountBase. Борг у леджері все одно лягає у base через settlement.
          if (dto.amount > remaining + 1e-9) {
            throw new BadRequestException(
              translateError('err.payment.amountExceedsInvoiceRemaining', getLocale(), {
                remaining: remaining.toFixed(2),
              }),
            );
          }
          const newPaid = prevPaid + dto.amount;
          // BR-INV-025: часткова оплата простроченого рахунку лишає його «Прострочено» одразу.
          const newStatus = invoiceStatusForPaid(inv.status, invAmount, newPaid, inv.dueDate);
          // CAS: оновлюємо лише якщо paidAmount і статус досі ті, що прочитали. Статус — бо з нього
          // вище рахувалась відмова (скасований між читанням і записом рахунок не стає «Оплачено»)
          // і з нього ж — `fromStatus` події (BR-AUT-060).
          const fromStatus = inv.status;
          const updated = await tx.invoice.updateMany({
            where: {
              id: dto.invoiceId,
              orgId,
              deletedAt: null,
              paidAmount: inv.paidAmount,
              status: inv.status,
            },
            data: { paidAmount: newPaid, status: newStatus },
          });
          if (updated.count === 0) {
            throw new BadRequestException(
              translateError('err.payment.invoiceConcurrentChange', getLocale()),
            );
          }
          await recordDocumentEvent(tx, {
            orgId,
            documentType: 'INVOICE',
            documentId: inv.id,
            kind: 'STATUS_CHANGED',
            fromStatus,
            toStatus: newStatus,
            actorId: userId ?? null,
          });
          // Курсові різниці (Фаза 4): рахунок став PAID цим платежем + валюта НЕ базова →
          // після запису PAYMENT-settlement визнаємо realized FX проти CHARGE самого рахунку.
          if (
            newStatus === 'PAID' &&
            !(await this.exchangeRates.sameCurrency(orgId, null, inv.currencyId))
          ) {
            fxInvoiceId = inv.id;
          }
        }

        const created = await tx.payment.create({
          data: {
            orgId,
            counterpartyId: dto.counterpartyId,
            workOrderId,
            invoiceId: paymentInvoiceId,
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
        await recordDocumentEvent(tx, {
          orgId,
          documentType: 'PAYMENT',
          documentId: created.id,
          kind: 'CREATED',
          // Псевдостатус «діє» (BR-AUT-060): без нього правило «оплату створено» з умовою
          // «у статус» мовчки не спрацьовувало б — у події не було б статусу для звірки.
          toStatus: AUTOMATION_PAYMENT_ACTIVE_STATUS,
          actorId: userId ?? null,
        });

        await this.settlements.createTransaction(
          orgId,
          {
            counterpartyId: dto.counterpartyId,
            // BR-PAY-020: аванс (PREPAYMENT) до «Виконано», оплата (PAYMENT) після. Без наряду —
            // дефолт PAYMENT; рознесення виписки передає PREPAYMENT / REFUND (BALANCE_SIGN різний).
            type: workOrderId
              ? woKind === 'PREPAYMENT'
                ? 'PREPAYMENT'
                : 'PAYMENT'
              : (dto.settlementType ?? 'PAYMENT'),
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

        if (fxInvoiceId)
          await this.postInvoiceFx(tx, orgId, fxInvoiceId, dto.counterpartyId, userId);

        if (workOrderId) {
          // BR-PAY-005 / BR-WO-016: повна оплата — «Виставлено» → «Оплачено», «Виконано» →
          // «Виставлено» → «Оплачено» (без рахунку) у цій самій транзакції.
          statusSteps = await settleIfFullyPaidInTx(tx, orgId, workOrderId, userId);
          // BR-INV-018: рахунок наряду — дзеркало наряду (блокується після наряду).
          await syncWorkOrderInvoicePaid(tx, orgId, workOrderId, userId);
          // BR-PAY-022: курсова різниця — за нарядом (лише повністю сплачений з нарахованим боргом).
          await postWorkOrderFxInTx(
            tx,
            { settlements: this.settlements, exchangeRates: this.exchangeRates },
            orgId,
            workOrderId,
            userId,
          );
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
              ...cashRowBaseDocument(cashRow, workOrderId),
            },
            tx,
          );
        }

        return created;
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    ); // explicit timeout — payment + settlement + invoice/WO updates

    // Події переходів наряду (аудит статусу) — ПІСЛЯ коміту, як у WorkOrdersService.transition.
    if (workOrderId) this.workOrders.emitStatusSteps(orgId, workOrderId, statusSteps, userId);
    // Повідомлення клієнту про оплату — типове правило `PAYMENT_CREATED_CLIENT` (BR-AUT-007).

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
            isCash,
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
          invoiceId: payment.invoiceId ?? null,
          workOrderId: payment.workOrderId ?? null,
        })
        .catch((e: unknown) =>
          this.logger.warn(`Audit record failed: ${e instanceof Error ? e.message : e}`),
        );
    }

    return this.toDto(payment);
  }

  /**
   * Сторно оплати клієнта — внутрішній метод у транзакції викликача. Два входи: каса
   * (`CashDeskService.reverse`, BR-CASH-024) після запису рядка сторно (його id —
   * `ctx.cashOperationId`) і безготівкове сторно `reverseNonCash` (BR-PAY-024) без касового рядка.
   * Відкочує все, що зробила оплата: борг (проводка `PAYMENT_CANCEL` / `PREPAYMENT_CANCEL` з курсом
   * оригіналу; документ — рядок сторно каси або сама оплата), «сплачено» й статус рахунку й наряду,
   * чек у черзі, бонуси; пише в оплату причину й автора. Відмова — до першого запису; будь-яка
   * відмова відкочує й записи викликача.
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
    // «Вже сторновано» — словами входу: каса сторнує операцію, `reverseNonCash` — оплату (гонка двох
    // безготівкових сторно інакше відповідала програвшому «Операцію вже сторновано»).
    const alreadyReversedKey = ctx.cashOperationId
      ? 'err.cash.alreadyReversed'
      : 'err.payment.alreadyReversed';
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
      throw new BadRequestException(translateError(alreadyReversedKey, locale));
    }
    // Чека повернення в системі немає: пробитий чек лишився б за оплатою, якої вже немає.
    if (payment.fiscalStatus === FiscalReceiptStatus.DONE || payment.fiscalReceiptId) {
      throw new BadRequestException(translateError('err.cash.reversalFiscalDone', locale));
    }
    // BR-PAY-029: чек у черзі ПРРО може бути вже в дорозі — пробитий після сторно, він лишився б
    // за оплатою, якої немає. Сторно — лише коли ПРРО відповів (пробито → відмова вище,
    // відхилено → сторно знімає чек).
    if (payment.fiscalStatus === FiscalReceiptStatus.QUEUED) {
      throw new BadRequestException(translateError('err.cash.reversalFiscalQueued', locale));
    }

    const [workOrder, invoice] = await Promise.all([
      payment.workOrderId
        ? tx.workOrder.findFirst({
            where: { id: payment.workOrderId, orgId, deletedAt: null },
            select: { status: true, paidAmount: true, totalAmount: true, counterpartyId: true },
          })
        : null,
      // Рахунок окремо — лише для оплати без наряду: рахунок наряду — дзеркало (BR-INV-018).
      payment.invoiceId && !payment.workOrderId
        ? tx.invoice.findFirst({
            where: { id: payment.invoiceId, orgId, deletedAt: null },
            select: {
              status: true,
              paidAmount: true,
              amount: true,
              dueDate: true,
              counterpartyId: true,
            },
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
    // Відхилений ПРРО чек знімаємо тим самим записом — повтор фіскалізації його вже не поставить.
    const fiscalPending = payment.fiscalStatus === FiscalReceiptStatus.FAILED;
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
        reversalCashOperationId: ctx.cashOperationId ?? null,
        // BR-PAY-024: причина й автор — для будь-якого сторно, касового теж.
        reversalReason: ctx.reason,
        reversedBy: ctx.userId ?? null,
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
          now?.reversedAt ? alreadyReversedKey : 'err.cash.reversalStateChanged',
          locale,
        ),
      );
    }
    // BR-AUT-060: у оплати немає поля статусу — сторно фіксується псевдостатусами
    // «ACTIVE» → «REVERSED».
    await recordDocumentEvent(tx, {
      orgId,
      documentType: 'PAYMENT',
      documentId: payment.id,
      kind: 'STATUS_CHANGED',
      fromStatus: AUTOMATION_PAYMENT_ACTIVE_STATUS,
      toStatus: AUTOMATION_PAYMENT_REVERSED_STATUS,
      actorId: ctx.userId ?? null,
    });

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
        // Документ сторно: рядок сторно каси (BR-CASH-024) або, без каси, сама оплата (BR-PAY-024).
        ...(ctx.cashOperationId
          ? { documentType: 'CashOperation', documentId: ctx.cashOperationId }
          : { documentType: 'Payment', documentId: payment.id }),
        notes: ctx.reason,
        createdBy: ctx.userId,
      },
      tx,
    );

    const amount = moneyFromDecimal(payment.amount);

    // Наряд — ПЕРШИМ (той самий порядок блокувань «наряд → рахунок», що в create): «сплачено» назад
    // (не нижче нуля), «Оплачено» → «Виставлено», якщо наряд уже не сплачений повністю (BR-PAY-017
    // навпаки: інші оплати можуть і далі покривати суму — тоді він лишається «Оплачено»).
    // Зворотного переходу в публічній карті (WORK_ORDER_TRANSITIONS) немає і не буде: статус пише
    // окремий внутрішній хелпер модуля нарядів (BR-WO-001). Рахунок наряду — дзеркало (BR-INV-018).
    let reopenedWorkOrderId: string | null = null;
    if (workOrder && payment.workOrderId) {
      const newPaid = money(Math.max(0, moneyFromDecimal(workOrder.paidAmount) - amount));
      if (
        workOrder.status === WorkOrderStatus.PAID &&
        !isWorkOrderFullyPaid(workOrder.totalAmount, newPaid)
      ) {
        await reopenPaidWorkOrderInTx(
          tx,
          orgId,
          payment.workOrderId,
          workOrder.paidAmount,
          newPaid,
          ctx.userId,
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
      await syncWorkOrderInvoicePaid(tx, orgId, payment.workOrderId, ctx.userId);
      // BR-PAY-028: наряд більше не сплачений повністю — курсова різниця повної оплати відкочується.
      if (!isWorkOrderFullyPaid(workOrder.totalAmount, newPaid)) {
        await reverseNetFxInTx(tx, this.settlements, orgId, {
          counterpartyId: workOrder.counterpartyId,
          target: { documentType: 'WorkOrder', documentId: payment.workOrderId },
          documents: await workOrderFxDocuments(tx, orgId, payment.workOrderId),
          notes: `Курсова різниця відкочена: сторно оплати — ${ctx.reason}`,
          userId: ctx.userId,
        });
      }
    }

    // Оплата рахунку БЕЗ наряду: «сплачено» рахунку назад (не нижче нуля); «Оплачено» / «Частково
    // оплачено» / «Прострочено» → за тією самою формулою, що в create (BR-INV-025): сплачене й далі
    // покриває суму → «Оплачено»; термін минув → «Прострочено» одразу; інакше «Частково оплачено» або
    // «Виставлено». CAS на сумі й статусі.
    if (invoice && payment.invoiceId) {
      const newPaid = money(Math.max(0, moneyFromDecimal(invoice.paidAmount) - amount));
      const invoiceAmount = moneyFromDecimal(invoice.amount);
      const wasPaid =
        invoice.status === InvoiceStatus.PAID ||
        invoice.status === InvoiceStatus.PARTIALLY_PAID ||
        invoice.status === InvoiceStatus.OVERDUE;
      const newStatus = !wasPaid
        ? invoice.status
        : invoiceStatusForPaid(invoice.status, invoiceAmount, newPaid, invoice.dueDate);
      const fromStatus = invoice.status;
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
      await recordDocumentEvent(tx, {
        orgId,
        documentType: 'INVOICE',
        documentId: payment.invoiceId,
        kind: 'STATUS_CHANGED',
        fromStatus,
        toStatus: newStatus,
        actorId: ctx.userId ?? null,
      });
      // BR-PAY-028: рахунок більше не сплачений повністю — курсова різниця його повної оплати
      // відкочується (базова валюта — чистої FX немає, виклик нічого не пише).
      if (newPaid < invoiceAmount - 1e-9) {
        await reverseNetFxInTx(tx, this.settlements, orgId, {
          counterpartyId: invoice.counterpartyId,
          target: { documentType: 'Invoice', documentId: payment.invoiceId },
          documents: [{ documentType: 'Invoice', documentId: payment.invoiceId }],
          notes: `Курсова різниця відкочена: сторно оплати — ${ctx.reason}`,
          userId: ctx.userId,
        });
      }
    }

    const loyalty = await this.loyalty.reverseEarn(orgId, payment.id, tx);

    return {
      paymentId: payment.id,
      cashOperationId: ctx.cashOperationId ?? null,
      reason: ctx.reason,
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
          reversalReason: result.reason,
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

  /**
   * BR-PAY-024: сторно оплати клієнта без касового рядка (`POST /payments/:id/reverse`) — на
   * банківський рахунок (з вікна «Оплатити» чи з рознесення виписки) і старої оплати без
   * призначення. Власна транзакція ReadCommitted: відмови (касова оплата, онлайн-оплата QR, уже
   * сторнована) — до першого запису; далі той самий `reverse`, що й у касі (його відмови теж до
   * запису). Оплата з рознесення виписки: у тій самій транзакції рядок виписки CAS MATCHED →
   * UNMATCHED без посилання на оплату, з причиною (BR-BANK-040) — його можна рознести заново.
   * Аудит — після коміту.
   */
  async reverseNonCash(
    orgId: string,
    id: string,
    dto: PaymentReversalFormValues,
    userId: string,
  ): Promise<PaymentResponseDto> {
    const locale = getLocale();
    // Повторює zod-схему маршруту свідомо: сервіс можуть викликати й не через HTTP.
    const reason = dto.reason?.trim() ?? '';
    if (!reason) {
      throw new BadRequestException(translateError('err.cash.reversalReasonRequired', locale));
    }

    const outcome = await this.prisma.$transaction(
      async tx => {
        const payment = await tx.payment.findFirst({
          where: { id, orgId },
          select: {
            id: true,
            sourceType: true,
            cashRegisterId: true,
            onlinePaymentIntentId: true,
            reversedAt: true,
          },
        });
        if (!payment) throw new NotFoundException(translateError('err.payment.notFound', locale));
        if (payment.reversedAt) {
          throw new BadRequestException(translateError('err.payment.alreadyReversed', locale));
        }
        // Касова оплата сторнується лише в касі: там сторно — ще й рядок протилежного напряму.
        // Стара готівкова оплата могла не мати `sourceType`, але мати рядок каси — його теж видно.
        // Та сама функція дає ознаку `inCashDesk` у «Пов'язаних документах» (кнопки там немає).
        if ((await paymentsInCashDesk(tx, orgId, [payment])).has(payment.id)) {
          throw new BadRequestException(translateError('err.payment.reversalCashRow', locale));
        }
        if (payment.onlinePaymentIntentId) {
          throw new BadRequestException(translateError('err.payment.reversalOnlineQr', locale));
        }

        const bankRow = await tx.bankTransaction.findFirst({
          where: { orgId, paymentId: payment.id, deletedAt: null },
          select: { id: true, matchedType: true, counterpartyId: true },
        });

        const reversal = await this.reverse(orgId, payment.id, { reason, userId }, tx);

        if (bankRow) {
          // BR-BANK-040: рядок виписки звільняється разом зі сторно — і лише тоді, коли він ще
          // рознесений саме на ЦЮ оплату; інакше відкочується й сторно.
          const released = await tx.bankTransaction.updateMany({
            where: {
              id: bankRow.id,
              orgId,
              deletedAt: null,
              status: 'MATCHED',
              paymentId: payment.id,
            },
            data: {
              status: 'UNMATCHED',
              matchedType: null,
              counterpartyId: null,
              paymentId: null,
              matchedAt: null,
              matchedBy: null,
              unmatchReason: reason,
              unmatchedAt: new Date(),
              unmatchedBy: userId,
            },
          });
          if (released.count === 0) {
            throw new ConflictException(translateError('err.bankStatement.notMatched', locale));
          }
        }
        return { reversal, bankRow };
      },
      {
        timeout: TRANSACTION_TIMEOUT_MS,
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      },
    );

    this.afterReversal(orgId, outcome.reversal, userId);
    if (outcome.bankRow) {
      this.audit
        .record(
          orgId,
          'BankTransaction',
          outcome.bankRow.id,
          'UPDATE',
          userId,
          {
            status: 'MATCHED',
            matchedType: outcome.bankRow.matchedType,
            counterpartyId: outcome.bankRow.counterpartyId,
            paymentId: id,
            unmatchReason: null,
          },
          { status: 'UNMATCHED', matchedType: null, paymentId: null, unmatchReason: reason },
        )
        .catch((e: unknown) =>
          this.logger.warn(`Audit record failed: ${e instanceof Error ? e.message : String(e)}`),
        );
    }
    return this.findOne(orgId, id);
  }

  /** BR-PAY-001: наряд приймає оплату лише в `WO_PAYABLE_STATUSES`; інакше 400 з назвою статусу. */
  private assertWorkOrderPayable(status: string): void {
    if (!WO_PAYABLE_STATUSES.includes(status)) {
      throw new BadRequestException(
        translateError('err.payment.workOrderStatusNoPayment', getLocale(), {
          status: WO_STATUS_LABELS[status] ?? status,
        }),
      );
    }
  }

  /**
   * Курсові різниці (Фаза 4) рахунку БЕЗ наряду, що став PAID цим платежем: CHARGE брав курс дати
   * документа, PAYMENT — курс дати оплати, тож base-залишок ≠ 0. Одна проводка FX обнуляє його.
   * paidBase агрегується ПІСЛЯ create цього Payment (включений). Рахунок наряду — `postWorkOrderFxInTx`.
   */
  private async postInvoiceFx(
    tx: Prisma.TransactionClient,
    orgId: string,
    invoiceId: string,
    counterpartyId: string,
    userId?: string,
  ): Promise<void> {
    const [chargeAgg, paidAgg, fxNet] = await Promise.all([
      tx.settlementTransaction.aggregate({
        where: { orgId, type: 'CHARGE', documentType: 'Invoice', documentId: invoiceId },
        _sum: { amountBase: true },
      }),
      tx.payment.aggregate({
        where: { orgId, invoiceId, reversedAt: null },
        _sum: { amountBase: true },
      }),
      // Idempotency: чиста FX рахунку ≠ 0 — вже визнано, не дублюємо. Сторно, що зробило рахунок
      // не сплаченим, її обнуляє (BR-PAY-028) — тоді повна оплата визнає її заново.
      netFxBalanceEffect(tx, orgId, [{ documentType: 'Invoice', documentId: invoiceId }]),
    ]);
    if (hasNetFx(fxNet)) return;
    const chargeBase = moneyFromDecimal(chargeAgg._sum.amountBase);
    const paidBase = moneyFromDecimal(paidAgg._sum.amountBase);
    const fx = money(chargeBase - paidBase);
    // EPS 0.005: нижче — копійчаний дрейф округлення / той самий курс → FX не потрібна
    // (і createTransaction відхилив би amount≤0).
    if (Math.abs(fx) < 0.005) return;
    await this.settlements.createTransaction(
      orgId,
      {
        counterpartyId,
        // fx>0: нарахували більше base ніж отримали → збиток (гасить додатний залишок).
        type: fx > 0 ? 'FX_LOSS' : 'FX_GAIN',
        amount: Math.abs(fx),
        // БЕЗ currencyId → base-дельта (rate=1, base=amount); інакше re-конвертація зіпсує суму.
        documentType: 'Invoice',
        documentId: invoiceId,
        notes: `Курсова різниця: нараховано ${chargeBase.toFixed(2)} за курсом документа, отримано ${paidBase.toFixed(2)} за курсом оплат`,
        createdBy: userId,
      },
      tx,
    );
  }

  /** BR-PAY-017: оплата наряду не перевищує залишок до сплати (total − paid). */
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
    // Тип без явного значення — з переданого id (лише один id): каса без `sourceType` інакше брала
    // тип способу оплати й мовчки губилась — готівка «вказаної каси» давала 400 BR-PAY-019, а інший
    // спосіб записувався повз касу, яку касир назвав.
    const typeFromId =
      dto.cashRegisterId && !dto.bankAccountId
        ? 'CASH_REGISTER'
        : dto.bankAccountId && !dto.cashRegisterId
          ? 'BANK_ACCOUNT'
          : null;
    const sourceType = dto.sourceType ?? typeFromId ?? methodConfig?.defaultSourceType ?? null;
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
    reversalReason?: string | null;
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
      reversalReason: p.reversalReason ?? null,
      createdAt: p.createdAt instanceof Date ? p.createdAt.toISOString() : p.createdAt,
    };
  }
}

/**
 * BR-CASH-030: підстава рядка каси для оплати в касу. Підставу, яку задала каса (картка касової
 * операції, BR-CASH-020), не чіпаємо; оплата за нарядом (з вікна наряду чи через рахунок наряду)
 * без неї отримує підставою сам наряд — у журналі каси видно, за що прийнято гроші.
 */
function cashRowBaseDocument(
  cashRow: CashOperationExtras | undefined,
  workOrderId: string | null,
): Pick<CashOperationExtras, 'baseDocumentType' | 'baseDocumentId'> {
  if (cashRow?.baseDocumentId) return {};
  return workOrderId ? { baseDocumentType: 'WorkOrder', baseDocumentId: workOrderId } : {};
}
