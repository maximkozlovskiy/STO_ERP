// Вид «День» (BR-CAL-011) через справжній useCalendarState: блок запису в кольорі категорії
// (прострочення — за кінцем ланцюжка з довантаженим наступним днем), механік на блоці, лінія
// «зараз» лише сьогодні з оновленням щохвилини, завантаження підйомника «N год з M».

import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithQueryClient } from '@/__tests__/query-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarSlot } from '../calendar.types';

let params = new URLSearchParams('view=day&date=2026-10-15');
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => params,
}));

const apiFetch = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (url: string, init?: unknown) => apiFetch(url, init),
}));

import { CalendarDayGrid } from '../CalendarDayGrid';
import { CATEGORY_VIEW } from '../calendar-categories';
import { useCalendarState } from '../useCalendarState';

const iso = (local: string) => new Date(`${local}:00+03:00`).toISOString();
const NOW = new Date('2026-10-15T12:00:00+03:00');

const slot = (
  id: string,
  start: string,
  end: string,
  extra: Partial<CalendarSlot> = {},
): CalendarSlot => ({
  id,
  liftId: 'lift-1',
  startAt: iso(start),
  endAt: iso(end),
  workOrderId: `wo-${id}`,
  workOrderNumber: `WO-${id}`,
  workOrderStatus: 'APPROVED',
  type: 'WORK',
  ...extra,
});

let byDay: Record<string, CalendarSlot[]> = {};

beforeEach(() => {
  // shouldAdvanceTime: інтервал «зараз» (60 с) керований, а waitFor далі працює в реальному часі.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  params = new URLSearchParams('view=day&date=2026-10-15');
  byDay = {};
  apiFetch.mockReset();
  apiFetch.mockImplementation((url: string) => {
    const m = /\/calendar\/slots\?date=(\d{4}-\d{2}-\d{2})/.exec(url);
    if (m) return Promise.resolve(byDay[m[1]] ?? []);
    if (url.startsWith('/lifts'))
      return Promise.resolve([
        { id: 'lift-1', name: 'Підйомник 1' },
        { id: 'lift-2', name: 'Підйомник 2' },
      ]);
    if (url.startsWith('/settings/work-hours'))
      return Promise.resolve({ workStartHour: 8, workEndHour: 20 });
    return Promise.resolve({ items: [] });
  });
});

afterEach(() => {
  vi.useRealTimers();
  sessionStorage.clear();
});

function Harness({ canManageSlots = true }: { canManageSlots?: boolean }) {
  const state = useCalendarState({ canManageSlots });
  return <CalendarDayGrid state={state} />;
}

async function renderDay(opts: { canManageSlots?: boolean } = {}) {
  const view = renderWithQueryClient(<Harness {...opts} />);
  await waitFor(() => expect(screen.getAllByTestId('lift-load')).toHaveLength(2));
  // Прихід підйомників перечитує день (бронювання розкладаються по вільних підйомниках) — блоки
  // записів з'являються, коли це читання завершиться.
  await waitFor(() => expect(screen.queryByLabelText('Завантаження')).not.toBeInTheDocument());
  return view;
}

const block = (number: string) =>
  screen.getByText(number).closest<HTMLElement>('[data-calendar-slot]')!;

