import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  CashOperationReason,
  PaymentSourceType,
  Prisma,
  UserRole,
  WorkOrderStatus,
} from '@prisma/client';
import {
  CASH_REASON_RULES,
  CASH_METHOD_CODE,
  formatPersonName,
  RECEPTIONIST_CASH_REASONS,
  TRANSACTION_TIMEOUT_MS,
  translateError,
  WO_PAYABLE_STATUSES,
  WO_STATUS_LABELS,
  type CashOperationFormValues,
  type CashReasonRule,
  type CashReversalFormValues,
} from '@sto/shared';
import { getLocale } from '../../common/tenant/tenant-context';
import { assertCounterpartyRole } from '../../common/utils/counterparty-role';
import { money } from '../../common/utils/money';
import { isSerializationConflict } from '../../common/utils/prisma-errors';
import { PrismaService } from '../../prisma/prisma.service';
import { CashService, toCashOperationDto, type CashOperationExtras } from '../cash/cash.service';
import { CashOperationResponseDto } from '../cash/cash.dto';
import { cashReasonLabel } from '../cash/cash-reason-labels';
import { PaymentsService, type PaymentReversalResult } from '../payments/payments.service';
import { SettlementsService } from '../settlements/settlements.service';
import { SupplierPaymentsService } from '../supplier-payments/supplier-payments.service';

/** Хто проводить операцію: id — автор рядка, role — для обмеження приводів (BR-CASH-021). */
export interface CashDeskActor {
  id?: string;
  role: string;
}

// Ролі, яким дозволено будь-який ручний привід. Решта — лише приводи зі свого переліку.
const FULL_ACCESS_ROLES: ReadonlySet<string> = new Set([
  UserRole.OWNER,
  UserRole.ADMIN,
  UserRole.ACCOUNTANT,
]);

// Рядки каси, які створив інший документ і скасовує лише він (BR-CASH-023): назва документа для
// тексту відмови «скасуйте її там».
const REVERSED_ELSEWHERE: Readonly<Record<string, { uk: string; en: string }>> = {
  PayrollPeriod: { uk: 'Зарплатна відомість', en: 'Payroll' },
  BankTransaction: { uk: 'Банківська виписка', en: 'Bank statement' },
};

/** Перевірені посилання операції — усе, що гілкам і відповіді треба знати про касу й учасників. */
interface DeskContext {
  cashRegisterId: string;
  currencyId: string;
  counterpartyName: string | null;
  employeeName: string | null;
  /** Наряд-підстава (лише для приводів, де підстава — наряд). */
  workOrder: { id: string; status: WorkOrderStatus; number: string } | null;
  /** Замовлення-підстава (лише для приводів, де підстава — замовлення постачальнику). */
  purchaseOrder: { id: string; number: string } | null;
}

/** Рядок каси, який дала гілка, і те, що гілка знає про його платіжний документ. */
interface DeskOutcome {
  row: CashOperationResponseDto;
  documentNumber?: string | null;
  fiscalStatus?: string | null;
}

/**
 * Каса як місце готівкових оплат (BR-CASH-016…021). Диригент ручної касової операції: перевіряє
 * привід за `CASH_REASON_RULES` і веде її тим шляхом, який змінює борг контрагента:
 *
 *   • оплата контрагента      → `PaymentsService.create` (борг, чек, бонуси, рядок каси — його);
 *   • оплата постачальнику    → `SupplierPaymentsService.create` + `confirm`;
 *   • повернення клієнту      → рядок каси + проводка `REFUND_OUT` в одній транзакції;
 *   • повернення від постач.  → рядок каси + проводка `SUPPLIER_PAYMENT_RETURN` в одній транзакції;
 *   • решта приводів          → лише рядок каси.
 *
 * Сам у журнал каси й у взаєморозрахунки НЕ пише: готівку рухає лише `CashService`, баланс —
 * лише `SettlementsService` (BR-CASH-001, BR-SETL-001). Журнал каси він лише ЧИТАЄ — щоб віддати
 * рядок, який написав сервіс оплат.
 */
