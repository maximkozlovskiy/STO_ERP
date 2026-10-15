/**
 * PaymentsService.create — оплата наряду: аванс і оплата з документа наряду, рахунок наряду як
 * дзеркало (рішення власника 2026-10-15).
 *
 *   BR-PAY-001 — статуси, що приймають оплату (`WO_PAYABLE_STATUSES`), 400 з назвою статусу;
 *   BR-PAY-005 — paidAmount наряду в транзакції, рядок наряду блокується ПЕРШИМ, «Оплачено» в тій
 *                самій транзакції (з «Виконано» — через «Виставлено», без рахунку), події — після;
 *   BR-PAY-016 — платник наряду;
 *   BR-PAY-017 — залишок обмежує будь-яку оплату наряду, наряд на 0 не приймає, CAS;
 *   BR-PAY-020 — тип проводки за статусом, прочитаним у транзакції; REFUND з нарядом → 400;
 *   BR-PAY-021 — наряд виводиться з рахунку; оплата наряду отримує invoiceId активного рахунку.
 *
 * Наряд, рахунок і оплати — таблиці в пам'яті (`memoryTable`): скільки запитів зробить сервіс і в
 * якому порядку, з правил не випливає, а `where` (CAS!) вони застосовують по-справжньому.
 */

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { vi, describe, it, expect } from 'vitest';
import type { Queue } from 'bullmq';
import { WO_PAYABLE_STATUSES, WO_PREPAYMENT_STATUSES } from '@sto/shared';
import { PaymentsService } from './payments.service';
import { exchangeRatesMock } from './payments.spec-fixture';
import { memoryTable, type MemRow } from '../cash/cash.spec-fixture';
import type { PrismaService } from '../../prisma/prisma.service';
import type { SettlementsService } from '../settlements/settlements.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { WorkOrdersService } from '../work-orders/work-orders.service';
import type { LoyaltyService } from '../loyalty/loyalty.service';
import type { AuditService } from '../audit/audit.service';
import type { CashService } from '../cash/cash.service';
import type { ExchangeRatesService } from '../exchange-rates/exchange-rates.service';

const ORG = 'org-1';
const CP_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_CP = '33333333-3333-4333-8333-333333333333';
const WO_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_WO = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const INV_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

interface Seed {
  workOrder?: MemRow | null;
  invoice?: MemRow | null;
}

