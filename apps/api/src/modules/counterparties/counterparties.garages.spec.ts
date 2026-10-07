/**
 * CounterpartiesService — гаражі клієнта: інваріант «рівно один гараж за замовчуванням»
 *
 * Аспект BR-CP-011: при soft-delete гаража з `isDefault: true` наступний (найстаріший
 * активний) стає default у тій самій транзакції — дзеркало promote головного договору
 * (BR-CP-004). Заодно — зворотний бік інваріанта: новий default знімає прапорець з решти.
 */

import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { CounterpartiesService } from './counterparties.service';
import { PrismaService } from '../../prisma/prisma.service';
import { DocumentNumberService } from '../document-number/document-number.service';
import { AuditService } from '../audit/audit.service';
import type { PrismaModelMock } from '../../common/testing/prisma-mock';
import { statusesProvider } from './counterparties.spec-fixture';

describe('CounterpartiesService — гаражі (isDefault)', () => {
  let service: CounterpartiesService;
  let tx: { customerGarage: PrismaModelMock };
  let prisma: {
    counterparty: PrismaModelMock;
    customerGarage: PrismaModelMock;
    $transaction: ReturnType<typeof vi.fn>;
  };

  const garageRow = {
    id: 'g-new',
    counterpartyId: 'cp-1',
    name: 'Другий',
    address: null,
    notes: null,
    isDefault: true,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  };

  beforeEach(async () => {
    tx = {
      customerGarage: {
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findFirst: vi.fn().mockResolvedValue({ id: 'g-next' }),
        create: vi.fn().mockResolvedValue(garageRow),
      },
    };
    prisma = {
      counterparty: { findFirst: vi.fn().mockResolvedValue({ id: 'cp-1' }) },
      customerGarage: { findFirst: vi.fn() },
      $transaction: vi
        .fn()
        .mockImplementation(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx)),
    };

    const module = await Test.createTestingModule({
      providers: [
        CounterpartiesService,
        { provide: PrismaService, useValue: prisma },
        { provide: DocumentNumberService, useValue: { next: vi.fn() } },
        { provide: AuditService, useValue: { record: vi.fn().mockResolvedValue(undefined) } },
        statusesProvider(),
      ],
    }).compile();

    service = module.get(CounterpartiesService);
  });

  // guards: BR-CP-011
  it('removeGarage: видалення default-гаража → найстаріший активний сусід стає default (у тій самій tx)', async () => {
    prisma.customerGarage.findFirst.mockResolvedValueOnce({ id: 'g-old', isDefault: true });

    await service.removeGarage('org-1', 'cp-1', 'g-old');

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    // soft-delete, не фізичне видалення
    expect(tx.customerGarage.update).toHaveBeenNthCalledWith(1, {
      where: { id: 'g-old', orgId: 'org-1' },
      data: { deletedAt: expect.any(Date) },
    });
    // наступний — того ж контрагента й org, активний, не сам видалений, найстаріший
    expect(tx.customerGarage.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { orgId: 'org-1', counterpartyId: 'cp-1', deletedAt: null, id: { not: 'g-old' } },
        orderBy: { createdAt: 'asc' },
      }),
    );
    expect(tx.customerGarage.update).toHaveBeenNthCalledWith(2, {
      where: { id: 'g-next', orgId: 'org-1' },
      data: { isDefault: true },
    });
  });

  // guards: BR-CP-011
  it('removeGarage: видалення НЕ default-гаража → нікого не промотує', async () => {
    prisma.customerGarage.findFirst.mockResolvedValueOnce({ id: 'g-2', isDefault: false });

    await service.removeGarage('org-1', 'cp-1', 'g-2');

    expect(tx.customerGarage.update).toHaveBeenCalledTimes(1);
    expect(tx.customerGarage.findFirst).not.toHaveBeenCalled();
  });

  it('removeGarage: default був єдиним гаражем → soft-delete без promote (нема кого)', async () => {
    prisma.customerGarage.findFirst.mockResolvedValueOnce({ id: 'g-only', isDefault: true });
    tx.customerGarage.findFirst.mockResolvedValueOnce(null);

    await service.removeGarage('org-1', 'cp-1', 'g-only');

    expect(tx.customerGarage.update).toHaveBeenCalledTimes(1);
  });

  it('removeGarage: гараж не цього контрагента/org → NotFound, транзакція не починається', async () => {
    prisma.customerGarage.findFirst.mockResolvedValueOnce(null);

    await expect(service.removeGarage('org-1', 'cp-1', 'g-foreign')).rejects.toThrow(
      NotFoundException,
    );
    expect(prisma.customerGarage.findFirst.mock.calls[0][0].where).toEqual({
      id: 'g-foreign',
      counterpartyId: 'cp-1',
      orgId: 'org-1',
      deletedAt: null,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('createGarage з isDefault:true → знімає default з решти гаражів контрагента', async () => {
    await service.createGarage('org-1', 'cp-1', { name: 'Другий', isDefault: true } as never);

    expect(tx.customerGarage.updateMany).toHaveBeenCalledWith({
      where: { orgId: 'org-1', counterpartyId: 'cp-1', isDefault: true, deletedAt: null },
      data: { isDefault: false },
    });
    expect(tx.customerGarage.create).toHaveBeenCalledWith({
      data: { orgId: 'org-1', counterpartyId: 'cp-1', name: 'Другий', isDefault: true },
    });
  });

  it('createGarage без isDefault → чужий default не чіпає', async () => {
    await service.createGarage('org-1', 'cp-1', { name: 'Другий' } as never);

    expect(tx.customerGarage.updateMany).not.toHaveBeenCalled();
  });
});