@Injectable()
export class CashDeskService {
  private readonly logger = new Logger(CashDeskService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cash: CashService,
    private readonly payments: PaymentsService,
    private readonly supplierPayments: SupplierPaymentsService,
    private readonly settlements: SettlementsService,
  ) {}

  /**
   * Ручна касова операція. Повертає рядок журналу каси у формі рядка історії (для оплат — рядок,
   * який написав сервіс оплат). Назви й номери беруться з уже перевірених посилань операції, без
   * повторних запитів.
   */
  async create(
    orgId: string,
    cashRegisterId: string,
    dto: CashOperationFormValues,
    actor: CashDeskActor,
  ): Promise<CashOperationResponseDto> {
    this.assertReasonAllowedForRole(dto.reason, actor.role);
    const rule = this.assertReasonRule(dto);
    const ctx = await this.loadContext(orgId, cashRegisterId, dto, rule);

    const extras: CashOperationExtras = {
      expenseCategoryId: dto.expenseCategoryId ?? null,
      baseDocumentType: dto.baseDocumentType ?? null,
      baseDocumentId: dto.baseDocumentId ?? null,
      notes: dto.notes ?? null,
    };

    const { row, documentNumber, fiscalStatus } = await this.runBranch(
      orgId,
      dto,
      ctx,
      extras,
      actor,
    );
    return {
      ...row,
      counterpartyName: row.counterpartyId ? ctx.counterpartyName : null,
      employeeName: row.employeeId ? ctx.employeeName : null,
      baseDocumentNumber: row.baseDocumentId
        ? (ctx.workOrder?.number ?? ctx.purchaseOrder?.number ?? null)
        : null,
      documentNumber: documentNumber ?? null,
      fiscalStatus: fiscalStatus ?? null,
    };
  }

  private async runBranch(
    orgId: string,
    dto: CashOperationFormValues,
    ctx: DeskContext,
    extras: CashOperationExtras,
    actor: CashDeskActor,
  ): Promise<DeskOutcome> {
    // Контрагент у чотирьох приводах нижче гарантовано є: кожен із них має `rule.counterparty`,
    // і `assertReasonRule` без контрагента вже відмовив.
    switch (dto.reason) {
      case 'SALE_PAYMENT':
        return this.payByCounterparty(orgId, dto, required(dto.counterpartyId), ctx, extras, actor);
      case 'SUPPLIER_PAYMENT':
        return this.payToSupplier(orgId, dto, required(dto.counterpartyId), ctx, extras, actor);
      case 'REFUND':
      case 'SUPPLIER_REFUND_IN':
        return this.moveCashWithSettlement(
          orgId,
          dto,
          required(dto.counterpartyId),
          ctx,
          extras,
          actor,
        );
      default:
        return {
          row: await this.cash.createOperation(orgId, {
            cashRegisterId: ctx.cashRegisterId,
            direction: dto.direction,
            amount: dto.amount,
            reason: dto.reason,
            counterpartyId: dto.counterpartyId ?? null,
            employeeId: dto.employeeId ?? null,
            createdBy: actor.id,
            ...extras,
          }),
        };
    }
  }

  // ── Перевірки ──────────────────────────────────────────────────────────────────────────

  /** BR-CASH-021: OWNER/ADMIN/ACCOUNTANT — будь-який привід; приймальня — лише свій перелік. */
  private assertReasonAllowedForRole(
    reason: CashOperationFormValues['reason'],
    role: string,
  ): void {
    if (FULL_ACCESS_ROLES.has(role)) return;
    if (role === UserRole.RECEPTIONIST && RECEPTIONIST_CASH_REASONS.includes(reason)) return;
    throw new ForbiddenException(translateError('err.cash.reasonForbiddenForRole', getLocale()));
  }

