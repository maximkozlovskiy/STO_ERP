import { describe, it, expect, vi } from 'vitest';
import { forEachActiveOrg } from './for-each-active-org';

/**
 * Keyset-пагінація активних орг для scheduler-bootstrap. Замінює `findMany take:1000`
 * (Bug #107 — >1000 орг тихо не охоплювались). Guard: коректний cursor-advance,
 * зупинка на неповному батчі, порожній результат.
 */
describe('forEachActiveOrg — keyset-пагінація', () => {
  // Симулює organisation.findMany з keyset (orderBy id asc, skip:1 + cursor).
  function makePrisma(allIds: string[]) {
    const sorted = [...allIds].sort();
    const findMany = vi
      .fn()
      .mockImplementation(
        async (args: { take: number; cursor?: { id: string }; skip?: number }) => {
          let startIdx = 0;
          if (args.cursor) {
            const ci = sorted.indexOf(args.cursor.id);
            startIdx = ci + (args.skip ?? 0); // skip:1 → елемент ПІСЛЯ cursor
          }
          return sorted.slice(startIdx, startIdx + args.take).map(id => ({ id }));
        },
      );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { organisation: { findMany } } as any;
  }

  it('охоплює ВСІ орг через кілька батчів (>batchSize) без пропусків і дублів', async () => {
    const ids = Array.from({ length: 1250 }, (_, i) => `org-${String(i).padStart(4, '0')}`);
    const prisma = makePrisma(ids);
    const seen: string[] = [];

    const total = await forEachActiveOrg(
      prisma,
      async orgIds => {
        seen.push(...orgIds);
      },
      { batchSize: 500 },
    );

    expect(total).toBe(1250);
    // 500 + 500 + 250 = 3 сторінки (остання неповна → зупинка).
    expect(prisma.organisation.findMany).toHaveBeenCalledTimes(3);
    expect(new Set(seen).size).toBe(1250); // без дублів
    expect(seen.sort()).toEqual([...ids].sort()); // без пропусків
  });

  it('перший запит БЕЗ cursor, наступні — з cursor+skip:1', async () => {
    const ids = Array.from({ length: 900 }, (_, i) => `org-${String(i).padStart(4, '0')}`);
    const prisma = makePrisma(ids);

    await forEachActiveOrg(prisma, async () => {}, { batchSize: 500 });

    const calls = prisma.organisation.findMany.mock.calls;
    expect(calls[0][0].cursor).toBeUndefined();
    expect(calls[0][0].skip).toBeUndefined();
    expect(calls[1][0].skip).toBe(1);
    expect(calls[1][0].cursor).toEqual({ id: ids[499] });
  });

  it('рівно batchSize орг → 2 запити (другий порожній зупиняє)', async () => {
    const ids = Array.from({ length: 500 }, (_, i) => `org-${i}`);
    const prisma = makePrisma(ids);
    const total = await forEachActiveOrg(prisma, async () => {}, { batchSize: 500 });
    // Перший батч рівно 500 (===batchSize) → не зупиняємось, робимо 2-й (порожній).
    expect(total).toBe(500);
    expect(prisma.organisation.findMany).toHaveBeenCalledTimes(2);
  });

  it('порожня БД → 0 орг, callback не викликається', async () => {
    const prisma = makePrisma([]);
    const handle = vi.fn();
    const total = await forEachActiveOrg(prisma, handle, { batchSize: 500 });
    expect(total).toBe(0);
    expect(handle).not.toHaveBeenCalled();
  });

  it('фільтрує лише активні (deletedAt: null)', async () => {
    const prisma = makePrisma(['a', 'b']);
    await forEachActiveOrg(prisma, async () => {});
    expect(prisma.organisation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { deletedAt: null }, orderBy: { id: 'asc' } }),
    );
  });
});
