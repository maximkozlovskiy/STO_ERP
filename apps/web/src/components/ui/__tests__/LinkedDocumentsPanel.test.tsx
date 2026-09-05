import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import { Receipt, CreditCard } from 'lucide-react';
import { LinkedDocumentsPanel, type LinkedEntityConfig } from '../LinkedDocumentsPanel';

// Mock apiFetch — panel робить один GET на mount + при кожній зміні refreshKey/entityId.
const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

const WO_ID = '11111111-1111-4111-8111-111111111111';
const EMPTY: Record<string, unknown[]> = { invoices: [], payments: [] };

// Навігація, яку конфіг викликає при кліку «Відкрити» у прев'ю рахунку.
const navigateInvoice = vi.fn();

// Мінімальний config-driven конфіг для тестів (дзеркалить workOrderLinkedConfig-форму).
const testConfig: LinkedEntityConfig = {
  fetchPath: id => `/work-orders/${id}/linked-documents`,
  sections: [
    {
      key: 'invoices',
      title: 'Рахунки',
      icon: Receipt,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mapRow: (row: any) => ({
        id: row.id,
        primary: `Рахунок ${row.number}`,
        badge: { label: row.status, className: 'bg-secondary' },
        preview: {
          title: `Рахунок ${row.number}`,
          rows: [{ label: 'Сума', value: `${row.amount} ₴` }],
        },
        navigate: () => navigateInvoice(row.id),
      }),
    },
    {
      key: 'payments',
      title: 'Оплати',
      icon: CreditCard,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mapRow: (row: any) => ({
        id: row.id,
        primary: `${row.amount} ₴`,
        preview: { title: 'Оплата', rows: [{ label: 'Сума', value: `${row.amount} ₴` }] },
        // навмисно без navigate → кнопки «Відкрити» не має бути
      }),
    },
  ],
};

