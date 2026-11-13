-- Ланцюжок запису календаря (BR-CAL-019): `chainsOf` на кожне читання слотів (день, місяць, конфлікти,
-- `findSlotById`) і видалення ланцюжка (`updateMany` по `parentSlotId`) фільтрують за `parentSlotId`.
-- Без індексу (orgId, deletedAt) звужував вибірку лише до всіх живих слотів організації (review блоку 2).
CREATE INDEX "calendar_slots_orgId_parentSlotId_idx" ON "calendar_slots"("orgId", "parentSlotId");
