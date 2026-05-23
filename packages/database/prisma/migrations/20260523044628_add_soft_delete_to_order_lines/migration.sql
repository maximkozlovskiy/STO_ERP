-- DropIndex
DROP INDEX "stock_document_lines_orgId_stockDocumentId_idx";

-- DropIndex
DROP INDEX "work_order_lines_orgId_workOrderId_idx";

-- DropIndex
DROP INDEX "work_order_parts_orgId_workOrderId_idx";

-- AlterTable
ALTER TABLE "purchase_order_lines" ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "stock_document_lines" ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "work_order_lines" ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "work_order_parts" ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "purchase_order_lines_purchaseOrderId_deletedAt_idx" ON "purchase_order_lines"("purchaseOrderId", "deletedAt");

-- CreateIndex
CREATE INDEX "stock_document_lines_orgId_stockDocumentId_deletedAt_idx" ON "stock_document_lines"("orgId", "stockDocumentId", "deletedAt");

-- CreateIndex
CREATE INDEX "work_order_lines_orgId_workOrderId_deletedAt_idx" ON "work_order_lines"("orgId", "workOrderId", "deletedAt");

-- CreateIndex
CREATE INDEX "work_order_parts_orgId_workOrderId_deletedAt_idx" ON "work_order_parts"("orgId", "workOrderId", "deletedAt");
