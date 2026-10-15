// Календар, вид «Місяць»: картки записів дня (BR-CAL-009, рішення власника 2026-10-15) —
// до 3 карток за часом початку, «ще N», текст картки (механік — лише номер наряду), клік по
// картці відкриває запис, дії клітинки «Відкрити день» і «Новий запис на цю дату».

import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CalendarMonthView } from '../CalendarMonthView';
import { MONTH_CARD_LIMIT, buildMonthSlots, monthCards } from '../calendar-month';
import type { CalendarSlot, MonthSlots } from '../calendar.types';

const NOW = new Date('2026-10-15T12:00:00+03:00').getTime();
const DAY = '2026-10-20';

/** Слот 20.10 о `hh:mm` київського часу (жовтень до 25-го — UTC+3), 1 година. */
const slot = (id: string, hhmm: string, extra: Partial<CalendarSlot> = {}): CalendarSlot => {
  const start = new Date(`${DAY}T${hhmm}:00+03:00`);
  return {
    id,
    startAt: start.toISOString(),
    endAt: new Date(start.getTime() + 3_600_000).toISOString(),
    type: 'WORK',
    ...extra,
  };
};

const monthOf = (slots: CalendarSlot[], day = DAY): MonthSlots =>
  buildMonthSlots([{ d: day, slots }], [day]);

function renderMonth(
  monthSlots: MonthSlots,
  handlers: Partial<{
    onDayClick: (d: string) => void;
    onOpenSlot: (s: CalendarSlot) => void;
    onNewOnDate: (d: string) => void;
  }> = {},
) {
  return render(
    <CalendarMonthView
      yearMonth="2026-10"
      monthSlots={monthSlots}
      monthLoading={false}
      monthError={false}
      nowMs={NOW}
      onDayClick={handlers.onDayClick ?? (() => {})}
      onOpenSlot={handlers.onOpenSlot ?? (() => {})}
      onNewOnDate={handlers.onNewOnDate ?? (() => {})}
    />,
  );
}

const cell = (day = DAY) => {
  const el = document.querySelector<HTMLElement>(`[data-date="${day}"]`);
  if (!el) throw new Error(`немає клітинки ${day}`);
  return el;
};

describe('monthCards — відбір карток дня (BR-CAL-009)', () => {
  // guards: BR-CAL-009
  it('не більше трьох карток, за часом початку; решта — у «ще N»', () => {
    const month = monthOf([
      slot('d', '15:00'),
      slot('a', '09:00'),
      slot('e', '17:00'),
      slot('c', '13:00'),
      slot('b', '11:00'),
    ]);
    const { cards, more } = monthCards(month[DAY].entries);
    expect(MONTH_CARD_LIMIT).toBe(3);
    expect(cards.map(c => c.slot.id)).toEqual(['a', 'b', 'c']);
    expect(more).toBe(2);
  });

  it('три записи й менше — без «ще»', () => {
    const { cards, more } = monthCards(
      monthOf([slot('a', '09:00'), slot('b', '10:00')])[DAY].entries,
    );
    expect(cards).toHaveLength(2);
    expect(more).toBe(0);
  });
});