  /**
   * BR-CASH-016, BR-CASH-020 — правила приводу, які не потребують бази. Повторює zod-схему
   * `cashOperationSchema` свідомо: сервіс викликають і не через HTTP, а схема — лише перша лінія.
   */
  private assertReasonRule(dto: CashOperationFormValues): CashReasonRule {
    const locale = getLocale();
    const rule: CashReasonRule | undefined = CASH_REASON_RULES[dto.reason];
    const reason = cashReasonLabel(dto.reason, locale);
    if (!rule?.manual) {
      throw new BadRequestException(translateError('err.cash.reasonAutoOnly', locale, { reason }));
    }
    if (rule.direction !== dto.direction) {
      throw new BadRequestException(
        translateError('err.cash.reasonDirectionMismatch', locale, { reason }),
      );
    }
    if (!(money(dto.amount) > 0)) {
      throw new BadRequestException(translateError('err.cash.amountMustBePositive', locale));
    }
    if (rule.counterparty && !dto.counterpartyId) {
      throw new BadRequestException(translateError('err.cash.counterpartyRequired', locale));
    }
    if (rule.employee && !dto.employeeId) {
      throw new BadRequestException(translateError('err.cash.employeeRequired', locale));
    }
    if (rule.categoryRequired && !dto.expenseCategoryId) {
      throw new BadRequestException(translateError('err.cash.expenseRequiresCategory', locale));
    }
    // Підстава: тип і id — лише разом, і лише того типу, який дозволяє привід.
    const baseIncomplete = !!dto.baseDocumentType !== !!dto.baseDocumentId;
    if (baseIncomplete || (dto.baseDocumentType && dto.baseDocumentType !== rule.baseDocument)) {
      throw new BadRequestException(translateError('err.cash.baseDocumentNotAllowed', locale));
    }
    return rule;
  }

  /**
   * BR-CASH-016, BR-CASH-020 — перевірки по базі: каса, контрагент (існує, у потрібній ролі),
   * працівник, документ-підстава (існує, не видалений, належить контрагентові операції).
   * Усе — до першого запису: відмова не лишає ні оплати, ні рядка каси.
   */
  private async loadContext(
    orgId: string,
    cashRegisterId: string,
    dto: CashOperationFormValues,
    rule: CashReasonRule,
  ): Promise<DeskContext> {
    const locale = getLocale();
    const alive = { orgId, deletedAt: null };
    const [register, counterparty, employee, workOrder, purchaseOrder] = await Promise.all([
      this.prisma.cashRegister.findFirst({
        where: { id: cashRegisterId, ...alive },
        select: { id: true, currencyId: true },
      }),
      dto.counterpartyId
        ? this.prisma.counterparty.findFirst({
            where: { id: dto.counterpartyId, ...alive },
            select: { id: true, type: true, firstName: true, lastName: true, companyName: true },
          })
        : null,
      dto.employeeId
        ? this.prisma.employee.findFirst({
            where: { id: dto.employeeId, ...alive },
            select: { id: true, firstName: true, lastName: true },
          })
        : null,
      dto.baseDocumentType === 'WorkOrder' && dto.baseDocumentId
        ? this.prisma.workOrder.findFirst({
            where: { id: dto.baseDocumentId, ...alive },
            select: { id: true, status: true, number: true, counterpartyId: true },
          })
        : null,
      dto.baseDocumentType === 'PurchaseOrder' && dto.baseDocumentId
        ? this.prisma.purchaseOrder.findFirst({
            where: { id: dto.baseDocumentId, ...alive },
            select: { id: true, number: true, supplierId: true },
          })
        : null,
    ]);

    if (!register) throw new NotFoundException(translateError('err.cashRegister.notFound', locale));
    if (dto.counterpartyId) {
      if (!counterparty) {
        throw new NotFoundException(translateError('err.cash.counterpartyNotFound', locale));
      }
      if (rule.counterparty) assertCounterpartyRole(counterparty.type, rule.counterparty); // BR-CP-001
    }
    if (dto.employeeId && !employee) {
      throw new NotFoundException(translateError('err.cash.employeeNotFound', locale));
    }
    if (dto.baseDocumentId) {
      const owner = workOrder?.counterpartyId ?? purchaseOrder?.supplierId;
      if (!owner) {
        throw new NotFoundException(translateError('err.cash.baseDocumentNotFound', locale));
      }
      if (owner !== dto.counterpartyId) {
        throw new BadRequestException(translateError('err.cash.baseDocumentForeign', locale));
      }
    }

    return {
      cashRegisterId: register.id,
      currencyId: register.currencyId,
      counterpartyName: counterparty
        ? formatPersonName(counterparty.lastName, counterparty.firstName, counterparty.companyName)
        : null,
      employeeName: employee ? formatPersonName(employee.lastName, employee.firstName) : null,
      workOrder: workOrder
        ? { id: workOrder.id, status: workOrder.status, number: workOrder.number }
        : null,
      purchaseOrder: purchaseOrder ? { id: purchaseOrder.id, number: purchaseOrder.number } : null,
    };
  }

