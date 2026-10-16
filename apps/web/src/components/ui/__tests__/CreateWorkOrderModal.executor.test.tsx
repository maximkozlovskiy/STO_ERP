import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import { CreateWorkOrderModal } from '../CreateWorkOrderModal';

/**
 * Картка наряду і довідники, які вона читає (рішення власника 2026-10-16, друге):
 *  - BR-WO-018: «Виконавець» рядка роботи пропонує лише активних механіків; збережений виконавець
 *    поза цим списком (адмін, звільнений) показується своїм ім'ям — у рядку і недоступною опцією з
 *    поясненням у режимі редагування, — а не «— Механік —»;
 *  - приймальня отримує звужені налаштування організації (7 полів картки) і рахує ПДВ організації;
 *  - договір механік отримує лише як id, номер і тип — опція договору з них і складається.
 */

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

let role = 'OWNER';
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ employee: { role } }),
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

// Повна відповідь `GET /employees?role=MECHANIC` для адміна: активний, у відпустці, звільнений,
// видалений механік і (з кешу старішої сторінки) власник.
const EMPLOYEES = [
  { id: 'm-active', firstName: 'Іван', lastName: 'Петров', role: 'MECHANIC', status: 'ACTIVE' },
  { id: 'm-leave', firstName: 'Олег', lastName: 'Відпустка', role: 'MECHANIC', status: 'ON_LEAVE' },
  { id: 'm-fired', firstName: 'Петро', lastName: 'Звільнений', role: 'MECHANIC', status: 'FIRED' },
  {
    id: 'm-deleted',
    firstName: 'Ганна',
    lastName: 'Видалена',
    role: 'MECHANIC',
    status: 'ACTIVE',
    deletedAt: '2026-05-01T00:00:00.000Z',
  },
  { id: 'owner-1', firstName: 'Марія', lastName: 'Власниця', role: 'OWNER', status: 'ACTIVE' },
];

// Звужена відповідь `GET /settings/organisation` для приймальні й механіка — рівно 7 полів картки.
const CARD_SETTINGS = {
  currency: 'UAH',
  vatMode: 'EXCLUSIVE',
  defaultVatRateId: 'r20',
  language: 'uk',
  recalcPlannedHoursFromLines: true,
  recalcActualHoursFromLines: true,
  syncCalendarSlotWithPlannedHours: true,
};

function mockApi(opts: {
  lines: { employeeId: string; employeeName?: string }[];
  employees?: Record<string, unknown>[];
  organisation?: Record<string, unknown> | 'forbidden';
  contracts?: Record<string, unknown>[];
  /** APPROVED — шапку й рядки можна редагувати; IN_PROGRESS — лише фактичні години. */
  status?: string;
}) {
  apiFetchMock.mockImplementation((path: string) => {
    if (path === '/branches') return Promise.resolve([{ id: 'b1', name: 'Філія №1' }]);
    if (path === '/warehouses') return Promise.resolve([{ id: 'w1', name: 'Склад №1' }]);
    if (path.startsWith('/employees'))
      return Promise.resolve({ items: opts.employees ?? EMPLOYEES });
    if (path.startsWith('/vehicles')) return Promise.resolve([]);
    if (path.includes('/contracts')) return Promise.resolve(opts.contracts ?? []);
    if (path === '/settings/organisation') {
      if (opts.organisation === 'forbidden') return Promise.reject(new Error('Недостатньо прав'));
      return Promise.resolve(opts.organisation ?? CARD_SETTINGS);
    }
    if (path === '/settings/tax-rates')
      return Promise.resolve([{ id: 'r20', rate: 20, isDefault: true, isActive: true }]);
    if (path === '/work-orders/wo-1/linked-documents') {
      return Promise.resolve({ invoices: [], payments: [], calendarSlots: [], warranties: [] });
    }
    if (path === '/work-orders/wo-1?withDeleted=true') {
      return Promise.resolve({
        id: 'wo-1',
        number: 'WO-001',
        status: opts.status ?? 'APPROVED',
        branchId: 'b1',
        vehicleId: 'v1',
        counterpartyId: 'cp1',
        counterpartyName: 'Тест',
        contractId: null,
        liftId: null,
        description: '',
        priority: 'NORMAL',
        repairCategory: '',
        documentDate: '2026-10-08',
        plannedAt: null,
        dueDate: null,
        plannedHours: 2,
        actualHours: null,
        lines: opts.lines.map((l, i) => ({
          id: `l${i + 1}`,
          workId: `work-${i + 1}`,
          workName: `Робота ${i + 1}`,
          employeeId: l.employeeId,
          employeeName: l.employeeName,
          normoHours: 2,
          actualHours: null,
          price: 500,
        })),
        parts: [],
      });
    }
    return Promise.resolve({ items: [] });
  });
}

