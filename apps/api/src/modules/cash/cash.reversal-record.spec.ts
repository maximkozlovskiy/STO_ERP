/**
 * Рядок сторно в журналі каси (BR-CASH-023) — те, що пише САМ `CashService.createOperation`:
 * курс і сума в базовій валюті оригіналу (`conversion`), посилання на оригінал (`reversalOfId`) і
 * переклад порушення унікальності `reversalOfId` (друге сторно тієї самої операції) у 400.
 *
 * Що робить каса-диригент (знайти оригінал, протилежний напрям, відкат наслідків) — у
 * `../cash-registers/cash-desk.reverse.spec.ts`. Тут — лише єдиний писар рядка (BR-CASH-001).
 *
 * Написано зі специфікації ДО коду: `conversion` і `reversalOfId` у вході createOperation — з
 * контракту плану 2026-10-14 (`CreateCashOperationInput`).
 */
import { describe, it, expect } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ORG, REG, USER, opRow, setup } from './cash.spec-fixture';

const ORIGINAL = 'c4000001-0000-4000-8000-000000000001';

/** Порушення унікального індексу `cash_operations.reversalOfId` — так його віддає Prisma. */
const p2002OnReversal = () =>
  new Prisma.PrismaClientKnownRequestError(
    'Unique constraint failed on the fields: (`reversalOfId`)',
    {
      code: 'P2002',
      clientVersion: 'test',
      meta: { modelName: 'CashOperation', target: ['reversalOfId'] },
    },
  );

/** Вхід рядка сторно: протилежний напрям, той самий привід, курс оригіналу. */
const reversalInput = (over: Record<string, unknown> = {}) => ({
  cashRegisterId: REG,
  direction: 'OUT' as const,
  amount: 1250.75,
  reason: 'MANUAL_IN' as const,
  notes: 'помилково внесено двічі',
  createdBy: USER,
  reversalOfId: ORIGINAL,
  conversion: { rateUsed: 41.47, amountBase: 51868.6 },
  ...over,
});

describe('CashService.createOperation — рядок сторно', () => {
  // Сторно повертає РІВНО ту базову суму, яку записав оригінал. Курс на сьогодні дав би іншу
  // базову суму, і звіти в гривні після «операція + сторно» не вийшли б у нуль.
  // guards: BR-CASH-023
  it('conversion передано → у рядок ідуть курс і сума в базовій валюті ОРИГІНАЛУ, а не курс на сьогодні', async () => {
    const { m, service } = setup();
    // Курс «на сьогодні» навмисно інший — щоб було видно, звідки взято числа.
    m.exchangeRates.resolveBaseConversion.mockResolvedValue({
      rateUsed: 43.9,
      amountBase: 54907.93,
    });
    await service.createOperation(ORG, reversalInput() as never);
    const data = m.prisma.cashOperation.create.mock.calls[0][0].data;
    expect(Number(data.rateUsed)).toBe(41.47);
    expect(Number(data.amountBase)).toBe(51868.6);
    expect(Number(data.amount)).toBe(1250.75);
  });

  // guards: BR-CASH-023
  it('базова валюта: conversion { 1, сума } пишеться як є (копійки не губляться)', async () => {
    const { m, service } = setup();
    await service.createOperation(
      ORG,
      reversalInput({ amount: 0.01, conversion: { rateUsed: 1, amountBase: 0.01 } }) as never,
    );
    const data = m.prisma.cashOperation.create.mock.calls[0][0].data;
    expect(Number(data.amount)).toBe(0.01);
    expect(Number(data.amountBase)).toBe(0.01);
    expect(Number(data.rateUsed)).toBe(1);
  });

  // guards: BR-CASH-023
  it('reversalOfId і причина-примітка пишуться в рядок; напрям і привід — як передані', async () => {
    const { m, service } = setup();
    await service.createOperation(ORG, reversalInput() as never);
    expect(m.prisma.cashOperation.create.mock.calls[0][0].data).toMatchObject({
      orgId: ORG,
      cashRegisterId: REG,
      direction: 'OUT',
      reason: 'MANUAL_IN',
      reversalOfId: ORIGINAL,
      notes: 'помилково внесено двічі',
      createdBy: USER,
    });
  });

  // guards: BR-CASH-023
  it('без conversion — як раніше: курс на дату операції з ExchangeRatesService', async () => {
    const { m, service } = setup();
    m.exchangeRates.resolveBaseConversion.mockResolvedValue({ rateUsed: 43.9, amountBase: 4390 });
    await service.createOperation(ORG, {
      cashRegisterId: REG,
      direction: 'IN',
      amount: 100,
      reason: 'MANUAL_IN',
    });
    const data = m.prisma.cashOperation.create.mock.calls[0][0].data;
    expect(Number(data.rateUsed)).toBe(43.9);
    expect(Number(data.amountBase)).toBe(4390);
    expect(data.reversalOfId ?? null).toBeNull();
  });

  // Дві одночасні спроби сторнувати ту саму операцію: обидві не бачать сторно при перевірці,
  // другу зупиняє унікальний індекс. Користувач мусить отримати зрозумілу 400, а не 500.
  // guards: BR-CASH-023
  it('P2002 на reversalOfId (друге сторно тієї самої операції) → 400 «Операцію вже сторновано»', async () => {
    const { m, service } = setup();
    m.prisma.cashOperation.create.mockRejectedValueOnce(p2002OnReversal());
    const call = service.createOperation(ORG, reversalInput() as never);
    await expect(call).rejects.toThrow(BadRequestException);
    await expect(call).rejects.toThrow(/вже сторновано/);
  });

  // Каса-диригент кличе createOperation зі СВОЄЮ транзакцією — переклад P2002 мусить працювати й
  // на цьому шляху, а не лише коли createOperation відкриває транзакцію сам.
  // guards: BR-CASH-023
  it('P2002 на reversalOfId із зовнішнім tx → та сама 400', async () => {
    const { service } = setup();
    const outer = setup().m.prisma;
    outer.cashOperation.create.mockReset().mockRejectedValueOnce(p2002OnReversal());
    const call = service.createOperation(ORG, reversalInput() as never, outer as never);
    await expect(call).rejects.toThrow(BadRequestException);
    await expect(call).rejects.toThrow(/вже сторновано/);
  });

  // guards: BR-CASH-023
  it('звичайна операція (без reversalOfId) — інша помилка БД не маскується під «вже сторновано»', async () => {
    const { m, service } = setup();
    const boom = new Error('connection lost');
    m.prisma.cashOperation.create.mockRejectedValueOnce(boom);
    m.prisma.cashOperation.create.mockResolvedValue(opRow());
    await expect(
      service.createOperation(ORG, {
        cashRegisterId: REG,
        direction: 'IN',
        amount: 100,
        reason: 'MANUAL_IN',
      }),
    ).rejects.toBe(boom);
  });
});
