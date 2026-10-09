import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MonobankStatementProvider } from './monobank-statement.provider';
import type { MonoStatementClient } from './mono-statement.client';
import type { BankStatementConfig } from './bank-provider.interface';

/**
 * MonobankStatementProvider.mapTx — ЗАХИСНА нормалізація StatementItem → RawTx.
 * MONEY-CRITICAL: amount у мінор-одиницях → ÷100 (15000→150.00). Доводимо: напрям за знаком суми
 * (від'ємна → OUT з модулем, нуль / NaN → skip), мапінг counter*→payer*, time → київський
 * календарний день, purpose=comment??description, skip без id, verifyCredentials auth-помилка → invalid.
 *
 * Кейси BR-BANK-019 / 020 / 021 написано ДО реалізації вихідних платежів (2026-10-09).
 * Mutation-verify: (1) повернути `minor <= 0 → skip` → «напрям за знаком суми»; (2) не брати модуль →
 * той самий кейс (сума −50); (3) `new Date(time * 1000)` без переведення в київський день →
 * «київський день операції: … о 01:30»; (4) хардкод +03:00 → зимові рядки того самого кейсу.
 */

/** Напрям рядка. У RawTx на момент написання тестів поля ще немає — його додає реалізація. */
const directionOf = (row: unknown): unknown => (row as { direction?: unknown }).direction;

