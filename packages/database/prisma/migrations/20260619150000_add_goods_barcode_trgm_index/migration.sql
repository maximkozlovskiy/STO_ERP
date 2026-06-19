-- sto-optimize 2026-06-19:
-- GoodsService.findAll() search predicate is
--   where.OR = [ name contains, sku contains, barcode contains ]   (all insensitive).
-- name and sku already have GIN trgm indexes (idx_goods_name_trgm, idx_goods_sku_trgm
-- from 20260526060945_b6_search_b10_branch_acl_f8_comments_f10_wo_templates).
-- barcode column does not — Postgres falls back to per-row LIKE evaluation after the
-- (orgId, deletedAt) index narrows the candidate set. Aligning index coverage with the
-- OR clause prevents the search column drift that the recent internalCode feature
-- highlighted (barcode is still the third OR branch and a primary lookup path from
-- the GoodPickerModal barcode scanner).
--
-- Uses pg_trgm; the extension is enabled in earlier B6 migrations
-- (20260526060945_b6_search...). IF NOT EXISTS is idempotent so re-runs are safe.
CREATE INDEX IF NOT EXISTS "idx_goods_barcode_trgm"
  ON goods USING gin (barcode gin_trgm_ops);
