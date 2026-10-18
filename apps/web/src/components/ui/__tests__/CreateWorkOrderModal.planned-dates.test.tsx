/**
 * Картка наряду — планові дати (рішення власника 2026-10-16):
 * - BR-WO-019: автокінець за нормогодинами — у робочих годинах ФІЛІЇ наряду
 *   (`GET /settings/work-hours?branchId=`), а не в жорстких 08–20; у пікерах планових дат минулі
 *   дні недоступні.
 * - BR-WO-020: запис календаря переносить сервер у транзакції збереження наряду — картка не
 *   питає «Оновити слот?» і не шле `PATCH /calendar/slots/by-work-order`; після збереження
 *   відкритий календар перечитує записи (подія `sto:calendar-changed`) — лише коли змінились
 *   планові дати чи підйомник; без підйомника перевірки зайнятості немає (сервер на такий запит
 *   відповідає «вільно», не читаючи календар).
 */
import { act, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, it, expect, describe, beforeEach, afterEach } from 'vitest';
import { CreateWorkOrderModal } from '../CreateWorkOrderModal';
import { renderWithQueryClient } from '@/__tests__/query-utils';

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

vi.mock('@/lib/ref-cache', () => ({
  getCached: () => null,
  setCache: vi.fn(),
}));

vi.mock('@/hooks/api/useCash', () => ({
  useBaseCurrency: () => ({ data: { code: 'UAH', symbol: '₴' } }),
}));

const WO = '10000000-0000-4000-8000-000000000001';
const B1 = '10000000-0000-4000-8000-000000000002';
const V1 = '10000000-0000-4000-8000-000000000003';
const CP1 = '10000000-0000-4000-8000-000000000004';
const LIFT = '10000000-0000-4000-8000-000000000009';

/** «Зараз» — 20.05.2026 12:00 Києва. */
const NOW = new Date('2026-05-20T09:00:00Z');

type Call = [string, { method?: string; body?: string } | undefined];

function mockApi(
  hours: { workStartHour: number; workEndHour: number },
  { liftId = LIFT }: { liftId?: string | null } = {},
) {
  apiFetchMock.mockImplementation((path: string, init?: { method?: string }) => {
    if (path === '/branches') return Promise.resolve([{ id: B1, name: 'Філія №1' }]);
    if (path === '/warehouses') return Promise.resolve([]);
    if (path.startsWith('/employees')) return Promise.resolve({ items: [] });
    if (path.startsWith('/vehicles')) return Promise.resolve([]);
    if (path.includes('/contracts')) return Promise.resolve({ items: [] });
    if (path === '/settings/organisation') return Promise.resolve({ vatMode: 'NONE' });
    if (path === '/settings/tax-rates') return Promise.resolve([]);
    if (path === `/settings/work-hours?branchId=${B1}`) return Promise.resolve(hours);
    if (path === `/work-orders/${WO}/linked-documents`) {
      return Promise.resolve({ invoices: [], payments: [], calendarSlots: [], warranties: [] });
    }
    if (path === `/work-orders/${WO}?withDeleted=true`) {
      return Promise.resolve({
        id: WO,
        number: 'WO-001',
        status: 'DRAFT',
        branchId: B1,
        vehicleId: V1,
        counterpartyId: CP1,
        counterpartyName: 'Тест',
        contractId: null,
        liftId,
        description: '',
        priority: 'NORMAL',
        repairCategory: '',
        documentDate: '2026-05-20',
        // 22.05 16:00–17:00 Києва
        plannedAt: '2026-05-22T13:00:00.000Z',
        dueDate: '2026-05-22T14:00:00.000Z',
        plannedHours: 1,
        actualHours: null,
        lines: [],
        parts: [],
      });
    }
    if (path === `/work-orders/${WO}` && init?.method === 'PATCH') return Promise.resolve({});
    if (path === '/calendar/slots/check-conflicts') return Promise.resolve(conflict.current);
    return Promise.resolve({ items: [] });
  });
}

/** Відповідь перевірки зайнятості для картки (типово — вільно). */
const conflict: { current: unknown } = { current: { anyConflict: false, conflictSlots: [] } };

/** Поля пікерів дат картки: [плановий початок, планове завершення, фактичні…]. */
const dateInputs = () => screen.getAllByPlaceholderText('ДД.ММ.РРРР ГГ:ХХ') as HTMLInputElement[];
const plannedHoursInput = () =>
  document.querySelectorAll<HTMLInputElement>('input[type="number"][step="0.5"]')[0]!;

