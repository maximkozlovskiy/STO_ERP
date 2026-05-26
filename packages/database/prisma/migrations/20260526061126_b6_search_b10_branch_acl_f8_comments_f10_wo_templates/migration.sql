-- DropIndex
DROP INDEX "idx_counterparties_firstname_trgm";

-- DropIndex
DROP INDEX "idx_counterparties_lastname_trgm";

-- DropIndex
DROP INDEX "idx_counterparties_phone_trgm";

-- DropIndex
DROP INDEX "idx_goods_name_trgm";

-- DropIndex
DROP INDEX "idx_goods_sku_trgm";

-- DropIndex
DROP INDEX "idx_work_orders_number_trgm";

-- AlterTable
ALTER TABLE "work_order_templates" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- RenameIndex
ALTER INDEX "comments_syncVersion_idx" RENAME TO "comments_orgId_syncVersion_idx";
