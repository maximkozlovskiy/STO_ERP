import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MonobankStatementProvider } from './monobank-statement.provider';
import type { MonoStatementClient } from './mono-statement.client';
import type { BankStatementConfig } from './bank-provider.interface';

/**
 * MonobankStatementProvider.mapTx — ЗАХИСНА нормалізація StatementItem → RawTx.
 * MONEY-CRITICAL: amount у мінор-одиницях → ÷100 (15000→150.00). Доводимо: credit-фільтр
 * (amount≤0 → skip), мапінг counter*→payer*, time*1000→date, purpose=comment??description,
 * skip без id, verifyCredentials auth-помилка → invalid.
 */
describe('MonobankStatementProvider', () => {
  let provider: MonobankStatementProvider;
  let client: { fetchStatements: ReturnType<typeof vi.fn> };
  const cfg: BankStatementConfig = { apiUrl: null, credentials: { token: 'T', accountId: '0' } };
  const params = { iban: 'UA1', from: new Date(), to: new Date() };

  beforeEach(() => {
    client = { fetchStatements: vi.fn() };
    provider = new MonobankStatementProvider(client as unknown as MonoStatementClient);
  });

  it('MONEY-CRITICAL: amount у мінор-одиницях ÷100 (15000 → 150.00)', async () => {
    client.fetchStatements.mockResolvedValue([
      { id: 'm1', time: 1757060000, amount: 15000, comment: 'оплата' },
    ]);
    const rows = await provider.fetchStatements(cfg, params);
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe(150.0);
    expect(rows[0].externalId).toBe('m1');
    expect(rows[0].purpose).toBe('оплата');
  });

  it('credit-фільтр: amount≤0 (debit від’ємний / нуль) → skip', async () => {
    client.fetchStatements.mockResolvedValue([
      { id: 'in', time: 1757060000, amount: 5000 }, // ✓ вхідний
      { id: 'out', time: 1757060000, amount: -5000 }, // ✗ debit
      { id: 'zero', time: 1757060000, amount: 0 }, // ✗ нуль
    ]);
    const rows = await provider.fetchStatements(cfg, params);
    expect(rows.map(r => r.externalId)).toEqual(['in']);
    expect(rows[0].amount).toBe(50.0);
  });

  it('мапінг counterName→payerName, counterIban→payerIban, counterEdrpou→payerEdrpou', async () => {
    client.fetchStatements.mockResolvedValue([
      {
        id: 'm2',
        time: 1757060000,
        amount: 10000,
        counterName: 'ТОВ Ромашка',
        counterIban: 'UA9988',
        counterEdrpou: '12345678',
      },
    ]);
    const rows = await provider.fetchStatements(cfg, params);
    expect(rows[0].payerName).toBe('ТОВ Ромашка');
    expect(rows[0].payerIban).toBe('UA9988');
    expect(rows[0].payerEdrpou).toBe('12345678');
  });

  it('time (Unix секунди) * 1000 → коректний Date', async () => {
    client.fetchStatements.mockResolvedValue([{ id: 'm3', time: 1757060000, amount: 100 }]);
    const rows = await provider.fetchStatements(cfg, params);
    expect(rows[0].operationDate.getTime()).toBe(1757060000 * 1000);
  });

  it('purpose = comment ?? description (fallback на description)', async () => {
    client.fetchStatements.mockResolvedValue([
      { id: 'has-comment', time: 1757060000, amount: 100, comment: 'C', description: 'D' },
      { id: 'no-comment', time: 1757060000, amount: 100, description: 'лише опис' },
    ]);
    const rows = await provider.fetchStatements(cfg, params);
    expect(rows.find(r => r.externalId === 'has-comment')!.purpose).toBe('C');
    expect(rows.find(r => r.externalId === 'no-comment')!.purpose).toBe('лише опис');
  });

  it('defensive: проводка без id → skip (не кидає)', async () => {
    client.fetchStatements.mockResolvedValue([
      { time: 1757060000, amount: 100 }, // немає id → skip
      { id: 'ok', time: 1757060000, amount: 100 },
    ]);
    const rows = await provider.fetchStatements(cfg, params);
    expect(rows.map(r => r.externalId)).toEqual(['ok']);
  });

  it('defensive: невалідний time → skip', async () => {
    client.fetchStatements.mockResolvedValue([
      { id: 'bad-time', time: NaN, amount: 100 },
      { id: 'good', time: 1757060000, amount: 100 },
    ]);
    const rows = await provider.fetchStatements(cfg, params);
    expect(rows.map(r => r.externalId)).toEqual(['good']);
  });

  it('rawData зберігає повний сирий item', async () => {
    const item = { id: 'm4', time: 1757060000, amount: 100, extra: 'x' };
    client.fetchStatements.mockResolvedValue([item]);
    const rows = await provider.fetchStatements(cfg, params);
    expect(rows[0].rawData).toEqual(item);
  });

  it('params.iban НЕ передається клієнту (mono ідентифікує через accountId)', async () => {
    client.fetchStatements.mockResolvedValue([]);
    await provider.fetchStatements(cfg, { ...params, iban: 'UA-ІГНОР' });
    const arg = client.fetchStatements.mock.calls[0][0];
    expect(arg.account).toBe('0');
    expect(arg.token).toBe('T');
    expect(JSON.stringify(arg)).not.toContain('UA-ІГНОР');
  });

  it('accountId дефолт "0" якщо не задано у кредах', async () => {
    client.fetchStatements.mockResolvedValue([]);
    await provider.fetchStatements({ apiUrl: null, credentials: { token: 'T' } }, params);
    expect(client.fetchStatements.mock.calls[0][0].account).toBe('0');
  });

  it('creds: відсутній token → fetchStatements кидає', async () => {
    await expect(
      provider.fetchStatements({ apiUrl: null, credentials: {} }, params),
    ).rejects.toThrow(/токен/i);
  });

  it('порожня відповідь (0 проводок) → []', async () => {
    client.fetchStatements.mockResolvedValue([]);
    const rows = await provider.fetchStatements(cfg, params);
    expect(rows).toEqual([]);
  });

  it('verifyCredentials: успіх → valid:true', async () => {
    client.fetchStatements.mockResolvedValue([]);
    const res = await provider.verifyCredentials(cfg);
    expect(res.valid).toBe(true);
  });

  it('verifyCredentials: 401 auth-помилка → valid:false', async () => {
    client.fetchStatements.mockRejectedValue(new Error('monobank 401: invalid token'));
    const res = await provider.verifyCredentials(cfg);
    expect(res.valid).toBe(false);
    expect(res.error).toBeTruthy();
  });
});
