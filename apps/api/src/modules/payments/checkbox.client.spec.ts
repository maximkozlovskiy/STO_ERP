import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CheckboxClient, CheckboxUnauthorizedError } from './checkbox.client';

/**
 * ПРРО Крок 2 — CheckboxClient (тонкий HTTP-клієнт Checkbox). Ці тести мокають global fetch і
 * доводять інваріанти безпеки/контракту, яких не бачить жоден інший тест (0 тестів на цей файл):
 *  - signInPinCode → {accessToken}; X-License-Key header; НЕ Bearer.
 *  - openShift/closeShift/sellReceipt → Bearer=accessToken header.
 *  - 401 → CheckboxUnauthorizedError (щоб processor зробив re-sign-in).
 *  - 3xx під redirect:'manual' → reject (SSRF-tampering guard).
 *  - SSRF URL (localhost/приватний) → reject ПЕРЕД fetch (fetch не викликано).
 *  - timeout через AbortController (signal переданий; abort → reject).
 *  - cents-конвертація суми (Math.round, без float-дрейфу).
 */

const OK = (body: unknown, status = 200): Response =>
  ({
    status,
    ok: status >= 200 && status < 300,
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  }) as unknown as Response;

describe('CheckboxClient (ПРРО Крок 2 — HTTP-клієнт)', () => {
  let client: CheckboxClient;
  let fetchMock: ReturnType<typeof vi.fn>;
  const URL = 'https://api.checkbox.ua';

  beforeEach(() => {
    client = new CheckboxClient();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  // ── signInPinCode ──────────────────────────────────────────────────────────
  describe('signInPinCode', () => {
    it('повертає {accessToken} з access_token; X-License-Key header; НЕ Bearer', async () => {
      fetchMock.mockResolvedValueOnce(OK({ access_token: 'tok-123', expires_at: '2030-01-01' }));
      const res = await client.signInPinCode(URL, 'LIC-KEY', '1234');
      expect(res.accessToken).toBe('tok-123');
      expect(res.expiresAt).toBe('2030-01-01');

      const [calledUrl, opts] = fetchMock.mock.calls[0];
      expect(calledUrl).toBe(`${URL}/api/v1/cashier/signinPinCode`);
      expect(opts.headers['X-License-Key']).toBe('LIC-KEY');
      // Sign-in НЕ повинен мати Bearer (токена ще нема).
      expect(opts.headers.Authorization).toBeUndefined();
      // PIN у тілі.
      expect(JSON.parse(opts.body)).toEqual({ pin_code: '1234' });
    });

    it('fallback на res.token якщо access_token відсутній', async () => {
      fetchMock.mockResolvedValueOnce(OK({ token: 'legacy-tok' }));
      const res = await client.signInPinCode(URL, 'LIC', '1');
      expect(res.accessToken).toBe('legacy-tok');
      expect(res.expiresAt).toBeUndefined();
    });

    it('немає токена у відповіді → Error', async () => {
      fetchMock.mockResolvedValueOnce(OK({ foo: 'bar' }));
      await expect(client.signInPinCode(URL, 'LIC', '1')).rejects.toThrow(/access-token/);
    });
  });

  // ── openShift ──────────────────────────────────────────────────────────────
  describe('openShift', () => {
    it('повертає {checkboxShiftId}; Bearer=accessToken', async () => {
      fetchMock.mockResolvedValueOnce(OK({ id: 'shift-abc' }));
      const res = await client.openShift(URL, 'access-tok');
      expect(res.checkboxShiftId).toBe('shift-abc');

      const [calledUrl, opts] = fetchMock.mock.calls[0];
      expect(calledUrl).toBe(`${URL}/api/v1/shifts`);
      expect(opts.headers.Authorization).toBe('Bearer access-tok');
    });

    it('немає id зміни → Error', async () => {
      fetchMock.mockResolvedValueOnce(OK({}));
      await expect(client.openShift(URL, 'tok')).rejects.toThrow(/id зміни/);
    });
  });

  // ── closeShift ─────────────────────────────────────────────────────────────
  describe('closeShift', () => {
    it('повертає zReportId з z_report.id; Bearer=accessToken', async () => {
      fetchMock.mockResolvedValueOnce(OK({ z_report: { id: 'z-1' } }));
      const res = await client.closeShift(URL, 'tok');
      expect(res.zReportId).toBe('z-1');
      expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer tok');
    });

    it('fallback zReportId на res.id', async () => {
      fetchMock.mockResolvedValueOnce(OK({ id: 'shift-id-as-z' }));
      expect((await client.closeShift(URL, 'tok')).zReportId).toBe('shift-id-as-z');
    });

    it('без z-звіту → zReportId undefined (не кидає)', async () => {
      fetchMock.mockResolvedValueOnce(OK({}));
      expect((await client.closeShift(URL, 'tok')).zReportId).toBeUndefined();
    });
  });

  // ── sellReceipt ────────────────────────────────────────────────────────────
  describe('sellReceipt', () => {
    it('повертає {fiscalReceiptId} з res.id; Bearer=accessToken; cash→CASH', async () => {
      fetchMock.mockResolvedValueOnce(OK({ id: 'receipt-1' }));
      const res = await client.sellReceipt(URL, 'tok', { amount: 100, method: 'cash' });
      expect(res.fiscalReceiptId).toBe('receipt-1');

      const [calledUrl, opts] = fetchMock.mock.calls[0];
      expect(calledUrl).toBe(`${URL}/api/v1/receipts/sell`);
      expect(opts.headers.Authorization).toBe('Bearer tok');
      const body = JSON.parse(opts.body);
      expect(body.payments[0].type).toBe('CASH');
    });

    it('non-cash метод → CASHLESS', async () => {
      fetchMock.mockResolvedValueOnce(OK({ id: 'r' }));
      await client.sellReceipt(URL, 'tok', { amount: 50, method: 'card' });
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.payments[0].type).toBe('CASHLESS');
    });

    it('cents = Math.round(amount*100) без float-дрейфу', async () => {
      fetchMock.mockResolvedValueOnce(OK({ id: 'r' }));
      // 35.20*100 = 3519.9999999999995 у IEEE-754 → Math.round → 3520 (не 3519).
      await client.sellReceipt(URL, 'tok', { amount: 35.2, method: 'cash' });
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.payments[0].value).toBe(3520);
      expect(body.goods[0].good.price).toBe(3520);
    });

    it('fallback fiscalReceiptId на fiscal_code', async () => {
      fetchMock.mockResolvedValueOnce(OK({ fiscal_code: 'fc-9' }));
      expect(
        (await client.sellReceipt(URL, 'tok', { amount: 1, method: 'cash' })).fiscalReceiptId,
      ).toBe('fc-9');
    });

    it('немає id чеку → Error', async () => {
      fetchMock.mockResolvedValueOnce(OK({}));
      await expect(client.sellReceipt(URL, 'tok', { amount: 1, method: 'cash' })).rejects.toThrow(
        /id чеку/,
      );
    });

    it('default goodName коли не передано', async () => {
      fetchMock.mockResolvedValueOnce(OK({ id: 'r' }));
      await client.sellReceipt(URL, 'tok', { amount: 1, method: 'cash' });
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.goods[0].good.name).toBe('Послуги автосервісу');
    });
  });

  // ── error mapping ──────────────────────────────────────────────────────────
  describe('HTTP error mapping', () => {
    it('401 → CheckboxUnauthorizedError (для re-sign-in у processor)', async () => {
      fetchMock.mockResolvedValueOnce(OK('unauthorized', 401));
      await expect(client.openShift(URL, 'tok')).rejects.toBeInstanceOf(CheckboxUnauthorizedError);
    });

    it('3xx (redirect під redirect:manual) → reject (SSRF-tampering guard)', async () => {
      fetchMock.mockResolvedValueOnce(OK('', 302));
      await expect(client.openShift(URL, 'tok')).rejects.toThrow(/перенаправлення 302/);
    });

    it('всі 3xx-коди (300..399) відхиляються', async () => {
      for (const status of [300, 301, 307, 308, 399]) {
        fetchMock.mockResolvedValueOnce(OK('', status));
        await expect(client.openShift(URL, 'tok')).rejects.toThrow(/запит відхилено/);
      }
    });

    it('redirect:manual завжди у fetch-опціях (не follow)', async () => {
      fetchMock.mockResolvedValueOnce(OK({ id: 's' }));
      await client.openShift(URL, 'tok');
      expect(fetchMock.mock.calls[0][1].redirect).toBe('manual');
    });

    it('non-ok 500 → Error з тілом', async () => {
      fetchMock.mockResolvedValueOnce(OK('internal boom', 500));
      await expect(client.openShift(URL, 'tok')).rejects.toThrow(/Checkbox 500: internal boom/);
    });

    it('порожнє тіло на 200 → {} (не JSON.parse crash)', async () => {
      fetchMock.mockResolvedValueOnce(OK('', 200));
      // openShift кине бо нема id — але не з SyntaxError JSON.parse, а з «id зміни».
      await expect(client.openShift(URL, 'tok')).rejects.toThrow(/id зміни/);
    });
  });

  // ── SSRF guard ─────────────────────────────────────────────────────────────
  describe('SSRF guard (validatePublicUrl ПЕРЕД fetch)', () => {
    it('localhost URL → reject ПЕРЕД fetch (fetch не викликано)', async () => {
      await expect(client.openShift('http://localhost:8080', 'tok')).rejects.toThrow(
        /Невалідний Checkbox API URL/,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('приватна IP (169.254 metadata) → reject ПЕРЕД fetch', async () => {
      await expect(client.signInPinCode('http://169.254.169.254', 'l', 'p')).rejects.toThrow(
        /Невалідний Checkbox API URL/,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('RFC1918 (10.x) → reject; non-http схема → reject', async () => {
      await expect(client.openShift('http://10.0.0.5', 'tok')).rejects.toThrow(/Невалідний/);
      await expect(client.openShift('file:///etc/passwd', 'tok')).rejects.toThrow(/Невалідний/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('порожній apiUrl → fallback на DEFAULT_BASE (публічний, дозволений)', async () => {
      fetchMock.mockResolvedValueOnce(OK({ id: 's' }));
      await client.openShift('', 'tok');
      expect(fetchMock.mock.calls[0][0]).toBe('https://api.checkbox.ua/api/v1/shifts');
    });
  });

  // ── timeout (AbortController) ────────────────────────────────────────────────
  describe('timeout через AbortController', () => {
    it('передає signal у fetch і clearTimeout по завершенню', async () => {
      fetchMock.mockResolvedValueOnce(OK({ id: 's' }));
      await client.openShift(URL, 'tok');
      expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    });

    it('abort по таймауту → fetch reject → помилка пробрасується', async () => {
      // fetch, що реджектиться лише коли signal.abort() спрацював.
      fetchMock.mockImplementationOnce(
        (_url: string, opts: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            opts.signal.addEventListener('abort', () =>
              reject(new DOMException('The operation was aborted', 'AbortError')),
            );
          }),
      );
      vi.useFakeTimers();
      const p = client.openShift(URL, 'tok');
      const assertion = expect(p).rejects.toThrow(/aborted/);
      // прокрутити таймер за поріг SYNC_TIMEOUT_MS (10s).
      await vi.advanceTimersByTimeAsync(10_001);
      await assertion;
    });
  });
});
