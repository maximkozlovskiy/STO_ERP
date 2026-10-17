-- Backfill DocumentNumberConfig для PURCHASE_LIST (список купівлі) у наявних організаціях.
-- Окрема міграція: нове enum-значення з 20261017120000 не можна використати в тій самій транзакції.
-- Значення збігаються з seed.ts і document-number-defaults.ts: prefix='СК', дата, щорічний скид.
-- Ідемпотентно (NOT EXISTS по (orgId, documentType)).

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
    'PURCHASE_LIST'::"DocumentType",
    'СК',
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
      AND c."documentType" = 'PURCHASE_LIST'::"DocumentType"
);
