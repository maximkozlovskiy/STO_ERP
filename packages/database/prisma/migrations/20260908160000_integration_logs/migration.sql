-- Журнал зовнішніх HTTP-обмінів з інтеграціями (метадані лише, append-only) +
-- retention-конфіг у OrganisationSettings. Additive/idempotent, deploy-safe.

ALTER TABLE "organisation_settings"
  ADD COLUMN IF NOT EXISTS "integrationLogRetentionDays" INTEGER NOT NULL DEFAULT 30;

CREATE TABLE IF NOT EXISTS "integration_logs" (
  "id"           UUID NOT NULL DEFAULT gen_random_uuid(),
  "orgId"        UUID NOT NULL,
  "branchId"     UUID,
  "provider"     TEXT NOT NULL,
  "operation"    TEXT NOT NULL,
  "ok"           BOOLEAN NOT NULL,
  "httpStatus"   INTEGER,
  "durationMs"   INTEGER,
  "documentType" TEXT,
  "documentId"   UUID,
  "error"        TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "integration_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "integration_logs_orgId_createdAt_idx"
  ON "integration_logs" ("orgId", "createdAt");
CREATE INDEX IF NOT EXISTS "integration_logs_orgId_documentType_documentId_idx"
  ON "integration_logs" ("orgId", "documentType", "documentId");
