// Сторож верстки карток документів на телефоні (390 px). Після Bug #1028 картка `size="content"` на
// телефоні на всю ширину, і все, що не переноситься, виходить за її край: шапка одним рядком різала дату
// й ховала «Статус» (Bug #1031), таблиця рядків `w-full table-fixed` без мінімальної ширини стискала
// стовпці до накладання заголовків, а обгортка `overflow-hidden` різала їх (Bug #1032).
// jsdom верстки не міряє — тому сторож читає джерело; живу перевірку робить E2E на 390 px.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const UI = join(__dirname, '..');
const cards = readdirSync(UI)
  .filter(f => f.endsWith('.tsx'))
  .map(f => ({ file: f, src: readFileSync(join(UI, f), 'utf8') }))
  .filter(c => c.src.includes('headerContent={'));

describe('картки документів на 390 px', () => {
  it('картки з шапкою документа знайдено (сторож не порожній)', () => {
    expect(cards.map(c => c.file)).toEqual(
      expect.arrayContaining([
        'CreateWorkOrderModal.tsx',
        'InvoiceCreateModal.tsx',
        'PurchaseOrderCreateModal.tsx',
        'StockDocumentCreateModal.tsx',
        'SupplierReturnCreateModal.tsx',
      ]),
    );
  });

  // Bug #1031
  it.each(cards.map(c => [c.file, c.src] as const))(
    '%s: шапка (`headerContent`) переноситься — flex-wrap',
    (_file, src) => {
      const wrapper = src.slice(src.indexOf('headerContent={')).match(/<div className="([^"]*)"/);
      expect(wrapper?.[1]).toMatch(/\bflex-wrap\b/);
    },
  );

  // Bug #1032
  it.each(cards.map(c => [c.file, c.src] as const))(
    '%s: таблиця рядків `table-fixed` — з min-w і прокруткою всередині картки',
    (_file, src) => {
      const tables = [...src.matchAll(/<div className="([^"]*)">\s*<table className="([^"]*)"/g)];
      for (const [, wrapper, table] of tables) {
        if (!/\btable-fixed\b/.test(table!)) continue;
        expect(table).toMatch(/\bmin-w-\[/);
        expect(wrapper).toMatch(/\boverflow-x-auto\b/);
      }
      // Таблиця без обгортки-div одразу перед нею — теж порушення (нема чим гортати).
      const bare = [...src.matchAll(/<table className="([^"]*)"/g)].filter(
        m => /\btable-fixed\b/.test(m[1]!) && !/\bmin-w-\[/.test(m[1]!),
      );
      expect(bare).toEqual([]);
    },
  );
});
