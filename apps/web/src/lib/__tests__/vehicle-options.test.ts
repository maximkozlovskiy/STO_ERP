import { afterEach, describe, expect, it } from 'vitest';
import { BODY_OPTIONS, DRIVE_OPTIONS, FUEL_TYPE_OPTIONS, TRANSMISSION_OPTIONS } from '@sto/shared';
import i18n from '@/i18n/config';
import { vehicleOptionLabel, vehicleOptions, type VehicleOptionGroup } from '../vehicle-options';

const SHARED: Record<VehicleOptionGroup, readonly { value: string; label: string }[]> = {
  fuel: FUEL_TYPE_OPTIONS,
  transmission: TRANSMISSION_OPTIONS,
  drive: DRIVE_OPTIONS,
  body: BODY_OPTIONS,
};

describe('vehicle-options', () => {
  afterEach(async () => {
    await i18n.changeLanguage('uk');
  });

  it('uk — ті самі підписи, що в @sto/shared, для кожного значення', () => {
    for (const [group, options] of Object.entries(SHARED)) {
      expect(vehicleOptions(group as VehicleOptionGroup, i18n.t)).toEqual(
        options.map(o => ({ value: o.value, label: o.label })),
      );
    }
  });

  it('en — кожне значення перекладене (підпис не збігається з українським)', async () => {
    await i18n.changeLanguage('en');
    for (const [group, options] of Object.entries(SHARED)) {
      const labels = vehicleOptions(group as VehicleOptionGroup, i18n.t);
      labels.forEach((o, i) => expect(o.label).not.toBe(options[i]!.label));
    }
    expect(vehicleOptionLabel('body', 'SEDAN', i18n.t)).toBe('Sedan');
    expect(vehicleOptionLabel('fuel', 'DIESEL', i18n.t)).toBe('Diesel');
  });

  it('невідоме значення — як є, порожнє — порожній рядок', () => {
    expect(vehicleOptionLabel('body', 'UNKNOWN', i18n.t)).toBe('UNKNOWN');
    expect(vehicleOptionLabel('body', '', i18n.t)).toBe('');
    expect(vehicleOptionLabel('body', null, i18n.t)).toBe('');
  });
});
