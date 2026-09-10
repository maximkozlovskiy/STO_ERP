import { Module } from '@nestjs/common';
import { WorkOrdersController } from './work-orders.controller';
import { WorkOrdersPublicController } from './work-orders-public.controller';
import { WorkOrdersService } from './work-orders.service';
import { WorkOrderStockEffectsService } from './work-order-stock-effects.service';
import { EstimateExportService } from './work-orders-export.service';
import { WorkOrderShareService } from './work-order-share.service';
import { WorkOrderEventHandlers } from './events/work-order.handlers';
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
  // A2: WorkOrderEventHandlers — @OnEvent-хендлери lifecycle-side-effects (реагують на події з
  // WorkOrdersService.transition). MaintenanceSchedulesModule/WarrantiesModule лишаються імпортовані —
  // тепер їх споживає хендлер, а не сам сервіс.
  providers: [
    WorkOrdersService,
    // A3: transaction-critical stock+settlement side-effects FSM-переходів — окремий сервіс,
    // інжектиться у WorkOrdersService.transition (внутрішня деталь, не експортується).
    WorkOrderStockEffectsService,
    EstimateExportService,
    WorkOrderShareService,
    WorkOrderEventHandlers,
  ],
  exports: [WorkOrdersService],
})
export class WorkOrdersModule {}
