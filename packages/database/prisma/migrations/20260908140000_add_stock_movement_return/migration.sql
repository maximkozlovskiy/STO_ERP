-- Новий тип руху RETURN — повернення на склад (реверс WRITEOFF) при скасуванні завершеного
-- наряду (COMPLETED→CANCELLED). Additive/idempotent.
-- ОКРЕМА міграція: Postgres не дозволяє вживати нове enum-значення у тій же транзакції, де
-- його додано (дзеркалить 20260902120000_add_supplier_settlement_types).
ALTER TYPE "StockMovementType" ADD VALUE IF NOT EXISTS 'RETURN';
