// «Виставити рахунок» з картки наряду «Виконано» (BR-WO-037): спершу рахунок, потім перехід у
// «Виставлено». Сервер створює рахунок і для «Виконано», а зворотного переходу FSM не має — за
// старого порядку збій створення лишав наряд «Виставлено» без рахунку (Г3, 2026-10-31). `/find`,
// який перезапускає зміна статусу, іде вже після коміту рахунку.
import { act, renderHook, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { vi, it, expect, describe, beforeEach } from 'vitest';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...a: unknown[]) => apiFetchMock(...a),
  apiBlobFetch: vi.fn(),
}));
vi.mock('@/lib/download', () => ({ downloadBlob: vi.fn(), printPdf: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { useWorkOrderActions, WO_TRANSITION_ROLES } from '../useWorkOrderActions';

function setup(role = 'RECEPTIONIST') {
  const setError = vi.fn();
  const view = renderHook(() => {
    const [status, setStatus] = useState('COMPLETED');
    return {
      status,
      ...useWorkOrderActions({
        workOrderId: 'wo-1',
        isEditMode: true,
        currentStatus: status,
        setCurrentStatus: setStatus,
        features: { toastEnabled: false },
        setError,
        setLinkedDocsRefreshKey: vi.fn(),
        role,
      }),
    };
  });
  return { ...view, setError };
}

const CREATE_URL = '/invoices/from-work-order/wo-1';
const urls = () => apiFetchMock.mock.calls.map(c => String(c[0]));
const transitions = () => urls().filter(u => u.endsWith('/transition'));

describe('useWorkOrderActions — «Виставити рахунок»: рахунок, потім перехід', () => {
  beforeEach(() => apiFetchMock.mockReset());

  // guards: BR-WO-037
  it('POST рахунку йде ДО переходу; /find після переходу бачить рахунок', async () => {
    let releaseCreate: (v: { id: string; number: string }) => void = () => {};
    let created = false;
    apiFetchMock.mockImplementation((raw: unknown) => {
      const url = String(raw);
      if (url.endsWith('/find'))
        return Promise.resolve(created ? { id: 'inv-1', number: 'РАХ-1' } : null);
      if (url.endsWith('/transition')) return Promise.resolve({ status: 'INVOICED' });
      if (url === CREATE_URL)
        return new Promise(res => {
          releaseCreate = v => {
            created = true;
            res(v);
          };
        });
      return Promise.resolve(null);
    });

    const { result } = setup();
    await waitFor(() => expect(result.current.canInvoice).toBe(true));
    let creating: Promise<void> = Promise.resolve();
    act(() => {
      creating = result.current.handleInvoice();
    });
    await waitFor(() => expect(urls()).toContain(CREATE_URL));
    // Рахунку ще немає — наряд не переводиться.
    expect(transitions()).toHaveLength(0);

    await act(async () => {
      releaseCreate({ id: 'inv-1', number: 'РАХ-1' });
      await creating;
    });
    expect(urls().indexOf(CREATE_URL)).toBeLessThan(
      urls().findIndex(u => u.endsWith('/transition')),
    );
    await waitFor(() => expect(result.current.status).toBe('INVOICED'));
    await waitFor(() => expect(urls().filter(u => u.endsWith('/find'))).toHaveLength(2));
    expect(result.current.canPrintInvoice).toBe(true);
    expect(result.current.canInvoice).toBe(false);
  });

  // guards: BR-WO-037
  it('збій створення рахунку → наряд лишається «Виконано», переходу немає, кнопку можна повторити', async () => {
    apiFetchMock.mockImplementation((raw: unknown) => {
      const url = String(raw);
      if (url.endsWith('/find')) return Promise.resolve(null);
      if (url.endsWith('/transition')) return Promise.resolve({ status: 'INVOICED' });
      if (url === CREATE_URL) return Promise.reject(new Error('ПДВ наряду не відповідає ставці'));
      return Promise.resolve(null);
    });
    const { result, setError } = setup();
    await waitFor(() => expect(result.current.canInvoice).toBe(true));

    await act(async () => {
      await result.current.handleInvoice();
    });

    expect(transitions()).toHaveLength(0);
    expect(result.current.status).toBe('COMPLETED');
    expect(setError).toHaveBeenCalledWith('ПДВ наряду не відповідає ставці');
    expect(result.current.canInvoice).toBe(true);
  });

  // guards: BR-WO-037
  it('рахунок створено, а перехід відхилено → «Друк рахунку» є, наряд «Виконано», помилка з номером', async () => {
    apiFetchMock.mockImplementation((raw: unknown) => {
      const url = String(raw);
      if (url.endsWith('/find')) return Promise.resolve(null);
      if (url.endsWith('/transition')) return Promise.reject(new Error('Перехід заборонено'));
      if (url === CREATE_URL) return Promise.resolve({ id: 'inv-1', number: 'РАХ-1' });
      return Promise.resolve(null);
    });
    const { result, setError } = setup();
    await waitFor(() => expect(result.current.canInvoice).toBe(true));

    await act(async () => {
      await result.current.handleInvoice();
    });

    expect(result.current.status).toBe('COMPLETED');
    expect(result.current.canPrintInvoice).toBe(true);
    expect(result.current.canInvoice).toBe(false);
    expect(setError).toHaveBeenCalledWith(expect.stringContaining('РАХ-1'));
    expect(setError).toHaveBeenCalledWith(expect.stringContaining('Перехід заборонено'));
  });

  it('«Бухгалтер» (рахунок створює, статус не переводить) — лише POST рахунку, без 403 на переході', async () => {
    apiFetchMock.mockImplementation((raw: unknown) => {
      const url = String(raw);
      if (url.endsWith('/find')) return Promise.resolve(null);
      if (url === CREATE_URL) return Promise.resolve({ id: 'inv-1', number: 'РАХ-1' });
      return Promise.resolve(null);
    });
    const { result, setError } = setup('ACCOUNTANT');
    await waitFor(() => expect(result.current.canInvoice).toBe(true));

    await act(async () => {
      await result.current.handleInvoice();
    });

    expect(transitions()).toHaveLength(0);
    expect(result.current.canPrintInvoice).toBe(true);
    expect(setError).not.toHaveBeenCalled();
  });

  it('WO_TRANSITION_ROLES — дзеркало @Roles на POST /work-orders/:id/transition', () => {
    const src = readFileSync(
      resolve(__dirname, '../../../../api/src/modules/work-orders/work-orders.controller.ts'),
      'utf8',
    );
    const at = src.indexOf("@Post(':id/transition')");
    expect(at).toBeGreaterThan(-1);
    const match = src.slice(at).match(/@Roles\(([^)]*)\)/);
    expect(match).not.toBeNull();
    const roles = (match?.[1] ?? '')
      .split(',')
      .map(r => r.trim().replace(/['"]/g, ''))
      .filter(Boolean)
      .sort();
    expect([...WO_TRANSITION_ROLES].sort()).toEqual(roles);
  });

  // Bug #1033: два кліки в одному такті — два POST рахунку (другий — «вже існує» і діалог конфлікту).
  // Mutation-verify: без `invoiceBusyRef` → два POST рахунку і два /transition.
  it('«Виставити рахунок» двічі в одному такті — один перехід і один POST рахунку', async () => {
    apiFetchMock.mockImplementation((raw: unknown) => {
      const url = String(raw);
      if (url.endsWith('/find')) return Promise.resolve(null);
      if (url.endsWith('/transition')) return Promise.resolve({ status: 'INVOICED' });
      if (url === CREATE_URL) return Promise.resolve({ id: 'inv-1', number: 'РАХ-1' });
      return Promise.resolve(null);
    });
    const { result } = setup();
    await waitFor(() => expect(result.current.canInvoice).toBe(true));
    await act(async () => {
      await Promise.all([result.current.handleInvoice(), result.current.handleInvoice()]);
    });
    expect(transitions()).toHaveLength(1);
    expect(urls().filter(u => u === CREATE_URL)).toHaveLength(1);
  });
});
