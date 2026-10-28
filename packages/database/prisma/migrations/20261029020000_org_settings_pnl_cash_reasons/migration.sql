-- Звіт P&L (BR-RPT-030): налаштування організації — які операції каси зі статтею рахуються
-- «іншим доходом» і витратою, і чи попереджати про нерозраховану зарплату в майбутніх місяцях
-- (рішення власника 2026-10-29). Типові значення = поведінка до налаштувань, тож звіт для
-- наявних організацій не змінюється.

ALTER TABLE "organisation_settings"
  ADD COLUMN "pnlIncomeCashReasons" "CashOperationReason"[] NOT NULL DEFAULT ARRAY['MANUAL_IN']::"CashOperationReason"[],
  ADD COLUMN "pnlExpenseCashReasons" "CashOperationReason"[] NOT NULL DEFAULT ARRAY['EXPENSE']::"CashOperationReason"[],
  ADD COLUMN "pnlWarnFuturePayroll" BOOLEAN NOT NULL DEFAULT false;
