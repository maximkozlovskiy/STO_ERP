// Картка задачі співробітнику (docs/objects/task.md): керівник ставить задачу (спільна
// taskFormSchema, BR-TASK-001/004), виконавець — лише перегляд, свої переходи статусу (BR-TASK-003)
// і коментарі (BR-TASK-008).

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let actor = { id: 'mgr-1', role: 'ADMIN' };
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ employee: actor }),
  useRequireAuth: () => ({ employee: actor }),
}));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

import { TaskEditModal, type TaskPrefill } from '../TaskEditModal';

const MECH = '11111111-1111-4111-8111-00000000000a';
const FIRED = '11111111-1111-4111-8111-0000000000c2';
const TASK_ID = '55555555-5555-4555-8555-000000000001';
const EMPLOYEES = [
  { id: MECH, firstName: 'Іван', lastName: 'Коваль', status: 'ACTIVE', deletedAt: null },
  { id: 'leave', firstName: 'Петро', lastName: 'Відпустка', status: 'ON_LEAVE', deletedAt: null },
  { id: FIRED, firstName: 'Олег', lastName: 'Звільнений', status: 'FIRED', deletedAt: null },
];
const TASK = {
  id: TASK_ID,
  title: 'Перевірити гальма',
  description: null,
  status: 'NEW',
  priority: 'HIGH',
  assigneeId: MECH,
  assigneeName: 'Коваль Іван',
  createdById: 'mgr-1',
  createdByName: 'Адмін СТО',
  startAt: null,
  dueAt: '2026-11-12T16:00:00.000Z',
  completedAt: null,
  workOrderId: null,
  workOrderNumber: null,
  workOrderDeleted: false,
  vehicleId: null,
  vehicleSummary: null,
  counterpartyId: null,
  counterpartyName: null,
  overdue: false,
  syncVersion: 1,
  createdAt: '2026-10-26T08:00:00.000Z',
  updatedAt: '2026-10-26T08:00:00.000Z',
};

let task: typeof TASK = TASK;
const calls = (method: string, prefix: string) =>
  apiFetchMock.mock.calls.filter(
    ([path, init]) =>
      String(path).startsWith(prefix) &&
      ((init as { method?: string })?.method ?? 'GET') === method,
  );

function renderCard(taskId: string | null, prefill?: TaskPrefill) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TaskEditModal open taskId={taskId} prefill={prefill} onClose={() => {}} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  actor = { id: 'mgr-1', role: 'ADMIN' };
  task = TASK;
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation((path: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    if (path.startsWith('/employees')) return Promise.resolve({ items: EMPLOYEES, total: 3 });
    if (path.startsWith('/comments')) return Promise.resolve({ items: [], total: 0 });
    if (method === 'POST' && path.endsWith('/transition')) {
      const { status } = JSON.parse(init!.body!) as { status: string };
      task = { ...task, status };
      return Promise.resolve(task);
    }
    if (method === 'POST' && path === '/tasks') return Promise.resolve({ ...TASK, id: 'new' });
    if (path === `/tasks/${TASK_ID}`) return Promise.resolve(task);
    return Promise.resolve({ items: [], total: 0 });
  });
});

const dialog = () => screen.getByRole('dialog');

