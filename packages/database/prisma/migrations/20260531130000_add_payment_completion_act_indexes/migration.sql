-- Covering indexes for hot list endpoints sorted by createdAt DESC.
-- payments.findAll(orgId, counterpartyId?) ORDER BY createdAt DESC LIMIT 20
-- → existing (orgId, counterpartyId) needs Sort node after Index Scan.
-- → new (orgId, counterpartyId, createdAt) lets Postgres return rows in index order.
-- Also adds (orgId, createdAt) for the unfiltered list page.
DROP INDEX IF EXISTS "payments_orgId_counterpartyId_idx";
CREATE INDEX IF NOT EXISTS "payments_orgId_counterpartyId_createdAt_idx"
  ON "payments" ("orgId", "counterpartyId", "createdAt");
CREATE INDEX IF NOT EXISTS "payments_orgId_createdAt_idx"
  ON "payments" ("orgId", "createdAt");

-- completion_acts.findAll(orgId, workOrderId?) ORDER BY createdAt DESC LIMIT 100
-- → existing (orgId, workOrderId, deletedAt) lacks createdAt for Sort elimination.
-- → new (orgId, workOrderId, deletedAt, createdAt) covers list query end-to-end.
DROP INDEX IF EXISTS "completion_acts_orgId_workOrderId_deletedAt_idx";
CREATE INDEX IF NOT EXISTS "completion_acts_orgId_workOrderId_deletedAt_createdAt_idx"
  ON "completion_acts" ("orgId", "workOrderId", "deletedAt", "createdAt");
