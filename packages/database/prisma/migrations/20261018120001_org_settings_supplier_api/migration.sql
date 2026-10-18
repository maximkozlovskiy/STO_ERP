-- Налаштування закупівлі через API постачальників (BR-SCON, BR-SOFR): режим відправки замовлень,
-- політика аналогів, стратегія автопідбору та її вага, TTL пропозицій, інтервали. Межі — як у DTO.

-- AlterTable
ALTER TABLE "organisation_settings" ADD COLUMN     "supplierAllowAnalogsInAuto" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "supplierAllowSplit" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "supplierAnalogPolicy" "SupplierAnalogPolicy" NOT NULL DEFAULT 'CATALOG_ONLY',
ADD COLUMN     "supplierCatalogSyncIntervalMinutes" INTEGER NOT NULL DEFAULT 360,
ADD COLUMN     "supplierDefaultStrategy" "SupplierStrategy" NOT NULL DEFAULT 'OPTIMAL',
ADD COLUMN     "supplierOfferRetentionDays" INTEGER NOT NULL DEFAULT 7,
ADD COLUMN     "supplierOfferTtlMinutes" INTEGER NOT NULL DEFAULT 60,
ADD COLUMN     "supplierOptimalPriceWeight" DECIMAL(4,3) NOT NULL DEFAULT 0.7,
ADD COLUMN     "supplierOrderPollIntervalMinutes" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "supplierOrderSendMode" "SupplierOrderSendMode" NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "supplierUnknownDeliveryDays" INTEGER NOT NULL DEFAULT 7;

ALTER TABLE "organisation_settings"
    ADD CONSTRAINT "org_settings_supplier_price_weight_chk"
        CHECK ("supplierOptimalPriceWeight" >= 0 AND "supplierOptimalPriceWeight" <= 1),
    ADD CONSTRAINT "org_settings_supplier_offer_ttl_chk"
        CHECK ("supplierOfferTtlMinutes" BETWEEN 5 AND 1440),
    ADD CONSTRAINT "org_settings_supplier_offer_retention_chk"
        CHECK ("supplierOfferRetentionDays" BETWEEN 1 AND 90),
    ADD CONSTRAINT "org_settings_supplier_poll_interval_chk"
        CHECK ("supplierOrderPollIntervalMinutes" BETWEEN 5 AND 1440),
    ADD CONSTRAINT "org_settings_supplier_catalog_interval_chk"
        CHECK ("supplierCatalogSyncIntervalMinutes" BETWEEN 60 AND 1440),
    ADD CONSTRAINT "org_settings_supplier_unknown_days_chk"
        CHECK ("supplierUnknownDeliveryDays" BETWEEN 1 AND 90);
