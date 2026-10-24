import { Injectable, ExecutionContext } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

/**
 * Глобальний guard (`APP_GUARD` у `app.module.ts`) — «закрито за замовчуванням»: кожен роут
 * вимагає валідний JWT, доки його явно не позначено `@Public()`.
 *
 * Ідемпотентний: public-роут лишається публічним і коли guard працює глобально, і коли його
 * додатково вказано у `@UseGuards(JwtAuthGuard)` контролера (74 контролери лишили per-controller
 * guard, і повторний пропуск не шкодить). Для не-public роутів — звичайна поведінка `AuthGuard('jwt')`.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  override canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }
    return super.canActivate(context);
  }
}