  // ── Гілки ──────────────────────────────────────────────────────────────────────────────

  /**
   * BR-CASH-017: оплата контрагента = оплата клієнта з джерелом «каса». Борг, фіскальний чек,
   * бонуси й єдиний рядок каси робить `PaymentsService.create` у своїй транзакції. Наряд-підстава →
   * завжди оплата за нарядом (`workOrderId`): аванс чи оплата — за статусом наряду (BR-PAY-020),
   * сума не більша за залишок, наряд може стати «Оплачено». Без підстави — звичайна оплата боргу.
   * BR-CASH-026: підстава «Скасовано» / «Оплачено» / «Архів» → 400 ДО будь-якого запису.
   */
  private async payByCounterparty(
    orgId: string,
    dto: CashOperationFormValues,
    counterpartyId: string,
    ctx: DeskContext,
    cashRow: CashOperationExtras,
    actor: CashDeskActor,
  ): Promise<DeskOutcome> {
    if (ctx.workOrder && !WO_PAYABLE_STATUSES.includes(ctx.workOrder.status)) {
      throw new BadRequestException(
        translateError('err.cash.baseWorkOrderNotPayable', getLocale(), {
          status: WO_STATUS_LABELS[ctx.workOrder.status] ?? ctx.workOrder.status,
        }),
      );
    }
    const payment = await this.payments.create(
      orgId,
      {
        counterpartyId,
        amount: dto.amount,
        method: CASH_METHOD_CODE,
        sourceType: PaymentSourceType.CASH_REGISTER,
        cashRegisterId: ctx.cashRegisterId,
        notes: dto.notes,
        ...(ctx.workOrder && { workOrderId: ctx.workOrder.id }),
      },
      actor.id,
      cashRow,
    );
    return {
      row: await this.readRowOf(orgId, 'Payment', payment.id),
      fiscalStatus: payment.fiscalStatus,
    };
  }

  /**
   * BR-CASH-019: оплата постачальнику = документ оплати, створений і одразу проведений. Борг,
   * «сплачено» замовлення й рядок каси робить `SupplierPaymentsService.confirm` у своїй
   * транзакції. Проведення не вдалося (каса в мінус, зміна закрита, немає курсу) — чернетку
   * скасовуємо: каса й борг не змінились, «висячого» документа не лишається. Порядок той самий,
   * що в рознесенні банківського платежу (BR-BANK-028).
   */
  private async payToSupplier(
    orgId: string,
    dto: CashOperationFormValues,
    supplierId: string,
    ctx: DeskContext,
    cashRow: CashOperationExtras,
    actor: CashDeskActor,
  ): Promise<DeskOutcome> {
    // Проведення вимагає автора; маршрут завжди дає його з токена.
    const userId = required(actor.id);
    const draft = await this.supplierPayments.create(
      orgId,
      {
        supplierId,
        sourceType: PaymentSourceType.CASH_REGISTER,
        cashRegisterId: ctx.cashRegisterId,
        amount: dto.amount,
        method: CASH_METHOD_CODE,
        purchaseOrderId: ctx.purchaseOrder?.id,
        notes: dto.notes,
      },
      userId,
    );
    try {
      await this.supplierPayments.confirm(orgId, draft.id, userId, undefined, cashRow);
    } catch (confirmError: unknown) {
      await this.supplierPayments
        .cancel(orgId, draft.id)
        .catch((cancelError: unknown) =>
          this.logger.warn(
            `Не вдалось скасувати чернетку оплати постачальнику ${draft.id} після невдалого проведення: ${
              cancelError instanceof Error ? cancelError.message : String(cancelError)
            }`,
          ),
        );
      throw confirmError;
    }
    return {
      row: await this.readRowOf(orgId, 'SupplierPayment', draft.id),
      documentNumber: draft.number,
    };
  }

