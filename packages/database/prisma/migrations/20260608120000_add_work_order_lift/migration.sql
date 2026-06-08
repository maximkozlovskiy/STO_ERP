-- AlterTable
ALTER TABLE "work_orders" ADD COLUMN "liftId" UUID;

-- AddForeignKey
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_liftId_fkey" FOREIGN KEY ("liftId") REFERENCES "lifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex: FK index for liftId — supports "work orders by lift" queries
-- (dashboards, utilization reports). Without it, lookup by lift falls back to
-- the orgId-leading covering index + filter scan.
CREATE INDEX "work_orders_orgId_liftId_idx" ON "work_orders"("orgId", "liftId");
