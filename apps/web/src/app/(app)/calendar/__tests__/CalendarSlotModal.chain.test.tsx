// Форма запису календаря: запис на N робочих днів (№72), години філії підйомника (№85),
// відв'язка від наряду (№67) і ланцюжки (№60, BR-WO-024). Рішення власника 2026-10-30 / 2026-11-06.
// 2026-10-20 — вівторок, 24.10 — субота, 26.10 — понеділок.

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createRef, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkHoursWindow } from '@/components/ui/work-order/planned-dates';

const L1 = '11111111-1111-4111-8111-000000000001';
const CP = '33333333-3333-4333-8333-000000000001';
const WO = '44444444-4444-4444-8444-000000000001';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiFetch }));
const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
}));
vi.mock('@/lib/toast', () => ({ toast }));
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

type Chain = { days: number; startAt?: string; endAt: string; isFirst: boolean; isLast: boolean };

interface HarnessProps {
  initial?: Partial<SlotForm>;
  editingSlotId?: string | null;
  editingWorkOrder?: { number: string; lockedStatus: string | null } | null;
  editingChain?: Chain | null;
  startLocked?: boolean;
  formWorkHours?: WorkHoursWindow | null;
  /** Години філії за підйомником форми (як `useCalendarState`): є — замість `formWorkHours`. */
  hoursByLift?: Record<string, WorkHoursWindow>;
  savedWorkHours?: WorkHoursWindow | null;
  savedLiftId?: string;
  lifts?: { id: string; name: string }[];
  /** «Зараз» форми; типово — 15.10.2026 12:00, раніше за всі записи спеків. */
  nowMs?: number;
  /** Години основної філії (сітка дня й запасні години форми); типово 09–18 пн–пт. */
  windowWorkDays?: number[];
  date?: string;
  onSaved?: (o?: { workOrderChanged?: boolean }) => void;
  onDeleted?: () => void;
}

function Harness({
  initial = {},
  editingSlotId = null,
  editingWorkOrder = null,
  editingChain = null,
  startLocked = false,
  formWorkHours = null,
  hoursByLift,
  savedWorkHours = null,
  savedLiftId,
  lifts = [{ id: L1, name: 'П1' }],
  nowMs = new Date('2026-10-15T12:00:00+03:00').getTime(),
  windowWorkDays = [1, 2, 3, 4, 5],
  date = '2026-10-20',
  onSaved = () => {},
  onDeleted = () => {},
}: HarnessProps) {
  const [form, setForm] = useState<SlotForm>({
    ...EMPTY_FORM,
    counterpartyId: CP,
    counterpartyDisplay: 'Іван Тестовий',
    vehicleId: 'veh-1',
    liftId: L1,
    startAt: '10:00',
    endAt: '11:00',
    normoHours: '1',
    ...initial,
  });
  return (
    <CalendarSlotModal
      open
      onClose={() => {}}
      onSaved={onSaved}
      onDeleted={onDeleted}
      date={date}
      lifts={lifts}
      form={form}
      setForm={setForm}
      editingSlotId={editingSlotId}
      isEditingPast={false}
      editingWorkOrder={editingWorkOrder}
      editingChain={editingChain}
      startLocked={startLocked}
      pendingSlot={null}
      setPendingSlot={() => {}}
      formMounted
      formVisible
      formCollapseRef={createRef<HTMLDivElement>()}
      formInnerRef={createRef<HTMLDivElement>()}
      minHour={9}
      windowStart={9}
      windowEnd={18}
      windowWorkDays={windowWorkDays}
      formWorkHours={hoursByLift ? (hoursByLift[form.liftId] ?? null) : formWorkHours}
      savedWorkHours={savedWorkHours}
      savedMechanic={
        savedLiftId ? { liftId: savedLiftId, employeeId: '', employeeName: null } : null
      }
      nowMs={nowMs}
      error=""
      setError={() => {}}
      saving={false}
      setSaving={() => {}}
      cpDisplay="Іван Тестовий"
      setCpDisplay={() => {}}
    />
  );
}

