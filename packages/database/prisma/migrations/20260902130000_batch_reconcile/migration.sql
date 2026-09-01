-- PROD reconcile (разовий): до підключення партійного списання StockBatch.remainingQty
-- монотонно ріс (consumeBatch не викликався), тож Σ remainingQty(active) ≫ StockItem.quantity.
-- Ця міграція FIFO-доспоживає найстаріші партії на величину надлишку, щоб інваріант
-- Σ remainingQty == StockItem.quantity відновився.
--
-- БЕЗПЕЧНА на вже-чистій dev-БД: якщо надлишку немає (deficit<=0) — no-op.
-- ⚠️ ПРОД: зробити BACKUP БД перед запуском. Історичний COGS завершених нарядів НЕ backfill-иться
-- (batchCostPrice лишається NULL для старих; звіт бере Good.purchasePrice-fallback як і раніше).
-- Ідемпотентна: повторний запуск після досягнення інваріанта нічого не змінює.

DO $$
DECLARE
  rec RECORD;
  deficit DOUBLE PRECISION;
  b RECORD;
  take DOUBLE PRECISION;
BEGIN
  -- Для кожної пари (orgId, goodId, warehouseId) з активними партіями:
  FOR rec IN
    SELECT sb."orgId", sb."goodId", sb."warehouseId",
           COALESCE(SUM(sb."remainingQty"), 0) AS batch_sum,
           COALESCE(si."quantity", 0)          AS stock_qty
    FROM "stock_batches" sb
    LEFT JOIN "stock_items" si
      ON si."orgId" = sb."orgId" AND si."goodId" = sb."goodId"
      AND si."warehouseId" = sb."warehouseId" AND si."deletedAt" IS NULL
    WHERE sb."isActive" = true AND sb."remainingQty" > 0
    GROUP BY sb."orgId", sb."goodId", sb."warehouseId", si."quantity"
  LOOP
    deficit := rec.batch_sum - rec.stock_qty;
    IF deficit <= 0 THEN
      CONTINUE; -- інваріант уже тримається (або партій менше за залишок) — пропускаємо
    END IF;

    -- FIFO: доспоживаємо найстаріші партії (createdAt asc), лишаючи слід Reconcile.
    FOR b IN
      SELECT "id", "remainingQty"
      FROM "stock_batches"
      WHERE "orgId" = rec."orgId" AND "goodId" = rec."goodId"
        AND "warehouseId" = rec."warehouseId"
        AND "isActive" = true AND "remainingQty" > 0
      ORDER BY "createdAt" ASC
    LOOP
      EXIT WHEN deficit <= 0;
      take := LEAST(b."remainingQty", deficit);
      UPDATE "stock_batches"
        SET "remainingQty" = "remainingQty" - take,
            "isActive" = ("remainingQty" - take) > 0
        WHERE "id" = b."id";
      INSERT INTO "batch_consumptions"
        ("id", "orgId", "batchId", "goodId", "quantity", "documentType", "documentId", "createdAt")
        VALUES (gen_random_uuid(), rec."orgId", b."id", rec."goodId", -take,
                'Reconcile', b."id", now());
      deficit := deficit - take;
    END LOOP;
  END LOOP;
END $$;
