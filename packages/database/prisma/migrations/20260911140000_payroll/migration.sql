-- Payroll (зарплата): PayrollPeriodStatus enum + payroll_periods + payroll_lines.
-- Additive-only (1 enum + 2 CREATE TABLE + indexes + FK, 0 DROP).

-- CreateEnum
CREATE TYPE "PayrollPeriodStatus" AS ENUM ('DRAFT', 'COMPUTED', 'PAID', 'CANCELLED');

-- CreateTable
CREATE TABLE "payroll_periods" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "branchId" UUID,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "status" "PayrollPeriodStatus" NOT NULL DEFAULT 'DRAFT',
    "note" TEXT,
    "computedAt" TIMESTAMP(3),
    "computedBy" UUID,
    "paidAt" TIMESTAMP(3),
    "paidBy" UUID,
    "syncVersion" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "payroll_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_lines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "periodId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "rateSchemeType" TEXT NOT NULL,
    "baseAmount" DECIMAL(12,2) NOT NULL,
    "normoHours" DOUBLE PRECISION NOT NULL,
    "linesCount" INTEGER NOT NULL,
    "accruedAmount" DECIMAL(12,2) NOT NULL,
    "paidAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "syncVersion" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payroll_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payroll_periods_orgId_deletedAt_idx" ON "payroll_periods"("orgId", "deletedAt");

-- CreateIndex
CREATE INDEX "payroll_periods_orgId_status_idx" ON "payroll_periods"("orgId", "status");

-- CreateIndex
CREATE INDEX "payroll_periods_orgId_syncVersion_idx" ON "payroll_periods"("orgId", "syncVersion");

-- CreateIndex
CREATE INDEX "payroll_lines_orgId_employeeId_idx" ON "payroll_lines"("orgId", "employeeId");

-- CreateIndex
CREATE INDEX "payroll_lines_orgId_syncVersion_idx" ON "payroll_lines"("orgId", "syncVersion");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_lines_periodId_employeeId_key" ON "payroll_lines"("periodId", "employeeId");

-- AddForeignKey
ALTER TABLE "payroll_periods" ADD CONSTRAINT "payroll_periods_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "payroll_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

