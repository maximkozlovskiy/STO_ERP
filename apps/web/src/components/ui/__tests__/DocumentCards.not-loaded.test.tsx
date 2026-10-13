// Bug #844: картка документа до відповіді сервера (і назавжди — якщо завантаження не вдалось)
// показувала типову «чернетку» з усіма діями. «Підтвердити» / «Замовлено» / «Скасувати» слали
// перехід статусу в документ, якого користувач у картці не бачив (номер у запиті підтвердження
// порожній), а «Зберегти зміни» стояла поруч із текстом помилки завантаження.
//
// Для чотирьох карток (складський документ, замовлення постачальнику, рахунок, наряд):
//   - поки відповіді немає — жодної дії, що змінює документ;
//   - завантаження не вдалось — помилку видно, дій так само немає;
//   - контроль: після успішної відповіді дії з'являються (інакше кейси вище зелені завжди).
// У поверненні постачальнику те саме тримає `DeletedDocumentCards.test.tsx` (прапорець notLoaded).
//
// Мутація (перевірено для кожної картки): `const viewOnly = isDeleted;` без `|| notLoaded` →
// падають обидва її кейси.

import { render, screen, waitFor, act } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';

import { CreateWorkOrderModal } from '../CreateWorkOrderModal';
import { InvoiceCreateModal } from '../InvoiceCreateModal';
import { PurchaseOrderCreateModal } from '../PurchaseOrderCreateModal';
import { StockDocumentCreateModal } from '../StockDocumentCreateModal';
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

type Doc = Record<string, unknown>;

interface Deferred {
  resolve: (doc: Doc) => void;
  reject: (e: Error) => void;
}

/** Довідники відповідають одразу; документ `docPath` — коли тест вирішить. */
function mockApiWithDeferredDoc(docPath: string): Deferred {
  const deferred: Deferred = { resolve: () => {}, reject: () => {} };
  const pending = new Promise<Doc>((resolve, reject) => {
    deferred.resolve = resolve;
    deferred.reject = reject;
  });
  // Відмову ловить картка; цей обробник лише прибирає «unhandled rejection» для самого проміса.
  pending.catch(() => undefined);
  apiFetchMock.mockImplementation((path: string) => {
    if (path === docPath) return pending;
    if (path === '/branches') return Promise.resolve([{ id: 'b1', name: 'Філія №1' }]);
    if (path === '/warehouses') {
      return Promise.resolve([{ id: 'w1', name: 'Склад №1', deletedAt: null }]);
    }
    if (path.startsWith('/employees')) {
      return Promise.resolve({ items: [{ id: 'e1', firstName: 'Іван', lastName: 'Петров' }] });
    }
    if (path.startsWith('/vehicles')) return Promise.resolve([]);
    if (path === '/settings/organisation') {
      return Promise.resolve({ vatMode: 'NONE', defaultVatRateId: null });
    }
    if (path === '/settings/tax-rates') return Promise.resolve([]);
    if (path.endsWith('/linked-documents')) {
      return Promise.resolve({ invoices: [], payments: [], calendarSlots: [], warranties: [] });
    }
    return Promise.resolve({ items: [] });
  });
  return deferred;
}

const button = (name: string | RegExp) => screen.queryByRole('button', { name });

function expectNoActions(names: (string | RegExp)[], when: string) {
  for (const name of names) {
    expect(button(name), `${when}: кнопки «${String(name)}» бути не має`).not.toBeInTheDocument();
  }
}

const writes = () =>
  apiFetchMock.mock.calls.filter(([, init]) => {
    const method = (init as { method?: string } | undefined)?.method;
    return method !== undefined && method !== 'GET';
  });

beforeEach(() => {
  apiFetchMock.mockReset();
});

interface CardCase {
  title: string;
  docPath: string;
  render: () => void;
  /** Дії, що змінюють документ у статусі «чернетка» (або йдуть на сервер по цей документ). */
  actions: (string | RegExp)[];
  doc: Doc;
  /** Текст рядка документа — ознака, що успішна відповідь дійшла до форми. */
  lineText: string;
}

