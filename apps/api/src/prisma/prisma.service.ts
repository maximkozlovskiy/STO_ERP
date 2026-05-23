import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

// Models that carry syncVersion and need it auto-incremented on every write
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

    // Auto-increment syncVersion on every mutating operation
    this.$use(async (params, next) => {
      if (
        params.model &&
        SYNC_VERSION_MODELS.has(params.model) &&
        ['update', 'upsert', 'updateMany'].includes(params.action)
      ) {
        if (params.action === 'updateMany') {
          params.args.data ??= {};
          params.args.data.syncVersion = { increment: 1 };
        } else {
          // update / upsert
          const dataKey = params.action === 'upsert' ? 'update' : 'data';
          params.args[dataKey] ??= {};
          params.args[dataKey].syncVersion = { increment: 1 };
        }
      }
      return next(params);
    });
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
