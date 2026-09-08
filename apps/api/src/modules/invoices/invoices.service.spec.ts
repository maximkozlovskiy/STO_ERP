import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { InvoicesService } from './invoices.service';
import { PrismaService } from '../../prisma/prisma.service';
import { DocumentNumberService } from '../document-number/document-number.service';
import { PdfService } from '../pdf/pdf.service';
import { SettlementsService } from '../settlements/settlements.service';
import { SettingsService } from '../settings/settings.service';

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
      updateMany: ReturnType<typeof vi.fn>;
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
  let settlementsMock: { createTransaction: ReturnType<typeof vi.fn> };
  let settingsMock: { getDefaultVatRate: ReturnType<typeof vi.fn> };

  const ORG = 'org-1';
  const WO_ID = '11111111-1111-4111-8111-111111111111';
  const INV_ID = '22222222-2222-4222-8222-222222222222';

  beforeEach(async () => {
    prisma = {
      invoice: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
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
    settlementsMock = { createTransaction: vi.fn() };
    // Дефолт VAT = NONE; тести, що перевіряють ПДВ, перевизначають getDefaultVatRate per-case.
    settingsMock = {
      getDefaultVatRate: vi.fn().mockResolvedValue({ vatMode: 'NONE', vatRate: 0 }),
      // §13: invoiceDueDays керує дефолтним терміном оплати (resolveDueDate).
      getOrganisationSettings: vi.fn().mockResolvedValue({ invoiceDueDays: 7 }),
    };

    const module = await Test.createTestingModule({
      providers: [
        InvoicesService,
        { provide: PrismaService, useValue: prisma },
        { provide: DocumentNumberService, useValue: docNumbers },
        { provide: PdfService, useValue: pdf },
        { provide: SettlementsService, useValue: settlementsMock },
        { provide: SettingsService, useValue: settingsMock },
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

  describe('refreshFromWorkOrder — VAT з налаштувань org (не хардкод)', () => {
    it('EXCLUSIVE 20% → створює invoice lines з vatRate=20 для робіт і запчастин', async () => {
      // Раніше vatRate був хардкод 20 незалежно від org; тепер береться з getDefaultVatRate.
      settingsMock.getDefaultVatRate.mockResolvedValue({ vatMode: 'EXCLUSIVE', vatRate: 20 });
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
      // sto-optimize: Serializable inner re-check (status DRAFT) — додано симетрично
      // з createFromWorkOrder для закриття TOCTOU concurrent addLine/refresh.
      prisma.invoice.findFirst.mockResolvedValueOnce({ status: 'DRAFT' });
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
      // vatRate=20 для всіх рядків (EXCLUSIVE) + priceWithVat > priceWithoutVat.
      for (const line of createCall.data) {
        expect(line.vatRate).toBe(20);
        expect(line.vatAmount).toBeGreaterThan(0);
        expect(line.priceWithVat).toBeGreaterThan(line.priceWithoutVat);
      }
    });

    it('NONE → vatRate=0, ПДВ не додається (не хардкод 20 для безПДВ-org)', async () => {
      // Регрес фікса: раніше org без ПДВ отримувала роздутий на 20% рахунок.
      settingsMock.getDefaultVatRate.mockResolvedValue({ vatMode: 'NONE', vatRate: 0 });
      prisma.workOrder.findFirst.mockResolvedValue({
        id: WO_ID,
        orgId: ORG,
        status: 'COMPLETED',
        counterpartyId: 'c-1',
        totalAmount: 1000,
        lines: [
          { id: 'l-1', workId: 'w-1', normoHours: 2, price: 100, work: { name: 'Робота 1' } },
        ],
        parts: [{ id: 'p-1', goodId: 'g-1', quantity: 1, price: 500, good: { name: 'Запч.' } }],
      });
      // pre-check existing → in-tx invInTx → findOne (три findFirst, як у EXCLUSIVE-тесті).
      prisma.invoice.findFirst.mockResolvedValueOnce({
        id: INV_ID,
        orgId: ORG,
        status: 'DRAFT',
        workOrderId: WO_ID,
      });
      prisma.invoice.findFirst.mockResolvedValueOnce({ status: 'DRAFT' });
      prisma.invoice.findFirst.mockResolvedValueOnce({
        id: INV_ID,
        orgId: ORG,
        number: 'INV-2026-0001',
        status: 'DRAFT',
        counterpartyId: 'c-1',
        workOrderId: WO_ID,
        amount: 700,
        totalWithoutVat: 700,
        totalVat: 0,
        totalWithVat: 700,
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

      const createCall = prisma.invoiceLine.createMany.mock.calls[0][0];
      for (const line of createCall.data) {
        expect(line.vatRate).toBe(0);
        expect(line.vatAmount).toBe(0);
        expect(line.priceWithVat).toBe(line.priceWithoutVat);
      }
      // amount = база без ПДВ (200 роботи + 500 запчастина = 700), збігається з CHARGE.
      const updCall = prisma.invoice.update.mock.calls[0][0];
      expect(updCall.data.amount).toBe(700);
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
      // sto-optimize: Serializable inner re-check.
      prisma.invoice.findFirst.mockResolvedValueOnce({ status: 'DRAFT' });
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

  // ─── sto-optimize: refreshFromWorkOrder Serializable inner re-check ────
  //
  // Regression-guard для INNER re-check всередині Serializable $transaction. Без
  // цього тесту видалення `const invInTx = await tx.invoice.findFirst(...)` блоку
  // у refactor пройшло б CI зеленим — TOCTOU window повертається silently.
  //
  // Сценарій: pre-check бачить DRAFT → переходимо у $tx → re-check бачить status=SENT
  // (інший actor встиг змінити статус між pre-check і входом у tx) → re-check кидає
  // BadRequestException без виклику deleteMany/createMany (бухоблік не псується).

  describe('refreshFromWorkOrder — Serializable inner re-check race protection', () => {
    const MOCK_WO = {
      id: WO_ID,
      orgId: ORG,
      status: 'COMPLETED',
      counterpartyId: 'c-1',
      totalAmount: 100,
      lines: [],
      parts: [],
    };

    beforeEach(() => {
      prisma.workOrder.findFirst.mockResolvedValue(MOCK_WO);
    });

    it('re-check всередині $transaction виявляє статус-mutation → throw без deleteMany', async () => {
      // 1st findFirst (pre-check, поза $tx) → DRAFT (PASS)
      // 2nd findFirst (re-check, всередині $tx) → SENT (інший actor щойно змінив статус)
      prisma.invoice.findFirst
        .mockResolvedValueOnce({ id: INV_ID, orgId: ORG, status: 'DRAFT', workOrderId: WO_ID })
        .mockResolvedValueOnce({ status: 'SENT' });

      await expect(service.refreshFromWorkOrder(ORG, WO_ID)).rejects.toThrow(BadRequestException);
      // Жодних мутацій якщо re-check спрацював
      expect(prisma.invoiceLine.deleteMany).not.toHaveBeenCalled();
      expect(prisma.invoiceLine.createMany).not.toHaveBeenCalled();
      expect(prisma.invoice.update).not.toHaveBeenCalled();
    });

    it('re-check всередині $transaction виявляє soft-deleted invoice → NotFound', async () => {
      // pre-check бачить DRAFT, re-check бачить null (інший actor soft-deleted)
      prisma.invoice.findFirst
        .mockResolvedValueOnce({ id: INV_ID, orgId: ORG, status: 'DRAFT', workOrderId: WO_ID })
        .mockResolvedValueOnce(null);

      await expect(service.refreshFromWorkOrder(ORG, WO_ID)).rejects.toThrow(NotFoundException);
      expect(prisma.invoiceLine.deleteMany).not.toHaveBeenCalled();
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

    it('повертає { id, number, status, amount, documentDate } коли invoice існує (Bug #508)', async () => {
      // Сервіс розширено у commit 523190f2: findByWorkOrder() віддає 5 полів для
      // invoice slot у картці наряду — status badge, сума, дата документу. Mock
      // ОБОВ'ЯЗКОВО повертає shape що Prisma реально віддасть (Decimal для amount,
      // Date для documentDate), щоб мapping `Number()` + `.toISOString()` працював.
      prisma.invoice.findFirst.mockResolvedValue({
        id: INV_ID,
        number: 'INV-1',
        status: 'DRAFT',
        amount: 200,
        documentDate: new Date('2026-01-15T00:00:00.000Z'),
      });
      const result = await service.findByWorkOrder(ORG, WO_ID);
      expect(result).toEqual({
        id: INV_ID,
        number: 'INV-1',
        status: 'DRAFT',
        amount: 200,
        documentDate: '2026-01-15T00:00:00.000Z',
      });
    });

    it('повертає documentDate=null коли інвойс без дати документа (Bug #508 null branch)', async () => {
      // documentDate у Prisma nullable. Якщо null → service map повертає null, не
      // namespace error. Окремий case — інакше null branch без regression-guard.
      prisma.invoice.findFirst.mockResolvedValue({
        id: INV_ID,
        number: 'INV-1',
        status: 'DRAFT',
        amount: 200,
        documentDate: null,
      });
      const result = await service.findByWorkOrder(ORG, WO_ID);
      expect(result).toEqual({
        id: INV_ID,
        number: 'INV-1',
        status: 'DRAFT',
        amount: 200,
        documentDate: null,
      });
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

  // §13 config-over-hardcode: дефолтний термін оплати = documentDate + invoiceDueDays.
  describe('create — dueDate за invoiceDueDays (§13)', () => {
    const CP = '44444444-4444-4444-8444-444444444444';
    const setup = () => {
      prisma.counterparty.findFirst.mockResolvedValue({ id: CP });
      prisma.invoice.create.mockImplementation(
        async ({ data }: { data: Record<string, unknown> }) => ({
          id: INV_ID,
          number: 'INV-1',
          status: 'DRAFT',
          amount: data.amount,
          workOrderId: null,
          counterpartyId: CP,
          documentDate: data.documentDate,
          dueDate: data.dueDate,
          deletedAt: null,
          totalWithoutVat: 0,
          totalVat: 0,
          totalWithVat: data.amount,
          createdAt: new Date(),
          counterparty: { firstName: 'a', lastName: 'b', companyName: null },
          workOrder: null,
        }),
      );
    };

    it('коли dueDate не задано → documentDate + invoiceDueDays(7)', async () => {
      setup();
      await service.create(ORG, {
        counterpartyId: CP,
        amount: 100,
        documentDate: '2026-03-01',
      } as never);
      const arg = prisma.invoice.create.mock.calls[0][0].data;
      // 2026-03-01 + 7 днів = 2026-03-08 (Kyiv, DST-aware addDaysKyiv)
      expect((arg.dueDate as Date).toISOString().slice(0, 10)).toBe('2026-03-08');
      expect(settingsMock.getOrganisationSettings).toHaveBeenCalledWith(ORG);
    });

    it('явно заданий dueDate поважається (invoiceDueDays ігнорується)', async () => {
      setup();
      await service.create(ORG, {
        counterpartyId: CP,
        amount: 100,
        documentDate: '2026-03-01',
        dueDate: '2026-03-20',
      } as never);
      const arg = prisma.invoice.create.mock.calls[0][0].data;
      expect((arg.dueDate as Date).toISOString().slice(0, 10)).toBe('2026-03-20');
    });

    it('налаштування недоступні → fallback 7 днів (без падіння)', async () => {
      setup();
      settingsMock.getOrganisationSettings.mockRejectedValueOnce(new Error('db down'));
      await service.create(ORG, {
        counterpartyId: CP,
        amount: 100,
        documentDate: '2026-03-01',
      } as never);
      const arg = prisma.invoice.create.mock.calls[0][0].data;
      expect((arg.dueDate as Date).toISOString().slice(0, 10)).toBe('2026-03-08');
    });

    it('DST boundary: documentDate 2026-10-24 + 7д перетинає осінній перехід → 2026-10-31 (без стрибка)', async () => {
      // Kyiv осінній fallback = остання неділя жовтня (2026-10-25). addDaysKyiv рахує через
      // UTC-дні на date-only → зсув рівно 7 календарних днів, DST не з'їдає/не додає доби.
      setup();
      settingsMock.getOrganisationSettings.mockResolvedValueOnce({ invoiceDueDays: 7 });
      await service.create(ORG, {
        counterpartyId: CP,
        amount: 100,
        documentDate: '2026-10-24',
      } as never);
      const arg = prisma.invoice.create.mock.calls[0][0].data;
      expect((arg.dueDate as Date).toISOString().slice(0, 10)).toBe('2026-10-31');
    });

    it('DST boundary: documentDate 2026-03-28 + 7д перетинає весняний перехід → 2026-04-04', async () => {
      // Kyiv весняний spring-forward = остання неділя березня (2026-03-29).
      setup();
      settingsMock.getOrganisationSettings.mockResolvedValueOnce({ invoiceDueDays: 7 });
      await service.create(ORG, {
        counterpartyId: CP,
        amount: 100,
        documentDate: '2026-03-28',
      } as never);
      const arg = prisma.invoice.create.mock.calls[0][0].data;
      expect((arg.dueDate as Date).toISOString().slice(0, 10)).toBe('2026-04-04');
    });

    it('invoiceDueDays=0 → dueDate === documentDate (термін оплати того ж дня)', async () => {
      setup();
      settingsMock.getOrganisationSettings.mockResolvedValueOnce({ invoiceDueDays: 0 });
      await service.create(ORG, {
        counterpartyId: CP,
        amount: 100,
        documentDate: '2026-03-01',
      } as never);
      const arg = prisma.invoice.create.mock.calls[0][0].data;
      expect((arg.dueDate as Date).toISOString().slice(0, 10)).toBe('2026-03-01');
    });

    it('негативний invoiceDueDays ігнорується (>= 0 guard) → fallback 7 днів', async () => {
      setup();
      settingsMock.getOrganisationSettings.mockResolvedValueOnce({ invoiceDueDays: -5 });
      await service.create(ORG, {
        counterpartyId: CP,
        amount: 100,
        documentDate: '2026-03-01',
      } as never);
      const arg = prisma.invoice.create.mock.calls[0][0].data;
      // raw < 0 → умова (Number.isFinite && raw >= 0) хибна → dueDays лишається 7.
      expect((arg.dueDate as Date).toISOString().slice(0, 10)).toBe('2026-03-08');
    });
  });

  // createFromWorkOrder також резолвить dueDate через invoiceDueDays (обчислюється ПОЗА
  // Serializable tx). Раніше dueDate був завжди null для WO-рахунків (§13 config gap).
  describe('createFromWorkOrder — dueDate за invoiceDueDays (§13)', () => {
    it('дефолтний dueDate = documentDate(kyivToday) + invoiceDueDays проброшено у create', async () => {
      prisma.workOrder.findFirst.mockResolvedValue({
        id: WO_ID,
        orgId: ORG,
        status: 'COMPLETED',
        counterpartyId: 'c-1',
        totalAmount: 500,
      });
      // pre-check + inner re-check обидва null (нема існуючого рахунку).
      prisma.invoice.findFirst.mockResolvedValue(null);
      prisma.invoice.create.mockImplementation(
        async ({ data }: { data: Record<string, unknown> }) => ({
          id: INV_ID,
          number: 'INV-1',
          status: 'DRAFT',
          amount: data.amount,
          workOrderId: WO_ID,
          counterpartyId: 'c-1',
          documentDate: data.documentDate,
          dueDate: data.dueDate,
          deletedAt: null,
          totalWithoutVat: 0,
          totalVat: 0,
          totalWithVat: data.amount,
          createdAt: new Date(),
          counterparty: { firstName: 'a', lastName: 'b', companyName: null },
          workOrder: { number: 'WO-1' },
        }),
      );
      settingsMock.getOrganisationSettings.mockResolvedValueOnce({ invoiceDueDays: 10 });

      await service.createFromWorkOrder(ORG, WO_ID);

      const arg = prisma.invoice.create.mock.calls[0][0].data;
      // dueDate НЕ null — резолвиться з invoiceDueDays (регресія проти §13 config gap).
      expect(arg.dueDate).toBeInstanceOf(Date);
      // documentDate === kyivToday → dueDate = kyivToday + 10 днів (перевіряємо дельту).
      const doc = arg.documentDate as Date;
      const due = arg.dueDate as Date;
      const deltaDays = Math.round((due.getTime() - doc.getTime()) / 86_400_000);
      expect(deltaDays).toBe(10);
    });
  });

  // FIN-C2: standalone-рахунок (workOrderId=null) при DRAFT→SENT створює CHARGE; WO-рахунок — ні
  // (там CHARGE вже при COMPLETED наряду). CAS-перехід (updateMany status:DRAFT) проти дублю.
  describe('transition — FIN-C2 CHARGE для standalone на DRAFT→SENT', () => {
    const CP_ID = '33333333-3333-4333-8333-333333333333';
    // findOne (в кінці transition) робить власний findFirst з include — даємо мінімальний валідний.
    const findOneRow = {
      id: INV_ID,
      orgId: ORG,
      number: 'INV-1',
      status: 'SENT',
      amount: 500,
      workOrderId: null,
      counterpartyId: CP_ID,
      documentDate: new Date('2026-01-01'),
      dueDate: null,
      deletedAt: null,
      totalWithoutVat: 0,
      totalVat: 0,
      totalWithVat: 500,
      createdAt: new Date(),
      updatedAt: new Date(),
      counterparty: { firstName: null, lastName: null, companyName: 'ТОВ' },
      workOrder: null,
      lines: [],
    };

    it('standalone DRAFT→SENT → createTransaction(CHARGE) з сумою рахунку', async () => {
      prisma.invoice.findFirst
        .mockResolvedValueOnce({
          status: 'DRAFT',
          workOrderId: null,
          counterpartyId: CP_ID,
          amount: 500,
        })
        .mockResolvedValue(findOneRow); // findOne
      prisma.invoice.updateMany.mockResolvedValue({ count: 1 });
      await service.transition(ORG, INV_ID, 'SENT' as never, 'user-1');
      expect(settlementsMock.createTransaction).toHaveBeenCalledWith(
        ORG,
        expect.objectContaining({
          counterpartyId: CP_ID,
          type: 'CHARGE',
          amount: 500,
          documentType: 'Invoice',
        }),
        expect.anything(),
      );
    });

    it('WO-рахунок DRAFT→SENT → CHARGE НЕ створюється (уникнення подвійного боргу)', async () => {
      prisma.invoice.findFirst
        .mockResolvedValueOnce({
          status: 'DRAFT',
          workOrderId: WO_ID,
          counterpartyId: CP_ID,
          amount: 500,
        })
        .mockResolvedValue({ ...findOneRow, workOrderId: WO_ID });
      prisma.invoice.updateMany.mockResolvedValue({ count: 1 });
      await service.transition(ORG, INV_ID, 'SENT' as never, 'user-1');
      expect(settlementsMock.createTransaction).not.toHaveBeenCalled();
    });

    it('CAS: updateMany count=0 (статус змінився паралельно) → throw, CHARGE не створюється', async () => {
      prisma.invoice.findFirst.mockResolvedValueOnce({
        status: 'DRAFT',
        workOrderId: null,
        counterpartyId: CP_ID,
        amount: 500,
      });
      prisma.invoice.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.transition(ORG, INV_ID, 'SENT' as never, 'user-1')).rejects.toThrow(
        /змінився/,
      );
      expect(settlementsMock.createTransaction).not.toHaveBeenCalled();
    });
  });

  // ─── Session 2026-09-06: manual transition→PAID (money-model Phase 1) ─────
  //
  // Bug #675 fix: ручний →PAID для STANDALONE-рахунку (workOrderId=null) створює дзеркальний
  // PAYMENT-settlement на непокритий залишок — закриває CHARGE у леджері (інакше борг висів би
  // попри PAID). WO-рахунок НЕ отримує PAYMENT (його CHARGE через COMPLETED, оплата окремо).
  // paidAmount=amount синхронізується завжди. Ці тести стережуть від (а) втрати PAYMENT для
  // standalone, (б) подвоєння обліку для WO-рахунку.
  describe('transition — manual PAID + дзеркальний PAYMENT для standalone (Bug #675)', () => {
    const CP_ID = '33333333-3333-4333-8333-333333333333';
    const findOneRow = {
      id: INV_ID,
      orgId: ORG,
      number: 'INV-1',
      status: 'PAID',
      amount: 500,
      paidAmount: 500,
      workOrderId: null,
      counterpartyId: CP_ID,
      documentDate: new Date('2026-01-01'),
      dueDate: null,
      deletedAt: null,
      totalWithoutVat: 0,
      totalVat: 0,
      totalWithVat: 500,
      invoiceType: 'INVOICE',
      createdAt: new Date(),
      updatedAt: new Date(),
      counterparty: { firstName: null, lastName: null, companyName: 'ТОВ' },
      workOrder: null,
      lines: [],
    };

    it('standalone SENT→PAID: paidAmount=amount + дзеркальний PAYMENT на весь залишок (Bug #675 fix)', async () => {
      prisma.invoice.findFirst
        .mockResolvedValueOnce({
          status: 'SENT',
          workOrderId: null,
          counterpartyId: CP_ID,
          amount: 500,
          paidAmount: 0,
        })
        .mockResolvedValue(findOneRow);
      prisma.invoice.updateMany.mockResolvedValue({ count: 1 });

      await service.transition(ORG, INV_ID, 'PAID' as never, 'user-1');

      expect(prisma.invoice.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: INV_ID, orgId: ORG, status: 'SENT' }),
          data: expect.objectContaining({ status: 'PAID', paidAmount: 500 }),
        }),
      );
      // Дзеркальний PAYMENT закриває CHARGE у леджері (Bug #675): standalone-рахунок, залишок 500.
      expect(settlementsMock.createTransaction).toHaveBeenCalledTimes(1);
      expect(settlementsMock.createTransaction).toHaveBeenCalledWith(
        ORG,
        expect.objectContaining({
          counterpartyId: CP_ID,
          type: 'PAYMENT',
          amount: 500,
          documentType: 'Invoice',
          documentId: INV_ID,
        }),
        expect.anything(),
      );
    });

    it('standalone PARTIALLY_PAID→PAID: PAYMENT лише на НЕПОКРИТИЙ залишок (не подвоює часткові)', async () => {
      prisma.invoice.findFirst
        .mockResolvedValueOnce({
          status: 'PARTIALLY_PAID',
          workOrderId: null,
          counterpartyId: CP_ID,
          amount: 500,
          paidAmount: 200, // 200 уже сплачено через payments-модуль
        })
        .mockResolvedValue(findOneRow);
      prisma.invoice.updateMany.mockResolvedValue({ count: 1 });

      await service.transition(ORG, INV_ID, 'PAID' as never, 'user-1');

      // PAYMENT = 500 − 200 = 300 (лише залишок), не 500.
      expect(settlementsMock.createTransaction).toHaveBeenCalledWith(
        ORG,
        expect.objectContaining({ type: 'PAYMENT', amount: 300 }),
        expect.anything(),
      );
    });

    it('WO-рахунок →PAID: БЕЗ PAYMENT (CHARGE був через COMPLETED, уникаємо подвійного обліку)', async () => {
      prisma.invoice.findFirst
        .mockResolvedValueOnce({
          status: 'SENT',
          workOrderId: 'wo-1', // рахунок за нарядом
          counterpartyId: CP_ID,
          amount: 500,
          paidAmount: 0,
        })
        .mockResolvedValue({ ...findOneRow, workOrderId: 'wo-1' });
      prisma.invoice.updateMany.mockResolvedValue({ count: 1 });

      await service.transition(ORG, INV_ID, 'PAID' as never, 'user-1');
      // MUTATION-VERIFY: якби умова була лише `newStatus===PAID` без `workOrderId===null` —
      // WO-рахунок отримав би подвійний PAYMENT (CHARGE через COMPLETED + цей).
      expect(settlementsMock.createTransaction).not.toHaveBeenCalled();
    });

    it('non-PAID перехід (SENT→CANCELLED) НЕ пише paidAmount + без PAYMENT', async () => {
      prisma.invoice.findFirst
        .mockResolvedValueOnce({
          status: 'SENT',
          workOrderId: null,
          counterpartyId: CP_ID,
          amount: 500,
          paidAmount: 0,
        })
        .mockResolvedValue({ ...findOneRow, status: 'CANCELLED' });
      prisma.invoice.updateMany.mockResolvedValue({ count: 1 });

      await service.transition(ORG, INV_ID, 'CANCELLED' as never, 'user-1');

      const call = prisma.invoice.updateMany.mock.calls[0][0];
      expect(call.data).toEqual({ status: 'CANCELLED' });
      expect(call.data).not.toHaveProperty('paidAmount');
      expect(settlementsMock.createTransaction).not.toHaveBeenCalled();
    });
  });
});

// ─── Session 2026-09-06: toDto paidAmount column authority (Bug #676) ─────────
//
// toDto віддає РЕАЛЬНУ колонку paidAmount (авторитетну, транзакційно оновлювану), НЕ
// суму payments. Фолбек на Σpayments лише коли колонки немає у вибірці (старий шлях).
// PARTIALLY_PAID має коректно потрапляти у status відповіді.
describe('InvoicesService — toDto paidAmount authority (Bug #676)', () => {
  let service: InvoicesService;
  let prisma: { invoice: { findFirst: ReturnType<typeof vi.fn> } };

  const ORG = 'org-1';
  const INV_ID = '22222222-2222-4222-8222-222222222222';

  const baseInv = {
    id: INV_ID,
    orgId: ORG,
    number: 'INV-1',
    counterpartyId: 'c-1',
    workOrderId: null,
    invoiceType: 'INVOICE',
    notes: null,
    dueDate: null,
    documentDate: new Date('2026-01-01'),
    deletedAt: null,
    totalWithoutVat: 0,
    totalVat: 0,
    totalWithVat: 500,
    createdAt: new Date(),
    updatedAt: new Date(),
    counterparty: { firstName: null, lastName: null, companyName: 'ТОВ' },
    workOrder: null,
    lines: [],
  };

  beforeEach(async () => {
    prisma = { invoice: { findFirst: vi.fn() } };
    const module = await Test.createTestingModule({
      providers: [
        InvoicesService,
        { provide: PrismaService, useValue: prisma },
        { provide: DocumentNumberService, useValue: { next: vi.fn() } },
        { provide: PdfService, useValue: {} },
        { provide: SettlementsService, useValue: {} },
        {
          provide: SettingsService,
          useValue: {
            getDefaultVatRate: vi.fn().mockResolvedValue({ vatMode: 'NONE', vatRate: 0 }),
          },
        },
      ],
    }).compile();
    service = module.get(InvoicesService);
  });

  it('віддає paidAmount з колонки (200), навіть якщо Σpayments розходиться (999)', async () => {
    prisma.invoice.findFirst.mockResolvedValue({
      ...baseInv,
      status: 'PARTIALLY_PAID',
      amount: 500,
      paidAmount: 200, // авторитетна колонка
      payments: [{ amount: 999 }], // навмисно розбіжна сума — НЕ має вплинути
    });

    const dto = await service.findOne(ORG, INV_ID);

    expect(dto.paidAmount).toBe(200);
    expect(dto.status).toBe('PARTIALLY_PAID');
  });

  it('фолбек на Σpayments лише коли колонки paidAmount немає у вибірці', async () => {
    prisma.invoice.findFirst.mockResolvedValue({
      ...baseInv,
      status: 'SENT',
      amount: 500,
      paidAmount: null, // колонка відсутня → фолбек
      payments: [{ amount: 100 }, { amount: 50 }],
    });

    const dto = await service.findOne(ORG, INV_ID);

    expect(dto.paidAmount).toBe(150);
  });

  it('paidAmount=0 (колонка є, ще нічого не оплачено) → 0, не undefined/фолбек', async () => {
    prisma.invoice.findFirst.mockResolvedValue({
      ...baseInv,
      status: 'SENT',
      amount: 500,
      paidAmount: 0,
      payments: [{ amount: 777 }], // не має протекти
    });

    const dto = await service.findOne(ORG, INV_ID);

    expect(dto.paidAmount).toBe(0);
  });
});

// ─── Bug #A + edge inputs: getLinkedCounts / getLinkedDocuments ──────────────
describe('InvoicesService — linked-documents edge cases', () => {
  let service: InvoicesService;
  let prisma: {
    invoice: { findFirst: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
    workOrder: { findFirst: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
    counterparty: { findFirst: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
    payment: { findMany: ReturnType<typeof vi.fn>; groupBy: ReturnType<typeof vi.fn> };
  };

  const ORG = 'org-1';
  const OTHER_ORG = 'org-2';
  const A = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';
  const WO = '33333333-3333-4333-8333-333333333333';
  const CP = '44444444-4444-4444-8444-444444444444';

  beforeEach(async () => {
    prisma = {
      invoice: { findFirst: vi.fn(), findMany: vi.fn() },
      workOrder: { findFirst: vi.fn(), findMany: vi.fn() },
      counterparty: { findFirst: vi.fn(), findMany: vi.fn() },
      payment: { findMany: vi.fn(), groupBy: vi.fn() },
    };
    const module = await Test.createTestingModule({
      providers: [
        InvoicesService,
        { provide: PrismaService, useValue: prisma },
        { provide: DocumentNumberService, useValue: { next: vi.fn() } },
        { provide: PdfService, useValue: {} },
        { provide: SettlementsService, useValue: {} },
        {
          provide: SettingsService,
          useValue: {
            getDefaultVatRate: vi.fn().mockResolvedValue({ vatMode: 'NONE', vatRate: 0 }),
          },
        },
      ],
    }).compile();
    service = module.get(InvoicesService);
  });

  it('getLinkedCounts: zero-count id присутній у мапі з усіма нулями (не absent)', async () => {
    prisma.invoice.findMany.mockResolvedValue([{ id: A, workOrderId: null, counterpartyId: null }]);
    prisma.payment.groupBy.mockResolvedValue([]);
    prisma.workOrder.findMany.mockResolvedValue([]);
    prisma.counterparty.findMany.mockResolvedValue([]);

    const res = await service.getLinkedCounts(ORG, [A]);
    expect(res[A]).toEqual({ workOrder: 0, payments: 0, counterparty: 0 });
  });

  it('getLinkedCounts: duplicate ids у запиті не ламають мапу (keyed by id)', async () => {
    prisma.invoice.findMany.mockResolvedValue([{ id: A, workOrderId: WO, counterpartyId: CP }]);
    prisma.payment.groupBy.mockResolvedValue([{ invoiceId: A, _count: { id: 3 } }]);
    prisma.workOrder.findMany.mockResolvedValue([{ id: WO }]);
    prisma.counterparty.findMany.mockResolvedValue([{ id: CP }]);

    const res = await service.getLinkedCounts(ORG, [A, A, A]);
    expect(Object.keys(res)).toEqual([A]);
    expect(res[A]).toEqual({ workOrder: 1, payments: 3, counterparty: 1 });
  });

  it('getLinkedCounts: cross-org id → всі нулі, чужі дані не протікають', async () => {
    // findMany scoped by orgId → чужий рахунок не повертається.
    prisma.invoice.findMany.mockResolvedValue([]);
    prisma.payment.groupBy.mockResolvedValue([]);
    prisma.workOrder.findMany.mockResolvedValue([]);
    prisma.counterparty.findMany.mockResolvedValue([]);

    const res = await service.getLinkedCounts(OTHER_ORG, [A, B]);
    expect(res[A]).toEqual({ workOrder: 0, payments: 0, counterparty: 0 });
    expect(res[B]).toEqual({ workOrder: 0, payments: 0, counterparty: 0 });
    // orgId дійсно у where групуючого запиту
    expect(prisma.invoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ orgId: OTHER_ORG }) }),
    );
  });

  it('Bug #A: soft-deleted контрагент → count=0 (відповідає порожній detail-секції)', async () => {
    // FK присутній, але counterparty.findMany (deletedAt:null) НЕ повертає його.
    prisma.invoice.findMany.mockResolvedValue([{ id: A, workOrderId: WO, counterpartyId: CP }]);
    prisma.payment.groupBy.mockResolvedValue([]);
    prisma.workOrder.findMany.mockResolvedValue([{ id: WO }]);
    prisma.counterparty.findMany.mockResolvedValue([]); // CP soft-deleted → не в живому наборі

    const res = await service.getLinkedCounts(ORG, [A]);
    // Дискримінатор: старий код давав counterparty:1 (inv.counterpartyId ? 1 : 0).
    expect(res[A].counterparty).toBe(0);
    expect(res[A].workOrder).toBe(1);
  });

  it('getLinkedDocuments: cross-org id → порожні секції, не чужі дані', async () => {
    prisma.invoice.findFirst.mockResolvedValue(null); // findFirst orgId-scoped → null
    const res = await service.getLinkedDocuments(OTHER_ORG, A);
    expect(res).toEqual({ workOrder: [], payments: [], counterparty: [] });
    expect(prisma.payment.findMany).not.toHaveBeenCalled();
  });
});
