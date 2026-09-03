-- Конструктор звітів: збережені конфігурації (report-builder). config — ReportConfig JSON.
CREATE TABLE "saved_reports" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "createdBy" UUID,
    "syncVersion" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "saved_reports_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "saved_reports_orgId_deletedAt_idx" ON "saved_reports"("orgId", "deletedAt");
CREATE INDEX "saved_reports_orgId_syncVersion_idx" ON "saved_reports"("orgId", "syncVersion");

ALTER TABLE "saved_reports" ADD CONSTRAINT "saved_reports_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
