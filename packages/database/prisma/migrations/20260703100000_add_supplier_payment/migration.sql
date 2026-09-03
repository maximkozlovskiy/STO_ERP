-- Add SUPPLIER_PAYMENT to DocumentType enum
ALTER TYPE "DocumentType" ADD VALUE IF NOT EXISTS 'SUPPLIER_PAYMENT';

-- CreateEnum: SupplierPaymentStatus
DO $$ BEGIN
  CREATE TYPE "SupplierPaymentStatus" AS ENUM ('DRAFT', 'CONFIRMED', 'CANCELLED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- CreateEnum: PaymentSourceType
DO $$ BEGIN
  CREATE TYPE "PaymentSourceType" AS ENUM ('BANK_ACCOUNT', 'CASH_REGISTER');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- CreateTable: supplier_payments
CREATE TABLE IF NOT EXISTS "supplier_payments" (
    "id"              UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId"           UUID NOT NULL,
    "supplierId"      UUID NOT NULL,
    "purchaseOrderId" UUID,
    "sourceType"      "PaymentSourceType" NOT NULL,
    "bankAccountId"   UUID,
    "cashRegisterId"  UUID,
    "number"          TEXT NOT NULL,
    "status"          "SupplierPaymentStatus" NOT NULL DEFAULT 'DRAFT',
    "amount"          DECIMAL(12,2) NOT NULL,
    "method"          TEXT NOT NULL,
    "notes"           TEXT,
    "documentDate"    DATE NOT NULL DEFAULT CURRENT_DATE,
    "syncVersion"     BIGINT NOT NULL DEFAULT 0,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,
    "deletedAt"       TIMESTAMP(3),
    CONSTRAINT "supplier_payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "supplier_payments_orgId_deletedAt_idx" ON "supplier_payments"("orgId", "deletedAt");
CREATE INDEX IF NOT EXISTS "supplier_payments_orgId_supplierId_createdAt_idx" ON "supplier_payments"("orgId", "supplierId", "createdAt");
CREATE INDEX IF NOT EXISTS "supplier_payments_orgId_status_createdAt_idx" ON "supplier_payments"("orgId", "status", "createdAt");
CREATE INDEX IF NOT EXISTS "supplier_payments_orgId_syncVersion_idx" ON "supplier_payments"("orgId", "syncVersion");

-- AddForeignKey
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "counterparties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "purchase_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "bank_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_cashRegisterId_fkey" FOREIGN KEY ("cashRegisterId") REFERENCES "cash_registers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
