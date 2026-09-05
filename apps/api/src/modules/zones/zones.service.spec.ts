import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { ZonesService } from './zones.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../redis/cache.service';

// ─── Regression spec — removeZone cascade guard (MD-H1 клас) ───────────────────
//
// removeZone раніше робив голий updateMany без перевірки дочірніх підйомників.
// Soft-delete зони з активними Lift лишав осиротілі підйомники: вони далі
// показувались у findAllLifts, на них посилались CalendarSlot і наряди, а
// керувати ними через UI зони було вже неможливо. Guard блокує таке видалення.

describe('ZonesService.removeZone — cascade guard (active lifts)', () => {
  let service: ZonesService;
  let prisma: { zone: any; lift: any };
  let cache: {
    get: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
    del: ReturnType<typeof vi.fn>;
    delPattern: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    cache = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
      del: vi.fn().mockResolvedValue(undefined),
      delPattern: vi.fn().mockResolvedValue(undefined),
    };
    prisma = {
      zone: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      lift: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
    };

    const module = await Test.createTestingModule({
      providers: [
        ZonesService,
        { provide: PrismaService, useValue: prisma },
        { provide: CacheService, useValue: cache },
      ],
    }).compile();

    service = module.get(ZonesService);
  });

  it('блокує видалення зони з активним підйомником → BadRequestException, БЕЗ soft-delete', async () => {
    prisma.lift.findFirst.mockResolvedValueOnce({ id: 'lift-1' });

    await expect(service.removeZone('org-1', 'zone-1')).rejects.toThrow(BadRequestException);

    // Проти старого коду (без guard) zone.updateMany викликався б → цей assert падає.
    expect(prisma.zone.updateMany).not.toHaveBeenCalled();
    expect(prisma.lift.findFirst).toHaveBeenCalledWith({
      where: { orgId: 'org-1', zoneId: 'zone-1', deletedAt: null },
      select: { id: true },
    });
  });

  it('дозволяє видалення зони без активних підйомників', async () => {
    prisma.lift.findFirst.mockResolvedValueOnce(null);
    prisma.zone.updateMany.mockResolvedValueOnce({ count: 1 });

    await service.removeZone('org-1', 'zone-empty');

    expect(prisma.zone.updateMany).toHaveBeenCalledWith({
      where: { id: 'zone-empty', orgId: 'org-1', deletedAt: null },
      data: { deletedAt: expect.any(Date) },
    });
  });

  it('зона не існує (guard пройдено, updateMany count=0) → NotFoundException', async () => {
    prisma.lift.findFirst.mockResolvedValueOnce(null);
    prisma.zone.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(service.removeZone('org-1', 'zone-missing')).rejects.toThrow(NotFoundException);
  });
});
