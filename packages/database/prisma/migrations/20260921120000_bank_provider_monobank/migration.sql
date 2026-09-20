-- Multi-bank + monobank statement API: BankAccount.provider (код банку-провайдера auto-pull) +
-- BankTransactionSource.MONOBANK_API. Ручна міграція (лише зміни фічі — schema-vs-DB diff містить
-- сторонній drift, який НЕ включаємо; див. docs sto-database).

-- AlterEnum: нове джерело auto-pull (monobank). ADD VALUE першим (не використовується у цій міграції).
ALTER TYPE "BankTransactionSource" ADD VALUE 'MONOBANK_API';

-- AlterTable: код банку-провайдера цього рахунку для auto-pull (multi-bank per-account провайдер).
ALTER TABLE "bank_accounts" ADD COLUMN "provider" TEXT;
