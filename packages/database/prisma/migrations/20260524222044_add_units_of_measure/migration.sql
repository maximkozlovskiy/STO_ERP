-- AlterTable
ALTER TABLE "goods" ADD COLUMN     "unitId" UUID;

-- CreateTable
CREATE TABLE "units_of_measure" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "shortName" TEXT NOT NULL,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "syncVersion" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "units_of_measure_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "units_of_measure_orgId_deletedAt_idx" ON "units_of_measure"("orgId", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "units_of_measure_orgId_shortName_key" ON "units_of_measure"("orgId", "shortName");

-- AddForeignKey
ALTER TABLE "goods" ADD CONSTRAINT "goods_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "units_of_measure"("id") ON DELETE SET NULL ON UPDATE CASCADE;
