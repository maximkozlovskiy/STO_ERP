-- CreateTable
CREATE TABLE "booking_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "clientName" TEXT NOT NULL,
    "clientPhone" TEXT NOT NULL,
    "serviceIds" TEXT[],
    "requestedDate" TIMESTAMP(3) NOT NULL,
    "confirmedSlotId" UUID,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "booking_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "booking_requests_orgId_status_deletedAt_idx" ON "booking_requests"("orgId", "status", "deletedAt");

-- CreateIndex
CREATE INDEX "booking_requests_orgId_createdAt_idx" ON "booking_requests"("orgId", "createdAt");

-- AddForeignKey
ALTER TABLE "booking_requests" ADD CONSTRAINT "booking_requests_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_requests" ADD CONSTRAINT "booking_requests_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "garage_branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

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
