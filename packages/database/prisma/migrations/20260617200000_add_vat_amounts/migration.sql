-- Add totalVat to work_orders
ALTER TABLE "work_orders" ADD COLUMN "totalVat" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- Add totalVat to purchase_orders
ALTER TABLE "purchase_orders" ADD COLUMN "totalVat" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- Add vatRate and vatAmount to purchase_order_lines
ALTER TABLE "purchase_order_lines" ADD COLUMN "vatRate" DECIMAL(5,2) NOT NULL DEFAULT 0;
ALTER TABLE "purchase_order_lines" ADD COLUMN "vatAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;
