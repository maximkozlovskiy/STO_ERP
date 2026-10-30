/**
 * Оплата постачальнику однією дією (BR-SUPPAY-013) і підстава оплати — лише замовлення
 * «Замовлено» / «Частково» / «Отримано» (BR-SUPPAY-015).
 *
 * Рішення власника 2026-10-30 (TECH-DEBT (б) №34, №38): «Оплатити» в картці замовлення й каса
 * створюють і проводять оплату в ОДНІЙ транзакції, з номером документа в ній же — відмова не
 * лишає ні скасованої чернетки, ні витраченого номера (до того web слав create → confirm → cancel,
 * і з 2026-10-25 confirm без ключа завжди падав: Bug #1020). Що номер справді відкочується в
 * Postgres — `supplier-payments.pay-rollback.integration.spec.ts`.
 */
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { PaymentSourceType, SupplierPaymentStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { SupplierPaymentsController } from './supplier-payments.controller';
import { SupplierPaymentsService } from './supplier-payments.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RequiredIdempotencyInterceptor } from '../../common/interceptors/idempotency.interceptor';
import { makeIdempotencyStore } from '../../common/testing/idempotency-store';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import {
  makeSpHarness,
  type SpHarness,
  ORG,
  SP_ID,
  SUPPLIER_ID,
  CASH_ID,
  USER_ID,
  confirmedRow,
} from './supplier-payments.spec-fixture';

const PO_ID = '55555555-5555-4555-8555-555555555555';

const cashPayment = (over: Record<string, unknown> = {}) => ({
  supplierId: SUPPLIER_ID,
  sourceType: PaymentSourceType.CASH_REGISTER,
  cashRegisterId: CASH_ID,
  amount: 300,
  method: 'cash',
  ...over,
});

describe('SupplierPaymentsService.createAndConfirm — одна транзакція (BR-SUPPAY-013)', () => {
  let h: SpHarness;

  beforeEach(async () => {
    h = await makeSpHarness();
    h.prisma.counterparty.findFirst.mockResolvedValue({ id: SUPPLIER_ID, type: 'SUPPLIER' });
    h.prisma.cashRegister.findFirst.mockResolvedValue({ id: CASH_ID, currencyId: 'uah' });
    h.prisma.supplierPayment.create.mockResolvedValue({ ...confirmedRow, status: 'DRAFT' });
    h.prisma.supplierPayment.findFirst.mockResolvedValue(confirmedRow); // findOne після коміту
  });

  /** Замовлення-підстава: одна відповідь і на пошук для створення, і на читання для проведення. */
  const orderIs = (status: string) =>
    h.prisma.purchaseOrder.findFirst.mockResolvedValue({
      id: PO_ID,
      supplierId: SUPPLIER_ID,
      status,
      currencyId: 'uah',
      totalAmount: 1000,
      paidAmount: 0,
      paidAt: null,
    });

  // guards: BR-SUPPAY-013
  it('номер, запис і проведення — в ОДНІЙ транзакції: номер береться її tx, далі CAS, борг, каса', async () => {
    const res = await h.service.createAndConfirm(ORG, cashPayment(), USER_ID);

    expect(h.prisma.$transaction).toHaveBeenCalledTimes(1);
    const tx = h.prisma; // harness віддає колбеку той самий об'єкт як tx
    expect(h.docNumbers.next).toHaveBeenCalledWith(ORG, 'SUPPLIER_PAYMENT', tx);
    expect(h.prisma.supplierPayment.create).toHaveBeenCalledTimes(1);
    expect(h.prisma.supplierPayment.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: SP_ID, status: SupplierPaymentStatus.DRAFT },
      data: { status: SupplierPaymentStatus.CONFIRMED },
    });
    expect(h.settlements.createTransaction.mock.calls[0][1]).toMatchObject({
      type: 'SUPPLIER_PAYMENT',
      amount: 300,
      documentId: SP_ID,
    });
    expect(h.settlements.createTransaction.mock.calls[0][2]).toBe(tx);
    expect(h.cash.createOperation.mock.calls[0][1]).toMatchObject({
      cashRegisterId: CASH_ID,
      direction: 'OUT',
      reason: 'SUPPLIER_PAYMENT',
      documentId: SP_ID,
    });
    expect(h.cash.createOperation.mock.calls[0][2]).toBe(tx);
    // Порядок: номер → документ → проведення (номер блокує лічильник якомога коротше, але в tx).
    expect(h.docNumbers.next.mock.invocationCallOrder[0]).toBeLessThan(
      h.prisma.supplierPayment.create.mock.invocationCallOrder[0],
    );
    expect(res.status).toBe(SupplierPaymentStatus.CONFIRMED);
  });

  // guards: BR-SUPPAY-013
  it('каса відмовила (в мінус / зміна закрита) → помилка піднята; скасування й другої транзакції немає', async () => {
    const boom = new BadRequestException('Недостатньо готівки в касі');
    h.cash.createOperation.mockRejectedValueOnce(boom);

    await expect(h.service.createAndConfirm(ORG, cashPayment(), USER_ID)).rejects.toBe(boom);

    expect(h.prisma.$transaction).toHaveBeenCalledTimes(1);
    const cancelled = h.prisma.supplierPayment.updateMany.mock.calls.some(
      ([a]: [{ data: { status?: string } }]) => a.data.status === SupplierPaymentStatus.CANCELLED,
    );
    expect(cancelled).toBe(false);
  });

  // guards: BR-SUPPAY-013, BR-SUPPAY-015
  it('перевірки — до транзакції: замовлення «Скасовано» → 400, номера не взято', async () => {
    orderIs('CANCELLED');

    await expect(
      h.service.createAndConfirm(ORG, cashPayment({ purchaseOrderId: PO_ID }), USER_ID),
    ).rejects.toThrow(/Замовлено.*Скасовано/s);

    expect(h.prisma.$transaction).not.toHaveBeenCalled();
    expect(h.docNumbers.next).not.toHaveBeenCalled();
  });

  // guards: BR-SUPPAY-015
  it('замовлення «Замовлено» → оплачено, «сплачено» замовлення росте CAS-ом лише в статусах оплати', async () => {
    orderIs('ORDERED');

    await h.service.createAndConfirm(ORG, cashPayment({ purchaseOrderId: PO_ID }), USER_ID);

    const [cas] = h.prisma.purchaseOrder.updateMany.mock.calls[0] as [
      { where: { id: string; status: { in: string[] } }; data: { paidAmount: number } },
    ];
    expect(cas.where.id).toBe(PO_ID);
    expect([...cas.where.status.in].sort()).toEqual(['ORDERED', 'PARTIAL', 'RECEIVED']);
    expect(cas.data.paidAmount).toBe(300);
  });
});

