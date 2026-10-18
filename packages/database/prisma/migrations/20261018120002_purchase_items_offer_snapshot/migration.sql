-- Знімок обраної пропозиції на позиції списку купівлі (BR-PL-017…019, BR-SOFR) і підсумок передачі
-- замовлення постачальнику через API (BR-PO-011).

-- AlterTable
ALTER TABLE "purchase_list_items" ADD COLUMN     "offerArticle" TEXT,
ADD COLUMN     "offerBrand" TEXT,
ADD COLUMN     "offerChosenBy" "OfferChosenBy",
ADD COLUMN     "offerConnectionId" UUID,
ADD COLUMN     "offerCurrencyCode" TEXT,
ADD COLUMN     "offerDeliveryDate" TIMESTAMP(3),
ADD COLUMN     "offerDeliveryDays" INTEGER,
ADD COLUMN     "offerIsAnalog" BOOLEAN,
ADD COLUMN     "offerKey" TEXT,
ADD COLUMN     "offerMultiplicity" DOUBLE PRECISION,
ADD COLUMN     "offerPrice" DECIMAL(12,2),
ADD COLUMN     "offerSupplierItemId" TEXT,
ADD COLUMN     "offerWarehouseCode" TEXT,
ADD COLUMN     "offerWarehouseName" TEXT,
ADD COLUMN     "offeredAt" TIMESTAMP(3),
ADD COLUMN     "originalGoodId" UUID;

-- AlterTable
ALTER TABLE "purchase_orders" ADD COLUMN     "supplierApiError" TEXT,
ADD COLUMN     "supplierApiSentAt" TIMESTAMP(3),
ADD COLUMN     "supplierApiStatus" "PurchaseOrderSupplierApiStatus" NOT NULL DEFAULT 'NOT_SENT';

-- CreateIndex
CREATE INDEX "purchase_orders_orgId_supplierApiStatus_deletedAt_idx" ON "purchase_orders"("orgId", "supplierApiStatus", "deletedAt");
