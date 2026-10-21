import { screen, waitFor, within } from '@testing-library/react';
import { renderWithQueryClient } from '@/__tests__/query-utils';
import userEvent from '@testing-library/user-event';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import { CreateWorkOrderModal } from '../CreateWorkOrderModal';

/**
 * BR-WO-029: склад рядка товару в картці наряду — біля складу вільна кількість обраного товару, а
 * склад підставляється сам, щойно прийшли залишки товару. Ручний вибір складу не перезаписується,
 * доки не змінено товар. Збереженого рядка правило не стосується (BR-WO-021).
 *
 * Mutation-verify (2026-10-22): прибрати виклик `pickPartWarehouse` в ефекті картки → падають
 * кейси автовибору; не знімати очікування при ручному виборі → падає «ручний вибір»; підпис
 * опції без кількості → падає «підписи опцій».
 */

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ employee: { role: 'OWNER' } }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/',
}));

vi.mock('@/lib/ref-cache', () => ({
  getCached: () => null,
  setCache: vi.fn(),
}));

vi.mock('@/hooks/api/useCash', () => ({
  useBaseCurrency: () => ({ data: { code: 'UAH', symbol: '₴' } }),
}));

const WO = '20000000-0000-4000-8000-000000000001';
const B1 = '20000000-0000-4000-8000-000000000002';
const V1 = '20000000-0000-4000-8000-000000000003';
const CP1 = '20000000-0000-4000-8000-000000000004';
const W_MAIN = '20000000-0000-4000-8000-000000000005';
const W_SIDE = '20000000-0000-4000-8000-000000000006';
const W_THIRD = '20000000-0000-4000-8000-000000000007';
const W_HOTEL = '20000000-0000-4000-8000-000000000008';
const G_SIDE_ONLY = '20000000-0000-4000-8000-000000000011';
const G_MAIN_TOO = '20000000-0000-4000-8000-000000000012';
const G_NOT_MAIN = '20000000-0000-4000-8000-000000000013';
const G_NOWHERE = '20000000-0000-4000-8000-000000000014';
const G_SAVED = '20000000-0000-4000-8000-000000000015';
const P_SAVED = '20000000-0000-4000-8000-000000000021';

const GOODS = [
  { id: G_SIDE_ONLY, name: 'Фільтр лише на бічному' },
  { id: G_MAIN_TOO, name: 'Олива на основному й бічному' },
  { id: G_NOT_MAIN, name: 'Свічка не на основному' },
  { id: G_NOWHERE, name: 'Ремінь без залишку' },
];

type WhRow = { warehouseId: string; quantity: number; reserved: number; available: number };
const wh = (warehouseId: string, quantity: number, reserved = 0): WhRow => ({
  warehouseId,
  quantity,
  reserved,
  available: Math.max(0, quantity - reserved),
});

/** Залишки по товарах. Основний склад у G_SIDE_ONLY — усе в резерві (вільна 0). */
const STOCK: Record<string, WhRow[]> = {
  [G_SIDE_ONLY]: [wh(W_MAIN, 5, 5), wh(W_SIDE, 3)],
  [G_MAIN_TOO]: [wh(W_MAIN, 2), wh(W_SIDE, 9)],
  // Найбільше — у «Шинному готелі», якого немає в переліку вибору.
  [G_NOT_MAIN]: [wh(W_SIDE, 1), wh(W_THIRD, 4), wh(W_HOTEL, 40)],
  [G_SAVED]: [wh(W_SIDE, 6)],
};

let stockGate: Promise<void> | null = null;
let stockFail = false;

function stockTotals(path: string) {
  if (stockFail) return Promise.reject(new Error('Сервер недоступний'));
  const ids = new URL(path, 'http://x').searchParams.get('ids')!.split(',');
  const rows = ids
    .filter(id => STOCK[id])
    .map(id => ({
      goodId: id,
      totalQuantity: STOCK[id]!.reduce((s, r) => s + r.quantity, 0),
      byWarehouse: STOCK[id],
    }));
  return stockGate ? stockGate.then(() => rows) : Promise.resolve(rows);
}

