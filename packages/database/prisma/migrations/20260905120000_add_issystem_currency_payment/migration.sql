-- isSystem-захист для Currency та PaymentMethodConfig (audit round 3 gap): seed-записи (базова
-- валюта, стандартні методи оплати) не мали механізму блокування видалення/редагування через API
-- — на відміну від UnitOfMeasure/WorkCategory/GoodCategory. Додаємо колонку + backfill наявних
-- seed-рядків, щоб і вже-розгорнуті БД отримали захист. Code-guard у сервісах — окремо.

ALTER TABLE "currencies" ADD COLUMN IF NOT EXISTS "isSystem" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "payment_method_configs" ADD COLUMN IF NOT EXISTS "isSystem" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: базова валюта обліку (UAH) і стандартні seed-методи оплати → системні.
UPDATE "currencies" SET "isSystem" = true WHERE "code" = 'UAH';
UPDATE "payment_method_configs"
  SET "isSystem" = true
  WHERE "code" IN ('cash', 'card_terminal', 'bank_transfer', 'privat24_qr', 'monobank_qr');