function makeHarness(seed: Seed = {}) {
  const workOrder: MemRow | null =
    seed.workOrder === null
      ? null
      : {
          id: WO_ID,
          orgId: ORG,
          branchId: 'br-1',
          counterpartyId: CP_ID,
          status: 'INVOICED',
          totalAmount: 500,
          paidAmount: 0,
          currencyId: null,
          deletedAt: null,
          ...seed.workOrder,
        };
  const invoice: MemRow | null = seed.invoice
    ? {
        id: INV_ID,
        orgId: ORG,
        workOrderId: WO_ID,
        counterpartyId: CP_ID,
        status: 'SENT',
        amount: 500,
        paidAmount: 0,
        currencyId: null,
        deletedAt: null,
        ...seed.invoice,
      }
    : null;

  const tables = {
    counterparty: memoryTable([
      {
        id: CP_ID,
        orgId: ORG,
        deletedAt: null,
        phone: null,
        email: null,
        firstName: null,
        lastName: null,
        companyName: 'ТОВ',
      },
    ]),
    workOrder: memoryTable(workOrder ? [workOrder] : []),
    invoice: memoryTable(invoice ? [invoice] : []),
    payment: memoryTable([], () => ({
      orgId: ORG,
      fiscalReceiptId: null,
      reversedAt: null,
      createdAt: new Date('2026-10-15T09:00:00.000Z'),
      counterparty: { firstName: null, lastName: null, companyName: 'ТОВ' },
    })),
    // Метод без фіскалізації й без рахунку-призначення — перевіряються лише правила наряду.
    paymentMethodConfig: memoryTable([{ orgId: ORG, code: 'card', requiresFiscal: false }]),
    bankAccount: memoryTable([]),
    cashRegister: memoryTable([]),
    garageBranch: memoryTable([{ id: 'br-1', orgId: ORG, deletedAt: null }]),
    settlementTransaction: memoryTable([]),
  };

  let inTx = false;
  const prisma: Record<string, unknown> = { ...tables };
  const runTx = async (cb: (tx: unknown) => Promise<unknown>) => {
    inTx = true;
    try {
      return await cb(prisma);
    } finally {
      inTx = false;
    }
  };
  const begin = vi.fn(runTx);
  prisma.$transaction = begin;

  const settlementRows: MemRow[] = [];
  const settlements = {
    createTransaction: vi.fn((orgId: string, dto: MemRow) => {
      settlementRows.push({ orgId, ...dto, __inTx: inTx });
      return Promise.resolve();
    }),
  };
  // Події переходів — лише ПІСЛЯ коміту: фіксуємо, чи була транзакція відкрита в момент виклику.
  const emittedInTx: boolean[] = [];
  const workOrders = {
    transition: vi.fn().mockResolvedValue(undefined),
    emitStatusSteps: vi.fn(() => {
      emittedInTx.push(inTx);
    }),
  };
  const service = new PaymentsService(
    prisma as unknown as PrismaService,
    settlements as unknown as SettlementsService,
    { send: vi.fn().mockResolvedValue(undefined) } as unknown as NotificationsService,
    workOrders as unknown as WorkOrdersService,
    { queueEarn: vi.fn().mockResolvedValue(undefined) } as unknown as LoyaltyService,
    { record: vi.fn().mockResolvedValue(undefined) } as unknown as AuditService,
    { createOperation: vi.fn().mockResolvedValue(undefined) } as unknown as CashService,
    exchangeRatesMock() as unknown as ExchangeRatesService,
    { add: vi.fn().mockResolvedValue(undefined) } as unknown as Queue,
  );

  /** Змінити дані «паралельно» — між перевіркою до транзакції і самою транзакцією. */
  const beforeTx = (change: () => void) =>
    begin.mockImplementationOnce((cb: (tx: unknown) => Promise<unknown>) => {
      change();
      return runTx(cb);
    });

  return {
    service,
    prisma,
    beforeTx,
    tables,
    settlements,
    settlementRows,
    workOrders,
    emittedInTx,
    workOrder,
    invoice,
    payments: tables.payment.rows,
  };
}

const woDto = { counterpartyId: CP_ID, workOrderId: WO_ID, amount: 500, method: 'card' };
const paymentPosting = (rows: MemRow[]) =>
  rows.filter(r => r.documentType === 'Payment').map(r => r.type);

// ── BR-PAY-001: передумови ────────────────────────────────────────────────────────────────

