/**
 * CounterpartiesService — пов'язані документи (Phase C)
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
import { statusesProvider } from './counterparties.spec-fixture';

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
        { provide: AuditService, useValue: { record: vi.fn().mockResolvedValue(undefined) } },
        statusesProvider(),
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

/**
 * Bug #719 (C1b audit): update() пише AuditEvent з коректним before-знімком.
 *
 * Регресія: раніше `existing` тягнув лише {id,companyName,firstName,lastName}, і весь знімок
 * (з `id`) передавався як old-data у audit.record — buildDiff тоді порівнював його з частковим
 * PATCH-dto, де решта полів = undefined → фейкові записи «id→undefined», «companyName→undefined»
 * (нібито поля очищено, хоча PATCH їх не чіпав). Тепер old-snapshot обмежений ключами dto й
 * містить справжні попередні значення. Ці тести замикають:
 *  1) record() викликано з правильними позиційними аргументами (orgId/entityType/entityId/action/userId);
 *  2) old-snapshot НЕ містить `id` та полів, яких немає у PATCH;
 *  3) old-snapshot містить справжнє попереднє значення саме зміненого поля.
 */
