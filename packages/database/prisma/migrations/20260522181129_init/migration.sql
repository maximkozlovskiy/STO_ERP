-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC', 'STOREKEEPER', 'ACCOUNTANT', 'CLIENT');

-- CreateEnum
CREATE TYPE "WorkOrderStatus" AS ENUM ('DRAFT', 'ESTIMATE', 'APPROVED', 'IN_PROGRESS', 'ON_HOLD', 'COMPLETED', 'INVOICED', 'PAID', 'ARCHIVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ZoneType" AS ENUM ('MECHANICAL', 'BODY', 'TIRE', 'WASH', 'ELECTRICAL', 'OTHER');

-- CreateEnum
CREATE TYPE "LiftType" AS ENUM ('TWO_POST', 'FOUR_POST', 'ALIGNMENT', 'STENCIL', 'STAND', 'OTHER');

-- CreateEnum
CREATE TYPE "WarehouseType" AS ENUM ('MAIN', 'WORKSHOP', 'TIRE_HOTEL', 'MOBILE');

-- CreateEnum
CREATE TYPE "CounterpartyType" AS ENUM ('CLIENT', 'SUPPLIER', 'BOTH');

-- CreateEnum
CREATE TYPE "StockMovementType" AS ENUM ('RECEIPT', 'WRITEOFF', 'TRANSFER', 'RESERVATION', 'RESERVATION_RELEASE', 'OPENING_BALANCE');

-- CreateEnum
CREATE TYPE "StockDocumentType" AS ENUM ('WRITEOFF', 'TRANSFER', 'OPENING_BALANCE');

-- CreateEnum
CREATE TYPE "StockDocumentStatus" AS ENUM ('DRAFT', 'CONFIRMED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('WORK_ORDER', 'INVOICE', 'PURCHASE_ORDER', 'STOCK_RECEIPT', 'STOCK_WRITEOFF', 'STOCK_TRANSFER', 'STOCK_OPENING', 'RECONCILIATION_ACT');

-- CreateEnum
CREATE TYPE "ResetPeriod" AS ENUM ('NEVER', 'YEARLY', 'MONTHLY');

-- CreateEnum
CREATE TYPE "VatMode" AS ENUM ('NONE', 'EXCLUSIVE', 'INCLUSIVE');

-- CreateEnum
CREATE TYPE "NotificationEventType" AS ENUM ('WO_CREATED', 'WO_ESTIMATE_READY', 'WO_APPROVED', 'WO_IN_PROGRESS', 'WO_COMPLETED', 'WO_READY_FOR_PICKUP', 'PAYMENT_RECEIVED', 'INVOICE_SENT', 'LOW_STOCK_ALERT');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('SMS', 'VIBER', 'EMAIL');

-- CreateEnum
CREATE TYPE "SettlementTransactionType" AS ENUM ('CHARGE', 'PAYMENT', 'REFUND', 'PREPAYMENT', 'CREDIT_NOTE');

-- CreateTable
CREATE TABLE "organisations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "edrpou" TEXT,
    "syncVersion" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "organisations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "garage_branches" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Kyiv',
    "syncVersion" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "garage_branches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zones" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" "ZoneType" NOT NULL,
    "syncVersion" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "zones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lifts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "zoneId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" "LiftType" NOT NULL,
    "maxWeightKg" INTEGER,
    "syncVersion" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "lifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouses" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" "WarehouseType" NOT NULL DEFAULT 'MAIN',
    "syncVersion" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "warehouses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employees" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "userId" UUID,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "phone" TEXT,
    "role" "UserRole" NOT NULL,
    "rateScheme" JSONB NOT NULL,
    "syncVersion" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "employees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_zones" (
    "employeeId" UUID NOT NULL,
    "zoneId" UUID NOT NULL,

    CONSTRAINT "employee_zones_pkey" PRIMARY KEY ("employeeId","zoneId")
);

-- CreateTable
CREATE TABLE "employee_lifts" (
    "employeeId" UUID NOT NULL,
    "liftId" UUID NOT NULL,

    CONSTRAINT "employee_lifts_pkey" PRIMARY KEY ("employeeId","liftId")
);

-- CreateTable
CREATE TABLE "employee_work_categories" (
    "employeeId" UUID NOT NULL,
    "workCategoryId" UUID NOT NULL,

    CONSTRAINT "employee_work_categories_pkey" PRIMARY KEY ("employeeId","workCategoryId")
);

-- CreateTable
CREATE TABLE "counterparties" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "type" "CounterpartyType" NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT,
    "companyName" TEXT,
    "edrpou" TEXT,
    "vatPayer" BOOLEAN NOT NULL DEFAULT false,
    "phone" TEXT,
    "email" TEXT,
    "notes" TEXT,
    "syncVersion" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "counterparties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_garages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "counterpartyId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "notes" TEXT,
    "syncVersion" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "customer_garages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "customerGarageId" UUID NOT NULL,
    "vin" TEXT,
    "licensePlate" TEXT,
    "make" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "year" INTEGER,
    "engineVolume" DOUBLE PRECISION,
    "fuelType" TEXT,
    "currentMileage" INTEGER,
    "color" TEXT,
    "notes" TEXT,
    "syncVersion" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "vehicles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_nodes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "vehicleId" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mileageAtInstall" INTEGER,
    "notes" TEXT,
    "syncVersion" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "vehicle_nodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_categories" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "parentId" UUID,
    "name" TEXT NOT NULL,
    "icon" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "syncVersion" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "work_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "works" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "categoryId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "normoHours" DOUBLE PRECISION NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "description" TEXT,
    "syncVersion" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "works_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goods" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "sku" TEXT,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'шт',
    "purchasePrice" DECIMAL(12,2),
    "salePrice" DECIMAL(12,2) NOT NULL,
    "category" TEXT,
    "barcode" TEXT,
    "notes" TEXT,
    "syncVersion" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "goods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "services" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "price" DECIMAL(12,2),
    "syncVersion" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_works" (
    "serviceId" UUID NOT NULL,
    "workId" UUID NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL DEFAULT 1,

    CONSTRAINT "service_works_pkey" PRIMARY KEY ("serviceId","workId")
);

-- CreateTable
CREATE TABLE "service_goods" (
    "serviceId" UUID NOT NULL,
    "goodId" UUID NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL DEFAULT 1,

    CONSTRAINT "service_goods_pkey" PRIMARY KEY ("serviceId","goodId")
);

-- CreateTable
CREATE TABLE "work_orders" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "vehicleId" UUID NOT NULL,
    "counterpartyId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "status" "WorkOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "description" TEXT,
    "inMileage" INTEGER,
    "outMileage" INTEGER,
    "plannedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "warrantyUntil" TIMESTAMP(3),
    "totalLabor" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "totalParts" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "totalAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "paidAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "syncVersion" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "work_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_order_lines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "workOrderId" UUID NOT NULL,
    "workId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "liftId" UUID,
    "normoHours" DOUBLE PRECISION NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "notes" TEXT,
    "syncVersion" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "work_order_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_order_line_employees" (
    "workOrderLineId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,

    CONSTRAINT "work_order_line_employees_pkey" PRIMARY KEY ("workOrderLineId","employeeId")
);

-- CreateTable
CREATE TABLE "work_order_parts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "workOrderId" UUID NOT NULL,
    "goodId" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "syncVersion" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "work_order_parts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "goodId" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "reserved" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "minStock" DOUBLE PRECISION,
    "syncVersion" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_movements" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "goodId" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "type" "StockMovementType" NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "price" DECIMAL(12,2),
    "documentType" TEXT,
    "documentId" UUID,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" UUID,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_orders" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "supplierId" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "totalAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "syncVersion" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_order_lines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "purchaseOrderId" UUID NOT NULL,
    "goodId" UUID NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "receivedQty" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "purchase_order_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_documents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "type" "StockDocumentType" NOT NULL,
    "status" "StockDocumentStatus" NOT NULL DEFAULT 'DRAFT',
    "warehouseId" UUID NOT NULL,
    "targetWarehouseId" UUID,
    "notes" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "confirmedBy" UUID,
    "syncVersion" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "stock_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_document_lines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "stockDocumentId" UUID NOT NULL,
    "goodId" UUID NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "price" DECIMAL(12,2),

    CONSTRAINT "stock_document_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_number_configs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "documentType" "DocumentType" NOT NULL,
    "prefix" TEXT,
    "includeDate" BOOLEAN NOT NULL DEFAULT true,
    "dateFormat" TEXT NOT NULL DEFAULT 'YYYYMMDD',
    "separator" TEXT NOT NULL DEFAULT '-',
    "padding" INTEGER NOT NULL DEFAULT 6,
    "currentSeq" BIGINT NOT NULL DEFAULT 0,
    "resetPeriod" "ResetPeriod" NOT NULL DEFAULT 'NEVER',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_number_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organisation_settings" (
    "orgId" UUID NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'UAH',
    "vatMode" "VatMode" NOT NULL DEFAULT 'EXCLUSIVE',
    "defaultVatRateId" UUID,
    "invoiceDueDays" INTEGER NOT NULL DEFAULT 7,
    "autoArchiveDays" INTEGER NOT NULL DEFAULT 30,
    "defaultWarrantyDays" INTEGER NOT NULL DEFAULT 30,
    "requireClientApproval" BOOLEAN NOT NULL DEFAULT true,
    "allowPartialPayment" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organisation_settings_pkey" PRIMARY KEY ("orgId")
);

