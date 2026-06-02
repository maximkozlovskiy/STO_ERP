-- AlterTable
ALTER TABLE "goods" ADD COLUMN     "goodCategoryId" UUID;

-- AlterTable
ALTER TABLE "work_categories" ADD COLUMN     "code" TEXT,
ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "isSystem" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "good_categories" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "parentId" UUID,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "syncVersion" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "good_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_good_category_links" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "workCategoryId" UUID NOT NULL,
    "goodCategoryId" UUID NOT NULL,

    CONSTRAINT "work_good_category_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "good_categories_orgId_deletedAt_idx" ON "good_categories"("orgId", "deletedAt");

-- CreateIndex
CREATE INDEX "good_categories_orgId_parentId_idx" ON "good_categories"("orgId", "parentId");

-- CreateIndex
CREATE INDEX "good_categories_orgId_syncVersion_idx" ON "good_categories"("orgId", "syncVersion");

-- CreateIndex
CREATE INDEX "work_good_category_links_orgId_workCategoryId_idx" ON "work_good_category_links"("orgId", "workCategoryId");

-- CreateIndex
CREATE INDEX "work_good_category_links_orgId_goodCategoryId_idx" ON "work_good_category_links"("orgId", "goodCategoryId");

-- CreateIndex
CREATE UNIQUE INDEX "work_good_category_links_orgId_workCategoryId_goodCategoryI_key" ON "work_good_category_links"("orgId", "workCategoryId", "goodCategoryId");

-- AddForeignKey
ALTER TABLE "good_categories" ADD CONSTRAINT "good_categories_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "good_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_good_category_links" ADD CONSTRAINT "work_good_category_links_workCategoryId_fkey" FOREIGN KEY ("workCategoryId") REFERENCES "work_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_good_category_links" ADD CONSTRAINT "work_good_category_links_goodCategoryId_fkey" FOREIGN KEY ("goodCategoryId") REFERENCES "good_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods" ADD CONSTRAINT "goods_goodCategoryId_fkey" FOREIGN KEY ("goodCategoryId") REFERENCES "good_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;
