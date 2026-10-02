import { describe, it, expect } from 'vitest';
import { purchaseOrderFormSchema, purchaseOrderUpdateSchema } from '@sto/shared';

const SUP = '11111111-1111-4111-8111-111111111111';
const WH = '22222222-2222-4222-8222-222222222222';
const GOOD = '44444444-4444-4444-8444-444444444444';
const CONTRACT = '55555555-5555-4555-8555-555555555555';
const CURRENCY = '66666666-6666-4666-8666-666666666666';

const line = { goodId: GOOD, quantity: '2', price: '10' };

describe('purchaseOrderFormSchema (спільна, web ↔ api)', () => {
  it('валідний create з рядками; quantity/price коерситься; pricedSalePrice опційна', () => {
    const r = purchaseOrderFormSchema.safeParse({
      supplierId: SUP,
      warehouseId: WH,
      currencyId: CURRENCY,
      lines: [{ ...line, pricedSalePrice: '15' }],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.lines[0].quantity).toBe(2);
      expect(r.data.lines[0].price).toBe(10);
      expect(r.data.lines[0].pricedSalePrice).toBe(15);
    }
  });

  it('UA-кома у quantity/price/pricedSalePrice: "1,5" → 1.5 (moneyString backstop, не NaN/усічення)', () => {
    const r = purchaseOrderFormSchema.safeParse({
      supplierId: SUP,
      warehouseId: WH,
      lines: [{ goodId: GOOD, quantity: '1,5', price: '10,25', pricedSalePrice: '20,5' }],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.lines[0].quantity).toBe(1.5); // не 1 (parseFloat-усічення) і не NaN (Number)
      expect(r.data.lines[0].price).toBe(10.25);
      expect(r.data.lines[0].pricedSalePrice).toBe(20.5);
    }
  });

  it('supplierId не UUID → помилка «Оберіть постачальника»', () => {
    const r = purchaseOrderFormSchema.safeParse({
      supplierId: 'x',
      warehouseId: WH,
      lines: [line],
    });
    expect(r.success).toBe(false);
    if (!r.success)
      expect(r.error.issues.find(i => i.path[0] === 'supplierId')?.message).toBe(
        'v.purchaseOrder.supplier.required',
      );
  });

  it('price ОБОВʼЯЗКОВА — рядок без ціни → помилка', () => {
    const r = purchaseOrderFormSchema.safeParse({
      supplierId: SUP,
      warehouseId: WH,
      lines: [{ goodId: GOOD, quantity: '1' }],
    });
    expect(r.success).toBe(false);
  });

  it('quantity ≤ 0 → помилка', () => {
    const r = purchaseOrderFormSchema.safeParse({
      supplierId: SUP,
      warehouseId: WH,
      lines: [{ goodId: GOOD, quantity: '0', price: '10' }],
    });
    expect(r.success).toBe(false);
    if (!r.success)
      expect(r.error.issues.some(i => i.message === 'v.purchaseOrder.line.quantity.min')).toBe(
        true,
      );
  });

  it('trackingNumber > 64 символів → помилка (validation-parity @MaxLength(64))', () => {
    const r = purchaseOrderFormSchema.safeParse({
      supplierId: SUP,
      warehouseId: WH,
      trackingNumber: 'x'.repeat(65),
      lines: [line],
    });
    expect(r.success).toBe(false);
  });

  it('битий documentDate/paymentDate → помилка (validation-parity @IsDateString)', () => {
    const r1 = purchaseOrderFormSchema.safeParse({
      supplierId: SUP,
      warehouseId: WH,
      documentDate: 'not-a-date',
      lines: [line],
    });
    expect(r1.success).toBe(false);
    const r2 = purchaseOrderFormSchema.safeParse({
      supplierId: SUP,
      warehouseId: WH,
      paymentDate: 'nope',
      lines: [line],
    });
    expect(r2.success).toBe(false);
  });

  it('порожні lines — валідно (default [])', () => {
    const r = purchaseOrderFormSchema.safeParse({ supplierId: SUP, warehouseId: WH });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.lines).toEqual([]);
  });

  it('update — усі поля опційні; порожній обʼєкт ok', () => {
    expect(purchaseOrderUpdateSchema.safeParse({}).success).toBe(true);
  });

  it('update — contractId null очищає (nullable, @ValidateIf value!==null)', () => {
    const r = purchaseOrderUpdateSchema.safeParse({ contractId: null });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.contractId).toBeNull();
  });

  it('update — contractId UUID встановлює; trackingNumber null очищає', () => {
    const r = purchaseOrderUpdateSchema.safeParse({
      contractId: CONTRACT,
      trackingNumber: null,
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.contractId).toBe(CONTRACT);
      expect(r.data.trackingNumber).toBeNull();
    }
  });

  it('update з lines — quantity/price коерситься', () => {
    const r = purchaseOrderUpdateSchema.safeParse({ lines: [line] });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.lines?.[0].price).toBe(10);
  });
});
