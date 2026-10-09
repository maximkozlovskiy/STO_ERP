/**
 * SupplierReturnsService.findAll — відбір списку повернень постачальнику за датою документа.
 *
 * `documentDate` — дата БЕЗ часу (`@db.Date`): межі `dateFrom` / `dateTo` — самі календарні дати,
 * обидві включні, без зсуву на київський пояс (він зачепив би попередній день — клас Bug #798).
 *
 * Mutation-verify: `dateOnlyRangeFilter` → `kyivDayRangeFilter` у `findAll` — кейси з датами падають.
 */
import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { SupplierReturnsService } from './supplier-returns.service';
import { PrismaService } from '../../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { SettlementsService } from '../settlements/settlements.service';
import { DocumentNumberService } from '../document-number/document-number.service';

describe('SupplierReturnsService.findAll — відбір за датою документа', () => {
  let service: SupplierReturnsService;
  let prisma: {
    supplierReturn: { findMany: ReturnType<typeof vi.fn>; count: ReturnType<typeof vi.fn> };
  };

  const ORG = 'org-1';

  beforeEach(async () => {
    prisma = {
      supplierReturn: {
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
      },
    };
    const module = await Test.createTestingModule({
      providers: [
        SupplierReturnsService,
        { provide: PrismaService, useValue: prisma },
        { provide: InventoryService, useValue: {} },
        { provide: SettlementsService, useValue: {} },
        { provide: DocumentNumberService, useValue: { next: vi.fn() } },
      ],
    }).compile();
    service = module.get(SupplierReturnsService);
  });

  const list = (dateFrom?: string, dateTo?: string) =>
    service.findAll(ORG, 1, 20, undefined, undefined, false, dateFrom, dateTo);

  const where = (call = 0) =>
    (prisma.supplierReturn.findMany.mock.calls[call]![0] as { where: Record<string, unknown> })
      .where;

  // guards: BR-PAY-018
  it('dateFrom + dateTo → documentDate від 09.10 до 10.10 календарними датами, без зсуву на пояс', async () => {
    await list('2026-10-09', '2026-10-10');
    expect(where().documentDate).toEqual({
      gte: new Date('2026-10-09T00:00:00.000Z'),
      lte: new Date('2026-10-10T00:00:00.000Z'),
    });
  });

  // guards: BR-PAY-018
  it('лише одна межа → у documentDate тільки вона (зимова дата теж без зсуву)', async () => {
    await list('2026-01-15', undefined);
    await list(undefined, '2026-01-15');
    expect(where(0).documentDate).toEqual({ gte: new Date('2026-01-15T00:00:00.000Z') });
    expect(where(1).documentDate).toEqual({ lte: new Date('2026-01-15T00:00:00.000Z') });
  });

  it('без дат — умови на documentDate немає', async () => {
    await list();
    expect(where()).not.toHaveProperty('documentDate');
  });

  it('відбір за датою не чіпає tenant-фільтр: orgId і deletedAt на місці, лічильник отримує той самий where', async () => {
    await list('2026-10-09', '2026-10-10');
    expect(where()).toMatchObject({ orgId: ORG, deletedAt: null });
    expect((prisma.supplierReturn.count.mock.calls[0]![0] as { where: unknown }).where).toEqual(
      where(),
    );
  });
});