describe('PaymentsService.create — передумови оплати наряду (BR-PAY-001)', () => {
  // guards: BR-PAY-001
  it('контрагента не знайдено (чужа org / видалений) → NotFound, без транзакції/Payment/settlement', async () => {
    const h = makeHarness();
    h.tables.counterparty.rows.length = 0;

    await expect(h.service.create(ORG, woDto, 'user-1')).rejects.toThrow(NotFoundException);

    expect(h.prisma.$transaction).not.toHaveBeenCalled();
    expect(h.payments).toHaveLength(0);
    expect(h.settlementRows).toEqual([]);
  });

  // guards: BR-PAY-001
  it.each(WO_PAYABLE_STATUSES.map(s => [s]))(
    'наряд у статусі %s приймає оплату: Payment з workOrderId, paidAmount наряду росте',
    async status => {
      const h = makeHarness({ workOrder: { status, totalAmount: 1200 } });

      await h.service.create(ORG, woDto, 'user-1');

      expect(h.payments).toHaveLength(1);
      expect(h.payments[0]!.workOrderId).toBe(WO_ID);
      expect(h.workOrder!.paidAmount).toBe(500);
    },
  );

  // guards: BR-PAY-001
  it.each([
    ['CANCELLED', 'Скасовано'],
    ['PAID', 'Оплачено'],
    ['ARCHIVED', 'Архів'],
  ])(
    'наряд у статусі %s → 400 з назвою статусу «%s» ДО транзакції, нічого не пишеться',
    async (status, label) => {
      const h = makeHarness({ workOrder: { status } });

      await expect(h.service.create(ORG, woDto, 'user-1')).rejects.toThrow(
        `Наряд у статусі "${label}" — оплата неможлива`,
      );

      expect(h.prisma.$transaction).not.toHaveBeenCalled();
      expect(h.payments).toHaveLength(0);
      expect(h.settlementRows).toEqual([]);
      expect(h.workOrder!.paidAmount).toBe(0);
    },
  );

  // Регресія (review 03e45456): видалений наряд (DRAFT/CANCELLED) отримував paidAmount в обхід
  // статусу й залишку, бо всі перевірки стояли за `&& workOrder`.
  // guards: BR-PAY-001
  it('наряд не знайдено (чужа org / видалений) → NotFound ДО транзакції, без Payment/settlement', async () => {
    const h = makeHarness({ workOrder: { deletedAt: new Date('2026-10-15') } });

    await expect(h.service.create(ORG, woDto, 'user-1')).rejects.toThrow(NotFoundException);

    expect(h.prisma.$transaction).not.toHaveBeenCalled();
    expect(h.payments).toHaveLength(0);
    expect(h.settlementRows).toEqual([]);
  });

  // Статус наряду, що змінився між перевіркою і транзакцією (скасували наряд), перевіряється
  // ще раз — уже на рядку, прочитаному в транзакції.
  // guards: BR-PAY-001
  it('наряд скасували між перевіркою і транзакцією → 400, paidAmount не пишеться', async () => {
    const h = makeHarness({ workOrder: { status: 'IN_PROGRESS', totalAmount: 1200 } });
    h.beforeTx(() => {
      h.workOrder!.status = 'CANCELLED';
    });

    await expect(h.service.create(ORG, woDto, 'user-1')).rejects.toThrow(BadRequestException);

    expect(h.workOrder!.paidAmount).toBe(0);
    expect(h.payments).toHaveLength(0);
    expect(h.settlementRows).toEqual([]);
  });

  // guards: BR-PAY-017
  it('читання наряду В ТРАНЗАКЦІЇ теж не бачить видалений: видалили між перевіркою і записом → NotFound, paidAmount не пишеться', async () => {
    const h = makeHarness();
    h.beforeTx(() => {
      h.workOrder!.deletedAt = new Date('2026-10-15');
    });

    await expect(h.service.create(ORG, woDto, 'user-1')).rejects.toThrow(NotFoundException);

    expect(h.workOrder!.paidAmount).toBe(0);
    expect(h.payments).toHaveLength(0);
  });

  it('оплата без наряду й без рахунку → наряд не чіпаємо, тип проводки PAYMENT', async () => {
    const h = makeHarness();

    await h.service.create(ORG, { counterpartyId: CP_ID, amount: 500, method: 'card' }, 'user-1');

    expect(h.payments).toHaveLength(1);
    expect(h.payments[0]!.workOrderId).toBeNull();
    expect(h.tables.workOrder.findFirst).not.toHaveBeenCalled();
    expect(h.workOrder!.paidAmount).toBe(0);
    expect(paymentPosting(h.settlementRows)).toEqual(['PAYMENT']);
  });
});

// ── BR-PAY-016: платник ───────────────────────────────────────────────────────────────────

describe('PaymentsService.create — платник наряду (BR-PAY-016)', () => {
  // Та сама діра, що BR-PAY-016 закрив для рахунку: платіж контрагента A піднімав paidAmount
  // наряду контрагента B і переводив його в PAID, а гроші лягали на баланс A.
  // guards: BR-PAY-016
  it('наряд оформлено на іншого контрагента (пряма оплата без рахунку) → 400 ДО транзакції, наряд не чіпається', async () => {
    const h = makeHarness({ workOrder: { counterpartyId: OTHER_CP } });

    await expect(h.service.create(ORG, woDto, 'user-1')).rejects.toThrow(
      'Наряд оформлено на іншого контрагента — оплату наряду приймаємо лише від його замовника',
    );

    expect(h.prisma.$transaction).not.toHaveBeenCalled();
    expect(h.payments).toHaveLength(0);
    expect(h.workOrder!.paidAmount).toBe(0);
  });

  // guards: BR-PAY-016
  it('оплата з рахунком і нарядом: платника визначає рахунок (його можна виписати на іншого платника), перевірка наряду мовчить', async () => {
    // Наряд клієнта OTHER_CP, рахунок за цим нарядом виписано на платника CP_ID (напр. страхову).
    const h = makeHarness({ workOrder: { counterpartyId: OTHER_CP }, invoice: {} });

    await h.service.create(ORG, { ...woDto, invoiceId: INV_ID }, 'user-1');

    expect(h.payments).toHaveLength(1);
    expect(h.payments[0]!.invoiceId).toBe(INV_ID);
    expect(h.workOrder!.paidAmount).toBe(500);
  });

  // guards: BR-PAY-016
  it('рахунок наряду виписано на іншого платника → 400 у транзакції, нічого не пишеться', async () => {
    const h = makeHarness({ invoice: { counterpartyId: OTHER_CP } });

    await expect(h.service.create(ORG, { ...woDto, invoiceId: INV_ID }, 'user-1')).rejects.toThrow(
      BadRequestException,
    );

    expect(h.payments).toHaveLength(0);
    expect(h.settlementRows).toEqual([]);
  });
});

