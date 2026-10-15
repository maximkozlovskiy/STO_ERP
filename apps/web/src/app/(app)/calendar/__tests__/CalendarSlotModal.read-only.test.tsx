// Форма запису календаря для користувача без права змінювати записи (механік): лише перегляд.
// `POST/PATCH/DELETE /calendar/slots` — OWNER/ADMIN/RECEPTIONIST; без цього «Оновити» і
// «Видалити» закінчувались 403 (Bug #871).

import { render, screen } from '@testing-library/react';
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

const FUTURE = '2026-10-20';

function renderForm(readOnly: boolean) {
  return render(
    <CalendarSlotModal
      open
      onClose={() => {}}
      onSaved={() => {}}
      onDeleted={() => {}}
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
      isEditingPast={false}
      readOnly={readOnly}
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

  it('контроль: з правом той самий запис редагується', () => {
    renderForm(false);
    expect(screen.getByText('Редагування слоту')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Оновити' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Видалити/ })).toBeInTheDocument();
  });
});
