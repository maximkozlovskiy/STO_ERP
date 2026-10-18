-- Постачальники API (docs/objects/supplier-connection.md BR-SCON-*, supplier-offer.md BR-SOFR-*):
-- підключення, пропозиції, дзеркало каталогу AVD, замовлення через API. Рішення власника 2026-10-18.

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "SupplierProvider" AS ENUM ('TEHNOMIR', 'BM_PARTS', 'UTR', 'AD_UKRAINE', 'AVD_TRADE');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "SupplierVerifyStatus" AS ENUM ('NEVER', 'PENDING', 'OK', 'FAILED');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "SupplierOfferRequestStatus" AS ENUM ('QUEUED', 'RUNNING', 'RETRYING', 'DONE', 'FAILED');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "SupplierOrderStatus" AS ENUM ('QUEUED', 'SENDING', 'PLACED', 'CONFIRMED', 'PARTIALLY_CONFIRMED', 'READY', 'SHIPPED', 'REJECTED', 'CANCELLED', 'FAILED', 'UNKNOWN');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "PurchaseOrderSupplierApiStatus" AS ENUM ('NOT_SENT', 'QUEUED', 'SENT', 'PARTIAL', 'CONFIRMED', 'FAILED', 'NEEDS_ATTENTION');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "SupplierOrderSendMode" AS ENUM ('MANUAL', 'ON_ORDERED');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "SupplierAnalogPolicy" AS ENUM ('CREATE_AND_REPLACE', 'SHOW_ONLY', 'CATALOG_ONLY');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "SupplierStrategy" AS ENUM ('FAST', 'CHEAP', 'OPTIMAL');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "OfferChosenBy" AS ENUM ('MANUAL', 'AUTO');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- CreateTable
CREATE TABLE "supplier_connections" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "counterpartyId" UUID NOT NULL,
    "provider" "SupplierProvider" NOT NULL,
    "name" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "apiUrl" TEXT,
    "testMode" BOOLEAN NOT NULL DEFAULT false,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "defaultDeliveryDays" INTEGER,
    "credentials" TEXT,
    "authState" TEXT,
    "options" JSONB NOT NULL DEFAULT '{}',
    "verifyStatus" "SupplierVerifyStatus" NOT NULL DEFAULT 'NEVER',
    "verifyRequestedAt" TIMESTAMP(3),
    "lastVerifiedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "catalogSyncedAt" TIMESTAMP(3),
    "catalogSyncStatus" TEXT,
    "catalogSyncError" TEXT,
    "syncVersion" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "supplier_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_offer_batches" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "purpose" "OfferChosenBy" NOT NULL,
    "strategy" "SupplierStrategy",
    "requestedBy" UUID,
    "itemIds" JSONB NOT NULL DEFAULT '[]',
    "completedAt" TIMESTAMP(3),
    "syncVersion" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "supplier_offer_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_offer_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "batchId" UUID,
    "connectionId" UUID NOT NULL,
    "purchaseListItemId" UUID,
    "goodId" UUID,
    "article" TEXT NOT NULL,
    "articleNormalized" TEXT NOT NULL,
    "brand" TEXT,
    "includeAnalogs" BOOLEAN NOT NULL DEFAULT true,
    "status" "SupplierOfferRequestStatus" NOT NULL DEFAULT 'QUEUED',
    "attemptsMade" INTEGER NOT NULL DEFAULT 0,
    "nextRetryAt" TIMESTAMP(3),
    "error" TEXT,
    "enqueueError" TEXT,
    "fromCache" BOOLEAN NOT NULL DEFAULT false,
    "cacheOfId" UUID,
    "completedAt" TIMESTAMP(3),
    "syncVersion" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "supplier_offer_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_offers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "connectionId" UUID NOT NULL,
    "supplierItemId" TEXT NOT NULL,
    "article" TEXT NOT NULL,
    "articleNormalized" TEXT NOT NULL,
    "brand" TEXT,
    "name" TEXT,
    "price" DECIMAL(12,2) NOT NULL,
    "currencyCode" TEXT NOT NULL DEFAULT 'UAH',
    "qty" DOUBLE PRECISION NOT NULL,
    "qtyIsLowerBound" BOOLEAN NOT NULL DEFAULT false,
    "warehouseCode" TEXT,
    "warehouseName" TEXT,
    "deliveryDays" INTEGER,
    "deliveryDate" TIMESTAMP(3),
    "multiplicity" DOUBLE PRECISION,
    "isAnalog" BOOLEAN NOT NULL DEFAULT false,
    "offerKey" TEXT NOT NULL,
    "matchedGoodId" UUID,
    "matchStatus" TEXT,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "syncVersion" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "supplier_offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_catalog_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "connectionId" UUID NOT NULL,
    "supplierItemId" TEXT NOT NULL,
    "article" TEXT NOT NULL,
    "articleNormalized" TEXT NOT NULL,
    "brand" TEXT,
    "brandNormalized" TEXT,
    "name" TEXT,
    "price" DECIMAL(12,2) NOT NULL,
    "currencyCode" TEXT NOT NULL DEFAULT 'UAH',
    "priceType" TEXT,
    "stock" JSONB NOT NULL DEFAULT '[]',
    "seenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "syncVersion" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "supplier_catalog_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_orders" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "purchaseOrderId" UUID NOT NULL,
    "connectionId" UUID NOT NULL,
    "supplierWarehouseCode" TEXT,
    "status" "SupplierOrderStatus" NOT NULL DEFAULT 'QUEUED',
    "step" TEXT,
    "externalCartId" TEXT,
    "externalOrderId" TEXT,
    "externalNumber" TEXT,
    "externalStatusRaw" TEXT,
    "reference" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "lastPolledAt" TIMESTAMP(3),
    "nextPollAt" TIMESTAMP(3),
    "error" TEXT,
    "syncVersion" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "supplier_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_order_lines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "supplierOrderId" UUID NOT NULL,
    "goodId" UUID NOT NULL,
    "offerKey" TEXT NOT NULL,
    "supplierItemId" TEXT NOT NULL,
    "warehouseCode" TEXT,
    "qtyRequested" DOUBLE PRECISION NOT NULL,
    "qtyConfirmed" DOUBLE PRECISION,
    "priceRequested" DECIMAL(12,2) NOT NULL,
    "priceConfirmed" DECIMAL(12,2),
    "currencyCode" TEXT NOT NULL DEFAULT 'UAH',
    "externalLineId" TEXT,
    "statusRaw" TEXT,
    "syncVersion" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "supplier_order_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "supplier_connections_orgId_enabled_deletedAt_idx" ON "supplier_connections"("orgId", "enabled", "deletedAt");