// ── BR-PAY-020: аванс чи оплата — за статусом ─────────────────────────────────────────────

describe('PaymentsService.create — аванс і оплата наряду за статусом (BR-PAY-020)', () => {
  // guards: BR-PAY-020
  it.each(WO_PREPAYMENT_STATUSES.map(s => [s]))(
    'наряд у статусі %s (до «Виконано») → проводка PREPAYMENT, у тій самій транзакції',
    async status => {
      const h = makeHarness({ workOrder: { status, totalAmount: 1200 } });

      await h.service.create(ORG, woDto, 'user-1');

      expect(paymentPosting(h.settlementRows)).toEqual(['PREPAYMENT']);
      expect(h.settlementRows[0]!.__inTx).toBe(true);
      expect(h.payments[0]!.workOrderId).toBe(WO_ID);
    },
  );

  // guards: BR-PAY-020
  it.each([['COMPLETED'], ['INVOICED']])(
    'наряд у статусі %s (борг нараховано) → проводка PAYMENT',
    async status => {
      const h = makeHarness({ workOrder: { status, totalAmount: 1200 } });

      await h.service.create(ORG, woDto, 'user-1');

      expect(paymentPosting(h.settlementRows)).toEqual(['PAYMENT']);
    },
  );

  // Тип визначає статус, прочитаний У ТРАНЗАКЦІЇ: наряд, що встиг стати «Виконано» між перевіркою
  // і записом, уже має борг — аванс задвоїв би його погашення на балансі.
  // guards: BR-PAY-020
  it('статус змінився на «Виконано» між перевіркою і транзакцією → проводка PAYMENT, не PREPAYMENT', async () => {
    const h = makeHarness({ workOrder: { status: 'IN_PROGRESS', totalAmount: 1200 } });
    h.beforeTx(() => {
      h.workOrder!.status = 'COMPLETED';
    });

    await h.service.create(ORG, woDto, 'user-1');

    expect(paymentPosting(h.settlementRows)).toEqual(['PAYMENT']);
  });

  // Рознесення виписки передає settlementType із запиту — для оплати наряду воно не діє.
  // guards: BR-PAY-020
  it('settlementType PREPAYMENT із запиту для наряду в «Виставлено» → проводка все одно PAYMENT', async () => {
    const h = makeHarness({ workOrder: { totalAmount: 1200 } });

    await h.service.create(ORG, { ...woDto, settlementType: 'PREPAYMENT' }, 'user-1');

    expect(paymentPosting(h.settlementRows)).toEqual(['PAYMENT']);
  });

  // guards: BR-PAY-020
  it('повернення (settlementType REFUND) з нарядом → 400 ДО транзакції, нічого не пишеться', async () => {
    const h = makeHarness();

    await expect(
      h.service.create(ORG, { ...woDto, settlementType: 'REFUND' }, 'user-1'),
    ).rejects.toThrow("Повернення не прив'язується до наряду — оформіть його в касі");

    expect(h.prisma.$transaction).not.toHaveBeenCalled();
    expect(h.payments).toHaveLength(0);
  });
});

// ── BR-PAY-017: залишок ───────────────────────────────────────────────────────────────────

