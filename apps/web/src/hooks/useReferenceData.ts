import { useState, useRef, useMemo, useEffect } from 'react';
import { apiFetch } from '@/lib/api-client';
import { getCached, setCache } from '@/lib/ref-cache';
import { toIdMap } from '@/lib/utils';

/**
 * A3-modal: reference-data + org-settings хук, винесений з CreateWorkOrderModal (God-component 3708р).
 * Self-contained: тягне 6 довідників (branches/lifts/warehouses/employees/units + per-CP vehicles/contracts)
 * і org-налаштування (vatMode/vatRate/recalc-flags/syncCalendar) через apiFetch + warm sessionStorage cache.
 * Нуль coupling у form/lines/parts модала — vehicle auto-select single повертається через колбек
 * `onSingleVehicle`, щоб хук не залежав від form-shape.
 */

export interface Branch {
  id: string;
  name: string;
}
export interface Lift {
  id: string;
  name: string;
}
export interface Warehouse {
  id: string;
  name: string;
  type?: string;
  deletedAt?: string | null;
}
export interface Employee {
  id: string;
  firstName: string;
  lastName: string;
  role?: string;
  deletedAt?: string | null;
}
export interface Vehicle {
  id: string;
  make: string;
  model: string;
  licensePlate: string | null;
}
export interface Contract {
  id: string;
  title: string;
  number?: string | null;
}
export interface Unit {
  id: string;
  name: string;
  shortName: string;
}

export type VatMode = 'NONE' | 'EXCLUSIVE' | 'INCLUSIVE';

