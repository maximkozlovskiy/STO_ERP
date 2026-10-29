// Типове меню (UX-огляд 2026-10-29): «Онлайн-запис» і «Зарплата» — не в «Звітах»; задачі й
// онлайн-запис — група CRM після «Документів», «Зарплата» — під «Касою» (рішення власника 2026-10-29); «Склад»
// (складські документи) — у «Документах», окремої групи немає (рішення власника 2026-10-29, після
// короткої спроби з групою «Склад»). «Залишки» — лише вкладка
// «Звітів», пункту меню немає (рішення власника 2026-10-29). Змінено лише ТИПОВИЙ конфіг
// (`MASTER_NAV_ITEMS`): користувацькі налаштування меню («Налаштувати меню») ключуються за href і
// мають лишитись чинними; збережений href прибраного пункту меню не ламає (resolveNav іде від
// типових пунктів, невідомі href у налаштуваннях просто не збігаються ні з чим).
//
// Mutation-verify (2026-10-29): повернути «Зарплаті» `section: 'reports'` → падає «не в Звітах»;
// «Склад» у іншу групу → падає «Склад у Документах»; повернути пункт «Залишки» → падає
// «Залишків у меню немає».
import { describe, expect, it } from 'vitest';
import { MASTER_NAV_ITEMS } from '../nav';
import { EMPTY_NAV_LAYOUT, resolveNav, type NavLayout } from '../nav-layout';

const INVENTORY_TAB = '/reports?tab=inventory';

const sectionOf = (layout: NavLayout, href: string, role = 'OWNER') =>
  resolveNav(MASTER_NAV_ITEMS, layout, role).find(s => s.items.some(i => i.href === href))?.id;

describe('типове меню', () => {
  it('«Онлайн-запис» і «Зарплата» — не в «Звітах»', () => {
    expect(sectionOf(EMPTY_NAV_LAYOUT, '/bookings')).toBe('crm');
    expect(sectionOf(EMPTY_NAV_LAYOUT, '/payroll')).toBe('settlements');
    const reports = resolveNav(MASTER_NAV_ITEMS, EMPTY_NAV_LAYOUT, 'OWNER').find(
      s => s.id === 'reports',
    );
    expect(reports?.items.map(i => i.href)).toEqual(['/reports']);
  });

  it('«Склад» — пункт «Документів», окремої групи немає', () => {
    expect(sectionOf(EMPTY_NAV_LAYOUT, '/stock-documents', 'STOREKEEPER')).toBe('documents');
    const item = MASTER_NAV_ITEMS.find(i => i.href === '/stock-documents');
    expect(item?.label).toBe('Склад');
    const ids = resolveNav(MASTER_NAV_ITEMS, EMPTY_NAV_LAYOUT, 'OWNER').map(s => s.id as string);
    expect(ids).not.toContain('stock');
  });

  it('група CRM одразу після «Документів»: задачі й онлайн-запис', () => {
    const sections = resolveNav(MASTER_NAV_ITEMS, EMPTY_NAV_LAYOUT, 'OWNER');
    expect(sections.find(s => s.id === 'crm')?.items.map(i => i.href)).toEqual([
      '/tasks',
      '/bookings',
    ]);
    const order = sections.map(s => s.id);
    expect(order.indexOf('crm')).toBe(order.indexOf('documents') + 1);
  });

  it('«Зарплата» — одразу під «Касою»', () => {
    const settlements = resolveNav(MASTER_NAV_ITEMS, EMPTY_NAV_LAYOUT, 'OWNER').find(
      s => s.id === 'settlements',
    );
    const hrefs = settlements?.items.map(i => i.href) ?? [];
    expect(hrefs.indexOf('/payroll')).toBe(hrefs.indexOf('/cash') + 1);
  });

  it('«Залишків» у меню немає — лише вкладка «Звітів»', () => {
    expect(MASTER_NAV_ITEMS.some(i => i.href.includes('tab=inventory'))).toBe(false);
  });

  it('користувацькі налаштування лишаються чинними; збережений href «Залишків» не ламає меню', () => {
    const custom: NavLayout = {
      ...EMPTY_NAV_LAYOUT,
      itemSection: { '/payroll': 'reports', '/bookings': 'top', [INVENTORY_TAB]: 'documents' },
      hiddenItems: ['/cash'],
      itemOrder: { documents: [INVENTORY_TAB, '/stock-documents'] },
    };
    expect(sectionOf(custom, '/payroll')).toBe('reports');
    expect(sectionOf(custom, '/bookings')).toBe('top');
    expect(sectionOf(custom, '/cash')).toBeUndefined();
    expect(sectionOf(custom, INVENTORY_TAB)).toBeUndefined();
    expect(sectionOf(custom, '/stock-documents')).toBe('documents');
    // Перенесення «Складу» в іншу групу лишається чинним.
    const moved: NavLayout = {
      ...EMPTY_NAV_LAYOUT,
      itemSection: { '/stock-documents': 'refs' },
    };
    expect(sectionOf(moved, '/stock-documents')).toBe('refs');
  });
});
