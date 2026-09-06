import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ProviderConfigService } from './provider-config.service';

/**
 * ProviderConfigService — резолвер активного провайдера (config + legacy-fallback) + CRUD/активація.
 * Доводимо:
 *  - resolveActive бере enabled-конфіг; при відсутності → legacy BranchSettings (checkbox/monobank).
 *  - resolveActive парсить credentials JSON; secrets не тікають у view.
 *  - activate: ексклюзивність (вимкнути інших + увімкнути активного, атомарно) + guard creds.
 *  - upsert: credentials write-only merge (порожнє не затирає); hasCredentials у view.
 *  - getBranchConfigs НЕ повертає сирі credentials.
 */
describe('ProviderConfigService', () => {
  let svc: ProviderConfigService;
  let prisma: {
    branchProviderConfig: {
      findFirst: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
      upsert: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
    };
    branchSettings: { findFirst: ReturnType<typeof vi.fn> };
    garageBranch: { findFirst: ReturnType<typeof vi.fn> };
    $transaction: ReturnType<typeof vi.fn>;
  };

  const ORG = 'org-1';
  const BRANCH = 'branch-1';

  beforeEach(() => {
    prisma = {
      branchProviderConfig: {
        findFirst: vi.fn(),
        findMany: vi.fn(),
        upsert: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      branchSettings: { findFirst: vi.fn() },
      garageBranch: { findFirst: vi.fn().mockResolvedValue({ id: BRANCH }) },
      $transaction: vi.fn().mockImplementation(async (ops: Promise<unknown>[]) => Promise.all(ops)),
    };
    svc = new ProviderConfigService(prisma as never);
  });

  describe('resolveActive', () => {
    it('бере enabled-конфіг і парсить credentials JSON', async () => {
      prisma.branchProviderConfig.findFirst.mockResolvedValue({
        provider: 'liqpay',
        apiUrl: null,
        credentials: JSON.stringify({ publicKey: 'PUB', privateKey: 'PRIV' }),
        shiftMode: 'MANUAL',
      });
      const r = await svc.resolveActive(ORG, BRANCH, 'PAYMENT');
      expect(r).toEqual({
        provider: 'liqpay',
        apiUrl: null,
        credentials: { publicKey: 'PUB', privateKey: 'PRIV' },
        shiftMode: 'MANUAL',
      });
      // enabled=true у where.
      expect(prisma.branchProviderConfig.findFirst.mock.calls[0][0].where).toMatchObject({
        orgId: ORG,
        branchId: BRANCH,
        kind: 'PAYMENT',
        enabled: true,
        deletedAt: null,
      });
    });

    it('немає конфіга → legacy fallback на BranchSettings.monobank*', async () => {
      prisma.branchProviderConfig.findFirst.mockResolvedValue(null);
      prisma.branchSettings.findFirst.mockResolvedValue({
        fiscalEnabled: false,
        monobankToken: 'LEGACY-T',
        monobankApiUrl: 'https://api.monobank.ua',
      });
      const r = await svc.resolveActive(ORG, BRANCH, 'PAYMENT');
      expect(r).toEqual({
        provider: 'monobank',
        apiUrl: 'https://api.monobank.ua',
        credentials: { token: 'LEGACY-T' },
        shiftMode: 'MANUAL',
      });
    });

    it('немає конфіга + legacy checkbox → FISCAL fallback з license/pin/cashRegister', async () => {
      prisma.branchProviderConfig.findFirst.mockResolvedValue(null);
      prisma.branchSettings.findFirst.mockResolvedValue({
        fiscalEnabled: true,
        checkboxApiUrl: 'https://api.checkbox.ua',
        checkboxLicenseKey: 'LIC',
        checkboxPinCode: 'PIN',
        checkboxCashRegisterId: 'CR',
        shiftMode: 'AUTO_OPEN',
      });
      const r = await svc.resolveActive(ORG, BRANCH, 'FISCAL');
      expect(r).toEqual({
        provider: 'checkbox',
        apiUrl: 'https://api.checkbox.ua',
        credentials: { licenseKey: 'LIC', pinCode: 'PIN', cashRegisterId: 'CR' },
        shiftMode: 'AUTO_OPEN',
      });
    });

    it('legacy FISCAL: fiscalEnabled=false → null (не активний)', async () => {
      prisma.branchProviderConfig.findFirst.mockResolvedValue(null);
      prisma.branchSettings.findFirst.mockResolvedValue({
        fiscalEnabled: false,
        checkboxLicenseKey: 'LIC',
      });
      expect(await svc.resolveActive(ORG, BRANCH, 'FISCAL')).toBeNull();
    });

    it('немає ні конфіга, ні BranchSettings → null', async () => {
      prisma.branchProviderConfig.findFirst.mockResolvedValue(null);
      prisma.branchSettings.findFirst.mockResolvedValue(null);
      expect(await svc.resolveActive(ORG, BRANCH, 'PAYMENT')).toBeNull();
    });
  });

  describe('activate (ексклюзивність)', () => {
    it('вимикає інших + вмикає активного (атомарно), guard creds ok', async () => {
      prisma.branchProviderConfig.findFirst.mockResolvedValue({
        id: 'c1',
        credentials: JSON.stringify({ token: 'T' }),
      });
      const res = await svc.activate(ORG, BRANCH, 'PAYMENT', 'monobank');
      expect(res).toEqual({ activated: 'monobank' });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      // 1) вимкнути інших (provider not monobank), 2) увімкнути monobank
      const disableCall = prisma.branchProviderConfig.updateMany.mock.calls[0][0];
      expect(disableCall.where).toMatchObject({
        orgId: ORG,
        branchId: BRANCH,
        kind: 'PAYMENT',
        provider: { not: 'monobank' },
      });
      expect(disableCall.data).toEqual({ enabled: false });
      const enableCall = prisma.branchProviderConfig.updateMany.mock.calls[1][0];
      expect(enableCall.where).toMatchObject({ provider: 'monobank' });
      expect(enableCall.data).toEqual({ enabled: true });
    });

    it('провайдер без збережених creds → 400 (спершу введіть креди)', async () => {
      prisma.branchProviderConfig.findFirst.mockResolvedValue({ id: 'c1', credentials: null });
      await expect(svc.activate(ORG, BRANCH, 'PAYMENT', 'monobank')).rejects.toThrow(
        /введіть креди/,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('провайдер не налаштовано → NotFound', async () => {
      prisma.branchProviderConfig.findFirst.mockResolvedValue(null);
      await expect(svc.activate(ORG, BRANCH, 'PAYMENT', 'liqpay')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('філія не в org → NotFound (branch-in-org guard)', async () => {
      prisma.garageBranch.findFirst.mockResolvedValue(null);
      await expect(svc.activate(ORG, BRANCH, 'PAYMENT', 'monobank')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('upsertConfig (creds write-only merge)', () => {
    it('нові непорожні поля мерджаться у наявні; порожнє не затирає', async () => {
      prisma.branchProviderConfig.findFirst.mockResolvedValue({
        id: 'c1',
        credentials: JSON.stringify({ publicKey: 'OLD-PUB', privateKey: 'OLD-PRIV' }),
      });
      prisma.branchProviderConfig.upsert.mockResolvedValue({
        provider: 'liqpay',
        enabled: false,
        apiUrl: null,
        shiftMode: 'MANUAL',
        credentials: JSON.stringify({ publicKey: 'NEW-PUB', privateKey: 'OLD-PRIV' }),
      });
      await svc.upsertConfig(ORG, BRANCH, 'PAYMENT', {
        provider: 'liqpay',
        credentials: { publicKey: 'NEW-PUB', privateKey: '' }, // privateKey порожнє → зберегти старе
      });
      const upsertArg = prisma.branchProviderConfig.upsert.mock.calls[0][0];
      const mergedCreds = JSON.parse(upsertArg.update.credentials);
      expect(mergedCreds).toEqual({ publicKey: 'NEW-PUB', privateKey: 'OLD-PRIV' });
    });

    it('view повертає hasCredentials, НЕ сирі credentials', async () => {
      prisma.branchProviderConfig.findFirst.mockResolvedValue(null);
      prisma.branchProviderConfig.upsert.mockResolvedValue({
        provider: 'monobank',
        enabled: false,
        apiUrl: null,
        shiftMode: 'MANUAL',
        credentials: JSON.stringify({ token: 'SECRET' }),
      });
      const view = await svc.upsertConfig(ORG, BRANCH, 'PAYMENT', {
        provider: 'monobank',
        credentials: { token: 'SECRET' },
      });
      expect(view.hasCredentials).toBe(true);
      expect(JSON.stringify(view)).not.toContain('SECRET');
      expect(Object.keys(view)).toEqual([
        'provider',
        'enabled',
        'apiUrl',
        'shiftMode',
        'hasCredentials',
      ]);
    });
  });

  describe('getBranchConfigs', () => {
    it('НЕ повертає сирі credentials — лише hasCredentials', async () => {
      prisma.branchProviderConfig.findMany.mockResolvedValue([
        {
          provider: 'checkbox',
          enabled: true,
          apiUrl: null,
          shiftMode: 'MANUAL',
          credentials: JSON.stringify({ licenseKey: 'SECRET' }),
        },
        {
          provider: 'vchasno',
          enabled: false,
          apiUrl: null,
          shiftMode: 'MANUAL',
          credentials: null,
        },
      ]);
      const res = await svc.getBranchConfigs(ORG, BRANCH, 'FISCAL');
      expect(res[0].hasCredentials).toBe(true);
      expect(res[1].hasCredentials).toBe(false);
      expect(JSON.stringify(res)).not.toContain('SECRET');
    });
  });
});
