-- Мультивалюта Фаза 2: Payment + SettlementTransaction += currencyId/amountBase/rateUsed (additive).
-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "amountBase" DECIMAL(12,2),
ADD COLUMN     "currencyId" UUID,
ADD COLUMN     "rateUsed" DECIMAL(18,6);

-- AlterTable
ALTER TABLE "settlement_transactions" ADD COLUMN     "amountBase" DECIMAL(12,2),
ADD COLUMN     "currencyId" UUID,
ADD COLUMN     "rateUsed" DECIMAL(18,6);

-- Backfill наявних = базова валюта org (UAH): base = amount, курс = 1, currencyId = валюта org
-- (per-org: код з organisation_settings.currency → currencies.id тієї ж org). Якщо не резолвиться —
-- currencyId лишається NULL, amountBase=amount (усе історично у base UAH).
UPDATE "payments" p SET
  "amountBase" = p."amount",
  "rateUsed" = 1,
  "currencyId" = (
    SELECT c."id" FROM "currencies" c
    JOIN "organisation_settings" os ON os."orgId" = p."orgId"
    WHERE c."orgId" = p."orgId" AND c."code" = os."currency" AND c."deletedAt" IS NULL
    LIMIT 1
  )
WHERE p."amountBase" IS NULL;

UPDATE "settlement_transactions" st SET
  "amountBase" = st."amount",
  "rateUsed" = 1,
  "currencyId" = (
    SELECT c."id" FROM "currencies" c
    JOIN "organisation_settings" os ON os."orgId" = st."orgId"
    WHERE c."orgId" = st."orgId" AND c."code" = os."currency" AND c."deletedAt" IS NULL
    LIMIT 1
  )
WHERE st."amountBase" IS NULL;
