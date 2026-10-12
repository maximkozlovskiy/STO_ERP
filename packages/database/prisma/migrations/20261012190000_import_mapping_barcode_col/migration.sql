-- Import wizard: optional barcode column in the saved per-counterparty column mapping
-- (unified good matching, BR-GOOD-008). Additive only.

-- AlterTable
ALTER TABLE "counterparty_import_mappings" ADD COLUMN "barcodeCol" INTEGER;
