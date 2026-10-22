-- BR-WO-031 (рішення власника 2026-10-22): скасування наряду скасовує його рахунок і гасить гарантію
-- без звернення — у тій самій транзакції. Наряди, скасовані до цього правила (з «Виконано»), могли
-- лишити живий рахунок (overdue-процесор міг зробити його «Простроченим») і дійсну гарантію, на яку
-- приймалось звернення (Bug #945). Одноразове виправлення тих самих наслідків для старих даних.
--
-- Проводок немає: рахунок наряду власного CHARGE не має (борг — на наряді, його сторнувало
-- скасування наряду). Ідемпотентно: кожен крок чіпає лише рядки, що ще не виправлені. Схема не
-- змінюється.

-- 1. Живий рахунок скасованого наряду — «Скасовано» (як `transition` наряду в CANCELLED).
UPDATE "invoices" AS i
SET "status" = 'CANCELLED',
    "updatedAt" = now(),
    "syncVersion" = i."syncVersion" + 1
FROM "work_orders" AS w
WHERE i."workOrderId" = w."id"
  AND w."status" = 'CANCELLED'
  AND i."deletedAt" IS NULL
  AND i."status" IN ('DRAFT', 'SENT', 'PARTIALLY_PAID', 'OVERDUE');

-- 2. Гарантія скасованого наряду без звернення — видалена (звернена лишається як історія).
UPDATE "warranties" AS g
SET "deletedAt" = now(),
    "updatedAt" = now(),
    "syncVersion" = g."syncVersion" + 1
FROM "work_orders" AS w
WHERE g."workOrderId" = w."id"
  AND w."status" = 'CANCELLED'
  AND g."deletedAt" IS NULL
  AND g."claimedAt" IS NULL;
