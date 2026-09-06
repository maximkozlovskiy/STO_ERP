-- Phase 2 фічі «мульти-канал сповіщень»: per-branch конфіг каналів (провайдер, пріоритет,
-- креди) + журнал доставки (для fallback + спостережуваності). Additive/idempotent.

-- Enum статусів доставки (guard проти повторного застосування).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'NotificationDeliveryStatus') THEN
    CREATE TYPE "NotificationDeliveryStatus" AS ENUM ('QUEUED', 'SENT', 'REJECTED', 'FAILED');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "notification_channel_configs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "provider" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "apiKey" TEXT,
    "senderName" TEXT,
    "syncVersion" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    CONSTRAINT "notification_channel_configs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "notification_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "branchId" UUID,
    "eventType" "NotificationEventType" NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "provider" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "providerMessageId" TEXT,
    "status" "NotificationDeliveryStatus" NOT NULL DEFAULT 'QUEUED',
    "error" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "notification_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "notification_channel_configs_orgId_branchId_enabled_priorit_idx"
  ON "notification_channel_configs" ("orgId", "branchId", "enabled", "priority");
CREATE UNIQUE INDEX IF NOT EXISTS "notification_channel_configs_branchId_channel_key"
  ON "notification_channel_configs" ("branchId", "channel");
CREATE INDEX IF NOT EXISTS "notification_logs_orgId_createdAt_idx"
  ON "notification_logs" ("orgId", "createdAt");
CREATE INDEX IF NOT EXISTS "notification_logs_orgId_eventType_channel_idx"
  ON "notification_logs" ("orgId", "eventType", "channel");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'notification_channel_configs_branchId_fkey'
  ) THEN
    ALTER TABLE "notification_channel_configs"
      ADD CONSTRAINT "notification_channel_configs_branchId_fkey"
      FOREIGN KEY ("branchId") REFERENCES "garage_branches"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
