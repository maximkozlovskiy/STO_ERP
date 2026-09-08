import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CashShiftService } from './cash-shift.service';
import { FiscalProviderRegistry } from './fiscal/fiscal-provider-registry';
import { ProviderConfigService } from './provider-config.service';
import { IntegrationLogService } from '../integration-logs/integration-log.service';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * ПРРО Крок 2/registry — CashShiftService через активний FiscalProvider (не хардкод Checkbox).
 * Покриває load-bearing інваріанти грошей/безпеки:
 *  - open: happy (signIn→openShift→persist OPEN+token+provider+shiftId); guard провайдер/каса;
 *    existing OPEN→400; P2002-recovery повертає winner OPEN-зміну (mutation-verified).
 *  - close: OPEN→ensureToken→closeShift→CLOSED+zReportId; already CLOSED→400; cross-org→NotFound.
 *  - ensureToken: валідний токен (30s skew)→кеш; протух/нема→re-sign-in+update; провайдер зник→400.
 *  - refreshToken: updateMany where{id,orgId} — cross-org id → no-op; потім ensureToken.
 *  - getCurrent: OPEN → dto + pendingReceipts scoped до THIS branch; нема→null.
 *  - Секрет: checkboxAccessToken НЕ у жодному DTO-виводі.
 */

const P2002 = new Prisma.PrismaClientKnownRequestError('unique', {
  code: 'P2002',
  clientVersion: '5',
});

