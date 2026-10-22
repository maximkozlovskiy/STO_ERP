import { screen, waitFor, within } from '@testing-library/react';
import { renderWithQueryClient } from '@/__tests__/query-utils';
import userEvent from '@testing-library/user-event';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import { CreateWorkOrderModal, type CreateWOPrefill } from '../CreateWorkOrderModal';

/**
 * BR-WO-030: виконавець нової роботи в картці наряду — механік запису календаря наряду, інакше
 * єдиний механік підйомника наряду. Нові рядки: пошуком, вікном вибору й усі роботи «+ Послуга».
 * Ручний вибір не перезаписується; наявні рядки зміна підйомника не чіпає.
 */

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

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

// Кеш вкладки: порожній, доки тест сам його не наповнить (Bug #946).
const refCache = vi.hoisted(() => new Map<string, unknown>());
vi.mock('@/lib/ref-cache', () => ({
  getCached: (key: string) => refCache.get(key) ?? null,
  setCache: vi.fn((key: string, data: unknown) => refCache.set(key, data)),
}));

vi.mock('@/hooks/api/useCash', () => ({
  useBaseCurrency: () => ({ data: { code: 'UAH', symbol: '₴' } }),
}));

const WO = 'wo-30';
const LIFT_ONE = 'lift-one';
const LIFT_TWO = 'lift-two';
const ENGINE = 'cat-engine';
const BODY = 'cat-body';

const EMPLOYEES = [
  { id: 'm-ivan', firstName: 'Іван', lastName: 'Петров', role: 'MECHANIC', status: 'ACTIVE' },
  { id: 'm-oleh', firstName: 'Олег', lastName: 'Сидоренко', role: 'MECHANIC', status: 'ACTIVE' },
  { id: 'm-anna', firstName: 'Анна', lastName: 'Коваль', role: 'MECHANIC', status: 'ACTIVE' },
];

/** Механіки підйомників (`GET /employees?liftId=`), з категоріями робіт. */
const LIFT_MECHANICS: Record<string, unknown[]> = {
  [LIFT_ONE]: [{ id: 'm-ivan', status: 'ACTIVE', workCategoryIds: [] }],
  [LIFT_TWO]: [
    { id: 'm-ivan', status: 'ACTIVE', workCategoryIds: [] },
    { id: 'm-oleh', status: 'ACTIVE', workCategoryIds: [] },
  ],
};

const WORKS = [
  { id: 'w-oil', name: 'Заміна оливи', normoHours: 1, price: 400, categoryId: ENGINE },
  { id: 'w-paint', name: 'Фарбування дверей', normoHours: 3, price: 900, categoryId: BODY },
];

const SERVICE = {
  id: 'svc-1',
  name: 'ТО-1',
  description: null,
  price: null,
  works: [
    { workId: 'w-oil', workName: 'Заміна оливи', normoHours: 1, price: 400, quantity: 1 },
    { workId: 'w-paint', workName: 'Фарбування дверей', normoHours: 3, price: 900, quantity: 1 },
  ],
  goods: [],
};

