/**
 * BR-GOOD-007 — одне написання належить одному бренду (рішення власника 2026-10-12:
 * «не можуть бути дублі синоніми в різних картках»).
 *
 * До правила дубль не відхилявся, а мовчки пропускався: `createMany({ skipDuplicates })` на
 * унікальному індексі `(orgId, synonym)` — користувач бачив «збережено», а синоніма не було.
 *
 * Mutation-verify:
 *  · прибрати виклик `assertWritingsFree` з `update` → кейси update падають;
 *  · прибрати його з `create` → кейси create падають;
 *  · прибрати `NOT: { brandId }` → кейс «власний синонім не конфліктує сам із собою» падає;
 *  · `mode: 'insensitive'` → точний збіг → кейс про регістр падає;
 *  · прибрати `brand: { deletedAt: null }` → кейс про видалений бренд падає;
 *  · повернути `new Set(raw.map(trim))` у cleanSynonyms → кейси про повтори й власну назву падають.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { BrandsService } from './brands.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { CacheService } from '../../redis/cache.service';

vi.mock('../../common/tenant/tenant-context', () => ({ getLocale: () => 'uk' }));

const ORG = '11111111-1111-4111-8111-111111111111';
const BRAND_A = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-10-12T10:00:00.000Z');

type Where = Record<string, unknown>;
interface SynRow {
  orgId: string;
  brandId: string;
  brandName: string;
  synonym: string;
  deleted?: boolean;
  brandDeleted?: boolean;
}
interface BrandRow {
  id: string;
  orgId: string;
  name: string;
  deleted?: boolean;
}

const eq = (a: string, cond: unknown): boolean => {
  const c = cond as { equals: string; mode?: string };
  return c.mode === 'insensitive' ? a.toLowerCase() === c.equals.toLowerCase() : a === c.equals;
};

/** Підробка Prisma, що ВИКОНУЄ умови `where` над даними — забутий фільтр змінює результат. */
function makeWorld(brands: BrandRow[], synonyms: SynRow[]) {
  const writes: string[] = [];
  const synMatches = (r: SynRow, where: Where): boolean => {
    if (where.orgId !== r.orgId) return false;
    if (where.deletedAt === null && r.deleted) return false;
    if (where.brand && r.brandDeleted) return false;
    const not = where.NOT as { brandId?: string } | undefined;
    if (not?.brandId && not.brandId === r.brandId) return false;
    if (where.synonym && !eq(r.synonym, where.synonym)) return false;
    const or = where.OR as Array<{ synonym: unknown }> | undefined;
    if (or && !or.some(c => eq(r.synonym, c.synonym))) return false;
    return true;
  };
  const brandMatches = (r: BrandRow, where: Where): boolean => {
    if (where.orgId !== r.orgId) return false;
    if (where.deletedAt === null && r.deleted) return false;
    if (where.id && where.id !== r.id) return false;
    const not = where.NOT as { id?: string } | undefined;
    if (not?.id && not.id === r.id) return false;
    if (typeof where.name === 'string' && where.name !== r.name) return false;
    const or = where.OR as Array<{ name: unknown }> | undefined;
    if (or && !or.some(c => eq(r.name, c.name))) return false;
    return true;
  };
  const prisma = {
    brand: {
      findFirst: vi.fn(({ where }: { where: Where }) =>
        Promise.resolve(brands.find(b => brandMatches(b, where)) ?? null),
      ),
      findFirstOrThrow: vi.fn(({ where }: { where: Where }) => {
        const b = brands.find(x => x.id === where.id)!;
        return Promise.resolve({
          ...b,
          deletedAt: null,
          createdAt: NOW,
          updatedAt: NOW,
          synonyms: [],
        });
      }),
      update: vi.fn(() => {
        writes.push('brand.update');
        return Promise.resolve({});
      }),
      create: vi.fn(({ data }: { data: { name: string } }) => {
        writes.push('brand.create');
        return Promise.resolve({
          id: 'new',
          orgId: ORG,
          name: data.name,
          deletedAt: null,
          createdAt: NOW,
          updatedAt: NOW,
          synonyms: [],
        });
      }),
    },
    brandSynonym: {
      findFirst: vi.fn(({ where }: { where: Where }) => {
        const r = synonyms.find(s => synMatches(s, where));
        return Promise.resolve(r ? { synonym: r.synonym, brand: { name: r.brandName } } : null);
      }),
      findMany: vi.fn(() => Promise.resolve([])),
      updateMany: vi.fn(() => {
        writes.push('synonym.updateMany');
        return Promise.resolve({ count: 0 });
      }),
      createMany: vi.fn(({ data }: { data: Array<{ synonym: string }> }) => {
        writes.push(`synonym.createMany:${data.map(d => d.synonym).join(',')}`);
        return Promise.resolve({ count: data.length });
      }),
    },
  };
  const cache = { get: vi.fn().mockResolvedValue(null), set: vi.fn(), del: vi.fn() };
  const service = new BrandsService(
    prisma as unknown as PrismaService,
    cache as unknown as CacheService,
  );
  return { service, prisma, writes };
}

