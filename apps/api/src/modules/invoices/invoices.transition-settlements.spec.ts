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
import { BadRequestException } from '@nestjs/common';
import { translateError } from '@sto/shared';
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
          _count: { lines: 1 },
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
          _count: { lines: 1 },
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
          _count: { lines: 1 },
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
        _count: { lines: 1 },
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

    // guards: BR-INV-006, BR-INV-012
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

    // guards: BR-INV-012
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

    // guards: BR-INV-012
    // F6 (аудит 2026-10-24): CAS має ловити й паралельну ОПЛАТУ, не лише зміну статусу. Якщо
    // payments-модуль збільшив paidAmount між findFirst і updateMany, where містить paidAmount
    // (=стальне значення) → count=0 → statusChanged, а дзеркальний PAYMENT на застарілий залишок
    // НЕ створюється (інакше фантомний кредит клієнта в ledger).
    it('OVERDUE→PAID: паралельна оплата (updateMany count=0) → statusChanged, PAYMENT не створюється', async () => {
      prisma.invoice.findFirst.mockResolvedValueOnce({
        status: 'OVERDUE',
        workOrderId: null,
        counterpartyId: CP_ID,
        amount: 500,
        paidAmount: 200, // стальне значення на момент читання
      });
      // Паралельна оплата зсунула paidAmount → where {paidAmount:200} не збігся.
      prisma.invoice.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.transition(ORG, INV_ID, 'PAID' as never, 'user-1')).rejects.toThrow(
        /змінився/,
      );
      // where CAS мусить містити paidAmount — інакше паралельна оплата не детектиться (F6).
      expect(prisma.invoice.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: 'OVERDUE', paidAmount: 200 }),
        }),
      );
      // Фантомного кредиту нема: дзеркальний PAYMENT не створено.
      expect(settlementsMock.createTransaction).not.toHaveBeenCalled();
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

    // guards: BR-INV-012
    // BR-INV-019 (рішення власника 2026-10-15): рахунок наряду закривається лише оплатою наряду —
    // ручне «Оплачено» записало б сплачене без грошей і розвело б рахунок із нарядом (дзеркало,
    // BR-INV-018). Раніше перехід проходив без PAYMENT; тепер — 400 і жодного запису.
    // guards: BR-INV-019
    it.each(['SENT', 'PARTIALLY_PAID', 'OVERDUE'])(
      'WO-рахунок у %s → ручний PAID: 400 «закривається оплатою», ні статусу, ні проводки',
      async status => {
        prisma.invoice.findFirst.mockResolvedValueOnce({
          status,
          workOrderId: 'wo-1', // рахунок за нарядом
          counterpartyId: CP_ID,
          amount: 500,
          paidAmount: 0,
        });

        await expect(service.transition(ORG, INV_ID, 'PAID' as never, 'user-1')).rejects.toThrow(
          'Рахунок наряду закривається оплатою — скористайтесь «Оплатити»',
        );
        expect(prisma.invoice.updateMany).not.toHaveBeenCalled();
        expect(settlementsMock.createTransaction).not.toHaveBeenCalled();
      },
    );

    it('non-PAID перехід (SENT→CANCELLED) НЕ пише paidAmount + постить CREDIT_NOTE (MV-H1)', async () => {
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
      // MV-H1 (BR-INV-022): скасування виставленого standalone-рахунку сторнує непогашений борг
      // компенсуючим CREDIT_NOTE на повний amount (нічого не сплачено).
      expect(settlementsMock.createTransaction).toHaveBeenCalledTimes(1);
      expect(settlementsMock.createTransaction).toHaveBeenCalledWith(
        ORG,
        expect.objectContaining({
          counterpartyId: CP_ID,
          type: 'CREDIT_NOTE',
          amount: 500,
          documentType: 'Invoice',
          documentId: INV_ID,
          createdBy: 'user-1',
        }),
        expect.anything(),
      );
    });
  });

  // ─── MV-H1 (BR-INV-022, аудит 2026-10-25): скасування ВИСТАВЛЕНОГО standalone-рахунку ───
  //
  // До фіксу гілки CANCELLED не було → при SENT/PARTIALLY_PAID/OVERDUE→CANCELLED нарахований
  // CHARGE лишався в леджері вічно (фантомний борг). Тепер постимо компенсуючий CREDIT_NOTE на
  // НЕПОГАШЕНИЙ залишок (amount − paidAmount), часткові оплати лишаються; DRAFT→CANCELLED нічого
  // не сторнує (CHARGE нараховується лише на DRAFT→SENT); WO-рахунок цю гілку не зачіпає.
  describe('transition — MV-H1 скасування standalone → CREDIT_NOTE (BR-INV-022)', () => {
    const CP_ID = '33333333-3333-4333-8333-333333333333';
    const findOneRow = {
      id: INV_ID,
      orgId: ORG,
      number: 'INV-1',
      status: 'CANCELLED',
      amount: 500,
      paidAmount: 0,
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

    // guards: BR-INV-022
    it('PARTIALLY_PAID→CANCELLED: CREDIT_NOTE лише на непогашене (amount − paidAmount), не на повний amount', async () => {
      prisma.invoice.findFirst
        .mockResolvedValueOnce({
          status: 'PARTIALLY_PAID',
          workOrderId: null,
          counterpartyId: CP_ID,
          amount: 500,
          paidAmount: 200, // 200 уже сплачено — лишається в леджері
        })
        .mockResolvedValue(findOneRow);
      prisma.invoice.updateMany.mockResolvedValue({ count: 1 });

      await service.transition(ORG, INV_ID, 'CANCELLED' as never, 'user-1');

      // Сторнуємо рівно 500 − 200 = 300 (непогашене), не 500 → часткова оплата не подвоюється.
      expect(settlementsMock.createTransaction).toHaveBeenCalledTimes(1);
      expect(settlementsMock.createTransaction).toHaveBeenCalledWith(
        ORG,
        expect.objectContaining({ type: 'CREDIT_NOTE', amount: 300, documentId: INV_ID }),
        expect.anything(),
      );
    });

    // guards: BR-INV-022
    it('DRAFT→CANCELLED: CHARGE ще не нараховано → жодної проводки', async () => {
      prisma.invoice.findFirst
        .mockResolvedValueOnce({
          status: 'DRAFT',
          workOrderId: null,
          counterpartyId: CP_ID,
          amount: 500,
          paidAmount: 0,
        })
        .mockResolvedValue({ ...findOneRow, status: 'CANCELLED' });
      prisma.invoice.updateMany.mockResolvedValue({ count: 1 });

      await service.transition(ORG, INV_ID, 'CANCELLED' as never, 'user-1');

      expect(settlementsMock.createTransaction).not.toHaveBeenCalled();
    });

    // guards: BR-INV-022
    it('WO-рахунок SENT→CANCELLED: гілка MV-H1 НЕ спрацьовує (WO-шлях сторнує окремо)', async () => {
      prisma.invoice.findFirst
        .mockResolvedValueOnce({
          status: 'SENT',
          workOrderId: WO_ID, // рахунок за нарядом
          counterpartyId: CP_ID,
          amount: 500,
          paidAmount: 0,
        })
        .mockResolvedValue({ ...findOneRow, workOrderId: WO_ID });
      prisma.invoice.updateMany.mockResolvedValue({ count: 1 });

      await service.transition(ORG, INV_ID, 'CANCELLED' as never, 'user-1');

      expect(settlementsMock.createTransaction).not.toHaveBeenCalled();
    });

    // guards: BR-INV-022
    // Конверсія CREDIT_NOTE дзеркалить курс оригінальної CHARGE: amountBase = залишок × rateUsed
    // оригіналу (не повний amountBase CHARGE), щоб сторнувати рівно непогашене у base.
    it('валютний SENT→CANCELLED: CREDIT_NOTE бере курс оригінальної CHARGE (залишок × rateUsed)', async () => {
      const USD = 'usd-3333-3333-3333-333333333333';
      prisma.invoice.findFirst
        .mockResolvedValueOnce({
          status: 'SENT',
          workOrderId: null,
          counterpartyId: CP_ID,
          amount: 100, // USD
          paidAmount: 0,
          currencyId: USD,
          documentDate: new Date('2026-01-01'),
        })
        .mockResolvedValue({ ...findOneRow, currencyId: USD });
      prisma.invoice.updateMany.mockResolvedValue({ count: 1 });
      // Оригінальна CHARGE: 100 USD × 41.5 = 4150 base.
      prisma.settlementTransaction.findFirst.mockResolvedValue({
        amountBase: 4150,
        rateUsed: 41.5,
      });

      await service.transition(ORG, INV_ID, 'CANCELLED' as never, 'user-1');

      const call = settlementsMock.createTransaction.mock.calls.find(
        (c: unknown[]) => (c[1] as { type?: string })?.type === 'CREDIT_NOTE',
      );
      expect(call, 'CREDIT_NOTE має бути створено').toBeDefined();
      expect(call![1]).toMatchObject({
        type: 'CREDIT_NOTE',
        amount: 100, // повний залишок у валюті
        currencyId: USD,
        conversion: { rateUsed: 41.5, amountBase: 4150 }, // 100 × 41.5
      });
    });

    // guards: BR-INV-022
    // Мутація: якщо прибрати гілку reversesStandaloneOnCancel, цей тест стане червоним —
    // CREDIT_NOTE не створиться й борг у леджері лишиться.
    it('CAS count=0 (паралельна зміна) → throw, CREDIT_NOTE не створюється', async () => {
      prisma.invoice.findFirst.mockResolvedValueOnce({
        status: 'SENT',
        workOrderId: null,
        counterpartyId: CP_ID,
        amount: 500,
        paidAmount: 0,
      });
      prisma.invoice.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.transition(ORG, INV_ID, 'CANCELLED' as never, 'user-1')).rejects.toThrow(
        /змінився/,
      );
      expect(settlementsMock.createTransaction).not.toHaveBeenCalled();
    });
  });

  // BR-INV-023 (рішення власника 2026-10-29): рахунок без рядків не виставляється — РАХ-2026-004310
  // пішов клієнту на 100,00 без жодного рядка. DRAFT → SENT при 0 рядків → 400 до CAS-переходу й до
  // CHARGE (FIN-C2), для standalone і для рахунку наряду; DRAFT → CANCELLED — дозволено.
  // Мутація: прибрати перевірку в transition() → кейси «без рядків» червоні (updateMany і CHARGE
  // викликаються); замінити `?? 0` на `?? 1` → червоний кейс «лічильника немає».
  describe('transition — BR-INV-023 рахунок без рядків не виставляється', () => {
    const CP_ID = '33333333-3333-4333-8333-333333333333';
    const draft = (extra: Record<string, unknown>) => ({
      status: 'DRAFT',
      workOrderId: null,
      counterpartyId: CP_ID,
      amount: 100,
      paidAmount: 0,
      ...extra,
    });
    const findOneRow = {
      id: INV_ID,
      orgId: ORG,
      number: 'INV-1',
      status: 'SENT',
      amount: 100,
      paidAmount: 0,
      workOrderId: null,
      counterpartyId: CP_ID,
      documentDate: new Date('2026-01-01'),
      dueDate: null,
      deletedAt: null,
      totalWithoutVat: 0,
      totalVat: 0,
      totalWithVat: 100,
      createdAt: new Date(),
      updatedAt: new Date(),
      counterparty: { firstName: null, lastName: null, companyName: 'ТОВ' },
      workOrder: null,
      lines: [],
    };

    // guards: BR-INV-023
    it('standalone DRAFT→SENT без рядків → 400 noLinesToIssue; ні CAS-переходу, ні CHARGE', async () => {
      prisma.invoice.findFirst.mockResolvedValueOnce(draft({ _count: { lines: 0 } }));
      prisma.invoice.updateMany.mockResolvedValue({ count: 1 });

      const err: unknown = await service
        .transition(ORG, INV_ID, 'SENT' as never, 'user-1')
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as Error).message).toBe(translateError('err.invoice.noLinesToIssue', 'uk'));
      expect(prisma.invoice.updateMany).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(settlementsMock.createTransaction).not.toHaveBeenCalled();
    });

    // guards: BR-INV-023
    it('рахунок наряду DRAFT→SENT без рядків → 400, статус не змінюється', async () => {
      prisma.invoice.findFirst.mockResolvedValueOnce(
        draft({ workOrderId: WO_ID, _count: { lines: 0 } }),
      );
      prisma.invoice.updateMany.mockResolvedValue({ count: 1 });

      await expect(
        service.transition(ORG, INV_ID, 'SENT' as never, 'user-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.invoice.updateMany).not.toHaveBeenCalled();
      expect(prisma.workOrder.findFirst).not.toHaveBeenCalled();
    });

    // guards: BR-INV-023
    // Fail-closed: select без лічильника (рефакторинг прибрав `_count`) не має пропускати рахунок.
    it('лічильника рядків у прочитаному рахунку немає → 400, а не виставлення', async () => {
      prisma.invoice.findFirst.mockResolvedValueOnce(draft({}));
      prisma.invoice.updateMany.mockResolvedValue({ count: 1 });

      await expect(
        service.transition(ORG, INV_ID, 'SENT' as never, 'user-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(settlementsMock.createTransaction).not.toHaveBeenCalled();
    });

    // guards: BR-INV-023
    // Позитивний контроль тим самим шляхом: один рядок → перехід і CHARGE; лічильник запитано.
    it('один рядок → DRAFT→SENT проходить, CHARGE створено; transition читає _count.lines', async () => {
      prisma.invoice.findFirst
        .mockResolvedValueOnce(draft({ _count: { lines: 1 } }))
        .mockResolvedValue(findOneRow);
      prisma.invoice.updateMany.mockResolvedValue({ count: 1 });

      await service.transition(ORG, INV_ID, 'SENT' as never, 'user-1');

      expect(prisma.invoice.findFirst.mock.calls[0]![0]).toMatchObject({
        where: { id: INV_ID, orgId: ORG, deletedAt: null },
        select: { _count: { select: { lines: true } } },
      });
      expect(prisma.invoice.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'SENT' } }),
      );
      expect(settlementsMock.createTransaction).toHaveBeenCalledWith(
        ORG,
        expect.objectContaining({ type: 'CHARGE', amount: 100 }),
        expect.anything(),
      );
    });

    // guards: BR-INV-023
    it('DRAFT→CANCELLED без рядків — дозволено', async () => {
      prisma.invoice.findFirst
        .mockResolvedValueOnce(draft({ _count: { lines: 0 } }))
        .mockResolvedValue({ ...findOneRow, status: 'CANCELLED' });
      prisma.invoice.updateMany.mockResolvedValue({ count: 1 });

      await service.transition(ORG, INV_ID, 'CANCELLED' as never, 'user-1');

      expect(prisma.invoice.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'CANCELLED' } }),
      );
    });
  });
});
