// «Рознести як» у вікні «Новий банківський платіж» (BR-BANK-041): одна дія — платіж внесено й
// рознесено; відмова — помилка у вікні, вікно відкрите.
//   - розділ є; поки рахунок не обрано — вибір виду недоступний;
//   - види за напрямом (BR-BANK-025): вхідний — види match і переказ, вихідний — види reconcile;
//   - зміна напряму / рахунку / суми скидає несумісний вибір;
//   - тіло запиту = CreateBankTransactionDto + allocation лише з полями свого виду;
//   - перед видами, що проводять гроші (оплата рахунку, зняття в касу…), — крок підтвердження;
//   - без обов'язкового поля виду запит не йде; подвійний клік — один запит.
//
// Mutation-verify:
//   - `if (allocType !== '' && !allowedTypes(next).includes(allocType)) clearAllocation()` → прибрати
//                                                                   → «зміна напряму скидає вид» падає;
//   - прибрати `onAmountChange` з register('amount')                  → «сума більша за залишок» падає;
//   - `BANK_TX_CREATE_CONFIRM_TYPES.has(…)` → false                   → кейси підтвердження падають;
//   - `if (savingRef.current) return;` у send прибрати                 → «подвійний клік» падає;
//   - ефект «рахунок переказу не з переліку → скинути» прибрати        → «зміна рахунку» падає.

import { screen, waitFor, fireEvent, within } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';

vi.mock('@/lib/format', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/format')>()),
  kyivToday: () => '2026-10-14',
}));

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

vi.mock('@/hooks/api/useInfrastructure', () => ({
  useBranches: () => ({ data: [] }),
}));

// Пікер — стуб: «pick» обирає перший елемент, який повернув fetchItems.
vi.mock('@/components/ui/search-picker-modal', () => ({
  SearchPickerModal: (p: {
    open: boolean;
    title: string;
    onSelect: (item: unknown) => void;
    fetchItems: (q: string) => Promise<unknown[]>;
  }) =>
    p.open ? (
      <div data-testid="picker" data-title={p.title}>
        <button type="button" onClick={() => void p.fetchItems('').then(i => p.onSelect(i[0]))}>
          pick
        </button>
      </div>
    ) : null,
}));

import { BankTransactionCreateModal } from '../BankTransactionCreateModal';
import { renderWithQueryClient } from '../../../__tests__/query-utils';

