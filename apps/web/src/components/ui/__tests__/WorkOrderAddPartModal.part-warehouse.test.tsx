import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import { WorkOrderAddPartModal } from '../WorkOrderAddPartModal';

/**
 * BR-WO-029 у вікні «+ Запчастина» сторінки наряду: біля складу — вільна кількість обраного товару
 * (`GET /goods/stock-totals`, не `/stock-items`: той віддає масив, а механіку — 403), склад
 * підставляється сам, ручний вибір не перезаписується. Нестача вільного залишку «Додати» не блокує
 * (BR-WO-021, рішення власника 2026-10-22) — індикатор лише попереджає.
 *
 * Mutation-verify (2026-10-22): прибрати `pickPartWarehouse` з ефекту вікна → падають кейси
 * автовибору; не знімати очікування при ручному виборі → падає «ручний вибір»; повернути
 * блокування «Додати» за залишком → падає «нестача не блокує».
 */

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

vi.mock('@/hooks/useUiFeatures', () => ({
  useUiFeatures: () => ({
    toastEnabled: false,
    unsavedGuardEnabled: false,
    stockIndicatorEnabled: true,
    keyboardShortcutsEnabled: false,
  }),
}));

// Картка товару (вкладене вікно) тут не предмет тесту.
vi.mock('@/components/ui/GoodEditModal', () => ({ GoodEditModal: () => null }));

const W_MAIN = 'wh-main';
const W_SIDE = 'wh-side';
const W_THIRD = 'wh-third';
const W_HOTEL = 'wh-hotel';
const WAREHOUSES = [
  { id: W_MAIN, name: 'Основний', isMain: true, type: 'MAIN' },
  { id: W_SIDE, name: 'Бічний', isMain: false, type: 'MAIN' },
  { id: W_THIRD, name: 'Третій', isMain: false, type: 'MAIN' },
  { id: W_HOTEL, name: 'Шинний готель', isMain: false, type: 'TIRE_HOTEL' },
];

const GOODS = [
  { id: 'g-side', name: 'Фільтр лише на бічному' },
  { id: 'g-main', name: 'Олива на основному й бічному' },
  { id: 'g-notmain', name: 'Свічка не на основному' },
  { id: 'g-none', name: 'Ремінь без залишку' },
];

const wh = (warehouseId: string, quantity: number, reserved = 0) => ({
  warehouseId,
  quantity,
  reserved,
  available: Math.max(0, quantity - reserved),
});

const STOCK: Record<string, ReturnType<typeof wh>[]> = {
  'g-side': [wh(W_MAIN, 5, 5), wh(W_SIDE, 3)],
  'g-main': [wh(W_MAIN, 2), wh(W_SIDE, 9)],
  'g-notmain': [wh(W_SIDE, 1), wh(W_THIRD, 4), wh(W_HOTEL, 40)],
};

let stockGate: Promise<void> | null = null;

function mockApi() {
  apiFetchMock.mockImplementation((path: string, init?: { method?: string }) => {
    if (init?.method === 'POST') return Promise.resolve({ id: 'part-1' });
    if (path.startsWith('/goods?q=')) {
      const q = decodeURIComponent(new URL(path, 'http://x').searchParams.get('q') ?? '');
      return Promise.resolve({
        items: GOODS.filter(g => g.name.includes(q)).map(g => ({
          ...g,
          salePrice: 100,
          unit: 'шт',
        })),
      });
    }
    if (path.startsWith('/goods/stock-totals')) {
      const id = new URL(path, 'http://x').searchParams.get('ids')!;
      const rows = STOCK[id] ? [{ goodId: id, totalQuantity: 0, byWarehouse: STOCK[id] }] : [];
      return stockGate ? stockGate.then(() => rows) : Promise.resolve(rows);
    }
    if (path.endsWith('/uoms')) return Promise.resolve([]);
    return Promise.resolve({ items: [] });
  });
}

function renderModal() {
  const user = userEvent.setup();
  render(
    <WorkOrderAddPartModal
      open
      workOrderId="wo1"
      warehouses={WAREHOUSES}
      initialWarehouseId={W_MAIN}
      onClose={vi.fn()}
      onAdded={vi.fn()}
    />,
  );
  return user;
}

