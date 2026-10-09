// Рознесення вихідного банківського платежу за видом (BR-BANK-025…034) і переказу для вхідного.
//   - для кожного виду: без обов'язкового поля запит НЕ йде; payload = ReconcileTransactionDto
//     і містить лише поля свого виду (суму, рахунок, дату бекенд бере з рядка — BR-BANK-026);
//   - оплата постачальнику: прив'язка наявної оплати — без підтвердження (нічого не проводиться,
//     BR-BANK-027); нова — з підтвердженням;
//   - види з проведенням / касовою операцією питають підтвердження з текстом наслідку;
//   - allowedTypes=['TRANSFER'] — єдиний вид для вхідного рядка;
//   - відмова сервера показується в модалці його текстом.
//
// Mutation-verify:
//   - `const posts = … && !data.supplierPaymentId` → `const posts = false`  → кейси «питає підтвердження» падають;
//   - `… && !data.supplierPaymentId` прибрати                         → «прив'язка без підтвердження» падає;
//   - buildPayload: `supplierPaymentId: v.supplierPaymentId` → `counterpartyId: …` → payload наявної оплати падає;
//   - прибрати `clearLinks()` із changeType                           → «зміна виду скидає посилання» падає;
//   - фільтр `a.id !== transaction?.bankAccountId` прибрати           → «без рахунку рядка» падає;
//   - фільтр `r.currencyId === transaction?.currencyId` прибрати      → кейси каси іншої валюти падають;
//   - `PAYROLL_STATUSES` += 'DRAFT'                                    → «лише Розраховано і Виплачено» падає;
//   - `allowedTypes?.length ? … filter` → завжди всі види             → кейс allowedTypes падає;
//   - прибрати автоперемикання (`setSupplierMode('new')` в ефекті)    → «порожні кандидати» падає.

import { screen, waitFor, fireEvent, within } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';

vi.mock('@/lib/format', () => ({
  fmtMoney: (v: number) => String(v),
  fmtDate: (v: string) => `d:${v}`,
  fmtBankCurrencySuffix: (c: string | null | undefined) => (!c || c === 'UAH' ? '₴' : c),
}));

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  apiMultipartFetch: vi.fn(),
}));

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast: toastMock }));

vi.mock('@/hooks/api/useInfrastructure', () => ({
  useBranches: () => ({ data: [{ id: 'br-1', name: 'Центральна' }] }),
}));

// Пікер — стуб: «pick» обирає перший елемент, який повернув fetchItems (тобто реальний URL
// довідника проходить через apiFetch-мок і його можна перевірити).
vi.mock('@/components/ui/search-picker-modal', () => ({
  SearchPickerModal: (p: {
    open: boolean;
    title: string;
    onSelect: (item: { id: string; primary: string }) => void;
    fetchItems: (q: string) => Promise<{ id: string; primary: string }[]>;
  }) =>
    p.open ? (
      <div data-testid="picker" data-title={p.title}>
        <button type="button" onClick={() => void p.fetchItems('').then(i => p.onSelect(i[0]!))}>
          pick
        </button>
      </div>
    ) : null,
}));

import { MatchOutgoingBankTransactionModal } from '../MatchOutgoingBankTransactionModal';
import { renderWithQueryClient } from '../../../__tests__/query-utils';
import type { BankTransaction } from '@/hooks/api/useBankStatements';

