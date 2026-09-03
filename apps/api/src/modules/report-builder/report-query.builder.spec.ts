import { describe, it, expect } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { buildQuery, REPORT_TAKE_CAP } from './report-query.builder';

const ORG = 'org-1';

describe('report-query.builder', () => {
  it('інжектить orgId + deletedAt для FULL-профілю', () => {
    const q = buildQuery({ entity: 'workOrder', columns: ['number'], groupBy: [] }, ORG);
    expect(q.model).toBe('workOrder');
    expect(q.args.where).toMatchObject({ orgId: ORG, deletedAt: null });
    expect(q.args.take).toBe(REPORT_TAKE_CAP);
  });

  it('невідома сутність → BadRequestException', () => {
    expect(() => buildQuery({ entity: 'hacker', columns: [], groupBy: [] }, ORG)).toThrow(
      BadRequestException,
    );
  });

  it('proto-injection у entity (__proto__/constructor) → BadRequestException', () => {
    for (const bad of ['__proto__', 'constructor', 'toString']) {
      expect(() => buildQuery({ entity: bad, columns: [], groupBy: [] }, ORG)).toThrow(
        BadRequestException,
      );
    }
  });

  it('невідоме поле у columns → BadRequestException', () => {
    expect(() =>
      buildQuery({ entity: 'workOrder', columns: ['secretField'], groupBy: [] }, ORG),
    ).toThrow(BadRequestException);
  });

  it('relation-колонка будує вкладений include+select', () => {
    const q = buildQuery(
      { entity: 'workOrderPart', columns: ['good.brand.name'], groupBy: [] },
      ORG,
    );
    // good → include → brand → select:{name:true}. БЕЗ where у nested include (to-one relation).
    expect(q.args.include).toEqual({
      good: {
        include: {
          brand: { select: { name: true } },
        },
      },
    });
  });

  it('include-merge спільних префіксів (good.name + good.brand.name)', () => {
    const q = buildQuery(
      { entity: 'workOrderPart', columns: ['good.name', 'good.brand.name'], groupBy: [] },
      ORG,
    );
    const good = (q.args.include as Record<string, unknown>).good as Record<string, unknown>;
    expect(good.select).toEqual({ name: true });
    expect(good.include).toEqual({
      brand: { select: { name: true } },
    });
  });

  it('enum-фільтр з валідним значенням проходить, з невалідним → 400', () => {
    expect(() =>
      buildQuery(
        {
          entity: 'workOrder',
          columns: [],
          groupBy: [],
          filters: [{ field: 'status', op: 'eq', value: 'COMPLETED' }],
        },
        ORG,
      ),
    ).not.toThrow();
    expect(() =>
      buildQuery(
        {
          entity: 'workOrder',
          columns: [],
          groupBy: [],
          filters: [{ field: 'status', op: 'eq', value: 'HACKED' }],
        },
        ORG,
      ),
    ).toThrow(BadRequestException);
  });

  it('relation-фільтр додає nested deletedAt (Bug #607)', () => {
    const q = buildQuery(
      {
        entity: 'workOrder',
        columns: [],
        groupBy: [],
        filters: [{ field: 'counterparty.type', op: 'eq', value: 'CLIENT' }],
      },
      ORG,
    );
    expect(q.args.where).toMatchObject({
      counterparty: { deletedAt: null, type: 'CLIENT' },
    });
  });

  it('dateRange → фільтр по entity.dateField (Kyiv-межі)', () => {
    const q = buildQuery(
      {
        entity: 'workOrder',
        columns: [],
        groupBy: [],
        dateRange: { from: '2026-09-01', to: '2026-09-30' },
      },
      ORG,
    );
    const w = q.args.where as Record<string, { gte: Date; lte: Date }>;
    expect(w.documentDate.gte).toBeInstanceOf(Date);
    expect(w.documentDate.lte).toBeInstanceOf(Date);
    expect(w.documentDate.gte.getTime()).toBeLessThan(w.documentDate.lte.getTime());
  });

  it('orderBy fallback на defaultSort коли sort порожній', () => {
    const q = buildQuery({ entity: 'workOrder', columns: ['number'], groupBy: [] }, ORG);
    expect(q.args.orderBy).toEqual([{ createdAt: 'desc' }]);
  });

  it('sort по relation-полю будує вкладений orderBy', () => {
    const q = buildQuery(
      {
        entity: 'workOrderPart',
        columns: [],
        groupBy: [],
        sort: [{ field: 'good.name', dir: 'asc' }],
      },
      ORG,
    );
    expect(q.args.orderBy).toEqual([{ good: { name: 'asc' } }]);
  });
});
