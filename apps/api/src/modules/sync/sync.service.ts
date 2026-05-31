import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncRecord } from '@sto/shared';

// Minimal interface for the dynamic Prisma model operations used in sync
interface DynamicPrismaModel {
  findMany(args: {
    where: Record<string, unknown>;
    take?: number;
  }): Promise<Record<string, unknown>[]>;
  findFirst(args: {
    where: Record<string, unknown>;
    select?: Record<string, boolean>;
  }): Promise<Record<string, unknown> | null>;
  create(args: { data: Record<string, unknown> }): Promise<Record<string, unknown>>;
  update(args: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }): Promise<Record<string, unknown>>;
  aggregate(args: {
    where: Record<string, unknown>;
    _max: Record<string, boolean>;
  }): Promise<{ _max: Record<string, unknown> }>;
}

export { SyncRecord };

// Tables included in cloud sync pull (read-only from server perspective for most)
// Note: stock_movements is append-only and has no syncVersion — excluded from delta-sync
// Note: batch_consumptions and price_history are append-only (no syncVersion) — excluded
const PULL_TABLES = [
  'work_orders',
  'work_order_lines',
  'work_order_parts',
  'counterparties',
  'vehicles',
  'customer_garages',
  'stock_items',
  'stock_batches',
  'invoices',
  'payments',
  'calendar_slots',
  'maintenance_schedules',
  'completion_acts',
  'pricing_rules',
  // B3: warranties — mobile mechanics need to see which work is under warranty
  'warranties',
] as const;

// Tables safe for push — excludes append-only logs and FSM-controlled models
const PUSH_SAFE_TABLES = new Set([
  'counterparties',
  'vehicles',
  'customer_garages',
  'calendar_slots',
]);

// Bug #127: Prisma client exposes models in SINGULAR camelCase form (e.g. `prisma.workOrder`),
// while Postgres tables (via `@@map`) are PLURAL. A naive `snake_to_camel` of the table name
// produces a plural identifier (`workOrders`) which is `undefined` on PrismaClient, causing
// `TypeError: Cannot read properties of undefined` at `getStatus` (the `.catch` only catches
// the aggregate promise rejection, not the synchronous property access). Pull/push were also
// affected but the try/catch silently swallowed every table — making the bug invisible.
// Keep this map in sync with `PULL_TABLES` and any new tables added to sync.
const TABLE_TO_MODEL: Record<string, string> = {
  work_orders: 'workOrder',
  work_order_lines: 'workOrderLine',
  work_order_parts: 'workOrderPart',
  counterparties: 'counterparty',
  vehicles: 'vehicle',
  customer_garages: 'customerGarage',
  stock_items: 'stockItem',
  stock_batches: 'stockBatch',
  invoices: 'invoice',
  payments: 'payment',
  calendar_slots: 'calendarSlot',
  maintenance_schedules: 'maintenanceSchedule',
  completion_acts: 'completionAct',
  pricing_rules: 'pricingRule',
  warranties: 'warranty',
};

// Fields stripped from pull payloads to protect sensitive data sent to mobile clients
const PULL_FIELD_BLACKLIST: Record<string, Set<string>> = {
  counterparties: new Set(['phone', 'edrpou', 'email']),
};

