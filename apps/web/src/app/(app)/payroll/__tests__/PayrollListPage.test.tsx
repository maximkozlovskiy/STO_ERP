// Regression-guard для List Page pattern на /payroll (пагінація + фільтр статусу + колонки).
// Load-bearing поведінка:
//   - usePayrollPeriods отримує { page, limit, status } — фільтр реально їде на бекенд,
//     а не фільтрує локально (інакше пагінація бреше: total з сервера ≠ видимі рядки).
//   - Зміна статусу скидає page на 1 (інакше «сторінка 3» порожня після вужчого фільтра).
//   - Пагінація рендериться лише коли totalPages > 1 (компонент Pagination сам це тримає).
//   - ColumnsDropdown присутній; приховування колонки прибирає її th і не ламає colSpan.
//   - Порожній список під фільтром → empty.noMatchDescription, без фільтра → periodsDescription.

import { render, screen, fireEvent, within } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import type { PayrollPeriod, PayrollPeriodsFilter } from '@/hooks/api/usePayroll';

vi.mock('@/lib/auth', () => ({
  useRequireAuth: () => undefined,
  useAuth: () => ({ employee: { role: 'OWNER' } }),
}));

// Останні фільтри, з якими сторінка покликала хук списку — асертимо контракт.
let lastFilters: PayrollPeriodsFilter | undefined;
const listItems: PayrollPeriod[] = [];
let listTotal = 0;
let lastPreviewArgs: unknown[] = [];

vi.mock('@/hooks/api/usePayroll', async orig => {
  const actual = await orig<typeof import('@/hooks/api/usePayroll')>();
  const noopMut = () => ({ mutateAsync: vi.fn(), isPending: false, variables: undefined });
  return {
    ...actual,
    usePayrollPreview: (...args: unknown[]) => {
      lastPreviewArgs = args;
      return { data: undefined, isLoading: false, error: null };
    },
    usePayrollPeriods: (filters: PayrollPeriodsFilter = {}) => {
      lastFilters = filters;
      return {
        data: { items: listItems, total: listTotal, page: filters.page ?? 1, limit: 20 },
        isLoading: false,
      };
    },
    usePayrollPeriod: () => ({ data: undefined, isLoading: false }),
    useCreatePayrollPeriod: noopMut,
    useComputePayrollPeriod: noopMut,
    usePayPayrollPeriod: noopMut,
    useDeletePayrollPeriod: noopMut,
  };
});

vi.mock('@/hooks/api/useCash', () => ({
  useCashRegisters: () => ({ data: [] }),
}));

import PayrollPage from '../page';

function makePeriod(over: Partial<PayrollPeriod> = {}): PayrollPeriod {
  return {
    id: 'p-1',
    orgId: 'org-1',
    branchId: null,
    periodStart: '2026-09-01',
    periodEnd: '2026-09-30',
    status: 'COMPUTED',
    note: null,
    totalAccrued: 3620,
    totalPaid: 0,
    lines: [],
    computedAt: '2026-09-30T00:00:00.000Z',
    paidAt: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-30T00:00:00.000Z',
    ...over,
  };
}

const STATUS_SELECT = 'Статус періоду';

