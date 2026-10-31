import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { SettingsService } from './settings.service';
import { PrismaService } from '../../prisma/prisma.service';
import { REDIS_CLIENT } from '../../redis/redis.module';
import { NbuFetchScheduler } from '../exchange-rates/nbu-fetch.scheduler';
import { BankStatementPullScheduler } from '../bank-statements/bank-statement-pull.scheduler';
import { AuditService } from '../audit/audit.service';
import { HOST_LOOKUP } from '../../common/utils/host-lookup.token';
import { publicHostLookup } from '../../common/testing/host-lookup';

/**
 * BR-INV-027 (рішення власника 2026-10-31): число ставки ПДВ, уже застосованої в документах
 * організації, не змінюється — наряди, пораховані за 20 %, після «20 → 7» лишались без рахунку
 * (BR-INV-002 бере лише ставки довідника). Назву й активність міняти можна. Сам SQL «де ставка
 * застосована» тут замокано — його на живій БД проходить E2E `ndi.spec.ts`.
 */
const ORG = 'org-1';

describe('SettingsService — ставка ПДВ, застосована в документах (BR-INV-027)', () => {
  let service: SettingsService;
  let prisma: {
    taxRate: {
      findMany: ReturnType<typeof vi.fn>;
      findFirst: ReturnType<typeof vi.fn>;
      findFirstOrThrow: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
    };
    $queryRaw: ReturnType<typeof vi.fn>;
    $transaction: ReturnType<typeof vi.fn>;
  };
  /** Ставки, які «застосовано» в документах — те, що повернув би SQL. */
  let used: number[];

  beforeEach(async () => {
    used = [];
    prisma = {
      taxRate: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'tax-20', name: 'ПДВ 20%', rate: 20, isDefault: true, isActive: true },
          { id: 'tax-7', name: 'ПДВ 7%', rate: 7, isDefault: false, isActive: true },
        ]),
        findFirst: vi.fn().mockResolvedValue({ rate: 20 }),
        findFirstOrThrow: vi.fn().mockResolvedValue({
          id: 'tax-20',
          name: 'ПДВ 20%',
          rate: 20,
          isDefault: true,
          isActive: true,
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      $queryRaw: vi.fn((_sql: TemplateStringsArray, rates: number[]) =>
        Promise.resolve(rates.filter(r => used.includes(r)).map(rate => ({ rate }))),
      ),
      $transaction: vi.fn(),
    };
    const module = await Test.createTestingModule({
      providers: [
        SettingsService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: { record: vi.fn().mockResolvedValue(undefined) } },
        {
          provide: REDIS_CLIENT,
          useValue: { get: vi.fn(), set: vi.fn(), del: vi.fn().mockResolvedValue(1) },
        },
        { provide: NbuFetchScheduler, useValue: {} },
        { provide: BankStatementPullScheduler, useValue: {} },
        { provide: HOST_LOOKUP, useValue: publicHostLookup },
      ],
    }).compile();
    service = module.get(SettingsService);
  });

  // guards: BR-INV-027
  it('застосовану ставку 20 → 7 не змінити: 400 з порадою, запису немає', async () => {
    used = [20];

    const err = await service.updateTaxRate(ORG, 'tax-20', { rate: 7 }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).message).toBe(
      'Ставку 20 % уже застосовано в документах — її число не змінюється. Додайте нову ставку, а цю вимкніть',
    );
    expect(prisma.taxRate.updateMany).not.toHaveBeenCalled();
    expect(prisma.taxRate.findFirst).toHaveBeenCalledWith({
      where: { id: 'tax-20', orgId: ORG },
      select: { rate: true },
    });
  });

  // guards: BR-INV-027
  it('незастосовану ставку змінити можна', async () => {
    await service.updateTaxRate(ORG, 'tax-20', { rate: 7 });

    expect(prisma.taxRate.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'tax-20', orgId: ORG },
        data: expect.objectContaining({ rate: 7 }),
      }),
    );
  });

  // guards: BR-INV-027
  it('назву й активність застосованої ставки змінити можна; те саме число ставки — не зміна', async () => {
    used = [20];

    await service.updateTaxRate(ORG, 'tax-20', { name: 'ПДВ основна', isActive: false });
    await service.updateTaxRate(ORG, 'tax-20', { name: 'ПДВ основна', rate: 20 });

    expect(prisma.taxRate.updateMany).toHaveBeenCalledTimes(2);
    // Без зміни числа сервер не питає, де ставку застосовано.
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('ставки іншої організації (або неіснуючої) → 404, запису немає', async () => {
    prisma.taxRate.findFirst.mockResolvedValueOnce(null);

    await expect(service.updateTaxRate(ORG, 'tax-x', { rate: 7 })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.taxRate.updateMany).not.toHaveBeenCalled();
  });

  // guards: BR-INV-027
  it('список ставок для НДІ позначає застосовані (inUse) — одним запитом на всі ставки', async () => {
    used = [20];

    const rates = await service.getTaxRatesWithUsage(ORG);

    expect(rates.map(r => [r.rate, r.inUse])).toEqual([
      [20, true],
      [7, false],
    ]);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  // guards: BR-INV-027
  it('застосованою вважається ставка рядків рахунків, рядків замовлень і нарахованих нарядів', async () => {
    await service.getTaxRatesWithUsage(ORG);

    const sql = (prisma.$queryRaw.mock.calls[0]?.[0] as TemplateStringsArray).join('?');
    expect(sql).toContain('invoice_lines');
    expect(sql).toContain('purchase_order_lines');
    expect(sql).toContain('work_orders');
    // Чернетки нарядів перераховуються на завершенні (BR-WO-008) — ставку «не тримають».
    expect(sql).toContain(`IN ('COMPLETED', 'INVOICED', 'PAID', 'ARCHIVED')`);
    expect(sql).toMatch(/"deletedAt" IS NULL/);
  });
});
