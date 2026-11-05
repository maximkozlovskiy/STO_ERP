// Посилання на пов'язаний документ за роллю — одне джерело `canOpen(kind, role)` (техборг §15 п. 4,
// Bugs #899, #900, #914: кожен компонент вирішував сам, і номер наряду вів комірника на 403).
//
// Таблиця «вид × роль» звіряється з guard-ами сторінок, на які веде перехід: `canOpen` не обіцяє
// посилання, яке відкриє 403, і не ховає доступне. Для «Купівлі» guard — оболонка за роллю, що
// відкриває саме цю картку (повна сторінка замовлень, графік оплат бухгалтера, «Управління
// купівлями» приймальні).
//
// Mutation-verify: `purchaseOrder.roles` + 'RECEPTIONIST' у `LINKED_DOC_ACCESS` → падають «таблиця»
// і «guard купівлі»; `warranty` без `roles` → падає «таблиця» (механік отримав би гарантії).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { canOpen, LINKED_DOC_ACCESS, MASTER_NAV_ITEMS, type LinkedDocKind } from '../nav';
import { WARRANTY_VIEW_ROLES } from '../warranty-roles';

const ROLES = ['OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC', 'STOREKEEPER', 'ACCOUNTANT'] as const;
const APP = resolve(__dirname, '../../app/(app)');

const opens = (kind: LinkedDocKind) => ROLES.filter(r => canOpen(kind, r));

/** Ролі `useRequireAuth([...])` у файлі; з `fn` — лише в тілі цієї функції (оболонки «Купівлі»). */
function guardRoles(file: string, fn?: string): string[] {
  let text = readFileSync(resolve(APP, file), 'utf8');
  if (fn) {
    const start = text.indexOf(`function ${fn}(`);
    expect(start, `${file}: ${fn}`).toBeGreaterThanOrEqual(0);
    const next = text.indexOf('\nfunction ', start + 1);
    const nextExport = text.indexOf('\nexport ', start + 1);
    const ends = [next, nextExport].filter(i => i > 0);
    text = text.slice(start, ends.length ? Math.min(...ends) : undefined);
  }
  const calls = [...text.matchAll(/useRequireAuth\(\[([^\]]*)\]/g)];
  expect(calls.length, `${file} ${fn ?? ''}: guard-літерал`).toBeGreaterThan(0);
  return [...new Set(calls.flatMap(m => [...m[1]!.matchAll(/'([A-Z_]+)'/g)].map(x => x[1]!)))];
}

const sorted = (xs: readonly string[]) => [...xs].sort();

/** Сторінка (і оболонка), що відкриває картку документа цього виду. */
const TARGET_GUARDS: Record<LinkedDocKind, Array<[file: string, fn?: string]>> = {
  workOrder: [['work-orders/[id]/PageClient.tsx']],
  counterparty: [['counterparties/[id]/PageClient.tsx']],
  invoice: [['invoices/page.tsx']],
  stockDocument: [['stock-documents/page.tsx']],
  calendarDay: [['calendar/page.tsx']],
  purchaseOrder: [
    ['purchase-orders/page.tsx', 'PurchaseOrdersPageClient'],
    ['purchase-orders/page.tsx', 'PurchaseSchedulePage'],
  ],
  supplierReturn: [['purchase-orders/page.tsx', 'PurchaseOrdersPageClient']],
  purchaseList: [
    ['purchase-orders/page.tsx', 'PurchaseOrdersPageClient'],
    ['purchase-orders/page.tsx', 'PurchaseProcurementPage'],
  ],
  // Вкладку «Гарантії» сторінка нарядів звужує `canViewWarranties` — див. окремий кейс нижче.
  warranty: [['work-orders/page.tsx']],
};

describe('canOpen — вид документа × роль (техборг §15 п. 4)', () => {
  it('таблиця доступу', () => {
    const table = Object.fromEntries(
      (Object.keys(LINKED_DOC_ACCESS) as LinkedDocKind[]).map(k => [k, opens(k)]),
    );
    expect(table).toEqual({
      workOrder: ['OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC', 'ACCOUNTANT'],
      counterparty: ['OWNER', 'ADMIN', 'RECEPTIONIST', 'ACCOUNTANT'],
      invoice: ['OWNER', 'ADMIN', 'RECEPTIONIST', 'ACCOUNTANT'],
      stockDocument: ['OWNER', 'ADMIN', 'STOREKEEPER'],
      calendarDay: ['OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC'],
      // Бухгалтер — картка на перегляд із графіка оплат (BR-PO-015); приймальні закрита.
      purchaseOrder: ['OWNER', 'ADMIN', 'STOREKEEPER', 'ACCOUNTANT'],
      supplierReturn: ['OWNER', 'ADMIN', 'STOREKEEPER'],
      // «Управління купівлями» (BR-PL-015) — без бухгалтера.
      purchaseList: ['OWNER', 'ADMIN', 'RECEPTIONIST', 'STOREKEEPER'],
      warranty: ['OWNER', 'ADMIN', 'RECEPTIONIST', 'ACCOUNTANT'],
    });
  });

  it.each((Object.keys(TARGET_GUARDS) as LinkedDocKind[]).filter(k => k !== 'warranty'))(
    '%s — ролі посилання = ролі guard-а сторінки, що відкриває картку',
    kind => {
      const guard = [...new Set(TARGET_GUARDS[kind].flatMap(([f, fn]) => guardRoles(f, fn)))];
      expect(sorted(opens(kind))).toEqual(sorted(guard));
    },
  );

  it('warranty — лише ролі вкладки «Гарантії», і всі вони проходять guard нарядів', () => {
    const guard = guardRoles('work-orders/page.tsx');
    expect(sorted(opens('warranty'))).toEqual(sorted(WARRANTY_VIEW_ROLES));
    expect(opens('warranty').filter(r => !guard.includes(r))).toEqual([]);
    const page = readFileSync(resolve(APP, 'work-orders/page.tsx'), 'utf8');
    expect(page).toMatch(/canViewWarranties\(role\)/);
  });

  it('роль картки не ширша за сторінку: canOpen ⊆ ролі пункту меню', () => {
    for (const [kind, { route }] of Object.entries(LINKED_DOC_ACCESS)) {
      const menu = MASTER_NAV_ITEMS.find(i => i.href === route);
      expect(menu, route).toBeDefined();
      const extra = opens(kind as LinkedDocKind).filter(r => !menu!.roles?.includes(r));
      expect(extra, kind).toEqual([]);
    }
  });

  it('без ролі (сесія ще не завантажена) — посилань немає', () => {
    for (const kind of Object.keys(LINKED_DOC_ACCESS) as LinkedDocKind[]) {
      expect(canOpen(kind, null), kind).toBe(false);
      expect(canOpen(kind, undefined), kind).toBe(false);
    }
  });
});
