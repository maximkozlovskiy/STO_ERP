import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { TRANSACTION_TIMEOUT_MS } from '@sto/shared';
import { EncryptionService } from '../common/crypto/encryption.service';
import { withTenantGuard } from './tenant-guard.extension';
import { extendAllModels } from './extend-all-models';
import { createPgAdapter } from './pg-adapter';

// Секретні поля що шифруються at-rest (Phase 4, H-2). Ключ — модель Prisma, значення —
// список полів-секретів. Prisma-розширення шифрує їх на write і дешифрує на read. Той самий
// перелік маскує секрети в аудиті налаштувань (Bug #951): у `audit_events.diff` вони лягали б відкрито.
export const ENCRYPTED_FIELDS: Readonly<Record<string, readonly string[]>> = {
  NotificationChannelConfig: ['apiKey'],
  BranchSettings: ['smsApiKey', 'checkboxLicenseKey', 'checkboxPinCode', 'monobankToken'],
  CashShift: ['checkboxAccessToken'],
  // credentials = JSON-рядок секретів провайдера (ПРРО/еквайринг) — шифрується цілим полем.
  BranchProviderConfig: ['credentials'],
  // Підключення до API постачальників (BR-SCON): креди й кеш JWT (UTR/AD) — JSON-рядки цілим полем.
  SupplierConnection: ['credentials', 'authState'],
};

// Models that carry syncVersion — auto-incremented on every write, set to 1 on create
const SYNC_VERSION_MODELS = new Set([
  'Organisation',
  'GarageBranch',
  'Zone',
  'Lift',
  'Warehouse',
  'Employee',
  'AuthAccount',
  'Counterparty',
  'CustomerGarage',
  'Vehicle',
  'VehicleMake',
  'VehicleModel',
  'VehicleNode',
  'WorkCategory',
  'Work',
  'Good',
  'Service',
  'WorkOrder',
  'WorkOrderLine',
  'WorkOrderPart',
  'StockItem',
  'PurchaseOrder',
  'PurchaseOrderLine',
  'PurchaseList',
  'PurchaseListItem',
  'SupplierConnection',
  'SupplierOfferBatch',
  'SupplierOfferRequest',
  'SupplierOffer',
  'SupplierOrder',
  'SupplierOrderLine',
  // SupplierCatalogItem — поза списком: масовий upsert сирим SQL сам пише syncVersion (BR-SCON).
  'StockDocument',
  'StockDocumentLine',
  'Invoice',
  'CalendarSlot',
  'ReconciliationAct',
  'OrganisationSettings',
  'BranchSettings',
  'DocumentNumberConfig',
  'NotificationTemplate',
  'TaxRate',
  'PaymentMethodConfig',
  'SettlementAccount',
  // Phases 16-19 additions
  'Brand',
  'UnitOfMeasure',
  'WorkOrderTemplate',
  'Comment',
  'MaintenanceSchedule',
  'CompletionAct',
  'StockBatch',
  'PricingRule',
  'Payment',
  'SyncJob',
  'BranchProviderConfig',
  'CounterpartyStatus',
  'GoodStatus',
  'PayrollPeriod',
  'PayrollLine',
  'ExpenseCategory',
]);

// Prisma 5 requires $extends for query middleware — $use was removed in v5.
// Спільний каркас/тип хука — у extendAllModels; тут лише handler-логіка syncVersion.
function withSyncVersion(client: PrismaClient): PrismaClient {
  return extendAllModels(client, async ({ model, operation, args, query }) => {
    if (model && SYNC_VERSION_MODELS.has(model)) {
      if (operation === 'create') {
        const data = (args.data ?? {}) as Record<string, unknown>;
        if (data.syncVersion === undefined) data.syncVersion = 1;
        args = { ...args, data };
      } else if (operation === 'createMany') {
        const rows = args.data as Record<string, unknown>[];
        args = {
          ...args,
          data: rows.map(item => ({
            ...item,
            syncVersion: item.syncVersion ?? 1,
          })),
        };
      } else if (operation === 'update' || operation === 'updateMany') {
        const data = (args.data ?? {}) as Record<string, unknown>;
        data.syncVersion = { increment: 1 };
        args = { ...args, data };
      } else if (operation === 'upsert') {
        const update = (args.update ?? {}) as Record<string, unknown>;
        update.syncVersion = { increment: 1 };
        const create = (args.create ?? {}) as Record<string, unknown>;
        if (create.syncVersion === undefined) create.syncVersion = 1;
        args = { ...args, update, create };
      }
    }
    return query(args);
  });
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]);