describe('Вид «День» — блок запису (BR-CAL-011)', () => {
  // guards: BR-CAL-011
  it('колір і категорія блоку — за станом наряду, з фоном і смугою категорії', async () => {
    byDay['2026-10-15'] = [
      slot('ov', '2026-10-15T08:00', '2026-10-15T09:00', { workOrderStatus: 'IN_PROGRESS' }),
      slot('ip', '2026-10-15T13:00', '2026-10-15T14:00', { workOrderStatus: 'ON_HOLD' }),
      slot('pl', '2026-10-15T14:00', '2026-10-15T15:00', { workOrderStatus: 'ESTIMATE' }),
      slot('dr', '2026-10-15T15:00', '2026-10-15T16:00', { workOrderStatus: 'DRAFT' }),
      slot('dn', '2026-10-15T09:00', '2026-10-15T10:00', { workOrderStatus: 'PAID' }),
      slot('cn', '2026-10-15T16:00', '2026-10-15T17:00', { workOrderStatus: 'CANCELLED' }),
      slot('ot', '2026-10-15T17:00', '2026-10-15T18:00', {
        workOrderNumber: undefined,
        workOrderStatus: null,
        workOrderId: null,
        counterpartyName: 'Службовий',
      }),
    ];
    await renderDay();

    const cases = [
      ['WO-ov', 'overdue'],
      ['WO-ip', 'inProgress'],
      ['WO-pl', 'planned'],
      ['WO-dr', 'draft'],
      ['WO-dn', 'done'],
      ['WO-cn', 'cancelled'],
      ['Службовий', 'other'],
    ] as const;
    for (const [text, category] of cases) {
      const el = block(text);
      expect(el.dataset.category, text).toBe(category);
      expect(el.className).toContain(CATEGORY_VIEW[category].bgClassName);
      expect(el.className).toContain(CATEGORY_VIEW[category].barClassName);
      // Темний текст на світлому фоні, а не білий на `bg-primary`.
      expect(el.className).toContain('text-foreground');
      expect(el.className).not.toContain('text-white');
    }
  });

  // guards: BR-CAL-011
  it('частина з продовженням завтра — не прострочена (кінець ланцюжка з наступного дня)', async () => {
    byDay['2026-10-15'] = [
      slot('p', '2026-10-15T08:00', '2026-10-15T10:00', { workOrderStatus: 'IN_PROGRESS' }),
    ];
    byDay['2026-10-16'] = [
      slot('c', '2026-10-16T08:00', '2026-10-16T11:00', {
        workOrderStatus: 'IN_PROGRESS',
        parentSlotId: 'p',
      }),
    ];
    await renderDay();
    await waitFor(() => expect(block('WO-p').dataset.category).toBe('inProgress'));
  });

  // guards: BR-CAL-011
  it('номер наряду жирним; назва категорії й типу — у підказці й для читача екрана', async () => {
    byDay['2026-10-15'] = [slot('a', '2026-10-15T13:00', '2026-10-15T14:00')];
    await renderDay();
    const el = block('WO-a');
    expect(screen.getByText('WO-a').className).toContain('font-bold');
    expect(el.title).toContain('Робота · Заплановано');
    expect(within(el).getByText(/Робота\. Заплановано\./).className).toContain('sr-only');
  });

  // guards: BR-CAL-003, BR-CAL-011
  it('службовий запис без наряду: на блоці назва типу й примітка; без примітки — лише назва', async () => {
    const service = { workOrderId: null, workOrderNumber: undefined, workOrderStatus: null };
    byDay['2026-10-15'] = [
      slot('b', '2026-10-15T13:00', '2026-10-15T14:00', {
        ...service,
        type: 'BREAK',
        notes: 'Обід',
      }),
      // Механіку примітка не приходить — блок лишається з назвою типу.
      slot('m', '2026-10-15T15:00', '2026-10-15T16:00', { ...service, type: 'MAINTENANCE' }),
    ];
    await renderDay();

    const brk = screen.getByText('Обід').closest<HTMLElement>('[data-calendar-slot]')!;
    expect(
      within(brk).getByText('Перерва', { selector: '[data-part="service-type"]' }),
    ).toBeInTheDocument();
    expect(brk.title).toContain('Обід');
    expect(brk.dataset.category).toBe('other');
    const mnt = screen
      .getByText('Обслуговування', { selector: '[data-part="service-type"]' })
      .closest<HTMLElement>('[data-calendar-slot]')!;
    expect(within(mnt).queryByText('Обід')).toBeNull();
    expect(mnt.querySelector('[data-part="notes"]')).toBeNull();
  });

  // guards: BR-CAL-011
  it('механік на блоці й у підказці; без механіка — рядка немає', async () => {
    byDay['2026-10-15'] = [
      slot('m', '2026-10-15T13:00', '2026-10-15T14:00', { employeeName: 'Коваль Петро' }),
      slot('n', '2026-10-15T15:00', '2026-10-15T16:00', { employeeName: null }),
    ];
    await renderDay();
    const withMech = block('WO-m');
    const mech = withMech.querySelector<HTMLElement>('[data-part="mechanic"]');
    expect(mech?.textContent).toBe('Механік: Коваль Петро');
    expect(withMech.title).toContain('Механік: Коваль Петро');
    expect(block('WO-n').querySelector('[data-part="mechanic"]')).toBeNull();
  });

  // guards: BR-CAL-011
  it("механік (лише перегляд) бачить ім'я механіка на блоці так само", async () => {
    byDay['2026-10-15'] = [
      slot('m', '2026-10-15T13:00', '2026-10-15T14:00', { employeeName: 'Коваль Петро' }),
    ];
    await renderDay({ canManageSlots: false });
    expect(within(block('WO-m')).getByText('Коваль Петро')).toBeInTheDocument();
  });

  // guards: BR-CAL-011
  it('блок, що редагується, лишається виділеним рамкою, колір категорії зберігається', async () => {
    byDay['2026-10-15'] = [slot('a', '2026-10-15T13:00', '2026-10-15T14:00')];
    await renderDay();
    expect(block('WO-a').dataset.editing).toBeUndefined();
    fireEvent.click(screen.getByText('WO-a'));
    await waitFor(() => expect(block('WO-a').dataset.editing).toBe('true'));
    expect(block('WO-a').className).toContain('ring-2');
    expect(block('WO-a').dataset.category).toBe('planned');
  });

  // guards: BR-CAL-011 (Bug #876)
  it('вузький блок: час і тип ховаються за шириною блоку, іконка категорії лишається', async () => {
    byDay['2026-10-15'] = [slot('n', '2026-10-15T16:00', '2026-10-15T16:30')];
    await renderDay();
    const el = block('WO-n');
    // jsdom не рахує контейнерні запити — перевіряється, що правило стоїть на своїх місцях;
    // ширину й видимість іконки міряли в браузері (30 хв на 1280 — блок 43 px).
    const body = el.querySelector<HTMLElement>('.\\@container');
    expect(body).not.toBeNull();
    expect(body!.contains(el.querySelector('[data-part="time"]'))).toBe(true);
    expect(el.querySelector('[data-part="type-icon"]')?.getAttribute('class')).toContain(
      '@max-[2.75rem]:hidden',
    );
    // Час не зникає для читача екрана — лише візуально.
    expect(el.querySelector('[data-part="time"]')?.className).toContain('@max-[2.75rem]:sr-only');
    const svgs = [...el.querySelectorAll('svg')];
    const categoryIcon = svgs.find(s => s.getAttribute('class')?.includes('ml-auto'));
    expect(categoryIcon?.getAttribute('class')).not.toContain('@max-');
  });

  // guards: BR-CAL-011 (Bug #875)
  it('запис за межами робочих годин — блок лише в межах сітки, не на колонці підйомника', async () => {
    byDay['2026-10-15'] = [
      // Почався до відкриття (08:00) — блок від 08:00, не з від'ємним відступом.
      slot('early', '2026-10-15T06:00', '2026-10-15T10:00'),
      // Закінчується після закриття (20:00) — блок до 20:00, рядок не ширшає.
      slot('late', '2026-10-15T19:00', '2026-10-15T22:00'),
      // Цілком до відкриття — коротка позначка біля краю, а не прихований чи зміщений блок.
      slot('before', '2026-10-15T06:00', '2026-10-15T07:00'),
    ];
    await renderDay();
    const pct = (s: string) => Number(s.replace('%', ''));
    const early = block('WO-early').style;
    expect(pct(early.left)).toBe(0);
    expect(pct(early.width)).toBeCloseTo((2 / 12) * 100, 5);
    const late = block('WO-late').style;
    expect(pct(late.left)).toBeCloseTo((11 / 12) * 100, 5);
    expect(pct(late.left) + pct(late.width)).toBeCloseTo(100, 5);
    const before = block('WO-before').style;
    expect(pct(before.left)).toBe(0);
    expect(pct(before.width)).toBeCloseTo((0.25 / 12) * 100, 5);
    // Підказка показує справжній час запису, а не обрізаний.
    expect(block('WO-early').title).toContain('06:00–10:00');
  });
});

