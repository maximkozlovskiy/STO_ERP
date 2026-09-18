import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { translateError } from '@sto/shared';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { getLocale } from '../../common/tenant/tenant-context';
import type { AuthenticatedUser } from '../strategies/jwt.strategy';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);

    if (!required || required.length === 0) return true;

    const request = ctx.switchToHttp().getRequest();
    const user = request.user as AuthenticatedUser | undefined;

    if (!user || !required.includes(user.role)) {
      throw new ForbiddenException(translateError('err.auth.insufficientRights', getLocale()));
    }

    return true;
  }
}
