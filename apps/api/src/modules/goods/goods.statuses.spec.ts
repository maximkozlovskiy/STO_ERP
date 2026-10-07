import { describe, it, expect, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { GoodsService } from './goods.service';
import { GoodsController } from './goods.controller';
import type { PrismaService } from '../../prisma/prisma.service';
import type { DocumentNumberService } from '../document-number/document-number.service';
import type { GoodStatusesService } from '../good-statuses/good-statuses.service';

// ─── Аспект: статуси-мітки товару (M:N Good ↔ GoodStatus через GoodStatusLink) ──
//
// Стереже ту частину правила про мітки, що живе в goods-модулі: assign / unassign,
// tenant-ізоляція обох сторін призначення, ідемпотентність, приховування soft-deleted
// статусу в DTO, скидання кешу довідника і ролі на двох endpoint-ах.
// CRUD самого довідника, TTL кешу і restore статусу — у good-statuses.service.spec.ts.

const ORG = 'org-1';
const GOOD_ID = 'good-1';
const STATUS_ID = 'status-1';

const goodRow = {
  id: GOOD_ID,
  orgId: ORG,
  internalCode: 'T-000001',
  sku: 'OIL',
  name: 'Олива',
  unit: 'шт',
  unitId: null,
  brandId: null,
  purchasePrice: new Prisma.Decimal(100),
  salePrice: new Prisma.Decimal(150),
  category: null,
  barcode: null,
  notes: null,
  goodType: null,
  preferredSupplierId: null,
  preferredSupplier: null,
  statusLinks: [{ status: { id: STATUS_ID, name: 'Акція', color: '#ff0000', deletedAt: null } }],
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
};

// Factory, не const: кожен тест отримує власні vi.fn() (isolate:false без clearMocks).
function setup() {
  const prisma = {
    good: { findFirst: vi.fn().mockResolvedValue(goodRow) },
    goodStatus: { findFirst: vi.fn().mockResolvedValue({ id: STATUS_ID }) },
    goodStatusLink: {
      create: vi.fn().mockResolvedValue({ id: 'link-1' }),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const goodStatuses = { invalidateCache: vi.fn().mockResolvedValue(undefined) };
  const service = new GoodsService(
    prisma as unknown as PrismaService,
    { next: vi.fn() } as unknown as DocumentNumberService,
    goodStatuses as unknown as GoodStatusesService,
  );
  return { service, prisma, goodStatuses };
}

describe('GoodsService — статуси-мітки (assign / unassign)', () => {
  // guards: BR-GOOD-006
  it('assign: і товар, і статус шукаються в org запитувача (orgId + deletedAt:null)', async () => {
    const { service, prisma } = setup();
    await service.assignStatus(ORG, GOOD_ID, STATUS_ID);
    // calls[0] — precheck у assignStatus (наступний виклик good.findFirst робить findOne).
    expect(prisma.good.findFirst.mock.calls[0][0].where).toEqual({
      id: GOOD_ID,
      orgId: ORG,
      deletedAt: null,
    });
    expect(prisma.goodStatus.findFirst.mock.calls[0][0].where).toEqual({
      id: STATUS_ID,
      orgId: ORG,
      deletedAt: null,
    });
  });

  // guards: BR-GOOD-006
  it('assign: товар не з цієї org → NotFoundException, link не створюється', async () => {
    const { service, prisma, goodStatuses } = setup();
    prisma.good.findFirst.mockResolvedValueOnce(null);
    await expect(service.assignStatus(ORG, GOOD_ID, STATUS_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.goodStatusLink.create).not.toHaveBeenCalled();
    expect(goodStatuses.invalidateCache).not.toHaveBeenCalled();
  });

  // guards: BR-GOOD-006
  it('assign: статус не з цієї org або soft-deleted → NotFoundException, link не створюється', async () => {
    const { service, prisma, goodStatuses } = setup();
    prisma.goodStatus.findFirst.mockResolvedValueOnce(null);
    await expect(service.assignStatus(ORG, GOOD_ID, STATUS_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.goodStatusLink.create).not.toHaveBeenCalled();
    expect(goodStatuses.invalidateCache).not.toHaveBeenCalled();
  });

  // guards: BR-GOOD-006
  it('assign: створює link {orgId, goodId, statusId} і скидає кеш довідника статусів', async () => {
    const { service, prisma, goodStatuses } = setup();
    const res = await service.assignStatus(ORG, GOOD_ID, STATUS_ID);
    expect(prisma.goodStatusLink.create).toHaveBeenCalledWith({
      data: { orgId: ORG, goodId: GOOD_ID, statusId: STATUS_ID },
    });
    expect(goodStatuses.invalidateCache).toHaveBeenCalledWith(ORG);
    expect(res.statuses).toEqual([{ id: STATUS_ID, name: 'Акція', color: '#ff0000' }]);
  });

  // guards: BR-GOOD-006
  it('assign повторно (P2002 на @@unique[goodId,statusId]) → no-op: без помилки, повертає товар', async () => {
    const { service, prisma } = setup();
    prisma.goodStatusLink.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('unique violation', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    const res = await service.assignStatus(ORG, GOOD_ID, STATUS_ID);
    expect(res.id).toBe(GOOD_ID);
  });

  it('assign: помилка БД, відмінна від P2002, не ковтається', async () => {
    const { service, prisma } = setup();
    prisma.goodStatusLink.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('fk violation', {
        code: 'P2003',
        clientVersion: 'test',
      }),
    );
    await expect(service.assignStatus(ORG, GOOD_ID, STATUS_ID)).rejects.toMatchObject({
      code: 'P2003',
    });
  });

  // guards: BR-GOOD-006
  it('unassign: видаляє link лише в межах org (orgId + goodId + statusId) і скидає кеш', async () => {
    const { service, prisma, goodStatuses } = setup();
    await service.unassignStatus(ORG, GOOD_ID, STATUS_ID);
    expect(prisma.goodStatusLink.deleteMany).toHaveBeenCalledWith({
      where: { orgId: ORG, goodId: GOOD_ID, statusId: STATUS_ID },
    });
    expect(goodStatuses.invalidateCache).toHaveBeenCalledWith(ORG);
  });

  // guards: BR-GOOD-006
  it('unassign неіснуючого призначення → NotFoundException, кеш не чіпається', async () => {
    const { service, prisma, goodStatuses } = setup();
    prisma.goodStatusLink.deleteMany.mockResolvedValueOnce({ count: 0 });
    await expect(service.unassignStatus(ORG, GOOD_ID, STATUS_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(goodStatuses.invalidateCache).not.toHaveBeenCalled();
  });

  // guards: BR-GOOD-006
  it('toDto: soft-deleted статус прихований у statuses, активний лишається', async () => {
    const { service, prisma } = setup();
    prisma.good.findFirst.mockResolvedValueOnce({
      ...goodRow,
      statusLinks: [
        { status: { id: STATUS_ID, name: 'Акція', color: '#ff0000', deletedAt: null } },
        {
          status: {
            id: 'status-2',
            name: 'Розпродаж',
            color: '#00ff00',
            deletedAt: new Date('2026-02-01'),
          },
        },
      ],
    });
    const res = await service.findOne(ORG, GOOD_ID);
    expect(res.statuses).toEqual([{ id: STATUS_ID, name: 'Акція', color: '#ff0000' }]);
  });
});

describe('GoodsController — ролі на статусах-мітках', () => {
  const rolesOf = (method: 'assignStatus' | 'unassignStatus'): string[] =>
    Reflect.getMetadata('roles', GoodsController.prototype[method]);

  // guards: BR-GOOD-006
  it.each(['assignStatus', 'unassignStatus'] as const)(
    '%s — рівно OWNER / ADMIN / STOREKEEPER',
    method => {
      expect([...rolesOf(method)].sort()).toEqual(['ADMIN', 'OWNER', 'STOREKEEPER']);
    },
  );
});