describe('Вид «День» — лінія «зараз» (BR-CAL-011)', () => {
  const linesLeft = () => screen.queryAllByTestId('now-line').map(el => parseFloat(el.style.left));

  // guards: BR-CAL-011
  it('сьогодні — у кожному рядку підйомника на поточному часі; минуле приглушене до неї', async () => {
    const { container } = await renderDay();
    const left = (4 / 12) * 100;
    await waitFor(() => expect(linesLeft()).toHaveLength(2));
    for (const l of linesLeft()) expect(l).toBeCloseTo(left, 3);
    const muted = container.querySelector<HTMLElement>('[data-lift-id] [aria-hidden].absolute');
    expect(parseFloat(muted!.style.width)).toBeCloseTo(left, 3);
  });

  // guards: BR-CAL-011
  it('оновлюється щохвилини', async () => {
    await renderDay();
    await waitFor(() => expect(linesLeft()).toHaveLength(2));
    act(() => {
      vi.advanceTimersByTime(60 * 60_000);
    });
    await waitFor(() => expect(linesLeft()[0]).toBeCloseTo((5 / 12) * 100, 1));
  });

  // guards: BR-CAL-011
  it('інший день — лінії немає', async () => {
    params = new URLSearchParams('view=day&date=2026-10-16');
    await renderDay();
    expect(linesLeft()).toHaveLength(0);
  });

  // guards: BR-CAL-011
  it('поза робочими годинами — лінії немає', async () => {
    vi.setSystemTime(new Date('2026-10-15T21:00:00+03:00'));
    await renderDay();
    expect(linesLeft()).toHaveLength(0);
  });
});

