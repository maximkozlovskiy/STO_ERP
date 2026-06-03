-- CreateIndex
CREATE INDEX "invoices_orgId_documentDate_deletedAt_idx" ON "invoices"("orgId", "documentDate", "deletedAt");

-- CreateIndex
CREATE INDEX "purchase_orders_orgId_documentDate_deletedAt_idx" ON "purchase_orders"("orgId", "documentDate", "deletedAt");

-- CreateIndex
CREATE INDEX "stock_documents_orgId_documentDate_deletedAt_idx" ON "stock_documents"("orgId", "documentDate", "deletedAt");

-- CreateIndex
CREATE INDEX "work_orders_orgId_documentDate_deletedAt_idx" ON "work_orders"("orgId", "documentDate", "deletedAt");
