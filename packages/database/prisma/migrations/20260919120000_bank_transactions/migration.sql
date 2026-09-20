-- Bank statements (вхідні банк-платежі без рахунку): staging-модель BankTransaction + матчинг-поля.
-- Ручно-складена міграція (лише зміни цієї фічі) — schema-vs-DB diff у цьому репо містить сторонній
-- drift (trgm GIN-індекси, FK-перестворення) який НЕ можна включати. Див. docs sto-database.

-- CreateEnum
CREATE TYPE "BankTransactionStatus" AS ENUM ('UNMATCHED', 'MATCHED', 'IGNORED');

-- CreateEnum
CREATE TYPE "BankTransactionMatchType" AS ENUM ('PREPAYMENT', 'SERVICE', 'INVOICE', 'REFUND', 'OTHER');

-- CreateEnum
CREATE TYPE "BankTransactionSource" AS ENUM ('FILE_IMPORT', 'PRIVAT24_API');

-- CreateEnum
CREATE TYPE "BankTransactionDirection" AS ENUM ('IN', 'OUT');

-- AlterEnum
ALTER TYPE "ProviderKind" ADD VALUE 'BANK';

-- AlterTable: структурований IBAN контрагента (для авто-матчу вхідних виписок)
ALTER TABLE "counterparties" ADD COLUMN "iban" TEXT;

-- CreateTable
CREATE TABLE "bank_transactions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "bankAccountId" UUID NOT NULL,
    "direction" "BankTransactionDirection" NOT NULL DEFAULT 'IN',
    "amount" DECIMAL(12,2) NOT NULL,
    "currencyId" UUID NOT NULL,
    "amountBase" DECIMAL(12,2),
    "rateUsed" DECIMAL(18,6),
    "operationDate" DATE NOT NULL,
    "payerName" TEXT,
    "payerIban" TEXT,
    "payerEdrpou" TEXT,
    "purpose" TEXT,
    "externalId" TEXT NOT NULL,
    "source" "BankTransactionSource" NOT NULL,
    "status" "BankTransactionStatus" NOT NULL DEFAULT 'UNMATCHED',
    "matchedType" "BankTransactionMatchType",
    "counterpartyId" UUID,
    "paymentId" UUID,
    "matchConfidence" DECIMAL(5,2),
    "rawData" JSONB,
    "ignoreReason" TEXT,
    "syncVersion" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "bank_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "bank_transactions_paymentId_key" ON "bank_transactions"("paymentId");

-- CreateIndex
CREATE INDEX "bank_transactions_orgId_status_deletedAt_operationDate_idx" ON "bank_transactions"("orgId", "status", "deletedAt", "operationDate");

-- CreateIndex
CREATE INDEX "bank_transactions_orgId_operationDate_idx" ON "bank_transactions"("orgId", "operationDate");

-- CreateIndex
CREATE INDEX "bank_transactions_orgId_syncVersion_idx" ON "bank_transactions"("orgId", "syncVersion");

-- CreateIndex
CREATE UNIQUE INDEX "bank_transactions_orgId_bankAccountId_externalId_key" ON "bank_transactions"("orgId", "bankAccountId", "externalId");

-- CreateIndex
CREATE INDEX "counterparties_orgId_iban_idx" ON "counterparties"("orgId", "iban");

-- CreateIndex
CREATE INDEX "counterparties_orgId_edrpou_idx" ON "counterparties"("orgId", "edrpou");

-- AddForeignKey
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "bank_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_currencyId_fkey" FOREIGN KEY ("currencyId") REFERENCES "currencies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_counterpartyId_fkey" FOREIGN KEY ("counterpartyId") REFERENCES "counterparties"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: нормалізований IBAN з наявного вільнотекстового bankAccount (лише IBAN-подібні рядки:
-- 2 літери країни + 2 контрольні цифри + рахунок). UPPERCASE, без пробілів.
UPDATE "counterparties"
SET "iban" = upper(replace("bankAccount", ' ', ''))
WHERE "bankAccount" IS NOT NULL
  AND replace("bankAccount", ' ', '') ~ '^[A-Za-z]{2}[0-9]{2}[0-9A-Za-z]{10,}$';
