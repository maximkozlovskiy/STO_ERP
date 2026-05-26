-- B6: pg_trgm extension + GIN indexes for similarity search
-- These are raw SQL indexes not tracked by Prisma schema diff (intentional)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "idx_work_orders_number_trgm" ON work_orders USING gin ("number" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "idx_counterparties_firstname_trgm" ON counterparties USING gin ("firstName" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "idx_counterparties_lastname_trgm" ON counterparties USING gin ("lastName" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "idx_counterparties_phone_trgm" ON counterparties USING gin (phone gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "idx_goods_name_trgm" ON goods USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "idx_goods_sku_trgm" ON goods USING gin (sku gin_trgm_ops);
