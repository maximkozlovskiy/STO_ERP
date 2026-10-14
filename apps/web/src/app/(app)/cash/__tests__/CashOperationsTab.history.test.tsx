// Історія операцій каси й доступ до операцій за роллю (BR-CASH-016…022).
//
//   - колонка «Контрагент / працівник»: назва контрагента або ім'я працівника рядка;
//   - колонка «Підстава»: номер документа, клік відкриває саме його картку (наряд або
//     замовлення постачальнику) і не «провалюється» у рядок;
//   - позначка фіскального чека є лише в рядків із `fiscalStatus`;
//   - «Повторити» — лише для чека FAILED, лише тим, кому бекенд дозволяє повтор, і шле
//     id ПЛАТЕЖУ (`documentId`), а не id касового рядка;
//   - приймальня має «Внести», але не «Видати»; роль без операцій — жодної кнопки.
//
// Mutation-verify:
//   - `retryFiscal.mutateAsync(op.documentId)` → `(op.id)`      → «id платежу» падає;
//   - прибрати `canOperate &&` перед кнопкою «Повторити»        → «приймальня» падає;
//   - `nav.toWorkOrder` ↔ `nav.toPurchaseOrder` поміняти місцями → «відкриває картку» падає;
//   - прибрати `e.stopPropagation()` у кнопці підстави           → «не провалюється в рядок» падає.

import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import type { CashOperation } from '@/hooks/api/useCash';

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast: toastMock }));
vi.mock('@/lib/format', () => ({
  fmtMoney: (v: number) => String(v),
  fmtDateTime: (v: string) => v,
  kyivToday: () => '2026-10-14',
}));
vi.mock('@/components/ui/date-picker-input', () => ({ DatePickerInput: () => null }));

const nav = vi.hoisted(() => ({ toWorkOrder: vi.fn(), toPurchaseOrder: vi.fn() }));
vi.mock('@/lib/linked-nav', () => ({ useLinkedNav: () => nav }));

