-- GIN trigram indexes for fast ILIKE text search on high-traffic columns.
-- pg_trgm extension already enabled in B6 migration.
-- These were created in code but never applied to the DB.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_work_orders_number_trgm
  ON work_orders USING gin ("number" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_counterparties_lastname_trgm
  ON counterparties USING gin ("lastName" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_counterparties_firstname_trgm
  ON counterparties USING gin ("firstName" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_counterparties_companyname_trgm
  ON counterparties USING gin ("companyName" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_goods_name_trgm
  ON goods USING gin (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_goods_sku_trgm
  ON goods USING gin (sku gin_trgm_ops);
