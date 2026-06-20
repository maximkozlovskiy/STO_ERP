-- Covering index for the public widget hot-path `BookingService.getAvailability()`.
-- WHERE: orgId + branchId + status = 'CONFIRMED' + requestedDate range + deletedAt IS NULL.
-- Existing indexes ((orgId,status,deletedAt) and (orgId,deletedAt,createdAt)) narrow on
-- orgId/status but leave branchId equality and requestedDate range filter as a per-row
-- heap predicate. The new index orders equality columns first (orgId, branchId, status)
-- so Postgres can do a single index-range scan on requestedDate without heap re-filter.
-- This query runs on every public booking widget mount (no auth, throttled but cacheless),
-- so it sits on the critical TTFB path for the customer-facing booking flow.
CREATE INDEX IF NOT EXISTS "booking_requests_orgId_branchId_status_requestedDate_idx"
  ON "booking_requests" ("orgId", "branchId", "status", "requestedDate");