function mockApi(opts: {
  liftId?: string | null;
  calendarSlots?: { startAt: string; employeeId: string | null }[];
  liftMechanics?: Record<string, unknown[]>;
  lines?: { workId: string; workName: string; employeeId: string; employeeName: string }[];
}) {
  const liftMechanics = opts.liftMechanics ?? LIFT_MECHANICS;
  apiFetchMock.mockImplementation((path: string) => {
    if (path === '/branches') return Promise.resolve([{ id: 'b1', name: 'Філія №1' }]);
    if (path === '/warehouses') return Promise.resolve([{ id: 'w1', name: 'Склад №1' }]);
    if (path === '/lifts')
      return Promise.resolve([
        { id: LIFT_ONE, name: 'Підйомник 1' },
        { id: LIFT_TWO, name: 'Підйомник 2' },
      ]);
    if (path.startsWith('/employees?liftId=')) {
      const liftId = new URL(path, 'http://x').searchParams.get('liftId')!;
      return Promise.resolve({ items: liftMechanics[liftId] ?? [] });
    }
    if (path.startsWith('/employees')) return Promise.resolve({ items: EMPLOYEES });
    if (path.startsWith('/vehicles')) return Promise.resolve([]);
    if (path.includes('/contracts')) return Promise.resolve({ items: [] });
    if (path === '/settings/organisation') return Promise.resolve({ vatMode: 'NONE' });
    if (path === '/settings/tax-rates') return Promise.resolve([]);
    if (path.startsWith('/services')) return Promise.resolve({ items: [SERVICE] });
    if (path.startsWith('/works')) {
      const params = new URL(path, 'http://x').searchParams;
      const ids = params.get('ids')?.split(',');
      if (ids) return Promise.resolve({ items: WORKS.filter(w => ids.includes(w.id)) });
      const q = params.get('q') ?? '';
      return Promise.resolve({ items: WORKS.filter(w => w.name.includes(q)) });
    }
    if (path === `/work-orders/${WO}/linked-documents`) {
      return Promise.resolve({
        invoices: [],
        payments: [],
        calendarSlots: opts.calendarSlots ?? [],
        warranties: [],
      });
    }
    if (path === `/work-orders/${WO}?withDeleted=true`) {
      return Promise.resolve({
        id: WO,
        number: 'WO-030',
        status: 'DRAFT',
        branchId: 'b1',
        vehicleId: 'v1',
        counterpartyId: 'cp1',
        counterpartyName: 'Тест',
        contractId: null,
        liftId: opts.liftId === undefined ? LIFT_ONE : opts.liftId,
        description: '',
        priority: 'NORMAL',
        repairCategory: '',
        documentDate: '2026-10-22',
        plannedAt: null,
        dueDate: null,
        plannedHours: null,
        actualHours: null,
        lines: (opts.lines ?? []).map((l, i) => ({
          id: `l${i + 1}`,
          ...l,
          normoHours: 1,
          actualHours: null,
          price: 400,
        })),
        parts: [],
      });
    }
    return Promise.resolve({ items: [] });
  });
}

async function openCard(prefill?: CreateWOPrefill) {
  const user = userEvent.setup();
  renderWithQueryClient(
    prefill ? (
      <CreateWorkOrderModal open onClose={vi.fn()} prefill={prefill} />
    ) : (
      <CreateWorkOrderModal open onClose={vi.fn()} workOrderId={WO} />
    ),
  );
  await screen.findByTestId('wo-works-section');
  await waitFor(() =>
    expect(apiFetchMock).toHaveBeenCalledWith('/employees?limit=200&role=MECHANIC'),
  );
  return user;
}

const worksSection = () => screen.getByTestId('wo-works-section');

async function openInputRow(user: ReturnType<typeof userEvent.setup>) {
  await user.click(within(worksSection()).getByRole('button', { name: 'Додати' }));
  return screen.getByTitle('Зберегти рядок').closest('tr') as HTMLElement;
}

const executor = (row: HTMLElement) =>
  within(row).getByRole('combobox', { name: 'Виконавець' }) as HTMLSelectElement;

async function searchWork(
  user: ReturnType<typeof userEvent.setup>,
  row: HTMLElement,
  name: string,
) {
  await user.type(within(row).getByRole('combobox', { name: 'Робота' }), name.slice(0, 6));
  await user.click(await screen.findByRole('option', { name: new RegExp(name) }));
}

const lineRow = (name: string) =>
  within(worksSection()).getByText(name).closest('tr') as HTMLTableRowElement;

