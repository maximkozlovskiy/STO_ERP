import { Global, Module } from '@nestjs/common';
import { DeadLetterService } from './dead-letter.service';
import { DeadLetterController } from './dead-letter.controller';

/**
 * @Global — 12 BullMQ-процесорів інжектять DeadLetterService у конструктор (через
 * DeadLetterWorkerHost) без імпорту цього модуля у кожен feature-модуль. PrismaService —
 * теж глобальний. Import 1× у AppModule.
 */
@Global()
@Module({
  controllers: [DeadLetterController],
  providers: [DeadLetterService],
  exports: [DeadLetterService],
})
export class DeadLetterModule {}
