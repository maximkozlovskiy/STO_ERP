/**
 * Тіло зміни підключення до API постачальника (BR-SCON-002): порожнє значення поля, яке можна
 * очистити (назва, адреса API, термін за замовчуванням), означає «очистити» (null), а відсутнє —
 * «не чіпати». Одна схема для картки на web і для маршруту api.
 */
import { describe, expect, it } from 'vitest';
import { supplierConnectionUpdateSchema } from './supplier-api.schema';

describe('supplierConnectionUpdateSchema — очищення полів', () => {
  // guards: BR-SCON-002
  it('Bug #891: порожня назва → null (очистити); відсутня — undefined (не чіпати)', () => {
    const cleared = supplierConnectionUpdateSchema.parse({ name: '' });
    expect(cleared.name).toBeNull();
    expect(supplierConnectionUpdateSchema.parse({ name: null }).name).toBeNull();
    expect(supplierConnectionUpdateSchema.parse({}).name).toBeUndefined();
    expect(supplierConnectionUpdateSchema.parse({ name: 'AVD основний' }).name).toBe(
      'AVD основний',
    );
    expect(supplierConnectionUpdateSchema.safeParse({ name: 'x'.repeat(121) }).success).toBe(false);
  });
});
