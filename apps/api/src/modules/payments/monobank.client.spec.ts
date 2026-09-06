import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MonobankClient } from './monobank.client';

/**
 * QR-оплата monobank — MonobankClient (тонкий HTTP-клієнт). Тести мокають global fetch і
 * доводять MONEY/security-інваріанти, яких не бачив жоден інший тест (файл мав 0 тестів):
 *  - createInvoice → {gatewayInvoiceId,pageUrl}; відсутні поля → throw.
 *  - getStatus мапінг: success→paid, failure/reversed→failed, expired→expired, інше→pending.
 *  - X-Token header присутній (auth); НЕ Bearer.
 *  - SSRF URL (localhost/приватний) → reject ПЕРЕД fetch (fetch не викликано).
 *  - 3xx під redirect:'manual' → reject (SSRF-tampering guard).
 *  - AbortController timeout (signal переданий; abort → reject).
 *  - cents-конвертація (createIntent робить Math.round; тут передаємо amountCents як є).
 */

const OK = (body: unknown, status = 200): Response =>
  ({
    status,
    ok: status >= 200 && status < 300,
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  }) as unknown as Response;

describe('MonobankClient (QR-оплата — HTTP-клієнт)', () => {
  let client: MonobankClient;
  let fetchMock: ReturnType<typeof vi.fn>;
  const URL = 'https://api.monobank.ua';

  beforeEach(() => {
    client = new MonobankClient();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  // ── createInvoice ────────────────────────────────────────────────────────────
  describe('createInvoice', () => {
    it('повертає {gatewayInvoiceId,pageUrl}; X-Token header; POST на invoice/create', async () => {
      fetchMock.mockResolvedValueOnce(OK({ invoiceId: 'inv-1', pageUrl: 'https://pay.mono/x' }));
      const res = await client.createInvoice(URL, 'MERCH-TOK', {
        amountCents: 15000,
        reference: 'intent-1',
      });
      expect(res.gatewayInvoiceId).toBe('inv-1');
      expect(res.pageUrl).toBe('https://pay.mono/x');

      const [calledUrl, opts] = fetchMock.mock.calls[0];
      expect(calledUrl).toBe(`${URL}/api/merchant/invoice/create`);
      expect(opts.method).toBe('POST');
      expect(opts.headers['X-Token']).toBe('MERCH-TOK');
      // Auth — X-Token merchant, НЕ Bearer.
      expect(opts.headers.Authorization).toBeUndefined();
      const body = JSON.parse(opts.body);
      expect(body.amount).toBe(15000);
      expect(body.ccy).toBe(980); // UAH default
      expect(body.merchantPaymInfo.reference).toBe('intent-1');
    });

    it('явний ccy передається', async () => {
      fetchMock.mockResolvedValueOnce(OK({ invoiceId: 'i', pageUrl: 'p' }));
      await client.createInvoice(URL, 'T', { amountCents: 1, reference: 'r', ccy: 840 });
      expect(JSON.parse(fetchMock.mock.calls[0][1].body).ccy).toBe(840);
    });

    it('відсутній invoiceId → throw (не мовчазний undefined)', async () => {
      fetchMock.mockResolvedValueOnce(OK({ pageUrl: 'https://pay.mono/x' }));
      await expect(
        client.createInvoice(URL, 'T', { amountCents: 1, reference: 'r' }),
      ).rejects.toThrow(/invoiceId\/pageUrl/);
    });

    it('відсутній pageUrl → throw', async () => {
      fetchMock.mockResolvedValueOnce(OK({ invoiceId: 'inv-1' }));
      await expect(
        client.createInvoice(URL, 'T', { amountCents: 1, reference: 'r' }),
      ).rejects.toThrow(/invoiceId\/pageUrl/);
    });

    it('порожнє тіло → throw (не JSON.parse crash)', async () => {
      fetchMock.mockResolvedValueOnce(OK('', 200));
      await expect(
        client.createInvoice(URL, 'T', { amountCents: 1, reference: 'r' }),
      ).rejects.toThrow(/invoiceId\/pageUrl/);
    });

    it('null apiUrl → дефолтна база api.monobank.ua', async () => {
      fetchMock.mockResolvedValueOnce(OK({ invoiceId: 'i', pageUrl: 'p' }));
      await client.createInvoice(null, 'T', { amountCents: 1, reference: 'r' });
      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://api.monobank.ua/api/merchant/invoice/create',
      );
    });
  });

  // ── getStatus мапінг ─────────────────────────────────────────────────────────
  describe('getStatus — мапінг monobank-статусу у нормалізований', () => {
    const cases: Array<[string, string]> = [
      ['success', 'paid'],
      ['failure', 'failed'],
      ['reversed', 'failed'],
      ['expired', 'expired'],
      ['created', 'pending'],
      ['processing', 'pending'],
      ['hold', 'pending'],
      ['whatever-unknown', 'pending'],
    ];
    for (const [mono, mapped] of cases) {
      it(`${mono} → ${mapped}`, async () => {
        fetchMock.mockResolvedValueOnce(OK({ status: mono }));
        const res = await client.getStatus(URL, 'T', 'inv-1');
        expect(res.status).toBe(mapped);
        expect(res.raw).toBe(mono);
      });
    }

    it('відсутній status у відповіді → raw "unknown" → pending (не крашить)', async () => {
      fetchMock.mockResolvedValueOnce(OK({}));
      const res = await client.getStatus(URL, 'T', 'inv-1');
      expect(res.status).toBe('pending');
      expect(res.raw).toBe('unknown');
    });

    it('GET на invoice/status з encoded invoiceId; X-Token header', async () => {
      fetchMock.mockResolvedValueOnce(OK({ status: 'created' }));
      await client.getStatus(URL, 'MERCH-TOK', 'inv/with space');
      const [calledUrl, opts] = fetchMock.mock.calls[0];
      expect(calledUrl).toBe(
        `${URL}/api/merchant/invoice/status?invoiceId=${encodeURIComponent('inv/with space')}`,
      );
      expect(opts.method).toBe('GET');
      expect(opts.headers['X-Token']).toBe('MERCH-TOK');
    });
  });

  // ── SSRF guard ──────────────────────────────────────────────────────────────
  describe('SSRF guard (validatePublicUrl ПЕРЕД fetch)', () => {
    it('localhost → reject ПЕРЕД fetch (fetch не викликано)', async () => {
      await expect(
        client.createInvoice('http://localhost:8080', 'T', { amountCents: 1, reference: 'r' }),
      ).rejects.toThrow(/monobank API URL/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('приватна IP (169.254.169.254 cloud metadata) → reject ПЕРЕД fetch', async () => {
      await expect(client.getStatus('http://169.254.169.254', 'T', 'inv')).rejects.toThrow(
        /monobank API URL/,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('RFC1918 10.x → reject', async () => {
      await expect(
        client.createInvoice('http://10.0.0.5', 'T', { amountCents: 1, reference: 'r' }),
      ).rejects.toThrow(/monobank API URL/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('file:// схема → reject', async () => {
      await expect(client.getStatus('file:///etc/passwd', 'T', 'inv')).rejects.toThrow(
        /monobank API URL/,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  // ── HTTP error mapping ───────────────────────────────────────────────────────
  describe('HTTP error mapping', () => {
    it('3xx під redirect:manual → reject (SSRF-tampering guard)', async () => {
      fetchMock.mockResolvedValueOnce(OK('', 302));
      await expect(client.getStatus(URL, 'T', 'inv')).rejects.toThrow(/перенаправлення 302/);
    });

    it('усі 3xx (300..399) відхиляються', async () => {
      for (const status of [300, 301, 307, 308, 399]) {
        fetchMock.mockResolvedValueOnce(OK('', status));
        await expect(client.getStatus(URL, 'T', 'inv')).rejects.toThrow(/запит відхилено/);
      }
    });

    it('redirect:manual завжди у fetch-опціях', async () => {
      fetchMock.mockResolvedValueOnce(OK({ status: 'created' }));
      await client.getStatus(URL, 'T', 'inv');
      expect(fetchMock.mock.calls[0][1].redirect).toBe('manual');
    });

    it('non-ok 500 → Error з тілом', async () => {
      fetchMock.mockResolvedValueOnce(OK('gateway boom', 500));
      await expect(client.getStatus(URL, 'T', 'inv')).rejects.toThrow(/monobank 500: gateway boom/);
    });
  });

  // ── timeout ──────────────────────────────────────────────────────────────────
  describe('AbortController timeout', () => {
    it('signal переданий у fetch', async () => {
      fetchMock.mockResolvedValueOnce(OK({ status: 'created' }));
      await client.getStatus(URL, 'T', 'inv');
      expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    });

    it('abort після HTTP_TIMEOUT_MS → reject (fetch відхиляється по signal)', async () => {
      vi.useFakeTimers();
      // fetch резолвиться коли signal аборт — імітуємо реальну поведінку fetch.
      fetchMock.mockImplementationOnce(
        (_url: string, opts: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            opts.signal.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            );
          }),
      );
      const p = client.getStatus(URL, 'T', 'inv');
      // прикріпити catch одразу — щоб не було unhandled rejection під час advanceTimers.
      const expectation = expect(p).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(10_001);
      await expectation;
    });
  });
});