function mockApi(savedParts: unknown[] = []) {
  apiFetchMock.mockImplementation((path: string) => {
    if (path === '/branches') return Promise.resolve([{ id: B1, name: 'Філія №1' }]);
    if (path === '/warehouses') {
      return Promise.resolve([
        { id: W_SIDE, name: 'Бічний', isMain: false, type: 'MAIN' },
        { id: W_MAIN, name: 'Основний', isMain: true, type: 'MAIN' },
        { id: W_THIRD, name: 'Третій', isMain: false, type: 'MAIN' },
        { id: W_HOTEL, name: 'Шинний готель', isMain: false, type: 'TIRE_HOTEL' },
      ]);
    }
    if (path.startsWith('/employees')) return Promise.resolve({ items: [] });
    if (path.startsWith('/vehicles')) return Promise.resolve([]);
    if (path.includes('/contracts')) return Promise.resolve({ items: [] });
    if (path === '/settings/organisation') return Promise.resolve({ vatMode: 'NONE' });
    if (path === '/settings/tax-rates') return Promise.resolve([]);
    if (path.startsWith('/goods/stock-totals')) return stockTotals(path);
    if (path.startsWith('/goods?')) {
      const q = new URL(path, 'http://x').searchParams.get('q') ?? '';
      return Promise.resolve({
        items: GOODS.filter(g => g.name.includes(q)).map(g => ({
          ...g,
          salePrice: 100,
          unit: 'шт',
        })),
      });
    }
    if (path === `/work-orders/${WO}/linked-documents`) {
      return Promise.resolve({ invoices: [], payments: [], calendarSlots: [], warranties: [] });
    }
    if (path === `/work-orders/${WO}?withDeleted=true`) {
      return Promise.resolve({
        id: WO,
        number: 'WO-029',
        status: 'DRAFT',
        branchId: B1,
        vehicleId: V1,
        counterpartyId: CP1,
        counterpartyName: 'Тест',
        contractId: null,
        liftId: null,
        description: '',
        priority: 'NORMAL',
        repairCategory: '',
        documentDate: '2026-10-21',
        plannedAt: null,
        dueDate: null,
        plannedHours: null,
        actualHours: null,
        lines: [],
        parts: savedParts,
      });
    }
    return Promise.resolve({ items: [] });
  });
}

async function openInputRow() {
  const user = userEvent.setup();
  renderWithQueryClient(<CreateWorkOrderModal open onClose={vi.fn()} workOrderId={WO} />);
  await screen.findByText('Натисніть «Додати» щоб додати товар');
  await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith('/settings/organisation'));
  const addButtons = screen.getAllByRole('button', { name: 'Додати' });
  await user.click(addButtons[addButtons.length - 1]!);
  const row = screen.getByTitle('Зберегти рядок').closest('tr')!;
  return { user, row: row as HTMLElement };
}

async function pickGood(user: ReturnType<typeof userEvent.setup>, row: HTMLElement, name: string) {
  const box = within(row).getByRole('combobox', { name: 'Товар' });
  await user.type(box, name.slice(0, 8));
  await user.click(await screen.findByRole('option', { name: new RegExp(name) }));
}

const warehouseSelect = (row: HTMLElement) =>
  within(row).getByRole('combobox', { name: 'Склад' }) as HTMLSelectElement;

