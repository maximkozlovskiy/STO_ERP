-- ПРРО Крок 2: касова зміна (CashShift) + режим зміни (BranchSettings.shiftMode). Additive/idempotent.

-- Enums (guards).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CashShiftStatus') THEN
    CREATE TYPE "CashShiftStatus" AS ENUM ('OPEN', 'CLOSED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ShiftMode') THEN
    CREATE TYPE "ShiftMode" AS ENUM ('MANUAL', 'AUTO_OPEN');
  END IF;
END $$;

-- BranchSettings.shiftMode.
ALTER TABLE "branch_settings"
  ADD COLUMN IF NOT EXISTS "shiftMode" "ShiftMode" NOT NULL DEFAULT 'MANUAL';

-- CashShift.
CREATE TABLE IF NOT EXISTS "cash_shifts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "cashRegisterId" UUID NOT NULL,
    "checkboxShiftId" TEXT,
    "status" "CashShiftStatus" NOT NULL DEFAULT 'OPEN',
    "openedById" UUID,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "zReportId" TEXT,
    "checkboxAccessToken" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "syncVersion" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    CONSTRAINT "cash_shifts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "cash_shifts_orgId_branchId_status_idx"
  ON "cash_shifts" ("orgId", "branchId", "status");
CREATE INDEX IF NOT EXISTS "cash_shifts_orgId_cashRegisterId_status_idx"
  ON "cash_shifts" ("orgId", "cashRegisterId", "status");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'cash_shifts_cashRegisterId_fkey'
  ) THEN
    ALTER TABLE "cash_shifts"
      ADD CONSTRAINT "cash_shifts_cashRegisterId_fkey"
      FOREIGN KEY ("cashRegisterId") REFERENCES "cash_registers"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