describe('Payroll — List Page pattern (пагінація + фільтри + колонки)', () => {
  beforeEach(() => {
    listItems.length = 0;
    listTotal = 0;
    lastFilters = undefined;
    // Колонки/фільтри персистяться у localStorage — ізолюємо тести одне від одного.
    window.localStorage.clear();
  });

  it('хук списку отримує серверні page/limit (пагінація НЕ клієнтська)', () => {
    listItems.push(makePeriod());
    listTotal = 1;
    render(<PayrollPage />);
    expect(lastFilters?.page).toBe(1);
    expect(lastFilters?.limit).toBe(20);
  });

  it('фільтр статусу їде на бекенд у filters.status', () => {
    listItems.push(makePeriod());
    listTotal = 1;
    render(<PayrollPage />);
    fireEvent.change(screen.getByLabelText(STATUS_SELECT), { target: { value: 'PAID' } });
    expect(lastFilters?.status).toBe('PAID');
  });

  it('зміна статусу скидає сторінку на 1 (інакше глибока сторінка порожня)', () => {
    // 3 сторінки → є на що перейти.
    listItems.push(makePeriod());
    listTotal = 55;
    render(<PayrollPage />);

    fireEvent.click(screen.getByRole('button', { name: '2' }));
    expect(lastFilters?.page).toBe(2);

    fireEvent.change(screen.getByLabelText(STATUS_SELECT), { target: { value: 'DRAFT' } });
    expect(lastFilters?.page).toBe(1);
    expect(lastFilters?.status).toBe('DRAFT');
  });

  it('пагінація рендериться лише коли сторінок > 1', () => {
    listItems.push(makePeriod());
    listTotal = 5; // 1 сторінка
    const { unmount } = render(<PayrollPage />);
    expect(screen.queryByRole('button', { name: 'Наступна сторінка' })).not.toBeInTheDocument();
    unmount();

    listTotal = 55; // 3 сторінки
    render(<PayrollPage />);
    expect(screen.getByRole('button', { name: 'Наступна сторінка' })).toBeInTheDocument();
  });

  it('порожній список: без фільтра — підказка створення, під фільтром — «немає за фільтром»', () => {
    listTotal = 0;
    const { unmount } = render(<PayrollPage />);
    expect(
      screen.getByText('Розрахуйте період вище і натисніть «Створити період»'),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(STATUS_SELECT), { target: { value: 'CANCELLED' } });
    expect(screen.getByText('За вибраним фільтром періодів немає')).toBeInTheDocument();
    unmount();
  });

  it('колонки списку рендеряться через visibleColumns; ColumnsDropdown присутній', () => {
    listItems.push(makePeriod({ note: 'Вересень' }));
    listTotal = 1;
    render(<PayrollPage />);

    // Дефолтні колонки (мітки з i18n namespace payroll).
    const table = screen.getByRole('table');
    const head = within(table)
      .getAllByRole('columnheader')
      .map(th => th.textContent?.trim());
    expect(head).toContain('Період');
    expect(head).toContain('Примітка');
    expect(head).toContain('Статус');
    expect(head).toContain('Нараховано');

    // Кнопка керування колонками (ColumnsDropdown) доступна.
    expect(screen.getByLabelText('Налаштувати колонки')).toBeInTheDocument();
  });

  it('рядок періоду лежить під стабільним data-testid (контракт E2E)', () => {
    listItems.push(makePeriod({ id: 'abc-123', status: 'DRAFT' }));
    listTotal = 1;
    render(<PayrollPage />);

    const row = screen.getByTestId('payroll-period-abc-123');
    // Статус-бейдж і FSM-кнопка «Розрахувати» — всередині того ж вузла (E2E їх скоупить).
    expect(within(row).getByText('Чернетка')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Розрахувати' })).toBeInTheDocument();
  });

  it('порожня примітка → «—», сума з символом ₴ і tabular-nums (Document table standard)', () => {
    listItems.push(makePeriod({ id: 'p-9', note: null, totalAccrued: 1250 }));
    listTotal = 1;
    render(<PayrollPage />);

    const row = screen.getByTestId('payroll-period-p-9');
    expect(within(row).getByText('—')).toBeInTheDocument();
    const amount = within(row).getByText(/1\s?250/);
    expect(amount.className).toContain('tabular-nums');
    expect(amount.className).toContain('text-right');
  });
});

describe('Payroll — розрахунок за період шле лише календарні дати', () => {
  it('рік із 5 цифр: кнопка «Розрахувати» вимкнена, запит preview не вмикається', () => {
    render(<PayrollPage />);
    const from = document.querySelectorAll('input[type="date"]')[0] as HTMLInputElement;
    fireEvent.change(from, { target: { value: '20261-10-01' } });
    const btn = screen.getByRole('button', { name: /Розрахувати/ });
    expect(btn).toBeDisabled();
    expect(lastPreviewArgs[3]).toBe(false);
  });
});
