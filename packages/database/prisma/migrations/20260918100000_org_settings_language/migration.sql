-- Мова інтерфейсу org-рівня (дефолт для всієї СТО). Дзеркалить brandTheme/currency.
-- Additive NOT NULL + DEFAULT 'uk' → наявні рядки бекфіляться автоматично, zero-risk offline.
ALTER TABLE "organisation_settings" ADD COLUMN IF NOT EXISTS "language" TEXT NOT NULL DEFAULT 'uk';
