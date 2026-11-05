-- Жорстке видалення тестових даних E2E/TST із DEV-бази (не для продакшену).
--
-- Корені — записи з мітками тестів у назві (`E2E` будь-де, `000 TST|PERF|OPT …`, `TST…`, `BNK<цифра>…`,
-- `TestClient`): контрагенти, склади, товари, роботи, авто, працівники, каси, способи оплати тощо.
-- Далі — все, що на них посилається (restrict / cascade), і документ цілком, якщо видаляється його рядок.
-- Організації не чіпаються. Тригери (FK, append-only) вимкнено на час транзакції
-- (`session_replication_role = replica`), тому цілісність перевіряється наприкінці: висяче посилання
-- хоч в одному FK — відкат. Поліморфні посилання (`documentId` без FK) на видалений документ крок 4б
-- прибирає: проводки — геть, баланс рахунку розрахунків — заново з проводок; у рядку каси, руху складу й
-- бонусів гроші й кількість лишаються, посилання — NULL. Крок 5б перевіряє, що грошей і складу з таким
-- посиланням не лишилось (інакше відкат). Також звіряються залишки складу (рух ↔ залишок).
--
-- Типово — ПРОБНИЙ прогін (ROLLBACK) зі звітом «таблиця → скільки рядків». Справжнє видалення — `-v commit=1`.
-- Спершу копія бази:
--   wsl -e docker exec stoerp-postgres-1 pg_dump -U sto -Fc sto_erp > /e/tmp/db-backup/sto_erp_$(date +%F).dump
--   wsl -e docker exec -i stoerp-postgres-1 psql -U sto -d sto_erp [-v commit=1] < scripts/dev/purge-e2e-data.sql
--   wsl -e docker exec stoerp-postgres-1 psql -U sto -d sto_erp -c "VACUUM ANALYZE"
\set ON_ERROR_STOP on
\set QUIET on
BEGIN;
SET LOCAL session_replication_role = replica;   -- без FK- і append-only-тригерів; цілісність перевіряємо самі наприкінці

CREATE TEMP TABLE purge (tbl text, id text, why text, PRIMARY KEY (tbl, id)) ON COMMIT DROP;

-- 1) Корені: записи з мітками тестів
DO $$
DECLARE
  re  constant text := '(e2e|^000 (TST|PERF|OPT)|^TST|^BNK[0-9]|TestClient)';
  s   record;
BEGIN
  FOR s IN SELECT * FROM (VALUES
    ('counterparties','"companyName"'), ('counterparties','"lastName"'), ('counterparties','"firstName"'),
    ('warehouses','name'), ('works','name'), ('goods','name'), ('goods','sku'),
    ('vehicles','"licensePlate"'), ('customer_garages','name'),
    ('employees','"firstName"'), ('employees','"lastName"'), ('employees','email'),
    ('auth_accounts','email'), ('payment_method_configs','name'), ('zones','name'), ('services','name'),
    ('work_categories','name'), ('garage_branches','name'), ('brands','name'), ('tax_rates','name'),
    ('units_of_measure','name'), ('lifts','name'), ('saved_reports','name'), ('pricing_rules','name'),
    ('bank_accounts','name'), ('cash_registers','name'), ('good_categories','name'), ('purchase_lists','name'),
    ('expense_categories','name'), ('supplier_connections','name'), ('vehicle_makes','name'),
    ('vehicle_models','name'), ('tasks','title'), ('employee_notifications','title'), ('automation_rules','name')
  ) AS t(tbl, expr)
  LOOP
    EXECUTE format('INSERT INTO purge SELECT %L, id::text, %L FROM %I WHERE (%s) ~* %L ON CONFLICT DO NOTHING',
                   s.tbl, 'root', s.tbl, s.expr, re);
  END LOOP;
END $$;

-- FK-и (одноколонкові; усі посилаються на "id")
CREATE TEMP TABLE fks ON COMMIT DROP AS
SELECT c.conname, c.conrelid::regclass::text AS child, ca.attname AS col,
       c.confrelid::regclass::text AS parent, pa.attname AS pcol, c.confdeltype AS act,
       EXISTS (SELECT 1 FROM pg_attribute x WHERE x.attrelid = c.conrelid AND x.attname = 'id' AND NOT x.attisdropped) AS child_has_id
FROM pg_constraint c
JOIN pg_attribute ca ON ca.attrelid = c.conrelid  AND ca.attnum = c.conkey[1]
JOIN pg_attribute pa ON pa.attrelid = c.confrelid AND pa.attnum = c.confkey[1]
WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM fks WHERE pcol <> 'id') THEN RAISE EXCEPTION 'FK не на id — скрипт не розрахований'; END IF;
END $$;

-- 2) Замикання: залежні рядки (restrict / no action / cascade) + рядок документа тягне весь документ
DO $$
DECLARE
  f record; added bigint; total bigint; pass int := 0;
  lines constant text[][] := ARRAY[
    ['work_order_lines','work_orders'], ['work_order_parts','work_orders'], ['invoice_lines','invoices'],
    ['purchase_order_lines','purchase_orders'], ['stock_document_lines','stock_documents'],
    ['supplier_return_lines','supplier_returns']];
  i int;