describe('Підстава оплати постачальнику — статус замовлення (BR-SUPPAY-015)', () => {
  let h: SpHarness;

  beforeEach(async () => {
    h = await makeSpHarness();
    h.prisma.counterparty.findFirst.mockResolvedValue({ id: SUPPLIER_ID, type: 'SUPPLIER' });
    h.prisma.cashRegister.findFirst.mockResolvedValue({ id: CASH_ID, currencyId: 'uah' });
    h.prisma.supplierPayment.create.mockResolvedValue({ ...confirmedRow, status: 'DRAFT' });
  });

  const orderIs = (status: string) =>
    h.prisma.purchaseOrder.findFirst.mockResolvedValue({
      id: PO_ID,
      supplierId: SUPPLIER_ID,
      status,
      currencyId: 'uah',
      totalAmount: 1000,
      paidAmount: 0,
      paidAt: null,
    });

  // guards: BR-SUPPAY-015
  it.each(['ORDERED', 'PARTIAL', 'RECEIVED'])('замовлення %s приймає оплату', async status => {
    orderIs(status);
    await h.service.create(ORG, cashPayment({ purchaseOrderId: PO_ID }), USER_ID);
    expect(h.prisma.supplierPayment.create).toHaveBeenCalledTimes(1);
  });

  // guards: BR-SUPPAY-015
  it.each([
    ['DRAFT', 'Чернетка'],
    ['CANCELLED', 'Скасовано'],
  ])('замовлення %s → 400 з назвою статусу, нічого не записано', async (status, label) => {
    orderIs(status);
    const call = h.service.create(ORG, cashPayment({ purchaseOrderId: PO_ID }), USER_ID);
    await expect(call).rejects.toThrow(BadRequestException);
    await expect(call).rejects.toThrow(label);
    expect(h.prisma.supplierPayment.create).not.toHaveBeenCalled();
    expect(h.docNumbers.next).not.toHaveBeenCalled();
  });

  // Стара чернетка (до правила) на замовлення, яке відтоді скасували: «Провести» перевіряє той самий
  // статус, а не лише статус самої оплати.
  // guards: BR-SUPPAY-014, BR-SUPPAY-015
  it('проведення старої чернетки на скасоване замовлення → 400 до транзакції', async () => {
    h.prisma.supplierPayment.findFirst.mockResolvedValueOnce({
      status: SupplierPaymentStatus.DRAFT,
      supplierId: SUPPLIER_ID,
      amount: 300,
      sourceType: PaymentSourceType.CASH_REGISTER,
      cashRegisterId: CASH_ID,
      currencyId: null,
      purchaseOrderId: PO_ID,
    });
    orderIs('CANCELLED');

    await expect(h.service.confirm(ORG, SP_ID, USER_ID)).rejects.toThrow(/Скасовано/);

    expect(h.prisma.$transaction).not.toHaveBeenCalled();
    expect(h.settlements.createTransaction).not.toHaveBeenCalled();
    expect(h.cash.createOperation).not.toHaveBeenCalled();
  });
});

