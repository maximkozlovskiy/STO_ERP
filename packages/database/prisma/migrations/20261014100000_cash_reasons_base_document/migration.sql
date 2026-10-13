-- Каса як місце готівкових оплат (рішення власника 2026-10-14, BR-CASH-016…021).
-- 1) нові приводи касової операції; 2) документ-підстава операції; 3) «привід за замовчуванням»
-- статті руху коштів (один привід — одна стаття в організації); 4) тип взаєморозрахунків
-- «постачальник повернув гроші».

-- AlterEnum
ALTER TYPE "CashOperationReason" ADD VALUE 'SUPPLIER_REFUND_IN';
ALTER TYPE "CashOperationReason" ADD VALUE 'ADVANCE_ISSUE';
ALTER TYPE "CashOperationReason" ADD VALUE 'ADVANCE_RETURN';
ALTER TYPE "CashOperationReason" ADD VALUE 'BANK_DEPOSIT';
ALTER TYPE "CashOperationReason" ADD VALUE 'BANK_WITHDRAWAL';
ALTER TYPE "CashOperationReason" ADD VALUE 'OWNER_IN';
ALTER TYPE "CashOperationReason" ADD VALUE 'OWNER_OUT';

ALTER TYPE "SettlementTransactionType" ADD VALUE 'SUPPLIER_PAYMENT_RETURN';

-- AlterTable
ALTER TABLE "cash_operations" ADD COLUMN "baseDocumentType" TEXT,
ADD COLUMN "baseDocumentId" UUID;

-- AlterTable
ALTER TABLE "expense_categories" ADD COLUMN "defaultReason" "CashOperationReason";

-- Один привід за замовчуванням — одна стаття в організації. Prisma не вміє WHERE у @@unique,
-- тому індекс рукописний (як cash_shifts_one_open_per_register_uq).
CREATE UNIQUE INDEX IF NOT EXISTS "expense_categories_default_reason_uq"
  ON "expense_categories" ("orgId", "defaultReason")
  WHERE "deletedAt" IS NULL AND "defaultReason" IS NOT NULL;
