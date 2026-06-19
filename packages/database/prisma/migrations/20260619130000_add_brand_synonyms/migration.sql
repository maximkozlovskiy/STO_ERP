CREATE TABLE "brand_synonyms" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "brandId" UUID NOT NULL,
    "synonym" TEXT NOT NULL,
    "syncVersion" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "brand_synonyms_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "brand_synonyms_orgId_synonym_key" ON "brand_synonyms"("orgId", "synonym");
CREATE INDEX "brand_synonyms_orgId_brandId_deletedAt_idx" ON "brand_synonyms"("orgId", "brandId", "deletedAt");

ALTER TABLE "brand_synonyms" ADD CONSTRAINT "brand_synonyms_brandId_fkey"
    FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
