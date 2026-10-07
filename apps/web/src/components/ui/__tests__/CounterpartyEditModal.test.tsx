// Компонентні тести вкладок «Договори» та «Авто» у CounterpartyEditModal.
//
// Що стережуть (docs/objects/counterparty.md):
//   BR-CP-005 — «Вид договору»: пункти select фільтруються за типом контрагента, дефолт,
//               обов'язковий вибір для BOTH, submit бере вибір користувача.
//   BR-CP-006 — CRUD договору: POST / PATCH за editingContractId / DELETE через useConfirm,
//               optimistic «Головний» у межах contractType, tenant-guard при зміні контрагента.
//   BR-CP-007 — CRUD авто: POST з авто-створенням гаража «Основний», PATCH без
//               customerGarageId, DELETE через useConfirm.
//
// Мережа — один мок `apiFetch` з таблицею маршрутів (`mountApi`). Усе, що модалка читає при
// відкритті (гаражі, авто, наряди, договори, налаштування, валюти), віддається одразу;
// запити-мутації тест задає сам через `on`.

import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';

import { CounterpartyEditModal, type CounterpartyForModal } from '../CounterpartyEditModal';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

vi.mock('@/hooks/useUiFeatures', () => ({
  useUiFeatures: () => ({ toastEnabled: false, unsavedGuardEnabled: false }),
}));

vi.mock('@/hooks/useDirtyForm', () => ({
  useDirtyForm: () => ({
    isDirty: false,
    markDirty: vi.fn(),
    resetDirty: vi.fn(),
    confirmClose: () => Promise.resolve(true),
    dialogProps: { open: false },
  }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ employee: { role: 'OWNER' } }),
}));

// Статуси-мітки — окремий компонент зі своїм fetch-ем; до договорів і авто стосунку не має.
vi.mock('@/components/ui/CounterpartyStatusManager', () => ({
  StatusManager: () => null,
}));

// ─── Тестові дані ─────────────────────────────────────────────────────────────

type CpType = CounterpartyForModal['type'];

const cp = (type: CpType, id = 'cp-1'): CounterpartyForModal => ({
  id,
  type,
  firstName: null,
  lastName: null,
  companyName: 'ТОВ Тест',
  vatPayer: false,
});

interface ContractRow {
  id: string;
  number: string;
  contractType: 'PURCHASE' | 'SALE';
  startDate: string;
  endDate: string | null;
  isPrimary: boolean;
  creditLimit: number | null;
  currencyCode: string;
  paymentDeferDays: number | null;
  deletedAt?: string | null;
}

const contract = (
  over: Partial<ContractRow> & Pick<ContractRow, 'id' | 'number'>,
): ContractRow => ({
  contractType: 'PURCHASE',
  startDate: '2026-01-15T00:00:00.000Z',
  endDate: null,
  isPrimary: false,
  creditLimit: null,
  currencyCode: 'UAH',
  paymentDeferDays: null,
  ...over,
});

interface VehicleRow {
  id: string;
  make: string;
  model: string;
  year: number | null;
  licensePlate: string;
  vin?: string | null;
}

// ─── Мок API ──────────────────────────────────────────────────────────────────

interface ApiCall {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
}

type Handler = (call: ApiCall) => unknown;

/**
 * Таблиця маршрутів поверх `apiFetchMock`. `seed` — те, що модалка читає при відкритті
 * (ключ — id контрагента). `on('POST /vehicles', fn)` — відповідь на мутацію. Мутація без
 * обробника кидає помилку: тест не може тихо «пройти» на запиті, якого не чекав.
 */
