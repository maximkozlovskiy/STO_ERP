# sto-review — секція: База даних і sync-готовність (§6, §9)

> Частина скіла `sto-review`. Алгоритм і матриця «тип зміни → секції» — у `../SKILL.md`.
> Читати цілком, коли матриця призначила хоч один § цього файла.
> Реальні випадки з детекторами: `../journal/database.md` (шукати, не читати цілком).

### §6 Database

```bash
# N+1 — findMany без include + подальший цикл (для кожного — перевірити prisma виклик всередині циклу)
grep -rn "for.*of\|forEach\|\.map(" apps/api/src/modules/ --include="*.service.ts" | grep -v spec | head -20
# include: true замість select — тягне всі колонки
grep -rn "include:.*true\b" apps/api/src/modules/ --include="*.service.ts" | grep -v "spec\|//.*include" | head -15
# Raw SQL без LIMIT або snake_case ідентифікатори
grep -rn "queryRaw\|executeRaw" apps/api/src --include="*.ts" | grep -v spec
grep -rn "queryRaw\|executeRaw" apps/api/src --include="*.ts" -A 20 \
  | grep -E "org_id|deleted_at|created_at|updated_at|good_id|warehouse_id|min_stock" | head -10
# FK без @@index
grep -rn "@db.Uuid" packages/database/prisma/schema/*.prisma | grep -v "id\s\|@@index\|@@unique"
# schema.prisma змінено але міграція НЕ додана (Critical: schema ≠ DB)
if git diff HEAD~10 --name-only 2>/dev/null | grep -qE "prisma/schema/.*[.]prisma"; then
  echo "schema.prisma змінено — перевір нову папку у migrations/:"
  git log --oneline -10 --name-only | grep -E "prisma/schema/|migrations/" | head
fi
# Нове enum-значення у schema (ADD VALUE) — звірити з міграцією
git diff HEAD~10 -- packages/database/prisma/schema/*.prisma 2>/dev/null | grep -E "^\+\s+[A-Z_]+$"
grep -rn "ALTER TYPE.*ADD VALUE" packages/database/prisma/migrations/ | tail -5
```