-- CreateTable
CREATE TABLE "branch_settings" (
    "branchId" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "workStartTime" TEXT NOT NULL DEFAULT '09:00',
    "workEndTime" TEXT NOT NULL DEFAULT '18:00',
    "workDays" JSONB NOT NULL DEFAULT '[1,2,3,4,5]',
    "slotDurationMinutes" INTEGER NOT NULL DEFAULT 60,
    "fiscalEnabled" BOOLEAN NOT NULL DEFAULT false,
    "checkboxApiUrl" TEXT,
    "checkboxLicenseKey" TEXT,
    "checkboxPinCode" TEXT,
    "checkboxCashRegisterId" TEXT,
    "smsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "smsProvider" TEXT,
    "smsApiKey" TEXT,
    "smsSenderName" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "branch_settings_pkey" PRIMARY KEY ("branchId")
);

-- CreateTable
CREATE TABLE "notification_templates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "eventType" "NotificationEventType" NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_rates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "rate" DECIMAL(5,2) NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tax_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_method_configs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "requiresFiscal" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_method_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "counterpartyId" UUID NOT NULL,
    "workOrderId" UUID,
    "number" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "dueDate" TIMESTAMP(3),
    "syncVersion" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "counterpartyId" UUID NOT NULL,
    "workOrderId" UUID,
    "invoiceId" UUID,
    "amount" DECIMAL(12,2) NOT NULL,
    "method" TEXT NOT NULL,
    "notes" TEXT,
    "fiscalReceiptId" TEXT,
    "syncVersion" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlement_accounts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "counterpartyId" UUID NOT NULL,
    "balance" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "settlement_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlement_transactions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "settlementAccountId" UUID NOT NULL,
    "type" "SettlementTransactionType" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "documentType" TEXT,
    "documentId" UUID,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" UUID,

    CONSTRAINT "settlement_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation_acts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "counterpartyId" UUID NOT NULL,
    "periodFrom" TIMESTAMP(3) NOT NULL,
    "periodTo" TIMESTAMP(3) NOT NULL,
    "openingBalance" DECIMAL(12,2) NOT NULL,
    "closingBalance" DECIMAL(12,2) NOT NULL,
    "snapshotJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" UUID,

    CONSTRAINT "reconciliation_acts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calendar_slots" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "liftId" UUID,
    "employeeId" UUID,
    "workOrderId" UUID,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "notes" TEXT,
    "syncVersion" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "calendar_slots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organisations_edrpou_key" ON "organisations"("edrpou");

