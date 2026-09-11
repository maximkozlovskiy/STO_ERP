import { Module } from '@nestjs/common';
import { CashService } from './cash.service';
import { AuditModule } from '../audit/audit.module';

// Рушій руху готівки (CashService.createOperation — єдина точка). HTTP-ендпоінти операцій живуть
// на CashRegistersController (щоб не дублювати базовий шлях /cash-registers). Модуль лише експортує сервіс.
@Module({
  imports: [AuditModule],
  providers: [CashService],
  exports: [CashService],
})
export class CashModule {}
