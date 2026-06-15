-- AlterEnum: DocumentType + SUPPLIER_RETURN
ALTER TYPE "DocumentType" ADD VALUE 'SUPPLIER_RETURN';

-- AlterEnum: MovementDocumentType + SUPPLIER_RETURN
ALTER TYPE "MovementDocumentType" ADD VALUE 'SUPPLIER_RETURN';

-- CreateEnum: SupplierReturnStatus
CREATE TYPE "SupplierReturnStatus" AS ENUM ('DRAFT', 'CONFIRMED', 'CANCELLED');

-- CreateTable: supplier_returns
CREATE TABLE "supplier_returns" (
    "id"           UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId"        UUID NOT NULL,
    "supplierId"   UUID NOT NULL,
    "warehouseId"  UUID NOT NULL,
    "number"       TEXT NOT NULL,
    "status"       "SupplierReturnStatus" NOT NULL DEFAULT 'DRAFT',
    "totalAmount"  DECIMAL(12,2) NOT NULL DEFAULT 0,
    "notes"        TEXT,
    "documentDate" DATE NOT NULL DEFAULT CURRENT_DATE,
    "syncVersion"  BIGINT NOT NULL DEFAULT 0,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,
    "deletedAt"    TIMESTAMP(3),
    CONSTRAINT "supplier_returns_pkey" PRIMARY KEY ("id")
);

-- CreateTable: supplier_return_lines
CREATE TABLE "supplier_return_lines" (
    "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId"            UUID NOT NULL,
    "supplierReturnId" UUID NOT NULL,
    "goodId"           UUID NOT NULL,
    "quantity"         DOUBLE PRECISION NOT NULL,
    "price"            DECIMAL(12,2) NOT NULL,
    "unitOfMeasureId"  UUID,
    "syncVersion"      BIGINT NOT NULL DEFAULT 0,
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3) NOT NULL,
    "deletedAt"        TIMESTAMP(3),
    CONSTRAINT "supplier_return_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "supplier_returns_orgId_status_deletedAt_idx" ON "supplier_returns"("orgId", "status", "deletedAt");
CREATE INDEX "supplier_returns_orgId_syncVersion_idx" ON "supplier_returns"("orgId", "syncVersion");
CREATE INDEX "supplier_returns_orgId_deletedAt_createdAt_idx" ON "supplier_returns"("orgId", "deletedAt", "createdAt");
CREATE INDEX "supplier_returns_orgId_documentDate_deletedAt_idx" ON "supplier_returns"("orgId", "documentDate", "deletedAt");
CREATE INDEX "supplier_return_lines_supplierReturnId_deletedAt_idx" ON "supplier_return_lines"("supplierReturnId", "deletedAt");
CREATE INDEX "supplier_return_lines_orgId_syncVersion_idx" ON "supplier_return_lines"("orgId", "syncVersion");

-- AddForeignKey
ALTER TABLE "supplier_returns" ADD CONSTRAINT "supplier_returns_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "counterparties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "supplier_returns" ADD CONSTRAINT "supplier_returns_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "supplier_return_lines" ADD CONSTRAINT "supplier_return_lines_supplierReturnId_fkey" FOREIGN KEY ("supplierReturnId") REFERENCES "supplier_returns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "supplier_return_lines" ADD CONSTRAINT "supplier_return_lines_goodId_fkey" FOREIGN KEY ("goodId") REFERENCES "goods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "supplier_return_lines" ADD CONSTRAINT "supplier_return_lines_unitOfMeasureId_fkey" FOREIGN KEY ("unitOfMeasureId") REFERENCES "units_of_measure"("id") ON DELETE SET NULL ON UPDATE CASCADE;
