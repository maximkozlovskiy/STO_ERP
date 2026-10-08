-- BR-WO-007: сума наряду до сплати містить ПДВ у всіх режимах.
--
-- Нове поле work_orders."totalNet" — сума без ПДВ. Інваріант наряду:
--   "totalNet" + "totalVat" = "totalAmount", де "totalAmount" — сума до сплати (борг клієнта).
--
-- Рішення власника (2026-10-08): перерахувати лише ВІДКРИТІ наряди (до «Завершено»).
-- Завершені, виставлені, оплачені, архівні й скасовані не чіпаються: клієнтові ПДВ зверху за ними
-- не нараховували, борг і рахунок уже зафіксовані. Для них "totalNet" = "totalAmount"
-- (у режимі «ПДВ у ціні» — "totalAmount" − "totalVat", бо там ПДВ у сумі вже був).
--
-- Ставка й режим — ті самі, що бере SettingsService.getDefaultVatRate: режим з
-- organisation_settings."vatMode", ставка — "defaultVatRateId", інакше активна ставка за замовчуванням.

ALTER TABLE "work_orders" ADD COLUMN IF NOT EXISTS "totalNet" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- 1. Усі наряди: сума без ПДВ = сума наряду (стан до правки; режими NONE і EXCLUSIVE, закриті).
UPDATE "work_orders" SET "totalNet" = "totalAmount";

-- 2. Закриті наряди організацій «ПДВ у ціні»: ПДВ уже сидить у сумі — виділяємо збережений.
UPDATE "work_orders" w
SET "totalNet" = GREATEST(w."totalAmount" - w."totalVat", 0)
FROM "organisation_settings" s
WHERE s."orgId" = w."orgId"
  AND s."vatMode" = 'INCLUSIVE'
  AND w."status" NOT IN ('DRAFT', 'ESTIMATE', 'APPROVED', 'IN_PROGRESS', 'ON_HOLD');

-- 3. Відкриті наряди: ПДВ рахується заново від бази за чинною ставкою (збережений "totalVat"
--    лінивий — міг лишитись від іншого режиму), і сума до сплати приводиться до нової моделі.
WITH rates AS (
  SELECT
    s."orgId",
    s."vatMode",
    CASE
      WHEN s."vatMode" = 'NONE' THEN 0
      ELSE COALESCE(
        (SELECT t."rate" FROM "tax_rates" t
          WHERE t."id" = s."defaultVatRateId" AND t."orgId" = s."orgId"),
        CASE WHEN s."defaultVatRateId" IS NULL THEN
          (SELECT t."rate" FROM "tax_rates" t
            WHERE t."orgId" = s."orgId" AND t."isDefault" AND t."isActive"
            ORDER BY t."id" LIMIT 1)
        END,
        0)
    END AS rate
  FROM "organisation_settings" s
),
calc AS (
  SELECT
    w."id",
    w."totalAmount" AS base,
    r."vatMode",
    CASE
      WHEN r."vatMode" = 'EXCLUSIVE' THEN ROUND(w."totalAmount" * r.rate / 100, 2)
      WHEN r."vatMode" = 'INCLUSIVE' THEN ROUND(w."totalAmount" - w."totalAmount" / (1 + r.rate / 100), 2)
      ELSE 0
    END AS vat
  FROM "work_orders" w
  JOIN rates r ON r."orgId" = w."orgId"
  WHERE w."status" IN ('DRAFT', 'ESTIMATE', 'APPROVED', 'IN_PROGRESS', 'ON_HOLD')
)
UPDATE "work_orders" w
SET
  "totalVat" = c.vat,
  "totalNet" = CASE WHEN c."vatMode" = 'INCLUSIVE' THEN c.base - c.vat ELSE c.base END,
  "totalAmount" = CASE WHEN c."vatMode" = 'EXCLUSIVE' THEN c.base + c.vat ELSE c.base END,
  -- сума в базовій валюті масштабується тим самим коефіцієнтом (курс "rateUsed" не змінюється)
  "totalAmountBase" = CASE
    WHEN c."vatMode" = 'EXCLUSIVE' AND w."totalAmountBase" IS NOT NULL AND c.base > 0
      THEN ROUND(w."totalAmountBase" * (c.base + c.vat) / c.base, 2)
    ELSE w."totalAmountBase"
  END,
  "syncVersion" = w."syncVersion" + 1
FROM calc c
WHERE c."id" = w."id";
