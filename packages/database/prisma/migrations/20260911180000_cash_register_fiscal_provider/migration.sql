-- Привʼязка фіскальної каси до ПРРО-провайдера (additive, nullable — наявні каси не зачеплено).
-- AlterTable
ALTER TABLE "cash_registers" ADD COLUMN     "fiscalProvider" TEXT,
ADD COLUMN     "providerCashRegisterId" TEXT;
