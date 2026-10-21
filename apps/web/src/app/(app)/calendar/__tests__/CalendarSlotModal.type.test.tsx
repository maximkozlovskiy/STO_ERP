// Поле «Тип запису» у формі запису календаря (BR-CAL-003, рішення власника 2026-10-21): тип
// обирають лише в новому записі; службовий тип (обслуговування, перерва, нарада) ховає клієнта,
// автомобіль і наряд і скидає їх; «Зберегти» без клієнта доступне, `POST` несе тип; у наявному
// записі тип недоступний, а `PATCH` типу не шле.

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createRef, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const L1 = '11111111-1111-4111-8111-000000000001';
const CP = '33333333-3333-4333-8333-000000000001';
const WO = '44444444-4444-4444-8444-000000000001';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiFetch }));
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('@/components/ui/CounterpartyEditModal', () => ({ CounterpartyEditModal: () => null }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/calendar',
}));

import { CalendarSlotModal } from '../CalendarSlotModal';
import { EMPTY_FORM } from '../useCalendarState';
import type { SlotForm } from '../calendar.types';

const FUTURE = '2026-10-20';

function Harness({
  initial,
  editingSlotId = null,
}: {
  initial: Partial<SlotForm>;
  editingSlotId?: string | null;
}) {
  const [form, setForm] = useState<SlotForm>({
    ...EMPTY_FORM,
    liftId: L1,
    startAt: '10:00',
    endAt: '11:00',
    normoHours: '1',
    ...initial,
  });
  return (
    <>
      <output data-testid="form">{JSON.stringify(form)}</output>
      <CalendarSlotModal
        open
        onClose={() => {}}
        onSaved={() => {}}
        onDeleted={() => {}}
        date={FUTURE}
        lifts={[{ id: L1, name: 'П1' }]}
        form={form}
        setForm={setForm}
        editingSlotId={editingSlotId}
        isEditingPast={false}
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
      />
    </>
  );
}

const typeSelect = () => screen.getByLabelText('Тип запису') as HTMLSelectElement;
const formState = () => JSON.parse(screen.getByTestId('form').textContent ?? '{}') as SlotForm;
const clientLabel = () => screen.queryByText('Клієнт');
const vehicleLabel = () => screen.queryByText('Автомобіль');
const workOrderLabel = () => screen.queryByText('Наряд');
const sentBody = (url: string) => {
  const call = apiFetch.mock.calls.find(c => c[0] === url);
  return call ? (JSON.parse((call[1] as { body: string }).body) as Record<string, unknown>) : null;
};

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockImplementation((url: string) => {
    if (url.startsWith('/calendar/slots/check-conflicts'))
      return Promise.resolve({ anyConflict: false, conflictSlots: [] });
    if (url.startsWith('/vehicles'))
      return Promise.resolve([
        { id: 'veh-1', make: 'Skoda', model: 'Octavia', licensePlate: null },
      ]);
    if (url === '/calendar/slots') return Promise.resolve({ slots: [{ id: 'new' }] });
    if (url.startsWith('/calendar/slots/')) return Promise.resolve({ id: 'slot-1' });
    return Promise.resolve({ items: [] });
  });
});

