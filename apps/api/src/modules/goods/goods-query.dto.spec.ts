import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { describe, it, expect } from 'vitest';
import { GoodQueryDto } from './goods.dto';

/**
 * Bug #N (scanner trailing/leading spaces): сканер ШК (або ручний ввід) додає пробіли до
 * коду. Бек шукає sub-ШК через `equals` — не-обрізаний " 4820… " не збігається з кодом у
 * БД → сканування дає порожню видачу і нічого не вибирається. DTO мусить trim'ити `q`/`barcode`
 * ДО побудови where (порожнє після trim → undefined, аби не фільтрувати за пробілом).
 */
describe('GoodQueryDto — trim q/barcode (Bug #N сканер)', () => {
  it('обрізає провідні/кінцеві пробіли у q', () => {
    const dto = plainToInstance(GoodQueryDto, { q: '  4820000000012  ' });
    expect(dto.q).toBe('4820000000012');
  });

  it('обрізає провідні/кінцеві пробіли у barcode', () => {
    const dto = plainToInstance(GoodQueryDto, { barcode: ' 999 ' });
    expect(dto.barcode).toBe('999');
  });

  it('q лише з пробілів → undefined (не фільтр за пробілом)', () => {
    const dto = plainToInstance(GoodQueryDto, { q: '   ' });
    expect(dto.q).toBeUndefined();
  });

  it('barcode лише з пробілів → undefined', () => {
    const dto = plainToInstance(GoodQueryDto, { barcode: '  ' });
    expect(dto.barcode).toBeUndefined();
  });

  it('відсутні q/barcode лишаються undefined', () => {
    const dto = plainToInstance(GoodQueryDto, {});
    expect(dto.q).toBeUndefined();
    expect(dto.barcode).toBeUndefined();
  });

  it('нормальний код без пробілів не змінюється', () => {
    const dto = plainToInstance(GoodQueryDto, { q: '4820000000012', barcode: '999' });
    expect(dto.q).toBe('4820000000012');
    expect(dto.barcode).toBe('999');
  });
});

// guards: BR-WO-036 — товари наряду за id (`?ids=a,b` або повторений параметр), до 200.
describe('GoodQueryDto — ids', () => {
  const A = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';

  it('рядок через кому → масив без пробілів і порожніх', () => {
    const dto = plainToInstance(GoodQueryDto, { ids: ` ${A},,${B} ` });
    expect(dto.ids).toEqual([A, B]);
  });

  it('повторений параметр (масив) лишається масивом; порожній рядок → undefined', () => {
    expect(plainToInstance(GoodQueryDto, { ids: [A, B] }).ids).toEqual([A, B]);
    expect(plainToInstance(GoodQueryDto, { ids: '' }).ids).toBeUndefined();
  });

  it('не-UUID і понад 200 id — помилка валідації', () => {
    const bad = validateSync(plainToInstance(GoodQueryDto, { ids: 'abc' }));
    expect(bad.some(e => e.property === 'ids')).toBe(true);
    const many = Array.from({ length: 201 }, () => A).join(',');
    const tooMany = validateSync(plainToInstance(GoodQueryDto, { ids: many }));
    expect(tooMany.some(e => e.property === 'ids')).toBe(true);
    expect(validateSync(plainToInstance(GoodQueryDto, { ids: `${A},${B}` }))).toEqual([]);
  });
});
