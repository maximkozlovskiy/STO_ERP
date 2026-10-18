import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { SupplierProvider } from '@prisma/client';
import { translateError } from '@sto/shared';
import { getLocale } from '../../../common/tenant/tenant-context';
import {
  SUPPLIER_ADAPTERS,
  type SupplierAdapter,
  type SupplierCapabilities,
  type SupplierConnectionOptions,
  type SupplierFieldSpec,
} from './supplier-adapter.interface';

export interface SupplierProviderInfo {
  provider: SupplierProvider;
  name: string;
  capabilities: SupplierCapabilities;
  credentialFields: SupplierFieldSpec[];
  optionFields: SupplierFieldSpec[];
  warehouseFields: SupplierFieldSpec[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPTION_VALUE_MAX = 200;

/**
 * Реєстр адаптерів (за зразком DeliveryProviderRegistry): адаптери інжектяться масивом
 * через SUPPLIER_ADAPTERS. Новий постачальник = новий адаптер у supplier-api.module, реєстр не
 * змінюється. `list()` віддає опис полів кредів і опцій — форма підключення в web будується з
 * сервера (BR-SCON-003).
 */
@Injectable()
export class SupplierAdapterRegistry {
  private readonly adapters = new Map<SupplierProvider, SupplierAdapter>();

  constructor(@Inject(SUPPLIER_ADAPTERS) adapters: SupplierAdapter[]) {
    for (const a of adapters) this.adapters.set(a.provider, a);
  }

  /** Адаптер провайдера або 400 unknownProvider. */
  get(provider: SupplierProvider | string): SupplierAdapter {
    const a = this.adapters.get(provider as SupplierProvider);
    if (!a) {
      throw new BadRequestException(
        translateError('err.supplierConnection.unknownProvider', getLocale(), { provider }),
      );
    }
    return a;
  }

  list(): SupplierProviderInfo[] {
    return [...this.adapters.values()].map(a => ({
      provider: a.provider,
      name: a.name,
      capabilities: a.capabilities,
      credentialFields: a.credentialFields,
      optionFields: a.optionFields,
      warehouseFields: a.warehouseFields,
    }));
  }
}

/**
 * BR-SCON-003: опції підключення — лише поля з опису адаптера. Верхній рівень — `optionFields`
 * і `warehouses`; `warehouses` — мапа «uuid нашого складу → { поле: рядок }» із `warehouseFields`.
 * Повертає нормалізоване значення й перелік помилок (порожній — валідно).
 */
export function validateSupplierOptions(
  adapter: Pick<SupplierAdapter, 'optionFields' | 'warehouseFields'>,
  raw: unknown,
): { value: SupplierConnectionOptions; errors: string[] } {
  const errors: string[] = [];
  const value: SupplierConnectionOptions = {};
  if (raw === undefined || raw === null) return { value, errors };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { value, errors: ['options: очікується об’єкт'] };
  }
  const known = new Map(adapter.optionFields.map(f => [f.key, f]));
  for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
    if (key === 'warehouses') continue;
    const spec = known.get(key);
    if (!spec) {
      errors.push(`невідоме поле «${key}»`);
      continue;
    }
    const err = checkField(spec, v);
    if (err) errors.push(err);
    else if (v !== undefined && v !== null && v !== '') value[key] = v;
  }
  const whRaw = (raw as Record<string, unknown>).warehouses;
  if (whRaw !== undefined && whRaw !== null) {
    if (typeof whRaw !== 'object' || Array.isArray(whRaw)) {
      errors.push('warehouses: очікується об’єкт');
    } else {
      const whFields = new Map(adapter.warehouseFields.map(f => [f.key, f]));
      const warehouses: Record<string, Record<string, string>> = {};
      for (const [warehouseId, entry] of Object.entries(whRaw as Record<string, unknown>)) {
        if (!UUID_RE.test(warehouseId)) {
          errors.push(`warehouses: «${warehouseId}» — не ідентифікатор складу`);
          continue;
        }
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          errors.push(`warehouses.${warehouseId}: очікується об’єкт`);
          continue;
        }
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(entry as Record<string, unknown>)) {
          const spec = whFields.get(k);
          if (!spec) {
            errors.push(`warehouses.${warehouseId}: невідоме поле «${k}»`);
            continue;
          }
          const err = checkField(spec, v);
          if (err) errors.push(`warehouses.${warehouseId}: ${err}`);
          else if (typeof v === 'string' && v.trim() !== '') out[k] = v.trim();
        }
        for (const spec of adapter.warehouseFields) {
          if (spec.required && !out[spec.key]) {
            errors.push(`warehouses.${warehouseId}: поле «${spec.label}» обов’язкове`);
          }
        }
        if (Object.keys(out).length > 0) warehouses[warehouseId] = out;
      }
      if (Object.keys(warehouses).length > 0) value.warehouses = warehouses;
    }
  }
  return { value, errors };
}

function checkField(spec: SupplierFieldSpec, v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (spec.type === 'boolean') {
    return typeof v === 'boolean' ? null : `«${spec.label}»: очікується так/ні`;
  }
  if (typeof v !== 'string') return `«${spec.label}»: очікується рядок`;
  if (v.length > OPTION_VALUE_MAX) return `«${spec.label}»: задовге значення`;
  if (spec.type === 'select' && spec.options && !spec.options.includes(v)) {
    return `«${spec.label}»: допустимі значення — ${spec.options.join(', ')}`;
  }
  return null;
}
