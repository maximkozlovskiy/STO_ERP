-- QR-оплата monobank: OnlinePaymentIntent + monobank-креди на BranchSettings. Additive/idempotent.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'OnlinePaymentStatus') THEN
    CREATE TYPE "OnlinePaymentStatus" AS ENUM ('PENDING', 'PAID', 'FAILED', 'EXPIRED');
  END IF;
END $$;

ALTER TABLE "branch_settings" ADD COLUMN IF NOT EXISTS "monobankToken" TEXT;
ALTER TABLE "branch_settings" ADD COLUMN IF NOT EXISTS "monobankApiUrl" TEXT;

CREATE TABLE IF NOT EXISTS "online_payment_intents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "gateway" TEXT NOT NULL DEFAULT 'monobank',
    "gatewayInvoiceId" TEXT,
    "pageUrl" TEXT,
    "amount" DECIMAL(12,2) NOT NULL,
    "counterpartyId" UUID NOT NULL,
    "invoiceId" UUID,
    "workOrderId" UUID,
    "status" "OnlinePaymentStatus" NOT NULL DEFAULT 'PENDING',
    "paymentId" UUID,
    "error" TEXT,
    "expiresAt" TIMESTAMP(3),
    "syncVersion" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    CONSTRAINT "online_payment_intents_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "online_payment_intents_orgId_status_idx"
  ON "online_payment_intents" ("orgId", "status");
CREATE INDEX IF NOT EXISTS "online_payment_intents_orgId_createdAt_idx"
  ON "online_payment_intents" ("orgId", "createdAt");

-- Детермінувати monobank_qr: онлайн-оплата за замовч. фіскалізується (requiresFiscal=true) —
-- виправляє розбіжність seed(false)/setup(true). Idempotent.
UPDATE "payment_method_configs" SET "requiresFiscal" = true
WHERE "code" = 'monobank_qr' AND "requiresFiscal" = false;
