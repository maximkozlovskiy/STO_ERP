-- Рядок банківської виписки, з якого оплату постачальнику СТВОРЕНО (BR-BANK-028). Скасування рознесення
-- сторнує лише таку оплату; прив'язану до вже проведеної — лише відв'язує (BR-BANK-039, рішення власника 2026-11-06).

-- AlterTable
ALTER TABLE "supplier_payments" ADD COLUMN     "originBankTransactionId" UUID;

-- CreateIndex
CREATE INDEX "supplier_payments_originBankTransactionId_idx" ON "supplier_payments"("originBankTransactionId");

-- AddForeignKey
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_originBankTransactionId_fkey" FOREIGN KEY ("originBankTransactionId") REFERENCES "bank_transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Наявні оплати: створена з рядка з'являється ПІСЛЯ захоплення рядка (matchedAt), а прив'язувати можна
-- лише вже проведену (BR-BANK-027) — тобто створену раніше. Ознака походження для старих записів — порядок у часі.
UPDATE "supplier_payments" sp
SET "originBankTransactionId" = bt."id"
FROM "bank_transactions" bt
WHERE bt."supplierPaymentId" = sp."id"
  AND bt."matchedType" = 'SUPPLIER_PAYMENT'
  AND bt."matchedAt" IS NOT NULL
  AND sp."createdAt" >= bt."matchedAt";
