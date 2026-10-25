import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createPgAdapter } from '../../prisma/pg-adapter';
import { handleDbUnavailable, testDatabaseUrl } from '../../common/testing/require-db';
import { ReportBuilderService, type FullReportConfig } from './report-builder.service';
import type { PrismaService } from '../../prisma/prisma.service';
import {
  REGISTRY,
  REGISTRY_ENUMS,
  type ReportEntityDef,
  type ReportFieldDef,
} from './report-registry';
import { buildQuery } from './report-query.builder';
import { aggregate, type GroupNode, type ReportAggInput } from './report-aggregator';
import type { ReportFilterInput } from './report-condition';

/**
 * ІНТЕГРАЦІЙНИЙ паритет двох рендерерів умов конструктора (BR-RPT-027) проти ЖИВОЇ БД.
 * Групи, «Разом» і склеєні рядки рахує SQL (`report-sql.builder.ts`); еталон — Prisma `findMany`
 * БЕЗ ліміту з тим самим `where` + JS-агрегатор (`aggregate`), яким звіт рахувався до 2026-10-25.
 * Для матриці конфігів (кожна сутність × групування × фільтр кожного типу поля) мають збігтися
 * кількість рядків, кожна група (ключі, кількість, агрегати) і склеєні плоскі рядки.
 *
 * Дані не засіваються: рухи й платежі append-only (тригери не дають прибрати), тож тест іде по
 * тому, що вже є в базі. У dev-базі «Рухи товару» понад 5000 рядків — паритет доводить, що групи
 * точні понад ліміт детальних. У CI (чиста база + seed) — синтаксис і семантика SQL для всіх 9
 * сутностей. Умови запуску: жива Postgres на DATABASE_URL; без БД — SKIP (у CI з REQUIRE_DB — FAIL).
 */

let dbAvailable = false;
let raw: PrismaClient;
let orgId = '';
let service: ReportBuilderService;

beforeAll(async () => {
  raw = new PrismaClient({ adapter: createPgAdapter(testDatabaseUrl()) });
  try {
    await raw.$connect();
    await raw.$queryRawUnsafe(`SELECT 1 FROM "stock_movements" LIMIT 0`);
  } catch {
    handleDbUnavailable('connection failed or schema is not migrated');
    return;
  }
  // Організація з найбільшою кількістю рухів — там найбагатші дані для паритету.
  const top = await raw.$queryRawUnsafe<{ orgId: string }[]>(
    `SELECT "orgId" FROM stock_movements GROUP BY "orgId" ORDER BY COUNT(*) DESC LIMIT 1`,
  );
  const branch = await raw.garageBranch.findFirst({ select: { orgId: true } });
  orgId = top[0]?.orgId ?? branch?.orgId ?? '';
  if (!orgId) {
    handleDbUnavailable('no organisation in the database (seed not applied)');
    return;
  }
  service = new ReportBuilderService(raw as unknown as PrismaService);
  dbAvailable = true;
}, 60_000);

afterAll(async () => {
  await raw?.$disconnect();
});

// ── Еталон і нормалізація ─────────────────────────────────────────────────────────

const close = (a: number | null, b: number | null) =>
  a === null || b === null
    ? a === b
    : Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));

/** Дерево → мапа «шлях ключів» → { count, aggregates }. */
function flattenTree(nodes: GroupNode[], prefix = ''): Map<string, GroupNode> {
  const out = new Map<string, GroupNode>();
  for (const n of nodes) {
    const path = `${prefix}/${n.key}`;
    out.set(path, n);
    for (const [k, v] of flattenTree(n.children, path)) out.set(k, v);
  }
  return out;
}

/** Значення клітинки склеєного рядка для порівняння: Decimal/число → число, дата → ISO. */
function cell(v: unknown): string {
  if (v === null || v === undefined) return '∅';
  if (v instanceof Date) return v.toISOString();
  // Числа — без хвоста двійкового дробу: JS-еталон складає float (0.1 + 0.2), SQL — точно.
  if (typeof v === 'object' && v !== null && 'toFixed' in v) return String(Number(v));
  if (typeof v === 'number') return String(Number(v.toFixed(6)));
  return String(v);
}

