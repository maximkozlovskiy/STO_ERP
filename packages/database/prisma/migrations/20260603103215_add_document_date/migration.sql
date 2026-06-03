-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "documentDate" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "purchase_orders" ADD COLUMN     "documentDate" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "stock_documents" ADD COLUMN     "documentDate" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "work_orders" ADD COLUMN     "documentDate" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP;
