-- AlterEnum
ALTER TYPE "StockDocumentType" ADD VALUE 'RECEIPT';

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
ALTER TABLE "works" ADD COLUMN     "isWarranty" BOOLEAN NOT NULL DEFAULT false;
