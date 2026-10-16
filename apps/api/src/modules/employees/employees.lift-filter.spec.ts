import { describe, it, expect, vi } from 'vitest';
import { EmployeesService } from './employees.service';
import { matchesWhere } from '../calendar/calendar.spec-fixture';

// guards: BR-CAL-012
// `GET /employees?liftId=` — список для поля «Механік» у записі календаря: лише закріплені за
// підйомником, своєї організації, без звільнених і видалених. Таблиця в пам'яті ВИКОНУЄ Prisma
// `where` (`matchesWhere` — та сама, що в спеках календаря), тож тест описує, КОГО повертає
// фільтр, а не форму запиту.

const LIFT_1 = '22222222-2222-4222-8222-222222222222';
const LIFT_2 = '22222222-2222-4222-8222-333333333333';

function person(id: string, lifts: string[], over: Record<string, unknown> = {}) {
  return {
    id,
    orgId: 'org-1',
    firstName: 'Іван',
    lastName: id,
    role: 'MECHANIC',
    status: 'ACTIVE',
    rateScheme: { type: 'HOURLY', rate: 100 },
    deletedAt: null as Date | null,
    employeeLifts: lifts.map(liftId => ({ liftId })),
    employeeZones: [],
    employeeWorkCategories: [],
    employeeBranches: [],
    ...over,
  };
}

const TABLE = [
  person('on-lift-1', [LIFT_1]),
  person('both-lifts', [LIFT_1, LIFT_2]),
  person('on-lift-2', [LIFT_2]),
  person('no-lifts', []),
  person('fired', [LIFT_1], { status: 'FIRED' }),
  person('on-leave', [LIFT_1], { status: 'ON_LEAVE' }),
  person('deleted', [LIFT_1], { deletedAt: new Date('2026-05-01T00:00:00Z') }),
  person('foreign', [LIFT_1], { orgId: 'org-2' }),
  person('receptionist', [LIFT_1], { role: 'RECEPTIONIST' }),
];

function service() {
  const where = (args: { where: Record<string, unknown> }) =>
    TABLE.filter(e => matchesWhere(e, args.where));
  const prisma = {
    employee: {
      findMany: vi.fn(async (args: { where: Record<string, unknown> }) => where(args)),
      count: vi.fn(async (args: { where: Record<string, unknown> }) => where(args).length),
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new EmployeesService(prisma as any);
}

describe('EmployeesService.findAll — фільтр liftId (BR-CAL-012)', () => {
  it('лише закріплені за підйомником, своєї організації, без звільнених і видалених', async () => {
    const { items, total } = await service().findAll('org-1', { liftId: LIFT_1 });
    expect(items.map(e => e.id).sort()).toEqual(
      ['both-lifts', 'on-leave', 'on-lift-1', 'receptionist'].sort(),
    );
    expect(total).toBe(4);
  });

  it('разом із role=MECHANIC — лише механіки підйомника', async () => {
    const { items } = await service().findAll('org-1', { liftId: LIFT_1, role: 'MECHANIC' });
    expect(items.map(e => e.id).sort()).toEqual(['both-lifts', 'on-leave', 'on-lift-1'].sort());
  });

  it('інший підйомник — свій список', async () => {
    const { items } = await service().findAll('org-1', { liftId: LIFT_2 });
    expect(items.map(e => e.id).sort()).toEqual(['both-lifts', 'on-lift-2'].sort());
  });

  it('без liftId фільтр не діє: звільнені й незакріплені в загальному списку лишаються', async () => {
    const { items } = await service().findAll('org-1', {});
    expect(items.map(e => e.id)).toEqual(
      expect.arrayContaining(['fired', 'no-lifts', 'on-lift-2']),
    );
  });
});
