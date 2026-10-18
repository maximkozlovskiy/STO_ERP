// Bug #899: пункти меню й команди палітри (Ctrl+K) без `roles` бачили всі ролі, а сторінки
// пускають лише свої (`useRequireAuth([...])`): комірник мав у меню «Календар», «Наряди»,
// «Рахунки клієнтам», «Контрагенти» — і кожен вів на 403; механік — «Купівлю» й «Контрагентів».
//
// Тест читає guard сторінки з її файла й вимагає: кожна роль, якій показано пункт меню чи
// команду, проходить guard сторінки. Мутація: прибрати `roles` у пункту «Контрагенти" → падає.

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { MASTER_NAV_ITEMS } from '../nav';
import { getCommands } from '../commands';

const ROLES = ['OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC', 'STOREKEEPER', 'ACCOUNTANT'] as const;
const APP = resolve(__dirname, '../../app/(app)');

/**
 * Ролі guard-а сторінки — об'єднання літералів `useRequireAuth([...])` у файлі (сторінка може
 * мати оболонки за ролями, як «Купівля»: документи / управління купівлями / графік оплат);
 * `null` — guard-а немає або він зі спредом констант (`...FINANCE_ROLES` тест не розгортає).
 */
function pageRoles(href: string): string[] | null {
  const path = href.split('?')[0]!;
  const file = resolve(APP, `.${path}`, 'page.tsx');
  if (!existsSync(file)) return null;
  const calls = [...readFileSync(file, 'utf8').matchAll(/useRequireAuth\(\[([^\]]*)\]/g)];
  if (!calls.length || calls.some(m => m[1]!.includes('...'))) return null;
  return [...new Set(calls.flatMap(m => [...m[1]!.matchAll(/'([A-Z_]+)'/g)].map(x => x[1]!)))];
}

describe('меню й палітра не ведуть на 403 (Bug #899)', () => {
  const guarded = MASTER_NAV_ITEMS.filter(i => pageRoles(i.href));

  it('guard-и сторінок прочитано (тест не порожній)', () => {
    expect(guarded.map(i => i.href)).toEqual(
      expect.arrayContaining(['/calendar', '/work-orders', '/invoices', '/counterparties']),
    );
  });

  it.each(guarded.map(i => [i.href, i] as const))('меню %s — лише ролі сторінки', (href, item) => {
    const allowed = pageRoles(href)!;
    const shown = ROLES.filter(r => !item.roles || item.roles.includes(r));
    expect(shown.filter(r => !allowed.includes(r))).toEqual([]);
  });

  it.each(ROLES)('палітра для %s — без команд, що ведуть на 403', role => {
    const forbidden = getCommands(role)
      .map(c => (c as { href?: string }).href)
      .filter((href): href is string => !!href)
      .filter(href => {
        const allowed = pageRoles(href);
        return allowed !== null && !allowed.includes(role);
      });
    expect(forbidden).toEqual([]);
  });

  it('комірник: у меню «Купівля» є, «Контрагентів» немає (BR-CP-014 — лише вибір постачальника)', () => {
    const visible = MASTER_NAV_ITEMS.filter(i => !i.roles || i.roles.includes('STOREKEEPER'));
    expect(visible.map(i => i.href)).toContain('/purchase-orders');
    expect(visible.map(i => i.href)).not.toContain('/counterparties');
  });

  it('«Купівля» лишається приймальні й бухгалтеру (їхні вкладки), механіку — ні', () => {
    const roles = MASTER_NAV_ITEMS.find(i => i.href === '/purchase-orders')?.roles;
    expect(roles).toEqual(expect.arrayContaining(['RECEPTIONIST', 'ACCOUNTANT', 'STOREKEEPER']));
    expect(roles).not.toContain('MECHANIC');
  });
});
