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

  // Bug #N (ambiguity): два товари з ОДНАКОВИМ точним ШК (data-entry помилка: той самий
  // код у головному barcode одного і у sub-barcode іншого). Раніше повертався ПЕРШИЙ —
  // для фінансового документа це тихий вибір «не того» товару. Тепер → null (показати список).
  it('кілька точних ШК-збігів (неоднозначно) → null, а не перший', () => {
    const items = [g('a', '777'), g('b', '777')];
    expect(pickScannedGood(items, '777')).toBeNull();
  });

  it('точний збіг у головному одного + у sub-barcode іншого → null (неоднозначно)', () => {
    const items = [g('a', '777'), g('b', '222', ['777'])];
    expect(pickScannedGood(items, '777')).toBeNull();
  });

  it('дублікат ШК в межах ОДНОГО товару (головний == sub) не робить його неоднозначним', () => {
    // один і той самий об'єкт матчиться раз — це РІВНО один товар, а не колізія.
    const items = [g('a', '777', ['777']), g('b', '222')];
    expect(pickScannedGood(items, '777')?.id).toBe('a');
  });

  // Bug #N (contains-not-exact): pickScannedGood НЕ підтверджує що єдиний результат
  // справді має цей ШК. Якщо бек повернув 1 товар за contains-матчем головного ШК
  // (введене «12» ⊂ «123456»), а точного немає — правило «єдиний результат» бере його.
  // Документуємо цю поведінку: single-result auto-select навмисний (пошук за назвою теж
  // дає єдиний товар без ШК-збігу). Виклик contains-only + 1 результат → беремо.
  it('єдиний результат без точного ШК (contains-only) → беремо (навмисно)', () => {
    const items = [g('a', '123456')];
    expect(pickScannedGood(items, '12')?.id).toBe('a');
  });

  it('contains-only + КІЛЬКА результатів без точного → null (не вгадуємо)', () => {
    const items = [g('a', '123456'), g('b', '129999')];
    expect(pickScannedGood(items, '12')).toBeNull();
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