describe('PaymentsService.create — залишок наряду (BR-PAY-017)', () => {
  // guards: BR-PAY-017
  it('оплата понад залишок (500 при залишку 300) → 400, без Payment, settlement і зміни наряду', async () => {
    const h = makeHarness({ workOrder: { totalAmount: 1200, paidAmount: 900 } });

    await expect(h.service.create(ORG, woDto, 'user-1')).rejects.toThrow(
      'Сума перевищує залишок до сплати за нарядом (300.00)',
    );

    expect(h.workOrder!.paidAmount).toBe(900);
    expect(h.settlementRows).toEqual([]);
    expect(h.payments).toHaveLength(0);
  });

  // guards: BR-PAY-017
  it('аванс понад залишок наряду «В роботі» → 400 (залишок обмежує й аванс)', async () => {
    const h = makeHarness({ workOrder: { status: 'IN_PROGRESS', totalAmount: 400 } });

    await expect(h.service.create(ORG, woDto, 'user-1')).rejects.toThrow(BadRequestException);

    expect(h.payments).toHaveLength(0);
  });

  // guards: BR-PAY-017
  it('наряд на 0 грн оплати не приймає → 400', async () => {
    const h = makeHarness({ workOrder: { status: 'DRAFT', totalAmount: 0 } });

    await expect(h.service.create(ORG, { ...woDto, amount: 0.01 }, 'user-1')).rejects.toThrow(
      BadRequestException,
    );

    expect(h.payments).toHaveLength(0);
    expect(h.workOrder!.paidAmount).toBe(0);
  });

  // guards: BR-PAY-017
  it('оплата через рахунок наряду теж не перевищує залишок НАРЯДУ', async () => {
    const h = makeHarness({ workOrder: { totalAmount: 500, paidAmount: 300 }, invoice: {} });

    await expect(
      h.service.create(
        ORG,
        { counterpartyId: CP_ID, invoiceId: INV_ID, amount: 300, method: 'card' },
        'user-1',
      ),
    ).rejects.toThrow(BadRequestException);

    expect(h.payments).toHaveLength(0);
  });

  // guards: BR-PAY-017
  it('рівно залишок → проходить: paidAmount = total', async () => {
    const h = makeHarness({ workOrder: { totalAmount: 1200, paidAmount: 700 } });

    await h.service.create(ORG, woDto, 'user-1');

    expect(h.workOrder!.paidAmount).toBe(1200);
  });

  // Два одночасні платежі прочитали той самий paidAmount: другий програє CAS і нічого не пише.
  // guards: BR-PAY-017
  it('паралельна зміна наряду (CAS count=0) → 400 «повторіть», без Payment і проводки', async () => {
    const h = makeHarness({ workOrder: { totalAmount: 1200 } });
    h.tables.workOrder.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(h.service.create(ORG, woDto, 'user-1')).rejects.toThrow(
      'Наряд змінено паралельною операцією — повторіть',
    );

    expect(h.payments).toHaveLength(0);
    expect(h.settlementRows).toEqual([]);
    expect(h.workOrders.emitStatusSteps).not.toHaveBeenCalled();
  });

  // CAS тримає не лише сплачене, а й статус і суму: аванс, проведений проти статусу чи суми, що
  // встигли змінитись, — уже не той аванс.
  // guards: BR-PAY-017, BR-PAY-020
  it('CAS наряду — за статусом, сумою і сплаченим, прочитаними в транзакції', async () => {
    const h = makeHarness({
      workOrder: { status: 'IN_PROGRESS', totalAmount: 1200, paidAmount: 100 },
    });

    await h.service.create(ORG, woDto, 'user-1');

    expect(h.tables.workOrder.updateMany.mock.calls[0]![0]).toEqual({
      where: {
        id: WO_ID,
        orgId: ORG,
        deletedAt: null,
        status: 'IN_PROGRESS',
        paidAmount: 100,
        totalAmount: 1200,
      },
      data: { paidAmount: 600 },
    });
  });
});

// ── BR-PAY-005 / BR-WO-016: «Оплачено» в тій самій транзакції ──────────────────────────────

