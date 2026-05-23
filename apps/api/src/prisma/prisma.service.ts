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

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await this.$connect();

    // Prisma 5 uses $extends for query middleware (replaces deprecated $use)
    // Auto-manage syncVersion: set to 1 on create, increment on every mutation
    this.$use(async (params, next) => {
      if (params.model && SYNC_VERSION_MODELS.has(params.model)) {
        if (params.action === 'create' || params.action === 'createMany') {
          // Set initial syncVersion = 1 so delta-sync clients with since=0 can retrieve it
          if (params.action === 'create') {
            params.args.data ??= {};
            if (params.args.data.syncVersion === undefined) {
              params.args.data.syncVersion = 1;
            }
          }
          // createMany: items array — set syncVersion on each if not provided
          if (params.action === 'createMany') {
            params.args.data = (params.args.data as any[]).map((item: any) => ({
              ...item,
              syncVersion: item.syncVersion ?? 1,
            }));
          }
        } else if (['update', 'upsert', 'updateMany'].includes(params.action)) {
          if (params.action === 'updateMany') {
            params.args.data ??= {};
            params.args.data.syncVersion = { increment: 1 };
          } else {
            const dataKey = params.action === 'upsert' ? 'update' : 'data';
            params.args[dataKey] ??= {};
            params.args[dataKey].syncVersion = { increment: 1 };
          }
        }
      }
      return next(params);
    });
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
