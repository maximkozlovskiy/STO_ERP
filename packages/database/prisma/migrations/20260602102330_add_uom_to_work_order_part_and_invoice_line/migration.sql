-- AlterTable
ALTER TABLE "invoice_lines" ADD COLUMN     "unitOfMeasureId" UUID;

-- AlterTable
ALTER TABLE "work_order_parts" ADD COLUMN     "unitOfMeasureId" UUID;

-- AddForeignKey
ALTER TABLE "work_order_parts" ADD CONSTRAINT "work_order_parts_unitOfMeasureId_fkey" FOREIGN KEY ("unitOfMeasureId") REFERENCES "units_of_measure"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_unitOfMeasureId_fkey" FOREIGN KEY ("unitOfMeasureId") REFERENCES "units_of_measure"("id") ON DELETE SET NULL ON UPDATE CASCADE;
