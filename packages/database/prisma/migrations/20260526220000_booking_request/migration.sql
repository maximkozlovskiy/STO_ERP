-- CreateTable
CREATE TABLE "booking_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "clientName" TEXT NOT NULL,
    "clientPhone" TEXT NOT NULL,
    "serviceIds" TEXT[],
    "requestedDate" TIMESTAMP(3) NOT NULL,
    "confirmedSlotId" UUID,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "booking_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "booking_requests_orgId_status_deletedAt_idx" ON "booking_requests"("orgId", "status", "deletedAt");

-- CreateIndex
CREATE INDEX "booking_requests_orgId_createdAt_idx" ON "booking_requests"("orgId", "createdAt");

-- AddForeignKey
ALTER TABLE "booking_requests" ADD CONSTRAINT "booking_requests_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_requests" ADD CONSTRAINT "booking_requests_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "garage_branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
