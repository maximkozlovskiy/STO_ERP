/**
 * SupplierPaymentsService — пов'язані документи (linked-documents edge cases)
 *
 * Виділено з `supplier-payments.service.spec.ts` (був 1410 рядків: 1235 з них — ОДИН
 * top-level describe із 56 тестами БЕЗ вкладених describe, секції розмічені лише
 * ASCII-швами автора) 2026-10-07. Кейси перенесені ДОСЛІВНО.
 *
 * Сетап — `makeSpHarness()` з `./supplier-payments.spec-fixture` (той самий beforeEach).
 */

import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { SupplierPaymentsService } from './supplier-payments.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SettlementsService } from '../settlements/settlements.service';
import { DocumentNumberService } from '../document-number/document-number.service';
import { CashService } from '../cash/cash.service';
import { exchangeRatesProvider } from './supplier-payments.spec-fixture';

// ─── Bug #A + edge inputs: getLinkedCounts / getLinkedDocuments ──────────────
describe('SupplierPaymentsService — linked-documents edge cases', () => {
  let service: SupplierPaymentsService;
  let prisma: {
    supplierPayment: { findFirst: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
    purchaseOrder: { findFirst: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
    counterparty: { findFirst: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
    bankAccount: { findFirst: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
    cashRegister: { findFirst: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
  };

  const ORG = '00000000-0000-4000-8000-000000000001';
  const OTHER = '00000000-0000-4000-8000-000000000002';
  const SP = '11111111-1111-4111-8111-111111111111';
  const SUP = '22222222-2222-4222-8222-222222222222';
  const BANK = '33333333-3333-4333-8333-333333333333';
  const CASH = '44444444-4444-4444-8444-444444444444';
  const PO = '55555555-5555-4555-8555-555555555555';

  beforeEach(async () => {
    prisma = {
      supplierPayment: { findFirst: vi.fn(), findMany: vi.fn() },
      purchaseOrder: { findFirst: vi.fn(), findMany: vi.fn() },
      counterparty: { findFirst: vi.fn(), findMany: vi.fn() },
      bankAccount: { findFirst: vi.fn(), findMany: vi.fn() },
      cashRegister: { findFirst: vi.fn(), findMany: vi.fn() },
    };
    const module = await Test.createTestingModule({
      providers: [
        SupplierPaymentsService,
        { provide: PrismaService, useValue: prisma },
        { provide: SettlementsService, useValue: {} },
        { provide: DocumentNumberService, useValue: {} },
        { provide: CashService, useValue: { createOperation: vi.fn() } },
        exchangeRatesProvider(),
      ],
    }).compile();
    service = module.get(SupplierPaymentsService);
  });

  const setLive = (over: Partial<Record<string, unknown[]>> = {}) => {
    prisma.purchaseOrder.findMany.mockResolvedValue(over.po ?? [{ id: PO }]);
    prisma.counterparty.findMany.mockResolvedValue(over.cp ?? [{ id: SUP }]);
    prisma.bankAccount.findMany.mockResolvedValue(over.bank ?? [{ id: BANK }]);
    prisma.cashRegister.findMany.mockResolvedValue(over.cash ?? [{ id: CASH }]);
  };

  it('getLinkedCounts: bank-оплата → account=1, counterparty=1, PO=1', async () => {
    prisma.supplierPayment.findMany.mockResolvedValue([
      { id: SP, purchaseOrderId: PO, supplierId: SUP, bankAccountId: BANK, cashRegisterId: null },
    ]);
    setLive();
    const res = await service.getLinkedCounts(ORG, [SP]);
    expect(res[SP]).toEqual({ purchaseOrder: 1, counterparty: 1, account: 1 });
  });

  it('getLinkedCounts: без bank і cash → account=0 (не crash)', async () => {
    prisma.supplierPayment.findMany.mockResolvedValue([
      { id: SP, purchaseOrderId: null, supplierId: SUP, bankAccountId: null, cashRegisterId: null },
    ]);
    setLive({ po: [], bank: [], cash: [] });
    const res = await service.getLinkedCounts(ORG, [SP]);
    expect(res[SP]).toEqual({ purchaseOrder: 0, counterparty: 1, account: 0 });
  });

  it('getLinkedCounts: duplicate ids keyed by id', async () => {
    prisma.supplierPayment.findMany.mockResolvedValue([
      { id: SP, purchaseOrderId: PO, supplierId: SUP, bankAccountId: null, cashRegisterId: CASH },
    ]);
    setLive();
    const res = await service.getLinkedCounts(ORG, [SP, SP]);
    expect(Object.keys(res)).toEqual([SP]);
    expect(res[SP].account).toBe(1);
  });

  it('getLinkedCounts: cross-org → нулі, orgId у where', async () => {
    prisma.supplierPayment.findMany.mockResolvedValue([]);
    setLive({ po: [], cp: [], bank: [], cash: [] });
    const res = await service.getLinkedCounts(OTHER, [SP]);
    expect(res[SP]).toEqual({ purchaseOrder: 0, counterparty: 0, account: 0 });
    expect(prisma.supplierPayment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ orgId: OTHER }) }),
    );
  });

  it('Bug #A: soft-deleted bank account → account count=0 (відповідає detail)', async () => {
    prisma.supplierPayment.findMany.mockResolvedValue([
      { id: SP, purchaseOrderId: null, supplierId: SUP, bankAccountId: BANK, cashRegisterId: null },
    ]);
    setLive({ po: [], bank: [], cash: [] }); // BANK soft-deleted → не в живому наборі
    const res = await service.getLinkedCounts(ORG, [SP]);
    // Дискримінатор: старий код давав account:1 (bankAccountId ? 1 : 0).
    expect(res[SP].account).toBe(0);
    expect(res[SP].counterparty).toBe(1);
  });

  it('Bug #A: soft-deleted постачальник → counterparty count=0', async () => {
    prisma.supplierPayment.findMany.mockResolvedValue([
      { id: SP, purchaseOrderId: null, supplierId: SUP, bankAccountId: null, cashRegisterId: CASH },
    ]);
    setLive({ po: [], cp: [] }); // SUP soft-deleted
    const res = await service.getLinkedCounts(ORG, [SP]);
    expect(res[SP].counterparty).toBe(0);
    expect(res[SP].account).toBe(1);
  });

  it('getLinkedDocuments: cross-org id → порожні секції', async () => {
    prisma.supplierPayment.findFirst.mockResolvedValue(null);
    const res = await service.getLinkedDocuments(OTHER, SP);
    expect(res).toEqual({ purchaseOrder: [], counterparty: [], account: [] });
  });

  it('getLinkedDocuments: bank account soft-deleted → account:[] (не crash)', async () => {
    prisma.supplierPayment.findFirst.mockResolvedValue({
      purchaseOrderId: null,
      supplierId: SUP,
      bankAccountId: BANK,
      cashRegisterId: null,
    });
    prisma.counterparty.findFirst.mockResolvedValue({
      id: SUP,
      firstName: null,
      lastName: null,
      companyName: 'Acme',
      phone: null,
    });
    prisma.bankAccount.findFirst.mockResolvedValue(null); // soft-deleted → deletedAt:null не знайшов
    prisma.cashRegister.findFirst.mockResolvedValue(null);
    const res = await service.getLinkedDocuments(ORG, SP);
    expect(res.account).toEqual([]);
    expect(res.counterparty).toHaveLength(1);
  });
});
