import { describe, it, expect } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate, type ValidationError } from 'class-validator';
import { ApplyImportDto, IgnoreTransactionDto, MatchTransactionDto } from './bank-statement.dto';

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
