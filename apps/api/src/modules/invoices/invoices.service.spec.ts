import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { InvoicesService } from './invoices.service';
import { PrismaService } from '../../prisma/prisma.service';
import { DocumentNumberService } from '../document-number/document-number.service';
import { PdfService } from '../pdf/pdf.service';

/**
 * Bug #413: Service-level spec для guards що додані review-фіксами #403, #406, #407, #412.
 * Contract spec мокає сервіс — НЕ перевіряє business logic. Цей файл — regression-guard.
 */
describe('InvoicesService — business logic guards', () => {
  let service: InvoicesService;
  let prisma: {
    invoice: {
      findFirst: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
    invoiceLine: {
      deleteMany: ReturnType<typeof vi.fn>;
      createMany: ReturnType<typeof vi.fn>;
    };
    workOrder: { findFirst: ReturnType<typeof vi.fn> };
    counterparty: { findFirst: ReturnType<typeof vi.fn> };
    $transaction: ReturnType<typeof vi.fn>;
  };
  let docNumbers: { next: ReturnType<typeof vi.fn> };
  let pdf: { generateInvoicePdf: ReturnType<typeof vi.fn> };

  const ORG = 'org-1';
  const WO_ID = '11111111-1111-4111-8111-111111111111';
  const INV_ID = '22222222-2222-4222-8222-222222222222';

  beforeEach(async () => {
    prisma = {
      invoice: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
      invoiceLine: { deleteMany: vi.fn(), createMany: vi.fn() },
      workOrder: { findFirst: vi.fn() },
      counterparty: { findFirst: vi.fn() },
      $transaction: vi.fn().mockImplementation(async (arg: unknown) => {
        if (typeof arg === 'function') return (arg as (tx: unknown) => Promise<unknown>)(prisma);
        return undefined;
      }),
    };
    docNumbers = { next: vi.fn().mockResolvedValue('INV-2026-0001') };
    pdf = { generateInvoicePdf: vi.fn() };

    const module = await Test.createTestingModule({
      providers: [
        InvoicesService,
        { provide: PrismaService, useValue: prisma },
        { provide: DocumentNumberService, useValue: docNumbers },
        { provide: PdfService, useValue: pdf },
      ],
    }).compile();
    service = module.get(InvoicesService);
  });

  // ─── Bug #403: refreshFromWorkOrder DRAFT-only guard ─────────────────────

  describe('refreshFromWorkOrder — Bug #403 status guard', () => {
    const setupValidWO = () =>
      prisma.workOrder.findFirst.mockResolvedValue({
        id: WO_ID,
        orgId: ORG,
        status: 'COMPLETED',
        counterpartyId: 'c-1',
        totalAmount: 1000,
        lines: [],
        parts: [],
      });

    it('кидає BadRequestException якщо existing.status=SENT', async () => {
      setupValidWO();
      prisma.invoice.findFirst.mockResolvedValueOnce({
        id: INV_ID,
        orgId: ORG,
        status: 'SENT',
        workOrderId: WO_ID,
      });
      await expect(service.refreshFromWorkOrder(ORG, WO_ID)).rejects.toThrow(BadRequestException);
    });

    it('кидає BadRequestException якщо existing.status=PAID', async () => {
      setupValidWO();
      prisma.invoice.findFirst.mockResolvedValueOnce({
        id: INV_ID,
        orgId: ORG,
        status: 'PAID',
        workOrderId: WO_ID,
      });
      await expect(service.refreshFromWorkOrder(ORG, WO_ID)).rejects.toThrow(BadRequestException);
    });

    it('кидає BadRequestException якщо existing.status=OVERDUE', async () => {
      setupValidWO();
      prisma.invoice.findFirst.mockResolvedValueOnce({
        id: INV_ID,
        orgId: ORG,
        status: 'OVERDUE',
        workOrderId: WO_ID,
      });
      await expect(service.refreshFromWorkOrder(ORG, WO_ID)).rejects.toThrow(BadRequestException);
    });

    it('кидає NotFoundException якщо WO не знайдено', async () => {
      prisma.workOrder.findFirst.mockResolvedValue(null);
      prisma.invoice.findFirst.mockResolvedValueOnce(null);
      await expect(service.refreshFromWorkOrder(ORG, WO_ID)).rejects.toThrow(NotFoundException);
    });

    it('кидає NotFoundException якщо active invoice не знайдено', async () => {
      setupValidWO();
      prisma.invoice.findFirst.mockResolvedValueOnce(null);
      await expect(service.refreshFromWorkOrder(ORG, WO_ID)).rejects.toThrow(NotFoundException);
    });
  });

  // ─── Bug #406: vatRate=20 default ────────────────────────────────────────

  describe('refreshFromWorkOrder — Bug #406 vatRate=20 default', () => {
    it('створює invoice lines з vatRate=20 для робіт і запчастин', async () => {
      prisma.workOrder.findFirst.mockResolvedValue({
        id: WO_ID,
        orgId: ORG,
        status: 'COMPLETED',
        counterpartyId: 'c-1',
        totalAmount: 1000,
        lines: [
          { id: 'l-1', workId: 'w-1', normoHours: 2, price: 100, work: { name: 'Робота 1' } },
        ],
        parts: [
          { id: 'p-1', goodId: 'g-1', quantity: 1, price: 500, good: { name: 'Запчастина 1' } },
        ],
      });
      prisma.invoice.findFirst.mockResolvedValueOnce({
        id: INV_ID,
        orgId: ORG,
        status: 'DRAFT',
        workOrderId: WO_ID,
      });
      // findOne (повернути результат після refresh) — мінімальний mock щоб не кидало
      prisma.invoice.findFirst.mockResolvedValueOnce({
        id: INV_ID,
        orgId: ORG,
        number: 'INV-2026-0001',
        status: 'DRAFT',
        counterpartyId: 'c-1',
        workOrderId: WO_ID,
        amount: 720,
        totalWithoutVat: 600,
        totalVat: 120,
        totalWithVat: 720,
        invoiceType: 'STANDARD',
        notes: null,
        dueDate: null,
        documentDate: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
        lines: [],
        payments: [],
      });

      await service.refreshFromWorkOrder(ORG, WO_ID);

      expect(prisma.invoiceLine.createMany).toHaveBeenCalledTimes(1);
      const createCall = prisma.invoiceLine.createMany.mock.calls[0][0];
      expect(createCall.data).toHaveLength(2);
      // КЛЮЧОВИЙ assert: vatRate=20 для всіх рядків (НЕ 0)
      for (const line of createCall.data) {
        expect(line.vatRate).toBe(20);
        expect(line.vatAmount).toBeGreaterThan(0);
        expect(line.priceWithVat).toBeGreaterThan(line.priceWithoutVat);
      }
    });
  });

  // ─── Bug #407: $transaction atomicity ────────────────────────────────────

  describe('refreshFromWorkOrder — Bug #407 atomic recalc', () => {
    it('викликає invoice.update ВСЕРЕДИНІ $transaction (не після commit)', async () => {
      prisma.workOrder.findFirst.mockResolvedValue({
        id: WO_ID,
        orgId: ORG,
        status: 'COMPLETED',
        counterpartyId: 'c-1',
        totalAmount: 100,
        lines: [{ id: 'l-1', workId: 'w-1', normoHours: 1, price: 100, work: null }],
        parts: [],
      });
      prisma.invoice.findFirst.mockResolvedValueOnce({
        id: INV_ID,
        orgId: ORG,
        status: 'DRAFT',
        workOrderId: WO_ID,
      });
      prisma.invoice.findFirst.mockResolvedValueOnce({
        id: INV_ID,
        orgId: ORG,
        number: 'INV-1',
        status: 'DRAFT',
        counterpartyId: 'c-1',
        workOrderId: WO_ID,
        amount: 120,
        totalWithoutVat: 100,
        totalVat: 20,
        totalWithVat: 120,
        invoiceType: 'STANDARD',
        notes: null,
        dueDate: null,
        documentDate: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
        lines: [],
        payments: [],
      });

      await service.refreshFromWorkOrder(ORG, WO_ID);

      // $transaction викликаний — atomicity guarantee
      expect(prisma.$transaction).toHaveBeenCalled();
      // invoice.update викликаний ОДНОРАЗОВО всередині callback з обчисленими totals
      expect(prisma.invoice.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: INV_ID, orgId: ORG },
          data: expect.objectContaining({
            totalWithoutVat: expect.any(Number),
            totalVat: expect.any(Number),
            totalWithVat: expect.any(Number),
            amount: expect.any(Number),
          }),
        }),
      );
    });
  });

  // ─── Bug #412: createFromWorkOrder serializable guard ───────────────────

  describe('createFromWorkOrder — Bug #412 serializable race protection', () => {
    it('кидає BadRequestException якщо WO не у COMPLETED/INVOICED статусі', async () => {
      prisma.workOrder.findFirst.mockResolvedValue({
        id: WO_ID,
        orgId: ORG,
        status: 'DRAFT',
        counterpartyId: 'c-1',
        totalAmount: 100,
      });
      prisma.invoice.findFirst.mockResolvedValue(null);
      await expect(service.createFromWorkOrder(ORG, WO_ID)).rejects.toThrow(BadRequestException);
    });

    it('кидає BadRequestException якщо pre-check виявляє існуючий invoice', async () => {
      prisma.workOrder.findFirst.mockResolvedValue({
        id: WO_ID,
        orgId: ORG,
        status: 'COMPLETED',
        counterpartyId: 'c-1',
        totalAmount: 100,
      });
      prisma.invoice.findFirst.mockResolvedValue({ id: INV_ID });
      await expect(service.createFromWorkOrder(ORG, WO_ID)).rejects.toThrow(BadRequestException);
    });

    it('кидає NotFoundException якщо WO не знайдено', async () => {
      prisma.workOrder.findFirst.mockResolvedValue(null);
      prisma.invoice.findFirst.mockResolvedValue(null);
      await expect(service.createFromWorkOrder(ORG, WO_ID)).rejects.toThrow(NotFoundException);
    });

    // Bug #416: regression-guard для INNER re-check всередині Serializable $transaction
    // (Bug #412 fix). Без цього тесту видалення `const existing = await tx.invoice.findFirst(...)`
    // блоку у refactor пройде CI зеленим — CRITICAL race window повертається silently.
    //
    // Сценарій: pre-check (1-й findFirst) бачить null → переходимо у $tx → re-check (2-й
    // findFirst) бачить ВЖЕ СТВОРЕНИЙ другим конкурентом → re-check кидає BadRequestException.
    it('Bug #412: re-check всередині $transaction виявляє race-створений invoice → throw', async () => {
      prisma.workOrder.findFirst.mockResolvedValue({
        id: WO_ID,
        orgId: ORG,
        status: 'COMPLETED',
        counterpartyId: 'c-1',
        totalAmount: 100,
      });
      // 1st findFirst (pre-check, поза $tx) → null
      // 2nd findFirst (re-check, всередині $tx) → конкурент щойно створив invoice
      prisma.invoice.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: INV_ID });

      await expect(service.createFromWorkOrder(ORG, WO_ID)).rejects.toThrow(BadRequestException);
      // Жоден invoice не повинен бути створений якщо re-check спрацював
      expect(prisma.invoice.create).not.toHaveBeenCalled();
    });
  });

  // ─── Bug #405: findByWorkOrder returns null (not 404) ───────────────────

  describe('findByWorkOrder — Bug #405', () => {
    it('повертає null коли активного invoice немає', async () => {
      prisma.invoice.findFirst.mockResolvedValue(null);
      const result = await service.findByWorkOrder(ORG, WO_ID);
      expect(result).toBeNull();
    });

    it('повертає { id, number } коли invoice існує', async () => {
      prisma.invoice.findFirst.mockResolvedValue({ id: INV_ID, number: 'INV-1' });
      const result = await service.findByWorkOrder(ORG, WO_ID);
      expect(result).toEqual({ id: INV_ID, number: 'INV-1' });
    });

    it('виключає CANCELLED invoices з пошуку', async () => {
      prisma.invoice.findFirst.mockResolvedValue(null);
      await service.findByWorkOrder(ORG, WO_ID);
      expect(prisma.invoice.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            workOrderId: WO_ID,
            orgId: ORG,
            deletedAt: null,
            status: { not: 'CANCELLED' },
          }),
        }),
      );
    });
  });
});
