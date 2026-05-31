import { describe, it, expect } from 'vitest';
import { emptyToUndefined } from './empty-to-undefined';

// `class-transformer` `@Transform` викликає трансформер з `TransformFnParams`-об'єктом,
// з якого ми використовуємо лише поле `value`. Тести наслідують цю shape.
describe('emptyToUndefined', () => {
  it('перетворює порожній рядок на undefined', () => {
    expect(emptyToUndefined({ value: '' })).toBeUndefined();
  });

  it('пропускає null без змін (не перетворює на undefined)', () => {
    // class-validator `@IsOptional()` пропускає і `undefined`, і `null` — null лишається null
    // щоб сервіс міг розрізнити "не передавали поле" (`undefined`) і "очистити поле" (`null`).
    expect(emptyToUndefined({ value: null })).toBeNull();
  });

  it('пропускає undefined без змін', () => {
    expect(emptyToUndefined({ value: undefined })).toBeUndefined();
  });

  it('пропускає число 0 (НЕ trick falsy check)', () => {
    // Регресія від помилкового `!value ? undefined : value` — 0 валідний для @IsNumber().
    expect(emptyToUndefined({ value: 0 })).toBe(0);
  });

  it('пропускає false (НЕ trick falsy check)', () => {
    expect(emptyToUndefined({ value: false })).toBe(false);
  });

  it('пропускає валідний UUID рядок без змін', () => {
    const uuid = '11111111-1111-4111-8111-111111111111';
    expect(emptyToUndefined({ value: uuid })).toBe(uuid);
  });

  it('пропускає не-порожній рядок з пробілами без змін (trim — обов’язок іншого валідатора)', () => {
    expect(emptyToUndefined({ value: '   ' })).toBe('   ');
  });

  it('пропускає масиви/обʼєкти без змін', () => {
    const arr: unknown[] = [];
    const obj = { a: 1 };
    expect(emptyToUndefined({ value: arr })).toBe(arr);
    expect(emptyToUndefined({ value: obj })).toBe(obj);
  });
});