describe('CreateWorkOrderModal — виконавець нової роботи (BR-WO-030)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    refCache.clear();
  });

  // guards: BR-WO-030
  it('підйомник з одним механіком: робота пошуком → виконавець — цей механік', async () => {
    mockApi({});
    const user = await openCard();
    const row = await openInputRow(user);
    expect(executor(row).value).toBe('');

    await searchWork(user, row, 'Заміна оливи');

    await waitFor(() => expect(executor(row).value).toBe('m-ivan'));
  });

  // guards: BR-WO-030
  it('робота вікном вибору → виконавець підставляється так само', async () => {
    mockApi({});
    const user = await openCard();
    const row = await openInputRow(user);

    await user.click(within(row).getByRole('button', { name: 'Обрати' }));
    const picker = await screen.findByRole('dialog', { name: 'Оберіть роботу' });
    await user.click(await within(picker).findByRole('button', { name: /Заміна оливи/ }));

    await waitFor(() => expect(executor(row).value).toBe('m-ivan'));
  });

  // guards: BR-WO-030
  it('на підйомнику кілька механіків, запису немає → поле порожнє', async () => {
    mockApi({ liftId: LIFT_TWO });
    const user = await openCard();
    const row = await openInputRow(user);

    await searchWork(user, row, 'Заміна оливи');

    await waitFor(() => expect(within(row).getByText('Заміна оливи')).toBeTruthy());
    expect(executor(row).value).toBe('');
  });

  // guards: BR-WO-030
  it('запис календаря з механіком → він, навіть коли на підйомнику кілька', async () => {
    mockApi({
      liftId: LIFT_TWO,
      calendarSlots: [
        { startAt: '2026-10-25T08:00:00.000Z', employeeId: 'm-ivan' },
        { startAt: '2026-10-23T08:00:00.000Z', employeeId: 'm-oleh' },
      ],
    });
    const user = await openCard();
    const row = await openInputRow(user);

    await searchWork(user, row, 'Заміна оливи');

    await waitFor(() => expect(executor(row).value).toBe('m-oleh'));
  });

  // guards: BR-WO-030
  it('новий наряд із календаря: механік запису з prefill', async () => {
    mockApi({});
    const user = await openCard({ liftId: LIFT_TWO, employeeId: 'm-anna' });
    const row = await openInputRow(user);

    await searchWork(user, row, 'Заміна оливи');

    await waitFor(() => expect(executor(row).value).toBe('m-anna'));
  });

  // guards: BR-WO-030
  it('єдиний механік без категорії роботи → поле порожнє; з нею → підставляється', async () => {
    mockApi({
      liftMechanics: { [LIFT_ONE]: [{ id: 'm-ivan', status: 'ACTIVE', workCategoryIds: [BODY] }] },
    });
    const user = await openCard();
    const row = await openInputRow(user);

    await searchWork(user, row, 'Заміна оливи');
    await waitFor(() => expect(within(row).getByText('Заміна оливи')).toBeTruthy());
    expect(executor(row).value).toBe('');

    await user.click(within(row).getByRole('button', { name: 'Очистити' }));
    await searchWork(user, row, 'Фарбування дверей');
    await waitFor(() => expect(executor(row).value).toBe('m-ivan'));
  });

  // guards: BR-WO-030
  it('підйомника немає → поле порожнє', async () => {
    mockApi({ liftId: null });
    const user = await openCard();
    const row = await openInputRow(user);

    await searchWork(user, row, 'Заміна оливи');

    await waitFor(() => expect(within(row).getByText('Заміна оливи')).toBeTruthy());
    expect(executor(row).value).toBe('');
    expect(apiFetchMock.mock.calls.some(([p]) => String(p).includes('liftId='))).toBe(false);
  });

  // guards: BR-WO-030
  it('ручний вибір не перезаписується: ні зміною роботи, ні тією самою роботою вдруге', async () => {
    mockApi({});
    const user = await openCard();
    const row = await openInputRow(user);
    await searchWork(user, row, 'Заміна оливи');
    await waitFor(() => expect(executor(row).value).toBe('m-ivan'));

    await user.selectOptions(executor(row), 'm-anna');
    expect(executor(row).value).toBe('m-anna');

    // Та сама робота через вікно вибору.
    await user.click(within(row).getByRole('button', { name: 'Обрати' }));
    const picker = await screen.findByRole('dialog', { name: 'Оберіть роботу' });
    await user.click(await within(picker).findByRole('button', { name: /Заміна оливи/ }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Оберіть роботу' })).toBeNull(),
    );
    expect(executor(row).value).toBe('m-anna');

    // Інша робота — виконавець лишається обраним людиною.
    await user.click(within(row).getByRole('button', { name: 'Обрати' }));
    const picker2 = await screen.findByRole('dialog', { name: 'Оберіть роботу' });
    await user.click(await within(picker2).findByRole('button', { name: /Фарбування дверей/ }));
    await waitFor(() => expect(within(row).getByText('Фарбування дверей')).toBeTruthy());
    expect(executor(row).value).toBe('m-anna');
  });

  // guards: BR-WO-030
  it('«+ Послуга»: кожна робота — з виконавцем за правилом (категорія — зі списку робіт)', async () => {
    mockApi({
      liftMechanics: {
        [LIFT_ONE]: [{ id: 'm-ivan', status: 'ACTIVE', workCategoryIds: [ENGINE] }],
      },
    });
    const user = await openCard();

    await user.click(within(worksSection()).getByRole('button', { name: 'Послуга' }));
    const picker = await screen.findByRole('dialog', { name: 'Оберіть комплексну послугу' });
    await user.click(await within(picker).findByRole('button', { name: /ТО-1/ }));

    await waitFor(() => expect(lineRow('Заміна оливи').textContent).toContain('Петров Іван'));
    // Фарбування — категорія BODY, якої механік підйомника не має: виконавця немає.
    expect(lineRow('Фарбування дверей').textContent).not.toContain('Петров');
    // Категорії — лише робіт послуги, запитом за id (не перші 200 робіт довідника).
    expect(apiFetchMock).toHaveBeenCalledWith('/works?ids=w-oil,w-paint&limit=200');
  });

  // Bug #946: категорію роботи з кешу вкладки ніхто не оновлює — роботу перенесли в «Двигун», а
  // правило підставляло механіка за старою категорією з кешу.
  // guards: BR-WO-030
  it('«+ Послуга»: категорія роботи — з сервера, а не зі старого кешу вкладки', async () => {
    refCache.set('cache:works', [
      { id: 'w-oil', categoryId: BODY },
      { id: 'w-paint', categoryId: BODY },
    ]);
    mockApi({
      liftMechanics: {
        [LIFT_ONE]: [{ id: 'm-ivan', status: 'ACTIVE', workCategoryIds: [ENGINE] }],
      },
    });
    const user = await openCard();

    await user.click(within(worksSection()).getByRole('button', { name: 'Послуга' }));
    const picker = await screen.findByRole('dialog', { name: 'Оберіть комплексну послугу' });
    await user.click(await within(picker).findByRole('button', { name: /ТО-1/ }));

    await waitFor(() => expect(lineRow('Заміна оливи').textContent).toContain('Петров Іван'));
    expect(apiFetchMock).toHaveBeenCalledWith('/works?ids=w-oil,w-paint&limit=200');
    // Кеш оновлено свіжою категорією.
    const cached = refCache.get('cache:works') as { id: string; categoryId: string }[];
    expect(cached.find(w => w.id === 'w-oil')?.categoryId).toBe(ENGINE);
  });

  // guards: BR-WO-030
  it('зміна підйомника не чіпає вже доданих робіт', async () => {
    mockApi({
      liftId: LIFT_ONE,
      lines: [
        {
          workId: 'w-oil',
          workName: 'Заміна оливи',
          employeeId: 'm-anna',
          employeeName: 'Коваль Анна',
        },
      ],
    });
    const user = await openCard();
    await waitFor(() => expect(lineRow('Заміна оливи').textContent).toContain('Коваль Анна'));

    const liftSelect = (await screen.findByRole('option', { name: 'Підйомник 2' }))
      .parentElement as HTMLSelectElement;
    await user.selectOptions(liftSelect, LIFT_TWO);
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith(
        `/employees?liftId=${LIFT_TWO}&role=MECHANIC&limit=200`,
        expect.anything(),
      ),
    );

    expect(lineRow('Заміна оливи').textContent).toContain('Коваль Анна');
  });
});
