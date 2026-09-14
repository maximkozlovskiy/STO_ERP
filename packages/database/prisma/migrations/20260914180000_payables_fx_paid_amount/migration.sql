-- Payables FX (мультивалюта Фаза 5): відстеження оплати PO (вісь ОПЛАТИ, окрема від status=прийом).
-- paidAmount — сукупні проведені оплати у валюті PO; paidAt — дата першої повної оплати (тригер realized FX).
-- Additive. НЕ пише жодного SettlementTransaction → historical PO ніколи не отримують FX (FX лише проспективно).

-- AlterTable
ALTER TABLE "purchase_orders" ADD COLUMN "paidAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "purchase_orders" ADD COLUMN "paidAt" DATE;

-- Backfill paidAmount = Σ проведених (CONFIRMED, не видалених) SupplierPayment.amount по PO.
-- Суми у доку-валюті SP; historically валютний guard SP==PO не існував → mixed-currency legacy може бути
-- трохи неточним (прийнятно для відображення; FX не бекфілиться).
UPDATE "purchase_orders" po SET "paidAmount" = COALESCE((
  SELECT SUM(sp."amount") FROM "supplier_payments" sp
  WHERE sp."purchaseOrderId" = po."id" AND sp."status" = 'CONFIRMED' AND sp."deletedAt" IS NULL
), 0);

-- Backfill paidAt = дата оновлення для вже повністю сплачених PO (точна історична дата невідома — best-effort).
UPDATE "purchase_orders" po SET "paidAt" = po."updatedAt"::date
WHERE po."totalAmount" > 0 AND po."paidAmount" >= po."totalAmount" - 0.005;
