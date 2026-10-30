// Картка правила автоматизації (docs/objects/automation.md, US-AUT-1, 2, 4): вкладки «Подія / Умови /
// Дії / Журнал», валідація — спільна automationRuleSchema (та сама, що на сервері), масив дій —
// useFieldArray. Тіло POST / PATCH перевіряється тут: його ж приймає `POST /automation/rules`.

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth', () => ({ useAuth: () => ({ employee: { id: 'adm', role: 'ADMIN' } }) }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/ref-cache', () => ({ getCached: () => null, setCache: () => undefined }));
const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({ apiFetch: (...a: unknown[]) => apiFetchMock(...a) }));

import { AutomationRuleEditModal } from '../AutomationRuleEditModal';

const MECH = '22222222-2222-4222-8222-00000000000a';
const BACKUP = '22222222-2222-4222-8222-00000000000b';
const RULE_ID = '33333333-3333-4333-8333-000000000001';
const EMPLOYEES = [
  { id: MECH, firstName: 'Іван', lastName: 'Механік', status: 'ACTIVE', deletedAt: null },
  { id: BACKUP, firstName: 'Петро', lastName: 'Запасний', status: 'ACTIVE', deletedAt: null },
];
const SYSTEM_RULE = {
  id: RULE_ID,
  name: 'Наряд виконано — повідомити клієнта',
  enabled: true,
  documentType: 'WORK_ORDER',
  eventKind: 'STATUS_CHANGED',
  toStatuses: ['COMPLETED'],
  messageKind: 'SERVICE',
  conditions: {},
  actions: [{ type: 'client_message', template: { body: 'Готово, {{clientName}}' } }],
  systemKey: 'WO_COMPLETED_CLIENT',
  lastRunAt: null,
  createdAt: '2026-10-29T00:00:00.000Z',
  updatedAt: '2026-10-29T00:00:00.000Z',
};

const posts = () =>
  apiFetchMock.mock.calls.filter(
    ([p, init]) => p === '/automation/rules' && (init as { method?: string })?.method === 'POST',
  );
const postedBody = () =>
  JSON.parse((posts()[0]![1] as { body: string }).body) as Record<string, unknown>;

beforeEach(() => {
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation((path: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    if (path.startsWith('/employees')) return Promise.resolve({ items: EMPLOYEES, total: 2 });
    if (path === '/branches') return Promise.resolve([{ id: 'br-1', name: 'Головна' }]);
    if (method === 'POST' && path === '/automation/rules')
      return Promise.resolve({
        ...SYSTEM_RULE,
        ...JSON.parse(init!.body!),
        id: 'new',
        systemKey: null,
      });
    if (method === 'PATCH' && path === `/automation/rules/${RULE_ID}`)
      return Promise.resolve({ ...SYSTEM_RULE, ...JSON.parse(init!.body!) });
    if (path === `/automation/rules/${RULE_ID}`) return Promise.resolve(SYSTEM_RULE);
    if (path.startsWith('/automation/runs') || path.startsWith('/automation/messages'))
      return Promise.resolve({ items: [], total: 0, page: 1, limit: 20 });
    return Promise.resolve({ items: [], total: 0 });
  });
});

function renderCard(ruleId: string | null = null, onCreated = vi.fn(), onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AutomationRuleEditModal open ruleId={ruleId} onClose={onClose} onCreated={onCreated} />
    </QueryClientProvider>,
  );
  return { onCreated, onClose };
}

const dialog = () => within(screen.getByRole('dialog'));
const tab = (name: RegExp) => fireEvent.click(dialog().getByRole('tab', { name }));
const save = (label = 'Створити') => fireEvent.click(dialog().getByRole('button', { name: label }));

function fillEvent(name: string, status: string) {
  fireEvent.change(dialog().getByLabelText(/Назва правила/), { target: { value: name } });
  fireEvent.click(dialog().getByLabelText(status));
}
function addAction(type: string) {
  tab(/^Дії/);
  fireEvent.click(document.querySelector(`[data-add-action="${type}"]`)!);
}