describe('MonobankStatementProvider', () => {
  let provider: MonobankStatementProvider;
  let client: { fetchStatements: ReturnType<typeof vi.fn> };
  const cfg: BankStatementConfig = { apiUrl: null, credentials: { token: 'T', accountId: '0' } };
  const params = { iban: 'UA1', from: new Date(), to: new Date() };

  beforeEach(() => {
    client = { fetchStatements: vi.fn() };
    provider = new MonobankStatementProvider(client as unknown as MonoStatementClient);
  });

  // guards: BR-BANK-013
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

  // guards: BR-BANK-013
  it('MONEY-CRITICAL: credit-межа minor=1 → 0.01 проходить (не губимо копійку)', async () => {
    // Найменша можлива вхідна проводка: 1 копійка. Фільтр minor>0 → проходить; ÷100 → 0.01.
    client.fetchStatements.mockResolvedValue([{ id: 'penny', time: 1757060000, amount: 1 }]);
    const rows = await provider.fetchStatements(cfg, params);
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe(0.01);
  });

  it('MONEY-CRITICAL: amount як рядок "15000" (JSON-coerce) → 150.00, не ламає мапінг', async () => {
    // Захисна нормалізація: Number("15000")=15000. Якби mono колись віддав amount рядком —
    // не має тихо давати NaN/skip чи неправильну суму.
    client.fetchStatements.mockResolvedValue([
      { id: 'str', time: 1757060000, amount: '15000' as unknown as number },
    ]);
    const rows = await provider.fetchStatements(cfg, params);
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe(150.0);
  });

  it('defensive: amount нечисловий рядок "abc" → NaN → skip (не 0-грн проводка)', async () => {
    client.fetchStatements.mockResolvedValue([
      { id: 'bad', time: 1757060000, amount: 'abc' as unknown as number },
      { id: 'ok', time: 1757060000, amount: 500 },
    ]);
    const rows = await provider.fetchStatements(cfg, params);
    expect(rows.map(r => r.externalId)).toEqual(['ok']);
  });

  // Переписано 2026-10-09 (BR-BANK-019 уточнює BR-BANK-013): раніше кейс закріплював
  // «amount ≤ 0 → skip». Тепер від'ємна сума — вихідний платіж (модуль / 100); нуль і далі пропускається.
  // guards: BR-BANK-017, BR-BANK-019
  it('напрям за знаком суми: додатна → IN, від’ємна → OUT з модулем / 100; нуль пропускається', async () => {
    client.fetchStatements.mockResolvedValue([
      { id: 'in', time: 1757060000, amount: 5000 }, // вхідний
      { id: 'out', time: 1757060000, amount: -5000 }, // вихідний
      { id: 'zero', time: 1757060000, amount: 0 }, // нуль — не платіж
      { id: 'out-penny', time: 1757060000, amount: -1 }, // найменший вихідний: 1 копійка
    ]);
    const rows = await provider.fetchStatements(cfg, params);
    expect(rows.map(r => [r.externalId, directionOf(r), r.amount])).toEqual([
      ['in', 'IN', 50],
      ['out', 'OUT', 50],
      ['out-penny', 'OUT', 0.01],
    ]);
  });

  // guards: BR-BANK-017, BR-BANK-019
  it('від’ємна сума рядком ("-15000") → OUT 150.00; нечислова й далі пропускається', async () => {
    client.fetchStatements.mockResolvedValue([
      { id: 'str-out', time: 1757060000, amount: '-15000' as unknown as number },
      { id: 'nan', time: 1757060000, amount: '-abc' as unknown as number },
    ]);
    const rows = await provider.fetchStatements(cfg, params);
    expect(rows.map(r => [r.externalId, directionOf(r), r.amount])).toEqual([
      ['str-out', 'OUT', 150],
    ]);
  });

  // guards: BR-BANK-020
  it('для вихідного рядка counter* — це отримувач: він і лягає в поля контрагента', async () => {
    client.fetchStatements.mockResolvedValue([
      {
        id: 'out',
        time: 1757060000,
        amount: -120000,
        counterName: 'ТОВ Постачальник',
        counterIban: 'UA903052992990004149123456789',
        counterEdrpou: '30405060',
      },
    ]);
    const rows = await provider.fetchStatements(cfg, params);
    expect(rows[0]).toMatchObject({
      amount: 1200,
      payerName: 'ТОВ Постачальник',
      payerIban: 'UA903052992990004149123456789',
      payerEdrpou: '30405060',
    });
    expect(directionOf(rows[0])).toBe('OUT');
  });

  // monobank віддає МИТЬ операції (Unix-секунди, UTC). Дата операції — київський календарний день
  // цієї миті. 01:30 за Києвом — це ще попередня доба за UTC, тож наївне «дата з UTC» дає вчора.
  // Літній час (UTC+3) і зимовий (UTC+2) перевіряються окремо — зсув не можна хардкодити.
  // guards: BR-BANK-021
  it.each([
    ['літо, 10.10 о 01:30 за Києвом', '2026-10-09T22:30:00Z', '2026-10-10'],
    ['літо, 10.10 о 23:30 за Києвом', '2026-10-10T20:30:00Z', '2026-10-10'],
    ['літо, 10.10 о 02:59 за Києвом', '2026-10-09T23:59:00Z', '2026-10-10'],
    ['зима, 15.01 о 01:30 за Києвом', '2026-01-14T23:30:00Z', '2026-01-15'],
    ['зима, 14.01 о 23:59 за Києвом', '2026-01-14T21:59:00Z', '2026-01-14'],
    ['зима, 15.01 о 00:00 за Києвом', '2026-01-14T22:00:00Z', '2026-01-15'],
    ['опівдні', '2026-07-01T09:00:00Z', '2026-07-01'],
  ])('київський день операції: %s → %s', async (_name, instant, day) => {
    client.fetchStatements.mockResolvedValue([
      { id: 'k', time: Date.parse(instant) / 1000, amount: 100 },
    ]);
    const rows = await provider.fetchStatements(cfg, params);
    // У базу (`@db.Date`) йде дата-частина UTC цього значення — вона й мусить бути київським днем.
    expect(rows[0].operationDate.toISOString().slice(0, 10)).toBe(day);
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

  // Переписано 2026-10-09 (BR-BANK-021): раніше кейс вимагав точну мить (time * 1000). Дата операції —
  // календарна дата без часу; від time лишається перевірка «секунди, а не мілісекунди»: 1757060000 —
  // це 05.09.2025 (якби прочитали як мілісекунди, вийшов би січень 1970).
  // guards: BR-BANK-021
  it('time — Unix СЕКУНДИ: 1757060000 → 05.09.2025', async () => {
    client.fetchStatements.mockResolvedValue([{ id: 'm3', time: 1757060000, amount: 100 }]);
    const rows = await provider.fetchStatements(cfg, params);
    expect(rows[0].operationDate.toISOString().slice(0, 10)).toBe('2025-09-05');
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
