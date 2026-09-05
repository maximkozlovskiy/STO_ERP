-- Phase D («пов'язані документи»): StockDocument і SupplierReturn історично НЕ мали
-- прямого зв'язку з PurchaseOrder-джерелом (лише постачальник/склад). Додаємо nullable
-- FK purchaseOrderId, щоб надати цим документам справжні doc-to-doc зв'язки.
--
-- BACKFILL НЕМОЖЛИВИЙ: джерело-замовлення історично ніде не фіксувалось (PO.receive()
-- пише рухи напряму, не створюючи StockDocument; SupplierReturn create не мав PO-референсу).
-- Тому наявні рядки лишаються NULL — колонка заповнюється лише для нових документів,
-- створених через оновлені create-форми з PO-пікером. ON DELETE SET NULL — м'який FK.
--
-- Additive / nullable / idempotent — безпечно на розгорнутих БД.

ALTER TABLE "stock_documents" ADD COLUMN IF NOT EXISTS "purchaseOrderId" UUID;
ALTER TABLE "supplier_returns" ADD COLUMN IF NOT EXISTS "purchaseOrderId" UUID;

CREATE INDEX IF NOT EXISTS "stock_documents_orgId_purchaseOrderId_deletedAt_createdAt_idx"
  ON "stock_documents" ("orgId", "purchaseOrderId", "deletedAt", "createdAt");
CREATE INDEX IF NOT EXISTS "supplier_returns_orgId_purchaseOrderId_deletedAt_createdAt_idx"
  ON "supplier_returns" ("orgId", "purchaseOrderId", "deletedAt", "createdAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'stock_documents_purchaseOrderId_fkey'
  ) THEN
    ALTER TABLE "stock_documents"
      ADD CONSTRAINT "stock_documents_purchaseOrderId_fkey"
      FOREIGN KEY ("purchaseOrderId") REFERENCES "purchase_orders"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'supplier_returns_purchaseOrderId_fkey'
  ) THEN
    ALTER TABLE "supplier_returns"
      ADD CONSTRAINT "supplier_returns_purchaseOrderId_fkey"
      FOREIGN KEY ("purchaseOrderId") REFERENCES "purchase_orders"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
