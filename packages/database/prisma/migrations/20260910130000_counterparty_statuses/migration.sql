-- CreateTable
CREATE TABLE "counterparty_statuses" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#6b7280',
    "syncVersion" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    CONSTRAINT "counterparty_statuses_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "counterparty_status_links" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "counterpartyId" UUID NOT NULL,
    "statusId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "counterparty_status_links_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "counterparty_statuses_orgId_deletedAt_idx" ON "counterparty_statuses"("orgId", "deletedAt");
-- CreateIndex
CREATE INDEX "counterparty_statuses_orgId_syncVersion_idx" ON "counterparty_statuses"("orgId", "syncVersion");
-- CreateIndex
CREATE UNIQUE INDEX "counterparty_statuses_orgId_name_key" ON "counterparty_statuses"("orgId", "name");
-- CreateIndex
CREATE INDEX "counterparty_status_links_orgId_counterpartyId_idx" ON "counterparty_status_links"("orgId", "counterpartyId");
-- CreateIndex
CREATE INDEX "counterparty_status_links_orgId_statusId_idx" ON "counterparty_status_links"("orgId", "statusId");
-- CreateIndex
CREATE UNIQUE INDEX "counterparty_status_links_counterpartyId_statusId_key" ON "counterparty_status_links"("counterpartyId", "statusId");
-- AddForeignKey
ALTER TABLE "counterparty_statuses" ADD CONSTRAINT "counterparty_statuses_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "counterparty_status_links" ADD CONSTRAINT "counterparty_status_links_counterpartyId_fkey" FOREIGN KEY ("counterpartyId") REFERENCES "counterparties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "counterparty_status_links" ADD CONSTRAINT "counterparty_status_links_statusId_fkey" FOREIGN KEY ("statusId") REFERENCES "counterparty_statuses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
