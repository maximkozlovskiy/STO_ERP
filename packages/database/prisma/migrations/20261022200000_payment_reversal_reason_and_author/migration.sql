-- Сторно безготівкової оплати (BR-PAY-024, рішення власника 2026-10-22): причина й автор сторно
-- в самій оплаті — для будь-якого сторно (каса й `POST /payments/:id/reverse`). Безготівкове
-- сторно касового рядка не має, тож `reversalCashOperationId` лишається порожнім.
-- Additive.
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "reversalReason" TEXT;
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "reversedBy" UUID;
