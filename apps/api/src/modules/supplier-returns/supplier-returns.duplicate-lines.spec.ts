/**
 * SupplierReturnsService — повтори товару окремими рядками (BR-PO-008)
 *
 * Той самий товар може стояти в поверненні кількома рядками (наприклад, із різною ціною).
 * Раніше create/update зливали такі рядки за товаром: лишався останній, перший зникав разом
 * із кількістю. Тут — update і проведення; create перевіряє supplier-returns.confirm-fsm.spec.ts.
 */

import { Test } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { SupplierReturnStatus } from '@prisma/client';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { SupplierReturnsService } from './supplier-returns.service';
import { PrismaService } from '../../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { SettlementsService } from '../settlements/settlements.service';
import { DocumentNumberService } from '../document-number/document-number.service';

const ORG = '00000000-0000-4000-8000-000000000001';
const SR_ID = '11111111-1111-4111-8111-111111111111';
const SUPPLIER_ID = '22222222-2222-4222-8222-222222222222';
const WAREHOUSE_ID = '33333333-3333-4333-8333-333333333333';
const GOOD_ID = '44444444-4444-4444-8444-444444444444';
const GOOD_ID_2 = '55555555-5555-4555-8555-555555555555';
const USER_ID = '77777777-7777-4777-8777-777777777777';

const header = (over: Record<string, unknown> = {}) => ({
  id: SR_ID,
  orgId: ORG,
  number: 'ПВП-20261013-000001',
  status: SupplierReturnStatus.DRAFT,
  supplierId: SUPPLIER_ID,
  warehouseId: WAREHOUSE_ID,
  purchaseOrderId: null,
  totalAmount: 0,
  notes: null,
  documentDate: new Date('2026-10-13'),
  createdAt: new Date(),
  updatedAt: new Date(),
  supplier: { firstName: null, lastName: null, companyName: 'Acme' },
  warehouse: { name: 'Склад 1' },
  purchaseOrder: null,
  lines: [],
  ...over,
});

type LineRow = { goodId: string; quantity: number; price: number; createdAt: Date };

