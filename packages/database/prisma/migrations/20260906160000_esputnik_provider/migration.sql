-- Провайдер eSputnik: +канал TELEGRAM, +externalTemplateId (ID готового шаблону для
-- template-based каналів Viber/Telegram через smartsend). Additive/idempotent.

-- Додаємо TELEGRAM у enum (guard проти повторного застосування).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'NotificationChannel' AND e.enumlabel = 'TELEGRAM'
  ) THEN
    ALTER TYPE "NotificationChannel" ADD VALUE 'TELEGRAM';
  END IF;
END $$;

-- externalTemplateId (не секрет; null для inline-каналів).
ALTER TABLE "notification_channel_configs"
  ADD COLUMN IF NOT EXISTS "externalTemplateId" TEXT;
