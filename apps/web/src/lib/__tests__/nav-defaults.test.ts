// Типове меню (UX-огляд 2026-10-29, частина 3): «Онлайн-запис» і «Зарплата» — не в «Звітах»,
// «Залишки» — пункт поруч зі «Складом». Змінено лише ТИПОВИЙ конфіг (`MASTER_NAV_ITEMS`):
// користувацькі налаштування меню («Налаштувати меню») ключуються за href і мають лишитись чинними.
//
// Mutation-verify (2026-10-29): повернути «Зарплаті» `section: 'reports'` → падає «не в Звітах»;
// прибрати пункт «Залишки» → падає «поруч зі Складом».
import { describe, expect, it } from 'vitest';
import { MASTER_NAV_ITEMS } from '../nav';
import { EMPTY_NAV_LAYOUT, resolveNav, type NavLayout } from '../nav-layout';

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

  it('«Залишки» — пункт у «Документах» одразу після «Складу», веде на вкладку звітів', () => {
    const docs = resolveNav(MASTER_NAV_ITEMS, EMPTY_NAV_LAYOUT, 'OWNER').find(
      s => s.id === 'documents',
    );
    const hrefs = docs?.items.map(i => i.href) ?? [];
    expect(hrefs.indexOf('/reports?tab=inventory')).toBe(hrefs.indexOf('/stock-documents') + 1);
    // Комірник і приймальник бачать вкладку «Залишки» у звітах — і пункт меню теж.
    expect(sectionOf(EMPTY_NAV_LAYOUT, '/reports?tab=inventory', 'STOREKEEPER')).toBe('documents');
    expect(sectionOf(EMPTY_NAV_LAYOUT, '/reports?tab=inventory', 'RECEPTIONIST')).toBe('documents');
    expect(sectionOf(EMPTY_NAV_LAYOUT, '/reports?tab=inventory', 'MECHANIC')).toBeUndefined();
  });

  it('користувацьке перенесення й приховування лишаються чинними', () => {
    const custom: NavLayout = {
      ...EMPTY_NAV_LAYOUT,
      itemSection: { '/payroll': 'reports', '/bookings': 'top' },
      hiddenItems: ['/reports?tab=inventory'],
    };
    expect(sectionOf(custom, '/payroll')).toBe('reports');
    expect(sectionOf(custom, '/bookings')).toBe('top');
    expect(sectionOf(custom, '/reports?tab=inventory')).toBeUndefined();
  });
});
