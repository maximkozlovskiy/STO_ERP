import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { BankTransactionDirection, Prisma } from '@prisma/client';
import { translateError } from '@sto/shared';
import { getLocale } from '../../common/tenant/tenant-context';
import { assertCounterpartyRole } from '../../common/utils/counterparty-role';
import type { PrismaService } from '../../prisma/prisma.service';
import type { BankTxOutMatchType, ReconcileTransactionDto } from './bank-statement.dto';

// Перевірка вводу рознесення (`reconcile`) ДО захоплення рядка: напрям проти виду й усі посилання
// виду — у межах orgId і серед не видалених (BR-BANK-025, 027, 028, 030…034, 038). Нічого не пише.
// Винесено з BankReconciliationService: там лишаються CAS і ефекти (проведення, каса, оплата).

type ErrorKey = Parameters<typeof translateError>[0];

const badRequest = (key: ErrorKey) => new BadRequestException(translateError(key, getLocale()));
const notFound = (key: ErrorKey) => new NotFoundException(translateError(key, getLocale()));

/** Поля рядка виписки, з яких рознесення бере суму, рахунок і валюту (ніколи з запиту — BR-BANK-026). */
export interface OutgoingRow {
  direction: BankTransactionDirection;
  bankAccountId: string;
  currencyId: string;
  amount: Prisma.Decimal | number;
}

/** Посилання рядка, які визначає вид рознесення; усі решта лишаються `null`. */
export interface OutgoingLinks {
  counterpartyId: string | null;
  supplierPaymentId: string | null;
  expenseCategoryId: string | null;
  payrollPeriodId: string | null;
  employeeId: string | null;
  transferBankAccountId: string | null;
}

/** Усі посилання рознесення очищені — стан рядка `UNMATCHED`. */
export const NO_OUTGOING_LINKS: OutgoingLinks = {
  counterpartyId: null,
  supplierPaymentId: null,
  expenseCategoryId: null,
  payrollPeriodId: null,
  employeeId: null,
  transferBankAccountId: null,
};

/**
 * Що робити з рядком після перевірок. `NEW_SUPPLIER_PAYMENT` — єдиний план без готових посилань:
 * оплату ще треба створити й провести (шаблон «захоплення → дія → відкат»), решта виконується
 * однією транзакцією БД.
 */
export type OutgoingPlan =
  | { kind: 'LINK'; links: OutgoingLinks }
  | { kind: 'CLIENT_REFUND'; links: OutgoingLinks; counterpartyId: string }
  | { kind: 'CASH_WITHDRAWAL'; links: OutgoingLinks; cashRegisterId: string }
  | { kind: 'NEW_SUPPLIER_PAYMENT'; supplierId: string; purchaseOrderId?: string };

/** Суми в копійках рівні (Decimal(12,2) проти Decimal(12,2); поріг гасить лише похибку Number). */
const sameAmount = (a: Prisma.Decimal | number, b: Prisma.Decimal | number): boolean =>
  Math.abs(Number(a) - Number(b)) < 0.005;

/**
 * BR-BANK-025: вихідні види — лише для `OUT`-рядка; `TRANSFER` — для обох напрямків.
 * Невідповідність → 400 до будь-якого запису.
 */
export function assertOutgoingDirection(
  direction: BankTransactionDirection,
  type: BankTxOutMatchType,
): void {
  if (type !== 'TRANSFER' && direction !== 'OUT') {
    throw badRequest('err.bankStatement.wrongDirection');
  }
}

function required(value: string | undefined): string {
  if (!value) throw badRequest('err.bankStatement.fieldRequiredForType');
  return value;
}

async function findCounterparty(prisma: PrismaService, orgId: string, id: string) {
  const cp = await prisma.counterparty.findFirst({
    where: { id, orgId, deletedAt: null },
    select: { id: true, type: true },
  });
  if (!cp) throw notFound('err.bankStatement.counterpartyNotFound');
  return cp;
}

