/**
 * InvoicesService.createFromWorkOrder — serializable race + dueDate
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
import { describe, it, expect } from 'vitest';
import {
  makeInvoicesHarness,
  ORG,
  WO_ID,
  INV_ID,
  type InvoicesHarness,
} from './invoices.spec-fixture';

describe('InvoicesService — create-from-work-order', () => {
  // Деструктуризація у ТІ САМІ імена, що були у вихідному beforeEach — щоб жоден
  // it() не правився (інакше це вже не «перенесено дослівно»).
  let service: InvoicesHarness['service'];
  let prisma: InvoicesHarness['prisma'];
  let settingsMock: InvoicesHarness['settings'];

  beforeEach(async () => {
    ({ service, prisma, settings: settingsMock } = await makeInvoicesHarness());
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

  // createFromWorkOrder також резолвить dueDate через invoiceDueDays (обчислюється ПОЗА
  // Serializable tx). Раніше dueDate був завжди null для WO-рахунків (§13 config gap).
  describe('createFromWorkOrder — dueDate за invoiceDueDays (§13)', () => {
    // guards: BR-INV-004
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
});
