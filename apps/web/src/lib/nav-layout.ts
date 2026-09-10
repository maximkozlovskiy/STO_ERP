/**
 * nav-layout — per-user overlay поверх MASTER_NAV_ITEMS (кастомізація бокової панелі).
 *
 * Користувач може: переставляти пункти в межах розділу, переносити пункти між розділами,
 * створювати/перейменовувати/видаляти власні розділи, приховувати пункти й розділи.
 * Зберігається per-user через user-preferences (key `nav_layout`), кешується в localStorage.
 *
 * Головний інваріант — FAIL-SAFE: будь-який master-пункт, відсутній у layout, ЗАВЖДИ зʼявляється
 * у своєму дефолтному розділі. Тож нові пункти після оновлення застосунку не губляться.
 */

import { NAV_SECTION_LABELS, NAV_SECTION_ORDER, type NavItem } from './nav';

export const NAV_LAYOUT_VERSION = 1 as const;

export interface CustomNavSection {
  id: string; // 'custom:<rand>'
  label: string;
}

export interface NavLayout {
  version: 1;
  hiddenItems: string[]; // href[] прихованих пунктів
  hiddenSections: string[]; // sectionId[] прихованих розділів (вкл. кастомні)
  customSections: CustomNavSection[];
  sectionOrder: string[]; // порядок усіх розділів (дефолтні + кастомні)
  itemSection: Record<string, string>; // href → sectionId override (перенесення між розділами)
  itemOrder: Record<string, string[]>; // sectionId → впорядкований href[]
}

/** Секція після резолву: несе id/label/custom + пункти (visible) і, для edit-mode, приховані. */
export interface ResolvedNavSection {
  id: string;
  label: string; // '' для top-секції (без заголовка)
  custom: boolean;
  items: NavItem[]; // видимі пункти (без прихованих, з role-filter)
  hiddenItems: NavItem[]; // приховані пункти цієї секції (для режиму редагування)
  hidden: boolean; // чи прихована сама секція
}

export const EMPTY_NAV_LAYOUT: NavLayout = {
  version: NAV_LAYOUT_VERSION,
  hiddenItems: [],
  hiddenSections: [],
  customSections: [],
  sectionOrder: [],
  itemSection: {},
  itemOrder: {},
};

/** Нормалізує довільний JSON із user-preferences у валідний NavLayout (захист від сміття/старих версій). */
export function normalizeNavLayout(raw: unknown): NavLayout {
  const v = (raw ?? {}) as Partial<NavLayout>;
  const strArr = (x: unknown): string[] =>
    Array.isArray(x) ? x.filter(s => typeof s === 'string') : [];
  const custom = Array.isArray(v.customSections)
    ? v.customSections
        .filter(
          (s): s is CustomNavSection =>
            !!s && typeof s.id === 'string' && typeof s.label === 'string',
        )
        .map(s => ({ id: s.id, label: s.label }))
    : [];
  const itemSection: Record<string, string> = {};
  if (v.itemSection && typeof v.itemSection === 'object') {
    for (const [k, val] of Object.entries(v.itemSection)) {
      if (typeof val === 'string') itemSection[k] = val;
    }
  }
  const itemOrder: Record<string, string[]> = {};
  if (v.itemOrder && typeof v.itemOrder === 'object') {
    for (const [k, val] of Object.entries(v.itemOrder)) {
      itemOrder[k] = strArr(val);
    }
  }
  return {
    version: NAV_LAYOUT_VERSION,
    hiddenItems: strArr(v.hiddenItems),
    hiddenSections: strArr(v.hiddenSections),
    customSections: custom,
    sectionOrder: strArr(v.sectionOrder),
    itemSection,
    itemOrder,
  };
}

/** Чи є href дефолтним пунктом (для валідації itemSection-override на існуючу секцію). */
function isKnownSectionId(id: string, layout: NavLayout): boolean {
  return (
    (NAV_SECTION_ORDER as string[]).includes(id) || layout.customSections.some(c => c.id === id)
  );
}

/**
 * Основний резолвер: master-пункти + layout + роль → впорядкований список секцій.
 *
 * @param includeHidden якщо true — приховані пункти/секції теж повертаються (з прапорцями),
 *   для режиму редагування. Якщо false (дефолт) — лише видимі (для рендера панелі).
 */
