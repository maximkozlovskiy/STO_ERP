-- AlterTable: add recalcActualHoursFromLines to organisation_settings
ALTER TABLE "organisation_settings" ADD COLUMN "recalcActualHoursFromLines" BOOLEAN NOT NULL DEFAULT true;
