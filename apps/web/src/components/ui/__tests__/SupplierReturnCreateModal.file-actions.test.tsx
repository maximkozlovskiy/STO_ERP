/**
 * BR-SRET-014: картка повернення постачальнику має «Друк» і «Зберегти як» (до правила — ні того,
 * ні іншого): збережене повернення, зокрема видалене (друкується з позначкою «ВИДАЛЕНО»); нове —
 * ні. Escape закриває меню форматів, а не картку.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SupplierReturnCreateModal } from '../SupplierReturnCreateModal';

const apiFetchMock = vi.fn();
const apiFileFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...a: unknown[]) => apiFetchMock(...a),
  apiBlobFetch: vi.fn(),
  apiFileFetch: (...a: unknown[]) => apiFileFetchMock(...a),
}));
const downloadBlobMock = vi.fn();
vi.mock('@/lib/download', () => ({
  downloadBlob: (...a: unknown[]) => downloadBlobMock(...a),
  printPdf: vi.fn(),
}));
vi.mock('@/lib/ref-cache', () => ({ getCached: () => null, setCache: vi.fn() }));
vi.mock('@/hooks/useUiFeatures', () => ({ useUiFeatures: () => ({ toastEnabled: false }) }));

const doc = (deletedAt: string | null) => ({
  id: 'sr1',
  number: 'ПОВ-1',
  status: 'CONFIRMED',
  supplierId: 'sup1',
  supplierName: 'ТОВ Постач',
  warehouseId: 'w1',
  notes: '',
  documentDate: '2026-11-05',
  deletedAt,
  lines: [],
});

function serve(deletedAt: string | null) {
  apiFetchMock.mockImplementation((path: string) => {
    if (path === '/warehouses') return Promise.resolve([{ id: 'w1', name: 'Склад' }]);
    if (path === '/supplier-returns/sr1?withDeleted=true') return Promise.resolve(doc(deletedAt));
    return Promise.resolve({ items: [] });
  });
}

describe('SupplierReturnCreateModal — друк і «Зберегти як» (BR-SRET-014)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFileFetchMock.mockReset();
    downloadBlobMock.mockReset();
  });

  // guards: BR-SRET-014
  it.each([
    ['проведене', null],
    ['видалене', '2026-11-05T10:00:00Z'],
  ])('%s повернення — «Друк» і «Зберегти як → PDF» з іменем із сервера', async (_n, deletedAt) => {
    serve(deletedAt);
    const blob = new Blob(['%PDF']);
    apiFileFetchMock.mockResolvedValue({ blob, filename: 'Повернення-ПОВ-1.pdf' });
    render(<SupplierReturnCreateModal open onClose={vi.fn()} onSaved={vi.fn()} editId="sr1" />);

    expect(await screen.findByRole('button', { name: /Друк/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Зберегти як/ }));
    fireEvent.click(screen.getByRole('button', { name: 'PDF' }));

    await waitFor(() =>
      expect(downloadBlobMock).toHaveBeenCalledWith(blob, 'Повернення-ПОВ-1.pdf'),
    );
    expect(apiFileFetchMock).toHaveBeenCalledWith('/supplier-returns/sr1/export/pdf', 'sr1.pdf');
  });

  // guards: BR-SRET-014
  it('Escape закриває меню форматів, картка лишається', async () => {
    serve(null);
    const onClose = vi.fn();
    render(<SupplierReturnCreateModal open onClose={onClose} onSaved={vi.fn()} editId="sr1" />);

    fireEvent.click(await screen.findByRole('button', { name: /Зберегти як/ }));
    expect(screen.getByRole('button', { name: 'Excel (.xlsx)' })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Excel (.xlsx)' })).not.toBeInTheDocument(),
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  // guards: BR-SRET-014
  it('нове повернення — без друку й «Зберегти як»', () => {
    serve(null);
    render(<SupplierReturnCreateModal open onClose={vi.fn()} onSaved={vi.fn()} />);

    expect(screen.queryByRole('button', { name: /Друк/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Зберегти як/ })).not.toBeInTheDocument();
  });
});
