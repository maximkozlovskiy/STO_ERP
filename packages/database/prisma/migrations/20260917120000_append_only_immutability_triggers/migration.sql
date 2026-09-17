-- Append-only immutability тригери (аудит Дані/Інфра). Фінансовий/складський ledger — джерело правди;
-- досі незмінність трималась ЛИШЕ конвенцією коду + guard-тестом. БД тепер фізично забороняє
-- UPDATE/DELETE на append-only таблицях. Manual-SQL конструкт (не в schema.prisma) → захищений
-- schema-integrity.integration.spec (як GiST-EXCLUDE / partial-unique). Idempotent (DROP IF EXISTS).
--
-- stock_movements: рядок отримує ОДНОРАЗОВИЙ post-insert UPDATE "batchId" (NULL→value) у тій самій
-- createMovement-транзакції (inventory.service: рух вставляється ПЕРШИМ, бо його id — вхід для
-- consumeBatch, далі проставляється batchId для single-batch трасування). Тож блокуємо DELETE завжди
-- + UPDATE будь-чого КРІМ цього одноразового "batchId" NULL→non-NULL переходу.
-- settlement_transactions: жодного легітимного update/delete у коді → повна заборона UPDATE+DELETE.
-- Колонки Prisma — camelCase у лапках ("orgId", "goodId", "batchId" ...).

-- ─── settlement_transactions: повна незмінність ──────────────────────────────
CREATE OR REPLACE FUNCTION forbid_mutation_settlement_transactions()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'settlement_transactions є append-only (ledger): % заборонено', TG_OP
    USING ERRCODE = 'raise_exception';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_settlement_transactions_immutable ON settlement_transactions;
CREATE TRIGGER trg_settlement_transactions_immutable
  BEFORE UPDATE OR DELETE ON settlement_transactions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation_settlement_transactions();

-- ─── stock_movements: DELETE заборонено; UPDATE лише одноразовий "batchId" NULL→value ────────
CREATE OR REPLACE FUNCTION forbid_mutation_stock_movements()
RETURNS TRIGGER AS $$
BEGIN
  IF (TG_OP = 'DELETE') THEN
    RAISE EXCEPTION 'stock_movements є append-only (ledger): DELETE заборонено'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- Єдиний дозволений UPDATE: "batchId" з NULL на значення, за умови що ВСІ інші колонки незмінні.
  IF (OLD."batchId" IS NULL
      AND NEW."batchId" IS NOT NULL
      AND NEW.id           IS NOT DISTINCT FROM OLD.id
      AND NEW."orgId"      IS NOT DISTINCT FROM OLD."orgId"
      AND NEW."goodId"     IS NOT DISTINCT FROM OLD."goodId"
      AND NEW."warehouseId" IS NOT DISTINCT FROM OLD."warehouseId"
      AND NEW.type         IS NOT DISTINCT FROM OLD.type
      AND NEW.quantity     IS NOT DISTINCT FROM OLD.quantity
      AND NEW."documentType" IS NOT DISTINCT FROM OLD."documentType"
      AND NEW."documentId"   IS NOT DISTINCT FROM OLD."documentId"
      AND NEW."createdAt"  IS NOT DISTINCT FROM OLD."createdAt") THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'stock_movements є append-only (ledger): дозволено лише одноразове проставлення "batchId", інші UPDATE/зміни колонок заборонено'
    USING ERRCODE = 'raise_exception';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_stock_movements_immutable ON stock_movements;
CREATE TRIGGER trg_stock_movements_immutable
  BEFORE UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation_stock_movements();
