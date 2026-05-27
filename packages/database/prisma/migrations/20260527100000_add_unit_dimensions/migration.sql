-- AlterTable: add dimensions and coefficient to units_of_measure
ALTER TABLE "units_of_measure"
  ADD COLUMN "coefficient" DOUBLE PRECISION NOT NULL DEFAULT 1,
  ADD COLUMN "width"       DOUBLE PRECISION,
  ADD COLUMN "height"      DOUBLE PRECISION,
  ADD COLUMN "depth"       DOUBLE PRECISION,
  ADD COLUMN "volume"      DOUBLE PRECISION,
  ADD COLUMN "weight"      DOUBLE PRECISION;
