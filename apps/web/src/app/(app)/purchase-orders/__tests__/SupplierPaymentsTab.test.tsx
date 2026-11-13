// BR-SUPPAY-014 (рішення власника 2026-10-30, TECH-DEBT (б) №36): старі чернетки оплат
// постачальнику, яких після видалення сторінки оплат ніде не було видно, — у «Купівлі», вкладка
// «Оплати постачальникам», фільтр «Чернетки» за замовчуванням. «Провести» — з ключем
// ідемпотентності (маршрут без ключа відповідає 400), «Скасувати» — без руху грошей.

import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import { makeTestQueryClient } from '@/__tests__/query-utils';

type Init = { method?: string; headers?: Record<string, string> } | undefined;
const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  apiPost: (path: string, body?: unknown, headers?: Record<string, string>) =>
    apiFetchMock(path, {
      method: 'POST',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(headers ? { headers } : {}),
    }),
}));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ employee: { id: 'e1', role: 'ACCOUNTANT' } }) }));
vi.mock('@/hooks/useUiFeatures', () => ({ useUiFeatures: () => ({ toastEnabled: false }) }));

import { SupplierPaymentsTab } from '../SupplierPaymentsTab';

const DRAFT = {
  id: 'sp-1',
  number: 'ОПП-2026-000042',
  status: 'DRAFT',
  supplierName: 'АвтоДеталь ТОВ',
  sourceName: 'Грн каса',
  purchaseOrderId: 'po-1',
  purchaseOrderNumber: 'ЗАМ-2026-000007',
  amount: 300,
  currencyCode: 'USD',
  documentDate: '2026-10-20',
};

function mockList(items: unknown[] = [DRAFT]) {
  apiFetchMock.mockImplementation((path: string, init: Init) => {
    if (path.startsWith('/supplier-payments?'))
      return Promise.resolve({ items, total: items.length, page: 1, limit: 20 });
    if (init?.method === 'POST') return Promise.resolve({ id: 'sp-1' });
    return Promise.resolve({});
  });
}

const listUrls = () =>
  (apiFetchMock.mock.calls as Array<[string, Init]>)
    .map(c => c[0])
    .filter(p => p.startsWith('/supplier-payments?'));
const posts = (suffix: string) =>
  (apiFetchMock.mock.calls as Array<[string, Init]>).filter(
    c => c[0].endsWith(suffix) && c[1]?.method === 'POST',
  );

function renderTab(onOpenOrder = vi.fn()) {
  render(
    <QueryClientProvider client={makeTestQueryClient()}>
      <SupplierPaymentsTab onOpenOrder={onOpenOrder} />
    </QueryClientProvider>,
  );
  return { onOpenOrder };
}

