-- T13 (pre-prod аудит): горизонт прогнозу нагадувань про ТО — з коду (hardcoded 14) у налаштування.
-- Additive, NOT NULL з DEFAULT → backfill існуючих рядків автоматично. Безпечно на існуючих БД.
ALTER TABLE "organisation_settings"
  ADD COLUMN IF NOT EXISTS "maintenanceForecastDays" INTEGER NOT NULL DEFAULT 14;
