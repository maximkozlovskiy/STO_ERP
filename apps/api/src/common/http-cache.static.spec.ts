/**
 * Статичний сторож: жоден контролер не віддає редагований список із `max-age` у Cache-Control.
 *
 * Чому. З `max-age=300` браузер 5 хвилин віддає список зі СВОГО кешу, не питаючи сервер. Після
 * збереження сторінка перечитує список і отримує стару копію: таблиця показує дані до правки,
 * форма відкривається з них же — і наступне збереження стирає щойно додане.
 *
 *  - Bug #299 (одиниці виміру): видалені й відновлені одиниці «жили» в браузері до 360 с.
 *  - 2026-10-12 (бренди): «не зберігаються синоніми» — сервер зберігав, браузер показував старе,
 *    а повторне збереження зі старої форми знімало попередній синонім.
 *
 * Обидва рази заголовок виправили в одному контролері, а в сусідніх лишили. Тому перевіряється
 * весь каталог контролерів, а не перелік відомих. Серверний Redis-кеш (скидається на кожен запис)
 * тримає відповідь швидкою й без браузерного кешу.
 *
 * Виняток вписується в ALLOWED разом із причиною: дані, які з інтерфейсу не редагуються.
 *
 * Mutation-verify: повернути `max-age=300` у будь-який контролер → кейс падає й називає файл.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it, expect } from 'vitest';

const MODULES_DIR = join(__dirname, '..', 'modules');

/** Контролери, яким браузерний кеш дозволено, і чому. */
const ALLOWED: Record<string, string> = {
  'system-templates/system-templates.controller.ts':
    'системні шаблони постачаються з релізом і з інтерфейсу не редагуються',
};

function controllers(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...controllers(full));
    else if (entry.endsWith('.controller.ts')) out.push(full);
  }
  return out;
}

/** Рядки з декоратором `@Header('Cache-Control', …)`, що містять `max-age` (коментарі не рахуються). */
function maxAgeHeaders(source: string): string[] {
  return source
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => !line.startsWith('//') && !line.startsWith('*'))
    .filter(line => /@Header\(\s*['"]Cache-Control['"]/.test(line) && /max-age/.test(line));
}

describe('HTTP-кеш списків: браузер не тримає копію редагованих даних', () => {
  const files = controllers(MODULES_DIR);
  const rel = (f: string) => relative(MODULES_DIR, f).replace(/\\/g, '/');

  it('сторож справді обходить контролери і бачить декоратор Cache-Control', () => {
    expect(files.length).toBeGreaterThan(30);
    const withHeader = files.filter(f =>
      /@Header\(\s*['"]Cache-Control['"]/.test(readFileSync(f, 'utf8')),
    );
    expect(withHeader.length).toBeGreaterThan(5);
  });

  it('жоден контролер поза переліком винятків не ставить max-age', () => {
    const offenders = files
      .map(f => ({ file: rel(f), lines: maxAgeHeaders(readFileSync(f, 'utf8')) }))
      .filter(x => x.lines.length > 0 && !(x.file in ALLOWED));
    expect(
      offenders,
      'редагований список із max-age: браузер віддаватиме стару копію після збереження — ' +
        "постав 'private, no-cache' або додай виняток з причиною в ALLOWED",
    ).toEqual([]);
  });

  it('кожен виняток досі існує й досі має max-age (перелік не застарів)', () => {
    for (const file of Object.keys(ALLOWED)) {
      const full = join(MODULES_DIR, file);
      expect(maxAgeHeaders(readFileSync(full, 'utf8')).length, file).toBeGreaterThan(0);
    }
  });
});
