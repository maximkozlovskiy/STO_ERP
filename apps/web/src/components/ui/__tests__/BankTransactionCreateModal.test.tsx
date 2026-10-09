// Ручне внесення банківського платежу (BR-BANK-023):
//   - payload = CreateBankTransactionDto (сума з UA-комою → число, порожні поля не шлються);
//   - напрям за замовчуванням — з пропа (напрям вкладки), без пропа — вхідний;
//   - заголовок `Idempotency-Key`: один на відкриття, той самий при повторі після збою;
//   - єдиний рахунок обирається сам, поруч показано його валюту;
//   - дата за замовчуванням — сьогодні за Києвом.
//
// Mutation-verify:
//   - прибрати `headers: { 'Idempotency-Key': … }` у хуку          → кейси ключа падають;
//   - `idempotencyKeyRef.current = newIdempotencyKey()` перенести в onValid → «той самий при повторі» падає;
//   - `emptyDefaults(defaultDirection ?? 'IN')` → `emptyDefaults('IN')`   → «напрям з пропа» падає;
//   - `amount: values.amount` → `amount: 1`                          → «payload» падає.

import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/format', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/format')>()),
  kyivToday: () => '2026-10-09',
}));

// Календар — не мета тесту: поле дати як звичайний input зі значенням YYYY-MM-DD.
vi.mock('@/components/ui/date-picker-input', () => ({
  DatePickerInput: (p: { value: string; onChange: (v: string) => void; label?: string }) => (
    <input aria-label={p.label} value={p.value} onChange={e => p.onChange(e.target.value)} />
  ),
}));

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  apiMultipartFetch: vi.fn(),
}));

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast: toastMock }));

import { BankTransactionCreateModal } from '../BankTransactionCreateModal';
import { renderWithQueryClient, makeTestQueryClient } from '../../../__tests__/query-utils';

const ACC_UAH = '11111111-1111-4111-8111-111111111111';
const ACC_USD = '22222222-2222-4222-8222-222222222222';
const account = (id: string, name: string, currencyCode: string) => ({
  id,
  name,
  currencyCode,
  currencyId: `cur-${currencyCode}`,
  ibanUA: 'UA213223130000026007233566001',
  orgId: 'o1',
  autoPullEnabled: false,
  createdAt: '',
  updatedAt: '',
});

type Init = { method?: string; body?: string; headers?: Record<string, string> };

/** apiFetch: довідник рахунків + створення (за замовчуванням успішне). */
function mockApi(accounts: ReturnType<typeof account>[], create?: () => Promise<unknown>) {
  apiFetchMock.mockImplementation((path: string, init?: Init) => {
    if (path === '/bank-accounts') return Promise.resolve({ items: accounts });
    if (path === '/bank-statements/transactions' && init?.method === 'POST')
      return create ? create() : Promise.resolve({ id: 'new-1' });
    return Promise.reject(new Error(`неочікуваний запит ${path}`));
  });
}

const createCalls = () =>
  apiFetchMock.mock.calls.filter(
    c => c[0] === '/bank-statements/transactions' && (c[1] as Init | undefined)?.method === 'POST',
  ) as [string, Init][];
