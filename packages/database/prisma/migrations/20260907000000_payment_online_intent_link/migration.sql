-- Bug #688: idempotency-лінк Payment ↔ OnlinePaymentIntent.
-- Реконсиляція наміру (PAID але Payment ще не залінковано) може повторити payments.create після
-- збою link-write. Унікальний констрейнт відкидає повторний INSERT того ж наміру (P2002) → finalize
-- знаходить наявний Payment і лінкує, замість тихого double-charge.
ALTER TABLE "payments" ADD COLUMN "onlinePaymentIntentId" UUID;

-- @unique → partial-friendly btree; NULL значення не конфліктують (звичайні платежі без наміру).
CREATE UNIQUE INDEX "payments_onlinePaymentIntentId_key" ON "payments"("onlinePaymentIntentId");
