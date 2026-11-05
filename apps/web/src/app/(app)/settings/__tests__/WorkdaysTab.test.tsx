// WorkdaysTab — робочі дні й години філії (BR-WO-019, BR-CAL-016). Збереження шле лише поля вкладки:
// `GET /settings/branch/:id` віддає ще branchId, orgId, updatedAt, фіскалізацію й SMS, а сервер
// (`forbidNonWhitelisted`) відкидає незнайомі поля — весь об'єкт давав 400 (Bug #1047).
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import WorkdaysTab from '../WorkdaysTab';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));
vi.mock('@/hooks/useUiFeatures', () => ({
  useUiFeatures: () => ({ toastEnabled: false }),
}));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/ref-cache', () => ({ getCached: () => null, setCache: vi.fn() }));

const BRANCH = 'a1000000-0000-4000-8000-000000000002';
// Відповідь GET — як `mapBranchSettings` на сервері.
const SETTINGS = {
  branchId: BRANCH,
  orgId: 'a1000000-0000-4000-8000-000000000001',
  workStartTime: '08:00',
  workEndTime: '18:00',
  workDays: [1, 2, 3, 4, 5, 6],
  slotDurationMinutes: 60,
  fiscalEnabled: false,
  checkboxApiUrl: null,
  checkboxCashRegisterId: null,
  monobankApiUrl: null,
  hasMonobankToken: false,
  smsEnabled: false,
  smsProvider: null,
  smsSenderName: null,
  updatedAt: '2026-11-05T10:00:00.000Z',
};

function renderTab() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(qc, 'invalidateQueries');
  render(
    <QueryClientProvider client={qc}>
      <WorkdaysTab />
    </QueryClientProvider>,
  );
  return { invalidate };
}

describe('WorkdaysTab — збереження робочих днів', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation((url: string, init?: { method?: string }) => {
      if (url === '/branches') return Promise.resolve([{ id: BRANCH, name: 'Головна філія' }]);
      if (init?.method === 'PATCH') return Promise.resolve(SETTINGS);
      return Promise.resolve(SETTINGS);
    });
  });

  // guards: BR-WO-019
  it('«Зберегти» шле PATCH лише з полями вкладки, без branchId / orgId / updatedAt', async () => {
    const { invalidate } = renderTab();
    await waitFor(() => expect(screen.getByText('Сб')).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByText('Сб'));
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Зберегти'));
    });
    const patch = apiFetchMock.mock.calls.find(c => c[1]?.method === 'PATCH');
    expect(patch).toBeDefined();
    expect(patch![0]).toBe(`/settings/branch/${BRANCH}`);
    const body = JSON.parse(patch![1].body as string) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      'slotDurationMinutes',
      'workDays',
      'workEndTime',
      'workStartTime',
    ]);
    expect(body.workDays).toEqual([1, 2, 3, 4, 5]);
    // Пікер планових дат і сітка календаря перечитують години одразу.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['settings', 'work-hours'] });
  });
});