async function pickGood(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.type(screen.getByPlaceholderText('Назва, артикул, штрих-код...'), name.slice(0, 8));
  await user.click(await screen.findByRole('option', { name: new RegExp(name) }));
}

const select = () => screen.getByRole('combobox', { name: 'Склад' }) as HTMLSelectElement;
const optionTexts = () =>
  Array.from(select().options)
    .slice(1)
    .map(o => o.textContent);

describe('WorkOrderAddPartModal — склад запчастини (BR-WO-029)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    stockGate = null;
    mockApi();
  });

  // guards: BR-WO-029
  it('до вибору товару — склад із initialWarehouseId, підписи лише назви, без «Шинного готелю»', () => {
    renderModal();
    expect(select().value).toBe(W_MAIN);
    expect(optionTexts()).toEqual(['Основний', 'Бічний', 'Третій']);
  });

  // guards: BR-WO-029
  it.each([
    ['вільна лише на одному (неосновному) → він', 'Фільтр лише на бічному', W_SIDE],
    ['на кількох, зокрема на основному → основний', 'Олива на основному й бічному', W_MAIN],
    ['на кількох, але не на основному → порожньо', 'Свічка не на основному', ''],
    ['вільної немає ніде → основний', 'Ремінь без залишку', W_MAIN],
  ])('%s', async (_name, good, expected) => {
    const user = renderModal();
    await pickGood(user, good);
    await waitFor(() => expect(optionTexts()[0]).toMatch(/^Основний — /));
    await waitFor(() => expect(select().value).toBe(expected));
  });

  // guards: BR-WO-029
  it('підписи — вільна кількість; індикатор — вільна на обраному складі; /stock-items не кличеться', async () => {
    const user = renderModal();
    await pickGood(user, 'Фільтр лише на бічному');
    await waitFor(() =>
      expect(optionTexts()).toEqual(['Основний — 0', 'Бічний — 3', 'Третій — 0']),
    );
    expect(screen.getByTestId('part-stock-indicator')).toHaveTextContent('Вільно: 3 шт');

    await user.selectOptions(select(), W_MAIN);
    expect(screen.getByTestId('part-stock-indicator')).toHaveTextContent('Вільного залишку немає');
    const paths = apiFetchMock.mock.calls.map(c => String(c[0]));
    expect(paths).toContain('/goods/stock-totals?ids=g-side');
    expect(paths.some(p => p.startsWith('/stock-items'))).toBe(false);
  });

  // guards: BR-WO-029
  it('ручний вибір складу до відповіді залишків не перезаписується автовибором', async () => {
    let release!: () => void;
    stockGate = new Promise<void>(r => (release = r));
    const user = renderModal();
    await pickGood(user, 'Фільтр лише на бічному');
    await user.selectOptions(select(), W_THIRD);
    release();
    await waitFor(() => expect(optionTexts()).toContain('Третій — 0'));
    await new Promise(r => setTimeout(r, 50));
    expect(select().value).toBe(W_THIRD);
  });

  // guards: BR-WO-029, BR-WO-021
  it('нестача вільного залишку не блокує «Додати»: кількість 10 при вільних 3 — POST іде', async () => {
    const user = renderModal();
    await pickGood(user, 'Фільтр лише на бічному');
    await waitFor(() => expect(select().value).toBe(W_SIDE));
    const qty = screen.getByDisplayValue('1');
    await user.clear(qty);
    await user.type(qty, '10');

    const add = screen.getByRole('button', { name: 'Додати' });
    expect(add).toBeEnabled();
    await user.click(add);
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith(
        '/work-orders/wo1/parts',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    const post = apiFetchMock.mock.calls.find(c => c[0] === '/work-orders/wo1/parts')!;
    expect(JSON.parse((post[1] as { body: string }).body)).toMatchObject({
      goodId: 'g-side',
      warehouseId: W_SIDE,
      quantity: 10,
    });
  });
});
