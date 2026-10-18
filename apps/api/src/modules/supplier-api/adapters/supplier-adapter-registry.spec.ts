import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { SupplierAdapterRegistry, validateSupplierOptions } from './supplier-adapter-registry';
import type { SupplierAdapter, SupplierFieldSpec } from './supplier-adapter.interface';

const WH = '21111111-1111-4111-8111-111111111111';

const specs = {
  optionFields: [
    {
      key: 'paymentType',
      label: 'Оплата',
      secret: false,
      required: false,
      type: 'select',
      options: ['nal', 'beznal'],
    },
    { key: 'autoShip', label: 'Відвантаження', secret: false, required: false, type: 'boolean' },
  ] as SupplierFieldSpec[],
  warehouseFields: [
    { key: 'locationUuid', label: 'Торгова точка', secret: false, required: true, type: 'string' },
    { key: 'recipientUuid', label: 'Отримувач', secret: false, required: false, type: 'string' },
  ] as SupplierFieldSpec[],
};

describe('validateSupplierOptions — опції лише з опису адаптера (BR-SCON-003)', () => {
  // guards: BR-SCON-003
  it('відомі поля й мапа складів проходять; порожні значення відкидаються', () => {
    const r = validateSupplierOptions(specs, {
      paymentType: 'beznal',
      autoShip: true,
      warehouses: { [WH]: { locationUuid: ' loc-1 ', recipientUuid: '' } },
    });
    expect(r.errors).toEqual([]);
    expect(r.value).toEqual({
      paymentType: 'beznal',
      autoShip: true,
      warehouses: { [WH]: { locationUuid: 'loc-1' } },
    });
  });

  // guards: BR-SCON-003
  it('невідоме поле, не той тип, значення поза переліком, склад без обов’язкового поля → помилки', () => {
    const r = validateSupplierOptions(specs, {
      secretToken: 'x',
      paymentType: 'card',
      autoShip: 'yes',
      warehouses: { 'not-a-uuid': {}, [WH]: { recipientUuid: 'r' } },
    });
    expect(r.errors).toHaveLength(5);
    expect(r.errors.join('\n')).toMatch(/невідоме поле «secretToken»/);
    expect(r.errors.join('\n')).toMatch(/Торгова точка/);
  });

  it('не об’єкт → помилка', () => {
    expect(validateSupplierOptions(specs, [1, 2]).errors).toHaveLength(1);
    expect(validateSupplierOptions(specs, undefined)).toEqual({ value: {}, errors: [] });
  });
});

describe('SupplierAdapterRegistry', () => {
  it('невідомий провайдер → 400 unknownProvider; list() — без кредів, лише опис полів', () => {
    const adapter = {
      provider: 'AVD_TRADE',
      name: 'AVD Trade',
      capabilities: { search: 'mirror' },
      credentialFields: [
        { key: 'apiKey', label: 'Ключ', secret: true, required: true, type: 'string' },
      ],
      optionFields: [],
      warehouseFields: [],
    } as unknown as SupplierAdapter;
    const reg = new SupplierAdapterRegistry([adapter]);
    expect(reg.get('AVD_TRADE')).toBe(adapter);
    expect(() => reg.get('NOPE')).toThrow(BadRequestException);
    expect(reg.list()[0]).toMatchObject({
      provider: 'AVD_TRADE',
      credentialFields: [{ key: 'apiKey', secret: true }],
    });
  });
});
