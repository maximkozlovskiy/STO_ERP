import { translateError } from '@sto/shared';
import { describe, it, expect } from 'vitest';
import type { CreateBankTransactionDto } from './bank-statement.dto';
import {
  ID,
  NO_EFFECTS,
  ORG,
  OTHER_ORG,
  USER,
  effectCalls,
  makeWorld,
  type World,
} from './bank-reconciliation.world.spec-fixture';

// Аспект: ручне внесення банківського платежу і видалення ручного рядка —
// BankReconciliationService.createManual / removeManual.
// Правила BR-BANK-017, 021, 023, 024 — docs/objects/bank-statements.md.
//
// Написано ДО реалізації (2026-10-09) з контракту: createManual(orgId, dto, userId?),
// removeManual(orgId, txId), CreateBankTransactionDto, схема BankTransaction.
//
// Mutation-verify (кожна мутація мусить валити названі кейси):
//  · source не MANUAL / externalId без префікса MANUAL- / status не UNMATCHED → «створює рядок…»;
//  · direction захардкоджений IN → кейс для OUT; не писати createdBy → «створює рядок…»;
//  · валюта не з рахунку або курс на «сьогодні» замість operationDate → «валюта рахунку, курс на дату операції»;
//  · `new Date(dto.operationDate + 'T00:00:00')` (локальна північ) замість північ UTC → кейс про дату
//    (на машині з поясом на схід від UTC дата з'їде на попередній день);
//  · прибрати orgId / deletedAt з пошуку рахунку → «рахунок чужої організації / видалений → 404»;
//  · removeManual: прибрати `source: 'MANUAL'` з CAS → «рядок із виписки → 400»; прибрати
//    `status: 'UNMATCHED'` → «рознесений / ігнорований → 409»; замінити на `delete` → «soft delete».

const dto = (over: Partial<CreateBankTransactionDto> = {}): CreateBankTransactionDto => ({
  bankAccountId: ID.account,
  direction: 'OUT',
  amount: 2400.75,
  operationDate: '2026-10-09',
  payerName: 'ФОП Коваленко',
  purpose: 'Оренда приміщення за жовтень',
  ...over,
});