const submit = () => fireEvent.click(screen.getByRole('button', { name: 'Внести платіж' }));
const type = (label: string | RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const pressed = (name: string) =>
  screen.getByRole('button', { name }).getAttribute('aria-pressed') === 'true';

describe('BankTransactionCreateModal', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    toastMock.success.mockReset();
    toastMock.error.mockReset();
  });

  it('payload відповідає контракту: рахунок, напрям, сума-число, дата, контрагент, призначення', async () => {
    mockApi([account(ACC_UAH, 'Основний', 'UAH'), account(ACC_USD, 'Валютний', 'USD')]);
    const onClose = vi.fn();
    renderWithQueryClient(<BankTransactionCreateModal open onClose={onClose} />);

    await screen.findByRole('option', { name: 'Валютний' });
    type(/Банківський рахунок/, ACC_USD);
    fireEvent.click(screen.getByRole('button', { name: 'Вихідний' }));
    type(/^Сума/, '1250,50');
    type('Дата операції', '2026-10-07');
    type('Контрагент (назва)', '  ТОВ Постачальник ');
    type('IBAN контрагента', 'UA903052992990004149123456789');
    type('ЄДРПОУ контрагента', '12345678');
    type('Призначення платежу', 'Оплата за запчастини');
    submit();

    await waitFor(() => expect(createCalls()).toHaveLength(1));
    expect(JSON.parse(createCalls()[0]![1].body!)).toEqual({
      bankAccountId: ACC_USD,
      direction: 'OUT',
      amount: 1250.5,
      operationDate: '2026-10-07',
      payerName: 'ТОВ Постачальник',
      payerIban: 'UA903052992990004149123456789',
      payerEdrpou: '12345678',
      purpose: 'Оплата за запчастини',
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(toastMock.success).toHaveBeenCalledWith('Платіж внесено');
  });

  it("необов'язкові поля порожні → у payload їх немає; дата за замовчуванням — сьогодні за Києвом", async () => {
    mockApi([account(ACC_UAH, 'Основний', 'UAH')]);
    renderWithQueryClient(<BankTransactionCreateModal open onClose={() => {}} />);
    await waitFor(() =>
      expect((screen.getByLabelText(/Банківський рахунок/) as HTMLSelectElement).value).toBe(
        ACC_UAH,
      ),
    );
    expect((screen.getByLabelText('Дата операції') as HTMLInputElement).value).toBe('2026-10-09');
    type(/^Сума/, '300');
    submit();

    await waitFor(() => expect(createCalls()).toHaveLength(1));
    expect(JSON.parse(createCalls()[0]![1].body!)).toEqual({
      bankAccountId: ACC_UAH,
      direction: 'IN',
      amount: 300,
      operationDate: '2026-10-09',
    });
  });

  it('напрям за замовчуванням: без пропа — вхідний', async () => {
    mockApi([account(ACC_UAH, 'Основний', 'UAH')]);
    renderWithQueryClient(<BankTransactionCreateModal open onClose={() => {}} />);
    expect(pressed('Вхідний')).toBe(true);
    expect(pressed('Вихідний')).toBe(false);
  });

  it('напрям за замовчуванням береться з пропа (вкладка «Вихідні») і йде в payload', async () => {
    mockApi([account(ACC_UAH, 'Основний', 'UAH')]);
    renderWithQueryClient(
      <BankTransactionCreateModal open onClose={() => {}} defaultDirection="OUT" />,
    );
    expect(pressed('Вихідний')).toBe(true);
    expect(pressed('Вхідний')).toBe(false);
    await waitFor(() =>
      expect((screen.getByLabelText(/Банківський рахунок/) as HTMLSelectElement).value).toBe(
        ACC_UAH,
      ),
    );
    type(/^Сума/, '10');
    submit();
    await waitFor(() => expect(createCalls()).toHaveLength(1));
    expect(JSON.parse(createCalls()[0]![1].body!).direction).toBe('OUT');
  });

  it('єдиний рахунок обрано автоматично; поруч — валюта рахунку', async () => {
    mockApi([account(ACC_USD, 'Валютний', 'USD')]);
    renderWithQueryClient(<BankTransactionCreateModal open onClose={() => {}} />);
    expect(await screen.findByText('Валюта рахунку: USD')).toBeInTheDocument();
    expect(screen.getByLabelText(/^Сума, USD/)).toBeInTheDocument();
  });

  it('кілька рахунків — жоден не обрано; без рахунку запит не йде, показано помилку', async () => {
    mockApi([account(ACC_UAH, 'Основний', 'UAH'), account(ACC_USD, 'Валютний', 'USD')]);
    renderWithQueryClient(<BankTransactionCreateModal open onClose={() => {}} />);
    await screen.findByRole('option', { name: 'Валютний' });
    expect((screen.getByLabelText(/Банківський рахунок/) as HTMLSelectElement).value).toBe('');
    type(/^Сума/, '100');
    submit();
    expect(await screen.findByText('Оберіть банківський рахунок')).toBeInTheDocument();
    expect(createCalls()).toHaveLength(0);
  });

  it.each(['', '0', '-5', 'abc'])('сума «%s» не проходить — запит не йде', async amount => {
    mockApi([account(ACC_UAH, 'Основний', 'UAH')]);
    renderWithQueryClient(<BankTransactionCreateModal open onClose={() => {}} />);
    await waitFor(() =>
      expect((screen.getByLabelText(/Банківський рахунок/) as HTMLSelectElement).value).toBe(
        ACC_UAH,
      ),
    );
    type(/^Сума/, amount);
    submit();
    await waitFor(() =>
      expect(screen.getByLabelText(/^Сума/)).toHaveAttribute('aria-invalid', 'true'),
    );
    expect(createCalls()).toHaveLength(0);
  });

  it('призначення обмежене 500 символами', async () => {
    mockApi([account(ACC_UAH, 'Основний', 'UAH')]);
    renderWithQueryClient(<BankTransactionCreateModal open onClose={() => {}} />);
    expect(screen.getByLabelText('Призначення платежу')).toHaveAttribute('maxlength', '500');
  });

  // ── Idempotency-Key ────────────────────────────────────────────────────────
  it('запит несе заголовок Idempotency-Key (непорожній)', async () => {
    mockApi([account(ACC_UAH, 'Основний', 'UAH')]);
    renderWithQueryClient(<BankTransactionCreateModal open onClose={() => {}} />);
    await waitFor(() =>
      expect((screen.getByLabelText(/Банківський рахунок/) as HTMLSelectElement).value).toBe(
        ACC_UAH,
      ),
    );
    type(/^Сума/, '100');
    submit();
    await waitFor(() => expect(createCalls()).toHaveLength(1));
    const key = createCalls()[0]![1].headers?.['Idempotency-Key'];
    expect(typeof key).toBe('string');
    expect(key!.length).toBeGreaterThanOrEqual(16);
  });

  it('повтор після збою шле ТОЙ САМИЙ ключ; нове відкриття — новий', async () => {
    let attempt = 0;
    mockApi([account(ACC_UAH, 'Основний', 'UAH')], () =>
      ++attempt === 1 ? Promise.reject(new Error('Мережа недоступна')) : Promise.resolve({}),
    );
    const onClose = vi.fn();
    // rerender() не огортає провайдером повторно — огортаємо самі тим самим клієнтом.
    const client = makeTestQueryClient();
    const ui = (open: boolean) => (
      <QueryClientProvider client={client}>
        <BankTransactionCreateModal open={open} onClose={onClose} />
      </QueryClientProvider>
    );
    const { rerender } = render(ui(true));
    const ready = () =>
      waitFor(() =>
        expect((screen.getByLabelText(/Банківський рахунок/) as HTMLSelectElement).value).toBe(
          ACC_UAH,
        ),
      );

    await ready();
    type(/^Сума/, '100');
    submit();
    // Відмова показана в модалці, форма лишається відкритою.
    expect(await screen.findByRole('alert')).toHaveTextContent('Мережа недоступна');
    expect(onClose).not.toHaveBeenCalled();

    submit();
    await waitFor(() => expect(createCalls()).toHaveLength(2));
    const first = createCalls()[0]![1].headers!['Idempotency-Key'];
    expect(createCalls()[1]![1].headers!['Idempotency-Key']).toBe(first);

    // Нове відкриття — це новий платіж, отже новий ключ.
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    rerender(ui(false));
    rerender(ui(true));
    await ready();
    type(/^Сума/, '200');
    submit();
    await waitFor(() => expect(createCalls()).toHaveLength(3));
    expect(createCalls()[2]![1].headers!['Idempotency-Key']).not.toBe(first);
  });
});
