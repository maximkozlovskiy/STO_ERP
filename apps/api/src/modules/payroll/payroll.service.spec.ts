import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PayrollService } from './payroll.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';

const ORG = '11111111-1111-4111-8111-111111111111';
const PID = '22222222-2222-4222-8222-222222222222';

function makeMocks() {
  // compute() runs the aggregates INSIDE the transaction: tx shares the same $queryRaw and
  // employee mocks as prisma, so specs keep asserting on one place.
  const $queryRaw = vi.fn().mockResolvedValue([]);
  const employee = { findMany: vi.fn().mockResolvedValue([]) };
  const tx = {
    payrollPeriod: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    payrollLine: {
      deleteMany: vi.fn(),
      createMany: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({ id: 'line-1' }),
    },
    payrollLineWorkOrder: { deleteMany: vi.fn(), createMany: vi.fn() },
    $executeRaw: vi.fn(),
    $queryRaw,
    employee,
  };
  return {
    tx,
    prisma: {
      payrollPeriod: {
        findFirst: vi.fn(),
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
        create: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      payrollLine: { findMany: vi.fn().mockResolvedValue([]) },
      garageBranch: { findFirst: vi.fn() },
      $queryRaw,
      employee,
      $transaction: vi
        .fn()
        .mockImplementation(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    },
    audit: { record: vi.fn().mockResolvedValue(undefined) },
    cash: { createOperation: vi.fn().mockResolvedValue(undefined) },
  };
}

function makeService(m: ReturnType<typeof makeMocks>): PayrollService {
  return new PayrollService(
    m.prisma as unknown as PrismaService,
    m.audit as unknown as AuditService,
    m.cash as unknown as import('../cash/cash.service').CashService,
  );
}

describe('PayrollService.preview', () => {
  let m: ReturnType<typeof makeMocks>;
  let service: PayrollService;
  beforeEach(() => {
    m = makeMocks();
    service = makeService(m);
  });

  // guards: BR-PAYR-004
  it('агрегує виробіток і рахує accrued за rateScheme', async () => {
    m.prisma.$queryRaw.mockResolvedValueOnce([
      {
        employeeId: 'e1',
        firstName: 'Іван',
        lastName: 'Коваль',
        rateScheme: { type: 'percent_normo', params: { percent: 40 } },
        totalNormoHours: 10,
        totalAmount: 5000,
        linesCount: 3n,
      },
    ]);
    const res = await service.preview(ORG, '2026-09-01', '2026-09-30');
    expect(res.lines).toHaveLength(1);
    expect(res.lines[0].accruedAmount).toBe(2000); // 40% від 5000
    expect(res.totalAccrued).toBe(2000);
  });

  // guards: BR-PAYR-007
  it('невалідна rateScheme → accrued 0, rateSchemeType=unknown', async () => {
    m.prisma.$queryRaw.mockResolvedValueOnce([
      {
        employeeId: 'e1',
        firstName: 'A',
        lastName: 'B',
        rateScheme: { garbage: true },
        totalNormoHours: 10,
        totalAmount: 5000,
        linesCount: 1n,
      },
    ]);
    const res = await service.preview(ORG, '2026-09-01', '2026-09-30');
    expect(res.lines[0].accruedAmount).toBe(0);
    expect(res.lines[0].rateSchemeType).toBe('unknown');
  });

  // guards: BR-PAYR-002
  it('from > to → BadRequest', async () => {
    await expect(service.preview(ORG, '2026-09-30', '2026-09-01')).rejects.toThrow(
      BadRequestException,
    );
  });

  // guards: BR-PAYR-003
  it('branchId не належить org → 404', async () => {
    m.prisma.garageBranch.findFirst.mockResolvedValueOnce(null);
    await expect(service.preview(ORG, '2026-09-01', '2026-09-30', 'bad-branch')).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('PayrollService.compute — FSM', () => {
  let m: ReturnType<typeof makeMocks>;
  let service: PayrollService;
  beforeEach(() => {
    m = makeMocks();
    service = makeService(m);
  });

  // guards: BR-PAYR-009
  it('не-DRAFT → BadRequest (не рахуємо)', async () => {
    m.prisma.payrollPeriod.findFirst.mockResolvedValueOnce({
      id: PID,
      status: 'COMPUTED',
      periodStart: new Date('2026-09-01'),
      periodEnd: new Date('2026-09-30'),
      branchId: null,
    });
    await expect(service.compute(ORG, PID)).rejects.toThrow(BadRequestException);
    expect(m.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('період не знайдено → 404', async () => {
    m.prisma.payrollPeriod.findFirst.mockResolvedValueOnce(null);
    await expect(service.compute(ORG, PID)).rejects.toThrow(NotFoundException);
  });

  // guards: BR-PAYR-009
  it('DRAFT → фіксує lines у транзакції (claim + createMany)', async () => {
    m.prisma.payrollPeriod.findFirst
      .mockResolvedValueOnce({
        id: PID,
        status: 'DRAFT',
        periodStart: new Date('2026-09-01'),
        periodEnd: new Date('2026-09-30'),
        branchId: null,
      })
      .mockResolvedValueOnce({
        id: PID,
        orgId: ORG,
        branchId: null,
        periodStart: new Date('2026-09-01'),
        periodEnd: new Date('2026-09-30'),
        status: 'COMPUTED',
        note: null,
        computedAt: new Date(),
        paidAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        lines: [],
      });
    m.prisma.$queryRaw
      .mockResolvedValueOnce([
        {
          employeeId: 'e1',
          firstName: 'A',
          lastName: 'B',
          rateScheme: { type: 'per_normo_hour', params: { ratePerHour: 100 } },
          totalNormoHours: 5,
          totalAmount: 0,
          linesCount: 1n,
        },
      ])
      .mockResolvedValueOnce([]); // aggregateWorkOrders — розшифровка порожня

    await service.compute(ORG, PID, 'user-1');

    expect(m.tx.payrollPeriod.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: PID, orgId: ORG, status: 'DRAFT' } }),
    );
    expect(m.tx.payrollLine.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ employeeId: 'e1', accruedAmount: 500 }), // 100×5
      }),
    );
  });

  // guards: BR-PAYR-009
  it('DRAFT → фіксує розшифровку по нарядах (snapshot номера/авто)', async () => {
    m.prisma.payrollPeriod.findFirst
      .mockResolvedValueOnce({
        id: PID,
        status: 'DRAFT',
        periodStart: new Date('2026-09-01'),
        periodEnd: new Date('2026-09-30'),
        branchId: null,
      })
      .mockResolvedValueOnce({
        id: PID,
        orgId: ORG,
        branchId: null,
        periodStart: new Date('2026-09-01'),
        periodEnd: new Date('2026-09-30'),
        status: 'COMPUTED',
        note: null,
        computedAt: new Date(),
        paidAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        lines: [],
      });
    m.prisma.$queryRaw
      .mockResolvedValueOnce([
        {
          employeeId: 'e1',
          firstName: 'A',
          lastName: 'B',
          rateScheme: { type: 'percent_normo', params: { percent: 50 } },
          totalNormoHours: 8,
          totalAmount: 4000,
          linesCount: 2n,
        },
      ])
      .mockResolvedValueOnce([
        {
          employeeId: 'e1',
          workOrderId: 'wo-1',
          workOrderNumber: 'WO-2026-0001',
          make: 'Toyota',
          model: 'Camry',
          licensePlate: 'AA1234BB',
          worksCount: 2n,
          normoHours: 8,
          baseAmount: 4000,
        },
      ]);

    await service.compute(ORG, PID, 'user-1');

    expect(m.tx.payrollLineWorkOrder.createMany).toHaveBeenCalledWith({
      data: [
        {
          orgId: ORG,
          payrollLineId: 'line-1',
          workOrderId: 'wo-1',
          workOrderNumber: 'WO-2026-0001',
          vehicleName: 'Toyota Camry · AA1234BB',
          worksCount: 2,
          normoHours: 8,
          baseAmount: 4000,
        },
      ],
    });
  });

  it('null-авто (vehicleId відсутній / make+model+plate порожні) → vehicleName=null (UI показує «—», не «null»)', async () => {
    m.prisma.payrollPeriod.findFirst
      .mockResolvedValueOnce({
        id: PID,
        status: 'DRAFT',
        periodStart: new Date('2026-09-01'),
        periodEnd: new Date('2026-09-30'),
        branchId: null,
      })
      .mockResolvedValueOnce({
        id: PID,
        orgId: ORG,
        branchId: null,
        periodStart: new Date('2026-09-01'),
        periodEnd: new Date('2026-09-30'),
        status: 'COMPUTED',
        note: null,
        computedAt: new Date(),
        paidAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        lines: [],
      });
    m.prisma.$queryRaw
      .mockResolvedValueOnce([
        {
          employeeId: 'e1',
          firstName: 'A',
          lastName: 'B',
          rateScheme: { type: 'percent_normo', params: { percent: 50 } },
          totalNormoHours: 2,
          totalAmount: 1000,
          linesCount: 3n,
        },
      ])
      .mockResolvedValueOnce([
        // wo-null: LEFT JOIN vehicles → make/model/plate усі NULL (наряд без авто)
        {
          employeeId: 'e1',
          workOrderId: 'wo-null',
          workOrderNumber: 'НРД-2026-0100',
          make: null,
          model: null,
          licensePlate: null,
          worksCount: 1n,
          normoHours: 1,
          baseAmount: 400,
        },
        // wo-empty: рядки-порожні make/model/plate (не null, але trim→'') → теж null
        {
          employeeId: 'e1',
          workOrderId: 'wo-empty',
          workOrderNumber: 'НРД-2026-0101',
          make: '  ',
          model: '',
          licensePlate: '   ',
          worksCount: 1n,
          normoHours: 0.5,
          baseAmount: 300,
        },
        // wo-plate: лише номерний знак → показуємо його
        {
          employeeId: 'e1',
          workOrderId: 'wo-plate',
          workOrderNumber: 'НРД-2026-0102',
          make: null,
          model: null,
          licensePlate: 'BC5678HK',
          worksCount: 1n,
          normoHours: 0.5,
          baseAmount: 300,
        },
      ]);

    await service.compute(ORG, PID, 'user-1');

    const data = m.tx.payrollLineWorkOrder.createMany.mock.calls[0]![0].data as {
      workOrderId: string;
      vehicleName: string | null;
    }[];
    const byId = Object.fromEntries(data.map(d => [d.workOrderId, d.vehicleName]));
    expect(byId['wo-null']).toBeNull(); // null, НЕ рядок 'null'
    expect(byId['wo-empty']).toBeNull(); // порожні рядки → null (не «   »)
    expect(byId['wo-plate']).toBe('BC5678HK'); // лише plate
  });

  // guards: BR-PAYR-009
  it('кілька співробітників — розшифровка не «протікає» між рядками (правильний payrollLineId)', async () => {
    m.prisma.payrollPeriod.findFirst
      .mockResolvedValueOnce({
        id: PID,
        status: 'DRAFT',
        periodStart: new Date('2026-09-01'),
        periodEnd: new Date('2026-09-30'),
        branchId: null,
      })
      .mockResolvedValueOnce({
        id: PID,
        orgId: ORG,
        branchId: null,
        periodStart: new Date('2026-09-01'),
        periodEnd: new Date('2026-09-30'),
        status: 'COMPUTED',
        note: null,
        computedAt: new Date(),
        paidAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        lines: [],
      });
    // create() повертає різні lineId по черзі (e1 → line-e1, e2 → line-e2)
    m.tx.payrollLine.create
      .mockResolvedValueOnce({ id: 'line-e1' })
      .mockResolvedValueOnce({ id: 'line-e2' });
    m.prisma.$queryRaw
      .mockResolvedValueOnce([
        {
          employeeId: 'e1',
          firstName: 'A',
          lastName: 'One',
          rateScheme: { type: 'percent_normo', params: { percent: 50 } },
          totalNormoHours: 2,
          totalAmount: 1000,
          linesCount: 1n,
        },
        {
          employeeId: 'e2',
          firstName: 'B',
          lastName: 'Two',
          rateScheme: { type: 'percent_normo', params: { percent: 50 } },
          totalNormoHours: 4,
          totalAmount: 2000,
          linesCount: 1n,
        },
      ])
      .mockResolvedValueOnce([
        {
          employeeId: 'e1',
          workOrderId: 'wo-1',
          workOrderNumber: 'НРД-1',
          make: 'Kia',
          model: null,
          licensePlate: null,
          worksCount: 1n,
          normoHours: 2,
          baseAmount: 1000,
        },
        {
          employeeId: 'e2',
          workOrderId: 'wo-2',
          workOrderNumber: 'НРД-2',
          make: 'Audi',
          model: null,
          licensePlate: null,
          worksCount: 1n,
          normoHours: 4,
          baseAmount: 2000,
        },
      ]);

    await service.compute(ORG, PID, 'user-1');

    // e1 (line-e1) отримує лише wo-1; e2 (line-e2) — лише wo-2. Жодного перехресного лінка.
    const calls = m.tx.payrollLineWorkOrder.createMany.mock.calls.map(
      c => c[0].data as { payrollLineId: string; workOrderId: string }[],
    );
    const e1 = calls.find(d => d[0]?.payrollLineId === 'line-e1');
    const e2 = calls.find(d => d[0]?.payrollLineId === 'line-e2');
    expect(e1).toEqual([
      expect.objectContaining({ payrollLineId: 'line-e1', workOrderId: 'wo-1' }),
    ]);
    expect(e2).toEqual([
      expect.objectContaining({ payrollLineId: 'line-e2', workOrderId: 'wo-2' }),
    ]);
    // жоден рядок e1 не містить wo-2 і навпаки
    expect(e1!.some(d => d.workOrderId === 'wo-2')).toBe(false);
    expect(e2!.some(d => d.workOrderId === 'wo-1')).toBe(false);
  });

  it('перерахунок: видаляє стару розшифровку ПЕРЕД рядками (FK RESTRICT)', async () => {
    m.prisma.payrollPeriod.findFirst
      .mockResolvedValueOnce({
        id: PID,
        status: 'DRAFT',
        periodStart: new Date('2026-09-01'),
        periodEnd: new Date('2026-09-30'),
        branchId: null,
      })
      .mockResolvedValueOnce({
        id: PID,
        orgId: ORG,
        branchId: null,
        periodStart: new Date('2026-09-01'),
        periodEnd: new Date('2026-09-30'),
        status: 'COMPUTED',
        note: null,
        computedAt: new Date(),
        paidAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        lines: [],
      });
    m.tx.payrollLine.findMany.mockResolvedValueOnce([{ id: 'old-line-1' }]);
    m.prisma.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    await service.compute(ORG, PID, 'user-1');

    expect(m.tx.payrollLineWorkOrder.deleteMany).toHaveBeenCalledWith({
      where: { orgId: ORG, payrollLineId: { in: ['old-line-1'] } },
    });
    // порядок: спершу діти, потім батьківські рядки
    expect(m.tx.payrollLineWorkOrder.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
      m.tx.payrollLine.deleteMany.mock.invocationCallOrder[0],
    );
  });

  // guards: BR-PAYR-009
  it('claim програв гонку (count=0) → BadRequest', async () => {
    m.prisma.payrollPeriod.findFirst.mockResolvedValueOnce({
      id: PID,
      status: 'DRAFT',
      periodStart: new Date('2026-09-01'),
      periodEnd: new Date('2026-09-30'),
      branchId: null,
    });
    m.tx.payrollPeriod.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(service.compute(ORG, PID)).rejects.toThrow(BadRequestException);
  });
});

describe('PayrollService.pay — FSM', () => {
  let m: ReturnType<typeof makeMocks>;
  let service: PayrollService;
  beforeEach(() => {
    m = makeMocks();
    service = makeService(m);
  });

  // guards: BR-PAYR-010
  it('не-COMPUTED → BadRequest', async () => {
    m.prisma.payrollPeriod.findFirst.mockResolvedValueOnce({ id: PID, status: 'DRAFT' });
    await expect(service.pay(ORG, PID)).rejects.toThrow(BadRequestException);
  });

  // guards: BR-PAYR-010
  it('COMPUTED → PAID (updateMany claim + paidAmount=accrued)', async () => {
    m.prisma.payrollPeriod.findFirst
      .mockResolvedValueOnce({ id: PID, status: 'COMPUTED' })
      .mockResolvedValueOnce({
        id: PID,
        orgId: ORG,
        branchId: null,
        periodStart: new Date('2026-09-01'),
        periodEnd: new Date('2026-09-30'),
        status: 'PAID',
        note: null,
        computedAt: new Date(),
        paidAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
        lines: [],
      });
    await service.pay(ORG, PID, 'user-1');
    expect(m.tx.payrollPeriod.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: PID, orgId: ORG, status: 'COMPUTED' } }),
    );
    expect(m.tx.$executeRaw).toHaveBeenCalled();
  });

  // guards: BR-PAYR-011
  it('cashRegisterId → cash-out OUT/PAYROLL по кожному співробітнику (amount>0)', async () => {
    m.prisma.payrollPeriod.findFirst
      .mockResolvedValueOnce({ id: PID, status: 'COMPUTED' })
      .mockResolvedValueOnce({
        id: PID,
        orgId: ORG,
        branchId: null,
        periodStart: new Date('2026-09-01'),
        periodEnd: new Date('2026-09-30'),
        status: 'PAID',
        note: null,
        computedAt: new Date(),
        paidAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
        lines: [],
      });
    m.prisma.payrollLine.findMany.mockResolvedValueOnce([
      { employeeId: 'e1', accruedAmount: 300 },
      { employeeId: 'e2', accruedAmount: 0 }, // 0 → пропускається (amount<=0 continue)
      { employeeId: 'e3', accruedAmount: 200 },
    ]);

    await service.pay(ORG, PID, 'user-1', 'reg-1');

    // Дві виплати (e1, e3) — нульова e2 пропущена. Кожна OUT/PAYROLL у ту саму tx.
    expect(m.cash.createOperation).toHaveBeenCalledTimes(2);
    const [, firstInput, firstTx] = m.cash.createOperation.mock.calls[0]!;
    expect(firstInput).toMatchObject({
      cashRegisterId: 'reg-1',
      direction: 'OUT',
      amount: 300,
      reason: 'PAYROLL',
      employeeId: 'e1',
      documentType: 'PayrollPeriod',
      documentId: PID,
    });
    expect(firstTx).toBe(m.tx); // ЄДИНА транзакція — cash-out бачить paidAmount claim
  });

  // guards: BR-PAYR-011
  it('overdraft на N-му співробітнику → весь період відкат (createOperation throw пропагується, не проковтнутий)', async () => {
    m.prisma.payrollPeriod.findFirst.mockResolvedValueOnce({ id: PID, status: 'COMPUTED' });
    m.prisma.payrollLine.findMany.mockResolvedValueOnce([
      { employeeId: 'e1', accruedAmount: 300 },
      { employeeId: 'e2', accruedAmount: 300 }, // перевищить залишок → guard кине
    ]);
    // Перший OUT ок, другий — недостатньо готівки (overdraft-guard у CashService).
    m.cash.createOperation
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new BadRequestException('Недостатньо готівки в касі'));

    await expect(service.pay(ORG, PID, 'user-1', 'reg-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    // Обидві спроби зроблені; помилка НЕ проковтнута → $transaction відкотить claim (period лишається COMPUTED).
    expect(m.cash.createOperation).toHaveBeenCalledTimes(2);
  });
});

