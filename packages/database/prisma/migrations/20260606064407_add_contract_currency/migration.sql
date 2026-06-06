-- AlterTable
ALTER TABLE "counterparty_contracts" ADD COLUMN     "currencyCode" VARCHAR(10) NOT NULL DEFAULT 'UAH';

-- CreateIndex
CREATE INDEX "work_orders_orgId_deletedAt_createdAt_idx" ON "work_orders"("orgId", "deletedAt", "createdAt");
