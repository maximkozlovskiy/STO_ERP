-- AlterTable
ALTER TABLE "currencies" ADD COLUMN     "nbuFetchEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "nbuMarkupPercent" DECIMAL(6,2);

-- AlterTable
ALTER TABLE "organisation_settings" ADD COLUMN     "nbuFetchHour" INTEGER NOT NULL DEFAULT 12;
