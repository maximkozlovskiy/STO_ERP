import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CashShiftService } from './cash-shift.service';
import { CheckboxClient } from './checkbox.client';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * ПРРО Крок 2 — CashShiftService (0 тестів на цей файл до цієї сесії).
 * Покриває load-bearing інваріанти грошей/безпеки:
 *  - open: happy (sign-in→openShift→persist OPEN+token+checkboxShiftId); guard fiscal/creds/каса;
 *    existing OPEN→400; P2002-recovery повертає winner OPEN-зміну (mutation-verified).
 *  - close: OPEN→ensureToken→closeShift→CLOSED+zReportId; already CLOSED→400; cross-org→NotFound.
 *  - ensureToken: валідний токен (30s skew) → кеш, БЕЗ re-sign-in; протух/нема → re-sign-in+update;
 *    нема креди → 400. Skew/expiry boundary mutation-verified.
 *  - refreshToken: updateMany where{id,orgId} — cross-org id → no-op (не інвалідує чужий токен),
 *    потім ensureToken → NotFound. orgId на updateMany mutation-verified.
 *  - getCurrent: OPEN → dto + pendingReceipts scoped до THIS branch (workOrder.branchId); нема→null.
 *  - Секрет: checkboxAccessToken НЕ у жодному DTO-виводі (toDto/getCurrent/open/close).
 */

const P2002 = new Prisma.PrismaClientKnownRequestError('unique', {
  code: 'P2002',
  clientVersion: '5',
});

