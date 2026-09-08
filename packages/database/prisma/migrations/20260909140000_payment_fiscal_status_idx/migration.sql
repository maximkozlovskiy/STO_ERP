-- Covering-індекс під головний UI-фільтр PaymentsService.findAll на сторінці /payments:
--   WHERE ("orgId", "fiscalStatus" = X) ORDER BY "createdAt" DESC
-- fiscalStatus-дропдаун — домінантний фільтр (пошук FAILED-чеків для повторної фіскалізації —
-- центральний workflow сторінки). Payment — append-only high-volume (1 рядок на грошову
-- операцію). Наявні індекси ведуть workOrderId / counterpartyId / createdAt / invoiceId, тож
-- (orgId, fiscalStatus) equality не покрита: голий (orgId, createdAt) дає createdAt-sort, але
-- fiscalStatus лишається heap-filter → org-wide scan усіх платежів орг у createdAt-порядку.
-- (orgId, fiscalStatus, createdAt): fiscalStatus equality leftmost, createdAt range/sort у tail →
-- index-range scan + готовий порядок (без external sort). fiscalStatus nullable — 'none'→IS NULL
-- гілка теж активує індекс. Additive/idempotent, deploy-safe.

CREATE INDEX IF NOT EXISTS "payments_orgId_fiscalStatus_createdAt_idx"
  ON "payments" ("orgId", "fiscalStatus", "createdAt");
