import { describe, it, expect } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate, type ValidationError } from 'class-validator';
import {
  ApplyImportDto,
  BANK_IMPORT_DIRECTION_MODES,
  BANK_TX_IN_MATCH_TYPES,
  BANK_TX_MATCH_TYPES,
  BANK_TX_OUT_MATCH_TYPES,
  CreateBankTransactionDto,
  IgnoreTransactionDto,
  ListQueryDto,
  MatchTransactionDto,
  PreviewImportColumnMapping,
  ReconcileTransactionDto,
  UnreconcileTransactionDto,
} from './bank-statement.dto';

// Межі вхідних даних банк-виписки (BR-BANK-014). Перевіряємо САМІ декоратори DTO тим самим
// шляхом, що й глобальний ValidationPipe: plainToInstance → validate.

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const CP_ID = '22222222-2222-4222-8222-222222222222';

const row = (over: Record<string, unknown> = {}) => ({
  externalId: 'e1',
  operationDate: '2026-09-01',
  amount: 100,
  ...over,
});

/** Усі constraint-ключі помилок (включно з вкладеними рядками) у вигляді «поле.правило». */
function constraints(errors: ValidationError[], prefix = ''): string[] {
  return errors.flatMap(e => [
    ...Object.keys(e.constraints ?? {}).map(k => `${prefix}${e.property}.${k}`),
    ...constraints(e.children ?? [], `${prefix}${e.property}.`),
  ]);
}

const check = async <T extends object>(cls: new () => T, plain: unknown): Promise<string[]> =>
  constraints(await validate(plainToInstance(cls, plain)));

describe('ApplyImportDto — межі імпорту', () => {
  // guards: BR-BANK-014
  it('1000 рядків за запит проходить, 1001 — відхиляється (rows.arrayMaxSize)', async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => row({ externalId: `e${i}` }));
    expect(await check(ApplyImportDto, { bankAccountId: ACCOUNT_ID, rows })).toEqual([]);
    expect(
      await check(ApplyImportDto, {
        bankAccountId: ACCOUNT_ID,
        rows: [...rows, row({ externalId: 'e1000' })],
      }),
    ).toEqual(['rows.arrayMaxSize']);
  });

  // guards: BR-BANK-014
  it.each([0, -150, 0.009])('сума рядка %s → відхиляється (мінімум 0.01)', async amount => {
    expect(
      await check(ApplyImportDto, { bankAccountId: ACCOUNT_ID, rows: [row({ amount })] }),
    ).toEqual(['rows.0.amount.min']);
  });

  // guards: BR-BANK-014
  it('сума рядка 0.01 (одна копійка) проходить', async () => {
    expect(
      await check(ApplyImportDto, { bankAccountId: ACCOUNT_ID, rows: [row({ amount: 0.01 })] }),
    ).toEqual([]);
  });

  // guards: BR-BANK-014
  it('рядок без externalId або без дати операції → відхиляється', async () => {
    const errors = await check(ApplyImportDto, {
      bankAccountId: ACCOUNT_ID,
      rows: [row({ externalId: '', operationDate: '' })],
    });
    expect(errors).toContain('rows.0.externalId.isNotEmpty');
    expect(errors).toContain('rows.0.operationDate.isNotEmpty');
  });

  // guards: BR-BANK-014
  it('bankAccountId не UUID → відхиляється', async () => {
    expect(await check(ApplyImportDto, { bankAccountId: 'ba-1', rows: [row()] })).toEqual([
      'bankAccountId.isUuid',
    ]);
  });
});

