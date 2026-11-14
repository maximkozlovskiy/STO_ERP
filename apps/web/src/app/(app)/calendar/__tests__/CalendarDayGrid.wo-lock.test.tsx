// Вид «День» (BR-WO-027, рішення власника 2026-10-18): запис наряду, чий статус не дозволяє
// картці змінювати дати («В роботі», «Призупинено», «Виконано»…), не перетягується й не
// розтягується — без ручок зміни меж і курсору перетягування, з підказкою причини; відкривається
// кліком і з клавіатури. Запис наряду в редагованому статусі й запис без наряду — як раніше.
// BR-WO-026 (рішення власника 2026-10-19): такий запис і не видаляється з переліку «Без підйомника»,
// крім запису скасованого наряду.

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithQueryClient } from '@/__tests__/query-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarSlot } from '../calendar.types';

const params = new URLSearchParams('view=day&date=2026-10-15');
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => params,
}));

const apiFetch = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (url: string, init?: unknown) => apiFetch(url, init),
}));

import { CalendarDayGrid } from '../CalendarDayGrid';
import { useCalendarState } from '../useCalendarState';

const iso = (local: string) => new Date(`${local}:00+03:00`).toISOString();

const slot = (id: string, start: string, extra: Partial<CalendarSlot> = {}): CalendarSlot => ({
  id,
  liftId: 'lift-1',
  startAt: iso(`2026-10-15T${start}`),
  endAt: iso(`2026-10-15T${String(Number(start.slice(0, 2)) + 1).padStart(2, '0')}:00`),
  workOrderId: `wo-${id}`,
  workOrderNumber: `WO-${id}`,
  workOrderStatus: 'APPROVED',
  type: 'WORK',
  ...extra,
});

let daySlots: CalendarSlot[] = [];

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date('2026-10-15T09:00:00+03:00'));
  daySlots = [];
  apiFetch.mockReset();
  apiFetch.mockImplementation((url: string) => {
    if (url === '/calendar/slots?date=2026-10-15') return Promise.resolve(daySlots);
    if (url.startsWith('/calendar/slots?date=')) return Promise.resolve([]);
    if (url.startsWith('/lifts')) return Promise.resolve([{ id: 'lift-1', name: 'Підйомник 1' }]);
    if (url.startsWith('/settings/work-hours'))
      return Promise.resolve({ workStartHour: 8, workEndHour: 20 });
    return Promise.resolve({ items: [] });
  });
});

afterEach(() => {
  vi.useRealTimers();
  sessionStorage.clear();
});

let editing: string | null = null;
function Harness() {
  const state = useCalendarState();
  editing = state.editingSlotId;
  return <CalendarDayGrid state={state} />;
}

async function renderDay() {
  renderWithQueryClient(<Harness />);
  await waitFor(() => expect(screen.getAllByTestId('lift-load')).toHaveLength(1));
  await waitFor(() => expect(screen.queryByLabelText('Завантаження')).not.toBeInTheDocument());
}

const block = (number: string) =>
  screen.getByText(number).closest<HTMLElement>('[data-calendar-slot]')!;

describe('Вид «День» — запис наряду не в редагованому статусі (BR-WO-027)', () => {
  // guards: BR-WO-027
  it.each([
    ['IN_PROGRESS', 'В роботі'],
    ['ON_HOLD', 'Призупинено'],
    ['COMPLETED', 'Виконано'],
  ])('наряд «%s»: без ручок і курсору перетягування, підказка причини', async (status, label) => {
    daySlots = [slot('lk', '13:00', { workOrderStatus: status })];
    await renderDay();

    const el = block('WO-lk');
    expect(el.dataset.timeLocked).toBe('true');
    expect(el.querySelectorAll('[data-part^="resize-"]')).toHaveLength(0);
    expect(el.querySelector('.cursor-grab')).toBeNull();
    expect(el.querySelector('[data-part="content"]')).toHaveClass('cursor-pointer');
    expect(el.querySelector('[data-part="content"]')).not.toHaveAttribute('aria-roledescription');
    expect(el.title).toContain(`Наряд «${label}»: час і підйомник запису не змінюються`);
    expect(el).toHaveTextContent('час і підйомник запису не змінюються');
  });

  // guards: BR-WO-027
  it('такий запис відкривається кліком і з клавіатури', async () => {
    daySlots = [slot('lk', '13:00', { workOrderStatus: 'IN_PROGRESS' })];
    await renderDay();

    const content = block('WO-lk').querySelector<HTMLElement>('[data-part="content"]')!;
    expect(content).toHaveAttribute('role', 'button');
    fireEvent.keyDown(content, { key: 'Enter' });
    await waitFor(() => expect(editing).toBe('lk'));
  });

  // guards: BR-WO-027
  it('контроль: наряд «Затверджено» і запис без наряду — ручки й курсор перетягування є', async () => {
    daySlots = [
      slot('ok', '10:00'),
      slot('pl', '15:00', {
        workOrderId: null,
        workOrderNumber: undefined,
        workOrderStatus: null,
        counterpartyName: 'Без наряду',
      }),
    ];
    await renderDay();

    for (const el of [block('WO-ok'), block('Без наряду')]) {
      expect(el.dataset.timeLocked).toBeUndefined();
      expect(el.querySelectorAll('[data-part^="resize-"]')).toHaveLength(2);
      expect(el.querySelector('[data-part="content"]')).toHaveClass('cursor-grab');
      expect(el.title).not.toContain('не змінюються');
    }
  });
});

