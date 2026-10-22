// «Зберегти як» (PDF / xlsx / docx) — назва файла несе номер наряду (запит власника 2026-10-22).
// Сервер дає «Кошторис-<номер>.<формат>» у Content-Disposition; коли заголовка не видно (CORS до
// виправлення, проксі), запасна назва теж має номер, а не голе «Кошторис.xlsx».
import { act, renderHook } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach, afterEach } from 'vitest';

const apiFetchMock = vi.fn();
const downloadBlobMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...a: unknown[]) => apiFetchMock(...a),
  apiBlobFetch: vi.fn(),
}));
vi.mock('@/lib/download', () => ({
  downloadBlob: (...a: unknown[]) => downloadBlobMock(...a),
  printPdf: vi.fn(),
}));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { useWorkOrderActions } from '../useWorkOrderActions';

function setup(woNumber?: string) {
  return renderHook(() =>
    useWorkOrderActions({
      workOrderId: 'wo-1',
      isEditMode: true,
      currentStatus: 'ESTIMATE',
      setCurrentStatus: vi.fn(),
      features: { toastEnabled: false },
      setError: vi.fn(),
      setLinkedDocsRefreshKey: vi.fn(),
      woNumber,
    }),
  );
}

// Відповідь — простий об'єкт, а не `new Response(jsdomBlob)`: Response з undici на різних версіях
// Node по-різному приймає Blob з jsdom (у CI `blob()` відхилявся, хук ловив помилку й мовчав).
function stubExport(disposition: string | null) {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: {
          get: (name: string) =>
            name.toLowerCase() === 'content-disposition' ? disposition : null,
        },
        blob: () => Promise.resolve(new Blob(['x'])),
      }),
    ),
  );
}

describe('useWorkOrderActions — «Зберегти як», назва файла', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    downloadBlobMock.mockReset();
    apiFetchMock.mockImplementation((url: string) =>
      Promise.resolve(url.endsWith('/share-token') ? { token: 't1' } : []),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each(['pdf', 'xlsx', 'docx'] as const)(
    'без Content-Disposition (%s) — запасна назва з номером наряду',
    async format => {
      stubExport(null);
      const { result } = setup('НРД-2026-003055');
      await act(async () => {
        await result.current.handleSaveAs(format);
      });
      expect(downloadBlobMock).toHaveBeenCalledWith(
        expect.any(Blob),
        `Кошторис-НРД-2026-003055.${format}`,
      );
    },
  );

  it('назва із заголовка сервера має перевагу', async () => {
    stubExport(
      `attachment; filename*=UTF-8''${encodeURIComponent('Кошторис-НРД-2026-000001.xlsx')}`,
    );
    const { result } = setup('НРД-2026-003055');
    await act(async () => {
      await result.current.handleSaveAs('xlsx');
    });
    expect(downloadBlobMock).toHaveBeenCalledWith(
      expect.any(Blob),
      'Кошторис-НРД-2026-000001.xlsx',
    );
  });

  it('символи, недозволені в назві файла, замінено', async () => {
    stubExport(null);
    const { result } = setup('НРД/2026:7');
    await act(async () => {
      await result.current.handleSaveAs('pdf');
    });
    expect(downloadBlobMock).toHaveBeenCalledWith(expect.any(Blob), 'Кошторис-НРД-2026-7.pdf');
  });
});
