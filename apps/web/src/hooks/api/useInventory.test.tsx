import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import type { ReactNode } from 'react';

// Mock apiFetch — jsdom не має fetch; ловимо точний URL що сформував хук.
const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

// Mock useAuth — useStockByDocument/useStockByBatch мають employee у enabled-gate.
const useAuthMock = vi.fn();
vi.mock('@/lib/auth', () => ({
  useAuth: () => useAuthMock(),
}));

import { useStockByDocument, useStockByBatch, inventoryKeys } from './useInventory';

function createWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

describe('useInventory hooks — Bug #457 + URL contract', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    useAuthMock.mockReset();
    apiFetchMock.mockResolvedValue({ goods: [] });
    useAuthMock.mockReturnValue({ employee: { id: 'emp-1', role: 'STOREKEEPER' } });
  });

  describe('inventoryKeys factory', () => {
    it('byDocument різні filters → різні keys', () => {
      const k1 = inventoryKeys.byDocument({ warehouseId: 'wh-1' });
      const k2 = inventoryKeys.byDocument({ warehouseId: 'wh-2' });
      expect(JSON.stringify(k1)).not.toEqual(JSON.stringify(k2));
    });

    it('byDocument і byBatch мають різні префікси (не міксуються у кеші)', () => {
      const docKey = inventoryKeys.byDocument({});
      const batchKey = inventoryKeys.byBatch({});
      expect(docKey).not.toEqual(batchKey);
      expect(docKey[1]).toBe('by-document');
      expect(batchKey[1]).toBe('by-batch');
    });
  });

  describe('useStockByDocument — URL contract', () => {
    it('викликає GET /stock-items/by-document без params коли фільтри порожні', async () => {
      const { wrapper } = createWrapper();
      renderHook(() => useStockByDocument({}), { wrapper });
      await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
      const url = apiFetchMock.mock.calls[0][0] as string;
      expect(url).toBe('/stock-items/by-document');
    });

    it('передає warehouseId у query string', async () => {
      const { wrapper } = createWrapper();
      renderHook(() => useStockByDocument({ warehouseId: 'wh-1' }), { wrapper });
      await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
      const url = apiFetchMock.mock.calls[0][0] as string;
      expect(url).toContain('warehouseId=wh-1');
      expect(url.startsWith('/stock-items/by-document?')).toBe(true);
    });

    it('передає goodId у query string', async () => {
      const { wrapper } = createWrapper();
      renderHook(() => useStockByDocument({ goodId: 'g-1' }), { wrapper });
      await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
      const url = apiFetchMock.mock.calls[0][0] as string;
      expect(url).toContain('goodId=g-1');
    });

    it('передає from/to date range у query string', async () => {
      const { wrapper } = createWrapper();
      renderHook(() => useStockByDocument({ from: '2025-01-01', to: '2025-01-31' }), { wrapper });
      await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
      const url = apiFetchMock.mock.calls[0][0] as string;
      expect(url).toContain('from=2025-01-01');
      expect(url).toContain('to=2025-01-31');
    });

    it('опускає undefined-фільтри (не пише &warehouseId=undefined)', async () => {
      const { wrapper } = createWrapper();
      renderHook(() => useStockByDocument({ warehouseId: 'wh-1', goodId: undefined }), { wrapper });
      await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
      const url = apiFetchMock.mock.calls[0][0] as string;
      expect(url).not.toContain('goodId');
      expect(url).not.toContain('undefined');
    });
  });

  describe('useStockByBatch — URL contract', () => {
    beforeEach(() => {
      apiFetchMock.mockResolvedValue({ batches: [] });
    });

    it('викликає GET /stock-items/by-batch без params', async () => {
      const { wrapper } = createWrapper();
      renderHook(() => useStockByBatch({}), { wrapper });
      await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
      expect(apiFetchMock.mock.calls[0][0]).toBe('/stock-items/by-batch');
    });

    it('передає warehouseId + goodId + from + to', async () => {
      const { wrapper } = createWrapper();
      renderHook(
        () =>
          useStockByBatch({
            warehouseId: 'wh-A',
            goodId: 'g-B',
            from: '2025-02-01',
            to: '2025-02-28',
          }),
        { wrapper },
      );
      await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
      const url = apiFetchMock.mock.calls[0][0] as string;
      expect(url).toContain('warehouseId=wh-A');
      expect(url).toContain('goodId=g-B');
      expect(url).toContain('from=2025-02-01');
      expect(url).toContain('to=2025-02-28');
    });
  });

  describe('Bug #457: enabled gate', () => {
    it('useStockByDocument НЕ викликає apiFetch коли enabled=false', async () => {
      const { wrapper } = createWrapper();
      renderHook(() => useStockByDocument({}, false), { wrapper });
      await new Promise(r => setTimeout(r, 60));
      expect(apiFetchMock).not.toHaveBeenCalled();
    });

    it('useStockByBatch НЕ викликає apiFetch коли enabled=false', async () => {
      apiFetchMock.mockResolvedValue({ batches: [] });
      const { wrapper } = createWrapper();
      renderHook(() => useStockByBatch({}, false), { wrapper });
      await new Promise(r => setTimeout(r, 60));
      expect(apiFetchMock).not.toHaveBeenCalled();
    });

    it('useStockByDocument викликає apiFetch коли enabled=true (default)', async () => {
      const { wrapper } = createWrapper();
      renderHook(() => useStockByDocument({}), { wrapper });
      await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    });

    it('useStockByDocument НЕ викликає apiFetch коли employee=null (auth gate)', async () => {
      useAuthMock.mockReturnValue({ employee: null });
      const { wrapper } = createWrapper();
      renderHook(() => useStockByDocument({}, true), { wrapper });
      await new Promise(r => setTimeout(r, 60));
      expect(apiFetchMock).not.toHaveBeenCalled();
    });

    it('обидва gates AND-юються: employee=ok але enabled=false → НЕ зап��т', async () => {
      const { wrapper } = createWrapper();
      renderHook(() => useStockByDocument({}, false), { wrapper });
      await new Promise(r => setTimeout(r, 60));
      expect(apiFetchMock).not.toHaveBeenCalled();
    });
  });
});
