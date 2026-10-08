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
import { describe, it, expect, vi } from 'vitest';
import {
  makeInvoicesHarness,
  ORG,
  WO_ID,
  INV_ID,
  type InvoicesHarness,
} from './invoices.spec-fixture';

type Fn = ReturnType<typeof vi.fn>;

describe('InvoicesService — create-from-work-order', () => {
  // Деструктуризація у ТІ САМІ імена, що були у вихідному beforeEach — щоб жоден
  // it() не правився (інакше це вже не «перенесено дослівно»).
  let service: InvoicesHarness['service'];
  let prisma: InvoicesHarness['prisma'];
  let settingsMock: InvoicesHarness['settings'];
  let exchangeRates: InvoicesHarness['exchangeRates'];

  beforeEach(async () => {
    ({ service, prisma, settings: settingsMock, exchangeRates } = await makeInvoicesHarness());
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
        // Наряд читається двічі: pre-check (статус) і в транзакції (тотали й рядки, BR-INV-002) —
        // рядки мусять сходитися з сумою, інакше рахунок не створюється.
        totalNet: 500,
        totalAmount: 500,
        lines: [
          { workId: 'w-1', price: 500, normoHours: 1, actualHours: null, work: { name: 'Р' } },
        ],
        parts: [],
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

  // ─── BR-INV-002: рядки й сума рахунку — одразу, у транзакції створення ───────
  //
  // Тут `$transaction` віддає ОКРЕМИЙ об'єкт tx (у фікстурі tx === prisma): інакше не видно,
  // чи рядки пишуться клієнтом транзакції, чи поза нею.
  describe('createFromWorkOrder — рядки й сума з наряду в тій самій транзакції (BR-INV-002)', () => {
    type WoInTx = {
      totalNet: number;
      totalAmount: number;
      lines: Record<string, unknown>[];
      parts: Record<string, unknown>[];
    };
    // 2 год × 100 + 1 шт × 500 = 700; ПДВ зверху 20% → до сплати 840.
    const WO_EXCL: WoInTx = {
      totalNet: 700,
      totalAmount: 840,
      lines: [
        { workId: 'w-1', price: 100, normoHours: 2, actualHours: null, work: { name: 'Робота 1' } },
      ],
      parts: [{ goodId: 'g-1', price: 500, quantity: 1, good: { name: 'Запчастина 1' } }],
    };

    function arrange(woInTx: WoInTx | null, currencyId: string | null = null) {
      const order: string[] = [];
      const step = <T>(name: string, value: T) =>
        vi.fn().mockImplementation(() => {
          order.push(name);
          return Promise.resolve(value);
        });
      const tx = {
        invoice: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: step('create', { id: INV_ID }),
          update: step('update', {}),
          findFirstOrThrow: step('reread', {
            id: INV_ID,
            number: 'INV-1',
            status: 'DRAFT',
            amount: woInTx?.totalAmount ?? 0,
            workOrderId: WO_ID,
            counterpartyId: 'c-1',
            documentDate: new Date(),
            dueDate: null,
            deletedAt: null,
            totalWithoutVat: woInTx?.totalNet ?? 0,
            totalVat: 0,
            totalWithVat: woInTx?.totalAmount ?? 0,
            createdAt: new Date(),
            counterparty: { firstName: 'a', lastName: 'b', companyName: null },
            workOrder: { number: 'WO-1' },
          }),
        },
        invoiceLine: { createMany: step('createMany', { count: 0 }) },
        workOrder: { findFirst: vi.fn().mockResolvedValue(woInTx) },
      };
      // pre-check поза транзакцією: статус і валюта наряду.
      prisma.workOrder.findFirst.mockResolvedValue({
        id: WO_ID,
        status: 'COMPLETED',
        counterpartyId: 'c-1',
        currencyId,
      });
      prisma.invoice.findFirst.mockResolvedValue(null);
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
    const updateArg = (tx: { invoice: { update: Fn } }) =>
      tx.invoice.update.mock.calls[0][0] as { where: unknown; data: Record<string, unknown> };

    // guards: BR-INV-002
    it('рядки наряду пишуться клієнтом ТІЄЇ САМОЇ транзакції, що створила рахунок, до її завершення', async () => {
      settingsMock.getDefaultVatRate.mockResolvedValue({ vatMode: 'EXCLUSIVE', vatRate: 20 });
      const { tx, order } = arrange(WO_EXCL);

      await service.createFromWorkOrder(ORG, WO_ID);

      expect(order).toEqual(['tx-begin', 'create', 'createMany', 'update', 'reread', 'tx-commit']);
      expect(tx.invoiceLine.createMany).toHaveBeenCalledTimes(1);
      const data = lineData(tx);
      expect(data).toHaveLength(2);
      for (const l of data) expect(l).toMatchObject({ orgId: ORG, invoiceId: INV_ID });
      expect(data.map(l => l.description)).toEqual(['Робота 1', 'Запчастина 1']);
      // Поза транзакцією — жодного запису рахунку чи рядків.
      expect(prisma.invoice.create).not.toHaveBeenCalled();
      expect(prisma.invoiceLine.createMany).not.toHaveBeenCalled();
      expect(prisma.invoice.update).not.toHaveBeenCalled();
    });

    // guards: BR-INV-002
    it('сума рахунку = сума наряду до сплати: amount = totalWithVat = wo.totalAmount, totalWithoutVat = wo.totalNet', async () => {
      settingsMock.getDefaultVatRate.mockResolvedValue({ vatMode: 'EXCLUSIVE', vatRate: 20 });
      const { tx } = arrange(WO_EXCL);

      await service.createFromWorkOrder(ORG, WO_ID);

      const upd = updateArg(tx);
      expect(upd.where).toEqual({ id: INV_ID, orgId: ORG });
      expect(upd.data).toMatchObject({
        amount: 840,
        totalWithVat: 840,
        totalWithoutVat: 700,
        totalVat: 140,
        // базова валюта: base-сума = сума до сплати, курс 1
        totalAmountBase: 840,
        rateUsed: 1,
      });
      // Σ рядків = сума рахунку.
      const data = lineData(tx) as { priceWithVat: number; priceWithoutVat: number }[];
      expect(data.reduce((s, l) => s + l.priceWithVat, 0)).toBe(840);
      expect(data.reduce((s, l) => s + l.priceWithoutVat, 0)).toBe(700);
    });

    // guards: BR-INV-002
    it('режим ПДВ рядків визначає наряд: налаштування «ПДВ зверху 20%», наряд без ПДВ у сумі → рахунок на 700 без ПДВ', async () => {
      settingsMock.getDefaultVatRate.mockResolvedValue({ vatMode: 'EXCLUSIVE', vatRate: 20 });
      const { tx } = arrange({ ...WO_EXCL, totalNet: 700, totalAmount: 700 });

      await service.createFromWorkOrder(ORG, WO_ID);

      for (const l of lineData(tx)) {
        expect(l.vatRate).toBe(0);
        expect(l.vatAmount).toBe(0);
      }
      expect(updateArg(tx).data).toMatchObject({ amount: 700, totalWithVat: 700, totalVat: 0 });
    });

    // guards: BR-INV-002
    it('кількість роботи = фактичні години, якщо задані (0 — теж значення), інакше нормо-години', async () => {
      const { tx } = arrange({
        totalNet: 300,
        totalAmount: 300,
        lines: [
          { workId: 'w-1', price: 100, normoHours: 2, actualHours: 3, work: { name: 'А' } },
          { workId: 'w-2', price: 100, normoHours: 5, actualHours: 0, work: { name: 'Б' } },
        ],
        parts: [],
      });

      await service.createFromWorkOrder(ORG, WO_ID);

      expect(lineData(tx).map(l => [l.quantity, l.unitPrice, l.priceWithVat])).toEqual([
        [3, 100, 300],
        [0, 100, 0],
      ]);
    });

    // guards: BR-INV-002
    it('наряд у транзакції читається у межах orgId; зник між pre-check і транзакцією → 404, запис відкочується', async () => {
      const { tx, order } = arrange(null);

      await expect(service.createFromWorkOrder(ORG, WO_ID)).rejects.toThrow(NotFoundException);

      expect(tx.workOrder.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: WO_ID, orgId: ORG, deletedAt: null } }),
      );
      expect(order).toEqual(['tx-begin', 'create', 'tx-rollback']);
    });

    // Bug #814: порядок рядків рахунку = порядок рядків наряду. Без orderBy «останній рядок», що
    // забирає копійку округлення, був випадковим. Mutation-verify: прибрати orderBy → падає.
    // guards: BR-INV-002
    it('рядки наряду читаються в порядку введення (createdAt, далі id): роботи й запчастини', async () => {
      settingsMock.getDefaultVatRate.mockResolvedValue({ vatMode: 'EXCLUSIVE', vatRate: 20 });
      const { tx } = arrange(WO_EXCL);

      await service.createFromWorkOrder(ORG, WO_ID);

      const select = (
        tx.workOrder.findFirst.mock.calls[0][0] as {
          select: { lines: { orderBy: unknown }; parts: { orderBy: unknown } };
        }
      ).select;
      const byEntry = [{ createdAt: 'asc' }, { id: 'asc' }];
      expect(select.lines.orderBy).toEqual(byEntry);
      expect(select.parts.orderBy).toEqual(byEntry);
    });

    // guards: BR-INV-002
    it('тотали наряду не відповідають рядкам → 400 ЗСЕРЕДИНИ транзакції: рахунок не лишається, рядки й суми не пишуться', async () => {
      // Рядки на 700, а наряд каже 1000 — це не копійки округлення.
      const { tx, order } = arrange({ ...WO_EXCL, totalNet: 1000, totalAmount: 1000 });

      await expect(service.createFromWorkOrder(ORG, WO_ID)).rejects.toThrow(BadRequestException);

      // create уже відбувся в tx — тож помилка мусить вийти з колбека, щоб Prisma його відкотила.
      expect(order).toEqual(['tx-begin', 'create', 'tx-rollback']);
      expect(tx.invoiceLine.createMany).not.toHaveBeenCalled();
      expect(tx.invoice.update).not.toHaveBeenCalled();
    });

    // guards: BR-INV-002
    it('наряд у валюті: base-сума рахунку = сума до сплати × курс на дату рахунку', async () => {
      settingsMock.getDefaultVatRate.mockResolvedValue({ vatMode: 'EXCLUSIVE', vatRate: 20 });
      const { tx } = arrange(WO_EXCL, 'cur-usd');
      exchangeRates.resolveBaseConversion.mockImplementation(
        (_o: string, _c: string, _d: Date, amount: number) =>
          Promise.resolve({ rateUsed: 40, amountBase: amount * 40 }),
      );

      await service.createFromWorkOrder(ORG, WO_ID);

      const documentDate = tx.invoice.create.mock.calls[0][0].data.documentDate as Date;
      expect(exchangeRates.resolveBaseConversion).toHaveBeenCalledWith(
        ORG,
        'cur-usd',
        documentDate,
        840,
        true,
      );
      expect(updateArg(tx).data).toMatchObject({ totalAmountBase: 33_600, rateUsed: 40 });
    });

    // guards: BR-INV-002
    it('порожній наряд із нульовою сумою → рахунок на 0 без рядків (createMany не кличеться)', async () => {
      const { tx } = arrange({ totalNet: 0, totalAmount: 0, lines: [], parts: [] });

      await service.createFromWorkOrder(ORG, WO_ID);

      expect(tx.invoiceLine.createMany).not.toHaveBeenCalled();
      expect(updateArg(tx).data).toMatchObject({ amount: 0, totalWithVat: 0, totalWithoutVat: 0 });
    });
  });
});
