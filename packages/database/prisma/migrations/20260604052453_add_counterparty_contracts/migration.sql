-- CreateEnum
CREATE TYPE "ContractType" AS ENUM ('PURCHASE', 'SALE');

-- AlterEnum
ALTER TYPE "DocumentType" ADD VALUE 'COUNTERPARTY_AGREEMENT';

-- AlterTable
ALTER TABLE "purchase_orders" ADD COLUMN     "contractId" UUID;

-- AlterTable
ALTER TABLE "work_orders" ADD COLUMN     "contractId" UUID;

-- CreateTable
CREATE TABLE "counterparty_contracts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "counterpartyId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "contractType" "ContractType" NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "creditLimit" DECIMAL(15,2),
    "paymentDeferDays" INTEGER,
    "syncVersion" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "counterparty_contracts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "counterparty_contracts_orgId_counterpartyId_deletedAt_idx" ON "counterparty_contracts"("orgId", "counterpartyId", "deletedAt");

-- CreateIndex
CREATE INDEX "counterparty_contracts_orgId_syncVersion_idx" ON "counterparty_contracts"("orgId", "syncVersion");

-- AddForeignKey
ALTER TABLE "counterparty_contracts" ADD CONSTRAINT "counterparty_contracts_counterpartyId_fkey" FOREIGN KEY ("counterpartyId") REFERENCES "counterparties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "counterparty_contracts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "counterparty_contracts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