/** BR-BANK-027: прив'язка до наявної проведеної оплати — нічого не проводиться. */
async function planLinkSupplierPayment(
  prisma: PrismaService,
  orgId: string,
  row: OutgoingRow,
  supplierPaymentId: string,
): Promise<OutgoingPlan> {
  const sp = await prisma.supplierPayment.findFirst({
    where: { id: supplierPaymentId, orgId, deletedAt: null },
    select: {
      id: true,
      status: true,
      sourceType: true,
      bankAccountId: true,
      currencyId: true,
      amount: true,
      supplierId: true,
      bankTransaction: { select: { id: true } },
    },
  });
  if (!sp) throw notFound('err.bankStatement.supplierPaymentNotFound');
  if (
    sp.status !== 'CONFIRMED' ||
    sp.sourceType !== 'BANK_ACCOUNT' ||
    sp.bankAccountId !== row.bankAccountId ||
    sp.currencyId !== row.currencyId ||
    !sameAmount(sp.amount, row.amount)
  ) {
    throw badRequest('err.bankStatement.supplierPaymentMismatch');
  }
  // Швидка відмова; справжній рубіж проти подвійної прив'язки — унікальний індекс (P2002 → 409).
  if (sp.bankTransaction) {
    throw new ConflictException(
      translateError('err.bankStatement.supplierPaymentAlreadyLinked', getLocale()),
    );
  }
  return {
    kind: 'LINK',
    links: { ...NO_OUTGOING_LINKS, counterpartyId: sp.supplierId, supplierPaymentId: sp.id },
  };
}

/** BR-BANK-028: нова оплата — постачальник за роллю, замовлення лише цього постачальника. */
async function planNewSupplierPayment(
  prisma: PrismaService,
  orgId: string,
  dto: ReconcileTransactionDto,
): Promise<OutgoingPlan> {
  const supplierId = required(dto.counterpartyId);
  const [supplier, purchaseOrder] = await Promise.all([
    findCounterparty(prisma, orgId, supplierId),
    dto.purchaseOrderId
      ? prisma.purchaseOrder.findFirst({
          where: { id: dto.purchaseOrderId, orgId, deletedAt: null },
          select: { id: true, supplierId: true },
        })
      : Promise.resolve(null),
  ]);
  assertCounterpartyRole(supplier.type, 'supplier');
  if (dto.purchaseOrderId) {
    if (!purchaseOrder) throw notFound('err.bankStatement.purchaseOrderNotFound');
    if (purchaseOrder.supplierId !== supplierId) {
      throw badRequest('err.supplierPayment.orderNotForSupplier');
    }
  }
  return { kind: 'NEW_SUPPLIER_PAYMENT', supplierId, purchaseOrderId: dto.purchaseOrderId };
}

/** BR-BANK-031: стаття своєї організації — не видалена, активна, типу EXPENSE. */
async function planExpense(
  prisma: PrismaService,
  orgId: string,
  dto: ReconcileTransactionDto,
): Promise<OutgoingPlan> {
  const expenseCategoryId = required(dto.expenseCategoryId);
  const [category, counterparty] = await Promise.all([
    prisma.expenseCategory.findFirst({
      where: { id: expenseCategoryId, orgId, deletedAt: null },
      select: { type: true, isActive: true },
    }),
    // Контрагент витрати необов'язковий і довідковий, але посилання мусить бути справжнім.
    dto.counterpartyId
      ? findCounterparty(prisma, orgId, dto.counterpartyId)
      : Promise.resolve(null),
  ]);
  if (!category || !category.isActive || category.type !== 'EXPENSE') {
    throw badRequest('err.bankStatement.expenseCategoryInvalid');
  }
  return {
    kind: 'LINK',
    links: { ...NO_OUTGOING_LINKS, expenseCategoryId, counterpartyId: counterparty?.id ?? null },
  };
}

