-- Дати прийому й звільнення працівника — дата без часу (TECH-DEBT (а) §8 L528(9)).
-- Зарплата (`payroll.service` `salariedWithoutWork`) порівнює їх з межами періоду; мітка часу давала
-- правильний результат, лише доки дати писались північчю UTC. Наявні значення — саме північ UTC
-- (перевірено 2026-11-05 на dev-базі: 44 дати прийому й 49 звільнення, жодна не з часом), тож `::date`
-- нічого не зсуває. Колонки — `timestamp(3)` без часового поясу, перетворення пряме.
ALTER TABLE "employees" ALTER COLUMN "dateOfHire" TYPE DATE USING "dateOfHire"::date;
ALTER TABLE "employees" ALTER COLUMN "dateOfFire" TYPE DATE USING "dateOfFire"::date;
