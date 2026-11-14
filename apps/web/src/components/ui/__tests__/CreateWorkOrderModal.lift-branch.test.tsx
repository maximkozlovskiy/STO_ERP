/**
 * BR-WO-040 (рішення власника 2026-11-14, TECH-DEBT (б) №95): філія наряду — філія його підйомника.
 * Картка наряду при виборі підйомника іншої філії ставить її в поле «Філія» з підказкою «Філію
 * змінено на філію підйомника», і нового наряду з підйомником, відкритого з календаря, — теж;
 * сервер робить те саме при збереженні. Підйомник тієї самої філії чи без філії — без підказки.
 * Поки обрано підйомник із філією, «Філія» заблокована (значення — філія підйомника); без
 * підйомника чи з підйомником без зони — вільна.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import { renderWithQueryClient } from '@/__tests__/query-utils';
import { CreateWorkOrderModal, type CreateWOPrefill } from '../CreateWorkOrderModal';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ employee: { role: 'OWNER' } }) }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/',
}));
vi.mock('@/lib/ref-cache', () => ({ getCached: () => null, setCache: vi.fn() }));
vi.mock('@/hooks/api/useCash', () => ({
  useBaseCurrency: () => ({ data: { code: 'UAH', symbol: '₴' } }),
}));

const MAIN = '11111111-1111-4111-8111-111111111111';
const SECOND = '11111111-1111-4111-8111-222222222222';
const LIFT_MAIN = '55555555-5555-4555-8555-000000000001';
const LIFT_SECOND = '55555555-5555-4555-8555-000000000002';
const LIFT_NO_ZONE = '55555555-5555-4555-8555-000000000003';
const BASE: CreateWOPrefill = {
  branchId: MAIN,
  counterpartyId: '22222222-2222-4222-8222-222222222222',
  counterpartyDisplay: 'Тест Клієнт',
  vehicleId: '33333333-3333-4333-8333-333333333333',
};
const HINT = 'Філію змінено на філію підйомника «Друга філія»';
const WO = '66666666-6666-4666-8666-000000000001';

type Call = [string, { method?: string; body?: string } | undefined];

/** Години другої філії (`GET /settings/work-hours?branchId=SECOND`): типово — пн–сб. */
let secondHours: unknown;

/** Відповіді API картки; кейс може підмінити окремий шлях і передати решту сюди. */
function defaultImpl(path: string, init?: { method?: string }): Promise<unknown> {
  if (path === '/branches')
    return Promise.resolve([
      { id: MAIN, name: 'Основна філія' },
      { id: SECOND, name: 'Друга філія' },
    ]);
  if (path === '/lifts')
    return Promise.resolve([
      { id: LIFT_MAIN, name: 'П1', branchId: MAIN },
      { id: LIFT_SECOND, name: 'П2', branchId: SECOND },
      { id: LIFT_NO_ZONE, name: 'П3', branchId: null },
    ]);
  if (path === `/work-orders/${WO}?withDeleted=true`)
    return Promise.resolve({
      id: WO,
      number: 'WO-001',
      status: 'DRAFT',
      branchId: MAIN,
      vehicleId: BASE.vehicleId,
      counterpartyId: BASE.counterpartyId,
      counterpartyName: 'Тест',
      contractId: null,
      liftId: null,
      description: '',
      priority: 'NORMAL',
      repairCategory: '',
      documentDate: '2026-05-20',
      plannedAt: null,
      dueDate: null,
      plannedHours: null,
      actualHours: null,
      lines: [],
      parts: [],
    });
  if (path === `/work-orders/${WO}/linked-documents`)
    return Promise.resolve({ invoices: [], payments: [], calendarSlots: [], warranties: [] });
  if (path === '/work-orders' && init?.method === 'POST')
    return Promise.resolve({ id: 'wo1', number: 'НРД-1', counterpartyId: BASE.counterpartyId });
  if (path.startsWith('/employees')) return Promise.resolve({ items: [] });
  // №98: основна філія — 09–18 пн–пт, друга — 09–18 пн–сб; без філії — запит не йде.
  if (path === `/settings/work-hours?branchId=${MAIN}`)
    return Promise.resolve({ workStartHour: 9, workEndHour: 18, workDays: [1, 2, 3, 4, 5] });
  if (path === `/settings/work-hours?branchId=${SECOND}`) return Promise.resolve(secondHours);
  return Promise.resolve([]);
}

