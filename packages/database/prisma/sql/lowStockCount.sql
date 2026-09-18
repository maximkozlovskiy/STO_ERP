-- typedSql: кількість позицій із низьким залишком (quantity <= minStock) для однієї org.
-- Prisma не підтримує cross-field порівняння у where → static SQL. Дзеркалить /stock-items/low.
-- Колонки camelCase (schema без @map) → подвійні лапки обов'язкові.
-- @param {String} $1:orgId
SELECT COUNT(*)::bigint AS count
FROM stock_items si
JOIN goods g ON g.id = si."goodId"
JOIN warehouses w ON w.id = si."warehouseId"
WHERE si."orgId" = $1::uuid
  AND si."deletedAt" IS NULL
  AND g."deletedAt" IS NULL
  AND w."deletedAt" IS NULL
  AND si."minStock" IS NOT NULL
  AND si.quantity <= si."minStock"
