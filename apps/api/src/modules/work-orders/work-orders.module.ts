import { Module } from '@nestjs/common';
import { WorkOrdersController } from './work-orders.controller';
import { WorkOrdersPublicController } from './work-orders-public.controller';
import { WorkOrdersService } from './work-orders.service';
import { InventoryModule } from '../inventory/inventory.module';
import { SettlementsModule } from '../settlements/settlements.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { MaintenanceSchedulesModule } from '../maintenance-schedules/maintenance-schedules.module';
import { PdfModule } from '../pdf/pdf.module';
import { DocumentNumberModule } from '../document-number/document-number.module';
import { AuditModule } from '../audit/audit.module';
import { WarrantiesModule } from '../warranties/warranties.module';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [
    InventoryModule,
    SettlementsModule,
    NotificationsModule,
    MaintenanceSchedulesModule,
    PdfModule,
    DocumentNumberModule,
    AuditModule,
    WarrantiesModule,
    SettingsModule,
  ],
  controllers: [WorkOrdersController, WorkOrdersPublicController],
  providers: [WorkOrdersService],
  exports: [WorkOrdersService],
})
export class WorkOrdersModule {}
