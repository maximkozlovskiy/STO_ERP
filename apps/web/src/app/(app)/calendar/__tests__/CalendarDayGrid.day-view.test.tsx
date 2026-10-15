// Вид «День» (BR-CAL-011) через справжній useCalendarState: блок запису в кольорі категорії
// (прострочення — за кінцем ланцюжка з довантаженим наступним днем), механік на блоці, лінія
// «зараз» лише сьогодні з оновленням щохвилини, завантаження підйомника «N год з M».

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  const view = render(<Harness {...opts} />);
  await waitFor(() => expect(screen.getAllByTestId('lift-load')).toHaveLength(2));
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
});
