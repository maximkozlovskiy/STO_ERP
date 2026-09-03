-- Bug-fix (разова): виправлення знаку балансу постачальника.
-- До цього receive() PO писав CHARGE(+1) постачальнику → balance ДОДАТНИЙ (наче він винен НАМ),
-- хоча ми отримали товар і винні ЙОМУ (balance має бути ВІД'ЄМНИЙ). Через це графік оплат
-- (getSchedule, фільтр balance<0) і звіт «Взаєморозрахунки» не бачили проведених PO.
--
-- Канонічне джерело знаку — BALANCE_SIGN у settlements.service.ts. CASE нижче — застигла копія
-- на момент міграції (SUPPLIER_CHARGE:-1, SUPPLIER_PAYMENT/REFUND:+1, CHARGE:+1, решта:-1).
-- Ідемпотентно: re-typing по строгих documentType, recompute = детермінований Σ signed(tx).

-- Частина А — перекласифікація історичних постачальницьких транзакцій (лише type;
-- amount/documentId недоторкані). Клієнтські (documentType='WorkOrder'/'Payment') НЕ чіпаються.
UPDATE "settlement_transactions" SET "type" = 'SUPPLIER_CHARGE'
  WHERE "type" = 'CHARGE'  AND "documentType" = 'PurchaseOrder';
UPDATE "settlement_transactions" SET "type" = 'SUPPLIER_PAYMENT'
  WHERE "type" = 'PAYMENT' AND "documentType" = 'SupplierPayment';
UPDATE "settlement_transactions" SET "type" = 'SUPPLIER_REFUND'
  WHERE "type" = 'REFUND'  AND "documentType" = 'SupplierReturn';

-- Частина Б — перерахунок balance = Σ signed(tx) для ВСІХ акаунтів (самолікує дрейф).
-- Клієнтські баланси не зсуваються (їх txs не re-typed → та сама сума). Постачальницькі
-- стають від'ємними → з'являються у графіку оплат. syncVersion++ для офлайн-реплік.
UPDATE "settlement_accounts" sa SET
  "balance" = COALESCE((
    SELECT SUM(CASE st."type"
      WHEN 'CHARGE'           THEN  st."amount"
      WHEN 'SUPPLIER_PAYMENT' THEN  st."amount"
      WHEN 'SUPPLIER_REFUND'  THEN  st."amount"
      ELSE -st."amount"  -- PAYMENT, REFUND, PREPAYMENT, CREDIT_NOTE, SUPPLIER_CHARGE
    END)
    FROM "settlement_transactions" st
    WHERE st."settlementAccountId" = sa."id"
  ), 0),
  "syncVersion" = "syncVersion" + 1;
