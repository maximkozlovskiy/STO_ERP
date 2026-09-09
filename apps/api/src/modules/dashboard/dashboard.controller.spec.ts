import { vi, describe, it, expect, beforeEach } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';
import { DashboardController } from './dashboard.controller';
import type { DashboardService } from './dashboard.service';
import type { JwtService } from '@nestjs/jwt';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../../prisma/prisma.service';

/**
 * T6: SSE-stream окрім підпису+expiry звіряє tokenVersion проти AuthAccount (revocation-guard) +
 * liveness employee. Раніше відкликаний токен стрімив би до expiry.
 */
describe('DashboardController.stream — SSE auth (T6)', () => {
  const getSummary = vi.fn().mockResolvedValue({ activeWo: 1 });
  const verify = vi.fn();
  const employeeFindFirst = vi.fn();

  const dashboardService = { getSummary } as unknown as DashboardService;
  const jwtService = { verify } as unknown as JwtService;
  const configService = {
    getOrThrow: vi.fn().mockReturnValue('secret'),
  } as unknown as ConfigService;
  const prisma = {
    employee: { findFirst: employeeFindFirst },
  } as unknown as PrismaService;

  let controller: DashboardController;

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new DashboardController(dashboardService, jwtService, configService, prisma);
  });

  it('без токена → UnauthorizedException', async () => {
    await expect(controller.stream('')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(verify).not.toHaveBeenCalled();
  });

  it('невалідний підпис → UnauthorizedException', async () => {
    verify.mockImplementation(() => {
      throw new Error('bad signature');
    });
    await expect(controller.stream('bad')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('токен без claims (sub/orgId) → UnauthorizedException', async () => {
    verify.mockReturnValue({ sub: '', orgId: '' });
    await expect(controller.stream('t')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('employee не знайдено (видалений) → UnauthorizedException', async () => {
    verify.mockReturnValue({ sub: 'e1', orgId: 'o1', tokenVersion: 1 });
    employeeFindFirst.mockResolvedValue(null);
    await expect(controller.stream('t')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('REVOCATION: tokenVersion у токені != поточний AuthAccount → UnauthorizedException', async () => {
    verify.mockReturnValue({ sub: 'e1', orgId: 'o1', tokenVersion: 1 });
    employeeFindFirst.mockResolvedValue({ id: 'e1', authAccount: { tokenVersion: 2 } });
    await expect(controller.stream('t')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('legacy-токен без tokenVersion (undefined→0) vs current 0 → пропускає', async () => {
    verify.mockReturnValue({ sub: 'e1', orgId: 'o1' });
    employeeFindFirst.mockResolvedValue({ id: 'e1', authAccount: null });
    const stream$ = await controller.stream('t');
    const first = await firstValueFrom(stream$);
    expect(JSON.parse((first as { data: string }).data)).toEqual({ activeWo: 1 });
  });

  it('валідний токен + збіг tokenVersion → стрім віддає snapshot org-scoped', async () => {
    verify.mockReturnValue({ sub: 'e1', orgId: 'o1', tokenVersion: 3 });
    employeeFindFirst.mockResolvedValue({ id: 'e1', authAccount: { tokenVersion: 3 } });
    const stream$ = await controller.stream('t');
    const first = await firstValueFrom(stream$);
    expect(getSummary).toHaveBeenCalledWith('o1');
    expect(JSON.parse((first as { data: string }).data)).toEqual({ activeWo: 1 });
  });
});
