// BR-WO-018: довідник виконавців рядка роботи — лише активні механіки. Повна відповідь
// (OWNER/ADMIN/RECEPTIONIST) несе `role` і `status`; звужена відповідь механіка — лише id та ім'я,
// бо сервер уже відфільтрував (рішення власника 2026-10-16, друге).

import { describe, expect, it } from 'vitest';
import { ACTIVE_MECHANICS_URL, activeMechanics } from '../work-order-mechanics';

const person = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  firstName: 'Іван',
  lastName: id,
  role: 'MECHANIC',
  status: 'ACTIVE',
  deletedAt: null as string | null,
  ...over,
});

describe('activeMechanics (BR-WO-018)', () => {
  // guards: BR-WO-018
  it('повна відповідь: без відпустки, звільнених, видалених і не механіків', () => {
    const items = [
      person('active'),
      person('leave', { status: 'ON_LEAVE' }),
      person('fired', { status: 'FIRED' }),
      person('deleted', { deletedAt: '2026-05-01T00:00:00.000Z' }),
      person('owner', { role: 'OWNER' }),
    ];

    expect(activeMechanics(items).map(e => e.id)).toEqual(['active']);
  });

  // guards: BR-WO-018
  it('звужена відповідь механіка (без role і status) — як прийшла', () => {
    const items = [
      { id: 'a', firstName: 'Іван', lastName: 'Петров' },
      { id: 'b', firstName: 'Олег', lastName: 'Сидоренко' },
    ];

    expect(activeMechanics(items)).toEqual(items);
  });

  it('порожньо чи null → порожній список', () => {
    expect(activeMechanics(null)).toEqual([]);
    expect(activeMechanics(undefined)).toEqual([]);
  });

  it('запит — лише механіки', () => {
    expect(ACTIVE_MECHANICS_URL).toContain('role=MECHANIC');
  });
});
