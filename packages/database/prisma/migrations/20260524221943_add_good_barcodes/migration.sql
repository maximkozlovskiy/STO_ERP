-- CreateTable
CREATE TABLE "good_barcodes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "goodId" UUID NOT NULL,
    "barcode" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'EAN13',
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "good_barcodes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "good_barcodes_orgId_barcode_idx" ON "good_barcodes"("orgId", "barcode");

-- CreateIndex
CREATE INDEX "good_barcodes_orgId_goodId_idx" ON "good_barcodes"("orgId", "goodId");

-- AddForeignKey
ALTER TABLE "good_barcodes" ADD CONSTRAINT "good_barcodes_goodId_fkey" FOREIGN KEY ("goodId") REFERENCES "goods"("id") ON DELETE CASCADE ON UPDATE CASCADE;
