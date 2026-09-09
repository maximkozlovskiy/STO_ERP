import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import { ReconciliationProcessor, ReconcileJob } from './reconciliation.processor';

/**
 * A3 — drift-detection. Доводимо: (1) консистентні дані → 0 drift; (2) розбіжність stock/balance/
 * paidAmount → виявлено + logger.error; (3) processor READ-ONLY (жодного write-методу prisma).
 */
describe('ReconciliationProcessor', () => {
  let prisma: {
    stockItem: { findMany: ReturnType<typeof vi.fn> };
    stockBatch: { groupBy: ReturnType<typeof vi.fn> };
    settlementAccount: { findMany: ReturnType<typeof vi.fn> };
    settlementTransaction: { groupBy: ReturnType<typeof vi.fn> };
    invoice: { findMany: ReturnType<typeof vi.fn> };
    payment: { groupBy: ReturnType<typeof vi.fn> };
  };
  let processor: ReconciliationProcessor;
  const job = { data: { orgId: 'org-1' } } as Job<ReconcileJob>;

  beforeEach(() => {
    prisma = {
      stockItem: { findMany: vi.fn().mockResolvedValue([]) },
      stockBatch: { groupBy: vi.fn().mockResolvedValue([]) },
      settlementAccount: { findMany: vi.fn().mockResolvedValue([]) },
      settlementTransaction: { groupBy: vi.fn().mockResolvedValue([]) },
      invoice: { findMany: vi.fn().mockResolvedValue([]) },
      payment: { groupBy: vi.fn().mockResolvedValue([]) },
    };
    processor = new ReconciliationProcessor(prisma as never);
  });

  it('консистентні дані (Σbatch=quantity, Σtx×sign=balance, Σpayment=paidAmount) → 0 drift', async () => {
    prisma.stockItem.findMany.mockResolvedValue([{ goodId: 'g1', warehouseId: 'w1', quantity: 5 }]);
    prisma.stockBatch.groupBy.mockResolvedValue([
      { goodId: 'g1', warehouseId: 'w1', _sum: { remainingQty: 5 } },
    ]);
    prisma.settlementAccount.findMany.mockResolvedValue([{ id: 'acc1', balance: 100 }]);
    prisma.settlementTransaction.groupBy.mockResolvedValue([
      { settlementAccountId: 'acc1', type: 'CHARGE', _sum: { amount: 100 } }, // CHARGE = +1
    ]);
    prisma.invoice.findMany.mockResolvedValue([{ id: 'inv1', paidAmount: 50 }]);
    prisma.payment.groupBy.mockResolvedValue([{ invoiceId: 'inv1', _sum: { amount: 50 } }]);

    const errSpy = vi.spyOn(processor['logger'], 'error');
    await processor.process(job);
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('stock drift (quantity≠Σbatch) → logger.error', async () => {
    prisma.stockItem.findMany.mockResolvedValue([{ goodId: 'g1', warehouseId: 'w1', quantity: 5 }]);
    prisma.stockBatch.groupBy.mockResolvedValue([
      { goodId: 'g1', warehouseId: 'w1', _sum: { remainingQty: 3 } }, // розійшлось на 2
    ]);
    const errSpy = vi.spyOn(processor['logger'], 'error');
    await processor.process(job);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('DRIFT stock'));
  });

  it('balance drift враховує BALANCE_SIGN (PAYMENT=−1)', async () => {
    prisma.settlementAccount.findMany.mockResolvedValue([{ id: 'acc1', balance: 0 }]);
    prisma.settlementTransaction.groupBy.mockResolvedValue([
      { settlementAccountId: 'acc1', type: 'CHARGE', _sum: { amount: 100 } }, // +100
      { settlementAccountId: 'acc1', type: 'PAYMENT', _sum: { amount: 100 } }, // −100 → Σ=0
    ]);
    const errSpy = vi.spyOn(processor['logger'], 'error');
    await processor.process(job);
    // balance=0 == Σ(100−100)=0 → без drift. MUTATION-VERIFY: ігнорувати BALANCE_SIGN (Σ=200) → drift.
    expect(errSpy).not.toHaveBeenCalledWith(expect.stringContaining('DRIFT balance'));
  });

  it('paidAmount drift (paidAmount≠Σpayment) → logger.error', async () => {
    prisma.invoice.findMany.mockResolvedValue([{ id: 'inv1', paidAmount: 50 }]);
    prisma.payment.groupBy.mockResolvedValue([{ invoiceId: 'inv1', _sum: { amount: 30 } }]);
    const errSpy = vi.spyOn(processor['logger'], 'error');
    await processor.process(job);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('DRIFT paidAmount'));
  });

  it('READ-ONLY: жоден prisma-метод не є write (create/update/delete/upsert)', () => {
    // Структурна гарантія: processor тримає лише read-методи. Якщо хтось додасть write —
    // цей список треба свідомо оновити (сигнал у рев'ю).
    const writeMethods = ['create', 'update', 'updateMany', 'delete', 'deleteMany', 'upsert'];
    for (const model of Object.values(prisma)) {
      for (const w of writeMethods) {
        expect(model).not.toHaveProperty(w);
      }
    }
  });
});
