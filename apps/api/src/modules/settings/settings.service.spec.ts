import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Prisma } from '@prisma/client';
import { SettingsService, orgSettingsCacheKey, schemaFingerprint } from './settings.service';
import { PrismaService } from '../../prisma/prisma.service';
import { REDIS_CLIENT } from '../../redis/redis.module';
import { NbuFetchScheduler } from '../exchange-rates/nbu-fetch.scheduler';
import { BankStatementPullScheduler } from '../bank-statements/bank-statement-pull.scheduler';
import { AuditService } from '../audit/audit.service';
import type { MockInstance } from 'vitest';
import type { HostLookup } from '../../common/utils/url-guard';
import { HOST_LOOKUP } from '../../common/utils/host-lookup.token';
import {
  publicHostLookup,
  loopbackHostLookup,
  metadataHostLookup,
} from '../../common/testing/host-lookup';

/**
 * Bug #665 — regression guard для SettingsService.verifyFiscal
 * (feat(prro): Checkbox ПРРО Крок 1, commit 247cfaec + review-fix).
 *
 * verify робить зовнішній HTTP-виклик до Checkbox для перевірки кредів БЕЗ пробиття чеку.
 * Load-bearing інваріанти (усі mutation-verified):
 *   - невідома філія → NotFoundException;
 *   - ключ не переданий і не збережений → {valid:false} без fetch;
 *   - SSRF-заблокований apiUrl → {valid:false} БЕЗ fetch (validatePublicUrl);
 *   - 3xx redirect (redirect:'manual') → {valid:false} — підозра на SSRF-редірект;
 *   - non-ok → {valid:false};
 *   - success → парсить cash-registers → cashRegisterName;
 *   - КРЕДИ (licenseKey/apiUrl) НІКОЛИ не потрапляють у повернутий об'єкт.
 */
