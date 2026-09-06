import { Global, Module } from '@nestjs/common';
import { EncryptionService } from './encryption.service';

/**
 * Глобальний модуль шифрування — EncryptionService доступний у будь-якому провайдері
 * без повторного імпорту (як ConfigModule). Використовується Prisma-розширенням і
 * point-of-use сервісами (notifications, checkbox/ПРРО).
 */
@Global()
@Module({
  providers: [EncryptionService],
  exports: [EncryptionService],
})
export class CryptoModule {}
