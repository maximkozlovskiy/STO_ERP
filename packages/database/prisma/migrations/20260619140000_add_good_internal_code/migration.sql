-- Add GOOD_INTERNAL_CODE to DocumentType enum
ALTER TYPE "DocumentType" ADD VALUE IF NOT EXISTS 'GOOD_INTERNAL_CODE';

-- Add internalCode field to goods
ALTER TABLE "goods" ADD COLUMN IF NOT EXISTS "internalCode" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "goods_orgId_internalCode_key" ON "goods"("orgId", "internalCode");
