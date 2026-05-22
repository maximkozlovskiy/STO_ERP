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
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('JWT_ACCESS_SECRET') ?? 'dev_access_secret',
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