// Рішення власника 2026-10-30 / 2026-11-13 (TECH-DEBT (б) №66, №92): внутрішні межі ланцюжка
// наряду й ручного запису не тягнуться.
describe('Вид «День» — ручки ланцюжка наряду (BR-WO-024)', () => {
  const handles = (el: HTMLElement) =>
    [...el.querySelectorAll<HTMLElement>('[data-part^="resize-"]')].map(h => h.dataset.part);

  // guards: BR-WO-024
  it('перший день — лише ручка початку, продовження посередині — жодної, останній — лише кінця', async () => {
    const later = iso('2026-10-17T12:00');
    daySlots = [
      slot('a', '09:00', { chainDays: 3, chainEndAt: later }),
      slot('m', '12:00', { parentSlotId: 'x', chainDays: 3, chainEndAt: later }),
      slot('z', '15:00', { parentSlotId: 'x', chainDays: 3, chainEndAt: iso('2026-10-15T16:00') }),
    ];
    await renderDay();

    expect(handles(block('WO-a'))).toEqual(['resize-start']);
    expect(handles(block('WO-m'))).toEqual([]);
    expect(handles(block('WO-z'))).toEqual(['resize-end']);
    // Блок перетягується цілком (BR-WO-023) — курсор перетягування лишається.
    expect(block('WO-m').querySelector('[data-part="content"]')).toHaveClass('cursor-grab');
  });

  // guards: BR-CAL-020
  it('ручний ланцюжок (без наряду) — так само: внутрішніх ручок немає, крайні є (TECH-DEBT №92)', async () => {
    const manual = { workOrderId: null, workOrderNumber: undefined, workOrderStatus: null };
    daySlots = [
      slot('r', '10:00', {
        ...manual,
        counterpartyName: 'Середній день',
        parentSlotId: 'x',
        chainDays: 3,
        chainEndAt: iso('2026-10-16T12:00'),
      }),
      slot('f', '13:00', {
        ...manual,
        counterpartyName: 'Перший день',
        chainDays: 2,
        chainEndAt: iso('2026-10-16T12:00'),
      }),
    ];
    await renderDay();
    expect(handles(block('Середній день'))).toEqual([]);
    expect(handles(block('Перший день'))).toEqual(['resize-start']);
    // Блок перетягується цілком — з усім ланцюжком (BR-CAL-020).
    expect(block('Середній день').querySelector('[data-part="content"]')).toHaveClass(
      'cursor-grab',
    );
  });
});

// Рішення власника 2026-11-14 (TECH-DEBT (б) №97): запис, чий ланцюжок уже почався, не
// переноситься — без перетягування й ручки початку, ручка кінця останнього дня лишається.
describe('Вид «День» — розпочатий запис (BR-CAL-020, BR-WO-024, №97)', () => {
  const handles = (el: HTMLElement) =>
    [...el.querySelectorAll<HTMLElement>('[data-part^="resize-"]')].map(h => h.dataset.part);
  const HINT = 'Запис уже почався: не переноситься — змінюйте кінець останнього дня';

  // guards: BR-CAL-020, BR-WO-024
  it.each([
    ['ручний', { workOrderId: null, workOrderNumber: undefined, workOrderStatus: null }],
    ['наряду', {}],
  ])(
    '%s запис, що почався о 08:00: без перетягування й ручки початку, кінець — є',
    async (_l, o) => {
      daySlots = [slot('st', '08:00', { ...o, counterpartyName: 'Розпочатий' })];
      await renderDay();

      const el = block('Розпочатий');
      expect(el.dataset.started).toBe('true');
      expect(handles(el)).toEqual(['resize-end']);
      expect(el.querySelector('.cursor-grab')).toBeNull();
      expect(el.querySelector('[data-part="content"]')).toHaveAttribute('role', 'button');
      expect(el.title).toContain(HINT);
      expect(el).toHaveTextContent(HINT);
    },
  );

  // guards: BR-CAL-020
  it('частина сьогодні з 10:00 ланцюжка, що почався вчора, — теж (chainStartAt)', async () => {
    daySlots = [
      slot('cn', '10:00', {
        workOrderId: null,
        workOrderNumber: undefined,
        workOrderStatus: null,
        counterpartyName: 'Другий день',
        parentSlotId: 'x',
        chainDays: 2,
        chainStartAt: iso('2026-10-14T16:00'),
        chainEndAt: iso('2026-10-15T11:00'),
      }),
    ];
    await renderDay();

    expect(handles(block('Другий день'))).toEqual(['resize-end']);
    expect(block('Другий день').querySelector('.cursor-grab')).toBeNull();
  });

  // guards: BR-CAL-020
  it('контроль: запис із 10:00 (ще не почався) — перетягується, обидві ручки', async () => {
    daySlots = [slot('fu', '10:00', { counterpartyName: 'Майбутній' })];
    await renderDay();

    const el = block('Майбутній');
    expect(el.dataset.started).toBeUndefined();
    expect(handles(el)).toEqual(['resize-start', 'resize-end']);
    expect(el.querySelector('[data-part="content"]')).toHaveClass('cursor-grab');
    expect(el.title).not.toContain(HINT);
  });
});

