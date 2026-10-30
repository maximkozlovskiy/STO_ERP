// Bug #761 regression: URI-версіонування API (/api/v1) — публічні роути мають ДВА контракти:
//   · versioned public (setup, booking) → /api/v1/<path>  (publicFetch)
//   · version-neutral public (public/work-orders — share-лінки кошторису зі SMS/email,
//     бекенд монтує їх під /api/... з VERSION_NEUTRAL) → /api/<path>  (publicNeutralFetch)
// Раніше сторінка /estimate/[token] викликала versioned publicFetch → додавав /api/v1 →
// routing-404 «Cannot GET /api/v1/public/work-orders/...» → публічний кошторис не відкривався.
// Ці тести пінять точний URL-префікс кожного хелпера, щоб регрес не повторився без запуску E2E.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  apiBlobFetch,
  apiFetch,
  apiMultipartFetch,
  NetworkError,
  publicFetch,
  publicNeutralFetch,
} from './api-client';
import i18n from '@/i18n/config';
import { TOKEN_KEY } from './auth';

const fetchMock = vi.fn();
const NETWORK_UK = "Немає зв'язку з сервером — перевірте мережу й спробуйте ще раз";

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
    await expect(apiFetch('/work-orders')).rejects.toThrow(NETWORK_UK);
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

// Security block Stage 2: /auth/refresh is no longer @SkipThrottle (owner decision 2026-10-24,
// 30/min). tryRefresh() is invoked from 3 sites (apiFetch/apiBlobFetch/apiMultipartFetch) on 401.
// A burst of concurrent 401s (several TanStack queries re-firing after one access-token expiry)
// must NOT fan out into N parallel POST /auth/refresh — that can exceed 30/min → 429 → forced
// logout mid-session. A module-level single in-flight refresh promise collapses the burst into
// ONE network request. Mutation-check: drop `if (refreshInFlight) return refreshInFlight;` and the
// "refresh called exactly once" assertion fails (each caller fires its own POST).
describe('apiFetch — дедуплікація паралельних refresh (Security Stage 2, 30/min)', () => {
  let releaseRefresh: (token: string) => void;

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    sessionStorage.setItem(TOKEN_KEY, 'stale-access-token');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  const count401 = () =>
    fetchMock.mock.calls.filter(c => String(c[0]).endsWith('/auth/refresh')).length;

  it('N паралельних 401 → рівно ОДИН POST /auth/refresh, усі отримують новий токен', async () => {
    const refreshPending = new Promise<string>(resolve => {
      releaseRefresh = resolve;
    });

    fetchMock.mockImplementation((url: string) => {
      if (String(url).endsWith('/auth/refresh')) {
        // refresh «висить», доки тест не відпустить — моделює одночасні in-flight виклики
        return refreshPending.then(
          token =>
            ({ ok: true, status: 200, json: async () => ({ accessToken: token }) }) as Response,
        );
      }
      // Перший удар (stale токен) → 401; після refresh (повторний запит) → 200 з даними.
      const auth = (fetchMock.mock.calls.at(-1)?.[1] as RequestInit | undefined)?.headers as
        Record<string, string> | undefined;
      const bearer = auth?.['Authorization'];
      if (bearer === 'Bearer fresh-token') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ ok: true }),
        } as unknown as Response);
      }
      return Promise.resolve({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        json: async () => ({ message: 'Unauthorized' }),
      } as unknown as Response);
    });

    const callers = [
      apiFetch<{ ok: boolean }>('/work-orders'),
      apiFetch<{ ok: boolean }>('/invoices'),
      apiFetch<{ ok: boolean }>('/counterparties'),
    ];
    // Дати всім трьом дійти до 401 і стати в чергу на СПІЛЬНИЙ refresh promise.
    await Promise.resolve();
    await new Promise(r => setTimeout(r, 0));

    releaseRefresh!('fresh-token');
    const results = await Promise.all(callers);

    // Ключова асерція (мутаційна): рівно один мережевий refresh на весь burst.
    expect(count401()).toBe(1);
    expect(results).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    // Токен у сесії оновлено спільним refresh-ом.
    expect(sessionStorage.getItem(TOKEN_KEY)).toBe('fresh-token');
  });

  it('після завершення refresh наступний 401 стартує СВІЖИЙ refresh', async () => {
    // Перший цикл: 401 → refresh(fresh-1) → retry 200.
    const seq: Array<() => Response> = [
      () => ({ ok: false, status: 401, statusText: '', json: async () => ({}) }) as Response,
      () => ({ ok: true, status: 200, json: async () => ({ accessToken: 'fresh-1' }) }) as Response,
      () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }) as Response,
      () => ({ ok: false, status: 401, statusText: '', json: async () => ({}) }) as Response,
      () => ({ ok: true, status: 200, json: async () => ({ accessToken: 'fresh-2' }) }) as Response,
      () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }) as Response,
    ];
    let i = 0;
    fetchMock.mockImplementation(() => Promise.resolve(seq[i++]!()));

    await apiFetch('/work-orders');
    await apiFetch('/invoices');

    // Два окремих у часі 401 → два окремих refresh-и (in-flight promise очищено після settle).
    expect(count401()).toBe(2);
  });
});