describe('Вид «День» — механік лише переглядає (BR-CAL-010)', () => {
  const HINT = /Затисніть і перетягніть/;

  // guards: BR-CAL-010
  it('без права змінювати: без підказки DnD, ручок і курсорів перетягування; клік відкриває', async () => {
    byDay['2026-10-15'] = [slot('a', '2026-10-15T13:00', '2026-10-15T15:00')];
    await renderDay({ canManageSlots: false });
    const el = await waitFor(() => block('WO-a'));
    expect(screen.queryByText(HINT)).toBeNull();
    expect(el.querySelector('[data-part^="resize-"]')).toBeNull();
    expect(el.querySelector('.cursor-grab, .cursor-col-resize')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Змінити початок' })).toBeNull();
    const content = el.querySelector<HTMLElement>('[data-part="content"]')!;
    expect(content).toHaveClass('cursor-pointer');
    expect(content).toHaveAttribute('role', 'button');
    expect(content).not.toHaveAttribute('aria-roledescription');
  });

  // guards: BR-CAL-010
  it('без права змінювати: запис відкривається з клавіатури — Enter і пробіл, інші клавіші ні', async () => {
    byDay['2026-10-15'] = [
      slot('a', '2026-10-15T13:00', '2026-10-15T14:00'),
      slot('b', '2026-10-15T15:00', '2026-10-15T16:00'),
    ];
    await renderDay({ canManageSlots: false });
    const content = (n: string) => block(n).querySelector<HTMLElement>('[data-part="content"]')!;
    fireEvent.keyDown(content('WO-a'), { key: 'a' });
    expect(block('WO-a').dataset.editing).toBeUndefined();
    fireEvent.keyDown(content('WO-a'), { key: 'Enter' });
    await waitFor(() => expect(block('WO-a').dataset.editing).toBe('true'));
    fireEvent.keyDown(content('WO-b'), { key: ' ' });
    await waitFor(() => expect(block('WO-b').dataset.editing).toBe('true'));
  });

  // Bug #877: з правом блок теж кнопка для клавіатури (`role="button"` від useDraggable), а
  // сенсор лише вказівний — без власного обробника Enter і пробіл запису не відкривали.
  it('з правом змінювати: запис теж відкривається з клавіатури — Enter і пробіл', async () => {
    byDay['2026-10-15'] = [
      slot('a', '2026-10-15T13:00', '2026-10-15T14:00'),
      slot('b', '2026-10-15T15:00', '2026-10-15T16:00'),
    ];
    await renderDay({ canManageSlots: true });
    const content = (n: string) => block(n).querySelector<HTMLElement>('[data-part="content"]')!;
    expect(content('WO-a')).toHaveAttribute('role', 'button');
    fireEvent.keyDown(content('WO-a'), { key: 'Tab' });
    expect(block('WO-a').dataset.editing).toBeUndefined();
    fireEvent.keyDown(content('WO-a'), { key: 'Enter' });
    await waitFor(() => expect(block('WO-a').dataset.editing).toBe('true'));
    fireEvent.keyDown(content('WO-b'), { key: ' ' });
    await waitFor(() => expect(block('WO-b').dataset.editing).toBe('true'));
  });

  // guards: BR-CAL-010
  it('контроль: з правом — підказка, ручки зміни меж і курсор перетягування є', async () => {
    byDay['2026-10-15'] = [slot('a', '2026-10-15T13:00', '2026-10-15T15:00')];
    await renderDay({ canManageSlots: true });
    const el = await waitFor(() => block('WO-a'));
    expect(screen.getByText(HINT)).toBeInTheDocument();
    expect(el.querySelectorAll('[data-part^="resize-"]')).toHaveLength(2);
    expect(el.querySelector('[data-part="content"]')).toHaveClass('cursor-grab');
  });

  // guards: BR-CAL-010
  it('без права змінювати: запис без підйомника — без кнопки «Видалити»', async () => {
    byDay['2026-10-15'] = [slot('u', '2026-10-15T13:00', '2026-10-15T15:00', { liftId: null })];
    await renderDay({ canManageSlots: false });
    await waitFor(() => expect(screen.getByText('Наряд WO-u')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Видалити слот/ })).toBeNull();
  });
});

