/*
  Warnings:

  - Added the required column `orgId` to the `purchase_order_lines` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updatedAt` to the `purchase_order_lines` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updatedAt` to the `stock_document_lines` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "purchase_order_lines" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "orgId" UUID NOT NULL,
ADD COLUMN     "syncVersion" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- AlterTable
ALTER TABLE "stock_document_lines" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "syncVersion" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- AlterTable
ALTER TABLE "stock_items" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "purchase_order_lines_orgId_syncVersion_idx" ON "purchase_order_lines"("orgId", "syncVersion");

-- CreateIndex
CREATE INDEX "stock_document_lines_orgId_syncVersion_idx" ON "stock_document_lines"("orgId", "syncVersion");

-- CreateIndex
CREATE INDEX "stock_items_orgId_syncVersion_idx" ON "stock_items"("orgId", "syncVersion");
