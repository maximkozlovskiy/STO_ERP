// Картка ручної касової операції (BR-CASH-016…022).
//
// Що стереже:
//   - поля картки йдуть із таблиці приводів `CASH_REASON_RULES`: контрагент (клієнт / постачальник),
//     працівник, документ-підстава — з'являються й зникають разом із приводом;
//   - обов'язкове поле без значення зупиняє запит і показує помилку біля поля;
//   - тіло POST /cash-registers/:id/operations — рівно вихід спільної схеми, без зайвих полів;
//   - зміна приводу очищає поля, яких новий привід не має; зміна контрагента очищає підставу;
//   - стаття підставляється за приводом, але вибір людини не перезаписується;
//   - приймальня бачить лише свої приводи й не ходить у довідник статей;
//   - відмова сервера лишається в картці; подвійний клік не шле двох запитів;
//     повтор після збою йде з тим самим `Idempotency-Key`.
//
// Mutation-verify:
//   - `if (nextRule.counterparty !== prevRule.counterparty) clearCounterparty()` прибрати
//       → «зміна приводу очищає контрагента» падає;
//   - `if (item.id !== counterpartyId) clearBaseDocument()` прибрати → «інший контрагент» падає;
//   - `categoryAutoRef.current = false` в onChange статті прибрати → «вибір людини» падає;
//   - `if (savingRef.current …) return` прибрати → «подвійний клік» падає;
//   - `clearErrors()` у onReasonChange прибрати → «знімає помилку поля» падає;
//   - `idempotencyKeyRef.current = newIdempotencyKey()` перенести в onValid → «той самий ключ» падає.

import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import {
  CASH_REASON_RULES,
  RECEPTIONIST_CASH_REASONS,
  manualCashReasons,
  type CashDirectionValue,
  type CashReasonValue,
} from '@sto/shared';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast: toastMock }));

// Пікер із пошуком і пагінацією — не мета тесту. Заглушка зберігає контракт: тягне список
// через `fetchItems` (тож видно, з яким фільтром пішов запит) і віддає вибір у `onSelect`.
vi.mock('@/components/ui/search-picker-modal', async () => {
  const { useEffect, useState } = await import('react');
  interface Item {
    id: string;
    primary: string;
  }
  function SearchPickerModal(p: {
    open: boolean;
    title: string;
    fetchItems: (q: string) => Promise<Item[]>;
    onSelect: (item: Item) => void;
  }) {
    const [items, setItems] = useState<Item[]>([]);
    const { open, fetchItems } = p;
    useEffect(() => {
      if (!open) return;
      let alive = true;
      void fetchItems('').then(d => {
        if (alive) setItems(d);
      });
      return () => {
        alive = false;
      };
    }, [open, fetchItems]);
    if (!open) return null;
    return (
      <div role="dialog" aria-label={p.title}>
        {items.map(i => (
          <button key={i.id} type="button" onClick={() => p.onSelect(i)}>
            {i.primary}
          </button>
        ))}
      </div>
    );
  }
  return { SearchPickerModal };
});

import { CashOperationModal } from '../CashOperationModal';
import { makeTestQueryClient } from '@/__tests__/query-utils';
import type { CashRegister } from '@/hooks/api/useCash';

const REG = 'reg-1';
const CLIENT = '11111111-1111-4111-8111-111111111111';
const CLIENT_2 = '11111111-1111-4111-8111-222222222222';
const SUPPLIER = '22222222-2222-4222-8222-222222222222';
const EMPLOYEE = '33333333-3333-4333-8333-333333333333';
const WORK_ORDER = '44444444-4444-4444-8444-444444444444';
const PURCHASE_ORDER = '55555555-5555-4555-8555-555555555555';
const CAT_SALE = '66666666-6666-4666-8666-666666666666';
const CAT_BANK = '77777777-7777-4777-8777-777777777777';
const CAT_OTHER = '88888888-8888-4888-8888-888888888888';
const CAT_RENT = '99999999-9999-4999-8999-999999999999';

const register = {
  id: REG,
  name: 'Каса №1',
  branchId: 'br-1',
  currencyCode: 'UAH',
  currencySymbol: '₴',
} as CashRegister;

