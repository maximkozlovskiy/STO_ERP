import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

// Tables that are included in cloud sync
const SYNC_TABLES = [
  'work_orders', 'work_order_lines', 'work_order_parts',
  'counterparties', 'vehicles', 'customer_garages',
  'stock_items', 'stock_movements',
  'invoices', 'payments',
  'calendar_slots',
] as const;

export interface SyncRecord {
  table: string;
  id: string;
  operation: 'INSERT' | 'UPDATE' | 'DELETE';
  syncVersion: number;
  payload: Record<string, unknown>;
}

@Injectable()
export class SyncService {
  constructor(private readonly prisma: PrismaService) {}

  async pull(orgId: string, since: bigint): Promise<SyncRecord[]> {
    const records: SyncRecord[] = [];

    for (const table of SYNC_TABLES) {
      try {
        // Dynamically query each table for records with syncVersion > since
        const rows = await (this.prisma as any)[toCamel(table)].findMany({
          where: { orgId, syncVersion: { gt: since } },
          take: 500,
        });

        for (const row of rows) {
          records.push({
            table,
            id: row.id,
            operation: row.deletedAt ? 'DELETE' : 'UPDATE',
            syncVersion: Number(row.syncVersion),
            payload: row,
          });
        }
      } catch {
        // Table might not have orgId — skip
      }
    }

    // Sort by syncVersion ascending for deterministic apply order
    records.sort((a, b) => a.syncVersion - b.syncVersion);
    return records;
  }

  async push(orgId: string, records: SyncRecord[]): Promise<{ accepted: number; conflicts: number }> {
    let accepted = 0;
    let conflicts = 0;

    for (const rec of records) {
      try {
        await this.applyRecord(orgId, rec);
        accepted++;
      } catch {
        conflicts++;
        // Log to SyncJob for manual resolution
        await this.prisma.syncJob.create({
          data: {
            orgId,
            tableName: rec.table,
            recordId: rec.id,
            operation: rec.operation,
            syncVersion: BigInt(rec.syncVersion),
            payload: rec.payload as any,
            status: 'FAILED',
            lastError: 'Conflict during push',
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

    if (!existing) {
      // INSERT
      await model.create({ data: { ...rec.payload, orgId } });
      return;
    }

    // last-write-wins by syncVersion
    if (BigInt(rec.syncVersion) > existing.syncVersion) {
      const { id, ...rest } = rec.payload;
      await model.update({ where: { id: rec.id }, data: rest });
    }
    // If remote syncVersion ≤ local — local wins, skip
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
