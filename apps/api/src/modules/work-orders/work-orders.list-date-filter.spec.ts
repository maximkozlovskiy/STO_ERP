/**
 * WorkOrdersService.findAll — відбір списку нарядів за датою документа.
 *
 * `documentDate` — дата БЕЗ часу (`@db.Date`): межі `dateFrom` / `dateTo` — самі календарні дати,
 * обидві включні. Зсув на київський пояс (як для міток часу `createdAt`) зачепив би попередній
 * день: `gte 08.10T21:00Z` для колонки-дати — це вже 08.10 (клас Bug #798).
 *
 * Окремий файл, а не `work-orders.service.spec.ts`: той уже на межі гейта розміру (880 рядків,
 * 5 top-level describe). `findAll` торкається лише `this.prisma`, решта залежностей — null.
 *
 * Mutation-verify (2026-10-09): `dateOnlyRangeFilter` → `kyivDayRangeFilter` у `findAll` — обидва
 * кейси з міткою guards падають.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkOrdersService } from './work-orders.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { WorkOrderQueryDto } from './work-orders.dto';

const ORG = '11111111-1111-4111-8111-111111111111';
const baseQuery = { page: 1, limit: 20 } as WorkOrderQueryDto;

describe('WorkOrdersService.findAll — відбір за датою документа', () => {
  let findMany: ReturnType<typeof vi.fn>;
  let count: ReturnType<typeof vi.fn>;
  let service: WorkOrdersService;

  beforeEach(() => {
    findMany = vi.fn().mockResolvedValue([]);
    count = vi.fn().mockResolvedValue(0);
    const prisma = {
      workOrder: { findMany, count },
      // findAll загортає обидва читання у `$transaction([...])` (форма масиву).
      $transaction: vi.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
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
    );
  });

  const where = (call = 0) =>
    (findMany.mock.calls[call]![0] as { where: Record<string, unknown> }).where;

  // guards: BR-PAY-018
  it('dateFrom + dateTo → documentDate від 09.10 до 10.10 календарними датами, без зсуву на пояс', async () => {
    await service.findAll(ORG, {
      ...baseQuery,
      dateFrom: '2026-10-09',
      dateTo: '2026-10-10',
    } as WorkOrderQueryDto);
    expect(where().documentDate).toEqual({
      gte: new Date('2026-10-09T00:00:00.000Z'),
      lte: new Date('2026-10-10T00:00:00.000Z'),
    });
  });

  // guards: BR-PAY-018
  it('лише одна межа → у documentDate тільки вона (зимова дата теж без зсуву)', async () => {
    await service.findAll(ORG, { ...baseQuery, dateFrom: '2026-01-15' } as WorkOrderQueryDto);
    await service.findAll(ORG, { ...baseQuery, dateTo: '2026-01-15' } as WorkOrderQueryDto);
    expect(where(0).documentDate).toEqual({ gte: new Date('2026-01-15T00:00:00.000Z') });
    expect(where(1).documentDate).toEqual({ lte: new Date('2026-01-15T00:00:00.000Z') });
  });

  it('без дат — умови на documentDate немає', async () => {
    await service.findAll(ORG, baseQuery);
    expect(where()).not.toHaveProperty('documentDate');
  });

  it('відбір за датою не чіпає tenant-фільтр: orgId і deletedAt на місці, лічильник отримує той самий where', async () => {
    await service.findAll(ORG, {
      ...baseQuery,
      dateFrom: '2026-10-09',
      dateTo: '2026-10-10',
    } as WorkOrderQueryDto);
    expect(where()).toMatchObject({ orgId: ORG, deletedAt: null });
    expect((count.mock.calls[0]![0] as { where: unknown }).where).toEqual(where());
  });
});
