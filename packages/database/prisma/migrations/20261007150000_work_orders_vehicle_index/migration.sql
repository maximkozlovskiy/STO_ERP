-- Work orders of one vehicle: GET /vehicles/:id/mileage (BR-VEH-001) and the vehicleId
-- filter of the work-order list. Before this the planner used orgId-prefixed indexes and
-- filtered vehicleId row by row.
CREATE INDEX IF NOT EXISTS "work_orders_orgId_vehicleId_deletedAt_idx"
  ON "work_orders"("orgId", "vehicleId", "deletedAt");
