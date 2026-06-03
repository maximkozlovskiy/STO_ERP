'use client';

import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';
import { setCache } from '@/lib/ref-cache';

export interface Branch {
  id: string;
  name: string;
  address?: string;
  phone?: string | null;
}
export interface Zone {
  id: string;
  name: string;
  type: string;
  branchId: string;
}
export interface Lift {
  id: string;
  name: string;
  type: string;
  zoneId?: string | null;
  maxWeightKg?: number | null;
  status?: string | null;
  serialNumber?: string | null;
  purchaseDate?: string | null;
  warrantyUntil?: string | null;
  maintenanceIntervalDays?: number | null;
  lastMaintenanceDate?: string | null;
  nextMaintenanceDate?: string | null;
}
export interface Warehouse {
  id: string;
  name: string;
  type: string;
  branchId?: string | null;
  isMain: boolean;
}

export const infraKeys = {
  branches: ['infrastructure', 'branches'] as const,
  zones: ['infrastructure', 'zones'] as const,
  lifts: ['infrastructure', 'lifts'] as const,
  warehouses: ['infrastructure', 'warehouses'] as const,
  all: ['infrastructure'] as const,
};

export function useBranches() {
  const { employee } = useAuth();
  return useQuery<Branch[]>({
    queryKey: infraKeys.branches,
    queryFn: ({ signal }) =>
      apiFetch<Branch[]>('/branches', { signal }).then(d => {
        setCache('cache:branches', d);
        return d;
      }),
    enabled: !!employee,
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
  });
}

export function useZones() {
  const { employee } = useAuth();
  return useQuery<Zone[]>({
    queryKey: infraKeys.zones,
    queryFn: ({ signal }) =>
      apiFetch<Zone[]>('/zones', { signal }).then(d => {
        setCache('cache:zones', d);
        return d;
      }),
    enabled: !!employee,
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
  });
}

export function useLifts() {
  const { employee } = useAuth();
  return useQuery<Lift[]>({
    queryKey: infraKeys.lifts,
    queryFn: ({ signal }) =>
      apiFetch<Lift[]>('/lifts', { signal }).then(d => {
        setCache('cache:lifts', d);
        return d;
      }),
    enabled: !!employee,
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
  });
}

export function useWarehouses() {
  const { employee } = useAuth();
  return useQuery<Warehouse[]>({
    queryKey: infraKeys.warehouses,
    queryFn: ({ signal }) =>
      apiFetch<Warehouse[]>('/warehouses', { signal }).then(d => {
        setCache('cache:warehouses', d);
        return d;
      }),
    enabled: !!employee,
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
  });
}

export function useInvalidateInfrastructure() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: infraKeys.all });
}
