import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Privat24Client } from './privat24.client';

/**
 * Privat24Client — тонкий HTTP-клієнт statements. Доводимо: DD-MM-YYYY дати, заголовки id+token,
 * followId-пагінація (2 сторінки), SSRF-reject приватного URL, AbortController timeout, redact
 * секретів у тексті помилки.
 */
describe('Privat24Client', () => {
  let client: Privat24Client;
  let fetchMock: ReturnType<typeof vi.fn>;

  const okResponse = (body: unknown, status = 200): Response =>
    ({
      status,
      ok: status >= 200 && status < 300,
      text: async () => JSON.stringify(body),
    }) as unknown as Response;

  beforeEach(() => {
    client = new Privat24Client();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const baseArgs = {
    id: 'MERCH1',
    token: 'SECRET-TOKEN',
    iban: 'UA213223130000026007233566001',
    from: new Date(Date.UTC(2026, 8, 1)), // 01-09-2026
    to: new Date(Date.UTC(2026, 8, 20)), // 20-09-2026
  };

  it('надсилає заголовки id+token та дати DD-MM-YYYY', async () => {
    fetchMock.mockResolvedValue(okResponse({ transactions: [], exist_next_page: false }));
    await client.fetchTransactions(baseArgs);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/statements/transactions');
    expect(init.method).toBe('POST');
    expect(init.headers.id).toBe('MERCH1');
    expect(init.headers.token).toBe('SECRET-TOKEN');
    const body = JSON.parse(init.body);
    expect(body.startDate).toBe('01-09-2026');
    expect(body.endDate).toBe('20-09-2026');
    expect(body.acc).toBe(baseArgs.iban);
  });

  it('followId-пагінація: 2 сторінки → об’єднаний масив, followId переданий на 2-у сторінку', async () => {
    fetchMock
      .mockResolvedValueOnce(
        okResponse({
          transactions: [{ REF: 'A' }],
          exist_next_page: true,
          next_page_id: 'CURSOR2',
        }),
      )
      .mockResolvedValueOnce(okResponse({ transactions: [{ REF: 'B' }], exist_next_page: false }));

    const rows = await client.fetchTransactions(baseArgs);
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.REF)).toEqual(['A', 'B']);
    // 2-й запит несе followId=CURSOR2.
    const body2 = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body2.followId).toBe('CURSOR2');
  });

  it('SSRF: приватний apiUrl → кидає, fetch не викликається', async () => {
    await expect(
      client.fetchTransactions({ ...baseArgs, apiUrl: 'http://169.254.169.254/api' }),
    ).rejects.toThrow(/URL/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('timeout: fetch abort → проброс помилки', async () => {
    fetchMock.mockRejectedValue(new Error('The operation was aborted'));
    await expect(client.fetchTransactions(baseArgs)).rejects.toThrow(/aborted/i);
  });

  it('reject-3xx: перенаправлення відхиляється', async () => {
    fetchMock.mockResolvedValue(okResponse({}, 302));
    await expect(client.fetchTransactions(baseArgs)).rejects.toThrow(/перенаправлення|302/);
  });

  it('redact: секрети id/token не витікають у текст помилки', async () => {
    fetchMock.mockResolvedValue({
      status: 401,
      ok: false,
      text: async () => 'auth failed for id=MERCH1 token=SECRET-TOKEN',
    } as unknown as Response);
    await expect(client.fetchTransactions(baseArgs)).rejects.toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining('SECRET-TOKEN'),
      }),
    );
  });
});
