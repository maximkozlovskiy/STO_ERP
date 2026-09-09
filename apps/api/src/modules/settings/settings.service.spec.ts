import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SettingsService } from './settings.service';
import { PrismaService } from '../../prisma/prisma.service';
import { REDIS_CLIENT } from '../../redis/redis.module';
import { NbuFetchScheduler } from '../exchange-rates/nbu-fetch.scheduler';
import { AuditService } from '../audit/audit.service';

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
  let fetchSpy: ReturnType<typeof vi.spyOn>;

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
      ],
    }).compile();
    service = module.get(SettingsService);
    fetchSpy = vi.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('невідома філія → NotFoundException', async () => {
    prisma.garageBranch.findFirst.mockResolvedValue(null);
    await expect(
      service.verifyFiscal(ORG, BRANCH, { apiUrl: 'https://api.checkbox.ua', licenseKey: 'k' }),
    ).rejects.toThrow(NotFoundException);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('ключ не переданий і не збережений → {valid:false} без fetch', async () => {
    prisma.branchSettings.findFirst.mockResolvedValue({
      checkboxLicenseKey: null,
      checkboxApiUrl: null,
    });
    const res = await service.verifyFiscal(ORG, BRANCH, {});
    expect(res).toEqual({ valid: false, error: 'Не вказано ліцензійний ключ' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('SSRF-заблокований apiUrl (cloud metadata) → {valid:false} БЕЗ fetch', async () => {
    const res = await service.verifyFiscal(ORG, BRANCH, {
      apiUrl: 'http://169.254.169.254',
      licenseKey: 'k',
    });
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/Невалідний API URL/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('SSRF: loopback apiUrl → {valid:false} БЕЗ fetch', async () => {
    const res = await service.verifyFiscal(ORG, BRANCH, {
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
    const res = await service.verifyFiscal(ORG, BRANCH, {
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
    const res = await service.verifyFiscal(ORG, BRANCH, {
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
    const res = await service.verifyFiscal(ORG, BRANCH, {
      apiUrl: 'https://api.checkbox.ua',
      licenseKey: 'good-key',
    });
    expect(res).toEqual({ valid: true, cashRegisterName: 'Каса №1' });
  });

  it('success (голий масив) → {valid:true, cashRegisterName}', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify([{ title: 'Каса А' }]), { status: 200 }),
    );
    const res = await service.verifyFiscal(ORG, BRANCH, {
      apiUrl: 'https://api.checkbox.ua',
      licenseKey: 'good-key',
    });
    expect(res.valid).toBe(true);
    expect(res.cashRegisterName).toBe('Каса А');
  });

  it('success з порожнім списком кас → {valid:true} без cashRegisterName', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ results: [] }), { status: 200 }));
    const res = await service.verifyFiscal(ORG, BRANCH, {
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
    const res = await service.verifyFiscal(ORG, BRANCH, {});
    expect(res.valid).toBe(true);
    // Authorization несе збережений ключ
    const [, init] = fetchSpy.mock.calls[0];
    const headers = (init as { headers: Record<string, string> }).headers;
    expect(headers.Authorization).toBe('Bearer stored-key');
  });

  it('КРЕДИ ніколи не потрапляють у повернутий об`єкт (success)', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ results: [{ title: 'Каса' }] }), { status: 200 }),
    );
    const res = await service.verifyFiscal(ORG, BRANCH, {
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
    const res = await service.verifyFiscal(ORG, BRANCH, {
      apiUrl: 'https://api.checkbox.ua',
      licenseKey: 'super-secret-key',
    });
    expect(JSON.stringify(res)).not.toContain('super-secret-key');
  });

  it('мережевий збій (fetch reject) → {valid:false} з повідомленням, не кидає', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const res = await service.verifyFiscal(ORG, BRANCH, {
      apiUrl: 'https://api.checkbox.ua',
      licenseKey: 'k',
    });
    expect(res.valid).toBe(false);
    expect(res.error).toBe('ECONNREFUSED');
  });
});
