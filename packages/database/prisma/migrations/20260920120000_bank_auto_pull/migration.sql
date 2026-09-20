-- Bank auto-pull (Фаза 4): прапор autoPullEnabled + курсор lastPulledAt на BankAccount;
-- інтервал pull Privat24 у OrganisationSettings. Ручна міграція (лише зміни фічі — schema-vs-DB
-- diff містить сторонній drift, який НЕ включаємо; див. docs sto-database).

-- AlterTable: рахунки, відмічені для auto-pull виписки + курсор вікна дат
ALTER TABLE "bank_accounts" ADD COLUMN "autoPullEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "bank_accounts" ADD COLUMN "lastPulledAt" TIMESTAMP(3);

-- AlterTable: інтервал auto-pull Privat24 (хв)
ALTER TABLE "organisation_settings" ADD COLUMN "bankStatementPollIntervalMinutes" INTEGER NOT NULL DEFAULT 60;