describe('Картка правила — створення', () => {
  // guards: BR-AUT-001
  it('без дій — помилка «Додайте хоча б одну дію» на вкладці «Дії», запиту немає', async () => {
    renderCard();
    fireEvent.change(dialog().getByLabelText(/Назва правила/), { target: { value: 'Правило' } });
    save();
    expect(await screen.findByText('Додайте хоча б одну дію')).toBeInTheDocument();
    expect(dialog().getByRole('tab', { name: /^Дії/ })).toHaveAttribute('aria-selected', 'true');
    expect(posts()).toHaveLength(0);
  });

  // guards: BR-AUT-011
  it('«Наряд → В роботі → повідомити клієнта» без каналів — «як у філії»: POST без channels', async () => {
    const { onCreated } = renderCard();
    fillEvent('000 TST в роботі', 'В роботі');
    addAction('client_message');
    fireEvent.change(dialog().getByLabelText(/^Текст повідомлення/), {
      target: { value: 'Авто {{vehicle}} в роботі. {{branchName}}[[, тел. {{branchPhone}}]]' },
    });
    save();
    await waitFor(() => expect(posts()).toHaveLength(1));
    const body = postedBody();
    expect(body).toMatchObject({
      name: '000 TST в роботі',
      documentType: 'WORK_ORDER',
      eventKind: 'STATUS_CHANGED',
      toStatuses: ['IN_PROGRESS'],
      messageKind: 'SERVICE',
    });
    const action = (body.actions as Array<Record<string, unknown>>)[0]!;
    expect(action.type).toBe('client_message');
    expect(action).not.toHaveProperty('channels');
    expect(action.template).toEqual({
      body: 'Авто {{vehicle}} в роботі. {{branchName}}[[, тел. {{branchPhone}}]]',
    });
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
  });

  // guards: BR-AUT-011
  it('«Свій перелік» каналів зберігає порядок, заданий стрілками', async () => {
    renderCard();
    fillEvent('000 TST канали', 'В роботі');
    addAction('client_message');
    fireEvent.click(dialog().getByLabelText(/Свій перелік/));
    fireEvent.change(dialog().getByRole('combobox', { name: 'Додати канал' }), {
      target: { value: 'SMS' },
    });
    fireEvent.click(dialog().getByRole('button', { name: 'Вище: SMS' }));
    fireEvent.change(dialog().getByLabelText(/^Текст повідомлення/), {
      target: { value: 'Текст' },
    });
    save();
    await waitFor(() => expect(posts()).toHaveLength(1));
    const action = (postedBody().actions as Array<Record<string, unknown>>)[0]!;
    expect(action.channels).toEqual(['SMS', 'TELEGRAM_BOT']);
  });

  // guards: BR-AUT-014
  it('невідома змінна — помилка до запиту (той самий текст, що й 400 сервера)', async () => {
    renderCard();
    fillEvent('000 TST змінна', 'В роботі');
    addAction('client_message');
    fireEvent.change(dialog().getByLabelText(/^Текст повідомлення/), {
      target: { value: 'Задача {{taskTitle}}' },
    });
    expect(screen.getByTestId('template-unknown')).toHaveTextContent('{{taskTitle}}');
    save();
    await waitFor(() =>
      expect(dialog().getByRole('tab', { name: /^Дії/ })).toHaveAttribute('aria-selected', 'true'),
    );
    expect(posts()).toHaveLength(0);
  });

  // guards: BR-AUT-003, BR-AUT-010
  it('інший документ скидає статуси й умови; клієнта в замовлення немає — дія клієнту — помилка', async () => {
    renderCard();
    fillEvent('000 TST документ', 'В роботі');
    tab(/^Умови/);
    fireEvent.click(dialog().getByLabelText('ТО'));
    addAction('client_message');
    fireEvent.change(dialog().getByLabelText(/^Текст повідомлення/), {
      target: { value: 'Текст' },
    });
    tab(/^Подія/);
    fireEvent.change(dialog().getByLabelText('Документ'), { target: { value: 'PURCHASE_ORDER' } });
    expect(dialog().queryByLabelText('В роботі')).toBeNull();
    tab(/^Умови/);
    expect(dialog().queryByTestId('rule-repair-categories')).toBeNull();
    tab(/^Дії/);
    expect(document.querySelector('[data-add-action="client_message"]')).toBeNull();
    save();
    expect(
      await screen.findByText(/повідомлення клієнту|клієнта немає|немає клієнта/i),
    ).toBeInTheDocument();
    expect(posts()).toHaveLength(0);
  });

  // guards: BR-AUT-020, BR-AUT-023
  it('сповіщення працівникам: типово відповідальний, ініціатор без сповіщення, у системі', async () => {
    renderCard();
    fillEvent('000 TST сповіщення', 'Затверджено');
    addAction('employee_notification');
    expect(dialog().getByLabelText(/Сповіщати й того, хто змінив документ/)).not.toBeChecked();
    fireEvent.change(dialog().getByLabelText(/^Заголовок сповіщення/), {
      target: { value: 'Наряд {{documentNumber}} затверджено' },
    });
    save();
    await waitFor(() => expect(posts()).toHaveLength(1));
    const action = (postedBody().actions as Array<Record<string, unknown>>)[0]!;
    expect(action).toMatchObject({
      type: 'employee_notification',
      recipients: { responsible: true, roles: [], employeeIds: [] },
      notifyInitiator: false,
      inApp: true,
      title: 'Наряд {{documentNumber}} затверджено',
    });
    expect(action).not.toHaveProperty('external');
  });

  // guards: BR-AUT-030
  it('задача: конкретний виконавець, запасний, термін у годинах, пріоритет', async () => {
    renderCard();
    fillEvent('000 TST задача', 'Затверджено');
    addAction('create_task');
    fireEvent.change(dialog().getByLabelText(/^Назва задачі/), {
      target: { value: 'Підготувати пост для {{documentNumber}}' },
    });
    fireEvent.click(dialog().getByLabelText('Конкретний працівник'));
    const assignee = dialog().getByRole('combobox', { name: 'Конкретний працівник' });
    await waitFor(() => expect(within(assignee).getByText('Механік Іван')).toBeInTheDocument());
    fireEvent.change(assignee, { target: { value: MECH } });
    fireEvent.change(dialog().getByLabelText(/Запасний виконавець/), { target: { value: BACKUP } });
    fireEvent.change(dialog().getByLabelText(/Термін, годин від події/), {
      target: { value: '3' },
    });
    fireEvent.change(dialog().getByLabelText('Пріоритет'), { target: { value: 'HIGH' } });
    save();
    await waitFor(() => expect(posts()).toHaveLength(1));
    const action = (postedBody().actions as Array<Record<string, unknown>>)[0]!;
    expect(action).toMatchObject({
      type: 'create_task',
      assignee: { employeeId: MECH },
      fallbackEmployeeId: BACKUP,
      dueInHours: 3,
      priority: 'HIGH',
    });
  });
});

