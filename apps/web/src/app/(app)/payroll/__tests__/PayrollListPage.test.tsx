// Regression-guard для List Page pattern на /payroll (пагінація + фільтр статусу + колонки).
// Стандарт списку (рішення власника 2026-10-22): сторінка на весь екран (`page-fill`), статуси —
// кнопками окремим рядком над рядком фільтрів, розрахунок за період — у вікні з основної кнопки.
// Load-bearing поведінка:
//   - usePayrollPeriods отримує { page, limit, status } — фільтр реально їде на бекенд,
//     а не фільтрує локально (інакше пагінація бреше: total з сервера ≠ видимі рядки).
//   - Зміна статусу скидає page на 1 (інакше «сторінка 3» порожня після вужчого фільтра).
//   - Пагінація рендериться лише коли totalPages > 1 (компонент Pagination сам це тримає).
//   - ColumnsDropdown присутній; приховування колонки прибирає її th і не ламає colSpan.
//   - Порожній список під фільтром → empty.noMatchDescription, без фільтра → periodsHint.
//   - Дати періоду й «Розраховано» — ДД.ММ.РРРР; «Розраховано» — за Києвом, а не UTC-зріз ISO.

import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import type { PayrollPeriod, PayrollPeriodsFilter, PayrollPreview } from '@/hooks/api/usePayroll';

vi.mock('@/lib/auth', () => ({
  useRequireAuth: () => undefined,
  useAuth: () => ({ employee: { role: 'OWNER' } }),
}));

// Останні фільтри, з якими сторінка покликала хук списку — асертимо контракт.
let lastFilters: PayrollPeriodsFilter | undefined;
const listItems: PayrollPeriod[] = [];
let listTotal = 0;
let lastPreviewArgs: unknown[] = [];
let previewError: Error | null = null;
let previewData: PayrollPreview | undefined;
const previewRefetch = vi.fn();
const createMutate = vi.fn();

vi.mock('@/hooks/api/usePayroll', async orig => {
  const actual = await orig<typeof import('@/hooks/api/usePayroll')>();
  const noopMut = () => ({ mutateAsync: vi.fn(), isPending: false, variables: undefined });
  return {
    ...actual,
    usePayrollPreview: (...args: unknown[]) => {
      lastPreviewArgs = args;
      return { data: previewData, isLoading: false, error: previewError, refetch: previewRefetch };
    },
    usePayrollPeriods: (filters: PayrollPeriodsFilter = {}) => {
      lastFilters = filters;
      return {
        data: { items: listItems, total: listTotal, page: filters.page ?? 1, limit: 20 },
        isLoading: false,
      };
    },
    usePayrollPeriod: () => ({ data: undefined, isLoading: false }),
    useCreatePayrollPeriod: () => ({ mutateAsync: createMutate, isPending: false }),
    useComputePayrollPeriod: noopMut,
    usePayPayrollPeriod: noopMut,
    useDeletePayrollPeriod: noopMut,
  };
});

vi.mock('@/hooks/api/useCash', () => ({
  useCashRegisters: () => ({ data: [] }),
}));

import PayrollPage from '../page';
// Сторінка вантажить вікно розрахунку через next/dynamic; модуль у кеші заздалегідь — інакше перший
// імпорт під навантаженням повного прогону довший за таймаут тесту.
import '../PayrollPreviewModal';

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

const statusGroup = () => screen.getByRole('group', { name: 'Статус періоду' });
const pickStatus = (label: string) =>
  fireEvent.click(within(statusGroup()).getByRole('button', { name: label }));

/** Вікно «Розрахунок за період» — з основної кнопки рядка фільтрів (вантажиться ліниво). */
async function openPreview() {
  fireEvent.click(screen.getByRole('button', { name: 'Розрахувати період' }));
  return screen.findByRole('dialog', { name: 'Розрахунок за період' }, { timeout: 3000 });
}

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
    pickStatus('Виплачено');
    expect(lastFilters?.status).toBe('PAID');
  });

  it('зміна статусу скидає сторінку на 1 (інакше глибока сторінка порожня)', () => {
    // 3 сторінки → є на що перейти.
    listItems.push(makePeriod());
    listTotal = 55;
    render(<PayrollPage />);

    fireEvent.click(screen.getByRole('button', { name: '2' }));
    expect(lastFilters?.page).toBe(2);

    pickStatus('Чернетка');
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
      screen.getByText('Натисніть «Розрахувати період» і створіть період у вікні розрахунку'),
    ).toBeInTheDocument();

    pickStatus('Скасовано');
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

  it('дати періоду й «Розраховано» — ДД.ММ.РРРР, день розрахунку за Києвом (не UTC-зріз)', () => {
    // 22:30 UTC 30.09 — у Києві вже 01.10 (UTC+3): зріз `slice(0, 10)` показав би 2026-09-30.
    listItems.push(makePeriod({ id: 'p-d', computedAt: '2026-09-30T22:30:00.000Z' }));
    listTotal = 1;
    render(<PayrollPage />);

    const row = screen.getByTestId('payroll-period-p-d');
    expect(within(row).getByText('01.09.2026 — 30.09.2026')).toBeInTheDocument();
    expect(within(row).getByText('01.10.2026')).toBeInTheDocument();
    expect(within(row).queryByText(/2026-09/)).not.toBeInTheDocument();
  });
});