const category = (
  id: string,
  name: string,
  type: 'INCOME' | 'EXPENSE',
  defaultReason: CashReasonValue | null = null,
) => ({ id, name, type, isActive: true, defaultReason, children: [] });

const INCOME_TREE = [
  category(CAT_SALE, 'Виручка від клієнтів', 'INCOME', 'SALE_PAYMENT'),
  category(CAT_BANK, 'Зняття з рахунку', 'INCOME', 'BANK_WITHDRAWAL'),
  category(CAT_OTHER, 'Інші надходження', 'INCOME'),
  category(CAT_RENT, 'Оренда', 'EXPENSE'),
];

type Init = { method?: string; body?: string; headers?: Record<string, string> };
const OPS_PATH = `/cash-registers/${REG}/operations`;

interface ApiOptions {
  categories?: unknown[];
  create?: () => Promise<unknown>;
}

function mockApi({ categories = [], create }: ApiOptions = {}) {
  apiFetchMock.mockImplementation((path: string, init?: Init) => {
    if (path === OPS_PATH && init?.method === 'POST') {
      return create ? create() : Promise.resolve({ id: 'op-1' });
    }
    if (path.startsWith('/expense-categories')) return Promise.resolve({ items: categories });
    if (path.startsWith('/counterparties?')) {
      const supplier = path.includes('types=SUPPLIER');
      return Promise.resolve({
        items: supplier
          ? [{ id: SUPPLIER, firstName: null, lastName: null, companyName: 'ТОВ Запчастини' }]
          : [
              { id: CLIENT, firstName: 'Олег', lastName: 'Коваль', companyName: null },
              { id: CLIENT_2, firstName: null, lastName: null, companyName: 'ТОВ Автопарк' },
            ],
      });
    }
    if (path.startsWith('/employees?')) {
      return Promise.resolve({
        items: [{ id: EMPLOYEE, firstName: 'Іван', lastName: 'Петренко' }],
      });
    }
    if (path.startsWith('/work-orders?')) {
      return Promise.resolve({
        items: [{ id: WORK_ORDER, number: 'НЗ-000012', status: 'INVOICED' }],
      });
    }
    if (path.startsWith('/purchase-orders?')) {
      return Promise.resolve({
        items: [{ id: PURCHASE_ORDER, number: 'ЗП-000003', status: 'ORDERED' }],
      });
    }
    return Promise.reject(new Error(`неочікуваний запит ${path}`));
  });
}

const createCalls = () =>
  apiFetchMock.mock.calls.filter(
    c => c[0] === OPS_PATH && (c[1] as Init | undefined)?.method === 'POST',
  ) as [string, Init][];
const lastBody = () => JSON.parse(createCalls().at(-1)![1].body!) as Record<string, unknown>;
const requested = (prefix: string) =>
  apiFetchMock.mock.calls.map(c => String(c[0])).filter(p => p.startsWith(prefix));

interface RenderOptions {
  direction?: CashDirectionValue;
  allowedReasons?: readonly CashReasonValue[];
  categoriesEnabled?: boolean;
}

function renderModal({
  direction = 'IN',
  allowedReasons,
  categoriesEnabled = true,
}: RenderOptions = {}) {
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={makeTestQueryClient()}>
      <CashOperationModal
        open
        onClose={onClose}
        direction={direction}
        register={register}
        allowedReasons={allowedReasons}
        categoriesEnabled={categoriesEnabled}
      />
    </QueryClientProvider>,
  );
  return { onClose };
}

const SUBMIT: Record<CashDirectionValue, string> = { IN: 'Внести', OUT: 'Видати' };
const submit = (direction: CashDirectionValue = 'IN') =>
  fireEvent.click(screen.getByRole('button', { name: SUBMIT[direction] }));
const typeAmount = (value: string) =>
  fireEvent.change(screen.getByLabelText(/^Сума/), { target: { value } });
const reasonSelect = () => screen.getByLabelText(/^Привід/) as HTMLSelectElement;
const chooseReason = (reason: CashReasonValue) =>
  fireEvent.change(reasonSelect(), { target: { value: reason } });
const categorySelect = () => screen.getByLabelText(/^Стаття/) as HTMLSelectElement;

