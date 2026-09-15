import { Module } from '@nestjs/common';
import { CounterpartyImportMappingsController } from './counterparty-import-mappings.controller';
import { CounterpartyImportMappingsService } from './counterparty-import-mappings.service';

@Module({
  controllers: [CounterpartyImportMappingsController],
  providers: [CounterpartyImportMappingsService],
  exports: [CounterpartyImportMappingsService],
})
export class CounterpartyImportMappingsModule {}