const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

async function openModal() {
  render(<CreateWorkOrderModal open onClose={vi.fn()} workOrderId="wo-1" />);
  await screen.findByText('Робота 1');
  await waitFor(() =>
    expect(apiFetchMock).toHaveBeenCalledWith('/employees?limit=200&role=MECHANIC'),
  );
}

const lineRow = (name: string) => screen.getByText(name).closest('tr') as HTMLTableRowElement;

async function editLine(name: string) {
  fireEvent.click(within(lineRow(name)).getByRole('button', { name: 'Редагувати роботу' }));
  return (await screen.findByRole('combobox', { name: 'Виконавець' })) as HTMLSelectElement;
}

const optionTexts = (select: HTMLSelectElement) =>
  Array.from(select.options).map(o => norm(o.textContent));

describe('CreateWorkOrderModal — виконавець поза списком активних механіків (BR-WO-018)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    role = 'OWNER';
  });

  // guards: BR-WO-018
  it.each([
    ['адмін (не механік)', 'admin-1', 'Адмін Олег'],
    ['звільнений механік', 'm-fired', 'Звільнений Петро'],
    ['механік у відпустці', 'm-leave', 'Відпустка Олег'],
  ])('%s: у рядку — його ім’я з наряду, а не «—»', async (_label, employeeId, employeeName) => {
    mockApi({ lines: [{ employeeId, employeeName }] });
    await openModal();

    await waitFor(() => expect(norm(lineRow('Робота 1').textContent)).toContain(employeeName));
  });

  // guards: BR-WO-018
  it('редагування: збережений адмін — недоступна обрана опція з ім’ям і поясненням', async () => {
    mockApi({ lines: [{ employeeId: 'admin-1', employeeName: 'Адмін Олег' }] });
    await openModal();

    const select = await editLine('Робота 1');

    expect(select.value).toBe('admin-1');
    const saved = Array.from(select.options).find(o => o.value === 'admin-1');
    expect(norm(saved?.textContent)).toBe('Адмін Олег (недоступний)');
    expect(saved?.disabled).toBe(true);
    expect(norm(select.selectedOptions[0]?.textContent)).toBe('Адмін Олег (недоступний)');
    expect(
      screen.getByText(
        'Не активний механік (не механік, звільнений чи у відпустці) — оберіть іншого',
      ),
    ).toBeTruthy();
  });

  // guards: BR-WO-018
  it('обрати заново можна лише активних механіків: без відпустки, звільнених, видалених і власника', async () => {
    mockApi({ lines: [{ employeeId: 'admin-1', employeeName: 'Адмін Олег' }] });
    await openModal();

    const select = await editLine('Робота 1');
    const choosable = Array.from(select.options)
      .filter(o => o.value && !o.disabled)
      .map(o => o.value);

    expect(choosable).toEqual(['m-active']);
  });

  // guards: BR-WO-018
  it('обрано активного механіка → недоступна опція зникає, пояснення теж', async () => {
    mockApi({ lines: [{ employeeId: 'admin-1', employeeName: 'Адмін Олег' }] });
    await openModal();

    const select = await editLine('Робота 1');
    fireEvent.change(select, { target: { value: 'm-active' } });

    await waitFor(() => expect(select.value).toBe('m-active'));
    expect(Array.from(select.options).some(o => o.value === 'admin-1')).toBe(false);
    expect(
      screen.queryByText(
        'Не активний механік (не механік, звільнений чи у відпустці) — оберіть іншого',
      ),
    ).toBeNull();
  });

  // guards: BR-WO-018
  it('виконавець — активний механік: звичайна опція, без пояснення', async () => {
    mockApi({ lines: [{ employeeId: 'm-active', employeeName: 'Петров Іван' }] });
    await openModal();

    const select = await editLine('Робота 1');

    expect(select.value).toBe('m-active');
    expect(optionTexts(select).some(t => t.includes('(недоступний)'))).toBe(false);
  });

  // guards: BR-WO-018
  it('новий рядок: «— Механік —» і лише активні механіки, без недоступної опції', async () => {
    mockApi({ lines: [{ employeeId: 'admin-1', employeeName: 'Адмін Олег' }] });
    await openModal();

    // Перша «Додати» — у таблиці робіт (друга — у запчастинах).
    fireEvent.click(screen.getAllByRole('button', { name: 'Додати' })[0]);
    const select = (await screen.findByRole('combobox', {
      name: 'Виконавець',
    })) as HTMLSelectElement;

    expect(select.value).toBe('');
    expect(optionTexts(select)).toEqual(['— Механік —', 'Петров Іван']);
  });

  // guards: BR-WO-018
  it('механік (звужена відповідь без role/status): список — як прийшов, збережений адмін — недоступна опція', async () => {
    role = 'MECHANIC';
    mockApi({
      lines: [{ employeeId: 'admin-1', employeeName: 'Адмін Олег' }],
      employees: [{ id: 'm-active', firstName: 'Іван', lastName: 'Петров' }],
      status: 'IN_PROGRESS',
    });
    await openModal();

    await waitFor(() => expect(norm(lineRow('Робота 1').textContent)).toContain('Адмін Олег'));
    // Механік лише вводить фактичні години: поле виконавця недоступне, але ім'я — на місці.
    const select = await editLine('Робота 1');
    expect(select.disabled).toBe(true);
    expect(norm(select.selectedOptions[0]?.textContent)).toBe('Адмін Олег (недоступний)');
  });
});

