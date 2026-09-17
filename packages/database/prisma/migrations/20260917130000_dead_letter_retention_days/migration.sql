-- DLQ retention (аудит Дані/Інфра, DLQ v1.1). Скільки днів зберігати РОЗВ'ЯЗАНІ DeadLetterJob-записи;
-- нерозв'язані (money/legal) не авто-видаляються. Additive, idempotent → zero-risk, без backfill.

ALTER TABLE "organisation_settings"
  ADD COLUMN IF NOT EXISTS "deadLetterRetentionDays" INTEGER NOT NULL DEFAULT 180;
