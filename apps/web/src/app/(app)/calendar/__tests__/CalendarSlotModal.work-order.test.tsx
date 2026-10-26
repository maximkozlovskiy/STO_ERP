// Наряд, створений із форми запису календаря (BR-WO-020, рішення власника 2026-10-16): наряд із
// плановими початком і завершенням сервер сам записує в календар — форма запису НЕ шле
// `POST /calendar/slots` (інакше другий запис чи «Підйомник зайнятий» на власному часі), лише
// ставить обраного механіка на запис наряду й закривається. Межі дня для переповнення — робочі
// години філії (windowStart/windowEnd), а не жорсткі 08–20.

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createRef, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const L1 = '11111111-1111-4111-8111-000000000001';
const L2 = '11111111-1111-4111-8111-000000000002';
const KOVAL = '22222222-2222-4222-8222-000000000001';
const CP = '33333333-3333-4333-8333-000000000001';
const WO = '44444444-4444-4444-8444-000000000001';

const { apiFetch, created } = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  created: {
    current: null as null | {
      id: string;
      number: string;
      counterpartyId: string | null;
      plannedAt?: string | null;
      dueDate?: string | null;
    },
  },
}));
vi.mock('@/lib/api-client', () => ({ apiFetch }));
const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
}));
vi.mock('@/lib/toast', () => ({ toast }));
// Картка наряду — заглушка: показує prefill і по кліку «створює» наряд `created.current`.
vi.mock('next/dynamic', () => ({
  default:
    () =>
    (props: {
      prefill?: Record<string, unknown>;
      onCreated?: (wo: NonNullable<typeof created.current>) => void;
    }) => (
      <button
        type="button"
        data-testid="wo-stub"
        data-prefill={JSON.stringify(props.prefill ?? {})}
        onClick={() => created.current && props.onCreated?.(created.current)}
      >
        stub
      </button>
    ),
}));
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

