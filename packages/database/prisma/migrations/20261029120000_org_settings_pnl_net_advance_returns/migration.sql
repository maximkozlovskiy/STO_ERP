-- Звіт P&L (BR-RPT-030 п. 5): повернення підзвітних коштів (ADVANCE_RETURN) зменшує витрату, коли
-- видача під звіт (ADVANCE_ISSUE) рахується витратою. Рішення власника 2026-10-29 — налаштування.
-- Типово true: «Під звіт» у витратах типово вимкнено, тож звіт наявних організацій не змінюється.

ALTER TABLE "organisation_settings"
  ADD COLUMN "pnlNetAdvanceReturns" BOOLEAN NOT NULL DEFAULT true;
