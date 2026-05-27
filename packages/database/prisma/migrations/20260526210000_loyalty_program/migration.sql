-- AlterTable: loyalty settings on OrganisationSettings
ALTER TABLE "organisation_settings" ADD COLUMN     "loyaltyEarnPer" DECIMAL(10,2) NOT NULL DEFAULT 100,
ADD COLUMN     "loyaltyEarnPoints" DECIMAL(10,2) NOT NULL DEFAULT 1,
ADD COLUMN     "loyaltyEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "loyaltyRedeemRate" DECIMAL(10,2) NOT NULL DEFAULT 1;

-- CreateTable: loyalty_accounts
CREATE TABLE "loyalty_accounts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "counterpartyId" UUID NOT NULL,
    "balance" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "syncVersion" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "loyalty_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable: loyalty_transactions
CREATE TABLE "loyalty_transactions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "accountId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "points" DECIMAL(12,2) NOT NULL,
    "documentId" UUID,
    "documentType" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "loyalty_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "loyalty_accounts_counterpartyId_key" ON "loyalty_accounts"("counterpartyId");

-- CreateIndex
CREATE INDEX "loyalty_accounts_orgId_idx" ON "loyalty_accounts"("orgId");

-- CreateIndex
CREATE INDEX "loyalty_accounts_orgId_syncVersion_idx" ON "loyalty_accounts"("orgId", "syncVersion");

-- CreateIndex
CREATE INDEX "loyalty_transactions_accountId_createdAt_idx" ON "loyalty_transactions"("accountId", "createdAt");

-- AddForeignKey
ALTER TABLE "loyalty_accounts" ADD CONSTRAINT "loyalty_accounts_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_accounts" ADD CONSTRAINT "loyalty_accounts_counterpartyId_fkey" FOREIGN KEY ("counterpartyId") REFERENCES "counterparties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_transactions" ADD CONSTRAINT "loyalty_transactions_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "loyalty_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Defensive recreation of pg_trgm GIN indexes that Prisma migrate dev may
-- silently drop when generating subsequent migrations (drift between
-- schema.prisma and raw-SQL indexes from migration 20260526061209_b6_trgm_gin_indexes).
CREATE INDEX IF NOT EXISTS "idx_work_orders_number_trgm"
  ON work_orders USING gin ("number" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "idx_counterparties_firstname_trgm"
  ON counterparties USING gin ("firstName" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "idx_counterparties_lastname_trgm"
  ON counterparties USING gin ("lastName" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "idx_counterparties_phone_trgm"
  ON counterparties USING gin (phone gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "idx_goods_name_trgm"
  ON goods USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "idx_goods_sku_trgm"
  ON goods USING gin (sku gin_trgm_ops);
