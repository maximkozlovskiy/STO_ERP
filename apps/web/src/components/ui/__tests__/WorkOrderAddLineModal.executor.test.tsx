import { screen, waitFor, fireEvent } from '@testing-library/react';
import { renderWithQueryClient } from '@/__tests__/query-utils';
import { vi, it, expect, describe, beforeEach } from 'vitest';

import { WorkOrderAddLineModal } from '../WorkOrderAddLineModal';

/**
 * BR-WO-030 у вікні «+ Робота» сторінки наряду: виконавець нової роботи — механік запису наряду в
 * календарі, інакше єдиний механік підйомника наряду; відпустка й чужа категорія не підставляються;
 * ручний вибір не перезаписується.
 */

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

vi.mock('@/hooks/useUiFeatures', () => ({
  useUiFeatures: () => ({ toastEnabled: false, unsavedGuardEnabled: false }),
}));

vi.mock('@/hooks/useDirtyForm', () => ({
  useDirtyForm: () => ({
    isDirty: false,
    markDirty: vi.fn(),
    resetDirty: vi.fn(),
    confirmClose: () => Promise.resolve(true),
  }),
}));

const ENGINE = 'cat-engine';
const BODY = 'cat-body';

const works = [
  { id: 'w-oil', name: 'Заміна оливи', normoHours: 1, price: 400, categoryId: ENGINE },
  { id: 'w-paint', name: 'Фарбування', normoHours: 3, price: 900, categoryId: BODY },
];
const employees = [
  { id: 'm-ivan', firstName: 'Іван', lastName: 'Петров' },
  { id: 'm-oleh', firstName: 'Олег', lastName: 'Сидоренко' },
  { id: 'm-anna', firstName: 'Анна', lastName: 'Коваль' },
];

function mockApi(opts: {
  liftMechanics?: unknown[];
  calendarSlots?: { startAt: string; employeeId: string | null }[];
}) {
  apiFetchMock.mockImplementation((path: string) => {
    if (path.startsWith('/employees?liftId='))
      return Promise.resolve({ items: opts.liftMechanics ?? [] });
    if (path === '/work-orders/wo1/linked-documents')
      return Promise.resolve({
        invoices: [],
        payments: [],
        calendarSlots: opts.calendarSlots ?? [],
        warranties: [],
      });
    return Promise.resolve({ items: [] });
  });
}

function renderModal(liftId: string | null = 'lift-1') {
  renderWithQueryClient(
    <WorkOrderAddLineModal
      open
      workOrderId="wo1"
      liftId={liftId}
      works={works}
      employees={employees}
      onClose={() => {}}
      onAdded={() => {}}
    />,
  );
  const [work, executor] = screen.getAllByRole('combobox') as HTMLSelectElement[];
  return { work: work!, executor: executor! };
}

describe('WorkOrderAddLineModal — виконавець нової роботи (BR-WO-030)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  // guards: BR-WO-030
  it('підйомник з одним механіком → після вибору роботи виконавець — він', async () => {
    mockApi({ liftMechanics: [{ id: 'm-ivan', status: 'ACTIVE', workCategoryIds: [] }] });
    const { work, executor } = renderModal();
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith(
        '/employees?liftId=lift-1&role=MECHANIC&limit=200',
        expect.anything(),
      ),
    );
    expect(executor.value).toBe('');

    fireEvent.change(work, { target: { value: 'w-oil' } });

    await waitFor(() => expect(executor.value).toBe('m-ivan'));
  });

  // guards: BR-WO-030
  it('кілька механіків, запису немає → порожньо', async () => {
    const two = [
      { id: 'm-ivan', status: 'ACTIVE', workCategoryIds: [] },
      { id: 'm-oleh', status: 'ACTIVE', workCategoryIds: [] },
    ];
    mockApi({ liftMechanics: two });
    const { work, executor } = renderModal();
    fireEvent.change(work, { target: { value: 'w-oil' } });
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith(
        '/employees?liftId=lift-1&role=MECHANIC&limit=200',
        expect.anything(),
      ),
    );
    await new Promise(r => setTimeout(r, 20));
    expect(executor.value).toBe('');
  });

  // guards: BR-WO-030
  it('запис календаря з механіком → він, навіть коли на підйомнику кілька', async () => {
    mockApi({
      liftMechanics: [
        { id: 'm-ivan', status: 'ACTIVE', workCategoryIds: [] },
        { id: 'm-oleh', status: 'ACTIVE', workCategoryIds: [] },
      ],
      calendarSlots: [{ startAt: '2026-10-23T08:00:00.000Z', employeeId: 'm-anna' }],
    });
    const { work, executor } = renderModal();

    fireEvent.change(work, { target: { value: 'w-oil' } });

    await waitFor(() => expect(executor.value).toBe('m-anna'));
  });

  // guards: BR-WO-030
  it('єдиний механік без категорії роботи → порожньо; робота його категорії → він', async () => {
    mockApi({ liftMechanics: [{ id: 'm-ivan', status: 'ACTIVE', workCategoryIds: [BODY] }] });
    const { work, executor } = renderModal();

    fireEvent.change(work, { target: { value: 'w-oil' } });
    await new Promise(r => setTimeout(r, 20));
    expect(executor.value).toBe('');

    fireEvent.change(work, { target: { value: 'w-paint' } });
    await waitFor(() => expect(executor.value).toBe('m-ivan'));
  });

  // guards: BR-WO-030
  // Рішення власника 2026-10-22: на підйомнику двоє → поле порожнє (запасний «єдиний» не діє).
  it('механік запису у відпустці, на підйомнику двоє → поле порожнє', async () => {
    mockApi({
      liftMechanics: [
        { id: 'm-oleh', status: 'ON_LEAVE', workCategoryIds: [] },
        { id: 'm-ivan', status: 'ACTIVE', workCategoryIds: [] },
      ],
      calendarSlots: [{ startAt: '2026-10-23T08:00:00.000Z', employeeId: 'm-oleh' }],
    });
    const { work, executor } = renderModal();

    fireEvent.change(work, { target: { value: 'w-oil' } });
    await new Promise(r => setTimeout(r, 20));

    expect(executor.value).toBe('');
  });

  // guards: BR-WO-030
  it('ручний вибір виконавця не перезаписується зміною роботи', async () => {
    mockApi({ liftMechanics: [{ id: 'm-ivan', status: 'ACTIVE', workCategoryIds: [] }] });
    const { work, executor } = renderModal();
    fireEvent.change(work, { target: { value: 'w-oil' } });
    await waitFor(() => expect(executor.value).toBe('m-ivan'));

    fireEvent.change(executor, { target: { value: 'm-anna' } });
    fireEvent.change(work, { target: { value: 'w-paint' } });
    await new Promise(r => setTimeout(r, 20));

    expect(executor.value).toBe('m-anna');
  });

  // guards: BR-WO-030
  it('наряд без підйомника → без запиту механіків, поле порожнє', async () => {
    mockApi({});
    const { work, executor } = renderModal(null);

    fireEvent.change(work, { target: { value: 'w-oil' } });
    await new Promise(r => setTimeout(r, 20));

    expect(executor.value).toBe('');
    expect(apiFetchMock.mock.calls.some(([p]) => String(p).includes('liftId='))).toBe(false);
  });
});
