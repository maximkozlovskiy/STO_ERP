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
- [ ] **Bug #733 (HIGH): документ ЗБЕРІГАЄ джерело руху (`cashRegisterId`/`bankAccountId`/`warehouseId`) але при провід-переході НЕ створює сам рух → guard оминається за пропуском.** «Єдина точка руху» тримає guard, grep прямого bypass чистий — але провід-крок (`confirm/pay/post`) пише лише похідний settlement, а первинний рух джерела не створюється зовсім. Тут: `SupplierPayment.confirm()` для `CASH_REGISTER` не викликав `cash.createOperation(OUT)` → готівка не залишала касу + overdraft-guard мертвий. Детектор: для кожної моделі з FK на register/account/warehouse перевірити чи confirm/pay РЕАЛЬНО кличе `createOperation`/`createMovement` для ЦЬОГО джерела; крос-чек — чи є enum-reason/movement-type який НІХТО не пише (`grep` дає лише enum-визначення = сирота = відсутня інтеграція). Fix: рух у ТІЙ САМІЙ tx що й settlement (нестача → 400 + rollback усього). ⚠️ unit-специ зелені (мокають лише settlements) — потрібен live-probe: cash-оплата при порожній касі має дати 400.
- [ ] **Bug #688 (CRITICAL money): reconcile/finalize-гілка створює money-запис без `@unique`-лінку на джерело → sequential double-create.** Async-confirm money-flow (QR/gateway) з наміром: CAS→PAID, потім окремий `payments.create`, потім окремий `intent.update({paymentId})`. Три write НЕ атомарні → якщо create вдався а link-write упав, намір лишається `PAID+paymentId=null` → наступний reconcile-poll робить `create` ВДРУГЕ = double-charge (jobId single-flight не рятує — вікно послідовне). Grep: `grep -rn "reconcile\|finalize\|paymentId.*null" apps/api/src/modules/**/*.processor.ts | grep -v spec` — для кожного money-`create` у такій гілці перевірити чи є (а) `@unique` колонка-лінок на джерело у money-таблиці, (б) pre-create `findFirst({orgId,<link>})` guard, (в) P2002-recovery. Fix: `@unique` лінок (additive nullable міграція) + pre-check + P2002→relink. Test+mutation: «create-succeeds-then-link-fails» → assert no second create (вимкнути pre-guard→падає). Severity CRITICAL (тихий double-charge, без cap).
- [ ] **Bug #629: похідне money × дріб-коефіцієнт / reduce-Σ / різниця сум БЕЗ roundMoney, що покидає систему сирим (export/JSON).** Множення грошей на дріб (`Number(x) * RATIO`, напр. `LABOR_COST_RATIO=0.4` → `3520.30*0.4=1408.1200000000001`), Σ у JS-`reduce`, або різниця двох сум (`invoiced - purchases=66.77000000000001`) — гарантований/ймовірний IEEE-754 дрейф. Маскується `fmt()` на екрані, але **емітиться СИРИМ у CSV/XLSX/PDF-експорт (без fmtMoney — для XLSX number-детекту) і у JSON API-відповідь** (mobile/sync/зовнішні клієнти). Grep: `grep -rnE "Number\([^)]*\)\s*[*/]" apps/api/src/modules/{reports,completion-acts,xlsx}` + `grep -rnE "reduce\(\(s.*\+.*(amount|balance|revenue|total|cost|vat)"`. Для кожного — чи результат покидає систему (export/JSON)? Fix: `roundMoney()` на КОЖНЕ похідне money-поле (НЕ на %/count/hours). Live-guard: report endpoint з фракційними даними → `round(v*100)/100===v` для кожного money-поля. Severity LOW-MEDIUM (не stored/balance, але user-visible float у фіндокументі). Родич completion-acts PDF float (f7a935db). ⚠️ report-сервіси часто мають 0 unit-тестів → закрити test-gap разом із фіксом.
- [ ] **Bug #745 (MEDIUM-HIGH): side-effect на «X досяг статусу S» доданий на ОДИН шлях, пропущений на ДРУГОМУ FSM-шляху до S.** Money/inventory side-effect (realized FX, нарахування, авто-документ) на подію-статус реалізований лише там де подія «природно» настає (напр. `payments.service`→invoice PAID), але S досяжний ЩЕ й через ручний `X.service.transition(S)` (FSM-мапа), bulk/import, cron. Другий шлях фічу не отримав → інваріант тихо порушено (tsc/unit/review зелені бо дивляться шлях-1). Тут: FX-хук Фази 4 лише у payments.service; `invoices.service.transition(PAID)` (Bug #675 mirror-PAYMENT) курсову різницю не визнавав → іновалютний standalone з частковими оплатами + ручний PAID лишав base-залишок Σчасткові×(r_doc−r_pay)≠0. Детектор: `grep -rn "status:\s*['\"]\?<S>\|newStatus\s*===\?\s*['\"]\?<S>" apps/api/src/modules --include=*.service.ts | grep -v spec` — КОЖЕН унікальний writer статусу S мусить емітити side-effect або мати причину. Крос-чек `<X>_TRANSITIONS`: кожен `transition(S)` — кандидат-пропуск. Fix: дублювати хук (з idempotency count-guard + skip-умовами) або спільний метод для обох шляхів. Severity MEDIUM-HIGH. Де ще: WO COMPLETED (transition + bulk), invoice PAID (payments + invoices.transition + overdue-processor), PO RECEIVED, loyalty, авто-архівація. Парне #733/#688.
- [ ] **Bug #743: multicurrency-aware ЕКРАН + non-aware CSV/XLSX/PDF-експорт — сира per-currency сума у одну «amount»-колонку без валюти й без base.** Коли фіча додає валюту (`currencyCode`/`amountBase`) у row-модель, on-screen список зазвичай ОНОВЛЮЮТЬ (сума у валюті + base-підрядок + символ), а CSV/export-хендлер у ТОМУ Ж компоненті — НІ (лишається з до-мультивалютної версії: `['Дата','Тип','Сума',...]` → кладе сирий `row.amount` без коду валюти й без `amountBase`). 100 USD і 4150 UAH у колонці = `100`/`4150`, нерозрізнювані → Σ колонки безглузда. Клас #629 (сире money покидає систему), але корінь інший — не float, а **змішування ОДИНИЦЬ (валют)**; review часто ловить backend base-облік і пропускає frontend-export. Grep (frontend): для кожного компонента, що має І multicurrency-display (`amountBase != null`/`currencyCode`) І CSV/export (`escapeCsvCell`/`buildCsv`/`new Blob([csv`/`xlsx`) — `grep -rlnE "amountBase|currencyCode" apps/web/src/**/*.tsx` ∩ `grep -rlnE "escapeCsvCell|Blob\(\[.*csv|\.xlsx" apps/web/src/**/*.tsx` → у перетині перевірити header/рядок експорту: чи є колонка «Валюта» + окрема base-колонка? Fix: додати колонку валюти (`row.currencyCode ?? baseCode`) + окрему base-колонку (`row.amountBase ?? row.amount`; історичні = base) — base-колонка єдина коректно-підсумовна. Severity MEDIUM (user-visible фінекспорт змішує валюти; stored balance завжди у base → не corrupts). Де ще: payments/settlements/cash/invoice/PO-експорти; будь-який `exportReport`/`buildCsv`/xlsx-емітер після додавання валюти у агрегат.

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
- [ ] **Fail-closed guard судить ПРИСУТНІСТЬ токена, не його ФОРМУ → негація обходить (Bug #721):** будь-який centralized guard-предикат (tenant-isolation `whereHasTenantScope`, RBAC where-injector, soft-delete-фільтр), що вирішує «where несе потрібний токен» через `where[t] !== undefined` / `t in where` / `!!where[t]` — обходиться негативним/діапазонним фільтром на тому ж полі. Prisma-токен ≠ лише скаляр рівності: `{orgId:{not:X}}`/`{notIn:[...]}`/`{gt/gte/lt/lte}` СЕМАНТИЧНО матчать ЧУЖІ tenant-и, `{orgId:null}` проходить (null≠undefined), а `NOT:{orgId:X}` під composite-key-scan хибно рахується «ключ з orgId». Guard тихо ПРОПУСКАЄ замість throw → крос-tenant leak. Grep: `grep -rnE "!== undefined|\bin\b.*where|Object\.keys\(where" apps/api/src/**/*guard*.ts apps/api/src/**/*tenant*.ts` → для кожного «токен присутній»-предиката перевірити чи розрізняє позитивну рівність (scalar/`{in:[...]}`/`{equals}`) від негації/діапазону/null; чи виключає логічні ключі {AND,OR,NOT} з composite-scan. Mutation-проба: `whereHasTenantScope({orgId:{not:'x'}})`/`({NOT:{orgId:'x'}})` → якщо `true` = leak. Fix: `isPositiveTenantBinding(v)` — scope лише за рівністю/`{in:[non-empty]}`/`{equals:scalar}`; `{not}`/`{notIn}`/діапазон/`null`/`{in:[]}`/невідома-форма → false (fail-closed); composite-scan skip {AND,OR,NOT}; зберегти легіт cross-org `{token:{in:[...]}}`. Regression: unit-матриця (leak-форми→throw, positive→pass) mutation-verified + live-DB integration (мокнуті юніти НЕ виконують guard-екстеншн; треба реальний guarded-client). Парний gap: integration-spec без delete/deleteMany/groupBy/upsert-throw кейсів (кожна операція з GUARDED_WHERE_OPS має live-покриття). Severity CRITICAL (латентний — тригериться майбутнім негованим orgId-фільтром). Де ще: RBAC branch-guard, org-scoped cache-key builder, будь-де де `NOT`/`{not}` торкається tenant/authz-поля.
- [ ] **Публічний/unauth endpoint читає tenant-scoped модель без `runUnscoped` → fail-closed guard кидає 500 (Bug #730):** ДЗЕРКАЛО Bug #721 (там guard хибно ПРОПУСКАВ; тут — правомірно кидає, але caller забув легалізувати доступ). Будь-який `@Controller`-метод БЕЗ `@UseGuards(JwtAuthGuard)` (public booking-віджет, share-token, `/setup`, webhook-callback, публічний прайс) що читає tenant-scoped модель (у TENANT-списку `prisma.service.ts`, поза `TENANT_EXEMPT_MODELS`) з `where` БЕЗ `orgId`/`branchId` — Prisma `$extends` tenant-guard кидає `TenantIsolationError` → **500 на кожен запит** (весь публічний флоу мертвий). Причина: без JWT ambient `orgId=undefined`, а orgId часто РЕЗОЛВИТЬСЯ саме з цього запиту (`branchId → branch.orgId`) — курка-яйце. Grep: `grep -rLn "UseGuards" apps/api/src/modules/**/*.controller.ts` → у public-контролерах знайти `this.prisma.<tenantModel>.find*` / `this.service` що читає без orgId; або прямо `grep -rn "prisma\.\(garageBranch\|organisation\|.*\)\.find" apps/api/src/modules` у сервісах, які кличуть public-роути. Live-проба (найнадійніша): `curl` кожен public GET/POST → 500 з `{"message":"Внутрішня помилка сервера"}` + у логах API `TenantIsolationError: <op> на <Model> без tenant-фільтра`. Fix: обгорнути ЛЕГІТИМНИЙ глобальний read у `runUnscoped(async () => await this.prisma...)`. ⚠️ **`await` УСЕРЕДИНІ scope критичний** — повернути lazy `PrismaPromise` назовні (`runUnscoped(() => prisma.find(...))`) НЕ працює: реальний DB-виклик і guard-hook виконаються ПІСЛЯ виходу з ALS-scope → bypass втрачено → throw лишається. Регресія: E2E/contract кейс на кожен public endpoint (200 + валідне тіло); unit не ловить (мок-Prisma не проганяє `$extends`-guard). Severity HIGH (публічна фіча повністю непрацездатна; CRITICAL якщо це checkout/оплата). Де ще: усі `@Controller` без `JwtAuthGuard` що дотягуються до tenant-моделей — booking (fixed), setup-status, публічні прайс/каталог, share-token документи, gateway webhook-callback-и що резолвлять org з payload.
- [ ] **Write-time «X налаштовано?»-guard розходиться семантикою з runtime-резолвером X (Bugs #731/#732):** `assert<Provider>Config`/`assert<Gateway>`/будь-який guard що перевіряє «провайдер/рахунок/кред налаштований» ПЕРЕД записом прив'язки МУСИТЬ вживати ту саму семантику «валідно», що й resolve-шлях у runtime. Класична пастка — JSON-в-рядку: guard `if (!cfg.credentials)` (сира truthiness рядка) пропускає `"{}"`/`'{"k":""}'`/`"null"`/битий JSON, а резолвер `hasCreds(parseCreds())` парсить і вимагає непорожнє значення → повернув би null → тиха нерезолвабельна прив'язка (чек навічно QUEUED / no-op). Grep: `grep -rnE "assert[A-Z][A-Za-z]*(Provider|Config|Gateway)|!.*\.credentials\b" apps/api/src/modules/**/*.service.ts | grep -v spec` → для кожного знайти парний `resolve*`/`hasCreds`/`parse*` і звірити 1-в-1; підозра коли одна гілка читає raw truthiness JSON-колонки, інша парсить. Родич #732: guard кидає 400 на «вимкнули feature»-переході (isFiscal→false лишає успадкований provider) замість авто-очищення залежних полів — реконсилюй у write (`data.provider=null` коли `!isFiscal`), а не throw. Fix: спільний хелпер semantics або виклик самого резолвера. Регресія: unit з погранич. конфігами (`"{}"`/порожні/битий JSON→400; валідний→pass). Severity MEDIUM (HIGH якщо блокує фіскальне зобов'язання/гроші без видимої помилки). Де ще: payment-gateways activate/resolve PAYMENT, notification-channel token guard vs send-resolver, delivery-провайдери, будь-яка `@unique` FK-прив'язка де write перевіряє існування рядка а use — придатність.
- [ ] **Multi-`updateMany` «exclusive mutation» у `$transaction` — orgId у КОЖНОМУ where (Bug #657):** будь-який метод що ексклюзивно перемикає стан (активним лишається лише 1) через 2+ `updateMany` у `$transaction` (напр. «вимкнути всі інші → увімкнути цей», `provider: { not: code }` + `provider: code`) МАЄ нести `orgId` (і `branchId` де застосовно) у **кожному** where-клозі, не лише у prep-`findFirst`. Prep-guard (`findFirst({ id, orgId })`) валідує branch/parent, АЛЕ самі `updateMany` фільтрують по бізнес-полю (`provider`/`type`/`isDefault`) — якщо хоч один where втратить `orgId`, mass-update зачепить рядки ЧУЖОЇ org з тим самим branchId/business-key. `@@unique([branchId, key])` НЕ рятує (updateMany не через unique). Grep: `grep -rnE "\\\$transaction\(\[" apps/api/src/modules --include="*.service.ts" -A6 | grep -A6 "updateMany"` → для кожного updateMany-у-транзакції перевірити `orgId` у where. Fix: додати `orgId` у кожен where. Regression-guard: in-memory-store spec що моделює updateMany → активація в org-1 з рядком org-2 (той самий branchId+key) → рядок org-2 НЕДОТОРКАНИЙ (обидва прапорці); плюс assert обидва where несуть orgId. Severity HIGH (cross-org data corruption на масовому write). Де ще: default-flag toggles (`setDefault*` що скидає isDefault на інших), status-exclusive switches, priority-reorder через bulk updateMany.
- [ ] **Frontend «only-one-active» toggle-тріада (Bug #657):** UI де активним може бути лише 1 із набору (провайдер/метод/стратегія) через per-item Switch МАЄ мати всі три захисти: (1) **gate** у toggle-handler — увімкнути можна лише item що вже активний-сумісний, інакше setError+return без запиту; (2) **empty-state guard** перед POST activate — якщо item не має конфігу/під-рядків (`items.some(x => x.key === code)` === false) → повідомлення «спершу налаштуйте», НЕ POST (бек ідемпотентний no-op → UI показав би хибний «активовано» + Switch відскочив); (3) **disabled-стан** — Switch активного item disabled (нема повторної/зворотної активації), Switch неактивного sub-toggle disabled коли є інший active. Всі три треба **mutation-verified** (нейтралізувати guard → тест падає, інакше fake-green). Grep: `grep -rn "activeProvider\|active[A-Z]\|isActive.*===\|only one\|лише один\|ексклюзивн" apps/web/src --include="*.tsx" -l`. Severity HIGH якщо тихий регрес порушує бізнес-інваріант (2 активні провайдери → resolveConfig змішує → неконтрольований fallback).
- [ ] **Узагальнення поля до типізованого locator + per-channel selection + структуровані креди (Bugs #658-#660):** будь-яка фіча що (а) узагальнює адресат з одного типу до багатотипного (`phone`→`recipient` де тип залежить від каналу), (б) вводить per-channel/per-item селектор `SET.has(x.channel) ? valueA : valueB`, (в) додає provider зі структурованими кредами серіалізованими JSON-ом в одне поле (`apiKey=JSON.stringify({host,port,user,pass})`) + multi-field UI-форму — потребує парних тестів на КРИТИЧНІ перехрестя. **Селектор:** тест змішаного набору `[typeA,typeB]` × `{a}`(B відкинуто)/`{b}`(A відкинуто)/`{a,b}`(обидва, **recipient КОЖНОГО кроку СВОГО типу** — SMS без `@`, EMAIL з `@`)/`{}`(job не ставиться). Mutation: замінити селектор на `a ?? b` → змішані падають (інакше телефон тече у SMTP `to` → провал усіх email). **Mask-helper:** email/короткий/порожній/no-@ входи (навіть module-private — через публічний метод що логує). **Структуровані креди (UI):** показ multi-field форми (не single-token), `credsReady`=усі обов'язкові поля, save-payload=очікуваний JSON (парсити+`toEqual`), дефолти (порожній порт→587), verify той самий JSON, негатив: інший provider лишає single-token. Mutation: зламати `buildApiKey` → save/verify падають. **Persist:** assert пишеться НОВА колонка (`recipient`), не стара (`phone`). Grep: `grep -rnE "\.has\([a-z]+\.channel\)\s*\?|JSON\.stringify\(\{[^}]*host" apps/api/src apps/web/src --include="*.ts" --include="*.tsx"`. Severity HIGH (селектор/креди), MEDIUM (mask). By-design виняток: caller що передає лише підмножину адресатів (followup лише phone→EMAIL тихо skip) — підтвердити no-crash, задокументувати як intended, НЕ «фіксити».
- [ ] **FSM transition write-path persistence для new nullable row column (Bug #236):** sprint що додає `nullable colX?: TypeX` у row-модель (`PurchaseOrderLine`/`StockDocumentLine`/`InvoiceLine`/`WorkOrderPart`) + mapping `colX: l.colX ?? null` у `toDto` → у кожному `transition(STATE)` / `receive()` / `applyPricing()` / FSM-обчислювальному методі, де обчислюється resolved value (наприклад `lineUnitId = good.unitId`) і пропагується у side-effect resource (`inventory.createMovement(colX: lineUnitId)`/`stockMovement.create({ colX })`), ОБОВ'ЯЗКОВО має бути парний `tx.<rowTable>.update({ where: { id: line.id }, data: { colX: resolvedValue } })` для самого row, всередині $transaction. Інакше `findOne(id).lines[i].colX === null` назавжди → cross-resource inconsistency: history (movements) має X, current state (line) має NULL → audit/sync/export ламається. Symmetric-write для Bug #232 (read-side missing include). Grep: `grep -rnE "[a-z]*Id:\s*l\.[a-z]*Id\s*\?\?\s*null" apps/api/src/modules --include="*.service.ts"` → для кожного match у відповідному `transition()`/`receive()`/`applyPricing()` шукати `tx.<row>.update.*data.*colX`. Severity HIGH (silent data integrity)
- [ ] **BullMQ processor idempotency guard (Bug #346):** кожен `@Process({ name: 'X', concurrency: N })` з external API call (`fetch`, `axios`, SMS, ПРРО/Checkbox) ТА `attempts > 1` ОБОВ'ЯЗКОВО читає відповідний DB-запис ПЕРЕД external call і перевіряє результат вже записаний (`fiscalReceiptId`, `sentAt`, `deliveredAt`). Без guard: transient DB error після успішного зовнішнього виклику → BullMQ retry → дублікат side-effect (2 фіскальних чеки, 2 SMS). Grep: `grep -rn "async handle" apps/api/src/modules/ --include="*.processor.ts" -l | while read f; do grep -q "fetch(\|axios\." "$f" && ! grep -q "findFirst\|findUnique" "$f" && echo "MISSING: $f"; done`. Регресія-guard: spec `it('пропускає якщо result-field вже встановлено')` + `it('пропускає якщо запис не знайдено')`. Severity: MEDIUM для ПРРО (fiscal compliance risk); LOW для webhook retry (acceptable by protocol).

- [ ] **Dead-feature integration audit (Bugs #267, #268):** для КОЖНОГО `@Injectable` сервісу з queue/processor companion (`@nestjs/bull`, `@Processor`, `@InjectQueue`) — перевірити чи real callsite викликає його з payments/invoices/work-orders/settlements flow. Grep: `grep -rl "InjectQueue\|@Processor" apps/api/src/modules --include="*.ts"` → для кожного service-метода: `grep -rln "\.<method>(" apps/api/src --include="*.ts" | grep -v "spec\|<own-module>"` → якщо count=0 → bug. Парний сигнал: UI tab/sidebar/settings для фічі АЛЕ нема telemetry/trigger. Severity HIGH якщо feature розрекламована користувачу (`loyalty.queueEarn` ніколи не викликається з payments → бали не нараховуються); MEDIUM якщо admin/internal (`batch.consumeBatch` ніколи з inventory WRITEOFF → cost-method не застосовується). Фікс: додати виклик у trigger service (з `.catch(warn)` для non-blocking) + import відповідного Module у trigger Module + DI injection

- [ ] **Self-re-enqueue polling: domain-service enqueue-гілки + clamp + zombie-job без прямих тестів (Bugs #696-#698):** нова polling-інтеграція зовнішнього API (не webhook) має 3 частини — (1) domain-service `create/update` що enqueue-ить при появі/зміні поля, (2) `@Processor` self-re-enqueue з delay+термінал+cap, (3) `pollDelayMs` clamp з налаштувань. Специ типово покривають лише (2). Grep: `grep -rln "enqueueInitial\|reEnqueue\|pollDelayMs\|self-re-enqueue\|removeOnComplete" apps/api/src --include="*.ts" | grep -v spec` → для кожного перевірити прямі тести на: **(а) domain-service** — create з полем→`status:PENDING`+enqueue РІВНО раз (mutation: прибрати `if(field)` guard→падає); create без поля→null+НЕ enqueue; trim/whitespace normalize; update новий→PENDING+`raw:null`+enqueue; update скид(null/'')→усі scalar null+НЕ enqueue; update той самий→жоден scalar-write+НЕ enqueue (`data not.toHaveProperty('field')`); update undefined→не чіпати; поза-DRAFT-guard ПЕРЕД field-обробкою. **(б) clamp напряму** (реальний instance, мок settings) — `MIN-1→MIN`,`MAX+1→MAX`,`NaN/Infinity→default`,`throw→default` (mutation: прибрати кожен `Math.min/max`-край→падає). **(в) zombie-job** — enqueueInitial+reEnqueue шлють ОДНАКОВИЙ `jobId`; `job.data not.toHaveProperty('<field>')`; getStatus викликано полем з `findFirst`(БД). Severity HIGH (тихий регрес трекінгу при рефакторингу). Where else: nova-poshta-polling, monobank/checkbox polling, nbu-rate-fetch, будь-який `getOrganisationSettings`-derived clamp.

- [ ] **Hardcoded document-number у auto-create обхід DocumentNumberService (Bug #348):** будь-який `tx.<Model>.create({ data: { number: '<literal>', ... } })` де `<Model>` має згадку у `DocumentNumberConfig` seed (`WORK_ORDER`, `INVOICE`, `PURCHASE_ORDER`, `STOCK_RECEIPT`, `COUNTERPARTY_AGREEMENT`...) — bug. Auto-create-flow (наприклад `service.create()` контрагента → авто-PURCHASE контракт) повинен використовувати ту саму систему нумерації що і ручний UI-flow (`createContract` через `documentNumberService.next()`), інакше monotonic-нумерація документів порушена. Grep: `grep -rnE "tx\.[a-z]+\.create\(\s*\{\s*data:\s*\{[^}]*\bnumber:\s*['\"]" apps/api/src/modules --include="*.service.ts"` — кожен literal-number у data-spread = bug. Виклик `documentNumberService.next()` робити ПЕРЕД `$transaction` (next() сам відкриває власний $tx з SELECT FOR UPDATE — nesting deadlock). Severity HIGH (feature розрекламована як «автоматично створюється документ», порядок номерів inconsistent).

- [ ] **Materialize-on-forward-transition без release-on-cancel/reverse (Bug #699):** будь-який sprint що додає МАТЕРІАЛІЗАЦІЮ дочірнього ресурсу на forward-переході (`confirm()`→create `CalendarSlot`; `approve()`→create reservation; `issue()`→create fiscal-doc; `activate()`→create schedule) — ОБОВ'ЯЗКОВО має ПАРНЕ звільнення того ресурсу у зворотному/скасувальному методі (`cancel()`/`reject()`/`void()`/`remove()`). Типова пастка: до спринту forward-метод НЕ матеріалізував нічого → cancel не мав що прибирати; спринт додає create на forward, АЛЕ забуває release на cancel → материалізований ресурс лишається `deletedAt:null` (активний) назавжди → блокує потужність (ліфт/склад/номер) без жодного live-parent. Симптом: скасування «з'їдає» місткість; фіча, що робилася ЩОБ зберегти місткість, натомість її втрачає на кожному cancel. Grep: `grep -rn "confirmedSlotId\|materializ\|\.createSlot(\|reservationId\|<link>Id" apps/api/src/modules/<mod>/*.service.ts` → для кожного forward-методу що пише link-колонку (`confirmedSlotId`/`reservationId`), перевірити чи cancel/remove ЧИТАЄ цю колонку і soft-delete-ить залінкований ресурс. Fix: cancel читає link ДО скасування → в одній `$transaction` soft-delete залінкований ресурс (`where: OR[{id:linkId},{parentSlotId:linkId}]` — покриває split-child) + скасування parent атомарно. Regression-guard (mutation-verified): (а) cancel БЕЗ link → child-updateMany НЕ викликано; (б) cancel З link → child-updateMany 1× з orgId+deletedAt:null; (в) обидва write у одній `$transaction`; мутація (прибрати release) → тест (б) падає. Severity HIGH (тиха втрата бізнес-потужності). Де ще: booking↔CalendarSlot, WO↔reservation, invoice↔fiscal-receipt, будь-яка нова `<parent>.confirm/approve` що materializes і має парний cancel/reject/void.
- [ ] **Soft-delete primary без auto-promote next sibling (Bug #351):** для КОЖНОЇ моделі з `isPrimary Boolean` / `isDefault Boolean` / `isMain Boolean` полем — `service.remove()` ОБОВ'ЯЗКОВО має auto-promote next sibling. Pattern: `(1) SELECT existing { id, isPrimary, <scopeFields> }`; `(2) $transaction: soft-delete X; if (existing.isPrimary) findFirst({<scope>, deletedAt:null, id:{not:id}}, orderBy:{createdAt:'asc'}) → update({isPrimary:true})`. Без promote: bizнес-інваріант «у scope завжди ≥1 primary якщо існують активні рядки» силентнo порушений. Downstream auto-selection logic (PO/WO create без contractId → findFirst orderBy isPrimary desc → випадковий non-primary) повертає неправильні значення. Grep: `grep -rnE "isPrimary\s+Boolean|isDefault\s+Boolean|isMain\s+Boolean" packages/database/prisma/schema.prisma | awk '{print $1}'` — для кожної моделі знайти `<module>.service.ts` `remove()`/`deleteX()` і перевірити наявність findFirst+update після soft-delete. Severity HIGH. Парне з Bug #226-#227 (frontend-side): backend може правильно promote, але frontend з optimistic-filter не знає → теж потребує refetch.

- [ ] **restore() вузла ієрархії з soft-deleted батьком → сирота у buildTree (Bug #734):** для КОЖНОЇ self-relation дерево-моделі (`parentId → self`) з каскадним `remove()` (soft-delete нащадків через `getDescendantIds`) — парний `restore(id)` що відновлює лише один рядок (`updateMany({id},{deletedAt:null})`) БЕЗ перевірки живості батька лишає вузол сиротою: `parentId` вказує на все ще soft-deleted батька → `findAll`(deletedAt:null)+`buildTree(items,null)` не покаже його ні коренем (parentId≠null), ні під батьком (батька нема в наборі) → **стаття зникає з UI, існує в БД, некерована**. Grep: `grep -rn "async restore" apps/api/src/modules/**/*.service.ts` → для кожного на моделі з `parentId` self-relation перевірити re-parent-логіку. Fix: у restore перевірити `findFirst({id:parentId, orgId, deletedAt:null})`; якщо батько мертвий/відсутній → відновити коренем (`parentId:null`, детермінований fallback). Регресія: 2 тести (батько видалений→parentId=null у data; батько живий→data без parentId). Severity HIGH (тиха втрата видимості даних). Where else: `WorkCategory`, `GoodCategory`, `ExpenseCategory` (fixed), будь-який `*Category`/`*Node` з `parentId`. Парне Bug #373 (remove не каскадить) — інверсія.

- [ ] **reference-time guard приймає вимкнений (isActive=false) довідниковий запис (Bug #735):** сервіс-споживач валідує FK на довідник ПЕРЕД записом операції лише на `deletedAt:null` (+бізнес-guard), але НЕ на `isActive`, хоча довідник має toggle-active і фронт ховає вимкнені у select. Пряме API (mobile/sync/curl/застарілий кеш дерева) приймає вимкнений запис → нова операція посилається на «архівований» довідник → спотворює звітність по активних. Тут: `cash.createOperation` брав `expenseCategory.findFirst({deletedAt:null})` без `isActive`. Grep: `grep -rn "findFirst.*deletedAt: null" apps/api/src/modules/**/*.service.ts | grep -iE "Category|Method|Config|Rate|Template|Account"` → для кожного lookup довідника з `isActive`, вжитого у create нової операції, перевірити відхилення `!isActive`. Fix: select += `isActive`, 400 «X вимкнено — оберіть активний» ЛИШЕ на шляху нової операції (історичні недоторкані). ⚠️ оновити наявні мок-lookup у специ (додати `isActive:true`) — новий guard читає поле, якого мок не давав → `undefined` → хибний блок. Severity MEDIUM (HIGH якщо запис маршрутизує гроші — рахунок/податкова ставка). Where else: payments (payment-method), payroll, invoices (tax-rate), будь-який споживач `*Category`/`PaymentMethodConfig`/`TaxRate`/`NotificationTemplate`/`SettlementAccount`.

- [ ] **Backend без depth-guard на self-relation дереві коли UI обмежує глибину (Bug #736):** UI дерево-довідника має `MAX_DEPTH` (напр. 3 рівні), але backend `create`/`update` не має жодної перевірки → пряме API будує необмежену вкладеність (розходження UI↔API; `buildTree` рекурсія без обмеження). Grep: `grep -rn "MAX_DEPTH\|maxDepth\|depth" apps/web/src/**/*.tsx` — якщо UI обмежує, а `grep "depth\|MAX_DEPTH" apps/api/src/modules/<mod>/*.service.ts` порожній → gap. Fix: `getDepth`(обхід ланцюга батьків у памʼяті) у create (глибина_батька+1) та `getDepth`+`getSubtreeHeight` в update-reparent (глибина_нового_батька+1+висота_піддерева) → >MAX_DEPTH → 400. Severity LOW (цілісність/консистентність). Where else: усі self-relation `*Category` з UI-обмеженням глибини.

- [ ] **Soft string FK без validation (Bug #361):** будь-який DTO field що зберігається у Prisma як plain `String`/`String @db.VarChar(N)` АЛЕ концептуально посилається на іншу таблицю (`currencyCode → Currency.code`, `paymentMethodCode → PaymentMethodConfig.code`, `eventType → NotificationTemplate.eventType`, etc.) — service ОБОВ'ЯЗКОВО валідує існування через `findFirst({ orgId, <field>: dto.X, deletedAt: null })` перед persist. Без guard API дозволяє `currencyCode: 'XYZ'` → DB корумпована (no FK constraint enforces existence) → UI рендерить garbage (`1 000.00 XYZ`), downstream FX/notification lookups silent-skip або throw. Парний guard має існувати у БОТКИ `create` І `update` paths (PATCH-only attack vector іначе). Grep: `grep -rnE "String\s*$|String\s+@db\.VarChar" packages/database/prisma/schema.prisma | grep -iE "code|type|status"` → для кожного знайденого field перевірити service. Severity HIGH. Регресія-guard: contract spec кейс `POST .../<resource> { code: 'INVALID' } → 400`.

- [ ] **Auto-create child resource ignores parent settings inheritance (Bug #360):** для КОЖНОГО `tx.<ChildModel>.create()` всередині parent `service.create()`/`$transaction` — перевірити чи child default-values відповідають parent-level settings, які user міг налаштувати. Приклад: `OrganisationSettings.currency='USD'` → `auto-create CounterpartyContract.currencyCode` має використати 'USD' (не hardcoded 'UAH'). Інші risk-spots: `BranchSettings.slotDurationMinutes` → auto-Slot create, `OrgSettings.invoiceDueDays` → auto-Invoice create. Grep: `grep -rnE "tx\.[a-z]+\.create\(\s*\{\s*data:\s*\{[^}]*\b(currencyCode|currency|paymentDeferDays|warrantyDays|slotDurationMinutes):" apps/api/src/modules --include="*.service.ts"` — кожен hardcoded value у data поза параметром = potential bug. Fix-pattern: fetch `prisma.organisationSettings.findUnique({ where: { orgId }, select: { <fields> }})` ПЕРЕД `$transaction` (паралельно з documentNumberService.next через Promise.all для -1 RTT), передати у tx.create.data. Severity HIGH (порушує задекларовану інваріант UX-tooltip типу «Використовується за замовчуванням у договорах і звітах», silent inconsistency).

- [ ] **Case-sensitive lookup vs canonical-form seed data (Bug #359):** для КОЖНОГО `findFirst({ where: { code: dto.X } })` або `where: { eventType: dto.Y }` або `where: { documentType: dto.Z }` де target field зберігається у канонічній формі (UPPERCASE ISO code, snake_case event type) — DTO ОБОВ'ЯЗКОВО має `@Transform(toUpperCurrencyCode)` / `@Transform(toLowerCase)` / etc. до `@IsString`. Postgres VARCHAR/TEXT case-sensitive за замовчуванням → користувач набирає `uah` у fallback Input → backend lookup `code: 'uah'` не знаходить `'UAH'` → 400 з валідним кодом. Парний UI-fix: `<Input onChange={e => set(e.target.value.toUpperCase())} maxLength={N}>` у fallback inputs (коли dropdown reference data не завантажилось через offline-first). Grep: `grep -rnE "findFirst\(\s*\{\s*where:\s*\{[^}]*\b(code|type|status):\s*dto\." apps/api/src/modules --include="*.service.ts"` → перевірити що DTO field має нормалізацію transform. Severity HIGH (UX): валідний код → 400 → користувач думає «зламано».

- [ ] **Нове enum value без regression-guard у contract+service spec (Bugs #478-#480):** будь-який commit вигляду `feat(<scope>): add <NEW_VALUE> to <Enum>` що змінює (а) Prisma schema enum + migration `ALTER TYPE ... ADD VALUE`, (б) `@IsEnum([...])` whitelist у Create/Query DTO, (в) backend service maps (`MOVEMENT_TYPES[NEW]`, `docTypeMap[NEW]`), (г) frontend hardcoded array — ОБОВ'ЯЗКОВО має парні regression-тести для нового значення у `*.contract.spec.ts` І `*.service.spec.ts`. Grep: `grep -rn "<NEW_VALUE>" apps/api/src/modules/<scope>/ --include="*.spec.ts"` — 0 matches = bug. Мінімальний набір regression-guards: (1) POST з `type: NEW_VALUE` → 201 + service отримує dto.type=NEW_VALUE; (2) GET з `?type=NEW_VALUE` → 200 + service.findAll отримує NEW_VALUE; (3) `transition(NEW-doc, CONFIRMED)` (або equivalent FSM-step) → асерти на map-резолв (`docNumbers.next(orgId, PARENT_DOC_TYPE)`, `inventory.createMovement type=StockMovementType.NEW`), branch logic (`toHaveBeenCalledTimes(1)` — не як TRANSFER з двома), sign quantity (`.toBeGreaterThan(0)`). Якщо service spec ВЗАГАЛІ нема — створити новий (як `stock-documents.service.spec.ts` у f59c6a47). Без guards: refactor що видаляє `NEW: StockMovementType.NEW` з MOVEMENT_TYPES або додає `NEW` у TRANSFER-branch проходить CI зеленим, runtime отримує 400/«Непідтримуваний тип документу». Severity HIGH. Where else: `WorkOrderStatus`, `InvoiceStatus`, `PurchaseOrderStatus`, `StockMovementType`, `DocumentType`, `PaymentMethod`, `CounterpartyType`, `EmployeeRole`, будь-який backend service з `switch (type)` або `Record<EnumType, X>` map.

- [ ] **Shared FE constant без парної backend константи (Bug #432):** будь-який commit що додає `export const <NAME>_STATUSES`/`<NAME>_TRANSITIONS` у `packages/shared/src/constants/*.ts` І оновлює FE-компоненти щоб використати її, ПОВИНЕН паралельно мати backend константу у `apps/api/src/modules/<entity>/<entity>.fsm.ts` (або `*.constants.ts`). Backend service-файл НЕ має містити inline `['LITERAL_A', 'LITERAL_B']` що дублює значення shared константи — інакше FE = single source of truth (порушує SKILL §1.3 Bug #401 принцип «BE — single source, FE — mirror»). Grep: для кожного нового shared `<NAME>_STATUSES` literal-array → `grep -rnE "'<literal-A>', '<literal-B>'" apps/api/src --include="*.ts" | grep -v spec` → matches = bug. Особливо CRITICAL коли whitelist гейтить financial/legal ops (invoice creation, completion-act). Парне з Bug #401 (FE↔BE status whitelist symmetry — там FE асиметричний за подію; тут структурна gap до first-class const). Регресія-guard: spec у `*.fsm.spec.ts` `expect(BE_STATUSES.sort()).toEqual([...FE_STATUSES].sort())`. Severity HIGH. Where else: будь-який модуль з FSM/gate-whitelist (PO, Invoice, StockDocument, CompletionAct, Calendar slots).
- [ ] **Стала локальна копія shared-константи у тесті + мок-рівнева асерція замість real-invariant (Bugs #705-#706):** дві test-drift пастки що лишають suite ЗЕЛЕНОЮ поки критичний money/inventory/FSM-шлях незахищений. (1) Component/unit-тест визначає ЛОКАЛЬНУ копію shared-мапи (`const TRANSITIONS = {...}` дублює `@sto/shared` `WO_STATUS_TRANSITIONS`/`*_STATUSES`/badge-map) → sprint змінює shared, копія лишається старою → нова гілка не покрита, ба більше — маскує первинний sync-gap. Grep: `grep -rnE "const [A-Z_]+\s*(:\s*Record|=\s*{)" apps/web/src/**/__tests__ apps/api/**/*.spec.ts` → звірити ключі проти реального shared-export; після sprint що чіпав `packages/shared/src/constants/*` — обов'язково. Фікс: синхронізувати фікстуру + dedicated guard що ІМПОРТУЄ фактичний shared-export і асертить нову поведінку. (2) Money/inventory/FSM-spec стверджує інваріант ЛИШЕ через `toHaveBeenCalledTimes/toHaveBeenCalledWith` на ЗАМОКАНОМУ критичному колабораторі (`batchService.returnToBatch = vi.fn()`) → реальна арифметика (Σ remainingQty==StockItem.quantity, balance net-to-zero, агрегація-по-ключу) ніколи не біжить → регресія що ламає інваріант проходить CI. Детектор: у спеці всі асерції на моці + жодна не читає ПІДСУМКОВИЙ стан (remainingQty/quantity/balance). Фікс: стейтфул integration-спек з in-memory Prisma-store (CAS `updateMany` з where-предикатом, increment/decrement, findMany-фільтр) + РЕАЛЬНІ сервіси через Nest DI → повний round-trip + асерт підсумкового інваріанту. Mutation-verify: (1) відкат shared-мапи → guard падає; (2) заміна агрегації на per-row → stateful падає, мок-тести лишаються зелені (доводить що не ловили б). Severity MEDIUM (HIGH якщо шлях рухає гроші/склад і нема іншого real-invariant тесту). Where else: `__tests__/*.test.tsx` з копією `*_TRANSITIONS`/`*_STATUS_*`; money-специ де Batch/Settlements/Inventory замоканий а асерції лише `toHaveBeenCalled*` (invoice from-WO, PO receive, stock-document, supplier-returns). Деталі: «Накопичені підходи» 2026-09-08 (C2).
- [ ] **PRODUCTION-компонент дублює backend-похідну модель (знак/колір/статус) локальним літералом без cross-layer guard (Bug #715):** frontend `page.tsx`/компонент фарбує/знакує доменні enum-значення ЛОКАЛЬНИМ `const X = new Set([...])`/`Record<...>` виведеним з backend-константи (`BALANCE_SIGN`, FSM-мапа, tone/sign-мапа), але НЕ імпортованим з `@sto/shared` і БЕЗ тесту що прив'язує його до backend-джерела. Значення вірні на момент коміту (review/tsc/тести зелені), але зміна backend-константи мовчки десинхронізує UI (транзакція «+» замість «−»; badge зникає). Часто дубльований на 2+ екранах → дрейф і між ними. Grep: `grep -rnE "new Set\(\[|: Record<string" apps/web/src/**/*.tsx | grep -iE "CHARGE|PAYMENT|REFUND|CREDIT_NOTE|SUPPLIER_|BALANCE|sign|tone|STATUS"` → для кожного: чи є backend-джерело? чи імпортовано з shared чи локальний літерал? чи є guard? Фікс: підняти канон у `@sto/shared` + усі екрани import (compile-time guard) + cross-layer invariant-тест у backend-специ (import shared+backend, асерт 1-в-1 по кожному enum + без зайвих ключів). ⚠️ Розрізняти знак (арифметика) від кольору (бізнес-семантика) — навмисне розходяться для постач. типів; фіксувати обидва напрями. Severity MEDIUM (HIGH якщо грошовий знак у export/PDF). Where else: `*_STATUS_COLORS`/`*_BADGE`/`sign`/`tone`-літерали що дзеркалять backend без shared-import. Деталі: «Накопичені підходи» 2026-09-09. Production-сібл Bug #705 (test-fixture-копія).
- [ ] **Journal-row колір/напрям фарбується за ТИПОМ-Set, а не за знаком записаної кількості/суми (Bug #738):** гострий підвид #715 у будь-якому плоскому журналі рухів (StockMovement, cash, settlements, ledger) де рядок несе ЗНАКОВУ величину (`quantity`/`amount`, «+»=прихід «−»=витрата) І поряд колір-класифікацію `INCOMING/OUTGOING = new Set([...types])`. Type-Set неминуче дрейфує зі знаком бо (а) той самий тип може зберігатись з протилежним знаком до інтуїції (`RESERVATION` зберігається ДОДАТНІМ але «звучить» як витрата → потрапляє в OUTGOING → додатнє число фарбується червоним, суперечить самому числу на екрані); (б) нові enum-значення (`RESERVATION_RELEASE`, `TRANSFER` обидві ноги) не попадають у жоден Set → від'ємне число рендериться НЕЙТРАЛЬНИМ; (в) коментар над Set-ом часто вже суперечить коду («лишаємо нейтральним» поки тип у OUTGOING). Сигнал-детектор: у компоненті є І `{m.quantity}`/`{fmtMoney(m.amount)}` (сире знакове число на екрані) І `Set([...ENUM_VALUES]).has(m.type)` для кольору → майже завжди drift. Grep: `grep -rnE "new Set\(\[[^]]*(RECEIPT|WRITEOFF|RESERVATION|TRANSFER|CHARGE|PAYMENT|IN|OUT)" apps/web/src/**/*.tsx` → для кожного звірити напрям Set проти знакової конвенції backend `createMovement`/`createTransaction` (яким знаком КОЖЕН тип зберігається). Фікс: фарбувати СТРОГО за знаком displayed-величини — `incoming = v > 0`, `outgoing = v < 0`, `=0` нейтрально; знак числа = єдине самоузгоджене джерело, стійке до нових enum. (Виняток: якщо семантичний колір НАВМИСНЕ розходиться зі знаком — постач. типи settlements — тоді Set легітимний, але має shared-import+cross-layer guard як #715.) Регресія mutation-verified: рядок кожного знаку × кожного проблемного типу (RESERVATION+, RESERVATION_RELEASE−, TRANSFER±) → assert клас за знаком; revert до type-Set → падає. Severity MEDIUM (HIGH якщо грошовий знак у ledger/export). Де ще: cash-operations, settlements-tx, будь-який journal/ledger UI з sign-column + type-color.
- [ ] **Audit-track list ↔ update.data symmetry (Bug #433, family Bug #421):** для КОЖНОГО `service.update()` що має `auditService.record(...)` поряд з `prisma.X.update({ data: { ...fields } })` — keys у audit-track array (`['fieldA', 'fieldB', ...] as const).forEach(trackField)` ⊇ keys у data-payload. Якщо data пише поле що НЕМАЄ у audit-list → AuditEvent.diff силенто порожній для цього поля → compliance/bookkeeping gap. Особливо ризиково для FK (`liftId`, `branchId`, `contractId`), документ-дат, фінансових сум. Свіжий `fix(tester): Bug #N audit gap` commit означає що один specific field виправили, але **уся сімʼя fields у тому ж update()** залишилась підозрілою — split-fix pattern. Grep: ручний audit для кожного service.update() з audit-list — diff data-keys vs audit-keys; будь-який diff > 0 = bug. Регресія-guard: spec `it('update() diff включає <new field> якщо у dto')`. Severity HIGH (audit-trail). Where else: усі `*.service.ts` що мають update + auditService — особливо ті що нещодавно мали додавання нового поля.
- [ ] **Perf-звужений `select` повторно використаний як audit old-snapshot → фейкові «поле→undefined» diff (Bug #719):** ІНВЕРСІЯ Bug #433 — там audit пропускав поля, тут audit пише ЗАЙВІ/ХИБНІ. Патерн: `service.update()` читає `existing` через оптимізований `select:{id, <кілька-полів-для-guard>}` (name-guard/tenant-guard), а потім передає ВЕСЬ цей `existing` як old-data у `audit.record(..., existing, dto)`. `AuditService.buildDiff` ітерує ОБ'ЄДНАННЯ ключів old∪next → для часткового PATCH поля що є в `existing` але НЕ в `dto` дають `{from:<val>, to:undefined}` → аудит ХИБНО стверджує що поле очищено (+ `id` завжди спурйозний бо ніколи не в dto). Money-adjacent (журнал змін контрагента/документа). Grep: `grep -rnE "audit(Service)?\.record\([^)]*existing" apps/api/src/modules/**/*.service.ts` + для кожного звірити: (а) чи `existing`-select містить `id`/поля поза dto-ключами? (б) чи old-data обмежено `Object.keys(dto)`? Фікс: old-snapshot = перетин existing з ключами dto (`for(k of Object.keys(dto)) if(k in existing) old[k]=existing[k]`), а `existing`-select розширити до повного auditable-набору DTO (щоб before-значення були справжні, не undefined). Регресія: `it('old-snapshot НЕ містить id/полів поза PATCH')` + `Object.keys(old).toEqual([<змінене>])`. Severity MEDIUM (HIGH якщо фейкове очищення стосується сум/платника-ПДВ/реквізитів у compliance-експорті). Where else: усі `*.service.ts` update() де `existing` (перечитаний перед update) йде в audit.record — counterparties (fixed), + перевірити invoices/work-orders/purchase-orders/vehicles якщо мають перечит-existing→audit.
- [ ] **Audit arg-correctness БЕЗ жодної assert (test-gap #720):** money-critical inline-audit (pricing-rules controller, settings TaxRate) часто має AuditService замоканим `{record: vi.fn()}` АЛЕ жодна assert не перевіряє аргументи → тихий refactor ламає аудит (переплутаний entityType, забутий userId, audit ПЕРЕД write коли id ще undefined) без падіння CI. Grep: `grep -rln "provide: AuditService" apps/api/**/*.spec.ts` → для кожного звірити чи є `expect(auditMock.record).toHaveBeenCalledWith/mock.calls[0]`. Мін-набір тестів на audit-шлях: (1) record(orgId, '<Entity>', <id>, <ACTION>, userId) з правильними позиційними арг; (2) id береться з WRITE-результату (create) → audit ПІСЛЯ write; (3) fail-path (404/count=0) → record НЕ викликано; (4) userId=undefined → record НЕ викликано (best-effort gate); (5) **record() reject НЕ ламає основну мутацію** (best-effort `.catch` — мутація повертає результат попри «audit db down»). Побічно ловить mock-shape drift: `@CurrentUser().id` vs мок що ставить лише `req.user.sub` (AuthenticatedUser має `id`, мапиться з `payload.sub`). Severity MEDIUM (audit-trail regression risk). Where else: будь-який controller/service з `audit.record` без arg-assert.
- [ ] **Кешований `_count.<junction>` завищений: junction без `deletedAt`, а parent soft-delete-иться (Bug #723):** будь-який aggregate-лічильник що показує «скільки X мають цей Y» через `_count: { select: { <junction>: true } }` на M:N довіднику (`CounterpartyStatus.counterpartyCount`, `Tag.usageCount`, `Category.itemCount`) — рахує ВСІ link-рядки, а junction-таблиці зазвичай БЕЗ `deletedAt` і НЕ прибираються при soft-delete батька (link лишається навмисно, щоб restore відновив призначення). Наслідок: soft-delete контрагента/товару з міткою НЕ зменшує лічильник → у списку «5 контрагентів» коли активний 1. Значення вірне на момент assign (review/tsc/spec зелені бо тест мокає `_count`), брехня зʼявляється лише після видалення батька. Grep: `grep -rnE "_count: \{ select: \{ [a-zA-Z]+: true \}" apps/api/src/modules/**/*.service.ts` → для КОЖНОГО: чи relation веде на junction чиї parent-рядки soft-delete-яться? Якщо так — `true` треба замінити фільтром через parent: `_count: { select: { links: { where: { <parent>: { deletedAt: null } } } } }` (Prisma 5 підтримує; патерн уже у purchase-orders/stock-documents/supplier-returns з `lines: { where: { deletedAt: null } }`). Live-доказ: assign→count=1, DELETE parent (soft)→count має стати 0. Регресія: spec асертить `findMany`/`create` викликано з фільтрованим include (revert до `links: true` → тест червоний). Severity MEDIUM (HIGH якщо лічильник керує білінгом/лімітом). Де ще: усі M:N довідники з `<parent>Count`/`usageCount`/`itemCount` на кешованому findAll. Деталі: «Накопичені підходи» 2026-09-10.
- [ ] **Кешований filtered-`_count` розсинхронізується від мутації РІДНОЇ сутності, що зсуває фільтр, а не самого link (Bug #725):** прямий сіблінг #723 — там виправили ЗАПИТ (`_count: { select: { links: { where: { <parent>: { deletedAt: null } } } } }`), тут ламається КЕШ. Коли `findAll` довідника кешується (`ref:<x>:<orgId>`, TTL 300с), а `goodCount`/`counterpartyCount` рахує `_count.links where <parent>.deletedAt:null`, то на значення впливають ДВІ осі мутацій: (1) assign/unassign — міняють сам link (ці зазвичай вже кличуть `invalidateCache`); (2) `<parent>.remove()`/`restore()` — міняють `<parent>.deletedAt`, що входить у WHERE-фільтр `_count`, але живуть у ІНШОМУ сервісі (`GoodsService`/`CounterpartiesService`) і про кеш довідника НЕ знають. Наслідок: soft-delete товару/контрагента з міткою лишає кешований `goodCount` завищеним до TTL (restore — занижує). Значення вірне одразу після assign і у свіжому (не-кешованому) запиті — брехня лише поки кеш живий → легко пропустити (перший live-read після delete може влучити у прострочений кеш і показати правду). Grep: `grep -rn "invalidateCache\|Statuses\.\|ref:.*:\${orgId}" apps/api/src/modules/**/*.service.ts` → для КОЖНОГО кешованого filtered-`_count` перелічити ВСІ операції що зсувають поле-фільтр (тут `deletedAt`): assign, unassign, **parent.remove, parent.restore** (+ hard-delete/merge якщо є) — кожна МУСИТЬ інвалідувати кеш довідника. Live-доказ: assign→goodCount=N; `DELETE /goods/:id` (soft, 204)→повторний `GET /good-statuses` має дати N−1 БЕЗ жодної проміжної статус-CRUD (яка б випадково скинула кеш). Fix: приватний `invalidate<X>CacheIfLabeled(orgId, id)` у parent-сервісі — після успішного remove/restore перевірити `<junction>.findFirst({orgId, <parentId>})`; якщо є link — `<statuses>.invalidateCache(orgId)` (guard уникає churn на сутностях без міток). Регресія: spec parent-сервісу — «parent з міткою → remove/restore кличе invalidateCache», «без мітки → не кличе»; mutation-verify: прибрати виклик → тест червоний. Severity MEDIUM (user-visible лічильник; HIGH якщо гейтить білінг/ліміт). Де ще: усі M:N довідники з кешованим filtered-`_count` (counterparty-statuses — той самий латентний баг у `counterparties.remove/restore`), будь-який `ref:*`-кеш чиє значення залежить від поля яке мутить ІНШИЙ агрегат. Деталі: «Накопичені підходи» 2026-09-11.
- [ ] **Захисні гілки перенесеного методу після refactor-extract без прямого тесту (A3 e8ae4d70):** для КОЖНОГО commit `refactor(...extract)`/`винести ... у <NewService>` (навіть з review «byte-identical» + suite зелений) — `git show <sha> --stat`, у новому `.service.ts` перелічити ВСІ захисні гілки перенесеного коду: `if (...) throw` на невалідному стані, `safeCoeff(...)`/`?? 1`/clamp division-guard, `Number.isFinite`, single-vs-batch null-гілки, in-tx-re-read перекриває stale. Для КОЖНОЇ спитати «який тест червоніє якщо прибрати?» — happy-path перенісся зеленим, але ці лінії виконуються лише на специфічному вході, якого happy-path не подає (тут: zero-total throw на COMPLETED + coeff=0→safeCoeff→1 обидва без прямого тесту, хоча return-дзеркало мало zero-total). Grep: `grep -nE "throw |safeCoeff|\?\? 1|/ coeff|Number.isFinite" apps/api/src/modules/**/<new>.service.ts` → для кожного матчу шукати assert у `<new>.service.spec.ts`. ОКРЕМО: якщо перенесений private-хелпер робить guarded Prisma-запит (`goodUoM.findMany` +orgId) — юніт-mock НЕ виконує $extends-guard, тож «фікс перевірено unit» = лише mock-shape-assert; треба ІНТЕГРАЦІЙНИЙ тест проти реального guarded-client (дзеркалить `tenant-guard.integration.spec.ts`) з mutation-baseline (revert фіксу → integration відтворює оригінальний throw наживо). Мін-набір: (1) edge-throw: невалідний вхід→throw + побічний-ефект НЕ стався; (2) division-fallback: coeff=0→baseQty скінченне (не Infinity/NaN); (3) live-guarded: перенесений метод з edge-входом (UoM-частина) через guarded `$transaction`→0 guard-throw. Severity MEDIUM (сам рефактор коректний; для tenant-фіксу без live-тесту — HIGH). Де ще: усі A-серії God-object split, майбутні extract у invoices/purchase-orders/stock-documents. Парне з #705-#706 (mock-рівнева асерція) + #429 (stale-mock після extract).
- [ ] **Cross-endpoint status-filter inconsistency для одного resource (Bug #415):** для КОЖНОГО resource з status-enum (`Invoice.status`, `WorkOrder.status`, `Payment.status`) — звірити status filtering між усіма ендпоінтами що оперують одним resource. Типова асиметрія: `findByX(parentId)` має `status: { not: 'CANCELLED' }`, але `getLinkedY(parentId)` / `getCountsZ(parentIds)` — БЕЗ status фільтра. Result: badge count показує "2 invoices" коли активний 1 (другий CANCELLED), користувач відкриває панель → бачить мертвий запис → confused UX. Pre-check `createFromX` тоді блокує "вже існує", але badge показав 2 — користувач сприймає як bug. Grep: для кожного `prisma.<model>.find*/count/groupBy` query — перевірити чи `where.status` уніфікований через усі service-методи того ж модуля. Якщо `findByWorkOrder` exclude CANCELLED АЛЕ `getLinked*/`/getCounts` include — bug. Imp: import enum (`InvoiceStatus`) з `@prisma/client`замість string literal`'CANCELLED'` — TS catches typo + renaming. Severity LOW (UX inconsistency); MEDIUM коли inconsistency caused decision-making error. Регресія-guard: contract spec кейс «WO має 1 CANCELLED + 1 DRAFT → counts.X===1». Парне з Bug #401 (FE↔BE status whitelist symmetry — той самий принцип, інший рівень).
- [ ] **Concurrent-create race for "1 active per parent" resources без unique index (Bug #412):** будь-який service-метод що створює дочірній resource з логіко-унікальним FK (`Invoice.workOrderId`, `FiscalReceipt.paymentId`, `InspectionReport.workOrderId`) використовуючи pattern `find existing → if (existing) throw → create` БЕЗ обгортки у `$transaction({ isolationLevel: 'Serializable' })` АБО без `@@unique` partial-index на FK = race-window для дублікатів. Два паралельних POST (double-click через UI lag, два tab-и, два admin) обидва бачать `existing === null` між findFirst і create → 2 invoice створено з тим самим `workOrderId`. Grep: `grep -rnE "async (create|createFrom|issueFor|generateFor)[A-Z]" apps/api/src/modules --include="*.service.ts"` → для кожного знайти `findFirst({ <fkField>: id })` prep-check ПЕРЕД `create()` → перевірити schema.prisma на парний `@@unique([<fkField>])` АБО Serializable $tx. Fix-pattern: pre-fetch `docNumbers.next()` (свій внутрішній $tx), потім обернути read+create у Serializable з re-check existing всередині; map P2034 → friendly BadRequestException. `DocumentNumberService.next()` серіалізує лише ПО docType, НЕ по parent FK — не достатньо для invariant "1 active per parent". Severity HIGH (фінансовий ризик). Регресія-guard: service spec з 2-3 кейсами (existing у pre-check → 400, status guard → 400, non-existent WO → 404).
- [ ] **Inner $tx re-check тест для Serializable race fix (Bug #416, paired with #412):** для КОЖНОГО service-метода з Bug #412 фіксом (`$transaction({ isolationLevel: 'Serializable' })`з inner`tx.X.findFirst`re-check) — парний`*.spec.ts`має ОКРЕМИЙ test з`mockResolvedValueOnce(null).mockResolvedValueOnce({id})`sequence +`expect(prisma.X.create).not.toHaveBeenCalled()`. Без цього тесту видалення `const existing = await tx.X.findFirst(...); if (existing) throw ...`блоку у refactor (типовий "цей блок дублює pre-check вище") пройде CI зеленим — CRITICAL race window повертається. Grep: для кожного`$transaction.*Serializable`у service.ts → у парному`.spec.ts`шукати`mockResolvedValueOnce`для того ж`findFirst`ДВА рази підряд. Якщо тільки один`mockResolvedValue`(constant) → gap. Severity MEDIUM (regression risk для CRITICAL fix). Ключовий assert:`expect(prisma.<resource>.create).not.toHaveBeenCalled()` — інакше тест-зелений-проходить навіть при видаленні re-check (бо pre-check теж кидає з тим же moc-setup).

- [ ] **`Partial<Record<Enum, V>>` lookup map з runtime fallthrough (Bug #488):** будь-який `Partial<Record<<EnumType>, V>>` у service-методі для look-up знаку/типу/factor (BALANCE_SIGN, MOVEMENT_FACTOR, TAX_RATE) — потенційний gap у TS-exhaustiveness. `Partial<>` дозволяє додавання нового enum value через Prisma migration `ALTER TYPE ... ADD VALUE` БЕЗ compile-error → runtime throw у проді коли новий тип потрапляє до lookup. Grep: `grep -rnE "Partial<Record<[A-Z][a-zA-Z]+(Type|Status|Role|Kind),\s" apps/api/src/modules --include="*.ts" | grep -v spec`. Якщо ВСІ enum values уже у map → `Partial<>` непотрібно (видалити + видалити runtime guard). Якщо проєктно потрібен partial — задокументувати inline + додати regression-guard для default-branch. Парне з Bug #478-#480 (enum coverage у contract+service spec). Severity MEDIUM (release-blocker якщо gating financial operation: settlement/payment/tax).

- [ ] **Alternate-mutation endpoint обходить canonical guards (Bug #403):** будь-який backend service-метод що **мутує той самий resource** що і `update()`/`addLine()`/`removeLine()` АЛЕ зі своєю окремою сигнатурою (`refreshFromWorkOrder`/`syncFromX`/`importFromY`/`recalculateZ`/`refreshFromExternalSource`...) — ПОВИНЕН повторити ВСІ business-guards канонічного `update()`. Типові guards що пропускаються: (а) `if (X.status !== 'DRAFT') throw BadRequestException` (FSM-readonly для submitted/paid/sent статусів); (б) `if (existing.isLocked) throw ...` (manually locked records); (в) `if (existing.isSystem) throw ...` (seed-керовані); (г) prep-check unique-constraint конфлікту. Сценарій: оригінальний `update()` має FSM-guard `!DRAFT → throw`; альтернативний endpoint забуває цей guard → перезаписує дані SENT/PAID/locked record-у без error → silently corrupts data. Grep: `grep -rnE "async (refresh|sync|import|recalculate|regenerate|rebuild)[A-Z]" apps/api/src/modules --include="*.service.ts"` — для кожного знайденого метода: знайти canonical `update()`/`updateLine()`/`updateX()` у тому ж файлі, скопіювати ВСІ `if (...) throw` guards (особливо `inv.status !== 'DRAFT'`, `existing.status !== ...`), перевірити що alternate-метод їх має. Парний підхід: будь-який mutation що приймає workOrderId/parentId і робить `deleteMany + createMany` на child resource (full overwrite) — обов'язково prep-check status батьківського resource через `if (parent.status !== <ALLOWED>) throw`. Severity CRITICAL (фінансовий ризик для invoice/payment/settlement resources). Регресія-guard: contract spec для alternate endpoint що мокає existing.status=non-DRAFT → 400.

- [ ] **DB-constraint error-mapping guard у canonical write, відсутній у alternate-mutation endpoint (Bug #628):** підклас #403 для ERROR-conversion (не business-guard). Будь-який `throwIfExclusionConflict`/`throwIfSerializationConflict`/`mapPrismaError`-try/catch навколо `$transaction` у canonical `createX()`/`updateX()` МАЄ бути повторений у КОЖНОМУ alternate-мутуючому методі того ж resource (`syncFromX`/`refreshFromY`/`bulk*`/`by-work-order`), інакше concurrent race що обійшов app-probe → raw SQLSTATE → generic 500 замість 4xx. ПАСТКА: EXCLUDE/CHECK-констрейнти перевіряються і на **UPDATE**, не лише INSERT (доводиться live: `update({data:<overlap>})` → 23P01) — тож alternate-метод що лише робить `updateMany({startAt,endAt})` вразливий так само як create. Grep: `grep -rn "throwIfExclusionConflict\|throwIfSerializationConflict" apps/api/src/modules/<mod>/*.service.ts` → порахувати сайти; для кожного alternate-write (`return this.prisma.$transaction` БЕЗ try) — gap. Fix: `let result: T; try { result = await $transaction(...) } catch(err){ throwIfX(err,...) } return result` (throwIfX:never → tsc бачить definite-assign). Регресія-guard: (1) `$transaction` mock кидає SQLSTATE-shaped Error → `rejects ConflictException/BadRequestException`; (2) не-constraint error → пробрасується as-is. Severity MEDIUM (цілісність тримається — constraint фізично блокує; лише 500→4xx UX/observability + Sentry-шум). Where else: CalendarSlot (createSlot/updateSlot/syncWorkOrderSlots × EXCLUDE), StockItem (× `stock_*_nonneg` CHECK), balance-writers, будь-який `@@unique` partial index з кількома write-шляхами.

- [ ] **Concurrent pre-check → write без row-lock або conditional-decrement (Bug #613):** будь-який service-метод що робить `findFirst({ select: { counter }}) → GUARD → upsert/update({ counter: { increment/decrement }})` у $transaction БЕЗ явного `isolationLevel: 'Serializable'` — race window: 2 concurrent tx проходять guard на stale snapshot, Postgres row-lock UPDATE серіалізує тільки сам запис → другий залишає counter НЕГАТИВНИМ (немає DB CHECK constraint). Grep: `grep -rn "isolationLevel|Serializable" apps/api/src/modules/<hot-path>` = 0 matches. Fix 2-layer: (Layer 1) `.select({counter})` у upsert + post-check `if (upserted.counter < 0) throw` (rollback у $tx); (Layer 2) `X.update({data:{field:{decrement:n}}})` → `X.updateMany({where:{id, field:{gte:n}}, data:{...}})` — Postgres atomic CHECK+DECREMENT, count=0 → throw. Regression-guards: (а) service.spec `mockResolvedValueOnce({quantity:-10}) → throw`; (б) service.spec `mockResolvedValueOnce({count:0}) → throw`; (в) invariants.spec property-based `2 concurrent → totalConsumed <= initial ∀ (initial, take)`. Severity: HIGH коли інваріант фінансовий (quantity/balance/reserved); MEDIUM для non-critical counters. Where else: `settlementAccount.balance`, `cashRegister.balance`, `bankAccount.balance`, `deliveryOrder.receivedQty`, `purchaseOrder.paidAmount` — будь-який `findFirst → upsert/update({increment/decrement})` у Read Committed.

- [ ] **Stale-read status-guard → exactly-once ЗОВНІШНІЙ side-effect → write, без CAS-claim (Bug #711):** підклас #613 для НЕ-ідемпотентних external ефектів (не лічильників). Будь-який service-метод, що (1) читає стан рядка `findFirst` і перевіряє `if (row.status !== 'OPEN'/'ACTIVE'/...) throw`, потім (2) робить ЗОВНІШНІЙ exactly-once виклик (`provider.closeShift` Z-звіт, `sellReceipt` фіскальний чек, SMS/ПРРО/gateway), потім (3) `update({where:{id}})` без CAS-предиката на статус — має вікно гонки: два concurrent виклики (подвійний клік / BullMQ retry / два оператори) обидва проходять stale head-guard і обидва виконують зовнішній ефект → **ДВА Z-звіти / два чеки / два SMS**. Row-lock на фінальному update НЕ рятує (ефект уже стався ДО нього). Grep: `grep -rnE "async (close|finalize|issue|void|cancel|send)[A-Z]?" apps/api/src/modules --include="*.service.ts" -A20 | grep -B15 "provider\.\|\.sellReceipt\|\.closeShift\|fetch(\|axios\." | grep "status !==\|status ==="` — head-guard + external call без CAS-claim між ними. Fix: **CAS-claim ПЕРЕД зовнішнім викликом** — `updateMany({where:{id,orgId,status:'OPEN',deletedAt:null}, data:{status:'CLOSED',...}})`, `count===0 → throw` (програвший не робить другий ефект); рівно 1 переможець іде до external. При збої external — best-effort revert claim у попередній статус (`where` guard на «ще не фіналізовано», напр. `zReportId:null`), щоб оператор повторив. Метадані (zReportId/fiscalReceiptId) дописати окремим update після успіху. Порівняй з `supplier-payments.confirm()`/`supplier-returns.confirm()` — вони CAS-flip-ають ПЕРШИМ (еталон). Regression-guard (mutation-verified): (а) claim count:0 → 4xx + external НЕ викликано + фінальний update НЕ викликано; (б) claim ok, external кидає → revert-updateMany назад + rethrow; (в) happy: claim-where несе status+orgId, external після claim. Мутація: прибрати `if(claim.count===0)` → тест (а) червоний. Severity HIGH якщо ефект фіскальний/грошовий (Z-звіт, чек, платіж); MEDIUM для повідомлень. Where else: cash-shift close/open, будь-який `*.processor` з external call + status-flip, invoice issue→fiscal, gateway refund.

- [ ] **CAS захищає concurrency, але НЕ бізнес-діапазон/max (Bug #712):** пастка-плутанина рівнів захисту. `updateMany({where:{id, counter:<expected>}, data:{increment:delta}})` — CAS проти concurrent-подвоєння (2 паралельні виклики), АЛЕ він НЕ перевіряє чи `existing + delta` не перевищує бізнес-максимум (`receivedQty <= orderedQty`, `paidAmount <= invoiceAmount`, `reserved <= quantity`). Один-єдиний виклик з роздутим `delta` (прийом 100 на замовлені 10) проходить CAS чисто → over-receipt/over-pay/over-reserve + роздутий side-effect (SUPPLIER_CHARGE ×100, RECEIPT +100). Симптом-сигнал: DTO має лише `@Min(0)` без `@Max`, а дос'є/бізнес-правило декларує верхню межу («не може перевищити X») — але guard-а нема НІ в DTO НІ в сервісі (задокументований, але неіснуючий інваріант). Grep: для кожного `updateMany({where:{...,<counter>:<val>}, data:{<counter>:{increment}}})` знайти чи є fail-fast `if (existing.<counter> + dto.delta > existing.<max> + EPSILON) throw` ПЕРЕД транзакцією; звірити DTO на `@Max`/кумулятивну перевірку. Fix: fail-fast 4xx перед `$transaction`; для Float-полів (дробові одиниці) — толеранс `EPSILON=1e-6` (не пряме `>`, інакше хибне 400 на IEEE-754-дрейфі). Regression-guard (mutation-verified): (1) over-limit → 400 + жодного inventory/settlement/CAS write; (2) кумулятивний over на partial → 400; (3) **boundary рівно до max → дозволено** (не хибне 400). Мутація: `if(false)` на guard → over-тести червоні, boundary зелений. Severity HIGH коли надлишок рухає склад/гроші. Where else: `PurchaseOrderLine.receivedQty≤quantity`, `Invoice.paidAmount≤amount`, `StockItem.reserved≤quantity`, `WorkOrder.paidAmount≤totalAmount` — будь-який monotonic-counter з бізнес-стелею.

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

# Bug #717: .ps1 з кирилицею БЕЗ BOM, викликаний powershell.exe 5.1 → мохібейк логів / parse-крихкість
for f in installer/scripts/*.ps1; do head -c3 "$f"|xxd -p 2>/dev/null|grep -q efbbbf || echo "NO-BOM (5.1 мохібейк ризик): $f"; done
grep -rn "powershell.exe\|pwsh" installer/inno/*.iss installer/scripts/*.ps1 2>/dev/null  # powershell.exe=5.1-семантика (BOM обов'язковий)

# Bug #716: rollback re-pull того самого плаваючого тега = no-op + ігнорований exit-code у rollback
grep -nE "Invoke-Rollback|rollback|docker compose pull" installer/scripts/*.ps1 2>/dev/null
# для кожного pull у rollback-гілці: (а) є $prev==$target guard? (б) $LASTEXITCODE після pull/up?
# (в) rollback тягне з registry (fail офлайн) замість docker load з бандлу як Setup? Звірити .env VERSION дефолт.

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
- [ ] **PowerShell-скрипт UTF-8-БЕЗ-BOM + не-ASCII, викликаний `powershell.exe` 5.1 (не `pwsh` 7.x) (Bug #717):** 5.1 без BOM читає `-File` як системний ANSI → кирилиця = мохібейк у логах Task Scheduler/Inno; крихкість до парс-краху. Перевірити ВСЮ `installer/scripts/` suite (не один файл): `head -c3 <f>|xxd -p` має бути `efbbbf`. Severity: MEDIUM якщо не-ASCII лише в логах; **HIGH** якщо у `Set-Content`/`Add-Content`/`Out-File`-значеннях (пише мохібейк у .env/DB), у `-eq`/`-match`-порівняннях (ламає логіку), або у ScheduledTask-НАЗВАХ (task не знайдеться). Fix: перезаписати з UTF-8 BOM (`New-Object System.Text.UTF8Encoding($true)`), контент незмінний. Verify на живому 5.1: `powershell.exe -File <f>` → кирилиця коректна.
- [ ] **rollback re-pull того самого плаваючого тега = no-op + ігнорований exit-code (Bug #716):** deploy/update-скрипт з rollback через `docker compose pull <img>:$prev` — (а) якщо shipped-дефолт `.env VERSION=latest` і update без явної `-Version` → `$prev==$target` → re-pull перетягує щойно-зламаний образ (тег плаваючий) → відкату НЕМАЄ, але лог каже «виконано»; треба `if ($prev -eq $target)` guard → чесне «неможливо відкотити» + exit 1. (б) rollback-pull/up БЕЗ `if ($LASTEXITCODE -ne 0){throw}` → на офлайн-збої (registry pull без інтернету — суперечить offline-first) логує фальшивий success. (в) rollback має тягнути образ як forward-install (offline=`docker load` з бандлу, не registry). Звірити обіцянку в UI/task-описі («відкотиться автоматично») з реальністю під SHIPPED-дефолтом. Severity: MEDIUM (HIGH якщо продукт обіцяє unattended auto-rollback).
- [ ] nginx Next.js static export: `location /_next/static/` з `expires 1y; immutable`; `gzip_types` включає `text/javascript image/svg+xml application/xml`
- [ ] **Global APP_GUARD skip-list audit (Bug #203):** будь-яке введення global guard через `{ provide: APP_GUARD, useClass: XGuard }` потребує аудиту endpoint-ів які мають бути виключені: (а) `/health` — docker healthcheck/nginx upstream/моніторинг опитують часто, ліміт швидко перетинається → cascade restart; (б) `/metrics` — Prometheus scrape кожні 15s; (в) SSE-streams (`@Sse`) — довгоживучі з'єднання повторно retry-ються EventSource при втраті; (г) webhooks з зовнішніх систем (PRRO, payment provider) — клієнт не контролює rate; (д) batch/cron-endpoints. Кожен такий контролер потребує парний skip-декоратор (`@SkipThrottle()`, `@Public()`, `@SkipGuard()`). tsc не ловить, тести не ловять (HEALTH spec звичайно не запускає AppModule з APP_GUARD). Виявляється лише у проді коли docker healthcheck отримує `429` → restart loop.
- [ ] **Paired logger+middleware request-id link (Bug #216):** коли проєкт додає одночасно (а) HTTP correlation middleware що сетить `x-request-id` header, і (б) structured logger (`nestjs-pino`/`pino-http`) — пересвідчись що ДВА компоненти **поділяють той самий ID source**. Дефолтний `pino-http.genReqId` повертає sequential integers (`1, 2, 3, ...`) — НЕ читає header. Middleware сетить header один UUID, pino пише інший integer у `reqId` лога → cross-correlation мертва. Grep: `grep -n "genReqId\|reqId" apps/api/src` — якщо середовище має CorrelationIdMiddleware АЛЕ нема `genReqId` у pino config → bug. Фікс: `genReqId: req => req.headers['x-request-id']`-based з fallback `randomUUID()`. Захист: контракт-тест що шле `X-Request-Id: <UUID>` і асертить `JSON.parse(stdout).reqId === <UUID>`. Аналогічна перевірка: `customLogLevel`, `customSuccessMessage`, `serializers` що ховають correlation поля. Severity: HIGH (не runtime crash, але feature що додається саме для production-моніторингу — не працює).
- [ ] **pino redact list — cross-DTO secret-field audit (Bug #217):** після додавання `pino` `redact: [...]` пройти кожен `*.dto.ts` у `apps/api/src/modules/` і знайти ВСІ plaintext-secret поля (`password`, `*Password`, `*Token`, `*Secret`, `*Key`, `*PrivateKey`, `apiKey`, `webhookSecret`). Кожне таке поле має `req.body.X` АБО `req.body.*Password`-glob у redact. Grep: `grep -rnE "(password|Token|Secret|apiKey|webhookSecret)!?\??:.*string" apps/api/src/modules/**/*.dto.ts` → cross-check проти `redact: [...]`. SKILL §1.4 раніше згадував лише `password`/`refreshToken`/`accessToken`; реальні DTO мають теж `ownerPassword` (setup), `prroApiKey` (POS), `webhookSecret` (webhooks). Без full аудиту перший review-раунд накладає redact лише для очевидних auth-полів, а решта secret-полів лишається непокритими — log statement з spread `req.body` витече їх. Severity: MEDIUM (поки немає log statement що spread-ить body — нема leak; додавання stmt стає HIGH).

- [ ] **redact/mask min-length поріг пропускає найкоротший реальний секрет (Bug #709):** будь-яка утиліта що маскує секрети у тексті помилки/лога (`redactSecrets`, `maskToken`, `scrub`) з нижнім порогом довжини (`if (s.length < N) continue;`) — поріг обрано «щоб коротка підстрока не зіпсувала текст», але БЕЗ звірки з фактичною довжиною реальних секретів. Секрет коротший за поріг → НЕ маскується → витікає у лог (тут: Checkbox `pin_code` = **рівно 4 цифри**, поріг `<6` пропускав → PIN у `IntegrationLog.error`). Grep: `grep -rnE "\.length\s*<\s*[0-9]|length\s*[<>]=" apps/api/src/common/utils/*redact* *mask*` → для КОЖНОГО секрету у `redact:[...]`/масиві знайти реальну min-довжину (DTO без min-length? тест-фікстура `pinCode:'1234'`? OTP/CVV/verification-код?) і звірити з порогом. Емпірика: `node -e "redactSecrets('pin=1234',['1234'])"` → якщо `1234` лишилось = leak. Fix: знизити поріг до реальної нижньої межі (пропускати лише вироджені 0-2 символи); НЕ підіймати «для чистоти» — leak гірший за over-mask. Перевірити також `split/join` (безпечно) vs `new RegExp(secret)` (ReDoS/crash на спецсимволах). Regression mutation-verified: revert порогу → PIN-тест червоний. Severity: HIGH (CRITICAL якщо секрет = повний токен/пароль). Деталі: «Накопичені підходи» 2026-09-08 (Bug #709).

---

### §1.2 — TypeScript / API якість

```bash
# Dead imports/declarations after page/module split (Bug #204-#205, #726-#727)
# tsconfig зазвичай має noUnusedLocals: false → tsc мовчить про неіснуючий runtime impact,
# але мертві імпорти/типи псують tree-shaking + плутають code review + ламаються коли helper переноситься
# у privately-renamed export. Шукати кожен imported symbol чи реально вживається у файлі-споживачі.
#
# ПЕРВИННИЙ детектор (швидший і повніший за grep нижче): `eslint <changed files>` ловить І мертві
# imports (Bug #726 fmtMoney), І мертві ЛОКАЛЬНІ декларації — interface/type/const (Bug #727 unused
# `interface Paginated`), яких grep-по-import нижче НЕ бачить. Патерн split-файлу (винесення частини
# компонента у новий файл, напр. /inventory-вміст → InventoryTab.tsx) ЗАКОНОМІРНО лишає у старому
# файлі і мертвий import (символ переїхав), і мертвий локальний тип (більше не потрібен). Після
# будь-якого refactor(split)/«винести … у <NewFile>» — обов'язково `eslint` на ОБИДВА файли (донор+новий),
# 0 warnings; будь-який `is defined but never used` у файлі-донорі = dead code внесений сплітом → прибрати.
# Severity LOW (lint-only, runtime не зачеплено), але файл-донор у scope зміни → чистити одразу.
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

# Bug #728: новий тип discriminated-union / enum доданий у backend Zod + read-модель + labels,
# але WRITE-форма (create/edit модалка) його НЕ підтримує → значення недоступне користувачу.
# Сигнал: backend `z.discriminatedUnion('type', [...])` / enum має N варіантів, а форма-білдер
# (buildRateScheme / buildX / EMPTY_FORM / <Select> опції) — менше.
# Крок 1: порахувати варіанти у backend union/enum:
grep -rnE "z\.literal\('|z\.enum\(\[" apps/api/src/modules --include="*.dto.ts" | grep -iE "type|scheme|kind|mode" | head -20
# Крок 2: для КОЖНОГО union/enum знайти write-форму (модалку) що його будує:
grep -rnE "build[A-Z][A-Za-z]*Scheme|EMPTY_FORM|rateType|===\s*'(percent_normo|per_normo_hour|fixed_plus_bonus)'" apps/web/src/components --include="*.tsx" | head -20
# Звірити: чи форма має гілку + input + label + edit-гідрацію для ВСІХ backend-варіантів?
# Пропущений варіант = HIGH (нова можливість фічі недоступна з UI; edit наявного губить тип).
# 4 місця мають бути оновлені разом: LABELS-мапа, EMPTY_FORM поле, edit-гідрація (читання rs.params.*),
# build-функція (гілка+валідація), JSX-input. Пропуск будь-якого = мовчазний write-path gap.

# Bug #729: query-хук фаєрить роль-обмежений GET, бо `enabled` не гейтиться роллю
# (UI-видимість кнопки/вкладки/модалки гейтнули, а сам data-fetch — ні → фонове 403 × retry).
# Сигнал: компонент видимий нижчій ролі (вкладка/сторінка з roles включає RECEPTIONIST/MECHANIC),
# але викликає useQuery-хук БЕЗ enabled-гейта до ендпоінта, чий backend @Roles вимагає вищу роль.
# Крок 1: знайти безумовні query-хуки у компонентах з рольовим prop (canOperate/canManage/canEdit):
grep -rnE "use[A-Z][A-Za-z]*\(\)" apps/web/src/app --include="*.tsx" | grep -vE "enabled|useState|useRef|useMemo|useAuth|useRouter|useSearchParams|useEffect|useCallback|useContext" | head -20
# Крок 2: для компонента з canOperate/canManage/canX — для КОЖНОГО query-хука звірити @Roles ендпоінта:
grep -rn "canOperate\|canManage\|canEdit\|canView" apps/web/src/app --include="*.tsx" -l | head
grep -rnE "@Roles\('OWNER'" apps/api/src/modules --include="*.controller.ts" | grep -vE "RECEPTIONIST|ACCOUNTANT" | head -20
# Якщо хук б'є ендпоінт де RECEPTIONIST відсутній у @Roles, а компонент видимий RECEPTIONIST → 403-fetch.
# Fix: додати `enabled`-параметр у хук + передати рольовий prop (`useX(false, canOperate)`).
# Live-доказ: DB-flip ролі (`employee.role=RECEPTIONIST`) → login → curl ендпоінт → 403 = баг.
# Регресія: component-тест мокає хук і асертить `toHaveBeenCalledWith(..., canOperate)` для обох гілок.

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
- [ ] **Same-data-другий-namespace invalidation gap: dashboard/summary-віджет читає окремий query-namespace, який мутація ресурсу НЕ чіпає (Bug #718):** відрізняється від cross-resource (#210/#590 — той про СЕРВЕРНІ side-effects на іншому ресурсі). Тут той САМИЙ ресурс матеріалізується у ДРУГЕ дерево query-ключів на іншій сторінці/віджеті — типово дашборд/summary/badge-count, що свідомо тримає власний namespace (`dashboardKeys.*`, `<x>SummaryKeys.*`, `notificationsKeys.count`), щоб TopShell-prefetch/SSE-stream керували ним незалежно. Мутація ресурсу робить `invalidateQueries({queryKey: <x>Keys.all})` і вважає справу закритою — але дашборд-віджет під `dashboardKeys.<widget>()` лишається стале до staleTime (і TopShell route-prefetch `/dashboard` часто НЕ перелічує цей віджет → навіть навігація на дашборд його не рефрешить). **Найгостріше — коли віджет фільтрує за станом, який мутація змінює** (expiring читає `claimedAt=null` → claim мусить прибрати рядок; low-stock badge → writeoff; unpaid-count → payment): stale-віджет показує вже-неактуальний рядок як актуальний. Grep: `grep -rn "dashboardKeys\.\|SummaryKeys\.\|Keys\.count\b" apps/web/src/hooks/api` → для кожного summary/widget-ключа знайти ресурс, який його наповнює, і перевірити що КОЖНА мутація того ресурсу (`use<X>Create/Claim/Complete/Cancel` у `use*.ts`) інвалідує І `<x>Keys.all` І цей widget-ключ. Reference-fix: `invalidateWarrantyAffected(qc)` (cache-invalidation.ts) інвалідує `warrantiesKeys.all` + `dashboardKeys.expiringWarranties()`; дзеркалить `invalidateStockAffected`/`invalidateBalanceAffected` (обидва вже кидають `dashboardKeys.all`). Fix-pattern: cross-namespace хелпер у `lib/cache-invalidation.ts`, обидві мутації кличуть його в `onSuccess`. Regression-guard: hook-тест зі spy на `client.invalidateQueries` → assert widget-ключ присутній (revert onSuccess до own-keys-only → fail). Severity MEDIUM (UX stale, до staleTime); HIGH якщо віджет гейтить фінансове рішення. **Де шукати ще:** low-stock badge (inventory writeoff/receipt), unpaid-invoices count (payment), upcoming-ТО (maintenance mutate), notification-count.
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
- [ ] **Non-type-aware name/required guard рахує значення УМОВНО-ПРИХОВАНОГО поля як валідне (Bug #739):** будь-яка форма що ПРИХОВУЄ поля залежно від дискримінатора (`{f.type !== 'SUPPLIER' && <FirstNameInput/>}`, `mode==='X' && ...`, `category==='Y' ? ...`) АЛЕ валідує «є хоч якась назва/значення» незалежним від того ж дискримінатора guard-ом (`companyName || firstName || lastName`) — приховане поле лишає ненульове значення у стані форми (напр. лишок після перемикання типу), guard рахує його як валідне → submit проходить → у БД сутність де «назва» = поле недоступне для перегляду/редагування у цьому UI. Кнопка `disabled={!hasName(form)}` та submit-guard обидва хибно-зелені. Grep: `grep -rnE "f\.type !== |mode === |=== 'SUPPLIER'|&& <.*Input" apps/web/src/components/ui/*Form.tsx *Modal.tsx` → для кожного умовно-рендереного input перевірити чи його значення входить у name/required-guard БЕЗ звірки з тим самим дискримінатором. **Обидва шари:** frontend guard (`validate*`/`hasName`) І backend cross-field guard (`hasCounterpartyName`) мають бути type-aware — сирий API-виклик оминає FE. При editable-дискримінаторі (type тепер PATCH-able): backend merged-guard МУСИТЬ брати ЕФЕКТИВНИЙ (пост-PATCH) type (`dto.type ?? existing.type`), інакше зміна X→Y за старим типом. Fix: винести type-aware guard у спільний компонент (єдине джерело), reuse у модалці+DetailPage+backend. Регресія (mutation-verified): FE-тест «SUPPLIER+приховане ім'я→валідація падає»; BE-spec «create/update SUPPLIER лише firstName→400», «CLIENT→SUPPLIER без companyName→400». Severity HIGH (тихе порушення бізнес-інваріанта «SUPPLIER має companyName» + осиротіле недоступне поле, масковане displayName-fallback). Де ще: будь-яка форма з type/mode/category-залежним прихованням полів + агрегатний required-guard (Counterparty, Good pricing-mode, Employee rate-scheme, WorkOrder vehicle-vs-anonymous). Деталі: «Накопичені підходи» 2026-09-13 (Bug #739).
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
- [ ] **Застарілий коментар після інверсії доменного арифм. оператора `/`↔`*` у ІНШОМУ шарі (Bug #737):** commit що інвертує семантику множника/дільника (coefficient `qty/coeff`→`qty*coeff`, rate, VAT-дільник, знижка) править арифметичні САЙТИ + backend-коментарі, але лишає паралельні коментарі-обґрунтування guard-ів у frontend/mobile/shared зі старою семантикою («divide-by-zero», «Infinity», «дільник»). Guard часто ще коректний → tsc/тести/review зелені, брехливий лише коментар → вводить в оману майбутнього розробника money/stock-конверсії. Grep ПІСЛЯ будь-якого коміту-інверсії: `grep -rn "divisor\|divide-by-zero\|Infinity\|дільник\|/ *coeff\|qty */ *co" apps packages --include="*.ts" --include="*.tsx" | grep -iE "coeff|qty_base|base" | grep -iv "множник\|multiplier\|\* *coeff"` → кожен збіг у шарі поза diff коміту = кандидат-застарілий. Крос-шаровий фокус: backend-формулу оновлено → перевір frontend guard-и того ж поля. Fix: переписати коментар під нову семантику, guard не чіпати якщо коректний для обох; переконатись що guard дійсно валідний під нову формулу (множник 0 обнуляє кількість → `coeff<=0` доречний з іншої причини). Severity LOW (коментар-only; MEDIUM якщо застарілий коментар «виправдовує» тепер-НЕкоректний guard — вже логічний баг). Де ще: будь-яка інверсія оператора з наміром продубльованим у 2+ шарах: coefficient (fixed), currency rate, VAT `/1.2`↔`*0.2`, знижка `price*(1-d)`↔`price-price*d`, half-away-rounding напрям. Деталі: «Накопичені підходи» 2026-09-13.

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

| Сервіс                      | Критичні кейси                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------- |
| `work-orders.service`       | create→DRAFT; FSM invalid→throws; IN_PROGRESS→RESERVATION; COMPLETED→WRITEOFF+CHARGE  |
| `inventory.service`         | RECEIPT +qty; RESERVATION -available; WRITEOFF insufficient→throws; qty=0→throws      |
| `settlements.service`       | CHARGE +balance; PAYMENT -balance; no account→NotFoundException                       |
| `auth.service`              | login OK; wrong password→401; deleted employee→401; invalid refresh→401               |
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
- [ ] **Flaky component-тест: дефолтний waitFor timeout (1000ms) під повним паралельним suite (Bug #746):** якщо повний `vitest run src` падає `1 failed | N passed` на `await waitFor(() => expect(...))` БЕЗ явного timeout, але `vitest run <той-самий-файл>` в ізоляції — all green → це async-flush **starvation** під паралельним навантаженням (важкий environment/transform setup суміжних файлів), НЕ продуктовий баг. Типовий носій: модалка з async-mount (reference-fetch каси/банку/методів через React Query) + POST-round-trip `mutateAsync`→`apiFetch` (SupplierPaymentCreateModal, будь-яка `*CreateModal.test.tsx`/`*EditModal.test.tsx`). Дефолтний waitFor=1000ms замалий. У repo вже усталений патерн `{ timeout: 2000 }` (CreateWorkOrderModal.test.tsx:103, DocumentCreateModals.test.tsx:214, command-palette.test.tsx:146) — новий/дедуплікований spec його не успадкував. Grep кандидатів: `grep -rLn "timeout:" apps/web/src/**/__tests__/*.tsx` серед файлів з `mutateAsync`/`apiFetch` POST + `waitFor`. **Фікс — у ТЕСТІ, не компоненті** (продуктовий інваріант — idempotency/double-submit/rollback — верифікується в ізоляції): додати `{ timeout: 2000 }` до всіх async `waitFor`/`findBy` у spec-і; верифікувати повторним ПОВНИМ прогоном ×2-3. Severity MEDIUM (flaky false-negative блокує CI/коміт, маскує реальні падіння шумом). Деталі: «Накопичені підходи» 2026-09-15 (Bug #746)
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

Якщо **НІ** — одразу оновити скіл:

1. Додати новий пункт у відповідний розділ SKILL.md (§1.1–§1.7) з grep-командою
2. Записати підхід у **`sto-tester-approaches.md`** (найновіше зверху, формат нижче)
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

## Накопичені підходи → окремий файл

> Журнал накопичених патернів багів винесено у **`sto-tester-approaches.md`** (структурний split, TD3 —
> був ~2575 рядків, 68% файлу). Читай його ЗА ПОТРЕБОЮ: перед статичним аналізом (Крок 1), щоб звірити
> чи знайдений баг уже описаний, і на Кроці 7, щоб дописати новий патерн.
>
> `→ дивись sto-tester-approaches.md` — формат запису (Сигнал/Фікс/Severity/Де ще) і всі bug-номери там.

---

## Що вже перевірено (не дублювати)

**Backend:** ✅ FSM transition map (work-orders.fsm.ts) · InventoryService guards (quantity=0, available<qty, RESERVATION_RELEASE) · SettlementsService guards (CHARGE↑, PAYMENT↓) · Soft-delete всі основні сервіси · Resurrection pattern (currencies, exchange-rates, brands, units, payment-methods) · Org-scoped FK validation перед write (goods brandId/unitId/preferredSupplierId #161, invoices/work-orders clone #90) · $transaction explicit timeout (всі interactive callbacks) · ParseUUIDPipe (всі :id) · Security headers (@fastify/helmet@11) · SSRF guard webhooks.processor (validatePublicUrl+redirect:'manual') · ArrayMaxSize (inspection.dto, webhook payload) · Deploy phase18: docker api healthcheck node-http /api/health (#164/#165), minio `mc ready local`+пін RELEASE (#170), root .dockerignore (#166), build-prod.ps1 export→apps/web/out+$PSScriptRoot fallback (#167), nginx \_next/static immutable+gzip_types svg/js (#168), /api/health публічний. minio/minio=лише mc (перевірено емпірично).

**Frontend:** ✅ cancelled flag (AuthProvider, всі mount-fetches) · SSR-safe today (useState(null)+useEffect) · apiFetch error array join · UUID validation client-side · aria-label на іконкових кнопках · React named imports · React Query Sprint B: QueryClient singleton (staleTime 30s, retry 1, refetchOnWindowFocus false), 5 query hooks (workOrders/invoices/counterparties/inventory/purchaseOrders) з queryKey factory, cross-resource invalidation (PO receive→inventory, PO apply-pricing→inventory, work-orders create→workOrders #210-#212), useWorkOrders.test.tsx як зразок (12 кейсів).

**Tests:** ✅ Contract specs: auth, work-orders, warehouses, counterparties, sync, settings, audit, pricing-rules, batches, currencies, bank-accounts, exchange-rates, cash-registers, calendar (GET/POST/PATCH/DELETE resize/drag) · Service specs (query-shape): goods (FK), counterparties (?q= plural customerGarages→vehicles #163), work-orders (findAll calendarSlots plural+take:1+deletedAt+orderBy asc; ?q= counterparty nested; employeeId some soft-delete #171) · Pricing: COST_TIER tier matching, brandId priority over goodType (#179) · Calendar timeline px→time clamp усі гілки; isEditingPast minHour-boundary · Property-based invariants: inventory, settlements, FSM (26 invariants) · Component tests: 148/148 (14 файлів) · E2E: 42/42 (smoke, console-errors serial, inventory, api-errors).
