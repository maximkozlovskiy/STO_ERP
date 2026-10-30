-- Надходження з виписки «Повернення від постачальника» (рішення власника 2026-10-30, TECH-DEBT (б) №48):
-- окремий тип замість оплати клієнта на постачальника; проводка SUPPLIER_PAYMENT_RETURN, як у касі.
ALTER TYPE "BankTransactionMatchType" ADD VALUE 'SUPPLIER_REFUND_IN';