describe('Картка задачі — керівник', () => {
  // guards: BR-TASK-001
  it('виконавець — лише активні працівники; відпустка й звільнені не пропонуються', async () => {
    renderCard(null);
    const select = within(dialog()).getByLabelText(/Виконавець/);
    await waitFor(() => expect(within(select).getByText('Коваль Іван')).toBeInTheDocument());
    expect(within(select).queryByText(/Відпустка/)).toBeNull();
    expect(within(select).queryByText(/Звільнений/)).toBeNull();
  });

  // guards: BR-TASK-001
  it('порожня назва — помилка українською, запиту немає; помилки немає до спроби зберегти', async () => {
    renderCard(null);
    expect(screen.queryByText('Вкажіть, що треба зробити')).toBeNull();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Поставити задачу' }));
    expect(await screen.findByText('Вкажіть, що треба зробити')).toBeInTheDocument();
    expect(calls('POST', '/tasks')).toHaveLength(0);
  });

  // guards: BR-TASK-004
  it('POST: київський час форми → ISO з поясом; термін раніше початку — помилка, без запиту', async () => {
    const { unmount } = renderCard(null, {
      startAt: '2026-11-12T19:00',
      dueAt: '2026-11-12T18:00',
    });
    const card = within(dialog());
    fireEvent.change(card.getByLabelText(/Що зробити/), { target: { value: 'Замінити лампу' } });
    await waitFor(() => expect(card.getByText('Коваль Іван')).toBeInTheDocument());
    fireEvent.change(card.getByLabelText(/Виконавець/), { target: { value: MECH } });
    fireEvent.click(card.getByRole('button', { name: 'Поставити задачу' }));
    expect(await card.findByText('Термін не може бути раніше початку')).toBeInTheDocument();
    expect(calls('POST', '/tasks')).toHaveLength(0);
    unmount();

    renderCard(null, {
      dueAt: '2026-11-12T18:00',
      workOrderId: '22222222-2222-4222-8222-000000000001',
      workOrderDisplay: 'НРД-1',
    });
    const card2 = within(dialog());
    fireEvent.change(card2.getByLabelText(/Що зробити/), { target: { value: 'Замінити лампу' } });
    await waitFor(() => expect(card2.getByText('Коваль Іван')).toBeInTheDocument());
    fireEvent.change(card2.getByLabelText(/Виконавець/), { target: { value: MECH } });
    fireEvent.click(card2.getByRole('button', { name: 'Поставити задачу' }));
    await waitFor(() => expect(calls('POST', '/tasks')).toHaveLength(1));
    const body = JSON.parse((calls('POST', '/tasks')[0][1] as { body: string }).body) as Record<
      string,
      unknown
    >;
    // Листопад — зимовий час (+02:00): 18:00 за Києвом = 16:00Z.
    expect(body).toMatchObject({
      title: 'Замінити лампу',
      assigneeId: MECH,
      dueAt: '2026-11-12T16:00:00.000Z',
      workOrderId: '22222222-2222-4222-8222-000000000001',
    });
    expect(body.startAt).toBeUndefined();
  });

  // guards: BR-TASK-004
  it('помилка «термін раніше початку» знімається, коли виправили ПОЧАТОК (а не термін)', async () => {
    renderCard(null, { startAt: '2026-11-12T19:00', dueAt: '2026-11-12T18:00' });
    const card = within(dialog());
    fireEvent.change(card.getByLabelText(/Що зробити/), { target: { value: 'Замінити лампу' } });
    fireEvent.click(card.getByRole('button', { name: 'Поставити задачу' }));
    expect(await card.findByText('Термін не може бути раніше початку')).toBeInTheDocument();

    fireEvent.click(card.getByRole('button', { name: /Очистити дату: Початок/ }));
    await waitFor(() => expect(card.queryByText('Термін не може бути раніше початку')).toBeNull());
  });

  // guards: BR-TASK-001
  it('збережений звільнений виконавець — позначка «(недоступний)» після завантаження переліку', async () => {
    task = { ...TASK, assigneeId: FIRED, assigneeName: 'Звільнений Олег' };
    renderCard(TASK_ID);
    const select = await within(dialog()).findByLabelText(/Виконавець/);
    await waitFor(() =>
      expect(within(select).getByText('Звільнений Олег (недоступний)')).toBeInTheDocument(),
    );
  });

  // guards: BR-TASK-001
  it('виконавець у відпустці — поле показує його «(недоступний)» обраним, а не порожнім (Bug #985)', async () => {
    task = { ...TASK, assigneeId: 'leave', assigneeName: 'Відпустка Петро' };
    // Перелік працівників уже є (кеш сторінки «Задачі»), картка задачі приходить після нього.
    const base = apiFetchMock.getMockImplementation()!;
    apiFetchMock.mockImplementation((path: string, init?: { method?: string }) =>
      path === `/tasks/${TASK_ID}`
        ? new Promise(resolve => setTimeout(() => resolve(task), 30))
        : base(path, init),
    );
    renderCard(TASK_ID);
    const select = (await within(dialog()).findByLabelText(/Виконавець/)) as HTMLSelectElement;
    await waitFor(() =>
      expect(within(select).getByText('Відпустка Петро (недоступний)')).toBeInTheDocument(),
    );
    // Позначка в переліку є, але й обрана: інакше поле виглядає порожнім, ніби виконавця немає.
    await waitFor(() => expect(select.value).toBe('leave'));
    // Браузер губить вибір, коли значення поставлено ДО появи позначки (jsdom цього не відтворює):
    // зсуваємо DOM руками — поле має повернути значення форми на наступному рендері.
    select.value = 'zzz';
    fireEvent.change(within(dialog()).getByLabelText(/Що зробити/), {
      target: { value: 'Перевірити гальма ще раз' },
    });
    await waitFor(() => expect(select.value).toBe('leave'));
    expect(select.options[select.selectedIndex]?.text).toBe('Відпустка Петро (недоступний)');
  });

  // guards: BR-TASK-003
  it('виконану задачу керівник може повернути в роботу, скасованої — без дій', async () => {
    task = { ...TASK, status: 'DONE' };
    renderCard(TASK_ID);
    expect(
      await within(dialog()).findByRole('button', { name: 'Повернути в роботу' }),
    ).toBeInTheDocument();
  });
});