function Harness({
  initial,
  editingSlotId = null,
  onSaved,
  windowStart = 8,
  windowEnd = 18,
  savedMechanic = null,
}: {
  initial: Partial<SlotForm>;
  editingSlotId?: string | null;
  onSaved: () => void;
  windowStart?: number;
  windowEnd?: number;
  savedMechanic?: SavedMechanic | null;
}) {
  const [form, setForm] = useState<SlotForm>({
    ...EMPTY_FORM,
    counterpartyId: CP,
    counterpartyDisplay: 'Клієнт',
    liftId: L1,
    startAt: '10:00',
    endAt: '11:00',
    normoHours: '1',
    ...initial,
  });
  return (
    <>
      <output data-testid="wo-id">{form.workOrderId}</output>
      <CalendarSlotModal
        open
        onClose={() => {}}
        onSaved={onSaved}
        onDeleted={() => {}}
        date={FUTURE}
        lifts={[
          { id: L1, name: 'П1' },
          { id: L2, name: 'П2' },
        ]}
        form={form}
        setForm={setForm}
        editingSlotId={editingSlotId}
        isEditingPast={false}
        savedMechanic={savedMechanic}
        pendingSlot={null}
        setPendingSlot={() => {}}
        formMounted
        formVisible
        formCollapseRef={createRef<HTMLDivElement>()}
        formInnerRef={createRef<HTMLDivElement>()}
        minHour={windowStart}
        windowStart={windowStart}
        windowEnd={windowEnd}
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

const calls = () => apiFetch.mock.calls as [string, { method?: string; body?: string }?][];
const prefill = () =>
  JSON.parse(screen.getByTestId('wo-stub').getAttribute('data-prefill') ?? '{}') as Record<
    string,
    string | undefined
  >;

beforeEach(() => {
  apiFetch.mockReset();
  created.current = null;
  apiFetch.mockImplementation((url: string) => {
    if (url.startsWith('/employees?'))
      return Promise.resolve({ items: [{ id: KOVAL, firstName: 'Петро', lastName: 'Коваль' }] });
    if (url.startsWith('/calendar/slots/check-conflicts'))
      return Promise.resolve({ anyConflict: false, conflictSlots: [] });
    if (url.startsWith('/vehicles'))
      return Promise.resolve([
        { id: 'veh-1', make: 'Skoda', model: 'Octavia', licensePlate: null },
      ]);
    if (url === `/work-orders/${WO}/linked-documents`)
      return Promise.resolve({
        invoices: [],
        payments: [],
        warranties: [],
        calendarSlots: [
          { id: 'cont', startAt: '2026-10-21T06:00:00.000Z' },
          { id: 'anchor', startAt: '2026-10-20T07:00:00.000Z' },
        ],
      });
    return Promise.resolve({ items: [] });
  });
});

describe('CalendarSlotModal — наряд, створений із форми запису (BR-WO-020)', () => {
  // guards: BR-WO-020
  it('наряд із плановими датами → без POST /calendar/slots; механік — на запис наряду; форма закрита', async () => {
    const onSaved = vi.fn();
    created.current = {
      id: WO,
      number: 'НЗ-1',
      counterpartyId: CP,
      plannedAt: '2026-10-20T07:00:00.000Z',
      dueDate: '2026-10-20T08:00:00.000Z',
    };
    render(<Harness initial={{ employeeId: KOVAL }} onSaved={onSaved} />);
    fireEvent.click(screen.getByTestId('wo-stub'));

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(calls().some(([u, i]) => u === '/calendar/slots' && i?.method === 'POST')).toBe(false);
    const patch = calls().find(
      ([u, i]) => u.startsWith('/calendar/slots/') && i?.method === 'PATCH',
    );
    // Механік ставиться на ПЕРШУ (найранішу) частину запису наряду.
    expect(patch?.[0]).toBe('/calendar/slots/anchor');
    expect(JSON.parse(patch![1]!.body!)).toEqual({ employeeId: KOVAL });
  });

  // guards: BR-WO-020
  it('без механіка у формі — жодних запитів до записів календаря, форма закрита', async () => {
    const onSaved = vi.fn();
    created.current = {
      id: WO,
      number: 'НЗ-1',
      counterpartyId: CP,
      plannedAt: '2026-10-20T07:00:00.000Z',
      dueDate: '2026-10-20T08:00:00.000Z',
    };
    render(<Harness initial={{}} onSaved={onSaved} />);
    fireEvent.click(screen.getByTestId('wo-stub'));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(calls().some(([u]) => u.startsWith('/calendar/slots/') && !u.includes('check'))).toBe(
      false,
    );
  });

  // guards: BR-WO-020
  it('наряд без планових дат → як раніше: наряд підставлено у форму, запис ще не збережено', async () => {
    const onSaved = vi.fn();
    created.current = {
      id: WO,
      number: 'НЗ-1',
      counterpartyId: CP,
      plannedAt: null,
      dueDate: null,
    };
    render(<Harness initial={{}} onSaved={onSaved} />);
    fireEvent.click(screen.getByTestId('wo-stub'));
    await waitFor(() => expect(screen.getByTestId('wo-id').textContent).toBe(WO));
    expect(onSaved).not.toHaveBeenCalled();
  });

  // guards: BR-WO-020
  it('наряд для ІСНУЮЧОГО запису — без планових дат у prefill (сервер не створить другий запис)', () => {
    render(<Harness initial={{}} editingSlotId="slot-1" onSaved={vi.fn()} />);
    expect(prefill().plannedStartAt).toBeUndefined();
    expect(prefill().plannedEndAt).toBeUndefined();
  });

  // guards: BR-WO-019
  it('prefill нового запису: переповнення — за кінцем робочого дня філії (18:00), не 20:00', () => {
    render(
      <Harness
        initial={{ startAt: '17:00', endAt: '09:00', normoHours: '2' }}
        onSaved={vi.fn()}
        windowEnd={18}
      />,
    );
    expect(prefill().plannedStartAt).toBe('2026-10-20T17:00');
    expect(prefill().plannedEndAt).toBe('2026-10-21T09:00');
  });

  // guards: BR-WO-019, BR-CAL-007
  it('prefill: наряд довший за два робочі дні — кінець як у картці наряду (рішення №64), не «завтра 19:00»', () => {
    // 16:00 + 12 год при 9–18: 2 год сьогодні, 9 год завтра, 1 год післязавтра → 10:00. Поле
    // «Кінець» самого запису ділить лише на два дні (BR-CAL-007) і показує завтра 19:00 — поза
    // робочими годинами; з ним сервер відхилив би наряд (400).
    render(
      <Harness
        initial={{ startAt: '16:00', endAt: '19:00', normoHours: '12' }}
        onSaved={vi.fn()}
        windowStart={9}
        windowEnd={18}
      />,
    );
    expect(prefill().plannedStartAt).toBe('2026-10-20T16:00');
    expect(prefill().plannedEndAt).toBe('2026-10-22T10:00');
    expect(prefill().plannedHours).toBe('12');
  });

  // guards: BR-WO-019
  it('prefill: нормогодини з комою («1,5») — кінець і години рахуються, а не губляться в NaN', () => {
    render(
      <Harness
        initial={{ startAt: '17:00', endAt: '11:00', normoHours: '1,5' }}
        onSaved={vi.fn()}
        windowEnd={18}
      />,
    );
    expect(prefill().plannedEndAt).toBe('2026-10-21T08:30');
    expect(prefill().plannedHours).toBe('1.5');
  });

  // guards: BR-WO-019
  it('prefill: без нормогодин — кінець із поля «Кінець» запису', () => {
    render(
      <Harness initial={{ startAt: '10:00', endAt: '12:30', normoHours: '' }} onSaved={vi.fn()} />,
    );
    expect(prefill().plannedEndAt).toBe('2026-10-20T12:30');
    expect(prefill().plannedHours).toBeUndefined();
  });
});

describe('CalendarSlotModal — попередження про зайнятість (BR-CAL-006)', () => {
  // guards: BR-CAL-006
  it('зайнятий підйомник: попередження каже, що збереження буде відхилено, а не «можна зберегти»', async () => {
    const free = apiFetch.getMockImplementation()!;
    apiFetch.mockImplementation((url: string, init?: unknown) => {
      if (url.startsWith('/calendar/slots/check-conflicts'))
        return Promise.resolve({
          anyConflict: true,
          liftConflict: true,
          employeeConflict: false,
          conflictSlots: [{ id: 'busy', startAt: '', endAt: '', status: 'BOOKED', type: 'WORK' }],
        });
      return free(url, init);
    });
    render(<Harness initial={{}} onSaved={vi.fn()} />);
    const warning = await screen.findByText(/Підйомник зайнятий/, undefined, { timeout: 3_000 });
    expect(warning.textContent).toMatch(/буде відхилено/);
    expect(warning.textContent).not.toMatch(/Можна зберегти/);
  });
});

describe('CalendarSlotModal — зміна запису наряду (BR-WO-024)', () => {
  // Збережений запис: клієнт з авто (без авто кнопка «Оновити» недоступна).
  const SAVED = { vehicleId: 'veh-1', startAt: '10:00', endAt: '12:00', normoHours: '2' };

  // guards: BR-WO-024
  it('запис наряду збережено → onSaved з `workOrderChanged` (картка й списки нарядів перечитують дати)', async () => {
    const onSaved = vi.fn();
    render(
      <Harness
        initial={{ ...SAVED, workOrderId: WO, workOrderDisplay: 'НЗ-1' }}
        editingSlotId="anchor"
        onSaved={onSaved}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Оновити' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ workOrderChanged: true }));
    const patch = calls().find(([u, i]) => u === '/calendar/slots/anchor' && i?.method === 'PATCH');
    expect(JSON.parse(patch![1]!.body!)).toMatchObject({ workOrderId: WO, liftId: L1 });
  });

  // guards: BR-WO-024
  it('сервер відмовив (поза робочими годинами) → причина у формі, форма не закривається', async () => {
    const onSaved = vi.fn();
    const free = apiFetch.getMockImplementation()!;
    apiFetch.mockImplementation((url: string, init?: { method?: string }) =>
      url === '/calendar/slots/anchor' && init?.method === 'PATCH'
        ? Promise.reject(new Error('Плановий час — у робочих годинах філії 08:00–18:00'))
        : free(url, init),
    );
    render(
      <Harness
        initial={{ ...SAVED, workOrderId: WO, workOrderDisplay: 'НЗ-1' }}
        editingSlotId="anchor"
        onSaved={onSaved}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Оновити' }));

    await waitFor(() =>
      expect(
        calls().some(([u, i]) => u === '/calendar/slots/anchor' && i?.method === 'PATCH'),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'Плановий час — у робочих годинах філії 08:00–18:00',
      ),
    );
    expect(onSaved).not.toHaveBeenCalled();
  });

  // guards: BR-WO-024
  it('запис без наряду → onSaved без `workOrderChanged`', async () => {
    const onSaved = vi.fn();
    render(<Harness initial={SAVED} editingSlotId="slot-1" onSaved={onSaved} />);
    fireEvent.click(screen.getByRole('button', { name: 'Оновити' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ workOrderChanged: false }));
  });

  // guards: BR-WO-024
  it('наряд відкріплено у формі → PATCH з `workOrderId: null` (сервер не переносить час у відкріплений наряд)', async () => {
    const onSaved = vi.fn();
    render(
      <Harness
        initial={{ ...SAVED, workOrderId: WO, workOrderDisplay: 'НЗ-1' }}
        editingSlotId="anchor"
        onSaved={onSaved}
      />,
    );
    // «×» поля наряду (у клієнта — своє «Очистити»).
    const woField = screen.getByText('НЗ-1').parentElement!;
    fireEvent.click(within(woField).getByRole('button', { name: 'Очистити' }));
    await waitFor(() => expect(screen.getByTestId('wo-id').textContent).toBe(''));
    fireEvent.click(screen.getByRole('button', { name: 'Оновити' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ workOrderChanged: false }));
    const patch = calls().find(([u, i]) => u === '/calendar/slots/anchor' && i?.method === 'PATCH');
    expect(JSON.parse(patch![1]!.body!)).toMatchObject({ workOrderId: null });
  });

  // Bug #901: `notes || undefined` — стерта примітка не доходила до сервера, і він лишав стару.
  it('примітку стерто у зміні запису → PATCH з `notes: null`', async () => {
    render(<Harness initial={{ ...SAVED, notes: '' }} editingSlotId="slot-1" onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Оновити' }));

    await waitFor(() =>
      expect(
        calls().some(([u, i]) => u === '/calendar/slots/slot-1' && i?.method === 'PATCH'),
      ).toBe(true),
    );
    const patch = calls().find(([u, i]) => u === '/calendar/slots/slot-1' && i?.method === 'PATCH');
    expect(JSON.parse(patch![1]!.body!)).toHaveProperty('notes', null);
  });
});

describe('CalendarSlotModal — новий запис для наряду (BR-WO-028, Bug #905)', () => {
  const NEW = { vehicleId: 'veh-1', workOrderId: WO, workOrderDisplay: 'НЗ-1' };
  const postReturns = (slot: { startAt: string; liftId: string }) => {
    const free = apiFetch.getMockImplementation()!;
    apiFetch.mockImplementation((url: string, init?: { method?: string }) =>
      url === '/calendar/slots' && init?.method === 'POST'
        ? Promise.resolve({ slots: [{ id: 'anchor', endAt: slot.startAt, ...slot }] })
        : free(url, init),
    );
  };

  // guards: BR-WO-028
  it('сервер поставив запис на дати наряду → підказка, onSaved з `workOrderChanged` (наряд змінено)', async () => {
    const onSaved = vi.fn();
    // Форма — 10:00 за Києвом; наряд уже має дати на 08:00.
    postReturns({ startAt: '2026-10-20T05:00:00.000Z', liftId: L1 });
    render(<Harness initial={NEW} onSaved={onSaved} />);
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ workOrderChanged: true }));
    expect(toast.info).toHaveBeenCalledWith(
      'Наряд уже має планові дати — запис стоїть на датах і підйомнику наряду',
    );
  });

  // guards: BR-WO-028
  it('запис на часі форми (наряд узяв дати запису) → без підказки, наряд теж перечитується', async () => {
    const onSaved = vi.fn();
    toast.info.mockClear();
    postReturns({ startAt: '2026-10-20T07:00:00.000Z', liftId: L1 });
    render(<Harness initial={NEW} onSaved={onSaved} />);
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ workOrderChanged: true }));
    expect(toast.info).not.toHaveBeenCalled();
  });
});

