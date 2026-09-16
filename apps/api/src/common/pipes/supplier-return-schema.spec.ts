import { describe, it, expect } from 'vitest';
import { supplierReturnFormSchema, supplierReturnUpdateSchema } from '@sto/shared';

const SUP = '11111111-1111-1111-1111-111111111111';
const WH = '22222222-2222-2222-2222-222222222222';
const GOOD = '44444444-4444-4444-4444-444444444444';

const line = { goodId: GOOD, quantity: '2', price: '10' };

describe('supplierReturnFormSchema (спільна, web ↔ api)', () => {
  it('валідний create з рядками; quantity/price коерситься з рядка', () => {
    const r = supplierReturnFormSchema.safeParse({
      supplierId: SUP,
      warehouseId: WH,
      lines: [line],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.lines[0].quantity).toBe(2);
      expect(r.data.lines[0].price).toBe(10);
    }
  });

  it('supplierId не UUID → помилка «Оберіть постачальника»', () => {
    const r = supplierReturnFormSchema.safeParse({
      supplierId: 'x',
      warehouseId: WH,
      lines: [line],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const issue = r.error.issues.find(i => i.path[0] === 'supplierId');
      expect(issue?.message).toBe('Оберіть постачальника');
    }
  });

  it('price ОБОВʼЯЗКОВА (на відміну від StockDocument) — рядок без ціни → помилка', () => {
    const r = supplierReturnFormSchema.safeParse({
      supplierId: SUP,
      warehouseId: WH,
      lines: [{ goodId: GOOD, quantity: '1' }],
    });
    expect(r.success).toBe(false);
  });

  it('quantity ≤ 0 → помилка на рядку', () => {
    const r = supplierReturnFormSchema.safeParse({
      supplierId: SUP,
      warehouseId: WH,
      lines: [{ goodId: GOOD, quantity: '0', price: '10' }],
    });
    expect(r.success).toBe(false);
    if (!r.success)
      expect(r.error.issues.some(i => i.message.includes('більшою за нуль'))).toBe(true);
  });

  it("price від'ємна → помилка", () => {
    const r = supplierReturnFormSchema.safeParse({
      supplierId: SUP,
      warehouseId: WH,
      lines: [{ goodId: GOOD, quantity: '1', price: '-5' }],
    });
    expect(r.success).toBe(false);
  });

  it('unitOfMeasureId опційний UUID зберігається', () => {
    const UOM = '55555555-5555-5555-5555-555555555555';
    const r = supplierReturnFormSchema.safeParse({
      supplierId: SUP,
      warehouseId: WH,
      lines: [{ ...line, unitOfMeasureId: UOM }],
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.lines[0].unitOfMeasureId).toBe(UOM);
  });

  it('purchaseOrderId (create-only) приймається у формі', () => {
    const PO = '66666666-6666-6666-6666-666666666666';
    const r = supplierReturnFormSchema.safeParse({
      supplierId: SUP,
      warehouseId: WH,
      purchaseOrderId: PO,
      lines: [line],
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.purchaseOrderId).toBe(PO);
  });

  it('битий documentDate → помилка (validation-parity @IsDateString)', () => {
    const r = supplierReturnFormSchema.safeParse({
      supplierId: SUP,
      warehouseId: WH,
      documentDate: 'not-a-date',
      lines: [line],
    });
    expect(r.success).toBe(false);
  });

  it('update — усі поля опційні; БЕЗ purchaseOrderId (create-only)', () => {
    expect(supplierReturnUpdateSchema.safeParse({}).success).toBe(true);
    const r = supplierReturnUpdateSchema.safeParse({ supplierId: SUP, lines: [line] });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.lines?.[0].price).toBe(10);
      // purchaseOrderId ігнорується — не в схемі update
      expect('purchaseOrderId' in r.data).toBe(false);
    }
  });
});
