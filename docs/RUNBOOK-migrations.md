# RUNBOOK — міграції БД та zero-downtime індекси

> Операційний посібник для застосування Prisma-міграцій на проді (installer-модель, ПК/сервер СТО).
> Аудит стеку (Дані/Інфра) формалізував це з інлайн-коментаря однієї міграції у окремий runbook.

## Контекст: чому це важливо

Розгортання СТО ERP — **installer-модель**: міграції застосовує НЕ DBA, а
`docker compose run --rm api npx prisma migrate deploy` з `installer/scripts/{First-Run,Update}.ps1`.
Оператор інсталяції не має SQL-експертизи, тож ризиковані міграції потребують явного, задокументованого
процесу.

**Ключове обмеження Prisma:** `prisma migrate deploy` виконує кожен `migration.sql` **у транзакції**.
Тому:

- ✅ Звичайний `CREATE INDEX` працює, АЛЕ бере `ACCESS SHARE`-lock і будує **синхронно** — на великій
  таблиці (десятки тис. рядків) блокує запис на секунди-хвилини.
- ❌ `CREATE INDEX CONCURRENTLY` **НЕ можна** всередині транзакції → у звичайній міграції його НЕМАЄ.

Для малих СТО (típово одна org, помірні обсяги) синхронний `CREATE INDEX` прийнятний. Для великих
таблиць (`work_orders`, `invoices`, `stock_movements`, `settlement_transactions`, `integration_logs`)
на завантаженому проді — потрібне вікно обслуговування АБО ручний CONCURRENTLY.

---

## Стандартний потік (малі/середні інсталяції)

Нічого особливого — installer робить усе сам:

1. **Update.ps1** запускає `docker compose run --rm api npx prisma migrate deploy` ПЕРШИМ (старі
   api/web-контейнери ще працюють і обслуговують запити).
2. Якщо міграція впала → старі контейнери живі, `exit 1` (без відкату образів — нові ще не піднято).
   Additive-only міграції безпечні навіть при частковому застосуванні.
3. Далі — `stop api web` + `up -d api web` на нову версію + health-check `/api/health/live`.

**Правило міграцій цього проєкту:** тільки **additive** (нова таблиця/колонка/індекс), idempotent
(`IF NOT EXISTS`), без backfill важких даних у тій самій міграції. Так `migrate deploy` — zero-risk.

---

## Ризикова міграція: важкий `CREATE INDEX` на великій таблиці

Коли нова міграція додає індекс на таблицю, що вже має багато рядків, і синхронний lock неприйнятний.

### Варіант А — вікно обслуговування (просто, є короткий даунтайм)

1. Оголосити коротке вікно (СТО не приймає роботу / поза робочими годинами).
2. `docker compose run --rm api npx prisma migrate deploy` — індекс будується синхронно, запис
   заблоковано на час побудови (секунди-хвилини).
3. Health-check → відновити роботу.

Підходить, коли даунтайк у кілька хвилин прийнятний (більшість СТО вночі закриті).

### Варіант Б — ручний `CREATE INDEX CONCURRENTLY` (zero-downtime, складніше)

Коли даунтайм неприйнятний. Індекс будується БЕЗ блокування запису, поза транзакцією, вручну.

1. **Написати міграцію з `IF NOT EXISTS`** (звичайний `CREATE INDEX`, як завжди — Prisma запише її у
   `_prisma_migrations` як застосовану на кроці 4). Закомітити як зазвичай.
2. **ПЕРЕД деплоєм** — вручну виконати CONCURRENTLY на проді (поза Prisma), напряму в Postgres:
   ```bash
   docker compose exec postgres psql -U <user> -d sto_erp \
     -c 'CREATE INDEX CONCURRENTLY IF NOT EXISTS "my_new_idx" ON "my_table" ("orgId", "createdAt");'
   ```
   > `CONCURRENTLY` не блокує запис, але триває довше і НЕ може бути у транзакції (тому напряму, не через
   > `migrate`). Індекс SQL має ТОЧНО збігатися з тим, що у `migration.sql` (ім'я + колонки + предикат).
3. **Позначити міграцію застосованою** (Prisma не має її виконувати повторно — індекс уже є):
   ```bash
   docker compose run --rm api npx prisma migrate resolve --applied <timestamp>_<migration_name>
   ```
4. Далі `migrate deploy` пропустить цю міграцію (вже resolved); решта pending-міграцій застосуються.
   Бо `CREATE INDEX` у `migration.sql` має `IF NOT EXISTS` — навіть якщо `resolve` пропущено, повторний
   deploy не впаде (індекс уже існує), лише візьме короткий lock на `IF NOT EXISTS`-перевірку.

> **Якщо CONCURRENTLY впав посередині** (напр. дедлок) — Postgres лишає **INVALID**-індекс. Прибрати:
> `DROP INDEX CONCURRENTLY IF EXISTS "my_new_idx";` і повторити крок 2.

### Позначати ризикові міграції у коментарі

Кожна міграція з важким `CREATE INDEX` на великій таблиці МУСИТЬ нести `-- ⚠️ ПРОД:`-коментар
(взірець — `20260916130000_covering_indexes_status_createdat/migration.sql`), що вказує застосувати
CONCURRENTLY вручну на завантаженому проді. Так оператор/наступний розробник бачить ризик у самій міграції.

---

## Append-only / immutability міграції

Ledger-таблиці (`stock_movements`, `settlement_transactions`) захищені BEFORE-тригерами
(`20260917120000_append_only_immutability_triggers`). Тригери — idempotent (`DROP TRIGGER IF EXISTS`),
застосовуються звичайним `migrate deploy`. Їх існування підтверджує `schema-integrity.integration.spec`
(як GiST-EXCLUDE / partial-unique) — якщо `db push`/rebuild зі схеми їх скине, спек почервоніє.

---

## Ніколи на проді з даними

- ❌ `prisma db push` — синхронізує схему БЕЗ міграцій, ТИХО скидає manual-SQL конструкти (тригери,
  partial-unique, GIN/trgm, EXCLUDE), що не матеріалізовані у `schema.prisma`.
- ❌ `prisma migrate reset` — дропає БД.
- ❌ редагувати вже-застосований `migration.sql` (checksum-drift). Виняток: якщо правку вже вручну
  застосовано на всі середовища (як фікс тіла тригера) — `migrate deploy` checksum не перевіряє
  (лише pending за іменем), тож безпечно; але це процесний виняток, не норма.

---

## Швидка діагностика

| Симптом                                                                      | Причина / дія                                                                                   |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `migrate deploy` довго висить на `CREATE INDEX`                              | синхронна побудова на великій таблиці → вікно обслуговування або CONCURRENTLY (Варіант Б)       |
| INVALID-індекс у `\d table`                                                  | CONCURRENTLY впав → `DROP INDEX CONCURRENTLY` + повтор                                          |
| `migrate deploy` каже «migration already applied» після ручного CONCURRENTLY | очікувано (крок 3 `resolve --applied`) — не помилка                                             |
| зникли partial-unique / trgm / тригери                                       | ймовірно `db push`/rebuild — `schema-integrity.spec` це ловить; відновити з manual-SQL міграцій |
