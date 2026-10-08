/**
 * PaymentsService.create — передумови (контрагент, статус наряду) і звʼязок з нарядом.
 *
 * Аспект зʼявився 2026-10-07 під час простеження «правило → тест»: BR-PAY-001 і FSM-частина
 * BR-PAY-005 не мали жодного unit-тесту (paidAmount наряду стерігся лише мультивалютним кейсом).
 * Кожен кейс доведено мутацією продукт-коду (зламав → тест упав → повернув → зелений).
 *
 * `exchangeRatesMock()` — з `./payments.spec-fixture` (factory: `isolate: false` без `clearMocks`).
 */

import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { getQueueToken } from '@nestjs/bullmq';
import { PaymentsService } from './payments.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SettlementsService } from '../settlements/settlements.service';
import { CashService } from '../cash/cash.service';
import { NotificationsService } from '../notifications/notifications.service';
import { WorkOrdersService } from '../work-orders/work-orders.service';
import { LoyaltyService } from '../loyalty/loyalty.service';
import { AuditService } from '../audit/audit.service';
import { ExchangeRatesService } from '../exchange-rates/exchange-rates.service';
import { exchangeRatesMock } from './payments.spec-fixture';

describe('PaymentsService.create — передумови і звʼязок з нарядом (BR-PAY-001, BR-PAY-005)', () => {
  let service: PaymentsService;
  let prisma: {
    counterparty: { findFirst: ReturnType<typeof vi.fn> };
    workOrder: {
      findFirst: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
    };
    invoice: { findFirst: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
    garageBranch: { findFirst: ReturnType<typeof vi.fn> };
    payment: { create: ReturnType<typeof vi.fn> };
    paymentMethodConfig: { findFirst: ReturnType<typeof vi.fn> };
    bankAccount: { findFirst: ReturnType<typeof vi.fn> };
    cashRegister: { findFirst: ReturnType<typeof vi.fn> };
    $transaction: ReturnType<typeof vi.fn>;
  };
  let settlements: { createTransaction: ReturnType<typeof vi.fn> };
  let workOrders: { transition: ReturnType<typeof vi.fn> };
  let inTx: boolean;

  const ORG = 'org-1';
  const CP_ID = '22222222-2222-4222-8222-222222222222';
  const WO_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const PAY_ID = '44444444-4444-4444-8444-444444444444';

  const cp = {
    id: CP_ID,
    phone: null,
    email: null,
    firstName: null,
    lastName: null,
    companyName: 'ТОВ',
  };

  const createdPayment = {
    id: PAY_ID,
    orgId: ORG,
    counterpartyId: CP_ID,
    workOrderId: WO_ID,
    invoiceId: null,
    amount: 500,
    method: 'CASH',
    notes: null,
    fiscalReceiptId: null,
    createdAt: new Date(),
    counterparty: { firstName: null, lastName: null, companyName: 'ТОВ' },
  };

  const invoicedWorkOrder = {
    branchId: 'br-1',
    status: 'INVOICED',
    currencyId: null,
    counterpartyId: CP_ID,
    // сума до сплати й уже оплачене — їх читає платіж у транзакції (BR-PAY-017)
    totalAmount: 500,
    paidAmount: 0,
  };

  beforeEach(async () => {
    inTx = false;
    prisma = {
      counterparty: { findFirst: vi.fn().mockResolvedValue(cp) },
      workOrder: {
        findFirst: vi.fn().mockResolvedValue(invoicedWorkOrder),
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      invoice: { findFirst: vi.fn(), updateMany: vi.fn() },
      garageBranch: { findFirst: vi.fn().mockResolvedValue({ id: 'br-1' }) },
      payment: { create: vi.fn().mockResolvedValue(createdPayment) },
      // Метод без фіскалізації й без дефолтного рахунку — щоб перевірялось лише правило наряду.
      paymentMethodConfig: { findFirst: vi.fn().mockResolvedValue({ requiresFiscal: false }) },
      bankAccount: { findFirst: vi.fn() },
      cashRegister: { findFirst: vi.fn() },
      $transaction: vi.fn().mockImplementation(async (arg: unknown) => {
        if (typeof arg !== 'function') return undefined;
        inTx = true;
        try {
          return await (arg as (tx: unknown) => Promise<unknown>)(prisma);
        } finally {
          inTx = false;
        }
      }),
    };
    settlements = { createTransaction: vi.fn() };
    workOrders = { transition: vi.fn().mockResolvedValue(undefined) };

    const module = await Test.createTestingModule({
      providers: [
        PaymentsService,
        { provide: PrismaService, useValue: prisma },
        { provide: SettlementsService, useValue: settlements },
        { provide: NotificationsService, useValue: { send: vi.fn().mockResolvedValue(undefined) } },
        { provide: WorkOrdersService, useValue: workOrders },
        { provide: LoyaltyService, useValue: { queueEarn: vi.fn().mockResolvedValue(undefined) } },
        { provide: AuditService, useValue: { record: vi.fn().mockResolvedValue(undefined) } },
        {
          provide: CashService,
          useValue: { createOperation: vi.fn().mockResolvedValue(undefined) },
        },
        { provide: ExchangeRatesService, useValue: exchangeRatesMock() },
        { provide: getQueueToken('checkbox'), useValue: { add: vi.fn() } },
      ],
    }).compile();
    service = module.get(PaymentsService);
  });

  const woDto = { counterpartyId: CP_ID, workOrderId: WO_ID, amount: 500, method: 'CASH' };

  // ── BR-PAY-001: передумови ────────────────────────────────────────────────

  // guards: BR-PAY-001
  it('контрагента не знайдено (чужа org / видалений) → NotFound, без транзакції/Payment/settlement', async () => {
    prisma.counterparty.findFirst.mockResolvedValue(null);

    await expect(service.create(ORG, woDto, 'user-1')).rejects.toThrow(NotFoundException);

    // Пошук org-scoped і не бачить soft-deleted — інакше чужий контрагент пройшов би.
    expect(prisma.counterparty.findFirst.mock.calls[0][0].where).toEqual({
      id: CP_ID,
      orgId: ORG,
      deletedAt: null,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.payment.create).not.toHaveBeenCalled();
    expect(settlements.createTransaction).not.toHaveBeenCalled();
  });

  // guards: BR-PAY-001
  it.each([
    'DRAFT',
    'ESTIMATE',
    'APPROVED',
    'IN_PROGRESS',
    'ON_HOLD',
    'COMPLETED',
    'PAID',
    'ARCHIVED',
    'CANCELLED',
  ])(
    'наряд у статусі %s (не INVOICED) → 400 ДО транзакції, без Payment/settlement/transition',
    async status => {
      prisma.workOrder.findFirst.mockResolvedValue({ ...invoicedWorkOrder, status });

      await expect(service.create(ORG, woDto, 'user-1')).rejects.toThrow(BadRequestException);

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.payment.create).not.toHaveBeenCalled();
      expect(settlements.createTransaction).not.toHaveBeenCalled();
      expect(prisma.workOrder.update).not.toHaveBeenCalled();
      expect(workOrders.transition).not.toHaveBeenCalled();
    },
  );

  // Регресія (review 03e45456): наряд не знайдено (чужа org або видалений) — усі перевірки
  // наряду стояли за `&& workOrder` і мовчали, а читання в транзакції не дивилось на deletedAt:
  // видалений наряд (DRAFT/CANCELLED) отримував paidAmount в обхід статусу й залишку.
  // Mutation-verify: прибрати ранній NotFound → кейс падає (транзакція відкривається).
  // guards: BR-PAY-001
  it('наряд не знайдено (чужа org / видалений) → NotFound ДО транзакції, без Payment/settlement', async () => {
    prisma.workOrder.findFirst.mockResolvedValue(null);

    await expect(service.create(ORG, woDto, 'user-1')).rejects.toThrow(NotFoundException);

    expect(prisma.workOrder.findFirst.mock.calls[0][0].where).toEqual({
      id: WO_ID,
      orgId: ORG,
      deletedAt: null,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.payment.create).not.toHaveBeenCalled();
    expect(settlements.createTransaction).not.toHaveBeenCalled();
    expect(workOrders.transition).not.toHaveBeenCalled();
  });

  // guards: BR-PAY-017
  it('читання наряду В ТРАНЗАКЦІЇ теж не бачить видалений: видалили між перевіркою і записом → NotFound, paidAmount не пишеться', async () => {
    prisma.workOrder.findFirst
      .mockResolvedValueOnce(invoicedWorkOrder) // до транзакції
      .mockResolvedValueOnce(null); // у транзакції

    await expect(service.create(ORG, woDto, 'user-1')).rejects.toThrow(NotFoundException);

    expect(prisma.workOrder.findFirst.mock.calls[1][0].where).toEqual({
      id: WO_ID,
      orgId: ORG,
      deletedAt: null,
    });
    expect(prisma.workOrder.updateMany).not.toHaveBeenCalled();
    expect(workOrders.transition).not.toHaveBeenCalled();
  });

  // ── BR-PAY-005: paidAmount наряду + best-effort FSM ───────────────────────

  // Та сама діра, що BR-PAY-016 закрив для рахунку: платіж контрагента A піднімав paidAmount
  // наряду контрагента B і переводив його в PAID, а гроші лягали на баланс A.
  // guards: BR-PAY-016
  it('наряд оформлено на іншого контрагента (пряма оплата без рахунку) → 400 ДО транзакції, наряд не чіпається', async () => {
    prisma.workOrder.findFirst.mockResolvedValue({
      ...invoicedWorkOrder,
      counterpartyId: 'cp-other',
    });

    await expect(service.create(ORG, woDto, 'user-1')).rejects.toThrow(
      'Наряд оформлено на іншого контрагента — оплату наряду приймаємо лише від його замовника',
    );

    expect(prisma.workOrder.findFirst.mock.calls[0][0].select.counterpartyId).toBe(true);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.payment.create).not.toHaveBeenCalled();
    expect(settlements.createTransaction).not.toHaveBeenCalled();
    expect(prisma.workOrder.update).not.toHaveBeenCalled();
    expect(workOrders.transition).not.toHaveBeenCalled();
  });

  // guards: BR-PAY-016
  it('оплата з рахунком і нарядом: платника визначає рахунок (його можна виписати на іншого платника), перевірка наряду мовчить', async () => {
    // Наряд клієнта cp-owner, рахунок за цим нарядом виписано на платника CP_ID (напр. страхову).
    prisma.workOrder.findFirst.mockResolvedValue({
      ...invoicedWorkOrder,
      counterpartyId: 'cp-owner',
    });
    prisma.invoice.findFirst.mockResolvedValue({
      id: 'inv-1',
      counterpartyId: CP_ID,
      status: 'SENT',
      workOrderId: WO_ID,
      amount: 500,
      paidAmount: 0,
      currencyId: null,
    });
    prisma.invoice.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      service.create(ORG, { ...woDto, invoiceId: 'inv-1' }, 'user-1'),
    ).resolves.toBeDefined();
    expect(prisma.payment.create).toHaveBeenCalledTimes(1);
  });

  // guards: BR-PAY-001, BR-PAY-005
  it('наряд INVOICED → paidAmount += amount У транзакції, а transition(PAID) — ПІСЛЯ неї', async () => {
    let updateInTx: boolean | undefined;
    let transitionInTx: boolean | undefined;
    prisma.workOrder.updateMany.mockImplementation(() => {
      updateInTx = inTx;
      return Promise.resolve({ count: 1 });
    });
    workOrders.transition.mockImplementation(() => {
      transitionInTx = inTx;
      return Promise.resolve(undefined);
    });

    await service.create(ORG, woDto, 'user-1');

    // paidAmount пишеться умовно (CAS за прочитаним значенням), не сліпим increment.
    expect(prisma.workOrder.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.workOrder.updateMany).toHaveBeenCalledWith({
      where: { id: WO_ID, orgId: ORG, paidAmount: 0 },
      data: { paidAmount: 500 },
    });
    expect(updateInTx).toBe(true);

    // FSM — лише через WorkOrdersService.transition (CLAUDE.md §9), з власною транзакцією.
    expect(workOrders.transition).toHaveBeenCalledTimes(1);
    expect(workOrders.transition).toHaveBeenCalledWith(ORG, WO_ID, 'PAID', 'user-1');
    expect(transitionInTx).toBe(false);
  });

  // guards: BR-PAY-005
  it('transition(PAID) кидає → create НЕ валиться: платіж і settlement уже закомічені (best-effort)', async () => {
    workOrders.transition.mockRejectedValue(new Error('FSM: перехід заборонено'));

    const dto = await service.create(ORG, woDto, 'user-1');

    expect(dto.id).toBe(PAY_ID);
    expect(prisma.payment.create).toHaveBeenCalledTimes(1);
    expect(settlements.createTransaction).toHaveBeenCalledTimes(1);
  });

  it('оплата без workOrderId → наряд не чіпаємо: ні paidAmount, ні transition', async () => {
    await service.create(ORG, { counterpartyId: CP_ID, amount: 500, method: 'CASH' }, 'user-1');

    expect(prisma.payment.create).toHaveBeenCalledTimes(1);
    expect(prisma.workOrder.findFirst).not.toHaveBeenCalled();
    expect(prisma.workOrder.updateMany).not.toHaveBeenCalled();
    expect(workOrders.transition).not.toHaveBeenCalled();
  });

  // ── BR-PAY-017: «Оплачено» лише при повній оплаті ────────────────────────

  // guards: BR-PAY-017
  it('часткова оплата (500 із 1200) → paidAmount 500, наряд лишається INVOICED: transition не кличеться', async () => {
    prisma.workOrder.findFirst.mockResolvedValue({ ...invoicedWorkOrder, totalAmount: 1200 });

    await service.create(ORG, woDto, 'user-1');

    expect(prisma.workOrder.updateMany).toHaveBeenCalledWith({
      where: { id: WO_ID, orgId: ORG, paidAmount: 0 },
      data: { paidAmount: 500 },
    });
    expect(prisma.payment.create).toHaveBeenCalledTimes(1);
    expect(workOrders.transition).not.toHaveBeenCalled();
  });

  // guards: BR-PAY-017
  it('доплата решти (700 + 500 = 1200) → наряд переходить у PAID', async () => {
    prisma.workOrder.findFirst.mockResolvedValue({
      ...invoicedWorkOrder,
      totalAmount: 1200,
      paidAmount: 700,
    });

    await service.create(ORG, woDto, 'user-1');

    expect(prisma.workOrder.updateMany).toHaveBeenCalledWith({
      where: { id: WO_ID, orgId: ORG, paidAmount: 700 },
      data: { paidAmount: 1200 },
    });
    expect(workOrders.transition).toHaveBeenCalledWith(ORG, WO_ID, 'PAID', 'user-1');
  });

  // guards: BR-PAY-017
  it('копійки: 0.1 + 0.2 із 0.3 — це повна оплата, а не «бракує 4e-17»', async () => {
    prisma.workOrder.findFirst.mockResolvedValue({
      ...invoicedWorkOrder,
      totalAmount: 0.3,
      paidAmount: 0.1,
    });

    await service.create(ORG, { ...woDto, amount: 0.2 }, 'user-1');

    expect(prisma.workOrder.updateMany.mock.calls[0]![0].data).toEqual({ paidAmount: 0.3 });
    expect(workOrders.transition).toHaveBeenCalledTimes(1);
  });

  // guards: BR-PAY-017
  it('пряма оплата понад залишок (500 при залишку 300) → 400, без Payment, settlement і зміни наряду', async () => {
    prisma.workOrder.findFirst.mockResolvedValue({
      ...invoicedWorkOrder,
      totalAmount: 1200,
      paidAmount: 900,
    });

    await expect(service.create(ORG, woDto, 'user-1')).rejects.toThrow(BadRequestException);

    expect(prisma.workOrder.updateMany).not.toHaveBeenCalled();
    expect(settlements.createTransaction).not.toHaveBeenCalled();
    expect(workOrders.transition).not.toHaveBeenCalled();
  });

  // guards: BR-PAY-017
  it('паралельний платіж змінив paidAmount (CAS count=0) → 400 «повторіть», transition не кличеться', async () => {
    prisma.workOrder.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.create(ORG, woDto, 'user-1')).rejects.toThrow(BadRequestException);

    expect(workOrders.transition).not.toHaveBeenCalled();
  });

  // guards: BR-PAY-017
  it('оплата з рахунком: часткова оплата рахунку наряду теж лишає наряд INVOICED', async () => {
    prisma.workOrder.findFirst.mockResolvedValue({ ...invoicedWorkOrder, totalAmount: 1200 });
    prisma.invoice.findFirst.mockResolvedValue({
      id: 'inv-1',
      counterpartyId: CP_ID,
      status: 'SENT',
      workOrderId: WO_ID,
      amount: 1200,
      paidAmount: 0,
      currencyId: null,
    });
    prisma.invoice.updateMany.mockResolvedValue({ count: 1 });

    await service.create(ORG, { ...woDto, invoiceId: 'inv-1' }, 'user-1');

    expect(prisma.workOrder.updateMany.mock.calls[0]![0].data).toEqual({ paidAmount: 500 });
    expect(workOrders.transition).not.toHaveBeenCalled();
  });
});
