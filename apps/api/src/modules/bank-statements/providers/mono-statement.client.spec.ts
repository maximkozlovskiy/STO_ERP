import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MonoStatementClient } from './mono-statement.client';

/**
 * MonoStatementClient — тонкий HTTP-клієнт monobank personal statement. Доводимо: WINDOWING
 * (≤31-денні шматки), X-Token заголовок, Unix-секунди у path, SSRF-reject приватного URL,
 * AbortController timeout, reject-3xx, redact токена у тексті помилки. Rate-limit sleep — fake-timers
 * (тест не чекає 60с реально).
 */
describe('MonoStatementClient', () => {
  let client: MonoStatementClient;
  let fetchMock: ReturnType<typeof vi.fn>;

  const okResponse = (body: unknown, status = 200): Response =>
    ({
      status,
      ok: status >= 200 && status < 300,
      text: async () => JSON.stringify(body),
    }) as unknown as Response;

  beforeEach(() => {
    client = new MonoStatementClient();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const baseArgs = {
    token: 'PERSONAL-TOKEN',
    account: '0',
    from: new Date(Date.UTC(2026, 8, 1)),
    to: new Date(Date.UTC(2026, 8, 20)), // 19 днів → 1 вікно
  };

  it('надсилає X-Token та Unix-секунди у path (одне вікно)', async () => {
    fetchMock.mockResolvedValue(okResponse([]));
    await client.fetchStatements(baseArgs);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/personal/statement/0/');
    expect(init.method).toBe('GET');
    expect(init.headers['X-Token']).toBe('PERSONAL-TOKEN');
    // Unix-секунди: from = 2026-09-01 UTC.
    const fromSec = Math.floor(Date.UTC(2026, 8, 1) / 1000);
    const toSec = Math.floor(Date.UTC(2026, 8, 20) / 1000);
    expect(url).toContain(`/${fromSec}/${toSec}`);
  });

  it('WINDOWING: 60-денне вікно → ≥2 шматки ≤31 день кожен, результати обʼєднуються', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(okResponse([{ id: 'a', time: 1, amount: 100 }]))
      .mockResolvedValueOnce(okResponse([{ id: 'b', time: 2, amount: 200 }]));

    const args = {
      ...baseArgs,
      from: new Date(Date.UTC(2026, 6, 1)),
      to: new Date(Date.UTC(2026, 7, 30)), // ~60 днів → 2 вікна (31 + 29)
    };
    const promise = client.fetchStatements(args);
    // Rate-limit пауза 60с між шматками — прокручуємо таймери.
    await vi.runAllTimersAsync();
    const rows = await promise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(rows.map(r => r.id)).toEqual(['a', 'b']);
    // Кожен шматок ≤31 день: різниця toSec-fromSec у path ≤ 31*86400.
    for (const call of fetchMock.mock.calls) {
      const m = /\/personal\/statement\/0\/(\d+)\/(\d+)/.exec(call[0] as string);
      expect(m).not.toBeNull();
      const span = Number(m![2]) - Number(m![1]);
      expect(span).toBeLessThanOrEqual(31 * 24 * 60 * 60);
    }
  });

  it('WINDOWING: суміжні вікна — from другого = to першого (без розривів/накладок)', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(okResponse([]));
    const args = {
      ...baseArgs,
      from: new Date(Date.UTC(2026, 6, 1)),
      to: new Date(Date.UTC(2026, 7, 30)),
    };
    const promise = client.fetchStatements(args);
    await vi.runAllTimersAsync();
    await promise;

    const first = /\/statement\/0\/(\d+)\/(\d+)/.exec(fetchMock.mock.calls[0][0] as string)!;
    const second = /\/statement\/0\/(\d+)\/(\d+)/.exec(fetchMock.mock.calls[1][0] as string)!;
    expect(second[1]).toBe(first[2]); // from2 === to1
  });

  it('одне вікно (≤31 день) → без rate-limit паузи (не чекає 60с)', async () => {
    // Без fake-timers: якби була пауза, тест завис би. 1 вікно → 0 пауз.
    fetchMock.mockResolvedValue(okResponse([{ id: 'x', time: 1, amount: 50 }]));
    const rows = await client.fetchStatements(baseArgs);
    expect(rows).toHaveLength(1);
  });

  it('WINDOWING: рівно 31 день → 1 шматок (без зайвого другого вікна)', async () => {
    // Точна межа WINDOW_MS=31д. cursor+31д === end → один шматок, cursor доходить до end, цикл стоп.
    // Без fake-timers: 1 вікно = 0 пауз (якби було 2 → зависло б на sleep(60с)).
    fetchMock.mockResolvedValue(okResponse([]));
    await client.fetchStatements({
      ...baseArgs,
      from: new Date(Date.UTC(2026, 0, 1)),
      to: new Date(Date.UTC(2026, 0, 1) + 31 * 24 * 60 * 60 * 1000),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('WINDOWING: from == to → 1 вироджене вікно, 1 запит (без падіння/циклу)', async () => {
    // Інвертований/нульовий діапазон (from>=to) → splitWindows повертає [{from,to}] → 1 запит.
    fetchMock.mockResolvedValue(okResponse([]));
    const day = new Date(Date.UTC(2026, 5, 15));
    const rows = await client.fetchStatements({ ...baseArgs, from: day, to: day });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(rows).toEqual([]);
    const [url] = fetchMock.mock.calls[0];
    // fromSec === toSec (порожнє вікно), без NaN у path.
    const m = /\/statement\/0\/(\d+)\/(\d+)/.exec(url as string)!;
    expect(m[1]).toBe(m[2]);
  });

  it('WINDOWING: 90-денне вікно → 3 суміжні шматки без розривів/накладок', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(okResponse([]));
    const promise = client.fetchStatements({
      ...baseArgs,
      from: new Date(Date.UTC(2026, 0, 1)),
      to: new Date(Date.UTC(2026, 0, 1) + 90 * 24 * 60 * 60 * 1000),
    });
    await vi.runAllTimersAsync();
    await promise;
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // Ланцюг суміжності: from[i+1] === to[i] для всіх шматків (без gap/overlap на межах).
    const bounds = fetchMock.mock.calls.map(c => {
      const m = /\/statement\/0\/(\d+)\/(\d+)/.exec(c[0] as string)!;
      return { from: m[1], to: m[2] };
    });
    expect(bounds[1].from).toBe(bounds[0].to);
    expect(bounds[2].from).toBe(bounds[1].to);
    // Останній шматок закінчується рівно на to (без втрати хвоста).
    const toSec = Math.floor((Date.UTC(2026, 0, 1) + 90 * 24 * 60 * 60 * 1000) / 1000);
    expect(Number(bounds[2].to)).toBe(toSec);
  });

  it('SSRF: приватний apiUrl → кидає, fetch не викликається', async () => {
    await expect(
      client.fetchStatements({ ...baseArgs, apiUrl: 'http://169.254.169.254' }),
    ).rejects.toThrow(/URL/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('timeout: fetch abort → проброс помилки', async () => {
    fetchMock.mockRejectedValue(new Error('The operation was aborted'));
    await expect(client.fetchStatements(baseArgs)).rejects.toThrow(/aborted/i);
  });

  it('reject-3xx: перенаправлення відхиляється', async () => {
    fetchMock.mockResolvedValue(okResponse({}, 302));
    await expect(client.fetchStatements(baseArgs)).rejects.toThrow(/перенаправлення|302/);
  });

  it('порожня відповідь (текст "") → 0 проводок, без throw', async () => {
    fetchMock.mockResolvedValue({
      status: 200,
      ok: true,
      text: async () => '',
    } as unknown as Response);
    const rows = await client.fetchStatements(baseArgs);
    expect(rows).toEqual([]);
  });

  it('не-масив відповідь (обʼєкт помилки) → 0 проводок', async () => {
    fetchMock.mockResolvedValue(okResponse({ errorDescription: 'unknown account' }));
    const rows = await client.fetchStatements(baseArgs);
    expect(rows).toEqual([]);
  });

  it('redact: токен не витікає у текст помилки', async () => {
    fetchMock.mockResolvedValue({
      status: 403,
      ok: false,
      text: async () => 'forbidden token=PERSONAL-TOKEN',
    } as unknown as Response);
    await expect(client.fetchStatements(baseArgs)).rejects.toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining('PERSONAL-TOKEN'),
      }),
    );
  });
});
