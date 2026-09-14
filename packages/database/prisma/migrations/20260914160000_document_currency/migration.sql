-- Мультивалюта Фаза 3: валюта документів. WorkOrder/PurchaseOrder/Invoice/SupplierPayment +=
-- currencyId/totalAmountBase/rateUsed (additive, nullable). Рядки лишаються у валюті документа;
-- на рівні документа зберігається base-сума по курсу на дату. Backfill наявних = base UAH.

-- AlterTable
ALTER TABLE "work_orders"       ADD COLUMN "currencyId" UUID, ADD COLUMN "totalAmountBase" DECIMAL(12,2), ADD COLUMN "rateUsed" DECIMAL(18,6);
ALTER TABLE "purchase_orders"   ADD COLUMN "currencyId" UUID, ADD COLUMN "totalAmountBase" DECIMAL(12,2), ADD COLUMN "rateUsed" DECIMAL(18,6);
ALTER TABLE "invoices"          ADD COLUMN "currencyId" UUID, ADD COLUMN "totalAmountBase" DECIMAL(12,2), ADD COLUMN "rateUsed" DECIMAL(18,6);
ALTER TABLE "supplier_payments" ADD COLUMN "currencyId" UUID, ADD COLUMN "totalAmountBase" DECIMAL(12,2), ADD COLUMN "rateUsed" DECIMAL(18,6);

-- AddForeignKey (валюта опційна → ON DELETE SET NULL, як у payments/settlement_transactions Фази 2)
ALTER TABLE "work_orders"       ADD CONSTRAINT "work_orders_currencyId_fkey"       FOREIGN KEY ("currencyId") REFERENCES "currencies"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "purchase_orders"   ADD CONSTRAINT "purchase_orders_currencyId_fkey"   FOREIGN KEY ("currencyId") REFERENCES "currencies"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "invoices"          ADD CONSTRAINT "invoices_currencyId_fkey"          FOREIGN KEY ("currencyId") REFERENCES "currencies"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_currencyId_fkey" FOREIGN KEY ("currencyId") REFERENCES "currencies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill наявних = базова валюта org (UAH): base = поточний total, курс = 1, currencyId = валюта org
-- (per-org: код з organisation_settings.currency → currencies.id тієї ж org). Не резолвиться → NULL (NULL-path=base).
UPDATE "work_orders" d SET
  "totalAmountBase" = d."totalAmount", "rateUsed" = 1,
  "currencyId" = (SELECT c."id" FROM "currencies" c JOIN "organisation_settings" os ON os."orgId" = d."orgId"
                  WHERE c."orgId" = d."orgId" AND c."code" = os."currency" AND c."deletedAt" IS NULL LIMIT 1)
WHERE d."totalAmountBase" IS NULL;

UPDATE "purchase_orders" d SET
  "totalAmountBase" = d."totalAmount", "rateUsed" = 1,
  "currencyId" = (SELECT c."id" FROM "currencies" c JOIN "organisation_settings" os ON os."orgId" = d."orgId"
                  WHERE c."orgId" = d."orgId" AND c."code" = os."currency" AND c."deletedAt" IS NULL LIMIT 1)
WHERE d."totalAmountBase" IS NULL;

UPDATE "invoices" d SET
  "totalAmountBase" = d."amount", "rateUsed" = 1,
  "currencyId" = (SELECT c."id" FROM "currencies" c JOIN "organisation_settings" os ON os."orgId" = d."orgId"
                  WHERE c."orgId" = d."orgId" AND c."code" = os."currency" AND c."deletedAt" IS NULL LIMIT 1)
WHERE d."totalAmountBase" IS NULL;

UPDATE "supplier_payments" d SET
  "totalAmountBase" = d."amount", "rateUsed" = 1,
  "currencyId" = (SELECT c."id" FROM "currencies" c JOIN "organisation_settings" os ON os."orgId" = d."orgId"
                  WHERE c."orgId" = d."orgId" AND c."code" = os."currency" AND c."deletedAt" IS NULL LIMIT 1)
WHERE d."totalAmountBase" IS NULL;