// Рішення власника 2026-10-19: запис наряду видаляється лише в редагованому статусі.
describe('Вид «День» — видалення запису наряду з переліку «Без підйомника» (BR-WO-026)', () => {
  // guards: BR-WO-026
  it('наряд «В роботі»: кнопка видалення недоступна, причина в підказці; DELETE не йде', async () => {
    daySlots = [slot('lk', '13:00', { liftId: null, workOrderStatus: 'IN_PROGRESS' })];
    await renderDay();

    const hint =
      'Запис наряду в статусі «В роботі» не видаляється — лише в статусах «Чернетка», «Кошторис», «Затверджено» або «Скасовано»';
    // Назва лишає час запису (кілька заблокованих кошиків не звучать однаково), причина — описом.
    const btn = await screen.findByRole('button', { name: /^Видалити слот 13:00/ });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAccessibleDescription(hint);
    expect(btn.parentElement).toHaveAttribute('title', hint);
    fireEvent.click(btn);
    expect(screen.queryByText('Видалити слот?')).toBeNull();
    expect(apiFetch).not.toHaveBeenCalledWith(
      expect.stringMatching(/^\/calendar\/slots\/lk$/),
      expect.anything(),
    );
  });

  // Рішення власника 2026-10-19: запис скасованого наряду видаляється (дати наряду ті самі).
  // guards: BR-WO-026
  it('скасований наряд: кнопка «Видалити слот» доступна без підказки блокування', async () => {
    daySlots = [slot('cn', '14:00', { liftId: null, workOrderStatus: 'CANCELLED' })];
    await renderDay();

    const btn = await screen.findByRole('button', { name: /^Видалити слот 14:00/ });
    expect(btn).not.toBeDisabled();
    expect(btn).not.toHaveAccessibleDescription();
    expect(btn.parentElement).toHaveAttribute('title', 'Видалити слот');
  });

  // Рішення власника №68: і в минулому дні — як у формі запису (CalendarSlotModal.read-only).
  // guards: BR-WO-026
  it('скасований наряд у минулому дні: кнопка «Видалити слот» доступна без підказки блокування', async () => {
    vi.setSystemTime(new Date('2026-10-17T12:00:00+03:00'));
    daySlots = [slot('pc', '14:00', { liftId: null, workOrderStatus: 'CANCELLED' })];
    await renderDay();

    const btn = await screen.findByRole('button', { name: /^Видалити слот 14:00/ });
    expect(btn).not.toBeDisabled();
    expect(btn).not.toHaveAccessibleDescription();
    expect(btn.parentElement).toHaveAttribute('title', 'Видалити слот');
  });

  // guards: BR-WO-026
  it('контроль: наряд «Затверджено» і запис без наряду — кнопка «Видалити слот» доступна', async () => {
    daySlots = [
      slot('ok', '10:00', { liftId: null }),
      slot('pl', '15:00', {
        liftId: null,
        workOrderId: null,
        workOrderNumber: undefined,
        workOrderStatus: null,
      }),
    ];
    await renderDay();

    const buttons = await screen.findAllByRole('button', { name: /^Видалити слот/ });
    expect(buttons).toHaveLength(2);
    for (const b of buttons) {
      expect(b).not.toBeDisabled();
      expect(b).not.toHaveAccessibleDescription();
      expect(b.parentElement).toHaveAttribute('title', 'Видалити слот');
    }
  });
});