describe('CalendarSlotModal — тип запису (BR-CAL-003)', () => {
  // guards: BR-CAL-003
  it('новий запис: поле «Тип запису» доступне, чотири типи, типово «Робота» з клієнтом і нарядом', () => {
    render(<Harness initial={{}} />);
    expect(typeSelect()).toBeEnabled();
    expect(typeSelect().value).toBe('WORK');
    expect(
      within(typeSelect())
        .getAllByRole('option')
        .map(o => o.textContent),
    ).toEqual(['Робота', 'Обслуговування', 'Перерва', 'Нарада']);
    expect(clientLabel()).toBeInTheDocument();
    expect(vehicleLabel()).toBeInTheDocument();
    expect(workOrderLabel()).toBeInTheDocument();
  });

  // guards: BR-CAL-003
  it('«Перерва» ховає клієнта, автомобіль і наряд і скидає обрані', async () => {
    render(
      <Harness
        initial={{
          counterpartyId: CP,
          counterpartyDisplay: 'Клієнт Іван',
          workOrderId: WO,
          workOrderDisplay: 'НРД-1 · Клієнт Іван',
        }}
      />,
    );
    await waitFor(() => expect(formState().vehicleId).toBe('veh-1'));

    fireEvent.change(typeSelect(), { target: { value: 'BREAK' } });

    expect(clientLabel()).not.toBeInTheDocument();
    expect(vehicleLabel()).not.toBeInTheDocument();
    expect(workOrderLabel()).not.toBeInTheDocument();
    expect(formState()).toMatchObject({
      type: 'BREAK',
      counterpartyId: '',
      counterpartyDisplay: '',
      vehicleId: '',
      workOrderId: '',
      workOrderDisplay: '',
    });
  });

  // Телефон клієнта — окремий стан форми: службовий тип скидає і його, інакше після повернення
  // на «Роботу» під порожнім полем «Клієнт» лишався б телефон знятого клієнта.
  // guards: BR-CAL-003
  it('«Перерва» скидає й телефон клієнта: назад на «Роботу» — телефону знятого клієнта немає', async () => {
    const base = apiFetch.getMockImplementation()!;
    apiFetch.mockImplementation((url: string, init?: unknown) =>
      url === `/counterparties/${CP}`
        ? Promise.resolve({ phone: '+380671234567' })
        : base(url, init),
    );
    render(<Harness initial={{ counterpartyId: CP, counterpartyDisplay: 'Клієнт Іван' }} />);
    expect(await screen.findByText('+380671234567')).toBeInTheDocument();

    fireEvent.change(typeSelect(), { target: { value: 'BREAK' } });
    fireEvent.change(typeSelect(), { target: { value: 'WORK' } });

    expect(clientLabel()).toBeInTheDocument();
    expect(screen.queryByText('+380671234567')).not.toBeInTheDocument();
  });

  // guards: BR-CAL-003
  it('«Перерва» без клієнта: «Зберегти» доступне, POST несе тип і не несе клієнта, авто й наряду', async () => {
    render(<Harness initial={{ notes: 'Обід' }} />);
    // «Робота» без клієнта й наряду — зберегти не можна.
    expect(screen.getByRole('button', { name: 'Зберегти' })).toBeDisabled();

    fireEvent.change(typeSelect(), { target: { value: 'BREAK' } });
    const save = screen.getByRole('button', { name: 'Зберегти' });
    expect(save).toBeEnabled();
    fireEvent.click(save);

    await waitFor(() => expect(sentBody('/calendar/slots')).not.toBeNull());
    const body = sentBody('/calendar/slots')!;
    expect(body).toMatchObject({ type: 'BREAK', liftId: L1, notes: 'Обід' });
    expect(body).not.toHaveProperty('counterpartyId');
    expect(body).not.toHaveProperty('vehicleId');
    expect(body).not.toHaveProperty('workOrderId');
  });

  // guards: BR-CAL-003
  it('наявний службовий запис: тип недоступний з поясненням, полів клієнта немає, PATCH без типу', async () => {
    render(<Harness initial={{ type: 'MEETING', notes: 'Планірка' }} editingSlotId="slot-1" />);
    expect(typeSelect()).toBeDisabled();
    expect(typeSelect().value).toBe('MEETING');
    expect(typeSelect()).toHaveAccessibleDescription('Тип запису не змінюється після створення');
    expect(clientLabel()).not.toBeInTheDocument();
    expect(workOrderLabel()).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Оновити' }));

    await waitFor(() => expect(sentBody('/calendar/slots/slot-1')).not.toBeNull());
    const body = sentBody('/calendar/slots/slot-1')!;
    expect(body).not.toHaveProperty('type');
    expect(body).toMatchObject({ workOrderId: null, notes: 'Планірка' });
    expect(body).not.toHaveProperty('counterpartyId');
  });

  // guards: BR-CAL-003
  it('наявний запис «Робота»: тип теж недоступний', () => {
    render(<Harness initial={{ counterpartyId: CP }} editingSlotId="slot-1" />);
    expect(typeSelect()).toBeDisabled();
    expect(clientLabel()).toBeInTheDocument();
  });

  // guards: BR-CAL-003
  it('назад на «Роботу» — клієнт, автомобіль і наряд повертаються, без клієнта зберегти не можна', () => {
    render(<Harness initial={{}} />);
    fireEvent.change(typeSelect(), { target: { value: 'MAINTENANCE' } });
    expect(clientLabel()).not.toBeInTheDocument();

    fireEvent.change(typeSelect(), { target: { value: 'WORK' } });

    expect(clientLabel()).toBeInTheDocument();
    expect(vehicleLabel()).toBeInTheDocument();
    expect(workOrderLabel()).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Зберегти' })).toBeDisabled();
  });
});