beforeEach(() => {
  secondHours = { workStartHour: 9, workEndHour: 18, workDays: [1, 2, 3, 4, 5, 6] };
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(defaultImpl);
});

const branchSelect = () => screen.getByLabelText(/^Філія/) as HTMLSelectElement;
const liftSelect = () => screen.getByLabelText(/^Підйомник/) as HTMLSelectElement;

async function open(prefill: CreateWOPrefill = BASE) {
  renderWithQueryClient(<CreateWorkOrderModal open onClose={vi.fn()} prefill={prefill} />);
  await waitFor(() => expect(liftSelect().options.length).toBe(4));
}

async function postBody(): Promise<Record<string, unknown>> {
  const submit = screen.getByRole('button', { name: /Створити наряд/ });
  await waitFor(() => expect(submit).not.toBeDisabled(), { timeout: 2000 });
  await userEvent.click(submit);
  let post: Call | undefined;
  await waitFor(() => {
    post = (apiFetchMock.mock.calls as Call[]).find(
      ([p, i]) => p === '/work-orders' && i?.method === 'POST',
    );
    expect(post).toBeDefined();
  });
  return JSON.parse(post![1]!.body!) as Record<string, unknown>;
}

describe('CreateWorkOrderModal — філія з підйомника (BR-WO-040)', () => {
  // guards: BR-WO-040
  it('підйомник іншої філії → «Філія» — його філія, підказка; POST шле філію підйомника', async () => {
    await open();
    expect(branchSelect().value).toBe(MAIN);

    await userEvent.selectOptions(liftSelect(), LIFT_SECOND);

    expect(branchSelect().value).toBe(SECOND);
    expect(screen.getByTestId('wo-branch-from-lift')).toHaveTextContent(HINT);
    expect(liftSelect()).toHaveAccessibleDescription(HINT);
    expect(await postBody()).toMatchObject({ branchId: SECOND, liftId: LIFT_SECOND });
  });

  // guards: BR-WO-040
  it('наряд із календаря з підйомником іншої філії — філія підйомника одразу, з підказкою', async () => {
    await open({ ...BASE, liftId: LIFT_SECOND });

    await waitFor(() => expect(branchSelect().value).toBe(SECOND));
    expect(screen.getByTestId('wo-branch-from-lift')).toHaveTextContent(HINT);
  });

  // guards: BR-WO-040
  it('контроль: підйомник тієї самої філії чи без філії — філія та сама, без підказки', async () => {
    await open();

    await userEvent.selectOptions(liftSelect(), LIFT_MAIN);
    expect(branchSelect().value).toBe(MAIN);
    await userEvent.selectOptions(liftSelect(), LIFT_NO_ZONE);
    expect(branchSelect().value).toBe(MAIN);
    expect(screen.queryByTestId('wo-branch-from-lift')).toBeNull();
  });

  // guards: BR-WO-040
  it('підйомник із філією → «Філія» заблокована з філією підйомника; без підйомника чи без зони — вільна', async () => {
    await open();
    expect(branchSelect()).not.toBeDisabled();

    await userEvent.selectOptions(liftSelect(), LIFT_SECOND);
    expect(branchSelect()).toBeDisabled();
    expect(branchSelect().value).toBe(SECOND);
    expect(branchSelect()).toHaveAccessibleDescription(HINT);

    await userEvent.selectOptions(liftSelect(), LIFT_MAIN);
    expect(branchSelect()).toBeDisabled();
    expect(branchSelect().value).toBe(MAIN);

    await userEvent.selectOptions(liftSelect(), LIFT_NO_ZONE);
    expect(branchSelect()).not.toBeDisabled();
    await userEvent.selectOptions(liftSelect(), '');
    expect(branchSelect()).not.toBeDisabled();
  });

  // guards: BR-WO-040
  it('збережений наряд: підйомник іншої філії → «Філія» — його філія з підказкою', async () => {
    renderWithQueryClient(<CreateWorkOrderModal open onClose={vi.fn()} workOrderId={WO} />);
    await waitFor(() => expect(liftSelect().options.length).toBe(4));
    await waitFor(() => expect(branchSelect().value).toBe(MAIN));

    await userEvent.selectOptions(liftSelect(), LIFT_SECOND);

    expect(branchSelect().value).toBe(SECOND);
    expect(screen.getByTestId('wo-branch-from-lift')).toHaveTextContent(HINT);
  });
});

