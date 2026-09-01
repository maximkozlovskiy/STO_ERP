-- Постачальницькі типи settlement-транзакцій з окремою семантикою знаку.
-- ОКРЕМА міграція (перед backfill) — Postgres не дозволяє вживати нове enum-значення
-- у тій самій транзакції, де його додано.
ALTER TYPE "SettlementTransactionType" ADD VALUE IF NOT EXISTS 'SUPPLIER_CHARGE';
ALTER TYPE "SettlementTransactionType" ADD VALUE IF NOT EXISTS 'SUPPLIER_PAYMENT';
ALTER TYPE "SettlementTransactionType" ADD VALUE IF NOT EXISTS 'SUPPLIER_REFUND';