describe('CashShiftService (ПРРО registry)', () => {
  let service: CashShiftService;

  // Prisma mocks
  const cashShiftFindFirst = vi.fn();
  const cashShiftCreate = vi.fn();
  const cashShiftUpdate = vi.fn();
  const cashShiftUpdateMany = vi.fn();
  const cashRegisterFindFirst = vi.fn();
  const paymentCount = vi.fn();

  const prisma = {
    cashShift: {
      findFirst: cashShiftFindFirst,
      create: cashShiftCreate,
      update: cashShiftUpdate,
      updateMany: cashShiftUpdateMany,
    },
    cashRegister: { findFirst: cashRegisterFindFirst },
    payment: { count: paymentCount },
  } as unknown as PrismaService;

  // Активний FiscalProvider (мок) — signIn/openShift/closeShift зараз викликає сервіс.
  const signIn = vi.fn();
  const openShift = vi.fn();
  const closeShift = vi.fn();
  const providerMock = { code: 'checkbox', name: 'Checkbox', signIn, openShift, closeShift };
  const registryGet = vi.fn().mockReturnValue(providerMock);
  const registry = { get: registryGet } as unknown as FiscalProviderRegistry;

  const cfg = {
    apiUrl: 'https://api.checkbox.ua',
    credentials: { licenseKey: 'LIC', pinCode: '1234' },
  };
  const resolveActive = vi.fn();
  const resolveByCode = vi.fn();
  const providerConfig = { resolveActive, resolveByCode } as unknown as ProviderConfigService;

  const activeCfg = (over: Record<string, unknown> = {}) => ({
    provider: 'checkbox',
    apiUrl: cfg.apiUrl,
    credentials: cfg.credentials,
    shiftMode: 'MANUAL',
    ...over,
  });

  const okShiftRow = (over: Record<string, unknown> = {}) => ({
    id: 'shift-1',
    status: 'OPEN',
    cashRegisterId: 'reg-1',
    provider: 'checkbox',
    checkboxShiftId: 'cbx-1',
    openedAt: new Date('2026-09-06T08:00:00Z'),
    closedAt: null,
    zReportId: null,
    cashRegister: { name: 'Каса №1' },
    ...over,
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    registryGet.mockReturnValue(providerMock);
    resolveActive.mockResolvedValue(activeCfg());
    resolveByCode.mockResolvedValue(activeCfg());
    const module = await Test.createTestingModule({
      providers: [
        CashShiftService,
        { provide: PrismaService, useValue: prisma },
        { provide: FiscalProviderRegistry, useValue: registry },
        { provide: ProviderConfigService, useValue: providerConfig },
        // Transparent wrap: логування не змінює control flow (просто виконує fn).
        {
          provide: IntegrationLogService,
          useValue: { wrap: (_ctx: unknown, fn: () => unknown) => fn() },
        },
      ],
    }).compile();
    service = module.get(CashShiftService);
  });

  // ── open ─────────────────────────────────────────────────────────────────
  describe('open', () => {
    it('happy: signIn → openShift → persist OPEN + token + provider + shiftId', async () => {
      cashRegisterFindFirst.mockResolvedValueOnce({ id: 'reg-1' });
      cashShiftFindFirst.mockResolvedValueOnce(null); // no existing OPEN
      signIn.mockResolvedValueOnce({ accessToken: 'tok-x', expiresAt: '2030-01-01' });
      openShift.mockResolvedValueOnce({ providerShiftId: 'cbx-1' });
      cashShiftCreate.mockResolvedValueOnce(okShiftRow());

      const dto = await service.open('org-1', 'br-1', 'user-1');

      expect(signIn).toHaveBeenCalledWith(cfg);
      expect(openShift).toHaveBeenCalledWith(cfg, 'tok-x');
      const createArg = cashShiftCreate.mock.calls[0][0];
      expect(createArg.data).toMatchObject({
        orgId: 'org-1',
        branchId: 'br-1',
        cashRegisterId: 'reg-1',
        provider: 'checkbox',
        checkboxShiftId: 'cbx-1',
        status: 'OPEN',
        openedById: 'user-1',
        checkboxAccessToken: 'tok-x',
      });
      expect(createArg.data.tokenExpiresAt).toBeInstanceOf(Date);
      expect(dto.status).toBe('OPEN');
      expect(dto.checkboxShiftId).toBe('cbx-1');
    });

    it('guard: провайдер не налаштовано (resolveActive→null) → 400, без зовнішнього виклику', async () => {
      resolveActive.mockResolvedValueOnce(null);
      await expect(service.open('org-1', 'br-1')).rejects.toBeInstanceOf(BadRequestException);
      expect(signIn).not.toHaveBeenCalled();
    });

    it('guard: немає каси для філії → 400', async () => {
      cashRegisterFindFirst.mockResolvedValueOnce(null);
      await expect(service.open('org-1', 'br-1')).rejects.toThrow(/Немає каси/);
      expect(signIn).not.toHaveBeenCalled();
    });

    it('guard: вже є OPEN-зміна на касі → 400 "вже відкрита", без зовнішнього виклику', async () => {
      cashRegisterFindFirst.mockResolvedValueOnce({ id: 'reg-1' });
      cashShiftFindFirst.mockResolvedValueOnce({ id: 'existing' });
      await expect(service.open('org-1', 'br-1')).rejects.toThrow(/вже відкрита/);
      expect(signIn).not.toHaveBeenCalled();
    });

    it('P2002-recovery: create кидає P2002 (гонка) → повертає winner OPEN-зміну, НЕ помилку', async () => {
      cashRegisterFindFirst.mockResolvedValueOnce({ id: 'reg-1' });
      cashShiftFindFirst.mockResolvedValueOnce(null); // pre-check: нема OPEN
      signIn.mockResolvedValueOnce({ accessToken: 'tok', expiresAt: undefined });
      openShift.mockResolvedValueOnce({ providerShiftId: 'cbx-race' });
      cashShiftCreate.mockRejectedValueOnce(P2002); // partial-unique race
      cashShiftFindFirst.mockResolvedValueOnce(
        okShiftRow({ id: 'winner', checkboxShiftId: 'cbx-winner' }),
      );

      const dto = await service.open('org-1', 'br-1');
      expect(dto.id).toBe('winner');
      expect(dto.checkboxShiftId).toBe('cbx-winner');
    });

    it('P2002-recovery mutation-guard: winner null → rethrow P2002', async () => {
      cashRegisterFindFirst.mockResolvedValueOnce({ id: 'reg-1' });
      cashShiftFindFirst.mockResolvedValueOnce(null);
      signIn.mockResolvedValueOnce({ accessToken: 'tok' });
      openShift.mockResolvedValueOnce({ providerShiftId: 'cbx' });
      cashShiftCreate.mockRejectedValueOnce(P2002);
      cashShiftFindFirst.mockResolvedValueOnce(null); // winner не знайдено
      await expect(service.open('org-1', 'br-1')).rejects.toBe(P2002);
    });

    it('non-P2002 помилка create → пробрасується (не ковтається)', async () => {
      cashRegisterFindFirst.mockResolvedValueOnce({ id: 'reg-1' });
      cashShiftFindFirst.mockResolvedValueOnce(null);
      signIn.mockResolvedValueOnce({ accessToken: 'tok' });
      openShift.mockResolvedValueOnce({ providerShiftId: 'cbx' });
      cashShiftCreate.mockRejectedValueOnce(new Error('DB down'));
      await expect(service.open('org-1', 'br-1')).rejects.toThrow('DB down');
    });

    it('tenant-scoped: cashRegister/existing findFirst усі містять orgId', async () => {
      cashRegisterFindFirst.mockResolvedValueOnce({ id: 'reg-1' });
      cashShiftFindFirst.mockResolvedValueOnce(null);
      signIn.mockResolvedValueOnce({ accessToken: 'tok' });
      openShift.mockResolvedValueOnce({ providerShiftId: 'cbx' });
      cashShiftCreate.mockResolvedValueOnce(okShiftRow());
      await service.open('org-9', 'br-1');
      expect(resolveActive).toHaveBeenCalledWith('org-9', 'br-1', 'FISCAL');
      expect(cashRegisterFindFirst.mock.calls[0][0].where).toMatchObject({ orgId: 'org-9' });
      expect(cashShiftFindFirst.mock.calls[0][0].where).toMatchObject({ orgId: 'org-9' });
    });

    it('секрет: dto з open() НЕ містить checkboxAccessToken', async () => {
      cashRegisterFindFirst.mockResolvedValueOnce({ id: 'reg-1' });
      cashShiftFindFirst.mockResolvedValueOnce(null);
      signIn.mockResolvedValueOnce({ accessToken: 'super-secret-tok' });
      openShift.mockResolvedValueOnce({ providerShiftId: 'cbx' });
      cashShiftCreate.mockResolvedValueOnce(
        okShiftRow({ checkboxAccessToken: 'super-secret-tok' }),
      );
      const dto = await service.open('org-1', 'br-1');
      expect(JSON.stringify(dto)).not.toContain('super-secret-tok');
      expect(dto).not.toHaveProperty('checkboxAccessToken');
    });
  });

  // ── close ────────────────────────────────────────────────────────────────
  describe('close', () => {
    it('OPEN → CAS-claim → ensureToken → closeShift → CLOSED + zReportId', async () => {
      cashShiftFindFirst
        .mockResolvedValueOnce(okShiftRow({ status: 'OPEN' })) // close() head
        .mockResolvedValueOnce({
          branchId: 'br-1',
          provider: 'checkbox',
          checkboxAccessToken: 'tok',
          tokenExpiresAt: new Date(Date.now() + 3_600_000),
        }); // ensureToken read
      cashShiftUpdateMany.mockResolvedValueOnce({ count: 1 }); // Bug #711 CAS-claim wins
      closeShift.mockResolvedValueOnce({ zReportId: 'z-99' });
      cashShiftUpdate.mockResolvedValueOnce(
        okShiftRow({ status: 'CLOSED', closedAt: new Date(), zReportId: 'z-99' }),
      );

      const dto = await service.close('org-1', 'shift-1');
      // Bug #711: claim CAS обов'язково несе status:'OPEN' + orgId → атомарне захоплення.
      expect(cashShiftUpdateMany.mock.calls[0][0].where).toMatchObject({
        id: 'shift-1',
        orgId: 'org-1',
        status: 'OPEN',
      });
      expect(cashShiftUpdateMany.mock.calls[0][0].data).toMatchObject({ status: 'CLOSED' });
      // Зовнішній Z-звіт викликається ПІСЛЯ виграного claim.
      expect(closeShift).toHaveBeenCalledWith(cfg, 'tok');
      expect(cashShiftUpdate.mock.calls[0][0].data).toMatchObject({ zReportId: 'z-99' });
      expect(dto.status).toBe('CLOSED');
      expect(dto.zReportId).toBe('z-99');
    });

    // Bug #711 mutation-verified: якщо прибрати CAS-claim (лишити stale-read update),
    // конкурентний close() пройшов би head-guard і пробив би ДРУГИЙ Z-звіт. Тут claim програний
    // (count:0) → 400 і closeShift НЕ викликається (жодного другого фіскального Z-звіту).
    it('CAS-claim програний (concurrent close виграв) → 400, closeShift НЕ викликається', async () => {
      cashShiftFindFirst.mockResolvedValueOnce(okShiftRow({ status: 'OPEN' })); // head бачить OPEN
      cashShiftUpdateMany.mockResolvedValueOnce({ count: 0 }); // інший close уже захопив
      await expect(service.close('org-1', 'shift-1')).rejects.toThrow(/вже закрита/);
      expect(closeShift).not.toHaveBeenCalled(); // критично: жодного другого Z-звіту
      expect(cashShiftUpdate).not.toHaveBeenCalled();
    });

    // Bug #711: зовнішній Z-звіт упав ПІСЛЯ виграного claim → відкат claim у OPEN (щоб касир
    // повторив), інакше зміна лишилась би CLOSED без реального Z-звіту.
    it('claim виграний, але closeShift кидає → revert у OPEN + rethrow', async () => {
      cashShiftFindFirst
        .mockResolvedValueOnce(okShiftRow({ status: 'OPEN' }))
        .mockResolvedValueOnce({
          branchId: 'br-1',
          provider: 'checkbox',
          checkboxAccessToken: 'tok',
          tokenExpiresAt: new Date(Date.now() + 3_600_000),
        });
      cashShiftUpdateMany
        .mockResolvedValueOnce({ count: 1 }) // claim wins
        .mockResolvedValueOnce({ count: 1 }); // revert
      closeShift.mockRejectedValueOnce(new Error('Checkbox 503'));

      await expect(service.close('org-1', 'shift-1')).rejects.toThrow(/Checkbox 503/);
      // Другий updateMany = revert: CLOSED (+zReportId:null) → OPEN.
      const revertCall = cashShiftUpdateMany.mock.calls[1][0];
      expect(revertCall.where).toMatchObject({ id: 'shift-1', orgId: 'org-1', status: 'CLOSED' });
      expect(revertCall.data).toMatchObject({ status: 'OPEN', closedAt: null });
    });

    it('already CLOSED → 400 "вже закрита", без зовнішнього виклику', async () => {
      cashShiftFindFirst.mockResolvedValueOnce(okShiftRow({ status: 'CLOSED' }));
      await expect(service.close('org-1', 'shift-1')).rejects.toThrow(/вже закрита/);
      expect(closeShift).not.toHaveBeenCalled();
      expect(cashShiftUpdateMany).not.toHaveBeenCalled();
    });

    it('cross-org / неіснуюча зміна → NotFound', async () => {
      cashShiftFindFirst.mockResolvedValueOnce(null);
      await expect(service.close('org-OTHER', 'shift-1')).rejects.toBeInstanceOf(NotFoundException);
      expect(cashShiftFindFirst.mock.calls[0][0].where).toMatchObject({
        id: 'shift-1',
        orgId: 'org-OTHER',
      });
    });
  });

  // ── ensureToken ────────────────────────────────────────────────────────────
  describe('ensureToken', () => {
    const shiftTokenRow = (over: Record<string, unknown> = {}) => ({
      branchId: 'br-1',
      provider: 'checkbox',
      checkboxAccessToken: 'cached-tok',
      tokenExpiresAt: new Date(Date.now() + 5 * 60_000),
      ...over,
    });

    it('валідний токен (>30s до expiry) → кеш, БЕЗ re-sign-in', async () => {
      cashShiftFindFirst.mockResolvedValueOnce(shiftTokenRow());
      const res = await service.ensureToken('org-1', 'shift-1');
      expect(res.token).toBe('cached-tok');
      expect(res.provider).toBe(providerMock);
      expect(signIn).not.toHaveBeenCalled();
      expect(cashShiftUpdate).not.toHaveBeenCalled();
    });

    it('mutation-verify boundary: expiry рівно на межі +30s (не строго > ) → re-sign-in', async () => {
      const now = 1_000_000_000_000;
      vi.spyOn(Date, 'now').mockReturnValue(now);
      cashShiftFindFirst.mockResolvedValueOnce(
        shiftTokenRow({ checkboxAccessToken: 'old', tokenExpiresAt: new Date(now + 30_000) }),
      );
      signIn.mockResolvedValueOnce({ accessToken: 'fresh' });
      cashShiftUpdate.mockResolvedValueOnce({});
      const res = await service.ensureToken('org-1', 'shift-1');
      expect(signIn).toHaveBeenCalledTimes(1);
      expect(res.token).toBe('fresh');
      vi.restoreAllMocks();
    });

    it('boundary: expiry на +30_001ms (щойно за межею) → кеш, БЕЗ re-sign-in', async () => {
      const now = 1_000_000_000_000;
      vi.spyOn(Date, 'now').mockReturnValue(now);
      cashShiftFindFirst.mockResolvedValueOnce(
        shiftTokenRow({ checkboxAccessToken: 'cached', tokenExpiresAt: new Date(now + 30_001) }),
      );
      const res = await service.ensureToken('org-1', 'shift-1');
      expect(res.token).toBe('cached');
      expect(signIn).not.toHaveBeenCalled();
      vi.restoreAllMocks();
    });

    it('протух → re-sign-in + update рядка з новим токеном', async () => {
      cashShiftFindFirst.mockResolvedValueOnce(
        shiftTokenRow({
          checkboxAccessToken: 'expired',
          tokenExpiresAt: new Date(Date.now() - 60_000),
        }),
      );
      signIn.mockResolvedValueOnce({ accessToken: 'renewed' });
      cashShiftUpdate.mockResolvedValueOnce({});
      const res = await service.ensureToken('org-1', 'shift-1');
      expect(res.token).toBe('renewed');
      expect(cashShiftUpdate.mock.calls[0][0].data.checkboxAccessToken).toBe('renewed');
    });

    it('токен відсутній (null) → re-sign-in', async () => {
      cashShiftFindFirst.mockResolvedValueOnce(
        shiftTokenRow({ checkboxAccessToken: null, tokenExpiresAt: null }),
      );
      signIn.mockResolvedValueOnce({ accessToken: 'new' });
      cashShiftUpdate.mockResolvedValueOnce({});
      const res = await service.ensureToken('org-1', 'shift-1');
      expect(res.token).toBe('new');
    });

    it('провайдер зник (resolveByCode→null) → 400', async () => {
      cashShiftFindFirst.mockResolvedValueOnce(
        shiftTokenRow({ checkboxAccessToken: null, tokenExpiresAt: null }),
      );
      resolveByCode.mockResolvedValueOnce(null);
      await expect(service.ensureToken('org-1', 'shift-1')).rejects.toThrow(
        /неможливо оновити токен/,
      );
    });

    it('cross-org shiftId → NotFound (tenant-scoped findFirst)', async () => {
      cashShiftFindFirst.mockResolvedValueOnce(null);
      await expect(service.ensureToken('org-OTHER', 'shift-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(cashShiftFindFirst.mock.calls[0][0].where).toMatchObject({
        id: 'shift-1',
        orgId: 'org-OTHER',
      });
    });

    it('resolveByCode викликається з provider зміни (не «активний»)', async () => {
      cashShiftFindFirst.mockResolvedValueOnce(shiftTokenRow({ provider: 'vchasno' }));
      registryGet.mockReturnValue(providerMock);
      await service.ensureToken('org-1', 'shift-1');
      expect(resolveByCode).toHaveBeenCalledWith('org-1', 'br-1', 'FISCAL', 'vchasno');
    });
  });

  // ── refreshToken ─────────────────────────────────────────────────────────
  describe('refreshToken', () => {
    it('mutation-verify: updateMany where містить orgId (не безумовна інвалідація по id)', async () => {
      cashShiftUpdateMany.mockResolvedValueOnce({ count: 1 });
      cashShiftFindFirst.mockResolvedValueOnce({
        branchId: 'br-1',
        provider: 'checkbox',
        checkboxAccessToken: null,
        tokenExpiresAt: null,
      });
      signIn.mockResolvedValueOnce({ accessToken: 'refreshed' });
      cashShiftUpdate.mockResolvedValueOnce({});

      const res = await service.refreshToken('org-7', 'shift-1');
      expect(cashShiftUpdateMany).toHaveBeenCalledWith({
        where: { id: 'shift-1', orgId: 'org-7' },
        data: { tokenExpiresAt: new Date(0) },
      });
      expect(res.token).toBe('refreshed');
    });

    it('cross-org id → updateMany no-op (не інвалідує чужий токен) → ensureToken NotFound', async () => {
      cashShiftUpdateMany.mockResolvedValueOnce({ count: 0 });
      cashShiftFindFirst.mockResolvedValueOnce(null);
      await expect(service.refreshToken('org-OTHER', 'foreign-shift')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(cashShiftUpdateMany.mock.calls[0][0].where).toMatchObject({
        id: 'foreign-shift',
        orgId: 'org-OTHER',
      });
    });
  });

  // ── getCurrent ─────────────────────────────────────────────────────────────
  describe('getCurrent', () => {
    it('OPEN → dto + pendingReceipts scoped до THIS branch (workOrder.branchId)', async () => {
      cashShiftFindFirst.mockResolvedValueOnce(okShiftRow());
      paymentCount.mockResolvedValueOnce(3);
      const dto = await service.getCurrent('org-1', 'br-1');
      expect(dto?.pendingReceipts).toBe(3);
      expect(paymentCount).toHaveBeenCalledWith({
        where: { orgId: 'org-1', fiscalStatus: 'QUEUED', workOrder: { branchId: 'br-1' } },
      });
    });

    it('per-branch: дві філії з QUEUED — count запитано саме для запитаної філії', async () => {
      cashShiftFindFirst.mockResolvedValueOnce(okShiftRow());
      paymentCount.mockResolvedValueOnce(5);
      await service.getCurrent('org-1', 'br-2');
      const where = paymentCount.mock.calls[0][0].where;
      expect(where.workOrder).toEqual({ branchId: 'br-2' });
    });

    it('немає OPEN-зміни → null (count не запитується)', async () => {
      cashShiftFindFirst.mockResolvedValueOnce(null);
      const dto = await service.getCurrent('org-1', 'br-1');
      expect(dto).toBeNull();
      expect(paymentCount).not.toHaveBeenCalled();
    });

    it('tenant-scoped: shift findFirst містить orgId+branchId+status OPEN', async () => {
      cashShiftFindFirst.mockResolvedValueOnce(okShiftRow());
      paymentCount.mockResolvedValueOnce(0);
      await service.getCurrent('org-1', 'br-1');
      expect(cashShiftFindFirst.mock.calls[0][0].where).toMatchObject({
        orgId: 'org-1',
        branchId: 'br-1',
        status: 'OPEN',
        deletedAt: null,
      });
    });

    it('секрет: dto з getCurrent НЕ містить checkboxAccessToken', async () => {
      cashShiftFindFirst.mockResolvedValueOnce(okShiftRow());
      paymentCount.mockResolvedValueOnce(0);
      const dto = await service.getCurrent('org-1', 'br-1');
      expect(dto).not.toHaveProperty('checkboxAccessToken');
      expect(JSON.stringify(dto)).not.toMatch(/token/i);
    });
  });
});
