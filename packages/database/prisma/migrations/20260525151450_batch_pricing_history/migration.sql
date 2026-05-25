-- CreateEnum
CREATE TYPE "BatchCostMethod" AS ENUM ('FIFO', 'FEFO', 'LIFO', 'AVG_COST');

-- CreateEnum
CREATE TYPE "PricingRuleType" AS ENUM ('PERCENT', 'FIXED_AMOUNT', 'FIXED_PRICE', 'COMPETITOR_PLUS');

-- AlterTable
ALTER TABLE "organisation_settings" ADD COLUMN     "costMethod" "BatchCostMethod" NOT NULL DEFAULT 'FIFO';

-- AlterTable
ALTER TABLE "stock_movements" ADD COLUMN     "batchId" UUID;

-- AlterTable
ALTER TABLE "work_order_parts" ADD COLUMN     "batchCostPrice" DECIMAL(12,2),
ADD COLUMN     "batchId" UUID;

-- CreateTable
CREATE TABLE "stock_batches" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "goodId" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "purchaseOrderLineId" UUID,
    "stockMovementId" UUID NOT NULL,
    "batchNumber" TEXT,
    "expiryDate" TIMESTAMP(3),
    "receivedQty" DOUBLE PRECISION NOT NULL,
    "remainingQty" DOUBLE PRECISION NOT NULL,
    "costPrice" DECIMAL(12,2) NOT NULL,
    "salePrice" DECIMAL(12,2) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "syncVersion" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "batch_consumptions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "goodId" UUID NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "documentType" TEXT NOT NULL,
    "documentId" UUID NOT NULL,
    "documentLineId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" UUID,

    CONSTRAINT "batch_consumptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pricing_rules" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" "PricingRuleType" NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 10,
    "goodId" UUID,
    "goodCategory" TEXT,
    "goodType" TEXT,
    "percentValue" DECIMAL(6,2),
    "fixedAmount" DECIMAL(12,2),
    "fixedPrice" DECIMAL(12,2),
    "roundTo" DECIMAL(6,2),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "syncVersion" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "pricing_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_history" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "goodId" UUID NOT NULL,
    "oldPrice" DECIMAL(12,2),
    "newPrice" DECIMAL(12,2) NOT NULL,
    "costPrice" DECIMAL(12,2),
    "reason" TEXT,
    "batchId" UUID,
    "pricingRuleId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" UUID,

    CONSTRAINT "price_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "stock_batches_stockMovementId_key" ON "stock_batches"("stockMovementId");

-- CreateIndex
CREATE INDEX "stock_batches_orgId_goodId_warehouseId_isActive_idx" ON "stock_batches"("orgId", "goodId", "warehouseId", "isActive");

-- CreateIndex
CREATE INDEX "stock_batches_orgId_goodId_expiryDate_idx" ON "stock_batches"("orgId", "goodId", "expiryDate");

-- CreateIndex
CREATE INDEX "batch_consumptions_orgId_batchId_idx" ON "batch_consumptions"("orgId", "batchId");

-- CreateIndex
CREATE INDEX "batch_consumptions_orgId_documentType_documentId_idx" ON "batch_consumptions"("orgId", "documentType", "documentId");

-- CreateIndex
CREATE INDEX "pricing_rules_orgId_isActive_priority_idx" ON "pricing_rules"("orgId", "isActive", "priority");

-- CreateIndex
CREATE INDEX "pricing_rules_orgId_deletedAt_idx" ON "pricing_rules"("orgId", "deletedAt");

-- CreateIndex
CREATE INDEX "price_history_orgId_goodId_createdAt_idx" ON "price_history"("orgId", "goodId", "createdAt");

-- AddForeignKey
ALTER TABLE "work_order_parts" ADD CONSTRAINT "work_order_parts_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "stock_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "stock_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_batches" ADD CONSTRAINT "stock_batches_goodId_fkey" FOREIGN KEY ("goodId") REFERENCES "goods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_batches" ADD CONSTRAINT "stock_batches_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_batches" ADD CONSTRAINT "stock_batches_purchaseOrderLineId_fkey" FOREIGN KEY ("purchaseOrderLineId") REFERENCES "purchase_order_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_batches" ADD CONSTRAINT "stock_batches_stockMovementId_fkey" FOREIGN KEY ("stockMovementId") REFERENCES "stock_movements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch_consumptions" ADD CONSTRAINT "batch_consumptions_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "stock_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pricing_rules" ADD CONSTRAINT "pricing_rules_goodId_fkey" FOREIGN KEY ("goodId") REFERENCES "goods"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_history" ADD CONSTRAINT "price_history_goodId_fkey" FOREIGN KEY ("goodId") REFERENCES "goods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_history" ADD CONSTRAINT "price_history_pricingRuleId_fkey" FOREIGN KEY ("pricingRuleId") REFERENCES "pricing_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;