const calls = () => apiFetch.mock.calls as [string, { method?: string; body?: string }?][];
const callsTo = (url: string, method: string) =>
  calls().filter(([u, i]) => u === url && i?.method === method);
const pickerInput = (label: string) =>
  screen.getByText(label).parentElement!.querySelector('input')!;
const warning = () => screen.queryByTestId('slot-split-warning')?.textContent ?? null;

let patchResponse: unknown = {};

beforeEach(() => {
  apiFetch.mockReset();
  toast.success.mockReset();
  patchResponse = {};
  apiFetch.mockImplementation((url: string, init?: { method?: string; body?: string }) => {
    if (url.startsWith('/employees?')) return Promise.resolve({ items: [] });
    if (url.startsWith('/calendar/slots/check-conflicts'))
      return Promise.resolve({ anyConflict: false, conflictSlots: [] });
    if (url.startsWith('/vehicles'))
      return Promise.resolve([{ id: 'veh-1', make: 'Skoda', model: 'Octavia' }]);
    if (url === '/calendar/slots' && init?.method === 'POST')
      return Promise.resolve({
        slots: [
          { id: 'a', startAt: '2026-10-20T07:00:00.000Z', endAt: '2026-10-20T15:00:00.000Z' },
          { id: 'b', startAt: '2026-10-21T06:00:00.000Z', endAt: '2026-10-21T15:00:00.000Z' },
          { id: 'c', startAt: '2026-10-22T06:00:00.000Z', endAt: '2026-10-22T09:00:00.000Z' },
        ],
      });
    if (init?.method === 'PATCH') return Promise.resolve(patchResponse);
    if (init?.method === 'DELETE') return Promise.resolve(undefined);
    return Promise.resolve({ items: [] });
  });
});

describe('CalendarSlotModal — запис на N робочих днів (BR-CAL-007, №72)', () => {
  // guards: BR-CAL-007, BR-CAL-016
  it('10:00 + 20 год: «Кінець» — четвер 12:00, підказка — усі 3 частини, POST — справжній кінець', async () => {
    render(<Harness />);
    fireEvent.change(screen.getByPlaceholderText('напр. 1,5'), { target: { value: '20' } });

    expect(screen.getByDisplayValue('22.10.2026 12:00')).toBeInTheDocument();
    expect(warning()).toMatch(/3 дні: 20\.10 10:00–18:00, 21\.10 09:00–18:00, 22\.10 09:00–12:00/);

    fireEvent.click(screen.getByRole('button', { name: 'Зберегти' }));
    await waitFor(() => expect(callsTo('/calendar/slots', 'POST')).toHaveLength(1));
    const body = JSON.parse(callsTo('/calendar/slots', 'POST')[0]![1]!.body!) as {
      startAt: string;
      endAt: string;
    };
    // Київ, жовтень — UTC+3: без обрізання до 23:59 першого дня.
    expect(body.startAt).toBe('2026-10-20T07:00:00.000Z');
    expect(body.endAt).toBe('2026-10-22T09:00:00.000Z');
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        expect.stringMatching(/Слот розбито на 3 дні: 20\.10 10:00–18:00, 21\.10/),
      ),
    );
  });
});