const uuid = (n: number) =>
  `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const ACC_MAIN = uuid(1);
const ACC_RESERVE = uuid(2);
const CLIENT = uuid(3);
const INVOICE = uuid(4);
const CAT_RENT = uuid(5);
const CASH_UAH = uuid(6);

const account = (id: string, name: string) => ({
  id,
  name,
  currencyCode: 'UAH',
  currencyId: 'cur-uah',
  ibanUA: 'UA213223130000026007233566001',
  orgId: 'o1',
  autoPullEnabled: false,
  createdAt: '',
  updatedAt: '',
});

type Init = { method?: string; body?: string; headers?: Record<string, string> };

function mockApi(opts: { create?: () => Promise<unknown>; single?: boolean } = {}) {
  apiFetchMock.mockImplementation((path: string, init?: Init) => {
    if (path === '/bank-accounts')
      return Promise.resolve({
        items: opts.single
          ? [account(ACC_MAIN, 'Основний')]
          : [account(ACC_MAIN, 'Основний'), account(ACC_RESERVE, 'Резервний')],
      });
    if (path === '/bank-statements/transactions' && init?.method === 'POST')
      return opts.create ? opts.create() : Promise.resolve({ id: 'new-1', status: 'MATCHED' });
    if (path.startsWith('/counterparties?'))
      return Promise.resolve({ items: [{ id: CLIENT, companyName: 'ТОВ Клієнт' }] });
    if (path.startsWith('/invoices?'))
      return Promise.resolve({
        // Відбір за платником і статусами робить сервер — мок віддає вже відібране.
        items: [
          {
            id: INVOICE,
            number: 'INV-0042',
            amount: 1000,
            paidAmount: 400,
            counterpartyId: CLIENT,
            status: 'PARTIALLY_PAID',
          },
        ],
      });
    if (path.startsWith('/expense-categories'))
      return Promise.resolve({
        items: [{ id: CAT_RENT, name: 'Оренда', type: 'EXPENSE', isActive: true, children: [] }],
        total: 1,
      });
    if (path === '/cash-registers')
      return Promise.resolve({
        items: [{ id: CASH_UAH, name: 'Каса №1', currencyId: 'cur-uah', currencyCode: 'UAH' }],
      });
    return Promise.reject(new Error(`неочікуваний запит ${path}`));
  });
}

const createCalls = () =>
  apiFetchMock.mock.calls.filter(
    c => c[0] === '/bank-statements/transactions' && (c[1] as Init | undefined)?.method === 'POST',
  ) as [string, Init][];
const lastBody = () => JSON.parse(createCalls().at(-1)![1].body!) as Record<string, unknown>;

const allocSelect = () => screen.getByLabelText('Рознести як') as HTMLSelectElement;
const optionValues = () =>
  within(allocSelect())
    .getAllByRole('option')
    .map(o => (o as HTMLOptionElement).value);
const choose = (label: string | RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const pickVia = async (placeholder: string) => {
  const field = (await screen.findByText(placeholder)).parentElement!;
  fireEvent.click(within(field).getByRole('button', { name: 'Обрати' }));
  fireEvent.click(within(await screen.findByTestId('picker')).getByText('pick'));
  await waitFor(() => expect(screen.queryByTestId('picker')).not.toBeInTheDocument());
};

/** Відкрити вікно, обрати рахунок і ввести суму. */
async function openReady(
  props: { defaultDirection?: 'IN' | 'OUT'; onClose?: () => void } = {},
  amount = '600',
) {
  const onClose = props.onClose ?? vi.fn();
  renderWithQueryClient(
    <BankTransactionCreateModal open onClose={onClose} defaultDirection={props.defaultDirection} />,
  );
  await screen.findByRole('option', { name: 'Резервний' });
  choose(/Банківський рахунок/, ACC_MAIN);
  choose(/^Сума/, amount);
  return { onClose };
}

beforeEach(() => {
  apiFetchMock.mockReset();
  toastMock.success.mockReset();
  toastMock.error.mockReset();
});

describe('BankTransactionCreateModal — розділ «Рознести як»', () => {
  it('без рахунку вибір виду недоступний; за замовчуванням — «не розносити»', async () => {
    mockApi();
    renderWithQueryClient(<BankTransactionCreateModal open onClose={() => {}} />);
    await screen.findByRole('option', { name: 'Резервний' });
    expect(allocSelect()).toBeDisabled();
    expect(allocSelect().value).toBe('');
    expect(screen.getByText('Спершу оберіть банківський рахунок')).toBeInTheDocument();
    choose(/Банківський рахунок/, ACC_MAIN);
    expect(allocSelect()).toBeEnabled();
  });

  it('вхідний — «не розносити», види match і переказ; вихідний — шість видів reconcile', async () => {
    mockApi();
    await openReady();
    expect(optionValues()).toEqual([
      '',
      'PREPAYMENT',
      'SERVICE',
      'INVOICE',
      'REFUND',
      'OTHER',
      'TRANSFER',
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Вихідний' }));
    expect(optionValues()).toEqual([
      '',
      'SUPPLIER_PAYMENT',
      'CLIENT_REFUND',
      'EXPENSE',
      'PAYROLL',
      'TRANSFER',
      'CASH_WITHDRAWAL',
    ]);
  });

  it('без виду — як раніше: кнопка «Внести платіж», у тілі немає allocation', async () => {
    mockApi();
    await openReady();
    fireEvent.click(screen.getByRole('button', { name: 'Внести платіж' }));
    await waitFor(() => expect(createCalls()).toHaveLength(1));
    expect(lastBody().allocation).toBeUndefined();
    expect(toastMock.success).toHaveBeenCalledWith('Платіж внесено');
  });
});

describe('BankTransactionCreateModal — скидання несумісного вибору', () => {
  it('зміна напряму скидає вид, якого для нового напряму немає; переказ лишається', async () => {
    mockApi();
    await openReady();
    choose('Рознести як', 'SERVICE');
    fireEvent.click(screen.getByRole('button', { name: 'Вихідний' }));
    expect(allocSelect().value).toBe('');
    expect(screen.queryByText('Пошук контрагента…')).not.toBeInTheDocument();

    choose('Рознести як', 'TRANSFER');
    fireEvent.click(screen.getByRole('button', { name: 'Вхідний' }));
    expect(allocSelect().value).toBe('TRANSFER');
  });

  it('зміна рахунку платежу на рахунок переказу скидає рахунок переказу', async () => {
    mockApi();
    await openReady();
    choose('Рознести як', 'TRANSFER');
    await screen.findByRole('option', { name: 'Резервний (UAH)' });
    choose(/Інший власний рахунок/, ACC_RESERVE);
    expect((screen.getByLabelText(/Інший власний рахунок/) as HTMLSelectElement).value).toBe(
      ACC_RESERVE,
    );

    choose(/Банківський рахунок/, ACC_RESERVE);
    expect(await screen.findByRole('option', { name: 'Основний (UAH)' })).toBeInTheDocument();
    // Значення скинуто у формі, а не лише в DOM-селекті (той показав би '' і без скидання):
    // запит не йде, бо рахунок переказу знову не обрано.
    fireEvent.click(screen.getByRole('button', { name: 'Внести й рознести' }));
    expect(
      await screen.findByText('Оберіть рахунок, на який зроблено переказ'),
    ).toBeInTheDocument();
    expect(createCalls()).toHaveLength(0);
  });

  it('пікер рахунку: відбір за платником і статусами, що можна оплатити, йде на сервер', async () => {
    mockApi();
    await openReady();
    choose('Рознести як', 'INVOICE');
    await pickVia('Пошук контрагента…');
    await pickVia('Оберіть рахунок…');
    expect(screen.getByText('INV-0042')).toBeInTheDocument();
    const invoicePaths = apiFetchMock.mock.calls
      .map(c => String(c[0]))
      .filter(path => path.startsWith('/invoices?'));
    expect(invoicePaths.length).toBeGreaterThan(0);
    for (const path of invoicePaths) {
      const params = new URLSearchParams(path.split('?')[1]);
      expect(params.get('counterpartyId')).toBe(CLIENT);
      expect(params.get('statuses')).toBe('SENT,PARTIALLY_PAID,OVERDUE');
      expect(Number(params.get('limit'))).toBeLessThanOrEqual(200);
    }
  });

  it('сума більша за залишок обраного рахунку клієнта скидає рахунок; менша — ні', async () => {
    mockApi();
    await openReady({}, '500');
    choose('Рознести як', 'INVOICE');
    await pickVia('Пошук контрагента…');
    await pickVia('Оберіть рахунок…');
    expect(screen.getByText('INV-0042')).toBeInTheDocument();

    choose(/^Сума/, '550'); // залишок 1000 − 400 = 600
    expect(screen.getByText('INV-0042')).toBeInTheDocument();
    choose(/^Сума/, '600,01');
    expect(screen.queryByText('INV-0042')).not.toBeInTheDocument();
    expect(screen.getByText('ТОВ Клієнт')).toBeInTheDocument();
  });

  // Bug #863: правило діяло лише на зміні суми — рахунок, обраний ПІСЛЯ більшої суми, проходив
  // до підтвердження й відмови сервера.
  // Mutation-verify: прибрати перевірку `amount > incoming.invoiceRemaining` у incomingAllocation
  // → кейс падає (з'являється крок підтвердження).
  it('рахунок обрано ПІСЛЯ суми, більшої за його залишок, — помилка під рахунком, запит не йде', async () => {
    mockApi();
    await openReady({}, '600,01'); // залишок 1000 − 400 = 600
    choose('Рознести як', 'INVOICE');
    await pickVia('Пошук контрагента…');
    await pickVia('Оберіть рахунок…');
    fireEvent.click(screen.getByRole('button', { name: 'Внести й рознести' }));

    expect(
      await screen.findByText('Сума платежу більша за залишок до сплати за рахунком (600,00)'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    expect(createCalls()).toHaveLength(0);

    // Рівно залишок — проходить до підтвердження.
    choose(/^Сума/, '600');
    expect(screen.getByText('INV-0042')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Внести й рознести' }));
    expect(await screen.findByRole('note')).toHaveTextContent('600,00 ₴');
  });
});

describe('BankTransactionCreateModal — тіло запиту й підтвердження', () => {
  it('вхідний «Оплата послуг»: allocation з контрагентом, без підтвердження', async () => {
    mockApi();
    const { onClose } = await openReady();
    choose('Рознести як', 'SERVICE');
    await pickVia('Пошук контрагента…');
    fireEvent.click(screen.getByRole('button', { name: 'Внести й рознести' }));

    await waitFor(() => expect(createCalls()).toHaveLength(1));
    expect(lastBody()).toEqual({
      bankAccountId: ACC_MAIN,
      direction: 'IN',
      amount: 600,
      operationDate: '2026-10-14',
      allocation: { type: 'SERVICE', counterpartyId: CLIENT },
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(toastMock.success).toHaveBeenCalledWith('Платіж внесено й рознесено');
  });

  it('вихідна «Витрата»: allocation лише з полями виду, без підтвердження', async () => {
    mockApi();
    await openReady({ defaultDirection: 'OUT' });
    choose('Рознести як', 'EXPENSE');
    await screen.findByRole('option', { name: 'Оренда' });
    choose(/Стаття витрат/, CAT_RENT);
    fireEvent.click(screen.getByRole('button', { name: 'Внести й рознести' }));

    await waitFor(() => expect(createCalls()).toHaveLength(1));
    expect(lastBody()).toMatchObject({ direction: 'OUT', amount: 600 });
    expect(lastBody().allocation).toEqual({ type: 'EXPENSE', expenseCategoryId: CAT_RENT });
  });

  it('«Оплата рахунку» просить підтвердження з номером рахунку й сумою; «Назад» нічого не шле', async () => {
    mockApi();
    await openReady();
    choose('Рознести як', 'INVOICE');
    await pickVia('Пошук контрагента…');
    await pickVia('Оберіть рахунок…');
    fireEvent.click(screen.getByRole('button', { name: 'Внести й рознести' }));

    const note = await screen.findByRole('note');
    expect(note).toHaveTextContent('INV-0042');
    expect(note).toHaveTextContent('ТОВ Клієнт');
    expect(note).toHaveTextContent('600,00 ₴');
    expect(createCalls()).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Назад' }));
    expect(screen.getByText('INV-0042')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Внести й рознести' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Підтвердити' }));

    await waitFor(() => expect(createCalls()).toHaveLength(1));
    expect(lastBody().allocation).toEqual({
      type: 'INVOICE',
      counterpartyId: CLIENT,
      invoiceId: INVOICE,
    });
  });

  it('«Зняття готівки» просить підтвердження з назвою каси', async () => {
    mockApi();
    await openReady({ defaultDirection: 'OUT' });
    choose('Рознести як', 'CASH_WITHDRAWAL');
    await screen.findByRole('option', { name: 'Каса №1' });
    choose(/^Каса/, CASH_UAH);
    fireEvent.click(screen.getByRole('button', { name: 'Внести й рознести' }));

    expect(await screen.findByRole('note')).toHaveTextContent('Каса №1');
    fireEvent.click(screen.getByRole('button', { name: 'Підтвердити' }));
    await waitFor(() => expect(createCalls()).toHaveLength(1));
    expect(lastBody().allocation).toEqual({ type: 'CASH_WITHDRAWAL', cashRegisterId: CASH_UAH });
  });

  it.each([
    ['IN', 'SERVICE', 'Оберіть контрагента'],
    ['IN', 'INVOICE', 'Оберіть контрагента'],
    ['OUT', 'EXPENSE', 'Оберіть статтю витрат'],
    ['OUT', 'SUPPLIER_PAYMENT', 'Оберіть постачальника'],
  ] as const)(
    '%s %s без обов’язкового поля → «%s», запит не йде',
    async (direction, type, message) => {
      mockApi();
      await openReady({ defaultDirection: direction });
      choose('Рознести як', type);
      fireEvent.click(screen.getByRole('button', { name: 'Внести й рознести' }));
      expect(await screen.findByText(message)).toBeInTheDocument();
      expect(createCalls()).toHaveLength(0);
      expect(screen.queryByRole('note')).not.toBeInTheDocument();
    },
  );

  it('відмова сервера → текст у вікні, вікно відкрите; після підтвердження — назад до форми', async () => {
    mockApi({
      create: () => Promise.reject(new Error('Рахунок у статусі «Оплачено» — оплата неможлива')),
    });
    // Сума в межах залишку: рахунок оплатили паралельно, поки вікно було відкрите.
    const { onClose } = await openReady({}, '500');
    choose('Рознести як', 'INVOICE');
    await pickVia('Пошук контрагента…');
    await pickVia('Оберіть рахунок…');
    fireEvent.click(screen.getByRole('button', { name: 'Внести й рознести' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Підтвердити' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Рахунок у статусі «Оплачено» — оплата неможлива',
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    expect(allocSelect().value).toBe('INVOICE');
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it('подвійний клік — один запит', async () => {
    let release: (v: unknown) => void = () => {};
    mockApi({ create: () => new Promise(r => (release = r)) });
    await openReady({ defaultDirection: 'OUT' });
    choose('Рознести як', 'EXPENSE');
    await screen.findByRole('option', { name: 'Оренда' });
    choose(/Стаття витрат/, CAT_RENT);
    const button = screen.getByRole('button', { name: 'Внести й рознести' });
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(createCalls()).toHaveLength(1));
    // Дати другому кліку відпрацювати валідацію до кінця.
    await new Promise(r => setTimeout(r, 20));
    expect(createCalls()).toHaveLength(1);
    release({ id: 'new-1' });
  });
});

// Bug #862: вікно закривалось по Escape разом із уведеним — і з кроку підтвердження теж.
// Mutation-verify: у close прибрати `guard.markDirty()` (лишити resetDirty) → три кейси падають.
describe('BankTransactionCreateModal — закриття з уведеним', () => {
  const escape = () => fireEvent.keyDown(document, { key: 'Escape' });

  it('крок підтвердження: Escape питає «Є незбережені зміни»; «Скасувати» — лишає підтвердження', async () => {
    mockApi();
    const { onClose } = await openReady();
    choose('Рознести як', 'INVOICE');
    await pickVia('Пошук контрагента…');
    await pickVia('Оберіть рахунок…');
    fireEvent.click(screen.getByRole('button', { name: 'Внести й рознести' }));
    await screen.findByRole('note');

    escape();
    expect(await screen.findByText('Є незбережені зміни')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Скасувати' }));
    await waitFor(() => expect(screen.queryByText('Є незбережені зміни')).not.toBeInTheDocument());
    expect(screen.getByRole('note')).toHaveTextContent('INV-0042');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('уведена сума: Escape питає; «Покинути» закриває вікно', async () => {
    mockApi();
    const { onClose } = await openReady();
    escape();
    expect(await screen.findByText('Є незбережені зміни')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Покинути' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('нічого не введено (лише рахунок) — Escape закриває без запиту', async () => {
    mockApi();
    const { onClose } = await openReady({}, '');
    escape();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Є незбережені зміни')).not.toBeInTheDocument();
  });
});
