// Regression-guard для SupplierReturnCreateModal.
//
// Bug guarded (audit 2026-09-05, family Bug #630 / WEB-H3):
//   Модалка НЕ мала синхронного savingRef/transitioningRef — на відміну від
//   Invoice/PO/Stock/WorkOrder. `disabled={saving}` спирається на re-render React
//   МІЖ подіями кліку; два click-и в одному tick обидва входять до застосування
//   disabled → 2 POST /supplier-returns або подвійний confirm. Тепер ref фліпається
//   синхронно у setSavingBoth/setTransitioningBoth → другий вхід одразу повертається.

import { render, screen, waitFor, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, it, expect, describe, beforeEach } from 'vitest';

import { SupplierReturnCreateModal } from '../SupplierReturnCreateModal';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

vi.mock('@/lib/ref-cache', () => ({
  getCached: () => null,
  setCache: vi.fn(),
}));

vi.mock('@/hooks/useUiFeatures', () => ({
  useUiFeatures: () => ({ toastEnabled: false }),
}));

vi.mock('@/lib/format', async () => ({
  ...(await vi.importActual<typeof import('@/lib/format')>('@/lib/format')),
  kyivToday: () => '2026-09-05',
}));

const mockWarehouses = [{ id: 'w1', name: 'Склад №1' }];
const mockReturn = {
  id: 'sr1',
  number: 'ПОВ-1',
  status: 'DRAFT',
  supplierId: 'sup1',
  supplierName: 'ТОВ Постач',
  warehouseId: 'w1',
  notes: '',
  documentDate: '2026-09-05',
  lines: [
    {
      id: 'l1',
      goodId: 'g1',
      goodName: 'Фільтр',
      goodSku: 'F-1',
      unit: 'шт',
      unitShortName: 'шт',
      unitOfMeasureId: 'u1',
      quantity: 2,
      price: 100,
    },
  ],
};

describe('SupplierReturnCreateModal — double-submit guard (Bug #630 / WEB-H3)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it('подвійний клік «Підтвердити» шле POST /confirm лише один раз', async () => {
    let resolveConfirm: (v: unknown) => void = () => {};
    apiFetchMock.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/warehouses') return Promise.resolve(mockWarehouses);
      if (
        path === '/supplier-returns/sr1?withDeleted=true' &&
        (!init || init.method === undefined)
      ) {
        return Promise.resolve(mockReturn);
      }
      if (path === '/supplier-returns/sr1/confirm' && init?.method === 'POST') {
        return new Promise(resolve => {
          resolveConfirm = resolve;
        });
      }
      return Promise.resolve({ items: [] });
    });

    render(<SupplierReturnCreateModal open onClose={() => {}} onSaved={() => {}} editId="sr1" />);

    // Дочекатись завантаження документа (кнопка «Підтвердити» зʼявляється лише коли lines>0).
    const confirmBtn = (await screen.findByRole('button', {
      name: 'Підтвердити',
    })) as HTMLButtonElement;

    // Два синхронних native-кліки в ОДНОМУ tick через HTMLElement.click().
    // ⚠️ НЕ userEvent.click: userEvent проганяє власну pointer-event чергу з мікротасками
    // → React встигає re-renderнути й виставити disabled={transitioning} МІЖ кліками →
    // тест був би хибно-зеленим (проходив би і БЕЗ savingRef-guard). Native .click() ×2 у
    // одному синхронному блоці: React batch-ить state → re-render лише ПІСЛЯ обох → саме
    // transitioningRef (синхронний) блокує другий вхід у doTransition. Відтворює реальну race.
    confirmBtn.click();
    confirmBtn.click();

    // Дати мікротаскам відпрацювати.
    await waitFor(() => {
      const confirmCalls = apiFetchMock.mock.calls.filter(
        c => c[0] === '/supplier-returns/sr1/confirm',
      );
      expect(confirmCalls.length).toBe(1);
    });

    await act(async () => {
      resolveConfirm({});
    });
  });
});

