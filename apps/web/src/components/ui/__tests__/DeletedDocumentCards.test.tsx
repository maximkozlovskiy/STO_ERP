// Документ, позначений на видалення, відкривається карткою ЛИШЕ на перегляд (рішення власника
// 2026-10-13). До цього «Відкрити документ» на видаленому рядку давав порожню картку «не знайдено»:
// картка вантажила документ без прапорця, сервер відповідав 404.
//
// Для кожної з п'яти карток:
//   - документ вантажиться з `?withDeleted=true`;
//   - з `deletedAt` — зверху смуга (role="status"), немає збереження, переходів статусу,
//     додавання рядків, імпорту, оплати, поширення; «Закрити» і «Друк» лишаються
//     (окрім наряду: там «Друк» і «Зберегти як» ідуть на сервер через токен поширення, а
//     сервер видаленого наряду не знаходить — тому в картці перегляду їх немає);
//   - без `deletedAt` — картка як раніше (збереження й переходи на місці, смуги немає).
//
// Що ловить: прибрати `&& !viewOnly` з `canEdit` картки → падає її кейс «лише перегляд»
// (з'являється «Зберегти зміни»); прибрати `!viewOnly` з allowedTransitions → падає перевірка
// кнопок переходу. Мутацію прогнано для складського документа (tester 2026-10-13).

import { render, screen, waitFor, within, act, fireEvent } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { vi, it, expect, describe, beforeEach } from 'vitest';

import { CreateWorkOrderModal } from '../CreateWorkOrderModal';
import { InvoiceCreateModal } from '../InvoiceCreateModal';
import { PurchaseOrderCreateModal } from '../PurchaseOrderCreateModal';
import { StockDocumentCreateModal } from '../StockDocumentCreateModal';
import { SupplierReturnCreateModal } from '../SupplierReturnCreateModal';
import { renderWithQueryClient, makeTestQueryClient } from '../../../__tests__/query-utils';

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
      'Додати',
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
      'Додати',
      'тест-імпорт-xlsx',
      /Поділитись/,
      /SMS/,
    ]);
    expect(button(/Друк/)).toBeInTheDocument();
  });

  // Картку відкрили для A, закрили й відкрили для видаленого B; відповідь A прийшла пізніше.
  // Без токена запиту вона заповнювала форму рядками A і знімала позначку «видалено» з B.
  it('пізня відповідь попереднього замовлення не потрапляє в картку наступного', async () => {
    let resolveA: (v: Doc) => void = () => {};
    mockApi({ '/purchase-orders/po-1?withDeleted=true': doc(DELETED_AT) });
    const base = apiFetchMock.getMockImplementation()!;
    apiFetchMock.mockImplementation((path: string) =>
      path === '/purchase-orders/po-a?withDeleted=true'
        ? new Promise<Doc>(resolve => {
            resolveA = resolve;
          })
        : base(path),
    );
    const client = makeTestQueryClient();
    const card = (id: string) => (
      <QueryClientProvider client={client}>
        <PurchaseOrderCreateModal open purchaseOrderId={id} onClose={vi.fn()} />
      </QueryClientProvider>
    );
    const { rerender } = render(card('po-a'));
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith('/purchase-orders/po-a?withDeleted=true'),
    );

    rerender(card('po-1'));
    await screen.findByText('Фільтр');
    expect(banner()).toBeInTheDocument();

    await act(async () => {
      resolveA({
        ...doc(null),
        id: 'po-a',
        number: 'ЗАМ-ЧУЖЕ',
        lines: [{ id: 'la', goodId: 'ga', goodName: 'Чужий товар', quantity: 1, price: 1 }],
      });
    });

    expect(screen.queryByText('Чужий товар')).not.toBeInTheDocument();
    expect(screen.getByText('Фільтр')).toBeInTheDocument();
    expect(banner()).toBeInTheDocument();
    expect(button('Зберегти зміни')).not.toBeInTheDocument();
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

  // Доки документ не завантажено, у картці стоять статус і рядки попереднього — жодних дій.
  // А відповідь попереднього документа, що прийшла після перемикання, у картку не потрапляє.
  it('до відповіді сервера дій немає; пізня відповідь попереднього повернення відкидається', async () => {
    let resolveA: (v: Doc) => void = () => {};
    mockApi({ '/supplier-returns/sr-1?withDeleted=true': doc(DELETED_AT) });
    const base = apiFetchMock.getMockImplementation()!;
    apiFetchMock.mockImplementation((path: string) =>
      path === '/supplier-returns/sr-a?withDeleted=true'
        ? new Promise<Doc>(resolve => {
            resolveA = resolve;
          })
        : base(path),
    );
    const card = (id: string) => (
      <SupplierReturnCreateModal open editId={id} onClose={vi.fn()} onSaved={vi.fn()} />
    );
    const { rerender } = render(card('sr-a'));
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith('/supplier-returns/sr-a?withDeleted=true'),
    );
    // Відповіді ще немає: типовий статус «чернетка» не має давати ні збереження, ні проведення.
    for (const name of ['Зберегти зміни', 'Підтвердити', 'Скасувати']) {
      expect(button(name), `до завантаження кнопки «${name}» бути не має`).not.toBeInTheDocument();
    }

    rerender(card('sr-1'));
    await screen.findByText('Фільтр');
    expect(banner()).toBeInTheDocument();

    await act(async () => {
      resolveA({
        ...doc(null),
        id: 'sr-a',
        lines: [
          { id: 'la', goodId: 'ga', goodName: 'Чужий товар', unit: 'шт', quantity: 1, price: 1 },
        ],
      });
    });

    expect(screen.queryByText('Чужий товар')).not.toBeInTheDocument();
    expect(banner()).toBeInTheDocument();
    expect(button('Підтвердити')).not.toBeInTheDocument();
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
    expectReadOnly([
      'Зберегти зміни',
      'Скасувати',
      /Виставити рахунок/,
      /Поділитись/,
      /SMS/,
      // Друк і «Зберегти як» наряду — через POST /work-orders/:id/share-token: для видаленого 404.
      'Друк',
      /Зберегти як/,
    ]);
    // Клієнта в картці перегляду не очистити й не змінити: поле вимкнене, як решта шапки.
    expect(button('Очистити')).not.toBeInTheDocument();
    // Стара підказка «редагування недоступне у статусі …» поруч зі смугою не дублюється.
    expect(screen.queryByText(/редагування недоступне/)).not.toBeInTheDocument();
  });

  it('без deletedAt — картка як раніше', async () => {
    await open(null);

    expect(banner()).not.toBeInTheDocument();
    expect(button('Зберегти зміни')).toBeInTheDocument();
    expect(button('Скасувати')).toBeInTheDocument();
    expect(button(/Поділитись/)).toBeInTheDocument();
    expect(button('Друк')).toBeInTheDocument();
    expect(button(/Зберегти як/)).toBeInTheDocument();
    expect(button('Очистити')).toBeInTheDocument();
  });

  it('смуга стоїть у тілі картки над формою', async () => {
    await open(DELETED_AT);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByTestId('deleted-document-banner')).toHaveTextContent(BANNER);
  });
});

