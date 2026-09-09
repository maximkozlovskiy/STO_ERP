-- T14 (pre-prod аудит): DB-рівнева унікальність номера документа серед АКТИВНИХ рядків.
-- Номери видаються через DocumentNumberConfig (SELECT ... FOR UPDATE) — race-safe в межах однієї БД,
-- але без DB-гарантії дублі можливі поза happy-path: offline-first push, restore з розсинхроном
-- currentSeq, ручний reset resetPeriod. Дубль номера = юридична/фіскальна проблема для UA-звітності.
--
-- Partial unique WHERE deletedAt IS NULL — щоб soft-deleted документ (той самий номер) не блокував
-- новий. Prisma не виражає partial-unique у @@unique → ручний індекс (як warehouses_orgId_isMain_unique,
-- cash_shifts_one_open_per_register_uq). Idempotent (IF NOT EXISTS). Перевірено: 0 дублів активних
-- номерів на існуючих даних, тож застосується без конфлікту.

CREATE UNIQUE INDEX IF NOT EXISTS "work_orders_orgId_number_active_uq"
  ON "work_orders" ("orgId", "number") WHERE "deletedAt" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "invoices_orgId_number_active_uq"
  ON "invoices" ("orgId", "number") WHERE "deletedAt" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "purchase_orders_orgId_number_active_uq"
  ON "purchase_orders" ("orgId", "number") WHERE "deletedAt" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "stock_documents_orgId_number_active_uq"
  ON "stock_documents" ("orgId", "number") WHERE "deletedAt" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "supplier_returns_orgId_number_active_uq"
  ON "supplier_returns" ("orgId", "number") WHERE "deletedAt" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "supplier_payments_orgId_number_active_uq"
  ON "supplier_payments" ("orgId", "number") WHERE "deletedAt" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "counterparty_contracts_orgId_number_active_uq"
  ON "counterparty_contracts" ("orgId", "number") WHERE "deletedAt" IS NULL;
