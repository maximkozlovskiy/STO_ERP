// Форма запису наряду (рішення власника 2026-10-18):
// - BR-WO-027: наряд не в редагованому статусі — час, тривалість, підйомник, клієнт і наряд запису
//   недоступні з підказкою; механік і нотатки — доступні, «Оновити» лишається;
// - BR-WO-026: «Видалити» запису наряду попереджає, що планові дати наряду буде стерто; у
//   нередагованому статусі наряду «Видалити» недоступна з підказкою (рішення власника 2026-10-19),
//   крім скасованого наряду — запис видаляється, дати наряду не змінюються.

import { fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api-client', () => ({
  apiFetch: vi.fn(() => Promise.resolve({ items: [] })),
}));
// Картки наряду й клієнта форма вантажить ліниво — тут вони не відкриваються.
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('@/components/ui/CounterpartyEditModal', () => ({ CounterpartyEditModal: () => null }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/calendar',
}));

import { CalendarSlotModal } from '../CalendarSlotModal';
import { EMPTY_FORM } from '../useCalendarState';

const WO_ID = '11111111-1111-4111-8111-111111111111';

function renderForm(editingWorkOrder: { number: string; lockedStatus: string | null } | null) {
  return render(
    <CalendarSlotModal
      open
      onClose={() => {}}
      onSaved={() => {}}
      onDeleted={() => {}}
      date="2026-10-20"
      lifts={[{ id: 'lift-1', name: 'П1' } as never]}
      form={{
        ...EMPTY_FORM,
        liftId: 'lift-1',
        startAt: '10:00',
        endAt: '11:00',
        normoHours: '1',
        workOrderId: editingWorkOrder ? WO_ID : '',
        workOrderDisplay: editingWorkOrder ? editingWorkOrder.number : '',
        counterpartyDisplay: 'Клієнт',
        notes: 'Примітка',
      }}
      setForm={() => {}}
      editingSlotId="slot-1"
      isEditingPast={false}
      editingWorkOrder={editingWorkOrder}
      pendingSlot={null}
      setPendingSlot={() => {}}
      formMounted
      formVisible
      formCollapseRef={createRef<HTMLDivElement>()}
      formInnerRef={createRef<HTMLDivElement>()}
      minHour={8}
      windowStart={8}
      windowEnd={20}
      nowMs={new Date('2026-10-15T12:00:00+03:00').getTime()}
      error=""
      setError={() => {}}
      saving={false}
      setSaving={() => {}}
      cpDisplay=""
      setCpDisplay={() => {}}
    />,
  );
}

const liftSelect = () => screen.getByLabelText(/Підйомник/) as HTMLSelectElement;
const mechanicSelect = () => screen.getByLabelText('Механік') as HTMLSelectElement;
const pickerInput = (label: string) =>
  screen.getByText(label).parentElement!.querySelector('input')!;
const fieldInput = (label: string) =>
  screen.getByText(label).closest('div')!.querySelector('input')!;

describe('CalendarSlotModal — запис наряду не в редагованому статусі (BR-WO-027)', () => {
  // guards: BR-WO-027
  it('«В роботі»: час, тривалість, підйомник і наряд недоступні з підказкою; механік і нотатки — ні', () => {
    renderForm({ number: 'НРД-1', lockedStatus: 'IN_PROGRESS' });

    expect(screen.getByTestId('slot-wo-time-locked')).toHaveTextContent('«В роботі»');
    expect(liftSelect()).toBeDisabled();
    expect(pickerInput('Початок')).toBeDisabled();
    expect(pickerInput('Кінець')).toBeDisabled();
    expect(fieldInput('Норм-год')).toBeDisabled();
    expect(screen.queryByTitle('Новий наряд')).toBeNull();
    expect(screen.queryByTitle('Новий клієнт')).toBeNull();

    expect(mechanicSelect()).not.toBeDisabled();
    expect(screen.getByDisplayValue('Примітка')).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Оновити' })).toBeInTheDocument();
  });

  // guards: BR-WO-027
  it('контроль: наряд «Кошторис» — поля доступні, підказки немає', () => {
    renderForm({ number: 'НРД-1', lockedStatus: null });

    expect(screen.queryByTestId('slot-wo-time-locked')).toBeNull();
    expect(liftSelect()).not.toBeDisabled();
    expect(pickerInput('Початок')).not.toBeDisabled();
    expect(fieldInput('Норм-год')).not.toBeDisabled();
    expect(screen.getByTitle('Новий наряд')).toBeInTheDocument();
  });
});

describe('CalendarSlotModal — видалення запису наряду (BR-WO-026)', () => {
  // guards: BR-WO-026
  it('«Видалити» запису наряду — підтвердження, що планові дати наряду буде стерто', async () => {
    renderForm({ number: 'НРД-1', lockedStatus: null });

    fireEvent.click(screen.getByRole('button', { name: /Видалити/ }));

    expect(await screen.findByText(/планові дати наряду/)).toHaveTextContent('НРД-1');
  });

  // guards: BR-WO-026
  it('наряд «В роботі»: «Видалити» недоступна, причина в підказці й для читача екрана; підтвердження немає', async () => {
    renderForm({ number: 'НРД-1', lockedStatus: 'IN_PROGRESS' });

    const hint =
      'Запис наряду в статусі «В роботі» не видаляється — лише в статусах «Чернетка», «Кошторис», «Затверджено» або «Скасовано»';
    const btn = screen.getByRole('button', { name: /Видалити/ });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAccessibleDescription(hint);
    expect(screen.getByTestId('slot-delete-wrap')).toHaveAttribute('title', hint);
    fireEvent.click(btn);
    expect(screen.queryByText(/планові дати наряду/)).toBeNull();
  });

  // Рішення власника 2026-10-19: запис скасованого наряду видаляється, дати наряду ті самі.
  // guards: BR-WO-026
  it('скасований наряд: «Видалити» доступна, підтвердження — дати наряду не зміняться', async () => {
    renderForm({ number: 'НРД-1', lockedStatus: 'CANCELLED' });

    // Час і підйомник лишаються заблокованими, підказка каже, що запис видалити можна.
    expect(screen.getByTestId('slot-wo-time-locked')).toHaveTextContent(
      'а запис — видалити (дати наряду не зміняться)',
    );
    const btn = screen.getByRole('button', { name: /Видалити/ });
    expect(btn).not.toBeDisabled();
    expect(btn).not.toHaveAccessibleDescription();
    expect(screen.getByTestId('slot-delete-wrap')).not.toHaveAttribute('title');
    fireEvent.click(btn);

    expect(await screen.findByText(/скасованого наряду НРД-1/)).toHaveTextContent(
      'дати наряду не зміняться',
    );
    expect(screen.queryByText(/планові дати наряду/)).toBeNull();
  });

  // guards: BR-WO-026
  it('контроль: наряд «Кошторис» — «Видалити» доступна без підказки', () => {
    renderForm({ number: 'НРД-1', lockedStatus: null });

    expect(screen.getByRole('button', { name: /Видалити/ })).not.toBeDisabled();
    expect(screen.getByTestId('slot-delete-wrap')).not.toHaveAttribute('title');
  });

  // guards: BR-WO-026
  it('запис без наряду — звичайне підтвердження', async () => {
    renderForm(null);

    fireEvent.click(screen.getByRole('button', { name: /Видалити/ }));

    expect(await screen.findByText('Цю дію не можна скасувати.')).toBeInTheDocument();
    expect(screen.queryByText(/планові дати/)).toBeNull();
  });
});