describe('MatchTransactionDto / IgnoreTransactionDto', () => {
  // guards: BR-BANK-014
  it('тип рознесення поза переліком → відхиляється; кожен дозволений тип проходить', async () => {
    expect(await check(MatchTransactionDto, { counterpartyId: CP_ID, type: 'BONUS' })).toEqual([
      'type.isIn',
    ]);
    for (const type of ['SERVICE', 'PREPAYMENT', 'INVOICE', 'REFUND', 'OTHER']) {
      expect(await check(MatchTransactionDto, { counterpartyId: CP_ID, type })).toEqual([]);
    }
  });

  // guards: BR-BANK-014
  it('ігнорування без причини → відхиляється', async () => {
    expect(await check(IgnoreTransactionDto, { reason: '' })).toEqual(['reason.isNotEmpty']);
    expect(await check(IgnoreTransactionDto, { reason: 'помилковий переказ' })).toEqual([]);
  });
});

// ─── Вихідні платежі: межі нових запитів (BR-BANK-017 / 018 / 021 / 023 / 025 / 039) ───
// Mutation-verify: (1) повернути `@IsIn(BANK_TX_MATCH_TYPES)` у MatchTransactionDto → «вихідний вид
// %s через match → відхиляється»; (2) додати вхідні види в BANK_TX_OUT_MATCH_TYPES → «вхідний вид
// %s через reconcile»; (3) прибрати `@Transform(trimString)` з reason → «причина з самих пробілів»;
// (4) прибрати `@MaxLength` → «501 символ»; (5) `@Min(0)` замість `@Min(0.01)` або зняти
// `maxDecimalPlaces` → кейси суми; (6) зняти `@Matches(CALENDAR_DATE_RE)` або `strict` → кейси дати.

describe('MatchTransactionDto / ReconcileTransactionDto — вид рознесення проти endpoint-а', () => {
  // Вихідний вид на `match` мовчки став би оплатою клієнта (settlementType PAYMENT).
  // guards: BR-BANK-025
  it.each(BANK_TX_OUT_MATCH_TYPES)('вихідний вид %s через match → відхиляється', async type => {
    expect(await check(MatchTransactionDto, { counterpartyId: CP_ID, type })).toEqual([
      'type.isIn',
    ]);
  });

  // guards: BR-BANK-025
  it.each(BANK_TX_OUT_MATCH_TYPES)('вид %s через reconcile → проходить', async type => {
    expect(await check(ReconcileTransactionDto, { type })).toEqual([]);
  });

  // guards: BR-BANK-025
  it.each(BANK_TX_IN_MATCH_TYPES)('вхідний вид %s через reconcile → відхиляється', async type => {
    expect(await check(ReconcileTransactionDto, { type, counterpartyId: CP_ID })).toEqual([
      'type.isIn',
    ]);
  });

  // guards: BR-BANK-025
  it('переліки видів не перетинаються і разом покривають увесь enum', () => {
    const both = [...BANK_TX_IN_MATCH_TYPES, ...BANK_TX_OUT_MATCH_TYPES];
    expect(new Set(both).size).toBe(both.length);
    expect([...both].sort()).toEqual([...BANK_TX_MATCH_TYPES].sort());
  });

  // guards: BR-BANK-038
  it.each([
    'counterpartyId',
    'supplierPaymentId',
    'purchaseOrderId',
    'expenseCategoryId',
    'payrollPeriodId',
    'employeeId',
    'transferBankAccountId',
    'cashRegisterId',
  ])('reconcile: %s не UUID → відхиляється', async field => {
    expect(await check(ReconcileTransactionDto, { type: 'EXPENSE', [field]: 'abc' })).toEqual([
      `${field}.isUuid`,
    ]);
  });
});

