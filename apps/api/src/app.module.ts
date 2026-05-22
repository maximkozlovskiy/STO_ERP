import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { HealthModule } from './health/health.module';
import { AuthModule } from './auth/auth.module';
import { RedisModule } from './redis/redis.module';
import { SettingsModule } from './modules/settings/settings.module';
import { PaymentMethodsModule } from './modules/payment-methods/payment-methods.module';
import { SetupModule } from './modules/setup/setup.module';

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
  ],
})
export class AppModule {}