function mountApi(seed: {
  garages?: Record<string, { id: string }[]>;
  vehicles?: Record<string, VehicleRow[]>;
  contracts?: Record<string, ContractRow[]>;
}) {
  const calls: ApiCall[] = [];
  const handlers = new Map<string, Handler>();

  apiFetchMock.mockImplementation((path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body
      ? (JSON.parse(init.body as string) as Record<string, unknown>)
      : undefined;
    const call: ApiCall = { method, path, body };
    calls.push(call);

    if (method === 'GET') {
      const garages = /^\/counterparties\/([^/]+)\/garages$/.exec(path);
      if (garages) return Promise.resolve(seed.garages?.[garages[1]!] ?? []);
      const vehicles = /^\/vehicles\?counterpartyId=([^&]+)/.exec(path);
      if (vehicles) return Promise.resolve(seed.vehicles?.[vehicles[1]!] ?? []);
      const contracts = /^\/counterparties\/([^/?]+)\/contracts/.exec(path);
      if (contracts) return Promise.resolve(seed.contracts?.[contracts[1]!] ?? []);
      if (path.startsWith('/work-orders')) return Promise.resolve({ items: [] });
      if (path === '/settings/organisation') return Promise.resolve({ currency: 'UAH' });
      if (path === '/currencies') {
        return Promise.resolve({ items: [{ code: 'UAH', name: 'Гривня' }], total: 1 });
      }
      return Promise.reject(new Error(`Неочікуваний GET ${path}`));
    }

    const handler = handlers.get(`${method} ${path}`);
    if (!handler) return Promise.reject(new Error(`Неочікуваний запит ${method} ${path}`));
    return Promise.resolve().then(() => handler(call));
  });

  return {
    calls,
    on: (route: string, handler: Handler) => handlers.set(route, handler),
    mutations: () => calls.filter(c => c.method !== 'GET'),
  };
}

// ─── Хелпери DOM ──────────────────────────────────────────────────────────────

function renderModal(counterparty: CounterpartyForModal) {
  return render(
    <CounterpartyEditModal
      open
      counterparty={counterparty}
      onClose={() => {}}
      onSaved={() => {}}
    />,
  );
}

