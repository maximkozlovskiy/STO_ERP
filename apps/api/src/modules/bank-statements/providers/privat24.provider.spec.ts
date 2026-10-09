import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Privat24Provider } from './privat24.provider';
import type { Privat24Client } from './privat24.client';
import type { BankStatementConfig } from './bank-provider.interface';

/**
 * Privat24Provider.mapTx — ЗАХИСНА нормалізація сирого рядка Privat → RawTx.
 * Доводимо: напрям за TRANTYPE (C → IN, D → OUT, невідомий → skip), контрагент з AUT_CNTR_*,
 * skip рядка без REF, парсинг дати/суми, fallback-ключі, verifyCredentials (auth-помилка → invalid).
 *
 * Кейси BR-BANK-019 / 020 написано ДО реалізації вихідних платежів (2026-10-09).
 * Mutation-verify: (1) повернути `if (!isCredit) return null` → «C → IN, D → OUT» і «змішаний батч»;
 * (2) трактувати невідомий TRANTYPE як вхідний → «…рядок пропускається, а не стає вхідним»;
 * (3) читати контрагента з AUT_MY_* → обидва кейси BR-BANK-020.
 */

/** Напрям рядка. У RawTx на момент написання тестів поля ще немає — його додає реалізація. */
const directionOf = (row: unknown): unknown => (row as { direction?: unknown }).direction;