describe('Картка правила — наявне типове правило', () => {
  // guards: BR-AUT-007
  it('форма з сервера, «Типове», без «Видалити»; є «Журнал»; збереження — PATCH', async () => {
    const { onClose } = renderCard(RULE_ID);
    expect(
      await screen.findByDisplayValue('Наряд виконано — повідомити клієнта'),
    ).toBeInTheDocument();
    expect(dialog().getByLabelText('Виконано')).toBeChecked();
    expect(dialog().getByText('Типове')).toBeInTheDocument();
    expect(dialog().queryByRole('button', { name: 'Видалити' })).toBeNull();
    expect(dialog().getByRole('tab', { name: /Журнал/ })).toBeInTheDocument();
    fireEvent.change(dialog().getByLabelText(/Назва правила/), {
      target: { value: 'Наряд виконано — SMS' },
    });
    save('Зберегти');
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const patch = apiFetchMock.mock.calls.find(
      ([p, init]) =>
        p === `/automation/rules/${RULE_ID}` && (init as { method?: string })?.method === 'PATCH',
    );
    expect(JSON.parse((patch![1] as { body: string }).body)).toMatchObject({
      name: 'Наряд виконано — SMS',
      toStatuses: ['COMPLETED'],
    });
  });

  // guards: BR-AUT-051
  it('«Надіслати тест» недоступний, доки правило має незбережені зміни', async () => {
    renderCard(RULE_ID);
    await screen.findByDisplayValue('Наряд виконано — повідомити клієнта');
    tab(/^Дії/);
    expect(dialog().getByRole('button', { name: /Надіслати тест/ })).toBeEnabled();
    fireEvent.change(dialog().getByLabelText(/^Текст повідомлення/), {
      target: { value: 'Інший текст' },
    });
    expect(dialog().getByRole('button', { name: /Надіслати тест/ })).toBeDisabled();
  });
});
