import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkOrdersService } from './work-orders.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { WorkOrderQueryDto } from './work-orders.dto';

// ─── Query-shape regression spec (Bug #163 / #171 pattern) ────────────────────
//
// The contract spec mocks the whole WorkOrdersService (`useValue: serviceMock`),
// so it NEVER executes the real `findAll` Prisma query — a regression in the
// `calendarSlots` relation name (plural→singular), the `take: 1` cap, the soft-delete
// filter, or the nested counterparty search relations would pass every test and
// only blow up at runtime as a PrismaClientValidationError.
//
// This spec drives the REAL findAll against a Prisma mock-spy and asserts the
// exact `findMany`/`count` argument shape that the calendar "next slot" badge and
// the `?q=` search depend on.

const ORG = '11111111-1111-4111-8111-111111111111';

function makePrismaSpy() {
  const findMany = vi.fn().mockResolvedValue([]);
  const count = vi.fn().mockResolvedValue(0);
  const prisma = {
    workOrder: { findMany, count },
    // findAll wraps the two reads in `$transaction([...])` (array form) — execute the array.
    $transaction: vi.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  } as unknown as PrismaService;
  return { prisma, findMany, count };
}

function makeService(prisma: PrismaService): WorkOrdersService {
  // findAll only touches `this.prisma`; the other 9 deps are unused on this path.
  return new WorkOrdersService(
    prisma,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
  );
}

const baseQuery: WorkOrderQueryDto = { page: 1, limit: 20 } as WorkOrderQueryDto;

describe('WorkOrdersService.findAll — query shape', () => {
  let prisma: PrismaService;
  let findMany: ReturnType<typeof vi.fn>;
  let count: ReturnType<typeof vi.fn>;
  let service: WorkOrdersService;

  beforeEach(() => {
    ({ prisma, findMany, count } = makePrismaSpy());
    service = makeService(prisma);
  });

  it('includes calendarSlots with the correct relation name, soft-delete filter, asc order and take:1', async () => {
    await service.findAll(ORG, baseQuery);

    expect(findMany).toHaveBeenCalledTimes(1);
    const arg = findMany.mock.calls[0][0];

    // Relation name MUST be the plural `calendarSlots` (matches Prisma WorkOrder.calendarSlots).
    // Guard against a regression back to a singular/renamed relation → PrismaClientValidationError.
    expect(arg.include).toHaveProperty('calendarSlots');
    expect(arg.include).not.toHaveProperty('calendarSlot');

    const slots = arg.include.calendarSlots;
    expect(slots.where).toEqual({ deletedAt: null }); // only live slots feed the badge
    expect(slots.orderBy).toEqual({ startAt: 'asc' }); // earliest slot first
    expect(slots.take).toBe(1); // single round-trip — never load the whole history
    expect(slots.select).toMatchObject({
      startAt: true,
      endAt: true,
      lift: { select: { name: true } },
    });
  });

  it('scopes to org and excludes soft-deleted work orders by default', async () => {
    await service.findAll(ORG, baseQuery);
    const where = findMany.mock.calls[0][0].where;
    expect(where.orgId).toBe(ORG);
    expect(where.deletedAt).toBeNull();
    // count() must use the SAME where (pagination total stays consistent with the page)
    expect(count.mock.calls[0][0].where).toEqual(where);
  });

  it('?q= search targets number + nested counterparty relations (insensitive)', async () => {
    await service.findAll(ORG, { ...baseQuery, q: 'AB-1' } as WorkOrderQueryDto);
    const or = findMany.mock.calls[0][0].where.OR;
    expect(Array.isArray(or)).toBe(true);
    expect(or).toContainEqual({ number: { contains: 'AB-1', mode: 'insensitive' } });
    // Nested counterparty relations must be addressed by the real relation key.
    expect(or).toContainEqual({
      counterparty: { companyName: { contains: 'AB-1', mode: 'insensitive' } },
    });
    expect(or).toContainEqual({
      counterparty: { lastName: { contains: 'AB-1', mode: 'insensitive' } },
    });
    expect(or).toContainEqual({
      counterparty: { firstName: { contains: 'AB-1', mode: 'insensitive' } },
    });
  });

  it('employeeId filter uses a soft-delete-aware `some` correlated subquery on lines', async () => {
    const empId = '22222222-2222-4222-8222-222222222222';
    await service.findAll(ORG, { ...baseQuery, employeeId: empId } as WorkOrderQueryDto);
    const where = findMany.mock.calls[0][0].where;
    expect(where.lines).toEqual({ some: { employeeId: empId, deletedAt: null } });
  });
});
