-- Excel-імпорт товарів: нормалізовані колонки для exact-пошуку + per-counterparty мапінг колонок.
-- Additive + idempotent. Backfill похідних колонок з наявних даних (0 ledger-впливу).

-- 1. Good.skuNormalized (upper + strip non-alnum з sku) + індекс
ALTER TABLE "goods" ADD COLUMN IF NOT EXISTS "skuNormalized" TEXT;
UPDATE "goods"
   SET "skuNormalized" = UPPER(REGEXP_REPLACE("sku", '[^A-Za-z0-9]', '', 'g'))
 WHERE "sku" IS NOT NULL AND "sku" <> '' AND "skuNormalized" IS NULL;
CREATE INDEX IF NOT EXISTS "goods_orgId_skuNormalized_idx" ON "goods" ("orgId", "skuNormalized");

-- 2. BrandSynonym.normalizedSynonym (upper + strip non-alnum) + індекс
ALTER TABLE "brand_synonyms" ADD COLUMN IF NOT EXISTS "normalizedSynonym" TEXT;
UPDATE "brand_synonyms"
   SET "normalizedSynonym" = UPPER(REGEXP_REPLACE("synonym", '[^A-Za-z0-9]', '', 'g'))
 WHERE "synonym" IS NOT NULL AND "synonym" <> '' AND "normalizedSynonym" IS NULL;
CREATE INDEX IF NOT EXISTS "brand_synonyms_orgId_normalizedSynonym_idx"
  ON "brand_synonyms" ("orgId", "normalizedSynonym");

-- 3. CounterpartyImportMapping — мапінг колонок Excel per-контрагент
CREATE TABLE IF NOT EXISTS "counterparty_import_mappings" (
  "id"             UUID NOT NULL DEFAULT gen_random_uuid(),
  "orgId"          UUID NOT NULL,
  "counterpartyId" UUID NOT NULL,
  "startRow"       INTEGER NOT NULL DEFAULT 2,
  "codeCol"        INTEGER,
  "articleCol"     INTEGER,
  "brandCol"       INTEGER,
  "nameCol"        INTEGER,
  "quantityCol"    INTEGER,
  "priceCol"       INTEGER,
  "syncVersion"    BIGINT NOT NULL DEFAULT 0,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  "deletedAt"      TIMESTAMP(3),
  CONSTRAINT "counterparty_import_mappings_pkey" PRIMARY KEY ("id")
);
-- 1:1 з контрагентом → single-field unique (вимога Prisma для one-to-one relation)
CREATE UNIQUE INDEX IF NOT EXISTS "counterparty_import_mappings_counterpartyId_key"
  ON "counterparty_import_mappings" ("counterpartyId");
CREATE INDEX IF NOT EXISTS "counterparty_import_mappings_orgId_counterpartyId_idx"
  ON "counterparty_import_mappings" ("orgId", "counterpartyId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'counterparty_import_mappings_counterpartyId_fkey'
  ) THEN
    ALTER TABLE "counterparty_import_mappings"
      ADD CONSTRAINT "counterparty_import_mappings_counterpartyId_fkey"
      FOREIGN KEY ("counterpartyId") REFERENCES "counterparties"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
