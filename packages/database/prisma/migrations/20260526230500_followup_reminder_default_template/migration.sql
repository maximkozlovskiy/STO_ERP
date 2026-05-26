-- Insert default FOLLOWUP_REMINDER SMS template for every organisation that
-- does not yet have one. Idempotent: WHERE NOT EXISTS guards against re-runs.
INSERT INTO "notification_templates" ("id", "orgId", "eventType", "channel", "body", "isActive", "updatedAt")
SELECT
  gen_random_uuid(),
  o."id",
  'FOLLOWUP_REMINDER'::"NotificationEventType",
  'SMS'::"NotificationChannel",
  'Вітаємо, {{clientName}}! Запрошуємо на планове ТО для {{vehicleMake}} {{vehicleModel}} ({{licensePlate}}){{nextMaintenanceDate}}. Зателефонуйте нам для запису.',
  true,
  NOW()
FROM "organisations" o
WHERE o."deletedAt" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "notification_templates" t
    WHERE t."orgId" = o."id"
      AND t."eventType" = 'FOLLOWUP_REMINDER'::"NotificationEventType"
      AND t."channel" = 'SMS'::"NotificationChannel"
  );

-- Defensive recreation of pg_trgm GIN indexes that Prisma migrate dev may
-- silently drop when generating subsequent migrations (drift between
-- schema.prisma and raw-SQL indexes from migration 20260526061209).
CREATE INDEX IF NOT EXISTS "idx_work_orders_number_trgm"
  ON work_orders USING gin ("number" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "idx_counterparties_firstname_trgm"
  ON counterparties USING gin ("firstName" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "idx_counterparties_lastname_trgm"
  ON counterparties USING gin ("lastName" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "idx_counterparties_phone_trgm"
  ON counterparties USING gin (phone gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "idx_goods_name_trgm"
  ON goods USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "idx_goods_sku_trgm"
  ON goods USING gin (sku gin_trgm_ops);
