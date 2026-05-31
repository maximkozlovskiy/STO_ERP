import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SearchResultItemDto } from './search.dto';

type SearchType = 'wo' | 'counterparty' | 'good';

@Injectable()
export class SearchService {
  constructor(private readonly prisma: PrismaService) {}

  async search(
    orgId: string,
    q: string,
    types: SearchType[],
    limit: number,
  ): Promise<SearchResultItemDto[]> {
    // Keep ordering deterministic: queries run in parallel for latency, but results are
    // re-emitted in the user-requested `types` order. Otherwise a slow `goods` query could
    // arrive last and be dropped by `slice(0, limit)` while `wo` results dominate.
    const perType = Math.ceil(limit / types.length);
    const buckets = await Promise.all(
      types.map(type => this.searchByType(orgId, q, type, perType)),
    );
    return buckets.flat().slice(0, limit);
  }

  private async searchByType(
    orgId: string,
    q: string,
    type: SearchType,
    limit: number,
  ): Promise<SearchResultItemDto[]> {
    switch (type) {
      case 'wo':
        return this.searchWorkOrders(orgId, q, limit);
      case 'counterparty':
        return this.searchCounterparties(orgId, q, limit);
      case 'good':
        return this.searchGoods(orgId, q, limit);
    }
  }

  private async searchWorkOrders(orgId: string, q: string, limit: number) {
    // Perf: similarity() обчислюється у WHERE І ORDER BY = 2 виклики на рядок.
    // Subquery виносить sim як column → 1 обчислення; planner може використати
    // GIN trgm index (work_orders.number) лише для filter, sort іде по pre-computed col.
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        number: string;
        status: string;
        firstName: string | null;
        lastName: string | null;
        companyName: string | null;
      }[]
    >`
      SELECT id, "number", "status", "firstName", "lastName", "companyName"
      FROM (
        SELECT wo.id, wo."number", wo."status",
               cp."firstName", cp."lastName", cp."companyName",
               similarity(wo."number", ${q}) AS sim
        FROM work_orders wo
        LEFT JOIN counterparties cp ON cp.id = wo."counterpartyId" AND cp."deletedAt" IS NULL
        WHERE wo."orgId" = ${orgId}::uuid
          AND wo."deletedAt" IS NULL
          AND wo."number" % ${q}
      ) s
      WHERE sim > 0.1
      ORDER BY sim DESC
      LIMIT ${limit}
    `;
    return rows.map(r => {
      const personName = [r.firstName, r.lastName].filter(Boolean).join(' ');
      return {
        type: 'wo',
        id: r.id,
        label: r.number,
        sub: r.companyName ?? (personName || undefined),
        extra: { status: r.status },
      };
    });
  }

  private async searchCounterparties(orgId: string, q: string, limit: number) {
    // Counterparty can be an individual (firstName + lastName) OR a company (companyName).
    // Without the companyName branch, B2B clients are invisible to the command palette.
    // Perf: similarity() рахується ОДИН раз у subquery + GREATEST() порівнюється pre-computed
    // cols, замість 4 окремих викликів similarity (2 WHERE + 2 ORDER BY).
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        firstName: string | null;
        lastName: string | null;
        companyName: string | null;
        phone: string | null;
      }[]
    >`
      SELECT id, "firstName", "lastName", "companyName", phone
      FROM (
        SELECT id, "firstName", "lastName", "companyName", phone,
               similarity(COALESCE("firstName", '') || ' ' || COALESCE("lastName", ''), ${q}) AS sim_person,
               similarity(COALESCE("companyName", ''), ${q}) AS sim_company
        FROM counterparties
        WHERE "orgId" = ${orgId}::uuid
          AND "deletedAt" IS NULL
          AND (
            COALESCE("firstName", '') || ' ' || COALESCE("lastName", '') % ${q}
            OR COALESCE("companyName", '') % ${q}
            OR phone ILIKE ${'%' + q + '%'}
          )
      ) s
      WHERE sim_person > 0.1 OR sim_company > 0.1 OR phone ILIKE ${'%' + q + '%'}
      ORDER BY GREATEST(sim_person, sim_company) DESC
      LIMIT ${limit}
    `;
    return rows.map(r => ({
      type: 'counterparty',
      id: r.id,
      label: r.companyName ?? `${r.firstName ?? ''} ${r.lastName ?? ''}`.trim(),
      sub: r.phone ?? undefined,
    }));
  }

  private async searchGoods(orgId: string, q: string, limit: number) {
    // Aggregate stock across all warehouses with SUM(quantity - reserved). Without GROUP BY,
    // a good present in multiple stock_items would multiply rows and inflate `LIMIT`.
    // The Prisma schema uses camelCase Postgres identifiers (`"reserved"`, not `"reservedQty"`),
    // so double-quoted identifiers are required — unquoted would be folded to lowercase.
    // Perf: similarity рахується тричі для name (WHERE + ORDER BY); виносимо у subquery +
    // 2-фазний join: спочатку pre-filter goods (мала вибірка), потім aggregate stock.
    const rows = await this.prisma.$queryRaw<
      { id: string; name: string; sku: string | null; available: number | null }[]
    >`
      WITH matched AS (
        SELECT g.id, g.name, g.sku, similarity(g.name, ${q}) AS sim
        FROM goods g
        WHERE g."orgId" = ${orgId}::uuid
          AND g."deletedAt" IS NULL
          AND (g.name % ${q} OR g.sku ILIKE ${'%' + q + '%'})
      )
      SELECT m.id, m.name, m.sku,
             COALESCE(SUM(si.quantity - COALESCE(si."reserved", 0)), 0) AS available
      FROM matched m
      LEFT JOIN stock_items si ON si."goodId" = m.id
        AND si."orgId" = ${orgId}::uuid
        AND si."deletedAt" IS NULL
      WHERE m.sim > 0.1 OR m.sku ILIKE ${'%' + q + '%'}
      GROUP BY m.id, m.name, m.sku, m.sim
      ORDER BY m.sim DESC
      LIMIT ${limit}
    `;
    return rows.map(r => ({
      type: 'good',
      id: r.id,
      label: r.name,
      sub: r.sku ?? undefined,
      extra: { available: Number(r.available ?? 0) },
    }));
  }
}
