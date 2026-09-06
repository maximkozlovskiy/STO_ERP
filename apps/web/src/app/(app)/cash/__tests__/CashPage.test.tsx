// Regression-guard для сторінки /cash (ПРРО Крок 2).
//
// Load-bearing поведінка UI:
//   - OPEN-зміна → статус «Зміна відкрита» + індикатор (bg-success) + кнопка «Закрити зміну».
//   - CLOSED (null shift) → «Зміну закрито» + індикатор (bg-muted) + кнопка «Відкрити зміну».
//   - pendingReceipts>0 → бейдж «Чеків очікує пробиття: N»; 0/undefined → без бейджа.
//   - клік «Відкрити» → useOpenShift.mutateAsync(branchId); помилка → показує error + не crash.
//   - клік «Закрити» → useCloseShift.mutateAsync(shift.id).

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, it, expect, describe, beforeEach } from 'vitest';

vi.mock('@/lib/auth', () => ({ useRequireAuth: () => undefined }));

vi.mock('@/lib/api-client', () => ({
  apiFetch: () => Promise.resolve([{ id: 'br-1', name: 'Філія 1' }]),
}));

vi.mock('@/lib/ref-cache', () => ({
  getCached: () => null,
  setCache: () => undefined,
}));

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/format', () => ({
  fmtDate: (v: string) => v,
}));

const useCurrentShiftMock = vi.fn();
const openMutateAsync = vi.fn().mockResolvedValue(undefined);
const closeMutateAsync = vi.fn().mockResolvedValue(undefined);
const openIsPending = { value: false };
vi.mock('@/hooks/api/useCashShift', () => ({
  useCurrentShift: (...a: unknown[]) => useCurrentShiftMock(...a),
  useOpenShift: () => ({ mutateAsync: openMutateAsync, isPending: openIsPending.value }),
  useCloseShift: () => ({ mutateAsync: closeMutateAsync, isPending: false }),
}));

import CashPage from '../page';

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

describe('CashPage — ПРРО Крок 2', () => {
  beforeEach(() => {
    useCurrentShiftMock.mockReset();
    openMutateAsync.mockClear();
    closeMutateAsync.mockClear();
    openIsPending.value = false;
  });

  it('OPEN-зміна → статус «відкрита» + кнопка «Закрити зміну (Z-звіт)»', async () => {
    useCurrentShiftMock.mockReturnValue({ data: openShiftData(), isLoading: false });
    render(<CashPage />);
    expect(await screen.findByText('Зміна відкрита')).toBeInTheDocument();
    expect(screen.getByText('Каса: Каса №1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Закрити зміну/ })).toBeInTheDocument();
    // Немає кнопки «Відкрити»
    expect(screen.queryByRole('button', { name: /Відкрити зміну/ })).not.toBeInTheDocument();
  });

  it('CLOSED (shift=null) → статус «закрито» + кнопка «Відкрити зміну»', async () => {
    useCurrentShiftMock.mockReturnValue({ data: null, isLoading: false });
    render(<CashPage />);
    expect(await screen.findByText('Зміну закрито')).toBeInTheDocument();
    // чекаємо доки selectedBranch виставиться з /branches → кнопка розблокується
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Відкрити зміну/ })).not.toBeDisabled(),
    );
    expect(screen.queryByRole('button', { name: /Закрити зміну/ })).not.toBeInTheDocument();
  });

  it('pendingReceipts>0 → бейдж «Чеків очікує пробиття: N»', async () => {
    useCurrentShiftMock.mockReturnValue({
      data: openShiftData({ pendingReceipts: 4 }),
      isLoading: false,
    });
    render(<CashPage />);
    expect(await screen.findByText(/Чеків очікує пробиття: 4/)).toBeInTheDocument();
  });

  it('pendingReceipts=0 → без бейджа', async () => {
    useCurrentShiftMock.mockReturnValue({
      data: openShiftData({ pendingReceipts: 0 }),
      isLoading: false,
    });
    render(<CashPage />);
    await screen.findByText('Зміна відкрита');
    expect(screen.queryByText(/Чеків очікує пробиття/)).not.toBeInTheDocument();
  });

  it('клік «Відкрити зміну» → useOpenShift.mutateAsync(branchId)', async () => {
    useCurrentShiftMock.mockReturnValue({ data: null, isLoading: false });
    const user = userEvent.setup();
    render(<CashPage />);
    const btn = await screen.findByRole('button', { name: /Відкрити зміну/ });
    await waitFor(() => expect(btn).not.toBeDisabled());
    await user.click(btn);
    await waitFor(() => expect(openMutateAsync).toHaveBeenCalledWith('br-1'));
  });

  it('клік «Закрити зміну» → useCloseShift.mutateAsync(shift.id)', async () => {
    useCurrentShiftMock.mockReturnValue({ data: openShiftData(), isLoading: false });
    const user = userEvent.setup();
    render(<CashPage />);
    const btn = await screen.findByRole('button', { name: /Закрити зміну/ });
    await user.click(btn);
    await waitFor(() => expect(closeMutateAsync).toHaveBeenCalledWith('shift-1'));
  });

  it('помилка відкриття → показує повідомлення, не crash', async () => {
    useCurrentShiftMock.mockReturnValue({ data: null, isLoading: false });
    openMutateAsync.mockRejectedValueOnce(new Error('ПРРО недоступний'));
    const user = userEvent.setup();
    render(<CashPage />);
    const btn = await screen.findByRole('button', { name: /Відкрити зміну/ });
    await waitFor(() => expect(btn).not.toBeDisabled());
    await user.click(btn);
    expect(await screen.findByText('ПРРО недоступний')).toBeInTheDocument();
  });
});
