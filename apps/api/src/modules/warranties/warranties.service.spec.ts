import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { WarrantiesService } from './warranties.service';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Bug #249: unit-покриття `WarrantiesService.claim()`.
 *
 * Фокус — захист defense-in-depth, доданий у `ffe3f07`:
 *   • `updateMany({ where: { id, orgId, deletedAt: null } })` замість `update`
 *   • `findFirstOrThrow({ where: { id, orgId } })` для повернення updated DTO
 *
 * Без цього spec будь-який майбутній refactor що повертає простий
 * `prisma.warranty.update({ where: { id } })` пройде CI зеленим — захист
 * від cross-tenant write-у мовчки зникне.
 */
describe('WarrantiesService.claim', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let service: WarrantiesService;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;

  const orgId = 'org-1';
  const warrantyId = 'wty-1';
  const claimWoId = 'claim-wo-1';

  const futureDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // +30 days
  const pastDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // -30 days

  const validWarranty = {
    id: warrantyId,
    orgId,
    workOrderId: 'wo-1',
    workOrderLineId: null,
    workOrderPartId: null,
    counterpartyId: 'cp-1',
    expiresAt: futureDate,
    description: 'Тестова гарантія',
    claimedAt: null,
    claimWoId: null,
    deletedAt: null,
    createdAt: new Date(),
  };

  const validClaimWo = { id: claimWoId, orgId };

  beforeEach(async () => {
    prisma = {
      warranty: {
        findFirst: vi.fn(),
        findFirstOrThrow: vi.fn(),
        updateMany: vi.fn(),
        update: vi.fn(),
      },
      workOrder: {
        findFirst: vi.fn(),
      },
    };
    const module = await Test.createTestingModule({
      providers: [WarrantiesService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(WarrantiesService);
  });

  it('happy path: викликає updateMany із commit-where { id, orgId, deletedAt: null } і повертає DTO', async () => {
    prisma.warranty.findFirst.mockResolvedValueOnce(validWarranty);
    prisma.workOrder.findFirst.mockResolvedValueOnce(validClaimWo);
    prisma.warranty.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.warranty.findFirstOrThrow.mockResolvedValueOnce({
      ...validWarranty,
      claimedAt: new Date(),
      claimWoId,
      workOrder: { number: 'WO-100' },
      counterparty: { companyName: 'ТОВ Тест', firstName: null, lastName: null },
    });

    const result = await service.claim(orgId, warrantyId, { claimWoId });

    // Bug #249: defense-in-depth — `updateMany` має мати `orgId` і `deletedAt: null` у where.
    expect(prisma.warranty.updateMany).toHaveBeenCalledTimes(1);
    const updateArgs = prisma.warranty.updateMany.mock.calls[0][0];
    expect(updateArgs.where.id).toBe(warrantyId);
    expect(updateArgs.where.orgId).toBe(orgId);
    expect(updateArgs.where.deletedAt).toBe(null);
    expect(updateArgs.data.claimWoId).toBe(claimWoId);
    expect(updateArgs.data.claimedAt).toBeInstanceOf(Date);

    // Bug #249: НЕ викликати простий update — щоб refactor назад до { where: { id } } зламав тест.
    expect(prisma.warranty.update).not.toHaveBeenCalled();

    // findFirstOrThrow теж має включати orgId guard.
    expect(prisma.warranty.findFirstOrThrow).toHaveBeenCalledTimes(1);
    const reReadArgs = prisma.warranty.findFirstOrThrow.mock.calls[0][0];
    expect(reReadArgs.where.id).toBe(warrantyId);
    expect(reReadArgs.where.orgId).toBe(orgId);

    expect(result.id).toBe(warrantyId);
    expect(result.claimWoId).toBe(claimWoId);
    expect(result.claimedAt).not.toBeNull();
  });

  it('cross-tenant warranty (findFirst → null) → NotFoundException; updateMany НЕ викликаний', async () => {
    prisma.warranty.findFirst.mockResolvedValueOnce(null);
    prisma.workOrder.findFirst.mockResolvedValueOnce(validClaimWo);

    await expect(service.claim(orgId, warrantyId, { claimWoId })).rejects.toBeInstanceOf(
      NotFoundException,
    );

    expect(prisma.warranty.updateMany).not.toHaveBeenCalled();
    expect(prisma.warranty.update).not.toHaveBeenCalled();
  });

  it('cross-tenant claimWo (workOrder.findFirst → null) → NotFoundException; updateMany НЕ викликаний', async () => {
    prisma.warranty.findFirst.mockResolvedValueOnce(validWarranty);
    prisma.workOrder.findFirst.mockResolvedValueOnce(null);

    await expect(service.claim(orgId, warrantyId, { claimWoId })).rejects.toBeInstanceOf(
      NotFoundException,
    );

    expect(prisma.warranty.updateMany).not.toHaveBeenCalled();
  });

  it('повторне використання вже claimed гарантії → BadRequestException', async () => {
    prisma.warranty.findFirst.mockResolvedValueOnce({
      ...validWarranty,
      claimedAt: new Date(),
      claimWoId: 'other-wo',
    });
    prisma.workOrder.findFirst.mockResolvedValueOnce(validClaimWo);

    await expect(service.claim(orgId, warrantyId, { claimWoId })).rejects.toBeInstanceOf(
      BadRequestException,
    );

    expect(prisma.warranty.updateMany).not.toHaveBeenCalled();
  });

  it('гарантія з минулим терміном → BadRequestException', async () => {
    prisma.warranty.findFirst.mockResolvedValueOnce({
      ...validWarranty,
      expiresAt: pastDate,
    });
    prisma.workOrder.findFirst.mockResolvedValueOnce(validClaimWo);

    await expect(service.claim(orgId, warrantyId, { claimWoId })).rejects.toBeInstanceOf(
      BadRequestException,
    );

    expect(prisma.warranty.updateMany).not.toHaveBeenCalled();
  });
});

/**
 * Регресія: `autoCreate` рахує `expiresAt` через `addDaysKyiv` (Kyiv-календар),
 * а НЕ через `new Date().setDate(getDate()+days)` (server-local календар).
 * На UTC-сервері стара реалізація зсувала день завершення гарантії на TZ-offset.
 */
describe('WarrantiesService.autoCreate — Kyiv-дата expiresAt', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let service: WarrantiesService;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  const orgId = 'org-1';
  const workOrderId = 'wo-1';

  beforeEach(async () => {
    prisma = {
      workOrder: { findFirst: vi.fn() },
      warranty: { findFirst: vi.fn(), create: vi.fn() },
    };
    const module = await Test.createTestingModule({
      providers: [WarrantiesService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(WarrantiesService);
  });

  // Дзеркалить addDaysKyiv: Kyiv-календарна дата (sv-SE) + N днів через UTC-опівніч.
  const expectedKyivExpiry = (days: number): Date => {
    const ymd = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv' }).format(new Date());
    const d = new Date(ymd + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + days);
    return new Date(d.toISOString().slice(0, 10));
  };

  it('expiresAt = Kyiv-сьогодні + warrantyDays (UTC-опівніч), warrantyDays з БД', async () => {
    prisma.workOrder.findFirst.mockResolvedValueOnce({
      id: workOrderId,
      number: 'WO-42',
      counterpartyId: 'cp-1',
    });
    prisma.warranty.findFirst.mockResolvedValueOnce(null); // idempotent — ще не створено
    prisma.warranty.create.mockResolvedValueOnce({ id: 'wty-new' });

    const warrantyDays = 90;
    await service.autoCreate(orgId, workOrderId, warrantyDays);

    expect(prisma.warranty.create).toHaveBeenCalledTimes(1);
    const createArgs = prisma.warranty.create.mock.calls[0][0];
    expect(createArgs.data.expiresAt.getTime()).toBe(expectedKyivExpiry(warrantyDays).getTime());
    expect(createArgs.data.orgId).toBe(orgId);
    expect(createArgs.data.counterpartyId).toBe('cp-1');
  });

  it('ідемпотентність: гарантія по наряду вже існує → create НЕ викликаний', async () => {
    prisma.workOrder.findFirst.mockResolvedValueOnce({
      id: workOrderId,
      number: 'WO-42',
      counterpartyId: 'cp-1',
    });
    prisma.warranty.findFirst.mockResolvedValueOnce({ id: 'existing-wty' });

    await service.autoCreate(orgId, workOrderId, 90);

    expect(prisma.warranty.create).not.toHaveBeenCalled();
  });
});
