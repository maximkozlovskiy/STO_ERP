// «Привід за замовчуванням» у статті руху коштів (BR-CASH-022).
//
//   - у картці створення й редагування є поле з приводами ТОГО Ж напряму, що й тип статті:
//     витрата → приводи видачі (разом із «зарплатою», яку ставить лише система),
//     оприбуткування → приводи внесення; порожнє значення — «— немає —»;
//   - привід, зайнятий іншою статтею, неактивний і підписаний назвою статті-власника;
//     власний привід статті в її картці лишається доступним;
//   - create шле `defaultReason` лише коли його обрано; update — лише коли змінено, і `null`
//     знімає привід;
//   - у дереві біля статті стоїть позначка її приводу;
//   - відмова сервера (409 «привід зайнятий») показана в картці.
//
// Mutation-verify:
//   - `owner.id !== editing?.id` → `true`                  → «власний привід доступний» падає;
//   - `defaultReason: defaultReason || null` → `|| undefined` → «null знімає привід» падає;
//   - `reasonChanged ? … : {}` → завжди слати                 → «без зміни привід не шлеться» падає;
//   - `direction = type === 'INCOME' ? 'IN' : 'OUT'` навпаки  → обидва кейси переліку падають.

import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import { CASH_REASON_RULES, CASH_REASON_VALUES } from '@sto/shared';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast: toastMock }));

import ExpenseCategoriesTab from '../ExpenseCategoriesTab';
import { renderWithQueryClient } from '@/__tests__/query-utils';

const RENT = 'c-rent';
const SUPPLIERS = 'c-suppliers';
const SALARY = 'c-salary';
const REVENUE = 'c-revenue';

const node = (
  id: string,
  name: string,
  type: 'EXPENSE' | 'INCOME',
  defaultReason: string | null = null,
) => ({
  id,
  orgId: 'o1',
  parentId: null,
  name,
  type,
  sortOrder: 0,
  isActive: true,
  defaultReason,
  children: [],
  deletedAt: null,
  createdAt: '',
  updatedAt: '',
});

const TREE = [
  node(RENT, 'Оренда', 'EXPENSE'),
  node(SUPPLIERS, 'Постачальники', 'EXPENSE', 'SUPPLIER_PAYMENT'),
  node(SALARY, 'Зарплата', 'EXPENSE', 'PAYROLL'),
  node(REVENUE, 'Виручка', 'INCOME', 'SALE_PAYMENT'),
];

type Init = { method?: string; body?: string };

function mockApi(write?: () => Promise<unknown>) {
  apiFetchMock.mockImplementation((path: string, init?: Init) => {
    if (path.startsWith('/expense-categories') && !init?.method) {
      return Promise.resolve({ items: TREE, total: TREE.length });
    }
    if (init?.method === 'POST' || init?.method === 'PATCH') {
      return write ? write() : Promise.resolve({ id: 'saved' });
    }
    return Promise.reject(new Error(`неочікуваний запит ${path}`));
  });
}

const writes = () =>
  apiFetchMock.mock.calls
    .filter(c => ['POST', 'PATCH'].includes((c[1] as Init | undefined)?.method ?? ''))
    .map(c => ({
      path: c[0] as string,
      method: (c[1] as Init).method,
      body: JSON.parse((c[1] as Init).body!) as Record<string, unknown>,
    }));

const reasonSelect = () => screen.getByLabelText('Привід за замовчуванням') as HTMLSelectElement;
const options = () => Array.from(reasonSelect().options);
const rowOf = (name: string) => screen.getByText(name).parentElement as HTMLElement;
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Зберегти' }));

async function renderTab() {
  renderWithQueryClient(<ExpenseCategoriesTab canManage />);
  await screen.findByText('Оренда');
}
/** Картка нової кореневої статті: 0 — розділ «Витрати», 1 — «Оприбуткування». */
const openCreate = (section: 0 | 1) =>
  fireEvent.click(screen.getAllByRole('button', { name: 'Стаття' })[section]!);
const openEdit = (name: string) => fireEvent.click(within(rowOf(name)).getByTitle('Редагувати'));
const typeName = (value: string) =>
  fireEvent.change(screen.getByLabelText(/^Назва статті/), { target: { value } });

const reasonsOf = (direction: 'IN' | 'OUT') =>
  CASH_REASON_VALUES.filter(r => CASH_REASON_RULES[r].direction === direction);

