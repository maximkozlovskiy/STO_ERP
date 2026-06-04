import { Module } from '@nestjs/common';
import { ExchangeRatesModule } from '../exchange-rates/exchange-rates.module';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';

@Module({
  imports: [ExchangeRatesModule],
  controllers: [SettingsController],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
