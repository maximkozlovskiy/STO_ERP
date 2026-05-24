-- AlterTable
ALTER TABLE "goods" ADD COLUMN     "brandId" UUID;

-- CreateTable
CREATE TABLE "brands" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "syncVersion" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "brands_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "brands_orgId_deletedAt_idx" ON "brands"("orgId", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "brands_orgId_name_key" ON "brands"("orgId", "name");

-- AddForeignKey
ALTER TABLE "goods" ADD CONSTRAINT "goods_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE SET NULL ON UPDATE CASCADE;