const CASES: CardCase[] = [
  {
    title: 'складський документ',
    docPath: '/stock-documents/sd-1?withDeleted=true',
    render: () => {
      render(<StockDocumentCreateModal open stockDocumentId="sd-1" onClose={vi.fn()} />);
    },
    actions: ['Зберегти зміни', 'Підтвердити', 'Скасувати', 'Додати', 'тест-імпорт-xlsx'],
    doc: {
      id: 'sd-1',
      number: 'ПРХ-000001',
      status: 'DRAFT',
      type: 'RECEIPT',
      branchId: 'b1',
      warehouseId: 'w1',
      documentDate: '2026-10-13',
      deletedAt: null,
      lines: [{ id: 'l1', goodId: 'g1', goodName: 'Фільтр', quantity: 1, price: 10 }],
    },
    lineText: 'Фільтр',
  },
  {
    title: 'замовлення постачальнику',
    docPath: '/purchase-orders/po-1?withDeleted=true',
    render: () => {
      renderWithQueryClient(
        <PurchaseOrderCreateModal open purchaseOrderId="po-1" onClose={vi.fn()} />,
      );
    },
    actions: ['Зберегти зміни', 'Скасувати', /Оплатити/, 'Додати', 'тест-імпорт-xlsx'],
    doc: {
      id: 'po-1',
      number: 'ЗАМ-000001',
      status: 'DRAFT',
      supplierId: 's1',
      supplierName: 'Постачальник',
      warehouseId: 'w1',
      documentDate: '2026-10-13',
      totalAmount: 10,
      deletedAt: null,
      lines: [
        { id: 'l1', goodId: 'g1', goodName: 'Фільтр', quantity: 1, price: 10, receivedQty: 0 },
      ],
    },
    lineText: 'Фільтр',
  },
  {
    title: 'рахунок',
    docPath: '/invoices/inv-1?withDeleted=true',
    render: () => {
      render(<InvoiceCreateModal open invoiceId="inv-1" onClose={vi.fn()} />);
    },
    actions: ['Зберегти зміни', 'Скасувати', /Додати/],
    doc: {
      id: 'inv-1',
      number: 'РАХ-0001',
      status: 'DRAFT',
      invoiceType: 'STANDARD',
      counterpartyId: 'cp-1',
      counterpartyName: 'Клієнт',
      amount: 100,
      paidAmount: 0,
      dueDate: null,
      documentDate: '2026-10-13T00:00:00.000Z',
      notes: null,
      deletedAt: null,
      lines: [
        {
          id: 'line-A',
          description: 'Робота 1',
          quantity: 1,
          unitPrice: 100,
          vatRate: 0,
          priceWithVat: 100,
        },
      ],
    },
    lineText: 'Робота 1',
  },
  {
    title: 'наряд',
    docPath: '/work-orders/wo-1?withDeleted=true',
    render: () => {
      render(<CreateWorkOrderModal open onClose={vi.fn()} workOrderId="wo-1" />);
    },
    actions: ['Зберегти зміни', 'Скасувати', /Поділитись/, 'Друк'],
    doc: {
      id: 'wo-1',
      number: 'WO-001',
      status: 'DRAFT',
      branchId: 'b1',
      vehicleId: 'v1',
      counterpartyId: 'cp1',
      counterpartyName: 'Тест',
      contractId: null,
      liftId: null,
      description: '',
      priority: 'NORMAL',
      repairCategory: '',
      documentDate: '2026-10-08',
      plannedAt: null,
      dueDate: null,
      plannedHours: 2,
      actualHours: null,
      deletedAt: null,
      lines: [
        {
          id: 'l1',
          workId: 'work-1',
          workName: 'Заміна колодок',
          employeeId: 'e1',
          normoHours: 2,
          actualHours: null,
          price: 500,
        },
      ],
      parts: [],
    },
    lineText: 'Заміна колодок',
  },
];

describe.each(CASES)('Картка до завантаження документа — $title', c => {
  it('поки відповіді немає — дій немає; після відповіді дії на місці', async () => {
    const deferred = mockApiWithDeferredDoc(c.docPath);
    c.render();
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith(c.docPath));
    // Довідники вже прийшли, документа ще немає.
    await act(async () => {
      await Promise.resolve();
    });

    expectNoActions(c.actions, 'до відповіді сервера');

    await act(async () => {
      deferred.resolve(c.doc);
    });
    expect(await screen.findByText(c.lineText, undefined, { timeout: 2000 })).toBeInTheDocument();
    // Контроль: у завантаженій чернетці збереження на місці.
    await waitFor(() => expect(button('Зберегти зміни')).toBeInTheDocument());
  });

  it('завантаження не вдалось — помилку видно, дій немає, запитів на зміну немає', async () => {
    const deferred = mockApiWithDeferredDoc(c.docPath);
    c.render();
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith(c.docPath));

    await act(async () => {
      deferred.reject(new Error('Сервер недоступний'));
    });

    expect(await screen.findByText('Сервер недоступний')).toBeInTheDocument();
    expectNoActions(c.actions, 'після помилки завантаження');
    // Закрити картку можна.
    expect(screen.getAllByRole('button', { name: 'Закрити' }).length).toBeGreaterThan(0);
    expect(writes()).toEqual([]);
  });
});
