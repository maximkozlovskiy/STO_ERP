// Вікно «Оплатити» рахунку: каса для готівки (BR-PAY-019, рішення власника 2026-10-14).
//
// До цього вікно слало лише клієнта, рахунок, суму, спосіб і примітку, а каса за замовчуванням
// способу оплати ніде не задавалась — готівка з рахунку гасила борг повз касу. Тепер поле «Каса»
// є для готівки (обов'язкове) і для способу, у якого кошти за замовчуванням надходять у касу;
// заповнюється касою за замовчуванням способу, а запит несе `sourceType` + `cashRegisterId`.

import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, it, expect, describe, beforeEach } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/invoices',
}));
vi.mock('@/lib/auth', () => ({
  useRequireAuth: () => ({ employee: { id: 'e1', role: 'RECEPTIONIST' } }),
  useAuth: () => ({ employee: { id: 'e1', role: 'RECEPTIONIST' } }),
}));

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  apiBlobFetch: vi.fn(),
}));
vi.mock('@/lib/ref-cache', () => ({ getCached: () => null, setCache: vi.fn() }));

const INV = {
  id: 'inv-a',
  orgId: 'org-1',
  number: 'РАХ-0001',
  status: 'SENT',
  invoiceType: 'STANDARD',
  counterpartyId: 'cp-1',
  counterpartyName: 'Клієнт Перший',
  workOrderId: null,
  amount: 100,
  paidAmount: 0,
  dueDate: null,
  documentDate: '2026-10-13T00:00:00.000Z',
  notes: null,
  createdAt: '2026-10-13T08:00:00.000Z',
  updatedAt: '2026-10-13T08:00:00.000Z',
  deletedAt: null,
};

vi.mock('@/hooks/api/useInvoices', async importOriginal => {
  const actual = await importOriginal<typeof import('@/hooks/api/useInvoices')>();
  return {
    ...actual,
    useInvoices: () => ({
      data: { items: [INV], total: 1, page: 1, limit: 20 },
      isLoading: false,
      error: null,
    }),
  };
});
const REGISTERS = [
  { id: 'cr-main', name: 'Каса головна' },
  { id: 'cr-second', name: 'Каса друга' },
  // Валютна каса: рахунок у гривні оплату в неї не прийме (валюта оплати = валюта каси).
  { id: 'cr-usd', name: 'Каса доларова', currencyCode: 'USD' },
];
vi.mock('@/hooks/api/useCash', () => ({
  useBaseCurrency: () => ({ data: { code: 'UAH', symbol: '₴' } }),
  useRetryCashFiscal: () => ({ mutateAsync: async () => ({}) }),
  useCashRegisters: () => ({ data: REGISTERS }),
}));
vi.mock('@/components/ui/InvoiceCreateModal', () => ({ InvoiceCreateModal: () => null }));
vi.mock('@/components/ui/QrPaymentModal', () => ({ QrPaymentModal: () => null }));
vi.mock('@/components/ui/date-picker-input', () => ({ DatePickerInput: () => null }));

import InvoicesPage from '../page';

type Method = {
  code: string;
  name: string;
  isActive: boolean;
  defaultSourceType: 'CASH_REGISTER' | 'BANK_ACCOUNT' | null;
  defaultCashRegisterId: string | null;
  defaultBankAccountId: string | null;
  defaultDestinationName: string | null;
};
const method = (code: string, name: string, over: Partial<Method> = {}): Method => ({
  code,
  name,
  isActive: true,
  defaultSourceType: null,
  defaultCashRegisterId: null,
  defaultBankAccountId: null,
  defaultDestinationName: null,
  ...over,
});
let methods: Method[] = [];
let payResponse: () => Promise<unknown> = () => Promise.resolve({ id: 'pay-1' });

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <InvoicesPage />
    </QueryClientProvider>,
  );
}

