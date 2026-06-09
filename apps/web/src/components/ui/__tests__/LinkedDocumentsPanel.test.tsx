import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import { LinkedDocumentsPanel } from '../LinkedDocumentsPanel';

// Mock apiFetch — panel робить один GET на mount + при кожній зміні refreshKey/workOrderId.
const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

// Stable date/time formatters (uk-UA локаль).
vi.mock('@/lib/format', () => ({
  fmtDate: (iso: string | null | undefined) => (iso ? '05.06.2026' : '—'),
  fmtDateTime: (iso: string | null | undefined) => (iso ? '05.06.2026 10:30' : '—'),
  fmtMoney: (n: number) => `${Number(n).toFixed(2).replace('.', ',')}`,
}));

const WO_ID = '11111111-1111-4111-8111-111111111111';
const EMPTY: Record<string, unknown[]> = {
  invoices: [],
  payments: [],
  calendarSlots: [],
  warranties: [],
};

describe('LinkedDocumentsPanel — regression guards (Bugs #409, #414, #417)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it('показує спінер завантаження поки fetch in-flight', async () => {
    apiFetchMock.mockImplementation(() => new Promise(() => {})); // never resolves
    render(<LinkedDocumentsPanel workOrderId={WO_ID} />);
    expect(screen.getByText(/Завантаження/)).toBeInTheDocument();
  });

  it('Bug #414: показує error banner при apiFetch reject (НЕ маскує empty state)', async () => {
    apiFetchMock.mockRejectedValueOnce(new Error('Internal Server Error'));
    render(<LinkedDocumentsPanel workOrderId={WO_ID} />);
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
    expect(screen.getByText(/Не вдалось завантажити/)).toBeInTheDocument();
    expect(screen.getByText(/Internal Server Error/)).toBeInTheDocument();
    // Empty state НЕ показано
    expect(screen.queryByText(/Пов'язаних документів немає/)).not.toBeInTheDocument();
    // Retry button рендериться
    expect(screen.getByRole('button', { name: /Спробувати ще раз/ })).toBeInTheDocument();
  });

  it('Bug #414: Retry-кнопка викликає apiFetch повторно після помилки', async () => {
    const user = userEvent.setup();
    apiFetchMock.mockRejectedValueOnce(new Error('Network down'));
    render(<LinkedDocumentsPanel workOrderId={WO_ID} />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());

    // На повторний запит — успіх
    apiFetchMock.mockResolvedValueOnce(EMPTY);
    await user.click(screen.getByRole('button', { name: /Спробувати ще раз/ }));

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
    // empty-state показано після успішного retry
    expect(screen.getByText(/Пов'язаних документів немає/)).toBeInTheDocument();
  });

  it('показує empty state коли всі секції порожні (НЕ помилка)', async () => {
    apiFetchMock.mockResolvedValueOnce(EMPTY);
    render(<LinkedDocumentsPanel workOrderId={WO_ID} />);
    await waitFor(() => {
      expect(screen.getByText(/Пов'язаних документів немає/)).toBeInTheDocument();
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('рендерить секцію Рахунки з кількістю + кліком відкриває preview', async () => {
    const user = userEvent.setup();
    apiFetchMock.mockResolvedValueOnce({
      ...EMPTY,
      invoices: [
        { id: 'inv-1', number: 'INV-2026-0001', status: 'DRAFT', amount: 1250, documentDate: null },
      ],
    });
    render(<LinkedDocumentsPanel workOrderId={WO_ID} />);
    await waitFor(() => expect(screen.getByText(/INV-2026-0001/)).toBeInTheDocument());
    // section header з лічильником (1)
    expect(screen.getByText(/Рахунки/)).toBeInTheDocument();

    // Клік на рядку відкриває preview
    await user.click(screen.getByRole('button', { name: /Рахунок INV-2026-0001/ }));
    // Preview має дублюючий title (з пробілом) — використовуємо role=dialog
    expect(screen.getByRole('dialog', { name: '' })).toBeInTheDocument();
  });

  it('Bug #409: refreshKey зміна тригерить новий fetch без unmount/remount', async () => {
    apiFetchMock.mockResolvedValueOnce(EMPTY);
    const { rerender } = render(<LinkedDocumentsPanel workOrderId={WO_ID} refreshKey={0} />);
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1));

    apiFetchMock.mockResolvedValueOnce(EMPTY);
    rerender(<LinkedDocumentsPanel workOrderId={WO_ID} refreshKey={1} />);
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(2));
  });

  it('workOrderId зміна → fetch йде на новий URL', async () => {
    apiFetchMock.mockResolvedValueOnce(EMPTY);
    const { rerender } = render(<LinkedDocumentsPanel workOrderId={WO_ID} />);
    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith(`/work-orders/${WO_ID}/linked-documents`);
    });

    const NEW_ID = '22222222-2222-4222-8222-222222222222';
    apiFetchMock.mockResolvedValueOnce(EMPTY);
    rerender(<LinkedDocumentsPanel workOrderId={NEW_ID} />);
    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith(`/work-orders/${NEW_ID}/linked-documents`);
    });
  });

  it('Bug #409 (паре): preview скидається при зміні workOrderId/refreshKey', async () => {
    const user = userEvent.setup();
    apiFetchMock.mockResolvedValueOnce({
      ...EMPTY,
      invoices: [
        { id: 'inv-1', number: 'INV-1', status: 'DRAFT', amount: 100, documentDate: null },
      ],
    });
    const { rerender } = render(<LinkedDocumentsPanel workOrderId={WO_ID} refreshKey={0} />);
    await waitFor(() => expect(screen.getByText(/INV-1/)).toBeInTheDocument());

    // Відкрити preview
    await user.click(screen.getByRole('button', { name: /Рахунок INV-1/ }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    // Bump refreshKey → preview має зникнути одразу (НЕ показувати stale)
    apiFetchMock.mockResolvedValueOnce({
      ...EMPTY,
      invoices: [
        { id: 'inv-2', number: 'INV-2', status: 'DRAFT', amount: 200, documentDate: null },
      ],
    });
    await act(async () => {
      rerender(<LinkedDocumentsPanel workOrderId={WO_ID} refreshKey={1} />);
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });
});
