import {
  Injectable,
  UnauthorizedException,
  ForbiddenException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import type { FastifyReply } from 'fastify';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthResponseDto, JwtPayload, LoginDto } from './auth.dto';

const REFRESH_COOKIE = 'sto_refresh';
const REFRESH_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async login(dto: LoginDto, res: FastifyReply): Promise<AuthResponseDto> {
    // Find by email first; then validate orgId matches the employee's org to prevent cross-tenant auth
    const authRecord = await this.prisma.authAccount.findFirst({
      where: { email: dto.email, deletedAt: null },
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
    if (!emp || emp.deletedAt !== null) {
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

  async refresh(refreshToken: string, res: FastifyReply): Promise<AuthResponseDto> {
    let payload: JwtPayload;
    try {
      payload = this.jwt.verify<JwtPayload>(refreshToken, {
        secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
      });
    } catch (e: unknown) {
      this.logger.debug(`JWT refresh failed: ${e instanceof Error ? e.message : e}`);
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

  logout(res: FastifyReply): void {
    res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
  }

  async getMe(orgId: string, employeeId: string) {
    const emp = await this.prisma.employee.findFirst({
      where: { id: employeeId, orgId, deletedAt: null },
      select: { id: true, orgId: true, firstName: true, lastName: true, role: true },
    });
    if (!emp) throw new NotFoundException('Користувача не знайдено');
    const auth = await this.prisma.authAccount.findFirst({ where: { employeeId, orgId, deletedAt: null }, select: { email: true } });
    return { ...emp, email: auth?.email ?? null };
  }

  async changePassword(orgId: string, employeeId: string, currentPassword: string, newPassword: string): Promise<void> {
    const auth = await this.prisma.authAccount.findFirst({ where: { employeeId, orgId, deletedAt: null } });
    if (!auth) throw new NotFoundException('Обліковий запис не знайдено');
    const valid = await bcrypt.compare(currentPassword, auth.passwordHash);
    if (!valid) throw new UnauthorizedException('Поточний пароль невірний');
    const hash = await bcrypt.hash(newPassword, 12);
    await this.prisma.authAccount.update({ where: { id: auth.id }, data: { passwordHash: hash } });
  }

  generateAccessToken(payload: JwtPayload): string {
    return this.signAccess(payload);
  }

  private signAccess(payload: JwtPayload): string {
    return this.jwt.sign(payload, {
      secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      expiresIn: this.config.get<string>('JWT_ACCESS_EXPIRES_IN') ?? '15m',
    });
  }

  private signRefresh(payload: JwtPayload): string {
    return this.jwt.sign(payload, {
      secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
      expiresIn: this.config.get<string>('JWT_REFRESH_EXPIRES_IN') ?? '30d',
    });
  }

  private setRefreshCookie(res: FastifyReply, token: string): void {
    res.cookie(REFRESH_COOKIE, token, {
      httpOnly: true,
      secure: this.config.get<string>('NODE_ENV') === 'production',
      sameSite: 'strict',
      path: '/api/auth',
      maxAge: REFRESH_COOKIE_MAX_AGE_MS,
    });
  }
}
