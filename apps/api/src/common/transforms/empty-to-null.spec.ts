import { describe, it, expect } from 'vitest';
import { emptyToNull } from './empty-to-null';

// `class-transformer` `@Transform` викликає трансформер з `TransformFnParams`-об'єктом,
// з якого ми використовуємо лише поле `value`. Тести наслідують цю shape.
describe('emptyToNull', () => {
  it('перетворює порожній рядок на null (сигнал "очистити поле")', () => {
    expect(emptyToNull({ value: '' })).toBeNull();
  });

  it('пропускає null без змін', () => {
    expect(emptyToNull({ value: null })).toBeNull();
  });

  it('пропускає undefined без змін (поле не передавали — Prisma updateMany його ігнорує)', () => {
    expect(emptyToNull({ value: undefined })).toBeUndefined();
  });

  it('пропускає число 0 (НЕ trick falsy check)', () => {
    expect(emptyToNull({ value: 0 })).toBe(0);
  });

  it('пропускає false (НЕ trick falsy check)', () => {
    expect(emptyToNull({ value: false })).toBe(false);
  });

  it('пропускає валідний рядок без змін', () => {
    expect(emptyToNull({ value: 'checkbox' })).toBe('checkbox');
  });
});
