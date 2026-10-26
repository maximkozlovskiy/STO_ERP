import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { translateError } from '@sto/shared';
import { BankAccountsService } from './bank-accounts.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { CacheService } from '../../redis/cache.service';

// Аспект: видалення банківського рахунку — BankAccountsService.remove.
// Правило BR-BANK-043 — docs/objects/bank-statements.md (рішення власника №9, 2026-10-26).
//
// Mutation-verify:
//  · прибрати перевірку рознесених рядків у remove → «рознесений рядок рахунку → 400» і
//    «переказ на рахунок → 400» (рахунок видалено);
//  · прибрати `transferBankAccountId` з OR → кейс про переказ; прибрати `status: 'MATCHED'` /
//    `deletedAt: null` / `orgId` → кейс «шукаються лише живі MATCHED своєї організації».

const ORG = '11111111-1111-4111-8111-111111111111';
const ACC = '22222222-2222-4222-8222-222222222222';
const HAS_LINES = translateError('err.bankAccount.hasReconciledLines', 'uk');

function makeMocks() {
  return {
    prisma: {
      bankAccount: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      bankTransaction: { findFirst: vi.fn().mockResolvedValue(null) },
    },
    cache: { get: vi.fn(), set: vi.fn(), del: vi.fn().mockResolvedValue(undefined) },
  };
}

describe('BankAccountsService.remove — рахунок із рознесеними рядками виписки', () => {
  let m: ReturnType<typeof makeMocks>;
  let service: BankAccountsService;
  beforeEach(() => {
    m = makeMocks();
    service = new BankAccountsService(
      m.prisma as unknown as PrismaService,
      m.cache as unknown as CacheService,
    );
  });

  // Справжній пошук фільтрується `where`, тож підробка повертає рядок лише на відповідний OR-гілці.
  const arrangeLine = (field: 'bankAccountId' | 'transferBankAccountId') =>
    m.prisma.bankTransaction.findFirst.mockImplementation(
      ({ where }: { where: { OR: Array<Record<string, string>> } }) =>
        Promise.resolve(where.OR.some(c => c[field] === ACC) ? { id: 'bt-1' } : null),
    );

  // guards: BR-BANK-043
  it('рознесений рядок виписки цього рахунку → 400, рахунок не видалено', async () => {
    arrangeLine('bankAccountId');
    const act = service.remove(ORG, ACC);
    await expect(act).rejects.toThrow(BadRequestException);
    await expect(act).rejects.toThrow(HAS_LINES);
    expect(m.prisma.bankAccount.updateMany).not.toHaveBeenCalled();
    expect(m.cache.del).not.toHaveBeenCalled();
  });

  // guards: BR-BANK-043
  it('рядок іншого рахунку рознесено як переказ на цей → 400, рахунок не видалено', async () => {
    arrangeLine('transferBankAccountId');
    await expect(service.remove(ORG, ACC)).rejects.toThrow(HAS_LINES);
    expect(m.prisma.bankAccount.updateMany).not.toHaveBeenCalled();
  });

  // guards: BR-BANK-043
  it('шукаються лише живі MATCHED рядки своєї організації; нема таких → рахунок видалено', async () => {
    await service.remove(ORG, ACC);
    expect(m.prisma.bankTransaction.findFirst).toHaveBeenCalledWith({
      where: {
        orgId: ORG,
        status: 'MATCHED',
        deletedAt: null,
        OR: [{ bankAccountId: ACC }, { transferBankAccountId: ACC }],
      },
      select: { id: true },
    });
    const MATCHED_LINE = { status: 'MATCHED', deletedAt: null };
    expect(m.prisma.bankAccount.updateMany).toHaveBeenCalledWith({
      where: {
        id: ACC,
        orgId: ORG,
        deletedAt: null,
        bankTransactions: { none: MATCHED_LINE },
        transfersIn: { none: MATCHED_LINE },
      },
      data: { deletedAt: expect.any(Date) },
    });
    expect(m.cache.del).toHaveBeenCalledWith(`ref:bank-accounts:${ORG}`);
  });

  it('рахунку немає → 404', async () => {
    m.prisma.bankAccount.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(service.remove(ORG, ACC)).rejects.toThrow(NotFoundException);
  });

  // guards: BR-BANK-043
  // Мутація: прибрати повторну перевірку після count = 0 → 404 замість 400.
  it('рядок рознесли між перевіркою і видаленням (запис не пройшов умову) → 400, не 404', async () => {
    m.prisma.bankTransaction.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'bt-1' });
    m.prisma.bankAccount.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(service.remove(ORG, ACC)).rejects.toThrow(HAS_LINES);
    expect(m.cache.del).not.toHaveBeenCalled();
  });
});