async function openPayDialog() {
  renderPage();
  await screen.findByText('РАХ-0001');
  fireEvent.click(
    screen
      .getAllByText('РАХ-0001')
      .map(el => el.closest('tr'))
      .find(tr => tr !== null)!,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Оплатити' }));
  const dialog = await screen.findByRole('dialog');
  // Способи оплати прийшли з сервера — у списку справжні назви, а не запасні.
  await within(dialog).findByRole('option', { name: methods[0].name });
  return dialog;
}

const cashSelect = (dialog: HTMLElement) =>
  within(dialog).queryByRole('combobox', { name: /^Каса/ }) as HTMLSelectElement | null;
const methodSelect = (dialog: HTMLElement) =>
  within(dialog).getByRole('combobox', { name: /^Метод оплати/ }) as HTMLSelectElement;
const payButton = (dialog: HTMLElement) =>
  within(dialog.closest('[role="dialog"]') ?? dialog).getByRole('button', {
    name: 'Підтвердити оплату',
  });
const paymentBody = () => {
  const call = apiFetchMock.mock.calls.find(([path]) => path === '/payments');
  return call ? (JSON.parse((call[1] as { body: string }).body) as Record<string, unknown>) : null;
};

describe('Рахунки — вікно «Оплатити»: каса для готівки (BR-PAY-019)', () => {
  beforeEach(() => {
    localStorage.clear();
    methods = [
      method('cash', 'Готівка'),
      method('card_terminal', 'Термінал'),
      method('cash_safe', 'Готівка (сейф)', {
        defaultSourceType: 'CASH_REGISTER',
        defaultCashRegisterId: 'cr-second',
        defaultDestinationName: 'Каса друга',
      }),
    ];
    payResponse = () => Promise.resolve({ id: 'pay-1' });
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/payment-methods') return Promise.resolve(methods);
      if (path === '/payments') return payResponse();
      if (path === '/invoices/inv-a') return Promise.resolve({ ...INV, lines: [] });
      if (path.endsWith('/lines-summary')) return Promise.resolve({ tables: [], executors: [] });
      return Promise.resolve({});
    });
  });

  // guards: BR-PAY-019
  it('готівка з касою за замовчуванням: поле «Каса» заповнене нею, запит несе касу', async () => {
    methods[0] = method('cash', 'Готівка', {
      defaultSourceType: 'CASH_REGISTER',
      defaultCashRegisterId: 'cr-main',
      defaultDestinationName: 'Каса головна',
    });
    const dialog = await openPayDialog();

    await waitFor(() => expect(cashSelect(dialog)?.value).toBe('cr-main'));
    expect(cashSelect(dialog)).toBeRequired();
    fireEvent.click(payButton(dialog));

    await waitFor(() => expect(paymentBody()).not.toBeNull());
    expect(paymentBody()).toMatchObject({
      invoiceId: 'inv-a',
      method: 'cash',
      sourceType: 'CASH_REGISTER',
      cashRegisterId: 'cr-main',
    });
  });

  // guards: BR-PAY-019
  it('готівка без каси за замовчуванням: поле порожнє, оплатити не можна, доки касу не обрано', async () => {
    const dialog = await openPayDialog();

    expect(cashSelect(dialog)?.value).toBe('');
    expect(payButton(dialog)).toBeDisabled();
    expect(within(dialog).getByText('Для оплати готівкою оберіть касу')).toBeInTheDocument();
    fireEvent.click(payButton(dialog));
    expect(paymentBody()).toBeNull();

    fireEvent.change(cashSelect(dialog)!, { target: { value: 'cr-second' } });
    expect(payButton(dialog)).toBeEnabled();
    fireEvent.click(payButton(dialog));

    await waitFor(() => expect(paymentBody()).not.toBeNull());
    expect(paymentBody()).toMatchObject({
      method: 'cash',
      sourceType: 'CASH_REGISTER',
      cashRegisterId: 'cr-second',
    });
  });

  it('зміна способу міняє касу на його замовчування, доки касир касу не чіпав', async () => {
    const dialog = await openPayDialog();

    fireEvent.change(methodSelect(dialog), { target: { value: 'cash_safe' } });
    expect(cashSelect(dialog)?.value).toBe('cr-second');
    // Поле є, але для не-готівки воно необов'язкове.
    expect(cashSelect(dialog)).not.toBeRequired();

    // Касир касу не чіпав — повернення на «Готівку» знову йде за її замовчуванням (порожньо).
    fireEvent.change(methodSelect(dialog), { target: { value: 'cash' } });
    expect(cashSelect(dialog)?.value).toBe('');

    // Касир обрав касу сам — інший спосіб із власною касою за замовчуванням її вже не міняє.
    fireEvent.change(cashSelect(dialog)!, { target: { value: 'cr-main' } });
    fireEvent.change(methodSelect(dialog), { target: { value: 'cash_safe' } });
    expect(cashSelect(dialog)?.value).toBe('cr-main');
  });

  it('картка без каси за замовчуванням: поля «Каса» немає, запит без каси — як раніше', async () => {
    const dialog = await openPayDialog();

    fireEvent.change(methodSelect(dialog), { target: { value: 'card_terminal' } });
    expect(cashSelect(dialog)).toBeNull();
    fireEvent.click(payButton(dialog));

    await waitFor(() => expect(paymentBody()).not.toBeNull());
    const body = paymentBody()!;
    expect(body.method).toBe('card_terminal');
    expect(body).not.toHaveProperty('sourceType');
    expect(body).not.toHaveProperty('cashRegisterId');
  });

  it('каси іншої валюти, ніж рахунок, не пропонуються — навіть як замовчування способу', async () => {
    methods[0] = method('cash', 'Готівка', {
      defaultSourceType: 'CASH_REGISTER',
      defaultCashRegisterId: 'cr-usd',
      defaultDestinationName: 'Каса доларова',
    });
    const dialog = await openPayDialog();

    const options = within(cashSelect(dialog)!)
      .getAllByRole('option')
      .map(o => o.textContent);
    expect(options).toContain('Каса головна');
    expect(options).not.toContain('Каса доларова');
    // Замовчування не підходить рахунку — поле порожнє, кнопка чекає вибору касира.
    expect(cashSelect(dialog)?.value).toBe('');
    expect(payButton(dialog)).toBeDisabled();
  });

  it('помилка сервера (закрита зміна фіскальної каси) — у самому вікні, вікно лишається', async () => {
    payResponse = () =>
      Promise.reject(new Error('Відкрийте касову зміну фіскальної каси перед операцією'));
    const dialog = await openPayDialog();
    fireEvent.change(cashSelect(dialog)!, { target: { value: 'cr-main' } });
    fireEvent.click(payButton(dialog));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Відкрийте касову зміну фіскальної каси перед операцією',
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
