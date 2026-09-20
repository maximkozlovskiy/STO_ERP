import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Privat24Provider } from './privat24.provider';
import type { Privat24Client } from './privat24.client';
import type { BankStatementConfig } from './bank-provider.interface';

/**
 * Privat24Provider.mapTx — ЗАХИСНА нормалізація сирого рядка Privat → RawTx.
 * Доводимо: фільтр напряму (TRANTYPE credit/debit), skip рядка без REF, парсинг дати/суми,
 * fallback-ключі, verifyCredentials (auth-помилка → invalid).
 */
describe('Privat24Provider', () => {
  let provider: Privat24Provider;
  let client: { fetchTransactions: ReturnType<typeof vi.fn> };
  const cfg: BankStatementConfig = { apiUrl: null, credentials: { merchantId: 'M', token: 'T' } };
  const params = { iban: 'UA1', from: new Date(), to: new Date() };

  beforeEach(() => {
    client = { fetchTransactions: vi.fn() };
    provider = new Privat24Provider(client as unknown as Privat24Client);
  });

  it('TRANTYPE-фільтр: лише credit (C) залишається, debit (D) відкидається', async () => {
    client.fetchTransactions.mockResolvedValue([
      { REF: 'in-1', TRANTYPE: 'C', SUM: '100.50', DAT_OD: '05.09.2026', OSND: 'оплата' },
      { REF: 'out-1', TRANTYPE: 'D', SUM: '200', DAT_OD: '05.09.2026', OSND: 'видача' },
    ]);
    const rows = await provider.fetchStatements(cfg, params);
    expect(rows).toHaveLength(1);
    expect(rows[0].externalId).toBe('in-1');
    expect(rows[0].amount).toBe(100.5);
    expect(rows[0].purpose).toBe('оплата');
  });

  it('defensive: рядок без REF/id → skip (не кидає)', async () => {
    client.fetchTransactions.mockResolvedValue([
      { TRANTYPE: 'C', SUM: '10', DAT_OD: '05.09.2026' }, // немає REF → skip
      { REF: 'ok', TRANTYPE: 'C', SUM: '20', DAT_OD: '05.09.2026' },
    ]);
    const rows = await provider.fetchStatements(cfg, params);
    expect(rows.map(r => r.externalId)).toEqual(['ok']);
  });

  it('defensive: невалідна сума/дата → skip рядка', async () => {
    client.fetchTransactions.mockResolvedValue([
      { REF: 'bad-sum', TRANTYPE: 'C', SUM: 'abc', DAT_OD: '05.09.2026' },
      { REF: 'bad-date', TRANTYPE: 'C', SUM: '10', DAT_OD: 'not-a-date' },
      { REF: 'good', TRANTYPE: 'C', SUM: '10', DAT_OD: '05.09.2026' },
    ]);
    const rows = await provider.fetchStatements(cfg, params);
    expect(rows.map(r => r.externalId)).toEqual(['good']);
  });

  it('fallback-ключі: lower-case ref/amount/direction=in теж працюють', async () => {
    client.fetchTransactions.mockResolvedValue([
      { ref: 'lc-1', direction: 'in', amount: 55, date: '2026-09-05T10:00:00Z' },
    ]);
    const rows = await provider.fetchStatements(cfg, params);
    expect(rows).toHaveLength(1);
    expect(rows[0].externalId).toBe('lc-1');
    expect(rows[0].amount).toBe(55);
  });

  it('parseDate: DD.MM.YYYY → коректний UTC Date', async () => {
    client.fetchTransactions.mockResolvedValue([
      { REF: 'd', TRANTYPE: 'C', SUM: '1', DAT_OD: '15.03.2026 14:30:00' },
    ]);
    const rows = await provider.fetchStatements(cfg, params);
    expect(rows[0].operationDate.toISOString()).toBe('2026-03-15T14:30:00.000Z');
  });

  it('rawData зберігає повний сирий рядок', async () => {
    const raw = { REF: 'r', TRANTYPE: 'C', SUM: '1', DAT_OD: '05.09.2026', extra: 'x' };
    client.fetchTransactions.mockResolvedValue([raw]);
    const rows = await provider.fetchStatements(cfg, params);
    expect(rows[0].rawData).toEqual(raw);
  });

  it('порожня відповідь (0 рядків) → []', async () => {
    client.fetchTransactions.mockResolvedValue([]);
    const rows = await provider.fetchStatements(cfg, params);
    expect(rows).toEqual([]);
  });

  it('змішаний батч: валідні лишаються, биті (без REF / debit / битий amount) відкидаються', async () => {
    client.fetchTransactions.mockResolvedValue([
      { REF: 'ok-1', TRANTYPE: 'C', SUM: '100', DAT_OD: '05.09.2026' }, // ✓
      { TRANTYPE: 'C', SUM: '50', DAT_OD: '05.09.2026' }, // ✗ без REF
      { REF: 'debit-1', TRANTYPE: 'D', SUM: '200', DAT_OD: '05.09.2026' }, // ✗ debit
      { REF: 'ok-2', TRANTYPE: 'C', SUM: '75.25', DAT_OD: '06.09.2026' }, // ✓
      { REF: 'bad-amt', TRANTYPE: 'C', SUM: '0', DAT_OD: '06.09.2026' }, // ✗ amount<=0
      { REF: 'neg', TRANTYPE: 'C', SUM: '-10', DAT_OD: '06.09.2026' }, // ✗ від'ємна
    ]);
    const rows = await provider.fetchStatements(cfg, params);
    expect(rows.map(r => r.externalId)).toEqual(['ok-1', 'ok-2']);
  });

  it("amount=0 та амаунт від'ємний → skip (лише додатні надходження)", async () => {
    client.fetchTransactions.mockResolvedValue([
      { REF: 'z', TRANTYPE: 'C', SUM: '0.00', DAT_OD: '05.09.2026' },
      { REF: 'n', TRANTYPE: 'C', SUM: '-5', DAT_OD: '05.09.2026' },
    ]);
    const rows = await provider.fetchStatements(cfg, params);
    expect(rows).toEqual([]);
  });

  it('parseDate: DD-MM-YYYY (дефіси) теж парситься', async () => {
    client.fetchTransactions.mockResolvedValue([
      { REF: 'dash', TRANTYPE: 'C', SUM: '1', DAT_OD: '15-03-2026' },
    ]);
    const rows = await provider.fetchStatements(cfg, params);
    expect(rows[0].operationDate.toISOString()).toBe('2026-03-15T00:00:00.000Z');
  });

  it('creds: відсутній token → fetchStatements кидає', async () => {
    await expect(
      provider.fetchStatements({ apiUrl: null, credentials: { merchantId: 'M' } }, params),
    ).rejects.toThrow(/токен|ID/i);
  });

  it('verifyCredentials: успіх → valid:true', async () => {
    client.fetchTransactions.mockResolvedValue([]);
    const res = await provider.verifyCredentials(cfg);
    expect(res.valid).toBe(true);
  });

  it('verifyCredentials: auth-помилка → valid:false', async () => {
    client.fetchTransactions.mockRejectedValue(new Error('Privat24 401: invalid token'));
    const res = await provider.verifyCredentials(cfg);
    expect(res.valid).toBe(false);
    expect(res.error).toBeTruthy();
  });
});
