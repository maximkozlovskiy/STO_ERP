-- DropForeignKey
ALTER TABLE "calendar_slots" DROP CONSTRAINT "calendar_slots_counterpartyId_fkey";

-- DropIndex
DROP INDEX "audit_events_orgId_entityType_entityId_idx";

-- DropIndex
DROP INDEX "booking_requests_orgId_createdAt_idx";

-- DropIndex
DROP INDEX "counterparties_companyname_trgm_idx";

-- DropIndex
DROP INDEX "counterparties_firstname_trgm_idx";

-- DropIndex
DROP INDEX "counterparties_lastname_trgm_idx";

-- DropIndex
DROP INDEX "counterparties_phone_trgm_idx";

-- DropIndex
DROP INDEX "idx_counterparties_companyname_trgm";

-- DropIndex
DROP INDEX "idx_counterparties_firstname_trgm";

-- DropIndex
DROP INDEX "idx_counterparties_lastname_trgm";

-- DropIndex
DROP INDEX "idx_counterparties_phone_trgm";

-- DropIndex
DROP INDEX "goods_name_trgm_idx";

-- DropIndex
DROP INDEX "goods_sku_trgm_idx";

-- DropIndex
DROP INDEX "idx_goods_name_trgm";

-- DropIndex
DROP INDEX "idx_goods_sku_trgm";

-- DropIndex
DROP INDEX "settlement_transactions_orgId_settlementAccountId_idx";

-- DropIndex
DROP INDEX "idx_work_orders_number_trgm";

-- AlterTable
ALTER TABLE "organisation_settings" ADD COLUMN     "followUpActive" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "followUpDays" INTEGER NOT NULL DEFAULT 90;

-- CreateIndex
CREATE INDEX "audit_events_orgId_entityType_entityId_createdAt_idx" ON "audit_events"("orgId", "entityType", "entityId", "createdAt");

-- CreateIndex
CREATE INDEX "invoices_orgId_deletedAt_createdAt_idx" ON "invoices"("orgId", "deletedAt", "createdAt");

-- CreateIndex
CREATE INDEX "purchase_orders_orgId_deletedAt_createdAt_idx" ON "purchase_orders"("orgId", "deletedAt", "createdAt");

-- CreateIndex
CREATE INDEX "settlement_transactions_orgId_settlementAccountId_createdAt_idx" ON "settlement_transactions"("orgId", "settlementAccountId", "createdAt");

-- CreateIndex
CREATE INDEX "stock_documents_orgId_deletedAt_createdAt_idx" ON "stock_documents"("orgId", "deletedAt", "createdAt");

-- AddForeignKey
ALTER TABLE "calendar_slots" ADD CONSTRAINT "calendar_slots_counterpartyId_fkey" FOREIGN KEY ("counterpartyId") REFERENCES "counterparties"("id") ON DELETE SET NULL ON UPDATE CASCADE;
