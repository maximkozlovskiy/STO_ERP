-- Налаштування філії існують для КОЖНОЇ філії (рішення власника 2026-11-06, TECH-DEBT (б) №84, BR-SET-001):
-- `POST /branches` тепер створює рядок разом із філією; тут — рядки для філій, створених раніше без нього.
-- Без рядка наряди й календар вважали робочим кожен день, а онлайн-запис і звіти — пн–пт.
INSERT INTO "branch_settings" ("branchId", "orgId", "updatedAt")
SELECT b."id", b."orgId", now()
FROM "garage_branches" b
WHERE NOT EXISTS (SELECT 1 FROM "branch_settings" bs WHERE bs."branchId" = b."id");

-- Порожній перелік робочих днів заборонено (№83): наявні порожні / не-масиви — типові пн–пт, як у моделі.
UPDATE "branch_settings"
SET "workDays" = '[1,2,3,4,5]'::jsonb, "updatedAt" = now()
WHERE jsonb_typeof("workDays") <> 'array' OR "workDays" = '[]'::jsonb;
