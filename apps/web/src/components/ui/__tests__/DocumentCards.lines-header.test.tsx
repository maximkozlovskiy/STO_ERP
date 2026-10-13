// Стандарт шапки табличної частини картки документа (рішення власника 2026-10-14): «+ Додати»
// стоїть НАД таблицею рядків, а порожня таблиця показує ту саму підказку в усіх картках.
// Компонентні тести карток перевіряли лише, що кнопка Є і що її немає в режимі перегляду —
// кнопку можна було повернути під таблицю, і жоден тест цього не помічав.
//
// Мутації (перевірено): перенести <DocLinesHeader> під </table> в одній картці → її кейс
// «над таблицею» падає; прибрати <DocLinesEmptyRow> з картки → її кейс падає на підказці;
// у DocLinesHeader поміняти місцями {children} і кнопку → кейс про порядок дій падає.

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, it, expect, describe, beforeEach } from 'vitest';

import { InvoiceCreateModal } from '../InvoiceCreateModal';
import { PurchaseOrderCreateModal } from '../PurchaseOrderCreateModal';
import { StockDocumentCreateModal } from '../StockDocumentCreateModal';
import { SupplierReturnCreateModal } from '../SupplierReturnCreateModal';
import { DocLinesHeader, DocLinesEmptyRow } from '../doc-lines-header';
import { renderWithQueryClient } from '../../../__tests__/query-utils';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
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
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ employee: { role: 'OWNER' } }),
}));

vi.mock('@/lib/ref-cache', () => ({
  getCached: () => null,
  setCache: vi.fn(),
}));

vi.mock('@/hooks/api/useCash', () => ({
  useBaseCurrency: () => ({ data: { code: 'UAH', symbol: '₴' } }),
}));

vi.mock('@/components/ui/xlsx-import-button', () => ({
  XlsxImportButton: () => <button type="button">тест-імпорт-xlsx</button>,
}));
vi.mock('@/components/ui/ExcelImportWizard', () => ({
  ExcelImportWizard: () => null,
}));

const HINT = 'Натисніть «Додати» для початку';

beforeEach(() => {
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation((path: string) => {
    if (path === '/branches') return Promise.resolve([{ id: 'b1', name: 'Філія №1' }]);
    if (path === '/warehouses') {
      return Promise.resolve([{ id: 'w1', name: 'Склад №1', deletedAt: null }]);
    }
    if (path === '/settings/organisation') {
      return Promise.resolve({ vatMode: 'NONE', defaultVatRateId: null });
    }
    if (path === '/settings/tax-rates') return Promise.resolve([]);
    return Promise.resolve({ items: [] });
  });
});

const CARDS = [
  {
    title: 'рахунок',
    renderCard: () => render(<InvoiceCreateModal open onClose={vi.fn()} />),
  },
  {
    title: 'складський документ',
    renderCard: () => render(<StockDocumentCreateModal open onClose={vi.fn()} />),
  },
  {
    title: 'замовлення постачальнику',
    renderCard: () => renderWithQueryClient(<PurchaseOrderCreateModal open onClose={vi.fn()} />),
  },
  {
    title: 'повернення постачальнику',
    renderCard: () =>
      render(<SupplierReturnCreateModal open onClose={vi.fn()} onSaved={vi.fn()} />),
  },
];

describe.each(CARDS)('Таблична частина нової картки — $title', ({ renderCard }) => {
  it('«Додати» стоїть над таблицею рядків, порожня таблиця показує підказку', async () => {
    renderCard();

    const hint = await screen.findByText(HINT, undefined, { timeout: 2000 });
    const table = hint.closest('table');
    expect(table).not.toBeNull();
    const add = screen.getByRole('button', { name: 'Додати' });

    // Кнопка — раніше за таблицю в DOM (тобто над нею), а не всередині й не після неї.
    expect(table!.contains(add)).toBe(false);
    expect(add.compareDocumentPosition(table!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("після «Додати» з'являється рядок вводу: підказки й самої кнопки вже немає", async () => {
    renderCard();
    const add = await screen.findByRole('button', { name: 'Додати' }, { timeout: 2000 });

    await userEvent.click(add);

    expect(screen.queryByText(HINT)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Додати' })).not.toBeInTheDocument();
  });
});

describe('DocLinesHeader', () => {
  it('порядок: назва, інші дії таблиці, «Додати» останньою праворуч', () => {
    render(
      <DocLinesHeader title="Товари" onAdd={vi.fn()}>
        <button type="button">Імпорт</button>
      </DocLinesHeader>,
    );

    const title = screen.getByText('Товари');
    const importBtn = screen.getByRole('button', { name: 'Імпорт' });
    const add = screen.getByRole('button', { name: 'Додати' });
    expect(
      title.compareDocumentPosition(importBtn) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(importBtn.compareDocumentPosition(add) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('без onAdd кнопки «Додати» немає, решта дій лишається', async () => {
    const onAdd = vi.fn();
    const { rerender } = render(
      <DocLinesHeader title="Товари">
        <button type="button">Імпорт</button>
      </DocLinesHeader>,
    );
    expect(screen.queryByRole('button', { name: 'Додати' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Імпорт' })).toBeInTheDocument();

    // Контроль: з onAdd кнопка є і кличе саме його.
    rerender(
      <DocLinesHeader title="Товари" onAdd={onAdd}>
        <button type="button">Імпорт</button>
      </DocLinesHeader>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Додати' }));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });
});

describe('DocLinesEmptyRow', () => {
  const renderRow = (canEdit: boolean) =>
    render(
      <table>
        <tbody>
          <DocLinesEmptyRow colSpan={4} canEdit={canEdit} />
        </tbody>
      </table>,
    );

  it('редагована картка кличе натиснути «Додати»; рядок займає всю ширину таблиці', () => {
    renderRow(true);
    const cell = within(screen.getByRole('table')).getByRole('cell');
    expect(cell).toHaveTextContent(HINT);
    expect(cell).toHaveAttribute('colspan', '4');
  });

  it('картка на перегляд не згадує кнопку, якої в ній немає', () => {
    renderRow(false);
    expect(screen.getByRole('cell')).toHaveTextContent('Рядки відсутні');
    expect(screen.queryByText(HINT)).not.toBeInTheDocument();
  });
});
