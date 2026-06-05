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
  Package,
  ShoppingCart,
  FileText,
  Receipt,
  Wallet,
  BarChart2,
  BookOpen,
  UserCog,
  Building2,
  Settings,
  CloudUpload,
  Zap,
  BookMarked,
  ClipboardList,
} from 'lucide-react';

export type NavSection = 'top' | 'documents' | 'reports' | 'refs';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  section: NavSection;
  roles?: string[];
}

export interface NavGroup {
  label?: string;
  items: NavItem[];
}

export const NAV_SECTION_LABELS: Record<NavSection, string> = {
  top: '',
  documents: 'Документи',
  reports: 'Звіти',
  refs: 'Довідники',
};

/**
 * Повний список пунктів навігації.
 * Порядок у межах section визначає порядок у меню.
 */
export const MASTER_NAV_ITEMS: NavItem[] = [
  // ─── Top ──────────────────────────────────────────────────────────
  { href: '/dashboard', label: 'Дашборд', icon: LayoutDashboard, section: 'top' },

  // ─── Документи ────────────────────────────────────────────────────
  { href: '/work-orders', label: 'Наряди', icon: Wrench, section: 'documents' },
  { href: '/invoices', label: 'Рахунки', icon: Receipt, section: 'documents' },
  { href: '/purchase-orders', label: 'Замовлення', icon: ShoppingCart, section: 'documents' },
  { href: '/stock-documents', label: 'Документи складу', icon: FileText, section: 'documents' },

  // ─── Звіти ────────────────────────────────────────────────────────
  { href: '/calendar', label: 'Календар', icon: CalendarDays, section: 'reports' },
  {
    href: '/bookings',
    label: 'Онлайн-запис',
    icon: ClipboardList,
    section: 'reports',
    roles: ['OWNER', 'ADMIN', 'RECEPTIONIST'],
  },
  { href: '/settlements', label: 'Розрахунки', icon: Wallet, section: 'reports' },
  {
    href: '/reports',
    label: 'Звіти',
    icon: BarChart2,
    section: 'reports',
    roles: ['OWNER', 'ADMIN', 'ACCOUNTANT'],
  },

  // ─── Довідники ────────────────────────────────────────────────────
  { href: '/counterparties', label: 'Контрагенти', icon: Users, section: 'refs' },
  { href: '/inventory', label: 'Склад', icon: Package, section: 'refs' },
  {
    href: '/catalog',
    label: 'Каталог',
    icon: BookOpen,
    section: 'refs',
    roles: ['OWNER', 'ADMIN'],
  },
  {
    href: '/pricing-rules',
    label: 'Ціноутворення',
    icon: Zap,
    section: 'refs',
    roles: ['OWNER', 'ADMIN', 'STOREKEEPER'],
  },
  {
    href: '/ndi',
    label: 'НДІ',
    icon: BookMarked,
    section: 'refs',
    roles: ['OWNER', 'ADMIN'],
  },
  {
    href: '/employees',
    label: 'Співробітники',
    icon: UserCog,
    section: 'refs',
    roles: ['OWNER', 'ADMIN'],
  },
  {
    href: '/infrastructure',
    label: 'Інфраструктура',
    icon: Building2,
    section: 'refs',
    roles: ['OWNER', 'ADMIN'],
  },
  {
    href: '/settings',
    label: 'Налаштування',
    icon: Settings,
    section: 'refs',
    roles: ['OWNER', 'ADMIN'],
  },
  {
    href: '/settings/sync',
    label: 'Cloud Sync',
    icon: CloudUpload,
    section: 'refs',
    roles: ['OWNER', 'ADMIN'],
  },
];

/**
 * Згрупований вигляд для sidebar у режимі 'sections'.
 * Автогенерується з MASTER_NAV_ITEMS — не редагувати вручну.
 */
export const NAV_GROUPS: NavGroup[] = (() => {
  const order: NavSection[] = ['top', 'documents', 'reports', 'refs'];
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
