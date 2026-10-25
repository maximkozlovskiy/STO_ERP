import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import type { ArgumentMetadata } from '@nestjs/common';
import { RejectNulCharacterPipe } from './reject-nul-character.pipe';
import { globalPipes } from './global-pipes';
import { runWithTenant } from '../tenant/tenant-context';

/**
 * NUL (`\u0000`) у query/param/ТІЛІ → 400 замість 500 від Postgres («invalid byte sequence 0x00»).
 * TECH-DEBT §8 «Списки документів» п. 3: `?q=a%00b` давав 500 у будь-якому списку системи.
 * BR-SEC-NUL: та сама діра у тілі (`{name:"a\u0000b"}`) до 2026-10-25 проходила трубу й давала
 * безіменну 500 — тепер труба перевіряє й `body`.
 * Мутації: (1) прибрати перевірку в transform → кейси «query»/«param»/«тіло»/«вкладене» червоніють;
 * (2) повернути звуження `type !== 'query' && type !== 'param'` → кейс «тіло з NUL» червоніє;
 * (3) прибрати труба з globalPipes() → кейс «перша глобальна труба» червоніє.
 */
const pipe = new RejectNulCharacterPipe();
const meta = (type: ArgumentMetadata['type'], data?: string): ArgumentMetadata => ({
  type,
  data,
  metatype: String,
});

const errorOf = (fn: () => unknown): BadRequestException => {
  try {
    fn();
  } catch (e) {
    if (e instanceof BadRequestException) return e;
    throw e;
  }
  throw new Error('очікували BadRequestException');
};

describe('RejectNulCharacterPipe', () => {
  // guards: BR-PAY-025
  it('query-рядок із NUL → 400 з українським текстом', () => {
    const err = errorOf(() => pipe.transform('шин\u0000а', meta('query', 'q')));
    expect(err.message).toBe('Запит містить недопустимий символ (NUL)');
  });

  it('en-локаль запиту → англійський текст', () => {
    const err = runWithTenant({ locale: 'en' }, () =>
      errorOf(() => pipe.transform('a\u0000', meta('query', 'q'))),
    );
    expect(err.message).toBe('The request contains a disallowed character (NUL)');
  });

  it('query-DTO цілком (`@Query() dto`): NUL у вкладеному значенні чи масиві → 400', () => {
    expect(() => pipe.transform({ q: 'ok', types: ['A', 'B\u0000'] }, meta('query'))).toThrow(
      BadRequestException,
    );
    expect(() => pipe.transform({ filter: { name: { eq: 'x\u0000' } } }, meta('query'))).toThrow(
      BadRequestException,
    );
  });

  it('path-параметр із NUL → 400', () => {
    expect(() => pipe.transform('abc\u0000', meta('param', 'id'))).toThrow(BadRequestException);
  });

  // guards: BR-SEC-NUL
  it('тіло запиту з NUL у рядковому полі → 400 (BR-SEC-NUL)', () => {
    expect(() => pipe.transform({ name: 'a\u0000b' }, meta('body'))).toThrow(BadRequestException);
    // вкладене поле тіла теж
    expect(() => pipe.transform({ vehicle: { vin: 'x\u0000' } }, meta('body'))).toThrow(
      BadRequestException,
    );
  });

  it('валідне тіло, query та custom-аргумент проходять як є', () => {
    const body = { notes: 'нотатка без NUL', amount: 100 };
    expect(pipe.transform(body, meta('body'))).toBe(body);
    const q = { q: 'шина 205/55', page: '2' };
    expect(pipe.transform(q, meta('query'))).toBe(q);
    expect(pipe.transform(undefined, meta('query', 'q'))).toBeUndefined();
    // custom-аргумент (напр. orgId з @OrgContext) трубу проходить без обходу, навіть якби мав NUL
    expect(pipe.transform('org\u0000id', meta('custom'))).toBe('org\u0000id');
  });

  // guards: BR-PAY-025
  it('globalPipes(): перша труба — RejectNulCharacterPipe, далі ValidationPipe; main.ts бере саме їх', () => {
    const pipes = globalPipes();
    expect(pipes[0]).toBeInstanceOf(RejectNulCharacterPipe);
    expect(pipes[1]).toBeInstanceOf(ValidationPipe);
    const main = readFileSync(join(__dirname, '..', '..', 'main.ts'), 'utf8');
    expect(main).toContain('app.useGlobalPipes(...globalPipes())');
  });
});
