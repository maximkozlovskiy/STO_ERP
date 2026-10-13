// Документ, позначений на видалення, відкривається карткою ЛИШЕ на перегляд (рішення власника
// 2026-10-13). До цього «Відкрити документ» на видаленому рядку давав порожню картку «не знайдено»:
// картка вантажила документ без прапорця, сервер відповідав 404.
//
// Для кожної з п'яти карток:
//   - документ вантажиться з `?withDeleted=true`;
//   - з `deletedAt` — зверху смуга (role="status"), немає збереження, переходів статусу,
//     додавання рядків, імпорту, оплати, поширення; «Закрити» і «Друк» лишаються;
//   - без `deletedAt` — картка як раніше (збереження й переходи на місці, смуги немає).
//
// Що ловить (мутацію не проганяв): прибрати `&& !isDeleted` з `canEdit` будь-якої картки → падає її
// кейс «лише перегляд» (з'являється «Зберегти зміни»); прибрати `!isDeleted` з allowedTransitions →
// падає перевірка кнопок переходу.

import { render, screen, waitFor, within } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';

import { CreateWorkOrderModal } from '../CreateWorkOrderModal';
import { InvoiceCreateModal } from '../InvoiceCreateModal';
import { PurchaseOrderCreateModal } from '../PurchaseOrderCreateModal';
import { StockDocumentCreateModal } from '../StockDocumentCreateModal';
import { SupplierReturnCreateModal } from '../SupplierReturnCreateModal';
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

// Кнопка імпорту — маркер: у картці лише на перегляд її бути не має.
vi.mock('@/components/ui/xlsx-import-button', () => ({
  XlsxImportButton: () => <button type="button">тест-імпорт-xlsx</button>,
}));
vi.mock('@/components/ui/ExcelImportWizard', () => ({
  ExcelImportWizard: () => null,
}));

const DELETED_AT = '2026-10-13T09:00:00.000Z';
const BANNER = 'Документ позначено на видалення — лише перегляд';

type Doc = Record<string, unknown>;

