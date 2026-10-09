import { describe, it, expect } from 'vitest';
import type { RawTx } from './bank-reconciliation.service';
import {
  ID,
  NO_EFFECTS,
  OP_DATE,
  ORG,
  OWN_IBAN,
  ROW_AMOUNT,
  effectCalls,
  makeWorld,
  type World,
} from './bank-reconciliation.world.spec-fixture';

// Аспект: напрям рядка в імпорті та прев'ю — applyImport / previewImport для ОБОХ напрямків:
// запис напряму, власний IBAN, позначка ручного дубля, підказки для вихідного рядка.
// Правила BR-BANK-017, 020, 036, 037 — docs/objects/bank-statements.md.
//
// Написано ДО реалізації (2026-10-09). Контракт: ApplyRowDto.direction, PreviewRowDto.direction /
// possibleManualDuplicate. Напрям сирого рядка прев'ю (RawTx.direction) контракт ще не називає —
// див. `raw()` нижче.
//
// Mutation-verify (кожна мутація мусить валити названі кейси):
//  · `direction: 'IN' as const` у applyImport замість `row.direction ?? 'IN'` → «пише напрям рядка»;
//  · не порівнювати payerIban з ibanUA рахунку → «власний IBAN рахунку не зберігається…»;
//  · `direction: 'IN'` / `possibleManualDuplicate: false` заглушками у previewImport → кейси прев'ю;
//  · у пошуку ручних дублів прибрати будь-яку з умов (рахунок, дата, сума, напрям, source MANUAL,
//    deletedAt) → відповідний рядок «не дубль: …»;
//  · для OUT-рядка лишити підказку SERVICE або не шукати замовлення в призначенні → кейси підказок;
//  · дати підказці щось записати → «прев'ю нічого не пише».

const SUPPLIER_IBAN = 'UA903052992990004149123456789';
const CLIENT_IBAN = 'UA173348510000026201112609803';

/**
 * Сирий рядок виписки з напрямом. `direction` у RawTx на момент написання тестів немає в контракті
 * (його додає реалізація BR-BANK-018) — тому приведення типу, а не літерал RawTx.
 */
const raw = (over: Partial<RawTx> & { direction?: 'IN' | 'OUT' } = {}): RawTx =>
  ({
    externalId: 'stmt-1',
    operationDate: OP_DATE,
    amount: ROW_AMOUNT,
    direction: 'OUT',
    payerName: 'ТОВ Автозапчастини',
    ...over,
  }) as RawTx;

const applyRow = (over: Record<string, unknown> = {}) => ({
  externalId: 'stmt-1',
  operationDate: '2026-09-28',
  amount: ROW_AMOUNT,
  ...over,
});

/** Усі записи в рядки виписки на обох клієнтах (прев'ю не має права зробити жодного). */
const rowWrites = (w: World) => [
  ...w.calls('bankTransaction', 'create'),
  ...w.calls('bankTransaction', 'createMany'),
  ...w.calls('bankTransaction', 'update'),
  ...w.calls('bankTransaction', 'updateMany'),
];

describe('BankReconciliationService.applyImport — напрям рядка і власний IBAN', () => {
  // guards: BR-BANK-017
  it('пише напрям рядка: OUT і IN як задано, без напряму — IN; сума лишається додатною', async () => {
    const w = await makeWorld();

    const res = await w.service.applyImport(ORG, {
      bankAccountId: ID.account,
      rows: [
        applyRow({ externalId: 'out', direction: 'OUT', amount: 320.4 }),
        applyRow({ externalId: 'in', direction: 'IN', amount: 150 }),
        applyRow({ externalId: 'legacy', amount: 99.99 }),
      ],
    });

    expect(res).toEqual({ created: 3, skipped: 0 });
    const stored = Object.fromEntries(
      w.db
        .rows('bankTransaction')
        .map(r => [r.externalId, { direction: r.direction, amount: Number(r.amount) }]),
    );
    expect(stored).toEqual({
      out: { direction: 'OUT', amount: 320.4 },
      in: { direction: 'IN', amount: 150 },
      legacy: { direction: 'IN', amount: 99.99 },
    });
  });

  // guards: BR-BANK-001, BR-BANK-017
  it('вихідний рядок теж лише лягає у staging: UNMATCHED, нічого не розноситься і не проводиться', async () => {
    const w = await makeWorld();

    await w.service.applyImport(ORG, {
      bankAccountId: ID.account,
      rows: [applyRow({ direction: 'OUT' })],
    });

    expect(w.db.rows('bankTransaction')[0]).toMatchObject({
      direction: 'OUT',
      status: 'UNMATCHED',
      source: 'FILE_IMPORT',
      currencyId: ID.uah,
    });
    expect(effectCalls(w)).toEqual(NO_EFFECTS);
  });

  // У виписках банків колонка «рахунок» часто містить НАШ рахунок (для вихідного платежу він —
  // платник). Якщо зберегти його як IBAN контрагента, авто-матч знайде «контрагента» з нашим IBAN.
  // guards: BR-BANK-020
  it.each(['OUT', 'IN'] as const)(
    'власний IBAN рахунку (у будь-якому записі) не зберігається як IBAN контрагента — напрям %s',
    async direction => {
      const w = await makeWorld();
      const spaced = OWN_IBAN.toLowerCase().replace(/(.{4})/g, '$1 ');

      await w.service.applyImport(ORG, {
        bankAccountId: ID.account,
        rows: [
          applyRow({ externalId: 'own', direction, payerIban: OWN_IBAN }),
          applyRow({ externalId: 'own-spaced', direction, payerIban: spaced }),
          applyRow({ externalId: 'other', direction, payerIban: SUPPLIER_IBAN }),
        ],
      });

      const ibans = Object.fromEntries(
        w.db.rows('bankTransaction').map(r => [r.externalId, r.payerIban]),
      );
      expect(ibans).toEqual({ own: null, 'own-spaced': null, other: SUPPLIER_IBAN });
    },
  );
});

