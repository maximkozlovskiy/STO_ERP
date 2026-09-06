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

    // ── Bug #692 (CRITICAL): enabled-конфіг БЕЗ кредів (сід-рядок міграції) → legacy-fallback ──
    it('Bug #692: enabled-конфіг з credentials=NULL (сід міграції) → legacy-fallback того ж провайдера (checkbox)', async () => {
      // Міграція сідить enabled=true checkbox-рядок з credentials=NULL; секрети ще у BranchSettings.
      prisma.branchProviderConfig.findFirst.mockResolvedValue({
        provider: 'checkbox',
        apiUrl: null,
        credentials: null, // сід лишив NULL
        shiftMode: 'AUTO_OPEN',
      });
      prisma.branchSettings.findFirst.mockResolvedValue({
        fiscalEnabled: true,
        checkboxApiUrl: 'https://api.checkbox.ua',
        checkboxLicenseKey: 'LEGACY-LIC',
        checkboxPinCode: 'LEGACY-PIN',
        checkboxCashRegisterId: 'CR',
        shiftMode: 'MANUAL',
      });
      const r = await svc.resolveActive(ORG, BRANCH, 'FISCAL');
      // Креди беруться з legacy (інакше провайдер кинув би «не задано ключ/PIN» → зміна не відкриється).
      expect(r).not.toBeNull();
      expect(r!.provider).toBe('checkbox');
      expect(r!.credentials).toEqual({
        licenseKey: 'LEGACY-LIC',
        pinCode: 'LEGACY-PIN',
        cashRegisterId: 'CR',
      });
      // apiUrl/shiftMode беруться з config-рядка (пріоритет нового над legacy).
      expect(r!.shiftMode).toBe('AUTO_OPEN');
      // MUTATION-VERIFY: без hasCreds-guard resolveActive повернув би credentials={} → signIn throw.
    });

    it('Bug #692: enabled-конфіг з credentials=NULL, PAYMENT monobank → legacy token', async () => {
      prisma.branchProviderConfig.findFirst.mockResolvedValue({
        provider: 'monobank',
        apiUrl: null,
        credentials: null,
        shiftMode: 'MANUAL',
      });
      prisma.branchSettings.findFirst.mockResolvedValue({
        fiscalEnabled: false,
        monobankToken: 'LEGACY-MONO',
        monobankApiUrl: 'https://api.monobank.ua',
      });
      const r = await svc.resolveActive(ORG, BRANCH, 'PAYMENT');
      expect(r!.credentials).toEqual({ token: 'LEGACY-MONO' });
    });

    it('Bug #692: enabled-конфіг без кредів, а legacy — ІНШИЙ провайдер → null (не плутати креди)', async () => {
      // Активовано vchasno (config, creds порожні), а legacy = checkbox → креди checkbox НЕ підходять vchasno.
      prisma.branchProviderConfig.findFirst.mockResolvedValue({
        provider: 'vchasno',
        apiUrl: null,
        credentials: null,
        shiftMode: 'MANUAL',
      });
      prisma.branchSettings.findFirst.mockResolvedValue({
        fiscalEnabled: true,
        checkboxLicenseKey: 'LIC',
        checkboxPinCode: 'PIN',
        shiftMode: 'MANUAL',
      });
      expect(await svc.resolveActive(ORG, BRANCH, 'FISCAL')).toBeNull();
    });

    it('branchId невідомий → бере будь-який enabled у org (без branchId у where)', async () => {
      prisma.branchProviderConfig.findFirst.mockResolvedValue({
        provider: 'liqpay',
        apiUrl: null,
        credentials: JSON.stringify({ publicKey: 'P', privateKey: 'S' }),
        shiftMode: 'MANUAL',
      });
      await svc.resolveActive(ORG, undefined, 'PAYMENT');
      expect(prisma.branchProviderConfig.findFirst.mock.calls[0][0].where).not.toHaveProperty(
        'branchId',
      );
    });
  });

  // ── resolveByCode (для processor/зміни — конкретний провайдер, ігнорує enabled) ────────
  describe('resolveByCode', () => {
    it('config з кредами → повертає (НЕ фільтрує по enabled — зміна могла відкритись вимкненим)', async () => {
      // Сценарій: зміна відкрита checkbox, потім активували vchasno → checkbox тепер enabled=false,
      // але sell у стару зміну має йти checkbox-ом. resolveByCode НЕ фільтрує enabled.
      prisma.branchProviderConfig.findFirst.mockResolvedValue({
        provider: 'checkbox',
        apiUrl: null,
        credentials: JSON.stringify({ licenseKey: 'L', pinCode: 'P' }),
        shiftMode: 'MANUAL',
      });
      const r = await svc.resolveByCode(ORG, BRANCH, 'FISCAL', 'checkbox');
      expect(r!.provider).toBe('checkbox');
      expect(r!.credentials).toEqual({ licenseKey: 'L', pinCode: 'P' });
      // where НЕ містить enabled.
      expect(prisma.branchProviderConfig.findFirst.mock.calls[0][0].where).not.toHaveProperty(
        'enabled',
      );
      expect(prisma.branchProviderConfig.findFirst.mock.calls[0][0].where).toMatchObject({
        orgId: ORG,
        kind: 'FISCAL',
        provider: 'checkbox',
      });
    });

    it('config БЕЗ кредів + legacy того ж провайдера → legacy креди', async () => {
      prisma.branchProviderConfig.findFirst.mockResolvedValue({
        provider: 'checkbox',
        apiUrl: null,
        credentials: null,
        shiftMode: 'MANUAL',
      });
      prisma.branchSettings.findFirst.mockResolvedValue({
        fiscalEnabled: true,
        checkboxLicenseKey: 'LEG-L',
        checkboxPinCode: 'LEG-P',
        shiftMode: 'MANUAL',
      });
      const r = await svc.resolveByCode(ORG, BRANCH, 'FISCAL', 'checkbox');
      expect(r!.credentials).toEqual({ licenseKey: 'LEG-L', pinCode: 'LEG-P' });
    });

    it('немає config; legacy — ІНШИЙ провайдер (default checkbox), питаємо vchasno → null', async () => {
      prisma.branchProviderConfig.findFirst.mockResolvedValue(null);
      prisma.branchSettings.findFirst.mockResolvedValue({
        fiscalEnabled: true,
        checkboxLicenseKey: 'LIC',
        shiftMode: 'MANUAL',
      });
      expect(await svc.resolveByCode(ORG, BRANCH, 'FISCAL', 'vchasno')).toBeNull();
    });

    it('немає config; legacy — той самий провайдер (checkbox) → legacy', async () => {
      prisma.branchProviderConfig.findFirst.mockResolvedValue(null);
      prisma.branchSettings.findFirst.mockResolvedValue({
        fiscalEnabled: true,
        checkboxApiUrl: null,
        checkboxLicenseKey: 'LIC',
        checkboxPinCode: 'PIN',
        shiftMode: 'MANUAL',
      });
      const r = await svc.resolveByCode(ORG, BRANCH, 'FISCAL', 'checkbox');
      expect(r!.provider).toBe('checkbox');
    });
  });

  // ── parseCreds robustness ─────────────────────────────────────────────────────────
  describe('parseCreds (битий JSON не валить)', () => {
    it('битий credentials JSON → {} (getBranchConfigs не кидає, hasCredentials=false)', async () => {
      prisma.branchProviderConfig.findMany.mockResolvedValue([
        {
          provider: 'checkbox',
          enabled: true,
          apiUrl: null,
          shiftMode: 'MANUAL',
          credentials: '{битий', // не валідний JSON
        },
      ]);
      const res = await svc.getBranchConfigs(ORG, BRANCH, 'FISCAL');
      expect(res[0].hasCredentials).toBe(false); // {} → нема кредів, не crash
    });

    it('битий JSON у resolveActive → падає у legacy (не crash)', async () => {
      prisma.branchProviderConfig.findFirst.mockResolvedValue({
        provider: 'monobank',
        apiUrl: null,
        credentials: 'not-json',
        shiftMode: 'MANUAL',
      });
      prisma.branchSettings.findFirst.mockResolvedValue({
        fiscalEnabled: false,
        monobankToken: 'MONO',
        monobankApiUrl: null,
      });
      const r = await svc.resolveActive(ORG, BRANCH, 'PAYMENT');
      expect(r!.credentials).toEqual({ token: 'MONO' });
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

    it('kind-незалежність: активація FISCAL-провайдера НЕ чіпає PAYMENT-конфіги (kind у обох where)', async () => {
      prisma.branchProviderConfig.findFirst.mockResolvedValue({
        id: 'c1',
        credentials: JSON.stringify({ licenseKey: 'L', pinCode: 'P' }),
      });
      await svc.activate(ORG, BRANCH, 'FISCAL', 'checkbox');
      // Обидва updateMany скоуплені kind='FISCAL' → monobank/liqpay (PAYMENT) не зачеплені.
      const disableCall = prisma.branchProviderConfig.updateMany.mock.calls[0][0];
      const enableCall = prisma.branchProviderConfig.updateMany.mock.calls[1][0];
      expect(disableCall.where.kind).toBe('FISCAL');
      expect(enableCall.where.kind).toBe('FISCAL');
      // MUTATION-VERIFY: прибрати kind з where → активація ПРРО вимкнула б активний платіжний шлюз.
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
