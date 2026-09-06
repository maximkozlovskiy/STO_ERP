import { plainToInstance } from 'class-transformer';
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
