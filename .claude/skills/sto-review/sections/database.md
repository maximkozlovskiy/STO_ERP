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
