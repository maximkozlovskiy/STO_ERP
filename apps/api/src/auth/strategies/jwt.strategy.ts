import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { translateError } from '@sto/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { getLocale } from '../../common/tenant/tenant-context';
import type { JwtPayload } from '../auth.dto';

export interface AuthenticatedUser {
  id: string;
  orgId: string;
  role: string;
  branchId?: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    // §2.1 SECURITY: ніяких fallback secret — `getOrThrow` падає при старті,
    // якщо JWT_ACCESS_SECRET не заданий. Раніше fallback 'dev_access_secret'
    // означав, що у production з втраченим env-var JWT валідувався б публічно
    // відомим рядком → зловмисник міг би підробити будь-який access-token.
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
    });
  }

  async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    const employee = await this.prisma.employee.findFirst({
      where: { id: payload.sub, orgId: payload.orgId, deletedAt: null },
      // B1: tokenVersion живе на пов'язаному AuthAccount — тягнемо nested-select (той самий запит,
      // без зайвого RTT), щоб порівняти з версією у токені.
      select: {
        id: true,
        orgId: true,
        role: true,
        authAccount: { select: { tokenVersion: true } },
      },
    });

    if (!employee) {
      throw new UnauthorizedException(translateError('err.auth.sessionInvalid', getLocale()));
    }

    // B1: revocation-guard. Після logout-all/зміни пароля поточний tokenVersion інкрементовано →
    // усі раніше видані токени (зі старою версією) відхиляються. undefined у payload (старий токен
    // до релізу) трактується як 0.
    const currentVersion = employee.authAccount?.tokenVersion ?? 0;
    if ((payload.tokenVersion ?? 0) !== currentVersion) {
      throw new UnauthorizedException(translateError('err.auth.sessionInvalid', getLocale()));
    }

    return { id: employee.id, orgId: employee.orgId, role: employee.role };
  }
}