/** Поле-посилання за підписом: обгортка з підписом, значенням і кнопками. */
const field = (label: string | RegExp) => screen.getByText(label).parentElement as HTMLElement;
const queryField = (label: string | RegExp) => screen.queryByText(label);

/** Відкриває пікер поля й обирає рядок із назвою `name`. */
async function pick(label: string | RegExp, name: string) {
  fireEvent.click(within(field(label)).getByRole('button', { name: 'Обрати' }));
  fireEvent.click(await screen.findByRole('button', { name }));
}

const COUNTERPARTY = 'Контрагент';
const EMPLOYEE_FIELD = 'Працівник';
const BASE = /-підстава/;

describe('CashOperationModal', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    toastMock.success.mockReset();
    toastMock.error.mockReset();
  });

  describe('приводи в переліку', () => {
    it.each<CashDirectionValue>(['IN', 'OUT'])(
      '%s: рівно ручні приводи напряму, у порядку таблиці; «зарплати» немає',
      direction => {
        mockApi();
        renderModal({ direction });
        const values = Array.from(reasonSelect().options).map(o => o.value);
        expect(values).toEqual(manualCashReasons(direction));
        expect(values).not.toContain('PAYROLL');
      },
    );

    it('кожен привід має український підпис, а не код', () => {
      mockApi();
      renderModal({ direction: 'IN' });
      const labels = Array.from(reasonSelect().options).map(o => o.textContent);
      expect(labels).toEqual([
        'Оплата контрагента',
        'Повернення від постачальника',
        'Повернення підзвіту',
        'Отримання з банку',
        'Внесок власника',
        'Інкасація',
        'Внесення',
      ]);
    });
  });

  describe('привід з обов’язковим контрагентом', () => {
    const cases: [CashReasonValue, CashDirectionValue, string, string, string][] = [
      ['SALE_PAYMENT', 'IN', 'types=CLIENT&types=BOTH', 'Коваль Олег', CLIENT],
      ['REFUND', 'OUT', 'types=CLIENT&types=BOTH', 'Коваль Олег', CLIENT],
      ['SUPPLIER_REFUND_IN', 'IN', 'types=SUPPLIER&types=BOTH', 'ТОВ Запчастини', SUPPLIER],
      ['SUPPLIER_PAYMENT', 'OUT', 'types=SUPPLIER&types=BOTH', 'ТОВ Запчастини', SUPPLIER],
    ];

    it.each(cases)(
      '%s: поле є й обов’язкове, список — лише потрібного типу, id іде в запит',
      async (reason, direction, typesFilter, name, id) => {
        mockApi();
        const { onClose } = renderModal({ direction });
        chooseReason(reason);
        typeAmount('1250,50');

        // Зірочка обов'язкового поля і відмова без значення — запит не йде.
        expect(within(field(COUNTERPARTY)).getByText('*')).toBeInTheDocument();
        submit(direction);
        expect(await screen.findByText('Для цього приводу вкажіть контрагента')).toBeVisible();
        expect(createCalls()).toHaveLength(0);

        await pick(COUNTERPARTY, name);
        expect(requested('/counterparties?').at(-1)).toContain(typesFilter);
        expect(within(field(COUNTERPARTY)).getByText(name)).toBeInTheDocument();

        submit(direction);
        await waitFor(() => expect(createCalls()).toHaveLength(1));
        expect(lastBody()).toEqual({ direction, reason, amount: 1250.5, counterpartyId: id });
        await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
      },
    );
  });

  describe('привід з обов’язковим працівником', () => {
    it.each<[CashReasonValue, CashDirectionValue]>([
      ['ADVANCE_RETURN', 'IN'],
      ['ADVANCE_ISSUE', 'OUT'],
    ])('%s: поле є й обов’язкове, id працівника іде в запит', async (reason, direction) => {
      mockApi();
      renderModal({ direction });
      chooseReason(reason);
      typeAmount('300');

      expect(within(field(EMPLOYEE_FIELD)).getByText('*')).toBeInTheDocument();
      expect(queryField(COUNTERPARTY)).not.toBeInTheDocument();
      submit(direction);
      expect(await screen.findByText('Для цього приводу вкажіть працівника')).toBeVisible();
      expect(createCalls()).toHaveLength(0);

      await pick(EMPLOYEE_FIELD, 'Петренко Іван');
      submit(direction);
      await waitFor(() => expect(createCalls()).toHaveLength(1));
      expect(lastBody()).toEqual({ direction, reason, amount: 300, employeeId: EMPLOYEE });
    });
  });

  it('привід без контрагента й працівника — цих полів немає, тіло лише з сумою', async () => {
    mockApi();
    renderModal({ direction: 'IN' });
    for (const reason of manualCashReasons('IN')) {
      const rule = CASH_REASON_RULES[reason];
      chooseReason(reason);
      expect(!!queryField(COUNTERPARTY)).toBe(!!rule.counterparty);
      expect(!!queryField(EMPLOYEE_FIELD)).toBe(!!rule.employee);
      // Підстава — лише після вибору контрагента, отже на порожній картці її немає ніколи.
      expect(queryField(BASE)).not.toBeInTheDocument();
    }
    chooseReason('BANK_WITHDRAWAL');
    typeAmount('5000');
    submit();
    await waitFor(() => expect(createCalls()).toHaveLength(1));
    expect(lastBody()).toEqual({ direction: 'IN', reason: 'BANK_WITHDRAWAL', amount: 5000 });
  });

  describe('документ-підстава', () => {
    it('клієнт → наряди цього клієнта; тип і id підстави йдуть у запит разом', async () => {
      mockApi();
      renderModal({ direction: 'IN' });
      chooseReason('SALE_PAYMENT');
      typeAmount('800');
      expect(queryField(BASE)).not.toBeInTheDocument();

      await pick(COUNTERPARTY, 'Коваль Олег');
      await pick('Наряд-підстава (необовʼязково)', 'НЗ-000012');
      expect(requested('/work-orders?').at(-1)).toContain(`counterpartyId=${CLIENT}`);

      submit();
      await waitFor(() => expect(createCalls()).toHaveLength(1));
      expect(lastBody()).toEqual({
        direction: 'IN',
        reason: 'SALE_PAYMENT',
        amount: 800,
        counterpartyId: CLIENT,
        baseDocumentType: 'WorkOrder',
        baseDocumentId: WORK_ORDER,
      });
    });

    it('постачальник → замовлення цього постачальника', async () => {
      mockApi();
      renderModal({ direction: 'OUT' });
      chooseReason('SUPPLIER_PAYMENT');
      typeAmount('4200');
      await pick(COUNTERPARTY, 'ТОВ Запчастини');
      await pick('Замовлення-підстава (необовʼязково)', 'ЗП-000003');
      expect(requested('/purchase-orders?').at(-1)).toContain(`supplierId=${SUPPLIER}`);

      submit('OUT');
      await waitFor(() => expect(createCalls()).toHaveLength(1));
      expect(lastBody()).toEqual({
        direction: 'OUT',
        reason: 'SUPPLIER_PAYMENT',
        amount: 4200,
        counterpartyId: SUPPLIER,
        baseDocumentType: 'PurchaseOrder',
        baseDocumentId: PURCHASE_ORDER,
      });
    });

    it('підстава необов’язкова: без неї запит іде', async () => {
      mockApi();
      renderModal({ direction: 'IN' });
      chooseReason('SALE_PAYMENT');
      typeAmount('100');
      await pick(COUNTERPARTY, 'Коваль Олег');
      expect(within(field(BASE)).queryByText('*')).not.toBeInTheDocument();
      submit();
      await waitFor(() => expect(createCalls()).toHaveLength(1));
      expect(lastBody()).not.toHaveProperty('baseDocumentId');
    });

    it('інший контрагент очищає підставу — чужий наряд у запит не йде', async () => {
      mockApi();
      renderModal({ direction: 'IN' });
      chooseReason('SALE_PAYMENT');
      typeAmount('100');
      await pick(COUNTERPARTY, 'Коваль Олег');
      await pick(BASE, 'НЗ-000012');
      expect(within(field(BASE)).getByText('НЗ-000012')).toBeInTheDocument();

      await pick(COUNTERPARTY, 'ТОВ Автопарк');
      expect(within(field(BASE)).queryByText('НЗ-000012')).not.toBeInTheDocument();

      submit();
      await waitFor(() => expect(createCalls()).toHaveLength(1));
      expect(lastBody()).toEqual({
        direction: 'IN',
        reason: 'SALE_PAYMENT',
        amount: 100,
        counterpartyId: CLIENT_2,
      });
    });

    it('очищений контрагент забирає з собою підставу й саме поле підстави', async () => {
      mockApi();
      renderModal({ direction: 'IN' });
      chooseReason('SALE_PAYMENT');
      await pick(COUNTERPARTY, 'Коваль Олег');
      await pick(BASE, 'НЗ-000012');

      fireEvent.click(within(field(COUNTERPARTY)).getByRole('button', { name: 'Очистити' }));
      expect(queryField(BASE)).not.toBeInTheDocument();

      // Повторний вибір того самого клієнта не повертає стару підставу.
      await pick(COUNTERPARTY, 'Коваль Олег');
      expect(within(field(BASE)).queryByText('НЗ-000012')).not.toBeInTheDocument();
    });
  });

  describe('зміна приводу', () => {
    it('очищає контрагента й підставу, яких новий привід не має', async () => {
      mockApi();
      renderModal({ direction: 'IN' });
      chooseReason('SALE_PAYMENT');
      typeAmount('100');
      await pick(COUNTERPARTY, 'Коваль Олег');
      await pick(BASE, 'НЗ-000012');

      chooseReason('MANUAL_IN');
      expect(queryField(COUNTERPARTY)).not.toBeInTheDocument();
      submit();
      await waitFor(() => expect(createCalls()).toHaveLength(1));
      expect(lastBody()).toEqual({ direction: 'IN', reason: 'MANUAL_IN', amount: 100 });
    });

    it('клієнт не переходить у привід постачальника', async () => {
      mockApi();
      renderModal({ direction: 'IN' });
      chooseReason('SALE_PAYMENT');
      await pick(COUNTERPARTY, 'Коваль Олег');

      chooseReason('SUPPLIER_REFUND_IN');
      expect(within(field(COUNTERPARTY)).queryByText('Коваль Олег')).not.toBeInTheDocument();
      expect(queryField(BASE)).not.toBeInTheDocument();
    });

    it('очищає працівника, якого новий привід не має', async () => {
      mockApi();
      renderModal({ direction: 'IN' });
      chooseReason('ADVANCE_RETURN');
      typeAmount('50');
      await pick(EMPLOYEE_FIELD, 'Петренко Іван');

      chooseReason('OWNER_IN');
      submit();
      await waitFor(() => expect(createCalls()).toHaveLength(1));
      expect(lastBody()).toEqual({ direction: 'IN', reason: 'OWNER_IN', amount: 50 });
    });

    it('знімає помилку поля попереднього приводу', async () => {
      mockApi();
      renderModal({ direction: 'IN' });
      chooseReason('SALE_PAYMENT');
      typeAmount('10');
      submit();
      await screen.findByText('Для цього приводу вкажіть контрагента');
      // Поле контрагента в новому приводі теж є — помилка зникає не разом із полем, а сама.
      chooseReason('SUPPLIER_REFUND_IN');
      expect(queryField(COUNTERPARTY)).toBeInTheDocument();
      expect(screen.queryByText('Для цього приводу вкажіть контрагента')).not.toBeInTheDocument();
    });
  });

  describe('стаття за приводом', () => {
    it('привід підставляє статтю з таким самим «приводом за замовчуванням»', async () => {
      mockApi({ categories: INCOME_TREE });
      renderModal({ direction: 'IN' });
      await screen.findByRole('option', { name: 'Інші надходження' });
      // Стартовий привід («Внесення») своєї статті не має.
      expect(categorySelect().value).toBe('');

      chooseReason('BANK_WITHDRAWAL');
      expect(categorySelect().value).toBe(CAT_BANK);

      typeAmount('700');
      submit();
      await waitFor(() => expect(createCalls()).toHaveLength(1));
      expect(lastBody()).toEqual({
        direction: 'IN',
        reason: 'BANK_WITHDRAWAL',
        amount: 700,
        expenseCategoryId: CAT_BANK,
      });
    });

    it('підставлену статтю наступний привід замінює, а якщо своєї немає — прибирає', async () => {
      mockApi({ categories: INCOME_TREE });
      renderModal({ direction: 'IN' });
      await screen.findByRole('option', { name: 'Інші надходження' });

      chooseReason('BANK_WITHDRAWAL');
      expect(categorySelect().value).toBe(CAT_BANK);
      chooseReason('SALE_PAYMENT');
      expect(categorySelect().value).toBe(CAT_SALE);
      chooseReason('OWNER_IN');
      expect(categorySelect().value).toBe('');
    });

    it('статтю, яку обрала людина, зміна приводу не чіпає', async () => {
      mockApi({ categories: INCOME_TREE });
      renderModal({ direction: 'IN' });
      await screen.findByRole('option', { name: 'Інші надходження' });

      chooseReason('BANK_WITHDRAWAL');
      fireEvent.change(categorySelect(), { target: { value: CAT_OTHER } });
      chooseReason('SALE_PAYMENT');
      expect(categorySelect().value).toBe(CAT_OTHER);
    });

    it('у переліку — лише статті напряму операції', async () => {
      mockApi({ categories: INCOME_TREE });
      renderModal({ direction: 'OUT' });
      await screen.findByRole('option', { name: 'Оренда' });
      expect(screen.queryByRole('option', { name: 'Інші надходження' })).not.toBeInTheDocument();
    });

    it('«Витрата» без статті не йде: помилка біля поля', async () => {
      mockApi({ categories: INCOME_TREE });
      renderModal({ direction: 'OUT' });
      await screen.findByRole('option', { name: 'Оренда' });
      chooseReason('EXPENSE');
      typeAmount('900');
      submit('OUT');
      expect(await screen.findByText('Для витрати вкажіть статтю витрат')).toBeVisible();
      expect(createCalls()).toHaveLength(0);

      fireEvent.change(categorySelect(), { target: { value: CAT_RENT } });
      submit('OUT');
      await waitFor(() => expect(createCalls()).toHaveLength(1));
      expect(lastBody()).toEqual({
        direction: 'OUT',
        reason: 'EXPENSE',
        amount: 900,
        expenseCategoryId: CAT_RENT,
      });
    });
  });

  describe('приймальня', () => {
    it('бачить лише свої приводи, без статті, і не ходить у довідник статей', async () => {
      mockApi();
      renderModal({
        direction: 'IN',
        allowedReasons: RECEPTIONIST_CASH_REASONS,
        categoriesEnabled: false,
      });
      expect(Array.from(reasonSelect().options).map(o => o.value)).toEqual([
        ...RECEPTIONIST_CASH_REASONS,
      ]);
      expect(screen.queryByLabelText(/^Стаття/)).not.toBeInTheDocument();
      // Привід обрано одразу — поле контрагента вже на місці.
      expect(within(field(COUNTERPARTY)).getByText('*')).toBeInTheDocument();

      typeAmount('450');
      await pick(COUNTERPARTY, 'Коваль Олег');
      submit();
      await waitFor(() => expect(createCalls()).toHaveLength(1));
      expect(lastBody()).toEqual({
        direction: 'IN',
        reason: 'SALE_PAYMENT',
        amount: 450,
        counterpartyId: CLIENT,
      });
      expect(requested('/expense-categories')).toEqual([]);
    });
  });

  describe('сума', () => {
    it('порожня або нульова сума не йде в запит', async () => {
      mockApi();
      renderModal({ direction: 'IN' });
      submit();
      await waitFor(() =>
        expect(screen.getByLabelText(/^Сума/)).toHaveAttribute('aria-invalid', 'true'),
      );
      typeAmount('0');
      submit();
      expect(await screen.findByText('Сума повинна бути більшою за нуль')).toBeVisible();
      expect(createCalls()).toHaveLength(0);
    });
  });

  describe('надсилання', () => {
    it('відмова сервера показана в картці, картка лишається відкритою', async () => {
      mockApi({
        create: () => Promise.reject(new Error('Підстава не належить цьому контрагентові')),
      });
      const { onClose } = renderModal({ direction: 'IN' });
      typeAmount('100');
      submit();
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Підстава не належить цьому контрагентові',
      );
      expect(onClose).not.toHaveBeenCalled();
      expect(toastMock.success).not.toHaveBeenCalled();
    });

    it('подвійний клік — один запит', async () => {
      let release: (v: unknown) => void = () => {};
      mockApi({ create: () => new Promise(r => (release = r)) });
      const { onClose } = renderModal({ direction: 'IN' });
      typeAmount('100');
      const button = screen.getByRole('button', { name: 'Внести' });
      fireEvent.click(button);
      fireEvent.click(button);
      await waitFor(() => expect(createCalls()).toHaveLength(1));
      fireEvent.click(button);
      release({ id: 'op-1' });
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
      expect(createCalls()).toHaveLength(1);
    });

    it('повтор після збою йде з тим самим Idempotency-Key', async () => {
      let attempt = 0;
      mockApi({
        create: () =>
          ++attempt === 1 ? Promise.reject(new Error('обрив')) : Promise.resolve({ id: 'op-1' }),
      });
      renderModal({ direction: 'IN' });
      typeAmount('100');
      submit();
      await screen.findByRole('alert');
      submit();
      await waitFor(() => expect(createCalls()).toHaveLength(2));
      const keys = createCalls().map(c => c[1].headers?.['Idempotency-Key']);
      expect(keys[0]).toBeTruthy();
      expect(keys[1]).toBe(keys[0]);
    });

    it('успіх: підтвердження за напрямом', async () => {
      mockApi();
      renderModal({ direction: 'OUT' });
      typeAmount('100');
      submit('OUT');
      await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith('Готівку видано'));
    });
  });

  // Bug #853: картка закривалась по Escape разом із введеним, без запиту.
  describe('закриття з уведеним', () => {
    const escape = () => fireEvent.keyDown(document, { key: 'Escape' });
    const UNSAVED = 'Є незбережені зміни';

    it('порожня картка закривається одразу, без запиту', async () => {
      mockApi();
      const { onClose } = renderModal({ direction: 'IN' });
      chooseReason('OWNER_IN');
      escape();
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
      expect(screen.queryByText(UNSAVED)).toBeNull();
    });

    // UX-огляд 2026-10-29: підвал «Скасувати / Внести» (була одна кнопка), сума праворуч.
    it('підвал «Скасувати / Внести»; «Скасувати» без змін закриває одразу; сума праворуч', async () => {
      mockApi();
      const { onClose } = renderModal({ direction: 'IN' });
      expect(screen.getByRole('button', { name: 'Внести' })).toBeInTheDocument();
      expect(screen.getByLabelText(/^Сума/)).toHaveClass('text-right');
      fireEvent.click(screen.getByRole('button', { name: 'Скасувати' }));
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    });

    it('з уведеною сумою — запит; «Скасувати» лишає картку й суму', async () => {
      mockApi();
      const { onClose } = renderModal({ direction: 'IN' });
      typeAmount('777');
      escape();
      expect(await screen.findByText(UNSAVED)).toBeVisible();
      expect(onClose).not.toHaveBeenCalled();
      // «Скасувати» запиту (у підвалі картки тепер теж є «Скасувати» — UX-огляд 2026-10-29).
      const prompt = screen.getByText(UNSAVED).closest('[role="dialog"]') as HTMLElement;
      fireEvent.click(within(prompt).getByRole('button', { name: 'Скасувати' }));
      await waitFor(() => expect(screen.queryByText(UNSAVED)).toBeNull());
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByLabelText(/^Сума/)).toHaveValue('777');
    });

    it('з обраним контрагентом — запит; «Покинути» закриває картку', async () => {
      mockApi();
      const { onClose } = renderModal({ direction: 'IN' });
      chooseReason('SALE_PAYMENT');
      await pick(COUNTERPARTY, 'Коваль Олег');
      // Пікер закрито — тепер Escape належить картці (верхній шар Escape).
      await waitFor(() => {
        escape();
        expect(screen.getByText(UNSAVED)).toBeVisible();
      });
      fireEvent.click(screen.getByRole('button', { name: 'Покинути' }));
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    });

    it('після успішного проведення картка закривається без запиту', async () => {
      mockApi();
      const { onClose } = renderModal({ direction: 'IN' });
      typeAmount('100');
      submit();
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
      expect(screen.queryByText(UNSAVED)).toBeNull();
    });
  });
});
