-- BR-PAYR-015: payroll accrual skips a work order whose (work order, employee) pair is already in
-- the breakdown of another computed/paid period. The NOT EXISTS probe looks the snapshot up by
-- work order; before this index the planner had only (orgId, payrollLineId) and re-scanned every
-- snapshot row of the organisation for each work-order line. The snapshot is append-only growth
-- (one row per work order per payroll), so the scan would get slower with every payroll run.
CREATE INDEX IF NOT EXISTS "payroll_line_work_orders_orgId_workOrderId_idx"
  ON "payroll_line_work_orders"("orgId", "workOrderId");
