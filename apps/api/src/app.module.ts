import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'crypto';
import {
  CORRELATION_ID_HEADER,
  CorrelationIdMiddleware,
} from './common/middleware/correlation-id.middleware';
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
import { BrandsModule } from './modules/brands/brands.module';
import { GoodCategoriesModule } from './modules/good-categories/good-categories.module';
import { UnitsModule } from './modules/units/units.module';
import { XlsxModule } from './modules/xlsx/xlsx.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { SettlementsModule } from './modules/settlements/settlements.module';
import { WorkOrdersModule } from './modules/work-orders/work-orders.module';
import { CalendarModule } from './modules/calendar/calendar.module';
import { PurchaseOrdersModule } from './modules/purchase-orders/purchase-orders.module';
import { SupplierReturnsModule } from './modules/supplier-returns/supplier-returns.module';
import { SupplierPaymentsModule } from './modules/supplier-payments/supplier-payments.module';
import { StockDocumentsModule } from './modules/stock-documents/stock-documents.module';
import { InvoicesModule } from './modules/invoices/invoices.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { ReportsModule } from './modules/reports/reports.module';
import { FilesModule } from './modules/files/files.module';
import { SyncModule } from './modules/sync/sync.module';
import { DocumentNumberModule } from './modules/document-number/document-number.module';
import { MaintenanceSchedulesModule } from './modules/maintenance-schedules/maintenance-schedules.module';
import { CompletionActsModule } from './modules/completion-acts/completion-acts.module';
import { SearchModule } from './modules/search/search.module';
import { CommentsModule } from './modules/comments/comments.module';
import { WorkOrderTemplatesModule } from './modules/work-order-templates/work-order-templates.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { WorkOrderMediaModule } from './modules/work-order-media/work-order-media.module';
import { AuditModule } from './modules/audit/audit.module';
import { WarrantiesModule } from './modules/warranties/warranties.module';
import { LoyaltyModule } from './modules/loyalty/loyalty.module';
import { InspectionModule } from './modules/inspection/inspection.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';
import { BookingModule } from './modules/booking/booking.module';
import { CurrenciesModule } from './modules/currencies/currencies.module';
import { ExchangeRatesModule } from './modules/exchange-rates/exchange-rates.module';
import { BankAccountsModule } from './modules/bank-accounts/bank-accounts.module';
import { CashRegistersModule } from './modules/cash-registers/cash-registers.module';
import { UserPreferencesModule } from './modules/user-preferences/user-preferences.module';
import { SystemTemplatesModule } from './modules/system-templates/system-templates.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.dev', '.env'],
    }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const url = config.get<string>('REDIS_URL') ?? 'redis://localhost:6379';
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          throw new Error(
            `Invalid REDIS_URL: "${url}". Expected format: redis://[:password@]host[:port][/db]`,
          );
        }
        return {
          connection: {
            host: parsed.hostname,
            port: Number(parsed.port) || 6379,
            password: parsed.password || undefined,
            db: parsed.pathname ? Number(parsed.pathname.slice(1)) || 0 : 0,
          },
        };
      },
    }),
    // Global rate limiting: 200 req/min per IP; stricter limits on specific routes
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 200 }]),
    // Structured JSON logging via pino — production: JSON, development: pretty-print
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
        transport:
          process.env.NODE_ENV !== 'production'
            ? {
                target: 'pino-pretty',
                options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' },
              }
            : undefined,
        // Links pino's req.id to the inbound x-request-id header so logs and the
        // response header echoed by CorrelationIdMiddleware share the SAME id. Without this
        // pino-http falls back to its built-in sequential counter (1, 2, 3, ...) — making
        // correlation between an HTTP response and the JSON log impossible.
        genReqId: req => {
          const raw = (req.headers as Record<string, string | string[] | undefined>)[
            CORRELATION_ID_HEADER
          ];
          const candidate = Array.isArray(raw) ? raw[0] : raw;
          // Loose UUID/correlation-id format (printable ASCII, ≤128 chars).
          // Rejects unbounded/control-char strings that could bloat or poison logs.
          const isValid = typeof candidate === 'string' && /^[a-zA-Z0-9-_]{1,128}$/.test(candidate);
          return isValid ? candidate : randomUUID();
        },
        // Redact sensitive fields from logs (multi-tenant + secrets hygiene).
        // Bodies of /auth/* and other handlers may contain password/refresh/access tokens —
        // a future log statement that spreads req.body would otherwise leak them.
        // Include ownerPassword (setup endpoint) — same hygiene principle.
        redact: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["set-cookie"]',
          'req.body.password',
          'req.body.newPassword',
          'req.body.currentPassword',
          'req.body.refreshToken',
          'req.body.accessToken',
          'req.body.ownerPassword',
          'res.headers["set-cookie"]',
        ],
        // Skip health-check noise in logs
        autoLogging: { ignore: req => req.url === '/api/health' },
      },
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
    BrandsModule,
    GoodCategoriesModule,
    UnitsModule,
    XlsxModule,
    InventoryModule,
    SettlementsModule,
    WorkOrdersModule,
    CalendarModule,
    PurchaseOrdersModule,
    SupplierReturnsModule,
    SupplierPaymentsModule,
    StockDocumentsModule,
    InvoicesModule,
    PaymentsModule,
    NotificationsModule,
    ReportsModule,
    FilesModule,
    SyncModule,
    DocumentNumberModule,
    MaintenanceSchedulesModule,
    CompletionActsModule,
    SearchModule,
    CommentsModule,
    WorkOrderTemplatesModule,
    DashboardModule,
    WorkOrderMediaModule,
    AuditModule,
    WarrantiesModule,
    LoyaltyModule,
    InspectionModule,
    WebhooksModule,
    BookingModule,
    CurrenciesModule,
    ExchangeRatesModule,
    BankAccountsModule,
    CashRegistersModule,
    UserPreferencesModule,
    SystemTemplatesModule,
  ],
  providers: [
    // Apply ThrottlerGuard globally — routes can override with @Throttle() or @SkipThrottle()
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
