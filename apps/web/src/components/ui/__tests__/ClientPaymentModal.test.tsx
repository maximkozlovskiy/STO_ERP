// Вікно «Оплатити» — спільне для рахунку й наряду (рішення власника 2026-10-15).
//
// Кейси каси для готівки (BR-PAY-019) перенесено з InvoicesPage.pay-cash-register.test.tsx разом
// із логікою вікна: поле «Каса» обов'язкове для готівки, заповнюється касою за замовчуванням
// способу, каси — лише у валюті документа (Bug #857), порожній перелік пояснено (Bug #858), QR —
// без каси (Bug #859). Нове: оплата наряду (`workOrderId`, BR-PAY-020/021), сума за замовчуванням =
// залишок (BR-PAY-017), ключ ідемпотентності на відкриття, QR лише для рахунку.

import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, it, expect, describe, beforeEach } from 'vitest';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  apiBlobFetch: vi.fn(),
}));
vi.mock('@/lib/ref-cache', () => ({ getCached: () => null, setCache: vi.fn() }));

const REGISTERS = [
  { id: 'cr-main', name: 'Каса головна' },
  { id: 'cr-second', name: 'Каса друга' },
  // Валютна каса: гривневий документ оплату в неї не прийме (валюта оплати = валюта каси).
  { id: 'cr-usd', name: 'Каса доларова', currencyCode: 'USD' },
];
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
    useCashRegisters: () => registersQuery,
  };
});

import { ClientPaymentModal, type ClientPaymentTarget } from '../ClientPaymentModal';

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

const INVOICE: ClientPaymentTarget = {
  kind: 'invoice',
  id: 'inv-a',
  counterpartyId: 'cp-1',
  amount: 100,
  paidAmount: 0,
  currencyCode: null,
};
const WORK_ORDER: ClientPaymentTarget = {
  kind: 'workOrder',
  id: 'wo-1',
  counterpartyId: 'cp-1',
  amount: 1440,
  paidAmount: 300,
  currencyCode: null,
};

interface Rendered {
  dialog: HTMLElement;
  onPaid: ReturnType<typeof vi.fn>;
  onClose: ReturnType<typeof vi.fn>;
  onShowQr: ReturnType<typeof vi.fn>;
  rerender: (target: ClientPaymentTarget | null, open?: boolean) => void;
}

async function openDialog(
  target: ClientPaymentTarget = INVOICE,
  opts: { withQr?: boolean } = {},
): Promise<Rendered> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onPaid = vi.fn();
  const onClose = vi.fn();
  const onShowQr = vi.fn();
  const ui = (t: ClientPaymentTarget | null, open = true) => (
    <QueryClientProvider client={client}>
      <ClientPaymentModal
        open={open}
        target={t}
        title="Оплата"
        onClose={onClose}
        onPaid={onPaid}
        {...(opts.withQr === false ? {} : { onShowQr })}
      />
    </QueryClientProvider>
  );
  const r = render(ui(target));
  const dialog = await screen.findByRole('dialog');
  // Способи оплати прийшли з сервера — у списку справжні назви, а не запасні.
  await within(dialog).findByRole('option', { name: methods[0]!.name });
  return {
    dialog,
    onPaid,
    onClose,
    onShowQr,
    rerender: (t, open = true) => r.rerender(ui(t, open)),
  };
}

const cashSelect = (dialog: HTMLElement) =>
  within(dialog).queryByRole('combobox', { name: /^Каса/ }) as HTMLSelectElement | null;
const methodSelect = (dialog: HTMLElement) =>
  within(dialog).getByRole('combobox', { name: /^Метод оплати/ }) as HTMLSelectElement;
const payButton = (dialog: HTMLElement) =>
  within(dialog.closest('[role="dialog"]') ?? dialog).getByRole('button', {
    name: 'Підтвердити оплату',
  });
const paymentCalls = () => apiFetchMock.mock.calls.filter(([path]) => path === '/payments');
const paymentBody = () => {
  const call = paymentCalls()[0];
  return call ? (JSON.parse((call[1] as { body: string }).body) as Record<string, unknown>) : null;
};
const paymentHeaders = (i = 0) =>
  (paymentCalls()[i]?.[1] as { headers?: Record<string, string> } | undefined)?.headers ?? {};

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
  registersQuery = { data: REGISTERS, isPending: false, isError: false };
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation((path: string) => {
    if (path === '/payment-methods') return Promise.resolve(methods);
    if (path === '/payments') return payResponse();
    return Promise.resolve({});
  });
});

