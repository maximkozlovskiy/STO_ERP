-- Компенсація хибних курсових різниць на НЕ прийнятих замовленнях постачальнику (Bug #1062, доповнює
-- `20261113120000_compensate_prepaid_supplier_fx`, BR-SUPPAY-019).
--
-- Попередня міграція шукала уражені замовлення за ознакою «FX-проводка раніша за останнє нарахування
-- `SUPPLIER_CHARGE`». ЧАСТКОВО прийняте («Частково») замовлення, повністю сплачене ПІСЛЯ часткового
-- прийому, до `159d10adb` отримало FX проти неповного нарахування (нараховано за прийнятою частиною −
-- сплачено все), і ця FX ПІЗНІША за останнє нарахування — під ознаку не підпадала. А прийом, що потім
-- переводить замовлення в «Отримано», бачить чисту FX ≠ 0 як «уже визнано» й правильну не пише.
--
-- Правило коду: FX замовлення визнається лише в статусі «Отримано» (BR-SUPPAY-012 / 018), а «Отримано» —
-- кінцевий статус. Тож для замовлення в будь-якому іншому статусі правильна чиста FX = 0. Кожна пара
-- (замовлення, рахунок взаєморозрахунків) з чистою FX ≠ 0 на такому замовленні отримує ОДНУ проводку
-- протилежного знаку на чисту суму (базова валюта, rate 1, без валюти — як у коді) і зміну балансу рахунку.
-- Журнал лише дописується (тригер append-only дозволяє INSERT). Повторний запуск нічого не пише: після
-- компенсації чиста FX уже 0.
DO $$
DECLARE
  r RECORD;
  v_count INTEGER := 0;
BEGIN
  FOR r IN
    SELECT fx."orgId", fx."documentId" AS po_id, fx."settlementAccountId" AS account_id,
           round(sum(CASE WHEN fx."type" = 'FX_GAIN' THEN fx."amountBase" ELSE -fx."amountBase" END), 2)
             AS net
      FROM "settlement_transactions" fx
      JOIN "purchase_orders" po ON po."id" = fx."documentId" AND po."orgId" = fx."orgId"
     WHERE fx."documentType" = 'PurchaseOrder'
       AND fx."type" IN ('FX_GAIN', 'FX_LOSS')
       AND po."status" <> 'RECEIVED'
     GROUP BY fx."orgId", fx."documentId", fx."settlementAccountId"
    HAVING abs(sum(CASE WHEN fx."type" = 'FX_GAIN' THEN fx."amountBase" ELSE -fx."amountBase" END)) >= 0.005
  LOOP
    INSERT INTO "settlement_transactions"
      ("orgId", "settlementAccountId", "type", "amount", "currencyId", "amountBase", "rateUsed",
       "documentType", "documentId", "notes", "createdAt")
    VALUES
      (r."orgId", r.account_id,
       (CASE WHEN r.net > 0 THEN 'FX_LOSS' ELSE 'FX_GAIN' END)::"SettlementTransactionType",
       abs(r.net), NULL, abs(r.net), 1,
       'PurchaseOrder', r.po_id,
       'Компенсація хибної курсової різниці передоплати (Bug #1054)', now());

    UPDATE "settlement_accounts"
       SET "balance" = "balance" - r.net,
           "updatedAt" = now(),
           "syncVersion" = "syncVersion" + 1
     WHERE "id" = r.account_id;

    v_count := v_count + 1;
  END LOOP;

  RAISE NOTICE 'Компенсовано курсових різниць на не прийнятих замовленнях постачальнику: %', v_count;
END $$;
