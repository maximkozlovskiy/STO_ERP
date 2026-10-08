// Regression-guard для вкладки «Операції» сторінки /cash (ПРРО зміна на фіскальній касі).
//
// Load-bearing поведінка (перенесено з окремої сторінки у CashOperationsTab):
//   - Фіскальна каса + OPEN-зміна → «Зміна відкрита» + кнопка «Закрити зміну (Z-звіт)».
//   - Фіскальна каса + CLOSED (null) → «Зміну закрито» + кнопка «Відкрити зміну».
//   - pendingReceipts>0 → «Чеків очікує: N»; 0 → без бейджа.
//   - клік «Відкрити» → useOpenShift.mutateAsync(branchId); помилка → toast.error, не crash.
//   - клік «Закрити» → useCloseShift.mutateAsync(shift.id).

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, it, expect, describe, beforeEach } from 'vitest';

vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/format', () => ({
  fmtMoney: (v: number) => String(v),
  fmtDateTime: (v: string) => v,
  // Період операцій за замовчуванням — сьогодні (CashOperationsTab.filters.test.tsx).
  kyivToday: () => '2026-09-06',
}));

// Одна фіскальна каса — щоб рендерився блок зміни.
vi.mock('@/hooks/api/useCash', () => ({
  useCashRegisters: () => ({
    data: [
      {
        id: 'reg-1',
        name: 'Каса №1',
        branchId: 'br-1',
        currencyCode: 'UAH',
        currencySymbol: '₴',
        isFiscal: true,
        initialBalance: 0,
        balance: 0,
      },
    ],
    isLoading: false,
  }),
  useCashOperations: () => ({ data: [], isLoading: false }),
  useCreateCashOperation: () => ({ mutateAsync: vi.fn(), isPending: false }),
  // Базова валюта org (UAH) — вкладка порівнює код каси з базовим замість хардкоду 'UAH'.
  useBaseCurrency: () => ({ data: { code: 'UAH', symbol: '₴' } }),
  CASH_REASON_LABELS: {},
  MANUAL_IN_REASONS: ['MANUAL_IN'],
  MANUAL_OUT_REASONS: ['MANUAL_OUT'],
}));
const useExpenseCategoriesMock = vi.fn((_showDeleted?: boolean, _enabled?: boolean) => ({
  data: [] as unknown[],
}));
vi.mock('@/hooks/api/useExpenseCategories', () => ({
  useExpenseCategories: (showDeleted?: boolean, enabled?: boolean) =>
    useExpenseCategoriesMock(showDeleted, enabled),
  // Модалка операції сплощує дерево статей за типом — у тесті статей немає.
  flattenActiveByType: () => [],
}));

const useCurrentShiftMock = vi.fn();
const openMutateAsync = vi.fn().mockResolvedValue(undefined);
const closeMutateAsync = vi.fn().mockResolvedValue(undefined);
vi.mock('@/hooks/api/useCashShift', () => ({
  useCurrentShift: (...a: unknown[]) => useCurrentShiftMock(...a),
  useOpenShift: () => ({ mutateAsync: openMutateAsync, isPending: false }),
  useCloseShift: () => ({ mutateAsync: closeMutateAsync, isPending: false }),
}));

import CashOperationsTab from '../CashOperationsTab';
import { toast } from '@/lib/toast';

const openShiftData = (over: Record<string, unknown> = {}) => ({
  id: 'shift-1',
  status: 'OPEN',
  cashRegisterId: 'reg-1',
  cashRegisterName: 'Каса №1',
  checkboxShiftId: 'cbx-1',
  openedAt: '2026-09-06T08:00:00.000Z',
  closedAt: null,
  zReportId: null,
  pendingReceipts: 0,
  ...over,
});

