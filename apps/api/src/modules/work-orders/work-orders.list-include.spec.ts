/**
 * WorkOrdersService.findAll з `?include=lines,parts` — синхронізація планшета механіка.
 *
 * Мобільний застосунок тягне `/work-orders?limit=100&include=lines,parts`, а API такого параметра
 * не знав: ValidationPipe відповідав 400 «Поле "include" недозволене», і планшет не отримував
 * жодного наряду. Тепер список віддає рядки й запчастини у формі картки, але лише на запит.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import { WorkOrdersService } from './work-orders.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { WorkOrderQueryDto } from './work-orders.dto';

const ORG = '11111111-1111-4111-8111-111111111111';
const baseQuery = { page: 1, limit: 100 } as WorkOrderQueryDto;
const dec = (n: number) => new Prisma.Decimal(n);

const woRow = () => ({
  id: 'wo-1',
  orgId: ORG,
  number: 'НРД-1',
  status: 'IN_PROGRESS',
  priority: 'NORMAL',
  branchId: 'br-1',
  vehicleId: 'veh-1',
  counterpartyId: 'cp-1',
  vehicle: { make: 'Toyota', model: 'Corolla', licensePlate: 'AA0001AA' },
  counterparty: { firstName: 'Іван', lastName: 'Петренко', companyName: null },
  clientApproval: false,
  totalLabor: dec(500),
  totalParts: dec(200),
  totalNet: dec(700),
  totalAmount: dec(700),
  totalVat: dec(0),
  paidAmount: dec(0),
  createdAt: new Date('2026-10-22T08:00:00Z'),
  updatedAt: new Date('2026-10-22T08:00:00Z'),
  lines: [
    {
      id: 'line-1',
      workOrderId: 'wo-1',
      workId: 'work-1',
      employeeId: 'emp-1',
      liftId: null,
      normoHours: 1,
      actualHours: null,
      price: dec(500),
      amount: dec(500),
      notes: null,
      createdAt: new Date('2026-10-22T08:00:00Z'),
      work: { name: 'Заміна оливи' },
      employee: { firstName: 'Олег', lastName: 'Механік' },
    },
  ],
  parts: [
    {
      id: 'part-1',
      workOrderId: 'wo-1',
      goodId: 'good-1',
      warehouseId: 'wh-1',
      quantity: 1,
      price: dec(200),
      amount: dec(200),
      batchCostPrice: dec(120),
      unitOfMeasureId: null,
      createdAt: new Date('2026-10-22T08:00:00Z'),
      good: { name: 'Фільтр', unit: 'шт', unitOfMeasure: null },
    },
  ],
});

describe('WorkOrdersService.findAll — рядки й запчастини для планшета (?include=)', () => {
  let findMany: ReturnType<typeof vi.fn>;
  let service: WorkOrdersService;

  beforeEach(() => {
    findMany = vi.fn().mockResolvedValue([woRow()]);
    const prisma = {
      workOrder: { findMany, count: vi.fn().mockResolvedValue(1) },
    } as unknown as PrismaService;
    service = new WorkOrdersService(
      prisma,
      null as never, // stockEffects
      null as never, // docNumbers
      null as never, // pdf
      null as never, // audit
      null as never, // settingsService
      null as never, // exchangeRates
      null as never, // events
      null as never, // totals
      null as never, // orgPrintInfo
      null as never, // calendar
    );
  });

  const include = () =>
    (findMany.mock.calls[0]![0] as { include: Record<string, unknown> }).include;

  it('include=lines,parts → невидалені рядки й запчастини наряду у формі картки', async () => {
    const res = await service.findAll(ORG, {
      ...baseQuery,
      include: ['lines', 'parts'],
    } as WorkOrderQueryDto);
    expect(include().lines).toMatchObject({ where: { deletedAt: null } });
    expect(include().parts).toMatchObject({ where: { deletedAt: null } });
    const [item] = res.items;
    expect(item!.vehicleSummary).toBe('Toyota Corolla (AA0001AA)');
    expect(item!.lines).toEqual([
      expect.objectContaining({
        id: 'line-1',
        workName: 'Заміна оливи',
        normoHours: 1,
        price: 500,
        amount: 500,
      }),
    ]);
    expect(item!.parts).toEqual([
      expect.objectContaining({ id: 'part-1', goodName: 'Фільтр', quantity: 1, amount: 200 }),
    ]);
  });

  it('собівартість запчастини у списку не віддається нікому', async () => {
    const res = await service.findAll(ORG, {
      ...baseQuery,
      include: ['parts'],
    } as WorkOrderQueryDto);
    expect(res.items[0]!.parts![0]!.costPrice ?? null).toBeNull();
    expect(res.items[0]!.lines).toBeUndefined();
  });

  it('без include список такий, як був: рядків і запчастин немає ні в запиті, ні у відповіді', async () => {
    const res = await service.findAll(ORG, baseQuery);
    expect(include()).not.toHaveProperty('lines');
    expect(include()).not.toHaveProperty('parts');
    expect(res.items[0]).not.toHaveProperty('lines');
    expect(res.items[0]).not.toHaveProperty('parts');
  });
});
