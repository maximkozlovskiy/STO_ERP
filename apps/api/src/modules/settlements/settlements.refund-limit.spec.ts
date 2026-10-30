/**
 * Межа повернення (рішення власника 2026-10-30, TECH-DEBT (б) №37 і №48):
 *
 *   BR-CASH-029 / BR-BANK-044 — клієнту повертаємо не більше його переплати: `max(0, −баланс)`;
 *   BR-BANK-046               — від постачальника приймаємо не більше нашого аванса: `max(0, баланс)`.
 *
 * Баланс один на контрагента (і для «обидва» — чисте сальдо), у базовій валюті. Рядок рахунку
 * розрахунків блокується `FOR UPDATE` у транзакції викликача; рівно доступна сума проходить.
 */
import { describe, it, expect, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { translateError } from '@sto/shared';
import { SettlementsService } from './settlements.service';
import { formatMoneyForMessage } from '../../common/utils/money';
import type { PrismaService } from '../../prisma/prisma.service';
import type { ExchangeRatesService } from '../exchange-rates/exchange-rates.service';

const ORG = '11111111-1111-4111-8111-111111111111';
const CP = '22222222-2222-4222-8222-222222222222';

function makeService(balanceRows: Array<{ balance: string | number }> = []) {
  const tx = { $queryRaw: vi.fn().mockResolvedValue(balanceRows) };
  const exchangeRates = { getBaseCurrency: vi.fn().mockResolvedValue({ id: 'uah', code: 'UAH' }) };
  const service = new SettlementsService(
    {} as unknown as PrismaService,
    exchangeRates as unknown as ExchangeRatesService,
  );
  return { service, tx, exchangeRates };
}

/** Текст SQL тегованого шаблону `$queryRaw` (частини без значень) і самі значення. */
function rawQuery(tx: { $queryRaw: ReturnType<typeof vi.fn> }) {
  const [strings, ...values] = tx.$queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
  return { sql: strings.join('?').replace(/\s+/g, ' '), values };
}

describe('SettlementsService.lockRefundAvailable — доступна сума повернення', () => {
  // guards: BR-CASH-029, BR-BANK-044
  it.each([
    ['переплата клієнта 300', '-300.00', 300],
    ['клієнт винен 250 — переплати немає', '250.00', 0],
    ['сальдо нуль', '0', 0],
  ])('клієнт: %s → %d', async (_label, balance, expected) => {
    const { service, tx } = makeService([{ balance }]);
    await expect(service.lockRefundAvailable(ORG, CP, 'client', tx as never)).resolves.toBe(
      expected,
    );
  });

  // guards: BR-BANK-046
  it.each([
    ['наш аванс постачальнику 400', '400.00', 400],
    ['ми винні постачальнику 150 — аванса немає', '-150.00', 0],
  ])('постачальник: %s → %d', async (_label, balance, expected) => {
    const { service, tx } = makeService([{ balance }]);
    await expect(service.lockRefundAvailable(ORG, CP, 'supplier', tx as never)).resolves.toBe(
      expected,
    );
  });

  // guards: BR-CASH-029
  it('рахунку розрахунків ще немає → доступно 0', async () => {
    const { service, tx } = makeService([]);
    await expect(service.lockRefundAvailable(ORG, CP, 'client', tx as never)).resolves.toBe(0);
  });

  // Дві паралельні видачі на ту саму переплату: друга чекає блокування рядка й читає баланс уже з
  // першою. Запит — у транзакції викликача, з orgId (сирий SQL tenant-guard не бачить).
  // guards: BR-CASH-029, BR-BANK-044
  it('баланс читається FOR UPDATE клієнтом транзакції викликача, за orgId і контрагентом', async () => {
    const { service, tx } = makeService([{ balance: '-10' }]);

    await service.lockRefundAvailable(ORG, CP, 'client', tx as never);

    const { sql, values } = rawQuery(tx);
    expect(sql).toContain('FROM settlement_accounts');
    expect(sql).toMatch(/"orgId" = \?::uuid AND "counterpartyId" = \?::uuid FOR UPDATE/);
    expect(values).toEqual([ORG, CP]);
  });
});

describe('SettlementsService.assertRefundWithin — більше доступного → 400', () => {
  // guards: BR-CASH-029, BR-BANK-044
  it('рівно доступна сума проходить; 0,01 понад — 400 з доступною сумою в базовій валюті', async () => {
    const { service } = makeService();

    await expect(service.assertRefundWithin(ORG, 'client', 1500.49, 1500.49)).resolves.toBe(
      undefined,
    );
    const over = service.assertRefundWithin(ORG, 'client', 1500.49, 1500.5);
    await expect(over).rejects.toThrow(BadRequestException);
    await expect(over).rejects.toThrow(
      translateError('err.settlement.refundExceedsOverpayment', 'uk', {
        available: formatMoneyForMessage(1500.49, 'uk'),
        currency: 'UAH',
      }),
    );
  });

  // Сума в базовій валюті рахується множенням на курс — копійчаний дрейф Number не має відмовляти.
  // guards: BR-CASH-029
  it('дрейф обчислення в межах копійки (4150.0000001 при доступних 4150) — проходить', async () => {
    const { service } = makeService();
    await expect(service.assertRefundWithin(ORG, 'client', 4150, 4150.0000001)).resolves.toBe(
      undefined,
    );
  });

  // guards: BR-BANK-046
  it('постачальник: текст про наш аванс', async () => {
    const { service } = makeService();
    await expect(service.assertRefundWithin(ORG, 'supplier', 0, 10)).rejects.toThrow(
      translateError('err.settlement.refundExceedsAdvance', 'uk', {
        available: formatMoneyForMessage(0, 'uk'),
        currency: 'UAH',
      }),
    );
  });
});
