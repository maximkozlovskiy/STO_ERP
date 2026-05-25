/*
  Warnings:

  - The `status` column on the `invoices` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `status` column on the `purchase_orders` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- CreateEnum
CREATE TYPE "PurchaseOrderStatus" AS ENUM ('DRAFT', 'ORDERED', 'RECEIVED', 'PARTIAL', 'CANCELLED');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'SENT', 'PAID', 'OVERDUE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "MovementDocumentType" AS ENUM ('WORK_ORDER', 'PURCHASE_ORDER', 'STOCK_DOCUMENT', 'MANUAL');

-- CreateEnum
CREATE TYPE "CalendarSlotStatus" AS ENUM ('AVAILABLE', 'BOOKED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "CalendarSlotType" AS ENUM ('WORK', 'MAINTENANCE', 'BREAK', 'MEETING');

-- CreateEnum
CREATE TYPE "EmployeeStatus" AS ENUM ('ACTIVE', 'ON_LEAVE', 'FIRED');

-- CreateEnum
CREATE TYPE "WorkOrderPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "RepairCategory" AS ENUM ('MAINTENANCE', 'CURRENT_REPAIR', 'MAJOR_REPAIR', 'BODY_REPAIR', 'DIAGNOSTICS', 'WARRANTY', 'SEASONAL');

-- CreateEnum
CREATE TYPE "GoodType" AS ENUM ('SPARE_PART', 'CONSUMABLE', 'MATERIAL', 'TOOL');

-- CreateEnum
CREATE TYPE "LegalForm" AS ENUM ('INDIVIDUAL', 'FOP', 'TOV', 'AT', 'PP', 'OTHER');

-- CreateEnum
CREATE TYPE "LiftStatus" AS ENUM ('ACTIVE', 'MAINTENANCE', 'BROKEN', 'DECOMMISSIONED');

-- CreateEnum
CREATE TYPE "CompletionActStatus" AS ENUM ('DRAFT', 'SIGNED', 'CANCELLED');

-- AlterEnum
ALTER TYPE "DocumentType" ADD VALUE 'COMPLETION_ACT';

-- AlterTable
ALTER TABLE "calendar_slots" ADD COLUMN     "status" "CalendarSlotStatus" NOT NULL DEFAULT 'BOOKED',
ADD COLUMN     "type" "CalendarSlotType" NOT NULL DEFAULT 'WORK';

-- AlterTable
ALTER TABLE "counterparties" ADD COLUMN     "actualAddress" TEXT,
ADD COLUMN     "bankAccount" TEXT,
ADD COLUMN     "bankName" TEXT,
ADD COLUMN     "contactPerson" TEXT,
ADD COLUMN     "legalAddress" TEXT,
ADD COLUMN     "legalForm" "LegalForm",
ADD COLUMN     "taxNumber" TEXT;

-- AlterTable
ALTER TABLE "employees" ADD COLUMN     "dateOfFire" TIMESTAMP(3),
ADD COLUMN     "dateOfHire" TIMESTAMP(3),
ADD COLUMN     "email" TEXT,
ADD COLUMN     "status" "EmployeeStatus" NOT NULL DEFAULT 'ACTIVE';

-- AlterTable
ALTER TABLE "goods" ADD COLUMN     "goodType" "GoodType",
ADD COLUMN     "preferredSupplierId" UUID;

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "invoiceType" TEXT NOT NULL DEFAULT 'INVOICE',
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "totalVat" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "totalWithVat" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "totalWithoutVat" DECIMAL(12,2) NOT NULL DEFAULT 0,
DROP COLUMN "status",
ADD COLUMN     "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT';

-- AlterTable
ALTER TABLE "lifts" ADD COLUMN     "lastMaintenanceDate" TIMESTAMP(3),
ADD COLUMN     "maintenanceIntervalDays" INTEGER,
ADD COLUMN     "nextMaintenanceDate" TIMESTAMP(3),
ADD COLUMN     "purchaseDate" TIMESTAMP(3),
ADD COLUMN     "serialNumber" TEXT,
ADD COLUMN     "status" "LiftStatus" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "warrantyUntil" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "purchase_orders" DROP COLUMN "status",
ADD COLUMN     "status" "PurchaseOrderStatus" NOT NULL DEFAULT 'DRAFT';

-- AlterTable
ALTER TABLE "vehicles" ADD COLUMN     "bodyType" TEXT,
ADD COLUMN     "driveType" TEXT,
ADD COLUMN     "engineCode" TEXT,
ADD COLUMN     "inspectionExpiry" TIMESTAMP(3),
ADD COLUMN     "insuranceExpiry" TIMESTAMP(3),
ADD COLUMN     "transmissionType" TEXT;

-- AlterTable
ALTER TABLE "work_order_lines" ADD COLUMN     "actualHours" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "work_orders" ADD COLUMN     "clientApproval" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "dueDate" TIMESTAMP(3),
ADD COLUMN     "priority" "WorkOrderPriority" NOT NULL DEFAULT 'NORMAL',
ADD COLUMN     "repairCategory" "RepairCategory";

-- CreateTable
CREATE TABLE "invoice_lines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "goodId" UUID,
    "workId" UUID,
    "description" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "unitPrice" DECIMAL(12,2) NOT NULL,
    "vatRate" DECIMAL(5,2) NOT NULL DEFAULT 20,
    "priceWithoutVat" DECIMAL(12,2) NOT NULL,
    "vatAmount" DECIMAL(12,2) NOT NULL,
    "priceWithVat" DECIMAL(12,2) NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "maintenance_schedules" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "vehicleId" UUID NOT NULL,
    "maintenanceType" TEXT NOT NULL DEFAULT 'REGULAR',
    "intervalDays" INTEGER,
    "intervalMileage" INTEGER,
    "lastMaintenanceDate" TIMESTAMP(3),
    "lastMaintenanceMileage" INTEGER,
    "nextMaintenanceDate" TIMESTAMP(3),
    "nextMaintenanceMileage" INTEGER,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "syncVersion" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "maintenance_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "completion_acts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "workOrderId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "status" "CompletionActStatus" NOT NULL DEFAULT 'DRAFT',
    "signedAt" TIMESTAMP(3),
    "signedBy" TEXT,
    "clientPhone" TEXT,
    "notes" TEXT,
    "syncVersion" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "completion_acts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "invoice_lines_orgId_invoiceId_idx" ON "invoice_lines"("orgId", "invoiceId");

-- CreateIndex
CREATE INDEX "maintenance_schedules_orgId_vehicleId_deletedAt_idx" ON "maintenance_schedules"("orgId", "vehicleId", "deletedAt");

-- CreateIndex
CREATE INDEX "maintenance_schedules_orgId_nextMaintenanceDate_idx" ON "maintenance_schedules"("orgId", "nextMaintenanceDate");

-- CreateIndex
CREATE INDEX "maintenance_schedules_orgId_syncVersion_idx" ON "maintenance_schedules"("orgId", "syncVersion");

-- CreateIndex
CREATE INDEX "completion_acts_orgId_workOrderId_deletedAt_idx" ON "completion_acts"("orgId", "workOrderId", "deletedAt");

-- CreateIndex
CREATE INDEX "completion_acts_orgId_syncVersion_idx" ON "completion_acts"("orgId", "syncVersion");

-- CreateIndex
CREATE UNIQUE INDEX "completion_acts_orgId_number_key" ON "completion_acts"("orgId", "number");

-- CreateIndex
CREATE INDEX "invoices_orgId_status_deletedAt_idx" ON "invoices"("orgId", "status", "deletedAt");

-- CreateIndex
CREATE INDEX "purchase_orders_orgId_status_deletedAt_idx" ON "purchase_orders"("orgId", "status", "deletedAt");

-- AddForeignKey
ALTER TABLE "goods" ADD CONSTRAINT "goods_preferredSupplierId_fkey" FOREIGN KEY ("preferredSupplierId") REFERENCES "counterparties"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_goodId_fkey" FOREIGN KEY ("goodId") REFERENCES "goods"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_workId_fkey" FOREIGN KEY ("workId") REFERENCES "works"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_schedules" ADD CONSTRAINT "maintenance_schedules_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "completion_acts" ADD CONSTRAINT "completion_acts_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "work_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
