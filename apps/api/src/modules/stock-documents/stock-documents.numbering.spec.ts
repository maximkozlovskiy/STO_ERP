/**
 * StockDocumentsService — нумерація документа (BR-SDOC-001).
 *
 * Номер не приходить із DTO і не будується у сервісі: його видає
 * `DocumentNumberService.next(orgId, documentType)`, а тип лічильника залежить від
 * типу складського документа. Спек перевіряє обидві половини правила:
 *   1. КОЖЕН `StockDocumentType` веде у СВІЙ лічильник (а не у fallback STOCK_WRITEOFF);
 *   2. у БД пишеться саме той номер, що його повернув лічильник.
 *
 * Перелік типів береться з Prisma-enum, а не з літералів: новий тип без запису в
 * `docTypeMap` сервіса мовчки отримав би нумерацію списання — тут він упаде.
 */

import { Test } from '@nestjs/testing';
import type { DocumentType } from '@prisma/client';
import { StockDocumentType } from '@prisma/client';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { StockDocumentsService } from './stock-documents.service';
import { PrismaService } from '../../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { DocumentNumberService } from '../document-number/document-number.service';

const ORG = 'org-1';
const DOC_ID = '11111111-1111-4111-8111-111111111111';
const BRANCH_ID = '22222222-2222-4222-8222-222222222222';
const WAREHOUSE_ID = '33333333-3333-4333-8333-333333333333';
const TARGET_WAREHOUSE_ID = '77777777-7777-4777-8777-777777777777';
const ISSUED_NUMBER = 'ТЕСТ-2026-0042';

// Очікувана відповідність «тип документа → лічильник». Record<StockDocumentType, …> —
// новий тип у Prisma зробить цей файл некомпільованим, доки рядок не додадуть.
const EXPECTED_COUNTER: Record<StockDocumentType, DocumentType> = {
  WRITEOFF: 'STOCK_WRITEOFF',
  TRANSFER: 'STOCK_TRANSFER',
  OPENING_BALANCE: 'STOCK_OPENING',
  RECEIPT: 'STOCK_RECEIPT',
};

describe('StockDocumentsService — нумерація документа (BR-SDOC-001)', () => {
  let service: StockDocumentsService;
  let createData: Record<string, unknown> | undefined;
  let docNumbers: { next: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    createData = undefined;
    const prisma = {
      garageBranch: { findFirst: vi.fn().mockResolvedValue({ id: BRANCH_ID }) },
      // І джерело, і ціль (TRANSFER) — «знайдені»: echo запитаного id.
      warehouse: {
        findFirst: vi
          .fn()
          .mockImplementation((args: { where: { id: string } }) =>
            Promise.resolve({ id: args.where.id }),
          ),
      },
      good: { findMany: vi.fn().mockResolvedValue([]) },
      stockDocument: {
        create: vi.fn().mockImplementation((args: { data: Record<string, unknown> }) => {
          createData = args.data;
          return Promise.resolve({ id: DOC_ID });
        }),
        // Повертаємо рядок із тим номером, який сервіс ЗАПИСАВ (а не з константи) —
        // інакше DTO-асерт нижче проходив би незалежно від сервіса.
        findFirstOrThrow: vi.fn().mockImplementation(() =>
          Promise.resolve({
            id: DOC_ID,
            orgId: ORG,
            number: createData?.number,
            type: createData?.type,
            status: 'DRAFT',
            branchId: BRANCH_ID,
            warehouseId: WAREHOUSE_ID,
            targetWarehouseId: null,
            notes: null,
            documentDate: new Date(),
            confirmedAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            branch: { name: 'Філія 1' },
            warehouse: { name: 'Склад 1' },
            targetWarehouse: null,
            lines: [],
          }),
        ),
      },
      stockDocumentLine: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
      $transaction: vi.fn(),
    };
    prisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(prisma));
    docNumbers = { next: vi.fn().mockResolvedValue(ISSUED_NUMBER) };

    const module = await Test.createTestingModule({
      providers: [
        StockDocumentsService,
        { provide: PrismaService, useValue: prisma },
        { provide: InventoryService, useValue: {} },
        { provide: DocumentNumberService, useValue: docNumbers },
      ],
    }).compile();
    service = module.get(StockDocumentsService);
  });

  const dtoFor = (type: StockDocumentType) => ({
    type,
    branchId: BRANCH_ID,
    warehouseId: WAREHOUSE_ID,
    ...(type === 'TRANSFER' ? { targetWarehouseId: TARGET_WAREHOUSE_ID } : {}),
  });

  // guards: BR-SDOC-001
  it.each(Object.values(StockDocumentType))(
    'create(type=%s) → docNumbers.next(orgId, свій лічильник типу), рівно один раз',
    async type => {
      await service.create(ORG, dtoFor(type) as never);

      expect(docNumbers.next).toHaveBeenCalledTimes(1);
      expect(docNumbers.next).toHaveBeenCalledWith(ORG, EXPECTED_COUNTER[type]);
    },
  );

  // guards: BR-SDOC-001
  it('create() пише у БД і повертає саме той номер, що видав лічильник; номер із DTO ігнорується', async () => {
    const res = await service.create(ORG, {
      ...dtoFor('WRITEOFF'),
      number: 'РУЧНИЙ-1',
    } as never);

    expect(createData?.number).toBe(ISSUED_NUMBER);
    expect(res.number).toBe(ISSUED_NUMBER);
  });
});