/** Довідники, спільні для всіх карток; `docs` — відповіді на завантаження самих документів. */
function mockApi(docs: Record<string, Doc>) {
  apiFetchMock.mockImplementation((path: string) => {
    if (path in docs) return Promise.resolve(docs[path]);
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
}

const loadCalls = (prefix: string) =>
  apiFetchMock.mock.calls
    .filter(([p, init]) => typeof p === 'string' && p.startsWith(prefix) && !init?.method)
    .map(([p]) => p as string);

// Смугу шукаємо за testid: role="status" має ще й підказка поля-підбору.
const banner = () => screen.queryByTestId('deleted-document-banner');
const button = (name: string | RegExp) => screen.queryByRole('button', { name });

function expectReadOnly(absent: (string | RegExp)[]) {
  expect(banner()).toHaveTextContent(BANNER);
  expect(banner()).toHaveAttribute('role', 'status');
  for (const name of absent) {
    expect(button(name), `кнопки «${String(name)}» бути не має`).not.toBeInTheDocument();
  }
  // «Закрити» лишається (і хрестик у шапці, і кнопка внизу мають цю назву).
  expect(screen.getAllByRole('button', { name: 'Закрити' }).length).toBeGreaterThan(0);
}

beforeEach(() => {
  apiFetchMock.mockReset();
});

// ── Складський документ ──────────────────────────────────────────────────────
describe('StockDocumentCreateModal — документ, позначений на видалення', () => {
  const doc = (deletedAt: string | null): Doc => ({
    id: 'sd-1',
    number: 'ПРХ-000001',
    status: 'DRAFT',
    type: 'RECEIPT',
    branchId: 'b1',
    warehouseId: 'w1',
    documentDate: '2026-10-13',
    deletedAt,
    lines: [{ id: 'l1', goodId: 'g1', goodName: 'Фільтр', quantity: 1, price: 10 }],
  });
  const open = (deletedAt: string | null) => {
    mockApi({ '/stock-documents/sd-1?withDeleted=true': doc(deletedAt) });
    render(<StockDocumentCreateModal open stockDocumentId="sd-1" onClose={vi.fn()} />);
    return screen.findByText('Фільтр');
  };

  it('вантажить документ із withDeleted; з deletedAt — смуга, без збереження, переходів, імпорту', async () => {
    await open(DELETED_AT);

    expect(loadCalls('/stock-documents/sd-1')).toEqual(['/stock-documents/sd-1?withDeleted=true']);
    expectReadOnly([
      'Зберегти зміни',
      'Підтвердити',
      'Скасувати',
      'Додати товар',
      'тест-імпорт-xlsx',
      /Завантажити з Excel/,
      /Поділитись/,
      /SMS/,
    ]);
    expect(button(/Друк/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Додаткова інформація…')).toBeDisabled();
  });

  it('без deletedAt — картка як раніше: смуги немає, збереження й переходи на місці', async () => {
    await open(null);

    expect(banner()).not.toBeInTheDocument();
    for (const name of ['Зберегти зміни', 'Підтвердити', 'Скасувати', 'тест-імпорт-xlsx']) {
      expect(button(name)).toBeInTheDocument();
    }
    expect(screen.getByPlaceholderText('Додаткова інформація…')).toBeEnabled();
  });
});

// ── Замовлення постачальнику ─────────────────────────────────────────────────
describe('PurchaseOrderCreateModal — документ, позначений на видалення', () => {
  const doc = (deletedAt: string | null, status = 'DRAFT'): Doc => ({
    id: 'po-1',
    number: 'ЗАМ-000001',
    status,
    supplierId: 's1',
    supplierName: 'Постачальник',
    warehouseId: 'w1',
    documentDate: '2026-10-13',
    totalAmount: 10,
    deletedAt,
    lines: [{ id: 'l1', goodId: 'g1', goodName: 'Фільтр', quantity: 1, price: 10, receivedQty: 0 }],
  });
  const open = (deletedAt: string | null, status?: string) => {
    mockApi({ '/purchase-orders/po-1?withDeleted=true': doc(deletedAt, status) });
    renderWithQueryClient(
      <PurchaseOrderCreateModal open purchaseOrderId="po-1" onClose={vi.fn()} />,
    );
    return screen.findByText('Фільтр');
  };

  it('з deletedAt — смуга, без збереження, переходів, оплати, імпорту, поширення', async () => {
    await open(DELETED_AT);

    expect(loadCalls('/purchase-orders/po-1')).toEqual(['/purchase-orders/po-1?withDeleted=true']);
    expectReadOnly([
      'Зберегти зміни',
      'Скасувати',
      /Оплатити/,
      'тест-імпорт-xlsx',
      /Поділитись/,
      /SMS/,
    ]);
    expect(button(/Друк/)).toBeInTheDocument();
  });

  it('з deletedAt у статусі «Замовлено» — прийому товару немає', async () => {
    await open(DELETED_AT, 'ORDERED');
    expectReadOnly([/Оприбуткувати/, /Оплатити/]);
  });

  it('контроль: живе замовлення у статусі «Замовлено» прийом товару має', async () => {
    await open(null, 'ORDERED');
    expect(button(/Оприбуткувати/)).toBeInTheDocument();
  });

  it('без deletedAt — картка як раніше', async () => {
    await open(null);

    expect(banner()).not.toBeInTheDocument();
    for (const name of ['Зберегти зміни', 'Скасувати', /Оплатити/, 'тест-імпорт-xlsx']) {
      expect(button(name)).toBeInTheDocument();
    }
  });
});

// ── Рахунок ──────────────────────────────────────────────────────────────────
describe('InvoiceCreateModal — документ, позначений на видалення', () => {
  const doc = (deletedAt: string | null): Doc => ({
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
    deletedAt,
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
  });
  const open = (deletedAt: string | null) => {
    mockApi({ '/invoices/inv-1?withDeleted=true': doc(deletedAt) });
    render(<InvoiceCreateModal open invoiceId="inv-1" onClose={vi.fn()} />);
    return screen.findByText('Робота 1', undefined, { timeout: 2000 });
  };

  it('з deletedAt — смуга, без збереження, переходів, додавання рядків, поширення', async () => {
    await open(DELETED_AT);

    expect(loadCalls('/invoices/inv-1')).toEqual(['/invoices/inv-1?withDeleted=true']);
    expectReadOnly(['Зберегти зміни', 'Скасувати', /Додати/, /Поділитись/, /SMS/]);
    expect(button(/Друк/)).toBeInTheDocument();
  });

  it('без deletedAt — картка як раніше', async () => {
    await open(null);

    expect(banner()).not.toBeInTheDocument();
    expect(button('Зберегти зміни')).toBeInTheDocument();
    expect(button('Скасувати')).toBeInTheDocument();
    expect(button(/Додати/)).toBeInTheDocument();
  });
});

// ── Повернення постачальнику ─────────────────────────────────────────────────
describe('SupplierReturnCreateModal — документ, позначений на видалення', () => {
  const doc = (deletedAt: string | null): Doc => ({
    id: 'sr-1',
    number: 'ПОВ-1',
    status: 'DRAFT',
    supplierId: 'sup1',
    supplierName: 'ТОВ Постач',
    warehouseId: 'w1',
    notes: '',
    documentDate: '2026-10-13',
    deletedAt,
    lines: [{ id: 'l1', goodId: 'g1', goodName: 'Фільтр', unit: 'шт', quantity: 2, price: 100 }],
  });
  const open = (deletedAt: string | null) => {
    mockApi({ '/supplier-returns/sr-1?withDeleted=true': doc(deletedAt) });
    render(<SupplierReturnCreateModal open editId="sr-1" onClose={vi.fn()} onSaved={vi.fn()} />);
    return screen.findByText('Фільтр');
  };

  it('з deletedAt — смуга, без збереження, переходів і додавання рядків', async () => {
    await open(DELETED_AT);

    expect(loadCalls('/supplier-returns/sr-1')).toEqual([
      '/supplier-returns/sr-1?withDeleted=true',
    ]);
    expectReadOnly(['Зберегти зміни', 'Підтвердити', 'Скасувати', /Додати/]);
  });

  it('без deletedAt — картка як раніше', async () => {
    await open(null);

    expect(banner()).not.toBeInTheDocument();
    for (const name of ['Зберегти зміни', 'Підтвердити', 'Скасувати', /Додати/]) {
      expect(button(name)).toBeInTheDocument();
    }
  });

  // Раніше помилка завантаження ковталась (`.catch(() => {})`): картка лишалась порожньою формою
  // «чернетки», наче документа ще немає.
  it('помилка завантаження показана в картці', async () => {
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/supplier-returns/sr-1?withDeleted=true') {
        return Promise.reject(new Error('Повернення не знайдено'));
      }
      if (path === '/warehouses') return Promise.resolve([{ id: 'w1', name: 'Склад №1' }]);
      return Promise.resolve({ items: [] });
    });
    render(<SupplierReturnCreateModal open editId="sr-1" onClose={vi.fn()} onSaved={vi.fn()} />);

    expect(await screen.findByText('Повернення не знайдено')).toBeInTheDocument();
  });
});

// ── Наряд ────────────────────────────────────────────────────────────────────
describe('CreateWorkOrderModal — наряд, позначений на видалення', () => {
  const doc = (deletedAt: string | null): Doc => ({
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
    deletedAt,
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
  });
  const open = async (deletedAt: string | null) => {
    mockApi({ '/work-orders/wo-1?withDeleted=true': doc(deletedAt) });
    render(<CreateWorkOrderModal open onClose={vi.fn()} workOrderId="wo-1" />);
    await screen.findByText('Заміна колодок');
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith('/settings/organisation'));
  };

  it('з deletedAt — смуга, без збереження, переходів, рахунку, поширення', async () => {
    await open(DELETED_AT);

    expect(loadCalls('/work-orders/wo-1?')).toEqual(['/work-orders/wo-1?withDeleted=true']);
    expectReadOnly(['Зберегти зміни', 'Скасувати', /Виставити рахунок/, /Поділитись/, /SMS/]);
    // Стара підказка «редагування недоступне у статусі …» поруч зі смугою не дублюється.
    expect(screen.queryByText(/редагування недоступне/)).not.toBeInTheDocument();
  });

  it('без deletedAt — картка як раніше', async () => {
    await open(null);

    expect(banner()).not.toBeInTheDocument();
    expect(button('Зберегти зміни')).toBeInTheDocument();
    expect(button('Скасувати')).toBeInTheDocument();
    expect(button(/Поділитись/)).toBeInTheDocument();
  });

  it('смуга стоїть у тілі картки над формою', async () => {
    await open(DELETED_AT);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByTestId('deleted-document-banner')).toHaveTextContent(BANNER);
  });
});
