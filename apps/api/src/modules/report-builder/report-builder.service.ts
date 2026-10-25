import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { translateError } from '@sto/shared';
import { getLocale } from '../../common/tenant/tenant-context';
import { PrismaService } from '../../prisma/prisma.service';
import { REGISTRY, REGISTRY_ENUMS, getEntity, ReportEntityDef } from './report-registry';
import { buildQuery, ReportConfigInput } from './report-query.builder';
import { ReportResult, ReportAggInput, assertAggregations } from './report-aggregator';
import { buildConditions } from './report-condition';
import { assertGroupable, buildAggregateSql, buildMergedRowsSql } from './report-sql.builder';
import { assembleMergedRows, assembleTree } from './report-sql-result';

/** Повний config звіту: білдер-частина + агрегація/групування для JS-шару. */
export type FullReportConfig = ReportConfigInput & {
  aggregations?: ReportAggInput[];
  includeRows?: boolean;
  /** Сортування ГРУП за агрегатом: alias='SUM_amount' + напрям. */
  sortByAggregate?: { alias: string; dir: 'asc' | 'desc' };
};

const NUMERIC_TYPES = new Set(['number', 'decimal']);

/** Ефективна агрегація з розширеною метаданими для UI-рендеру (Bug #620).
 * `type`+`label` дозволяють правильно форматувати MIN/MAX-дати, гроші, штуки без
 * додаткового пошуку в метадані фронта, і працює навіть коли поле не в `columns`. */
export interface ReportAggEnriched extends ReportAggInput {
  type: string;
  label: string;
}

export interface ReportRunResult {
  entity: string;
  columns: Array<{ key: string; label: string; type: string; enumName?: string }>;
  groupBy: string[];
  /** Ефективні агрегації (явні + авто-SUM) — для рендеру заголовків/дерева. */
  aggregations: ReportAggEnriched[];
  result: ReportResult;
}

@Injectable()
export class ReportBuilderService {
  constructor(private readonly prisma: PrismaService) {}

  /** Реєстр для фронта. advanced-зв'язки не приховуємо у v1 (їх немає), але поле лишаємо. */
  getMetadata() {
    return {
      entities: Object.values(REGISTRY).map(e => ({
        key: e.key,
        label: e.label,
        dateField: e.dateField,
        fields: e.fields.map(f => ({
          key: f.key,
          label: f.label,
          type: f.type,
          enumName: f.enumName,
          aggregations: f.aggregations,
          filterable: f.filterable,
          groupable: f.groupable,
          nullable: f.nullable === true,
        })),
        relations: e.relations.map(r => ({
          key: r.key,
          label: r.label,
          advanced: r.advanced,
        })),
      })),
      enums: REGISTRY_ENUMS,
    };
  }

  /** Виконує ad-hoc звіт: config → Prisma findMany → JS-групування. */
  async run(orgId: string, config: FullReportConfig): Promise<ReportRunResult> {
    const entity = getEntity(config.entity);

    // Ефективні агрегації: явні + авто-SUM для числових колонок без обраної агрегації
    // (діра #1: колонка-число без agg раніше губилась). Знакові поля (signedByType) —
    // SUM теж коректний (нетто). balance/stateNotFlow — НЕ авто-SUM (SUM заборонений).
    const rawAggregations = this.effectiveAggregations(entity, config);
    // Bug #620: збагачуємо агрегації типом/label з реєстру — щоб фронт міг форматувати
    // MIN/MAX-дати як дати, а не як гроші, навіть коли поле НЕ у config.columns.
    const aggregations: ReportAggEnriched[] = rawAggregations.map(a => {
      const fld = entity.fields.find(f => f.key === a.field);
      return {
        field: a.field,
        agg: a.agg,
        type: fld?.type ?? 'scalar',
        label: fld?.label ?? a.field,
      };
    });

    // Детальні рядки завжди (діра #5: без цього «детальний звіт» неможливий).
    const includeRows = config.includeRows ?? true;
    const result = await this.aggregateInDb(orgId, config, entity, aggregations, includeRows);
    return {
      entity: entity.key,
      columns: this.expandColumns(entity, config.columns),
      groupBy: config.groupBy,
      aggregations, // ефективні (з авто-SUM) — фронт рендерить заголовки/дерево з них
      result,
    };
  }

