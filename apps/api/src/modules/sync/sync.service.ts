import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncRecord, translateError } from '@sto/shared';
import { getLocale } from '../../common/tenant/tenant-context';
import {
  canWriteCalendar,
  findMechanicOnLift,
  MECHANIC_REJECT_KEY,
} from '../calendar/calendar-mechanic';
import { WorkOrdersService } from '../work-orders/work-orders.service';
import { movesWorkOrderSlot } from '../work-orders/work-order-slot-move';
import type { CalendarSlotEdit } from '../calendar/calendar.dto';

// Minimal interface for the dynamic Prisma model operations used in sync
interface DynamicPrismaModel {
  findMany(args: {
    where: Record<string, unknown>;
    orderBy?: Record<string, 'asc' | 'desc'>;
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

// Явно ВИКЛЮЧЕНІ з sync (не додавати до PULL_TABLES/PUSH_SAFE_TABLES):
//  - notification_channel_configs: містить apiKey провайдера (секрет) — mobile не має бачити.
//  - notification_logs: append-only журнал + phone (PII); мобільним клієнтам не потрібен.
//  - branch_settings: smsApiKey (секрет).
//  - branch_provider_configs: credentials (секрети ПРРО/еквайринг-провайдерів) — mobile не має бачити.
//  - integration_logs / idempotency_keys / dead_letter_jobs: server-local infra (без syncVersion) —
//    не sync-иться (dead_letter_jobs містить payload вичерпаних job-ів; лишається на сервері).
//  - bank_transactions: staging вхідних банк-виписок (payerName/payerIban/purpose — PII платника);
//    серверна реконсиляція, mobile не потрібна. Має syncVersion для консистентності, але свідомо
//    поза PULL_TABLES/PUSH_SAFE_TABLES.
//  - purchase_lists / purchase_list_items: закупівля (етап 1, BR-PL-*) — робота в web; мобільному
//    клієнтові механіка не потрібна. Мають syncVersion, але свідомо поза PULL_TABLES/PUSH_SAFE_TABLES.
//  - supplier_* (підключення до API постачальників, пропозиції, дзеркало каталогу, замовлення через API):
//    креди постачальників і серверні дані черг — mobile не має бачити (BR-SCON).

// Tables safe for push — excludes append-only logs and FSM-controlled models
const PUSH_SAFE_TABLES = new Set([
  'counterparties',
  'vehicles',
  'customer_garages',
  'calendar_slots',
]);

// Prisma client exposes models in SINGULAR camelCase (e.g. `prisma.workOrder`),
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
  // shareToken — секрет (дає публічний read-доступ до кошторису). Mobile devices
  // не повинні мати до нього доступу через sync (їм нема для чого).
  work_orders: new Set(['shareToken']),
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

  constructor(
    private readonly prisma: PrismaService,
    private readonly workOrders: WorkOrdersService,
  ) {}

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
          // orderBy syncVersion asc — детермінований порядок для делта-курсора. Без нього при
          // >500 змінених рядків Postgres віддає ДОВІЛЬНІ 500, клієнт просуває курсор до max
          // отриманого syncVersion → рядки з меншим syncVersion, що не потрапили у вибірку,
          // більше ніколи не витягуються (тиха втрата даних). Із ordering клієнт бере наступну
          // сторінку через since = останній отриманий syncVersion.
          const rows = await this.model(table).findMany({
            where: { orgId, syncVersion: { gt: since } },
            orderBy: { syncVersion: 'asc' },
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
              // Prisma rows contain BigInt `syncVersion` (and Decimal fields).
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
                  'toNumber' in v &&
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

  /**
   * `role` — роль того, хто синхронізує: записи календаря змінюють лише ролі BR-CAL-010.
   * Відмова — як будь-який конфлікт синхронізації: `conflicts + 1` і `SyncJob` FAILED з причиною.
   */
  async push(
    orgId: string,
    records: SyncRecord[],
    role: string,
    userId?: string,
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
        await this.applyRecord(orgId, rec, role, userId);
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

  private async applyRecord(
    orgId: string,
    rec: SyncRecord,
    role: string,
    userId?: string,
  ): Promise<void> {
    const model = this.model(rec.table);
    if (!model) throw new Error(`Unknown model for table: ${rec.table}`);

    const isSlot = rec.table === 'calendar_slots';
    // BR-CAL-010: записи календаря змінюють лише власник, адміністратор і приймальня — і з
    // планшета теж, будь-якою операцією.
    if (isSlot && !canWriteCalendar(role)) {
      throw new Error(translateError('err.calendar.syncRoleForbidden', getLocale()));
    }

    // Колонки запису календаря — лише для `calendar_slots`: у контрагента, авто й гаража їх
    // немає, і Prisma відхилила б `select` невідомого поля (кожен push цих таблиць падав би).
    const existing = await model.findFirst({
      where: { id: rec.id, orgId },
      select: {
        id: true,
        syncVersion: true,
        deletedAt: true,
        ...(isSlot && {
          workOrderId: true,
          liftId: true,
          employeeId: true,
          startAt: true,
          endAt: true,
        }),
      },
    });

    // Strip protected fields — only allow whitelisted fields through
    const whitelist = PUSH_FIELD_WHITELIST[rec.table];
    const rawPayload = rec.payload;
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
        const slot = existing;
        if (slot.workOrderId) {
          throw new Error("Видалення слоту з прив'язаним нарядом через синхронізацію заборонено");
        }
      }
      if (existing) {
        // LWW for tombstones too: a DELETE that arrives out of order (older
        // syncVersion than what the server already has) must NOT clobber a newer
        // server-side edit — otherwise a stale mobile delete silently erases data
        // the operator changed on the web afterwards. Apply the soft-delete only
        // when the incoming version is strictly newer.
        const existingVersion = BigInt(
          (existing as { syncVersion?: bigint | number | string }).syncVersion ?? 0,
        );
        if (BigInt(rec.syncVersion) > existingVersion) {
          await model.update({ where: { id: rec.id, orgId }, data: { deletedAt: new Date() } });
        }
      }
      return;
    }

    if (!existing) {
      // Validate FK fields belong to the same org to prevent cross-tenant injection
      await this.validateForeignKeys(orgId, rec.table, safePayload);
      if (isSlot) await this.assertSlotMechanic(orgId, safePayload, null);
      await model.create({ data: { ...safePayload, id: rec.id, orgId } });
      return;
    }

    // A4: Vehicle mileage — MONOTONIC (max-wins), не LWW (ADR-006 §74). Пробіг лічильника лише
    // зростає; offline-планшет зі СТАРИМ показником не має відкотити його назад, навіть якщо
    // виграє LWW за іншими полями. Обчислюємо max ПЕРЕД LWW-гейтом і застосовуємо в ОБОХ гілках:
    //   - LWW-winner → пишемо max замість вхідного currentMileage;
    //   - LWW-loser з БІЛЬШИМ пробігом → окремий targeted-update лише mileage (інакше «загубився б»).
    let mileageToWrite: number | undefined;
    if (rec.table === 'vehicles' && 'currentMileage' in safePayload) {
      const incoming = Number(safePayload.currentMileage ?? 0);
      const current = await this.getVehicleMileage(orgId, rec.id);
      mileageToWrite = Math.max(incoming, current);
    }

    // last-write-wins by syncVersion — also validate FKs on update to prevent cross-tenant FK injection
    if (
      BigInt(rec.syncVersion) >
      BigInt((existing as { syncVersion: bigint | number | string }).syncVersion ?? 0)
    ) {
      await this.validateForeignKeys(orgId, rec.table, safePayload);
      // BR-WO-024: новий час чи підйомник запису наряду змінює наряд — тим самим шляхом, що й
      // `PATCH /calendar/slots/:id` (перевірки збереження наряду; відмова — конфлікт із причиною).
      const edit = isSlot ? slotEdit(safePayload) : null;
      if (edit && movesWorkOrderSlot(slotState(existing), edit)) {
        await this.workOrders.updateCalendarSlot(orgId, rec.id, edit, userId);
        return;
      }
      if (isSlot) await this.assertSlotMechanic(orgId, safePayload, existing);
      const data =
        mileageToWrite !== undefined
          ? { ...safePayload, currentMileage: mileageToWrite }
          : safePayload;
      await model.update({ where: { id: rec.id, orgId }, data });
    } else if (mileageToWrite !== undefined) {
      // LWW програв, АЛЕ пробіг більший за поточний → пишемо лише mileage (монотонність).
      const current = await this.getVehicleMileage(orgId, rec.id);
      if (mileageToWrite > current) {
        await model.update({
          where: { id: rec.id, orgId },
          data: { currentMileage: mileageToWrite },
        });
      }
    }
  }

  /**
   * BR-CAL-012 для запису календаря з планшета — та сама перевірка, що в `CalendarService`:
   * механік запису активний (не звільнений, не у відпустці) MECHANIC організації, закріплений за
   * підйомником запису. Як і в API, перевіряє лише новий запис або зміну механіка чи підйомника:
   * збережений механік, якого відтоді відкріпили, не блокує зміну часу чи нотаток.
   */
  private async assertSlotMechanic(
    orgId: string,
    payload: Record<string, unknown>,
    existing: Record<string, unknown> | null,
  ): Promise<void> {
    const pick = (field: 'employeeId' | 'liftId'): string | null => {
      const value = field in payload ? payload[field] : existing?.[field];
      return typeof value === 'string' && value ? value : null;
    };
    const employeeId = pick('employeeId');
    if (!employeeId) return;
    const liftId = pick('liftId');
    const changed =
      !existing ||
      employeeId !== (existing.employeeId ?? null) ||
      liftId !== (existing.liftId ?? null);
    if (!changed) return;
    const mechanic = await findMechanicOnLift(this.prisma, orgId, employeeId, liftId);
    if (!mechanic.ok) {
      // Та сама причина, що й у 400 API: «у відпустці» окремо від «не закріплений».
      throw new Error(translateError(MECHANIC_REJECT_KEY[mechanic.reason], getLocale()));
    }
  }

  /** Поточний пробіг авто (для монотонного mileage max-wins). 0 якщо null/не знайдено. */
  private async getVehicleMileage(orgId: string, id: string): Promise<number> {
    const v = await this.prisma.vehicle.findFirst({
      where: { id, orgId },
      select: { currentMileage: true },
    });
    return Number(v?.currentMileage ?? 0);
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
          const isWorkOrder = model === 'workOrder';
          const record = (await this.model(model).findFirst({
            where: { id, orgId, deletedAt: null },
            select: { id: true, ...(isWorkOrder && { status: true }) },
          })) as { id: string; status?: string } | null;
          if (!record) {
            throw new Error(`Поле ${field}=${id} не знайдено в межах організації`);
          }
          // BR-WO-022: запис календаря не прив'язується до скасованого наряду — так само, як
          // `CalendarService.createSlot/updateSlot`. Живий запис скасованого наряду ніде не
          // показується, але EXCLUDE `calendar_slots_no_overlap` його бачить — невидимий тримач
          // підйомника (409 на вільному з вигляду часі).
          if (isWorkOrder && record.status === 'CANCELLED') {
            throw new Error(translateError('err.calendar.workOrderCancelled', getLocale()));
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

/** Збережений запис календаря з вибірки `applyRecord` — для порівняння зі зміною (BR-WO-024). */
function slotState(row: Record<string, unknown>) {
  const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
  return {
    workOrderId: str(row.workOrderId),
    liftId: str(row.liftId),
    startAt: new Date(row.startAt as Date),
    endAt: new Date(row.endAt as Date),
  };
}

/**
 * Поля запису календаря з планшета (уже з білого списку) — у формі зміни запису API. Невалідна
 * дата лишається рядком: її відхиляє перевірка зміни з перекладеною причиною, а не `RangeError`.
 */
function slotEdit(payload: Record<string, unknown>): CalendarSlotEdit {
  const ref = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
  const edit: CalendarSlotEdit = {};
  if ('liftId' in payload) edit.liftId = ref(payload.liftId);
  if ('employeeId' in payload) edit.employeeId = ref(payload.employeeId);
  if ('workOrderId' in payload) edit.workOrderId = ref(payload.workOrderId);
  for (const key of ['startAt', 'endAt'] as const) {
    const v = payload[key];
    if (v == null) continue;
    const d = new Date(v as string | number | Date);
    if (!Number.isNaN(d.getTime())) edit[key] = d.toISOString();
    else edit[key] = typeof v === 'string' ? v : '';
  }
  if ('notes' in payload) edit.notes = typeof payload.notes === 'string' ? payload.notes : null;
  return edit;
}

function toCamel(snake: string): string {
  return snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}
