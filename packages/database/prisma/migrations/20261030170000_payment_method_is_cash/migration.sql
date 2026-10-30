-- Ознака «готівка» способу оплати (BR-PAY-019 за довідником, а не за кодом `cash`) — рішення власника
-- 2026-10-30, TECH-DEBT (б) п. 45. Наявним організаціям ознаку отримує системний спосіб `cash`.
ALTER TABLE "payment_method_configs" ADD COLUMN "isCash" BOOLEAN NOT NULL DEFAULT false;

UPDATE "payment_method_configs" SET "isCash" = true WHERE lower("code") = 'cash';