  /**
   * BR-CASH-018, BR-CASH-019: повернення клієнту (`REFUND` → `REFUND_OUT`, борг клієнта росте) і
   * повернення від постачальника (`SUPPLIER_REFUND_IN` → `SUPPLIER_PAYMENT_RETURN`, його борг
   * перед нами меншає). Рядок каси і проводка — одна транзакція: або обидва, або нічого.
   * «Сплачено» в рахунку, наряді й замовленні не змінюється.
   *
   * BR-SETL-010 (проводка не ідемпотентна): вона 1:1 із рядком каси, щойно створеним У ЦІЙ САМІЙ
   * транзакції (`documentId: operation.id`) — другої проводки для того самого рядка не буває.
   * Від повторного створення самої операції — `IdempotencyInterceptor` на маршруті.
   *
   * Рівень `Serializable` — як у `CashService` без зовнішньої транзакції: запобіжник «каса не йде
   * в мінус» читає залишок цією ж транзакцією, і лише SSI ловить паралельну видачу.
   */
  private async moveCashWithSettlement(
    orgId: string,
    dto: CashOperationFormValues,
    counterpartyId: string,
    ctx: DeskContext,
    cashRow: CashOperationExtras,
    actor: CashDeskActor,
  ): Promise<DeskOutcome> {
    const refundToClient = dto.reason === 'REFUND';
    try {
      return await this.prisma.$transaction(
        async tx => {
          const operation = await this.cash.createOperation(
            orgId,
            {
              cashRegisterId: ctx.cashRegisterId,
              direction: dto.direction,
              amount: dto.amount,
              reason: dto.reason,
              counterpartyId,
              createdBy: actor.id,
              ...cashRow,
            },
            tx,
          );
          await this.settlements.createTransaction(
            orgId,
            {
              counterpartyId,
              type: refundToClient ? 'REFUND_OUT' : 'SUPPLIER_PAYMENT_RETURN',
              amount: operation.amount,
              // Борг ведеться в базовій валюті — тим самим курсом, що й рядок каси.
              currencyId: ctx.currencyId,
              ...(operation.amountBase != null &&
                operation.rateUsed != null && {
                  conversion: { amountBase: operation.amountBase, rateUsed: operation.rateUsed },
                }),
              documentType: 'CashOperation',
              documentId: operation.id,
              createdBy: actor.id,
            },
            tx,
          );
          return { row: operation };
        },
        { timeout: TRANSACTION_TIMEOUT_MS, isolationLevel: 'Serializable' },
      );
    } catch (e: unknown) {
      if (isSerializationConflict(e)) {
        throw new BadRequestException(translateError('err.cash.concurrentOperation', getLocale()));
      }
      throw e;
    }
  }

  // ── Сторно ─────────────────────────────────────────────────────────────────────────────

