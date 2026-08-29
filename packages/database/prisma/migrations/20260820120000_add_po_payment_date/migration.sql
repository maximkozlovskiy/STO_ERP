-- Планова дата оплати постачальнику на документі купівлі (PurchaseOrder).
-- Редаговане поле; автозаповнюється при отриманні (RECEIVED) за формулою
-- дата_отримання + CounterpartyContract.paymentDeferDays.
ALTER TABLE "purchase_orders" ADD COLUMN "paymentDate" DATE;
