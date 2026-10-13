import { UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { JwtStrategy } from './strategies/jwt.strategy';
import type { PrismaService } from '../prisma/prisma.service';
import type { JwtPayload } from './auth.dto';

/**
 * JwtStrategy.validate — перевірка, що виконується на КОЖЕН авторизований запит.
 *
 * Підпис і строк дії токена перевіряє passport-jwt до виклику validate; тут — те, що
 * стратегія дочитує з бази: працівник існує у своїй організації, не видалений, не звільнений
 * (BR-EMP-001), а версія токена збігається з поточною (відкликання сесій).
 */
describe('JwtStrategy.validate', () => {
  const ORG = 'org-1';
  const EMP = 'emp-1';
  const payload = (over: Partial<JwtPayload> = {}): JwtPayload =>
    ({ sub: EMP, orgId: ORG, role: 'MECHANIC', tokenVersion: 0, ...over }) as JwtPayload;

  let findFirst: ReturnType<typeof vi.fn>;
  let strategy: JwtStrategy;

  const employee = (over: Record<string, unknown> = {}) => ({
    id: EMP,
    orgId: ORG,
    role: 'MECHANIC',
    status: 'ACTIVE',
    authAccount: { tokenVersion: 0 },
    ...over,
  });

  beforeEach(() => {
    findFirst = vi.fn().mockResolvedValue(employee());
    const config = { getOrThrow: vi.fn(() => 'access-secret') } as unknown as ConfigService;
    const prisma = { employee: { findFirst } } as unknown as PrismaService;
    strategy = new JwtStrategy(config, prisma);
  });

  it('чинний працівник проходить; у запит іде id, orgId і роль з БАЗИ', async () => {
    findFirst.mockResolvedValue(employee({ role: 'ADMIN' }));

    // У токені роль MECHANIC, у базі вже ADMIN — права беруться з бази.
    await expect(strategy.validate(payload())).resolves.toEqual({
      id: EMP,
      orgId: ORG,
      role: 'ADMIN',
    });
  });

  it('працівника шукає у СВОЇЙ організації, за sub, серед невидалених і читає статус', async () => {
    await strategy.validate(payload());

    const arg = findFirst.mock.calls[0]![0] as {
      where: Record<string, unknown>;
      select: Record<string, unknown>;
    };
    expect(arg.where).toEqual({ id: EMP, orgId: ORG, deletedAt: null });
    expect(arg.select).toMatchObject({
      status: true,
      authAccount: { select: { tokenVersion: true } },
    });
  });

  // guards: BR-EMP-001
  it('звільнений (FIRED) → 401 «Сесія недійсна», хоча токен і версія чинні', async () => {
    findFirst.mockResolvedValue(employee({ status: 'FIRED' }));

    await expect(strategy.validate(payload())).rejects.toThrow(
      new UnauthorizedException('Сесія недійсна'),
    );
  });

  // guards: BR-EMP-001
  it.each(['ACTIVE', 'ON_LEAVE'])('статус %s проходить', async status => {
    findFirst.mockResolvedValue(employee({ status }));

    await expect(strategy.validate(payload())).resolves.toMatchObject({ id: EMP });
  });

  it('видалений або чужий працівник (запит нічого не знайшов) → 401', async () => {
    findFirst.mockResolvedValue(null);

    await expect(strategy.validate(payload())).rejects.toThrow(UnauthorizedException);
  });

  it('версія токена розійшлася з поточною (вихід з усіх пристроїв, зміна пароля) → 401', async () => {
    findFirst.mockResolvedValue(employee({ authAccount: { tokenVersion: 2 } }));

    await expect(strategy.validate(payload({ tokenVersion: 1 }))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('токен без версії та працівник без акаунта трактуються як версія 0', async () => {
    findFirst.mockResolvedValue(employee({ authAccount: null }));
    const legacy = payload();
    delete (legacy as { tokenVersion?: number }).tokenVersion;

    await expect(strategy.validate(legacy)).resolves.toMatchObject({ id: EMP });
  });
});