describe('Вид «День» — завантаження підйомника (BR-CAL-011)', () => {
  // guards: BR-CAL-011
  it('«N год з M» під назвою підйомника: сума записів у межах годин, 0 — без записів', async () => {
    byDay['2026-10-15'] = [
      slot('a', '2026-10-15T08:00', '2026-10-15T10:00'),
      slot('b', '2026-10-15T11:00', '2026-10-15T13:30'),
      // Виходить за кінець робочих годин (20:00) — рахується до 20:00.
      slot('c', '2026-10-15T19:00', '2026-10-15T22:00'),
    ];
    await renderDay();
    await waitFor(() =>
      expect(screen.getAllByTestId('lift-load').map(el => el.textContent)).toEqual([
        '5,5 год з 12',
        '0 год з 12',
      ]),
    );
  });

  // guards: BR-CAL-011
  it('записи скасованих і видалених нарядів не входять у «N год з M»', async () => {
    byDay['2026-10-15'] = [
      slot('a', '2026-10-15T08:00', '2026-10-15T10:00'),
      slot('cn', '2026-10-15T10:00', '2026-10-15T13:00', { workOrderStatus: 'CANCELLED' }),
      slot('del', '2026-10-15T13:00', '2026-10-15T16:00', { workOrderDeleted: true }),
    ];
    await renderDay();
    await waitFor(() =>
      expect(screen.getAllByTestId('lift-load').map(el => el.textContent)).toEqual([
        '2 год з 12',
        '0 год з 12',
      ]),
    );
  });
});

describe('Вид «День» — чернетка запису', () => {
  // Текст часу чернетки — «кнопка» (`attributes` useDraggable), а сенсор лише вказівний: без
  // власного onKeyDown Enter і пробіл форму не відкривали (клас Bug #877).
  // Mutation-verify: прибрати onKeyDown зі span чернетки → Enter не кличе openFormFromPending.
  it('чернетка відкривається з клавіатури — Enter і пробіл, інші клавіші ні', async () => {
    const open = vi.fn();
    function PendingHarness() {
      const state = useCalendarState({ canManageSlots: true });
      return (
        <CalendarDayGrid
          state={{
            ...state,
            pendingSlot: { liftId: 'lift-1', startH: 10, endH: 12 },
            openFormFromPending: open,
          }}
        />
      );
    }
    renderWithQueryClient(<PendingHarness />);
    await screen.findByText('10:00–12:00');
    // Сітка перемонтовується, коли довантаження дня завершується: у повному прогоні знайдений
    // елемент уже від'єднаний, і подія на ньому нікуди не доходить. Тому — дочекатися оновлень і
    // шукати елемент заново перед кожною подією.
    await act(async () => {});
    const text = () => screen.getByText('10:00–12:00');
    expect(text()).toHaveAttribute('role', 'button');
    fireEvent.keyDown(text(), { key: 'a' });
    expect(open).not.toHaveBeenCalled();
    fireEvent.keyDown(text(), { key: 'Enter' });
    fireEvent.keyDown(text(), { key: ' ' });
    expect(open).toHaveBeenCalledTimes(2);
  });
});
