/**
 * MASTER_NAV_ITEMS — єдине джерело правди для навігації.
 *
 * Щоб додати пункт меню — тільки цей файл.
 * Щоб перенести між розділами — змінити `section`.
 *
 * section визначає у який розділ sidebar попадає пункт (режим 'sections').
 * В режимі 'functions' всі пункти рендеряться плоским списком у порядку масиву.
 */

import type { LucideIcon } from 'lucide-react';
import {
  LayoutDashboard,
  Wrench,
  CalendarDays,
  Users,
  ShoppingCart,
  FileText,
  Receipt,
  DoorOpen,
  BarChart2,
  BookOpen,
  UserCog,
  Building2,
  Settings,
  CloudUpload,
  Zap,
  BookMarked,
  ClipboardList,
  Banknote,
  Landmark,
  ListTodo,
} from 'lucide-react';

export type NavSection =
  'top' | 'documents' | 'crm' | 'settlements' | 'reports' | 'refs' | 'settings';

export interface NavItem {
  href: string;
  label: string;
  /** i18n-ключ у namespace `nav` (напр. 'workOrders'); label — укр. fallback. */
  labelKey: string;
  icon: LucideIcon;
  section: NavSection;
  roles?: string[];
}

/** i18n-ключі заголовків розділів (namespace `nav`, під `section.<key>`). */
export const NAV_SECTION_KEYS: Record<NavSection, string> = {
  top: '',
  documents: 'section.documents',
  crm: 'section.crm',
  settlements: 'section.settlements',
  reports: 'section.reports',
  refs: 'section.refs',
  settings: 'section.settings',
};

export interface NavGroup {
  label?: string;
  items: NavItem[];
}

export const NAV_SECTION_LABELS: Record<NavSection, string> = {
  top: '',
  documents: 'Документи',
  crm: 'CRM',
  settlements: 'Взаєморозрахунки',
  reports: 'Звіти',
  refs: 'Довідники',
  settings: 'Налаштування',
};

/**
 * Повний список пунктів навігації.
 * Порядок у межах section визначає порядок у меню.
 */