// BR-PO-008 (рішення власника 2026-10-13): той самий товар можна повернути кількома рядками.
// Раніше addLine мовчки відкидав повтор («+» нічого не робив), а сервер зливав рядки з однаковим
// товаром — перший зникав разом зі своєю кількістю.
//
// Що ловить (мутацію не проганяв): повернути `if (existing.some(l => l.goodId === newLine.goodId)) return;`
// у addLine → кейс падає (рядок лишається один, у PATCH іде один рядок).
describe('SupplierReturnCreateModal — повтор товару окремим рядком', () => {
  // Збереження проходить zod-схему форми — ідентифікатори мають бути справжніми UUID.
  const G1 = '30000000-0000-4000-8000-000000000001';
  const W1 = '30000000-0000-4000-8000-000000000002';
  const SUP = '30000000-0000-4000-8000-000000000003';
  const U1 = '30000000-0000-4000-8000-000000000004';
  const draft = {
    ...mockReturn,
    supplierId: SUP,
    warehouseId: W1,
    lines: [{ ...mockReturn.lines[0], goodId: G1, unitOfMeasureId: U1 }],
  };

  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it('той самий товар додається другим рядком і йде у збереження двома рядками, у тому ж порядку', async () => {
    apiFetchMock.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/warehouses') return Promise.resolve([{ id: W1, name: 'Склад №1' }]);
      if (path === '/supplier-returns/sr1?withDeleted=true') return Promise.resolve(draft);
      if (path.startsWith('/goods?')) {
        return Promise.resolve({
          items: [{ id: G1, name: 'Фільтр', sku: 'F-1', unit: 'шт', purchasePrice: 90 }],
        });
      }
      if (path === '/supplier-returns/sr1' && init?.method === 'PATCH') return Promise.resolve({});
      return Promise.resolve({ items: [] });
    });
    const user = userEvent.setup();
    render(<SupplierReturnCreateModal open onClose={() => {}} onSaved={() => {}} editId="sr1" />);
    await screen.findByText('Фільтр');

    // Відкриваємо рядок введення і вибираємо ТОЙ САМИЙ товар, що вже є в документі.
    await user.click(screen.getByRole('button', { name: 'Додати' }));
    const table = screen.getByRole('table');
    await user.click(within(table).getByRole('button', { name: 'Обрати' }));
    await screen.findByText('Оберіть товар');
    // У списку підбору той самий товар: у таблиці він уже є, тож шукаємо другий напис.
    await waitFor(() => expect(screen.getAllByText('Фільтр').length).toBeGreaterThan(1));
    const inPicker = screen.getAllByText('Фільтр').find(el => !table.contains(el))!;
    await user.click(inPicker);
    await user.click(screen.getByTitle('Додати рядок'));

    // У таблиці два рядки одного товару; сума — обох: 2 × 100 + 1 × 90.
    await waitFor(() => expect(within(table).getAllByText('Фільтр')).toHaveLength(2));
    expect(table).toHaveTextContent('290.00');

    await user.click(screen.getByRole('button', { name: 'Зберегти зміни' }));

    await waitFor(() =>
      expect(
        apiFetchMock.mock.calls.some(
          ([p, init]) => p === '/supplier-returns/sr1' && init?.method === 'PATCH',
        ),
      ).toBe(true),
    );
    const patch = apiFetchMock.mock.calls.find(
      ([p, init]) => p === '/supplier-returns/sr1' && init?.method === 'PATCH',
    )!;
    const body = JSON.parse((patch[1] as RequestInit).body as string) as {
      lines: { goodId: string; quantity: number; price: number }[];
    };
    expect(body.lines.map(l => [l.goodId, Number(l.quantity), Number(l.price)])).toEqual([
      [G1, 2, 100],
      [G1, 1, 90],
    ]);
  });
  // Bug #845: кнопка видалення рядка була іконкою без назви. З повторами товару (BR-PO-008) у
  // документі кілька однакових на вигляд рядків — читач екрана називав усі кнопки просто «кнопка».
  // Тут же: видалення ОДНОГО з повторів прибирає саме його, решта йде у збереження в тому ж порядку.
  it('у кожного рядка кнопка видалення має назву; видалення одного з повторів прибирає саме його', async () => {
    const threeLines = {
      ...draft,
      lines: [
        { ...draft.lines[0], id: 'l1', quantity: 2, price: 100 },
        { ...draft.lines[0], id: 'l2', quantity: 3, price: 90 },
        { ...draft.lines[0], id: 'l3', quantity: 4, price: 80 },
      ],
    };
    apiFetchMock.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/warehouses') return Promise.resolve([{ id: W1, name: 'Склад №1' }]);
      if (path === '/supplier-returns/sr1?withDeleted=true') return Promise.resolve(threeLines);
      if (path === '/supplier-returns/sr1' && init?.method === 'PATCH') return Promise.resolve({});
      return Promise.resolve({ items: [] });
    });
    const user = userEvent.setup();
    render(<SupplierReturnCreateModal open onClose={() => {}} onSaved={() => {}} editId="sr1" />);
    const table = await screen.findByRole('table');
    await waitFor(() => expect(within(table).getAllByText('Фільтр')).toHaveLength(3));

    expect(
      within(table)
        .getAllByRole('button', { name: /^Видалити рядок \d+$/ })
        .map(b => b.getAttribute('aria-label')),
    ).toEqual(['Видалити рядок 1', 'Видалити рядок 2', 'Видалити рядок 3']);

    await user.click(within(table).getByRole('button', { name: 'Видалити рядок 2' }));
    await waitFor(() => expect(within(table).getAllByText('Фільтр')).toHaveLength(2));
    await user.click(screen.getByRole('button', { name: 'Зберегти зміни' }));

    await waitFor(() =>
      expect(
        apiFetchMock.mock.calls.some(
          ([p, init]) => p === '/supplier-returns/sr1' && init?.method === 'PATCH',
        ),
      ).toBe(true),
    );
    const patch = apiFetchMock.mock.calls.find(
      ([p, init]) => p === '/supplier-returns/sr1' && init?.method === 'PATCH',
    )!;
    const body = JSON.parse((patch[1] as RequestInit).body as string) as {
      lines: { goodId: string; quantity: number; price: number }[];
    };
    expect(body.lines.map(l => [l.goodId, Number(l.quantity), Number(l.price)])).toEqual([
      [G1, 2, 100],
      [G1, 4, 80],
    ]);
  });

  // Сума рядка = round(кількість × ціна), підсумок = Σ округлених рядків - як на сервері
  // (`money(quantity * price)`). Сирий добуток показував 30.01 там, де збережено 30.02.
  // Мутація (не проганяв): lineSubtotal без lineAmount -> кейс падає (рядок "30.01").
  it('сума рядка і підсумок округлюються по рядках, як на сервері', async () => {
    const rounding = {
      ...draft,
      lines: [
        { ...draft.lines[0], quantity: 0.3, price: 100.05 },
        { ...draft.lines[0], quantity: 0.3, price: 100.05 },
      ],
    };
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/warehouses') return Promise.resolve([{ id: W1, name: 'Склад №1' }]);
      if (path === '/supplier-returns/sr1?withDeleted=true') return Promise.resolve(rounding);
      return Promise.resolve({ items: [] });
    });
    render(<SupplierReturnCreateModal open onClose={() => {}} onSaved={() => {}} editId="sr1" />);
    await screen.findAllByText('Фільтр');
    const table = screen.getByRole('table');
    expect(within(table).getAllByText('30.02')).toHaveLength(2);
    expect(table).toHaveTextContent('60.04');
  });
});
