-- CAL-C1: DB-рівень backstop проти подвійного бронювання одного підйомника (Bug #444/audit).
-- App-level conflict-probe (findFirst + create у $transaction на READ COMMITTED) НЕ ловить
-- фантомний рядок: два concurrent createSlot бачать 0 конфліктів до коміту → обидва створюють
-- пересічні слоти. EXCLUDE-constraint на рівні БД робить пересічні активні слоти фізично
-- неможливими (23P01 exclusion_violation → app конвертує у 409 UA). Той самий патерн defense-
-- in-depth, що stock_*_nonneg CHECK (20260902210000). App-guard ЛИШАЄТЬСЯ (локалізоване
-- повідомлення для очікуваної гонки); constraint — backstop для будь-якого writer (зокрема
-- offline-first sync-merge).
--
-- Семантика: для одного (orgId, liftId) не може бути двох НЕвидалених слотів з пересічними
-- інтервалами [startAt, endAt). liftId IS NULL → NULL != NULL у EXCLUDE → слоти без підйомника
-- не блокують одне одного (коректно — ресурс не займається). Half-open range '[)' узгоджено з
-- app-overlap `startAt < end AND endAt > start` (дотик кінець-до-початку НЕ конфлікт).
--
-- ⚠️ ПРОД: BACKUP + перевірити відсутність наявних пересічень ПЕРЕД міграцією (на чистій dev — 0).
-- btree_gist потрібен для рівності (=) на скалярних orgId/liftId разом з gist range-overlap (&&).

CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'calendar_slots_no_overlap') THEN
    ALTER TABLE "calendar_slots"
      ADD CONSTRAINT "calendar_slots_no_overlap"
      EXCLUDE USING gist (
        "orgId" WITH =,
        "liftId" WITH =,
        tsrange("startAt", "endAt", '[)') WITH &&
      )
      WHERE ("deletedAt" IS NULL AND "liftId" IS NOT NULL);
  END IF;
END $$;
