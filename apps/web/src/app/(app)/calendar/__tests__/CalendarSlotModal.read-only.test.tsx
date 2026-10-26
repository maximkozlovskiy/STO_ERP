// Форма запису календаря для користувача без права змінювати записи (механік): лише перегляд.
// `POST/PATCH/DELETE /calendar/slots` — OWNER/ADMIN/RECEPTIONIST; без цього «Оновити» і
// «Видалити» закінчувались 403 (Bug #871).
// Минулий запис — теж лише перегляд, крім видалення запису скасованого наряду (рішення власника
// №68, BR-WO-026): «Видалити» є, як у переліку «Без підйомника».

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';

const { apiFetch } = vi.hoisted(() => ({
  apiFetch: vi.fn((..._args: unknown[]) => Promise.resolve({ items: [] })),
}));
vi.mock('@/lib/api-client', () => ({ apiFetch }));
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

const FUTURE = '2026-10-20';

function renderForm(
  readOnly: boolean,
  {
    past = false,
    editingWorkOrder = null,
    onDeleted = () => {},
  }: {
    past?: boolean;
    editingWorkOrder?: { number: string; lockedStatus: string | null } | null;
    onDeleted?: () => void;
  } = {},
) {
  return render(
    <CalendarSlotModal
      open
      onClose={() => {}}
      onSaved={() => {}}
      onDeleted={onDeleted}
      date={FUTURE}
      lifts={[{ id: 'lift-1', name: 'П1' } as never]}
      form={{
        ...EMPTY_FORM,
        liftId: 'lift-1',
        startAt: '10:00',
        endAt: '11:00',
        normoHours: '1',
      }}
      setForm={() => {}}
      editingSlotId="slot-1"
      isEditingPast={past}
      readOnly={readOnly}
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

describe('CalendarSlotModal — без права змінювати записи (Bug #871)', () => {
  // guards: BR-CAL-010
  it('майбутній запис: лише перегляд — без «Оновити» і «Видалити», з поясненням', () => {
    renderForm(true);
    expect(screen.getByText('Перегляд слоту')).toBeInTheDocument();
    expect(
      screen.getByText('Записи календаря змінюють адміністратор і рецепція — тут лише перегляд'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Оновити' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Видалити/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Закрити' })).toBeInTheDocument();
  });

  // guards: BR-CAL-010
  it('контроль: з правом той самий запис редагується', () => {
    renderForm(false);
    expect(screen.getByText('Редагування слоту')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Оновити' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Видалити/ })).toBeInTheDocument();
  });
});

describe('CalendarSlotModal — минулий запис скасованого наряду (рішення власника №68)', () => {
  const cancelled = { number: 'НРД-7', lockedStatus: 'CANCELLED' };

  // guards: BR-WO-026, BR-CAL-009
  it('минулий запис скасованого наряду: лише перегляд, але «Видалити» доступна й шле DELETE', async () => {
    const onDeleted = vi.fn();
    renderForm(false, { past: true, editingWorkOrder: cancelled, onDeleted });
    expect(screen.getByText('Перегляд слоту')).toBeInTheDocument();
    expect(
      screen.getByText('Слот у закритому періоді — редагування недоступне'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Оновити' })).toBeNull();

    const btn = screen.getByRole('button', { name: /Видалити/ });
    expect(btn).not.toBeDisabled();
    expect(btn).not.toHaveAccessibleDescription();
    fireEvent.click(btn);
    expect(await screen.findByText(/скасованого наряду НРД-7/)).toHaveTextContent(
      'дати наряду не зміняться',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Так' }));
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/calendar/slots/slot-1', { method: 'DELETE' }),
    );
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
  });

  // guards: BR-WO-026, BR-CAL-009
  it('контроль: минулий запис нескасованого наряду і без наряду — «Видалити» немає', () => {
    const { unmount } = renderForm(false, {
      past: true,
      editingWorkOrder: { number: 'НРД-8', lockedStatus: 'COMPLETED' },
    });
    expect(screen.queryByRole('button', { name: /Видалити/ })).toBeNull();
    unmount();
    renderForm(false, { past: true });
    expect(screen.queryByRole('button', { name: /Видалити/ })).toBeNull();
  });

  // guards: BR-CAL-010
  it('контроль: без права змінювати записи — «Видалити» немає й для скасованого наряду', () => {
    renderForm(true, { past: true, editingWorkOrder: cancelled });
    expect(screen.queryByRole('button', { name: /Видалити/ })).toBeNull();
  });
});
