-- BR-PAY-021, BR-INV-018: оплата рахунку наряду — це оплата наряду, рахунок наряду — дзеркало.
--
-- До 2026-10-15 вікно «Оплатити» на сторінці рахунків слало лише "invoiceId": сплачене лежало в
-- "invoices"."paidAmount", а "work_orders"."paidAmount" лишався 0 (TECH-DEBT §10 п.9). Новий код
-- рахує все від наряду, тож без цієї міграції перша ж оплата через рахунок наряду затерла б
-- старе сплачене в рахунку, а перевірка залишку наряду прийняла б ту саму суму вдруге.
--
-- Ідемпотентно: кожен крок оновлює лише рядки, що ще не збігаються. Схема не змінюється.

-- 1. Оплатам рахунку наряду — наряд рахунку.
UPDATE "payments" AS p
SET "workOrderId" = i."workOrderId",
    "syncVersion" = p."syncVersion" + 1
FROM "invoices" AS i
WHERE p."invoiceId" = i."id"
  AND i."workOrderId" IS NOT NULL
  AND p."workOrderId" IS NULL;

-- 2. «Сплачено» наряду = сума його оплат без сторно. Наряди, де сума оплат більша за суму наряду
--    (подвійна оплата), не чіпаються — їх розбирає людина (на dev-базі 2026-10-15 таких 0).
WITH sums AS (
  SELECT "workOrderId", SUM("amount") AS paid
  FROM "payments"
  WHERE "workOrderId" IS NOT NULL
    AND "reversedAt" IS NULL
  GROUP BY "workOrderId"
)
UPDATE "work_orders" AS w
SET "paidAmount" = s.paid,
    "syncVersion" = w."syncVersion" + 1
FROM sums AS s
WHERE w."id" = s."workOrderId"
  AND s.paid <= w."totalAmount"
  AND w."paidAmount" <> s.paid;

-- 3. Повністю сплачений наряд у «Виставлено» — «Оплачено» (BR-WO-016; перехід без побічних дій).
UPDATE "work_orders"
SET "status" = 'PAID',
    "syncVersion" = "syncVersion" + 1
WHERE "status" = 'INVOICED'
  AND "deletedAt" IS NULL
  AND "totalAmount" > 0
  AND "paidAmount" >= "totalAmount";

-- 4. Рахунок наряду показує сплачене наряду: лише ПІДНЯТИ "paidAmount" (рахунки, закриті вручну
--    без оплат, не понижуються) і перерахувати статус. DRAFT і CANCELLED статус не змінюють.
UPDATE "invoices" AS i
SET "paidAmount" = LEAST(w."paidAmount", i."amount"),
    "status" = CASE
      WHEN i."status" IN ('SENT', 'PARTIALLY_PAID', 'OVERDUE')
        THEN CASE
          WHEN LEAST(w."paidAmount", i."amount") >= i."amount" THEN 'PAID'::"InvoiceStatus"
          ELSE 'PARTIALLY_PAID'::"InvoiceStatus"
        END
      ELSE i."status"
    END,
    "syncVersion" = i."syncVersion" + 1
FROM "work_orders" AS w
WHERE i."workOrderId" = w."id"
  AND i."deletedAt" IS NULL
  AND i."status" <> 'CANCELLED'
  AND LEAST(w."paidAmount", i."amount") > i."paidAmount";
