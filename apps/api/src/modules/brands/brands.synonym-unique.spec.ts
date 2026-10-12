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
 *  · прибрати його з `restore` → кейс «назву зайняли синонімом, поки бренд був видалений» падає;
 *  · прибрати `NOT: { brandId }` → кейс «власний синонім не конфліктує сам із собою» падає;
 *  · `mode: 'insensitive'` → точний збіг → кейс про регістр падає;
 *  · символи шаблону стережуть два шари — екранування `_`/`%` в `insensitive()` і рішення за
 *    `synonymKey`; кейс падає, коли прибрано ОБИДВА (саме екранування окремо ловить кейс
 *    `resolveByNameOrSynonym` у `brands.service.spec.ts`);
 *  · прибрати `brand: { deletedAt: null }` → кейс про видалений бренд падає;
 *  · повернути `new Set(raw.map(trim))` у cleanSynonyms → кейси про повтори й власну назву падають;
 *  · прибрати `pg_advisory_xact_lock` → кейс про блокування падає;
 *  · повернути вкладений `createMany` у `create` або прибрати гілку `brand: { deletedAt }` у
 *    `syncSynonyms` → кейси «вільний рядок переїжджає до нового бренду» падають.
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

const escapeRe = (ch: string): string => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Postgres ILIKE: `%` — будь-який рядок, `_` — один символ, `\x` — буквальний x. */
const ilike = (value: string, pattern: string): boolean => {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '\\' && i + 1 < pattern.length) re += escapeRe(pattern[++i]!);
    else if (ch === '%') re += '.*';
    else if (ch === '_') re += '.';
    else re += escapeRe(ch);
  }
  return new RegExp(`^${re}$`, 'iu').test(value);
};

/** Prisma `equals` + `insensitive` іде в базу як ILIKE без екранування — підробка поводиться так само. */
const eq = (a: string, cond: unknown): boolean => {
  const c = cond as { equals: string; mode?: string };
  return c.mode === 'insensitive' ? ilike(a, c.equals) : a === c.equals;
};

