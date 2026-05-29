-- AddValue: PricingRuleType.COST_TIER
ALTER TYPE "PricingRuleType" ADD VALUE IF NOT EXISTS 'COST_TIER';

-- AlterTable: PricingRule — add brandId column
ALTER TABLE "pricing_rules" ADD COLUMN IF NOT EXISTS "brandId" UUID;

-- CreateTable: pricing_rule_tiers
CREATE TABLE IF NOT EXISTS "pricing_rule_tiers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "pricingRuleId" UUID NOT NULL,
    "costMin" DECIMAL(12,2) NOT NULL,
    "costMax" DECIMAL(12,2),
    "percentValue" DECIMAL(6,2) NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "pricing_rule_tiers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "pricing_rule_tiers_pricingRuleId_costMin_idx"
    ON "pricing_rule_tiers"("pricingRuleId", "costMin");

-- AddForeignKey: pricing_rules.brandId -> brands.id
ALTER TABLE "pricing_rules"
    ADD CONSTRAINT "pricing_rules_brandId_fkey"
    FOREIGN KEY ("brandId") REFERENCES "brands"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
    DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey: pricing_rule_tiers.pricingRuleId -> pricing_rules.id (CASCADE)
ALTER TABLE "pricing_rule_tiers"
    ADD CONSTRAINT "pricing_rule_tiers_pricingRuleId_fkey"
    FOREIGN KEY ("pricingRuleId") REFERENCES "pricing_rules"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