describe('CashShiftService (ПРРО Крок 2)', () => {
  let service: CashShiftService;

  // Prisma mocks
  const cashShiftFindFirst = vi.fn();
  const cashShiftCreate = vi.fn();
  const cashShiftUpdate = vi.fn();
  const cashShiftUpdateMany = vi.fn();
  const branchSettingsFindFirst = vi.fn();
  const cashRegisterFindFirst = vi.fn();
  const paymentCount = vi.fn();

  const prisma = {
    cashShift: {
      findFirst: cashShiftFindFirst,
      create: cashShiftCreate,
      update: cashShiftUpdate,
      updateMany: cashShiftUpdateMany,
    },
    branchSettings: { findFirst: branchSettingsFindFirst },
    cashRegister: { findFirst: cashRegisterFindFirst },
    payment: { count: paymentCount },
  } as unknown as PrismaService;

  const signInPinCode = vi.fn();
  const openShift = vi.fn();
  const closeShift = vi.fn();
  const checkbox = { signInPinCode, openShift, closeShift } as unknown as CheckboxClient;

  const okShiftRow = (over: Record<string, unknown> = {}) => ({
    id: 'shift-1',
    status: 'OPEN',
    cashRegisterId: 'reg-1',
    checkboxShiftId: 'cbx-1',
    openedAt: new Date('2026-09-06T08:00:00Z'),
    closedAt: null,
    zReportId: null,
    cashRegister: { name: 'Каса №1' },
    ...over,
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        CashShiftService,
        { provide: PrismaService, useValue: prisma },
        { provide: CheckboxClient, useValue: checkbox },
      ],
    }).compile();
    service = module.get(CashShiftService);
  });

  // ── open ─────────────────────────────────────────────────────────────────
  describe('open', () => {
    const goodCreds = {
      fiscalEnabled: true,
      checkboxApiUrl: 'https://api.checkbox.ua',
      checkboxLicenseKey: 'LIC',
      checkboxPinCode: '1234',
    };

    it('happy: sign-in → openShift → persist OPEN + token + checkboxShiftId', async () => {
      branchSettingsFindFirst.mockResolvedValueOnce(goodCreds);
      cashRegisterFindFirst.mockResolvedValueOnce({ id: 'reg-1' });
      cashShiftFindFirst.mockResolvedValueOnce(null); // no existing OPEN
      signInPinCode.mockResolvedValueOnce({ accessToken: 'tok-x', expiresAt: '2030-01-01' });
      openShift.mockResolvedValueOnce({ checkboxShiftId: 'cbx-1' });
      cashShiftCreate.mockResolvedValueOnce(okShiftRow());

      const dto = await service.open('org-1', 'br-1', 'user-1');

      expect(signInPinCode).toHaveBeenCalledWith('https://api.checkbox.ua', 'LIC', '1234');
      expect(openShift).toHaveBeenCalledWith('https://api.checkbox.ua', 'tok-x');
      const createArg = cashShiftCreate.mock.calls[0][0];
      expect(createArg.data).toMatchObject({
        orgId: 'org-1',
        branchId: 'br-1',
        cashRegisterId: 'reg-1',
        checkboxShiftId: 'cbx-1',
        status: 'OPEN',
        openedById: 'user-1',
        checkboxAccessToken: 'tok-x',
      });
      expect(createArg.data.tokenExpiresAt).toBeInstanceOf(Date);
      expect(dto.status).toBe('OPEN');
      expect(dto.checkboxShiftId).toBe('cbx-1');
    });

    it('guard: fiscal вимкнено → 400, без зовнішнього виклику', async () => {
      branchSettingsFindFirst.mockResolvedValueOnce({ ...goodCreds, fiscalEnabled: false });
      await expect(service.open('org-1', 'br-1')).rejects.toBeInstanceOf(BadRequestException);
      expect(signInPinCode).not.toHaveBeenCalled();
    });

    it('guard: немає ключа/PIN → 400', async () => {
      branchSettingsFindFirst.mockResolvedValueOnce({
        fiscalEnabled: true,
        checkboxLicenseKey: null,
        checkboxPinCode: null,
      });
      await expect(service.open('org-1', 'br-1')).rejects.toThrow(/Фіскалізацію не налаштовано/);
      expect(signInPinCode).not.toHaveBeenCalled();
    });

    it('guard: немає branchSettings взагалі → 400', async () => {
      branchSettingsFindFirst.mockResolvedValueOnce(null);
      await expect(service.open('org-1', 'br-1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('guard: немає каси для філії → 400', async () => {
      branchSettingsFindFirst.mockResolvedValueOnce(goodCreds);
      cashRegisterFindFirst.mockResolvedValueOnce(null);
      await expect(service.open('org-1', 'br-1')).rejects.toThrow(/Немає каси/);
      expect(signInPinCode).not.toHaveBeenCalled();
    });

    it('guard: вже є OPEN-зміна на касі → 400 "вже відкрита", без зовнішнього виклику', async () => {
      branchSettingsFindFirst.mockResolvedValueOnce(goodCreds);
      cashRegisterFindFirst.mockResolvedValueOnce({ id: 'reg-1' });
      cashShiftFindFirst.mockResolvedValueOnce({ id: 'existing' });
      await expect(service.open('org-1', 'br-1')).rejects.toThrow(/вже відкрита/);
      expect(signInPinCode).not.toHaveBeenCalled();
    });

    it('P2002-recovery: create кидає P2002 (гонка) → повертає winner OPEN-зміну, НЕ помилку', async () => {
      branchSettingsFindFirst.mockResolvedValueOnce(goodCreds);
      cashRegisterFindFirst.mockResolvedValueOnce({ id: 'reg-1' });
      cashShiftFindFirst.mockResolvedValueOnce(null); // pre-check: нема OPEN
      signInPinCode.mockResolvedValueOnce({ accessToken: 'tok', expiresAt: undefined });
      openShift.mockResolvedValueOnce({ checkboxShiftId: 'cbx-race' });
      cashShiftCreate.mockRejectedValueOnce(P2002); // partial-unique race
      // winner (той, хто виграв гонку) знайдено другим findFirst
      cashShiftFindFirst.mockResolvedValueOnce(
        okShiftRow({ id: 'winner', checkboxShiftId: 'cbx-winner' }),
      );

      const dto = await service.open('org-1', 'br-1');
      expect(dto.id).toBe('winner');
      expect(dto.checkboxShiftId).toBe('cbx-winner');
    });

    it('P2002-recovery mutation-guard: якби recovery-findFirst НЕ виконувався (winner null) → rethrow P2002', async () => {
      // Доводить, що зелений P2002-тест не «фейковий»: без winner помилка НЕ ковтається.
      branchSettingsFindFirst.mockResolvedValueOnce(goodCreds);
      cashRegisterFindFirst.mockResolvedValueOnce({ id: 'reg-1' });
      cashShiftFindFirst.mockResolvedValueOnce(null);
      signInPinCode.mockResolvedValueOnce({ accessToken: 'tok' });
      openShift.mockResolvedValueOnce({ checkboxShiftId: 'cbx' });
      cashShiftCreate.mockRejectedValueOnce(P2002);
      cashShiftFindFirst.mockResolvedValueOnce(null); // winner не знайдено
      await expect(service.open('org-1', 'br-1')).rejects.toBe(P2002);
    });

    it('non-P2002 помилка create → пробрасується (не ковтається)', async () => {
      branchSettingsFindFirst.mockResolvedValueOnce(goodCreds);
      cashRegisterFindFirst.mockResolvedValueOnce({ id: 'reg-1' });
      cashShiftFindFirst.mockResolvedValueOnce(null);
      signInPinCode.mockResolvedValueOnce({ accessToken: 'tok' });
      openShift.mockResolvedValueOnce({ checkboxShiftId: 'cbx' });
      cashShiftCreate.mockRejectedValueOnce(new Error('DB down'));
      await expect(service.open('org-1', 'br-1')).rejects.toThrow('DB down');
    });

    it('tenant-scoped: branchSettings/cashRegister/existing findFirst усі містять orgId', async () => {
      branchSettingsFindFirst.mockResolvedValueOnce(goodCreds);
      cashRegisterFindFirst.mockResolvedValueOnce({ id: 'reg-1' });
      cashShiftFindFirst.mockResolvedValueOnce(null);
      signInPinCode.mockResolvedValueOnce({ accessToken: 'tok' });
      openShift.mockResolvedValueOnce({ checkboxShiftId: 'cbx' });
      cashShiftCreate.mockResolvedValueOnce(okShiftRow());
      await service.open('org-9', 'br-1');
      expect(branchSettingsFindFirst.mock.calls[0][0].where).toMatchObject({ orgId: 'org-9' });
      expect(cashRegisterFindFirst.mock.calls[0][0].where).toMatchObject({ orgId: 'org-9' });
      expect(cashShiftFindFirst.mock.calls[0][0].where).toMatchObject({ orgId: 'org-9' });
    });

    it('секрет: dto з open() НЕ містить checkboxAccessToken', async () => {
      branchSettingsFindFirst.mockResolvedValueOnce(goodCreds);
      cashRegisterFindFirst.mockResolvedValueOnce({ id: 'reg-1' });
      cashShiftFindFirst.mockResolvedValueOnce(null);
      signInPinCode.mockResolvedValueOnce({ accessToken: 'super-secret-tok' });
      openShift.mockResolvedValueOnce({ checkboxShiftId: 'cbx' });
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
    it('OPEN → ensureToken → closeShift → CLOSED + zReportId', async () => {
      cashShiftFindFirst
        .mockResolvedValueOnce(okShiftRow({ status: 'OPEN' })) // close() head
        .mockResolvedValueOnce({
          branchId: 'br-1',
          checkboxAccessToken: 'tok',
          tokenExpiresAt: new Date(Date.now() + 3_600_000),
        }); // ensureToken read
      branchSettingsFindFirst.mockResolvedValueOnce({ checkboxApiUrl: 'https://api.checkbox.ua' });
      closeShift.mockResolvedValueOnce({ zReportId: 'z-99' });
      cashShiftUpdate.mockResolvedValueOnce(
        okShiftRow({ status: 'CLOSED', closedAt: new Date(), zReportId: 'z-99' }),
      );

      const dto = await service.close('org-1', 'shift-1');
      expect(closeShift).toHaveBeenCalledWith('https://api.checkbox.ua', 'tok');
      expect(cashShiftUpdate.mock.calls[0][0].data).toMatchObject({
        status: 'CLOSED',
        zReportId: 'z-99',
      });
      expect(dto.status).toBe('CLOSED');
      expect(dto.zReportId).toBe('z-99');
    });

    it('already CLOSED → 400 "вже закрита", без зовнішнього виклику', async () => {
      cashShiftFindFirst.mockResolvedValueOnce(okShiftRow({ status: 'CLOSED' }));
      await expect(service.close('org-1', 'shift-1')).rejects.toThrow(/вже закрита/);
      expect(closeShift).not.toHaveBeenCalled();
    });

    it('cross-org / неіснуюча зміна → NotFound', async () => {
      cashShiftFindFirst.mockResolvedValueOnce(null);
      await expect(service.close('org-OTHER', 'shift-1')).rejects.toBeInstanceOf(NotFoundException);
      // head findFirst tenant-scoped
      expect(cashShiftFindFirst.mock.calls[0][0].where).toMatchObject({
        id: 'shift-1',
        orgId: 'org-OTHER',
      });
    });
  });

  // ── ensureToken ────────────────────────────────────────────────────────────
  describe('ensureToken', () => {
    it('валідний токен (>30s до expiry) → кеш, БЕЗ re-sign-in', async () => {
      cashShiftFindFirst.mockResolvedValueOnce({
        branchId: 'br-1',
        checkboxAccessToken: 'cached-tok',
        tokenExpiresAt: new Date(Date.now() + 5 * 60_000),
      });
      branchSettingsFindFirst.mockResolvedValueOnce({ checkboxApiUrl: 'https://api.checkbox.ua' });
      const res = await service.ensureToken('org-1', 'shift-1');
      expect(res.token).toBe('cached-tok');
      expect(signInPinCode).not.toHaveBeenCalled();
      expect(cashShiftUpdate).not.toHaveBeenCalled();
    });

    it('mutation-verify boundary: expiry рівно на межі +30s (не строго > ) → re-sign-in', async () => {
      // valid = tokenExpiresAt.getTime() > Date.now()+30_000. Ставимо expiry = now+30_000 РІВНО
      // → НЕ строго більше → протух → re-sign-in. Доводить строгість межі (>, не >=).
      const now = 1_000_000_000_000;
      vi.spyOn(Date, 'now').mockReturnValue(now);
      cashShiftFindFirst.mockResolvedValueOnce({
        branchId: 'br-1',
        checkboxAccessToken: 'old',
        tokenExpiresAt: new Date(now + 30_000), // рівно межа
      });
      branchSettingsFindFirst.mockResolvedValueOnce({
        checkboxApiUrl: 'https://api.checkbox.ua',
        checkboxLicenseKey: 'LIC',
        checkboxPinCode: 'PIN',
      });
      signInPinCode.mockResolvedValueOnce({ accessToken: 'fresh' });
      cashShiftUpdate.mockResolvedValueOnce({});
      const res = await service.ensureToken('org-1', 'shift-1');
      expect(signInPinCode).toHaveBeenCalledTimes(1);
      expect(res.token).toBe('fresh');
      vi.restoreAllMocks();
    });

    it('boundary: expiry на +30_001ms (щойно за межею) → кеш, БЕЗ re-sign-in', async () => {
      const now = 1_000_000_000_000;
      vi.spyOn(Date, 'now').mockReturnValue(now);
      cashShiftFindFirst.mockResolvedValueOnce({
        branchId: 'br-1',
        checkboxAccessToken: 'cached',
        tokenExpiresAt: new Date(now + 30_001),
      });
      branchSettingsFindFirst.mockResolvedValueOnce({ checkboxApiUrl: 'https://api.checkbox.ua' });
      const res = await service.ensureToken('org-1', 'shift-1');
      expect(res.token).toBe('cached');
      expect(signInPinCode).not.toHaveBeenCalled();
      vi.restoreAllMocks();
    });

    it('протух → re-sign-in + update рядка з новим токеном', async () => {
      cashShiftFindFirst.mockResolvedValueOnce({
        branchId: 'br-1',
        checkboxAccessToken: 'expired',
        tokenExpiresAt: new Date(Date.now() - 60_000),
      });
      branchSettingsFindFirst.mockResolvedValueOnce({
        checkboxApiUrl: 'https://api.checkbox.ua',
        checkboxLicenseKey: 'LIC',
        checkboxPinCode: 'PIN',
      });
      signInPinCode.mockResolvedValueOnce({ accessToken: 'renewed' });
      cashShiftUpdate.mockResolvedValueOnce({});
      const res = await service.ensureToken('org-1', 'shift-1');
      expect(res.token).toBe('renewed');
      expect(cashShiftUpdate.mock.calls[0][0].data.checkboxAccessToken).toBe('renewed');
    });

    it('токен відсутній (null) → re-sign-in', async () => {
      cashShiftFindFirst.mockResolvedValueOnce({
        branchId: 'br-1',
        checkboxAccessToken: null,
        tokenExpiresAt: null,
      });
      branchSettingsFindFirst.mockResolvedValueOnce({
        checkboxLicenseKey: 'LIC',
        checkboxPinCode: 'PIN',
      });
      signInPinCode.mockResolvedValueOnce({ accessToken: 'new' });
      cashShiftUpdate.mockResolvedValueOnce({});
      const res = await service.ensureToken('org-1', 'shift-1');
      expect(res.token).toBe('new');
    });

    it('немає креди для re-sign-in → 400', async () => {
      cashShiftFindFirst.mockResolvedValueOnce({
        branchId: 'br-1',
        checkboxAccessToken: null,
        tokenExpiresAt: null,
      });
      branchSettingsFindFirst.mockResolvedValueOnce({
        checkboxLicenseKey: null,
        checkboxPinCode: null,
      });
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
  });

  // ── refreshToken ─────────────────────────────────────────────────────────
  describe('refreshToken', () => {
    it('mutation-verify: updateMany where містить orgId (не безумовна інвалідація по id)', async () => {
      cashShiftUpdateMany.mockResolvedValueOnce({ count: 1 });
      cashShiftFindFirst.mockResolvedValueOnce({
        branchId: 'br-1',
        checkboxAccessToken: null,
        tokenExpiresAt: null,
      });
      branchSettingsFindFirst.mockResolvedValueOnce({
        checkboxLicenseKey: 'LIC',
        checkboxPinCode: 'PIN',
      });
      signInPinCode.mockResolvedValueOnce({ accessToken: 'refreshed' });
      cashShiftUpdate.mockResolvedValueOnce({});

      const res = await service.refreshToken('org-7', 'shift-1');
      expect(cashShiftUpdateMany).toHaveBeenCalledWith({
        where: { id: 'shift-1', orgId: 'org-7' },
        data: { tokenExpiresAt: new Date(0) },
      });
      expect(res.token).toBe('refreshed');
    });

    it('cross-org id → updateMany no-op (не інвалідує чужий токен) → ensureToken NotFound', async () => {
      cashShiftUpdateMany.mockResolvedValueOnce({ count: 0 }); // чужий id: нічого не оновлено
      cashShiftFindFirst.mockResolvedValueOnce(null); // ensureToken не бачить чужу зміну
      await expect(service.refreshToken('org-OTHER', 'foreign-shift')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      // Доводимо: updateMany був tenant-scoped (не безумовний update by id).
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
      // mutation-verify: count filtered by THIS branch, not org-wide
      expect(paymentCount).toHaveBeenCalledWith({
        where: { orgId: 'org-1', fiscalStatus: 'QUEUED', workOrder: { branchId: 'br-1' } },
      });
    });

    it('per-branch: дві філії з QUEUED — count запитано саме для запитаної філії', async () => {
      cashShiftFindFirst.mockResolvedValueOnce(okShiftRow());
      paymentCount.mockResolvedValueOnce(5);
      await service.getCurrent('org-1', 'br-2');
      const where = paymentCount.mock.calls[0][0].where;
      expect(where.workOrder).toEqual({ branchId: 'br-2' }); // НЕ br-1, не org-wide
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