export const MASTER_NAV_ITEMS: NavItem[] = [
  // ─── Top ──────────────────────────────────────────────────────────
  {
    href: '/dashboard',
    labelKey: 'dashboard',
    label: 'Дашборд',
    icon: LayoutDashboard,
    section: 'top',
  },
  {
    href: '/calendar',
    labelKey: 'calendar',
    label: 'Календар',
    icon: CalendarDays,
    section: 'top',
    // Ролі пунктів без власного `roles` — як у guard-і сторінки (`useRequireAuth`), інакше
    // пункт веде на 403 (Bug #899). Звіряє `lib/__tests__/nav-page-roles.test.ts`.
    roles: ['OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC'],
  },

  // ─── Документи ────────────────────────────────────────────────────
  {
    href: '/work-orders',
    labelKey: 'workOrders',
    label: 'Наряди',
    icon: Wrench,
    section: 'documents',
    roles: ['OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC', 'ACCOUNTANT'],
  },
  {
    href: '/purchase-orders',
    labelKey: 'purchaseOrders',
    label: 'Купівля',
    icon: ShoppingCart,
    section: 'documents',
    roles: ['OWNER', 'ADMIN', 'STOREKEEPER', 'RECEPTIONIST', 'ACCOUNTANT'],
  },
  {
    // «Склад» — у «Документах»; окремої групи й пункту «Залишки» (вкладка «Звітів») немає
    // (рішення власника 2026-10-29).
    href: '/stock-documents',
    labelKey: 'stockDocuments',
    label: 'Склад',
    icon: FileText,
    section: 'documents',
    // Документи складу й рухи містять ціни й собівартість (backend @Roles).
    roles: ['OWNER', 'ADMIN', 'STOREKEEPER'],
  },

  // ─── CRM ──────────────────────────────────────────────────────────
  // Задачі й онлайн-запис — робота з клієнтами й командою, окремою групою (рішення власника
  // 2026-10-29).
  {
    // Задачі співробітникам (docs/objects/task.md): бачать усі ролі персоналу — виконавець лише
    // свої (BR-TASK-002), ставлять ролі керування (BR-TASK-001).
    href: '/tasks',
    labelKey: 'tasks',
    label: 'Задачі',
    icon: ListTodo,
    section: 'crm',
    roles: ['OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC', 'STOREKEEPER', 'ACCOUNTANT'],
  },
  // Онлайн-запис — заявки клієнтів на візит, робочий документ приймальника, а не звіт.
  {
    href: '/bookings',
    labelKey: 'bookings',
    label: 'Онлайн-запис',
    icon: ClipboardList,
    section: 'crm',
    roles: ['OWNER', 'ADMIN', 'RECEPTIONIST'],
  },

  // ─── Взаєморозрахунки ─────────────────────────────────────────────
  {
    href: '/invoices',
    labelKey: 'invoices',
    label: 'Рахунки клієнтам',
    icon: Receipt,
    section: 'settlements',
    roles: ['OWNER', 'ADMIN', 'ACCOUNTANT', 'RECEPTIONIST'],
  },
  {
    href: '/bank-statements',
    labelKey: 'bankStatements',
    label: 'Банківські платежі',
    icon: Landmark,
    section: 'settlements',
    roles: ['OWNER', 'ADMIN', 'ACCOUNTANT'],
  },
  {
    href: '/cash',
    labelKey: 'cash',
    label: 'Каса',
    icon: DoorOpen,
    section: 'settlements',
    roles: ['OWNER', 'ADMIN', 'ACCOUNTANT', 'RECEPTIONIST'],
  },
  // Зарплата — розрахунки з працівниками, а не звіт (UX-огляд 2026-10-29); під «Касою» (рішення
  // власника 2026-10-29; кастомний порядок може перекрити).
  {
    href: '/payroll',
    labelKey: 'payroll',
    label: 'Зарплата',
    icon: Banknote,
    section: 'settlements',
    roles: ['OWNER', 'ADMIN', 'ACCOUNTANT'],
  },

  // ─── Звіти ────────────────────────────────────────────────────────
  // /settlements — вкладка всередині /reports (не окремий пункт меню)
  {
    href: '/reports',
    labelKey: 'reports',
    label: 'Звіти',
    icon: BarChart2,
    section: 'reports',
    // Комірник і приймальник бачать тут лише вкладку «Залишки» (reports/page.tsx).
    roles: ['OWNER', 'ADMIN', 'ACCOUNTANT', 'STOREKEEPER', 'RECEPTIONIST'],
  },

  // ─── Довідники ────────────────────────────────────────────────────
  {
    href: '/counterparties',
    labelKey: 'counterparties',
    label: 'Контрагенти',
    icon: Users,
    section: 'refs',
    // Комірник читає постачальників лише для вибору (BR-CP-014), сторінки контрагентів не має.
    roles: ['OWNER', 'ADMIN', 'RECEPTIONIST', 'ACCOUNTANT'],
  },
  {
    href: '/catalog',
    labelKey: 'catalog',
    label: 'Каталог',
    icon: BookOpen,
    section: 'refs',
    roles: ['OWNER', 'ADMIN'],
  },
  {
    href: '/pricing-rules',
    labelKey: 'pricingRules',
    label: 'Ціноутворення',
    icon: Zap,
    section: 'refs',
    roles: ['OWNER', 'ADMIN', 'STOREKEEPER'],
  },
  {
    href: '/ndi',
    labelKey: 'ndi',
    label: 'НДІ',
    icon: BookMarked,
    section: 'refs',
    roles: ['OWNER', 'ADMIN'],
  },
  {
    href: '/employees',
    labelKey: 'employees',
    label: 'Співробітники',
    icon: UserCog,
    section: 'refs',
    roles: ['OWNER', 'ADMIN'],
  },
  {
    href: '/infrastructure',
    labelKey: 'infrastructure',
    label: 'Інфраструктура',
    icon: Building2,
    section: 'refs',
    roles: ['OWNER', 'ADMIN'],
  },

  // ─── Налаштування ─────────────────────────────────────────────────
  {
    href: '/settings',
    labelKey: 'settings',
    label: 'Система',
    icon: Settings,
    section: 'settings',
    roles: ['OWNER', 'ADMIN'],
  },
  {
    href: '/settings/sync',
    labelKey: 'settingsSync',
    label: 'Cloud Sync',
    icon: CloudUpload,
    section: 'settings',
    roles: ['OWNER', 'ADMIN'],
  },
];

/**
 * Згрупований вигляд для sidebar у режимі 'sections'.
 * Автогенерується з MASTER_NAV_ITEMS — не редагувати вручну.
 */
/** Дефолтний порядок дефолтних розділів (використовується resolveNav як база). */
export const NAV_SECTION_ORDER: NavSection[] = [
  'top',
  'documents',
  'crm',
  'settlements',
  'reports',
  'refs',
  'settings',
];

export const NAV_GROUPS: NavGroup[] = (() => {
  const order = NAV_SECTION_ORDER;
  return order
    .map(section => ({
      label: NAV_SECTION_LABELS[section] || undefined,
      items: MASTER_NAV_ITEMS.filter(item => item.section === section),
    }))
    .filter(g => g.items.length > 0);
})();

/**
 * Плаский вигляд для sidebar у режимі 'functions'.
 * Автогенерується з MASTER_NAV_ITEMS — не редагувати вручну.
 */
export const NAV_GROUPS_FUNCTIONS: NavGroup[] = [{ items: MASTER_NAV_ITEMS }];

/**
 * Чи пускає сторінка `href` роль — за `roles` пункту меню (їх звіряє з guard-ом сторінки
 * `lib/__tests__/nav-page-roles.test.ts`). Пункт без `roles` — для всіх. Для посилань на
 * документ іншого розділу: комірник бачить номер наряду в «Нестачі», але сторінки нарядів не має
 * — номер для нього текст, а не посилання на 403 (Bug #900).
 */
export function canOpenRoute(href: string, role: string | null | undefined): boolean {
  const item = MASTER_NAV_ITEMS.find(i => i.href === href);
  if (!item?.roles) return true;
  return !!role && item.roles.includes(role);
}
