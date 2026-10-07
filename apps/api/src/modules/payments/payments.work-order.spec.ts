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
    workOrder: { findFirst: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
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

  const invoicedWorkOrder = { branchId: 'br-1', status: 'INVOICED', currencyId: null };

  beforeEach(async () => {
    inTx = false;
    prisma = {
      counterparty: { findFirst: vi.fn().mockResolvedValue(cp) },
      workOrder: {
        findFirst: vi.fn().mockResolvedValue(invoicedWorkOrder),
        update: vi.fn().mockResolvedValue({}),
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

  // ── BR-PAY-005: paidAmount наряду + best-effort FSM ───────────────────────

  // guards: BR-PAY-001, BR-PAY-005
  it('наряд INVOICED → paidAmount += amount У транзакції, а transition(PAID) — ПІСЛЯ неї', async () => {
    let updateInTx: boolean | undefined;
    let transitionInTx: boolean | undefined;
    prisma.workOrder.update.mockImplementation(() => {
      updateInTx = inTx;
      return Promise.resolve({});
    });
    workOrders.transition.mockImplementation(() => {
      transitionInTx = inTx;
      return Promise.resolve(undefined);
    });

    await service.create(ORG, woDto, 'user-1');

    expect(prisma.workOrder.update).toHaveBeenCalledTimes(1);
    expect(prisma.workOrder.update).toHaveBeenCalledWith({
      where: { id: WO_ID, orgId: ORG },
      data: { paidAmount: { increment: 500 } },
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
    expect(prisma.workOrder.update).not.toHaveBeenCalled();
    expect(workOrders.transition).not.toHaveBeenCalled();
  });
});
