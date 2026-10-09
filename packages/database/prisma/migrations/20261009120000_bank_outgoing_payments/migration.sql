-- Outgoing bank payments (owner decision 2026-10-09): manual entry, both directions from files and
-- bank APIs, reconciliation of OUT rows (supplier payment / client refund / expense / payroll /
-- own transfer / cash withdrawal) and its cancellation with a mandatory reason.
-- Additive only. The new enum values are NOT used in this migration (Postgres cannot use a value
-- added in the same transaction).

-- AlterEnum
ALTER TYPE "BankTransactionSource" ADD VALUE 'MANUAL';

ALTER TYPE "BankTransactionMatchType" ADD VALUE 'SUPPLIER_PAYMENT';
ALTER TYPE "BankTransactionMatchType" ADD VALUE 'CLIENT_REFUND';
ALTER TYPE "BankTransactionMatchType" ADD VALUE 'EXPENSE';
ALTER TYPE "BankTransactionMatchType" ADD VALUE 'PAYROLL';
ALTER TYPE "BankTransactionMatchType" ADD VALUE 'TRANSFER';
ALTER TYPE "BankTransactionMatchType" ADD VALUE 'CASH_WITHDRAWAL';

ALTER TYPE "SettlementTransactionType" ADD VALUE 'REFUND_OUT';
ALTER TYPE "SettlementTransactionType" ADD VALUE 'REFUND_OUT_CANCEL';

-- AlterTable
ALTER TABLE "bank_transactions"
  ADD COLUMN "supplierPaymentId" UUID,
  ADD COLUMN "expenseCategoryId" UUID,
  ADD COLUMN "payrollPeriodId" UUID,
  ADD COLUMN "employeeId" UUID,
  ADD COLUMN "transferBankAccountId" UUID,
  ADD COLUMN "cashOperationId" UUID,
  ADD COLUMN "createdBy" UUID,
  ADD COLUMN "matchedAt" TIMESTAMP(3),
  ADD COLUMN "matchedBy" UUID,
  ADD COLUMN "unmatchReason" TEXT,
  ADD COLUMN "unmatchedAt" TIMESTAMP(3),
  ADD COLUMN "unmatchedBy" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "bank_transactions_supplierPaymentId_key" ON "bank_transactions"("supplierPaymentId");
CREATE UNIQUE INDEX "bank_transactions_cashOperationId_key" ON "bank_transactions"("cashOperationId");
CREATE INDEX "bank_transactions_orgId_direction_deletedAt_operationDate_idx" ON "bank_transactions"("orgId", "direction", "deletedAt", "operationDate");

-- AddForeignKey
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_supplierPaymentId_fkey" FOREIGN KEY ("supplierPaymentId") REFERENCES "supplier_payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_expenseCategoryId_fkey" FOREIGN KEY ("expenseCategoryId") REFERENCES "expense_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_payrollPeriodId_fkey" FOREIGN KEY ("payrollPeriodId") REFERENCES "payroll_periods"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_transferBankAccountId_fkey" FOREIGN KEY ("transferBankAccountId") REFERENCES "bank_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_cashOperationId_fkey" FOREIGN KEY ("cashOperationId") REFERENCES "cash_operations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