/**
 * №98: зміна підйомника на підйомник філії з іншими годинами зберігає нормогодини — «Завершення» від
 * того ж початку за годинами й днями нової філії, нормогодини не змінюються. Пт 21.05.2027 17:00 +
 * 3 нормогодини на пн–пт — пн 11:00; на пн–сб — сб 11:00 (08:00Z).
 */
describe('CreateWorkOrderModal — підйомник іншої філії зберігає нормогодини (BR-WO-040, №98)', () => {
  const PLAN: CreateWOPrefill = {
    ...BASE,
    plannedStartAt: '2027-05-21T17:00',
    plannedEndAt: '2027-05-24T11:00',
  };
  const plan = () => within(screen.getByTestId('wo-planned'));
  const endInput = () =>
    plan()
      .getByText('Дата та час завершення')
      .closest('label')!
      .parentElement!.querySelector('input') as HTMLInputElement;

  // guards: BR-WO-040
  it('пт 17:00 + 3 нормогодини → завершення сб 11:00, нормогодини ті самі', async () => {
    await open({ ...PLAN, plannedHours: '3' });
    await waitFor(() => expect(endInput().value).toBe('24.05.2027 11:00'));

    await userEvent.selectOptions(liftSelect(), LIFT_SECOND);

    await waitFor(() => expect(endInput().value).toBe('22.05.2027 11:00'));
    expect((plan().getByLabelText(/^Нормогодин/) as HTMLInputElement).value).toBe('3');
    expect(await postBody()).toMatchObject({
      branchId: SECOND,
      plannedAt: '2027-05-21T14:00:00.000Z',
      dueDate: '2027-05-22T08:00:00.000Z',
    });
  });

  // guards: BR-WO-040
  it.each([
    ['години філій однакові', { workStartHour: 9, workEndHour: 18, workDays: [1, 2, 3, 4, 5] }],
    ['години нової філії не прочитано (збій) — дати рахує сервер', null],
  ])('контроль: %s → завершення без змін', async (_l, hoursOfSecond) => {
    secondHours = hoursOfSecond;
    if (hoursOfSecond === null)
      apiFetchMock.mockImplementation((path: string, init?: { method?: string }) =>
        path === `/settings/work-hours?branchId=${SECOND}`
          ? Promise.reject(new Error('offline'))
          : defaultImpl(path, init),
      );
    // Нормогодини в полі навмисно не збігаються з датами: перерахунок дав би пн 13:00.
    await open({ ...PLAN, plannedHours: '5' });
    await waitFor(() => expect(endInput().value).toBe('24.05.2027 11:00'));

    await userEvent.selectOptions(liftSelect(), LIFT_SECOND);

    expect(branchSelect().value).toBe(SECOND);
    await new Promise(r => setTimeout(r, 50));
    expect(endInput().value).toBe('24.05.2027 11:00');
  });
});