// Шифрує секретні поля у write-payload (data/create/update): і рядок, і обгортку `{ set: рядок }`.
// null/порожнє/не-рядок пропускаємо; EncryptionService.encrypt ідемпотентний (вже-зашифроване →
// без змін), тож повторний обхід того самого payload безпечний.
function encryptWriteData(enc: EncryptionService, fields: readonly string[], data: unknown): void {
  if (!isRecord(data)) return;
  for (const f of fields) {
    const v = data[f];
    if (typeof v === 'string' && v !== '') data[f] = enc.encrypt(v);
    else if (isRecord(v) && typeof v.set === 'string' && v.set !== '') {
      data[f] = { ...v, set: enc.encrypt(v.set) };
    }
  }
}

/** Модель → (поле-зв'язок → модель цілі), з DMMF: вкладений запис іде через поле-зв'язок. */
const RELATIONS: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map(
  Prisma.dmmf.datamodel.models.map(m => [
    m.name,
    new Map(m.fields.filter(f => f.kind === 'object').map(f => [f.name, f.type])),
  ]),
);

/**
 * Шифрує секрети у write-payload моделі `model` І у вкладених записах через її зв'язки
 * (`create`, `createMany.data`, `connectOrCreate.create`, `update` / `updateMany` (`data` або
 * сам payload), `upsert.create` / `upsert.update`) — рекурсивно. Хук `$allOperations` бачить лише
 * модель верхнього рівня: `garageBranch.update({ data: { branchSettings: { update: { smsApiKey } } } })`
 * інакше писав би секрет у `branch_settings` відкритим текстом.
 */
function encryptNestedWrite(enc: EncryptionService, model: string, data: unknown): void {
  if (!isRecord(data)) return;
  const fields = ENCRYPTED_FIELDS[model];
  if (fields) encryptWriteData(enc, fields, data);
  const relations = RELATIONS.get(model);
  if (!relations) return;
  for (const [field, target] of relations) {
    const ops = data[field];
    if (!isRecord(ops)) continue;
    for (const item of asArray(ops.create)) encryptNestedWrite(enc, target, item);
    for (const item of asArray(ops.connectOrCreate)) {
      if (isRecord(item)) encryptNestedWrite(enc, target, item.create);
    }
    if (isRecord(ops.createMany)) {
      for (const row of asArray(ops.createMany.data)) encryptNestedWrite(enc, target, row);
    }
    for (const item of [...asArray(ops.update), ...asArray(ops.updateMany)]) {
      // to-one `update` — або сам payload, або `{ where, data }`; to-many — `{ where, data }`.
      // Обходимо обидва варіанти: шифрування ідемпотентне, чужих полів encryptWriteData не чіпає.
      encryptNestedWrite(enc, target, item);
      if (isRecord(item)) encryptNestedWrite(enc, target, item.data);
    }
    for (const item of asArray(ops.upsert)) {
      if (!isRecord(item)) continue;
      encryptNestedWrite(enc, target, item.create);
      encryptNestedWrite(enc, target, item.update);
    }
  }
}

/** Операції запису верхнього рівня і де в їхніх args лежить payload. */
const WRITE_PAYLOADS: Readonly<Record<string, readonly string[]>> = {
  create: ['data'],
  update: ['data'],
  updateMany: ['data'],
  updateManyAndReturn: ['data'],
  createMany: ['data'],
  createManyAndReturn: ['data'],
  upsert: ['create', 'update'],
};

