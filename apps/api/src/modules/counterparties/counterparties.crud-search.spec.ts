/**
 * CounterpartiesService — findAll/findOne/remove, пошук за ?q= (Bug #163)
 *
 * Виділено з `counterparties.service.spec.ts` (був 1194 рядки, 5 незалежних
 * top-level describe) 2026-10-06. Кейси перенесені ДОСЛІВНО, назви describe не
 * змінені — інакше `fullName` у test-baseline.json розійшовся б.
 *
 * `statusesMock` замінено на `statusesProvider()` з `./counterparties.spec-fixture`:
 * module-level `const` із `vi.fn()` при `isolate: false` течий би між файлами.
 */

import { Test } from '@nestjs/testing';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { CounterpartiesService } from './counterparties.service';
import { PrismaService } from '../../prisma/prisma.service';
import { DocumentNumberService } from '../document-number/document-number.service';
import { AuditService } from '../audit/audit.service';
import type { CounterpartyQueryDto } from './counterparties.dto';
import type { PrismaModelMock } from '../../common/testing/prisma-mock';
import { statusesProvider } from './counterparties.spec-fixture';

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
    counterparty: PrismaModelMock;
    counterpartyStatusLink: PrismaModelMock;
    workOrder: PrismaModelMock;
    purchaseOrder: PrismaModelMock;
    invoice: PrismaModelMock;
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
      // remove() інвалідує кеш статусів лише коли контрагент має мітку. За замовч. null (без мітки).
      counterpartyStatusLink: { findFirst: vi.fn().mockResolvedValue(null) },
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
        { provide: AuditService, useValue: { record: vi.fn().mockResolvedValue(undefined) } },
        statusesProvider(),
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

    // guards: BR-CP-002
    it('?q= шукає і по firstName, і по lastName, і по companyName — окремими OR-гілками, без урахування регістру', async () => {
      await service.findAll('org-1', query({ q: 'петр' }));
      const where = prisma.counterparty.findMany.mock.calls[0][0].where;

      // Фізособа (ім'я/прізвище) АБО компанія: кожне поле — власна гілка, тож збіг в одному
      // не вимагає збігу в іншому (у фізособи companyName = null, у компанії — навпаки).
      for (const field of ['firstName', 'lastName', 'companyName']) {
        expect(where.OR, `where.OR має містити гілку ${field}`).toContainEqual({
          [field]: { contains: 'петр', mode: 'insensitive' },
        });
      }
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