describe('CalendarSlotModal — години філії підйомника (BR-CAL-017, №85)', () => {
  const LIFT_BRANCH: WorkHoursWindow = { startHour: 8, endHour: 20, workDays: [1, 2, 3, 4, 5, 6] };
  const SAT = {
    date: '2026-10-24',
    initial: { startAt: '17:00', endAt: '22:00', normoHours: '5' },
  };

  // guards: BR-CAL-017
  it('форма рахує за годинами й днями філії підйомника, а не основної', () => {
    render(<Harness {...SAT} formWorkHours={LIFT_BRANCH} />);
    // Субота робоча у філії підйомника: 17–20 сьогодні, 2 год у понеділок від 08:00.
    expect(screen.getByDisplayValue('26.10.2026 10:00')).toBeInTheDocument();
    expect(warning()).toMatch(/24\.10 17:00–20:00, 26\.10 08:00–10:00/);
  });

  // guards: BR-CAL-017
  it('години філії підйомника довантажились / підйомник іншої філії — «Кінець» рахується знову', () => {
    const { rerender } = render(<Harness {...SAT} />);
    // Основна філія (пн–пт): субота не робоча — один запис 17:00–22:00 (№86).
    expect(screen.getByDisplayValue('24.10.2026 22:00')).toBeInTheDocument();
    expect(warning()).toBeNull();

    rerender(<Harness {...SAT} formWorkHours={LIFT_BRANCH} />);
    expect(screen.getByDisplayValue('26.10.2026 10:00')).toBeInTheDocument();
    expect(warning()).toMatch(/2 дні/);
  });
});

describe("CalendarSlotModal — відв'язка запису від наряду (BR-WO-028, №67)", () => {
  const LINKED: HarnessProps = {
    initial: { workOrderId: WO, workOrderDisplay: 'НЗ-1', startAt: '10:00', endAt: '12:00' },
    editingSlotId: 'anchor',
    editingWorkOrder: { number: 'НЗ-1', lockedStatus: null },
  };

  // guards: BR-WO-028
  it('«×» наряду → підтвердження: відмова — без запиту; згода — лише `workOrderId: null`, тост', async () => {
    const onSaved = vi.fn();
    patchResponse = { id: 'anchor', removed: true };
    render(<Harness {...LINKED} onSaved={onSaved} />);
    const woField = screen.getByText('НЗ-1').parentElement!;
    fireEvent.click(within(woField).getByRole('button', { name: 'Очистити' }));

    fireEvent.click(screen.getByRole('button', { name: 'Оновити' }));
    expect(await screen.findByText("Відв'язати наряд від запису?")).toBeInTheDocument();
    const dialog = screen.getByRole('dialog', { name: "Відв'язати наряд від запису?" });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Скасувати' }));
    await waitFor(() => expect(screen.queryByText("Відв'язати наряд від запису?")).toBeNull());
    expect(callsTo('/calendar/slots/anchor', 'PATCH')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Оновити' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Так' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ workOrderChanged: true }));
    const patch = callsTo('/calendar/slots/anchor', 'PATCH');
    expect(patch).toHaveLength(1);
    expect(JSON.parse(patch[0]![1]!.body!)).toEqual({ workOrderId: null });
    expect(toast.success).toHaveBeenCalledWith('Запис видалено — наряд НЗ-1 зберіг планові дати');
  });

  // guards: BR-WO-028
  it("очищення клієнта теж відв'язує: кнопка доступна, без «Оберіть клієнта», запит іде", async () => {
    const onSaved = vi.fn();
    patchResponse = { id: 'anchor', removed: true };
    render(<Harness {...LINKED} onSaved={onSaved} />);
    const cpField = screen.getByText('Іван Тестовий').parentElement!;
    fireEvent.click(within(cpField).getByRole('button', { name: 'Очистити' }));

    const update = screen.getByRole('button', { name: 'Оновити' });
    expect(update).not.toBeDisabled();
    fireEvent.click(update);
    fireEvent.click(await screen.findByRole('button', { name: 'Так' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ workOrderChanged: true }));
    expect(JSON.parse(callsTo('/calendar/slots/anchor', 'PATCH')[0]![1]!.body!)).toEqual({
      workOrderId: null,
    });
  });

  it("контроль: запис без наряду — звичайне «Оновити», без підтвердження відв'язки", async () => {
    const onSaved = vi.fn();
    render(
      <Harness
        initial={{ startAt: '10:00', endAt: '12:00' }}
        editingSlotId="s1"
        onSaved={onSaved}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Оновити' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ workOrderChanged: false }));
    expect(screen.queryByText("Відв'язати наряд від запису?")).toBeNull();
  });
});