BEGIN
  LOOP
    pass := pass + 1; total := 0;
    FOR f IN SELECT * FROM fks WHERE act IN ('r','a','c') AND child_has_id
             AND parent IN (SELECT DISTINCT tbl FROM purge) LOOP
      EXECUTE format('INSERT INTO purge SELECT %L, c.id::text, %L FROM %I c
                      WHERE c.%I::text IN (SELECT id FROM purge WHERE tbl = %L) ON CONFLICT DO NOTHING',
                     f.child, 'dep:'||f.parent, f.child, f.col, f.parent);
      GET DIAGNOSTICS added = ROW_COUNT; total := total + added;
    END LOOP;
    FOR i IN 1 .. array_length(lines, 1) LOOP
      FOR f IN SELECT * FROM fks WHERE child = lines[i][1] AND parent = lines[i][2] LOOP
        EXECUTE format('INSERT INTO purge SELECT %L, l.%I::text, %L FROM %I l
                        WHERE l.id::text IN (SELECT id FROM purge WHERE tbl = %L) ON CONFLICT DO NOTHING',
                       f.parent, f.col, 'doc-of-line', f.child, f.child);
        GET DIAGNOSTICS added = ROW_COUNT; total := total + added;
      END LOOP;
    END LOOP;
    EXIT WHEN total = 0;
    IF pass > 50 THEN RAISE EXCEPTION 'замикання не зійшлось'; END IF;
  END LOOP;
  RAISE NOTICE 'замикання: % проходів', pass;
END $$;

-- 3) Знімок узгодженості ДО: склад (рухи ↔ залишок)
CREATE TEMP TABLE before_bad ON COMMIT DROP AS
SELECT 'stock'::text AS kind, si.id::text AS id FROM stock_items si
 WHERE si.quantity <> coalesce((SELECT sum(m.quantity) FROM stock_movements m
                                WHERE m."goodId" = si."goodId" AND m."warehouseId" = si."warehouseId"), 0);

-- Звіт: що видаляється
SELECT tbl, count(*) AS rows, count(*) FILTER (WHERE why = 'root') AS roots
FROM purge GROUP BY tbl ORDER BY 2 DESC;

-- 4) Видалення: SET NULL-посилання вручну (тригери вимкнено), далі дочірні без id, далі все з purge
DO $$
DECLARE f record; t text; n bigint;
BEGIN
  FOR f IN SELECT * FROM fks WHERE parent IN (SELECT DISTINCT tbl FROM purge) LOOP
    IF f.act = 'n' THEN
      EXECUTE format('UPDATE %I SET %I = NULL WHERE %I::text IN (SELECT id FROM purge WHERE tbl = %L)',
                     f.child, f.col, f.col, f.parent);
    ELSIF NOT f.child_has_id THEN
      EXECUTE format('DELETE FROM %I WHERE %I::text IN (SELECT id FROM purge WHERE tbl = %L)', f.child, f.col, f.parent);
      GET DIAGNOSTICS n = ROW_COUNT;
      IF n > 0 THEN RAISE NOTICE 'без id: % — %', f.child, n; END IF;
    END IF;
  END LOOP;
  FOR t IN SELECT DISTINCT tbl FROM purge LOOP
    EXECUTE format('DELETE FROM %I WHERE id::text IN (SELECT id FROM purge WHERE tbl = %L)', t, t);
  END LOOP;
END $$;

-- 4б) Поліморфні посилання на видалені документи. Документ, що потрапив у purge як залежний (наряд
-- реального клієнта з тестовим авто, товаром чи складом), лишав би проводки, рядки каси й рухи складу з
-- `documentId` без FK (2026-11-05: 818 проводок на нарядах, яких немає, на рахунках клієнтів без мітки).
-- Знаки — дзеркало `BALANCE_SIGN` (`settlements.service.ts`); тип, якого тут немає, — відкат.
CREATE TEMP TABLE balance_sign (type text PRIMARY KEY, s int) ON COMMIT DROP;
INSERT INTO balance_sign VALUES ('CHARGE',1),('PAYMENT',-1),('PREPAYMENT',-1),('REFUND',-1),('CREDIT_NOTE',-1),
  ('SUPPLIER_CHARGE',-1),('SUPPLIER_PAYMENT',1),('SUPPLIER_REFUND',1),('FX_GAIN',1),('FX_LOSS',-1),
  ('REFUND_OUT',1),('REFUND_OUT_CANCEL',-1),('SUPPLIER_PAYMENT_RETURN',-1),('PAYMENT_CANCEL',1),
  ('PREPAYMENT_CANCEL',1),('SUPPLIER_PAYMENT_CANCEL',-1),('SUPPLIER_PAYMENT_RETURN_CANCEL',1);