describe('SettingsService.verifyFiscal — Bug #665', () => {
  let service: SettingsService;
  let prisma: {
    garageBranch: { findFirst: ReturnType<typeof vi.fn> };
    branchSettings: { findFirst: ReturnType<typeof vi.fn> };
  };
  let fetchSpy: MockInstance<typeof fetch>;

  const ORG = 'org-1';
  const BRANCH = 'br-1';

  beforeEach(async () => {
    prisma = {
      garageBranch: { findFirst: vi.fn().mockResolvedValue({ id: BRANCH }) },
      branchSettings: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    const module = await Test.createTestingModule({
      providers: [
        SettingsService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: { record: vi.fn().mockResolvedValue(undefined) } },
        {
          provide: REDIS_CLIENT,
          useValue: { get: vi.fn(), set: vi.fn(), del: vi.fn() },
        },
        { provide: NbuFetchScheduler, useValue: { rescheduleForOrg: vi.fn() } },
        { provide: BankStatementPullScheduler, useValue: { rescheduleForOrg: vi.fn() } },
        { provide: HOST_LOOKUP, useValue: publicHostLookup },
      ],
    }).compile();
    service = module.get(SettingsService);
    fetchSpy = vi.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  // Підставний DNS: unit-тест не ходить у мережу, а ім'я «резолвиться» в публічну адресу.
  const publicLookup: HostLookup = () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]);
  const verify = (dto: { apiUrl?: string; licenseKey?: string }, lookup = publicLookup) =>
    service.verifyFiscal(ORG, BRANCH, dto, lookup);

  it('невідома філія → NotFoundException', async () => {
    prisma.garageBranch.findFirst.mockResolvedValue(null);
    await expect(verify({ apiUrl: 'https://api.checkbox.ua', licenseKey: 'k' })).rejects.toThrow(
      NotFoundException,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('ключ не переданий і не збережений → {valid:false} без fetch', async () => {
    prisma.branchSettings.findFirst.mockResolvedValue({
      checkboxLicenseKey: null,
      checkboxApiUrl: null,
    });
    const res = await verify({});
    expect(res).toEqual({ valid: false, error: 'Не вказано ліцензійний ключ' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('SSRF-заблокований apiUrl (cloud metadata) → {valid:false} БЕЗ fetch', async () => {
    const res = await verify({
      apiUrl: 'http://169.254.169.254',
      licenseKey: 'k',
    });
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/Невалідний API URL/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('SSRF: loopback apiUrl → {valid:false} БЕЗ fetch', async () => {
    const res = await verify({
      apiUrl: 'http://127.0.0.1:8080',
      licenseKey: 'k',
    });
    expect(res.valid).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('3xx redirect (redirect:manual) → {valid:false} "перенаправлення"', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response('', { status: 302, headers: { Location: 'http://169.254.169.254/' } }),
    );
    const res = await verify({
      apiUrl: 'https://attacker.example',
      licenseKey: 'k',
    });
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/перенаправлення/);
    // fetch викликано з redirect:'manual'
    const [, init] = fetchSpy.mock.calls[0];
    expect(init).toMatchObject({ redirect: 'manual' });
  });

  it('non-ok (401) → {valid:false} з кодом статусу', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('unauthorized', { status: 401 }));
    const res = await verify({
      apiUrl: 'https://api.checkbox.ua',
      licenseKey: 'bad',
    });
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/401/);
  });

  it('success (results-обгортка) → {valid:true, cashRegisterName}', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ results: [{ title: 'Каса №1' }] }), { status: 200 }),
    );
    const res = await verify({
      apiUrl: 'https://api.checkbox.ua',
      licenseKey: 'good-key',
    });
    expect(res).toEqual({ valid: true, cashRegisterName: 'Каса №1' });
  });

  it('success (голий масив) → {valid:true, cashRegisterName}', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify([{ title: 'Каса А' }]), { status: 200 }),
    );
    const res = await verify({
      apiUrl: 'https://api.checkbox.ua',
      licenseKey: 'good-key',
    });
    expect(res.valid).toBe(true);
    expect(res.cashRegisterName).toBe('Каса А');
  });

  it('success з порожнім списком кас → {valid:true} без cashRegisterName', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ results: [] }), { status: 200 }));
    const res = await verify({
      apiUrl: 'https://api.checkbox.ua',
      licenseKey: 'good-key',
    });
    expect(res.valid).toBe(true);
    expect(res.cashRegisterName).toBeUndefined();
  });

  it('використовує збережений ключ коли body не містить licenseKey', async () => {
    prisma.branchSettings.findFirst.mockResolvedValue({
      checkboxLicenseKey: 'stored-key',
      checkboxApiUrl: 'https://api.checkbox.ua',
    });
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ results: [{ title: 'Каса' }] }), { status: 200 }),
    );
    const res = await verify({});
    expect(res.valid).toBe(true);
    // Authorization несе збережений ключ
    const [, init] = fetchSpy.mock.calls[0];
    const headers = (init as { headers: Record<string, string> }).headers;
    expect(headers.Authorization).toBe('Bearer stored-key');
  });

  it('збережений ключ НЕ йде на іншу адресу з body → {valid:false} без fetch', async () => {
    prisma.branchSettings.findFirst.mockResolvedValue({
      checkboxLicenseKey: 'stored-key',
      checkboxApiUrl: 'https://api.checkbox.ua',
    });
    const res = await verify({ apiUrl: 'https://collector.example' });
    expect(res).toEqual({
      valid: false,
      error: 'Для нової адреси API введіть ліцензійний ключ ще раз',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('та сама збережена адреса з кінцевим слешем → збережений ключ іде на неї', async () => {
    prisma.branchSettings.findFirst.mockResolvedValue({
      checkboxLicenseKey: 'stored-key',
      checkboxApiUrl: 'https://api.checkbox.ua',
    });
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));
    const res = await verify({ apiUrl: 'https://api.checkbox.ua/' });
    expect(res.valid).toBe(true);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.checkbox.ua/api/v1/cash-registers'); // без `//` у шляху
    expect((init as { headers: Record<string, string> }).headers.Authorization).toBe(
      'Bearer stored-key',
    );
  });

  it('публічне ім`я, що резолвиться в loopback → {valid:false} БЕЗ fetch', async () => {
    const toLoopback: HostLookup = () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]);
    const res = await verify({ apiUrl: 'https://rebind.example', licenseKey: 'k' }, toLoopback);
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/127\.0\.0\.1/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('КРЕДИ ніколи не потрапляють у повернутий об`єкт (success)', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ results: [{ title: 'Каса' }] }), { status: 200 }),
    );
    const res = await verify({
      apiUrl: 'https://api.checkbox.ua',
      licenseKey: 'super-secret-key',
    });
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain('super-secret-key');
    expect(res).not.toHaveProperty('licenseKey');
    expect(res).not.toHaveProperty('apiUrl');
  });

  it('КРЕДИ ніколи не потрапляють у повернутий об`єкт (error/non-ok)', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('nope', { status: 403 }));
    const res = await verify({
      apiUrl: 'https://api.checkbox.ua',
      licenseKey: 'super-secret-key',
    });
    expect(JSON.stringify(res)).not.toContain('super-secret-key');
  });

  it('мережевий збій (fetch reject) → {valid:false} з повідомленням, не кидає', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const res = await verify({
      apiUrl: 'https://api.checkbox.ua',
      licenseKey: 'k',
    });
    expect(res.valid).toBe(false);
    expect(res.error).toBe('ECONNREFUSED');
  });
});

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
