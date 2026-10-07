/**
 * StockDocumentsService — tenant-guard goodId рядків (BR-SDOC-002).
 *
 * `Good.id` глобально унікальний, тож без перевірки org A могла б підсунути goodId
 * org B у рядок документа — а на CONFIRM `createMovement` записав би рух проти чужого
 * товару. Правило діє і на create, і на update; гілку create стереже кейс
 * «create(): foreign goodId…» у `stock-documents.receipt-type.spec.ts`, цей файл —
 * гілку update і форму самого запиту до `good` (orgId + deletedAt:null).
 */

import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { StockDocumentType } from '@prisma/client';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { StockDocumentsService } from './stock-documents.service';
import { PrismaService } from '../../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { DocumentNumberService } from '../document-number/document-number.service';

const ORG = 'org-1';
const DOC_ID = '11111111-1111-4111-8111-111111111111';
const OWN_GOOD = '44444444-4444-4444-8444-444444444444';
const FOREIGN_GOOD = '88888888-8888-4888-8888-888888888888';

describe('StockDocumentsService — tenant-guard goodId рядків на update (BR-SDOC-002)', () => {
  let service: StockDocumentsService;
  let prisma: {
    stockDocument: { findFirst: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
    stockDocumentLine: {
      updateMany: ReturnType<typeof vi.fn>;
      createMany: ReturnType<typeof vi.fn>;
    };
    good: { findMany: ReturnType<typeof vi.fn> };
    $transaction: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    prisma = {
      stockDocument: {
        findFirst: vi.fn().mockResolvedValue({ status: 'DRAFT' }),
        update: vi.fn().mockResolvedValue({
          id: DOC_ID,
          orgId: ORG,
          number: 'ПТ-2026-0001',
          type: StockDocumentType.RECEIPT,
          status: 'DRAFT',
          branchId: 'b1',
          warehouseId: 'w1',
          targetWarehouseId: null,
          notes: null,
          documentDate: new Date(),
          confirmedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          branch: { name: 'Ф1' },
          warehouse: { name: 'С1' },
          targetWarehouse: null,
          lines: [],
        }),
      },
      stockDocumentLine: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      // «Своя» org має лише OWN_GOOD: чужий id у відповідь не потрапляє, як у реальній БД
      // з фільтром orgId.
      good: {
        findMany: vi
          .fn()
          .mockImplementation((args: { where: { id: { in: string[] } } }) =>
            Promise.resolve(args.where.id.in.filter(id => id === OWN_GOOD).map(id => ({ id }))),
          ),
      },
      $transaction: vi.fn(),
    };
    prisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(prisma));

    const module = await Test.createTestingModule({
      providers: [
        StockDocumentsService,
        { provide: PrismaService, useValue: prisma },
        { provide: InventoryService, useValue: {} },
        { provide: DocumentNumberService, useValue: { next: vi.fn() } },
      ],
    }).compile();
    service = module.get(StockDocumentsService);
  });

  // guards: BR-SDOC-002
  it('update(): чужий goodId серед рядків → 404 ДО запису (рядки не soft-delete-нуті, нові не створені)', async () => {
    const dto = {
      lines: [
        { goodId: OWN_GOOD, quantity: 1 },
        { goodId: FOREIGN_GOOD, quantity: 2 },
      ],
    };

    await expect(service.update(ORG, DOC_ID, dto as never)).rejects.toThrow(NotFoundException);

    // «ДО запису»: транзакція заміни рядків навіть не стартувала.
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.stockDocumentLine.updateMany).not.toHaveBeenCalled();
    expect(prisma.stockDocumentLine.createMany).not.toHaveBeenCalled();
    expect(prisma.stockDocument.update).not.toHaveBeenCalled();
  });

  // guards: BR-SDOC-002
  it('update(): пошук товарів обмежений org і живими записами (where: orgId + deletedAt:null)', async () => {
    await service.update(ORG, DOC_ID, { lines: [{ goodId: OWN_GOOD, quantity: 1 }] } as never);

    expect(prisma.good.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.good.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: [OWN_GOOD] }, orgId: ORG, deletedAt: null },
      }),
    );
    // Свої товари → правка проходить, рядки замінюються.
    expect(prisma.stockDocumentLine.createMany).toHaveBeenCalledTimes(1);
  });
});
