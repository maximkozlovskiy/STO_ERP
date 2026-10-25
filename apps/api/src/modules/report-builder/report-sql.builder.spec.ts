import { describe, it, expect } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { buildConditions, type ReportConfigInput } from './report-condition';
import { assertGroupable, buildAggregateSql, buildMergedRowsSql } from './report-sql.builder';
import { getEntity, getField } from './report-registry';
import type { ReportAggInput } from './report-aggregator';

/**
 * Форма SQL-агрегатів (BR-RPT-027). Що SQL дає ту саму вибірку й ті самі суми, що Prisma + JS,
 * доводить `report-builder.parity.integration.spec.ts` на живій БД; тут — безпека й ключові
 * конструкції запиту без БД.
 */

const ORG = '11111111-1111-4111-8111-111111111111';

const agg = (config: ReportConfigInput, aggs: ReportAggInput[] = []) => {
  const conds = buildConditions(config, ORG);
  const groupBy = assertGroupable(conds.entity, config.groupBy);
  return buildAggregateSql(conds, groupBy, aggs);
};

describe('report-sql.builder', () => {
  // guards: BR-RPT-006
  it('orgId — параметром на корені й у ON кожного з’єднання, ніколи не текстом запиту', () => {
    const sql = agg({
      entity: 'workOrderPart',
      columns: [],
      groupBy: ['good.brand.name', 'warehouse.name'],
    });
    expect(sql.sql).toContain('t0."orgId" = ');
    // корінь + good + brand + warehouse + workOrder (документ-власник)
    expect(sql.values.filter(v => v === ORG)).toHaveLength(5);
    expect(sql.sql).not.toContain(ORG);
    expect(sql.sql).toMatch(
      /LEFT JOIN "goods" t\d+ ON t\d+\."id" = t0\."goodId" AND t\d+\."orgId" = /,
    );
    expect(sql.sql).toMatch(/LEFT JOIN "brands" t\d+ ON t\d+\."id" = t\d+\."brandId"/);
  });

  // guards: BR-RPT-007
  it('soft delete кореня й документа-власника; сторно платежу за замовчуванням', () => {
    const wop = agg({ entity: 'workOrderPart', columns: [], groupBy: [] });
    expect(wop.sql).toContain('t0."deletedAt" IS NULL');
    expect(wop.sql).toMatch(/t\d+\."id" IS NOT NULL AND t\d+\."deletedAt" IS NULL/);
    const pay = agg({ entity: 'payment', columns: [], groupBy: [] });
    expect(pay.sql).not.toContain('t0."deletedAt"');
    expect(pay.sql).toContain('t0."reversedAt" IS NULL');
  });

  // guards: BR-RPT-010
  it('групування за датою-міткою — київський день через подвійний AT TIME ZONE; @db.Date — як є', () => {
    const ts = agg({ entity: 'payment', columns: [], groupBy: ['createdAt'] });
    expect(ts.sql).toContain(
      `to_char((t0."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Kyiv', 'YYYY-MM-DD')`,
    );
    const d = agg({ entity: 'workOrder', columns: [], groupBy: ['documentDate'] });
    expect(d.sql).toContain(`to_char(t0."documentDate", 'YYYY-MM-DD')`);
  });

  // guards: BR-RPT-013
  it('групи всіх рівнів і «Разом» — один GROUP BY ROLLUP з GROUPING на кожен ключ', () => {
    const sql = agg({ entity: 'workOrder', columns: [], groupBy: ['status', 'priority'] }, [
      { field: 'totalAmount', agg: 'SUM' },
      { field: 'totalAmount', agg: 'AVG' },
    ]);
    expect(sql.sql).toContain('GROUP BY ROLLUP (k0, k1)');
    expect(sql.sql).toContain('GROUPING(k0) AS g0');
    expect(sql.sql).toContain('GROUPING(k1) AS g1');
    expect(sql.sql).toContain('COALESCE(SUM(v0), 0)');
    expect(sql.sql).toContain('AVG(v1)');
    const flat = agg({ entity: 'workOrder', columns: [], groupBy: [] });
    expect(flat.sql).not.toContain('GROUP BY');
  });

  // guards: BR-RPT-013
  it('ліміт груп відрізає лише найглибші: ORDER BY рівня перед LIMIT («Разом» і батьки — першими)', () => {
    const sql = agg({ entity: 'workOrder', columns: [], groupBy: ['status', 'priority'] });
    // Без ORDER BY хешований ROLLUP віддає рядки довільно, і LIMIT різав «Разом» (rowCount 0).
    expect(sql.sql).toMatch(
      /GROUP BY ROLLUP \(k0, k1\) ORDER BY GROUPING\(k0\) \+ GROUPING\(k1\) DESC LIMIT/,
    );
  });

  // guards: BR-RPT-014
  it('знакова кількість руху: резерви поза сумою, списання від’ємне', () => {
    const sql = agg({ entity: 'stockMovement', columns: [], groupBy: [] }, [
      { field: 'quantity', agg: 'SUM' },
    ]);
    expect(sql.sql).toMatch(
      /CASE WHEN t0\."type"::text IN \(.+\) THEN NULL WHEN t0\."type"::text = .+ THEN -ABS/,
    );
    expect(sql.values).toEqual(
      expect.arrayContaining(['RESERVATION', 'RESERVATION_RELEASE', 'WRITEOFF']),
    );
  });

  // guards: BR-RPT-025
  it('«≠ день» — OR двох меж; колонка @db.Date порівнюється з датою, не з міткою', () => {
    const sql = agg({
      entity: 'workOrder',
      columns: [],
      groupBy: [],
      filters: [{ field: 'documentDate', op: 'ne', value: '22.10.2026' }],
    });
    expect(sql.sql).toContain('(t0."documentDate" < ');
    expect(sql.sql).toContain(' OR t0."documentDate" > ');
    expect(sql.sql).toContain('::date');
    expect(sql.values).toContain('2026-10-22');
  });

  // guards: BR-RPT-022
  it('фільтр по зв’язку — зв’язок має існувати й бути живим, як Prisma-фільтр `is`', () => {
    const sql = agg({
      entity: 'purchaseOrderLine',
      columns: [],
      groupBy: [],
      filters: [{ field: 'purchaseOrder.supplier.companyName', op: 'contains', value: 'тов' }],
    });
    expect(sql.sql).toMatch(/ILIKE/);
    expect(sql.values).toContain('%тов%');
    expect(sql.sql.match(/"id" IS NOT NULL/g)?.length).toBeGreaterThanOrEqual(2);
  });

  // guards: BR-RPT-015
  it('склеєні плоскі рядки: GROUP BY непідсумовуваних колонок, SUM підсумовуваних, ліміт 5000+1', () => {
    const conds = buildConditions(
      { entity: 'purchaseOrderLine', columns: ['good.name', 'price', 'quantity'], groupBy: [] },
      ORG,
    );
    const sql = buildMergedRowsSql(conds, ['good.name', 'price', 'quantity'], null);
    expect(sql.sql).toContain('AS d0'); // good.name
    expect(sql.sql).toContain('AS d1'); // price — ціна не складається
    expect(sql.sql).toContain('AS s0'); // quantity
    expect(sql.sql).toContain('GROUP BY 1, 2');
    expect(sql.sql).toContain('ORDER BY MAX(t0."createdAt") DESC');
    expect(sql.values).toContain(5001);
  });

  // guards: BR-RPT-015
  it('склеювання лише підсумовуваних колонок: HAVING — порожня вибірка не дає фантомного рядка нулів', () => {
    const conds = buildConditions(
      { entity: 'purchaseOrderLine', columns: ['quantity'], groupBy: [] },
      ORG,
    );
    const sql = buildMergedRowsSql(conds, ['quantity'], null);
    expect(sql.sql).not.toContain('GROUP BY');
    expect(sql.sql).toContain('HAVING COUNT(*) > 0');
  });

  // guards: BR-RPT-002
  it('групування лише за полем з groupable; інше → 400 з назвою поля', () => {
    const e = getEntity('workOrder');
    expect(() => assertGroupable(e, ['totalAmount'])).toThrow(BadRequestException);
    expect(() => assertGroupable(e, ['totalAmount'])).toThrow(getField(e, 'totalAmount').label);
    expect(assertGroupable(e, ['status']).map(f => f.key)).toEqual(['status']);
  });
});
