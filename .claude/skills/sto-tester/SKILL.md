---
name: sto-tester
description: >
  Тестувальник STO ERP. Знаходить баги в бек- і фронт-частині, фіксує їх у BUG_REPORT.md,
  після чого автоматично виправляє кожен баг. Враховує бізнес-логіку: FSM нарядів,
  резервування запчастин, розрахунки балансів, tenant isolation, soft delete.
  Запускай командою /sto-tester після реалізації фічі або перед релізом.
model: claude-opus-4-8
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

**Визнач агрегати зі scope → читай відповідні дос'є (бізнес-правила для тест-кейсів):**

| Ключові слова у змінених файлах   | Читати                                                           |
| --------------------------------- | ---------------------------------------------------------------- |
| `work-order`, `WorkOrder`         | `docs/objects/work-order.md` (FSM transitions + side-effects)    |
| `invoice`, `Invoice`              | `docs/objects/invoice.md` (from-work-order flow, calcVatTotals)  |
| `purchase-order`, `PurchaseOrder` | `docs/objects/purchase-order.md` (receive() invariants)          |
| `stock-document`, `StockDocument` | `docs/objects/stock-document.md` (type→movement map)             |
| `counterpart`, `Counterparty`     | `docs/objects/counterparty.md` (isPrimary promote)               |
| `good`, `Good`                    | `docs/objects/good.md` (pricing hierarchy, GoodUoM guard)        |
| `work`, `Work`, `WorkCategory`    | `docs/objects/work.md`                                           |
| `calendar`, `CalendarSlot`        | `docs/objects/calendar.md` (split-day invariant, conflict check) |
| `stock-item`, `StockMovement`     | `docs/objects/inventory.md` (createMovement only)                |
| `settlement`, `transaction`       | `docs/objects/settlements.md` (createTransaction only)           |

Дос'є містять **бізнес-інваріанти** — саме їх порушення і є багами, які треба шукати.

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
- [ ] **Bug #508**: при зміні семантики denormalized поля (`totalAmount`, `amount`, `balance`, `currentMileage`) перевірити кожен share/public endpoint — чи нова формула не «протікає» туди де очікується planned/snapshot значення. Локальне обчислення з первинних компонентів у share-handler коли семантика розходиться.

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
- [ ] **Bug #619**: SUM(quantity) у reports/aggregators виключає RESERVATION/RESERVATION_RELEASE (non-physical) — інакше «нетто» містить фантоми. Grep: `grep -rn "signedByType\|quantityDelta\s*=\s*0" apps/api/src/modules/report-builder apps/api/src/modules/inventory` — набір типів має бути ідентичним; live-probe `curl POST /reports/builder/run stockMovement groupBy=[type]` → бакети RESERVATION/RESERVATION_RELEASE мають SUM=0.
- [ ] **Bug #621 (CRITICAL): Prisma `upsert` create-гілка × Postgres CHECK-констрейнт.** `upsert` компілюється у `INSERT ... VALUES(create-payload) ON CONFLICT DO UPDATE`. **Postgres перевіряє CHECK-констрейнти таблиці на INSERT-tuple ПЕРЕД арбітражем ON CONFLICT** → якщо `create.<field>` = знакова дельта (напр. `quantity: quantityDelta` де WRITEOFF дає −40), а таблиця має `CHECK (<field> >= 0)`, upsert валить `23514` (500) **НАВІТЬ коли рядок існує і DO UPDATE дав би валідне значення**. Unit-мок Prisma не б'є Postgres → CI зелений. Grep: для кожного `X.upsert({...create:{...}})` у сервісах перевірити чи будь-яке `create`-поле може бути від'ємним (increment/decrement дельта, знакова кількість) І чи таблиця має non-neg CHECK (`grep -rn "CHECK.*>= 0\|_nonneg" packages/database/prisma/migrations/`). Fix: клампити create-гілку `Math.max(0, delta)` (update-гілка лишається `{increment: delta}`) — create спрацьовує лише коли рядка нема, тоді від'ємний стан і так неможливий (pre-check відсік би). Regression-guard: unit-асерт `upsert.mock.calls[0][0].create.<field>` ≥ 0 при від'ємному dto. **ПАСТКА:** цей баг створюється САМИМ фіксом Bug #613 (додавання non-neg CHECK як backstop) — після будь-якої міграції що додає `CHECK (col >= 0)` на таблицю, ОБОВ'ЯЗКОВО live-probe КОЖЕН upsert-writer цієї таблиці з від'ємною дельтою (curl/probe, не unit). Severity CRITICAL — блокує весь клас операцій (усі WRITEOFF/TRANSFER-out/WO-COMPLETED).

#### Розрахунки

```bash
# Прямий update balance (заборонено поза SettlementsService)
grep -rn "settlementAccount\.update\|balance.*decrement\|balance.*increment" apps/api/src/modules/ --include="*.ts" | grep -v "settlements.service\|spec" | head -5
```

- [ ] Жодного прямого `prisma.settlementAccount.update({ balance })` поза `SettlementsService`
- [ ] `CHARGE` збільшує баланс; `PAYMENT/PREPAYMENT/REFUND/CREDIT_NOTE` — зменшують
- [ ] **Bug #688 (CRITICAL money): reconcile/finalize-гілка створює money-запис без `@unique`-лінку на джерело → sequential double-create.** Async-confirm money-flow (QR/gateway) з наміром: CAS→PAID, потім окремий `payments.create`, потім окремий `intent.update({paymentId})`. Три write НЕ атомарні → якщо create вдався а link-write упав, намір лишається `PAID+paymentId=null` → наступний reconcile-poll робить `create` ВДРУГЕ = double-charge (jobId single-flight не рятує — вікно послідовне). Grep: `grep -rn "reconcile\|finalize\|paymentId.*null" apps/api/src/modules/**/*.processor.ts | grep -v spec` — для кожного money-`create` у такій гілці перевірити чи є (а) `@unique` колонка-лінок на джерело у money-таблиці, (б) pre-create `findFirst({orgId,<link>})` guard, (в) P2002-recovery. Fix: `@unique` лінок (additive nullable міграція) + pre-check + P2002→relink. Test+mutation: «create-succeeds-then-link-fails» → assert no second create (вимкнути pre-guard→падає). Severity CRITICAL (тихий double-charge, без cap).
- [ ] **Bug #629: похідне money × дріб-коефіцієнт / reduce-Σ / різниця сум БЕЗ roundMoney, що покидає систему сирим (export/JSON).** Множення грошей на дріб (`Number(x) * RATIO`, напр. `LABOR_COST_RATIO=0.4` → `3520.30*0.4=1408.1200000000001`), Σ у JS-`reduce`, або різниця двох сум (`invoiced - purchases=66.77000000000001`) — гарантований/ймовірний IEEE-754 дрейф. Маскується `fmt()` на екрані, але **емітиться СИРИМ у CSV/XLSX/PDF-експорт (без fmtMoney — для XLSX number-детекту) і у JSON API-відповідь** (mobile/sync/зовнішні клієнти). Grep: `grep -rnE "Number\([^)]*\)\s*[*/]" apps/api/src/modules/{reports,completion-acts,xlsx}` + `grep -rnE "reduce\(\(s.*\+.*(amount|balance|revenue|total|cost|vat)"`. Для кожного — чи результат покидає систему (export/JSON)? Fix: `roundMoney()` на КОЖНЕ похідне money-поле (НЕ на %/count/hours). Live-guard: report endpoint з фракційними даними → `round(v*100)/100===v` для кожного money-поля. Severity LOW-MEDIUM (не stored/balance, але user-visible float у фіндокументі). Родич completion-acts PDF float (f7a935db). ⚠️ report-сервіси часто мають 0 unit-тестів → закрити test-gap разом із фіксом.

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
- [ ] **Multi-`updateMany` «exclusive mutation» у `$transaction` — orgId у КОЖНОМУ where (Bug #657):** будь-який метод що ексклюзивно перемикає стан (активним лишається лише 1) через 2+ `updateMany` у `$transaction` (напр. «вимкнути всі інші → увімкнути цей», `provider: { not: code }` + `provider: code`) МАЄ нести `orgId` (і `branchId` де застосовно) у **кожному** where-клозі, не лише у prep-`findFirst`. Prep-guard (`findFirst({ id, orgId })`) валідує branch/parent, АЛЕ самі `updateMany` фільтрують по бізнес-полю (`provider`/`type`/`isDefault`) — якщо хоч один where втратить `orgId`, mass-update зачепить рядки ЧУЖОЇ org з тим самим branchId/business-key. `@@unique([branchId, key])` НЕ рятує (updateMany не через unique). Grep: `grep -rnE "\\\$transaction\(\[" apps/api/src/modules --include="*.service.ts" -A6 | grep -A6 "updateMany"` → для кожного updateMany-у-транзакції перевірити `orgId` у where. Fix: додати `orgId` у кожен where. Regression-guard: in-memory-store spec що моделює updateMany → активація в org-1 з рядком org-2 (той самий branchId+key) → рядок org-2 НЕДОТОРКАНИЙ (обидва прапорці); плюс assert обидва where несуть orgId. Severity HIGH (cross-org data corruption на масовому write). Де ще: default-flag toggles (`setDefault*` що скидає isDefault на інших), status-exclusive switches, priority-reorder через bulk updateMany.
- [ ] **Frontend «only-one-active» toggle-тріада (Bug #657):** UI де активним може бути лише 1 із набору (провайдер/метод/стратегія) через per-item Switch МАЄ мати всі три захисти: (1) **gate** у toggle-handler — увімкнути можна лише item що вже активний-сумісний, інакше setError+return без запиту; (2) **empty-state guard** перед POST activate — якщо item не має конфігу/під-рядків (`items.some(x => x.key === code)` === false) → повідомлення «спершу налаштуйте», НЕ POST (бек ідемпотентний no-op → UI показав би хибний «активовано» + Switch відскочив); (3) **disabled-стан** — Switch активного item disabled (нема повторної/зворотної активації), Switch неактивного sub-toggle disabled коли є інший active. Всі три треба **mutation-verified** (нейтралізувати guard → тест падає, інакше fake-green). Grep: `grep -rn "activeProvider\|active[A-Z]\|isActive.*===\|only one\|лише один\|ексклюзивн" apps/web/src --include="*.tsx" -l`. Severity HIGH якщо тихий регрес порушує бізнес-інваріант (2 активні провайдери → resolveConfig змішує → неконтрольований fallback).
- [ ] **Узагальнення поля до типізованого locator + per-channel selection + структуровані креди (Bugs #658-#660):** будь-яка фіча що (а) узагальнює адресат з одного типу до багатотипного (`phone`→`recipient` де тип залежить від каналу), (б) вводить per-channel/per-item селектор `SET.has(x.channel) ? valueA : valueB`, (в) додає provider зі структурованими кредами серіалізованими JSON-ом в одне поле (`apiKey=JSON.stringify({host,port,user,pass})`) + multi-field UI-форму — потребує парних тестів на КРИТИЧНІ перехрестя. **Селектор:** тест змішаного набору `[typeA,typeB]` × `{a}`(B відкинуто)/`{b}`(A відкинуто)/`{a,b}`(обидва, **recipient КОЖНОГО кроку СВОГО типу** — SMS без `@`, EMAIL з `@`)/`{}`(job не ставиться). Mutation: замінити селектор на `a ?? b` → змішані падають (інакше телефон тече у SMTP `to` → провал усіх email). **Mask-helper:** email/короткий/порожній/no-@ входи (навіть module-private — через публічний метод що логує). **Структуровані креди (UI):** показ multi-field форми (не single-token), `credsReady`=усі обов'язкові поля, save-payload=очікуваний JSON (парсити+`toEqual`), дефолти (порожній порт→587), verify той самий JSON, негатив: інший provider лишає single-token. Mutation: зламати `buildApiKey` → save/verify падають. **Persist:** assert пишеться НОВА колонка (`recipient`), не стара (`phone`). Grep: `grep -rnE "\.has\([a-z]+\.channel\)\s*\?|JSON\.stringify\(\{[^}]*host" apps/api/src apps/web/src --include="*.ts" --include="*.tsx"`. Severity HIGH (селектор/креди), MEDIUM (mask). By-design виняток: caller що передає лише підмножину адресатів (followup лише phone→EMAIL тихо skip) — підтвердити no-crash, задокументувати як intended, НЕ «фіксити».
- [ ] **FSM transition write-path persistence для new nullable row column (Bug #236):** sprint що додає `nullable colX?: TypeX` у row-модель (`PurchaseOrderLine`/`StockDocumentLine`/`InvoiceLine`/`WorkOrderPart`) + mapping `colX: l.colX ?? null` у `toDto` → у кожному `transition(STATE)` / `receive()` / `applyPricing()` / FSM-обчислювальному методі, де обчислюється resolved value (наприклад `lineUnitId = good.unitId`) і пропагується у side-effect resource (`inventory.createMovement(colX: lineUnitId)`/`stockMovement.create({ colX })`), ОБОВ'ЯЗКОВО має бути парний `tx.<rowTable>.update({ where: { id: line.id }, data: { colX: resolvedValue } })` для самого row, всередині $transaction. Інакше `findOne(id).lines[i].colX === null` назавжди → cross-resource inconsistency: history (movements) має X, current state (line) має NULL → audit/sync/export ламається. Symmetric-write для Bug #232 (read-side missing include). Grep: `grep -rnE "[a-z]*Id:\s*l\.[a-z]*Id\s*\?\?\s*null" apps/api/src/modules --include="*.service.ts"` → для кожного match у відповідному `transition()`/`receive()`/`applyPricing()` шукати `tx.<row>.update.*data.*colX`. Severity HIGH (silent data integrity)
- [ ] **BullMQ processor idempotency guard (Bug #346):** кожен `@Process({ name: 'X', concurrency: N })` з external API call (`fetch`, `axios`, SMS, ПРРО/Checkbox) ТА `attempts > 1` ОБОВ'ЯЗКОВО читає відповідний DB-запис ПЕРЕД external call і перевіряє результат вже записаний (`fiscalReceiptId`, `sentAt`, `deliveredAt`). Без guard: transient DB error після успішного зовнішнього виклику → BullMQ retry → дублікат side-effect (2 фіскальних чеки, 2 SMS). Grep: `grep -rn "async handle" apps/api/src/modules/ --include="*.processor.ts" -l | while read f; do grep -q "fetch(\|axios\." "$f" && ! grep -q "findFirst\|findUnique" "$f" && echo "MISSING: $f"; done`. Регресія-guard: spec `it('пропускає якщо result-field вже встановлено')` + `it('пропускає якщо запис не знайдено')`. Severity: MEDIUM для ПРРО (fiscal compliance risk); LOW для webhook retry (acceptable by protocol).

- [ ] **Dead-feature integration audit (Bugs #267, #268):** для КОЖНОГО `@Injectable` сервісу з queue/processor companion (`@nestjs/bull`, `@Processor`, `@InjectQueue`) — перевірити чи real callsite викликає його з payments/invoices/work-orders/settlements flow. Grep: `grep -rl "InjectQueue\|@Processor" apps/api/src/modules --include="*.ts"` → для кожного service-метода: `grep -rln "\.<method>(" apps/api/src --include="*.ts" | grep -v "spec\|<own-module>"` → якщо count=0 → bug. Парний сигнал: UI tab/sidebar/settings для фічі АЛЕ нема telemetry/trigger. Severity HIGH якщо feature розрекламована користувачу (`loyalty.queueEarn` ніколи не викликається з payments → бали не нараховуються); MEDIUM якщо admin/internal (`batch.consumeBatch` ніколи з inventory WRITEOFF → cost-method не застосовується). Фікс: додати виклик у trigger service (з `.catch(warn)` для non-blocking) + import відповідного Module у trigger Module + DI injection

- [ ] **Hardcoded document-number у auto-create обхід DocumentNumberService (Bug #348):** будь-який `tx.<Model>.create({ data: { number: '<literal>', ... } })` де `<Model>` має згадку у `DocumentNumberConfig` seed (`WORK_ORDER`, `INVOICE`, `PURCHASE_ORDER`, `STOCK_RECEIPT`, `COUNTERPARTY_AGREEMENT`...) — bug. Auto-create-flow (наприклад `service.create()` контрагента → авто-PURCHASE контракт) повинен використовувати ту саму систему нумерації що і ручний UI-flow (`createContract` через `documentNumberService.next()`), інакше monotonic-нумерація документів порушена. Grep: `grep -rnE "tx\.[a-z]+\.create\(\s*\{\s*data:\s*\{[^}]*\bnumber:\s*['\"]" apps/api/src/modules --include="*.service.ts"` — кожен literal-number у data-spread = bug. Виклик `documentNumberService.next()` робити ПЕРЕД `$transaction` (next() сам відкриває власний $tx з SELECT FOR UPDATE — nesting deadlock). Severity HIGH (feature розрекламована як «автоматично створюється документ», порядок номерів inconsistent).

- [ ] **Soft-delete primary без auto-promote next sibling (Bug #351):** для КОЖНОЇ моделі з `isPrimary Boolean` / `isDefault Boolean` / `isMain Boolean` полем — `service.remove()` ОБОВ'ЯЗКОВО має auto-promote next sibling. Pattern: `(1) SELECT existing { id, isPrimary, <scopeFields> }`; `(2) $transaction: soft-delete X; if (existing.isPrimary) findFirst({<scope>, deletedAt:null, id:{not:id}}, orderBy:{createdAt:'asc'}) → update({isPrimary:true})`. Без promote: bizнес-інваріант «у scope завжди ≥1 primary якщо існують активні рядки» силентнo порушений. Downstream auto-selection logic (PO/WO create без contractId → findFirst orderBy isPrimary desc → випадковий non-primary) повертає неправильні значення. Grep: `grep -rnE "isPrimary\s+Boolean|isDefault\s+Boolean|isMain\s+Boolean" packages/database/prisma/schema.prisma | awk '{print $1}'` — для кожної моделі знайти `<module>.service.ts` `remove()`/`deleteX()` і перевірити наявність findFirst+update після soft-delete. Severity HIGH. Парне з Bug #226-#227 (frontend-side): backend може правильно promote, але frontend з optimistic-filter не знає → теж потребує refetch.

- [ ] **Soft string FK без validation (Bug #361):** будь-який DTO field що зберігається у Prisma як plain `String`/`String @db.VarChar(N)` АЛЕ концептуально посилається на іншу таблицю (`currencyCode → Currency.code`, `paymentMethodCode → PaymentMethodConfig.code`, `eventType → NotificationTemplate.eventType`, etc.) — service ОБОВ'ЯЗКОВО валідує існування через `findFirst({ orgId, <field>: dto.X, deletedAt: null })` перед persist. Без guard API дозволяє `currencyCode: 'XYZ'` → DB корумпована (no FK constraint enforces existence) → UI рендерить garbage (`1 000.00 XYZ`), downstream FX/notification lookups silent-skip або throw. Парний guard має існувати у БОТКИ `create` І `update` paths (PATCH-only attack vector іначе). Grep: `grep -rnE "String\s*$|String\s+@db\.VarChar" packages/database/prisma/schema.prisma | grep -iE "code|type|status"` → для кожного знайденого field перевірити service. Severity HIGH. Регресія-guard: contract spec кейс `POST .../<resource> { code: 'INVALID' } → 400`.

- [ ] **Auto-create child resource ignores parent settings inheritance (Bug #360):** для КОЖНОГО `tx.<ChildModel>.create()` всередині parent `service.create()`/`$transaction` — перевірити чи child default-values відповідають parent-level settings, які user міг налаштувати. Приклад: `OrganisationSettings.currency='USD'` → `auto-create CounterpartyContract.currencyCode` має використати 'USD' (не hardcoded 'UAH'). Інші risk-spots: `BranchSettings.slotDurationMinutes` → auto-Slot create, `OrgSettings.invoiceDueDays` → auto-Invoice create. Grep: `grep -rnE "tx\.[a-z]+\.create\(\s*\{\s*data:\s*\{[^}]*\b(currencyCode|currency|paymentDeferDays|warrantyDays|slotDurationMinutes):" apps/api/src/modules --include="*.service.ts"` — кожен hardcoded value у data поза параметром = potential bug. Fix-pattern: fetch `prisma.organisationSettings.findUnique({ where: { orgId }, select: { <fields> }})` ПЕРЕД `$transaction` (паралельно з documentNumberService.next через Promise.all для -1 RTT), передати у tx.create.data. Severity HIGH (порушує задекларовану інваріант UX-tooltip типу «Використовується за замовчуванням у договорах і звітах», silent inconsistency).

- [ ] **Case-sensitive lookup vs canonical-form seed data (Bug #359):** для КОЖНОГО `findFirst({ where: { code: dto.X } })` або `where: { eventType: dto.Y }` або `where: { documentType: dto.Z }` де target field зберігається у канонічній формі (UPPERCASE ISO code, snake_case event type) — DTO ОБОВ'ЯЗКОВО має `@Transform(toUpperCurrencyCode)` / `@Transform(toLowerCase)` / etc. до `@IsString`. Postgres VARCHAR/TEXT case-sensitive за замовчуванням → користувач набирає `uah` у fallback Input → backend lookup `code: 'uah'` не знаходить `'UAH'` → 400 з валідним кодом. Парний UI-fix: `<Input onChange={e => set(e.target.value.toUpperCase())} maxLength={N}>` у fallback inputs (коли dropdown reference data не завантажилось через offline-first). Grep: `grep -rnE "findFirst\(\s*\{\s*where:\s*\{[^}]*\b(code|type|status):\s*dto\." apps/api/src/modules --include="*.service.ts"` → перевірити що DTO field має нормалізацію transform. Severity HIGH (UX): валідний код → 400 → користувач думає «зламано».

- [ ] **Нове enum value без regression-guard у contract+service spec (Bugs #478-#480):** будь-який commit вигляду `feat(<scope>): add <NEW_VALUE> to <Enum>` що змінює (а) Prisma schema enum + migration `ALTER TYPE ... ADD VALUE`, (б) `@IsEnum([...])` whitelist у Create/Query DTO, (в) backend service maps (`MOVEMENT_TYPES[NEW]`, `docTypeMap[NEW]`), (г) frontend hardcoded array — ОБОВ'ЯЗКОВО має парні regression-тести для нового значення у `*.contract.spec.ts` І `*.service.spec.ts`. Grep: `grep -rn "<NEW_VALUE>" apps/api/src/modules/<scope>/ --include="*.spec.ts"` — 0 matches = bug. Мінімальний набір regression-guards: (1) POST з `type: NEW_VALUE` → 201 + service отримує dto.type=NEW_VALUE; (2) GET з `?type=NEW_VALUE` → 200 + service.findAll отримує NEW_VALUE; (3) `transition(NEW-doc, CONFIRMED)` (або equivalent FSM-step) → асерти на map-резолв (`docNumbers.next(orgId, PARENT_DOC_TYPE)`, `inventory.createMovement type=StockMovementType.NEW`), branch logic (`toHaveBeenCalledTimes(1)` — не як TRANSFER з двома), sign quantity (`.toBeGreaterThan(0)`). Якщо service spec ВЗАГАЛІ нема — створити новий (як `stock-documents.service.spec.ts` у f59c6a47). Без guards: refactor що видаляє `NEW: StockMovementType.NEW` з MOVEMENT_TYPES або додає `NEW` у TRANSFER-branch проходить CI зеленим, runtime отримує 400/«Непідтримуваний тип документу». Severity HIGH. Where else: `WorkOrderStatus`, `InvoiceStatus`, `PurchaseOrderStatus`, `StockMovementType`, `DocumentType`, `PaymentMethod`, `CounterpartyType`, `EmployeeRole`, будь-який backend service з `switch (type)` або `Record<EnumType, X>` map.

- [ ] **Shared FE constant без парної backend константи (Bug #432):** будь-який commit що додає `export const <NAME>_STATUSES`/`<NAME>_TRANSITIONS` у `packages/shared/src/constants/*.ts` І оновлює FE-компоненти щоб використати її, ПОВИНЕН паралельно мати backend константу у `apps/api/src/modules/<entity>/<entity>.fsm.ts` (або `*.constants.ts`). Backend service-файл НЕ має містити inline `['LITERAL_A', 'LITERAL_B']` що дублює значення shared константи — інакше FE = single source of truth (порушує SKILL §1.3 Bug #401 принцип «BE — single source, FE — mirror»). Grep: для кожного нового shared `<NAME>_STATUSES` literal-array → `grep -rnE "'<literal-A>', '<literal-B>'" apps/api/src --include="*.ts" | grep -v spec` → matches = bug. Особливо CRITICAL коли whitelist гейтить financial/legal ops (invoice creation, completion-act). Парне з Bug #401 (FE↔BE status whitelist symmetry — там FE асиметричний за подію; тут структурна gap до first-class const). Регресія-guard: spec у `*.fsm.spec.ts` `expect(BE_STATUSES.sort()).toEqual([...FE_STATUSES].sort())`. Severity HIGH. Where else: будь-який модуль з FSM/gate-whitelist (PO, Invoice, StockDocument, CompletionAct, Calendar slots).
- [ ] **Audit-track list ↔ update.data symmetry (Bug #433, family Bug #421):** для КОЖНОГО `service.update()` що має `auditService.record(...)` поряд з `prisma.X.update({ data: { ...fields } })` — keys у audit-track array (`['fieldA', 'fieldB', ...] as const).forEach(trackField)` ⊇ keys у data-payload. Якщо data пише поле що НЕМАЄ у audit-list → AuditEvent.diff силенто порожній для цього поля → compliance/bookkeeping gap. Особливо ризиково для FK (`liftId`, `branchId`, `contractId`), документ-дат, фінансових сум. Свіжий `fix(tester): Bug #N audit gap` commit означає що один specific field виправили, але **уся сімʼя fields у тому ж update()** залишилась підозрілою — split-fix pattern. Grep: ручний audit для кожного service.update() з audit-list — diff data-keys vs audit-keys; будь-який diff > 0 = bug. Регресія-guard: spec `it('update() diff включає <new field> якщо у dto')`. Severity HIGH (audit-trail). Where else: усі `*.service.ts` що мають update + auditService — особливо ті що нещодавно мали додавання нового поля.
- [ ] **Cross-endpoint status-filter inconsistency для одного resource (Bug #415):** для КОЖНОГО resource з status-enum (`Invoice.status`, `WorkOrder.status`, `Payment.status`) — звірити status filtering між усіма ендпоінтами що оперують одним resource. Типова асиметрія: `findByX(parentId)` має `status: { not: 'CANCELLED' }`, але `getLinkedY(parentId)` / `getCountsZ(parentIds)` — БЕЗ status фільтра. Result: badge count показує "2 invoices" коли активний 1 (другий CANCELLED), користувач відкриває панель → бачить мертвий запис → confused UX. Pre-check `createFromX` тоді блокує "вже існує", але badge показав 2 — користувач сприймає як bug. Grep: для кожного `prisma.<model>.find*/count/groupBy` query — перевірити чи `where.status` уніфікований через усі service-методи того ж модуля. Якщо `findByWorkOrder` exclude CANCELLED АЛЕ `getLinked*/`/getCounts` include — bug. Imp: import enum (`InvoiceStatus`) з `@prisma/client`замість string literal`'CANCELLED'` — TS catches typo + renaming. Severity LOW (UX inconsistency); MEDIUM коли inconsistency caused decision-making error. Регресія-guard: contract spec кейс «WO має 1 CANCELLED + 1 DRAFT → counts.X===1». Парне з Bug #401 (FE↔BE status whitelist symmetry — той самий принцип, інший рівень).
- [ ] **Concurrent-create race for "1 active per parent" resources без unique index (Bug #412):** будь-який service-метод що створює дочірній resource з логіко-унікальним FK (`Invoice.workOrderId`, `FiscalReceipt.paymentId`, `InspectionReport.workOrderId`) використовуючи pattern `find existing → if (existing) throw → create` БЕЗ обгортки у `$transaction({ isolationLevel: 'Serializable' })` АБО без `@@unique` partial-index на FK = race-window для дублікатів. Два паралельних POST (double-click через UI lag, два tab-и, два admin) обидва бачать `existing === null` між findFirst і create → 2 invoice створено з тим самим `workOrderId`. Grep: `grep -rnE "async (create|createFrom|issueFor|generateFor)[A-Z]" apps/api/src/modules --include="*.service.ts"` → для кожного знайти `findFirst({ <fkField>: id })` prep-check ПЕРЕД `create()` → перевірити schema.prisma на парний `@@unique([<fkField>])` АБО Serializable $tx. Fix-pattern: pre-fetch `docNumbers.next()` (свій внутрішній $tx), потім обернути read+create у Serializable з re-check existing всередині; map P2034 → friendly BadRequestException. `DocumentNumberService.next()` серіалізує лише ПО docType, НЕ по parent FK — не достатньо для invariant "1 active per parent". Severity HIGH (фінансовий ризик). Регресія-guard: service spec з 2-3 кейсами (existing у pre-check → 400, status guard → 400, non-existent WO → 404).
- [ ] **Inner $tx re-check тест для Serializable race fix (Bug #416, paired with #412):** для КОЖНОГО service-метода з Bug #412 фіксом (`$transaction({ isolationLevel: 'Serializable' })` з inner `tx.X.findFirst` re-check) — парний `*.spec.ts` має ОКРЕМИЙ test з `mockResolvedValueOnce(null).mockResolvedValueOnce({id})` sequence + `expect(prisma.X.create).not.toHaveBeenCalled()`. Без цього тесту видалення `const existing = await tx.X.findFirst(...); if (existing) throw ...` блоку у refactor (типовий "цей блок дублює pre-check вище") пройде CI зеленим — CRITICAL race window повертається. Grep: для кожного `$transaction.*Serializable` у service.ts → у парному `.spec.ts` шукати `mockResolvedValueOnce` для того ж `findFirst` ДВА рази підряд. Якщо тільки один `mockResolvedValue` (constant) → gap. Severity MEDIUM (regression risk для CRITICAL fix). Ключовий assert: `expect(prisma.<resource>.create).not.toHaveBeenCalled()` — інакше тест-зелений-проходить навіть при видаленні re-check (бо pre-check теж кидає з тим же moc-setup).

- [ ] **`Partial<Record<Enum, V>>` lookup map з runtime fallthrough (Bug #488):** будь-який `Partial<Record<<EnumType>, V>>` у service-методі для look-up знаку/типу/factor (BALANCE_SIGN, MOVEMENT_FACTOR, TAX_RATE) — потенційний gap у TS-exhaustiveness. `Partial<>` дозволяє додавання нового enum value через Prisma migration `ALTER TYPE ... ADD VALUE` БЕЗ compile-error → runtime throw у проді коли новий тип потрапляє до lookup. Grep: `grep -rnE "Partial<Record<[A-Z][a-zA-Z]+(Type|Status|Role|Kind),\s" apps/api/src/modules --include="*.ts" | grep -v spec`. Якщо ВСІ enum values уже у map → `Partial<>` непотрібно (видалити + видалити runtime guard). Якщо проєктно потрібен partial — задокументувати inline + додати regression-guard для default-branch. Парне з Bug #478-#480 (enum coverage у contract+service spec). Severity MEDIUM (release-blocker якщо gating financial operation: settlement/payment/tax).

- [ ] **Alternate-mutation endpoint обходить canonical guards (Bug #403):** будь-який backend service-метод що **мутує той самий resource** що і `update()`/`addLine()`/`removeLine()` АЛЕ зі своєю окремою сигнатурою (`refreshFromWorkOrder`/`syncFromX`/`importFromY`/`recalculateZ`/`refreshFromExternalSource`...) — ПОВИНЕН повторити ВСІ business-guards канонічного `update()`. Типові guards що пропускаються: (а) `if (X.status !== 'DRAFT') throw BadRequestException` (FSM-readonly для submitted/paid/sent статусів); (б) `if (existing.isLocked) throw ...` (manually locked records); (в) `if (existing.isSystem) throw ...` (seed-керовані); (г) prep-check unique-constraint конфлікту. Сценарій: оригінальний `update()` має FSM-guard `!DRAFT → throw`; альтернативний endpoint забуває цей guard → перезаписує дані SENT/PAID/locked record-у без error → silently corrupts data. Grep: `grep -rnE "async (refresh|sync|import|recalculate|regenerate|rebuild)[A-Z]" apps/api/src/modules --include="*.service.ts"` — для кожного знайденого метода: знайти canonical `update()`/`updateLine()`/`updateX()` у тому ж файлі, скопіювати ВСІ `if (...) throw` guards (особливо `inv.status !== 'DRAFT'`, `existing.status !== ...`), перевірити що alternate-метод їх має. Парний підхід: будь-який mutation що приймає workOrderId/parentId і робить `deleteMany + createMany` на child resource (full overwrite) — обов'язково prep-check status батьківського resource через `if (parent.status !== <ALLOWED>) throw`. Severity CRITICAL (фінансовий ризик для invoice/payment/settlement resources). Регресія-guard: contract spec для alternate endpoint що мокає existing.status=non-DRAFT → 400.

- [ ] **DB-constraint error-mapping guard у canonical write, відсутній у alternate-mutation endpoint (Bug #628):** підклас #403 для ERROR-conversion (не business-guard). Будь-який `throwIfExclusionConflict`/`throwIfSerializationConflict`/`mapPrismaError`-try/catch навколо `$transaction` у canonical `createX()`/`updateX()` МАЄ бути повторений у КОЖНОМУ alternate-мутуючому методі того ж resource (`syncFromX`/`refreshFromY`/`bulk*`/`by-work-order`), інакше concurrent race що обійшов app-probe → raw SQLSTATE → generic 500 замість 4xx. ПАСТКА: EXCLUDE/CHECK-констрейнти перевіряються і на **UPDATE**, не лише INSERT (доводиться live: `update({data:<overlap>})` → 23P01) — тож alternate-метод що лише робить `updateMany({startAt,endAt})` вразливий так само як create. Grep: `grep -rn "throwIfExclusionConflict\|throwIfSerializationConflict" apps/api/src/modules/<mod>/*.service.ts` → порахувати сайти; для кожного alternate-write (`return this.prisma.$transaction` БЕЗ try) — gap. Fix: `let result: T; try { result = await $transaction(...) } catch(err){ throwIfX(err,...) } return result` (throwIfX:never → tsc бачить definite-assign). Регресія-guard: (1) `$transaction` mock кидає SQLSTATE-shaped Error → `rejects ConflictException/BadRequestException`; (2) не-constraint error → пробрасується as-is. Severity MEDIUM (цілісність тримається — constraint фізично блокує; лише 500→4xx UX/observability + Sentry-шум). Where else: CalendarSlot (createSlot/updateSlot/syncWorkOrderSlots × EXCLUDE), StockItem (× `stock_*_nonneg` CHECK), balance-writers, будь-який `@@unique` partial index з кількома write-шляхами.

- [ ] **Concurrent pre-check → write без row-lock або conditional-decrement (Bug #613):** будь-який service-метод що робить `findFirst({ select: { counter }}) → GUARD → upsert/update({ counter: { increment/decrement }})` у $transaction БЕЗ явного `isolationLevel: 'Serializable'` — race window: 2 concurrent tx проходять guard на stale snapshot, Postgres row-lock UPDATE серіалізує тільки сам запис → другий залишає counter НЕГАТИВНИМ (немає DB CHECK constraint). Grep: `grep -rn "isolationLevel|Serializable" apps/api/src/modules/<hot-path>` = 0 matches. Fix 2-layer: (Layer 1) `.select({counter})` у upsert + post-check `if (upserted.counter < 0) throw` (rollback у $tx); (Layer 2) `X.update({data:{field:{decrement:n}}})` → `X.updateMany({where:{id, field:{gte:n}}, data:{...}})` — Postgres atomic CHECK+DECREMENT, count=0 → throw. Regression-guards: (а) service.spec `mockResolvedValueOnce({quantity:-10}) → throw`; (б) service.spec `mockResolvedValueOnce({count:0}) → throw`; (в) invariants.spec property-based `2 concurrent → totalConsumed <= initial ∀ (initial, take)`. Severity: HIGH коли інваріант фінансовий (quantity/balance/reserved); MEDIUM для non-critical counters. Where else: `settlementAccount.balance`, `cashRegister.balance`, `bankAccount.balance`, `deliveryOrder.receivedQty`, `purchaseOrder.paidAmount` — будь-який `findFirst → upsert/update({increment/decrement})` у Read Committed.

- [ ] **Role-gated sensitive DTO field без regression-guard spec (Bug #527, #529):** будь-який commit вигляду `fix/feat: role-gate <Field>` що додає (а) `<X>_VISIBLE_ROLES = new Set<string>(['OWNER', ...])`, (б) helper `canSeeX(role)`, (в) `userRole?: string` параметр у service-метод(и) — ОБОВ'ЯЗКОВО має парний `*.role-gate.spec.ts` (новий або існуючий) з матрицею: (1) кожна привілейована роль × значення поля → візібл, (2) кожна непривілейована роль (включно з `MECHANIC`, `RECEPTIONIST`, `CLIENT`) → undefined, (3) edge `userRole === undefined` → fail-closed, (4) edge `userRole === ''` → fail-closed, (5) невідома роль (`'GUEST'`/`'PARTNER'`) → fail-closed, (6) lowercase (`'owner'`) → fail-closed (case-sensitive Set lookup), (7) `<Field> === null` для привілейованої → `null` (не `undefined`!) — semantic distinction "доступ є, але value not set" vs "нема доступу". Плюс: ВСІ mutation endpoint що повертають DTO (`addX`, `updateX`, не тільки `findOne`) приймають userRole і передають у toDto — інакше OWNER не побачить поле одразу після створення (refresh потрібен) АБО refactor що видалить fail-closed default витече для не-привілейованих write-ролей (`RECEPTIONIST` у write-allow для add/updatePart, але НЕ в COST_PRICE_VISIBLE_ROLES). Grep: `grep -rnE "(VISIBLE_ROLES|canSee[A-Z])" apps/api/src --include="*.ts" | grep -v "spec\|test"` → для кожного matched: `grep -rn "<sameName>" apps/api/src --include="*.spec.ts"` → нуль matches = HIGH (release-blocker для §2.1 Auth). Парне з Bug #478-#480 (enum coverage). Where else: будь-яке поле з prefix `cost*`/`purchase*`/`internal*`/`audit*`/`private*`/`secret*`/`bankAccount`/`taxId`/`salary`/`margin` у DTO.

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
- [ ] **DocumentType enum + INSERT backfill парність (Bug #533)** — будь-який commit що додає нове значення у Prisma enum `DocumentType` (`'GOOD_INTERNAL_CODE'`, `'COMPLETION_ACT'`, `'STOCK_TRANSFER'` etc.) + має парний `documentNumberService.next(orgId, '<NEW_VALUE>')` виклик у service — ОБОВ'ЯЗКОВО мусить мати парну backfill-міграцію з `INSERT INTO document_number_configs SELECT ... FROM organisations o WHERE NOT EXISTS (...)`. Інакше: `seed.ts:docConfigs[]` оновлюється (свіжі orgs OK), але **існуючі orgs** не отримують конфіг → `POST /<resource>` падає з `NotFoundException('Конфігурацію нумерації для "<NEW_VALUE>" не знайдено')` → CRITICAL release-blocker (фіча мертва у проді). Pattern: окрема migration з timestamp на 1 секунду пізніше (бо Postgres забороняє INSERT з новим enum value у тій самій транзакції що `ALTER TYPE`). Прецеденти: `20260615120100_seed_supplier_return_doc_numbers`, `20260619140001_seed_good_internal_code_doc_numbers`. Grep: `git diff schema.prisma | grep -E "^\+\s+[A-Z_]+$" | wc -l` (нові enum values) → перевірити кожне у `packages/database/prisma/migrations/*/migration.sql` `INSERT INTO document_number_configs`. Severity CRITICAL.
- [ ] **Constructor DI drift у \*.service.spec.ts (Bug #534, #536)** — будь-який commit що додає `private readonly newDep: NewService` у `@Injectable()` сервіс constructor → ОБОВ'ЯЗКОВО оновити ВСІ `*.service.spec.ts` файли цього модуля: (а) для `Test.createTestingModule` specs — додати `{ provide: NewService, useValue: mockObj }` у providers (mockObj повинен мокати методи що сервіс реально викликає — `vi.fn().mockResolvedValue(safeDefault)` для side-effects, не порожній `{}` що дасть `null.method` runtime); (б) для **positional-arg** specs (`new XService(prisma, null as never, ...)`) — найти позицію new dep, замінити відповідний `null as never` на mock obj, додати named comment до кожного arg `null as never, // inventory`. Без цього 100% тестів модуля падає у baseline (DI throw на compile()) → release-blocker. Pre-existing test rot накопичується якщо це проґавити (у нашій сесії — 55 тестів падали з 5 червня). Grep: `for f in $(git diff HEAD~5 HEAD --name-only -- 'apps/api/src/modules/**/*.service.ts' | grep -v spec); do git diff HEAD~5 HEAD -- "$f" | grep "^+.*private readonly.*Service$" && echo "$f changed constructor — verify $f.spec.ts"; done`. Pre-commit hook: `pnpm --filter @sto/api test --run | grep "Tests.*failed"` — будь-який failure = release-blocker. Severity CRITICAL для нових feature, HIGH для pre-existing test rot.

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
- [ ] **Remove-guard «блокувати якщо є пов'язані активні документи» — повнота набору relations (Bug #631):** будь-який `service.remove()`/`delete()` що додає guard типу «не видаляти якщо є активні наряди/замовлення/борг» — звірити ПОВНИЙ перелік document-relations сутності (schema `X[]` back-relations) проти списку `count()`-перевірок у guard. Частий split-coverage: перевіряють 2 з 3 однотипних document-relations. **Пастка balance-як-proxy:** SENT/OVERDUE/фінальні документи, що вже створили settlement-транзакцію, ловляться balance-guard-ом (`Number(balance)!==0`) непрямо → здається «покрито», АЛЕ DRAFT/чернетка того ж документа ще НЕ має транзакції → `balance=0` → провалюється крізь усі guard-и → осиротілий активний документ на soft-deleted parent. Grep: для кожного `count()` у `remove()` знайти всі `model X { ...  <Rel>[]  ...}` back-relations parent-моделі у schema (`sed -n '/^model Counterparty /,/^}/p' schema.prisma | grep -E "\[\]"`) → кожен document-подібний relation (WorkOrder/Invoice/PurchaseOrder/StockDocument) має власний count-guard з `status: { notIn: [<фінальні>] }`, НЕ покладатись на balance. Append-only (Payment/StockMovement) — не блокують. Fix: додати відсутній `count()` у той самий `Promise.all`, симетрично наявним. Severity MEDIUM (data-integrity + orphan-UX). Where else: `Counterparty.remove` (WO+PO+Invoice), `Vehicle.remove` (пов'язані WO), `Good.remove` (StockItem залишки), `Warehouse.remove` (StockItem), будь-який parent з kількома document-children.

- [ ] **count/detail консистентність за soft-delete (Bug #641):** будь-яка пара «summary-badge count» + «detail-list» на ті самі зв'язки (класика: `getLinkedCounts` vs `getLinkedDocuments`) — count МУСИТЬ мати ідентичний WHERE до detail. Пастка: count зроблено дешево через `row.fkId ? 1 : 0` (лічить наявність FK-скаляра з батька), а detail тягне referenced-запис з `deletedAt: null` → коли referenced soft-deleted, а FK лишився, badge показує «1» над порожньою секцією. Досяжно, якщо delete-guard referenced-сутності блокує лише за відкритими документами (контрагента можна видалити під PAID-рахунком / RECEIVED-PO). Grep: `grep -rnE "\.[a-zA-Z]*Id \? 1 : 0" apps/api/src/modules/**/*.service.ts | grep -iE "count"` → кожен такий лічильник перехресно з detail-методом: чи фільтрує detail referenced по `deletedAt:null`? Fix: зібрати унікальні FK, одним `findMany({id:{in},orgId,deletedAt:null})` на тип дістати живий набір, зарахувати «1» лише якщо `liveSet.has(fkId)` (батч, без N+1). Тести: soft-deleted ref→count=0 (дискримінатор), duplicate ids (keyed by id), cross-org (нулі), zero-count id (present у мапі). Severity MEDIUM. Where else: `_count` у list-DTO vs include у detail; лічильники активних договорів/гаражів/авто; dashboard-плитки з іншим WHERE ніж сторінка.

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
- [ ] **date-only `@Query('dateTo')` → `lte` МУСИТЬ бути inclusive-of-day (Bug #678):** фронт шле `YYYY-MM-DD`; `new Date('2026-09-06')`=midnight UTC → голий `createdAt.lte = new Date(dateTo)` виключає всі записи того ж дня. Правильно `new Date(dateTo + 'T23:59:59.999Z')` (+ `dateFrom + 'T00:00:00.000Z'`). Grep: `grep -rn "lte.*new Date(.*dateTo\|lte.*new Date(opts" apps/api/src/modules/ | grep -v "T23:59:59"`. Тест: `findMany.mock.calls[0][0].where.createdAt.lte.toISOString()==='...T23:59:59.999Z'`.
- [ ] **query-string enum-фільтр → `Set(Object.values(Enum)).has()` guard ПЕРЕД `as EnumType` (Bug #679):** `where.x = opts.x as EnumType` без валідації → `?x=garbage` доходить до Prisma → HTTP **500** (не-i18n). Правильно: enum-driven Set + `if (VALUES.has(opts.x)) where.x=...`, невідоме тихо ігнорується. Grep (з `-B1` бо guard часто на рядку вище присвоєння): `grep -rn -B1 "where\.\w* = opts\.\w* as \|as Prisma\.\w*WhereInput\['" apps/api/src/modules/ --include="*.service.ts"` → для КОЖНОГО match переконатись що рядок вище/поруч має `.has(` / `Object.values(` / `VALUES`; match без жодного guard-контексту = баг. Тест: garbage→`'x' in where===false` + `resolves` (no 500).
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
- [ ] **Fastify request-parse помилка не мапиться у catch-all filter → 500 замість 4xx (Bug #627):** будь-який bodyless POST/PATCH-ендпоінт (`/transition`, `/restore`, `/clone`, `/confirm`, `/cancel`, `/refresh`, `/set-default` — без `@Body`) при виклику з `Content-Type: application/json` + порожнім тілом дає **500 «Внутрішня помилка сервера»** (не 4xx), бо Fastify content-type-parser кидає `FastifyError` (code `FST_ERR_CTP_EMPTY_JSON_BODY`/`FST_ERR_CTP_INVALID_JSON_BODY`) ДО хендлера — вона НЕ `HttpException` і НЕ `PrismaClientKnownRequestError` → провалюється у `else`-гілку `HttpExceptionFilter` (500 + Sentry). Grep: `grep -rn "FST_ERR\|isFastify" apps/api/src/common/filters` — 0 matches = gap. Live-probe: `curl -X POST <bodyless-url> -H "Content-Type: application/json"` (порожнє тіло) → має бути 4xx, НЕ 500. Fix: guard `code.startsWith('FST_ERR_CTP_') && statusCode у 4xx` → чистий 4xx UA + `logger.warn`; 5xx-FastifyError і Node errno (`ECONNREFUSED`) лишаються 500. Регресія-guard: filter-spec з fake `{code:'FST_ERR_CTP_EMPTY_JSON_BODY', statusCode:400}` → 400+warn. Severity LOW (керована помилка, веб уже захищений api-client-ом; але Sentry-шум + маскує баги для не-браузерних клієнтів). **ПАСТКА тест-харнеса:** власний probe-клієнт має додавати `Content-Type: application/json` ТІЛЬКИ за наявності тіла — інакше bodyless-виклики дають хибний 500, що імітує неіснуючий баг ендпоінта.

---

### §1.3 — Frontend (Next.js)

```bash
# Bug #567 — E2E sessionStorage не restored Playwright-ом: будь-який рефактор
# AuthProvider або setup-auth.ts може непомітно зламати E2E auth state.
# Перевірити обидві сторони escape-hatch:
grep -n "sto_e2e_skip_refresh\|sto_e2e_access_token" apps/web/src/lib/auth/context.tsx
# Має бути 2+ matches (reducer init copy + useEffect skip)
grep -n "sto_e2e_skip_refresh\|sto_e2e_access_token" apps/web/e2e/setup-auth.ts
# Має бути 2+ matches (write skip_refresh + write access_token mirror)
# Якщо хоч в одному файлі 0 — E2E зламається на 100% тестів (всі побачать login)

# Bug #506/#510 — Дублюючі interface declarations (hook vs PageClient inline)
# Кожен дубльований тип = ризик дрейфу при додаванні нового поля у бекенді.
grep -rEn "^interface (WorkOrder|Invoice|Counterparty|Vehicle|Good|Warehouse|Employee) " apps/web/src --include="*.ts*"
# Якщо >1 match для одного імені — перевірити що локальний дублікат містить всі поля з hook.

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

# Bug #606 — guard-order у click-shortcut «add-to-collection» helper: limit/permission-guard кидає toast на ПОВТОРНИЙ клік по вже-активному елементу.
# Для будь-якого helper типу addToZone/addToList/pushToSelection — перевірити що includes/has() коротшить ПЕРЕД limit/permission.
grep -rEn "\.includes\(key\)|\.has\(key\)|\.some\(.*===\s*key" apps/web/src --include="*.tsx" -B 3 -A 3 | grep -B 4 -A 2 "toast\.warning\|toast\.error" | head -60
# Для кожного match: якщо limit-check/permission-check стоїть ВИЩЕ за unique-check → повторний клік по вже-активній кнопці кине misleading toast.
# Правильно: `if (list.includes(key)) return;` — ПЕРШИМ, ЛИШЕ ПОТІМ `if (list.length >= LIMIT) return toast(...)`.

# Bug #620 — форматер шукає тип поля у `columns` list але поле може бути ВНЕ columns
# (aggregation-only, footer-only, computed metric) → fallback на fmtMoney/String → візуальний баг.
grep -rEn "cols\??\.find\(.*key\s*===|columns\.find\(.*key\s*===" apps/web/src --include="*.tsx" -B 2 -A 6 | head -40
# Для кожного match — перевірити:
# 1. Чи можливий сценарій де fieldKey ВНЕ cols/columns (агрегати, footer totals)?
# 2. Чи backend response має ще один array з type/label (aggregations, metrics)?
# 3. Якщо так — форматер має шукати спочатку у ньому, fallback на cols.

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

# Bug #401: FE canShare/canEdit/canDelete асиметричний з backend X_STATUSES константою
# (FE масив ⊂ BE → silent UX обмеження; FE ⊃ BE → false promise → 400).
grep -rnE "const can(Share|Edit|Delete|Reserve|Transition)\s*=" apps/web/src --include="*.tsx" --include="*.ts" | head -10
# Для кожного match — знайти відповідну backend константу:
grep -rnE "(SHAREABLE|EDITABLE|DELETABLE|RESERVATION_ACTIVE)_STATUSES\s*[:=]" apps/api/src/modules --include="*.ts"
# Звірити масиви: BE — single source of truth, FE має бути дзеркальним підмножиною (або тотожним).

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

# Bug #630 — concurrent double-submit у create-модалці: submit-handler захищений ЛИШЕ
# `disabled={saving}` без синхронного savingRef-guard першим рядком.
# `disabled` спирається на re-render React МІЖ подіями кліку → два click-и в одному tick
# (швидкий double-click / синтетичні події / Enter-repeat) обидва входять до застосування
# disabled → 2 POST → 2 документи. Idempotency-ref (createdIdRef/createdInvoiceRef) НЕ рятує
# (виставляється лише ПІСЛЯ await першого POST — другий click вже пройшов).
grep -rln "const handleCreate\|const handleSave\|const create =\|const save = async\|const update = async\|async function handleCreate" apps/web/src/components/ui --include="*Modal.tsx" | while read f; do
  # модалка має savingRef АБО лише disabled={saving}? і чи save/create-handler гейтить на savingRef?
  if grep -qE "setSaving(Both)?\(true\)" "$f" && ! grep -qE "if \(saving(Ref|_?ref)?\.current" "$f"; then
    echo "DOUBLE-SUBMIT RISK (no savingRef guard at all): $f"
  fi
done
# КОВЕРІДЖ: перевіряти НЕ ЛИШЕ великі документні модалки, а Й edit-модалки довідників
# (Counterparty/Employee/Good/Unit/Brand/Category). Bug #632-#634: submit-кнопка
# `<Button onClick={save} loading={saving} disabled={!field}>` — `disabled` БЕЗ saving →
# гейт лише async (loading через re-render), same-tick race незахищений → дубль master-data.
grep -rln "loading={saving}" apps/web/src/components/ui --include="*Modal.tsx" | while read f; do
  # кнопка має loading={saving} але disabled БЕЗ saving/loading і немає savingRef → vulnerable
  if grep -qE "disabled=\{![^}]*\}" "$f" && ! grep -qE "if \(saving(Ref)?\.current" "$f"; then
    echo "DOUBLE-SUBMIT RISK (loading-only gate, no sync ref): $f"
  fi
done
# Точніша перевірка (ручна): для КОЖНОГО create/save async-handler переконатись, що ПЕРШИЙ
# рядок = `if (savingRef.current [|| transitioningRef.current]) return;` ПЕРЕД будь-яким await.
# Модалка може мати savingRef і використовувати його у edit/transition-handler, АЛЕ забути у create.
```

- [ ] **Concurrent double-submit у create/save-модалці (Bug #630, #632-#634):** будь-який async submit-handler (`handleCreate`/`handleSave`/`create`/`save`/`update`) у `apps/web/src/components/ui/*Modal.tsx`, що пише **документ АБО master-data** (не лише «великі» документні модалки — Й edit-модалки довідників Counterparty/Employee/Good/Unit/Brand/Category), МАЄ синхронний re-entrancy guard `if (savingRef.current [|| transitioningRef.current]) return;` **першим рядком, ПЕРЕД будь-яким `await`**. Особливий сигнал edit-модалок: кнопка `<Button onClick={save} loading={saving} disabled={!field}>` — `disabled` БЕЗ `saving` → гейт лише async (loading через re-render) → same-tick дубль (Bug #632 контрагент, #633 співробітник+auth-акаунт, #634 товар). `disabled={saving}` НЕдостатньо — він спирається на re-render React МІЖ подіями кліку; два click-и в одному event-loop tick (швидкий double-click, синтетичні події a11y-інструментів, Enter-repeat на сфокусованій кнопці) обидва входять у handler до застосування disabled → 2 POST → 2 документи (фінансовий ризик: подвійний борг/списання). Idempotency-ref (`createdIdRef`/`createdInvoiceRef`) закриває ЛИШЕ retry-після-обриву (виставляється після await першого POST), НЕ concurrent double-submit — потрібні ОБИДВА механізми. `savingRef.current` фліпається СИНХРОННО (у `setSaving`/`setSavingBoth`) → другий вхід одразу повертається. Grep: див. блок вище. **Пастка:** модалка часто ВЖЕ має `savingRef` (у `setSavingBoth`) і гейтить edit/transition-handler, але забуває create-шлях — split-coverage. Регресія-guard: component-тест з **нативним** подвійним `(btn as HTMLButtonElement).click(); btn.click();` — двічі СИНХРОННО в одному блоці БЕЗ `await`/`act`-обгортки між кліками (НЕ `userEvent.click`×2 і НЕ `fireEvent.click`×2 — обидва обгортають кожен клік у act()/pointer-чергу і flush-ять стан між кліками → `disabled={loading}` стає гейтом → хибно-зелений 1 POST навіть без ref-guard). Ввід у поля — `fireEvent.change` (синхронний). Розрулити in-flight POST у фінальному `await act(async () => resolve())`. assert рівно 1 POST; **ОБОВ'ЯЗКОВО верифікувати дискримінацію: revert guard→FAIL «expected 2 to be 1» / fix→PASS** (інакше тест хибно-зелений — див. Meta 2026-09-05). Severity HIGH для фінансово-облікових документів (SupplierPayment/Invoice/PurchaseOrder/StockDocument/WorkOrder), MEDIUM для інших. Where else: усі create-модалки + `SettlementsTabContent.handleCreateAct` (raw apiFetch без savingRef).
- [ ] Кожен list-fetch в `useEffect` має: `let cancelled=false` + `return () => {cancelled=true}`; `setLoading(true)` перед; `.finally(() => !cancelled && setLoading(false))`; `.catch((e) => !cancelled && setError(...))`; у JSX `{loading && <Spinner/>}` + `{!loading && items.length===0 && <Empty/>}`
- [ ] `new Date()` у render path → `useState<Date|null>(null)` + `useEffect(() => setToday(new Date()), [])`
- [ ] `key={i}` у списках де можлива re-order/filter → `key={item.id}` або stable derived key
- [ ] PUBLIC_ROUTES (`/booking`, `/setup`, `/login`, `/403`) → `publicFetch`, не `apiFetch`
- [ ] `import type { ReactNode, ChangeEvent, MouseEvent } from 'react'` (не `React.ReactNode`)
- [ ] `setTimeout` / `setInterval` у `useEffect` → `clearTimeout` / `clearInterval` у cleanup
- [ ] Timeline/gantt drag/resize: кожен px→decimal-hours converter clamp-ить результат у `[WINDOW_START, WINDOW_END]` ПЕРЕД побудовою `new Date(...).toISOString()` (інакше `endH>maxHour`/`startH<0` → `"24:30"`/`"-1:00"` → Invalid Date → RangeError у `toISOString()` → handler мовчки падає). Resize-гілка ОКРЕМО від draw-гілки — draw зазвичай clamp-ить через `pxToDecimalHours`, resize рахує delta і clamp-ить тільки проти протилежного краю
- [ ] Swallowed-fetch що годує **обов'язковий** контрол → MEDIUM (не LOW): якщо `.catch(() => {})`/`.catch(noop)` ховає помилку завантаження списку, який рендериться у `<Select required>` або гейтить `disabled={!state}` submit-кнопку — порожній список = назавжди заблокований workflow без feedback. Фікс: `errorState` + inline `<p>` під контролом
- [ ] **Swallowed-fetch у read-only panel мапиться у empty-state (Bug #414):** будь-який `<*Panel/>` viewer (`LinkedDocumentsPanel`, `HistoryPanel`, `AuditLogPanel`, `RelatedDocsList`) що має `.catch((e) => setData(emptyShape))` (замість `setError`) → backend помилка 500/network drop рендериться так само як справжній empty state (`"немає документів"`). Користувач думає що даних просто немає — приймає рішення на основі цієї хибної інформації (наприклад «створимо рахунок, бо немає активного»; backend насправді впав і відповідний invoice існує). Severity MEDIUM (UX false reassurance). Grep: `grep -rn "\.catch.*=>" apps/web/src/components/ui apps/web/src/app --include="*.tsx" -A 2 | grep -B 1 "setData\|setItems\|setX\|setList"` → для кожного match перевірити чи render має `if (error) return <ErrorBanner/>`. Фікс: окремий `error` state + Retry-кнопка (bumps local `retryKey` у useEffect deps).
- [ ] **FE canX status-whitelist симетричний з backend X_STATUSES (Bug #401):** для КОЖНОГО `const canShare/canEdit/canDelete/canReserve = [...].includes(currentStatus)` у `apps/web/src/components/ui/*.tsx` знайти відповідну backend константу `(SHAREABLE|EDITABLE|DELETABLE|RESERVATION_ACTIVE)_STATUSES`. Backend = єдине джерело правди (security validation). Якщо FE масив ⊂ BE → MEDIUM (silent UX-обмеження); FE масив ⊃ BE → HIGH (UI обіцяє кнопку, click → 400). Регресія-гард: contract spec кейс на кожен статус з BE масиву → 200; статус поза масивом → 400
- [ ] Мертвий стан після inline→shared-component рефактору: коли inline-патерн (dropdown/picker/search) замінюють на shared-компонент (`SearchPickerModal` тощо), старі `useState`/`useCallback`/`useRef` лишаються «сиротами». Ознака: setter викликається ТІЛЬКИ в reset-ефекті (`if (!open) setX('')`), а value НІКОЛИ не читається у JSX; handler (`searchX`) визначено але не викликано. `tsc` без `noUnusedLocals` мовчить. Видалити повністю (включно з cleanup-ефектом orphaned `timeoutRef`)
- [ ] **Next.js App Router convention-файли — точна сигнатура (Bug #206):** `app/**/error.tsx` має приймати `{ error: Error & { digest?: string }; reset: () => void }` — bare `Error` валідний у tsc але блокує майбутній моніторинг (Sentry/Datadog) що читає `error.digest`. Перевіряти сигнатуру кожного нового error.tsx проти Next.js docs (`https://nextjs.org/docs/app/api-reference/file-conventions/error`). Аналогічно для `layout.tsx` (`{ children, params }`), `page.tsx` (`{ params, searchParams }`), `loading.tsx` (no props). Grep: `grep -rn "error.*:\s*Error[^&]" apps/web/src/app --include="error.tsx"` — кожен match без `digest` = Bug
- [ ] **Decorative SVG/icon без `aria-hidden="true"` (Bug #207):** SVG-іконки що дублюють semantic-сигнал поряд (warning-icon біля заголовка "Помилка", info-icon біля banner-тексту) → `aria-hidden="true"` обов'язково, інакше screen-reader озвучує "image" перед текстом. Іконки-кнопки без тексту → `aria-label` (вже у §1.7). Іконки з текстом-аналогом поряд → `aria-hidden="true"`
- [ ] **App Router convention-файли з інтерактивом (`useEffect`/`onClick`/`'use client'`) → парний `*.test.tsx` (Bug #208):** `error.tsx`/`not-found.tsx`/кастомний `global-error.tsx` потребують компонент-тестів. Шаблон: `apps/web/src/app/__tests__/error.test.tsx` — heading render, error.message render, fallback при empty, reset callback клік, navigate link/button, console.error effect, type-regression test (digest support), aria-hidden SVG. `loading.tsx` без логіки skip
- [ ] **FormData upload через `apiFetch` замість `apiMultipartFetch` (Bug #197) → CRITICAL**: `apiFetch` ЖОРСТКО додає `Content-Type: application/json` до КОЖНОГО запиту → коли тіло — `FormData`, browser НЕ може автоматично виставити правильний `multipart/form-data; boundary=...`. Сервер отримує binary FormData з JSON content-type → `fastify-multipart` кидає `the request is not multipart` → upload завжди валиться 400/406. **Фіча повністю мертва у проді.** Grep: `grep -rn "apiFetch\b.*body:\s*\(fd\|formData\|new FormData\)" apps/web/src --include="*.tsx"` — кожен match замінити на `apiMultipartFetch(path, formData)` (БЕЗ ручного `method: POST` — функція сама POST). Особливо при додаванні нової upload-фічі: «нагуглив схожий аплоад» → `apiFetch` looks similar → CRITICAL регресія
- [ ] **React Query cross-resource invalidation audit (Bug #210-#212, повторено у #590):** для КОЖНОГО `await apiFetch(/X/:id/Y, { method: 'POST'|'PATCH'|'DELETE' })` у migrated page **АБО** для КОЖНОГО `useMutation` hook у `apps/web/src/hooks/api/use*.ts` → прочитати **серверний** controller+service цього endpoint і знайти всі side-effect updates на ІНШИХ resource-ах: (1) `inventory.createMovement(...)` → invalidate `inventoryKeys.all`; (2) `workOrders.transition(...)` → invalidate `workOrdersKeys.all`; (3) `settlements.createTransaction(...)` → invalidate `counterpartiesKeys.all` (якщо list показує balance); (4) `priceHistory.create(...)` + `good.update({ salePrice })` → invalidate `inventoryKeys.all` / `goodsKeys.all`. Same-resource invalidation (own-keys.all) — звичайна; cross-resource — невидимий gap бо клієнт не знає що endpoint мутує сторонній resource. Не покладатись на `staleTime=30s` — користувач може мати другий tab з відповідним list-view або переходити швидше за staleTime. **Особливо ризикова категорія — FSM confirm-like мутації (`use<X>Confirm`/`use<X>Complete`/`use<X>Approve`/`use<X>Issue`) що триггерять `settlements.createTransaction(PAYMENT|CHARGE|CREDIT_NOTE|REFUND|PREPAYMENT)` у $transaction** — без `counterpartiesKeys.all` invalidate CRM balance застаріває до 30s. Sanity-grep: `grep -rln "createTransaction" apps/api/src/modules/*/*.service.ts` → для кожного service-метода знайти всі FE-хуки що його триггерять (`grep -rn "endpoint-path" apps/web/src/hooks/api`) → у кожному хуку `.onSuccess` перевірити `counterpartiesKeys.all`. Reference-fix: `useCreatePayment` (useInvoices.ts, Bug #245), `useConfirmSupplierPayment` (useSupplierPayments.ts, Bug #590). Grep: `grep -B2 -A5 "method: 'POST'\|method: 'PATCH'\|method: 'DELETE'" apps/web/src/app/<migrated-page>` → кожен endpoint pair-check проти `apps/api/src/modules/<resource>/<resource>.service.ts`. Severity: MEDIUM коли впливає на бізнес-метрику (залишки/ціни); HIGH коли впливає на balance/фінансовий-стан і user приймає рішення на його основі (продовжити оплату/не продовжити); LOW коли лише UX (new row не з'являється у list до router.back)
- [ ] **React Query migration completeness: mutation hooks експортовані але не використовуються (Bug #213):** після `feat(rq): migrate X` commits — grep usage `useXMutation`/`useDeleteX`/`useUpdateX` у `apps/web/src/app` (поза tests). Якщо count === 0 → migration зробила лише READ-path, WRITE-path лишається raw `apiFetch` + manual invalidate. Це **не runtime-bug**, але: (1) bundle bloat; (2) misleading commit-message; (3) maintenance burden (invalidation у двох місцях). Severity LOW; фікс: задокументувати у MemoryManual як known-state АБО видалити hooks; full migration = окремий sprint
- [ ] **React Query custom hook без `*.test.tsx` (Bug #214):** новий `apps/web/src/hooks/api/use*.ts` з `useQuery`/`useMutation` потребує парний `*.test.tsx`. Тести покривають: (1) queryKey factory ізоляція (різні фільтри → різні ключі); (2) enabled-gate (`employee=null` → no fetch); (3) URLSearchParams build (кожне опціональне поле → відповідний URL param АБО відсутній якщо false-y); (4) signal abort (apiFetch отримує signal). Шаблон: `useWorkOrders.test.tsx`. Mock `apiFetch` + `useAuth`. Не використовувати реальний `QueryClientProvider` — створити свіжий `QueryClient` per-test з `retry: false`. Без цих тестів — silent URL param drift (як 3d5136d repairCategory regression) пройде CI зеленим
- [ ] **Token-guard debouncer: early-return гілка інкрементує reqId (Bug #396):** для КОЖНОГО хука з `reqIdRef`/`requestIdRef`/`tokenRef` (last-fetch-wins pattern) — переконатись що ВСІ гілки `check()`/`run()`/`load()` що змінюють стан (включно з early-return на невалідних параметрах: `!startAt || endAt<=startAt`) бамптять `reqIdRef.current++` ПЕРЕД `setX(null)`. Інакше pending in-flight fetch розпочатий до невалідного зміни перезапише очищений стан (banner мигне з фальшивими даними). Grep: `grep -rn "reqIdRef\|requestIdRef\|tokenRef" apps/web/src --include="*.ts" --include="*.tsx" -l` → для кожного `check`/`run`/`load` метод знайти early-return з `setX(null)` без `reqIdRef.current++`. Регресія-гард тест: simulate in-flight via never-resolving Promise + trigger early-return + delayed resolve → assert state still null
- [ ] **Conflict-check endpoint: parent-context потребує `excludeParentId` (Bug #397):** для кожного `POST /X/check-conflicts|check-availability|check-overlap` що має `excludeSelfId` — перевірити чи фронт викликає його з контексту "edit parent" (modal батьківської entity що має 1:N до self-entity). Приклад: WO modal → check-conflicts по slots (1 WO → N slots). Без `excludeParentWO Id` backend завжди знаходить власні slots цього WO → false positive banner при кожному відкритті уже-запланованого batch-parent. Grep usage: `grep -rn "check-conflicts\|checkConflict" apps/web/src --include="*.tsx" -l`; для кожного споживача — чи контекст modal = parent-entity (WO/RecurringEvent/PurchaseOrder)? Якщо так — потрібен симетричний `excludeParentId` field у DTO та фільтр у сервісі (обидва прапори незалежні, поєднуються). Тест: contract case на прокидання `excludeParentId` + 400 на не-UUID + `excludeParentId` deps у useEffect модалки
- [ ] **Read-only DTO degraded-form: contract drift (Bug #398):** будь-який service-метод що повертає `T[]` де `T = SharedResponseDto` (той самий тип що інші CRUD-методи) і має ЛОКАЛЬНИЙ mapper `toDtoSimple()`/`mapBriefly()`/`projectMinimal()` — потенційна латентна регресія. Optional поля у DTO компілюються БЕЗ enrichment → TS green → UI зараз тільки `.length` → майбутній рендер деталей отримає undefined у всьому масиві. Grep: `grep -rn "const toDto[A-Z]\w* = " apps/api/src/modules --include="*.service.ts" -A 2`. Фікс: видалити локальний mapper, використовувати `this.toDto(s)`; розширити CONFLICT_SELECT/SEARCH_SELECT щоб включити ті ж relations (counterparty/vehicle/parent). Якщо degraded shape потрібна для публічного endpoint — окремий type (`PublicXDto`) замість того ж загального
- [ ] **UoM display-vs-base mismatch на submit (Bug #231):** будь-який `<Select>` що дозволяє перемикати UoM з recalc display quantity (Krok 5 patten: `coefficient` + `unitId` + `unitShortName` у local lines state) ОБОВ'ЯЗКОВО має у submit-функції конвертувати display→base: `quantity: parseFloat(l.quantity) * (l.coefficient || 1)` і `price: parseFloat(l.price) / (l.coefficient || 1)`. Display-transition formula `newDisplay = oldDisplay * oldCoeff / newCoeff` зберігає інваріант між двома UoMs, АЛЕ submit потребує **окремої** конверсії до base. Якщо submit шле `parseFloat(l.quantity)` як-є → backend (що очікує base units) отримує display value → silent data corruption у stock movement / payable / applyPricing. Видно ЛИШЕ коли coefficient != 1; happy-path з default UoM (coeff=1) — без регресії. Grep: `grep -rnE "quantity:\s*parseFloat\(l\.quantity\)[^*]" apps/web/src/app --include="*.tsx" -B5 | grep -B5 "coefficient"` — кожен match без `* coeff`/`* (l.coefficient` = CRITICAL bug. Backend пара: `inventory.createMovement(quantity: l.quantity)` без UoM-conversion — підтвердження що quantity ОЧІКУЄТЬСЯ у base units. Severity: CRITICAL (release-blocker)
- [ ] **Local FE interface ↔ backend ResponseDto field-list symmetry (Bug #434):** для КОЖНОГО великого modal/page компонента (`CreateXModal`, `EditXModal`, `XDetailModal`, `app/(app)/<entity>/[id]/PageClient.tsx`) що оголошує **локальний** TypeScript-interface `<EntityDetail>`/`<EntitySummary>` (НЕ імпортує з `@sto/shared` чи backend DTO) — cross-check взаємно-зворотно проти backend `*.dto.ts` `ResponseDto`. Якщо backend DTO має `<field>?: <type>` АЛЕ FE-interface його пропускає → silent type-drift. tsc green (локальний interface незалежний). Симптом drift: **display** працює (бо backend повертає форматоване значення типу `unitShortName`), але **inline-edit/clone/duplicate** mappers хардкодять дефолт замість preserved value. Особливо помітно для FK з default-value у dropdown (`unitOfMeasureId: ''` показує "шт" замість реального `'kg'`). Grep: `git diff HEAD~N HEAD -- "apps/api/src/modules/**/*.dto.ts" | grep "^+.*?: " | grep -E "@ApiPropertyOptional"` → нові optional fields у backend → перевірити кожен у відповідних FE-interface. Альтернатива (long-term): експортувати interface у `packages/shared/src/types.ts` і використати з обох сторін. Регресія-guard: компонент-test `it('edit existing X зберігає <new field> з backend response')` (mock `apiFetch` з backend response що містить new field, відкрити inline-edit, асертити state включає field). Severity: MEDIUM (inline-edit drift); HIGH якщо submit-path записує hardcoded default замість preserved value.
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
- [ ] **Imperative `.focus()`/`.scrollIntoView()`/`.select()` на conditionally-rendered ref у click-handler (Bug #386):** будь-який `xxxRef.current?.focus()` (або `.select()`, `.scrollIntoView()`, `.click()`) викликаний у click/event handler ТОГО Ж компонента — перевірити чи ref належить **умовно-рендереному** елементу (`{cond && <input ref={xxxRef}/>}` або `cond ? <input ref={xxxRef}/> : <span/>`). Якщо так і handler змінює state-умову яка контролює mount/unmount цього ref-елемента (наприклад `setForm(f => ({...f, x: ''}))` → display='' → input mounted) — `?.focus()` ВИКОНУЄТЬСЯ ДО React commit → ref still null → optional-chaining ховає → focus loss. Фікс: обгорнути у `requestAnimationFrame(() => xxxRef.current?.focus())` АБО використати declarative `useEffect([cond])` що ставить focus коли cond flip-нулась. Grep: `grep -rnE "[a-zA-Z]Ref\.current\?\.(focus|select|scrollIntoView|click)" apps/web/src/components/ui --include="*.tsx" -B 3` → для кожного match перевірити чи ref-елемент рендериться умовно. Severity LOW (UX-дрібниця) до HIGH (для `.scrollIntoView` у list-modal — модал виглядає ламаним). Регресія-guard: component-test `await user.click(clearBtn); expect(input).toHaveFocus();`.
- [ ] **Sequential FE mutation chain without rollback on later-step failure (Bug #404):** будь-яка async UI-функція що робить **2+ послідовних** `apiFetch(/X/, {method:'POST'})` де крок 1 змінює state-A (FSM transition / create-related-resource), а крок 2 змінює state-B (create-invoice / charge-payment / send-notification) — потребує rollback крок-1 у catch коли крок-2 провалюється. Сценарій: `await transition(WO, INVOICED); await createInvoice(WO);` — якщо invoice POST throws (validation, network, race), WO застряг у INVOICED без рахунку → FSM-інваріант "INVOICED = invoice exists" порушений. Pattern: захопити `originalStatus` ПЕРЕД step 1, прапор `transitionedHere=false`, після успіху step 1 → `transitionedHere=true`. У catch (поза branch що очікувано-успішний як conflict-409): `if (transitionedHere) try { await transition(WO, originalStatus) } catch {/* warn */}`. Альтернатива (бажана): атомарний backend endpoint що робить обидва steps у `$transaction`. Grep: `grep -rnE "await apiFetch\(.*transition.*\);" apps/web/src --include="*.tsx" -A 5` — для кожного match перевірити чи наступний await є мутацією і чи catch робить rollback. Severity HIGH (порушує business invariant). Регресія-guard: vitest mock step1→200, step2→500 → assert наступний viкlik transition→originalStatus.
- [ ] **Inline ad-hoc modal/dialog без використання shared `<Modal>` (Bug #408):** будь-який `<div className="fixed inset-0 z-[XX] flex items-center justify-center bg-black/50">` всередині `apps/web/src/components/ui/*.tsx` або `apps/web/src/app/**/*.tsx` що НЕ обгорнутий у shared `<Modal>` — потенційний пропуск modal affordances. Перевірити: (а) `onKeyDown` listener для ESC що закриває; (б) `onClick` на overlay + `e.stopPropagation()` на inner div; (в) `autoFocus` на головну кнопку (або focus trap логіка); (г) `role="dialog" aria-modal aria-labelledby` (часто фіксовано sto-review). Хоча shared `<Modal>` має все це вбудовано, інлайн-копії повторюють виключно макет і обходять shared behaviors. Grep: `grep -rnE "fixed inset-0 z-\[\d+\].*bg-black/50" apps/web/src --include="*.tsx" -A 2` → для кожного match перевірити: чи `onKeyDown` на wrapper? Чи `onClick` на overlay? Чи `autoFocus`? Якщо ні — bug. Парне: важливо guard `!isLoading` щоб не закрити dialog під час in-flight action. Severity MEDIUM (a11y + UX, не release-blocker). Регресія-guard: vitest `userEvent.keyboard('{Escape}')` закриває.
- [ ] **Hardcoded `0`/`false`/`null` у side-channel mutation що дублює canonical create (Bug #406):** будь-який `tx.<Model>.create({ data: { vatRate: 0, ... } })` або similar copy-from-source mutation де canonical create-метод (`addLine`/`addX`/`createX`) використовує `dto.vatRate ?? <DEFAULT>` АБО читає `<DEFAULT>` з OrganisationSettings — копія повинна використати ТЕ САМЕ дефолтне значення. Сценарій (Bug #406): `addLine` дефолтить `vatRate=20`; `refreshFromWorkOrder` (alternate endpoint) hardcode-ить `vatRate: 0` → totalVat завжди 0 → ПДВ-облік ламається. Інші risk-spots: `discountPercent: 0`, `currencyCode: 'UAH'`, `paymentDays: 14`, `warrantyDays: 0`. Grep для виявлення: спочатку знайти canonical defaults (`grep -rnE "vatRate:\s*dto\.vatRate\s*\?\?\s*\d+" apps/api/src/modules --include="*.service.ts"`), потім alternate mutations у тому ж модулі (`grep -rnE "vatRate:\s*0\b|currencyCode:\s*'UAH'" apps/api/src/modules --include="*.service.ts"`) → mismatch = bug. Pattern fix: extract `const DEFAULT_VAT = 20` constant у service (або читати з OrganisationSettings), використати у обох. Severity HIGH для фінансових полів (ПДВ/discount/currency). Парне з Bug #360 (auto-create child ignores parent settings inheritance).
- [ ] **`useState` guard у async handler з pending `await` між set і guard-read (Bug #430):** будь-який `handleClose`/`handleCancel`/`handleDismiss`/`handleEscape` що читає React state (`saving`, `loading`, `transitioning`, `submitting`) у тілі — race-prone якщо парний async handler робить `setX(true)` → `await externalCall()`. React batching: state-flush НЕ відбувається до завершення event handler; pending `await` тримає handler open → handleClose v1 з closure `state=false` живий → guard обходиться → modal закривається на pending POST → orphan data. Grep: `grep -rnE "if \((saving|loading|transitioning|submitting)\)\s*return" apps/web/src/components --include="*.tsx" | grep -v "Ref\.current"` — кожен match читає state замість ref. Cross-check: `grep -rnE "set(Saving|Loading|Transitioning|Submitting)\(true\)" apps/web/src/components --include="*.tsx" -A 3` → знайти парний `await apiFetch\|await fetch` — якщо є, race-window CONFIRMED. Фікс-pattern: двошарова state — `useState` для render (disabled-props/spinners) + `useRef` для guard-read у async paths. Wrapper-сетер `setXBoth(v)` оновлює обидва. Guard у handleClose читає **виключно** з ref. Регресія-guard vitest: pending Promise mock (`new Promise(resolve => { resolveFn = resolve; })`) → click submit → keyboard Escape → assert onClose NOT called. Severity: HIGH (data-integrity: orphan rows, silent failed POSTs)
- [ ] **`vi.mock(...)` зі shared lib НЕ оновлений після refactor-extract (Bug #429):** будь-який `refactor(simplify|extract)` commit що додає нові exports у shared lib (`apps/web/src/lib/*.ts`, `@/hooks/*`, `@sto/shared`) і модифікує компонент щоб імпортувати їх — ОБОВ'ЯЗКОВО перевірити кожний test що мокає той же модуль. Grep: `git diff HEAD~N HEAD -- "apps/web/src/lib/*.ts" "apps/web/src/hooks/*.ts" | grep "^+export"` → для кожного нового export `<X>`: `grep -rln "vi.mock\(['\"]@/lib/<libName>['\"]" apps/web/src --include="*.test.tsx"` → для кожного матчу перевірити чи містить `<X>:` у returned object → якщо ні → stale mock. **Симптом runtime:** тест fail'ить за НЕ ПОВ'ЯЗАНИМ assert (наприклад спостережувана state assertion), а не за "missing export" — бо exception ловиться у `try/catch` у компоненті, `finally` нормалізує state. DEBUG-перевірка: тимчасові `console.log` у компоненті `try/catch/finally` блоки → у логах `[catch] Error: No "X" export is defined on the "@/lib/Y" mock`. Фікс: додати pass-through stub для нового export (identity-mapping `(v) => v` достатньо якщо тест не залежить від DST/Intl-поведінки). Альтернатива (preferable): `vi.mock(..., async () => { const actual = await vi.importActual(...); return { ...actual, override: stub }; })` — only override what test controls. Severity: HIGH (release-blocker, ховає інші регресії). Парний шаблон з Bug #430: stale mock ховав race-window 10+ commit-ів — після фіксу mock, real bug випливає назовні.
- [ ] **Behavior-change fix + stale regression-guard який асертить СТАРУ (виправлену) поведінку (Bug #648):** коли fix змінює що робить handler на певну подію (race-фікс: Enter тепер ФЛАШИТЬ debounce замість тихо ігнорувати; guard-move: умова переїхала нижче нової гілки) — ОБОВ'ЯЗКОВО перечитати ВСІ парні `*.test.tsx` що покривають цей handler. Ризик: існуючий тест досі асертить ДО-фіксну поведінку («scanSubmit НЕ викликається», «onSelect НЕ спрацьовує») і **проходить лише за async-таймінгом** — новий flush `.then()` резолвиться ПІСЛЯ синхронної асерції, тому на момент `expect(...).not.toHaveBeenCalled()` сет-стейт ще не стався. **Сигнал-детектор:** `Warning: An update to <Component> inside a test was not wrapped in act(...)` у тесті що асертить _відсутність_ дії — майже завжди означає що late async setState втікає повз синхронну асерцію = тест закріплює прибраний баг як «правильну» поведінку. Grep: `git diff <range> -- 'apps/web/src/components/**/*.tsx' | grep -E "^\+.*(clearTimeout|debounceRef|timeoutRef).*null"` (сигнал зміни async-контролю) → для кожного зачепленого компонента: `grep -rln "<Component>" apps/web/src/**/__tests__/*.test.tsx` → перечитати кожен тест з `.not.toHaveBeenCalled()`/`НЕ викликається` на подію яку фікс тепер обробляє. **Фікс:** видалити stale тест (він шкідливий — хибно-зелений guard приховує регресії самого фіксу); замінити на дискримінуючі тести НОВОЇ поведінки з `flushMicrotasks()` helper (`await act(async () => { await Promise.resolve(); await Promise.resolve(); })`) щоб коректно дочекатися flush-promise під fake timers. **ОБОВ'ЯЗКОВО довести дискримінацію:** revert flush-гілки → нові тести падають. Severity: MEDIUM (test-integrity — хибно-зелений guard гірший за відсутній: приховує майбутню регресію фіксу і документує баг як правило). Where else: будь-який picker/combobox/autocomplete з debounce+Enter (`search-picker-modal`, `search-combobox`, `GoodPickerModal`), будь-який `refactor`/`fix(review)` що чіпає `setTimeout`/`clearTimeout`/AbortController у обробнику події.
- [ ] **`setX(value)` викликається, але `x` не читається у JSX (Bug #497, sub-patern Bug #160):** на відміну від класичного dead-state (setter не викликається І value не читається — обидві сторони мертві), цей варіант **гірший**: setter ВИКЛИКАЄТЬСЯ під час async-операцій (`apiFetch`/`mutateAsync`), state перерендерить компонент, але value НІКОЛИ не зчитується у JSX → user не бачить loading-spinner/disabled-state/error-banner під час operation. На відміну від dead state — тут є performance impact (extra renders) + UX gap. Grep: `grep -rnE "useState[<(](bool|number|null|string)" apps/web/src/app --include="*.tsx" -A 5` → для кожного state-name взяти grep по файлу: `grep -nE "\b<name>\b" $file` — якщо є тільки декларація + setter calls але **немає** читання `{<name> && ...}`/`disabled={<name>}`/`loading={<name>}` у JSX → bug. Найчастіше: `detailLoading`/`loadingId`/`saving` після refactor що видалив conditional render. Severity MEDIUM (silent UX). Фікс: ЛИБО видалити state (якщо feature не потрібна), ЛИБО додати render-time consumption (loading-button, spinner, disabled-row). Особливо ризиковано коли state описує per-row tracking — `detailLoadingId: string | null` дозволяє per-row loading-state на action-кнопках.
- [ ] **`mutateAsync()` у inline click-handler без try/catch — silent failure (Bug #499):** TanStack Query mutation hook без `useMutation({onError})` АБО без global `MutationCache.onError` у `QueryClientProvider` config → `await mutateAsync` throw перериває handler. Якщо handler має `toast.success` ПІСЛЯ await — success тост не показується, але також НЕ показується error тост. Користувач клікнув "Видалити" → нічого не відбулось → бачить що рядок все ще там → плутанина. Grep: `grep -rnE "await\s+\w+\.mutateAsync\(" apps/web/src/app --include="*.tsx" -B 1 -A 2` — для кожного match перевірити: (а) `try/catch` обгортка; АБО (б) hook має `useMutation({onError: ...})`; АБО (в) `MutationCache.onError` глобально. Якщо жодного з трьох — bug. Cross-check: `grep -rn "MutationCache\|mutationCache:" apps/web/src` — якщо взагалі немає global onError, КОЖЕН inline mutateAsync без try/catch = bug. Severity MEDIUM (silent failure, user confusion). Фікс-pattern inline: `try { await mut.mutateAsync(); toast.success } catch (e) { toast.error(e.message) }`. Альтернативний фікс (preferable): додати `onError` у сам hook — спрацює для ВСІХ callers. Регресія-guard: vitest mock mutation з `mockRejectedValue` → click button → assert `toast.error` called.
- [ ] **Dead state cleanup у paired файлах після review (Bug #496, paired with Bug #341):** коли review-fix commit ВИДАЛЯЄ dead state з одного файлу (наприклад `selectDoc`/`toggleSelectDoc` у stock-documents), часто паралельний файл (`purchase-orders/page.tsx`, `invoices/page.tsx`) має **той самий патерн** — `useState<X | null>(null)` + setter тільки до `null` + ніколи non-null. Grep: для кожного `useState<\w+\s*\|\s*null>` у `apps/web/src/app/(app)/**/page.tsx`: підрахувати кількість `setName(<value>)` де value НЕ `null` → якщо 0 → dead state. Pair-check: якщо review-fix щойно видалив dead state з одного `<entity>/page.tsx` → пройти ВСІ інші list-pages (`grep -rln "DetailPanel\|<entity-name>Panel" apps/web/src/app/(app)`) і перевірити. Severity HIGH якщо state годує панель/модал що рендериться у JSX (feature мертва). Регресія-guard: vitest snapshot тест на JSX → щоб видалення DetailPanel не пройшло як silent regression.
- [ ] **URL deep-link writer без парного reader (Bug #596):** будь-який `router.push('/<page>?<param>=<value>')` де таргет-сторінка НЕ має `searchParams.get('<param>')` handler → deep-link мертвий (кнопка перекидає у голий список без візуальної відмітки/дії). Класика: `/supplier-payments/[id]` пушить `?highlight=<poId>` а `/purchase-orders/page.tsx` не читає → 0 UX-ефекту. Grep-команда: для кожного writer `grep -rnE "router\.(push|replace)\(\`?[/'\"]<page>[^)]_\?[a-z]+=" apps/web/src --include="_.tsx"`— витягти`<param>`name, потім`grep -n "searchParams.get\('<param>'\)" apps/web/src/app/\*\*/<page>/page.tsx`. Якщо 0 matches → broken deep-link. Fix pattern: (а) reader додає `useEffect(() => { const v = searchParams.get(<param>); if (v && ...валідно) { setState(v); params.delete(<param>); router.replace... } }, [])` — ідемпотентний, mount-only (свідомо БЕЗ deps щоб refresh не спамив дію); (б) якщо feature непотрібна — просто прибрати param у writer. Severity: LOW (broken UX-feature, не data loss); MEDIUM якщо feature розрекламована tooltip'ом/label'ом («відкрити картку X» → нічого). Where else: будь-який pair сторінок з cross-linking (`/counterparties/[id]`↔`/work-orders`, `/vehicles/[id]`↔`/work-orders`, `/invoices/[id]`↔`/counterparties`).
- [ ] **Review-fix completeness audit для крос-файлових патернів (Bug #341):** будь-який review-fix commit `fix(review): replace X with Y` що чіпає **N файлів** (наприклад заміна `.catch(() => {})` на `console.warn`) — після кожного такого commit пройти **ВЕСЬ codebase** на той самий патерн і переконатись що review знайшов УСІ файли. Grep-команда має бути така ж яка вживалась у review, але БЕЗ filter по changed-files. Типові пропуски: (а) сторінки `[id]/PageClient.tsx` коли review працював зі сторінкою у root (`/X/page.tsx`); (б) tabbed-content (`*Tab.tsx`) поза основним route файлом; (в) sub-components всередині той самий сторінки; (г) shared hooks/utilities у `apps/web/src/hooks` чи `lib`. Парний сигнал у git log: `git log --oneline | grep "fix(review)" | head -3` — для останнього review-fix-commit взяти grep-паттерн з нього (наприклад `\.catch(() => {})`) і виконати `grep -rn "<pattern>" apps/web/src --include="*.tsx" --include="*.ts" | grep -v <вже-виправлені>` → нові match = upskipped review (BUG нової tester-сесії). Виключення з cleanup: легітимні випадки документуються у самому місці (toast-double-protection, optional PWA SW, fire-and-forget telemetry) — тестер відрізняє за наявністю парного user-feedback каналу (toast/setError/console.warn вище у фукнції). Severity: успадковує severity оригінального review-fix bug-у. Grep шаблон: `git show --stat <last-review-commit> -- '*.tsx' '*.ts' | awk '/^ /{print $1}'` — список файлів review-fix; для кожного знайденого згодом match → перевірити чи серед них. Якщо ні → bug.
- [ ] **Хардкоджений label службової/обчисленої колонки колізує з користувацьким полем даних тієї ж назви (Bug #626):** будь-яка динамічна таблиця-конструктор (Report Builder, pivot, будь-який `cols.map(c => <th>{c.label}</th>)`) що додає ПОРУЧ службову колонку з **хардкодженим label-літералом** (`<th>Кількість</th>`, `<th>Всього</th>`, `<th>Разом</th>`) — перевірити чи цей літерал може збігтися з `label` користувацького поля даних, яке юзер має право вибрати у ту ж таблицю. Сценарій: merge-count колонка має назву «Кількість», а поле даних `quantity` у 6+ сутностей реєстру теж має label «Кількість» → сценарій «Товар + Кількість» рендерить ДВІ сусідні колонки «Кількість» з різним сенсом (сума vs лічильник). Aggregate-колонки НЕ страждають (мають префікс Σ/сер./мін./макс.). Grep: `grep -rnE "<th[^>]*>\s*(Кількість|Всього|Разом|Сума|Ціна)\s*<" apps/web/src/app --include="*.tsx"` → для кожного хардкод-літерала перевірити чи існує registry-поле з тим же label поряд у тій же таблиці (`grep -n "label: '<той-же-текст>'" apps/api/src/modules/*/registry*.ts`). Fix: службовій колонці дати унікальну назву що НЕ збігається з жодним полем даних (merge-count → «Склеєно»); АБО зробити label умовним за режимом (`{hasGroups ? 'Кількість' : 'Склеєно'}` — grouped=розмір групи node.count, flat-merge=скільки склеєно). Severity MEDIUM (дані коректні, вирівнювання коректне, але дублювання назв вводить в оману — особливо у головному сценарії фічі). Виявляється ЛИШЕ живою eyes-on перевіркою (§5.4) — colspan-вирівнювання (що перевіряє review) при цьому цілком коректне. Де шукати ще: будь-яка pivot/matrix-таблиця де юзер вибирає колонки + движок домішує обчислені (count/subtotal/rank) з фіксованими назвами.

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
- [ ] **Secret at-rest via Prisma `$extends` (Bug #652):** якщо секрет (apiKey/licenseKey/pinCode/token) шифрується розширенням `withFieldEncryption` (encrypt-on-write/decrypt-on-read) — ОБОВ'ЯЗКОВО перевірити:
  - (а) **Integration-тест наскрізного циклу проти живої БД** (не лише unit round-trip crypto-хелпера). Будувати клієнт ТОЧНО як `PrismaService.onModuleInit` (та сама композиція розширень, той самий порядок). Довести: raw `$queryRawUnsafe` колонки = `enc:v1:`+не містить plaintext; read через розширення = plaintext; legacy-plaintext рядок (raw INSERT) читається без змін; update без секрету не робить подвійне шифрування. Guard skip якщо БД down, але реально біжить коли є (не fake-green). uuid-bind у raw кастити `$1::uuid`.
  - (б) **Consumer читає розшифроване:** кожен провайдер-виклик / external-API header що споживає секрет читає його через РОЗШИРЕНИЙ client (`this.prisma`), НЕ через `new PrismaClient()` чи `$queryRaw`. Grep: `grep -rn "new PrismaClient" apps/api/src --include="*.ts" | grep -v "spec\|prisma.service"` = 0; `grep -rniE "queryRaw.*(apiKey|licenseKey|pinCode|secret|token)" apps/api/src` (не spec) = 0.
  - (в) **Секрет не витікає:** response-DTO-мапер / Redis-кеш / sync-експорт НЕ включають розшифроване поле (лише `hasX`-прапорець). Мапер має явно омітити секрет; sync PULL/PUSH tables мають виключати таблиці-носії секретів.
  - (г) **`where`-фільтр на зашифрованій колонці** — лише null-checks (`{ not: null }`) валідні (індиферентні до шифрування); `equals/contains/startsWith/in` на ciphertext-колонці = завжди-промах (баг). Grep: `grep -rnE "(apiKey|smsApiKey|licenseKey|pinCode):\s*\{?\s*(equals|contains|startsWith|in)" apps/api/src --include="*.ts" | grep -v spec`.

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

# Новий external-API HTTP-клієнт/gateway з fetch — ЗАВЖДИ потребує власного spec (Bugs #683-#687).
# Processor-spec мокає клієнт цілком → SSRF/timeout/auth-header/3xx/401 клієнта невидимі CI.
for f in $(git diff HEAD --name-only | grep -E "client\.ts$|gateway\.ts$|provider\.ts$"); do
  grep -q "fetch(\|axios\." "$f" 2>/dev/null && { [ -f "${f%.ts}.spec.ts" ] || echo "MISSING client spec (external-API): $f"; }
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

- [ ] **Dedup invariant додано після simplify-to-Promise.all БЕЗ regression-guard (Bug #489):** simplify/optimize-цикл що замінив sequential `for-loop { await tx.X.update(...) }` на `await Promise.all(plan.map(u => tx.X.update(...)))` І додав `const dedupedPlan = deduplicateBy(plan, u => u.pk)` ПЕРЕД Promise.all → ПОТРЕБУЄ regression-guard у парному `*.service.spec.ts`. Без нього refactor що дропне `deduplicateBy` (наприклад «бачу dead code на унікальному масиві») пройде CI зеленим, а production-дані з duplicate-PK (PO multi-lot lines на той самий goodId, xlsx-import з повтором SKU) → race-deterministic ОДНОГО winner серед N writes на той самий PK → silent data corruption. Grep: `grep -rn "deduplicateBy\|new Map(.*\.map.*=> \[" apps/api/src/modules --include="*.service.ts" -l` → для кожного service знайти парний spec → `grep -cE "deduplicate|duplicate.*(goodId|lineId|id)" $spec` = 0 → bug. Regression-guard test: 2 entries з ОДНИМ PK + різні compute results → `expect(prisma.<model>.updateMany).toHaveBeenCalledTimes(1)` (НЕ 2!) + `data: { <field>: <last-value> }` (last-wins). Severity MEDIUM.

- [ ] **Widened return-type service method + stale 2-field mock/assert у paired spec (Bug #508-#509):** будь-який commit що розширює сигнатуру service-методу (`Promise<{ id, number }>` → `Promise<{ id, number, status, amount, documentDate }>`) АБО розширює `select`-clause у Prisma read І додає mapping (Number(decimal), date.toISOString()) ОБОВ'ЯЗКОВО оновлює: (а) `*.service.spec.ts` mock щоб `mockResolvedValue` повертав ВСІ нові поля з реалістичними значеннями (Decimal/Date типи якщо service map їх перетворює); (б) `*.service.spec.ts` assert через `expect(result).toEqual({...5-полевий-shape...})` (НЕ `expect.objectContaining` що дозволяє регресію видалення полів); (в) `*.contract.spec.ts` `serviceMock.X.mockResolvedValueOnce({ all-fields })` + `expect(res.json()).toEqual({...})` (НЕ `toMatchObject({ id, number })` — підмножина не блокує регресію). Без оновлення: service mock повертає 2 поля → service map дає `NaN` для `Number(undefined)`, `null` для `(undefined).toISOString()`, `undefined` для нових полів → unit test червоний з cryptic message `expected { …(5) } to deeply equal { …(2) }` — release-blocker baseline. Парне для contract spec: `toMatchObject({ id, number })` пропускає `undefined`/`null` у нових полях → contract spec проходить АЛЕ silently не покриває нові wire fields → refactor що видалить status/amount/documentDate з `select` пройде CI green → FE отримує undefined → status badge сирий код. Sprint-pattern: тестова симуляція оновлюється з 1-2 commit'ам лагом vs implementation. Grep для виявлення: `git diff HEAD~3 HEAD -- "*.service.ts" | grep -E "^\+\s+(status|amount|documentDate|[a-z]+At):\s*(true|inv\.|Number|\.toISOString)"` → для кожного match у select/mapping → перевірити mock у `*.service.spec.ts` + asserts у contract+service spec на повний shape. Парне з Bug #390 (stale regression-guard після URL/payload-format fix). Severity HIGH (baseline-blocker якщо unit; MEDIUM regression-guard gap якщо contract).

- [ ] **Stale `$transaction` callback mock (Bug #489 sub-pattern):** spec мок `$transaction: vi.fn(async (ops: unknown[]) => ops)` (повертає arg напряму) НЕ виконує callback-форму `$transaction(async tx => { ... })` — INNER логіка $transaction body МОВЧКИ пропускається. ВСІ assert-и на `tx.X.updateMany`/`tx.priceHistory.createMany`/`tx.<model>.X` у тестах **проходять як зелені без виклику** → defense-in-depth orgId guards, dedup invariants, FSM side-effects не покриті. Шаблон правильного моку: розпізнавати ОБИДВІ форми + виконувати callback з `prisma` як `tx`:

```ts
$transaction: vi.fn().mockImplementation((arg: unknown) => {
  if (Array.isArray(arg)) return Promise.all(arg as Promise<unknown>[]);
  if (typeof arg === 'function') return (arg as (tx: unknown) => Promise<unknown>)(prisma);
  return Promise.resolve(arg);
}),
```

Grep: для кожного `$transaction(async ... =>` у service.ts → у парному spec.ts шукати `$transaction:.*async\s*\(\s*ops`/`async\s*\(\s*op` (старий array-only мок) → bug. Severity HIGH (стирає весь test-coverage внутрішнього $transaction body — інші regression-guard checklist items неефективні).

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
- [ ] **Sibling-panel stale state після parent-action створив child resource (Bug #409):** будь-який shared UI компонент (`LinkedDocumentsPanel`, `RelatedX`, `HistoryX`, `DocumentsTab`, `PaymentsList`) що приймає parent ID і робить `useEffect(() => fetch(`/X/:id/related`), [parentId])` — потенційно stale якщо ВЕРШИНА компонент-tree має action button (Виставити рахунок / Створити запит / Згенерувати слот) що POST-ить на endpoint що змінює related-resources. Сценарій: tab "Документи" вже відкритий → користувач тисне footer-button "Виставити рахунок" → toast.success → tab "Документи" показує СТАРИЙ список (новий invoice не з'являється до manual tab-switch). Grep: `grep -rnE "useEffect\(.*\[[a-zA-Z]+Id\]" apps/web/src/components/ui --include="*.tsx" -B 5 -A 10 | grep -B 12 "apiFetch"` — для кожного знайденого "viewer" компонента шукати його usage у parent з handle\\w+ що робить POST/PATCH/DELETE на endpoint що змінює дані viewer-у. Fix-pattern: prop `refreshKey?: number` → useEffect deps `[parentId, refreshKey]`; parent useState + інкремент після успішної action. Альтернатива: React Query з invalidate cross-component. Severity MEDIUM (UX, eventual refresh через manual remount). HIGH для critical financial panels. Регресія-guard: vitest component test — render → fetch1 → rerender з bumped refreshKey → fetch2 fired (2 apiFetch calls). Парне: ОБОВ'ЯЗКОВО `setPreview(null)` (або інший derived item-reference state) у тому ж useEffect — інакше popup/preview тримає stale-item.

- [ ] **Bind-once `useEffect([])` listener кличе проп напряму → stale closure (2026-09-06):** shared overlay/popup/modal що робить `document.addEventListener('keydown'|'click'|...)` у `useEffect(..., [])` і всередині handler-а кличе проп-колбек НАПРЯМУ (`onClose()`/`onConfirm()`) замість `ref.current()`. `[]` замикає mount-версію пропа → після ре-рендера батька з новою інлайн-стрілкою listener кличе СТАРИЙ колбек. Grep: `grep -rnE "addEventListener\('(keydown|keyup|click|mousedown)'" apps/web/src/components --include="*.tsx" -A 8 | grep -B4 -E "on[A-Z][a-zA-Z]*\(\)" | grep -v "\.current\("` — кожен match де deps ефекту `[]` і колбек — проп = баг. Fix: `const cbRef=useRef(cb); cbRef.current=cb;` (поза ефектом), handler кличе `cbRef.current()`, deps лишаються `[]`. JSX-обробники (onClick) переводити на ref НЕ треба — вони свіжі на кожен render; ref потрібен ЛИШЕ у document-listener всередині bind-once ефекту. Regression-guard: `render(onClose=first) → rerender(onClose=second) → keyDown Escape → expect(second) 1×, expect(first) 0×`. Дискримінація: revert `ref.current()` → `cb()` → тест червоніє. Severity: MEDIUM (HIGH якщо колбек — submit/delete зі stale id). Де ще: `ConfirmDialog`, `CommandPalette`, `Modal`, будь-який `useHotkey`; загалом будь-який bind-once listener/subscription/interval що читає проп чи змінний state.

- [ ] **Stale regression-guard test після backend-compat URL/payload fix (Bug #390):** будь-який `fix(<area>): <change> X serialization format` / `fix(<area>): remove [] suffix` / `fix(<area>): switch to camelCase keys` commit що ЗМІНЮЄ форму запиту (URL params / body keys / header values) ОБОВ'ЯЗКОВО оновлює парний `*.test.tsx` що асертить старий формат. Симптом: web baseline test suite червоний на `expect(url).toContain('<old-form>')` АБО `expect(payload).toEqual({ <old-key>: ... })`. Особливо підступно з URL-encoded формами: тест шукає `categoryIds%5B%5D=` (URL-encoded `[]`), фікс шле `categoryIds=` (репитед keys) → `.toContain` фейлиться, але повідомлення помилки виглядає як «component-bug» а не «test-stale». tsc green бо це runtime string assertion. API contract spec теж може не ловити (mock-based, не реальний parser). Grep для виявлення PRE-commit: `git diff HEAD~3 HEAD -- 'apps/web/src/**/*.tsx' | grep -E "^\+.*params\.(append|set)\b" | grep -v test` → кожен match — pair-check `__tests__/<Component>.test.tsx` на `.toContain(<param-name>` і `.toContain(<encoded-bracket>`. Альтернативний detection: червоний `vitest run` у baseline + `.toContain('%5B%5D')` у failing test. Severity: CRITICAL коли весь web suite червоний (release-blocker baseline → майбутні tester-сесії ховають реальні регресії за шумом). Fix-pattern: оновити assertion на новий формат + ДОДАТИ negation guard `expect(url).not.toContain('<old-form>')` як regression-guard щоб майбутня «спроба повернути старий формат» не пройшла CI зеленою. Парне з §1.5 «query-shape fix потребує service-spec» (Bug #163) — той самий принцип «після fix-у синхронізувати парний spec», але для frontend URL-serialization.

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

**⚠️ Слабкий асерт (Bug #625)** — «доказовий» асерт має бути scoped до цільового піддерева, не page. Grep-детектор фіктивних guard-ів:

```bash
# Широкий page-level селектор для «з'явився результат» при наявних службових decoy-контролах
grep -rnE "page\.locator\('button\[aria-expanded\]'\)\.first|page\.getByRole\('(button|table|tab|listitem)'\)\.first|page\.locator\('table'\)\.first" apps/web/e2e
# Для кожного match: чи є на сторінці ІНШИЙ елемент того ж роду (хедер-тоггл з aria-expanded,
# службова кнопка/таблиця)? Якщо так → scope до контейнера результату (table.locator(...)) +
# позитивні якорі стану (thead th=='Група', count>1, очікувані лейбли) + негативний якір анти-стану.
# Sanity: тимчасово «зламати» очікуваний стан — тест МАЄ почервоніти; якщо лишився зелений → асерт слабкий.
```

### 5.3 — Component-тести (Testing Library)

```bash
grep "@testing-library" apps/web/package.json || \
  pnpm --filter @sto/web add -D @testing-library/react @testing-library/user-event @testing-library/jest-dom jsdom
find apps/web/src -name "*.test.tsx" | sort
pnpm --filter @sto/web exec vitest run --reporter=verbose 2>&1 | tail -30
```

### 5.4 — User-path verification (ОБОВ'ЯЗКОВО для UI-фіч)

> **Клас багів «функція недосяжна через UX»:** бекенд коректний, API повертає правильне,
> АЛЕ користувач не може досягти результату через інтерфейс (напр. поле кладеться не в ту
> зону; єдиний спосіб — ненадійний drag; немає сигналу «що робити»). API-верифікація
> (`Σ==grandTotal`, 200-статус) ЦЕ НЕ ЛОВИТЬ. Реально траплялось: «не групує» × 3 повернення.

Для **будь-якої UI-фічі** (нова сторінка / компонент / interaction) — окрім API-перевірки
пройти **шлях реального користувача** через Playwright MCP і зробити скріншот РЕЗУЛЬТАТУ:

- [ ] Пройти сценарій кліками (не прямим `fetch` у `page.evaluate`) — так, як це робить юзер.
- [ ] `browser_snapshot` / скріншот кінцевого стану → **очима перевірити** що видно ОЧІКУВАНЕ,
      а не порожній/плоский/помилковий результат.
- [ ] Якщо результат недосяжний або незрозумілий без інструкції → це **UX-баг**, фіксувати як
      баг коду (додати сигнал/підказку/явний елемент керування), не лишати на «поясню текстом».
- [ ] Головний happy-path закріпити E2E-тестом що йде **через UI-контроли** (клік кнопки),
      а не лише через API-конфіг — інакше регресія UX пройде мовчки.

Мінімум (якщо MCP недоступний) — E2E що проходить фічу через видимі контроли + асерт що
кінцевий стан містить очікуваний елемент (група/сума/рядок), не лише статус 200.

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

### 2026-09-07 — data-міграція сідить «увімкнений але порожній» рядок у новій registry-таблиці → тінить legacy read-fallback → тихий outage вже-налаштованих сутностей після deploy — backend / db-міграція / CRITICAL

**Сигнал:** registry-рефакторинг (хардкод-провайдер → таблиця конфігів + вибір активного) з політикою «нова таблиця = джерело правди, БЕЗ неї — legacy read-fallback на старі колонки». Резолвер має 2-крокову форму: `crок 1 = findFirst(new-table, enabled:true)` → якщо є, ПОВЕРНУТИ; `крок 2 = legacy-fallback` (досягається лише коли крок 1 порожній). Additive-міграція СІДИТЬ рядки у нову таблицю з наявних записів — але залишає секрет-поле (`credentials`) **NULL** (бо старі секрети лежать зашифровані в окремих колонках і їх ризиковано/незручно копіювати at-rest у нову схему). **Пастка:** сід ставить `enabled=true`, тож крок 1 ТЕПЕР знаходить рядок для кожної сутності → повертає його з **порожніми кредами** (`parseCreds(null)={}`) і НІКОЛИ не доходить до legacy-fallback, у якому лежать реальні секрети. Downstream провайдер кидає «не задано ключ/токен» → **тихий повний outage** саме тих сутностей, що працювали до деплою — з'являється лише при `migrate deploy`, не на dev (де сіду не було). Grep-сигнал: сід `INSERT ... enabled = true|<flag>` з `credentials`/секрет-колонкою поза списком INSERT (=NULL) + резолвер що повертає крок-1-рядок БЕЗ перевірки повноти кредів. **Асиметрія-детектор:** якщо у ТОМУ Ж сервісі є parallel-метод (`resolveByCode`), який МАЄ `hasCreds`-guard перед поверненням, а `resolveActive` — ні → майже напевно баг (один написали з захистом, інший забули).

```bash
# 1. Міграції що сідять enabled-рядок у нову registry-таблицю, лишаючи секрет NULL:
grep -rn "INSERT INTO.*_config\|enabled.*true\|::\"ProviderKind\"" packages/database/prisma/migrations/ | grep -iv "credentials\|token\|secret\|licenseKey"
# 2. Резолвер: крок-1 повертає рядок БЕЗ hasCreds-guard, поки sibling-метод його має:
grep -n "hasCreds\|parseCreds\|return.*credentials" apps/api/src/modules/**/provider-config.service.ts
# Асиметрія: один метод має if(hasCreds(...)) перед return, інший — return напряму → баг.
```

**Причина виникнення:** розробник (і review) міркує про два стани нової таблиці — «рядок є» (використати) / «рядка нема» (legacy-fallback) — і пропускає третій, який САМ і створив у міграції: «рядок є + enabled, але НЕПОВНИЙ (секрет ще у legacy-колонках)». Сід-коментар навіть декларує «сервіс має legacy-fallback коли credentials порожні» — але код падає у fallback лише за ВІДСУТНОСТІ рядка, не за порожнечею кредів у ньому. Unit-специ подають config-рядок з непорожнім `credentials` JSON (щасливий стан UI-збереження), тож сід-стан `credentials=NULL+enabled=true` не тестується → tsc+unit зелені, ламається лише на реальному деплої.

**Підхід до виявлення:** для КОЖНОГО резолвера-з-fallback — тест «enabled-рядок є, але credentials=NULL (сід-стан)» → assert повертаються РЕАЛЬНІ креди з legacy (не `{}`), і лише для ТОГО Ж провайдера (`legacy.provider===row.provider`, інакше `null` — не плутати чужі креди). Плюс «enabled-рядок без кредів + legacy іншого провайдера → null». **Mutation-verify:** прибрати hasCreds-guard (повернути безумовний `return row`) → сід-fallback-тести МУСЯТЬ впасти (доводить що зелений тест ловить саме порожні-креди-після-сіду). Загальний прийом: тестувати резолвер у стані, який залишає САМЕ МІГРАЦІЯ, не лише у стані, який залишає щасливий UI-write.

**Підхід до фіксу:** резолвер крок-1 — після знаходження enabled-рядка перевірити повноту кредів (`hasCreds(parseCreds(row.credentials))`); якщо порожні → впасти у legacy-fallback ДЛЯ ТОГО Ж провайдера (`legacy && legacy.provider===row.provider ? {...legacy, apiUrl/mode з нового рядка} : null`). Дзеркалити вже-наявний захист sibling-методу (`resolveByCode`). Альтернатива «сідити реальні креди у нову таблицю» гірша — копіювання зашифрованих секретів між схемами at-rest ризиковане; runtime-fallback безпечніший і збігається з декларованим наміром сіду. Реальні креди резолвляться до першого перезбереження у новій формі.

**Severity:** CRITICAL — тихий повний outage (money/fiscal/будь-яка зовнішня інтеграція) на всіх раніше-робочих сутностях, тригериться звичайним `migrate deploy`, невидимий на dev і в unit.

**Де шукати ще:** будь-який registry-рефакторинг «хардкод → таблиця активного + legacy-fallback»: провайдери сповіщень (`NotificationChannelConfig`), ПРРО/еквайринг (`BranchProviderConfig` — цей), майбутні прайс-провайдери, SMS-шлюзи, будь-яка `*_config`-таблиця з additive-сідом що лишає секрет NULL. Спорідн.: цей рефакторинг дзеркалить provider-registry сповіщень — перевір чи там резолвер має той самий hasCreds-guard.

### 2026-09-07 — idempotency-лінк, що НЕ атомарний з money-write який він захищає → sequential re-entry double-create (reconcile/crash-recovery) — backend / money / CRITICAL

**Сигнал:** external-gateway money-flow (QR-оплата, будь-який async confirm) із «наміром» (intent/order), що переходить у термінальний-оплачено-статус через CAS (`updateMany where status:PENDING → PAID, count===1`), а ПОТІМ окремим write створює доменний money-запис (`payments.create` → Payment+settlement+running-total) і **третім** write лінкує його назад у намір (`intent.update({paymentId})`). Часто є reconcile/crash-recovery гілка (review-fix): «якщо намір PAID але `paymentId==null` → створити money-запис знову» (щоб не втратити гроші після падіння між CAS і create). **Пастка:** три write НЕ атомарні. Якщо `create` закомітився, а `update({paymentId})` упав (транзієнт DB/Redis), намір лишається `PAID+paymentId=null` → наступний reconcile-poll бачить те саме → `create` ВДРУГЕ → **дубль Payment/settlement/running-total = тихий double-charge**. jobId single-flight НЕ рятує (вікно послідовне, не конкурентне). Сам reconcile-фікс, доданий щоб не ВТРАТИТИ гроші, вводить дзеркальний баг — ПОДВОЇТИ гроші. Grep-сигнал: money-запис у reconcile/finalize-гілці БЕЗ pre-create existence-guard і БЕЗ `@unique`-лінку на джерело.

```bash
# intent/order-driven money-create у processor/reconcile без унікального лінку:
grep -rn "paymentId.*null\|reconcile\|finalize" apps/api/src/modules/**/*.processor.ts | grep -v spec
# для КОЖНОГО money-create у такій гілці — чи є @unique колонка-лінок на source-намір?
grep -rn "onlinePaymentIntentId\|@unique" packages/database/prisma/schema.prisma | grep -i "payment\|intent\|order"
```

**Причина виникнення:** розробник (і review-фікс) розмірковує лише про два стани збою — «впав ДО create» (треба reconcile, щоб довести гроші) — і пропускає третій: «create вдався, лінк-write упав». CAS + jobId-дедуп створюють хибне відчуття «рівно один раз»: вони справді боронять КОНКУРЕНТНИЙ подвій, але не ПОСЛІДОВНИЙ повтор коли стан-прапорець (`paymentId`) не відображає реально-створений запис. `payments.create` не має природного dedup-ключа на намір → ніщо не боронить другий INSERT.

**Підхід до виявлення:** для КОЖНОЇ reconcile/finalize-гілки що створює money-запис — тест «create-succeeds-then-link-fails»: намір `PAID+paymentId=null`, а money-таблиця ВЖЕ містить запис для цього наміру → assert `create` НЕ викликано вдруге + наявний запис лише до-лінковано. Плюс «P2002 на create (гонка)» → дістає winner і лінкує, не термінальна помилка. **Mutation-verify:** вимкнути pre-create existence-guard (`existing = null && ...`) → double-create-тест МУСИТЬ впасти (це доводить що зелений тест ловить саме подвій). Також покрити: CAS `count===0` → no second create (конкурент); crash-recovery PAID+paymentId=null → create коли запису ще НЕМА (mutation: вимкнути reconcile-гілку → «гроші втрачено»-тест падає); idempotent PAID+paymentId set → no-op.

**Підхід до фіксу:** додати `@unique` колонку-лінок на джерело у money-таблицю (`Payment.onlinePaymentIntentId String? @unique` — additive nullable, backward-compat міграція) → БД фізично боронить другий INSERT (P2002). У finalize: (1) pre-create `findFirst({orgId, <link>})` — якщо запис уже є (лінк-write минулого разу впав), лише до-лінковуй, create НЕ повторюй; (2) на `P2002` з create (гонка) — дістань winner і залінкуй (успіх, не помилка, не re-enqueue). Це закриває і послідовне вікно (pre-check), і конкурентне (unique-констрейнт). Money-таблиця з новим полем: перевір чи не секрет (ENCRYPTED_FIELDS) і що syncVersion-політика незмінна.

**Severity:** CRITICAL — тихий double-charge клієнта, без cap-захисту (reconcile-шлях часто скидає лічильник спроб), виявляється лише звіркою gateway↔Payment.

**Де шукати ще:** будь-який async-confirm money-flow із intent/order + окремим лінк-write: online-payments (monobank QR), майбутні card/apple-pay, ПРРО-чек↔Payment лінк, loyalty-earn↔Payment, будь-який BullMQ processor що робить `X.create` у reconcile/retry-гілці за станом-прапорцем. Спорідн.: review-fix 025bf77f (reconcile-гілка яка й породила вікно), Bug #688 (цей), FIN-C1 (CAS ідемпотентність але у ОДНІЙ транзакції — контраст: там безпечно бо create+CAS атомарні).

### 2026-09-06 — list-endpoint query-фільтри (date-range + enum) та retry-action відвантажені з 0 unit, поки create() добре покритий — backend / coverage-gap / HIGH

**Сигнал:** фіча Фази-2 додає `findAll(opts)` з набором query-фільтрів (date-range, enum-eq, FK org-scoped) + `findOne` + action-метод (`retryFiscal`/`retryX`), а `.spec` покриває ЛИШЕ `create()` (грошовий happy/CAS). Класичний drift: складна create-логіка «заслуговує» тестів, а «простий» findAll/filter «очевидний» → 0 покриття саме на review-фіксах, які туди й лягли. Два підпатерни ловляться grep-детекторами:

- **(A) date-only `lte` inclusive-of-day.** Фронт шле `YYYY-MM-DD`; `new Date('2026-09-06')` = **midnight UTC** → голий `createdAt.lte = new Date(dateTo)` виключає всі записи того ж дня (платіж о 15:00 не потрапляє у діапазон `dateTo=сьогодні`). Правильно: `new Date(dateTo + 'T23:59:59.999Z')` (і `dateFrom + 'T00:00:00.000Z'` для симетрії). Grep: `grep -rn "lte.*new Date([a-zA-Z].*dateTo\|lte.*new Date(opts" apps/api/src/modules/ | grep -v "T23:59:59"`.
- **(B) query-string enum-cast без guard → 500.** `where.enumField = opts.x as EnumType` без валідації → `?x=garbage` каститься і доходить до Prisma → **HTTP 500 (не-i18n, шум у Sentry)**, а не тихе ігнорування як для будь-якого нерозпізнаного query-параметра. Правильно: `const VALUES = new Set(Object.values(EnumFromPrisma))` (enum-driven, без хардкоду) + `if (VALUES.has(opts.x)) where.x = opts.x`. Grep: `grep -rn "where\.\w* = opts\.\w* as \|as Prisma\.\w*WhereInput" apps/api/src/modules/ | grep -v "\.has("`.

**Причина виникнення:** розробник вважає CRUD-list «тривіальним» і що ParseUUIDPipe/class-validator ловлять усе — але вони НЕ валідують `@Query('x') x?: string` вільні рядки (date, enum-як-string) що йдуть у сервіс сирими. `new Date('YYYY-MM-DD')` мовчазно дає midnight (виглядає «як дата»), а enum-cast компілюється (`as`), тож обидва проходять tsc+create-тести й падають лише на живому запиті з крайовим вводом.

**Підхід до виявлення:** для КОЖНОГО нового list/filter-методу — дістати `where`, з яким викликано `findMany` (`prisma.X.findMany.mock.calls[0][0].where`), і асертити межі/фільтри напряму: `createdAt.lte.toISOString() === '...T23:59:59.999Z'`, `createdAt.gte === '...T00:00:00.000Z'`, enum valid→eq, `'none'`→`null` (IS NULL, ключ присутній), **garbage→`'x' in where === false` + `resolves` (no 500)**, FK org-scoped (валідний→where + findFirst orgId; чужа org→NotFound + findMany НЕ викликано), where завжди містить orgId, pagination clamp. Для retry/action-методу: усі guards (`receiptId set`→400 БЕЗ enqueue; `!=FAILED`→400; happy→update+queue.add; queue reject→`.catch` FAILED + resolves; cross-org→NotFound) + **порядок guards** (idempotency-guard ПЕРЕД status-guard). **Mutation-verify обидва review-фікси:** відкат `new Date(dateTo)` (midnight)→inclusivity-тест падає; прибрати `VALUES.has()`→garbage-тест падає.

**Підхід до фіксу:** tests-only коли логіка вірна (0 функціональних дефектів, як #678-#682). Якщо grep-детектор (A)/(B) знайшов сирий cast/midnight lte у СЕРВІСІ без review-фіксу — це реальний баг (HIGH: пропущені записи / 500), фікс = дзеркалити sibling-сервіс (`supplier-payments.service` для date-range) + enum-Set guard.

**Severity:** HIGH (A: тихо пропущені фіндокументи у звіті за день; B: 500 на публічному list-endpoint від тривіального query-параметра).

**Де шукати ще:** будь-який `findAll` з `@Query` date-range або enum-status-фільтром: payments, supplier-payments, invoices, work-orders, stock-documents, purchase-orders, reports/builder. Спорідн.: sto-review f33edc2c (ті самі 2 детектори у review-чеклісті), Bug #595/#616 (date-only DTO semantic).

### 2026-09-06 — авторитетна denormalized-колонка з derived-Σ фолбеком у toDto + partial-payment CAS money-flow — backend / coverage-gap / HIGH-MEDIUM

**Сигнал:** фіча вводить нову авторитетну колонку-накопичувач (`Invoice.paidAmount`, `PurchaseOrder.receivedAmount`, `WorkOrder.paidAmount`), що транзакційно оновлюється у грошовому/кількісному flow, ПЛЮС паралельно існує похідна сума з дочірніх рядків (`Σpayments.amount`, `Σlines.receivedQty`). `toDto` пише фолбек `col != null ? Number(col) : (children ? children.reduce(...) : undefined)`. Часто відвантажується так: CAS-flow (updateMany where col=read-value → count=0 throw) має 1-2 щасливих тести, але БЕЗ: (A) послідовності часткова→повна з ненульової бази (paid=200 → доплата → PAID); (B) оплати РІВНО залишку (межа `>=amount-epsilon`); (C) overpay поверх часткової (не лише з нульової бази); (D) concurrency-моделі двох write через `count=1 → count=0`; (E) status-gate ВСІХ заборонених станів (не лише DRAFT); (F) manual-статус-переходу що синхронізує col=amount БЕЗ створення settlement (статус-узгодження ≠ платіж); (G) toDto-авторитетності (col vs розбіжний Σ, col=null фолбек, col=0 ≠ undefined).

**Причина виникнення:** розробник вважає CAS-happy-path достатнім і що «межа = очевидна». Але саме межі й перехрестя ховають гроші-баги: `>` замість `>=` лишає повністю оплачений рахунок у PARTIALLY_PAID; manual-PAID що ЗАБУВ синхронізувати col лишає «залишок» ненульовим назавжди; refactor що ДОДАВ settlement у manual-PAID-гілку → подвійний облік; toDto що впав на Σ замість col → показ суми-payments яка розходиться з авторитетним станом (refund/adjustment). Concurrency: два платежі читають col=0 на stale-snapshot; лише один CAS-updateMany виграє (count=1), другий count=0 → throw — без цього тесту зняття `if(count===0) throw` = тихий double-charge.

**Підхід до виявлення:** ганяти tx-callback mock ($transaction виконує callback з prisma-як-tx, щоб CAS updateMany/create РЕАЛЬНО викликались). Мінімальний money-набір: partial→full sequence, exact-remaining→PAID, overpay-from-partial→throw-ПЕРЕД-CAS, concurrency count=1→count=0 (assert create/settlement РІВНО 1×), кожен заборонений статус→throw, manual-terminal-status→col=amount+`settlements.createTransaction not.toHaveBeenCalled`, toDto(col vs розбіжний-Σ / col=null / col=0). **Обов'язково mutation-verify КОЖЕН money-guard:** нейтралізувати overpay-if (`false &&`), прибрати `col: read-value` з CAS-where, `false &&` на count=0-throw, прибрати `col: amount` з terminal-status-data, прибрати доданок у optimistic-статус — відповідний тест МУСИТЬ впасти. Fake-green на грошах гірший за відкритий баг.

**Підхід до фіксу:** зазвичай tests-only (логіка вірна — 0 функціональних дефектів, як #668-#677). FE-паралель: якщо optimistic-статус/remaining живуть inline у компоненті — винести у чистий helper (`lib/invoice-payment.ts`) і покрити unit-тестами (дзеркало backend CAS з ТИМ САМИМ epsilon), а не тягнути важкий component-render. Backfill-міграцію нової колонки перевірити на idempotency (ADD COLUMN IF NOT EXISTS, enum/FK guarded, backfill-UPDATE з WHERE що самонейтралізується при re-run).

**Severity:** HIGH для CAS/overpay/concurrency/manual-sync (гроші: double-charge, застряглий залишок, подвійний облік); MEDIUM для toDto-авторитетності (user-visible розбіжність суми).

**Де шукати ще:** будь-яка «running total» колонка + дочірні рядки: `Invoice.paidAmount`↔payments, `PurchaseOrder.receivedAmount/paidAmount`↔lines, `WorkOrder.paidAmount`↔payments, `SettlementAccount.balance`↔transactions, `StockItem.quantity`↔movements. Спорідн.: Bug #508/#1955 (denormalized-formula semantics у consumer), Bug #613 (concurrent pre-check→write row-lock), Bug #629 (roundMoney на похідних).

### 2026-09-06 — узагальнення поля до типізованого locator (phone→recipient) + per-channel selection + структуровані креди у одне поле — backend + frontend / coverage-gap / HIGH

**Сигнал:** фіча що узагальнює адресат/ідентифікатор з одного конкретного типу до багатотипного (`phone: string` → `recipient: string` де тип залежить від каналу; `token` → creds-об'єкт). З'являються: (A) per-channel/per-item селектор `TYPE_SET.has(x.channel) ? valueA : valueB` (`EMAIL_CHANNELS.has(c.channel) ? email : phone`), що будує ланцюг і **пропускає** крок без відповідного адресата; (B) mask/format-helper локатора у логах (`maskRecipient`); (C) новий provider зі **структурованими кредами** серіалізованими JSON-ом в одне поле (`apiKey = JSON.stringify({host,port,user,pass})`) + UI-форма з кількома інпутами замість одного токена + `credsReady = !!(f1 && f2 && f3)`. Тести часто покривають лише «type-A only» і «type-B only» ОКРЕМО, але НЕ змішаний набір з асертом типу в КОЖНОМУ кроці; mask-helper — лише «щасливий» вхід; структуровану-креди форму — взагалі 0 (фікстури лишились legacy single-token).

**Причина виникнення:** розробник тестує кожен канал ізольовано («SMS працює», «EMAIL працює»), вважаючи що змішаний випадок — механічна сума. Але саме на перехресті ховається найгірший регрес: селектор зламаний на `phone ?? email` (частий copy-paste/спрощення) → у EMAIL-крок тече телефон → nodemailer `to:'38067...'` = 500/тихий відкид, а обидва ізольовані тести лишаються зеленими. Mask-helper: email-гілка (`indexOf('@')>0`) і edge (порожній/короткий/no-@) виглядають «очевидно правильними» → не тестуються → регрес витікає повний email у логи (PII) або валить воркер. Структуровані креди: нова UI-гілка `code==='smtp'` невидима для legacy-фікстур → сериалізація в JSON (де EmailProvider.parseConfig очікує саме JSON) без покриття → регрес → сирий текст → parseConfig→null→усі email мовчки не йдуть.

**Підхід до виявлення:** (A) для кожного per-channel/per-item селектора — тест ЗМІШАНОГО набору `[typeA, typeB]` × усі комбінації наявності адресатів (`{a}`→B-крок відкинуто; `{b}`→A відкинуто; `{a,b}`→ОБИДВА, і **assert recipient КОЖНОГО кроку СВОГО типу** — `smsStep.recipient` без `@`, `emailStep.recipient` з `@`; `{}`→порожній ланцюг, job не ставиться). Mutation-check: замінити селектор на `a ?? b` → змішані тести падають. (B) mask/format-helper (навіть module-private — ганяти через публічний метод що логує): email-вхід (перша літера+`***@`домен, повний НЕ у лог), короткий (`≤N`→повне маскування), порожній (no-crash), no-@. (C) структуровані креди: тест нової provider-гілки UI — показ multi-field форми (не single token), `credsReady` вимагає ВСІ обов'язкові поля (по одному → disabled, усі → enabled), save-payload = очікуваний JSON-рядок (парсити назад і `toEqual`), дефолти (порожній порт→587), verify шле той самий JSON; плюс негатив: інший provider лишає single-token форму. Mutation-check: зламати `buildApiKey` (SMTP повертає сирий) → save/verify-тести падають. Backend-парний: NotificationLog/persist пише НОВУ колонку (`recipient`), не стару (`phone`) — assert `data.recipient` + `not.toHaveProperty('phone')`.

**Підхід до фіксу:** зазвичай tests-only (логіка вірна — 0 функціональних дефектів, як тут #658-#660). Якщо селектор реально зламаний — відновити типізований вибір per-channel (`SET.has(channel) ? typed : other`), НЕ `??`-fallback. Кожен доданий тест mutation-verified.

**Severity:** HIGH для селектора (тихий регрес → весь клас каналу не доставляється) і структурованих кредів (розрекламована фіча непридатна); MEDIUM для mask-helper (PII-витік/краш воркера на edge).

**Де шукати ще:** будь-яке узагальнення поля до багатотипного (push-token/webhook-URL/deviceId залежно від каналу); будь-який provider/integration зі структурованими кредами в одне serialize-поле (OAuth `{clientId,secret}`, DB-DSN, S3 `{key,secret,bucket}`); by-design обмеження де один caller передає лише підмножину адресатів (followup лише phone → EMAIL тихо skip) — підтвердити що НЕ крашить і задокументувати як intended, не «фіксити». Спорідн.: Bug #488 (`Partial<Record<Enum>>` fallthrough), Bug #401/#432 (FE↔BE symmetry).

### 2026-09-06 — «exclusive mutation» через multi-`updateMany` у `$transaction` + frontend «only-one-active» тріада — backend + frontend / tenant-isolation + coverage-gap / HIGH

**Сигнал:** нова фіча «активним може бути лише 1» (провайдер/метод/стратегія/default-flag) реалізована сервіс-методом виду `activateX(orgId, branchId, code)`, що робить prep-`findFirst({ id, orgId })` (валідує branch/parent), а потім `$transaction([updateMany(where: {..., key: {not: code}}, {enabled:false}), updateMany(where: {..., key: code}, {enabled:true})])`. Часто відвантажується з 0 тестів на сам `activateX` + 0 контрактних на endpoint. Дзеркальний frontend — per-item Switch що активує ексклюзивно + per-sub-item toggle що не має вмикати 2-й набір.

**Причина виникнення:** розробник вважає, що prep-`findFirst({id, orgId})` вже «зачинив» tenant-isolation для всього методу. Але prep перевіряє лише branch/parent-існування; самі масові `updateMany` матчаться по **бізнес-полю** (`provider`/`type`/`isDefault`), і `orgId` у їх where — окрема відповідальність кожного клозу. Легко забути `orgId` в одному з двох (особливо у `{ not: code }`-гілці) — локально «працює», бо dev-дані одноорганізаційні. `@@unique([branchId, key])` не рятує: updateMany не йде через unique-арбітраж. Frontend-бік: «Switch → POST activate» здається достатнім, але без empty-state guard активація без під-рядків = бек-no-op (updateMany 0 rows) → UI бреше «активовано»; без per-sub-toggle gate можна увімкнути канал 2-го провайдера → 2 активні → resolver змішує.

**Підхід до виявлення:** (backend) для кожного `$transaction([... updateMany ...])` перерахувати where-клози й підтвердити `orgId` (+ `branchId`) у КОЖНОМУ — не лише у prep. Найгостріший тест — cross-org: in-memory-store spec що моделює семантику updateMany (мутує рядки за where, повертає {count}); засіяти рядок org-2 з тим самим branchId+business-key; активувати для org-1; assert рядок org-2 НЕДОТОРКАНИЙ (обидва прапорці) + обидва where несуть orgId + soft-deleted не реактивується + exclusivity (рівно 1 набір enabled, навіть із «брудного» 2-enabled стану) + empty-state (0 rows → повертає {activeX}, no throw — idempotent by design). (contract) endpoint: ParseUUIDPipe(branchId)→400, DTO @IsString→400, whitelist відкидає orgId-з-body, доменні BadRequest→400/NotFound→404, orgId прокинутий з JWT. (frontend) тріада gate+empty-state+disabled, кожна mutation-verified.

**Підхід до фіксу:** якщо логіка вірна (двічі рев'юнута) — tests-only, як тут (0 функціональних багів). Якщо where втратив orgId — додати у кожен клоз. Обов'язково mutation-check: видалити orgId з одного updateMany → cross-org spec падає; нейтралізувати frontend-guard → відповідний тест падає. Fake-green (тест зелений і на зламаному коді) — гірше за відсутність тесту.

**Severity:** HIGH — backend-гілка = cross-org data corruption на масовому write (мовчазна, без error); frontend-гілка порушеної ексклюзивності = 2 активні набори → неконтрольована поведінка resolver-а (напр. сповіщення шле через обидва провайдери).

**Де шукати ще:** default-flag toggles (`setDefaultX` що `updateMany({isDefault:false})` на решті + `update({isDefault:true})`); status-exclusive switches; priority/reorder через bulk updateMany; будь-який `$transaction([...])` з ≥2 масовими write на org-scoped таблиці; frontend будь-де «активним лише один» / радіо-подібний Switch-набір. Спорідн.: Bug #191 (single-update orgId), Bug #628 (constraint-mapping across write-paths).

### 2026-09-06 — review-fix замінив хардкод-набір на metadata-driven gate (напр. `provider.templateChannels`), але regression-guard покрив не КОЖНУ гілку нового гейта — backend+frontend / coverage-gap / metadata-driven-gate / MEDIUM-HIGH

**Сигнал:** commit виду `fix(review):` вводить нове поле-метадані на абстракції (`NotificationProvider.templateChannels`, `PaymentProvider.supportsRefund`, `DocType.requiresApproval`) як ЄДИНЕ джерело правди, ЗАМІНЮЮЧИ раніше захардкоджені set-и і на бекенді (`resolveConfig`/валідація), і на фронті (`needsExternalTemplate`/умовний рендер поля). Поле читається у 3+ місцях: (A) resolver-gate (`filter(c => registry.get(c.provider)?.templateChannels?.includes(c.channel))`), (B) upsert/write-guard (force-null/reject коли канал не в наборі), (C) UI-видимість поля + submit-payload, (D) registry `list()`-мапінг що віддає поле фронту (`?? []`). Тести часто покривають 1-2 «очевидні» гілки (positive-VIBER included, negative-turbosms excluded), а решту матриці — ні. Grep-детектор:

```bash
# нове metadata-поле-гейт у diff review-fix — скільки гілок і чи всі покриті?
git log --oneline -8 | grep -iE "fix\(review\)|review-fix"
grep -rnE "readonly \w+Channels\??:|readonly supports[A-Z]|\.\w+Channels\?\.includes\(|templateChannels" apps/api/src --include="*.ts" | grep -v spec
# для КОЖНОГО місця читання поля — чи є парний тест на INCLUDED і на EXCLUDED гілку?
# registry/list()-мапінг (`?? []`) — чи має власний spec проти РЕАЛЬНИХ impl? (моки list() не ловлять регрес мапінгу)
ls apps/api/src/modules/<mod>/providers/*registry*.spec.ts   # часто відсутній
# threading поля крізь processor у provider.send — чи є assert `send.mock.calls[0][0].<field>`?
grep -n "<field>:" apps/api/src/modules/<mod>/*.processor.ts   # рядок є → потрібен guard
# frontend: чи фікстура тесту має провайдера З metadata-полем? (часто лише legacy без нього)
grep -n "templateChannels\|<field>" apps/web/src/**/*.test.tsx
```

**Причина виникнення:** розробник/рев'ювер вважає «замінив хардкод на метадані + додав тест на головний кейс → досить». Але суть гейта — саме матриця (channel × provider → in-set / out-of-set), і кожна комбінація — окрема тиха гілка: out-of-set inline-канал з випадковим template-id має бути ВИКЛЮЧЕНИЙ (інакше порожній send), in-set без template-id теж ВИКЛЮЧЕНИЙ (нема джерела тексту). Registry `list()`-мапінг (`?? []`) невидимий бо інші specs мокають `list()`, а не будують реальний registry. Threading поля у processor→send — один рядок, який refactor легко викидає. Frontend-фікстура лишається на старому провайдері без нового поля → уся metadata-гілка UI без покриття (типово sync-agent це і сигналить: «файл фікстурить лише legacy-провайдера»).

**Підхід до виявлення:** для нового metadata-gate побудувати ПОВНУ матрицю і закрити guard на кожну клітинку: (1) in-set канал + метадані-джерело → INCLUDED; (2) in-set канал БЕЗ джерела → EXCLUDED; (3) out-of-set канал з випадково-присутнім метаданим → EXCLUDED (anti-empty/anti-wrong-op — це і є суть fix); (4) write-guard force-null/reject для out-of-set; (5) `list()`/registry-мапінг проти РЕАЛЬНИХ impl (не мок) — поле є, тип масив, out-of-set значення відсутнє; (6) threading крізь processor → `expect(send.mock.calls[0][0].<field>).toBe(...)`; (7) frontend: фікстура З metadata-полем → поле показ/схов за клітинкою матриці + submit-payload включає/виключає поле + prefill. Плюс empty-payload шлях (renderTemplate('')='' для template-каналу → send без крашу, без порожнього повідомлення).

**Підхід до фіксу:** тести-only якщо логіка вірна (як тут — код двічі рев'юнуто, 0 функціональних багів). Новий `*registry*.spec.ts` проти реальних impl (не моків). Frontend: додати фікстуру з metadata-полем + `describe`-блок на всю матрицю (керувати `combobox`-select-ом каналу, асертити PATCH-body/DOM-видимість — тест падає якщо гейтинг зламано, не fake-green).

**Severity:** MEDIUM-HIGH за blast-radius: сповіщення=MEDIUM (тихий порожній лист/пропущений канал), платіж/refund/approval-gate=HIGH. Frontend-гілка розрекламованої фічі (задати Viber/Telegram-шаблон) без покриття = HIGH (тихий регрес блокує налаштування).

**Де шукати ще:** будь-який `readonly <x>Channels?`/`supports<X>`/`requires<X>` на provider/strategy/policy-абстракції; registry/factory `list()`-мапінг з `?? []`/`?? default`; будь-яке metadata-поле що ОДНОЧАСНО гейтить backend-resolver І frontend-видимість поля (симетрія BE↔FE, спорідн. Bug #401/#432); processor що пробрасує опційне поле у зовнішній `send`/`call`. Правило: review-fix «замінив хардкод-set на метадані» → матриця (варіант × канал) з guard на кожну клітинку, не лише diagonal.

### 2026-09-06 — Prisma `$extends` field-encryption (encrypt-on-write/decrypt-on-read) відвантажено з 0 інтеграційних тестів наскрізного циклу — backend / security / db / at-rest-crypto / HIGH (regression-guard для критичного класу)

**Сигнал:** нове наскрізне at-rest шифрування секретів реалізоване як Prisma-розширення `$extends({ query: { $allModels: { $allOperations } } })` — мутує write-payload (`args.data/create/update`) на write і результат на read. Юніт-тести є ТІЛЬКИ на сам crypto-хелпер (`EncryptionService.encrypt/decrypt` round-trip у пам'яті), а на РОЗШИРЕННЯ (те, що дійсно біжить у продакшні) — 0. Unit-мок Prisma НЕ виконує `$allOperations`-hook і не б'є Postgres → CI зелений, хоч розширення може: не зашифрувати (encrypt no-op → plaintext-leak at-rest), не дешифрувати (provider отримає ciphertext → зламаний ланцюг), подвійно зашифрувати при lazy re-encrypt+upsert, або зламатись на композиції з іншим розширенням (`withFieldEncryption(withSyncVersion(client))` — порядок обгортання визначає хто мутує args першим). Grep-детектор:

```bash
# Prisma-розширення що мутує write/read payload — чи має ІНТЕГРАЦІЙНИЙ (live-DB) тест?
grep -rnE "\\\$extends\(|\\\$allOperations|encryptWriteData|decryptReadResult" apps/api/src/prisma --include="*.ts"
grep -rln "integration.spec\|\\\$queryRawUnsafe.*enc:v1" apps/api/src/prisma   # чи є парний live-тест?
# consumer-пати секрету — чи читають через РОЗШИРЕНИЙ client (this.prisma), не raw?
grep -rn "new PrismaClient" apps/api/src --include="*.ts" | grep -v "spec\|prisma.service"   # має бути 0
grep -rniE "queryRaw.*(apiKey|smsApiKey|licenseKey|pinCode|secret|token)" apps/api/src --include="*.ts" | grep -v spec  # raw-read секрету = bypass дешифрування
```

**Причина виникнення:** розробник (і рев'ювер) вважає «crypto round-trip покрито юнітом → досить». Але баг живе не в crypto-хелпері, а на СТИКУ розширення×Prisma×Postgres: чи спрацював hook для КОЖНОЇ операції (create/update/upsert/updateMany/createMany), чи `select`-проєкція не обрізала поле, чи композиція розширень зберегла порядок, чи толерантний decrypt читає legacy-plaintext рядки (записані до фічі / raw SQL). Це невидиме юнітам за визначенням.

**Підхід до виявлення:** для БУДЬ-ЯКОГО Prisma-розширення що трансформує дані — обов'язковий інтеграційний spec проти живої dev-БД (guard: skip якщо БД недоступна, АЛЕ реально біжить коли є — не fake-green). Будувати клієнт ТОЧНО як `PrismaService.onModuleInit` (та сама композиція розширень). Довести at-rest: read сирої колонки через `$queryRawUnsafe` = ciphertext (`enc:v1:` + не містить plaintext); read через розширення = plaintext; legacy-plaintext рядок (raw INSERT) читається без змін (толерантність); update без секрету зберігає наявний (не подвійне шифрування). Плюс статично: 0 `new PrismaClient()` поза service, 0 raw-read секретних колонок, response/cache-мапери НЕ включають секрет (лише `hasX`-прапорець).

**Підхід до фіксу:** написати live-DB інтеграційний spec (test-only, код вірний). Ізоляція фікстур через unique-ключ (обійти `@@unique`), hard-delete у `afterAll`+`beforeAll`-cleanup. uuid-параметри у `$queryRawUnsafe` кастити явно (`$1::uuid`) — Postgres не інферить тип bind-параметра проти uuid-колонки (`42883 operator does not exist: uuid = text`).

**Severity:** HIGH — розширення шифрує ВСІ секрети провайдерів at-rest; тихий регрес = plaintext-leak у БД АБО зламаний provider-ланцюг у продакшні. Regression-guard закриває весь клас одразу.

**Де шукати ще:** будь-який `$extends` що мутує payload (soft-delete-фільтр, multi-tenant-scoping, syncVersion, audit-stamp, field-transform); будь-який at-rest crypto / masking / redaction на рівні ORM; consumer-паті секрету (provider-виклики, external-API headers) — чи читають через розширений client; response/cache/sync-експорт — чи не витікає розшифроване поле.

### 2026-09-06 — review-fix змінив DI-конструктор сервісу (+параметр), sibling `.spec` лишився на старій арності → hidden-red baseline (tsc зелений, runtime crash) — backend / hidden-red-baseline / HIGH (release-blocker)

**Сигнал:** попередній commit (часто саме `fix(review):` — atomic-upsert, інжект registry/config, розбиття залежності) **додав/переставив параметр конструктора NestJS-сервіса** (`constructor(prisma, registry, @InjectQueue() q)`), але не оновив `*.spec.ts`, який досі робить `new Service(prisma, q)` зі старою кількістю аргументів. **tsc проходить** бо тест кастить моки `as unknown as T` → компілятор не ловить зсув слотів; аргумент їде у сусідній слот, останній параметр стає `undefined` → `TypeError: Cannot read properties of undefined (reading '...')` у першому методі, що торкається зсунутої залежності. Grep-детектор:

```bash
# для кожного зміненого сервіса у diff — арність конструктора vs арність new у спеку
git diff HEAD~3 HEAD -- '*.service.ts' | grep -E "constructor\("
grep -rnE "new \w+Service\(" apps/api/src --include="*.spec.ts"   # порахувати аргументи, звірити
# найнадійніше: просто ПРОГНАТИ цільову suite зміненого модуля (не лише tsc)
```

**Причина виникнення:** review-агент (і людина-рев'ювер) верифікує зміну лише через `tsc --noEmit`, бо «типи зелені = ок». Але моки в спеках навмисно кастять через `as unknown as` (щоб не реалізовувати весь інтерфейс) — це **вимикає перевірку арності конструктора** саме там, де вона потрібна. Зсув DI-слотів невидимий до реального прогону. Класичний review→tester handoff-провал: рев'ю не ганяє suite, тестер бачить червоне аж на Кроці 0.

**Підхід до виявлення:** Крок 0 ЗАВЖДИ прогонить **цільову suite зміненого модуля** (`vitest run src/modules/<mod>`), не лише tsc. Будь-яка зміна сигнатури конструктора/DI = обов'язковий прогін `<service>.spec.ts` цього сервіса. Якщо baseline червоний — це Bug #0 (release-blocker), фіксувати ПЕРШИМ.

**Підхід до фіксу:** оновити конструктор у спеку до нової арності + додати мок нової залежності (`{ get: vi.fn(), list: vi.fn() } as unknown as Registry`) + import. Це test-only фікс (код сервіса вірний). Meta-нотатка у BUG_REPORT: рев'юер має ганяти targeted suite при DI-зміні.

**Severity:** HIGH — червоний baseline ховає регресії за шумом і блокує наступні сесії; сам дефект — лише в тесті, але це не видно поки не впаде.

**Де шукати ще:** будь-який `fix(review):`/`refactor:` commit що чіпає `*.service.ts` конструктор; NestJS-сервіси з ≥2 інжектованих залежностей + `@InjectQueue`/`@Inject`; спеки що конструюють сервіс вручну (`new X(...)`) замість `Test.createTestingModule`. Правило: diff чіпає `constructor(` у сервісі → прогнати його `.spec` перед усім іншим.

### 2026-09-06 — fallback/retry-engine: config-resolver (chain-builder) відвантажується з 0 unit-тестів, поки worker має часткові — backend / critical-test-gap / meta (severity бага = severity ланцюга)

**Сигнал:** нова багатоканальна/багатокрокова async-машина (fallback-ланцюг сповіщень, retry-orchestrator, multi-provider payment fallback, saga-крок) розбита на дві частини: **(A) resolver/builder** — читає конфіг з БД і будує впорядкований ланцюг (`resolveConfig()`, `buildChain()`, `planSteps()`); **(B) worker/processor** — виконує один крок і вирішує accept-STOP / reject-next / retry. Тести є ТІЛЬКИ на (B) (бо він явно «двигун»), а (A) — де живуть УСІ edge-case'и (порожній ланцюг, NULL-креди відфільтровані where-запитом, крок без активного шаблону/провайдера тихо пропускається, ВСІ пропущені → повернути null=batch-abort, legacy-fallback backward-compat, priority-порядок) — має 0 прямих тестів. Grep-детектор:

```bash
# resolver-методи що будують ланцюг/план для async-двигуна — чи мають парний .spec?
grep -rnE "async (resolve|build|plan)[A-Z]\w*\(" apps/api/src/modules --include="*.ts" | grep -v spec
# для кожного: чи існує <module>.service.spec.ts що ВИКЛИКАЄ саме цей метод?
# worker має spec (sms.processor.spec), а .service.spec (resolveConfig) відсутній → gap
ls apps/api/src/modules/<mod>/*.spec.ts   # порахувати покриття resolver vs worker
```

**Причина виникнення:** «двигун» у голові розробника = processor (там видно accept/reject/retry-гілки), тож тести йдуть туди. Resolver сприймається як «просто SELECT + map» і здається тривіальним — але саме він містить мовчазні гілки-фільтри (`where apiKey:{not:null}`, `.filter(has-template)`, `length===0→null`, legacy-if) кожна з яких — окрема бізнес-вимога, що ламається тихо (0 sent, без throw, без логу-помилки). CI зелений бо worker-тести зелені.

**Підхід до виявлення:** прогнати КОЖЕН edge-case ланцюга проти РЕАЛЬНОГО коду resolver'а (не припускати), потім закрити gap тестом-guard на кожну мовчазну гілку: (1) NULL-креди → відфільтровано where → або legacy, або null (без крашу); (2) крок без шаблону → тихо skip; (3) ВСІ кроки без шаблону → null (batch-abort, НЕ throw); (4) legacy-гілка коли конфіг-рядків 0 (backward-compat) — усі під-варіанти (enabled/disabled/no-key/no-template/no-row); (5) priority-порядок збережено. Плюс **property-based (fast-check) на processor-інваріанти**: для будь-якої послідовності accept/reject/unknown — max 1 SENT, stop-on-first-accept, throw ⟺ останній крок = транзієнт-reject, Σ(term-логів)=visited. 200 runs/property ловить композиційні діри, які приклад-тести пропускають.

**Підхід до фіксу:** тести-only — фіксують поточну КОРЕКТНУ поведінку як регресію-guard (код не чіпати якщо логіка вірна). Якщо ж edge-case дає краш/подвійну-відправку/тихий-0 — то це вже реальний баг, фіксувати код + той самий тест стає дискримінуючим.

**Severity:** meta. Сам gap = CRITICAL (ховає майбутню регресію у гроше-/сповіщення-критичному шляху), але знайдені дефекти можуть бути 0 (як тут). Оцінювати за blast-radius ланцюга: сповіщення=MEDIUM, платіж/склад=HIGH-CRITICAL.

**Де шукати ще:** `notifications` (цей сеанс — resolveConfig), будь-який `*.processor.ts`+BullMQ з fallback/retry, multi-provider (payment/ПРРО/SMS) fallback, saga/outbox-кроки, `resolveConfig`/`buildPlan`/`nextStep`-патерн. Правило: якщо є `<x>.processor.spec.ts` але нема `<x>.service.spec.ts` а сервіс має resolve/build-метод — gap.

### 2026-09-06 — «перший-переможець» `.find()` для scan/lookup-збігу тихо бере не той запис при неоднозначному ТОЧНОМУ матчі — frontend / silent-wrong-pick / MEDIUM (HIGH якщо фін.документ)

**Сигнал:** чиста resolver-функція (сканер ШК, code-lookup, «знайти за унікальним ключем») робить `items.find(it => it.key === typed)` і повертає перший збіг. Але ключ, який ПРИПУСКАЄТЬСЯ унікальним, у реальних даних може дублюватися (data-entry помилка: той самий ШК у головному `barcode` одного товару і в `barcodes[]` іншого; той самий SKU у двох рядках). `.find()` → тихо перший → у фінансовому документі (Invoice/StockDoc/PO/SR) оператор отримує «не той» товар, не помічаючи. Grep-детектор:

```bash
# resolver що бере ПЕРШИЙ exact-збіг без перевірки на колізію
grep -rnE "\.find\(.*===\s*(code|typed|barcode|sku|key)\b" apps/web/src/lib apps/web/src/components --include="*.ts" --include="*.tsx"
# перетнути: чи ключ ГАРАНТОВАНО унікальний у межах items? (як правило — ні: sub-таблиці, ручний ввід)
```

**Причина виникнення:** розробник вважає код/ШК/SKU унікальним (доменне припущення), тож «перший = єдиний». Але унікальність тримається лише логікою сервісу або взагалі не тримається (sub-таблиця `GoodBarcode[]` не має cross-good unique), а UI-пошук зводить кілька товарів в один список. `.find()` виглядає ідіоматично — review/sync не сигналять.

**Підхід до виявлення:** unit-тест на КОЛІЗІЮ: два РІЗНІ записи з однаковим точним ключем → очікувати `null` (показати список), а не мовчазний перший. Окремий тест «дубль ключа в межах ОДНОГО запису (головний == sub) НЕ колізія» доводить, що фікс рахує РІЗНІ об'єкти, а не входження. Дискримінація: до фіксу тест червоний (`expected {id:'a'} to be null`).

**Підхід до фіксу:** `.find()` → `.filter()`; `length === 1` → беремо; `length > 1` → `null` (не вгадуємо на фін.даних). Дублікат у межах одного запису не подвоює (фільтр по об'єктах). Single-result fallback («єдиний результат без точного ключа → беремо») лишається навмисним — це інший кейс (пошук за назвою).

**Severity:** MEDIUM, HIGH коли резолвер живить фінансовий/складський документ (тихий вибір не того товару → неправильна ціна/залишок/акт).

**Де шукати ще:** `pickScannedGood` (цей фікс), будь-який `resolveByCode`/`findBySku`/`matchBarcode`, а також backend-аналоги де `findFirst({ where: { uniqueLike } })` припускає унікальність без DB-констрейнта (restore-guard-и вже це роблять для SKU/internalCode).

### 2026-09-06 — query-DTO не trim'ить рядок → exact-матч (`equals`) промахує при провідних/кінцевих пробілах (сканер/ручний ввід) — backend / whitespace-miss / MEDIUM

**Сигнал:** `@Get` query-параметр (`q`/`barcode`/`code`) з `@IsString()` без `@Transform` trim, а сервіс будує `where` з `equals: query.x` (точний матч) для sub-сутності. Сканер ШК (частина моделей) або оператор додає провідний/кінцевий пробіл → `" 4820… "` не збігається з кодом у БД (записаним без пробілів). Головна гілка `contains` теж не рятує (`contains " 4820"` хибний). Видача порожня → фронтовий resolver отримує 0 рядків → нічого не вибирається. Фронт міг trim'ити СВІЙ ввід (`typed.trim()`), але це не допомагає — бек уже повернув 0. Grep-детектор:

```bash
# query-DTO рядкові поля без trim, які підуть у equals/exact-where
grep -rnE "@IsString\(\)\s+\w+\?:" apps/api/src/modules/**/*.dto.ts | grep -iE "\b(q|barcode|code|sku|search)\b"
# перетнути з сервісом: чи це поле йде у { equals: } / { barcode: value } (exact)?
grep -rnE "equals:\s*(query|dto)\.(q|barcode|code)" apps/api/src/modules
```

**Причина виникнення:** trim роблять на фронті («там де ввід»), припускаючи що бек отримає чисте. Але джерел вводу кілька (сканер, deep-link URL, інший клієнт, curl), а exact-`equals` нещадний до пробілів. `contains` для головного поля маскує проблему для звичайного пошуку, тож помічається лише на sub-exact гілці.

**Підхід до виявлення:** DTO-spec через `plainToInstance(QueryDto, { q: ' 999 ' })` → `expect(dto.q).toBe('999')`; whitespace-only → `undefined` (щоб `?q= ` не був фільтром за пробілом). Тестувати на рівні DTO, не сервісу (трансформ живе у ValidationPipe, сервіс отримує вже-розпарсене). Дискримінація: без `@Transform` тест червоний.

**Підхід до фіксу:** `@Transform(({value}) => typeof value==='string' ? value.trim() || undefined : value)` на кожному exact-lookup query-полі. Порожнє-після-trim → `undefined` (не фільтр за пустим рядком).

**Severity:** MEDIUM — тиха порожня видача на легітимному скані; не падає, не логується, користувач думає «товар не знайдено».

**Де шукати ще:** усі query-DTO з `q`/`barcode`/`code`/`sku` що йдуть у exact-where; deep-link `?param=` парсери; будь-який `equals: userInput` без попереднього trim.

### 2026-09-06 — bind-once `useEffect([])` document-listener кличе проп напряму → stale closure після ре-рендера батька (Escape/hotkey викликає СТАРИЙ колбек) — frontend / stale-closure / MEDIUM

**Сигнал:** shared-компонент (попап/модалка/overlay) реєструє `document.addEventListener('keydown', h)` у `useEffect(() => {...}, [])` (bind-once, щоб listener не пере-біндився на кожен ре-рендер), а всередині `h` кличе проп-колбек НАПРЯМУ (`if (e.key==='Escape') onClose()`). Батько передає інлайн-стрілку (`onClose={() => setPopupId(null)}`) — нова identity на кожен ре-рендер. Bind-once ефект замикає ПЕРШУ версію `onClose`; після будь-якого ре-рендера батька (зміна фільтра, tick, інший state) Escape викликає СТАРИЙ колбек → може закрити не той попап / no-op / діяти на застарілому id. Тихо: у простих сценаріях (батько не ре-рендериться до Escape) баг не проявляється. Grep-детектор:

```bash
# bind-once ефект з deps [] що всередині кличе проп-функцію напряму (не через ref)
grep -rnE "addEventListener\('(keydown|keyup|click|mousedown)'" apps/web/src/components --include="*.tsx" -A 8 \
  | grep -B4 -E "onClose\(\)|onConfirm\(\)|on[A-Z][a-zA-Z]*\(\)" | grep -v "\.current\("
# перетнути: чи deps масив ефекту === [] (bind-once) І колбек — проп (не локальна ф-я)?
```

**Причина виникнення:** дві правильні цілі конфліктують: (1) «listener має біндитись раз» → deps `[]`; (2) «колбек приходить пропом, свіжий щоразу». Розробник виконує (1), забуваючи що `[]` заморожує замикання на mount-версії пропа. Класична React stale-closure пастка; ESLint `exhaustive-deps` пропонує додати `onClose` у deps — але це вертає пере-біндинг listener-а на кожен ре-рендер (те, від чого тікали). Правильне — ref-latest патерн, який ESLint не підказує.

**Підхід до виявлення:** component-тест на ДИСКРИМІНАЦІЮ свіжості: `render(<C onClose={first}/>)` → `rerender(<C onClose={second}/>)` (нова identity) → `fireEvent.keyDown(document,{key:'Escape'})` → асертити `second` викликано 1×, `first` — 0×. Дискримінація доведена ЕМПІРИЧНО: revert `onCloseRef.current()` → `onClose()` у handler → тест червоніє (`first` спрацьовує). Обов'язково — окремий тест cleanup на unmount (Escape після unmount → 0 викликів) і тест «backdrop/inner-click» (event-handler у JSX прив'язується свіжим на кожен render → може кликати проп НАПРЯМУ, ref потрібен ЛИШЕ у document-listener всередині ефекту).

**Підхід до фіксу:** ref-latest: `const cbRef = useRef(onClose); cbRef.current = onClose;` (оновлюється на кожен render, поза ефектом), а bind-once handler кличе `cbRef.current()`. Deps ефекту лишаються `[]`. JSX-обробники (onClick backdrop, close-X) НЕ треба переводити на ref — вони перестворюються на кожен render і бачать свіжий проп; ref потрібен виключно там, де замикання заморожене bind-once ефектом.

**Severity:** MEDIUM — потенційно спрацьовує на застарілому колбеку; шкода залежить від того, що робить колбек (закрити попап — легко; submit/delete зі stale id — HIGH). Тихо проходить review (виглядає як стандартний ref-guard), sync не бачить (чисто клієнтський).

**Де шукати ще:** усі shared overlay/popup/modal з global keydown-listener: `LinkedDocumentsPopup` (цей рефактор — коректний, ref є), `ConfirmDialog`, `CommandPalette`, `Modal`, будь-який `useHotkey`/`useKeyboardShortcut` хук. Загальний клас: будь-який bind-once (`[]`) ефект-listener/subscription/interval що кличе проп чи змінний state — має читати його через ref-latest, не через замикання.

### 2026-09-06 — deep-link виставляє лише `editId`, але модалка керується ОКРЕМИМ `open`-прапорцем того самого інстансу → deep-link мертвий (модалка не відкривається) — frontend / dead-feature / HIGH

**Сигнал:** сторінка-список має ОДИН інстанс модалки з `open={xCreateOpen}` + `editId={xEditId}` (два незалежні state). Усі «нормальні» точки відкриття (row-click, кнопки) виставляють ОБИДВА (`setXEditId(id); setXCreateOpen(true)`), а mount-once deep-link ефект (`?open=`/`?openReturn=`) — ЛИШЕ `setXEditId(id)`. Наслідок: `editId` виставлено, `open` лишається `false` → модалка ніколи не відкривається (тихо: URL змінюється, нічого не рендериться). Grep-детектор:

```bash
# знайти модалки з роздільними open+editId на одному інстансі
grep -rnE "open=\{[a-zA-Z]+CreateOpen\}" apps/web/src/app/**/page.tsx
# для кожної — перевірити чи deep-link ефект виставляє ОБИДВА setter-и
grep -rnE "searchParams.get\('open|openReturn'\)" apps/web/src/app/**/page.tsx
# у тілі ефекту має бути і setXEditId, і setXCreateOpen(true) — інакше баг
```

**Причина виникнення:** аналогія з іншою модалкою, що ПРАЦЮЄ через deep-link, вводить в оману. Напр. StockDoc `?open=` працює, бо має ДВА окремі інстанси модалки (`open={showCreate}` для create + `open={!!editingDocId}` для edit — editId сам є open-джерелом). Розробник копіює «виставляю editId — і все» на модалку з ЄДИНИМ інстансом, де `open` — окремий boolean, не похідний від editId. Sync/review це не ловлять: endpoint-контракт цілий, типи збігаються, а intra-page state-coupling поза їхньою зоною; тестів на deep-link page-ефекти зазвичай нема.

**Підхід до виявлення:** винести чистий розбір deep-link у helper `resolveXDeepLink(get) → { openId, ..., modalShouldOpen }` де `modalShouldOpen` явно = «open теж треба true, не лише editId». Тест: `?openReturn=<uuid>` → `modalShouldOpen===true`. Дискримінатор: ментальний відкат (`modalShouldOpen:false`) → тест падає. Це обходить неможливість легко відрендерити гігантську page.tsx у RTL — тестуємо рішення про стан, а не весь компонент. Правило-інваріант: **якщо модалка керується `open` + `editId` роздільно, КОЖНА точка відкриття (row-click І deep-link) зобов'язана виставити обидва.**

**Підхід до фіксу:** у deep-link ефекті виставити обидва setter-и (`setXEditId(id); setXCreateOpen(true)`), дзеркалячи row-click. Дублювання UUID-валідації прибрати у helper. Альтернатива (якщо архітектурно чистіше) — зробити `open={xCreateOpen || !!xEditId}`, але це змінює семантику close (обидва треба скидати) → менш безпечно за explicit-обидва.

**Severity:** HIGH — цілий шлях навігації неробочий (мертва фіча), тихо: жодної помилки, лише «клік нічого не робить». Легко пропустити на demo, якщо тестили лише row-click-відкриття.

**Де шукати ще:** усі сторінки-списки з `open={xCreateOpen}`-модалкою що приймає deep-link: purchase-orders (`?openReturn=` SR — цей баг), invoices/stock-documents (`?open=` — там ok, окремі інстанси, але перевіряти при рефакторі об'єднання інстансів). Загальний клас: будь-який роздільний `visible` + `selectedId` state, де кілька кодо-шляхів відкривають, а один забуває `visible=true`.

### 2026-09-05 — count/detail розходяться: badge-лічильник рахує зв'язок за наявністю FK, а detail-endpoint фільтрує `deletedAt: null` → «1» над порожньою секцією (Bug #641) — backend / consistency / MEDIUM

**Сигнал:** пара методів «summary-count» + «detail-list» для одних і тих самих зв'язків, де count зроблено дешевше за detail. Count: `bucket.counterparty = row.counterpartyId ? 1 : 0` (лічить наявність **FK-скаляра**, взятого з `findMany` самої сутності). Detail: `this.prisma.counterparty.findFirst({ where: { id, orgId, deletedAt: null } })` (тягне **сам referenced-запис** з soft-delete фільтром) → `counterparty ? [row] : []`. Розходження проявляється щойно referenced-запис (контрагент / банк-рахунок / каса / пов'язаний документ) soft-deleted, а FK у батьку лишився: badge показує «1», панель — порожньо. Grep-детектор:

```bash
# методи-лічильники, що зараховують «1» за наявністю FK-скаляра (без live-перевірки referenced-запису)
grep -rnE "= [a-zA-Z]+\.[a-zA-Z]*Id \? 1 : 0|Id \|\| [a-zA-Z]+\.[a-zA-Z]*Id \? 1 : 0" apps/api/src/modules/**/*.service.ts | grep -iE "count|Count"
# перетнути з detail-методом того ж модуля: чи фільтрує він referenced-запис по deletedAt:null?
grep -rn "getLinked\|LinkedCounts\|LinkedDocuments" apps/api/src/modules/**/*.service.ts
```

**Причина виникнення:** оптимізація N+1 — щоб не тягнути кожен referenced-запис заради лічильника, розробник бере FK-скаляр із вже-завантаженого батька (`select: { counterpartyId: true }`) і зараховує «є зв'язок = FK не null». Припущення «FK не null ⇒ referenced-запис живий» хибне за soft-delete-моделі: FK лишається, а запис може бути `deletedAt != null`. Особливо досяжно, якщо delete-guard referenced-сутності блокує видалення лише за **відкритими** документами (напр. counterparty можна видалити під PAID-рахунком / RECEIVED-PO) — тоді жива посилка на мертвий запис штатна.

**Підхід до виявлення:** будь-де, де існують ДВА endpoint-и на ті самі зв'язки (badge-count + detail-panel), написати service-тест: FK присутній (`findMany` батька повертає `counterpartyId`), але `referenced.findMany({deletedAt:null})` повертає `[]` (soft-deleted) → асертити `count === 0` (щоб дорівнювало порожній detail-секції). Дискримінатор: revert фіксу (`FK ? 1 : 0`) → тест дає `1`, падає. Правило: **count МУСИТЬ дзеркалити ті самі WHERE-фільтри, що й detail** (orgId + deletedAt:null + status-фільтри). Плюс edge-тести: duplicate ids (map keyed by id — не подвоюється), cross-org ids (findMany scoped by orgId → нулі, витоку нема), zero-count id (пре-fill `for (const id of ids) result[id]={...0}` → присутній, не absent → frontend badge не крешить на undefined).

**Підхід до фіксу:** у лічильнику зібрати унікальні FK (`[...new Set(rows.map(r=>r.fkId).filter(Boolean))]`), одним `findMany({ where:{ id:{in}, orgId, deletedAt:null }, select:{id:true} })` на КОЖЕН тип referenced-запису дістати живий набір, зарахувати «1» лише якщо `liveSet.has(fkId)`. Батч через `Promise.all` — без N+1 (K запитів на K типів секцій, не на N рядків). Ключ у тому, щоб summary й detail мали **єдину definition «зв'язок існує»**.

**Severity:** MEDIUM — не корупція даних, але UX-неконсистентність, що підриває довіру до лічильників (badge бреше). За гіршого сценарію ховає, що документ осиротів на мертвий довідник.

**Де шукати ще:** будь-яка пара summary-badge + detail-list на один агрегат: `getLinkedCounts`/`getLinkedDocuments` (invoices/PO/supplier-payments/work-orders); `_count` у list-DTO проти реального include у detail; лічильники «активних договорів/гаражів/авто» контрагента; dashboard-плитки що рахують `X.count({where})` з іншим набором фільтрів ніж сторінка-деталізація. Загальний інваріант: **лічильник і список, які мають узгоджуватись, зобов'язані мати ідентичний WHERE.**

### 2026-09-05 — Unsaved-guard baseline через `setTimeout(0)` + АСИНХРОННИЙ авто-populate дефолту → false-positive «незбережені зміни» на незайманій формі — frontend / trust-erosion / HIGH

**Сигнал:** модалка з dirty-guard озброює baseline через `const t = setTimeout(() => { baselineReadyRef.current = true; }, 0)`, а dirty-детектор — `useEffect(() => { if (!open || !baselineReadyRef.current) return; dirty.markDirty(); }, [form, lines, ...])`. Одночасно існує async авто-вибір дефолту: `useEffect(() => { if (warehouses.length === 1) setForm(f => f.warehouseId ? f : {...f, warehouseId: warehouses[0].id}); }, [warehouses])` де `warehouses`/`branches` приходять з `apiFetch('/warehouses')`. Симптом: відкрити create-модалку з РІВНО одним складом/філією, нічого не чіпати, Escape → спливає діалог «Є незбережені зміни» (Bug #639). Grep: `grep -rlE "baselineReadyRef|setTimeout\(\s*\(\)\s*=>\s*\{\s*baselineReadyRef" apps/web/src/components/ui/*Modal*.tsx` перетнути з `grep -lE "length === 1|length !== 1" ` (модалки з авто-вибором) + перевірити чи авто-вибірне поле є у deps dirty-детектора.

**Причина виникнення:** розробник припускає, що весь початковий стан осідає в межах першого setState-батчу (тому `setTimeout(0)` вистачає). Але reference-дані (склади/філії/ПДВ) вантажаться окремим async-запитом, який резолвиться ПІЗНІШЕ за 0ms-таймер. Програмна установка дефолту тоді неможливо відрізнити від правки користувача — детектор бачить лише «поле у deps змінилось».

**Підхід до виявлення:** для КОЖНОЇ create/edit-модалки з `useDirtyForm` + baseline-ефектом написати component-тест: замокати reference-fetch на РІВНО 1 елемент (щоб спрацював авто-вибір), `render(open)`, зачекати осідання (`await new Promise(r=>setTimeout(r,60))` — довше за ланцюг load→auto-select→re-render), `fireEvent.keyDown(document,{key:'Escape'})`, асертити `onClose` викликано 1× І `queryByText('Є незбережені зміни')` відсутній. Дискримінація: revert skip-фіксу → тест падає (діалог спливає). Парний тест «змінив поле → діалог Є» ловить протилежний false-negative.

**Підхід до фіксу:** зафіксувати САМЕ програмну зміну ref-прапорцем (`autoWarehouseRef`/`autoBranchRef`/`autoDefaultsRef`), який встановлюється в авто-вибірному ефекті ЛИШЕ коли `baselineReadyRef.current === true` (тобто дефосів пізно). Dirty-детектор пропускає рівно цю зміну (`if (auto !== null && field === auto) { auto = null; return; }`) — один раз, споживаючи ref. Скидати ref у reset-ефекті (`baselineReadyRef.current = false; autoXRef.current = null;`). НЕ переозброювати baseline через новий `setTimeout` у cleanup-ефекті: cleanup при re-run ефекту (напр. `warehouseId` у deps) скасує pending-таймер і вимкне guard узагалі.

**Severity:** HIGH — не ламає дані, але руйнує довіру: guard кричить «вовки» на кожному відкритті модалки з єдиним складом → користувачі привчаються сліпо тиснути «Покинути», і РЕАЛЬНІ незбережені зміни втрачаються.

**Де шукати ще:** усі модалки з async авто-populate дефолтів ПІСЛЯ baseline-таймера — не лише склад/філія, а й авто-вибір єдиного ПДВ, валюти, каси, автомобіля клієнта; будь-який `useEffect([refData], () => setForm(...))` де refData з fetch. InvoiceCreateModal безпечна (лише синхронні дефолти) — критерій імунітету: чи є async-populate поля, що входить у deps dirty-детектора.

### 2026-09-05 — Component-тест sync-ref-guard через `userEvent.click`×2 (або `fireEvent`×2) — ХИБНО-ЗЕЛЕНИЙ: гейтом стає `disabled={loading}`, не тестований ref — frontend / test-integrity / MEDIUM

**Сигнал:** component-тест «подвійний клік → 1 POST» що імітує double-submit через `userEvent.click(btn)` двічі (або `void user.click(); void user.click()` у `act`), АБО через `fireEvent.click(btn)` двічі. Тест ПРОХОДИТЬ навіть коли синхронний `savingRef`-guard видалено з handler-а. Причина: `userEvent`/`fireEvent` обгортають КОЖЕН клік у власний `act()`/pointer-чергу з мікротасками → React встигає re-renderнути й виставити `disabled={saving||loading}` на `<Button>` МІЖ кліками → другий клік не доходить до handler-а незалежно від ref. Тобто фактичним гейтом у тесті є async `disabled={loading}`, а не тестований sync-ref. Тест нічого не гарантує: рефактор, що прибере ref-guard, пройде CI зеленим.

**Причина виникнення:** інтуїтивно «клікнув двічі → перевірив кількість POST». Але `disabled={loading}` і `savingRef` захищають ДВА РІЗНІ вікна: `disabled` — коли між кліками БУВ re-render (async, повільний double-click); `savingRef` — коли обидва кліки в ОДНОМУ tick ДО re-render (native fast double-click, синтетичні/програмні події). `userEvent`/`fireEvent`-choreography потрапляє лише у перше вікно, тож тестує НЕ те, що фіксили.

**Підхід до виявлення:** для кожного double-submit component-тесту перевірити ДИСКРИМІНАЦІЮ: тимчасово видалити ref-guard з handler-а → тест МУСИТЬ впасти («expected 2 to be 1»). Якщо лишається зеленим — хибний. Grep: `grep -rnE "user\.click|fireEvent\.click" apps/web/src/**/__tests__/*double*|*submit*` + будь-який тест що асертить «POST рівно 1×» після ≥2 кліків. Правило baseline (Крок 0): shipped double-submit тест без доказу дискримінації = недовірений.

**Підхід до фіксу:** відтворити реальний same-tick race через `(btn as HTMLButtonElement).click(); btn.click();` — native `HTMLElement.click()` двічі СИНХРОННО в одному блоці (без `await`/`act`-обгортки між ними). React batch-ить state-updates → re-render лише ПІСЛЯ обох кліків → гейтом стає саме синхронний ref. Розрулити in-flight promise у фінальному `await act(async () => resolve())` (прибирає act()-warning). Ввід у поля — `fireEvent.change` (синхронний), не `user.type`. Завжди довести дискримінацію (fail без guard) перед комітом.

**Severity:** MEDIUM (test-integrity) — код-фікс може бути коректним, але його регресія-захист відсутній; майбутній рефактор мовчки знімає guard.

**Де шукати ще:** усі `*Modal.test.tsx` з double-submit/double-click; той самий принцип для будь-якого sync-vs-async guard (debounce-ref, request-token ref, idempotency createdRef) — тест мусить бити САМЕ синхронне вікно.

### 2026-09-05 — Split-coverage double-submit guard: аудит покрив «великі» модалки, edit-модалки довідників пропущені → дубль master-data (WEB-H3 / Bug #630 class) — frontend / data-integrity / HIGH

**Сигнал:** submit-кнопка модалки `<Button onClick={save} loading={saving} disabled={!field}>` де `disabled` НЕ містить `saving`/`||loading`-еквіваленту як синхронного гейта, а `save()`/`create()`/`update()` мають `setSaving(true)` БЕЗ `if (savingRef.current) return` першим рядком. Два same-tick кліки → 2× POST → дубль сутності (контрагент/співробітник/товар; для Employee ще й дубль auth-акаунта). `<Button>` внутрішньо ставить `disabled={disabled||loading}`, але це async-гейт (після re-render) — не рятує same-tick.

**Причина виникнення:** попередній double-submit аудит охопив «великі» документні модалки (WorkOrder/PO/Stock/Invoice/SupplierReturn), а edit-модалки довідників (Counterparty/Employee/Good) вважались «простими» і випали зі scope. Класичний split-coverage: фіксять N зі списку, лишають M «схожих але менш помітних».

**Підхід до виявлення:** grep-pair по ВСІХ модалках: `for f in apps/web/src/components/ui/*Modal.tsx; do echo "$f: guards=$(grep -cE 'savingRef|createdRef|transitioningRef|submittingRef' $f) posts=$(grep -cE "method: '(POST|PATCH)'" $f); done` → будь-яка модалка з POST/PATCH і 0 guard-refs = кандидат. Перехресно: чи `disabled=` кнопки містить `saving`? Якщо гейт лише `loading={saving}` (async) — vulnerable.

**Підхід до фіксу:** `savingRef = useRef(false)` + `setSavingBoth(v){savingRef.current=v; setSaving(v)}`; `if (savingRef.current) return` ПЕРШИМ рядком кожного save-handler-а; `finally { setSavingBoth(false) }`. Симетрія з уже-виправленими модалками. Regression-guard: native-click×2 дискримінуючий тест (див. підхід вище).

**Severity:** HIGH — silent duplicate master-data (контрагент/товар/співробітник), для Employee дубль login-акаунта (безпека). User-visible, псує CRM/номенклатуру/settlement-звіти.

**Де шукати ще:** усі `*Modal.tsx` / inline-форми з submit-POST; той самий клас — будь-який `onClick`-handler що робить mutation і покладається лише на `disabled={loading}` (не sync-ref). Кандидати поза модалками: quick-add форми, bulk-action кнопки, share/print-token генерація, **row-action-хендлери у списках** (`clone`/`duplicate`/`archive`/`markDeleted` у `page.tsx` з `disabled={xxxId === row.id}` де `xxxId`=`useState`). Bug #637: clone-дія у списку нарядів гейтилась лише `useState cloningId` → 2 POST /clone на native-click×2. Grep: `grep -rnE "disabled=\{[a-zA-Z]+Id === " apps/web/src/app/**/page.tsx` + звірити чи handler має sync-ref-guard. **Тепер є переюзабельний хук `apps/web/src/hooks/useSubmitGuard.ts`** (`guard.run(async fn)` з sync `inFlightRef`) — фіксити row-actions через нього замість inline-ref.

### 2026-09-05 — Backend-агрегат змішує `Σ(round(x))` і `round(Σ(x))` для тієї самої величини → розходження на копійку між denorm-полями — backend / money-precision / LOW

**Сигнал:** сервіс що рахує кілька denormalized money-полів з одних per-line значень різними стратегіями квантування: одне поле = `roundMoney(Σ l.amount)` де `l.amount` вже `roundMoney(qty×price)` (per-line rounded sum), інше = `roundMoney(Σ (qty×price raw))` (raw sum then round). Приклад: WO `recalcTotals` — `totalLabor = roundMoney(Σ roundMoney(nh×price))`, але `totalAmount = roundMoney(Σ raw(nh×price))` через `totalActualLabor`. При per-line-дрейфі 3×2.525 → totalLabor=7.59, totalAmount=7.58 (копійка). FE-preview що дзеркалить одне поле не збігається з іншим. Frontend `calcVatTotals` mirror-ить `totalLabor` (per-line), але CHARGE-база при COMPLETED бере `totalAmount` (raw-sum).

**Причина виникнення:** дві формули пишуться у різний час / різними фічами (`totalLabor` — з базового WO, `totalActualLabor`/`totalAmount` — додано VAT-фічею), кожна «логічна» окремо, але для однакового кейсу (actualHours=null) мали б дати рівний результат. Ніхто не звірив per-line-round vs aggregate-round на дробових копійках.

**Підхід до виявлення:** у сервісі з ≥2 money-полями з тих самих компонентів — перевірити чи ВСІ використовують ОДНУ стратегію (або всі `Σ(round)`, або всі `round(Σ)`). Числова симуляція: 3 рядки з ціною що дає дробову половину-копійки (×.525) → порівняти поля попарно. Frontend-preview, що претендує «== backend по копійку», звіряти проти КОЖНОГО поля, яке він нібито дзеркалить, І проти поля, що реально йде у фін-операцію (CHARGE/Invoice).

**Підхід до фіксу:** обрати ОДНУ канонічну стратегію для величини (STO ERP-конвенція: per-line `amount` округлюється при записі рядка → агрегат = `Σ(round)`, тобто `totalActualLabor` мав би теж сумувати округлені per-line, а не raw). Або задокументувати навмисну різницю (planned per-line vs actual raw). Regression-guard: unit що асертить `totalLabor === totalAmount` коли `actualHours === null` для всіх рядків.

**Severity:** LOW — розбіжність ≤1 коп, проявляється лише коли actualHours=null І per-line-rounding дрейфує; не stored-corruption (обидва округлені), але user-visible preview≠charge. НЕ блокер, кандидат на окремий бек-фікс.

**Де шукати ще:** будь-який `recalc*`/`*Totals`/aggregate-сервіс (Invoice recalc, PO totals, StockDocument, CompletionAct) — grep `grep -rnE "roundMoney\(.*reduce|\+= Number\(.*price\)" apps/api/src/modules` → перевірити консистентність round-стратегії між полями.

### 2026-09-05 — Read-фільтр діапазону дати використовує CONTAINMENT замість OVERLAP → рядки що перетинають межу вікна мовчки зникають (CAL-C2) — backend / data-visibility / HIGH

**Сигнал:** `findX(date)`/`listByDay`/будь-який read що будує UTC-вікно `[dayStart, dayEnd]` з календарної дати і фільтрує `where: { startAt: { gte: dayStart }, endAt: { lte: dayEnd } }` (CONTAINMENT — рядок повністю всередині вікна). Наслідок: запис що ПОЧИНАЄТЬСЯ до `dayStart` але закінчується всередині дня (split-day continuation, слот через опівніч, оренда/бронювання що триває кілька днів) — випадає з вибірки. UI показує ресурс вільним, хоча він зайнятий → double-booking. Live-сигнал: створити слот `startAt=D-1 21:00, endAt=D 06:00` → `GET ?date=D` НЕ повертає його (мало б).

**Причина виникнення:** «слоти дня» інтуїтивно = «слоти що починаються й закінчуються в цей день», тож пишуть `gte dayStart AND lte dayEnd`. Це правильно для point-in-time подій (createdAt), але НЕ для інтервалів [startAt,endAt] що можуть тривати через межу. Той самий overlap-предикат що вже стоїть у conflict-probe (`checkConflicts`/`createSlot`) забувають продублювати у read-фільтрі.

**Підхід до виявлення:** grep `grep -rnE "startAt: \{ (gte|gt):" apps/api/src/modules --include="*.service.ts"` — для кожного read по інтервальній моделі (CalendarSlot/BookingRequest/Reservation/Rental/будь-що з парою start/end) перевірити чи фільтр = half-open OVERLAP `startAt < end AND endAt > start`, а НЕ containment `startAt >= start AND endAt <= end`. Порівняти з conflict-probe того ж сервісу — вони мають бути ідентичні. Unit-сигнал: асертити форму `where.startAt` має ключ `lt` (не `gte`) і `where.endAt` має `gt` (не `lte`).

**Підхід до фіксу:** замінити на half-open overlap: `where: { startAt: { lt: end }, endAt: { gt: start } }` (дотик межі не рахується конфліктом/входженням, `[start,end)`). Дзеркалити наявний conflict-probe. Regression-guard: unit що будує вибірку дня і асертить `where.startAt.lt` + `where.endAt.gt`; live-проба зі слотом що перетинає межу.

**Severity:** HIGH — прихована зайнятість ресурсу → double-booking, порушення capacity-інваріанта; TS/unit зелені бо форма where синтаксично валідна.

**Де шукати ще:** будь-яка інтервальна модель з date-window read — `BookingRequest` (getAvailability), майбутні `Rental`/`Reservation`/`Shift`/`MaintenanceWindow`; загальний принцип «інтервал ⇒ overlap, точка ⇒ containment».

### 2026-09-05 — Cascade-remove-guard для master-data з FK-дітьми: soft-delete parent без перевірки активних дітей → осиротілі рядки (MD-H1 class) — backend / data-integrity / orphan / MEDIUM–HIGH

**Сигнал:** `service.remove()` reference/master-data сутності (Warehouse/Zone/Employee/Lift/Brand/Category) робить atomic `updateMany({deletedAt})` БЕЗ prep-check на активних FK-дітей. Наслідок: parent зникає з активних списків, але діти (StockItem із залишком, Lift у зоні, WorkOrderLine з employeeId) далі посилаються на мертвий id → залишки «зникають», підйомник некерований через UI зони, робота вказує на видаленого механіка. Live-сигнал: create parent → create активну дитину → DELETE parent → 204 (мало 400), дитина лишається з мертвим `parentId`.

**Причина виникнення:** master-data сприймається «просто довідник, видаляється вільно»; FK-зв'язки з операційними даними (StockItem.warehouseId, Lift.zoneId, WorkOrderLine.employeeId) не спадають на думку при написанні `remove()`. Симетрично Bug #631 (document-children counterparty), але тут діти — не документи, а операційні агрегати/залишки.

**Підхід до виявлення:** для кожного `remove()`/`delete()` master-data сервісу знайти всі моделі з FK на цю сутність (`grep -rnE "<entity>Id\b" schema.prisma`) → кожна операційно-значуща дитина (з ненульовим станом: StockItem.quantity/reserved, активний Lift, WorkOrderLine у не-термінальному WO) потребує prep-guard `findFirst({where:{<fk>:id, orgId, deletedAt:null, <active-predicate>}})` → `throw BadRequestException(<укр>)` ПЕРЕД soft-delete. Термінальні стани (ARCHIVED/CANCELLED WO) не блокують — паритет із Bug #631.

**Підхід до фіксу:** додати `findFirst` guard ПЕРЕД `$transaction`/`updateMany` (не всередині — щоб 400 віддавався до будь-якої мутації); повідомлення українською «Неможливо видалити: <причина>. Спочатку …». Для балансу — `OR: [{ quantity: { not: 0 } }, { reserved: { not: 0 } }]`. Regression-guard: spec з дитина-`findFirst.mockResolvedValueOnce({id}) → BadRequest + parent.updateMany.not.toHaveBeenCalled`; happy `null → updateMany`; count=0 → NotFound.

**Severity:** MEDIUM (Zone/Lift/Employee — керованість/UX) до HIGH (Warehouse із залишком — фінансово-облікова цілісність).

**Де шукати ще:** `Warehouse.remove` (StockItem≠0 — зроблено), `Zone.remove` (активний Lift — зроблено), `Employee.remove` (WorkOrderLine у активному WO — зроблено); ще перевірити `Lift.remove` (CalendarSlot майбутні), `GarageBranch.remove` (Warehouse/Zone/Employee), `UnitOfMeasure.remove` (GoodUoM), `WorkCategory.remove` (Work).

### 2026-09-05 — TOCTOU: existence/uniqueness check через count() ПОЗА транзакцією → concurrent-запити обидва проходять (setup first-run) — backend / concurrency / HIGH

**Сигнал:** `if (await isAlreadyInitialized()) throw` / будь-який `count()`/`findFirst()` prep-guard ПОЗА `$transaction`, після якого йде create повного агрегату. Класичний check-then-act: два одночасні запити обидва читають count=0, обидва створюють. Особливо небезпечно коли `@@unique` НЕ ловить дубль (у setup кожна tx має власний `org.id`, тож `@@unique([orgId,email])` на AuthAccount не спрацьовує — orgId різні). Наслідок: два повні tenant-и / два OWNER / зламаний single-instance інваріант. Throttle (3/хв) НЕ рятує — обидва в межах ліміту.

**Причина виникнення:** guard і create написані окремо; «навряд чи хтось натисне двічі одночасно» — але curl-flood/подвійний сабміт/retry це відтворюють. Розробник покладається на `@@unique` як backstop, не помічаючи що ключ не покриває саме цей інваріант.

**Підхід до виявлення:** grep `grep -rnE "await (this\.)?(isAlready|exists|count|findFirst)" apps/api/src/modules --include="*.service.ts"` — для кожного prep-guard перед create-агрегату перевірити: (а) чи він ПОЗА tx? (б) чи `@@unique` РЕАЛЬНО ловить дубль у concurrent-кейсі (не «схоже що ловить»)? Якщо унікальність не гарантована схемою — це TOCTOU. Unit-сигнал: mock де outer-count=0 але in-tx-count=1 → має бути 400 + create.not.toHaveBeenCalled.

**Підхід до фіксу (offline-safe, локальний Postgres):** серіалізувати bootstrap через `tx.$executeRaw\`SELECT pg_advisory_xact_lock(hashtext('<унікальний-ключ>'))\``ПЕРШОЮ операцією у`$transaction`, ПОТІМ re-check `count()`ВСЕРЕДИНІ tx → 400. Другий запит блокується до COMMIT першого, після чого бачить count>0. Lock авто-звільняється в кінці tx. Для не-bootstrap кейсів — покладатись на DB`@@unique`+ ловити P2002 → 409 (якщо ключ дійсно покриває інваріант). Regression-guard: unit з`makePrisma(outer=0, inner=1)` → 400 + advisory-lock узятий×1 + create not called.

**Severity:** HIGH — порушення критичних single-instance/uniqueness інваріантів; невідтворюване у звичайному тесті (потрібен concurrency-mock), тому unit з in-tx-count=1 обов'язковий.

**Де шукати ще:** setup/init (зроблено); будь-який «create-if-not-exists» без DB-unique що покриває саме цей інваріант — first-org, singleton-settings, «перший X стає default», reserve-унікального-номера поза `SELECT FOR UPDATE`. Споріднено з §1.1 CAS-гейт для FSM (Хвиля 1) — той самий клас «read stale поза атомарним контекстом».

### 2026-09-05 — Public endpoint приймає дату в минулому (booking) → сміття в черзі + SMS на минулу дату — backend / validation-completeness / MEDIUM

**Сигнал:** public mutation-endpoint (booking/request, reservation, appointment) валідує формат дати (`@IsDateString`), робочі години, робочий день — але НЕ перевіряє що дата ≥ тепер. curl-bypass (або баг у віджеті) створює заявку на вчора → захаращує reception-чергу + тригерить SMS/notification на минулу дату.

**Причина виникнення:** валідатори перевіряють «синтаксис + бізнес-вікно» (години/дні тижня), «не в минулому» здається обов'язком фронта — але public endpoint не може довіряти клієнту. Пропущений семантичний guard серед синтаксичних.

**Підхід до виявлення:** для кожного public/no-auth endpoint що приймає майбутню дату (`requestedDate`/`scheduledAt`/`appointmentDate`) — перевірити наявність `if (new Date(dto.date).getTime() < Date.now()) throw`. Grep `grep -rnE "requestedDate|scheduledAt|appointmentDate|plannedAt" apps/api/src/modules --include="*.service.ts"` → зіставити з наявністю past-check. Порівнювати як абсолютні інстанти (Date вже несе client-offset), НЕ як локальні рядки.

**Підхід до фіксу:** `if (requestedAt.getTime() < Date.now()) throw new BadRequestException('Дата запису не може бути в минулому')` серед інших guard-ів. Live-проба: past-дата→400, майбутня робоча→201.

**Severity:** MEDIUM — operational-noise + витрати SMS-gateway, не corruption.

**Де шукати ще:** booking.create (зроблено); будь-який public scheduler-endpoint, `POST /appointments`, `POST /reservations`, publiс WO-estimate-accept із датою.

### 2026-09-04 — Remove-guard «блокувати якщо є пов'язані активні документи» покриває не всі однотипні relations; balance-як-proxy маскує DRAFT-документи (Bug #631) — backend / data-integrity / orphan / MEDIUM

**Сигнал:** `service.remove()` додає guard «не видаляти якщо є активні наряди/PO/борг» і перевіряє 2 з N однотипних document-relations. Balance-guard (`Number(balance)!==0`) присутній і здається універсальним «є борг → не можна», тому DRAFT/чернетка ще-без-транзакції документа (Invoice DRAFT, PO DRAFT) провалюється: `balance=0`, немає count-guard для цього типу → parent soft-видаляється → активний документ вказує на soft-deleted parent (осиротів у списку, зник з CRM). Live-сигнал: create parent → create DRAFT-документ (без send/transition) → DELETE parent → 204 (мало бути 400), а `GET /document/:id` → 200 з мертвим `parentId`.

**Причина виникнення:** guard пишуть інкрементально «які документи спадають на думку» (наряди, замовлення), Invoice — клієнтський еквівалент PO — випадає. SENT/OVERDUE-рахунки непрямо ловляться balance-guard-ом (створили CHARGE), тому розробник вважає рахунки «покритими через баланс». Але DRAFT ще не має settlement-транзакції → `balance=0` → крізь усі guard-и. Плутанина: balance ловить committed-фінанси, НЕ open-но-ще-без-транзакції документи.

**Підхід до виявлення:** для КОЖНОГО `count()` у `remove()`/`delete()` витягти повний перелік back-relations parent-моделі зі schema (`sed -n '/^model <Parent> /,/^}/p' schema.prisma | grep -E "\[\]"`) → кожен document-подібний relation (WorkOrder/Invoice/PurchaseOrder/StockDocument/SupplierReturn) має ВЛАСНИЙ count-guard з `status: { notIn: [<фінальні>] }`. Балансу НЕ достатньо (він ловить лише транзакційні документи). Append-only (Payment/StockMovement) не блокують. Live-проба з DRAFT-версією кожного document-типу.

**Підхід до фіксу:** додати відсутній `count()` у той самий `Promise.all` симетрично наявним (`prisma.invoice.count({ where:{orgId, <fk>:id, deletedAt:null, status:{notIn:['PAID','CANCELLED']}} })`) + `if (n>0) throw BadRequestException(<укр>)`. Використати наявний index `(orgId, status, deletedAt)`. Regression-guard: spec з `<rel>.count.mockResolvedValueOnce(1) → BadRequest + updateMany не викликаний` + happy `=0 → delete` + перевірка `where.status = notIn [фінальні]`. Додати relation.count у prisma-mock (інакше happy-тест впаде на `undefined.count`).

**Severity:** MEDIUM — data-integrity + orphan-UX, той самий клас що вже покриті relations; DRAFT менш критичні за committed, SENT/OVERDUE вже ловились balance-ом.

**Де шукати ще:** `Counterparty.remove` (WO+PO+Invoice — тепер повний), `Vehicle.remove` (пов'язані активні WO), `Good.remove`/`Warehouse.remove` (StockItem залишки≠0), будь-який parent з кількома document-children + guard. Загальний принцип: guard-completeness = ПОВНИЙ набір relations, не підмножина; balance ≠ proxy для «є відкриті документи».

### 2026-09-04 — Stale `dist/main` рецидив: запущений процес старший за rebuild → guard мовчки не спрацьовує на live попри зелений unit + свіжий dist-файл (verification-hygiene) — process / deployment / CRITICAL-для-верифікації

**Сигнал:** live-проба нового guard/фіксу дає СТАРУ поведінку (VIN dup → 201 замість 400), хоча: (1) unit зелені, (2) tsc чистий, (3) `grep <guard-msg> dist/.../*.js` знаходить код у файлі dist на диску. Парадокс «код є, а не працює» = майже завжди stale-процес.

**Причина виникнення:** `node dist/main` (не `nest start --watch`) завантажує JS у пам'ять один раз на старті і НЕ hot-reload-ить. Якщо dist перезібрано ПІСЛЯ старту процесу — файл на диску новий, процес у пам'яті старий. Друга сесія / попередній агент часто лишає працюючий `node dist/main`, а поточна сесія перезбирає, але не рестартить. Урок Хвиль 2-3, що повторюється.

**Підхід до виявлення:** ПЕРЕД будь-якою live-верифікацією звірити StartTime процесу порту 3000 із часом останнього білду dist: `Get-CimInstance Win32_Process -Filter "ProcessId=<pid>"` (CommandLine + StartTime) vs `ls -la dist/main.js`. Якщо процес старший за dist → stale. Швидкий сигнал: guard-код у `dist/*.js` є (`grep -c`), але live дає стару поведінку.

**Підхід до фіксу:** `pnpm --filter @sto/api build` → kill процесу порту 3000 (`Get-NetTCPConnection -LocalPort 3000 | Stop-Process -Force`) → `node dist/main` у фоні → чекати `/api/health`=200 → перелогінитись (токен міг протухнути) → повторити live-пробу. Після рестарту всі guard-и спрацьовують.

**Severity:** не баг продукту — операційна пастка ВЕРИФІКАЦІЇ. Але критична: без рестарту тестер або (а) хибно рапортує «баг існує» на неіснуючий баг, або (б) хибно пропускає реальний баг (стара поведінка = «стара» ловить/не ловить не те). Unit-зелений + свіжий dist-файл ≠ deployed.

**Де шукати ще:** будь-яка live/E2E-верифікація проти локального `node dist/main` (API) — завжди звіряти StartTime. Web dev-сервер (`next dev`) hot-reload-ить, тому менш вразливий, АЛЕ `.next` cache після route-group rename — окрема пастка (§0 Bug #291). Загальне правило: перед live-пробою — «чи запущений процес містить мій код?».

### 2026-09-04 — Concurrent double-submit у create-модалці обходить idempotency-ref: захист лише через `disabled={saving}`, без синхронного savingRef-guard (Bug #630) — frontend / concurrency / financial-integrity / HIGH

**Сигнал:** create/save async-handler у `*Modal.tsx`, що робить `setSaving(true)` → `await POST`, а кнопка захищена ЛИШЕ `disabled={saving}`. Idempotency-ref (`createdIdRef`/`createdInvoiceRef`) присутній «для WEB-H3», але виставляється ПІСЛЯ await першого POST. `fireEvent.click` × 2 у тесті дає 1 POST (хибно-зелений) — а нативний `dispatchEvent(new MouseEvent('click'))` × 2 в одному `act()` дає 2 POST. Модалка часто ВЖЕ має `savingRef` (у `setSavingBoth`) і гейтить edit/transition-handler, але create-шлях цей guard пропускає.

**Причина виникнення:** `disabled={saving}` покладається на re-render React МІЖ подіями кліку — вірно для двох ОКРЕМИХ фізичних кліків (окремі tasks, flush між ними), але НЕ для двох подій в одному event-loop tick (швидкий double-click, синтетичні події a11y-інструментів, Enter-repeat на сфокусованій кнопці, автоматизація). Розробник вважає, що idempotency-ref закриває «подвійний клік», але той ref захищає лише RETRY-після-обриву (клік користувача ПІСЛЯ помилки), не concurrent-вхід. Два механізми плутаються: retry-safety ≠ re-entrancy-safety.

**Підхід до виявлення:** для КОЖНОГО create/save async-handler у `apps/web/src/components/ui/*Modal.tsx` перевірити, що ПЕРШИЙ рядок (ПЕРЕД будь-яким await) = `if (savingRef.current [|| transitioningRef.current]) return;`. Grep-детектор: модалки з `setSaving(Both)?(true)` без жодного `if (savingRef.current` = точно вразливі; модалки з savingRef, але без guard у create-шляху — split-coverage (перевірити вручну кожен handler). Component-проба: рендер модалки у submittable-стан → `await act(async () => { btn.dispatchEvent(click); btn.dispatchEvent(click); })` → assert рівно 1 POST. `fireEvent` НЕ підходить (маскує).

**Підхід до фіксу:** синхронний re-entrancy guard першим рядком handler-а. Якщо `savingRef` вже є (через `setSavingBoth` що фліпає ref синхронно) — додати `if (savingRef.current || transitioningRef.current) return;`. Якщо немає — завести `const savingRef = useRef(false)`, фліпати `savingRef.current = true` ПЕРЕД `setSaving(true)`, reset у `finally` + `resetForm`. Ref фліпається СИНХРОННО → другий вхід одразу повертається, ще до await. Idempotency-ref лишається (retry-safety) — це два ортогональні механізми. Regression-guard: нативний подвійний dispatch, верифікований revert→2 POST / fix→1 POST.

**Severity:** HIGH для фінансово-облікових документів (SupplierPayment=подвійний борг постачальнику, Invoice=подвійний рахунок, PurchaseOrder=подвійне замовлення, StockDocument=подвійний рух складу, WorkOrder=подвійний наряд); MEDIUM для нефінансових. Ймовірність нижча за retry-кейс (потрібні два click-и в одному tick), але не нульова, а наслідок — дубльований фінансовий документ.

**Де шукати ще:** усі create-модалки (`*CreateModal.tsx`), особливо ті, що мають `setSavingBoth` — перевірити, що ВСІ handler-и (create + edit + transition), а не лише частина, гейтять на savingRef. `SettlementsTabContent.handleCreateAct` — raw apiFetch без savingRef взагалі (кандидат). Backend-двійник: Bug #412 (Serializable $tx для «1 active per parent») — frontend-guard і backend-unique-index/Serializable доповнюють один одного (defense-in-depth: клієнт відсікає домінантний кейс, БД — істинно-паралельний з двох вкладок/адмінів).

### 2026-09-04 — Похідне грошове значення × дріб-коефіцієнт (або reduce/різниця) БЕЗ roundMoney, що покидає систему сирим через export/JSON (Bug #629) — backend / money-precision / report-and-export / LOW-MEDIUM

**Сигнал:** money-обчислення `Number(x) * RATIO` (де RATIO дробовий, напр. `LABOR_COST_RATIO=0.4`), або `reduce((s,r)=>s+r.money, 0)`, або різниця двох сум (`a - b`), результат якого повертається зі звіту/сервісу і потім **емітиться СИРИМ у CSV/XLSX/PDF-експорт або JSON API** — без roundMoney. На екрані маскується `fmt()`/`fmtMoney`, тому візуально «все ок», але у експортованому фінансовому документі (чи у відповіді API стороннім клієнтам) з'являється `1408.1200000000001` / `399.99600000000004` / `66.77000000000001`. Множення на дріб — ГАРАНТОВАНИЙ IEEE-754 дрейф (`3520.30 × 0.4`, `100.10 − 33.33`); Σ у JS-`reduce` дрейфує на певних комбінаціях (`0.1+0.2`); SQL `SUM(...)::float` теж повертає float. ПАСТКА: аудит хвилі округлення фокусується на DB-write і balance-feeding шляхах (стор/баланс) і легко пропускає «лише для перегляду» звіти — але звіти теж покидають систему через export, тож дрейф стає user-visible.

**Причина виникнення:** розробник вважає звітні агрегати «display-only» («fmt на фронті округлить») → не квантує. Хвиля roundMoney квантує stored/balance шляхи, звіти лишаються поза скоупом. Насправді значення виходять сирими двома каналами: (1) CSV/XLSX-експорт емітить числове поле напряму (`rows.push([label, data.grossProfit, ...])`, без fmtMoney — бо для number-детекту XLSX потрібен raw), (2) JSON API-відповідь звіту споживається mobile/sync/зовнішніми клієнтами без гарантії форматування. fmt() на екрані — єдина точка округлення, і її недостатньо.

**Підхід до виявлення:** grep множень/різниць/reduce грошей без roundMoney у сервісах, чий результат покидає систему: `grep -rnE "Number\([^)]*\)\s*[*/]" apps/api/src/modules/{reports,completion-acts,xlsx}` + `grep -rnE "reduce\(\(s.*\+.*(amount|balance|revenue|total|cost|price|vat)" ` + ручний огляд `a - b` де a,b гроші. Для КОЖНОГО кандидата: чи результат іде у `$queryRaw ::float`-суму, чи у `* ratio`, чи у JS-`reduce`? Потім трасувати споживача: чи frontend-експортер (`buildCsv`/`exportReport`/`page.tsx` rows) емітить це поле СИРИМ (без fmtMoney)? Live-проба: викликати report endpoint з даними, що дають фракційний labor/суму → перевірити `round(v*100)/100===v` для КОЖНОГО money-поля відповіді (реплікувати дрейф node-скриптом: `3520.30*0.4`).

**Підхід до фіксу:** roundMoney на КОЖНЕ похідне грошове значення перед поверненням зі звіту/сервісу — множення×дріб, Σ-reduce, різницю сум. НЕ чіпати: `%`-показники (margin), лічильники (count), години (hours) — не гроші. Дзеркалить `sumLineTotals`/invoice `recalcTotals` патерн (`roundMoney(Σ)`). Regression-guard: unit-спец із фракційними входами що дають гарантований дрейф (`totalLabor:3520.3`→`totalCostLabor` `.toBe(1408.12)` не `1408.12000…001`; `net` `.toBe(66.77)`) + `has2Decimals()` helper на кожне money-поле. Якщо у сервісі 0 unit-тестів (частий випадок для reports) — це ще й test-gap, закрити разом.

**Severity:** LOW-MEDIUM — не stored-value, не balance-мутація (тому не CRITICAL/HIGH), але user-visible: спотворене число у експортованому фінансовому документі + сирий float у JSON API. Класична «float-у-документі» (родич completion-acts PDF, який хвиля вже фіксила — але цей шлях пропустила).

**Де шукати ще:** усі report-сервіси (revenue/vat/settlements/profitability/load/stock/work-orders); будь-який `* RATIO`/`* rate`/`/ divisor` на грошах (markup, знижки %, комісії, амортизація, COGS-оцінки); reduce-суми у звітах/дашбордах; різниці балансів/сум; frontend-експортери (`exportReport`, `buildCsv`, xlsx-генератори) що емітять числові поля БЕЗ fmtMoney — саме там backend-дрейф стає видимим. Родич Bug #621/#613 (money-precision клас), completion-acts PDF float (f7a935db).

### 2026-09-04 — DB-constraint error-mapping guard присутній у canonical write, відсутній у alternate-mutation endpoint → 500 замість 409 (Bug #628) — backend / error-mapping-symmetry / robustness / MEDIUM

**Сигнал:** новий Postgres constraint-as-backstop (EXCLUDE, CHECK, unique partial index) додано разом з try/catch-конверсією його SQLSTATE у охайний HTTP (напр. `throwIfExclusionConflict(err, 'calendar_slots_no_overlap', ...)` → 409, `throwIfSerializationConflict` → 400). Конверсію додали у 1-2 очевидні write-методи (`createX`/`updateX`), АЛЕ той самий resource має ТРЕТІЙ мутуючий метод — alternate-mutation endpoint (`syncFromX`/`refreshFromY`/`bulkUpdateZ`/`by-work-order`) — який теж пише поля що тригерять constraint, але повертає `$transaction` напряму без try/catch. Concurrent race, що обійшов app-level probe, → raw SQLSTATE → неперехоплена помилка → **generic 500 + Sentry-шум** замість friendly-4xx. ПАСТКА: EXCLUDE/CHECK перевіряються і на **UPDATE**, не лише INSERT (доводиться live: `UPDATE ... SET startAt=<overlap>` → 23P01) — тож «це ж лише update, не create» хибне.

**Причина виникнення:** розробник фіксить race у методі де його вперше помітив (createSlot), додає try/catch там (і, за симетрією, у updateSlot), але забуває що resource має alternate-mutation endpoint з окремою сигнатурою і власним `return this.prisma.$transaction(...)` без обгортки. Це error-mapping-варіант Bug #403 (alternate-mutation обходить canonical guards): там пропускається business-guard (FSM status), тут — error-conversion guard. App-level conflict-probe у sync може вже бути (Bug #444), що створює хибне відчуття «sync захищений» — але probe ловить лише детермінований конфлікт, race все одно проскакує до DB.

**Підхід до виявлення:** для КОЖНОГО `throwIfExclusionConflict`/`throwIfSerializationConflict`/`mapPrismaErrorToHttp`-виклику у сервісі — знайти ВСІ методи що мутують той самий resource і перевірити чи кожен має обгортку. Grep: `grep -rn "throwIfExclusionConflict\|throwIfSerializationConflict" apps/api/src/modules/<mod>/*.service.ts` → порахувати сайти; окремо `grep -rnE "async (sync|refresh|import|bulk|recalculate|regenerate)[A-Z].*\{" ` + `return this\.prisma\.\$transaction` у тому ж файлі БЕЗ try — gap. Live: після додавання будь-якого EXCLUDE/CHECK — проби КОЖНОГО write-path (включно з alternate) на constraint-порушення через UPDATE (не лише INSERT): Prisma-direct `update({where,data:<overlap>})` → очікувати SQLSTATE; API-рівень concurrent 2×запит → рівно 1 успіх + 1×4xx (не 5xx).

**Підхід до фіксу:** обгорнути `$transaction` alternate-методу у try/catch → той самий `throwIfExclusionConflict(err, <constraintName>, <UA-msg>)` що у canonical. Патерн для `return this.prisma.$transaction(...)`: оголосити `let result: <T>;` перед try, присвоїти всередині, `return result` після (TS бачить `throwIfX: never` → catch non-returning → result definite-assigned, tsc 0). Regression-guards: (1) `$transaction` mock кидає SQLSTATE-shaped Error → `rejects <ConflictException|BadRequestException>`; (2) не-constraint помилка (`'connection reset'`) → пробрасується as-is (не маскується під 4xx).

**Severity:** MEDIUM — цілісність тримається (constraint фізично блокує дубль у ВСІХ шляхах); лише UX/observability (500 замість 4xx + зайвий Sentry-alert + гірша діагностика). НЕ CRITICAL бо не втрата даних; НЕ LOW бо гейтить фінансово/планувально значущий resource і псує alerting-сигнал.

**Де шукати ще:** будь-який resource з DB-backstop constraint + ≥3 write-методами: CalendarSlot (createSlot/updateSlot/**syncWorkOrderSlots** — цей баг), StockItem (createMovement + будь-який alternate quantity-writer × `stock_*_nonneg` CHECK), settlementAccount/cashRegister/bankAccount balance-writers, будь-який `@@unique` partial index з кількома create-шляхами (Invoice.workOrderId, FiscalReceipt.paymentId). Родич Bug #621 (upsert × CHECK) і Bug #403 (alternate обходить canonical guards).

### 2026-09-04 — Deployed `dist/main` застарілий → фікс мовчки не працює на live, попри зелені unit-тести (verification-hygiene) — backend / deployment / verification / process

**Сигнал:** live-верифікація фіксу показує СТАРУ поведінку (напр. FIN-C2: standalone SEND НЕ створює CHARGE — баланс delta=0, у `/transactions` нема `CHARGE ... Invoice`), хоча код у джерелі коректний, `tsc 0`, юніт-тести зелені, і `dist/*.js` містить новий код (grep підтверджує). Причина: запущений `node dist/main` процес стартував ДО останнього білду і тримає стару скомпільовану версію в пам'яті — навіть свіжий `dist` на диску не підхоплюється без рестарту процесу. `nest start --watch` підхопив би, але прод-подібний `node dist/main` — ні.

**Причина виникнення:** dev-стек піднято давно; хтось перезібрав `dist` (або попередня сесія), але процес не перезапущено. `grep dist` вводить в оману — файл на диску новий, процес у пам'яті старий. Легко списати «фікс не працює» на код-баг і почати гонитву за неіснуючою проблемою.

**Підхід до виявлення:** ПЕРЕД live-верифікацією будь-якого backend-фіксу — ЗАВЖДИ `pnpm --filter @sto/api build` + рестарт процесу на порту (kill PID → `node dist/main` заново → wait 200 на `/api/docs`). Правило: **unit-зелений ≠ deployed**. Якщо live показує стару поведінку а `dist`-grep показує новий код → 100% застарілий процес, не код-баг: перезапустити і перепровірити ПЕРШ ніж діагностувати код.

**Підхід до фіксу:** процесний, не код. У tester-runbook: (1) `netstat -ano | grep :3000` → PID; (2) `Stop-Process -Id <PID> -Force`; (3) rebuild; (4) `node dist/main &`; (5) Monitor until `/api/docs`==200; (6) тоді live-probe. Для web — аналогічно + `.next` cache при route-group рефакторингу (Bug #291).

**Severity:** process (не баг коду) — але критичний для достовірності tester-звіту: без рестарту можна (а) хибно оголосити робочий фікс зламаним, (б) хибно оголосити зламаний фікс робочим (якщо стара збірка випадково «проходить»). Обидва напрямки отруюють MemoryManual.

**Де шукати ще:** кожна live-верифікація backend через API; кожен раз коли поведінка суперечить джерелу+тестам+`dist`-grep. Родич Bug #291 (Next.js `.next` cache після route-group rename).

### 2026-09-04 — Fastify content-type-parser помилка (FST*ERR_CTP*\*) не мапиться у filter → 500 замість 4xx (Bug #627) — backend / framework-error-mapping / robustness / LOW

**Сигнал:** bodyless POST-ендпоінт (`/transition`, `/restore`, `/clone`, будь-який без `@Body`) при виклику з заголовком `Content-Type: application/json` + порожнім тілом повертає **500 «Внутрішня помилка сервера»** (не 400/415). У серверному логу — `FastifyError: Body cannot be empty when content-type is set to 'application/json'` (code `FST_ERR_CTP_EMPTY_JSON_BODY`), яка проходить через `else`-гілку `HttpExceptionFilter` (`logger.error` + Sentry). Так само для malformed JSON (`FST_ERR_CTP_INVALID_JSON_BODY`) чи непідтримуваного media type (`FST_ERR_CTP_INVALID_MEDIA_TYPE`, 415). ПАСТКА верифікації: якщо власний тест-клієнт завжди додає `Content-Type: application/json` навіть без тіла — bodyless-ендпоінт даватиме хибний 500, що маскується під «баг ендпоінта» (у моєму випадку 30 хв гонитви за неіснуючим MD-C1 restore-багом, поки лог не показав FastifyError).

**Причина виникнення:** Fastify content-type-parser кидає `FastifyError` зі своїм `statusCode` (4xx) **ДО** входу в NestJS-хендлер. Ця помилка НЕ є `HttpException` (Nest) і НЕ `PrismaClientKnownRequestError` → жодна гілка `mapPrismaErrorToHttp`/`instanceof HttpException` її не ловить → падає у generic 500. Розробник фільтра резонно мапить лише Nest + Prisma помилки, не думаючи про фреймворк-рівневі помилки парсингу запиту що виникають ще до хендлера. Веб-клієнт зазвичай уже захищений (STO `api-client.ts` не додає Content-Type без тіла — з коментарем саме про цю пастку), тож у браузері не проявляється — але mobile/sync/зовнішні інтеграції/тести можуть слати «голий» заголовок.

**Підхід до виявлення:** (1) статично — перевірити `HttpExceptionFilter` (`grep -rn "FST_ERR\|FastifyError\|isFastify" apps/api/src/common/filters`); якщо нема гілки для Fastify-помилок парсингу → gap. (2) live-probe — для будь-якого bodyless POST: `curl -X POST <url> -H "Content-Type: application/json"` (порожнє тіло) → має бути 4xx, НЕ 500. (3) правило самоперевірки тест-харнеса: додавати `Content-Type: application/json` ТІЛЬКИ коли є тіло (інакше власний клієнт генерує хибні 500, що приховують/імітують справжні баги).

**Підхід до фіксу:** у catch-all `ExceptionFilter` додати guard що ловить Fastify request-parse помилки за `code.startsWith('FST_ERR_CTP_')` **І** `statusCode` у 4xx → мапити у той самий `statusCode` з UA-повідомленням + `logger.warn` (без Sentry, як Prisma-коди). НАВМИСНО НЕ чіпати: 5xx-FastifyError (справжні серверні збої лишаються 500) і Node errno з `code` типу `ECONNREFUSED` (guard вимагає префікс `FST_ERR_CTP_`, не будь-який `code`). Regression-guard: unit-спец фільтра з fake-об'єктом `{code:'FST_ERR_CTP_EMPTY_JSON_BODY', statusCode:400}` → 400+warn-not-error; 415 → зберігає statusCode; 5xx → лишається 500; ECONNREFUSED → 500.

**Severity:** LOW — 500 замість 400 (керована помилка, не data-corruption); веб уже захищений; але Sentry-шум + плутанина для не-браузерних клієнтів + робить діагностику інших багів довшою (хибний 500 імітує баг ендпоінта).

**Де шукати ще:** усі catch-all `ExceptionFilter` у проєкті; будь-який bodyless POST/PATCH-ендпоінт (FSM `/transition`, `/restore`, `/clone`, `/refresh`, `/confirm`, `/cancel`, `/set-default`); interceptor-и що читають `request.body`. Родич — власний тест/probe-клієнт: **завжди умовно додавати Content-Type за наявністю тіла**, інакше bodyless-виклики дадуть хибний 500 і зіпсують верифікацію (мій `live_test.py` спершу мав саме цю ваду → хибний MD-C1 «500»).

### 2026-09-04 — Слабкий page-scope `button[aria-expanded]` асерт матчить decoy-тоггл, а не цільовий рядок (Bug #625) — frontend / e2e-integrity / verification / MEDIUM

**Сигнал:** E2E-регресія «фіча X працює» асертить широкий page-level селектор (`page.locator('button[aria-expanded]').first()`, `page.getByRole('button').first()`, `page.locator('table').first()`) для доказу що з'явився ОЧІКУВАНИЙ елемент результату. Тест зелений — АЛЕ на сторінці є ІНШИЙ елемент того ж роду (тоггл «Згорнути» з `aria-expanded={!collapsed}`, будь-яка службова кнопка/таблиця), який матчиться першим. Тест пройшов би навіть при плоскому/порожньому/помилковому результаті — тобто **не охороняє те, що декларує**. Особливо небезпечно для класу багів «функція недосяжна через UX» (§5.4) — саме там де регресія має ловитись (напр. «не групується × 3 повернення»).

**Причина виникнення:** розробник тесту асертить «є хоч один expandable-елемент» як проксі для «результат згруповано», не усвідомлюючи що той самий ARIA-атрибут/роль несе службовий контрол поза таблицею результату. `.first()` бере найвищий у DOM — а службові контроли (хедер-тоггли) зазвичай вище за таблицю. Додатковий підступ: очікуваний стан може взагалі не досягатись у тест-конфігу (напр. groupBy БЕЗ columns → backend не шле `node.rows` → групи `disabled` без `aria-expanded`), тож table-level матчів немає нуль — а page-level decoy ховає це.

**Підхід до виявлення:** (1) для КОЖНОГО «доказового» асерту в UI-регресії спитати «чи цей селектор унікальний для цільового піддерева?» — якщо ні, scope до контейнера результату (`table.locator(...)`, `resultPanel.getByRole(...)`). (2) grep слабких патернів: `grep -rn "page.locator('button\[aria-expanded\]')\|page.getByRole('button').first()\|page.locator('table').first()" apps/web/e2e` → перевірити чи є decoy того ж роду на сторінці (хедер-тоггли з `aria-expanded`, службові кнопки/таблиці). (3) sanity: асерт має падати якщо фіча зламана — тимчасово «зламати» очікуваний стан (порожній groupBy / прибрати columns) і переконатись що тест ЧЕРВОНИЙ; якщо лишився зелений — асерт слабкий. (4) підкріпити позитивними якорями цільового піддерева: `thead th first == 'Група'`, наявність очікуваних лейблів/лічильників, `count > 1`, ВІДСУТНІСТЬ анти-стану-банера («Групування не задано»).

**Підхід до фіксу:** (a) scope селектор до контейнера результату, не сторінки; (b) додати позитивні якорі саме цільового стану (заголовок колонки, кількість груп >1, очікувані лейбли) + негативний якір анти-стану; (c) якщо очікуваний стан вимагає передумови для рендеру (drill-down groups потребують `node.rows` → потрібна колонка) — виставити цю передумову у тесті, інакше guard тестує не той режим. Це тест-фікс, не код-фікс: продакшн-код може бути коректним — але верифікувати це треба ОКРЕМО (жива перевірка §5.4 зі скріном/інспекцією DOM), бо слабкий асерт сам по собі не доказ.

**Severity:** MEDIUM — код може працювати, але регресія-guard фіктивний → майбутня регресія головного сценарію пройде мовчки (саме той сценарій що вже повертався 3 рази).

**Де шукати ще:** будь-який E2E що доказує «з'явився результат X» через широкий селектор при наявності службових контролів того ж роду: disclosure-тоггли (`aria-expanded`), tab-панелі (`role=tab`/`aria-selected`), будь-які `.first()`/`.last()` на неунікальному локаторі, `getByRole('table'/'button'/'listitem').first()`. Родич §5.4: API-верифікація (200/`Σ==grandTotal`) НЕ доводить UI-досяжність; слабкий E2E-асерт — та сама пастка на E2E-рівні.

### 2026-09-04 — Prisma `upsert` create-гілка × Postgres CHECK-констрейнт = 500 на кожній від'ємній дельті (Bug #621) — backend / db / prisma-postgres-semantics / CRITICAL

**Сигнал:** сервіс робить `X.upsert({ where, update: { field: { increment: delta } }, create: { field: delta } })`, де `delta` може бути від'ємним (WRITEOFF/decrement/знакова кількість), А таблиця має `CHECK (field >= 0)`. Живий виклик валить `PrismaClientUnknownRequestError` → Postgres `23514 violates check constraint` з failing-row що містить від'ємне create-значення — **навіть коли рядок ІСНУЄ і `DO UPDATE` дав би валідний результат** (100−40=60). Unit-тести зелені (мок Prisma ніколи не б'є Postgres). Симптом у продакшені: 500 (не 400) на цілому класі операцій.

**Причина виникнення:** Prisma `upsert` компілюється у `INSERT ... VALUES(create) ON CONFLICT(constraint) DO UPDATE SET ...`. У PostgreSQL table-level CHECK-констрейнти оцінюються на **INSERT-tuple ПЕРЕД арбітражем конфлікту** — тобто до того як `ON CONFLICT DO UPDATE` встигне «врятувати» рядок. Розробник резонно вважає що при існуючому рядку виконається UPDATE-гілка і create-payload «не матиме значення» — але Postgres спершу конструює й перевіряє insert-tuple. Особливо підступно: **сам баг створюється попереднім фіксом** — QA-цикл додає non-neg CHECK як backstop (Bug #613 Layer-3), і цей CHECK ретроактивно ламає кожен upsert-writer таблиці з від'ємною create-дельтою.

**Підхід до виявлення:** (1) статично — `grep -rn "\.upsert(" apps/api/src/modules --include="*.service.ts"`; для кожного match зіставити `create`-payload поля з non-neg CHECK-констрейнтами (`grep -rn "CHECK.*>= 0\|_nonneg\|_nonneg" packages/database/prisma/migrations/`); ризик там де create-поле = знакова дельта. (2) **обов'язково live-probe, не unit** — після будь-якої міграції що додає `CHECK (col >= 0)`, прогнати КОЖЕН upsert-writer цієї таблиці з від'ємною дельтою через API/curl проти живої dev-БД (existing row + від'ємна дельта → має бути 2xx, не 500). Ізоляція: прямий Prisma-probe `upsert` фейлить, а plain `update` по тому самому compound-key — ок; raw-SQL `INSERT ... ON CONFLICT` відтворює 23514 на SQL-рівні (доказ що це Postgres-семантика, не Prisma-баг).

**Підхід до фіксу:** клампити create-гілку до валідного діапазону (`quantity: Math.max(0, delta)`), лишаючи update-гілку з реальною дельтою (`{ increment: delta }`). Create-гілка виконується ЛИШЕ коли рядка ще нема — а тоді від'ємний стан і так неможливий (pre-check «недостатньо» відсік би раніше). Regression-guard: unit-асерт саме на `upsert.mock.calls[0][0].create.<field>` ≥ 0 при від'ємному вхідному dto (мок не б'є Postgres, тож guard-асерт на payload, а не на runtime-поведінку).

**Severity:** CRITICAL — блокує весь клас операцій (усі WRITEOFF/TRANSFER-out/WO-COMPLETED); 500 замість керованого 400; невидимий для unit-CI.

**Де шукати ще:** будь-яка таблиця з non-neg (чи range) CHECK + upsert-writer зі знаковою create-дельтою: `stock_items.quantity/reserved` (виправлено), `stock_batches.remainingQty` (safe — createFromReceipt лише додатні, consume через updateMany), settlementAccount/cashRegister/bankAccount balance (наразі БЕЗ non-neg CHECK — але якщо додадуть, кожен upsert-writer балансу впаде), loyaltyAccount.points (якщо додати CHECK≥0). Мета-правило: **міграція що додає CHECK на існуючу таблицю = обов'язковий live-probe кожного upsert/insert-writer з граничними значеннями.**

### 2026-09-04 — Guard-order у inline «add-to-collection» helper: unique-check коротшить перед limit/permission-check (Bug #606) — frontend / UX / guard-ordering

**Сигнал:** новий helper типу `addToZone(zone, key)` / `addToList(key)` / `addToSelection(id)` виконує guards `permission → limit → includes(key)` у такому порядку. Новий click-shortcut (кнопка на вже-доданому елементі) відкриває сценарій «повторний add» → limit/permission guard спрацьовує на nothing-to-do → misleading toast «Максимум 5/немає прав». Гарди були скопійовані з drop-варіанту де унікальність гарантована.
**Grep:** `addTo\w+|toggleIn\w+|selectField|pushTo` — для кожного helper'а перевірити що `includes(key)`/`has(id)` **ПЕРШИМ** перед toast-throwing guard. Static test: список до ліміту → повторний виклик з наявним ключем → НЕ кидає toast «ліміт». E2E: `waitForTimeout(300-500ms)` + `toHaveCount(0)` (toast async).
**Фікс:** `unique-check first` — `if (collection.includes/has(key)) return;` на найпершу позицію після null-check; коментар з конкретним сценарієм («5/5 + повторний клік»); дзеркально виправити всі паралельні гілки (groupBy + filters).
**Severity:** LOW-MEDIUM — не втрата даних, але критичний UX-signal (user думає що система зламана); легко пропускається при static/unit-only тестуванні.
**Де шукати ще:** Zone/Palette/Picker з click-shortcut (tag input, multi-select chip, permission grid), «Add to favorites/bookmarks/pinned», batch «вибрати всі до ліміту», filter/sort field pickers з MAX-N.

---

### 2026-09-04 — Cross-midnight probe protocol: timezone-aware date-bucketing регресійна live-верифікація — backend / time-zone / aggregation / verification

**Сигнал:** свіжий fix «UTC→Local-day» у date-групуванні (`toISOString().slice(0,10)` → `Intl.DateTimeFormat('sv-SE',{timeZone:...})`) або зміна helper `KYIV_YMD`/`localYMD`/`kyivDate`. Ризик: fix проходить unit-тести (mock Date), але seed-дані можуть не містити cross-midnight записів → live-response ідентичний UTC → регресія прихована до реальної cross-midnight транзакції.
**Probe (live):**

```
1. curl POST /reports/... columns=[dateField,valueField] groupBy=[] includeRows=true → raw timestamps
2. для кожного ts: utc_day = ts[:10] vs local_day = astimezone(TARGET_TZ).strftime('%Y-%m-%d') → count cross-midnight
3. якщо 0 → створити транзакцію у cross-midnight window (POST createdAt=<tomorrow-01:30-local>)
4. curl POST /reports/... groupBy=[dateField] aggregations=[SUM(valueField)] → server-agg
5. client-side: by_local_day[astimezone(TZ).ymd] += value
6. АСЕРТ server.tree[day].SUM == client.by_local_day[day] для КОЖНОГО дня + sum(all)==grandTotal
```

**Grep фіксу:** `toISOString().slice\(0,10\)|toISOString\(\).*substring\(0` → locale-aware `Intl.DateTimeFormat('sv-SE',{timeZone})`; `getUTCHours|getUTCDate|getUTCMonth` разом з `Date`. Усі public export'и `common/utils/kyiv-date.ts` — один formatter.
**Фікс:** regression tests: (a) DST-boundary літо+зима `T22:30:00Z`; (b) DST-transition day; (c) UTC-day boundary 00:00Z±1s. Anti-pattern: «unit-тест з mock Date проходить → OK» — потрібен живий probe.
**Severity:** CRITICAL коли групування впливає на фінансово-звітну logic (daily sales/balance/inventory delta); MEDIUM для UI-only сортування.
**Де шукати ще:** aggregator з `DateTime` bucketing (normalizeKey/groupKey/dateGroup/toDateStr), report endpoints `{date,value}[]`, cache keys з «сьогодні», cron triggers у Docker без TZ, frontend chart labels.

---

### 2026-09-03 — Semantic aggregation drift: SUM over a signed field включає значення яке не впливає на ресурс (Bug #619) — backend / aggregation / business-invariant

**Сигнал:** реєстр декларує field як `signedByType`, а aggregator обчислює `SUM(field)` без ВИКЛЮЧЕННЯ типів які **не змінюють** ресурс. StockMovement: RESERVATION/RESERVATION_RELEASE рухають `reserved`, не `quantity`; SettlementTransaction: PREPAYMENT_APPLICATION не змінює `balance`. Aggregator який їх включає дає числа-«привиди». Розробник думає «знак правильний → SUM правильний».
**Grep:** `signedByType` / `MovementType` / `TransactionType` разом з `SUM|reduce` — чи виключаються NON_PHYSICAL типи. Live-probe: `curl POST /reports/... groupBy=[type]` → `Σ(бакети)==grandTotal` І grandTotal == бізнес-нетто. Cross-check `grep -n "quantityDelta|balanceDelta" *.service.ts` → type-значення з `delta=0` = кандидати на виключення. Property-based: `expect(sumThroughAggregator(rows)).toBe(sumThroughService(rows))`.
**Фікс:** whitelist `NON_PHYSICAL_MOVEMENT_TYPES = new Set([...])`; `numericValue` повертає `null` для non-mutation-типів (SUM/AVG/MIN/MAX пропускають). Regression: (a) grandTotal mixed-type; (b) WRITEOFF backstop; (c) non-mutation бакети SUM=0.
**Severity:** HIGH коли поле фінансово-числове (quantity/amount/balance) у management-звітах; різниця >20% при інтенсивному резервуванні.
**Де шукати ще:** SettlementTransaction.amount (PREPAYMENT/CREDIT_NOTE), Payment.amount (cash vs bonus/loyalty), Invoice.paidAmount (refunds), Bookkeeping Debit/Credit sign.

---

### 2026-09-03 — Formatter-metadata drift: рендер тип-специфічного значення шукає тип поля у списку який його НЕ містить (Bug #620) — frontend / contract-drift / display

**Сигнал:** frontend-формайтер (`fmtValue(alias, cols)`, `renderCell(key, columns)`) резолвить тип поля через lookup у `columns` (обране користувачем), але контекст містить значення полів **поза** `columns` (aggregation-only, footer grand-total, row-hover). Backend віддає `aggregations:[{field,agg}]` без `type` → фронт не знаходить тип → падає у fallback (money-format або plain string).
**Grep:** `\.type|colType|fieldType` разом з `\.find\(c\s*=>\s*c\.key`; `grep -rn "cols\.find\|columns\.find" apps/web/src`. Live-probe: `curl POST` з агрегацією що НЕ дублює колонку → чи є type/label у response.aggregations? Manual: drag агрегат у header → NaN/грошовий формат замість дати/enum.
**Фікс (backend-first):** backend enrichment — додати `{type,label}` до кожного array item «поля що буде показане» (додаткові поля, не breaking). Формайтер приймає ОБИДВА джерела (aggregations, columns) → шукає тип послідовно → fallback. НЕ покладатись на окремий metadata hook (робить формайтер coupled). Regression: (a) backend spec response.aggregations[0].type/label==entity.fields[key]; (b) frontend spec formatter з cols_without_field + aggregations_with_field.
**Severity:** HIGH коли розбіжність візуальна (дата як млрд грн, boolean як «0», UUID як plain-string); MEDIUM якщо тільки label відсутній.
**Де шукати ще:** sortable headers з ONLY-sort полем, chart/dashboard з computed metrics, Excel/PDF export з aggregation-only column, notification templates з полем-агрегатом.

---

### 2026-09-02 — Concurrent pre-check → write без row-lock контракту → від'ємні лічильники силентно (Bug #613) — backend / concurrency / financial-integrity

**Сигнал:** service робить `findFirst({select:{counter}}) → BUSINESS-GUARD → upsert/update({counter:{increment:-X}})` в одному `$transaction` без `isolationLevel:'Serializable'`. Prisma default = Read Committed → 2 concurrent tx обидва проходять guard на stale snapshot → другий декрементує `counter` до **−N без сигналу** (немає CHECK у міграціях). Read Committed не серіалізує read+write.
**Grep:** `grep -rn "isolationLevel|Serializable" apps/api/src/modules/<hot-path>` = 0 для inventory/settlements/cash-registers/bank-accounts/deliveryOrder-receivedQty; `grep -rn "CHECK.*<counter>|<counter>.*CHECK" packages/database/prisma/migrations/` = 0. Асиметрія з захищеним модулем (Bug #412) сигналізує ризик.
**Фікс (2 layers):**

- **Layer 1 post-upsert re-check:** `.select({counter})` у upsert → `if (upserted.counter < 0) throw BadRequestException('...concurrent...')` — throw всередині $tx = rollback. Захищає ГЛОБАЛЬНИЙ інваріант рядка.
- **Layer 2 conditional updateMany:** `X.update({data:{field:{decrement:n}}})` → `X.updateMany({where:{id, field:{gte:n}}, data})`. Атомарний CHECK+DECREMENT; race `count=0` → throw. Захищає ЛОКАЛЬНИЙ інваріант row.

Regression: service.spec (happy `mockResolvedValueOnce({quantity:-10})→throw`; updateMany `mockResolvedValueOnce({count:0})→throw + expect(next).not.toHaveBeenCalled()`); invariants.spec property-based `totalConsumed <= initial`; коментар ЧОМУ не Serializable + яка race-послідовність.
**Severity:** HIGH коли інваріант фінансовий (quantity/balance/reserved) чи bookkeeping; MEDIUM для non-critical counters.
**Де шукати ще:** `findFirst → upsert/update({increment/decrement})` у Read Committed: settlementAccount.balance (payment/refund flows), cashRegister/bankAccount.balance, deliveryOrder.receivedQty, purchaseOrder.paidAmount, будь-який decrement без CHECK≥0.

---

### 2026-09-02 — 0 нових багів у активному фінансовому scope → property-based cross-invariant regression-guard (Bug #612) — backend / financial-integrity / test-coverage / property-based

**Сигнал:** явний `/sto-tester` bug hunt на фінансово-чутливій гілці (FIFO/AVG_COST, BALANCE_SIGN, cost-carry); всі фокус-області перевірені → **0 нових активних багів** (попередні цикли додали example-based guards). Прицільні unit-тести ловлять конкретну регресію, але не доводять що інваріант тримається для БУДЬ-ЯКОЇ послідовності — refactor `??→||` у cost-carry (0 як falsy) чи зміна знаку SUPPLIER_REFUND пройде example-based CI зеленим.
**Grep:** у sibling `*.invariants.spec.ts` наявність `fc.property` для КОЖНОГО інваріанту (FIFO span, cost-method порядок, all-or-nothing, AVG_COST sentinel, batchId fixation, BALANCE_SIGN cycle, `??` vs `||`). Тільки `it()` без property-based = coverage-gap.
**Фікс:** новий `<module>.invariants.spec.ts`, 4-6 describe (10-25 property tests, 200-500 numRuns):

- **Consume/mutation** — Σ output==input; масовий баланс; нема ресурсу у мінус; guard-стан; порядок обходу FIFO/LIFO; all-or-nothing (throw + no mutation).
- **Aggregation** — Σ bucket==загальне; overflow→excess; порядок наповнення.
- **Sign/enum** — exhaustive `Object.values(enum).forEach(t=>expect(SIGN[t]).toBeDefined())`; повний+частковий цикл; RELATED types той самий знак.
- **`??` vs `||`** — `it("weightedCostPrice=0 через ?? НЕ падає у fallback", ()=>{ expect(0??100).toBe(0); expect(0||100).toBe(100); })` — guard проти `??→||`.

Дзеркалити реалізацію у моделі-функції (`consumeBatchModel`, `fillSchedule`) — тестувати ІНВАРІАНТ, не Prisma-мок.
**Severity:** MEDIUM (regression-guard, не активний баг). Критично не пропустити turn без внеску — «0 знайдено» без нових тестів залишає регресії відкритими.
**Де шукати ще:** модуль з 3+ finger-print Bug'ів (financial cycle, FSM, sync outbox) → після 3-го fix переходити на property-based; multi-branch switch/if-else 3+ гілок; nullable-safe `??`/`??=`.

---

### 2026-09-02 — Live-DB probe для DB CHECK/rollback/invariant верифікації (цикл 3 фінальний) — backend / operational-verification / live-evidence

**Сигнал:** цикли N−1, N−2 додали defensive layers (CHECK constraints, post-upsert re-check, updateMany conditional, self-wrap $transaction) покриті **unit-тестами з моками**. Жоден unit-тест не доводить що Postgres реально ловить CHECK на UPDATE (не тільки INSERT), що `$transaction` відкочує mixed ORM+raw, що live-БД масштабно тримає інваріант. Unit = «письмо про механізм», probe = «фотографія роботи».
**Probe (ad-hoc, фінальний цикл):**

1. **DB constraint** — `$executeRaw INSERT/UPDATE` з value що порушує CHECK → код помилки (23514 check, 23503 FK, 23505 unique). Перевірити ОБИДВІ операції (INSERT+UPDATE) — міграція може відключити одну.
2. **Rollback** — `$transaction(async tx => { tx.model.create(...); tx.$executeRaw INSERT з CHECK-violation })` → count до/після однаковий (mixed ORM+raw справді відкочується).
3. **Invariant sweep** — SQL `SELECT si.quantity, (SELECT SUM(sb.remainingQty) ...) as batchSum FROM stock_items si WHERE ABS(quantity-batchSum) > epsilon`. Живі дані, не fixture.
4. **Semantic map READ, not HARDCODED** — sign-мапу (BALANCE_SIGN, FSM) читати з коду, не переписувати у probe. Хардкод → **false positive** (гірше за пропущений баг).
   **Фікс:** CHECK не спрацював → міграція з `DO $$ ... IF NOT EXISTS`; rollback не спрацював → перевірити nested `$transaction` (savepoint) / bare `prisma.` поза tx; invariant розійшовся → **не патчити probe**, розслідувати (legacy data) → clamp+backfill. Regression: unit-мок Prisma throw `code:'23514'` → локалізоване повідомлення; integration з реальною $transaction; property-based invariant (Bug #612).
   **Severity:** MEDIUM (verification-only). Критичний як фінальна валідація перед merge — піраміда unit→integration→live когерентна.
   **Де шукати ще:** міграція з CHECK/UNIQUE/FK (probe що constraint реально живе), `createMovement`/`createTransaction`/`createDocument` з self-wrap $transaction, recompute-функції (recomputeBalance, Reconciliation) з map як єдиним джерелом правди.

---

### 2026-09-02 — inventory cost-method switch + COGS writeback: 3-layer regression protocol (Bugs #609, #610, #611) — backend / financial-integrity / test-coverage

**Сигнал:** commit `feat(inventory): підключення партійного FIFO-списання` — service стає multi-return (`{movementId, consumed, weightedCostPrice}` замість void), switch за `costMethod:'FIFO'|'LIFO'|'FEFO'|'AVG_COST'` з різним orderBy, caller (WO writeoff / TRANSFER / SupplierReturn) **записує cost назад** у row-модель. 3 concern зливаються у один $transaction: (1) cost-method switch (не-default гілка LIFO/FEFO без тесту → refactor asc↔desc чи видалення `nulls:'last'` проходить CI); (2) writeback `if (result.weightedCostPrice != null) db.workOrderPart.update({...})` (легко зняти, spec не мокає write-side); (3) cost carry TRANSFER — SEQUENTIAL `const src = await writeoff(...); await receipt({price: src.weightedCostPrice ?? baseArgs.price})`, повернення до Promise.all → target batch отримує lines.price замість FIFO cost.
**Grep/probe:**

```
- Cost-method matrix: PATCH /settings/organisation {costMethod} → seed 2-3 партії → WRITEOFF /stock-documents → правильна партія (LIFO новіша, FIFO старіша, FEFO createdAt asc null-expiry, AVG weighted)
- Global invariant: Σ StockBatch.remainingQty(active) == StockItem.quantity (raw GROUP BY, HAVING <>, 0 mismatches)
- WO trace: single-batch batchCostPrice=X,batchId=<uuid>; span batchCostPrice=weighted,batchId=null,2+ BatchConsumption
- TRANSFER carry: RECEIPT 5×@40+5×@60 → TRANSFER 8 → target (5×40+3×60)/8=47.5, НЕ salePrice
- spec grep: expect(prisma.workOrderPart.update).toHaveBeenCalledWith для writeback (0=gap); orderBy per switch-branch
- await Promise.all([.*writeoff.*, .*receipt.*]) = regression (не carry-cost)
```

**Фікс:** 3 regression tests — writeback (5 сценаріїв: single-batch, span, null-skip, multi-parts, no-price-arg); cost carry (2: src.weightedCostPrice у target.price; fallback при null); orderBy switch (1 assert per cost-method `expect(prisma.stockBatch.findMany).toHaveBeenCalledWith(objectContaining({orderBy:[...]}))`).
**Severity:** HIGH (#609,#610) — фінансова точність рентабельності; MEDIUM (#611) — silent drift для LIFO/FEFO.
**Де шукати ще:** `service.method()` `void→{...compound}` (grep sibling spec за новими result-компонентами), `createMovement(WRITEOFF)` з writeback, `switch(costMethod/paymentMethod/docType)` (unit на кожну гілку), Promise.all→sequential (`expect(callOrder).toEqual(['WRITEOFF','RECEIPT'])`).

---

### 2026-09-02 — після фінансової migration з backfill: audit invariant через live API (Bug #606, #607, #608) — api / backend / frontend / financial-integrity / migration-verification

**Сигнал:** commit `fix(settlements): виправлення знаку` / `add enum value + backfill` / `migrations/*_backfill_*`. Знак балансу = функція типу транзакції, але семантика **різна для клієнта і постачальника** (CHARGE:+1 для клієнта = «нам винен» правильно; той самий для постачальника означав би «постачальник нам винен» — а фактично **ми винні йому**). Old-code `receive()→CHARGE` писав неправильний знак → баланси постачальників додатні → `getSchedule` (balance<0) порожній → feature «мертва» на реальних даних, тести проходять. Fix: 3 нові enum (SUPPLIER_CHARGE/PAYMENT/REFUND) + backfill re-type по `documentType` + recompute balance=Σ signed(tx). Міграція 2-стадійна: (1) ADD ENUM VALUE окремо; (2) DML backfill. Frontend знак-код паралельно розходиться (Bug #606).
**Grep/probe:**

```
1. Live invariant: balance == Σ BALANCE_SIGN(tx.type)×tx.amount для КОЖНОГО акаунта (Python через /counterparties/:id/balance + /transactions?limit=500, дзеркальний BALANCE_SIGN); ідемпотентність backfill
2. Cross-source: /reports/settlements totalCredit vs /supplier-payments/schedule totals.total — має збігатися для активних SUPPLIER/BOTH; різниця → soft-delete filter drift (Bug #607)
3. FE sibling-drift: grep копій `balance>0 ? 'destructive' : 'success'` — ≥2 файли (list + CP card + панелі + PDF); CLIENT vs SUPPLIER мають РІЗНУ шкалу
4. Exhaustive: Object.values(SettlementTransactionType).forEach(t=>expect(BALANCE_SIGN[t]).toBeDefined()) + expect(BALANCE_SIGN.CHARGE).toBe(1) (Record<enum> не ловить зміну середнього ключа 1→−1 — Bug #606 root)
5. E2E: receive(X)→partial SP(Y<X)→balance=−(X−Y); SUPPLIER_REFUND(+1) → tx-log містить `SUPPLIER_REFUND` не `REFUND`
6. Client-regression: 5-10 CLIENT-акаунтів — Counter(tx.type) без жодного SUPPLIER_*
```

**Фікс:** тип-aware UI helper `settlementBalanceTone(balance, type)` в `lib/utils.ts` (CLIENT>0=red/<0=warning; SUPPLIER<0=red/>0=warning; BOTH nonzero→red) — ВСІ balance-header з ONE МІСЦЯ; nested soft-delete filter `where.counterparty={deletedAt:null}` у звітах; regression: exhaustive by-enum assert, property `receive(X)−pay(Y)+refund(Z) → −(X−Y−Z)`, BOTH-mix знаки не інтерферують.
**Severity:** HIGH (гроші, UI/reports узгодженість). Не CRITICAL — backfill спрацював 139/139, але наступна зміна знаку → silent drift.
**Де шукати ще:** Reconciliation act (новий aggregate/export/pdf endpoint дублює `type=='CHARGE'`), dashboard KPI «заборгованість» картки, PDF pdfmake docDefinition, sync-outbox pending зі старими типами, mobile settlements, share-token публічний акт-звірки PDF.

---

### 2026-09-01 — restore() без парент-chain guard → silent orphan (Bugs #601, #602, #603) — api / backend / data-integrity / soft-delete

**Сигнал:** новий `POST /:id/restore` над child-агрегатом (Vehicle→Garage→Counterparty; Contract→Counterparty; Invoice→WO). `service.restore()` робить atomic `updateMany({where:{id,orgId,NOT:{deletedAt:null}},data:{deletedAt:null}})` **без** prep-check на активність parent-ів, хоча sibling `create/findX/updateX/removeX` мають parent-guard `findFirst({id:parentId,orgId,deletedAt:null})→404`. Асиметрія. Live: `DELETE child → DELETE parent → POST child/restore → 201` = silent orphan (child активний, parent видалений; `GET parent/children`→404, `GET /children/{id}`→200).
**Grep:**

```bash
grep -rn "async restore" apps/api/src/modules --include="*.service.ts" -A5
# для кожного: чи є findFirst({id:parentId,orgId,deletedAt:null}) ПЕРЕД updateMany? тільки updateMany = gap
# schema.prisma: model X, relation fields з ? — чи parent-model має deletedAt (soft-delete-able)
# Live curl: create parent→child; DELETE child; DELETE parent; POST child/restore → 201 = bug
```

**Фікс:** ОДИН `findFirst` перед atomic-restore: (а) знаходить child з `deletedAt:not-null`; (б) SELECT parent-chain з `deletedAt` через nested select; (в) distinguisher: child не знайдено/чужа org → `NotFoundException`; double-restore (child активний) → `NotFoundException`; parent chain has `deletedAt!==null` → `BadRequestException` («Контрагента авто видалено. Спочатку відновіть контрагента.») з ПРІОРИТЕТОМ найдальшого предка (CP>garage). Vehicle (2 рівні): `findFirst({where:{id,orgId}, select:{deletedAt:true, customerGarage:{select:{deletedAt:true, counterparty:{select:{deletedAt:true}}}}}})` → 4 guards CP>garage>double-restore>tenant.
**Severity:** HIGH (data corruption через public API, silent orphan). Не CRITICAL (lower-tier data) але підриває UX-довіру + ламає downstream (WO з orphan vehicleId).
**Де шукати ще:** WorkOrder/Invoice/PurchaseOrder/WorkOrderLine/StockDocument `.restore()` — parent soft-delete-able. Bullseye: `grep -rn "@Post.*restore" apps/api/src/modules --include="*.controller.ts"`. Регресія-guard для КОЖНОГО restore: 5 кейсів — happy→201; double-restore→404; parent-CP deleted→400; parent-garage deleted→400; cross-tenant→404. Всі з `expect(prisma.X.updateMany).not.toHaveBeenCalled()` (fail-closed).

---

### 2026-08-30 — Cross-field guard + новий single-pass aggregator без regression-test (Bug #597) — api / backend / test-coverage / regression-guard

**Сигнал:** service-метод має `throw new BadRequestException('...')` для крос-полю validation (`from>to`, `windowDays>100`, `qty>available`) АБО новий single-pass aggregator (після optimize: multi-reduce → for-of + `totals.byX`). Парний `*.spec.ts` НЕ містить `it(...)` для цих guards/aggregators. Класична split-fix: impl-fix у review/optimize-циклі, парний test-fix забутий.
**Grep:**

```bash
# cross-field guards:
grep -rn "throw new BadRequestException" apps/api/src/modules --include="*.service.ts" -B1 | grep -B1 "if (.*>.*\|if (.*<.*\|if (.*!==.*"
grep -rn "'Вікно графіка не може перевищувати'" apps/api/src --include="*.spec.ts"   # 0 = gap
# single-pass aggregator:
grep -rn "for (const .* of .* )\|for (const .* in " apps/api/src --include="*.service.ts" -A2 | grep -B1 "totals\[.*\] = (totals\[.*\] ?? 0) +"
grep -rn "totals\.byX\|totals\.byDate\|totals\.by" apps/api/src --include="*.spec.ts"   # тільки totals.total → gap
```

**Фікс:** cross-field guard — 3 кейси: (а) invalid→`rejects.toThrow(BadRequestException)`; (б) `expect(prisma.X.find).not.toHaveBeenCalled()`; (в) boundary→resolves (`>` vs `>=`). Aggregator — 1-2: 2+ contributors у bucket→sum; empty bucket не в output; Σ buckets==grand total.
**Severity:** MEDIUM (regression risk, impl зараз працює). aggregator output user-visible (footer/totals).
**Де шукати ще:** сервіс з recent `simplify:`/`perf(optimize):`/`fix(review):` що змінив service.ts — чи парний `.spec.ts` теж у diff: `git show <commit> --stat | grep -E "service.ts|spec.ts"`. Pre-commit hook: review/optimize commit з `.service.ts` вимагає діф у `.spec.ts`.

---

### 2026-08-30 — URL deep-link writer без парного reader (Bug #596) — web / frontend / navigation / broken-feature

**Сигнал:** кнопка «покажи X у Y» виглядає як deep-link (`ExternalLink`, `text-primary`), клік перекидає у Y — АЛЕ Y відкривається у голому стані без відмітки/модалки/скролу. Grep `?<param>=` повертає РІВНО 1 match — писач без читача. Next.js ігнорує unknown query params, TS зелений, E2E рідко перевіряє post-navigation state.
**Grep:**

```bash
grep -rnE "router\.(push|replace)\(\`?[/'\"][a-z-/]+[^)]*\?[a-z]+=" apps/web/src --include="*.tsx"
# для кожного writer витягти <target-page>+<param>, перевірити reader:
grep -c "searchParams.get('$param')" apps/web/src/app/\(app\)/$target/page.tsx || echo "MISSING READER"
```

**Фікс:** (A) реалізувати reader (preferable) — на mount читати param, виконати дію, одразу очистити `router.replace`, ідемпотентно:

```typescript
useEffect(() => {
  const openId = searchParams.get('open');
  if (openId && UUID_RE.test(openId)) {
    setEditingPOId(openId);
    const params = new URLSearchParams(searchParams.toString());
    params.delete('open');
    router.replace(params.toString() ? `?${params.toString()}` : '?', { scroll: false });
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, []); // mount-only — refresh не reopens
```

(B) прибрати param у writer якщо feature не готова. Регресія-guard: Playwright `page.goto('/target?param=<uuid>')` → `expect(modal-or-highlighted-row).toBeVisible()`.
**Severity:** LOW (broken UX, не crash); MEDIUM якщо tooltip/label обіцяє конкретну дію.
**Де шукати ще:** cross-linking pairs: counterparties↔work-orders, vehicles↔work-orders, invoices↔counterparties, purchase-orders↔supplier-payments, warehouses↔stock-documents.

---

### 2026-06-20 — Prisma `$queryRaw` + pg_trgm `%` operator без `::text` cast (Bug #572) — api / backend / sql / type-resolution

**Сигнал:** `$queryRaw` з `pg_trgm` similarity (`%` оператор) повертає 500. Postgres `42804`: `argument of OR must be type boolean, not type text`. Працює для `column % $1`, падає при concatenation на LHS: `COALESCE(a,'') || ' ' || COALESCE(b,'') % $N`. Prisma шле `$N` без explicit type → planner при ambiguous context (text||text expr, `%` має overloads pg_trgm/модуло) резолвить `$N` як text → `text % text` без trgm resolution повертає text → 42804.
**Grep:**

```bash
grep -rn "\$queryRaw" apps/api/src --include="*.ts" -A 30 | grep -B 1 "%\s*\${" | grep -v "::text"
# контракт-тест: search/similarity endpoint з 5+ варіантами q (English, Cyrillic, empty, numeric) → 200
curl -s -w "%{http_code}" "http://localhost:3000/api/<endpoint>?q=Toyota" -H "$AUTH"
```

**Фікс:** для всіх `$queryRaw` params у `%`/`ILIKE`/`similarity()` — explicit cast:

```typescript
const qText = `${q}`;
const qLike = `%${q}%`;
await prisma.$queryRaw`WHERE col % ${qText}::text OR col ILIKE ${qLike}::text AND similarity(col, ${qText}::text) > 0.3`;
```

Те саме `${uuid}::uuid`, `${num}::int`, `${date}::timestamptz`.
**Severity:** HIGH (endpoint падає на специфічних запитах, 500 у production).
**Де шукати ще:** search/list endpoints з pg_trgm GIN indexes (counterparties, work_orders, goods, brands), reports/analytics similarity-grouping, `$queryRaw` у складному expression (concatenation, COALESCE, CASE WHEN).

---

### 2026-06-20 — pnpm-workspace.yaml overrides peer incompatibility (Bug #573) — infra / dependencies / startup

**Сигнал:** API не стартує після `pnpm install`. `FastifyError: fastify-plugin: @fastify/<plugin> - expected '5.x' fastify version, '4.28.1' is installed` (FST_ERR_PLUGIN_VERSION_MISMATCH) або `@nestjs/*` вимагає Nest 11.x на 10.x. Security override з `>=` constraint (для CVE) у `pnpm-workspace.yaml`: після переїзду overrides package.json→pnpm-workspace (pnpm 11+, раніше silently ігнорувалися) pnpm install витяг найновішу версію що вимагає newer peer.
**Grep:**

```bash
grep -A 5 "^overrides:" pnpm-workspace.yaml
# для кожного: RESOLVED=$(grep -A 2 "@fastify/middie" pnpm-lock.yaml | grep resolution | head -1); resolved major > runtime → ризик
# pnpm --filter @sto/api dev → FST_ERR_PLUGIN_VERSION_MISMATCH → знайти max compatible major
```

**Фікс:** pin override до останньої runtime-peer-сумісної major-лінії:

```yaml
overrides:
  '@fastify/middie': '^8.0.0' # 9.x вимагає fastify 5.x; ми на 4.28 → остання fastify-4 лінія
```

Коментар: причина (CVE) + чому цей major.
**Severity:** CRITICAL — API/Web не стартує. Не виявляється у CI бо cache; тільки fresh install + restart.
**Де шукати ще:** всі `>=` у pnpm-workspace overrides → конкретний major; щотижня fresh `pnpm install` + dev sanity; CI `node dist/main` smoke test.

---

### 2026-06-20 — Silent `test.skip(true)` як fake-green replacement (мета-патерн) — e2e / test-debt

**Сигнал:** E2E spec містить `if (!data) return test.skip(true, '...')` де `data` — результат API до endpoint що seed надійно заповнює. Skipped виглядає як «pass» у CI — фактично нічого не перевіряє. Boilerplate defensive skip для «empty DB» ніколи не спрацьовує (seed повний) і прикриває bug коли seed/API ламається.
**Grep:**

```bash
grep -rn "test.skip(true" apps/web/e2e --include="*.spec.ts"
npx playwright test --reporter=line 2>&1 | grep -E "skipped"
```

**Фікс:** `if (!data) test.skip(...)` → `expect(data, 'Seed має ...').toBeTruthy(); if (!data) return; // TS narrow`. Виняток — conditional UI feature (XLSX import): `if (hasFeature) {...} else {expect modal still works}`.
**Severity:** MEDIUM (не prod bug, приховує regressions).
**Де шукати ще:** будь-який spec при нових тестах; CI grep skipped>5 → failure; pre-commit `grep test.skip\(true apps/web/e2e/*.spec.ts && exit 1`.

---

### 2026-06-20 — E2E pagination-blind test з stale DB records (Bug #568) — e2e / test-debt / pagination

**Сигнал:** E2E створює запис `E2E-Foo-{uid}`, перевіряє `table tbody tr:has-text("E2E-Foo-...")` БЕЗ попереднього search/filter. Проходить на чистій CI БД, fails з timeout 20s у dev де накопичились E2E records (sort=name ASC + pagination(30) ховає новий рядок на page 2/3). Assume «новий запис → сторінка 1» справедливе тільки коли total ≤ pageSize.
**Grep:**

```bash
grep -rn "table tbody tr:has-text" apps/web/e2e --include="*.spec.ts" | while read line; do
  file=$(echo "$line" | cut -d: -f1)
  if ! grep -B 50 "table tbody tr:has-text" "$file" | grep -q "Пошук\|search\|filter.*fill"; then
    echo "PAGINATION-BLIND: $line"
  fi
done
```

**Фікс:** перед `toBeVisible` — `await page.getByPlaceholder('Пошук...').fill(uniqueName)`. Детермінізує видимість незалежно від stale data.
**Severity:** HIGH (інтермітентне падіння у dev, блокер suite).
**Де шукати ще:** crud-counterparties/vehicles, invoices, work-orders, stock-documents — кожен create+verify-row; модуль з pagination 30+ + alphabetic sort default.

---

### 2026-06-20 — Reflector-based contract test для new @Decorator (Bug #569) — api / contract / regression-guard

**Сигнал:** review commit додає security/behavioral decorator на існуючий controller method (`@Throttle`, `@UseGuards(JwtAuthGuard)`, `@Roles`, `@HttpCode`, `@ApiBearerAuth`). Тести (`*.service.spec.ts`) перевіряють бізнес-логіку, не reflection metadata. Декоратор через `Reflect.defineMetadata` невидимий у unit-моках; жоден guard не падає при відсутності decorator (Throttler пропускає route без metadata) → false security, тихе видалення при refactor.
**Grep:**

```bash
grep -rn "@Controller\|@Get(\|@Post(\|@Patch(\|@Delete(" apps/api/src/modules --include="*.controller.ts" | grep -v "spec"
ls apps/api/src/modules/*/ | grep -E "throttle.*contract\.spec"   # для @Throttle endpoint
```

**Фікс:** `<module>.<decorator>.contract.spec.ts` з `new Reflector()`:

```ts
const limit = reflector.get<number>(
  `${THROTTLER_LIMIT}default`,
  BookingController.prototype.createPublic,
);
expect(limit).toBe(5);
```

Keys для `@nestjs/throttler`: `THROTTLER_LIMIT+'default'`, `THROTTLER_TTL+'default'` (named — ім'я замість `default`).
**Severity:** LOW (немає прямого багу), HIGH preventive (захист від тихого регресу security декоратора).
**Де шукати ще:** модуль з `@Throttle/@Roles/@UseGuards/@HttpCode` доданим після initial impl — особливо публічні endpoints у booking, share, webhooks.

---

### 2026-06-20 — Cross-package LABELS/BADGE контракт-тест для shared constants (Bug #570) — web / shared / drift-detection

**Сигнал:** FE `LABELS[entity.status] ?? entity.status` (з `@sto/shared` чи inline-копія). Backend додає новий enum value → FE LABELS не оновлюється → fallback повертає raw `NEW_STATUS_X` замість українського. TS не падає (обидва `Record<string,string>`), drift непомічений до production.
**Grep:**

```bash
grep -rn "_LABELS\[.*\] ?? " apps/web/src --include="*.tsx" --include="*.ts"
grep "enum.*Status\|enum GoodType\|enum CounterpartyType" packages/database/prisma/schema.prisma
find apps/web/src -name "*labels.test.*" -o -name "*-status.test.*"
```

**Фікс:** `apps/web/src/lib/<entity>-status-labels.test.ts` зі списком `EXPECTED_STATUSES` (дзеркало prisma enum) + it.each: кожен має label/badge/description, кирилиця `/[Ѐ-ӿ]/`, all 3 maps однакові ключі. Тест паде першим якщо backend додасть статус без оновлення shared.
**Severity:** LOW (regression guard, no current bug).
**Де шукати ще:** INVOICE_STATUS_LABELS, PO_STATUS_LABELS, STOCK_DOC_STATUS/TYPE_LABELS, COUNTERPARTY_TYPE_LABELS, GOOD_TYPE_LABELS, EMPLOYEE_ROLE_LABELS.

---

### 2026-06-17 — Local interface дрейфує від hook/DTO коли додається нове поле (Bug #506 / #510) — frontend / type-duplication

**Сигнал:** ім'я типу `WorkOrder`/`Invoice`/`Counterparty` дублюється: `hooks/api/use<Entity>.ts` (авторитетний) + `<entity>/page.tsx`/`[id]/PageClient.tsx` (inline-дублікат). Backend додає поле у `<Entity>ResponseDto` → hook оновлюється, локальний interface забутий → TS компілюється, нове поле невидиме, розрахунки розходяться. Найгірше — feature міняє формулу `totalAmount`, UI продовжує сумувати `totalLabor+totalParts` → математично некоректна сума.
**Grep:**

```bash
grep -rn "^interface WorkOrder " apps/web/src --include="*.ts*"   # >1 match → один застарілий
diff <(grep -A 50 "^export interface WorkOrder " apps/web/src/hooks/api/useWorkOrders.ts) \
     <(grep -A 50 "^interface WorkOrderDetail " apps/web/src/app/\(app\)/work-orders/\[id\]/PageClient.tsx)
grep -rn "totalActualLabor\|<newField>" apps/web/src --include="*.ts*"   # має бути у ВСІХ типах aggregate
```

**Фікс:** `import { WorkOrder } from '@/hooks/api/useWorkOrders'`, `interface WorkOrderDetail extends WorkOrder { lines; parts; }`. Регресія-guard `satisfies`: `const _check: WorkOrderDetail = {} as Awaited<ReturnType<typeof fetchWorkOrder>>;` (tsc error при drift).
**Severity:** MEDIUM (не data loss, UI довіра — некоректні суми); HIGH з gross-сумами (помилка у рахунку).
**Де шукати ще:** тріада `[id]/PageClient.tsx` + `Create<Entity>Modal.tsx` + `use<Entity>.ts`; ризик у aggregate-полях (totalAmount, paidAmount, balanceAmount).

---

### 2026-06-17 — Семантична зміна загального поля без оновлення downstream consumers (Bug #508) — backend / consistency

**Сигнал:** feature змінює формулу вже існуючого denormalized поля (`totalAmount`, `paidAmount`, `balance`, `cost`) що читається всюди (service flows, public/share endpoints, PDF, FE views, reports, sync). Автор оновив головний flow, пропустив semantic mismatch у consumer. Класика: estimate-share показує `wo.totalAmount` що тепер «actual amount» (з actualHours), хоча контекст естімейту = PLAN. Зміна у `recalcTotals` поширюється туди де семантично не повинна.
**Grep:**

```bash
grep -rn "\.totalAmount\|totalAmount:" apps/api/src --include="*.ts" | grep -v "spec\|test"
# категоризувати: "actual" (completion/invoice/settlement) → нова формула OK; "planned" (estimate/share/draft) → WRONG
# кожен share/public endpoint має інший semantic contract — не наслідує internal change
```

**Фікс:** у share/public consumer — обчислити ЛОКАЛЬНО з planning-компонентів:

```ts
totalAmount: Number(wo.totalLabor) + Number(wo.totalParts),   // замість Number(wo.totalAmount)
```

Регресія-guard: property/snapshot «estimate-share = totalLabor+totalParts (no actualHours leak)» для WO з ненульовими actualHours.
**Severity:** LOW-MEDIUM — баг у крайових випадках, але некоректна публічна сторінка заплутує клієнта.
**Де шукати ще:** пари (denormalized field, share/public): wo.totalAmount↔estimate, invoice.amount↔receipt, counterparty.balance↔self-service, vehicle.currentMileage↔public history.

---

### 2026-06-19 — Shared include-shape const (3 read paths) без regression-guard на DTO field propagation (Bug #541) — backend / test-coverage / refactor safety

**Сигнал:** review-fix витягує дублюваний Prisma `include`-shape у shared const (`PART_GOOD_INCLUDE`/`<X>_INCLUDE`) у 3+ read paths (`findOne`/`createX`/`updateX`/FSM). Drift між callsites попереджено, АЛЕ жоден test не асертить що поля const реально потрапляють у DTO. `toDto` мапить `?? null` → видалення `internalCode:true` з const-shape: TS green (DTO `internalCode?:string|null`), `toDto` повертає null (silent), FE не показує, тести passing. `as const satisfies Prisma.<X>DefaultArgs` дає safety лише до видалення поля з const.
**Grep:**

```bash
grep -rnE "^const [A-Z_]+_INCLUDE\s*=" apps/api/src/modules --include="*.service.ts"
# для кожного: paired spec (*.service.spec.ts / *.role-gate.spec.ts) mock-fixture <relation> має містити ВСІ scalar поля
#   (не лише name — internalCode/sku/brand.name/unit); grep -E "internalCode|sku|brand\.name" $spec
# mock-fixture good = {name, unit} тільки → bug
```

**Фікс:** для КОЖНОГО shared include-const один з: (1) розширити mock-fixture до повного shape; (2) regression-guard `it()`:

```typescript
it('DTO містить goodInternalCode / goodSku / goodBrandName', async () => {
  const wo = await service.findOne(ORG, WO_ID);
  expect(wo.parts[0]).toMatchObject({
    goodInternalCode: 'INT-001',
    goodSku: 'SKU-1',
    goodBrandName: 'Toyota',
  });
});
```

(3) дзеркальний guard у кожному callsite (findOne/addPart/updatePart) — refactor може забути includes у 1 з 3.
**Severity:** LOW (silent regression-guard gap; broken тільки коли drift станеться); MEDIUM коли const-shape дає denormalized PII для share-link (counterpartyName, vehicleLabel).
**Де шукати ще:** `const <X>_INCLUDE`/`<X>_SELECT`/`<X>_DEFAULT_ARGS` у service.ts ≥2 callsites: PART_GOOD_INCLUDE, PO_LINE_GOOD_INCLUDE, GOOD_UOM_SELECT, shared Counterparty/Vehicle projection у FSM.

---

### 2026-06-17 — Role-gated sensitive field у DTO без regression-guard у service spec (Bug #527, #529) — backend / security / test-coverage

**Сигнал:** commit `fix/feat: role-gate <Field> for <ContextDto>` додає whitelist-ролі (`<X>_VISIBLE_ROLES = new Set<string>([...])`), helper `canSeeX(role)`, optional `userRole?:string` у service. Поле чутливе (`costPrice`, `purchasePrice`, `margin`, `internalNotes`, `bankAccount`). Ризики без тесту: refactor видаляє `userRole`; default `'OWNER'` → leak; typo у Set → leak для механіка; нова роль забута у whitelist.
**Grep:**

```bash
grep -rn "<Field>\|canSee<Field>\|<X>_VISIBLE_ROLES" apps/api/src --include="*.spec.ts"   # 0 = bug
git log --all --oneline --grep="role-gate\|VISIBLE_ROLES\|canSee" -- apps/api/src
grep -rn "to<DtoName>\(" apps/api/src --include="*.service.ts" | grep -v spec   # кожен callsite передає userRole?
grep -rn "Set<string>" apps/api/src --include="*.service.ts" | grep -i "role"   # case-sensitive vs JWT claim
```

Endpoint що повертають DTO і потребують userRole: GET /:id, POST create/add*, PATCH update*, bulk list details=true.
**Фікс:** dedicated `<module>.role-gate.spec.ts` матриця: привілейовані ролі `it.each([['OWNER'],['ADMIN']])` бачать; непривілейовані `it.each([['MECHANIC']])` не бачать (undefined); edge fail-closed для `userRole===undefined/''/'GUEST'/'owner'` (lowercase); semantic `<Field>===null` для привілейованої (доступ є, value not set) ≠ undefined; симетрія для кожного mutation. Defense-in-depth: всі DTO-endpoint приймають userRole. Spec = guard проти видалення param / rename const / нова роль / default 'OWNER'.
**Severity:** HIGH (release-blocker Auth) коли поле фінансове/PII; MEDIUM для informational/audit. Gap у тесті = security gap.
**Де шукати ще:** DTO поля prefix `cost*`, `purchase*`, `internal*`, `audit*`, `private*`, `secret*`, `bankAccount`, `taxId`, `phone`/`email` (public counterparty), `salary`/`wage`, `margin`.

---

### 2026-06-17 — React inline-edit merge втрачає DB-only fields (`id`, `createdAt`) → save() filter мовчки пропускає рядок (Bug #526) — frontend / state-merge

**Сигнал:** inline-row-edit (CreateWorkOrderModal, BudgetTab, будь-який list-with-edit) — на commit ✓ merge губить `id`:

```ts
const [editing, setEditing] = useState<Omit<Item, 'id'>>(EMPTY); // editable subset без id
setItems(prev => prev.map(it => (it._key === target._key ? { ...editing, _key: it._key } : it))); // ← id загублено
```

Далі `save()` робить `items.filter(i => !!i.id)` → row пропадає → PATCH не надсилається → після reload старе value. WO-level (sum/total) виглядає збереженим → маскує bug. `Omit<LocalLine, '_key'>` робить `id` опціональним → spread valid, нема compile error.
**Grep:**

```bash
grep -rn "\.\.\.editing.*_key" apps/web/src --include="*.tsx" --include="*.ts"   # editing/base містять id?
grep -rn "filter.*!!.*\.id\|filter.*l\.id" apps/web/src --include="*.tsx" --include="*.ts"   # перетин у файлі = high-risk
grep -rn "Omit<.*'_key'>" apps/web/src --include="*.ts*"
```

**Фікс:** spread base FIRST:

```ts
{ ...l, ...editing, _key: l._key }   // l first preserves id/createdAt
```

Регресія-guard (RTL): після click ✓ assert `lines[0].id === <original-id>` або spy на apiFetch PATCH `/lines/<originalId>`.
**Severity:** CRITICAL — silent data-loss маскований UI feedback («збережено» → значення зникло після reload).
**Де шукати ще:** CreateInvoiceModal, CreatePurchaseOrderModal, CreateStockDocumentModal, BudgetTab, будь-яка двофазна editing UI (server list + local edit buffer).

---

### 2026-06-16 — Time-of-day string DTO field без regex + cross-field guard (Bug #515) — backend / validation

**Сигнал:** `@IsString()` для поля `*Time` або `*Hour` у DTO БЕЗ `@Matches(/^\d{2}:\d{2}$/)`. Сервіс не валідує `workEnd > workStart` → `dynHours=[]` → division by zero → NaN у CSS. Де ще шукати: `BranchSettings`, `OperatingHours`, `EmployeeShift`, `EventSchedule`.

**Підхід:** Додати `@Matches(HH_MM_RE)` до DTO + cross-field guard у сервісі (`if (startH >= endH) throw BadRequest`). Defense-in-depth fallback у `getWorkHours()` щоб ніколи не повернути `start >= end` навіть якщо стара БД містить невалідні дані.

**Grep:**

```bash
grep -rn "@IsString()" apps/api/src --include="*.dto.ts" | grep -i "time\|hour\|start\|end" | grep -v "@Matches"
```

---

### 2026-06-16 — jsdom missing URL.createObjectURL/revokeObjectURL stub (Bug #518) — frontend / test-infrastructure

**Сигнал:** `vitest exit 1` при всіх green tests + `Uncaught Exception: TypeError: URL.createObjectURL is not a function`. Shadow error — видно тільки по exit code, не по test report.

**Fix:** У `apps/web/src/__tests__/setup.ts` додати:

```typescript
if (typeof URL.createObjectURL === 'undefined') {
  URL.createObjectURL = () => '';
  URL.revokeObjectURL = () => {};
}
```

**Grep:**

```bash
grep -n "createObjectURL\|revokeObjectURL" apps/web/src --include="*.tsx" --include="*.ts" -r
# якщо є → перевірити apps/web/src/__tests__/setup.ts на наявність stub
```

---

### 2026-06-16 — Dead exports у \*.utils.ts після refactor на dynamic config (Bug #517) — frontend / dead-code

**Сигнал:** `const` exported у `calendar.utils.ts` або подібному файлі має 0 usages після того як компонент перейшов на `useState(fetched)`. TypeScript не видає error на unused exports.

**Підхід:** Після будь-якого refactor що переводить module-level constants → dynamic fetch: перевірити всі exports модуля на 0 references.

```bash
grep -rn "HOURS\|TOTAL_HOURS\|WINDOW_START\|WINDOW_END\|pxToHours" apps/web/src --include="*.ts" --include="*.tsx" | grep -v "\.utils\.ts"
# якщо 0 matches → dead export → видалити
```

---

### 2026-06-16 — Set key з `getUTCHours()` для порівняння з Kyiv-локальними слотами (Bug #511) — backend / time-zone semantics

**Сигнал:** ключ Map/Set формується через `getUTCHours()`/`getUTCMinutes()` з `DateTime` поля як `HH:MM`, а в тому ж файлі інший масив ключів — з Kyiv-локальних `BranchSettings.workStartTime/workEndTime` (або UI пікера). Ключі НЕ перетинаються весь рік (Europe/Kyiv +02/+03 ≠ UTC) → `Set.has(...)` always false → guard silently не спрацьовує. Розробник думав «UTC у БД → всі похідні з UTC», але робочі години «09:00–18:00» — Kyiv-local.
**Grep:**

```bash
grep -rn "getUTCHours\|getUTCMinutes" apps/api/src/modules --include="*.ts" | grep -v spec
grep -B2 -A2 "getUTCHours" <file> | grep -E "workStart|workEnd|BranchSettings|slot.*minutes|kyiv"   # parallel HH:MM з НЕ-UTC = bug
grep -l "BranchSettings\|workStartTime" apps/api/src/modules --include="*.ts" -r | while read f; do grep -l "getUTCHours\|getUTCMinutes" "$f"; done
grep -rn "toISOString().slice(11" apps/web/src --include="*.ts*" | grep -v test   # frontend mirror UTC HH:MM
```

**Фікс:** module-level `Intl.DateTimeFormat` singleton `{timeZone:'Europe/Kyiv', hour12:false, hour/minute:'2-digit'}` (locale `'en-GB'` дає padded HH:MM); `.format(date)` замість `getUTC*`+padStart (авто-DST). Регресія-guard: unit з date що переходить UTC midnight у Kyiv (`2026-06-01T22:30:00Z` → 01:30 Kyiv NEXT day).
**Severity:** CRITICAL коли guard блокує бронювання/payment/inventory; HIGH для UI display; MEDIUM для log/analytics.
**Де шукати ще:** модуль що порівнює BookingRequest.requestedDate/CalendarSlot.startAt/WorkOrder.scheduledAt/Payment.paidAt/Invoice.documentDate/StockMovement.movedAt з user-введеними часами; frontend useCalendarState, CreateWorkOrderModal datetime, `<TimeInput>` persist UTC vs Kyiv window.

---

### 2026-06-16 — `useRef` для уникнення ре-рендерів стає stale коли його ініціалізація async (Bug #512) — frontend / race condition

**Сигнал:** дві паралельні `useEffect` на mount: один fetch A (`/lifts`) пише у `useRef`, інший `useCallback` **читає ref** у `.then()` з deps `[date]` (НЕ `[lifts]` щоб уникнути подвійної fetch). Якщо B резолвиться ДО A → ref читає `[]` → derived state (`bookingSlots`) порожній назавжди (до зміни date). Тест проходить (моки одразу), cache hit ховає у dev. Перший виклик load() теж читає порожній ref.
**Grep:**

```bash
grep -rnE "useRef\(\[?\]?\)" apps/web/src --include="*.ts*" | grep -v test   # де Ref.current=X у .then()
grep -B3 -A10 "useRef" apps/web/src/<file>.ts | grep -E "useCallback|useEffect"   # deps [date] без lifts.length АЛЕ читає liftsRef.current = bug
# race test: mock /lifts резолвиться останнім (delay) → expect bookingSlots.length > 0
```

**Фікс:** додати proxy `.length` у deps callback (`lifts.length` 0→N перевикликає з готовим ref). Альтернатива — Promise.all([lifts, bookings]) у єдиному effect (+1 round-trip). Регресія-guard: vitest `mockResolvedValueOnce(new Promise(r => setTimeout(() => r(<data>), 100)))` повільний /lifts vs швидке /booking.
**Severity:** HIGH коли feature видимо ламається; MEDIUM приховані індикатори; LOW cosmetic.
**Де шукати ще:** hook з `useRef([])` async-init + `useCallback` без проксі-сигналу (useChatState, useDashboardState, useTimelineState); будь-яка `useCallback([dateOnly])` що читає state через closure → stale.

---

### 2026-06-16 — Unclamped UI math для нових feature-блоків копіюється з existing блоку але втрачає back-end guard (Bug #513) — frontend / UI overflow

**Сигнал:** новий component (`BookingSlotBlock`) копіює positioning math (`left = ((startH - HOURS[0]) / TOTAL_HOURS) * 100`) з existing (`DraggableSlot`). Existing працює бо дані clamp-ляться через service (`createSlot() → kyivEndOfWorkDay`), новий бере дані з іншого джерела (`BookingRequest.requestedDate`) БЕЗ clamp → `left<0` / `width>100%` → блок невидимий за parent box. `overflow:hidden` ховає, JS не падає.
**Grep:**

```bash
grep -rn "((startH - HOURS\[0\])\|left = .* % \|kyivHours(slot" apps/web/src --include="*.tsx"
# для кожного: чи source має server-side clamp? CalendarSlot createSlot()→kyivEndOfWorkDay ✓; BookingRequest ✗ (Bug #513+#514)
# defensive: if (endH <= MIN || startH >= MAX) return null; + Math.max(MIN,startH), Math.min(MAX,endH)
```

**Фікс:** (1) defensive clamp у component; (2) парний back-end guard для джерела (Bug #514 family). Регресія-guard: vitest out-of-bounds startH (`'2026-06-01T04:00:00.000Z'`=07:00 Kyiv літо, HOURS[0]=8) → `container.firstChild` має `left:'0%'` або null.
**Severity:** MEDIUM коли invisible block ховає data; HIGH коли block — CTA.
**Де шукати ще:** Gantt timelines, schedule grids, sparklines, progress bars з `width %` з user input, chart axis labels, drag-and-drop position calc.

---

### 2026-06-15 — Queue.add(name, data) shape не співпадає з processor `process(job)` interface (Bug #506) — backend / queue / contract drift

**Сигнал:** `someQueue.add('job-name', { fieldA, fieldB })` у service-A, але `@Processor('queue') WorkerHost.process(job)` робить `const { fieldX, fieldY } = job.data` — **жодне поле не співпадає**. tsc green (payload `any`/JSON), unit-spec обох сторін проходять окремо. Runtime: processor читає undefined → `if (provider==='X')` false → **silent skip** замість throw → BullMQ НЕ retry → SMS не приходить, user бачить успіх. Причина: service-A написано до NotificationsService.send() consolidation, АБО `bull→bullmq` refactor (старий `@Process({name})` фільтрував job.name, новий `WorkerHost.process()` не фільтрує → всі jobs у один process()).
**Grep:**

```bash
grep -rnE "Queue.*add\(\s*['\"]([^'\"]+)['\"]" apps/api/src --include="*.ts" | grep -v spec   # name + data shape
grep -rnE "@Processor\(['\"]([^'\"]+)['\"]" apps/api/src --include="*.processor.ts"
# interface XxxJob { у processor → порівняти ключі з data-об'єктом у Queue.add(); unique callsite key (templateCode, params) відсутній у Job = bug
# декілька callsite з РІЗНИМИ shape на одну чергу → потрібна switch(job.name) диспетчеризація АБО окремі черги
```

**Фікс:** знайти canonical service черги (NotificationsService.send() для SMS, SettlementsService.createTransaction() для balance, InventoryService.createMovement() для stock) що агрегує resolve + ставить правильний shape; переписати порушуючий callsite на нього, прибрати `@InjectQueue`/`BullModule.registerQueue`. Новий event-type → enum + `ALTER TYPE ADD VALUE IF NOT EXISTS` + seed NotificationTemplate (Bug #220, #478-#480). Spec: видалити `expect(opts.attempts).toBe(10)` (Bug #507 лише options); `expect(canonicalService.send).toHaveBeenCalledWith(orgId, expect.any(String), objectContaining({branchId, phone, ...placeholders}))`.
**Severity:** HIGH (фіча розрекламована «надішлемо SMS» але silent gap); MEDIUM для non-critical (loyalty); CRITICAL для фінансової операції (ПРРО чек, settlement).
**Де шукати ще:** `@InjectQueue(name)` поза canonical service — особливо public/widget endpoints (booking, form, lead) до consolidation; після кожного queue-library migration — audit shape vs interface. Парне з Bug #267/#268.

---

### 2026-06-16 — Widened service return-type + stale paired spec (Bugs #508-#509) — backend / contract / tests symmetry

**Сигнал:** service-method розширюється з `Promise<{id,number}>` до `Promise<{id,number,status,amount,documentDate}>` (розширений `select` + mapping `Number(inv.amount)`, `inv.documentDate?.toISOString() ?? null`). Backend+FE tsc green, але baseline unit-spec падає: `expected {…5} to equal {…2}` — mock повертав `{id,number}`, mapping робить `Number(undefined)→NaN`, `inv.status→undefined`. Release-blocker. Contract-spec тихіше: `toMatchObject({id, number})` пропускає нові undefined поля → silent regression-guard gap (refactor що видалить поле з select пройде CI, FE отримає undefined/NaN/Invalid Date). Sprint-lag: impl+FE оновлені, regression tests відстають 1-2 commits.
**Grep:**

```bash
git diff HEAD~3 HEAD -- "apps/api/src/modules/*/*.service.ts" | grep -E "^\+\s+(status|amount|documentDate|totalAmount|fiscalCode|[a-z]+At|[a-z]+Count):\s*(true|inv\.|Number|\.toISOString|\?\?\s*null)"
grep -rn "mockResolvedValue\|mockResolvedValueOnce" apps/api/src/modules/<scope>/ --include="*.spec.ts" -A 5   # чи покриває НОВІ поля
grep -rn "toMatchObject({" apps/api/src --include="*.contract.spec.ts"   # підмножина-assert без negation = gap
```

**Фікс:** unit-spec mock — всі нові поля з реалістичним Prisma-shape (Decimal/Date, null для nullable); unit assert `expect(result).toEqual({..все 5..})` конкретні значення (не `expect.any`); contract mock той самий shape; contract assert `expect(res.json()).toEqual({..все 5..})` (НЕ toMatchObject — видалення поля з select → undefined → JSON без ключа → підмножина проходить, silenced); окремий null-branch case; component-test для FE consumer (Bug #510 family).
**Severity:** HIGH якщо unit-spec падає (release-blocker); MEDIUM лише contract-spec gap; LOW косметичне поле з fallback.
**Де шукати ще:** service.ts чіпнутий review-commit після feature; lightweight-read endpoint для «це існує?» що пізніше отримує fields (findActive, findLast, findPrimary). Парне з Bug #390, #478-#480, #432-#433.

---

### 2026-06-15 — `setX(value)` викликається у async-операції, але `x` не читається у JSX (Bug #497) — frontend / dead-state / UX feedback

**Сигнал:** `const [loading, setLoading] = useState(false)` (або `loadingId`, `saving`) → setter викликається у async-handler (`setLoading(true)` перед await, false у finally), але `loading` НІКОЛИ не читається у JSX (немає `{loading && <Spinner/>}`, `disabled={loading}`, `loading={loading}` prop). Extra renders + memory churn, але user не бачить реакції UI (клік Pencil → 1-3s нічого → Modal). Refactor видалив JSX що читав state, забув видалити setLoading.
**Grep:**

```bash
grep -rnE "useState[<(]boolean|useState\(false\)|useState<string \| null>\(null\)|useState<number \| null>\(null\)" apps/web/src/app --include="*.tsx" -A 1 | grep "const \[" | head -30
# для кожного state-name (loading/saving/processing/loadingId/transitioning/submitting):
#   has_decl=$(grep -c "const \[$name," "$f"); has_read=$(grep -cE "\{$name|$name &&|disabled=\{$name|loading=\{$name" "$f")
#   decl>0 && read==0 → MUTE STATE
```

**Фікс:** (1) видалити state якщо feedback не потрібна (<100ms); (2) render-time: single-row `disabled={saving}`+`loading={saving}` або `{saving && <Spinner/>}`; per-row `loading={detailLoadingId === row.id}` (уникає disabled для ВСІХ рядків).
**Severity:** MEDIUM (silent UX gap); LOW якщо <100ms. Парне з Bug #303 (in-flight guard).
**Де шукати ще:** `loadDetail`/`fetchFull`/`fetchOne`/`loadOptions` async → per-row loading-state; search input з debounced fetch; inline-edit save button + savingIds.

---

### 2026-06-15 — `mutateAsync()` у inline click-handler без try/catch — silent failure при mutation error (Bug #499) — frontend / error-handling / silent UX failure

**Сигнал:** inline `onClick={async () => { await mut.mutateAsync(arg); toast.success('...') }}` без try/catch, без `useMutation({onError})`, без глобального `MutationCache.onError`. `mutateAsync` rejects → throw перериває handler → ні success, ні error toast → user клікнув «Видалити» → нічого → рядок на місці → плутанина. TanStack Query НЕ показує помилки автоматично.
**Grep:**

```bash
grep -rn "MutationCache\|mutationCache:" apps/web/src   # пусто → ВСІ inline mutateAsync без try/catch = bug
grep -rnE "await\s+\w+\.mutateAsync\(" apps/web/src/app --include="*.tsx" -B 2 -A 3   # чи є try/catch
```

**Фікс:** (1) per-hook `onError` (preferable): `useMutation({ mutationFn, onError: e => toast.error(e.message), onSuccess: () => qc.invalidate(...) })` — SSOT для всіх callers; (2) inline try/catch коли message contextual; (highest leverage) глобальний `MutationCache.onError` у QueryClientProvider.
**Severity:** MEDIUM (silent failure); HIGH якщо mutation видаляє важливий ресурс (Invoice/Payment/WO transition) → duplicate-click → data inconsistency.
**Де шукати ще:** inline `onClick={async () =>` single-step mutation (icon-button Trash2/Pencil/Zap, inline-confirm, bulk-actions); `useEffect(() => { mutation.mutateAsync() }, [])` (unhandled rejection).

---

### 2026-06-15 — `Partial<Record<Enum, V>>` lookup з runtime fallthrough ховає TS-exhaustiveness (Bug #488) — backend / business logic / type-safety

**Сигнал:** map `Partial<Record<EnumX, ValueY>>` для look-up знаку/типу по enum, з runtime `if (sign === undefined) throw new Error('Unknown...')`. Зараз всі enum присутні (throw неможливий), АЛЕ через `Partial<>` новий enum value (`ALTER TYPE ADD VALUE`) **пройде compile зеленим** → runtime exception у проді. Автор почав з `{}` literal (TS вимагав Partial) і забув видалити.
**Grep:**

```bash
grep -rnE "Partial<Record<[A-Z][a-zA-Z]+(Type|Status|Role|Kind),\s" apps/api/src/modules --include="*.ts" | grep -v spec
# всі enum values присутні → Partial<> непотрібно; tell: `if (X === undefined) throw` нижче = compensation
```

**Фікс:** `Partial<Record<Enum,V>>` → плоский `Record<Enum,V>` (TS вимагатиме всі values → новий enum зловить compile-error); видалити runtime guard. Якщо Partial потрібна — коментар «intentional partial: <причина>» + regression-guard для default-branch.
**Severity:** MEDIUM (рідкісний runtime exception); HIGH якщо map гейтить фінансову операцію (BALANCE_SIGN, TAX_RATE, VAT_FACTOR) — throw blocks commit.
**Де шукати ще:** MOVEMENT_TYPES, docTypeMap, TRANSITIONS (FSM), LABELS/BADGE/COLOR (для UI Partial з fallback «—» OK), `Record<EnumX, fn>` switch-replacement у sales/payments/inventory.

---

### 2026-06-15 — Dedup invariant додано після simplify-to-Promise.all БЕЗ regression-guard у spec (Bug #489) — test-coverage / silent data corruption

**Сигнал:** simplify замінив sequential `for-loop { await tx.X.update() }` (last-write-wins) на `await Promise.all(plan.map(u => tx.X.update()))` (race-deterministic winner на той самий PK) + додав `dedupedPlan = deduplicateBy(plan, u => u.pk)` ПЕРЕД Promise.all для збереження last-wins. Парний spec НЕ перевіряє invariant — refactor що дропне `deduplicateBy` (бачить «dead code») пройде CI зеленим (fixtures унікальні PK). Production має дублікати (PO multi-lot на той самий goodId, xlsx з повторюваним SKU).
**Grep:**

```bash
grep -rn "deduplicateBy\|new Map(.*\.map.*=> \[" apps/api/src/modules --include="*.service.ts" -l
for svc in $(grep -rl "deduplicateBy" apps/api/src/modules --include="*.service.ts"); do
  spec="${svc%.ts}.spec.ts"; grep -cE "deduplicate|duplicate.*(goodId|lineId|id)" "$spec" 2>/dev/null   # 0 = bug
done
```

**Фікс:** regression-guard test — `plan` з 2+ entries з ОДНИМ PK (різні price/quantity); mock downstream різні значення; run метод; `expect(prisma.X.updateMany).toHaveBeenCalledTimes(1)` (НЕ 2!); `data: { <field>: <last-value> }` (last-wins). Опційно `result.updated === 2` (informational).
**Sub-pattern: stale `$transaction` mock у callback-form:**

```ts
// ❌ повертає callback БЕЗ виклику:  $transaction: vi.fn(async (ops) => ops),
// ✅ розпізнає обидві форми:
$transaction: vi.fn().mockImplementation((arg) => {
  if (Array.isArray(arg)) return Promise.all(arg);
  if (typeof arg === 'function') return arg(prisma);
  return Promise.resolve(arg);
}),
```

Якщо service спрощено array→callback-form АЛЕ spec мок не оновлено → INNER логіка НЕ виконується → всі внутрішні asserts мовчки проходять. Для кожного `$transaction(async...)` → мок ОБОВ'ЯЗКОВО розпізнає callback.
**Severity:** MEDIUM (silent data corruption на duplicate-PK; race-determinism = випадковий winner).
**Де шукати ще:** `applyX`/`bulkUpdateX`/`recalculateX`/`syncFromY` з масивом можливих duplicate-PK: pricing (PO/xlsx/rule apply), reservation release on FSM, batch FEFO writeoff, settlement reconciliation, period-end close.

---

### 2026-06-15 — Новий documentType literal не зареєстрований у DOC_TYPE_LABELS map (Bug #491) — backend / i18n / UI consistency

**Сигнал:** новий ресурс (`SupplierReturn`, `ReconciliationAct`) пише StockMovement/SettlementTransaction з `documentType: '<NewName>'`, АЛЕ `inventory.service.ts:DOC_TYPE_LABELS` не має парного запису → `docLabel` fallback `DOC_TYPE_LABELS[documentType] ?? documentType` → UI показує англомовний `'SupplierReturn'` замість `'Повернення постачальнику'` (CLAUDE.md #15-#17). Map у ЧУЖОМУ модулі (inventory), TS не падає (Record<string,string>).
**Grep:**

```bash
grep -rnE "documentType:\s*'[A-Z][a-zA-Z]+'" apps/api/src/modules --include="*.service.ts" | grep -oE "'[A-Z][a-zA-Z]+'" | sort -u
grep -oE "^\s+[A-Z][a-zA-Z]+:\s*'" apps/api/src/modules/inventory/inventory.service.ts | grep -oE "[A-Z][a-zA-Z]+" | sort -u
# diff двох списків → unmapped = bug
```

**Фікс:** додати `<NewModel>: 'Український label'` у DOC_TYPE_LABELS. Better: винести у `packages/shared/.../document-labels.ts` як `Record<DocumentType, string>` (НЕ Partial) — TS-exhaustiveness заверне commit без label.
**Severity:** MEDIUM (UI inconsistency); LOW якщо internal/admin-only.
**Де шукати ще:** новий ресурс що пише documentType у history: StockMovement.documentType, SettlementTransaction.documentType, AuditEvent.entityType, NotificationEvent.relatedDocumentType.

---

### 2026-06-15 — DTO line-level FK поля (`goodId`, `unitOfMeasureId`) пишуться через `createMany` без cross-tenant guard (Bug #495) — backend / tenant isolation / Bug #161 family

**Сигнал:** `create()`/`update()` приймає `dto.lines: Array<{goodId, unitOfMeasureId?, ...}>` і пише `tx.<resource>Line.createMany({data})` БЕЗ preceding `findFirst({orgId, id: l.goodId})` для КОЖНОГО FK. Bug #161 розширене на nested arrays (batch масштабує impact). Автор валідує parent FK (supplierId) але child line FK пропускає (Prisma FK валідує лише глобальне існування `id`, НЕ `orgId`) → ADMIN з валідним JWT створює документ з goodId з чужої org.
**Grep:**

```bash
grep -rnE "tx\.\w+Line\.createMany\s*\(\s*\{" apps/api/src/modules --include="*.service.ts" -l
grep -B5 "Line\.createMany" <service.ts> | grep -E "good\.findMany.*orgId|good\.findFirst.*orgId"   # 0 = bug
```

**Фікс:** `validateLineRefs(orgId, lines)` batch через Promise.all ПЕРЕД `$transaction` (read-only):

```ts
const goodIds = Array.from(new Set(lines.map(l => l.goodId)));
const goods = await prisma.good.findMany({
  where: { id: { in: goodIds }, orgId, deletedAt: null },
  select: { id: true },
});
if (goods.length !== goodIds.length)
  throw new NotFoundException(`Товар не знайдено: ${missing[0]}`);
```

1-2 RTT замість N. Регресія-guard: cross-tenant fixture (`good.findMany` повертає N-1) → `rejects.toThrow(NotFoundException)` + `expect(prisma.X.create).not.toHaveBeenCalled()`.
**Severity:** HIGH (tenant isolation gap, defense-in-depth); CRITICAL якщо UI drop-down показує лише власні org-дані але API direct дозволяє cross-tenant FK.
**Де шукати ще:** `<resource>Line[]` DTO create/update: SupplierReturn, PurchaseOrder, Invoice, StockDocument, WorkOrder (parts), ReconciliationAct; nested recipients[]/permissions[]/vehicleIds[] — masked-as-string FK у array DTO.

---

### 2026-06-14 — Multi-mode page викликає всі data hooks одночасно замість gate-у по mode (Bug #457) — frontend / perf / wasted-fetches

**Сигнал:** сторінка з `viewMode` switcher показує одну з N data-source, але hooks (`useStockByDocument`, `useStockByBatch`) викликані безумовно на top-level → ВСІ N запитів стартують на mount (лише 1 visible). Cost: звіт 5000 рядків × 3 hooks = ~1.5MB зайвого трафіку. Автор думає «TanStack кешує» + `enabled: !!employee` виглядає достатнім.
**Grep:** `useState<.*ViewMode\|viewMode\s*===\s*['"]` у `.tsx` → порахувати `useQuery` на top-level; `count(useQuery)>1` АЛЕ `count(enabled.*viewMode)`=0 → bug. Runtime: DevTools Network у default mode → N>1 запитів де 1 потрібен.
**Фікс:** opt-in `enabled?: boolean` у кожен mode-specific hook (default true), внутрішньо `enabled: !!employee && enabled`; споживач передає `viewMode === 'documents'`. Регресія-guard: `renderHook(useX({}, false))` → НЕ викликає apiFetch.
**Severity:** MEDIUM (perf-only); HIGH якщо endpoint важкий (агрегації >1000, JOIN) або mode рідкий.
**Де шукати ще:** `*/page.tsx` зі switcher: inventory, reports, dashboard, analytics, calendar (week/month/list), dispatch board, settings sub-tabs.

---

### 2026-06-14 — useEffect deps на array-of-object refetches network на кожну mutation НЕ-key поля (Bug #454) — frontend / perf / network-overuse

**Сигнал:** useEffect фетчить за «key» полями (`goodId` set з масиву), але має deps сам масив (`[parts, ...]`) → typing у НЕ-key поле (quantity/price) створює нову reference → effect re-fires → network дублюється на кожен keystroke. ESLint exhaustive-deps вимагає `parts`, але семантично потрібен ТІЛЬКИ derived set.
**Grep:** `useEffect.*apiFetch` з array prop/state у deps + `.map()`/`.filter()` для derived ключа; runtime DevTools Network, type у quantity → множинні calls; `[arrayOfObjects, ...]` де body `.map(x => x.specificField)`.
**Фікс:** memoize fingerprint `useMemo(() => sortedSetOfKeys.join(','), [array, ...])` → deps `[fingerprint]` (sort обов'язковий проти false-positive при reorder).
**Severity:** MEDIUM (perf-only); HIGH якщо race-conditions або endpoint дорогий (100+ елементів).
**Де шукати ще:** BulkActionsBar, list pages з batch-select (ids→metadata), filter sidebar з debounce, settings з `Promise.all(...).then(setMap)`.

---

### 2026-06-15 — Нове enum value додано через DTO+service+frontend БЕЗ regression-guard для самого value (Bugs #478-#480) — test-coverage / regression-guard gap

**Сигнал:** commit `feat(<scope>): add <NEW_VALUE> to <Enum>` змінює: (1) prisma enum + migration `ALTER TYPE ADD VALUE`; (2) `@sto/shared` LABELS/BADGE; (3) backend DTO `@IsEnum` whitelist (Create+Query); (4) service maps (`MOVEMENT_TYPES[NEW]`, `docTypeMap[NEW]`); (5) FE hardcoded array. АЛЕ парний spec залишається зі старими values → grep `<NEW_VALUE>` у spec = 0. Автор перевіряє happy path лайв-сервером, тести вже зелені, нові не пише («логіка як WRITEOFF» — хибно: RECEIPT vs TRANSFER різна гілка, RECEIPT vs WRITEOFF sign quantity). TS green.
**Grep:**

```bash
git show <commit> -- packages/database/prisma/schema.prisma | grep -A1 "^enum"
grep -rn "<NEW_VALUE>" apps/api/src/modules/<scope>/ --include="*.spec.ts"   # 0 = bug
```

**Фікс:** 3 regression-guards у contract+service spec:

1. Contract POST `type:NEW_VALUE` → 201 (@IsEnum Create DTO).
2. Contract GET `?type=NEW_VALUE` → 200 (Query DTO + argv-position findAll).
3. Service `transition(NEW_VALUE-doc, CONFIRMED)` → map-резолв + side-effect:
   - `expect(inventory.createMovement).toHaveBeenCalledTimes(1)` ← NEW у TRANSFER-branch кличе двічі
   - `expect(dtoArg.type).toBe(StockMovementType.NEW_VALUE)` ← MOVEMENT_TYPES[NEW] resolved
   - `expect(dtoArg.quantity).toBeGreaterThan(0)` (або `<0` WRITEOFF) ← sign-логіка
   - `expect(docNumbers.next).toHaveBeenCalledWith(orgId, 'PARENT_DOC_TYPE')` ← docTypeMap[NEW]
   - `expect(dtoArg.warehouseId).toBe(WAREHOUSE_ID)` ← НЕ targetWarehouseId

Якщо service spec нема (Bug #480) — створити з `Test.createTestingModule` + mock deps. Приклад: `stock-documents.service.spec.ts`.
**Severity:** HIGH — 3 рівні (DTO whitelist, map resolve, branch) можуть мовчки зламатись; live 400/400/«Непідтримуваний тип».
**Де шукати ще:** enum-керовані гілки кожен sprint: WorkOrderStatus/InvoiceStatus/PurchaseOrderStatus (FSM transition side-effects), StockMovementType/StockDocumentType (Bug #480), DocumentType (numbering prefix e2e), PaymentMethod/CounterpartyType/EmployeeRole (if-else guards), `switch(type)`/`Record<EnumType,X>`.

---

### 2026-06-14 — Новий endpoint без service spec + contract spec при доданні фічі (Bugs #452, #453) — test-coverage / regression-guard gap

**Сигнал:** commit з новим `@Get('endpoint')` + method у service → grep spec для method → 0 матчів. Особливо коли endpoint у hot-path UI. Автор browser-test через Network tab, spec не пише; review fix-ить guard-и (UUID validation) але без spec регресія пройде CI green.
**Grep:** `git diff HEAD~N HEAD --name-only -- "apps/api/src/modules/**/*.controller.ts" "*.service.ts"` → для кожного method grep парний `.spec.ts`; `find ... -name "*.controller.ts"` → чи є `*.contract.spec.ts` поруч.
**Фікс:** `describe('newMethod')` у service spec 5-7 кейсів (empty, tenant isolation, soft-delete, edge null/0, cross-tenant); окремий `*-<feature>.contract.spec.ts` 10-12 HTTP-кейсів (validation 400, RBAC 403, boundary, dups, malformed).
**Severity:** MEDIUM (release-blocker якщо guard CRITICAL — UUID validation, ліміти; LOW якщо happy path). Auto-rule: commit що додає метод у service МАЄ мати diff у `<service>.spec.ts`.

---

### 2026-06-11 — Shared FE-BE константа: backend inline literals замість спільної const (Bug #432) — backend / FE-BE drift

**Сигнал:** shared const у `packages/shared/src/constants/*.ts` оновлена для FE, але backend service має inline `['STATUS_A', 'STATUS_B']`.
**Grep:** `grep -rn "'COMPLETED', 'INVOICED'" apps/api/src --include="*.ts" | grep -v spec`.
**Фікс:** додати backend const у `<entity>.fsm.ts`, замінити inline у service. FSM-spec: `expect(BE_STATUSES.sort()).toEqual([...FE_STATUSES].sort())`.
**Severity:** HIGH (silent drift → при додаванні статусу FE gate проходить, backend 400).

---

### 2026-06-11 — Audit-track list неповний для нових полів у update().data (Bug #433) — backend / audit / compliance

**Сигнал:** `prisma.X.update({ data: { documentDate, liftId, ... } })` має більше keys ніж `trackField([...] as const)` array. Split-fix: один `fix(tester): audit gap` часто пропускає суміжні поля.
**Grep:** вручну порівняти data-keys vs audit-keys у кожному `update()` з `auditService.record`.
**Фікс:** додати поле у trackField array. Регресія-guard: `it('update з { X } включає X у audit.diff')`.
**Severity:** HIGH (compliance/audit-trail gap для фінансових полів).

---

### 2026-06-11 — Local FE interface ↔ backend DTO field-list drift (Bug #434) — sync / type-drift

**Сигнал:** компонент має локальний `interface <ResourceDetail>` без імпорту з shared. Backend DTO додав поле — FE interface пропустив → load-mapper хардкодить дефолт.
**Grep:** `git diff HEAD~N HEAD -- "apps/api/src/modules/**/*.dto.ts" | grep "^+.*?: "` → нові optional fields → перевірити у FE-interface.
**Фікс:** додати поле у local interface, оновити load-mapper і inline-edit handler.
**Severity:** MEDIUM (display ОК, inline-edit губить FK); HIGH якщо submit writes hardcoded default.

---

### 2026-06-11 — Dead JSX `<></>` Fragment після refactor IIFE→inline (Bug #431) — frontend / code-cleanliness

**Сигнал:** refactor/simplify commit у `.tsx` → залишаються `<>...</>` де батьківський element вже має siblings.
**Grep:** `grep -nE '^\s+<>\s*$|^\s+</>\s*$' apps/web/src/**/*.tsx` → cross-read 5 рядків вище для контексту.
**Виключення:** `return <>...</>`, `condition && <></>` — не dead.
**Severity:** LOW (cosmetic), але накопичується по кодовій базі.

---

### 2026-09-06 — Behavior-change fix + stale regression-guard (Bug #648) — frontend / test-integrity

**Сигнал:** race/async-фікс змінює що робить handler на подію (Enter тепер флашить debounce замість тихо ігнорувати), але існуючий `*.test.tsx` досі асертить `expect(scanSubmit).not.toHaveBeenCalled()` / «НЕ викликається» — ДО-фіксну поведінку. Тест зелений ЛИШЕ за таймінгом: flush `.then()` резолвиться після синхронної асерції. Тіль-тейл: `Warning: An update to <Component> inside a test was not wrapped in act(...)` у тесті що перевіряє _відсутність_ дії.
**Причина виникнення:** тест писався ПІД стару поведінку і закріплював guard `if(!open||items.length===0)return` як «правильний»; фікс перемістив guard нижче нової flush-гілки, але тест ніхто не перечитав — «зелений = ок».
**Підхід до виявлення:** після fix що чіпає `setTimeout/clearTimeout/debounceRef/timeoutRef/AbortController` у обробнику події → grep парні тести на `.not.toHaveBeenCalled()`/`НЕ викликається` для тієї ж події; будь-який act()-warning у «negative» тесті = підозра. Запустити тест ізольовано і перевірити чи асерція синхронна, а дія — async.
**Підхід до фіксу:** видалити stale тест (хибно-зелений guard шкідливіший за відсутній); замінити дискримінуючими тестами НОВОЇ поведінки з `flushMicrotasks()` (`await act(async()=>{await Promise.resolve();await Promise.resolve();})`) під fake timers. Довести дискримінацію: revert flush-гілки → нові тести падають.
**Severity:** MEDIUM (test-integrity; приховує майбутню регресію самого фіксу).
**Де шукати ще:** усі picker/combobox/autocomplete з debounce+Enter (`search-picker-modal`, `search-combobox`, `GoodPickerModal`); будь-який `fix(review)`/`refactor(simplify)` що змінив async-контроль у event handler.

---

### 2026-06-11 — Stale vi.mock після refactor-extract нового export (Bug #429) — frontend / test-staleness

**Сигнал:** `vi.mock('@/lib/X', () => ({ ... }))` без нового export що компонент імпортує. Тест fail-ить за не-пов'язаним assert (catch+finally нормалізують стан).
**Grep:** `git diff HEAD~N HEAD -- "apps/web/src/lib/*.ts" | grep "^+export"` → `grep -rln "vi.mock.*@/lib/<libName>" apps/web/src --include="*.test.tsx"`.
**Фікс:** `vi.mock('@/lib/X', async () => { const actual = await vi.importActual('@/lib/X'); return { ...actual, override: stub }; })`.
**Severity:** HIGH (release-blocker, ховає реальні регресії).

---

### 2026-06-11 — React state guard у async handler race-window (Bug #430) — frontend / race-condition / data-integrity

**Сигнал:** `handleClose` читає `if (saving) return` через state closure; handler робить `setSaving(true)` → `await apiFetch()` → React не flush-ить до завершення handler → Escape між кроками закриває modal на pending POST → orphan data.
**Grep:** `grep -rn "if (saving\|if (loading\|if (transitioning" apps/web/src/components --include="*.tsx" | grep -v "Ref\.current"`.
**Фікс:** двошарова state: `useState` для render + `useRef` для guard reads. Wrapper-setter оновлює обидва. Регресія-guard: pending Promise mock → submit → Escape → `expect(onClose).not.toHaveBeenCalled()`.
**Severity:** HIGH (orphan data у БД, silent failed POST).

---

### 2026-06-10 — Asymmetric-write nullable col у clone()/copy mutation (Bug #426) — backend / data integrity

**Сигнал:** sprint додає `nullable colX` у line-model. `transition()/clone()` обчислює `resolvedValue` і передає у side-effect, але НЕ робить `tx.<row>.update({ data: { colX: resolvedValue } })`.
**Grep:** `grep -rnE "[a-z]*Id:\s*l\.[a-z]*Id\s*\?\?\s*null" apps/api/src/modules --include="*.service.ts"` → парний `tx.<row>.update` у тому ж `$transaction`.
**Severity:** HIGH (silent: movement має X, line має NULL → audit/sync ламається).

---

### 2026-06-10 — E2E тест застарів після UI refactor: dropdown→pills (Bug #428) — E2E / test staleness

**Правило:** тест падає = щось зламано → знайти ЩО (UI зламаний або тест застарів). Якщо intentional UI refactor → оновити тест, НЕ обходити. `data-testid` стабільніше за text/role.
**Severity:** MEDIUM (false negative приховує реальні регресії).

---

### 2026-06-10 — Token-guard debouncer: early-return не інкрементує reqId (Bug #396) — frontend / async race

**Сигнал:** хук з `reqIdRef` — early-return гілка (`!startAt || endAt<=startAt`) робить `setX(null)` БЕЗ `reqIdRef.current++` → in-flight fetch resolve перезаписує очищений стан.
**Grep:** `grep -rn "reqIdRef\|requestIdRef" apps/web/src --include="*.ts" --include="*.tsx" -l` → у кожному `check`/`run`: early-return з `setX(null)` без increment.
**Severity:** MEDIUM (state corruption при швидкому очищенні параметрів).

---

### 2026-06-10 — Conflict-check без excludeParentId у контексті edit parent (Bug #397) — backend+frontend

**Сигнал:** `POST /X/check-conflicts` з `excludeSelfId` АЛЕ виклик з modal батьківської entity без `excludeParentId` → false-positive при кожному відкритті.
**Grep:** `grep -rn "check-conflicts\|checkConflict" apps/web/src --include="*.tsx" -l` → перевірити чи context = parent-entity.
**Severity:** MEDIUM (UX false-positive banner).

---

### 2026-06-10 — DTO degraded-form у read-only endpoint → contract drift (Bug #398) — backend / contract drift

**Сигнал:** локальний `toDtoSimple()` повертає той самий тип без enrichment. Optional поля undefined → TS green → майбутній рендер деталей broken.
**Grep:** `grep -rn "const toDto[A-Z]\w* = " apps/api/src/modules --include="*.service.ts" -A2`.
**Фікс:** використати `this.toDto(s)`. Публічний endpoint → окремий `PublicXDto`.
**Severity:** MEDIUM (latent regression).

---

### 2026-06-09 — Swallowed-fetch mapped to empty-state у read-only panel (Bug #414) — frontend / error handling

**Сигнал:** `<LinkedDocumentsPanel>` робить `.catch((e) => setData(emptyShape))` → 500/network mapped як "немає документів" → UX false reassurance.
**Grep:** `grep -rn "\.catch.*=>" apps/web/src/components/ui apps/web/src/app --include="*.tsx" -A2 | grep -B1 "setData\|setItems"`.
**Фікс:** окремий `error` state + `if (error) return <ErrorBanner/>` + Retry.
**Severity:** MEDIUM (user makes decision based on false empty state).

---

### 2026-06-09 — Cross-endpoint status-filter inconsistency (Bug #415) — backend / API contract

**Сигнал:** `findByWorkOrder` фільтрує `status: { not: CANCELLED }`, але `getCounts/getLinked` БЕЗ фільтра → badge count показує N+1.
**Grep:** знайти всі `prisma.<model>.find*/count/groupBy` у тому ж модулі → перевірити уніфікацію `where.status`.
**Severity:** LOW (UX inconsistency); MEDIUM якщо призводить до помилкового рішення.

---

### 2026-06-09 — Inner $tx re-check spec для Serializable race fix (Bug #416) — backend / test coverage

**Сигнал:** `$transaction({ Serializable })` з inner `tx.X.findFirst` re-check — spec має один `mockResolvedValue` (constant), не двічі `mockResolvedValueOnce`.
**Фікс:** `mockResolvedValueOnce(null).mockResolvedValueOnce({id})` + `expect(prisma.X.create).not.toHaveBeenCalled()`.
**Severity:** MEDIUM (regression risk для CRITICAL race fix).

---

### 2026-06-09 — Concurrent-create race for "1 active per parent" без unique index (Bug #412) — backend / concurrency

**Сигнал:** `find existing → if (existing) throw → create` без `$transaction({ Serializable })` або `@@unique` partial-index → race window для дублікатів.
**Grep:** `grep -rnE "async (create|createFrom|issueFor)[A-Z]" apps/api/src/modules --include="*.service.ts"` → перевірити `@@unique` або Serializable tx.
**Severity:** HIGH (2 invoice з тим самим workOrderId).

---

### 2026-06-09 — Sibling-panel stale state після parent action (Bug #409) — frontend / state staleness

**Сигнал:** "Документи" tab відкритий → footer-button "Виставити рахунок" → toast.success → tab показує старий список.
**Grep:** `useEffect.*\[parentId\]` у viewer-компоненті + parent `handle*` POST на endpoint що змінює viewer-дані.
**Фікс:** prop `refreshKey?: number` → useEffect deps `[parentId, refreshKey]` + parent increment після успіху.
**Severity:** MEDIUM; HIGH для critical financial panels.

---

### 2026-06-09 — Alternate-mutation endpoint обходить canonical guards (Bug #403, #444) — backend / FSM enforcement / capacity invariants

**Сигнал:** `refreshFromWorkOrder/syncFromX/recalculateZ/syncWorkOrderSlots` мутує той самий resource без guards канонічного `update()`. Типові guards що пропускаються: (а) FSM `if (X.status !== DRAFT) throw`; (б) **capacity/conflict probe** (Bug #444: `calendarSlot.startAt/endAt` write має перевіряти overlap з іншими bookings на тому ж lift/employee — інакше silent double-booking); (в) `isLocked/isSystem` guards.
**Grep:** `grep -rnE "async (refresh|sync|import|recalculate|regenerate|rebuild)[A-Z]" apps/api/src/modules --include="*.service.ts"` → для кожного метода знайти canonical `update()`/`updateLine()` у тому ж файлі, скопіювати ВСІ `if (...) throw` + conflict-check блоки.
**Severity:** CRITICAL (FSM перезаписує SENT/PAID record без error); HIGH (capacity invariant overlap → double-booking, broken capacity).
**Регресія-guard:** spec mock-ить conflict-row → метод має throw + `expect(updateMany).not.toHaveBeenCalled()`.

---

### 2026-06-09 — FE status-whitelist асиметрія з backend (Bug #401) — frontend / UX

**Сигнал:** `const canShare = [...].includes(status)` — масив не збігається з backend `SHAREABLE_STATUSES`. FE ⊃ BE → 400 на кліку (HIGH); FE ⊂ BE → silent UX обмеження (MEDIUM).
**Grep:** `grep -rnE "const can(Share|Edit|Delete)" apps/web/src --include="*.tsx"` → знайти парний backend const → звірити.
**Severity:** HIGH якщо FE обіцяє кнопку що повертає 400.

---

### 2026-06-09 — ID-namespace contract mismatch FE↔BE "silently ignore" (Bugs #396, #399) — full-stack / data loss

**Сигнал:** FE надсилає `itemId` але backend очікує `lineId` — whitelist:true мовчки ігнорує unknown field, операція "успішна" але без ефекту.
**Grep:** порівняти body у apiFetch POST з DTO fields у відповідному controller.
**Severity:** HIGH (silent data loss).

---

### 2026-06-09 — Soft-delete primary без auto-promote next sibling (Bugs #351, #398) — backend / business invariant

**Сигнал:** `service.remove()` для `isPrimary/isDefault` entity не promote-ить наступного sibling.
**Grep:** `grep -rnE "isPrimary\s+Boolean|isDefault\s+Boolean" packages/database/prisma/schema.prisma | awk '{print $1}'` → перевірити `remove()` кожної моделі.
**Severity:** HIGH (downstream auto-selection повертає неправильні значення).

---

### 2026-06-09 — Stale URL-serialization test після backend-compat fix (Bug #390) — frontend / test drift

**Сигнал:** `fix: remove [] suffix` змінює URL params, але `*.test.tsx` ще асертить `categoryIds%5B%5D=`.
**Grep:** `git diff HEAD~3 HEAD -- 'apps/web/src/**/*.tsx' | grep -E "^\+.*params\.(append|set)"` → pair-check `__tests__/*.test.tsx`.
**Фікс:** оновити assertion + додати negation guard `expect(url).not.toContain('<old-form>')`.
**Severity:** CRITICAL (весь web suite червоний → release-blocker).

---

### 2026-06-08 — Imperative `.focus()` на conditionally-rendered ref (Bug #386) — frontend / UX

**Сигнал:** `xxxRef.current?.focus()` у click handler де ref належить `{cond && <input ref={xxxRef}/>}` — handler змінює state-умову → ref ще null → focus loss.
**Grep:** `grep -rnE "[a-zA-Z]Ref\.current\?\.(focus|select|scrollIntoView)" apps/web/src/components --include="*.tsx" -B3` → перевірити чи ref умовний.
**Фікс:** `requestAnimationFrame(() => xxxRef.current?.focus())` або `useEffect([cond])`.
**Severity:** LOW-HIGH залежно від context.

---

### 2026-06-08 — Soft-delete remove() не каскадить на 1:1 @unique related table (Bug #373) — backend / soft-delete

**Сигнал:** `parent.remove()` soft-delete parent, але пов'язана `@unique(FK)` таблиця не soft-deleted → `create()` нового батька кидає P2002.
**Grep:** `grep -rn "@@unique" packages/database/prisma/schema.prisma | grep -v "orgId,"` → для кожного `@@unique([FK])` перевірити `remove()` у service на каскадний deletedAt.
**Severity:** HIGH (re-create permanently blocked).

---

### 2026-06-08 — seed.ts залежить від іншого seed-скрипту (Bug #377) — db / seed orchestration

**Сигнал:** `seed.ts` (`prisma db seed`) використовує дані з таблиці що заповнюється `seed-catalog.ts` (не запускається автоматично) → RuntimeError у CI.
**Фікс:** об'єднати у один `seed.ts` або `seedCatalog() → seedMain()` orchestration.
**Severity:** MEDIUM (CI seed fails, dev onboarding broken).

---

### 2026-06-08 — Controlled `<select value>` default ігнорує dynamic option filter (Bug #378) — frontend / controlled-select

**Сигнал:** `value={form.X}` де options фільтруються по parent → при зміні parent `form.X` може не існувати в нових options → порожній вибір без reset.
**Фікс:** `useEffect([parent], () => { if (!options.find(o=>o.id===form.X)) setForm(f=>({...f, X: ''})) })`.
**Severity:** MEDIUM (UX state mismatch).

---

### 2026-06-06 — Sibling-handler pattern miss: review виправив один handler, дзеркальний залишився (Bug #370) — frontend

**Сигнал:** `fix(review)` виправив один з 2-3 парних handlers у тому ж файлі (handleCreate/handleUpdate/handleDelete). Решта мають той самий патерн.
**Grep:** після review-fix commit → `grep -n "handle(Create|Update|Delete|Restore)" <file>` → перевірити кожен.
**Severity:** успадковує severity оригінального бага.

---

### 2026-06-06 — Mask wrapper re-extracts digits із форматованого prefix (Bug #369) — frontend / controlled-input

**Сигнал:** PhoneInput: iterative typing дає `+38 (380)...` замість `+38 (038)...` — `replace(/\D/g,'')` витягує digits з prefix `+38 (` разом з user input.
**Grep:** `grep -rn "e\.target\.value\s*=\s*" apps/web/src/components/ui --include="*.tsx"`.
**Фікс:** `applyMask(v)` strip prefix перед digit-extraction. Регресія-guard: `it('iterative typing matches one-shot paste')`.
**Severity:** HIGH (silent data corruption — невалідний номер у БД).

---

### 2026-06-06 — Cascade-clear stale linked FK при зміні parent picker (Bugs #365, #367) — frontend / form-state

**Сигнал:** user обрав counterparty → обрав vehicle → змінив counterparty → `vehicleId` лишається від попереднього.
**Grep:** `<EntityPickerField.*onChange` → перевірити чи `setForm(f => ({ ...f, parentFk, childFk: '' }))`.
**Severity:** HIGH (FK з іншої org → cross-tenant або 404).

---

### 2026-06-15 — Orphan affordance UI: toggle/button без consumer-а після dead-code cleanup (Bugs #504, #505) — frontend / UX / Bug #341 sub-pattern

**Сигнал:** review-fix/tester видалив dead state + render-залежний компонент, але залишилась **affordance**: `<Toggle enabled={x.enabled} onToggle={x.toggle}/>`, `<Button onClick={openX}>`, hotkey, command palette entry — керує hook/state що **нічого не контролює**. tsc/тести green, кнопка лишається, натиск → нічого (або localStorage без ефекту). Affordance у іншому регіоні JSX; destructure не unused (TS без `noUnusedLocals` мовчить).
**Grep:**

```bash
grep -rln "DetailPanel\b\|DetailPanelToggle\|<XPanel" apps/web/src/app/\(app\)   # paired list-pages
grep -rnE "<DetailPanelToggle |hotkey:|cmdK:|<MinimizeButton" apps/web/src --include="*.tsx"
# для кожного: hook-стан що toggle мутує → єдиний consumer → якщо немає / consumer-prop завжди false → bug
# review-fix commit з delete >50% insert = підозра
```

**Фікс:** видалити affordance разом з destructure. Якщо affordance у багатьох файлах, мертвий лише у деяких → видалити тільки у dead files. НЕ залишати «TODO: відновити» (dead code + TODO = подвоєний debt). Регресія-guard: vitest snapshot JSX layout.
**Severity:** MEDIUM (UX confusion + dead localStorage); LOW якщо hotkey без UI hint; HIGH якщо affordance = key feature (toolbar з підказкою).
**Де шукати ще:** shared hook з toggle-state (useDetailPanel, useColumnsConfig, useSavedFilters, useBulkSelect) — destructure без render consumer; command-palette entries до неіснуючої сторінки (Bug #354); hotkey handlers що змінюють state не зчитуваний у JSX.

---

### 2026-06-15 — Backend stale-FK cleanup у service.update() (Bug #473, paired Bugs #365, #367 frontend) — backend / business-logic / data-integrity

**Сигнал:** service.update() приймає `dto.parentFkId` (supplierId/counterpartyId/vehicleId) АЛЕ FE забуває dependent child FK (contractId/...) у PATCH body. Backend silent-keep-ає старий child FK → cross-parent orphan (`po.contract.counterpartyId !== po.supplierId`). P2003 не спрацює (target row у self-org); UI показує «договір N» що належить ІНШОМУ постачальнику.
**Grep:** для `service.update()` з ≥2 FK (parentFkId + childFkId):

```bash
grep -nE "findFirst.*select:.*{(\s|$)" apps/api/src/modules/<resource>/<resource>.service.ts -A5 | grep -E "Id:\s*true"   # SELECT має включати BOTH
grep -n "parentChanged\|supplierChanged" apps/api/src/modules/<resource>/<resource>.service.ts   # branch auto-clear?
```

**Фікс:** SELECT включає parent FK + ВСІ dependent FK; `<parent>Changed = dto.<parent>Id !== undefined && dto.<parent>Id !== po.<parent>Id`; child FK у 4 гілки: (a) string → validate проти `effectiveParentId = dto.parentId ?? po.parentId`; (b) null → explicit clear; (c) `parentChanged && po.childFkId` → auto-clear stale; (d) otherwise keep (undefined). DTO `child?: string | null` з `@ValidateIf((_,v)=>v!==null) @IsUUID()` + `@Transform(emptyToUndefined)`. Регресія-guard: ОКРЕМІ кейси (b)(c)(d); тест (c) mocks `findFirst` `po.childFkId!==null` + dto WITHOUT childFkId → `update.data.childFkId === null`; Bug #477: contract `PATCH {childFkId:null} → 200`.
**Severity:** HIGH (silent cross-parent corruption; ризик коли FE/BE паралельно, фронт reset робить ОДИН з 3 шляхів — picker modal/inline/manual unset).
**Де шукати ще:** WorkOrderService.update (counterpartyId+vehicleId), InvoiceService.update (counterpartyId+workOrderId+paymentMethodId), StockDocumentService.update, SettlementService.transferTransaction (from+toAccountId), PurchaseOrderService.update ✅ (#473), SupplierPaymentService.update ✅ (#588), CounterpartyContractService, AppointmentService.

---

### 2026-06-06 — Toggle callback виконує full open-logic при CLOSING (Bug #364) — frontend / callback design

**Сигнал:** `onToggle(open: boolean)` при `open=false` виконує повну open-логіку (reset форми, fetch даних) замість cleanup.
**Grep:** `grep -rn "onToggle\|onOpenChange\|onClose" apps/web/src --include="*.tsx" -A5 | grep "fetch\|reset\|load"`.
**Фікс:** `if (!open) return; // only run open-logic when opening`.
**Severity:** MEDIUM (зайве fetch при закритті).

---

### 2026-06-06 — Soft string FK без validation (Bugs #359, #361) — backend / data-integrity

**Сигнал:** DTO `currencyCode: string` без `findFirst({ orgId, code: dto.currencyCode })` → `'XYZ'` проходить → DB corrupted.
**Grep:** `grep -rnE "String\s*$|String\s+@db\.VarChar" packages/database/prisma/schema.prisma | grep -iE "code|type"` → перевірити validation у service.
**Severity:** HIGH.

---

### 2026-06-06 — Auto-create child ignores parent settings inheritance (Bug #360) — backend / business-logic

**Сигнал:** `tx.Contract.create({ data: { currencyCode: 'UAH' } })` hardcoded замість `OrganisationSettings.currency`.
**Grep:** `grep -rnE "tx\.[a-z]+\.create.*currencyCode|paymentDeferDays|warrantyDays" apps/api/src/modules --include="*.service.ts"`.
**Фікс:** fetch `organisationSettings` ПЕРЕД `$transaction`, передати у create.data.
**Severity:** HIGH (порушує UX-інваріант "default відповідає налаштуванням").

---

### 2026-06-06 — Case-sensitive lookup vs canonical-form (Bug #359) — backend / DTO normalization

**Сигнал:** `findFirst({ code: dto.currencyCode })` — user вводить `'uah'`, БД має `'UAH'` → 400 з валідним кодом.
**Grep:** `grep -rnE "findFirst.*code:\s*dto\." apps/api/src/modules --include="*.service.ts"` → перевірити `@Transform(toUpperCase)` у DTO.
**Severity:** HIGH (valid user input → 400 → perceived as broken).

---

### 2026-06-05 — Dead `/X/new` маршрут у keyboard shortcut (Bug #354) — frontend / routing

**Сигнал:** `router.push('/resources/new')` але `new/` dir не існує → `[id]` route ловить `'new'` як id → broken detail page.
**Grep:** `grep -rn "router\.push('/[^']*/new')" apps/web/src --include="*.ts" --include="*.tsx"` → `test -d apps/web/src/app/.../<resource>/new`.
**Фікс:** `?action=new` query param + `useSearchParams` у page + `<Suspense>`.
**Severity:** HIGH (keyboard shortcut → broken page).

---

### 2026-06-05 — TanStack Query queryKey shape mismatch: helper vs factory vs prefetch (Bugs #355-#356) — frontend / react-query

**Сигнал:** `usePaginatedList({ queryKey: 'X' })` будує `[key, filters]` але factory `xKeys.list(f) = [...xKeys.all, 'list', filters]` (3-element) → різні cache slots → prefetch не hit.
**Grep:** `grep -rn "queryKey:\s*\[.*filters\]" apps/web/src/hooks/api --include="*.ts"` → match без `'list'` = bug.
**Severity:** MEDIUM (prefetch silent miss → double-fetch).

---

### 2026-06-04 — Hardcoded document-number обходить DocumentNumberService (Bug #348) — backend / bizlogic

**Сигнал:** `tx.Contract.create({ data: { number: 'DRAFT' } })` замість `documentNumberService.next()`.
**Grep:** `grep -rnE "tx\.[a-z]+\.create.*\bnumber:\s*['\"]" apps/api/src/modules --include="*.service.ts"`.
**Фікс:** `documentNumberService.next()` ПЕРЕД `$transaction`.
**Severity:** HIGH (monotonic numbering порушена).

---

### 2026-06-03 — Stale contract-spec: arg-count drift після нового query-param (Bug #340) — backend / contract tests

**Сигнал:** controller forwarding `service.findAll(orgId, ..., query.NEW)` — `toHaveBeenCalledWith(orgId, ...8 args)` ламається при 9 args.
**Grep:** `git diff HEAD~N HEAD -- "*.controller.ts" | grep -E "^\+.*query\.[a-zA-Z]+"` → нові args → оновити `toHaveBeenCalledWith`.
**Severity:** MEDIUM (red baseline приховує реальні баги).

---

### 2026-06-03 — Stale mock після додавання cascade-helper у service (Bug #340b) — backend / test-coverage

**Сигнал:** review-fix додав `getDescendantIds()` → spec ловить `TypeError: X is not iterable` бо `findMany` у helper не замокано.
**Grep:** `git diff HEAD~N HEAD -- "*.service.ts" | grep -E "^\+.*await this\.(getDescendant|cascade)"` → додати `prisma.<model>.findMany.mockResolvedValueOnce([])`.
**Severity:** MEDIUM.

---

### 2026-06-03 — Review-fix completeness: крос-файловий патерн частково виправлений (Bug #341) — frontend

**Сигнал:** `fix(review): replace X with Y` чіпає N файлів — але є ще M файлів з тим самим патерном поза scope review.
**Grep:** після review-fix — той самий grep-pattern по ВСЬОМУ codebase без file-filter.
**Severity:** успадковує severity original bug.

---

### 2026-06-03 — Нові query-param фільтри без contract-spec coverage (Bugs #338, #339) — backend / contract tests

**Сигнал:** `QueryDto` отримав нові поля (`dateFrom`, `branchId`), але contract spec не перевіряє forwarding.
**Grep:** `git diff HEAD~5 HEAD --name-only | grep "\.dto\.ts$"` → для кожного QueryDto → перевірити spec coverage нових полів.
**Severity:** MEDIUM.

---

### 2026-06-03 — Bool prop early-return у useEffect: обидві гілки потребують test (Bug #336) — frontend / hooks

**Сигнал:** `useEffect(() => { if (!enabled) { cleanup(); return; } init(); }, [enabled])` — тест тільки для `enabled=true`.
**Фікс:** додати тест `enabled=false` гілки (`expect(cleanup).toHaveBeenCalled()`).
**Severity:** MEDIUM (інверсія `!enabled` ↔ `enabled` проходить зеленою).

---

### 2026-06-03 — Animation hook без tests + CSS marker contract (Bugs #332-#335) — frontend / animation

**Сигнал:** `useAnimatedPresence` без `*.test.ts`; CSS `[data-animate][data-state="open"]` без assertion що атрибут на правильному елементі.
**Grep:** `grep -nE "\[data-[a-z]+\]" apps/web/src/app/globals.css` → кожен `data-*` selector має assertion в `*.test.tsx`.
**Severity:** LOW (visual jank).

---

### 2026-06-02 — Coefficient-zero у нових UoM endpoints (Bug #312) — backend+frontend

**Сигнал:** `coefficient?: number` без `@Min(0.0001)` → coefficient=0 → division by zero у price calc.
**Grep:** `grep -rn "coefficient" apps/api/src/modules --include="*.dto.ts" | grep -v "@Min\|@IsPositive"`.
**Severity:** HIGH (data corruption).

---

### 2026-06-02 — `window.confirm` замість `useConfirm` (Bug #313) — frontend / UX

**Grep:** `grep -rn "window\.confirm" apps/web/src --include="*.tsx"`. Фікс: `const confirm = useConfirm(); await confirm({ ... })`.
**Severity:** LOW (UX consistency).

---

### 2026-06-02 — Reusable UI компонент без `type="button"` (Bug #314) — frontend / a11y

**Grep:** `grep -rn "<button" apps/web/src/components/ui --include="*.tsx" | grep -v "type="`.
**Severity:** MEDIUM (defensive: при вбудові в форму → form submission).

---

### 2026-06-02 — Promise.all для reference data без AbortController (Bug #315) — frontend / memory

**Сигнал:** `useEffect(() => { Promise.all([apiFetch(A), apiFetch(B)]).then(set) }, [])` без cleanup → memory leak.
**Фікс:** `const ac = new AbortController(); ... return () => ac.abort()`.
**Severity:** MEDIUM.

---

### 2026-06-02 — Toggle-state UI desync: highlight/cursor без enabled-gate (Bugs #310-#311) — frontend / UI

**Сигнал:** `selectedX?.id === item.id && 'bg-secondary'` рендерується після `detailPanel.toggle()` → `enabled=false` але selectedX non-null.
**Grep:** `grep -rnE "selected[A-Z][a-zA-Z]*\?.id\s*===\s*[a-z]+\.id\s*&&\s*'bg-" apps/web/src/app --include="*.tsx" | grep -v "enabled &&"`.
**Фікс:** `&& detailPanel.enabled` до affordance classes, або `useEffect(() => { if (!enabled) setSelected(null) }, [enabled])`.
**Severity:** MEDIUM.

---

### 2026-09-04 — Toggle-close selection не скидається при disable → панель недосяжна після re-enable (Bug #624) — frontend / UI / Bug #310-#311 sub-pattern

**Сигнал:** список з DetailPanelToggle І з toggle-close логікою вибору (клік по вже-вибраному рядку → закрити панель) через `selectedXIdRef`. При вимиканні тогла код скидає лише ВИДИМІСТЬ (`open={... && enabled}`), але `selectedX`/ref лишаються. Після re-enable клік по ТОМУ Ж рядку → `selectX` бачить `ref.current === row.id` → toggle-close → `setSelectedX(null)` замість відкриття → мовчазний no-op (панель не з'являється при активному тоглі). tsc/unit green — це runtime UX desync, ловиться ЛИШЕ E2E off→on-цикл-кліком або скріншотом.
**Grep:**

```bash
# списки з ref-based toggle-close selection
grep -rnE "selected[A-Z]\w*IdRef" apps/web/src/app --include="*.tsx"
grep -rnE "if \(selected\w*Ref\.current === .*\.id\)" apps/web/src/app --include="*.tsx"
# для кожного: чи є useEffect що скидає selection коли !enabled? якщо ні → bug
grep -rn "if (!.*\.enabled)" apps/web/src/app/**/page.tsx   # має існувати парний reset
```

**Причина виникнення:** selection-toggle-close і visibility-gate (`enabled`) — ДВА незалежні джерела правди про «чи показувати панель». Розробник гейтить видимість, але забуває що ref-based toggle-close тепер бачить стейл-вибір. Асиметрія: `open` реагує на `enabled`, а `selectX` — ні.
**Підхід до виявлення:** E2E-цикл для КОЖНОГО списку з toggle-close: клік рядка (панель) → тогл off → тогл on → клік ТОГО Ж рядка → панель має відкритись. Не покривається `toHaveCount` (DetailPanel width-collapse лишає контент у DOM; overflow-hidden не робить дочірні «hidden» для Playwright — assert через aria-label стану тогла + реальну поведінку кліку, або скрін).
**Підхід до фіксу:** `useEffect(() => { if (!enabled) { selectedXIdRef.current = null; setSelectedX(null); } }, [enabled])` — при disable синхронно скидаємо ОБА (ref + state), щоб re-enable починав із чистого аркуша.
**Severity:** MEDIUM (feature недосяжна для last-selected row після disable→enable; обхід неочевидний).
**Де шукати ще:** будь-який список де selection persist окремо від enabled-toggle І має клік-по-вибраному=закрити (purchase-orders — єдиний зараз; при копіюванні patтерну на invoices/stock-documents перевірити reset). Родич: Playwright `toBeVisible` дає false-positive на `w-0 overflow-hidden` контенті (width-collapse панелі) — асертити стан, не count.

---

### 2026-06-02 — Multi-module sprint: pattern dilution між модулями (Bug #306) — backend

**Сигнал:** sprint додає soft-delete до N модулів — деякі пропускають `@@unique` partial filter або resurrection pattern.
**Правило:** після кожного multi-module sprint — grep ВСІХ нових модулів на повний pattern checklist.
**Severity:** HIGH (P2002 при re-create).

---

### 2026-06-02 — Soft-delete filter pill chicken-and-egg (Bug #295) — frontend / UX

**Сигнал:** `{deletedCount > 0 || showDeleted ? <Toggle/> : null}` — count=0 поки `showDeleted=false` → Toggle не рендерується → архів недосяжний.
**Grep:** `grep -rnE "(deleted|archived)Count\s*>\s*0\s*\|\|" apps/web/src/app --include="*.tsx"`.
**Фікс:** Toggle завжди видимий; count тільки коли `showDeleted=true`.
**Severity:** CRITICAL (feature недосяжна без power-user URL hack).

---

### 2026-06-02 — Postgres NULLS LAST ламає sort по nullable soft-delete (Bug #296) — backend / Prisma

**Сигнал:** `orderBy: { deletedAt: 'asc' }` → NULL (активні) в кінець → видалені перед активними.
**Grep:** `grep -rn "orderBy.*deletedAt.*['\"]asc['\"]" apps/api/src/modules --include="*.service.ts" | grep -v "nulls"`.
**Фікс:** `{ deletedAt: { sort: 'asc', nulls: 'first' } }` (активні зверху).
**Severity:** HIGH (UX broken, активні рядки в кінці).

---

### 2026-06-02 — Soft-delete + @@unique без partial filter = P2002 (Bugs #297, #298) — backend

**Сигнал:** `update()` unique-field re-check `findFirst({ orgId, field, NOT: { id } })` без `deletedAt:null` → soft-deleted дубль проходить → P2002.
**Grep:** `grep -n "@@unique" packages/database/prisma/schema.prisma` + `grep -rn "CREATE UNIQUE INDEX" packages/database/prisma/migrations | grep -v WHERE`.
**Фікс update re-check:** НЕ фільтрувати `deletedAt:null`; якщо `duplicate.deletedAt != null` → `ConflictException('...існує у архіві.')`.
**Severity:** HIGH (P2002 500 на update).

---

### 2026-05-31 — Prefetch queryKey ↔ page queryKey shape mismatch (Bug #281) — frontend / react-query

**Сигнал:** TopShell `prefetchQuery({ queryKey: xKeys.list({}) })` але сторінка `useX({ page:1, limit:20, status:'', q:'', showDeleted:false })` → різні hash → double-fetch.
**Grep:** для кожного `prefetchQuery` → знайти споживача → порівняти shape (всі keys + значення).
**Severity:** MEDIUM (prefetch не hit, silent performance regression).

---

### 2026-05-31 — SSRF: validatePublicUrl + redirect:'manual' обов'язково разом (Bug #273) — backend / security

**Сигнал:** `fetch(userUrl)` з `validatePublicUrl` але без `redirect:'manual'` → attacker.com 302→internal → metadata bypass.
**Grep:** для кожного `fetch(` де URL = user-supplied → перевірити `redirect: 'manual'` + 3xx-rejection.
**Severity:** CRITICAL (SSRF → cloud metadata).

---

### 2026-05-31 — Dead-feature: service реалізований але ніколи не викликається (Bugs #267, #268) — backend

**Сигнал:** `@Injectable` з `@InjectQueue` є але 0 callsites поза self-module та spec → бали/cost не нараховуються.
**Grep:** `grep -rl "InjectQueue" apps/api/src/modules --include="*.ts"` → для кожного method: `grep -rln ".<method>(" apps/api/src | grep -v spec | wc -l` = 0.
**Severity:** HIGH (feature розрекламована але мертва).

---

### 2026-05-31 — Frontend hint обіцяє backend behavior що не реалізований (Bug #266) — frontend / UX

**Сигнал:** `"буде автоматично застосовано"` але POST body не містить поля що реалізує обіцяне.
**Grep:** `grep -rnE "буде (додано|застосовано|автоматично)" apps/web/src --include="*.tsx"` → перевірити submit body.
**Severity:** HIGH.

---

### 2026-05-31 — Mass DTO migration variant audit (Bugs #257-#265) — backend / dto-validation

**Сигнал:** sprint `@Transform(emptyToUndefined)` для `@IsDateString` пропускає `@IsISO8601`, `@IsEnum([lit])`, `@IsUUID('4', {each:true})` та inline 1-рядкові форми.
**Grep:** для кожного validator-type — перевірити обидва варіанти `@X()` та `@X(arg, {each|message})`.
**Severity:** HIGH (фіча мертва коли фронт шле `''`).

---

### 2026-05-31 — Public endpoint: array-cap + tenant-FK audit (Bugs #251, #252) — backend / security

**Сигнал:** controller без `@UseGuards(JwtAuthGuard)` — DTO array без `@ArrayMaxSize`, UUID array без tenant-FK count guard.
**Grep:** `find apps/api/src/modules -name "*.controller.ts" | while read c; do ! grep -q "@UseGuards(JwtAuthGuard" "$c" && grep -q "@Get\|@Post" "$c" && echo "PUBLIC: $c"; done`.
**Severity:** HIGH (DoS + cross-tenant linkage).

---

### 2026-05-31 — Inner DTO без class-validator декораторів (Bug #247) — backend / security

**Сигнал:** `@ValidateNested @Type(() => InnerDto)` але InnerDto-поля мають лише `@ApiProperty()` без `@IsUUID/@IsNumber`.
**Grep:** `grep -rn "@ApiProperty()" apps/api/src/modules --include="*.dto.ts" -A1 | grep -B1 "[a-z]!: string" | grep -v "@Is"`.
**Severity:** HIGH (bypass validation для вкладеної структури).

---

### 2026-05-31 — Shared helper без unit-тесту (Bug #243) — backend / test-coverage

**Сигнал:** `calculateXxx()` використовується в 10+ endpoints але нема `*.spec.ts` → будь-яка зміна = 10+ регресій.
**Severity:** HIGH.

---

### 2026-05-31 — DTO write-side asymmetry: nullable col без FSM persist (Bug #236) — backend / data-integrity

**Сигнал:** `InvoiceLine.unitShortName` у DTO та toDto, але `transition(APPROVED)` не робить `tx.invoiceLine.update({ data: { unitId } })`.
**Grep:** `grep -rnE "[a-z]*Id:\s*l\.[a-z]*Id\s*\?\?\s*null" apps/api/src/modules --include="*.service.ts"` → парний `tx.<row>.update` у `$transaction`.
**Severity:** HIGH (history має X, current state NULL → audit ламається).

---

### 2026-05-31 — UoM conversion відсутня на submit (Bug #231) — frontend / data-corruption

**Сигнал:** UI дозволяє перемикати UoM → display qty змінюється (×coefficient), але submit шле `parseFloat(l.quantity)` без `* l.coefficient`.
**Grep:** `grep -rnE "quantity:\s*parseFloat\(l\.quantity\)[^*]" apps/web/src/app --include="*.tsx" -B5 | grep -B5 "coefficient"`.
**Severity:** CRITICAL (stock movement у неправильних одиницях).

---

### 2026-05-31 — Prisma schema без парного migration (Bug #220) — database / release-blocker

**Сигнал:** `schema.prisma` modified але нема нового SQL у `migrations/` → runtime P2021. tsc+unit green.
**Grep:** `schema_changes=$(git diff HEAD~5 HEAD --name-only -- "*/schema.prisma"); new_migrations=$(git diff HEAD~5 HEAD --name-only --diff-filter=A -- "*/migrations/"); [ -n "$schema_changes" ] && [ -z "$new_migrations" ] && echo "BUG"`.
**Severity:** CRITICAL (runtime crash in production).

---

### 2026-05-31 — Sub-resource default-switch staleness у parent list (Bugs #226-#227) — frontend / state-sync

**Сигнал:** UoM modal `setDefault()` → parent `Good.unitId` змінено у backend → FE parent-table не рефетчена.
**Grep:** `grep -rn "apiFetch.*method:.*'(POST|PATCH|DELETE)" apps/web/src/app --include="*.tsx" | grep -E "/uoms|/barcodes|/categories"` → чи є `load()` для parent після mutation.
**Severity:** MEDIUM-HIGH.

---

### 2026-05-31 — Paired logger+middleware без спільного req-id source (Bug #216) — backend / observability

**Сигнал:** `CorrelationIdMiddleware` сетить `x-request-id`, pino-http `genReqId` → sequential int → cross-correlation мертва.
**Grep:** `grep -n "genReqId\|reqId" apps/api/src` → якщо є Middleware але нема `genReqId` → bug.
**Фікс:** `genReqId: req => req.headers['x-request-id'] ?? randomUUID()`.
**Severity:** HIGH (production monitoring мертвий).

---

### 2026-05-30 — React Query cross-resource invalidation gap (Bugs #210-#212) — frontend / react-query

**Сигнал:** `POST /invoices/:id/lines` side-effect оновлює `StockMovement` — але `invalidateQueries(inventoryKeys.all)` відсутній.
**Grep:** для кожного мутуючого endpoint pair-check проти backend service side-effects.
**Severity:** MEDIUM (stale cross-resource data).

---

### 2026-05-30 — React Query custom hook без тесту (Bug #214) — frontend / test-coverage

**Сигнал:** `apps/web/src/hooks/api/use*.ts` без парного `*.test.tsx`.
**Обов'язково тестувати:** queryKey factory isolation, enabled-gate, URLSearchParams build, signal abort.
**Severity:** MEDIUM.

---

### 2026-05-30 — error.tsx без `& { digest?: string }` (Bug #206) — frontend / typescript

**Grep:** `grep -rn "error.*:\s*Error[^&]" apps/web/src/app --include="error.tsx" | grep -v digest`.
**Фікс:** `{ error: Error & { digest?: string }; reset: () => void }`.
**Severity:** LOW (блокує моніторинг).

---

### 2026-05-30 — Global APP_GUARD без skip-list для /health/SSE/webhooks (Bug #203) — backend / deploy

**Сигнал:** `{ provide: APP_GUARD, useClass: ThrottlerGuard }` → `/health` отримує 429 → docker healthcheck fails → cascade restart.
**Grep:** `grep -n "APP_GUARD" apps/api/src/app.module.ts` → `@SkipThrottle()` на health/metrics/SSE controllers.
**Severity:** CRITICAL (production cascade restart).

---

### 2026-05-30 — Defense-in-depth guard + stale fixtures (Bug #200) — backend / test-coverage

**Сигнал:** review-фікс додав `if (entity.status !== ALLOWED) throw` → spec мокає без поля `status` → guard кидає → ВСІ тести fail.
**Grep:** після review-commit → `findFirst.mockResolvedValueOnce` у spec → перевірити наявність `status: <ALLOWED>`.
**Severity:** MEDIUM (red baseline blocks all CI).

---

### 2026-05-30 — FormData через apiFetch замість apiMultipartFetch (Bug #197) — frontend / api-contract

**Grep:** `grep -rn "apiFetch\b.*body:\s*(fd\|formData\|new FormData)" apps/web/src --include="*.tsx"`.
**Фікс:** замінити на `apiMultipartFetch(path, formData)`.
**Severity:** CRITICAL (upload feature повністю мертва).

---

### 2026-05-30 — Nullable cost-input → calculateSalePrice → salePrice=0 (Bug #198) — backend / data-corruption

**Сигнал:** `pricingService.calculateSalePrice(0, rule)` → `0 * (1+pct/100) = 0` → `Good.salePrice` затирається.
**Grep:** `grep -rn "calculateSalePrice\|purchasePrice ?? 0" apps/api/src/modules --include="*.ts"`.
**Фікс:** guard `if (good.purchasePrice == null || Number(good.purchasePrice) <= 0) skip`.
**Severity:** CRITICAL (data corruption у БД без помилки).

---

### 2026-05-30 — Boolean prop без inverse-condition test (Bug #194) — frontend / test-coverage

**Сигнал:** новий `propX?: boolean` — тест лише для default (false), але не для `propX=true`.
**Grep:** `grep -nE "^\s+\w+\?: boolean" apps/web/src/components/ui/*.tsx` після diff.
**Severity:** MEDIUM.

---

### 2026-05-30 — fastify-multipart FastifyError → 406 замість 400 (Bug #192) — backend / api-contract

**Grep:** `grep -rn "await req.file()" apps/api/src/modules --include="*.controller.ts" | grep -v "try\|catch"`.
**Фікс:** try/catch `FastifyError → throw new BadRequestException('Неправильний формат запиту')`.
**Severity:** HIGH.

---

### 2026-05-30 — `prisma.X.update({ where: { id } })` без `orgId` (Bug #191) — backend / tenant-isolation

**Grep:** `grep -rn "\.update({ where: { id:" apps/api/src/modules --include="*.service.ts" | grep -v "orgId"`.
**Фікс:** `updateMany({ where: { id, orgId, deletedAt: null } })`.
**Severity:** LOW-HIGH залежно від context.

---

### 2026-05-30 — Boundary-кейси для COST_TIER (Bug #184) — backend / test-coverage

**Сигнал:** `min <= cost < max` — нема тестів на межах (`cost===min`, `cost===max`, `cost===0`, out-of-range).
**Severity:** MEDIUM (інверсія `<=`/`<` ловиться лише boundary тестом).

---

### 2026-05-30 — Cross-tenant FK не покритий у contract-spec (Bug #186) — backend / security

**Сигнал:** optional FK у DTO валідується у service, але contract spec нема кейс `POST з FK чужої org → 404`.
**Severity:** HIGH (регресія = cross-tenant linkage у проді без error).

---

### 2026-05-30 — apiFetch generic type mismatch: `T[]` але endpoint повертає `{items,total}` (Bug #181) — frontend

**Grep:** `grep -rn "apiFetch<[A-Za-z]*\[\]>" apps/web/src/app --include="*.tsx" | grep -v "//"` → перевірити controller.
**Severity:** HIGH (runtime TypeError).

---

### 2026-05-30 — Bulk-apply scope-inconsistency після нового scope-поля (Bug #178) — backend / business-logic

**Сигнал:** `PricingRule` отримав нове scope-поле, але `applyRuleToGoods where` не включає його → правило застосовується до зайвих товарів.
**Severity:** HIGH (неправильна salePrice у БД).

---

### 2026-05-29 — Browser-API без jsdom-стабу → cascade test failure (Bug #177) — frontend / test-coverage

**Grep:** `grep -rnE "new (ResizeObserver|IntersectionObserver|MutationObserver)" apps/web/src/components --include="*.tsx" -l | while read f; do grep -q "ResizeObserver" apps/web/src/__tests__/setup.ts || echo "STUB MISSING: $f"; done`.
**Severity:** HIGH (cascade всіх component тестів).

---

### 2026-05-29 — `[x] виправлено` без парного code-diff → хибно-зелений — process

**Сигнал:** `git log -5 --stat | grep "fix(tester)"` чіпає тільки `*.md` → фікси у коді відсутні.
**Severity:** CRITICAL (hides real blockers).

---

### 2026-05-29 — Container healthcheck несумісний з базовим образом (Bugs #164, #170) — backend / deploy

**Сигнал:** `curl` у healthcheck alpine-образу без curl; `wget` у minio/minio (лише `mc`).
**Grep:** `grep -nE "curl|wget" docker-compose*.yml | grep -i healthcheck`.
**Фікс:** `["CMD","mc","ready","local"]` для minio; `node -e "require('http').get(...)"` для node.
**Severity:** CRITICAL (service ніколи не healthy → cascade restart).

---

### 2026-05-29 — Query-shape фікс (relation-ім'я) без service-spec (Bug #163) — backend / test-coverage

**Сигнал:** `fix: customerGarage → customerGarages` — contract spec мокає service → не ловить PrismaClientValidationError.
**Фікс:** service-spec з `PrismaService useValue: { model: { findMany: vi.fn() } }` → assert `findMany.mock.calls[0][0].where`.
**Severity:** HIGH (runtime P2028 у production).

---

### 2026-05-28 — Optional FK у spread без org-scoped validation (Bugs #90, #161) — backend / tenant-isolation

**Сигнал:** `data: { ...dto }` де `dto.brandId?: string` — service не робить `findFirst({ id: dto.brandId, orgId, deletedAt:null })` ПЕРЕД create.
**Grep:** `grep -rn "Id?: string" apps/api/src/modules --include="*.dto.ts" | grep -iE "brand|unit|supplier|counterparty|vehicle"` → `grep -rn "data: { \.\.\.dto" apps/api/src/modules --include="*.service.ts"`.
**Severity:** HIGH (cross-tenant FK у БД без error).

---

### 2026-05-28 — Swallowed fetch годує обов'язковий Select → заблокований workflow — frontend

**Grep:** `grep -rn "\.catch(() => {})" apps/web/src/app --include="*.tsx" -B3` → чи `setX()` рендерується у `<Select required>`.
**Severity:** MEDIUM (workflow permanently blocked).

---

### 2026-05-28 — Мертвий стан/handler після inline→shared-component рефактору — frontend

**Сигнал:** setter викликається ТІЛЬКИ у reset-ефекті, value ніде не читається у JSX. tsc без `noUnusedLocals` мовчить.
**Grep:** `grep -rn "const \[(wo|cp|search)[A-Za-z]*," apps/web/src/app --include="*.tsx"` → перевірити usage.
**Severity:** LOW.

---

### 2026-05-28 — Timeline drag/resize px→time без clamp → Invalid Date (Bug #157) — frontend

**Grep:** `grep -rn "pxToHours\|pxToDecimal\|clientX.*-.*rect" apps/web/src/app --include="*.tsx" -l`.
**Фікс:** clamp у `[WINDOW_START, WINDOW_END]` ПЕРЕД `new Date(...)`. Resize-гілка ОКРЕМО від draw-гілки.
**Severity:** HIGH (RangeError → handler мовчки падає).

---

### 2026-05-28 — Стала spec після рефактору сервісу (Bugs #153-#155) — backend / test-coverage

**Сигнал:** нова `private readonly X: Type` у конструкторі → `{ provide: Type, useValue: mock }` відсутній у spec → NestJS DI fail на ВСІХ тестах.
**Severity:** MEDIUM (baseline red).

---

### 2026-05-28 — Soft-delete resurrection / P2002 — backend / unique constraints

**Сигнал:** `create()` без resurrection check → P2002 при повторному створенні.
**Фікс:** `findFirst({ NOT: { deletedAt: null } })` → якщо знайшов → `update({ ...dto, deletedAt: null })`.
**Severity:** HIGH.

---

### 2026-05-28 — @db.Date timezone mismatch — backend / date handling

**Сигнал:** `@db.Date` зберігає UTC-midnight → при читанні в Kyiv (UTC+3) → неправильна дата (вчора).
**Фікс:** `DateTime` + normalize у kyivMidnight(); або `@db.Date` тільки для calendar-independent dates.
**Severity:** HIGH.

---

### 2026-05-28 — $transaction(array, { timeout }) не підтримується Prisma 5 — backend

**Сигнал:** `prisma.$transaction([op1, op2], { timeout })` → `TypeError: Option not supported`.
**Фікс:** тільки callback-form: `$transaction(async (tx) => { ... }, { timeout })`.
**Severity:** HIGH (runtime error).

---

### 2026-05-28 — BigInt у payload spread → JSON.stringify 500 — backend / sync

**Grep:** `grep -rn "syncVersion\b" apps/api/src/modules --include="*.service.ts" | grep -v "Number(\|toNumber()"`.
**Фікс:** `syncVersion: Number(row.syncVersion)` у toDto.
**Severity:** HIGH (500 при синхронізації).

---

### 2026-05-28 — CRON findMany без deletedAt: null на Organisation — backend

**Grep:** `grep -rn "findMany.*Organisation\|findFirst.*Organisation" apps/api/src --include="*.ts" | grep -v "deletedAt"`.
**Severity:** MEDIUM (cron обробляє deleted orgs).

---

### 2026-05-28 — Playwright fullyParallel + Next.js dev → SyntaxError race — E2E

**Сигнал:** `fullyParallel: true` → кілька workers mount Next.js dev server паралельно → `SyntaxError: Unexpected token`.
**Фікс:** `fullyParallel: false` або `workers: 1` для dev mode.
**Severity:** HIGH (E2E suite unstable в CI).

---

### 2026-05-28 — .catch(() => {}) ховає loading/error стан — frontend

**Grep:** `grep -rn "\.catch(() => {})" apps/web/src/app --include="*.tsx"`.
**Фікс:** `.catch((e) => { if (!cancelled) setError(e.message) })`.
**Severity:** MEDIUM.

---

### 2026-06-01 — Optional numeric DTO field з тільки @IsOptional() (Bug #283) — backend / validation

**Grep:** `grep -rn "?: number\b" apps/api/src/modules --include="*.dto.ts"` → перевірити наявність `@IsInt/@IsNumber/@Min/@Max/@Type(() => Number)`.
**Severity:** HIGH (runtime crash / data corruption).

---

### 2026-06-01 — Stale `.next/` cache після route group рефакторингу (Bug #291) — infra

**Сигнал:** переміщення `app/X/page.tsx` → `app/(group)/X/page.tsx` → webpack chunk-id mismatch → CRITICAL 500 → React не гідрується → auth guards не виконуються.
**Grep:** `git diff HEAD~5 HEAD --name-status | grep -E "^R.*app/.*page\.tsx"` → при match: `rm -rf apps/web/.next apps/web/tsconfig.tsbuildinfo`.
**Severity:** CRITICAL.

---

### 2026-06-02 — `?? 1` не ловить 0 від БД-дільника (Bug #316) — backend / defense-in-depth

**Сигнал:** `coefficient ?? 1` — якщо `coefficient=0` у БД → division by zero. `??` ловить лише null/undefined, не 0.
**Grep:** `grep -rn "coefficient ?? 1\|denominator ?? 1" apps/api/src --include="*.ts"`.
**Фікс:** `coefficient || 1` або `coefficient > 0 ? coefficient : 1`. Парне: `CHECK (coefficient > 0)` у migration.
**Severity:** HIGH.

---

### 2026-06-02 — isSystem-guard у update()/remove() (Bugs #319-#320) — backend / business-rule

**Grep:** `grep -rn "isSystem\s*Boolean" packages/database/prisma/schema.prisma` → для кожної моделі → `service.update`: `if (existing.isSystem && dto.name !== undefined) throw`.
**Severity:** HIGH (system seed corrupted via API).
**Coverage-gap (2026-09-05 — split-coverage):** guard був у UnitOfMeasure/WorkCategory/GoodCategory, АЛЕ відсутній у Currency + PaymentMethodConfig — той самий клас seed-master-data без захисту. Сигнал: у `schema.prisma` є `isSystem` НЕ на всіх seed-таблицях, або seed промарковано `isSystem:true` але `service.remove/update` не читає це поле. **Grep-пара:** `grep -rn "isSystem: true" packages/database/prisma/seed.ts` (які моделі мають системні seed-рядки) звірити проти `grep -rln "existing.isSystem" apps/api/src/modules` (які service мають guard) — різниця = незахищені. **Міграція-нюанс:** нова `isSystem`-колонка потребує backfill наявних seed-рядків (`UPDATE ... SET isSystem=true WHERE code IN (...)`), інакше вже-розгорнуті БД лишаються без захисту (DEFAULT false). Live-verify: GET повертає isSystem у кожному item; DELETE/PATCH-name системного→400.

**Frontend-coupling (2026-09-05 — «reject-if-present» guard тригерить false-400):** guard `if (dto.name !== undefined) throw` реджектить НАЯВНІСТЬ поля, не зміну. Frontend що PATCH-ить назад **незмінений** immutable-field системного запису (типовий edit-form який серіалізує весь стан) отримає спурінний 400. **Фікс на фронті — ОМІТити immutable-поля з PATCH-body для системного запису, не лише `disabled` input:** `body = { ...(isSystem ? {} : { name, code }), ...editableFields }`. Просто `disabled` на input недостатньо — стан форми все одно містить старе значення і потрапляє у body. Сигнал у component-тесті/live: PATCH системного з UI лише-косметичної зміни→400 попри disabled-поля. Дзеркалити omit і у dead/sibling-файлах (settings vs ndi drift).
**Де шукати ще:** будь-яка модель з seed + `isSystem` (TaxRate, DocumentNumberConfig, NotificationTemplate, PaymentMethodConfig, Currency, UnitOfMeasure, Work/GoodCategory) → guard у service + frontend-omit у її Tab-компоненті.

---

### 2026-06-02 — refetch-callback (onChanged) без race-guard (Bug #323) — frontend / race-condition

**Сигнал:** `<CategoryManagerModal onChanged={() => loadCategories()}/>` без cancelled-flag → unmount перед resolve → setState on unmounted.
**Grep:** `grep -rn "onChanged\|onUpdated\|onCreated" apps/web/src/app --include="*.tsx" -A2 | grep "load\|fetch"`.
**Severity:** MEDIUM.

---

### 2026-06-03 — Literal `[]`/`{}` як аргумент до custom hook (Bug #328) — frontend / React anti-pattern

**Сигнал:** `useX(filters, [])` → нова reference кожен render → `useEffect([deps, []])` запускається infinitely.
**Grep:** `grep -rnE "use[A-Z]\w*\(.*\[\]|\{\}\s*\)" apps/web/src/app --include="*.tsx"`.
**Фікс:** `const EMPTY = useMemo(() => [], [])` або `useCallback`/`useMemo` для object args.
**Severity:** HIGH (infinite re-render / network storm).

---

### 2026-06-03 — Stale closure у useApiMutation/useCallback з eslint-disable exhaustive-deps (Bug #330) — frontend / hooks

**Сигнал:** `useCallback(() => apiFetch(url, { body: data }), [])` з `// eslint-disable-next-line` → stale closure для змінних що оновлюються.
**Grep:** `grep -rn "eslint-disable.*exhaustive-deps" apps/web/src --include="*.tsx" --include="*.ts"`.
**Severity:** HIGH (stale data у mutation).

---

### 2026-06-04 — BullMQ processor без idempotency guard (Bug #346) — backend / BullMQ

**Сигнал:** `@Process` з `fetch(externalApi)` + `attempts > 1` але БЕЗ перевірки `existingResult` → retry дублює side-effect (2 SMS, 2 фіскальних чеки).
**Grep:** `grep -rn "async handle" apps/api/src/modules --include="*.processor.ts" -l | while read f; do grep -q "fetch(\|axios\." "$f" && ! grep -q "findFirst\|findUnique" "$f" && echo "MISSING idempotency: $f"; done`.
**Severity:** MEDIUM (ПРРО fiscal compliance risk).

---

### 2026-06-05 — Stable callback identity invariant у composable hooks — frontend / hooks

**Сигнал:** `useCallback(() => ..., [])` у composable hook — без regression-guard test на identity stability.
**Grep:** `grep -rn "useCallback(.*, \[\])" apps/web/src/hooks --include="*.ts" | grep -v test`.
**Фікс-тест:** `const first = result.current.cb; rerender(); expect(result.current.cb).toBe(first)`.
**Severity:** MEDIUM (perf cascade).

---

### 2026-06-05 — `new Date(\`${date}T${time}:00\`)` без TZ суфіксу (Bugs #354, #358) — frontend / timezone

**Сигнал:** FE парсить як local-time замість UTC → 3-year drift у timestamp.
**Grep:** `grep -rnE "new Date\(\`\$\{._\}T\$\{._\}:00\`\)" apps/web/src/app --include="\*.tsx"`.
**Фікс:** використати `localDateTimeToISO(date, time)`з`apps/web/src/lib/format.ts`.
**Severity:** HIGH (wrong datetime у БД).

---

### 2026-06-05 — Boolean-flag (isPrimary/isDefault) без unset previous при create/update (Bug #357) — backend

**Сигнал:** `create({ isPrimary: true })` без `updateMany({ where: { isPrimary: true }, data: { isPrimary: false } })` → кілька primary у scope.
**Grep:** `grep -rn "isPrimary.*true\|isDefault.*true" apps/api/src/modules --include="*.service.ts" | grep -v "updateMany"`.
**Фікс:** у `$transaction`: спочатку `updateMany` unset, потім `create/update`.
**Severity:** HIGH (business invariant порушений).

---

### 2026-06-08 — Дублікат рядка у multi-row form без перевірки (Bug #382) — frontend / UX / validation

**Сигнал:** `addRow()` дозволяє додати той самий `goodId` двічі → duplicate inventory movements.
**Фікс:** `if (rows.some(r => r.goodId === newRow.goodId)) return` перед push.
**Severity:** MEDIUM.

---

### 2026-06-08 — Pre-validate numeric fields у local rows ДО batch POST (Bug #383) — frontend / validation

**Сигнал:** submit batch POST без front-validation → partial-create або rollback але UX не знає яка row failed.
**Фікс:** `rows.forEach((r, i) => { if (!r.quantity || r.quantity <= 0) throw \`Рядок ${i+1}: кількість обов'язкова\` })`ПЕРЕД першим`apiFetch`.
**Severity:** MEDIUM.

---

### 2026-06-08 — Half-typed row silently dropped при submit (Bug #384) — frontend / UX / data-loss

**Сигнал:** `rows.filter(r => r.goodId && r.quantity > 0)` → half-typed row мовчки пропускається без warning.
**Фікс:** `if (rows.some(r => r.goodId && !r.quantity)) confirm("Незаповнені рядки будуть пропущені. Продовжити?")`.
**Severity:** MEDIUM (data-loss без feedback).

---

### 2026-06-17 — Public DTO leak whitelist test (Bug #530) — backend / security / regression-guard

**Сигнал:** public endpoint (share-token/magic-link) повертає DTO через manual `parts.map(p => ({...whitelist}))`. Захист від витоку (`costPrice`, `batchCostPrice`, `paidAmount`, `orgId`, `syncVersion`) тримається на тому що автор НЕ написав `{...p}` spread. TS не ловить (Prisma row ширший за DTO; `parts!: EstimatePublicPartDto[]` не валідує runtime — зайвий ключ проходить JSON.stringify). Ризик: `{...p, computed}` шортчат або `include: {warehouse:true}` замість narrow select → sensitive поля витікають.
**Grep:**

```bash
grep -rn "@Public\|@Get.*share\|@Get.*public" apps/api/src/modules --include="*.controller.ts"
# handler НЕ має: parts.map(p => ({...p})) spread; include: true / wide-include
ls apps/api/src/modules/*/work-orders.share-public.spec.ts 2>/dev/null
```

**Фікс:** `<resource>.share-public.spec.ts` з 3 assertions (hasOwnProperty ловить ключ навіть зі значенням undefined — сильніше за `=== undefined`):

```ts
expect(Object.prototype.hasOwnProperty.call(part, 'costPrice')).toBe(false);
expect(Object.keys(part).sort()).toEqual(
  ['amount', 'goodName', 'id', 'price', 'quantity', 'unitShortName'].sort(),
);
expect(Object.prototype.hasOwnProperty.call(dto, 'orgId')).toBe(false); // + paidAmount, syncVersion
```

**Severity:** HIGH для public (без auth — витік = реальна leak); MEDIUM для authenticated (RBAC обмежує).
**Де шукати ще:** кожен `@Public()` endpoint з aggregate+вкладеними рядками: WorkOrder estimate share ✅ (#530), Invoice public viewer, Counterparty public profile.

---

### 2026-06-17 — Defensive take/limit cap regression-guard (Bug #531) — backend / perf / regression-guard

**Сигнал:** service робить `findMany`/`findFirst` з `take: N` cap як defense-in-depth проти unbounded зростання (legacy import, missing ArrayMaxSize, scripted ops). Без regression-guard refactor може: видалити `take` → OOM; знизити → silent truncation → дезінформація у totals; `select` narrow → `include: true` → perf drop. «Defensive — ніколи не спрацює» → spec не пишеться → хтось видаляє «зайвий» take → sentry alert після WO з 5000 рядків.
**Grep:**

```bash
grep -rnE "take: (100|500|1000)\b" apps/api/src/modules --include="*.service.ts" | grep -v "spec\|page"
grep -rn "callArgs.take\|take: 1000" apps/api/src/modules --include="*.spec.ts"   # потрібно expect(callArgs.take).toBe(1000), не toHaveBeenCalled()
```

**Фікс:** dedicated `*-cap.spec.ts` (не мікс з business-logic), 3-4 тести:

```ts
expect(callArgs.take).toBe(1000); // exact, НЕ >=
expect(callArgs.where.deletedAt).toBeNull();
expect(callArgs.select).toEqual({
  /* narrow */
});
// boundary: findMany повертає рівно N → aggregated суми коректні
```

**Severity:** MEDIUM (defense-in-depth, runtime ОК зараз); HIGH якщо cap захищає hot path (recalcTotals у transaction).
**Де шукати ще:** work-orders.service.ts (recalcTotals ✅), inventory.service.ts (reserveParts take:1000), purchase-orders.service.ts (receive bulk), invoices.service.ts (createFromWorkOrder).

---

### 2026-06-19 — Constructor DI drift breaks ALL specs of service (Bug #534, #536) — backend / test-infra

**Сигнал:** feature commit додає **новий dependency у constructor** `@Injectable()` сервісу (`private readonly newDep: NewService`) без оновлення `*.service.spec.ts` — 100% тестів модуля падають `Nest can't resolve dependencies of XService (..., ?). ... NewService at index [N]`. CRITICAL release-blocker (ховає реальну регресію шумом). Окремий drift у positional-arg specs (`new WorkOrdersService(prisma, null as never, ...)`): новий arg зсуває порядок, `null as never` однакові → TS не ловить, runtime падає коли метод читає поле з зсунутим індексом.
**Grep:**

```bash
for f in $(git diff HEAD~5 HEAD --name-only -- 'apps/api/src/modules/**/*.service.ts' | grep -v spec); do
  added=$(git diff HEAD~5 HEAD -- "$f" | grep "^+.*private readonly.*Service$" | wc -l)
  [ "$added" -gt 0 ] && spec="${f%.ts}.spec.ts" && [ -f "$spec" ] && grep -q "$(git diff HEAD~5 HEAD -- "$f" | grep "^+.*private readonly" | head -1 | grep -oE '[A-Z][a-zA-Z]+Service')" "$spec" || echo "DRIFT $spec MISSING mock"
done
pnpm --filter @sto/api test --run 2>&1 | tail -5   # baseline; new fails після scope commits = feature ввела
grep -rn "new [A-Z][a-zA-Z]*Service(" apps/api/src --include="*.spec.ts"   # positional-arg крихкі
```

**Фікс:** (1) Test.createTestingModule: `{ provide: NewService, useValue: stubObj }` (не `{}` — дає null.method; `vi.fn().mockResolvedValue(safeDefault)`); (2) positional-arg: замінити відповідний `null as never` на mock, named comment `null as never, // inventory`; (3) MANDATORY повний test-suite ПЕРЕД commit. Регресія-guard: pre-commit hook — constructor changed → spec providers changed; tester Krok 0 `pnpm test --run` для @sto/api І @sto/web.
**Severity:** CRITICAL feature-introduced (новий dep + 30+ failed = фіча мертва у CI); MEDIUM pre-existing test rot.
**Де шукати ще:** новий dep у будь-якому `@Injectable()`; cross-module dep (SettingsService у PurchaseOrdersService, DocumentNumberService у GoodsService); `grep -rn "new.*Service(.*null as never" apps/api/src --include="*.spec.ts"`.

---

### 2026-06-19 — Migration ADD VALUE без парного INSERT backfill для DocumentNumberConfig (Bug #533) — database / migration

**Сигнал:** commit додає enum `DocumentType` value (`'GOOD_INTERNAL_CODE'`) + service `documentNumberService.next(orgId, '<NEW_VALUE>')`; у `seed.ts` є `docConfigs[]` запис, АЛЕ міграція містить ЛИШЕ `ALTER TYPE ADD VALUE` БЕЗ парного `INSERT INTO document_number_configs` для існуючих org. У production (existing org не запускають seed повторно) → `next()` кидає `NotFoundException('Конфігурацію нумерації...не знайдено')` → mutation-flow blocked. Не ловиться tsc/unit/contract (prisma моки) — лише integration/runtime. seed.ts запускається ТІЛЬКИ при initial setup, не при `prisma migrate deploy`.
**Grep:**

```bash
grep -l "ADD VALUE.*'GOOD_INTERNAL_CODE'" packages/database/prisma/migrations/*/migration.sql
grep -l "INSERT INTO document_number_configs" packages/database/prisma/migrations/*/migration.sql   # нема INSERT з timestamp ПІСЛЯ ALTER TYPE = bug
grep -rn "docNumbers.next.*'GOOD_INTERNAL_CODE'" apps/api/src/modules --include="*.ts"
ls packages/database/prisma/migrations/ | grep -i "_seed.*doc_numbers"
```

**Фікс:** окрема migration з timestamp +1s (Postgres забороняє INSERT з новим enum у тій же tx що ALTER TYPE):

```sql
INSERT INTO document_number_configs ("id","orgId","documentType","prefix","includeDate","dateFormat","separator","padding","currentSeq","resetPeriod","updatedAt")
SELECT gen_random_uuid(), o.id, '<NEW_VALUE>'::"DocumentType", '<prefix>', <includeDate>, 'YYYYMMDD', '-', <padding>, 0, '<resetPeriod>'::"ResetPeriod", NOW()
FROM organisations o
WHERE NOT EXISTS (SELECT 1 FROM document_number_configs c WHERE c."orgId"=o.id AND c."documentType"='<NEW_VALUE>'::"DocumentType");
```

Config 1:1 з `seed.ts:docConfigs[]` (prefix, padding, includeDate, resetPeriod). Регресія-guard: pre-commit hook блокує `ADD VALUE` у DocumentType без парного INSERT; integration test після `migrate deploy` runtime `next()` з новим enum.
**Severity:** CRITICAL (release-blocker — фіча мертва у проді для існуючих orgs).
**Де шукати ще:** всі commits з `enum DocumentType {... NEW}`; seed-керовані enum з config-таблицями: PaymentMethodConfig.code, NotificationTemplate.eventType, TaxRate.rate, CurrencyCode.code — кожен потребує backfill INSERT.

### 2026-06-20 — Validation message Cyrillic encoding in Zod/class-validator (Bug #537) — frontend / validation / i18n

**Сигнал:** `@Matches` validator з `message`-кирилицею обробленою інструментом що змінює encoding (BOM removal, PowerShell `Set-Content` без `-Encoding utf8`, UTF-16). Результат `'Р¤РѕСЂРјР°С‚...'` замість `'Формат "ГГ:ХХ"'` → 400 з garbled текстом.
**Grep:**

```bash
grep -rn "@Matches.*message:\|@MinLength.*message:\|@MaxLength.*message:" apps/api/src/modules --include="*.dto.ts"
for f in $(git diff HEAD~2 HEAD --name-only -- "*.dto.ts"); do grep -q "@Matches.*message:" "$f" && grep -n "message:" "$f"; done
# contract.spec: expect(res.json().message).toMatch(/^[А-Яа-яІіЇїЄє0-9\s"():.–—-]*$/)
```

**Фікс:** переписати кирилицю вручну, зберегти UTF-8 БЕЗ BOM (`"files.encoding": "utf8"`), перевірити у contract.spec.
**Severity:** LOW (UX confusion validation message); MEDIUM якщо message ключовий для workflow (HH:MM format).
**Де шукати ще:** усі `@Matches`/`@IsString`/`@MinLength` з кирилицею message у DTO що пройшли sed/BOM-removal commit (`git log --oneline -20 -- "*.dto.ts"`).

---

### 2026-06-20 — E2E test seed race condition за 30s timeout (Bug #538) — E2E / test-infrastructure / flaky

**Сигнал:** Playwright spec (retries=3) всі 3 спроби `expect(...).toBeVisible({timeout:30_000})` → `element(s) not found`; окремий запуск може пройти (flaky). Seed у `beforeAll()` через API залежить від DRAFT donor у БД; якщо DB пустий/seed не спрацював → clone=null → тест мовчки пропускається (нема `expect(seededId).toBeTruthy()`). Або transition DRAFT→ESTIMATE дає 500 → clone у DRAFT → FE фільтрує ESTIMATE → рядок не видно.
**Grep:**

```bash
grep -rn "beforeAll.*async\|seedEstimateWorkOrder\|seedXWorkOrder" apps/web/e2e --include="*.spec.ts"
grep -A 5 "beforeAll" "$spec" | grep -E "expect.*toBeTruthy|expect.*not.toBeNull" || echo "MISSING GUARD"
```

**Фікс:** explicit гард `expect(seededId, 'beforeAll must seed ...').toBeTruthy()` у першому тесті; seed-функція логує error detail (не `return null`); retry-loop max 3 з backoff для транзиторних 500; skip з дружнім `test.skip()` якщо нема donor.
**Severity:** LOW (flaky, наступна спроба може пройти); MEDIUM якщо seed гарантує детермінізм.
**Де шукати ще:** .spec.ts з `beforeAll()` API seeding (POST, не DB insert): estimate-share, public pages, auth flows, complex-state (multi-org, cross-org).

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

---

### 2026-06-20 — E2E sessionStorage НЕ restored через storageState (Bug #567) — e2e / playwright / sessionStorage-limitation

**Сигнал:** E2E failure screenshot показує login форму замість сторінки; `getByRole(...)` timeout одразу після `page.goto('/work-orders')`. Playwright `storageState` зберігає sessionStorage у admin.json, АЛЕ `test.use({storageState})` restore-ить ТІЛЬКИ cookies+localStorage — sessionStorage завжди порожній (відома обмеження, tab-scoped). AuthProvider читає token з sessionStorage → `stored=null` → reducer `{isLoading:true}` → `refreshToken()` → 401 (no refresh cookie) → silent LOGOUT → redirect /login.
**Grep/probe:**

```bash
ls apps/web/test-results/*/test-failed-1.png   # screenshot «Вхід до системи» = auth issue
cat apps/web/e2e/.auth/admin.json | jq '.cookies | length'   # 0 → refresh fails завжди
# runtime: page.evaluate(() => ({ hasToken: !!sessionStorage.getItem('sto_access_token') }))  → false попри admin.json
```

**Фікс (3-prong):** (1) `setup-auth.ts`: дзеркалити token у `localStorage.sto_e2e_access_token` + `sto_e2e_skip_refresh='1'` + `sto_employee_cache`; (2) AuthProvider reducer init: якщо sessionStorage порожній + `sto_e2e_skip_refresh==='1'` + є `sto_e2e_access_token` → скопіювати у sessionStorage ПЕРЕД читанням; (3) useEffect: flag+cached → пропустити refresh-on-mount. Production не встановлює E2E ключі — zero impact. Регресія-guard: spec «skips refresh when sto_e2e_skip_refresh=1 + cached».
**Severity:** CRITICAL — блокує всі захищені E2E тести.
**Де шукати ще:** frontend з httpOnly refresh cookie + cross-port API + Playwright. Альтернатива — `webServer` proxy `/api/*` → same-origin → cookies survive.

---

### 2026-06-20 — Node IPv6 default на Windows ламає server-side fetch (Bug #566) — e2e / infrastructure / dns-resolution

**Сигнал:** інтермітентний `ECONNREFUSED ::1:3000` у Playwright `request.newContext()` / Node `fetch()`; браузерні запити з Chromium працюють (dual-stack). Node 18+ на Windows повертає IPv6 `::1` перед `127.0.0.1` при resolution `localhost`; NestJS `app.listen(port, '0.0.0.0')` слухає тільки IPv4 → ECONNREFUSED.
**Grep:**

```bash
grep -rn "fetch.*localhost:3000\|request.newContext\|http://localhost:3000" apps/web/e2e/ | grep -v "page.evaluate"
```

**Фікс:** (1) швидкий: `http://localhost:3000` → `http://127.0.0.1:3000` у server-side fetch (estimate-share.spec.ts, setup-auth.ts); браузерні `page.evaluate(fetch)` ОК; (2) architectural: `app.listen(port, '::')` dual-stack (за згодою owner); (3) env: `playwright.config.ts` webServer.env `NEXT_PUBLIC_API_URL=http://127.0.0.1:3000`. Регресія-guard: test 3 рази підряд.
**Severity:** HIGH (intermittent, ризик у flaky investigations).
**Де шукати ще:** Node-side fetch до localhost де сервер біндить IPv4-only: WatermelonDB sync, BullMQ workers, cross-service HTTP у monorepo dev.

---

### 2026-06-20 — Sidebar-preview pattern: row click НЕ навігує (Bug #574) — e2e / ux-pattern / list-pages

**Сигнал:** E2E ламається на `expect(page).toHaveURL(/\/<entity>\/[a-z0-9-]+/)` після `firstRow.click()`; сторінка залишилась на /<entity>. List-pages мігрували на pattern: row click → `setSelected` → DetailPanel side-preview; навігація тепер через окрему кнопку/action-button (модалка, не URL). Тест писався коли row click робив `router.push`.
**Grep:**

```bash
grep -rn "firstRow\|tbody tr.*click\(\)" apps/web/e2e --include="*.spec.ts" -A 3 | grep -B 1 "toHaveURL.*\[a-z0-9-\]"
grep -nE "onClick.*setSelected|router\.push" $page/page.tsx   # тільки setSelected → UI не навігує
```

**Фікс:** для detail-page тестів — НЕ row click, а API + page.goto:

```typescript
await page.goto('/work-orders');
await expect(page.locator('table tbody tr').first()).toBeVisible(); // wait for auth
const token = await page.evaluate(() => sessionStorage.getItem('sto_access_token'));
const wo = await page.evaluate(async t => {
  const r = await fetch('http://localhost:3000/api/work-orders?limit=1', {
    headers: { Authorization: `Bearer ${t}` },
  });
  const j = await r.json();
  return Array.isArray(j) ? j[0] : j.items?.[0];
}, token);
await page.goto(`/work-orders/${wo.id}`);
```

**Severity:** MEDIUM — тести failed після migration на side-preview; потребує правки в усіх list-page specs.
**Де шукати ще:** invoices, purchase-orders, stock-documents, counterparties, employees — усі list-pages з `useListPage`; перевіряти `firstRow.click()` + `toHaveURL`.

---

### 2026-06-20 — Skeleton/loading row матчиться як data row (Bug #575) — e2e / async-state / table-loading

**Сигнал:** тест `expect(page.locator('table tbody tr').first()).toBeVisible()` думає що таблиця завантажилась, потім `.count()` на checkbox = 0 попри свіжо створені рядки. Скріншот показує «Завантаження». List-page рендерить skeleton `<TableRow>` при `isLoading=true`; локатор `table tbody tr` матчить і skeleton, і data row; `first()` дає skeleton.
**Grep:** `grep -rn "table tbody tr.*first\(\)" apps/web/e2e --include="*.spec.ts"`.
**Фікс:** чекати на елемент який є ТІЛЬКИ у data row (не skeleton):

```typescript
await expect
  .poll(async () => await page.locator('table tbody tr input[type="checkbox"]').count(), {
    timeout: 20_000,
  })
  .toBeGreaterThanOrEqual(2);
// АБО content-селектор:
await expect(page.locator(`table tbody tr:has-text("${invoiceNumber}")`)).toBeVisible();
```

**Severity:** MEDIUM — flaky/false-fail, важко дебажити (locator знаходить tr, assertions після — fail).
**Де шукати ще:** list-page де loading rendering включає `<TableRow>` (invoices, work-orders, purchase-orders, stock-documents); всі `table tbody tr').first()` що передують `count()`/`nth(N)`.

---

### 2026-06-20 — Hardcoded seed values vs E2E-generated fixtures (Bug #576) — e2e / fixture-drift / first-row-pollution

**Сигнал:** тест очікує hardcoded seed values (`AA1234BB`, `Toyota`) на першому ресурсі з API, але там `E2E-Make E2E-Model-560110` — артефакт з раніших прогонів (CRUD specs без afterAll cleanup → `GET /vehicles?limit=1` повертає E2E-артефакт). `getByText(/AA1234BB/).first() not found`.
**Grep:** `grep -rn "AA1234BB\|Toyota Camry\|Honda Civic\|Іван Петренко" apps/web/e2e --include="*.spec.ts"`.
**Фікс:** динамічний regex з API замість hardcoded:

```typescript
const vehicle = await page.evaluate(
  async ({ tok, id }) => {
    const r = await fetch(`http://localhost:3000/api/vehicles/${id}`, {
      headers: { Authorization: `Bearer ${tok}` },
    });
    return r.json();
  },
  { tok: token, id: vehicleId },
);
await expect(page.getByText(new RegExp(escapeRegex(vehicle.make), 'i')).first()).toBeVisible();
const optional = [vehicle.licensePlate, vehicle.year, vehicle.vin].filter(Boolean);
if (optional.length)
  await expect(
    page.getByText(new RegExp(optional.map(escapeRegex).join('|'), 'i')).first(),
  ).toBeVisible();
```

**Severity:** MEDIUM — fail якщо row-order залежить від E2E artifacts; після seed reset працює. False positives у CI.
**Де шукати ще:** тести що очікують seed values (vehicles, counterparties, work-orders, goods) на першому елементі list; всі hardcoded brand/model/name/phone strings.

---

### 2026-07-03 — Sprint-wide DTO drift detection: `@IsArray` без `@ArrayMaxSize` через 5-line context grep (Bug #587) — api / dto / anti-dos / drift

**Сигнал:** проєкт має 30+ файлів `@IsArray()` + `@ArrayMaxSize(N)` (canonical DoS-guard), АЛЕ ~5 пропустили cap. TS/unit green, review не ловить (checklist існує, але grep-scan не використаний). Ловиться тільки systematic-audit grep+context (не manual-review): розробник копіює validate/type-guards без `@ArrayMaxSize`.
**Grep (template canonical-pattern audit):**

```bash
for line in $(grep -rn "<PRIMARY_MARKER>" <SCOPE> --include="*.<EXT>" | cut -d: -f1-2); do
  file=$(echo "$line" | cut -d: -f1); ln=$(echo "$line" | cut -d: -f2)
  ctx=$(sed -n "$((ln-5)),$((ln+5))p" "$file")   # декоратори згруповані вгорі поля
  echo "$ctx" | grep -qE "<PAIRED_MARKER_REGEX>" || echo "MISSING: $file:$ln"
done
# фільтр false-positive: awk 'NR<=LN && /^export class.*Dto/{c=$0} END{print c}' | grep -qE "Response|Paginated|Public|List" && continue
```

Приклади: `@IsArray()` без `@ArrayMaxSize|@ArrayMinSize`; `@IsString()` без `@MaxLength|@IsIn|@IsEmail|@IsUrl|@Matches|@IsUUID`; `@IsUUID()` без `Transform` (nil-UUID injection); `?: number` без `@IsInt|@IsNumber|@Min|@Max|@Type` (Bug #283); `$transaction(async` без `timeout:` (§1.1).
**Фікс:** batch — realistic максимум (small→20, medium→100, list→200); `@ArrayMaxSize(N, {message})` між `@IsArray()` та inner validator; inner `@IsString()` → `@MaxLength(N, {each:true})`; import ArrayMaxSize.
**Severity:** MEDIUM (auth-protected — insider), але systematic-consistency → release-blocker.
**Де шукати ще:** кожен новий `@IsArray()` у review; QueryDto array filter params; PartialType Create нове поле; sprint-audit інших canonical: `@IsString+@MaxLength`, `?:number+@Type`, `$transaction+timeout`, `@Controller+@UseGuards`.

---

### 2026-08-30 — Spec-vs-impl timezone-arithmetic parity (Bug #592) — api / test / dst-aware

**Сигнал:** baseline API vitest падає `expected 'YYYY-MM-DD_A' to be 'YYYY-MM-DD_B'` (різниця 1 день). Spec обчислює `expected` через `new Date() + setUTCDate()` (UTC), impl використовує `kyivToday()/addDaysKyiv()` (Kyiv). Падає у ~3h вікні UTC-північ ↔ Kyiv-північ; днем passes. Виглядає flaky, але deterministic bug у spec (impl правильний).
**Grep:**

```bash
grep -rn "setUTCDate\|toISOString().slice(0, 10)" apps/api/src --include="*.spec.ts"
# для кожного: паралельний impl imports kyivToday/addDaysKyiv → spec теж має їх
```

**Фікс:** `new Date() + setUTCDate(+N)` → `addDaysKyiv(kyivToday(), N)` у spec (import з `../../common/utils/kyiv-date`) + inline-коментар.
**Severity:** HIGH — release-blocker у 3h/day вікні (tester-сесії неможливі). Не CRITICAL (impl правильний, 1-line fix, flaky).
**Де шукати ще:** `*.spec.ts` з paymentDate/dueDate/expiryDate/documentDate/warrantyExpiresAt/@db.Date; auto-fill дати receive() PO, create() Invoice (dueDate=today+N), addDaysISO() FE; reports/calendar/schedule date-window тести.

---

### 2026-08-30 — QueryClientProvider absent після React Query hook migration (Bug #593) — web / test / rq-migration

**Сигнал:** baseline web vitest падає `Error: No QueryClient set, use QueryClientProvider`. Stack trace вказує на новий hook (`useUpdateSupplierPayment`, `use*Mutation`) у компоненті що раніше юзав raw `apiFetch`. Тест був зелений до commit-міграції (`feat(rq): migrate X`). Тести `render(<Component/>)` без обгортки — apiFetch mock працює (raw), але `useQueryClient()` throws. Підступний варіант: transitive — parent modal падає бо рендерить newly-migrated child з RQ hooks.
**Grep:**

```bash
for hook in $(grep -rlE "^export function use(Create|Update|Delete|Confirm|Cancel)" apps/web/src/hooks/api --include="*.ts"); do
  grep -rln "$(basename $hook .ts)" apps/web/src/components --include="*.tsx" | grep -v test
done
for comp in $(git diff HEAD~5 HEAD --name-only apps/web/src/components/ui/*.tsx); do
  test="apps/web/src/components/ui/__tests__/$(basename $comp .tsx).test.tsx"
  [ -f "$test" ] && grep -q "QueryClientProvider\|renderWithQueryClient" "$test" || echo "MISSING QCP: $test"
done
# transitive: grep parent-component на child-modal-name → parent test теж потребує QCP
# alt: vitest 4+ failures з ідентичним useQueryClient → знайти commit що додав hook
```

**Фікс:** helper у test:

```typescript
function renderWithQueryClient(ui) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}
```

Замінити всі `render(<Component>)`. Довгостроково: shared `test-utils.tsx renderWithProviders` (QueryClient+Router+AuthProvider).
**Severity:** HIGH — release-blocker baseline (тест мовчить, регресії ховаються; особливо критично для regression-guard тестів, Bug #460 pattern).
**Де шукати ще:** кожен `*.test.tsx` для `components/ui/*.tsx` з useMutation/useQuery/useQueryClient; transitive parent modals; аналогічно Router/AuthProvider міграції.

---

### 2026-08-30 — Partial hook migration: один branch мігрований, інший — raw apiFetch (Bug #594) — web / cache / rq-migration-completeness

**Сигнал:** компонент має 2+ branches у handleSave: A `if (isEdit) updateMut.mutateAsync(payload)` (RQ hook, auto-invalidate onSuccess), B `else await apiFetch('/resource', {method:'POST'})` (raw, БЕЗ invalidate). Одна гілка оновлює cache, інша — ні (stale до staleTime=30s). User бачить асиметрію: «оновлення одразу, створення з затримкою». Легко сплутати з «backend повільний». Refactor `feat(rq): migrate X` мігрує один path; hook для іншого branch існує у `use<X>.ts` але не імпортований.
**Grep:**

```bash
grep -rn "^export function use\(Create\|Update\|Delete\|Confirm\|Cancel\)" apps/web/src/hooks/api --include="*.ts" -l | while read hookfile; do
  hookname=$(basename $hookfile .ts | sed 's/^use//')
  endpoint=$(grep -A 3 "^export function use\(Create\|Update\)" $hookfile | grep "apiFetch" | grep -oE "'/[^']*'" | head -1)
  [ -z "$endpoint" ] && continue
  grep -rln "use\(Create\|Update\|Delete\)$hookname" apps/web/src/components apps/web/src/app --include="*.tsx" | grep -v test | while read c; do
    grep -q "apiFetch($endpoint" "$c" && echo "PARTIAL MIGRATION: $c BOTH hook AND raw apiFetch"
  done
done
# manual: modal з handleSave → обидві гілки if(isEdit)/else мають бути mutation-hook
```

**Фікс:** імпортувати парний hook, `const createMut = useCreateSupplierPayment()`, замінити raw apiFetch на `await createMut.mutateAsync(payload)`, додати `createMut` у useCallback deps. Регресія-guard: component-test mock apiFetch + click «Створити» → assert URL + `invalidateQueries`.
**Severity:** HIGH — silent UX gap (stale cache); не CRITICAL (самовиправляється через 30s).
**Де шукати ще:** modal з `if(isEdit) updateMut else apiFetch(POST)`; `if(bulk) apiFetch else deleteMut`; modal-и нещодавно refactor-нуті (feat(rq): migrate).

---

### 2026-08-30 — Regex-shape validation без semantic parseability (Bug #595) — api / dto / validator

**Сигнал:** DTO приймає `@Matches(/^\d{4}-\d{2}-\d{2}$/)` (YMD regex) як ЄДИНУ валідацію дати. `?from=2026-99-99` → 200 з empty/silent-wrong (замість 400). Regex перевіряє SHAPE, не SEMANTIC (місяць 1-12, leap year). Downstream `new Date('2026-99-99')` → Invalid Date → NaN. Розробник не знає що `@IsDateString` = alias `@IsISO8601` (accepts full ISO); комбо `@IsDateString + @Matches(YMD_RE)` не intuitive.
**Grep:**

```bash
grep -rnE "@Matches\(.*\\\\d\{4\}.*\\\\d\{2\}.*\\\\d\{2\}" apps/api/src/modules --include="*.dto.ts"
grep -rnE "@Matches\(.*\\\\d\{4\}" apps/api/src/modules --include="*.dto.ts" -A 3 | grep -B 3 "!:\s*string" | grep -v "@IsDateString" | grep "@Matches"
# curl "/api/<endpoint>?from=2026-99-99" → 200 з empty замість 400 = bug
```

**Фікс:** `@IsDateString({strict:true})` РАЗОМ з `@Matches(YMD_RE)`:

```typescript
@IsDateString({ strict: true }, { message: 'from має бути валідною датою' })
@Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from має бути у форматі YYYY-MM-DD' })
from!: string;
```

`strict:true` відхиляє `2009-02-29`, `2026-99-99`; `@Matches` обмежує YMD-only. Регресія-guard: contract-test invalid date → 400 + Ukrainian message.
**Severity:** MEDIUM — silent empty/wrong data (UI date-picker коректний, DoS обмежений).
**Де шукати ще:** DTO з YMD-date param (reports/calendar/schedule/dashboard `dateFrom/dateTo`); phone `@Matches(/^\+?\d{10,15}$/)` без range-check, IBAN без checksum, EDRPOU без mod-11.

- **sibling-drift у ТОМУ Ж файлі (Bug #616 — регресія #595):** sprint додає новий DTO (drill-down/child) поруч з fix-ed — копіює `@Matches(YMD_RE)` для sibling-поля БЕЗ парного `@IsDateString({strict:true})` (читає декоратори наявного поля, не doc-comment вище). Grep-guard — файли з fix перевірити чи КОЖНЕ `@Matches(YMD_RE)` має парний `@IsDateString`, не тільки перше:
  ```bash
  for f in $(grep -rl "IsDateString.*strict.*true" apps/api/src/modules --include="*.dto.ts"); do
    awk '/@Matches\(YMD_RE/{ if (!has_ds) print FILENAME ":" NR ": lone @Matches"; has_ds=0 } /@IsDateString.*strict/{ has_ds=1 } /^[[:space:]]*[a-z].*:/{ has_ds=0 }' "$f"
  done
  ```

### 2026-08-30 — E2E: seeded entity invisible через дефолтний date-фільтр списку (Bug #572) — e2e / seed-brittle / list-filters

**Сигнал:** тест сідить сутність через API (`beforeAll`), навігує на список, не знаходить row; screenshot «Нарядів не знайдено» з date-input на «today». API GET підтверджує існування. Prisma `documentDate @default(now()) @db.Date` = UTC (Docker), UI дефолт `dateFrom=kyivToday()`. У 00:00-03:00 Kyiv (+3) UTC-дата на добу менша → seed на UTC-добу, фільтр показує Kyiv-добу → row невидимий.
**Grep:** `grep -rn "@default(now()).*@db.Date\|dateFrom.*kyivToday" apps/ --include="*.tsx" --include="*.ts"` (cross-match Prisma vs UI defaults); коментар «фільтр по даті приховує seed ≠ today» (Bug #401) = задокументована grabля.
**Фікс (у ТЕСТІ, не продукті):** seed-helper повертає `number`; перед пошуком очистити date-input (`fill('') → press('Escape')`); `getByRole('textbox', {name:/Пошук/i}).fill(number)` замість `filter({hasText})`. Anti-pattern: обійти через API (фіксує один тест, не root-cause).
**Severity:** HIGH — стабільно червоний 3h/добу + завжди у CI (UTC TZ).
**Де шукати ще:** e2e з beforeAll API-seed + UI перевірка (`grep -rn "beforeAll.*await\|await.*seed" apps/web/e2e`); списки з `dateFrom=kyivToday()` (work-orders, purchase-orders, stock-documents, invoices, supplier-payments); дефолтні filter (branchId, warehouseId, status).

### 2026-08-30 — E2E: DST-aware Kyiv timezone у test time-arithmetic (Bug #573) — e2e / dst / timezone

**Сигнал:** тест створює time-based ресурс (calendar slot, plannedAt) через API + перевіряє на UI; у 00:00-03:00 Kyiv (+3 літо) / 00:00-02:00 (+2 зима) падає «element not found». Тест бере «today» через `new Date().toISOString().split('T')[0]` = UTC (`.toISOString()` завжди UTC попри Playwright `timezoneId`), frontend через `Intl.DateTimeFormat('sv-SE', {timeZone:'Europe/Kyiv'})` = Kyiv. У 21:00-24:00 UTC Kyiv на добу вперед → mismatch. Hardcoded `${today}T07:00:00Z` теж ламається з DST.
**Grep:** `grep -rn "toISOString.*split.*T.*\[0\]\|new Date().*toISOString" apps/web/e2e --include="*.spec.ts"`; pattern «green dev, red CI (UTC TZ)» = timezone-issue.
**Фікс (у ТЕСТІ):** Kyiv-дата як у продукті `Intl.DateTimeFormat('sv-SE', {timeZone:'Europe/Kyiv'}).format(new Date())`; Kyiv wall-clock → UTC через DST-safe round-trip:

```ts
function kyivWallToUtcIso(kyivDate: string, kyivHour: number, kyivMinute = 0): string {
  const guess = new Date(
    `${kyivDate}T${String(kyivHour).padStart(2, '0')}:${String(kyivMinute).padStart(2, '0')}:00Z`,
  );
  const kyivHourOfGuess = parseInt(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'Europe/Kyiv',
      hour: 'numeric',
      hour12: false,
    }).format(guess),
    10,
  );
  return new Date(guess.getTime() + (kyivHour - kyivHourOfGuess) * 3_600_000).toISOString();
}
```

Iterate по Kyiv-годинах робочого дня (10-16). Anti-pattern: hardcoded `+3`/`+2` offset; `date.getTimezoneOffset()` (залежить від хост-OS, не Playwright timezoneId).
**Severity:** HIGH — червоний у DST-boundary вікні + завжди у CI (UTC TZ); CI-only failure не reproducible локально без `TZ=UTC`.
**Де шукати ще:** e2e date/time arithmetic; backend spec (Bug #592); frontend unit — Intl не респектує `vi.setSystemTime()` TZ, юзати `vi.stubEnv('TZ', 'Europe/Kyiv')`. Правило: НІКОЛИ не змішувати UTC-arithmetic з Kyiv-UI/DB без round-trip через Intl.DateTimeFormat.

---

### 2026-09-03 — Dynamic Prisma include-builder: parent-leaf + parent.child.leaf → PrismaClientValidationError (Bug #617) — backend / dynamic-query / metadata-driven

**Сигнал:** білдер будує Prisma `include`-дерево з метадата-конфігу (report-builder, dynamic search, saved views) з dot-path полями. Комбо коли ОДИН родич (`good`) юзається І як leaf (`good.name` → select), І як шлях до вкладеного (`good.brand.name` → include) → `{ good: { select:{name:true}, include:{brand:{select:{name:true}}} } }` — **Prisma не приймає include+select на одному рівні** → `PrismaClientValidationError` → 400 без деталей (Bug #618). Автор писав хопи ізольовано, unit на ОДИН шлях проходив; комбо у registry норма (groupBy=good.name + good.brand.name).
**Grep/probe:**

```bash
grep -rn "select:.*true\s*}" apps/api/src --include="*.builder.ts"
```

Комбінаторний контракт-тест: пара `[parentA.leafA, parentA.subrel.leafB]` (не по одному; shape-тест «green by shape, red by Prisma runtime»). Registry-driven fuzz: всі пари/трійки полів з груп (leaf-root/parent/grandchild) → `POST /run`. Симптом: 400 «Некоректні дані запиту» на POST /dynamic-endpoint = завжди баг серверного білдера (disguised 500, клієнт не обходить DTO whitelist).
**Фікс:** НЕ змішувати include+select на одному рівні — relation-branch з leaf-ами І subrel описувати ТІЛЬКИ через `select` (nested select — Prisma-canonical); кореневий рівень лишається `include` (щоб не тягнути всі скаляри). Regression: unit з РЕАЛЬНОЮ Prisma-формою + live-контрактний тест.
**Severity:** CRITICAL — динамічні запити ламаються тихо, user бачить «Некоректні дані запиту».
**Де шукати ще:** `**/*.builder.ts`, `**/search.service.ts` (relation-поля), `**/saved-view*.ts`, `prisma.X.findMany({include:{...,select:...}})` з динамічними ключами.

---

### 2026-09-03 — PrismaClientValidationError мовчки ковтається у 400 без message-логу (Bug #618) — backend / observability / dev-DX

**Сигнал:** exception-filter має `else if (exception instanceof Prisma.PrismaClientValidationError) { return 400 "generic message" }` **без** `logger.warn/error`. Prisma-повідомлення (реальна причина «Please either use include or select, but not both») відкидається → розробник бачить лише «Некоректні дані запиту». У 100% випадків це помилка серверного білдера (клієнт передає DTO-whitelisted config), тобто прихована 500 — disguised 500, логи критичні.
**Grep:**

```bash
grep -rn "PrismaClientValidationError" apps/api/src   # чи є logger.warn/error з exception.message? тільки throw BadRequestException('generic') = bug
```

**Фікс:** у catch-branch `logger.warn(\`${method} ${url}: ${lastNonEmptyLineOf(exception.message)}\`)`— ОСТАННІЙ непорожній рядок (Prisma кладе причину у кінець; перед ним header+spacer). Regression: unit з багато-строковим Prisma-текстом + spy на`logger.warn`.
**Severity:** LOW user-facing, HIGH як тестерська DX/observability пастка (15 хв діагностики #617 замість 1).
**Де шукати ще:** усі `else if (exception instanceof Prisma.\*)`у filter'ах — логувати`exception.message`навіть при 4xx;`mapPrismaErrorToHttp`(Bug #451-подібні мапінги — чи не втрачається`meta.target`). Правило: будь-який exception з серверної логіки (не user-input class-validator) має лишити слід у логах.

---

### 2026-09-04 — Хардкоджений label службової колонки колізує з користувацьким полем даних тієї ж назви (Bug #626) — frontend / dynamic-table / UX-clarity

**Сигнал:** динамічна таблиця-конструктор (Report Builder / pivot / будь-який `cols.map(c => <th>{c.label}</th>)`), де движок домішує ПОРУЧ службову/обчислену колонку з **хардкодженим label-літералом** (`<th>Кількість</th>`, count/subtotal/rank), а користувач має право вибрати у ту ж таблицю поле даних із таким самим `label`. Головний сценарій фічі (Товар + Кількість) → дві сусідні колонки «Кількість»: перша = сума `quantity`, друга = merge-count `__mergedCount`. Дані і вирівнювання коректні — лише назви колізують.
**Причина виникнення:** нова обчислена колонка (merge-count) отримала label дослівно скопійований з grouped-режиму («Кількість» = node.count, розмір групи — там доречно). У плоскому merge-режимі поруч стоїть поле даних `quantity` з тим самим label «Кількість» у 6+ сутностях реєстру. Автор мислив службову колонку ізольовано, не врахувавши що юзер поставить поруч однойменне поле. Code review перевіряє colspan-вирівнювання (thead==body==tfoot==colSpan) — воно ідеальне, тож review дає 0 findings; семантична колізія header-назв поза його чеклістом.
**Підхід до виявлення:** ЛИШЕ жива eyes-on перевірка (§5.4) головного сценарію фічі — прогнати саме той user-path, заради якого зроблено коміт (тут: Товар+Кількість→Сформувати), і подивитися на скрін ОЧИМА. Статичний grep-бекап: `grep -rnE "<th[^>]*>\s*(Кількість|Всього|Разом|Сума|Ціна)\s*<" apps/web/src/app --include="*.tsx"` → для кожного хардкод-літерала перевірити чи є registry-поле з тим же label (`grep -n "label: '<текст>'" apps/api/src/modules/*/registry*.ts`). Aggregate-колонки не колізують (мають Σ/сер./мін./макс. префікс).
**Підхід до фіксу:** дати службовій колонці назву, що НЕ збігається з жодним полем даних (merge-count → «Склеєно»); коли одна й та сама колонка має різний сенс у двох режимах — зробити label умовним за режимом (`{hasGroups ? 'Кількість' : 'Склеєно'}`, grouped=node.count лишає історичну назву, flat-merge=однозначна «Склеєно»). Не чіпати export якщо він емітить окрему summary-схему.
**Severity:** MEDIUM — дані коректні, але дублювання назв вводить в оману саме у головному сценарії фічі, заради якого зроблено коміт.
**Де шукати ще:** будь-яка pivot/matrix-таблиця де юзер вибирає колонки, а движок домішує обчислені (count/subtotal/rank/percent) з фіксованими назвами; фінансові/складські звіти з «Всього»/«Разом» службовими рядками поряд із однойменними полями. Мета-урок: жива перевірка МАЄ ганяти саме той user-path з фідбеку (з тими самими полями), а не абстрактний «якийсь звіт» — колізія проявляється лише на конкретній комбінації полів.

### 2026-09-06 — BullMQ delivery-status FSM на DB-записі: enqueue-gate + QUEUED→DONE/SKIPPED/FAILED anti-flicker (Bugs #661-#664) — backend / queue / status-machine / test-gap

**Сигнал:** фіча що додає nullable status-enum на DB-запис (`Payment.fiscalStatus`, `Notification.deliveryStatus`, `Receipt.status`) який пише 2 сторони: (а) `service.create()` ставить QUEUED **під гейтом** (`willX = config?.requiresX === true` → QUEUED-or-null) і потім `queue.add(...).catch(...)`; (б) `@Processor`/`@OnWorkerEvent('failed')` рухає QUEUED→DONE/SKIPPED/FAILED. Комітиться з 0-1 тестом на CAS/idempotency, але **самі status-переходи не покриті**. Чотири load-bearing точки регулярно лишаються без regression-guard.
**Причина виникнення:** автор фокусується на happy-path (чек пробито → DONE) і на вже відомому патерні (idempotency guard Bug #346), а status-FSM сприймає як «очевидний». Але кожна гілка — окремий інваріант: (1) **enqueue-гейт** (фіскалізувати ЛИШЕ requiresFiscal-методи, інакше чек на кожну готівку); (2) **enqueue-failure fallback** (Redis лежить → `.catch()` → QUEUED→FAILED, інакше платіж завис навічно у QUEUED без job-а — offline-first вимагає щоб фінансова операція вже повернулась); (3) **skip-конфіг → SKIPPED** (ПРРО вимкнено на філії → пишемо SKIPPED, не throw, не QUEUED-навічно); (4) **anti-flicker** — FAILED ЛИШЕ на термінальній спробі (`job.attemptsMade >= job.opts.attempts`), інакше статус «мигає» FAILED↔QUEUED між 288 ретраями. Unit-мок Prisma/Queue → CI зелений навіть коли будь-яку гілку прибрали.
**Підхід до виявлення:** grep `grep -rnE "fiscalStatus|deliveryStatus|\.add\(.*\).catch" apps/api/src/modules --include="*.service.ts"` + `grep -rn "@OnWorkerEvent\('failed'\)" apps/api/src/modules --include="*.processor.ts"`. Для КОЖНОГО status-writer перевірити наявність тесту на: (а) gate true/false/unknown-config (3 гілки, кожна асертить `queue.add` called/not + `create.data.status`); (б) `queue.add.mockRejectedValue` → `service.create` **resolves** (не throw) + `payment.update({status:'FAILED'})`; (в) skip-конфіг → `payment.update({status:'SKIPPED'})` (не лише «fetch не викликано»!); (г) `onFailed` ДВІ гілки — `attemptsMade < attempts` → `update` NOT called; `attemptsMade >= attempts` → FAILED. 0 таких тестів на будь-яку точку = gap.
**Підхід до фіксу:** дописати regression-guard на кожну непокриту гілку, **mutation-verify** дві найкритичніші: занейтралізувати gate (`willX = true`) → false/null-тести падають; прибрати `if (attemptsMade < attempts) return` → проміжний тест падає. Для enqueue-failure тесту переконатись що мок `$transaction` викликає callback (щоб `create` реально спрацював) і що `payment.update` теж мокнутий (щоб `.catch(()=>undefined)` не ковтав реальну помилку тесту). verify/external-call сервіс що повертає `{valid, ...}` — окремо асертити що **креди не в поверненому об'єкті** (`JSON.stringify(res)` не містить ключа) на success І error.
**Severity:** HIGH для gate + enqueue-failure (фінансовий інваріант: помилкові чеки / завислий QUEUED); MEDIUM для skip-SKIPPED + anti-flicker (UX/observability, дані цілі).
**Де шукати ще:** будь-який `@InjectQueue` з парним DB-status полем — `checkbox`/`fiscal`, `sms`/`notifications`, `webhooks`, `prro` (attempts=288), `loyalty.queueEarn`, `followup`. Особливо після коміту `feat(...): add <status>Status enum` + міграція `ALTER TYPE`. Парне з Bug #346 (idempotency — інша грань того ж processor).

### 2026-09-06 — Тонкий external-API HTTP-клієнт (fetch-wrapper) відвантажується з 0 тестів; recipe mock-global-fetch + token-never-logged (Bugs #683-#687) — backend / external-api / security / test-gap (HIGH)

**Сигнал:** новий `*.client.ts` / `*.gateway.ts` що інкапсулює всі виклики зовнішнього API (Checkbox/ПРРО/SMS/OAuth/postal) через `fetch()` — типово має SSRF-guard + `redirect:'manual'` + `AbortController` timeout + reject-3xx + auth-header (Bearer на одних методах, alternate header типу `X-License-Key` на sign-in). Комітиться з **0 тестів на цей файл** (unit-мок Prisma/Queue у parent-processor spec НЕ виконує цей код — fetch реальний). Парний lifecycle-сервіс (`*-shift.service`, token/session-менеджер) теж часто 0 тестів. Класична пастка: «клієнт — тонка обгортка, нема що тестувати» — але саме тут живуть security-інваріанти (SSRF-before-fetch, 3xx→reject, 401-mapping, timeout-abort) і auth-контракт (правильний header на правильному методі).

**Причина виникнення:** розробник вважає HTTP-клієнт «тонким» (лише URL+headers+JSON), а processor-spec «покриває флоу». Але processor мокає весь клієнт (`{ sellReceipt: vi.fn() }`) → жоден рядок клієнта не біжить у CI. SSRF/timeout/error-mapping невидимі. Плюс токен, прочитаний клієнтом, легко протікає у лог parent-processor-а.

**Підхід до виявлення:** `git diff` дає новий `*.client.ts`/`*.gateway.ts` з `fetch(` І нема `*.client.spec.ts` → gap. Grep `for f in $(git diff HEAD~N --name-only | grep -E 'client\.ts$|gateway\.ts$'); do [ -f "${f%.ts}.spec.ts" ] || echo "NO SPEC: $f"; done`. Так само для token/session-lifecycle сервіса (`ensureToken`/`refreshToken`/`signIn`).

**Підхід до фіксу (recipe):**

- **mock global fetch:** `vi.stubGlobal('fetch', fetchMock)` + helper `OK(body, status)` що повертає `{status, ok, text: () => Promise.resolve(JSON.stringify(body))}` (не повний Response). `afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); })`.
- **auth-контракт per method:** асертити `fetchMock.mock.calls[0][1].headers` — Bearer=token на authed-викликах, alternate header (X-License-Key) на sign-in, І **`Authorization` undefined на sign-in** (щоб не переплутали). Правильний endpoint-URL кожного методу.
- **SSRF-before-fetch:** для localhost/169.254-metadata/RFC1918/non-http URL → `expect(client.call(...)).rejects` + `expect(fetchMock).not.toHaveBeenCalled()` (доводить що guard ПЕРЕД fetch, не після).
- **3xx→reject:** цикл по [300,301,307,308,399] → кожен reject (SSRF-tampering); + `redirect:'manual'` завжди у опціях; 401→спец-error-клас (для re-sign-in у processor).
- **timeout:** happy-тест — `signal instanceof AbortSignal` у опціях; abort-тест — `fetchMock.mockImplementationOnce((_u,opts)=>new Promise((_,rej)=>opts.signal.addEventListener('abort',()=>rej(new DOMException('aborted','AbortError')))))` + `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync(TIMEOUT+1)`.
- **cents/money конверсія:** `Math.round(amount*100)` з fraction-input (35.2→3520, не 3519) — anti-IEEE-754.
- **token-never-logged:** у parent-processor spec замокати ВСІ рівні logger (`for lvl of ['log','debug','warn','error'] proc.logger[lvl]=(...a)=>logged.push(...a)`) → `expect(JSON.stringify(logged)).not.toContain(secretToken)` для success І для 401→refresh (обидва токени); sanity `logged.length>0`.
- **секрет не у DTO:** `expect(JSON.stringify(dto)).not.toContain(secret)` + `expect(dto).not.toHaveProperty('<secretField>')` на КОЖНОМУ DTO-виводі (open/close/getCurrent).

**Підхід до mutation-verify (token-lifecycle boundaries):** skew-межа кешу токена (`expiry > now+SKEW`) — тест «expiry рівно на межі → re-sign-in» + «expiry на +1ms за межею → кеш»; мутація `>`→`>=` валить перший (протухлий токен прийнявся б за валідний → 401-цикл). tenant-scope refresh (`updateMany where{id,orgId}`) — cross-org id→no-op→NotFound; мутація дропу orgId валить (безумовна інвалідація чужого токена). P2002-recovery — winner→OK + winner-null→rethrow (доводить що catch не ковтає безумовно).

**Severity:** HIGH — external-API клієнт несе SSRF + auth + money + secret одночасно; 0 тестів = увесь клас невидимий CI. Token-log-leak — HIGH (секрет у production-логах).

**Де шукати ще:** будь-який `*.client.ts`/`*.gateway.ts`/`*.provider.ts` з `fetch`/`axios` до зовнішнього хоста; token/session-lifecycle сервіси (`ensureX`/`refreshX`/`signIn`/`getValidToken`) з skew/expiry-логікою; парні processor-спеки що мокають клієнт цілком — перевірити чи клієнт має ВЛАСНИЙ spec. Парне з Bug #273 (SSRF paired defense), #652 (secret at-rest), #661-#664 (BullMQ status-FSM).
