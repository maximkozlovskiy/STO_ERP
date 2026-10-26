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
// Роль касира: перелік рахунків (`GET /bank-accounts`) — лише OWNER / ADMIN / ACCOUNTANT.
let role = 'OWNER';
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ employee: { id: 'e1', role } }) }));

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
const BANKS = [
  { id: 'ba-main', name: 'Рахунок ПриватБанк', currencyCode: 'UAH' },
  { id: 'ba-second', name: 'Рахунок Моно', currencyCode: 'UAH' },
  { id: 'ba-usd', name: 'Рахунок доларовий', currencyCode: 'USD' },
];
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
const bankSelect = (dialog: HTMLElement) =>
  within(dialog).queryByRole('combobox', { name: /^Рахунок/ }) as HTMLSelectElement | null;
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
  role = 'OWNER';
  methods = [
    method('cash', 'Готівка'),
    // Безготівковий спосіб із рахунком за замовчуванням (BR-PAY-023).
    method('card_terminal', 'Термінал', {
      defaultSourceType: 'BANK_ACCOUNT',
      defaultBankAccountId: 'ba-main',
    }),
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
    if (path === '/bank-accounts') return Promise.resolve({ items: BANKS });
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

  // guards: BR-PAY-023
  it('картка без каси за замовчуванням: поля «Каса» немає, запит несе рахунок способу', async () => {
    const { dialog } = await openDialog();

    fireEvent.change(methodSelect(dialog), { target: { value: 'card_terminal' } });
    expect(cashSelect(dialog)).toBeNull();
    await waitFor(() => expect(bankSelect(dialog)?.value).toBe('ba-main'));
    fireEvent.click(payButton(dialog));

    await waitFor(() => expect(paymentBody()).not.toBeNull());
    const body = paymentBody()!;
    expect(body.method).toBe('card_terminal');
    expect(body).toMatchObject({ sourceType: 'BANK_ACCOUNT', bankAccountId: 'ba-main' });
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

  // Сума для QR розбирається так само, як для оплати: «1 000,50» — число, нерозбірне — помилка,
  // а не QR на весь залишок. Mutation-verify: гілку QR повернути на `parseFloat(form.amount)` з
  // `undefined` для нерозбірного → обидва кейси падають.
  it.each([
    ['1 000,50', 'рахунок 2 000', 1000.5],
    ['abc', 'нерозбірне', null],
  ])('QR: сума «%s» (%s) → %s', async (value, _why, expected) => {
    withQr();
    const { dialog, onShowQr } = await openDialog({ ...INVOICE, amount: 2000 });
    fireEvent.change(methodSelect(dialog), { target: { value: 'monobank_qr' } });
    fireEvent.change(within(dialog).getByLabelText(/^Сума,/), { target: { value } });
    fireEvent.click(
      within(dialog.closest('[role="dialog"]') ?? dialog).getByRole('button', {
        name: 'Показати QR',
      }),
    );
    if (expected === null) {
      expect(await within(dialog).findByRole('alert')).toHaveTextContent(/не більшою за залишок/);
      expect(onShowQr).not.toHaveBeenCalled();
    } else {
      expect(onShowQr).toHaveBeenCalledWith(expected);
    }
  });

  it('наряд: способу monobank QR у переліку немає (QR-оплату сервер створює лише за рахунком)', async () => {
    withQr();
    const { dialog } = await openDialog(WORK_ORDER);

    const codes = within(methodSelect(dialog))
      .getAllByRole('option')
      .map(o => (o as HTMLOptionElement).value);
    expect(codes).not.toContain('monobank_qr');
  });

  // Bug #870: setup створює ще PrivatPay QR і LiqPay QR — у вікні наряду їх теж не має бути:
  // обраний, такий спосіб реєстрував оплату одразу, без жодного QR.
  it('наряд: жодного QR-способу (privat24_qr, liqpay_qr) у переліку немає', async () => {
    withQr();
    methods.push(method('privat24_qr', 'PrivatPay QR'), method('liqpay_qr', 'LiqPay QR'));
    const { dialog } = await openDialog(WORK_ORDER);

    const codes = within(methodSelect(dialog))
      .getAllByRole('option')
      .map(o => (o as HTMLOptionElement).value);
    expect(codes).toContain('cash');
    expect(codes.filter(c => c.endsWith('_qr'))).toEqual([]);
  });
});

describe('ClientPaymentModal — безготівкова оплата на банківський рахунок (BR-PAY-023)', () => {
  // guards: BR-PAY-023
  it("спосіб без рахунку за замовчуванням: поле порожнє й обов'язкове, оплата заблокована", async () => {
    methods[1] = method('card_terminal', 'Термінал');
    const { dialog } = await openDialog();

    fireEvent.change(methodSelect(dialog), { target: { value: 'card_terminal' } });
    await waitFor(() => expect(bankSelect(dialog)).not.toBeNull());
    expect(bankSelect(dialog)!.value).toBe('');
    expect(bankSelect(dialog)).toBeRequired();
    expect(
      await within(dialog).findByText('Для безготівкової оплати оберіть банківський рахунок'),
    ).toBeInTheDocument();
    expect(payButton(dialog)).toBeDisabled();
    fireEvent.click(payButton(dialog));
    expect(paymentCalls()).toHaveLength(0);
  });

  // guards: BR-PAY-023
  it('обраний касиром рахунок перемагає рахунок способу й іде в запит', async () => {
    const { dialog } = await openDialog();
    fireEvent.change(methodSelect(dialog), { target: { value: 'card_terminal' } });
    await waitFor(() => expect(bankSelect(dialog)?.value).toBe('ba-main'));
    fireEvent.change(bankSelect(dialog)!, { target: { value: 'ba-second' } });
    fireEvent.click(payButton(dialog));
    await waitFor(() =>
      expect(paymentBody()).toMatchObject({
        sourceType: 'BANK_ACCOUNT',
        bankAccountId: 'ba-second',
      }),
    );
  });

  // guards: BR-PAY-023
  it('рахунки іншої валюти, ніж документ, не пропонуються', async () => {
    const { dialog } = await openDialog();
    fireEvent.change(methodSelect(dialog), { target: { value: 'card_terminal' } });
    await within(bankSelect(dialog)!).findByRole('option', { name: 'Рахунок ПриватБанк' });
    const options = within(bankSelect(dialog)!)
      .getAllByRole('option')
      .map(o => o.textContent);
    expect(options).toContain('Рахунок ПриватБанк');
    expect(options).not.toContain('Рахунок доларовий');
  });

  // guards: BR-PAY-023
  it('готівка й спосіб із касою за замовчуванням — поля «Рахунок» немає', async () => {
    const { dialog } = await openDialog();
    expect(bankSelect(dialog)).toBeNull();
    fireEvent.change(methodSelect(dialog), { target: { value: 'cash_safe' } });
    expect(bankSelect(dialog)).toBeNull();
  });

  // guards: BR-PAY-023
  it('роль без переліку рахунків (RECEPTIONIST): рахунок способу оплати з його назвою, без запиту /bank-accounts', async () => {
    role = 'RECEPTIONIST';
    methods[1] = method('card_terminal', 'Термінал', {
      defaultSourceType: 'BANK_ACCOUNT',
      defaultBankAccountId: 'ba-main',
      defaultDestinationName: 'Рахунок ПриватБанк',
      defaultDestinationCurrencyCode: 'UAH',
    });
    const { dialog } = await openDialog();

    fireEvent.change(methodSelect(dialog), { target: { value: 'card_terminal' } });
    await waitFor(() => expect(bankSelect(dialog)?.value).toBe('ba-main'));
    expect(
      within(bankSelect(dialog)!).getByRole('option', { name: 'Рахунок ПриватБанк' }),
    ).toBeInTheDocument();
    expect(apiFetchMock.mock.calls.some(([path]) => path === '/bank-accounts')).toBe(false);
    expect(within(dialog).queryByText(/Не вдалося завантажити рахунки/)).toBeNull();
    fireEvent.click(payButton(dialog));

    await waitFor(() =>
      expect(paymentBody()).toMatchObject({ sourceType: 'BANK_ACCOUNT', bankAccountId: 'ba-main' }),
    );
  });

  // guards: BR-PAY-023
  it('роль без переліку рахунків і спосіб без рахунку у валюті документа: пояснення, оплата неактивна', async () => {
    role = 'RECEPTIONIST';
    methods[1] = method('card_terminal', 'Термінал', {
      defaultSourceType: 'BANK_ACCOUNT',
      defaultBankAccountId: 'ba-usd',
      defaultDestinationName: 'Рахунок доларовий',
      defaultDestinationCurrencyCode: 'USD',
    });
    const { dialog } = await openDialog();

    fireEvent.change(methodSelect(dialog), { target: { value: 'card_terminal' } });
    expect(
      await within(dialog).findByText(/Способу оплати не задано банківського рахунку у валюті UAH/),
    ).toBeInTheDocument();
    expect(
      within(bankSelect(dialog)!).queryByRole('option', { name: 'Рахунок доларовий' }),
    ).toBeNull();
    expect(payButton(dialog)).toBeDisabled();
  });
});

describe('ClientPaymentModal — оплата наряду (BR-PAY-020, BR-PAY-017)', () => {
  // guards: BR-PAY-021
  it('наряд: запит несе workOrderId, а не invoiceId', async () => {
    const { dialog, onPaid } = await openDialog(WORK_ORDER);
    fireEvent.change(methodSelect(dialog), { target: { value: 'card_terminal' } });
    await waitFor(() => expect(bankSelect(dialog)?.value).toBe('ba-main'));
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
    fireEvent.change(methodSelect(dialog), { target: { value: 'card_terminal' } });
    await waitFor(() => expect(bankSelect(dialog)?.value).toBe('ba-main'));
    fireEvent.click(payButton(dialog));
    await waitFor(() => expect(paymentBody()?.amount).toBe(1140));
  });

  it('введена сума йде як є (часткова оплата / аванс)', async () => {
    const { dialog } = await openDialog(WORK_ORDER);
    fireEvent.change(methodSelect(dialog), { target: { value: 'card_terminal' } });
    await waitFor(() => expect(bankSelect(dialog)?.value).toBe('ba-main'));
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
      await waitFor(() => expect(bankSelect(dialog)?.value).toBe('ba-main'));
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
  // Поле було `type="number"`: вставлене «1 000,50» браузер віддавав порожнім рядком, а порожнє —
  // «весь залишок», тож оплата мовчки йшла на 1 140 замість 1 000,50 (TECH-DEBT §12 п.13).
  // Mutation-verify: `normalizeDecimalInput(form.amount)` → `form.amount` → «1 000,50» падає;
  // `raw ? Number(raw) : remaining` → `Number.isFinite(Number(raw)) ? … : remaining` → «abc» падає.
  it.each([
    ['1 000,50', 1000.5],
    ['1 000,50', 1000.5],
    ['250,5', 250.5],
  ])('сума «%s» з UA-комою й пробілами тисяч → %s, а не весь залишок', async (value, expected) => {
    const { dialog } = await openDialog(WORK_ORDER);
    const field = within(dialog).getByLabelText(/^Сума,/) as HTMLInputElement;
    expect(field.type).toBe('text');
    expect(field.inputMode).toBe('decimal');
    fireEvent.change(methodSelect(dialog), { target: { value: 'card_terminal' } });
    await waitFor(() => expect(bankSelect(dialog)?.value).toBe('ba-main'));
    fireEvent.change(field, { target: { value } });
    fireEvent.click(payButton(dialog));
    await waitFor(() => expect(paymentBody()?.amount).toBe(expected));
  });

  // guards: BR-PAY-017
  it('нерозбірна сума («abc») — помилка у вікні, а не оплата всього залишку', async () => {
    const { dialog, onPaid } = await openDialog(WORK_ORDER);
    fireEvent.change(methodSelect(dialog), { target: { value: 'card_terminal' } });
    await waitFor(() => expect(bankSelect(dialog)?.value).toBe('ba-main'));
    fireEvent.change(within(dialog).getByLabelText(/^Сума,/), { target: { value: 'abc' } });
    fireEvent.click(payButton(dialog));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/не більшою за залишок/);
    expect(paymentCalls()).toHaveLength(0);
    expect(onPaid).not.toHaveBeenCalled();
  });

  // guards: BR-PAY-017
  it('сплачено повністю — оплатити нічого: кнопка неактивна', async () => {
    const { dialog } = await openDialog({ ...WORK_ORDER, paidAmount: 1440 });
    fireEvent.change(methodSelect(dialog), { target: { value: 'card_terminal' } });
    await waitFor(() => expect(bankSelect(dialog)?.value).toBe('ba-main'));
    expect(payButton(dialog)).toBeDisabled();
  });
});

describe('ClientPaymentModal — ключ ідемпотентності на відкриття', () => {
  it('повтор після помилки в тому самому вікні — той самий ключ; нове відкриття — новий', async () => {
    payResponse = () => Promise.reject(new Error('Мережа недоступна'));
    const { dialog, rerender } = await openDialog(WORK_ORDER);
    fireEvent.change(methodSelect(dialog), { target: { value: 'card_terminal' } });
    await waitFor(() => expect(bankSelect(dialog)?.value).toBe('ba-main'));
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

// TECH-DEBT §12 п.13: Escape закривав «Оплатити» з уже введеною сумою без питання. Тепер — як
// `PaymentReversalModal`: уведене (сума, примітка, обраний спосіб / каса / рахунок) → «Є незбережені
// зміни»; другий Escape закриває лише діалог.
// Mutation-verify: `if (touched) dirty.markDirty()` → прибрати → «сума»/«примітка»/«спосіб» падають;
// `onClose={() => void close()}` → `onClose={onClose}` → кейси з питанням падають;
// прибрати `setMethodChosen(false)` з ефекту відкриття → «нове відкриття стартує чистим» падає.
describe('ClientPaymentModal — закриття з уведеним питає (Escape)', () => {
  const escape = () => fireEvent.keyDown(document, { key: 'Escape' });
  const DIRTY = 'Є незбережені зміни';

  it('нічого не введено — Escape закриває без питання', async () => {
    const { onClose } = await openDialog(WORK_ORDER);
    escape();
    // Закриття проходить через `await confirmClose()` — onClose приходить мікрозадачею.
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(DIRTY)).not.toBeInTheDocument();
  });

  it.each([
    ['сума', (d: HTMLElement) => within(d).getByLabelText(/^Сума,/), '500'],
    ['примітка', (d: HTMLElement) => within(d).getByLabelText(/^Примітки/), 'аванс'],
  ])('уведена %s: Escape питає; «Скасувати» лишає вікно з уведеним', async (_n, field, value) => {
    const { dialog, onClose } = await openDialog(WORK_ORDER);
    fireEvent.change(field(dialog), { target: { value } });
    escape();

    expect(await screen.findByText(DIRTY)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    // Другий Escape — лише діалог підтвердження (верхній шар), вікно оплати лишається.
    escape();
    await waitFor(() => expect(screen.queryByText(DIRTY)).not.toBeInTheDocument());
    expect(onClose).not.toHaveBeenCalled();
    expect((field(dialog) as HTMLInputElement).value).toBe(value);
  });

  it('обраний касиром спосіб оплати теж питає; «Покинути» закриває вікно', async () => {
    const { dialog, onClose } = await openDialog(WORK_ORDER);
    fireEvent.change(methodSelect(dialog), { target: { value: 'card_terminal' } });
    escape();

    expect(await screen.findByText(DIRTY)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Покинути' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('нове відкриття стартує чистим: уведене минулого разу не питає при Escape', async () => {
    const { dialog, onClose, rerender } = await openDialog(WORK_ORDER);
    fireEvent.change(methodSelect(dialog), { target: { value: 'card_terminal' } });
    fireEvent.change(within(dialog).getByLabelText(/^Сума,/), { target: { value: '500' } });
    // Викликач закриває вікно через `open` (напр. після onPaid) — без питання.
    rerender(WORK_ORDER, false);
    rerender(WORK_ORDER, true);
    await screen.findByRole('dialog');
    escape();

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(DIRTY)).not.toBeInTheDocument();
  });
});
