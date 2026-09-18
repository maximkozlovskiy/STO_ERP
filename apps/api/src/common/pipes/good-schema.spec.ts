import { describe, it, expect } from 'vitest';
import { goodFormSchema } from '@sto/shared';

// Спільна zod-схема товару (packages/shared) — тестуємо тут, бо @sto/shared не має власного
// test-runner; api вже споживає shared і має vitest. Дзеркальний тест для web-боку — у формі.
describe('goodFormSchema (спільна zod-схема, web ↔ api)', () => {
  it('приймає мінімальний валідний товар (лише name)', () => {
    const r = goodFormSchema.safeParse({ name: 'Масло 5W-40' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.name).toBe('Масло 5W-40');
  });

  it('відхиляє порожню назву з укр. повідомленням', () => {
    const r = goodFormSchema.safeParse({ name: '   ' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toBe('v.good.name.required');
  });

  it("коерсить ціну з рядка у число; '' → undefined", () => {
    const r = goodFormSchema.safeParse({ name: 'X', purchasePrice: '350', salePrice: '' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.purchasePrice).toBe(350);
      expect(r.data.salePrice).toBeUndefined();
    }
  });

  it("відхиляє від'ємну ціну", () => {
    const r = goodFormSchema.safeParse({ name: 'X', salePrice: '-5' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toBe('v.nonNeg');
  });

  it("порожній опційний UUID ('') → undefined, не помилка", () => {
    const r = goodFormSchema.safeParse({ name: 'X', brandId: '', unitId: '', goodCategoryId: '' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.brandId).toBeUndefined();
      expect(r.data.unitId).toBeUndefined();
    }
  });

  it('відхиляє невалідний UUID бренду', () => {
    const r = goodFormSchema.safeParse({ name: 'X', brandId: 'not-a-uuid' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toBe('v.uuid');
  });

  it('приймає валідний goodType; невідомий — відхиляє', () => {
    expect(goodFormSchema.safeParse({ name: 'X', goodType: 'SPARE_PART' }).success).toBe(true);
    expect(goodFormSchema.safeParse({ name: 'X', goodType: '' }).success).toBe(true);
    expect(goodFormSchema.safeParse({ name: 'X', goodType: 'WEIRD' }).success).toBe(false);
  });

  it('приймає повністю типізований JSON (числа вже number) — для бек-валідації', () => {
    const r = goodFormSchema.safeParse({
      name: 'Фільтр',
      purchasePrice: 120,
      salePrice: 200,
      brandId: '11111111-1111-1111-1111-111111111111',
    });
    expect(r.success).toBe(true);
  });
});
