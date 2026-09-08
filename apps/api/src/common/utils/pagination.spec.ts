import { describe, it, expect } from 'vitest';
import { calculatePagination, MAX_PAGE_SIZE, buildSortOrderBy } from './pagination';

describe('calculatePagination', () => {
  it('page=1, limit=20 → skip=0, take=20', () => {
    expect(calculatePagination({ page: 1, limit: 20 })).toEqual({ skip: 0, take: 20 });
  });

  it('page=2, limit=20 → skip=20, take=20', () => {
    expect(calculatePagination({ page: 2, limit: 20 })).toEqual({ skip: 20, take: 20 });
  });

  it('page=3, limit=10 → skip=20, take=10', () => {
    expect(calculatePagination({ page: 3, limit: 10 })).toEqual({ skip: 20, take: 10 });
  });

  it('page=0 → skip=0 (clamp to page 1)', () => {
    expect(calculatePagination({ page: 0, limit: 20 })).toEqual({ skip: 0, take: 20 });
  });

  it('page=-1 → skip=0 (clamp to page 1)', () => {
    expect(calculatePagination({ page: -1, limit: 20 })).toEqual({ skip: 0, take: 20 });
  });

  it(`limit=999 → take=${MAX_PAGE_SIZE} (cap at MAX_PAGE_SIZE)`, () => {
    const { take } = calculatePagination({ page: 1, limit: 999 });
    expect(take).toBe(MAX_PAGE_SIZE);
  });

  it('limit=0 → take=1 (clamp to minimum)', () => {
    expect(calculatePagination({ page: 1, limit: 0 })).toEqual({ skip: 0, take: 1 });
  });

  it('limit=-5 → take=1 (clamp negative)', () => {
    expect(calculatePagination({ page: 1, limit: -5 })).toEqual({ skip: 0, take: 1 });
  });

  it('undefined page → defaults to 1', () => {
    expect(calculatePagination({ page: undefined, limit: 20 })).toEqual({ skip: 0, take: 20 });
  });

  it('undefined limit → defaults to 20', () => {
    expect(calculatePagination({ page: 1, limit: undefined })).toEqual({ skip: 0, take: 20 });
  });

  it('кастомний maxLimit використовується замість MAX_PAGE_SIZE', () => {
    const { take } = calculatePagination({ page: 1, limit: 1000, maxLimit: 500 });
    expect(take).toBe(500);
  });

  it('дробові значення floor-уються', () => {
    expect(calculatePagination({ page: 1.9, limit: 20.7 })).toEqual({ skip: 0, take: 20 });
  });

  // Регресія: контролер бере сирий @Query і робить `+page`; garbage-ввід (`?page=abc`) → NaN.
  // `??` не ловить NaN → skip/take були NaN → Prisma 500. Тепер → чистий дефолт.
  it('NaN page (garbage +"abc") → дефолт page=1, без NaN у skip', () => {
    expect(calculatePagination({ page: NaN, limit: 20 })).toEqual({ skip: 0, take: 20 });
  });

  it('NaN limit (garbage +"xyz") → дефолт take=20, без NaN', () => {
    expect(calculatePagination({ page: 1, limit: NaN })).toEqual({ skip: 0, take: 20 });
  });

  it('обидва NaN → skip=0, take=20 (жодного NaN не просочується у Prisma)', () => {
    const { skip, take } = calculatePagination({ page: NaN, limit: NaN, maxLimit: 200 });
    expect(Number.isNaN(skip)).toBe(false);
    expect(Number.isNaN(take)).toBe(false);
    expect({ skip, take }).toEqual({ skip: 0, take: 20 });
  });
});

describe('buildSortOrderBy', () => {
  const WL = { name: 'name', createdAt: 'createdAt', paymentDate: 'paymentDate' };

  it('відомий sortBy + asc → плоска форма { field: asc }', () => {
    expect(buildSortOrderBy(WL, 'name', 'asc')).toEqual({ name: 'asc' });
  });

  it('відомий sortBy + desc → плоска форма { field: desc }', () => {
    expect(buildSortOrderBy(WL, 'name', 'desc')).toEqual({ name: 'desc' });
  });

  it('невідомий sortBy → повний fallback { createdAt: desc }, ігнорує dir', () => {
    expect(buildSortOrderBy(WL, 'DROP TABLE', 'asc')).toEqual({ createdAt: 'desc' });
  });

  it('undefined sortBy → fallback { createdAt: desc }', () => {
    expect(buildSortOrderBy(WL, undefined, undefined)).toEqual({ createdAt: 'desc' });
  });

  it('прототипні ключі (constructor/toString) — fallback (hasOwnProperty guard)', () => {
    expect(buildSortOrderBy(WL, 'constructor', 'asc')).toEqual({ createdAt: 'desc' });
    expect(buildSortOrderBy(WL, 'toString', 'desc')).toEqual({ createdAt: 'desc' });
  });

  it('кастомний fallback field', () => {
    expect(buildSortOrderBy(WL, undefined, undefined, 'name')).toEqual({ name: 'desc' });
  });

  // Bug #598 — nullable-fields wrapper
  describe('nullable fields (Bug #598)', () => {
    const NULLABLE = new Set(['paymentDate']);

    it('nullable field + desc → { field: { sort:desc, nulls:last } } (не виносить NULL наверх)', () => {
      expect(buildSortOrderBy(WL, 'paymentDate', 'desc', 'createdAt', NULLABLE)).toEqual({
        paymentDate: { sort: 'desc', nulls: 'last' },
      });
    });

    it('nullable field + asc → { field: { sort:asc, nulls:last } } (стабільний UX)', () => {
      expect(buildSortOrderBy(WL, 'paymentDate', 'asc', 'createdAt', NULLABLE)).toEqual({
        paymentDate: { sort: 'asc', nulls: 'last' },
      });
    });

    it('non-nullable field (name) — плоска форма навіть з nullableFields set', () => {
      expect(buildSortOrderBy(WL, 'name', 'desc', 'createdAt', NULLABLE)).toEqual({ name: 'desc' });
    });

    it('fallback createdAt (non-nullable) — плоска форма', () => {
      expect(buildSortOrderBy(WL, 'unknown', 'asc', 'createdAt', NULLABLE)).toEqual({
        createdAt: 'desc',
      });
    });

    it('nullableFields undefined → backward-compat: плоска форма для всіх', () => {
      expect(buildSortOrderBy(WL, 'paymentDate', 'desc')).toEqual({ paymentDate: 'desc' });
    });

    it('nullable field як fallback (edge): якщо fallback у nullableFields — теж wrapped', () => {
      const nullableWithFallback = new Set(['createdAt']);
      expect(buildSortOrderBy(WL, 'unknown', 'asc', 'createdAt', nullableWithFallback)).toEqual({
        createdAt: { sort: 'desc', nulls: 'last' },
      });
    });
  });
});
