/**
 * BR-GOOD-007, блок 4 (рішення власника 2026-10-30):
 *  · №10 — відновлення бренду повертає синоніми, зняті РАЗОМ із ним (той самий момент
 *    видалення), якщо написання вільне; зайняті пропускаються й перелічуються у відповіді;
 *    зняті окремо раніше — не повертаються;
 *  · №11 — назва бренду унікальна без урахування регістру серед активних: create / update /
 *    restore → 409 з назвою наявного; create з назвою видаленого (будь-який регістр) — воскресіння.
 *
 * Підробка Prisma ВИКОНУЄ `where` (рівність, `insensitive`, `in`, `not`, `gte`/`lte`, `NOT`, `OR`,
 * `AND`, зв'язок `brand`) і пише в пам'ять; тримає обидва унікальні індекси синонімів —
 * `(orgId, synonym)` і `(orgId, lower(synonym)) WHERE deletedAt IS NULL` — і новий індекс назви
 * `(orgId, lower(name)) WHERE deletedAt IS NULL`: забута перевірка дає не «тихий успіх», а P2002.
 *
 * Mutation-verify (2026-11-14):
 *  · прибрати нижню межу `gte: deleted.deletedAt` → «знятий окремо раніше — не повертається» падає;
 *  · `free = candidates` (без фільтра зайнятих) → «зайнятий синонім пропускається» падає (P2002);
 *  · `findActiveNamesake` з точною назвою замість `insensitive` → кейси «bosch» при «Bosch» падають;
 *  · `remove()` з двома `new Date()` → «один момент видалення» падає.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { BrandNameExistsException, BrandsService } from './brands.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { CacheService } from '../../redis/cache.service';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '99999999-9999-4999-8999-999999999999';
const T0 = new Date('2026-11-01T10:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;
interface BrandRow extends Row {
  id: string;
  orgId: string;
  name: string;
  deletedAt: Date | null;
}
interface SynRow extends Row {
  id: string;
  orgId: string;
  brandId: string;
  synonym: string;
  normalizedSynonym?: string | null;
  deletedAt: Date | null;
}
interface NewSynonym {
  orgId: string;
  brandId: string;
  synonym: string;
  normalizedSynonym?: string | null;
}

const escapeRe = (ch: string): string => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Postgres ILIKE: `%`, `_` — шаблон, `\x` — буквальний x. */
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
const lower = (s: string) => s.toLocaleLowerCase('uk');

function matchValue(v: unknown, cond: unknown): boolean {
  if (cond === null) return v === null || v === undefined;
  if (cond instanceof Date) return v instanceof Date && v.getTime() === cond.getTime();
  if (typeof cond !== 'object') return v === cond;
  const c = cond as Row;
  if ('equals' in c)
    return c.mode === 'insensitive' ? ilike(String(v), String(c.equals)) : v === c.equals;
  if ('in' in c) return (c.in as unknown[]).includes(v);
  if ('not' in c) return c.not === null ? v !== null && v !== undefined : !matchValue(v, c.not);
  if ('gte' in c || 'lte' in c) {
    if (!(v instanceof Date)) return false;
    if (c.gte instanceof Date && v.getTime() < c.gte.getTime()) return false;
    if (c.lte instanceof Date && v.getTime() > c.lte.getTime()) return false;
    return true;
  }
  throw new Error(`підробка не знає умови ${JSON.stringify(c)}`);
}

