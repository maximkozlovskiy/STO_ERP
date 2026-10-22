import type { TFunction } from 'i18next';
import { BODY_OPTIONS, DRIVE_OPTIONS, FUEL_TYPE_OPTIONS, TRANSMISSION_OPTIONS } from '@sto/shared';

/**
 * Варіанти полів авто (паливо, КПП, привід, кузов) мовою інтерфейсу. Набір значень — зі спільної
 * `@sto/shared`, підписи — `vehicles:options.<група>.<значення>` (uk збігається з підписами
 * shared, це стереже тест). Невідоме значення показується як є.
 */
const GROUPS = {
  fuel: FUEL_TYPE_OPTIONS,
  transmission: TRANSMISSION_OPTIONS,
  drive: DRIVE_OPTIONS,
  body: BODY_OPTIONS,
} as const;

export type VehicleOptionGroup = keyof typeof GROUPS;

export function vehicleOptions(group: VehicleOptionGroup, t: TFunction) {
  return GROUPS[group].map(o => ({
    value: o.value,
    label: t(`vehicles:options.${group}.${o.value}`, { defaultValue: o.label }),
  }));
}

export function vehicleOptionLabel(
  group: VehicleOptionGroup,
  value: string | null | undefined,
  t: TFunction,
): string {
  if (!value) return '';
  const option = GROUPS[group].find(o => o.value === value);
  return option
    ? t(`vehicles:options.${group}.${option.value}`, { defaultValue: option.label })
    : value;
}
