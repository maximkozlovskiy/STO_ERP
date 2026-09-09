-- T5 (pre-prod аудит): додаємо @@index([orgId, syncVersion]) на 3 PULL-таблиці delta-sync.
-- sync.service робить `where orgId + syncVersion > since ORDER BY syncVersion ASC` для кожної
-- PULL-таблиці. Без композитного (orgId, syncVersion) Postgres робить index-scan по orgId +
-- in-memory sort (для payments — append-only high-volume — можливий seqscan+sort на десятках тисяч
-- рядків). Additive + idempotent — безпечно на існуючих клієнтських БД.

CREATE INDEX IF NOT EXISTS "work_order_lines_orgId_syncVersion_idx"
  ON "work_order_lines" ("orgId", "syncVersion");

CREATE INDEX IF NOT EXISTS "work_order_parts_orgId_syncVersion_idx"
  ON "work_order_parts" ("orgId", "syncVersion");

CREATE INDEX IF NOT EXISTS "payments_orgId_syncVersion_idx"
  ON "payments" ("orgId", "syncVersion");