function makeWorld(brands: BrandRow[], synonyms: SynRow[]) {
  const writes: string[] = [];
  const brandOf = (s: SynRow) => brands.find(b => b.id === s.brandId) ?? null;

  const matchWhere = (row: Row, where: Where, kind: 'brand' | 'synonym'): boolean => {
    for (const [key, cond] of Object.entries(where)) {
      if (key === 'AND') {
        if (!(cond as Where[]).every(w => matchWhere(row, w, kind))) return false;
      } else if (key === 'OR') {
        if (!(cond as Where[]).some(w => matchWhere(row, w, kind))) return false;
      } else if (key === 'NOT') {
        if (matchWhere(row, cond as Where, kind)) return false;
      } else if (key === 'brand' && kind === 'synonym') {
        const b = brandOf(row as SynRow);
        if (!b || !matchWhere(b, cond as Where, 'brand')) return false;
      } else if (!matchValue(row[key], cond)) return false;
    }
    return true;
  };

  /** Унікальні індекси бази — порушення кидає, як P2002. */
  const assertIndexes = () => {
    const active = synonyms.filter(s => s.deletedAt === null);
    for (const s of active) {
      if (active.some(o => o !== s && o.orgId === s.orgId && lower(o.synonym) === lower(s.synonym)))
        throw new Error(`P2002 lower(synonym): ${s.synonym}`);
    }
    for (const s of synonyms) {
      if (synonyms.some(o => o !== s && o.orgId === s.orgId && o.synonym === s.synonym))
        throw new Error(`P2002 (orgId, synonym): ${s.synonym}`);
    }
    const liveBrands = brands.filter(b => b.deletedAt === null);
    for (const b of liveBrands) {
      if (liveBrands.some(o => o !== b && o.orgId === b.orgId && lower(o.name) === lower(b.name)))
        throw new Error(`P2002 lower(name): ${b.name}`);
    }
    for (const b of brands) {
      if (brands.some(o => o !== b && o.orgId === b.orgId && o.name === b.name))
        throw new Error(`P2002 (orgId, name): ${b.name}`);
    }
  };

  const withSynonyms = (b: BrandRow, args: { select?: Row; include?: Row }) => {
    const rel = (args.select?.synonyms ?? args.include?.synonyms) as { where?: Where } | undefined;
    if (!rel) return { ...b };
    return {
      ...b,
      synonyms: synonyms
        .filter(s => s.brandId === b.id && matchWhere(s, rel.where ?? {}, 'synonym'))
        .map(s => ({ synonym: s.synonym })),
    };
  };
  const synView = (s: SynRow) => ({ ...s, brand: { name: brandOf(s)?.name ?? '?' } });
  const apply = <T extends Row>(row: T, data: Row) => {
    for (const [k, v] of Object.entries(data)) if (v !== undefined) row[k as keyof T] = v as never;
  };

  const prisma = {
    $transaction: vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
    $executeRaw: vi.fn(() => Promise.resolve(1)),
    brand: {
      findFirst: vi.fn((args: { where: Where; select?: Row; include?: Row }) => {
        const b = brands.find(x => matchWhere(x, args.where, 'brand'));
        return Promise.resolve(b ? withSynonyms(b, args) : null);
      }),
      findFirstOrThrow: vi.fn((args: { where: Where; include?: Row }) => {
        const b = brands.find(x => matchWhere(x, args.where, 'brand'));
        if (!b) throw new Error('not found');
        return Promise.resolve({ ...withSynonyms(b, args), createdAt: T0, updatedAt: T0 });
      }),
      findMany: vi.fn((args: { where: Where; take?: number }) =>
        Promise.resolve(
          brands
            .filter(x => matchWhere(x, args.where, 'brand'))
            .slice(0, args.take)
            .map(b => ({ ...b })),
        ),
      ),
      updateMany: vi.fn(({ where, data }: { where: Where; data: Row }) => {
        const hit = brands.filter(x => matchWhere(x, where, 'brand'));
        hit.forEach(b => apply(b, data));
        assertIndexes();
        writes.push(`brand.updateMany:${hit.length}`);
        return Promise.resolve({ count: hit.length });
      }),
      update: vi.fn(({ where, data }: { where: Where; data: Row }) => {
        const b = brands.find(x => matchWhere(x, where, 'brand'));
        if (!b) throw new Error('P2025');
        apply(b, data);
        assertIndexes();
        writes.push(`brand.update:${b.id}`);
        return Promise.resolve({ ...b });
      }),
      create: vi.fn(({ data }: { data: { name: string; orgId: string } }) => {
        const b: BrandRow = { id: `new-${data.name}`, ...data, deletedAt: null };
        brands.push(b);
        assertIndexes();
        writes.push(`brand.create:${data.name}`);
        return Promise.resolve({ id: b.id });
      }),
    },
    brandSynonym: {
      findMany: vi.fn((args: { where: Where; take?: number }) =>
        Promise.resolve(
          synonyms
            .filter(s => matchWhere(s, args.where, 'synonym'))
            .slice(0, args.take)
            .map(synView),
        ),
      ),
      findFirst: vi.fn((args: { where: Where }) => {
        const s = synonyms.find(x => matchWhere(x, args.where, 'synonym'));
        return Promise.resolve(s ? synView(s) : null);
      }),
      updateMany: vi.fn(({ where, data }: { where: Where; data: Row }) => {
        const hit = synonyms.filter(x => matchWhere(x, where, 'synonym'));
        hit.forEach(s => apply(s, data));
        assertIndexes();
        writes.push(`synonym.updateMany:${hit.map(s => s.synonym).join(',')}`);
        return Promise.resolve({ count: hit.length });
      }),
      createMany: vi.fn(({ data }: { data: NewSynonym[] }) => {
        let count = 0;
        for (const d of data) {
          const clash = synonyms.some(
            s =>
              s.orgId === d.orgId &&
              (s.synonym === d.synonym ||
                (s.deletedAt === null && lower(s.synonym) === lower(d.synonym))),
          );
          if (clash) continue; // skipDuplicates
          synonyms.push({ id: `syn-${d.synonym}`, ...d, deletedAt: null });
          count++;
        }
        writes.push(`synonym.createMany:${data.map(d => d.synonym).join(',')}`);
        return Promise.resolve({ count });
      }),
    },
  };
  const cache = { get: vi.fn().mockResolvedValue(null), set: vi.fn(), del: vi.fn() };
  const service = new BrandsService(
    prisma as unknown as PrismaService,
    cache as unknown as CacheService,
  );
  const activeSynonymsOf = (brandId: string) =>
    synonyms
      .filter(s => s.brandId === brandId && s.deletedAt === null)
      .map(s => s.synonym)
      .sort();
  return { service, prisma, writes, brands, synonyms, activeSynonymsOf };
}