  /**
   * BR-CASH-023…025: сторно касової операції. Новий рядок протилежного напряму на ту саму суму з
   * тим самим приводом, контрагентом, працівником, підставою, статтею й платіжним документом,
   * курсом оригіналу, `reversalOfId` = id оригіналу і приміткою = причина; рядок оригіналу не
   * змінюється. Наслідки оригіналу відкочуються в тій самій транзакції:
   *
   *   • оплата клієнта (`Payment`)            → `PaymentsService.reverse`;
   *   • оплата постачальнику (`SupplierPayment`) → `SupplierPaymentsService.reverse`;
   *   • повернення клієнту / від постачальника  → проводка `REFUND_OUT_CANCEL` /
   *     `SUPPLIER_PAYMENT_RETURN_CANCEL` з курсом проводки оригіналу;
   *   • решта приводів                         → лише рядок каси.
   *
   * Будь-яка відмова відкочує все. Повертає рядок сторно у формі рядка історії.
   */
  async reverse(
    orgId: string,
    cashRegisterId: string,
    operationId: string,
    dto: CashReversalFormValues,
    actor: CashDeskActor,
  ): Promise<CashOperationResponseDto> {
    const locale = getLocale();
    if (!FULL_ACCESS_ROLES.has(actor.role)) {
      throw new ForbiddenException(translateError('err.auth.insufficientRights', locale));
    }
    // Повторює zod-схему `cashReversalSchema` свідомо: сервіс викликають і не через HTTP.
    const reason = dto.reason?.trim() ?? '';
    if (!reason) {
      throw new BadRequestException(translateError('err.cash.reversalReasonRequired', locale));
    }

    let outcome: { row: CashOperationResponseDto; paymentReversal: PaymentReversalResult | null };
    try {
      outcome = await this.prisma.$transaction(
        async tx => {
          // Черга сторно й видач однієї каси — те саме блокування, що бере видача в CashService
          // (BR-CASH-006): друге сторно того самого рядка чекає першого й бачить його вже
          // записаним. Рівень ReadCommitted свідомо — знімок Serializable зробили б ДО очікування
          // блокування, і друге сторно не побачило б першого (його зупинив би лише унікальний індекс).
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`cash-register:${cashRegisterId}`}))`;

          const original = await tx.cashOperation.findFirst({
            where: { id: operationId, orgId, cashRegisterId },
          });
          if (!original) {
            throw new NotFoundException(translateError('err.cash.operationNotFound', locale));
          }
          this.assertReversible(original.reversalOfId, original.documentType);
          const existing = await tx.cashOperation.findFirst({
            where: { orgId, reversalOfId: original.id },
            select: { id: true },
          });
          if (existing) {
            throw new BadRequestException(translateError('err.cash.alreadyReversed', locale));
          }

          const row = await this.cash.createOperation(
            orgId,
            {
              cashRegisterId: original.cashRegisterId,
              direction: original.direction === 'IN' ? 'OUT' : 'IN',
              amount: Number(original.amount),
              reason: original.reason,
              // Стаття — як в оригіналу, без підстановки за приводом і без перевірки напряму.
              expenseCategoryId: original.expenseCategoryId,
              withoutCategory: original.expenseCategoryId == null,
              counterpartyId: original.counterpartyId,
              employeeId: original.employeeId,
              documentType: original.documentType,
              documentId: original.documentId,
              baseDocumentType: original.baseDocumentType,
              baseDocumentId: original.baseDocumentId,
              notes: reason,
              createdBy: actor.id,
              conversion:
                original.amountBase != null && original.rateUsed != null
                  ? {
                      rateUsed: Number(original.rateUsed),
                      amountBase: Number(original.amountBase),
                    }
                  : null,
              reversalOfId: original.id,
              // Аудит рядка — лише після коміту: відмова гілки нижче відкочує рядок.
              deferAudit: true,
            },
            tx,
          );

          const ctx = { cashOperationId: row.id, reason, userId: actor.id };
          if (original.documentType === 'Payment' && original.documentId) {
            return {
              row,
              paymentReversal: await this.payments.reverse(orgId, original.documentId, ctx, tx),
            };
          }
          if (original.documentType === 'SupplierPayment' && original.documentId) {
            await this.supplierPayments.reverse(orgId, original.documentId, ctx, tx);
          } else if (
            original.reason === CashOperationReason.REFUND ||
            original.reason === CashOperationReason.SUPPLIER_REFUND_IN
          ) {
            await this.reverseRefundSettlement(orgId, original, row.id, reason, actor, tx);
          }
          return { row, paymentReversal: null };
        },
        { timeout: TRANSACTION_TIMEOUT_MS },
      );
    } catch (e: unknown) {
      if (isSerializationConflict(e)) {
        throw new BadRequestException(translateError('err.cash.concurrentOperation', locale));
      }
      throw e;
    }

    if (actor.id) this.cash.recordCreated(orgId, outcome.row, actor.id);
    if (outcome.paymentReversal) {
      this.payments.afterReversal(orgId, outcome.paymentReversal, actor.id);
    }
    return this.cash.getHistoryRow(orgId, cashRegisterId, outcome.row.id);
  }

  /** BR-CASH-023: сторно сторно немає; рядки зарплати й банку скасовують там, де створили. */
  private assertReversible(reversalOfId: string | null, documentType: string | null): void {
    const locale = getLocale();
    if (reversalOfId) {
      throw new BadRequestException(translateError('err.cash.reversalOfReversal', locale));
    }
    const owner = documentType ? REVERSED_ELSEWHERE[documentType] : undefined;
    if (owner) {
      throw new BadRequestException(
        translateError('err.cash.reversalNotHere', locale, {
          document: locale === 'en' ? owner.en : owner.uk,
        }),
      );
    }
  }

  /**
   * BR-CASH-025: проводка повернення (`REFUND_OUT` / `SUPPLIER_PAYMENT_RETURN`, документ — рядок
   * оригіналу) сторнується протилежною з її ж курсом; документ сторно — рядок сторно. Повернення,
   * записане до появи проводки (без неї), сторнується лише рядком каси — відкочувати нічого.
   */
  private async reverseRefundSettlement(
    orgId: string,
    original: { id: string; reason: CashOperationReason; counterpartyId: string | null },
    reversalRowId: string,
    reason: string,
    actor: CashDeskActor,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    const refundToClient = original.reason === CashOperationReason.REFUND;
    const posted = await tx.settlementTransaction.findFirst({
      where: {
        orgId,
        documentType: 'CashOperation',
        documentId: original.id,
        type: refundToClient ? 'REFUND_OUT' : 'SUPPLIER_PAYMENT_RETURN',
      },
      orderBy: { createdAt: 'asc' },
      select: { amount: true, currencyId: true, amountBase: true, rateUsed: true },
    });
    if (!posted || !original.counterpartyId) return;
    await this.settlements.createTransaction(
      orgId,
      {
        counterpartyId: original.counterpartyId,
        type: refundToClient ? 'REFUND_OUT_CANCEL' : 'SUPPLIER_PAYMENT_RETURN_CANCEL',
        amount: Number(posted.amount),
        currencyId: posted.currencyId ?? undefined,
        ...(posted.amountBase != null &&
          posted.rateUsed != null && {
            conversion: {
              rateUsed: Number(posted.rateUsed),
              amountBase: Number(posted.amountBase),
            },
          }),
        documentType: 'CashOperation',
        documentId: reversalRowId,
        notes: reason,
        createdBy: actor.id,
      },
      tx,
    );
  }

  /**
   * Рядок каси, який написав сервіс оплат, — за платіжним документом. Пишеться він у тій самій
   * транзакції, що й оплата: оплата є, а рядка немає — порушений інваріант, не помилка користувача.
   */
  private async readRowOf(
    orgId: string,
    documentType: 'Payment' | 'SupplierPayment',
    documentId: string,
  ): Promise<CashOperationResponseDto> {
    const row = await this.prisma.cashOperation.findFirst({
      // Рядок сторно несе той самий платіжний документ (BR-CASH-023) — тут потрібен оригінал.
      where: { orgId, documentType, documentId, reversalOfId: null },
      include: { expenseCategory: { select: { name: true } } },
    });
    if (!row) throw new InternalServerErrorException();
    return toCashOperationDto(row);
  }
}

/** Обов'язкове за таблицею приводів поле: його відсутність уже відсіяв `assertReasonRule`. */
function required(value: string | undefined): string {
  if (!value) throw new InternalServerErrorException();
  return value;
}
