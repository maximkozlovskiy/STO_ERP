// Bug #938: кнопка «Закрити» у футері картки документа (наряд, рахунок, замовлення постачальнику)
// кликала `onClose` напряму — повз `useDirtyForm`. Escape і «×» перед закриттям питали «Є незбережені
// зміни», а футерна кнопка закривала картку мовчки: додані роботи, змінений опис чи примітки
// зникали без попередження (наживо — наряд НРД-2026-003201, 2026-10-22).
//
// Для кожної картки: змінити поле → «Закрити» у футері → підтвердження, картка не закрита;
// «Покинути» → закрита. Контроль: без змін «Закрити» закриває одразу (інакше перший кейс
// зелений і тоді, коли кнопка просто нічого не робить).
//
// Мутація (перевірено для кожної картки): `onClick={onClose}` замість `handleModalClose` → падає
// перший кейс її блоку.

import { render, screen, waitFor, act, within, fireEvent } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';

import { CreateWorkOrderModal } from '../CreateWorkOrderModal';
import { InvoiceCreateModal } from '../InvoiceCreateModal';
import { PurchaseOrderCreateModal } from '../PurchaseOrderCreateModal';
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

vi.mock('@/hooks/useUiFeatures', () => ({
  useUiFeatures: () => ({
    toastEnabled: false,
    unsavedGuardEnabled: true,
    keyboardShortcutsEnabled: false,
  }),
}));

vi.mock('@/hooks/api/useCash', () => ({
  useBaseCurrency: () => ({ data: { code: 'UAH', symbol: '₴' } }),
}));

vi.mock('@/components/ui/xlsx-import-button', () => ({
  XlsxImportButton: () => null,
}));
vi.mock('@/components/ui/ExcelImportWizard', () => ({
  ExcelImportWizard: () => null,
}));

type Doc = Record<string, unknown>;

function mockApi(docPath: string, doc: Doc) {
  apiFetchMock.mockImplementation((path: string) => {
    if (path === docPath) return Promise.resolve(doc);
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

interface CardCase {
  title: string;
  docPath: string;
  doc: Doc;
  lineText: string;
  render: (onClose: () => void) => void;
  /** Поле, яке змінює користувач. */
  field: () => HTMLElement;
}

const CASES: CardCase[] = [
  {
    title: 'наряд',
    docPath: '/work-orders/wo-1?withDeleted=true',
    render: onClose => {
      renderWithQueryClient(<CreateWorkOrderModal open onClose={onClose} workOrderId="wo-1" />);
    },
    field: () => screen.getByPlaceholderText('Заміна масла, колодок...'),
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
  {
    title: 'рахунок',
    docPath: '/invoices/inv-1?withDeleted=true',
    render: onClose => {
      render(<InvoiceCreateModal open invoiceId="inv-1" onClose={onClose} />);
    },
    field: () => screen.getByLabelText('Примітки'),
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
    title: 'замовлення постачальнику',
    docPath: '/purchase-orders/po-1?withDeleted=true',
    render: onClose => {
      renderWithQueryClient(
        <PurchaseOrderCreateModal open purchaseOrderId="po-1" onClose={onClose} />,
      );
    },
    field: () => screen.getByLabelText('Опис'),
    doc: {
      id: 'po-1',
      number: 'ЗАМ-000001',
      status: 'DRAFT',
      supplierId: 's1',
      supplierName: 'Постачальник',
      warehouseId: 'w1',
      documentDate: '2026-10-13',
      totalAmount: 10,
      notes: '',
      deletedAt: null,
      lines: [
        { id: 'l1', goodId: 'g1', goodName: 'Фільтр', quantity: 1, price: 10, receivedQty: 0 },
      ],
    },
    lineText: 'Фільтр',
  },
];

/** Кнопка «Закрити» футера картки (у шапці є ще іконка «×» з тим самим ім'ям). */
function footerClose(): HTMLElement {
  const buttons = screen.getAllByRole('button', { name: 'Закрити' });
  const footer = buttons.find(b => b.textContent?.trim() === 'Закрити');
  expect(footer, 'футерна кнопка «Закрити»').toBeDefined();
  return footer!;
}

async function openLoaded(c: CardCase, onClose: () => void) {
  mockApi(c.docPath, c.doc);
  c.render(onClose);
  expect(await screen.findByText(c.lineText, undefined, { timeout: 3000 })).toBeInTheDocument();
  // Дати осісти асинхронним довідникам і reset() форми.
  await act(async () => {
    await new Promise(r => setTimeout(r, 60));
  });
}

beforeEach(() => {
  apiFetchMock.mockReset();
});

describe.each(CASES)('Картка «$title» — «Закрити» у футері (Bug #938)', c => {
  it('є незбережені зміни → підтвердження, картка не закрита; «Покинути» → закрита', async () => {
    const onClose = vi.fn();
    await openLoaded(c, onClose);

    fireEvent.change(c.field(), { target: { value: '000 зміна' } });
    fireEvent.click(footerClose());

    const dialog = await screen.findByText('Є незбережені зміни');
    expect(onClose).not.toHaveBeenCalled();

    const confirm = dialog.closest('[role="dialog"], [role="alertdialog"]') as HTMLElement;
    fireEvent.click(within(confirm).getByRole('button', { name: 'Покинути' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('контроль: без змін «Закрити» закриває одразу, без підтвердження', async () => {
    const onClose = vi.fn();
    await openLoaded(c, onClose);

    fireEvent.click(footerClose());

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Є незбережені зміни')).not.toBeInTheDocument();
  });
});
