// НДІ → «Оплата»: куди надходять кошти способу оплати (каса чи банківський рахунок за
// замовчуванням). До 2026-10-14 ці поля ніде не задавались, тож оплата готівкою з рахунку
// йшла повз касу. Для «Готівки» каса тут — джерело каси у вікні оплати рахунку (BR-PAY-019).

import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, it, expect, describe, beforeEach } from 'vitest';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));
vi.mock('@/hooks/api/useCash', () => ({
  useCashRegisters: () => ({
    data: [
      { id: 'cr-main', name: 'Каса головна' },
      { id: 'cr-second', name: 'Каса друга' },
    ],
  }),
}));
vi.mock('@/hooks/api/useBankStatements', () => ({
  useBankAccountOptions: () => ({ data: [{ id: 'ba-1', name: 'ПриватБанк' }] }),
}));
vi.mock('@/components/ui/template-picker-modal', () => ({ TemplatePickerModal: () => null }));

import PaymentsTab from '../PaymentsTab';

const CASH = {
  id: 'pm-cash',
  code: 'cash',
  name: 'Готівка',
  isActive: true,
  isSystem: true,
  sortOrder: 1,
  requiresFiscal: false,
  isCash: true,
  defaultSourceType: null,
  defaultCashRegisterId: null,
  defaultBankAccountId: null,
  defaultDestinationName: null,
};
const CARD = {
  ...CASH,
  id: 'pm-card',
  code: 'card',
  name: 'Картка',
  isSystem: false,
  isCash: false,
  defaultSourceType: 'BANK_ACCOUNT',
  defaultBankAccountId: 'ba-1',
  defaultDestinationName: 'ПриватБанк',
};
let list: Record<string, unknown>[] = [];

function renderTab() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <PaymentsTab />
    </QueryClientProvider>,
  );
}

const patchBody = () => {
  const call = apiFetchMock.mock.calls.find(
    ([, init]) => (init as { method?: string } | undefined)?.method === 'PATCH',
  );
  return call ? (JSON.parse((call[1] as { body: string }).body) as Record<string, unknown>) : null;
};

async function openEdit(name: string) {
  renderTab();
  fireEvent.click(await screen.findByRole('button', { name: `Редагувати метод оплати: ${name}` }));
  return screen.findByRole('dialog');
}

const destinationSelect = (dialog: HTMLElement) =>
  within(dialog).getByRole('combobox', { name: /Куди надходять кошти/ }) as HTMLSelectElement;
const saveButton = (dialog: HTMLElement) =>
  within(dialog).getByRole('button', { name: 'Зберегти' });

