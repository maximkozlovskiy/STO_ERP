import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { LoyaltyService } from './loyalty.service';
import { PrismaService } from '../../prisma/prisma.service';
import { getQueueToken } from '@nestjs/bullmq';
import { Prisma } from '@prisma/client';

/**
 * Bug #254: unit-покриття `LoyaltyService.redeem`.
 *
 * Фокус — atomic check-and-decrement у `redeem`:
 *   • `updateMany({ where: { id, balance: { gte: points } } })` — атомарний guard
 *   • `count === 0` → `BadRequestException('Недостатньо балів')`
 *
 * Без spec будь-який refactor що замінить `gte` на `gt`, або зробить read+write
 * без атомарної умови, відкриє double-spend race у проді (двоє паралельних
 * redeem-запитів обидва побачать достатньо балансу, обидва списать).
 */
describe('LoyaltyService.redeem', () => {
  let service: LoyaltyService;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  const orgId = 'org-1';
  const counterpartyId = 'cp-1';
  const accountId = 'acc-1';

  beforeEach(async () => {
    prisma = {
      counterparty: { findFirst: vi.fn() },
      organisationSettings: { findFirst: vi.fn() },
      loyaltyAccount: {
        findFirst: vi.fn(),
        updateMany: vi.fn(),
        update: vi.fn(),
      },
      loyaltyTransaction: {
        create: vi.fn(),
      },
      $transaction: vi.fn(async (cb: (tx: typeof prisma) => Promise<unknown>) => cb(prisma)),
    };
    const loyaltyQueueMock = { add: vi.fn() };
    const module = await Test.createTestingModule({
      providers: [
        LoyaltyService,
        { provide: PrismaService, useValue: prisma },
        { provide: getQueueToken('loyalty'), useValue: loyaltyQueueMock },
      ],
    }).compile();
    service = module.get(LoyaltyService);
  });

  // guards: BR-LOY-009, BR-LOY-011
  it('happy path: атомарний updateMany з balance: { gte: points }, потім LoyaltyTransaction', async () => {
    prisma.counterparty.findFirst.mockResolvedValueOnce({ id: counterpartyId });
    prisma.organisationSettings.findFirst.mockResolvedValueOnce({ loyaltyRedeemRate: 1 });
    prisma.loyaltyAccount.findFirst.mockResolvedValueOnce({ id: accountId });
    prisma.loyaltyAccount.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.loyaltyTransaction.create.mockResolvedValueOnce({ id: 'tx-1' });

    const result = await service.redeem(orgId, counterpartyId, 50);

    // Bug #254: критичний guard — `updateMany` з `balance: { gte: points }`.
    // Регресія `gte` → `gt` блокує точне витрачання, регресія зняття guard взагалі
    // дозволяє double-spend → CI має це ловити.
    expect(prisma.loyaltyAccount.updateMany).toHaveBeenCalledTimes(1);
    const updateArgs = prisma.loyaltyAccount.updateMany.mock.calls[0][0];
    expect(updateArgs.where.id).toBe(accountId);
    expect(updateArgs.where.balance).toEqual({ gte: 50 });
    expect(updateArgs.data.balance).toEqual({ decrement: 50 });

    // НЕ викликати простий update — щоб refactor назад до неатомарного шляху провалив тест.
    expect(prisma.loyaltyAccount.update).not.toHaveBeenCalled();

    // LoyaltyTransaction (REDEEM) має бути створена з правильним accountId.
    expect(prisma.loyaltyTransaction.create).toHaveBeenCalledTimes(1);
    const txArgs = prisma.loyaltyTransaction.create.mock.calls[0][0];
    expect(txArgs.data.accountId).toBe(accountId);
    expect(txArgs.data.type).toBe('REDEEM');
    expect(txArgs.data.points).toBe(50);

    expect(result.discountAmount).toBe(50);
  });

  // Pre-prod audit R2: дробові бали (10.007) квантуються до 2dp ПЕРЕД gte/decrement — інакше
  // атомарний guard використав би 10.007, а LoyaltyTransaction.points зберіг би 10.01 → balance
  // розходиться з Σ(ledger). Обидва мусять використати ІДЕНТИЧНЕ квантоване значення.
  // guards: BR-LOY-008
  it('дробові points (10.007) → gte/decrement І ledger усі використовують 10.01 (без дрейфу)', async () => {
    prisma.counterparty.findFirst.mockResolvedValueOnce({ id: counterpartyId });
    prisma.organisationSettings.findFirst.mockResolvedValueOnce({ loyaltyRedeemRate: 1 });
    prisma.loyaltyAccount.findFirst.mockResolvedValueOnce({ id: accountId });
    prisma.loyaltyAccount.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.loyaltyTransaction.create.mockResolvedValueOnce({ id: 'tx-1' });

    await service.redeem(orgId, counterpartyId, 10.007);

    const updateArgs = prisma.loyaltyAccount.updateMany.mock.calls[0][0];
    expect(updateArgs.where.balance).toEqual({ gte: 10.01 });
    expect(updateArgs.data.balance).toEqual({ decrement: 10.01 });
    expect(prisma.loyaltyTransaction.create.mock.calls[0][0].data.points).toBe(10.01);
  });

  // guards: BR-LOY-009
  it('недостатньо балів: updateMany.count === 0 → BadRequestException', async () => {
    prisma.counterparty.findFirst.mockResolvedValueOnce({ id: counterpartyId });
    prisma.organisationSettings.findFirst.mockResolvedValueOnce({ loyaltyRedeemRate: 1 });
    prisma.loyaltyAccount.findFirst.mockResolvedValueOnce({ id: accountId });
    // Critical: count=0 моделює реальний випадок коли BD виявила недостатньо балансу
    prisma.loyaltyAccount.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(service.redeem(orgId, counterpartyId, 5000)).rejects.toBeInstanceOf(
      BadRequestException,
    );

    // LoyaltyTransaction НЕ створюється коли guard зафейлив.
    expect(prisma.loyaltyTransaction.create).not.toHaveBeenCalled();
  });

  // guards: BR-LOY-012
  it('контрагент відсутній → NotFoundException, $transaction не викликаний', async () => {
    prisma.counterparty.findFirst.mockResolvedValueOnce(null);
    prisma.organisationSettings.findFirst.mockResolvedValueOnce({ loyaltyRedeemRate: 1 });

    await expect(service.redeem(orgId, counterpartyId, 50)).rejects.toBeInstanceOf(
      NotFoundException,
    );

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('обліковий запис лояльності відсутній → NotFoundException("Рахунок лояльності не знайдено")', async () => {
    prisma.counterparty.findFirst.mockResolvedValueOnce({ id: counterpartyId });
    prisma.organisationSettings.findFirst.mockResolvedValueOnce({ loyaltyRedeemRate: 1 });
    prisma.loyaltyAccount.findFirst.mockResolvedValueOnce(null);

    await expect(service.redeem(orgId, counterpartyId, 50)).rejects.toBeInstanceOf(
      NotFoundException,
    );

    expect(prisma.loyaltyAccount.updateMany).not.toHaveBeenCalled();
    expect(prisma.loyaltyTransaction.create).not.toHaveBeenCalled();
  });

  it('points <= 0 → BadRequestException ("Кількість балів має бути > 0")', async () => {
    await expect(service.redeem(orgId, counterpartyId, 0)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.redeem(orgId, counterpartyId, -5)).rejects.toBeInstanceOf(
      BadRequestException,
    );

    // Жодного prisma-виклику до самого ранього guard.
    expect(prisma.counterparty.findFirst).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  // guards: BR-LOY-010
  it('redeemRate з налаштувань впливає на discountAmount', async () => {
    prisma.counterparty.findFirst.mockResolvedValueOnce({ id: counterpartyId });
    // 1 бал = 2 грн знижки
    prisma.organisationSettings.findFirst.mockResolvedValueOnce({ loyaltyRedeemRate: 2 });
    prisma.loyaltyAccount.findFirst.mockResolvedValueOnce({ id: accountId });
    prisma.loyaltyAccount.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.loyaltyTransaction.create.mockResolvedValueOnce({ id: 'tx-1' });

    const result = await service.redeem(orgId, counterpartyId, 50);

    expect(result.discountAmount).toBe(100); // 50 балів × 2 грн
  });

  // guards: BR-LOY-010
  it('discountAmount квантується до 2dp: 10.01 бала × 1.1 грн → 11.01 (не 11.011)', async () => {
    prisma.counterparty.findFirst.mockResolvedValueOnce({ id: counterpartyId });
    prisma.organisationSettings.findFirst.mockResolvedValueOnce({ loyaltyRedeemRate: 1.1 });
    prisma.loyaltyAccount.findFirst.mockResolvedValueOnce({ id: accountId });
    prisma.loyaltyAccount.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.loyaltyTransaction.create.mockResolvedValueOnce({ id: 'tx-1' });

    const result = await service.redeem(orgId, counterpartyId, 10.01);

    expect(result.discountAmount).toBe(11.01);
  });

  // guards: BR-LOY-011
  it('REDEEM-рядок леджера пишеться через tx-клієнт тієї ж $transaction, що й decrement', async () => {
    // tx — ОКРЕМИЙ об'єкт від prisma: якщо запис леджера (або decrement) піде повз транзакцію
    // через this.prisma, списання і його слід у леджері перестануть бути атомарними.
    const tx = {
      loyaltyAccount: {
        findFirst: vi.fn().mockResolvedValue({ id: accountId }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      loyaltyTransaction: { create: vi.fn().mockResolvedValue({ id: 'tx-1' }) },
    };
    prisma.$transaction.mockImplementationOnce(async (cb: (t: typeof tx) => Promise<unknown>) =>
      cb(tx),
    );
    prisma.counterparty.findFirst.mockResolvedValueOnce({ id: counterpartyId });
    prisma.organisationSettings.findFirst.mockResolvedValueOnce({ loyaltyRedeemRate: 1 });

    await service.redeem(orgId, counterpartyId, 50);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.loyaltyAccount.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.loyaltyTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ accountId, type: 'REDEEM', points: 50 }),
    });
    expect(prisma.loyaltyAccount.updateMany).not.toHaveBeenCalled();
    expect(prisma.loyaltyTransaction.create).not.toHaveBeenCalled();
  });
});

describe('LoyaltyService.earn', () => {
  let service: LoyaltyService;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  const orgId = 'org-1';
  const counterpartyId = 'cp-1';

  beforeEach(async () => {
    prisma = {
      counterparty: { findFirst: vi.fn() },
      organisationSettings: { findFirst: vi.fn() },
      loyaltyAccount: {
        upsert: vi.fn().mockResolvedValue({ id: 'acc-1', balance: 0 }),
        update: vi.fn(),
      },
      loyaltyTransaction: {
        create: vi.fn(),
        findFirst: vi.fn().mockResolvedValue(null),
      },
      $transaction: vi.fn(async (cb: (tx: typeof prisma) => Promise<unknown>) => cb(prisma)),
    };
    const loyaltyQueueMock = { add: vi.fn() };
    const module = await Test.createTestingModule({
      providers: [
        LoyaltyService,
        { provide: PrismaService, useValue: prisma },
        { provide: getQueueToken('loyalty'), useValue: loyaltyQueueMock },
      ],
    }).compile();
    service = module.get(LoyaltyService);
  });

  // guards: BR-LOY-002
  it('Bug #271: paymentAmount=NaN → ранній return без doторкання $transaction', async () => {
    await service.earn(orgId, counterpartyId, Number.NaN);
    expect(prisma.organisationSettings.findFirst).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.loyaltyTransaction.create).not.toHaveBeenCalled();
  });

  // guards: BR-LOY-002
  it('Bug #271: paymentAmount=Infinity → ранній return без $transaction', async () => {
    await service.earn(orgId, counterpartyId, Number.POSITIVE_INFINITY);
    expect(prisma.organisationSettings.findFirst).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  // guards: BR-LOY-002
  it('Bug #271: paymentAmount=0 → ранній return без $transaction', async () => {
    await service.earn(orgId, counterpartyId, 0);
    expect(prisma.organisationSettings.findFirst).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  // guards: BR-LOY-002
  it('loyaltyEnabled=false → ранній return після перевірки settings', async () => {
    prisma.organisationSettings.findFirst.mockResolvedValueOnce({ loyaltyEnabled: false });
    await service.earn(orgId, counterpartyId, 1000);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.loyaltyTransaction.create).not.toHaveBeenCalled();
  });

  // guards: BR-LOY-002
  it('happy path: paymentAmount=1000, earnPer=100, earnPoints=1 → +10 points', async () => {
    prisma.counterparty.findFirst.mockResolvedValue({ id: counterpartyId });
    prisma.organisationSettings.findFirst.mockResolvedValueOnce({
      loyaltyEnabled: true,
      loyaltyEarnPer: 100,
      loyaltyEarnPoints: 1,
    });
    await service.earn(orgId, counterpartyId, 1000);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.loyaltyAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { balance: { increment: 10 } },
      }),
    );
    expect(prisma.loyaltyTransaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: 'EARN', points: 10 }),
      }),
    );
  });

  // guards: BR-LOY-003, BR-LOY-004, BR-LOY-005
  it('ідемпотентність: повторний job з тим самим documentId НЕ подвоює нарахування', async () => {
    // BullMQ attempts=10: якщо tx закомітилась, але worker впав до ACK — job повториться.
    // Без idempotency-guard баланс інкрементувався б удруге + дубль LoyaltyTransaction.
    prisma.counterparty.findFirst.mockResolvedValue({ id: counterpartyId });
    prisma.organisationSettings.findFirst.mockResolvedValue({
      loyaltyEnabled: true,
      loyaltyEarnPer: 100,
      loyaltyEarnPoints: 1,
    });
    // Симулюємо повторний запуск: EARN за цей документ вже існує.
    prisma.loyaltyTransaction.findFirst.mockResolvedValueOnce({ id: 'existing-earn' });

    await service.earn(orgId, counterpartyId, 1000, 'payment-1');

    // Guard спрацював всередині tx → жодного інкременту балансу, жодного нового запису.
    expect(prisma.loyaltyTransaction.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          accountId: 'acc-1',
          type: 'EARN',
          documentId: 'payment-1',
        }),
      }),
    );
    expect(prisma.loyaltyAccount.update).not.toHaveBeenCalled();
    expect(prisma.loyaltyTransaction.create).not.toHaveBeenCalled();
  });

  it('ідемпотентність: перше нарахування за documentId проходить (findFirst=null)', async () => {
    prisma.counterparty.findFirst.mockResolvedValue({ id: counterpartyId });
    prisma.organisationSettings.findFirst.mockResolvedValue({
      loyaltyEnabled: true,
      loyaltyEarnPer: 100,
      loyaltyEarnPoints: 1,
    });
    prisma.loyaltyTransaction.findFirst.mockResolvedValueOnce(null); // ще не нараховано

    await service.earn(orgId, counterpartyId, 1000, 'payment-2');

    expect(prisma.loyaltyAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { balance: { increment: 10 } } }),
    );
    expect(prisma.loyaltyTransaction.create).toHaveBeenCalledTimes(1);
  });
  // guards: BR-LOY-002
  it('points = floor(amount / earnPer) × earnPoints, квантовано до 2dp: 350 / 100 × 1.1 → 3.3', async () => {
    // floor: 350 грн при кроці 100 — це 3 повні батчі, не 3.5.
    // 2dp: 3 × 1.1 === 3.3000000000000003 у float — у balance і леджер має піти рівно 3.3.
    prisma.counterparty.findFirst.mockResolvedValue({ id: counterpartyId });
    prisma.organisationSettings.findFirst.mockResolvedValueOnce({
      loyaltyEnabled: true,
      loyaltyEarnPer: 100,
      loyaltyEarnPoints: 1.1,
    });

    await service.earn(orgId, counterpartyId, 350);

    expect(prisma.loyaltyAccount.update.mock.calls[0][0].data).toEqual({
      balance: { increment: 3.3 },
    });
    expect(prisma.loyaltyTransaction.create.mock.calls[0][0].data.points).toBe(3.3);
  });

  // guards: BR-LOY-002
  it('оплата менша за крок нарахування (99 грн при earnPer=100) → 0 балів, нічого не пишеться', async () => {
    prisma.counterparty.findFirst.mockResolvedValue({ id: counterpartyId });
    prisma.organisationSettings.findFirst.mockResolvedValueOnce({
      loyaltyEnabled: true,
      loyaltyEarnPer: 100,
      loyaltyEarnPoints: 1,
    });

    await service.earn(orgId, counterpartyId, 99);

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.loyaltyAccount.update).not.toHaveBeenCalled();
    expect(prisma.loyaltyTransaction.create).not.toHaveBeenCalled();
  });

  // guards: BR-LOY-004, BR-LOY-006
  it('паралельний job: P2002 від partial-unique на insert EARN ковтається — earn завершується без помилки', async () => {
    prisma.counterparty.findFirst.mockResolvedValue({ id: counterpartyId });
    prisma.organisationSettings.findFirst.mockResolvedValue({
      loyaltyEnabled: true,
      loyaltyEarnPer: 100,
      loyaltyEarnPoints: 1,
    });
    // Read-guard нічого не побачив (переможець ще не закомітив), а insert уперся в індекс.
    prisma.loyaltyTransaction.findFirst.mockResolvedValueOnce(null);
    prisma.loyaltyTransaction.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );

    await expect(service.earn(orgId, counterpartyId, 1000, 'payment-3')).resolves.toBeUndefined();
  });

  // guards: BR-LOY-006
  it('будь-яка інша помилка транзакції (не P2002) прокидається далі — BullMQ має повторити job', async () => {
    prisma.counterparty.findFirst.mockResolvedValue({ id: counterpartyId });
    prisma.organisationSettings.findFirst.mockResolvedValue({
      loyaltyEnabled: true,
      loyaltyEarnPer: 100,
      loyaltyEarnPoints: 1,
    });
    prisma.loyaltyTransaction.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('FK failed', {
        code: 'P2003',
        clientVersion: 'test',
      }),
    );

    await expect(service.earn(orgId, counterpartyId, 1000, 'payment-4')).rejects.toMatchObject({
      code: 'P2003',
    });
  });

  // guards: BR-LOY-006
  it('P2002 БЕЗ documentId не ковтається: якоря ідемпотентності немає, це справжня помилка', async () => {
    prisma.counterparty.findFirst.mockResolvedValue({ id: counterpartyId });
    prisma.organisationSettings.findFirst.mockResolvedValue({
      loyaltyEnabled: true,
      loyaltyEarnPer: 100,
      loyaltyEarnPoints: 1,
    });
    prisma.loyaltyTransaction.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );

    await expect(service.earn(orgId, counterpartyId, 1000)).rejects.toMatchObject({
      code: 'P2002',
    });
  });

  // guards: BR-LOY-007
  it('без documentId: read-guard не виконується, нарахування завжди нове, рядок без документа', async () => {
    prisma.counterparty.findFirst.mockResolvedValue({ id: counterpartyId });
    prisma.organisationSettings.findFirst.mockResolvedValue({
      loyaltyEnabled: true,
      loyaltyEarnPer: 100,
      loyaltyEarnPoints: 1,
    });
    // Навіть якщо в леджері вже є якийсь EARN — без documentId його не можна вважати дублем.
    prisma.loyaltyTransaction.findFirst.mockResolvedValue({ id: 'some-earn' });

    await service.earn(orgId, counterpartyId, 1000);

    expect(prisma.loyaltyTransaction.findFirst).not.toHaveBeenCalled();
    expect(prisma.loyaltyAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { balance: { increment: 10 } } }),
    );
    expect(prisma.loyaltyTransaction.create).toHaveBeenCalledWith({
      data: { accountId: 'acc-1', type: 'EARN', points: 10, documentId: null, documentType: null },
    });
  });
});

describe('LoyaltyService.queueEarn', () => {
  // guards: BR-LOY-001
  it("ставить job 'earn' у чергу loyalty: attempts=10, exponential backoff 30 с, payload один-в-один", async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    const module = await Test.createTestingModule({
      providers: [
        LoyaltyService,
        { provide: PrismaService, useValue: {} },
        { provide: getQueueToken('loyalty'), useValue: { add } },
      ],
    }).compile();
    const service = module.get(LoyaltyService);

    await service.queueEarn('org-1', 'cp-1', 4150, 'pay-1');

    expect(add).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith(
      'earn',
      { orgId: 'org-1', counterpartyId: 'cp-1', paymentAmount: 4150, documentId: 'pay-1' },
      { attempts: 10, backoff: { type: 'exponential', delay: 30_000 } },
    );
  });
});
