import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule } from '@nestjs/config';
import { DashboardService } from './dashboard.service';
import { DashboardController } from './dashboard.controller';

@Module({
  // JwtModule registered without secret — each verify() call passes its own secret.
  // JwtAuthGuard/RolesGuard are stateless and don't need DI registration here.
  imports: [JwtModule.register({}), ConfigModule],
  controllers: [DashboardController],
  providers: [DashboardService],
  exports: [DashboardService],
})
export class DashboardModule {}
