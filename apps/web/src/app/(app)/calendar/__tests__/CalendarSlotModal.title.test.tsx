// Заголовок форми нового запису — дата в локальному форматі (ДД.ММ.РРРР), не 'YYYY-MM-DD'
// (Bug #874): дія місяця «Новий запис на 22.10.2026» відкривала «Новий слот на 2026-10-22».

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

const FUTURE = '2026-10-22';

function renderNewForm() {
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
      editingSlotId={null}
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
    />,
  );
}

describe('CalendarSlotModal — заголовок нового запису (Bug #874)', () => {
  it('дата в заголовку — ДД.ММ.РРРР, як у назві дії «Новий запис на …»', () => {
    renderNewForm();
    expect(screen.getByText('Новий слот на 22.10.2026')).toBeInTheDocument();
    expect(screen.queryByText(/2026-10-22/)).toBeNull();
  });
});
