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
      types.map((type) => this.searchByType(orgId, q, type, perType)),
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
    const rows = await this.prisma.$queryRaw<
      { id: string; number: string; status: string; firstName: string | null; lastName: string | null; companyName: string | null }[]
    >`
      SELECT wo.id, wo."number", wo."status",
             cp."firstName", cp."lastName", cp."companyName"
      FROM work_orders wo
      LEFT JOIN counterparties cp ON cp.id = wo."counterpartyId" AND cp."deletedAt" IS NULL
      WHERE wo."orgId" = ${orgId}::uuid
        AND wo."deletedAt" IS NULL
        AND similarity(wo."number", ${q}) > 0.1
      ORDER BY similarity(wo."number", ${q}) DESC
      LIMIT ${limit}
    `;
    return rows.map((r) => {
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
    const rows = await this.prisma.$queryRaw<
      { id: string; firstName: string | null; lastName: string | null; companyName: string | null; phone: string | null }[]
    >`
      SELECT id, "firstName", "lastName", "companyName", phone
      FROM counterparties
      WHERE "orgId" = ${orgId}::uuid
        AND "deletedAt" IS NULL
        AND (
          similarity(COALESCE("firstName", '') || ' ' || COALESCE("lastName", ''), ${q}) > 0.1
          OR similarity(COALESCE("companyName", ''), ${q}) > 0.1
          OR phone ILIKE ${'%' + q + '%'}
        )
      ORDER BY GREATEST(
        similarity(COALESCE("firstName", '') || ' ' || COALESCE("lastName", ''), ${q}),
        similarity(COALESCE("companyName", ''), ${q})
      ) DESC
      LIMIT ${limit}
    `;
    return rows.map((r) => ({
      type: 'counterparty',
      id: r.id,
      label: r.companyName ?? `${r.firstName ?? ''} ${r.lastName ?? ''}`.trim(),
      sub: r.phone ?? undefined,
    }));
  }

  private async searchGoods(orgId: string, q: string, limit: number) {
    const rows = await this.prisma.$queryRaw<
      { id: string; name: string; sku: string | null; available: number | null }[]
    >`
      SELECT g.id, g.name, g.sku,
             si.quantity - COALESCE(si."reservedQty", 0) AS available
      FROM goods g
      LEFT JOIN stock_items si ON si."goodId" = g.id AND si."deletedAt" IS NULL
      WHERE g."orgId" = ${orgId}::uuid
        AND g."deletedAt" IS NULL
        AND (
          similarity(g.name, ${q}) > 0.1
          OR g.sku ILIKE ${'%' + q + '%'}
        )
      ORDER BY similarity(g.name, ${q}) DESC
      LIMIT ${limit}
    `;
    return rows.map((r) => ({
      type: 'good',
      id: r.id,
      label: r.name,
      sub: r.sku ?? undefined,
      extra: { available: Number(r.available ?? 0) },
    }));
  }
}
