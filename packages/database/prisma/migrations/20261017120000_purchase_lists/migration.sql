-- Списки купівлі (docs/objects/purchase-list.md, BR-PL-*): товари під замовлення у постачальника —
-- з нарядів і вручну. Рішення власника 2026-10-17.
--
-- Нове значення DocumentType.PURCHASE_LIST НЕ використовується в цій міграції: Postgres забороняє
-- нове enum-значення в тій самій транзакції, де воно додане. Конфігурацію нумерації для наявних
-- організацій додає наступна міграція 20261017120001.

-- AlterEnum
ALTER TYPE "DocumentType" ADD VALUE IF NOT EXISTS 'PURCHASE_LIST';

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "PurchaseListStatus" AS ENUM ('OPEN', 'CLOSED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "PurchaseListItemStatus" AS ENUM ('OPEN', 'ORDERED', 'RECEIVED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "PurchaseListItemSource" AS ENUM ('WORK_ORDER', 'MANUAL');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- CreateTable
CREATE TABLE "purchase_lists" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "name" TEXT,
    "status" "PurchaseListStatus" NOT NULL DEFAULT 'OPEN',
    "warehouseId" UUID,
    "notes" TEXT,
    "mergedIntoId" UUID,
    "closedAt" TIMESTAMP(3),
    "syncVersion" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "purchase_lists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_list_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "listId" UUID NOT NULL,
    "goodId" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "receivedQty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "reservedQty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" "PurchaseListItemStatus" NOT NULL DEFAULT 'OPEN',
    "source" "PurchaseListItemSource" NOT NULL,
    "workOrderId" UUID,
    "workOrderPartId" UUID,
    "supplierId" UUID,
    "expectedPrice" DECIMAL(12,2),
    "purchaseOrderId" UUID,
    "notes" TEXT,
    "syncVersion" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "purchase_list_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "purchase_lists_orgId_status_deletedAt_createdAt_idx" ON "purchase_lists"("orgId", "status", "deletedAt", "createdAt");

-- CreateIndex
CREATE INDEX "purchase_lists_orgId_deletedAt_createdAt_idx" ON "purchase_lists"("orgId", "deletedAt", "createdAt");

-- CreateIndex
CREATE INDEX "purchase_lists_orgId_syncVersion_idx" ON "purchase_lists"("orgId", "syncVersion");

-- CreateIndex
CREATE INDEX "purchase_list_items_orgId_listId_deletedAt_idx" ON "purchase_list_items"("orgId", "listId", "deletedAt");

-- CreateIndex
CREATE INDEX "purchase_list_items_orgId_status_deletedAt_createdAt_idx" ON "purchase_list_items"("orgId", "status", "deletedAt", "createdAt");

-- CreateIndex
CREATE INDEX "purchase_list_items_orgId_workOrderId_deletedAt_idx" ON "purchase_list_items"("orgId", "workOrderId", "deletedAt");

-- CreateIndex
CREATE INDEX "purchase_list_items_orgId_purchaseOrderId_goodId_status_idx" ON "purchase_list_items"("orgId", "purchaseOrderId", "goodId", "status");

-- CreateIndex
CREATE INDEX "purchase_list_items_orgId_goodId_warehouseId_status_idx" ON "purchase_list_items"("orgId", "goodId", "warehouseId", "status");

-- CreateIndex
CREATE INDEX "purchase_list_items_orgId_supplierId_status_idx" ON "purchase_list_items"("orgId", "supplierId", "status");

-- CreateIndex
CREATE INDEX "purchase_list_items_orgId_syncVersion_idx" ON "purchase_list_items"("orgId", "syncVersion");

-- AddForeignKey
ALTER TABLE "purchase_lists" ADD CONSTRAINT "purchase_lists_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_lists" ADD CONSTRAINT "purchase_lists_mergedIntoId_fkey" FOREIGN KEY ("mergedIntoId") REFERENCES "purchase_lists"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_list_items" ADD CONSTRAINT "purchase_list_items_listId_fkey" FOREIGN KEY ("listId") REFERENCES "purchase_lists"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_list_items" ADD CONSTRAINT "purchase_list_items_goodId_fkey" FOREIGN KEY ("goodId") REFERENCES "goods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_list_items" ADD CONSTRAINT "purchase_list_items_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_list_items" ADD CONSTRAINT "purchase_list_items_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "work_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_list_items" ADD CONSTRAINT "purchase_list_items_workOrderPartId_fkey" FOREIGN KEY ("workOrderPartId") REFERENCES "work_order_parts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_list_items" ADD CONSTRAINT "purchase_list_items_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "counterparties"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_list_items" ADD CONSTRAINT "purchase_list_items_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "purchase_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Номер списку унікальний серед невидалених (як T14 для інших документів; Prisma не виражає partial-unique).
CREATE UNIQUE INDEX IF NOT EXISTS "purchase_lists_orgId_number_active_uq"
    ON "purchase_lists" ("orgId", "number") WHERE "deletedAt" IS NULL;

-- Кількості позиції — у базових одиницях товару (BR-PL-002). Резерв не більший за отримане (BR-PL-011).
ALTER TABLE "purchase_list_items"
    ADD CONSTRAINT "purchase_list_items_quantity_positive_chk" CHECK ("quantity" > 0),
    ADD CONSTRAINT "purchase_list_items_received_nonneg_chk" CHECK ("receivedQty" >= 0),
    ADD CONSTRAINT "purchase_list_items_reserved_range_chk"
        CHECK ("reservedQty" >= 0 AND "reservedQty" <= "receivedQty" + 0.000001);
