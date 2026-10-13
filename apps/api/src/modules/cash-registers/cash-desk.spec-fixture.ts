/**
 * Спільний harness аспектних спеків `CashDeskService` — «каса як місце готівкових оплат»
 * (BR-CASH-016…021). Написаний ІЗ КОНТРАКТУ до появи сервісу:
 *
 *   new CashDeskService(prisma, cash, payments, supplierPayments, settlements)
 *   service.create(orgId, cashRegisterId, input, user: { id?: string; role: string })
 *
 * DI-DRIFT GUARD: порядок і склад залежностей конструктора правиться ТУТ, в одному місці.
 *
 * FACTORY, не `const`: `vitest.config.ts` має `isolate: false` без `clearMocks`.
 *
 * Чому не ланцюжки `mockResolvedValueOnce`: скільки запитів зробить сервіс і в якому порядку —
 * із правил не випливає. Довідники (контрагенти, працівники, наряди, замовлення) лежать у
 * таблицях у пам'яті (`memoryTable`), які справді застосовують `where` сервісу.
 *
 * Транзакція — теж справжня за поведінкою: усе, що `CashService.createOperation` і
 * `SettlementsService.createTransaction` записали з tx-клієнтом, потрапляє в журнали лише коли
 * callback `$transaction` завершився без помилки. Кинув — нічого не лишилось. Так спек бачить
 * різницю між «рядок каси і проводка в одній транзакції» і «два окремі записи».
 */
import { expect, vi } from 'vitest';
import { CASH_REASON_RULES, type CashOperationFormValues, type CashReasonValue } from '@sto/shared';
import { CashDeskService } from './cash-desk.service';
import { memoryTable, type MemRow } from '../cash/cash.spec-fixture';
import type { PrismaService } from '../../prisma/prisma.service';
import type { CashService } from '../cash/cash.service';
import type { PaymentsService } from '../payments/payments.service';
import type { SupplierPaymentsService } from '../supplier-payments/supplier-payments.service';
import type { SettlementsService } from '../settlements/settlements.service';

export const ORG = '11111111-1111-4111-8111-111111111111';
export const OTHER_ORG = '99999999-9999-4999-8999-999999999999';
export const REG = '22222222-2222-4222-8222-222222222222';
export const USER = '44444444-4444-4444-8444-444444444444';

/** Контрагенти: клієнт, постачальник, «обидва», ще один клієнт, чужий і видалений. */
export const CLIENT = 'c0000001-0000-4000-8000-000000000001';
export const SUPPLIER = 'c0000002-0000-4000-8000-000000000002';
export const BOTH = 'c0000003-0000-4000-8000-000000000003';
export const CLIENT_2 = 'c0000004-0000-4000-8000-000000000004';
export const SUPPLIER_2 = 'c0000005-0000-4000-8000-000000000005';
export const FOREIGN_CP = 'c0000006-0000-4000-8000-000000000006';
export const DELETED_CLIENT = 'c0000007-0000-4000-8000-000000000007';
export const DELETED_SUPPLIER = 'c0000008-0000-4000-8000-000000000008';
export const MISSING = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

export const EMP = 'e0000001-0000-4000-8000-000000000001';
export const FOREIGN_EMP = 'e0000002-0000-4000-8000-000000000002';
export const DELETED_EMP = 'e0000003-0000-4000-8000-000000000003';

/** Наряди клієнта CLIENT (статус задає кейс), чужі й видалені. */
export const WO = 'a0000001-0000-4000-8000-000000000001';
export const WO_OF_CLIENT_2 = 'a0000002-0000-4000-8000-000000000002';
export const WO_FOREIGN_ORG = 'a0000003-0000-4000-8000-000000000003';
export const WO_DELETED = 'a0000004-0000-4000-8000-000000000004';
export const WO_OF_BOTH = 'a0000005-0000-4000-8000-000000000005';

/** Замовлення постачальника SUPPLIER, чужі й видалені. */
export const PO = 'b0000001-0000-4000-8000-000000000001';
export const PO_OF_SUPPLIER_2 = 'b0000002-0000-4000-8000-000000000002';
export const PO_FOREIGN_ORG = 'b0000003-0000-4000-8000-000000000003';
export const PO_DELETED = 'b0000004-0000-4000-8000-000000000004';

export const CAT_EXPENSE = 'd0000001-0000-4000-8000-000000000001';
export const CAT_INCOME = 'd0000002-0000-4000-8000-000000000002';

export type DeskInput = CashOperationFormValues;
export interface DeskUser {
  id?: string;
  role: string;
}
export const ADMIN: DeskUser = { id: USER, role: 'ADMIN' };

const GONE = new Date('2026-10-01T10:00:00.000Z');

const counterparty = (id: string, type: string, over: MemRow = {}): MemRow => ({
  id,
  orgId: ORG,
  type,
  firstName: 'Тест',
  lastName: id.slice(0, 8),
  companyName: null,
  deletedAt: null,
  ...over,
});

interface Staged {
  cash: MemRow[];
  settlements: MemRow[];
}

