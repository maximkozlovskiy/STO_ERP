-- Шаблони нарядів → послуги каталогу (рішення власника 2026-10-30). Шаблон зберігав лише id і
-- кількості в JSON, вибору в UI не мав; «Послуга» (services + service_works + service_goods) робить те
-- саме з цінами й виконавцем (кнопка «Послуга» в картці наряду). Кожен невидалений шаблон стає
-- послугою, шаблон позначається видаленим. Модель і таблицю шаблонів прибирає окрема міграція пізніше.
--
-- Кількість роботи в послузі — множник нормо-годин каталогу (`applyService`: normoHours × quantity),
-- а шаблон тримав саме години рядка наряду. Тому quantity = Σ годин ÷ норма роботи (2 знаки);
-- норма 0 чи сума 0 → 1. Однакові роботи / товари шаблону зводяться в один рядок (ключ — пара id).
-- Роботи й товари іншої організації, відсутні чи видалені з каталогу — відкидаються.

CREATE TEMP TABLE "_tpl_to_service" AS
SELECT t."id" AS "templateId", gen_random_uuid() AS "serviceId", t."orgId", t."name", t."lines", t."parts"
FROM "work_order_templates" t
WHERE t."deletedAt" IS NULL;

INSERT INTO "services" ("id", "orgId", "name", "description", "updatedAt")
SELECT m."serviceId", m."orgId", m."name", 'Перенесено з шаблону наряду', now()
FROM "_tpl_to_service" m;

INSERT INTO "service_works" ("serviceId", "workId", "quantity")
SELECT m."serviceId", w."id",
  COALESCE(NULLIF(round((sum(COALESCE((l ->> 'quantity')::numeric, 0)) / NULLIF(w."normoHours"::numeric, 0)), 2), 0), 1)::double precision
FROM "_tpl_to_service" m
CROSS JOIN LATERAL jsonb_array_elements(m."lines") AS l
JOIN "works" w ON w."id"::text = (l ->> 'workId') AND w."orgId" = m."orgId" AND w."deletedAt" IS NULL
GROUP BY m."serviceId", w."id", w."normoHours";

INSERT INTO "service_goods" ("serviceId", "goodId", "quantity")
SELECT m."serviceId", g."id",
  COALESCE(NULLIF(sum(COALESCE((p ->> 'quantity')::double precision, 0)), 0), 1)
FROM "_tpl_to_service" m
CROSS JOIN LATERAL jsonb_array_elements(m."parts") AS p
JOIN "goods" g ON g."id"::text = (p ->> 'goodId') AND g."orgId" = m."orgId" AND g."deletedAt" IS NULL
GROUP BY m."serviceId", g."id";

UPDATE "work_order_templates" t
SET "deletedAt" = now(), "updatedAt" = now()
FROM "_tpl_to_service" m
WHERE t."id" = m."templateId";

DROP TABLE "_tpl_to_service";