describe('CalendarSlotModal — ланцюжки (BR-CAL-019, BR-WO-024)', () => {
  const SECOND_DAY: Chain = {
    days: 2,
    endAt: '2026-10-21T09:00:00.000Z',
    isFirst: false,
    isLast: true,
  };

  // guards: BR-CAL-019
  it('другий день ручного запису: «Видалити» → «Видалити всі 2 дні?» → DELETE, onDeleted', async () => {
    const onDeleted = vi.fn();
    render(
      <Harness
        date="2026-10-21"
        initial={{ startAt: '09:00', endAt: '12:00' }}
        editingSlotId="cont"
        editingChain={SECOND_DAY}
        onDeleted={onDeleted}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Видалити' }));
    expect(await screen.findByText('Видалити всі 2 дні?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Так' }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
    expect(callsTo('/calendar/slots/cont', 'DELETE')).toHaveLength(1);
  });

  // guards: BR-CAL-019, BR-CAL-020
  it('ручний ланцюжок — без блокування меж і підказки про внутрішні межі', () => {
    render(
      <Harness
        date="2026-10-21"
        initial={{ startAt: '09:00', endAt: '12:00' }}
        editingSlotId="cont"
        editingChain={SECOND_DAY}
      />,
    );
    expect(pickerInput('Початок')).not.toBeDisabled();
    expect(screen.queryByTestId('slot-chain-hint')).toBeNull();
  });

  // guards: BR-WO-024
  it('ланцюжок наряду: внутрішня межа (початок другого дня) недоступна, підказка про межі', () => {
    render(
      <Harness
        date="2026-10-21"
        initial={{ startAt: '09:00', endAt: '12:00', workOrderId: WO, workOrderDisplay: 'НЗ-1' }}
        editingSlotId="cont"
        editingWorkOrder={{ number: 'НЗ-1', lockedStatus: null }}
        editingChain={SECOND_DAY}
      />,
    );
    expect(pickerInput('Початок')).toBeDisabled();
    expect(pickerInput('Кінець')).not.toBeDisabled();
    expect(screen.getByTestId('slot-chain-hint').textContent).toMatch(/Запис на 2 дні/);
  });
});

// Рішення власника 2026-11-13 (TECH-DEBT (б) №92): ручний ланцюжок, відкритий з будь-якого дня,
// форма показує й змінює цілим — як новий запис: «Початок» — початок першого дня, «Кінець» —
// кінець останнього, нормогодини між ними, частини за годинами філії; збереження — `chainSpan`.
describe('CalendarSlotModal — ручний ланцюжок цілим (BR-CAL-020)', () => {
  // Вт 20.10 10:00–18:00, ср 21.10 09:00–18:00, чт 22.10 09:00–12:00 — 20 нормогодин (09–18).
  const MIDDLE_DAY: Chain = {
    days: 3,
    startAt: '2026-10-20T07:00:00.000Z',
    endAt: '2026-10-22T09:00:00.000Z',
    isFirst: false,
    isLast: false,
  };
  const openMiddleDay = () =>
    render(
      <Harness
        date="2026-10-21"
        // Форма з хука (`slotToForm`): час початку першого дня й кінця останнього, нормогодини — форми.
        initial={{ startAt: '10:00', endAt: '12:00', normoHours: '' }}
        editingSlotId="mid"
        editingChain={MIDDLE_DAY}
      />,
    );

  // guards: BR-CAL-020
  it('з середнього дня: межі всього ланцюжка, нормогодини між ними, усі частини', async () => {
    openMiddleDay();

    expect(screen.getByDisplayValue('20.10.2026 10:00')).toBeInTheDocument();
    expect(screen.getByDisplayValue('22.10.2026 12:00')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByPlaceholderText('напр. 1,5')).toHaveValue(20));
    expect(warning()).toMatch(/3 дні: 20\.10 10:00–18:00, 21\.10 09:00–18:00, 22\.10 09:00–12:00/);
    // Зайнятість — на межах ланцюжка; власні дні сервер не рахує (excludeSlotId — увесь ланцюжок).
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        '/calendar/slots/check-conflicts',
        expect.objectContaining({
          body: expect.stringContaining('"startAt":"2026-10-20T07:00:00.000Z"'),
        }),
      ),
    );
  });

  // guards: BR-CAL-020
  it('нові нормогодини — новий кінець і 4 частини; «Оновити» шле межі ланцюжка з chainSpan', async () => {
    openMiddleDay();
    await waitFor(() => expect(screen.getByPlaceholderText('напр. 1,5')).toHaveValue(20));

    fireEvent.change(screen.getByPlaceholderText('напр. 1,5'), { target: { value: '27' } });
    expect(screen.getByDisplayValue('23.10.2026 10:00')).toBeInTheDocument();
    expect(warning()).toMatch(/4 дні: .*23\.10 09:00–10:00/);

    fireEvent.click(screen.getByRole('button', { name: 'Оновити' }));
    await waitFor(() => expect(callsTo('/calendar/slots/mid', 'PATCH')).toHaveLength(1));
    const body = JSON.parse(callsTo('/calendar/slots/mid', 'PATCH')[0]![1]!.body!) as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({
      startAt: '2026-10-20T07:00:00.000Z',
      endAt: '2026-10-23T07:00:00.000Z',
      chainSpan: true,
    });
  });

  // guards: BR-CAL-020, BR-WO-028
  it('обрано наряд для ручного ланцюжка з середнього дня — PATCH теж із chainSpan (Bug #1063)', async () => {
    // Без `chainSpan` перев'язка читала межі ланцюжка як межі дня, з якого відкрито форму, —
    // і відповідала 400 «Внутрішню межу багатоденного запису змінити не можна».
    render(
      <Harness
        date="2026-10-21"
        initial={{
          startAt: '10:00',
          endAt: '12:00',
          normoHours: '',
          workOrderId: WO,
          workOrderDisplay: 'НЗ-1',
        }}
        editingSlotId="mid"
        editingChain={MIDDLE_DAY}
      />,
    );
    await waitFor(() => expect(screen.getByPlaceholderText('напр. 1,5')).toHaveValue(20));

    fireEvent.click(screen.getByRole('button', { name: 'Оновити' }));
    await waitFor(() => expect(callsTo('/calendar/slots/mid', 'PATCH')).toHaveLength(1));
    const body = JSON.parse(callsTo('/calendar/slots/mid', 'PATCH')[0]![1]!.body!) as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({
      workOrderId: WO,
      startAt: '2026-10-20T07:00:00.000Z',
      endAt: '2026-10-22T09:00:00.000Z',
      chainSpan: true,
    });
  });

  // guards: BR-CAL-020
  it('контроль: одноденний ручний запис — без chainSpan, час дня сторінки', async () => {
    render(
      <Harness
        initial={{ startAt: '10:00', endAt: '12:00', normoHours: '2' }}
        editingSlotId="one"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Оновити' }));
    await waitFor(() => expect(callsTo('/calendar/slots/one', 'PATCH')).toHaveLength(1));
    const body = JSON.parse(callsTo('/calendar/slots/one', 'PATCH')[0]![1]!.body!) as Record<
      string,
      unknown
    >;
    expect(body).not.toHaveProperty('chainSpan');
    expect(body.startAt).toBe('2026-10-20T07:00:00.000Z');
  });
});

