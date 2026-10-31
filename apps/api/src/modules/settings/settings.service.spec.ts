import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import { SettingsService, orgSettingsCacheKey, schemaFingerprint } from './settings.service';
import { PrismaService } from '../../prisma/prisma.service';
import { REDIS_CLIENT } from '../../redis/redis.module';
import { NbuFetchScheduler } from '../exchange-rates/nbu-fetch.scheduler';
import { BankStatementPullScheduler } from '../bank-statements/bank-statement-pull.scheduler';
import { AuditService } from '../audit/audit.service';
import type { HostLookup } from '../../common/utils/url-guard';
import { HOST_LOOKUP } from '../../common/utils/host-lookup.token';
import {
  publicHostLookup,
  loopbackHostLookup,
  metadataHostLookup,
} from '../../common/testing/host-lookup';

/**
 * C1b audit: TaxRate CRUD (ставки ПДВ — money-critical) пишуть AuditEvent з коректними
 * аргументами. Регресія-gap: раніше жоден тест не асертив, що createTaxRate/updateTaxRate/
 * deleteTaxRate → audit.record(orgId, 'TaxRate', id, action, userId). Load-bearing: аудит
 * зміни ставок ПДВ — фінансовий compliance-слід. Best-effort .catch не має ламати мутацію.
 */
