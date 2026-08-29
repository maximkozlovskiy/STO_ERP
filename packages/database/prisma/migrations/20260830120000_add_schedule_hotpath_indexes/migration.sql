-- sto-optimize: compound B-tree indexes for hot-path getSchedule query
-- (SupplierPaymentsService.getSchedule — SupplierPaymentScheduleTab polls with staleTime=30s).
--
-- 1) counterparty_contracts: без цього індексу getSchedule робить heap-scan усіх
--    контрактів org-а (WHERE orgId, contractType='PURCHASE', creditLimit IS NOT NULL,
--    deletedAt IS NULL). Існуючий (orgId, counterpartyId, deletedAt) не покриває
--    бо counterpartyId у WHERE не використовується. Порядок: equality першими
--    (orgId, contractType), deletedAt останнім (низька cardinality — 2 значення).
CREATE INDEX IF NOT EXISTS "counterparty_contracts_orgId_contractType_deletedAt_idx"
  ON "counterparty_contracts" ("orgId", "contractType", "deletedAt");

-- 2) supplier_payments: покриває три queries:
--    (a) findAll(purchaseOrderId=?)     — «Оплати цього PO» у деталі PO
--    (b) getSchedule.groupBy purchaseOrderId=null — загальні оплати
--    (c) Prisma nested include supplierPayments (WHERE purchaseOrderId IN (…))
--    Existing (orgId, supplierId, createdAt) не покриває — потрібен ключ по FK PO.
CREATE INDEX IF NOT EXISTS "supplier_payments_orgId_purchaseOrderId_deletedAt_idx"
  ON "supplier_payments" ("orgId", "purchaseOrderId", "deletedAt");