-- CreateIndex
CREATE INDEX "organisations_orgId_deletedAt_idx" ON "organisations"("orgId", "deletedAt");

-- CreateIndex
CREATE INDEX "organisations_orgId_syncVersion_idx" ON "organisations"("orgId", "syncVersion");

-- CreateIndex
CREATE INDEX "garage_branches_orgId_deletedAt_idx" ON "garage_branches"("orgId", "deletedAt");

-- CreateIndex
CREATE INDEX "garage_branches_orgId_syncVersion_idx" ON "garage_branches"("orgId", "syncVersion");

-- CreateIndex
CREATE INDEX "zones_orgId_deletedAt_idx" ON "zones"("orgId", "deletedAt");

-- CreateIndex
CREATE INDEX "zones_orgId_syncVersion_idx" ON "zones"("orgId", "syncVersion");

-- CreateIndex
CREATE INDEX "lifts_orgId_deletedAt_idx" ON "lifts"("orgId", "deletedAt");

-- CreateIndex
CREATE INDEX "lifts_orgId_syncVersion_idx" ON "lifts"("orgId", "syncVersion");

-- CreateIndex
CREATE INDEX "warehouses_orgId_deletedAt_idx" ON "warehouses"("orgId", "deletedAt");

-- CreateIndex
CREATE INDEX "warehouses_orgId_syncVersion_idx" ON "warehouses"("orgId", "syncVersion");

