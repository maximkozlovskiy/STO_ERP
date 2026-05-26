-- CreateTable
CREATE TABLE "work_order_media" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "workOrderId" UUID NOT NULL,
    "fileKey" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "uploadedBy" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "syncVersion" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "work_order_media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "diff" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "work_order_media_orgId_workOrderId_idx" ON "work_order_media"("orgId", "workOrderId");

-- CreateIndex
CREATE INDEX "work_order_media_orgId_syncVersion_idx" ON "work_order_media"("orgId", "syncVersion");

-- CreateIndex
CREATE INDEX "audit_events_orgId_entityType_entityId_idx" ON "audit_events"("orgId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "audit_events_orgId_createdAt_idx" ON "audit_events"("orgId", "createdAt");

-- AddForeignKey
ALTER TABLE "work_order_media" ADD CONSTRAINT "work_order_media_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_order_media" ADD CONSTRAINT "work_order_media_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "work_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_order_media" ADD CONSTRAINT "work_order_media_uploadedBy_fkey" FOREIGN KEY ("uploadedBy") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_userId_fkey" FOREIGN KEY ("userId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
