-- CreateEnum
CREATE TYPE "SyncJobStatus" AS ENUM ('PENDING', 'RUNNING', 'DONE', 'FAILED');

-- CreateTable
CREATE TABLE "sync_jobs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "tableName" TEXT NOT NULL,
    "recordId" UUID NOT NULL,
    "operation" TEXT NOT NULL,
    "syncVersion" BIGINT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "SyncJobStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "sync_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sync_jobs_orgId_status_idx" ON "sync_jobs"("orgId", "status");

-- CreateIndex
CREATE INDEX "sync_jobs_orgId_tableName_syncVersion_idx" ON "sync_jobs"("orgId", "tableName", "syncVersion");