const BRANDS: BrandRow[] = [
  { id: BRAND_A, orgId: ORG, name: 'ASAM' },
  { id: 'b-bosch', orgId: ORG, name: 'Bosch' },
  { id: 'b-elring', orgId: ORG, name: 'ELRING' },
  { id: 'b-old', orgId: ORG, name: 'OldBrand', deleted: true },
  { id: 'b-foreign', orgId: 'other-org', name: 'Чужий' },
];
const SYNONYMS: SynRow[] = [
  { orgId: ORG, brandId: BRAND_A, brandName: 'ASAM', synonym: 'abas' },
  { orgId: ORG, brandId: 'b-bosch', brandName: 'Bosch', synonym: 'БОШ' },
  { orgId: ORG, brandId: 'b-bosch', brandName: 'Bosch', synonym: 'знятий', deleted: true },
  { orgId: ORG, brandId: 'b-old', brandName: 'OldBrand', synonym: 'старий', brandDeleted: true },
  { orgId: 'other-org', brandId: 'b-foreign', brandName: 'Чужий', synonym: 'чуже' },
];

// guards: BR-GOOD-007
describe('BrandsService — синонім не може належати двом брендам', () => {
  let w: ReturnType<typeof makeWorld>;
  beforeEach(() => {
    w = makeWorld(BRANDS, SYNONYMS);
  });

  describe('update', () => {
    it('синонім іншого бренду → 409 з назвами синоніма й бренду, жодного запису', async () => {
      const act = w.service.update(ORG, BRAND_A, { name: 'ASAM', synonyms: ['abas', 'БОШ'] });
      await expect(act).rejects.toThrow(ConflictException);
      await expect(act).rejects.toThrow('Синонім «БОШ» уже належить бренду «Bosch»');
      expect(w.writes).toEqual([]);
    });

    it('збіг без урахування регістру — теж дубль («бош» проти «БОШ»)', async () => {
      await expect(
        w.service.update(ORG, BRAND_A, { name: 'ASAM', synonyms: ['бош'] }),
      ).rejects.toThrow(/уже належить бренду «Bosch»/);
      expect(w.writes).toEqual([]);
    });

    it('синонім, що збігається з НАЗВОЮ іншого бренду → 409', async () => {
      await expect(
        w.service.update(ORG, BRAND_A, { name: 'ASAM', synonyms: ['elring'] }),
      ).rejects.toThrow('Синонім «elring» збігається з назвою бренду «ELRING»');
      expect(w.writes).toEqual([]);
    });

    it('нова НАЗВА бренду, що вже є синонімом іншого бренду → 409', async () => {
      await expect(w.service.update(ORG, BRAND_A, { name: 'бош', synonyms: [] })).rejects.toThrow(
        'Назва «бош» уже є синонімом бренду «Bosch»',
      );
      expect(w.writes).toEqual([]);
    });

    it('власний синонім не конфліктує сам із собою — повторне збереження проходить', async () => {
      await expect(
        w.service.update(ORG, BRAND_A, { name: 'ASAM', synonyms: ['abas', 'новий'] }),
      ).resolves.toBeTruthy();
      expect(w.writes).toContain('synonym.createMany:abas,новий');
    });

    it.each([
      ['знятий синонім іншого бренду', 'знятий'],
      ['синонім видаленого бренду', 'старий'],
      ['синонім бренду іншої організації', 'чуже'],
    ])('%s — не дубль, збереження проходить', async (_name, synonym) => {
      await expect(
        w.service.update(ORG, BRAND_A, { name: 'ASAM', synonyms: [synonym] }),
      ).resolves.toBeTruthy();
    });

    it('повтори в одному списку зводяться до першого написання; назва самого бренду не синонім', async () => {
      await w.service.update(ORG, BRAND_A, {
        name: 'ASAM',
        synonyms: [' Перший ', 'перший', 'ПЕРШИЙ', 'asam', '  ', 'другий'],
      });
      expect(w.writes).toContain('synonym.createMany:Перший,другий');
    });
  });

  describe('create', () => {
    it('синонім іншого бренду → 409, бренд не створюється', async () => {
      await expect(w.service.create(ORG, { name: 'Новий', synonyms: ['abas'] })).rejects.toThrow(
        'Синонім «abas» уже належить бренду «ASAM»',
      );
      expect(w.writes).toEqual([]);
    });

    it('назва нового бренду, що вже є чиїмось синонімом → 409', async () => {
      await expect(w.service.create(ORG, { name: 'Abas' })).rejects.toThrow(
        'Назва «Abas» уже є синонімом бренду «ASAM»',
      );
      expect(w.writes).toEqual([]);
    });

    it('вільні синоніми → бренд створюється', async () => {
      await expect(
        w.service.create(ORG, { name: 'Новий', synonyms: ['вільний'] }),
      ).resolves.toBeTruthy();
      expect(w.writes).toEqual(['brand.create']);
    });
  });
});