-- CreateIndex
CREATE INDEX "employees_orgId_deletedAt_idx" ON "employees"("orgId", "deletedAt");

-- CreateIndex
CREATE INDEX "employees_orgId_syncVersion_idx" ON "employees"("orgId", "syncVersion");

-- CreateIndex
CREATE INDEX "counterparties_orgId_type_deletedAt_idx" ON "counterparties"("orgId", "type", "deletedAt");

-- CreateIndex
CREATE INDEX "counterparties_orgId_syncVersion_idx" ON "counterparties"("orgId", "syncVersion");

-- CreateIndex
CREATE INDEX "customer_garages_orgId_deletedAt_idx" ON "customer_garages"("orgId", "deletedAt");

-- CreateIndex
CREATE INDEX "customer_garages_orgId_syncVersion_idx" ON "customer_garages"("orgId", "syncVersion");

-- CreateIndex
CREATE INDEX "vehicles_orgId_deletedAt_idx" ON "vehicles"("orgId", "deletedAt");

-- CreateIndex
CREATE INDEX "vehicles_orgId_vin_idx" ON "vehicles"("orgId", "vin");

-- CreateIndex
CREATE INDEX "vehicles_orgId_syncVersion_idx" ON "vehicles"("orgId", "syncVersion");

-- CreateIndex
CREATE INDEX "vehicle_nodes_orgId_vehicleId_deletedAt_idx" ON "vehicle_nodes"("orgId", "vehicleId", "deletedAt");

-- CreateIndex
CREATE INDEX "vehicle_nodes_orgId_syncVersion_idx" ON "vehicle_nodes"("orgId", "syncVersion");

-- CreateIndex
CREATE INDEX "work_categories_orgId_deletedAt_idx" ON "work_categories"("orgId", "deletedAt");

-- CreateIndex
CREATE INDEX "work_categories_orgId_syncVersion_idx" ON "work_categories"("orgId", "syncVersion");

-- CreateIndex
CREATE INDEX "works_orgId_deletedAt_idx" ON "works"("orgId", "deletedAt");

-- CreateIndex
CREATE INDEX "works_orgId_syncVersion_idx" ON "works"("orgId", "syncVersion");

-- CreateIndex
CREATE INDEX "goods_orgId_deletedAt_idx" ON "goods"("orgId", "deletedAt");

-- CreateIndex
CREATE INDEX "goods_orgId_sku_idx" ON "goods"("orgId", "sku");

-- CreateIndex
CREATE INDEX "goods_orgId_syncVersion_idx" ON "goods"("orgId", "syncVersion");

-- CreateIndex
CREATE INDEX "services_orgId_deletedAt_idx" ON "services"("orgId", "deletedAt");

-- CreateIndex
CREATE INDEX "services_orgId_syncVersion_idx" ON "services"("orgId", "syncVersion");

-- CreateIndex
CREATE INDEX "work_orders_orgId_status_deletedAt_idx" ON "work_orders"("orgId", "status", "deletedAt");

-- CreateIndex
CREATE INDEX "work_orders_orgId_syncVersion_idx" ON "work_orders"("orgId", "syncVersion");

-- CreateIndex
CREATE INDEX "work_orders_orgId_counterpartyId_idx" ON "work_orders"("orgId", "counterpartyId");

-- CreateIndex
CREATE INDEX "work_orders_orgId_branchId_deletedAt_idx" ON "work_orders"("orgId", "branchId", "deletedAt");

-- CreateIndex
CREATE INDEX "work_order_lines_orgId_workOrderId_idx" ON "work_order_lines"("orgId", "workOrderId");

-- CreateIndex
CREATE INDEX "work_order_lines_orgId_employeeId_idx" ON "work_order_lines"("orgId", "employeeId");

-- CreateIndex
CREATE INDEX "work_order_parts_orgId_workOrderId_idx" ON "work_order_parts"("orgId", "workOrderId");

-- CreateIndex
CREATE INDEX "stock_items_orgId_warehouseId_idx" ON "stock_items"("orgId", "warehouseId");

-- CreateIndex
CREATE UNIQUE INDEX "stock_items_orgId_goodId_warehouseId_key" ON "stock_items"("orgId", "goodId", "warehouseId");