describe('PaymentsService.create — наряд стає «Оплачено» в транзакції оплати (BR-PAY-005)', () => {
  // guards: BR-PAY-005, BR-WO-016
  it('повна оплата наряду «Виставлено» → «Оплачено» в тій самій транзакції, подія — після коміту', async () => {
    const h = makeHarness();

    await h.service.create(ORG, woDto, 'user-1');

    expect(h.workOrder!.status).toBe('PAID');
    expect(h.workOrder!.paidAmount).toBe(500);
    expect(h.workOrders.emitStatusSteps).toHaveBeenCalledWith(
      ORG,
      WO_ID,
      [{ from: 'INVOICED', to: 'PAID' }],
      'user-1',
    );
    expect(h.emittedInTx).toEqual([false]);
    // Пост-комітного best-effort transition більше немає.
    expect(h.workOrders.transition).not.toHaveBeenCalled();
  });

  // guards: BR-PAY-005, BR-WO-016
  it('повна оплата наряду «Виконано» → «Виставлено» → «Оплачено» без створення рахунку', async () => {
    const h = makeHarness({ workOrder: { status: 'COMPLETED' } });

    await h.service.create(ORG, woDto, 'user-1');

    expect(h.workOrder!.status).toBe('PAID');
    expect(h.tables.invoice.create).not.toHaveBeenCalled();
    expect(h.tables.invoice.rows).toHaveLength(0);
    expect(h.workOrders.emitStatusSteps).toHaveBeenCalledWith(
      ORG,
      WO_ID,
      [
        { from: 'COMPLETED', to: 'INVOICED' },
        { from: 'INVOICED', to: 'PAID' },
      ],
      'user-1',
    );
  });

  // guards: BR-PAY-017
  it('часткова оплата (500 із 1200) → paidAmount 500, наряд лишається «Виставлено»', async () => {
    const h = makeHarness({ workOrder: { totalAmount: 1200 } });

    await h.service.create(ORG, woDto, 'user-1');

    expect(h.workOrder!.paidAmount).toBe(500);
    expect(h.workOrder!.status).toBe('INVOICED');
    expect(h.workOrders.emitStatusSteps).toHaveBeenCalledWith(ORG, WO_ID, [], 'user-1');
  });

  // До «Виконано» борг ще не нараховано — повний аванс статус не змінює (BR-WO-016: далі до
  // «Оплачено» наряд піде сам при переході у «Виконано»).
  // guards: BR-WO-016
  it('повний аванс наряду «В роботі» → наряд лишається «В роботі»', async () => {
    const h = makeHarness({ workOrder: { status: 'IN_PROGRESS' } });

    await h.service.create(ORG, woDto, 'user-1');

    expect(h.workOrder!.paidAmount).toBe(500);
    expect(h.workOrder!.status).toBe('IN_PROGRESS');
  });

  // guards: BR-PAY-017
  it('копійки: 0.1 + 0.2 із 0.3 — це повна оплата, а не «бракує 4e-17»', async () => {
    const h = makeHarness({ workOrder: { totalAmount: 0.3, paidAmount: 0.1 } });

    await h.service.create(ORG, { ...woDto, amount: 0.2 }, 'user-1');

    expect(h.workOrder!.paidAmount).toBe(0.3);
    expect(h.workOrder!.status).toBe('PAID');
  });

  // Порядок блокувань «наряд → рахунок»: рядок наряду — перший запис транзакції.
  // guards: BR-PAY-005
  it('рядок наряду записується ПЕРШИМ — раніше за рахунок наряду', async () => {
    const h = makeHarness({ workOrder: { totalAmount: 1200 }, invoice: { amount: 1200 } });

    await h.service.create(ORG, { ...woDto, invoiceId: INV_ID }, 'user-1');

    const woWrite = h.tables.workOrder.updateMany.mock.invocationCallOrder[0]!;
    const invWrite = h.tables.invoice.updateMany.mock.invocationCallOrder[0]!;
    expect(woWrite).toBeLessThan(invWrite);
  });
});

// ── BR-PAY-021: оплата рахунку наряду = оплата наряду ──────────────────────────────────────

