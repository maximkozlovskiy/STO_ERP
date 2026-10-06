/**
 * InvoicesService.transition — CHARGE для standalone і дзеркальний PAYMENT
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

describe('InvoicesService — transition-settlements', () => {
  // Деструктуризація у ТІ САМІ імена, що були у вихідному beforeEach — щоб жоден
  // it() не правився (інакше це вже не «перенесено дослівно»).
  let service: InvoicesHarness['service'];
  let prisma: InvoicesHarness['prisma'];
  let settlementsMock: InvoicesHarness['settlements'];
  let exchangeRatesMockRef: InvoicesHarness['exchangeRates'];

  beforeEach(async () => {
    ({
      service,
      prisma,
      settlements: settlementsMock,
      exchangeRates: exchangeRatesMockRef,
    } = await makeInvoicesHarness());
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

    // Мультивалюта (Фаза 3): CHARGE пробрасує currencyId + date + fallbackToLatest → борг у base.
    it('standalone у валюті DRAFT→SENT → CHARGE з currencyId + date + fallbackToLatest', async () => {
      const USD = 'usd-1111-1111-1111-111111111111';
      const docDate = new Date('2026-02-01');
      prisma.invoice.findFirst
        .mockResolvedValueOnce({
          status: 'DRAFT',
          workOrderId: null,
          counterpartyId: CP_ID,
          amount: 100,
          currencyId: USD,
          documentDate: docDate,
        })
        .mockResolvedValue(findOneRow);
      prisma.invoice.updateMany.mockResolvedValue({ count: 1 });
      await service.transition(ORG, INV_ID, 'SENT' as never, 'user-1');
      expect(settlementsMock.createTransaction).toHaveBeenCalledWith(
        ORG,
        expect.objectContaining({
          type: 'CHARGE',
          amount: 100,
          currencyId: USD,
          date: docDate,
          fallbackToLatest: true,
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

    // Bug #745: іновалютний standalone-рахунок з ЧАСТКОВИМИ реальними оплатами (різні курси),
    // вручну переведений PARTIALLY_PAID→PAID, мусить визнати курсову різницю (FX_GAIN/FX_LOSS),
    // інакше base-залишок ≠ 0 (Σчасткові×(r_doc−r_pay) висить). До фіксу цей шлях FX не бронював.
    it('іновалютний standalone PARTIALLY_PAID→PAID: FX-проводка обнуляє base-залишок (Bug #745)', async () => {
      const USD = 'usd-2222-2222-2222-222222222222';
      prisma.invoice.findFirst
        .mockResolvedValueOnce({
          status: 'PARTIALLY_PAID',
          workOrderId: null,
          counterpartyId: CP_ID,
          amount: 100, // USD
          paidAmount: 60, // 60 USD уже сплачено через payments-модуль (курс дати оплати)
          currencyId: USD,
          documentDate: new Date('2026-01-01'),
        })
        .mockResolvedValue({ ...findOneRow, currencyId: USD });
      prisma.invoice.updateMany.mockResolvedValue({ count: 1 });
      // Валюта НЕ базова → FX-гілка активна.
      exchangeRatesMockRef.getBaseCurrency.mockResolvedValue({ id: 'uah-base', code: 'UAH' });
      // Леджер по рахунку: CHARGE base=4150 (100 USD × 41.5 курс документа); дзеркальний PAYMENT
      // (40 USD × 41.5 = 1660, base) — payAgg. Реальні часткові: 60 USD × 42.0 = 2520 (курс оплати).
      // Base-залишок = 4150 − 1660 − 2520 = −30 → отримали більше base → FX_GAIN 30.
      prisma.settlementTransaction.count.mockResolvedValue(0);
      prisma.settlementTransaction.aggregate
        .mockResolvedValueOnce({ _sum: { amountBase: 4150 } }) // CHARGE
        .mockResolvedValueOnce({ _sum: { amountBase: 1660 } }); // дзеркальний PAYMENT
      prisma.payment.aggregate.mockResolvedValue({ _sum: { amountBase: 2520 } }); // реальні часткові

      await service.transition(ORG, INV_ID, 'PAID' as never, 'user-1');

      const fxCall = settlementsMock.createTransaction.mock.calls.find(
        (c: unknown[]) =>
          (c[1] as { type?: string })?.type === 'FX_GAIN' ||
          (c[1] as { type?: string })?.type === 'FX_LOSS',
      );
      expect(fxCall, 'FX-проводка має бути створена для іновалютного ручного →PAID').toBeDefined();
      expect(fxCall![1]).toMatchObject({
        type: 'FX_GAIN',
        amount: 30,
        documentType: 'Invoice',
        documentId: INV_ID,
      });
      // FX БЕЗ currencyId → base-дельта (rate=1), інакше re-конвертація зіпсує суму.
      expect((fxCall![1] as { currencyId?: unknown }).currencyId).toBeUndefined();
    });

    it('іновалютний ручний →PAID, FX вже проведено (count>0) → повторно НЕ бронюється (Bug #745 idempotency)', async () => {
      const USD = 'usd-2222-2222-2222-222222222222';
      prisma.invoice.findFirst
        .mockResolvedValueOnce({
          status: 'PARTIALLY_PAID',
          workOrderId: null,
          counterpartyId: CP_ID,
          amount: 100,
          paidAmount: 60,
          currencyId: USD,
          documentDate: new Date('2026-01-01'),
        })
        .mockResolvedValue({ ...findOneRow, currencyId: USD });
      prisma.invoice.updateMany.mockResolvedValue({ count: 1 });
      exchangeRatesMockRef.getBaseCurrency.mockResolvedValue({ id: 'uah-base', code: 'UAH' });
      prisma.settlementTransaction.count.mockResolvedValue(1); // FX уже існує

      await service.transition(ORG, INV_ID, 'PAID' as never, 'user-1');

      const fxCall = settlementsMock.createTransaction.mock.calls.find(
        (c: unknown[]) =>
          (c[1] as { type?: string })?.type === 'FX_GAIN' ||
          (c[1] as { type?: string })?.type === 'FX_LOSS',
      );
      expect(fxCall).toBeUndefined();
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