async function compare(config: FullReportConfig, label: string): Promise<void> {
  // Обидва читання — в одному знімку (REPEATABLE READ): паралельні integration-спеки пишуть наряди
  // й закупівлі в ту саму базу, і два окремі читання бачили різні дані (хибна розбіжність).
  const { actual, rows } = await raw.$transaction(
    async tx => {
      const svc = new ReportBuilderService(tx as unknown as PrismaService);
      const built = buildQuery(config, orgId);
      return {
        actual: await svc.run(orgId, config),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        rows: (await (tx as any)[built.model].findMany({
          ...built.args,
          take: undefined,
        })) as Record<string, unknown>[],
      };
    },
    { isolationLevel: 'RepeatableRead', timeout: 120_000 },
  );
  const aggs: ReportAggInput[] = actual.aggregations.map(a => ({ field: a.field, agg: a.agg }));
  const expected = aggregate(
    rows,
    { groupBy: config.groupBy, columns: config.columns, aggregations: aggs, includeRows: true },
    REGISTRY[config.entity],
  );

  expect(actual.result.rowCount, `${label}: rowCount`).toBe(rows.length);
  for (const [alias, v] of Object.entries(expected.grandTotals)) {
    expect(close(actual.result.grandTotals[alias] ?? null, v), `${label}: Разом ${alias}`).toBe(
      true,
    );
  }

  if (config.groupBy.length > 0) {
    const a = flattenTree(actual.result.tree);
    const e = flattenTree(expected.tree);
    expect([...a.keys()].sort(), `${label}: групи`).toEqual([...e.keys()].sort());
    for (const [path, en] of e) {
      const an = a.get(path)!;
      expect(an.count, `${label}: ${path} count`).toBe(en.count);
      for (const [alias, v] of Object.entries(en.aggregates)) {
        expect(close(an.aggregates[alias] ?? null, v), `${label}: ${path} ${alias}`).toBe(true);
      }
    }
  } else if (config.columns.length > 0 && !actual.result.detailTruncated) {
    const key = (r: Record<string, unknown>) =>
      config.columns.map(c => cell(r[c])).join('|') + `#${String(r.__mergedCount)}`;
    expect(actual.result.detailRows.map(key).sort(), `${label}: склеєні рядки`).toEqual(
      expected.detailRows.map(key).sort(),
    );
  }
}

// ── Матриця ───────────────────────────────────────────────────────────────────────

/** Фільтри, що зачіпають кожен тип поля й оператор. */
function filtersFor(f: ReportFieldDef): ReportFilterInput[] {
  const out: ReportFilterInput[] = [];
  if (f.nullable) {
    out.push(
      { field: f.key, op: 'isNull', value: true },
      { field: f.key, op: 'isNull', value: false },
    );
  }
  switch (f.type) {
    case 'enum': {
      const values = REGISTRY_ENUMS[f.enumName!];
      out.push(
        { field: f.key, op: 'eq', value: values[0] },
        { field: f.key, op: 'ne', value: values[0] },
        { field: f.key, op: 'in', value: values.slice(0, 2) },
      );
      break;
    }
    case 'scalar':
      out.push(
        { field: f.key, op: 'contains', value: 'а' },
        { field: f.key, op: 'contains', value: '%' },
        { field: f.key, op: 'contains', value: '_' },
        { field: f.key, op: 'ne', value: 'x' },
      );
      break;
    case 'number':
    case 'decimal':
      out.push({ field: f.key, op: 'gte', value: '1' }, { field: f.key, op: 'lt', value: '100' });
      break;
    case 'date':
      out.push(
        { field: f.key, op: 'gte', value: '2026-10-01' },
        { field: f.key, op: 'eq', value: '2026-10-22' },
        { field: f.key, op: 'ne', value: '2026-10-22' },
      );
      break;
    case 'boolean':
      out.push({ field: f.key, op: 'eq', value: true });
      break;
  }
  return out;
}