describe('PayrollService.remove — guard', () => {
  let m: ReturnType<typeof makeMocks>;
  let service: PayrollService;
  beforeEach(() => {
    m = makeMocks();
    service = makeService(m);
  });

  // guards: BR-PAYR-012
  it('PAID не видаляється → BadRequest', async () => {
    m.prisma.payrollPeriod.findFirst.mockResolvedValueOnce({ status: 'PAID' });
    await expect(service.remove(ORG, PID)).rejects.toThrow(BadRequestException);
    expect(m.prisma.payrollPeriod.updateMany).not.toHaveBeenCalled();
  });

  // guards: BR-PAYR-012
  it('COMPUTED видаляється (ще не виплачено) → soft-delete', async () => {
    m.prisma.payrollPeriod.findFirst.mockResolvedValueOnce({ status: 'COMPUTED' });
    await service.remove(ORG, PID, 'user-1');
    expect(m.prisma.payrollPeriod.updateMany).toHaveBeenCalledWith({
      where: { id: PID, orgId: ORG, deletedAt: null },
      data: { deletedAt: expect.any(Date) },
    });
  });

  // guards: BR-PAYR-012
  it('DRAFT → soft-delete', async () => {
    m.prisma.payrollPeriod.findFirst.mockResolvedValueOnce({ status: 'DRAFT' });
    await service.remove(ORG, PID, 'user-1');
    expect(m.prisma.payrollPeriod.updateMany).toHaveBeenCalledWith({
      where: { id: PID, orgId: ORG, deletedAt: null },
      data: { deletedAt: expect.any(Date) },
    });
  });
});

