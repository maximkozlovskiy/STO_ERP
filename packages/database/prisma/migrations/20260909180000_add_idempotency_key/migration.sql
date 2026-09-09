-- A1: Idempotency-Key дедуплікація create-документів під offline-retry. Server-local infra
-- (без syncVersion/deletedAt — не sync-иться). unique(orgId,key) = лок проти конкурентних дублів.
-- Additive, deploy-safe (CREATE TABLE IF NOT EXISTS).
CREATE TABLE IF NOT EXISTS "idempotency_keys" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "responseStatus" INTEGER,
    "responseBody" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "idempotency_keys_orgId_key_key" ON "idempotency_keys"("orgId", "key");
CREATE INDEX IF NOT EXISTS "idempotency_keys_expiresAt_idx" ON "idempotency_keys"("expiresAt");

ALTER TABLE "idempotency_keys" DROP CONSTRAINT IF EXISTS "idempotency_keys_orgId_fkey";
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
