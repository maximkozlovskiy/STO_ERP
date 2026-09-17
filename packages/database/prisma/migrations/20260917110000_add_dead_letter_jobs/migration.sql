-- Централізований DLQ для BullMQ (аудит стеку, backend #2). Additive: нова таблиця, без змін
-- наявних → zero-risk, без backfill. Durable-storage вичерпаних job-ів (переживає Redis flush).

CREATE TABLE IF NOT EXISTS "dead_letter_jobs" (
  "id"           UUID NOT NULL DEFAULT gen_random_uuid(),
  "orgId"        UUID,
  "queueName"    TEXT NOT NULL,
  "jobName"      TEXT NOT NULL,
  "bullJobId"    TEXT NOT NULL,
  "attemptsMade" INTEGER NOT NULL,
  "maxAttempts"  INTEGER NOT NULL,
  "failedReason" TEXT NOT NULL,
  "stacktrace"   TEXT,
  "payload"      JSONB NOT NULL,
  "resolved"     BOOLEAN NOT NULL DEFAULT false,
  "resolvedAt"   TIMESTAMP(3),
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "dead_letter_jobs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "dead_letter_jobs_orgId_createdAt_idx"
  ON "dead_letter_jobs" ("orgId", "createdAt");
CREATE INDEX IF NOT EXISTS "dead_letter_jobs_queueName_createdAt_idx"
  ON "dead_letter_jobs" ("queueName", "createdAt");
-- UI-фільтр: активні (resolved=false) зверху за createdAt.
CREATE INDEX IF NOT EXISTS "dead_letter_jobs_resolved_createdAt_idx"
  ON "dead_letter_jobs" ("resolved", "createdAt");