describe('BankReconciliationService.previewImport — напрям і ручні дублі', () => {
  // guards: BR-BANK-017
  it('прев’ю повертає напрям кожного рядка; сума додатна для обох', async () => {
    const w = await makeWorld();

    const rows = await w.service.previewImport(ORG, ID.account, [
      raw({ externalId: 'out', direction: 'OUT', amount: 320.4 }),
      raw({ externalId: 'in', direction: 'IN', amount: 150 }),
    ]);

    expect(rows.map(r => [r.externalId, r.direction, r.amount])).toEqual([
      ['out', 'OUT', 320.4],
      ['in', 'IN', 150],
    ]);
  });

  // guards: BR-BANK-037
  it('той самий рахунок, дата, сума й напрям, що в ручного рядка → possibleManualDuplicate, але рядок не заблоковано', async () => {
    const w = await makeWorld();
    w.addRow({ source: 'MANUAL', externalId: 'MANUAL-aaaa' });

    const [row] = await w.service.previewImport(ORG, ID.account, [raw()]);

    expect(row!.possibleManualDuplicate).toBe(true);
    // Попередження, а не дубль за externalId: рядок лишається придатним до імпорту.
    expect(row!.matchStatus).not.toBe('duplicate');
  });

  const NOT_DUPLICATES: Array<[string, (w: World) => RawTx, string?]> = [
    ['сума відрізняється на копійку', () => raw({ amount: ROW_AMOUNT + 0.01 })],
    ['інший напрям', () => raw({ direction: 'IN' })],
    ['наступний день', () => raw({ operationDate: new Date('2026-09-29T00:00:00.000Z') })],
    ['ручний рядок на іншому рахунку', () => raw(), ID.account2],
    [
      'такий самий рядок є, але він із виписки, а не ручний',
      w => {
        w.row().source = 'FILE_IMPORT';
        return raw();
      },
    ],
    [
      'ручний рядок видалено',
      w => {
        w.row().deletedAt = new Date('2026-10-01');
        return raw();
      },
    ],
  ];

  // guards: BR-BANK-037
  it.each(NOT_DUPLICATES)('не дубль: %s', async (_name, arrange, accountId) => {
    const w = await makeWorld();
    w.addRow({ source: 'MANUAL', externalId: 'MANUAL-aaaa' });
    const incoming = arrange(w);

    const [row] = await w.service.previewImport(ORG, accountId ?? ID.account, [incoming]);

    expect(row!.possibleManualDuplicate).toBe(false);
  });

  // guards: BR-BANK-037
  it('без жодного ручного рядка позначки немає', async () => {
    const w = await makeWorld();

    const [row] = await w.service.previewImport(ORG, ID.account, [raw()]);

    expect(row!.possibleManualDuplicate).toBe(false);
  });
});