// ─── HTTP: POST /supplier-payments/pay ─────────────────────────────────────────────────────────

const serviceMock = { createAndConfirm: vi.fn() };
let jwtRole = 'ACCOUNTANT';
const mockJwtGuard = {
  canActivate: vi.fn().mockImplementation((ctx: ExecutionContext) => {
    const req = ctx.switchToHttp().getRequest<{ user?: unknown }>();
    req.user = { id: USER_ID, orgId: ORG, role: jwtRole };
    return true;
  }),
};

describe('POST /supplier-payments/pay — HTTP-контракт (BR-SUPPAY-013)', () => {
  let app: INestApplication;
  let store: ReturnType<typeof makeIdempotencyStore>;

  beforeAll(async () => {
    store = makeIdempotencyStore();
    const module = await Test.createTestingModule({
      controllers: [SupplierPaymentsController],
      providers: [
        { provide: SupplierPaymentsService, useValue: serviceMock },
        { provide: PrismaService, useValue: { idempotencyKey: store.idempotencyKey } },
        RequiredIdempotencyInterceptor,
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(mockJwtGuard)
      .overrideGuard(RolesGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => new RolesGuard(new Reflector()).canActivate(ctx),
      })
      .compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    await app.init();
    await (app as NestFastifyApplication).getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jwtRole = 'ACCOUNTANT';
    store.rows.clear();
    serviceMock.createAndConfirm.mockReset();
    serviceMock.createAndConfirm.mockImplementation(() =>
      Promise.resolve({ id: randomUUID(), status: 'CONFIRMED' }),
    );
  });

  const pay = (key: string | null = randomUUID()) =>
    (app as NestFastifyApplication).inject({
      method: 'POST',
      url: '/supplier-payments/pay',
      payload: cashPayment({ amount: '300.50' }),
      ...(key && { headers: { 'idempotency-key': key } }),
    });

  // guards: BR-SUPPAY-013
  it('без Idempotency-Key → 400, оплата не створюється', async () => {
    const res = await pay(null);
    expect(res.statusCode).toBe(400);
    expect(serviceMock.createAndConfirm).not.toHaveBeenCalled();
  });

  // guards: BR-SUPPAY-013
  it.each(['OWNER', 'ADMIN', 'ACCOUNTANT'])(
    '%s → 201; сервіс отримує orgId, оплату (сума числом) і автора',
    async role => {
      jwtRole = role;
      const res = await pay();
      expect(res.statusCode).toBe(201);
      expect(serviceMock.createAndConfirm).toHaveBeenCalledWith(
        ORG,
        expect.objectContaining({ supplierId: SUPPLIER_ID, amount: 300.5, method: 'cash' }),
        USER_ID,
      );
    },
  );

  // guards: BR-SUPPAY-013
  it.each(['STOREKEEPER', 'RECEPTIONIST', 'MECHANIC'])('%s → 403', async role => {
    jwtRole = role;
    const res = await pay();
    expect(res.statusCode).toBe(403);
    expect(serviceMock.createAndConfirm).not.toHaveBeenCalled();
  });

  // Обрив відповіді: web повторює той самий запит із тим самим ключем — друга оплата не проводиться.
  // guards: BR-SUPPAY-013
  it('повтор із тим самим ключем → та сама відповідь, оплата проведена рівно раз', async () => {
    const key = randomUUID();
    const first = await pay(key);
    const second = await pay(key);

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBeLessThan(300);
    expect(second.json()).toEqual(first.json());
    expect(serviceMock.createAndConfirm).toHaveBeenCalledTimes(1);
  });
});
