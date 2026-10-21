import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithQueryClient } from '@/__tests__/query-utils';
import userEvent from '@testing-library/user-event';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import { CreateWorkOrderModal } from '../CreateWorkOrderModal';

// Mock apiFetch — modal calls /branches, /warehouses, /employees on mount.
const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

// LinkedDocumentsPanel «Документи» tab uses useLinkedNav()→useRouter; jsdom має no app router.
// Картка бере роль користувача (друк рахунку з наряду — лише ролям, яким дозволено рахунок).
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ employee: { role: 'OWNER' } }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/',
}));

// Mock ref-cache — return null so we always hit apiFetch path.
vi.mock('@/lib/ref-cache', () => ({
  getCached: () => null,
  setCache: vi.fn(),
}));

// Override only kyivToday for stable snapshot dates; all other format helpers use
// real implementations so DST/timezone logic stays under test.
vi.mock('@/lib/format', async () => ({
  ...(await vi.importActual<typeof import('@/lib/format')>('@/lib/format')),
  kyivToday: () => '2026-06-08',
}));

// useBaseCurrency (використовується CurrencySelect у модалці) читає org базову
// валюту через useQuery — стабимо, щоб не потрібен QueryClientProvider (мультивалюта Фаза 3).
vi.mock('@/hooks/api/useCash', () => ({
  useBaseCurrency: () => ({ data: { code: 'UAH', symbol: '₴' } }),
}));

const mockBranches = [{ id: 'b1', name: 'Філія №1' }];
const mockWarehouses = [{ id: 'w1', name: 'Склад №1' }];
const mockEmployees = [
  { id: 'e1', firstName: 'Іван', lastName: 'Петров' },
  { id: 'e2', firstName: 'Олена', lastName: 'Сидорова' },
];

describe('CreateWorkOrderModal — Escape у вікні вибору (Bug #923)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/branches') return Promise.resolve(mockBranches);
      if (path === '/warehouses') return Promise.resolve(mockWarehouses);
      if (path.startsWith('/employees')) return Promise.resolve({ items: mockEmployees });
      if (path.startsWith('/vehicles')) return Promise.resolve([]);
      if (path.includes('/contracts')) return Promise.resolve({ items: [] });
      return Promise.resolve({ items: [] });
    });
  });

  // Вікно «Оберіть клієнта» — вкладений Modal: його Escape доходив і до картки, яка закривалась з
  // усім введеним, а вікно вибору лишалось над сторінкою.
  it('Escape у «Оберіть клієнта» закриває лише вікно вибору — картка лишається', async () => {
    const onClose = vi.fn();
    renderWithQueryClient(<CreateWorkOrderModal open onClose={onClose} />);
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith('/branches'));
    const pick = screen.getAllByRole('button', { name: 'Обрати' })[0]!;
    await userEvent.click(pick);
    await screen.findByRole('dialog', { name: 'Оберіть клієнта' });

    await userEvent.keyboard('{Escape}');

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Оберіть клієнта' })).not.toBeInTheDocument(),
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Новий наряд' })).toBeInTheDocument();
  });
  // GOTCHAS 2026-10-12: у браузері React рендерить між слухачами того самого Escape, і картка
  // бачила вже закрите вікно вибору. Тепер Escape має один слухач (стек шарів): кожна подія закриває
  // рівно один шар — навіть два Escape підряд без пауз.
  it('два Escape підряд: перший закриває вікно вибору, другий — картку', async () => {
    const onClose = vi.fn();
    renderWithQueryClient(<CreateWorkOrderModal open onClose={onClose} />);
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith('/branches'));
    await userEvent.click(screen.getAllByRole('button', { name: 'Обрати' })[0]!);
    const picker = await screen.findByRole('dialog', { name: 'Оберіть клієнта' });

    act(() => {
      fireEvent.keyDown(document.body, { key: 'Escape' });
    });
    // Вікно вибору вже закрите (іде анімація виходу), картка — ні.
    expect(picker).toHaveAttribute('data-state', 'closed');
    await act(async () => {
      await Promise.resolve();
    });
    expect(onClose).not.toHaveBeenCalled();

    act(() => {
      fireEvent.keyDown(document.body, { key: 'Escape' });
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});
