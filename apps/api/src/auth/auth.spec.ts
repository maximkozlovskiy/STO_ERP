import { Test } from '@nestjs/testing';
import { UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';

const mockEmployee = {
  id: 'emp-1',
  orgId: 'org-1',
  firstName: 'Іван',
  lastName: 'Петренко',
  role: 'ADMIN',
  deletedAt: null,
};

describe('AuthService', () => {
  let service: AuthService;
  let prisma: {
    employee: { findFirst: ReturnType<typeof vi.fn> };
    authAccount: {
      findFirst: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
    };
  };
  let jwtService: { sign: ReturnType<typeof vi.fn>; verify: ReturnType<typeof vi.fn> };

  const mockRes = {
    cookie: vi.fn(),
    clearCookie: vi.fn(),
  } as unknown as import('fastify').FastifyReply;

  beforeEach(async () => {
    mockRes.cookie.mockReset();
    mockRes.clearCookie.mockReset();

    const module = await Test.createTestingModule({
      providers: [
        AuthService,
        {
          provide: PrismaService,
          useValue: {
            employee: {
              findFirst: vi.fn(),
            },
            authAccount: {
              findFirst: vi.fn(),
              update: vi.fn().mockResolvedValue(undefined),
              updateMany: vi.fn().mockResolvedValue({ count: 1 }),
            },
          },
        },
        {
          provide: JwtService,
          useValue: {
            sign: vi.fn().mockReturnValue('mock.jwt.token'),
            verify: vi.fn(),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: vi.fn((key: string) => {
              const map: Record<string, string> = {
                JWT_ACCESS_SECRET: 'access-secret',
                JWT_REFRESH_SECRET: 'refresh-secret',
                JWT_ACCESS_EXPIRES_IN: '15m',
                JWT_REFRESH_EXPIRES_IN: '30d',
              };
              return map[key];
            }),
            getOrThrow: vi.fn((key: string) => {
              const map: Record<string, string> = {
                JWT_ACCESS_SECRET: 'access-secret',
                JWT_REFRESH_SECRET: 'refresh-secret',
              };
              const val = map[key];
              if (!val) throw new Error(`Config key "${key}" not found`);
              return val;
            }),
          },
        },
      ],
    }).compile();

    service = module.get(AuthService);
    prisma = module.get(PrismaService) as unknown as typeof prisma;
    jwtService = module.get(JwtService) as unknown as typeof jwtService;
  });

  describe('login', () => {
    it('кидає UnauthorizedException якщо email не знайдено', async () => {
      prisma.authAccount.findFirst.mockResolvedValue(null);

      await expect(
        service.login({ email: 'wrong@sto.local', password: 'pass' }, mockRes),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('кидає UnauthorizedException при невірному паролі', async () => {
      const hash = await bcrypt.hash('correct', 10);
      prisma.authAccount.findFirst.mockResolvedValue({
        id: 'auth-1',
        email: 'admin@sto.local',
        passwordHash: hash,
        tokenVersion: 0,
        failedAttempts: 0,
        lockedUntil: null,
        employee: { ...mockEmployee },
      });

      await expect(
        service.login({ email: 'admin@sto.local', password: 'wrong' }, mockRes),
      ).rejects.toThrow(UnauthorizedException);
      // B2: невдала спроба інкрементує лічильник.
      expect(prisma.authAccount.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { failedAttempts: 1 } }),
      );
    });

    it('B2: на 5-й невдалій спробі блокує акаунт (lockedUntil у майбутньому)', async () => {
      const hash = await bcrypt.hash('correct', 10);
      prisma.authAccount.findFirst.mockResolvedValue({
        id: 'auth-1',
        email: 'admin@sto.local',
        passwordHash: hash,
        tokenVersion: 0,
        failedAttempts: 4, // наступна невдача = 5-та → lock
        lockedUntil: null,
        employee: { ...mockEmployee },
      });

      await expect(
        service.login({ email: 'admin@sto.local', password: 'wrong' }, mockRes),
      ).rejects.toThrow(UnauthorizedException);
      const call = prisma.authAccount.update.mock.calls[0][0];
      expect(call.data.failedAttempts).toBe(0);
      expect(call.data.lockedUntil.getTime()).toBeGreaterThan(Date.now());
      // MUTATION-VERIFY: якщо прибрати lock-гілку (locked?...:...) — цей assert впаде (lockedUntil undefined).
    });

    it('B2: заблокований акаунт (lockedUntil у майбутньому) → ForbiddenException навіть з ВІРНИМ паролем', async () => {
      const hash = await bcrypt.hash('secret', 10);
      prisma.authAccount.findFirst.mockResolvedValue({
        id: 'auth-1',
        email: 'admin@sto.local',
        passwordHash: hash,
        tokenVersion: 0,
        failedAttempts: 0,
        lockedUntil: new Date(Date.now() + 60_000),
        employee: { ...mockEmployee },
      });

      // Пароль ВІРНИЙ, але акаунт заблоковано → Forbidden (lock-гілка спрацьовує ПЕРЕД перевіркою
      // пароля; інакше вірний пароль дав би успіх). Лічильник невдач НЕ чіпається (update не викликано).
      await expect(
        service.login({ email: 'admin@sto.local', password: 'secret' }, mockRes),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.authAccount.update).not.toHaveBeenCalled();
      // MUTATION-VERIFY: прибрати lock-guard → вірний пароль пройшов би → .rejects впаде.
    });

    it('кидає ForbiddenException якщо працівника видалено', async () => {
      const hash = await bcrypt.hash('secret', 10);
      prisma.authAccount.findFirst.mockResolvedValue({
        email: 'admin@sto.local',
        passwordHash: hash,
        employee: { ...mockEmployee, deletedAt: new Date() },
      });

      await expect(
        service.login({ email: 'admin@sto.local', password: 'secret' }, mockRes),
      ).rejects.toThrow(ForbiddenException);
    });

    it('повертає accessToken і встановлює cookie при успішному вході', async () => {
      const hash = await bcrypt.hash('secret', 10);
      prisma.authAccount.findFirst.mockResolvedValue({
        id: 'auth-1',
        email: 'admin@sto.local',
        passwordHash: hash,
        orgId: 'org-1',
        tokenVersion: 3,
        failedAttempts: 0,
        lockedUntil: null,
        employee: { ...mockEmployee },
      });

      const result = await service.login({ email: 'admin@sto.local', password: 'secret' }, mockRes);

      expect(result.accessToken).toBe('mock.jwt.token');
      expect(result.employee?.id).toBe('emp-1');
      // B1: payload несе поточний tokenVersion акаунта.
      expect(jwtService.sign).toHaveBeenCalledWith(
        expect.objectContaining({ tokenVersion: 3 }),
        expect.anything(),
      );
      expect(mockRes.cookie).toHaveBeenCalledWith(
        'sto_refresh',
        'mock.jwt.token',
        expect.objectContaining({ httpOnly: true }),
      );
    });

    it('B2: успішний вхід після невдач скидає failedAttempts/lockedUntil', async () => {
      const hash = await bcrypt.hash('secret', 10);
      prisma.authAccount.findFirst.mockResolvedValue({
        id: 'auth-1',
        email: 'admin@sto.local',
        passwordHash: hash,
        orgId: 'org-1',
        tokenVersion: 0,
        failedAttempts: 3,
        lockedUntil: null,
        employee: { ...mockEmployee },
      });

      await service.login({ email: 'admin@sto.local', password: 'secret' }, mockRes);
      expect(prisma.authAccount.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { failedAttempts: 0, lockedUntil: null } }),
      );
    });
  });

  describe('refresh', () => {
    it('кидає UnauthorizedException при невалідному refresh token', async () => {
      jwtService.verify.mockImplementation(() => {
        throw new Error('invalid');
      });

      await expect(service.refresh('invalid.token', mockRes)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('кидає UnauthorizedException якщо працівника не знайдено', async () => {
      jwtService.verify.mockReturnValue({
        sub: 'emp-1',
        orgId: 'org-1',
        role: 'ADMIN',
      });
      prisma.employee.findFirst.mockResolvedValue(null);

      await expect(service.refresh('valid.token', mockRes)).rejects.toThrow(UnauthorizedException);
    });

    it('повертає новий accessToken при валідному refresh (tokenVersion збігається)', async () => {
      jwtService.verify.mockReturnValue({
        sub: 'emp-1',
        orgId: 'org-1',
        role: 'ADMIN',
        tokenVersion: 2,
      });
      prisma.employee.findFirst.mockResolvedValue({
        ...mockEmployee,
        authAccount: { tokenVersion: 2 },
      });

      const result = await service.refresh('valid.token', mockRes);

      expect(result.accessToken).toBe('mock.jwt.token');
      expect(mockRes.cookie).toHaveBeenCalled();
    });

    it('B1: refresh відхиляється якщо tokenVersion розійшовся (logout-all/зміна пароля)', async () => {
      jwtService.verify.mockReturnValue({
        sub: 'emp-1',
        orgId: 'org-1',
        role: 'ADMIN',
        tokenVersion: 1, // старий токен
      });
      prisma.employee.findFirst.mockResolvedValue({
        ...mockEmployee,
        authAccount: { tokenVersion: 2 }, // версію інкрементовано → токен мертвий
      });

      await expect(service.refresh('stale.token', mockRes)).rejects.toThrow(UnauthorizedException);
      // MUTATION-VERIFY: прибрати tokenVersion-guard у refresh → цей assert впаде (сесія продовжилась би).
    });
  });

  describe('logout', () => {
    it('очищає refresh cookie', () => {
      service.logout(mockRes);
      expect(mockRes.clearCookie).toHaveBeenCalledWith('sto_refresh', {
        path: '/api/auth',
      });
    });
  });

  describe('logoutAll (B1)', () => {
    it('інкрементує tokenVersion (усі сесії мертві) + чистить cookie', async () => {
      await service.logoutAll('org-1', 'emp-1', mockRes);
      expect(prisma.authAccount.updateMany).toHaveBeenCalledWith({
        where: { employeeId: 'emp-1', orgId: 'org-1', deletedAt: null },
        data: { tokenVersion: { increment: 1 } },
      });
      expect(mockRes.clearCookie).toHaveBeenCalledWith('sto_refresh', { path: '/api/auth' });
    });
  });
});