describe('BankReconciliationService.previewImport — підказки для вихідного рядка', () => {
  // guards: BR-BANK-036
  it('IBAN контрагента-постачальника → підказка SUPPLIER_PAYMENT з контрагентом', async () => {
    const w = await makeWorld();
    w.db.get('counterparty', ID.supplier).iban = SUPPLIER_IBAN;

    const [row] = await w.service.previewImport(ORG, ID.account, [
      raw({ payerIban: SUPPLIER_IBAN }),
    ]);

    expect(row).toMatchObject({
      direction: 'OUT',
      matchStatus: 'matched',
      matchReason: 'iban',
      suggestedCounterpartyId: ID.supplier,
      suggestedMatchType: 'SUPPLIER_PAYMENT',
    });
  });

  // guards: BR-BANK-036
  it('ЄДРПОУ контрагента-постачальника → підказка SUPPLIER_PAYMENT', async () => {
    const w = await makeWorld();
    w.db.get('counterparty', ID.supplier).edrpou = '30405060';

    const [row] = await w.service.previewImport(ORG, ID.account, [
      raw({ payerEdrpou: '30405060' }),
    ]);

    expect(row).toMatchObject({
      matchStatus: 'matched',
      matchReason: 'edrpou',
      suggestedCounterpartyId: ID.supplier,
      suggestedMatchType: 'SUPPLIER_PAYMENT',
    });
  });

  // guards: BR-BANK-036
  it('номер замовлення постачальнику в призначенні → постачальник замовлення і підказка SUPPLIER_PAYMENT', async () => {
    const w = await makeWorld();

    const [row] = await w.service.previewImport(ORG, ID.account, [
      raw({ purpose: 'Оплата за замовлення №4521 від 20.09.2026, без ПДВ' }),
    ]);

    expect(row).toMatchObject({
      matchStatus: 'matched',
      matchReason: 'purpose',
      suggestedCounterpartyId: ID.supplier,
      suggestedMatchType: 'SUPPLIER_PAYMENT',
    });
  });

  // guards: BR-BANK-036
  it('каскад: IBAN виграє в номера замовлення іншого постачальника', async () => {
    const w = await makeWorld();
    w.db.get('counterparty', ID.supplier).iban = SUPPLIER_IBAN;

    const [row] = await w.service.previewImport(ORG, ID.account, [
      // Замовлення №4522 належить ID.supplier2.
      raw({ payerIban: SUPPLIER_IBAN, purpose: 'Оплата за замовлення №4522' }),
    ]);

    expect(row).toMatchObject({ matchReason: 'iban', suggestedCounterpartyId: ID.supplier });
  });

  // guards: BR-BANK-036
  it('контрагент без ролі постачальника (лише клієнт) → підказки SUPPLIER_PAYMENT немає', async () => {
    const w = await makeWorld();
    w.db.get('counterparty', ID.client).iban = CLIENT_IBAN;

    const [row] = await w.service.previewImport(ORG, ID.account, [raw({ payerIban: CLIENT_IBAN })]);

    expect(row!.suggestedCounterpartyId).toBe(ID.client);
    expect(row!.suggestedMatchType).not.toBe('SUPPLIER_PAYMENT');
  });

  // Вихідному рядку не можна підказати вхідний вид: `match` його не прийме (BR-BANK-025).
  // guards: BR-BANK-025, BR-BANK-036
  it('вихідний рядок ніколи не отримує підказку вхідного виду (SERVICE / INVOICE / PREPAYMENT / REFUND / OTHER)', async () => {
    const w = await makeWorld();
    w.db.get('counterparty', ID.client).iban = CLIENT_IBAN;
    w.db.get('counterparty', ID.supplier).edrpou = '30405060';

    const rows = await w.service.previewImport(ORG, ID.account, [
      raw({ externalId: 'a', payerIban: CLIENT_IBAN }),
      raw({ externalId: 'b', payerEdrpou: '30405060' }),
      raw({ externalId: 'c', purpose: 'просто переказ' }),
    ]);

    for (const row of rows) {
      expect(['SERVICE', 'INVOICE', 'PREPAYMENT', 'REFUND', 'OTHER']).not.toContain(
        row.suggestedMatchType,
      );
    }
  });

  // guards: BR-BANK-004, BR-BANK-036
  it('вхідний рядок від того самого контрагента підказки SUPPLIER_PAYMENT не отримує — лишається SERVICE', async () => {
    const w = await makeWorld();
    w.db.get('counterparty', ID.supplier).iban = SUPPLIER_IBAN;

    const [row] = await w.service.previewImport(ORG, ID.account, [
      raw({ direction: 'IN', payerIban: SUPPLIER_IBAN }),
    ]);

    expect(row).toMatchObject({
      direction: 'IN',
      suggestedCounterpartyId: ID.supplier,
      suggestedMatchType: 'SERVICE',
    });
  });

  // guards: BR-BANK-036
  it('прев’ю з підказкою нічого не пише: ні рядків, ні оплат, ні проведень', async () => {
    const w = await makeWorld();
    w.db.get('counterparty', ID.supplier).iban = SUPPLIER_IBAN;

    await w.service.previewImport(ORG, ID.account, [
      raw({ payerIban: SUPPLIER_IBAN, purpose: 'Оплата за замовлення №4521' }),
    ]);

    expect(rowWrites(w)).toEqual([]);
    expect(w.db.rows('bankTransaction')).toEqual([]);
    expect(w.db.rows('supplierPayment')).toEqual([]);
    expect(effectCalls(w)).toEqual(NO_EFFECTS);
  });
});
