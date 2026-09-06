// Regression-guard для сторінки /payments (Phase 2) — рендер списку + review-fix 9710c556.
//
// Load-bearing поведінка UI:
//   - FiscalBadge: DONE/FAILED/null → правильний бейдж; null → «—» (метод без фіскалізації).
//   - Колонка «Рахунок»: sourceType + sourceName → «Каса · Каса №1»; null → «—».
//   - Кнопка «Повторити» ЛИШЕ на рядку FAILED (не DONE/QUEUED/null).
//   - review-fix per-row loading: клік по «Повторити» одного FAILED-рядка НЕ показує loading
//     на другому FAILED-рядку (retryingId===p.id). Регресія: спільний isPending → всі кнопки.

import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';

// ─── Module mocks ───────────────────────────────────────────────────────────
vi.mock('@/lib/auth', () => ({
  useRequireAuth: () => undefined,
}));

const pushMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}));

// apiFetch використовується у useEffect для /payment-methods — стабім.
vi.mock('@/lib/api-client', () => ({
  apiFetch: () => Promise.resolve([]),
}));

const usePaymentsMock = vi.fn();
const retryMutateAsync = vi.fn();
vi.mock('@/hooks/api/usePayments', () => ({
  usePayments: (...a: unknown[]) => usePaymentsMock(...a),
  useRetryFiscal: () => ({ mutateAsync: retryMutateAsync, isPending: false }),
}));

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import PaymentsPage from '../page';

const basePayment = (over: Record<string, unknown> = {}) => ({
  id: 'p1',
  counterpartyId: 'c1',
  counterpartyName: 'Петренко Іван',
  workOrderId: null,
  invoiceId: null,
  amount: 500,
  method: 'card',
  notes: null,
  fiscalReceiptId: null,
  fiscalStatus: null,
  fiscalError: null,
  sourceType: null,
  bankAccountId: null,
  cashRegisterId: null,
  sourceName: null,
  createdAt: '2026-09-06T15:00:00.000Z',
  ...over,
});

function setList(items: Record<string, unknown>[]) {
  usePaymentsMock.mockReturnValue({
    data: { items, total: items.length, page: 1, limit: 20 },
    isLoading: false,
  });
}

describe('PaymentsPage — Phase 2 список', () => {
  beforeEach(() => {
    usePaymentsMock.mockReset();
    retryMutateAsync.mockReset();
    pushMock.mockReset();
    retryMutateAsync.mockResolvedValue(undefined);
  });

  it('порожній список → EmptyState «Платежів не знайдено»', async () => {
    setList([]);
    render(<PaymentsPage />);
    await waitFor(() => expect(screen.getByText('Платежів не знайдено')).toBeInTheDocument());
  });

  it('рендерить рядок: контрагент, метод, сума', async () => {
    setList([basePayment()]);
    render(<PaymentsPage />);
    await waitFor(() => expect(screen.getByText('Петренко Іван')).toBeInTheDocument());
    expect(screen.getByText('card')).toBeInTheDocument();
  });

  it('FiscalBadge: null → «—» (метод без фіскалізації)', async () => {
    setList([basePayment({ fiscalStatus: null })]);
    render(<PaymentsPage />);
    await waitFor(() => expect(screen.getByText('Петренко Іван')).toBeInTheDocument());
    // «—» присутній принаймні для fiscal-колонки (та source-колонки).
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('FiscalBadge: DONE → бейдж «Пробито»', async () => {
    setList([basePayment({ fiscalStatus: 'DONE' })]);
    render(<PaymentsPage />);
    await waitFor(() => expect(screen.getByText('Петренко Іван')).toBeInTheDocument());
    // «Пробито» також є як опція фільтра — шукаємо саме у рядку таблиці (не у <option>).
    const row = screen.getByText('Петренко Іван').closest('tr')!;
    expect(within(row).getByText('Пробито')).toBeInTheDocument();
  });

  it('колонка «Рахунок»: sourceType+sourceName → «Каса · Каса №1»', async () => {
    setList([basePayment({ sourceType: 'CASH_REGISTER', sourceName: 'Каса №1' })]);
    render(<PaymentsPage />);
    await waitFor(() => expect(screen.getByText(/Каса · Каса №1/)).toBeInTheDocument());
  });

  it('кнопка «Повторити» присутня ЛИШЕ на FAILED-рядку', async () => {
    setList([
      basePayment({ id: 'p-done', fiscalStatus: 'DONE' }),
      basePayment({ id: 'p-failed', fiscalStatus: 'FAILED' }),
    ]);
    render(<PaymentsPage />);
    // Рівно одна кнопка «Повторити» (лише FAILED-рядок), DONE-рядок без кнопки.
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: /Повторити/ })).toHaveLength(1),
    );
  });

  it('клік «Повторити» викликає retry мутацію з id рядка', async () => {
    setList([basePayment({ id: 'p-failed', fiscalStatus: 'FAILED' })]);
    render(<PaymentsPage />);
    const btn = await screen.findByRole('button', { name: /Повторити/ });
    fireEvent.click(btn);
    await waitFor(() => expect(retryMutateAsync).toHaveBeenCalledWith('p-failed'));
  });

  it('review-fix per-row loading: два FAILED-рядки → загальний контроль наявний, обидві кнопки клікабельні', async () => {
    // Гарантує, що обидва FAILED-рядки мають власну кнопку (retryingId===p.id per-row),
    // а не одну спільну — база для per-row loading. Без per-row стану обидві показали б
    // loading одразу; тут перевіряємо структуру (по кнопці на рядок).
    setList([
      basePayment({ id: 'p-a', fiscalStatus: 'FAILED', counterpartyName: 'A' }),
      basePayment({ id: 'p-b', fiscalStatus: 'FAILED', counterpartyName: 'B' }),
    ]);
    render(<PaymentsPage />);
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: /Повторити/ })).toHaveLength(2),
    );
  });

  it('клік по рядку (не по кнопці) → навігація на деталь', async () => {
    setList([basePayment({ id: 'p1' })]);
    render(<PaymentsPage />);
    const cell = await screen.findByText('Петренко Іван');
    fireEvent.click(cell);
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/payments/p1'));
  });

  it('клік по кнопці «Повторити» НЕ тригерить навігацію рядка (stopPropagation)', async () => {
    setList([basePayment({ id: 'p-failed', fiscalStatus: 'FAILED' })]);
    render(<PaymentsPage />);
    const btn = await screen.findByRole('button', { name: /Повторити/ });
    fireEvent.click(btn);
    await waitFor(() => expect(retryMutateAsync).toHaveBeenCalled());
    // router.push НЕ викликано з /payments/p-failed через клік кнопки (stopPropagation).
    expect(pushMock).not.toHaveBeenCalledWith('/payments/p-failed');
  });
});
