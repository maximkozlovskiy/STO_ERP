// Очищення приміток у картці рахунку (TECH-DEBT (а) 2026-11-01): очищене поле → PATCH 200 → у БД
// старе. Форма парситься `invoiceFormSchema` ('' → undefined), і JSON.stringify ключ викидав.
// Тепер тіло PATCH шапки будує `patchBodyWithClears(header, formDefaults, INVOICE_CLEARABLE_FIELDS)`,
// де оригінал — база останнього `reset` (завантажений рахунок).
// Мутація: повернути `JSON.stringify({ ... notes: values.notes })` → кейс «примітки → null» червоніє.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';

import { InvoiceCreateModal } from '../InvoiceCreateModal';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ employee: { role: 'OWNER' } }) }));
vi.mock('@/lib/ref-cache', () => ({ getCached: () => null, setCache: vi.fn() }));
vi.mock('@/hooks/api/useCash', () => ({
  useBaseCurrency: () => ({ data: { code: 'UAH', symbol: '₴' } }),
}));

const CP = '11111111-1111-4111-8111-111111111111';
const NOTES = 'Оплата готівкою';
const DOC = {
  id: 'inv-1',
  number: 'РАХ-0042',
  status: 'DRAFT',
  invoiceType: 'STANDARD',
  counterpartyId: CP,
  counterpartyName: 'Клієнт',
  amount: 0,
  paidAmount: 0,
  dueDate: null,
  documentDate: '2026-10-28T00:00:00.000Z',
  notes: NOTES,
  deletedAt: null,
  workOrderId: null,
  workOrderNumber: null,
  lines: [
    {
      id: 'l-a',
      workId: null,
      goodId: null,
      description: 'Діагностика',
      quantity: 1,
      unitPrice: 100,
      vatRate: 20,
      priceWithVat: 120,
    },
  ],
};

function serve(doc: typeof DOC | (Omit<typeof DOC, 'dueDate'> & { dueDate: string })) {
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation((path: string) => {
    if (path === '/invoices/inv-1?withDeleted=true') return Promise.resolve(doc);
    return Promise.resolve(path === '/currencies' ? { items: [] } : {});
  });
}

beforeEach(() => serve(DOC));

const headerPatch = (): Record<string, unknown> => {
  const call = apiFetchMock.mock.calls.find(
    c =>
      c[0] === '/invoices/inv-1' && (c[1] as { method?: string } | undefined)?.method === 'PATCH',
  );
  expect(call).toBeTruthy();
  return JSON.parse(String((call![1] as { body: string }).body)) as Record<string, unknown>;
};

describe('Картка рахунку — очищення приміток у PATCH шапки', () => {
  it('очищені примітки → notes: null; термін оплати, якого не було, у тілі відсутній', async () => {
    const onClose = vi.fn();
    render(<InvoiceCreateModal open invoiceId="inv-1" onClose={onClose} />);
    fireEvent.change(await screen.findByDisplayValue(NOTES), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти зміни' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());

    const body = headerPatch();
    expect(body).toHaveProperty('notes', null);
    expect('dueDate' in body).toBe(false);
  });

  it('примітки не чіпали → ідуть як були, без null', async () => {
    const onClose = vi.fn();
    render(<InvoiceCreateModal open invoiceId="inv-1" onClose={onClose} />);
    await screen.findByDisplayValue(NOTES);
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти зміни' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());

    const body = headerPatch();
    expect(body).toHaveProperty('notes', NOTES);
    expect(Object.values(body)).not.toContain(null);
  });
});

// TECH-DEBT (а) 2026-11-04: термін оплати — у тому ж переліку (`INVOICE_CLEARABLE_FIELDS`).
// Мутація: прибрати 'dueDate' з INVOICE_CLEARABLE_FIELDS → перший кейс червоніє (ключа немає).
describe('Картка рахунку — очищення терміну оплати', () => {
  const WITH_DUE = { ...DOC, dueDate: '2026-12-01T00:00:00.000Z' };

  it('очищений термін → dueDate: null; дата документа (NOT NULL) іде як була', async () => {
    serve(WITH_DUE);
    const onClose = vi.fn();
    render(<InvoiceCreateModal open invoiceId="inv-1" onClose={onClose} />);
    fireEvent.change(await screen.findByDisplayValue('01.12.2026'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти зміни' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());

    const body = headerPatch();
    expect(body).toHaveProperty('dueDate', null);
    expect(body).toHaveProperty('documentDate', '2026-10-28');
    expect(body).toHaveProperty('notes', NOTES);
  });

  it('термін не чіпали → іде датою, без null', async () => {
    serve(WITH_DUE);
    const onClose = vi.fn();
    render(<InvoiceCreateModal open invoiceId="inv-1" onClose={onClose} />);
    await screen.findByDisplayValue('01.12.2026');
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти зміни' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());

    const body = headerPatch();
    expect(body).toHaveProperty('dueDate', '2026-12-01');
    expect(Object.values(body)).not.toContain(null);
  });
});
