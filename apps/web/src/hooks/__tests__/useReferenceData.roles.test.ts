// Картка наряду для «Бухгалтера» (клас Bug #729): бухгалтер читає наряд, але не довідники
// підйомників і авто й не залишки товарів — `GET /lifts`, `GET /vehicles?counterpartyId=…` і
// `GET /goods/stock-totals` давали 403 на кожне відкриття картки. Картка їх не запитує, а підпис авто й підйомника бере з самого наряду.
// Набори ролей — дзеркало `@Roles` контролерів api: тест падає, щойно одна сторона зміниться.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, renderHook, waitFor } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({ apiFetch: (...a: unknown[]) => apiFetchMock(...a) }));
vi.mock('@/lib/ref-cache', () => ({ getCached: () => null, setCache: vi.fn() }));

import { useReferenceData, vehicleLabel, WO_REFERENCE_READ_ROLES } from '../useReferenceData';
import { useStockTotals } from '../useStockTotals';

const MODULES = resolve(__dirname, '../../../../api/src/modules');

/** Ролі `@Roles(...)` над `@Get('<route>')` (або `@Get()`) контролера з `@Controller('<name>')`. */
function rolesOfList(file: string, controller: string, route = '', method = 'Get'): string[] {
  const src = readFileSync(resolve(MODULES, file), 'utf8');
  const ctl = src.indexOf(`@Controller('${controller}')`);
  expect(ctl, `@Controller('${controller}') у ${file}`).toBeGreaterThan(-1);
  const get = src.indexOf(route ? `@${method}('${route}')` : `@${method}()`, ctl);
  expect(get).toBeGreaterThan(-1);
  const match = src.slice(get).match(/@Roles\(([^)]*)\)/);
  expect(match).not.toBeNull();
  return (match?.[1] ?? '')
    .split(',')
    .map(r => r.trim().replace(/['"]/g, ''))
    .filter(Boolean)
    .sort();
}

const urls = () => apiFetchMock.mock.calls.map(c => String(c[0]));
const OWN = {
  id: 'veh-1',
  make: '',
  model: '',
  licensePlate: null,
  summary: 'Toyota Camry (AA1234BB)',
};

describe('useReferenceData — довідники картки наряду за роллю', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation((raw: unknown) => {
      const url = String(raw);
      if (url === '/lifts') return Promise.resolve([{ id: 'lift-1', name: 'Підйомник 1' }]);
      if (url.startsWith('/vehicles'))
        return Promise.resolve([
          { id: 'veh-1', make: 'Toyota', model: 'Camry', licensePlate: 'AA1234BB' },
        ]);
      if (url === '/settings/organisation') return Promise.resolve({ vatMode: 'NONE' });
      if (url === '/settings/tax-rates') return Promise.resolve([]);
      return Promise.resolve([]);
    });
  });

  it.each<[keyof typeof WO_REFERENCE_READ_ROLES, string, string, string, string]>([
    ['lifts', 'zones/zones.controller.ts', 'lifts', '', 'Get'],
    ['vehicles', 'vehicles/vehicles.controller.ts', 'vehicles', '', 'Get'],
    ['stockTotals', 'goods/goods.controller.ts', 'goods', 'stock-totals', 'Get'],
    [
      'conflictCheck',
      'calendar/calendar.controller.ts',
      'calendar/slots',
      'check-conflicts',
      'Post',
    ],
  ])('%s ↔ @Roles %s', (key, file, controller, route, method) => {
    expect([...WO_REFERENCE_READ_ROLES[key]].sort()).toEqual(
      rolesOfList(file, controller, route, method),
    );
  });

  it('залишки товарів: без доступу ролі — жодного /goods/stock-totals', async () => {
    const parts = [{ goodId: 'g-1' }];
    const { rerender } = renderHook(({ enabled }) => useStockTotals(parts, '', '', enabled), {
      initialProps: { enabled: false },
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(urls().filter(u => u.startsWith('/goods/stock-totals'))).toEqual([]);

    rerender({ enabled: true });
    await waitFor(() => expect(urls()).toContain('/goods/stock-totals?ids=g-1'));
  });

  it('«Бухгалтер»: ні /lifts, ні /vehicles; у полях — авто й підйомник самого наряду', async () => {
    const { result } = renderHook(() => useReferenceData('ACCOUNTANT'));
    await waitFor(() => expect(urls()).toContain('/settings/tax-rates'));

    act(() => {
      result.current.loadVehicles('cp-1', 'veh-1', undefined, OWN);
      result.current.seedOwnLift({ id: 'lift-9', name: 'Підйомник наряду' });
    });

    expect(urls().filter(u => u === '/lifts' || u.startsWith('/vehicles'))).toEqual([]);
    expect(result.current.vehicles).toEqual([OWN]);
    expect(result.current.lifts).toEqual([{ id: 'lift-9', name: 'Підйомник наряду' }]);
    expect(vehicleLabel(result.current.vehicles[0]!, p => ` · ${p}`)).toBe(
      'Toyota Camry (AA1234BB)',
    );
  });

  it('«Приймальня»: довідники з api, підйомник наряду не підміняє перелік', async () => {
    const { result } = renderHook(() => useReferenceData('RECEPTIONIST'));
    await waitFor(() => expect(result.current.lifts).toHaveLength(1));

    act(() => {
      result.current.seedOwnLift({ id: 'lift-9', name: 'Підйомник наряду' });
      result.current.loadVehicles('cp-1', 'veh-1', undefined, OWN);
    });
    await waitFor(() => expect(result.current.vehicles[0]?.make).toBe('Toyota'));

    expect(urls()).toContain('/lifts');
    expect(urls()).toContain('/vehicles?counterpartyId=cp-1');
    expect(result.current.lifts).toEqual([{ id: 'lift-1', name: 'Підйомник 1' }]);
    expect(vehicleLabel(result.current.vehicles[0]!, p => ` · ${p}`)).toBe(
      'Toyota Camry · AA1234BB',
    );
  });
});