describe('CalendarSlotModal — перевірка зайнятості за тим кінцем, який збережеться (BR-CAL-007)', () => {
  const conflictBodies = () =>
    callsTo('/calendar/slots/check-conflicts', 'POST').map(
      ([, i]) => JSON.parse(i!.body!) as { startAt: string; endAt: string },
    );

  // guards: BR-CAL-007, BR-CAL-020
  it('зміна одноденного ручного запису 17:00–20:00 (№96): перевіряється, як поділить сервер — до 11:00 наступного дня', async () => {
    // З №96 зміну одноденного ручного запису сервер ділить на дні, як новий (раніше — один запис
    // 17:00–20:00), — і конфлікт шукається на тих самих днях.
    render(
      <Harness
        initial={{ startAt: '17:00', endAt: '20:00', normoHours: '3' }}
        editingSlotId="s1"
      />,
    );
    await waitFor(() => expect(conflictBodies().length).toBeGreaterThan(0));
    expect(conflictBodies().at(-1)).toMatchObject({
      startAt: '2026-10-20T14:00:00.000Z',
      endAt: '2026-10-21T08:00:00.000Z',
    });
  });

  // guards: BR-CAL-007
  it('контроль: новий запис 17:00 + 3 год — перевіряється до 11:00 наступного робочого дня', async () => {
    render(<Harness initial={{ startAt: '17:00', endAt: '20:00', normoHours: '3' }} />);
    await waitFor(() => expect(conflictBodies().length).toBeGreaterThan(0));
    expect(conflictBodies().at(-1)).toMatchObject({
      startAt: '2026-10-20T14:00:00.000Z',
      endAt: '2026-10-21T08:00:00.000Z',
    });
  });
});