// Дешифрує секретні поля у прочитаному результаті (один рядок або масив). Толерантно:
// legacy-plaintext повертається як є; null/undefined пропускаються.
function decryptReadResult(
  enc: EncryptionService,
  fields: readonly string[],
  result: unknown,
): void {
  if (result == null) return;
  const rows = Array.isArray(result) ? result : [result];
  for (const row of rows) {
    if (row == null || typeof row !== 'object') continue;
    const rec = row as Record<string, unknown>;
    for (const f of fields) {
      const v = rec[f];
      if (typeof v === 'string' && v !== '') rec[f] = enc.decryptNullable(v);
    }
  }
}

/**
 * Prisma-розширення: прозоре шифрування секретних полів at-rest (H-2).
 * Централізує encrypt-on-write / decrypt-on-read для всіх call-sites одразу
 * (включно з `...dto`-spread у settings.service.updateBranchSettings).
 */
function withFieldEncryption(client: PrismaClient, enc: EncryptionService): PrismaClient {
  // Спільний каркас/тип хука — у extendAllModels; тут лише handler-логіка шифрування.
  return extendAllModels(client, async ({ model, operation, args, query }) => {
    if (!model) return query(args);
    const fields = ENCRYPTED_FIELDS[model];

    // WRITE — шифруємо перед відправкою у БД: payload моделі і вкладені записи в моделі з
    // секретами (тому й для моделей без власних секретних полів). `createMany*` — масив
    // рядків, решта — один payload. Сирий SQL (`$executeRaw`) сюди не доходить — секрети
    // ним не пишуться.
    for (const key of WRITE_PAYLOADS[operation] ?? []) {
      for (const payload of asArray(args[key])) encryptNestedWrite(enc, model, payload);
    }

    if (!fields) return query(args);
    const result = await query(args);

    // READ — дешифруємо результат (find*/upsert/create/update/*AndReturn повертають рядок(и)).
    decryptReadResult(enc, fields, result);
    return result;
  });
}

/**
 * Augment DATABASE_URL with Prisma connection pool parameters when not already set
 * by the operator. Defaults: connection_limit=25 (Prisma docs recommend ~10 per cpu;
 * 25 покриває API під навантаженням з reports + dashboard + SSE), pool_timeout=20s
 * (запит чекає до 20s на вільне з'єднання перед throw — захист від тривалого hang).
 * Operator може перевизначити через .env (?connection_limit=...&pool_timeout=...).
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(private readonly encryption: EncryptionService) {
    // Prisma 7: підключення ЛИШЕ через driver-adapter — `datasourceUrl` і `url` у схемі
    // прибрані (P1012). Параметри пулу (connection_limit=25 / pool_timeout=20), які раніше
    // додавав withConnectionPool у query-рядок, тепер живуть у createPgAdapter.
    super({
      adapter: createPgAdapter(),
      log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
      // Тайм-аут інтерактивної транзакції за замовчуванням — для ВСІХ `$transaction(async tx => …)`,
      // а не лише тих, де виклик передав `{ timeout }` (§5). Довші — явно в місці виклику.
      transactionOptions: { timeout: TRANSACTION_TIMEOUT_MS },
    });
  }

  async onModuleInit() {
    await this.$connect();
    // Apply extensions via $extends (Prisma 5 — $use was removed).
    // A1: tenant-guard застосовується ОСТАННІМ → OUTERMOST hook (у $extends останній-застосований
    // виконується першим): судить ОРИГІНАЛЬНІ args (orgId у where/data) ДО того, як syncVersion/encryption
    // їх мутують; throw → inner-hooks не виконуються. Далі syncVersion (мутує write-args), тоді шифрування (H-2).
    Object.assign(
      this,
      withTenantGuard(withFieldEncryption(withSyncVersion(this), this.encryption)),
    );
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