  /**
   * Групи, «Разом» і склеєні плоскі рядки рахує PostgreSQL — точно на будь-якому обсязі
   * (BR-RPT-027); детальні рядки груп (≤5000) читає Prisma з тим самим набором умов.
   */
  private async aggregateInDb(
    orgId: string,
    config: FullReportConfig,
    entity: ReportEntityDef,
    aggregations: ReportAggInput[],
    includeRows: boolean,
  ): Promise<ReportResult> {
    const conds = buildConditions(config, orgId);
    const groupFields = assertGroupable(entity, config.groupBy);
    assertAggregations(aggregations, entity);
    const wantDetail = includeRows && config.columns.length > 0;
    const sort = config.sort?.[0] ?? null;

    if (groupFields.length === 0) {
      const [totals, merged] = await Promise.all([
        this.prisma.$queryRaw<Record<string, unknown>[]>(
          buildAggregateSql(conds, [], aggregations),
        ),
        wantDetail
          ? this.prisma.$queryRaw<Record<string, unknown>[]>(
              buildMergedRowsSql(conds, config.columns, sort),
            )
          : Promise.resolve([]),
      ]);
      const assembled = assembleTree(totals, [], aggregations, {
        detail: null,
        columns: config.columns,
        entity,
      });
      const flat = assembleMergedRows(merged, config.columns, entity);
      return {
        tree: [],
        detailRows: flat.detailRows,
        grandTotals: assembled.grandTotals,
        rowCount: assembled.rowCount,
        detailTruncated: flat.truncated,
        groupsTruncated: false,
        truncated: flat.truncated,
      };
    }

    const built = buildQuery(config, orgId);
    const [rollup, detail] = await Promise.all([
      this.prisma.$queryRaw<Record<string, unknown>[]>(
        buildAggregateSql(conds, groupFields, aggregations),
      ),
      wantDetail ? this.runFindMany(built.model, built.args) : Promise.resolve(null),
    ]);
    const assembled = assembleTree(rollup, groupFields, aggregations, {
      detail,
      columns: config.columns,
      entity,
      sortByAggregate: config.sortByAggregate,
    });
    const detailTruncated = (detail?.length ?? 0) >= built.args.take;
    return {
      tree: assembled.tree,
      detailRows: [],
      grandTotals: assembled.grandTotals,
      rowCount: assembled.rowCount,
      detailTruncated,
      groupsTruncated: assembled.groupsTruncated,
      truncated: detailTruncated || assembled.groupsTruncated,
    };
  }

  /** Явні агрегації + авто-SUM для числових columns без власної агрегації. */
  private effectiveAggregations(
    entity: ReportEntityDef,
    config: FullReportConfig,
  ): ReportAggInput[] {
    const explicit = config.aggregations ?? [];
    const haveAgg = new Set(explicit.map(a => a.field));
    const auto: ReportAggInput[] = [];
    for (const key of config.columns) {
      if (haveAgg.has(key)) continue;
      const fld = entity.fields.find(f => f.key === key);
      if (
        fld &&
        NUMERIC_TYPES.has(fld.type) &&
        !fld.stateNotFlow &&
        fld.aggregations.includes('SUM')
      ) {
        auto.push({ field: key, agg: 'SUM' });
      }
    }
    return [...explicit, ...auto];
  }

  private expandColumns(entity: ReportEntityDef, columns: string[]) {
    return columns.map(key => {
      const f = entity.fields.find(x => x.key === key);
      return { key, label: f?.label ?? key, type: f?.type ?? 'scalar', enumName: f?.enumName };
    });
  }

  /**
   * Єдина межа динамічного делегата. `model` — з реєстру (літерал), не з вводу; args побудовані
   * білдером з whitelist. `as` ізольований і задокументований.
   */
  private async runFindMany(
    model: string,
    args: { where: unknown; include?: unknown; orderBy: unknown[]; take: number },
  ): Promise<Record<string, unknown>[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const delegate = (this.prisma as any)[model];
    if (!delegate || typeof delegate.findMany !== 'function') {
      throw new NotFoundException(
        translateError('err.reportBuilder.modelUnavailable', getLocale(), { model }),
      );
    }
    return delegate.findMany(args) as Promise<Record<string, unknown>[]>;
  }

  // ── SavedReport CRUD ──────────────────────────────────────────────────────────

  async listSaved(orgId: string) {
    return this.prisma.savedReport.findMany({
      where: { orgId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  async createSaved(
    orgId: string,
    dto: { name: string; config: FullReportConfig },
    userId?: string,
  ) {
    // dry-run: не зберігати невалідний config (кине 400 з білдера).
    buildQuery(dto.config, orgId);
    return this.prisma.savedReport.create({
      data: {
        orgId,
        name: dto.name,
        entity: dto.config.entity,
        config: dto.config as unknown as Prisma.InputJsonValue,
        createdBy: userId ?? null,
      },
    });
  }

  async getSaved(orgId: string, id: string) {
    const rep = await this.prisma.savedReport.findFirst({ where: { id, orgId, deletedAt: null } });
    if (!rep)
      throw new NotFoundException(
        translateError('err.reportBuilder.savedReportNotFound', getLocale()),
      );
    return rep;
  }

  async updateSaved(orgId: string, id: string, dto: { name?: string; config?: FullReportConfig }) {
    await this.getSaved(orgId, id); // guard-404 + tenant (id належить org, не soft-deleted)
    if (dto.config) buildQuery(dto.config, orgId); // dry-run
    // update() повертає оновлений рядок одним UPDATE...RETURNING — без окремого re-fetch
    // (getSaved вище вже підтвердив tenant+not-deleted). where МУСИТЬ нести orgId+deletedAt:null:
    // (1) A1 tenant-guard відхиляє update без tenant-токена у where (TenantIsolationError);
    // (2) захист від TOCTOU між getSaved і update (паралельний soft-delete/cross-tenant).
    return this.prisma.savedReport.update({
      where: { id, orgId, deletedAt: null },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.config
          ? {
              entity: dto.config.entity,
              config: dto.config as unknown as Prisma.InputJsonValue,
            }
          : {}),
      },
    });
  }

  async removeSaved(orgId: string, id: string) {
    await this.getSaved(orgId, id); // guard-404
    await this.prisma.savedReport.updateMany({
      where: { id, orgId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
  }

  /** Запускає збережений звіт. */
  async runSaved(orgId: string, id: string): Promise<ReportRunResult> {
    const rep = await this.getSaved(orgId, id);
    return this.run(orgId, rep.config as unknown as FullReportConfig);
  }
}