// Рішення власника 2026-11-14 (TECH-DEBT (б) №96): зміну одноденного ручного запису сервер ділить на
// дні, як новий запис, — форма показує ту саму підказку «Буде розбито на N днів».
describe('CalendarSlotModal — одноденний ручний запис ділиться й при зміні (BR-CAL-020, №96)', () => {
  // guards: BR-CAL-020, BR-CAL-007
  it('нормогодини за закриття → «Кінець» наступного дня, підказка про 2 дні, PATCH — справжній кінець', async () => {
    render(
      <Harness
        initial={{ startAt: '16:00', endAt: '17:00', normoHours: '1' }}
        editingSlotId="one"
      />,
    );
    fireEvent.change(screen.getByPlaceholderText('напр. 1,5'), { target: { value: '4' } });

    await waitFor(() => expect(warning()).toContain('Буде розбито на 2 дні'));
    expect(pickerInput('Кінець')).toHaveValue('21.10.2026 11:00');
    fireEvent.click(screen.getByRole('button', { name: 'Оновити' }));
    await waitFor(() => expect(callsTo('/calendar/slots/one', 'PATCH')).toHaveLength(1));
    const body = JSON.parse(callsTo('/calendar/slots/one', 'PATCH')[0]![1]!.body!) as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({
      startAt: '2026-10-20T13:00:00.000Z',
      endAt: '2026-10-21T08:00:00.000Z',
    });
  });
});

// Рішення власника 2026-11-14 (TECH-DEBT (б) №97): у запису, що вже почався, «Початок» лише для
// читання, «Кінець» і нормогодини змінюються.
describe('CalendarSlotModal — розпочатий запис (BR-CAL-020, BR-WO-024, №97)', () => {
  // guards: BR-CAL-020, BR-WO-024
  it('«Початок» недоступний з підказкою, «Кінець» і нормогодини — доступні', () => {
    render(
      <Harness
        initial={{ startAt: '10:00', endAt: '12:00', normoHours: '2' }}
        editingSlotId="one"
        startLocked
      />,
    );

    expect(pickerInput('Початок')).toBeDisabled();
    expect(pickerInput('Кінець')).not.toBeDisabled();
    expect(screen.getByPlaceholderText('напр. 1,5')).not.toBeDisabled();
    expect(screen.getByTestId('slot-started-hint')).toHaveTextContent(
      'Запис уже почався — початок не змінюється; змінюйте кінець',
    );
  });

  // guards: BR-CAL-020
  it('контроль: запис, що не почався, — «Початок» доступний, підказки немає', () => {
    render(
      <Harness
        initial={{ startAt: '10:00', endAt: '12:00', normoHours: '2' }}
        editingSlotId="one"
      />,
    );

    expect(pickerInput('Початок')).not.toBeDisabled();
    expect(screen.queryByTestId('slot-started-hint')).toBeNull();
  });
});