describe('Privat24Provider', () => {
  let provider: Privat24Provider;
  let client: { fetchTransactions: ReturnType<typeof vi.fn> };
  const cfg: BankStatementConfig = { apiUrl: null, credentials: { merchantId: 'M', token: 'T' } };
  const params = { iban: 'UA1', from: new Date(), to: new Date() };

  beforeEach(() => {
    client = { fetchTransactions: vi.fn() };
    provider = new Privat24Provider(client as unknown as Privat24Client);
  });

  // Переписано 2026-10-09 (BR-BANK-019 уточнює BR-BANK-013): раніше кейс закріплював «debit (D)
  // відкидається». Тепер обидва напрямки йдуть у staging, а напрям — окремим полем.
  // guards: BR-BANK-017, BR-BANK-019
  it('TRANTYPE задає напрям: C → IN, D → OUT; обидва рядки лишаються, сума додатна', async () => {
    client.fetchTransactions.mockResolvedValue([
      { REF: 'in-1', TRANTYPE: 'C', SUM: '100.50', DAT_OD: '05.09.2026', OSND: 'оплата' },
      { REF: 'out-1', TRANTYPE: 'D', SUM: '200', DAT_OD: '05.09.2026', OSND: 'видача' },
    ]);
    const rows = await provider.fetchStatements(cfg, params);
    expect(rows.map(r => [r.externalId, directionOf(r), r.amount])).toEqual([
      ['in-1', 'IN', 100.5],
      ['out-1', 'OUT', 200],
    ]);
    expect(rows[0].purpose).toBe('оплата');
    expect(rows[1].purpose).toBe('видача');
  });

  // Невідомий маркер НЕ стає вхідним: вихідний платіж, прочитаний як надходження, авто-рознесення
  // перетворило б на оплату клієнта.
  // guards: BR-BANK-019
  it.each([
    ['невідомий TRANTYPE', { TRANTYPE: 'X' }],
    ['порожній TRANTYPE', { TRANTYPE: '' }],
    ['маркера немає взагалі', {}],
  ])('%s → рядок пропускається, а не стає вхідним', async (_name, marker) => {
    client.fetchTransactions.mockResolvedValue([
      { REF: 'unknown', SUM: '10', DAT_OD: '05.09.2026', ...marker },
      { REF: 'ok', TRANTYPE: 'D', SUM: '20', DAT_OD: '05.09.2026' },
    ]);
    const rows = await provider.fetchStatements(cfg, params);
    expect(rows.map(r => [r.externalId, directionOf(r)])).toEqual([['ok', 'OUT']]);
  });

  // Privat24 кладе реквізити контрагента в AUT_CNTR_*, а наші власні — в AUT_MY_*.
  // guards: BR-BANK-020
  it.each(['C', 'D'])(
    'контрагент береться з AUT_CNTR_*; власні реквізити AUT_MY_* в контрагента не потрапляють (TRANTYPE %s)',
    async trantype => {
      client.fetchTransactions.mockResolvedValue([
        {
          REF: 'r1',
          TRANTYPE: trantype,
          SUM: '10',
          DAT_OD: '05.09.2026',
          AUT_MY_NAM: 'СТО Наша',
          AUT_MY_ACC: 'UA213223130000026007233566001',
          AUT_MY_CRF: '11112222',
          AUT_CNTR_NAM: 'ТОВ Постачальник',
          AUT_CNTR_ACC: 'UA903052992990004149123456789',
          AUT_CNTR_CRF: '30405060',
        },
      ]);
      const rows = await provider.fetchStatements(cfg, params);
      expect(rows[0]).toMatchObject({
        payerName: 'ТОВ Постачальник',
        payerIban: 'UA903052992990004149123456789',
        payerEdrpou: '30405060',
      });
    },
  );

  // guards: BR-BANK-020
  it.each(['C', 'D'])(
    'у рядку є лише власні реквізити AUT_MY_* → контрагент порожній, а не «ми самі» (TRANTYPE %s)',
    async trantype => {
      client.fetchTransactions.mockResolvedValue([
        {
          REF: 'r1',
          TRANTYPE: trantype,
          SUM: '10',
          DAT_OD: '05.09.2026',
          AUT_MY_NAM: 'СТО Наша',
          AUT_MY_ACC: 'UA213223130000026007233566001',
          AUT_MY_CRF: '11112222',
        },
      ]);
      const rows = await provider.fetchStatements(cfg, params);
      expect(rows).toHaveLength(1);
      expect(rows[0].payerName ?? null).toBeNull();
      expect(rows[0].payerIban ?? null).toBeNull();
      expect(rows[0].payerEdrpou ?? null).toBeNull();
    },
  );

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

  // Переписано 2026-10-09 (BR-BANK-021): раніше кейс закріплював ще й час (14:30:00Z). Дата операції —
  // календарна дата без часу, а Privat24 віддає вже київський локальний час: день береться з рядка
  // як є. Пізній вечір і перша година ночі не мають з'їжджати на сусідній день (це сталося б, якби
  // рядок прочитали як UTC і перевели в Київ, або як Київ і перевели в UTC).
  // guards: BR-BANK-021
  it.each([
    ['15.03.2026 14:30:00', '2026-03-15'],
    ['15.03.2026 23:30:00', '2026-03-15'],
    ['15.03.2026 00:30:00', '2026-03-15'],
    ['10.10.2026 01:30:00', '2026-10-10'],
  ])('parseDate: «%s» (київський час банку) → календарний день %s', async (raw, day) => {
    client.fetchTransactions.mockResolvedValue([
      { REF: 'd', TRANTYPE: 'C', SUM: '1', DAT_OD: raw },
    ]);
    const rows = await provider.fetchStatements(cfg, params);
    expect(rows[0].operationDate.toISOString().slice(0, 10)).toBe(day);
  });

  // guards: BR-BANK-003
  it('РЕГРЕС: неіснуюча дата 31.02.2026 НЕ rollover — рядок відкидається', async () => {
    // parseDate DD.MM.YYYY-гілка раніше не мала rollover-guard: Date.UTC(2026,1,31) перекочувало б
    // у 03-02 → зіпсована operationDate (визначає курс для amountBase). Тепер → null → skip.
    client.fetchTransactions.mockResolvedValue([
      { REF: 'bad-day', TRANTYPE: 'C', SUM: '10', DAT_OD: '31.02.2026 12:00:00' },
      { REF: 'nonleap', TRANTYPE: 'C', SUM: '10', DAT_OD: '29.02.2023' }, // невисокосний
      { REF: 'ok', TRANTYPE: 'C', SUM: '10', DAT_OD: '15.03.2026' },
    ]);
    const rows = await provider.fetchStatements(cfg, params);
    expect(rows.map(r => r.externalId)).toEqual(['ok']);
    expect(rows[0].operationDate.toISOString()).toBe('2026-03-15T00:00:00.000Z');
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

  // Переписано 2026-10-09 (BR-BANK-019): debit більше не «битий» — він лишається як вихідний.
  // guards: BR-BANK-019
  it('змішаний батч: валідні лишаються (і debit — як вихідний), биті (без REF / битий amount) відкидаються', async () => {
    client.fetchTransactions.mockResolvedValue([
      { REF: 'ok-1', TRANTYPE: 'C', SUM: '100', DAT_OD: '05.09.2026' }, // ✓ вхідний
      { TRANTYPE: 'C', SUM: '50', DAT_OD: '05.09.2026' }, // ✗ без REF
      { REF: 'debit-1', TRANTYPE: 'D', SUM: '200', DAT_OD: '05.09.2026' }, // ✓ вихідний
      { REF: 'ok-2', TRANTYPE: 'C', SUM: '75.25', DAT_OD: '06.09.2026' }, // ✓ вхідний
      { REF: 'bad-amt', TRANTYPE: 'C', SUM: '0', DAT_OD: '06.09.2026' }, // ✗ нульова сума
      { REF: 'bad-amt-out', TRANTYPE: 'D', SUM: '0.00', DAT_OD: '06.09.2026' }, // ✗ нульова сума
    ]);
    const rows = await provider.fetchStatements(cfg, params);
    expect(rows.map(r => [r.externalId, directionOf(r)])).toEqual([
      ['ok-1', 'IN'],
      ['debit-1', 'OUT'],
      ['ok-2', 'IN'],
    ]);
  });

  // guards: BR-BANK-013
  it("amount=0 та амаунт від'ємний → skip (лише додатні надходження)", async () => {
    client.fetchTransactions.mockResolvedValue([
      { REF: 'z', TRANTYPE: 'C', SUM: '0.00', DAT_OD: '05.09.2026' },
      { REF: 'n', TRANTYPE: 'C', SUM: '-5', DAT_OD: '05.09.2026' },
    ]);
    const rows = await provider.fetchStatements(cfg, params);
    expect(rows).toEqual([]);
  });

  // guards: BR-BANK-003
  it('РЕГРЕС: ISO-fallback (гілка в) — неіснуюча 2026-02-31 НЕ rollover, валідна ISO парситься', async () => {
    // parseDate гілка (в) (нативний new Date) раніше не мала guard: new Date('2026-02-31')
    // тихо перекочувало у 03-02 → зіпсована operationDate (визначає курс для amountBase).
    // Тепер ISO date-only парситься покомпонентно з rollover-guard.
    client.fetchTransactions.mockResolvedValue([
      { REF: 'iso-bad', TRANTYPE: 'C', SUM: '10', DAT_OD: '2026-02-31' }, // неіснуюча → skip
      { REF: 'iso-ok', TRANTYPE: 'C', SUM: '10', DAT_OD: '2026-03-15' }, // валідна ISO
    ]);
    const rows = await provider.fetchStatements(cfg, params);
    expect(rows.map(r => r.externalId)).toEqual(['iso-ok']);
    expect(rows[0].operationDate.toISOString()).toBe('2026-03-15T00:00:00.000Z');
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
