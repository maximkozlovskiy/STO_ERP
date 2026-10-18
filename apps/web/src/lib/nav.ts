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
} from 'lucide-react';

export type NavSection = 'top' | 'documents' | 'settlements' | 'reports' | 'refs' | 'settings';

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
    href: '/stock-documents',
    labelKey: 'stockDocuments',
    label: 'Склад',
    icon: FileText,
    section: 'documents',
    // Документи складу й рухи містять ціни й собівартість (backend @Roles).
    roles: ['OWNER', 'ADMIN', 'STOREKEEPER'],
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
  // «Каса» — остання у Взаєморозрахунках за замовчуванням (кастомний порядок може перекрити).
  {
    href: '/cash',
    labelKey: 'cash',
    label: 'Каса',
    icon: DoorOpen,
    section: 'settlements',
    roles: ['OWNER', 'ADMIN', 'ACCOUNTANT', 'RECEPTIONIST'],
  },

  // ─── Звіти ────────────────────────────────────────────────────────
  // /settlements — вкладка всередині /reports (не окремий пункт меню)
  {
    href: '/bookings',
    labelKey: 'bookings',
    label: 'Онлайн-запис',
    icon: ClipboardList,
    section: 'reports',
    roles: ['OWNER', 'ADMIN', 'RECEPTIONIST'],
  },
  {
    href: '/payroll',
    labelKey: 'payroll',
    label: 'Зарплата',
    icon: Banknote,
    section: 'reports',
    roles: ['OWNER', 'ADMIN', 'ACCOUNTANT'],
  },
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
