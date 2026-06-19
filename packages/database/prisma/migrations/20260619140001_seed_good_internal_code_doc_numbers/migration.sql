-- Backfill DocumentNumberConfig for GOOD_INTERNAL_CODE across existing orgs.
-- Postgres забороняє використовувати нове enum-значення у тій самій транзакції,
-- де воно додано (через ALTER TYPE у 20260619140000_add_good_internal_code), тому
-- INSERT винесено в окрему міграцію з пізнішим timestamp.
--
-- Конфігурація відповідає seed.ts (DocumentType.GOOD_INTERNAL_CODE):
--   prefix='T', separator='-', padding=6, includeDate=false, resetPeriod='NEVER'
--
-- Bug #533 (release-blocker): без цього backfill `POST /goods` падає на
-- DocumentNumberService.next() з NotFoundException у будь-якій існуючій org →
-- створення товару повністю заблоковане у production.

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
    'GOOD_INTERNAL_CODE'::"DocumentType",
    'T',
    false,
    'YYYYMMDD',
    '-',
    6,
    0,
    'NEVER'::"ResetPeriod",
    NOW()
FROM organisations o
WHERE NOT EXISTS (
    SELECT 1
    FROM document_number_configs c
    WHERE c."orgId" = o.id
      AND c."documentType" = 'GOOD_INTERNAL_CODE'::"DocumentType"
);
