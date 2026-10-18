import { describe, expect, it } from 'vitest';
import { supplierCacheRows } from '../supplier-cache-rows';

describe('supplierCacheRows — кеш постачальників лише з полями вибору (BR-CP-014)', () => {
  // guards: BR-CP-014
  it('повна відповідь власника → у кеш лише id і назва, без телефону, e-mail, балансу', () => {
    const owner = {
      id: 's-1',
      firstName: null,
      lastName: null,
      companyName: 'ТОВ Запчастини',
      phone: '+380671112233',
      email: 'sup@sto.local',
      balance: -1500,
      notes: 'нотатка',
    };
    expect(supplierCacheRows([owner])).toEqual([
      { id: 's-1', firstName: null, lastName: null, companyName: 'ТОВ Запчастини' },
    ]);
  });
});
