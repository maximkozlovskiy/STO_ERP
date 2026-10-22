-- Bug #943: доповнення до 20261022120000_settlement_charge_one_per_document.
-- Та міграція не створювала індекс у базі, де вже були дублікати CHARGE (ledger незмінний,
-- прибрати їх неможливо), і обіцяла, що «наступне оновлення створить індекс». Це хибно: Prisma
-- виконує кожну міграцію один раз, а дублікати лишаються назавжди — захист BR-SETL-015 у такій
-- базі мовчки відсутній.
--
-- Тут: якщо індексу немає, створюється той самий індекс (та сама назва, ті самі колонки) з
-- додатковою межею за часом — лише для нарахувань, записаних після цієї версії. Наявні дублікати
-- лишаються як історія (їх розбирає оператор компенсуючими записами), а нові — блокуються в
-- будь-якій базі. Де індекс уже створено попередньою міграцією, нічого не змінюється.
-- Additive/idempotent.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'settlement_charge_one_per_document_uq'
  ) THEN
    CREATE UNIQUE INDEX "settlement_charge_one_per_document_uq"
      ON "settlement_transactions" ("orgId", "documentType", "documentId")
      WHERE "type" = 'CHARGE' AND "documentId" IS NOT NULL
        AND "createdAt" >= TIMESTAMP '2026-10-23 00:00:00';
  END IF;
END $$;
