// BR-WO-032: «Поділитись» у картці наряду — посилання з датою згорання, «Згенерувати нове» й
// «Відкликати». Сервер: POST /work-orders/:id/share-token видає чинний токен (або новий, якщо старий
// прострочений чи відкликаний), DELETE — відкликає.
import { act, renderHook } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';

const apiFetchMock = vi.fn();
const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...a: unknown[]) => apiFetchMock(...a),
  apiBlobFetch: vi.fn(),
}));
vi.mock('@/lib/download', () => ({ downloadBlob: vi.fn(), printPdf: vi.fn() }));
vi.mock('@/lib/toast', () => ({
  toast: {
    error: (...a: unknown[]) => toastError(...a),
    success: (...a: unknown[]) => toastSuccess(...a),
  },
}));

import { useWorkOrderActions } from '../useWorkOrderActions';

const EXPIRES = '2026-11-23T10:00:00.000Z';
const URL_ = '/work-orders/wo-1/share-token';

function setup(workOrderId = 'wo-1') {
  return renderHook(
    ({ id }: { id: string }) =>
      useWorkOrderActions({
        workOrderId: id,
        isEditMode: true,
        currentStatus: 'ESTIMATE',
        setCurrentStatus: vi.fn(),
        features: { toastEnabled: true },
        setError: vi.fn(),
        setLinkedDocsRefreshKey: vi.fn(),
      }),
    { initialProps: { id: workOrderId } },
  );
}

/** Сервер-двійник: POST видає чинний токен або новий після DELETE. */
function fakeServer() {
  let current: string | null = null;
  let n = 0;
  apiFetchMock.mockImplementation((url: string, init?: { method?: string }) => {
    if (url !== URL_) return Promise.resolve([]);
    if (init?.method === 'DELETE') {
      current = null;
      return Promise.resolve({ token: null, expiresAt: null });
    }
    current ??= `tok-${++n}`;
    return Promise.resolve({ token: current, expiresAt: EXPIRES });
  });
}

const calls = () =>
  apiFetchMock.mock.calls
    .filter(([url]) => url === URL_)
    .map(([, init]) => (init as { method: string }).method);

describe('useWorkOrderActions — посилання на кошторис (BR-WO-032)', () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  beforeEach(() => {
    apiFetchMock.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();
    writeText.mockClear();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    fakeServer();
  });

  // guards: BR-WO-032
  it('«Поділитись»: посилання з датою згорання, панель відкрита, адресу скопійовано', async () => {
    const { result } = setup();

    await act(async () => {
      await result.current.handleShare();
    });

    expect(result.current.shareLink).toEqual({
      status: 'active',
      token: 'tok-1',
      expiresAt: EXPIRES,
    });
    expect(result.current.shareOpen).toBe(true);
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/estimate/tok-1`);
  });

  // guards: BR-WO-032
  it('«Відкликати»: DELETE, панель показує «відкликано»', async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.handleShare();
    });

    await act(async () => {
      await result.current.handleRevokeShare();
    });

    expect(calls()).toEqual(['POST', 'DELETE']);
    expect(result.current.shareLink).toEqual({ status: 'revoked' });
    expect(toastSuccess).toHaveBeenLastCalledWith('Посилання відкликано');
  });

  // guards: BR-WO-032
  it('«Згенерувати нове» на чинному посиланні: спершу відкликає старе, потім видає нове', async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.handleShare();
    });

    await act(async () => {
      await result.current.handleRegenerateShare();
    });

    expect(calls()).toEqual(['POST', 'DELETE', 'POST']);
    expect(result.current.shareLink).toMatchObject({ status: 'active', token: 'tok-2' });
    expect(writeText).toHaveBeenLastCalledWith(`${window.location.origin}/estimate/tok-2`);
  });

  // guards: BR-WO-032
  it('«Згенерувати нове» після відкликання: лише POST', async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.handleShare();
    });
    await act(async () => {
      await result.current.handleRevokeShare();
    });

    await act(async () => {
      await result.current.handleRegenerateShare();
    });

    expect(calls()).toEqual(['POST', 'DELETE', 'POST']);
    expect(result.current.shareLink).toMatchObject({ status: 'active', token: 'tok-2' });
  });

  it('буфер обміну недоступний — посилання все одно в панелі, без помилки', async () => {
    writeText.mockRejectedValueOnce(new Error('NotAllowedError'));
    const { result } = setup();

    await act(async () => {
      await result.current.handleShare();
    });

    expect(result.current.shareOpen).toBe(true);
    expect(result.current.shareLink).toMatchObject({ status: 'active', token: 'tok-1' });
    expect(toastError).not.toHaveBeenCalled();
  });

  it('відкликання не вдалося — посилання лишається чинним, помилка в тості', async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.handleShare();
    });
    apiFetchMock.mockRejectedValueOnce(new Error('Недостатньо прав'));

    await act(async () => {
      await result.current.handleRevokeShare();
    });

    expect(result.current.shareLink).toMatchObject({ status: 'active', token: 'tok-1' });
    expect(toastError).toHaveBeenCalledWith('Недостатньо прав');
  });

  it('інший наряд у тій самій картці — панель закрита, посилання попереднього не показується', async () => {
    const { result, rerender } = setup();
    await act(async () => {
      await result.current.handleShare();
    });

    rerender({ id: 'wo-2' });

    expect(result.current.shareOpen).toBe(false);
    expect(result.current.shareLink).toBeNull();
  });
});
