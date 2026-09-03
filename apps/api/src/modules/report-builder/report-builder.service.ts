import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { REGISTRY, REGISTRY_ENUMS, getEntity, ReportEntityDef } from './report-registry';
import { buildQuery, ReportConfigInput } from './report-query.builder';
import { aggregate, ReportResult, ReportAggInput } from './report-aggregator';

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
  columns: Array<{ key: string; label: string; type: string }>;
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
    const built = buildQuery(config, orgId);
    const rows = await this.runFindMany(built.model, built.args);

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

    const result = aggregate(
      rows,
      {
        groupBy: config.groupBy,
        columns: config.columns,
        aggregations,
        includeRows,
        sortByAggregate: config.sortByAggregate,
      },
      entity,
    );
    return {
      entity: entity.key,
      columns: this.expandColumns(entity, config.columns),
      groupBy: config.groupBy,
      aggregations, // ефективні (з авто-SUM) — фронт рендерить заголовки/дерево з них
      result,
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
      return { key, label: f?.label ?? key, type: f?.type ?? 'scalar' };
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
      throw new NotFoundException(`Модель ${model} недоступна`);
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
    if (!rep) throw new NotFoundException('Збережений звіт не знайдено');
    return rep;
  }

  async updateSaved(orgId: string, id: string, dto: { name?: string; config?: FullReportConfig }) {
    await this.getSaved(orgId, id); // guard-404 + tenant
    if (dto.config) buildQuery(dto.config, orgId); // dry-run
    await this.prisma.savedReport.updateMany({
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
    return this.getSaved(orgId, id);
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
