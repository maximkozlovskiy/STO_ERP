import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

// Models that carry syncVersion — auto-incremented on every write, set to 1 on create
const SYNC_VERSION_MODELS = new Set([
  'Organisation', 'GarageBranch', 'Zone', 'Lift', 'Warehouse',
  'Employee', 'Counterparty', 'CustomerGarage', 'Vehicle', 'VehicleNode',
  'WorkCategory', 'Work', 'Good', 'Service',
  'WorkOrder', 'WorkOrderLine', 'WorkOrderPart',
  'StockItem', 'PurchaseOrder', 'PurchaseOrderLine',
  'StockDocument', 'StockDocumentLine',
  'Invoice', 'CalendarSlot',
  'OrganisationSettings', 'BranchSettings', 'DocumentNumberConfig',
  'NotificationTemplate', 'TaxRate', 'PaymentMethodConfig',
]);

// Prisma 5 requires $extends for query middleware — $use was removed in v5
function withSyncVersion(client: PrismaClient): PrismaClient {
  return client.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }: {
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

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await this.$connect();
    // Apply syncVersion middleware via $extends (Prisma 5 — $use was removed)
    Object.assign(this, withSyncVersion(this));
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
