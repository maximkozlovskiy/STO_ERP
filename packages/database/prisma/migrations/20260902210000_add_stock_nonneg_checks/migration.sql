-- Altitude-фікс (simplify cycle 2): інваріанти НЕ-ВІДʼЄМНОСТІ залишків тепер захищені
-- на рівні БД, а не лише в застосунку. Bug #613 додав app-level guard (post-upsert re-check
-- + conditional updateMany) з локалізованими повідомленнями та CAS-retry-семантикою — вони
-- ЛИШАЮТЬСЯ (переклад очікуваної гонки + «lost race → retry»). Ці CHECK — backstop, що ловить
-- БУДЬ-ЯКИЙ забутий чи майбутній writer (зокрема offline-first sync-merge шлях), кидаючи
-- 23514 check_violation і відкочуючи tx. Defense-in-depth, не заміна.
--
-- БЕЗПЕЧНА на чистій dev-БД (0 негативів станом на 2026-09-02). Для ПРОДу, де до Bug #613
-- гонка могла лишити від'ємне значення: спершу clamp до 0 (ідемпотентно), потім constraint.
-- ⚠️ ПРОД: BACKUP перед запуском. Clamp лишає слід у notes НЕ робиться (лічильники — не журнал);
-- історичний рух уже у stock_movements. Повторний запуск після clamp — no-op.

-- 1. Clamp наявних негативів (прод-safety; на чистій dev — 0 рядків).
UPDATE "stock_items" SET "quantity" = 0 WHERE "quantity" < 0;
UPDATE "stock_items" SET "reserved" = 0 WHERE "reserved" < 0;
UPDATE "stock_batches" SET "remainingQty" = 0, "isActive" = false WHERE "remainingQty" < 0;

-- 2. Джерело-правди інваріантів на рівні таблиць. IF NOT EXISTS-семантику Postgres для
--    ADD CONSTRAINT не має до PG16 — обгортаємо у DO-guard для ідемпотентності міграції.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_items_quantity_nonneg') THEN
    ALTER TABLE "stock_items"
      ADD CONSTRAINT "stock_items_quantity_nonneg" CHECK ("quantity" >= 0 AND "reserved" >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_batches_remaining_nonneg') THEN
    ALTER TABLE "stock_batches"
      ADD CONSTRAINT "stock_batches_remaining_nonneg" CHECK ("remainingQty" >= 0);
  END IF;
END $$;