// Bug #966 (регресія security Stage 2): /auth/refresh тепер throttled (30/хв), а не @SkipThrottle.
// Коли дата-запит ловить 401, а наступний POST /auth/refresh повертає 429 (вичерпано ліміт з
// одного IP у кількапотоковому прогоні), клієнт НЕ сміє clearToken()+redirect на /login:
// throttle — тимчасовий, сесія жива. Кидаємо помилку, щоб TanStack Query повторив запит, і
// лишаємо токен на місці. Мутаційна перевірка: приберіть гілку `if (newToken === THROTTLED)`
// — тоді 429 падає у `else` (clearToken + location.replace('/login')), токен зникає, і
// редірект відбувається → обидві асерції валяться.
describe('apiFetch — 429 на refresh не вивалює сесію (Bug #966)', () => {
  let replaceSpy: ReturnType<typeof vi.fn>;
  let originalLocation: Location;

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    sessionStorage.setItem(TOKEN_KEY, 'valid-but-just-expired');
    // location.replace мокаємо, щоб довести: редіректу на /login немає.
    originalLocation = window.location;
    replaceSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, replace: replaceSpy },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    sessionStorage.clear();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: originalLocation,
    });
  });

  it('401 → refresh 429: кидає тимчасову помилку, токен лишається, редіректу на /login немає', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).endsWith('/auth/refresh')) {
        // throttle: refresh відмовляє тимчасово, НЕ 401.
        return Promise.resolve({
          ok: false,
          status: 429,
          statusText: 'Too Many Requests',
          json: async () => ({ message: 'ThrottlerException: Too Many Requests' }),
        } as unknown as Response);
      }
      // дата-запит зі stale токеном → 401.
      return Promise.resolve({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        json: async () => ({ message: 'Unauthorized' }),
      } as unknown as Response);
    });

    await expect(apiFetch('/work-orders')).rejects.toThrow(/перевантажений/);
    // Токен НЕ стертий — сесія жива, запит можна повторити.
    expect(sessionStorage.getItem(TOKEN_KEY)).toBe('valid-but-just-expired');
    // Форсованого виходу на /login немає.
    expect(replaceSpy).not.toHaveBeenCalled();
  });
});

// TECH-DEBT §8 L802: обрив зв'язку — TypeError браузера з англійським текстом («Failed to fetch»,
// «Load failed»); місця, що показують `e.message`, друкували його людині. Обгортки api-client
// перекладають його в NetworkError мовою інтерфейсу; скасований запит (AbortError) — як є.
// Mutation-verify: у `fetchOrNetworkError` прокинути `err` замість `new NetworkError(err)` —
// падають кейси перекладу; прибрати перевірку `isAbortError` — падає кейс AbortError.
describe('api-client — мережева помилка мовою інтерфейсу', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await i18n.changeLanguage('uk');
  });

  it.each([
    ['apiFetch', () => apiFetch('/work-orders')],
    ['apiBlobFetch', () => apiBlobFetch('/work-orders/1/pdf')],
    ['apiMultipartFetch', () => apiMultipartFetch('/files', new FormData())],
    ['publicFetch', () => publicFetch('/booking/branches')],
    ['publicNeutralFetch', () => publicNeutralFetch('/public/work-orders/abc')],
  ])('%s: «Failed to fetch» → NetworkError українською, оригінал у cause', async (_name, call) => {
    const original = new TypeError('Failed to fetch');
    fetchMock.mockRejectedValue(original);
    const err = await call().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect((err as Error).message).toBe(NETWORK_UK);
    expect((err as Error).message).not.toMatch(/fetch/i);
    expect((err as Error).cause).toBe(original);
  });

  it('мова інтерфейсу en → англійський текст ключа, не текст браузера', async () => {
    await i18n.changeLanguage('en');
    fetchMock.mockRejectedValue(new TypeError('Load failed'));
    await expect(apiFetch('/work-orders')).rejects.toThrow(
      'No connection to the server — check the network and try again',
    );
  });

  it('скасований запит (AbortError) прокидається як є, без перекладу', async () => {
    const ac = new AbortController();
    fetchMock.mockImplementation(() => {
      ac.abort();
      return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
    });
    const err = await apiFetch('/work-orders', { signal: ac.signal }).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(NetworkError);
    expect(err).toMatchObject({ name: 'AbortError' });
  });
});
