import type { ExecutionContext } from '@nestjs/common';
import { createParamDecorator } from '@nestjs/common';
import type { AuthenticatedUser } from '../strategies/jwt.strategy';

/** Extracts orgId from the authenticated user — use instead of @CurrentUser() for tenant isolation */
export const OrgContext = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const request = ctx.switchToHttp().getRequest();
  return (request.user as AuthenticatedUser).orgId;
});
