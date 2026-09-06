import { describe, it, expect } from 'vitest';
import { pickScannedGood, looksLikeBarcode } from '@/lib/barcode';

const g = (id: string, barcode?: string | null, barcodes?: string[]) => ({
  id,
  barcode,
  barcodes,
});

describe('pickScannedGood — scan-submit логіка', () => {
  it('точний збіг головного ШК → той товар (навіть якщо результатів кілька)', () => {
    const items = [g('a', '111'), g('b', '222'), g('c', '333')];
    expect(pickScannedGood(items, '222')?.id).toBe('b');
  });

  it('точний збіг ДОДАТКОВОГО ШК (barcodes[]) → той товар', () => {
    const items = [g('a', '111', ['999', '888']), g('b', '222')];
    expect(pickScannedGood(items, '888')?.id).toBe('a');
  });

  it('точний ШК має пріоритет над «єдиний результат»', () => {
    const items = [g('a', '111'), g('b', '222')];
    expect(pickScannedGood(items, '111')?.id).toBe('a'); // не бере b лише бо 2 результати
  });

  it('немає точного, але РІВНО один результат → беремо його', () => {
    const items = [g('a', '111')];
    expect(pickScannedGood(items, 'болт')?.id).toBe('a');
  });

  it('немає точного + кілька результатів → null (не вгадуємо)', () => {
    const items = [g('a', '111'), g('b', '222')];
    expect(pickScannedGood(items, 'болт')).toBeNull();
  });

  it('порожній ввід або порожній список → null', () => {
    expect(pickScannedGood([g('a', '111')], '')).toBeNull();
    expect(pickScannedGood([g('a', '111')], '   ')).toBeNull();
    expect(pickScannedGood([], '111')).toBeNull();
  });

  it('trim введеного перед порівнянням', () => {
    const items = [g('a', '111'), g('b', '222')];
    expect(pickScannedGood(items, ' 222 ')?.id).toBe('b');
  });
});

describe('looksLikeBarcode', () => {
  it('лише цифри ≥8 → true', () => {
    expect(looksLikeBarcode('4820000000012')).toBe(true);
    expect(looksLikeBarcode('12345678')).toBe(true);
  });
  it('короткі/з літерами → false', () => {
    expect(looksLikeBarcode('1234567')).toBe(false); // 7 цифр
    expect(looksLikeBarcode('ABC12345')).toBe(false);
    expect(looksLikeBarcode('болт')).toBe(false);
  });
});