export function resolveNav(
  master: NavItem[],
  layout: NavLayout,
  role: string | undefined,
  includeHidden = false,
): ResolvedNavSection[] {
  const roleOk = (item: NavItem) => !item.roles || (role != null && item.roles.includes(role));

  // 1. Ефективна секція кожного пункту (override → дефолт). Override на неіснуючу секцію ігнорується.
  const effSection = (item: NavItem): string => {
    const ov = layout.itemSection[item.href];
    if (ov && isKnownSectionId(ov, layout)) return ov;
    return item.section;
  };

  // 2. Групуємо пункти за ефективною секцією.
  const bySection = new Map<string, NavItem[]>();
  for (const item of master) {
    const sec = effSection(item);
    const arr = bySection.get(sec) ?? [];
    arr.push(item);
    bySection.set(sec, arr);
  }

  // 3. Порядок секцій: спершу за layout.sectionOrder, потім решта дефолтних (у дефолт-порядку),
  //    потім решта кастомних. Невідомі id у sectionOrder ігноруються.
  const allSectionIds: string[] = [
    ...(NAV_SECTION_ORDER as string[]),
    ...layout.customSections.map(c => c.id),
  ];
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const id of layout.sectionOrder) {
    if (allSectionIds.includes(id) && !seen.has(id)) {
      ordered.push(id);
      seen.add(id);
    }
  }
  for (const id of allSectionIds) {
    if (!seen.has(id)) {
      ordered.push(id);
      seen.add(id);
    }
  }

  const labelFor = (id: string): string => {
    if ((NAV_SECTION_LABELS as Record<string, string>)[id] !== undefined) {
      return (NAV_SECTION_LABELS as Record<string, string>)[id];
    }
    return layout.customSections.find(c => c.id === id)?.label ?? '';
  };
  const isCustom = (id: string) => !(NAV_SECTION_ORDER as string[]).includes(id);

  const hiddenItemSet = new Set(layout.hiddenItems);
  const hiddenSectionSet = new Set(layout.hiddenSections);

  const result: ResolvedNavSection[] = [];
  for (const secId of ordered) {
    const itemsInSection = bySection.get(secId) ?? [];
    // FAIL-SAFE-порядок: спершу за itemOrder[secId] (лише ті, що реально тут), потім решта у master-порядку.
    const order = layout.itemOrder[secId] ?? [];
    const orderIndex = new Map(order.map((href, i) => [href, i]));
    const sorted = [...itemsInSection].sort((a, b) => {
      const ia = orderIndex.has(a.href) ? orderIndex.get(a.href)! : Number.POSITIVE_INFINITY;
      const ib = orderIndex.has(b.href) ? orderIndex.get(b.href)! : Number.POSITIVE_INFINITY;
      if (ia !== ib) return ia - ib;
      // стабільність для «нових» пунктів (обидва poza order) — master-порядок
      return master.indexOf(a) - master.indexOf(b);
    });

    const visible: NavItem[] = [];
    const hidden: NavItem[] = [];
    for (const item of sorted) {
      if (!roleOk(item)) continue; // роль-filter завжди (безпека UI)
      if (hiddenItemSet.has(item.href)) hidden.push(item);
      else visible.push(item);
    }

    const sectionHidden = hiddenSectionSet.has(secId);

    // Для рендера панелі (includeHidden=false): пропускаємо приховані секції та порожні.
    if (!includeHidden) {
      if (sectionHidden) continue;
      if (visible.length === 0) continue;
      result.push({
        id: secId,
        label: labelFor(secId),
        custom: isCustom(secId),
        items: visible,
        hiddenItems: [],
        hidden: false,
      });
      continue;
    }

    // Для редактора: показуємо всі секції, які мають хоч якийсь пункт (видимий чи прихований),
    // АБО є кастомними (щоб порожній щойно створений розділ був видимий для наповнення).
    if (visible.length === 0 && hidden.length === 0 && !isCustom(secId)) continue;
    result.push({
      id: secId,
      label: labelFor(secId),
      custom: isCustom(secId),
      items: visible,
      hiddenItems: hidden,
      hidden: sectionHidden,
    });
  }

  return result;
}

/** Генерує id для нового кастомного розділу. */
export function newCustomSectionId(): string {
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `custom:${rand}`;
}
