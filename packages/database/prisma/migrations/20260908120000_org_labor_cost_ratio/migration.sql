-- Configuration-over-hardcode: частка ФОП механіків (laborCostRatio) per-org для звіту
-- рентабельності (раніше хардкод 0.4 у reports.service). Additive/idempotent.
ALTER TABLE "organisation_settings"
  ADD COLUMN IF NOT EXISTS "laborCostRatio" DECIMAL(4,3) NOT NULL DEFAULT 0.4;