let operations: CashOperation[] = [];
const retryMutateAsync = vi.fn();
vi.mock('@/hooks/api/useCash', () => ({
  useCashRegisters: () => ({
    data: [
      {
        id: 'reg-1',
        name: 'Каса №1',
        branchId: 'br-1',
        currencyCode: 'UAH',
        currencySymbol: '₴',
        isFiscal: false,
        initialBalance: 0,
        balance: 0,
      },
    ],
    isLoading: false,
  }),
  useCashOperations: () => ({ data: operations, isLoading: false }),
  useCreateCashOperation: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRetryCashFiscal: () => ({ mutateAsync: retryMutateAsync, isPending: false }),
  useBaseCurrency: () => ({ data: { code: 'UAH', symbol: '₴' } }),
}));
vi.mock('@/hooks/api/useExpenseCategories', () => ({
  useExpenseCategories: () => ({ data: [] }),
  flattenActiveByType: () => [],
}));
vi.mock('@/hooks/api/useCashShift', () => ({
  useCurrentShift: () => ({ data: null, isLoading: false }),
  useOpenShift: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useCloseShift: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

import CashOperationsTab from '../CashOperationsTab';

const WORK_ORDER = '44444444-4444-4444-8444-444444444444';
const PURCHASE_ORDER = '55555555-5555-4555-8555-555555555555';
const PAYMENT = '66666666-6666-4666-8666-666666666666';

const op = (over: Partial<CashOperation>): CashOperation => ({
  id: 'op',
  cashRegisterId: 'reg-1',
  direction: 'IN',
  amount: 100,
  reason: 'MANUAL_IN',
  createdAt: '2026-10-14T09:00:00.000Z',
  ...over,
});

const salePayment = (over: Partial<CashOperation> = {}) =>
  op({
    id: 'op-sale',
    reason: 'SALE_PAYMENT',
    counterpartyName: 'Коваль Олег',
    baseDocumentType: 'WorkOrder',
    baseDocumentId: WORK_ORDER,
    baseDocumentNumber: 'НЗ-000012',
    documentType: 'Payment',
    documentId: PAYMENT,
    fiscalStatus: 'DONE',
    ...over,
  });

const rowOf = (text: string) => screen.getByText(text).closest('tr') as HTMLElement;

describe('CashOperationsTab — історія операцій', () => {
  beforeEach(() => {
    operations = [];
    nav.toWorkOrder.mockReset();
    nav.toPurchaseOrder.mockReset();
    retryMutateAsync.mockReset();
    toastMock.success.mockReset();
    toastMock.error.mockReset();
  });

  it('шапка має колонки «Контрагент / працівник» і «Підстава»', () => {
    render(<CashOperationsTab canOperate />);
    const headers = screen.getAllByRole('columnheader').map(h => h.textContent);
    expect(headers).toEqual([
      'Дата',
      'Операція',
      'Привід',
      'Контрагент / працівник',
      'Підстава',
      'Сума',
    ]);
  });

  it('рядок показує контрагента або працівника; без них і без підстави — прочерки', () => {
    operations = [
      salePayment(),
      op({
        id: 'op-adv',
        reason: 'ADVANCE_ISSUE',
        direction: 'OUT',
        employeeName: 'Петренко Іван',
      }),
      op({ id: 'op-plain', reason: 'COLLECTION', notes: 'інкасація ранкова' }),
    ];
    render(<CashOperationsTab canOperate />);
    expect(within(rowOf('Коваль Олег')).getByText(/Оплата контрагента/)).toBeInTheDocument();
    expect(within(rowOf('Петренко Іван')).getByText(/Під звіт/)).toBeInTheDocument();
    const plain = rowOf('Інкасація · інкасація ранкова');
    expect(within(plain).getAllByText('—')).toHaveLength(2);
    expect(within(plain).queryByRole('button')).not.toBeInTheDocument();
  });

  it('підстава-наряд відкриває картку наряду, підстава-замовлення — картку замовлення', () => {
    operations = [
      salePayment(),
      op({
        id: 'op-sup',
        reason: 'SUPPLIER_PAYMENT',
        direction: 'OUT',
        counterpartyName: 'ТОВ Запчастини',
        baseDocumentType: 'PurchaseOrder',
        baseDocumentId: PURCHASE_ORDER,
        baseDocumentNumber: 'ЗП-000003',
      }),
    ];
    render(<CashOperationsTab canOperate canOpenPurchaseOrders />);

    fireEvent.click(screen.getByRole('button', { name: 'Відкрити документ НЗ-000012' }));
    expect(nav.toWorkOrder).toHaveBeenCalledWith(WORK_ORDER);
    expect(nav.toPurchaseOrder).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Відкрити документ ЗП-000003' }));
    expect(nav.toPurchaseOrder).toHaveBeenCalledWith(PURCHASE_ORDER);
    expect(nav.toWorkOrder).toHaveBeenCalledTimes(1);
  });

  // Бухгалтер у «Купівлі» бачить лише графік оплат, приймальню звідти веде на /403: посилання
  // на картку замовлення для них вело б у нікуди. Наряд відкривають обидві ролі.
  it('роль без доступу до замовлень: номер замовлення-підстави — текст, наряд — далі посилання', () => {
    operations = [
      salePayment(),
      op({
        id: 'op-sup',
        reason: 'SUPPLIER_PAYMENT',
        direction: 'OUT',
        counterpartyName: 'ТОВ Запчастини',
        baseDocumentType: 'PurchaseOrder',
        baseDocumentId: PURCHASE_ORDER,
        baseDocumentNumber: 'ЗП-000003',
      }),
    ];
    render(<CashOperationsTab canOperate />);

    expect(screen.getByText('ЗП-000003')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Відкрити документ ЗП-000003' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Відкрити документ НЗ-000012' })).toBeInTheDocument();
  });

  it('клік по підставі не «провалюється» в рядок', () => {
    operations = [salePayment()];
    const onRowClick = vi.fn();
    render(
      <div role="presentation" onClick={onRowClick}>
        <CashOperationsTab canOperate />
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Відкрити документ НЗ-000012' }));
    expect(nav.toWorkOrder).toHaveBeenCalledTimes(1);
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it('позначка чека — лише в рядків із фіскальним станом, з підписом стану', () => {
    operations = [
      salePayment({ id: 'a', counterpartyName: 'Клієнт А', fiscalStatus: 'QUEUED' }),
      salePayment({ id: 'b', counterpartyName: 'Клієнт Б', fiscalStatus: 'DONE' }),
      salePayment({ id: 'c', counterpartyName: 'Клієнт В', fiscalStatus: 'FAILED' }),
      salePayment({ id: 'd', counterpartyName: 'Клієнт Г', fiscalStatus: 'SKIPPED' }),
      salePayment({ id: 'e', counterpartyName: 'Клієнт Ґ', fiscalStatus: null }),
    ];
    render(<CashOperationsTab canOperate />);
    expect(within(rowOf('Клієнт А')).getByText('Чек: У черзі')).toBeInTheDocument();
    expect(within(rowOf('Клієнт Б')).getByText('Чек: Пробито')).toBeInTheDocument();
    expect(within(rowOf('Клієнт В')).getByText('Чек: Помилка')).toBeInTheDocument();
    expect(within(rowOf('Клієнт Г')).getByText('Чек: Пропущено')).toBeInTheDocument();
    expect(within(rowOf('Клієнт Ґ')).queryByText(/^Чек:/)).not.toBeInTheDocument();
    // Повторити можна лише чек із помилкою: у черзі, пробитий і пропущений повтору не мають.
    expect(screen.getAllByRole('button', { name: 'Повторити' })).toHaveLength(1);
    expect(within(rowOf('Клієнт В')).getByRole('button', { name: 'Повторити' })).toBeEnabled();
  });

  it('«Повторити» є лише в чека FAILED і шле id платежу, а не касового рядка', async () => {
    retryMutateAsync.mockResolvedValue(undefined);
    operations = [
      salePayment({ id: 'op-failed', counterpartyName: 'Клієнт В', fiscalStatus: 'FAILED' }),
      salePayment({ id: 'op-done', counterpartyName: 'Клієнт Б', fiscalStatus: 'DONE' }),
    ];
    render(<CashOperationsTab canOperate />);
    expect(within(rowOf('Клієнт Б')).queryByRole('button', { name: 'Повторити' })).toBeNull();

    fireEvent.click(within(rowOf('Клієнт В')).getByRole('button', { name: 'Повторити' }));
    await waitFor(() => expect(retryMutateAsync).toHaveBeenCalledTimes(1));
    expect(retryMutateAsync).toHaveBeenCalledWith(PAYMENT);
    await waitFor(() =>
      expect(toastMock.success).toHaveBeenCalledWith('Фіскалізацію поставлено в чергу повторно'),
    );
  });

  it('відмова повтору показана користувачу', async () => {
    retryMutateAsync.mockRejectedValue(new Error('Чек уже фіскалізовано'));
    operations = [salePayment({ fiscalStatus: 'FAILED' })];
    render(<CashOperationsTab canOperate />);
    fireEvent.click(screen.getByRole('button', { name: 'Повторити' }));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('Чек уже фіскалізовано'));
  });

  it('приймальня бачить стан чека, але повторити не може (бекенд дав би 403)', () => {
    operations = [salePayment({ fiscalStatus: 'FAILED' })];
    render(<CashOperationsTab receptionist />);
    expect(screen.getByText('Чек: Помилка')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Повторити' })).not.toBeInTheDocument();
  });
});

describe('CashOperationsTab — кнопки операцій за роллю', () => {
  beforeEach(() => {
    operations = [];
  });

  it('власник / адміністратор / бухгалтер: «Внести» і «Видати»', () => {
    render(<CashOperationsTab canOperate />);
    expect(screen.getByRole('button', { name: 'Внести' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Видати' })).toBeInTheDocument();
  });

  it('приймальня: «Внести» є, «Видати» немає', () => {
    render(<CashOperationsTab receptionist />);
    expect(screen.getByRole('button', { name: 'Внести' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Видати' })).not.toBeInTheDocument();
  });

  it('роль без операцій: жодної кнопки', () => {
    render(<CashOperationsTab />);
    expect(screen.queryByRole('button', { name: 'Внести' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Видати' })).not.toBeInTheDocument();
  });

  it('приймальня у картці внесення має лише «Оплату контрагента»', async () => {
    render(<CashOperationsTab receptionist />);
    fireEvent.click(screen.getByRole('button', { name: 'Внести' }));
    const reason = (await screen.findByLabelText(/^Привід/)) as HTMLSelectElement;
    expect(Array.from(reason.options).map(o => o.textContent)).toEqual(['Оплата контрагента']);
  });
});
