-- Одне нарахування (CHARGE) на документ у взаєморозрахунках — захист на рівні бази.
-- Наряд нараховує борг один раз («Виконано»: з COMPLETED шлях лише в INVOICED / CANCELLED), рахунок
-- без наряду — один раз (DRAFT → SENT). Досі це тримали лише claim-и статусу в коді; паралельний
-- чи повторний виклик в обхід них записав би борг клієнта двічі. SUPPLIER_CHARGE не входить:
-- закупівля нараховує на кожне часткове надходження.
-- Additive/idempotent.
--
-- Ledger незмінний (тригер trg_settlement_transactions_immutable): наявні дублі прибрати
-- неможливо й не можна. Тому індекс створюється, лише коли дублів немає; інакше міграція не
-- падає (оновлення в клієнта не зупиняється), а пише попередження — дублі розбирає оператор
-- компенсуючими записами, після чого наступне оновлення створить індекс (IF NOT EXISTS).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "settlement_transactions"
    WHERE "type" = 'CHARGE' AND "documentId" IS NOT NULL
    GROUP BY "orgId", "documentType", "documentId"
    HAVING count(*) > 1
  ) THEN
    RAISE WARNING 'settlement_transactions: є документи з кількома CHARGE — індекс settlement_charge_one_per_document_uq не створено';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS "settlement_charge_one_per_document_uq"
      ON "settlement_transactions" ("orgId", "documentType", "documentId")
      WHERE "type" = 'CHARGE' AND "documentId" IS NOT NULL;
  END IF;
END $$;
