-- Прибрати 6 надлишкових btree-індексів: кожен — строгий колонковий ПРЕФІКС довшого індексу
-- на тій самій таблиці, тож довший повністю обслуговує префіксні запити (Postgres використовує
-- лівий префікс складеного індексу). Дублі знайдено аналізом pg_index (scale-independent, не за
-- pg_stat — на dev-даних лічильники не показові). Zero query-план impact, менше write-overhead.
DROP INDEX IF EXISTS "good_uom_orgId_goodId_idx";                          -- ⊂ UNIQUE(orgId,goodId,unitOfMeasureId)
DROP INDEX IF EXISTS "stock_items_orgId_warehouseId_idx";                  -- ⊂ (orgId,warehouseId,deletedAt)
DROP INDEX IF EXISTS "stock_batches_orgId_goodId_warehouseId_isActive_idx";-- ⊂ (…isActive,createdAt)
DROP INDEX IF EXISTS "batch_consumptions_orgId_batchId_idx";               -- ⊂ (orgId,batchId,createdAt)
DROP INDEX IF EXISTS "work_good_category_links_orgId_workCategoryId_idx";  -- ⊂ UNIQUE(orgId,workCategoryId,goodCategoryId)
DROP INDEX IF EXISTS "loyalty_accounts_orgId_idx";                         -- ⊂ (orgId,syncVersion)
