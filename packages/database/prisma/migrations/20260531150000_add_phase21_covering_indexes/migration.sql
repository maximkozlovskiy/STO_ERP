-- Covering indexes for Phase 21+22 list endpoints — eliminate Sort node on
-- ORDER BY createdAt DESC by extending existing (orgId, ...) indexes with createdAt.

-- Warranty.findByCounterparty / .findByWorkOrder sort by createdAt DESC, take 50-100.
-- Existing (orgId, counterpartyId, deletedAt) — covered WHERE but missed sort.
DROP INDEX IF EXISTS "warranties_orgId_counterpartyId_deletedAt_idx";
CREATE INDEX IF NOT EXISTS "warranties_orgId_counterpartyId_deletedAt_createdAt_idx"
  ON "warranties" ("orgId", "counterpartyId", "deletedAt", "createdAt");

-- WebhookEndpoint.findAll sorts by createdAt DESC, take 100. Existing
-- (orgId, deletedAt) — covered WHERE but Sort node поверх Index Scan.
DROP INDEX IF EXISTS "webhook_endpoints_orgId_deletedAt_idx";
CREATE INDEX IF NOT EXISTS "webhook_endpoints_orgId_deletedAt_createdAt_idx"
  ON "webhook_endpoints" ("orgId", "deletedAt", "createdAt");

-- BookingRequest.findAll sorts by createdAt DESC + filter deletedAt=null.
-- Existing (orgId, createdAt) covered unfiltered scan; додаємо deletedAt-aware.
CREATE INDEX IF NOT EXISTS "booking_requests_orgId_deletedAt_createdAt_idx"
  ON "booking_requests" ("orgId", "deletedAt", "createdAt");
