-- TD2 — переconstruction GIN/pg_trgm пошукових індексів (self-heal після schema-rebuild).
--
-- КОНТЕКСТ: trgm-індекси створювались ранніми міграціями (травень–липень 2026) через
-- `CREATE INDEX IF NOT EXISTS ... USING gin`. Якщо БД колись пройшла `prisma db push` або
-- `migrate reset`+schema-sync, ці конструкти ТИХО зникли (schema.prisma їх НЕ виражає), а
-- `_prisma_migrations` усе одно позначає ранні міграції застосованими → `migrate deploy` їх
-- НЕ переграє. Наслідок: пошук контрагентів/товарів/нарядів деградує до seq-scan, а
-- schema-integrity.integration.spec червоніє.
--
-- ЦЯ міграція — НОВА (пізніший timestamp), тож `migrate deploy` виконає її на КОЖНОМУ середовищі
-- рівно раз і відновить втрачені індекси. Idempotent (IF NOT EXISTS) → на здоровій БД no-op,
-- на дрейфованій — реконструює. Це backstop; першоджерело істини лишається у ранніх міграціях.
--
-- ⚠️ КОРІНЬ, а не лише симптом: заборона `db push`/`migrate reset` на проді — див. docs/DATABASE.md.
-- Той самий клас втрати стосується partial-unique doc-number індексів і EXCLUDE/CHECK-констрейнтів
-- (наразі присутні, бо створені пізнішими міграціями); guard-тест стежить за всіма.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Наряди: пошук за номером
CREATE INDEX IF NOT EXISTS "work_orders_number_trgm_idx"
  ON "work_orders" USING gin ("number" gin_trgm_ops);

-- Контрагенти: пошук за ім'ям / назвою / телефоном
CREATE INDEX IF NOT EXISTS "counterparties_firstName_trgm_idx"
  ON "counterparties" USING gin ("firstName" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "counterparties_lastName_trgm_idx"
  ON "counterparties" USING gin ("lastName" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "counterparties_companyName_trgm_idx"
  ON "counterparties" USING gin ("companyName" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "counterparties_phone_trgm_idx"
  ON "counterparties" USING gin ("phone" gin_trgm_ops);

-- Товари: пошук за назвою / SKU / штрихкодом
CREATE INDEX IF NOT EXISTS "goods_name_trgm_idx"
  ON "goods" USING gin ("name" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "goods_sku_trgm_idx"
  ON "goods" USING gin ("sku" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "goods_barcode_trgm_idx"
  ON "goods" USING gin ("barcode" gin_trgm_ops);