-- CreateIndex
CREATE INDEX "supplier_connections_orgId_syncVersion_idx" ON "supplier_connections"("orgId", "syncVersion");

-- CreateIndex
CREATE INDEX "supplier_offer_batches_orgId_createdAt_idx" ON "supplier_offer_batches"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "supplier_offer_batches_orgId_syncVersion_idx" ON "supplier_offer_batches"("orgId", "syncVersion");

-- CreateIndex
CREATE INDEX "supplier_offer_requests_orgId_batchId_idx" ON "supplier_offer_requests"("orgId", "batchId");

-- CreateIndex
CREATE INDEX "supplier_offer_requests_orgId_connectionId_articleNormalize_idx" ON "supplier_offer_requests"("orgId", "connectionId", "articleNormalized", "includeAnalogs", "completedAt");

-- CreateIndex
CREATE INDEX "supplier_offer_requests_orgId_status_createdAt_idx" ON "supplier_offer_requests"("orgId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "supplier_offer_requests_orgId_syncVersion_idx" ON "supplier_offer_requests"("orgId", "syncVersion");

-- CreateIndex
CREATE INDEX "supplier_offers_orgId_requestId_idx" ON "supplier_offers"("orgId", "requestId");

-- CreateIndex
CREATE INDEX "supplier_offers_orgId_connectionId_articleNormalized_idx" ON "supplier_offers"("orgId", "connectionId", "articleNormalized");

-- CreateIndex
CREATE INDEX "supplier_offers_orgId_fetchedAt_idx" ON "supplier_offers"("orgId", "fetchedAt");

-- CreateIndex
CREATE INDEX "supplier_offers_orgId_syncVersion_idx" ON "supplier_offers"("orgId", "syncVersion");

-- CreateIndex
CREATE INDEX "supplier_catalog_items_orgId_connectionId_articleNormalized_idx" ON "supplier_catalog_items"("orgId", "connectionId", "articleNormalized");

-- CreateIndex
CREATE INDEX "supplier_catalog_items_orgId_syncVersion_idx" ON "supplier_catalog_items"("orgId", "syncVersion");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_catalog_items_connectionId_supplierItemId_key" ON "supplier_catalog_items"("connectionId", "supplierItemId");

-- CreateIndex
CREATE INDEX "supplier_orders_orgId_purchaseOrderId_idx" ON "supplier_orders"("orgId", "purchaseOrderId");

-- CreateIndex
CREATE INDEX "supplier_orders_orgId_status_nextPollAt_idx" ON "supplier_orders"("orgId", "status", "nextPollAt");

-- CreateIndex
CREATE INDEX "supplier_orders_orgId_syncVersion_idx" ON "supplier_orders"("orgId", "syncVersion");

-- CreateIndex
CREATE INDEX "supplier_order_lines_orgId_supplierOrderId_idx" ON "supplier_order_lines"("orgId", "supplierOrderId");

-- CreateIndex
CREATE INDEX "supplier_order_lines_orgId_syncVersion_idx" ON "supplier_order_lines"("orgId", "syncVersion");

-- AddForeignKey
ALTER TABLE "supplier_connections" ADD CONSTRAINT "supplier_connections_counterpartyId_fkey" FOREIGN KEY ("counterpartyId") REFERENCES "counterparties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_offer_requests" ADD CONSTRAINT "supplier_offer_requests_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "supplier_offer_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_offer_requests" ADD CONSTRAINT "supplier_offer_requests_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "supplier_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_offers" ADD CONSTRAINT "supplier_offers_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "supplier_offer_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_offers" ADD CONSTRAINT "supplier_offers_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "supplier_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_catalog_items" ADD CONSTRAINT "supplier_catalog_items_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "supplier_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_orders" ADD CONSTRAINT "supplier_orders_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_orders" ADD CONSTRAINT "supplier_orders_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "supplier_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_order_lines" ADD CONSTRAINT "supplier_order_lines_supplierOrderId_fkey" FOREIGN KEY ("supplierOrderId") REFERENCES "supplier_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_order_lines" ADD CONSTRAINT "supplier_order_lines_goodId_fkey" FOREIGN KEY ("goodId") REFERENCES "goods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Одне підключення на (постачальник-контрагент, провайдер) серед невидалених (BR-SCON).
CREATE UNIQUE INDEX IF NOT EXISTS "supplier_connections_org_cp_provider_active_uq"
    ON "supplier_connections" ("orgId", "counterpartyId", "provider") WHERE "deletedAt" IS NULL;

-- Кількості й ціни пропозицій, каталогу й рядків замовлень — невід'ємні (BR-SOFR, BR-SCON).
ALTER TABLE "supplier_offers"
    ADD CONSTRAINT "supplier_offers_qty_nonneg_chk" CHECK ("qty" >= 0),
    ADD CONSTRAINT "supplier_offers_price_nonneg_chk" CHECK ("price" >= 0);
ALTER TABLE "supplier_catalog_items"
    ADD CONSTRAINT "supplier_catalog_items_price_nonneg_chk" CHECK ("price" >= 0);
ALTER TABLE "supplier_order_lines"
    ADD CONSTRAINT "supplier_order_lines_qty_positive_chk" CHECK ("qtyRequested" > 0),
    ADD CONSTRAINT "supplier_order_lines_confirmed_nonneg_chk"
        CHECK ("qtyConfirmed" IS NULL OR "qtyConfirmed" >= 0);