// guards: BR-PO-008
describe('SupplierReturnsService — повтори товару окремими рядками (BR-PO-008)', () => {
  let service: SupplierReturnsService;
  let stored: LineRow[];
  let headerUpdate: Record<string, unknown> | undefined;
  let prisma: {
    supplierReturn: {
      findFirst: ReturnType<typeof vi.fn>;
      findFirstOrThrow: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
    };
    supplierReturnLine: {
      updateMany: ReturnType<typeof vi.fn>;
      createMany: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
    };
    counterparty: { findFirst: ReturnType<typeof vi.fn> };
    warehouse: { findFirst: ReturnType<typeof vi.fn> };
    good: { findMany: ReturnType<typeof vi.fn> };
    unitOfMeasure: { findMany: ReturnType<typeof vi.fn> };
    $transaction: ReturnType<typeof vi.fn>;
  };
  let inventory: { createMovement: ReturnType<typeof vi.fn> };
  let settlements: { createTransaction: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    stored = [];
    headerUpdate = undefined;
    prisma = {
      supplierReturn: {
        findFirst: vi.fn(),
        findFirstOrThrow: vi.fn(),
        update: vi.fn().mockImplementation((args: { data: Record<string, unknown> }) => {
          headerUpdate = args.data;
          return Promise.resolve({});
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      supplierReturnLine: {
        updateMany: vi.fn().mockImplementation(() => {
          stored = []; // старі рядки позначено видаленими
          return Promise.resolve({ count: 0 });
        }),
        createMany: vi.fn().mockImplementation(({ data }: { data: LineRow[] }) => {
          stored.push(...data);
          return Promise.resolve({ count: data.length });
        }),
        // Сума документа рахується з того, що реально лежить у таблиці після запису.
        findMany: vi.fn().mockImplementation(() => Promise.resolve(stored)),
      },
      counterparty: { findFirst: vi.fn() },
      warehouse: { findFirst: vi.fn() },
      good: { findMany: vi.fn().mockResolvedValue([{ id: GOOD_ID }]) },
      unitOfMeasure: { findMany: vi.fn().mockResolvedValue([]) },
      $transaction: vi
        .fn()
        .mockImplementation((cb: (tx: unknown) => Promise<unknown>) => cb(prisma)),
    };
    inventory = { createMovement: vi.fn().mockResolvedValue(undefined) };
    settlements = { createTransaction: vi.fn().mockResolvedValue(undefined) };

    const module = await Test.createTestingModule({
      providers: [
        SupplierReturnsService,
        { provide: PrismaService, useValue: prisma },
        { provide: InventoryService, useValue: inventory },
        { provide: SettlementsService, useValue: settlements },
        { provide: DocumentNumberService, useValue: { next: vi.fn() } },
      ],
    }).compile();
    service = module.get(SupplierReturnsService);
  });

  describe('update()', () => {
    beforeEach(() => {
      prisma.supplierReturn.findFirst
        .mockResolvedValueOnce({
          id: SR_ID,
          status: SupplierReturnStatus.DRAFT,
          supplierId: SUPPLIER_ID,
        })
        .mockResolvedValueOnce(header());
    });

    it('два рядки одного товару → обидва збережено в надісланому порядку, сума обох', async () => {
      await service.update(ORG, SR_ID, {
        lines: [
          { goodId: GOOD_ID, quantity: 1, price: 10 },
          { goodId: GOOD_ID, quantity: 2, price: 25 },
        ],
      });

      const data = (prisma.supplierReturnLine.createMany.mock.calls[0]![0] as { data: LineRow[] })
        .data;
      expect(data).toHaveLength(2);
      expect(data[0]).toMatchObject({ goodId: GOOD_ID, quantity: 1, price: 10, orgId: ORG });
      expect(data[1]).toMatchObject({ goodId: GOOD_ID, quantity: 2, price: 25, orgId: ORG });
      expect(data[1]!.createdAt.getTime()).toBeGreaterThan(data[0]!.createdAt.getTime());
      // 1×10 + 2×25 = 60; при злитті за товаром було б 50.
      expect(headerUpdate).toMatchObject({ totalAmount: 60 });
    });

    it('повтор між іншими товарами лишається на своєму місці (А, Б, А)', async () => {
      prisma.good.findMany.mockResolvedValueOnce([{ id: GOOD_ID }, { id: GOOD_ID_2 }]);

      await service.update(ORG, SR_ID, {
        lines: [
          { goodId: GOOD_ID, quantity: 1, price: 10 },
          { goodId: GOOD_ID_2, quantity: 1, price: 5 },
          { goodId: GOOD_ID, quantity: 3, price: 10 },
        ],
      });

      const data = (prisma.supplierReturnLine.createMany.mock.calls[0]![0] as { data: LineRow[] })
        .data;
      expect(data.map(l => [l.goodId, l.quantity])).toEqual([
        [GOOD_ID, 1],
        [GOOD_ID_2, 1],
        [GOOD_ID, 3],
      ]);
      const stamps = data.map(l => l.createdAt.getTime());
      expect([...stamps].sort((a, b) => a - b)).toEqual(stamps);
      expect(new Set(stamps).size).toBe(3);
      expect(headerUpdate).toMatchObject({ totalAmount: 45 });
    });
  });

  describe('findOne()', () => {
    it('рядки читаються в порядку запису (createdAt, далі id)', async () => {
      prisma.supplierReturn.findFirst.mockResolvedValueOnce(header());

      await service.findOne(ORG, SR_ID);

      const arg = prisma.supplierReturn.findFirst.mock.calls[0]![0] as {
        include: { lines: { orderBy: unknown } };
      };
      expect(arg.include.lines.orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }]);
    });
  });

  describe('confirm()', () => {
    const arrange = (lines: Array<{ goodId: string; quantity: number; price: number }>) => {
      prisma.supplierReturn.findFirst
        .mockResolvedValueOnce({
          status: SupplierReturnStatus.DRAFT,
          _count: { lines: lines.length },
        })
        .mockResolvedValueOnce(header({ status: SupplierReturnStatus.CONFIRMED }));
      prisma.supplierReturn.findFirstOrThrow.mockResolvedValueOnce({
        supplierId: SUPPLIER_ID,
        warehouseId: WAREHOUSE_ID,
        totalAmount: lines.reduce((s, l) => s + l.quantity * l.price, 0),
        lines: lines.map(l => ({ ...l, unitOfMeasureId: null })),
      });
    };

    /**
     * Заглушка складу з поведінкою справжнього `InventoryService.createMovement`: спершу читає
     * залишок, на кожному кроці поступається керуванням (await), перевіряє достатність за
     * ПРОЧИТАНИМ значенням і лише тоді списує. Якщо два рухи одного товару запустити разом,
     * обидва прочитають той самий залишок.
     */
    const stockfulInventory = (initial: number) => {
      const state = { stock: initial, inFlight: 0, maxInFlight: 0 };
      inventory.createMovement.mockImplementation(
        async (_org: string, dto: { quantity: number }) => {
          state.inFlight += 1;
          state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
          try {
            const seen = state.stock;
            await Promise.resolve();
            if (seen < Math.abs(dto.quantity)) {
              throw new BadRequestException('Недостатньо товару на складі');
            }
            await Promise.resolve();
            state.stock += dto.quantity;
          } finally {
            state.inFlight -= 1;
          }
        },
      );
      return state;
    };

    it('два рядки одного товару → два окремі рухи WRITEOFF, один розрахунок на суму обох', async () => {
      arrange([
        { goodId: GOOD_ID, quantity: 1, price: 10 },
        { goodId: GOOD_ID, quantity: 2, price: 25 },
      ]);
      const state = stockfulInventory(10);

      await service.confirm(ORG, SR_ID, USER_ID);

      expect(inventory.createMovement).toHaveBeenCalledTimes(2);
      const dtos = inventory.createMovement.mock.calls.map(c => c[1] as Record<string, unknown>);
      expect(dtos[0]).toMatchObject({ goodId: GOOD_ID, type: 'WRITEOFF', quantity: -1, price: 10 });
      expect(dtos[1]).toMatchObject({ goodId: GOOD_ID, type: 'WRITEOFF', quantity: -2, price: 25 });
      expect(state.stock).toBe(7);
      expect(settlements.createTransaction).toHaveBeenCalledTimes(1);
      expect(settlements.createTransaction.mock.calls[0]![1]).toMatchObject({
        type: 'SUPPLIER_REFUND',
        amount: 60,
      });
    });

    it('рухи йдуть по одному: наступний починається після завершення попереднього', async () => {
      arrange([
        { goodId: GOOD_ID, quantity: 1, price: 10 },
        { goodId: GOOD_ID, quantity: 2, price: 25 },
        { goodId: GOOD_ID_2, quantity: 1, price: 5 },
      ]);
      const state = stockfulInventory(10);

      await service.confirm(ORG, SR_ID, USER_ID);

      expect(state.maxInFlight).toBe(1);
    });

    it('достатність залишку — за СУМОЮ по товару: 3 + 3 при залишку 5 → відмова', async () => {
      // Кожен рядок окремо «вистачає» (3 ≤ 5), разом — ні (6 > 5). Одночасний запуск обох рухів
      // пропустив би обидва, і залишок пішов би в мінус.
      arrange([
        { goodId: GOOD_ID, quantity: 3, price: 10 },
        { goodId: GOOD_ID, quantity: 3, price: 10 },
      ]);
      const state = stockfulInventory(5);

      await expect(service.confirm(ORG, SR_ID, USER_ID)).rejects.toThrow(
        new BadRequestException('Недостатньо товару на складі'),
      );

      expect(state.stock).toBe(2); // другий рух не списав; транзакція відкотить і перший
      expect(state.stock).toBeGreaterThanOrEqual(0);
      // Відмова всередині транзакції → розрахунок із постачальником не створено.
      expect(settlements.createTransaction).not.toHaveBeenCalled();
    });

    it('3 + 2 при залишку 5 → проходить, залишок рівно 0', async () => {
      arrange([
        { goodId: GOOD_ID, quantity: 3, price: 10 },
        { goodId: GOOD_ID, quantity: 2, price: 10 },
      ]);
      const state = stockfulInventory(5);

      await service.confirm(ORG, SR_ID, USER_ID);

      expect(state.stock).toBe(0);
    });
  });
});
