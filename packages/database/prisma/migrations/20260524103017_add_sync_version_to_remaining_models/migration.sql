-- AlterTable
ALTER TABLE "auth_accounts" ADD COLUMN     "syncVersion" BIGINT NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "document_number_configs" ADD COLUMN     "syncVersion" BIGINT NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "reconciliation_acts" ADD COLUMN     "syncVersion" BIGINT NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "auth_accounts_orgId_syncVersion_idx" ON "auth_accounts"("orgId", "syncVersion");

-- CreateIndex
CREATE INDEX "document_number_configs_orgId_syncVersion_idx" ON "document_number_configs"("orgId", "syncVersion");

-- CreateIndex
CREATE INDEX "reconciliation_acts_orgId_syncVersion_idx" ON "reconciliation_acts"("orgId", "syncVersion");
