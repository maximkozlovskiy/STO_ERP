import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { CounterpartyImportMappingsService } from './counterparty-import-mappings.service';
import type { PrismaService } from '../../prisma/prisma.service';

const ORG = 'org-1';
const CP = 'cp-1';

function makeMocks() {
  return {
    counterparty: { findFirst: vi.fn().mockResolvedValue({ id: CP }) },
    counterpartyImportMapping: {
      findFirst: vi.fn().mockResolvedValue(null),
      upsert: vi.fn(),
    },
  };
}

function makeService(mocks: ReturnType<typeof makeMocks>): CounterpartyImportMappingsService {
  return new CounterpartyImportMappingsService(mocks as unknown as PrismaService);
}

describe('CounterpartyImportMappingsService', () => {
  let mocks: ReturnType<typeof makeMocks>;
  let service: CounterpartyImportMappingsService;

  beforeEach(() => {
    mocks = makeMocks();
    service = makeService(mocks);
  });

  describe('get', () => {
    it('чужий контрагент → NotFoundException', async () => {
      mocks.counterparty.findFirst.mockResolvedValueOnce(null);
      await expect(service.get(ORG, CP)).rejects.toThrow(NotFoundException);
    });

    it('мапінгу ще немає → дефолт startRow=2, колонки null', async () => {
      mocks.counterpartyImportMapping.findFirst.mockResolvedValueOnce(null);
      const res = await service.get(ORG, CP);
      expect(res).toEqual({
        counterpartyId: CP,
        startRow: 2,
        codeCol: null,
        articleCol: null,
        brandCol: null,
        nameCol: null,
        quantityCol: null,
        priceCol: null,
      });
    });

    it('мапінг існує → повертається як DTO', async () => {
      mocks.counterpartyImportMapping.findFirst.mockResolvedValueOnce({
        counterpartyId: CP,
        startRow: 5,
        codeCol: 1,
        articleCol: 2,
        brandCol: null,
        nameCol: 3,
        quantityCol: 4,
        priceCol: 5,
      });
      const res = await service.get(ORG, CP);
      expect(res).toMatchObject({ startRow: 5, codeCol: 1, articleCol: 2, nameCol: 3 });
    });
  });

  describe('upsert', () => {
    it('чужий контрагент → NotFoundException, upsert НЕ викликається', async () => {
      mocks.counterparty.findFirst.mockResolvedValueOnce(null);
      await expect(service.upsert(ORG, CP, { articleCol: 2 })).rejects.toThrow(NotFoundException);
      expect(mocks.counterpartyImportMapping.upsert).not.toHaveBeenCalled();
    });

    it('атомарний upsert по counterpartyId @unique, orgId у create', async () => {
      mocks.counterpartyImportMapping.upsert.mockResolvedValueOnce({
        counterpartyId: CP,
        startRow: 3,
        codeCol: 1,
        articleCol: 2,
        brandCol: 3,
        nameCol: 4,
        quantityCol: 5,
        priceCol: 6,
      });
      const res = await service.upsert(ORG, CP, {
        startRow: 3,
        codeCol: 1,
        articleCol: 2,
        brandCol: 3,
        nameCol: 4,
        quantityCol: 5,
        priceCol: 6,
      });
      expect(mocks.counterpartyImportMapping.upsert).toHaveBeenCalledWith({
        where: { counterpartyId: CP },
        create: expect.objectContaining({
          orgId: ORG,
          counterpartyId: CP,
          startRow: 3,
          articleCol: 2,
        }),
        update: expect.objectContaining({ startRow: 3, articleCol: 2, deletedAt: null }),
      });
      expect(res).toMatchObject({ counterpartyId: CP, articleCol: 2 });
    });

    it('відсутні колонки → null у data, startRow дефолт 2', async () => {
      mocks.counterpartyImportMapping.upsert.mockResolvedValueOnce({
        counterpartyId: CP,
        startRow: 2,
        codeCol: null,
        articleCol: 7,
        brandCol: null,
        nameCol: null,
        quantityCol: null,
        priceCol: null,
      });
      await service.upsert(ORG, CP, { articleCol: 7 });
      const call = mocks.counterpartyImportMapping.upsert.mock.calls[0]![0] as {
        create: Record<string, unknown>;
      };
      expect(call.create).toMatchObject({
        startRow: 2,
        articleCol: 7,
        codeCol: null,
        priceCol: null,
      });
    });
  });
});
