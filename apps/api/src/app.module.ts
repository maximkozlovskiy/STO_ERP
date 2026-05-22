import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
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

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.dev', '.env'],
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
  ],
})
export class AppModule {}
