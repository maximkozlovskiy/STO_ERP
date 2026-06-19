-- AddColumn: supplierId to pricing_rules
ALTER TABLE "pricing_rules" ADD COLUMN "supplierId" UUID;

-- AddForeignKey
ALTER TABLE "pricing_rules" ADD CONSTRAINT "pricing_rules_supplierId_fkey"
  FOREIGN KEY ("supplierId") REFERENCES "counterparties"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "pricing_rules_orgId_supplierId_idx" ON "pricing_rules"("orgId", "supplierId");
