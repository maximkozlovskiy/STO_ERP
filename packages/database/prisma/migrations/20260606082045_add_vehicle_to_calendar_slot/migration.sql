-- AlterTable
ALTER TABLE "calendar_slots" ADD COLUMN     "vehicleId" UUID;

-- AddForeignKey
ALTER TABLE "calendar_slots" ADD CONSTRAINT "calendar_slots_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
