import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncRecord } from '@sto/shared';

export { SyncRecord };

// Tables included in cloud sync pull (read-only from server perspective for most)
const PULL_TABLES = [
  'work_orders', 'work_order_lines', 'work_order_parts',
  'counterparties', 'vehicles', 'customer_garages',
  'stock_items', 'stock_movements',
  'invoices', 'payments',
  'calendar_slots',
] as const;

// Tables safe for push — excludes append-only logs and FSM-controlled models
const PUSH_SAFE_TABLES = new Set([
  'counterparties', 'vehicles', 'customer_garages',
  'calendar_slots',
]);

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(private readonly prisma: PrismaService) {}

  async pull(orgId: string, since: bigint): Promise<SyncRecord[]> {
    const results = await Promise.all(
      PULL_TABLES.map(async (table) => {
        try {
          const rows = await (this.prisma as any)[toCamel(table)].findMany({
            where: { orgId, syncVersion: { gt: since } },
            take: 500,
          });

          return rows.map((row: any): SyncRecord => ({
            table,
            id: row.id,
            operation: row.deletedAt ? 'DELETE' : 'UPDATE',
            syncVersion: Number(row.syncVersion),
            payload: row,
          }));
        } catch (err) {
          this.logger.warn(`pull: skipped table ${table}: ${err}`);
          return [];
        }
      }),
    );

    const records = results.flat();
    records.sort((a, b) => a.syncVersion - b.syncVersion);
    return records;
  }

  async push(orgId: string, records: SyncRecord[]): Promise<{ accepted: number; conflicts: number }> {
    let accepted = 0;
    let conflicts = 0;

    for (const rec of records) {
      if (!PUSH_SAFE_TABLES.has(rec.table)) {
        this.logger.warn(`push: rejected write to restricted table ${rec.table} for org ${orgId}`);
        conflicts++;
        continue;
      }

      try {
        await this.applyRecord(orgId, rec);
        accepted++;
      } catch (err) {
        conflicts++;
        this.logger.error(`push: conflict on ${rec.table}/${rec.id}: ${err}`);
        await this.prisma.syncJob.create({
          data: {
            orgId,
            tableName: rec.table,
            recordId: rec.id,
            operation: rec.operation,
            syncVersion: BigInt(rec.syncVersion),
            payload: rec.payload as any,
            status: 'FAILED',
            lastError: err instanceof Error ? err.message : 'Conflict during push',
          },
        });
      }
    }

    return { accepted, conflicts };
  }

  private async applyRecord(orgId: string, rec: SyncRecord): Promise<void> {
    const model = (this.prisma as any)[toCamel(rec.table)];
    if (!model) return;

    const existing = await model.findFirst({
      where: { id: rec.id, orgId },
      select: { id: true, syncVersion: true },
    });

    // Strip orgId from payload to prevent cross-tenant injection
    const { id, orgId: _payloadOrgId, ...safePayload } = rec.payload as any;

    if (!existing) {
      await model.create({ data: { ...safePayload, id: rec.id, orgId } });
      return;
    }

    // last-write-wins by syncVersion
    if (BigInt(rec.syncVersion) > existing.syncVersion) {
      await model.update({ where: { id: rec.id }, data: safePayload });
    }
  }

  async getStatus(orgId: string): Promise<{
    pendingJobs: number;
    failedJobs: number;
    lastSyncAt: Date | null;
    maxSyncVersion: number;
  }> {
    const [pending, failed, maxVersionResult] = await Promise.all([
      this.prisma.syncJob.count({ where: { orgId, status: 'PENDING' } }),
      this.prisma.syncJob.count({ where: { orgId, status: 'FAILED' } }),
      this.prisma.$queryRaw<{ max: bigint | null }[]>`
        SELECT MAX(sync_version) as max FROM work_orders WHERE org_id = ${orgId}
      `,
    ]);

    const lastJob = await this.prisma.syncJob.findFirst({
      where: { orgId, status: 'DONE' },
      orderBy: { processedAt: 'desc' },
      select: { processedAt: true },
    });

    return {
      pendingJobs: pending,
      failedJobs: failed,
      lastSyncAt: lastJob?.processedAt ?? null,
      maxSyncVersion: Number(maxVersionResult[0]?.max ?? 0),
    };
  }
}

function toCamel(snake: string): string {
  return snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}