describe('НДІ → способи оплати: куди надходять кошти', () => {
  beforeEach(() => {
    list = [CASH, CARD];
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation((path: string, init?: { method?: string; body?: string }) => {
      if (path === '/payment-methods' && !init) return Promise.resolve(list);
      if (init?.method === 'PATCH') {
        const id = path.split('/').pop();
        const body = JSON.parse(init.body ?? '{}') as Record<string, unknown>;
        const current = list.find(m => m.id === id)!;
        return Promise.resolve({
          ...current,
          ...body,
          defaultDestinationName: body.defaultCashRegisterId === 'cr-main' ? 'Каса головна' : null,
        });
      }
      return Promise.resolve({});
    });
  });

  it('у списку видно, куди надходять кошти кожного способу', async () => {
    renderTab();

    expect(await screen.findByTestId('pm-destination-card')).toHaveTextContent(
      'Банківський рахунок: ПриватБанк',
    );
    expect(screen.getByTestId('pm-destination-cash')).toHaveTextContent('— не вказано —');
  });

  it('тип є, а касу видалено — це видно в списку', async () => {
    list = [
      { ...CASH, defaultSourceType: 'CASH_REGISTER', defaultCashRegisterId: 'cr-gone' },
      CARD,
    ];
    renderTab();

    expect(await screen.findByTestId('pm-destination-cash')).toHaveTextContent(
      'Каса: касу чи рахунок видалено',
    );
  });

  // guards: BR-PAY-019
  it('«Готівці» задають касу: без вибраної каси зберегти не можна; запит несе тип і касу', async () => {
    const dialog = await openEdit('Готівка');

    fireEvent.change(destinationSelect(dialog), { target: { value: 'CASH_REGISTER' } });
    const cash = within(dialog).getByRole('combobox', { name: /^Каса/ }) as HTMLSelectElement;
    expect(cash.value).toBe('');
    expect(saveButton(dialog)).toBeDisabled();
    expect(within(dialog).getByText('Оберіть касу чи рахунок')).toBeInTheDocument();

    fireEvent.change(cash, { target: { value: 'cr-main' } });
    fireEvent.click(saveButton(dialog));

    await waitFor(() => expect(patchBody()).not.toBeNull());
    expect(apiFetchMock).toHaveBeenCalledWith('/payment-methods/pm-cash', expect.anything());
    expect(patchBody()).toEqual({
      requiresFiscal: false,
      defaultSourceType: 'CASH_REGISTER',
      defaultCashRegisterId: 'cr-main',
    });
    expect(await screen.findByTestId('pm-destination-cash')).toHaveTextContent(
      'Каса: Каса головна',
    );
  });

  // guards: BR-PAY-019 — готівка лягає лише в касу (рішення власника 2026-10-14)
  it('«Готівка»: банківського рахунку немає серед варіантів; в іншого способу він є', async () => {
    const values = (dialog: HTMLElement) =>
      Array.from(destinationSelect(dialog).options).map(o => o.value);

    const cashDialog = await openEdit('Готівка');
    expect(values(cashDialog)).toEqual(['', 'CASH_REGISTER']);
    cleanup();

    const cardDialog = await openEdit('Картка');
    expect(values(cardDialog)).toEqual(['', 'CASH_REGISTER', 'BANK_ACCOUNT']);
  });

  // guards: BR-PAY-019 — банківський рахунок «Готівки», збережений до правила
  it('«Готівка» зі старим банківським рахунком: його видно з поясненням, змінити можна на «не вказано»', async () => {
    list = [
      {
        ...CASH,
        defaultSourceType: 'BANK_ACCOUNT',
        defaultBankAccountId: 'ba-1',
        defaultDestinationName: 'ПриватБанк',
      },
      CARD,
    ];
    const dialog = await openEdit('Готівка');
    const select = destinationSelect(dialog);

    // Поле показує збережений тип, а не «— не вказано —»: інакше вибрати «не вказано» браузер
    // не дав би (вибір уже показаної опції change не породжує).
    expect(select.value).toBe('BANK_ACCOUNT');
    const bankOption = Array.from(select.options).find(o => o.value === 'BANK_ACCOUNT')!;
    expect(bankOption.disabled).toBe(true);
    expect(within(dialog).getByText(/лише в касу/)).toBeInTheDocument();
    expect(saveButton(dialog)).toBeEnabled();

    fireEvent.change(select, { target: { value: '' } });
    expect(Array.from(select.options).map(o => o.value)).toEqual(['', 'CASH_REGISTER']);
    fireEvent.click(saveButton(dialog));

    await waitFor(() => expect(patchBody()).not.toBeNull());
    expect(patchBody()).toEqual({
      requiresFiscal: false,
      defaultSourceType: null,
      defaultCashRegisterId: null,
      defaultBankAccountId: null,
    });
  });

  it('«— не вказано —» знімає призначення: усі три поля null', async () => {
    const dialog = await openEdit('Картка');

    expect(destinationSelect(dialog).value).toBe('BANK_ACCOUNT');
    expect(
      (within(dialog).getByRole('combobox', { name: /^Банківський рахунок/ }) as HTMLSelectElement)
        .value,
    ).toBe('ba-1');
    fireEvent.change(destinationSelect(dialog), { target: { value: '' } });
    fireEvent.click(saveButton(dialog));

    await waitFor(() => expect(patchBody()).not.toBeNull());
    expect(patchBody()).toMatchObject({
      defaultSourceType: null,
      defaultCashRegisterId: null,
      defaultBankAccountId: null,
    });
  });

  it('призначення не змінювали — запит його не несе (збережена каса могла зникнути)', async () => {
    const dialog = await openEdit('Картка');

    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Фіскальний/ }));
    fireEvent.click(saveButton(dialog));

    await waitFor(() => expect(patchBody()).not.toBeNull());
    expect(patchBody()).toEqual({ name: 'Картка', requiresFiscal: true });
  });

  // guards: BR-PAY-019 — «готівка» — ознака способу в довіднику, не код `cash`
  it('ознака «Готівка» видна в списку й у картці; увімкнули — запит несе isCash, рахунок недоступний', async () => {
    renderTab();
    expect(await screen.findByText(/^cash · готівка/)).toBeTruthy();
    cleanup();

    const dialog = await openEdit('Картка');
    const cashFlag = within(dialog).getByRole('checkbox', { name: /^Готівка/ }) as HTMLInputElement;
    expect(cashFlag.checked).toBe(false);
    fireEvent.click(cashFlag);
    // Банківський рахунок за замовчуванням тепер суперечить ознаці — поле пояснює чому.
    expect(within(dialog).getByText(/Для готівки кошти надходять лише в касу/)).toBeTruthy();
    fireEvent.change(destinationSelect(dialog), { target: { value: '' } });
    fireEvent.click(saveButton(dialog));

    await waitFor(() => expect(patchBody()).not.toBeNull());
    expect(patchBody()).toMatchObject({ isCash: true, defaultSourceType: null });
  });

  // guards: BR-PAY-019
  it('новий спосіб з ознакою «Готівка» — POST несе isCash: true', async () => {
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: /Метод оплати/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/^Код/), { target: { value: 'cash2' } });
    fireEvent.change(within(dialog).getByLabelText(/^Назва/), { target: { value: 'Каса 2' } });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /^Готівка/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Додати' }));

    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith(
        '/payment-methods',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    const post = apiFetchMock.mock.calls.find(
      ([, i]) => (i as { method?: string })?.method === 'POST',
    )!;
    expect(JSON.parse((post[1] as { body: string }).body)).toMatchObject({
      code: 'CASH2',
      isCash: true,
    });
  });
});