describe('PayrollService.findOne — розшифровка (toDto)', () => {
  let m: ReturnType<typeof makeMocks>;
  let service: PayrollService;
  beforeEach(() => {
    m = makeMocks();
    service = makeService(m);
  });

  it('не знайдено → 404', async () => {
    m.prisma.payrollPeriod.findFirst.mockResolvedValueOnce(null);
    await expect(service.findOne(ORG, PID)).rejects.toThrow(NotFoundException);
  });

  it('workOrders із null vehicleName серіалізуються як null (не рядок «null»); baseAmount — Number', async () => {
    m.prisma.payrollPeriod.findFirst.mockResolvedValueOnce({
      id: PID,
      orgId: ORG,
      branchId: null,
      periodStart: new Date('2026-09-01'),
      periodEnd: new Date('2026-09-30'),
      status: 'COMPUTED',
      note: null,
      computedAt: new Date(),
      paidAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      lines: [
        {
          employeeId: 'e1',
          rateSchemeType: 'percent_normo',
          baseAmount: { toString: () => '700' } as never, // Prisma.Decimal-подібний
          normoHours: 1.5,
          linesCount: 2,
          accruedAmount: { toString: () => '350' } as never,
          paidAmount: { toString: () => '0' } as never,
          employee: { firstName: 'Іван', lastName: 'Коваль' },
          workOrders: [
            {
              workOrderId: 'wo-null',
              workOrderNumber: 'НРД-2026-0100',
              vehicleName: null, // наряд без авто
              worksCount: 1,
              normoHours: 1,
              baseAmount: { toString: () => '400' } as never,
            },
            {
              workOrderId: 'wo-2',
              workOrderNumber: 'НРД-2026-0101',
              vehicleName: 'Toyota Camry · AA1234BB',
              worksCount: 1,
              normoHours: 0.5,
              baseAmount: { toString: () => '300' } as never,
            },
          ],
        },
      ],
    });

    const dto = await service.findOne(ORG, PID);
    const wos = dto.lines![0].workOrders!;
    expect(wos).toHaveLength(2);
    expect(wos[0].vehicleName).toBeNull(); // null зберігається (JSON null → UI «—»)
    expect(wos[1].vehicleName).toBe('Toyota Camry · AA1234BB');
    expect(wos[0].baseAmount).toBe(400); // Number, не Decimal-обʼєкт
    // Інваріант розшифровки: Σ workOrders.baseAmount === line.baseAmount (tfoot «Разом база» сходиться)
    const sumWo = wos.reduce((s, w) => s + w.baseAmount, 0);
    expect(sumWo).toBe(dto.lines![0].baseAmount);
  });

  it('старий період (розраховано до фічі): workOrders=[] → пуста розшифровка, а не падіння', async () => {
    m.prisma.payrollPeriod.findFirst.mockResolvedValueOnce({
      id: PID,
      orgId: ORG,
      branchId: null,
      periodStart: new Date('2026-09-01'),
      periodEnd: new Date('2026-09-30'),
      status: 'COMPUTED',
      note: null,
      computedAt: new Date(),
      paidAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      lines: [
        {
          employeeId: 'e1',
          rateSchemeType: 'fixed_plus_bonus',
          baseAmount: { toString: () => '0' } as never,
          normoHours: 0,
          linesCount: 0,
          accruedAmount: { toString: () => '5000' } as never,
          paidAmount: { toString: () => '0' } as never,
          employee: { firstName: 'Іван', lastName: 'Коваль' },
          workOrders: [], // немає snapshot-рядків
        },
      ],
    });

    const dto = await service.findOne(ORG, PID);
    // workOrders присутнє й порожнє → UI показує breakdown.empty (не спінер, не краш)
    expect(dto.lines![0].workOrders).toEqual([]);
    // accrued лишається (fixed-схема нарахувала попри 0 нарядів)
    expect(dto.lines![0].accruedAmount).toBe(5000);
  });
});

