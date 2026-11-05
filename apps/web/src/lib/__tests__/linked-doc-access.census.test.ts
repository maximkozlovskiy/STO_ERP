// Сторож посилань на документи за роллю (техборг §15 п. 4): чи відкриє роль пов'язаний документ,
// вирішує лише `canOpen(kind, role)` з lib/nav (`nav.canOpen` / `<LinkedDocRef>`). Власний перелік
// ролей чи тернарник біля переходу повертає клас Bugs #899, #900, #914 — номер веде на 403.
//
// Mutation-verify: повернути в ShortageView `canOpenRoute('/work-orders', …)` → падає «canOpenRoute»;
// у linked-configs `navigate: () => nav.toInvoice(row.id)` без `nav.canOpen` → падає «конфіги».

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' ? [] : sourceFiles(full);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

const files = sourceFiles(SRC).map(full => ({
  path: relative(SRC, full).split(sep).join('/'),
  text: readFileSync(full, 'utf8'),
}));

/** Перехід до документа через `LinkedNav`: `nav.toWorkOrder(…)`, `linkedNav.toInvoice(…)`. */
const NAV_TO = /\b\w*[nN]av\.to[A-Z]\w*\(/;
/** Рішення за роллю: перелік ролей, порівняння з роллю, предикат «бачить вкладку». */
const ROLE_CHECK = /_ROLES\.includes\(|\brole\s*[!=]==\s*'|\bcanView[A-Z]\w*\(|\bcanOpenRoute\(/;

describe('посилання на документи — доступ лише через canOpen', () => {
  it('файл із переходом LinkedNav не вирішує доступ сам (перелік ролей, role ===)', () => {
    const offenders = files
      .filter(f => NAV_TO.test(f.text) && ROLE_CHECK.test(f.text))
      .map(f => f.path);
    expect(offenders).toEqual([]);
  });

  it('canOpenRoute — лише в lib/nav (джерело) і для сторінок журналу автоматизації', () => {
    const offenders = files
      .filter(f => /\bcanOpenRoute\(/.test(f.text))
      .map(f => f.path)
      .filter(p => p !== 'lib/nav.ts' && p !== 'lib/automation-href.ts');
    expect(offenders).toEqual([]);
  });

  it('старих пропів доступу до документа немає (canOpenPurchaseOrders, canOpenWarranties, …)', () => {
    const offenders = files
      .filter(f => /\bcanOpen(PurchaseOrders?|WorkOrders?|Warranties|Invoices?)\b/.test(f.text))
      .map(f => f.path);
    expect(offenders).toEqual([]);
  });

  it('конфіги «Пов’язаних документів»: кожен перехід — за nav.canOpen того ж виду', () => {
    const text = files.find(f => f.path === 'lib/linked-configs.tsx')!.text;
    // Вираз до коми в кінці рядка — і однорядковий тернарник, і перенесений prettier-ом.
    const navigates = [...text.matchAll(/navigate:\s*([\s\S]*?),\n/g)].map(m => m[1]!);
    expect(navigates.length).toBeGreaterThan(0);
    for (const line of navigates) {
      const to = /nav\.to(\w+)\(/.exec(line)?.[1];
      if (!to) continue;
      const kind = to[0]!.toLowerCase() + to.slice(1);
      expect(line, line).toContain(`nav.canOpen('${kind}')`);
    }
  });
});
