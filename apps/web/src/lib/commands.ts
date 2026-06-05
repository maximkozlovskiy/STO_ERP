'use client';

import type { LucideIcon } from 'lucide-react';

export interface Command {
  id: string;
  label: string;
  description?: string;
  icon?: LucideIcon;
  keywords?: string[];
  group: 'navigation' | 'action' | 'settings' | 'data';
  perform: (ctx: CommandContext) => void;
}

export interface CommandContext {
  router: { push: (href: string) => void };
  role: string;
}

type CommandDef = Omit<Command, 'perform'> & {
  href?: string;
  roles?: string[];
  perform?: Command['perform'];
};

const NAV_COMMANDS: CommandDef[] = [
  {
    id: 'nav:dashboard',
    label: 'Дашборд',
    group: 'navigation',
    href: '/dashboard',
    keywords: ['головна', 'dashboard'],
  },
  {
    id: 'nav:work-orders',
    label: 'Наряди',
    group: 'navigation',
    href: '/work-orders',
    keywords: ['наряд', 'ремонт', 'work order'],
  },
  {
    id: 'nav:calendar',
    label: 'Календар',
    group: 'navigation',
    href: '/calendar',
    keywords: ['розклад', 'запис', 'слот'],
  },
  {
    id: 'nav:crm',
    label: 'Контрагенти',
    group: 'navigation',
    href: '/counterparties',
    keywords: ['клієнти', 'постачальники', 'crm'],
  },
  {
    id: 'nav:inventory',
    label: 'Склад',
    group: 'navigation',
    href: '/inventory',
    keywords: ['залишки', 'запчастини', 'stock'],
  },
  {
    id: 'nav:purchase-orders',
    label: 'Замовлення',
    group: 'navigation',
    href: '/purchase-orders',
    keywords: ['закупівля', 'постачальник'],
  },
  {
    id: 'nav:stock-documents',
    label: 'Документи складу',
    group: 'navigation',
    href: '/stock-documents',
    keywords: ['прихід', 'списання', 'складський'],
  },
  {
    id: 'nav:invoices',
    label: 'Рахунки',
    group: 'navigation',
    href: '/invoices',
    keywords: ['рахунок', 'виставити'],
  },
  {
    id: 'nav:settlements',
    label: 'Розрахунки',
    group: 'navigation',
    href: '/settlements',
    keywords: ['оплата', 'баланс'],
  },
  {
    id: 'nav:reports',
    label: 'Звіти',
    group: 'navigation',
    href: '/reports',
    roles: ['OWNER', 'ADMIN', 'ACCOUNTANT'],
    keywords: ['аналітика', 'звіт'],
  },
  {
    id: 'nav:catalog',
    label: 'Каталог',
    group: 'navigation',
    href: '/catalog',
    roles: ['OWNER', 'ADMIN'],
    keywords: ['товари', 'послуги', 'роботи'],
  },
  {
    id: 'nav:pricing-rules',
    label: 'Ціноутворення',
    group: 'navigation',
    href: '/pricing-rules',
    roles: ['OWNER', 'ADMIN', 'STOREKEEPER'],
    keywords: ['ціна', 'правило', 'знижка'],
  },
  {
    id: 'nav:employees',
    label: 'Персонал',
    group: 'navigation',
    href: '/employees',
    roles: ['OWNER', 'ADMIN'],
    keywords: ['співробітник', 'механік'],
  },
  {
    id: 'nav:infrastructure',
    label: 'Підрозділи',
    group: 'navigation',
    href: '/infrastructure',
    roles: ['OWNER', 'ADMIN'],
    keywords: ['філія', 'підйомник', 'зона'],
  },
  {
    id: 'nav:settings',
    label: 'Налаштування',
    group: 'navigation',
    href: '/settings',
    roles: ['OWNER', 'ADMIN'],
    keywords: ['config', 'параметри'],
  },
];

const ACTION_COMMANDS: CommandDef[] = [
  {
    id: 'action:new-work-order',
    label: 'Новий наряд',
    group: 'action',
    href: '/work-orders/new',
    keywords: ['створити наряд', 'новий ремонт'],
  },
  {
    id: 'action:new-crm',
    label: 'Новий контрагент',
    group: 'action',
    href: '/counterparties/new',
    keywords: ['новий клієнт', 'постачальник'],
  },
];

function buildCommand(def: CommandDef): Command {
  return {
    ...def,
    perform:
      def.perform ??
      (ctx => {
        if (def.href) ctx.router.push(def.href);
      }),
  };
}

export function getCommands(role: string): Command[] {
  const all = [...NAV_COMMANDS, ...ACTION_COMMANDS];
  return all
    .filter(
      c => !(c as { roles?: string[] }).roles || (c as { roles?: string[] }).roles!.includes(role),
    )
    .map(buildCommand);
}

export function searchCommands(commands: Command[], query: string): Command[] {
  const q = query.toLowerCase().trim();
  if (!q) return commands;
  return commands.filter(
    c =>
      c.label.toLowerCase().includes(q) ||
      c.description?.toLowerCase().includes(q) ||
      c.keywords?.some(k => k.toLowerCase().includes(q)),
  );
}
