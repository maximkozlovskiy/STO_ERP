import { describe, it, expect, afterEach } from 'vitest';
import { Wrench, Receipt } from 'lucide-react';
import i18n from '@/i18n/config';
import { resolveNav, EMPTY_NAV_LAYOUT } from '@/lib/nav-layout';
import { NAV_SECTION_KEYS, type NavItem, type NavSection } from '@/lib/nav';

/**
 * Bug #762 — заголовки розділів sidebar (режим 'sections') НЕ перекладались LIVE.
 *
 * resolveNav повертає label = NAV_SECTION_LABELS[id] (жорсткий укр. рядок). TopShell рендерив
 * {group.label} без t() → при перемиканні на 'en' пункти меню фліпали (через t(labelKey)), а
 * заголовки розділів («Документи»…) лишались українськими. NAV_SECTION_KEYS + каталоги
 * nav:section.* існували, але не були під'єднані. Цей тест дзеркалить точний вираз, який
 * TopShell.activeGroups тепер застосовує до дефолтних (не-custom) розділів.
 */

const MASTER: NavItem[] = [
  {
    href: '/work-orders',
    labelKey: 'workOrders',
    label: 'Наряди',
    icon: Wrench,
    section: 'documents',
  },
  {
    href: '/invoices',
    labelKey: 'invoices',
    label: 'Рахунки',
    icon: Receipt,
    section: 'settlements',
  },
];

// Точна копія мапінгу з TopShell.activeGroups (режим 'sections').
function sectionLabels(
  t: (k: string, o?: Record<string, unknown>) => string,
): (string | undefined)[] {
  return resolveNav(MASTER, EMPTY_NAV_LAYOUT, 'OWNER').map(s =>
    s.custom
      ? s.label || undefined
      : NAV_SECTION_KEYS[s.id as NavSection]
        ? t(NAV_SECTION_KEYS[s.id as NavSection], { defaultValue: s.label })
        : s.label || undefined,
  );
}

describe('TopShell — заголовки розділів sidebar перекладаються LIVE (Bug #762)', () => {
  afterEach(async () => {
    await i18n.changeLanguage('uk');
  });

  it('uk: заголовки розділів українською', async () => {
    await i18n.changeLanguage('uk');
    const t = i18n.getFixedT('uk', 'nav');
    expect(sectionLabels(t)).toEqual(['Документи', 'Взаєморозрахунки']);
  });

  it('en: заголовки розділів фліпають на англійську', async () => {
    await i18n.changeLanguage('en');
    const t = i18n.getFixedT('en', 'nav');
    expect(sectionLabels(t)).toEqual(['Documents', 'Settlements']);
  });

  it('кастомний розділ зберігає user-визначену назву (не перекладається)', () => {
    const t = i18n.getFixedT('en', 'nav');
    const res = resolveNav(
      MASTER,
      {
        ...EMPTY_NAV_LAYOUT,
        customSections: [{ id: 'custom:x', label: 'Моє' }],
        itemSection: { '/invoices': 'custom:x' },
      },
      'OWNER',
    ).map(s =>
      s.custom
        ? s.label || undefined
        : NAV_SECTION_KEYS[s.id as NavSection]
          ? t(NAV_SECTION_KEYS[s.id as NavSection], { defaultValue: s.label })
          : s.label || undefined,
    );
    // 'Documents' (перекладено) + 'Моє' (кастом, без перекладу)
    expect(res).toContain('Моє');
    expect(res).toContain('Documents');
  });
});
