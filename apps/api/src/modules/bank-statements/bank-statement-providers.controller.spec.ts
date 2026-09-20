import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { BankStatementProvidersController } from './bank-statement-providers.controller';

/**
 * BankStatementProvidersController — CRUD конфігів + verify + pull-now. Доводимо: list з registry;
 * verify з kind-guard (невідомий код → 400) через integrationLog.wrap; upsert/activate передають
 * kind='BANK'; pull-now делегує scheduler.enqueueImmediate.
 */
describe('BankStatementProvidersController', () => {
  let registry: { list: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };
  let providerConfig: {
    getBranchConfigs: ReturnType<typeof vi.fn>;
    upsertConfig: ReturnType<typeof vi.fn>;
    activate: ReturnType<typeof vi.fn>;
  };
  let integrationLog: { wrap: ReturnType<typeof vi.fn> };
  let scheduler: { enqueueImmediate: ReturnType<typeof vi.fn> };
  let controller: BankStatementProvidersController;

  const ORG = 'org-1';
  const BRANCH = 'br-1';

  beforeEach(() => {
    registry = {
      list: vi.fn().mockReturnValue([{ code: 'privat24', name: 'Приват24' }]),
      get: vi
        .fn()
        .mockReturnValue({ verifyCredentials: vi.fn().mockResolvedValue({ valid: true }) }),
    };
    providerConfig = {
      getBranchConfigs: vi.fn().mockResolvedValue([]),
      upsertConfig: vi.fn().mockResolvedValue({ provider: 'privat24' }),
      activate: vi.fn().mockResolvedValue({ activated: 'privat24' }),
    };
    integrationLog = { wrap: vi.fn((_c: unknown, fn: () => unknown) => fn()) };
    scheduler = { enqueueImmediate: vi.fn().mockResolvedValue({ queued: true }) };
    controller = new BankStatementProvidersController(
      registry as never,
      providerConfig as never,
      integrationLog as never,
      scheduler as never,
    );
  });

  it('list() → registry.list', () => {
    expect(controller.list()).toEqual([{ code: 'privat24', name: 'Приват24' }]);
  });

  it('verify: відомий код → integrationLog.wrap(verifyCredentials)', async () => {
    const res = await controller.verify(ORG, 'privat24', {
      credentials: { merchantId: 'M', token: 'T' },
    });
    expect(res).toEqual({ valid: true });
    expect(integrationLog.wrap).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG, provider: 'privat24', operation: 'verifyCredentials' }),
      expect.any(Function),
    );
  });

  it('verify: невідомий код → 400', async () => {
    registry.get.mockReturnValue(null);
    await expect(controller.verify(ORG, 'nope', { credentials: {} })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('branchConfigs / upsert / activate передають kind=BANK', () => {
    controller.branchConfigs(ORG, BRANCH);
    expect(providerConfig.getBranchConfigs).toHaveBeenCalledWith(ORG, BRANCH, 'BANK');

    controller.upsert(ORG, BRANCH, { provider: 'privat24' });
    expect(providerConfig.upsertConfig).toHaveBeenCalledWith(ORG, BRANCH, 'BANK', {
      provider: 'privat24',
    });

    controller.activate(ORG, BRANCH, { provider: 'privat24' });
    expect(providerConfig.activate).toHaveBeenCalledWith(ORG, BRANCH, 'BANK', 'privat24');
  });

  it('pull-now → scheduler.enqueueImmediate(orgId)', async () => {
    const res = await controller.pullNow(ORG);
    expect(res).toEqual({ queued: true });
    expect(scheduler.enqueueImmediate).toHaveBeenCalledWith(ORG);
  });
});
