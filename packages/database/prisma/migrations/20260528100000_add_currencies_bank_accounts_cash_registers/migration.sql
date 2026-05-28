-- AlterTable: Organisation — add logo, addresses, primary bank account
ALTER TABLE "organisations"
  ADD COLUMN "logoUrl"       TEXT,
  ADD COLUMN "legalAddress"  TEXT,
  ADD COLUMN "actualAddress" TEXT,
  ADD COLUMN "bankAccountId" UUID;

-- CreateTable: currencies
CREATE TABLE "currencies" (
    "id"                UUID          NOT NULL DEFAULT gen_random_uuid(),
    "orgId"             UUID          NOT NULL,
    "name"              TEXT          NOT NULL,
    "fullName"          TEXT,
    "internationalName" TEXT,
    "code"              TEXT          NOT NULL,
    "symbol"            TEXT,
    "syncVersion"       BIGINT        NOT NULL DEFAULT 0,
    "createdAt"         TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"         TIMESTAMP(3)  NOT NULL,
    "deletedAt"         TIMESTAMP(3),

    CONSTRAINT "currencies_pkey" PRIMARY KEY ("id")
);

-- CreateTable: exchange_rates
CREATE TABLE "exchange_rates" (
    "id"          UUID          NOT NULL DEFAULT gen_random_uuid(),
    "orgId"       UUID          NOT NULL,
    "currencyId"  UUID          NOT NULL,
    "date"        DATE          NOT NULL,
    "rate"        DECIMAL(15,2) NOT NULL,
    "coefficient" DECIMAL(15,2) NOT NULL DEFAULT 1,
    "syncVersion" BIGINT        NOT NULL DEFAULT 0,
    "createdAt"   TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3)  NOT NULL,
    "deletedAt"   TIMESTAMP(3),

    CONSTRAINT "exchange_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable: bank_accounts
CREATE TABLE "bank_accounts" (
    "id"          UUID          NOT NULL DEFAULT gen_random_uuid(),
    "orgId"       UUID          NOT NULL,
    "name"        TEXT          NOT NULL,
    "ibanUA"      TEXT          NOT NULL,
    "currencyId"  UUID          NOT NULL,
    "bankName"    TEXT,
    "branchId"    UUID,
    "mfo"         TEXT,
    "edrpou"      TEXT,
    "bankAddress" TEXT,
    "syncVersion" BIGINT        NOT NULL DEFAULT 0,
    "createdAt"   TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3)  NOT NULL,
    "deletedAt"   TIMESTAMP(3),

    CONSTRAINT "bank_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable: cash_registers
CREATE TABLE "cash_registers" (
    "id"          UUID          NOT NULL DEFAULT gen_random_uuid(),
    "orgId"       UUID          NOT NULL,
    "name"        TEXT          NOT NULL,
    "currencyId"  UUID          NOT NULL,
    "branchId"    UUID          NOT NULL,
    "syncVersion" BIGINT        NOT NULL DEFAULT 0,
    "createdAt"   TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3)  NOT NULL,
    "deletedAt"   TIMESTAMP(3),

    CONSTRAINT "cash_registers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "currencies_orgId_deletedAt_idx" ON "currencies"("orgId", "deletedAt");
CREATE INDEX "currencies_orgId_syncVersion_idx" ON "currencies"("orgId", "syncVersion");
CREATE UNIQUE INDEX "currencies_orgId_code_key" ON "currencies"("orgId", "code");

-- CreateIndex
CREATE INDEX "exchange_rates_orgId_deletedAt_idx" ON "exchange_rates"("orgId", "deletedAt");
CREATE INDEX "exchange_rates_orgId_syncVersion_idx" ON "exchange_rates"("orgId", "syncVersion");
CREATE UNIQUE INDEX "exchange_rates_orgId_currencyId_date_key" ON "exchange_rates"("orgId", "currencyId", "date");

-- CreateIndex
CREATE INDEX "bank_accounts_orgId_deletedAt_idx" ON "bank_accounts"("orgId", "deletedAt");
CREATE INDEX "bank_accounts_orgId_syncVersion_idx" ON "bank_accounts"("orgId", "syncVersion");

-- CreateIndex
CREATE INDEX "cash_registers_orgId_deletedAt_idx" ON "cash_registers"("orgId", "deletedAt");
CREATE INDEX "cash_registers_orgId_syncVersion_idx" ON "cash_registers"("orgId", "syncVersion");

-- AddForeignKey
ALTER TABLE "organisations" ADD CONSTRAINT "organisations_bankAccountId_fkey"
  FOREIGN KEY ("bankAccountId") REFERENCES "bank_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "currencies" ADD CONSTRAINT "currencies_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "exchange_rates" ADD CONSTRAINT "exchange_rates_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "exchange_rates" ADD CONSTRAINT "exchange_rates_currencyId_fkey"
  FOREIGN KEY ("currencyId") REFERENCES "currencies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_currencyId_fkey"
  FOREIGN KEY ("currencyId") REFERENCES "currencies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "garage_branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "cash_registers" ADD CONSTRAINT "cash_registers_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "cash_registers" ADD CONSTRAINT "cash_registers_currencyId_fkey"
  FOREIGN KEY ("currencyId") REFERENCES "currencies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "cash_registers" ADD CONSTRAINT "cash_registers_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "garage_branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