describe('UnreconcileTransactionDto — причина скасування', () => {
  // guards: BR-BANK-039
  it.each([
    ['порожня', ''],
    ['із самих пробілів', '   '],
    ['із табуляції та переводу рядка', '\t\n '],
  ])('причина %s → відхиляється', async (_name, reason) => {
    expect(await check(UnreconcileTransactionDto, { reason })).toContain('reason.isNotEmpty');
  });

  // guards: BR-BANK-039
  it('причини немає взагалі → відхиляється', async () => {
    expect((await check(UnreconcileTransactionDto, {})).length).toBeGreaterThan(0);
  });

  // guards: BR-BANK-039
  it('500 символів проходить, 501 — відхиляється', async () => {
    expect(await check(UnreconcileTransactionDto, { reason: 'я'.repeat(500) })).toEqual([]);
    expect(await check(UnreconcileTransactionDto, { reason: 'я'.repeat(501) })).toEqual([
      'reason.maxLength',
    ]);
  });

  // guards: BR-BANK-039
  it('пробіли по краях обрізаються: у сервіс іде чиста причина', () => {
    const dto = plainToInstance(UnreconcileTransactionDto, { reason: '  помилковий вид  ' });
    expect(dto.reason).toBe('помилковий вид');
  });
});

describe('CreateBankTransactionDto — ручне внесення', () => {
  const manual = (over: Record<string, unknown> = {}) => ({
    bankAccountId: ACCOUNT_ID,
    direction: 'OUT',
    amount: 1500.5,
    operationDate: '2026-10-09',
    ...over,
  });

  // guards: BR-BANK-017, BR-BANK-023
  it.each(['IN', 'OUT'])('напрям %s з мінімальним набором полів проходить', async direction => {
    expect(await check(CreateBankTransactionDto, manual({ direction }))).toEqual([]);
  });

  // guards: BR-BANK-017
  it.each([0, -150, 0.009])(
    'сума %s → відхиляється (завжди додатна, мінімум 0.01)',
    async amount => {
      expect(await check(CreateBankTransactionDto, manual({ amount }))).toContain('amount.min');
    },
  );

  // guards: BR-BANK-017
  it('сума з трьома знаками після коми → відхиляється; з двома — проходить', async () => {
    expect(await check(CreateBankTransactionDto, manual({ amount: 10.123 }))).toEqual([
      'amount.isNumber',
    ]);
    expect(await check(CreateBankTransactionDto, manual({ amount: 10.12 }))).toEqual([]);
  });

  // guards: BR-BANK-021
  it.each([
    ['неіснуюча дата', '2026-02-31'],
    ['29 лютого невисокосного року', '2025-02-29'],
    ['ISO з часом', '2026-10-09T10:00:00Z'],
    ['ISO з часом і поясом', '2026-10-09T00:00:00+03:00'],
    ['формат банку', '09.10.2026'],
    ['порожня', ''],
  ])('дата операції: %s («%s») → відхиляється', async (_name, operationDate) => {
    const errors = await check(CreateBankTransactionDto, manual({ operationDate }));
    expect(errors.filter(e => e.startsWith('operationDate.')).length).toBeGreaterThan(0);
  });

  // guards: BR-BANK-021
  it('29 лютого високосного року — існуюча дата, проходить', async () => {
    expect(await check(CreateBankTransactionDto, manual({ operationDate: '2028-02-29' }))).toEqual(
      [],
    );
  });

  // guards: BR-BANK-017
  it.each(['SIDEWAYS', 'in', '', undefined])('напрям «%s» → відхиляється', async direction => {
    expect(await check(CreateBankTransactionDto, manual({ direction }))).toEqual([
      'direction.isEnum',
    ]);
  });

  // guards: BR-BANK-014, BR-BANK-023
  it('bankAccountId не UUID → відхиляється', async () => {
    expect(await check(CreateBankTransactionDto, manual({ bankAccountId: 'ba-1' }))).toEqual([
      'bankAccountId.isUuid',
    ]);
  });

  // guards: BR-BANK-023
  it('порожні необов’язкові поля контрагента й призначення означають «не вказано»', async () => {
    const plain = manual({ payerName: '', payerIban: '', payerEdrpou: '', purpose: '' });
    expect(await check(CreateBankTransactionDto, plain)).toEqual([]);
    expect(plainToInstance(CreateBankTransactionDto, plain).payerIban).toBeUndefined();
  });
});

