-- Backfill DocumentNumberConfig for SUPPLIER_RETURN across existing orgs.
-- Postgres забороняє використовувати нове enum-значення у тій самій транзакції,
-- де воно додано (через ALTER TYPE), тому INSERT винесено в окрему міграцію
-- з пізнішим timestamp.
--
-- Конфігурація відповідає seed.ts:
--   prefix='ПВП', separator='-', padding=6, includeDate=true, resetPeriod='YEARLY'

INSERT INTO document_number_configs (
    "id",
    "orgId",
    "documentType",
    "prefix",
    "includeDate",
    "dateFormat",
    "separator",
    "padding",
    "currentSeq",
    "resetPeriod",
    "updatedAt"
)
SELECT
    gen_random_uuid(),
    o.id,
    'SUPPLIER_RETURN'::"DocumentType",
    'ПВП',
    true,
    'YYYYMMDD',
    '-',
    6,
    0,
    'YEARLY'::"ResetPeriod",
    NOW()
FROM organisations o
WHERE NOT EXISTS (
    SELECT 1
    FROM document_number_configs c
    WHERE c."orgId" = o.id
      AND c."documentType" = 'SUPPLIER_RETURN'::"DocumentType"
);
