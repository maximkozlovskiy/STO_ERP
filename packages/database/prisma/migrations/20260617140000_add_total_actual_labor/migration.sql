ALTER TABLE "work_orders" ADD COLUMN "totalActualLabor" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- Backfill: recalc totalActualLabor and totalAmount for all existing work orders
UPDATE "work_orders" wo
SET
  "totalActualLabor" = COALESCE((
    SELECT SUM(
      COALESCE(wol."actualHours", wol."normoHours", 0) * COALESCE(wol."price", 0)
    )
    FROM "work_order_lines" wol
    WHERE wol."workOrderId" = wo.id
      AND wol."orgId" = wo."orgId"
      AND wol."deletedAt" IS NULL
  ), 0),
  "totalAmount" = COALESCE((
    SELECT SUM(
      COALESCE(wol."actualHours", wol."normoHours", 0) * COALESCE(wol."price", 0)
    )
    FROM "work_order_lines" wol
    WHERE wol."workOrderId" = wo.id
      AND wol."orgId" = wo."orgId"
      AND wol."deletedAt" IS NULL
  ), 0) + wo."totalParts";
