import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bull';
import { PrismaModule } from './prisma/prisma.module';
import { HealthModule } from './health/health.module';
import { AuthModule } from './auth/auth.module';
import { RedisModule } from './redis/redis.module';
import { SettingsModule } from './modules/settings/settings.module';
import { PaymentMethodsModule } from './modules/payment-methods/payment-methods.module';
import { SetupModule } from './modules/setup/setup.module';
import { BranchesModule } from './modules/branches/branches.module';
import { ZonesModule } from './modules/zones/zones.module';
import { WarehousesModule } from './modules/warehouses/warehouses.module';
import { WorkCategoriesModule } from './modules/work-categories/work-categories.module';
import { EmployeesModule } from './modules/employees/employees.module';
import { CounterpartiesModule } from './modules/counterparties/counterparties.module';
import { VehiclesModule } from './modules/vehicles/vehicles.module';
import { WorksModule } from './modules/works/works.module';
import { GoodsModule } from './modules/goods/goods.module';
import { ServicesModule } from './modules/services/services.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { SettlementsModule } from './modules/settlements/settlements.module';
import { WorkOrdersModule } from './modules/work-orders/work-orders.module';
import { CalendarModule } from './modules/calendar/calendar.module';
import { PurchaseOrdersModule } from './modules/purchase-orders/purchase-orders.module';
import { StockDocumentsModule } from './modules/stock-documents/stock-documents.module';
import { InvoicesModule } from './modules/invoices/invoices.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { ReportsModule } from './modules/reports/reports.module';
import { FilesModule } from './modules/files/files.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.dev', '.env'],
    }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        redis: config.get<string>('REDIS_URL') ?? 'redis://localhost:6379',
      }),
    }),
    PrismaModule,
    RedisModule,
    HealthModule,
    AuthModule,
    SettingsModule,
    PaymentMethodsModule,
    SetupModule,
    BranchesModule,
    ZonesModule,
    WarehousesModule,
    WorkCategoriesModule,
    EmployeesModule,
    CounterpartiesModule,
    VehiclesModule,
    WorksModule,
    GoodsModule,
    ServicesModule,
    InventoryModule,
    SettlementsModule,
    WorkOrdersModule,
    CalendarModule,
    PurchaseOrdersModule,
    StockDocumentsModule,
    InvoicesModule,
    PaymentsModule,
    NotificationsModule,
    ReportsModule,
    FilesModule,
  ],
})
export class AppModule {}
