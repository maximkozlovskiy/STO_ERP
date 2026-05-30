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
    authAccount: { findFirst: ReturnType<typeof vi.fn> };
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
        email: 'admin@sto.local',
        passwordHash: hash,
        employee: { ...mockEmployee },
      });

      await expect(
        service.login({ email: 'admin@sto.local', password: 'wrong' }, mockRes),
      ).rejects.toThrow(UnauthorizedException);
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
        email: 'admin@sto.local',
        passwordHash: hash,
        orgId: 'org-1',
        employee: { ...mockEmployee },
      });

      const result = await service.login({ email: 'admin@sto.local', password: 'secret' }, mockRes);

      expect(result.accessToken).toBe('mock.jwt.token');
      expect(result.employee?.id).toBe('emp-1');
      expect(mockRes.cookie).toHaveBeenCalledWith(
        'sto_refresh',
        'mock.jwt.token',
        expect.objectContaining({ httpOnly: true }),
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

    it('повертає новий accessToken при валідному refresh', async () => {
      jwtService.verify.mockReturnValue({
        sub: 'emp-1',
        orgId: 'org-1',
        role: 'ADMIN',
      });
      prisma.employee.findFirst.mockResolvedValue(mockEmployee);

      const result = await service.refresh('valid.token', mockRes);

      expect(result.accessToken).toBe('mock.jwt.token');
      expect(mockRes.cookie).toHaveBeenCalled();
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
});
