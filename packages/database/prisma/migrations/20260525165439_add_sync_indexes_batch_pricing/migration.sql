-- CreateIndex
CREATE INDEX "pricing_rules_orgId_syncVersion_idx" ON "pricing_rules"("orgId", "syncVersion");

-- CreateIndex
CREATE INDEX "stock_batches_orgId_syncVersion_idx" ON "stock_batches"("orgId", "syncVersion");
