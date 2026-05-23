import { Global, Module } from '@nestjs/common';
import { DocumentNumberService } from './document-number.service';

@Global()
@Module({
  providers: [DocumentNumberService],
  exports: [DocumentNumberService],
})
export class DocumentNumberModule {}
