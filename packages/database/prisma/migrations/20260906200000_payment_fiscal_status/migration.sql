-- ПРРО Крок 1c: статус фіскалізації на Payment. Additive/idempotent.

-- Enum статусів чеку (guard проти повторного застосування).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'FiscalReceiptStatus') THEN
    CREATE TYPE "FiscalReceiptStatus" AS ENUM ('QUEUED', 'DONE', 'FAILED', 'SKIPPED');
  END IF;
END $$;

ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "fiscalStatus" "FiscalReceiptStatus";
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "fiscalError" TEXT;
