import { describe, it, expect } from 'vitest';
import { stockDocumentFormSchema, stockDocumentUpdateSchema } from '@sto/shared';

const BRANCH = '11111111-1111-4111-8111-111111111111';
const WH = '22222222-2222-4222-8222-222222222222';
const WH2 = '33333333-3333-4333-8333-333333333333';
const GOOD = '44444444-4444-4444-8444-444444444444';

const line = { goodId: GOOD, quantity: '2', price: '10' };

describe('stockDocumentFormSchema (спільна, web ↔ api)', () => {
  it('WRITEOFF з рядками — валідний; quantity/price коерситься з рядка', () => {
    const r = stockDocumentFormSchema.safeParse({
      type: 'WRITEOFF',
      branchId: BRANCH,
      warehouseId: WH,
      lines: [line],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.lines[0].quantity).toBe(2);
      expect(r.data.lines[0].price).toBe(10);
    }
  });

  it('TRANSFER без targetWarehouseId → помилка на targetWarehouseId (Bug #462)', () => {
    const r = stockDocumentFormSchema.safeParse({
      type: 'TRANSFER',
      branchId: BRANCH,
      warehouseId: WH,
      lines: [line],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const issue = r.error.issues.find(i => i.path[0] === 'targetWarehouseId');
      expect(issue?.message).toBe('v.stockDocument.transfer.targetRequired');
    }
  });

  it('TRANSFER де target === source → помилка (склади збігаються)', () => {
    const r = stockDocumentFormSchema.safeParse({
      type: 'TRANSFER',
      branchId: BRANCH,
      warehouseId: WH,
      targetWarehouseId: WH,
      lines: [line],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const issue = r.error.issues.find(i => i.path[0] === 'targetWarehouseId');
      expect(issue?.message).toBe('v.stockDocument.transfer.targetSame');
    }
  });

  it('TRANSFER з різними складами — валідний', () => {
    const r = stockDocumentFormSchema.safeParse({
      type: 'TRANSFER',
      branchId: BRANCH,
      warehouseId: WH,
      targetWarehouseId: WH2,
      lines: [line],
    });
    expect(r.success).toBe(true);
  });

  it('price опційна — рядок без ціни валідний (undefined)', () => {
    const r = stockDocumentFormSchema.safeParse({
      type: 'WRITEOFF',
      branchId: BRANCH,
      warehouseId: WH,
      lines: [{ goodId: GOOD, quantity: '1' }],
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.lines[0].price).toBeUndefined();
  });

  it('quantity ≤ 0 → помилка на рядку', () => {
    const r = stockDocumentFormSchema.safeParse({
      type: 'WRITEOFF',
      branchId: BRANCH,
      warehouseId: WH,
      lines: [{ goodId: GOOD, quantity: '0' }],
    });
    expect(r.success).toBe(false);
    if (!r.success)
      expect(r.error.issues.some(i => i.message === 'v.stockDocument.line.quantity.min')).toBe(
        true,
      );
  });

  it('goodId не UUID → помилка «Оберіть товар»', () => {
    const r = stockDocumentFormSchema.safeParse({
      type: 'WRITEOFF',
      branchId: BRANCH,
      warehouseId: WH,
      lines: [{ goodId: 'not-uuid', quantity: '1' }],
    });
    expect(r.success).toBe(false);
  });

  it('битий documentDate → помилка (validation-parity @IsDateString)', () => {
    const r = stockDocumentFormSchema.safeParse({
      type: 'WRITEOFF',
      branchId: BRANCH,
      warehouseId: WH,
      documentDate: 'not-a-date',
      lines: [line],
    });
    expect(r.success).toBe(false);
  });

  it('порожні lines — валідно (default [])', () => {
    const r = stockDocumentFormSchema.safeParse({
      type: 'WRITEOFF',
      branchId: BRANCH,
      warehouseId: WH,
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.lines).toEqual([]);
  });

  it('update — лише notes/documentDate/lines; порожній обʼєкт ok', () => {
    expect(stockDocumentUpdateSchema.safeParse({}).success).toBe(true);
    const r = stockDocumentUpdateSchema.safeParse({ notes: 'x', lines: [line] });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.lines?.[0].quantity).toBe(2);
  });
});
