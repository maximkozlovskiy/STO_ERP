import {
  Injectable,
  UnauthorizedException,
  ForbiddenException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { JwtService, type JwtSignOptions } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import type { FastifyReply } from 'fastify';
import { translateError } from '@sto/shared';
import { PrismaService } from '../prisma/prisma.service';
import { runUnscoped, getLocale } from '../common/tenant/tenant-context';
import type { AuthResponseDto, JwtPayload, LoginDto } from './auth.dto';

const REFRESH_COOKIE = 'sto_refresh';
/**
 * Час життя refresh-cookie У СЕКУНДАХ.
 *
 * `@fastify/cookie` (як і специфікація Set-Cookie) очікує Max-Age у СЕКУНДАХ, а константа
 * була в мілісекундах — браузер отримував `Max-Age=2592000000`, тобто ~82 роки замість
 * 30 днів. Refresh-cookie фактично не протухав: вкрадений токен лишався дійсним без
 * обмеження за часом (ротація tokenVersion рятує лише при зміні пароля).
 * Помічено на живому відгуку сервера під час міграції на Fastify 5; у коді було й раніше.
 */
const REFRESH_COOKIE_MAX_AGE_SEC = 30 * 24 * 60 * 60;
// B2 lockout: N невдалих спроб поспіль → блок на вікно. Прикриває стійкий підбір на відомий email
// (IP-throttle 10/min ловить burst, але не повільний перебір з одного IP чи розподілений).
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async login(dto: LoginDto, res: FastifyReply): Promise<AuthResponseDto> {
    // A1: login здійснюється ДО автентифікації — orgId невідомий. Пошук по email та lockout-update по id
    // легітимно без orgId-фільтра (акаунт ідентифікується email/id, tenant звіряється вручну нижче на :73).
    // Обгортаємо весь метод у runUnscoped, щоб tenant-guard пропустив ці глобальні запити.
    return runUnscoped(async () => {
      // Find by email first; then validate orgId matches the employee's org to prevent cross-tenant auth
      const authRecord = await this.prisma.authAccount.findFirst({
        where: { email: dto.email, deletedAt: null },
        include: { employee: true },
      });

      if (!authRecord) {
        throw new UnauthorizedException(translateError('err.auth.invalidCredentials', getLocale()));
      }

      // B2: rate-based account lockout. Якщо акаунт заблоковано — не перевіряємо пароль зовсім
      // (не подовжуємо вікно, не витрачаємо bcrypt). Розблокування — по спливу lockedUntil.
      if (authRecord.lockedUntil && authRecord.lockedUntil.getTime() > Date.now()) {
        throw new ForbiddenException(translateError('err.auth.accountTempLocked', getLocale()));
      }

      const passwordValid = await bcrypt.compare(dto.password, authRecord.passwordHash);
      if (!passwordValid) {
        // B2: інкремент лічильника; на порозі — блокуємо на LOCKOUT_WINDOW і скидаємо лічильник.
        const attempts = authRecord.failedAttempts + 1;
        const locked = attempts >= MAX_FAILED_ATTEMPTS;
        await this.prisma.authAccount
          .update({
            where: { id: authRecord.id },
            data: locked
              ? { failedAttempts: 0, lockedUntil: new Date(Date.now() + LOCKOUT_WINDOW_MS) }
              : { failedAttempts: attempts },
          })
          .catch(() => undefined); // облік невдач не має зривати відповідь 401
        throw new UnauthorizedException(translateError('err.auth.invalidCredentials', getLocale()));
      }

      const emp = authRecord.employee;
      if (!emp || emp.deletedAt !== null) {
        throw new ForbiddenException(translateError('err.auth.accountBlocked', getLocale()));
      }

      // Tenant guard: authAccount.orgId must match the employee's orgId
      if (authRecord.orgId !== emp.orgId) {
        throw new ForbiddenException(translateError('err.auth.accountBlocked', getLocale()));
      }

      // B2: успішний вхід скидає лічильник невдач (якщо він був ненульовий).
      if (authRecord.failedAttempts !== 0 || authRecord.lockedUntil !== null) {
        await this.prisma.authAccount
          .update({ where: { id: authRecord.id }, data: { failedAttempts: 0, lockedUntil: null } })
          .catch(() => undefined);
      }

      const payload: JwtPayload = {
        sub: emp.id,
        orgId: emp.orgId,
        role: emp.role,
        tokenVersion: authRecord.tokenVersion, // B1
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
    });
  }

  async refresh(refreshToken: string, res: FastifyReply): Promise<AuthResponseDto> {
    let payload: JwtPayload;
    try {
      payload = this.jwt.verify<JwtPayload>(refreshToken, {
        secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
      });
    } catch (e: unknown) {
      this.logger.debug(`JWT refresh failed: ${e instanceof Error ? e.message : e}`);
      throw new UnauthorizedException(translateError('err.auth.sessionExpired', getLocale()));
    }

    const employee = await this.prisma.employee.findFirst({
      where: { id: payload.sub, orgId: payload.orgId, deletedAt: null },
      include: { authAccount: { select: { tokenVersion: true } } },
    });
    if (!employee) {
      throw new UnauthorizedException(translateError('err.auth.sessionExpired', getLocale()));
    }

    // B1: refresh теж підлягає revocation — якщо tokenVersion наміру не збігається з поточним
    // (logout-all/зміна пароля вже сталися), відмовляємо у продовженні сесії.
    const currentVersion = employee.authAccount?.tokenVersion ?? 0;
    if ((payload.tokenVersion ?? 0) !== currentVersion) {
      throw new UnauthorizedException(translateError('err.auth.sessionExpired', getLocale()));
    }

    const newPayload: JwtPayload = {
      sub: employee.id,
      orgId: employee.orgId,
      role: employee.role,
      tokenVersion: currentVersion,
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
    res.clearCookie(REFRESH_COOKIE, { path: '/api/v1/auth' });
  }

  /**
   * B1: «Вийти на всіх пристроях» — інкремент tokenVersion робить НЕДІЙСНИМИ усі раніше видані
   * access+refresh токени цього користувача (jwt.strategy та refresh порівнюють версію). Також
   * чистить refresh-cookie поточного пристрою. Використовується при підозрі на компрометацію.
   */
  async logoutAll(orgId: string, employeeId: string, res: FastifyReply): Promise<void> {
    await this.prisma.authAccount.updateMany({
      where: { employeeId, orgId, deletedAt: null },
      data: { tokenVersion: { increment: 1 } },
    });
    res.clearCookie(REFRESH_COOKIE, { path: '/api/v1/auth' });
  }

  async getMe(orgId: string, employeeId: string) {
    const emp = await this.prisma.employee.findFirst({
      where: { id: employeeId, orgId, deletedAt: null },
      select: { id: true, orgId: true, firstName: true, lastName: true, role: true },
    });
    if (!emp) throw new NotFoundException(translateError('err.auth.userNotFound', getLocale()));
    const auth = await this.prisma.authAccount.findFirst({
      where: { employeeId, orgId, deletedAt: null },
      select: { email: true },
    });
    return { ...emp, email: auth?.email ?? null };
  }

  async changePassword(
    orgId: string,
    employeeId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const auth = await this.prisma.authAccount.findFirst({
      where: { employeeId, orgId, deletedAt: null },
    });
    if (!auth) throw new NotFoundException(translateError('err.auth.accountNotFound', getLocale()));
    const valid = await bcrypt.compare(currentPassword, auth.passwordHash);
    if (!valid)
      throw new UnauthorizedException(translateError('err.auth.currentPasswordWrong', getLocale()));
    const hash = await bcrypt.hash(newPassword, 12);
    // B1: зміна пароля інвалідовує усі інші сесії (bump tokenVersion) — стандартна безпекова
    // поведінка: якщо пароль змінено через компрометацію, старі токени на інших пристроях мертві.
    // where МУСИТЬ нести orgId — A1 tenant-guard відхиляє guarded update без tenant-токена
    // (AuthAccount не у TENANT_EXEMPT_MODELS) → TenantIsolationError. auth.id вже tenant-звірено
    // вище через findFirst({orgId}); orgId у where задовольняє guard і не змінює вибірку (1 рядок).
    await this.prisma.authAccount.update({
      where: { id: auth.id, orgId },
      data: { passwordHash: hash, tokenVersion: { increment: 1 } },
    });
  }

  /**
   * Тривалість життя токена з env у типі, який приймає @nestjs/jwt 11.
   *
   * У v11 `expiresIn` звузився з довільного `string` до `number | StringValue`, де
   * StringValue — шаблонний літерал («15m», «30d», «2h»). Значення з ConfigService
   * приходить як `string`, тож потрібна перевірка, а не каст наосліп: помилка у
   * JWT_ACCESS_EXPIRES_IN інакше дала б рантаймний збій підписання вже у проді.
   *
   * Формат — число з одиницею (s/m/h/d/w/y) або просто число секунд; обидва підтримує
   * jsonwebtoken. Нерозпізнане значення — явна помилка на старті, а не тихе ігнорування.
   */
  private expiresIn(
    key: string,
    fallback: `${number}${'s' | 'm' | 'h' | 'd'}`,
  ): JwtSignOptions['expiresIn'] {
    const raw = this.config.get<string>(key);
    if (!raw) return fallback;
    if (/^\d+$/.test(raw)) return Number(raw);
    if (/^\d+(\.\d+)?\s*(s|m|h|d|w|y)$/i.test(raw))
      return raw as `${number}${'s' | 'm' | 'h' | 'd'}`;
    throw new Error(
      `${key}="${raw}" має неприпустимий формат. Очікується число секунд або число з одиницею: 15m, 2h, 30d.`,
    );
  }

  generateAccessToken(payload: JwtPayload): string {
    return this.signAccess(payload);
  }

  private signAccess(payload: JwtPayload): string {
    return this.jwt.sign(payload, {
      secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      expiresIn: this.expiresIn('JWT_ACCESS_EXPIRES_IN', '15m'),
    });
  }

  private signRefresh(payload: JwtPayload): string {
    return this.jwt.sign(payload, {
      secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
      expiresIn: this.expiresIn('JWT_REFRESH_EXPIRES_IN', '30d'),
    });
  }

  private setRefreshCookie(res: FastifyReply, token: string): void {
    res.cookie(REFRESH_COOKIE, token, {
      httpOnly: true,
      secure: this.config.get<string>('NODE_ENV') === 'production',
      sameSite: 'strict',
      path: '/api/v1/auth',
      maxAge: REFRESH_COOKIE_MAX_AGE_SEC,
    });
  }
}
