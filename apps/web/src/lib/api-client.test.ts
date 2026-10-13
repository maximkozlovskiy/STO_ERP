// Bug #761 regression: URI-версіонування API (/api/v1) — публічні роути мають ДВА контракти:
//   · versioned public (setup, booking) → /api/v1/<path>  (publicFetch)
//   · version-neutral public (public/work-orders — share-лінки кошторису зі SMS/email,
//     бекенд монтує їх під /api/... з VERSION_NEUTRAL) → /api/<path>  (publicNeutralFetch)
// Раніше сторінка /estimate/[token] викликала versioned publicFetch → додавав /api/v1 →
// routing-404 «Cannot GET /api/v1/public/work-orders/...» → публічний кошторис не відкривався.
// Ці тести пінять точний URL-префікс кожного хелпера, щоб регрес не повторився без запуску E2E.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { apiFetch, publicFetch, publicNeutralFetch } from './api-client';

const fetchMock = vi.fn();

describe('api-client public fetch — versioning URL contract (Bug #761)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('publicFetch префіксує /api/v1 (versioned public: setup, booking)', async () => {
    await publicFetch('/setup/status');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toBe('http://localhost:3000/api/v1/setup/status');
    // МУСИТЬ містити /api/v1 — інакше versioned-роут дасть 404
    expect(url).toContain('/api/v1/');
  });

  it('publicNeutralFetch НЕ додає /api/v1 (version-neutral: public/work-orders share-лінк)', async () => {
    await publicNeutralFetch('/public/work-orders/abc123');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toBe('http://localhost:3000/api/public/work-orders/abc123');
    // КРИТИЧНО: version-neutral роут НЕ має нести /v1 — інакше routing-404 «Cannot GET»
    expect(url).not.toContain('/api/v1/');
    expect(url).not.toContain('/v1/');
  });

  it('обидва хелпери прокидають помилку з JSON message при !ok', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      json: async () => ({ message: 'Посилання не дійсне' }),
    } as unknown as Response);
    await expect(publicNeutralFetch('/public/work-orders/bad')).rejects.toThrow(
      'Посилання не дійсне',
    );
  });
});

// Bug #839: індикатор «Офлайн — збереження недоступне» слухає подію `sto:sync-status`, яку
// apiFetch шле, коли fetch кидає. Скасований запит (AbortController) теж кидає — і до виправлення
// перемикав індикатор в «Офлайн», доки не прийде наступна успішна відповідь. Наживо 2026-10-13:
// закрили бокову панель списку, поки вантажилось «Зведення», — індикатор лишився «Офлайн».
describe('apiFetch — статус зв’язку для індикатора (Bug #839)', () => {
  const statuses: string[] = [];
  const onSync = (e: Event) => statuses.push((e as CustomEvent<{ status: string }>).detail.status);

  beforeEach(() => {
    statuses.length = 0;
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    window.addEventListener('sto:sync-status', onSync);
  });

  afterEach(() => {
    window.removeEventListener('sto:sync-status', onSync);
    vi.unstubAllGlobals();
  });

  it('скасований запит (AbortError) НЕ перемикає індикатор в «офлайн»', async () => {
    const ac = new AbortController();
    fetchMock.mockImplementation(() => {
      ac.abort();
      return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
    });
    await expect(
      apiFetch('/work-orders/1/lines-summary', { signal: ac.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(statuses).toEqual([]);
  });

  it('справжній обрив мережі перемикає індикатор в «офлайн», успішна відповідь — назад', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(apiFetch('/work-orders')).rejects.toThrow('Failed to fetch');
    expect(statuses).toEqual(['offline']);

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ items: [] }),
    } as unknown as Response);
    await apiFetch('/work-orders');
    expect(statuses).toEqual(['offline', 'idle']);
  });
});
