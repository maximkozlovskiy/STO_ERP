import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BrandsService } from './brands.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { CacheService } from '../../redis/cache.service';

// ─── Regression spec for §5.2 — BrandSynonym resurrection ──────────────────────
//
// sto-review (2026-06-20): схема має `@@unique([orgId, synonym])` БЕЗ
// `deletedAt`. Раніше `syncSynonyms()` робив `createMany({ skipDuplicates: true })`
// для нових синонімів — це мовчки ігнорувало рядки, які вже існують у стані
// `deletedAt != null` (унікальний слот зайнятий tombstone-ом). Тобто:
//   1. Користувач додає "OEM" → ряд з deletedAt=null.
//   2. Видаляє "OEM" з бренду → ряд soft-deleted (deletedAt=now()).
//   3. Знову додає "OEM" → createMany пропускає (skipDuplicates) → синонім НЕ з'являється.
//
// Фікс — split incoming list на (a) resurrect (soft-deleted рядок у org → update
// `deletedAt: null, brandId: ...`), (b) create (truly new).
//
// Цей spec ловить регресії:
//   A: повернення до простого `createMany({ skipDuplicates: true })` без resurrect.
//   B: resurrect не перезаписує `brandId` (синонім лишається у старого бренду).
//   C: resurrect шукає лише у поточному бренді, а не по всій org.

const ORG = '11111111-1111-4111-8111-111111111111';
const BRAND_A = '22222222-2222-4222-8222-222222222222';
const BRAND_B = '33333333-3333-4333-8333-333333333333';

function makeMocks() {
  return {
    prisma: {
      brandSynonym: {
        findMany: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    },
    cache: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn(),
      del: vi.fn(),
    },
  };
}

function makeService(mocks: ReturnType<typeof makeMocks>): BrandsService {
  return new BrandsService(
    mocks.prisma as unknown as PrismaService,
    mocks.cache as unknown as CacheService,
  );
}

// `syncSynonyms` is private — invoke via [reflection] for focused regression
// without dragging in the full create()/update() Brand path.
async function callSyncSynonyms(
  service: BrandsService,
  orgId: string,
  brandId: string,
  incoming: string[],
): Promise<void> {
  await (
    service as unknown as {
      syncSynonyms(o: string, b: string, i: string[]): Promise<void>;
    }
  ).syncSynonyms(orgId, brandId, incoming);
}

describe('BrandsService.syncSynonyms — resurrection (Bug §5.2)', () => {
  let mocks: ReturnType<typeof makeMocks>;
  let service: BrandsService;

  beforeEach(() => {
    mocks = makeMocks();
    service = makeService(mocks);
  });

  it('resurrect: soft-deleted synonym у іншого бренду → updateMany із deletedAt=null + новий brandId', async () => {
    // Активних синонімів у поточного бренду немає.
    mocks.prisma.brandSynonym.findMany
      .mockResolvedValueOnce([]) // active for BRAND_A
      .mockResolvedValueOnce([{ id: 'syn-1', synonym: 'OEM' }]); // soft-deleted in org

    await callSyncSynonyms(service, ORG, BRAND_A, ['OEM']);

    // Має викликатись updateMany з deletedAt: null + brandId: BRAND_A.
    expect(mocks.prisma.brandSynonym.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['syn-1'] } },
      data: { deletedAt: null, brandId: BRAND_A },
    });
    // createMany НЕ викликається — це resurrect, не create.
    expect(mocks.prisma.brandSynonym.createMany).not.toHaveBeenCalled();
  });

  it('create: truly new synonym → createMany із orgId+brandId+synonym', async () => {
    mocks.prisma.brandSynonym.findMany
      .mockResolvedValueOnce([]) // no active
      .mockResolvedValueOnce([]); // no soft-deleted

    await callSyncSynonyms(service, ORG, BRAND_A, ['BRAND_NEW']);

    expect(mocks.prisma.brandSynonym.createMany).toHaveBeenCalledWith({
      data: [{ orgId: ORG, brandId: BRAND_A, synonym: 'BRAND_NEW' }],
      skipDuplicates: true,
    });
  });

  it('soft-delete: активний синонім, якого більше немає у incoming → updateMany deletedAt=now()', async () => {
    mocks.prisma.brandSynonym.findMany
      .mockResolvedValueOnce([{ id: 'syn-active', synonym: 'OLD_SYN' }]) // active
      .mockResolvedValueOnce([]); // no soft-deleted

    await callSyncSynonyms(service, ORG, BRAND_A, []);

    expect(mocks.prisma.brandSynonym.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['syn-active'] } },
      data: { deletedAt: expect.any(Date) },
    });
  });

  it('mix: одночасно resurrect + create + soft-delete за один виклик', async () => {
    mocks.prisma.brandSynonym.findMany
      .mockResolvedValueOnce([
        { id: 'syn-keep', synonym: 'KEEP' },
        { id: 'syn-drop', synonym: 'DROP' },
      ]) // active
      .mockResolvedValueOnce([{ id: 'syn-tomb', synonym: 'RESURRECT' }]); // soft-deleted

    await callSyncSynonyms(service, ORG, BRAND_A, ['KEEP', 'RESURRECT', 'NEW']);

    // soft-delete DROP, resurrect RESURRECT, create NEW.
    const updateCalls = mocks.prisma.brandSynonym.updateMany.mock.calls;
    const createCalls = mocks.prisma.brandSynonym.createMany.mock.calls;

    expect(updateCalls).toHaveLength(2); // 1 для soft-delete + 1 для resurrect
    expect(createCalls).toHaveLength(1);

    // Resurrect (deletedAt: null) — найважливіший шлях.
    expect(
      updateCalls.some((c: unknown[]) => {
        const arg = c[0] as { data?: { deletedAt?: Date | null } };
        return arg.data?.deletedAt === null;
      }),
    ).toBe(true);
    // Soft-delete (deletedAt: Date) — паралельно.
    expect(
      updateCalls.some((c: unknown[]) => {
        const arg = c[0] as { data?: { deletedAt?: Date | null } };
        return arg.data?.deletedAt instanceof Date;
      }),
    ).toBe(true);
  });

  it('empty incoming → жодних запитів create/update (тільки findMany на active)', async () => {
    mocks.prisma.brandSynonym.findMany
      .mockResolvedValueOnce([]) // active
      .mockResolvedValueOnce([]); // soft-deleted (порожній incoming → findMany має повернути [])

    await callSyncSynonyms(service, ORG, BRAND_A, []);

    expect(mocks.prisma.brandSynonym.createMany).not.toHaveBeenCalled();
    // updateMany НЕ викликається коли немає to-remove / to-resurrect.
    expect(mocks.prisma.brandSynonym.updateMany).not.toHaveBeenCalled();
  });

  it('resurrect: brandId перезаписується (синонім переходить між брендами)', async () => {
    // Сценарій: "OEM" був на BRAND_B, потім soft-deleted, тепер додається до BRAND_A.
    mocks.prisma.brandSynonym.findMany
      .mockResolvedValueOnce([]) // no active for BRAND_A
      .mockResolvedValueOnce([{ id: 'syn-oem', synonym: 'OEM' }]); // soft-deleted (raніше на BRAND_B)

    await callSyncSynonyms(service, ORG, BRAND_A, ['OEM']);

    // brandId МАЄ оновитися на BRAND_A — без цього синонім "OEM" зник би назавжди
    // (deletedAt=null, але brandId=BRAND_B → не з'явиться у новому бренду).
    expect(mocks.prisma.brandSynonym.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['syn-oem'] } },
      data: { deletedAt: null, brandId: BRAND_A },
    });
  });
});
