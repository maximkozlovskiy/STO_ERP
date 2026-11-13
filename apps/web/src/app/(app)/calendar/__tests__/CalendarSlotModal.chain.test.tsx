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
  formWorkHours?: WorkHoursWindow | null;
  date?: string;
  onSaved?: (o?: { workOrderChanged?: boolean }) => void;
  onDeleted?: () => void;
}

function Harness({
  initial = {},
  editingSlotId = null,
  editingWorkOrder = null,
  editingChain = null,
  formWorkHours = null,
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
      lifts={[{ id: L1, name: 'П1' }]}
      form={form}
      setForm={setForm}
      editingSlotId={editingSlotId}
      isEditingPast={false}
      editingWorkOrder={editingWorkOrder}
      editingChain={editingChain}
      pendingSlot={null}
      setPendingSlot={() => {}}
      formMounted
      formVisible
      formCollapseRef={createRef<HTMLDivElement>()}
      formInnerRef={createRef<HTMLDivElement>()}
      minHour={9}
      windowStart={9}
      windowEnd={18}
      windowWorkDays={[1, 2, 3, 4, 5]}
      formWorkHours={formWorkHours}
      nowMs={new Date('2026-10-15T12:00:00+03:00').getTime()}
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

  // guards: BR-CAL-007
  it('зміна ручного запису 17:00–20:00: перевіряється 17:00–20:00 того ж дня, не «завтра до 11:00»', async () => {
    // Зміну ручного запису сервер не ділить на дні — і конфлікт шукається на тому ж проміжку.
    render(
      <Harness
        initial={{ startAt: '17:00', endAt: '20:00', normoHours: '3' }}
        editingSlotId="s1"
      />,
    );
    await waitFor(() => expect(conflictBodies().length).toBeGreaterThan(0));
    expect(conflictBodies().at(-1)).toMatchObject({
      startAt: '2026-10-20T14:00:00.000Z',
      endAt: '2026-10-20T17:00:00.000Z',
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
