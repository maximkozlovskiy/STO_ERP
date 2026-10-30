import { describe, it, expect } from 'vitest';
import { resources as shellResources } from './resources';
import { lazyResources } from './lazy-resources';

const resources = {
  uk: { ...shellResources.uk, ...lazyResources.uk },
  en: { ...shellResources.en, ...lazyResources.en },
};

/**
 * Тексти кнопок «?» (`CatalogHelp` / `HelpBlocks`, рішення власника 2026-10-29) — у каталогах
 * сторінок: `<topic>.title` і `<topic>.blocks` (розділи з пунктами-рядками або `{ term, text }`).
 * Паритет (`parity.test.ts`) порівнює лише листки; тут — що кожна тема, на яку посилається код,
 * є в обох мовах і має ту форму, яку `HelpBlocks` малює (пункт іншої форми він мовчки пропускає).
 *
 * Mutation-verify (2026-10-29): пункт `{ "term": "…" }` без `text` → падає «форма»; тема лише в uk
 * → падає «обидві мови».
 */
const TOPICS: ReadonlyArray<[ns: string, topic: string]> = [
  ['reports', 'help.revenue'],
  ['reports', 'help.workOrders'],
  ['reports', 'help.stock'],
  ['reports', 'help.settlements'],
  ['reports', 'help.load'],
  ['reports', 'help.profitability'],
  ['reports', 'help.pnl'],
  ['reports', 'help.vat'],
  ['inventory', 'help'],
  ['settlements', 'help'],
  ['pricingRules', 'help'],
  ['payroll', 'help'],
  ['bankStatements', 'help'],
  ['supplierPayments', 'schedule.help'],
  ['settings', 'numbers.help'],
  ['settings', 'workdays.help'],
  ['employees', 'editModal.rateHelp'],
  ['workOrders', 'partsTable.warehouseHelp'],
  ['workOrders', 'invoice.baseHelp'],
  ['automation', 'help'],
];

function pick(obj: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
      obj,
    );
}

const isEntry = (v: unknown): boolean =>
  (typeof v === 'string' && v.trim() !== '') ||
  (!!v &&
    typeof v === 'object' &&
    typeof (v as { term?: unknown }).term === 'string' &&
    typeof (v as { text?: unknown }).text === 'string');

describe('i18n — теми пояснень «?»', () => {
  it.each(TOPICS)('%s › %s: є в обох мовах і має форму HelpBlocks', (ns, topic) => {
    for (const lang of ['uk', 'en'] as const) {
      const catalog = (resources[lang] as Record<string, unknown>)[ns];
      const node = pick(catalog, topic) as { title?: unknown; blocks?: unknown } | undefined;
      expect(typeof node?.title, `${lang} ${ns}:${topic}.title`).toBe('string');
      expect(Array.isArray(node?.blocks), `${lang} ${ns}:${topic}.blocks`).toBe(true);
      for (const block of node!.blocks as Array<{ title?: unknown; items?: unknown }>) {
        expect(block.title === undefined || typeof block.title === 'string').toBe(true);
        expect(Array.isArray(block.items) && block.items.length > 0).toBe(true);
        for (const item of block.items as unknown[])
          expect(isEntry(item), `${lang} ${ns}:${topic} ${JSON.stringify(item)}`).toBe(true);
      }
    }
  });
});
