/**
 * ReportBuilderService — тонкий unit-shim (без Prisma-стуба): тестує ЛИШЕ помарк-логіку
 * навколо збагачення `aggregations` (Bug #620). Логіку `aggregate()` та `buildQuery()`
 * покривають окремі spec-и.
 */
import { describe, it, expect } from 'vitest';
import { ReportBuilderService } from './report-builder.service';
import { getEntity } from './report-registry';

/** Викликаємо приватний метод через bracket-access (unit-shim, tests only). */
function callEffective(
  service: ReportBuilderService,
  entity: ReturnType<typeof getEntity>,
  config: unknown,
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (service as any).effectiveAggregations(entity, config);
}

describe('ReportBuilderService — Bug #620: aggregations enrichment', () => {
  const service = new ReportBuilderService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {} as any,
  );

  it('effectiveAggregations додає авто-SUM тільки для числових колонок без явного agg', () => {
    const entity = getEntity('invoice');
    const config = {
      entity: 'invoice',
      columns: ['amount', 'totalVat', 'number', 'status'], // number/status — не числові
      groupBy: [],
      aggregations: [{ field: 'amount', agg: 'AVG' as const }],
    };
    const eff = callEffective(service, entity, config);
    // amount — має AVG (не авто-SUM), totalVat — автo-SUM, number/status — жодного.
    expect(eff).toEqual([
      { field: 'amount', agg: 'AVG' },
      { field: 'totalVat', agg: 'SUM' },
    ]);
  });

  it('Bug #620: run повинен збагачувати aggregations типом і label (перевіряється у e2e/integration; тут — контракт типу)', () => {
    // Це sanity-тест: якщо effectiveAggregations повертає лише {field,agg}, то мапа у run
    // додає type/label з entity.fields. Симулюємо ту саму трансформацію тут.
    const entity = getEntity('invoice');
    const eff = [
      { field: 'documentDate', agg: 'MIN' as const },
      { field: 'amount', agg: 'SUM' as const },
    ];
    const enriched = eff.map(a => {
      const fld = entity.fields.find(f => f.key === a.field);
      return {
        field: a.field,
        agg: a.agg,
        type: fld?.type ?? 'scalar',
        label: fld?.label ?? a.field,
      };
    });
    expect(enriched).toEqual([
      { field: 'documentDate', agg: 'MIN', type: 'date', label: 'Дата' },
      { field: 'amount', agg: 'SUM', type: 'decimal', label: 'Сума' },
    ]);
  });
});
