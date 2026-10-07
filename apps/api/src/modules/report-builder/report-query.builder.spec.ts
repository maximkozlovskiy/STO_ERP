import { describe, it, expect } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { buildQuery, REPORT_TAKE_CAP } from './report-query.builder';

const ORG = 'org-1';

describe('report-query.builder', () => {
  // guards: BR-RPT-006, BR-RPT-007
  it('інжектить orgId + deletedAt для FULL-профілю', () => {
    const q = buildQuery({ entity: 'workOrder', columns: ['number'], groupBy: [] }, ORG);
    expect(q.model).toBe('workOrder');
    expect(q.args.where).toMatchObject({ orgId: ORG, deletedAt: null });
    expect(q.args.take).toBe(REPORT_TAKE_CAP);
  });

  // guards: BR-RPT-001
  it('невідома сутність → BadRequestException', () => {
    expect(() => buildQuery({ entity: 'hacker', columns: [], groupBy: [] }, ORG)).toThrow(
      BadRequestException,
    );
  });

  // guards: BR-RPT-001
  it('proto-injection у entity (__proto__/constructor) → BadRequestException', () => {
    for (const bad of ['__proto__', 'constructor', 'toString']) {
      expect(() => buildQuery({ entity: bad, columns: [], groupBy: [] }, ORG)).toThrow(
        BadRequestException,
      );
    }
  });

  // guards: BR-RPT-002
  it('невідоме поле у columns → BadRequestException', () => {
    expect(() =>
      buildQuery({ entity: 'workOrder', columns: ['secretField'], groupBy: [] }, ORG),
    ).toThrow(BadRequestException);
  });

  it('relation-колонка будує nested select (без include/select mix — Bug #617)', () => {
    const q = buildQuery(
      { entity: 'workOrderPart', columns: ['good.brand.name'], groupBy: [] },
      ORG,
    );
    // good → select → brand → select:{name:true}. Все "усередині" — тільки select
    // (Prisma забороняє include+select на одному рівні).
    expect(q.args.include).toEqual({
      good: {
        select: {
          brand: { select: { name: true } },
        },
      },
    });
  });

  it('Bug #617: include-merge спільних префіксів (good.name + good.brand.name) — тільки select', () => {
    const q = buildQuery(
      { entity: 'workOrderPart', columns: ['good.name', 'good.brand.name'], groupBy: [] },
      ORG,
    );
    const good = (q.args.include as Record<string, unknown>).good as Record<string, unknown>;
    // Bug #617: раніше було good.select + good.include одночасно → Prisma 400.
    // Тепер обидва leaf-и лежать всередині select — Prisma це приймає.
    expect(good.include).toBeUndefined();
    expect(good.select).toEqual({
      name: true,
      brand: { select: { name: true } },
    });
  });

  it('Bug #617: multi-hop (workOrder.counterparty.companyName + workOrder.number) — тільки select', () => {
    const q = buildQuery(
      {
        entity: 'workOrderPart',
        columns: ['workOrder.number', 'workOrder.counterparty.companyName'],
        groupBy: [],
      },
      ORG,
    );
    const wo = (q.args.include as Record<string, unknown>).workOrder as Record<string, unknown>;
    expect(wo.include).toBeUndefined();
    expect(wo.select).toEqual({
      number: true,
      counterparty: { select: { companyName: true } },
    });
  });

  // guards: BR-RPT-004
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

  // guards: BR-RPT-007
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

  // ── Білий список полів, операторів і фільтрів ─────────────────────────────────

  // guards: BR-RPT-002
  it.each([
    ['groupBy', { groupBy: ['secretField'] }],
    ['filters', { filters: [{ field: 'secretField', op: 'eq' as const, value: 1 }] }],
    ['sort', { sort: [{ field: 'secretField', dir: 'asc' as const }] }],
  ])('невідоме поле у %s → BadRequestException', (_slot, part) => {
    expect(() =>
      buildQuery({ entity: 'workOrder', columns: [], groupBy: [], ...part }, ORG),
    ).toThrow(BadRequestException);
  });

  // guards: BR-RPT-003
  it('оператор фільтра поза білим списком → BadRequestException', () => {
    for (const op of ['startsWith', 'search', 'OR', '__proto__']) {
      expect(() =>
        buildQuery(
          {
            entity: 'workOrder',
            columns: [],
            groupBy: [],
            filters: [{ field: 'number', op: op as never, value: 'WO' }],
          },
          ORG,
        ),
      ).toThrow(BadRequestException);
    }
  });

  // guards: BR-RPT-003
  it('contains для enum-, number- і decimal-поля → BadRequestException, для тексту — нечутливий до регістру', () => {
    const run = (entity: string, field: string, value: unknown) =>
      buildQuery(
        { entity, columns: [], groupBy: [], filters: [{ field, op: 'contains', value }] },
        ORG,
      );
    expect(() => run('workOrder', 'status', 'COMPLETED')).toThrow(BadRequestException); // enum
    expect(() => run('workOrderPart', 'quantity', 5)).toThrow(BadRequestException); // number
    expect(() => run('invoice', 'amount', 100)).toThrow(BadRequestException); // decimal
    expect(run('workOrder', 'number', 'wo-1').args.where).toMatchObject({
      number: { contains: 'wo-1', mode: 'insensitive' },
    });
  });

  // guards: BR-RPT-003
  it('оператор in без масиву → BadRequestException', () => {
    expect(() =>
      buildQuery(
        {
          entity: 'workOrder',
          columns: [],
          groupBy: [],
          filters: [{ field: 'number', op: 'in', value: 'WO-1' }],
        },
        ORG,
      ),
    ).toThrow(BadRequestException);
  });

  // guards: BR-RPT-005
  it('фільтр по нефільтровному полю (stockMovement.quantity) → BadRequestException', () => {
    expect(() =>
      buildQuery(
        {
          entity: 'stockMovement',
          columns: [],
          groupBy: [],
          filters: [{ field: 'quantity', op: 'gt', value: 0 }],
        },
        ORG,
      ),
    ).toThrow(BadRequestException);
  });

  // ── Ліміт рядків ──────────────────────────────────────────────────────────────

  // guards: BR-RPT-008
  it('take завжди 5000 — для кожної сутності реєстру, незалежно від config', () => {
    for (const entity of [
      'workOrder',
      'workOrderPart',
      'purchaseOrderLine',
      'invoice',
      'payment',
      'settlementTransaction',
      'stockMovement',
      'stockBatch',
      'stockItem',
    ]) {
      const q = buildQuery({ entity, columns: [], groupBy: [], take: 1_000_000 } as never, ORG);
      expect(q.args.take, entity).toBe(5000);
    }
  });

  // ── Період за Києвом ──────────────────────────────────────────────────────────

  // guards: BR-RPT-009
  it('dateRange — межі київської доби: літо UTC+3 і зима UTC+2', () => {
    const range = (from: string, to: string) =>
      (
        buildQuery({ entity: 'invoice', columns: [], groupBy: [], dateRange: { from, to } }, ORG)
          .args.where as Record<string, { gte: Date; lte: Date }>
      ).documentDate;
    const summer = range('2026-09-01', '2026-09-30');
    expect(summer.gte.toISOString()).toBe('2026-08-31T21:00:00.000Z'); // 01.09 00:00 Київ
    // Верхня межа — кінець київської доби 30.09. Точне значення не фіксуємо: kyivOffsetMs губить
    // мілісекунди, тож межа зсунута на 999 мс за північ (знахідка в дос'є, «Знахідки 2026-10-08»).
    expect(summer.lte.getTime()).toBeGreaterThanOrEqual(Date.parse('2026-09-30T20:59:59.999Z'));
    expect(summer.lte.getTime()).toBeLessThan(Date.parse('2026-09-30T21:00:01.000Z'));
    const winter = range('2026-01-15', '2026-01-15');
    expect(winter.gte.toISOString()).toBe('2026-01-14T22:00:00.000Z');
    expect(winter.lte.getTime()).toBeGreaterThanOrEqual(Date.parse('2026-01-15T21:59:59.999Z'));
    expect(winter.lte.getTime()).toBeLessThan(Date.parse('2026-01-15T22:00:01.000Z'));
  });

  // guards: BR-RPT-009
  it('dateRange лягає на dateField сутності (stockMovement → createdAt), а не на фіксоване поле', () => {
    const where = buildQuery(
      {
        entity: 'stockMovement',
        columns: [],
        groupBy: [],
        dateRange: { from: '2026-09-01', to: '2026-09-01' },
      },
      ORG,
    ).args.where;
    expect(Object.keys(where).sort()).toEqual(['createdAt', 'orgId']);
  });

  // guards: BR-RPT-009
  it('dateRange: початок пізніше кінця → BadRequestException', () => {
    expect(() =>
      buildQuery(
        {
          entity: 'invoice',
          columns: [],
          groupBy: [],
          dateRange: { from: '2026-09-30', to: '2026-09-01' },
        },
        ORG,
      ),
    ).toThrow(BadRequestException);
  });
});