describe('CashOperationsTab — ПРРО зміна (фіскальна каса)', () => {
  beforeEach(() => {
    useCurrentShiftMock.mockReset();
    openMutateAsync.mockClear();
    closeMutateAsync.mockClear();
    useExpenseCategoriesMock.mockClear();
    (toast.error as ReturnType<typeof vi.fn>).mockClear();
  });

  // Bug #729: GET /expense-categories вимагає ACCOUNTANT+ (backend @Roles). RECEPTIONIST бачить вкладку
  // «Операції» лише для перегляду (canOperate=false) → запит статей витрат мусить бути ВИМКНЕНИЙ (enabled=false),
  // інакше кожен перегляд каси реєстратором фаєрив би 403 (двічі через retry:1).
  it('canOperate=false → useExpenseCategories вимкнено (enabled=false) — без 403 у RECEPTIONIST', async () => {
    useCurrentShiftMock.mockReturnValue({ data: null, isLoading: false });
    render(<CashOperationsTab canOperate={false} />);
    await screen.findByText(/Зміну закрито/);
    expect(useExpenseCategoriesMock).toHaveBeenCalledWith(false, false);
  });

  it('canOperate=true → useExpenseCategories увімкнено (enabled=true)', async () => {
    useCurrentShiftMock.mockReturnValue({ data: null, isLoading: false });
    render(<CashOperationsTab canOperate />);
    await screen.findByText(/Зміну закрито/);
    expect(useExpenseCategoriesMock).toHaveBeenCalledWith(false, true);
  });

  it('OPEN-зміна → «Зміна відкрита» + кнопка «Закрити зміну (Z-звіт)»', async () => {
    useCurrentShiftMock.mockReturnValue({ data: openShiftData(), isLoading: false });
    render(<CashOperationsTab />);
    expect(await screen.findByText('Зміна відкрита')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Закрити зміну/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Відкрити зміну/ })).not.toBeInTheDocument();
  });

  it('CLOSED (shift=null) → «Зміну закрито» + кнопка «Відкрити зміну»', async () => {
    useCurrentShiftMock.mockReturnValue({ data: null, isLoading: false });
    render(<CashOperationsTab />);
    expect(await screen.findByText(/Зміну закрито/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Відкрити зміну/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Закрити зміну/ })).not.toBeInTheDocument();
  });

  it('pendingReceipts>0 → «Чеків очікує: N»', async () => {
    useCurrentShiftMock.mockReturnValue({
      data: openShiftData({ pendingReceipts: 4 }),
      isLoading: false,
    });
    render(<CashOperationsTab />);
    expect(await screen.findByText(/Чеків очікує: 4/)).toBeInTheDocument();
  });

  it('pendingReceipts=0 → без бейджа', async () => {
    useCurrentShiftMock.mockReturnValue({
      data: openShiftData({ pendingReceipts: 0 }),
      isLoading: false,
    });
    render(<CashOperationsTab />);
    await screen.findByText('Зміна відкрита');
    expect(screen.queryByText(/Чеків очікує/)).not.toBeInTheDocument();
  });

  it('клік «Відкрити зміну» → useOpenShift.mutateAsync(branchId)', async () => {
    useCurrentShiftMock.mockReturnValue({ data: null, isLoading: false });
    const user = userEvent.setup();
    render(<CashOperationsTab />);
    const btn = await screen.findByRole('button', { name: /Відкрити зміну/ });
    await user.click(btn);
    await waitFor(() => expect(openMutateAsync).toHaveBeenCalledWith('br-1'));
  });

  it('клік «Закрити зміну» → useCloseShift.mutateAsync(shift.id)', async () => {
    useCurrentShiftMock.mockReturnValue({ data: openShiftData(), isLoading: false });
    const user = userEvent.setup();
    render(<CashOperationsTab />);
    const btn = await screen.findByRole('button', { name: /Закрити зміну/ });
    await user.click(btn);
    await waitFor(() => expect(closeMutateAsync).toHaveBeenCalledWith('shift-1'));
  });

  it('помилка відкриття → toast.error, не crash', async () => {
    useCurrentShiftMock.mockReturnValue({ data: null, isLoading: false });
    openMutateAsync.mockRejectedValueOnce(new Error('ПРРО недоступний'));
    const user = userEvent.setup();
    render(<CashOperationsTab />);
    const btn = await screen.findByRole('button', { name: /Відкрити зміну/ });
    await user.click(btn);
    await waitFor(() =>
      expect(toast.error as ReturnType<typeof vi.fn>).toHaveBeenCalledWith('ПРРО недоступний'),
    );
  });
});
