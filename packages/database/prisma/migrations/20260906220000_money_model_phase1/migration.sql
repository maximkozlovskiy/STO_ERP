-- Модель грошей Фаза 1: Payment→рахунок-призначення + часткова оплата рахунка. Additive/idempotent.

-- 1) InvoiceStatus +PARTIALLY_PAID (guard).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'InvoiceStatus' AND e.enumlabel = 'PARTIALLY_PAID'
  ) THEN
    ALTER TYPE "InvoiceStatus" ADD VALUE 'PARTIALLY_PAID' BEFORE 'PAID';
  END IF;
END $$;

-- 2) Payment → рахунок-призначення (дзеркало SupplierPayment).
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "sourceType" "PaymentSourceType";
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "bankAccountId" UUID;
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "cashRegisterId" UUID;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'payments_bankAccountId_fkey') THEN
    ALTER TABLE "payments" ADD CONSTRAINT "payments_bankAccountId_fkey"
      FOREIGN KEY ("bankAccountId") REFERENCES "bank_accounts"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'payments_cashRegisterId_fkey') THEN
    ALTER TABLE "payments" ADD CONSTRAINT "payments_cashRegisterId_fkey"
      FOREIGN KEY ("cashRegisterId") REFERENCES "cash_registers"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- 3) PaymentMethodConfig дефолтний рахунок-призначення.
ALTER TABLE "payment_method_configs" ADD COLUMN IF NOT EXISTS "defaultSourceType" "PaymentSourceType";
ALTER TABLE "payment_method_configs" ADD COLUMN IF NOT EXISTS "defaultBankAccountId" UUID;
ALTER TABLE "payment_method_configs" ADD COLUMN IF NOT EXISTS "defaultCashRegisterId" UUID;

-- 4) Invoice.paidAmount (реальне поле). DEFAULT 0.
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "paidAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- 5) Backfill: наявним PAID-рахункам виставити paidAmount=amount (щоб «залишок» був 0, не повний).
-- Idempotent: лише де paidAmount ще 0 і статус PAID.
UPDATE "invoices" SET "paidAmount" = "amount"
WHERE "status" = 'PAID' AND "paidAmount" = 0;