/** Єдиний рядок, створений у світі цим тестом. */
function created(w: World): Record<string, unknown> {
  const rows = w.db.rows('bankTransaction');
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

describe('BankReconciliationService.createManual — ручне внесення платежу', () => {
  // guards: BR-BANK-017, BR-BANK-023
  it.each(['IN', 'OUT'] as const)(
    'створює рядок MANUAL / UNMATCHED напряму %s з externalId MANUAL-<uuid> і автором',
    async direction => {
      const w = await makeWorld();

      const res = await w.service.createManual(ORG, dto({ direction }), USER);

      const row = created(w);
      expect(row).toMatchObject({
        orgId: ORG,
        bankAccountId: ID.account,
        source: 'MANUAL',
        status: 'UNMATCHED',
        direction,
        createdBy: USER,
        payerName: 'ФОП Коваленко',
        purpose: 'Оренда приміщення за жовтень',
      });
      expect(row.externalId).toMatch(
        /^MANUAL-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      // Знак у базі не зберігається: сума додатна для обох напрямків.
      expect(Number(row.amount)).toBe(2400.75);
      expect(res).toMatchObject({
        id: row.id,
        source: 'MANUAL',
        status: 'UNMATCHED',
        direction,
        amount: 2400.75,
      });
      // Внесення нічого не розносить і не проводить.
      expect(effectCalls(w)).toEqual(NO_EFFECTS);
    },
  );

  // guards: BR-BANK-023
  it('два внесення підряд отримують різні externalId (ключ ідемпотентності рядка не збігається)', async () => {
    const w = await makeWorld();

    await w.service.createManual(ORG, dto(), USER);
    await w.service.createManual(ORG, dto(), USER);

    const ids = w.db.rows('bankTransaction').map(r => r.externalId);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  // guards: BR-BANK-023
  it('валюта = валюта рахунку; amountBase і rateUsed — з resolveBaseConversion на дату операції', async () => {
    const w = await makeWorld();
    w.exchange.resolveBaseConversion.mockResolvedValue({ rateUsed: 41.5, amountBase: 4150 });

    await w.service.createManual(
      ORG,
      dto({ bankAccountId: ID.accountUsd, amount: 100, operationDate: '2026-10-09' }),
      USER,
    );

    const row = created(w);
    expect(row.currencyId).toBe(ID.usd);
    expect(Number(row.amountBase)).toBe(4150);
    expect(Number(row.rateUsed)).toBe(41.5);
    expect(w.exchange.resolveBaseConversion).toHaveBeenCalledTimes(1);
    const [orgArg, currencyArg, dateArg, amountArg] =
      w.exchange.resolveBaseConversion.mock.calls[0]!;
    expect(orgArg).toBe(ORG);
    expect(currencyArg).toBe(ID.usd);
    expect((dateArg as Date).toISOString()).toBe('2026-10-09T00:00:00.000Z');
    expect(Number(amountArg)).toBe(100);
  });

  // Дата без часу (`@db.Date`): у базу йде північ UTC цього календарного дня — саме її Prisma
  // обріже до дати. Локальна північ на машині у Києві — це ще 08.10 за UTC.
  // guards: BR-BANK-021, BR-BANK-023
  it.each(['2026-10-09', '2026-01-01', '2026-03-29'])(
    'operationDate %s зберігається як північ UTC цього дня (день не з’їжджає)',
    async operationDate => {
      const w = await makeWorld();

      await w.service.createManual(ORG, dto({ operationDate }), USER);

      const stored = created(w).operationDate as Date;
      expect(stored).toBeInstanceOf(Date);
      expect(stored.toISOString()).toBe(`${operationDate}T00:00:00.000Z`);
    },
  );

  // guards: BR-BANK-016, BR-BANK-038
  it.each([
    ['чужої організації', ID.accountForeign],
    ['видалений', ID.accountDeleted],
    ['неіснуючий', '99999999-9999-4999-8999-999999999999'],
  ])('рахунок %s → 404, рядок не створено', async (_name, bankAccountId) => {
    const w = await makeWorld();

    await expect(w.service.createManual(ORG, dto({ bankAccountId }), USER)).rejects.toMatchObject({
      status: 404,
      message: translateError('err.bankStatement.bankAccountNotFound', 'uk'),
    });

    expect(w.db.rows('bankTransaction')).toEqual([]);
  });
});

describe('BankReconciliationService.removeManual — видалення ручного рядка', () => {
  const manual = (over: Record<string, unknown> = {}) => ({
    source: 'MANUAL',
    externalId: 'MANUAL-3f2b8c1e-5d47-4a90-9c1b-7e6f0a2d4b18',
    createdBy: USER,
    ...over,
  });

  const hardDeletes = (w: World) => [
    ...w.calls('bankTransaction', 'delete'),
    ...w.calls('bankTransaction', 'deleteMany'),
  ];

  // guards: BR-BANK-024
  it('ручний нерознесений рядок → soft delete (deletedAt), жорсткого видалення немає', async () => {
    const w = await makeWorld();
    w.addRow(manual());
    const before = Date.now();

    await expect(w.service.removeManual(ORG, ID.tx)).resolves.toBeUndefined();

    const row = w.row();
    expect(row.deletedAt).toBeInstanceOf(Date);
    expect((row.deletedAt as Date).getTime()).toBeGreaterThanOrEqual(before);
    expect(hardDeletes(w)).toEqual([]);
    expect(w.db.rows('bankTransaction')).toHaveLength(1);
  });

  // guards: BR-BANK-024
  it('видалення — CAS: updateMany з where {id, orgId, source: MANUAL, status: UNMATCHED, deletedAt: null}', async () => {
    const w = await makeWorld();
    w.addRow(manual());

    await w.service.removeManual(ORG, ID.tx);

    const writes = w
      .calls('bankTransaction', 'updateMany')
      .filter(a => (a.data as { deletedAt?: unknown }).deletedAt instanceof Date);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.where).toMatchObject({
      id: ID.tx,
      orgId: ORG,
      source: 'MANUAL',
      status: 'UNMATCHED',
      deletedAt: null,
    });
  });

  // guards: BR-BANK-024
  it.each(['FILE_IMPORT', 'PRIVAT24_API', 'MONOBANK_API'])(
    'рядок із джерела %s → 400 «лише внесений вручну», рядок цілий',
    async source => {
      const w = await makeWorld();
      w.addRow({ source });

      await expect(w.service.removeManual(ORG, ID.tx)).rejects.toMatchObject({
        status: 400,
        message: translateError('err.bankStatement.notManual', 'uk'),
      });

      expect(w.row().deletedAt).toBeNull();
      expect(hardDeletes(w)).toEqual([]);
    },
  );

  // guards: BR-BANK-024
  it.each([
    ['рознесений', { status: 'MATCHED', matchedType: 'EXPENSE', expenseCategoryId: ID.expense }],
    ['ігнорований', { status: 'IGNORED', ignoreReason: 'дубль' }],
  ])('%s ручний рядок → 409, рядок цілий', async (_name, over) => {
    const w = await makeWorld();
    w.addRow(manual(over));

    await expect(w.service.removeManual(ORG, ID.tx)).rejects.toMatchObject({ status: 409 });

    expect(w.row()).toMatchObject({ deletedAt: null, status: over.status });
    expect(hardDeletes(w)).toEqual([]);
  });

  // guards: BR-BANK-024, BR-BANK-038
  it.each([
    ['немає', null],
    ['чужої організації', { orgId: OTHER_ORG }],
    ['уже видалено', { deletedAt: new Date('2026-10-01T00:00:00.000Z') }],
  ])('рядка %s → 404', async (_name, over) => {
    const w = await makeWorld();
    if (over) w.addRow(manual(over));

    await expect(w.service.removeManual(ORG, ID.tx)).rejects.toMatchObject({ status: 404 });

    // Чужий рядок не видалено; уже видалений не «видалено вдруге» (дата та сама).
    const row = w.db.rows('bankTransaction')[0];
    if (row && row.orgId === OTHER_ORG) expect(row.deletedAt).toBeNull();
    if (row && row.orgId === ORG) {
      expect((row.deletedAt as Date).toISOString()).toBe('2026-10-01T00:00:00.000Z');
    }
    expect(hardDeletes(w)).toEqual([]);
  });

  // Гонка «видалити» ↔ «рознести»: поки рядок читали, його встигли рознести.
  // guards: BR-BANK-024
  it('CAS програв гонку (count 0, рядок існує) → 409, а не мовчазний успіх', async () => {
    const w = await makeWorld();
    w.addRow(manual());
    w.loseNextCas();

    await expect(w.service.removeManual(ORG, ID.tx)).rejects.toMatchObject({ status: 409 });

    expect(w.row().deletedAt).toBeNull();
  });
});
