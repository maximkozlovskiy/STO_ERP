-- BR-WORK-006: the works catalog is searched with ILIKE '%q%' (works.service: contains +
-- insensitive), but unlike goods / counterparties / work_orders it never got a trgm index.
-- Raw SQL on purpose: schema.prisma cannot express GIN trgm indexes (see 20260914200000).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "works_name_trgm_idx"
  ON "works" USING gin ("name" gin_trgm_ops);
