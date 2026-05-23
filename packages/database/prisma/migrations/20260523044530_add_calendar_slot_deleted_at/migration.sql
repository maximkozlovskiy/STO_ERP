-- AlterTable
ALTER TABLE "calendar_slots" ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "calendar_slots_orgId_deletedAt_idx" ON "calendar_slots"("orgId", "deletedAt");
