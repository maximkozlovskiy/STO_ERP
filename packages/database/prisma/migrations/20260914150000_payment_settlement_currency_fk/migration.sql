-- Мультивалюта Фаза 2 (FK): зв'язок Payment.currencyId / SettlementTransaction.currencyId → Currency.
-- Additive: колонки вже додані міграцією 20260914140000. ON DELETE SET NULL — валюта опційна, її
-- soft-delete/видалення не має валити append-only фінансові рядки (currencyId стане NULL → base UAH).

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_currencyId_fkey"
  FOREIGN KEY ("currencyId") REFERENCES "currencies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_transactions" ADD CONSTRAINT "settlement_transactions_currencyId_fkey"
  FOREIGN KEY ("currencyId") REFERENCES "currencies"("id") ON DELETE SET NULL ON UPDATE CASCADE;
