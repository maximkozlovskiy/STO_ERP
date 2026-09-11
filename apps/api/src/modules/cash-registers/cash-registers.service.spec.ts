import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { CashRegistersService } from './cash-registers.service';

/**
 * CashRegistersService — фокус на assertFiscalProvider (привʼязка каси до ПРРО-провайдера):
 *  - fiscalProvider без isFiscal=true → 400 (не звичайній касі);
 *  - fiscalProvider без збережених кредів у BranchProviderConfig(FISCAL) → 400 (Bug #731 — семантика
 *    «є креди» ідентична runtime-резолверу: "{}"/'{"k":""}'/"null"/битий JSON → немає кредів);
 *  - привʼязка лише у межах своєї org/філії (findFirst where містить orgId+branchId);
 *  - валідний провайдер із кредами → пропускає create/update.
 */
describe('CashRegistersService — assertFiscalProvider (привʼязка каси до ПРРО)', () => {
  let svc: CashRegistersService;
  let prisma: {
    cashRegister: {
      findFirst: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
      findFirstOrThrow: ReturnType<typeof vi.fn>;
    };
    currency: { findFirst: ReturnType<typeof vi.fn> };
    garageBranch: { findFirst: ReturnType<typeof vi.fn> };
    branchProviderConfig: { findFirst: ReturnType<typeof vi.fn> };
  };
  const cache = { get: vi.fn(), set: vi.fn(), del: vi.fn() };
  const cash = { getBalance: vi.fn().mockResolvedValue(0) };

  const ORG = 'org-1';
  const BRANCH = 'branch-1';
  const CURRENCY = 'cur-1';

  const dtoRow = () => ({
    id: 'cr-1',
    orgId: ORG,
    name: 'Каса',
    currencyId: CURRENCY,
    branchId: BRANCH,
    isFiscal: true,
    fiscalProvider: 'checkbox',
    providerCashRegisterId: null,
    initialBalance: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    currency: { code: 'UAH', symbol: '₴' },
    branch: { name: 'Головна' },
  });

  beforeEach(() => {
    prisma = {
      cashRegister: {
        findFirst: vi.fn(),
        create: vi.fn().mockResolvedValue(dtoRow()),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findFirstOrThrow: vi.fn().mockResolvedValue(dtoRow()),
      },
      currency: { findFirst: vi.fn().mockResolvedValue({ id: CURRENCY }) },
      garageBranch: { findFirst: vi.fn().mockResolvedValue({ id: BRANCH }) },
      branchProviderConfig: { findFirst: vi.fn() },
    };
    cache.get.mockResolvedValue(null);
    cache.set.mockResolvedValue(undefined);
    cache.del.mockResolvedValue(undefined);
    svc = new CashRegistersService(prisma as never, cache as never, cash as never);
  });

  const baseCreate = {
    name: 'Каса',
    currencyId: CURRENCY,
    branchId: BRANCH,
  };

  it('fiscalProvider на НЕфіскальній касі → 400', async () => {
    await expect(
      svc.create(ORG, { ...baseCreate, isFiscal: false, fiscalProvider: 'checkbox' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.cashRegister.create).not.toHaveBeenCalled();
  });

  it('fiscalProvider без конфіга у філії → 400', async () => {
    prisma.branchProviderConfig.findFirst.mockResolvedValue(null);
    await expect(
      svc.create(ORG, { ...baseCreate, isFiscal: true, fiscalProvider: 'checkbox' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('Bug #731: конфіг з порожнім JSON-кредами ("{}") → 400 (як runtime-резолвер)', async () => {
    prisma.branchProviderConfig.findFirst.mockResolvedValue({ credentials: '{}' });
    await expect(
      svc.create(ORG, { ...baseCreate, isFiscal: true, fiscalProvider: 'checkbox' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('Bug #731: креди з порожнім значенням (\'{"licenseKey":""}\') → 400', async () => {
    prisma.branchProviderConfig.findFirst.mockResolvedValue({
      credentials: JSON.stringify({ licenseKey: '' }),
    });
    await expect(
      svc.create(ORG, { ...baseCreate, isFiscal: true, fiscalProvider: 'checkbox' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('Bug #731: битий JSON-креди → 400', async () => {
    prisma.branchProviderConfig.findFirst.mockResolvedValue({ credentials: '{битий' });
    await expect(
      svc.create(ORG, { ...baseCreate, isFiscal: true, fiscalProvider: 'checkbox' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('валідний провайдер із кредами → create проходить + привʼязку записано', async () => {
    prisma.branchProviderConfig.findFirst.mockResolvedValue({
      credentials: JSON.stringify({ licenseKey: 'L', pinCode: 'P' }),
    });
    const res = await svc.create(ORG, {
      ...baseCreate,
      isFiscal: true,
      fiscalProvider: 'checkbox',
    });
    expect(res.fiscalProvider).toBe('checkbox');
    expect(prisma.cashRegister.create).toHaveBeenCalled();
    // Провайдер шукається лише у межах своєї org+філії (tenant isolation).
    expect(prisma.branchProviderConfig.findFirst.mock.calls[0][0].where).toMatchObject({
      orgId: ORG,
      branchId: BRANCH,
      kind: 'FISCAL',
      provider: 'checkbox',
    });
  });

  it('без fiscalProvider (fallback per-branch) → assertFiscalProvider пропускає, конфіг не читає', async () => {
    const res = await svc.create(ORG, { ...baseCreate, isFiscal: true });
    expect(res).toBeTruthy();
    expect(prisma.branchProviderConfig.findFirst).not.toHaveBeenCalled();
  });

  it('Bug #732: PATCH {isFiscal:false} на привʼязаній касі → авто-очищення провайдера, не 400', async () => {
    prisma.cashRegister.findFirst.mockResolvedValue({
      branchId: BRANCH,
      isFiscal: true,
      fiscalProvider: 'checkbox',
    });
    await svc.update(ORG, 'cr-1', { isFiscal: false });
    // Не читаємо конфіг провайдера (guard пропущено для нефіскальної), не кидаємо 400.
    expect(prisma.branchProviderConfig.findFirst).not.toHaveBeenCalled();
    expect(prisma.cashRegister.updateMany).toHaveBeenCalled();
    // Привʼязку авто-очищено у write.
    const writeData = prisma.cashRegister.updateMany.mock.calls[0][0].data;
    expect(writeData.fiscalProvider).toBeNull();
    expect(writeData.providerCashRegisterId).toBeNull();
  });

  it('update: зміна філії з успадкованим провайдером якого нема на новій філії → 400', async () => {
    // existing: фіскальна каса привʼязана до checkbox на старій філії.
    prisma.cashRegister.findFirst.mockResolvedValue({
      branchId: 'branch-OLD',
      isFiscal: true,
      fiscalProvider: 'checkbox',
    });
    // Нова філія валідна, але checkbox там не налаштований.
    prisma.garageBranch.findFirst.mockResolvedValue({ id: 'branch-NEW' });
    prisma.branchProviderConfig.findFirst.mockResolvedValue(null);
    await expect(svc.update(ORG, 'cr-1', { branchId: 'branch-NEW' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.cashRegister.updateMany).not.toHaveBeenCalled();
    // Провайдер перевіряється на НОВІЙ філії.
    expect(prisma.branchProviderConfig.findFirst.mock.calls[0][0].where).toMatchObject({
      branchId: 'branch-NEW',
      provider: 'checkbox',
    });
  });
});
