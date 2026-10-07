-- Bug #794 (release-blocker): backfill DocumentNumberConfig для типів, яких бракує в наявних
-- організаціях.
--
-- `/setup/init` до цієї версії створював 8 типів нумерації з 13. Типи, додані в enum пізніше,
-- отримували лише окремі backfill-міграції (SUPPLIER_RETURN, GOOD_INTERNAL_CODE,
-- SUPPLIER_PAYMENT) — а вони відпрацьовують на момент `migrate deploy`. На ЧИСТІЙ інсталяції
-- таблиця `organisations` у цей момент порожня, організацію створює `/setup/init` уже після
-- міграцій, тож вона лишалась без цих типів. Для COMPLETION_ACT і COUNTERPARTY_AGREEMENT
-- backfill-міграцій не було взагалі.
--
-- Наслідок: `DocumentNumberService.next()` → 404 «Конфігурацію нумерації … не знайдено», і
-- не створюються товар, договір контрагента, повернення й оплата постачальнику, акт виконаних робіт.
--
-- Ця міграція ідемпотентна (NOT EXISTS по (orgId, documentType)): організаціям, які тип уже
-- мають, вона нічого не змінює — ні префікс, ні лічильник. Нові організації отримують усі
-- типи з `apps/api/src/modules/setup/document-number-defaults.ts`.
--
-- Значення збігаються з seed.ts і попередніми backfill-міграціями:
--   SUPPLIER_RETURN         'ПВП'  дата, щорічний скид
--   COMPLETION_ACT          'АВР'  дата, щорічний скид   («АКТ» зайнятий актом звірки)
--   COUNTERPARTY_AGREEMENT  'ДГ'   дата, щорічний скид
--   GOOD_INTERNAL_CODE      'T'    без дати, без скиду
--   SUPPLIER_PAYMENT        'ОПП'  дата, щорічний скид

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
    v.doc_type::"DocumentType",
    v.prefix,
    v.include_date,
    'YYYYMMDD',
    '-',
    6,
    0,
    v.reset_period::"ResetPeriod",
    NOW()
FROM organisations o
CROSS JOIN (
    VALUES
        ('SUPPLIER_RETURN', 'ПВП', true, 'YEARLY'),
        ('COMPLETION_ACT', 'АВР', true, 'YEARLY'),
        ('COUNTERPARTY_AGREEMENT', 'ДГ', true, 'YEARLY'),
        ('GOOD_INTERNAL_CODE', 'T', false, 'NEVER'),
        ('SUPPLIER_PAYMENT', 'ОПП', true, 'YEARLY')
) AS v(doc_type, prefix, include_date, reset_period)
WHERE NOT EXISTS (
    SELECT 1
    FROM document_number_configs c
    WHERE c."orgId" = o.id
      AND c."documentType" = v.doc_type::"DocumentType"
);