describe('ApplyRowDto.direction / PreviewImportColumnMapping — напрям в імпорті', () => {
  const mapping = (over: Record<string, unknown> = {}) => ({
    dateCol: 1,
    amountCol: 2,
    externalIdCol: 3,
    ...over,
  });

  // guards: BR-BANK-017
  it('напрям рядка необов’язковий: без нього, IN і OUT проходять', async () => {
    for (const extra of [{}, { direction: 'IN' }, { direction: 'OUT' }]) {
      expect(
        await check(ApplyImportDto, { bankAccountId: ACCOUNT_ID, rows: [row(extra)] }),
      ).toEqual([]);
    }
  });

  // guards: BR-BANK-017
  it('напрям рядка поза IN / OUT → відхиляється', async () => {
    expect(
      await check(ApplyImportDto, {
        bankAccountId: ACCOUNT_ID,
        rows: [row({ direction: 'DEBIT' })],
      }),
    ).toEqual(['rows.0.direction.isEnum']);
  });

  // Сума у рядку завжди додатна — від'ємну «вихідну» суму не можна передати замість напряму.
  // guards: BR-BANK-017
  it('вихідний рядок з від’ємною сумою → відхиляється (напрям — полем, а не знаком)', async () => {
    expect(
      await check(ApplyImportDto, {
        bankAccountId: ACCOUNT_ID,
        rows: [row({ direction: 'OUT', amount: -150 })],
      }),
    ).toEqual(['rows.0.amount.min']);
  });

  // guards: BR-BANK-018
  it.each(BANK_IMPORT_DIRECTION_MODES)('directionMode %s проходить', async directionMode => {
    expect(await check(PreviewImportColumnMapping, mapping({ directionMode }))).toEqual([]);
  });

  // guards: BR-BANK-018
  it('directionMode поза SIGN / IN / OUT → відхиляється; без нього — проходить (типово SIGN)', async () => {
    expect(await check(PreviewImportColumnMapping, mapping({ directionMode: 'DEBIT' }))).toEqual([
      'directionMode.isIn',
    ]);
    expect(await check(PreviewImportColumnMapping, mapping())).toEqual([]);
  });

  // guards: BR-BANK-018
  it('debitCol — номер колонки від 1: рядок із form-data коерситься, 0 і дріб відхиляються', async () => {
    expect(await check(PreviewImportColumnMapping, mapping({ debitCol: '4' }))).toEqual([]);
    expect(await check(PreviewImportColumnMapping, mapping({ debitCol: 0 }))).toEqual([
      'debitCol.min',
    ]);
    expect(await check(PreviewImportColumnMapping, mapping({ debitCol: 2.5 }))).toEqual([
      'debitCol.isInt',
    ]);
  });
});

describe('ListQueryDto — відбір списку платежів', () => {
  // guards: BR-BANK-014
  it('порожні direction / dateFrom / dateTo означають «без відбору», а не 400', async () => {
    expect(await check(ListQueryDto, { direction: '', dateFrom: '', dateTo: '' })).toEqual([]);
  });

  // guards: BR-BANK-014
  it.each(['2026-02-31', '2026-03-09T10:00:00Z', '09.03.2026'])(
    'дата %s → відхиляється (лише існуюча календарна YYYY-MM-DD)',
    async dateFrom => {
      expect((await check(ListQueryDto, { dateFrom })).length).toBeGreaterThan(0);
    },
  );

  // guards: BR-BANK-014
  it('q довший за ліміт пошуку → відхиляється; рівно ліміт проходить', async () => {
    expect(await check(ListQueryDto, { q: 'а'.repeat(100) })).toEqual([]);
    expect(await check(ListQueryDto, { q: 'а'.repeat(101) })).toEqual(['q.maxLength']);
  });

  // guards: BR-BANK-014
  it('direction поза IN / OUT → відхиляється', async () => {
    expect(await check(ListQueryDto, { direction: 'SIDEWAYS' })).toEqual(['direction.isEnum']);
    expect(await check(ListQueryDto, { direction: 'OUT' })).toEqual([]);
  });
});