describe('ExpenseCategoriesTab — привід за замовчуванням', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    toastMock.success.mockReset();
    toastMock.error.mockReset();
  });

  it('у дереві біля статті стоїть позначка її приводу', async () => {
    mockApi();
    await renderTab();
    expect(within(rowOf('Постачальники')).getByText('Оплата постачальнику')).toBeInTheDocument();
    expect(within(rowOf('Виручка')).getByText('Оплата контрагента')).toBeInTheDocument();
    expect(within(rowOf('Оренда')).queryByText(/Оплата|Витрата|Видача/)).not.toBeInTheDocument();
  });

  it('стаття витрат: приводи видачі разом із «зарплатою», без приводів внесення', async () => {
    mockApi();
    await renderTab();
    openCreate(0);
    expect(options().map(o => o.value)).toEqual(['', ...reasonsOf('OUT')]);
    expect(options()[0]!.textContent).toBe('— немає —');
    expect(options().map(o => o.value)).toContain('PAYROLL');
    expect(reasonSelect().value).toBe('');
  });

  it('стаття оприбуткування: приводи внесення', async () => {
    mockApi();
    await renderTab();
    openCreate(1);
    expect(options().map(o => o.value)).toEqual(['', ...reasonsOf('IN')]);
  });

  it('зайнятий привід неактивний і підписаний статтею-власником', async () => {
    mockApi();
    await renderTab();
    openCreate(0);
    const byValue = (v: string) => options().find(o => o.value === v)!;
    expect(byValue('SUPPLIER_PAYMENT').disabled).toBe(true);
    expect(byValue('SUPPLIER_PAYMENT').textContent).toBe(
      'Оплата постачальнику — зайнято статтею «Постачальники»',
    );
    expect(byValue('PAYROLL').disabled).toBe(true);
    expect(byValue('PAYROLL').textContent).toContain('«Зарплата»');
    expect(byValue('ADVANCE_ISSUE').disabled).toBe(false);
    expect(byValue('ADVANCE_ISSUE').textContent).toBe('Під звіт');
  });

  it('створення з приводом шле defaultReason; без приводу — не шле поля взагалі', async () => {
    mockApi();
    await renderTab();
    openCreate(0);
    typeName('Підзвітні кошти');
    fireEvent.change(reasonSelect(), { target: { value: 'ADVANCE_ISSUE' } });
    save();
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({
      path: '/expense-categories',
      method: 'POST',
      body: { name: 'Підзвітні кошти', type: 'EXPENSE', defaultReason: 'ADVANCE_ISSUE' },
    });

    await waitFor(() =>
      expect(screen.queryByLabelText('Привід за замовчуванням')).not.toBeInTheDocument(),
    );
    openCreate(1);
    typeName('Інше');
    save();
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes()[1]!.body).toEqual({ name: 'Інше', type: 'INCOME' });
  });

  it('редагування: власний привід обрано й доступний; без зміни привід не шлеться', async () => {
    mockApi();
    await renderTab();
    openEdit('Постачальники');
    expect(reasonSelect().value).toBe('SUPPLIER_PAYMENT');
    const own = options().find(o => o.value === 'SUPPLIER_PAYMENT')!;
    expect(own.disabled).toBe(false);
    expect(own.textContent).toBe('Оплата постачальнику');

    typeName('Постачальники запчастин');
    save();
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({
      path: `/expense-categories/${SUPPLIERS}`,
      method: 'PATCH',
      body: { name: 'Постачальники запчастин' },
    });
  });

  it('«— немає —» знімає привід: у запит іде null', async () => {
    mockApi();
    await renderTab();
    openEdit('Постачальники');
    fireEvent.change(reasonSelect(), { target: { value: '' } });
    save();
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]!.body).toEqual({ name: 'Постачальники', defaultReason: null });
  });

  it('стаття без приводу отримує його при редагуванні', async () => {
    mockApi();
    await renderTab();
    openEdit('Оренда');
    expect(reasonSelect().value).toBe('');
    fireEvent.change(reasonSelect(), { target: { value: 'EXPENSE' } });
    save();
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]!.body).toEqual({ name: 'Оренда', defaultReason: 'EXPENSE' });
  });

  it('відмова сервера (привід зайнятий) показана в картці', async () => {
    mockApi(() => Promise.reject(new Error('Привід уже закріплено за статтею «Постачальники»')));
    await renderTab();
    openEdit('Оренда');
    fireEvent.change(reasonSelect(), { target: { value: 'EXPENSE' } });
    save();
    expect(
      await screen.findByText('Привід уже закріплено за статтею «Постачальники»'),
    ).toBeVisible();
    expect(screen.getByLabelText('Привід за замовчуванням')).toBeInTheDocument();
    expect(toastMock.success).not.toHaveBeenCalled();
  });
});
