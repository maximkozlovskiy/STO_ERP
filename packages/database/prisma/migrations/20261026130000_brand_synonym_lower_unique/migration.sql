-- Синонім бренду унікальний без урахування регістру серед активних (TECH-DEBT §8 «Бренди й
-- синоніми»): «Bosch» і «BOSCH» — той самий синонім. Досі це тримав лише код
-- (`brands.service.ts`), а база — повний unique (orgId, synonym) з урахуванням регістру.
-- Prisma не виражає функціональний partial-unique у @@unique → ручний індекс (як *_active_uq
-- номерів документів). Перевірено на dev-базі: 0 дублікатів за lower(synonym) серед активних.

CREATE UNIQUE INDEX IF NOT EXISTS "brand_synonyms_orgId_lower_synonym_active_uq"
  ON "brand_synonyms" ("orgId", lower("synonym")) WHERE "deletedAt" IS NULL;
