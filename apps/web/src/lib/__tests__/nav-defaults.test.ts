// Типове меню (UX-огляд 2026-10-29): «Онлайн-запис» і «Зарплата» — не в «Звітах»; окрема група
// «Склад» зі складськими документами (рішення власника 2026-10-29). «Залишки» — лише вкладка
// «Звітів», пункту меню немає (рішення власника 2026-10-29). Змінено лише ТИПОВИЙ конфіг
// (`MASTER_NAV_ITEMS`): користувацькі налаштування меню («Налаштувати меню») ключуються за href і
// мають лишитись чинними; збережений href прибраного пункту меню не ламає (resolveNav іде від
// типових пунктів, невідомі href у налаштуваннях просто не збігаються ні з чим).
//
// Mutation-verify (2026-10-29): повернути «Зарплаті» `section: 'reports'` → падає «не в Звітах»;
// складські документи назад у «Документи» → падає «група Склад»; повернути пункт «Залишки» → падає
// «Залишків у меню немає».
import { describe, expect, it } from 'vitest';
import { MASTER_NAV_ITEMS } from '../nav';
import { EMPTY_NAV_LAYOUT, resolveNav, type NavLayout } from '../nav-layout';

const INVENTORY_TAB = '/reports?tab=inventory';

const sectionOf = (layout: NavLayout, href: string, role = 'OWNER') =>
  resolveNav(MASTER_NAV_ITEMS, layout, role).find(s => s.items.some(i => i.href === href))?.id;

describe('типове меню', () => {
  it('«Онлайн-запис» і «Зарплата» — не в «Звітах»', () => {
    expect(sectionOf(EMPTY_NAV_LAYOUT, '/bookings')).toBe('documents');
    expect(sectionOf(EMPTY_NAV_LAYOUT, '/payroll')).toBe('settlements');
    const reports = resolveNav(MASTER_NAV_ITEMS, EMPTY_NAV_LAYOUT, 'OWNER').find(
      s => s.id === 'reports',
    );
    expect(reports?.items.map(i => i.href)).toEqual(['/reports']);
  });

  it('група «Склад» одразу після «Документів»: складські документи', () => {
    const sections = resolveNav(MASTER_NAV_ITEMS, EMPTY_NAV_LAYOUT, 'OWNER');
    expect(sections.find(s => s.id === 'stock')?.items.map(i => i.href)).toEqual([
      '/stock-documents',
    ]);
    const order = sections.map(s => s.id);
    expect(order.indexOf('stock')).toBe(order.indexOf('documents') + 1);
    expect(sectionOf(EMPTY_NAV_LAYOUT, '/stock-documents', 'STOREKEEPER')).toBe('stock');
    // Ролі без складу (механік) групи не бачать — порожня група не рендериться.
    expect(
      resolveNav(MASTER_NAV_ITEMS, EMPTY_NAV_LAYOUT, 'MECHANIC').some(s => s.id === 'stock'),
    ).toBe(false);
  });

  it('«Залишків» у меню немає — лише вкладка «Звітів»', () => {
    expect(MASTER_NAV_ITEMS.some(i => i.href.includes('tab=inventory'))).toBe(false);
  });

  it('користувацькі налаштування лишаються чинними; збережений href «Залишків» не ламає меню', () => {
    const custom: NavLayout = {
      ...EMPTY_NAV_LAYOUT,
      itemSection: { '/payroll': 'reports', '/bookings': 'top', [INVENTORY_TAB]: 'stock' },
      hiddenItems: ['/cash'],
      itemOrder: { stock: [INVENTORY_TAB, '/stock-documents'] },
    };
    expect(sectionOf(custom, '/payroll')).toBe('reports');
    expect(sectionOf(custom, '/bookings')).toBe('top');
    expect(sectionOf(custom, '/cash')).toBeUndefined();
    expect(sectionOf(custom, INVENTORY_TAB)).toBeUndefined();
    const stock = resolveNav(MASTER_NAV_ITEMS, custom, 'OWNER').find(s => s.id === 'stock');
    expect(stock?.items.map(i => i.href)).toEqual(['/stock-documents']);
    // Перенесення складських документів із колишнього типового місця лишається чинним.
    const moved: NavLayout = {
      ...EMPTY_NAV_LAYOUT,
      itemSection: { '/stock-documents': 'documents' },
    };
    expect(sectionOf(moved, '/stock-documents')).toBe('documents');
  });
});