describe('PayrollService.findAll — пагінація + фільтр статусу', () => {
  let m: ReturnType<typeof makeMocks>;
  let service: PayrollService;
  beforeEach(() => {
    m = makeMocks();
    service = makeService(m);
  });

  function periodRow(over: Record<string, unknown> = {}) {
    return {
      id: PID,
      orgId: ORG,
      branchId: null,
      periodStart: new Date('2026-09-01'),
      periodEnd: new Date('2026-09-30'),
      status: 'COMPUTED',
      note: null,
      computedAt: new Date(),
      paidAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      lines: [],
      ...over,
    };
  }

  it('повертає контракт usePaginatedList { items, total, page, limit }', async () => {
    m.prisma.payrollPeriod.findMany.mockResolvedValueOnce([periodRow()]);
    m.prisma.payrollPeriod.count.mockResolvedValueOnce(57);

    const res = await service.findAll(ORG, 2, 20);
    expect(res.items).toHaveLength(1);
    expect(res.total).toBe(57);
    expect(res.page).toBe(2);
    expect(res.limit).toBe(20);
  });

  it('page/limit → skip/take у Prisma (друга сторінка по 20 → skip 20)', async () => {
    await service.findAll(ORG, 2, 20);
    const args = m.prisma.payrollPeriod.findMany.mock.calls[0][0];
    expect(args.skip).toBe(20);
    expect(args.take).toBe(20);
    // Порядок стабільний: щойно створені першими (createdAt — первинний ключ), щоб новий
    // період не «тонув» на останній сторінці через periodStart у минулому.
    expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { periodStart: 'desc' }]);
  });

  it('дефолти без аргументів → page 1, limit 20, skip 0', async () => {
    const res = await service.findAll(ORG);
    const args = m.prisma.payrollPeriod.findMany.mock.calls[0][0];
    expect(args.skip).toBe(0);
    expect(args.take).toBe(20);
    expect(res.page).toBe(1);
    expect(res.limit).toBe(20);
  });

  // guards: BR-PAYR-013
  it('фільтр статусу попадає у where ОБОХ запитів (findMany + count)', async () => {
    await service.findAll(ORG, 1, 20, 'PAID');
    const findArgs = m.prisma.payrollPeriod.findMany.mock.calls[0][0];
    const countArgs = m.prisma.payrollPeriod.count.mock.calls[0][0];
    expect(findArgs.where).toEqual({ orgId: ORG, deletedAt: null, status: 'PAID' });
    // total має рахуватись по ТОМУ Ж where — інакше пагінація бреше.
    expect(countArgs.where).toEqual(findArgs.where);
  });

  // guards: BR-PAYR-013
  it('без статусу → where лише tenant + soft-delete (без status)', async () => {
    await service.findAll(ORG);
    const findArgs = m.prisma.payrollPeriod.findMany.mock.calls[0][0];
    expect(findArgs.where).toEqual({ orgId: ORG, deletedAt: null });
    expect(findArgs.where).not.toHaveProperty('status');
  });

  // guards: BR-PAYR-013
  it('tenant isolation + soft delete: кожен запит фільтрується по orgId і deletedAt=null', async () => {
    await service.findAll(ORG, 3, 50, 'DRAFT');
    for (const call of [
      m.prisma.payrollPeriod.findMany.mock.calls[0][0],
      m.prisma.payrollPeriod.count.mock.calls[0][0],
    ]) {
      expect(call.where.orgId).toBe(ORG);
      expect(call.where.deletedAt).toBeNull();
    }
  });

  it('список НЕ вантажить workOrders (важко) — лише lines+employee; розшифровку дає findOne', async () => {
    await service.findAll(ORG);
    const args = m.prisma.payrollPeriod.findMany.mock.calls[0][0];
    expect(args.include.lines.include).toEqual({
      employee: { select: { firstName: true, lastName: true } },
    });
    expect(JSON.stringify(args.include)).not.toContain('workOrders');
  });

  it('сміттєвий page/limit (NaN) не просочується у skip/take', async () => {
    await service.findAll(ORG, Number.NaN, Number.NaN);
    const args = m.prisma.payrollPeriod.findMany.mock.calls[0][0];
    expect(Number.isNaN(args.skip)).toBe(false);
    expect(Number.isNaN(args.take)).toBe(false);
    expect(args.skip).toBe(0);
    expect(args.take).toBe(20);
  });

  it('page нормалізується: page=0/-5 → 1 у відповіді (Pagination не малює хибний стан)', async () => {
    const zero = await service.findAll(ORG, 0, 20);
    expect(zero.page).toBe(1);
    const neg = await service.findAll(ORG, -5, 20);
    expect(neg.page).toBe(1);
  });

  it('limit понад MAX_PAGE_SIZE обрізається (DoS-guard) і повертається у відповіді', async () => {
    const res = await service.findAll(ORG, 1, 10_000);
    expect(res.limit).toBe(200);
    const args = m.prisma.payrollPeriod.findMany.mock.calls[0][0];
    expect(args.take).toBe(200);
  });

  it('порожня сторінка → items=[], total=0 (а не падіння)', async () => {
    m.prisma.payrollPeriod.findMany.mockResolvedValueOnce([]);
    m.prisma.payrollPeriod.count.mockResolvedValueOnce(0);
    const res = await service.findAll(ORG, 1, 20, 'CANCELLED');
    expect(res.items).toEqual([]);
    expect(res.total).toBe(0);
  });
});
