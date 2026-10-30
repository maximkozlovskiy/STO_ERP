// Сторінка рахунків → вікно «Оплатити» (спільне ClientPaymentModal, 2026-10-15).
//
// Правила самого вікна (каса для готівки BR-PAY-019, каси за валютою, QR без каси, ключ
// ідемпотентності) перевіряє `components/ui/__tests__/ClientPaymentModal.test.tsx` — туди перенесено
// кейси цього файла. Тут — що сторінка відкриває вікно для свого рахунку: запит несе `invoiceId`
// (наряд рахунку виводить сервер, BR-PAY-021), помилка лишається у вікні, QR — для рахунку.

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

// Валюта рахунку: null — базова (гривня).
let invCurrency: string | null = null;
vi.mock('@/hooks/api/useInvoices', async importOriginal => {
  const actual = await importOriginal<typeof import('@/hooks/api/useInvoices')>();
  return {
    ...actual,
    useInvoices: () => ({
      data: { items: [{ ...INV, currencyCode: invCurrency }], total: 1, page: 1, limit: 20 },
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
// Стан запиту кас: перелік прийшов (типово) або впав (Bug #858).
let registersQuery: { data?: typeof REGISTERS; isPending: boolean; isError: boolean } = {
  data: REGISTERS,
  isPending: false,
  isError: false,
};
vi.mock('@/hooks/api/useCash', async importOriginal => {
  const actual = await importOriginal<typeof import('@/hooks/api/useCash')>();
  return {
    ...actual,
    useBaseCurrency: () => ({ data: { code: 'UAH', symbol: '₴' } }),
    useRetryCashFiscal: () => ({ mutateAsync: async () => ({}) }),
    useCashRegisters: () => registersQuery,
  };
});
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
  defaultDestinationCurrencyCode: string | null;
};
const method = (code: string, name: string, over: Partial<Method> = {}): Method => ({
  code,
  name,
  isActive: true,
  defaultSourceType: null,
  defaultCashRegisterId: null,
  defaultBankAccountId: null,
  defaultDestinationName: null,
  defaultDestinationCurrencyCode: null,
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

describe('Рахунки — вікно «Оплатити» відкривається для рахунку', () => {
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
    invCurrency = null;
    registersQuery = { data: REGISTERS, isPending: false, isError: false };
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/payment-methods') return Promise.resolve(methods);
      // Підключений шлюз філії рахунку (BR-PAY-033): QR-спосіб видно лише свого шлюзу.
      if (path.startsWith('/online-payments/gateway'))
        return Promise.resolve({ provider: 'monobank' });
      if (path === '/payments') return payResponse();
      if (path === '/invoices/inv-a')
        return Promise.resolve({ ...INV, currencyCode: invCurrency, lines: [] });
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

  // Bug #859: QR-оплату створює сервер за способом оплати — касу з вікна вона не бере.
  it('monobank QR із касою за замовчуванням: поля «Каса» немає', async () => {
    methods.push(
      method('monobank_qr', 'Monobank QR', {
        defaultSourceType: 'CASH_REGISTER',
        defaultCashRegisterId: 'cr-main',
        defaultDestinationName: 'Каса головна',
        defaultDestinationCurrencyCode: 'UAH',
      }),
    );
    const dialog = await openPayDialog();
    await within(dialog).findByRole('option', { name: 'Monobank QR' });

    fireEvent.change(methodSelect(dialog), { target: { value: 'monobank_qr' } });
    expect(cashSelect(dialog)).toBeNull();
    expect(
      within(dialog.closest('[role="dialog"]') ?? dialog).getByRole('button', {
        name: 'Показати QR',
      }),
    ).toBeInTheDocument();
  });
});