// Per-table field whitelists for push — prevents clients from overwriting protected fields
// Note: phone, email, edrpou are intentionally excluded from counterparties — they are blacklisted
// from pull payloads and must only be writable through the authenticated web API with full validation.
const PUSH_FIELD_WHITELIST: Record<string, Set<string>> = {
  counterparties: new Set(['firstName', 'lastName', 'companyName', 'notes', 'type', 'vatPayer']),
  vehicles: new Set([
    'licensePlate',
    'make',
    'model',
    'year',
    'vin',
    'engineVolume',
    'fuelType',
    'currentMileage',
    'color',
    'notes',
    'customerGarageId',
  ]),
  customer_garages: new Set(['name', 'address', 'notes']),
  calendar_slots: new Set(['liftId', 'employeeId', 'workOrderId', 'startAt', 'endAt', 'notes']),
};

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(private readonly prisma: PrismaService) {}

  private model(tableName: string): DynamicPrismaModel {
    // First, try the explicit table → singular-camelCase map (covers all PULL_TABLES).
    // Fall back to naive camel conversion so that direct calls with already-camelCase
    // model names (e.g. `validateForeignKeys` passing 'lift', 'employee', 'workOrder',
    // 'customerGarage') continue to work without an additional map.
    const mapped = TABLE_TO_MODEL[tableName] ?? toCamel(tableName);
    const model = (this.prisma as unknown as Record<string, DynamicPrismaModel>)[mapped];
    if (!model) {
      throw new Error(`Невідома модель Prisma для таблиці: ${tableName}`);
    }
    return model;
  }

  async pull(orgId: string, since: bigint): Promise<SyncRecord[]> {
    const results = await Promise.all(
      PULL_TABLES.map(async table => {
        try {
          const rows = await this.model(table).findMany({
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
              // Bug #128: Prisma rows contain BigInt `syncVersion` (and Decimal fields).
              // Both crash `JSON.stringify` and trigger a 500. Normalise each value:
              // BigInt → number (sync version fits in 2^53 for decades), Decimal → number.
              payload = {};
              for (const [k, v] of Object.entries(row)) {
                if (blacklist?.has(k)) continue;
                if (typeof v === 'bigint') {
                  payload[k] = Number(v);
                } else if (
                  v !== null &&
                  typeof v === 'object' &&
                  'toNumber' in (v as object) &&
                  typeof (v as { toNumber?: unknown }).toNumber === 'function'
                ) {
                  // Prisma.Decimal
                  payload[k] = (v as { toNumber: () => number }).toNumber();
                } else {
                  payload[k] = v;
                }
              }
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

  async push(
    orgId: string,
    records: SyncRecord[],
  ): Promise<{ accepted: number; conflicts: number }> {
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
    const model = this.model(rec.table);
    if (!model) throw new Error(`Unknown model for table: ${rec.table}`);

    const existing = await model.findFirst({
      where: { id: rec.id, orgId },
      select: { id: true, syncVersion: true, deletedAt: true, workOrderId: true },
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
      // calendar_slots with an active work order must not be deleted via sync
      // — the operator must cancel the slot through the proper API
      if (rec.table === 'calendar_slots' && existing) {
        const slot = existing as Record<string, unknown>;
        if (slot.workOrderId) {
          throw new Error("Видалення слоту з прив'язаним нарядом через синхронізацію заборонено");
        }
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
    if (
      BigInt(rec.syncVersion) >
      BigInt((existing as { syncVersion: bigint | number | string }).syncVersion ?? 0)
    ) {
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
    vehicles: [{ field: 'customerGarageId', model: 'customerGarage' }],
  };

  private async validateForeignKeys(
    orgId: string,
    table: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const checks = SyncService.FK_CHECKS[table];
    if (!checks) return;
    await Promise.all(
      checks
        .filter(({ field }) => payload[field])
        .map(async ({ field, model }) => {
          const id = payload[field] as string;
          const record = await this.model(model).findFirst({
            where: { id, orgId, deletedAt: null },
            select: { id: true },
          });
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
    // lastJob fetch is independent of count/aggregate queries — merge into single Promise.all
    // to collapse 2 sequential round-trips into one. PULL_TABLES.length + 3 queries run in parallel.
    const [pending, failed, lastJob, ...maxVersionResults] = await Promise.all([
      this.prisma.syncJob.count({ where: { orgId, status: 'PENDING' } }),
      this.prisma.syncJob.count({ where: { orgId, status: 'FAILED' } }),
      this.prisma.syncJob.findFirst({
        where: { orgId, status: 'DONE' },
        orderBy: { processedAt: 'desc' },
        select: { processedAt: true },
      }),
      // Query max syncVersion across all pull tables to give clients a correct since cursor
      ...PULL_TABLES.map(table =>
        this.model(table)
          .aggregate({
            where: { orgId },
            _max: { syncVersion: true },
          })
          .catch(() => ({ _max: { syncVersion: null } })),
      ),
    ]);

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
