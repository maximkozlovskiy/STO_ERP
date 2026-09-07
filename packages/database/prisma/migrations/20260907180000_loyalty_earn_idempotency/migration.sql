-- Idempotency EARN лояльності: один EARN на документ. Захищає від подвійного нарахування балів
-- при паралельних/повторних BullMQ-джобах (read-then-write guard у сервісі ловить лише послідовні).
-- Additive/idempotent.

-- 1. Прибрати можливі наявні дублі (від pre-fix гонки): лишаємо найраніший EARN на (accountId, documentId),
--    решту — м'яко неможливо (немає deletedAt) → фізично видаляємо зайві дублі-нарахування.
--    (Баланс НЕ коригуємо тут автоматично — рідкісний випадок; оператор звірить за журналом.)
DELETE FROM "loyalty_transactions" t
USING "loyalty_transactions" keep
WHERE t."type" = 'EARN'
  AND t."documentId" IS NOT NULL
  AND keep."type" = 'EARN'
  AND keep."documentId" = t."documentId"
  AND keep."accountId" = t."accountId"
  AND (keep."createdAt" < t."createdAt"
       OR (keep."createdAt" = t."createdAt" AND keep."id" < t."id"));

-- 2. Partial unique: один EARN на (accountId, documentId), лише для документних нарахувань.
CREATE UNIQUE INDEX IF NOT EXISTS "loyalty_earn_one_per_document_uq"
  ON "loyalty_transactions" ("accountId", "documentId")
  WHERE "type" = 'EARN' AND "documentId" IS NOT NULL;
