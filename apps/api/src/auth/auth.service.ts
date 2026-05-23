import {
  Injectable,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthResponseDto, JwtPayload, LoginDto } from './auth.dto';

const REFRESH_COOKIE = 'sto_refresh';
const REFRESH_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

interface CookieResponse {
  cookie(name: string, value: string, options: Record<string, unknown>): void;
  clearCookie(name: string, options?: Record<string, unknown>): void;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async login(dto: LoginDto, res: CookieResponse): Promise<AuthResponseDto> {
    // Find by email first; then validate orgId matches the employee's org to prevent cross-tenant auth
    const authRecord = await this.prisma.authAccount.findFirst({
      where: { email: dto.email },
      include: { employee: true },
    });

    if (!authRecord) {
      throw new UnauthorizedException('Невірний email або пароль');
    }

    const passwordValid = await bcrypt.compare(dto.password, authRecord.passwordHash);
    if (!passwordValid) {
      throw new UnauthorizedException('Невірний email або пароль');
    }

    const emp = authRecord.employee;
    if (!emp || emp.deletedAt) {
      throw new ForbiddenException('Обліковий запис заблоковано');
    }

    // Tenant guard: authAccount.orgId must match the employee's orgId
    if (authRecord.orgId !== emp.orgId) {
      throw new ForbiddenException('Обліковий запис заблоковано');
    }

    const payload: JwtPayload = {
      sub: emp.id,
      orgId: emp.orgId,
      role: emp.role,
    };

    const accessToken = this.signAccess(payload);
    const refreshToken = this.signRefresh(payload);

    this.setRefreshCookie(res, refreshToken);

    return {
      accessToken,
      employee: {
        id: emp.id,
        orgId: emp.orgId,
        firstName: emp.firstName,
        lastName: emp.lastName,
        role: emp.role,
      },
    };
  }

  async refresh(refreshToken: string, res: CookieResponse): Promise<AuthResponseDto> {
    let payload: JwtPayload;
    try {
      payload = this.jwt.verify<JwtPayload>(refreshToken, {
        secret: this.config.get<string>('JWT_REFRESH_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('Сесія застаріла, увійдіть знову');
    }

    const employee = await this.prisma.employee.findFirst({
      where: { id: payload.sub, orgId: payload.orgId, deletedAt: null },
    });
    if (!employee) {
      throw new UnauthorizedException('Сесія застаріла, увійдіть знову');
    }

    const newPayload: JwtPayload = {
      sub: employee.id,
      orgId: employee.orgId,
      role: employee.role,
    };

    const accessToken = this.signAccess(newPayload);
    const newRefreshToken = this.signRefresh(newPayload);
    this.setRefreshCookie(res, newRefreshToken);

    // Return employee so the frontend can restore session state after a page reload
    return {
      accessToken,
      employee: {
        id: employee.id,
        orgId: employee.orgId,
        firstName: employee.firstName,
        lastName: employee.lastName,
        role: employee.role,
      },
    };
  }

  logout(res: CookieResponse): void {
    res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
  }

  generateAccessToken(payload: JwtPayload): string {
    return this.signAccess(payload);
  }

  private signAccess(payload: JwtPayload): string {
    return this.jwt.sign(payload, {
      secret: this.config.get<string>('JWT_ACCESS_SECRET'),
      expiresIn: this.config.get<string>('JWT_ACCESS_EXPIRES_IN') ?? '15m',
    });
  }

  private signRefresh(payload: JwtPayload): string {
    return this.jwt.sign(payload, {
      secret: this.config.get<string>('JWT_REFRESH_SECRET'),
      expiresIn: this.config.get<string>('JWT_REFRESH_EXPIRES_IN') ?? '30d',
    });
  }

  private setRefreshCookie(res: CookieResponse, token: string): void {
    res.cookie(REFRESH_COOKIE, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/api/auth',
      maxAge: REFRESH_COOKIE_MAX_AGE_MS,
    });
  }
}