export function makeDesk() {
  const tables = {
    counterparty: memoryTable([
      counterparty(CLIENT, 'CLIENT'),
      counterparty(CLIENT_2, 'CLIENT'),
      counterparty(SUPPLIER, 'SUPPLIER'),
      counterparty(SUPPLIER_2, 'SUPPLIER'),
      counterparty(BOTH, 'BOTH'),
      counterparty(FOREIGN_CP, 'BOTH', { orgId: OTHER_ORG }),
      counterparty(DELETED_CLIENT, 'CLIENT', { deletedAt: GONE }),
      counterparty(DELETED_SUPPLIER, 'SUPPLIER', { deletedAt: GONE }),
    ]),
    employee: memoryTable([
      {
        id: EMP,
        orgId: ORG,
        status: 'ACTIVE',
        firstName: 'Іван',
        lastName: 'Майстер',
        deletedAt: null,
      },
      {
        id: FOREIGN_EMP,
        orgId: OTHER_ORG,
        status: 'ACTIVE',
        firstName: 'Чужий',
        lastName: 'Працівник',
        deletedAt: null,
      },
      {
        id: DELETED_EMP,
        orgId: ORG,
        status: 'ACTIVE',
        firstName: 'Звільнений',
        lastName: 'Працівник',
        deletedAt: GONE,
      },
    ]),
    workOrder: memoryTable([
      {
        id: WO,
        orgId: ORG,
        counterpartyId: CLIENT,
        status: 'INVOICED',
        number: 'НЗ-0001',
        deletedAt: null,
      },
      {
        id: WO_OF_CLIENT_2,
        orgId: ORG,
        counterpartyId: CLIENT_2,
        status: 'INVOICED',
        number: 'НЗ-0002',
        deletedAt: null,
      },
      {
        id: WO_FOREIGN_ORG,
        orgId: OTHER_ORG,
        counterpartyId: CLIENT,
        status: 'INVOICED',
        number: 'НЗ-0003',
        deletedAt: null,
      },
      {
        id: WO_DELETED,
        orgId: ORG,
        counterpartyId: CLIENT,
        status: 'INVOICED',
        number: 'НЗ-0004',
        deletedAt: GONE,
      },
      {
        id: WO_OF_BOTH,
        orgId: ORG,
        counterpartyId: BOTH,
        status: 'INVOICED',
        number: 'НЗ-0005',
        deletedAt: null,
      },
    ]),
    purchaseOrder: memoryTable([
      {
        id: PO,
        orgId: ORG,
        supplierId: SUPPLIER,
        status: 'RECEIVED',
        number: 'ЗП-0001',
        deletedAt: null,
      },
      {
        id: PO_OF_SUPPLIER_2,
        orgId: ORG,
        supplierId: SUPPLIER_2,
        status: 'RECEIVED',
        number: 'ЗП-0002',
        deletedAt: null,
      },
      {
        id: PO_FOREIGN_ORG,
        orgId: OTHER_ORG,
        supplierId: SUPPLIER,
        status: 'RECEIVED',
        number: 'ЗП-0003',
        deletedAt: null,
      },
      {
        id: PO_DELETED,
        orgId: ORG,
        supplierId: SUPPLIER,
        status: 'RECEIVED',
        number: 'ЗП-0004',
        deletedAt: GONE,
      },
    ]),
    cashRegister: memoryTable([
      {
        id: REG,
        orgId: ORG,
        isFiscal: false,
        branchId: 'b1',
        currencyId: 'uah-id',
        initialBalance: 100000,
        deletedAt: null,
      },
    ]),
    expenseCategory: memoryTable([
      {
        id: CAT_EXPENSE,
        orgId: ORG,
        name: 'Оренда',
        type: 'EXPENSE',
        isActive: true,
        defaultReason: null,
        deletedAt: null,
      },
      {
        id: CAT_INCOME,
        orgId: ORG,
        name: 'Інші надходження',
        type: 'INCOME',
        isActive: true,
        defaultReason: null,
        deletedAt: null,
      },
    ]),
    /** ЗАКОМІЧЕНИЙ журнал каси: сюди рядок потрапляє лише після успішної транзакції. */
    cashOperation: memoryTable([]),
  };

  /** Закомічені рядки каси й проводки взаєморозрахунків. */
  const cashRows = tables.cashOperation.rows;
  const settlementRows: MemRow[] = [];
  const staged = new WeakMap<object, Staged>();
  let opSeq = 0;

  const bucketOf = (tx: unknown): Staged | undefined =>
    typeof tx === 'object' && tx !== null ? staged.get(tx) : undefined;
  /** Чи є об'єкт tx-клієнтом, виданим `$transaction` цього harness (а не кореневим prisma). */
  const isTx = (tx: unknown): boolean => bucketOf(tx) !== undefined;

  const cashRow = (orgId: string, data: MemRow): MemRow => {
    opSeq += 1;
    return {
      id: `op-${opSeq}`,
      orgId,
      cashShiftId: null,
      expenseCategoryId: null,
      counterpartyId: null,
      employeeId: null,
      documentType: null,
      documentId: null,
      baseDocumentType: null,
      baseDocumentId: null,
      notes: null,
      createdAt: new Date('2026-10-14T09:00:00.000Z'),
      expenseCategory: null,
      ...data,
    };
  };

  const prisma = {
    ...tables,
    $transaction: vi.fn(async (arg: unknown) => {
      if (typeof arg !== 'function') return Promise.all(arg as Promise<unknown>[]);
      const tx = { ...tables };
      const bucket: Staged = { cash: [], settlements: [] };
      staged.set(tx, bucket);
      // Кинув callback → до журналів нічого не доходить: це і є відкат.
      const result: unknown = await (arg as (client: unknown) => Promise<unknown>)(tx);
      cashRows.push(...bucket.cash);
      settlementRows.push(...bucket.settlements);
      return result;
    }),
  };

  const cash = {
    createOperation: vi.fn((orgId: string, input: MemRow, tx?: unknown) => {
      const row = cashRow(orgId, input);
      (bucketOf(tx)?.cash ?? cashRows).push(row);
      return Promise.resolve(row);
    }),
    getBalance: vi.fn(() => Promise.resolve(100000)),
  };

  // Справжній PaymentsService.create сам пише єдиний рядок каси (documentType = 'Payment').
  const payments = {
    create: vi.fn((orgId: string, dto: MemRow, ..._rest: unknown[]) => {
      cashRows.push(
        cashRow(orgId, {
          cashRegisterId: dto.cashRegisterId,
          direction: 'IN',
          reason: 'SALE_PAYMENT',
          amount: dto.amount,
          counterpartyId: dto.counterpartyId,
          documentType: 'Payment',
          documentId: 'pay-1',
        }),
      );
      return Promise.resolve({ id: 'pay-1', orgId, ...dto });
    }),
  };

  // Справжній SupplierPaymentsService: create → чернетка без руху грошей; confirm → рядок каси
  // (documentType = 'SupplierPayment') і проводка; cancel → чернетка скасована.
  const supplierPayments = {
    create: vi.fn((orgId: string, dto: MemRow, ..._rest: unknown[]) =>
      Promise.resolve({ id: 'sp-1', orgId, status: 'DRAFT', ...dto }),
    ),
    confirm: vi.fn((orgId: string, id: string, ..._rest: unknown[]) => {
      cashRows.push(
        cashRow(orgId, {
          cashRegisterId: REG,
          direction: 'OUT',
          reason: 'SUPPLIER_PAYMENT',
          documentType: 'SupplierPayment',
          documentId: id,
        }),
      );
      return Promise.resolve({ id, orgId, status: 'CONFIRMED' });
    }),
    cancel: vi.fn((orgId: string, id: string) =>
      Promise.resolve({ id, orgId, status: 'CANCELLED' }),
    ),
  };

  const settlements = {
    createTransaction: vi.fn((orgId: string, dto: MemRow, tx?: unknown) => {
      (bucketOf(tx)?.settlements ?? settlementRows).push({ orgId, ...dto });
      return Promise.resolve();
    }),
  };

  const service = new CashDeskService(
    prisma as unknown as PrismaService,
    cash as unknown as CashService,
    payments as unknown as PaymentsService,
    supplierPayments as unknown as SupplierPaymentsService,
    settlements as unknown as SettlementsService,
  );

  return {
    service,
    prisma,
    tables,
    cash,
    payments,
    supplierPayments,
    settlements,
    cashRows,
    settlementRows,
    isTx,
  };
}