describe('CalendarSlotModal — підйомник іншої філії зберігає нормогодини (BR-CAL-020, №98)', () => {
  const L2 = '11111111-1111-4111-8111-000000000002';
  const L3 = '11111111-1111-4111-8111-000000000003';
  const MON_FRI: WorkHoursWindow = { startHour: 9, endHour: 18, workDays: [1, 2, 3, 4, 5] };
  const MON_SAT: WorkHoursWindow = { startHour: 9, endHour: 18, workDays: [1, 2, 3, 4, 5, 6] };
  // Пт 23.10 17:00–18:00 + пн 26.10 09:00–12:00 (після переходу на +02:00) на П1 — 4 нормогодини.
  const FRI_MON: Chain = {
    days: 2,
    startAt: '2026-10-23T14:00:00.000Z',
    endAt: '2026-10-26T10:00:00.000Z',
    isFirst: true,
    isLast: false,
  };
  const openChain = (over: Partial<HarnessProps> = {}) =>
    render(
      <Harness
        date="2026-10-23"
        initial={{ startAt: '17:00', endAt: '12:00', normoHours: '' }}
        editingSlotId="a"
        editingChain={FRI_MON}
        lifts={[
          { id: L1, name: 'П1' },
          { id: L2, name: 'П2' },
          { id: L3, name: 'П3' },
        ]}
        hoursByLift={{ [L1]: MON_FRI, [L2]: MON_SAT, [L3]: { ...MON_FRI } }}
        savedWorkHours={MON_FRI}
        savedLiftId={L1}
        {...over}
      />,
    );
  const normo = () => screen.getByPlaceholderText('напр. 1,5');
  const lift = () => screen.getByRole('combobox', { name: /Підйомник/ });

  // guards: BR-CAL-020
  it('підйомник філії пн–сб → «Кінець» сб 12:00, ті самі 4 год; PATCH — новий кінець, chainSpan', async () => {
    openChain();
    await waitFor(() => expect(normo()).toHaveValue(4));
    expect(screen.getByDisplayValue('26.10.2026 12:00')).toBeInTheDocument();

    fireEvent.change(lift(), { target: { value: L2 } });

    await waitFor(() => expect(screen.getByDisplayValue('24.10.2026 12:00')).toBeInTheDocument());
    expect(normo()).toHaveValue(4);
    expect(warning()).toMatch(/2 дні: 23\.10 17:00–18:00, 24\.10 09:00–12:00/);

    fireEvent.click(screen.getByRole('button', { name: 'Оновити' }));
    await waitFor(() => expect(callsTo('/calendar/slots/a', 'PATCH')).toHaveLength(1));
    expect(JSON.parse(callsTo('/calendar/slots/a', 'PATCH')[0]![1]!.body!)).toMatchObject({
      liftId: L2,
      startAt: '2026-10-23T14:00:00.000Z',
      endAt: '2026-10-24T09:00:00.000Z',
      chainSpan: true,
    });
  });

  // guards: BR-CAL-020
  it('назад на збережений підйомник — збережений кінець; філія з тими самими годинами — без змін', async () => {
    openChain();
    await waitFor(() => expect(normo()).toHaveValue(4));

    fireEvent.change(lift(), { target: { value: L2 } });
    await waitFor(() => expect(screen.getByDisplayValue('24.10.2026 12:00')).toBeInTheDocument());
    fireEvent.change(lift(), { target: { value: L1 } });
    await waitFor(() => expect(screen.getByDisplayValue('26.10.2026 12:00')).toBeInTheDocument());

    fireEvent.change(lift(), { target: { value: L3 } });
    expect(screen.getByDisplayValue('26.10.2026 12:00')).toBeInTheDocument();
    expect(normo()).toHaveValue(4);
  });

  // guards: BR-CAL-020
  it('розпочатий запис, кінець за нормогодинами вже минув — збережений кінець, як сервер (Bug #1066)', async () => {
    // «Зараз» — пн 26.10 10:00: запис іде. Ті самі 4 год на П2 (пн–сб) закінчились би сб 24.10
    // 12:00 — у минулому; форма лишає збережений кінець, сервер — теж.
    openChain({ startLocked: true, nowMs: new Date('2026-10-26T10:00:00+02:00').getTime() });
    await waitFor(() => expect(normo()).toHaveValue(4));

    fireEvent.change(lift(), { target: { value: L2 } });

    await waitFor(() => expect(normo()).toHaveValue(13));
    expect(screen.getByDisplayValue('26.10.2026 12:00')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Оновити' }));
    await waitFor(() => expect(callsTo('/calendar/slots/a', 'PATCH')).toHaveLength(1));
    expect(JSON.parse(callsTo('/calendar/slots/a', 'PATCH')[0]![1]!.body!)).toMatchObject({
      liftId: L2,
      startAt: '2026-10-23T14:00:00.000Z',
      endAt: '2026-10-26T10:00:00.000Z',
    });
  });

  // guards: BR-CAL-020
  it('години нової філії ще читаються — кінець не рахується за годинами основної (Bug #1067)', async () => {
    // Основна філія пн–сб; П2 — 08–21 щодня, години ще не прочитано. «Зараз» — сб 24.10 10:00.
    // Запасні години дали б сб 12:00 (ще не минуло) — і далі, коли години П2 прийшли, від цього
    // «зміненого» кінця форма рахувала пт 21:00 (у минулому). Сервер для тих самих меж — пн 12:00.
    const DAILY_8_21: WorkHoursWindow = {
      startHour: 8,
      endHour: 21,
      workDays: [1, 2, 3, 4, 5, 6, 7],
    };
    const props = {
      startLocked: true,
      nowMs: new Date('2026-10-24T10:00:00+03:00').getTime(),
      windowWorkDays: [1, 2, 3, 4, 5, 6],
    };
    const { rerender } = openChain({ ...props, hoursByLift: { [L1]: MON_FRI } });
    await waitFor(() => expect(normo()).toHaveValue(4));

    fireEvent.change(lift(), { target: { value: L2 } });
    await waitFor(() => expect(lift()).toHaveValue(L2));
    expect(screen.getByDisplayValue('26.10.2026 12:00')).toBeInTheDocument();

    rerender(
      <Harness
        date="2026-10-23"
        initial={{ startAt: '17:00', endAt: '12:00', normoHours: '' }}
        editingSlotId="a"
        editingChain={FRI_MON}
        lifts={[
          { id: L1, name: 'П1' },
          { id: L2, name: 'П2' },
        ]}
        hoursByLift={{ [L1]: MON_FRI, [L2]: DAILY_8_21 }}
        savedWorkHours={MON_FRI}
        savedLiftId={L1}
        {...props}
      />,
    );
    await waitFor(() => expect(normo()).toHaveValue(34));
    expect(screen.getByDisplayValue('26.10.2026 12:00')).toBeInTheDocument();
  });

  // guards: BR-CAL-020
  it('розпочатий запис зі зміненими нормогодинами — новий підйомник не ставить кінець у минуле (Bug #1066)', async () => {
    // «Зараз» — пн 26.10 10:00; 7 год від пт 17:00 на П1 — пн 15:00. На П2 (08–21 щодня) ті самі
    // 7 год закінчились би сб 11:00 — у минулому: «Кінець» лишається пн 15:00.
    const daily: WorkHoursWindow = { startHour: 8, endHour: 21, workDays: [1, 2, 3, 4, 5, 6, 7] };
    openChain({
      startLocked: true,
      nowMs: new Date('2026-10-26T10:00:00+02:00').getTime(),
      hoursByLift: { [L1]: MON_FRI, [L2]: daily },
    });
    await waitFor(() => expect(normo()).toHaveValue(4));
    fireEvent.change(normo(), { target: { value: '7' } });
    await waitFor(() => expect(screen.getByDisplayValue('26.10.2026 15:00')).toBeInTheDocument());

    fireEvent.change(lift(), { target: { value: L2 } });

    await waitFor(() => expect(lift()).toHaveValue(L2));
    expect(screen.getByDisplayValue('26.10.2026 15:00')).toBeInTheDocument();
  });
});