-- CreateIndex
CREATE INDEX "stock_movements_orgId_goodId_warehouseId_idx" ON "stock_movements"("orgId", "goodId", "warehouseId");

-- CreateIndex
CREATE INDEX "stock_movements_orgId_documentType_documentId_idx" ON "stock_movements"("orgId", "documentType", "documentId");

-- CreateIndex
CREATE INDEX "purchase_orders_orgId_status_deletedAt_idx" ON "purchase_orders"("orgId", "status", "deletedAt");

-- CreateIndex
CREATE INDEX "purchase_orders_orgId_syncVersion_idx" ON "purchase_orders"("orgId", "syncVersion");

-- CreateIndex
CREATE INDEX "stock_documents_orgId_status_deletedAt_idx" ON "stock_documents"("orgId", "status", "deletedAt");

-- CreateIndex
CREATE INDEX "stock_documents_orgId_type_deletedAt_idx" ON "stock_documents"("orgId", "type", "deletedAt");

-- CreateIndex
CREATE INDEX "stock_documents_orgId_syncVersion_idx" ON "stock_documents"("orgId", "syncVersion");

-- CreateIndex
CREATE INDEX "stock_document_lines_orgId_stockDocumentId_idx" ON "stock_document_lines"("orgId", "stockDocumentId");

-- CreateIndex
CREATE INDEX "document_number_configs_orgId_idx" ON "document_number_configs"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "document_number_configs_orgId_documentType_key" ON "document_number_configs"("orgId", "documentType");

-- CreateIndex
CREATE INDEX "notification_templates_orgId_idx" ON "notification_templates"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "notification_templates_orgId_eventType_channel_key" ON "notification_templates"("orgId", "eventType", "channel");

-- CreateIndex
CREATE INDEX "tax_rates_orgId_idx" ON "tax_rates"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "tax_rates_orgId_rate_key" ON "tax_rates"("orgId", "rate");

-- CreateIndex
CREATE INDEX "payment_method_configs_orgId_idx" ON "payment_method_configs"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_method_configs_orgId_code_key" ON "payment_method_configs"("orgId", "code");

-- CreateIndex
CREATE INDEX "invoices_orgId_status_deletedAt_idx" ON "invoices"("orgId", "status", "deletedAt");

-- CreateIndex
CREATE INDEX "invoices_orgId_syncVersion_idx" ON "invoices"("orgId", "syncVersion");

-- CreateIndex
CREATE INDEX "payments_orgId_workOrderId_idx" ON "payments"("orgId", "workOrderId");

-- CreateIndex
CREATE INDEX "payments_orgId_counterpartyId_idx" ON "payments"("orgId", "counterpartyId");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_accounts_counterpartyId_key" ON "settlement_accounts"("counterpartyId");

-- CreateIndex
CREATE INDEX "settlement_accounts_orgId_idx" ON "settlement_accounts"("orgId");

-- CreateIndex
CREATE INDEX "settlement_transactions_orgId_settlementAccountId_idx" ON "settlement_transactions"("orgId", "settlementAccountId");

-- CreateIndex
CREATE INDEX "settlement_transactions_orgId_documentType_documentId_idx" ON "settlement_transactions"("orgId", "documentType", "documentId");

-- CreateIndex
CREATE INDEX "reconciliation_acts_orgId_counterpartyId_idx" ON "reconciliation_acts"("orgId", "counterpartyId");

-- CreateIndex
CREATE INDEX "calendar_slots_orgId_liftId_startAt_endAt_idx" ON "calendar_slots"("orgId", "liftId", "startAt", "endAt");

-- CreateIndex
CREATE INDEX "calendar_slots_orgId_employeeId_startAt_idx" ON "calendar_slots"("orgId", "employeeId", "startAt");

-- CreateIndex
CREATE INDEX "calendar_slots_orgId_syncVersion_idx" ON "calendar_slots"("orgId", "syncVersion");