describe('SettingsService — C1b audit TaxRate', () => {
  let service: SettingsService;
  let auditRecord: ReturnType<typeof vi.fn>;
  let prisma: {
    taxRate: {
      create: ReturnType<typeof vi.fn>;
      findFirst: ReturnType<typeof vi.fn>;
      findFirstOrThrow: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
    };
    $transaction: ReturnType<typeof vi.fn>;
    $queryRaw: ReturnType<typeof vi.fn>;
  };

  const ORG = 'org-1';
  const USER = 'user-7';

  beforeEach(async () => {
    auditRecord = vi.fn().mockResolvedValue(undefined);
    prisma = {
      taxRate: {
        create: vi.fn().mockResolvedValue({
          id: 'tax-new',
          name: 'ПДВ 20%',
          rate: 20,
          isDefault: false,
          isActive: true,
        }),
        findFirst: vi.fn(),
        findFirstOrThrow: vi.fn().mockResolvedValue({
          id: 'tax-1',
          name: 'ПДВ 20%',
          rate: 20,
          isDefault: false,
          isActive: true,
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: vi.fn(),
      // BR-INV-027: ставку не застосовано в документах — число змінювати можна.
      $queryRaw: vi.fn().mockResolvedValue([]),
    };
    const module = await Test.createTestingModule({
      providers: [
        SettingsService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: { record: auditRecord } },
        { provide: REDIS_CLIENT, useValue: { get: vi.fn(), set: vi.fn(), del: vi.fn() } },
        { provide: NbuFetchScheduler, useValue: { rescheduleForOrg: vi.fn() } },
        { provide: BankStatementPullScheduler, useValue: { rescheduleForOrg: vi.fn() } },
        { provide: HOST_LOOKUP, useValue: publicHostLookup },
      ],
    }).compile();
    service = module.get(SettingsService);
  });

  it('createTaxRate (non-default) → record(orgId, TaxRate, id, CREATE, userId)', async () => {
    await service.createTaxRate(ORG, { name: 'ПДВ 20%', rate: 20 }, USER);
    await Promise.resolve();
    expect(auditRecord).toHaveBeenCalledTimes(1);
    const args = auditRecord.mock.calls[0];
    expect(args[0]).toBe(ORG);
    expect(args[1]).toBe('TaxRate');
    expect(args[2]).toBe('tax-new'); // id з create-результату
    expect(args[3]).toBe('CREATE');
    expect(args[4]).toBe(USER);
  });

  it('updateTaxRate (non-default) → record(orgId, TaxRate, id, UPDATE, userId)', async () => {
    prisma.taxRate.findFirst.mockResolvedValueOnce({ rate: 20 });
    await service.updateTaxRate(ORG, 'tax-1', { rate: 7 }, USER);
    await Promise.resolve();
    expect(auditRecord).toHaveBeenCalledTimes(1);
    const args = auditRecord.mock.calls[0];
    expect(args[1]).toBe('TaxRate');
    expect(args[2]).toBe('tax-1');
    expect(args[3]).toBe('UPDATE');
    expect(args[4]).toBe(USER);
  });

  it('deleteTaxRate → record(orgId, TaxRate, id, DELETE, userId) з old-data назвою', async () => {
    prisma.taxRate.findFirst.mockResolvedValueOnce({
      id: 'tax-1',
      name: 'ПДВ 20%',
      isDefault: false,
    });
    await service.deleteTaxRate(ORG, 'tax-1', USER);
    await Promise.resolve();
    expect(auditRecord).toHaveBeenCalledTimes(1);
    const args = auditRecord.mock.calls[0];
    expect(args[1]).toBe('TaxRate');
    expect(args[2]).toBe('tax-1');
    expect(args[3]).toBe('DELETE');
    expect(args[4]).toBe(USER);
    expect(args[5]).toMatchObject({ name: 'ПДВ 20%' }); // old-data
  });

  it('userId відсутній → record() НЕ викликається (best-effort gate)', async () => {
    await service.createTaxRate(ORG, { name: 'ПДВ 0%', rate: 0 }, undefined);
    await Promise.resolve();
    expect(auditRecord).not.toHaveBeenCalled();
  });

  it('best-effort: record() reject НЕ ламає основну мутацію (createTaxRate повертає результат)', async () => {
    auditRecord.mockRejectedValueOnce(new Error('audit db down'));
    const res = await service.createTaxRate(ORG, { name: 'ПДВ 20%', rate: 20 }, USER);
    // мутація успішна попри падіння аудиту
    expect(res).toMatchObject({ id: 'tax-new', rate: 20 });
  });
});

/**
 * Bug #951: PATCH /settings/branch/:id писав у `audit_events.diff` ліцензійний ключ і PIN ПРРО,
 * токен monobank і ключ SMS відкритим текстом, а `GET /audit` (OWNER/ADMIN/ACCOUNTANT) віддавав їх
 * назад — хоча самі налаштування ці поля не повертають (write-only, шифрування at-rest).
 */
describe('SettingsService — аудит налаштувань філії маскує секрети (Bug #951)', () => {
  let service: SettingsService;
  let auditRecord: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    auditRecord = vi.fn().mockResolvedValue(undefined);
    const prisma = {
      garageBranch: { findFirst: vi.fn().mockResolvedValue({ id: 'b-1' }) },
      branchSettings: {
        // Налаштувань філії ще немає — зміни адреси API немає з чим порівнювати.
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockResolvedValue({ branchId: 'b-1', orgId: 'org-1', workDays: [] }),
      },
    };
    const module = await Test.createTestingModule({
      providers: [
        SettingsService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: { record: auditRecord } },
        { provide: REDIS_CLIENT, useValue: { get: vi.fn(), set: vi.fn(), del: vi.fn() } },
        { provide: NbuFetchScheduler, useValue: { rescheduleForOrg: vi.fn() } },
        { provide: BankStatementPullScheduler, useValue: { rescheduleForOrg: vi.fn() } },
        { provide: HOST_LOOKUP, useValue: publicHostLookup },
      ],
    }).compile();
    service = module.get(SettingsService);
  });

  it('секрети в дифі — маскою, решта полів — як є', async () => {
    await service.updateBranchSettings(
      'org-1',
      'b-1',
      {
        checkboxApiUrl: 'https://api.checkbox.ua',
        checkboxLicenseKey: 'LIC-SECRET-1',
        checkboxPinCode: '4321',
        monobankToken: 'mono-secret',
        smsApiKey: 'sms-secret',
        fiscalEnabled: true,
      },
      'user-7',
    );
    expect(auditRecord).toHaveBeenCalledTimes(1);
    const newData = auditRecord.mock.calls[0]![6] as Record<string, unknown>;
    expect(newData).toEqual({
      checkboxApiUrl: 'https://api.checkbox.ua',
      checkboxLicenseKey: '***',
      checkboxPinCode: '***',
      monobankToken: '***',
      smsApiKey: '***',
      fiscalEnabled: true,
    });
    expect(JSON.stringify(auditRecord.mock.calls[0])).not.toMatch(/SECRET|secret|4321/);
  });

  it('ключ прибрали (null) — у сліді лишається null', async () => {
    await service.updateBranchSettings(
      'org-1',
      'b-1',
      { checkboxLicenseKey: null as unknown as string },
      'user-7',
    );
    const newData = auditRecord.mock.calls[0]![6] as Record<string, unknown>;
    expect(newData).toEqual({ checkboxLicenseKey: null });
  });
});

