-- Мультивалюта Фаза 1: CashOperation += amountBase/rateUsed (additive, nullable).
-- AlterTable
ALTER TABLE "cash_operations" ADD COLUMN     "amountBase" DECIMAL(12,2),
ADD COLUMN     "rateUsed" DECIMAL(18,6);

-- Backfill наявних операцій = базова валюта (UAH): base = amount, курс = 1.
UPDATE "cash_operations" SET "amountBase" = "amount", "rateUsed" = 1 WHERE "amountBase" IS NULL;
