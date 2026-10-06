/**
 * CounterpartiesService — договори контрагента (contract flows)
 *
 * Виділено з `counterparties.service.spec.ts` (був 1194 рядки, 5 незалежних
 * top-level describe) 2026-10-06. Кейси перенесені ДОСЛІВНО, назви describe не
 * змінені — інакше `fullName` у test-baseline.json розійшовся б.
 *
 * `statusesMock` замінено на `statusesProvider()` з `./counterparties.spec-fixture`:
 * module-level `const` із `vi.fn()` при `isolate: false` течий би між файлами.
 */

import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { CounterpartiesService } from './counterparties.service';
import { PrismaService } from '../../prisma/prisma.service';
import { DocumentNumberService } from '../document-number/document-number.service';
import { AuditService } from '../audit/audit.service';
import type { PrismaModelMock } from '../../common/testing/prisma-mock';
import { statusesProvider } from './counterparties.spec-fixture';

describe('CounterpartiesService — contract flows', () => {
  let service: CounterpartiesService;
  let prisma: {
    counterparty: { create: any; findFirstOrThrow: any; findFirst: any };
    counterpartyContract: PrismaModelMock;
    settlementAccount: { create: any };
    customerGarage: { create: any };
    organisationSettings: { findUnique: any };
    currency: { findFirst: any };
    $transaction: any;
  };
  let docNumbers: { next: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    const tx = {
      counterparty: {
        create: vi.fn().mockResolvedValue({ id: 'cp-1', type: 'SUPPLIER' }),
        findFirstOrThrow: vi.fn().mockResolvedValue({
          id: 'cp-1',
          orgId: 'org-1',
          type: 'SUPPLIER',
          firstName: null,
          lastName: null,
          companyName: 'ТОВ Постачальник',
          edrpou: null,
          vatPayer: false,
          phone: null,
          email: null,
          notes: null,
          legalForm: null,
          legalAddress: null,
          actualAddress: null,
          bankAccount: null,
          bankName: null,
          contactPerson: null,
          taxNumber: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          settlementAccount: { balance: 0 },
        }),
      },
      counterpartyContract: {
        create: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        update: vi.fn().mockResolvedValue({}),
        findFirst: vi.fn(),
      },
      settlementAccount: { create: vi.fn() },
      customerGarage: { create: vi.fn() },
    };

    prisma = {
      counterparty: {
        create: vi.fn(),
        findFirstOrThrow: vi.fn(),
        findFirst: vi.fn(),
      },
      counterpartyContract: {
        create: vi.fn(),
        count: vi.fn().mockResolvedValue(0),
        findFirst: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        update: vi.fn(),
      },
      settlementAccount: { create: vi.fn() },
      customerGarage: { create: vi.fn() },
      // Bug #360: create() читає org currency перед tx → org settings mock.
      organisationSettings: {
        findUnique: vi.fn().mockResolvedValue({ currency: 'UAH' }),
      },
      // Bug #361: createContract/updateContract валідують currencyCode у Currency.
      currency: {
        findFirst: vi.fn().mockResolvedValue({ id: 'cur-1' }),
      },
      // Default: callback signature ($transaction(async tx => ...))
      $transaction: vi.fn().mockImplementation(async (cb: any) => cb(tx)),
    };

    docNumbers = { next: vi.fn().mockResolvedValue('ДГ-2026-000001') };

    const module = await Test.createTestingModule({
      providers: [
        CounterpartiesService,
        { provide: PrismaService, useValue: prisma },
        { provide: DocumentNumberService, useValue: docNumbers },
        { provide: AuditService, useValue: { record: vi.fn().mockResolvedValue(undefined) } },
        statusesProvider(),
      ],
    }).compile();
    service = module.get(CounterpartiesService);

    // expose tx state so tests can assert on its mock fns
    (service as any).__tx = tx;
  });

  describe('create — Bug #348: auto-PURCHASE contract use DocumentNumberService', () => {
    it('SUPPLIER → викликає documentNumberService.next("COUNTERPARTY_AGREEMENT") і використовує отриманий номер', async () => {
      await service.create('org-1', {
        type: 'SUPPLIER',
        companyName: 'ТОВ Постачальник',
      } as any);

      expect(docNumbers.next).toHaveBeenCalledWith('org-1', 'COUNTERPARTY_AGREEMENT');
      const tx = (service as any).__tx;
      expect(tx.counterpartyContract.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            number: 'ДГ-2026-000001',
            contractType: 'PURCHASE',
            isPrimary: true,
          }),
        }),
      );
    });

    it('CLIENT → НЕ викликає documentNumberService.next і НЕ створює договір', async () => {
      await service.create('org-1', { type: 'CLIENT', firstName: 'Іван' } as any);

      expect(docNumbers.next).not.toHaveBeenCalled();
      const tx = (service as any).__tx;
      expect(tx.counterpartyContract.create).not.toHaveBeenCalled();
    });

    it('BOTH → викликає documentNumberService.next і створює PURCHASE контракт', async () => {
      await service.create('org-1', { type: 'BOTH', firstName: 'Іван' } as any);

      expect(docNumbers.next).toHaveBeenCalledWith('org-1', 'COUNTERPARTY_AGREEMENT');
      const tx = (service as any).__tx;
      expect(tx.counterpartyContract.create).toHaveBeenCalled();
    });

    it('regression: договір НЕ створюється з hardcoded number="1"', async () => {
      await service.create('org-1', { type: 'SUPPLIER', companyName: 'ТОВ X' } as any);
      const tx = (service as any).__tx;
      const calls = tx.counterpartyContract.create.mock.calls;
      for (const call of calls) {
        expect(call[0].data.number).not.toBe('1');
      }
    });

    // Bug #360: auto-PURCHASE contract must use org-level currency, not hardcoded 'UAH'.
    it('Bug #360: SUPPLIER → auto-contract успадковує currencyCode з org settings', async () => {
      // Mock org settings → USD як валюта обліку
      prisma.organisationSettings.findUnique.mockResolvedValueOnce({ currency: 'USD' });

      await service.create('org-1', {
        type: 'SUPPLIER',
        companyName: 'ТОВ Постачальник',
      } as any);

      const tx = (service as any).__tx;
      expect(tx.counterpartyContract.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            currencyCode: 'USD',
            contractType: 'PURCHASE',
          }),
        }),
      );
    });

    it('Bug #360: SUPPLIER → fallback до "UAH" коли org settings row відсутній (fresh org)', async () => {
      prisma.organisationSettings.findUnique.mockResolvedValueOnce(null);

      await service.create('org-1', {
        type: 'SUPPLIER',
        companyName: 'ТОВ X',
      } as any);

      const tx = (service as any).__tx;
      expect(tx.counterpartyContract.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ currencyCode: 'UAH' }),
        }),
      );
    });

    it('Bug #360: CLIENT → НЕ робить fetch org settings (no auto-contract)', async () => {
      prisma.organisationSettings.findUnique.mockClear();
      await service.create('org-1', { type: 'CLIENT', firstName: 'Іван' } as any);
      // CLIENT не створює auto-contract → не потрібно тягнути org currency.
      expect(prisma.organisationSettings.findUnique).not.toHaveBeenCalled();
    });
  });

  // Bug #361: createContract/updateContract повинні валідувати що currencyCode існує у Currency.
  describe('createContract — Bug #361: валідація currencyCode', () => {
    beforeEach(() => {
      prisma.counterparty.findFirst.mockResolvedValue({ id: 'cp-1', type: 'SUPPLIER' });

      // Mock $transaction щоб повертати валідний ContractResponseDto-shape (Date objects).
      // Стандартний __tx mock не покриває counterpartyContract.create return — service
      // викликає toContractDto на результаті, який потребує startDate.toISOString().
      const txInner = {
        counterpartyContract: {
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          create: vi.fn().mockResolvedValue({
            id: 'con-1',
            orgId: 'org-1',
            counterpartyId: 'cp-1',
            number: 'ДГ-1',
            contractType: 'PURCHASE',
            startDate: new Date('2026-01-01'),
            endDate: null,
            isPrimary: true,
            creditLimit: null,
            currencyCode: 'USD',
            paymentDeferDays: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
          }),
        },
      };
      prisma.$transaction.mockImplementation(async (cb: any) => cb(txInner));
    });

    it('передає валідний currencyCode → currency.findFirst викликано з UPPERCASE кодом', async () => {
      prisma.currency.findFirst.mockResolvedValueOnce({ id: 'cur-usd' });
      await service.createContract('org-1', 'cp-1', {
        contractType: 'PURCHASE',
        startDate: '2026-01-01',
        currencyCode: 'USD',
      } as any);
      expect(prisma.currency.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ orgId: 'org-1', code: 'USD', deletedAt: null }),
        }),
      );
    });

    it('кидає BadRequestException якщо currency code не існує у Currency таблиці', async () => {
      prisma.currency.findFirst.mockResolvedValueOnce(null); // no such currency
      await expect(
        service.createContract('org-1', 'cp-1', {
          contractType: 'PURCHASE',
          startDate: '2026-01-01',
          currencyCode: 'XYZ',
        } as any),
      ).rejects.toThrow(/Валюта з кодом "XYZ" не знайдена/);
    });

    it('omitted currencyCode → currency.findFirst НЕ викликано (back-compat)', async () => {
      prisma.currency.findFirst.mockClear();
      await service.createContract('org-1', 'cp-1', {
        contractType: 'PURCHASE',
        startDate: '2026-01-01',
      } as any);
      expect(prisma.currency.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('removeContract — Bug #351: auto-promote next primary', () => {
    it('soft-delete primary → промотує наступний договір того ж типу у primary', async () => {
      prisma.counterparty.findFirst.mockResolvedValueOnce({ id: 'cp-1', type: 'SUPPLIER' });
      prisma.counterpartyContract.findFirst.mockResolvedValueOnce({
        id: 'con-old',
        contractType: 'PURCHASE',
        isPrimary: true,
      });

      // Mock $transaction для callback-style з власним tx — після Bug-#352-race-fix
      // count() рахується ВСЕРЕДИНІ tx (атомарно), тому mock йде через txInner.
      const txInner = {
        counterpartyContract: {
          count: vi.fn().mockResolvedValue(2), // >1 → проходить SUPPLIER guard
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          findFirst: vi.fn().mockResolvedValue({ id: 'con-next' }),
          update: vi.fn().mockResolvedValue({}),
        },
      };
      prisma.$transaction.mockImplementationOnce(async (cb: any) => cb(txInner));

      await service.removeContract('org-1', 'cp-1', 'con-old');

      // soft-delete викликано (з deletedAt:null guard для idempotency під race)
      expect(txInner.counterpartyContract.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'con-old', counterpartyId: 'cp-1', orgId: 'org-1', deletedAt: null },
          data: { deletedAt: expect.any(Date) },
        }),
      );

      // знаходить наступний за contractType + createdAt asc
      expect(txInner.counterpartyContract.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            counterpartyId: 'cp-1',
            orgId: 'org-1',
            deletedAt: null,
            contractType: 'PURCHASE',
            id: { not: 'con-old' },
          }),
          orderBy: { createdAt: 'asc' },
        }),
      );

      // промотує наступний у primary
      expect(txInner.counterpartyContract.update).toHaveBeenCalledWith({
        where: { id: 'con-next', orgId: 'org-1' },
        data: { isPrimary: true },
      });
    });

    it('soft-delete НЕ primary → НЕ промотує жодного', async () => {
      prisma.counterparty.findFirst.mockResolvedValueOnce({ id: 'cp-1', type: 'BOTH' });
      prisma.counterpartyContract.findFirst.mockResolvedValueOnce({
        id: 'con-secondary',
        contractType: 'PURCHASE',
        isPrimary: false,
      });

      const txInner = {
        counterpartyContract: {
          count: vi.fn().mockResolvedValue(2),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          findFirst: vi.fn(),
          update: vi.fn(),
        },
      };
      prisma.$transaction.mockImplementationOnce(async (cb: any) => cb(txInner));

      await service.removeContract('org-1', 'cp-1', 'con-secondary');

      expect(txInner.counterpartyContract.findFirst).not.toHaveBeenCalled();
      expect(txInner.counterpartyContract.update).not.toHaveBeenCalled();
    });

    it('soft-delete вже втрачено race-партнером → exit без auto-promote', async () => {
      // Bug #352 race-safety: якщо updateMany.count === 0 (другий writer виграв),
      // tx виходить чисто і НЕ запускає auto-promote (інакше ми б промотували
      // на основі stale `contract.isPrimary` що вже не актуальне).
      prisma.counterparty.findFirst.mockResolvedValueOnce({ id: 'cp-1', type: 'BOTH' });
      prisma.counterpartyContract.findFirst.mockResolvedValueOnce({
        id: 'con-1',
        contractType: 'SALE',
        isPrimary: true,
      });

      const txInner = {
        counterpartyContract: {
          count: vi.fn().mockResolvedValue(2),
          updateMany: vi.fn().mockResolvedValue({ count: 0 }), // race lost
          findFirst: vi.fn(),
          update: vi.fn(),
        },
      };
      prisma.$transaction.mockImplementationOnce(async (cb: any) => cb(txInner));

      await service.removeContract('org-1', 'cp-1', 'con-1');

      expect(txInner.counterpartyContract.updateMany).toHaveBeenCalled();
      expect(txInner.counterpartyContract.findFirst).not.toHaveBeenCalled();
      expect(txInner.counterpartyContract.update).not.toHaveBeenCalled();
    });
  });

  describe('removeContract — Bug #352: count тільки PURCHASE для SUPPLIER', () => {
    it('SUPPLIER → count рахує ТІЛЬКИ contractType:PURCHASE (у TX, атомарно)', async () => {
      prisma.counterparty.findFirst.mockResolvedValueOnce({ id: 'cp-1', type: 'SUPPLIER' });
      prisma.counterpartyContract.findFirst.mockResolvedValueOnce({
        id: 'con-1',
        contractType: 'PURCHASE',
        isPrimary: false,
      });

      const txInner = {
        counterpartyContract: {
          count: vi.fn().mockResolvedValue(2),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          findFirst: vi.fn(),
          update: vi.fn(),
        },
      };
      prisma.$transaction.mockImplementationOnce(async (cb: any) => cb(txInner));

      await service.removeContract('org-1', 'cp-1', 'con-1');

      expect(txInner.counterpartyContract.count).toHaveBeenCalledWith({
        where: {
          counterpartyId: 'cp-1',
          orgId: 'org-1',
          deletedAt: null,
          contractType: 'PURCHASE',
        },
      });
    });

    it('SUPPLIER → блокує видалення останнього PURCHASE (count <= 1)', async () => {
      prisma.counterparty.findFirst.mockResolvedValueOnce({ id: 'cp-1', type: 'SUPPLIER' });
      prisma.counterpartyContract.findFirst.mockResolvedValueOnce({
        id: 'con-1',
        contractType: 'PURCHASE',
        isPrimary: true,
      });

      // Bug-#352 race-fix: count() переїхав у tx. Прокидаємо у callback.
      const txInner = {
        counterpartyContract: {
          count: vi.fn().mockResolvedValue(1), // = 1 → guard fires
          updateMany: vi.fn(),
          findFirst: vi.fn(),
          update: vi.fn(),
        },
      };
      prisma.$transaction.mockImplementationOnce(async (cb: any) => cb(txInner));

      await expect(service.removeContract('org-1', 'cp-1', 'con-1')).rejects.toThrow(
        /Постачальник повинен мати хоча б один договір/,
      );
      // guard fired → жодного soft-delete не відбулось
      expect(txInner.counterpartyContract.updateMany).not.toHaveBeenCalled();
    });

    it('CLIENT → не виконує count guard (договір не обов’язковий)', async () => {
      prisma.counterparty.findFirst.mockResolvedValueOnce({ id: 'cp-1', type: 'CLIENT' });
      prisma.counterpartyContract.findFirst.mockResolvedValueOnce({
        id: 'con-1',
        contractType: 'SALE',
        isPrimary: false,
      });
      const txInner = {
        counterpartyContract: {
          count: vi.fn(),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          findFirst: vi.fn(),
          update: vi.fn(),
        },
      };
      prisma.$transaction.mockImplementationOnce(async (cb: any) => cb(txInner));

      await service.removeContract('org-1', 'cp-1', 'con-1');
      // CLIENT never triggers count guard, ні на prisma, ні на tx
      expect(txInner.counterpartyContract.count).not.toHaveBeenCalled();
      expect(prisma.counterpartyContract.count).not.toHaveBeenCalled();
    });
  });

  // Bug #603 + #605: regression-guard для restoreContract (парний check parent CP + семантика).
  describe('restoreContract — Bug #603 parent-CP guard + Bug #605 regression-guards', () => {
    it('Bug #603: NotFoundException коли parent CP soft-deleted (найде null → пре-check фейлить ДО updateMany)', async () => {
      prisma.counterparty.findFirst.mockResolvedValueOnce(null); // CP soft-deleted / не існує
      await expect(service.restoreContract('org-1', 'cp-1', 'con-1')).rejects.toThrow(
        /Контрагента не знайдено/,
      );
      // Жодного updateMany — без парент-check не пропускаємо на write-path
      expect(prisma.counterpartyContract.updateMany).not.toHaveBeenCalled();
    });

    it('NotFoundException коли contract вже активний або не існує (double-restore, updateMany.count===0)', async () => {
      prisma.counterparty.findFirst.mockResolvedValueOnce({ id: 'cp-1' });
      prisma.counterpartyContract.updateMany.mockResolvedValueOnce({ count: 0 });
      await expect(service.restoreContract('org-1', 'cp-1', 'con-1')).rejects.toThrow(
        /Видалений договір не знайдено/,
      );
    });

    it('пре-check CP містить orgId + deletedAt:null (tenant isolation)', async () => {
      prisma.counterparty.findFirst.mockResolvedValueOnce({ id: 'cp-1' });
      prisma.counterpartyContract.updateMany.mockResolvedValueOnce({ count: 1 });
      prisma.counterpartyContract.findFirstOrThrow = vi.fn().mockResolvedValueOnce({
        id: 'con-1',
        orgId: 'org-1',
        counterpartyId: 'cp-1',
        number: 'ДГ-1',
        contractType: 'PURCHASE',
        startDate: new Date('2026-01-01'),
        endDate: null,
        isPrimary: false,
        creditLimit: null,
        currencyCode: 'UAH',
        paymentDeferDays: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      });
      await service.restoreContract('org-7', 'cp-1', 'con-1');
      expect(prisma.counterparty.findFirst).toHaveBeenCalledWith({
        where: { id: 'cp-1', orgId: 'org-7', deletedAt: null },
        select: { id: true },
      });
    });

    it('updateMany where містить counterpartyId + orgId + NOT:{deletedAt:null} (cross-CP + tenant)', async () => {
      prisma.counterparty.findFirst.mockResolvedValueOnce({ id: 'cp-1' });
      prisma.counterpartyContract.updateMany.mockResolvedValueOnce({ count: 1 });
      prisma.counterpartyContract.findFirstOrThrow = vi.fn().mockResolvedValueOnce({
        id: 'con-1',
        orgId: 'org-1',
        counterpartyId: 'cp-1',
        number: 'ДГ-1',
        contractType: 'SALE',
        startDate: new Date('2026-01-01'),
        endDate: null,
        isPrimary: false,
        creditLimit: null,
        currencyCode: 'UAH',
        paymentDeferDays: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      });
      await service.restoreContract('org-1', 'cp-1', 'con-1');
      expect(prisma.counterpartyContract.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'con-1',
          counterpartyId: 'cp-1',
          orgId: 'org-1',
          NOT: { deletedAt: null },
        },
        data: { deletedAt: null, isPrimary: false },
      });
    });

    it('data містить isPrimary:false (уникнення дубля-primary того ж contractType)', async () => {
      prisma.counterparty.findFirst.mockResolvedValueOnce({ id: 'cp-1' });
      prisma.counterpartyContract.updateMany.mockResolvedValueOnce({ count: 1 });
      prisma.counterpartyContract.findFirstOrThrow = vi.fn().mockResolvedValueOnce({
        id: 'con-1',
        orgId: 'org-1',
        counterpartyId: 'cp-1',
        number: 'ДГ-1',
        contractType: 'PURCHASE',
        startDate: new Date('2026-01-01'),
        endDate: null,
        isPrimary: false,
        creditLimit: null,
        currencyCode: 'UAH',
        paymentDeferDays: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      });
      await service.restoreContract('org-1', 'cp-1', 'con-1');
      const call = prisma.counterpartyContract.updateMany.mock.calls[0][0];
      expect(call.data.isPrimary).toBe(false);
      expect(call.data.deletedAt).toBeNull();
    });

    it('повертає ContractResponseDto зі всіх ISO дат + deletedAt=null', async () => {
      prisma.counterparty.findFirst.mockResolvedValueOnce({ id: 'cp-1' });
      prisma.counterpartyContract.updateMany.mockResolvedValueOnce({ count: 1 });
      prisma.counterpartyContract.findFirstOrThrow = vi.fn().mockResolvedValueOnce({
        id: 'con-1',
        orgId: 'org-1',
        counterpartyId: 'cp-1',
        number: 'ДГ-1',
        contractType: 'PURCHASE',
        startDate: new Date('2026-01-01T00:00:00Z'),
        endDate: null,
        isPrimary: false,
        creditLimit: null,
        currencyCode: 'UAH',
        paymentDeferDays: null,
        createdAt: new Date('2026-01-01T10:00:00Z'),
        updatedAt: new Date('2026-01-02T10:00:00Z'),
        deletedAt: null,
      });
      const res = await service.restoreContract('org-1', 'cp-1', 'con-1');
      expect(res).toMatchObject({
        id: 'con-1',
        counterpartyId: 'cp-1',
        contractType: 'PURCHASE',
        startDate: '2026-01-01',
        isPrimary: false,
        deletedAt: null,
      });
      // ISO-string createdAt/updatedAt (не Date object) — DTO contract
      expect(typeof res.createdAt).toBe('string');
      expect(typeof res.updatedAt).toBe('string');
    });
  });
});

/**
 * Phase C — «Пов'язані документи» контрагента (getLinkedDocuments/getLinkedCounts).
 * Дзеркалить WorkOrder-патерн: orgId+deletedAt:null, Decimal→Number, zero-init counts.
 * Врахований урок Bug #641: counts мають рахувати лише живі (deletedAt:null) записи —
 * groupBy тут уже фільтрує deletedAt:null, тож count == detail.
 */