export type Desk = ReturnType<typeof makeDesk>;

/** Мінімальний коректний вхід для приводу — за таблицею `CASH_REASON_RULES`. */
export function validInput(reason: CashReasonValue, over: Partial<DeskInput> = {}): DeskInput {
  const rule = CASH_REASON_RULES[reason];
  return {
    direction: rule.direction,
    reason,
    amount: 100,
    ...(rule.counterparty
      ? { counterpartyId: rule.counterparty === 'client' ? CLIENT : SUPPLIER }
      : {}),
    ...(rule.employee ? { employeeId: EMP } : {}),
    ...(rule.categoryRequired ? { expenseCategoryId: CAT_EXPENSE } : {}),
    ...over,
  };
}

/** Єдине місце виклику `CashDeskService.create` — сигнатура з контракту. */
export function createOp(h: Desk, input: DeskInput, user: DeskUser = ADMIN) {
  return h.service.create(ORG, REG, input, user);
}

/** Відмова не лишила слідів: ні рядка каси, ні оплати, ні чернетки, ні проводки. */
export function expectNothingMoved(h: Desk): void {
  expect(h.cash.createOperation).not.toHaveBeenCalled();
  expect(h.payments.create).not.toHaveBeenCalled();
  expect(h.supplierPayments.create).not.toHaveBeenCalled();
  expect(h.supplierPayments.confirm).not.toHaveBeenCalled();
  expect(h.settlements.createTransaction).not.toHaveBeenCalled();
  expect(h.cashRows).toEqual([]);
  expect(h.settlementRows).toEqual([]);
}
