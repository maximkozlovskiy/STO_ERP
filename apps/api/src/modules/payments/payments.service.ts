import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { formatPersonName, TRANSACTION_TIMEOUT_MS } from '@sto/shared';
import { Queue } from 'bullmq';
import { Prisma, FiscalReceiptStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { SettlementsService } from '../settlements/settlements.service';
import { NotificationsService } from '../notifications/notifications.service';
import { WorkOrdersService } from '../work-orders/work-orders.service';
import { LoyaltyService } from '../loyalty/loyalty.service';
import { CreatePaymentDto, PaymentResponseDto, PaginatedPaymentsDto } from './payments.dto';

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
} satisfies Prisma.PaymentInclude;

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settlements: SettlementsService,
    private readonly notifications: NotificationsService,
    private readonly workOrders: WorkOrdersService,
    private readonly loyalty: LoyaltyService,
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
      if (!cp) throw new NotFoundException('Контрагента не знайдено');
      where.counterpartyId = opts.counterpartyId;
    }
    // Діапазон дат за createdAt (date-only рядки YYYY-MM-DD від фронту).
    // dateTo МУСИТЬ бути inclusive-of-full-day: `new Date('2026-09-06')` = midnight UTC →
    // голий lte виключив би всі платежі, зроблені пізніше того ж дня. Розширюємо до кінця доби
    // (дзеркалить supplier-payments.service: `new Date(dateTo + 'T23:59:59.999Z')`).
    if (opts.dateFrom || opts.dateTo) {
      const createdAt: Prisma.DateTimeFilter = {};
      if (opts.dateFrom) createdAt.gte = new Date(opts.dateFrom + 'T00:00:00.000Z');
      if (opts.dateTo) createdAt.lte = new Date(opts.dateTo + 'T23:59:59.999Z');
      where.createdAt = createdAt;
    }
    if (opts.method) where.method = opts.method;
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
    if (!payment) throw new NotFoundException('Платіж не знайдено');
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
      },
    });
    if (!payment) throw new NotFoundException('Платіж не знайдено');
    if (payment.fiscalReceiptId) {
      throw new BadRequestException('Чек уже пробито — повтор не потрібен');
    }
    if (payment.fiscalStatus !== 'FAILED') {
      throw new BadRequestException('Повтор можливий лише для чеків у статусі «Помилка»');
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

    await this.prisma.payment.update({
      where: { id, orgId },
      data: { fiscalStatus: 'QUEUED', fiscalError: null },
    });

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

  async create(orgId: string, dto: CreatePaymentDto, userId?: string): Promise<PaymentResponseDto> {
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
            select: { branchId: true, status: true },
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
    if (!counterparty) throw new NotFoundException('Контрагента не знайдено');

    // Рахунок-призначення: DTO задає явно, інакше дефолт з methodConfig. sourceType↔id узгоджені.
    const resolvedSource = await this.resolveDestinationAccount(orgId, dto, methodConfig);

    // Pre-validate work order status before opening transaction to avoid partial commit.
    // Status was fetched in the parallel batch above — no extra query needed.
    if (dto.workOrderId && workOrder && workOrder.status !== 'INVOICED') {
      throw new BadRequestException(`Наряд у статусі "${workOrder.status}" — оплата неможлива`);
    }

    // Фіскалізуємо лише якщо спосіб оплати цього потребує (requiresFiscal). Невідомий метод
    // або requiresFiscal=false → чек не ставимо, fiscalStatus лишається null (не застосовно).
    const willFiscalize = methodConfig?.requiresFiscal === true;

    const payment = await this.prisma.$transaction(
      async tx => {
        // Часткова оплата з захистом від переплати під concurrency (FIN-C1 еволюція):
        // читаємо amount/paidAmount/status; валідуємо суму ≤ залишку; атомарно інкрементуємо
        // paidAmount ЛИШЕ якщо paidAmount не змінився з-під нас (CAS через updateMany where
        // paidAmount=прочитане). count=0 → конкурентний платіж змінив paidAmount → throw/rollback.
        if (dto.invoiceId) {
          const inv = await tx.invoice.findFirst({
            where: { id: dto.invoiceId, orgId, deletedAt: null },
            select: { status: true, workOrderId: true, amount: true, paidAmount: true },
          });
          if (inv) {
            if (inv.status !== 'SENT' && inv.status !== 'PARTIALLY_PAID') {
              throw new BadRequestException(`Рахунок у статусі "${inv.status}" — оплата неможлива`);
            }
            if (dto.workOrderId && inv.workOrderId && inv.workOrderId !== dto.workOrderId) {
              throw new BadRequestException('Рахунок не належить до вказаного наряду');
            }
            const invAmount = Number(inv.amount);
            const prevPaid = Number(inv.paidAmount);
            const remaining = invAmount - prevPaid;
            if (dto.amount > remaining + 1e-9) {
              throw new BadRequestException(
                `Сума перевищує залишок за рахунком (${remaining.toFixed(2)} грн)`,
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
              throw new BadRequestException('Рахунок змінено паралельною операцією — повторіть');
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
            type: 'PAYMENT',
            amount: dto.amount,
            documentType: 'Payment',
            documentId: created.id,
            createdBy: userId,
          },
          tx,
        );

        if (dto.workOrderId) {
          await tx.workOrder.update({
            where: { id: dto.workOrderId, orgId },
            data: { paidAmount: { increment: dto.amount } },
          });
        }

        return created;
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    ); // explicit timeout — payment + settlement + invoice/WO updates

    // FSM INVOICED→PAID outside tx (WorkOrdersService has its own tx). Safe: payment + settlement
    // already committed; if transition fails, operator retries status manually.
    if (dto.workOrderId) {
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
    await this.loyalty
      .queueEarn(orgId, dto.counterpartyId, dto.amount, payment.id)
      .catch((err: unknown) =>
        this.logger.warn(
          `Loyalty earn enqueue failed: ${err instanceof Error ? err.message : err}`,
        ),
      );

    return this.toDto(payment);
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
        if (fromDto) throw new BadRequestException('Не вказано банківський рахунок');
        return empty;
      }
      const acc = await this.prisma.bankAccount.findFirst({
        where: { id: bankAccountId, orgId, deletedAt: null },
        select: { id: true },
      });
      if (!acc) {
        if (fromDto) throw new NotFoundException('Банківський рахунок не знайдено');
        return empty; // stale config default → degrade, не валимо платіж
      }
      return { sourceType, bankAccountId, cashRegisterId: null };
    }
    // CASH_REGISTER
    if (!cashRegisterId) {
      if (fromDto) throw new BadRequestException('Не вказано касу');
      return empty;
    }
    const reg = await this.prisma.cashRegister.findFirst({
      where: { id: cashRegisterId, orgId, deletedAt: null },
      select: { id: true },
    });
    if (!reg) {
      if (fromDto) throw new NotFoundException('Касу не знайдено');
      return empty; // stale config default → degrade, не валимо платіж
    }
    return { sourceType, bankAccountId: null, cashRegisterId };
  }

  private toDto(p: {
    id: string;
    orgId: string;
    counterpartyId: string;
    workOrderId: string | null;
    invoiceId: string | null;
    amount: import('@prisma/client').Prisma.Decimal;
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
      method: p.method,
      notes: p.notes ?? null,
      fiscalReceiptId: p.fiscalReceiptId ?? null,
      fiscalStatus: p.fiscalStatus ?? null,
      fiscalError: p.fiscalError ?? null,
      sourceType: p.sourceType ?? null,
      bankAccountId: p.bankAccountId ?? null,
      cashRegisterId: p.cashRegisterId ?? null,
      sourceName,
      createdAt: p.createdAt instanceof Date ? p.createdAt.toISOString() : p.createdAt,
    };
  }
}
