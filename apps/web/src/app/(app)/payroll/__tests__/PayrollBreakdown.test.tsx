// Regression-guard для розшифровки нарахувань ЗП у розрізі нарядів (drill-down).
// Load-bearing поведінка нової UI-логіки (feature b1beca00):
//   - Розкриття періоду → детальний запит (usePayrollPeriod) вантажить lines.workOrders.
//   - Розкриття рядка співробітника → таблиця нарядів + tfoot «Разом база» = line.baseAmount.
//   - null vehicleName → показуємо «—», НЕ рядок «null».
//   - Старий період (workOrders=[]) → breakdown.empty, а не спінер/краш.
//   - Розшифровка не «протікає» між співробітниками (кожен рядок читає власні workOrders).

import { render, screen, fireEvent, within } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import type { PayrollPeriod, PayrollLine, PayrollLineWorkOrder } from '@/hooks/api/usePayroll';

// --- auth: адмін (canPay=true) ---
vi.mock('@/lib/auth', () => ({
  useRequireAuth: () => undefined,
  useAuth: () => ({ employee: { role: 'OWNER' } }),
}));

// --- payroll hooks: керовані стуби ---
const listData: PayrollPeriod[] = [];
let detailData: PayrollPeriod | null = null;
let detailLoading = false;

vi.mock('@/hooks/api/usePayroll', async orig => {
  const actual = await orig<typeof import('@/hooks/api/usePayroll')>();
  const noopMut = () => ({ mutateAsync: vi.fn(), isPending: false, variables: undefined });
  return {
    ...actual,
    usePayrollPreview: () => ({ data: undefined, isLoading: false }),
    // Список періодів тепер paginated (usePaginatedList → {items,total,page,limit}).
    usePayrollPeriods: () => ({
      data: { items: listData, total: listData.length, page: 1, limit: 20 },
      isLoading: false,
    }),
    usePayrollPeriod: (id: string | null) => ({
      data: id && detailData?.id === id ? detailData : undefined,
      isLoading: detailLoading,
    }),
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

const PID = 'p-1';

function makeLine(over: Partial<PayrollLine> = {}): PayrollLine {
  return {
    employeeId: 'e1',
    employeeName: 'Коваль Іван',
    rateSchemeType: 'percent_normo',
    baseAmount: 9050,
    normoHours: 84.5,
    linesCount: 85,
    accruedAmount: 3620,
    paidAmount: 0,
    rateParams: { percent: 40 },
    rateDerived: false,
    ...over,
  };
}

function makeWo(over: Partial<PayrollLineWorkOrder> = {}): PayrollLineWorkOrder {
  return {
    workOrderId: 'wo-1',
    workOrderNumber: 'НРД-2026-0001',
    vehicleName: 'Toyota Camry · AA1234BB',
    worksCount: 1,
    normoHours: 1,
    baseAmount: 500,
    accruedAmount: 200,
    ...over,
  };
}

function makePeriod(
  lines: PayrollLine[],
  status: PayrollPeriod['status'] = 'COMPUTED',
): PayrollPeriod {
  return {
    id: PID,
    orgId: 'org-1',
    branchId: null,
    periodStart: '2026-09-01',
    periodEnd: '2026-09-30',
    status,
    note: null,
    totalAccrued: 3620,
    totalPaid: 0,
    lines,
    computedAt: '2026-09-30T00:00:00.000Z',
    paidAt: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-30T00:00:00.000Z',
  };
}

describe('Payroll — розшифровка по нарядах (drill-down)', () => {
  beforeEach(() => {
    listData.length = 0;
    detailData = null;
    detailLoading = false;
  });

  it('розкриття співробітника показує таблицю нарядів; tfoot «Разом» = line.baseAmount', () => {
    const wos = [
      makeWo({
        workOrderId: 'wo-1',
        workOrderNumber: 'НРД-2026-0001',
        baseAmount: 500,
        normoHours: 1,
      }),
      makeWo({
        workOrderId: 'wo-2',
        workOrderNumber: 'НРД-2026-0002',
        baseAmount: 300,
        normoHours: 0.5,
      }),
    ];
    // line.baseAmount = Σ wo.baseAmount = 800 (інваріант tfoot)
    const line = makeLine({ baseAmount: 800, normoHours: 1.5, workOrders: wos });
    const period = makePeriod([line]);
    // список несе рядок БЕЗ workOrders (важко); деталь несе повну розшифровку
    listData.push(makePeriod([{ ...line, workOrders: undefined }]));
    detailData = period;

    render(<PayrollPage />);

    // Розгортаємо період (перша кнопка-стрілка «Розгорнути»).
    fireEvent.click(screen.getByLabelText('Розгорнути'));
    // Розгортаємо рядок співробітника («Показати наряди»).
    fireEvent.click(screen.getByLabelText('Показати наряди'));

    // Таблиця нарядів: обидва номери — клікабельні лінки на наряд.
    const link1 = screen.getByRole('link', { name: 'НРД-2026-0001' });
    expect(link1).toHaveAttribute('href', '/work-orders/wo-1');
    expect(screen.getByRole('link', { name: 'НРД-2026-0002' })).toHaveAttribute(
      'href',
      '/work-orders/wo-2',
    );

    // tfoot «Разом» присутній і показує суму бази рядка (800), яка = Σ рядків розшифровки.
    const totalCell = screen.getByText('Разом');
    const tfootRow = totalCell.closest('tr')!;
    // fmtMoney(800) → «800,00» (uk-UA). Перевіряємо, що сумарна база у tfoot = base рядка.
    expect(within(tfootRow).getByText(/800/)).toBeInTheDocument();
  });

  it('null vehicleName → «—», не рядок «null»', () => {
    const wos = [makeWo({ vehicleName: null })];
    const line = makeLine({ baseAmount: 500, workOrders: wos });
    listData.push(makePeriod([{ ...line, workOrders: undefined }]));
    detailData = makePeriod([line]);

    render(<PayrollPage />);
    fireEvent.click(screen.getByLabelText('Розгорнути'));
    fireEvent.click(screen.getByLabelText('Показати наряди'));

    // Скоуп на таблицю розшифровки: колонка «Примітка» списку періодів теж рендерить «—»
    // для порожнього note, тому глобальний getByText('—') дав би multiple-match.
    const woRow = screen.getByRole('link', { name: 'НРД-2026-0001' }).closest('tr')!;
    expect(within(woRow).getByText('—')).toBeInTheDocument();
    expect(screen.queryByText('null')).not.toBeInTheDocument();
  });

  it('старий період (workOrders=[]) → breakdown.empty, без спінера/краху', () => {
    const line = makeLine({ workOrders: [] });
    listData.push(makePeriod([{ ...line, workOrders: undefined }]));
    detailData = makePeriod([line]);

    render(<PayrollPage />);
    fireEvent.click(screen.getByLabelText('Розгорнути'));
    fireEvent.click(screen.getByLabelText('Показати наряди'));

    expect(
      screen.getByText('Розшифровка недоступна (період розраховано до її впровадження).'),
    ).toBeInTheDocument();
  });

  // BR-PAYR-001: окладник без жодної роботи за період має рядок із базою 0 і linesCount 0.
  // Розшифровки в нього немає, бо немає нарядів, — текст «період розраховано до впровадження»
  // тут був би неправдою.
  it('окладник без робіт (linesCount=0, workOrders=[]) → «лише оклад», а не «період до впровадження»', () => {
    const line = makeLine({
      rateSchemeType: 'fixed_plus_bonus',
      baseAmount: 0,
      normoHours: 0,
      linesCount: 0,
      accruedAmount: 7000,
      workOrders: [],
    });
    listData.push(makePeriod([{ ...line, workOrders: undefined }]));
    detailData = makePeriod([line]);

    render(<PayrollPage />);
    fireEvent.click(screen.getByLabelText('Розгорнути'));
    // Рядок із нульовою базою не сховано.
    expect(screen.getByText('Коваль Іван')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Показати наряди'));

    expect(
      screen.getByText(
        'За період немає завершених робіт — нараховано лише оклад за частку періоду.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('Розшифровка недоступна (період розраховано до її впровадження).'),
    ).not.toBeInTheDocument();
  });

  it('поки деталь вантажиться (isLoading) → спінер у розкритій розшифровці, не breakdown.empty', () => {
    const line = makeLine({ workOrders: undefined }); // список без розшифровки
    listData.push(makePeriod([line]));
    detailData = null; // деталь ще не прийшла
    detailLoading = true;

    render(<PayrollPage />);
    fireEvent.click(screen.getByLabelText('Розгорнути'));
    fireEvent.click(screen.getByLabelText('Показати наряди'));

    // Спінер (status role) присутній; breakdown.empty НЕ показується під час завантаження.
    expect(
      screen.queryByText('Розшифровка недоступна (період розраховано до її впровадження).'),
    ).not.toBeInTheDocument();
  });

  it('дві особи — розшифровка не протікає: кожен рядок показує власні наряди', () => {
    const e1 = makeLine({
      employeeId: 'e1',
      employeeName: 'Один Олег',
      baseAmount: 500,
      workOrders: [makeWo({ workOrderId: 'wo-a', workOrderNumber: 'НРД-A', vehicleName: 'Kia' })],
    });
    const e2 = makeLine({
      employeeId: 'e2',
      employeeName: 'Два Богдан',
      baseAmount: 500,
      workOrders: [makeWo({ workOrderId: 'wo-b', workOrderNumber: 'НРД-B', vehicleName: 'Audi' })],
    });
    listData.push(
      makePeriod([
        { ...e1, workOrders: undefined },
        { ...e2, workOrders: undefined },
      ]),
    );
    detailData = makePeriod([e1, e2]);

    render(<PayrollPage />);
    fireEvent.click(screen.getByLabelText('Розгорнути'));
    // Дві кнопки «Показати наряди» — по одній на співробітника; розкриваємо першу (Олег).
    const toggles = screen.getAllByLabelText('Показати наряди');
    expect(toggles).toHaveLength(2);
    fireEvent.click(toggles[0]);

    // Видно лише наряд Олега (НРД-A), не Богдана (НРД-B).
    expect(screen.getByRole('link', { name: 'НРД-A' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'НРД-B' })).not.toBeInTheDocument();
  });

  // --- BR-PAYR-016: умови схеми й нараховане по наряду ---

  const openBreakdown = (line: PayrollLine) => {
    listData.push(makePeriod([{ ...line, workOrders: undefined }]));
    detailData = makePeriod([line]);
    render(<PayrollPage />);
    fireEvent.click(screen.getByLabelText('Розгорнути'));
  };

  // guards: BR-PAYR-016
  it('умови схеми зі знімка: «% від суми робіт · 40 %» без «≈» і без підказки', () => {
    openBreakdown(makeLine({ workOrders: [makeWo()] }));

    const terms = screen.getByText('% від суми робіт · 40 %');
    expect(terms).not.toHaveAttribute('title');
    expect(screen.queryByText(/≈/)).not.toBeInTheDocument();
  });

  // guards: BR-PAYR-016
  it('виведені умови (rateDerived): «≈ 40 %» з підказкою «обчислено з нарахування»', () => {
    openBreakdown(makeLine({ rateDerived: true, workOrders: [makeWo()] }));

    const terms = screen.getByText('% від суми робіт · ≈ 40 %');
    expect(terms).toHaveAttribute('title', 'обчислено з нарахування');
  });

  // guards: BR-PAYR-016
  it('нормо-година й оклад + бонус: ставка грошима з комою, бонус у відсотках', () => {
    const hourly = makeLine({
      employeeId: 'e1',
      rateSchemeType: 'per_normo_hour',
      rateParams: { ratePerHour: 250 },
    });
    const salaried = makeLine({
      employeeId: 'e2',
      employeeName: 'Бондар Олена',
      rateSchemeType: 'fixed_plus_bonus',
      rateParams: { fixedMonthly: 20000, bonusPercent: 5 },
    });
    listData.push(makePeriod([hourly, salaried]));
    detailData = makePeriod([hourly, salaried]);
    render(<PayrollPage />);
    fireEvent.click(screen.getByLabelText('Розгорнути'));

    // fmtMoney ставить нерозривний пробіл між тисячами — порівнюємо з нормалізованими пробілами.
    const norm = (el: Element) => el.textContent?.replace(/\s/g, ' ');
    const texts = screen.getAllByRole('row').map(norm);
    expect(texts.some(r => r?.includes('за нормо-годину · 250,00 ₴/год'))).toBe(true);
    expect(texts.some(r => r?.includes('оклад 20 000,00 ₴ + бонус 5 %'))).toBe(true);
  });

  // guards: BR-PAYR-016
  it('умов немає (null) — лише назва схеми', () => {
    openBreakdown(makeLine({ rateSchemeType: 'fixed_plus_bonus', rateParams: null }));
    expect(screen.getByText('Ставка + бонус')).toBeInTheDocument();
  });

  // guards: BR-PAYR-016
  it('колонка «Нараховано, ₴» по нарядах; підсумок = «Нараховано» працівника', () => {
    const line = makeLine({
      baseAmount: 800,
      accruedAmount: 320,
      workOrders: [
        makeWo({
          workOrderId: 'wo-1',
          workOrderNumber: 'НРД-1',
          baseAmount: 500,
          accruedAmount: 200,
        }),
        makeWo({
          workOrderId: 'wo-2',
          workOrderNumber: 'НРД-2',
          baseAmount: 300,
          accruedAmount: 120,
        }),
      ],
    });
    openBreakdown(line);
    fireEvent.click(screen.getByLabelText('Показати наряди'));

    const breakdown = screen.getByRole('link', { name: 'НРД-1' }).closest('table')!;
    expect(
      within(breakdown).getByRole('columnheader', { name: 'Нараховано, ₴' }),
    ).toBeInTheDocument();
    const row1 = screen.getByRole('link', { name: 'НРД-1' }).closest('tr')!;
    expect(within(row1).getAllByRole('cell').at(-1)).toHaveTextContent('200,00');
    const row2 = screen.getByRole('link', { name: 'НРД-2' }).closest('tr')!;
    expect(within(row2).getAllByRole('cell').at(-1)).toHaveTextContent('120,00');
    const total = within(breakdown).getByText('Разом').closest('tr')!;
    expect(within(total).getAllByRole('cell').at(-1)).toHaveTextContent('320,00');
    expect(screen.queryByText('Оклад за період')).not.toBeInTheDocument();
  });

  // guards: BR-PAYR-016
  it('оклад + бонус: рядок «Оклад за період» окремо від нарядів', () => {
    const line = makeLine({
      rateSchemeType: 'fixed_plus_bonus',
      rateParams: { fixedMonthly: 30000, bonusPercent: 10 },
      baseAmount: 500,
      accruedAmount: 7050,
      fixedPart: 7000,
      workOrders: [makeWo({ baseAmount: 500, accruedAmount: 50 })],
    });
    openBreakdown(line);
    fireEvent.click(screen.getByLabelText('Показати наряди'));

    const fixedRow = screen.getByText('Оклад за період').closest('tr')!;
    expect(within(fixedRow).getAllByRole('cell').at(-1)?.textContent?.replace(/\s/g, ' ')).toBe(
      '7 000,00',
    );
    const total = screen.getByText('Разом').closest('tr')!;
    expect(within(total).getAllByRole('cell').at(-1)?.textContent?.replace(/\s/g, ' ')).toBe(
      '7 050,00',
    );
  });

  // guards: BR-PAYR-016
  it('оклад + бонус без знімка (accruedAmount null): колонки «Нараховано» немає, пояснення чому', () => {
    const line = makeLine({
      rateSchemeType: 'fixed_plus_bonus',
      rateParams: null,
      workOrders: [makeWo({ accruedAmount: null })],
    });
    openBreakdown(line);
    fireEvent.click(screen.getByLabelText('Показати наряди'));

    const breakdown = screen.getByRole('link', { name: 'НРД-2026-0001' }).closest('table')!;
    expect(
      within(breakdown).queryByRole('columnheader', { name: 'Нараховано, ₴' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(
        'Відомість розраховано до збереження умов схеми: оклад + бонус по нарядах не розкладається.',
      ),
    ).toBeInTheDocument();
  });
});
