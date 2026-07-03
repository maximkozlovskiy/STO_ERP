-- Backfill DocumentNumberConfig for SUPPLIER_PAYMENT across existing orgs.
-- Postgres забороняє використовувати нове enum-значення у тій самій транзакції,
-- де воно додано (через ALTER TYPE у 20260703100000_add_supplier_payment), тому
-- INSERT винесено в окрему міграцію з пізнішим timestamp.
--
-- Конфігурація відповідає seed.ts (DocumentType.SUPPLIER_PAYMENT):
--   prefix='ОПП', separator='-', padding=6, includeDate=true, resetPeriod='YEARLY'
--
-- Без цього backfill `POST /supplier-payments` падає на
-- DocumentNumberService.next() з NotFoundException у будь-якій існуючій org →
-- створення оплати постачальнику заблоковане.

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
    'SUPPLIER_PAYMENT'::"DocumentType",
    'ОПП',
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
      AND c."documentType" = 'SUPPLIER_PAYMENT'::"DocumentType"
);
