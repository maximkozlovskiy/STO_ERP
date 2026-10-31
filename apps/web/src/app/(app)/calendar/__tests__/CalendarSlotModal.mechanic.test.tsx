// Поле «Механік» у формі запису календаря (BR-CAL-012): лише механіки, закріплені за підйомником
// запису (`GET /employees?liftId=`); без підйомника поле недоступне; зміна підйомника скидає
// механіка, не закріпленого за новим; збережений механік, якого вже не можна обрати, — недоступна
// опція з поясненням.

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createRef, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const L1 = '11111111-1111-4111-8111-000000000001';
const L2 = '11111111-1111-4111-8111-000000000002';
const L3 = '11111111-1111-4111-8111-000000000003';
const KOVAL = '22222222-2222-4222-8222-000000000001';
const SHEVCHUK = '22222222-2222-4222-8222-000000000002';
const FIRED = '22222222-2222-4222-8222-000000000003';
const ON_LEAVE = '22222222-2222-4222-8222-000000000004';
const CP = '33333333-3333-4333-8333-000000000001';

const MECHANICS: Record<string, { id: string; firstName: string; lastName: string }[]> = {
  [L1]: [
    { id: KOVAL, firstName: 'Петро', lastName: 'Коваль' },
    { id: SHEVCHUK, firstName: 'Олена', lastName: 'Шевчук' },
  ],
  [L2]: [],
  [L3]: [{ id: KOVAL, firstName: 'Петро', lastName: 'Коваль' }],
};

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
import type { SavedMechanic, SlotForm } from '../calendar.types';

const FUTURE = '2026-10-20';
const LIFTS = [
  { id: L1, name: 'П1' },
  { id: L2, name: 'П2' },
  { id: L3, name: 'П3' },
];

function employeesCalls() {
  return apiFetch.mock.calls.map(c => String(c[0])).filter(u => u.startsWith('/employees'));
}

function Harness({
  initial,
  editingSlotId = null,
  saved = null,
  readOnly = false,
}: {
  initial: Partial<SlotForm>;
  editingSlotId?: string | null;
  saved?: SavedMechanic | null;
  readOnly?: boolean;
}) {
  const [form, setForm] = useState<SlotForm>({
    ...EMPTY_FORM,
    counterpartyId: CP,
    counterpartyDisplay: 'Клієнт',
    startAt: '10:00',
    endAt: '11:00',
    normoHours: '1',
    ...initial,
  });
  return (
    <>
      <output data-testid="employee-id">{form.employeeId}</output>
      <CalendarSlotModal
        open
        onClose={() => {}}
        onSaved={() => {}}
        onDeleted={() => {}}
        date={FUTURE}
        lifts={LIFTS}
        form={form}
        setForm={setForm}
        editingSlotId={editingSlotId}
        isEditingPast={false}
        readOnly={readOnly}
        savedMechanic={saved}
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
        cpDisplay="Клієнт"
        setCpDisplay={() => {}}
      />
    </>
  );
}

const mechanicSelect = () => screen.getByLabelText('Механік') as HTMLSelectElement;
const liftSelect = () => screen.getByLabelText(/Підйомник/) as HTMLSelectElement;
const optionTexts = () =>
  within(mechanicSelect())
    .getAllByRole('option')
    .map(o => o.textContent);
const employeeId = () => screen.getByTestId('employee-id').textContent;

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockImplementation((url: string) => {
    if (url.startsWith('/employees?')) {
      const liftId = new URLSearchParams(url.split('?')[1]).get('liftId') ?? '';
      return Promise.resolve({ items: MECHANICS[liftId] ?? [], total: 0 });
    }
    if (url.startsWith('/calendar/slots/check-conflicts')) {
      return Promise.resolve({ anyConflict: false, conflictSlots: [] });
    }
    // Одне авто клієнта — форма ставить його сама (без авто «Зберегти» недоступна).
    if (url.startsWith('/vehicles'))
      return Promise.resolve([
        { id: 'veh-1', make: 'Skoda', model: 'Octavia', licensePlate: null },
      ]);
    if (url === '/calendar/slots') return Promise.resolve({ slots: [{ id: 'new' }] });
    return Promise.resolve({ items: [] });
  });
});

