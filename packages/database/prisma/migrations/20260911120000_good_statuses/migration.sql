-- Статуси (кастомні мітки) товарів: довідник GoodStatus + junction M:N GoodStatusLink.
-- Additive-only (2 CREATE TABLE + 6 index + 3 FK, 0 DROP).

-- CreateTable
CREATE TABLE "good_statuses" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#6b7280',
    "syncVersion" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "good_statuses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "good_status_links" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "goodId" UUID NOT NULL,
    "statusId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "good_status_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "good_statuses_orgId_deletedAt_idx" ON "good_statuses"("orgId", "deletedAt");

-- CreateIndex
CREATE INDEX "good_statuses_orgId_syncVersion_idx" ON "good_statuses"("orgId", "syncVersion");

-- CreateIndex
CREATE UNIQUE INDEX "good_statuses_orgId_name_key" ON "good_statuses"("orgId", "name");

-- CreateIndex
CREATE INDEX "good_status_links_orgId_goodId_idx" ON "good_status_links"("orgId", "goodId");

-- CreateIndex
CREATE INDEX "good_status_links_orgId_statusId_idx" ON "good_status_links"("orgId", "statusId");

-- CreateIndex
CREATE UNIQUE INDEX "good_status_links_goodId_statusId_key" ON "good_status_links"("goodId", "statusId");

-- AddForeignKey
ALTER TABLE "good_statuses" ADD CONSTRAINT "good_statuses_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "good_status_links" ADD CONSTRAINT "good_status_links_goodId_fkey" FOREIGN KEY ("goodId") REFERENCES "goods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "good_status_links" ADD CONSTRAINT "good_status_links_statusId_fkey" FOREIGN KEY ("statusId") REFERENCES "good_statuses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

