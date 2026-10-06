/**
 * InvoicesService.findByWorkOrder (Bug #405)
 *
 * Виділено з `invoices.service.spec.ts` (був 1244 рядки; 1011 з них — ОДИН top-level
 * describe із 10 вкладеними під спільним 85-рядковим beforeEach) 2026-10-06.
 * Кейси перенесені ДОСЛІВНО; вкладені describe підняті на top-level, тому їхній
 * `fullName` втратив префікс 'InvoicesService — business logic guards' — єдина
 * свідома зміна, baseline оновлено відповідно.
 *
 * Сетап — `makeInvoicesHarness()` з `./invoices.spec-fixture` (той самий beforeEach).
 */

import { describe, it, expect } from 'vitest';
import {
  makeInvoicesHarness,
  ORG,
  WO_ID,
  INV_ID,
  type InvoicesHarness,
} from './invoices.spec-fixture';

describe('InvoicesService — find-by-work-order', () => {
  // Деструктуризація у ТІ САМІ імена, що були у вихідному beforeEach — щоб жоден
  // it() не правився (інакше це вже не «перенесено дослівно»).
  let service: InvoicesHarness['service'];
  let prisma: InvoicesHarness['prisma'];

  beforeEach(async () => {
    ({ service, prisma } = await makeInvoicesHarness());
  });

  // ─── Bug #405: findByWorkOrder returns null (not 404) ───────────────────

  describe('findByWorkOrder — Bug #405', () => {
    it('повертає null коли активного invoice немає', async () => {
      prisma.invoice.findFirst.mockResolvedValue(null);
      const result = await service.findByWorkOrder(ORG, WO_ID);
      expect(result).toBeNull();
    });

    it('повертає { id, number, status, amount, currency*, documentDate } коли invoice існує (Bug #508)', async () => {
      // Сервіс розширено: findByWorkOrder() віддає 8 полів для invoice slot у картці
      // наряду — status badge, сума, валюта (Фаза 3: currencyCode/totalAmountBase/rateUsed
      // для foreign+base пари), дата документу. Mock ОБОВ'ЯЗКОВО повертає shape що Prisma
      // реально віддасть (Decimal для amount, Date для documentDate).
      prisma.invoice.findFirst.mockResolvedValue({
        id: INV_ID,
        number: 'INV-1',
        status: 'DRAFT',
        amount: 200,
        totalAmountBase: null,
        rateUsed: null,
        currency: null,
        documentDate: new Date('2026-01-15T00:00:00.000Z'),
      });
      const result = await service.findByWorkOrder(ORG, WO_ID);
      expect(result).toEqual({
        id: INV_ID,
        number: 'INV-1',
        status: 'DRAFT',
        amount: 200,
        currencyCode: null,
        totalAmountBase: null,
        rateUsed: null,
        documentDate: '2026-01-15T00:00:00.000Z',
      });
    });

    it('повертає валютні поля (currencyCode/totalAmountBase/rateUsed) для інвалютного рахунку (Фаза 3)', async () => {
      prisma.invoice.findFirst.mockResolvedValue({
        id: INV_ID,
        number: 'INV-1',
        status: 'SENT',
        amount: 100,
        totalAmountBase: 4150,
        rateUsed: 41.5,
        currency: { code: 'USD' },
        documentDate: new Date('2026-01-15T00:00:00.000Z'),
      });
      const result = await service.findByWorkOrder(ORG, WO_ID);
      expect(result).toEqual({
        id: INV_ID,
        number: 'INV-1',
        status: 'SENT',
        amount: 100,
        currencyCode: 'USD',
        totalAmountBase: 4150,
        rateUsed: 41.5,
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
        totalAmountBase: null,
        rateUsed: null,
        currency: null,
        documentDate: null,
      });
      const result = await service.findByWorkOrder(ORG, WO_ID);
      expect(result).toEqual({
        id: INV_ID,
        number: 'INV-1',
        status: 'DRAFT',
        amount: 200,
        currencyCode: null,
        totalAmountBase: null,
        rateUsed: null,
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
});
