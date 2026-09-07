-- Backfill способу оплати 'liqpay_qr' для вже-розгорнутих організацій.
-- payment-polling.processor створює Payment із method=`${gateway}_qr` (monobank_qr / liqpay_qr);
-- код мусить існувати у payment_method_configs, інакше LiqPay-оплата НЕ фіскалізується (requiresFiscal)
-- і не мапиться на дефолтний рахунок-призначення. requiresFiscal=true — дзеркалить monobank_qr.
-- Additive/idempotent (ON CONFLICT по @@unique(orgId, code)) — безпечно на розгорнутих БД.
INSERT INTO "payment_method_configs" ("orgId", "code", "name", "sortOrder", "requiresFiscal", "updatedAt")
SELECT o."id", 'liqpay_qr', 'LiqPay QR', 6, true, CURRENT_TIMESTAMP
FROM "organisations" o
ON CONFLICT ("orgId", "code") DO NOTHING;