/** Підробка Prisma, що ВИКОНУЄ умови `where` над даними — забутий фільтр змінює результат. */
function makeWorld(brands: BrandRow[], synonyms: SynRow[]) {
  const writes: string[] = [];
  const order: string[] = [];
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
    const not = where.NOT as { id?: string; deletedAt?: null } | undefined;
    if (not?.id && not.id === r.id) return false;
    if (not && 'deletedAt' in not && !r.deleted) return false;
    if (typeof where.name === 'string' && where.name !== r.name) return false;
    const or = where.OR as Array<{ name: unknown }> | undefined;
    if (or && !or.some(c => eq(r.name, c.name))) return false;
    return true;
  };
  /** Запит `syncSynonyms` по «вільних» рядках: знятий синонім або синонім видаленого бренду. */
  const freeRows = (where: Where): Array<{ id: string; synonym: string }> => {
    const wanted = (where.synonym as { in: string[] }).in;
    const or = (where.OR ?? []) as Array<Record<string, unknown>>;
    const seesTombstones = or.some(c => 'deletedAt' in c);
    const seesDeletedBrands = or.some(c => 'brand' in c);
    return synonyms
      .filter(r => r.orgId === where.orgId && wanted.includes(r.synonym))
      .filter(r => (seesTombstones && r.deleted) || (seesDeletedBrands && r.brandDeleted))
      .map(r => ({ id: r.synonym, synonym: r.synonym }));
  };
  const prisma = {
    $transaction: vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
    $executeRaw: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      order.push(`lock:${strings.join('?')}:${values.join(',')}`);
      return Promise.resolve(1);
    }),
    brand: {
      findFirst: vi.fn(({ where }: { where: Where }) => {
        order.push('read');
        return Promise.resolve(brands.find(b => brandMatches(b, where)) ?? null);
      }),
      findMany: vi.fn(({ where }: { where: Where }) => {
        order.push('read');
        return Promise.resolve(brands.filter(b => brandMatches(b, where)));
      }),
      findFirstOrThrow: vi.fn(({ where }: { where: Where }) => {
        const b = brands.find(x => x.id === where.id);
        return Promise.resolve({
          id: where.id,
          orgId: ORG,
          name: b?.name ?? 'new',
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
      updateMany: vi.fn(() => {
        writes.push('brand.updateMany');
        return Promise.resolve({ count: 1 });
      }),
      create: vi.fn(() => {
        writes.push('brand.create');
        return Promise.resolve({ id: 'new' });
      }),
    },
    brandSynonym: {
      findMany: vi.fn(({ where }: { where: Where }) => {
        order.push('read');
        // Запити syncSynonyms: активні рядки цього бренду (порожньо) і вільні рядки організації.
        if (typeof where.brandId === 'string') return Promise.resolve([]);
        if ((where.synonym as { in?: string[] } | undefined)?.in)
          return Promise.resolve(freeRows(where));
        return Promise.resolve(
          synonyms
            .filter(s => synMatches(s, where))
            .map(r => ({ synonym: r.synonym, brand: { name: r.brandName } })),
        );
      }),
      updateMany: vi.fn(({ where, data }: { where: { id?: unknown }; data: Where }) => {
        writes.push(
          data.brandId
            ? `synonym.rebind:${String(where.id)}→${String(data.brandId)}`
            : 'synonym.updateMany',
        );
        return Promise.resolve({ count: 1 });
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
  return { service, prisma, writes, order };
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
  { orgId: ORG, brandId: 'b-bosch', brandName: 'Bosch', synonym: 'aXc' },
  { orgId: ORG, brandId: 'b-bosch', brandName: 'Bosch', synonym: 'q_r' },
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

    it('«_» і «%» у синонімі — звичайні символи, а не шаблон: «a_c» не дубль чужого «aXc»', async () => {
      await expect(
        w.service.update(ORG, BRAND_A, { name: 'ASAM', synonyms: ['a_c', '%', 'б%'] }),
      ).resolves.toBeTruthy();
      expect(w.writes).toContain('synonym.createMany:a_c,%,б%');
    });

    it('синонім із «_» усе ще впізнається як дубль такого самого чужого («Q_R» проти «q_r»)', async () => {
      await expect(
        w.service.update(ORG, BRAND_A, { name: 'ASAM', synonyms: ['Q_R'] }),
      ).rejects.toThrow('Синонім «q_r» уже належить бренду «Bosch»');
      expect(w.writes).toEqual([]);
    });

    it('перевірка і запис ідуть однією транзакцією під блокуванням організації', async () => {
      await w.service.update(ORG, BRAND_A, { name: 'ASAM', synonyms: ['новий'] });
      expect(w.prisma.$transaction).toHaveBeenCalledTimes(1);
      // Блокування береться ДО першого читання: інакше два збереження обидва пройдуть перевірку.
      expect(w.order[0]).toBe(`lock:SELECT pg_advisory_xact_lock(hashtext(?)):brands:${ORG}`);
      expect(w.order.filter(o => o.startsWith('lock'))).toHaveLength(1);
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
      expect(w.writes).toEqual(['brand.create', 'synonym.createMany:вільний']);
    });

    // Унікальний слот `(orgId, synonym)` зайнятий і знятим рядком, і рядком видаленого бренду.
    // Вкладений `createMany skipDuplicates` мовчки пропускав таке написання: бренд створювався
    // «успішно», але без синоніма — той самий симптом, заради якого з'явилось правило.
    it.each([
      ['знятий синонім іншого бренду', 'знятий'],
      ['синонім видаленого бренду', 'старий'],
    ])('%s переїжджає до нового бренду, а не губиться мовчки', async (_name, synonym) => {
      await w.service.create(ORG, { name: 'Новий', synonyms: [synonym] });
      expect(w.writes).toEqual(['brand.create', `synonym.rebind:${synonym}→new`]);
    });
  });

  describe('restore', () => {
    it('назву зайняли синонімом, поки бренд був видалений → 409, бренд не відновлюється', async () => {
      const world = makeWorld(BRANDS, [
        ...SYNONYMS,
        { orgId: ORG, brandId: 'b-bosch', brandName: 'Bosch', synonym: 'oldbrand' },
      ]);
      await expect(world.service.restore(ORG, 'b-old')).rejects.toThrow(
        'Назва «OldBrand» уже є синонімом бренду «Bosch»',
      );
      expect(world.writes).toEqual([]);
    });

    it('назва вільна → бренд відновлюється', async () => {
      await expect(w.service.restore(ORG, 'b-old')).resolves.toBeTruthy();
      expect(w.writes).toEqual(['brand.updateMany']);
    });
  });
});
