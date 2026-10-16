import { describe, it, expect, vi } from 'vitest';
import { EmployeesService } from './employees.service';
import { whereHasTenantScope } from '../../prisma/tenant-guard.extension';

// Збереження картки співробітника шле POST /employees/:id/branches. `EmployeeBranch` — tenant-модель
// (має orgId), тож fail-closed guard відхиляє deleteMany без tenant-фільтра: картка не зберігалась
// узагалі (500 «Внутрішня помилка сервера»), а з нею й закріплення механіка за підйомником
// (BR-CAL-012). Перевіряється справжньою функцією guard-а, а не формою запиту.

const ORG = 'org-1';
const EMP = '11111111-1111-4111-8111-111111111111';
const BRANCH = '22222222-2222-4222-8222-222222222222';

function setup() {
  const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
  const createMany = vi.fn().mockResolvedValue({ count: 1 });
  const prisma = {
    employee: {
      findFirst: vi.fn().mockResolvedValue({
        id: EMP,
        employeeZones: [],
        employeeLifts: [],
        employeeWorkCategories: [],
        employeeBranches: [],
      }),
    },
    garageBranch: { findMany: vi.fn().mockResolvedValue([{ id: BRANCH }]) },
    $transaction: vi.fn((cb: (tx: unknown) => unknown) =>
      cb({ employeeBranch: { deleteMany, createMany }, employee: { updateMany: vi.fn() } }),
    ),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { service: new EmployeesService(prisma as any), deleteMany, createMany };
}

describe('EmployeesService.assignBranches — tenant-фільтр', () => {
  it('видалення старих філій співробітника обмежене своєю організацією', async () => {
    const { service, deleteMany, createMany } = setup();
    await service.assignBranches(ORG, EMP, { branchIds: [BRANCH], allBranches: false });
    const { where } = deleteMany.mock.calls[0][0];
    expect(whereHasTenantScope(where)).toBe(true);
    expect(where).toMatchObject({ employeeId: EMP, orgId: ORG });
    expect(createMany.mock.calls[0][0].data).toEqual([
      { employeeId: EMP, branchId: BRANCH, orgId: ORG },
    ]);
  });
});
