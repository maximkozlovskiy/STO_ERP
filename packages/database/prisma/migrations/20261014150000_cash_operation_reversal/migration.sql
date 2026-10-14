-- Сторно касової операції (рішення власника 2026-10-14, BR-CASH-023…025).

-- AlterEnum
ALTER TYPE "SettlementTransactionType" ADD VALUE 'PAYMENT_CANCEL';
ALTER TYPE "SettlementTransactionType" ADD VALUE 'PREPAYMENT_CANCEL';
ALTER TYPE "SettlementTransactionType" ADD VALUE 'SUPPLIER_PAYMENT_CANCEL';
ALTER TYPE "SettlementTransactionType" ADD VALUE 'SUPPLIER_PAYMENT_RETURN_CANCEL';

ALTER TYPE "SupplierPaymentStatus" ADD VALUE 'REVERSED';

-- AlterTable
ALTER TABLE "cash_operations" ADD COLUMN "reversalOfId" UUID;

-- AlterTable
ALTER TABLE "payments" ADD COLUMN "reversedAt" TIMESTAMP(3),
ADD COLUMN "reversalCashOperationId" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "cash_operations_reversalOfId_key" ON "cash_operations"("reversalOfId");

-- CreateIndex
CREATE INDEX "cash_operations_orgId_documentType_documentId_idx" ON "cash_operations"("orgId", "documentType", "documentId");