describe('CreateWorkOrderModal — склад рядка товару (BR-WO-029)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    stockGate = null;
    stockFail = false;
    mockApi();
  });

  // guards: BR-WO-029
  it('підписи опцій: без товару — лише назва; з товаром — назва і ВІЛЬНА кількість', async () => {
    const { user, row } = await openInputRow();
    const optionTexts = () =>
      Array.from(warehouseSelect(row).options)
        .slice(1)
        .map(o => o.textContent);
    expect(optionTexts()).toEqual(['Бічний', 'Основний', 'Третій']);

    await pickGood(user, row, 'Фільтр лише на бічному');
    // Основний: 5 на складі, 5 у резерві → вільна 0, не 5; «Шинного готелю» в переліку немає.
    await waitFor(() =>
      expect(optionTexts()).toEqual(['Бічний — 3', 'Основний — 0', 'Третій — 0']),
    );
  });

  // guards: BR-WO-029
  it.each([
    ['вільна лише на одному (неосновному) → він', 'Фільтр лише на бічному', W_SIDE],
    ['вільна на кількох, зокрема на основному → основний', 'Олива на основному й бічному', W_MAIN],
    ['вільна на кількох, але не на основному → порожньо', 'Свічка не на основному', ''],
    ['вільної немає ніде → основний', 'Ремінь без залишку', W_MAIN],
  ])('%s', async (_name, good, expected) => {
    const { user, row } = await openInputRow();
    await pickGood(user, row, good);
    await waitFor(() =>
      expect(
        apiFetchMock.mock.calls.some(
          ([p]) => typeof p === 'string' && p.startsWith('/goods/stock-totals'),
        ),
      ).toBe(true),
    );
    await waitFor(() => expect(warehouseSelect(row).value).toBe(expected));
    // «+» доступний лише коли склад є: третій пункт лишає вибір людині.
    expect(within(row).getByTitle('Зберегти рядок')).toHaveProperty('disabled', expected === '');
  });

  // guards: BR-WO-029
  it('ручний вибір складу до відповіді залишків не перезаписується автовибором', async () => {
    let release!: () => void;
    stockGate = new Promise<void>(r => (release = r));
    const { user, row } = await openInputRow();
    await pickGood(user, row, 'Фільтр лише на бічному');
    await user.selectOptions(warehouseSelect(row), W_THIRD);
    release();
    await waitFor(() =>
      expect(Array.from(warehouseSelect(row).options).map(o => o.textContent)).toContain(
        'Третій — 0',
      ),
    );
    // Відповідь прийшла й підписи оновлено — даємо ефекту автовибору шанс спрацювати.
    await new Promise(r => setTimeout(r, 50));
    expect(warehouseSelect(row).value).toBe(W_THIRD);
  });

  // guards: BR-WO-029
  it('ручний вибір після автовибору лишається; нова зміна товару підбирає склад знову', async () => {
    const { user, row } = await openInputRow();
    await pickGood(user, row, 'Фільтр лише на бічному');
    await waitFor(() => expect(warehouseSelect(row).value).toBe(W_SIDE));
    await user.selectOptions(warehouseSelect(row), W_THIRD);
    await new Promise(r => setTimeout(r, 50));
    expect(warehouseSelect(row).value).toBe(W_THIRD);

    await user.click(within(row).getByRole('button', { name: 'Очистити' }));
    await pickGood(user, row, 'Олива на основному й бічному');
    await waitFor(() => expect(warehouseSelect(row).value).toBe(W_MAIN));
  });

  // guards: BR-WO-029
  it('залишки не отримано (запит упав) → склад основний, підписи без кількості', async () => {
    stockFail = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { user, row } = await openInputRow();
    await pickGood(user, row, 'Фільтр лише на бічному');
    // Без запасного шляху поле лишалось порожнім назавжди, і «+» рядка — недоступним.
    await waitFor(() => expect(warehouseSelect(row).value).toBe(W_MAIN));
    expect(
      Array.from(warehouseSelect(row).options)
        .slice(1)
        .map(o => o.textContent),
    ).toEqual(['Бічний', 'Основний', 'Третій']);
    expect(within(row).getByTitle('Зберегти рядок')).toHaveProperty('disabled', false);
  });

  // guards: BR-WO-029, BR-WO-021
  it('збережений рядок: склад не змінюється й лишається лише для читання', async () => {
    apiFetchMock.mockReset();
    mockApi([
      {
        id: P_SAVED,
        goodId: G_SAVED,
        goodName: 'Збережений товар',
        warehouseId: W_THIRD,
        quantity: 1,
        price: 10,
      },
    ]);
    const user = userEvent.setup();
    renderWithQueryClient(<CreateWorkOrderModal open onClose={vi.fn()} workOrderId={WO} />);
    const name = await screen.findByText('Збережений товар');
    // «На складі» — фізична кількість (0 на «Третьому» / 6 усього), не вільна.
    await waitFor(() => expect(name.closest('tr')!.textContent).toContain('0/6'));
    expect(name.closest('tr')!.textContent).toContain('Третій');

    await user.click(screen.getByRole('button', { name: 'Редагувати товар' }));
    const row = screen.getByTitle('Зберегти').closest('tr')!;
    expect(within(row).getByTestId('part-warehouse-readonly')).toHaveTextContent('Третій');
    expect(within(row).queryByRole('combobox', { name: 'Склад' })).not.toBeInTheDocument();
  });
});
