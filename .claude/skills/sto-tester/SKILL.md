---
name: sto-tester
description: >
  Тестувальник STO ERP. Знаходить баги в бек- і фронт-частині, фіксує їх у BUG_REPORT.md,
  після чого автоматично виправляє кожен баг. Враховує бізнес-логіку: FSM нарядів,
  резервування запчастин, розрахунки балансів, tenant isolation, soft delete.
  Запускай командою /sto-tester після реалізації фічі або перед релізом.
model: claude-opus-4-7
bypassPermissions: true
---

# sto-tester — Автоматичний тестувальник STO ERP

## Режим Auto (ОБОВ'ЯЗКОВО)

**Все виконується без питань.** Алгоритм:

```
1. Крок 0 — підготовка (tsc + unit tests + scope)
2. Крок 1 — статичний аналіз (7 секцій grep)
3. Крок 2 — записати BUG_REPORT.md
4. Крок 3 — виправити всі баги (CRITICAL → LOW)
5. Крок 4 — верифікація (tsc + unit + contract)
6. Крок 5 — розширені тести (property / E2E / component)
7. Крок 6 — git commit + оновити MemoryManual.md
8. Крок 7 — самовдосконалення: записати нові підходи
```

> Не питай дозволу між кроками. Фіксуй одним реченням що робиш.

**AUTO vs FULL:**

- **AUTO** (після кожного commit, CLAUDE.md правило) → Кроки 0–4, 6–7; Крок 1 тільки змінені файли; Крок 5 пропустити
- **FULL** (явний `/sto-tester`) → Всі кроки 0–7; Крок 1 повний аналіз

---

## Крок 0 — Підготовка

```bash
# TypeScript — нульова точка відліку
pnpm --filter @sto/api exec tsc --noEmit
cd apps/web && node_modules/.bin/tsc --noEmit --incremental false 2>&1 | tail -20
pnpm --filter @sto/shared exec tsc --noEmit

# Unit tests
pnpm --filter @sto/api test --run 2>&1 | tail -30

# ОБОВ'ЯЗКОВО: web component suite ТАКОЖ у baseline (не лише API).
# Червоний web-тест невидимий якщо запускати лише @sto/api → виявиться аж на Кроці 4.
# Стале component-vs-test drift (тест асертить текст/поведінку якої компонент не має) ловиться ЛИШЕ тут.
pnpm --filter @sto/web exec vitest run 2>&1 | tail -10

# Scope (AUTO: тільки змінені файли; FULL: весь проєкт)
git diff HEAD --name-only | head -30
cat MemoryManual.md | head -50
```

TS або unit (API **і** web) червоні → зафіксуй як Bug #0, виправ ПЕРШИМ. Червоний baseline-тест (навіть не зачеплений scope-коммітами) — release-blocker: ховає регресії за шумом і блокує наступні сесії.

**ОБОВ'ЯЗКОВО: перевірити `[x]`-маркери попередніх сесій проти реального стану файлів.**
Попередня сесія могла позначити баги `[x] виправлено`, але закомітити лише docs (`MemoryManual.md`/`BUG_REPORT.md`) — фікси у коді відсутні. `[x]` без парного diff = хибно-зелений, гірший за відкритий баг (приховує блокер).

```bash
# Для кожного нещодавнього [x]-бага у BUG_REPORT.md що згадує конкретний файл:рядок —
# перевірити чи фікс РЕАЛЬНО у файлі (не довіряти статусу).
git log --oneline -5 --stat   # останній "fix(tester)" commit змінив код, чи лише *.md?
# якщо останній tester-commit чіпає ТІЛЬКИ MemoryManual.md/BUG_REPORT.md → фікси не застосовані
grep -n "Статус.*\[x\]" BUG_REPORT.md | tail -10   # звірити кожен з grep по реальному файлу
```

Якщо `[x]`-баг не виправлений у коді → переклас на відкритий, виправити РЕАЛЬНО, додати meta-bug про хибний маркер.

**ОБОВ'ЯЗКОВО після route group / app router рефакторингу — очистити `.next/` cache (Bug #291)**

Будь-який commit що рухає сторінки між route-group folders у Next.js App Router (`app/X/page.tsx` → `app/(group)/X/page.tsx`) інвалідує `apps/web/.next/` dev-cache: webpack chunk-id-и зберігаються у `webpack-runtime.js` як числа (`./726.js`), а нова структура має інші chunk-id-и → старий `webpack-runtime.js` шукає файл якого нема → CRITICAL 500 на ВСІХ chunks → React не гідрується → ніяких client-side guards (TopShell auth redirect, AuthProvider, useRequireAuth) не виконуються. TS green, unit tests green, але живий dev server повертає `<html>` без JS — користувач застряг на захищеному URL без auth.

```bash
# Detect route group rename pattern у diff:
git diff HEAD~5 HEAD --name-status | grep -E "^R.*app/.*[/(].*/.*page\.tsx"

# Або просто перевірити чи були переміщення з/в route-group folders:
git log -1 --stat HEAD~5..HEAD | grep -E "app/\{ =>|app/.* => app/\("

# Якщо знайдено rename pattern — ОБОВ'ЯЗКОВО:
test -d apps/web/.next && rm -rf apps/web/.next apps/web/tsconfig.tsbuildinfo

# Перезапустити web dev server (порт 3001) перед запуском E2E
# Перевірити що chunks повертають 200:
curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/_next/static/chunks/main-app.js
# Якщо 500 — cache не очистився, retry rm + restart
```

- [ ] Route group rename detected у `git diff HEAD~N HEAD --name-status` → `rm -rf apps/web/.next` ПЕРЕД будь-якими TS/unit/E2E запусками. Інакше E2E падатиме з помилковим повідомленням (`expected /\/(login|setup)/, got /work-orders/`) яке маскує справжню проблему (webpack chunk 500). Перевірка часта і дешева.

**AUTO: матриця що перевіряти за типом зміни**

| Тип зміни                      | Секції Кроку 1                                                            |
| ------------------------------ | ------------------------------------------------------------------------- |
| Новий `@Controller` / endpoint | §1.1 (tenant, soft delete), §1.2 (TS, API contract), §1.5 (contract spec) |
| Змінений `*.service.ts`        | §1.1 (business logic, FSM, inventory, settlements)                        |
| Нова `page.tsx` / зміна UI     | §1.3 (frontend стани, hydration, routing)                                 |
| Новий `*.dto.ts`               | §1.2 (validation guards, @IsUUID версія)                                  |
| `prisma/schema.prisma`         | §1.1 (soft delete fields, orgId), §1.2 (TS)                               |
| `components/ui/` only          | §1.3 (стани), §1.6 (a11y)                                                 |
| Config / docs / тести          | §0 (tsc) — більше нічого                                                  |

---

## Крок 1 — Статичний аналіз (збір багів)

> AUTO: аналізуй ТІЛЬКИ файли з `git diff HEAD --name-only`.
> FULL: повний аналіз всіх секцій.

Кожен знайдений баг → запиши в BUG_REPORT.md (Крок 2 — шаблон нижче).

---

### §1.1 — Бізнес-логіка Backend

#### FSM нарядів

```bash
# FSM читається з map, не хардкодиться
grep -rn "status.*===\|status.*==\b" apps/api/src/modules/work-orders/work-orders.service.ts | grep -v spec | grep -v "TRANSITIONS\[" | head -10

# IN_PROGRESS → RESERVATION через InventoryService
grep -rn "RESERVATION\|createMovement" apps/api/src/modules/work-orders/work-orders.service.ts | head -10

# COMPLETED → WRITEOFF+CHARGE у $transaction
grep -rn "WRITEOFF\|CHARGE\|prisma\.\$transaction" apps/api/src/modules/work-orders/work-orders.service.ts | head -10
```

- [ ] `transition()` читає з `WORK_ORDER_TRANSITIONS` map — не хардкодить статуси
- [ ] `IN_PROGRESS` → резервування через `InventoryService.createMovement(RESERVATION)`
- [ ] `COMPLETED` → `WRITEOFF` + `RESERVATION_RELEASE` + `SettlementsService.createTransaction(CHARGE)` у `prisma.$transaction`
- [ ] `CANCELLED` зі статусу з резервом → `RESERVATION_RELEASE`
- [ ] Недозволений перехід → `BadRequestException` українською

#### Інвентар

```bash
# Прямий update stockItem (заборонено поза InventoryService)
grep -rn "stockItem\.update\|stockItem\.upsert" apps/api/src/modules/ --include="*.ts" | grep -v "inventory.service\|spec" | head -10

# Guards у InventoryService
grep -n "available\|quantity\|BadRequestException" apps/api/src/modules/inventory/inventory.service.ts | head -20
```

- [ ] Жодного прямого `prisma.stockItem.update({ quantity })` поза `InventoryService`
- [ ] `RESERVATION`: `available < qty` → `BadRequestException`
- [ ] `WRITEOFF`: `quantity < Math.abs(qty)` → `BadRequestException`
- [ ] `quantity=0` → `BadRequestException`

#### Розрахунки

```bash
# Прямий update balance (заборонено поза SettlementsService)
grep -rn "settlementAccount\.update\|balance.*decrement\|balance.*increment" apps/api/src/modules/ --include="*.ts" | grep -v "settlements.service\|spec" | head -5
```

- [ ] Жодного прямого `prisma.settlementAccount.update({ balance })` поза `SettlementsService`
- [ ] `CHARGE` збільшує баланс; `PAYMENT/PREPAYMENT/REFUND/CREDIT_NOTE` — зменшують

#### Tenant Isolation

```bash
# findFirst/findMany без orgId
grep -rn "findFirst\|findMany\|findUnique" apps/api/src/modules/ --include="*.service.ts" | grep -v "orgId\|spec\|//.*find" | head -20

# Optional FK у create/update spread без org-scoped перевірки (Bug #161)
# для кожного *Id?: поля у CreateDto перевірити чи сервіс робить findFirst({ id: dto.XId, orgId }) ПЕРЕД create/update
grep -rn "Id?: string\|Id!: string" apps/api/src/modules/ --include="*.dto.ts" | grep -iE "brand|unit|supplier|counterparty|vehicle|branch|warehouse|category|account" | head -20
grep -rn "data: { \.\.\.dto\|data: dto\b" apps/api/src/modules/ --include="*.service.ts" | grep -v spec | head -10
```

- [ ] Кожен `findFirst` / `findMany` / `update` містить `orgId` у `where`
- [ ] **Optional FK у `data: { ...dto }` / `data: dto`** (`brandId`, `unitId`, `preferredSupplierId`, `vehicleId`, `branchId`...) → сервіс валідує КОЖЕН наданий FK через `findFirst({ id: dto.XId, orgId, deletedAt: null })` ПЕРЕД write (патерн Bug #90). Сирий DB FK перевіряє лише глобальне існування `id`, НЕ `orgId` → FK з чужої org проходить → cross-tenant linkage. P2003 ловить ТІЛЬКИ неіснуючий ID, не cross-tenant — тому «P2003 прийнятний» НЕ закриває tenant-isolation. Severity HIGH
- [ ] **Defense-in-depth для `update` (Bug #191):** жоден `prisma.X.update({ where: { id } })` на org-scoped таблиці без `orgId` у `where`. Prisma не підтримує `update({ where: { id, orgId } })` для primary-key (TS error) → використовувати `updateMany({ where: { id, orgId, deletedAt: null } })` + опціонально `if (count === 0) throw NotFoundException(...)`. Локально безпечно якщо `id` отриманий через org-scoped read, АЛЕ майбутній рефактор/copy-paste у controller без org-check = cross-tenant write без error. Grep: `grep -rn "\.update({ where: { id:" apps/api/src/modules/` — кожен match без `orgId` у where = LOW (profilatic), HIGH якщо викликається з prep-неперевіреним `id`
- [ ] **FSM transition write-path persistence для new nullable row column (Bug #236):** sprint що додає `nullable colX?: TypeX` у row-модель (`PurchaseOrderLine`/`StockDocumentLine`/`InvoiceLine`/`WorkOrderPart`) + mapping `colX: l.colX ?? null` у `toDto` → у кожному `transition(STATE)` / `receive()` / `applyPricing()` / FSM-обчислювальному методі, де обчислюється resolved value (наприклад `lineUnitId = good.unitId`) і пропагується у side-effect resource (`inventory.createMovement(colX: lineUnitId)`/`stockMovement.create({ colX })`), ОБОВ'ЯЗКОВО має бути парний `tx.<rowTable>.update({ where: { id: line.id }, data: { colX: resolvedValue } })` для самого row, всередині $transaction. Інакше `findOne(id).lines[i].colX === null` назавжди → cross-resource inconsistency: history (movements) має X, current state (line) має NULL → audit/sync/export ламається. Symmetric-write для Bug #232 (read-side missing include). Grep: `grep -rnE "[a-z]*Id:\s*l\.[a-z]*Id\s*\?\?\s*null" apps/api/src/modules --include="*.service.ts"` → для кожного match у відповідному `transition()`/`receive()`/`applyPricing()` шукати `tx.<row>.update.*data.*colX`. Severity HIGH (silent data integrity)
- [ ] **BullMQ processor idempotency guard (Bug #346):** кожен `@Process({ name: 'X', concurrency: N })` з external API call (`fetch`, `axios`, SMS, ПРРО/Checkbox) ТА `attempts > 1` ОБОВ'ЯЗКОВО читає відповідний DB-запис ПЕРЕД external call і перевіряє результат вже записаний (`fiscalReceiptId`, `sentAt`, `deliveredAt`). Без guard: transient DB error після успішного зовнішнього виклику → BullMQ retry → дублікат side-effect (2 фіскальних чеки, 2 SMS). Grep: `grep -rn "async handle" apps/api/src/modules/ --include="*.processor.ts" -l | while read f; do grep -q "fetch(\|axios\." "$f" && ! grep -q "findFirst\|findUnique" "$f" && echo "MISSING: $f"; done`. Регресія-guard: spec `it('пропускає якщо result-field вже встановлено')` + `it('пропускає якщо запис не знайдено')`. Severity: MEDIUM для ПРРО (fiscal compliance risk); LOW для webhook retry (acceptable by protocol).

- [ ] **Dead-feature integration audit (Bugs #267, #268):** для КОЖНОГО `@Injectable` сервісу з queue/processor companion (`@nestjs/bull`, `@Processor`, `@InjectQueue`) — перевірити чи real callsite викликає його з payments/invoices/work-orders/settlements flow. Grep: `grep -rl "InjectQueue\|@Processor" apps/api/src/modules --include="*.ts"` → для кожного service-метода: `grep -rln "\.<method>(" apps/api/src --include="*.ts" | grep -v "spec\|<own-module>"` → якщо count=0 → bug. Парний сигнал: UI tab/sidebar/settings для фічі АЛЕ нема telemetry/trigger. Severity HIGH якщо feature розрекламована користувачу (`loyalty.queueEarn` ніколи не викликається з payments → бали не нараховуються); MEDIUM якщо admin/internal (`batch.consumeBatch` ніколи з inventory WRITEOFF → cost-method не застосовується). Фікс: додати виклик у trigger service (з `.catch(warn)` для non-blocking) + import відповідного Module у trigger Module + DI injection

- [ ] **Hardcoded document-number у auto-create обхід DocumentNumberService (Bug #348):** будь-який `tx.<Model>.create({ data: { number: '<literal>', ... } })` де `<Model>` має згадку у `DocumentNumberConfig` seed (`WORK_ORDER`, `INVOICE`, `PURCHASE_ORDER`, `STOCK_RECEIPT`, `COUNTERPARTY_AGREEMENT`...) — bug. Auto-create-flow (наприклад `service.create()` контрагента → авто-PURCHASE контракт) повинен використовувати ту саму систему нумерації що і ручний UI-flow (`createContract` через `documentNumberService.next()`), інакше monotonic-нумерація документів порушена. Grep: `grep -rnE "tx\.[a-z]+\.create\(\s*\{\s*data:\s*\{[^}]*\bnumber:\s*['\"]" apps/api/src/modules --include="*.service.ts"` — кожен literal-number у data-spread = bug. Виклик `documentNumberService.next()` робити ПЕРЕД `$transaction` (next() сам відкриває власний $tx з SELECT FOR UPDATE — nesting deadlock). Severity HIGH (feature розрекламована як «автоматично створюється документ», порядок номерів inconsistent).

- [ ] **Soft-delete primary без auto-promote next sibling (Bug #351):** для КОЖНОЇ моделі з `isPrimary Boolean` / `isDefault Boolean` / `isMain Boolean` полем — `service.remove()` ОБОВ'ЯЗКОВО має auto-promote next sibling. Pattern: `(1) SELECT existing { id, isPrimary, <scopeFields> }`; `(2) $transaction: soft-delete X; if (existing.isPrimary) findFirst({<scope>, deletedAt:null, id:{not:id}}, orderBy:{createdAt:'asc'}) → update({isPrimary:true})`. Без promote: bizнес-інваріант «у scope завжди ≥1 primary якщо існують активні рядки» силентнo порушений. Downstream auto-selection logic (PO/WO create без contractId → findFirst orderBy isPrimary desc → випадковий non-primary) повертає неправильні значення. Grep: `grep -rnE "isPrimary\s+Boolean|isDefault\s+Boolean|isMain\s+Boolean" packages/database/prisma/schema.prisma | awk '{print $1}'` — для кожної моделі знайти `<module>.service.ts` `remove()`/`deleteX()` і перевірити наявність findFirst+update після soft-delete. Severity HIGH. Парне з Bug #226-#227 (frontend-side): backend може правильно promote, але frontend з optimistic-filter не знає → теж потребує refetch.

- [ ] **Soft string FK без validation (Bug #361):** будь-який DTO field що зберігається у Prisma як plain `String`/`String @db.VarChar(N)` АЛЕ концептуально посилається на іншу таблицю (`currencyCode → Currency.code`, `paymentMethodCode → PaymentMethodConfig.code`, `eventType → NotificationTemplate.eventType`, etc.) — service ОБОВ'ЯЗКОВО валідує існування через `findFirst({ orgId, <field>: dto.X, deletedAt: null })` перед persist. Без guard API дозволяє `currencyCode: 'XYZ'` → DB корумпована (no FK constraint enforces existence) → UI рендерить garbage (`1 000.00 XYZ`), downstream FX/notification lookups silent-skip або throw. Парний guard має існувати у БОТКИ `create` І `update` paths (PATCH-only attack vector іначе). Grep: `grep -rnE "String\s*$|String\s+@db\.VarChar" packages/database/prisma/schema.prisma | grep -iE "code|type|status"` → для кожного знайденого field перевірити service. Severity HIGH. Регресія-guard: contract spec кейс `POST .../<resource> { code: 'INVALID' } → 400`.

- [ ] **Auto-create child resource ignores parent settings inheritance (Bug #360):** для КОЖНОГО `tx.<ChildModel>.create()` всередині parent `service.create()`/`$transaction` — перевірити чи child default-values відповідають parent-level settings, які user міг налаштувати. Приклад: `OrganisationSettings.currency='USD'` → `auto-create CounterpartyContract.currencyCode` має використати 'USD' (не hardcoded 'UAH'). Інші risk-spots: `BranchSettings.slotDurationMinutes` → auto-Slot create, `OrgSettings.invoiceDueDays` → auto-Invoice create. Grep: `grep -rnE "tx\.[a-z]+\.create\(\s*\{\s*data:\s*\{[^}]*\b(currencyCode|currency|paymentDeferDays|warrantyDays|slotDurationMinutes):" apps/api/src/modules --include="*.service.ts"` — кожен hardcoded value у data поза параметром = potential bug. Fix-pattern: fetch `prisma.organisationSettings.findUnique({ where: { orgId }, select: { <fields> }})` ПЕРЕД `$transaction` (паралельно з documentNumberService.next через Promise.all для -1 RTT), передати у tx.create.data. Severity HIGH (порушує задекларовану інваріант UX-tooltip типу «Використовується за замовчуванням у договорах і звітах», silent inconsistency).

- [ ] **Case-sensitive lookup vs canonical-form seed data (Bug #359):** для КОЖНОГО `findFirst({ where: { code: dto.X } })` або `where: { eventType: dto.Y }` або `where: { documentType: dto.Z }` де target field зберігається у канонічній формі (UPPERCASE ISO code, snake_case event type) — DTO ОБОВ'ЯЗКОВО має `@Transform(toUpperCurrencyCode)` / `@Transform(toLowerCase)` / etc. до `@IsString`. Postgres VARCHAR/TEXT case-sensitive за замовчуванням → користувач набирає `uah` у fallback Input → backend lookup `code: 'uah'` не знаходить `'UAH'` → 400 з валідним кодом. Парний UI-fix: `<Input onChange={e => set(e.target.value.toUpperCase())} maxLength={N}>` у fallback inputs (коли dropdown reference data не завантажилось через offline-first). Grep: `grep -rnE "findFirst\(\s*\{\s*where:\s*\{[^}]*\b(code|type|status):\s*dto\." apps/api/src/modules --include="*.service.ts"` → перевірити що DTO field має нормалізацію transform. Severity HIGH (UX): валідний код → 400 → користувач думає «зламано».

#### Prisma schema ↔ migration parity (release-blocker)

```bash
# Bug #220: schema.prisma модифіковано АЛЕ нема нової migration у migrations/
# tsc green (Prisma client типи генеруються з schema, не з applied DB schema)
# unit tests green (vi.fn() mocks не торкаються DB), runtime — P2021 "table does not exist"
schema_changes=$(git diff HEAD~5 HEAD --name-only -- packages/database/prisma/schema.prisma)
new_migrations=$(git diff HEAD~5 HEAD --name-only --diff-filter=A -- packages/database/prisma/migrations/)
if [ -n "$schema_changes" ] && [ -z "$new_migrations" ]; then
  echo "BUG #220: schema.prisma modified but no new migration directory created"
fi

# Для кожної нової `model X` у schema → grep у migrations/ за CREATE TABLE
grep -E "^model [A-Z]" packages/database/prisma/schema.prisma | awk '{print $2}' | while read model; do
  tbl=$(grep -A20 "^model $model " packages/database/prisma/schema.prisma | grep -oE "@@map\(\"[^\"]+\"\)" | head -1 | sed 's/@@map("//;s/")//')
  [ -z "$tbl" ] && tbl=$(echo "$model" | sed 's/\([A-Z]\)/_\L\1/g' | sed 's/^_//')
  if ! grep -rq "CREATE TABLE.*\"$tbl\"" packages/database/prisma/migrations/; then
    echo "MISSING MIGRATION: model $model (table $tbl) — no CREATE TABLE in migrations/"
  fi
done
```

- [ ] **Schema↔migration parity (Bug #220)** — будь-який commit що модифікує `packages/database/prisma/schema.prisma` має закомітити **парний** SQL-файл у `packages/database/prisma/migrations/<timestamp>_<feature>/migration.sql`. Це CRITICAL release-blocker (фіча мертва у runtime з `P2021 table does not exist`). tsc green бо Prisma client типи генеруються з декларативної schema. Unit tests green бо vi.fn() mocks не торкаються DB. Ловиться ТІЛЬКИ статичним аудитом `git diff schema.prisma` ↔ `migrations/`. Перевіряти для: (а) нової `model X` → `CREATE TABLE`; (б) додавання field → `ALTER TABLE ADD COLUMN`; (в) нового `@@index` → `CREATE INDEX` (silent perf regression замість CRITICAL crash); (г) `@@unique` → `CREATE UNIQUE INDEX`. Не покладатись на `prisma migrate dev` (потребує live DB + interactive prompt); писати migration SQL вручну за шаблоном з найближчого попереднього migration з аналогічним relation pattern.

#### Soft Delete

```bash
# findFirst без deletedAt: null
grep -rn "findFirst\|findMany" apps/api/src/modules/ --include="*.service.ts" | grep -v "deletedAt\|spec\|StockMovement\|SettlementTransaction\|Payment\|WorkOrderLineEmployee\|EmployeeBranch" | head -20

# Прямий hard delete (заборонено)
grep -rn "prisma\.[a-zA-Z]*\.delete(" apps/api/src/modules/ --include="*.service.ts" | grep -v spec | head -10
```

- [ ] Всі `findFirst` / `findMany` мають `deletedAt: null` (окрім append-only моделей)
- [ ] Append-only без `deletedAt`: `SettlementTransaction`, `StockMovement`, `Payment`, `WorkOrderLineEmployee`
- [ ] Жодного `prisma.X.delete()` на бізнес-сутностях

**Soft-delete + `@@unique` = P2002 при повторному створенні (Bug #152)**

```bash
# Знайти @@unique без partial WHERE deletedAt IS NULL у міграції
grep -n "@@unique" packages/database/prisma/schema.prisma
grep -rn "CREATE UNIQUE INDEX" packages/database/prisma/migrations/ | grep -v "WHERE"
```

- [ ] Якщо `@@unique([orgId, X])` без `deletedAt` у partial filter → `create()` має **resurrection pattern**: `findFirst({ NOT: { deletedAt: null } })` → якщо знайшов, `update({ ...dto, deletedAt: null })` замість `create`

**PATCH що змінює unique-поле → ConflictException (Bug #151)**

- [ ] `update()` з `dto.field` що є у `@@unique` → re-check: `findFirst({ orgId, field, NOT: { id } })` → `ConflictException` якщо знайшов
- [ ] **CRITICAL для soft-delete + @@unique без partial filter (Bug #297):** `update()` re-check MUST НЕ фільтрувати `deletedAt: null` (інакше soft-deleted рядок з тим же unique field проходить як «не дубль» → потім `prisma.update` отримає P2002 → 500). Правильно: `findFirst({ orgId, field: dto.field, NOT: { id } })` без `deletedAt: null`; якщо знайшов і `duplicate.deletedAt != null` → `ConflictException('... існує у архіві. Спочатку відновіть її або оберіть інше скорочення.')`; інакше звичайний `ConflictException`.

**restore() prep-checks (Bug #298, #305)**

- [ ] `restore(orgId, id)` робить prep-check на active duplicate: `findFirst({ orgId, <uniqueField>, deletedAt: null, NOT: { id } })` → якщо знайшов → `ConflictException` (інакше P2002 при `update deletedAt=null`).
- [ ] `restore()` defensive guard: якщо `existing.isSystem` → `BadRequestException` (системні не повинні бути soft-деleted взагалі — це сигнал inconsistency).

**isSystem guard для seed-керованих сутностей у update/remove (Bug #319, #320)**

```bash
# Для кожної моделі що має `isSystem Boolean @default(false)` (catalog seed: WorkCategory,
# GoodCategory, UnitOfMeasure, NotificationTemplate, PaymentMethodConfig...) — service.update()
# і service.remove() повинні блокувати mutation коли `existing.isSystem === true`.
grep -rn "isSystem\s*Boolean" packages/database/prisma/schema.prisma | head -10
# Для кожного знайденого models → перевірити service.update/remove:
grep -rn "isSystem" apps/api/src/modules/<module>/<module>.service.ts | grep -v "spec\|toDto\|select"
# Має бути: BadRequestException у update (для name/parentId/code/unique-field) АБО у remove.
```

- [ ] **Backend isSystem guard у `update()`** (Bug #319): сутність з `isSystem Boolean` у schema (seed-керована: WorkCategory, GoodCategory, UnitOfMeasure, NotificationTemplate) → `update()` СЕЛЕКТУЄ `isSystem: true` І перевіряє `if (existing.isSystem && (dto.name !== undefined || dto.parentId !== undefined || dto.code !== undefined)) throw BadRequestException(...)`. Косметичні per-org поля (sortOrder, icon, isActive) дозволяються. UI ховає кнопку «Перейменувати» для системних — це **косметичний guard**; backend — авторитет. Будь-який ADMIN з валідним JWT може зробити `curl -X PATCH /<resource>/<system-id>` і змінити назву кореневої системної категорії → next `seed-catalog.ts` повторний запуск відновить назву, але `parentId`/`sortOrder`/inactive-флаги затреться. Severity HIGH (data corruption через API без UI).
- [ ] **Backend isSystem guard у `remove()`** (Bug #320): аналогічно — soft-delete системних категорій = catastrophic. `DELETE /good-categories/<system-root-id>` cascade-soft-deletes 365 системних GoodCategory + nulls 1000+ Good.goodCategoryId. UI ховає кнопку видалення, але backend має блокувати: `if (existing.isSystem) throw new BadRequestException('Системну категорію не можна видалити')`. Recovery: `seed-catalog.ts` ідемпотентний — відновить, але всі custom `sortOrder/isActive` загубляться. Severity HIGH.
- [ ] **Contract spec для isSystem guard (Bug #319-#320 regression-guard):** новий `*.contract.spec.ts` для seed-керованого ресурсу має містити мінімум 4 кейси: (а) `PATCH /<resource>/<system-id>` з `{ name: 'X' }` → 400 + service.update не викликаний; (б) `PATCH /<resource>/<system-id>` з `{ parentId: <other> }` → 400; (в) `PATCH /<resource>/<system-id>` з `{ sortOrder: 5 }` → 200 (косметика дозволена); (г) `DELETE /<resource>/<system-id>` → 400 + service.remove не викликаний. Без contract spec — регресія (видалення guard у refactor) пройде CI зеленою.

**`orderBy` нульового поля + NULL semantics (Bug #296)**

```bash
# orderBy { col: 'asc' } де col nullable → Postgres NULLS LAST за замовчуванням → сюрприз для soft-delete
grep -rn "orderBy.*deletedAt.*['\"]asc['\"]" apps/api/src/modules --include="*.service.ts" | grep -v "nulls" | head -10
grep -rn "orderBy.*expiryDate.*['\"]asc['\"]" apps/api/src/modules --include="*.service.ts" | grep -v "nulls" | head -10
```

- [ ] **`orderBy` по nullable полю + soft-delete = ОБОВ'ЯЗКОВО explicit `nulls`:** для `deletedAt` (active=NULL) у списку з deleted: `{ deletedAt: { sort: 'asc', nulls: 'first' } }` (активні зверху). Для `expiryDate` FEFO (товари без терміну): `{ sort: 'asc', nulls: 'last' }` (з терміном першими). Без explicit `nulls` Postgres дефолтно ставить NULL **в кінець** ASC → видалені (з timestamp) йдуть **ПЕРЕД активними** → UX broken silently (TS green, тест без integration green).

#### List endpoints — API contract

```bash
# findAll що повертають голий масив замість { items, total }
grep -rn "return.*\[\]\|return items\b\|return result\b" apps/api/src/modules/ --include="*.service.ts" | grep -v "spec\|toDto\|map(" | head -10
```

- [ ] Кожен list endpoint → `{ items, total }` (не голий масив)

#### Raw SQL — casing та LIMIT

```bash
# Raw SQL без LIMIT
grep -rn "queryRaw\|executeRaw" apps/api/src --include="*.ts" | grep -v spec

# snake_case колонки у raw SQL (має бути camelCase з лапками)
grep -rn "queryRaw\|executeRaw" apps/api/src --include="*.ts" -A 20 | grep -E "org_id|deleted_at|created_at|updated_at|good_id|warehouse_id|min_stock" | head -10
```

- [ ] Кожен `$queryRaw` має `LIMIT N` (Prisma `take:` не впливає)
- [ ] Raw SQL ідентифікатори — camelCase у лапках: `"orgId"`, `"deletedAt"` (не `org_id`)

#### Алгоритми ціноутворення та партій

```bash
# FEFO — nulls last обов'язково
grep -n "expiryDate" apps/api/src/modules/inventory/batch.service.ts | head -5

# AVG_COST — зважена, не проста
grep -n "AVG_COST\|avgCost\|totalCost" apps/api/src/modules/inventory/batch.service.ts | head -5

# Decimal cast у recalcTotals
grep -n "Number(l\.\|Number(p\.\|totalLabor\|totalParts" apps/api/src/modules/work-orders/work-orders.service.ts | head -5

# Bug #178: bulk-apply scope-consistency — applyRuleToGoods where має всі scope-поля правила
# Для кожного scope-поля у PricingRule (goodId, goodCategory, goodType, brandId) — є в where?
grep -n "brandId\|goodCategory\|goodType\|goodId" apps/api/src/modules/inventory/pricing.service.ts | grep "where\|rule\." | head -20
```

- [ ] FEFO: `[{ expiryDate: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }]`
- [ ] `PERCENT` = `cost * (1 + pct/100)`; `FIXED_AMOUNT` = `cost + delta`; `FIXED_PRICE` fallback = `fixedPrice ?? costPrice`
- [ ] Округлення = `Math.round(result / r) * r`; захист від від'ємної ціни = `Math.max(0, result)`
- [ ] `recalcTotals`: `Number(l.amount)` cast (Decimal без cast → рядкова конкатенація)
- [ ] Batch loop: `Math.min(remaining, batch.remainingQty)`; якщо `remaining > 0` після циклу → `BadRequestException`
- [ ] **Bulk-apply scope-consistency (Bug #178):** `applyRuleToGoods` `where`-умова містить ВСІ scope-поля правила (`goodId`, `goodCategory`, `goodType`, `brandId`). Будь-яке нове scope-поле у `PricingRule` → одразу оновити `where` у bulk-apply. Відсутнє scope-поле = правило застосовується до зайвих товарів → неправильна salePrice у БД без помилки.
- [ ] **Nullable cost-input у calculateSalePrice → data corruption salePrice=0 (Bug #198):** будь-який сервіс що передає `costPrice` у `pricingService.calculateSalePrice` має ПЕРЕД викликом перевірити: `if (good.purchasePrice == null || Number(good.purchasePrice) <= 0)` → пропустити цей good (push у `notFound`/`skipped`, НЕ оновлювати salePrice). Інакше для `PERCENT`/`COMPETITOR_PLUS`/`COST_TIER` правил отримаєш `0 * (1 + p/100) = 0` → `Good.salePrice` **затирається у 0** без помилки. `Good.purchasePrice` у схемі nullable — будь-який новий код що читає його як `Number(good.purchasePrice ?? 0)` робить **silent data corruption** для товарів без собівартості. Виключення: `FIXED_PRICE` правило безпечне (повертає фіксовану ціну незалежно від cost). Grep: `grep -rn "calculateSalePrice\|purchasePrice ?? 0\|purchasePrice ?? null" apps/api/src/modules/ --include="*.ts"` — кожен виклик у сервісі що пише `salePrice` має мати prep-guard.

#### $transaction timeout

```bash
# $transaction без timeout
for f in $(grep -rl "\$transaction(async" apps/api/src --include="*.ts" | grep -v spec); do
  tx=$(grep -c "\$transaction(async" "$f")
  to=$(grep -c "timeout:" "$f")
  if [ "$tx" -gt "$to" ]; then echo "MISMATCH $f: $tx transactions, $to timeouts"; fi
done
```

- [ ] Кожен `$transaction(async callback)` має `{ timeout: N }` (5000–15000ms)

#### Deploy / infra (docker-compose, Dockerfile, nginx, reverse-proxy)

```bash
# healthcheck бінарник vs базовий образ + шлях vs globalPrefix
grep -n "healthcheck\|curl\|wget\|/health\|HEALTHCHECK" docker-compose*.yml apps/*/Dockerfile 2>/dev/null
grep -n "setGlobalPrefix\|app.use('/api" apps/api/src/main.ts

# curl/wget healthcheck на образі що їх НЕ містить (minio/minio, node:*-alpine, distroless)
# minio/minio має ЛИШЕ mc — НЕ curl/НЕ wget. Емпірична перевірка наявного образу:
#   docker run --rm --entrypoint sh <image> -c "command -v curl; command -v wget; command -v mc"
grep -nE "curl|wget" docker-compose*.yml | grep -i "healthcheck\|test:" -A1

# root .dockerignore присутній (COPY . . без нього шле node_modules/.git/.env у контекст)
test -f .dockerignore && echo ".dockerignore OK" || echo ".dockerignore MISSING"
grep -c "COPY \. \.\|COPY \./" apps/*/Dockerfile 2>/dev/null

# build-скрипт копіює у шлях що НІХТО не обслуговує (dead output)
grep -rn "apps/api/public\|Copy-Item\|cp -r" scripts/ 2>/dev/null
grep -n "useStaticAssets\|@fastify/static\|express.static" apps/api/src/main.ts

# PowerShell $PSScriptRoot (порожній при dot-source) без fallback
grep -rn "PSScriptRoot" scripts/ installer/ 2>/dev/null | grep -v "MyInvocation\|if (\$PSScriptRoot)"

# Глобальний APP_GUARD (ThrottlerGuard/IpFilterGuard/тощо) — який endpoint має бути виключений (skip-list)
# Bug #203: global ThrottlerGuard блокує /health → docker healthcheck → cascade restart
grep -n "APP_GUARD\|useClass: ThrottlerGuard\|useClass: IpFilterGuard" apps/api/src/app.module.ts
# для кожного global guard → перевірити skip-list (health, metrics, webhooks, SSE):
grep -rn "@Controller.*health\|@Controller.*metrics\|@Sse\|@Controller.*webhook" apps/api/src --include="*.controller.ts" -l | while read f; do
  if ! grep -q "@SkipThrottle\|SkipThrottle()" "$f"; then
    echo "POSSIBLE SKIP-LIST GAP: $f served by global guard but no skip decorator (verify if intentional)"
  fi
done
```

- [ ] Кожен compose healthcheck: бінарник є у базовому образі (alpine → НЕ curl; node → `node -e http.get`; **minio/minio → НЕ curl/НЕ wget, лише `mc` → `["CMD","mc","ready","local"]`**); шлях узгоджений з `setGlobalPrefix`/proxy-prefix (`/api/health` не `/health`). Не довіряти «alpine/curl» евристиці для НЕ-alpine образів (minio, distroless, mongo тощо) — перевіряти емпірично `docker run --rm --entrypoint sh <image> -c "command -v curl wget mc"`
- [ ] Перевірити blast-radius: сервіси з `depends_on: X: { condition: service_healthy }` не стартують якщо healthcheck X завжди FAIL → CRITICAL
- [ ] Root `.dockerignore` присутній якщо будь-який Dockerfile робить `COPY . .` (інакше node_modules/.git/.env/out у контексті — повільно + ризик leak)
- [ ] Build-скрипт не копіює у мертвий шлях (`apps/api/public` коли API не реєструє `@fastify/static`/`useStaticAssets`)
- [ ] `$PSScriptRoot` має fallback `if ($PSScriptRoot) {...} else { Split-Path -Parent $MyInvocation.MyCommand.Path }` (порожній при dot-source)
- [ ] nginx Next.js static export: `location /_next/static/` з `expires 1y; immutable`; `gzip_types` включає `text/javascript image/svg+xml application/xml`
- [ ] **Global APP_GUARD skip-list audit (Bug #203):** будь-яке введення global guard через `{ provide: APP_GUARD, useClass: XGuard }` потребує аудиту endpoint-ів які мають бути виключені: (а) `/health` — docker healthcheck/nginx upstream/моніторинг опитують часто, ліміт швидко перетинається → cascade restart; (б) `/metrics` — Prometheus scrape кожні 15s; (в) SSE-streams (`@Sse`) — довгоживучі з'єднання повторно retry-ються EventSource при втраті; (г) webhooks з зовнішніх систем (PRRO, payment provider) — клієнт не контролює rate; (д) batch/cron-endpoints. Кожен такий контролер потребує парний skip-декоратор (`@SkipThrottle()`, `@Public()`, `@SkipGuard()`). tsc не ловить, тести не ловять (HEALTH spec звичайно не запускає AppModule з APP_GUARD). Виявляється лише у проді коли docker healthcheck отримує `429` → restart loop.
- [ ] **Paired logger+middleware request-id link (Bug #216):** коли проєкт додає одночасно (а) HTTP correlation middleware що сетить `x-request-id` header, і (б) structured logger (`nestjs-pino`/`pino-http`) — пересвідчись що ДВА компоненти **поділяють той самий ID source**. Дефолтний `pino-http.genReqId` повертає sequential integers (`1, 2, 3, ...`) — НЕ читає header. Middleware сетить header один UUID, pino пише інший integer у `reqId` лога → cross-correlation мертва. Grep: `grep -n "genReqId\|reqId" apps/api/src` — якщо середовище має CorrelationIdMiddleware АЛЕ нема `genReqId` у pino config → bug. Фікс: `genReqId: req => req.headers['x-request-id']`-based з fallback `randomUUID()`. Захист: контракт-тест що шле `X-Request-Id: <UUID>` і асертить `JSON.parse(stdout).reqId === <UUID>`. Аналогічна перевірка: `customLogLevel`, `customSuccessMessage`, `serializers` що ховають correlation поля. Severity: HIGH (не runtime crash, але feature що додається саме для production-моніторингу — не працює).
- [ ] **pino redact list — cross-DTO secret-field audit (Bug #217):** після додавання `pino` `redact: [...]` пройти кожен `*.dto.ts` у `apps/api/src/modules/` і знайти ВСІ plaintext-secret поля (`password`, `*Password`, `*Token`, `*Secret`, `*Key`, `*PrivateKey`, `apiKey`, `webhookSecret`). Кожне таке поле має `req.body.X` АБО `req.body.*Password`-glob у redact. Grep: `grep -rnE "(password|Token|Secret|apiKey|webhookSecret)!?\??:.*string" apps/api/src/modules/**/*.dto.ts` → cross-check проти `redact: [...]`. SKILL §1.4 раніше згадував лише `password`/`refreshToken`/`accessToken`; реальні DTO мають теж `ownerPassword` (setup), `prroApiKey` (POS), `webhookSecret` (webhooks). Без full аудиту перший review-раунд накладає redact лише для очевидних auth-полів, а решта secret-полів лишається непокритими — log statement з spread `req.body` витече їх. Severity: MEDIUM (поки немає log statement що spread-ить body — нема leak; додавання stmt стає HIGH).

---

### §1.2 — TypeScript / API якість

```bash
# Dead imports after page/module split (Bug #204-#205)
# tsconfig зазвичай має noUnusedLocals: false → tsc мовчить про неіснуючий runtime impact,
# але мертві імпорти псують tree-shaking + плутають code review + ламаються коли helper переноситься
# у privately-renamed export. Шукати кожен imported symbol чи реально вживається у файлі-споживачі.
for f in $(git diff HEAD --name-only | grep -E "\.(ts|tsx)$"); do
  [ -f "$f" ] || continue
  # extract imported names from { ... } imports
  for sym in $(grep -oE "^import \{[^}]+\}" "$f" | grep -oE "[A-Za-z_][A-Za-z0-9_]+" | grep -v "^import$\|^from$" | sort -u); do
    # count occurrences excluding import line itself
    count=$(grep -c "\b$sym\b" "$f")
    importLines=$(grep -c "^import.*\b$sym\b" "$f")
    used=$((count - importLines))
    if [ "$used" -le 0 ]; then echo "DEAD IMPORT in $f: $sym"; fi
  done
done

# any без виправданого cast
grep -rn ": any\b\|as any\b" apps/api/src/modules/ --include="*.ts" | grep -v "as unknown as\|spec" | head -10

# Prisma model напряму в response
grep -rn "return.*await.*prisma\|res\.json.*prisma\|return prisma" apps/api/src/modules/ --include="*.controller.ts" | grep -v spec | head -10

# BigInt у response без Number() cast
grep -rn "syncVersion\b" apps/api/src/modules/ --include="*.service.ts" | grep -v "Number(\|toNumber()\|spec\|where\|select\|BigInt" | head -10

# @IsUUID без версії — відхиляє nil-UUID (test-only баг)
grep -rn "@IsUUID()" apps/api/src/modules/ --include="*.dto.ts" | head -5

# ParseUUIDPipe відсутній
grep -rn "@Param('id')" apps/api/src/ --include="*.controller.ts" | grep -v "ParseUUIDPipe" | head -10

# Ukrainian error messages
grep -rn "throw new.*Exception\|throw new.*Error" apps/api/src/modules/ --include="*.ts" \
  | grep -E "['\"](Cannot|Invalid|Not found|Already|Forbidden|Unauthorized|Failed)" | grep -v spec | head -10

# JSON/Record DTO поля без @IsObject() → знімаються whitelist:true → undefined в сервісі (Bug #182)
# КОЖНЕ поле DTO (включно з non-primitive типами) потребує хоча б одного декоратора
grep -rn "Record<string\|: object\b\|: Json\b" apps/api/src/modules/ --include="*.dto.ts" | grep -v "//\|spec" | while read line; do
  file=$(echo "$line" | cut -d: -f1)
  lineno=$(echo "$line" | cut -d: -f2)
  # перевірити чи є будь-який @Is decorator на попередніх 3 рядках
  startline=$((lineno > 3 ? lineno - 3 : 1))
  if ! sed -n "${startline},$((lineno-1))p" "$file" | grep -q "@Is\|@Validate\|@Allow"; then
    echo "MISSING DECORATOR on $file:$lineno"
  fi
done
```

- [ ] Немає `any` (крім `as unknown as T`)
- [ ] `toResponseDto()` — жоден Prisma model не повертається напряму
- [ ] `syncVersion: Number(row.syncVersion)` у всіх DTO (Decimal/BigInt → Number)
- [ ] `@Param(':id')` → `ParseUUIDPipe`
- [ ] `throw new XxxException('...')` — повідомлення українською
- [ ] `@IsUUID()` без версії ('all') відхиляє nil-UUID → у **тестах** для UUID-полів: `11111111-1111-4111-8111-111111111111` (v4 layout)
- [ ] **JSON/Record DTO поля** (`Record<string, unknown>`, `object`, `Json`) → обов'язково `@IsObject()` або `@ValidateNested()`. Без декоратора `whitelist: true` знімає поле мовчки → `dto.value === undefined` → сервіс записує `undefined/null` у БД без помилки (Bug #182). Перевіряти: `grep -A2 "!: Record\|?: Record\|!: object\|?: object" *.dto.ts | grep -v "@Is"`
- [ ] **Multipart `await req.file()` обгорнутий у try/catch** (Bug #192): `fastify-multipart` кидає FastifyError "the request is not multipart" що мапиться у HTTP **406** з англ. messageом якщо клієнт відправляє НЕ-multipart body. Helper має ловити це і re-throw `BadRequestException` українською. Grep: `grep -rn "await req.file()" apps/api/src/modules/ --include="*.controller.ts"` — кожен виклик у try/catch АБО у helper з try/catch. Contract spec для нового multipart-endpoint вимагає тест `POST без multipart → 400 + укр. msg`
- [ ] **Mass DTO migration completeness — grep variant audit (Bug #215):** sprint-wide refactor (наприклад «змінити `@Matches(uuid-regex)` → `@IsUUID()` у всіх DTO», «додати `@IsOptional()` до всіх `?:` полів», «замінити `string` → `string | null` для nullable DB полів») часто пропускає **варіантні форми** оригінального паттерну. Розробник grep-ить простий case (`@IsUUID('4')`) і пропускає декорації з додатковими args (`@IsUUID('4', { each: true })`, `@IsUUID('4', { message: '...' })`). Після sprint лишається 2-5 file-points з СТАРОЮ строгістю — тестові fixtures з ТОГО ж sprint можуть пройти бо їх теж зробили v4-layout, але production seeds/demo data з не-v4 UUID (e.g. `00000000-0000-0000-0000-000000000002`) ловлять 400 у dev. Grep: для кожного sprint-wide refactor — пройти ОБИДВА варіанти `@X()` і `@X(arg1, { each|message|... })`. Приклад для UUID: `grep -rn "@IsUUID(" apps/api/src/modules/ --include="*.dto.ts"` (NOT `@IsUUID('4')$`). Severity: HIGH коли блокує dev/seed workflow.
- [ ] **Mass DTO migration variant validator-family audit (Bugs #257-#265):** sprint що додає `@Transform(emptyToUndefined)` для одного validator-сімейства (наприклад `@IsDateString`) часто пропускає **інші validator з тим самим symptom-ом**: `@IsISO8601`, `@IsDate` (Date), `@IsEnum([literal1, literal2])` (string-literal union), `@IsUUID('4')` (з аргументом). КОЖЕН validator що відхиляє `''` потребує `@Transform(emptyToUndefined)` якщо поле optional. Перевірка має пройти ВСІ варіанти:
  - Date: `@IsDateString`, `@IsISO8601`, `@IsDate`
  - Enum: `@IsEnum(Type)`, `@IsEnum([lit1, lit2])`, `@IsIn([...])`
  - String-format: `@IsEmail`, `@IsUrl`, `@IsUUID`, `@IsUUID('4')`, `@Matches(regex)`
    ПЛЮС перевірити **inline 1-рядкові форми** (`@ApiPropertyOptional() @IsOptional() @IsX() field?: T;` — не матчиться multi-line grep) ПЛЮС `extends PartialType(X)` derivation chains (UpdateDto успадковує проблему від CreateDto). Парне з: для кожного DTO зі змінами — 1 contract-spec `it` «POST/PATCH з порожнім рядком у X → 201 + service отримує undefined» (Bug #244 regression-guard). Severity: HIGH (фіча мертва коли фронт шле `''`).
- [ ] **Optional numeric DTO field з тільки @IsOptional() (Bug #283):** будь-яке поле `?: number` у `*.dto.ts` без хоча б одного з `@IsInt()` / `@IsNumber()` / `@Min()` / `@Max()` / `@Type(() => Number)` — bug. `class-validator` БЕЗ type-decorator пропускає string/Infinity/негативні/floats у Int colum. Severity HIGH (runtime crash + data corruption). Grep: `grep -rn "?: number\b" apps/api/src/modules/ --include="*.dto.ts"` → для кожного matched перевірити 5 рядків ПЕРЕД на наявність `@IsInt`/`@IsNumber`/`@Min`/`@Max`/`@IsPositive`. Парне з required: `grep -rn "!: number\b"`. Особливо вразливі: weight/quantity/limit/page/offset/percent/days/year поля. Регресія-guard: contract-spec який POST string `"abc"` / `-1` / `99999999` / `2.5` (для Int) → 400.
- [ ] **Inner DTO class з порожніми полями (Bug #247):** будь-який nested DTO клас (зазвичай використовується через `@ValidateNested @Type(() => InnerDto)`) — у якому поля декларовані як `@ApiProperty() workId!: string; quantity!: number;` БЕЗ class-validator декораторів (`@IsUUID`/`@IsNumber`/`@IsString`/`@Min`/тощо). `whitelist: true` НЕ зачепить inner DTO (бо `@ValidateNested` валідує його повністю), АЛЕ якщо inner DTO нема жодного декоратора — pipe сприймає його як «порожній» клас і пропускає ВСІ значення (UUID-зломане, негативні числа, рядки 1М символів). Outer-DTO виглядає захищеним (`@ValidateNested + @Type`), але насправді захист зворотнього порядку — `@ValidateNested` потребує що внутрішній DTO САМ описує валідатори. Grep: `grep -rn "@ApiProperty()" apps/api/src/modules/ --include="*.dto.ts" -A1 | grep -B1 "[a-z]!: string\|[a-z]!: number" | grep -v "@Is\|@Min\|@Max\|@Matches\|@Length" | head -20` — кожен `@ApiProperty()` без сусіднього `@IsXXX` декоратора у inner DTO = bug. Парне з: `grep -B5 "@ValidateNested" apps/api/src/modules/ --include="*.dto.ts"` для перевірки що inner DTO має валідатори. Severity: HIGH (повна обходка validation для вкладеної структури + anti-DoS через відсутнє `@ArrayMaxSize`).

---

### §1.3 — Frontend (Next.js)

```bash
# .catch(() => {}) на fetch — ховає помилки
grep -rn "\.catch(() => {})" apps/web/src/app --include="*.tsx"

# loading оголошений але setLoading(true) відсутній
grep -rn "const \[loading.*false" apps/web/src/app --include="*.tsx" | head -10
# → для кожного перевірити чи є setLoading(true) перед fetch

# cancelled flag відсутній
grep -rn "useEffect" apps/web/src/app --include="*.tsx" -A 10 | grep "apiFetch\|apiMultipartFetch" | grep -v "cancelled\|mounted" | head -10

# Async-init Select race
grep -rn "value=\{form\." apps/web/src/app --include="*.tsx" | grep -v "//\|onChange" | head -20
# Для кожного — перевірити що опції завантажуються async і є sync useEffect автовибору

# SSR-safe date (new Date() у render = hydration mismatch)
grep -rn "new Date()\|Date\.now()" apps/web/src/app --include="*.tsx" | grep -v "useEffect\|getTime\|setDate\|//\|spec" | head -10

# key={i} у списках з filter/sort
grep -rn "key={i}\|key={index}" apps/web/src/app --include="*.tsx" | head -10

# apiFetch у PUBLIC_ROUTES сторінках (public pages мають publicFetch)
grep -rn "apiFetch\|apiBlobFetch" apps/web/src/app --include="*.tsx" | grep -E "booking|setup" | head -5

# React.X без named import
grep -rn "React\.\(ReactNode\|CSSProperties\|ChangeEvent\|MouseEvent\|FormEvent\)" apps/web/src/ --include="*.tsx" | grep -v "//\|spec" | head -10

# Timeline/drag px→time converter без clamp у видиме вікно → Invalid Date (Bug #157)
grep -rn "decimalHoursTo\|pxToHours\|pxToDecimal\|clientX.*-.*rect\|getBoundingClientRect" apps/web/src/app --include="*.tsx" -l | head -10
# → для кожного timeline/calendar/gantt: чи resize/drag clamp-ить результат у [WINDOW_START, WINDOW_END] ПЕРЕД new Date()
grep -rn "new Date(\`\${.*}T\${\|toISOString()" apps/web/src/app --include="*.tsx" | grep -iE "calendar|timeline|slot|gantt|schedule" | head -10

# Swallowed-fetch що годує ОБОВ'ЯЗКОВИЙ select / disabled-guard (Bug #159) — escalate severity
grep -rn "\.catch(() => {})" apps/web/src/app --include="*.tsx" -B3
# → для кожного: чи setX(...) у .then() рендериться у <Select required> АБО у disabled={!state}?
#   якщо так — порожня помилка блокує workflow без feedback (MEDIUM, не LOW)

# Мертвий стан/handler після рефактору inline→shared-component (Bug #160)
# для кожного useState/useCallback з префіксом фічі (woSearch/woOptions...) перевірити чи setter
# викликається ПОЗА reset-ефектом і чи value читається у JSX. tsc без noUnusedLocals НЕ ловить.
grep -rn "const \[\(wo\|cp\|search\|inline\)[A-Za-z]*," apps/web/src/app --include="*.tsx" | head -20

# apiFetch generic type mismatch — fetch<T[]> але endpoint повертає {items,total} (Bug #181)
# Стандарт STO ERP list endpoint = { items, total }. Виняток: /branches = bare array.
# Шукати apiFetch<X[]> де X — не пагінований примітив; перевірити контролер.
grep -rn "apiFetch<[A-Za-z]*\[\]>" apps/web/src/app --include="*.tsx" | grep -v "//\|spec" | head -20
# → для кожного: прочитати controller.ts endpoint — повертає масив чи {items,total}?
# Known bare-array endpoints: /branches (fbe66ad — спеціальний випадок, довідник)
# Known {items,total} endpoints: /brands, /goods, /pricing-rules, /work-orders, /invoices, /counterparties, ...

# FormData надсилається через apiFetch (а не apiMultipartFetch) → CRITICAL (Bug #197) — фіча мертва
# apiFetch ЖОРСТКО ставить Content-Type: application/json → browser НЕ може автоматично виставити multipart boundary
# → fastify-multipart кидає "the request is not multipart" → upload завжди валиться
grep -rn "apiFetch\b.*body:\s*\(fd\|formData\|new FormData\)" apps/web/src --include="*.tsx" | head -10
grep -rn "body: \(fd\|formData\)" apps/web/src --include="*.tsx" -B3 | grep -E "apiFetch\b" | head -10
# → кожен match — обов'язково замінити на apiMultipartFetch

# Next.js App Router error.tsx з bare `error: Error` без `& { digest?: string }` (Bug #206)
# Docs: https://nextjs.org/docs/app/api-reference/file-conventions/error
grep -rn "error.*:\s*Error[^&]" apps/web/src/app --include="error.tsx" | grep -v "digest" | head -5

# Нова browser-API залежність без jsdom-стабу (Bug #177) → каскадне падіння всіх тестів які монтують shared-компонент
# tsc мовчить (типи в lib.dom.d.ts), prod працює (браузер має API), jsdom — НІ.
grep -rnE "new (ResizeObserver|IntersectionObserver|MutationObserver|PerformanceObserver)\(|window\.matchMedia\(|navigator\.(clipboard|share|wakeLock|geolocation|mediaDevices)|crypto\.subtle|new Notification\(" apps/web/src/components/ui apps/web/src/app --include="*.tsx" -l | while read f; do
  # для кожного знайденого API — перевірити чи setup.ts його стабає
  for api in ResizeObserver IntersectionObserver MutationObserver PerformanceObserver matchMedia; do
    if grep -q "$api" "$f" && ! grep -q "$api" apps/web/src/__tests__/setup.ts; then
      echo "JSDOM STUB MISSING: $f uses $api but apps/web/src/__tests__/setup.ts does not stub it"
    fi
  done
done
```

- [ ] Кожен list-fetch в `useEffect` має: `let cancelled=false` + `return () => {cancelled=true}`; `setLoading(true)` перед; `.finally(() => !cancelled && setLoading(false))`; `.catch((e) => !cancelled && setError(...))`; у JSX `{loading && <Spinner/>}` + `{!loading && items.length===0 && <Empty/>}`
- [ ] `new Date()` у render path → `useState<Date|null>(null)` + `useEffect(() => setToday(new Date()), [])`
- [ ] `key={i}` у списках де можлива re-order/filter → `key={item.id}` або stable derived key
- [ ] PUBLIC_ROUTES (`/booking`, `/setup`, `/login`, `/403`) → `publicFetch`, не `apiFetch`
- [ ] `import type { ReactNode, ChangeEvent, MouseEvent } from 'react'` (не `React.ReactNode`)
- [ ] `setTimeout` / `setInterval` у `useEffect` → `clearTimeout` / `clearInterval` у cleanup
- [ ] Timeline/gantt drag/resize: кожен px→decimal-hours converter clamp-ить результат у `[WINDOW_START, WINDOW_END]` ПЕРЕД побудовою `new Date(...).toISOString()` (інакше `endH>maxHour`/`startH<0` → `"24:30"`/`"-1:00"` → Invalid Date → RangeError у `toISOString()` → handler мовчки падає). Resize-гілка ОКРЕМО від draw-гілки — draw зазвичай clamp-ить через `pxToDecimalHours`, resize рахує delta і clamp-ить тільки проти протилежного краю
- [ ] Swallowed-fetch що годує **обов'язковий** контрол → MEDIUM (не LOW): якщо `.catch(() => {})`/`.catch(noop)` ховає помилку завантаження списку, який рендериться у `<Select required>` або гейтить `disabled={!state}` submit-кнопку — порожній список = назавжди заблокований workflow без feedback. Фікс: `errorState` + inline `<p>` під контролом
- [ ] Мертвий стан після inline→shared-component рефактору: коли inline-патерн (dropdown/picker/search) замінюють на shared-компонент (`SearchPickerModal` тощо), старі `useState`/`useCallback`/`useRef` лишаються «сиротами». Ознака: setter викликається ТІЛЬКИ в reset-ефекті (`if (!open) setX('')`), а value НІКОЛИ не читається у JSX; handler (`searchX`) визначено але не викликано. `tsc` без `noUnusedLocals` мовчить. Видалити повністю (включно з cleanup-ефектом orphaned `timeoutRef`)
- [ ] **Next.js App Router convention-файли — точна сигнатура (Bug #206):** `app/**/error.tsx` має приймати `{ error: Error & { digest?: string }; reset: () => void }` — bare `Error` валідний у tsc але блокує майбутній моніторинг (Sentry/Datadog) що читає `error.digest`. Перевіряти сигнатуру кожного нового error.tsx проти Next.js docs (`https://nextjs.org/docs/app/api-reference/file-conventions/error`). Аналогічно для `layout.tsx` (`{ children, params }`), `page.tsx` (`{ params, searchParams }`), `loading.tsx` (no props). Grep: `grep -rn "error.*:\s*Error[^&]" apps/web/src/app --include="error.tsx"` — кожен match без `digest` = Bug
- [ ] **Decorative SVG/icon без `aria-hidden="true"` (Bug #207):** SVG-іконки що дублюють semantic-сигнал поряд (warning-icon біля заголовка "Помилка", info-icon біля banner-тексту) → `aria-hidden="true"` обов'язково, інакше screen-reader озвучує "image" перед текстом. Іконки-кнопки без тексту → `aria-label` (вже у §1.7). Іконки з текстом-аналогом поряд → `aria-hidden="true"`
- [ ] **App Router convention-файли з інтерактивом (`useEffect`/`onClick`/`'use client'`) → парний `*.test.tsx` (Bug #208):** `error.tsx`/`not-found.tsx`/кастомний `global-error.tsx` потребують компонент-тестів. Шаблон: `apps/web/src/app/__tests__/error.test.tsx` — heading render, error.message render, fallback при empty, reset callback клік, navigate link/button, console.error effect, type-regression test (digest support), aria-hidden SVG. `loading.tsx` без логіки skip
- [ ] **FormData upload через `apiFetch` замість `apiMultipartFetch` (Bug #197) → CRITICAL**: `apiFetch` ЖОРСТКО додає `Content-Type: application/json` до КОЖНОГО запиту → коли тіло — `FormData`, browser НЕ може автоматично виставити правильний `multipart/form-data; boundary=...`. Сервер отримує binary FormData з JSON content-type → `fastify-multipart` кидає `the request is not multipart` → upload завжди валиться 400/406. **Фіча повністю мертва у проді.** Grep: `grep -rn "apiFetch\b.*body:\s*\(fd\|formData\|new FormData\)" apps/web/src --include="*.tsx"` — кожен match замінити на `apiMultipartFetch(path, formData)` (БЕЗ ручного `method: POST` — функція сама POST). Особливо при додаванні нової upload-фічі: «нагуглив схожий аплоад» → `apiFetch` looks similar → CRITICAL регресія
- [ ] **React Query cross-resource invalidation audit (Bug #210-#212):** для КОЖНОГО `await apiFetch(/X/:id/Y, { method: 'POST'|'PATCH'|'DELETE' })` у migrated page → прочитати **серверний** controller+service цього endpoint і знайти всі side-effect updates на ІНШИХ resource-ах: (1) `inventory.createMovement(...)` → invalidate `inventoryKeys.all`; (2) `workOrders.transition(...)` → invalidate `workOrdersKeys.all`; (3) `settlements.createTransaction(...)` → invalidate `counterpartiesKeys.all` (якщо list показує balance); (4) `priceHistory.create(...)` + `good.update({ salePrice })` → invalidate `inventoryKeys.all` / `goodsKeys.all`. Same-resource invalidation (own-keys.all) — звичайна; cross-resource — невидимий gap бо клієнт не знає що endpoint мутує сторонній resource. Не покладатись на `staleTime=30s` — користувач може мати другий tab з відповідним list-view або переходити швидше за staleTime. Grep: `grep -B2 -A5 "method: 'POST'\|method: 'PATCH'\|method: 'DELETE'" apps/web/src/app/<migrated-page>` → кожен endpoint pair-check проти `apps/api/src/modules/<resource>/<resource>.service.ts`. Severity: MEDIUM коли впливає на бізнес-метрику (залишки/ціни/балансу); LOW коли лише UX (new row не з'являється у list до router.back)
- [ ] **React Query migration completeness: mutation hooks експортовані але не використовуються (Bug #213):** після `feat(rq): migrate X` commits — grep usage `useXMutation`/`useDeleteX`/`useUpdateX` у `apps/web/src/app` (поза tests). Якщо count === 0 → migration зробила лише READ-path, WRITE-path лишається raw `apiFetch` + manual invalidate. Це **не runtime-bug**, але: (1) bundle bloat; (2) misleading commit-message; (3) maintenance burden (invalidation у двох місцях). Severity LOW; фікс: задокументувати у MemoryManual як known-state АБО видалити hooks; full migration = окремий sprint
- [ ] **React Query custom hook без `*.test.tsx` (Bug #214):** новий `apps/web/src/hooks/api/use*.ts` з `useQuery`/`useMutation` потребує парний `*.test.tsx`. Тести покривають: (1) queryKey factory ізоляція (різні фільтри → різні ключі); (2) enabled-gate (`employee=null` → no fetch); (3) URLSearchParams build (кожне опціональне поле → відповідний URL param АБО відсутній якщо false-y); (4) signal abort (apiFetch отримує signal). Шаблон: `useWorkOrders.test.tsx`. Mock `apiFetch` + `useAuth`. Не використовувати реальний `QueryClientProvider` — створити свіжий `QueryClient` per-test з `retry: false`. Без цих тестів — silent URL param drift (як 3d5136d repairCategory regression) пройде CI зеленим
- [ ] **UoM display-vs-base mismatch на submit (Bug #231):** будь-який `<Select>` що дозволяє перемикати UoM з recalc display quantity (Krok 5 patten: `coefficient` + `unitId` + `unitShortName` у local lines state) ОБОВ'ЯЗКОВО має у submit-функції конвертувати display→base: `quantity: parseFloat(l.quantity) * (l.coefficient || 1)` і `price: parseFloat(l.price) / (l.coefficient || 1)`. Display-transition formula `newDisplay = oldDisplay * oldCoeff / newCoeff` зберігає інваріант між двома UoMs, АЛЕ submit потребує **окремої** конверсії до base. Якщо submit шле `parseFloat(l.quantity)` як-є → backend (що очікує base units) отримує display value → silent data corruption у stock movement / payable / applyPricing. Видно ЛИШЕ коли coefficient != 1; happy-path з default UoM (coeff=1) — без регресії. Grep: `grep -rnE "quantity:\s*parseFloat\(l\.quantity\)[^*]" apps/web/src/app --include="*.tsx" -B5 | grep -B5 "coefficient"` — кожен match без `* coeff`/`* (l.coefficient` = CRITICAL bug. Backend пара: `inventory.createMovement(quantity: l.quantity)` без UoM-conversion — підтвердження що quantity ОЧІКУЄТЬСЯ у base units. Severity: CRITICAL (release-blocker)
- [ ] **Mass DTO field migration completeness — include audit (Bug #232):** додавання нового поля (`unitShortName`/`coefficient`) у `*.dto.ts` `LineResponseDto` + `toLineDto`-mapping без оновлення Prisma `include` queries → поле завжди undefined у API response. Розробник додав `select: { unitOfMeasure: { select: { shortName, coefficient } } }` у service X, забув у service Y. Grep: для кожного `unitShortName`/`coefficient`/інше нове DTO-поле — для кожного `prisma.X.findFirst/findMany/findFirstOrThrow/create/update` що повертається через `toLineDto`/`toDto` → перевірити що relevant `include` присутній. Pair-check: `grep -n "good?.unitOfMeasure" apps/api/src/modules/**/*.service.ts` (consumer) vs `grep -n "unitOfMeasure:" apps/api/src/modules/**/*.service.ts | grep -v ".dto.ts"` (producer/include). Якщо consumer-count > producer-count за модулем — bug. Severity: MEDIUM (data display, не runtime crash; але feature що додано саме для UX — мертвий)
- [ ] **Frontend hint обіцяє backend behavior якого немає (Bug #266):** для кожного UI-хінту що містить «буде (додано|застосовано|скопійовано|створено|нараховано|використано|враховано|оновлено)» / «автоматично (X|застосується|створиться|нарахується|спрацює)» / «після (створення|відкриття|збереження)» — знайти найближчу POST/PATCH-функцію + перевірити чи body передає поле що упроваджує обіцяну дію. Grep: `grep -rnE "буде (додано|застосовано|скопійовано|створено|нараховано|використано|враховано|оновлено)|автоматично" apps/web/src --include="*.tsx"`. Парний сигнал: `<Select>`/`<input>` поряд з хінтом — value не передається у submit body → bug. Severity HIGH (feature розрекламована як автоматична). Фікс: реалізувати backend integration АБО переписати hint чесно `"додайте вручну ... після створення"`
- [ ] **`useState(initializer)` з React Query error як initializer (Bug #278):** `const [error, setError] = useState(queryError instanceof Error ? queryError.message : '')` — **antipattern.** `useState`-initializer запускається ТІЛЬКИ на першому render. На першому render `queryError === undefined` (запит in-flight, не resolved) → `error` ініціалізується як `''`. Потім query завершується з error → `queryError` стає `Error` → але `error` state застиглий на `''`. UI не показує помилку. Подвійно небезпечно з `refetchInterval` — кожне poll-failure ховається. **Правильний паттерн:** derive `displayError` value на кожному render: `const displayError = error || (queryError instanceof Error ? queryError.message : '');`. Local `error` state лишається для manual mutations (post-action errors), `queryError` derive завжди актуальний. Grep: `grep -rn "useState(.*queryError\|useState(.*statusError\|useState(.*Error instanceof Error" apps/web/src/app --include="*.tsx"` — кожен match потребує перетворення у derived value. Severity: MEDIUM (silent failure mode для polling sync/dashboard widgets).
- [ ] **Prefetch queryKey ↔ page queryKey shape mismatch (Bug #281):** `qc.prefetchQuery({ queryKey: Xkeys.list({}), queryFn: ... })` у `TopShell` / nav-prefetch буде у різному cache slot ніж сторінка що читає через `useX({ page: 1, limit: 20, status: '', q: '', showDeleted: false, ... })`. Default first-mount state хука зазвичай має **повний об'єкт** з derived empty-string/false values, НЕ `{}`. TanStack hashFn виробляє різні хеші. Prefetched data зберігається у unused cache slot, сторінка робить SECOND fetch при mount. Net: bandwidth+API load без жодного perceived speedup. Grep: для кожного `prefetchQuery` у `TopShell`/nav-компонентах знайти споживача сторінки → перевірити що `Xkeys.list({...})` shape ІДЕНТИЧНА (всі ключі і значення). Severity: MEDIUM (фіча декларована як «instant nav» не працює).
- [ ] **Sub-resource default-flag mutation → parent-list staleness (Bug #226-#227):** для будь-якого sub-resource CRUD у modal-табі (`addX`/`setDefaultX`/`removeX` що викликають `/<parent>/:id/<sub>` ендпоінти) — pair-check проти backend service: чи endpoint виконує `prisma.<Parent>.update/updateMany({...})` (наприклад `Good.unitId` оновлюється коли default UoM змінюється)? Якщо так, success-handler frontend ОБОВ'ЯЗКОВО викликає `load()` для parent-table АБО invalidate `<parentKeys>.all`. Conditional: `addX` тільки коли `isFirst === true` (зчитати з backend → у response `created.isDefault`); `setDefaultX` завжди; `removeX` тільки якщо видаляли default (capture `wasDefault` перед DELETE). **Auto-promote next-default:** коли backend `removeX` логіка пише `findFirst({orderBy:createdAt asc}) + update({isDefault:true})` (наприклад `removeUoM` у `goods.service.ts`), оптимістичний `setModalXs(prev => prev.filter(...))` у клієнті НЕВІРНИЙ — replace optimistic filter на `refreshXs(parentId)` (race-guarded через існуючий reqRef). Grep: `grep -rn "apiFetch.*method:.*'POST\|PATCH\|DELETE'" apps/web/src/app --include="*.tsx" | grep -E "/uoms|/barcodes|/categories|/tax-rates|/warranties|/contacts|/services"` — pair-check проти backend. Severity: MEDIUM коли стале значення впливає на бізнес-сприйняття; HIGH коли стале значення гейтить наступну дію
- [ ] **Filter pill chicken-and-egg для soft-delete UI (Bug #295):** будь-який toggle/filter-pill що відкриває **єдиний шлях** до архівних/прихованих даних (`Архів`/`Видалені`/`Корзина`) — його видимість НЕ МОЖЕ залежати від `derivedCount > 0` де count обчислюється з даних, видимих ТІЛЬКИ після toggle. Сценарій: initial state `showHidden=false` → API повертає лише видимі → `hiddenCount=0` → кнопка `{hiddenCount > 0 || showHidden ? <Toggle/> : null}` НЕ рендериться → користувач не має способу побачити архів → soft-delete фіча недосяжна. Grep: `grep -rnE "(deleted|archived|hidden|removed)Count\s*>\s*0\s*\|\|" apps/web/src/app --include="*.tsx"` — кожен match де count обчислюється з відфільтрованого списку = bug. Фікс: toggle завжди видимий, count показувати ТІЛЬКИ коли `showHidden=true` (бо у `false` mode count завжди 0 за визначенням). Severity: CRITICAL (feature недосяжна без power-user URL hack)
- [ ] **AbortController у `useEffect` для filter-toggle race (Bug #301):** будь-який `useEffect(() => { load() }, [filterState])` де `filterState` toggle-able і `load()` робить `apiFetch` — потребує `AbortController` у cleanup. Без нього: швидке перемикання filter → попередній fetch не cancelled → resolve order non-deterministic → last setUnits(...) wins, який може суперечити поточному UI mode (stale state shown for current filter). Grep: `grep -rn "useEffect" apps/web/src/app --include="*.tsx" -A 5 | grep -B1 "load\(\)\|apiFetch" | grep -v "AbortController\|signal"` — кожен match без AbortController при наявності залежності від toggle/filter state = bug. Severity: MEDIUM
- [ ] **In-flight guard для async-кнопок без overlay-блокування (Bug #303):** будь-яка `<Button onClick={() => action(id)}>` де `action` робить async POST/PATCH/DELETE і немає `disabled` prop тримати `inFlightIds` Set state. Без нього: користувач клікає 5 разів швидко → 5 паралельних POST → перший успіх, 2nd-5th повертають 404/409 (ресурс уже змінено) → setError shows стається помилка хоча перший успіх. Особливо при операціях що змінюють стан рядка (delete/restore/approve/cancel) — наступні reqs після першого побачать новий стан і обуряться. Грубий tip-off: відсутність `setRestoringIds`/`processingIds`/`busyIds` state у компоненті який має destructive/state-changing button-actions. Severity: MEDIUM (UX flash false errors)
- [ ] **Input-mask wrapper re-extracts digits from formatted prefix (Bug #369):** для КОЖНОГО mask-wrapper у `apps/web/src/components/ui/` (`PhoneInput`, майбутні `CardNumberInput`/`IBANInput`/`VinInput`/`EDRPOUInput`) що мутирує `e.target.value` напряму у onChange — функція форматування ОБОВ'ЯЗКОВО стрипає **фіксований локований prefix** маски (`+38 (` для phone, `UA` для IBAN, etc.) з raw string ПЕРЕД digit extraction. Інакше при ітеративному типінгу `e.target.value` повертає ВЕСЬ formatted string з власним prefix → `replace(/\D/g, '')` витягує prefix digits РАЗОМ з user input → country/prefix code акумулюється в subscriber portion. **One-shot paste happy-path** (`+380501234567` в порожнє поле) працює бо немає префіксу у raw. **Iterative typing fails** silently — користувач вводить `380501234567` посимвольно і отримує `+38 (380) 501-23-45` замість `+38 (050) 123-45-67`. Grep: `grep -rn "e\.target\.value\s*=\s*" apps/web/src/components/ui --include="*.tsx"` + `grep -rnE "function (apply|format)[A-Z]" apps/web/src/components/ui --include="*.tsx" -A 10`. Регресія-guard: `it('iterative typing matches one-shot paste')` + `it('idempotency applyMask(applyMask(x)) === applyMask(x)')`. Severity: HIGH (silent data corruption — невалідний номер у БД, backend приймає бо 10 цифр).
- [ ] **Toggle-state UI desync: highlight/cursor не gated на enabled-flag (Bugs #310-#311):** додавання toggle-component (`DetailPanelToggle`, `useDetailPanel`, `FilterToggle`, `CompactModeToggle`) що керує boolean state, але ефекти toggle (highlight рядка `bg-secondary`/`bg-primary/5`, `cursor-pointer`, hover-effects) застосовуються на основі іншої state-змінної (`selectedX?.id === item.id`, `expandedRows.has(id)`) **БЕЗ** gate на toggle-state → після `toggle()` → `enabled=false`, але `selectedX` залишається non-null → класи рендеряться, action недоступна, UX desync. Grep: `grep -rnE "selected[A-Z][a-zA-Z]*\?.id\s*===\s*[a-z]+\.id\s*&&\s*'bg-" apps/web/src/app --include="*.tsx" | grep -v "detailPanel\.enabled\|panel\.enabled\|enabled &&"` — кожен match без enabled-gate. Парний grep для cursor: `grep -rnE "'group cursor-pointer'|className=\\\`group cursor-pointer" apps/web/src/app --include="\*.tsx"`. Фікс: додати `&& detailPanel.enabled`до КОЖНОГО affordance class (cursor + highlight + hover). Альтернатива:`useEffect(() => { if (!detailPanel.enabled) setSelectedX(null) }, [detailPanel.enabled])` у consumer-page. Симетрія: якщо одне gated → друге теж має бути gated; асиметрія = bug. Severity: MEDIUM для stale highlight; LOW для cursor-only
- [ ] **Dead `/X/new` маршрут у keyboard shortcut / Command Palette (Bug #354):** будь-який `router.push('/<resource>/new')` у `apps/web/src/hooks/useGlobalShortcuts.ts` АБО `href: '/<resource>/new'` у `apps/web/src/lib/commands.ts` — перевірити що відповідна директорія `apps/web/src/app/<group>/<resource>/new/` ІСНУЄ. Якщо resource має create-flow через модалку (`<page.tsx>` → `setModal(true)`) і НЕ має окремої `/new` сторінки → `[id]` dynamic route ловить `'new'` як id → `apiFetch('/<resource>/new')` → 404/broken detail page. Grep для виявлення: `grep -rn "router\.push('/[^']*/new')\|href:\s*'/[^']*/new'" apps/web/src --include="*.ts" --include="*.tsx"` → для кожного match: `test -d apps/web/src/app/\(*\)/$(echo URL | cut -d/ -f2)/new && echo OK || echo DEAD`. Фікс-pattern: `?action=new` query param + `useSearchParams` listener у page.tsx + ОБОВ'ЯЗКОВО `<Suspense fallback={null}>` обгортка (Next.js static-export вимагає для `useSearchParams`). Severity HIGH (feature декларована, маршрут broken).
- [ ] **`usePaginatedList` queryKey shape ↔ `xKeys.list()` factory shape mismatch (Bug #355 — Bug #281 шаблон, глибинна варіація):** будь-який shared helper-hook (`usePaginatedList`, `useResourceList`, custom `useXXX`) що приймає `{ queryKey: 'X' }` option і будує `queryKey: [key, filters]` — ОБОВ'ЯЗКОВО має МАТЧИТИ shape парного factory. Стандарт `xKeys.list(filters)` = `[...xKeys.all, 'list', filters]` (3-element) → hook має `queryKey: [key, 'list', filters]`. Без `'list'` як другого елемента TopShell prefetch (що використовує factory) потрапляє у dead cache slot для ВСІХ ресурсів які споживають helper. Grep: `grep -rn "queryKey:\s*\[.*filters\]" apps/web/src/hooks/api/ --include="*.ts"` — кожен match без `'list'` як другого елемента та з парним `Keys.list()` factory у тому ж файлі = bug. Regression-guard: тест через `qc.getQueryCache().getAll()` + асерт `queryKey.toEqual([key, 'list', filters])`. Severity MEDIUM (silent — кожна nav робить FETCH вдруге, performance тільки). Виявляється ТІЛЬКИ якщо порівняти shape helper-hook vs factory shape — code review зазвичай пропускає.
- [ ] **TopShell prefetch payload-shape ↔ page first-mount filter object (Bug #356 — Bug #281 шаблон, sortBy/dateFrom defaults):** TopShell `prefetchQuery({ queryKey: xKeys.list({...}) })` має передавати ПОВНИЙ filter object що сторінка передає на first mount. Поля що часто пропускаються у prefetch: (а) `sortBy/sortDir` — додаються через `useSortState('createdAt', 'desc')` хук на сторінці; (б) `dateFrom/dateTo` — додаються через `useState(() => kyivToday())` initializer; (в) специфічні фільтри `employeeId`/`repairCategory`/`type` що сторінка передає як `undefined`. Кожен новий фільтр на сторінці потребує парного оновлення PREFETCH_MAP у `TopShell.tsx`. Grep: для кожного `prefetchQuery({ queryKey: xKeys.list({...}) })` у TopShell — знайти споживача сторінки + порівняти ВСІ keys filter object. Якщо count keys у TopShell < count keys у page-hook call → bug. Альтернатива (захищеніший паттерн): експортувати `defaultXFilters()` з hook-файлу і викликати ОБИДВІ сторони з неї. Regression-guard: integration тест через `qc.getQueryCache().getAll()` після TopShell mount + page mount → асерт `cache.length === 1` (один slot, не два). Severity MEDIUM (silent — prefetch не hit).
- [ ] **Review-fix completeness audit для крос-файлових патернів (Bug #341):** будь-який review-fix commit `fix(review): replace X with Y` що чіпає **N файлів** (наприклад заміна `.catch(() => {})` на `console.warn`) — після кожного такого commit пройти **ВЕСЬ codebase** на той самий патерн і переконатись що review знайшов УСІ файли. Grep-команда має бути така ж яка вживалась у review, але БЕЗ filter по changed-files. Типові пропуски: (а) сторінки `[id]/PageClient.tsx` коли review працював зі сторінкою у root (`/X/page.tsx`); (б) tabbed-content (`*Tab.tsx`) поза основним route файлом; (в) sub-components всередині той самий сторінки; (г) shared hooks/utilities у `apps/web/src/hooks` чи `lib`. Парний сигнал у git log: `git log --oneline | grep "fix(review)" | head -3` — для останнього review-fix-commit взяти grep-паттерн з нього (наприклад `\.catch(() => {})`) і виконати `grep -rn "<pattern>" apps/web/src --include="*.tsx" --include="*.ts" | grep -v <вже-виправлені>` → нові match = upskipped review (BUG нової tester-сесії). Виключення з cleanup: легітимні випадки документуються у самому місці (toast-double-protection, optional PWA SW, fire-and-forget telemetry) — тестер відрізняє за наявністю парного user-feedback каналу (toast/setError/console.warn вище у фукнції). Severity: успадковує severity оригінального review-fix bug-у. Grep шаблон: `git show --stat <last-review-commit> -- '*.tsx' '*.ts' | awk '/^ /{print $1}'` — список файлів review-fix; для кожного знайденого згодом match → перевірити чи серед них. Якщо ні → bug.

---

### §1.4 — Security (FULL режим)

```bash
# SSRF guard на webhook/external URL
grep -rn "validatePublicUrl\|url-guard" apps/api/src/modules/ --include="*.ts" | grep -v spec | head -10

# fetch без redirect: 'manual' на user-supplied URL
grep -rn "fetch(.*url\|fetch(dto\." apps/api/src/modules/ --include="*.ts" | grep -v "redirect:\|spec" | head -5

# Bug #273: validatePublicUrl присутній АЛЕ redirect: 'manual' відсутній — defense-in-depth NOT PAIRED.
# Сценарій атаки: validatePublicUrl блокує DIRECT внутрішні URL (127.0.0.1, link-local),
# але атакувальник з OWNER правом ставить legit external host attacker.com → attacker.com
# відповідає 302 Location: http://169.254.169.254/... → default fetch (redirect:'follow')
# слідує redirect → POST з Authorization header летить у privately-routed VPC. Bypass.
# Кожен файл що має ВЖЕ validatePublicUrl (або викликає fetch на user-controlled host) ПОВИНЕН
# мати парний `redirect: 'manual'` + 3xx-rejection guard:
for f in $(grep -l "validatePublicUrl\|branchSettings\.\|dto\.url\|dto\.webhookUrl\|endpoint\.url" \
            apps/api/src/modules --include="*.ts" -r | grep -v spec); do
  if grep -q "fetch(" "$f" && ! grep -q "redirect:\s*'manual'" "$f"; then
    echo "BUG #273 MISSING: $f has fetch() to user-supplied host but no redirect: 'manual'"
  fi
done

# @IsArray без @ArrayMaxSize
grep -rn "@IsArray()" apps/api/src/modules/ --include="*.dto.ts" -A 2 | grep -v "ArrayMaxSize" | head -10

# @IsString без @MaxLength (DoS)
grep -rn "@IsString()" apps/api/src/modules/ --include="*.dto.ts" | grep -v "MaxLength\|IsIn\|IsEmail\|IsUrl\|Matches\|spec" | head -20

# Public endpoint audit (Bugs #251 + #252) — controllers БЕЗ @UseGuards(JwtAuthGuard)
# Знайти контролери де клас НЕ декорований JwtAuthGuard
for c in $(find apps/api/src/modules -name "*.controller.ts" -not -name "*.spec.*"); do
  if ! grep -q "@UseGuards(JwtAuthGuard\|@UseGuards.*JwtAuthGuard" "$c"; then
    # перевірити що в файлі є хоча б один handler без guard
    grep -q "@Get\|@Post\|@Patch\|@Delete\|@Sse" "$c" && echo "PUBLIC CTRL: $c"
  fi
done
# Public-DTO double-strict audit: для кожного PUBLIC controller вивести його DTO file
# і grep-нути на @IsArray БЕЗ @ArrayMaxSize у попередніх 3 рядках, та array UUID-поля
# у service.create без tenant-FK count.
```

- [ ] User-supplied URL що server fetch-ить → `validatePublicUrl()` (`apps/api/src/common/utils/url-guard.ts`)
- [ ] `fetch(userUrl)` → `{ redirect: 'manual' }` + перевірка 3xx → block
- [ ] **Paired SSRF defense (Bug #273):** `validatePublicUrl` (defense-in-depth #1) АБО `redirect: 'manual'` (defense-in-depth #2) **окремо** = частковий захист. ОБИДВА обов'язкові. Атакувальник з admin правом може поставити `branchSettings.checkboxApiUrl = "https://attacker.com"` (proxy legit external), і attacker.com відповідає `302 Location: http://169.254.169.254/...` → default fetch слідує redirect у cloud metadata з Authorization header. Webhooks вже мають обидва шари; будь-який новий outbound fetch (Checkbox, ПРРО, SMS provider, OAuth callback, postal API) автоматично має мати обидва. Grep: для кожного `fetch(...)` де URL = ${branchSettings.X}/${dto.X}/${cfg.X}/${endpoint.X} — перевірити (а) URL пройшов validatePublicUrl у тому ж scope; (б) options має `redirect: 'manual'`; (в) response.status у [300,400) → throw. Парне з контракт-тестом (checkbox.processor.spec.ts pattern: `301/302 → throw + НЕ оновлює DB`). Severity: CRITICAL (production SSRF, admin → cloud metadata access)
- [ ] `@IsArray()` → `@ArrayMaxSize(N)` (N = реалістичний бізнес-ліміт)
- [ ] Вільний `@IsString()` → `@MaxLength(N)` (anti-DoS)
- [ ] `@IsIn(['A','B','C'])` для union-string типів (`'OK' | 'WARN' | 'CRITICAL'`)
- [ ] **Public endpoint double-strict audit (Bugs #251 + #252):** для КОЖНОГО controller-методу без `@UseGuards(JwtAuthGuard)` (повний клас без guard АБО handler з `@Public()`):
  - КОЖЕН `@IsArray()` поле у відповідному DTO має `@ArrayMaxSize(N)` (без cap — HIGH bug, ValidationPipe виконає N×regex до 400)
  - КОЖЕН `string[]` / `UUID[]` поле що зберігається у service-create-методі через `data: { ...dto, fkList: dto.field }` має ПЕРЕД create-викликом виконуватись tenant-FK guard `prisma.X.count({ where: { id: { in: dto.field }, orgId, deletedAt: null } })` з порівнянням `count === dto.field.length` (без guard — HIGH bug, cross-tenant linkage у БД)
  - КОЖЕН `@IsString()` поле без `@MaxLength` — anti-DoS gap
  - Якщо викликається external service (SMS, ПРРО) — queue з attempts ≥ 10 + exponential backoff (offline-first invariant)

---

### §1.5 — Тест-покриття Backend

```bash
# Contract тести
find apps/api/src -name "*.contract.spec.ts" | sort

# Property-based тести
find apps/api/src -name "*.invariants.spec.ts" | sort

# Unit тести нових сервісів
git diff HEAD --name-only | grep "service.ts" | while read f; do
  spec="${f%.ts}.spec.ts"
  [ -f "$spec" ] && echo "OK: $spec" || echo "MISSING spec: $spec"
done

# Стала spec після рефактору — нова constructor-залежність не замокана у TestingModule
# (NestJS DI fail "Nest can't resolve dependencies ... at index [N]")
for svc in $(git log --oneline -10 --name-only | grep "service.ts$" | sort -u); do
  spec="${svc%.ts}.spec.ts"
  [ -f "$spec" ] || continue
  # кожен private readonly у конструкторі сервісу має бути provided у спеці
  deps=$(grep -oE "private readonly [a-zA-Z]+: [A-Z][a-zA-Z]+" "$svc" | grep -oE ": [A-Z][a-zA-Z]+" | tr -d ': ')
  for d in $deps; do
    grep -q "$d" "$spec" || echo "STALE SPEC $spec: missing provider/mock for $d (constructor dep of $svc)";
  done
done

# Застарілий mock-call-count: сервіс спрощено до 1 findFirst, але spec мокає двічі
grep -rn "mockResolvedValueOnce(null)" apps/api/src --include="*.spec.ts" -A1 | grep "mockResolvedValueOnce" | head -10
# → для кожного звірити кількість findFirst у відповідному service.create()/update()

# Query-shape фікс (relation-ім'я / nested where) БЕЗ service-spec (Bug #163)
# fix-commit що змінює relation-ім'я або форму вкладеного where → contract spec мокає сервіс → НЕ ловить
git log --oneline -15 | grep -iE "PrismaClientValidationError|relation|nested|where|search|q=" | head
# для кожного fix що чіпав where/include/relation: чи є service-spec що асертить реальний where через Prisma-мок?
for svc in $(git log --oneline -15 --name-only | grep "service.ts$" | sort -u); do
  spec="${svc%.ts}.spec.ts"
  if grep -lq "PrismaService, useValue: {}" "${svc%/*}"/*.contract.spec.ts 2>/dev/null && [ ! -f "$spec" ]; then
    echo "QUERY-SHAPE GAP: $svc змінено, contract мокає сервіс, service-spec відсутній";
  fi
done
```

**Стала spec після рефактору сервісу (Bug #153-#155):**

- [ ] Кожен `private readonly X: Type` у конструкторі сервісу → є `{ provide: Type, useValue: mock }` у `Test.createTestingModule({ providers })` спеки (інакше NestJS DI fail на всіх тестах файлу)
- [ ] Кеш-мок: `CacheService.get` → `mockResolvedValue(null)` (cache miss → fallthrough на БД); `set/del/delPattern` → no-op
- [ ] Якщо `service.create()/update()` спрощено з N `findFirst` до 1 (single round-trip resurrection/dup-check) → spec мокає `findFirst` РІВНО стільки разів скільки реальних викликів (не успадкований `mockResolvedValueOnce(null).mockResolvedValueOnce(...)`)
- [ ] **Defense-in-depth status guard + stale fixtures (Bug #200):** review-фікс додав `if (entity.status !== ALLOWED_A && entity.status !== ALLOWED_B) throw BadRequestException(...)` у сервісі, але парний spec мокає `findFirst` БЕЗ поля `status` → undefined ≠ ALLOWED → guard кидає на ВСЕ існуючих тестах → release-blocker baseline. Grep: `grep -n "findFirst.mockResolvedValueOnce({" *.spec.ts` → для кожного мока у сервісі що додав status guard → перевірити чи fixture містить `status: <ALLOWED_STATUS>`. Якщо нове guard перевіряє додаткові поля (deletedAt, isActive, ownerId) — той самий патерн. Профілактично після кожного review-commit що додав early-throw guard у service.X — пройти всі `findFirst.mockResolvedValueOnce(...)` у відповідній spec і додати потрібні поля.
- [ ] **Refactored public method usage + stale mock (Bug #200):** рефактор сервісу замінив виклик `private/inline X()` на нову public method `Y()` (наприклад `calculateSalePrice` → `getActiveRulesForOrg + computePriceFromRules`). Парний spec ще мокає СТАРИЙ виклик (`pricingService.calculateSalePrice.mockResolvedValueOnce(...)`) — тест проходить **випадково** бо `Y` не викликається насправді. Регресія: майбутній рефактор поверне виклик `X` → тест зелений але реальна логіка зламана. Grep: `git diff HEAD~1 -- service.ts` шукає `+ this.X.Y(` + перевірити що spec мок названо `Y` а не `Z`. Принцип: spec повинна мокати ТЕ ЩО СПРАВДІ викликається — не успадковане.
- [ ] **Controller arg-count drift у `toHaveBeenCalledWith` форвардингу (Bug #340):** feature-commit що додає `sortBy`/`sortDir`/`branchId`/інший новий query-param у `*.dto.ts` зазвичай також редагує controller щоб прокинути `query.NEW` як додатковий positional arg у `this.service.findAll(orgId, ...args, query.NEW)`. Існуючі regression-guard contract specs (Bug #339 patten) асертять `toHaveBeenCalledWith(orgId, ...8 args)` — після рефактору controller передає 9-10 args → AssertionError на КОЖНОМУ існуючому contract spec тому ж модулю. tsc green (TypeScript не перевіряє кількість positional args при варіадичному передаванні всередині `.then(query => service.X(orgId, query.A, query.B, ...))`). Grep для виявлення pre-commit: `git diff HEAD~N HEAD -- "*.controller.ts" | grep -E "^\+.*service\.findAll\(.*\bquery\.[a-zA-Z]+\b"` — кожен новий `query.X` arg → перевірити **усі** `*.contract.spec.ts` у тому ж модулі на `toHaveBeenCalledWith` з фіксованою кількістю args і додати `undefined` для нових parametrів. Альтернатива (безпечніший pattern для майбутнього): передавати **об'єкт** `{ page, limit, ..., sortBy, sortDir }` замість positional args → нові поля не ламають existing specs (вони асертять об'єкт, додаткові поля у новому об'єкті НЕ матчаться assertion'ом якщо використовується `expect.objectContaining({...})`). Severity: MEDIUM (release-blocker — baseline червоний → tester-сесії неможливі). Boundary-check: після КОЖНОГО `feat(api|ui): add X filter`/`feat(api|ui): add X sorting` commit що чіпає controller — пройти `*.contract.spec.ts` того ж модулю.
- [ ] **Stale mock після додавання cascade-helper у service-method (Bug #340):** review-fix що додає каскадну логіку через helper-метод (`getDescendantIds`, `getAncestorIds`, `getLinkedRecords`) у існуючий service-метод (`toggleActive`/`deactivate`/`archive`/`remove`) часто додає НОВИЙ Prisma call (`findMany`, `count`, `groupBy`) ВСЕРЕДИНІ helper-а. Існуючі spec що мокали лише top-level Prisma calls (наприклад `updateMany` + `findFirstOrThrow`) тепер ловлять `TypeError: X is not iterable`/`Cannot read property 'length' of undefined` бо helper отримує `undefined` від unmocked `findMany`. Grep: `git diff HEAD~N HEAD -- "*.service.ts" | grep -E "^\+.*await this\.(getDescendantIds|getAncestorIds|getLinkedX|expandX|cascade)"` → для кожного нового helper-виклику читати helper-метод і знайти усі Prisma read-ops → у відповідному `*.spec.ts` додати `prisma.<model>.findMany.mockResolvedValueOnce([])` (порожній цаскад = mock default) ПЕРЕД викликом service-методу. Severity: MEDIUM. Парне з Bug #200 (Defense-in-depth status guard) — той самий принцип «новий read у сервісі → новий mock у spec».

**Query-shape фікс потребує service-spec, не contract-spec (Bug #163):**

- [ ] Fix що змінив **relation-ім'я** (`customerGarage`→`customerGarages`), **форму вкладеного `where`** (`some`/`every`/nested `OR`), `include`/`select` shape, або `mode: 'insensitive'` → це **runtime `PrismaClientValidationError`**, який mock-based contract spec (`{ provide: Service, useValue: serviceMock }`) НЕ виконує. Потрібен **service-spec** який будує реальний `where` через `{ provide: PrismaService, useValue: { model: { findMany: vi.fn() }, $transaction: ops => Promise.all(ops) } }` і асертить форму `findMany.mock.calls[0][0].where` (правильні relation-імена + nested `deletedAt: null` + tenant `orgId`). Перевіряти ОБИДВА напрями: правильне ім'я присутнє AND singular/старе ім'я відсутнє

**Обов'язкові contract тести для нових endpoints:**

- `GET /X` → 200 + `{ items, total }`; 401 без токена
- `POST /X` без обов'язкових полів → 400
- `PATCH /X/:id` з чужим orgId → 404

**Обов'язкові unit тести:**
| Сервіс | Критичні кейси |
|---|---|
| `work-orders.service` | create→DRAFT; FSM invalid→throws; IN_PROGRESS→RESERVATION; COMPLETED→WRITEOFF+CHARGE |
| `inventory.service` | RECEIPT +qty; RESERVATION -available; WRITEOFF insufficient→throws; qty=0→throws |
| `settlements.service` | CHARGE +balance; PAYMENT -balance; no account→NotFoundException |
| `auth.service` | login OK; wrong password→401; deleted employee→401; invalid refresh→401 |
| `pricing.service` COST_TIER | tiers=[]; cost=0; cost===tier.costMax (boundary half-open); cost<минімального costMin |

- [ ] Нові `*.service.ts` → парний `*.spec.ts` з мінімальними кейсами вище
- [ ] Нові `@Controller` → парний `*.contract.spec.ts`
- [ ] **Нові query-param фільтри (dateFrom, dateTo, branchId, q...) у існуючому QueryDto (Bugs #338, #339):** перевірити що відповідний `*.contract.spec.ts` має тест `toHaveBeenCalledWith(..., paramValue)` або `queryArg.param === value` (залежно від spread vs object). Якщо contract spec відсутня — створити. Grep: `git diff HEAD~5 HEAD --name-only | grep "\.dto\.ts$"` → для кожного QueryDto знайти spec → перевірити покриття нових полів.
- [ ] **Boundary-кейси для діапазонних правил (COST_TIER, sliding-scale, age-brackets, tax-brackets):** будь-яке правило з `min <= x < max` (або `<=`/`>=`) має тести точно НА межі (`x === min`, `x === max`), на нулі (`x === 0`), і за межами (`x < минімум`, `x > максимум`). Реалізація працює, але регресія `<=`/`<` беззвучно змінить semantics — рідко-проходимий код. Boundary-тест документує contract і ловить інверсію оператора (Bug #184)
- [ ] **Cross-tenant FK contract test для optional FK у payload:** якщо контролер валідує optional FK через `findFirst({id, orgId})` перед write (Bug #161 патерн) → contract spec має асертити: (а) POST з FK з ЦІЄЇ org → 201 + `findFirst` викликаний з правильним `{id, orgId, deletedAt:null}`; (б) POST з FK з ЧУЖОЇ org → 404 + `create` НЕ викликаний; (в) PATCH з FK з ЧУЖОЇ org → 404 + `update` НЕ викликаний. Без цих тестів регресія (видалення org-scoped перевірки під рефактор) пройде CI зеленою → cross-tenant linkage у проді без error (Bug #186)

---

### §1.6 — Frontend тест-покриття (FULL режим)

```bash
# Component тести
find apps/web/src -name "*.test.tsx" | sort

# E2E тести
find apps/web/e2e -name "*.spec.ts" | sort

# Playwright config
test -f apps/web/playwright.config.ts && echo "playwright OK" || echo "playwright MISSING"
```

- [ ] `Button`, `Select`, `Modal`, `Input`, `EmptyState`, `ModalTabs` — component тести існують
- [ ] Кожен **новий shared UI-компонент** (`components/ui/`) → парний `*.test.tsx` (render, інтерактив-стани, edge: порожні дані/`null`-render, badge з `0`)
- [ ] Кожен **новий custom hook** (`apps/web/src/hooks/use*.ts`) що містить `useEffect`/`useState` АБО викликає `apiFetch`/`localStorage`/`fetch` → парний `*.test.tsx` (renderHook + act). Шаблон: `useSavedFilters.test.tsx`. Обов'язкові кейси: початковий стан → loading; resolve API → setState; reject API → error/fallback; cleanup на unmount; race-protection (AbortController/cancelled-flag); різні pageKey/instance ізольовані. Бо hook керує persistence/network — регресія без тесту мовчки втрачає дані. tsc не ловить runtime-race, code review не ловить (locally виглядає валідно), баг виявиться лише через user-bug-report (Bug #185)
- [ ] `smoke.spec.ts` — обов'язковий: `/`, `/login`, `/setup` без auth, auth redirect
- [ ] **Component-vs-test drift:** якщо component-тест падає у baseline на `getByText(...)`/`getByRole(...)` — звірити чи компонент реально рендерить цей елемент. Тест може документувати UX-намір, від якого компонент розійшовся (видалили hint/label). Якщо намір легітимний → виправити КОМПОНЕНТ (повернути елемент); якщо застарів → виправити тест. НЕ ігнорувати «червоне і так було»
- [ ] **Новий optional boolean prop у existing UI component (Bug #194):** будь-який diff що додає `propX?: boolean` до `InterfaceProps` у `components/ui/*.tsx` → парний `*.test.tsx` має МІНІМУМ 2 кейси для цього prop: (а) inverse-стан (`propX=true`) активує/блокує очікувану поведінку; (б) inverse-стан **не зачіпає інших елементів** (захист від занадто-широкого guard, copy-paste помилок). Default-стан зазвичай покрито existing-тестами, але inverse-стан без явного тесту = «mute regression»: інверсія guard (`!hideX` → `!!hideX`, `showX` → `!showX`) проходить зеленою. Особливо критично для prop, що впроваджується для увімкнення нового UX-режиму у N сторінках одночасно (як `hideSaveButton` у 8 page.tsx) — інверсія ламає UX на всіх 8 одночасно. Grep: `grep -nE "^\s+\w+\?: boolean" apps/web/src/components/ui/*.tsx` після diff
- [ ] **Fake-green assertions у тестах (Bug #287):** будь-який `expect(<count|length>).toBeGreaterThanOrEqual(0)` — bug. `.count()` Playwright Locator повертає natural number (завжди ≥0), `arr.length` те саме → assertion завжди true → тест зеленіє назавжди, регресія не ловиться. Помилкова свідомість покриття. Grep: `grep -rn "toBeGreaterThanOrEqual(0)" apps/web/e2e apps/web/src --include="*.ts"`; також `expect(true)`, `expect(1).toBe(1)`, `toBeDefined()` на literal/number primitives. Фікс: знайти реальну очікувану кількість (`toBeGreaterThanOrEqual(N)` де N — мінімум з product spec; `toBe(N)` коли точна кількість); або переписати локатор на більш конкретний (`[data-testid="X"]` замість `[class*="X"]`); або видалити assertion якщо опціональна. Особливо підступно коли error-message string звучить як справжня перевірка (`'Має бути хоча б 3 KPI картки'`). Severity MEDIUM.
- [ ] **jsdom browser-API стаби в `apps/web/src/__tests__/setup.ts`:** якщо diff чіпає `components/ui/` АБО `app/**/page.tsx` і додає `new (ResizeObserver|IntersectionObserver|MutationObserver|PerformanceObserver)\(`, `window.matchMedia(`, `navigator.(clipboard|share|wakeLock|geolocation|mediaDevices)`, `crypto.subtle`, `Notification(` — перевірити що setup.ts стабає це API. tsc мовчить (типи у `lib.dom.d.ts`), prod працює (браузер має API), але jsdom падає → каскадне падіння всіх тестів які монтують компонент (включно з тестами далеких компонентів якщо shared-компонент усередині них). Фікс: noop-стаб під guard `typeof globalThis.X === 'undefined'`. Не стабати в самому компоненті, не вимикати тест
- [ ] **CSS scoped marker (data-X) контракт — integration-тест на наявність маркера (Bug #334):** будь-який shared UI-компонент (`Modal`, `DetailPanel`, `Popover`, `Drawer`) що покладається на CSS-правило з selector-prefix-маркером (`[data-animate][data-state="open"]`, `[data-portal]`, `[data-overlay]`) — парний `*.test.tsx` має містити assertion на присутність маркера на правильному елементі + позицію (direct-child vs descendant). Без тесту: refactor що видаляє `data-animate` атрибут з root компонента → анімація мовчки перестає працювати (CSS правило не матчиться), tsc green, всі функціональні тести зелені (Modal все ще монтується/закривається), але exit-animation мертва. Шаблон: `expect(dialog).toHaveAttribute('data-animate'); expect(dialog).toHaveAttribute('data-state', 'open'); expect(dialog.querySelector(':scope > [data-backdrop]')).toBeTruthy();`. Grep для виявлення pattern у CSS: `grep -nE "\[data-[a-z]+\](\[data-[a-z]+\=)?" apps/web/src/app/globals.css` — кожен унікальний `data-*` selector має бути присутнім хоча б в одному `*.test.tsx`. Severity LOW (visual jank, не data-correctness).
- [ ] **useEffect + rAF dance для CSS animation enter — 1-frame paint at previous state (Bug #335):** будь-який custom hook що використовує паттерн `setVisible(true); requestAnimationFrame(() => setState('open'))` у `useEffect` ДЛЯ enter-анімації CSS — потенційний flicker bug. React commits visible=true з застарілим state='closed', browser паінтиться 1 frame з закритими стилями (CSS animation FROM-keyframe для closed-state), потім rAF flips state → нова анімація стартує. У дефолтних exit-keyframes (`from { opacity:1; scale(1) }`) це означає що елемент **відмалюється з повним розміром** перед стартом enter-анімації — visual jank. Перевірити: grep `requestAnimationFrame.*setState\(` у `hooks/use*.ts` — кожен match потенційний bug. Безпечний паттерн: (а) `useLayoutEffect` + одразу `setState('open')` без rAF (CSS `animation` з `fill-mode: both` runs on mount, рAF dance не потрібен); або (б) initial state мати 'closed' + другий маркер `data-just-mounted="true"` що відключає exit-animation. Контракт-тест: між `rerender({ open: true })` і flush-rAF — `state === 'closed'` ОЧЕВИДНИЙ симптом → задокументувати у BUG_REPORT як LOW (1-frame jank). Severity LOW.
- [ ] **Stable callback identity invariant в composable hooks (Tester Cycle 2 2026-06-05):** будь-який `useCallback(() => ..., [])` у composable hook (`useListPage`, `useDetailPanel`, `useBulkSelect`, `useSavedFilters`) — окрім behavior test (`act(() => cb()) → стан змінився`) ПОВИНЕН мати regression-guard test на identity stability: `const first = result.current.cb; rerender(); expect(result.current.cb).toBe(first); act(() => result.current.setter(N)); expect(result.current.cb).toBe(first)`. Без guard: майбутній eslint --fix що додає "missing dep" (`[setPage]` замість `[]`) пройде tsc + behavior tests зеленим, але каскадно перестворює consumers' `useCallback`/`useMemo` що використовують `cb` у deps → invalidate `<MemoizedChild onApply={consumerCb}>` re-renders. Perf regression замість CRITICAL crash — важко діагностувати, накопичується мовчки. Grep: `grep -rn "useCallback(.*, \[\])" apps/web/src/hooks --include="*.ts" | grep -v test` — для кожного match перевірити чи парний test має `.toBe(firstCb)` асерт після rerender. Severity MEDIUM (perf cascade).

---

### §1.7 — Accessibility та i18n (FULL режим)

```bash
# Іконкові кнопки без aria-label
grep -rn "<Button\b\|<button\b" apps/web/src/ --include="*.tsx" | grep -E "Icon|lucide|Trash|Pencil|Eye" | grep -v "aria-label\|aria-describedby\|sr-only\|spec" | head -15

# onClick на не-інтерактивних елементах
grep -rn "onClick" apps/web/src/ --include="*.tsx" | grep -E "<div|<span|<p " | grep -v "role=" | head -10

# Англійські placeholder
grep -rn "placeholder=" apps/web/src/ --include="*.tsx" | grep -E '"[A-Z][a-z]' | head -10

# Англійські exception messages
grep -rn "throw new.*Exception\|throw new.*Error" apps/api/src/modules/ --include="*.ts" \
  | grep -E "['\"](Cannot|Invalid|Not found|Already|Forbidden)" | grep -v spec | head -10

# Формат дати: toISOString у render path
grep -rn "toISOString\|toLocaleDateString" apps/web/src/app/ --include="*.tsx" | grep -v "useEffect\|split\|//\|spec" | head -10
```

- [ ] Іконкові кнопки (без тексту) → `aria-label="Дієслово"`
- [ ] `onClick` на `<div>`/`<span>` → `role="button"` + `tabIndex={0}` + `onKeyDown`
- [ ] Всі placeholder → кирилицею (`Введіть...`, не `Enter...`)
- [ ] Всі `throw new XxxException(...)` → українською
- [ ] Дати у форматі `DD.MM.YYYY` (date-fns `uk` або `toLocaleDateString('uk-UA')`)
- [ ] Тиждень починається з понеділка (`weekStartsOn: 1`)

---

## Крок 2 — Фіксація в BUG_REPORT.md

Записуй **зразу після аналізу**, до виправлень:

```markdown
# BUG_REPORT.md — STO ERP

Дата: YYYY-MM-DD
Сесія: <коротко що тестувалось>

---

## Bug #N — [CRITICAL|HIGH|MEDIUM|LOW] Заголовок

**Файл:** `apps/api/src/modules/X/X.service.ts:145`
**Severity:** CRITICAL | HIGH | MEDIUM | LOW
**Категорія:** business-logic | security | typescript | frontend | test-coverage

**Опис:** Що не так і чому це баг.
**Очікувана поведінка:** Що має бути.
**Фактична поведінка:** Що є зараз.
**Статус:** [ ] відкритий / [x] виправлено
```

**Severity:**

- `CRITICAL` — втрата даних, неправильні фінанси, cross-tenant витік
- `HIGH` — порушення бізнес-правила (FSM, резерви), security
- `MEDIUM` — TypeScript помилка, відсутній тест критичної гілки
- `LOW` — UI стан (loading/empty), незручність

---

## Крок 3 — Автоматичне виправлення

```
Для кожного Bug #N (від CRITICAL до LOW):
  1. Прочитай файл з багом
  2. Застосуй мінімальний точковий фікс (не рефактор)
  3. pnpm --filter <package> exec tsc --noEmit → 0 errors
  4. Якщо відсутній тест → додай кейс у .spec.ts
  5. Відмітити [x] у BUG_REPORT.md
  6. git add <змінені файли> && git commit -m "fix(tester): Bug #N — <заголовок>"

Після останнього Bug:
  7. Оновити MemoryManual.md — одразу, без запиту
```

**Правила:**

- Мінімальний diff — не чіпай нічого крім проблемного місця
- Фікс потребує міграції БД → CRITICAL, повідоми користувача
- Фікс потребує змін у `@sto/shared` → оновлюй синхронно

---

## Крок 4 — Верифікація

```bash
# TypeScript — 0 errors
pnpm --filter @sto/api exec tsc --noEmit
pnpm --filter @sto/web exec tsc --noEmit --incremental false
pnpm --filter @sto/shared exec tsc --noEmit

# Unit тести
pnpm --filter @sto/api test --run 2>&1 | tail -30

# Build
pnpm --filter @sto/api build 2>&1 | tail -10

# Contract тести
pnpm --filter @sto/api test --run --reporter=verbose 2>&1 | grep -E "contract|PASS|FAIL"
```

---

## Крок 5 — Розширені тести (FULL режим)

### 5.1 — Property-based (fast-check)

```bash
grep "fast-check" apps/api/package.json || pnpm --filter @sto/api add -D fast-check
pnpm --filter @sto/api test --run --reporter=verbose 2>&1 | grep -E "invariant|property|PASS|FAIL"
find apps/api/src -name "*.invariants.spec.ts" | sort
```

| Модуль            | Інваріанти                                                                    |
| ----------------- | ----------------------------------------------------------------------------- |
| `work-orders.fsm` | всі пари (from, to) → blocked; ARCHIVED/CANCELLED = порожні                   |
| `inventory`       | quantity≥0, reserved≥0, available≥0 після валідних рухів                      |
| `settlements`     | CHARGE ↑balance; PAYMENT/REFUND/CREDIT_NOTE ↓balance                          |
| `pricing`         | PERCENT = `cost*(1+pct/100)`; округлення кратне roundTo; `Math.max(0,result)` |

### 5.2 — E2E (Playwright)

> **Повний E2E workflow → `/sto-e2e`** (окремий скіл з детальними інструкціями, кодогенерацією через MCP, аналізом падінь).

Мінімальний запуск для автоматичного tester-циклу:

```bash
# Перевірити сервери
docker ps --format "{{.Names}}\t{{.Status}}" | grep -E "postgres|redis|minio"
curl -s http://localhost:3000/api/health | head -c 80 && echo "" || echo "API:DOWN"
curl -s -o /dev/null -w "%{http_code}" http://localhost:3001 | grep -qE "^(200|30)" && echo "WEB:UP" || echo "WEB:DOWN"

# Запуск (82 тести, 8 spec файлів)
cd apps/web && npx playwright test --reporter=list 2>&1 | tee /tmp/pw-results.txt | tail -40
```

**⚠️ STALE API** — `404` при наявному маршруті = stale server. `curl localhost:3000/api/<route>` → `401` = OK, `404` = перезапустити API.

**Структура suite:** `smoke` · `auth-flow` · `work-orders` · `crm` · `settings` · `inventory` · `console-errors` (serial) · `api-errors`

**Auth state** (`e2e/.auth/admin.json`) оновлюється автоматично через `globalSetup`. Якщо відсутній — видалити і перезапустити.

**Падіння → `/sto-e2e debug <spec>`** для повного аналізу.

### 5.3 — Component-тести (Testing Library)

```bash
grep "@testing-library" apps/web/package.json || \
  pnpm --filter @sto/web add -D @testing-library/react @testing-library/user-event @testing-library/jest-dom jsdom
find apps/web/src -name "*.test.tsx" | sort
pnpm --filter @sto/web exec vitest run --reporter=verbose 2>&1 | tail -30
```

---

## Крок 6 — Commit + MemoryManual.md

```bash
git add apps/ packages/ BUG_REPORT.md
git commit -m "fix(tester): <короткий підсумок всіх багів>"
```

Оновити `MemoryManual.md`:

```markdown
## Останній commit

<hash> fix(tester): <message>
Дата: YYYY-MM-DD
Latest tester: YYYY-MM-DD (<режим>, HEAD <hash>) — <N> баги: <перелік>.

## Поточний стан проєкту

TypeScript: ✅ 0 errors
Unit+Contract: ✅ N/N passed
Property-based: ✅ N passed (або ⏭ fast-check не встановлений)
Components: ✅ N passed (або ⏭ @testing-library не встановлений)
E2E (Playwright):✅ N passed (або ⏭ Playwright не встановлений)
```

---

## Крок 7 — Самовдосконалення (ОБОВ'ЯЗКОВО після кожного запуску)

Після виправлення кожного Bug #N — запитай себе:

> **"Цей баг передбачений існуючим пунктом §1.1–§1.7?"**

Якщо **НІ** — одразу оновити цей файл:

1. Додати новий пункт у відповідний розділ з grep-командою
2. Записати підхід у "Накопичені підходи" нижче
3. Commit: `docs(skills): add <баг> to sto-tester checklist`

**Що записувати:**

- Новий **тип бага** якого не було в чеклісті
- Новий **grep-сигнал** для автовиявлення
- **Причину** чому баг виникає (щоб знати де шукати наступного разу)
- **Severity** для калібрування пріоритетів

**Не записувати:** конкретні файли/рядки (вони змінюються); ready-made фікси (для цього є Крок 3).

### Формат запису

```
### [Дата] — [Тип бага] — [Область: backend / frontend / db / security]

**Сигнал:** ознака за якою баг можна знайти або відтворити
**Причина виникнення:** типова помилка розробника або edge case
**Підхід до виявлення:** загальний принцип пошуку (не grep, не файл)
**Підхід до фіксу:** загальний принцип виправлення
**Severity:** CRITICAL / HIGH / MEDIUM / LOW
**Де шукати ще:** суміжні модулі де той самий патерн може повторитись
```

---

## Накопичені підходи (оновлюється автоматично)

### 2026-06-08 — Soft-delete `remove()` НЕ каскадить на 1:1 related @unique tables → re-create блокується pre-check ConflictException (Bug #373) — backend / soft-delete consistency

**Сигнал:** Будь-яка модель X з 1:1 relation до Y через `Y.xId @unique` (наприклад `Employee` ↔ `AuthAccount.employeeId @unique`, `Counterparty` ↔ `SettlementAccount.counterpartyId @unique`). Тип-вказівка resurrection-pattern існує у X.create() (читає soft-deleted Y через інший унікальний ключ типу `@@unique([orgId,email])` для AuthAccount, або `@@unique([orgId,name])` для Counterparty), АЛЕ `X.remove()` тільки soft-delete X. Зв'язаний Y залишається `deletedAt=null`. Pre-check у наступному `X.create()` знаходить активний Y → кидає 409 → resurrection-шлях ніколи не доходить.

```bash
# Знайти @unique поля що посилаються на ID іншої моделі (1:1 з-back):
grep -nE "^\s+[a-z]+Id\s+String\s+@unique" packages/database/prisma/schema.prisma

# Для кожного X (parent), Y (1:1 child з x.Id @unique):
# - X.remove() має містити $transaction що позначає Y як deleted
# - X.create() має знати про resurrection Y (вже існує у багатьох сервісах)
grep -rn "async remove(" apps/api/src/modules/<X>/<X>.service.ts
# Має бути:
#   $transaction(async tx => {
#     updateMany(X, deletedAt:new Date())
#     updateMany(Y, where: { xId: id, orgId, deletedAt:null }, deletedAt:new Date())
#   })
```

**Причина виникнення:** Розробник пише `remove()` лінійно, soft-deleting parent. Не екстраполює що child зі своїм `@unique` блокує майбутній re-create. Resurrection-patch у `create()` (часто added пізніше) логічно припускає що child уже soft-deleted, але насправді коли `remove()` не каскадить — child лишається active → resurrection-шлях dead code.

**Підхід до виявлення:**

1. Для кожного `model X` зі soft-delete (має `deletedAt DateTime?`) — знайти ВСЯ моделі Y що мають `xId String @unique` (back-reference).
2. Для кожної пари (X, Y) перевірити `service.remove(x.id)`:
   - Чи робить `$transaction` що soft-deletes ОБИДВА?
   - Якщо лише X — потенційний bug.
3. Перевірити `service.create()` — якщо містить resurrection-pattern для Y → це сигнал що pair логічно існує і remove має каскадити.
4. Можна також додати E2E-style test: create → remove → re-create з тими ж унікальними полями → має бути 200, не 409.

**Підхід до фіксу:**

```ts
async remove(orgId: string, id: string): Promise<void> {
  const now = new Date();
  const result = await this.prisma.$transaction(
    async tx => {
      const empResult = await tx.X.updateMany({
        where: { id, orgId, deletedAt: null },
        data: { deletedAt: now },
      });
      if (empResult.count === 0) return { empCount: 0 };
      await tx.Y.updateMany({
        where: { xId: id, orgId, deletedAt: null },
        data: { deletedAt: now },
      });
      return { empCount: empResult.count };
    },
    { timeout: TRANSACTION_TIMEOUT_MS },
  );
  if (result.empCount === 0) throw new NotFoundException('...');
}
```

Якщо є 1:N related (`Vehicle` belongs to `Counterparty`) — тут лише soft-delete sibling row ризикує DI-стану; зазвичай не каскадуємо (vehicles переходять до nowhere). Каскадити **тільки 1:1 @unique** і лише ті, де знов-створення parent з тим самим унікальним полем child очікувано.

**Severity:** HIGH — feature є (resurrection), але мертва без cascade. UX перевіряється: користувач бачить "вже використовується" хоча resource видалений → дезорієнтація + неможливість завершити робочий процес (re-hire, re-add контрагента).

**Де шукати ще:**

- `Employee` ↔ `AuthAccount` (Bug #373 — реалізовано).
- `Counterparty` ↔ `SettlementAccount` (counterpartyId @unique) — re-create контрагента з тим самим імʼям блокується?
- `Counterparty` ↔ `CustomerGarage` (isDefault — не unique-by-email, але унікальність by `counterpartyId+isDefault=true` партіальна).
- `Vehicle` ↔ `WatermelonRecord` (mobile sync) — не релевантно для web.
- Будь-який `model X { ... yId String @unique }` де `Y.xId` представляє 1:1.

---

### 2026-06-08 — `seed.ts` залежить від записів які створює інший seed-скрипт, але `prisma db seed` запускає тільки один (Bug #377) — db seed orchestration

**Сигнал:** `seed.ts` (або інший seed-entry) робить `findFirst({ code: 'X' })` АБО `findFirst({ key: 'Y' })` на сутність створену **іншим seed-скриптом** (`seed-catalog.ts`, `seed-templates.ts`, etc.). Якщо не знайдено — fall through до `console.warn('пропущено')` або silent skip. `package.json` `prisma.seed` запускає тільки один із них (`prisma db seed` → `seed.ts`). На свіжому DB (fresh install / CI) → залежність порушена → silent skip → E2E тести/dev workflow ламається без явної помилки.

```bash
# Знайти всі prisma/seed*.ts:
ls packages/database/prisma/seed*.ts

# Знайти cross-file lookups:
# (а) seed.ts шукає категорії що створює seed-catalog
grep -nE "findFirst.*code:\s*['\"]" packages/database/prisma/seed.ts
# (б) seed-catalog шукає org що створює seed.ts (одна модель, інший)
grep -nE "findFirst.*orgId" packages/database/prisma/seed-catalog.ts

# Поточний запуск:
grep -A 2 "\"prisma\":" packages/database/package.json
# Має запускати ВСІ необхідні seed-скрипти у правильному порядку.
```

**Причина виникнення:** Рефакторинг розділив один великий seed на кілька (типово: основа + каталоги + шаблони). package.json `"prisma": { "seed": "..." }` не оновлений → лишається old single-file командою. Розробник тестує локально де `seed-catalog.ts` уже виконаний раніше → не помічає залежність.

**Підхід до виявлення:**

1. ls packages/database/prisma/seed\*.ts → коли є >1 entry, перевірити `package.json.prisma.seed`.
2. Якщо команда запускає лише один → перевірити cross-references між seeds (grep `findFirst` у одному за моделями створених іншим).
3. Якщо знайдено залежність — bug.

**Підхід до фіксу:**

`package.json`:

```json
"prisma": {
  "seed": "ts-node prisma/seed-catalog.ts && ts-node prisma/seed.ts"
}
```

Порядок визначається залежностями. Catalog (без org залежностей бо org-id hardcoded) → seed.ts (потребує work categories created by catalog для Works).

Альтернатива (складніше): зробити `seed.ts` self-sufficient — inline-impl того що seed-catalog робить.

**Severity:** HIGH — fresh-install/CI breaks. Developer onboarding розривається. Виявляється лише на свіжій БД, локально працює бо catalog уже у БД.

**Де шукати ще:**

- Подібний паттерн у `mobile/scripts/seed-watermelon.ts` (якщо існує).
- Будь-який custom seed-orchestrator скрипт у `scripts/`, `tools/`.
- CI workflow YAML — який seed-команду виконує?

---

### 2026-06-08 — Controlled `<select value>` default не поважає dynamic option filter → state-mismatch UX без runtime error (Bug #378) — frontend / controlled-select

**Сигнал:** Picker/date-time/dropdown компонент має `availableOptions` що обчислюється з `props.minX/maxX/filter`. Default `selectedValue` hardcoded (наприклад `'09'`, `'UAH'`, `0`) без посилання на `availableOptions`. Якщо default не входить у `availableOptions` → `<select value="09">` рендериться без відповідної `<option>`. Браузер показує першу опцію візуально, але state value = '09'. React dev console: warning, prod: silent. Користувач:

- Не змінює час → onChange ніколи не fires → form value = '09' → backend валідація (`hour >= minHour`) → 400 → користувач не розуміє чому помилка коли він "не чіпав" поле.

```bash
# Знайти controlled-select з можливою динамічною filter-логікою:
grep -rnE "const \w+\s*=\s*(useMemo|use)?\([^)]*\)?\s*=>\s*[A-Z_]+\.filter\(" apps/web/src/components/ui --include="*.tsx"
# Перевірити чи default value hardcoded:
grep -rnE "selected\w+\s*=.*\?.*:\s*['\"][0-9]+['\"]" apps/web/src/components/ui --include="*.tsx"
```

**Причина виникнення:** Compoent написаний без minHour/maxHour, default '09' працював коли HOURS = [0..23]. Пізніше додано minHour/maxHour для звуження window. Default не оновлено → mismatch.

**Підхід до виявлення:**

1. Знайти controlled-select де value computed з expression: `value ? slice : 'literal-default'`.
2. Перевірити чи 'literal-default' гарантовано у options (`availableHours`/`availableCurrencies`/...).
3. Якщо options можуть бути filtered prop-ом (`minHour`, `excludeCodes`, etc.) → bug.

**Підхід до фіксу:**

```ts
const fallbackHour = availableHours[0] ?? '09';
const selectedHour = selectedTime ? selectedTime.slice(0, 2) : fallbackHour;
```

Перший доступний → завжди валідний. `?? '09'` — last-resort коли availableHours порожній (теоретично — баг, але defense).

**Регресія-guard:** test-кейс `it('коли picker відкривається з порожнім value і minHour=12 — selectedHour дорівнює першій валідній годині')`.

**Severity:** MEDIUM — UX confusion. Не data corruption. Користувач плутається але не пошкоджує дані (валідація на backend ловить → 400).

**Де шукати ще:**

- `currency-picker` (default 'UAH' якщо org currency != UAH → mismatch).
- `language-picker` (default 'uk' якщо org обмежує lang list).
- `payment-method-picker` (default 'cash' якщо isActive=false для cash).
- `unit-of-measure-picker` (default 'шт' якщо org використовує metric).
- Будь-який picker з prop `enabledIds`/`allowedCodes`/`excludeCodes`.

---

### 2026-06-06 — Sibling-handler pattern miss: review-agent виправив один handler з race/404/guard, але дзеркальний sibling у тому ж файлі залишився баговий (Bug #370) — frontend, modal/page CRUD handlers

**Сигнал:** sto-review-agent (або попередня сесія) виправив race-guard / 404-handling / closure-fix у ОДНОМУ handler (`addX`, `deleteY`, `markZ`), але у тому ж файлі є **дзеркальні sibling handlers** (`addContract` поруч з `addVehicle`, `bulkDelete` поруч з `deleteOne`, etc.) які НЕ були touched commit-ом і досі мають той самий патерн. Tester повинен post-review audit-ити **всі handler-функції того ж файлу**, не лише ті що фігурують у diff.

```bash
# Для кожного fixed handler у нещодавньому review-commit — знайти sibling handlers у тому ж файлі:
git log -1 --name-only --format="" | while read f; do
  case "$f" in *.tsx|*.ts)
    # У файлі знайти ВСІ async handler-функції
    grep -nE "const [a-z][a-zA-Z]+ = async \(|const handle[A-Z]" "$f" | head -20
    # Та перевірити чи КОЖНА з них має той самий patch що applied
    # (наприклад: currentCpIdRef.current === cpIdAtStart, або
    #  setSelectedX(prev => prev?.id === id ? null : prev))
  ;; esac
done
```

**Причина виникнення:** Review-agent (або dev) шукає за конкретним рядковим симптомом («бажано додати guard у addVehicle»), фіксить його, але **не екстраполює** на сусідні async handlers того ж файлу. Кожен handler — окремий callsite з copy-paste-style контролем потоку, тому одне і те саме виправлення треба застосувати N разів. Інкрементальні фікси без full-file scan легко лишають дзеркальні баги відкритими.

**Підхід до виявлення:**

1. Прочитати весь файл де applied review-fix (НЕ тільки конкретні handler).
2. Знайти ВСІ async handler-функції — `const X = async () => { ... }`, `const handleX = useCallback(async ...)`, `async function X(...)`.
3. Для КОЖНОЇ перевірити чи присутній той самий patch:
   - **Race-guard (Bug #370):** `const xAtStart = X.id; ... if (currentXRef.current !== xAtStart) return;` після КОЖНОГО await.
   - **404 → soft-handling (Bug #371-suite):** catch-блок розпарсює error message і не показує toast для not-found якщо resource уже видалений.
   - **Functional setter (Bug #371):** `setX(prev => prev?.id === id ? null : prev)` замість `if (selectedX?.id === id) setX(null)`.
   - **Captured closure vs ref-readback:** event handlers що читають state ПІСЛЯ await повинні читати з ref або з functional setter, не з захопленої closure.
4. Якщо хоча б одне — баг. Severity така ж як оригінальний patch (HIGH/MEDIUM/LOW).

**Підхід до фіксу:** Apply той самий patch у sibling handler. Якщо handlers поділяють спільний guard pattern → винести у helper-фукнцію або custom hook (наприклад `useTenantGuardedHandler`). Записати у BUG_REPORT.md з посиланням на original Bug# як «sibling pattern miss».

**Severity:** залежить від конкретного handler:

- HIGH якщо handler пишеться у API/DB → silent data corruption (Bug #370 — contract сюди потрапляє у чужий список).
- MEDIUM якщо лише UI state (toast.error не з того CP).
- LOW якщо edge-case (closure-stale у seldom-changing state).

**Де шукати ще:**

- Будь-який Modal/Page CRUD з 2+ async handlers (`addX`/`deleteX`/`updateX`).
- Calendar/work-orders/contracts/invoices forms — багато CRUD у одному файлі.
- Bulk-actions handlers у list pages (delete/archive/restore/fire) — copy-paste race.
- `useTransition`/`startTransition` обгортки навколо різних action-функцій того ж компонента.

### 2026-06-06 — Mask wrapper re-extracts digits from formatted prefix → country-code accumulates (Bug #369) — frontend, controlled-input wrapper

**Сигнал:** Input-mask wrapper (PhoneInput, CardNumberInput, IBANInput, VinInput) reads `e.target.value` як цілий рядок, витягує `digits = raw.replace(/\D/g, '')`, стрипає фіксований prefix (country code / IBAN code), re-applies формат. Тест repro: `await user.type(input, '<international-prefix><local-number>')` посимвольно → fields-state не співпадає з очікуваним після paste тієї ж строки одноразово. Grep:

```bash
# Знайти wrapper-компоненти що мутирують e.target.value у onChange handler
grep -rn "e\.target\.value\s*=\s*" apps/web/src/components/ui --include="*.tsx" | head -10

# Для кожного — перевірити чи `applyMask`/`format` функція стрипає фіксований
# prefix з digits ДО розпарсити, або з RAW string ДО digit extraction.
grep -rnE "function (apply|format)[A-Z]" apps/web/src/components/ui --include="*.tsx" -A 10
```

**Причина виникнення:** `applyMask` (або `formatPhone`/`formatIBAN`) написана з припущенням «вхід — raw user-typed string без префіксу». Працює для **happy-path одноразової вставки** (`+380501234567`). Але mask wrapper викликається на **КОЖНЕ натискання клавіші**, і React reconciles state ⇄ DOM — `value` prop reflects formatted state, DOM input містить formatted prefix (`+38 (`), і кожен наступний `e.target.value` повертає ВЕСЬ formatted string. `replace(/\D/g, '')` на `+38 (XXX` витягне і `38` з префіксу, і `XXX` з subscriber. Якщо стрип-логіка очікує лише ОДИН `38` prefix → залишковий `38` потрапляє у subscriber → silent number corruption.

**Підхід до виявлення:** Для кожного mask-wrapper в `apps/web/src/components/ui/`:

1. Чи функція форматування може бути викликана **ітеративно з вже-форматованим input**? (Майже завжди — yes, бо controlled inputs re-fire onChange кожен char.)
2. Чи стрип-логіка враховує double-prefix scenarios? Перевірити: подати `applyMask(applyMask('+380501234567'))` → має повернути той самий результат як `applyMask('+380501234567')`.
3. **Idempotency test**: `expect(applyMask(applyMask(x))).toBe(applyMask(x))` для масиву типових входів — паст, частковий ввід, з/без префіксу.
4. **Iterative typing test**: `await user.type(input, '<full-international>')` посимвольно → final state має дорівнювати очікуваному.

**Підхід до фіксу:** Стрипати **фіксований prefix маски** з raw string ПЕРЕД digit extraction:

```ts
function applyMask(raw: string): string {
  let rest = raw;
  // FIXED prefix that mask itself inserts:
  if (rest.startsWith(LOCKED_PREFIX)) rest = rest.slice(LOCKED_PREFIX.length);
  const digits = rest.replace(/\D/g, '');
  // ... country code strip and format
}
```

Це гарантує: mask бачить ЛИШЕ user-supplied portion, ніколи не double-counts власний prefix. Альтернатива (складніша) — track `selectionStart`/`selectionEnd` від попереднього render і diff-only mask. Простіший fix підходить для більшості UX.

**Severity:** HIGH (silent data corruption — невалідний номер потрапляє у БД, бекенд приймає бо це 10 цифр, але користувач думає що ввів інший номер). Особливо боляче для phone numbers — використовуються для SMS/call/notification і помилки виявляються тільки коли callee не відповідає або SMS повертається невдоставленою.

**Regression-guard pattern:**

```ts
it('ітеративний ввід `<international-prefix><local>` → масковано як local', async () => {
  await user.type(input, '380501234567'); // posymvol'no
  expect(state).toBe('+38 (050) 123-45-67');
});
it('idempotency: applyMask(applyMask(x)) === applyMask(x)', () => {
  for (const x of ['+380501234567', '0501234567', '+38 (050) 123-45-67', '']) {
    expect(applyMask(applyMask(x))).toBe(applyMask(x));
  }
});
```

**Де шукати ще:**

- `PhoneInput` (UA `+38 (0XX)`)
- Майбутні mask-обгортки: `CardNumberInput` (`4242-4242-...`), `IBANInput` (`UA21 3322 ...`), `VinInput` (`1HGBH41...`), `EDRPOUInput` (`12345678`), `INNInput` (10 чи 12 цифр), `PaymentReferenceInput`.
- Будь-який `<input>` wrapper що мутирує `e.target.value` напряму у onChange.
- Загальніше: будь-яка функція форматування user input що викликається не лише на paste, але і на keystroke-level зі stateful re-render.

---

### 2026-06-06 — Cascade-clear stale linked FK при зміні parent picker (Bugs #365, #367) — frontend, form-state

**Сигнал:** Form має chained pickers де child FK залежить від parent FK (`counterpartyId` → `vehicleId`; `branchId` → `warehouseId`; `goodCategoryId` → `goodId`). Існує кілька шляхів зміни parent (direct picker, indirect via related-resource picker — наприклад WO-picker замінює counterparty якщо belongs to інший client). Якщо хоча б ОДИН шлях не очищує child FK + cached child-options state, child FK успадковується від попереднього parent → leak до downstream POST → 400/silent FK mismatch на бекенді. Grep:

```bash
# 1. Знайти всі шляхи що змінюють parent FK у формі
grep -n "counterpartyId:" apps/web/src/app/\(app\)/calendar/CalendarSlotModal.tsx | grep "setForm\|setNewWo"

# 2. Для кожного — перевірити чи в тому ж setForm міняється child FK на ''
# Якщо setForm містить counterpartyId але НЕ містить vehicleId: '' → bug
```

**Причина виникнення:** developer чітко продумує очищення FK у ОДНОМУ обвіреному шляху (direct picker — найочевидніший case у дизайні). Indirect paths (WO-picker що side-effect-replaces counterparty після confirm) — забуваються. Особливо коли confirm dialog має branch «replace» vs «don't replace» — їх легко skip під час review. Effect-based clearing (useEffect watching parent FK) теж не спрацьовує: коли child state cleared у setForm у тому ж microtask, effect rolls back до stable parent → fetch starts → setForm overwrite потім — race.

**Підхід до виявлення:** Для кожної form з chained pickers — побудувати матрицю «шляхи зміни parent × поля що очищуються»:

| Path                                  | parentId    | childId     | childCache | otherLinkedData |
| ------------------------------------- | ----------- | ----------- | ---------- | --------------- |
| direct parentPicker.onSelect          | new         | ''          | []         | reset           |
| indirect childPicker що змінює parent | new         | ❓          | ❓         | ❓              |
| onClear()                             | ''          | ''          | []         | reset           |
| modal close                           | (unchanged) | (unchanged) | []         | reset           |

Кожна ❓ — bug. Окремо: effect що fetch-ит child options має setChildOptions([]) на старті (не тільки після успіху), інакше UI рендерить stale options попереднього parent протягом fetch latency.

**Підхід до фіксу:** (1) у КОЖНОМУ setForm де parentId змінюється — explicitly додати child FK clearing + caller для setChildOptions([]) + setRelatedData(null); (2) defense-in-depth у child auto-fill effect: після fetch перевірити чи поточний form.childId є серед нових options, якщо ні — скинути; (3) effect що fetch-ить — скидати state синхронно на старті, не покладатись на cleanup попереднього effect.

**Severity:** HIGH (CRITICAL якщо leak потрапляє у downstream POST з implicit assumption у backend що child belongs to parent — silent corruption / 400 з maddening UX).

**Де шукати ще:** будь-яка форма де FK залежить від іншого FK — Calendar slot (counterparty→vehicle), Work Order (counterparty→vehicle→warranty), Invoice/PO (counterparty→contract→currency), Stock Document (warehouse→stockItem), Settings (branch→cashRegister). Особливо коли picker dialog має «belongs to other counterparty/branch» branch with confirm — кожен такий confirm-flow це окремий path для cascade-clear.

---

### 2026-06-06 — Toggle callback executes full open-logic when CLOSING (Bug #364) — frontend, callback design

**Сигнал:** useCallback handler called from button onClick має `setShow(v => !v)` (toggle pattern) followed by guard-clause + side-effect code (prefill state, API fetch). Side-effects execute БЕЗ check чи ми відкриваємо чи закриваємо. Grep:

```bash
# Знайти toggle handlers що мають дальше side-effects
grep -rn "setShow.*=> !.*;\|setVisible.*=> !.*;" apps/web/src --include="*.tsx" -A 5 \
  | grep -B 1 "apiFetch\|setState\|set[A-Z]" | head -40
```

**Причина виникнення:** функція спочатку написана як «open handler» з prefill+fetch. Пізніше додано toggle через `setShow(v => !v)` щоб клік знову закривав. Author припускає що при closing решта коду нешкідливо повторно встановить state — але реально це (а) робить зайвий fetch (network waste, perf regression на slow connection); (б) перезаписує state що користувач міг змінити у відкритому стані (наприклад, vehicleId selection); (в) може race-state із паралельним effect.

**Підхід до виявлення:** для кожного useCallback що містить `setShow(v => !v)` АБО `setShow(prev => !prev)` — перевірити чи дальший код мав би виконуватись тільки при opening. Якщо так — refactor.

**Підхід до фіксу:** обчислити цільовий стан перед toggle через ref (щоб не додавати у deps), early-return при closing:

```typescript
const showRef = useRef(show);
showRef.current = show;

const handler = useCallback(async () => {
  const willOpen = !showRef.current;
  setShow(willOpen);
  if (!willOpen) return; // ← guard
  // ... prefill + fetch code only runs on open
}, [deps]);
```

Альтернатива: розділити на `openHandler` (без toggle, тільки open) та `toggleHandler` (тільки toggle, без side-effects), використовувати explicit close-button у UI замість toggle.

**Severity:** MEDIUM-HIGH (залежно від cost of side-effects: extra fetch = MEDIUM; state overwrite = HIGH).

**Де шукати ще:** mini-form toggles (showNewWo, showNewCp), expandable sections (showFilters, showAdvanced), sidebar toggles. Будь-який toggle де reuse одного handler для open і close.

---

### 2026-06-06 — Soft string FK без validation (Bugs #359, #361) — backend, data-integrity

**Сигнал:** DTO має string field що концептуально посилається на інший resource (`currencyCode → Currency.code`, `paymentMethodCode → PaymentMethodConfig.code`) АЛЕ Prisma schema зберігає як plain `String` без FK relation. Service пише `dto.X` напряму у persist. Грeп: `grep -rn "code:\s*dto\.\|Code:\s*dto\." apps/api/src/modules --include="*.service.ts" | grep -v "findFirst\|currency.findFirst"` → кожен write без парного existence-check = bug.

**Причина виникнення:** developer обирає soft string FK замість UUID FK для (1) durability (код USD не міняється від reseed), (2) human-readability у raw SQL/exports, (3) easier sync (no UUID translation across orgs). Trade-off: DB integrity не enforces existence — service-layer відповідальність. Easy to forget на new endpoint що додає той же FK з іншого DTO.

**Підхід до виявлення:** статичний grep по `String @db.VarChar(N)` у schema де field name містить семантику reference (`code|type|status|key|method`). Для кожного match — знайти всі сервіси що pишуть це поле і перевірити чи є парний existence-check `findFirst({ orgId, <field>: dto.X, deletedAt: null })`. Особливо у PATCH paths — `create` часто перевірений, `update` забутий.

**Підхід до фіксу:** додати `findFirst` guard у Promise.all з іншими tenant/parent guards у тому ж methodi (-1 RTT vs sequential). `BadRequestException` з locale-message. Для PATCH окремий tenant gain — той самий attack vector як cross-tenant FK injection (Bug #161). Регресія-захист: contract spec `it('POST/PATCH .../<resource> з invalid code → 400')`.

**Severity:** HIGH (silent data corruption; downstream resource lookups fail або UI shows garbage).

**Де шукати ще:** `paymentMethodCode` (PaymentMethodConfig), `eventType` (NotificationTemplate), `documentType` (DocumentNumberConfig), `vatRateName` коли є, `bankCode`, `unitCode` (`UnitOfMeasure.code` — критично, бо кількісні обчислення залежать від canonical unit). Будь-який string field у row моделі (`InvoiceLine`/`PurchaseOrderLine`/`WorkOrderPart`) що іменується `*Code`/`*Type`.

---

### 2026-06-06 — Auto-create child resource ignores parent settings (Bug #360) — backend, business-logic, defaults inheritance

**Сигнал:** `service.create(parent)` всередині `$transaction` робить `tx.<Child>.create({ data: { ..., hardcodedField: 'DEFAULT_VALUE' } })` де `hardcodedField` має парний user-configurable parameter у `OrganisationSettings`/`BranchSettings`. UI tooltip або docs обіцяє «використовується за замовчуванням» — а child з hardcoded value. Grep: `grep -rnE "tx\.[a-z]+\.create\(\s*\{\s*data:\s*\{[^}]*\b(currencyCode|currency|paymentDeferDays|warrantyDays|slotDurationMinutes|invoiceDueDays):\s*['\"]" apps/api/src/modules --include="*.service.ts"`.

**Причина виникнення:** developer вирішує що default у Prisma schema (`currencyCode String @default("UAH")`) — це достатньо. Не помічає що `OrganisationSettings.currency` дозволяє per-org override. Default у schema applies ТІЛЬКИ якщо field omitted, але user expectation: child resource успадковує org settings. Особливо коли auto-create і manual create UI-flow різні: manual flow читає settings, auto не читає.

**Підхід до виявлення:** для кожного `tx.Child.create()` у `service.create()` parent — перевірити чи якесь з полів data має парний user-configurable parameter. Якщо так — fetch parent settings перед `$transaction` (поряд з documentNumberService.next у Promise.all для -1 RTT) і передати inherited value.

**Підхід до фіксу:** parallel-fetch org/branch settings перед `$transaction` body, передати у data. Fallback default (`?? 'UAH'`) для fresh-org case (org settings row може ще не існувати).

**Severity:** HIGH (порушує UX-задекларовану інваріант, silent inconsistency).

**Де шукати ще:** `auto-create Invoice when WO COMPLETED` (settings.invoiceDueDays), `auto-create CalendarSlot from booking template` (settings.slotDurationMinutes), `auto-create Warranty when WO line completed` (settings.defaultWarrantyDays), `auto-create PaymentTransaction після прийому товару` (settings.allowPartialPayment).

---

### 2026-06-06 — Case-sensitive lookup vs canonical-form seed data (Bug #359) — backend, DTO normalization

**Сигнал:** Service робить `findFirst({ where: { code: dto.X } })` де target field зберігається у канонічній формі (UPPERCASE для ISO codes, lowercase для emails, etc.). DTO має лише `@IsString` без `@Transform` для normalize. Fallback UI Input (коли dropdown reference list не завантажилось) приймає raw user typing. Test: `POST .../endpoint { code: 'uah' }` → 400 хоча `UAH` існує. Grep: `grep -rnE "findFirst\(\s*\{\s*where:\s*\{[^}]*\b(code|type|status):\s*dto\." apps/api/src/modules --include="*.service.ts"`.

**Причина виникнення:** Postgres VARCHAR case-sensitive за замовчуванням (без `LOWER(...)` indexing). Developer пише service-lookup as-is, забуваючи що DTO input може прийти у будь-якому case. Frontend «hide» проблему — dropdown використовує canonical values з API. Bug surface через fallback Input (offline-first scenario) або direct API calls (cURL, Postman).

**Підхід до виявлення:** для кожного `findFirst({ where: { code|type|status: dto.X } })` — перевірити DTO field на наявність `@Transform(toUpperCurrencyCode)` / `@Transform(({value}) => value?.toLowerCase())` / etc. ПЕРЕД `@IsString`. Якщо немає — bug.

**Підхід до фіксу:** створити reusable transform helper (`apps/api/src/common/transforms/to-upper-currency-code.ts`) + застосувати у всіх відповідних DTO (Settings, Contracts, BankAccount, CashRegister, etc.). Парний UI-fix: `onChange={e => set(e.target.value.toUpperCase().slice(0, MAX))}` + `maxLength` у fallback Inputs.

**Severity:** HIGH (UX — валідний код → 400 → користувач думає «зламано», система виглядає buggy).

**Де шукати ще:** будь-яке поле що використовує ISO/canonical-form codes — `Currency.code`, `Country.code` (якщо є), email lookups (lowercase), `PaymentMethodConfig.code`, `NotificationTemplate.eventType` (snake_case у DB). Все що `@db.VarChar(N)` де семантика — canonical reference.

---

### 2026-06-05 — E2E тести розходяться з UI після рефакторингу: text-input → EntityPickerField, route rename, dynamic add-button — frontend, e2e

**Сигнал:** Pack of E2E test failures (~10-25 шт) після завершення фічі/рефакторингу. Типові патерни падінь:

1. `locator('input[placeholder*="телефон"], input[placeholder*="Ім\'я"]')` — element(s) not found, бо `<input>` замінений на `EntityPickerField` (button-based picker).
2. `goto('/crm')` → залишається на `/crm/` без redirect на `/login`, бо роут перейменовано (`/crm` → `/counterparties`).
3. `locator('button:has-text("Додати")')` — element(s) not found, бо add-button перейменовано на single-noun (`Додати` → `Зона`/`Правило`/`Документ`).
4. `locator('h2:has-text("X")')` — element(s) not found, бо tabbed pages не мають `<h2>` з назвою таба (тільки `<button>` як таб).
5. `locator('table td').nth(N)` — `unexpected value ""`, бо порядок колонок зсунувся (новий checkbox bulk-actions колонка перед першою колонкою; колонка `lines` тепер `linesCount`, тощо).
6. `button:has-text("+ Додати")` — element(s) not found, бо в кнопці `+` — це icon component `<Plus>`, а `text()` повертає тільки label "Додати".

**Причина виникнення:**

- Фронтенд переходить з вільної форми (text input + autocomplete `[role="option"]`) на стандартизований UI — `EntityPickerField` (display + 3 buttons: clear/detail/picker) + `SearchPickerModal` (окремий dialog з list of result-buttons).
- UI коротшає лейбли кнопок: "Новий рахунок" → "Рахунок", "Створити документ" → "Документ" (single-noun convention).
- Списки додають bulk-actions колонку → всі `nth(N)` зсуваються на +1 (тільки якщо `bulkActionsEnabled` у org-settings — це ще й конфігурабельно).
- Tabbed pages мають один `<h1>` (назва розділу) і кнопки-таби без `<h2>`. Тести помилково чекають `<h2>NameOfTab</h2>` як ready-signal.

**Підхід до виявлення:**

```bash
# 1. Grep усіх text-input placeholder локаторів що можуть таргетити старі inputs
grep -rn "placeholder\*=\"телефон\"\|placeholder\*=\"Ім'я\"\|placeholder\*=\"Назва компанії\"" apps/web/e2e/

# 2. Grep застарілих routes (після rename)
grep -rn "goto('/[oldname]\|toHaveURL.*[oldname]\|href\*=\"/[oldname]\"" apps/web/e2e/

# 3. Grep add-button з generic text
grep -rn "button:has-text(\"Додати\")\|button:has-text(\"Новий\")" apps/web/e2e/

# 4. Grep hard-coded column indices у table cells
grep -rn "locator('td').nth([0-9])\|locator('table td').nth" apps/web/e2e/

# 5. Запустити full suite — failures self-document the gaps
cd apps/web && npx playwright test --reporter=list --workers=2
```

**Підхід до фіксу (test-side, бо UI навмисно змінено):**

1. **EntityPickerField → SearchPickerModal:**

   ```ts
   // ❌ старе
   await modal.locator('input[placeholder*="телефон"]').first().fill('a');
   await page.locator('[role="option"]').first().click();

   // ✅ нове
   await modal.locator('button[aria-label="Обрати"]').first().click();
   const picker = page
     .locator('[role="dialog"]')
     .filter({ hasText: 'Оберіть контрагента' })
     .first();
   await expect(picker).toBeVisible({ timeout: 5_000 });
   // Результати — <button class="w-full text-left ..."> у SearchPickerModal
   const firstResult = picker.locator('button.w-full.text-left').first();
   await firstResult.click();
   await expect(picker).not.toBeVisible({ timeout: 5_000 });
   ```

2. **Route rename:** глобальна заміна `'/crm'` → `'/counterparties'` у всіх spec файлах. Перевірити окремо: PROTECTED_PAGES масиви, регекси `toHaveURL(/\/crm/)`, hrefs `a[href*="/crm"]`.

3. **Add-button single-noun:** замінити `button:has-text("Додати")` на `getByRole('button', { name: /^Зона$/ })` (точна назва). Для tabbed pages — побудувати map: `{ Зони: 'Зона', Пости: 'Пост', Склади: 'Склад' }`.

4. **Tabbed page ready-signal:** замість `h2:has-text("TabName")` — `h1:has-text("PageName")` + чекати add-button з expected label.

5. **Column index instability:** замість `locator('td').nth(N)` — фільтрувати by content:

   ```ts
   const firstDateCell = page
     .locator('tbody tr')
     .first()
     .locator('td')
     .filter({ hasText: /^\d{2}\.\d{2}\.\d{4}$/ })
     .first();
   ```

   Стійко до зміни порядку колонок, наявності bulk-actions checkbox колонки, кастомізації user-side.

6. **Icon-only button text:** замість `button:has-text("+ Додати")` — `getByRole('button', { name: /^Додати$/ })`. Icon рендериться через `leftIcon={<Plus />}`, не входить у accessible name.

7. **Pagination + sort:** якщо тест створює запис і шукає рядок by `:has-text(unique-name)`, але список відсортований і paginated — спочатку зробити пошук:
   ```ts
   const searchInput = page.locator('input[placeholder*="Пошук"]').first();
   if (await searchInput.isVisible({ timeout: 3_000 })) {
     await searchInput.fill(uniqueName);
     await page.waitForTimeout(500);
   }
   ```

**Правило: тест падає = щось зламано** — спочатку зрозуміти що реально змінилось у UI (читати page.tsx, modal component, real DOM via error-context.md). Якщо UI навмисно змінений — оновити тест. Якщо UI має баг — виправити UI. НЕ додавати `if (await x.isVisible()) return` — це маскує проблему.

**Severity:** HIGH — block release, but easy to fix mechanically once pattern is identified.

**Де шукати ще:** усі spec файли що взаємодіють з модалкою створення (counterparty, supplier, good, employee, invoice, purchase-order, stock-document), tabbed pages (infrastructure, settings, catalog), сторінки з таблицями що мають bulk-actions. Після кожного rename / "single-noun" cleanup / picker-migration — full suite run обов'язковий.

---

### 2026-06-05 — Dead `/X/new` маршрут у keyboard shortcut / Command Palette (Bug #354) — frontend, routing

**Сигнал:** Power-user UX feature (keyboard shortcut `N`, Command Palette "Новий X") робить `router.push('/X/new')` або `href: '/X/new'`, але папка `apps/web/src/app/<group>/X/new/` НЕ ІСНУЄ. Next.js `[id]` dynamic route ловить `'new'` як параметр id → `apiFetch('/X/new')` → 404 або broken detail page. tsc green бо `router.push` приймає будь-який рядок; runtime НЕ падає одразу — користувач бачить порожній/помилковий екран.

**Причина виникнення:** Розробник копіює патерн з іншого ресурсу що ДІЙСНО має окрему `/X/new` сторінку (наприклад `vehicles/new/`), не перевіривши що для нового ресурсу create-flow — модалка (`setModal(true)` на page.tsx). Або: команда планувала створити `/X/new` маршрут пізніше, але feature перейшла на модальний flow, а посилання у shortcuts/commands залишились.

**Підхід до виявлення:**

```bash
# Знайти кожне посилання '/X/new' у keyboard shortcuts + commands + nav helpers
grep -rn "router\.push('/[^']*/new')\|href:\s*'/[^']*/new'" apps/web/src --include="*.ts" --include="*.tsx"

# Для кожного знайденого URL — перевірити чи відповідна директорія існує
# (адаптуй під ваш monorepo шлях):
for url in $(grep -rohE "/[a-z-]+/new" apps/web/src --include="*.ts" --include="*.tsx" | sort -u); do
  base=$(echo $url | cut -d/ -f2)
  test -d apps/web/src/app/\(app\)/$base/new && echo "OK: $url" || echo "DEAD: $url"
done
```

**Підхід до фіксу:** Якщо ресурс має create-flow через модалку:

1. Замінити URL на `?action=new` query param:
   ```ts
   router.push('/X?action=new');
   // АБО у command:
   href: '/X?action=new',
   ```
2. Додати listener у page.tsx:
   ```ts
   const searchParams = useSearchParams();
   useEffect(() => {
     if (searchParams?.get('action') === 'new') {
       setModal(true);
       router.replace('/X', { scroll: false }); // прибрати query
     }
   }, [searchParams, router]);
   ```
3. ОБОВ'ЯЗКОВО обгорнути page у `<Suspense fallback={null}>` (Next.js static-export вимога для `useSearchParams`):
   ```tsx
   export default function XPage() {
     return (
       <Suspense fallback={null}>
         <XPageInner />
       </Suspense>
     );
   }
   function XPageInner() {
     /* original logic */
   }
   ```

Якщо ресурс ДІЙСНО має мати `/X/new` сторінку (як `vehicles/new`) — створити directory `apps/web/src/app/<group>/X/new/` з парою `page.tsx` + `PageClient.tsx`.

**Severity:** HIGH — feature декларується (видима у Command Palette/Help-toast), але маршрут broken → 404 → frustration.

**Де шукати ще:** `apps/web/src/hooks/useGlobalShortcuts.ts`, `apps/web/src/lib/commands.ts`, `MASTER_NAV_ITEMS` (`apps/web/src/lib/nav-items.ts`), будь-який inline `<Link href="/X/new">` у компонентах. Особливо після рефакторингу що міняє створення з окремої сторінки на модалку — посилання на `/new` зазвичай залишаються.

---

### 2026-06-05 — TanStack Query queryKey shape contract: helper-hook vs factory vs prefetch (Bugs #355-#356) — frontend, react-query, cache-correctness

**Сигнал:** TopShell/nav-prefetch на hover «гріє» дані (`qc.prefetchQuery({ queryKey: xKeys.list({...}) })`), але після click на nav-link сторінка все одно робить FETCH вдруге. У DevTools Network: 2 запити на той самий endpoint (один з prefetch-source, один з page-mount). Prefetch-data існує у cache (qc.getQueryCache().getAll() показує запис), але сторінка читає з ІНШОГО slot.

Два корені проблеми (часто разом):

1. **Helper-hook queryKey shape ≠ factory shape** — `usePaginatedList(endpoint, filters, { queryKey: 'X' })` будує `[key, filters]` (2-element), але парний `xKeys.list(filters)` = `[...all, 'list', filters]` (3-element). Без `'list'` як другого елемента — різний hash → різні slots.
2. **Prefetch filter object ≠ page first-mount filter object** — TopShell прокидує `{ page:1, limit:20, status:'', q:'' }`, але page-side hook на mount передає `{ page:1, limit:20, status:'', q:'', sortBy:'createdAt', sortDir:'desc', dateFrom: kyivToday(), dateTo: kyivToday(), showDeleted: false }` (через `useSortState` + `kyivToday()` initializers). Hash об'єктів різний → різні slots.

**Причина виникнення:**

1. Розробник, що пише helper (`usePaginatedList`), не знає про factory convention (`xKeys.all + 'list' + filters`) або вирішує не дотримуватись бо «коротше». Тести helper-а зазвичай мокають через `apiFetchMock` + assertять URL — не queryKey shape.
2. Розробник, що додає новий filter поле на сторінку (наприклад `dateFrom` через `kyivToday()` default), забуває оновити парний prefetch у TopShell. Code review не ловить — це cross-file invariant.

**Підхід до виявлення:**

```bash
# Audit 1 — helper queryKey shape vs factory:
grep -rn "queryKey:\s*\[.*filters\]" apps/web/src/hooks/api/ --include="*.ts"
# Для кожного знайденого helper — перевірити парний factory у тому ж файлі або імпортованому:
# - `XKeys.list = [...XKeys.all, 'list', filters]` (3-element factory)
# - helper `queryKey: [key, filters]` (2-element) → bug
# - helper `queryKey: [key, 'list', filters]` (3-element) → OK

# Audit 2 — TopShell prefetch payload-shape vs page first-mount:
# Знайти кожен prefetchQuery у TopShell:
grep -n "prefetchQuery\|queryKey:" apps/web/src/components/TopShell.tsx
# Для кожного — знайти page-споживач (`use<Resource>` callsite) і порівняти filter object:
# наприклад, для '/work-orders': прочитати apps/web/src/app/(app)/work-orders/page.tsx
# знайти `useWorkOrders({...})` і порівняти всі keys + initial values.
# `useSortState('createdAt', 'desc')` → page додає sortBy/sortDir defaults.
# `useState(() => kyivToday())` → page додає dateFrom/dateTo defaults.
```

**Підхід до фіксу:**

Для проблеми #1 (helper shape):

```ts
// Before:
return useQuery({ queryKey: [key, filters], ... });
// After:
return useQuery({ queryKey: [key, 'list', filters], ... });
```

Для проблеми #2 (prefetch payload):

```ts
// TopShell PREFETCH_MAP:
'/work-orders': qc => {
  const today = kyivToday(); // важливо викликати у функції, не на module-level
  void qc.prefetchQuery({
    queryKey: workOrdersKeys.list({
      page: 1, limit: 20, status: '', q: '',
      showDeleted: false, repairCategory: undefined, employeeId: undefined,
      dateFrom: today, dateTo: today,         // ← з kyivToday() initializer
      sortBy: 'createdAt', sortDir: 'desc',   // ← з useSortState defaults
    }),
    queryFn: ({ signal }) => apiFetch(`/work-orders?page=1&limit=20&dateFrom=${today}&dateTo=${today}&sortBy=createdAt&sortDir=desc`, { signal }),
    staleTime: 30_000,
  });
},
```

Захищеніший паттерн на майбутнє: експортувати `defaultXFilters()` з hook-файлу:

```ts
// useWorkOrders.ts
export const defaultWorkOrdersFilters = (today: string) => ({
  page: 1,
  limit: 20,
  status: '' /* ... всі defaults */,
  dateFrom: today,
  dateTo: today,
  sortBy: 'createdAt' as const,
  sortDir: 'desc' as const,
});
// Викликати з обох місць — TopShell + page → одна single source of truth.
```

**Регресія-guard:**

```ts
// usePaginatedList.test.tsx — assert queryKey shape:
const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
// ... render hook with custom QueryClientProvider ...
const cache = qc.getQueryCache().getAll();
expect(cache[0]?.queryKey).toEqual([key, 'list', filters]);

// TopShell integration test (бракує — додати у наступну сесію):
// 1. Render TopShell + trigger /work-orders prefetch
// 2. Render WorkOrdersPage у тому ж QueryClient
// 3. Очікувати cache.length === 1 (один slot, не два)
```

**Severity:** MEDIUM — silent perf regression, ніяких помилок чи broken UX, тільки +1 RTT при кожній nav-click. Виявляється тільки якщо порівняти DevTools Network з UX-обіцянкою «instant nav».

**Де шукати ще:**

- Усі shared helpers у `apps/web/src/hooks/api/` що приймають `queryKey` як option (`usePaginatedList`, custom paginated hooks).
- Кожен `prefetchQuery` у `TopShell.tsx` PREFETCH_MAP.
- Кожен `useQuery({ queryKey: xKeys.X() })` де `xKeys.X` — factory function: якщо хтось десь робить prefetch з тим самим `xKeys.X()`, але різним аргументом → mismatch.
- Кожен `setQueryData` / `getQueryData` з literal queryKey (не через factory) — те саме що prefetch.

---

### 2026-06-04 — Hardcoded document-number у auto-create обхід DocumentNumberService (Bug #348) — backend, bizlogic

**Сигнал:** Feature додає **двосторонню** генерацію нумерованих документів: (а) основний UI-flow через `service.createX(dto)` що правильно викликає `documentNumberService.next(orgId, 'X_TYPE')`; (б) допоміжний auto-create-flow всередині сервісу (наприклад, у `service.create()` контрагента — автоматичний договір при `type=SUPPLIER`) що пише hardcoded literal (`number: '1'`, `number: 'AUTO'`, `number: 'DEFAULT'`). Регресія невидима у tsc/unit-tests (mock-based) і у happy-path manual — лише при додаванні наступного документа того ж типу користувач бачить порушений порядок: `'1'`, `'ДГ-2026-000001'`.

**Причина виникнення:** Розробник копіює inline `tx.X.create({ data: { number: '1', ... } })` як placeholder з намірою «доробити пізніше» і забуває. tsc green бо `number: string` приймає будь-який. Тести з повним feature-flow (POST /counterparties → POST /contracts → GET /contracts) не запускаються в unit-suite. Виявляється тільки manual-чергою документів у production.

**Підхід до виявлення:**

```bash
# 1. Для кожної моделі що має `number String` поле + згадку у DocumentNumberConfig seed → service.create*
#    що пише цей `number` у БД, але НЕ через documentNumberService.next() — це bug.
grep -rn "DocumentType\\.[A-Z_]\\+" packages/database/prisma/seed.ts | awk '{print $NF}' | tr -d ',"' | while read dtype; do
  grep -rn "number:\\s*['\"][^'\"]*['\"]" apps/api/src/modules --include="*.service.ts" \
    | grep -v "spec\\|//\\|toDto\\|description" \
    | grep -v "documentNumberService\\|docNumbers\\.next\\|generateNext" \
    | head -10
done

# 2. Будь-який literal-number у data-spread у tx.<Model>.create
grep -rnE "tx\\.[a-z]+\\.create\\(\\s*\\{\\s*data:\\s*\\{[^}]*\\bnumber:\\s*['\"]" apps/api/src/modules --include="*.service.ts"
```

**Підхід до фіксу:** Перед `$transaction` (DocumentNumberService.next відкриває власний `$transaction` з `SELECT FOR UPDATE` — nesting deadlock-небезпечне) — викликати `await this.documentNumberService.next(orgId, '<TYPE>')`, передати результат як параметр у tx-callback. Якщо `next()` потрібно за умовою — обчислити умову раніше і call-only-if. Auto-create-flow МАЄ використовувати ту ж саму систему нумерації що і ручний UI-flow — інакше порушується monotonic-нумерація.

**Severity:** HIGH — feature декларується як «автоматично створюється договір», користувач бачить inconsistent номери документів.

**Де шукати ще:** будь-який `service.create()` що auto-створює side-resource: counterparty→contract, work-order→completion-act, invoice→payment, vehicle→default-tax-rate, employee→default-branch-assignment. Перевіряти кожний `tx.X.create({ data: { number: 'literal' } })` всередині parent-сервісу.

---

### 2026-06-04 — Soft-delete primary без auto-promote next sibling (Bug #351) — backend, bizlogic

**Сигнал:** Сутність має `isPrimary Boolean` / `isDefault Boolean` поле для відмітки «головного у scope». `service.remove(parentId, childId)` робить soft-delete (`deletedAt = new Date()`) **без** перевірки `existing.isPrimary` і **без** auto-promote next sibling. Інваріант «у scope завжди ≥1 primary якщо існують активні рядки» порушений. Наступний код що читає primary (`findFirst({ orderBy: [{isPrimary:'desc'},{createdAt:'asc'}] })`) повертає випадковий non-primary запис.

Frontend-side частина проблеми вже описана у Bug #226-#227 (sub-resource default-flag mutation → parent-list staleness). Цей патерн — backend-side: сам сервіс не підтримує інваріант при delete.

**Причина виникнення:** При написанні `remove()` розробник копіює стандартний soft-delete шаблон `prisma.X.updateMany({where:{...},data:{deletedAt:new Date()}})` без додавання промоушн-логіки. tsc green, unit test без real-DB зелений (mock не моделює invariant), happy-path manual теж не помічає бо primary-rows зазвичай останніми видаляються. Виявляється коли система пізніше залежить від primary (PurchaseOrder.create без contractId → findFirst → null).

**Підхід до виявлення:**

```bash
# Для кожної моделі з isPrimary/isDefault полем → service.remove() / service.deleteX()
grep -rnE "isPrimary\\s+Boolean|isDefault\\s+Boolean|isMain\\s+Boolean" packages/database/prisma/schema.prisma
# для кожної моделі знайти service.remove() / removeX() / deleteX()
# перевірити чи є логіка:
#   if (existing.isPrimary) { findFirst({orderBy:createdAt asc, NOT:{id}}) → update({isPrimary:true}) }
grep -rnE "isPrimary|isDefault" apps/api/src/modules/<module>/<module>.service.ts | grep -v "spec\\|toDto"
```

**Підхід до фіксу:** У `remove()` сервісу:

1. Прочитати existing з `select: { id, isPrimary, <scopeFieldType> }`.
2. У `$transaction`:
   - `tx.X.updateMany({where:{...},data:{deletedAt:new Date()}})`.
   - `if (existing.isPrimary)` → `const next = await tx.X.findFirst({where:{<scope>, deletedAt:null, id:{not:id}}, orderBy:{createdAt:'asc'}, select:{id:true}})`.
   - `if (next)` → `tx.X.update({where:{id:next.id}, data:{isPrimary:true}})`.

Regression-guard test (vi.fn $transaction з callback): asser что при `existing.isPrimary === true` І `findFirst` повертає `next` → `update({where:{id:'next'}, data:{isPrimary:true}})` викликаний.

**Severity:** HIGH (бізнес-інваріант силentlу порушений; impact на downstream auto-selection logic — наприклад PurchaseOrder.create без contractId → випадковий вибір).

**Де шукати ще:** CounterpartyContract.isPrimary, CustomerGarage.isDefault, GoodUoM.isDefault, Barcode.isPrimary, VehicleTaxRate.isActive, EmployeeBranch.isDefault, PaymentMethodConfig.isDefault, NotificationTemplate.isDefault. Будь-який scope-обмежений boolean «головний». Профілактика: для кожної моделі з `isPrimary/isDefault` створити contract-spec що демонструє promote-after-delete invariant.

---

### 2026-06-03 — Stale contract-spec через arg-count drift після додавання нового positional query-param (Bug #340) — backend, contract tests

**Сигнал:** Усі existing `toHaveBeenCalledWith(orgId, ...8 args)` у `*.contract.spec.ts` модуля раптом починають падати після безпечного-на-вигляд feature commit (`feat(ui|api): column sorting`/`feat(api): X filter`). Error pattern: `Expected: [...N args], Received: [...N+1 or N+2 args, +undefined, +undefined]`. tsc green, інші тести того ж модуля та інших модулів зелені.

**Причина виникнення:** Контролер форвардить query-params у service-метод як **positional arguments** (`this.service.findAll(orgId, query.page, query.limit, query.status, ..., query.sortBy, query.sortDir)`). Коли feature додає 2 нових опціональні параметри (`sortBy`, `sortDir`), розробник просто додає їх у кінець positional list — TS не скаржиться бо service-сигнатура теж розширилась з опціональними `sortBy?: string, sortDir?: string`. Існуючі contract specs (з попередніх Bug #X regression-guards) асертять ТОЧНУ кількість args через `toHaveBeenCalledWith(...)`, який в Vitest суворо порівнює довжину масиву → 8 args expected vs 10 received → AssertionError. Сторонній ефект: ВСІ existing contract tests того модуля падають одразу → baseline червоний → release-blocker.

**Підхід до виявлення:**

```bash
# Pre-commit (виявити перед commit ще під час реалізації feature)
git diff --staged -- "*.controller.ts" | grep -E "^\+.*\bquery\.[a-zA-Z]+\b.*,?\s*$"
# для кожного нового query.X arg → знайти всі toHaveBeenCalledWith у тому модулі
git diff --name-only --staged -- "*.controller.ts" | while read ctrl; do
  module=$(dirname "$ctrl")
  spec=$(find "$module" -name "*.contract.spec.ts" 2>/dev/null)
  [ -n "$spec" ] && grep -n "toHaveBeenCalledWith" "$spec"
done

# Post-commit baseline (як Tester виявляє Bug #340)
pnpm --filter @sto/api test --run 2>&1 | grep "Received:" -A 12 | grep -E "^\+\s*undefined,$"
# Якщо знайдено "+   undefined," у diff → arg-count drift
```

**Підхід до фіксу:** Додати `undefined, undefined` (або значення нових parametrів) у КОЖЕН `toHaveBeenCalledWith` у тому модулі. **Долгосрочний фікс (рекомендований):** мігрувати controller-service interface на **object-form** замість positional: `this.service.findAll(orgId, { page, limit, status, sortBy, sortDir })` — тоді existing contract specs продовжать працювати з `expect.objectContaining({page, limit, status})` без оновлення; нові поля у об'єкті не ламають assertion. Object-form має додаткові переваги: required vs optional чітко видно, легше додавати/видаляти поля, IDE autocomplete з типу.

**Severity:** MEDIUM (release-blocker — baseline червоний → tester-сесії неможливі)

**Де шукати ще:** Кожен sprint `feat(api|ui): add X filter|sort` що чіпає `*.controller.ts` — особливо list endpoints з паттерном Bug #339 (regression-guard tests на forwarding). Найбільш вразливі: `work-orders`, `invoices`, `purchase-orders`, `stock-documents`, `inventory`, `crm/counterparties`, `vehicles`, `employees` — будь-який контролер з фільтр-параметрами що growing-set.

---

### 2026-06-03 — Stale mock після додавання cascade-helper у service-method (Bug #340b) — backend, test-coverage

**Сигнал:** Existing service-spec тест раптом падає з `TypeError: X is not iterable` або `Cannot read property 'length' of undefined` у helper-метод (`getDescendantIds`, `getAncestorIds`, `expandX`). Stack trace показує `for (const c of all)` де `all` повертається з невмоканого `prisma.<model>.findMany(...)`.

**Причина виникнення:** Review/feature додав НОВИЙ behavior у існуючий service-метод (cascade-update, propagation, related-records expansion) через приватний helper. Helper викликає Prisma read-op (`findMany`, `count`, `groupBy`), який існуючий spec не мокав бо до фіксу метод не робив цього виклику. Mock повертає `undefined` за замовчуванням → ітерація по `undefined` крашиться. **Парний патерн** Bug #200 (Defense-in-depth status guard + stale fixtures) — той самий принцип «новий read у сервісі → новий mock у spec», але через helper-метод замість direct field-read.

**Підхід до виявлення:**

```bash
# Знайти review/feature commit що додав helper
git log --oneline -10 -- apps/api/src/modules/<module>/<module>.service.ts | head -3
git show <commit> -- "*.service.ts" | grep -E "^\+.*await this\.(get|expand|cascade|propagate|collect|gather)"

# Для кожного знайденого helper — перевірити що spec мокає Prisma read-ops helper-а
grep -n "private async <helper>" apps/api/src/modules/<module>/<module>.service.ts -A 15
# знайти всі `prisma.<model>.<readOp>` всередині helper
# у spec — додати `prisma.<model>.<readOp>.mockResolvedValueOnce([])` перед викликом service-method
```

**Підхід до фіксу:** Додати `mockResolvedValueOnce([])` (або відповідний default empty-state) для кожного нового Prisma read-op у helper, ПЕРЕД викликом service-методу у тесті. Альтернатива: уніфікувати mock через `beforeEach(() => { prisma.<model>.findMany.mockResolvedValue([]) })` — лиш якщо тести не залежать від конкретного return value.

**Severity:** MEDIUM (release-blocker — guard-тести не запускаються через crash)

**Де шукати ще:** Cascade-update паттерни — toggleActive, archive, deactivate, remove (з soft-delete на нащадків), restoreCascade. Особливо вразливі: ієрархічні моделі з `parentId` (GoodCategory, WorkCategory, Branch hierarchy), графи (WorkGoodCategoryLink, Permission roles).

---

### 2026-06-03 — Review-fix completeness audit для крос-файлових патернів (Bug #341) — frontend, refactoring

**Сигнал:** Tester виявляє новий bug з ТИМ САМИМ патерном як review-fix що вже виправив його у N файлах. Файл який пропустили — зазвичай `[id]/PageClient.tsx`, `*Tab.tsx`, або sub-component, що не у root route folder. Grep-команда з review-fix без файлового filter знаходить додатковий match-set.

**Причина виникнення:** Review-агент часто шукає bug-патерн у scope недавніх commits / specific files (наприклад `apps/web/src/app/(app)/X/page.tsx`) і ефективно фіксить там, але не виконує full-codebase grep на той самий патерн. Розробник, який раніше додав файл з тим патерном у іншому folder (наприклад `[id]/PageClient.tsx` коли review працював на root `/page.tsx`), залишається з невиправленим патерном. tsc green бо bug — runtime (silent .catch ховає помилку), unit tests green бо silent .catch не тестується unit-тестами.

**Підхід до виявлення:**

```bash
# Після кожного review-fix commit
last_review=$(git log --oneline -10 | grep "fix(review)" | head -1 | awk '{print $1}')
# 1) Витягти grep-патерн з commit message або з diff (заміна "X" на "Y")
pattern=$(git show "$last_review" -- "*.ts" "*.tsx" | grep "^-" | grep -oE '[\.]catch\(\(\) => \{\}\)' | head -1)
# 2) Виконати full-codebase grep
grep -rn "$pattern" apps/web/src --include="*.tsx" --include="*.ts"
# 3) Виключити файли вже виправлені review-fix
git show --stat "$last_review" -- '*.tsx' '*.ts' | awk '/^ /{print $1}' | head -10
# 4) Усі match-и поза цим списком = upskipped review = новий Bug нового tester-циклу
```

**Підхід до фіксу:** Застосувати ТУ САМУ заміну (з review-fix) до пропущених файлів. Якщо знайдене місце легітимно потребує silent поведінку (toast-double-protection, fire-and-forget telemetry, optional SW registration) — задокументувати у коментарі біля коду АБО у BUG_REPORT.md як «Залишені «легітимні» silent .catch».

**Severity:** Успадковує severity оригінального review-fix bug-у (зазвичай MEDIUM для debug-ability)

**Де шукати ще:** Будь-який review-fix commit з `fix(review): replace X with Y` патерном — особливо у файл-категоріях що часто пропускаються: `[id]/PageClient.tsx` (dynamic-route detail), `*Tab.tsx` (tabbed sub-content), `components/<feature>/<sub>.tsx` (внутрішні компоненти фічі), `hooks/api/use*.ts` (data-fetch hooks). Пул silent .catch / .then-without-catch / unmocked side-effect — найчастіші drift патерни.

---

### 2026-06-03 — Нові query-param фільтри без contract-spec coverage (Bugs #338, #339) — backend, contract tests

**Сигнал:** Sprint додає нові query-param фільтри (`dateFrom`/`dateTo`) до кількох контролерів. Contract specs для деяких модулів не існують взагалі (invoices, stock-documents) або не покривають нові параметри (work-orders). TS green, unit tests green — але якщо контролер перестане прокидати параметри у сервіс (наприклад через рефакторинг Query DTO або додавання нового параметра поверх старих), регресія залишається непоміченою до ручного QA або баг-репорту від користувача.

**Причина виникнення:** Розробник додає `dateFrom/dateTo` у DTO + controller + service за раз. Якщо contract spec вже існує — тести для старих параметрів passing, нові не додаються. Якщо contract spec відсутня — ніхто її не пишe бо "controller простий, просто проксіює". Справжня цінність contract spec — саме в тому, що контролер є intercept-точкою: DTO transformation, @Transform decorators, parameter forwarding — все це видиме ТІЛЬКИ через HTTP contract test.

**Підхід до виявлення:**

```bash
# Крок 1: знайти всі модифіковані QueryDto файли у diff
git diff HEAD~5 HEAD --name-only | grep -E "\.dto\.ts$"

# Крок 2: для кожного DTO перевірити чи contract spec покриває нові поля
for dto in $(git diff HEAD~5 HEAD --name-only | grep "\.dto\.ts$"); do
  module=$(dirname "$dto")
  spec=$(find "$module" -name "*.contract.spec.ts" 2>/dev/null | head -1)
  new_fields=$(git diff HEAD~5 HEAD -- "$dto" | grep "^+" | grep -oE "[a-z][a-zA-Z]+\?" | tr -d '?' | head -5)
  if [ -z "$spec" ]; then
    echo "NO SPEC: $module (missing contract spec entirely)"
  else
    for field in $new_fields; do
      grep -q "$field" "$spec" || echo "MISSING TEST: $field not covered in $spec"
    done
  fi
done

# Крок 3: якщо контролер передає query як цілий об'єкт (не spread) — перевірити call-assert форму
grep -n "service.findAll\|serviceMock.findAll" apps/api/src/modules/*/\*.contract.spec.ts 2>/dev/null | grep -v "mock\|fn()" | head -20
```

- [ ] Кожен sprint що додає нові query-param поля у QueryDto (`dateFrom`, `dateTo`, `branchId`, `vehicleId`, `q`) → парний test у contract spec (`toHaveBeenCalledWith(..., dateFromValue, dateToValue)`)
- [ ] Якщо contract spec модуля відсутня + модуль має нову фільтрацію → **обов'язково створити базовий spec** з мінімум: GET 200, GET з новими params, POST без mandatory fields → 400, GET без JWT → 403
- [ ] Якщо контролер передає `@Query() query: XxxQueryDto` як ціліснй об'єкт до сервісу → тест через `serviceMock.findAll.mock.calls[callsBefore]![1] as Record<string, unknown>` → `expect(queryArg.dateFrom).toBe(...)` (не `toHaveBeenCalledWith` бо форма аргументу — объект, не spread)

**Підхід до фіксу:**

1. Визначити: controller передає params як spread чи як QueryDto об'єкт? (`service.findAll(orgId, query)` vs `service.findAll(orgId, query.page, query.limit, ...)`).
2. Для spread-стилю — оновити `toHaveBeenCalledWith('org-1', 1, 20, ..., dateFrom, dateTo)`.
3. Для object-стилю — асертити `queryArg.dateFrom` та `queryArg.dateTo` через `mock.calls[idx][1]`.
4. При відсутній spec — створити базову (9-12 тестів): GET pagination shape, GET 403, GET limit=201 400, GET з новими params, POST mandatory 400, POST valid 201, POST з empty field → undefined (emptyToUndefined).

**Severity:** LOW — відсутність тестів не є runtime bug, але залишає regression-blind зону після кожного sprint що додає query params.

**Де шукати ще:**

- Кожен sprint що додає date-range фільтри (`documentDate`, `createdAt range`, `dueDate range`) — перевірити що існуючий contract spec оновлено
- Модулі з `findAll(orgId, ...args)` signature (spread) vs `findAll(orgId, query)` (object) — різна форма assertion у тестах
- Нові модулі без contract spec взагалі: `find apps/api/src/modules -name "*.controller.ts" | while read c; do d=$(dirname "$c"); ls "$d"/*.contract.spec.ts 2>/dev/null || echo "NO SPEC: $d"; done`

---

### 2026-06-03 — Bool prop early-return у useEffect — обидві гілки потребують regression-guard (Bug #336) — frontend, hooks & component props

**Сигнал:** Існуючий компонент (`AnimatedBody`) отримує новий boolean prop (`fill?: boolean`), який міняє поведінку `useEffect`: legacy шлях (default `false`) залишається з ResizeObserver + JS height-setting, новий шлях (`true`) робить early-return одразу після перевірки prop. Тести компонента покривають лише legacy шлях (`fill=false`) — як той що було. Якщо хтось рефакторить умову на інверсну (`if (!fill) return` замість `if (fill) return`), або переплутає присвоєння через rebase merge conflict, JS-логіка активується для нової гілки (fill=true) → CSS layout assumption (`flex-1 min-h-0 overflow-y-auto`) ламається `outer.style.height = inner.scrollHeight` → outer "застрягає" на висоті контенту, flex-розтягування не працює. tsc green, unit tests green (legacy шлях не зачеплений), баг видно тільки manual QA — footer Modal "пливе" / panel скорочується.

**Причина виникнення:**

1. Розробник додає булевий feature-flag prop у існуючий хук/компонент думаючи "default зберігає поведінку". Тести не оновлюються бо "default-шлях не змінено".
2. Нова гілка коду виглядає тривіальною (`if (fill) return;`) — здається не потребує тесту, "просто пропускає setup".
3. Документація-коментар описує контракт ("JS-керування ВИМКНЕНЕ для fill"), але без тесту цей інваріант не зафіксований у CI.

**Підхід до виявлення:**

1. `git diff HEAD~5 HEAD --name-only | xargs grep -l "useEffect\|useLayoutEffect"` → для кожного файлу з зміною hook-body перевірити чи доданий новий prop у JSX-сигнатурі.
2. Якщо у `useEffect` додано умовний early-return на основі boolean prop:
   ```bash
   grep -nE "if \(\w+\) return;?$" apps/web/src/components --include="*.tsx" -A1 -B5 | grep -B1 -A8 "useEffect\|useLayoutEffect"
   ```
3. Перевірити чи `*.test.tsx` має тест(и) для **обох гілок**:
   - `prop=true` → setup НЕ виконується (spy на ключовий side-effect — `new ResizeObserver`, `setTimeout`, `setInterval`, `fetch` — `expect(spy).not.toHaveBeenCalled()`)
   - `prop=false` → setup виконується (як baseline)
4. Парний сигнал: tag/comment у коді ("JS-керування ВИМКНЕНЕ для fill") без парного `it(...)` що це асертить.

**Підхід до фіксу:**

1. Додати regression-guard тест на early-return гілку: spy на side-effect що ХОЧЕ зайти у setup (ResizeObserver constructor, fetch, setTimeout), render component з `prop=true`, асертити `expect(spy).not.toHaveBeenCalled()`.
2. Додати regression-guard тест на DOM/CSS контракт нової гілки: render → query outer/inner елементи → асертити className/inline-style match (наприклад `outer.className).toMatch(/flex-1 min-h-0 overflow-y-auto/`, `outer.style.height).toBe('')`).
3. Якщо новий prop пропускається у внутрішньому використанні (Modal → AnimatedBody `fill={true}`), додати інтеграційний тест на верхньому рівні (Modal): рендер → query outer wrapper → асертити структуру (бо може зламатись лише при певному use-site).
4. Pattern для шаблону: коли вводимо boolean prop що міняє useEffect setup, ОДРАЗУ додаємо мінімум 3 тести — два per-branch (`prop=true`/`prop=false` setup behavior) + один контракт DOM/CSS.

**Severity:** MEDIUM — silent layout regression при майбутніх refactor; виявляється лише manual QA, ламає viewport-fill розкладку для всіх місць де компонент використовується.

**Де шукати ще:**

- Кожен компонент-обгортка з boolean feature-prop у `apps/web/src/components/ui/` (`AnimatedBody.fill`, `Modal.hideClose`, `DetailPanel.compact`...) — перевірити test-coverage на нову гілку.
- Кожен custom hook у `apps/web/src/hooks/use*.ts` де додано boolean param що включає early-return — той самий test pattern.
- Кожен `useEffect` що robить cleanup-критичний setup (ResizeObserver, MutationObserver, IntersectionObserver, EventListener, setTimeout) із умовним gate — early-return шлях завжди needs regression-guard, бо cleanup function НЕ реєструється коли гілка early-returns (виявлення memory-leak / double-cleanup при toggle).

**Профілактика:**

1. У `/sto-dev` SKILL.md: «Boolean prop що міняє `useEffect` setup → ОБОВ'ЯЗКОВО ≥2 unit-тести: per-branch side-effect (constructor/timer/fetch не викликається у early-return гілці) + DOM/CSS контракт нової гілки».
2. У `/sto-review` checklist §3.x: «Новий feature-prop у компоненті/хуку → перевірити `*.test.tsx` describe-блок з назвою cthe prop name».
3. У `/sto-tester` Крок 1 §1.3 frontend: grep для unguarded `if (\w+) return` всередині `useEffect`/`useLayoutEffect` + cross-check з тестами.

---

### 2026-06-03 — Animation hook (rAF + setTimeout cleanup) without tests + CSS marker contract gaps (Bugs #332-#335) — frontend, animation system

**Сигнал:** Введено новий хук `useAnimatedPresence` що керує DOM-mounting під час exit-анімації CSS (replace `if (!open) return null` antipattern). Хук використовується транзитивно в `Modal` → всіх дітях Modal (ConfirmDialog, CategoryManagerModal). Будь-який рефактор без regression-тестів ламає exit-animation для ВСЬОГО проєкту silently — tsc green, Modal все ще монтується, але DOM зникає миттєво при close. Парально: CSS правила в `globals.css` scoped через `[data-animate][data-state="open"]` markers — refactor що видаляє `data-animate` атрибут teж тихо ламає анімацію без runtime-error.

**Причина виникнення:**

1. Хуки з timing-семантикою (rAF + setTimeout + cleanup) виглядають «прості» — 20 рядків коду. Розробник додає без тестів думаючи що `useState` і `useEffect` тривіальні.
2. CSS scoped marker patterns (`[data-X]`-prefix) поширюються у проєкті щоб уникнути колізій з Radix/HeadlessUI, але немає очевидного зв'язку між CSS правилом і JSX атрибутом — рефактор JSX не запускає alarm для CSS.
3. Animation enter паттерн з `requestAnimationFrame(() => setState('open'))` копіюється з React-anim tutorials, але має subtle 1-frame flicker при re-open (CSS animation starts from previous state's keyframe).

**Підхід до виявлення:**

1. **Hook без тестів:** `git diff HEAD --name-only | grep "hooks/use.*\.ts$"` — кожен match має парний `.test.tsx`. Якщо хук має `useState` + `useEffect` + `setTimeout`/`requestAnimationFrame` → обов'язковий test із controllable timer (`vi.useFakeTimers`) + controllable rAF (`vi.spyOn(window, 'requestAnimationFrame').mockImplementation(...)`).
2. **CSS marker contract:** `grep -nE "\[data-[a-z]+\]" apps/web/src/app/globals.css` — для кожного унікального `data-X` selector → знайти JSX-споживача (`grep -rn "data-X" apps/web/src --include="*.tsx"`) → перевірити чи його `*.test.tsx` асертить наявність атрибута через `expect(...).toHaveAttribute('data-X')`. Якщо ні — додати integration-тест.
3. **rAF dance flicker:** `grep -rn "requestAnimationFrame.*setState" apps/web/src/hooks --include="*.ts"` — кожен match потенційний bug. Безпечніше: `useLayoutEffect` + одразу `setState('open')` (CSS `animation` з `fill-mode: both` runs on mount без rAF).

**Підхід до фіксу:**

1. **Hook test шаблон:** `controllable rAF queue` (Array + flushRaf) + `vi.useFakeTimers` + 7-10 кейсів: init (sync state), enter (rAF flip), exit (timer flush), кастомний duration, rapid toggle ×2 напрямки, stress 4-фазний flip, unmount cleanup для setTimeout і rAF (як `apps/web/src/hooks/useAnimatedPresence.test.tsx`).
2. **CSS marker integration test:** asserts `data-animate` + `data-state` + direct-child relation для backdrop (`:scope > [data-backdrop]`). Шаблон у `apps/web/src/components/ui/__tests__/modal.test.tsx`.
3. **Re-open flicker:** змінити `useEffect` на `useLayoutEffect`, прибрати rAF dance — CSS animation runs on mount with fill-mode both. Не критично, але polish.

**Severity:** MEDIUM для hook без тестів (silent regression на всю animation system); LOW для CSS marker drift (visual jank без data-loss); LOW для re-open flicker (1-frame ≈16ms).

**Де шукати ще:**

- Кожен новий custom hook у `hooks/use*.ts` з `setTimeout`/`setInterval`/`requestAnimationFrame` — needs controllable-timer test.
- Кожне нове scoped CSS правило з `[data-X]` selector — needs integration-test що асертить marker presence + position (direct-child vs descendant).
- Кожен новий shared modal-like компонент (`Drawer`, `Popover`, `Tooltip`) що використовує useAnimatedPresence — needs парний test що exit animation тримає DOM протягом duration.
- React-animation libs альтернативи (framer-motion, react-spring) — той же class issues.

**Профілактика:**

1. У `/sto-dev` SKILL.md: «Custom hook з `useEffect` + timer/rAF — обов'язковий `*.test.tsx` з `vi.useFakeTimers`».
2. У `/sto-review` checklist: «CSS scoped marker selector → парний integration-тест на marker presence».
3. У grep §1.6: додати hook-test-coverage аудит у Кроці 1 AUTO-режиму (поки що тільки FULL).

---

### 2026-06-02 — Coefficient-zero у нових Goods UoM endpoints (Bug #312) — повторення Bug #302 у різній моделі — backend+frontend, sprint-replicated bug

**Сигнал:** Раніше виправлений баг (`coefficient=0` → divide-by-zero у `qty_base = qty / coefficient`) **знову з'являється** у НОВОМУ модулі тому що backend-DTO для нової nested-моделі (`GoodUoM`) і frontend-форма для додавання UoM до конкретного товару створювались окремо від `UnitsTab`/`UnitOfMeasure`. Patch на `Unit.coefficient` (`@Min(0.000001)` + frontend `> 0` guard) не реплікувався у `CreateGoodUoMDto` / `UpdateGoodUoMDto` + `GoodsTab.addUoM` / `GoodsTab.saveUoMEdit`. TS green, unit-tests green (mocks приймають будь-яке число), runtime — silent NaN propagation у totalCost/totalParts при першому використанні товару у наряді.

**Причина виникнення:** Кожен новий "per-X" UoM relation (Good→GoodUoM, Service→ServiceUoM, Recipe→RecipeUoM…) додає **новий DTO** і **нову форму**. Розробник копіює форму з `UnitsTab` як reference, але **сирий @Min(0)** без `0.000001` приходить з PrimaryUnit-DTO який сам по собі ще НЕ був виправлений на момент створення Good-UoM-фічі. Або фіча додана ПІСЛЯ Bug #302 patch, але розробник дивився на старий код як приклад.

**Підхід до виявлення:**

1. Grep усіх DTO з `coefficient` полем у бек:
   ```bash
   grep -rn "coefficient" apps/api/src/modules --include="*.dto.ts"
   ```
   Кожен має `@Min(0.000001)` (або позитивний epsilon). `@Min(0)` = bug.
2. Grep усіх frontend-форм які парсять рядок у coefficient:
   ```bash
   grep -rn "coefficient.*Number\|Number(.*coefficient" apps/web/src --include="*.tsx"
   ```
   Кожен callsite що POST/PATCH-ить `coefficient` має guard `> 0` ПЕРЕД apiFetch.
3. Перевіряти при кожному code-review що додає Mass/Volume/qty relation у нову модель — це автоматично передбачає UoM-relation з coefficient.

**Підхід до фіксу:**

1. Бек: `@IsNumber() @Min(0.000001)` (consistent epsilon у всіх DTO-полях `coefficient`).
2. Фронт: перед `apiFetch(...)` у POST/PATCH витягувати `const coeff = Number(form.coefficient)` → `if (!Number.isFinite(coeff) || coeff <= 0) { setError('Коефіцієнт має бути більший 0'); return; }`.
3. Якщо є кілька форм для тієї ж моделі (`addUoM`, `saveUoMEdit`, `bulkImport`) — фіксити **усі одночасно** (sprint-replicated bug розповзається у sub-pattern).

**Severity:** HIGH (data corruption у downstream calc; Bug #302 уже доведено реальним).

**Де шукати ще:**

- ServiceUoM / RecipeUoM / ProductVariantUoM — будь-який новий relation з `coefficient`.
- `step` / `multiplier` / `divisor` поля у DTO — той самий клас бага (0 = divide-by-zero).
- `quantityPerUnit` / `pricePerUnit` / `taxRate` — будь-яке поле що використовується як divisor / multiplier.
- Розширення pricing (`COMPETITOR_PLUS`, `COST_TIER`) додають нові numeric DTO поля — кожне має explicit `@Min(positive)`.

**Профілактика:**

1. У `/sto-dev` SKILL.md: «Будь-який numeric DTO field що використовується як divisor — `@Min(0.000001)`, не `@Min(0)`».
2. У `/sto-review` checklist: «Чи кожне coefficient/divisor/multiplier поле має explicit positive min?»
3. У grep-команді з §1.1: додати `coefficient.*@Min(0)\\b` → авто-flag для review.

---

### 2026-06-02 — `window.confirm` у новій bulk-action функціональності замість `useConfirm` (Bug #313) — frontend, UX consistency

**Сигнал:** Сторінка вже імпортує і використовує `useConfirm` хука для single-delete (рядки 1-2 файла), але **нова** bulk-action (BulkActionsBar onClick) використовує browser-native `window.confirm(...)`. Native dialog: не стилізований у проєктній темі, блокує main thread (нема async-loading-spinner), на iOS Safari може бути дозволено «Block additional dialogs» → permanent skip. TS green, тести green (browser confirm mockється глобально у vitest setup), UX broken у DEV/QA.

**Причина виникнення:** Bulk-actions як паттерн з'являється пізніше за single-actions у sprint. Розробник пише його swiftly як «just confirm and delete», тип `BulkAction.onClick: async (ids) => void` не примушує до конкретного confirm-механізму. `window.confirm` — дефолтний JS-API, працює без імпорту, найшвидше написати. Inconsistency не помічається до code-review.

**Підхід до виявлення:**

1. `grep -rn "window\.confirm" apps/web/src --include="*.tsx"` — кожен результат потенційний.
2. Класифікувати: якщо файл уже імпортує `useConfirm` — це **завжди bug** (mixed-style). Якщо `useConfirm` не імпортовано — додати імпорт + рефактор.
3. Особлива увага до `BulkActionsBar onClick`, `bulk*Actions = useMemo([...])` — це місця де patterm reused.

**Підхід до фіксу:**

1. Замінити `if (!window.confirm(msg)) return;` на `if (!(await confirm({ title: msg, variant: 'destructive' }))) return;`.
2. Додати `confirm` у `useMemo` dependency array (інакше stale closure).
3. Verify TS — `BulkAction.onClick` повертає `void | Promise<void>`, тому `async` work без change.

**Severity:** MEDIUM (UX inconsistency + блокуюча native modal; не data-correctness).

**Де шукати ще:**

- Кожна нова integration з `BulkActionsBar` / `ContextMenu` / `RightClick` — confirm pattern.
- Imports / exports / migrations actions у `xlsx-import-button.tsx`, `audit-import-modal.tsx` тощо.
- Logout actions, account deletion modals — будь-де де destructive action.

**Профілактика:**

1. У `/sto-web` SKILL.md: «Якщо файл уже використовує `useConfirm` — НІКОЛИ не змішувати з `window.confirm`».
2. ESLint custom rule або `/sto-review` grep: «`window.confirm` у файлі що імпортує `useConfirm` = error».
3. Документувати у `BulkActionsBar` JSDoc: «onClick: confirm pattern має бути той самий що у решти page actions».

---

### 2026-06-02 — Reusable UI компонент без `type="button"` → ризик form-submission при майбутній вбудові (Bug #314) — frontend, defensive a11y / form semantics

**Сигнал:** Файл `apps/web/src/components/ui/*.tsx` (shared компонент який потенційно вбудовується у форму) має `<button>` БЕЗ `type="button"`. За HTML5 default — `type="submit"`. Якщо компонент вбудовується у `<form>` (search-bar, settings panel, modal form), клік на не-submit button (apply filter, toggle expand, remove tag) спричинить непотрібний form-submit. Парний компонент у тому самому файлі вже має `type="button"` — drift очевидний.

**Причина виникнення:** Розробник пише `<button>` бо HTML дозволяє опускати type. У standalone-context (поза формою) це працює бо submit nothing happens. Code-review бачить shared компонент і не перевіряє чи він може опинитись у формі — це залежить від callsite. Не з'являється у тестах бо тести не вбудовують компонент у form.

**Підхід до виявлення:**

1. Для кожного reusable компонента у `components/ui/`:
   ```bash
   grep -nE "<button(?!\s+type=)" apps/web/src/components/ui/<file>.tsx
   ```
   Кожен `<button>` без `type=` атрибута — потенційний bug.
2. Перевірити callsites: чи компонент колись використовується у `<form>` контексті:
   ```bash
   grep -rn "<ComponentName" apps/web/src/app --include="*.tsx"
   # для кожного — перевірити чи він всередині <form>
   ```
3. Перевірити **внутрішню парність**: якщо у файлі є хоч ОДИН `type="button"`, всі інші теж мають мати (consistency).

**Підхід до фіксу:**

1. Додати `type="button"` до кожного `<button>` у shared компоненті, окрім справжніх submit buttons.
2. Для submit buttons — явно `type="submit"` (документуй намір).
3. Не використовувати `<Button>` (custom) як reset-альтернатива — `<Button>` має `type="button"` за замовчуванням, але raw `<button>` ні.

**Severity:** LOW (defensive; буде проблемою при майбутній вбудові у form, не зараз).

**Де шукати ще:**

- Усі `components/ui/*.tsx` файли — масовий grep.
- Custom dropdowns, comboboxes, tag-pickers — вбудовуються у форму як часткове управління.
- Toolbar / FilterBar компоненти — потенційно у `<form role="search">`.

**Профілактика:**

1. `/sto-dev` SKILL.md: «Будь-який raw `<button>` у shared компоненті — `type="button"` обов'язково».
2. ESLint plugin `react/button-has-type` enable — auto-catch.
3. У `/sto-review` додати grep команду на shared `<button>` без type.

---

### 2026-06-02 — Promise.all для reference data без AbortController (Bug #315) — frontend, cleanup, memory hygiene

**Сигнал:** Component initial useEffect завантажує 2+ reference fetch паралельно через `Promise.all([apiFetch(...), apiFetch(...)])` БЕЗ AbortController. `then` callback викликає `setState` для всіх трьох. Якщо component unmounts (швидка навігація між табами) до завершення `Promise.all` → `setState` на unmounted → React 18 warning «Can't perform a React state update on an unmounted component». UX не зламано, але DEV console flooded, регресії тестів що ловлять console.error, memory churn якщо state large.

**Причина виникнення:** Reference data fetch — ranges одиничних викликів. Single `apiFetch` зазвичай уже має cleanup (AbortController у `useFetch` хука, mountedRef у calendar). `Promise.all` копіюється як «pattern для паралельності», але cleanup забувається бо `Promise.all` повертає один result, а не три окремих. Робота guard'у вимагає **єдиного** signal'у на всі fetch'и + check у then.

**Підхід до виявлення:**

1. Grep `Promise.all` всередині `useEffect`:
   ```bash
   grep -rnE "useEffect\(\(\) =>" apps/web/src/app --include="*.tsx" -A 30 | grep -B5 "Promise.all"
   ```
   Кожен match без AbortController = bug.
2. Перевірити чи `useEffect` має cleanup function (`return () => ac.abort()`).
3. Перевірити чи `setState` всередині `then` має guard `if (ac.signal.aborted) return`.

**Підхід до фіксу:**

1. На початку useEffect: `const ac = new AbortController();`.
2. Кожен `apiFetch(...)` отримує `{ signal: ac.signal }` як 2-й аргумент.
3. У `then`: guard `if (ac.signal.aborted) return` ПЕРЕД setState.
4. Cleanup: `return () => ac.abort();` в кінці useEffect.

**Severity:** LOW (DEV warnings + потенційне засмічення; не data-correctness). MEDIUM якщо component часто перемонтується (tabs/modals).

**Де шукати ще:**

- Catalog tabs (Brands/Works/Services/Goods/Units/Categories) — reference fetch на mount.
- CRM page reference data (categories, tags) — single useEffect with multiple fetches.
- Settings page initial load — typically 3-5 paralel reads (org, branch, user, settings).
- Будь-який Modal що завантажує reference на open — race з закриттям.

**Профілактика:**

1. `/sto-web` SKILL.md: «Будь-який `Promise.all` всередині `useEffect` — обов'язковий AbortController».
2. Краще: винести reference fetch у TanStack Query (`useQuery` має вбудований AbortController через `signal`).
3. ESLint rule custom: detect `Promise.all` у useEffect без cleanup function.

---

### 2026-06-02 — Toggle-state UI desync: highlight/cursor not gated on enabled flag (Bugs #310, #311) — frontend, UI consistency, toggle-state

**Сигнал:** Додається новий toggle-component (`DetailPanelToggle`, `FilterToggle`, `CompactModeToggle`) що керує boolean state через окремий hook (`useDetailPanel`, `useFilterMode`). Ефекти toggle (highlight рядка, cursor, hover, badge-count) застосовуються до DOM на основі іншої state-змінної (`selectedX?.id === item.id`, `expandedRows.has(id)`) яка **НЕ синхронізується** з toggle-state. Після `toggle()` → `enabled=false`, але `selectedX` залишається — клас типу `bg-secondary` / `cursor-pointer` рендериться, хоча action більше не доступна. Користувач бачить «вибрано» але панель прихована.

**Причина виникнення:** Розробник реалізує toggle для **видимості панелі** (`open={!!selectedX && enabled}`) і думає що цього достатньо. Інші візуальні affordance-и (cursor pointer, row highlight, hover effects) залишаються прив'язані до старої state — бо вони писались до того як з'явився toggle. Inverse pattern: `enabled && 'cursor-pointer'` написано (бо нова фіча), але `selectedX?.id === item.id && 'bg-secondary'` ні (стара фіча). Поломка часткова — TS green, unit green, бо `enabled` boolean правильний, але UI каже одне, поведінка інше.

**Підхід до виявлення:**

1. Для кожного нового toggle-component запитати: «Що **ще** перемикається разом з ним?» — panel visibility, cursor, hover, row highlight, click behavior. Усе має один gate.
2. Шукати rows / cards / list-items де класи selection / hover / cursor рендеряться **без** перевірки toggle-state:
   ```bash
   # Знайти всі TableRow / list items де selection highlight НЕ has toggle gate:
   grep -rnE "selected[A-Z][a-zA-Z]*\?.id\s*===\s*[a-z]+\.id\s*&&\s*'bg-" apps/web/src/app --include="*.tsx" | \
     grep -v "detailPanel\.enabled\|panel\.enabled\|enabled &&"
   ```
3. Шукати `cursor-pointer` поза `cn()` conditional / поза `enabled &&`:
   ```bash
   grep -rnE "'group cursor-pointer'|className=\\\`group cursor-pointer" apps/web/src/app --include="*.tsx"
   ```
4. Перевірити **симетрію**: якщо `cursor-pointer` gated → highlight теж має бути gated, і навпаки. Один без другого = bug.

**Підхід до фіксу:**

1. Defensive fix (швидкий): на render-рівні додати `&& detailPanel.enabled` до КОЖНОГО affordance class:
   ```tsx
   selectedX?.id === item.id && detailPanel.enabled && 'bg-secondary',
   detailPanel.enabled && 'cursor-pointer',
   ```
2. Alternative fix (cleaner): у toggle-hook очищати залежну state при `enabled=false` через external `useEffect` у consumer:
   ```tsx
   useEffect(() => {
     if (!detailPanel.enabled) setSelectedX(null);
   }, [detailPanel.enabled]);
   ```
   Це автоматично знімає highlight + закриває панель, але втрачає «memory» вибору при повторному включенні.
3. Перевірити **усі copy-cat сторінки** (work-orders, crm, employees, invoices, purchase-orders, stock-documents + catalog tabs) одночасно — pattern завжди реплікується N-разів.

**Severity:** MEDIUM (UX confusion: stale highlight + неіснуюча панель), LOW для cursor-only варіанту (просто misleading affordance).

**Де шукати ще:**

- Sprint що додає `useCompactMode` / `useGridMode` → перевірити чи hover/cursor/padding gated на mode.
- Sprint що додає `useExpandedRows` Set → row classes мають gate на `expanded.has(id)`.
- Sprint що додає `useReadOnly` mode → cursor/hover/click-handlers мають gate на `!readOnly`.
- Будь-який hook-based toggle (`use<Feature>`) з persisted state у localStorage — селекція не повинна «пам'ятати» між сесіями якщо toggle off.

**Профілактика:**

1. У `/sto-web` SKILL.md: «При додаванні toggle для feature-видимості — кожна affordance class має той самий gate». Додати ✅/❌ приклад з 2-line cn().
2. У `/sto-review` checklist: «Чи всі visual affordances (cursor, highlight, hover, badge) gated на тому ж flag що panel.open?»
3. У `useDetailPanel` hook документувати: «`enabled` гейтує VIDIMOСTI панелі, але consumer ВІДПОВІДАЛЬНИЙ за решту affordances (cursor, highlight)». Або додати `disabled` boolean у return + контекст.

---

### 2026-06-02 — Multi-module soft-delete sprint: pattern dilution (Bug #306) — backend, sprint-replicated bug, code-copy

**Сигнал:** один commit реалізує однакову фічу (наприклад «soft-delete + restore») у N модулях (`brands`, `works`, `goods`, `services`). У ОДНОМУ з них (зазвичай першому або останньому) застосовано WORKAROUND для відомої pitfall (наприклад explicit `nulls: 'first'` для orderBy), у решті N-1 — **скопійовано шаблонний код** з підрядника без цієї поправки. Перший review ловить bug у «новому» (units) модулі, але міграція fix-у у «копії» (brands) пропущена.

**Причина виникнення:** коли feature replicates across modules, перший review + tester цикл захоплюється «новим» модулем що drove pattern (тут — `units` зі своєю partial-unique-index складністю Bug #297). Решта 3 модулі трактуються як «trivial copy» і отримують shallow review — без перевірки чи вже відомі pitfalls (Bug #296 orderBy nulls) застосовані.

**Підхід до виявлення:**

1. Для кожного **multi-module commit** (`git show --stat | grep ".service.ts" | wc -l > 1`) сканувати ВСІ modified service.ts на ВСІ patterns зі SKILL §1.1:

   ```bash
   # Знайти всі service.ts змінені у останньому feature commit:
   git diff HEAD~3 HEAD --name-only | grep "modules/.*\.service\.ts$" | while read f; do
     echo "=== $f ==="
     grep -nE "orderBy.*deletedAt.*['\"]asc['\"]" "$f" | grep -v "nulls" && \
       echo "  ⚠ orderBy deletedAt asc без nulls"
     grep -nE "findFirst|findMany" "$f" | grep -v "deletedAt\|spec\|StockMovement\|SettlementTransaction\|Payment" | \
       head -5 && echo "  ⚠ можливо без deletedAt: null guard"
   done
   ```

2. Не довіряти «pattern matches units» — кожен модуль перевіряти НА ТУ Ж ЛІНІЮ checklist.

3. Парний паттерн на frontend: 4 Tab-component файли одночасно отримали `Eye/EyeOff` toggle + `restore` handler. Кожен має ту саму race+in-flight pitfall (Bug #301, #303). Якщо UnitsTab fix-ed → ОБОВ'ЯЗКОВО replicate у BrandsTab/GoodsTab/ServicesTab/WorksTab.

**Підхід до фіксу:**

1. Запустити сам grep що ловить pattern на ВСІХ файлах одночасно (не один-за-один). Швидше і повніше:
   ```bash
   grep -rn "orderBy.*deletedAt.*['\"]asc['\"]" apps/api/src/modules --include="*.service.ts" | grep -v "nulls"
   ```
2. Для frontend — grep `apiFetch.*restore.*POST` у `.tsx` + перевірка наявності `restoringIds` state.
3. Скласти **multi-module checklist** перед review: «Якщо feature додано у >1 модулі — чи кожен має той самий захист?»

**Severity:** HIGH — sprint-bug в одному з модулів пропускається review і потрапляє в production. UX broken тільки для конкретної entity (тут — brands), решта виглядає нормально.

**Де шукати ще:**

- Sprint що додає `audit log` chrono → всі модулі що пишуть → перевірити кожен викликає `auditLog.create`.
- Sprint що додає `?fields=` projection → кожен toDto має `.pick(fields)`.
- Sprint що додає `syncVersion` increment → кожен `update`/`create` має `syncVersion: { increment: 1 }`.
- Sprint що додає `branchId` scope → кожен `findFirst`/`findMany` має `branchId` у where.

**Профілактика:**

1. У `/sto-review` checklist: «Якщо modified service.ts > 1 — повторити grep section §1.1 для КОЖНОГО».
2. У `/sto-feature` плануванні: для multi-module фіч писати **explicit per-module checklist**, не «zaстосувати ті самі зміни до всіх».
3. У `/sto-sync` agent: коли і backend і frontend змінюються у N модулях — sync-перевірка має ходити по кожному N.

---

### 2026-06-02 — Soft-delete filter pill chicken-and-egg (Bug #295) — frontend, UX state, soft-delete

**Сигнал:** `Toggle/FilterPill` що дає доступ до **єдиного режиму перегляду** прихованих даних (`Архів`/`Видалені`/`Корзина`) має умовний рендер `{derivedCount > 0 || isToggled ? <Btn/> : null}`, де `derivedCount` обчислюється з `items.filter(predicate).length`. Якщо у default-режимі (`isToggled=false`) API повертає ЛИШЕ items де predicate=false → `derivedCount=0` завжди → кнопка ніколи не рендериться → користувач не має способу побачити приховане.

**Причина виникнення:** розробник додає filter feature і прагне «прибрати непотрібну кнопку коли немає видалених» (cleaner UX), не помічаючи що сам факт показу/приховання кнопки залежить від того що вона відкриває. UX-thinking «show only when relevant» працює для **інших** UI (export button only if data exists) але НЕ для toggle who reveals what fills its own counter.

**Підхід до виявлення:**

1. Знайти будь-який UI з умовним рендером кнопки, що читає `count > 0 || state`: `grep -rnE "(\b(deleted|archived|hidden|removed)Count)\s*>\s*0\s*\|\|" apps/web/src/app --include="*.tsx"`.
2. Для кожного match — простежити: звідки береться `count`. Якщо `items.filter(it => it.X).length` де `items` від API, а API повертає `it.X = false` коли filter=false → bug.
3. Альтернатива: перевірити що default-mode API returns ИЗОЛЮВАНО subset, а лічильник для протилежного субсету обчислюється ЦІЛКОМ з default-mode response → нерозв'язно без preflight.

**Підхід до фіксу:**

1. **Простіше:** toggle завжди видимий. Count показувати ТІЛЬКИ коли `isToggled=true` (бо у `false` mode count завжди 0).
2. Альтернатива: preflight HEAD/`/count`-endpoint при mount → знати чи є приховані → conditionally render toggle.
3. Альтернатива: для админ-only views завжди показувати обидва filters (active/archived) без count badge.

**Severity:** CRITICAL — soft-delete фіча недосяжна з UI. Виявляється тільки manual QA з реальним даним (одиниця створена → видалена → користувач шукає як відновити).

**Де шукати ще:**

- Будь-який майбутній «archived» / «inactive» / «deleted» filter у CRUD-табах (counterparties, vehicles, goods, services, employees-roles).
- Notification-center «прочитані»/«непрочитані» filter — якщо unreadCount=0 chowа «прочитані» вкладку, користувач не бачить історію.
- Settings → «вимкнені» інтеграції / payment-methods — якщо в default-режимі показуються лише увімкнені, кнопка «показати вимкнені» не повинна залежати від наявності вимкнених у поточному списку.

**Профілактика:** для кожного нового CRUD-таба з soft-delete review-checklist: «Чи можна побачити архів коли активних 100% і видалених 0?» — якщо ні, бо кнопки немає, → fix.

---

### 2026-06-02 — Postgres NULLS LAST default ламає sort by nullable soft-delete (Bug #296) — backend, Prisma, sort, NULL semantics

**Сигнал:** `findMany({ orderBy: [{ deletedAt: 'asc' }, ...] })` без explicit `nulls: 'first'` у Prisma 5+ → Postgres за замовчуванням ставить NULL В КІНЕЦЬ ASC → активні рядки (deletedAt=NULL) йдуть **ПОСЛЕ** видалених (з timestamp) у списку «showDeleted=true». TS green, unit-тести green (бо mocks повертають вже відсортований масив), runtime — UX broken silently.

**Причина виникнення:** розробник пише `orderBy: { deletedAt: 'asc' }` думаючи що NULL = «no date» = «найменше» = «перше» (інтуїтивне сприйняття). У SQL/Postgres NULL — «unknown», за замовчуванням sortується В КІНЕЦЬ ASC і НА ПОЧАТКУ DESC. Prisma не нормалізує цю поведінку — простий `'asc'` напряму мапиться на `ORDER BY col ASC` без `NULLS FIRST/LAST` hint.

**Підхід до виявлення:**

```bash
# Шукати orderBy по nullable полю без explicit nulls:
grep -rn "orderBy.*deletedAt.*['\"]asc['\"]" apps/api/src/modules --include="*.service.ts" | grep -v "nulls" | head -10
grep -rn "orderBy.*expiryDate.*['\"]asc['\"]" apps/api/src/modules --include="*.service.ts" | grep -v "nulls" | head -10
grep -rn "orderBy.*completedAt.*['\"]asc['\"]" apps/api/src/modules --include="*.service.ts" | grep -v "nulls" | head -10
grep -rn "orderBy.*[a-zA-Z]+At.*['\"]asc['\"]" apps/api/src/modules --include="*.service.ts" | grep -v "createdAt\|updatedAt\|spec\|nulls" | head -10
```

Прим. `createdAt`/`updatedAt` зазвичай NOT NULL — безпечно. `*At` поля що nullable — потребують explicit nulls hint.

**Підхід до фіксу:**

1. Замінити `{ col: 'asc' }` на `{ col: { sort: 'asc', nulls: 'first'|'last' } }` (Prisma 5+ syntax).
2. **Soft-delete sort у списку «з deleted»:** `nulls: 'first'` (активні зверху, видалені знизу).
3. **FEFO/expiry sort:** `nulls: 'last'` (товари з близьким терміном першими, без терміну в кінці).
4. **Completion-date sort:** залежить від бізнес-смислу — зазвичай `nulls: 'last'` (незавершені після завершених).

**Severity:** HIGH-CRITICAL коли впливає на основну сторінку перегляду; MEDIUM для рідких admin-views.

**Де шукати ще:**

- Будь-який `findMany` що включає soft-deleted рядки (admin views, audit logs, archive pages).
- FEFO батч-вибір (`batch.service.ts:findFEFOBatches`).
- Calendar/timeline що показує completed + pending tasks разом.
- Payment-list з partial payments (`paidAt` nullable).
- Email-queue з failed sends (`sentAt` nullable).

**Профілактика:**

1. ESLint custom-rule (майбутнє) для `orderBy` з nullable column без explicit nulls.
2. У `/sto-dev` SKILL — додати ❌/✅ приклад для nullable orderBy.
3. Integration-тест на список «з видаленими»: 3 active + 2 deleted → asserts active першими.

---

### 2026-06-02 — Soft-delete + @@unique без partial filter = P2002 у `update`/`restore` (Bugs #297, #298) — backend, soft-delete, unique-constraint, error-handling

**Сигнал:** `@@unique([orgId, X])` у `schema.prisma` без `WHERE deletedAt IS NULL` у migration `CREATE UNIQUE INDEX`. `update()` сервісу робить duplicate-check `findFirst({ orgId, X: dto.X, deletedAt: null, NOT: { id } })` (тільки серед активних) → soft-deleted дублікат не помічається → `prisma.update({ data: { X: dto.X } })` намагається записати → DB constraint hit → P2002 → NestJS дефолтний exception filter → **500 Internal Server Error** замість осмисленого 409 з повідомленням.

Аналогічно для `restore()`: prep-check лише на soft-deleted рядок з потрібним id, але не перевіряє чи нема активного дублікату → `prisma.update({ data: { deletedAt: null } })` отримає P2002.

**Причина виникнення:** SKILL § Bug #152 покриває resurrection-патерн для `create()` — розробник це знає і робить правильно. Але:

1. Для `update()` той самий розробник копіює існуючий patterns з brands/services що використовує `deletedAt: null` у duplicate-check (бо для них рідко є soft-deleted з тим же name) — забуває що для unit-shortname це може траплятись частіше через коротку довжину (`шт`, `л`, `кг`).
2. Для `restore()` розробник не задумується що активний дублікат може існувати (думає що sost-deleted рядок гарантовано «не має конкурента»).

**Підхід до виявлення:**

```bash
# Знайти всі @@unique у схемі без partial filter у migration
grep -n "@@unique" packages/database/prisma/schema.prisma | awk '{print $2}'
grep -rn "CREATE UNIQUE INDEX" packages/database/prisma/migrations/ | grep -v "WHERE"

# Для кожної моделі з @@unique[orgId,X] перевірити service:
# 1. update() — duplicate-check НЕ повинен мати deletedAt: null у where (інакше дублікат прихований)
# 2. restore() — prep-check на активний дублікат ОБОВ'ЯЗКОВИЙ
grep -rn "ConflictException\|P2002\|@@unique" apps/api/src/modules/<module>/<module>.service.ts
```

**Підхід до фіксу:**

1. **`update()` duplicate-check без `deletedAt: null`:**

   ```ts
   const duplicate = await prisma.X.findFirst({
     where: { orgId, field: dto.field, NOT: { id } }, // НЕ deletedAt: null!
   });
   if (duplicate) {
     if (duplicate.deletedAt) {
       throw new ConflictException(
         'X з таким значенням існує у архіві. Спочатку відновіть її або оберіть інше значення.',
       );
     }
     throw new ConflictException('X з таким значенням вже існує');
   }
   ```

2. **`restore()` active-duplicate prep-check:**

   ```ts
   const activeDuplicate = await prisma.X.findFirst({
     where: { orgId, field: existing.field, deletedAt: null, NOT: { id } },
   });
   if (activeDuplicate)
     throw new ConflictException('Активна X з таким значенням вже існує — відновлення неможливе');
   ```

3. **Альтернатива (DB-level):** додати migration з partial unique index `CREATE UNIQUE INDEX ... WHERE deleted_at IS NULL` + DROP старого full unique. Складніше, потребує даним cleanup. Але fundamentally безпечніше — guard на рівні БД, не сервісу.

**Severity:** CRITICAL для `update()` (часта операція, легко відтворити для shortName); HIGH для `restore()` (edge-case але реальний).

**Де шукати ще:**

- Кожен модуль з `@@unique([orgId, X])` що має soft-delete: `brands`, `units`, `services`, `work-categories`, `payment-methods`, `tax-rates`, `bank-accounts`, `branches` (`@@unique([orgId, name])`).
- Multi-column unique: `@@unique([orgId, X, Y])` — той самий патерн з більшою кількістю полів у duplicate-check.
- Backend-only resurrection sites (seed/migration scripts) — теж потребують той самий захист.

**Профілактика:**

1. Контракт-тест-шаблон для кожного soft-delete CRUD: `it('update rename to soft-deleted shortName returns 409, not 500')` + `it('restore conflicting active returns 409')`.
2. У `/sto-dev` SKILL приклад правильного `update()` з soft-delete-aware duplicate check.
3. Майбутнє: автоматизована перевірка migration → schema parity для @@unique → partial filter pairing.

---

### 2026-05-31 — Prefetch queryKey ↔ page queryKey shape mismatch (Bug #281) — frontend, react-query, wasted-work

**Сигнал:** `TopShell` / nav-component / route-prefetch механізм викликає `queryClient.prefetchQuery({ queryKey: Xkeys.list({}), queryFn: () => apiFetch('/x?limit=N', ...) })` на hover/focus. Але цільова сторінка викликає `useX({ page: 1, limit: 20, status: '', q: '', showDeleted: false, ... })` — повний об'єкт з default state values. TanStack Query використовує deep-equality (через `JSON.stringify`) для cache key — `Xkeys.list({})` ≠ `Xkeys.list({ page: 1, limit: 20, status: '', ... })`. Два різні cache slots → prefetch ніколи НЕ читається сторінкою → бандвідт+API навантаження без жодного perceived speedup.

**Grep для виявлення:**

```bash
# Знайти всі prefetchQuery виклики
grep -rn "prefetchQuery\b" apps/web/src --include="*.tsx" -A5 | grep -B2 "queryKey:" | head -30

# Для кожного prefetched key — знайти ВСІ виклики useX у сторінках і порівняти shape filters
for prefetchKey in workOrdersKeys counterpartiesKeys invoicesKeys; do
  echo "=== $prefetchKey ==="
  grep -rn "$prefetchKey" apps/web/src --include="*.tsx" | grep -v "import\|export"
done

# Альтернатива: вивести queryKey у dev tools React Query devtools — якщо after prefetch
# і page render видно ДВА окремі queries для тієї ж resource — bug.
```

**Причина виникнення:** розробник додає prefetch як «optimization layer» окремо від `useX` хука, не звіряє повну форму filter-default з тим що page first render передає. Часта помилка: prefetch fires з `{}` (порожній фільтр), а page hook сам **деривує** default-фільтри з local state (`useState('')` для search → `q: ''` у filters object → у queryKey).

**Підхід до виявлення:**

1. Кожен `prefetchQuery({ queryKey: ... })` пов'язаний з конкретним routes (URL pathname).
2. Знайти сторінку що рендериться на цьому route → знайти `useX({...})` виклик з фільтрами.
3. Порівняти **повну форму** filters object між prefetch і use-call. Object literal ordering у JS зазвичай однаковий, але важливо що **усі ті самі ключі присутні з тими самими значеннями**.
4. Якщо є різниця — bug.

**Підхід до фіксу:**

1. Скопіювати **точну форму** filters-object з page first-mount state у prefetch (включно з `undefined` значеннями — `JSON.stringify` пропускає `undefined`, але react-query stable hash може поводитись по-різному залежно від версії).
2. URL також має співпадати — якщо хук будує `/x?page=1&limit=20` а prefetch б'є `/x?limit=50` — навіть з правильним queryKey backend поверне інший response → cache буде з 50 елементами, але page очікує 20-paginated.
3. Контракт-тест-альтернатива: створити `prefetch-key-parity.test.tsx` — для кожного entry у `PREFETCH_MAP` створити mock `useX` і пересвідчитись що cache hit після prefetch.

**Severity:** MEDIUM коли впливає на perceived performance (вся фіча "instant nav" не працює); LOW коли prefetch — нагрівання rare cache (admin-only route). HIGH якщо prefetch tracking analytics — додатковий API hit враховується у usage metrics.

**Де шукати ще:**

- Будь-який майбутній `prefetchQuery`/`prefetchInfiniteQuery` поза react-query devtools auto-track
- `<Link prefetch={true}>` з шляхом → коли Next.js prefetch-ує JS-чанк сторінки, але react-query cache залишається порожнім → перевірити що сторінка sub-mounts hooks-prefetcher
- SSE / Websocket initial state hydration з prefetch
- React Suspense `prefetch` patterns (Next.js 15 Server Components → Client Components handoff)

**Профілактика:**

1. Завести utility `apps/web/src/hooks/api/createPrefetcher.ts` що приймає `useX` hook і повертає prefetch-функцію — eliminate shape drift between definition and consumer.
2. Альтернатива: спільна `defaultFilters` константа що використовується І у hook І у prefetch (`useWorkOrders.DEFAULT_FILTERS`).
3. У контракт-тестах кожного нового useX-хука додати `it('prefetches with same key as render')` — використовує `QueryClient.getQueryData()` post-prefetch.

---

### 2026-05-31 — Paired SSRF defense: validatePublicUrl + redirect: 'manual' завжди разом (Bug #273) — backend, security, ssrf, defense-in-depth

**Сигнал:** код містить `validatePublicUrl(userUrl)` що блокує DIRECT внутрішні URL (loopback, link-local, RFC1918, cloud metadata), АЛЕ `fetch(...)` поряд не має `redirect: 'manual'`. Patterns:

```bash
# Шукати модулі що мають url-guard import + fetch():
grep -l "validatePublicUrl" apps/api/src/modules --include="*.ts" -r | while read f; do
  if grep -q "fetch(" "$f" && ! grep -q "redirect:\s*'manual'" "$f"; then
    echo "MISSING #2 layer: $f"
  fi
done
```

Виявлено у `payments/checkbox.processor.ts` після cycle 5 review (649a5db) додав #1 шар (`validatePublicUrl(branchSettings.checkboxApiUrl)`) але забув #2.

**Причина виникнення:** review-цикл, що додає захист SSRF, часто фокусується на ОЧЕВИДНОМУ сценарії: «admin поставив http://127.0.0.1». Розробник додає `validatePublicUrl(url)` → тест-кейс «loopback відхиляється» проходить → закриває PR. **АЛЕ** ATTACKER з admin правом не настільки наївний:

1. Атакувальник ставить `userUrl = "https://attacker-controlled.com"` (легітимний external, **проходить** validatePublicUrl бо публічна IP).
2. Сервер attacker-controlled.com отримує POST з Authorization/Bearer token.
3. Server відповідає `HTTP/1.1 302 Found\nLocation: http://169.254.169.254/latest/meta-data/iam/security-credentials/` (AWS metadata) АБО `http://10.0.0.5:6379/` (internal Redis) АБО `http://localhost:5432/` (Postgres).
4. Node fetch default `redirect: 'follow'` слідує redirect — НЕ перевіряє нову target проти validatePublicUrl (внутрішній механізм node-fetch не знає про наш guard).
5. Auth header переноситься на новий host → cloud metadata / LAN service отримує POST з Authorization → можлива побічна-дія / token extraction.

Webhooks processor вже мав обидва шари (Bug #114 + IPv6 cycle); Checkbox був додаваний пізніше, повторив ту саму інтуїтивну помилку.

**Підхід до виявлення:** на Кроці 1 §1.4 — для КОЖНОГО `fetch(...)` де target URL походить з user-supplied джерела (DTO field, OrganisationSettings, BranchSettings, env var налаштованих UI):

1. **Шар #1**: `validatePublicUrl(url)` ПЕРЕД fetch, throw якщо error.
2. **Шар #2**: `fetch(url, { redirect: 'manual', ... })`.
3. **Шар #3**: `if (response.status >= 300 && < 400) throw` — БЛОКУЄ redirect мовчки замість слідувати.

ОБИДВА #2 і #3 обов'язкові — без #3 `redirect: 'manual'` повертає `Response` зі статусом 302, але код не throw → success-path виконується з порожнім body → silent fail / неконсистентний стан БД (`payment.fiscalReceiptId = undefined`).

Парне з контракт-spec: `<processor>.spec.ts` має тести: (а) fetch викликається з `redirect: 'manual'`; (б) 301/302 → throw; (в) DB.update НЕ викликається коли redirect block; (г) pre-flight URL guard для loopback / cloud-metadata. Шаблон: `checkbox.processor.spec.ts` (8 тестів).

**Підхід до фіксу:** додати ВСІ ТРИ шари одночасно + spec. Парний з шаблоном `webhooks.processor.ts:74-90`. Severity: CRITICAL якщо processor шле sensitive headers (Authorization, Bearer, API-Key) або data (payment amount, payload з PII).

**Severity:** CRITICAL (production SSRF + cloud metadata extraction).

**Де шукати ще:** будь-який майбутній outbound fetch з user-supplied URL:

- ПРРО processor (фіскальні чеки)
- SMS provider processor (turbosms, Twilio фінальні URL у settings)
- OAuth callback handlers (redirect_uri з DTO)
- Postal/delivery API integration
- AI/ML провайдери (URL у org-settings для self-hosted endpoints)
- Webhook outbound (вже захищені)
- Outbound proxy для cloud sync (ADR-006)

Профілактика: SKILL §1.4 тепер вимагає **парний** аудит — будь-який новий `validatePublicUrl` без `redirect: 'manual'` (або навпаки) = bug. Будь-який новий `*.processor.ts` що робить outbound fetch обов'язково має парний `*.processor.spec.ts` з redirect-block тестами.

---

### 2026-05-31 — Dead-feature integration audit: implemented + tested service ніколи не викликається з реального flow (Bugs #267, #268) — backend, dead-code, business-logic-gap

**Сигнал:** сервіс має повний implementation pattern (DI constructor + @Injectable + processor + BullMQ queue + unit-spec покриваючи happy/error paths) АЛЕ `grep -rn "<service>\.<method>(" apps/api/src --include="*.ts" | grep -v spec` повертає **тільки 2 рядки**:

1. Самоопис у service.ts (`async X() { ... }`)
2. Виклик у processor.ts (queue worker — bridge між BullMQ і service)

Жоден інший сервіс (payments, invoices, settlements, work-orders) НЕ викликає `service.X` чи `service.queueX`. Це означає бізнес-flow, який мав би тригерити дію — ніколи не тригерить. Виявлено у:

- **Bug #267 (HIGH)** — `LoyaltyService.queueEarn` / `LoyaltyService.earn`: повний BullMQ pipeline + unit specs + OrganisationSettings UI tab — ніколи не викликається з payments. Бали лояльності ніколи не нараховуються.
- **Bug #268 (MEDIUM)** — `BatchService.consumeBatch`: повний FIFO/FEFO/LIFO/AVG_COST tests + integration з batch consumption table — ніколи не викликається з `inventory.createMovement(WRITEOFF)`. Batch tracking decoupled від WO write-off.

**Причина виникнення:** sprint-структура (feat-sprint #1: «Implement loyalty service») vs (feat-sprint #2: «Integrate loyalty into payment flow») — другий sprint часто **відкладається** як «follow-up», робиться інша робота, через рік документація каже «фіча є», UI tab показує її, але **integration point не написаний**. Спостерігається у тестових системах де unit tests pass, contract specs pass (бо мокають service з payments) — НЕ покривають end-to-end flow. Code review бачить «сервіс OK, тести зелені» і пропускає.

**Підхід до виявлення:** на Кроці 1 §1.1 — для КОЖНОГО `@Injectable` сервісу що має queue/processor companion (`@nestjs/bull`, `@Processor`):

```bash
# Знайти сервіси з queue infrastructure
grep -rl "InjectQueue\|@Processor" apps/api/src/modules --include="*.ts" | while read f; do
  service=$(dirname "$f")
  # Знайти всі public методи сервісу
  for method in $(grep -oE "async [a-zA-Z]+\(" "$service"/*.service.ts | sed 's/async //;s/(//' | sort -u); do
    # Перевірити callsites поза модулем самого сервісу + поза spec
    callers=$(grep -rln "\.$method\(" apps/api/src --include="*.ts" | grep -v "spec\|$service" | wc -l)
    if [ "$callers" -eq 0 ]; then
      echo "DEAD: $f::$method (only callers: own module + spec)"
    fi
  done
done
```

Парний сигнал: UI має tab/sidebar/settings для цієї фічі (наприклад settings.tsx показує `loyaltyEnabled` toggle + counterparty page показує loyalty balance card) — це означає фіча розрекламована для користувача, але інтеграція мертва. Severity автоматично HIGH (broken promise).

Також перевірити callsites через ` ` (грantion-symbol) — sometimes service called через event emitter / pub-sub без прямого `.method()` виклику.

**Підхід до фіксу:** ідентифікувати **природний trigger point** для фічі і додати виклик там, з захистом:

- **Не блокуючий** виклик (`.catch(err => logger.warn(...))`) — щоб помилка інтеграції не блокувала основний flow (платіж проходить навіть якщо queue вниз).
- **Imported модуль** у відповідний `*.module.ts` (LoyaltyModule → PaymentsModule.imports[]).
- **DI у constructor** з нової залежності.
- **Spec-update** — додати integration-test що мокає loyaltyService.queueEarn і верифікує що `.toHaveBeenCalledWith(orgId, counterpartyId, amount, paymentId)` при успішному `payments.create`.

**Severity:** HIGH коли feature розрекламована (UI tab/sidebar/settings); MEDIUM коли internal optimization (batch tracking — admin-only audit feature); CRITICAL коли security-критична (audit log integration).

**Де шукати ще:** будь-який модуль з queue/processor companion (notifications, webhooks, exports, sync) — перевірити чи trigger-сервіс реально викликає `queueX`. Особливо коли:

- Новий модуль доданий нещодавно (sprint 21+ у STO ERP).
- Module має `BullModule.registerQueue` АЛЕ payments/work-orders/settlements не імпортує цей модуль.
- Settings-tab/dashboard-card для фічі існує АЛЕ нема telemetry/audit-logs про trigger.

---

### 2026-05-31 — Frontend hint обіцяє backend behavior якого немає (Bug #266) — frontend, ux-lie, contract-gap

**Сигнал:** UI-хінт (зазвичай `<p className="text-xs text-muted-foreground">`) під selector/checkbox/input обіцяє автоматичну backend-дію:

- `"буде додано після відкриття наряду"`
- `"автоматично застосується при наступному платежі"`
- `"скопіюється у новий документ"`
- `"буде використано як шаблон для X"`

АЛЕ:

- POST/PATCH body запиту НЕ містить відповідного поля (наприклад `templateId` для template apply).
- DTO на бекенді НЕ має такого поля.
- Service-метод НЕ виконує описаної дії.

Знайдено у Bug #266: WO create modal показує `Select шаблону` + хінт «буде додано після відкриття наряду», але:

1. `create()` POST body має `{branchId, vehicleId, counterpartyId, description, ...}` — НЕ `templateId`.
2. `CreateWorkOrderDto` НЕ має `templateId`.
3. `WorkOrdersService.create` НЕ зчитує шаблон і НЕ копіює `lines`/`parts`.

UI відверто бреше користувачу. Користувач створює наряд, відкриває його, чекає на lines/parts → їх немає → confused/frustrated.

**Причина виникнення:** UI-mockup створено раніше backend-логіки. Розробник пише UI-промо-текст («буде додано»), думаючи що backend подальше зробить це. Backend sprint фокусується на іншій частині, hint лишається. Code review не помічає, бо це лише `<p>` text — виглядає інформативно.

**Підхід до виявлення:** на Кроці 1 §1.3 — grep всі UI-хінти зі словами-обіцянками:

```bash
# Знайти UI хінти що обіцяють backend-дію
grep -rnE "буде (додано|застосовано|скопійовано|створено|нараховано|використано|враховано|оновлено)|автоматично (X|застосується|створиться|нарахується|спрацює)|після (створення|відкриття|збереження)" apps/web/src --include="*.tsx" | head -20

# Для кожного хінту → знайти найближчу POST/PATCH-функцію → перевірити чи body містить
# поле, яке упроваджує обіцяну дію (templateId, applyMaintenanceScheduleId, copyFromId).
# Якщо НЕ містить — bug.
```

Парний сигнал: під хінтом є `<Select>` / `<input>` що збирає user-input — якщо value цього controlу НЕ передається у submit-body, hint бреше про backend (хоч можливо переноситься у iншу частину UI flow).

**Підхід до фіксу:** один з двох:

1. **Реалізувати backend integration** (preferred): додати поле у DTO, валідацію тенант-ізоляції, service-логіку, integration-test. + frontend передавати значення у POST.
2. **Переписати hint чесно** (мінімум): якщо реалізація blocked (як WO template — потребує schema-extension `defaultEmployeeId`/`defaultWarehouseId`), замінити обіцянку на чесний опис:
   - Було: `"буде додано після відкриття наряду"`
   - Стало: `"додайте вручну на сторінці наряду після створення"`

**Severity:** HIGH коли feature розрекламована як автоматична (selectсr + хінт у головному UI flow); MEDIUM коли opt-in (checkbox що користувач свідомо вмикає).

**Де шукати ще:** modal-форми створення (create modal у \*.page.tsx) — найімовірніше місце для такого drift. Особливо коли:

- Новий feature sprint торкнувся ТІЛЬКИ UI частини.
- Backend має CRUD для resource, але «integration з X» — TODO.
- UI hint містить слово-обіцянку без code-comment що пояснює гарантує-яка частина.

Профілактика: SKILL §1.3 додано checklist item — перевіряти кожен UI-хінт-обіцянку проти POST body і service-логіки.

---

### 2026-05-31 — Mass DTO migration variant audit: всі validator-варіанти + inline 1-рядкові форми (Bugs #257-#265) — backend, dto-validation, sprint-completeness

**Сигнал:** sprint-commit виду «add @Transform(emptyToUndefined) for all optional X-fields» що фокусується на ОДНОМУ типі валідатора (`@IsEmail` або `@IsEnum` чи `@IsDateString`). Розробник grep-ить простий case і знаходить підмножину полів, але:

1. **Пропускає інші validator-типи у тій же сімействі.** Sprint Bug #244 покрив `@IsDateString`, але `@IsISO8601` (інший date-валідатор з іншою сигнатурою) залишається непокритим. Аналогічно sprint можливо покриває `@IsEnum(X)` але пропускає `@IsEnum([literal1, literal2])` (масив-форму). У STO ERP виявлено:
   - work-orders.dto: `@IsISO8601` (plannedAt, dueDate) — НЕ покрито sprintом `@IsDateString`
   - Sprint покрив 32 поля у 7 DTO, але пропустив 22 поля у 7 інших DTO

2. **Пропускає inline 1-рядкові форми.** Sprint grep-шаблон typically багаторядковий:

   ```
   @ApiPropertyOptional()
   @IsOptional()
   @IsEnum(X)
   field?: X;
   ```

   АЛЕ у проєкті є inline-форма:

   ```
   @ApiPropertyOptional() @IsOptional() @IsEnum(X) field?: X;
   ```

   що не матчиться multi-line grep. Це Bug #215 patten.

3. **Пропускає `extends PartialType(X)` derived DTO.** Якщо CreateDto має проблему, UpdateDto extends PartialType успадковує її автоматично — sprint бачить тільки одну точку, а їх дві (CreateGoodDto + UpdateGoodDto).

**Причина виникнення:** sprint описі завдання фокусується на use-case («фронт шле `''` для скинутого селекту → 400»). Розробник:

- запускає grep `@IsDateString` (з конкретної проблеми, де поле було `@IsDateString`),
- знаходить 15 матчів,
- додає трансформ у кожен,
- closes sprint.

АЛЕ:

- `@IsISO8601` пропущено — інший валідатор, той самий symptom («фронт шле `''` → 400»).
- inline `@ApiPropertyOptional() @IsOptional() @IsEnum(...) field?: X;` не матчиться multi-line grep шаблону «4 строки».
- `@IsEnum([literal1, literal2])` (string-literal union форма) — інша грамматика, той самий symptom.

**Підхід до виявлення:** для кожного sprint що додає трансформ/валідатор/pipe → **варіантний audit** перед closing:

1. **Перерахувати всі validator-сімейства** що мають той самий symptom:
   - Date/time: `@IsDateString`, `@IsISO8601`, `@IsDate` (різні validators, всі ловлять `''`)
   - Enum: `@IsEnum(Type)`, `@IsEnum([literal1, literal2])`, `@IsIn([...])` (різні API, той самий ефект)
   - Email/URL/UUID: `@IsEmail`, `@IsUrl`, `@IsUUID`, `@IsUUID('4')` (з аргументами і без)

2. **Перевірити обидва формати** (multi-line + inline):

   ```bash
   # Multi-line (standard грамматика)
   grep -rPzo "@IsOptional\(\)\s*\n\s*@IsX\(" apps/api/src/modules --include="*.dto.ts"
   # Inline (1-рядкова грамматика)
   grep -rE "@IsOptional\(\).*@IsX\(" apps/api/src/modules --include="*.dto.ts"
   ```

3. **Перевірити PartialType derivation chains:**

   ```bash
   grep -rE "extends PartialType\(" apps/api/src/modules --include="*.dto.ts"
   ```

   Для кожного — перевірити батьківський DTO не має проблеми (інакше UpdateDto автоматично її наслідує).

4. **regression-guard тести для нового patten:** для кожного DTO з трансформом — додати 1 contract-spec `it`-блок «POST/PATCH з порожнім рядком у поле X → 201/200 + service отримує undefined». Без цих тестів регресія `@Transform` decorator removal пройде CI зеленою (Bug #244 patten).

**Підхід до фіксу:** одночасно для всіх знайдених варіантних форм:

```ts
// Перед
@ApiPropertyOptional() @IsOptional() @IsISO8601() plannedAt?: string;

// Після (multi-line розгортка для зрозумілості + @Transform)
@ApiPropertyOptional()
@IsOptional()
@Transform(emptyToUndefined)
@IsISO8601()
plannedAt?: string;
```

Додати regression-guard test для КОЖНОГО зміненого DTO (1 `it`-блок) у відповідний contract spec.

**Severity:** HIGH для кожного знайденого gap (фіча мертва у проді коли фронт шле `''`); MEDIUM якщо існують тести але не покривають саме нову поведінку (regression-guard gap).

**Де шукати ще:** будь-який майбутній mass-DTO sprint:

- «Migrate `@IsString` → `@MaxLength + @IsString`» — перевірити `@IsString` + `@IsEmail` + `@IsUrl` + `@IsAlphanumeric` (всі string-валідатори)
- «Add `@Transform(toLowercase)` для всіх email-полів» — перевірити `@IsEmail` + `@IsString` що використовуються для email
- «Add `@Type(() => Number)` для всіх числових query params» — перевірити `@IsNumber` + `@IsInt` + `@IsDecimal` + `@IsPositive`
- «Change date format» — `@IsDateString` + `@IsISO8601` + `@IsDate` + custom `@IsDateString({ strict: true })`

Профілактика: SKILL §1.2 тепер вимагає **варіантний audit** для будь-якого mass-DTO sprintу:

1. Перерахувати всі validator-сімейства того ж symptom-у.
2. Перевірити inline + multi-line форми.
3. Перевірити PartialType derivation chains.
4. Додати regression-guard test для КОЖНОГО зміненого DTO (Bug #244 patten).

---

### 2026-05-31 — Публічний endpoint (no-auth) подвійна перевірка: array-cap у DTO + tenant-FK у service для кожного array UUID-ідентифікатора (Bugs #251 + #252) — backend, security, public-endpoint

**Сигнал:** controller-метод БЕЗ `@UseGuards(JwtAuthGuard)` (повний клас БЕЗ `@UseGuards` на рівні контролеру або handler-method з `@Public()` / без guard у списку). Сценарії: booking widget на лендингу СТО, форма зворотного зв'язку, public catalog API. DTO такого endpoint часто скопійовано з auth-protected DTO без подвійного перегляду: `@IsArray() @IsUUID(undefined, { each: true })` ЗАЛИШЕНО але `@ArrayMaxSize(N)` пропущено; service `prisma.X.create({ data: { ...dto, fkList: dto.fkList } })` зберігає raw array UUID-ів без tenant-FK перевірки. Виявлено у `booking.dto.ts` (`serviceIds` на обох DTO) + `booking.service.ts` (no `prisma.work.count` guard).

**Причина виникнення:** PR-описи фокусуються на use-case («публічний бронювальний віджет показує слоти за вибраним сервісом»). Розробник перевіряє happy path: 1-3 послуги, UUID валідний, branch належить org. Edge case (attacker контролює payload, has no auth, не обмежений швидкостями) рідко спливає у code review. Особливо ризик у monolith з global `ThrottlerGuard` що дає N запитів/хв на IP — `body` size перевіряється лише на nginx/Fastify рівні (типово 1MB), один запит з `Array(50_000).fill(UUID)` ВЖЕ ладить ValidationPipe в N×regex-перевірку до того як reach service.

**Підхід до виявлення:** на Кроці 1 — окреме «public endpoint audit».

1. Знайти всі controller-методи без auth:

```bash
# Контролери без @UseGuards(JwtAuthGuard) на класі
grep -L "JwtAuthGuard" apps/api/src/modules/*/controller.ts 2>/dev/null
# І окремо handler-методи без auth у захищеному контролері (рідкісно)
grep -rB3 "@Get\(\|@Post\(\|@Patch\(\|@Delete\(\|@Sse\(" apps/api/src/modules --include="*.controller.ts" | grep -A1 "@Public\(\)"
```

2. Для кожного public endpoint → прочитати DTO + service:
   - КОЖЕН `@IsArray()` у DTO → перевірити `@ArrayMaxSize(N)` суміжно. Без cap → HIGH bug (DoS).
   - КОЖЕН `string[]` / `T[]` поле у service-create → перевірити tenant-FK guard (`prisma.X.count({ where: { id: { in: dto.field }, orgId, deletedAt: null } })`). Без guard → HIGH bug (cross-tenant linkage у БД).
   - КОЖЕН `@IsString()` поле → `@MaxLength(N)` (anti-DoS).
   - КОЖЕН `@IsUUID()` поле → ОК (UUID validator уже bounded).

3. Парний сигнал: якщо public endpoint викликає external service (SMS, ПРРО) → перевірити що queue має attempts ≥ 10 + exponential backoff (offline-first invariant; уже у §1.1 «Bullq attempts»).

**Підхід до фіксу:** обидва місця одночасно — DTO + service. Якщо ARRAY обмежено лише у DTO, але service приймає його як-є → captured tenant-FK gap. Якщо обмежено лише у service (tenant-guard є, але `@ArrayMaxSize` нема) → DoS-вектор НЕ закрито (validation відбувається ДО service). Шаблон фіксу — `Promise.all([branchGuard, serviceCountGuard])` паралельно (`branch.findFirst` + `work.count({ where: { id: { in: serviceIds }, orgId } })`), потім `if (count !== serviceIds.length) throw BadRequestException`.

**Severity:** HIGH для кожного знайденого gap (DoS або cross-tenant linkage); CRITICAL якщо public endpoint модифікує fingerprint/audit/balance.

**Де шукати ще:** будь-який майбутній public endpoint (form-builder, RFQ, customer-portal, B2B catalog). Профілактика: SKILL §1.4 раніше вимагав anti-DoS для всіх DTO. Тепер тестер повинен ОКРЕМО ідентифікувати public-endpoint set і застосувати **double-strict** правила: і `@ArrayMaxSize` у DTO, і tenant-FK у service. Парне з: paired-component req-id link (Bug #216) — public endpoint часто перший на отримання traffic-storm, тому correlation-id для них критичний.

---

### 2026-05-31 — Inner DTO class з порожніми полями: @ValidateNested без декораторів усередині пропускає всі значення (Bug #247) — backend, security, dto-validation

**Сигнал:** outer-DTO має `@IsArray() @ValidateNested({ each: true }) @Type(() => InnerDto) lines!: InnerDto[]` — все «правильно». АЛЕ inner DTO `InnerDto` оголошено як:

```ts
export class TemplateLineDto {
  @ApiProperty() workId!: string;
  @ApiProperty() quantity!: number;
  @ApiProperty({ required: false }) note?: string;
}
```

— тобто з `@ApiProperty()` (для Swagger), але БЕЗ жодного `@IsUUID`/`@IsNumber`/`@IsString`/`@Min`/`@MaxLength`. Outer-DTO виглядає захищеним (`@ValidateNested` + `@Type`), але `class-validator` валідує inner DTO **тільки** через його ВЛАСНІ декоратори — а їх нема → всі поля приймаються as-is (`workId: 'NOT-A-UUID'`, `quantity: -999`, `note: 'a'.repeat(1e6)`). `whitelist: true` теж не допомагає — він не знімає поля інформаційно (з точки зору schema-validator поле «задеклароване»).

**Причина виникнення:** розробник, який пише inner DTO, фокусується на **shape** для Swagger (`@ApiProperty` дає правильний UI у docs). class-validator валідатори — це окрема концептуальна площина, і легко припустити: «outer-DTO має `@ValidateNested` → значить inner валідується автоматично». Хибно: `@ValidateNested` лише **вмикає** валідацію inner DTO; самі правила мають бути всередині нього. Це частіше виникає для «тривіальних» helper-DTO (template-lines, schedule-entries, contact-data) де розробник вважає що ID/quantity самі по собі «зрозумілі».

**Підхід до виявлення:**

1. На Кроці 1 §1.2 — після кожного `@ValidateNested @Type(() => InnerDto)` в outer-DTO знайти визначення InnerDto і перевірити чи кожне поле має class-validator декоратор.
2. Grep-сигнатура (наближена): шукати inner DTO в `.dto.ts` де `@ApiProperty()` стоїть прямо перед `[a-z]!: string|number|boolean` без сусіднього class-validator декоратора у попередніх 3 рядках.
3. **Парний сигнал anti-DoS:** outer-DTO з `@ValidateNested @Type(() => InnerDto)` БЕЗ `@ArrayMaxSize(N)` = double-bug (DoS attack vector + полна валідація bypass). Виправляти обидва одночасно.

```bash
# Знайти потенційні inner DTOs без декораторів
for f in $(find apps/api/src/modules -name "*.dto.ts"); do
  # для кожного class у файлі — перевірити чи поля мають @Is*
  awk '/^export class/{cn=$3} /@ApiProperty\(\)$/{ap=NR} /[a-z]+!: (string|number|boolean)/ && ap==NR-1 {pre=""; for(i=NR-3;i<NR;i++) pre=pre line[i]; if(pre !~ /@Is|@Min|@Max|@Length|@Match/) print FILENAME":"NR": "cn" "$0}' "$f"
done
```

**Підхід до фіксу:** для кожного поля inner DTO додати точний декоратор:

- `workId/goodId/branchId` → `@IsUUID()`
- `quantity/price/normoHours` → `@IsNumber() @Min(0)`
- `note/description` → `@IsString() @MaxLength(500)` (плюс `@IsOptional` якщо `?:`)
- enum-поля → `@IsEnum(EnumType)`

Парне з: додати `@ArrayMaxSize(N)` у outer-DTO (Bug #248-style anti-DoS cap).

**Severity:** HIGH — повна обходка validation для вкладеної структури + потенційний DoS через відсутнє `@ArrayMaxSize`. Не CRITICAL бо для exploit потрібна додаткова логіка (e.g. workOrderTemplate apply, який повинен сам перевіряти FK org-scope), але це другий вузол захисту — без першого attack surface значно ширший.

**Де шукати ще:** будь-який сервіс що має «helper-DTO» (template-lines, schedule-entries, contact-info, batch-items, line-items, address-parts). Особливо новостворені модулі — там часто з'являються лише `@ApiProperty` без `@IsXXX`. Перевіряти ОБОВ'ЯЗКОВО кожен новий `*.dto.ts` що має >1 експорт класу.

---

### 2026-05-31 — Shared helper з cross-DTO impact без unit-тесту → silent regression через десятки endpoint-ів (Bug #243) — backend, test-coverage, shared-utility

**Сигнал:** новий `apps/api/src/common/transforms/*.ts` або `apps/web/src/lib/*.ts` (pure-function helper) що імпортується у **N≥5 DTO/сервісах/компонентах**. Файл сам по собі — 1-3 рядки коду; жоден `*.spec.ts` поряд. Sprint-commit що додає helper здебільшого фокусується на use-sites (21 DTO update у `7f052d5`), не на самій utility — бо «logic тривіальна, очевидно працює». Регресія типу:

- `value === ''` → `!value` (виглядає схожим, але хибне для `0`/`false`/`null`),
- повертати `null` замість `undefined` (`@IsOptional` приймає лише `undefined` за замовчуванням),
- зміна shape з `({ value })` на `(value)` (TransformFn signature breaks).

— пройде CI зеленою бо тести DTO/components часто інтеграційні і не покривають всі гілки helper-логіки.

**Причина виникнення:** psychological «це 3 рядки, що там тестувати». Sprint review зосереджується на що **використовує** helper (мерж 21 DTO), а не сам helper. Бо «якщо helper зламаний — це покажуть 21 інших тестів». Хибно: ці тести часто покривають лише happy path (UUID-валідний → 201), не альтернативні падіння (`null` → ??).

**Підхід до виявлення:** після кожного commit що додає файл у `apps/api/src/common/` або `apps/web/src/lib/` з default-export чи named-export pure function — перевірити чи існує парний `*.spec.ts`. Якщо helper імпортується у >2 файли — spec обов'язковий. Grep: `git diff HEAD~5 HEAD --name-only --diff-filter=A | grep -E "common/|lib/" | grep -v ".spec." | grep ".ts$"` — кожен файл pair-check проти `find apps -name "$(basename $f .ts).spec.ts"`.

**Підхід до фіксу:** створити `*.spec.ts` поруч з helper. Покрити мінімум: (1) happy path; (2) кожен boundary (`''`/`0`/`null`/`undefined`/`false` — особливо для pure transformers); (3) shape API (входить object, повертає primitive — або навпаки). Tests pure, без NestJS/Prisma — швидкі (<10ms).

**Severity:** LOW — поточний код працює; стає HIGH коли регресуюча зміна потрапляє у helper (cascading break через N use-sites без видимого failure).

**Де шукати ще:** будь-який майбутній `common/transforms/`, `common/utils/`, `common/decorators/`, `lib/format-currency.ts`, `lib/parse-decimal.ts`, `lib/api-client.ts` — все що pure/imported по проєкту. Профілактика: SKILL §1.5 unit-test матриця тепер вимагає spec для будь-якого нового shared helper (≥1 import у не-spec файлі).

---

### 2026-05-31 — Sprint що додає нову поведінку DTO/validation без regression-test точно для цієї поведінки (Bug #244) — backend, test-coverage, regression-guard

**Сигнал:** commit-message виду «add @Transform(emptyToUndefined) for all optional UUID fields» / «add @ValidateNested для всіх масивних DTO» / «change @IsUUID() → @IsUUID('4')». Sprint виправляє конкретний клієнтський сценарій (фронт шле `''` для скинутого селекту → 400). Existing contract-spec тестує лише original cases (400 на невалідний UUID; 201 на валідний UUID), **але не саме той сценарій що додавали** (201 на `''` → undefined). Sprint реалізує те що задумано, тести **жодним чином не валідують саме нову поведінку**. Регресія типу «відкатили `@Transform` при refactor бо щось інше зламав» — tsc green (декоратор не обов'язковий), 400 повертається лише у production коли фронт шле `''`.

**Причина виникнення:** sprint фокусується на implementation; review зосереджений на «чи додано декоратор у всіх DTO». Тести вже є (вони перевіряли 400 на невалідний UUID), і це створює false-confidence: «існуючі контракт-тести вже покривають валідацію». Хибно: вони перевіряють **інверсну** гілку (валідація FAILS), а нова поведінка — це що валідація **passes** для конкретного нового inputу. Без регресійного тесту саме на цю гілку — нікому не очевидно що `@Transform` ефективно працює.

**Підхід до виявлення:** при review sprint-commit-у виду «add transform/validator/pipe для N DTO» — для **2-3 DTO найвищого ризику** (`bank-accounts`, `calendar`, `work-orders` тощо) перевірити чи existing contract-spec має `it(описати новий happy-path)` що: (1) шле саме той inputу що раніше валився; (2) assert 201/200 (не 400); (3) assert service-mock викликаний з **transformed** payload (`branchId: undefined`, не `branchId: ''`). Якщо відсутній — bug.

**Підхід до фіксу:** додати 1 `it` блок у кожен з ~3 representative DTO-spec. Mock service create → success; inject POST з порожнім рядком у новий optional field; assert 201 + `mock.calls[0][1].fieldX === undefined` (саме `undefined`, не `null` чи `''`).

**Severity:** MEDIUM — поточний код працює; регресія беззвучна (фронт ламається лише на production interactions, dev-fixtures зазвичай повний payload).

**Де шукати ще:** будь-який sprint що змінює validation/transform/pipe shape для широкого набору DTO (наприклад: «зміна @MaxLength з 100 на 500», «новий @Trim() decorator», «зміна date format»). Профілактика: SKILL §1.5 тепер вимагає 1 «новий-happy-path» test для кожного wave-refactoring sprintу (regression-guard саме нової поведінки, не original strict-валідації).

---

### 2026-05-31 — DTO write-side asymmetry: column declared, FSM transition не persists її у row (Bug #236) — backend, data-integrity, state-machine

**Сигнал:** sprint додає nullable FK/scalar колонку у `*.prisma` модель + `unitOfMeasureId?: string | null` у `XLineResponseDto` + mapping `unitOfMeasureId: l.unitOfMeasureId ?? null` у `toDto`. FSM transition (CONFIRMED, RECEIVED, IN_PROGRESS) обчислює resolved value (`lineUnitId = good.unitId`) і пропагує його у **side-effect resource** (StockMovement через `inventory.createMovement(unitOfMeasureId)`), АЛЕ забуває оновити **сам поточний row** (`tx.stockDocumentLine.update({ data: { unitOfMeasureId: lineUnitId } })`). Симптом: `findOne(id)` ПІСЛЯ transition повертає `lines[i].unitOfMeasureId === null` навіть коли StockMovement рядки мають коректне значення. tsc green (поле nullable, no compile pressure), unit tests green (немає spec для transition), code review зосереджується на side-effect (movement) а не на самому row. **Cross-resource inconsistency**: history (movements) має X, current state (line.row) має NULL → audit/sync/export ламається.

**Причина виникнення:** symmetric до Bug #232 (read-side: column declared у DTO, але Prisma `include` не fetch-ить — DTO віддає undefined). Write-side версія: розробник пише код side-effect rich operation і думає що головне — створити правильний StockMovement (це йде у history, append-only). Сам "owner" rowу (StockDocumentLine, PurchaseOrderLine) — це **поточний стан**, його теж треба оновити при transition. Логіка створення rowу (create) уже встановлювала всі поля одразу (тоді колонки ще не існували — backward compat), тому write-path не звичний. SKILL Bug #232 фікс додав `include` у read path; write path лишився непокритий.

**Підхід до виявлення:** на Кроці 1 §1.1 — для будь-якого diff що додає nullable колонку у row-модель (`PurchaseOrderLine`, `StockDocumentLine`, `InvoiceLine`, `WorkOrderPart`) і **mapping `l.<field> ?? null` у toDto**:

1. Знайти всі FSM transitions для цієї моделі (`transition(CONFIRMED|RECEIVED|IN_PROGRESS)`, `receive()`, `applyPricing()`, …).
2. Для кожної — у тілі циклу `for (const line of doc.lines)` шукати чи resolved value (наприклад `lineUnitId = good.unitId`) пишеться у `tx.<row>.update({ data: { <field> } })`. Якщо передається лише у side-effect resource (`inventory.createMovement(<field>)`) — bug.
3. Особлива увага: створення row через `create`/`createMany` без поля (поле залишається NULL) + transition не оновлює → row назавжди NULL.

Grep-сигнатура (по diff):

```bash
# Знайти всі toDto що мапять l.<field> ?? null без update у transition
grep -rnE "[a-z]*Id:\s*l\.[a-z]*Id\s*\?\?\s*null" apps/api/src/modules --include="*.service.ts"
# Для кожного — у тому ж файлі знайти transition/receive/transitionToConfirm:
grep -B5 "stockMovement.create\|inventory.createMovement\|workOrderPart.update" apps/api/src/modules/<module>/<module>.service.ts | grep -v "tx\.<row>\.update"
```

Property-test invariant: ПІСЛЯ transition `findOne(id).lines.every(l => l.unitOfMeasureId === movements[lineIdx].unitOfMeasureId)`.

**Підхід до фіксу:** у `for (const line of doc.lines)` циклу transition додати explicit `update` для самого row перед/після side-effect:

```ts
if (resolvedValue) {
  await tx.<row>.update({
    where: { id: line.id },
    data: { <field>: resolvedValue },
  });
}
```

Guard `if (resolvedValue)` пропускає null no-op коли fallback не знайшов значення. Розмістити після всіх side-effect creates (StockMovement) у тому ж блоці — атомарно у $transaction. **Не** робити окремий повторний цикл (зайвий round-trip + race-window). Якщо decision-table велика — окремий helper `await updateLineWithUom(tx, line.id, resolvedValue)`.

**Severity:** HIGH — silent data integrity gap (UI/PDF/sync/audit показує NULL замість коректного UoM). Cross-resource consistency порушено (StockMovement.uomId ≠ StockDocumentLine.uomId). Дані у БД технічно "коректні" (NULL = backward-compat allowed), але feature що додавалась саме для display/audit — **мертва на write-path**.

**Де шукати ще:** будь-який майбутній sprint що додає nullable колонку у row-модель з FSM transitions:

- `WorkOrderPart.unitOfMeasureId` (якщо колись додасться) → transition(COMPLETED) має пропагувати у row;
- `InvoiceLine.discountAppliedAmount` → transition(PAID) має зафіксувати застосовану знижку у row;
- `BatchConsumption.consumedAt` → confirm-consumption має зафіксувати у row;
- будь-який field з patterns "resolved при transition", "computed на CONFIRMED", "applied at FSM event".

Профілактика: SKILL §1.1 тепер вимагає write-path audit для кожної nullable колонки що з'являється у `toDto` маппінгу — не лише read-path `include` (Bug #232).

---

### 2026-05-31 — UoM/coefficient conversion missing на submit (Bug #231) — frontend, business-logic, data-corruption

**Сигнал:** фронт-формула `newQty = currentQty * (oldCoeff / newCoeff)` при переключенні Select UoM (Krok 5 patten) **зберігає інваріант** `qty_base = display × coeff` у локальному state, але `handleCreate` / submit-функція шле `parseFloat(l.quantity)` як-є — БЕЗ множення на `coefficient`. Backend очікує quantity у **базових одиницях** Good (`Good.unit`), а отримує display-value у обраній UoM → silent data corruption: stock movement, payable, applyPricing — все спотворюється на множник coefficient. Видно ЛИШЕ коли користувач реально перемикає UoM (coeff != 1); coeff = 1 (default UoM, або відсутні UoMs) — happy-path працює, регресія приходить у прод коли власник СТО заводить реальні UoMs. tsc green, unit tests green, ручне QA з default UoM green.

**Причина виникнення:** Krok 5 спека описує лише **display-transition formula** ("newQty = currentQty * oldCoeff/newCoeff"). Розробник реалізує саме її і додає коментар `// Перерахована кількість з урахуванням коефіцієнта` думаючи що formula виконує **і** display-перехід **і** display→base конверсію. Але формула — це маса-балансна формула між двома UoMs (qty1*coeff1 = qty2*coeff2 при коефіцієнтах base_units_per_uom), вона **не зводить до base unit** — вона зберігає інваріант. Submit потребує **окремої** конверсії `qty_base = display * coeff` АБО backend має зберігати UoM ID разом з quantity і конвертувати на stock-movement. Спека "Backend отримує тільки перераховану quantity, без unitId" → frontend MUST конвертувати.

**Підхід до виявлення:** на Кроці 1 §1.1 / §1.3 — для будь-якого UoM/unit-conversion patten (Select з coefficient, custom unit picker) перевірити **обидва кінця**:

1. **Display transition** (Select onChange): formula `newDisplay = oldDisplay * oldCoeff / newCoeff` — invariant preservation. ✓
2. **Submit conversion** (handleCreate/save): чи `parseFloat(displayQty) * coefficient` подається у API (база units)? Якщо submit шле raw display value БЕЗ множення — **data corruption**.

Grep-сигнатура: для UoM-aware Select-fields знайти submit-функцію та перевірити чи `quantity * coefficient` обчислюється:

```bash
# 1. Знайти всі local state з UoM-fields (coefficient + display quantity у одному рядку)
grep -rn "coefficient:\s*number\|coefficient:\s*1\b" apps/web/src/app --include="*.tsx" -l

# 2. Для кожного — знайти submit-функцію (handleCreate/handleSave/handleSubmit) і перевірити mapping
grep -rn "handleCreate\|handleSave\|handleSubmit" apps/web/src/app --include="*.tsx" -l | xargs grep -l "coefficient"

# 3. Червоний прапор: parseFloat(l.quantity) у submit БЕЗ * coefficient — баг
grep -rn "quantity:\s*parseFloat" apps/web/src/app --include="*.tsx" -B5 | grep -B5 "coefficient" | grep -v "coefficient ||\|\* coeff\|\* (l\.coefficient"
```

Property-test invariant: для будь-якої комбінації (qty, coeff) ∈ [0.001, 10000] × [0.001, 1000] — `submit_quantity = display_quantity * coefficient` повинен зберігати інваріант з backend's expected base-unit value. Перевіряти і `price`: backend's expected price-per-base-unit = display_price / coefficient.

**Підхід до фіксу:** у submit-функції додати explicit конверсію:

```ts
const coeff = l.coefficient || 1;
const displayQty = parseFloat(l.quantity);
const displayPrice = parseFloat(l.price);
return {
  goodId: l.goodId,
  quantity: displayQty * coeff, // base units
  price: displayPrice / coeff, // per base unit
};
```

`totalAmount` зберігається (qty_base × price_base = qty_display × price_display). Backward-compat: coeff=1 → ідентична поведінка. Якщо backend має RECEIVE-form чи інші surface-ди що приймають qty без UoM — узгодити їх теж на base unit.

**Severity:** CRITICAL (data corruption у stock-движенні, неможлива partial fulfillment-tracking, applyPricing з невірним cost-per-unit) — release-blocker.

**Де шукати ще:** будь-який form/modal у `apps/web/src/app/` що:

1. Має `coefficient: number` + `unitId: string` + `unitShortName: string` поля у local lines state;
2. Має `<Select>` що дозволяє перемикати UoM з recalc display quantity;
3. Має submit-функцію що мапить `validLines` → API payload.

Конкретно: `purchase-orders/page.tsx`, `stock-documents/page.tsx`, потенційно `work-orders/page.tsx` (parts-tab), `invoices/page.tsx` (якщо колись додасться UoM Select у line-form), POS / Кас mobile/web — будь-який surface що бере display-qty і шле у API.

---

### 2026-05-31 — Prisma schema mutation без парного migration (Bug #220) — database, release-blocker, schema-migration

**Сигнал:** commit з `feat(X)` що додає або змінює модель у `packages/database/prisma/schema.prisma` (нова `model X { ... }`, додатковий field у існуючій моделі, новий `@@unique`/`@@index`) АЛЕ **не створює** парного SQL-файлу у `packages/database/prisma/migrations/<timestamp>_X/migration.sql`. tsc green (Prisma client типи генеруються з schema, не з applied DB schema), unit tests green (vi.fn() mocks не торкаються DB), API webpack build green. У runtime — `PrismaClientKnownRequestError P2021` ("The table `X` does not exist") при першому виклику нового endpoint. Прикладий випадок STO ERP: `0227c44 feat(uom): krok 1+2 — GoodUoM model + /goods/:id/uoms CRUD endpoints` додав `model GoodUoM { ... }` (18 рядків у schema) + 113 рядків service-логіки + 54 рядки controller, але міграцію забув — таблиця `good_uom` не існує у БД.

**Причина виникнення:** Prisma toolchain розділяє **declarative schema** (`schema.prisma`) і **applied migrations** (`migrations/*.sql`). Розробник у момент дизайну фічі думає у термінах schema (Prisma client автоматично типизує `prisma.goodUoM.findMany()` після `prisma generate`), забуває що це **TypeScript-only ефект**. CI/dev workflow зазвичай має `prisma migrate dev` команду яка автоматично генерує migration від schema diff, але у безперервній CI/auto-mode розробника-AI ця команда не запускається (бо потребує live DB connection + interactive prompt для імені migration). Закомічено лише `schema.prisma` → reviewer (включно з sto-review) перевіряє правильність моделі, бачить індекси і FK у schema → схвалює → release-blocker проходить.

**Підхід до виявлення:** на Кроці 1 §1.1 — для кожного commit що зачіпає `packages/database/prisma/schema.prisma`, перевірити `git diff HEAD~N HEAD -- packages/database/prisma/`:

```bash
# Якщо schema.prisma додав/змінив модель → має бути новий каталог у migrations/
schema_changes=$(git diff HEAD~3 HEAD --name-only -- packages/database/prisma/schema.prisma)
new_migrations=$(git diff HEAD~3 HEAD --name-only --diff-filter=A -- packages/database/prisma/migrations/)
if [ -n "$schema_changes" ] && [ -z "$new_migrations" ]; then
  echo "BUG: schema.prisma modified but no new migration directory created"
fi

# Конкретніше: кожна нова `model X` у schema → grep у migrations/ за CREATE TABLE "x_table"
grep -E "^model [A-Z]" packages/database/prisma/schema.prisma | awk '{print $2}' | while read model; do
  # convert PascalCase to snake_case (rough heuristic — better to check @@map)
  table=$(echo "$model" | sed 's/\([A-Z]\)/_\L\1/g' | sed 's/^_//')
  if ! grep -rq "CREATE TABLE.*\"$table\"\|CREATE TABLE.*${model}" packages/database/prisma/migrations/; then
    echo "POSSIBLE MISSING MIGRATION: model $model has no CREATE TABLE in migrations/"
  fi
done
```

**Підхід до фіксу:** створити вручну `packages/database/prisma/migrations/<YYYYMMDDHHMMSS>_<feature>/migration.sql` з:

1. `CREATE TABLE "table_name" (...)` — всі колонки з schema, дефолти, `NOT NULL` де треба;
2. `CREATE UNIQUE INDEX` для кожного `@@unique([...])` (з суфіксом `_key` за конвенцією Prisma);
3. `CREATE INDEX` для кожного `@@index([...])` (з суфіксом `_idx`);
4. `ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY ... REFERENCES ... ON DELETE X ON UPDATE Y` для кожного `@relation` — cascade тільки для child-таблиць parent→child (наприклад `goodId` ON DELETE CASCADE), `ON DELETE RESTRICT` для довідникових relations (`unitOfMeasureId` — не можна видалити одиницю якщо хтось її використовує).

Шаблон копіюється з найближчого попереднього migration з аналогічним relation pattern (`grep -l "<related_table>" packages/database/prisma/migrations/*/migration.sql`).

**НЕ запускати `prisma migrate dev`** — це **side-effect** (auto-apply до dev DB + перегенерація client + auto-name через interactive prompt). У AUTO-режимі агенту краще вручну писати SQL і покладатись на наступний deploy щоб `prisma migrate deploy` його застосував.

**Severity:** CRITICAL — release-blocker. Фіча мертва у runtime; unit tests з mocks не ловлять; smoke-test через curl показує 500 на першому ж API call.

**Де шукати ще:** будь-який commit з `feat(*)` що модифікує `schema.prisma`. Особлива увага: (а) розробник додає **колонку** у існуючу модель (`ALTER TABLE X ADD COLUMN Y` migration пропущений → SELECT з нової колонки кидає `column "Y" does not exist`); (б) додано `@@index` для performance — без migration index не створиться, queries працюватимуть але повільно (silent regression замість CRITICAL crash); (в) перейменовано field (Prisma може mapnути через `@map("old_name")` → migration не потрібен, але якщо @map немає — runtime crash). Профілактика: SKILL §1.1 тепер вимагає schema↔migration diff audit у Кроці 1 для кожного commit що зачіпає `schema.prisma`.

---

### 2026-05-31 — UoM/довідникові sub-resource: parent-list staleness після default-switching mutation (Bug #226-#227) — frontend, state-sync, react-query

**Сигнал:** sub-resource CRUD у modal-табі (одиниці виміру/штрихкоди/гарантії/категорії) має «default flag» — одна з рядків — `isDefault: true`, решта `false`. Mutation що змінює default (`setDefaultUoM`, `setPrimaryBarcode`, `setActiveTaxRate`) на backend синхронізує **parent entity** (`Good.unitId`/`Good.unit`/`Vehicle.activeTaxRateId`). Frontend optimistic-update оновлює тільки modal-state (`setModalUoMs(prev => prev.map(u => ({ ...u, isDefault: u.id === uomId })))`) — забуває оновити **parent list** (`load()` для goods/vehicles table). Користувач закриває modal → у списку goods все ще старий unit. Розбіжність зникає лише після reload або refetch goods. Окремий subcase — auto-promote next default при `removeUoM`: optimistic `filter(u => u.id !== uomId)` не знає що backend підняв наступний UoM у default → UI показує жоден як default, DB — новий обраний.

**Причина виникнення:** modal-таб (Edit Good) і parent table (Goods Tab) live в одному компоненті, але стейт-вузли роздільні (`modalUoMs` vs `goods`). Розробник, фокусуючись на UX модалу, реалізує всі CRUD-операції з оптимістичним оновленням `modalUoMs` (швидкий feedback у модалі) і пропускає крок «invalidate parent list». TypeScript і tests не ловлять — `load()` опціональний, не примусовий. У React Query era це класична **cross-cache invalidation gap** (Bug #210-#212 для sibling resources, але тут — для same-page parent state).

**Підхід до виявлення:** у §1.3 frontend audit — для кожного sub-resource CRUD у modal-табі (`addX`/`setDefaultX`/`removeX` функції що викликають backend endpoints які можуть зачепити **parent** entity):

1. Прочитати backend service для відповідного endpoint — знайти всі `prisma.<Parent>.update({...})` АБО `prisma.<Parent>.updateMany({...})` поза собою (тобто не на самому sub-resource).
2. Для кожного знайденого parent-update — перевірити чи frontend success-handler викликає `load()` для parent table АБО invalidate `<parentKeys>.all` (для React Query).
3. Auto-promote scenarios: коли backend `removeX` логіка пише `findFirst({ orderBy: createdAt asc })` + `update({ isDefault: true })` (auto-promote next-default) → optimistic `filter()` на клієнті НЕ ЗНАЄ про це → refetch sub-resource list після DELETE замість optimistic.

```bash
# Знайти sub-resource CRUD у modal-табах
grep -rn "apiFetch.*method:.*'POST\|PATCH\|DELETE'" apps/web/src/app --include="*.tsx" | grep -E "/uoms|/barcodes|/categories|/tax-rates|/warranties" | head -10
# Для кожного — pair-check проти backend service на parent-update side-effects
```

**Підхід до фіксу:** дві дисципліни:

1. **Parent table refresh:** після успіху sub-resource mutation що може змінити parent — викликати `load()` (raw state) АБО `queryClient.invalidateQueries({ queryKey: parentKeys.all })` (React Query). Conditional: тільки коли реально був parent-side-effect (наприклад, `addUoM` оновлює Good лише якщо `isFirst === true` — invalidate тільки тоді; `setDefaultUoM` завжди — invalidate завжди; `removeUoM` тільки якщо видаляли default — capture `wasDefault` перед DELETE).
2. **Sub-resource list refetch замість optimistic filter:** коли backend logic може зробити **state transitions** на інших рядках (auto-promote next default після delete) — оптимістичний `prev.filter(...)` НЕВІРНИЙ; робити `refreshXs(parentId)` (race-guarded через існуючий reqRef).

**Severity:** MEDIUM — стале UI впливає на бізнес-сприйняття (користувач думає що unit не змінився); LOW коли немає бізнес-сенсу (декоративні badges); HIGH якщо стале значення гейтить наступну дію (наприклад, default tax rate у invoice creation).

**Де шукати ще:** будь-який «sub-resource з default-flag» патерн — `/goods/:id/uoms`, `/goods/:id/barcodes` (`isPrimary`), `/counterparties/:id/contacts` (`isMain`), `/vehicles/:id/services` (`isPreferred`), `/employees/:id/branches` (default branch). Профілактика: SKILL §1.3 тепер вимагає parent-list-refresh audit для default-mutating sub-resource operations + refetch-on-delete для auto-promote scenarios.

---

### 2026-05-31 — Paired correlation middleware + structured logger без спільного req-id source (Bug #216) — backend, logging, observability

**Сигнал:** додано в одному sprint (а) HTTP correlation middleware (`CorrelationIdMiddleware` — сетить `x-request-id` header) і (б) structured logger (`nestjs-pino`/`pino-http` з JSON-форматом). У браузері видно `x-request-id: 7f3d-...-uuid` у response, але JSON-лог пише `{"reqId": 1, ...}` (sequential integer). Перевірка `pino-http@*/logger.js`: `function reqIdGenFactory(func) { ... let nextReqId = 0; return function (req, res) { return req.id || (nextReqId = (nextReqId + 1) & maxInt) } }` — дефолт. Ні tsc, ні existing tests не ловлять (logger output не асертиться; smoke-test перевіряє лише HTTP status code).

**Причина виникнення:** обидва компоненти **окремо валідні**. Розробник реалізує middleware першим — testing-через-curl показує header в response → OK. Потім додає logger — JSON логи виглядають правильно (рівні, redact, формат) → OK. Але **інтеграційна точка** (`pino-http.genReqId` має читати той самий header що middleware сетить) ніде не задокументована як обов'язкова. Розробник вважає що **порядок** (middleware першим → pino другим) автоматично робить лінк, але насправді pino-http реєструється як Fastify `onRequest` hook ВПЕРЕД Nest middleware → pino вже зафіксував `req.id = 1` до того як middleware виставить header.

**Підхід до виявлення:** для будь-якого sprint що додає одночасно correlation middleware + structured logger — перевірити чи pino config має `genReqId: req => req.headers['x-request-id']`-based reader. Grep: `grep -rn "genReqId\|reqId" apps/api/src --include="*.ts"`. Якщо нема `genReqId` і є CorrelationIdMiddleware → gap. Альтернативно — sprint review-checklist має «logger ↔ correlation tested end-to-end?» питання: запит з `X-Request-Id: deadbeef-...` має пройти у логах як `reqId: deadbeef-...`.

**Підхід до фіксу:** `pinoHttp.genReqId = req => { const raw = req.headers['x-request-id']; const c = Array.isArray(raw) ? raw[0] : raw; return (typeof c === 'string' && VALID_RE.test(c)) ? c : randomUUID() }`. Middleware тепер додатково гарантує: (а) inbound header валідовано і нормалізовано перед pino; (б) response header echo з того ж source. Альтернатива: видалити middleware і використовувати лише pino з custom genReqId + onResponse hook що echo-ить `req.id` у response. Гірше — суто на боці middleware (бо тоді треба переписати порядок Fastify hooks щоб middleware впав РАНІШЕ pino).

**Severity:** HIGH — feature що додається для production-моніторингу (Sentry, Loki, ELK) не працює. Не runtime crash; ловиться лише вручну при першому incident-debug коли інженер копіює header value з Sentry і не може знайти точний лог у production.

**Де шукати ще:** будь-яке поєднання `nestjs-pino` + middleware (audit-trail, tenant-context, user-id propagation); інші pairings де (а) public-contract компонент і (б) логуючий компонент мають ділити state — наприклад tenant id, employee id у audit logs. Профілактика: SKILL §1.1 Deploy/infra тепер вимагає paired-component req-id link audit при кожному введенні pino + correlation middleware.

---

### 2026-05-31 — Mass DTO migration completeness: incomplete grep variant coverage (Bug #215) — backend, refactor, sprint-wide

**Сигнал:** sprint-wide commit з повідомленням «змінити X у всіх DTO» (`@IsUUID('4')` → `@IsUUID()`, `@Matches(regex)` → `@IsX()`, `@IsString()` → `@IsString() @MaxLength(N)`) — закомічено 20-30 DTO files. Grep по новому паттерну (`@IsUUID()` без args) показує що всюди застосовано, АЛЕ 2-5 file-points у тому ж проєкті лишаються зі СТАРИМ варіантом тому що grep розробника шукав літерально `@IsUUID('4')` і пропустив:

- `@IsUUID('4', { each: true })` — array-форма
- `@IsUUID('4', { message: '...' })` — кастомна error message
- `@IsUUID('4', { groups: [...] })` — validation groups

Кейс з Sprint C4 STO ERP: 22 DTO мігровано, 4 рядки у `employees.dto.ts` (`AssignBranchesDto.branchIds`, `AssignZonesDto.zoneIds`, `AssignLiftsDto.liftIds`, `AssignWorkCategoriesDto.workCategoryIds`) лишилися з `@IsUUID('4', { each: true })`. Тести проходять бо fixtures робилися v4-layout у тій самій сесії. Виявляється лише через dev/seed UUIDs з non-v4 layout (`00000000-0000-0000-0000-000000000002` — BRANCH_ID seed).

**Причина виникнення:** автоматизована migration сесія використовує grep як інструмент знаходження + Edit для заміни. Простий grep (`@IsUUID('4')` як literal) знаходить більшість, але **варіантні форми** з extra args вимагають **regex-grep** або `grep -E "@IsUUID\('4'.*\)"`. Sprint planning описує «замінити X на Y» без явного перерахунку всіх варіантних форм X. Code review зосереджується на правильності нової форми у видимому diff, не аудитує **залишкових** старих форм у inconsистентних file-points.

**Підхід до виявлення:** після кожного sprint-wide refactor — повторити grep з **regex** замість literal. Для UUID: `grep -rnE "@IsUUID\('4'[^)]*\)" apps/api/src/modules/ --include="*.dto.ts"` — кожен match = пропущений file-point. Для `@Matches(uuid-regex)` → `grep -rnE "@Matches\(.*uuid.*\)"`. Для `@IsString()` без `@MaxLength` → bash loop через DTO. Альтернативно: ESLint custom rule («no `@IsUUID('4')` — use `@IsUUID()`») + lint-staged → блокує commit з невирішеним residue. Або: codemod-instrument (`jscodeshift`) який обходить AST і знає про варіантні форми decoratorа.

**Підхід до фіксу:** додати `@IsUUID(undefined, { each: true })` (явний `undefined` як perfix arg) — узгоджує з рештою проєкту. Не міняти `{ each: true }` на лінивий `@IsUUID()` бо це втратить array-validation. Перевірити `@IsUUID('4', { message })` — лишити `message` (i18n)`@IsUUID(undefined, { message })`. Видалити стале коментар у specях що референсить старий стан.

**Severity:** HIGH коли блокує dev/seed workflow (як Bug #215 з branchIds seed); MEDIUM коли блокує лише edge-кейси (v3 UUID з legacy import); LOW коли семантично еквівалентно (рідко — більшість variant forms мають практичні наслідки).

**Де шукати ще:** будь-яка sprint-wide міграція декораторів/типів (validation, swagger, prisma). Особлива увага: Sprint X3-X5 review-сесії що говорять «зробив консистентно у всіх DTO» — review-агент часто не пере-перевіряє повний grep після свого ж фіксу. Профілактика: SKILL §1.2 тепер вимагає regex-grep variant audit після mass DTO refactor.

---

### 2026-05-30 — React Query migration: cache invalidation gaps між cross-resource mutations (Bug #210-#212) — frontend, react-query, cache-invalidation, sprint-B

**Сигнал:** Sprint commit з `feat(rq): migrate X to useQuery` пагується (1) сторінкою що читає через `useQuery` + (2) КОЖНИЙ існуючий mutation (POST/PATCH/DELETE через `apiFetch`) лишається raw з manual `queryClient.invalidateQueries({ queryKey: xKeys.all })`. Розробник перевіряє: «після X mutation я інвалідую X cache» — це коректно для **same-resource** invalidation, але **cross-resource** залежності пропускаються. Приклади з STO ERP:

- `POST /purchase-orders/:id/receive` → server-side створює `RECEIPT` stock movement → `StockItem.quantity` оновлено → `/inventory` cache stale. Frontend інвалідує лише `purchaseOrdersKeys.all`. Користувач відкриває `/inventory` через 5s — бачить старі залишки.
- `POST /purchase-orders/:id/apply-pricing` → server оновлює `Good.salePrice` → `findStockItems` include-ить `salePrice` → `/inventory` grid показує старі sale prices.
- `POST /payments` (з `workOrderId`) → server увеличує `WorkOrder.paidAmount` + транзитує WO статус → `workOrdersKeys.all` cache stale. Frontend інвалідує лише `invoicesKeys.all`.
- `POST /work-orders` (create) → frontend `router.push(/work-orders/:id)` БЕЗ invalidate → юзер `router.back()` у межах staleTime бачить список без щойно створеного наряду.

Регресія не runtime-bug, але **silent UX break** — користувач бачить «застарілі» цифри і не розуміє чому. Усе виправляється ручним refresh, тому bug-report з продакшну зазвичай не приходить — невдоволення лишається.

**Причина виникнення:** React Query migration зосереджується на «один запит — один хук» — це фасадний дизайн. Розробник перевіряє success-path (mutation повертається ОК) і invalidate-path (related list freshens), не моделює side-effects на сервері. Якщо backend контролер виконує `inventory.createMovement` АБО `workOrders.transition` АБО `good.update` АБО `priceHistory.create` — це **транзитивна залежність** яка не видна у клієнтському коді. SKILL раніше казав «mutation → invalidate», але не вимагав читання server-side service для виявлення cross-resource side-effects.

**Підхід до виявлення:** на Кроці 1 §1.3, для **кожного** raw `apiFetch` mutation (POST/PATCH/DELETE) у migrated page → прочитати **серверний** controller+service цього endpoint, і знайти:

1. Всі `prisma.X.update/create/upsert/delete` поза own-resource (наприклад, payments.service updates `workOrder`/`invoice`).
2. Всі виклики `inventoryService.createMovement(...)` (змінює stockItem.quantity → invalidate `inventoryKeys.all`).
3. Всі виклики `workOrdersService.transition(...)` (змінює WO status → invalidate `workOrdersKeys.all`).
4. Всі виклики `settlementsService.createTransaction(...)` (змінює counterparty.balance → invalidate `counterpartiesKeys.all` якщо list endpoint показує balance).
5. Всі виклики `priceHistory.create(...)` (змінює goods.salePrice → invalidate `inventoryKeys.all`/`goodsKeys.all` якщо є).

Для КОЖНОЇ side-effect target — перевірити чи відповідний queryKey інвалідовано у frontend success-handler. Якщо ні → gap. Grep по `await apiFetch.*method:.*'POST\|PATCH\|DELETE'` у migrated сторінці і pair-check проти service-method.

**Підхід до фіксу:** додати додаткові `queryClient.invalidateQueries({ queryKey: Ykeys.all })` для КОЖНОЇ зачепленої resource. Multi-resource invalidation = звичайна mutation success-handler, без структурних змін. Альтернатива (краще): використовувати ВЛАСНІ mutation hooks (`useReceivePO`, `useApplyPricing`) з invalidation у `onSuccess` — централізує знання про side-effects у hook (single source of truth). НЕ покладатись на staleTime=30s бо: (а) пагінований grid може бути на іншій сторінці що користувач уже бачить; (б) DevTools з React Query показує stale-час але звичайний user не моніторить.

**Severity:** MEDIUM коли invalidate gap впливає на бізнес-метрику (залишки/ціни/балансu) — користувач приймає рішення на основі stale-цифр; LOW коли invalidate gap впливає лише на UX (новий запис не з'являється у списку до router.back). Не CRITICAL бо дані у БД коректні; UX recovery — F5 / навігація.

**Де шукати ще:** будь-яка React Query migration сесія (Sprint B-style). Інші likely-точки: `POST /work-orders/:id/transition` COMPLETED → WRITEOFF створює `stock movements` (inventoryKeys) + CHARGE створює settlement (counterpartiesKeys якщо balance показано); `POST /invoices/:id/clone` створює invoice (invoicesKeys ✓) але може зачіпати work-order (workOrdersKeys); `DELETE /work-orders/:id` soft-delete може закрити пов'язаний invoice. Профілактика: SKILL §1.3 тепер вимагає cross-resource invalidation audit для кожного raw mutation у migrated page.

---

### 2026-05-30 — React Query migration incomplete: reads migrated, mutations лишилися raw → mutation hooks dead-code (Bug #213) — frontend, react-query, dead-code, sprint-B

**Сигнал:** commit з `feat(rq): sprint-B3 X — migrate to useX + useXMutation` додає ОБА хуки `useX` (query) і `useXMutation` (mutation з invalidate у `onSuccess`). Сторінка use-ить лише `useX` для читання; усі mutations (`POST/PATCH/DELETE`) залишаються raw `apiFetch` з manual `queryClient.invalidateQueries`. `useXMutation` ніколи не викликається — мертвий export. tsc валідний (export використовується у `index.ts` re-export), runtime ОК, bundle включає dead code, commit message **вводить в оману**. Маса прикладів у Sprint B STO ERP: `useInvoiceTransition`/`useCreatePayment`/`useDeleteInvoice`/`useDeleteCounterparty`/`useDeletePurchaseOrder`/`useApplyPricing`/`useWorkOrderTransition`/`useDeleteWorkOrder` — усі експортовані, **ніде не використовуються**.

**Причина виникнення:** Sprint planning часто має «query + mutation hooks» як один deliverable, але migration story зосереджена на ЧИТАННІ — write-path більш ризикований (FSM, валідація, error-recovery, optimistic updates). Розробник пише hooks завчасно («буде як queries готові»), мігрує сторінки на queries, не доходить до mutations через дедлайн → hooks лишаються «зомбі». Технічно НЕ runtime-bug, але:

- Bundle bloat (8 невикористаних hooks × ~200 bytes each)
- Misleading commit-message → майбутні розробники довіряють «hook налаштовано» і копіюють патерн (дублюючи raw fetch замість використання hook)
- Maintenance дублікат: invalidation логіка живе у двох місцях (hook `onSuccess` + page success-handler)

**Підхід до виявлення:** після кожного React Query migration sprint — grep кожен `export function useX` з `useMutation` у `hooks/api/` і шукати споживачів через `grep -rn "useX" apps/web/src/app --include="*.tsx"`. Якщо count === 0 (поза тестами) → dead hook. Альтернативно: scan `hooks/api/index.ts` re-exports проти actual page imports.

**Підхід до фіксу:** **на tester-сесії** — задокументувати у MemoryManual як incomplete migration (known-state); не видаляти hooks тому що вони можуть знадобитись Sprint B4 і їх краще лишити як reference-implementation. **Альтернатива**: повна міграція pages на mutation hooks — це окремий sprint (B4), не tester scope. Якщо рішення «не мігруємо» — видалити hooks і прибрати з `index.ts` (cleanup commit).

**Severity:** LOW — bundle bloat + maintenance burden + misleading messages, але runtime OK. Може стати MEDIUM якщо invalidation у hook розходиться з invalidation у page success-handler (різна логіка → cache desync).

**Де шукати ще:** будь-яка React Query / SWR / Apollo migration; будь-який abstraction layer що готують «наперед» (DAO classes, repository pattern, command pattern) — особливо у monorepo з декількома team-ами де код пише одна team, споживає інша. Профілактика: коли SKILL §1.3 знаходить dead mutation hooks — або одразу мігрувати (B4), або одразу видалити (cleanup commit); НЕ лишати "поки що".

---

### 2026-05-30 — React Query custom hook без `*.test.tsx`: queryKey factory / enabled-gate / URLSearchParams без regression-захисту (Bug #214) — frontend, test-coverage, react-query

**Сигнал:** новий `apps/web/src/hooks/api/use*.ts` що (а) типизує параметри через `Filter`-interface і будує `URLSearchParams` з нього; (б) має queryKey factory (`xKeys.all`/`.list(filters)`/`.detail(id)`); (в) використовує `enabled: !!employee` для гейту. Без `*.test.tsx` нуль захисту від:

- **queryKey identity-collision:** якщо два різних фільтри-стани випадково отримують один queryKey (наприклад через JSON.stringify-серіалізацію з неоднаковим порядком ключів), React Query показує дані для ОДНОЇ фільтр-комбінації у місці іншої.
- **URLSearchParams gaps:** новий фільтр (`repairCategory`) додано до UI, але в `useX` забуто `if (filters.repairCategory) params.set(...)` → silent filter ignore (точна регресія яка трапилась у 3d5136d під ревью).
- **enabled-gate інверсія:** `enabled: !!employee` → `enabled: !employee` (друкарська помилка) → fetch до auth → 401 у консолі.
- **signal-abort gap:** не пробросити `signal` у `apiFetch` → fetch продовжується після unmount → race на stale state.

**Причина виникнення:** React Query hooks виглядають як «trivial wrappers» — розробник вважає що `useQuery` сам себе тестує. Але фасад навколо `useQuery` (filter→queryString→queryKey→fetch) містить НЕ-тривіальну логіку: URL params серіалізацію, queryKey identity (для cache lookup), enabled gate. Кожна з цих гілок — потенційна регресія.

**Підхід до виявлення:** для кожного нового `hooks/api/use*.ts` що містить `useQuery` АБО `useMutation` → перевірити наявність парного `*.test.tsx`. Шаблон тесту: `useWorkOrders.test.tsx` — 4 describe-блоки: (1) queryKey factory (ізоляція ключів для різних фільтрів); (2) enabled-gate (employee=null → no fetch); (3) URLSearchParams (кожне опціональне поле → відповідний URL param АБО відсутній якщо false-y); (4) signal abort (apiFetch отримує signal від queryFn context).

**Підхід до фіксу:** створити `use<Name>.test.tsx` за шаблоном з мінімальними кейсами (12-15 it-блоків). Mock `apiFetch` через `vi.mock('@/lib/api-client')`, mock `useAuth` через `vi.mock('@/lib/auth')`. Тест НЕ потребує реального QueryClientProvider — створити `wrapper` factory що передає свіжий `QueryClient({ defaultOptions: { queries: { retry: false } } })`.

**Severity:** LOW — runtime коректний на момент написання, але регресії беззвучні (URL param drift = silent filter ignore — точно як Bug 3d5136d).

**Де шукати ще:** усі майбутні React Query hooks (Sprint B4+ — mutation hooks); SWR hooks; Apollo `useQuery`. Профілактика: SKILL §1.6 тепер явно покриває React Query custom hooks (раніше згадувалось `useEffect`+`apiFetch` як trigger — query hooks могли проскакувати бо `useEffect` у самого `useQuery` не у hook-споживача).

---

### 2026-05-30 — Next.js App Router `error.tsx` props без `digest` — incomplete type breaks monitoring (Bug #206) — frontend, typescript, next-js-convention

**Сигнал:** новий `apps/web/src/app/error.tsx` (Next.js App Router error boundary) з сигнатурою `({ error, reset }: { error: Error; reset: () => void })`. Поточний bare `Error` НЕ дозволяє типобезпечно прочитати `error.digest` — server-attached identifier що Next.js додає до помилок з Server Components (для крос-кореляції з логами / Sentry / Datadog). У runtime поле присутнє, але TypeScript reject будь-який майбутній код типу `Sentry.captureException(error, { tags: { digest: error.digest } })` → tsc error → розробник або змушений робити `(error as any).digest` (порушує §1.2), або забуває моніторинг взагалі. Документація Next.js (`https://nextjs.org/docs/app/api-reference/file-conventions/error`) явно показує `error: Error & { digest?: string }` як канонічний type. tsc сам по собі не ловить — bare `Error` валідний; ловиться лише через перегляд проти Next.js docs АБО через первинний пробіг tester-агента на новій error-boundary.
**Причина виникнення:** copy-paste з generic React error-boundary прикладу де `Error` достатньо. Next.js convention специфічна — `digest` як проп є лише у App Router error.tsx, не у звичайних component-error-handler-ах. Розробник пише сигнатуру з пам'яті/loose-копії, не звертаючись до Next.js docs. Якщо проект не використовує Sentry/Datadog зараз — мотивації немає (`digest` зайвий); але майбутній моніторинговий sprint буде заблокований tsc-помилкою. Симетрично з іншими Next.js convention-файлами: `layout.tsx` приймає `params: { [key: string]: string | string[] }`, `page.tsx` — `searchParams: { [key: string]: ... }` — і кожен має точний type-signature у docs.
**Підхід до виявлення:** при будь-якому новому `app/**/error.tsx` (включно з route-level error boundaries — `app/work-orders/error.tsx` тощо) — перевірити що сигнатура `error: Error & { digest?: string }`, не bare `Error`. Grep: `grep -rn "export default function.*error.*Error" apps/web/src/app --include="error.tsx"` → кожен match має `& { digest`. Перевірка через Next.js docs: error.js page → "Props" section явно показує `Error & { digest?: string }`. Не довіряти `tsc` (bare `Error` валідний); не довіряти eslint (no-unused-locals на `digest` бо поле опціональне).
**Підхід до фіксу:** оновити сигнатуру: `({ error, reset }: { error: Error & { digest?: string }; reset: () => void })`. Додати regression-тест у парний `*.test.tsx`: `const error: Error & { digest?: string } = Object.assign(new Error('X'), { digest: 'abc' }); render(<GlobalError error={error} reset={...} />);` — якщо тип регресне на bare `Error`, тест перестане компілюватись.
**Severity:** LOW — у поточному коді жоден споживач не читає `digest`, runtime коректний. Стає HIGH коли додасться моніторинговий interceptor / Sentry SDK що очікує `error.digest` як tag.
**Де шукати ще:** будь-який майбутній route-level error boundary (`app/{calendar,crm,invoices,work-orders,...}/error.tsx`); будь-який Next.js convention-файл з documented type-signature (`app/**/{layout,page,template,not-found,error,loading}.tsx`). Профілактика: SKILL §1.3 тепер вимагає перевірки точної сигнатури проти Next.js docs для convention-файлів.

---

### 2026-05-30 — Next.js App Router convention-файли (`error.tsx`/`not-found.tsx`) без component-тесту → беззвучна регресія UI-контракту (Bug #208) — frontend, test-coverage

**Сигнал:** новий `apps/web/src/app/error.tsx` (Next.js App Router error boundary з interactive логікою: `reset()` callback, `console.error` effect у `useEffect`, fallback message при empty `error.message`, navigate button на `/dashboard`) АБО `not-found.tsx` (link на `/dashboard`, кириличні тексти) — без жодного `*.test.tsx`. SKILL §1.6 вимагає тестів для нових shared UI-компонентів у `components/ui/`, але App Router convention-файли формально не в "shared UI", тому правило часто пропускається. Регресії, які стають беззвучними:

- зміна fallback від `||` на `??` (різна поведінка для empty string)
- видалення `console.error` effect → втрата моніторингу без сигналу
- зміна link з `/dashboard` на `/` після рефакторингу нав
- зміна кириличного тексту на англійський або з друкарською помилкою
- регресія a11y (видалення `aria-hidden` з декоративної SVG, зміна heading level)
- регресія типу (Bug #206): bare `Error` замість `Error & { digest?: string }`

**Причина виникнення:** App Router convention-файли (`error.tsx`/`loading.tsx`/`not-found.tsx`/`template.tsx`) виглядають як "framework infrastructure" — розробник вважає їх "тестує сам Next.js" або "слугують лише як fallback". Реально вони мають bizness-логіку (текст українською, навігація на правильний route, моніторинговий effect, a11y-контракт). SKILL §1.6 формулювання "shared UI-компонент `components/ui/`" буквально не включає `app/**/(convention).tsx` → пропускається.
**Підхід до виявлення:** при будь-якому новому `apps/web/src/app/**/{error,not-found}.tsx` (root-level АБО route-level) — створити парний `apps/web/src/app/__tests__/<name>.test.tsx` (АБО локально-розміщений `*.test.tsx`). Мінімум 4-8 кейсів: heading render, основний CTA (reset/link) клік, fallback при empty input, a11y перевірки (aria-hidden на декоративній SVG), regression на type-signature (Bug #206). `loading.tsx` — pure skeleton, можна skip (нема інтерактиву); але якщо `loading.tsx` має суттєву анімацію/dark-mode логіку — теж тест.
**Підхід до фіксу:** створити `app/__tests__/error.test.tsx` за шаблоном `useSavedFilters.test.tsx` — `render(<GlobalError error={new Error('X')} reset={vi.fn()} />)` + `screen.getByRole('heading', { name: 'Виникла помилка' })` + `userEvent.click(getByRole('button', { name: 'Спробувати знову' }))` + `expect(reset).toHaveBeenCalledTimes(1)`. `console.error` mock через `vi.spyOn(console, 'error').mockImplementation(() => {})` у `beforeEach`. Для `not-found.tsx` — `screen.getByRole('link', { name: 'На головну' })` + `.getAttribute('href')` асерт.
**Severity:** LOW — production коректний на момент написання, але нуль захисту від регресії UX-контракту. Може стати HIGH коли App Router convention-файл починає використовуватись для критичної UX-сигналізації (наприклад, error.tsx що показує `Sentry.lastEventId()` для support-тікетів — регресія "втратить" id без warning).
**Де шукати ще:** будь-який майбутній route-level error/not-found (`app/work-orders/error.tsx`, `app/booking/not-found.tsx`); `template.tsx` (rare); `default.tsx` (parallel routes); кастомний `global-error.tsx`. Профілактика: SKILL §1.6 розширено — нові App Router convention-файли з ANY інтерактивом (`useEffect`, `onClick`, `'use client'`) → парний тест обов'язковий.

---

### 2026-05-30 — Global APP_GUARD без skip-list для healthcheck/SSE/webhooks → docker cascade restart (Bug #203) — backend, deploy

**Сигнал:** новий `{ provide: APP_GUARD, useClass: XGuard }` додаваний у `app.module.ts` (rate-limiter, IP-allowlist, custom global guard). У тому ж комміті review-агент додає `@SkipThrottle()`/`@Public()` на очевидні endpoint-и (SSE streams, login throttle override), АЛЕ пропускає неочевидні: `/health`, `/metrics`, webhook-endpoint-и, batch endpoints. Production-симптоми (від найшвидших до найповільніших): (а) `429 Too Many Requests` на `/health` від docker healthcheck → контейнер позначається `unhealthy` → `depends_on: condition: service_healthy` валиться → cascade restart по compose-стеку; (б) Prometheus scrape втрачає метрики (silent — графіки виглядають порожніми); (в) webhook від PRRO/payment провайдера не доходить → ПРРО не отримує підтвердження → користувацька проблема. tsc мовчить (декоратори опціональні). Існуючі unit/contract тести зазвичай НЕ запускають AppModule з APP_GUARD, тому моки guard-у пропускають проблему. E2E `smoke.spec` без healthcheck-spam теж пропускає.
**Причина виникнення:** APP_GUARD виглядає як невинне додавання у `providers: []` — без зміни жодного контролера. Розробник зосереджується на «нових бізнес-сценаріях» (login rate, upload rate), не аудитує існуючі «незмінні» endpoint-и які тепер теж під guard. Бар'єр входу високий: треба знати які endpoint-и часто опитуються зовнішніми системами (docker, nginx, monitoring) і які мають бути виключені. `@nestjs/throttler` документація показує лише `@Throttle()` (більш обмежувальний) і `@SkipThrottle()` (виключний), але не дає шаблон skip-листа.
**Підхід до виявлення:** при будь-якому новому global APP_GUARD у `app.module.ts` — одразу пройти **skip-list checklist**: (1) `/health` — `@SkipThrottle()` на класі; (2) `/metrics` — те саме; (3) `@Sse()` endpoint-и — `@SkipThrottle()` на методі (бо EventSource retry-ється при дисконекті); (4) webhook controllers (`@Controller('webhooks/X')`) — guard-залежно (`@SkipThrottle()` для зовнішнього source); (5) batch/cron-trigger endpoints. Grep: `grep -n "APP_GUARD" apps/api/src/app.module.ts` → для кожного знайденого guard перевірити `@SkipX()` декоратори у вищезгаданих контролерах. Виявляється лише через runtime healthcheck failures у проді або у CI smoke-test що робить >200 запитів за хвилину.
**Підхід до фіксу:** додати `@SkipThrottle()` (або відповідний `@Skip*Guard()`) на рівні класу контролерів зі skip-листа. Симетрично з `dashboard/stream` (SSE) у STO ERP. Якщо guard не має built-in skip-декоратора — створити кастомний (`@Public()`-патерн з `Reflector` + `SetMetadata`).
**Severity:** HIGH — production deploy blocker. У dev/CI працює (без cascade docker depends_on); виявляється лише у проді або e2e smoke-тесті що швидко spam-ить health.
**Де шукати ще:** будь-який майбутній global guard (IP allowlist, RBAC-by-tenant, кастомний rate-limiter, audit guard). Профілактика: SKILL §1.1 Deploy/infra тепер вимагає `APP_GUARD skip-list audit` при кожному новому global guard. Аналогічна логіка для `APP_INTERCEPTOR`/`APP_FILTER` що змінюють response shape (наприклад, інтерсептор що додає `cache-control: no-cache` ламає Cloudflare edge caching для `/static/*` endpoint-у).

---

### 2026-05-30 — Dead imports після page-split рефакторингу — tsc мовчить через noUnusedLocals: false (Bug #204-#205) — frontend, typescript, dead-code

**Сигнал:** великий `page.tsx`/`*Tab.tsx`/`*Modal.tsx` сплітнули на 3-5 sibling файлів. Утиліти (наприклад `parseHHMM`, `KYIV_TZ`) переїхали разом з логікою у новий файл, але ОРИГІНАЛЬНИЙ `page.tsx` лишається з `import { ..., parseHHMM, ... }` де `parseHHMM` вже не викликається. `tsc` мовчить через `noUnusedLocals: false` у `apps/web/tsconfig.json`. Vite/Next.js dev і prod збираються без warning. Code review пропускає бо diff показує ВЕЛИКИЙ split — глобально файл скорочений з 1500 до 200 рядків, мертвий імпорт у 5 рядках імпорт-списку невидимий за зменшенням обсягу. Регресія виявляється коли утиліту згодом реіменують у sibling-файлі: пере-export-ять як `parseTime`, а у `page.tsx` лишається `parseHHMM` → run-time error `parseHHMM is not a function` після того як хтось викличе цей мертвий код (наприклад, через autocomplete у IDE).
**Причина виникнення:** при split-рефакторингу спочатку **копіюють** імпорти у новий файл, потім видаляють використання з оригіналу — але імпорти оригіналу не чистять (нудно, риск чогось зламати). Сучасний інструмент рефакторингу (VSCode "Move to file") видаляє імпорти автоматично, але **ручний** split (особливо коли частину коду треба адаптувати під нові props) обходить інструмент → імпорти лишаються мертвими.
**Підхід до виявлення:** для кожного файлу з `git diff HEAD` що **зменшився** на >30% або був split (один файл → два сиблінги) — пройти імпорт-список і для кожного `import { X, Y, Z }` грепати `\bX\b` у решті файлу: якщо count <= 1 (тільки сам імпорт) → мертвий імпорт. Автоматизація: bash-цикл який витягує impоrted names через `grep -oE "^import \{[^}]+\}"` + `grep -oE "[A-Za-z_][A-Za-z0-9_]+"` і рахує occurrences. Альтернатива: увімкнути `noUnusedLocals: true` у tsconfig — але це масивна зміна що ламає інші файли.
**Підхід до фіксу:** видалити неживі імпорти. Один рядок diff на файл — мінімальний ризик. Зазвичай batch-cleanup після split-серії — окремий комміт «cleanup dead imports after split».
**Severity:** LOW — runtime не зламаний (просто мертвий код), tree-shaking тимчасово страждає (bundle на кілька байт більше — не критично з urgent точки зору). Може стати HIGH якщо утиліту реіменують у sibling без перевірки споживачів.
**Де шукати ще:** кожен великий split-рефакторинг у STO ERP (`page.tsx` → `Tab*.tsx`, `service.ts` → split modules). Профілактика: SKILL §1.2 тепер містить bash-loop для dead-import detection; після кожного split-комміту проганяти.

---

### 2026-05-30 — Defense-in-depth status guard у service-ревью без оновлення fixtures → release-blocker baseline (Bug #200) — backend, test-coverage, process

**Сигнал:** review-сесія додала рядки на кшталт `if (entity.status !== ALLOWED_A && entity.status !== ALLOWED_B) throw BadRequestException('...')` у початку методу сервісу (приклад: PO `applyPricing` → guard RECEIVED/PARTIAL). Парний `*.service.spec.ts` має fixtures де `prisma.X.findFirst.mockResolvedValueOnce({...})` НЕ містять поле `status` → undefined ≠ ALLOWED_A → guard кидає на ВСЕ існуючих тестах → файл фейлить N з N+1 тестів (зазвичай лише `NotFound` кейс виживає бо findFirst поверне null). При цьому review-commit залишається docs-only / code-only без spec-update → baseline стає хибно-червоний → наступна tester-сесія не може розрізнити нові регресії від шуму. Симетрично з Bug #200: рефактор замінив `pricingService.calculateSalePrice` на нові public `getActiveRulesForOrg + computePriceFromRules` — spec ще мокає старий метод, тест проходить **випадково** бо новий метод не викликається насправді.
**Причина виникнення:** автоматизована code-review-сесія фокусується на діффі ВЕЛИКОГО файлу (service.ts), вживає мінімальний defense-in-depth fix і коментує-документує його, але не запускає парний spec → не бачить що 5 тестів зламано. Process-причина: review-агент не виконує тест-прохід після свого ж фіксу. Якщо новий guard перевіряє додаткові поля (deletedAt, isActive, ownerId, currency) — той самий патерн поширюється.
**Підхід до виявлення:** при будь-якому review-commit що додає early-throw guard у service (грепати `+    if (.+\.status !== \|+    throw new BadRequestException\|+    throw new ForbiddenException` у git diff після review) → одразу пройти парний spec і додати потрібне поле у ВСІ fixtures `findFirst.mockResolvedValueOnce({...})`. На Кроці 0 — якщо `[x] виправлено` review-bug додав guard АБО рефактор public-API сервісу, перевірити чи парна spec оновлена; якщо ні — це Bug #0 baseline-blocker, виправити ПЕРШИМ перед новим аналізом.
**Підхід до фіксу:** додати поле у кожен мок (`status: PurchaseOrderStatus.RECEIVED`, `deletedAt: null` тощо). Якщо рефактор замінив old method на new — оновити mock-ім'я (`pricingService.calculateSalePrice` → `pricingService.computePriceFromRules`). Додати окремі **boundary** тести для нової логіки guard (`status: DRAFT → throws`, `status: PARTIAL → success` — обидва стани boolean-guard як з Bug #194 inverse-condition).
**Severity:** HIGH — release-blocker через хибно-червоний baseline; ховає реальні регресії та блокує наступні AUTO-сесії.
**Де шукати ще:** будь-який майбутній defense-in-depth guard додаваний у review-агентом (FSM transition guard, tenant guard, permission guard, status guard, soft-delete guard); будь-який рефактор що замінює private method на public + старий метод видаляється. Профілактика: process — review-агент має ЗАВЖДИ пробігти парний `*.spec.ts` після свого фіксу; tester-агент на Кроці 0 — звіряти `[x]`-маркери попередніх review-сесій проти реального стану spec-файлів (не лише service-файлів).

---

### 2026-05-30 — FormData upload через `apiFetch` (а не `apiMultipartFetch`) → upload завжди валиться 400/406 — frontend, api-contract

**Сигнал:** новий код у `apps/web/src/app/**/*.tsx` що формує `FormData` (`new FormData()`/`fd.append('file', f)`) і відправляє через `apiFetch(path, { method: 'POST', body: fd })` замість `apiMultipartFetch(path, fd)`. `tsc` НЕ ловить (типи `RequestInit.body` приймають `FormData`). Browser DevTools показує що запит йде з `Content-Type: application/json` замість очікуваного `multipart/form-data; boundary=...`. Сервер відповідає 400 «Файл не завантажено: очікується multipart/form-data» (після фіксу Bug #192) АБО 406 «the request is not multipart» (без цього фіксу). Користувач натискає upload → бачить помилку → нічого не зберігається. **Уся клієнтська upload-фіча мертва у проді.**
**Причина виникнення:** `apiFetch` (api-client.ts) ЖОРСТКО додає `'Content-Type': 'application/json'` до КОЖНОГО запиту через `headers: { 'Content-Type': 'application/json', ... }`. Розробник додає upload-фічу і copy-paste з найближчого fetch-handler-а (POST/PATCH/DELETE), не помічаючи що для FormData потрібен інший helper. Окремий `apiMultipartFetch` створено саме для цього (Bug #85), але його легко пропустити: дві функції в одному файлі з однаковими підписами `(path, ...)` — потрібен код-ревью. Інші upload-точки (`xlsx-import-button.tsx`, `settings/page.tsx`, `work-orders/[id]/PageClient.tsx`) використовують `apiMultipartFetch`. Регресія з'являється коли нова фіча додає upload не через переюзаний компонент.
**Підхід до виявлення:** після кожного diff що додає `new FormData()` АБО `formData.append('file'`, шукати чи відправка йде через `apiMultipartFetch`. Grep: `grep -rn "apiFetch\b.*body:\s*\(fd\|formData\|new FormData\)" apps/web/src --include="*.tsx"`. Альтернатива (через інспекцію diff): кожен `formData.append('file', ...)` має наступним викликом `apiMultipartFetch(...)`, НЕ `apiFetch(...)`.
**Підхід до фіксу:** заміна `apiFetch<T>(path, { method: 'POST', body: fd })` → `apiMultipartFetch<T>(path, fd)`. Додати `apiMultipartFetch` в імпорт. `apiMultipartFetch` сам встановлює `method: POST`, не передавати у init.
**Severity:** CRITICAL — фіча повністю мертва у проді (upload завжди 400/406); виявляється лише через user-bug-report АБО E2E. tsc мовчить.
**Де шукати ще:** будь-який майбутній файловий аплоад (avatars, attachments, photos на mobile screens, batch imports, CSV/XLSX upload). Профілактика: SKILL §1.3 тепер вимагає grep на «apiFetch + body: FormData» патерн; новий загальний шаблон upload — завжди `apiMultipartFetch`.

### 2026-05-30 — Nullable cost-input у calculateSalePrice → salePrice=0 затирання — backend, business-logic, data-corruption

**Сигнал:** новий сервіс/метод що (а) читає `purchasePrice` товару з БД (де поле `Decimal?` nullable), (б) передає це значення у `pricingService.calculateSalePrice(orgId, goodId, ..., costPrice)`, (в) пише результат у `Good.salePrice`. Розробник пише `const costPrice = Number(good.purchasePrice ?? 0)` — здається безпечним fallback. Реально: `calculateSalePrice` для PERCENT/COMPETITOR_PLUS/COST_TIER повертає `0 * (1 + p/100) = 0`. Сервіс пише 0 у `salePrice` (non-nullable у схемі) → товар отримує нульову ціну продажу без помилки/попередження. PriceHistory зафіксує `oldPrice=130, newPrice=0` — post-mortem можлива, але дані відновлюються вручну.
**Причина виникнення:** `??  0` як defensive fallback інтуїтивний (Number(null) = NaN, тому fallback). Розробник не думає про **семантичні наслідки** costPrice=0 для multiplicative rules. Кейс "немає purchasePrice" виглядає edge (зазвичай товари створюються з purchasePrice), але реально присутній: новий товар з фронту (тільки name + salePrice), імпорт з прайсу без cost, історичні товари з пустим полем. PERCENT/COMPETITOR_PLUS правила (найпоширеніші у STO ERP) повертають 0 → масове знищення цін при першому ж списковому імпорті.
**Підхід до виявлення:** для будь-якого нового виклику `pricingService.calculateSalePrice(...)` — переконатись що ПЕРЕД викликом є guard `if (X.purchasePrice == null || Number(X.purchasePrice) <= 0) { /* skip */ }`. Grep: `grep -rn "calculateSalePrice\|purchasePrice ?? 0" apps/api/src/modules/ --include="*.ts"`. Особлива увага: list-import endpoints де input — лише ідентифікатор товару (sku/barcode), а cost береться з БД (а не з ряду файлу).
**Підхід до фіксу:** `if (good.purchasePrice == null || Number(good.purchasePrice) <= 0) { notFound.push(\`${sku} (без собівартості)\`); continue; }`ПЕРЕД`calculateSalePrice`. Тест-кейси: (а) `purchasePrice=null → notFound + calculateSalePrice не викликаний + good.updateMany не викликаний`; (б) `purchasePrice=0 → notFound + калькуляція пропущена` (захист від ділення на нуль у майбутніх правилах).
**Severity:** HIGH — silent data corruption на фінансовому полі (`salePrice`); виявляється лише через скаргу користувача «у мене ціни стали 0»; повернення цін вручну з PriceHistory.
**Де шукати ще:** будь-який майбутній сервіс що пише `Good.salePrice`на основі обчислення з nullable input — bulk-recalc CRON (якщо буде), price-sync endpoints для зовнішніх прайсів (Magento/1С), markup-recalc після зміни currency exchange rate. Профілактика: SKILL §1.1 тепер вимагає prep-guard для будь-якого виклику`calculateSalePrice` коли costPrice читається з nullable джерела (Good.purchasePrice, Batch.cost, StockMovement.price).

### 2026-05-30 — Новий boolean prop на існуючому компоненті без inverse-condition тесту → інверсія guard беззвучна — frontend, test-coverage

**Сигнал:** diff додає опціональний boolean prop (`hideSaveButton?: boolean`, `disabled?: boolean`, `showFooter?: boolean`, `collapsible?: boolean`) до існуючого shared UI-компонента. Прод-код використовує prop через guard `{!hideX && <Element />}` або `{showX && <Element />}`. Існуючий `*.test.tsx` тестує ТІЛЬКИ default-режим (prop undefined / прохідний шлях), inverse-режим (prop=true / альтернативний шлях) — нуль покриття. Регресія типу `!hideX` → `!!hideX` (мінорний друкарська помилка під рефактор) проходить зеленою бо жоден тест не активує inverse-стан.
**Причина виникнення:** новий prop додається як «розширення» — розробник думає «я не зламав default-поведінку, існуючі тести зелені». Не усвідомлює що **бінарний guard має ДВА стани** і кожен потребує окремого тесту. Inverse-стан зазвичай не описаний в acceptance-criteria («приховує save-button коли treba») — лише в head-розробника. Якщо prop впроваджується щоб увімкнути новий UX-режим в N сторінках (як `hideSaveButton` для 8 page.tsx), регресія guard-інверсії зламає UX на всіх 8 page одночасно, але існуючі тести всі зелені.
**Підхід до виявлення:** для кожного diff у `apps/web/src/components/ui/*.tsx` що додає новий optional boolean prop у InterfaceProps — переконатись що парний `*.test.tsx` має МІНІМУМ 2 кейси для цього prop: (а) default/false-режим (інколи покрито існуючими тестами) + (б) true-режим (інверсна-перевірка). Бажано також кейс «true-режим залишає інші елементи компонента видимими» (захист від занадто-широкого guard з copy-paste). Grep: `grep -nE "^\s+\w+\?: boolean" apps/web/src/components/ui/*.tsx` після diff — кожен новий prop = +2-3 тести.
**Підхід до фіксу:** додати inverse-condition тести у тому ж describe-блоку. Шаблон: `it('XProp=true приховує/показує Y') + it('XProp=true приховує/показує Z') + it('XProp=true залишає W видимим')`. Не покладатись на page-level integration тести (їх часто немає, а навіть якщо є — мокають саме prop через page-options, не сам компонент).
**Severity:** MEDIUM — регресія мовчазна; UX на N сторінках одночасно поломаний; виявляється лише через user-bug-report.
**Де шукати ще:** будь-який майбутній компонент з опціональним boolean (Modal `hideClose`, EmptyState `compact`, Button `loading`, Select `searchable`, Table `striped`). Профілактика: SKILL §1.6 тепер вимагає inverse-condition тестів для нових boolean props.

### 2026-05-30 — fastify-multipart `req.file()` кидає FastifyError → leak 406 з англ. повідомленням замість 400 українською — backend, api-contract, i18n

**Сигнал:** новий controller endpoint з `@ApiConsumes('multipart/form-data')` що викликає `await req.file()` напряму (без try/catch). Helper зазвичай має заглушку `if (!data) throw new BadRequestException('Файл не завантажено')`, що **обробляє лише nullish-результат, НЕ thrown FastifyError**. Якщо клієнт (curl без `-F`, фронт що забув `FormData`, не той content-type) НЕ присилає multipart-payload — `fastify-multipart` кидає `FastifyError: the request is not multipart` що мапиться у HTTP **406 Not Acceptable** з англомовним messageом. Користувач (або фронт) бачить 406 замість 400 + не отримує українського пояснення.
**Причина виникнення:** документація `fastify-multipart` показує лише happy-path (`await req.file()` + `await data.toBuffer()`). Кейс "request НЕ multipart" не описаний — розробник інтуїтивно припускає що `req.file()` поверне `undefined`, тому ставить лише `if (!data) throw`. Насправді `req.file()` кидає, бо плагін різко відрізняє "файл не присутній у multipart" від "request взагалі не multipart". `tsc` мовчить (тип повертає `Promise<MultipartFile | undefined>` — кидок не у типах). Code review пропускає бо happy-path виглядає валідним. Виявляється лише contract-spec що шле запит БЕЗ multipart-body.
**Підхід до виявлення:** для кожного `*.controller.ts` з `@ApiConsumes('multipart/form-data')` ↔ переконатись що helper для отримання файлу (`getUploadedFile`, `extractFile`, тощо) обгорнутий у try/catch + мапить помилку у `BadRequestException` українською. Grep: `grep -rn "await req.file()" apps/api/src/modules/` — кожен виклик має бути всередині try/catch АБО у helper що це робить. Contract spec має кейс «POST без multipart → 400».
**Підхід до фіксу:** try/catch навколо `await req.file()` що мапить FastifyError у `BadRequestException(\`Файл не завантажено: <локалізована причина>\`)`. Особлива деталізація для `'not multipart'` випадку: «очікується multipart/form-data» (підказка фронт-розробнику). Фікс у helper покриває ВСІ endpoint-и одночасно — не потрібно правити кожен метод.
**Severity:** MEDIUM — функціональна i18n-помилка (406+EN замість 400+UA); ймовірне з міграції фронтенду на нову форму завантаження (хибний content-type) → користувач бачить "the request is not multipart" українським UI. Не втрата даних, але псує UX і моніторинг (406 на DataDog/Sentry виглядає як "клієнтський баг" замість "наш UX").
**Де шукати ще:** будь-який майбутній endpoint з multipart upload (інші файлові імпорти, аватари, attachments); будь-який FastifyError що мапиться у НЕ-400 (`FST_ERR_PAYLOAD_TOO_LARGE`→ 413,`FST_ERR_VALIDATION`→ 400 OK,`FST_ERR_INVALID_URL` → 400). Профілактика: helper для multipart завжди з try/catch; SKILL §1.5 contract-spec для нових import-endpoints вимагає кейсу «POST без multipart → 400 + укр. msg».

### 2026-05-30 — `prisma.X.update({ where: { id } })` без `orgId` у `data: { ...dto }`-вільному коді → defense-in-depth gap навіть коли потік org-trusted — backend, tenant-isolation

**Сигнал:** новий метод сервісу що пише у org-scoped таблицю (`good`, `counterparty`, `workOrder`...) через `prisma.X.update({ where: { id } })` де `id` отриманий через раніше org-scoped read (`findFirst({ orgId })` АБО з parent-relation що org-scoped). Потік **локально безпечний** (id вже org-trusted), але `where` не містить `orgId`. Якщо хтось у майбутньому скопіює патерн у controller з прямим `body.goodId` (без org-перевірки) — буде cross-tenant write **БЕЗ помилки** бо Prisma `update({ where: { id } })` працює для будь-якого id який існує. Симетрично з Bug #161 (FK у `data: { ...dto }`) — але тут не FK, а primary key самого об'єкта.
**Причина виникнення:** Prisma не дозволяє compound where на primary key (`update({ where: { id, orgId } })` — TS error: `id` має бути окремо). Тому розробник пише `update({ where: { id } })` бо так працює. Альтернатива (`updateMany({ where: { id, orgId } })`) повертає `{ count }` замість `T` — менш зручно. У результаті розробник вибирає простий `update` і покладається на «id уже org-trusted».
**Підхід до виявлення:** після кожного diff що додає `prisma.X.update({ where: { id`... у new feature service → запитати: «якщо рефакторити цей сервіс і витягти `update`-логіку в окремий метод що приймає `id` напряму від API без org-перевірки — що станеться?». Якщо **cross-tenant write пройде без error** — це defense-in-depth gap. Grep: `grep -rn "\.update({ where: { id:" apps/api/src/modules/` → кожен match перевірити чи `where` містить `orgId`.
**Підхід до фіксу:** замінити `update({ where: { id } })` на `updateMany({ where: { id, orgId, deletedAt: null } })`. Втрачаємо повернений `T`, але отримуємо `{ count }` — можна додати `if (count === 0) throw new NotFoundException(...)` як перевірку результату. Якщо сервіс потребує оновлений запис — додатковий `findFirst` після `updateMany` (1 додатковий запит). Для batch — `updateMany` зазвичай і так використовувався, не потрібно міняти.
**Severity:** LOW — поточний код безпечний; це **profilatic defense-in-depth**. Може стати CRITICAL якщо хтось скопіює патерн у контролер без org-check.
**Де шукати ще:** будь-який `update`/`upsert` на org-scoped таблиці (Good, Counterparty, WorkOrder, Invoice, StockItem, PriceHistory, Payment, тощо); особливо service-методи що пишуть у "довідник" (`Brand`, `Unit`, `Warehouse`) — там часто id з body напряму. Профілактика: SKILL §1.1 тепер вимагає `updateMany({ where: { id, orgId } })` для defense-in-depth, навіть коли локальний потік org-trusted.

### 2026-05-30 — Boundary-кейси відсутні для діапазонних правил (COST_TIER half-open) → регресія `<=`/`<` беззвучна — backend, test-coverage

**Сигнал:** новий backend-feature з range-based logic (`min <= x < max`, `<=`/`<` boundary) — pricing tiers (COST_TIER), age brackets, tax brackets, sliding-scale discount. Spec покриває «typical» кейси (`x` посередині діапазону), пропускає **граничні** значення (`x === min`, `x === max`, `x === 0`, `x < найменшого min`). Реалізація працює бо boundary рідко проходимий код; регресія типу `>=` → `>` АБО `<` → `<=` змінює semantics беззвучно — жоден існуючий тест не падає.
**Причина виникнення:** розробник пише spec за «прикладами з вимог» — клієнт каже «50 у тірі [0,100]», «200 у тірі [100,500]» — це є у specі. Boundary («що буде з cost=100 — у нижньому чи верхньому тірі?») формально не описано, тому й тест не пишеться. Це навіть НЕ defensive omission — це просто «не подумали». В оригінальних вимогах часто пишуть «від X до Y» без уточнення inclusive/exclusive, що залишає простір для регресії.
**Підхід до виявлення:** для кожного нового сервісу/функції що містить range comparison (`>= min && < max` або варіанти) — переконатись що spec має ВСІ 4 boundary тести: (1) `x === min` тіру (найнижча точка діапазону, нижня межа включена); (2) `x === max` тіру (точна верхня межа, має перейти у наступний тір якщо half-open); (3) `x === 0` (для non-negative величин — баг типу `cost > 0` замість `cost >= 0` мовчки виключить нуль); (4) `x` поза будь-яким діапазоном (`< найменшого min` АБО `> найбільшого max` коли немає null-tail) → fallback на raw value. Без цих 4 тестів — спека не покриває core semantics, лише happy path.
**Підхід до фіксу:** додати 4 окремих `it()` у відповідний `describe` блок. КОЖЕН boundary — окремий тест (не один з 4 expects), щоб при майбутньому падінні було видно ЯКА саме межа зламана. Назви тестів літерально містять `cost=0`, `cost точно на верхній межі`, `cost===costMin`, `tiers=[]` — це документація.
**Severity:** MEDIUM — production-код працює, але регресія потенційно псує дані в БД (неправильна ціна, неправильний податок) без жодного error/warning.
**Де шукати ще:** будь-який сервіс ціноутворення/скидок/податків з tier-based або bracket-based логікою; age-based pricing у insurance/booking; volume-based shipping; quantity-based discounts; будь-яке `if (x >= A && x < B)` у бізнес-логіці. Профілактика: SKILL §1.5 unit-test матриця тепер вимагає boundary-кейсів для діапазонних правил.

### 2026-05-30 — Cross-tenant FK у contract-spec не покритий для optional payload FK (новий FK у DTO без regression-захисту на HTTP-рівні) — backend, test-coverage, security

**Сигнал:** новий optional FK у `*.dto.ts` (`brandId?: string`, `vehicleId?: string`...) + новий патерн у контролері `if (dto.XId) { const x = await prisma.X.findFirst({id: dto.XId, orgId, deletedAt:null}); if (!x) throw new NotFoundException(...) }` (Bug #161 захисний патерн). Контролер коректний, але contract spec для цього controller-endpoint НЕ асертить (а) що `findFirst` справді викликаний з `orgId`, (б) що 404 для cross-tenant FK, (в) що `prisma.X.create/update` НЕ викликаний при failed FK-перевірці. Регресія (видалення `if (dto.XId)`-блоку під «спрощення», прибрання `orgId` з findFirst-where, заміна `NotFoundException` на early return) пройде усіх існуючих тестів зеленою → cross-tenant linkage у production без error/warning.
**Причина виникнення:** розробник пише FK-валідацію у контролері і думає «це service-логіка, contract spec тестує HTTP-shape». Contract spec мокає Prisma (`prismaMock`) — додавання тесту вимагає налаштувати `prismaMock.brand.findFirst.mockResolvedValueOnce(null)` для cross-tenant сценарію + `expect(prismaMock.X.create).not.toHaveBeenCalled()` — це додаткова робота. Service-spec теж не покриває бо валідація живе у КОНТРОЛЕРІ (через `prisma` injected у controller), не у service. Між service-spec і contract-spec випадає вікно — controller validate logic без покриття.
**Підхід до виявлення:** на Кроці 1 §1.5 — для кожного `*.controller.ts` що містить `if (dto.XId) { const x = await this.prisma.X.findFirst(...); throw new NotFoundException(...) }` патерн → перевірити чи `*.contract.spec.ts` має 3 тести для КОЖНОГО таким захищеного FK: own-org→success, other-org→404, PATCH-other-org→404. Grep: `grep -n "if (dto\.[a-zA-Z]*Id)" apps/api/src/modules/**/*.controller.ts`; для кожного match шукати у відповідному `*.contract.spec.ts` тест зі `mockResolvedValueOnce(null)` на цьому моделі і `expect(prismaMock.X.create).not.toHaveBeenCalled()`. Якщо немає — gap.
**Підхід до фіксу:** додати 3 контракт-тести з мок-схемою:

```typescript
prismaMock.brand.findFirst.mockResolvedValueOnce(null); // інша org
const res = await app.inject({
  method: 'POST',
  url: '/...',
  payload: { brandId: 'cross-tenant-uuid' },
});
expect(res.statusCode).toBe(404);
expect(res.json().message).toMatch(/Бренд не знайдено/);
expect(prismaMock.pricingRule.create).not.toHaveBeenCalled();
```

Кожен FK = +3 тести (POST own, POST other, PATCH other). Документує contract і ловить регресію.
**Severity:** MEDIUM — production коректний на момент написання, але нуль захисту від регресії. Якщо регресія станеться у tenant-isolation — це HIGH (cross-tenant data linkage). MEDIUM = profileactic.
**Де шукати ще:** будь-який модуль з optional FK у DTO + `findFirst(orgId)` у controller (не service): pricing-rules brandId/goodId (POST+PATCH), invoices counterpartyId/vehicleId, work-orders branchId, purchase-orders supplierId, будь-який майбутній модуль що додає preferredSupplierId/warehouseId. Профілактика: SKILL §1.5 тепер вимагає cross-tenant FK тестів у contract-spec.

### 2026-05-30 — Custom hook з useEffect/apiFetch/localStorage без unit-тесту → беззвучна регресія persistence/race-protection — frontend, test-coverage

**Сигнал:** новий `apps/web/src/hooks/use*.ts` що: (а) має `useEffect` що викликає `apiFetch`/`fetch`/`localStorage`; (б) повертає imperative API (`toggle`, `reset`, `save`); (в) використовує `AbortController`/`cancelled`-flag/`mountedRef` для race-protection. Без `*.test.tsx` — нуль захисту від регресії: AbortController можна видалити «під спрощення», cancelled-flag можна забути після рефактору effect, mountedRef можна викинути коли «здається не потрібним». Усі ці регресії — runtime races що НЕ ловить tsc, code review (locally виглядає валідно), і ловить лише user-bug-report.
**Причина виникнення:** розробник пише hook як «звичайну логіку» і думає що component-тест pages що використовують hook покриє його. Але component-тест для page що використовує hook — мокає сам hook (інакше потрібно мокати весь fetch ланцюг). Тому hook сам залишається непокритий. Хук «надто маленький» для окремого тесту згідно з інтуїцією, але `useEffect` + `apiFetch` + `localStorage` + `AbortController` = 4 окремих race-гілки які треба перевірити.
**Підхід до виявлення:** при будь-якому новому `apps/web/src/hooks/use*.ts` — переконатись що існує парний `use*.test.tsx`. Шаблон: `useSavedFilters.test.tsx` (`renderHook` + `act`, `localStorage.clear()` у `beforeEach`, mock `apiFetch` через `vi.mock('@/lib/api-client', ...)`). Мінімум тестів: (1) початковий стан; (2) optimistic read з localStorage до резолву API; (3) resolve API → state оновлюється; (4) reject API → fallback зостається; (5) imperative API (toggle/save/reset) працює; (6) race-protection (rapid call → попередній abort-нутий АБО signal.aborted=true); (7) різні pageKey/instance ізольовані.
**Підхід до фіксу:** створити `use<Name>.test.tsx` за шаблоном. Mock `apiFetch` через `vi.mock('@/lib/api-client', () => ({ apiFetch: vi.fn() }))`. Для AbortController-тесту: захопити signals через `apiFetchMock.mockImplementation((url, init) => { signals.push(init.signal); return new Promise(() => {}); })` — це показує що `signal.aborted` справді змінюється при rapid sequential calls.
**Severity:** MEDIUM — production-код може бути коректним, але hook керує persistence/network — регресія беззвучна і виявиться лише через втрачені дані або memory-leak warning у консолі.
**Де шукати ще:** будь-який майбутній hook з мережею (useGoodsAutocomplete, useNotifications, usePolling) АБО з persistence (useColumnConfig, useTablePagination, useFilters). Профілактика: SKILL §1.6 тепер вимагає `*.test.tsx` для нових hooks з `useEffect`/`apiFetch`/`localStorage`.

### 2026-05-30 — JSON/Record DTO поле без @IsObject() → знімається whitelist:true → undefined в сервісі — backend

**Сигнал:** `UpsertXDto.value: Record<string, unknown>` (або будь-яке JSON/object поле) без жодного class-validator декоратора. `ValidationPipe({ whitelist: true })` видаляє з body будь-яку властивість що НЕ має принаймні одного decorator — навіть якщо поле TypeScript-типізоване. Сервіс отримує `dto.value === undefined` → Prisma `upsert`/`create` з `value: undefined` → TypeError або запис `null` замість реального конфігу.
**Причина виникнення:** розробник типізує поле через TypeScript (`value!: Record<string, unknown>`) вважаючи що тип = гарантія. `tsc` не скаржиться. Тест з MockService не доходить до ValidationPipe. Баг виявляється лише через `PUT /user-preferences/:key` у runtime — сервер приймає 204 але записує `null`/`undefined`. Особливо часто на JSON/blob полях де немає природного `@IsString()` / `@IsNumber()` / `@IsBoolean()` — розробник не думає "треба @IsObject()".
**Підхід до виявлення:** для кожного нового `*.dto.ts` — переконатись що КОЖНЕ поле класу (не тільки string/number) має принаймні один `class-validator` декоратор. Спеціально шукати поля типу `Record<string, unknown>`, `object`, `Json`, `T extends object` — вони найчастіше залишаються без декоратора. Grep: `grep -A1 "value!:\|value?:" apps/api/src/modules --include="*.dto.ts" | grep -v "@Is\|@Max\|@Min\|@Array\|@Validate\|class-validator"`. Також: contract spec з `PUT /... payload: { key: 'x' }` (без `value`) повинен повертати 400 — це ловить відсутній `@IsObject()`.
**Підхід до фіксу:** `@IsObject({ message: 'Значення має бути об\'єктом' })` перед `value`. Якщо поле опціональне — додати `@IsOptional()` перед `@IsObject()`. Для вкладених об'єктів із відомою структурою — `@ValidateNested()` + `@Type(() => XClass)`. Для довільного JSON без схеми — `@IsObject()` достатньо (гарантує що це об'єкт, не примітив/масив).
**Severity:** HIGH — функціональний баг: PUT приймається (204) але нічого не зберігається; без `@IsObject()` whitelist знімає поле мовчки → данні псуються без будь-якого сигналу.
**Де шукати ще:** будь-який DTO з JSON-полем (rateScheme, uiFeatures, metadata, config, settings, payload, extra); webhooks DTO з payload; будь-який новий DTO де field-тип не є примітивом string/number/boolean/Date. Особливо: `settings.dto.ts` вже має `@IsObject()` на `uiFeatures` — використати як зразок.

### 2026-05-30 — apiFetch generic type mismatch: очікує масив, endpoint повертає {items,total} — frontend

**Сигнал:** `apiFetch<X[]>('/endpoint').then(setX)` де `setX` — `Dispatch<SetStateAction<X[]>>`. При монтуванні `X[]` фактично отримує об'єкт `{ items: X[], total: number }` → `x.map is not a function` TypeError → Select порожній або fetch-помилка ковтається. `tsc` мовчить бо generic параметр `T` у `apiFetch<T>` — лише assertion, не runtime validation. Баг виявляється лише у runtime.
**Причина виникнення:** STO ERP має дві конвенції для довідникових endpoints: (1) `{ items, total }` — стандарт (brands, goods, pricing-rules, тощо); (2) bare array — виняток для деяких `/branches` (спеціальний endpoint). Розробник, знаючи про `/branches → bare`, помилково поширює цей патерн на `/brands`, або навпаки — знаючи про `{items}` стандарт, не перевіряє конкретний контролер. `tsc` не ловить (`apiFetch<T>` довіряє generic T без runtime-перевірки).
**Підхід до виявлення:** для кожного нового `apiFetch<X[]>('/endpoint')` (де X — не пагінований тип) — прочитати `*.controller.ts` endpoint-а і перевірити що саме повертає сервіс (bare array або object). Grep `apiFetch<[A-Za-z]*\[\]>` у всіх page.tsx і звірити кожне. Known виняток: `/branches` → bare array (fbe66ad); всі решта list-endpoints → `{ items, total }`.
**Підхід до фіксу:** `apiFetch<{ items: X[]; total: number }>('/endpoint').then(r => setX(r.items))`. Якщо endpoint реально повертає bare array — типизувати правильно і не чіпати; якщо потрібен `total` для пагінації — додати у state.
**Severity:** MEDIUM — brands Select порожній без feedback; якщо fetch у `Promise.all` — падіння ковтає також сусідній goods-fetch.
**Де шукати ще:** будь-яка нова довідникова сутність що додається до форми (units, warehouses, employees, payment-methods); будь-яка сторінка де `apiFetch<T[]>` на endpoint що не `/branches`.

### 2026-05-30 — Bulk-apply scope-inconsistency після додавання нового scope-поля — backend, business-logic

**Сигнал:** метод `applyRuleToGoods` / `applyRuleToAll` / `bulkRecalc` будує `where`-умову для `findMany` що відображає scope правила (`goodId`/`goodCategory`/`goodType`), але не включає нове щойно-додане scope-поле (`brandId`). Результат: правило brand-scoped застосовується до ВСІХ товарів org замість лише тих що мають цей бренд.
**Причина виникнення:** нове scope-поле додають до моделі та до `calculateSalePrice` (яка правильно фільтрує через OR+find), але `applyRuleToGoods` має свою `where`-умову окремо — її не оновлюють синхронно. Розробник думає «логіку ціноутворення виправив», але bulk-apply ще досі широкий. Ніякого TS-error нема (Prisma where-об'єкт валідний без нового поля). Тест `applyRuleToGoods` мокає `findMany` і не перевіряє форму `where`.
**Підхід до виявлення:** після будь-якого commit що додає нове scope-поле у `PricingRule` (або аналогічну ruling-модель) — знайти в тому ж сервісі всі методи що будують `where`-умову для `findMany` по сутності якою правило управляє. Звірити `where`-поля зі scope-полями правила. Будь-яке scope-поле відсутнє у `where` = bug.
**Підхід до фіксу:** `...(rule.newScopeField && !rule.higherPriorityField ? { newScopeField: rule.newScopeField } : {})` — аналогічно існуючим scope-полям. Додати service-spec що мокає `findMany` і асертить форму `where.brandId` для brand-scoped правила.
**Severity:** HIGH — перерахунок ціни для невідповідних товарів → неправильна salePrice у БД; дані псуються без будь-якого error.
**Де шукати ще:** будь-який bulk-apply метод у pricing, promotion, discount, tax-rate сервісах що мають multi-field scope; будь-який `applyToAll` / `recalculateAll` що самостійно будує `where` замість делегування у `calculateX`.

### 2026-05-30 — Нова browser-API залежність у shared-компоненті без jsdom-стабу → каскадне падіння всіх тестів які монтують компонент — frontend, test-coverage

**Сигнал:** після введення `new ResizeObserver(...)` / `new IntersectionObserver(...)` / `new MutationObserver(...)` / `matchMedia(...)` у `useEffect` shared-компонента (Modal, Drawer, Tooltip, Combobox, будь-що з `components/ui/`) — раптово N component-тестів які раніше були зеленими падають з `ReferenceError: X is not defined`. Падіння — НЕ у тесті самого компонента, а у тестах ДОВКОЛА (`getByText` → "not found", бо React error-boundary unmount-ить дерево після useEffect-exception). Виявляється ТІЛЬКИ при повному прогоні web-suite на Кроці 0, бо TypeScript мовчить (типи `ResizeObserver`/`IntersectionObserver` живуть у `lib.dom.d.ts` — завжди present), а dev/prod сервер коректний (браузер має API нативно).
**Причина виникнення:** розробник додає browser-API у компонент щоб реалізувати "розумну" поведінку (анімація висоти за scrollHeight, lazy-load при появі в viewport, реакція на theme-change). Локально все працює бо браузер має API. jsdom (environment Vitest для web) — мінімальна реалізація DOM що НЕ містить більшості Observer API. Setup-файл історично стабав лише те що падало раніше (`scrollIntoView`); новий API не покритий — повторюється історія "jsdom doesn't implement X" з кожним новим Observer. Code review пропускає бо локально файл валідний; `tsc` пропускає бо типи в `lib.dom`. Падіння виявляється аж на повному `vitest run`.
**Підхід до виявлення:** при будь-якому diff у `components/ui/` шукати `new (ResizeObserver|IntersectionObserver|MutationObserver|PerformanceObserver|BroadcastChannel)\(`, `window\.matchMedia\(`, `navigator\.(clipboard|share|wakeLock|geolocation|mediaDevices)`, `crypto\.subtle`, `IndexedDB`, `Notification\(`. Для кожного співпадіння — перевірити чи `apps/web/src/__tests__/setup.ts` стабає це API. Якщо ні → preempt-fix (додати стаб ДО того як тест впаде у baseline). Альтернативно: ЗАВЖДИ ганяти web-suite на Кроці 0 (вже у SKILL з 2026-05-29) — це ловить пропуск.
**Підхід до фіксу:** додати noop-клас-стаб у setup.ts під guard-ом `typeof globalThis.X === 'undefined'` (захист щоб у jsdom-версіях що отримають реальну реалізацію не перетирати). Не стабати у самому компоненті (захаращує prod-код); не вимикати тест (приховує реальні регресії). Для observable API (ResizeObserver, IntersectionObserver) — noop observe/unobserve/disconnect достатньо: тест перевіряє render-логіку, не саму анімацію.
**Severity:** HIGH — release-blocker через червоний baseline; ховає реальні регресії за шумом і блокує наступні AUTO-сесії (баг "хибно-червоний" симетричний до "хибно-зеленого" з 2026-05-29).
**Де шукати ще:** будь-який майбутній компонент з нативним browser-API; модальні/drawer/tooltip-системи (часто додають Observer-based layout); календарі/timeline (як calendar/page.tsx); virtual-list/auto-scroll; реактивні до viewport компоненти (responsive nav, sticky header). Профілактика: тримати у setup.ts ВСІ стандартні Observer-стаби незалежно від того чи використовуються — preempt-cost ~30 рядків, ловить весь клас багів.

### 2026-05-29 — Component-vs-test drift + web-suite поза baseline → червоний тест невидимий до Кроку 4 — frontend, test-coverage, process

**Сигнал:** на повному прогоні web-suite (Крок 4) падає component-тест на `getByText('...')`/`getByRole(...)` — елемент не знайдено. Тест НЕ зачеплений scope-коммітами поточної сесії (інший компонент). Часто: тест асертить empty-state hint / label / placeholder, якого компонент при певному стані (`saved=[]`, `items.length===0`) НЕ рендерить. Прихований під час Кроку 0 якщо baseline ганяв лише `pnpm --filter @sto/api test` і пропустив `@sto/web vitest run`.
**Причина виникнення:** дві накладені причини. (1) Крок 0 у старій версії SKILL запускав тільки API-suite → web-регресії невидимі до фінальної верифікації. (2) Компонент і його тест розійшлися: розробник прибрав/змінив UI-елемент (hint, бейдж, текст) у компоненті, але тест лишився асертити старий стан — АБО тест написали наперед під намір, який у компоненті так і не реалізували. `tsc` мовчить (типи цілі). Code review пропускає (кожен файл локально валідний). Виявляється лише запуском саме цього тесту.
**Підхід до виявлення:** ЗАВЖДИ ганяти ОБИДВА suite у Кроці 0 (API + web), навіть для docs-only/backend-only scope — червоний web-baseline блокує сесію так само як API. При падінні component-тесту — прочитати І тест, І компонент: чи компонент справді рендерить очікуваний елемент у тому стані що тестується? Якщо ні — це drift, не flaky.
**Підхід до фіксу:** вирішити чий намір правильний. Якщо тест документує легітимний UX (показати «Немає X» коли список порожній) → виправити КОМПОНЕНТ (повернути елемент під правильною умовою — звернути увагу на додаткові гейти у назві тесту, напр. «...і не відкритий save dialog» → умова `empty && !saveOpen`). Якщо UX свідомо прибрали → оновити тест. Не глушити тест і не лишати червоним.
**Severity:** MEDIUM — не runtime-bug на момент, але червоний baseline ховає реальні регресії за шумом і блокує наступні сесії (як docs-only хибно-зелений, лише навпаки — хибно-червоний).
**Де шукати ще:** будь-який `components/ui/*.test.tsx` після рефактору компонента (видалення/перейменування елементів, зміна умов рендеру); empty-state/loading hint-и; будь-який тест з `getByText`-літералом який легко розсинхронити з компонентом. Профілактика: Крок 0 завжди ганяє web-suite.

### 2026-05-29 — `[x] виправлено` без парного code-diff (docs-only commit) → хибно-зелений приховує release-blocker — process, test-coverage

**Сигнал:** BUG_REPORT.md має нещодавні баги з `**Статус:** [x] виправлено`, але `git log --stat` останнього `fix(tester)`/tester-commit показує що змінено ЛИШЕ `MemoryManual.md`/`BUG_REPORT.md` (docs-only) — жодного файлу з коду/конфігу. Перевірка реального файлу за вказаним `Файл: ...:рядок` показує що дефект ЖИВИЙ (healthcheck все ще `/health`, `.dockerignore` все ще відсутній тощо). Часто з'являється коли попередня сесія коректно ПРОаналізувала баги, написала фікс-опис, але через переривання/rate-limit/помилку не застосувала Edit/Write і одразу перейшла до фінального docs-commit, поставивши `[x]` «за планом».
**Причина виникнення:** агент-тестувальник ставить `[x]` на основі НАМІРУ виправити (фікс описаний у звіті), а не на основі застосованого diff. Якщо між «записати звіт» і «застосувати фікс» стається переривання, або кроки переплутані місцями, статус і робоче дерево розходяться. Наступні сесії читають `[x]` + MemoryManual «5 bugs fixed» і вважають стек готовим — особливо небезпечно для CRITICAL deploy-блокерів, які ніхто більше не перевіряє бо «вже вирішено».
**Підхід до виявлення:** на Кроці 0, ПЕРЕД новим аналізом — пройти останні N `[x]`-багів BUG_REPORT і для кожного звірити реальний файл проти опису. Не довіряти статусу. Швидкий тест: чи останній tester-commit змінив код, чи лише `*.md`? Docs-only tester-commit з купою `[x]` поряд = червоний прапор. `[x]` = «diff застосовано І верифіковано (tsc/test/`docker compose config`)», не «фікс описано».
**Підхід до фіксу:** реально застосувати кожен втрачений фікс (аналіз попередньої сесії зазвичай коректний — переюзати його); додати окремий meta-bug HIGH про хибний маркер щоб слід лишився; правило самій собі — ставити `[x]` ТІЛЬКИ після Edit/Write + проходження верифікації, ніколи «наперед».
**Severity:** HIGH (а якщо приховані баги CRITICAL — фактично CRITICAL): хибно-зелений гірший за відкритий баг бо знімає увагу з блокера.
**Де шукати ще:** будь-яка сесія що завершилась docs-only commit-ом при наявності щойно-доданих `[x]`; будь-який HEAD що вказаний у завданні РАНІШЕ за останній «fix»-commit (ознака що «фікс» був лише записом); infra/deploy багами особливо (їх не перевіряють unit-тести → легко лишити невиправленими непомітно).

### 2026-05-29 — Container healthcheck шлях/бінарник не узгоджений з образом і globalPrefix → стек не стартує — backend, deploy

**Сигнал:** `docker-compose.yml` healthcheck `test: ["CMD", "curl", "-f", "http://localhost:PORT/health"]` для сервісу чий образ — `node:20-alpine` (немає curl) АБО чий застосунок робить `setGlobalPrefix('api')` (реальний шлях `/api/health`, не `/health`). Інші сервіси мають `depends_on: <api>: { condition: service_healthy }` → якщо healthcheck назавжди FAIL, залежні сервіси НІКОЛИ не стартують → уся production-топологія мертва.
**Причина виникнення:** healthcheck пишуть «за звичкою» (`curl -f /health`) без перевірки (а) чи бінарник curl є у базовому образі (alpine-варіанти його НЕ містять), (б) чи шлях збігається з реальним роутом після `setGlobalPrefix`/router-mount. Healthcheck не покривається unit-тестами і не запускається локально без `docker compose up` → дефект невидимий до спроби деплою.
**Підхід до виявлення:** для кожного healthcheck у compose — звірити (1) бінарник проти базового образу сервісу (alpine → НЕ curl/wget-gnu; node-образ → є `node`); (2) шлях проти `setGlobalPrefix`/router prefix застосунку (grep `setGlobalPrefix`, `app.use('/api'`, mount-prefix). Перевірити blast-radius: хто `depends_on ... service_healthy`?
**Підхід до фіксу:** для node-образів — list-form healthcheck через вбудований `http`: `["CMD","node","-e","require('http').get('http://localhost:PORT/REAL_PATH',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]` (без зовнішніх бінарників, offline-safe). Завжди узгодити шлях з globalPrefix. Додати `timeout`+`retries`.
**Severity:** CRITICAL — release-blocker; уся система не піднімається у production.
**Де шукати ще:** будь-який compose healthcheck на alpine-образі; `Dockerfile` `HEALTHCHECK` директива; `Update.ps1`/installer health-probe; будь-який сервіс за reverse-proxy з префіксом.

### 2026-05-29 — curl/wget healthcheck на НЕ-alpine образі без цих бінарників (minio/minio) → сервіс ніколи не healthy → каскад мертвий — backend, deploy

**Сигнал:** compose healthcheck `["CMD","curl","-f","http://localhost:9000/minio/health/live"]` (або `wget`) на сервісі чий образ — `minio/minio`. Емпірично: `minio/minio:RELEASE.2024-*` має ЛИШЕ `/usr/bin/mc`, НЕ curl, НЕ wget. curl → command-not-found → healthcheck назавжди FAIL → minio `unhealthy` → `api` (depends_on minio: service_healthy) НІКОЛИ не стартує → web→caddy каскад мертвий. Той самий blast-radius, що node-alpine+curl, але пропускається бо minio — НЕ alpine, тому «alpine→немає curl»-евристика на нього не спрацьовує.
**Причина виникнення:** popular minio docker-compose приклади з мережі досі показують `curl -f /minio/health/live` — копіюється «як є». Раніше старі minio-образи містили curl; сучасні distroless-варіанти його викинули, але healthcheck лишився. Попередня deploy-аудит-сесія перевірила node/alpine образи (Bug #164/#165), але minio пропустила бо не alpine. tsc/unit/`docker compose config` НЕ ловлять (config валідний, бінарник перевіряється лише при реальному `up`).
**Підхід до виявлення:** для КОЖНОГО compose healthcheck що використовує curl/wget — НЕ покладатись на «alpine vs не-alpine», а емпірично перевірити образ: `docker run --rm --entrypoint sh <image> -c "command -v curl; command -v wget; command -v mc"`. minio/minio, distroless, scratch-based, деякі mongo/redis-варіанти можуть не мати http-клієнта. Перевірити blast-radius: хто `depends_on … service_healthy`?
**Підхід до фіксу:** для minio — офіційний `["CMD","mc","ready","local"]` (mc бандлиться у server-образі, `local`-alias вбудований у самому контейнері minio — alias-setup НЕ потрібен; перевірено: exit 0 «The cluster is ready»). Запінити образ конкретним RELEASE-тегом для offline-відтворюваності (latest може знову змінити набір бінарників). Для інших образів без http-клієнта — TCP-probe або вбудований інструмент образу.
**Severity:** CRITICAL — release-blocker; уся production-топологія не піднімається.
**Де шукати ще:** будь-який compose healthcheck з curl/wget на НЕ-node образі (minio, mongo, elasticsearch, distroless); `docker-compose.dev.yml` (часто копія prod healthcheck — фіксити ОБИДВА); installer health-probe; будь-який майбутній сервіс який додають з copy-paste healthcheck.

### 2026-05-29 — Query-shape фікс (relation-ім'я / nested where) без service-spec → невидима регресія — backend, test-coverage

**Сигнал:** fix-commit (часто з повідомленням «fix PrismaClientValidationError on search») змінює **relation-ім'я** у вкладеному `where` (`customerGarage`→`customerGarages`, singular→plural), форму `some`/`every`/`OR`, або `include`/`select` shape. Прод-код тепер коректний, але парного **service-spec немає** — є лише `*.contract.spec.ts`, який реєструє `{ provide: XService, useValue: serviceMock }`. Mock повністю заміняє сервіс → реальний `where` ніколи не доходить до Prisma → регресія назад до неправильного relation-імені пройде всі тести зеленими і впаде тільки на runtime з 500/`PrismaClientValidationError`.
**Причина виникнення:** `PrismaClientValidationError` — це валідація форми запиту на рівні Prisma-клієнта (не TypeScript: `mode`, nested relation names, `some/every` приймаються типами як loose object). Розробник фіксить relation-ім'я, бачить що сторінка працює, і не додає тест бо «contract spec вже є». Але contract spec для list-endpoint майже завжди мокає сервіс (щоб не піднімати реальну БД) → він тестує HTTP-shape (`{items,total}`, 401, 400), а НЕ query-shape. Жоден рівень не виконує справжній `where`.
**Підхід до виявлення:** для кожного fix що чіпав `where`/`include`/`select`/relation-ім'я/`mode` — перевірити чи існує `*.service.spec.ts` (не лише `*.contract.spec.ts`). Якщо contract spec мокає сервіс (`useValue: serviceMock` / `PrismaService, useValue: {}`) і service-spec відсутній → query-shape gap. Не зараховувати contract spec як покриття query-логіки.
**Підхід до фіксу:** service-spec з реальним сервісом + Prisma-мок-шпигуном: `{ provide: PrismaService, useValue: { model: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) }, $transaction: (ops) => Promise.all(ops) } }`. Викликати `service.findAll(orgId, { q })` і асертити `findMany.mock.calls[0][0].where` — правильні relation-імена присутні, старі/singular відсутні (`expect(branch).not.toHaveProperty('customerGarage')`), nested `deletedAt: null`, tenant `orgId`. Якщо `findAll` обгорнутий у `$transaction([...])` — мок `$transaction` має виконати масив через `Promise.all`.
**Severity:** MEDIUM — прод-код коректний на момент фіксу, але нуль захисту від регресії; relation-ім'я легко зламати назад при наступному рефакторі → 500 для користувача без жодного сигналу в CI.
**Де шукати ще:** будь-який list-сервіс з пошуком `?q=` через nested relation (`work-orders` counterparty-search, `goods` через preferredSupplier, vehicles через garage); будь-який `where.OR` з `some`/`every`; модулі що мають лише `*.contract.spec.ts` без `*.service.spec.ts` (counterparties було таким до Bug #163).

### 2026-05-28 — Optional FK у spread без org-scoped перевірки → cross-tenant leak — backend, tenant-isolation

**Сигнал:** сервіс пише `data: { ...dto, orgId }` (або `data: dto` в update) де DTO має optional FK-поля (`brandId?`, `unitId?`, `preferredSupplierId?`, `vehicleId?`...), і сервіс НЕ робить `findFirst({ id: dto.XId, orgId })` перед write. Часто з'являється коли FK-поле щойно додали до DTO (раніше whitelist його зрізав, P2003 не виникав, тому ніхто не думав про валідацію). База даних має лише звичайний FK constraint без `orgId` у ньому.
**Причина виникнення:** розробник (і навіть review) вважає, що сирий DB foreign key constraint + маппінг P2003→400 у HttpExceptionFilter — достатній захист. Це хибно у multi-tenant: DB FK перевіряє лише що `id` існує ГЛОБАЛЬНО, не що він належить поточній org. Тому `brandId` з org-B спокійно пишеться у товар org-A — cross-tenant linkage без жодної помилки. P2003 спрацьовує ЛИШЕ для повністю неіснуючого ID, не для валідного-у-чужій-org. Review може свідомо написати «P2003 прийнятний» — і це справедливо для «not found», але мовчки пропускає cross-tenant вимір.
**Підхід до виявлення:** для кожного `*.dto.ts` знайти optional/required `*Id` поля що є FK на org-scoped таблицю. Для кожного — у відповідному сервісі перевірити чи `create`/`update` робить org-scoped `findFirst` перед записом. НЕ зараховувати P2003-маппінг як захист: явно поставити питання «чи FK з ІНШОЇ org пройде?». Якщо так — HIGH (tenant isolation), не MEDIUM.
**Підхід до фіксу:** приватний `validateFkReferences(orgId, dto)` — `Promise.all` з `findFirst({ id: dto.XId, orgId, deletedAt: null, select: { id: true } })` для кожного наданого FK; кинути `BadRequestException` українською з конкретною назвою сутності («Бренд не знайдено»). Викликати ПЕРЕД `create` і `update` (усталений патерн Bug #90 з invoices/work-orders). Перевіряти лише надані поля (`dto.XId ? findFirst : Promise.resolve(null)`).
**Severity:** HIGH — cross-tenant data linkage порушує CLAUDE.md правило #6 (tenant isolation); дані не псуються одразу, але один tenant бачить/посилається на довідники іншого.
**Де шукати ще:** будь-який сервіс з optional FK у DTO який пишеться через spread — work-orders (vehicleId/counterpartyId/branchId на create, не лише clone), purchase-orders, invoices, stock-documents, pricing-rules (goodId), будь-який новий модуль з `preferredSupplierId`/`brandId`/`warehouseId` у DTO. Особлива увага — коли FK-поле ЩОЙНО додали до DTO (як 5045007): новий шлях запису без валідації.

### 2026-05-28 — Swallowed fetch годує обов'язковий контрол → заблокований workflow — frontend

**Сигнал:** `apiFetch('/list').then(setX).catch(() => {})` де `X` рендериться у `<Select>` обов'язкового поля, а submit-кнопка має `disabled={!form.fieldFromX}`. Базовий §1.3 анти-патерн (порожній catch) присутній, АЛЕ наслідок гірший за звичайний «порожній стан»: якщо список не завантажився, користувач фізично не може заповнити обов'язкове поле → кнопка назавжди disabled, без жодного пояснення. Часто сидить поряд з іншим catch який review/tester вже виправив (двійник на тій самій сторінці).
**Причина виникнення:** background-loader для довідника (філії, склади, валюти) додають як «другорядний» fetch і ставлять noop-catch, не усвідомлюючи що цей довідник гейтить критичний submit. Severity недооцінюють бо «список просто порожній».
**Підхід до виявлення:** для кожного `.catch(() => {})` знайти setter у `.then()`, далі grep чи цей state рендериться у `<Select required>` або у `disabled={!...}`. Якщо так — escalate з LOW до MEDIUM. Не плутати з тру-опціональними довідниками (там LOW досить).
**Підхід до фіксу:** окремий `xError` state (НЕ form-level `error`, бо loader спрацьовує до відкриття модалки і покаже stale-error); `.catch` встановлює повідомлення; inline `<p className="text-xs text-destructive-text">` під контролом.
**Severity:** MEDIUM — не втрата даних, але повністю заблокований legitimate workflow без feedback.
**Де шукати ще:** будь-яка mini-форма «створити X інлайн» (calendar new-WO, work-order new-client), будь-який екран з каскадними селектами (counterparty→vehicle→branch).

### 2026-05-28 — Мертвий стан/handler після inline→shared-component рефактору — frontend

**Сигнал:** після того як inline-патерн (search-dropdown, picker, autocomplete) замінили на shared-компонент (`SearchPickerModal`, `Combobox`), старі `useState`/`useCallback`/`useRef` + їх cleanup-ефекти лишаються. Ознака №1: setter (`setWoOptions`) викликається ТІЛЬКИ всередині reset-ефекту `if (!open) setX('')` і всередині самого orphaned-handler — а value (`woOptions`) НІКОЛИ не читається у JSX. Ознака №2: handler (`searchWorkOrders`) визначено через `useCallback` але жоден `onChange`/`onClick` його не викликає. Ознака №3: cleanup-ефект `return () => clearTimeout(woTimeoutRef.current)` для ref що більше нікуди не пишеться.
**Причина виникнення:** рефактор-комміт додає новий компонент і нові fetcher-и (`fetchWoItems`), правильно перемикає JSX, але «про всяк випадок» лишає старий код. `tsc` без `noUnusedLocals` (типово для Next.js) НЕ повідомляє про unused const на рівні тіла компонента. Code review теж пропускає бо локально кожен рядок виглядає валідним.
**Підхід до виявлення:** для кожного фіче-префіксного `useState` (`woX`, `cpX`, `searchX`) перевірити двосторонньо: (а) setter викликається десь окрім reset-ефекту? (б) value читається у JSX/computed? Якщо обидва «ні» — мертвий. Для `useCallback`-handler — grep чи його ім'я з'являється поза рядком визначення. Не покладатись на tsc.
**Підхід до фіксу:** видалити повний кластер — стани + handler + orphaned `timeoutRef` + його cleanup-ефект; спростити reset-ефект до того що реально лишилось; зберегти спільні типи/інтерфейси якщо їх використовує новий fetcher.
**Severity:** LOW — не runtime bug (код недосяжний), але плутає аудит (як Bug #158 що «виправив» вже-мертвий catch) і несе ризик зомбі-регресії якщо хтось випадково під'єднає назад.
**Де шукати ще:** будь-яка сторінка де inline-autocomplete мігрував у shared picker; settings-вкладки після уніфікації; форми де select замінили на modal-picker.

### 2026-05-28 — Timeline drag/resize px→time без clamp → Invalid Date → RangeError — frontend

**Сигнал:** timeline/calendar/gantt UI з drag або resize, де handler конвертує pointer delta у decimal-hours (`origEndH + deltaH`) і потім будує `new Date(\`${date}T${decimalHoursToHHMM(h)}:00\`).toISOString()`. Якщо resize-гілка clamp-ить результат ТІЛЬКИ проти протилежного краю (`origStartH + 0.25`) але НЕ проти меж видимого вікна — `h`може вийти за`[firstHour, lastHour+1]`. `decimalHoursToHHMM(24.5)`→`"24:30"`, `decimalHoursToHHMM(-1)`→`"-1:00"`→`new Date("...T24:30:00")`= **Invalid Date** →`.toISOString()`кидає`RangeError`. Помилка ловиться try/catch у pointerUp → показує нерелевантне "Помилка оновлення" і нічого не надсилає на сервер.
**Причина виникнення:** розробник клампить нову координату проти бізнес-правила "мінімум 15 хв тривалість" (проти протилежного краю слоту), але забуває що видиме вікно (08:00–20:00) — теж межа. Draw-гілка зазвичай безпечна бо `pxToDecimalHours`вже clamp-ить у`Math.max(HOURS[0], Math.min(HOURS[last], raw))`; resize рахує **delta** окремою формулою `pxToHours`і цей clamp обходить.
**Підхід до виявлення:** для кожного timeline/gantt page знайти ВСІ converter-и px→time (draw, resize-start, resize-end, drag-move — це різні гілки!). Для КОЖНОЇ перевірити: чи результат clamp-нутий у`[windowStart, windowEnd]`перед`new Date()`. Не довіряти що «draw clamp-ить, отже resize теж» — це окремі формули. Тест-сценарій: перетягнути край максимально за межу вікна.
**Підхід до фіксу:** додати `WINDOW_START`/`WINDOW_END`константи; обгорнути кожну resize/drag координату у`Math.max(WINDOW_START, Math.min(WINDOW_END, val))`; додатково hard-clamp у самому converter-і (`decimalHoursToHHMM`: `Math.min(24\*60, Math.max(0, totalMin))`) як остання лінія оборони для майбутніх викликачів.
**Severity:** MEDIUM — не втрата даних (PATCH не надсилається), але resize мовчки ламається + misleading error; UX broken на легітимній дії.
**Де шукати ще:** будь-який майбутній gantt/timeline/scheduler/booking-grid; mobile-планшет екран з drag слотів; будь-який handler що будує ISO timestamp з user-керованої координати.

### 2026-05-28 — Стала spec після рефактору сервісу — backend, test-coverage

**Сигнал:** baseline unit ❌ при docs-only diff. Дві ознаки: (1) NestJS "Nest can't resolve dependencies of the XService (PrismaService, ?) ... at index [N]" → нова constructor-залежність не замокана у `Test.createTestingModule`; (2) `expect(spy).toHaveBeenCalledWith(...)` → "Number of calls: 0" коли spy реально не викликався бо `mockResolvedValueOnce(null)` спожився раніше ніж очікувалось.
**Причина виникнення:** perf/simplify commit змінює сервіс (додає `CacheService` у конструктор, АБО зводить `create()/update()` з N `findFirst` до одного single-round-trip), але парний `*.spec.ts` не оновлюється. Тести лежать «зеленими» в пам'яті розробника, реально падають при наступному прогоні. Docs-only сесія не торкає код, але baseline-прогін викриває борг.
**Підхід до виявлення:** для кожного `service.ts` зміненого за останні N commits — звірити: (а) кожен `private readonly X: Type` конструктора присутній як provider у спеці; (б) кількість `mockResolvedValueOnce` на `findFirst` = реальна кількість викликів у методі (читати сервіс, не вгадувати). Не довіряти "тести зелені були минулого разу" — запускати baseline ЗАВЖДИ (Крок 0), навіть для docs-only.
**Підхід до фіксу:** фіксувати ТЕСТ, не код (prod коректний). Додати мок-провайдер для нової залежності (`CacheService.get` → `null` щоб не ламати cache-miss fallthrough); привести `mockResolvedValueOnce` ланцюг до фактичної кількості викликів.
**Severity:** MEDIUM — не runtime bug, але CI/baseline червоний → блокує наступні сесії та ховає реальні регресії за шумом.
**Де шукати ще:** усі `*.service.spec.ts` сервісів що отримали `CacheService` у perf-раунді (brands, units, payment-methods, branches, zones, work-categories, bank-accounts, cash-registers, dashboard) — якщо спека існує і будує власний TestingModule, вона під ризиком того ж DI fail.

### 2026-05-28 — Soft-delete resurrection / P2002 — backend, unique constraints

**Сигнал:** `create()` на таблиці з `@@unique([orgId, X])` де X не включає `deletedAt` — soft-deleted рядок займає uniq index
**Причина виникнення:** `findFirst({ deletedAt: null })` вважається повною перевіркою, але soft-deleted рядок блокує DB unique constraint
**Підхід до виявлення:** `@@unique` без partial `WHERE deletedAt IS NULL` + `create()` без resurrection
**Підхід до фіксу:** `findFirst({ NOT: { deletedAt: null } })` → якщо знайшов: `update({ ...dto, deletedAt: null })` замість `create`
**Severity:** HIGH — P2002 → HTTP 500 замість ConflictException; дані не псуються але UX broken
**Де шукати ще:** будь-який новий довідниковий модуль з `@@unique([orgId, code/name/shortName])`

---

### 2026-05-28 — @db.Date timezone mismatch — backend, date handling

**Сигнал:** `new Date(dto.date)` де `dto.date` — ISO string з TZ offset → UTC-parse зміщує дату
**Причина виникнення:** `new Date(isoString)` завжди парсить у UTC; `@db.Date` очікує UTC midnight
**Підхід до виявлення:** шукати `new Date(dto.X)` де X — поле `@IsDateString()` що пишеться у `@db.Date` колонку
**Підхід до фіксу:** `parseDateOnly(dto.date)` — витягти `YYYY-MM-DD` перші 10 символів + parse UTC midnight
**Severity:** HIGH — неправильна дата в БД для клієнтів у UTC+X
**Де шукати ще:** exchange-rates, warranties, maintenance-schedules, будь-що з date-only полем

---

### 2026-05-28 — $transaction(array, { timeout }) не підтримується Prisma 5 — backend

**Сигнал:** `prisma.$transaction([...promises], { timeout: N })` — TS-помилка (timeout не в array-form)
**Причина виникнення:** array-form приймає тільки `{ isolationLevel }`, callback-form — `{ timeout }`
**Підхід до виявлення:** grep `\$transaction(\[` — якщо там `timeout` → баг
**Підхід до фіксу:** переписати array → callback-form (`async tx => { for ... }`)
**Severity:** MEDIUM — TS-помилка при build; runtime може відпрацювати але без timeout гарантії
**Де шукати ще:** pricing.service.ts, будь-який масив із `$transaction` де хотіли timeout

---

### 2026-05-28 — Prisma plural table → singular model lookup — backend, sync

**Сигнал:** dynamic `(prisma as any)[modelName]` де modelName — snake_case plural (`work_orders`) → `prisma.workOrders === undefined`
**Причина виникнення:** Prisma exposes singular camelCase (`workOrder`), не plural; `@@map` задає plural тільки для таблиці
**Підхід до виявлення:** grep `toCamel\|snake.*camel` + перевірити чи є explicit `TABLE_TO_MODEL` map
**Підхід до фіксу:** explicit `Record<tableName, modelKey>` + `if (!model) throw` (fail-fast)
**Severity:** CRITICAL — `TypeError: Cannot read properties of undefined` на runtime; `.catch()` не ловить синхронний access
**Де шукати ще:** sync.service.ts будь-який dynamic model lookup

---

### 2026-05-28 — BigInt у payload spread → JSON.stringify 500 — backend, sync

**Сигнал:** `payload = { ...row }` де row має `syncVersion BigInt` → `Fastify JSON.stringify TypeError`
**Причина виникнення:** `syncVersion: Number(row.syncVersion)` конвертує top-level, але `{ ...row }` копіює BigInt у payload
**Підхід до виявлення:** grep `payload.*\.\.\.row\|{ \.\.\.row }` у sync/pull endpoints
**Підхід до фіксу:** прохід по полях: `if (typeof v === 'bigint') Number(v)` — об'єднати з BLACKLIST в один цикл
**Severity:** CRITICAL — 500 при будь-якому sync pull з реальними даними
**Де шукати ще:** будь-який endpoint що spread-ить Prisma row напряму у response

---

### 2026-05-28 — CRON findMany без deletedAt: null на Organisation — backend

**Сигнал:** `organisation.findMany()` без `where: { deletedAt: null }` у CRON-job → обробляє видалені org
**Причина виникнення:** CRON-код пишеться без думки про soft delete — кожен tenant проходить без перевірки
**Підхід до виявлення:** grep `organisation.findMany` у `*.processor.ts` / `*.scheduler.ts` | grep -v "deletedAt"
**Підхід до фіксу:** `where: { deletedAt: null }` — завжди для findMany на Organisation у CRON
**Severity:** HIGH — мертві org отримують SMS/webhooks, витрачаються кредити
**Де шукати ще:** followup.processor, будь-який новий scheduler

---

### 2026-05-28 — Playwright fullyParallel + Next.js dev → SyntaxError race — frontend, E2E

**Сигнал:** `Invalid or unexpected token` у console-errors.spec при > 5 workers + Next.js dev server
**Причина виникнення:** Next.js dev компілює chunks on-demand; паралельні workers отримують partial JS
**Підхід до виявлення:** console-errors.spec з `fullyParallel: true` і > 5 routes → SyntaxError у браузері
**Підхід до фіксу:** `test.describe.configure({ mode: 'serial' })` + `beforeAll` warm-up на `/dashboard`
**Severity:** MEDIUM — flaky tests, не production bug
**Де шукати ще:** будь-який E2E файл що навігує > 5 routes у Next.js dev

---

### 2026-05-28 — .catch(() => {}) ховає loading/error стан — frontend

**Сигнал:** `apiFetch(...).then(setX).catch(() => {})` у mount useEffect → loading ніколи false, error ніколи set
**Причина виникнення:** розробник додає fetch поступово без рефакторингу loading/error шаблону
**Підхід до виявлення:** grep `.catch(() => {})` + перевірити чи є `setLoading(true)` + `setError`
**Підхід до фіксу:** канонічний шаблон: `let cancelled=false; setLoading(true); fetch.then(...).catch(setError).finally(() => !cancelled && setLoading(false)); return () => cancelled=true`
**Severity:** LOW-MEDIUM — UX broken (empty state замість error, loading spinner ніколи не зникає)
**Де шукати ще:** нові вкладки settings, будь-яка сторінка де fetch додавався інкрементально

---

## Що вже перевірено (не дублювати)

**Backend:**

- ✅ FSM transition map pattern (work-orders.fsm.ts)
- ✅ InventoryService guards (quantity=0, available < qty, RESERVATION_RELEASE)
- ✅ SettlementsService guards (CHARGE ↑, PAYMENT ↓)
- ✅ Soft-delete: всі основні сервіси
- ✅ Resurrection pattern: currencies, exchange-rates, brands, units, payment-methods
- ✅ Org-scoped FK validation перед write: goods (brandId/unitId/preferredSupplierId — Bug #161), invoices/work-orders clone (Bug #90)
- ✅ $transaction explicit timeout: всі interactive callbacks
- ✅ ParseUUIDPipe: всі :id параметри
- ✅ Security headers (X-Content-Type-Options, X-Frame-Options, HSTS via @fastify/helmet@11)
- ✅ SSRF guard: webhooks.processor (validatePublicUrl + redirect: 'manual')
- ✅ ArrayMaxSize: inspection.dto, webhook payload
- ✅ Deploy/infra (phase18): docker-compose api healthcheck node-http /api/health (Bug #164/#165); minio healthcheck `mc ready local` замість curl-less образу + пін RELEASE-тегу (Bug #170); root .dockerignore (Bug #166); build-prod.ps1 export→apps/web/out + $PSScriptRoot fallback (Bug #167); nginx \_next/static immutable + gzip_types svg/js (Bug #168). /api/health публічний (HealthController без @UseGuards, auth per-controller) → healthcheck 200. minio/minio = лише mc, НЕ curl/wget (перевірено емпірично)

**Frontend:**

- ✅ cancelled flag: AuthProvider, всі mount-fetches (settings, crm, work-orders)
- ✅ SSR-safe today: useState(null) + useEffect → setToday(new Date())
- ✅ apiFetch error array join: `Array.isArray(msg) ? msg.join('; ') : msg`
- ✅ UUID validation client-side перед submit
- ✅ aria-label на іконкових кнопках (після bulk-fix)
- ✅ React named imports (не React.ReactNode)
- ✅ React Query Sprint B: QueryClient singleton (staleTime 30s, retry 1, refetchOnWindowFocus false); 5 query hooks (workOrders/invoices/counterparties/inventory/purchaseOrders) з queryKey factory; cross-resource invalidation покриває PO receive→inventory, PO apply-pricing→inventory, work-orders create→workOrders (Bug #210-#212); useWorkOrders.test.tsx як зразок query-hook tests (12 кейсів — queryKey factory, enabled gate, URLSearchParams build, signal abort)

**Tests:**

- ✅ Contract specs: auth, work-orders, warehouses, counterparties, sync, settings, audit, pricing-rules, batches, currencies, bank-accounts, exchange-rates, cash-registers, calendar (GET/POST/PATCH/DELETE — resize/drag PATCH endpoint)
- ✅ Service specs (query-shape): goods (FK validation), counterparties (?q= plural relation customerGarages→vehicles — Bug #163), work-orders (findAll calendarSlots include: plural relation + take:1 + deletedAt + orderBy asc; ?q= counterparty nested; employeeId some soft-delete — Bug #171)
- ✅ Pricing service specs: COST_TIER tier matching (first/mid/last/none), brandId priority over goodType (Bug #179)
- ✅ Calendar timeline px→time clamp: усі гілки (draw/pending-resize/saved-resize/drag) clamp у [WINDOW_START,WINDOW_END]; isEditingPast minHour-boundary (slot==minHour → НЕ past)
- ✅ Property-based invariants: inventory, settlements, FSM (26 invariants)
- ✅ Component tests: 148/148 passed (14 файлів)
- ✅ E2E: 42/42 passed (smoke, console-errors serial mode, inventory, api-errors)

---

### 2026-06-01 — Optional numeric DTO field з тільки @IsOptional() (Bug #283) — backend, validation, data-integrity

**Сигнал:** DTO має optional поле типу `number?` (або `maxWeightKg?: number` / `priceCents?: number` / `quantity?: number` / `mileage?: number`) декороване **виключно** `@ApiPropertyOptional() @IsOptional()`. Жодного `@IsInt()` / `@IsNumber()` / `@Min()` / `@Max()` / `@Type(() => Number)`. `class-validator` БЕЗ type-decorator пропускає БУДЬ-ЯКЕ значення: string `"abc"`, `-99999`, `Number.POSITIVE_INFINITY`, `2.5` (для Int colum), масив, об'єкт. Validation pipe whitelist=true не фільтрує бо поле оголошене у DTO. Сервіс отримує garbage → Prisma kraх з `Invalid value Nan` / `Argument of type 'string' is not assignable to parameter of type 'number'` АБО silent data corruption (`Math.floor(2.5) = 2`).

**Grep для виявлення:**

```bash
# Всі optional numeric поля без type/range decorators у DTO
grep -rn "?: number\b" apps/api/src/modules/ --include="*.dto.ts" | while read line; do
  file=$(echo "$line" | cut -d: -f1)
  lineno=$(echo "$line" | cut -d: -f2)
  # Перевірити 5 рядків ПЕРЕД полем — чи є @IsInt/@IsNumber/@Min/@Max декоратори?
  startline=$((lineno > 5 ? lineno - 5 : 1))
  ctx=$(sed -n "${startline},${lineno}p" "$file")
  if ! echo "$ctx" | grep -qE "@IsInt|@IsNumber|@Min|@Max|@IsPositive|@Type\(\(\) => Number\)"; then
    echo "MISSING numeric guard at $file:$lineno"
  fi
done

# Аналогічно для required numeric fields (рідше bug, але буває)
grep -rn "!: number\b" apps/api/src/modules/ --include="*.dto.ts" | grep -v ".service.ts:\|.spec.ts:"
```

**Причина виникнення:** розробник пише DTO інкрементально: спочатку додає поле зі швидким `@ApiPropertyOptional()`, потім (якщо встигне) повертається додати валідатори. Або скопіював існуюче поле з `@IsString()` + замінив тип на `number` забувши оновити декоратори. Або вірить що TypeScript `number` автоматично відбракує string на runtime (НЕ ВІДБРАКОВУЄ — typecasting тільки compile-time). Сприймає `@IsOptional()` як «достатньо, бо optional» — насправді `@IsOptional()` лише дозволяє undefined, не контролює тип.

**Підхід до виявлення:**

1. Grep усіх optional numeric полів у `*.dto.ts` (паттерн `?: number`).
2. Для кожного — перевірити чи у попередніх 5 рядках є хоч один з: `@IsInt`, `@IsNumber`, `@Min`, `@Max`, `@IsPositive`, `@IsNegative`, `@Type(() => Number)`.
3. Якщо ні — bug. Severity HIGH якщо поле зберігається у БД у NOT NULL колонці типу Int (crash на runtime) або у бізнес-розрахунку (silent data corruption через NaN/Infinity).
4. Парне: перевіряти ВСІ numeric DTO поля (як required `!: number`, так optional `?: number`).

**Підхід до фіксу:** додати повний пакет декораторів у такому порядку:

```ts
@ApiPropertyOptional({ example: 3500, description: '...' })
@IsOptional()
@Type(() => Number)              // приймає "3500" (string) → 3500 (number) для query/form-data
@IsInt()                          // або @IsNumber({ maxDecimalPlaces: 2 }) для money
@Min(0)
@Max(50000)                       // domain-specific upper bound
fieldName?: number;
```

Для money/decimal: `@IsNumber({ maxDecimalPlaces: 2 })` (Prisma Decimal toleratees). Для Int colum: завжди `@IsInt()`. Для дробових: `@IsNumber()`. `@Min(0)` майже завжди потрібен для лічильників/розмірів/ваги. `@Max(...)` залежить від domain — для maxWeightKg = `50_000` (50 тонн); для percentage = `100`; для year = `9999`.

**Severity:** HIGH (validation повністю обходиться → runtime crash + data corruption). MEDIUM якщо поле використовується лише у звітності (read-only impact).

**Де шукати ще:**

- Будь-який новий DTO (CreateXDto / UpdateXDto) з numeric optional полями.
- Query DTO з `limit?: number`, `page?: number`, `offset?: number` — мають бути `@IsInt() @Min(1) @Max(200)`.
- DTO з опціональними часовими інтервалами (`intervalDays?: number`, `timeoutMs?: number`).
- DTO з geo-координатами (`lat?: number`, `lng?: number`) — `@Min(-90) @Max(90)` для lat.
- Зверніть увагу: `@Type(() => Number)` потрібен ТІЛЬКИ якщо input може прийти як string (query params, multipart/form-data). Для JSON body — class-validator довіряє типу.

**Регресія-guard:** для кожного нового DTO з numeric optional поле — contract-spec який POST/PATCH-ить string `"abc"` / `-1` / `99999999` / float `2.5` (для Int) і очікує 400. Приклад: `lifts.contract.spec.ts` для Bug #283 додав 10 тестів (5 happy + 5 negative).

---

### 2026-06-01 — Fake-green assertion `toBeGreaterThanOrEqual(0)` (Bug #287) — test-reliability, dead-assertion

**Сигнал:** Playwright/Vitest test містить assertion який **завжди true**: `expect(count).toBeGreaterThanOrEqual(0)` (count від `.count()` ВЖЕ non-negative), `expect(arr.length).toBeGreaterThanOrEqual(0)`, `expect(result).toBeTruthy()` де result statically гарантовано truthy. Особливо підступно коли message-параметр звучить як справжня перевірка: `expect(count, 'Має бути хоча б 3 KPI картки').toBeGreaterThanOrEqual(0)`. Тест зеленіє назавжди — навіть якщо весь UI зник. Гірше за відсутню перевірку: створює фальшиве враження покриття.

**Grep для виявлення:**

```bash
# Fake-green patterns:
grep -rn "toBeGreaterThanOrEqual(0)\b" apps/web/e2e apps/web/src apps/api/src --include="*.ts" --include="*.tsx" | head -20
grep -rn "\.count().*toBeGreaterThanOrEqual\|\.length.*toBeGreaterThanOrEqual(0)" apps/web --include="*.ts"

# Інші подібні:
grep -rn "expect(true)\|expect(1).toBe(1)\|expect(0).toBe(0)" apps/web --include="*.ts"
grep -rn "toBeDefined()" apps/web/e2e --include="*.ts" | head -10   # для primitives often fake (a number is always defined)
```

**Причина виникнення:**

1. Розробник пише test scaffold з placeholder assertion: «треба буде уточнити локатор, поки що `>= 0`» → забуває уточнити.
2. Локатор spam'ить false-negatives → розробник «послаблює» assertion щоб тест перестав падати, не розслідуючи причину. Замість fix локатора отримуємо oBeGreaterThanOrEqual(0).
3. `.count()` повертає 0 коли список не завантажився → розробник хоче «м'якіший» тест → ставить `>= 0` (читає як «не fail») замість `>= 1` (читає як «хоча б 1»).
4. Copy-paste з другого тесту де `>= 0` мав сенс (наприклад counter що може бути від'ємним), не адаптує під новий контекст.

**Підхід до виявлення:**

1. Grep `toBeGreaterThanOrEqual(0)` — кожен match є кандидат на bug.
2. Для кожного: дивитись що `count` повертає. Якщо `.count()` (Playwright Locator) або `.length` (масив) → завжди `>= 0` → fake. Якщо `async aggregateBalance()` що може бути від'ємним → справжній.
3. Перевірити message-string assertion: якщо message каже «хоча б N» / «мінімум M» — assertion має співпадати (`>= N`, не `>= 0`).
4. `toBeDefined()` на `number` / `string` literal — підозра (literal завжди defined).

**Підхід до фіксу:**

1. Знайти **реальну очікувану кількість** з product/component spec. Якщо UI має ровно 6 KPI cards — `toBe(6)`. Якщо мінімум 3 з можливих 6 — `toBeGreaterThanOrEqual(3)`.
2. Якщо локатор ненадійний (`[class*="kpi"]` ловить також breadcrumbs, тощо) — пере-локалізувати на більш конкретний selector (`[class*="kpi-card-"]` де `kpi-card-` точно у component, або `data-testid="kpi"`).
3. Якщо assertion справді опціональна (page має 0..N elements залежно від data) — або (a) seed test data так щоб кількість була детермінована, або (b) видалити assertion взагалі (краще нічого ніж брехня).
4. Використовувати `expect.poll(async () => locator.count()).toBeGreaterThanOrEqual(N)` для асинхронних UI.

**Severity:** MEDIUM. Fake-green assertion не зловить регресію — UI поламається у production, тест залишиться зеленим, разробник не дізнається до user-report. Особливо критично для smoke-тестів які єдиний gate перед deploy.

**Де шукати ще:**

- E2E тести де count assertions
- Unit тести де `expect(items.length).toBeGreaterThanOrEqual(0)`
- Vitest snapshot тести без real content check (snapshot=undefined на 1-му запуску — passes до коли хтось не глянув)
- Property-based тести з `fc.array().filter(() => true)` — ефективно вимикає filter
- Будь-який `// TODO: tighten this assertion` коментар поряд з assertion

**Профілактика:** lint-rule (custom ESLint plugin) що детектує `toBeGreaterThanOrEqual(0)` на `.count()` / `.length` return → попередження. Аналогічно `toBeTruthy()` на literal.

---

### 2026-06-01 — Stale Next.js `.next/` cache після route group рефакторингу (Bug #291) — infra, build-cache, route-groups

**Сигнал:** будь-який commit що містить rename pattern `app/X/page.tsx → app/(group)/X/page.tsx` (або зворотній) у Next.js App Router проєкті. `git diff` показує:

```
rename from apps/web/src/app/X/page.tsx
rename to apps/web/src/app/(app)/X/page.tsx
```

АБО `git log --stat`:

```
apps/web/src/app/{ => (app)}/work-orders/page.tsx
```

Симптом у dev: TS green, unit tests green, але живий dev server повертає 500 на КОЖНОМУ chunk:

- `(app)/layout.js` → 500 `Cannot find module './726.js'`
- `(app)/work-orders/page.js` → 500
- `main-app.js` → 500
- `layout.css` → 500

Browser HTML завантажується, але всі JS chunks 500 → React не гідрується → ніяких client-side React effects не запускається → AuthProvider не dispatch LOGOUT → TopShell auth-guard `useEffect` ніколи не виконується → користувач застряг на захищеному URL **без auth redirect**.

E2E smoke test «захищена /work-orders без auth — врешті redirect на /login» падає з 33+ retry без redirect.

**Причина виникнення:** Next.js dev server тримає `.next/server/webpack-runtime.js` з фіксованими chunk-id числами. Route group rename змінює структуру chunks і chunk-id числа. Старий `webpack-runtime.js` посилається на `./726.js` (старе chunk-id), але новий build згенерував інші числа → ENOENT з вершини стеку, 500 на всіх запитах. HMR (hot module replacement) НЕ ловить структурні зміни — тільки content зміни. `next dev` потрібно повного перезапуску ПІСЛЯ повного видалення `.next/`.

**Підхід до виявлення:** на Кроці 0 — детектити route group rename у diff і **примусово** очищати `.next/` перед TS/unit/E2E:

```bash
# Детект rename pattern (R = rename у --name-status)
renames=$(git diff HEAD~5 HEAD --name-status | grep -E "^R.*app/.*\((app|auth|admin)\)")
# Або людський діалект:
group_moves=$(git log -1 --stat HEAD~5..HEAD | grep -E "app/\{ =>|app/.* => app/\(")

if [ -n "$renames" ] || [ -n "$group_moves" ]; then
  echo "Route group rename detected — clearing .next/ cache"
  rm -rf apps/web/.next apps/web/tsconfig.tsbuildinfo
  # перезапустити web dev server
fi

# Healthcheck після restart — критично:
sleep 20
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3001/_next/static/chunks/main-app.js
# 200 — OK; 500 — cache не очищено, retry
```

**Підхід до фіксу:**

1. `rm -rf apps/web/.next apps/web/tsconfig.tsbuildinfo`
2. Перезапустити dev server (port 3001) — нова webpack-runtime згенерована з нової структури
3. Перевірити що chunks повертають 200
4. Перезапустити E2E

**Severity:** CRITICAL. Не тому що production build зачеплено (production `next build` чистий), а тому що (а) dev workflow повністю заблокований до очищення; (б) E2E auth-guard regression test 100% fail з вводячим в оману повідомленням; (в) ловиться ТІЛЬКИ runtime-перевіркою — static analysis (TS, lint, unit) сліпий до webpack chunk runtime.

**Де шукати ще:**

- Будь-який `app/` рефакторинг у Next.js: route group rename (`(group)`), parallel route (`@slot`), intercepting route (`(.)foo`), private folder rename (`_private`). Усі вони змінюють webpack chunk структуру.
- Перейменування layout файлів (`app/layout.tsx` ↔ `app/(group)/layout.tsx`).
- Перенесення client/server boundary (`'use client'` директива додана/видалена у file що рендериться у нову chunk).
- Зміни у `next.config.js/ts` що чіпають `experimental.optimizePackageImports` або `serverComponentsExternalPackages` — теж змінюють chunk структуру.
- Аналогічна проблема з `tsconfig.tsbuildinfo` — TS incremental build cache може зберегти посилання на старі модулі. Видаляти разом з `.next/`.

**Профілактика:**

1. `.husky/post-rewrite` hook що видаляє `apps/web/.next` після `git rebase`/`git checkout` що чіпає route structure (`git diff --name-status @{1} HEAD | grep -E "^R.*app/"`).
2. У CI: `next build` ЗАВЖДИ запускається з чистого `.next/` (зазвичай так), а dev — ні. Тому regression `.next/` cache проявляється тільки локально → можна не помітити при PR review.
3. sto-tester §0 тепер обов'язково перевіряє rename pattern.
4. Документація: pre-flight у sto-feature/sto-web SKILL — після route group рефакторингу нагадування «clear .next».

---

### 2026-06-02 — Nullish coalescing `?? 1` НЕ ловить 0 від БД-дільника без CHECK constraint (Bug #316) — backend, defense-in-depth, divider

**Сигнал:** `coefficient ?? 1` / `divider ?? 1` патерн у read-path/DTO коли value читається з БД-колонки без `@check value > 0` CHECK constraint. DTO `@Min(0.000001)` блокує **новий** 0 на write-path, але:

```bash
grep -rn "\.coefficient\s*\?\?\s*1\|divider\s*\?\?\s*[0-9]" apps/api/src/modules --include="*.service.ts"
grep -rn "/\s*[a-z]*coeff\|/\s*[a-z]*divider" apps/api/src/modules --include="*.service.ts"
# для кожного match — перевірити схему: чи колонка має `@db.Decimal.*` БЕЗ CHECK constraint
grep -n "coefficient.*Float\|coefficient.*Decimal" packages/database/prisma/schema.prisma
```

Якщо `coefficient` у схемі — `Float @default(1)` без `@check coefficient > 0` → DB приймає 0. Якщо runtime робить `?? 1` де очікує fallback для 0 — silent data corruption.

**Причина виникнення:**

1. Bug #302/#312 fix додав DTO-level `@Min(0.000001)` — закриває forward-проблему для нових записів через API.
2. Але історичні дані (seed, прямий SQL, Prisma Studio edit, CSV import) або direct-DB операції оминають DTO.
3. Розробник пише defensive `?? 1` припускаючи що це покриває «відсутнє значення». Але nullish coalescing спрацьовує **лише** на `null`/`undefined`, не на `0`.
4. `0` як **дільник** → `Infinity` (для `x / 0` де `x > 0`) або `NaN` (для `0 / 0`).
5. Prisma не падає при `quantity: Infinity` — Float колонка приймає Infinity → DB має `inf` → подальші запити повертають Infinity → toFixed/JSON.stringify ламається у frontend.

**Підхід до виявлення:**

1. Знайти **кожен дільник** (`a / b` де `b` приходить з БД): `grep -rn "/\s*[a-z]*[Cc]oeff\|/\s*[a-z]*[Dd]ivider\|/\s*[a-z]*[Rr]ate\|/\s*[a-z]*[Mm]ultiplier"`.
2. Перевірити чи `b` обернений у `?? 1` (nullish, НЕ catch 0) чи `|| 1` (truthy, catches 0).
3. Перевірити schema чи колонка має `@check` constraint що блокує 0.
4. Якщо schema приймає 0 + код використовує `??` → bug.
5. Аналогічно перевірити read-path DTOs: `coefficient: x ?? defaultValue` де `x` приходить з findFirst include — той самий клас.

**Підхід до фіксу:**

Додати helper-функцію у service-файл (або shared utility):

```ts
function safeCoeff(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(value) || value <= 0) return 1;
  return value;
}
```

Замінити всі `value ?? 1` де value — потенційний дільник на `safeCoeff(value)`. Покриває: null, undefined, 0, NaN, негативні, Infinity-у-input.

Альтернатива (менш гнучка): `value || 1` (truthy fallback) — ловить 0/NaN/'', АЛЕ також ловить «правильні» 0-подібні значення (наприклад `0.5` пройде, а легітимний 0 нема де у дільнику). Для `coefficient` `0` ніколи не легітимний → `||` працює, але helper-функція explicit і testable.

**Defense-in-depth:** DTO `@Min(0.000001)` (захищає forward) + `safeCoeff` runtime (захищає legacy/migration/CSV).

**Severity:** MEDIUM. Forward-bug закритий DTO guard → нові запити OK. Але legacy-rows можуть існувати → unpredictable. Не CRITICAL бо seed/UI рідко дозволяють 0 — тільки rare adversarial path. Severity HIGH якщо схема нова + CSV import відомий шлях вводу.

**Де шукати ще:**

- `exchange-rates.service.ts` — `rate` і `coefficient` Decimal без CHECK constraint, використовуються у конвертаціях `amount / rate`
- `pricing.service.ts` — `markup`, `tier_multiplier` поля у PricingRule
- `payments.service.ts` — `discount_rate`, `commission_rate` поля
- Будь-яка `vatRate / 100` — `vatRate` валідація DTO, але runtime defense?
- Експорт/імпорт (XLSX/CSV) — найчастіший вектор «погані» 0 потрапляють у БД оминаючи DTO
- Прямі SQL-міграції що бекфілять колонку — забуваються CHECK constraints
- Sync (mobile WatermelonDB → API) — клієнт відсилає payload, якщо валідація на клієнтській стороні відрізняється від DTO

**Профілактика:**

1. Додати Postgres CHECK constraint у міграцію для кожної колонки що використовується як дільник: `ALTER TABLE "GoodUoM" ADD CONSTRAINT "coefficient_positive" CHECK ("coefficient" > 0);`
2. У `@sto/shared` додати утиліту `safeNumberRatio(numerator, denominator, fallback = 1)` з default Math.max guard.
3. ESLint custom rule: `?? 1` на змінній що використовується у `/ X` контексті — warn.
4. Type-level guard через branded type: `type SafeCoefficient = number & { __brand: 'positive' }` — функція converter validate + brand → запобігає прямому `divide(x, y)` коли `y` не branded.

---

### 2026-06-02 — isSystem-guard відсутній у update()/remove() для seed-керованих сутностей (Bug #319-#320) — backend, business-rule enforcement

**Сигнал:** Сутність у schema.prisma має `isSystem Boolean @default(false)` (catalog seed-керовані: `WorkCategory`, `GoodCategory`, `UnitOfMeasure`, `NotificationTemplate`, `PaymentMethodConfig`, `TaxRate`, system roles тощо). Сервіс `update()` робить `findFirst({id, orgId})` (іноді з `select: { isSystem: true }`), але НЕ перевіряє `existing.isSystem` перед mutation. Сервіс `remove()` так само не блокує системні рядки. UI (CategoryManagerModal, UnitsTab tabs тощо) ховає кнопки «Перейменувати»/«Видалити» для системних — але це **косметичний UI guard**, backend — авторитет.

Атакувальний вектор: будь-який ADMIN/OWNER з валідним JWT робить `curl -X PATCH /<resource>/<system-id> -d '{"name":"X"}'` або `curl -X DELETE` → бекенд приймає, виконує. Системний catalog (71 WorkCategory + 365 GoodCategory + 30+ UnitOfMeasure) тимчасово ламається до повторного запуску `seed-catalog.ts`. Custom per-org налаштування (sortOrder, isActive, parentId переноси між гілками) загубляться.

**Причина виникнення:** Розробник пише `update(orgId, id, dto)` як standard CRUD, фокусується на tenant isolation (`orgId` у where) і zod/DTO валідацію. `isSystem` flag сприймається як **read-only метаданими** для frontend (приховати кнопку), а не як backend invariant. Помилка особливо ймовірна коли:

1. Спочатку реалізовано через UI-фічу (manager modal ховає action), backend pure CRUD.
2. Сесія fix-у Bug #305 «restore() без isSystem guard» додає guard у restore, але не у update/remove.
3. Mass-DTO refactor (Bug #215 pattern) переписує `@IsUUID('4')` без перегляду business-rule.

Відсутність парного contract spec для `PATCH system → 400` робить регресію невидимою у CI.

**Підхід до виявлення:**

1. Grep усіх моделей з `isSystem` у schema:
   ```bash
   grep -B1 -A3 "isSystem\s*Boolean" packages/database/prisma/schema.prisma | grep "^model"
   ```
2. Для кожного знайденого `model X` → відкрити відповідний `apps/api/src/modules/<x>/<x>.service.ts` → перевірити:
   - `update()`: чи `select` містить `isSystem: true`? Чи є `if (existing.isSystem && ...) throw ...`?
   - `remove()`: чи є `if (existing.isSystem) throw BadRequestException(...)`?
   - `restore()`: уже покрито Bug #305.
3. Парне з contract spec: `grep "isSystem.*true" apps/api/src/modules/<x>/<x>.contract.spec.ts` — має бути мінімум 2 кейси (PATCH system blocked, DELETE system blocked).
4. Не достатньо лише `select: { isSystem: true }` — це не блокує. Перевіряти actual throw.

**Підхід до фіксу:**

1. `update()`: додати після `findFirst` (з `select: { id: true, isSystem: true }`):
   ```ts
   if (
     existing.isSystem &&
     (dto.name !== undefined || dto.parentId !== undefined || dto.code !== undefined)
   ) {
     throw new BadRequestException('Системну категорію не можна перейменовувати або переносити');
   }
   ```
   Косметичні поля (`sortOrder`, `icon`, `isActive`) дозволяються — це per-org налаштування.
2. `remove()`: додати після `findFirst`:
   ```ts
   if (existing.isSystem) throw new BadRequestException('Системну категорію не можна видалити');
   ```
3. Якщо UI має checkbox/switch для toggle ACTIVE — це OK (per-org налаштування видимості системної категорії), guard має бути ТІЛЬКИ для name/parentId/code/delete.
4. Contract spec — 4 regression-guard кейси:
   - `PATCH /<resource>/<system-id>` з `{ name }` → 400
   - `PATCH /<resource>/<system-id>` з `{ parentId }` → 400
   - `PATCH /<resource>/<system-id>` з `{ sortOrder }` → 200 (косметика дозволена)
   - `DELETE /<resource>/<system-id>` → 400

**Severity:** HIGH (data corruption via API bypassing UI; recovery вимагає повторного seed-у з втратою custom налаштувань).

**Де шукати ще:**

- `UnitOfMeasure` (isSystem=true для базових `шт`, `кг`, `л`) — `units.service.ts` `remove()` уже має `isSystem: false` у WHERE через 2026-06-02 sto-optimize patterm. Перевірити `update()`.
- `NotificationTemplate` — системні templates (welcome, invoice-paid).
- `PaymentMethodConfig` — системні методи (готівка, картка, переказ).
- `TaxRate` — системні ставки (20% ПДВ).
- Майбутні seed-керовані catalog-сутності (`Currency`, `BankBranch`, predefined roles/permissions).

**Профілактика:**

1. У `/sto-dev` SKILL.md: «Будь-яка модель з `isSystem Boolean` → service.update і service.remove МАЮТЬ guard `if (existing.isSystem) throw BadRequestException(...)`».
2. У `/sto-review` checklist: «Чи кожен service-метод що mutates seed-керовану сутність перевіряє `isSystem`?»
3. У `/sto-backend` шаблоні сервісу: додати TODO-плейсхолдер `// isSystem guard?` для кожного update/remove на seed-керованій моделі.
4. Тіло шаблону contract spec в `/sto-backend`: 4 obligatory кейси для системних рядків.

---

### 2026-06-02 — refetch-callback (onChanged) без race-guard у CategoryManagerModal / SettingsModal / sub-resource модалках (Bug #323) — frontend, race-condition

**Сигнал:** Модальне вікно з CRUD по sub-resource (категорії, UoM, tax rates, payment methods) приймає `onChanged: () => void` callback від parent компонента. Реалізація onChanged — інлайнова `apiFetch<X[]>(/endpoint).then(setState).catch(() => {})` без AbortController/reqRef. Користувач робить швидку послідовність дій у модалі (rename → add child → toggle active за ~200ms) → 3 fetch-и запускаються паралельно → resolve order не гарантовано → setState останнього resolved wins. Stale tree відображається після фінальної мутації.

Парне: `.catch(() => {})` (swallow-error) теж ховає 401/500.

**Причина виникнення:** Розробник пише модалку як «autonomous CRUD widget», callbacks-driven. Parent компонент має складніший load() з ref-counter (loadReqRef для goods list, race-guarded для tabs), а sub-resource refetch виглядає простим — «just refetch the tree». В sprint поспіх просто інлайнить fetch. Шаблон закріплюється через copy-paste.

Виявити цей баг важко локально бо потрібна swift inter-modal-action послідовність — у дев-режимі з повільним API майже завжди порядок послідовний (synchronous-feeling). У проді з cache hit-and-miss порядок reorder-ed.

**Підхід до виявлення:**

1. Grep усіх місць де callback prop викликає raw apiFetch:
   ```bash
   grep -B3 "apiFetch.*then.*set" apps/web/src/app --include="*.tsx" -r | grep -E "onChanged|onSaved|onSuccess|onUpdate"
   ```
2. Для кожного match — перевірити чи є ref-counter (`reqRef`/`reqId`) АБО AbortController у scope.
3. Парне з: чи `.catch(() => {})` — swallow без feedback?
4. Особлива увага до Modal components з internal CRUD: CategoryManagerModal, UoMTab у GoodsEditModal, SettingsModal, BarcodeManagerModal.

**Підхід до фіксу:**

1. Винести refetch у іменовану `useCallback` з ref-counter:
   ```ts
   const catReqRef = useRef(0);
   const reloadCategories = useCallback(() => {
     const reqId = ++catReqRef.current;
     apiFetch<Category[]>('/categories')
       .then(d => {
         if (catReqRef.current !== reqId) return;
         setCategories(d);
       })
       .catch(() => {
         /* swallow OK, errors handled by parent */
       });
   }, []);
   ```
2. Передавати `reloadCategories` у `onChanged={reloadCategories}`.
3. Якщо існує `useEffect` що теж робить початковий fetch — uniform ref-counter (`++catReqRef.current`) у обох місцях, щоб mount fetch не race-нув manager-CRUD fetch.
4. Альтернатива (cleaner): мігрувати на TanStack Query з `useQuery({queryKey, queryFn})` + `qc.invalidateQueries({queryKey})` у onChanged. TanStack обробляє race автоматично через `requestId` internal.

**Severity:** MEDIUM (UX confusion — stale data після CRUD, потрібен manual reload; не data-corruption).

**Де шукати ще:**

- Settings tabs з sub-resources (UoM, brands, suppliers) → кожен має refetch після add/remove.
- Vehicle modal з warranty/contact list → refetch після додавання.
- Counterparty modal з garages → refetch.
- Будь-який «autonomous CRUD widget» що повідомляє parent через callback.

**Профілактика:**

1. У `/sto-web` SKILL.md: «Кожен callback prop `onChanged`/`onSaved` що тригерить refetch — повинен використовувати ref-counter АБО TanStack Query invalidation; raw `apiFetch().then(setState)` без guard = bug».
2. У `/sto-review` checklist: «Modal-компонент з CRUD: чи `onChanged` callback parent-я race-guarded?»
3. ESLint custom rule: `apiFetch.*then.*set[A-Z]` всередині handler/callback без сусіднього `Ref.current` warning.
4. Документувати у JSDoc Modal-компонента: «onChanged: refetch має бути race-guarded».

---

### 2026-06-03 — Literal `[]` / `{}` як аргумент до custom hook → useEffect race у hook (Bug #328) — frontend, React hooks anti-pattern

**Сигнал:** Custom hook (`useBulkSelect(items)`, `useFiltered(query)`, `useMemoizeDeps(deps)`) приймає масив/об'єкт як аргумент І робить `useEffect(..., [arg])` всередині. Caller передає **літерал** (`[]`, `{}`, `{ status: 'X' }`) щоразу при render. Кожен render: новий референс → effect-deps вважає його зміненим → effect fires кожного render → infinite loop у dev, perf cliff у prod. Часом гірше: hook повертає state що повинен корелюватися з arg-ом, але оскільки реальні дані ніколи не передаються — hook повертає stale/empty state без видимої помилки (TS green, тест без integration green, runtime — feature мертва).

**Причина виникнення:** Композитний hook (`useListPage`) намагається інкапсулювати «все потрібне для list-сторінки» включно з `useBulkSelect`. Розробник пише `useBulkSelect<T>([])` як **placeholder** з ідеєю «caller передасть items через інший шлях». Або вважає що empty array = sane default. Compiler не попереджає бо тип `T[]` приймає літеральний `[]`. ESLint `react-hooks/exhaustive-deps` не ловить бо deps правильні (`[items]`) — проблема у тому що `items` reference нестабільний.

**Підхід до виявлення:**

1. Grep custom hooks що приймають array/object і мають useEffect:
   ```bash
   grep -rln "useEffect\|useMemo\|useCallback" apps/web/src/hooks --include="*.ts" |
     xargs grep -l "function use[A-Z]"
   ```
   Для кожного — перевірити чи hook викликається з літералом у будь-якому caller.
2. Grep callers що передають літерал як аргумент:
   ```bash
   grep -rnE "use[A-Z][a-zA-Z]+\(\[\]|use[A-Z][a-zA-Z]+\(\{\}" apps/web/src --include="*.ts" --include="*.tsx" | grep -v ".test."
   ```
3. Спеціальний red flag: composite hook (`useListPage`, `useFormState`) що НЕ приймає items/data як параметр але всередині використовує hook що потребує stable reference.

**Підхід до фіксу:**

1. Принцип: **stable reference** для будь-якого arg що йде у `useEffect/useMemo/useCallback` deps. Варіанти:
   - Caller передає `data?.items ?? STABLE_EMPTY` (де `STABLE_EMPTY = useMemo(() => [], [])` АБО module-level `Object.freeze([])`).
   - Hook приймає `items?: T[]` опційно, всередині `const safeItems = items ?? EMPTY` (де EMPTY — module-level frozen).
2. Composite hook що інкапсулює `useBulkSelect` → ОБОВ'ЯЗКОВО приймає `items` як параметр options, документує JSDoc-ом необхідність stable reference, надає `EMPTY` fallback.
3. JSDoc must-have: «Pass `data?.items ?? EMPTY` from your query hook. Inline `[]` causes effect-deps thrash».
4. Якщо hook ще не used (infrastructure-only) — теж виправити бо перший adopt = bug.

**Severity:** HIGH (потенційно blocker: infinite render loop або disconnected state). LOW якщо hook не used, але технічний борг high.

**Де шукати ще:**

- `useFiltered(items, query)` / `useGrouped(items, grouper)` / `useColumns(columns)` — будь-який hook що приймає мутабельну колекцію.
- `useForm({ defaultValues: {...} })` де `defaultValues` літерально передається кожен render.
- Custom queries: `useQuery({ queryKey: ['x'], ... })` де queryKey = inline array — TanStack Query внутрішньо порівнює по значенню, але user-side custom hook що `JSON.stringify(deps)` пропустить це.
- Props that flow into `useMemo([...deps])`: `<Component config={{ a, b }} />` створює новий `config` кожного рендера → child useMemo deps thrash.

**Профілактика:**

1. `/sto-dev` SKILL.md: додати правило «Custom hook що приймає array/object аргумент — caller ОБОВ'ЯЗКОВО передає stable reference. Каркас: module-level `EMPTY = Object.freeze([])` як fallback».
2. `/sto-review` checklist: «Composite hook (useListPage, useFormState) — каждий `useEffect([arg])` всередині має stable arg? Якщо arg — параметр, чи caller pre-stabilized?».
3. ESLint custom rule: попереджати про `useXxx([])` / `useXxx({})` у JSX/function body де hook не з white-list React core.
4. Тестово: hook з масивом-аргументом має тест «multiple renders → effect не fires more than expected».

---

### 2026-06-03 — Stale closure у useApiMutation/useCallback з eslint-disable exhaustive-deps (Bug #330) — frontend, React hooks anti-pattern

**Сигнал:** Custom hook повертає `mutate`/`save`/`submit` через `useCallback(..., [partialDeps])` з `// eslint-disable-next-line react-hooks/exhaustive-deps` бо `options` (props object з callback-ами) у deps призведе до identity churn. Дилема: **(a)** включити `options` → identity churn → downstream `useMemo([fn])` invalid → re-runs усього дерева; **(b)** exclude `options` → `mutate` тримає **stale reference** на старі `onSuccess`/`onError`. Parent ререндерить з новим `onSuccess`, `mutate` все одно викликає старий (захоплений на mount).

**Причина виникнення:** Розробник зустрічає identity churn проблему, додає `eslint-disable` як «швидкий fix». Не знає Latest-Ref pattern. ESLint disable виглядає як OK trade-off бо deps comment «mutationFn, features.toastEnabled» — все що ZAGD «варто включати». `options` про себе виглядає stable до першого parent-ререндера що генерує новий handler з cleanup logic.

**Підхід до виявлення:**

1. Grep `eslint-disable.*react-hooks/exhaustive-deps` у custom hook src:
   ```bash
   grep -rn "eslint-disable.*exhaustive-deps" apps/web/src/hooks --include="*.ts"
   ```
   Для кожного — перевірити що hook повертає callback що читає `options.onSuccess` / `props.onChange` / `callback?.()` всередині.
2. Grep `useCallback.*options\?\.\|props\?\.\|callback\?\.` всередині custom hook що НЕ у deps:
   ```bash
   grep -rnE "useCallback\(.*\b(options|props|callback)\?\." apps/web/src/hooks --include="*.ts"
   ```
3. Red flag pattern: hook приймає `options: { onSuccess?, onError? }` як другий аргумент і повертає `useCallback`.

**Підхід до фіксу: Latest-Ref pattern**

```ts
import { useRef, useEffect, useCallback } from 'react';

export function useApiMutation<T, R>(fn: (a: T) => Promise<R>, options?: Options<R>) {
  // 1. Ref що завжди має latest props/options
  const optionsRef = useRef(options);
  const fnRef = useRef(fn);
  useEffect(() => {
    // Sync кожного рендера БЕЗ deps — useEffect runs after every commit
    optionsRef.current = options;
    fnRef.current = fn;
  });

  // 2. Callback читає з ref — завжди latest, але identity stable
  const mutate = useCallback(async (args: T) => {
    const opts = optionsRef.current;
    const result = await fnRef.current(args);
    opts?.onSuccess?.(result);
    return result;
  }, []); // ✅ ПУСТІ deps — `mutate` identity stable назавжди

  return { mutate };
}
```

Регресія-guard test:

```ts
it('latest onSuccess (Bug #330)', async () => {
  const fn = vi.fn().mockResolvedValue('r');
  const v1 = vi.fn();
  const v2 = vi.fn();
  const { result, rerender } = renderHook(({ onSuccess }) => useApiMutation(fn, { onSuccess }), {
    initialProps: { onSuccess: v1 },
  });
  rerender({ onSuccess: v2 });
  await act(() => result.current.mutate(undefined));
  expect(v2).toHaveBeenCalled();
  expect(v1).not.toHaveBeenCalled();
});
```

**Severity:** MEDIUM (silent — UI продовжує працювати з найновішими handlerами здаючись). LOW якщо hook ще не consumed (infrastructure-only).

**Де шукати ще:**

- Будь-який `useMutation`/`useDebounced`/`useThrottled` wrapper з callback options.
- `useFormSubmit({ onSuccess, onError })` — той самий клас.
- `useEventListener('click', handler)` — handler через ref щоб не re-bind щоразу.
- `useInterval(callback, ms)` — класичний Dan Abramov приклад Latest-Ref pattern.

**Профілактика:**

1. `/sto-dev` SKILL.md: додати «Custom hook з callback options — використовуй Latest-Ref pattern: optionsRef + useEffect(no deps). Не disable exhaustive-deps».
2. `/sto-review` checklist: «`eslint-disable react-hooks/exhaustive-deps` у custom hook → перевірити Latest-Ref. Якщо нема — bug».
3. Регресія-test для будь-якого custom mutation hook: «latest onSuccess після rerender».

---

### 2026-06-04 — BullMQ processor без idempotency guard перед external API call (Bug #346) — backend, BullMQ

**Сигнал:** Processor з `attempts: N > 1` (offline-first retry) викликає зовнішній API (`fetch`, `axios`, Checkbox, SMS, webhook) БЕЗ перевірки чи side-effect вже відбувся (наприклад `payment.fiscalReceiptId != null`). Якщо зовнішній виклик успішний але подальший DB write (`payment.update({ fiscalReceiptId })`) падає з transient error → BullMQ ретраює → external API викликається ВДРУГЕ → дублікат side-effect.

**Причина виникнення:** Розробник фокусується на happy-path і retry-логіці (exponential backoff), але не моделює "partial success" scenario: API call OK + DB write failure. У ПРРО контексті (Checkbox) retry-count = 288 (24h) → ймовірність хоча б одного transient DB error за 24 годин при обробці > 100 платежів ненульова. Особливо небезпечно для fiscal receipts (ПРРО) та SMS: кожен дублікат = фінансові або юридичні наслідки.

**Підхід до виявлення:**

```bash
# Знайти processors що мають зовнішній fetch АБО database write АЛЕ не перевіряють pre-existing state
grep -rn "async handle" apps/api/src/modules/ --include="*.processor.ts" -l | while read f; do
  # processor has fetch / external call?
  if grep -q "fetch(\|axios\.\|nodemailer\|smsSend\|checkboxApi" "$f"; then
    # does it read own record BEFORE the external call?
    if ! grep -q "findFirst\|findUnique" "$f"; then
      echo "MISSING IDEMPOTENCY GUARD: $f — external call with no pre-check"
    fi
  fi
done

# Специфічно для Checkbox/ПРРО:
grep -rn "fiscalReceiptId" apps/api/src/modules/payments/checkbox.processor.ts | grep -v "update\|findFirst"
# Якщо нема findFirst → bug
```

**Підхід до фіксу:** На початку `handleX(job)` — прочитати запис із БД і перевірити чи "результат" вже записаний:

```ts
const existing = await this.prisma.payment.findFirst({
  where: { id: paymentId, orgId },
  select: { fiscalReceiptId: true },
});
if (!existing) return; // deleted or cross-tenant — safe to drop
if (existing.fiscalReceiptId) {
  this.logger.debug(`Already processed — skip`);
  return;
}
// ... тепер external call
```

Парний тест: `it('пропускає якщо fiscalReceiptId вже встановлено')` + `it('пропускає якщо платіж не знайдено')`.

**Severity:** MEDIUM (фінансовий / юридичний ризик при ПРРО дублікатах; LOW для SMS якщо SMS-провайдер дедупліює)

**Де шукати ще:**

- `sms.processor.ts` — чи перевіряє `notification.sentAt != null` перед відправкою?
- `followup.processor.ts` — чи пропускає counterparty що вже отримав нагадування цього циклу?
- `webhooks.processor.ts` — delivery idempotency (менш критично — webhook retry є нормою, але бажано логувати дублікати)
- Будь-який processor з `attempts > 5` і external API call — потенційний кандидат

---

### 2026-06-05 — Stable callback identity invariant у multi-page hook migration — frontend / hooks

**Сигнал:** Migration cycle послідовно: (1) утиліта вилучається у composable hook (`useListPage` повертає `resetPage = useCallback(() => setPage(1), [])`); (2) consumer code замінює inline `setPage(1)` → `resetPage()` у тілах `useCallback`/`useMemo`; (3) dep arrays оновлюються `[setPage, ...]` → `[resetPage, ...]`. Весь ланцюг працює ТІЛЬКИ якщо `resetPage` має стабільну identity (deps `[]`). Якщо хтось пізніше «виправляє» eslint warning і додає `[setPage]` deps у визначення `resetPage` — `resetPage` буде нова reference на кожному render бо `setPage` deps насправді теж stable. (React useState setter completely stable.) Це не reproduce-itься через unit test що тестує `resetPage()` поведінку (page=5 → resetPage → page=1 — OK), бо identity stability — окремий invariant.

**Причина виникнення:** Розробники довіряють react-hooks/exhaustive-deps eslint rule і додають "missing dep" автоматично. Lint попереджає про `setPage` "missing in deps" незалежно від того, що React documentation гарантує stability. Без regression-guard тесту майбутній auto-fix через eslint --fix міг би регресувати identity stability → каскадно ре-створювати applyFilter у 6 consumer pages → `<SavedFiltersBar onApply={applyFilter}>` (memoized child) re-render-ить на кожен parent re-render → інвалідує всю child-memoization оптимізацію.

**Підхід до виявлення:**

```bash
# 1. Для будь-якого composable hook що повертає stable callback — додати тест identity
grep -rn "useCallback.*\[\]\)" apps/web/src/hooks --include="*.ts" | grep -v "spec\|test"

# 2. Перевірити чи є парний test для identity (не лише behavior)
grep -rn "toBe(first" apps/web/src/hooks --include="*.test.ts" -B 2 | grep -E "rerender|identity"
# Якщо behavior test є, але identity test нема → gap

# 3. Перевірити consumers: усі useCallback що містять виклик stable-callback мають включати його у deps
grep -rln "resetPage()\|clearSelection()\|prefetch()" apps/web/src/app --include="*.tsx" | while read f; do
  # для кожного — перевірити чи відповідне ім'я є у dep arrays
  grep -E "\[.*resetPage|\[.*clearSelection|\[.*prefetch" "$f" | head -2
done
```

**Підхід до фіксу:**

1. Додати regression-guard тест у `<hook>.test.ts`:

   ```ts
   it('callbackX identity стабільна між render-ами (для useCallback deps)', () => {
     const { result, rerender } = renderHook(() => useX(...));
     const firstCb = result.current.callbackX;
     rerender();
     expect(result.current.callbackX).toBe(firstCb);
     // Also stable after state mutation
     act(() => result.current.someSetter(N));
     expect(result.current.callbackX).toBe(firstCb);
     // Also stable after own invocation
     act(() => result.current.callbackX());
     expect(result.current.callbackX).toBe(firstCb);
   });
   ```

2. У JSDoc hook-у — явно задокументувати invariant: `* @remarks resetPage has stable identity (useCallback with empty deps). Safe to put in dep arrays.`
3. ESLint comment на site definition: `// eslint-disable-next-line react-hooks/exhaustive-deps -- setPage from useState is stable by React contract` (оборона від `--fix`).

**Severity:** MEDIUM (perf regression замість CRITICAL crash, але важко діагностувати — re-renders спочатку непомітні, потім накопичуються; саме той клас багів що /sto-optimize ловить через профайлінг через 3 місяці).

**Де шукати ще:**

- Будь-який composable hook що повертає `useCallback(..., [])` для надання stable handler споживачам (`useDetailPanel`, `useBulkSelect`, `useSavedFilters`, `useColumnDrag`, `useUiFeatures`).
- Custom utility hooks що оборачують `setState` setters і повертають derived setters (`createSafeAsync`, `useStableSubmit`).
- Memoized component props що передаються у memoized children (`React.memo`, virtual list rows, table cell renderers).
- Будь-яка migration коли cycle = «вилучити утиліту → migrate consumers → оновити dep arrays»: identity stability — інваріант що тримає весь ланцюг. Без guard — будь-хто може випадково regress-ити «cleanup PR» що TS+behavior tests не покажуть.

---

### 2026-06-05 — `new Date(\`${date}T${time}:00\`)` без TZ суфіксу у frontend = local-time parsing замість Kyiv (Bug #354, #358) — frontend, time-zone, data-integrity

**Сигнал:**

- Static grep: `grep -rnE "new Date\\(.[\\\$\\\{]*[a-zA-Z_]+T[\\\$\\\{]*" apps/web/src` показує патерн `new Date('YYYY-MM-DDTHH:mm:00')` (без `Z`, без `+HH:MM`).
- Часто слідом викликається `.toISOString()` (надсилається на backend `@IsISO8601()`) АБО використовується для tickFormatter/labelFormatter у Recharts.
- Тести зелені бо `tsc` приймає синтаксис, unit-vitest запущений у TZ Node host (типово такий же як developer machine → не репродукує).
- На production WSL2 Windows installer + browser у Києві — все працює. Bug проявляється тільки у:
  1. multi-TZ deployment (SaaS demo, тестова VM у UTC),
  2. кочівні працівники з ноутбуками,
  3. CI runner Linux у UTC (E2E тести можуть або падати, або _випадково_ проходити залежно від дати).

**Причина виникнення:**

- ECMAScript: `new Date('YYYY-MM-DDTHH:mm:00')` (без `Z`/offset) парситься як **local time** через `Date.prototype.constructor` algorithm; ISO 8601 sec 3.4 → правило застосовується для time-only suffix.
- Розробник пише `${date}T${time}` для backend bridge (бо backend очікує ISO), думає що `.toISOString()` фіксить — насправді він конвертує local-time → UTC, додаючи ще одне зміщення на TZ.
- Stack Overflow «найпопулярніша» відповідь — без `Z` → саме цей патерн розмножується copy-paste.
- STO ERP має існуючий `kyivToday()` helper (DST-aware Intl), але **парного writer-helper-а** (Kyiv local string → UTC ISO) не було → розробники самі катували.

**Підхід до виявлення:**

```bash
# 1. Frontend: будь-яке конструювання Date з рядка YYYY-MM-DDTHH:MM без Z
grep -rnE "new Date\\(['\"\\`]+[\\\$\\\{0-9A-Za-z_-]+T[\\\$\\\{0-9A-Za-z:_-]+['\"\\`]+\\)" apps/web/src --include="*.ts" --include="*.tsx" | grep -v "Z'" | grep -v "+0" | grep -v "test"

# 2. Спеціально: + 'T00:00' / + 'T00:00:00' (Recharts/dashboard patterns)
grep -rnE "\\+ ['\"\\`]T[0-9]{2}:[0-9]{2}" apps/web/src

# 3. Перевірити, що toISOString() не використовується одразу після parse local-Date:
grep -rnE "new Date\\(['\"\\`][^Z]+['\"\\`]\\)\\.toISOString" apps/web/src

# 4. У спрямованому grep по календарю/планнерах/звітах:
grep -rnE "decimalHoursToISO|kyivLocalToUTC|kyivDateTimeToISO" apps/web/src
```

**Підхід до фіксу:**

1. **Створити централізовані Kyiv-TZ helpers у `apps/web/src/lib/format.ts`** (one source of truth, як `fmtMoney`/`kyivToday`):

   ```ts
   const KYIV_HOUR_FMT = new Intl.DateTimeFormat('en-CA', {
     timeZone: 'Europe/Kyiv',
     hour: '2-digit',
     hour12: false,
   });

   export function kyivOffsetMs(d: Date): number {
     const kyivHour = parseInt(KYIV_HOUR_FMT.format(d), 10);
     const utcHour = d.getUTCHours();
     return ((kyivHour - utcHour + 24) % 24) * 3_600_000;
   }

   export function kyivDateTimeToISO(date: string, time: string): string {
     const naive = new Date(`${date}T${time}:00Z`); // UTC-naive
     if (Number.isNaN(naive.getTime())) return '';
     return new Date(naive.getTime() - kyivOffsetMs(naive)).toISOString();
   }
   ```

2. **Замінити всі call-sites:** прямі `new Date(\`${d}T${t}:00\`).toISOString()`→`kyivDateTimeToISO(d, t)`.

3. **Для read-only display ticks/labels** (Recharts XAxis/Tooltip) — використовувати `new Date(d + 'T12:00:00')` (полудень UTC безпечно дає правильний день у Kyiv TZ незалежно від local TZ браузера; не може відкотитись на попередній день навіть у Asia/Tokyo).

4. **Regression-guard test** у `apps/web/src/lib/format.test.ts`:

   ```ts
   it('літо (EEST +03): 09:00 Kyiv → 06:00 UTC', () => {
     expect(kyivDateTimeToISO('2026-06-05', '09:00')).toBe('2026-06-05T06:00:00.000Z');
   });
   it('зима (EET +02): 09:00 Kyiv → 07:00 UTC', () => {
     expect(kyivDateTimeToISO('2026-01-15', '09:00')).toBe('2026-01-15T07:00:00.000Z');
   });
   it('опівночі: 00:00 Kyiv → 22:00 UTC попереднього дня (літо)', () => {
     expect(kyivDateTimeToISO('2026-06-05', '00:00')).toBe('2026-06-04T21:00:00.000Z');
   });
   ```

**Severity:** HIGH для writer-paths (POST/PATCH з startAt/endAt → silent data corruption у БД), LOW для read-only displays (UI off-by-one, не data corruption).

**Де шукати ще:**

- Frontend модулі з time pickers: `calendar/`, `booking/`, `work-orders/` (plannedAt), `maintenance-schedules/`, `inspection/` (scheduledAt).
- Reports/dashboard chart formatters: `dashboard/RevenueChart`, `reports/*Chart.tsx`, всі `tickFormatter`/`labelFormatter`.
- Будь-який `new Date(strDateOnly)` де `strDateOnly = 'YYYY-MM-DD'` без часу → parsed як midnight UTC (тут OK), але `new Date(strDateOnly + 'T00:00')` → midnight local (НЕ OK).
- Mobile Expo: ті ж патерни, бо JS Date API однаковий; мобілка ще імовірніше працює у різних TZ ніж desktop.

**Анти-патерн (НЕ робити):**

- ❌ Хардкодити `+03:00` як суфікс — порушує DST (взимку Kyiv +02). Див. `feedback_dst_kyiv.md` у `.claude/memory/`.
- ❌ Використовувати `date-fns-tz/zonedTimeToUtc` як runtime fix — додає важку залежність; одного helper-а з Intl досить.

---

### 2026-06-05 — Boolean-flag invariant (isPrimary/isDefault/isMain) без unique index у DB + service не unsets попередніх при create/update (Bug #357) — backend, business-rule, data-integrity

**Сигнал:**

- Static grep: `grep -nE "isPrimary|isDefault|isMain" packages/database/prisma/schema.prisma` показує `Boolean @default(false)` у моделі.
- Біля моделі НЕМАЄ `@@unique([orgId, isDefault])` partial index (Postgres дозволяє `WHERE isDefault = true` через raw migration, але Prisma syntax це не виражає).
- У service: `create({...dto})` / `update({...dto})` приймає `dto.isDefault === true` БЕЗ попереднього `updateMany({isDefault:true}, {isDefault:false})` всередині `$transaction`.
- Aналогічна модель з тим самим патерном АЛЕ виправлена (наприклад `WarehousesService.create` line 58-63 → `updateMany`) у тому ж codebase — лакмусова перевірка консистентності.

**Причина виникнення:**

- ER-моделювання: розробник думає «isDefault — це бізнес-marker, не constraint». DB не блокує, code не перевіряє → multiple defaults co-existing.
- Frontend toggle UX часто `<Switch>` — користувач знімає isDefault з А → перевіряє checkbox на B → POST B `{isDefault:true}`. Backend приймає, але старий isDefault на А лишається бо frontend не зробив explicit unset (або зробив, але race window).
- Часто партнерські сутності `WarehousesService` правильно реалізовано (через історію Bug #220) АЛЕ нова сутність `TaxRate` додана через інший спринт і pattern не перенесено → silent inconsistency у дзеркалі.
- Bug #351 покрив SOFT-DELETE сторону (auto-promote next sibling). Цей баг покриває CREATE/UPDATE сторону (unset previous).

**Підхід до виявлення:**

```bash
# 1. Знайти всі моделі з boolean-флагом invariant
grep -nE "isPrimary\\s+Boolean|isDefault\\s+Boolean|isMain\\s+Boolean" packages/database/prisma/schema.prisma

# 2. Для кожної моделі — перевірити чи є partial unique у migrations
for model in $(grep -B1 "isPrimary\\|isDefault\\|isMain" packages/database/prisma/schema.prisma | grep "^model " | awk '{print $2}'); do
  tbl=$(echo "$model" | sed 's/\\([A-Z]\\)/_\\L\\1/g' | sed 's/^_//')
  grep -rl "CREATE UNIQUE INDEX.*$tbl.*WHERE.*is_" packages/database/prisma/migrations/ || echo "MISSING partial unique: $model"
done

# 3. Для кожної service.create / service.update — перевірити чи робить unset previous
for f in apps/api/src/modules/**/(create|update)*.service.ts; do
  grep -L "updateMany.*isDefault.*false\\|updateMany.*isPrimary.*false\\|updateMany.*isMain.*false" "$f" \\
    && grep -l "data.*isDefault\\|data.*isPrimary\\|data.*isMain" "$f" \\
    && echo "MISSING unset: $f"
done

# 4. Symmetric check: чи є відповідний `remove() auto-promote` (Bug #351 pattern)
# (вже у §1.1 Soft Delete checklist).
```

**Підхід до фіксу:**

```ts
// service.create() для моделі з boolean-флагом
const item = dto.isDefault
  ? await this.prisma.$transaction(async tx => {
      await tx.<model>.updateMany({
        where: { orgId, isDefault: true },         // unset попередніх
        data: { isDefault: false },
      });
      return tx.<model>.create({ data: { ...dto, isDefault: true, orgId } });
    })
  : await this.prisma.<model>.create({ data: { ...dto, isDefault: false, orgId } });
```

```ts
// service.update() для моделі з boolean-флагом
if (dto.isDefault === true) {
  await this.prisma.$transaction(async tx => {
    await tx.<model>.updateMany({
      where: { orgId, isDefault: true, NOT: { id } }, // unset інших
      data: { isDefault: false },
    });
    await tx.<model>.updateMany({
      where: { id, orgId },
      data: { ...dto },
    });
  });
} else {
  await this.prisma.<model>.updateMany({ where: { id, orgId }, data: { ...dto } });
}
```

Альтернатива (рекомендовано для нових моделей з самого початку): додати у Prisma migration partial unique index:

```sql
CREATE UNIQUE INDEX "<table>_org_default_unique"
  ON "<table>" ("orgId")
  WHERE "isDefault" = true AND "deletedAt" IS NULL;
```

Тоді DB кидає P2002 → service-level guard стає defense-in-depth, не primary safety.

**Severity:** MEDIUM. Не crash, але silently broken default selection downstream — користувач створює invoice і не розуміє чому застосовується невірна ставка ПДВ. Складно відтворити при ручному тестуванні (потребує заборгованих станів БД).

**Де шукати ще:**

- `TaxRate.isDefault` — виправлено.
- `Warehouse.isMain` — `create()` правильно (через P2002 + ConflictException), `remove()` виправлено (Bug #355).
- `GoodBarcode.isPrimary` — виправлено (Bug #356).
- `CustomerGarage.isDefault` — перевірити `customer-garages.service.ts` create/update.
- `GoodUoM.isDefault` — `setDefaultUoM` правильно (line 426-427 у goods.service.ts), `deleteUoM` правильно (line 461-482).
- `PaymentMethodConfig` — якщо є isDefault — перевірити.
- `Currency.isBase` (якщо існує) — той же патерн.

**Анти-патерн:**

- ❌ Покладатись на ON CONFLICT у raw SQL — Prisma client не використовує `ON CONFLICT WHERE` syntax.
- ❌ UI-only guard (приховати toggle) — backend має бути authority. Будь-який ADMIN з валідним JWT може зробити curl PATCH і встановити multiple defaults.
- ❌ Робити unset попередніх **поза** `$transaction` з create/update — race window: між unset і create інший request може створити ще один default.

---
