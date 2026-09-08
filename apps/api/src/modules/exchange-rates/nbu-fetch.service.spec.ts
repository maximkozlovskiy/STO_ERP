import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { NbuFetchService } from './nbu-fetch.service';
import { ExchangeRatesService } from './exchange-rates.service';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Регресія Bug #714 — concurrent-race класифікація помилок у fetchAndUpsertForOrg.
 * immediate-fetch (`nbu-fetch-now-<org>`) і repeatable cron (`nbu-fetch-<org>`) — окремі jobId,
 * НЕ дедупляться → можуть виконатись одночасно. `exchangeRatesService.create` = findFirst→create
 * (не атомарно): обидва читають anyExisting=null → обидва create → переможець ОК, програвший
 * дістає P2002 (@@unique orgId,currencyId,date). Це idempotent-успіх (рядок уже є), НЕ помилка —
 * не має роздувати errors. Дзеркалить наявну обробку ConflictException (sequential-existing).
 */
describe('NbuFetchService.fetchAndUpsertForOrg — error classification (Bug #714)', () => {
  let service: NbuFetchService;

  const currencyFindMany = vi.fn();
  const create = vi.fn();
  const prisma = { currency: { findMany: currencyFindMany } } as unknown as PrismaService;
  const exchangeRates = { create } as unknown as ExchangeRatesService;

  const okFetchResponse = {
    ok: true,
    status: 200,
    json: async () => [{ cc: 'USD', rate: 40.5, exchangedate: '01.01.2026' }],
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okFetchResponse));
    currencyFindMany.mockResolvedValue([{ id: 'cur-usd', code: 'USD', nbuMarkupPercent: 0 }]);

    const module = await Test.createTestingModule({
      providers: [
        NbuFetchService,
        { provide: PrismaService, useValue: prisma },
        { provide: ExchangeRatesService, useValue: exchangeRates },
      ],
    }).compile();
    service = module.get(NbuFetchService);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('create успіх → fetched=1, errors=0', async () => {
    create.mockResolvedValueOnce({ id: 'rate-1' });
    const res = await service.fetchAndUpsertForOrg('org-1');
    expect(res).toEqual({ fetched: 1, errors: 0 });
  });

  it('ConflictException (sequential-existing) → трактується як успіх, errors=0', async () => {
    create.mockRejectedValueOnce(new ConflictException('Курс на цю дату вже існує'));
    const res = await service.fetchAndUpsertForOrg('org-1');
    expect(res).toEqual({ fetched: 1, errors: 0 });
  });

  // Bug #714 mutation-verified: якщо прибрати P2002-гілку, цей raw-Prisma error впав би у
  // warn-branch → return false → errors=1 (хибно). З гілкою — concurrent-write = idempotent-успіх.
  it('P2002 (concurrent-race, raw Prisma) → трактується як успіх, errors=0', async () => {
    create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '5.0.0',
      }),
    );
    const res = await service.fetchAndUpsertForOrg('org-1');
    expect(res).toEqual({ fetched: 1, errors: 0 });
  });

  it('інша помилка (не P2002, не Conflict) → errors=1', async () => {
    create.mockRejectedValueOnce(new Error('DB down'));
    const res = await service.fetchAndUpsertForOrg('org-1');
    expect(res).toEqual({ fetched: 0, errors: 1 });
  });
});
