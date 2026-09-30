-- Розшифровка нарахувань PayrollLine по нарядах (snapshot на момент COMPUTED).
-- Ручно-складена міграція (лише зміни цієї фічі) — schema-vs-DB diff у цьому репо містить сторонній
-- drift (trgm GIN-індекси, FK-перестворення) який НЕ можна включати. Див. docs sto-database.

-- CreateTable
CREATE TABLE "payroll_line_work_orders" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "payrollLineId" UUID NOT NULL,
    "workOrderId" UUID NOT NULL,
    "workOrderNumber" TEXT NOT NULL,
    "vehicleName" TEXT,
    "worksCount" INTEGER NOT NULL,
    "normoHours" DOUBLE PRECISION NOT NULL,
    "baseAmount" DECIMAL(12,2) NOT NULL,
    "syncVersion" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payroll_line_work_orders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payroll_line_work_orders_orgId_payrollLineId_idx" ON "payroll_line_work_orders"("orgId", "payrollLineId");

-- CreateIndex
CREATE INDEX "payroll_line_work_orders_orgId_syncVersion_idx" ON "payroll_line_work_orders"("orgId", "syncVersion");

-- AddForeignKey
ALTER TABLE "payroll_line_work_orders" ADD CONSTRAINT "payroll_line_work_orders_payrollLineId_fkey" FOREIGN KEY ("payrollLineId") REFERENCES "payroll_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
