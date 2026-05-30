-- GIN trigram indexes for full-text search
-- Requires pg_trgm extension (installed in init migration)

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Counterparties: search by name/phone
CREATE INDEX IF NOT EXISTS counterparties_firstName_trgm_idx    ON counterparties USING gin ("firstName" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS counterparties_lastName_trgm_idx     ON counterparties USING gin ("lastName" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS counterparties_companyName_trgm_idx  ON counterparties USING gin ("companyName" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS counterparties_phone_trgm_idx        ON counterparties USING gin (phone gin_trgm_ops);

-- Goods: search by name/sku
CREATE INDEX IF NOT EXISTS goods_name_trgm_idx  ON goods USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS goods_sku_trgm_idx   ON goods USING gin (sku gin_trgm_ops);

-- Covering indexes for list + sort queries
CREATE INDEX IF NOT EXISTS "counterparties_orgId_deletedAt_idx"          ON counterparties ("orgId", "deletedAt");
CREATE INDEX IF NOT EXISTS "calendar_slots_orgId_startAt_deletedAt_idx"  ON calendar_slots ("orgId", "startAt", "deletedAt");
CREATE INDEX IF NOT EXISTS "goods_orgId_goodType_deletedAt_idx"           ON goods ("orgId", "goodType", "deletedAt");