/** Відкрити вкладку і дочекатись, поки зникне «Завантаження...». */
async function openTab(label: 'Договори' | 'Авто') {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${label}`) }));
  const marker = label === 'Договори' ? 'Додати договір' : 'Додати авто';
  await screen.findByRole('button', { name: marker });
}

/** `<select>` поля «Вид договору» (у label немає htmlFor — шукаємо в межах обгортки поля). */
function contractTypeSelect(): HTMLSelectElement {
  const select = screen.getByText('Вид договору').parentElement?.querySelector('select');
  if (!select) throw new Error('select «Вид договору» не знайдено');
  return select;
}

const optionValues = (select: HTMLSelectElement) => Array.from(select.options).map(o => o.value);

/** Рядок таблиці за текстом першої клітинки (номер договору / «Марка Модель»). */
function row(text: string | RegExp): HTMLElement {
  const tr = screen.getByText(text).closest('tr');
  if (!tr) throw new Error(`рядок «${String(text)}» не знайдено`);
  return tr;
}

const isPrimaryRow = (number: string) => within(row(number)).queryByText('Головний') !== null;

/** Кнопка збереження інлайн-форми вкладки («Зберегти» / «Оновити»). */
const formButton = (name: 'Зберегти' | 'Оновити') =>
  screen.getByRole('button', { name }) as HTMLButtonElement;

async function confirmDialog(title: string, answer: 'Так' | 'Скасувати') {
  const dialog = (await screen.findByText(title)).closest('[role="dialog"]') as HTMLElement;
  fireEvent.click(within(dialog).getByRole('button', { name: answer }));
}

beforeEach(() => {
  apiFetchMock.mockReset();
});

// ─── BR-CP-005 ────────────────────────────────────────────────────────────────

describe('CounterpartyEditModal — «Вид договору» за типом контрагента (BR-CP-005)', () => {
  // guards: BR-CP-005
  it.each([
    ['SUPPLIER', 'PURCHASE'],
    ['CLIENT', 'SALE'],
  ] as const)(
    '%s → у списку лише %s, він же обраний за замовчуванням; поле редаговане',
    async (cpType, only) => {
      mountApi({});
      renderModal(cp(cpType));
      await openTab('Договори');
      fireEvent.click(screen.getByRole('button', { name: 'Додати договір' }));

      const select = contractTypeSelect();
      expect(optionValues(select)).toEqual([only]);
      expect(select.value).toBe(only);
      expect(select.disabled).toBe(false);
      // Обов'язковий вибір не потрібен — «Зберегти» доступна одразу.
      expect(formButton('Зберегти').disabled).toBe(false);
    },
  );

  // guards: BR-CP-005
  it('BOTH → порожній placeholder + обидва види; без вибору «Зберегти» заблокована', async () => {
    mountApi({});
    renderModal(cp('BOTH'));
    await openTab('Договори');
    fireEvent.click(screen.getByRole('button', { name: 'Додати договір' }));

    const select = contractTypeSelect();
    expect(optionValues(select)).toEqual(['', 'PURCHASE', 'SALE']);
    expect(select.value).toBe('');
    expect(select.disabled).toBe(false);
    expect(formButton('Зберегти').disabled).toBe(true);

    fireEvent.change(select, { target: { value: 'SALE' } });
    expect(formButton('Зберегти').disabled).toBe(false);
  });

  // guards: BR-CP-005
  it('submit шле вид, який обрав користувач, а не виведений із типу контрагента', async () => {
    const api = mountApi({});
    api.on('POST /counterparties/cp-1/contracts', ({ body }) =>
      contract({ id: 'con-new', number: 'ДГ-10', contractType: body!.contractType as 'SALE' }),
    );
    renderModal(cp('BOTH'));
    await openTab('Договори');
    fireEvent.click(screen.getByRole('button', { name: 'Додати договір' }));
    fireEvent.change(contractTypeSelect(), { target: { value: 'SALE' } });
    fireEvent.click(formButton('Зберегти'));

    await screen.findByText('ДГ-10');
    expect(api.mutations()).toHaveLength(1);
    expect(api.mutations()[0]!.body).toMatchObject({ contractType: 'SALE' });
  });

  // guards: BR-CP-005
  it('SUPPLIER: submit без дотику до select шле дефолтний PURCHASE', async () => {
    const api = mountApi({});
    api.on('POST /counterparties/cp-1/contracts', () =>
      contract({ id: 'con-new', number: 'ДГ-11', contractType: 'PURCHASE' }),
    );
    renderModal(cp('SUPPLIER'));
    await openTab('Договори');
    fireEvent.click(screen.getByRole('button', { name: 'Додати договір' }));
    fireEvent.click(formButton('Зберегти'));

    await screen.findByText('ДГ-11');
    expect(api.mutations()[0]!.body).toMatchObject({ contractType: 'PURCHASE' });
  });
});

// ─── BR-CP-006 ────────────────────────────────────────────────────────────────

describe('CounterpartyEditModal — CRUD договору (BR-CP-006)', () => {
  // Контрагент BOTH: по головному договору кожного виду + ще один SALE.
  const bothContracts = (): ContractRow[] => [
    contract({ id: 'con-p1', number: 'КУП-1', contractType: 'PURCHASE', isPrimary: true }),
    contract({ id: 'con-s1', number: 'ПРОД-1', contractType: 'SALE', isPrimary: true }),
    contract({ id: 'con-s2', number: 'ПРОД-2', contractType: 'SALE' }),
  ];

  // guards: BR-CP-006
  it('створення: POST на /contracts контрагента; новий «Головний» знімає мітку лише зі свого виду', async () => {
    const api = mountApi({ contracts: { 'cp-1': bothContracts() } });
    api.on('POST /counterparties/cp-1/contracts', () =>
      contract({ id: 'con-s3', number: 'ПРОД-3', contractType: 'SALE', isPrimary: true }),
    );
    renderModal(cp('BOTH'));
    await openTab('Договори');
    expect(isPrimaryRow('КУП-1')).toBe(true);
    expect(isPrimaryRow('ПРОД-1')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Додати договір' }));
    fireEvent.change(contractTypeSelect(), { target: { value: 'SALE' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Головний' }));
    fireEvent.click(formButton('Зберегти'));

    await screen.findByText('ПРОД-3');
    expect(api.mutations()).toEqual([
      expect.objectContaining({
        method: 'POST',
        path: '/counterparties/cp-1/contracts',
        body: expect.objectContaining({ contractType: 'SALE', isPrimary: true }),
      }),
    ]);
    expect(isPrimaryRow('ПРОД-3')).toBe(true);
    expect(isPrimaryRow('ПРОД-1')).toBe(false); // той самий вид — мітку знято
    expect(isPrimaryRow('КУП-1')).toBe(true); // інший вид — не зачеплено
    // Форма закрилась — знову доступна кнопка «Додати договір».
    expect(screen.getByRole('button', { name: 'Додати договір' })).toBeInTheDocument();
  });

  // guards: BR-CP-006
  it('редагування: олівець заповнює форму з рядка, «Оновити» шле PATCH саме цього договору', async () => {
    const api = mountApi({
      contracts: {
        'cp-1': [
          contract({
            id: 'con-s1',
            number: 'ПРОД-1',
            contractType: 'SALE',
            isPrimary: true,
            creditLimit: 5000,
            paymentDeferDays: 14,
          }),
        ],
      },
    });
    api.on('PATCH /counterparties/cp-1/contracts/con-s1', ({ body }) =>
      contract({
        id: 'con-s1',
        number: 'ПРОД-1-змінений',
        contractType: 'SALE',
        isPrimary: true,
        creditLimit: body!.creditLimit as number,
      }),
    );
    renderModal(cp('BOTH'));
    await openTab('Договори');

    fireEvent.click(within(row('ПРОД-1')).getByTitle('Редагувати'));

    expect(contractTypeSelect().value).toBe('SALE');
    expect((screen.getByRole('checkbox', { name: 'Головний' }) as HTMLInputElement).checked).toBe(
      true,
    );
    const creditLimit = screen.getByDisplayValue('5000');
    expect(screen.getByDisplayValue('14')).toBeInTheDocument();
    expect(screen.getByDisplayValue('2026-01-15')).toBeInTheDocument();

    fireEvent.change(creditLimit, { target: { value: '7500' } });
    fireEvent.click(formButton('Оновити'));

    await screen.findByText('ПРОД-1-змінений');
    expect(api.mutations()).toEqual([
      expect.objectContaining({
        method: 'PATCH',
        path: '/counterparties/cp-1/contracts/con-s1',
        body: expect.objectContaining({
          contractType: 'SALE',
          startDate: '2026-01-15',
          creditLimit: 7500,
          paymentDeferDays: 14,
          isPrimary: true,
        }),
      }),
    ]);
    // Рядок замінено, а не додано другий.
    expect(screen.queryByText('ПРОД-1')).toBeNull();
  });

  // guards: BR-CP-006
  it('видалення головного: підтвердження → DELETE; головним стає наступний ТОГО Ж виду', async () => {
    const api = mountApi({ contracts: { 'cp-1': bothContracts() } });
    api.on('DELETE /counterparties/cp-1/contracts/con-s1', () => undefined);
    renderModal(cp('BOTH'));
    await openTab('Договори');

    fireEvent.click(within(row('ПРОД-1')).getByTitle('Видалити'));
    await confirmDialog('Видалити договір?', 'Так');

    await waitFor(() => expect(screen.queryByText('ПРОД-1')).toBeNull());
    expect(api.mutations()).toEqual([
      expect.objectContaining({ method: 'DELETE', path: '/counterparties/cp-1/contracts/con-s1' }),
    ]);
    expect(isPrimaryRow('ПРОД-2')).toBe(true); // промоут у межах SALE
    expect(isPrimaryRow('КУП-1')).toBe(true); // PURCHASE лишився як був
  });

  // guards: BR-CP-006
  it('видалення: відмова у діалозі підтвердження → DELETE не йде, рядок на місці', async () => {
    const api = mountApi({ contracts: { 'cp-1': bothContracts() } });
    renderModal(cp('BOTH'));
    await openTab('Договори');

    fireEvent.click(within(row('ПРОД-1')).getByTitle('Видалити'));
    await confirmDialog('Видалити договір?', 'Скасувати');

    // Даємо промісу confirm() завершитись, перш ніж стверджувати «нічого не сталося».
    await act(async () => {
      await Promise.resolve();
    });
    expect(api.mutations()).toEqual([]);
    expect(isPrimaryRow('ПРОД-1')).toBe(true);
  });

  // guards: BR-CP-006
  it('tenant-guard: відповідь на збереження, що прийшла після перемикання контрагента, не потрапляє у чужий список', async () => {
    const api = mountApi({
      contracts: { 'cp-2': [contract({ id: 'con-other', number: 'ЧУЖИЙ-1' })] },
    });
    let release: (v: ContractRow) => void = () => {};
    api.on(
      'POST /counterparties/cp-1/contracts',
      () =>
        new Promise<ContractRow>(resolve => {
          release = resolve;
        }),
    );
    const view = renderModal(cp('SUPPLIER', 'cp-1'));
    await openTab('Договори');
    fireEvent.click(screen.getByRole('button', { name: 'Додати договір' }));
    fireEvent.click(formButton('Зберегти'));
    await waitFor(() => expect(api.mutations()).toHaveLength(1));

    // Поки POST у польоті — модалку перемкнули на іншого контрагента.
    view.rerender(
      <CounterpartyEditModal
        open
        counterparty={cp('SUPPLIER', 'cp-2')}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );
    await openTab('Договори');
    await screen.findByText('ЧУЖИЙ-1');

    await act(async () => {
      release(contract({ id: 'con-late', number: 'ЗАПІЗНІЛИЙ', isPrimary: true }));
      await Promise.resolve();
    });

    expect(screen.queryByText('ЗАПІЗНІЛИЙ')).toBeNull();
    expect(screen.getByText('ЧУЖИЙ-1')).toBeInTheDocument();
  });
});

// ─── BR-CP-007 ────────────────────────────────────────────────────────────────

describe('CounterpartyEditModal — CRUD авто (BR-CP-007)', () => {
  const fillVehicle = (make: string, model: string) => {
    fireEvent.change(screen.getByPlaceholderText('BMW'), { target: { value: make } });
    fireEvent.change(screen.getByPlaceholderText('X5'), { target: { value: model } });
  };

  // guards: BR-CP-007
  it('створення без гаража: спершу POST гаража «Основний» (isDefault), потім POST авто у нього', async () => {
    const api = mountApi({ garages: { 'cp-1': [] } });
    api.on('POST /counterparties/cp-1/garages', () => ({ id: 'g-new' }));
    api.on('POST /vehicles', ({ body }) => ({
      id: 'v-new',
      make: body!.make,
      model: body!.model,
      year: null,
      licensePlate: '',
    }));
    renderModal(cp('CLIENT'));
    await openTab('Авто');

    fireEvent.click(screen.getByRole('button', { name: 'Додати авто' }));
    fillVehicle('Skoda', 'Octavia');
    fireEvent.click(formButton('Зберегти'));

    await screen.findByText('Skoda Octavia');
    expect(api.mutations()).toEqual([
      {
        method: 'POST',
        path: '/counterparties/cp-1/garages',
        body: { name: 'Основний', isDefault: true },
      },
      expect.objectContaining({
        method: 'POST',
        path: '/vehicles',
        body: expect.objectContaining({
          customerGarageId: 'g-new',
          make: 'Skoda',
          model: 'Octavia',
        }),
      }),
    ]);
  });

  // guards: BR-CP-007
  it('створення за наявного гаража: гараж НЕ створюється, авто йде у наявний', async () => {
    const api = mountApi({ garages: { 'cp-1': [{ id: 'g-1' }] } });
    api.on('POST /vehicles', ({ body }) => ({
      id: 'v-new',
      make: body!.make,
      model: body!.model,
      year: null,
      licensePlate: '',
    }));
    renderModal(cp('CLIENT'));
    await openTab('Авто');

    fireEvent.click(screen.getByRole('button', { name: 'Додати авто' }));
    fillVehicle('Skoda', 'Fabia');
    fireEvent.click(formButton('Зберегти'));

    await screen.findByText('Skoda Fabia');
    expect(api.mutations()).toEqual([
      expect.objectContaining({
        method: 'POST',
        path: '/vehicles',
        body: expect.objectContaining({ customerGarageId: 'g-1' }),
      }),
    ]);
  });

  // guards: BR-CP-007
  it('редагування: олівець заповнює 5 полів з рядка, «Оновити» шле PATCH /vehicles/:id без customerGarageId', async () => {
    const api = mountApi({
      garages: { 'cp-1': [{ id: 'g-1' }] },
      vehicles: {
        'cp-1': [
          {
            id: 'v-1',
            make: 'Toyota',
            model: 'Camry',
            year: 2018,
            licensePlate: 'AA1234BB',
            vin: 'JTDBE32K123456789',
          },
        ],
      },
    });
    api.on('PATCH /vehicles/v-1', ({ body }) => ({
      id: 'v-1',
      make: 'Toyota',
      model: body!.model,
      year: 2018,
      licensePlate: 'AA1234BB',
      vin: 'JTDBE32K123456789',
    }));
    renderModal(cp('CLIENT'));
    await openTab('Авто');

    fireEvent.click(within(row('Toyota Camry')).getByTitle('Редагувати'));

    expect((screen.getByPlaceholderText('BMW') as HTMLInputElement).value).toBe('Toyota');
    expect((screen.getByPlaceholderText('X5') as HTMLInputElement).value).toBe('Camry');
    expect((screen.getByPlaceholderText('2015') as HTMLInputElement).value).toBe('2018');
    expect((screen.getByPlaceholderText('AA 1234 BB') as HTMLInputElement).value).toBe('AA1234BB');
    expect((screen.getByPlaceholderText('WVWZZZ1JZXW000001') as HTMLInputElement).value).toBe(
      'JTDBE32K123456789',
    );

    fireEvent.change(screen.getByPlaceholderText('X5'), { target: { value: 'Corolla' } });
    fireEvent.click(formButton('Оновити'));

    await screen.findByText('Toyota Corolla');
    const mutations = api.mutations();
    expect(mutations).toHaveLength(1);
    expect(mutations[0]).toMatchObject({
      method: 'PATCH',
      path: '/vehicles/v-1',
      body: {
        make: 'Toyota',
        model: 'Corolla',
        year: 2018,
        licensePlate: 'AA1234BB',
        vin: 'JTDBE32K123456789',
      },
    });
    expect(mutations[0]!.body).not.toHaveProperty('customerGarageId');
    // Рядок замінено, а не додано другий.
    expect(screen.queryByText('Toyota Camry')).toBeNull();
  });

  // guards: BR-CP-007
  it('видалення: підтвердження → DELETE /vehicles/:id, рядок зникає; відмова → нічого', async () => {
    const api = mountApi({
      garages: { 'cp-1': [{ id: 'g-1' }] },
      vehicles: {
        'cp-1': [
          { id: 'v-1', make: 'Toyota', model: 'Camry', year: 2018, licensePlate: 'AA1234BB' },
          { id: 'v-2', make: 'Honda', model: 'Civic', year: 2020, licensePlate: 'BB5678CC' },
        ],
      },
    });
    api.on('DELETE /vehicles/v-1', () => undefined);
    renderModal(cp('CLIENT'));
    await openTab('Авто');

    // Відмова.
    fireEvent.click(within(row('Toyota Camry')).getByTitle('Видалити'));
    await confirmDialog('Видалити авто?', 'Скасувати');
    await act(async () => {
      await Promise.resolve();
    });
    expect(api.mutations()).toEqual([]);
    expect(screen.getByText('Toyota Camry')).toBeInTheDocument();

    // Згода.
    fireEvent.click(within(row('Toyota Camry')).getByTitle('Видалити'));
    await confirmDialog('Видалити авто?', 'Так');
    await waitFor(() => expect(screen.queryByText('Toyota Camry')).toBeNull());
    expect(api.mutations()).toEqual([
      expect.objectContaining({ method: 'DELETE', path: '/vehicles/v-1' }),
    ]);
    expect(screen.getByText('Honda Civic')).toBeInTheDocument();
  });
});