- [ ] **Будь-яка зміна `schema.prisma` (enum value, поле, модель) → супутня папка у `migrations/`** — інакше schema ≠ DB, runtime error при insert/select нового значення
- [ ] Нове enum-значення → `ALTER TYPE "Enum" ADD VALUE IF NOT EXISTS 'X';` (окремий файл; Postgres не дозволяє ADD VALUE + use у одній транзакції)
- [ ] Немає N+1: `include` або окремий `findMany({ where: { id: { in: [...] } } })`
- [ ] `include: { vehicle: true }` → `include: { vehicle: { select: { make, model, licensePlate } } }`
- [ ] `$queryRaw` → LIMIT N у SQL (Prisma `take:` не впливає)
- [ ] Raw SQL ідентифікатори — camelCase у лапках: `"orgId"`, `"deletedAt"` (не `org_id`)
- [ ] Кожне нове FK поле → `@@index([orgId, fkId])`
- [ ] `@@index([orgId, syncVersion])` для sync-ready таблиць
- [ ] `prisma.$transaction` при зміні ≥ 2 таблиць
- [ ] **Новий `EXISTS`/`NOT EXISTS`/JOIN у `$queryRaw` → `EXPLAIN` на dev-БД (лише читання) і індекс під колонку пошуку.** Таблиця-знімок, що росте з кожним документом, без індексу дає `Seq Scan` на кожен зовнішній рядок; план видно одразу, тести (навіть integration) його не бачать (`journal/database.md`, 2026-10-08)
- [ ] **`getLinkedCounts` liveness == detail** (Bug #A/#641): count пов'язаних сутностей мусить gate FK на живості (`findMany` живих реф-id + `Set`-membership), бо парний `getLinkedDocuments` фільтрує `deletedAt:null`; безумовне `? 1 : 0` / `= 1` розсинхронить badge з панеллю коли реф soft-deleted (FK `ON DELETE SET NULL` не спрацьовує на soft-delete). Grep: `grep -rn "getLinkedCounts" apps/api/src/modules --include="*.service.ts"`
- [ ] **Append-only immutability тригер із частковим винятком (одноразовий field-set) → порівнюй ЦІЛИЙ рядок через `to_jsonb`, НЕ перелік колонок.** `stock_movements`-тригер дозволяє UPDATE лише коли змінився виключно `batchId` (NULL→value). ❌ ручний перелік `NEW."col" IS NOT DISTINCT FROM OLD."col"` пропускає БУДЬ-ЯКУ невключену колонку (`price`/`notes`/`createdBy`/`unitOfMeasureId` + майбутні) разом із дозволеним полем → ledger-money-поле `price` стає мутабельним. ✅ `(to_jsonb(NEW) - 'batchId') = (to_jsonb(OLD) - 'batchId')` (core PG, авто-покриває нові колонки). Behavioral-spec МУСИТЬ мати кейс «дозволене-поле set РАЗОМ зі зміною іншої колонки → reject». Правка тіла тригера у застосованій міграції → Prisma не переприкладе → переприклади функцію на dev-БД вручну. Grep: `grep -rn "IS NOT DISTINCT FROM OLD" packages/database/prisma/migrations --include="*.sql"` → кожен тригер-виняток перевір на повноту переліку/наявність to_jsonb. Severity: IMPORTANT (ledger integrity)
- [ ] **`orderBy: { createdAt }` для дочірніх рядків документа (рядки наряду, запчастини) НЕ дає порядку введення.** Рядки, створені разом із документом, вставляються в одній транзакції, а `now()` у Postgres — час її початку: `createdAt` у них однаковий. Додатковий ключ `id` (`gen_random_uuid()`) робить порядок сталим, але випадковим — друк і екран із різними `orderBy` показують рядки по-різному. Порядок введення тримає лише явна колонка позиції. Grep: `grep -rnE "orderBy: (\[\{ createdAt: 'asc' \}, \{ id: 'asc' \}\]|\{ createdAt: 'asc' \})" apps/api/src/modules --include="*.service.ts" | grep -v spec` → для одного агрегату всі читання рядків мають однаковий `orderBy` (`journal/database.md`, 2026-10-09)
- [ ] **`{ equals: x, mode: 'insensitive' }` — це `ILIKE` без екранування: `_` і `%` у значенні користувача працюють як шаблон.** Перевірка унікальності чи пошук «точно таке саме без регістру» дає хибний збіг («A_C» = «AXC», «%» = будь-що). Екранувати самому (`value.replace(/[\\%_]/g, '\\$&')`) і вирішувати збіг ключем у JS. Grep: `grep -rn -B3 "mode: 'insensitive'" apps/api/src --include="*.ts" | grep -v spec | grep "equals"` → кожне місце зі значенням від користувача (`journal/database.md`, 2026-10-12)
- [ ] **Рукописний індекс чи обмеження в міграції (`CREATE UNIQUE INDEX … WHERE`, GIN, EXCLUDE, CHECK) → рядок у `apps/api/src/prisma/schema-integrity.integration.spec.ts`.** Сторож дрейфу вважає `DROP INDEX` шумом і відсилає саме до цього спеку; індекс, якого там немає, зникне після `db push` непомітно, а з ним — захист від гонки. Grep: `git diff <base> -- packages/database/prisma/migrations | grep -E "^\+CREATE (UNIQUE )?INDEX|^\+.*ADD CONSTRAINT"` → кожна назва є в спеку (`journal/database.md`, 2026-10-14)
- [ ] **`{ not: X }` на nullable-колонці (`workOrderId`, `employeeId`, `liftId`) відкидає й NULL** — Prisma
      дає SQL `<> $1`. «Усі, крім власних записів наряду» без `OR: [{ col: null }, { col: { not } }]`
      мовчки виключає записи без наряду: попередження картки наряду про зайнятий підйомник мовчало,
      а збереження відмовляло 400. Тест — на сховищі, що виконує `where` (`matchesWhere`), із рядком
      `col: null`. Grep: `grep -rnE "[a-zA-Z]+Id: \{ not: [a-zA-Z.]+ \}" apps/api/src/modules --include="*.ts" | grep -v spec`
      → для кожного nullable-поля — гілка NULL (`journal/database.md`, 2026-10-16)
- [ ] **Правило унікальності «перевірив → записав» без блокування — гонка.** Два одночасні збереження обидва проходять перевірку; `createMany skipDuplicates` після неї ховає програш мовчки. Перевірку й запис — в одну `$transaction` під `pg_advisory_xact_lock(hashtext('<агрегат>:<orgId>'))` (взірець: `BrandsService.underWritingsLock`, `payroll`). Перевіряти ВСІ писачі: create, update, restore, імпорт (`journal/database.md`, 2026-10-12)
- [ ] **Нова колонка в моделі, чий змаплений DTO кешується в Redis (`settings:org:<id>`) → ключ кешу
      мусить змінитись разом зі схемою.** Інакше після оновлення до кінця TTL читається старий об'єкт без
      нового поля (`supplierOfferTtlMinutes` undefined → 400). Взірець — `schemaFingerprint(Prisma.<Model>ScalarFieldEnum)`
      у ключі (`settings.service.ts`). Grep: `grep -rn "redis.set(" apps/api/src --include="*.ts" | grep -v spec`
      → для кожного кешу DTO моделі ключ несе відбиток полів (`journal/database.md`, 2026-10-18)
- [ ] **Новий стан батька «приховує» дочірні записи фільтром у коді (`OF_LIVE_WORK_ORDER`, `status: { not: X }`),
      а таблиця має EXCLUDE/UNIQUE `WHERE "deletedAt" IS NULL` → бекфіл-міграція старих рядків + заборона
      створювати/прив'язувати нові до такого батька.** Фільтр бачать `findSlots` і перевірка зайнятості, а
      констрейнт, онлайн-запис, звіти й sync — ні: невидимий рядок тримає ресурс (409 на «вільному» підйомнику).
      Grep: `git diff <base> -- apps/api/src | grep -nE "^\+.*status: \{ not:"` → для кожного фільтра
      звірити `pg_constraint` таблиці й інших читачів (`journal/database.md`, 2026-10-18)

- [ ] **Сирий SQL з `GROUP BY ROLLUP/CUBE/GROUPING SETS` + `LIMIT` → `ORDER BY` рівня перед LIMIT; агрегат БЕЗ `GROUP BY` → `HAVING COUNT(*) > 0`, якщо порожня вибірка має дати 0 рядків.**
      Хешований ROLLUP (`MixedAggregate`) віддає рядки довільно: LIMIT на перевищенні ліміту відрізав
      «Разом» (rowCount 0) і батьківські групи (діти-сироти мовчки зникали). Агрегат без GROUP BY завжди
      дає рядок — склеювання лише сум над порожньою вибіркою показувало «0 · склеєно 0». Grep:
      `grep -rn "ROLLUP\|GROUPING SETS\|CUBE (" apps/api/src --include="*.ts" | grep -v spec` → поруч
      `ORDER BY GROUPING(…) DESC` до `LIMIT` (`journal/database.md`, 2026-10-25)

---

### §9 Sync Readiness

```bash
grep -n "model " packages/database/prisma/schema/*.prisma | grep -v "//"
# Для кожної нової моделі — перевірити syncVersion BigInt
```

- [ ] Нові таблиці → `PULL_TABLES` або обґрунтовано виключені
- [ ] Push-безпечні → `PUSH_SAFE_TABLES` + `PUSH_FIELD_WHITELIST`
- [ ] PII у `PULL_FIELD_BLACKLIST` (phone, edrpou, email)

---