describe('CalendarMonthView — картки записів дня (BR-CAL-009)', () => {
  // guards: BR-CAL-009
  it('показує три картки за часом і «ще 2», яке відкриває вид «День»', () => {
    const onDayClick = vi.fn();
    renderMonth(
      monthOf([
        slot('d', '15:00', { workOrderNumber: 'WO-4' }),
        slot('a', '09:00', { workOrderNumber: 'WO-1' }),
        slot('e', '17:00', { workOrderNumber: 'WO-5' }),
        slot('c', '13:00', { workOrderNumber: 'WO-3' }),
        slot('b', '11:00', { workOrderNumber: 'WO-2' }),
      ]),
      { onDayClick },
    );
    const cards = within(cell()).getAllByTestId('month-slot-card');
    expect(cards.map(c => c.textContent)).toEqual(['09:00WO-1', '11:00WO-2', '13:00WO-3']);
    const more = within(cell()).getByRole('button', { name: 'Ще 2 — відкрити день 20.10.2026' });
    expect(more).toHaveTextContent('ще 2');
    fireEvent.click(more);
    expect(onDayClick).toHaveBeenCalledWith(DAY);
  });

  // guards: BR-CAL-009
  it('картка: номер наряду й клієнт, смуга й іконка — за категорією, тип — у назві', () => {
    renderMonth(
      monthOf([
        slot('a', '09:00', {
          workOrderNumber: 'WO-000123',
          workOrderStatus: 'IN_PROGRESS',
          counterpartyName: 'Петренко Іван',
        }),
      ]),
    );
    const card = within(cell()).getByTestId('month-slot-card');
    expect(card).toHaveTextContent('09:00WO-000123· Петренко Іван');
    // Номер — природної ширини, клієнт — лише залишок місця (`flex-1`, база 0), тож першим
    // обрізається клієнт, а не номер наряду.
    expect(within(card).getByText('WO-000123')).not.toHaveClass('flex-1');
    expect(within(card).getByText('· Петренко Іван')).toHaveClass('flex-1', 'truncate');
    expect(card).toHaveAttribute('data-category', 'inProgress');
    expect(card).toHaveClass('border-l-warning');
    expect(card).toHaveAccessibleName('09:00 WO-000123 · Петренко Іван. Робота. В роботі');
    // Повний опис — у підказці: час до кінця, статус наряду.
    expect(card.getAttribute('title')).toContain('09:00–10:00');
    expect(card.getAttribute('title')).toContain('WO-000123 · В роботі');
  });

  // guards: BR-CAL-009
  it('механік (API без клієнта) бачить лише номер наряду', () => {
    renderMonth(
      monthOf([slot('a', '09:00', { workOrderNumber: 'WO-7', workOrderStatus: 'APPROVED' })]),
    );
    const card = within(cell()).getByTestId('month-slot-card');
    expect(card).toHaveTextContent(/^09:00WO-7$/);
    expect(card).toHaveAttribute('data-category', 'planned');
  });

  // guards: BR-CAL-009
  it('запис без наряду — «Без наряду» (+ клієнт чи примітка), іконка типу з назвою', () => {
    renderMonth(
      monthOf([
        slot('a', '09:00', { type: 'BREAK', notes: 'Обід' }),
        slot('b', '10:00', { counterpartyName: 'ТОВ Ромашка' }),
      ]),
    );
    const [brk, client] = within(cell()).getAllByTestId('month-slot-card');
    expect(brk).toHaveTextContent('09:00Без наряду· Обід');
    expect(brk).toHaveAttribute('data-category', 'other');
    expect(brk).toHaveAccessibleName('09:00 Без наряду · Обід. Перерва. Без наряду');
    expect(client).toHaveTextContent('10:00Без наряду· ТОВ Ромашка');
  });

  // guards: BR-CAL-009
  it('клік по картці відкриває САМЕ цей запис і не перемикає на вид «День»', () => {
    const onOpenSlot = vi.fn();
    const onDayClick = vi.fn();
    const s = slot('a', '09:00', { workOrderNumber: 'WO-1' });
    renderMonth(monthOf([s, slot('b', '10:00')]), { onOpenSlot, onDayClick });
    fireEvent.click(within(cell()).getAllByTestId('month-slot-card')[0]);
    expect(onOpenSlot).toHaveBeenCalledTimes(1);
    expect(onOpenSlot).toHaveBeenCalledWith(s);
    expect(onDayClick).not.toHaveBeenCalled();
  });

  it('клік по вільному місцю клітинки — вид «День» на цю дату', () => {
    const onDayClick = vi.fn();
    renderMonth(monthOf([slot('a', '09:00')]), { onDayClick });
    fireEvent.click(cell());
    expect(onDayClick).toHaveBeenCalledWith(DAY);
  });

  // guards: BR-CAL-009
  it('дії клітинки — кнопки з назвами: «Відкрити день» і «Новий запис на цю дату»', () => {
    const onDayClick = vi.fn();
    const onNewOnDate = vi.fn();
    renderMonth({}, { onDayClick, onNewOnDate });
    fireEvent.click(screen.getByRole('button', { name: 'Відкрити день 20.10.2026' }));
    expect(onDayClick).toHaveBeenCalledWith(DAY);
    fireEvent.click(screen.getByRole('button', { name: 'Новий запис на 20.10.2026' }));
    expect(onNewOnDate).toHaveBeenCalledWith(DAY);
    expect(onDayClick).toHaveBeenCalledTimes(1);
  });

  it('минулий день: «Відкрити день» є, «Новий запис» — ні (у минуле форма не створює)', () => {
    renderMonth({});
    expect(screen.getByRole('button', { name: 'Відкрити день 14.10.2026' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Новий запис на 14.10.2026' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Новий запис на 15.10.2026' })).toBeInTheDocument();
  });

  it('клітинка не є кнопкою — усередині кнопки карток і дій', () => {
    renderMonth(monthOf([slot('a', '09:00')]));
    expect(cell().tagName).toBe('DIV');
    expect(cell().querySelector('button button')).toBeNull();
  });
});
