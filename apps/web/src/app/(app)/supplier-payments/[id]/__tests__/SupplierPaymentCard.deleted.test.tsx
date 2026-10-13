// Картка оплати постачальнику для оплати, позначеної на видалення, — лише на перегляд
// (рішення власника 2026-10-13). Раніше картка вантажила оплату без прапорця: сервер відповідав
// 404, і замість документа було «не знайдено».
//
// Що ловить (мутацію не проганяв): прибрати `{ withDeleted: true }` з useSupplierPayment у PageClient → падає
// перевірка адреси запиту; прибрати `{sp.deletedAt && <DeletedDocumentBanner />}` → падає смуга.

import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, it, expect, describe, beforeEach } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), back: vi.fn() }),
  useParams: () => ({ id: 'sp-1' }),
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/supplier-payments/sp-1',
}));
vi.mock('@/lib/auth', () => ({
  useRequireAuth: () => ({ employee: { id: 'e1', role: 'OWNER' } }),
  useAuth: () => ({ employee: { id: 'e1', role: 'OWNER' } }),
}));

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));
vi.mock('@/components/ui/SupplierPaymentCreateModal', () => ({
  SupplierPaymentCreateModal: () => null,
}));
vi.mock('@/components/ui/LinkedDocumentsPanel', () => ({ LinkedDocumentsPanel: () => null }));

import SupplierPaymentCardPage from '../PageClient';

const PAYMENT = {
  id: 'sp-1',
  orgId: 'org-1',
  number: 'ОП-0001',
  status: 'DRAFT',
  supplierId: 'sup-1',
  supplierName: 'Постачальник Перший',
  sourceType: 'CASH',
  sourceName: 'Каса',
  method: 'cash',
  amount: 500,
  purchaseOrderId: null,
  purchaseOrderNumber: null,
  documentDate: '2026-10-13T00:00:00.000Z',
  notes: null,
  createdAt: '2026-10-13T08:00:00.000Z',
  updatedAt: '2026-10-13T08:00:00.000Z',
  deletedAt: null as string | null,
};

function renderCard(deletedAt: string | null) {
  apiFetchMock.mockImplementation((path: string) => {
    if (path === '/supplier-payments/sp-1?withDeleted=true') {
      return Promise.resolve({ ...PAYMENT, deletedAt });
    }
    return Promise.reject(new Error(`неочікуваний запит: ${path}`));
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SupplierPaymentCardPage />
    </QueryClientProvider>,
  );
  return screen.findByRole('heading', { level: 1, name: 'ОП-0001' });
}

const banner = () => screen.queryByTestId('deleted-document-banner');

describe('Картка оплати постачальнику — оплата, позначена на видалення', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it('вантажиться з withDeleted; смуга «лише перегляд» є, дій зміни немає', async () => {
    await renderCard('2026-10-13T09:00:00.000Z');

    expect(apiFetchMock.mock.calls.map(c => c[0])).toEqual([
      '/supplier-payments/sp-1?withDeleted=true',
    ]);
    expect(banner()).toHaveAttribute('role', 'status');
    expect(banner()).toHaveTextContent('Документ позначено на видалення — лише перегляд');
    for (const name of ['Провести', 'Редагувати', 'Скасувати', 'Помітити на видалення']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
    // Реквізити документа показано.
    expect(screen.getAllByText('Постачальник Перший').length).toBeGreaterThan(0);
  });

  it('жива чернетка — смуги немає, дії зміни на місці', async () => {
    await renderCard(null);

    expect(banner()).not.toBeInTheDocument();
    for (const name of ['Провести', 'Редагувати', 'Скасувати', 'Помітити на видалення']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
  });
});
