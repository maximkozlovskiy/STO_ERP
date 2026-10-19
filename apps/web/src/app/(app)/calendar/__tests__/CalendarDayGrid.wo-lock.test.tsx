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
