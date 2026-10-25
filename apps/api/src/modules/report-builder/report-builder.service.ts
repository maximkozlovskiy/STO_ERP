import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { translateError } from '@sto/shared';
import { getLocale } from '../../common/tenant/tenant-context';
import { PrismaService } from '../../prisma/prisma.service';
import { ExchangeRatesService } from '../exchange-rates/exchange-rates.service';
import {
  REGISTRY,
  REGISTRY_ENUMS,
  getEntity,
  canBeEmpty,
  ReportEntityDef,
  type ReportFieldDef,
} from './report-registry';
import { buildQuery, ReportConfigInput } from './report-query.builder';
import { ReportResult, ReportAggInput, assertAggregations } from './report-aggregator';
import { buildConditions, type ReportConditions } from './report-condition';
import {
  assertGroupable,
  buildAggregateSql,
  buildCurrencySplitSql,
  buildMergedRowsSql,
} from './report-sql.builder';
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
  /** Сума у валюті документа: у групі з кількома валютами — розбивка `byCurrency` (BR-RPT-029). */
  inDocumentCurrency?: boolean;
}

export interface ReportRunResult {
  entity: string;
  columns: Array<{
    key: string;
    label: string;
    type: string;
    enumName?: string;
    inDocumentCurrency?: boolean;
  }>;
  /** Базова валюта організації (нею рахуються документи без валюти). */
  baseCurrency: string;
  groupBy: string[];
  /** Ефективні агрегації (явні + авто-SUM) — для рендеру заголовків/дерева. */
  aggregations: ReportAggEnriched[];
  result: ReportResult;
}

@Injectable()
export class ReportBuilderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly exchangeRates: ExchangeRatesService,
  ) {}

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
          nullable: canBeEmpty(e, f.prismaPath),
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
        ...(fld?.inDocumentCurrency && a.agg !== 'COUNT' ? { inDocumentCurrency: true } : {}),
      };
    });

    // Детальні рядки завжди (діра #5: без цього «детальний звіт» неможливий).
    const includeRows = config.includeRows ?? true;
    const { code: baseCurrency } = await this.exchangeRates.getBaseCurrency(orgId);
    const result = await this.aggregateInDb(
      orgId,
      config,
      entity,
      aggregations,
      includeRows,
      baseCurrency,
    );
    return {
      entity: entity.key,
      columns: this.expandColumns(entity, config.columns),
      baseCurrency,
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
    baseCurrency: string,
  ): Promise<ReportResult> {
    const conds = buildConditions(config, orgId, baseCurrency);
    const groupFields = assertGroupable(entity, config.groupBy);
    assertAggregations(aggregations, entity);
    const wantDetail = includeRows && config.columns.length > 0;
    const sort = config.sort?.[0] ?? null;

    if (groupFields.length === 0) {
      const [totals, split, merged] = await Promise.all([
        this.prisma.$queryRaw<Record<string, unknown>[]>(
          buildAggregateSql(conds, [], aggregations),
        ),
        this.currencySplit(conds, [], aggregations),
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
        currencySplit: split,
        baseCurrency,
      });
      const flat = assembleMergedRows(merged, config.columns, entity);
      return {
        tree: [],
        detailRows: flat.detailRows,
        grandTotals: assembled.grandTotals,
        ...(assembled.grandTotalsByCurrency
          ? { grandTotalsByCurrency: assembled.grandTotalsByCurrency }
          : {}),
        rowCount: assembled.rowCount,
        detailTruncated: flat.truncated,
        groupsTruncated: false,
        truncated: flat.truncated,
      };
    }

    const built = buildQuery(config, orgId, baseCurrency);
    const [rollup, split, detail] = await Promise.all([
      this.prisma.$queryRaw<Record<string, unknown>[]>(
        buildAggregateSql(conds, groupFields, aggregations),
      ),
      this.currencySplit(conds, groupFields, aggregations),
      wantDetail ? this.runFindMany(built.model, built.args) : Promise.resolve(null),
    ]);
    const assembled = assembleTree(rollup, groupFields, aggregations, {
      detail,
      columns: config.columns,
      entity,
      sortByAggregate: config.sortByAggregate,
      currencySplit: split,
      baseCurrency,
    });
    const detailTruncated = (detail?.length ?? 0) >= built.args.take;
    return {
      tree: assembled.tree,
      detailRows: [],
      grandTotals: assembled.grandTotals,
      ...(assembled.grandTotalsByCurrency
        ? { grandTotalsByCurrency: assembled.grandTotalsByCurrency }
        : {}),
      rowCount: assembled.rowCount,
      detailTruncated,
      groupsTruncated: assembled.groupsTruncated,
      truncated: detailTruncated || assembled.groupsTruncated,
    };
  }

  /** Розбивка агрегацій у валюті документа за валютою; null — таких агрегацій у звіті немає. */
  private async currencySplit(
    conds: ReportConditions,
    groupFields: ReportFieldDef[],
    aggregations: ReportAggInput[],
  ): Promise<Record<string, unknown>[] | null> {
    const sql = buildCurrencySplitSql(conds, groupFields, aggregations);
    return sql ? this.prisma.$queryRaw<Record<string, unknown>[]>(sql) : null;
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
      return {
        key,
        label: f?.label ?? key,
        type: f?.type ?? 'scalar',
        enumName: f?.enumName,
        ...(f?.inDocumentCurrency ? { inDocumentCurrency: true } : {}),
      };
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

  /**
   * Перевірка config перед збереженням (BR-RPT-018): побудова запиту (BR-RPT-001…005, 009, 024) і
   * `groupable` (BR-RPT-002) — той самий набір, що кидає 400 під час запуску. Без `groupable` звіт із
   * групуванням за сумою зберігався і більше ніколи не запускався.
   */
  private async dryRun(config: FullReportConfig, orgId: string): Promise<void> {
    const { code: baseCurrency } = await this.exchangeRates.getBaseCurrency(orgId);
    buildQuery(config, orgId, baseCurrency);
    const entity = getEntity(config.entity);
    assertGroupable(entity, config.groupBy ?? []);
    // BR-RPT-018 + 011: недозволена агрегація (SUM ціни тощо) — 400 вже під час збереження, а не
    // збережений звіт, що падає при кожному запуску (рішення власника 2026-10-25).
    assertAggregations(config.aggregations ?? [], entity);
  }

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
    await this.dryRun(dto.config, orgId); // не зберігати невалідний config (400)
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
    if (dto.config) await this.dryRun(dto.config, orgId);
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
