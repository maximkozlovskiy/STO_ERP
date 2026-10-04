#!/usr/bin/env node
/**
 * Бюджет first-load на СТОРІНКУ (gzip).
 *
 * НАВІЩО ОКРЕМИЙ СКРИПТ, А НЕ ЩЕ ОДИН ЗАПИС У .size-limit.json: `size-limit` рахує
 * СУМУ файлів, що підпали під glob. Для `chunks/*.js` це 1.28 MB — сума всього, а не
 * те, що вантажить одна сторінка. Запис із назвою «найбільший чанк» вимірював би зовсім
 * інше, ніж обіцяє назва. Тут натомість читаємо, які чанки РЕАЛЬНО згадані у HTML
 * конкретної сторінки, і сумуємо лише їх — це і є first load для планшета механіка.
 *
 * Чому не прив'язуємось до імен чанків: Turbopack дає хешовані імена без стабільних
 * `framework`/`main`, тож єдине надійне джерело — сам згенерований HTML.
 *
 * Запуск: `pnpm --filter @sto/web size:pages` (після `build`).
 */
import { readFileSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(webRoot, 'out');

/** Ліміт на сторінку, KB gzip. Виміряно 2026-10-04: 408–510 KB. */
const LIMIT_KB = 560;

/** Сторінки-представники: найважча (invoices) + типові робочі. */
const PAGES = ['invoices', 'work-orders', 'reports', 'dashboard'];

if (!existsSync(OUT)) {
  console.error('out/ не знайдено — спершу `pnpm --filter @sto/web build`');
  process.exit(1);
}

let worst = 0;
let failed = false;

for (const page of PAGES) {
  const html = join(OUT, page, 'index.html');
  if (!existsSync(html)) {
    console.error(`✗ ${page}: немає ${html} — сторінку перейменовано чи прибрано?`);
    failed = true;
    continue;
  }
  const src = readFileSync(html, 'utf8');
  const chunks = [...new Set(src.match(/static\/chunks\/[A-Za-z0-9_-]+\.js/g) ?? [])];
  if (chunks.length === 0) {
    console.error(`✗ ${page}: у HTML не знайдено жодного чанка — змінився формат export?`);
    failed = true;
    continue;
  }
  let bytes = 0;
  for (const c of chunks) {
    const p = join(OUT, '_next', c);
    if (existsSync(p)) bytes += gzipSync(readFileSync(p)).length;
  }
  const kb = Math.round(bytes / 1024);
  worst = Math.max(worst, kb);
  const over = kb > LIMIT_KB;
  if (over) failed = true;
  console.log(
    `${over ? '✗' : '✓'} ${page.padEnd(14)} ${String(kb).padStart(4)} KB gzip  (${chunks.length} чанків)`,
  );
}

console.log(`\nНайважча сторінка: ${worst} KB · ліміт ${LIMIT_KB} KB gzip`);
if (failed) {
  console.error(
    '\nБюджет перевищено. Це не «підняти ліміт»: спершу подивіться, ЩО додалось —\n' +
      'зазвичай це нова важка залежність, яку варто вантажити динамічно (next/dynamic).',
  );
  process.exit(1);
}