describe('Payroll — сторінка на весь екран: статуси над фільтрами, розрахунок у вікні', () => {
  beforeEach(() => {
    listItems.length = 0;
    listTotal = 0;
    previewData = undefined;
    createMutate.mockReset();
    window.localStorage.clear();
  });

  it('page-fill замість вузької картки; статуси — кнопки окремим рядком над рядком фільтрів', () => {
    const { container } = render(<PayrollPage />);
    expect(container.firstElementChild).toHaveClass('page-fill');
    expect(container.querySelector('.page-container')).toBeNull();

    const group = statusGroup();
    expect(
      within(group)
        .getAllByRole('button')
        .map(b => b.textContent),
    ).toEqual(['Всі', 'Чернетка', 'Розраховано', 'Виплачено', 'Скасовано']);
    expect(within(group).getByRole('button', { name: 'Всі' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.queryByRole('combobox', { name: 'Статус періоду' })).toBeNull();

    // Рядок фільтрів — під статусами; дії (колонки, «Розрахувати період») притиснуті праворуч.
    const open = screen.getByRole('button', { name: 'Розрахувати період' });
    const actions = open.parentElement!;
    expect(actions).toHaveClass('ml-auto');
    expect(actions).toContainElement(screen.getByLabelText('Налаштувати колонки'));
    expect(group.contains(open)).toBe(false);
    expect(group.compareDocumentPosition(open) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Розрахунку на сторінці немає — він у вікні.
    expect(screen.queryByRole('button', { name: 'Розрахувати' })).toBeNull();
  });

  it('«Розрахувати період» відкриває вікно: дати — спільний фільтр «Період з … по», запит лише після «Розрахувати»', async () => {
    render(<PayrollPage />);
    const dialog = await openPreview();
    const from = within(dialog).getByLabelText('Період з');
    const to = within(dialog).getByLabelText('по');
    // DatePickerInput: текстове поле ДД.ММ.РРРР, а не рідне type=date.
    expect(from).toHaveAttribute('type', 'text');
    expect(to).toHaveAttribute('type', 'text');
    expect(lastPreviewArgs[3]).toBe(false);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Розрахувати' }));
    expect(lastPreviewArgs[3]).toBe(true);
    expect(String(lastPreviewArgs[0])).toMatch(/^\d{4}-\d{2}-01$/);
  });

  it('«Створити період» — лише коли є нарахування; створює період за датами вікна й закриває вікно', async () => {
    previewData = {
      lines: [
        {
          employeeId: 'e-1',
          employeeName: 'Іваненко Петро',
          rateSchemeType: 'percent_normo',
          normoHours: 2,
          baseAmount: 1000,
          accruedAmount: 400,
        } as PayrollPreview['lines'][number],
      ],
      totalAccrued: 400,
      from: '2026-10-01',
      to: '2026-10-22',
    };
    createMutate.mockResolvedValue({ id: 'p-new' });
    render(<PayrollPage />);
    const dialog = await openPreview();
    expect(within(dialog).queryByRole('button', { name: 'Створити період' })).toBeNull();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Розрахувати' }));
    expect(within(dialog).getByText('Іваненко Петро')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Створити період' }));

    await waitFor(() => expect(createMutate).toHaveBeenCalledTimes(1));
    const [{ periodStart, periodEnd }] = createMutate.mock.calls[0] as [
      { periodStart: string; periodEnd: string },
    ];
    expect(periodStart).toBe(lastPreviewArgs[0]);
    expect(periodEnd).toBe(lastPreviewArgs[1]);
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Розрахунок за період' })).toBeNull(),
    );
  });
});

describe('Payroll — розрахунок за період шле лише календарні дати', () => {
  beforeEach(() => {
    previewData = undefined;
  });

  // Mutation-verify: прибрати `&& datesValid` з виклику usePayrollPreview → падає твердження про
  // четвертий аргумент хука; `disabled={!datesValid}` → падає твердження про кнопку. Запит спершу
  // ВМИКАЄМО («Розрахувати» з коректними датами): без цього четвертий аргумент — false ще до
  // зміни дати, і твердження про нього нічого не стерегло б.
  it('порожня дата «по» («×» у полі): кнопка «Розрахувати» вимкнена, увімкнений запит вимикається', async () => {
    render(<PayrollPage />);
    const dialog = await openPreview();
    const btn = within(dialog).getByRole('button', { name: 'Розрахувати' });
    fireEvent.click(btn);
    expect(lastPreviewArgs[3]).toBe(true);

    fireEvent.change(within(dialog).getByLabelText('по'), { target: { value: '' } });
    expect(btn).toBeDisabled();
    expect(lastPreviewArgs[3]).toBe(false);
  });

  it('рік із 5 цифр у полі не стає межею: запит іде з попередньою датою', async () => {
    render(<PayrollPage />);
    const dialog = await openPreview();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Розрахувати' }));
    const before = lastPreviewArgs[0];

    fireEvent.change(within(dialog).getByLabelText('Період з'), {
      target: { value: '01.10.20261' },
    });
    expect(lastPreviewArgs[0]).toBe(before);
    expect(lastPreviewArgs[3]).toBe(true);
  });

  // Bug #824: смуга помилки розрахунку була без «Повторити». Кнопка «Розрахувати» після першого
  // натискання нічого не робить (запит уже ввімкнено), тож повторити розрахунок із тими самими
  // датами можна було лише змінивши дату туди й назад.
  it('збій розрахунку: смуга з текстом і «Повторити», що перезапитує', async () => {
    previewError = new Error('Внутрішня помилка сервера');
    previewRefetch.mockClear();
    try {
      render(<PayrollPage />);
      const dialog = await openPreview();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Розрахувати' }));
      expect(within(dialog).getByRole('alert')).toHaveTextContent('Внутрішня помилка сервера');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Повторити' }));
      expect(previewRefetch).toHaveBeenCalledTimes(1);
    } finally {
      previewError = null;
    }
  });
});
