-- Pricing rules (owner decision 2026-10-12): a rule targets a LIST of goods and a category from
-- the goods-category dictionary instead of one good and a free-text category.
-- Additive only: "goodId" and "goodCategory" stay (no column is dropped here). "goodId" is no
-- longer read by the application; "goodCategory" is read only for legacy rules whose text did not
-- resolve to exactly one dictionary category below.

-- AlterTable
ALTER TABLE "pricing_rules" ADD COLUMN "goodCategoryId" UUID;

-- CreateTable
CREATE TABLE "pricing_rule_goods" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "pricingRuleId" UUID NOT NULL,
    "goodId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pricing_rule_goods_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pricing_rule_goods_pricingRuleId_goodId_key" ON "pricing_rule_goods"("pricingRuleId", "goodId");

-- CreateIndex
CREATE INDEX "pricing_rule_goods_orgId_goodId_idx" ON "pricing_rule_goods"("orgId", "goodId");

-- CreateIndex
CREATE INDEX "pricing_rules_orgId_goodCategoryId_idx" ON "pricing_rules"("orgId", "goodCategoryId");

-- AddForeignKey
ALTER TABLE "pricing_rules" ADD CONSTRAINT "pricing_rules_goodCategoryId_fkey" FOREIGN KEY ("goodCategoryId") REFERENCES "good_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pricing_rule_goods" ADD CONSTRAINT "pricing_rule_goods_pricingRuleId_fkey" FOREIGN KEY ("pricingRuleId") REFERENCES "pricing_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pricing_rule_goods" ADD CONSTRAINT "pricing_rule_goods_goodId_fkey" FOREIGN KEY ("goodId") REFERENCES "goods"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Data: the single good of an existing rule becomes the first row of its list.
INSERT INTO "pricing_rule_goods" ("orgId", "pricingRuleId", "goodId")
SELECT r."orgId", r."id", r."goodId"
FROM "pricing_rules" r
JOIN "goods" g ON g."id" = r."goodId" AND g."orgId" = r."orgId"
WHERE r."goodId" IS NOT NULL
ON CONFLICT ("pricingRuleId", "goodId") DO NOTHING;

-- Data: a text category becomes a dictionary category when exactly one live category of the same
-- organisation carries that name (case-insensitive, trimmed). Ambiguous or unknown names are left
-- as text: such a rule keeps matching goods by their text category, as before.
UPDATE "pricing_rules" r
SET "goodCategoryId" = m."categoryId", "goodCategory" = NULL
FROM (
  SELECT r2."id" AS "ruleId", (array_agg(c."id"))[1] AS "categoryId"
  FROM "pricing_rules" r2
  JOIN "good_categories" c
    ON c."orgId" = r2."orgId"
   AND c."deletedAt" IS NULL
   AND lower(btrim(c."name")) = lower(btrim(r2."goodCategory"))
  WHERE r2."goodCategory" IS NOT NULL AND btrim(r2."goodCategory") <> ''
  GROUP BY r2."id"
  HAVING count(*) = 1
) m
WHERE r."id" = m."ruleId";
