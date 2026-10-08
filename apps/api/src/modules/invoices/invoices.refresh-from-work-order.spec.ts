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
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  makeInvoicesHarness,
  ORG,
  WO_ID,
  INV_ID,
  type InvoicesHarness,
} from './invoices.spec-fixture';

/**
 * Bug #413: Service-level spec для guards що додані review-фіксами #403, #406, #407, #412.
 * Contract spec мокає сервіс — НЕ перевіряє business logic. Цей файл — regression-guard.
 */
describe('InvoicesService — refresh-from-work-order', () => {
  // Деструктуризація у ТІ САМІ імена, що були у вихідному beforeEach — щоб жоден
  // it() не правився (інакше це вже не «перенесено дослівно»).
  let service: InvoicesHarness['service'];
  let prisma: InvoicesHarness['prisma'];
  let settingsMock: InvoicesHarness['settings'];
  let exchangeRates: InvoicesHarness['exchangeRates'];

  beforeEach(async () => {
    ({ service, prisma, settings: settingsMock, exchangeRates } = await makeInvoicesHarness());
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
    // guards: BR-INV-007
    it('EXCLUSIVE 20% → створює invoice lines з vatRate=20 для робіт і запчастин', async () => {
      // Раніше vatRate був хардкод 20 незалежно від org; тепер береться з getDefaultVatRate.
      settingsMock.getDefaultVatRate.mockResolvedValue({ vatMode: 'EXCLUSIVE', vatRate: 20 });
      prisma.workOrder.findFirst.mockResolvedValue({
        id: WO_ID,
        orgId: ORG,
        status: 'COMPLETED',
        counterpartyId: 'c-1',
        // Тотали наряду «ПДВ зверху» (BR-WO-007): 700 без ПДВ + 140 ПДВ = 840 до сплати.
        totalNet: 700,
        totalAmount: 840,
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
        // Наряд без ПДВ (BR-WO-007): обидві суми = сума рядків (200 + 500).
        totalNet: 700,
        totalAmount: 700,
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
        totalNet: 100,
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

  // ─── BR-INV-002: «Оновити з наряду» — той самий код рядків і сум, що й створення ───
  //
  // `$transaction` тут віддає ОКРЕМИЙ об'єкт tx (у фікстурі tx === prisma): видно, що старі
  // рядки зносяться, нові пишуться і суми оновлюються одним клієнтом транзакції.
  describe('refreshFromWorkOrder — рядки й сума з наряду, base-сума і курс (BR-INV-002)', () => {
    type Fn = ReturnType<typeof vi.fn>;
    const DOC_DATE = new Date('2026-09-15');
    // 2 год × 100 + 1 шт × 500 = 700; ПДВ зверху 20% → до сплати 840.
    const WO_EXCL = {
      totalNet: 700,
      totalAmount: 840,
      lines: [
        { workId: 'w-1', price: 100, normoHours: 2, actualHours: null, work: { name: 'Робота 1' } },
      ],
      parts: [{ goodId: 'g-1', price: 500, quantity: 1, good: { name: 'Запчастина 1' } }],
    };

    function arrange(woInTx: typeof WO_EXCL, currencyId: string | null = null) {
      const order: string[] = [];
      const step = <T>(name: string, value: T) =>
        vi.fn().mockImplementation(() => {
          order.push(name);
          return Promise.resolve(value);
        });
      const tx = {
        invoice: {
          findFirst: vi
            .fn()
            .mockResolvedValue({ status: 'DRAFT', currencyId, documentDate: DOC_DATE }),
          update: step('update', {}),
        },
        invoiceLine: {
          deleteMany: step('deleteMany', { count: 3 }),
          createMany: step('createMany', { count: 2 }),
        },
        workOrder: { findFirst: vi.fn().mockResolvedValue(woInTx) },
      };
      prisma.workOrder.findFirst.mockResolvedValue({ id: WO_ID, status: 'COMPLETED' });
      // 1-й findFirst — pre-check активного рахунку; 2-й — findOne після транзакції.
      prisma.invoice.findFirst
        .mockResolvedValueOnce({ id: INV_ID, status: 'DRAFT' })
        .mockResolvedValueOnce({
          id: INV_ID,
          orgId: ORG,
          number: 'INV-1',
          status: 'DRAFT',
          counterpartyId: 'c-1',
          workOrderId: WO_ID,
          amount: woInTx.totalAmount,
          totalWithoutVat: woInTx.totalNet,
          totalVat: 0,
          totalWithVat: woInTx.totalAmount,
          invoiceType: 'STANDARD',
          notes: null,
          dueDate: null,
          documentDate: DOC_DATE,
          createdAt: new Date(),
          updatedAt: new Date(),
          lines: [],
          payments: [],
        });
      prisma.$transaction.mockImplementation(async (cb: (t: unknown) => Promise<unknown>) => {
        order.push('tx-begin');
        try {
          const res = await cb(tx);
          order.push('tx-commit');
          return res;
        } catch (err) {
          order.push('tx-rollback');
          throw err;
        }
      });
      return { tx, order };
    }

    const lineData = (tx: { invoiceLine: { createMany: Fn } }) =>
      tx.invoiceLine.createMany.mock.calls[0][0].data as Record<string, unknown>[];
    const updateData = (tx: { invoice: { update: Fn } }) =>
      tx.invoice.update.mock.calls[0][0].data as Record<string, unknown>;

    // guards: BR-INV-002
    it('старі рядки зносяться, нові пишуться і суми оновлюються в одній транзакції; сума = wo.totalAmount', async () => {
      settingsMock.getDefaultVatRate.mockResolvedValue({ vatMode: 'EXCLUSIVE', vatRate: 20 });
      const { tx, order } = arrange(WO_EXCL);

      await service.refreshFromWorkOrder(ORG, WO_ID);

      expect(order).toEqual(['tx-begin', 'deleteMany', 'createMany', 'update', 'tx-commit']);
      expect(tx.invoiceLine.deleteMany).toHaveBeenCalledWith({
        where: { invoiceId: INV_ID, orgId: ORG },
      });
      const data = lineData(tx) as { priceWithVat: number; invoiceId: string; orgId: string }[];
      expect(data).toHaveLength(2);
      for (const l of data) expect(l).toMatchObject({ orgId: ORG, invoiceId: INV_ID });
      expect(data.reduce((s, l) => s + l.priceWithVat, 0)).toBe(840);
      expect(updateData(tx)).toMatchObject({
        amount: 840,
        totalWithVat: 840,
        totalWithoutVat: 700,
        totalVat: 140,
      });
      expect(tx.invoice.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: INV_ID, orgId: ORG } }),
      );
      // Поза транзакцією рядки й суми не чіпаються.
      expect(prisma.invoiceLine.deleteMany).not.toHaveBeenCalled();
      expect(prisma.invoiceLine.createMany).not.toHaveBeenCalled();
      expect(prisma.invoice.update).not.toHaveBeenCalled();
    });

    // guards: BR-INV-002
    it('оновлює суму в базовій валюті та курс: валюта й дата — рахунку, сума — наряду до сплати', async () => {
      settingsMock.getDefaultVatRate.mockResolvedValue({ vatMode: 'EXCLUSIVE', vatRate: 20 });
      const { tx } = arrange(WO_EXCL, 'cur-usd');
      exchangeRates.resolveBaseConversion.mockImplementation(
        (_o: string, _c: string, _d: Date, amount: number) =>
          Promise.resolve({ rateUsed: 41.5, amountBase: amount * 41.5 }),
      );

      await service.refreshFromWorkOrder(ORG, WO_ID);

      expect(exchangeRates.resolveBaseConversion).toHaveBeenCalledTimes(1);
      expect(exchangeRates.resolveBaseConversion).toHaveBeenCalledWith(
        ORG,
        'cur-usd',
        DOC_DATE,
        840,
        true,
      );
      expect(updateData(tx)).toMatchObject({ totalAmountBase: 34_860, rateUsed: 41.5 });
    });

    // guards: BR-INV-002
    it('рахунок у базовій валюті: base-сума = нова сума до сплати, курс 1 (стара base-сума не лишається)', async () => {
      settingsMock.getDefaultVatRate.mockResolvedValue({ vatMode: 'EXCLUSIVE', vatRate: 20 });
      const { tx } = arrange(WO_EXCL);

      await service.refreshFromWorkOrder(ORG, WO_ID);

      expect(exchangeRates.resolveBaseConversion).not.toHaveBeenCalled();
      expect(updateData(tx)).toMatchObject({ totalAmountBase: 840, rateUsed: 1 });
    });

    // guards: BR-INV-002
    it('режим ПДВ рядків визначає наряд: налаштування «ПДВ зверху 20%», наряд без ПДВ у сумі → 700 без ПДВ', async () => {
      settingsMock.getDefaultVatRate.mockResolvedValue({ vatMode: 'EXCLUSIVE', vatRate: 20 });
      const { tx } = arrange({ ...WO_EXCL, totalNet: 700, totalAmount: 700 });

      await service.refreshFromWorkOrder(ORG, WO_ID);

      for (const l of lineData(tx)) {
        expect(l.vatRate).toBe(0);
        expect(l.vatAmount).toBe(0);
      }
      expect(updateData(tx)).toMatchObject({ amount: 700, totalWithVat: 700, totalVat: 0 });
    });

    // guards: BR-INV-002
    it('тотали наряду не відповідають рядкам → 400 ЗСЕРЕДИНИ транзакції: старі рядки не втрачаються, суми не пишуться', async () => {
      const { tx, order } = arrange({ ...WO_EXCL, totalNet: 1000, totalAmount: 1000 });

      await expect(service.refreshFromWorkOrder(ORG, WO_ID)).rejects.toThrow(BadRequestException);

      // deleteMany уже відбувся в tx — помилка мусить вийти з колбека, щоб Prisma його відкотила.
      expect(order).toEqual(['tx-begin', 'deleteMany', 'tx-rollback']);
      expect(tx.invoiceLine.createMany).not.toHaveBeenCalled();
      expect(tx.invoice.update).not.toHaveBeenCalled();
    });
  });
});
