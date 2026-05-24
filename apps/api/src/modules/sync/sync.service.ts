import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncRecord } from '@sto/shared';

export { SyncRecord };

// Tables included in cloud sync pull (read-only from server perspective for most)
// Note: stock_movements is append-only and has no syncVersion — excluded from delta-sync
const PULL_TABLES = [
  'work_orders', 'work_order_lines', 'work_order_parts',
  'counterparties', 'vehicles', 'customer_garages',
  'stock_items',
  'invoices', 'payments',
  'calendar_slots',
] as const;

// Tables safe for push — excludes append-only logs and FSM-controlled models
const PUSH_SAFE_TABLES = new Set([
  'counterparties', 'vehicles', 'customer_garages',
  'calendar_slots',
]);

// Fields stripped from pull payloads to protect sensitive data sent to mobile clients
const PULL_FIELD_BLACKLIST: Record<string, Set<string>> = {
  counterparties: new Set(['phone', 'edrpou', 'email']),
};

// Per-table field whitelists for push — prevents clients from overwriting protected fields
// Note: phone, email, edrpou are intentionally excluded from counterparties — they are blacklisted
// from pull payloads and must only be writable through the authenticated web API with full validation.
const PUSH_FIELD_WHITELIST: Record<string, Set<string>> = {
  counterparties: new Set(['firstName', 'lastName', 'companyName', 'notes', 'type', 'vatPayer']),
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

          const blacklist = PULL_FIELD_BLACKLIST[table];
          return rows.map((row: Record<string, unknown>): SyncRecord => {
            const isDeleted = Boolean(row.deletedAt);
            let payload: Record<string, unknown>;
            if (isDeleted) {
              // For deleted records, only send the id — no PII in tombstone payloads
              payload = { id: row.id };
            } else {
              payload = { ...row };
              if (blacklist) for (const field of blacklist) delete payload[field];
            }
            return {
              table,
              id: row.id as string,
              operation: isDeleted ? 'DELETE' : 'UPDATE',
              syncVersion: Number(row.syncVersion),
              payload,
            };
          });
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
            payload: rec.payload as Prisma.InputJsonValue,
            status: 'FAILED',
            lastError: err instanceof Error ? err.message : 'Конфлікт під час синхронізації',
          },
        });
      }
    }

    return { accepted, conflicts };
  }

  private async applyRecord(orgId: string, rec: SyncRecord): Promise<void> {
    const model = (this.prisma as any)[toCamel(rec.table)];
    if (!model) throw new Error(`Unknown model for table: ${rec.table}`);

    const existing = await model.findFirst({
      where: { id: rec.id, orgId },
      select: { id: true, syncVersion: true, deletedAt: true },
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

    // Handle DELETE from client (soft delete)
    // counterparties and vehicles must be deleted via dedicated API endpoints that enforce business rules
    if (rec.operation === 'DELETE') {
      if (rec.table === 'counterparties' || rec.table === 'vehicles') {
        throw new Error('Видалення контрагентів та автомобілів через синхронізацію заборонено');
      }
      if (existing) {
        await model.update({ where: { id: rec.id, orgId }, data: { deletedAt: new Date() } });
      }
      return;
    }

    if (!existing) {
      // Validate FK fields belong to the same org to prevent cross-tenant injection
      await this.validateForeignKeys(orgId, rec.table, safePayload);
      await model.create({ data: { ...safePayload, id: rec.id, orgId } });
      return;
    }

    // last-write-wins by syncVersion — also validate FKs on update to prevent cross-tenant FK injection
    if (BigInt(rec.syncVersion) > existing.syncVersion) {
      await this.validateForeignKeys(orgId, rec.table, safePayload);
      await model.update({ where: { id: rec.id, orgId }, data: safePayload });
    }
  }

  // FK fields that must belong to the same org, keyed by table name
  private static readonly FK_CHECKS: Record<string, { field: string; model: string }[]> = {
    calendar_slots: [
      { field: 'liftId', model: 'lift' },
      { field: 'employeeId', model: 'employee' },
      { field: 'workOrderId', model: 'workOrder' },
    ],
    vehicles: [
      { field: 'customerGarageId', model: 'customerGarage' },
    ],
  };

  private async validateForeignKeys(orgId: string, table: string, payload: Record<string, unknown>): Promise<void> {
    const checks = SyncService.FK_CHECKS[table];
    if (!checks) return;
    await Promise.all(
      checks
        .filter(({ field }) => payload[field])
        .map(async ({ field, model }) => {
          const id = payload[field] as string;
          const record = await (this.prisma as any)[model].findFirst({ where: { id, orgId, deletedAt: null }, select: { id: true } });
          if (!record) {
            throw new Error(`Поле ${field}=${id} не знайдено в межах організації`);
          }
        }),
    );
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

    type AggResult = { _max: { syncVersion: bigint | null } };
    const maxSyncVersion = (maxVersionResults as AggResult[]).reduce((max, res) => {
      const v = Number(res?._max?.syncVersion ?? 0n);
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
