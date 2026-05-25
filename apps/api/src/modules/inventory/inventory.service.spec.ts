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
    good: { findFirst: ReturnType<typeof vi.fn> };
  };
  let batchService: { createFromReceipt: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    prisma = {
      stockItem: { findFirst: vi.fn(), upsert: vi.fn().mockResolvedValue({}) },
      stockMovement: { create: vi.fn().mockResolvedValue({ id: 'mov-1' }) },
      good: { findFirst: vi.fn().mockResolvedValue({ purchasePrice: null }) },
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
    await service.createMovement('org-1', dto({ type: 'RECEIPT', quantity: 10, price: 50 }));
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

  it('Bug #26: RECEIPT без price fallback до good.purchasePrice', async () => {
    prisma.good.findFirst.mockResolvedValue({ purchasePrice: 42 });
    await service.createMovement('org-1', dto({ type: 'RECEIPT', quantity: 10 }));
    expect(batchService.createFromReceipt).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({ receivedQty: 10, costPrice: 42 }),
      expect.anything(),
    );
  });

  it('Bug #26: RECEIPT без price і без purchasePrice → costPrice=0', async () => {
    prisma.good.findFirst.mockResolvedValue({ purchasePrice: null });
    await service.createMovement('org-1', dto({ type: 'RECEIPT', quantity: 10 }));
    expect(batchService.createFromReceipt).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({ receivedQty: 10, costPrice: 0 }),
      expect.anything(),
    );
  });

  it('Bug #15: RECEIPT з price=0 (безкоштовний зразок) створює партію з нульовою собівартістю', async () => {
    await service.createMovement('org-1', dto({ type: 'RECEIPT', quantity: 5, price: 0 }));
    expect(prisma.stockMovement.create).toHaveBeenCalled();
    expect(batchService.createFromReceipt).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({ receivedQty: 5, costPrice: 0 }),
      expect.anything(),
    );
  });

  it('Bug #26: createMovement кидає при NaN quantity', async () => {
    await expect(service.createMovement('org-1', dto({ quantity: NaN, price: 50 })))
      .rejects.toThrow(BadRequestException);
  });

  it('Bug #26: createMovement кидає при NaN price', async () => {
    await expect(service.createMovement('org-1', dto({ type: 'RECEIPT', quantity: 5, price: NaN })))
      .rejects.toThrow(BadRequestException);
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