// Рішення власника 2026-10-19: перев'язка запису на наряд з іншим підйомником знімає механіка, не
// закріпленого за ним, — сервер повертає причину, форма показує «Механіка знято: …».
describe("CalendarSlotModal — перев'язка запису знімає механіка (BR-WO-028)", () => {
  const SAVED = { vehicleId: 'veh-1', startAt: '10:00', endAt: '12:00', normoHours: '2' };
  const patchReturns = (res: Record<string, unknown>) => {
    const free = apiFetch.getMockImplementation()!;
    apiFetch.mockImplementation((url: string, init?: { method?: string }) =>
      url === '/calendar/slots/anchor' && init?.method === 'PATCH'
        ? Promise.resolve({ id: 'anchor', ...res })
        : free(url, init),
    );
  };
  const renderRelink = (onSaved = vi.fn()) =>
    render(
      <Harness
        initial={{ ...SAVED, workOrderId: WO, workOrderDisplay: 'НЗ-2', employeeId: KOVAL }}
        editingSlotId="anchor"
        onSaved={onSaved}
        savedMechanic={{ liftId: L1, employeeId: KOVAL, employeeName: 'Коваль Петро' }}
      />,
    );

  // guards: BR-WO-028, BR-CAL-012
  it('сервер зняв механіка → тост «Механіка знято» з іменем і підйомником нового наряду', async () => {
    toast.warning.mockClear();
    const onSaved = vi.fn();
    patchReturns({ liftId: L2, mechanicDropped: true, mechanicDroppedReason: 'NOT_ON_LIFT' });
    renderRelink(onSaved);
    fireEvent.click(screen.getByRole('button', { name: 'Оновити' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ workOrderChanged: true }));
    expect(toast.warning).toHaveBeenCalledWith(
      'Механіка знято: Коваль Петро не закріплений за підйомником «П2»',
    );
  });

  // guards: BR-WO-028, BR-CAL-012
  it('наряд без підйомника → «запис без підйомника», а не порожні лапки (Bug #908)', async () => {
    toast.warning.mockClear();
    const onSaved = vi.fn();
    patchReturns({ liftId: null, mechanicDropped: true, mechanicDroppedReason: 'NOT_ON_LIFT' });
    renderRelink(onSaved);
    fireEvent.click(screen.getByRole('button', { name: 'Оновити' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ workOrderChanged: true }));
    expect(toast.warning).toHaveBeenCalledWith(
      'Механіка знято: Коваль Петро — запис без підйомника',
    );
  });

  // guards: BR-WO-028, BR-CAL-012
  it('контроль: механіка не знято → без попередження', async () => {
    toast.warning.mockClear();
    const onSaved = vi.fn();
    patchReturns({ liftId: L2 });
    renderRelink(onSaved);
    fireEvent.click(screen.getByRole('button', { name: 'Оновити' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(toast.warning).not.toHaveBeenCalled();
  });
});