function configsFor(e: ReportEntityDef): { label: string; config: FullReportConfig }[] {
  const groupable = e.fields.filter(f => f.groupable);
  const numeric = e.fields.filter(f => f.aggregations.length > 0);
  const aggregations = numeric.flatMap(f => f.aggregations.map(agg => ({ field: f.key, agg })));
  const columns = e.fields.map(f => f.key);
  const out: { label: string; config: FullReportConfig }[] = [
    { label: `${e.key} плоский`, config: { entity: e.key, columns, groupBy: [] } },
    {
      label: `${e.key} Разом`,
      config: { entity: e.key, columns: [], groupBy: [], aggregations },
    },
  ];
  for (const g of groupable) {
    out.push({
      label: `${e.key} групи ${g.key}`,
      config: { entity: e.key, columns: [], groupBy: [g.key], aggregations },
    });
  }
  if (groupable.length >= 2) {
    out.push({
      label: `${e.key} групи ${groupable[0].key} → ${groupable[1].key}`,
      config: {
        entity: e.key,
        columns: [],
        groupBy: [groupable[0].key, groupable[1].key],
        aggregations,
      },
    });
  }
  for (const f of e.fields.filter(x => x.filterable)) {
    for (const filter of filtersFor(f)) {
      out.push({
        label: `${e.key} фільтр ${f.key} ${filter.op} ${JSON.stringify(filter.value)}`,
        config: {
          entity: e.key,
          columns: [],
          groupBy: groupable.length ? [groupable[0].key] : [],
          aggregations,
          filters: [filter],
        },
      });
    }
  }
  out.push({
    label: `${e.key} період`,
    config: {
      entity: e.key,
      columns: [],
      groupBy: [],
      aggregations,
      dateRange: { from: '2026-10-01', to: '2026-10-25' },
    },
  });
  return out;
}

describe('report-builder: SQL-агрегати = Prisma where + JS-агрегатор (паритет)', () => {
  for (const e of Object.values(REGISTRY)) {
    // guards: BR-RPT-027
    it(`${e.key}: групи, «Разом», склеєні рядки й фільтри збігаються з еталоном`, async ({
      skip,
    }) => {
      if (!dbAvailable) return skip();
      for (const { label, config } of configsFor(e)) {
        await compare(config, label);
      }
    }, 300_000);
  }

  // BR-RPT-028: група «X» = фільтр «= X», група «(порожньо)» = фільтр «порожнє». До 2026-10-25
  // фільтр по зв'язку відсікав видалений пов'язаний запис, а групування — ні («Платежі» за
  // контрагентом: група ∅ = 930, фільтр «порожнє» = 928).
  for (const e of Object.values(REGISTRY)) {
    // guards: BR-RPT-028
    it(`${e.key}: кожна група = фільтр за її значенням`, async ({ skip }) => {
      if (!dbAvailable) return skip();
      for (const f of e.fields.filter(x => x.groupable && x.filterable)) {
        const grouped = await service.run(orgId, { entity: e.key, columns: [], groupBy: [f.key] });
        for (const node of grouped.result.tree.slice(0, 8)) {
          const filter: ReportFilterInput =
            node.key === '∅'
              ? { field: f.key, op: 'isNull', value: true }
              : {
                  field: f.key,
                  op: 'eq',
                  value: f.type === 'boolean' ? node.key === 'true' : node.key,
                };
          const filtered = await service.run(orgId, {
            entity: e.key,
            columns: [],
            groupBy: [],
            filters: [filter],
          });
          expect(filtered.result.rowCount, `${e.key}.${f.key} = ${node.key}`).toBe(node.count);
        }
      }
    }, 300_000);
  }
});
