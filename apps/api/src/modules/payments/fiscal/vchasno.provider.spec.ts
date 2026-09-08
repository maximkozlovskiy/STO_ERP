import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VchasnoProvider } from './vchasno.provider';
import { FiscalUnauthorizedError } from './fiscal-provider.interface';
import type { FiscalConfig } from './fiscal-provider.interface';

/**
 * Вчасно.Каса Cloud API v3 — контракт транспорту (звірено з офіц. wiki + Postman):
 *  - ЄДИНИЙ endpoint POST /api/v3/fiscal/execute (dispatcher), не REST-per-operation
 *  - операція = `task`-код у `{ fiscal: { task, ... } }` (0 open / 1 sell / 11 close / 18 status)
 *  - Auth: `Authorization: <token>` БЕЗ префікса `Bearer`
 *  - reject-3xx, 401/403 → FiscalUnauthorizedError
 * Регресія проти попереднього (хибного) v1 REST + Bearer shape.
 */
describe('VchasnoProvider — Cloud API v3 dispatcher', () => {
  let provider: VchasnoProvider;
  let fetchMock: ReturnType<typeof vi.fn>;
  const cfg: FiscalConfig = {
    apiUrl: 'https://kasa.vchasno.ua',
    credentials: { token: 'TKN-123' },
  };

  const okJson = (body: unknown) =>
    ({
      status: 200,
      ok: true,
      text: () => Promise.resolve(JSON.stringify(body)),
    }) as unknown as Response;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    provider = new VchasnoProvider();
  });
  afterEach(() => vi.unstubAllGlobals());

  const lastCall = () => fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
  const lastBody = () => JSON.parse(lastCall()[1].body);

  it("усі операції б'ють у єдиний POST /api/v3/fiscal/execute", async () => {
    fetchMock.mockResolvedValue(okJson({ shift_id: 's1' }));
    await provider.openShift(cfg, 'TKN-123');
    const [url, init] = lastCall();
    expect(url).toBe('https://kasa.vchasno.ua/api/v3/fiscal/execute');
    expect(init.method).toBe('POST');
  });

  it('Auth-заголовок — СИРИЙ токен без префікса Bearer', async () => {
    fetchMock.mockResolvedValue(okJson({ shift_id: 's1' }));
    await provider.openShift(cfg, 'TKN-123');
    expect(lastCall()[1].headers.Authorization).toBe('TKN-123');
    expect(lastCall()[1].headers.Authorization).not.toMatch(/bearer/i);
  });

  it('openShift → task:0, повертає providerShiftId', async () => {
    fetchMock.mockResolvedValue(okJson({ shift_id: 'SH-9' }));
    const r = await provider.openShift(cfg, 'TKN-123');
    expect(lastBody().fiscal.task).toBe(0);
    expect(r.providerShiftId).toBe('SH-9');
  });

  it('closeShift → task:11, повертає zReportId', async () => {
    fetchMock.mockResolvedValue(okJson({ z_report_id: 'Z-7' }));
    const r = await provider.closeShift(cfg, 'TKN-123');
    expect(lastBody().fiscal.task).toBe(11);
    expect(r.zReportId).toBe('Z-7');
  });

  it('sellReceipt → task:1, копійки int, повертає fiscalReceiptId', async () => {
    fetchMock.mockResolvedValue(okJson({ fisn: 'RCPT-42' }));
    const r = await provider.sellReceipt(cfg, 'TKN-123', { amount: 150.5, method: 'card' });
    const body = lastBody().fiscal;
    expect(body.task).toBe(1);
    expect(body.goods[0].price).toBe(15050); // 150.50 грн → копійки
    expect(body.payment).toEqual({ type: 'CASHLESS', value: 15050 });
    expect(r.fiscalReceiptId).toBe('RCPT-42');
  });

  it("sellReceipt method='cash' → payment.type CASH", async () => {
    fetchMock.mockResolvedValue(okJson({ fisn: 'RCPT-1' }));
    await provider.sellReceipt(cfg, 'TKN-123', { amount: 10, method: 'cash' });
    expect(lastBody().fiscal.payment.type).toBe('CASH');
  });

  it('verifyCredentials → task:18, valid:true + назва каси', async () => {
    fetchMock.mockResolvedValue(okJson({ cash_register: { name: 'Каса №1' } }));
    const r = await provider.verifyCredentials(cfg);
    expect(lastBody().fiscal.task).toBe(18);
    expect(r).toEqual({ valid: true, cashRegisterName: 'Каса №1' });
  });

  it('401 → FiscalUnauthorizedError (openShift)', async () => {
    fetchMock.mockResolvedValue({
      status: 401,
      ok: false,
      text: () => Promise.resolve(''),
    } as never);
    await expect(provider.openShift(cfg, 'TKN-123')).rejects.toBeInstanceOf(
      FiscalUnauthorizedError,
    );
  });

  it('verifyCredentials на 401 → valid:false «Невірний API-токен»', async () => {
    fetchMock.mockResolvedValue({
      status: 403,
      ok: false,
      text: () => Promise.resolve(''),
    } as never);
    const r = await provider.verifyCredentials(cfg);
    expect(r).toEqual({ valid: false, error: 'Невірний API-токен' });
  });

  it('3xx-перенаправлення відхиляється (SSRF/redirect guard)', async () => {
    fetchMock.mockResolvedValue({
      status: 302,
      ok: false,
      text: () => Promise.resolve(''),
    } as never);
    await expect(provider.openShift(cfg, 'TKN-123')).rejects.toThrow(/перенаправлення/);
    expect(lastCall()[1].redirect).toBe('manual');
  });

  it('відсутній токен у кредах → помилка', async () => {
    await expect(
      provider.verifyCredentials({ apiUrl: null, credentials: {} } as FiscalConfig),
    ).resolves.toEqual({ valid: false, error: 'Вчасно: не задано API-токен' });
  });
});
