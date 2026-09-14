-- TD1: currencyId → NOT NULL для документних грошових таблиць (WorkOrder/PurchaseOrder/Invoice/
-- SupplierPayment). База сідиться на setup (setup.service) + backfill Фаз 3/5 заповнив наявні рядки
-- (перевірено: 0 NULL). Захисний backfill стрічних NULL перед SET NOT NULL — на випадок edge-org без
-- seeded-валюти (currencyId = валюта org за кодом OrganisationSettings.currency).
-- Payment/SettlementTransaction лишаються nullable СВІДОМО (оплата без source-рахунку / UAH-caller без
-- currencyId → NULL≡base) — їх НЕ чіпаємо.

-- Захисний backfill (ідемпотентний; на чистих даних — no-op)
UPDATE "work_orders" d SET "currencyId" = (
  SELECT c."id" FROM "currencies" c JOIN "organisation_settings" os ON os."orgId" = d."orgId"
  WHERE c."orgId" = d."orgId" AND c."code" = os."currency" AND c."deletedAt" IS NULL LIMIT 1)
WHERE d."currencyId" IS NULL;
UPDATE "purchase_orders" d SET "currencyId" = (
  SELECT c."id" FROM "currencies" c JOIN "organisation_settings" os ON os."orgId" = d."orgId"
  WHERE c."orgId" = d."orgId" AND c."code" = os."currency" AND c."deletedAt" IS NULL LIMIT 1)
WHERE d."currencyId" IS NULL;
UPDATE "invoices" d SET "currencyId" = (
  SELECT c."id" FROM "currencies" c JOIN "organisation_settings" os ON os."orgId" = d."orgId"
  WHERE c."orgId" = d."orgId" AND c."code" = os."currency" AND c."deletedAt" IS NULL LIMIT 1)
WHERE d."currencyId" IS NULL;
UPDATE "supplier_payments" d SET "currencyId" = (
  SELECT c."id" FROM "currencies" c JOIN "organisation_settings" os ON os."orgId" = d."orgId"
  WHERE c."orgId" = d."orgId" AND c."code" = os."currency" AND c."deletedAt" IS NULL LIMIT 1)
WHERE d."currencyId" IS NULL;

-- SET NOT NULL
ALTER TABLE "work_orders"       ALTER COLUMN "currencyId" SET NOT NULL;
ALTER TABLE "purchase_orders"   ALTER COLUMN "currencyId" SET NOT NULL;
ALTER TABLE "invoices"          ALTER COLUMN "currencyId" SET NOT NULL;
ALTER TABLE "supplier_payments" ALTER COLUMN "currencyId" SET NOT NULL;