// ── Ctrl+Enter ───────────────────────────────────────────────────────────────
// Кнопки «Зберегти зміни» у картці перегляду немає, але Ctrl+Enter у модалці кличе той самий
// обробник збереження напряму. Без запобіжника `isDeleted` на початку обробника картка слала б
// PATCH на видалений документ (сервер відповів би 404, користувач побачив би «не знайдено»).
// Мутація: прибрати `if (isDeleted) return;` / `|| isDeleted` з обробника збереження картки →
// падає її кейс тут (перевірено для всіх п'яти карток).
describe('Ctrl+Enter у картці документа, позначеного на видалення', () => {
  const writes = () =>
    apiFetchMock.mock.calls.filter(([, init]) => {
      const method = (init as { method?: string } | undefined)?.method;
      return method !== undefined && method !== 'GET';
    });

  // Модалка приймає Ctrl+Enter лише від елемента всередині своєї панелі, тому подію шлемо з
  // елемента картки: зі смуги «лише перегляд» (видалений) або з рядка документа (контроль).
  const pressCtrlEnter = async (inside: HTMLElement) => {
    await act(async () => {
      fireEvent.keyDown(inside, { key: 'Enter', ctrlKey: true });
      // Обробники збереження асинхронні (RHF handleSubmit) — даємо їм дійти до запиту.
      await new Promise(resolve => setTimeout(resolve, 50));
    });
  };

  // Справжні UUID: схема форми відкидає філію, склад і товар з іншими id, і тоді збереження
  // зупиняє валідація, а не запобіжник — контрольний кейс нижче це й показує.
  const sdDoc = (deletedAt: string | null): Doc => ({
    id: 'sd-1',
    number: 'ПРХ-000001',
    status: 'DRAFT',
    type: 'RECEIPT',
    branchId: 'a1000000-0000-4000-8000-0000000000b1',
    warehouseId: 'a1000000-0000-4000-8000-0000000000c1',
    documentDate: '2026-10-13',
    deletedAt,
    lines: [
      {
        id: 'l1',
        goodId: 'a1000000-0000-4000-8000-0000000000d1',
        goodName: 'Фільтр',
        quantity: 1,
        price: 10,
      },
    ],
  });

  it('складський документ: видалений — запиту на зміну немає', async () => {
    mockApi({ '/stock-documents/sd-1?withDeleted=true': sdDoc(DELETED_AT) });
    render(<StockDocumentCreateModal open stockDocumentId="sd-1" onClose={vi.fn()} />);
    await screen.findByText('Фільтр');
    expect(banner()).toBeInTheDocument();

    await pressCtrlEnter(banner()!);
    expect(writes()).toEqual([]);
  });

  // Контроль: той самий жест у живій чернетці зберігає — інакше кейси вище були б зеленими завжди.
  it('контроль: жива чернетка складського документа за Ctrl+Enter зберігається', async () => {
    mockApi({ '/stock-documents/sd-1?withDeleted=true': sdDoc(null) });
    render(<StockDocumentCreateModal open stockDocumentId="sd-1" onClose={vi.fn()} />);
    await screen.findByText('Фільтр');

    await pressCtrlEnter(screen.getByText('Фільтр'));
    await waitFor(() =>
      expect(writes().map(([p, init]) => [p, (init as { method: string }).method])).toEqual([
        ['/stock-documents/sd-1', 'PATCH'],
      ]),
    );
  });

  it('замовлення постачальнику: видалене — запиту на зміну немає', async () => {
    mockApi({
      '/purchase-orders/po-1?withDeleted=true': {
        id: 'po-1',
        number: 'ЗАМ-000001',
        status: 'DRAFT',
        supplierId: 'a1000000-0000-4000-8000-000000000001',
        supplierName: 'Постачальник',
        warehouseId: 'a1000000-0000-4000-8000-000000000002',
        documentDate: '2026-10-13',
        totalAmount: 10,
        deletedAt: DELETED_AT,
        lines: [
          {
            id: 'l1',
            goodId: 'a1000000-0000-4000-8000-000000000003',
            goodName: 'Фільтр',
            quantity: 1,
            price: 10,
            receivedQty: 0,
          },
        ],
      },
    });
    renderWithQueryClient(
      <PurchaseOrderCreateModal open purchaseOrderId="po-1" onClose={vi.fn()} />,
    );
    await screen.findByText('Фільтр');
    expect(banner()).toBeInTheDocument();

    await pressCtrlEnter(banner()!);
    expect(writes()).toEqual([]);
  });

  it('рахунок: видалений — запиту на зміну немає', async () => {
    mockApi({
      '/invoices/inv-1?withDeleted=true': {
        id: 'inv-1',
        number: 'РАХ-0001',
        status: 'DRAFT',
        invoiceType: 'STANDARD',
        counterpartyId: 'a1000000-0000-4000-8000-000000000004',
        counterpartyName: 'Клієнт',
        amount: 100,
        paidAmount: 0,
        dueDate: null,
        documentDate: '2026-10-13T00:00:00.000Z',
        notes: null,
        deletedAt: DELETED_AT,
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
    });
    render(<InvoiceCreateModal open invoiceId="inv-1" onClose={vi.fn()} />);
    await screen.findByText('Робота 1', undefined, { timeout: 2000 });
    expect(banner()).toBeInTheDocument();

    await pressCtrlEnter(banner()!);
    expect(writes()).toEqual([]);
  });

  it('повернення постачальнику: видалене — запиту на зміну немає', async () => {
    mockApi({
      '/supplier-returns/sr-1?withDeleted=true': {
        id: 'sr-1',
        number: 'ПОВ-1',
        status: 'DRAFT',
        supplierId: 'a1000000-0000-4000-8000-000000000001',
        supplierName: 'ТОВ Постач',
        warehouseId: 'a1000000-0000-4000-8000-000000000002',
        notes: '',
        documentDate: '2026-10-13',
        deletedAt: DELETED_AT,
        lines: [
          {
            id: 'l1',
            goodId: 'a1000000-0000-4000-8000-000000000003',
            goodName: 'Фільтр',
            unit: 'шт',
            quantity: 2,
            price: 100,
          },
        ],
      },
    });
    render(<SupplierReturnCreateModal open editId="sr-1" onClose={vi.fn()} onSaved={vi.fn()} />);
    await screen.findByText('Фільтр');
    expect(banner()).toBeInTheDocument();

    await pressCtrlEnter(banner()!);
    expect(writes()).toEqual([]);
  });

  // У наряді запитів не було б і без запобіжника (canEdit уже false), але обробник дійшов би до
  // кінця: «збережено» і закриття картки, наче щось записалось. Тому звіряємо ще й onClose.
  it('наряд: видалений — запиту на зміну немає, картка не закривається', async () => {
    mockApi({
      '/work-orders/wo-1?withDeleted=true': {
        id: 'wo-1',
        number: 'WO-001',
        status: 'DRAFT',
        branchId: 'a1000000-0000-4000-8000-000000000005',
        vehicleId: 'a1000000-0000-4000-8000-000000000006',
        counterpartyId: 'a1000000-0000-4000-8000-000000000004',
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
        deletedAt: DELETED_AT,
        lines: [
          {
            id: 'l1',
            workId: 'a1000000-0000-4000-8000-000000000007',
            workName: 'Заміна колодок',
            employeeId: 'a1000000-0000-4000-8000-000000000008',
            normoHours: 2,
            actualHours: null,
            price: 500,
          },
        ],
        parts: [],
      },
    });
    const onClose = vi.fn();
    render(<CreateWorkOrderModal open onClose={onClose} workOrderId="wo-1" />);
    await screen.findByText('Заміна колодок');
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith('/settings/organisation'));
    expect(banner()).toBeInTheDocument();

    await pressCtrlEnter(banner()!);
    expect(writes()).toEqual([]);
    expect(onClose).not.toHaveBeenCalled();
  });
});
