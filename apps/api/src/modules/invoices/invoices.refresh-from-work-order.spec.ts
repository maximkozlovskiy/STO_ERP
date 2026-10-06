/**
 * InvoicesService.refreshFromWorkOrder — status guard, ПДВ з налаштувань, atomic recalc, Serializable re-check
 *
 * Виділено з `invoices.service.spec.ts` (був 1244 рядки; 1011 з них — ОДИН top-level
 * describe із 10 вкладеними під спільним 85-рядковим beforeEach) 2026-10-06.
 * Кейси перенесені ДОСЛІВНО; вкладені describe підняті на top-level, тому їхній
 * `fullName` втратив префікс 'InvoicesService — business logic guards' — єдина
 * свідома зміна, baseline оновлено відповідно.
 *
 * Сетап — `makeInvoicesHarness()` з `./invoices.spec-fixture` (той самий beforeEach).
 */

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  makeInvoicesHarness,
  ORG,
  WO_ID,
  INV_ID,
  type InvoicesHarness,
} from './invoices.spec-fixture';

describe('InvoicesService — refresh-from-work-order', () => {
  // Деструктуризація у ТІ САМІ імена, що були у вихідному beforeEach — щоб жоден
  // it() не правився (інакше це вже не «перенесено дослівно»).
  let service: InvoicesHarness['service'];
  let prisma: InvoicesHarness['prisma'];
  let settingsMock: InvoicesHarness['settings'];

  beforeEach(async () => {
    ({ service, prisma, settings: settingsMock } = await makeInvoicesHarness());
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
});
