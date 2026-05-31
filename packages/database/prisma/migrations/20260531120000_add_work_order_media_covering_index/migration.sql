-- Covering index for WorkOrderMedia.findAll
-- findAll sorts by createdAt DESC with take:50 — previously the (orgId, workOrderId) index
-- covered the WHERE clause but required a Sort node atop the Index Scan.
-- The new (orgId, workOrderId, createdAt) index lets Postgres return rows in index order,
-- eliminating the Sort node.

DROP INDEX IF EXISTS "work_order_media_orgId_workOrderId_idx";
CREATE INDEX IF NOT EXISTS "work_order_media_orgId_workOrderId_createdAt_idx"
  ON "work_order_media"("orgId", "workOrderId", "createdAt");
