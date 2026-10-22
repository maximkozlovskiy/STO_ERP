// BR-WO-018 на сторінці наряду: рядок роботи показує ім'я збереженого виконавця з відповіді наряду
// (`employeeName`) навіть коли його немає серед активних механіків (адмін, звільнений); «+ Робота»
// пропонує лише тих механіків, яких передала сторінка (`activeMechanics`).

import { fireEvent, screen, within } from '@testing-library/react';
import { renderWithQueryClient } from '@/__tests__/query-utils';
import { vi, it, expect, describe } from 'vitest';

import { WorkOrderLinesSection } from '../WorkOrderLinesSection';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
}));

// «+ Робота» на відкритті читає запис календаря наряду (BR-WO-030).
vi.mock('@/lib/api-client', () => ({
  apiFetch: vi.fn(() => Promise.resolve({ items: [], calendarSlots: [] })),
}));

vi.mock('@/hooks/useUiFeatures', () => ({
  useUiFeatures: () => ({ toastEnabled: false, unsavedGuardEnabled: false }),
}));

const line = (id: string, employeeId: string, employeeName: string) => ({
  id,
  workId: `work-${id}`,
  workName: `Робота ${id}`,
  employeeId,
  employeeName,
  normoHours: 2,
  actualHours: null,
  price: 500,
  amount: 1000,
});

const ACTIVE = [{ id: 'm-active', firstName: 'Іван', lastName: 'Петров' }];

function renderSection() {
  renderWithQueryClient(
    <WorkOrderLinesSection
      woId="wo-1"
      lines={[line('1', 'admin-1', 'Адмін Олег'), line('2', 'm-fired', 'Звільнений Петро')]}
      works={[{ id: 'work-x', name: 'Діагностика', normoHours: 1, price: 400 }]}
      employees={ACTIVE}
      onChanged={vi.fn()}
    />,
  );
}

describe('WorkOrderLinesSection — виконавець поза списком (BR-WO-018)', () => {
  // guards: BR-WO-018
  it('адмін і звільнений виконавці показані своїм ім’ям з наряду', () => {
    renderSection();

    expect(screen.getByText(/Адмін Олег/)).toBeTruthy();
    expect(screen.getByText(/Звільнений Петро/)).toBeTruthy();
  });

  // guards: BR-WO-018
  it('«+ Робота»: обрати можна лише активних механіків зі сторінки', async () => {
    renderSection();

    fireEvent.click(screen.getByRole('button', { name: '+ Робота' }));
    const dialog = await screen.findByRole('dialog');
    const selects = within(dialog).getAllByRole('combobox') as HTMLSelectElement[];
    const executor = selects.find(s => Array.from(s.options).some(o => o.value === 'm-active'));

    expect(executor).toBeTruthy();
    expect(
      Array.from(executor!.options)
        .filter(o => o.value)
        .map(o => o.value),
    ).toEqual(['m-active']);
  });
});
