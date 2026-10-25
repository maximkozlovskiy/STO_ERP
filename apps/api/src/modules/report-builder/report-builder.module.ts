import { Module } from '@nestjs/common';
import { ReportBuilderService } from './report-builder.service';
import { ReportBuilderController } from './report-builder.controller';
import { ExchangeRatesModule } from '../exchange-rates/exchange-rates.module';

@Module({
  // ExchangeRatesModule — базова валюта організації: нею стає порожня валюта документа (BR-RPT-029).
  imports: [ExchangeRatesModule],
  controllers: [ReportBuilderController],
  providers: [ReportBuilderService],
})
export class ReportBuilderModule {}
