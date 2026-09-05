import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { EmployeesService } from './employees.service';
import { PrismaService } from '../../prisma/prisma.service';

// ─── Regression spec — remove() cascade guard (MD-H1 клас) ─────────────────────
//
// remove() раніше soft-deletiв співробітника без перевірки активних нарядів.
// Звільнення механіка, призначеного на відкриті наряди (WorkOrderLine у нарядах
// зі статусом notIn [ARCHIVED, CANCELLED]), лишало осиротілу ланку: наряд далі
// посилався на мертвого виконавця. Guard блокує таке видалення (симетрично до
// counterparty MD-H1).

describe('EmployeesService.remove — cascade guard (active work orders)', () => {
  let service: EmployeesService;
  let prisma: {
    workOrderLine: any;
    employee: any;
    authAccount: any;
    $transaction: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    prisma = {
      workOrderLine: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
      employee: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      authAccount: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      $transaction: vi
        .fn()
        .mockImplementation(async (cb: (tx: typeof prisma) => Promise<unknown>) => cb(prisma)),
    };

    const module = await Test.createTestingModule({
      providers: [EmployeesService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get(EmployeesService);
  });

  it('блокує звільнення співробітника з активним нарядом → BadRequestException, БЕЗ soft-delete', async () => {
    prisma.workOrderLine.findFirst.mockResolvedValueOnce({ id: 'line-1' });

    await expect(service.remove('org-1', 'emp-1')).rejects.toThrow(BadRequestException);

    // Проти старого коду (без guard) $transaction/employee.updateMany викликались би.
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.employee.updateMany).not.toHaveBeenCalled();
    // guard виключає термінальні наряди (ARCHIVED/CANCELLED) та soft-deleted
    expect(prisma.workOrderLine.findFirst).toHaveBeenCalledWith({
      where: {
        orgId: 'org-1',
        employeeId: 'emp-1',
        deletedAt: null,
        workOrder: { deletedAt: null, status: { notIn: ['ARCHIVED', 'CANCELLED'] } },
      },
      select: { id: true },
    });
  });

  it('дозволяє звільнення співробітника без активних нарядів (soft-delete + каскад AuthAccount)', async () => {
    prisma.workOrderLine.findFirst.mockResolvedValueOnce(null);
    prisma.employee.updateMany.mockResolvedValueOnce({ count: 1 });

    await service.remove('org-1', 'emp-free');

    expect(prisma.employee.updateMany).toHaveBeenCalledWith({
      where: { id: 'emp-free', orgId: 'org-1', deletedAt: null },
      data: { deletedAt: expect.any(Date) },
    });
    // каскад на AuthAccount
    expect(prisma.authAccount.updateMany).toHaveBeenCalled();
  });

  it('співробітник не існує (guard пройдено, updateMany count=0) → NotFoundException', async () => {
    prisma.workOrderLine.findFirst.mockResolvedValueOnce(null);
    prisma.employee.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(service.remove('org-1', 'emp-missing')).rejects.toThrow(NotFoundException);
  });
});