describe('LinkedDocumentsPanel — config-driven + navigation (Bugs #409, #414, #417)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    navigateInvoice.mockReset();
  });

  it('показує спінер завантаження поки fetch in-flight', async () => {
    apiFetchMock.mockImplementation(() => new Promise(() => {})); // never resolves
    render(<LinkedDocumentsPanel config={testConfig} entityId={WO_ID} />);
    expect(screen.getByText(/Завантаження/)).toBeInTheDocument();
  });

  it('Bug #414: показує error banner при apiFetch reject (НЕ маскує empty state)', async () => {
    apiFetchMock.mockRejectedValueOnce(new Error('Internal Server Error'));
    render(<LinkedDocumentsPanel config={testConfig} entityId={WO_ID} />);
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
    expect(screen.getByText(/Не вдалось завантажити/)).toBeInTheDocument();
    expect(screen.getByText(/Internal Server Error/)).toBeInTheDocument();
    expect(screen.queryByText(/Пов'язаних документів немає/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Спробувати ще раз/ })).toBeInTheDocument();
  });

  it('Bug #414: Retry-кнопка викликає apiFetch повторно після помилки', async () => {
    const user = userEvent.setup();
    apiFetchMock.mockRejectedValueOnce(new Error('Network down'));
    render(<LinkedDocumentsPanel config={testConfig} entityId={WO_ID} />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());

    apiFetchMock.mockResolvedValueOnce(EMPTY);
    await user.click(screen.getByRole('button', { name: /Спробувати ще раз/ }));

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/Пов'язаних документів немає/)).toBeInTheDocument();
  });

  it('показує empty state коли всі секції порожні (НЕ помилка)', async () => {
    apiFetchMock.mockResolvedValueOnce(EMPTY);
    render(<LinkedDocumentsPanel config={testConfig} entityId={WO_ID} />);
    await waitFor(() => {
      expect(screen.getByText(/Пов'язаних документів немає/)).toBeInTheDocument();
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('рендерить секцію Рахунки з кількістю + кліком відкриває preview', async () => {
    const user = userEvent.setup();
    apiFetchMock.mockResolvedValueOnce({
      ...EMPTY,
      invoices: [{ id: 'inv-1', number: 'INV-2026-0001', status: 'DRAFT', amount: 1250 }],
    });
    render(<LinkedDocumentsPanel config={testConfig} entityId={WO_ID} />);
    await waitFor(() => expect(screen.getByText(/INV-2026-0001/)).toBeInTheDocument());
    expect(screen.getByText(/Рахунки/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Рахунок INV-2026-0001/ }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it("перехід: клік «Відкрити» у прев'ю викликає navigate конфігу", async () => {
    const user = userEvent.setup();
    apiFetchMock.mockResolvedValueOnce({
      ...EMPTY,
      invoices: [{ id: 'inv-42', number: 'INV-42', status: 'PAID', amount: 500 }],
    });
    render(<LinkedDocumentsPanel config={testConfig} entityId={WO_ID} />);
    await waitFor(() => expect(screen.getByText(/INV-42/)).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /Рахунок INV-42/ }));
    // Кнопка «Відкрити» у прев'ю
    await user.click(screen.getByRole('button', { name: /Відкрити/ }));
    expect(navigateInvoice).toHaveBeenCalledWith('inv-42');
    // preview закривається після переходу
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('секція без navigate → кнопки «Відкрити» немає (оплата read-only)', async () => {
    const user = userEvent.setup();
    apiFetchMock.mockResolvedValueOnce({
      ...EMPTY,
      payments: [{ id: 'pay-1', amount: 300 }],
    });
    render(<LinkedDocumentsPanel config={testConfig} entityId={WO_ID} />);
    await waitFor(() => expect(screen.getByText(/Оплати/)).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /300 ₴/ }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Відкрити/ })).not.toBeInTheDocument();
  });

  it('Bug #409: refreshKey зміна тригерить новий fetch без unmount/remount', async () => {
    apiFetchMock.mockResolvedValueOnce(EMPTY);
    const { rerender } = render(
      <LinkedDocumentsPanel config={testConfig} entityId={WO_ID} refreshKey={0} />,
    );
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1));

    apiFetchMock.mockResolvedValueOnce(EMPTY);
    rerender(<LinkedDocumentsPanel config={testConfig} entityId={WO_ID} refreshKey={1} />);
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(2));
  });

  it('entityId зміна → fetch йде на новий URL', async () => {
    apiFetchMock.mockResolvedValueOnce(EMPTY);
    const { rerender } = render(<LinkedDocumentsPanel config={testConfig} entityId={WO_ID} />);
    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith(`/work-orders/${WO_ID}/linked-documents`);
    });

    const NEW_ID = '22222222-2222-4222-8222-222222222222';
    apiFetchMock.mockResolvedValueOnce(EMPTY);
    rerender(<LinkedDocumentsPanel config={testConfig} entityId={NEW_ID} />);
    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith(`/work-orders/${NEW_ID}/linked-documents`);
    });
  });

  it('Bug #409 (паре): preview скидається при зміні entityId/refreshKey', async () => {
    const user = userEvent.setup();
    apiFetchMock.mockResolvedValueOnce({
      ...EMPTY,
      invoices: [{ id: 'inv-1', number: 'INV-1', status: 'DRAFT', amount: 100 }],
    });
    const { rerender } = render(
      <LinkedDocumentsPanel config={testConfig} entityId={WO_ID} refreshKey={0} />,
    );
    await waitFor(() => expect(screen.getByText(/INV-1/)).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /Рахунок INV-1/ }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    apiFetchMock.mockResolvedValueOnce({
      ...EMPTY,
      invoices: [{ id: 'inv-2', number: 'INV-2', status: 'DRAFT', amount: 200 }],
    });
    await act(async () => {
      rerender(<LinkedDocumentsPanel config={testConfig} entityId={WO_ID} refreshKey={1} />);
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });
});
