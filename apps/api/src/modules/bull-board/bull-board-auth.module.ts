import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

/**
 * @Global — надає JwtService у DI-контейнер, щоб registerBullBoardGuard (main.ts) міг зробити
 * `app.get(JwtService)` для верифікації bearer-токенів на роутах bull-board. ConfigService/PrismaService
 * уже глобальні. Імпортується лише non-prod через BullBoardModule.register().
 */
@Global()
@Module({
  imports: [JwtModule.register({})],
  exports: [JwtModule],
})
export class BullBoardAuthModule {}
