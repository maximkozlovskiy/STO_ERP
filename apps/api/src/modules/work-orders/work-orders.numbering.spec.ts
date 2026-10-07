import { describe, it, expect, vi } from 'vitest';
import { WorkOrdersService } from './work-orders.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { CreateWorkOrderDto } from './work-orders.dto';

/**
 * Нумерація наряду — аспект «номер дає DocumentNumberService, а не клієнт і не літерал у коді».
 *
 * Контракт-спек мокає весь WorkOrdersService, тож реальні create()/clone() там не виконуються:
 * заміна `docNumbers.next(...)` на рядок-літерал або на номер оригіналу (у clone) пройшла б
 * усі наявні тести. Тут — реальний сервіс на Prisma-моку.
 */

const ORG = '11111111-1111-4111-8111-111111111111';
const BRANCH = '22222222-2222-4222-8222-222222222222';
const VEHICLE = '33333333-3333-4333-8333-333333333333';
const CP = '44444444-4444-4444-8444-444444444444';

/** Рядок, який повертає workOrder.create — рівно стільки, скільки читає toDto. */
function createdRow(number: string) {
  return {
    id: 'wo-new',
    orgId: ORG,
    number,
    status: 'DRAFT',
    priority: 'NORMAL',
    repairCategory: null,
    branchId: BRANCH,
    branch: { name: 'Br' },
    vehicleId: VEHICLE,
    vehicle: { make: 'X', model: 'Y', licensePlate: 'AB1234' },
    counterpartyId: CP,
    counterparty: { firstName: 'Іван', lastName: 'Петров', companyName: null },
    contractId: null,
    contract: null,
    description: null,
    inMileage: null,
    outMileage: null,
    plannedAt: null,
    dueDate: null,
    completedAt: null,
    warrantyUntil: null,
    clientApproval: false,
    totalLabor: 0,
    totalParts: 0,
    totalAmount: 0,
    paidAmount: 0,
    documentDate: new Date('2026-06-04'),
    syncVersion: 0n,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };
}

function setup(originalForClone?: Record<string, unknown>) {
  const create = vi
    .fn()
    .mockImplementation((args: { data: { number: string } }) =>
      Promise.resolve(createdRow(args.data.number)),
    );
  const prisma = {
    workOrder: { create, findFirst: vi.fn().mockResolvedValue(originalForClone ?? null) },
    garageBranch: { findFirst: vi.fn().mockResolvedValue({ id: BRANCH }) },
    vehicle: { findFirst: vi.fn().mockResolvedValue({ id: VEHICLE }) },
    counterparty: { findFirst: vi.fn().mockResolvedValue({ id: CP }) },
    lift: { findFirst: vi.fn().mockResolvedValue(null) },
    counterpartyContract: { findFirst: vi.fn().mockResolvedValue(null) },
  } as unknown as PrismaService;
  const next = vi.fn().mockResolvedValue('НЗ-2026-000042');
  const service = new WorkOrdersService(
    prisma,
    null as never, // stockEffects
    { next } as never, // docNumbers
    null as never, // pdf
    null as never, // audit (userId не передаємо → не викликається)
    null as never, // settingsService
    {
      requireBaseCurrencyId: vi.fn().mockResolvedValue('base-cur-id'),
      resolveBaseConversion: vi.fn(),
    } as never,
    { emit: vi.fn() } as never,
  );
  return { service, create, next };
}

describe('WorkOrdersService — номер наряду з DocumentNumberService', () => {
  // guards: BR-WO-004
  it('create(): номер = DocumentNumberService.next(orgId, WORK_ORDER), рівно один виклик', async () => {
    const { service, create, next } = setup();
    const dto = { branchId: BRANCH, vehicleId: VEHICLE, counterpartyId: CP } as CreateWorkOrderDto;

    const res = await service.create(ORG, dto);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith(ORG, 'WORK_ORDER');
    expect(create.mock.calls[0][0].data.number).toBe('НЗ-2026-000042');
    expect(res.number).toBe('НЗ-2026-000042');
  });

  // guards: BR-WO-004
  it('clone(): клон отримує НОВИЙ номер із DocumentNumberService, а не номер оригіналу', async () => {
    const { service, create, next } = setup({
      number: 'НЗ-2026-000001',
      vehicleId: VEHICLE,
      counterpartyId: CP,
      branchId: BRANCH,
      liftId: null,
      description: null,
      inMileage: null,
      priority: 'NORMAL',
      repairCategory: null,
      dueDate: null,
      plannedHours: null,
      currencyId: null,
      lines: [],
      parts: [],
    });

    await service.clone(ORG, 'wo-orig', undefined as never);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith(ORG, 'WORK_ORDER');
    expect(create.mock.calls[0][0].data.number).toBe('НЗ-2026-000042');
  });
});