DO $$
DECLARE n bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM settlement_transactions t
             WHERE NOT EXISTS (SELECT 1 FROM balance_sign b WHERE b.type = t.type::text)) THEN
    RAISE EXCEPTION 'тип проводки без знака в balance_sign — оновіть дзеркало BALANCE_SIGN';
  END IF;
  CREATE TEMP TABLE gone_postings ON COMMIT DROP AS
    SELECT id, "settlementAccountId" AS acc FROM settlement_transactions
    WHERE "documentId"::text IN (SELECT id FROM purge);
  DELETE FROM settlement_transactions WHERE id IN (SELECT id FROM gone_postings);
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE NOTICE 'проводок на видалені документи: % (рахунків: %)', n, (SELECT count(DISTINCT acc) FROM gone_postings); END IF;
  -- Баланс = Σ знак × amountBase (як звіряє reconciliation.processor)
  UPDATE settlement_accounts a SET balance = coalesce((
    SELECT round(sum(b.s * coalesce(t."amountBase", t.amount)), 2) FROM settlement_transactions t
    JOIN balance_sign b ON b.type = t.type::text WHERE t."settlementAccountId" = a.id), 0)
  WHERE a.id IN (SELECT acc FROM gone_postings);
  UPDATE cash_operations SET "documentType" = NULL, "documentId" = NULL WHERE "documentId"::text IN (SELECT id FROM purge);
  UPDATE cash_operations SET "baseDocumentType" = NULL, "baseDocumentId" = NULL WHERE "baseDocumentId"::text IN (SELECT id FROM purge);
  UPDATE stock_movements SET "documentType" = NULL, "documentId" = NULL WHERE "documentId"::text IN (SELECT id FROM purge);
  UPDATE loyalty_transactions SET "documentType" = NULL, "documentId" = NULL WHERE "documentId"::text IN (SELECT id FROM purge);
END $$;

-- 5) Цілісність: жодного посилання на неіснуючий рядок
DO $$
DECLARE f record; n bigint; bad int := 0;
BEGIN
  FOR f IN SELECT * FROM fks LOOP
    EXECUTE format('SELECT count(*) FROM %I c WHERE c.%I IS NOT NULL AND NOT EXISTS (SELECT 1 FROM %I p WHERE p.id = c.%I)',
                   f.child, f.col, f.parent, f.col) INTO n;
    IF n > 0 THEN RAISE WARNING 'висяче посилання %.% → % : %', f.child, f.col, f.parent, n; bad := bad + 1; END IF;
  END LOOP;
  IF bad > 0 THEN RAISE EXCEPTION 'цілісність порушена (% FK) — відкат', bad; END IF;
  RAISE NOTICE 'цілісність FK: ок';
END $$;

-- 5б) Поліморфні посилання (`documentId` / `entityId` без FK) — їх крок 5 не бачить. Після кроку 4б
-- гроші й склад на видалений документ посилатись не мають; лишилось — відкат. Журнали, події й
-- `batch_consumptions` (`documentId` обов'язковий, кількість партії узгоджена) — лише звіт.
DO $$
DECLARE
  r record; n bigint; bad int := 0;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('settlement_transactions','documentId', true), ('stock_movements','documentId', true),
    ('cash_operations','documentId', true), ('cash_operations','baseDocumentId', true),
    ('loyalty_transactions','documentId', true), ('batch_consumptions','documentId', false),
    ('audit_events','entityId', false), ('comments','entityId', false), ('domain_events','documentId', false),
    ('employee_notifications','documentId', false), ('integration_logs','documentId', false),
    ('notification_logs','documentId', false), ('tasks','entityId', false)
  ) AS t(tbl, col, critical)
  LOOP
    EXECUTE format('SELECT count(*) FROM %I WHERE %I::text IN (SELECT id FROM purge)', r.tbl, r.col) INTO n;
    CONTINUE WHEN n = 0;
    IF r.critical THEN
      RAISE WARNING 'поліморфне посилання на видалений документ: %.% — %', r.tbl, r.col, n; bad := bad + 1;
    ELSE
      RAISE NOTICE 'журнал посилається на видалений документ: %.% — %', r.tbl, r.col, n;
    END IF;
  END LOOP;
  IF bad > 0 THEN RAISE EXCEPTION 'гроші / склад посилаються на видалені документи (% колонок) — відкат', bad; END IF;
  RAISE NOTICE 'поліморфні посилання грошей і складу: ок';
END $$;

-- 6) Узгодженість ПІСЛЯ: нові розбіжності складу (яких не було до)
SELECT kind, count(*) AS new_mismatches FROM (
  SELECT 'stock'::text AS kind, si.id::text AS id FROM stock_items si
   WHERE si.quantity <> coalesce((SELECT sum(m.quantity) FROM stock_movements m
                                  WHERE m."goodId" = si."goodId" AND m."warehouseId" = si."warehouseId"), 0)
) a WHERE (kind, id) NOT IN (SELECT kind, id FROM before_bad) GROUP BY kind;
SELECT kind, count(*) AS mismatches_before FROM before_bad GROUP BY kind;

\if :{?commit}
  COMMIT;
  \echo 'ВИДАЛЕНО (COMMIT)'
\else
  ROLLBACK;
  \echo 'ПРОБНИЙ ПРОГІН (ROLLBACK) — для видалення: -v commit=1'
\endif
