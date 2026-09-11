-- Рух готівки: CashDirection/CashOperationReason enums + cash_registers.isFiscal/initialBalance
-- + cash_operations (append-only) + expense_categories. Additive-only, 0 DROP.

-- CreateEnum
CREATE TYPE "CashDirection" AS ENUM ('IN', 'OUT');

-- CreateEnum
CREATE TYPE "CashOperationReason" AS ENUM ('SALE_PAYMENT', 'REFUND', 'PAYROLL', 'SUPPLIER_PAYMENT', 'EXPENSE', 'COLLECTION', 'MANUAL_IN', 'MANUAL_OUT');

-- AlterTable
ALTER TABLE "cash_registers" ADD COLUMN     "initialBalance" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "isFiscal" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "cash_operations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "cashRegisterId" UUID NOT NULL,
    "cashShiftId" UUID,
    "direction" "CashDirection" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "reason" "CashOperationReason" NOT NULL,
    "expenseCategoryId" UUID,
    "counterpartyId" UUID,
    "employeeId" UUID,
    "documentType" TEXT,
    "documentId" UUID,
    "notes" TEXT,
    "createdBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense_categories" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "syncVersion" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "expense_categories_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cash_operations_orgId_cashRegisterId_createdAt_idx" ON "cash_operations"("orgId", "cashRegisterId", "createdAt");

-- CreateIndex
CREATE INDEX "cash_operations_orgId_cashShiftId_idx" ON "cash_operations"("orgId", "cashShiftId");

-- CreateIndex
CREATE INDEX "cash_operations_orgId_reason_createdAt_idx" ON "cash_operations"("orgId", "reason", "createdAt");

-- CreateIndex
CREATE INDEX "expense_categories_orgId_deletedAt_idx" ON "expense_categories"("orgId", "deletedAt");

-- CreateIndex
CREATE INDEX "expense_categories_orgId_syncVersion_idx" ON "expense_categories"("orgId", "syncVersion");

-- CreateIndex
CREATE UNIQUE INDEX "expense_categories_orgId_name_key" ON "expense_categories"("orgId", "name");

-- AddForeignKey
ALTER TABLE "cash_operations" ADD CONSTRAINT "cash_operations_cashRegisterId_fkey" FOREIGN KEY ("cashRegisterId") REFERENCES "cash_registers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_operations" ADD CONSTRAINT "cash_operations_expenseCategoryId_fkey" FOREIGN KEY ("expenseCategoryId") REFERENCES "expense_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_categories" ADD CONSTRAINT "expense_categories_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

