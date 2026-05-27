-- CreateTable: warranties (B3)
-- IF NOT EXISTS makes this idempotent for environments that previously
-- received the schema via `prisma db push` (dev) before the migration existed.
CREATE TABLE IF NOT EXISTS "warranties" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "workOrderId" UUID NOT NULL,
    "workOrderLineId" UUID,
    "workOrderPartId" UUID,
    "counterpartyId" UUID NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "claimedAt" TIMESTAMP(3),
    "claimWoId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "syncVersion" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "warranties_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "warranties_orgId_deletedAt_idx" ON "warranties"("orgId", "deletedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "warranties_orgId_syncVersion_idx" ON "warranties"("orgId", "syncVersion");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "warranties_orgId_counterpartyId_deletedAt_idx" ON "warranties"("orgId", "counterpartyId", "deletedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "warranties_orgId_expiresAt_deletedAt_idx" ON "warranties"("orgId", "expiresAt", "deletedAt");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "warranties" ADD CONSTRAINT "warranties_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "warranties" ADD CONSTRAINT "warranties_workOrderId_fkey"
    FOREIGN KEY ("workOrderId") REFERENCES "work_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "warranties" ADD CONSTRAINT "warranties_counterpartyId_fkey"
    FOREIGN KEY ("counterpartyId") REFERENCES "counterparties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "warranties" ADD CONSTRAINT "warranties_claimWoId_fkey"
    FOREIGN KEY ("claimWoId") REFERENCES "work_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Defensive recreation of pg_trgm GIN indexes that Prisma migrate dev may
-- silently drop when generating subsequent migrations (drift between
-- schema.prisma and raw-SQL indexes from migration 20260526061209_b6_trgm_gin_indexes).
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
