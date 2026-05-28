-- Performance indexes for high-traffic queries
-- Applied via db push; recorded here for migration history

-- WorkOrder: combined status+branchId filter (common list view with branch filter)
CREATE INDEX IF NOT EXISTS "work_orders_orgId_status_branchId_deletedAt_idx"
  ON "work_orders" ("orgId", "status", "branchId", "deletedAt");

-- WorkOrder: completedAt filter for reports (revenue, profitability by date range)
CREATE INDEX IF NOT EXISTS "work_orders_orgId_completedAt_deletedAt_idx"
  ON "work_orders" ("orgId", "completedAt", "deletedAt");

-- StockItem: warehouseId + deletedAt for inventory page with active-only filter
CREATE INDEX IF NOT EXISTS "stock_items_orgId_warehouseId_deletedAt_idx"
  ON "stock_items" ("orgId", "warehouseId", "deletedAt");

-- StockMovement: warehouseId + createdAt for stock movement reports by date range
CREATE INDEX IF NOT EXISTS "stock_movements_orgId_warehouseId_createdAt_idx"
  ON "stock_movements" ("orgId", "warehouseId", "createdAt");

-- StockBatch: warehouseId + isActive + createdAt for FIFO batch lookup across goods in a warehouse
CREATE INDEX IF NOT EXISTS "stock_batches_orgId_warehouseId_isActive_createdAt_idx"
  ON "stock_batches" ("orgId", "warehouseId", "isActive", "createdAt");
