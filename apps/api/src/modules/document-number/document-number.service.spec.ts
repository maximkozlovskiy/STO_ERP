import { vi, describe, it, expect, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { DocumentType } from '@prisma/client';
import { DocumentNumberService } from './document-number.service';
import type { PrismaService } from '../../prisma/prisma.service';

const ORG_ID = '11111111-1111-4111-8111-111111111111';

/**
 * Regression: atomic numbering + YEARLY/MONTHLY reset correctness.
 *
 * BUG (audit offline-first infra): the YEARLY reset branch carried an extra
 * `cfg.lastResetYear !== null` guard that MONTHLY did not have. A YEARLY config
 * with `lastResetYear = NULL` (fresh seed / legacy import) and a non-zero
 * `currentSeq` would therefore NEVER reset at the year boundary — it kept
 * incrementing the previous sequence, producing wrong (out-of-period) numbers.
 * The fix drops the null-guard so NULL is treated as "needs reset", symmetric
 * with MONTHLY.
 */

type ConfigRow = {
  id: string;
  prefix: string | null;
  includeDate: boolean;
  separator: string;
  padding: number;
  currentSeq: bigint;
  resetPeriod: string;
  lastResetYear: number | null;
  lastResetMonth: number | null;
  updatedAt: Date;
};

function kyivYear(): number {
  return Number(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Kyiv',
      year: 'numeric',
    }).format(new Date()),
  );
}

/**
 * Build a PrismaService mock whose `$transaction(cb)` runs the callback with a
 * `tx` that returns `configRow` from `$queryRaw` and records the UPDATE params.
 */
function makePrisma(configRow: ConfigRow | null) {
  const executed: { newSeq: bigint; year: number; month: number }[] = [];
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue(configRow ? [configRow] : []),
    // Prisma tagged-template: strings + interpolated values. The service passes
    // `${newSeq}, ${currentYear}, ${currentMonth}` as the first three values.
    $executeRaw: vi
      .fn()
      .mockImplementation((_strings: TemplateStringsArray, ...values: unknown[]) => {
        executed.push({
          newSeq: values[0] as bigint,
          year: values[1] as number,
          month: values[2] as number,
        });
        return Promise.resolve(1);
      }),
  };
  const prisma = {
    $transaction: vi.fn().mockImplementation((cb: (t: typeof tx) => unknown) => cb(tx)),
  } as unknown as PrismaService;
  return { prisma, tx, executed };
}

const baseConfig = (over: Partial<ConfigRow>): ConfigRow => ({
  id: '22222222-2222-4222-8222-222222222222',
  prefix: 'НРД',
  includeDate: false,
  separator: '-',
  padding: 6,
  currentSeq: 0n,
  resetPeriod: 'NEVER',
  lastResetYear: null,
  lastResetMonth: null,
  updatedAt: new Date(),
  ...over,
});

describe('DocumentNumberService.next', () => {
  let service: DocumentNumberService;

  const build = (row: ConfigRow | null) => {
    const { prisma, executed } = makePrisma(row);
    service = new DocumentNumberService(prisma);
    return { executed };
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('кидає NotFound коли конфіг нумерації відсутній', async () => {
    build(null);
    await expect(service.next(ORG_ID, DocumentType.WORK_ORDER)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  // Номер у транзакції виклику: її відкат повертає номер (оплата постачальнику однією дією). Без
  // `tx` — своя коротка транзакція, як було для всіх документів.
  // guards: BR-SUPPAY-013
  it('з tx — лічильник читається й пишеться ЦІЄЮ транзакцією, власної не відкриває', async () => {
    const { prisma, tx, executed } = makePrisma(baseConfig({ currentSeq: 7n }));
    service = new DocumentNumberService(prisma);
    const own = vi.mocked(prisma.$transaction);
    own.mockClear();

    const num = await service.next(ORG_ID, DocumentType.SUPPLIER_PAYMENT, tx as never);

    expect(num).toBe('НРД-000008');
    expect(own).not.toHaveBeenCalled();
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(executed[0].newSeq).toBe(8n);
  });

  // guards: BR-SUPPAY-013
  it('без tx — власна транзакція з таймаутом (решта документів — як було)', async () => {
    const { prisma } = makePrisma(baseConfig({ currentSeq: 1n }));
    service = new DocumentNumberService(prisma);

    await service.next(ORG_ID, DocumentType.WORK_ORDER);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(vi.mocked(prisma.$transaction).mock.calls[0][1]).toMatchObject({
      timeout: expect.any(Number),
    });
  });

  it('NEVER: просто інкрементує currentSeq (+1) з паддингом', async () => {
    const { executed } = build(baseConfig({ resetPeriod: 'NEVER', currentSeq: 41n }));
    const num = await service.next(ORG_ID, DocumentType.WORK_ORDER);
    expect(executed[0].newSeq).toBe(42n);
    expect(num).toBe('НРД-000042');
  });

  it('YEARLY + lastResetYear=NULL + currentSeq>0 → СКИДАЄ до 1 (регресія null-guard)', async () => {
    // This is the bug: before the fix, `lastResetYear !== null` short-circuited
    // the reset and produced currentSeq+1 (=124) instead of 1.
    const { executed } = build(
      baseConfig({ resetPeriod: 'YEARLY', currentSeq: 123n, lastResetYear: null }),
    );
    const num = await service.next(ORG_ID, DocumentType.WORK_ORDER);
    expect(executed[0].newSeq).toBe(1n);
    expect(executed[0].year).toBe(kyivYear());
    expect(num).toBe('НРД-000001');
  });

  it('YEARLY + lastResetYear=минулий рік → скидає до 1', async () => {
    const { executed } = build(
      baseConfig({ resetPeriod: 'YEARLY', currentSeq: 500n, lastResetYear: kyivYear() - 1 }),
    );
    await service.next(ORG_ID, DocumentType.WORK_ORDER);
    expect(executed[0].newSeq).toBe(1n);
  });

  it('YEARLY + lastResetYear=поточний рік → інкрементує (не скидає)', async () => {
    const { executed } = build(
      baseConfig({ resetPeriod: 'YEARLY', currentSeq: 7n, lastResetYear: kyivYear() }),
    );
    await service.next(ORG_ID, DocumentType.WORK_ORDER);
    expect(executed[0].newSeq).toBe(8n);
  });

  it('MONTHLY + lastResetYear=NULL → скидає до 1 (симетрія з YEARLY)', async () => {
    const { executed } = build(
      baseConfig({
        resetPeriod: 'MONTHLY',
        currentSeq: 88n,
        lastResetYear: null,
        lastResetMonth: null,
      }),
    );
    await service.next(ORG_ID, DocumentType.WORK_ORDER);
    expect(executed[0].newSeq).toBe(1n);
  });

  it('includeDate=true → формат PREFIX-YYYY-SEQ', async () => {
    build(
      baseConfig({
        resetPeriod: 'YEARLY',
        includeDate: true,
        currentSeq: 4n,
        lastResetYear: kyivYear(),
        prefix: 'НРД',
      }),
    );
    const num = await service.next(ORG_ID, DocumentType.WORK_ORDER);
    expect(num).toBe(`НРД-${kyivYear()}-000005`);
  });
});