/**
 * Зміна адреси API скидає збережені write-only ключі (рішення власника 2026-10-23, TECH-DEBT §19.6):
 * інакше OWNER/ADMIN у два кроки — змінити `checkboxApiUrl`, потім «Перевірити» чи пробити чек —
 * відправив би ключ ліцензії ПРРО на свій сервер, не знаючи його.
 */
describe('SettingsService — зміна адреси API скидає збережені ключі провайдера', () => {
  let service: SettingsService;
  let upsert: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    upsert = vi.fn().mockResolvedValue({ branchId: 'b-1', orgId: 'org-1', workDays: [] });
    const prisma = {
      garageBranch: { findFirst: vi.fn().mockResolvedValue({ id: 'b-1' }) },
      branchSettings: {
        findUnique: vi.fn().mockResolvedValue({
          checkboxApiUrl: 'https://api.checkbox.ua',
          monobankApiUrl: null,
        }),
        upsert,
      },
    };
    const module = await Test.createTestingModule({
      providers: [
        SettingsService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: { record: vi.fn().mockResolvedValue(undefined) } },
        { provide: REDIS_CLIENT, useValue: { get: vi.fn(), set: vi.fn(), del: vi.fn() } },
        { provide: NbuFetchScheduler, useValue: { rescheduleForOrg: vi.fn() } },
        { provide: BankStatementPullScheduler, useValue: { rescheduleForOrg: vi.fn() } },
        { provide: HOST_LOOKUP, useValue: publicHostLookup },
      ],
    }).compile();
    service = module.get(SettingsService);
  });

  const updateArg = () => (upsert.mock.calls[0]![0] as { update: Record<string, unknown> }).update;

  it('нова адреса Checkbox без ключа → ключ і PIN скинуто в null', async () => {
    await service.updateBranchSettings('org-1', 'b-1', {
      checkboxApiUrl: 'https://collector.example',
    });
    expect(updateArg()).toEqual({
      checkboxApiUrl: 'https://collector.example',
      checkboxLicenseKey: null,
      checkboxPinCode: null,
    });
  });

  it('нова адреса разом із новим ключем → ключ лишається, PIN скинуто', async () => {
    await service.updateBranchSettings('org-1', 'b-1', {
      checkboxApiUrl: 'https://collector.example',
      checkboxLicenseKey: 'NEW-KEY',
    });
    expect(updateArg()).toEqual({
      checkboxApiUrl: 'https://collector.example',
      checkboxLicenseKey: 'NEW-KEY',
      checkboxPinCode: null,
    });
  });

  it('та сама адреса з кінцевим слешем → ключі не чіпаються', async () => {
    await service.updateBranchSettings('org-1', 'b-1', {
      checkboxApiUrl: 'https://api.checkbox.ua/',
    });
    expect(updateArg()).toEqual({ checkboxApiUrl: 'https://api.checkbox.ua/' });
  });

  it('адреса monobank із null на власну → токен скинуто', async () => {
    await service.updateBranchSettings('org-1', 'b-1', { monobankApiUrl: 'https://mono.example' });
    expect(updateArg()).toEqual({ monobankApiUrl: 'https://mono.example', monobankToken: null });
  });
});