/** BR-BANK-032: період COMPUTED / PAID; вказаний працівник має рядок у цьому періоді. */
async function planPayroll(
  prisma: PrismaService,
  orgId: string,
  dto: ReconcileTransactionDto,
): Promise<OutgoingPlan> {
  const payrollPeriodId = required(dto.payrollPeriodId);
  const [period, line] = await Promise.all([
    prisma.payrollPeriod.findFirst({
      where: { id: payrollPeriodId, orgId, deletedAt: null },
      select: { status: true },
    }),
    dto.employeeId
      ? prisma.payrollLine.findFirst({
          where: { orgId, periodId: payrollPeriodId, employeeId: dto.employeeId },
          select: { id: true },
        })
      : Promise.resolve(null),
  ]);
  if (!period || (period.status !== 'COMPUTED' && period.status !== 'PAID')) {
    throw badRequest('err.bankStatement.payrollPeriodInvalid');
  }
  if (dto.employeeId && !line) throw badRequest('err.bankStatement.employeeNotInPeriod');
  return {
    kind: 'LINK',
    links: { ...NO_OUTGOING_LINKS, payrollPeriodId, employeeId: dto.employeeId ?? null },
  };
}

/** BR-BANK-033: інший власний рахунок — не видалений і не той самий, що в рядку. */
async function planTransfer(
  prisma: PrismaService,
  orgId: string,
  row: OutgoingRow,
  dto: ReconcileTransactionDto,
): Promise<OutgoingPlan> {
  const transferBankAccountId = required(dto.transferBankAccountId);
  const account =
    transferBankAccountId === row.bankAccountId
      ? null
      : await prisma.bankAccount.findFirst({
          where: { id: transferBankAccountId, orgId, deletedAt: null },
          select: { id: true },
        });
  if (!account) throw badRequest('err.bankStatement.transferAccountInvalid');
  return { kind: 'LINK', links: { ...NO_OUTGOING_LINKS, transferBankAccountId } };
}

/** BR-BANK-034: каса своєї організації тієї самої валюти, що й рядок. */
async function planCashWithdrawal(
  prisma: PrismaService,
  orgId: string,
  row: OutgoingRow,
  dto: ReconcileTransactionDto,
): Promise<OutgoingPlan> {
  const cashRegisterId = required(dto.cashRegisterId);
  const register = await prisma.cashRegister.findFirst({
    where: { id: cashRegisterId, orgId, deletedAt: null },
    select: { id: true, currencyId: true },
  });
  // BR-BANK-038: каса, якої немає у своїй організації, — невалідне значення поля (400), не 404.
  if (!register) throw badRequest('err.bankStatement.cashRegisterNotFound');
  if (register.currencyId !== row.currencyId) {
    throw badRequest('err.bankStatement.cashRegisterCurrencyMismatch');
  }
  return { kind: 'CASH_WITHDRAWAL', links: NO_OUTGOING_LINKS, cashRegisterId };
}

/**
 * Перевіряє посилання виду рознесення й повертає план дії. Кидає 400 / 404 / 409 — рядок при
 * цьому не чіпається (перевірка стоїть до CAS-захоплення).
 */
export async function resolveOutgoingPlan(
  prisma: PrismaService,
  orgId: string,
  row: OutgoingRow,
  dto: ReconcileTransactionDto,
): Promise<OutgoingPlan> {
  switch (dto.type) {
    case 'SUPPLIER_PAYMENT':
      return dto.supplierPaymentId
        ? planLinkSupplierPayment(prisma, orgId, row, dto.supplierPaymentId)
        : planNewSupplierPayment(prisma, orgId, dto);
    case 'CLIENT_REFUND': {
      const counterparty = await findCounterparty(prisma, orgId, required(dto.counterpartyId));
      assertCounterpartyRole(counterparty.type, 'client');
      return {
        kind: 'CLIENT_REFUND',
        links: { ...NO_OUTGOING_LINKS, counterpartyId: counterparty.id },
        counterpartyId: counterparty.id,
      };
    }
    case 'EXPENSE':
      return planExpense(prisma, orgId, dto);
    case 'PAYROLL':
      return planPayroll(prisma, orgId, dto);
    case 'TRANSFER':
      return planTransfer(prisma, orgId, row, dto);
    case 'CASH_WITHDRAWAL':
      return planCashWithdrawal(prisma, orgId, row, dto);
    default: {
      const unknown: never = dto.type;
      void unknown;
      throw badRequest('err.dto.bankStatement.type.invalid');
    }
  }
}
