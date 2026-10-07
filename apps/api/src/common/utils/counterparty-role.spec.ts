import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BadRequestException } from '@nestjs/common';
import type { CounterpartyType } from '@prisma/client';
import { describe, it, expect } from 'vitest';
import { assertCounterpartyRole, type CounterpartyRole } from './counterparty-role';

describe('assertCounterpartyRole (BR-CP-001)', () => {
  const MATRIX: [CounterpartyType, CounterpartyRole, boolean][] = [
    ['CLIENT', 'client', true],
    ['BOTH', 'client', true],
    ['SUPPLIER', 'client', false],
    ['SUPPLIER', 'supplier', true],
    ['BOTH', 'supplier', true],
    ['CLIENT', 'supplier', false],
  ];

  // guards: BR-CP-001
  it.each(MATRIX)('тип %s у ролі %s → дозволено: %s', (type, role, allowed) => {
    const call = () => assertCounterpartyRole(type, role);
    if (allowed) expect(call).not.toThrow();
    else expect(call).toThrow(BadRequestException);
  });

  it('повідомлення українською і різне для двох ролей', () => {
    const message = (type: CounterpartyType, role: CounterpartyRole): string => {
      try {
        assertCounterpartyRole(type, role);
      } catch (e) {
        return (e as BadRequestException).message;
      }
      return '';
    };
    expect(message('SUPPLIER', 'client')).toBe('Контрагент є постачальником — оберіть клієнта');
    expect(message('CLIENT', 'supplier')).toBe('Контрагент не є постачальником');
  });

  /**
   * Статичний сторож підключення. Матриця вище доводить, що хелпер відмовляє; цей кейс — що
   * його кличуть усі шляхи, якими контрагент потрапляє в документ. Прибрали виклик із сервісу —
   * кейс падає з назвою файла. Нові шляхи створення додавати сюди.
   */
  const WIRING: [string, CounterpartyRole, number][] = [
    ['purchase-orders/purchase-orders.service.ts', 'supplier', 2], // create, update (зміна постачальника)
    ['work-orders/work-orders.service.ts', 'client', 2], // create, clone
    ['invoices/invoices.service.ts', 'client', 3], // create, update (зміна контрагента), clone
    ['supplier-payments/supplier-payments.service.ts', 'supplier', 2], // create, update
    ['supplier-returns/supplier-returns.service.ts', 'supplier', 2], // create, update (зміна постачальника)
  ];

  // guards: BR-CP-001
  it.each(WIRING)('%s перевіряє роль «%s» у %i місцях', (file, role, count) => {
    const source = readFileSync(join(__dirname, '../../modules', file), 'utf8');
    const calls = source.match(new RegExp(`assertCounterpartyRole\\([^)]*'${role}'\\)`, 'g')) ?? [];
    expect(calls).toHaveLength(count);
  });
});