describe('ClientPaymentModal — каса для готівки (BR-PAY-019)', () => {
  // guards: BR-PAY-019
  it('готівка з касою за замовчуванням: поле «Каса» заповнене нею, запит несе касу', async () => {
    methods[0] = method('cash', 'Готівка', {
      defaultSourceType: 'CASH_REGISTER',
      defaultCashRegisterId: 'cr-main',
      defaultDestinationName: 'Каса головна',
    });
    const { dialog } = await openDialog();

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
    const { dialog } = await openDialog();

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
    const { dialog } = await openDialog();

    fireEvent.change(methodSelect(dialog), { target: { value: 'cash_safe' } });
    expect(cashSelect(dialog)?.value).toBe('cr-second');
    expect(cashSelect(dialog)).not.toBeRequired();

    fireEvent.change(methodSelect(dialog), { target: { value: 'cash' } });
    expect(cashSelect(dialog)?.value).toBe('');

    fireEvent.change(cashSelect(dialog)!, { target: { value: 'cr-main' } });
    fireEvent.change(methodSelect(dialog), { target: { value: 'cash_safe' } });
    expect(cashSelect(dialog)?.value).toBe('cr-main');
  });

  it('картка без каси за замовчуванням: поля «Каса» немає, запит без каси', async () => {
    const { dialog } = await openDialog();

    fireEvent.change(methodSelect(dialog), { target: { value: 'card_terminal' } });
    expect(cashSelect(dialog)).toBeNull();
    fireEvent.click(payButton(dialog));

    await waitFor(() => expect(paymentBody()).not.toBeNull());
    const body = paymentBody()!;
    expect(body.method).toBe('card_terminal');
    expect(body).not.toHaveProperty('sourceType');
    expect(body).not.toHaveProperty('cashRegisterId');
  });

  it('каси іншої валюти, ніж документ, не пропонуються — навіть як замовчування способу', async () => {
    methods[0] = method('cash', 'Готівка', {
      defaultSourceType: 'CASH_REGISTER',
      defaultCashRegisterId: 'cr-usd',
      defaultDestinationName: 'Каса доларова',
    });
    const { dialog } = await openDialog();

    const options = within(cashSelect(dialog)!)
      .getAllByRole('option')
      .map(o => o.textContent);
    expect(options).toContain('Каса головна');
    expect(options).not.toContain('Каса доларова');
    expect(cashSelect(dialog)?.value).toBe('');
    expect(payButton(dialog)).toBeDisabled();
  });

  it('помилка сервера (закрита зміна фіскальної каси) — у самому вікні, вікно лишається', async () => {
    payResponse = () =>
      Promise.reject(new Error('Відкрийте касову зміну фіскальної каси перед операцією'));
    const { dialog, onPaid, onClose } = await openDialog();
    fireEvent.change(cashSelect(dialog)!, { target: { value: 'cr-main' } });
    fireEvent.click(payButton(dialog));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Відкрийте касову зміну фіскальної каси перед операцією',
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(onPaid).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  // Bug #857
  it('каса за замовчуванням поза переліком: пропонується лише у валюті документа', async () => {
    const far = (currency: string) =>
      method('cash', 'Готівка', {
        defaultSourceType: 'CASH_REGISTER',
        defaultCashRegisterId: 'cr-far',
        defaultDestinationName: 'Каса далека',
        defaultDestinationCurrencyCode: currency,
      });
    methods[0] = far('USD');
    let { dialog } = await openDialog();
    const options = () =>
      within(cashSelect(dialog)!)
        .getAllByRole('option')
        .map(o => o.textContent);
    expect(options()).not.toContain('Каса далека');
    expect(cashSelect(dialog)?.value).toBe('');
    cleanup();

    methods[0] = far('UAH');
    ({ dialog } = await openDialog());
    expect(options()).toContain('Каса далека');
    expect(cashSelect(dialog)?.value).toBe('cr-far');
  });

  // Bug #858
  it('збій завантаження кас: у полі текст помилки, а не «оберіть касу»', async () => {
    registersQuery = { data: undefined, isPending: false, isError: true };
    const { dialog } = await openDialog();

    expect(
      within(dialog).getByText('Не вдалося завантажити каси — закрийте вікно й відкрийте знову'),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText('Для оплати готівкою оберіть касу')).toBeNull();
    expect(payButton(dialog)).toBeDisabled();
  });

  it('жодної каси у валюті документа: так і сказано, з кодом валюти', async () => {
    const { dialog } = await openDialog({ ...INVOICE, currencyCode: 'EUR' });

    expect(within(dialog).getByText('Немає жодної каси у валюті EUR')).toBeInTheDocument();
    expect(payButton(dialog)).toBeDisabled();
  });
});

describe('ClientPaymentModal — QR лише для рахунку (Bug #859)', () => {
  const withQr = () =>
    methods.push(
      method('monobank_qr', 'Monobank QR', {
        defaultSourceType: 'CASH_REGISTER',
        defaultCashRegisterId: 'cr-main',
        defaultDestinationName: 'Каса головна',
        defaultDestinationCurrencyCode: 'UAH',
      }),
    );

  it('рахунок, monobank QR із касою за замовчуванням: поля «Каса» немає, кнопка «Показати QR»', async () => {
    withQr();
    const { dialog, onShowQr } = await openDialog();

    fireEvent.change(methodSelect(dialog), { target: { value: 'monobank_qr' } });
    expect(cashSelect(dialog)).toBeNull();
    fireEvent.click(
      within(dialog.closest('[role="dialog"]') ?? dialog).getByRole('button', {
        name: 'Показати QR',
      }),
    );
    expect(onShowQr).toHaveBeenCalledWith(undefined);
    expect(paymentBody()).toBeNull();
  });

  it('наряд: способу monobank QR у переліку немає (QR-оплату сервер створює лише за рахунком)', async () => {
    withQr();
    const { dialog } = await openDialog(WORK_ORDER);

    const codes = within(methodSelect(dialog))
      .getAllByRole('option')
      .map(o => (o as HTMLOptionElement).value);
    expect(codes).not.toContain('monobank_qr');
  });
});

describe('ClientPaymentModal — оплата наряду (BR-PAY-020, BR-PAY-017)', () => {
  // guards: BR-PAY-021
  it('наряд: запит несе workOrderId, а не invoiceId', async () => {
    const { dialog, onPaid } = await openDialog(WORK_ORDER);
    fireEvent.change(methodSelect(dialog), { target: { value: 'card_terminal' } });
    fireEvent.click(payButton(dialog));

    await waitFor(() => expect(paymentBody()).not.toBeNull());
    expect(paymentBody()).toMatchObject({ counterpartyId: 'cp-1', workOrderId: 'wo-1' });
    expect(paymentBody()).not.toHaveProperty('invoiceId');
    // Сума і вона ж із валютою документа — для повідомлення викликача.
    await waitFor(() =>
      expect(onPaid).toHaveBeenCalledWith(1140, expect.stringMatching(/140,00 ₴$/)),
    );
  });

  // guards: BR-PAY-017
  it('сума за замовчуванням — залишок: «Разом» 1 440 − сплачено 300 = 1 140', async () => {
    const { dialog } = await openDialog(WORK_ORDER);

    expect(within(dialog).getByText('Сума наряду:')).toBeInTheDocument();
    const amount = within(dialog).getByLabelText(/^Сума,/) as HTMLInputElement;
    expect(amount.placeholder).toBe('1140');
    expect(amount.max).toBe('1140');
    fireEvent.change(methodSelect(dialog), { target: { value: 'card_terminal' } });
    fireEvent.click(payButton(dialog));
    await waitFor(() => expect(paymentBody()?.amount).toBe(1140));
  });

  it('введена сума йде як є (часткова оплата / аванс)', async () => {
    const { dialog } = await openDialog(WORK_ORDER);
    fireEvent.change(methodSelect(dialog), { target: { value: 'card_terminal' } });
    fireEvent.change(within(dialog).getByLabelText(/^Сума,/), { target: { value: '500' } });
    fireEvent.click(payButton(dialog));
    await waitFor(() => expect(paymentBody()?.amount).toBe(500));
  });

  // guards: BR-PAY-017
  it.each([['1500'], ['0'], ['-5']])(
    'сума %s поза межами «від копійки до залишку» → помилка у вікні, запиту немає',
    async value => {
      const { dialog, onPaid } = await openDialog(WORK_ORDER);
      fireEvent.change(methodSelect(dialog), { target: { value: 'card_terminal' } });
      fireEvent.change(within(dialog).getByLabelText(/^Сума,/), { target: { value } });
      fireEvent.click(payButton(dialog));

      expect(await within(dialog).findByRole('alert')).toHaveTextContent(
        /не більшою за залишок до сплати \(1\s?140,00 ₴\)/,
      );
      expect(paymentCalls()).toHaveLength(0);
      expect(onPaid).not.toHaveBeenCalled();
    },
  );

  // guards: BR-PAY-017
  it('сплачено повністю — оплатити нічого: кнопка неактивна', async () => {
    const { dialog } = await openDialog({ ...WORK_ORDER, paidAmount: 1440 });
    fireEvent.change(methodSelect(dialog), { target: { value: 'card_terminal' } });
    expect(payButton(dialog)).toBeDisabled();
  });
});

describe('ClientPaymentModal — ключ ідемпотентності на відкриття', () => {
  it('повтор після помилки в тому самому вікні — той самий ключ; нове відкриття — новий', async () => {
    payResponse = () => Promise.reject(new Error('Мережа недоступна'));
    const { dialog, rerender } = await openDialog(WORK_ORDER);
    fireEvent.change(methodSelect(dialog), { target: { value: 'card_terminal' } });
    fireEvent.click(payButton(dialog));
    await within(dialog).findByRole('alert');
    fireEvent.click(payButton(dialog));
    await waitFor(() => expect(paymentCalls()).toHaveLength(2));

    const first = paymentHeaders(0)['Idempotency-Key'];
    expect(first).toBeTruthy();
    expect(paymentHeaders(1)['Idempotency-Key']).toBe(first);

    rerender(WORK_ORDER, false);
    rerender(WORK_ORDER, true);
    const reopened = await screen.findByRole('dialog');
    fireEvent.change(methodSelect(reopened), { target: { value: 'card_terminal' } });
    fireEvent.click(payButton(reopened));
    await waitFor(() => expect(paymentCalls()).toHaveLength(3));
    expect(paymentHeaders(2)['Idempotency-Key']).toBeTruthy();
    expect(paymentHeaders(2)['Idempotency-Key']).not.toBe(first);
  });
});