describe('SupplierPaymentsTab — чернетки оплат постачальнику (BR-SUPPAY-014)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  // guards: BR-SUPPAY-014
  it('за замовчуванням — «Чернетки»: запит status=DRAFT, рядок із сумою у валюті оплати', async () => {
    mockList();
    renderTab();

    expect(await screen.findByText('ОПП-2026-000042')).toBeInTheDocument();
    expect(listUrls()[0]).toContain('status=DRAFT');
    const group = screen.getByRole('group', { name: 'Статус' });
    expect(within(group).getByRole('button', { name: 'Чернетки' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const row = screen.getByText('ОПП-2026-000042').closest('tr') as HTMLElement;
    expect(within(row).getByText(/300,00\sUSD/)).toBeInTheDocument();
  });

  // guards: BR-SUPPAY-014
  it('«Всі» — запит без статусу', async () => {
    mockList();
    renderTab();
    await screen.findByText('ОПП-2026-000042');
    fireEvent.click(within(screen.getByRole('group', { name: 'Статус' })).getByText('Всі'));
    await waitFor(() => expect(listUrls().some(u => !u.includes('status='))).toBe(true));
  });

  // guards: BR-SUPPAY-014
  it('«Провести» → підтвердження → POST confirm з Idempotency-Key', async () => {
    mockList();
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Провести оплату ОПП-2026-000042' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Грн каса');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Провести' }));

    await waitFor(() => expect(posts('/supplier-payments/sp-1/confirm')).toHaveLength(1));
    const key = posts('/supplier-payments/sp-1/confirm')[0][1]?.headers?.['Idempotency-Key'];
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
    expect(posts('/cancel')).toHaveLength(0);
  });

  // guards: BR-SUPPAY-014
  it('проведена чернетка з каси оновлює дані каси (залишок і рядки), не лише перелік оплат', async () => {
    mockList();
    const qc = makeTestQueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    render(
      <QueryClientProvider client={qc}>
        <SupplierPaymentsTab />
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Провести оплату ОПП-2026-000042' }));
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Провести' }),
    );

    await waitFor(() =>
      expect(spy.mock.calls.some(([f]) => (f?.queryKey as unknown[])?.[0] === 'cash')).toBe(true),
    );
  });

  // guards: BR-SUPPAY-014
  it('відмова проведення (замовлення скасовано) — текст над таблицею', async () => {
    mockList();
    apiFetchMock.mockImplementation((path: string, init: Init) => {
      if (path.startsWith('/supplier-payments?'))
        return Promise.resolve({ items: [DRAFT], total: 1, page: 1, limit: 20 });
      if (init?.method === 'POST')
        return Promise.reject(new Error('Оплатити можна лише замовлення «Замовлено»…'));
      return Promise.resolve({});
    });
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Провести оплату ОПП-2026-000042' }));
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Провести' }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('Оплатити можна лише замовлення');
  });

  // guards: BR-SUPPAY-014
  it('«Скасувати» → підтвердження → POST cancel; проведення немає', async () => {
    mockList();
    renderTab();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Скасувати чернетку ОПП-2026-000042' }),
    );
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Скасувати чернетку' }),
    );

    await waitFor(() => expect(posts('/supplier-payments/sp-1/cancel')).toHaveLength(1));
    expect(posts('/confirm')).toHaveLength(0);
  });

  // guards: BR-SUPPAY-014
  it('проведена оплата — без дій; номер замовлення відкриває його картку', async () => {
    mockList([{ ...DRAFT, status: 'CONFIRMED' }]);
    const { onOpenOrder } = renderTab();
    await screen.findByText('ОПП-2026-000042');
    expect(screen.queryByRole('button', { name: /Провести оплату/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Відкрити замовлення ЗАМ-2026-000007' }));
    expect(onOpenOrder).toHaveBeenCalledWith('po-1');
  });

  it('порожньо в «Чернетках» — пояснення, що чернеток немає', async () => {
    mockList([]);
    renderTab();
    expect(await screen.findByText(/Чернеток немає/)).toBeInTheDocument();
  });
});

// BR-SUPPAY-017 (рішення власника 2026-11-06, TECH-DEBT (б) №90): проведену БАНКІВСЬКУ оплату
// постачальнику сторнують окремою дією з причиною — `POST /supplier-payments/:id/reverse`.
// Mutation-verify: умова `sourceType === 'BANK_ACCOUNT'` прибрана → «лише банківська» падає; ключ
// створюється на кожен запит, а не на відкриття → «той самий ключ» падає.
describe('SupplierPaymentsTab — «Сторнувати» банківську оплату (BR-SUPPAY-017)', () => {
  const BANK = {
    ...DRAFT,
    id: 'sp-2',
    number: 'ОПП-2026-000043',
    status: 'CONFIRMED',
    sourceType: 'BANK_ACCOUNT',
    sourceName: 'ПриватБанк USD',
    method: 'bank_transfer',
  };
  const REVERSE = '/supplier-payments/sp-2/reverse';

  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  const openReversal = async () => {
    fireEvent.click(
      await screen.findByRole('button', { name: 'Сторнувати оплату ОПП-2026-000043' }),
    );
    return screen.findByRole('dialog', { name: 'Сторно оплати постачальнику' });
  };
  const reverseWith = async (dialog: HTMLElement, reason: string) => {
    fireEvent.change(within(dialog).getByLabelText(/^Причина сторно/), {
      target: { value: reason },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Сторнувати' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Так, сторнувати' }));
  };
  const reverseCalls = () =>
    (apiFetchMock.mock.calls as Array<[string, Init & { body?: string }]>).filter(
      c => c[0] === REVERSE,
    );

  // guards: BR-SUPPAY-017
  it('лише проведена банківська: каса, чернетка, сторнована — без «Сторнувати»', async () => {
    mockList([
      BANK,
      { ...BANK, id: 'sp-3', number: 'ОПП-КАСА', sourceType: 'CASH_REGISTER' },
      { ...BANK, id: 'sp-4', number: 'ОПП-СТОРНО', status: 'REVERSED' },
      { ...BANK, id: 'sp-5', number: 'ОПП-ЧЕРНЕТКА', status: 'DRAFT' },
    ]);
    renderTab();

    expect(
      await screen.findByRole('button', { name: 'Сторнувати оплату ОПП-2026-000043' }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Сторнувати оплату/ })).toHaveLength(1);
  });

  // guards: BR-SUPPAY-017
  it('вікно причини: що сторнується й що станеться — постачальник, борг, «сплачено» замовлення', async () => {
    mockList([BANK]);
    renderTab();
    const dialog = await openReversal();

    const summary = within(dialog).getByRole('region', { name: 'Що сторнується' });
    expect(within(summary).getByText(/300,00\sUSD/)).toBeInTheDocument();
    expect(within(summary).getByText('Постачальник')).toBeInTheDocument();
    expect(within(summary).getByText('АвтоДеталь ТОВ')).toBeInTheDocument();
    const note = within(dialog).getByRole('note');
    expect(note).toHaveTextContent('борг постачальнику зросте на цю суму');
    expect(note).toHaveTextContent('«сплачено» замовлення зменшиться');
    expect(note).toHaveTextContent('скасування рознесення рядка');
  });

  // guards: BR-SUPPAY-017
  it('причина → підтвердження → POST reverse з { reason } і Idempotency-Key; вікно закривається', async () => {
    mockList([BANK]);
    renderTab();
    const dialog = await openReversal();
    await reverseWith(dialog, '  оплачено не тому постачальнику  ');

    await waitFor(() => expect(reverseCalls()).toHaveLength(1));
    const [, init] = reverseCalls()[0];
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body ?? '{}')).toEqual({ reason: 'оплачено не тому постачальнику' });
    expect(init.headers?.['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Сторно оплати постачальнику' })).toBeNull(),
    );
  });

  // guards: BR-SUPPAY-017
  it('порожня причина — запиту немає', async () => {
    mockList([BANK]);
    renderTab();
    const dialog = await openReversal();
    fireEvent.change(within(dialog).getByLabelText(/^Причина сторно/), {
      target: { value: '   ' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Сторнувати' }));

    expect(await within(dialog).findByRole('alert')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Так, сторнувати' })).toBeNull();
    expect(reverseCalls()).toHaveLength(0);
  });

  // Рядок виписки рознесено на оплату: кнопка є, сервер відмовляє з поясненням — текст у вікні;
  // повтор тієї самої спроби — той самий ключ, нове відкриття — новий.
  // guards: BR-SUPPAY-017
  it('відмова сервера — текст у вікні; повтор — той самий ключ, нове відкриття — новий', async () => {
    const refusal =
      'Оплата рознесена з рядка банківської виписки — спершу зніміть рознесення рядка';
    apiFetchMock.mockImplementation((path: string) => {
      if (path.startsWith('/supplier-payments?'))
        return Promise.resolve({ items: [BANK], total: 1, page: 1, limit: 20 });
      if (path === REVERSE) return Promise.reject(new Error(refusal));
      return Promise.resolve({});
    });
    renderTab();
    const dialog = await openReversal();
    await reverseWith(dialog, 'помилкова оплата');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(refusal);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Сторнувати' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Так, сторнувати' }));
    await waitFor(() => expect(reverseCalls()).toHaveLength(2));
    const keyOf = (i: number) => reverseCalls()[i][1].headers?.['Idempotency-Key'];
    expect(keyOf(1)).toBe(keyOf(0));

    // Уведена причина — закриття питало б «Скасувати зміни?»; порожня закривається одразу.
    fireEvent.change(within(dialog).getByLabelText(/^Причина сторно/), { target: { value: '' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Скасувати' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Сторно оплати постачальнику' })).toBeNull(),
    );
    const again = await openReversal();
    await reverseWith(again, 'помилкова оплата');
    await waitFor(() => expect(reverseCalls()).toHaveLength(3));
    expect(keyOf(2)).not.toBe(keyOf(0));
  });
});
