import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { employeeUpdateSchema, type EmployeeUpdateValues } from '@sto/shared';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { EmployeesService } from './employees.service';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * PATCH /employees/:id — очищення телефону, e-mail і дат прийому / звільнення.
 *
 * TECH-DEBT (а) 2026-11-01: картка працівника слала `phone || undefined` (ключ зникав), а
 * `employeeUpdateSchema` (`optionalString`) робила з '' і null `undefined` — PATCH 200, у БД старе.
 * Тіло проходить ту саму `ZodValidationPipe`, що й контролер, далі — `EmployeesService.update`.
 */
const ORG = 'org-1';
const EMP_ID = '11111111-1111-4111-8111-111111111111';

describe('EmployeesService.update — очищення полів', () => {
  let service: EmployeesService;
  const txUpdate = vi.fn();

  const pipe = (body: Record<string, unknown>) =>
    new ZodValidationPipe<EmployeeUpdateValues>(employeeUpdateSchema).transform(body);

  beforeEach(async () => {
    txUpdate.mockReset().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({
        id: EMP_ID,
        orgId: ORG,
        userId: null,
        firstName: 'Іван',
        lastName: 'Коваль',
        role: 'MECHANIC',
        status: 'ACTIVE',
        rateScheme: null,
        allBranches: false,
        createdAt: new Date('2026-10-01T08:00:00Z'),
        updatedAt: new Date('2026-10-13T08:00:00Z'),
        deletedAt: null,
        employeeZones: [],
        employeeLifts: [],
        employeeWorkCategories: [],
        employeeBranches: [],
        ...data,
      }),
    );
    const tx = { employee: { update: txUpdate }, authAccount: { updateMany: vi.fn() } };
    const prisma = {
      employee: {
        findFirst: vi.fn().mockResolvedValue({ id: EMP_ID, status: 'ACTIVE' }),
        update: vi.fn(),
      },
      authAccount: { updateMany: vi.fn() },
      $transaction: vi.fn((cb: (t: typeof tx) => unknown) => Promise.resolve(cb(tx))),
    };
    const module = await Test.createTestingModule({
      providers: [EmployeesService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(EmployeesService);
  });

  const writtenData = (): Record<string, unknown> =>
    (txUpdate.mock.calls[0]![0] as { data: Record<string, unknown> }).data;

  it.each([['phone'], ['email'], ['dateOfHire'], ['dateOfFire']])(
    "%s: '' з картки → null у employee.update",
    async field => {
      await service.update(ORG, EMP_ID, pipe({ [field]: '' }));
      expect(writtenData()).toHaveProperty(field, null);
    },
  );

  // Review 2026-11-04: дати на clearableString пропускали 'not-a-date' → `new Date(...)` → Prisma 500.
  // Мутація: повернути `clearableString()` датам у employeeUpdateSchema → кейс червоніє.
  it.each([['dateOfHire'], ['dateOfFire']])(
    '%s: не дата → 400 від pipe, у базу нічого не йде',
    field => {
      expect(() => pipe({ [field]: 'not-a-date' })).toThrow(BadRequestException);
      expect(txUpdate).not.toHaveBeenCalled();
    },
  );

  it('телефон очищено (null) — e-mail і дати, яких не чіпали, не потрапляють у data', async () => {
    await service.update(ORG, EMP_ID, pipe({ phone: null }));
    const data = writtenData();
    expect(data).toHaveProperty('phone', null);
    expect('email' in data).toBe(false);
    expect('dateOfHire' in data).toBe(false);
    expect('dateOfFire' in data).toBe(false);
  });
});