export function useReferenceData() {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [lifts, setLifts] = useState<Lift[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);

  const [vatMode, setVatMode] = useState<VatMode>('NONE');
  const [vatRate, setVatRate] = useState(0);
  // default = true (Prisma schema default + DocumentsTab `?? true`).
  // Раніше `useState(false)` + `?? false` → silent drift: settings toggle on,
  // WO модалка ефективно off коли GET /settings/organisation lag-ить чи не повертає поле.
  const [recalcPlannedHoursEnabled, setRecalcPlannedHoursEnabled] = useState(true);
  const [recalcActualHoursEnabled, setRecalcActualHoursEnabled] = useState(true);
  const [syncCalendarEnabled, setSyncCalendarEnabled] = useState(true);

  const vehicleReqRef = useRef(0);
  const contractReqRef = useRef(0);

  useEffect(() => {
    const cachedBranches = getCached<Branch[]>('cache:branches');
    if (cachedBranches) {
      setBranches(cachedBranches);
    } else {
      apiFetch<Branch[]>('/branches')
        .then(bs => {
          setBranches(bs);
          setCache('cache:branches', bs);
        })
        .catch(() => {});
    }

    const cachedLifts = getCached<Lift[]>('cache:lifts');
    if (cachedLifts) setLifts(cachedLifts);
    // Always re-fetch to avoid stale deleted lifts appearing in the select
    apiFetch<Lift[] | { items: Lift[] }>('/lifts')
      .then(r => {
        const list = Array.isArray(r) ? r : ((r as { items: Lift[] }).items ?? []);
        setLifts(list);
        setCache('cache:lifts', list);
      })
      .catch(() => {});

    const cachedWarehouses = getCached<Warehouse[]>('cache:warehouses');
    if (cachedWarehouses) setWarehouses(cachedWarehouses);
    apiFetch<Warehouse[] | { items: Warehouse[] }>('/warehouses')
      .then(r => {
        const all = Array.isArray(r) ? r : ((r as { items: Warehouse[] }).items ?? []);
        const list = all.filter(w => !w.deletedAt && w.type !== 'TIRE_HOTEL');
        setWarehouses(list);
        setCache('cache:warehouses', list);
      })
      .catch(() => {});

    const cachedEmployees = getCached<Employee[]>('cache:employees');
    if (cachedEmployees) setEmployees(cachedEmployees);
    apiFetch<{ items: Employee[] }>('/employees?limit=200&role=MECHANIC')
      .then(r => {
        const list = (Array.isArray(r.items) ? r.items : []).filter(e => !e.deletedAt);
        setEmployees(list);
        setCache('cache:employees', list);
      })
      .catch(() => {});

    // sto-optimize: units є reference data з warm sessionStorage cache (TTL ≥30хв).
    // Cache populated catalog/UnitsTab + catalog/GoodsTab (source pages). Seeding
    // дає instant first-paint списку одиниць для parts table у WO modal.
    const cachedUnits = getCached<Unit[]>('cache:units');
    if (cachedUnits) {
      setUnits(cachedUnits);
    } else {
      apiFetch<{ items: Unit[] } | Unit[]>('/units?limit=200')
        .then(r => {
          const list = Array.isArray(r) ? r : (r.items ?? []);
          setUnits(list);
          setCache('cache:units', list);
        })
        .catch(() => {});
    }

    Promise.all([
      apiFetch<{
        vatMode: string;
        defaultVatRateId?: string | null;
        recalcPlannedHoursFromLines?: boolean;
        recalcActualHoursFromLines?: boolean;
        syncCalendarSlotWithPlannedHours?: boolean;
      }>('/settings/organisation'),
      apiFetch<{ id: string; rate: number; isDefault: boolean }[]>('/settings/tax-rates'),
    ])
      .then(([org, rates]) => {
        setVatMode((org.vatMode as VatMode) ?? 'NONE');
        // дефолт = true (Prisma schema default). Без цього при legacy DTO
        // response, що не містить поля, settings/DocumentsTab показує on, а тут off.
        setRecalcPlannedHoursEnabled(org.recalcPlannedHoursFromLines ?? true);
        setRecalcActualHoursEnabled(org.recalcActualHoursFromLines ?? true);
        setSyncCalendarEnabled(org.syncCalendarSlotWithPlannedHours ?? true);
        const def = (Array.isArray(rates) ? rates : []).find(r => r.isDefault);
        if (def) setVatRate(Number(def.rate));
      })
      .catch(() => {});
  }, []);

  /**
   * Per-CP vehicles. Race-safe через req-id. Auto-select single vehicle НЕ мутує form напряму —
   * повертає через `onSingleVehicle` (модал сам вирішує setForm), щоб хук лишався form-agnostic.
   */
  const loadVehicles = (
    cpId: string,
    keepVehicleId?: string,
    onSingleVehicle?: (vehicleId: string) => void,
  ) => {
    if (!cpId) return;
    const reqId = ++vehicleReqRef.current;
    apiFetch<Vehicle[]>(`/vehicles?counterpartyId=${cpId}`)
      .then(list => {
        if (reqId !== vehicleReqRef.current) return;
        const all = Array.isArray(list) ? list : [];
        setVehicles(all);
        if (keepVehicleId && all.some(v => v.id === keepVehicleId)) return;
        if (all.length === 1) onSingleVehicle?.(all[0].id);
      })
      .catch(() => {});
  };

  const loadContracts = (cpId: string) => {
    if (!cpId) return;
    const reqId = ++contractReqRef.current;
    apiFetch<{ items: Contract[] }>(`/counterparties/${cpId}/contracts?limit=100`)
      .then(r => {
        if (reqId !== contractReqRef.current) return;
        setContracts(Array.isArray(r.items) ? r.items : []);
      })
      .catch(() => {});
  };

  const employeesById = useMemo(() => toIdMap(employees), [employees]);
  const warehousesById = useMemo(() => toIdMap(warehouses), [warehouses]);
  const unitsById = useMemo(() => toIdMap(units), [units]);
  const vehiclesById = useMemo(() => toIdMap(vehicles), [vehicles]);
  const liftsById = useMemo(() => toIdMap(lifts), [lifts]);
  const branchesById = useMemo(() => toIdMap(branches), [branches]);

  return {
    branches,
    lifts,
    warehouses,
    employees,
    vehicles,
    contracts,
    units,
    setVehicles,
    setContracts,
    vatMode,
    vatRate,
    recalcPlannedHoursEnabled,
    recalcActualHoursEnabled,
    syncCalendarEnabled,
    loadVehicles,
    loadContracts,
    employeesById,
    warehousesById,
    unitsById,
    vehiclesById,
    liftsById,
    branchesById,
  };
}