/**
 * guards: BR-SEC-SSRF — updateBranchSettings валідує будь-яке поле `*ApiUrl` з dto ПІСЛЯ DNS і
 * до upsert. Публічне ім'я на приватну/метадані-адресу → BadRequestException (400), запис не
 * відбувається; літеральна приватна адреса блокується теж; публічна — проходить.
 */
describe('SettingsService — SSRF-перевірка адрес провайдера при збереженні філії', () => {
  let upsert: ReturnType<typeof vi.fn>;

  const makeService = async (lookup: HostLookup): Promise<SettingsService> => {
    upsert = vi.fn().mockResolvedValue({ branchId: 'b-1', orgId: 'org-1', workDays: [] });
    const prisma = {
      garageBranch: { findFirst: vi.fn().mockResolvedValue({ id: 'b-1' }) },
      branchSettings: {
        findUnique: vi.fn().mockResolvedValue({ checkboxApiUrl: null, monobankApiUrl: null }),
        upsert,
      },
    };
    const module = await Test.createTestingModule({
      providers: [
        SettingsService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: { record: vi.fn().mockResolvedValue(undefined) } },
        { provide: REDIS_CLIENT, useValue: { get: vi.fn(), set: vi.fn(), del: vi.fn() } },
        { provide: NbuFetchScheduler, useValue: { rescheduleForOrg: vi.fn() } },
        { provide: BankStatementPullScheduler, useValue: { rescheduleForOrg: vi.fn() } },
        { provide: HOST_LOOKUP, useValue: lookup },
      ],
    }).compile();
    return module.get(SettingsService);
  };

  it('checkboxApiUrl → loopback (DNS) → 400, upsert НЕ викликається', async () => {
    const service = await makeService(loopbackHostLookup);
    await expect(
      service.updateBranchSettings('org-1', 'b-1', { checkboxApiUrl: 'https://rebind.example' }),
    ).rejects.toThrow(/loopback|127\.0\.0\.1/i);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('monobankApiUrl → cloud-metadata (DNS) → 400, upsert НЕ викликається', async () => {
    const service = await makeService(metadataHostLookup);
    await expect(
      service.updateBranchSettings('org-1', 'b-1', { monobankApiUrl: 'https://rebind.example' }),
    ).rejects.toThrow();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('літеральний loopback checkboxApiUrl → 400 (без DNS)', async () => {
    const service = await makeService(publicHostLookup);
    await expect(
      service.updateBranchSettings('org-1', 'b-1', { checkboxApiUrl: 'http://127.0.0.1:8080' }),
    ).rejects.toThrow();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('публічна адреса → проходить, upsert викликається', async () => {
    const service = await makeService(publicHostLookup);
    await service.updateBranchSettings('org-1', 'b-1', {
      checkboxApiUrl: 'https://api.checkbox.ua',
    });
    expect(upsert).toHaveBeenCalledTimes(1);
  });
});

/**
 * Кеш налаштувань організації переживає оновлення схеми (2026-10-18, review блоку «Постачальники
 * API»): у Redis лежав DTO без полів `supplier*` → `supplierOfferTtlMinutes` undefined →
 * `POST /supplier-offers/search` 400 перші ≤5 хв після оновлення. Ключ кешу несе відбиток переліку
 * скалярних полів моделі — після міграції старий запис не читається.
 */
describe('SettingsService — кеш налаштувань організації з відбитком схеми', () => {
  const ORG = 'org-1';
  let service: SettingsService;
  let store: Map<string, string>;
  let findUnique: ReturnType<typeof vi.fn>;

  const row = {
    orgId: ORG,
    currency: 'UAH',
    vatMode: 'NONE',
    defaultVatRateId: null,
    invoiceDueDays: 14,
    autoArchiveDays: 90,
    defaultWarrantyDays: 30,
    requireClientApproval: false,
    allowPartialPayment: true,
    brandTheme: 'blue',
    costMethod: 'FIFO',
    followUpActive: false,
    followUpDays: 90,
    uiFeatures: {},
    recalcPlannedHoursFromLines: true,
    recalcActualHoursFromLines: true,
    supplierOrderSendMode: 'MANUAL',
    supplierAnalogPolicy: 'CATALOG_ONLY',
    supplierDefaultStrategy: 'OPTIMAL',
    supplierOptimalPriceWeight: 0.7,
    supplierAllowSplit: true,
    supplierAllowAnalogsInAuto: false,
    supplierOfferTtlMinutes: 60,
    supplierOfferRetentionDays: 7,
    supplierOrderPollIntervalMinutes: 30,
    supplierCatalogSyncIntervalMinutes: 360,
    supplierUnknownDeliveryDays: 7,
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };

  beforeEach(async () => {
    store = new Map();
    findUnique = vi.fn().mockResolvedValue(row);
    const module = await Test.createTestingModule({
      providers: [
        SettingsService,
        { provide: PrismaService, useValue: { organisationSettings: { findUnique } } },
        { provide: AuditService, useValue: { record: vi.fn() } },
        {
          provide: REDIS_CLIENT,
          useValue: {
            get: vi.fn((k: string) => Promise.resolve(store.get(k) ?? null)),
            set: vi.fn((k: string, v: string) => {
              store.set(k, v);
              return Promise.resolve('OK');
            }),
            del: vi.fn((k: string) => Promise.resolve(store.delete(k) ? 1 : 0)),
          },
        },
        { provide: NbuFetchScheduler, useValue: { rescheduleForOrg: vi.fn() } },
        { provide: BankStatementPullScheduler, useValue: { rescheduleForOrg: vi.fn() } },
        { provide: HOST_LOOKUP, useValue: publicHostLookup },
      ],
    }).compile();
    service = module.get(SettingsService);
  });

  it('запис старого формату (без полів supplier*) не читається — повні поля з БД', async () => {
    const stale = { ...row, updatedAt: row.updatedAt.toISOString() } as Record<string, unknown>;
    for (const k of Object.keys(stale)) if (k.startsWith('supplier')) delete stale[k];
    // старий ключ без відбитка — саме так кеш жив до оновлення
    store.set(`settings:org:${ORG}`, JSON.stringify(stale));

    const s = await service.getOrganisationSettings(ORG);

    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(s.supplierOfferTtlMinutes).toBe(60);
    expect(s.supplierUnknownDeliveryDays).toBe(7);
  });

  it('ключ кешу несе відбиток поточної схеми; повторне читання — з кешу', async () => {
    expect(orgSettingsCacheKey(ORG)).toBe(
      `settings:org:${schemaFingerprint(Prisma.OrganisationSettingsScalarFieldEnum)}:${ORG}`,
    );
    await service.getOrganisationSettings(ORG);
    const again = await service.getOrganisationSettings(ORG);
    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(again.supplierOfferTtlMinutes).toBe(60);
    expect(store.has(orgSettingsCacheKey(ORG))).toBe(true);
  });

  it('нова колонка в моделі змінює відбиток (старі записи стають невидимими)', () => {
    const before = schemaFingerprint({ a: 'a', b: 'b' });
    expect(schemaFingerprint({ b: 'b', a: 'a' })).toBe(before);
    expect(schemaFingerprint({ a: 'a', b: 'b', c: 'c' })).not.toBe(before);
  });

  it('invalidateOrgCache видаляє саме версійний ключ', async () => {
    await service.getOrganisationSettings(ORG);
    await service.invalidateOrgCache(ORG);
    expect(store.has(orgSettingsCacheKey(ORG))).toBe(false);
  });
});
