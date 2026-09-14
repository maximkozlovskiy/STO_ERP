# DATABASE — дисципліна міграцій і захист manual-SQL конструктів

> Джерело істини для роботи зі схемою БД. Читати перед будь-якою зміною `schema.prisma`,
> міграцій або перед деплоєм. Пов'язано: [GAPS.md](GAPS.md) TD2, `/sto-database` SKILL.

---

## ⛔ ЗАБОРОНА `prisma db push` та `migrate reset` на будь-якій БД з даними

**Ніколи** не виконувати проти dev-shared / staging / prod:

```
prisma db push          # ❌ синхронізує БД зі schema.prisma БЕЗ міграцій
prisma migrate reset    # ❌ дропає й перестворює всю схему зі schema.prisma
```

**Чому це небезпечно.** `schema.prisma` описує НЕ всю схему. Низка конструктів існує лише у
raw-SQL міграціях, бо Prisma їх не виражає. `db push`/`reset` перебудовують БД **зі schema.prisma**
→ ці конструкти **тихо зникають**, а `_prisma_migrations` продовжує позначати відповідні міграції
застосованими → `migrate deploy` їх **не переграє**. Дрейф лишається невидимим для Prisma-introspection.

**Реальний інцидент (TD2, 2026-09-14):** на dev-БД усі GIN/pg_trgm пошукові індекси були відсутні,
хоча всі 6 trgm-міграцій позначені `finished`. Причина — колишній rebuild зі схеми. Пошук
контрагентів/товарів/нарядів тихо деградував до seq-scan. Виявлено guard-тестом (нижче), полагоджено
міграцією `20260914200000_td2_reensure_trgm_indexes`.

**Правильний робочий цикл:**

```
# 1. Змінити schema.prisma
# 2. Згенерувати міграцію (dev):
DATABASE_URL=... npx prisma migrate dev --name <опис>
# 3. Для raw-SQL конструктів — дописати SQL у згенерований migration.sql ВРУЧНУ (IF NOT EXISTS)
# 4. Деплой (staging/prod):
DATABASE_URL=... npx prisma migrate deploy
```

Локальний throwaway (порожня одноразова БД без даних) — `db push` прийнятний лише там.

---

## Конструкти, яких `schema.prisma` НЕ виражає (manual-SQL only)

Усе нижче живе **виключно** у raw-SQL міграціях. При додаванні нового — обов'язково внести до
guard-тесту `apps/api/src/prisma/schema-integrity.integration.spec.ts`.

### 1. Partial-unique індекси (`CREATE UNIQUE INDEX ... WHERE ...`)

Prisma `@@unique` — тільки безумовний. Часткові індекси (унікальність серед АКТИВНИХ рядків) — вручну.

| Індекс                                          | Інваріант                                                         |
| ----------------------------------------------- | ----------------------------------------------------------------- |
| `work_orders_orgId_number_active_uq`            | № наряду унікальний серед активних (фіскальна вимога UA)          |
| `invoices_orgId_number_active_uq`               | № рахунку унікальний серед активних                               |
| `purchase_orders_orgId_number_active_uq`        | № замовлення постачальнику унікальний серед активних              |
| `stock_documents_orgId_number_active_uq`        | № складського документа унікальний серед активних                 |
| `supplier_returns_orgId_number_active_uq`       | № повернення постачальнику унікальний серед активних              |
| `supplier_payments_orgId_number_active_uq`      | № оплати постачальнику унікальний серед активних                  |
| `counterparty_contracts_orgId_number_active_uq` | № договору контрагента унікальний серед активних                  |
| `completion_acts_orgId_number_active_uq`        | № акту виконаних робіт унікальний серед активних                  |
| `warehouses_orgId_isMain_unique`                | не більше одного головного складу на org (`WHERE isMain AND ...`) |
| `cash_shifts_one_open_per_register_uq`          | не більше однієї відкритої касової зміни на касу (`WHERE OPEN`)   |
| `loyalty_earn_one_per_document_uq`              | idempotency нарахування балів (`WHERE type='EARN'`)               |

> Усі — з predicate `WHERE "deletedAt" IS NULL` (крім спец-умов вище), щоб soft-delete звільняв номер.
> Втрата будь-якого doc-number індексу = дублі фіскальних номерів = юридична проблема для UA-звітності.

### 2. GIN / pg_trgm пошукові індекси

Розширення `pg_trgm` + GIN-індекси на: `work_orders.number`, `counterparties.firstName/lastName/companyName/phone`,
`goods.name/sku/barcode`. Prisma не виражає GIN/опкласи. Втрата → пошук деградує до seq-scan.

### 3. GiST EXCLUDE-констрейнт (антидубль бронювання)

`calendar_slots_no_overlap` + розширення `btree_gist`: фізично унеможливлює пересічні активні слоти
одного підйомника (backstop проти подвійного бронювання поза app-guard, зокрема offline-sync merge).

### 4. CHECK-констрейнти

`stock_items_quantity_nonneg`, `stock_batches_remaining_nonneg` — незмінний від'ємний залишок неможливий.

---

## Guard-тест — детектор дрейфу

`apps/api/src/prisma/schema-integrity.integration.spec.ts` (інтеграційний, проти живої dev-БД;
SKIP без БД — не фейлить CI без docker). Асертить наявність УСІХ конструктів вище:

- partial-unique / EXCLUDE / CHECK — по канонічному імені (`pg_indexes` / `pg_constraint`);
- doc-number індекси — додатково перевіряє що вони справді ЧАСТКОВІ (`indpred` містить `deletedAt`);
- trgm — семантично (GIN + `gin_trgm_ops` на потрібній колонці через `indexdef`), не за крихким іменем;
- розширення `pg_trgm` + `btree_gist`.

Червоніє щойно будь-який конструкт зник із живої БД → перша лінія оборони проти прихованого дрейфу.
**При додаванні нового manual-SQL конструкту — розширити цей тест у тому ж коміті.**

---

## Мандаторний field-pattern (кожна модель)

```prisma
id          String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
orgId       String    @db.Uuid
createdAt   DateTime  @default(now())
updatedAt   DateTime  @updatedAt
deletedAt   DateTime?
syncVersion BigInt    @default(0)
```

Виняток (append-only, БЕЗ `deletedAt`): `StockMovement`, `SettlementTransaction`, `Payment`,
`WorkOrderLineEmployee`, `SettlementAccount`. Деталі — `/sto-database` SKILL.

## Enum-міграції

Postgres не може використати нове значення enum у тій самій транзакції, де воно додане. Нове
значення enum — окремою міграцією `ALTER TYPE ... ADD VALUE IF NOT EXISTS`, потім у наступній —
код що його використовує. Дзеркала enum (BALANCE_SIGN, shared labels, report-registry, pdf.service,
frontend color/label maps, invariants spec) оновлювати синхронно.
