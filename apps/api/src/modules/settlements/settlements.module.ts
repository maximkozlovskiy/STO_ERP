import { Module } from '@nestjs/common';
import { SettlementsService } from './settlements.service';
import { SettlementsAccountService } from './settlements-account.service';
import { SettlementsController } from './settlements.controller';
import { PdfModule } from '../pdf/pdf.module';
import { ExchangeRatesModule } from '../exchange-rates/exchange-rates.module';

@Module({
  imports: [PdfModule, ExchangeRatesModule],
  controllers: [SettlementsController],
  providers: [SettlementsService, SettlementsAccountService],
  exports: [SettlementsService, SettlementsAccountService],
})
export class SettlementsModule {}
