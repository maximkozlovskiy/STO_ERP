import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import type { ReactNode } from 'react';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));
const useAuthMock = vi.fn();
vi.mock('@/lib/auth', () => ({ useAuth: () => useAuthMock() }));

import { reportBuilderKeys, useReportMetadata, useRunReport } from './useReportBuilder';

function createWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

describe('useReportBuilder', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    useAuthMock.mockReset();
  });

  it('keys factory', () => {
    expect(reportBuilderKeys.metadata()).toEqual(['report-builder', 'metadata']);
    expect(reportBuilderKeys.saved()).toEqual(['report-builder', 'saved']);
  });

  it('useReportMetadata gated by employee (enabled=false без employee)', async () => {
    useAuthMock.mockReturnValue({ employee: null });
    const { wrapper } = createWrapper();
    renderHook(() => useReportMetadata(), { wrapper });
    await new Promise(r => setTimeout(r, 20));
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('useReportMetadata шле GET /reports/builder/metadata', async () => {
    useAuthMock.mockReturnValue({ employee: { id: '1' } });
    apiFetchMock.mockResolvedValueOnce({ entities: [], enums: {} });
    const { wrapper } = createWrapper();
    renderHook(() => useReportMetadata(), { wrapper });
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    expect(apiFetchMock.mock.calls[0][0]).toBe('/reports/builder/metadata');
  });

  it('useRunReport POST /reports/builder/run з config у body', async () => {
    useAuthMock.mockReturnValue({ employee: { id: '1' } });
    apiFetchMock.mockResolvedValueOnce({
      entity: 'workOrder',
      columns: [],
      groupBy: [],
      result: {},
    });
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useRunReport(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ entity: 'workOrder', columns: ['number'], groupBy: [] });
    });
    expect(apiFetchMock).toHaveBeenCalledWith(
      '/reports/builder/run',
      expect.objectContaining({ method: 'POST' }),
    );
    const body = JSON.parse((apiFetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.config.entity).toBe('workOrder');
    expect(body.config.columns).toEqual(['number']);
  });
});