describe('PaymentsService.create — рахунок наряду (BR-PAY-021)', () => {
  // guards: BR-PAY-021
  it('лише invoiceId рахунку наряду (сторінка рахунків / виписка) → оплата наряду: workOrderId з рахунку', async () => {
    const h = makeHarness({ workOrder: { totalAmount: 1200 }, invoice: { amount: 1200 } });

    await h.service.create(
      ORG,
      { counterpartyId: CP_ID, invoiceId: INV_ID, amount: 500, method: 'card' },
      'user-1',
    );

    expect(h.payments[0]!.workOrderId).toBe(WO_ID);
    expect(h.payments[0]!.invoiceId).toBe(INV_ID);
    expect(h.workOrder!.paidAmount).toBe(500);
    // Дзеркало (BR-INV-018): рахунок знає про сплачене наряду.
    expect(h.invoice!.paidAmount).toBe(500);
    expect(h.invoice!.status).toBe('PARTIALLY_PAID');
  });

  // guards: BR-PAY-021
  it('оплата з наряду отримує invoiceId активного рахунку наряду', async () => {
    const h = makeHarness({ workOrder: { totalAmount: 1200 }, invoice: { amount: 1200 } });

    await h.service.create(ORG, woDto, 'user-1');

    expect(h.payments[0]!.invoiceId).toBe(INV_ID);
    expect(h.invoice!.paidAmount).toBe(500);
  });

  // guards: BR-PAY-021
  it('скасований рахунок наряду — не активний: оплата з наряду йде без invoiceId', async () => {
    const h = makeHarness({ invoice: { status: 'CANCELLED' } });

    await h.service.create(ORG, woDto, 'user-1');

    expect(h.payments[0]!.invoiceId).toBeNull();
    expect(h.invoice!.paidAmount).toBe(0);
  });

  // guards: BR-PAY-021
  it('активний рахунок наряду виписано на іншого платника → оплата з наряду йде без invoiceId', async () => {
    const h = makeHarness({ invoice: { counterpartyId: OTHER_CP } });

    await h.service.create(ORG, woDto, 'user-1');

    expect(h.payments[0]!.invoiceId).toBeNull();
  });

  // guards: BR-PAY-021
  it('рахунок іншого наряду разом із workOrderId → 400 «Рахунок не належить до вказаного наряду»', async () => {
    const h = makeHarness({ invoice: { workOrderId: OTHER_WO } });

    await expect(h.service.create(ORG, { ...woDto, invoiceId: INV_ID }, 'user-1')).rejects.toThrow(
      'Рахунок не належить до вказаного наряду',
    );

    expect(h.prisma.$transaction).not.toHaveBeenCalled();
    expect(h.payments).toHaveLength(0);
  });

  // guards: BR-PAY-021
  it('рахунок без наряду разом із workOrderId → 400 «Рахунок не належить до вказаного наряду»', async () => {
    const h = makeHarness({ invoice: { workOrderId: null } });

    await expect(h.service.create(ORG, { ...woDto, invoiceId: INV_ID }, 'user-1')).rejects.toThrow(
      'Рахунок не належить до вказаного наряду',
    );

    expect(h.payments).toHaveLength(0);
  });

  // Статус рахунку наряду оплату не обмежує — обмежує статус наряду; сплачене чернетки рахунку
  // перераховує дзеркало, статус чернетки лишається DRAFT.
  // guards: BR-PAY-021
  it('рахунок наряду в «Чернетка» приймає оплату; рахунок показує сплачене і лишається DRAFT', async () => {
    const h = makeHarness({
      workOrder: { totalAmount: 1200 },
      invoice: { status: 'DRAFT', amount: 1200 },
    });

    await h.service.create(
      ORG,
      { counterpartyId: CP_ID, invoiceId: INV_ID, amount: 500, method: 'card' },
      'user-1',
    );

    expect(h.workOrder!.paidAmount).toBe(500);
    expect(h.invoice!.paidAmount).toBe(500);
    expect(h.invoice!.status).toBe('DRAFT');
  });

  // guards: BR-PAY-021, BR-PAY-005
  it('повна оплата рахунку наряду → наряд і рахунок закриваються разом («Оплачено» / PAID)', async () => {
    const h = makeHarness({ invoice: {} });

    await h.service.create(
      ORG,
      { counterpartyId: CP_ID, invoiceId: INV_ID, amount: 500, method: 'card' },
      'user-1',
    );

    expect(h.workOrder!.status).toBe('PAID');
    expect(h.invoice!.status).toBe('PAID');
    expect(h.invoice!.paidAmount).toBe(500);
  });
});