describe('CreateWorkOrderModal — довідники картки за звуженими відповідями (рішення 2026-10-16)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    role = 'RECEPTIONIST';
  });

  const row = (testId: string) => norm(screen.getByTestId(testId).textContent);

  it('приймальня: звужені налаштування (7 полів картки) → ПДВ організації 20% зверху', async () => {
    mockApi({ lines: [{ employeeId: 'm-active', employeeName: 'Петров Іван' }] });
    await openModal();

    // Робота 2 × 500 = 1000; ПДВ 20% зверху = 200.
    await waitFor(() => expect(row('vat-totals-vat')).toBe('ПДВ200,00'));
    expect(row('vat-totals-gross')).toBe('Разом1 200,00');
  });

  it('контроль: без налаштувань (раніше 403 приймальні) картка рахує без ПДВ', async () => {
    mockApi({
      lines: [{ employeeId: 'm-active', employeeName: 'Петров Іван' }],
      organisation: 'forbidden',
    });
    await openModal();

    await waitFor(() => expect(row('vat-totals-gross')).toBe('Разом1 000,00'));
    expect(screen.queryByTestId('vat-totals-vat')).toBeNull();
  });

  it('договір зі звуженої відповіді механіка (id, номер, тип) — опція «номер — тип»', async () => {
    role = 'MECHANIC';
    mockApi({
      lines: [{ employeeId: 'm-active', employeeName: 'Петров Іван' }],
      contracts: [{ id: 'c-1', number: 'Д-1', contractType: 'SALE' }],
    });
    await openModal();

    const option = await screen.findByRole('option', { name: 'Д-1 — Продаж' });
    expect(option).toBeTruthy();
    expect(screen.queryByRole('option', { name: /undefined/ })).toBeNull();
  });
});
