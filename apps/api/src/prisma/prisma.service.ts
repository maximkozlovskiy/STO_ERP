import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { EncryptionService } from '../common/crypto/encryption.service';

// Секретні поля що шифруються at-rest (Phase 4, H-2). Ключ — модель Prisma, значення —
// список полів-секретів. Prisma-розширення шифрує їх на write і дешифрує на read.
const ENCRYPTED_FIELDS: Record<string, string[]> = {
  NotificationChannelConfig: ['apiKey'],
  BranchSettings: ['smsApiKey', 'checkboxLicenseKey', 'checkboxPinCode'],
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
]);

// Prisma 5 requires $extends for query middleware — $use was removed in v5
function withSyncVersion(client: PrismaClient): PrismaClient {
  return client.$extends({
    query: {
      $allModels: {
        async $allOperations({
          model,
          operation,
          args,
          query,
        }: {
          model?: string;
          operation: string;
          args: Record<string, unknown>;
          query: (args: Record<string, unknown>) => Promise<unknown>;
        }) {
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
            } else if (operation === 'update') {
              const data = (args.data ?? {}) as Record<string, unknown>;
              data.syncVersion = { increment: 1 };
              args = { ...args, data };
            } else if (operation === 'updateMany') {
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
        },
      },
    },
  }) as unknown as PrismaClient;
}

// Шифрує секретні поля у write-payload (data/create/update). Значення {increment}/null/не-string
// пропускаємо; EncryptionService.encrypt ідемпотентний (вже-зашифроване → без змін).
function encryptWriteData(
  enc: EncryptionService,
  fields: string[],
  data: Record<string, unknown> | undefined,
): void {
  if (!data) return;
  for (const f of fields) {
    const v = data[f];
    if (typeof v === 'string' && v !== '') data[f] = enc.encrypt(v);
  }
}

// Дешифрує секретні поля у прочитаному результаті (один рядок або масив). Толерантно:
// legacy-plaintext повертається як є; null/undefined пропускаються.
function decryptReadResult(enc: EncryptionService, fields: string[], result: unknown): void {
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
  return client.$extends({
    query: {
      $allModels: {
        async $allOperations({
          model,
          operation,
          args,
          query,
        }: {
          model?: string;
          operation: string;
          args: Record<string, unknown>;
          query: (args: Record<string, unknown>) => Promise<unknown>;
        }) {
          const fields = model ? ENCRYPTED_FIELDS[model] : undefined;
          if (!fields) return query(args);

          // WRITE — шифруємо перед відправкою у БД.
          if (operation === 'create' || operation === 'update') {
            encryptWriteData(enc, fields, args.data as Record<string, unknown> | undefined);
          } else if (operation === 'createMany') {
            const rows = args.data as Record<string, unknown>[] | undefined;
            if (Array.isArray(rows)) rows.forEach(r => encryptWriteData(enc, fields, r));
          } else if (operation === 'updateMany') {
            encryptWriteData(enc, fields, args.data as Record<string, unknown> | undefined);
          } else if (operation === 'upsert') {
            encryptWriteData(enc, fields, args.create as Record<string, unknown> | undefined);
            encryptWriteData(enc, fields, args.update as Record<string, unknown> | undefined);
          }

          const result = await query(args);

          // READ — дешифруємо результат (find*/upsert/create/update повертають рядок(и)).
          decryptReadResult(enc, fields, result);
          return result;
        },
      },
    },
  }) as unknown as PrismaClient;
}

/**
 * Augment DATABASE_URL with Prisma connection pool parameters when not already set
 * by the operator. Defaults: connection_limit=25 (Prisma docs recommend ~10 per cpu;
 * 25 покриває API під навантаженням з reports + dashboard + SSE), pool_timeout=20s
 * (запит чекає до 20s на вільне з'єднання перед throw — захист від тривалого hang).
 * Operator може перевизначити через .env (?connection_limit=...&pool_timeout=...).
 */
function withConnectionPool(url: string | undefined): string | undefined {
  if (!url) return url;
  const params = new URL(url);
  if (!params.searchParams.has('connection_limit')) {
    params.searchParams.set('connection_limit', '25');
  }
  if (!params.searchParams.has('pool_timeout')) {
    params.searchParams.set('pool_timeout', '20');
  }
  return params.toString();
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(private readonly encryption: EncryptionService) {
    super({
      datasourceUrl: withConnectionPool(process.env.DATABASE_URL),
      log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
    });
  }

  async onModuleInit() {
    await this.$connect();
    // Apply extensions via $extends (Prisma 5 — $use was removed).
    // syncVersion спершу (мутує write-args), потім шифрування секретних полів (H-2).
    Object.assign(this, withFieldEncryption(withSyncVersion(this), this.encryption));
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
