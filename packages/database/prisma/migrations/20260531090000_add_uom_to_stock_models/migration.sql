-- AlterTable: add unitOfMeasureId to purchase_order_lines
ALTER TABLE "purchase_order_lines" ADD COLUMN "unitOfMeasureId" UUID;

-- AlterTable: add unitOfMeasureId to stock_batches
ALTER TABLE "stock_batches" ADD COLUMN "unitOfMeasureId" UUID;

-- AlterTable: add unitOfMeasureId to stock_document_lines
ALTER TABLE "stock_document_lines" ADD COLUMN "unitOfMeasureId" UUID;

-- AlterTable: add unitOfMeasureId to stock_movements
ALTER TABLE "stock_movements" ADD COLUMN "unitOfMeasureId" UUID;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_unitOfMeasureId_fkey" FOREIGN KEY ("unitOfMeasureId") REFERENCES "units_of_measure"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_batches" ADD CONSTRAINT "stock_batches_unitOfMeasureId_fkey" FOREIGN KEY ("unitOfMeasureId") REFERENCES "units_of_measure"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_unitOfMeasureId_fkey" FOREIGN KEY ("unitOfMeasureId") REFERENCES "units_of_measure"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_document_lines" ADD CONSTRAINT "stock_document_lines_unitOfMeasureId_fkey" FOREIGN KEY ("unitOfMeasureId") REFERENCES "units_of_measure"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill StockBatch.unitOfMeasureId from Good.unitId (where Good.unitId is not NULL and UoM is not soft-deleted)
UPDATE "stock_batches" sb
SET "unitOfMeasureId" = g."unitId"
FROM "goods" g
JOIN "units_of_measure" u ON u.id = g."unitId" AND u."deletedAt" IS NULL
WHERE sb."goodId" = g.id AND sb."unitOfMeasureId" IS NULL;
