-- F2 (audit 2026-10-24): DB-рівень backstop проти подвійного бронювання одного МЕХАНІКА.
-- Дзеркалить lift-констрейнт calendar_slots_no_overlap (20260904120000): той покривав лише
-- (orgId, liftId), тож механіка стерегла САМЕ app-проба (findFirst + create у $transaction на
-- READ COMMITTED), яка не ловить фантомний рядок — два concurrent createSlot бачать 0 конфліктів
-- до коміту й обидва садять того самого механіка на пересічний час. Цей другий EXCLUDE робить
-- пересічні активні слоти одного механіка фізично неможливими (23P01 → app конвертує у 409
-- err.calendar.employeeBusy). App-guard ЛИШАЄТЬСЯ (локалізоване повідомлення для очікуваної
-- гонки); constraint — backstop для будь-якого writer (зокрема offline-first sync-merge).
--
-- Семантика ідентична lift-констрейнту: для одного (orgId, employeeId) не може бути двох
-- НЕвидалених слотів з пересічними інтервалами [startAt, endAt). employeeId IS NULL → NULL != NULL
-- у EXCLUDE → слоти без механіка не блокують одне одного. Half-open range '[)' узгоджено з
-- app-overlap `startAt < end AND endAt > start` (дотик кінець-до-початку НЕ конфлікт). Статус
-- слота НЕ фільтрується (BR-CAL-004/006: AVAILABLE займає час як BOOKED), як і в lift-констрейнті.
--
-- ⚠️ ПРОД: BACKUP + перевірити відсутність наявних пересічень механіка ПЕРЕД міграцією
-- (на dev — 0, перевірено). btree_gist потрібен для рівності (=) на orgId/employeeId разом з
-- gist range-overlap (&&); його вже ставить 20260904120000, тут IF NOT EXISTS для self-containment.

CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'calendar_slots_mechanic_no_overlap') THEN
    ALTER TABLE "calendar_slots"
      ADD CONSTRAINT "calendar_slots_mechanic_no_overlap"
      EXCLUDE USING gist (
        "orgId" WITH =,
        "employeeId" WITH =,
        tsrange("startAt", "endAt", '[)') WITH &&
      )
      WHERE ("deletedAt" IS NULL AND "employeeId" IS NOT NULL);
  END IF;
END $$;
