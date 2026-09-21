-- sto-optimize (2026-09-21): covering index для дефолтного виду табу «Банк-транзакції» — «Усі».
-- Status-pill за замовчуванням порожній → list() будує where БЕЗ status:
--   WHERE ("orgId" = $1 AND "deletedAt" IS NULL) ORDER BY "operationDate" DESC LIMIT/OFFSET.
-- Наявний (orgId, status, deletedAt, operationDate) має status 2-ю колонкою → без status-рівності
-- leftmost-prefix обривається на orgId, а operationDate-сорт не покривається (scan усіх status-бакетів
-- + external sort). (orgId, operationDate) не має deletedAt → heap-filter м'яких видалень.
-- Covering (orgId, deletedAt, operationDate): deletedAt-рівність (IS NULL) leftmost після orgId,
-- operationDate у tail → index-range scan з готовим DESC-порядком без sort-node. Additive, zero-risk.
CREATE INDEX IF NOT EXISTS "bank_transactions_orgId_deletedAt_operationDate_idx"
  ON "bank_transactions"("orgId", "deletedAt", "operationDate");
