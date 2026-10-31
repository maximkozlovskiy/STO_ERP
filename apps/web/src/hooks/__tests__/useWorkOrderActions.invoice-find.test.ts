// «Виставити рахунок» з картки наряду «Виконано» (BR-WO-037): кнопка спершу переводить наряд у
// «Виставлено», і зміна статусу перезапускає `GET …/find` паралельно зі створенням рахунку. Відповідь
// `/find`, прочитана ДО коміту POST («рахунку немає»), не має затерти щойно створений рахунок:
// інакше «Друк рахунку» зникав, а «Виставити рахунок» з'являвся знову (review Г3, 2026-10-31).
import { act, renderHook, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { vi, it, expect, describe, beforeEach } from 'vitest';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...a: unknown[]) => apiFetchMock(...a),
  apiBlobFetch: vi.fn(),
}));
vi.mock('@/lib/download', () => ({ downloadBlob: vi.fn(), printPdf: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { useWorkOrderActions } from '../useWorkOrderActions';

function setup() {
  return renderHook(() => {
    const [status, setStatus] = useState('COMPLETED');
    return useWorkOrderActions({
      workOrderId: 'wo-1',
      isEditMode: true,
      currentStatus: status,
      setCurrentStatus: setStatus,
      features: { toastEnabled: false },
      setError: vi.fn(),
      setLinkedDocsRefreshKey: vi.fn(),
      role: 'RECEPTIONIST',
    });
  });
}

describe('useWorkOrderActions — «Виставити рахунок» і повторний /find', () => {
  beforeEach(() => apiFetchMock.mockReset());

  // guards: BR-WO-037
  it('пізня відповідь /find «рахунку немає» не затирає щойно створений рахунок', async () => {
    let findCalls = 0;
    let releaseLateFind: (v: null) => void = () => {};
    let releaseCreate: (v: { id: string; number: string }) => void = () => {};
    apiFetchMock.mockImplementation((raw: unknown) => {
      const url = String(raw);
      if (url.endsWith('/find')) {
        findCalls += 1;
        // Перший /find (статус «Виконано») — одразу «немає»; другий (після переходу) — пізно.
        if (findCalls === 1) return Promise.resolve(null);
        return new Promise<null>(resolve => {
          releaseLateFind = resolve;
        });
      }
      if (url.endsWith('/transition')) return Promise.resolve({ status: 'INVOICED' });
      if (url === '/invoices/from-work-order/wo-1')
        return new Promise(resolve => {
          releaseCreate = resolve;
        });
      return Promise.resolve(null);
    });

    const { result } = setup();
    await waitFor(() => expect(result.current.canInvoice).toBe(true));

    let creating: Promise<void> = Promise.resolve();
    act(() => {
      creating = result.current.handleInvoice();
    });
    // Перехід у «Виставлено» вже відбувся — другий /find у польоті, POST рахунку ще ні.
    await waitFor(() => expect(findCalls).toBe(2));
    await act(async () => {
      releaseCreate({ id: 'inv-1', number: 'РАХ-1' });
      await creating;
    });
    expect(result.current.canPrintInvoice).toBe(true);

    await act(async () => {
      releaseLateFind(null);
      await Promise.resolve();
    });
    expect(result.current.canPrintInvoice).toBe(true);
    expect(result.current.canInvoice).toBe(false);
  });

  // Bug #1033: два кліки в одному такті — два переходи «Виконано» → «Виставлено» (другий — 400 і тост).
  // Mutation-verify: без `invoiceBusyRef` → два POST /transition.
  it('«Виставити рахунок» двічі в одному такті — один перехід і один POST рахунку', async () => {
    apiFetchMock.mockImplementation((raw: unknown) => {
      const url = String(raw);
      if (url.endsWith('/find')) return Promise.resolve(null);
      if (url.endsWith('/transition')) return Promise.resolve({ status: 'INVOICED' });
      if (url === '/invoices/from-work-order/wo-1')
        return Promise.resolve({ id: 'inv-1', number: 'РАХ-1' });
      return Promise.resolve(null);
    });
    const { result } = setup();
    await waitFor(() => expect(result.current.canInvoice).toBe(true));
    await act(async () => {
      await Promise.all([result.current.handleInvoice(), result.current.handleInvoice()]);
    });
    const urls = apiFetchMock.mock.calls.map(c => String(c[0]));
    expect(urls.filter(u => u.endsWith('/transition'))).toHaveLength(1);
    expect(urls.filter(u => u === '/invoices/from-work-order/wo-1')).toHaveLength(1);
  });
});
