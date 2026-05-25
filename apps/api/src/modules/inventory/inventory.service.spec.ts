import { Test } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { InventoryService } from './inventory.service';
import { BatchService } from './batch.service';
import { PrismaService } from '../../prisma/prisma.service';

describe('InventoryService.createMovement guards', () => {
  let service: InventoryService;
  let prisma: {
    stockItem: { findFirst: ReturnType<typeof vi.fn>; upsert: ReturnType<typeof vi.fn> };
    stockMovement: { create: ReturnType<typeof vi.fn> };
  };
  let batchService: { createFromReceipt: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    prisma = {
      stockItem: { findFirst: vi.fn(), upsert: vi.fn().mockResolvedValue({}) },
      stockMovement: { create: vi.fn().mockResolvedValue({ id: 'mov-1' }) },
    };
    batchService = { createFromReceipt: vi.fn().mockResolvedValue({}) };
    const module = await Test.createTestingModule({
      providers: [
        InventoryService,
        { provide: PrismaService, useValue: prisma },
        { provide: BatchService, useValue: batchService },
      ],
    }).compile();
    service = module.get(InventoryService);
  });

  const dto = (overrides: Partial<Parameters<InventoryService['createMovement']>[1]> = {}) => ({
    goodId: 'good-1',
    warehouseId: 'wh-1',
    type: 'RECEIPT' as const,
    quantity: 10,
    ...overrides,
  });

  it('кидає при quantity = 0', async () => {
    await expect(service.createMovement('org-1', dto({ quantity: 0 })))
      .rejects.toThrow(BadRequestException);
  });

  it('кидає при RESERVATION_RELEASE з positive quantity', async () => {
    await expect(service.createMovement('org-1', dto({ type: 'RESERVATION_RELEASE', quantity: 5 })))
      .rejects.toThrow(BadRequestException);
  });

  it('кидає при WRITEOFF якщо available < |quantity|', async () => {
    prisma.stockItem.findFirst.mockResolvedValue({ quantity: 5, reserved: 0 });
    await expect(service.createMovement('org-1', dto({ type: 'WRITEOFF', quantity: -10 })))
      .rejects.toThrow(BadRequestException);
  });

  it('кидає при RESERVATION якщо available < quantity', async () => {
    prisma.stockItem.findFirst.mockResolvedValue({ quantity: 10, reserved: 8 });
    await expect(service.createMovement('org-1', dto({ type: 'RESERVATION', quantity: 5 })))
      .rejects.toThrow(BadRequestException);
  });

  it('кидає при RESERVATION_RELEASE якщо |quantity| > reserved', async () => {
    prisma.stockItem.findFirst.mockResolvedValue({ quantity: 10, reserved: 2 });
    await expect(service.createMovement('org-1', dto({ type: 'RESERVATION_RELEASE', quantity: -5 })))
      .rejects.toThrow(BadRequestException);
  });

  it('RECEIPT збільшує quantity і не торкається reserved', async () => {
    await service.createMovement('org-1', dto({ type: 'RECEIPT', quantity: 10 }));
    expect(prisma.stockMovement.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: 'RECEIPT', quantity: 10 }),
    });
    expect(prisma.stockItem.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({
        quantity: { increment: 10 },
        reserved: { increment: 0 },
      }),
    }));
  });

  it('RESERVATION тільки інкрементує reserved, не quantity', async () => {
    prisma.stockItem.findFirst.mockResolvedValue({ quantity: 100, reserved: 0 });
    await service.createMovement('org-1', dto({ type: 'RESERVATION', quantity: 5 }));
    expect(prisma.stockItem.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({
        quantity: { increment: 0 },
        reserved: { increment: 5 },
      }),
    }));
  });

  it('WRITEOFF з достатніми залишками декрементує quantity', async () => {
    prisma.stockItem.findFirst.mockResolvedValue({ quantity: 100, reserved: 0 });
    await service.createMovement('org-1', dto({ type: 'WRITEOFF', quantity: -10 }));
    expect(prisma.stockItem.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({
        quantity: { increment: -10 },
        reserved: { increment: 0 },
      }),
    }));
  });
});
