// useLinesSummary — зведення по табличних частинах документа (GET /<entity>/:id/lines-summary).
// Стереже контракт із бекендом (точний шлях для кожної з п'яти сутностей, AbortSignal) і дві
// властивості, на яких тримається панель: без id / з enabled=false запит не йде, а ключ лежить
// у просторі ключів сутності — тому наявна інвалідація `<сутність>Keys.all` оновлює і зведення.
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import type { ReactNode } from 'react';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

import {
  linesSummaryKeys,
  useLinesSummary,
  type LinesSummary,
  type LinesSummaryEntity,
} from './useLinesSummary';
import { workOrdersKeys } from './useWorkOrders';
import { invoicesKeys } from './useInvoices';
import { purchaseOrdersKeys } from './usePurchaseOrders';
import { stockDocsKeys } from './useStockDocuments';
import { supplierReturnsKeys } from './useSupplierReturns';

function createWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

const SUMMARY: LinesSummary = {
  tables: [{ key: 'works', positions: 2, distinct: 2, quantity: 3.5, quantityUnit: 'hours' }],
  executors: [{ employeeId: 'e1', name: 'Петренко Іван', works: 2, normoHours: 3.5 }],
};

const ENTITY_ROOTS: Array<[LinesSummaryEntity, readonly string[]]> = [
  ['work-orders', workOrdersKeys.all],
  ['invoices', invoicesKeys.all],
  ['purchase-orders', purchaseOrdersKeys.all],
  ['stock-documents', stockDocsKeys.all],
  ['supplier-returns', supplierReturnsKeys.all],
];

describe('useLinesSummary', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it('ключ = [entity, "lines-summary", id]', () => {
    expect(linesSummaryKeys.detail('work-orders', 'wo-1')).toEqual([
      'work-orders',
      'lines-summary',
      'wo-1',
    ]);
  });

  it.each(ENTITY_ROOTS)(
    '%s: ключ зведення починається з кореня ключів сутності',
    (entity, root) => {
      expect(linesSummaryKeys.detail(entity, 'x').slice(0, root.length)).toEqual([...root]);
    },
  );

  it.each(ENTITY_ROOTS.map(([entity]) => entity))(
    '%s: GET /<entity>/:id/lines-summary із signal',
    async entity => {
      apiFetchMock.mockResolvedValueOnce(SUMMARY);
      const { wrapper } = createWrapper();

      const { result } = renderHook(() => useLinesSummary(entity, 'id-1', true), { wrapper });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(apiFetchMock).toHaveBeenCalledTimes(1);
      const [path, init] = apiFetchMock.mock.calls[0] as [string, { signal?: AbortSignal }];
      expect(path).toBe(`/${entity}/id-1/lines-summary`);
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(result.current.data).toEqual(SUMMARY);
    },
  );

  it('без id запит не йде', () => {
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useLinesSummary('work-orders', null, true), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('enabled=false (панель вимкнена) — запит не йде, навіть коли id є', () => {
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useLinesSummary('invoices', 'inv-1', false), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('інвалідація кореня сутності перезапитує зведення — окремий виклик не потрібен', async () => {
    apiFetchMock.mockResolvedValue(SUMMARY);
    const { client, wrapper } = createWrapper();
    const { result } = renderHook(() => useLinesSummary('stock-documents', 'sd-1', true), {
      wrapper,
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetchMock).toHaveBeenCalledTimes(1);

    await client.invalidateQueries({ queryKey: stockDocsKeys.all });
    expect(apiFetchMock).toHaveBeenCalledTimes(2);

    // Чужий корінь зведення цієї сутності не чіпає.
    await client.invalidateQueries({ queryKey: workOrdersKeys.all });
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
  });

  it('помилка сервера віддається як є (текст показує блок зведення)', async () => {
    apiFetchMock.mockRejectedValueOnce(new Error('Наряд не знайдено'));
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useLinesSummary('work-orders', 'wo-404', true), {
      wrapper,
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toEqual(new Error('Наряд не знайдено'));
  });
});