describe('CalendarSlotModal — поле «Механік» (BR-CAL-012)', () => {
  // guards: BR-CAL-012
  it('пропонує лише механіків підйомника запису і «— без механіка —»', async () => {
    render(<Harness initial={{ liftId: L1 }} />);
    await waitFor(() => expect(optionTexts()).toContain('Коваль Петро'));
    expect(optionTexts()).toEqual(['— без механіка —', 'Коваль Петро', 'Шевчук Олена']);
    const [url] = employeesCalls();
    const params = new URLSearchParams(url.split('?')[1]);
    expect(params.get('liftId')).toBe(L1);
    expect(params.get('role')).toBe('MECHANIC');
  });

  // guards: BR-CAL-012
  it('без підйомника — поле недоступне з підказкою, працівників не читає', () => {
    render(<Harness initial={{ liftId: '' }} />);
    expect(mechanicSelect()).toBeDisabled();
    expect(mechanicSelect()).toHaveAccessibleDescription('Спершу оберіть підйомник');
    expect(employeesCalls()).toHaveLength(0);
  });

  // guards: BR-CAL-012
  it('за підйомником нікого не закріплено — підказка, лишається «без механіка»', async () => {
    render(<Harness initial={{ liftId: L2 }} />);
    await waitFor(() =>
      expect(mechanicSelect()).toHaveAccessibleDescription(
        'За підйомником не закріплено механіків',
      ),
    );
    expect(optionTexts()).toEqual(['— без механіка —']);
    expect(mechanicSelect()).toBeEnabled();
  });

  // guards: BR-CAL-012
  it('зміна підйомника скидає механіка, не закріпленого за новим; закріпленого — лишає', async () => {
    render(<Harness initial={{ liftId: L1 }} />);
    await waitFor(() => expect(optionTexts()).toContain('Коваль Петро'));
    fireEvent.change(mechanicSelect(), { target: { value: KOVAL } });
    expect(employeeId()).toBe(KOVAL);

    // П3: Коваль закріплений і там — лишається.
    fireEvent.change(liftSelect(), { target: { value: L3 } });
    await waitFor(() => expect(optionTexts()).toEqual(['— без механіка —', 'Коваль Петро']));
    expect(employeeId()).toBe(KOVAL);
    expect(mechanicSelect().value).toBe(KOVAL);

    // П2: за ним нікого — механіка скинуто.
    fireEvent.change(liftSelect(), { target: { value: L2 } });
    await waitFor(() => expect(employeeId()).toBe(''));

    // Підйомник прибрали — поле недоступне, механіка немає.
    fireEvent.change(liftSelect(), { target: { value: L1 } });
    await waitFor(() => expect(optionTexts()).toContain('Шевчук Олена'));
    fireEvent.change(mechanicSelect(), { target: { value: SHEVCHUK } });
    fireEvent.change(liftSelect(), { target: { value: '' } });
    await waitFor(() => expect(employeeId()).toBe(''));
    expect(mechanicSelect()).toBeDisabled();
  });

  // guards: BR-CAL-012
  it('збережений механік, якого вже не можна обрати, — недоступна опція з поясненням', async () => {
    render(
      <Harness
        initial={{ liftId: L1, employeeId: FIRED }}
        editingSlotId="slot-1"
        saved={{ liftId: L1, employeeId: FIRED, employeeName: null }}
      />,
    );
    await waitFor(() => expect(optionTexts()).toContain('Коваль Петро'));
    const unavailable = within(mechanicSelect()).getByRole('option', {
      name: 'Механік (недоступний)',
    }) as HTMLOptionElement;
    expect(unavailable).toBeDisabled();
    expect(mechanicSelect().value).toBe(FIRED);
    expect(employeeId()).toBe(FIRED);
    expect(mechanicSelect()).toHaveAccessibleDescription(
      'Механік звільнений, у відпустці або не закріплений за цим підйомником — оберіть іншого або «без механіка»',
    );

    // Збереження без зміни механіка шле того самого (сервер його не перевіряє).
    fireEvent.click(screen.getByRole('button', { name: 'Оновити' }));
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/calendar/slots/slot-1', expect.anything()),
    );
    const patch = apiFetch.mock.calls.find(c => c[0] === '/calendar/slots/slot-1')!;
    expect(JSON.parse(patch[1].body)).toMatchObject({ liftId: L1, employeeId: FIRED });

    // Зміна підйомника — недоступну опцію прибрано, механіка скинуто.
    fireEvent.change(liftSelect(), { target: { value: L3 } });
    await waitFor(() => expect(employeeId()).toBe(''));
    expect(optionTexts()).toEqual(['— без механіка —', 'Коваль Петро']);
  });

  // guards: BR-CAL-012
  it('збережений механік у відпустці — список підйомника його не пропонує, недоступна опція з ім’ям', async () => {
    // Сервер (`GET /employees?liftId=`) механіка у відпустці не віддає, хоч він і закріплений за
    // П1; ім'я запису (`employeeName`) приходить — він не звільнений.
    render(
      <Harness
        initial={{ liftId: L1, employeeId: ON_LEAVE }}
        editingSlotId="slot-1"
        saved={{ liftId: L1, employeeId: ON_LEAVE, employeeName: 'Бондар Андрій' }}
      />,
    );
    await waitFor(() => expect(optionTexts()).toContain('Коваль Петро'));
    const option = within(mechanicSelect()).getByRole('option', {
      name: 'Бондар Андрій (недоступний)',
    });
    expect(option).toBeDisabled();
    expect(optionTexts()).toEqual([
      '— без механіка —',
      'Бондар Андрій (недоступний)',
      'Коваль Петро',
      'Шевчук Олена',
    ]);
    expect(mechanicSelect()).toHaveAccessibleDescription(/у відпустці/);
  });

  // guards: BR-CAL-012
  it('збережений відкріплений механік з ім’ям — його ім’я в недоступній опції', async () => {
    render(
      <Harness
        initial={{ liftId: L2, employeeId: SHEVCHUK }}
        editingSlotId="slot-1"
        saved={{ liftId: L2, employeeId: SHEVCHUK, employeeName: 'Шевчук Олена' }}
      />,
    );
    await waitFor(() =>
      expect(
        within(mechanicSelect()).getByRole('option', { name: 'Шевчук Олена (недоступний)' }),
      ).toBeDisabled(),
    );
  });

  // guards: BR-CAL-012
  it('«— без механіка —» у зміні запису знімає механіка (employeeId: null)', async () => {
    render(
      <Harness
        initial={{ liftId: L1, employeeId: KOVAL }}
        editingSlotId="slot-1"
        saved={{ liftId: L1, employeeId: KOVAL, employeeName: 'Коваль Петро' }}
      />,
    );
    await waitFor(() => expect(optionTexts()).toContain('Шевчук Олена'));
    fireEvent.change(mechanicSelect(), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Оновити' }));
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/calendar/slots/slot-1', expect.anything()),
    );
    const patch = apiFetch.mock.calls.find(c => c[0] === '/calendar/slots/slot-1')!;
    expect(JSON.parse(patch[1].body).employeeId).toBeNull();
  });

  // guards: BR-CAL-012
  it('новий запис: обраний механік іде в POST', async () => {
    render(<Harness initial={{ liftId: L1 }} />);
    await waitFor(() => expect(optionTexts()).toContain('Шевчук Олена'));
    fireEvent.change(mechanicSelect(), { target: { value: SHEVCHUK } });
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти' }));
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        '/calendar/slots',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    const post = apiFetch.mock.calls.find(c => c[0] === '/calendar/slots')!;
    expect(JSON.parse(post[1].body)).toMatchObject({ liftId: L1, employeeId: SHEVCHUK });
  });

  // guards: BR-CAL-012
  it('400 «Механік не закріплений…» → перелік підйомника перечитано, відкріпленого механіка скинуто', async () => {
    const free = apiFetch.getMockImplementation()!;
    // Коваля відкріпили від П1 між відкриттям форми і збереженням.
    let unpinned = false;
    apiFetch.mockImplementation((url: string, init?: unknown) => {
      if (url === '/calendar/slots') {
        unpinned = true;
        return Promise.reject(new Error('Механік не закріплений за цим підйомником'));
      }
      if (unpinned && url.startsWith('/employees?'))
        return Promise.resolve({ items: [MECHANICS[L1][1]], total: 1 });
      return free(url, init);
    });
    render(<Harness initial={{ liftId: L1 }} />);
    await waitFor(() => expect(optionTexts()).toContain('Коваль Петро'));
    fireEvent.change(mechanicSelect(), { target: { value: KOVAL } });
    expect(employeesCalls()).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Зберегти' }));
    await waitFor(() => expect(employeesCalls()).toHaveLength(2));
    expect(new URLSearchParams(employeesCalls()[1].split('?')[1]).get('liftId')).toBe(L1);
    await waitFor(() => expect(optionTexts()).toEqual(['— без механіка —', 'Шевчук Олена']));
    // Скидання значення — наступний рендер після нового переліку: у повному прогоні під навантаженням
    // перевірка одразу після переліку бачила ще Коваля (2026-10-31).
    await waitFor(() => expect(employeeId()).toBe(''));
  });

  // guards: BR-CAL-012
  it('контроль: відмова без механіка у формі — перелік не перечитується', async () => {
    const free = apiFetch.getMockImplementation()!;
    apiFetch.mockImplementation((url: string, init?: unknown) =>
      url === '/calendar/slots' ? Promise.reject(new Error('Підйомник зайнятий')) : free(url, init),
    );
    render(<Harness initial={{ liftId: L1 }} />);
    await waitFor(() => expect(optionTexts()).toContain('Коваль Петро'));
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти' }));
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/calendar/slots', expect.anything()),
    );
    await new Promise(r => setTimeout(r, 0));
    expect(employeesCalls()).toHaveLength(1);
  });

  // guards: BR-CAL-010
  it('лише перегляд (механік): ім’я збереженого механіка, поле недоступне, без запиту працівників', () => {
    render(
      <Harness
        initial={{ liftId: L1, employeeId: KOVAL }}
        editingSlotId="slot-1"
        readOnly
        saved={{ liftId: L1, employeeId: KOVAL, employeeName: 'Коваль Петро' }}
      />,
    );
    expect(mechanicSelect()).toBeDisabled();
    expect(mechanicSelect().selectedOptions[0].textContent).toBe('Коваль Петро');
    expect(employeesCalls()).toHaveLength(0);
  });
});