const uuid = (n: number) =>
  `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const SP_1 = uuid(1);
const SP_2 = uuid(2);
const SUPPLIER = uuid(3);
const CLIENT = uuid(4);
const PO = uuid(5);
const CAT_RENT = uuid(6);
const PERIOD_COMPUTED = uuid(7);
const ACC_OTHER = uuid(8);
const CASH_UAH = uuid(9);
const EMPLOYEE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PERIOD_PAID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PERIOD_DRAFT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ACC_OWN = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const CASH_USD = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

const TX: BankTransaction = {
  id: 'tx-1',
  orgId: 'org-1',
  bankAccountId: ACC_OWN,
  direction: 'OUT',
  amount: 1200,
  currencyId: 'cur-uah',
  operationDate: '2026-10-01',
  payerName: 'ТОВ Запчастини',
  purpose: 'Оплата за рах. 15',
  externalId: 'ext-1',
  source: 'FILE_IMPORT',
  status: 'UNMATCHED',
  createdAt: '2026-10-01T00:00:00.000Z',
  bankAccountCurrencyCode: 'UAH',
};

const CANDIDATES = [
  {
    id: SP_1,
    number: 'SP-0001',
    documentDate: '2026-09-30',
    amount: 1200,
    supplierId: SUPPLIER,
    supplierName: 'ТОВ Запчастини',
    purchaseOrderId: PO,
    purchaseOrderNumber: 'PO-0042',
  },
  {
    id: SP_2,
    number: 'SP-0002',
    documentDate: '2026-10-01',
    amount: 1200,
    supplierId: SUPPLIER,
    supplierName: 'ФОП Інший',
  },
];

interface Refs {
  candidates?: unknown[] | Error;
  registers?: unknown[];
  reconcile?: () => Promise<unknown>;
}

type Init = { method?: string; body?: string };

function mockApi(refs: Refs = {}) {
  apiFetchMock.mockImplementation((path: string, init?: Init) => {
    if (path.endsWith('/supplier-payment-candidates')) {
      const c = refs.candidates ?? CANDIDATES;
      return c instanceof Error ? Promise.reject(c) : Promise.resolve(c);
    }
    if (path.endsWith('/reconcile') && init?.method === 'POST')
      return refs.reconcile ? refs.reconcile() : Promise.resolve({ ...TX, status: 'MATCHED' });
    if (path.startsWith('/counterparties?')) {
      const isClient = path.includes('types=CLIENT');
      return Promise.resolve({
        items: [
          isClient
            ? { id: CLIENT, firstName: 'Іван', lastName: 'Іваненко', companyName: null }
            : { id: SUPPLIER, companyName: 'ТОВ Запчастини' },
        ],
      });
    }
    if (path.startsWith('/purchase-orders?'))
      return Promise.resolve({ items: [{ id: PO, number: 'PO-0042' }] });
    if (path.startsWith('/employees?'))
      return Promise.resolve({
        items: [{ id: EMPLOYEE, firstName: 'Петро', lastName: 'Петренко' }],
      });
    if (path.startsWith('/expense-categories'))
      return Promise.resolve({
        items: [
          {
            id: CAT_RENT,
            name: 'Оренда',
            type: 'EXPENSE',
            isActive: true,
            children: [
              { id: uuid(0), name: 'Неактивна', type: 'EXPENSE', isActive: false, children: [] },
            ],
          },
          { id: 'inc', name: 'Оприбуткування', type: 'INCOME', isActive: true, children: [] },
        ],
        total: 2,
      });
    if (path.startsWith('/payroll/periods'))
      return Promise.resolve({
        items: [
          {
            id: PERIOD_COMPUTED,
            periodStart: '2026-09-01',
            periodEnd: '2026-09-30',
            status: 'COMPUTED',
            branchId: 'br-1',
          },
          {
            id: PERIOD_PAID,
            periodStart: '2026-08-01',
            periodEnd: '2026-08-31',
            status: 'PAID',
            branchId: null,
          },
          {
            id: PERIOD_DRAFT,
            periodStart: '2026-10-01',
            periodEnd: '2026-10-31',
            status: 'DRAFT',
            branchId: null,
          },
          {
            id: 'cancelled',
            periodStart: '2026-07-01',
            periodEnd: '2026-07-31',
            status: 'CANCELLED',
            branchId: null,
          },
        ],
        total: 4,
        page: 1,
        limit: 200,
      });
    if (path === '/bank-accounts')
      return Promise.resolve({
        items: [
          { id: ACC_OWN, name: 'Основний', currencyCode: 'UAH' },
          { id: ACC_OTHER, name: 'Резервний', currencyCode: 'UAH' },
        ],
      });
    if (path === '/cash-registers')
      return Promise.resolve({
        items: refs.registers ?? [
          { id: CASH_UAH, name: 'Каса №1', currencyId: 'cur-uah', currencyCode: 'UAH' },
          { id: CASH_USD, name: 'Валютна каса', currencyId: 'cur-usd', currencyCode: 'USD' },
        ],
      });
    return Promise.reject(new Error(`неочікуваний запит ${path}`));
  });
}

const reconcileCalls = () =>
  apiFetchMock.mock.calls.filter(c => String(c[0]).endsWith('/reconcile')) as [string, Init][];
const lastBody = () => JSON.parse(reconcileCalls().at(-1)![1].body!) as Record<string, unknown>;
const paths = () => apiFetchMock.mock.calls.map(c => String(c[0]));

const open = (props: Partial<Parameters<typeof MatchOutgoingBankTransactionModal>[0]> = {}) => {
  const onClose = vi.fn();
  renderWithQueryClient(
    <MatchOutgoingBankTransactionModal open onClose={onClose} transaction={TX} {...props} />,
  );
  return { onClose };
};
const typeSelect = () => screen.getByLabelText(/Вид рознесення/) as HTMLSelectElement;
const chooseType = (value: string) => fireEvent.change(typeSelect(), { target: { value } });
const submit = () => fireEvent.click(screen.getByRole('button', { name: 'Рознести' }));
const confirm = () => fireEvent.click(screen.getByRole('button', { name: 'Підтвердити' }));
/** Відкрити пікер кнопкою поля з підписом і обрати перший елемент довідника. */
const pickVia = async (placeholder: string, title: string) => {
  const field = (await screen.findByText(placeholder)).parentElement!;
  fireEvent.click(within(field).getByRole('button', { name: 'Обрати' }));
  const picker = await screen.findByTestId('picker');
  expect(picker).toHaveAttribute('data-title', title);
  fireEvent.click(within(picker).getByText('pick'));
  await waitFor(() => expect(screen.queryByTestId('picker')).not.toBeInTheDocument());
};
/** Дати валідації шанс відпрацювати й переконатись, що запит так і не пішов. */
const expectNotSent = async (message: string | RegExp) => {
  expect(await screen.findByText(message)).toBeInTheDocument();
  expect(reconcileCalls()).toHaveLength(0);
  expect(screen.queryByRole('button', { name: 'Підтвердити' })).not.toBeInTheDocument();
};

beforeEach(() => {
  apiFetchMock.mockReset();
  toastMock.success.mockReset();
  toastMock.error.mockReset();
});

describe('MatchOutgoingBankTransactionModal — довідка рядка і види', () => {
  it('угорі — дата, сума з валютою, контрагент із виписки, призначення', async () => {
    mockApi();
    open({ transaction: { ...TX, amount: 150, bankAccountCurrencyCode: 'USD' } });
    expect(screen.getByText('d:2026-10-01')).toBeInTheDocument();
    expect(screen.getByText('150 USD')).toBeInTheDocument();
    expect(screen.getByText('ТОВ Запчастини')).toBeInTheDocument();
    expect(screen.getByText('Оплата за рах. 15')).toBeInTheDocument();
  });

  it('без allowedTypes — усі шість видів, заголовок «Рознести вихідний платіж»', () => {
    mockApi();
    open();
    expect(screen.getByRole('dialog', { name: 'Рознести вихідний платіж' })).toBeInTheDocument();
    expect(
      within(typeSelect())
        .getAllByRole('option')
        .map(o => o.textContent),
    ).toEqual([
      'Оплата постачальнику',
      'Повернення клієнту',
      'Витрата',
      'Зарплата',
      'Переказ між рахунками',
      'Зняття готівки',
    ]);
  });

  it("allowedTypes=['TRANSFER'] (вхідний рядок): лише цей вид, він уже обраний", async () => {
    mockApi();
    open({ transaction: { ...TX, direction: 'IN' }, allowedTypes: ['TRANSFER'] });
    expect(screen.getByRole('dialog', { name: 'Переказ між рахунками' })).toBeInTheDocument();
    expect(
      within(typeSelect())
        .getAllByRole('option')
        .map(o => (o as HTMLOptionElement).value),
    ).toEqual(['TRANSFER']);
    expect(typeSelect().value).toBe('TRANSFER');
    // Форма одразу показує поле переказу, а не оплату постачальнику.
    expect(await screen.findByRole('option', { name: 'Резервний (UAH)' })).toBeInTheDocument();
    expect(paths().some(p => p.endsWith('/supplier-payment-candidates'))).toBe(false);

    fireEvent.change(screen.getByLabelText(/Інший власний рахунок/), {
      target: { value: ACC_OTHER },
    });
    submit();
    await waitFor(() => expect(reconcileCalls()).toHaveLength(1));
    expect(lastBody()).toEqual({ type: 'TRANSFER', transferBankAccountId: ACC_OTHER });
  });
});

describe('MatchOutgoingBankTransactionModal — SUPPLIER_PAYMENT', () => {
  it('кандидати: номер, дата, постачальник, замовлення; запит іде на …/:id/supplier-payment-candidates', async () => {
    mockApi();
    open();
    const first = (await screen.findByText('SP-0001')).closest('label')!;
    expect(within(first).getByText('d:2026-09-30')).toBeInTheDocument();
    expect(within(first).getByText('ТОВ Запчастини')).toBeInTheDocument();
    expect(within(first).getByText('замовлення PO-0042')).toBeInTheDocument();
    expect(screen.getByText('ФОП Інший')).toBeInTheDocument();
    expect(paths()).toContain('/bank-statements/transactions/tx-1/supplier-payment-candidates');
    // За наявності кандидатів режим — «прив'язати до наявної».
    expect(screen.getByRole('button', { name: "Прив'язати до наявної оплати" })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('наявна оплата не обрана → запит не йде', async () => {
    mockApi();
    open();
    await screen.findByText('SP-0001');
    submit();
    await expectNotSent('Оберіть оплату або створіть нову');
  });

  it('вибір наявної оплати → supplierPaymentId, БЕЗ підтвердження і без контрагента в payload', async () => {
    mockApi();
    const { onClose } = open();
    fireEvent.click(await screen.findByRole('radio', { name: /SP-0002/ }));
    submit();
    await waitFor(() => expect(reconcileCalls()).toHaveLength(1));
    expect(reconcileCalls()[0]![0]).toBe('/bank-statements/transactions/tx-1/reconcile');
    expect(lastBody()).toEqual({ type: 'SUPPLIER_PAYMENT', supplierPaymentId: SP_2 });
    expect(screen.queryByRole('button', { name: 'Підтвердити' })).not.toBeInTheDocument();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(toastMock.success).toHaveBeenCalledWith('Платіж рознесено');
  });

  it('порожні кандидати → підказка й автоперемикання на «Створити нову»', async () => {
    mockApi({ candidates: [] });
    open();
    expect(
      await screen.findByText('Проведених оплат на цю суму з цього рахунку немає'),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Створити нову' })).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    );
    expect(screen.getByText('Пошук постачальника…')).toBeInTheDocument();
  });

  it('нова оплата без постачальника → запит не йде', async () => {
    mockApi({ candidates: [] });
    open();
    await screen.findByText('Пошук постачальника…');
    submit();
    await expectNotSent('Оберіть постачальника або наявну оплату');
  });

  it('нова оплата: постачальник із довідника постачальників → підтвердження з наслідком → payload', async () => {
    mockApi();
    open();
    await screen.findByText('SP-0001');
    fireEvent.click(screen.getByRole('button', { name: 'Створити нову' }));
    await pickVia('Пошук постачальника…', 'Оберіть постачальника');
    expect(
      paths().some(
        p => p.startsWith('/counterparties?') && p.includes('types=SUPPLIER&types=BOTH'),
      ),
    ).toBe(true);

    submit();
    // Спершу — підтвердження: проведення ще не було.
    expect(await screen.findByRole('note')).toHaveTextContent(
      'Буде створено й проведено оплату постачальнику «ТОВ Запчастини» на 1200 ₴ — борг зменшиться.',
    );
    expect(reconcileCalls()).toHaveLength(0);

    confirm();
    await waitFor(() => expect(reconcileCalls()).toHaveLength(1));
    expect(lastBody()).toEqual({ type: 'SUPPLIER_PAYMENT', counterpartyId: SUPPLIER });
  });

  it('нова оплата із замовленням цього постачальника → purchaseOrderId у payload', async () => {
    mockApi({ candidates: [] });
    open();
    await pickVia('Пошук постачальника…', 'Оберіть постачальника');
    await pickVia("Прив'язати замовлення…", 'Оберіть замовлення постачальнику');
    expect(
      paths().some(p => p.startsWith('/purchase-orders?') && p.includes(`supplierId=${SUPPLIER}`)),
    ).toBe(true);
    submit();
    await screen.findByRole('note');
    confirm();
    await waitFor(() => expect(reconcileCalls()).toHaveLength(1));
    expect(lastBody()).toEqual({
      type: 'SUPPLIER_PAYMENT',
      counterpartyId: SUPPLIER,
      purchaseOrderId: PO,
    });
  });

  it('«Назад» із підтвердження повертає форму без запиту', async () => {
    mockApi({ candidates: [] });
    open();
    await pickVia('Пошук постачальника…', 'Оберіть постачальника');
    submit();
    await screen.findByRole('note');
    fireEvent.click(screen.getByRole('button', { name: 'Назад' }));
    expect(screen.getByRole('button', { name: 'Рознести' })).toBeInTheDocument();
    expect(screen.getByText('ТОВ Запчастини', { selector: 'dd' })).toBeInTheDocument();
    expect(reconcileCalls()).toHaveLength(0);
  });

  it('збій списку кандидатів показано, а не замасковано під «немає оплат»', async () => {
    mockApi({ candidates: new Error('Сервер недоступний') });
    open();
    expect(await screen.findByRole('alert')).toHaveTextContent('Сервер недоступний');
    expect(
      screen.queryByText('Проведених оплат на цю суму з цього рахунку немає'),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: "Прив'язати до наявної оплати" })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});

describe('MatchOutgoingBankTransactionModal — CLIENT_REFUND', () => {
  it('без клієнта → запит не йде', async () => {
    mockApi();
    open();
    chooseType('CLIENT_REFUND');
    submit();
    await expectNotSent('Оберіть клієнта');
  });

  it('клієнт із довідника клієнтів → підтвердження → payload', async () => {
    mockApi();
    open();
    chooseType('CLIENT_REFUND');
    await pickVia('Пошук клієнта…', 'Оберіть клієнта');
    expect(
      paths().some(p => p.startsWith('/counterparties?') && p.includes('types=CLIENT&types=BOTH')),
    ).toBe(true);
    submit();
    expect(await screen.findByRole('note')).toHaveTextContent(
      /Буде проведено повернення клієнту «Іваненко Іван» на 1200 ₴/,
    );
    expect(reconcileCalls()).toHaveLength(0);
    confirm();
    await waitFor(() => expect(reconcileCalls()).toHaveLength(1));
    expect(lastBody()).toEqual({ type: 'CLIENT_REFUND', counterpartyId: CLIENT });
  });
});

describe('MatchOutgoingBankTransactionModal — EXPENSE', () => {
  it('у списку лише активні статті типу «витрата»', async () => {
    mockApi();
    open();
    chooseType('EXPENSE');
    await screen.findByRole('option', { name: 'Оренда' });
    const options = within(screen.getByLabelText(/Стаття витрат/)).getAllByRole('option');
    expect(options.map(o => o.textContent?.trim())).toEqual(['— Оберіть —', 'Оренда']);
  });

  it('без статті → запит не йде', async () => {
    mockApi();
    open();
    chooseType('EXPENSE');
    await screen.findByRole('option', { name: 'Оренда' });
    submit();
    await expectNotSent('Оберіть статтю витрат');
  });

  it('стаття без контрагента → payload без підтвердження (проведень немає)', async () => {
    mockApi();
    open();
    chooseType('EXPENSE');
    await screen.findByRole('option', { name: 'Оренда' });
    fireEvent.change(screen.getByLabelText(/Стаття витрат/), { target: { value: CAT_RENT } });
    submit();
    await waitFor(() => expect(reconcileCalls()).toHaveLength(1));
    expect(lastBody()).toEqual({ type: 'EXPENSE', expenseCategoryId: CAT_RENT });
  });

  it("необов'язковий контрагент — будь-якого типу — потрапляє в payload", async () => {
    mockApi();
    open();
    chooseType('EXPENSE');
    await screen.findByRole('option', { name: 'Оренда' });
    fireEvent.change(screen.getByLabelText(/Стаття витрат/), { target: { value: CAT_RENT } });
    await pickVia('Пошук контрагента…', 'Оберіть контрагента');
    const cpCall = paths().find(p => p.startsWith('/counterparties?'))!;
    expect(cpCall).not.toContain('types=');
    submit();
    await waitFor(() => expect(reconcileCalls()).toHaveLength(1));
    expect(lastBody()).toEqual({
      type: 'EXPENSE',
      expenseCategoryId: CAT_RENT,
      counterpartyId: SUPPLIER,
    });
  });
});

describe('MatchOutgoingBankTransactionModal — PAYROLL', () => {
  it('лише періоди «Розраховано» і «Виплачено»; підпис — дати й філія', async () => {
    mockApi();
    open();
    chooseType('PAYROLL');
    await screen.findByRole('option', { name: /d:2026-09-01/ });
    const options = within(screen.getByLabelText(/Зарплатний період/)).getAllByRole('option');
    expect(options.map(o => o.textContent)).toEqual([
      '— Оберіть —',
      'd:2026-09-01 – d:2026-09-30 · Центральна · Розраховано',
      'd:2026-08-01 – d:2026-08-31 · усі філії · Виплачено',
    ]);
  });

  it('без періоду → запит не йде', async () => {
    mockApi();
    open();
    chooseType('PAYROLL');
    await screen.findByRole('option', { name: /d:2026-09-01/ });
    submit();
    await expectNotSent('Оберіть зарплатний період');
  });

  it("період → payload без підтвердження; працівник необов'язковий", async () => {
    mockApi();
    open();
    chooseType('PAYROLL');
    await screen.findByRole('option', { name: /d:2026-09-01/ });
    fireEvent.change(screen.getByLabelText(/Зарплатний період/), {
      target: { value: PERIOD_COMPUTED },
    });
    submit();
    await waitFor(() => expect(reconcileCalls()).toHaveLength(1));
    expect(lastBody()).toEqual({ type: 'PAYROLL', payrollPeriodId: PERIOD_COMPUTED });
  });

  it('період + працівник → employeeId у payload', async () => {
    mockApi();
    open();
    chooseType('PAYROLL');
    await screen.findByRole('option', { name: /d:2026-08-01/ });
    fireEvent.change(screen.getByLabelText(/Зарплатний період/), {
      target: { value: PERIOD_PAID },
    });
    await pickVia('Пошук працівника…', 'Оберіть працівника');
    expect(screen.getByText('Петренко Петро')).toBeInTheDocument();
    submit();
    await waitFor(() => expect(reconcileCalls()).toHaveLength(1));
    expect(lastBody()).toEqual({
      type: 'PAYROLL',
      payrollPeriodId: PERIOD_PAID,
      employeeId: EMPLOYEE,
    });
  });
});

describe('MatchOutgoingBankTransactionModal — TRANSFER', () => {
  it('у списку — інші власні рахунки, без рахунку самого рядка', async () => {
    mockApi();
    open();
    chooseType('TRANSFER');
    await screen.findByRole('option', { name: 'Резервний (UAH)' });
    const options = within(screen.getByLabelText(/Інший власний рахунок/)).getAllByRole('option');
    expect(options.map(o => (o as HTMLOptionElement).value)).toEqual(['', ACC_OTHER]);
  });

  it('без рахунку → запит не йде', async () => {
    mockApi();
    open();
    chooseType('TRANSFER');
    await screen.findByRole('option', { name: 'Резервний (UAH)' });
    submit();
    await expectNotSent('Оберіть рахунок, на який зроблено переказ');
  });

  it('рахунок → payload без підтвердження', async () => {
    mockApi();
    open();
    chooseType('TRANSFER');
    await screen.findByRole('option', { name: 'Резервний (UAH)' });
    fireEvent.change(screen.getByLabelText(/Інший власний рахунок/), {
      target: { value: ACC_OTHER },
    });
    submit();
    await waitFor(() => expect(reconcileCalls()).toHaveLength(1));
    expect(lastBody()).toEqual({ type: 'TRANSFER', transferBankAccountId: ACC_OTHER });
  });
});

describe('MatchOutgoingBankTransactionModal — CASH_WITHDRAWAL', () => {
  it('лише каси тієї самої валюти, що рядок', async () => {
    mockApi();
    open();
    chooseType('CASH_WITHDRAWAL');
    await screen.findByRole('option', { name: 'Каса №1' });
    const options = within(screen.getByLabelText(/^Каса/)).getAllByRole('option');
    expect(options.map(o => (o as HTMLOptionElement).value)).toEqual(['', CASH_UAH]);
  });

  it('кас у валюті рядка немає → пояснення; запит не йде', async () => {
    mockApi({ registers: [{ id: CASH_USD, name: 'Валютна каса', currencyId: 'cur-usd' }] });
    open();
    chooseType('CASH_WITHDRAWAL');
    expect(await screen.findByRole('note')).toHaveTextContent(
      /Немає каси у валюті платежу \(UAH\)/,
    );
    submit();
    await expectNotSent('Оберіть касу');
  });

  it('без каси → запит не йде', async () => {
    mockApi();
    open();
    chooseType('CASH_WITHDRAWAL');
    await screen.findByRole('option', { name: 'Каса №1' });
    submit();
    await expectNotSent('Оберіть касу');
  });

  it('каса → підтвердження з наслідком → payload', async () => {
    mockApi();
    open();
    chooseType('CASH_WITHDRAWAL');
    await screen.findByRole('option', { name: 'Каса №1' });
    fireEvent.change(screen.getByLabelText(/^Каса/), { target: { value: CASH_UAH } });
    submit();
    expect(await screen.findByRole('note')).toHaveTextContent(
      /У касу «Каса №1» буде внесено 1200 ₴/,
    );
    expect(reconcileCalls()).toHaveLength(0);
    confirm();
    await waitFor(() => expect(reconcileCalls()).toHaveLength(1));
    expect(lastBody()).toEqual({ type: 'CASH_WITHDRAWAL', cashRegisterId: CASH_UAH });
  });
});

describe('MatchOutgoingBankTransactionModal — зміна виду і відмова сервера', () => {
  it('зміна виду скидає посилання попереднього: клієнт не їде в payload витрати', async () => {
    mockApi();
    open();
    chooseType('CLIENT_REFUND');
    await pickVia('Пошук клієнта…', 'Оберіть клієнта');
    chooseType('EXPENSE');
    await screen.findByRole('option', { name: 'Оренда' });
    fireEvent.change(screen.getByLabelText(/Стаття витрат/), { target: { value: CAT_RENT } });
    submit();
    await waitFor(() => expect(reconcileCalls()).toHaveLength(1));
    expect(lastBody()).toEqual({ type: 'EXPENSE', expenseCategoryId: CAT_RENT });
  });

  it('відмова сервера (напр. 409) показана в модалці його текстом; модалка відкрита', async () => {
    mockApi({ reconcile: () => Promise.reject(new Error('Платіж уже рознесено')) });
    const { onClose } = open();
    fireEvent.click(await screen.findByRole('radio', { name: /SP-0001/ }));
    submit();
    expect(await screen.findByRole('alert')).toHaveTextContent('Платіж уже рознесено');
    expect(onClose).not.toHaveBeenCalled();
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it('відмова після підтвердження повертає до форми з текстом помилки', async () => {
    mockApi({ reconcile: () => Promise.reject(new Error('Фіскальна каса без відкритої зміни')) });
    open();
    chooseType('CASH_WITHDRAWAL');
    await screen.findByRole('option', { name: 'Каса №1' });
    fireEvent.change(screen.getByLabelText(/^Каса/), { target: { value: CASH_UAH } });
    submit();
    await screen.findByRole('note');
    confirm();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Фіскальна каса без відкритої зміни',
    );
    // Знову форма: можна обрати іншу касу й повторити.
    expect(screen.getByRole('button', { name: 'Рознести' })).toBeInTheDocument();
    expect((screen.getByLabelText(/^Каса/) as HTMLSelectElement).value).toBe(CASH_UAH);
  });
});
