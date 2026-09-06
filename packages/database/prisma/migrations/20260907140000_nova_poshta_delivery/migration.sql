-- Інтеграція служби доставки (Нова Пошта): трекінг доставки у PurchaseOrder + інтервал опитування.
-- Additive/idempotent — безпечно на розгорнутих БД.

-- 1. enum DeliveryStatus (guard: не падати якщо вже існує)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'DeliveryStatus') THEN
    CREATE TYPE "DeliveryStatus" AS ENUM ('PENDING', 'IN_TRANSIT', 'ARRIVED', 'DELIVERED', 'RETURNED', 'NOT_FOUND');
  END IF;
END$$;

-- 2. ProviderKind += DELIVERY (PG16: ADD VALUE у DO-block, IF NOT EXISTS)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'ProviderKind' AND e.enumlabel = 'DELIVERY'
  ) THEN
    ALTER TYPE "ProviderKind" ADD VALUE 'DELIVERY';
  END IF;
END$$;

-- 3. PurchaseOrder — поля доставки
ALTER TABLE "purchase_orders" ADD COLUMN IF NOT EXISTS "trackingNumber" TEXT;
ALTER TABLE "purchase_orders" ADD COLUMN IF NOT EXISTS "deliveryStatus" "DeliveryStatus";
ALTER TABLE "purchase_orders" ADD COLUMN IF NOT EXISTS "deliveryStatusRaw" TEXT;
ALTER TABLE "purchase_orders" ADD COLUMN IF NOT EXISTS "deliveryStatusUpdatedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "purchase_orders_orgId_deliveryStatus_deletedAt_idx"
  ON "purchase_orders"("orgId", "deliveryStatus", "deletedAt");

-- 4. OrganisationSettings — інтервал опитування (хв)
ALTER TABLE "organisation_settings"
  ADD COLUMN IF NOT EXISTS "deliveryPollIntervalMinutes" INTEGER NOT NULL DEFAULT 30;
