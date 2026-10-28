// Bug #879: дашборд шле лише ті запити, які роль може читати. Набори ролей — дзеркало `@Roles`
// ендпоінтів; цей тест читає контролери api і падає, щойно одна сторона зміниться без другої
// (інакше або знову 403 і порожній дашборд, або показник, якого роль дарма не бачить).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DASHBOARD_INVOICES_URL, DASHBOARD_READ_ROLES, dashboardAccess } from './useDashboardData';

const MODULES = resolve(__dirname, '../../../../api/src/modules');

/** Ролі `@Roles(...)`, що стоять над `@Get('<route>')` (або `@Get()` для порожнього route). */
function rolesOf(controller: string, route: string): string[] {
  const src = readFileSync(resolve(MODULES, controller), 'utf8');
  const get = route ? `@Get('${route}')` : '@Get()';
  const at = src.indexOf(get);
  expect(at, `${get} у ${controller}`).toBeGreaterThan(-1);
  const roles = src.slice(at).match(/@Roles\(([^)]*)\)/);
  expect(roles, `@Roles для ${get} у ${controller}`).not.toBeNull();
  return roles![1]
    .split(',')
    .map(r =>
      r
        .trim()
        .replace(/^UserRole\./, '')
        .replace(/['"]/g, ''),
    )
    .filter(Boolean)
    .sort();
}

describe('DASHBOARD_READ_ROLES — дзеркало @Roles ендпоінтів дашборда (Bug #879)', () => {
  it.each([
    ['orders', 'work-orders/work-orders.controller.ts', ''],
    ['lowStock', 'inventory/stock-items.controller.ts', 'low'],
    ['invoices', 'invoices/invoices.controller.ts', ''],
    ['revenue', 'reports/reports.controller.ts', 'revenue'],
    ['maintenance', 'maintenance-schedules/maintenance-schedules.controller.ts', 'upcoming'],
    ['calendar', 'calendar/calendar.controller.ts', ''],
  ] as const)('%s ↔ %s', (key, controller, route) => {
    expect([...DASHBOARD_READ_ROLES[key]].sort()).toEqual(rolesOf(controller, route));
  });
});

describe('dashboardAccess', () => {
  it('механік читає наряди й календар; склад, рахунки, ТО й виручка — ні', () => {
    expect(dashboardAccess('MECHANIC')).toEqual({
      orders: true,
      lowStock: false,
      invoices: false,
      revenue: false,
      maintenance: false,
      calendar: true,
    });
  });

  it('приймальня — без складу й виручки', () => {
    const a = dashboardAccess('RECEPTIONIST');
    expect(a.lowStock).toBe(false);
    expect(a.revenue).toBe(false);
    expect(a.orders && a.invoices && a.maintenance && a.calendar).toBe(true);
  });

  it('власник читає все; без ролі — нічого', () => {
    expect(Object.values(dashboardAccess('OWNER')).every(Boolean)).toBe(true);
    expect(Object.values(dashboardAccess(undefined)).some(Boolean)).toBe(false);
  });
});

describe('DASHBOARD_INVOICES_URL — запасний шлях лічильника неоплачених (TECH-DEBT §10 п. 26)', () => {
  it('ті самі статуси, що рахує сервер (`dashboard.service.ts`), а не лише SENT', () => {
    const url = new URL(DASHBOARD_INVOICES_URL, 'http://x');
    expect(url.pathname).toBe('/invoices');
    expect(url.searchParams.get('status')).toBeNull();
    expect(url.searchParams.get('statuses')?.split(',').sort()).toEqual([
      'DRAFT',
      'OVERDUE',
      'PARTIALLY_PAID',
      'SENT',
    ]);
    // Дзеркало сервера: статуси лічильника в dashboard.service.ts — ті самі.
    const svc = readFileSync(resolve(MODULES, 'dashboard/dashboard.service.ts'), 'utf8');
    const m = svc.match(/invoice\.count\([\s\S]*?status: \{ in: \[([^\]]*)\]/);
    expect(m, 'статуси invoice.count у dashboard.service.ts').not.toBeNull();
    const serverStatuses = m![1]
      .split(',')
      .map(x => x.trim().replace(/['"]/g, ''))
      .filter(Boolean);
    expect([...serverStatuses].sort()).toEqual(['DRAFT', 'OVERDUE', 'PARTIALLY_PAID', 'SENT']);
  });
});
