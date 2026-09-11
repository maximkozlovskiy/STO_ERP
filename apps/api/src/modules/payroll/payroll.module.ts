import { Module } from '@nestjs/common';
import { PayrollController } from './payroll.controller';
import { PayrollService } from './payroll.service';
import { AuditModule } from '../audit/audit.module';
import { CashModule } from '../cash/cash.module';

@Module({
  imports: [AuditModule, CashModule], // аудит + видача ЗП готівкою (cash-out)
  controllers: [PayrollController],
  providers: [PayrollService],
  exports: [PayrollService],
})
export class PayrollModule {}
