-- AlterTable
ALTER TABLE "warehouses" ADD COLUMN     "isMain" BOOLEAN NOT NULL DEFAULT false;

-- NOTE: An earlier auto-generated draft of this migration included
-- DROP INDEX statements for the trgm GIN indexes (idx_*_trgm). Those
-- indexes are created by 20260526061209_b6_trgm_gin_indexes as raw SQL
-- *intentionally not tracked* by Prisma schema diff. They power B6
-- fuzzy search. Dropping them silently regresses search performance,
-- so the DROP statements have been removed and the indexes are
-- re-created below (idempotent via IF NOT EXISTS) to recover from any
-- environment where the bad draft was applied.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "idx_work_orders_number_trgm" ON work_orders USING gin ("number" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "idx_counterparties_firstname_trgm" ON counterparties USING gin ("firstName" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "idx_counterparties_lastname_trgm" ON counterparties USING gin ("lastName" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "idx_counterparties_phone_trgm" ON counterparties USING gin (phone gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "idx_goods_name_trgm" ON goods USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "idx_goods_sku_trgm" ON goods USING gin (sku gin_trgm_ops);