const brand = (id: string, name: string, deletedAt: Date | null = null, orgId = ORG): BrandRow => ({
  id,
  orgId,
  name,
  deletedAt,
});
const syn = (brandId: string, synonym: string, deletedAt: Date | null = null): SynRow => ({
  id: `s-${synonym}`,
  orgId: ORG,
  brandId,
  synonym,
  deletedAt,
});

// guards: BR-GOOD-007
describe('BrandsService.restore — синоніми, зняті разом із брендом (№10)', () => {
  it('видалити й відновити: синоніми на місці, пропущених немає', async () => {
    const w = makeWorld(
      [brand('b-mann', 'Mann')],
      [syn('b-mann', 'MANN-FILTER'), syn('b-mann', 'Ман')],
    );

    await w.service.remove(ORG, 'b-mann');
    expect(w.activeSynonymsOf('b-mann')).toEqual([]);
    const restored = await w.service.restore(ORG, 'b-mann');

    expect(w.activeSynonymsOf('b-mann')).toEqual(['MANN-FILTER', 'Ман']);
    expect(restored.synonyms.sort()).toEqual(['MANN-FILTER', 'Ман']);
    expect(restored.skippedSynonyms).toEqual([]);
  });

  it('remove(): бренд і синоніми отримують ОДИН момент видалення, в одній транзакції', async () => {
    const w = makeWorld([brand('b-mann', 'Mann')], [syn('b-mann', 'Ман')]);
    await w.service.remove(ORG, 'b-mann');

    const brandAt = w.brands[0]!.deletedAt;
    expect(brandAt).toBeInstanceOf(Date);
    expect(w.synonyms[0]!.deletedAt?.getTime()).toBe(brandAt!.getTime());
    expect(w.prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('синонім, знятий окремо РАНІШЕ за бренд, не повертається', async () => {
    const w = makeWorld(
      [brand('b-mann', 'Mann', T0)],
      [syn('b-mann', 'разом', T0), syn('b-mann', 'раніше', at(-60_000))],
    );

    const restored = await w.service.restore(ORG, 'b-mann');

    expect(w.activeSynonymsOf('b-mann')).toEqual(['разом']);
    expect(restored.skippedSynonyms).toEqual([]);
  });

  it('старе видалення (синоніми на мілісекунди пізніші за бренд) — синоніми теж повертаються', async () => {
    const w = makeWorld([brand('b-mann', 'Mann', T0)], [syn('b-mann', 'Ман', at(37))]);

    await w.service.restore(ORG, 'b-mann');

    expect(w.activeSynonymsOf('b-mann')).toEqual(['Ман']);
  });

  it('зайнятий синонімом іншого бренду (інший регістр) — пропускається й названий у відповіді', async () => {
    const w = makeWorld(
      [brand('b-mann', 'Mann', T0), brand('b-bosch', 'Bosch')],
      [syn('b-mann', 'Ман', T0), syn('b-mann', 'MF', T0), syn('b-bosch', 'mf')],
    );

    const restored = await w.service.restore(ORG, 'b-mann');

    expect(w.activeSynonymsOf('b-mann')).toEqual(['Ман']);
    expect(w.activeSynonymsOf('b-bosch')).toEqual(['mf']);
    expect(restored.skippedSynonyms).toEqual(['MF']);
    expect(w.brands.find(b => b.id === 'b-mann')!.deletedAt).toBeNull();
  });

  it('зайнятий НАЗВОЮ іншого активного бренду — пропускається', async () => {
    const w = makeWorld(
      [brand('b-mann', 'Mann', T0), brand('b-filtron', 'Filtron')],
      [syn('b-mann', 'FILTRON', T0), syn('b-mann', 'Ман', T0)],
    );

    const restored = await w.service.restore(ORG, 'b-mann');

    expect(w.activeSynonymsOf('b-mann')).toEqual(['Ман']);
    expect(restored.skippedSynonyms).toEqual(['FILTRON']);
  });

  it('написання видаленого бренду чи іншої організації вільне — синонім повертається', async () => {
    const w = makeWorld(
      [
        brand('b-mann', 'Mann', T0),
        brand('b-old', 'Old', at(-1000)),
        brand('b-x', 'Ман', null, OTHER_ORG),
      ],
      [syn('b-mann', 'mf', T0), syn('b-old', 'MF', at(-1000))],
    );

    const restored = await w.service.restore(ORG, 'b-mann');

    expect(w.activeSynonymsOf('b-mann')).toEqual(['mf']);
    expect(restored.skippedSynonyms).toEqual([]);
  });
});

// guards: BR-GOOD-007
describe('BrandsService — назва бренду унікальна без урахування регістру (№11)', () => {
  let w: ReturnType<typeof makeWorld>;
  beforeEach(() => {
    w = makeWorld(
      [
        brand('b-bosch', 'Bosch'),
        brand('b-asam', 'ASAM'),
        brand('b-foreign', 'NGK', null, OTHER_ORG),
      ],
      [],
    );
  });

  it('create «bosch» при активному «Bosch» → 409 з назвою наявного, нічого не записано', async () => {
    const act = w.service.create(ORG, { name: ' bosch ' });
    await expect(act).rejects.toThrow(BrandNameExistsException);
    await expect(act).rejects.toThrow(
      'Бренд «Bosch» уже існує — назви брендів не розрізняють великі й малі літери',
    );
    expect(w.writes).toEqual([]);
  });

  it('create з ТОЧНОЮ назвою активного → 409 з давнім текстом (теж «наявний бренд»)', async () => {
    const act = w.service.create(ORG, { name: 'Bosch' });
    await expect(act).rejects.toThrow(BrandNameExistsException);
    await expect(act).rejects.toThrow('Бренд з такою назвою вже існує');
  });

  it('create «NGK»: бренд іншої організації не заважає', async () => {
    await expect(w.service.create(ORG, { name: 'ngk' })).resolves.toMatchObject({ name: 'ngk' });
    expect(w.writes).toEqual(['brand.create:ngk']);
  });

  it('create «BOSCH» при ВИДАЛЕНОМУ «Bosch» — воскресає той самий рядок з новим написанням', async () => {
    const world = makeWorld([brand('b-bosch', 'Bosch', T0)], []);
    const created = await world.service.create(ORG, { name: 'BOSCH' });

    expect(created.id).toBe('b-bosch');
    expect(world.brands).toHaveLength(1);
    expect(world.brands[0]).toMatchObject({ name: 'BOSCH', deletedAt: null });
  });

  it('кілька видалених тезок — воскресає рядок із точним написанням (інакше P2002 на назві)', async () => {
    const world = makeWorld([brand('b-1', 'Bosch', T0), brand('b-2', 'bosch', at(5000))], []);
    const created = await world.service.create(ORG, { name: 'bosch' });

    expect(created.id).toBe('b-2');
    expect(world.brands.find(b => b.id === 'b-1')!.deletedAt).not.toBeNull();
  });

  it('update: перейменувати «ASAM» на «BOSCH» → 409 з назвою «Bosch»', async () => {
    const act = w.service.update(ORG, 'b-asam', { name: 'BOSCH' });
    await expect(act).rejects.toThrow(ConflictException);
    await expect(act).rejects.toThrow('Бренд «Bosch» уже існує');
    expect(w.writes).toEqual([]);
  });

  it('update: назва ВИДАЛЕНОГО бренду (точне написання) → 409 «відновіть його», без P2002 (Bug #1068)', async () => {
    const world = makeWorld([brand('b-live', 'Live'), brand('b-del', 'Del', T0)], []);
    const act = world.service.update(ORG, 'b-live', { name: 'Del' });
    await expect(act).rejects.toThrow(ConflictException);
    await expect(act).rejects.toThrow('Назва «Del» належить видаленому бренду');
    expect(world.writes).toEqual([]);
    // Інше написання не займає слот `@@unique([orgId, name])` — перейменування проходить.
    await expect(world.service.update(ORG, 'b-live', { name: 'DEL' })).resolves.toMatchObject({
      name: 'DEL',
    });
  });

  it('update: зміна регістру власної назви («ASAM» → «Asam») проходить', async () => {
    await expect(w.service.update(ORG, 'b-asam', { name: 'Asam' })).resolves.toMatchObject({
      name: 'Asam',
    });
  });

  it('restore «bosch», поки активний «Bosch» → 409 з назвою наявного, бренд лишається видаленим', async () => {
    const world = makeWorld([brand('b-bosch', 'Bosch'), brand('b-old', 'bosch', T0)], []);
    const act = world.service.restore(ORG, 'b-old');
    await expect(act).rejects.toThrow('Бренд «Bosch» уже існує');
    expect(world.writes).toEqual([]);
    expect(world.brands.find(b => b.id === 'b-old')!.deletedAt).toEqual(T0);
  });
});
