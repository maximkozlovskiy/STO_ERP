import { describe, it, expect } from 'vitest';
import { csvArray } from './csv-array';

// `@Transform` передає `TransformFnParams`; трансформер читає лише `value`.
describe('csvArray', () => {
  it('розбиває рядок через кому й обрізає пробіли', () => {
    expect(csvArray({ value: 'SENT, OVERDUE' })).toEqual(['SENT', 'OVERDUE']);
  });

  it('повторений параметр (масив від Fastify) теж розбирається', () => {
    expect(csvArray({ value: ['SENT', 'OVERDUE,PAID'] })).toEqual(['SENT', 'OVERDUE', 'PAID']);
  });

  it('порожні частини відкидаються', () => {
    expect(csvArray({ value: 'SENT,,' })).toEqual(['SENT']);
  });

  it('нічого не лишилось → undefined (@IsOptional пропускає)', () => {
    expect(csvArray({ value: '' })).toBeUndefined();
    expect(csvArray({ value: undefined })).toBeUndefined();
    expect(csvArray({ value: [] })).toBeUndefined();
  });
});
