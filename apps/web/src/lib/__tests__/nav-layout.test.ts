import { describe, it, expect } from 'vitest';
import { Wrench, Receipt, DoorOpen, Users } from 'lucide-react';
import { resolveNav, normalizeNavLayout, EMPTY_NAV_LAYOUT, type NavLayout } from '../nav-layout';
import type { NavItem } from '../nav';

// Мінімальний master для детермінованих тестів (3 секції).
const MASTER: NavItem[] = [
  { href: '/work-orders', label: 'Наряди', icon: Wrench, section: 'documents' },
  { href: '/invoices', label: 'Рахунки', icon: Receipt, section: 'settlements' },
  { href: '/cash', label: 'Каса', icon: DoorOpen, section: 'settlements' },
  {
    href: '/employees',
    label: 'Співробітники',
    icon: Users,
    section: 'refs',
    roles: ['OWNER', 'ADMIN'],
  },
];

const layout = (over: Partial<NavLayout> = {}): NavLayout => ({ ...EMPTY_NAV_LAYOUT, ...over });

describe('resolveNav — дефолт (порожній layout)', () => {
  it('рендерить секції у дефолт-порядку з master-порядком пунктів', () => {
    const res = resolveNav(MASTER, EMPTY_NAV_LAYOUT, 'OWNER');
    expect(res.map(s => s.id)).toEqual(['documents', 'settlements', 'refs']);
    expect(res[1].items.map(i => i.href)).toEqual(['/invoices', '/cash']);
  });

  it('role-filter приховує пункт для ролі без доступу', () => {
    const res = resolveNav(MASTER, EMPTY_NAV_LAYOUT, 'MECHANIC');
    // /employees має roles [OWNER,ADMIN] → секція refs порожня → не рендериться
    expect(res.find(s => s.id === 'refs')).toBeUndefined();
  });

  it('undefined роль → пункти з roles приховані', () => {
    const res = resolveNav(MASTER, EMPTY_NAV_LAYOUT, undefined);
    expect(res.find(s => s.id === 'refs')).toBeUndefined();
    expect(res.find(s => s.id === 'documents')).toBeDefined();
  });
});

describe('resolveNav — reorder у межах секції', () => {
  it('itemOrder перевпорядковує пункти; невідомі у order — після, у master-порядку', () => {
    const res = resolveNav(
      MASTER,
      layout({ itemOrder: { settlements: ['/cash', '/invoices'] } }),
      'OWNER',
    );
    expect(res.find(s => s.id === 'settlements')!.items.map(i => i.href)).toEqual([
      '/cash',
      '/invoices',
    ]);
  });

  it('FAIL-SAFE: пункт, відсутній у itemOrder, все одно зʼявляється (нові пункти не губляться)', () => {
    // order містить лише /invoices — /cash має лишитись видимим (у кінці).
    const res = resolveNav(MASTER, layout({ itemOrder: { settlements: ['/invoices'] } }), 'OWNER');
    const hrefs = res.find(s => s.id === 'settlements')!.items.map(i => i.href);
    expect(hrefs).toContain('/cash');
    expect(hrefs).toEqual(['/invoices', '/cash']);
  });
});

describe('resolveNav — приховування', () => {
  it('hiddenItems прибирає пункт з рендера', () => {
    const res = resolveNav(MASTER, layout({ hiddenItems: ['/cash'] }), 'OWNER');
    expect(res.find(s => s.id === 'settlements')!.items.map(i => i.href)).toEqual(['/invoices']);
  });

  it('hiddenSections прибирає весь розділ', () => {
    const res = resolveNav(MASTER, layout({ hiddenSections: ['settlements'] }), 'OWNER');
    expect(res.find(s => s.id === 'settlements')).toBeUndefined();
  });

  it('includeHidden=true повертає приховані з прапорцями (для редактора)', () => {
    const res = resolveNav(
      MASTER,
      layout({ hiddenItems: ['/cash'], hiddenSections: ['refs'] }),
      'OWNER',
      true,
    );
    const settlements = res.find(s => s.id === 'settlements')!;
    expect(settlements.items.map(i => i.href)).toEqual(['/invoices']);
    expect(settlements.hiddenItems.map(i => i.href)).toEqual(['/cash']);
    const refs = res.find(s => s.id === 'refs')!;
    expect(refs.hidden).toBe(true);
  });
});

describe('resolveNav — кастомні розділи + перенесення', () => {
  it('itemSection переносить пункт у кастомний розділ', () => {
    const cs = { id: 'custom:x', label: 'Моє' };
    const res = resolveNav(
      MASTER,
      layout({ customSections: [cs], itemSection: { '/cash': 'custom:x' } }),
      'OWNER',
    );
    // /cash пішов з settlements у custom:x
    expect(res.find(s => s.id === 'settlements')!.items.map(i => i.href)).toEqual(['/invoices']);
    const custom = res.find(s => s.id === 'custom:x')!;
    expect(custom.custom).toBe(true);
    expect(custom.label).toBe('Моє');
    expect(custom.items.map(i => i.href)).toEqual(['/cash']);
  });

  it('itemSection на неіснуючу секцію ігнорується (пункт лишається у дефолтній)', () => {
    const res = resolveNav(MASTER, layout({ itemSection: { '/cash': 'custom:missing' } }), 'OWNER');
    expect(res.find(s => s.id === 'settlements')!.items.map(i => i.href)).toContain('/cash');
  });

  it('sectionOrder ставить кастомний розділ перед дефолтними', () => {
    const cs = { id: 'custom:x', label: 'Моє' };
    const res = resolveNav(
      MASTER,
      layout({
        customSections: [cs],
        itemSection: { '/work-orders': 'custom:x' },
        sectionOrder: ['custom:x', 'documents', 'settlements', 'refs'],
      }),
      'OWNER',
    );
    expect(res[0].id).toBe('custom:x');
  });

  it('порожній кастомний розділ видимий у режимі редактора (для наповнення)', () => {
    const cs = { id: 'custom:empty', label: 'Порожній' };
    const res = resolveNav(MASTER, layout({ customSections: [cs] }), 'OWNER', true);
    expect(res.find(s => s.id === 'custom:empty')).toBeDefined();
    // але у режимі рендера (includeHidden=false) порожній — не показується
    const render = resolveNav(MASTER, layout({ customSections: [cs] }), 'OWNER');
    expect(render.find(s => s.id === 'custom:empty')).toBeUndefined();
  });
});

describe('normalizeNavLayout — захист від сміття', () => {
  it('порожнє/undefined → EMPTY_NAV_LAYOUT-подібне', () => {
    expect(normalizeNavLayout(undefined)).toEqual(EMPTY_NAV_LAYOUT);
    expect(normalizeNavLayout({})).toEqual(EMPTY_NAV_LAYOUT);
  });

  it('відкидає нерядкові елементи масивів і невалідні customSections', () => {
    const n = normalizeNavLayout({
      hiddenItems: ['/a', 42, null],
      customSections: [{ id: 'custom:x', label: 'ok' }, { id: 5 }, null],
      itemOrder: { s: ['/a', 7] },
    });
    expect(n.hiddenItems).toEqual(['/a']);
    expect(n.customSections).toEqual([{ id: 'custom:x', label: 'ok' }]);
    expect(n.itemOrder.s).toEqual(['/a']);
  });
});
