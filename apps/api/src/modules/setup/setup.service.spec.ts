import { vi, describe, it, expect, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { SetupService } from './setup.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthService } from '../../auth/auth.service';
import { SetupInitDto } from './setup.dto';

/**
 * Regression (audit settings/setup/reports): TOCTOU race у first-run wizard.
 *
 * BUG: isAlreadyInitialized() у init()/controller — це organisation.count() ПОЗА
 * транзакцією. Два concurrent POST /setup/init (обидва в межах Throttle 3/хв) могли
 * пройти перевірку count=0 і кожен створити ПОВНУ організацію+власника — бо кожна tx
 * отримує власний org.id, тож @@unique([orgId,email]) на AuthAccount не ловить дубль
 * (orgId різні). Наслідок: дві Organisation + два OWNER → зламаний single-tenant
 * інваріант.
 *
 * FIX: xact-advisory-lock серіалізує bootstrap + re-check count() ВСЕРЕДИНІ tx.
 * Другий виклик, зайшовши у tx після COMMIT першого, бачить count>0 → BadRequest.
 */

const dto: SetupInitDto = {
  orgName: 'СТО Тест',
  ownerEmail: 'Owner@STO.local',
  ownerPassword: 'secret123',
  ownerFirstName: 'Іван',
  ownerLastName: 'Коваль',
  branchName: 'Головна',
  branchAddress: 'вул. Тестова 1',
};

/**
 * Build a Prisma mock whose $transaction runs the callback with a tx stub.
 * `orgCountInsideTx` — значення, яке organisation.count() повертає ВСЕРЕДИНІ tx
 * (симулює, що інша concurrent init вже закомітила організацію під advisory-lock).
 */
function makePrisma(orgCountOutsideTx: number, orgCountInsideTx: number) {
  const advisoryLockCalls: unknown[][] = [];
  const tx = {
    $executeRaw: vi.fn().mockImplementation((strings: TemplateStringsArray, ...v: unknown[]) => {
      advisoryLockCalls.push([strings.join('?'), ...v]);
      return Promise.resolve(0);
    }),
    organisation: {
      count: vi.fn().mockResolvedValue(orgCountInsideTx),
      create: vi.fn().mockResolvedValue({ id: 'org-1' }),
      update: vi.fn().mockResolvedValue({ id: 'org-1', orgId: 'org-1' }),
    },
    organisationSettings: { create: vi.fn().mockResolvedValue({}) },
    documentNumberConfig: { createMany: vi.fn().mockResolvedValue({ count: 8 }) },
    paymentMethodConfig: { createMany: vi.fn().mockResolvedValue({ count: 5 }) },
    taxRate: { createMany: vi.fn().mockResolvedValue({ count: 3 }) },
    garageBranch: { create: vi.fn().mockResolvedValue({ id: 'branch-1' }) },
    branchSettings: { create: vi.fn().mockResolvedValue({}) },
    warehouse: { create: vi.fn().mockResolvedValue({ id: 'wh-1' }) },
    employee: { create: vi.fn().mockResolvedValue({ id: 'emp-1', role: 'OWNER' }) },
    authAccount: { create: vi.fn().mockResolvedValue({ id: 'auth-1' }) },
  };
  const prisma = {
    organisation: { count: vi.fn().mockResolvedValue(orgCountOutsideTx) },
    $transaction: vi.fn().mockImplementation((cb: (t: typeof tx) => unknown) => cb(tx)),
  } as unknown as PrismaService;
  return { prisma, tx, advisoryLockCalls };
}

describe('SetupService.init — TOCTOU race guard', () => {
  let authService: AuthService;

  beforeEach(() => {
    authService = {
      generateAccessToken: vi.fn().mockReturnValue('jwt-token'),
    } as unknown as AuthService;
  });

  it('happy path: count=0 зовні і всередині tx → створює org + повертає токен', async () => {
    const { prisma, tx, advisoryLockCalls } = makePrisma(0, 0);
    const service = new SetupService(prisma, authService);

    const res = await service.init(dto);

    expect(res.orgId).toBe('org-1');
    expect(res.accessToken).toBe('jwt-token');
    // advisory-lock узято ПЕРШИМ у tx
    expect(tx.$executeRaw).toHaveBeenCalled();
    expect(advisoryLockCalls[0]?.[0]).toContain('pg_advisory_xact_lock');
    expect(tx.organisation.create).toHaveBeenCalledTimes(1);
    expect(tx.authAccount.create).toHaveBeenCalledTimes(1);
  });

  it('race: зовнішній count=0, але всередині tx count=1 (інша init закомітила) → 400, org НЕ створюється вдруге', async () => {
    // Симуляція: перша init пройшла outer-check (count=0), взяла lock; поки вона в tx,
    // друга init теж пройшла outer-check (count=0) і зайшла у $transaction; після
    // COMMIT першої друга бере lock і re-check всередині tx бачить count=1.
    const { prisma, tx } = makePrisma(0, 1);
    const service = new SetupService(prisma, authService);

    await expect(service.init(dto)).rejects.toBeInstanceOf(BadRequestException);
    // Критично: жодного дубль-створення після re-check
    expect(tx.organisation.create).not.toHaveBeenCalled();
    expect(tx.authAccount.create).not.toHaveBeenCalled();
    // Але advisory-lock усе одно був узятий (серіалізація) ПЕРЕД re-check
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('outer guard: якщо система вже налаштована (outer count>0) → 400 до входу в tx', async () => {
    const { prisma } = makePrisma(1, 1);
    const service = new SetupService(prisma, authService);

    await expect(service.init(dto)).rejects.toBeInstanceOf(BadRequestException);
    // $transaction не викликається — outer isAlreadyInitialized() відсік раніше
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('email власника нормалізується у lowercase', async () => {
    const { prisma, tx } = makePrisma(0, 0);
    const service = new SetupService(prisma, authService);

    await service.init(dto);

    const call = tx.authAccount.create.mock.calls[0]?.[0] as { data: { email: string } };
    expect(call.data.email).toBe('owner@sto.local');
  });
});
