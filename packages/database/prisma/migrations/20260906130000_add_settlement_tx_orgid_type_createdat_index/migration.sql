-- sto-optimize (pre-production release audit): covering index для
-- dashboard.getSummary "виручка сьогодні".
--
-- getSummary виконує:
--   prisma.settlementTransaction.aggregate({
--     where: { orgId, type: 'PAYMENT', createdAt: { gte: todayStart } },
--     _sum: { amount: true },
--   })
-- Ця гілка фільтрує по (orgId, type, createdAt-range) БЕЗ settlementAccountId,
-- тому існуючий (orgId, settlementAccountId, createdAt) не вибирається (leftmost-prefix
-- miss: settlementAccountId стоїть перед createdAt і не заданий), а
-- (orgId, documentType, documentId) — нерелевантний. Postgres змушений сканувати всі
-- settlement_transactions організації по orgId-префіксу й heap-фільтрувати type + createdAt.
--
-- settlement_transactions — append-only high-volume таблиця (кожен CHARGE/PAYMENT/PREPAYMENT/
-- SUPPLIER_* по всіх контрагентах). Дашборд опитується через SSE кожні 30s (сервер кешує 25s)
-- для КОЖНОГО активного користувача → при реальних обсягах (сотні тисяч транзакцій/орг) це
-- org-wide scan на кожен інтервал.
--
-- Covering (orgId, type, createdAt): type — equality (leftmost після orgId), createdAt — range
-- (tail) → single index-range scan, _sum(amount) без heap re-filter по type/createdAt.
-- Additive / idempotent — безпечно на розгорнутих БД (жодних змін даних чи схеми).

CREATE INDEX IF NOT EXISTS "settlement_transactions_orgId_type_createdAt_idx"
  ON "settlement_transactions" ("orgId", "type", "createdAt");
