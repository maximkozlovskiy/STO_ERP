// Пошук і відбір за датою на «Оплатах клієнтів» (рішення власника 2026-10-09).
//
//   - рядок фільтрів — за еталоном «Купівлі»: пошук, «З», «По» в один рядок БЕЗ підписів над
//     полями; способи оплати й фіскальний статус лишаються в тому ж рядку;
//   - дати за замовчуванням порожні;
//   - пошук іде у фільтр хука лише після debounce; порожні значення не надсилаються;
//   - зміна пошуку чи дати повертає на першу сторінку.
//
// Mutation-verify: прибрати `q` з `filters` або `setPage(1)` з resetPageAnd → кейс падає.

import { render, screen, fireEvent, act } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/auth', () => ({ useRequireAuth: () => undefined }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/lib/api-client', () => ({ apiFetch: () => Promise.resolve([]) }));
vi.mock('@/hooks/api/useCash', () => ({
  useBaseCurrency: () => ({ data: { code: 'UAH', symbol: '₴' } }),
}));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/components/ui/date-picker-input', () => ({
  DatePickerInput: (p: {
    value: string;
    onChange: (v: string) => void;
    label?: string;
    min?: string;
    max?: string;
  }) => (
    <input
      data-testid="date"
      value={p.value}
      data-label={p.label ?? ''}
      data-min={p.min ?? ''}
      data-max={p.max ?? ''}
      onChange={e => p.onChange(e.target.value)}
    />
  ),
}));

const usePaymentsMock = vi.fn();
vi.mock('@/hooks/api/usePayments', () => ({
  usePayments: (...a: unknown[]) => usePaymentsMock(...a),
  useRetryFiscal: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

import PaymentsPage from '../page';

const SEARCH = 'Пошук за клієнтом, рахунком, нарядом…';
const lastFilter = () => usePaymentsMock.mock.lastCall![0] as Record<string, unknown>;
const typeSearch = (value: string) =>
  fireEvent.change(screen.getByPlaceholderText(SEARCH), { target: { value } });
const debounce = () => act(() => void vi.advanceTimersByTime(300));
const dates = () => screen.getAllByTestId('date') as HTMLInputElement[];

const payment = (id: string) => ({
  id,
  counterpartyId: 'c1',
  counterpartyName: `Клієнт ${id}`,
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
});

describe('PaymentsPage — пошук і дати', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    usePaymentsMock.mockReset();
    // 3 сторінки по 20 — пагінація рендериться лише над непорожнім списком.
    usePaymentsMock.mockReturnValue({
      data: { items: [payment('p1')], total: 60, page: 1, limit: 20 },
      isLoading: false,
    });
  });
  afterEach(() => vi.useRealTimers());

  it('за замовчуванням дати порожні й у запит не йдуть — як і пошук', () => {
    render(<PaymentsPage />);
    expect(dates().map(d => d.value)).toEqual(['', '']);
    const f = lastFilter();
    expect(f.q).toBeUndefined();
    expect(f.dateFrom).toBeUndefined();
    expect(f.dateTo).toBeUndefined();
  });

  it('пошук іде у фільтр хука лише після debounce, обрізаний від пробілів', () => {
    render(<PaymentsPage />);
    typeSearch(' Петренко ');
    expect(lastFilter().q).toBeUndefined();
    debounce();
    expect(lastFilter().q).toBe('Петренко');
  });

  it('дати «З» і «По» йдуть у фільтр і взаємно обмежують одна одну', () => {
    render(<PaymentsPage />);
    fireEvent.change(dates()[0]!, { target: { value: '2026-09-01' } });
    fireEvent.change(dates()[1]!, { target: { value: '2026-09-30' } });
    expect(lastFilter()).toEqual(
      expect.objectContaining({ dateFrom: '2026-09-01', dateTo: '2026-09-30' }),
    );
    expect(dates()[0]!.dataset.max).toBe('2026-09-30');
    expect(dates()[1]!.dataset.min).toBe('2026-09-01');
  });

  it.each([
    ['пошуку', () => typeSearch('а')],
    ['дати «З»', () => fireEvent.change(dates()[0]!, { target: { value: '2026-09-01' } })],
    ['дати «По»', () => fireEvent.change(dates()[1]!, { target: { value: '2026-09-30' } })],
  ])('зміна %s повертає на першу сторінку', (_name, change) => {
    render(<PaymentsPage />);
    fireEvent.click(screen.getByRole('button', { name: '2' }));
    expect(lastFilter().page).toBe(2);
    change();
    expect(lastFilter().page).toBe(1);
  });

  it('рядок фільтрів за еталоном: пошук · З · По без підписів над полями, далі метод і фіскальний статус', () => {
    render(<PaymentsPage />);
    const search = screen.getByPlaceholderText(SEARCH);
    const row = search.closest('div.flex-wrap')!;
    const [from, to] = dates();
    const method = screen.getByLabelText('Метод');
    const fiscal = screen.getByLabelText('Фіскальний статус');

    for (const el of [from!, to!, method, fiscal]) expect(row.contains(el)).toBe(true);
    const order = [search, from!, to!, method, fiscal];
    for (let i = 0; i < order.length - 1; i++) {
      expect(
        order[i]!.compareDocumentPosition(order[i + 1]!) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
    // Підпис дати — у рядок («З», «По»), а не `label` над полем.
    expect(dates().map(d => d.dataset.label)).toEqual(['', '']);
    expect(row).toHaveClass('items-center');
    expect(row).toHaveTextContent('З');
    expect(row).toHaveTextContent('По');
  });

  // Bug #816: довший за 100 символів `q` бекенд або відхиляє (400), або мовчки обрізає — поле
  // не дає ввести більше, ніж буде знайдено.
  it('поле пошуку обмежене 100 символами — межа бекенду', () => {
    render(<PaymentsPage />);
    expect(screen.getByPlaceholderText(SEARCH)).toHaveAttribute('maxlength', '100');
  });
});
