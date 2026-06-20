import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
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
      select: { id: true, orgId: true, role: true },
    });

    if (!employee) {
      throw new UnauthorizedException('Сесія недійсна');
    }

    return { id: employee.id, orgId: employee.orgId, role: employee.role };
  }
}
