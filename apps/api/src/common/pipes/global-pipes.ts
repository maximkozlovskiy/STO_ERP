import { ValidationPipe } from '@nestjs/common';
import type { PipeTransform } from '@nestjs/common';
import { RejectNulCharacterPipe } from './reject-nul-character.pipe';
import { validationExceptionFactory } from './validation-error.factory';

/**
 * Глобальні труби застосунку — одне місце для `main.ts` і HTTP-контрактних спеків, щоб спек
 * перевіряв ту саму ланку, що й прод. Порядок: спершу відсіяти NUL (інакше рядок із ним дійшов
 * би до DTO і далі в Postgres), потім валідація DTO.
 */
export function globalPipes(): PipeTransform[] {
  return [
    new RejectNulCharacterPipe(),
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: validationExceptionFactory,
    }),
  ];
}
