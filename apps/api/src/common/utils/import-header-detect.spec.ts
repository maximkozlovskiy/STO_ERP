import { describe, it, expect } from 'vitest';
import { normalizeHeader, detectMappingFromGrid } from '@sto/shared';
import { normalizeArticle } from './normalize-article';

/**
 * Тести автовизначення колонок імпорту. Код живе у packages/shared (споживається і web, і api),
 * але spec — тут, бо у @sto/shared немає налаштованого test-runner (лише type-check + build).
 */

describe('normalizeHeader', () => {
  it.each([
    // [вхід, очікуване]
    ['Артикул', 'артикул'],
    ['Артикул (SKU)', 'артикул sku'],
    ['SKU', 'sku'],
    ['Найменування', 'найменування'],
    ['Назва товару', 'назва товару'],
    ['Ціна, ₴', 'ціна'],
    ['Ціна, грн', 'ціна'],
    ['Сума, грн', 'сума'],
    ['Ціна закупки, ₴', 'ціна закупки'],
    ['Ціна без ПДВ', 'ціна без пдв'],
    ['К-сть', 'к-сть'],
    ['К-ть', 'к-ть'],
    ['Кількість', 'кількість'],
    ['Од. виміру', 'од виміру'],
    ['№', ''],
    ['  Бренд  ', 'бренд'],
    ['', ''],
  ])('%s → %s', (input, expected) => {
    expect(normalizeHeader(input)).toBe(expected);
  });

  it('NBSP (частий у Excel-експортах) трактується як звичайний пробіл', () => {
    expect(normalizeHeader('Ціна закупки')).toBe('ціна закупки');
  });

  it('типографське тире і пробіли навколо дефіса стискаються', () => {
    expect(normalizeHeader('К – ть')).toBe('к-ть');
    expect(normalizeHeader('К - ть')).toBe('к-ть');
  });

  it('апостроф прибирається (кіл’сть ≡ кілсть)', () => {
    expect(normalizeHeader('Кіл’сть')).toBe('кілсть');
  });

  it('null/undefined → порожній рядок (без падіння)', () => {
    expect(normalizeHeader(null)).toBe('');
    expect(normalizeHeader(undefined)).toBe('');
  });

  // ── Регресійний guard проти R1 ──
  it('НЕ поводиться як normalizeArticle: кирилиця зберігається', () => {
    // normalizeArticle НАВМИСНО знищує кирилицю → всі укр. заголовки стали б '' і зіставились
    // би з усім підряд. Цей тест фіксує, що для заголовків ми його НЕ використовуємо.
    expect(normalizeArticle('Артикул')).toBe('');
    expect(normalizeArticle('Бренд')).toBe('');

    expect(normalizeHeader('Артикул')).not.toBe('');
    expect(normalizeHeader('Бренд')).not.toBe('');
    expect(normalizeHeader('Артикул')).not.toBe(normalizeHeader('Бренд'));
  });
});

describe('detectMappingFromGrid', () => {
  it('шапка з фікстури майстра: Код/Артикул/Бренд/К-сть', () => {
    const r = detectMappingFromGrid([
      ['Код', 'Артикул', 'Бренд', 'К-сть'],
      ['1', 'A1', 'VAG', '2'],
    ]);
    expect(r.headerRowIndex).toBe(0);
    expect(r.startRow).toBe(2);
    expect(r.cols).toEqual({ codeCol: 1, articleCol: 2, brandCol: 3, quantityCol: 4 });
  });

  it('XLSX-шаблон проєкту: Артикул (SKU)/Назва товару/К-ть/Ціна, ₴', () => {
    const r = detectMappingFromGrid([['Артикул (SKU)', 'Назва товару', 'К-ть', 'Ціна, ₴']]);
    expect(r.cols).toEqual({ articleCol: 1, nameCol: 2, quantityCol: 3, priceCol: 4 });
  });

  it('реальна накладна з «№» і «Сума»: службові колонки не мапляться', () => {
    const r = detectMappingFromGrid([['№', 'Артикул', 'Найменування', 'К-сть', 'Ціна', 'Сума']]);
    expect(r.cols).toEqual({ articleCol: 2, nameCol: 3, quantityCol: 4, priceCol: 5 });
    // «Сума» (колонка 6) — у негативному списку, у priceCol не потрапляє
    expect(Object.values(r.cols)).not.toContain(6);
  });

  it('усі 6 ролей розпізнаються', () => {
    const r = detectMappingFromGrid([
      ['Код', 'Артикул', 'Виробник', 'Найменування', 'Кількість', 'Ціна без ПДВ', 'Сума, грн'],
    ]);
    expect(r.cols).toEqual({
      codeCol: 1,
      articleCol: 2,
      brandCol: 3,
      nameCol: 4,
      quantityCol: 5,
      priceCol: 6,
    });
    expect(r.matchedCount).toBe(6);
  });

  it('експорт нарядів: «Од.» і «Сума, грн» відкидаються', () => {
    const r = detectMappingFromGrid([['Назва', 'Кількість', 'Од.', 'Ціна, грн', 'Сума, грн']]);
    expect(r.cols).toEqual({ nameCol: 1, quantityCol: 2, priceCol: 4 });
  });

  it('російськомовна накладна', () => {
    const r = detectMappingFromGrid([['Кол-во', 'Цена', 'Наименование', 'Производитель']]);
    expect(r.cols).toEqual({ quantityCol: 1, priceCol: 2, nameCol: 3, brandCol: 4 });
  });

  it('шапка не в першому рядку → headerRowIndex і startRow зсуваються', () => {
    const r = detectMappingFromGrid([
      ['ТОВ «АвтоДеталь»', '', ''],
      ['Видаткова накладна № РН-00123', '', ''],
      ['Артикул', 'Найменування', 'К-сть'],
      ['A1', 'Фільтр', '2'],
    ]);
    expect(r.headerRowIndex).toBe(2);
    expect(r.startRow).toBe(4);
    expect(r.cols).toEqual({ articleCol: 1, nameCol: 2, quantityCol: 3 });
  });

  it('немає впізнаваних заголовків → порожній результат (без false-positive)', () => {
    const r = detectMappingFromGrid([['Склад', 'Примітка', 'Дата']]);
    expect(r.headerRowIndex).toBeNull();
    expect(r.cols).toEqual({});
    expect(r.matchedCount).toBe(0);
  });

  it('один випадковий збіг (<2 ролей) не вважається шапкою', () => {
    const r = detectMappingFromGrid([['Ціна', 'Щось', 'Інше']]);
    expect(r.headerRowIndex).toBeNull();
    expect(r.cols).toEqual({});
  });

  it('порожня сітка не падає', () => {
    const r = detectMappingFromGrid([]);
    expect(r.headerRowIndex).toBeNull();
    expect(r.startRow).toBe(2);
  });

  it('колонка не призначається двом ролям (жадібне 1:1)', () => {
    const r = detectMappingFromGrid([['Артикул', 'Артикул', 'К-сть']]);
    const used = Object.values(r.cols);
    expect(new Set(used).size).toBe(used.length);
  });

  it('точний збіг виграє у часткового: «Ціна» перебиває «Ціна закупки»', () => {
    const r = detectMappingFromGrid([['Найменування', 'Ціна закупки', 'Ціна', 'К-сть']]);
    expect(r.cols.priceCol).toBe(3);
  });

  it('«Ціна продажу» не мапиться у priceCol (негативний список)', () => {
    const r = detectMappingFromGrid([['Артикул', 'Найменування', 'Ціна продажу']]);
    expect(r.cols.priceCol).toBeUndefined();
  });
});
