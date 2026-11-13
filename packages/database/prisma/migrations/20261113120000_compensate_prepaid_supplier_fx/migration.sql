-- Компенсація хибних курсових різниць передоплати постачальнику (Bug #1054, TECH-DEBT (б) №91 б, BR-SUPPAY-019).
--
-- До `159d10adb` повна оплата валютного замовлення ДО прийому писала FX проти нульового (чи часткового)
-- нарахування: FX_LOSS на всю сплачену суму. Правильна FX замовлення визнається лише на «Отримано», тобто
-- ПІСЛЯ всіх прийомів (BR-SUPPAY-018). Тому уражене замовлення — те, де є FX-проводка, створена раніше за
-- останнє нарахування `SUPPLIER_CHARGE` замовлення (або нарахування немає зовсім).
--
-- Для кожного ураженого замовлення чиста FX (Σ FX_GAIN − Σ FX_LOSS, як BALANCE_SIGN) приводиться до тієї, яку
-- дає правило: замовлення «Отримано» й повністю сплачене (`paidAt`) — нараховано − сплачено в базовій валюті
-- (Σ SUPPLIER_CHARGE замовлення − Σ SUPPLIER_PAYMENT проведених оплат замовлення, та сама формула, що в коді);
-- інакше — 0. Різниця — ОДНА проводка FX_GAIN / FX_LOSS у базовій валюті (rate 1, без валюти — як у коді) на
-- рахунок взаєморозрахунків тієї ж FX-проводки і зміна його балансу. Журнал лише дописується: тригер
-- append-only забороняє UPDATE / DELETE `settlement_transactions`, INSERT дозволено.
-- Повторний запуск нічого не пише: після компенсації чиста FX уже дорівнює цільовій.
DO $$
DECLARE
  r RECORD;
  v_count INTEGER := 0;
BEGIN
  FOR r IN
    WITH affected AS (
      SELECT DISTINCT fx."orgId", fx."documentId" AS po_id, fx."settlementAccountId" AS account_id
      FROM "settlement_transactions" fx
      WHERE fx."documentType" = 'PurchaseOrder'
        AND fx."type" IN ('FX_GAIN', 'FX_LOSS')
        AND fx."createdAt" < COALESCE(
          (SELECT max(c."createdAt")
             FROM "settlement_transactions" c
            WHERE c."orgId" = fx."orgId"
              AND c."documentType" = 'PurchaseOrder'
              AND c."documentId" = fx."documentId"
              AND c."type" = 'SUPPLIER_CHARGE'),
          'infinity'::timestamp)
    ),
    calc AS (
      SELECT
        a."orgId",
        a.po_id,
        a.account_id,
        COALESCE((SELECT sum(CASE WHEN t."type" = 'FX_GAIN' THEN t."amountBase" ELSE -t."amountBase" END)
                    FROM "settlement_transactions" t
                   WHERE t."orgId" = a."orgId"
                     AND t."documentType" = 'PurchaseOrder'
                     AND t."documentId" = a.po_id
                     AND t."type" IN ('FX_GAIN', 'FX_LOSS')), 0) AS current_net,
        CASE
          WHEN po."status" = 'RECEIVED' AND po."paidAt" IS NOT NULL THEN
            COALESCE((SELECT sum(c."amountBase")
                        FROM "settlement_transactions" c
                       WHERE c."orgId" = a."orgId"
                         AND c."documentType" = 'PurchaseOrder'
                         AND c."documentId" = a.po_id
                         AND c."type" = 'SUPPLIER_CHARGE'), 0)
            - COALESCE((SELECT sum(p."amountBase")
                          FROM "settlement_transactions" p
                          JOIN "supplier_payments" sp ON sp."id" = p."documentId"
                         WHERE p."orgId" = a."orgId"
                           AND p."documentType" = 'SupplierPayment'
                           AND p."type" = 'SUPPLIER_PAYMENT'
                           AND sp."purchaseOrderId" = a.po_id
                           AND sp."status" = 'CONFIRMED'
                           AND sp."deletedAt" IS NULL), 0)
          ELSE 0
        END AS target_net
      FROM affected a
      JOIN "purchase_orders" po ON po."id" = a.po_id AND po."orgId" = a."orgId"
    )
    SELECT *, round(target_net - current_net, 2) AS delta
    FROM calc
    WHERE abs(target_net - current_net) >= 0.005
  LOOP
    INSERT INTO "settlement_transactions"
      ("orgId", "settlementAccountId", "type", "amount", "currencyId", "amountBase", "rateUsed",
       "documentType", "documentId", "notes", "createdAt")
    VALUES
      (r."orgId", r.account_id,
       (CASE WHEN r.delta > 0 THEN 'FX_GAIN' ELSE 'FX_LOSS' END)::"SettlementTransactionType",
       abs(r.delta), NULL, abs(r.delta), 1,
       'PurchaseOrder', r.po_id,
       'Компенсація хибної курсової різниці передоплати (Bug #1054)', now());

    UPDATE "settlement_accounts"
       SET "balance" = "balance" + r.delta,
           "updatedAt" = now(),
           "syncVersion" = "syncVersion" + 1
     WHERE "id" = r.account_id;

    v_count := v_count + 1;
  END LOOP;

  RAISE NOTICE 'Компенсовано хибних курсових різниць передоплати постачальнику: %', v_count;
END $$;
