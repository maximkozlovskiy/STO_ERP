import { Test } from '@nestjs/testing';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { CounterpartiesService } from './counterparties.service';
import { PrismaService } from '../../prisma/prisma.service';
import { DocumentNumberService } from '../document-number/document-number.service';
import { CounterpartyQueryDto } from './counterparties.dto';

/**
 * Bug #163: regression-покриття для пошуку counterparties за `?q=`.
 *
 * Фікс 32e9a49 усунув PrismaClientValidationError, що виникав через singular relation-імена
 * (`customerGarage`/`vehicle`) замість plural (`customerGarages`/`vehicles`) у вкладеному
 * where.OR (пошук клієнта за номером авто). HTTP-contract spec повністю мокає сервіс і не
 * виконує реальний where → не зловить регресію назад до singular. Цей service-spec будує
 * where через справжній findAll і асертить правильну форму nested-relation запиту.
 */
describe('CounterpartiesService', () => {
  let service: CounterpartiesService;
  let prisma: {
    counterparty: { findMany: any; count: any; findFirst: any; updateMany: any };
    workOrder: { count: any };
    purchaseOrder: { count: any };
    invoice: { count: any };
    $transaction: ReturnType<typeof vi.fn>;
  };

  const query = (partial: Partial<CounterpartyQueryDto> = {}): CounterpartyQueryDto =>
    ({ page: 1, limit: 20, ...partial }) as CounterpartyQueryDto;

  beforeEach(async () => {
    prisma = {
      counterparty: {
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
        findFirst: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      workOrder: { count: vi.fn().mockResolvedValue(0) },
      purchaseOrder: { count: vi.fn().mockResolvedValue(0) },
      invoice: { count: vi.fn().mockResolvedValue(0) },
      // findAll використовує $transaction([findMany, count]) — виконуємо масив як є
      $transaction: vi.fn().mockImplementation((ops: Promise<unknown>[]) => Promise.all(ops)),
    };

    const module = await Test.createTestingModule({
      providers: [
        CounterpartiesService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: DocumentNumberService,
          useValue: { next: vi.fn().mockResolvedValue('CON-2026-000001') },
        },
      ],
    }).compile();

    service = module.get(CounterpartiesService);
  });

  describe('findAll — пошук ?q=', () => {
    it('повертає { items, total, page, limit } shape', async () => {
      const res = await service.findAll('org-1', query());
      expect(res).toMatchObject({ items: [], total: 0, page: 1, limit: 20 });
    });

    it('Bug #163: ?q= будує where.OR з PLURAL relation-іменами customerGarages → vehicles (а не singular)', async () => {
      await service.findAll('org-1', query({ q: 'AA1234BB' }));

      const where = prisma.counterparty.findMany.mock.calls[0][0].where;
      expect(Array.isArray(where.OR)).toBe(true);

      // Знайти гілку пошуку за номером авто
      const plateBranch = (where.OR as Record<string, any>[]).find(b => b.customerGarages);
      expect(plateBranch, 'where.OR має містити гілку customerGarages (plural)').toBeDefined();

      // Жодна гілка не повинна посилатись на singular relation-імена (регресія 32e9a49)
      for (const branch of where.OR as Record<string, any>[]) {
        expect(branch).not.toHaveProperty('customerGarage');
        expect(branch).not.toHaveProperty('vehicle');
      }

      // Структура: customerGarages.some.vehicles.some.licensePlate (plural на обох рівнях) + nested soft-delete
      const garageSome = plateBranch!.customerGarages.some;
      expect(garageSome.deletedAt).toBeNull();
      expect(garageSome.vehicles, 'вкладена relation має бути vehicles (plural)').toBeDefined();
      expect(garageSome.vehicles.some.deletedAt).toBeNull();
      expect(garageSome.vehicles.some.licensePlate).toMatchObject({ contains: 'AA1234BB' });
    });

    it('без ?q= не додає OR-гілку (лише orgId + deletedAt)', async () => {
      await service.findAll('org-1', query());
      const where = prisma.counterparty.findMany.mock.calls[0][0].where;
      expect(where.OR).toBeUndefined();
      expect(where).toMatchObject({ orgId: 'org-1', deletedAt: null });
    });

    it('завжди фільтрує по orgId + deletedAt:null (tenant isolation + soft delete)', async () => {
      await service.findAll('org-2', query({ q: 'тест' }));
      const where = prisma.counterparty.findMany.mock.calls[0][0].where;
      expect(where.orgId).toBe('org-2');
      expect(where.deletedAt).toBeNull();
    });
  });

  describe('findAll — showDeleted', () => {
    it('showDeleted=true прибирає deletedAt:null з where (повертає й видалених)', async () => {
      await service.findAll('org-1', query({ showDeleted: true }));
      const where = prisma.counterparty.findMany.mock.calls[0][0].where;
      // deletedAt-фільтр НЕ додається → у вибірку потрапляють і soft-deleted рядки
      expect(where).not.toHaveProperty('deletedAt');
    });

    it('showDeleted=true ЗАВЖДИ зберігає tenant-фільтр orgId (не витікають інші org)', async () => {
      await service.findAll('org-7', query({ showDeleted: true }));
      const where = prisma.counterparty.findMany.mock.calls[0][0].where;
      expect(where.orgId).toBe('org-7');
      // count() для total має використовувати ТОЙ САМИЙ where (без розбіжності items/total)
      expect(prisma.counterparty.count.mock.calls[0][0].where).toMatchObject({ orgId: 'org-7' });
      expect(prisma.counterparty.count.mock.calls[0][0].where).not.toHaveProperty('deletedAt');
    });

    it('showDeleted=false (за замовчуванням) фільтрує deletedAt:null', async () => {
      await service.findAll('org-1', query({ showDeleted: false }));
      const where = prisma.counterparty.findMany.mock.calls[0][0].where;
      expect(where.deletedAt).toBeNull();
    });

    it('showDeleted=true разом з ?q= зберігає orgId і OR-пошук, але без deletedAt-фільтра верхнього рівня', async () => {
      await service.findAll('org-1', query({ showDeleted: true, q: 'AA1234BB' }));
      const where = prisma.counterparty.findMany.mock.calls[0][0].where;
      expect(where.orgId).toBe('org-1');
      expect(where).not.toHaveProperty('deletedAt');
      expect(Array.isArray(where.OR)).toBe(true);
    });
  });

  describe('findOne', () => {
    it('кидає NotFoundException якщо контрагента немає в org', async () => {
      prisma.counterparty.findFirst.mockResolvedValueOnce(null);
      await expect(service.findOne('org-1', 'cp-1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // MD-H1: remove-guard проти видалення контрагента з боргом / активними документами.
  describe('remove — MD-H1 guard', () => {
    it('кидає BadRequestException при ненульовому балансі', async () => {
      prisma.counterparty.findFirst.mockResolvedValueOnce({ settlementAccount: { balance: 150 } });
      await expect(service.remove('org-1', 'cp-1')).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.counterparty.updateMany).not.toHaveBeenCalled();
    });

    it('кидає BadRequestException при активних нарядах', async () => {
      prisma.counterparty.findFirst.mockResolvedValueOnce({ settlementAccount: { balance: 0 } });
      prisma.workOrder.count.mockResolvedValueOnce(2);
      await expect(service.remove('org-1', 'cp-1')).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.counterparty.updateMany).not.toHaveBeenCalled();
    });

    it('кидає BadRequestException при незакритих замовленнях (PO)', async () => {
      prisma.counterparty.findFirst.mockResolvedValueOnce({ settlementAccount: { balance: 0 } });
      prisma.workOrder.count.mockResolvedValueOnce(0);
      prisma.purchaseOrder.count.mockResolvedValueOnce(1);
      await expect(service.remove('org-1', 'cp-1')).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.counterparty.updateMany).not.toHaveBeenCalled();
    });

    // Bug #631: DRAFT-рахунок (balance=0, немає CHARGE) не ловився → осиротів би.
    it('Bug #631: кидає BadRequestException при відкритих рахунках (DRAFT/SENT/OVERDUE)', async () => {
      prisma.counterparty.findFirst.mockResolvedValueOnce({ settlementAccount: { balance: 0 } });
      prisma.workOrder.count.mockResolvedValueOnce(0);
      prisma.purchaseOrder.count.mockResolvedValueOnce(0);
      prisma.invoice.count.mockResolvedValueOnce(1);
      await expect(service.remove('org-1', 'cp-1')).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.counterparty.updateMany).not.toHaveBeenCalled();
    });

    it('Bug #631: invoice.count гейтить лише non-final статуси (notIn PAID/CANCELLED)', async () => {
      prisma.counterparty.findFirst.mockResolvedValueOnce({ settlementAccount: { balance: 0 } });
      prisma.workOrder.count.mockResolvedValueOnce(0);
      prisma.purchaseOrder.count.mockResolvedValueOnce(0);
      prisma.invoice.count.mockResolvedValueOnce(0);
      await service.remove('org-1', 'cp-1');
      const where = prisma.invoice.count.mock.calls[0][0].where;
      expect(where).toMatchObject({ orgId: 'org-1', counterpartyId: 'cp-1', deletedAt: null });
      expect(where.status).toEqual({ notIn: ['PAID', 'CANCELLED'] });
    });

    it('видаляє коли баланс 0 і немає активних документів (наряди/PO/рахунки)', async () => {
      prisma.counterparty.findFirst.mockResolvedValueOnce({ settlementAccount: { balance: 0 } });
      prisma.workOrder.count.mockResolvedValueOnce(0);
      prisma.purchaseOrder.count.mockResolvedValueOnce(0);
      prisma.invoice.count.mockResolvedValueOnce(0);
      await service.remove('org-1', 'cp-1');
      expect(prisma.counterparty.updateMany).toHaveBeenCalledTimes(1);
    });

    it('кидає NotFound коли контрагента не знайдено', async () => {
      prisma.counterparty.findFirst.mockResolvedValueOnce(null);
      await expect(service.remove('org-1', 'missing')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});

/**
 * Bug #348, #351, #352 — regression guards for CounterpartyContract feature.
 *
 * Build separate, minimal Prisma mock with counterpartyContract + counterparty
 * stubs to exercise contract write-paths (create / removeContract).
 */
describe('CounterpartiesService — contract flows', () => {
  let service: CounterpartiesService;
  let prisma: {
    counterparty: { create: any; findFirstOrThrow: any; findFirst: any };
    counterpartyContract: { create: any; count: any; findFirst: any; updateMany: any; update: any };
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
        where: { id: 'con-next' },
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
describe('CounterpartiesService — linked documents (Phase C)', () => {
  let service: CounterpartiesService;
  let prisma: {
    counterparty: { findFirst: any };
    invoice: { findMany: any; groupBy: any };
    purchaseOrder: { findMany: any; groupBy: any };
    supplierPayment: { findMany: any; groupBy: any };
    supplierReturn: { findMany: any; groupBy: any };
  };

  beforeEach(async () => {
    prisma = {
      counterparty: { findFirst: vi.fn().mockResolvedValue({ id: 'cp-1' }) },
      invoice: { findMany: vi.fn().mockResolvedValue([]), groupBy: vi.fn().mockResolvedValue([]) },
      purchaseOrder: {
        findMany: vi.fn().mockResolvedValue([]),
        groupBy: vi.fn().mockResolvedValue([]),
      },
      supplierPayment: {
        findMany: vi.fn().mockResolvedValue([]),
        groupBy: vi.fn().mockResolvedValue([]),
      },
      supplierReturn: {
        findMany: vi.fn().mockResolvedValue([]),
        groupBy: vi.fn().mockResolvedValue([]),
      },
    };
    const module = await Test.createTestingModule({
      providers: [
        CounterpartiesService,
        { provide: PrismaService, useValue: prisma },
        { provide: DocumentNumberService, useValue: { next: vi.fn() } },
      ],
    }).compile();
    service = module.get(CounterpartiesService);
  });

  it('getLinkedDocuments: неіснуючий/чужий контрагент → порожні секції (без throw)', async () => {
    prisma.counterparty.findFirst.mockResolvedValueOnce(null); // cross-org / not found
    const res = await service.getLinkedDocuments('org-1', 'other-org-cp');
    expect(res).toEqual({
      invoices: [],
      purchaseOrders: [],
      supplierPayments: [],
      supplierReturns: [],
    });
    // Жодного sub-resource запиту, якщо контрагента немає у цій org.
    expect(prisma.invoice.findMany).not.toHaveBeenCalled();
  });

  it('getLinkedDocuments: усі запити фільтрують orgId + deletedAt:null; Decimal→Number', async () => {
    prisma.invoice.findMany.mockResolvedValueOnce([
      {
        id: 'i1',
        number: 'INV-1',
        status: 'PAID',
        amount: { toString: () => '100' },
        documentDate: null,
      },
    ]);
    prisma.purchaseOrder.findMany.mockResolvedValueOnce([
      { id: 'p1', number: 'PO-1', status: 'RECEIVED', totalAmount: 200, documentDate: null },
    ]);
    const res = await service.getLinkedDocuments('org-1', 'cp-1');
    // orgId + deletedAt:null у where кожної секції
    for (const m of [
      prisma.invoice.findMany,
      prisma.purchaseOrder.findMany,
      prisma.supplierPayment.findMany,
      prisma.supplierReturn.findMany,
    ]) {
      expect(m).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ orgId: 'org-1', deletedAt: null }),
        }),
      );
    }
    expect(res.invoices[0].amount).toBe(100); // Number, не Decimal/об'єкт
    expect(res.purchaseOrders[0].totalAmount).toBe(200);
  });

  it('getLinkedCounts: zero-init для КОЖНОГО id + порожній вхід → {}', async () => {
    expect(await service.getLinkedCounts('org-1', [])).toEqual({});
    // id без жодних зв'язків має з'явитись у мапі з нулями (не бути відсутнім)
    const res = await service.getLinkedCounts('org-1', ['cp-1', 'cp-2']);
    expect(res['cp-1']).toEqual({
      invoices: 0,
      purchaseOrders: 0,
      supplierPayments: 0,
      supplierReturns: 0,
    });
    expect(res['cp-2']).toBeDefined();
  });

  it('getLinkedCounts: groupBy фільтрує deletedAt:null (count == detail, урок Bug #641)', async () => {
    prisma.invoice.groupBy.mockResolvedValueOnce([{ counterpartyId: 'cp-1', _count: { id: 3 } }]);
    const res = await service.getLinkedCounts('org-1', ['cp-1']);
    expect(res['cp-1'].invoices).toBe(3);
    expect(prisma.invoice.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ orgId: 'org-1', deletedAt: null }),
      }),
    );
  });
});
