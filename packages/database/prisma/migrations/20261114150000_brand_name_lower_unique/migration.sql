-- Назва бренду унікальна без урахування регістру серед активних (рішення власника 2026-10-30,
-- TECH-DEBT (б) №11, BR-GOOD-007): «Bosch» і «BOSCH» — той самий бренд. Як синонім
-- (20261026130000_brand_synonym_lower_unique) — ручний функціональний partial-unique (Prisma такого не виражає).
--
-- Власник просив наявні дублі спершу показати йому: якщо в організації вже є активні бренди, чиї назви
-- різняться лише регістром, міграція НЕ падає (оновлення в клієнта не зупиняється) — друкує їх і індекс не
-- створює; нові дублі однаково відхиляє код (`BrandsService`, 409 err.brand.nameExistsCaseInsensitive).
-- Dev-база 2026-11-14: 0 дублів (16 активних брендів).
DO $$
DECLARE
  dup RECORD;
  dup_count INTEGER := 0;
BEGIN
  FOR dup IN
    SELECT "orgId", lower("name") AS key, string_agg("name", ', ' ORDER BY "name") AS names
    FROM "brands"
    WHERE "deletedAt" IS NULL
    GROUP BY "orgId", lower("name")
    HAVING count(*) > 1
  LOOP
    dup_count := dup_count + 1;
    RAISE NOTICE 'Дублі назви бренду (org %): %', dup."orgId", dup.names;
  END LOOP;

  IF dup_count = 0 THEN
    CREATE UNIQUE INDEX IF NOT EXISTS "brands_orgId_lower_name_active_uq"
      ON "brands" ("orgId", lower("name")) WHERE "deletedAt" IS NULL;
  ELSE
    RAISE NOTICE 'Індекс brands_orgId_lower_name_active_uq не створено: % груп дублів — об''єднайте бренди', dup_count;
  END IF;
END $$;
