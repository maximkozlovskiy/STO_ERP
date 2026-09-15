-- Covering-індекси для list-page: (orgId, <status|type>, deletedAt) → +createdAt хвостом.
-- Причина: list-сторінки фільтрують по status/type і сортують createdAt DESC. Наявний
-- (orgId,status,deletedAt) обслуговує фільтр, але createdAt поза індексом → Postgres додає
-- Sort node над усією status/type-групою (велика для COMPLETED/PAID/RECEIPT). Додавши createdAt
-- хвостом, індекс покриває і фільтр, і сортування — Sort node зникає. Старий коротший індекс
-- стає префіксом нового → прибираємо (щоб не тримати дубль).
--
-- ⚠️ ПРОД: на великих таблицях CREATE INDEX бере ACCESS SHARE-lock і будує синхронно. Для zero-
-- downtime краще CREATE INDEX CONCURRENTLY (поза транзакцією) — але Prisma migrate виконує міграцію
-- у транзакції, тож тут plain CREATE. На проді з великими work_orders/invoices — застосувати ці
-- індекси окремим maintenance-вікном або вручну CONCURRENTLY, тоді `migrate resolve --applied`.

-- WorkOrder
DROP INDEX IF EXISTS "work_orders_orgId_status_deletedAt_idx";
CREATE INDEX IF NOT EXISTS "work_orders_orgId_status_deletedAt_createdAt_idx"
  ON "work_orders" ("orgId", "status", "deletedAt", "createdAt");

-- Invoice
DROP INDEX IF EXISTS "invoices_orgId_status_deletedAt_idx";
CREATE INDEX IF NOT EXISTS "invoices_orgId_status_deletedAt_createdAt_idx"
  ON "invoices" ("orgId", "status", "deletedAt", "createdAt");

-- PurchaseOrder
DROP INDEX IF EXISTS "purchase_orders_orgId_status_deletedAt_idx";
CREATE INDEX IF NOT EXISTS "purchase_orders_orgId_status_deletedAt_createdAt_idx"
  ON "purchase_orders" ("orgId", "status", "deletedAt", "createdAt");

-- StockDocument (status + type)
DROP INDEX IF EXISTS "stock_documents_orgId_status_deletedAt_idx";
CREATE INDEX IF NOT EXISTS "stock_documents_orgId_status_deletedAt_createdAt_idx"
  ON "stock_documents" ("orgId", "status", "deletedAt", "createdAt");
DROP INDEX IF EXISTS "stock_documents_orgId_type_deletedAt_idx";
CREATE INDEX IF NOT EXISTS "stock_documents_orgId_type_deletedAt_createdAt_idx"
  ON "stock_documents" ("orgId", "type", "deletedAt", "createdAt");

-- SupplierReturn
DROP INDEX IF EXISTS "supplier_returns_orgId_status_deletedAt_idx";
CREATE INDEX IF NOT EXISTS "supplier_returns_orgId_status_deletedAt_createdAt_idx"
  ON "supplier_returns" ("orgId", "status", "deletedAt", "createdAt");

-- SupplierPayment (unfiltered list default sort)
DROP INDEX IF EXISTS "supplier_payments_orgId_deletedAt_idx";
CREATE INDEX IF NOT EXISTS "supplier_payments_orgId_deletedAt_createdAt_idx"
  ON "supplier_payments" ("orgId", "deletedAt", "createdAt");

-- Good — фільтр каталогу по goodCategoryId раніше без жодного індексу (seq/heap-filter)
CREATE INDEX IF NOT EXISTS "goods_orgId_goodCategoryId_deletedAt_idx"
  ON "goods" ("orgId", "goodCategoryId", "deletedAt");
