-- Bug #220: GoodUoM model was added to schema.prisma but no migration was created.
-- Without this table, /goods/:id/uoms endpoints fail at runtime with P2021
-- ("The table good_uom does not exist").

-- CreateTable
CREATE TABLE "good_uom" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "goodId" UUID NOT NULL,
    "unitOfMeasureId" UUID NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "good_uom_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (composite uniqueness — one row per (org, good, unit) tuple)
CREATE UNIQUE INDEX "good_uom_orgId_goodId_unitOfMeasureId_key" ON "good_uom"("orgId", "goodId", "unitOfMeasureId");

-- CreateIndex (covering index for list-by-good queries)
CREATE INDEX "good_uom_orgId_goodId_idx" ON "good_uom"("orgId", "goodId");

-- AddForeignKey (Good cascade — deleting a good removes its UoM mapping rows)
ALTER TABLE "good_uom" ADD CONSTRAINT "good_uom_goodId_fkey" FOREIGN KEY ("goodId") REFERENCES "goods"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey (UnitOfMeasure restrict — prevent deleting a unit that is still mapped to a good)
ALTER TABLE "good_uom" ADD CONSTRAINT "good_uom_unitOfMeasureId_fkey" FOREIGN KEY ("unitOfMeasureId") REFERENCES "units_of_measure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