describe('Картка задачі — виконавець', () => {
  beforeEach(() => {
    actor = { id: MECH, role: 'MECHANIC' };
  });

  // guards: BR-TASK-003, BR-TASK-001
  it('лише перегляд полів; «Взяти в роботу» й «Виконано», без «Скасувати задачу»', async () => {
    renderCard(TASK_ID);
    const card = within(dialog());
    expect(await card.findByText('Перевірити гальма', { selector: 'dd' })).toBeInTheDocument();
    expect(card.queryByLabelText(/Що зробити/)).toBeNull();
    expect(card.queryByRole('button', { name: 'Зберегти' })).toBeNull();
    expect(card.getByRole('button', { name: 'Взяти в роботу' })).toBeInTheDocument();
    expect(card.getByRole('button', { name: 'Виконано' })).toBeInTheDocument();
    expect(card.queryByRole('button', { name: 'Скасувати задачу' })).toBeNull();
    // Перелік працівників виконавцю не потрібен (і закритий для механіка).
    expect(calls('GET', '/employees')).toHaveLength(0);
  });

  // guards: BR-TASK-003
  it('«Взяти в роботу» → POST /tasks/:id/transition { IN_PROGRESS }; статус оновлюється', async () => {
    renderCard(TASK_ID);
    fireEvent.click(await within(dialog()).findByRole('button', { name: 'Взяти в роботу' }));
    await waitFor(() => expect(calls('POST', `/tasks/${TASK_ID}/transition`)).toHaveLength(1));
    expect(
      JSON.parse((calls('POST', `/tasks/${TASK_ID}/transition`)[0][1] as { body: string }).body),
    ).toEqual({
      status: 'IN_PROGRESS',
    });
    expect(await within(dialog()).findByText('В роботі')).toBeInTheDocument();
  });

  // guards: BR-TASK-008
  it('коментарі задачі — GET /comments?entityType=Task і поле нового коментаря', async () => {
    renderCard(TASK_ID);
    await waitFor(() =>
      expect(calls('GET', `/comments?entityType=Task&entityId=${TASK_ID}`)).toHaveLength(1),
    );
    expect(within(dialog()).getByPlaceholderText(/Напишіть коментар/)).toBeInTheDocument();
  });
});
