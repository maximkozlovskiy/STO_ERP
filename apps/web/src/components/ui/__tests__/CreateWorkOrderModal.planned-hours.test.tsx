import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import { CreateWorkOrderModal } from '../CreateWorkOrderModal';

/**
 * BR-WORK-001 — `normoHours` роботи є базовою одиницею оцінки: планові нормо-години наряду
 * перераховуються з рядків робіт як max(поточне значення, Σ normoHours рядків), і лише коли
 * в організації увімкнено `recalcPlannedHoursFromLines`.
 *
 * Рахує це `calcPlannedHoursFromLines` у `CreateWorkOrderModal.tsx`. Функція НЕ експортується,
 * тому тут вона перевіряється через компонент: наряд відкривається в режимі редагування з
 * готовими рядками, один рядок видаляється — і поле «Нормогодин» мусить показати перерахунок.
 * Шлях «додати рядок» викликає ту саму функцію, але потребує SearchCombobox і тут не проходиться.
 */

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
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

vi.mock('@/lib/ref-cache', () => ({
  getCached: () => null,
  setCache: vi.fn(),
}));

vi.mock('@/hooks/api/useCash', () => ({
  useBaseCurrency: () => ({ data: { code: 'UAH', symbol: '₴' } }),
}));

type LineFixture = { id: string; workName: string; normoHours: number };

function mockApi(opts: { plannedHours: number | null; lines: LineFixture[]; recalc?: boolean }) {
  apiFetchMock.mockImplementation((path: string) => {
    if (path === '/branches') return Promise.resolve([{ id: 'b1', name: 'Філія №1' }]);
    if (path === '/warehouses') return Promise.resolve([{ id: 'w1', name: 'Склад №1' }]);
    if (path.startsWith('/employees')) {
      return Promise.resolve({ items: [{ id: 'e1', firstName: 'Іван', lastName: 'Петров' }] });
    }
    if (path.startsWith('/vehicles')) return Promise.resolve([]);
    if (path.includes('/contracts')) return Promise.resolve({ items: [] });
    if (path === '/settings/organisation') {
      return Promise.resolve(
        opts.recalc === undefined
          ? { vatMode: 'NONE' }
          : { vatMode: 'NONE', recalcPlannedHoursFromLines: opts.recalc },
      );
    }
    if (path === '/settings/tax-rates') return Promise.resolve([]);
    if (path === '/work-orders/wo-1/linked-documents') {
      return Promise.resolve({ invoices: [], payments: [], calendarSlots: [], warranties: [] });
    }
    if (path === '/work-orders/wo-1') {
      return Promise.resolve({
        id: 'wo-1',
        number: 'WO-001',
        status: 'DRAFT',
        branchId: 'b1',
        vehicleId: 'v1',
        counterpartyId: 'cp1',
        counterpartyName: 'Тест',
        contractId: null,
        liftId: null,
        description: '',
        priority: 'NORMAL',
        repairCategory: '',
        documentDate: '2026-06-14',
        plannedAt: null,
        dueDate: null,
        plannedHours: opts.plannedHours,
        actualHours: null,
        lines: opts.lines.map(l => ({
          id: l.id,
          workId: `work-${l.id}`,
          workName: l.workName,
          employeeId: 'e1',
          normoHours: l.normoHours,
          actualHours: null,
          price: 100,
        })),
        parts: [],
      });
    }
    return Promise.resolve({ items: [] });
  });
}

/** Поле «Нормогодин» у блоці ПЛАНОВИХ показників — перше з двох (друге — фактичні). */
function plannedHoursInput(): HTMLInputElement {
  const inputs = Array.from(
    document.querySelectorAll<HTMLInputElement>('input[type="number"][step="0.5"]'),
  );
  expect(inputs.length).toBe(2);
  return inputs[0]!;
}

async function openAndDeleteFirstLine(firstLineName: string) {
  const user = userEvent.setup();
  render(<CreateWorkOrderModal open onClose={vi.fn()} workOrderId="wo-1" />);
  await screen.findByText(firstLineName);
  // Налаштування org приходять окремим запитом — дочекатись, інакше прапорець ще дефолтний.
  await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith('/settings/organisation'));
  const deleteButtons = await screen.findAllByRole('button', { name: 'Видалити роботу' });
  await user.click(deleteButtons[0]!);
  await waitFor(() => expect(screen.queryByText(firstLineName)).not.toBeInTheDocument());
}

describe('CreateWorkOrderModal — планові нормо-години з рядків робіт', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  // guards: BR-WORK-001
  it('сума normoHours рядків більша за поточне значення → поле стає сумою', async () => {
    mockApi({
      plannedHours: 1,
      lines: [
        { id: 'l1', workName: 'Діагностика ходової', normoHours: 2 },
        { id: 'l2', workName: 'Заміна колодок', normoHours: 3 },
        { id: 'l3', workName: 'Заміна масла', normoHours: 1.5 },
      ],
    });
    await openAndDeleteFirstLine('Діагностика ходової');
    // Лишилось 3 + 1.5 = 4.5 > 1
    await waitFor(() => expect(plannedHoursInput().value).toBe('4.5'));
  });

  // guards: BR-WORK-001
  it('поточне значення більше за суму рядків → не зменшується', async () => {
    mockApi({
      plannedHours: 10,
      lines: [
        { id: 'l1', workName: 'Діагностика ходової', normoHours: 2 },
        { id: 'l2', workName: 'Заміна колодок', normoHours: 3 },
      ],
    });
    await openAndDeleteFirstLine('Діагностика ходової');
    expect(plannedHoursInput().value).toBe('10');
  });

  // guards: BR-WORK-001
  it('recalcPlannedHoursFromLines=false → рядки на планові години не впливають', async () => {
    mockApi({
      plannedHours: 1,
      recalc: false,
      lines: [
        { id: 'l1', workName: 'Діагностика ходової', normoHours: 2 },
        { id: 'l2', workName: 'Заміна колодок', normoHours: 3 },
      ],
    });
    await openAndDeleteFirstLine('Діагностика ходової');
    expect(plannedHoursInput().value).toBe('1');
  });
});
