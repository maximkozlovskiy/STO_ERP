-- Performance indexes for hot-path queries
-- WorkOrderLine: list lines by workOrder without orgId fan-out (e.g. WO detail nested fetches)
CREATE INDEX IF NOT EXISTS "work_order_lines_workOrderId_deletedAt_idx"
  ON "work_order_lines"("workOrderId", "deletedAt");

-- BatchConsumption: chronological FIFO/LIFO traversal per-batch within tenant
CREATE INDEX IF NOT EXISTS "batch_consumptions_orgId_batchId_createdAt_idx"
  ON "batch_consumptions"("orgId", "batchId", "createdAt");