-- AddForeignKey
ALTER TABLE "garage_branches" ADD CONSTRAINT "garage_branches_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zones" ADD CONSTRAINT "zones_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "garage_branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lifts" ADD CONSTRAINT "lifts_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "zones"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "garage_branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_zones" ADD CONSTRAINT "employee_zones_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_zones" ADD CONSTRAINT "employee_zones_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "zones"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_lifts" ADD CONSTRAINT "employee_lifts_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_lifts" ADD CONSTRAINT "employee_lifts_liftId_fkey" FOREIGN KEY ("liftId") REFERENCES "lifts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_work_categories" ADD CONSTRAINT "employee_work_categories_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_work_categories" ADD CONSTRAINT "employee_work_categories_workCategoryId_fkey" FOREIGN KEY ("workCategoryId") REFERENCES "work_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "counterparties" ADD CONSTRAINT "counterparties_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_garages" ADD CONSTRAINT "customer_garages_counterpartyId_fkey" FOREIGN KEY ("counterpartyId") REFERENCES "counterparties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_customerGarageId_fkey" FOREIGN KEY ("customerGarageId") REFERENCES "customer_garages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_nodes" ADD CONSTRAINT "vehicle_nodes_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_categories" ADD CONSTRAINT "work_categories_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "work_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "works" ADD CONSTRAINT "works_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "work_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_works" ADD CONSTRAINT "service_works_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_works" ADD CONSTRAINT "service_works_workId_fkey" FOREIGN KEY ("workId") REFERENCES "works"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_goods" ADD CONSTRAINT "service_goods_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_goods" ADD CONSTRAINT "service_goods_goodId_fkey" FOREIGN KEY ("goodId") REFERENCES "goods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "garage_branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_counterpartyId_fkey" FOREIGN KEY ("counterpartyId") REFERENCES "counterparties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_order_lines" ADD CONSTRAINT "work_order_lines_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "work_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_order_lines" ADD CONSTRAINT "work_order_lines_workId_fkey" FOREIGN KEY ("workId") REFERENCES "works"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_order_lines" ADD CONSTRAINT "work_order_lines_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_order_lines" ADD CONSTRAINT "work_order_lines_liftId_fkey" FOREIGN KEY ("liftId") REFERENCES "lifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_order_line_employees" ADD CONSTRAINT "work_order_line_employees_workOrderLineId_fkey" FOREIGN KEY ("workOrderLineId") REFERENCES "work_order_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_order_line_employees" ADD CONSTRAINT "work_order_line_employees_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_order_parts" ADD CONSTRAINT "work_order_parts_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "work_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_order_parts" ADD CONSTRAINT "work_order_parts_goodId_fkey" FOREIGN KEY ("goodId") REFERENCES "goods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_order_parts" ADD CONSTRAINT "work_order_parts_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_goodId_fkey" FOREIGN KEY ("goodId") REFERENCES "goods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_goodId_fkey" FOREIGN KEY ("goodId") REFERENCES "goods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "counterparties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_goodId_fkey" FOREIGN KEY ("goodId") REFERENCES "goods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_documents" ADD CONSTRAINT "stock_documents_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "garage_branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_documents" ADD CONSTRAINT "stock_documents_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_documents" ADD CONSTRAINT "stock_documents_targetWarehouseId_fkey" FOREIGN KEY ("targetWarehouseId") REFERENCES "warehouses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_document_lines" ADD CONSTRAINT "stock_document_lines_stockDocumentId_fkey" FOREIGN KEY ("stockDocumentId") REFERENCES "stock_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_document_lines" ADD CONSTRAINT "stock_document_lines_goodId_fkey" FOREIGN KEY ("goodId") REFERENCES "goods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_number_configs" ADD CONSTRAINT "document_number_configs_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organisation_settings" ADD CONSTRAINT "organisation_settings_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_settings" ADD CONSTRAINT "branch_settings_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "garage_branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_templates" ADD CONSTRAINT "notification_templates_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_rates" ADD CONSTRAINT "tax_rates_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_method_configs" ADD CONSTRAINT "payment_method_configs_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_counterpartyId_fkey" FOREIGN KEY ("counterpartyId") REFERENCES "counterparties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "work_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_counterpartyId_fkey" FOREIGN KEY ("counterpartyId") REFERENCES "counterparties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "work_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_accounts" ADD CONSTRAINT "settlement_accounts_counterpartyId_fkey" FOREIGN KEY ("counterpartyId") REFERENCES "counterparties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_transactions" ADD CONSTRAINT "settlement_transactions_settlementAccountId_fkey" FOREIGN KEY ("settlementAccountId") REFERENCES "settlement_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_acts" ADD CONSTRAINT "reconciliation_acts_counterpartyId_fkey" FOREIGN KEY ("counterpartyId") REFERENCES "counterparties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_slots" ADD CONSTRAINT "calendar_slots_liftId_fkey" FOREIGN KEY ("liftId") REFERENCES "lifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_slots" ADD CONSTRAINT "calendar_slots_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "work_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
