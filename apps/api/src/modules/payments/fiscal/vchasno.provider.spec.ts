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

  // Bug #708 (money-correctness guard): копійки = Math.round(amount*100) — жоден із
  // «підступних» IEEE-754 дробів не має дрейфнути на ±1 коп, і goods.price МУСИТЬ дорівнювати
  // payment.value (інакше Вчасно відхилить чек як незбалансований). Дзеркалить CheckboxClient
  // (той самий Math.round(amount*100)) — money-мапінг обох провайдерів однаковий.
  describe('Bug #708: копійки без IEEE-754 дрейфу + goods/payment баланс', () => {
    // [amount, очікувані копійки] — класичні пастки представлення float.
    const cases: Array<[number, number]> = [
      [0.1 + 0.2, 30], // 0.30000000000000004 → 30 (не 30.0000…→31)
      [35.2, 3520], // 3520.0000000000005 → 3520
      [8.61, 861], // 860.9999999999999 → 861
      [1.005, 100], // 100.49999999999999 → 100 у сирому JS (round-half float-артефакт) — фіксуємо факт
      [19.99, 1999],
      [0.01, 1], // мінімальна копійка
      [1234567.89, 123456789], // велика сума — 123456788.99999999 → 123456789
      [999999.99, 99999999],
    ];
    it.each(cases)('amount=%d → %d коп (goods.price == payment.value)', async (amount, cents) => {
      fetchMock.mockResolvedValue(okJson({ fisn: 'RCPT-X' }));
      await provider.sellReceipt(cfg, 'TKN-123', { amount, method: 'card_terminal' });
      const body = lastBody().fiscal;
      expect(body.goods[0].price).toBe(cents);
      expect(body.payment.value).toBe(cents);
      // Баланс чека: сума позицій (price*quantity) == сума оплати.
      expect(body.goods[0].price * body.goods[0].quantity).toBe(body.payment.value);
    });
  });

  // Bug #708: CASH ⇔ CASHLESS для ВСІХ методів оплати системи (seed PaymentMethodConfig +
  // *_qr online). Лише 'cash' → CASH; усе інше (термінал/переказ/будь-який QR) → CASHLESS.
  describe('Bug #708: мапінг усіх методів оплати системи → CASH/CASHLESS', () => {
    const methods: Array<[string, 'CASH' | 'CASHLESS']> = [
      ['cash', 'CASH'],
      ['card_terminal', 'CASHLESS'],
      ['bank_transfer', 'CASHLESS'],
      ['privat24_qr', 'CASHLESS'],
      ['monobank_qr', 'CASHLESS'],
      ['liqpay_qr', 'CASHLESS'],
    ];
    it.each(methods)("method='%s' → payment.type='%s'", async (method, type) => {
      fetchMock.mockResolvedValue(okJson({ fisn: 'RCPT-M' }));
      await provider.sellReceipt(cfg, 'TKN-123', { amount: 100, method });
      expect(lastBody().fiscal.payment.type).toBe(type);
    });
  });

  // Bug #708: відповідь без жодного кандидат-ключа id ({} або порожнє тіло) → sellReceipt/
  // openShift МУСЯТЬ кинути чітку помилку, а НЕ повернути undefined як receipt id (інакше
  // undefined протік би у Payment.fiscalReceiptId → чек «є», а насправді ні).
  describe('Bug #708: порожня/безідентифікаторна відповідь → чітка помилка (не undefined-id)', () => {
    it('sellReceipt на {} → кидає «не отримано id чеку»', async () => {
      fetchMock.mockResolvedValue(okJson({}));
      await expect(
        provider.sellReceipt(cfg, 'TKN-123', { amount: 10, method: 'cash' }),
      ).rejects.toThrow(/не отримано id чеку/);
    });
    it('openShift на порожнє тіло (200, text="") → кидає «не отримано id зміни»', async () => {
      fetchMock.mockResolvedValue({
        status: 200,
        ok: true,
        text: () => Promise.resolve(''),
      } as never);
      await expect(provider.openShift(cfg, 'TKN-123')).rejects.toThrow(/не отримано id зміни/);
    });
    it('sellReceipt на відповідь без жодного кандидат-ключа ({other:1}) → кидає', async () => {
      fetchMock.mockResolvedValue(okJson({ other: 1, nested: { fisn: 'ignored-deep' } }));
      await expect(
        provider.sellReceipt(cfg, 'TKN-123', { amount: 10, method: 'cash' }),
      ).rejects.toThrow(/не отримано id чеку/);
    });
    it('extractId читає з обгортки {fiscal:{...}}', async () => {
      fetchMock.mockResolvedValue(okJson({ fiscal: { fisn: 'WRAPPED-42' } }));
      const r = await provider.sellReceipt(cfg, 'TKN-123', { amount: 10, method: 'cash' });
      expect(r.fiscalReceiptId).toBe('WRAPPED-42');
    });
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
