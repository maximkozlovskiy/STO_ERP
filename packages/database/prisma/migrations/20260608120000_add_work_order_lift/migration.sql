-- AlterTable
ALTER TABLE "work_orders" ADD COLUMN "liftId" UUID;

-- AddForeignKey
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_liftId_fkey" FOREIGN KEY ("liftId") REFERENCES "lifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
