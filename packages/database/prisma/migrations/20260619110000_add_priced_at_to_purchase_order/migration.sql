-- AddColumn: pricedAt to purchase_orders
ALTER TABLE "purchase_orders" ADD COLUMN "pricedAt" TIMESTAMP(3);
