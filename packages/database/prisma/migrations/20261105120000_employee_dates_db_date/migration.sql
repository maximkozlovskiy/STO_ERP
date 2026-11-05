-- Дати прийому й звільнення працівника — дата без часу (TECH-DEBT (а) §8 L528(9)).
-- Зарплата (`payroll.service` `salariedWithoutWork`) порівнює їх з межами періоду; мітка часу давала
-- правильний результат, лише доки дати писались північчю UTC.
--
-- Колонки — `timestamp(3)` без поясу, значення в UTC. Дата береться КИЇВСЬКА — та, яку картка й
-- таблиця працівників показували (`fmtDate` форматує в Europe/Kyiv), а не UTC-частина мітки:
--   * північ UTC (так пише поточний код, `new Date('YYYY-MM-DD')`) — у Києві 02:00/03:00 того ж дня,
--     результат той самий, що й `::date` (на dev-базі 2026-11-05 — 44 дати прийому й 49 звільнення,
--     усі такі);
--   * київська північ (21:00/22:00 UTC попереднього дня) — до 2026-11-04 API приймав будь-який ISO
--     (`@IsDateString`, потім `optionalString`), і клієнт міг надіслати `2026-05-01T00:00:00+03:00`.
--     Голий `::date` дав би 30.04 — на день раніше, ніж бачив користувач.
-- Той самий подвійний AT TIME ZONE уже вживають звіти (`reports.service`, Bug #808).
ALTER TABLE "employees"
  ALTER COLUMN "dateOfHire" TYPE DATE -- destructive-ok: мітка часу → дата за київським часом, нічого не губиться
    USING (("dateOfHire" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Kyiv')::date,
  ALTER COLUMN "dateOfFire" TYPE DATE -- destructive-ok: те саме для дати звільнення
    USING (("dateOfFire" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Kyiv')::date;
