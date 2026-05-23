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

// Per-table field whitelists for push — prevents clients from overwriting protected fields
const PUSH_FIELD_WHITELIST: Record<string, Set<string>> = {
  counterparties: new Set(['firstName', 'lastName', 'companyName', 'phone', 'email', 'notes', 'type', 'vatPayer', 'edrpou']),
  vehicles: new Set(['licensePlate', 'make', 'model', 'year', 'vin', 'engineVolume', 'fuelType', 'currentMileage', 'color', 'notes', 'customerGarageId']),
  customer_garages: new Set(['name', 'address', 'notes']),
  calendar_slots: new Set(['liftId', 'employeeId', 'workOrderId', 'startAt', 'endAt', 'notes']),
};

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

    // Strip protected fields — only allow whitelisted fields through
    const whitelist = PUSH_FIELD_WHITELIST[rec.table];
    const rawPayload = rec.payload as Record<string, unknown>;
    const safePayload: Record<string, unknown> = {};
    if (whitelist) {
      for (const key of whitelist) {
        if (key in rawPayload) safePayload[key] = rawPayload[key];
      }
    }

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
    const [pending, failed, ...maxVersionResults] = await Promise.all([
      this.prisma.syncJob.count({ where: { orgId, status: 'PENDING' } }),
      this.prisma.syncJob.count({ where: { orgId, status: 'FAILED' } }),
      // Query max syncVersion across all pull tables to give clients a correct since cursor
      ...PULL_TABLES.map(table =>
        (this.prisma as any)[toCamel(table)].aggregate({
          where: { orgId },
          _max: { syncVersion: true },
        }).catch(() => ({ _max: { syncVersion: null } }))
      ),
    ]);

    const lastJob = await this.prisma.syncJob.findFirst({
      where: { orgId, status: 'DONE' },
      orderBy: { processedAt: 'desc' },
      select: { processedAt: true },
    });

    const maxSyncVersion = maxVersionResults.reduce((max: number, res: any) => {
      const v = Number(res?._max?.syncVersion ?? 0);
      return v > max ? v : max;
    }, 0);

    return {
      pendingJobs: pending,
      failedJobs: failed,
      lastSyncAt: lastJob?.processedAt ?? null,
      maxSyncVersion,
    };
  }
}

function toCamel(snake: string): string {
  return snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}
