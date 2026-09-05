-- sto-optimize (Phase «пов'язані документи»): covering index для
-- invoices.getLinkedCounts.
--
-- getLinkedCounts робить `prisma.payment.groupBy({ by: ['invoiceId'],
-- where: { invoiceId: { in: [...до 500 id] }, orgId } })` на КОЖНУ завантажену
-- сторінку списку рахунків (колонка «Зв'язки» + вкладка «Документи»). Таблиця
-- payments мала на invoiceId лише FK-constraint — Postgres НЕ створює індекс під
-- foreign key автоматично. Через це groupBy ішов org-wide scan по (orgId, createdAt)
-- або (orgId, counterpartyId, createdAt) з per-row фільтром invoiceId IN (...),
-- тобто O(N) по всіх оплатах організації на кожен показ списку рахунків.
--
-- Додаємо покриваючий (orgId, invoiceId) → groupBy стає index-only.
-- Additive / idempotent — безпечно на розгорнутих БД (жодних змін даних/схеми).

CREATE INDEX IF NOT EXISTS "payments_orgId_invoiceId_idx"
  ON "payments" ("orgId", "invoiceId");
