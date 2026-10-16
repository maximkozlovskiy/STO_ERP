// Bug #879: дашборд шле лише ті запити, які роль може читати. Набори ролей — дзеркало `@Roles`
// ендпоінтів; цей тест читає контролери api і падає, щойно одна сторона зміниться без другої
// (інакше або знову 403 і порожній дашборд, або показник, якого роль дарма не бачить).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DASHBOARD_READ_ROLES, dashboardAccess } from './useDashboardData';

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
    ['expiringWarranties', 'warranties/warranties.controller.ts', 'expiring'],
  ] as const)('%s ↔ %s', (key, controller, route) => {
    expect([...DASHBOARD_READ_ROLES[key]].sort()).toEqual(rolesOf(controller, route));
  });
});

describe('dashboardAccess', () => {
  it('механік читає лише наряди; склад, рахунки, ТО, гарантії й виручка — ні', () => {
    expect(dashboardAccess('MECHANIC')).toEqual({
      orders: true,
      lowStock: false,
      invoices: false,
      revenue: false,
      maintenance: false,
      expiringWarranties: false,
    });
  });

  it('приймальня — без складу й виручки', () => {
    const a = dashboardAccess('RECEPTIONIST');
    expect(a.lowStock).toBe(false);
    expect(a.revenue).toBe(false);
    expect(a.orders && a.invoices && a.maintenance && a.expiringWarranties).toBe(true);
  });

  it('власник читає все; без ролі — нічого', () => {
    expect(Object.values(dashboardAccess('OWNER')).every(Boolean)).toBe(true);
    expect(Object.values(dashboardAccess(undefined)).some(Boolean)).toBe(false);
  });
});
