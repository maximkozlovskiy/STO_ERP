-- AddColumns: pricedSalePrice and pricingRuleName to purchase_order_lines
ALTER TABLE "purchase_order_lines" ADD COLUMN IF NOT EXISTS "pricedSalePrice" DECIMAL(12,2);
ALTER TABLE "purchase_order_lines" ADD COLUMN IF NOT EXISTS "pricingRuleName" TEXT;
