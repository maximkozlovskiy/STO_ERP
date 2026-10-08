/**
 * PaymentsService — Phase 2: findAll/findOne/retryFiscal/toDto
 *
 * Виділено з `payments.service.spec.ts` (був 1720 рядків, 5 незалежних top-level
 * describe) 2026-10-06. Кейси перенесені ДОСЛІВНО, назви describe не змінені —
 * інакше `fullName` у test-baseline.json розійшовся б.
 *
 * `exchangeRatesMock()` — з `./payments.spec-fixture` (був у преамбулі, 4 вживання).
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

describe('PaymentsService — Phase 2 findAll/findOne/retryFiscal/toDto', () => {
  let service: PaymentsService;
  let prisma: {
    counterparty: { findFirst: ReturnType<typeof vi.fn> };
    workOrder: { findFirst: ReturnType<typeof vi.fn> };
    garageBranch: { findFirst: ReturnType<typeof vi.fn> };
    payment: {
      findFirst: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
      count: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
  };
  let checkboxQueue: { add: ReturnType<typeof vi.fn> };

  const ORG = 'org-1';
  const CP_ID = '22222222-2222-4222-8222-222222222222';
  const PAY_ID = '44444444-4444-4444-8444-444444444444';

  // Мінімальний payment-рядок (як його повертає Prisma з PAYMENT_INCLUDE).
  const paymentRow = (over: Record<string, unknown> = {}) => ({
    id: PAY_ID,
    orgId: ORG,
    counterpartyId: CP_ID,
    workOrderId: null,
    invoiceId: null,
    amount: 500,
    method: 'card',
    notes: null,
    fiscalReceiptId: null,
    fiscalStatus: null,
    fiscalError: null,
    sourceType: null,
    bankAccountId: null,
    cashRegisterId: null,
    bankAccount: null,
    cashRegister: null,
    currency: null,
    currencyId: null,
    amountBase: null,
    rateUsed: null,
    createdAt: new Date('2026-09-06T15:00:00.000Z'),
    counterparty: { firstName: 'Іван', lastName: 'Петренко', companyName: null },
    ...over,
  });

  beforeEach(async () => {
    prisma = {
      counterparty: { findFirst: vi.fn() },
      workOrder: { findFirst: vi.fn() },
      garageBranch: { findFirst: vi.fn().mockResolvedValue({ id: 'br-1' }) },
      payment: {
        findFirst: vi.fn(),
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
        update: vi.fn().mockResolvedValue({}),
      },
    };
    checkboxQueue = { add: vi.fn().mockResolvedValue(undefined) };

    const module = await Test.createTestingModule({
      providers: [
        PaymentsService,
        { provide: PrismaService, useValue: prisma },
        { provide: SettlementsService, useValue: { createTransaction: vi.fn() } },
        { provide: NotificationsService, useValue: { send: vi.fn().mockResolvedValue(undefined) } },
        {
          provide: WorkOrdersService,
          useValue: { transition: vi.fn().mockResolvedValue(undefined) },
        },
        { provide: LoyaltyService, useValue: { queueEarn: vi.fn().mockResolvedValue(undefined) } },
        // C1: аудит best-effort — мок record() (no-op).
        { provide: AuditService, useValue: { record: vi.fn().mockResolvedValue(undefined) } },
        {
          provide: CashService,
          useValue: { createOperation: vi.fn().mockResolvedValue(undefined) },
        },
        { provide: ExchangeRatesService, useValue: exchangeRatesMock() },
        { provide: getQueueToken('checkbox'), useValue: checkboxQueue },
      ],
    }).compile();
    service = module.get(PaymentsService);
  });

  // Дістає where, з яким викликано findMany (щоб асертити межі createdAt/фільтри).
  const lastWhere = () =>
    (prisma.payment.findMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;

  // ── 1. Date-range INCLUSIVITY (review-fix 9710c556) ───────────────────────

  it('dateTo → where.createdAt.lte = кінець доби 23:59:59.999Z (inclusive-of-full-day)', async () => {
    await service.findAll(ORG, { dateTo: '2026-09-06' });
    const createdAt = lastWhere().createdAt as { lte?: Date };
    // МУТАЦІЯ-guard: якщо відкотити на `new Date(dateTo)` (midnight), lte був би
    // 2026-09-06T00:00:00Z і платіж о 15:00 випав би. Перевіряємо саме кінець доби.
    expect(createdAt.lte).toBeInstanceOf(Date);
    expect((createdAt.lte as Date).toISOString()).toBe('2026-09-06T23:59:59.999Z');
    // Платіж о 15:00 того ж дня МУСИТЬ проходити межу.
    const paidAt = new Date('2026-09-06T15:00:00.000Z');
    expect(paidAt.getTime()).toBeLessThanOrEqual((createdAt.lte as Date).getTime());
  });

  it('dateFrom → where.createdAt.gte = початок доби 00:00:00.000Z (нижня межа)', async () => {
    await service.findAll(ORG, { dateFrom: '2026-09-06' });
    const createdAt = lastWhere().createdAt as { gte?: Date };
    expect((createdAt.gte as Date).toISOString()).toBe('2026-09-06T00:00:00.000Z');
    // Платіж о 15:00 того ж дня МУСИТЬ проходити нижню межу.
    const paidAt = new Date('2026-09-06T15:00:00.000Z');
    expect(paidAt.getTime()).toBeGreaterThanOrEqual((createdAt.gte as Date).getTime());
  });

  it('dateFrom+dateTo разом → повний закритий інтервал [00:00:00.000, 23:59:59.999]', async () => {
    await service.findAll(ORG, { dateFrom: '2026-09-01', dateTo: '2026-09-06' });
    const createdAt = lastWhere().createdAt as { gte?: Date; lte?: Date };
    expect((createdAt.gte as Date).toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect((createdAt.lte as Date).toISOString()).toBe('2026-09-06T23:59:59.999Z');
  });

  it('без дат → where.createdAt відсутній (немає фільтра діапазону)', async () => {
    await service.findAll(ORG, {});
    expect(lastWhere().createdAt).toBeUndefined();
  });

  // ── 2. fiscalStatus фільтр (enum-guard review-fix) ────────────────────────

  it('fiscalStatus=FAILED (валідний enum) → where.fiscalStatus=FAILED', async () => {
    await service.findAll(ORG, { fiscalStatus: 'FAILED' });
    expect(lastWhere().fiscalStatus).toBe('FAILED');
  });

  it("fiscalStatus='none' → where.fiscalStatus=null (IS NULL — метод без фіскалізації)", async () => {
    await service.findAll(ORG, { fiscalStatus: 'none' });
    expect(lastWhere().fiscalStatus).toBeNull();
    expect('fiscalStatus' in lastWhere()).toBe(true);
  });

  it('fiscalStatus=garbage → фільтр НЕ застосовано (без 500) — MUTATION guard enum-Set', async () => {
    // МУТАЦІЯ-guard: якщо прибрати FISCAL_STATUS_VALUES.has() перевірку, 'xxx' дійшло б до
    // Prisma → HTTP 500. Валідне значення enum ігнорує невідоме → жодного where.fiscalStatus.
    await expect(service.findAll(ORG, { fiscalStatus: 'xxx' })).resolves.toBeDefined();
    expect('fiscalStatus' in lastWhere()).toBe(false);
  });

  it('fiscalStatus=DONE (інший валідний enum) → where.fiscalStatus=DONE', async () => {
    await service.findAll(ORG, { fiscalStatus: 'DONE' });
    expect(lastWhere().fiscalStatus).toBe('DONE');
  });

  it("fiscalStatus порожній рядок → фільтр НЕ застосовано (як 'усі')", async () => {
    await service.findAll(ORG, { fiscalStatus: '' });
    expect('fiscalStatus' in lastWhere()).toBe(false);
  });

  // ── 3. method + counterpartyId фільтри ────────────────────────────────────

  it('method=card → where.method=card (eq)', async () => {
    await service.findAll(ORG, { method: 'card' });
    expect(lastWhere().method).toBe('card');
  });

  it('counterpartyId валідний (org-scoped) → застосовано у where; findFirst перевіряє orgId', async () => {
    prisma.counterparty.findFirst.mockResolvedValue({ id: CP_ID });
    await service.findAll(ORG, { counterpartyId: CP_ID });
    expect(prisma.counterparty.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: CP_ID, orgId: ORG, deletedAt: null }),
      }),
    );
    expect(lastWhere().counterpartyId).toBe(CP_ID);
  });

  it('counterpartyId чужої org → NotFound (tenant isolation), findMany НЕ викликано', async () => {
    prisma.counterparty.findFirst.mockResolvedValue(null);
    await expect(service.findAll(ORG, { counterpartyId: CP_ID })).rejects.toThrow(
      NotFoundException,
    );
    expect(prisma.payment.findMany).not.toHaveBeenCalled();
  });

  it('where завжди містить orgId (tenant isolation базово)', async () => {
    await service.findAll(ORG, {});
    expect(lastWhere().orgId).toBe(ORG);
  });

  it('pagination: limit клампиться у [1,200], page у [1,∞) — DoS-hardening', async () => {
    await service.findAll(ORG, { limit: 999999, page: -5 });
    const args = prisma.payment.findMany.mock.calls[0][0] as { take: number; skip: number };
    expect(args.take).toBe(200); // clamp зверху
    expect(args.skip).toBe(0); // page клампиться до 1 → skip 0
  });

  // ── 4. findOne ────────────────────────────────────────────────────────────

  it('findOne валідний → toDto з counterpartyName та sourceName', async () => {
    prisma.payment.findFirst.mockResolvedValue(
      paymentRow({ bankAccount: { name: 'ПриватБанк' }, sourceType: 'BANK_ACCOUNT' }),
    );
    const dto = await service.findOne(ORG, PAY_ID);
    expect(prisma.payment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: PAY_ID, orgId: ORG } }),
    );
    expect(dto.id).toBe(PAY_ID);
    expect(dto.counterpartyName).toBe('Петренко Іван');
    expect(dto.sourceName).toBe('ПриватБанк');
  });

  it('findOne cross-org / missing → NotFound (findFirst повертає null)', async () => {
    prisma.payment.findFirst.mockResolvedValue(null);
    await expect(service.findOne(ORG, PAY_ID)).rejects.toThrow(NotFoundException);
  });

  // ── 5. toDto sourceName (bank → cash → null) ──────────────────────────────

  it('toDto: bankAccount.name присутній → sourceName = назва банку', async () => {
    prisma.payment.findFirst.mockResolvedValue(paymentRow({ bankAccount: { name: 'Моно' } }));
    expect((await service.findOne(ORG, PAY_ID)).sourceName).toBe('Моно');
  });

  it('toDto: лише cashRegister.name → sourceName = назва каси', async () => {
    prisma.payment.findFirst.mockResolvedValue(paymentRow({ cashRegister: { name: 'Каса №1' } }));
    expect((await service.findOne(ORG, PAY_ID)).sourceName).toBe('Каса №1');
  });

  it('toDto: ні bank ні cash → sourceName = null', async () => {
    prisma.payment.findFirst.mockResolvedValue(paymentRow());
    expect((await service.findOne(ORG, PAY_ID)).sourceName).toBeNull();
  });

  it('toDto: обидва присутні → пріоритет банку (bank ?? cash)', async () => {
    prisma.payment.findFirst.mockResolvedValue(
      paymentRow({ bankAccount: { name: 'Банк' }, cashRegister: { name: 'Каса' } }),
    );
    expect((await service.findOne(ORG, PAY_ID)).sourceName).toBe('Банк');
  });

  // ── 6. retryFiscal ────────────────────────────────────────────────────────

  const failedPayment = (over: Record<string, unknown> = {}) => ({
    id: PAY_ID,
    fiscalStatus: 'FAILED',
    fiscalReceiptId: null,
    method: 'card',
    amount: 500,
    workOrderId: null,
    ...over,
  });

  it('retryFiscal: FAILED + без receiptId → update QUEUED + checkboxQueue.add', async () => {
    prisma.payment.findFirst
      .mockResolvedValueOnce(failedPayment()) // select у retryFiscal
      .mockResolvedValueOnce(paymentRow({ fiscalStatus: 'QUEUED' })); // findOne у кінці
    await service.retryFiscal(ORG, PAY_ID);

    expect(prisma.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: PAY_ID, orgId: ORG },
        data: expect.objectContaining({ fiscalStatus: 'QUEUED', fiscalError: null }),
      }),
    );
    expect(checkboxQueue.add).toHaveBeenCalledTimes(1);
    expect(checkboxQueue.add).toHaveBeenCalledWith(
      'fiscal-receipt',
      expect.objectContaining({ paymentId: PAY_ID, orgId: ORG, method: 'card', amount: 500 }),
      expect.objectContaining({ attempts: 288 }),
    );
  });

  // Повторна фіскалізація — окремий `.add()` у retryFiscal зі своєю копією опцій: мусить тримати
  // ту саму політику, що й первинний чек (CLAUDE.md «Офлайн-незалежність»: ПРРО attempts=288,
  // backoff exponential). Сусідній кейс вище фіксує лише attempts.
  it('retryFiscal: повторний чек ПРРО ставиться з attempts=288 + exponential backoff від 5 хв — як первинний', async () => {
    prisma.payment.findFirst
      .mockResolvedValueOnce(failedPayment())
      .mockResolvedValueOnce(paymentRow({ fiscalStatus: 'QUEUED' }));
    await service.retryFiscal(ORG, PAY_ID);

    expect(checkboxQueue.add).toHaveBeenCalledTimes(1);
    expect(checkboxQueue.add.mock.calls[0][2]).toEqual({
      attempts: 288,
      backoff: { type: 'exponential', delay: 300_000 },
      removeOnComplete: true,
      removeOnFail: 200,
    });
  });

  it('retryFiscal: вже має fiscalReceiptId → 400 «уже пробито», БЕЗ enqueue (idempotency)', async () => {
    prisma.payment.findFirst.mockResolvedValue(
      failedPayment({ fiscalReceiptId: 'RCPT-1', fiscalStatus: 'FAILED' }),
    );
    await expect(service.retryFiscal(ORG, PAY_ID)).rejects.toThrow(/уже пробито/);
    expect(checkboxQueue.add).not.toHaveBeenCalled();
    expect(prisma.payment.update).not.toHaveBeenCalled();
  });

  it('retryFiscal: статус DONE (не FAILED) → 400, БЕЗ enqueue', async () => {
    prisma.payment.findFirst.mockResolvedValue(failedPayment({ fiscalStatus: 'DONE' }));
    await expect(service.retryFiscal(ORG, PAY_ID)).rejects.toThrow(/лише для чеків/);
    expect(checkboxQueue.add).not.toHaveBeenCalled();
  });

  it('retryFiscal: статус QUEUED (не FAILED) → 400', async () => {
    prisma.payment.findFirst.mockResolvedValue(failedPayment({ fiscalStatus: 'QUEUED' }));
    await expect(service.retryFiscal(ORG, PAY_ID)).rejects.toThrow(BadRequestException);
    expect(checkboxQueue.add).not.toHaveBeenCalled();
  });

  it('retryFiscal: статус SKIPPED (не FAILED) → 400', async () => {
    prisma.payment.findFirst.mockResolvedValue(failedPayment({ fiscalStatus: 'SKIPPED' }));
    await expect(service.retryFiscal(ORG, PAY_ID)).rejects.toThrow(BadRequestException);
    expect(checkboxQueue.add).not.toHaveBeenCalled();
  });

  it('retryFiscal: queue.add reject (Redis лежить) → .catch ставить FAILED, create НЕ кидає', async () => {
    prisma.payment.findFirst
      .mockResolvedValueOnce(failedPayment())
      .mockResolvedValueOnce(paymentRow({ fiscalStatus: 'FAILED' }));
    checkboxQueue.add.mockRejectedValue(new Error('Redis down'));

    // НЕ кидає — offline-first: помилка черги не валить HTTP-запит.
    await expect(service.retryFiscal(ORG, PAY_ID)).resolves.toBeDefined();
    // update викликано двічі: 1) QUEUED (на старті), 2) FAILED (у .catch).
    expect(prisma.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          fiscalStatus: 'FAILED',
          fiscalError: expect.stringContaining('Черга недоступна'),
        }),
      }),
    );
  });

  it('retryFiscal: cross-org id → NotFound (tenant-scoped), БЕЗ enqueue/update', async () => {
    prisma.payment.findFirst.mockResolvedValue(null);
    await expect(service.retryFiscal(ORG, PAY_ID)).rejects.toThrow(NotFoundException);
    expect(checkboxQueue.add).not.toHaveBeenCalled();
    expect(prisma.payment.update).not.toHaveBeenCalled();
  });

  it('retryFiscal: гейт receiptId перевіряється ПЕРЕД гейтом статусу (правильний порядок)', async () => {
    // Payment FAILED але з receiptId → має спрацювати «уже пробито», не «лише для FAILED».
    prisma.payment.findFirst.mockResolvedValue(
      failedPayment({ fiscalStatus: 'FAILED', fiscalReceiptId: 'RCPT-1' }),
    );
    await expect(service.retryFiscal(ORG, PAY_ID)).rejects.toThrow(/уже пробито/);
  });

  // ── Пошук (рішення власника 2026-10-09) ───────────────────────────────────

  it('q → клієнт (назва / прізвище / імʼя), номер рахунку, номер наряду або примітка', async () => {
    await service.findAll(ORG, { q: 'петренко' });

    const contains = { contains: 'петренко', mode: 'insensitive' };
    expect(lastWhere().OR).toEqual([
      { notes: contains },
      { counterparty: { companyName: contains } },
      { counterparty: { lastName: contains } },
      { counterparty: { firstName: contains } },
      { invoice: { number: contains } },
      { workOrder: { number: contains } },
    ]);
  });

  it('пошук не послаблює tenant-фільтр і діє разом з іншими фільтрами', async () => {
    await service.findAll(ORG, { q: 'РАХ-2026', method: 'cash', dateFrom: '2026-09-01' });

    const where = lastWhere();
    expect(where.orgId).toBe(ORG);
    expect(where.method).toBe('cash');
    expect(where.createdAt).toBeDefined();
    expect(JSON.stringify(where.OR)).not.toContain('orgId');
    expect(
      (prisma.payment.count.mock.calls[0][0] as { where: Record<string, unknown> }).where,
    ).toEqual(where);
  });

  it.each([undefined, '', '   '])('порожній q (%j) умови не додає', async q => {
    await service.findAll(ORG, { q });

    expect(lastWhere()).not.toHaveProperty('OR');
  });
});

/**
 * Мультивалюта (Фаза 2) — Payment у валюті рахунку-призначення.
 * Інваріанти:
 *   1. Оплата у касу з currencyId → payment.create пише currencyId/amountBase/rateUsed (по курсу).
 *   2. settlements.createTransaction отримує currencyId → борг у base.
 *   3. loyalty.queueEarn отримує amountBase (не dto.amount) — бали у base.
 *   4. Фіскальна каса у НЕ-базовій валюті → 400 (ПРРО лише у base), без payment.create.
 *   5. Фіскальна каса у БАЗОВІЙ валюті (currencyId == base) → успіх (чек ставиться).
 */
