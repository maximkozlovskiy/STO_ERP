-- Schema drift backfill. These objects exist in schema.prisma and in long-lived dev databases
-- (they got there via `prisma db push`), but no migration ever created them. On a FRESH database
-- `migrate deploy` therefore produced a schema the application cannot run on: the seed failed with
-- P2022 on organisation_settings, i.e. a clean installation was broken. Found by CI on 2026-10-08.
-- Everything is idempotent: a no-op where the objects already exist.

ALTER TABLE "organisation_settings"
  ADD COLUMN IF NOT EXISTS "recalcPlannedHoursFromLines" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "calendar_slots" ADD COLUMN IF NOT EXISTS "parentSlotId" UUID;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'calendar_slots_parentSlotId_fkey') THEN
    ALTER TABLE "calendar_slots"
      ADD CONSTRAINT "calendar_slots_parentSlotId_fkey"
      FOREIGN KEY ("parentSlotId") REFERENCES "calendar_slots"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

ALTER TABLE "supplier_payments" ALTER COLUMN "documentDate" SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "supplier_returns" ALTER COLUMN "documentDate" SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "brand_synonyms" ALTER COLUMN "updatedAt" DROP DEFAULT;

CREATE INDEX IF NOT EXISTS "calendar_slots_orgId_workOrderId_deletedAt_startAt_idx"
  ON "calendar_slots"("orgId", "workOrderId", "deletedAt", "startAt");
CREATE INDEX IF NOT EXISTS "invoices_orgId_workOrderId_deletedAt_createdAt_idx"
  ON "invoices"("orgId", "workOrderId", "deletedAt", "createdAt");
CREATE INDEX IF NOT EXISTS "reconciliation_acts_orgId_counterpartyId_createdAt_idx"
  ON "reconciliation_acts"("orgId", "counterpartyId", "createdAt");
CREATE INDEX IF NOT EXISTS "stock_batches_orgId_createdAt_idx"
  ON "stock_batches"("orgId", "createdAt");
CREATE INDEX IF NOT EXISTS "stock_movements_orgId_goodId_createdAt_idx"
  ON "stock_movements"("orgId", "goodId", "createdAt");
CREATE INDEX IF NOT EXISTS "stock_movements_orgId_createdAt_idx"
  ON "stock_movements"("orgId", "createdAt");
CREATE INDEX IF NOT EXISTS "warranties_orgId_workOrderId_deletedAt_createdAt_idx"
  ON "warranties"("orgId", "workOrderId", "deletedAt", "createdAt");