async function openCard() {
  renderWithQueryClient(<CreateWorkOrderModal open onClose={vi.fn()} workOrderId={WO} />);
  await waitFor(() => expect(dateInputs()[0]!.value).toBe('22.05.2026 16:00'));
  await waitFor(() =>
    expect(apiFetchMock).toHaveBeenCalledWith(
      `/settings/work-hours?branchId=${B1}`,
      expect.anything(),
    ),
  );
  // Запит відправлено — ще не означає, що години філії вже в стані хука: відповідь іде
  // ланцюжком промісів (запит → розбір → кеш запитів). Без цього кроку під навантаженням повного
  // прогону автокінець рахувався за типовими 09–18 (review 2026-10-16: «10:00» замість «09:00»).
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}

describe('CreateWorkOrderModal — планові дати (BR-WO-019, BR-WO-020)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    apiFetchMock.mockReset();
    conflict.current = { anyConflict: false, conflictSlots: [] };
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // guards: BR-WO-019
  it('автокінець — за годинами філії: 16:00 + 3 год при 08–18 → завтра 09:00', async () => {
    mockApi({ workStartHour: 8, workEndHour: 18 });
    await openCard();
    fireEvent.change(plannedHoursInput(), { target: { value: '3' } });
    await waitFor(() => expect(dateInputs()[1]!.value).toBe('23.05.2026 09:00'));
  });

  // guards: BR-WO-019
  it('інша філія 10–19: 16:00 + 3 год → 19:00 того ж дня (не жорсткі 08–20)', async () => {
    mockApi({ workStartHour: 10, workEndHour: 19 });
    await openCard();
    fireEvent.change(plannedHoursInput(), { target: { value: '3' } });
    await waitFor(() => expect(dateInputs()[1]!.value).toBe('22.05.2026 19:00'));
  });

  // guards: BR-WO-019
  it('пікер планового початку: минулі дні недоступні, години — лише робочі', async () => {
    mockApi({ workStartHour: 8, workEndHour: 18 });
    const user = userEvent.setup();
    await openCard();
    await user.click(dateInputs()[0]!);
    expect(document.querySelector('[data-day="2026-05-19"]')).toHaveAttribute(
      'data-disabled',
      'true',
    );
    expect(document.querySelector('[data-day="2026-05-21"]')).not.toHaveAttribute('data-disabled');
    const hours = Array.from(
      (screen.getByLabelText('Година') as HTMLSelectElement).querySelectorAll('option'),
    ).map(o => o.value);
    expect(hours[0]).toBe('08');
    expect(hours[hours.length - 1]).toBe('17');
  });

  // guards: BR-WO-020
  it('збереження зі зміненими датами: без діалогу й PATCH by-work-order; календар перечитує записи', async () => {
    mockApi({ workStartHour: 8, workEndHour: 18 });
    const user = userEvent.setup();
    const onCalendarChanged = vi.fn();
    window.addEventListener('sto:calendar-changed', onCalendarChanged);
    try {
      await openCard();
      fireEvent.change(plannedHoursInput(), { target: { value: '2' } });
      await waitFor(() => expect(dateInputs()[1]!.value).toBe('22.05.2026 18:00'));
      await user.click(screen.getByRole('button', { name: 'Зберегти зміни' }));

      await waitFor(() => expect(onCalendarChanged).toHaveBeenCalledTimes(1));
      const calls = apiFetchMock.mock.calls as Call[];
      const patch = calls.find(([p, i]) => p === `/work-orders/${WO}` && i?.method === 'PATCH');
      expect(JSON.parse(patch![1]!.body!)).toMatchObject({
        plannedAt: '2026-05-22T13:00:00.000Z',
        dueDate: '2026-05-22T15:00:00.000Z',
      });
      // Лише перевірка зайнятості (попередження у формі) — жодного запису календаря з клієнта.
      const calendarWrites = calls.filter(
        ([p]) => p.includes('/calendar/slots') && !p.endsWith('/check-conflicts'),
      );
      expect(calendarWrites).toEqual([]);
      expect(screen.queryByText('Оновити слот в календарі?')).not.toBeInTheDocument();
    } finally {
      window.removeEventListener('sto:calendar-changed', onCalendarChanged);
    }
  });

  // guards: BR-WO-020
  it('зайнятий підйомник: попередження каже, що збереження буде відхилено (сервер — 400)', async () => {
    mockApi({ workStartHour: 8, workEndHour: 18 });
    conflict.current = {
      anyConflict: true,
      liftConflict: true,
      employeeConflict: false,
      conflictSlots: [{ id: 'busy', startAt: '', endAt: '', status: 'BOOKED', type: 'WORK' }],
    };
    await openCard();
    const warning = await screen.findByText(/Підйомник зайнятий/, undefined, { timeout: 3_000 });
    expect(warning.textContent).toMatch(/буде відхилено/);
    expect(warning.textContent).not.toMatch(/Можна зберегти/);
  });

  // guards: BR-WO-020
  it('новий наряд із датами на зайнятий підйомник — попередження ще до «Створити наряд»', async () => {
    mockApi({ workStartHour: 8, workEndHour: 18 });
    conflict.current = {
      anyConflict: true,
      liftConflict: true,
      employeeConflict: false,
      conflictSlots: [{ id: 'busy', startAt: '', endAt: '', status: 'BOOKED', type: 'WORK' }],
    };
    renderWithQueryClient(
      <CreateWorkOrderModal
        open
        onClose={vi.fn()}
        prefill={{
          branchId: B1,
          liftId: LIFT,
          plannedStartAt: '2026-05-22T16:00',
          plannedEndAt: '2026-05-22T17:00',
        }}
      />,
    );
    const warning = await screen.findByText(/Підйомник зайнятий/, undefined, { timeout: 3_000 });
    expect(warning.textContent).toMatch(/буде відхилено/);
    const check = (apiFetchMock.mock.calls as Call[]).find(
      ([p]) => p === '/calendar/slots/check-conflicts',
    );
    expect(JSON.parse(check![1]!.body!)).not.toHaveProperty('excludeWorkOrderId');
  });

  // guards: BR-WO-020
  it('збереження без зміни дат і підйомника — календар не перечитується', async () => {
    mockApi({ workStartHour: 8, workEndHour: 18 });
    const user = userEvent.setup();
    const onCalendarChanged = vi.fn();
    window.addEventListener('sto:calendar-changed', onCalendarChanged);
    try {
      await openCard();
      await user.click(screen.getByRole('button', { name: 'Зберегти зміни' }));
      await waitFor(() =>
        expect(
          (apiFetchMock.mock.calls as Call[]).some(
            ([p, i]) => p === `/work-orders/${WO}` && i?.method === 'PATCH',
          ),
        ).toBe(true),
      );
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 0));
      });
      expect(onCalendarChanged).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('sto:calendar-changed', onCalendarChanged);
    }
  });

  // guards: BR-WO-022
  it.each([
    ['Скасувати', 'CANCELLED', 1],
    ['Кошторис', 'ESTIMATE', 0],
  ] as const)(
    'перехід «%s»: відкритий календар перечитує записи лише після скасування',
    async (label, status, events) => {
      mockApi({ workStartHour: 8, workEndHour: 18 });
      const base = apiFetchMock.getMockImplementation()!;
      apiFetchMock.mockImplementation((path: string, init?: { method?: string }) =>
        path === `/work-orders/${WO}/transition` ? Promise.resolve({ status }) : base(path, init),
      );
      const user = userEvent.setup();
      const onCalendarChanged = vi.fn();
      window.addEventListener('sto:calendar-changed', onCalendarChanged);
      try {
        await openCard();
        await user.click(screen.getByRole('button', { name: 'Чернетка' }));
        // Пункт меню статусу (у картці є й інші кнопки «Скасувати»).
        const item = (await screen.findAllByRole('button', { name: label })).find(btn =>
          btn.className.includes('text-left'),
        );
        await user.click(item!);
        await waitFor(() =>
          expect(
            (apiFetchMock.mock.calls as Call[]).some(
              ([p]) => p === `/work-orders/${WO}/transition`,
            ),
          ).toBe(true),
        );
        await act(async () => {
          await new Promise(resolve => setTimeout(resolve, 0));
        });
        expect(onCalendarChanged).toHaveBeenCalledTimes(events);
      } finally {
        window.removeEventListener('sto:calendar-changed', onCalendarChanged);
      }
    },
  );

  // guards: BR-WO-020
  it('наряд без підйомника — перевірки зайнятості немає, попередження немає', async () => {
    mockApi({ workStartHour: 8, workEndHour: 18 }, { liftId: null });
    conflict.current = {
      anyConflict: true,
      liftConflict: true,
      employeeConflict: false,
      conflictSlots: [{ id: 'busy', startAt: '', endAt: '', status: 'BOOKED', type: 'WORK' }],
    };
    await openCard();
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 600));
    });
    const checks = (apiFetchMock.mock.calls as Call[]).filter(
      ([p]) => p === '/calendar/slots/check-conflicts',
    );
    expect(checks).toEqual([]);
    expect(screen.queryByText(/Підйомник зайнятий/)).not.toBeInTheDocument();
  });
});
