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

- [ ] **Нове enum value без regression-guard у contract+service spec (Bugs #478-#480):** будь-який commit вигляду `feat(<scope>): add <NEW_VALUE> to <Enum>` що змінює (а) Prisma schema enum + migration `ALTER TYPE ... ADD VALUE`, (б) `@IsEnum([...])` whitelist у Create/Query DTO, (в) backend service maps (`MOVEMENT_TYPES[NEW]`, `docTypeMap[NEW]`), (г) frontend hardcoded array — ОБОВ'ЯЗКОВО має парні regression-тести для нового значення у `*.contract.spec.ts` І `*.service.spec.ts`. Grep: `grep -rn "<NEW_VALUE>" apps/api/src/modules/<scope>/ --include="*.spec.ts"` — 0 matches = bug. Мінімальний набір regression-guards: (1) POST з `type: NEW_VALUE` → 201 + service отримує dto.type=NEW_VALUE; (2) GET з `?type=NEW_VALUE` → 200 + service.findAll отримує NEW_VALUE; (3) `transition(NEW-doc, CONFIRMED)` (або equivalent FSM-step) → асерти на map-резолв (`docNumbers.next(orgId, PARENT_DOC_TYPE)`, `inventory.createMovement type=StockMovementType.NEW`), branch logic (`toHaveBeenCalledTimes(1)` — не як TRANSFER з двома), sign quantity (`.toBeGreaterThan(0)`). Якщо service spec ВЗАГАЛІ нема — створити новий (як `stock-documents.service.spec.ts` у f59c6a47). Без guards: refactor що видаляє `NEW: StockMovementType.NEW` з MOVEMENT_TYPES або додає `NEW` у TRANSFER-branch проходить CI зеленим, runtime отримує 400/«Непідтримуваний тип документу». Severity HIGH. Where else: `WorkOrderStatus`, `InvoiceStatus`, `PurchaseOrderStatus`, `StockMovementType`, `DocumentType`, `PaymentMethod`, `CounterpartyType`, `EmployeeRole`, будь-який backend service з `switch (type)` або `Record<EnumType, X>` map.

- [ ] **Shared FE constant без парної backend константи (Bug #432):** будь-який commit що додає `export const <NAME>_STATUSES`/`<NAME>_TRANSITIONS` у `packages/shared/src/constants/*.ts` І оновлює FE-компоненти щоб використати її, ПОВИНЕН паралельно мати backend константу у `apps/api/src/modules/<entity>/<entity>.fsm.ts` (або `*.constants.ts`). Backend service-файл НЕ має містити inline `['LITERAL_A', 'LITERAL_B']` що дублює значення shared константи — інакше FE = single source of truth (порушує SKILL §1.3 Bug #401 принцип «BE — single source, FE — mirror»). Grep: для кожного нового shared `<NAME>_STATUSES` literal-array → `grep -rnE "'<literal-A>', '<literal-B>'" apps/api/src --include="*.ts" | grep -v spec` → matches = bug. Особливо CRITICAL коли whitelist гейтить financial/legal ops (invoice creation, completion-act). Парне з Bug #401 (FE↔BE status whitelist symmetry — там FE асиметричний за подію; тут структурна gap до first-class const). Регресія-guard: spec у `*.fsm.spec.ts` `expect(BE_STATUSES.sort()).toEqual([...FE_STATUSES].sort())`. Severity HIGH. Where else: будь-який модуль з FSM/gate-whitelist (PO, Invoice, StockDocument, CompletionAct, Calendar slots).
- [ ] **Audit-track list ↔ update.data symmetry (Bug #433, family Bug #421):** для КОЖНОГО `service.update()` що має `auditService.record(...)` поряд з `prisma.X.update({ data: { ...fields } })` — keys у audit-track array (`['fieldA', 'fieldB', ...] as const).forEach(trackField)` ⊇ keys у data-payload. Якщо data пише поле що НЕМАЄ у audit-list → AuditEvent.diff силенто порожній для цього поля → compliance/bookkeeping gap. Особливо ризиково для FK (`liftId`, `branchId`, `contractId`), документ-дат, фінансових сум. Свіжий `fix(tester): Bug #N audit gap` commit означає що один specific field виправили, але **уся сімʼя fields у тому ж update()** залишилась підозрілою — split-fix pattern. Grep: ручний audit для кожного service.update() з audit-list — diff data-keys vs audit-keys; будь-який diff > 0 = bug. Регресія-guard: spec `it('update() diff включає <new field> якщо у dto')`. Severity HIGH (audit-trail). Where else: усі `*.service.ts` що мають update + auditService — особливо ті що нещодавно мали додавання нового поля.
- [ ] **Cross-endpoint status-filter inconsistency для одного resource (Bug #415):** для КОЖНОГО resource з status-enum (`Invoice.status`, `WorkOrder.status`, `Payment.status`) — звірити status filtering між усіма ендпоінтами що оперують одним resource. Типова асиметрія: `findByX(parentId)` має `status: { not: 'CANCELLED' }`, але `getLinkedY(parentId)` / `getCountsZ(parentIds)` — БЕЗ status фільтра. Result: badge count показує "2 invoices" коли активний 1 (другий CANCELLED), користувач відкриває панель → бачить мертвий запис → confused UX. Pre-check `createFromX` тоді блокує "вже існує", але badge показав 2 — користувач сприймає як bug. Grep: для кожного `prisma.<model>.find*/count/groupBy` query — перевірити чи `where.status` уніфікований через усі service-методи того ж модуля. Якщо `findByWorkOrder` exclude CANCELLED АЛЕ `getLinked*/`/getCounts` include — bug. Imp: import enum (`InvoiceStatus`) з `@prisma/client`замість string literal`'CANCELLED'` — TS catches typo + renaming. Severity LOW (UX inconsistency); MEDIUM коли inconsistency caused decision-making error. Регресія-guard: contract spec кейс «WO має 1 CANCELLED + 1 DRAFT → counts.X===1». Парне з Bug #401 (FE↔BE status whitelist symmetry — той самий принцип, інший рівень).
- [ ] **Concurrent-create race for "1 active per parent" resources без unique index (Bug #412):** будь-який service-метод що створює дочірній resource з логіко-унікальним FK (`Invoice.workOrderId`, `FiscalReceipt.paymentId`, `InspectionReport.workOrderId`) використовуючи pattern `find existing → if (existing) throw → create` БЕЗ обгортки у `$transaction({ isolationLevel: 'Serializable' })` АБО без `@@unique` partial-index на FK = race-window для дублікатів. Два паралельних POST (double-click через UI lag, два tab-и, два admin) обидва бачать `existing === null` між findFirst і create → 2 invoice створено з тим самим `workOrderId`. Grep: `grep -rnE "async (create|createFrom|issueFor|generateFor)[A-Z]" apps/api/src/modules --include="*.service.ts"` → для кожного знайти `findFirst({ <fkField>: id })` prep-check ПЕРЕД `create()` → перевірити schema.prisma на парний `@@unique([<fkField>])` АБО Serializable $tx. Fix-pattern: pre-fetch `docNumbers.next()` (свій внутрішній $tx), потім обернути read+create у Serializable з re-check existing всередині; map P2034 → friendly BadRequestException. `DocumentNumberService.next()` серіалізує лише ПО docType, НЕ по parent FK — не достатньо для invariant "1 active per parent". Severity HIGH (фінансовий ризик). Регресія-guard: service spec з 2-3 кейсами (existing у pre-check → 400, status guard → 400, non-existent WO → 404).
- [ ] **Inner $tx re-check тест для Serializable race fix (Bug #416, paired with #412):** для КОЖНОГО service-метода з Bug #412 фіксом (`$transaction({ isolationLevel: 'Serializable' })` з inner `tx.X.findFirst` re-check) — парний `*.spec.ts` має ОКРЕМИЙ test з `mockResolvedValueOnce(null).mockResolvedValueOnce({id})` sequence + `expect(prisma.X.create).not.toHaveBeenCalled()`. Без цього тесту видалення `const existing = await tx.X.findFirst(...); if (existing) throw ...` блоку у refactor (типовий "цей блок дублює pre-check вище") пройде CI зеленим — CRITICAL race window повертається. Grep: для кожного `$transaction.*Serializable` у service.ts → у парному `.spec.ts` шукати `mockResolvedValueOnce` для того ж `findFirst` ДВА рази підряд. Якщо тільки один `mockResolvedValue` (constant) → gap. Severity MEDIUM (regression risk для CRITICAL fix). Ключовий assert: `expect(prisma.<resource>.create).not.toHaveBeenCalled()` — інакше тест-зелений-проходить навіть при видаленні re-check (бо pre-check теж кидає з тим же moc-setup).

- [ ] **`Partial<Record<Enum, V>>` lookup map з runtime fallthrough (Bug #488):** будь-який `Partial<Record<<EnumType>, V>>` у service-методі для look-up знаку/типу/factor (BALANCE_SIGN, MOVEMENT_FACTOR, TAX_RATE) — потенційний gap у TS-exhaustiveness. `Partial<>` дозволяє додавання нового enum value через Prisma migration `ALTER TYPE ... ADD VALUE` БЕЗ compile-error → runtime throw у проді коли новий тип потрапляє до lookup. Grep: `grep -rnE "Partial<Record<[A-Z][a-zA-Z]+(Type|Status|Role|Kind),\s" apps/api/src/modules --include="*.ts" | grep -v spec`. Якщо ВСІ enum values уже у map → `Partial<>` непотрібно (видалити + видалити runtime guard). Якщо проєктно потрібен partial — задокументувати inline + додати regression-guard для default-branch. Парне з Bug #478-#480 (enum coverage у contract+service spec). Severity MEDIUM (release-blocker якщо gating financial operation: settlement/payment/tax).

- [ ] **Alternate-mutation endpoint обходить canonical guards (Bug #403):** будь-який backend service-метод що **мутує той самий resource** що і `update()`/`addLine()`/`removeLine()` АЛЕ зі своєю окремою сигнатурою (`refreshFromWorkOrder`/`syncFromX`/`importFromY`/`recalculateZ`/`refreshFromExternalSource`...) — ПОВИНЕН повторити ВСІ business-guards канонічного `update()`. Типові guards що пропускаються: (а) `if (X.status !== 'DRAFT') throw BadRequestException` (FSM-readonly для submitted/paid/sent статусів); (б) `if (existing.isLocked) throw ...` (manually locked records); (в) `if (existing.isSystem) throw ...` (seed-керовані); (г) prep-check unique-constraint конфлікту. Сценарій: оригінальний `update()` має FSM-guard `!DRAFT → throw`; альтернативний endpoint забуває цей guard → перезаписує дані SENT/PAID/locked record-у без error → silently corrupts data. Grep: `grep -rnE "async (refresh|sync|import|recalculate|regenerate|rebuild)[A-Z]" apps/api/src/modules --include="*.service.ts"` — для кожного знайденого метода: знайти canonical `update()`/`updateLine()`/`updateX()` у тому ж файлі, скопіювати ВСІ `if (...) throw` guards (особливо `inv.status !== 'DRAFT'`, `existing.status !== ...`), перевірити що alternate-метод їх має. Парний підхід: будь-який mutation що приймає workOrderId/parentId і робить `deleteMany + createMany` на child resource (full overwrite) — обов'язково prep-check status батьківського resource через `if (parent.status !== <ALLOWED>) throw`. Severity CRITICAL (фінансовий ризик для invoice/payment/settlement resources). Регресія-guard: contract spec для alternate endpoint що мокає existing.status=non-DRAFT → 400.

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
```

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
- [ ] **`setX(value)` викликається, але `x` не читається у JSX (Bug #497, sub-patern Bug #160):** на відміну від класичного dead-state (setter не викликається І value не читається — обидві сторони мертві), цей варіант **гірший**: setter ВИКЛИКАЄТЬСЯ під час async-операцій (`apiFetch`/`mutateAsync`), state перерендерить компонент, але value НІКОЛИ не зчитується у JSX → user не бачить loading-spinner/disabled-state/error-banner під час operation. На відміну від dead state — тут є performance impact (extra renders) + UX gap. Grep: `grep -rnE "useState[<(](bool|number|null|string)" apps/web/src/app --include="*.tsx" -A 5` → для кожного state-name взяти grep по файлу: `grep -nE "\b<name>\b" $file` — якщо є тільки декларація + setter calls але **немає** читання `{<name> && ...}`/`disabled={<name>}`/`loading={<name>}` у JSX → bug. Найчастіше: `detailLoading`/`loadingId`/`saving` після refactor що видалив conditional render. Severity MEDIUM (silent UX). Фікс: ЛИБО видалити state (якщо feature не потрібна), ЛИБО додати render-time consumption (loading-button, spinner, disabled-row). Особливо ризиковано коли state описує per-row tracking — `detailLoadingId: string | null` дозволяє per-row loading-state на action-кнопках.
- [ ] **`mutateAsync()` у inline click-handler без try/catch — silent failure (Bug #499):** TanStack Query mutation hook без `useMutation({onError})` АБО без global `MutationCache.onError` у `QueryClientProvider` config → `await mutateAsync` throw перериває handler. Якщо handler має `toast.success` ПІСЛЯ await — success тост не показується, але також НЕ показується error тост. Користувач клікнув "Видалити" → нічого не відбулось → бачить що рядок все ще там → плутанина. Grep: `grep -rnE "await\s+\w+\.mutateAsync\(" apps/web/src/app --include="*.tsx" -B 1 -A 2` — для кожного match перевірити: (а) `try/catch` обгортка; АБО (б) hook має `useMutation({onError: ...})`; АБО (в) `MutationCache.onError` глобально. Якщо жодного з трьох — bug. Cross-check: `grep -rn "MutationCache\|mutationCache:" apps/web/src` — якщо взагалі немає global onError, КОЖЕН inline mutateAsync без try/catch = bug. Severity MEDIUM (silent failure, user confusion). Фікс-pattern inline: `try { await mut.mutateAsync(); toast.success } catch (e) { toast.error(e.message) }`. Альтернативний фікс (preferable): додати `onError` у сам hook — спрацює для ВСІХ callers. Регресія-guard: vitest mock mutation з `mockRejectedValue` → click button → assert `toast.error` called.
- [ ] **Dead state cleanup у paired файлах після review (Bug #496, paired with Bug #341):** коли review-fix commit ВИДАЛЯЄ dead state з одного файлу (наприклад `selectDoc`/`toggleSelectDoc` у stock-documents), часто паралельний файл (`purchase-orders/page.tsx`, `invoices/page.tsx`) має **той самий патерн** — `useState<X | null>(null)` + setter тільки до `null` + ніколи non-null. Grep: для кожного `useState<\w+\s*\|\s*null>` у `apps/web/src/app/(app)/**/page.tsx`: підрахувати кількість `setName(<value>)` де value НЕ `null` → якщо 0 → dead state. Pair-check: якщо review-fix щойно видалив dead state з одного `<entity>/page.tsx` → пройти ВСІ інші list-pages (`grep -rln "DetailPanel\|<entity-name>Panel" apps/web/src/app/(app)`) і перевірити. Severity HIGH якщо state годує панель/модал що рендериться у JSX (feature мертва). Регресія-guard: vitest snapshot тест на JSX → щоб видалення DetailPanel не пройшло як silent regression.
- [ ] **URL deep-link writer без парного reader (Bug #596):** будь-який `router.push('/<page>?<param>=<value>')` де таргет-сторінка НЕ має `searchParams.get('<param>')` handler → deep-link мертвий (кнопка перекидає у голий список без візуальної відмітки/дії). Класика: `/supplier-payments/[id]` пушить `?highlight=<poId>` а `/purchase-orders/page.tsx` не читає → 0 UX-ефекту. Grep-команда: для кожного writer `grep -rnE "router\.(push|replace)\(\`?[/'\"]<page>[^)]_\?[a-z]+=" apps/web/src --include="_.tsx"`— витягти`<param>`name, потім`grep -n "searchParams.get\('<param>'\)" apps/web/src/app/\*\*/<page>/page.tsx`. Якщо 0 matches → broken deep-link. Fix pattern: (а) reader додає `useEffect(() => { const v = searchParams.get(<param>); if (v && ...валідно) { setState(v); params.delete(<param>); router.replace... } }, [])` — ідемпотентний, mount-only (свідомо БЕЗ deps щоб refresh не спамив дію); (б) якщо feature непотрібна — просто прибрати param у writer. Severity: LOW (broken UX-feature, не data loss); MEDIUM якщо feature розрекламована tooltip'ом/label'ом («відкрити картку X» → нічого). Where else: будь-який pair сторінок з cross-linking (`/counterparties/[id]`↔`/work-orders`, `/vehicles/[id]`↔`/work-orders`, `/invoices/[id]`↔`/counterparties`).
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

### 2026-09-02 — після фінансової migration з backfill: audit invariant через live API (Bug #606, #607, #608) — api / backend / frontend / financial-integrity / migration-verification

**Сигнал:** commit виду `fix(settlements): виправлення знаку` / `add enum value + backfill` / будь-яке `packages/database/prisma/migrations/*_backfill_*`. Знак/тип-специфічна логіка (BALANCE_SIGN, вид документа → тип транзакції). Міграція має 2 стадії: (1) ADD ENUM VALUE окремо (Postgres constraint — не можна вживати нове значення у тій самій транзакції); (2) DML backfill (`UPDATE ... SET type=...` + `UPDATE ... SET balance = Σ signed(tx)`).

**Причина виникнення:** знак балансу = чиста функція типу транзакції; але семантика **різна для клієнта і постачальника** (CHARGE:+1 для клієнта = "нам винен" правильно; але той самий CHARGE:+1 для постачальника означав би "постачальник нам винен" — тоді як фактично **ми винні йому**). Old-code `receive() → CHARGE` мовчки писав неправильний знак → баланси постачальників уперто додатні → `getSchedule` (фільтр balance<0) не бачив жодного → feature "мертва" на реальних даних, але тести проходять (spec-level `type='CHARGE' → balance += amount` семантично коректний). Fix: розщепити на 3 нові enum-значення (SUPPLIER_CHARGE/PAYMENT/REFUND) + backfill re-type історичні transactions по строгих `documentType` + recompute balance = Σ signed(tx). У фронтенд-двох місцях знак-код паралельно розходиться (Bug #606).

**Підхід до виявлення:**

1. **Live invariant sweep** — для КОЖНОГО акаунта: `balance == Σ BALANCE_SIGN(tx.type) × tx.amount`. Python-скрипт через API endpoints (`/counterparties/:id/balance` + `/counterparties/:id/transactions?limit=500`); дзеркальний BALANCE_SIGN словник у скрипті. 139 counterparties за <60s. Гарантує ідемпотентність backfill.
2. **Cross-source coherence** — `/reports/settlements` (totalCredit) vs `/supplier-payments/schedule` (totals.total): має збігатися по СУМІ **для активних (не-deleted) SUPPLIER/BOTH** counterparty (обидва фільтри однакові). Різниця = docstring trade-off (CLIENT balance<0 = переплата = не входить у schedule). Якщо `reports` НЕ фільтрує soft-deleted, а `schedule` фільтрує → різниця = сума боргу soft-deleted CP → **знак-баг у одному з них** (Bug #607).
3. **Frontend sibling-drift audit** — grep всіх копій `TX_TYPES / balance>0 ? 'destructive' : 'success'` heuristics: не менше 2 файлів (список settlements + картка CP), може бути й у панель-схемах, dashboard-widgets, PDF-templates. Bug #606 сценарій: після enum-розширення обидва місця треба переоцінити семантично (тип-aware colouring; **CLIENT vs SUPPLIER мають РІЗНУ шкалу проблема/OK**).
4. **BALANCE_SIGN exhaustiveness assert** — vitest `Object.values(SettlementTransactionType).forEach(t => expect(BALANCE_SIGN[t]).toBeDefined())` + явні `expect(BALANCE_SIGN.CHARGE).toBe(1)` на кожен ключ. TS-exhaustive `Record<enum, ...>` дає compile-time guard проти НОВОГО enum-value без запису, але не проти зміни СЕРЕДНЬОГО ключа з `1` на `-1` (реальний Bug #606 root cause).
5. **Ланцюг end-to-end через API** (сценарій #1): receive(X) → partial SP(Y, Y<X) → balance = −(X−Y); графік показує залишок. Verify SUPPLIER_REFUND(+1) на живому SR — schedule оновлюється, tx-log містить `SUPPLIER_REFUND` рядок (не `REFUND`).
6. **Client-regression proof** — вибірково для 5-10 CLIENT-акаунтів: `Counter(tx.type)` не містить жодного `SUPPLIER_*`. Backfill не re-typed клієнтські transactions (WorkOrder/Payment documentType недоторкані).

**Підхід до фіксу:**

- **Тип-aware UI helper** у `lib/utils.ts`: `settlementBalanceTone(balance, type)` → `'destructive'|'warning'|'success'|'muted'`. CLIENT>0=red / <0=warning; SUPPLIER<0=red / >0=warning; BOTH=nonzero→red (attention-first, тип-нейтральний). Всі balance-header-и (settlements list, CP detail card, dashboards, panels) імпортують з ONE МІСЦЯ.
- **Nested soft-delete filter** у звітах над settlement-акаунтами: `where.counterparty = { deletedAt: null }`. Кросс-endpoint узгодженість (report ↔ schedule).
- **Regression tests** у settlements-invariants: (а) BALANCE_SIGN exhaustive by-enum-value assert; (б) property-based `partial cycle: receive(X) − pay(Y) + refund(Z) → −(X−Y−Z)`; (в) BOTH-mix: `CHARGE(clientDebt) + SUPPLIER_CHARGE(supDebt) → balance = clientDebt − supDebt` (знаки не інтерферують).

**Severity:** HIGH (гроші, фінансові UI/reports узгодженість). Не CRITICAL бо backfill спрацював коректно (invariant 139/139) — але наступна фінансова зміна знаку могла б викликати silent drift.

**Де шукати ще:**

- Reconciliation act (settlements-account.service:133) — вже використовує BALANCE_SIGN, але **новий** endpoint над settlement-транзакціями (aggregate/export/pdf) може дублювати логіку. Grep: `type ==?= 'CHARGE'|'PAYMENT'|'REFUND'`.
- Dashboard KPI-віджети (`apps/web/src/app/(app)/dashboard/*`) — якщо є "заборгованість" картки, які фільтрують по balance sign, треба тип-aware evaluate.
- PDF-templates акту звірки — свій копі-код знаку у `pdfmake` docDefinition.
- Sync-outbox (`apps/api/src/modules/sync-outbox`) — якщо там pending SettlementTransaction зі старими типами (не мали backfill бо не commited), треба check migration coverage.
- Mobile app (`apps/mobile/src`) — якщо є settlements-екран з локальним copy-in знаку.
- Виправлення знаку в reports/schedules — треба перевірити чи не залежить від нього публічний API contract (share-token публічний акт-of-recon PDF).

---

### 2026-09-01 — restore() без парент-chain guard → silent orphan (Bugs #601, #602, #603) — api / backend / data-integrity / soft-delete

**Сигнал:** новий `POST /:id/restore` endpoint над child-агрегатом (Vehicle всередині CustomerGarage всередині Counterparty; CounterpartyContract всередині Counterparty; Invoice всередині WorkOrder; etc.). `service.restore()` робить atomic `updateMany({ where: { id, orgId, NOT: { deletedAt: null } }, data: { deletedAt: null } })` — тінш prep-check на активність parent(-ів). Але sibling `create()` / `findX()` / `updateX()` / `removeX()` того ж модуля мають parent-guard: `findFirst({ id: parentId, orgId, deletedAt: null })` → 404. Асиметрія: guards для читання/створення/зміни ≠ guards для відновлення. Live curl: `DELETE child` → `DELETE parent` → `POST child/restore` → **201** (silent orphan: child.deletedAt=null, parent.deletedAt=not-null; `GET parent/children` → 404 бо parent-guard, а `GET /children/{childId}` — 200 бо шукає тільки за `orgId` + `deletedAt: null`).

**Причина виникнення:** новий restore-endpoint копіює pattern з простих моделей (brands, colors — flat, без FK на soft-delete-able parent). Розробник фокусується на: (а) atomic updateMany з `NOT:{deletedAt:null}` (race-safety); (б) `NotFoundException` на count===0; (в) tenant `orgId` у where. Пропускає: chain-parent activity. Особливо небезпечно для 2-3 рівнів (Vehicle → Garage → Counterparty): треба joined-check. Live-verifiable за 30 секунд curl, але tsc/vitest без DB-integration тестів — зелені.

**Підхід до виявлення:**

```bash
# 1. Знайти всі async restore методи
grep -rn "async restore" apps/api/src/modules --include="*.service.ts" -A5

# 2. Для кожного знайденого - чек чи є parent-guard findFirst({id: parentId, orgId, deletedAt: null}) ПЕРЕД updateMany
# Grep за idiom "findFirst" у тому самому методі. Якщо тільки `updateMany` — gap.

# 3. Схема parent-chain: відкрити schema.prisma, знайти model X, знайти всі relation fields
# з `? =` (nullable/optional), перевірити чи parent-model має `deletedAt DateTime?` (soft-delete-able)

# 4. Live-perevirka curl-скриптом:
#    (a) create parent → create child; (b) DELETE child; (c) DELETE parent;
#    (d) POST child/restore → якщо 201 = bug
```

**Підхід до фіксу:** ОДИН `findFirst` перед atomic-restore що (а) знаходить child (включно з `deletedAt:not-null` — це і є "to be restored"), (б) SELECT parent-chain з `deletedAt` полями через nested include/select, (в) distinguisher-логіка:

- child не знайдено / чужа org → `NotFoundException`
- child вже активний (double-restore) → `NotFoundException` (та сама 404-семантика)
- parent chain has any `deletedAt !== null` → `BadRequestException` з друnestly-friendly text ("Контрагента авто видалено. Спочатку відновіть контрагента.") — з ПРІОРИТЕТОМ найдальшого предка (CP > garage), бо восстановлення CP автоматично зробить дитячі-restore можливими.

Приклад для Vehicle (2 рівня): `prisma.vehicle.findFirst({ where: {id, orgId}, select: { deletedAt: true, customerGarage: { select: { deletedAt: true, counterparty: { select: { deletedAt: true }}}}}})` → 4 guards у порядку CP > garage > double-restore > tenant.

Для CounterpartyContract (1 рівень): окремий `counterparty.findFirst({id:cpId, orgId, deletedAt:null})` — простіше, дзеркалить sibling-guards (findContracts, createContract, updateContract, removeContract усі мають цей check).

**Severity:** HIGH (data corruption через public API, silent orphan). Не CRITICAL бо lower-tier data (не invoice/settlement), АЛЕ підриває UX-довіру («restore не працює») + може ламати downstream (WorkOrder з vehicleId що вказує на orphan → invalid state).

**Де шукати ще:**

- `WorkOrder.restore()` (якщо додано) — parent: Counterparty, Vehicle (обидва soft-delete-able)
- `Invoice.restore()` (якщо додано) — parent: WorkOrder, Counterparty
- `PurchaseOrder.restore()` — parent: Counterparty, CounterpartyContract, Branch/Warehouse
- `WorkOrderLine.restore()` / `WorkOrderPart.restore()` — parent: WorkOrder (з двома FK: work, part goodId)
- `StockDocument.restore()` / `StockDocumentLine.restore()` — parent: Warehouse, Branch
- **BullseyeGrep для нових restore endpoints у майбутньому:** `grep -rn "@Post.*restore" apps/api/src/modules --include="*.controller.ts"` — для кожного sibling `service.restore()` перевірити наявність parent-chain guard.

**Регресія-guard для цього патерну:** для КОЖНОГО нового `restore()` — обов'язковий регресійний тест-набір з мін. 5 кейсами: (1) happy-path (усі парент активні → 201); (2) double-restore (child.deletedAt=null → 404 БЕЗ updateMany); (3) parent-CP soft-deleted → 400 БЕЗ updateMany; (4) parent-garage soft-deleted (якщо 2 рівні) → 400 БЕЗ updateMany; (5) cross-tenant / non-existent → 404 БЕЗ updateMany. `expect(prisma.X.updateMany).not.toHaveBeenCalled()` — критичний assert для fail-closed поведінки (інакше guard видалять "як зайвий" → runtime orphan).

---

### 2026-08-30 — Cross-field guard + новий single-pass aggregator без regression-test (Bug #597) — api / backend / test-coverage / regression-guard

**Сигнал:** Service-метод має `throw new BadRequestException('...')` для крос-полю validation (наприклад `from > to`, `windowDays > 100`, `startDate > endDate`, `qty > available`) АБО новий single-pass aggregator (типово після optimize-cycle: замінили multi-reduce на for-of + локальні акумулятори у `totals.byX`). Парний `*.spec.ts` НЕ містить жодного `it(...)` для цих guards чи aggregators — grep за унікальним фрагментом error-повідомлення / aggregator-output повертає 0 matches. Це патерн Bug #416 (Serializable inner re-check test) — точно той самий принцип.

**Причина виникнення:** feature-розробка додає тільки happy-path тести (byDate mapping, credit-limit reduction). Guards і аgg-и додаються ПІЗНІШЕ у review-циклі («Cross-field guard: без цього from > to тихо перевертає bucket-логіку») або в optimize-циклі («заміняємо 3 reduce на one-pass»). Розробник фокусується на impl-fix, забуває парний test-fix. Класична split-fix gap-family: pattern у скіллі §1.5 `spec-vs-impl parity — guard added, but no regression test` — тут той самий у cross-field і aggregation формі.

**Підхід до виявлення:**

```bash
# 1. Знайти всі cross-field guards у service.ts:
grep -rn "throw new BadRequestException" apps/api/src/modules --include="*.service.ts" -B1 | grep -B1 "if (.*>.*\|if (.*<.*\|if (.*!==.*"

# 2. Для кожного знайденого — унікальний фрагмент error-повідомлення:
#    Наприклад "Вікно графіка не може перевищувати"
grep -rn "'Вікно графіка не може перевищувати'" apps/api/src --include="*.spec.ts"
# 0 matches → gap

# 3. Aggregator у service (single-pass after optimize):
grep -rn "for (const .* of .* )\|for (const .* in " apps/api/src --include="*.service.ts" -A2 | grep -B1 "totals\[.*\] = (totals\[.*\] ?? 0) +"

# 4. У парному spec шукати assert на цей aggregator output:
grep -rn "totals\.byX\|totals\.byDate\|totals\.by" apps/api/src --include="*.spec.ts"
# Якщо тільки totals.total тестується, а totals.byX — ні → gap
```

**Підхід до фіксу:** для кожного знайденого gap-у додати `it(...)` кейси у парному spec:

- Для cross-field guard — 3 кейси: (а) invalid combo → `rejects.toThrow(BadRequestException)`; (б) DB не викликано (`expect(prisma.X.find).not.toHaveBeenCalled()`); (в) boundary case → resolves (перевіряє `>` vs `>=` typo).
- Для single-pass aggregator — 1-2 кейси з РІЗНИМИ input variantами: (а) 2+ contributors у той самий bucket → sum (не overwrite); (б) empty bucket не потрапляє у output; (в) sanity — сума окремих bucket-ів == grand total.

**Severity:** MEDIUM (regression risk, не immediate bug). Не HIGH бо impl зараз працює. Не LOW бо: (а) guard-у-коді без тестy = висока ймовірність silent regression при наступному refactor-і; (б) aggregator output — user-visible (footer/totals), помилка миттєво помітна користувачу.

**Де шукати ще:** будь-який сервіс з recent `simplify:`, `perf(optimize):`, `fix(review):` commit-ом що змінив service.ts (додав guard/aggregator) — перевірити чи парний `*.spec.ts` теж змінений у тому ж diff. Grep: `git log --oneline --grep="review\|optimize\|simplify" -10` → `git show <commit> --stat | grep -E "service.ts|spec.ts"` → якщо тільки `.service.ts` у diff, а `.spec.ts` — ні = потенційна gap.

**Регресія-guard для цього патерну:** pre-commit hook що для КОЖНОГО `fix(review):` / `simplify(review):` / `perf(optimize):` commit-у з `.service.ts` у diff, вимагає теж діф у парному `.spec.ts` (або explicit «no test needed» commit-message annotation).

---

### 2026-08-30 — URL deep-link writer без парного reader (Bug #596) — web / frontend / navigation / broken-feature

**Сигнал:** Кнопка «покажи X у Y» на сторінці A виглядає як deep-link (icon `ExternalLink`, `text-primary`), клік перекидає у target-сторінку Y — АЛЕ Y відкривається у голому стані без візуальної відмітки/відкритої модалки/скролу на потрібний item. Grep по всій кодовій базі `?<param>=` повертає РІВНО 1 match — той самий писач; читач відсутній.

**Причина виникнення:** розробник додав кнопку з deep-link URL контрактом (`?highlight=<id>`, `?open=<id>`, `?focus=<id>`) припускаючи що target-сторінка вже читає param. Часто це припущення переноситься з іншого проєкту чи pattern-у, який тут не імплементований. Runtime не падає — Next.js просто ігнорує unknown query params. TS зелений (query params — це runtime dictionary, не типізовано). Немає test-coverage бо E2E рідко перевіряють post-navigation state за URL param.

**Підхід до виявлення:**

```bash
# 1. Знайти всіх писачів deep-links з query params
grep -rnE "router\.(push|replace)\(\`?[/'\"][a-z-/]+[^)]*\?[a-z]+=" apps/web/src --include="*.tsx"

# 2. Для кожного знайденого writer витягти <target-page> і <param-name>
# 3. Перевірити чи target читає param
for pair in "supplier-payments:highlight" "counterparties:tab" ...; do
  target=$(echo $pair | cut -d: -f1)
  param=$(echo $pair | cut -d: -f2)
  grep -c "searchParams.get('$param')" apps/web/src/app/\(app\)/$target/page.tsx || echo "MISSING READER: $pair"
done
```

**Підхід до фіксу:** два еквівалентні шляхи в залежності від UX-наміру:

- (A) **Реалізувати reader** (preferable коли feature корисна): у target-сторінці на mount читати param, виконувати відповідну дію (setEditingId, scroll to element, expand section), одразу очищувати param через `router.replace` щоб refresh не спамив. Ідемпотентно.

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
}, []); // mount-only — deep-link з зовнішньої сторінки; refresh не reopens
```

- (B) **Прибрати param у writer** якщо feature ще не готова — не залишати broken UX.

**Severity:** LOW (broken UX-feature, не data corruption, не crash); MEDIUM якщо кнопка має tooltip/label що обіцяє конкретну дію («відкрити картку X»).

**Де шукати ще:** будь-який cross-linking pair сторінок: `/counterparties/[id]` ↔ `/work-orders`, `/vehicles/[id]` ↔ `/work-orders`, `/invoices/[id]` ↔ `/counterparties`, `/purchase-orders/[id]` ↔ `/supplier-payments`, `/warehouses/[id]` ↔ `/stock-documents`. Кожна pair — потенційна broken deep-link diadic.

**Регресія-guard:** мінімальний Playwright тест: `page.goto('/target?param=<uuid>')` → `await expect(modal-or-highlighted-row).toBeVisible()`. Без цього регресія (видалення reader-useEffect у refactor) пройде CI зеленою.

---

### 2026-06-20 — Prisma `$queryRaw` + pg_trgm `%` operator без `::text` cast (Bug #572) — api / backend / sql / type-resolution

**Сигнал:** API endpoint що використовує `$queryRaw` з `pg_trgm` similarity (`%` оператор) повертає 500. Postgres error code `42804`: `argument of OR must be type boolean, not type text`. Працює тільки для деяких запитів (наприклад на простому `column % $1`), падає коли є concatenation на LHS: `COALESCE(a, '') || ' ' || COALESCE(b, '') % $N`.

**Причина виникнення:** Prisma `$queryRaw\`...${q}...\`` шле параметр `$N`без explicit Postgres type. Planner вирішує тип на основі context — якщо контекст ambiguous (наприклад LHS — це`text || text || text`expression, а оператор`%`має кілька overloads — pg_trgm`text % text → boolean`і модуло`numeric % numeric`), результат типу `$N`може стати`text`, а `text % text`без trgm operator resolution не повертає boolean — повертає text →`WHERE ... OR text` → 42804.

**Підхід до виявлення:**

```bash
# Знайти всі $queryRaw з % оператором без ::text cast:
grep -rn "\$queryRaw" apps/api/src --include="*.ts" -A 30 | grep -B 1 "%\s*\${" | grep -v "::text"

# Контракт-тест: для кожного search/similarity endpoint — викликати з 5+ варіантами q
# (English, Cyrillic, empty-after-trim, numeric-only) і expect статус 200.
curl -s -w "%{http_code}" "http://localhost:3000/api/<endpoint>?q=Toyota" -H "$AUTH"
```

**Підхід до фіксу:** для всіх `$queryRaw` параметрів що використовуються в `%`, `ILIKE`, `similarity()` — додати explicit cast `::text` або `::numeric`:

```typescript
const qText = `${q}`; // створити stable string reference
const qLike = `%${q}%`;
await prisma.$queryRaw`
  WHERE col % ${qText}::text          -- НЕ ${q} БЕЗ касту
    OR col ILIKE ${qLike}::text
    AND similarity(col, ${qText}::text) > 0.3
`;
```

Те саме для `${uuid}::uuid` (вже застосовано в orgId), `${num}::int`, `${date}::timestamptz`.

**Severity:** HIGH (endpoint падає на специфічних запитах, fallback 500 у production).

**Де шукати ще:**

- усі search/list endpoints що використовують `pg_trgm` GIN trgm indexes (counterparties, work_orders, goods, brands)
- Reports services з similarity-based grouping (`reports/`, `analytics/`)
- Будь-який `$queryRaw` де параметр з'являється у складному expression (concatenation, COALESCE, CASE WHEN)

---

### 2026-06-20 — pnpm-workspace.yaml overrides peer incompatibility (Bug #573) — infra / dependencies / startup

**Сигнал:** API не стартує після `pnpm install`. Помилка: `FastifyError: fastify-plugin: @fastify/<plugin> - expected '5.x' fastify version, '4.28.1' is installed` (FST_ERR_PLUGIN_VERSION_MISMATCH). Або зворотний випадок: `@nestjs/*` plugin вимагає Nest 11.x а ми на 10.x. Розробник міг додати security override у `pnpm-workspace.yaml` (наприклад `>=9.3.2`) не перевіривши peer compatibility з runtime версією.

**Причина виникнення:** Override був написаний з `>=` constraint щоб закрити CVE. До переїзду overrides з `package.json` у `pnpm-workspace.yaml` (pnpm 11+) — overrides у package.json silently ігнорувалися, тому проблеми не було. Після правильного переїзду — pnpm install вирішив за `>=` і витяг найновішу версію, яка вимагає newer peer.

**Підхід до виявлення:**

```bash
# Знайти всі overrides у pnpm-workspace.yaml:
grep -A 5 "^overrides:" pnpm-workspace.yaml

# Для кожного override — перевірити peer compatibility з runtime версією у apps/*/package.json:
PLUGIN="@fastify/middie"
RESOLVED=$(grep -A 2 "$PLUGIN" pnpm-lock.yaml | grep resolution | head -1)
echo "Resolved: $RESOLVED"
# Якщо resolved major > runtime major → ризик

# Quickly verify: pnpm --filter @sto/api dev і чекати "Application is running"
# Якщо exit з FST_ERR_PLUGIN_VERSION_MISMATCH → знайти max compatible major
```

**Підхід до фіксу:** pin override до останньої major-лінії що сумісна з runtime peer:

```yaml
overrides:
  # @fastify/middie 9.x вимагає fastify 5.x; ми на 4.28 → ^8.0.0 (остання fastify-4-сумісна лінія)
  '@fastify/middie': '^8.0.0'
```

Документувати у коментарі: причина override (CVE) + чому саме цей мажор.

**Severity:** CRITICAL — API/Web не стартує = система непрацездатна. Не виявляється у CI/test бо `pnpm install` міг колись з кешу resolveить старішу версію; тільки fresh install + restart розкриває.

**Де шукати ще:**

- усі `>=` constraints у pnpm-workspace.yaml overrides → переписати на конкретний major
- Раз на тиждень: `pnpm install` + `pnpm --filter @sto/api dev` + `pnpm --filter @sto/web dev` як sanity check
- CI: додати `node dist/main` smoke test після build

---

### 2026-06-20 — Silent `test.skip(true)` як fake-green replacement (мета-патерн) — e2e / test-debt

**Сигнал:** E2E spec містить `if (!data) return test.skip(true, '...')` де `data` — це результат API виклику до endpoint що seed надійно заповнює (counterparties, warehouses, goods, works, work-orders різних статусів). Skipped тести виглядають як "pass" у CI repoorter — фактично нічого не перевіряють.

**Причина виникнення:** Автор тесту boilerplate-додав defensive skip для випадку "empty DB" (наприклад при freshly seeded test env). Але реальний seed містить усі entities — skip ніколи не спрацьовує у нормальних умовах і прикриває справжній bug коли seed або API ламається. fake-green: тест зеленіє бо skipped (technically не failed).

**Підхід до виявлення:**

```bash
# Знайти всі silent skip patterns:
grep -rn "test.skip(true" apps/web/e2e --include="*.spec.ts"

# Підрахувати кількість skipped у останньому runs:
npx playwright test --reporter=line 2>&1 | grep -E "skipped"
```

**Підхід до фіксу:** Замінити `if (!data) test.skip(...)` на `expect(data, 'Seed має ...').toBeTruthy(); if (!data) return; // TS narrow`. Тепер регресія seed або API провалює тест замість прихованого skip. Допустимий виняток — тести feature що залежать від conditional UI (наприклад XLSX import, який є тільки для деяких типів документів) — обробляти через `if (hasFeature) {...} else {expect modal still works}`.

**Severity:** MEDIUM (не bug у production, але приховує справжні regressions).

**Де шукати ще:**

- Будь-який spec файл при додаванні нових тестів
- CI policy: завжди run з `--reporter=line` + grep skipped > 5 → failure
- Pre-commit hook: `grep test.skip\(true apps/web/e2e/*.spec.ts && exit 1`

---

### 2026-06-20 — E2E pagination-blind test з stale DB records (Bug #568) — e2e / test-debt / pagination

**Сигнал:** E2E тест створює запис `E2E-Foo-{uid}` (`Date.now().toString().slice(-6)`), потім перевіряє `table tbody tr:has-text("E2E-Foo-...")` БЕЗ попереднього використання search-input чи filter. Tеs пройде на чистій CI БД (вебсайт показує всі 1-2 row), а у dev environment де накопичились sample/попередні E2E records — fails з timeout 20s бо новий рядок осідає на page 2/3.

**Причина виникнення:** Автор тесту тестував локально під clean state і не зрозумів, що sort=name ASC + pagination(30) поховає нові рядки за алфавітними prefix-ами накопиченних даних. Тест assumes "новий запис → на сторінці 1" — це справедливо тільки коли total ≤ pageSize.

**Підхід до виявлення:**

```bash
# Знайти всі E2E тести що шукають створений запис у таблиці БЕЗ попереднього search.fill:
grep -rn "table tbody tr:has-text" apps/web/e2e --include="*.spec.ts" | while read line; do
  file=$(echo "$line" | cut -d: -f1)
  # Перевірити чи у тесті раніше викликається `getByPlaceholder(/Пошук/).fill` або `fill` у search-полі
  if ! grep -B 50 "table tbody tr:has-text" "$file" | grep -q "Пошук\|search\|filter.*fill"; then
    echo "PAGINATION-BLIND: $line"
  fi
done
```

**Підхід до фіксу:** після save і перед `toBeVisible` — заповнити поле пошуку: `await page.getByPlaceholder('Пошук...').fill(uniqueName)`. Це детермінізує що новий запис буде серед видимих rows незалежно від stale data. Альтернативи (rejected): teardown cleanup між тестами (overhead), sort DESC тут не працює для timestamp-based names.

**Severity:** HIGH (інтермітентне падіння у dev environment, регулярний блокер тестового suite).

**Де шукати ще:**

- `crud-catalog.spec.ts` (виправлено для робіт + товарів)
- `crud-counterparties.spec.ts`, `crud-vehicles.spec.ts`, `invoices.spec.ts`, `work-orders.spec.ts`, `stock-documents.spec.ts` — кожен create+verify-row pattern
- Будь-який модуль з pagination 30+ rows + alphabetic sort default

---

### 2026-06-20 — Reflector-based contract test для new @Decorator (Bug #569) — api / contract / regression-guard

**Сигнал:** Review commit додає security/behavioral decorator на існуючий controller method: `@Throttle({...})`, `@UseGuards(JwtAuthGuard)`, `@Roles(...)`, `@HttpCode(...)`, `@ApiBearerAuth()`. Існуючі тести для модуля (`*.service.spec.ts`) перевіряють бізнес-логіку, але не reflection metadata. Майбутній рефактор, copy-paste нового endpoint без декоратора, чи tooling-помилка може тихо видалити декоратор → security гарантія зникає без сигналу.

**Причина виникнення:** Декоратор реалізований через `Reflect.defineMetadata` — він невидимий у звичайному unit test що мокає service. Жоден існуючий guard не падає при відсутності decorator (Throttler guard просто пропускає route без metadata). Розробник довіряє що decorator залишиться на місці — але це false security.

**Підхід до виявлення:**

```bash
# Знайти всі публічні (без guards) endpoints у API:
grep -rn "@Controller\|@Get(\|@Post(\|@Patch(\|@Delete(" apps/api/src/modules --include="*.controller.ts" \
  | grep -v "spec"
# Для кожного — переконатись що або є @UseGuards або є @Throttle
# Якщо є @Throttle → перевірити чи існує `*.throttle.contract.spec.ts`
ls apps/api/src/modules/*/  | grep -E "throttle.*contract\.spec"
```

**Підхід до фіксу:** створити `<module>.<decorator>.contract.spec.ts`. Імпортувати controller class, використати `new Reflector()`, читати metadata з handler reference:

```ts
const limit = reflector.get<number>(
  `${THROTTLER_LIMIT}default`,
  BookingController.prototype.createPublic,
);
expect(limit).toBe(5);
```

Метадата keys для `@nestjs/throttler` — `THROTTLER_LIMIT+'default'`, `THROTTLER_TTL+'default'` (для named throttler — замість `default` ім'я).

**Severity:** LOW (немає прямого багу), але HIGH preventive (захищає від тихого регресу security декоратора).

**Де шукати ще:** будь-який модуль з `@Throttle/@Roles/@UseGuards/@HttpCode` доданим після initial implementation. Особливо — публічні endpoints у `booking`, `share`, `webhooks` модулях.

---

### 2026-06-20 — Cross-package LABELS/BADGE контракт-тест для shared constants (Bug #570) — web / shared / drift-detection

**Сигнал:** Frontend код використовує `LABELS[entity.status] ?? entity.status` де LABELS приходить з `@sto/shared` (centralized) або (gorest) inline-копія. Backend має enum у Prisma schema (`WorkOrderStatus`, `InvoiceStatus`, `PurchaseOrderStatus`, `StockDocumentType`, `GoodType`, `CounterpartyType`). Коли backend додає новий enum value — frontend LABELS не оновлюється автоматично, fallback `?? entity.status` повертає raw `NEW_STATUS_X` що показується клієнту замість українського перекладу.

**Причина виникнення:** Розробник вірить що backend `prisma enum + LABELS у shared` синхронізовані, але немає механізму що це enforces. TS не падає бо обидва типи `Record<string, string>`. Drift лишається непомічений до production коли користувач бачить англомовний raw status.

**Підхід до виявлення:**

```bash
# Знайти всі *_LABELS використання з ?? fallback:
grep -rn "_LABELS\[.*\] ?? " apps/web/src --include="*.tsx" --include="*.ts"

# Для кожного — знайти corresponding prisma enum:
grep "enum.*Status\|enum GoodType\|enum CounterpartyType" packages/database/prisma/schema.prisma

# Перевірити що існує contract test:
find apps/web/src -name "*labels.test.*" -o -name "*-status.test.*"
```

**Підхід до фіксу:** створити `apps/web/src/lib/<entity>-status-labels.test.ts` зі списком `EXPECTED_STATUSES` (дзеркало `prisma enum`) і it.each-перевіркою: кожен має label/badge/description, label містить кирилицю (`/[Ѐ-ӿ]/`), label.length > 0, all 3 maps мають однакові ключі. Тест паде ПЕРШИМ якщо backend додасть статус без оновлення shared.

**Severity:** LOW (regression guard, no current bug).

**Де шукати ще:**

- `INVOICE_STATUS_LABELS` (Invoice.status)
- `PO_STATUS_LABELS` (PurchaseOrder.status)
- `STOCK_DOC_STATUS_LABELS`, `STOCK_DOC_TYPE_LABELS`
- `COUNTERPARTY_TYPE_LABELS` (Counterparty.type)
- `GOOD_TYPE_LABELS` (Good.goodType)
- `EMPLOYEE_ROLE_LABELS` (Employee.role)

---

### 2026-06-17 — Local interface дрейфує від hook/DTO коли додається нове поле (Bug #506 / #510) — frontend / type-duplication

**Сигнал:** Те саме ім'я типу `WorkOrder` / `Invoice` / `Counterparty` дублюється:

- `apps/web/src/hooks/api/use<Entity>.ts` — авторитетний інтерфейс
- `apps/web/src/app/(app)/<entity>/page.tsx` або `[id]/PageClient.tsx` — локальний inline-дублікат

Backend додає нове поле у `<Entity>ResponseDto` → hook інтерфейс оновлюється (бо це найбільш помітний consumer на TanStack Query layer) → локальний interface на детальній сторінці забутий. На сторінці тип компілюється (TypeScript не бачить що hook повертає більше), нове поле невидиме для UI коду, наявні розрахунки/відображення розходяться з новою семантикою бекенду.

**Причина виникнення:** Перший автор сторінки скопіював `interface WorkOrder { ... }` inline бо швидше за import. Згодом hook став джерелом правди (типи переїхали туди), але старі сторінки не зрефакторені. Pattern непомітний поки feature не вводить семантичну зміну у поле що використовувалось у UI обчисленнях. Найгірше — коли feature міняє формулу для `totalAmount` (бекенд) і UI продовжує сумувати старі компоненти (`totalLabor + totalParts`) які тепер не складаються у `totalAmount`. Користувач бачить математично некоректну суму.

**Підхід до виявлення:**

```bash
# 1) Знайти дублюючі interface declarations з однаковою назвою:
grep -rn "^interface WorkOrder " apps/web/src --include="*.ts*"
grep -rn "^interface Invoice " apps/web/src --include="*.ts*"
# >1 match → один з них застарілий

# 2) Порівняти поля з hook джерела правди:
diff <(grep -A 50 "^export interface WorkOrder " apps/web/src/hooks/api/useWorkOrders.ts) \
     <(grep -A 50 "^interface WorkOrderDetail " apps/web/src/app/\(app\)/work-orders/\[id\]/PageClient.tsx)

# 3) Перевірити кожне нове поле у бекенді — чи присутнє у локальному interface:
grep -rn "totalActualLabor\|<newField>" apps/web/src --include="*.ts*"
# Має бути присутнє у ВСІХ типах що описують той самий aggregate
```

**Підхід до фіксу:** Швидкий — додати нове поле у локальний interface. Правильний — `import { WorkOrder } from '@/hooks/api/useWorkOrders'` і використати або `WorkOrder` напряму, або `interface WorkOrderDetail extends WorkOrder { lines: WorkOrderLine[]; parts: WorkOrderPart[]; }`. Pattern працює для будь-якого aggregate з detail view розширенням.

**Регресія-guard:** ESLint правило `@typescript-eslint/no-duplicate-imports` не ловить це (різні imports). Альтернатива — наш custom check у `/sto-review`: grep duplicate `interface <Name> {` у `apps/web/src`. Або один TypeScript-level guard через `satisfies`:

```ts
// На рівні local interface:
const _check: WorkOrderDetail = {} as Awaited<ReturnType<typeof fetchWorkOrder>>;
// → tsc errors якщо детальний тип розходиться з реальним hook response
```

**Severity для подібних bugs:** MEDIUM — не silent data loss, але UI довіра порушена (математично некоректні суми). У комбінації з grosses-сумами це може досягти HIGH (помилка у виставленні рахунку, плутанина у звітах).

**Де шукати ще:** Кожен `apps/web/src/app/(app)/<entity>/[id]/PageClient.tsx` + `apps/web/src/components/ui/Create<Entity>Modal.tsx` + `apps/web/src/hooks/api/use<Entity>.ts` — тріада з найбільшим ризиком дрейфу. Особливо ризик у aggregate-полях (`totalAmount`, `paidAmount`, `balanceAmount`).

---

### 2026-06-17 — Семантична зміна загального поля без оновлення downstream consumers (Bug #508) — backend / consistency

**Сигнал:** Feature що змінює формулу обчислення вже існуючого denormalized полу (наприклад `totalAmount`, `paidAmount`, `balance`, `cost`). Поле читається у багатьох місцях:

- Service-to-service flows (invoice.createFromWorkOrder → wo.totalAmount)
- Public/share endpoints (estimate, public invoice)
- PDF generators
- Frontend Detail views, list tables, dashboard widgets
- Reports, exports (xlsx, csv)
- Sync layer (Outbox events)

Автор feature правильно оновив головний flow і одне-два очевидних місця, але пропустив semantic mismatch у спеціалізованих consumers. Класичний приклад: estimate-share показує `wo.totalAmount` що тепер семантично "actual amount" (включає `actualHours`), хоча контекст естімейту = PLAN.

**Причина виникнення:** Denormalized поля приваблюють тим що "вже обчислене, можна читати скрізь". Feature міняє формулу → один зміна у `recalcTotals` поширюється всюди — у тому числі куди семантично не повинна. Розробник не сприймає це як риск, бо синтаксично нічого не зламалось і type signatures стабільні.

**Підхід до виявлення:**

```bash
# 1) Знайти всі читачі denormalized поля що змінилося:
grep -rn "\.totalAmount\|totalAmount:" apps/api/src --include="*.ts" | grep -v "spec\|test"

# 2) Категоризувати кожне використання за семантикою:
#    - "actual" контекст (after-work, completion, invoice, settlement) → нова формула OK
#    - "planned" контекст (estimate, share, draft, preview) → нова формула WRONG
#    - "neutral" список / dashboard → залежить від UX наміру

# 3) Перевірити кожен share/public endpoint окремо — він зазвичай має інший
#    semantic contract з клієнтом і не повинен наслідувати backend internal change.
```

**Підхід до фіксу:** У share/public consumer обчислити суму ЛОКАЛЬНО з компонентів planning (не використовувати загальне поле):

```ts
// Bug #508 fix у findByShareToken:
totalAmount: Number(wo.totalLabor) + Number(wo.totalParts),
// замість Number(wo.totalAmount)
```

Альтернатива — додати окреме поле `totalPlannedAmount` у схему. Дорого для одного use case; локальне обчислення ефективніше.

**Регресія-guard:** Property-based test "estimate-share total = totalLabor + totalParts (no actualHours leak)" або просто snapshot-тест share response для WO з ненульовими `actualHours`. Якщо хтось у майбутньому повернеться до `wo.totalAmount`, тест зловить.

**Severity для подібних bugs:** LOW-MEDIUM — баг у крайових випадках (estimate з вже встановленими actualHours — нетипово), але семантично некоректна публічна сторінка може заплутати клієнта і викликати дзвінок у СТО.

**Де шукати ще:** Будь-яка пара (denormalized field, share/public endpoint). У STO ERP кандидати: `wo.totalAmount` ↔ estimate share, `invoice.amount` ↔ payment receipt, `counterparty.balance` ↔ self-service portal, `vehicle.currentMileage` ↔ public service-history. Кожна пара — потенційний source of semantic drift.

---

### 2026-06-19 — Shared include-shape const (3 read paths) без regression-guard на DTO field propagation (Bug #541) — backend / test-coverage / refactor safety

**Сигнал:** Review-fix комміт що витягує дублюваний Prisma `include`-shape (`good: { select: { name, internalCode, sku, ... } }`) у shared const (`PART_GOOD_INCLUDE`/`PO_LINE_GOOD_INCLUDE`/`<X>_INCLUDE`) і використовує його у 3+ read paths (`findOne` / `createX` / `updateX` / FSM transition return). Refactor чистий, тести зелені, drift попереджено між трьома callsites. **АЛЕ** жоден існуючий test не асертить що поля з shared const реально потрапляють у DTO. `toDto` мапить кожне поле через `?? null` → якщо хтось наступним рефактором видалить `internalCode: true` з const-shape:

1. TS green (DTO має `internalCode?: string | null`)
2. `toDto` повертає `null` для всіх записів (silent)
3. Frontend muted sub-line або кнопка-пошуку не показує значення
4. Existing tests passing — баг непомітний

**Причина виникнення:** review-fix зосереджується на **деуплікації** (3 ідентичні shape-и → 1 const), а не на **захисті** від майбутнього drift всередині самого const. Pattern `as const satisfies Prisma.<X>DefaultArgs` дає structural type safety **лише до моменту коли хтось видалить поле з const** — після цього TS вважає видалене поле "законно відсутнє" у return type, бо `toDto` має optional chain access (`l.good?.internalCode ?? null`).

**Підхід до виявлення:**

```bash
# 1. Знайти shared include-consts у service-файлах:
grep -rnE "^const [A-Z_]+_INCLUDE\s*=" apps/api/src/modules --include="*.service.ts"

# 2. Для кожного — звірити чи парний spec асертить поля у DTO:
#    asserts повинні бути на 100% полів які const-shape забезпечує
#    (не лише name, але internalCode / sku / brand.name / unit / etc.)
for f in $(grep -rl "_INCLUDE" apps/api/src/modules --include="*.service.ts"); do
  spec="${f/.ts/.spec.ts}"
  alt_spec="${f/.service.ts/.role-gate.spec.ts}"
  # асертимо що spec-mock включає всі fields з PART_GOOD_INCLUDE
  echo "=== $spec ==="
  grep -E "internalCode|sku|brand\.name" "$spec" "$alt_spec" 2>/dev/null | head -5
done

# 3. Якщо mock-fixture good має ТІЛЬКИ {name, unit} → bug: refactor що видалить
#    internalCode/sku/brand з const-shape проходить CI зеленим
```

**Підхід до фіксу:** Для КОЖНОГО shared include-const **обов'язково** один з:

1. **Розширити mock-fixture у paired spec** щоб включати ВСІ поля const-shape:
   - `good: { name, internalCode, sku, unit, unitOfMeasure, brand: { name } }` (повний PART_GOOD_INCLUDE shape)
2. **Додати regression-guard `it()` що асертить кожне поле у DTO:**
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
3. Дзеркальний guard у кожному callsite (`findOne` ✗ `addPart` ✗ `updatePart`) — щоб видалення з ОДНОГО з 3 callsites теж ловилося (refactor може забути про includes у 1 з 3 mutation paths).

**Severity:** LOW (silent regression-guard gap; runtime UX broken тільки коли drift реально станеться). MEDIUM коли const-shape забезпечує denormalized name для FK PII (`counterpartyName`, `vehicleLabel` — display label у share-link).

**Де шукати ще:** будь-який `const <X>_INCLUDE` / `<X>_SELECT` / `<X>_DEFAULT_ARGS` у `*.service.ts` що використовується ≥2 callsites. У STO ERP кандидати:

- `PART_GOOD_INCLUDE` / `PO_LINE_GOOD_INCLUDE` (Bug #541)
- `GOOD_UOM_SELECT` у work-orders.service.ts
- Будь-який shared `Counterparty`/`Vehicle` projection у FSM-обчислювальних flow

**Регресія-guard checklist:**

- [ ] **Shared include/select const без DTO-field propagation guard у paired spec (Bug #541):** будь-який `const <X>_INCLUDE = { select: {...} } as const satisfies Prisma.<Model>DefaultArgs` у `*.service.ts` що використовується ≥2 callsites (`findOne` + `addX`/`updateX` mutations) — у парному `*.service.spec.ts` / `*.role-gate.spec.ts` mock-fixture для `<relation>` має містити ВСІ scalar поля const-shape (не лише `name`), і має існувати хоча б ОДИН `it()` що `expect(dto).toMatchObject({ <denormName>: <fixture-value>, ... })` для кожного значення з mock-fixture. Без guard refactor що видалить поле з const-shape проходить CI зеленим. Grep: `grep -rnE "^const [A-Z_]+_INCLUDE\s*=" apps/api/src/modules --include="*.service.ts"` → для кожного match: `paired_spec.includes(const_name) || grep -E "(internalCode|sku|brand)" paired_spec`. Severity LOW (drift gap); MEDIUM коли const-shape ховає PII denormalization для share-link.

---

### 2026-06-17 — Role-gated sensitive field у DTO без regression-guard у service spec (Bug #527, #529) — backend / security / test-coverage

**Сигнал:** Commit вигляду `fix/feat: role-gate <Field> for <ContextDto>` що додає набір whитлист-ролей (`<X>_VISIBLE_ROLES = new Set<string>([...])`), helper-функцію (`canSeeX(role)`), і optional `userRole?: string` параметр у service-метод(и) що повертають DTO. Поле зазвичай — фінансово/безпечно чутливе (`costPrice`, `purchasePrice`, `margin`, `internalNotes`, `auditTrail`, `bankAccount`).

**Перевірка:** одразу — `grep -rn "<Field>\|canSee<Field>\|<X>_VISIBLE_ROLES" apps/api/src --include="*.spec.ts"`. Нуль matches = bug.

**Причина виникнення:** Role-gating пишеться як "невелика defensive фіча" — code review зосереджений на whitelist correctness, не на повноті test coverage. Розробник додає коментар "FE не використовує DTO у write-endpoints", але не пише тест, бо "поведінка очевидна". Через 6 місяців:

- Refactor видаляє `userRole` параметр з service (мовляв "нечитаний параметр")
- Default `userRole = 'OWNER'` додано для backward-compat → leak для всіх ролей
- Typo у Set (`'MECHANIK'` замість `'STOREKEEPER'`) → витік для механіка
- Нова роль `PARTNER` додана у schema, забута у whitelist → leak або несподіваний deny

**Підхід до виявлення:**

```bash
# 1) Знайти кожен commit з role-gating паттерном:
git log --all --oneline --grep="role-gate\|role gate\|VISIBLE_ROLES\|canSee" -- apps/api/src

# 2) Для кожного знайденого: чи є регресія-guard?
grep -rn "VISIBLE_ROLES\|canSee\(" apps/api/src --include="*.spec.ts"

# 3) Для кожного role-gated DTO field — переконатись що ВСІ endpoint що повертають DTO передають userRole:
#    - GET /:id (findOne) — найочевидніший
#    - POST mutations (create, add*) — повертають DTO, теж потребують role
#    - PATCH mutations (update, update*) — теж
#    - Bulk endpoints (list with details=true) — теж
grep -rn "to<DtoName>\(" apps/api/src --include="*.service.ts" | grep -v spec
# Кожен callsite має передавати userRole АБО fail-closed default зберігається.

# 4) Перевірити що Set лookup case-sensitive відповідає JWT role claim format:
grep -rn "Set<string>" apps/api/src --include="*.service.ts" | grep -i "role"
```

**Підхід до фіксу:** новий dedicated spec файл `<module>.role-gate.spec.ts` що покриває матрицю:

- **Привілейовані ролі × значення поля** — `it.each([['OWNER'], ['ADMIN'], ...])('%s бачить <Field> = number')`
- **Непривілейовані ролі × значення поля** — `it.each([['MECHANIC'], ...])('%s НЕ бачить <Field> (undefined)')`
- **Edge: `userRole === undefined`** → fail-closed
- **Edge: `userRole === ''`** → fail-closed (auth broken)
- **Edge: невідома роль `'GUEST'`** → fail-closed (whitelist semantic)
- **Edge: lowercase `'owner'`** → fail-closed (case-sensitive guard)
- **Semantic: `<Field> === null` для привілейованої ролі** → DTO має `<Field>: null` (доступ є, але value not set) — відмінно від `undefined` (нема доступу)
- **Симетрія для кожного mutation-endpoint** (`addX`, `updateX`) — окремий describe, перевірити response DTO

Defense-in-depth: всі endpoint що повертають DTO мають приймати userRole і передавати у toDto-mapper. Тоді refactor що видаляє fail-closed default залишається безпечним.

**Регресія-guard:** Самй spec файл = guard. Будь-який refactor що:

- Видаляє userRole параметр → describe-block-and-after отримає TS error або runtime fail.
- Перейменовує константу → відсутня константа compile error → grep знаходить.
- Додає роль у whitelist без оновлення Set → `it.each([['NEW_ROLE']])` падає.
- Встановлює `userRole = 'OWNER'` default → тести для undefined/'' падають.

**Severity для подібних bugs:** HIGH (release-blocker для §2.1 Auth) коли поле фінансово чутливе або PII. MEDIUM коли поле тільки informational/audit. Завжди вимагати regression-guard для security-sensitive fields — gap у тесті = security gap.

**Де шукати ще:** будь-яке поле у DTO з prefix `cost*`, `purchase*`, `internal*`, `audit*`, `private*`, `secret*`, `bankAccount`, `taxId`, `phone`/`email` (якщо є publish-mode для public counterparty), `salary`/`wage`, `margin`. Кожне таке поле — потенційний role-gating gap.

---

### 2026-06-17 — React inline-edit merge втрачає DB-only fields (`id`, `createdAt`) → save() filter мовчки пропускає рядок (Bug #526) — frontend / state-merge

**Сигнал:** У компонентах з inline-row-edit pattern (CreateWorkOrderModal, BudgetTab, InvoicePage, будь-який list-with-edit) state виглядає так:

```ts
const [items, setItems] = useState<Item[]>([]); // server-loaded, з `id`
const [editing, setEditing] = useState<Omit<Item, 'id'>>(EMPTY); // editable subset
```

На commit ✓ button:

```ts
setItems(prev =>
  prev.map(it =>
    it._key === target._key
      ? { ...editing, _key: it._key } // ← `id` загублено
      : it,
  ),
);
```

Далі save() робить `items.filter(i => !!i.id)` → відредагований row пропадає → PATCH не надсилається → DB не оновлюється → UI показує локально новий value, але після reload returnить попередній. Бо у save() WO-level fields рахуються з committed state (sum/total), а line-level PATCH повністю пропускається, **WO-рівень виглядає збереженим**, що маскує bug як "інший інше зламано".

**Причина виникнення:** TypeScript helper типи (`Omit<LocalLine, '_key'>` для `editingLine`) роблять `id` опціональним → spread valid → нема компіляційної помилки. Розробник пише `{ ...editing, _key: l._key }` як best-practice "shallow copy editable fields", забуваючи що merge replaces entire object, не lifts onto base. `editing` state ніколи не виставляється з `id`, бо handler що entering edit mode копіює тільки editable subset. Pattern масштабується: тих самих 3-5 рядків достатньо щоб тихо ламати persistence у будь-якій inline-edit UI.

**Підхід до виявлення:**

```bash
# 1) Знайти всі inline-edit commit patterns у components/
grep -rn "\.\.\.editing.*_key" apps/web/src --include="*.tsx" --include="*.ts"
# Будь-який match → перевірити: чи editing state містить id? Чи base item має id?

# 2) Знайти всі save()/submit() filters з `!!id`/`l.id` що потім роблять PATCH:
grep -rn "filter.*!!.*\.id\|filter.*l\.id" apps/web/src --include="*.tsx" --include="*.ts"
# Перетин (1) і (2) у одному файлі = high-risk

# 3) State типи `Omit<X, '_key'>` де X має `id?: string`:
grep -rn "Omit<.*'_key'>" apps/web/src --include="*.ts*"
# Кожен match — підозра на втрату id при merge.
```

**Підхід до фіксу:** spread base object FIRST, потім editable fields:

```ts
{ ...l, ...editing, _key: l._key }   // ← `l` first preserves `id`/`createdAt`/etc
```

Універсально для будь-якого React state merge де target має server-only fields. Альтернатива (gorzhe): додати `id: l.id` в setEditingLine, але це duplicates сурс правди і ламається при додаванні нового server-only field.

**Регресія-guard:** Component-test (RTL) — після click ✓ ассертити що `lines[0].id === <original-id>` через react-test-renderer state inspection, або spy на apiFetch і assert PATCH `/lines/<originalId>` був викликаний.

**Severity для подібних bugs:** CRITICAL — silent data-loss що маскується миттєвим UI feedback. Користувач бачить "збережено", закриває модалку, повертається → значення зникло. Найгірший UX trust violation.

**Де шукати ще:** CreateInvoiceModal, CreatePurchaseOrderModal, CreateStockDocumentModal, BudgetTab inline-edit, будь-яка двофазна editing UI з server-loaded list + local edit buffer.

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

**Сигнал:** `new Set(rows.map(r => { const d = new Date(r.dateField); const h = String(d.getUTCHours()).padStart(2, '0'); ... return \`${h}:${m}\`; }))`або взагалі будь-який ключ Map/Set що формується через`getUTC\*()`з`DateTime`поля. В тому ж файлі — інший масив ключів формується з Kyiv-локальних`BranchSettings.workStartTime/workEndTime`(або з UI часового пікера) як plain`HH:MM`рядки. Result: ключі НЕ перетинаються у будь-який сезон де`Europe/Kyiv`≠ UTC (тобто ВЕСЬ календарний рік: +02:00 зимою, +03:00 літом).`Set.has(...)`always returns false → security/business guard silently не спрацьовує. grep:`getUTCHours\|getUTCMinutes`у будь-якому файлі що згадує`BranchSettings\|workStartTime\|kyiv\|requestedDate\|slot` — кожен match підозрілий.

**Причина виникнення:** розробник думав «зберігаємо як UTC у БД → отже усі похідні значення мають витягати UTC». Логіка правильна для самого instant comparison, АЛЕ ламається коли інша сторона (slot generation, BranchSettings working hours, UI пікер) живе у Kyiv-локальному наративному просторі ("робочі години 09:00–18:00" — це Kyiv-local, не UTC). Pattern особливо часто з'являється коли feature додається інкрементально (`bookedTimes` block — пізніше додавання до існуючого `getAvailability` що вже використовував Kyiv-локальні `startLimitMinutes` для slot generation).

**Підхід до виявлення:**

```bash
# 1) Знайти всі use sites getUTCHours/getUTCMinutes у backend services що працюють з BranchSettings
grep -rn "getUTCHours\|getUTCMinutes" apps/api/src/modules --include="*.ts" | grep -v spec

# 2) Для кожного match — перевірити чи в тому ж файлі формується parallel array of "HH:MM" ключів з НЕ-UTC джерела
grep -B2 -A2 "getUTCHours" <file> | grep -E "workStart|workEnd|BranchSettings|slot.*minutes|kyiv"
# Якщо так → bug.

# 3) Альтернативний find — ЛЮБА конструкція HH:MM рядка через getUTC* у файлі що десь читає BranchSettings:
grep -l "BranchSettings\|workStartTime" apps/api/src/modules --include="*.ts" -r | while read f; do
  grep -l "getUTCHours\|getUTCMinutes" "$f"
done

# 4) Frontend mirror — використання `.toISOString().slice(11,16)` (= UTC HH:MM) для порівняння з фронтовим часовим піктером (Kyiv).
grep -rn "toISOString().slice(11" apps/web/src --include="*.ts*" | grep -v test
```

**Підхід до фіксу:** Module-level `Intl.DateTimeFormat` singleton з explicit `timeZone: 'Europe/Kyiv'` + `hour12: false` + `hour/minute: '2-digit'`. Локаль `'en-GB'` дає padded "HH:MM" формат природно. Використовувати `.format(date)` замість manual `getUTC*` + padStart. Перевага: Intl.DateTimeFormat авто-обробляє DST переходи (включно з 03:00→04:00 моментом останньої неділі березня).

**Регресія-guard:** обов'язковий unit-spec кейс з date що **переходить через UTC midnight у Kyiv** (наприклад `2026-06-01T22:30:00Z` → 01:30 Kyiv NEXT day). Без TZ-aware ключа цей кейс провалиться. Без цього specific кейсу — і без `getUTCHours` теж все працює (наївне поле здається працює для timestamp без TZ-крос-полуночного зсуву).

**Severity:** CRITICAL коли guard блокує бронювання/payment/inventory. HIGH коли тільки UI display. MEDIUM коли log/analytics.

**Де шукати ще:** будь-який модуль що порівнює `BookingRequest.requestedDate`, `CalendarSlot.startAt`, `WorkOrder.scheduledAt`, `Payment.paidAt`, `Invoice.documentDate`, `StockMovement.movedAt` з користувацько-введеними плановими часами; також **frontend**: `useCalendarState`, `CreateWorkOrderModal` form datetime fields, будь-який `<TimeInput>` що persistuє у UTC але порівнюється з Kyiv-локальним business window.

---

### 2026-06-16 — `useRef` для уникнення ре-рендерів стає stale коли його ініціалізація async (Bug #512) — frontend / race condition

**Сигнал:** дві паралельні `useEffect` на mount: один fetch-ить дані A (`/lifts`) і пише у `useRef`, інший викликає `useCallback` що **читає той же ref** у своєму `.then()`. `useCallback` має deps `[date]` (НЕ `[lifts]` бо тоді була б подвійна fetch). Якщо B-callback резолвиться **до** того як A-fetch завершився → ref читає initial `[]` → derived state (`bookingSlots`) лишається порожнім назавжди (до зміни `date`). Тест проходить (моки повертають усе одразу — race не симулюється). Cache hit приховує баг у local dev (`getCached` синхронно заповнює ref до rendering effect).

**Причина виникнення:** оптимізація proti re-renders — розробник свідомо обрав ref щоб уникнути перезапуску `load()` на кожну зміну `lifts`. Не врахував що **перший виклик** `load()` теж читає ref і він порожній. Pattern особливо коваурний бо у dev console показує `liftsRef.current` як заповнений (devtools читає current value AFTER all effects done).

**Підхід до виявлення:**

```bash
# 1) Знайти useRef що ініціалізується у async useEffect-і
grep -rnE "useRef\(\[?\]?\)" apps/web/src --include="*.ts*" | grep -v test
# Для кожного результату — подивитись де `Ref.current = X` стоїть у `.then()` async-у

# 2) Для кожного знайденого ref — пошукати читання `Ref.current` у callback що НЕ депендиться на цьому ref
grep -B3 -A10 "useRef" apps/web/src/<file>.ts | grep -E "useCallback|useEffect"
# Деп масиви треба перевірити вручну: якщо `[date]` без `lifts.length` АЛЕ читає `liftsRef.current` → bug

# 3) Frontend race test: переписати moc API щоб /lifts резолвилось останнім (delay).
# expect: bookingSlots.length > 0 після обох resolve.
```

**Підхід до фіксу:** найдешевший — додати proxy-value `.length` у deps масив того callback що читає ref. `lifts.length` змінюється з 0 → N коли ref заповнено → callback перевикликається з вже-готовим ref. Альтернатива (дорожча) — об'єднати fetch у Promise.all([lifts, bookings]) і зберегти результат у єдиному effect. Trade-off: дублікат fetch (+1 round-trip на mount), але гарантована коректність.

**Регресія-guard:** vitest test з `vi.fn().mockResolvedValueOnce(new Promise(r => setTimeout(() => r(<data>), 100)))` для повільного /lifts vs швидке /booking; expect derived state коректно після обох resolve. Альтернатива — Playwright з incognito context (no localStorage cache).

**Severity:** HIGH коли feature видимо ламається (показ читaчu) перед користувачем. MEDIUM коли тільки приховані індикатори. LOW коли purely cosmetic.

**Де шукати ще:** будь-який hook що поєднує `useRef([])` з async-init + `useCallback` deps без проксі-сигналу (`useChatState` для message threads, `useDashboardState` для KPI cards, `useTimelineState` для логи). Також паттерн виходить за межі ref-ів: будь-яка `useCallback([dateOnly])` що читає `someState` через closure → stale.

---

### 2026-06-16 — Unclamped UI math для нових feature-блоків копіюється з existing блоку але втрачає back-end guard (Bug #513) — frontend / UI overflow

**Сигнал:** новий React component (наприклад `BookingSlotBlock`) копіює math (`left = ((startH - HOURS[0]) / TOTAL_HOURS) * 100`) з existing component (`DraggableSlot`). Existing працює тому що його дані створюються через service-метод що clamp-ить значення (`createSlot()` → `kyivEndOfWorkDay`). Новий компонент отримує дані з **іншого** джерела (`BookingRequest.requestedDate`) що НЕ проходить через той же clamp-guard. Result: `left < 0` або `width > 100%` → блок частково/повністю невидимий за межами parent box. `overflow: hidden` приховує проблему — JS не падає, але UI loss capability.

**Причина виникнення:** copy-paste між схожими візуальними компонентами без re-audit передумов даних. Розробник побачив що math у `DraggableSlot` працює стабільно і скопіював, не помітивши що existing полагалась на server-side invariant який НЕ діє для нового джерела даних.

**Підхід до виявлення:**

```bash
# 1) Для КОЖНОГО нового компонента що рендерить positioning math — знайти existing з тією ж формулою
grep -rn "((startH - HOURS\[0\])\|left = .* % \|kyivHours(slot" apps/web/src --include="*.tsx"

# 2) Для кожного match — перевірити чи source даних має server-side clamp:
# - CalendarSlot: createSlot() → kyivEndOfWorkDay ✓
# - BookingRequest: ✗ (Bug #513 + #514)
# - WorkOrder.scheduledAt: ? (audit)
# - Invoice.documentDate: ? (audit)

# 3) Прагматичний defensive guard — кожен такий компонент має skip-render умову для out-of-bounds:
#    `if (endH <= MIN || startH >= MAX) return null;`
#    і clamp: `Math.max(MIN, startH)`, `Math.min(MAX, endH)`.
```

**Підхід до фіксу:** двоступеневий — (1) defensive clamp у component (cheap, не вимагає back-end change); (2) парний back-end guard для джерела даних (server-side invariant — Bug #514 family).

**Регресія-guard:** vitest test з out-of-bounds startH (`'2026-06-01T04:00:00.000Z'` = 07:00 Kyiv літо, HOURS[0]=8) → expected `container.firstChild` має `left: '0%'` або `null` (відповідно до policy).

**Severity:** MEDIUM коли invisible block hides existing data але не блокує business logic. HIGH коли invisible block — це CTA яку користувач має натиснути.

**Де шукати ще:** Gantt-style timelines, schedule grids, sparkline graphs, progress bars з `width %` обчислюваним з user input, charts axis labels, drag-and-drop position calc.

---

### 2026-06-15 — Queue.add(name, data) shape не співпадає з processor `process(job)` interface (Bug #506) — backend / queue / contract drift

**Сигнал:** `someQueue.add('job-name', { fieldA, fieldB, fieldC })` у service-A, але `@Processor('queue') WorkerHost.process(job)` у processor-B робить `const { fieldX, fieldY } = job.data` — **жодне поле не співпадає**. tsc green (queue payload типується як `any`/JSON у BullMQ — не валідується). Unit-spec service-A проходить (mock на queue.add асертить лише `attempts` у options, не shape data). Unit-spec processor-B проходить (тестується з власним коректним shape). Кінцевий runtime-результат: processor читає `undefined` для всіх потрібних полів → branch `if (provider === 'X')` false → fall through до `else { logger.warn(...) }` АБО fetch з `undefined` headers → **silent skip** замість throw → BullMQ НЕ retry → side-effect не відбувається → користувач бачить успіх (booking створено) але SMS не приходить.

**Причина виникнення:** дві типові траєкторії:

1. Service-A написано РАНІШЕ за NotificationsService.send() consolidation — розробник передавав raw `{ templateCode, params }` шукаючи майбутній central template resolver, а той resolver потім реалізовано в іншому місці. Service-A не оновили (no compile-time signal).
2. Refactor `bull → bullmq` — processor підпис зміниться з `@Process({ name: 'X' }) async handleX(job)` на `WorkerHost.process(job)`. Старий `@Process({ name })` фільтрував job.name — старий код міг покладатися на цей filter (наприклад, два handler-и на одну чергу для різних name). Новий `WorkerHost.process()` НЕ фільтрує — всі jobs queue потрапляють до одного process(). Якщо два callsite-и додають різні shape з різним name, processor мовчки obj-spread receives обидва і ламається на тому що не його.

**Підхід до виявлення:**

```bash
# Для КОЖНОЇ черги у проекті:
# 1) Знайти ВСІ callsite-и `<queue>.add(name, data, opts)` → витягти `name` + shape `data`
grep -rnE "Queue.*add\(\s*['\"]([^'\"]+)['\"]" apps/api/src --include="*.ts" | grep -v spec

# 2) Знайти @Processor('<queue>') processor і прочитати destructuring у process(job)
grep -rnE "@Processor\(['\"]([^'\"]+)['\"]" apps/api/src --include="*.processor.ts"

# 3) Для кожного processor — прочитати interface SendXJob / FooJob що тип job.data, порівняти з callsite shape
# Конкретно: знайти `interface XxxJob {` у processor.ts → порівняти ключі з ключами data-об'єкту у Queue.add()
# Будь-який unique-у-callsite key (templateCode, params, fooBar) що відсутній у Job interface = bug

# 4) Bonus — якщо одна черга має ДЕКІЛЬКА callsite з РІЗНИМИ shape:
# Старий @Process({ name: 'A' }) + @Process({ name: 'B' }) у двох handlers оброблятимуть різні shape
# Новий WorkerHost.process(job) обробляє ВСІ name → потрібна in-process диспетчеризація через switch (job.name)
# АБО (краще) — окремі черги. Граючий шлях: для NotificationsService.send() — завжди через template-resolve helper, не raw queue.add
```

**Підхід до фіксу:**

1. **Знайти canonical service** для черги (`NotificationsService.send()` для SMS, `SettlementsService.createTransaction()` для balance, `InventoryService.createMovement()` для stock). Канонічний service агрегує `branchSettings`/`template`/`config` resolve + ставить у чергу СПРАВЖНІЙ shape що processor чекає.
2. **Переписати порушуючий callsite** на canonical service. Прибрати `@InjectQueue('queue')` з порушуючого service і відповідний `BullModule.registerQueue` з його модуля. Імпортувати canonical Module замість.
3. **Якщо потрібен новий event-type** (як `BOOKING_CONFIRMATION`) — додати enum value у Prisma schema + написати парний migration `ALTER TYPE ... ADD VALUE IF NOT EXISTS '...'` + seed `NotificationTemplate` у `seed.ts`. Прив'язується до Bug #220 (schema↔migration parity) і Bug #478-#480 (enum coverage у contract+service spec).
4. **Виправити spec**: видалити assert типу `expect(queue.add).toHaveBeenCalledTimes(1); expect(opts.attempts).toBe(10)` (Bug #507 — лише options перевіряє); замість — `expect(canonicalService.send).toHaveBeenCalledWith(orgId, expect.any(String), expect.objectContaining({ branchId, phone, ...placeholders }))`. Регресія яка повертає прямий queue.add упаде на цей expect.

**Severity:** HIGH (фіча розрекламована користувачу = "ми надішлемо SMS" АЛЕ SMS ніколи не приходить — silent UX/business gap; payments аналог був би CRITICAL). MEDIUM якщо побічний ефект не критичний (loyalty earn — клієнт не бачить що бал не нараховано). Підвищується до CRITICAL якщо queue ставить ФІНАНСОВУ операцію (ПРРО фіскальний чек, settlement transaction).

**Де шукати ще:** будь-який `@InjectQueue(name)` поза canonical service. Особливо public/widget endpoints (booking, public form, lead capture) які з'явилися ПЕРЕД centralized service consolidation. Регулярно: після кожного `bull → bullmq` (або major queue-library) migration — повний audit `queue.add` shape vs processor `process` interface для всіх черг. Парне з Bug #267 / #268 (dead-feature integration audit) — там canonical service injected але викликається з мертвого path; тут canonical service не injected взагалі.

---

### 2026-06-16 — Widened service return-type + stale paired spec (Bugs #508-#509) — backend / contract / tests symmetry

**Сигнал:** Service-method сигнатура у одному commit (`523190f2`) розширюється з `Promise<{ id, number }>` до `Promise<{ id, number, status: InvoiceStatus, amount: number, documentDate: string | null }>`. Парний `select` clause розширений (`{ id: true, number: true, status: true, amount: true, documentDate: true }`). Парний mapping додає transformi: `Number(inv.amount)` (Prisma Decimal → JS number), `inv.documentDate?.toISOString() ?? null` (Date → ISO string|null). Backend tsc green, FE tsc green, FE component компілюється проти нового типу. **Baseline unit-spec падає** з cryptic message:

```
AssertionError: expected { …(5) } to deeply equal { …(2) }
- Expected: { id, number }
+ Received: { id, number, status: undefined, amount: NaN, documentDate: null }
```

Mock у `*.service.spec.ts` повертав лише `{ id, number }`; service mapping робить `Number(undefined) → NaN`, `(undefined).toISOString() → null branch`, `inv.status → undefined`. Це release-blocker baseline → блокує всі майбутні tester-сесії. Парне у `*.contract.spec.ts` тихіше: assert `toMatchObject({ id: expect.any(String), number: expect.any(String) })` пропускає undefined нові поля → spec залишається зеленим АЛЕ silently не гейтить регресію — refactor що видалить `status/amount/documentDate` з `select` пройде CI green, FE отримає undefined, status badge відображе сирий код / NaN сума / Invalid Date.

**Причина виникнення:** sprint-pattern де backend implementation + FE consumer оновлюються в одному PR, але regression-guard tests залишаються з лагом 1-2 commits (typical sprint cadence: implementation, type fixes, FE wiring, потім «треба ще оновити тести» — і часто остання частина забувається). Конкретний шлях для цього кейса:

1. Sprint-1 (`feat:`): `findByWorkOrder` повертав 2 поля для запиту "чи є рахунок" → unit/contract spec фіксували 2-полевий shape.
2. Sprint-2 (`feat: invoice section`): FE потребує badge/суму/дату → backend розширює shape до 5 полів.
3. PR оновлює implementation + FE narrow-type, АЛЕ regression-guard tests залишаються 2-полеві.
4. Unit-test падає → release blocker; contract-test проходить → silent regression-guard gap.

Альтернативна траєкторія: review-commit (`aa3b03c5`) звужує/розширює лише частину shape (наприклад додає `status` без `amount`) — тоді тести можуть пройти випадково на половинному mock.

**Підхід до виявлення:**

```bash
# 1) Diff service.ts на розширення return-type + select + mapping. Класичний signal:
git diff HEAD~3 HEAD -- "apps/api/src/modules/*/*.service.ts" | \
  grep -E "^\+\s+(status|amount|documentDate|totalAmount|fiscalCode|[a-z]+At|[a-z]+Count):\s*(true|inv\.|Number|\.toISOString|\?\?\s*null)"

# 2) Для кожного service-method з розширеним return-type:
#    (а) знайти парний *.service.spec.ts → перевірити кожен `findFirst.mockResolvedValue(...)` чи покриває всі НОВІ поля
#    (б) знайти парний *.contract.spec.ts → перевірити `serviceMock.X.mockResolvedValueOnce(...)` чи покриває всі НОВІ поля
#    (в) перевірити assert: `toEqual({ ..full shape.. })` — НЕ `toMatchObject({ id, number })`/`expect.objectContaining({ id })`

grep -rn "mockResolvedValue\|mockResolvedValueOnce" apps/api/src/modules/<scope>/ --include="*.spec.ts" -A 5

# 3) Перевірка assert-style: підмножина-assert (`toMatchObject` без negation) = регресія-guard gap.
grep -rn "toMatchObject({" apps/api/src --include="*.contract.spec.ts" | head -20
```

**Підхід до фіксу:**

1. **Unit-spec mock** — повернути всі нові поля з реалістичними Prisma-shape (Decimal/Date якщо service map їх трансформує; `null` для nullable). Окремий test case для null-branch у nullable полях.
2. **Unit-spec assert** — `expect(result).toEqual({ ..все 5 полів.. })` з конкретними значеннями (не `expect.any` для нових полів — це знижує силу regression-guard).
3. **Contract-spec mock** — той самий 5-полевий shape (контракт мокає service direct, тому Decimal/Date не потрібен — pre-mapped values OK).
4. **Contract-spec assert** — `expect(res.json()).toEqual({ ..все 5 полів.. })` — повна форма wire shape. `toMatchObject` тут НЕ підходить: refactor що видалить поле з `select` поверне `undefined` → JSON-serialize не включить ключ → wire JSON стане 4-полевим → `toMatchObject` (підмножина) усе ще проходить → regression silenced.
5. **Null branch** — окремий test case для кожного nullable поля у новому shape (`documentDate: null` → result містить `documentDate: null`).
6. **Component-test (якщо є FE consumer)** — extract компонент з PageClient у окремий файл (якщо ще не) → component test покриває рендер всіх нових полів (badge label, fmtMoney, fmtDate, fallback null). Bug #510 family.

**Severity:**

- **HIGH** якщо unit-spec падає (release-blocker baseline → ховає реальні регресії шумом).
- **MEDIUM** якщо лише contract-spec gap (silent regression-guard gap — refactor що звужує shape проходить CI).
- **LOW** якщо нове поле косметичне (icon, sortOrder) і FE має fallback.

**Де шукати ще:**

- Кожен `*.service.ts` що чіпається review-commit після feature (типово `aa3b03c5` після `523190f2`).
- Будь-який lightweight-read endpoint що використовується FE для "це існує?" check і пізніше отримує fields для inline-render (counterparty `findActive`, payment `findLast`, contract `findPrimary`).
- Pattern-detection bash для commit-hook: будь-який diff що додає `select` поле + має `select: { id: true, number: true }` стиль → авто-перевірка парних specs.

Парне з:

- **Bug #390** (stale regression-guard після URL/payload-format fix — той самий «після implementation-change оновити парний spec», але для frontend URL).
- **Bug #478-#480** (regression-guard для нового enum value — той самий принцип coverage gap).
- **Bug #432-#433** (audit-track field symmetry — той самий принцип "data list ⊇ audit list").

---

### 2026-06-15 — `setX(value)` викликається у async-операції, але `x` не читається у JSX (Bug #497) — frontend / dead-state / UX feedback

**Сигнал:** `const [loading, setLoading] = useState(false)` (або `loadingId`, `saving`, `processingId`) → setter викликається ВСЕРЕДИНІ async-handler (`setLoading(true)` перед `await apiFetch`, `setLoading(false)` у finally), state перевертає React render, але `loading` НІКОЛИ не читається у JSX — немає `{loading && <Spinner/>}`, немає `disabled={loading}` на кнопці, немає `loading={loading}` prop. Класичний Bug #160 — обидві сторони (setter + reader) мертві. Тут гірше: setter викликається → extra renders + memory churn + закидаються mutation queue events, але user НЕ бачить жодної реакції UI на запит. UX silent: користувач клікає Pencil → 1-3s нічого не відбувається → бачить що з'явився Modal → не розуміє чому затримка.

**Причина виникнення:** refactor видалив JSX-блок що читав state (наприклад, видалив всю Detail Modal стару секцію та переписав на React Query hook), але забув видалити setLoading/loading state. Альтернативно: розробник збирається додати feedback пізніше, але забуває (TODO без stamp).

**Підхід до виявлення:**

```bash
# Знайти потенційні mute-loading state
grep -rnE "useState[<(]boolean|useState\(false\)|useState<string \| null>\(null\)|useState<number \| null>\(null\)" apps/web/src/app --include="*.tsx" -A 1 | grep "const \[" | head -30

# Для кожного state-name перевірити usage у тому ж файлі
state_names=("loading" "saving" "processing" "loadingId" "savingId" "applyingPricingId" "transitioning" "submitting" "deletingIds")
for name in "${state_names[@]}"; do
  for f in apps/web/src/app/**/*.tsx; do
    [ -f "$f" ] || continue
    has_decl=$(grep -c "const \[$name," "$f")
    [ "$has_decl" -eq 0 ] && continue
    # Кількість read у JSX (виключаємо declaration і setter calls)
    has_read=$(grep -cE "\{$name|$name &&|$name\?|disabled=\{$name|loading=\{$name|if \($name" "$f")
    if [ "$has_decl" -gt 0 ] && [ "$has_read" -eq 0 ]; then
      echo "MUTE STATE: $f → $name (setter called but value never read in JSX)"
    fi
  done
done
```

**Підхід до фіксу:** два варіанти, оба валідні:

1. **Видалити state**, якщо feature feedback справді не потрібна (наприклад, операція займає <100ms — користувач не помітить). Видалити setter calls і useState declaration.
2. **Додати render-time consumption**: для **single-row** state (`saving`, `transitioning`, `loading`) — `disabled={saving}` + `loading={saving}` prop на пов'язану кнопку АБО `{saving && <Spinner/>}`. Для **per-row tracking** (`detailLoadingId: string | null`) — `loading={detailLoadingId === row.id}` + `disabled={detailLoadingId === row.id}` на per-row action button. Per-row pattern уникає накладного `disabled` для ВСІХ рядків коли тільки один in-flight.

**Severity:** MEDIUM (silent UX gap — користувач не розуміє чому затримка/чи кнопка спрацювала). LOW якщо async-operation < 100ms (немає сприйнятого затримки). Парне з Bug #303 (in-flight guard без overlay-блокування) — дублікат click ризикує race + silent failure якщо немає disabled feedback.

**Де шукати ще:** будь-який `loadDetail`/`fetchFull`/`fetchOne`/`loadOptions` що робить async fetch — потенційний кандидат на per-row loading-state у row action buttons. Також search input з debounced fetch + loading-spinner. Також inline-edit save button + savingIds set.

---

### 2026-06-15 — `mutateAsync()` у inline click-handler без try/catch — silent failure при mutation error (Bug #499) — frontend / error-handling / silent UX failure

**Сигнал:** Inline `onClick={async () => { await someMutation.mutateAsync(arg); toast.success('...') }}` — без `try/catch` і без `useMutation({onError: ...})` у hook і без глобального `MutationCache.onError` у `QueryClientProvider`. `mutateAsync` rejects → throw перериває handler → `toast.success` НЕ виконується, але `toast.error` теж НЕ показується → користувач клікнув "Видалити" → нічого не відбулось → бачить що рядок все ще там → плутанина.

**Причина виникнення:** розробник вважає що TanStack Query автоматично показує помилки. Це НЕ так — `useMutation` має `onError` callback що треба явно конфігурувати. Якщо проект не має `MutationCache.onError` (типово не має), то КОЖЕН mutateAsync без обгортки = silent failure point.

**Підхід до виявлення:**

```bash
# 1. Перевірити чи є глобальний MutationCache.onError
grep -rn "MutationCache\|mutationCache:" apps/web/src
# Якщо результат пустий → ВСІ inline mutateAsync без try/catch = bug

# 2. Знайти inline mutateAsync calls
grep -rnE "await\s+\w+\.mutateAsync\(" apps/web/src/app --include="*.tsx" -B 2 -A 3 | grep -B 5 "mutateAsync"

# 3. Для кожного match — перевірити чи є try/ catch
# pattern: спочатку try, потім await, потім catch — або відсутня обгортка
```

**Підхід до фіксу:** два варіанти, в порядку preference:

1. **Per-hook `onError`** (preferable): у `useDeleteX()` додати `useMutation({ mutationFn, onError: (e) => toast.error(e.message), onSuccess: () => qc.invalidate(...) })`. Спрацює для ВСІХ callers без обгортки кожного інлайн handler. Це SSOT для error handling specific mutation.
2. **Inline try/catch** у конкретному handler: `try { await mut.mutateAsync(); toast.success } catch (e) { toast.error(e.message) }`. Менш ergonomic, але корисно коли error message contextual до callsite (наприклад, "Не вдалось видалити повернення X" замість generic).

Альтернатива (highest leverage): **глобальний MutationCache.onError** у `QueryClientProvider`. Захищає від ВСІХ майбутніх mutateAsync calls без додаткової роботи. Не покриває success-toast (контекстуальний), але покриває силенце-throw scenarios.

**Severity:** MEDIUM (silent failure, user confusion). HIGH якщо mutation видаляє/змінює важливий ресурс (Invoice, Payment, WorkOrder transition) — користувач не знає чи операція пройшла → робить duplicate-click → потенційна data inconsistency.

**Де шукати ще:** будь-який inline `onClick={async () =>` що робить single-step mutation. Особливо: ICON-button у row-actions (Trash2/Pencil/Zap), inline-confirm dialogs, bulk-actions handlers. Також `useEffect(() => { mutation.mutateAsync() }, [])` — той самий ризик через unhandled promise rejection.

---

### 2026-06-15 — `Partial<Record<Enum, V>>` lookup з runtime fallthrough ховає TS-exhaustiveness (Bug #488) — backend / business logic / type-safety

**Сигнал:** service-метод заводить map `Partial<Record<EnumX, ValueY>>` для look-up знаку/типу/factor по enum value, з runtime guard `if (sign === undefined) throw new Error(\`Unknown EnumX: ${dto.type}\`)`. Зараз ВСІ значення enum присутні у map — runtime throw неможливий. АЛЕ через `Partial<>`додавання нового enum value (через Prisma migration`ALTER TYPE ... ADD VALUE`) **пройде compile зеленим** → runtime exception у проді при першому використанні нового типу.

**Причина виникнення:** автор почав з порожньої мапи (`{}` literal) → TS вимагав `Partial<Record<...>>` щоб literal був валідним. Потім додав 5 значень — забув видалити `Partial<>`. Compile-час забезпечує безпеку лише при `Record<Enum, V>` (без Partial); `Partial<>` спеціально знімає цю гарантію.

**Підхід до виявлення:**

```bash
# grep: Partial<Record<EnumType, ...>>
grep -rnE "Partial<Record<[A-Z][a-zA-Z]+(Type|Status|Role|Kind),\s" apps/api/src/modules --include="*.ts" | grep -v spec
# для кожного match — перевірити чи всі enum values присутні у map; якщо так — Partial<> непотрібно (compile-time помилка краще ніж runtime).
# додатковий tell: `if (X === undefined) throw new Error(...)` у наступних рядках = compensation для слабкого TS.
```

**Підхід до фіксу:** замінити `Partial<Record<Enum, V>>` на плоский `Record<Enum, V>`. TS-compiler вимагатиме всі enum values → додавання нового через migration зловить compile-error у service. Видалити runtime guard (unreachable з exhaustive map). Якщо проєктно потрібна `Partial<>` (опційний lookup з legitimate fallback) — залишити, АЛЕ задокументувати inline коментарем "intentional partial: <причина>" і додати regression-guard spec для default-branch.

**Severity:** MEDIUM (runtime exception у проді при додаванні enum value, але рідкісне). HIGH якщо map гейтить фінансову операцію (BALANCE_SIGN, TAX_RATE, VAT_FACTOR) — невідомий enum value → throw blocks transaction commit → бізнес-операція зупиняється.

**Де шукати ще:** `MOVEMENT_TYPES`, `docTypeMap`, `TRANSITIONS` (FSM maps), `LABELS`/`BADGE`/`COLOR` UI maps (для UI — допускається `Partial<>` з fallback "—"), будь-який `Record<EnumX, fn>` switch-replacement у sales/payments/inventory services.

---

### 2026-06-15 — Dedup invariant додано після simplify-to-Promise.all БЕЗ regression-guard у spec (Bug #489) — test-coverage / silent data corruption

**Сигнал:** simplify-цикл замінив sequential `for-loop { await tx.X.update(...) }` на `await Promise.all(plan.map(u => tx.X.update(...)))` для batch-write. Sequential loop мав last-write-wins (наступний overwrite попередній); Promise.all без dedup → race-deterministic ОДНОГО winner на той самий PK. Щоб зберегти last-wins, simplify також додає `const dedupedPlan = deduplicateBy(plan, u => u.pk)` ПЕРЕД Promise.all. АЛЕ парний `*.service.spec.ts` НЕ перевіряє цей invariant — refactor що дропне `deduplicateBy` (наприклад, рефакторщик «бачить dead code — викликаємо deduplicateBy на масив де PK уже унікальний») пройде CI зеленим, бо тести не конструюють duplicate-PK сценарій.

**Причина виникнення:** автор знає що production-дані можуть мати дублікати PK (PO multi-lot lines на той самий goodId, xlsx-import з повтор��ваним SKU), але тестові fixture-и завжди використовують унікальні PK для зручності. SKILL §1.5 «Стала spec після рефактору сервісу» ловить TS/DI gaps, але НЕ ловить semantic-invariant gaps типу dedup.

**Підхід до виявлення:**

```bash
# Step 1: знайти всі deduplicateBy/Map-based dedup callsites
grep -rn "deduplicateBy\|new Map(.*\.map.*=> \[" apps/api/src/modules --include="*.service.ts" -l

# Step 2: для кожного service — перевірити чи parent spec має duplicate-PK regression-guard
for svc in $(grep -rl "deduplicateBy" apps/api/src/modules --include="*.service.ts"); do
  spec="${svc%.ts}.spec.ts"
  matches=$(grep -cE "deduplicate|duplicate.*(goodId|lineId|id)" "$spec" 2>/dev/null)
  echo "$spec: $matches matches"
done
# 0 matches = bug

# Step 3: верифікувати exactly-once expectation у dedup-spec
# expect(prisma.X.updateMany).toHaveBeenCalledTimes(1)  ← КРИТИЧНИЙ
# expect(prisma.X.updateMany).toHaveBeenCalledWith({ data: { Y: <last-value> } })  ← last-wins
```

**Підхід до фіксу:** додати regression-guard test у `*.service.spec.ts` що:

1. Конструює `plan`/`lines`/`items` з 2+ entries з ОДНИМ PK (різні `newSalePrice`/`price`/`quantity`).
2. Mock-ит downstream lookup (`pricingService.computePriceFromRules`) щоб повернути різні значення для двох ітерацій.
3. Запускає method (`applyPricing`/`applyPricingFromList`/`receive`/`transition`).
4. Асертить `expect(prisma.<model>.updateMany).toHaveBeenCalledTimes(1)` (НЕ 2!).
5. Асертить `data: { <field>: <last-value> }` (last-wins у БД).
6. Опційно: `result.updated === 2` (informational count з оригінального plan) — задокументувати у тесті, що різниця між `dedupedPlan.length` (writes) і `plan.length` (informational) — навмисна.

**Severity:** MEDIUM (silent data corruption на production даних з duplicate-PK; runtime exception відсутній, race-determinism дає випадковий winner у БД).

**Окремий sub-pattern: stale `$transaction` mock у callback-form (виявлено у `pricing.service.spec.ts`):**

```ts
// ❌ ПОМИЛКА: повертає callback як значення, БЕЗ виклику.
$transaction: vi.fn(async (ops: unknown[]) => ops),

// ✅ ПРАВИЛЬНО: розпізнає ОБИДВІ форми (array + callback) і виконує callback з self як tx.
$transaction: vi.fn().mockImplementation((arg: unknown) => {
  if (Array.isArray(arg)) return Promise.all(arg as Promise<unknown>[]);
  if (typeof arg === 'function') return (arg as (tx: unknown) => Promise<unknown>)(prisma);
  return Promise.resolve(arg);
}),
```

Якщо service спрощено з array-form до callback-form `$transaction(async tx => { ... }, { timeout })` АЛЕ spec мок не оновлено → INNER логіка ($transaction body) НЕ виконується → ВСІ внутрішні `updateMany`/`createMany`/`tx.X` asserts мовчки проходять без виклику. Перевірити: для кожного `$transaction(async ... ) ` у service → spec мок ОБОВ'ЯЗКОВО розпізнає callback.

**Де шукати ще:** будь-який `applyX`/`bulkUpdateX`/`recalculateX`/`syncFromY` service-метод що обробляє массив з потенційними duplicates PK. Особливо вразливі: pricing (PO/xlsx/manual rule apply), reservation release on FSM transition, batch FEFO writeoff, settlement reconciliation, period-end accounting close.

---

### 2026-06-15 — Новий documentType literal не зареєстрований у DOC_TYPE_LABELS map (Bug #491) — backend / i18n / UI consistency

**Сигнал:** Новий ресурс/feature (наприклад `SupplierReturn`, `ServiceContract`, `ReconciliationAct`) додає в schema.prisma модель, її сервіс пише StockMovement/SettlementTransaction з `documentType: '<NewName>'` (PascalCase model-name convention), АЛЕ `apps/api/src/modules/inventory/inventory.service.ts:DOC_TYPE_LABELS` НЕ має парного запису. Через те `docLabel(documentType, documentId)` робить fallback `DOC_TYPE_LABELS[documentType] ?? documentType` → у UI (stock movement history, settlement history) показується англомовний літерал `'SupplierReturn'` замість українського `'Повернення постачальнику'`. CLAUDE.md правило #15-#17 (UI українською) силенто порушене.

**Причина виникнення:** автор фокусується на business логіці confirm(), на правильному WRITEOFF/REFUND, на FSM — і пропускає UI label maps у downstream services (inventory/settlements). Map знаходиться у ЧУЖОМУ модулі (inventory) і не імпортується у новий сервіс — фокус-blindness. Жоден TS compile-error не виникає (Record<string,string> приймає будь-який ключ).

**Підхід до виявлення:**

```bash
# Step 1: знайти ВСІ unique documentType literals що передаються у inventory/settlements
grep -rnE "documentType:\s*'[A-Z][a-zA-Z]+'" apps/api/src/modules --include="*.service.ts" | \
  grep -oE "'[A-Z][a-zA-Z]+'" | sort -u

# Step 2: cross-check проти DOC_TYPE_LABELS map keys
grep -oE "^\s+[A-Z][a-zA-Z]+:\s*'" apps/api/src/modules/inventory/inventory.service.ts | \
  grep -oE "[A-Z][a-zA-Z]+" | sort -u

# diff двох списків → unmapped literals = bug
```

**Підхід до фіксу:** додати запис `<NewModel>: 'Український label'` у `DOC_TYPE_LABELS` map. Альтернатива (better): винести map у `packages/shared/src/constants/document-labels.ts` як `DOCUMENT_TYPE_LABELS: Record<DocumentType, string>` з `Record<>` (НЕ Partial) — TS-exhaustiveness заверне commit що додає новий enum value без парного label.

**Severity:** MEDIUM (UI inconsistency; не runtime crash; не data corruption). LOW якщо feature internal/admin-only.

**Де шукати ще:** новий ресурс що пише `documentType` у будь-яку history-таблицю: `StockMovement.documentType`, `SettlementTransaction.documentType`, `AuditEvent.entityType`, `NotificationEvent.relatedDocumentType`. Парна перевірка: чи `i18n/uk-UA.json` / shared label maps мають localized string для нового enum value.

---

### 2026-06-15 — DTO line-level FK поля (`goodId`, `unitOfMeasureId`) пишуться через `createMany` без cross-tenant guard (Bug #495) — backend / tenant isolation / Bug #161 family

**Сигнал:** Service `create()`/`update()` приймає `dto.lines: Array<{ goodId, unitOfMeasureId?, ... }>` і пише прямо через `tx.<resource>Line.createMany({ data: dedupedLines.map(...) })` БЕЗ preceding `prisma.good.findFirst({ orgId, id: l.goodId })` валідації для КОЖНОГО FK у lines. Це Bug #161 (Optional FK у data-spread) розширене на nested arrays — додатково ризикове бо batch-write масштабує impact. Sister patterns: PO lines, WO parts, Invoice lines, StockDocument lines, ServiceContract items.

**Причина виникнення:** автор валідує parent FKs (`supplierId`, `warehouseId`) явним `findFirst({ orgId })` на топ-рівні DTO, але child line FKs пропускає тому що (а) Prisma FK constraint вже валідує — здається достатньо; (б) batch validation виглядає затратним (N RTT?); (в) автор тестує тільки happy-path з валідними IDs з тієї ж org. Prisma FK constraint валідує лише глобальне існування `id`, НЕ `orgId` → cross-tenant FK linkage проходить без error → ADMIN з валідним JWT може створити повернення/наряд/документ з goodId з чужої org.

**Підхід до виявлення:**

```bash
# Step 1: знайти всі service-методи що роблять createMany з масиву lines DTO
grep -rnE "tx\.\w+Line\.createMany\s*\(\s*\{" apps/api/src/modules --include="*.service.ts" -l

# Step 2: для кожного service — перевірити що ПЕРЕД createMany є batch-validation:
# `prisma.good.findMany({ where: { id: { in: [...] }, orgId, deletedAt: null }, select: { id: true } })`
# або per-line findFirst в loop (антипаттерн, але працює)
grep -B5 "Line\.createMany" <service.ts> | grep -E "good\.findMany.*orgId|good\.findFirst.*orgId"
# 0 matches = bug

# Step 3: парна перевірка унікальних FK fields у lines DTO:
# для кожного `*Id` поля у `<resource>LineDto` (goodId, unitOfMeasureId, brandId, supplierId)
# має бути guard.
```

**Підхід до фіксу:** додати приватний метод `validateLineRefs(orgId, lines)` що робить batch through `Promise.all`:

```ts
const goodIds = Array.from(new Set(lines.map(l => l.goodId)));
const uomIds = Array.from(new Set(lines.map(l => l.unitOfMeasureId).filter(Boolean)));
const [goods, uoms] = await Promise.all([
  prisma.good.findMany({
    where: { id: { in: goodIds }, orgId, deletedAt: null },
    select: { id: true },
  }),
  uomIds.length > 0
    ? prisma.unitOfMeasure.findMany({
        where: { id: { in: uomIds }, orgId, deletedAt: null },
        select: { id: true },
      })
    : Promise.resolve([]),
]);
if (goods.length !== goodIds.length)
  throw new NotFoundException(`Товар не знайдено: ${missing[0]}`);
```

— 1-2 RTT регдрозу від N послідовних. Викликати ПЕРЕД `$transaction` (read-only). Регресія-guard: spec з cross-tenant fixture (`good.findMany` повертає N-1 з N) → асерт `rejects.toThrow(NotFoundException)` + `expect(prisma.X.create).not.toHaveBeenCalled()`.

**Severity:** HIGH (tenant isolation gap; defense-in-depth; не runtime crash але дозволяє data leak/linkage cross-org). CRITICAL якщо feature видима через UI з drop-down що показує тільки власні org-данні, але API direct call дозволяє cross-tenant FK.

**Де шукати ще:** будь-який `<resource>Line[]` DTO у create/update: `SupplierReturn`, `PurchaseOrder`, `Invoice`, `StockDocument`, `WorkOrder` (parts), `ReconciliationAct`, `ServiceContractItem`. Також: nested `recipients[]` у notifications, `permissions[]` у roles, `vehicleIds[]` у customers — будь-який masked-as-string FK всередині array DTO.

---

### 2026-06-14 — Multi-mode page викликає всі data hooks одночасно замість gate-у по mode (Bug #457) — frontend / perf / wasted-fetches

**Сигнал:** Сторінка має `viewMode` switcher (tabs / pill buttons / select) що показує одну з N data-source. Hooks (`useStockByDocument`, `useStockByBatch`, `useStockItems` etc.) викликані безумовно на top-level — ВСІ N запитів стартують одночасно на mount, навіть якщо лише 1 visible.
**Причина виникнення:** автор бачить що hooks мають React-rules (не можна виклика��и в `if`); знає що TanStack Query кешує → "при перемиканні mode дані вже готові". Plus TanStack `enabled: !!employee` гейт виглядає достатнім. Cost: для звіту з 5000 рядків × 3 hooks = ~1.5MB зайвого трафіку при кожному mount + race з backend під час інтенсивного використання.
**Підхід до виявлення:**

- grep: `useState<.*ViewMode\|viewMode\s*===\s*['"]` у `.tsx` → знайти switch-state. Для того ж файлу — порахувати `useQuery` хуки на top-level. Якщо `count(useQuery) > 1` АЛЕ `count(enabled.*viewMode|enabled:.*===)` = 0 → bug.
- runtime: open DevTools Network на page mount у default mode → побачити N >1 запитів до різних endpoints, де тільки 1 потрібен.
- code-review: будь-який `viewMode === 'X' && <ComponentUsingHook>` → але hook викликається вище незалежно → fetch стартує дарма.
  **Підхід до фіксу:** додати opt-in `enabled?: boolean` параметр у кожен mode-specific hook (default `true` для зворотньої сумісності), внутрішньо `enabled: !!employee && enabled`. Споживач передає `viewMode === 'documents'` / `viewMode === 'batches'`. AND-юється з auth gate. Regression-guard: hook test що `renderHook(useX({}, false))` → НЕ викликає `apiFetch` (>50ms wait).
  **Severity:** MEDIUM (perf-only; не data corruption). HIGH якщо endpoint важкий (агрегації >1000 рядків, JOIN з мульти-таблицями) або mode рідко використовується ⇒ більшість запитів зайві.
  **Де шукати ще:** будь-яка `*/page.tsx` зі switcher: `inventory`, `reports`, `dashboard`, `analytics`, `calendar` (week/month/list views), dispatch board, settings sub-tabs з різними даними.

---

### 2026-06-14 — useEffect deps на array-of-object refetches network на кожну mutation НЕ-key поля (Bug #454) — frontend / perf / network-overuse

**Сигнал:** useEffect фетчить data за деякими "key" полями (наприклад `goodId` set з масиву об'єктів), але має у deps сам масив (`[parts, ...]`) → typing у НЕ-key поле (quantity, price, name) створює нову reference масиву → effect re-fires → network call дублюється на кожен keystroke.
**Причина виникнення:** автор бачить що deps має містити `parts` бо ефект «читає» `parts.map(p => p.goodId)`. ESLint react-hooks/exhaustive-deps вимагає `parts`. Але семантично — потрібен ТІЛЬКИ derived set.
**Підхід до виявлення:**

- grep: `useEffect.*apiFetch` де deps містить array prop/state + всередині `.map(/.filter()` для derived ключа
- runtime: open DevTools Network, type у quantity/price input → observe множинні calls до того ж endpoint
- code-review: будь-який `[arrayOfObjects, otherKey1, otherKey2]` де effect body виконує `.map(x => x.specificField)` — підозрілий
  **Підхід до фіксу:** memoize stable string fingerprint `useMemo(() => sortedSetOfKeys.join(','), [array, ...])` → useEffect deps = `[fingerprint]`. Sort обов'язковий для уникнення false-positive при reorder. Apply same pattern для будь-якого derived-set ефекту.
  **Severity:** MEDIUM (perf-only; не data corruption, але dev → production scaling cost). HIGH якщо ефект має race-conditions (cancelled flag insufficient при швидких циклах) або endpoint дорогий (групує по 100+ елементах).
  **Де шукати ще:** `BulkActionsBar`, list pages з batch-select (ids → fetch metadata), filter sidebar з debounce, settings sub-screens з `Promise.all(...).then(setMap)`.

---

### 2026-06-15 — Нове enum value додано через DTO+service+frontend БЕЗ regression-guard для самого value (Bugs #478-#480) — test-coverage / regression-guard gap

**Сигнал:** commit вигляду `feat(<scope>): add <NEW_VALUE> to <Enum>` що змінює:

1. Prisma schema enum (`StockDocumentType.RECEIPT`) + migration `ALTER TYPE ... ADD VALUE`;
2. `@sto/shared` constants (`*_LABELS`, `*_BADGE`);
3. backend DTO whitelist (`@IsEnum(['A', 'B', 'NEW'])` у Create + Query DTO);
4. backend service maps (`MOVEMENT_TYPES[NEW] = ...`, `docTypeMap[NEW] = ...`);
5. frontend hardcoded array (`const types = ['', 'A', 'B', 'NEW']`).

АЛЕ парний spec-файл (`*.contract.spec.ts` / `*.service.spec.ts`) **залишається з тестами тільки для старих values**. Grep по `*.spec.ts` для `NEW_VALUE` → 0 matches.

**Причина виникнення:** автор фокусується на runtime — клікає у UI, бачить що вкладка відкривається, документ створюється → "працює". Перевіряє happy path лайв-сервером, але існуючі тести вже зелені — і нові тести не пише, бо «логіка така ж як для WRITEOFF» (асиметрично-помилкове припущення: RECEIPT vs TRANSFER має різну гілку — TRANSFER кличе createMovement двічі з target+source, RECEIPT раз; RECEIPT vs WRITEOFF — sign quantity). sto-review-agent ловить frontend-side gap (hardcoded array — патерн Bug #432-family), АЛЕ test-coverage gap НЕ катить TS-помилку → проходить непомітно.

**Підхід до виявлення:**

```bash
# Step 1: знайти commit що додає enum value
git log --oneline -10 | grep -iE "add.*type|new.*enum|feat\(.*\): add"

# Step 2: extract new value name з commit body / diff schema.prisma
git show <commit> -- packages/database/prisma/schema.prisma | grep -A1 "^enum"

# Step 3: для КОЖНОЇ зміни DTO/service з новим value — grep spec
for spec in apps/api/src/modules/<scope>/*.spec.ts; do
  matches=$(grep -c "<NEW_VALUE>" "$spec")
  echo "$spec: $matches matches for <NEW_VALUE>"
done
# 0 matches = bug

# Альтернативно: повний аудит по всіх spec-файлах модуля
grep -rn "<NEW_VALUE>" apps/api/src/modules/<scope>/ --include="*.spec.ts"
```

**Підхід до фіксу:** додати мінімум 3 regression-guards у парному contract+service spec:

1. **Contract — POST з `type: NEW_VALUE` → 201** (захищає `@IsEnum` whitelist у Create DTO).
2. **Contract — GET з `?type=NEW_VALUE` → 200, service отримує `NEW_VALUE`** (захищає Query DTO + контрольний argv-position у findAll).
3. **Service — `transition(NEW_VALUE-doc, CONFIRMED)` або еквівалент** → перевіряє map-резолв (movement type, doc type) ТА сторону side-effect (count викликів, sign quantity, target vs source warehouse), гілку switch/if. Specifically:
   - `expect(inventory.createMovement).toHaveBeenCalledTimes(1)` ← ловить «хтось випадково додав NEW до TRANSFER-branch що кличе двічі».
   - `expect(dtoArg.type).toBe(StockMovementType.NEW_VALUE)` ← ловить `MOVEMENT_TYPES[NEW]` resolved (не undefined → не «Непідтримуваний тип»).
   - `expect(dtoArg.quantity).toBeGreaterThan(0)` (або `< 0` для WRITEOFF-family) ← ловить помилку quantity-sign логіки у `doc.type === 'WRITEOFF' ? -line.quantity : line.quantity`.
   - `expect(docNumbers.next).toHaveBeenCalledWith(orgId, 'PARENT_DOC_TYPE')` ← ловить `docTypeMap[NEW]` resolved.
   - `expect(dtoArg.warehouseId).toBe(WAREHOUSE_ID)` ← перевірка що НЕ targetWarehouseId (для RECEIPT/WRITEOFF без target).

Якщо service spec-файлу ВЗАГАЛІ нема (Bug #480 case) — створити новий з `Test.createTestingModule` + mock усіх injectable dependencies + `vi.fn()` для prisma sub-models. Pattern: див. `apps/api/src/modules/stock-documents/stock-documents.service.spec.ts` (створений у f59c6a47).

**Severity:** HIGH — кожен з 3 рівнів (whitelist DTO, map resolve, branch logic) може мовчазно зламатись у наступному refactor. TS green, baseline tests green. Live runtime: 400 на POST, 400 на GET filter, «Непідтримуваний тип документу» на CONFIRM — все три ловляться лише користувачем.

**Де шукати ще:** будь-який модуль що має enum-керовані гілки. Перевіряти кожен sprint:

- `WorkOrderStatus` (FSM transitions) — новий статус повинен мати spec для `transition(currentStatus, NEW_STATUS)` що перевіряє side-effects (резервування / списання / settlement).
- `InvoiceStatus`, `PurchaseOrderStatus` — теж саме.
- `StockMovementType`, `StockDocumentType` — як у Bug #480.
- `DocumentType` (numbering prefixes) — `documentNumberService.next(orgId, NEW_TYPE)` має мати unit + e2e тест що prefix правильний.
- `PaymentMethod`, `CounterpartyType`, `EmployeeRole` — додавання нової ролі/типу платежу часто має if-else у guards.
- Будь-який backend service з `switch (type)` або `Record<EnumType, X>` map.

---

### 2026-06-14 — Новий endpoint без service spec + contract spec при доданні фічі (Bugs #452, #453) — test-coverage / regression-guard gap

**Сигнал:** commit з новим `@Get('endpoint')` у controller + новим method у service → grep по spec-файлу для нового method → 0 матчів. Особливо коли endpoint потрапляє у hot-path UI (modal, list-page filter).
**Причина виникнення:** "це маленький endpoint, перевірю руками"; автор робить browser-test через Network tab → працює → не пише spec. Перший review (sto-review) fix-ить guard-и (UUID validation, etc.) АЛЕ без spec-ів регресія цих guard-ів пройде CI green.
**Підхід до виявлення:**

- `git diff HEAD~N HEAD --name-only -- "apps/api/src/modules/**/*.controller.ts" "apps/api/src/modules/**/*.service.ts"` → для кожного нового method → grep у парному `.spec.ts`
- список пар: `find apps/api/src/modules -name "*.controller.ts"` для кожного → перевірити чи є `*.contract.spec.ts` у тій же папці
  **Підхід до фіксу:** додати describe('newMethod') у service spec з 5-7 кейсами (empty input, tenant isolation, soft-delete, edge null/0, cross-tenant); створити окремий `*-<feature>.contract.spec.ts` з 10-12 HTTP-кейсами (validation 400, RBAC 403, boundary, dups, malformed).
  **Severity:** MEDIUM (release-blocker якщо guard CRITICAL — UUID validation, ліміти; LOW якщо тільки happy path).
  **Де шукати ще:** будь-який `feat(<scope>):` commit без парного `test(<scope>):` або `spec` modifications. Auto-rule: commit що додає метод у service МАЄ мати diff у `<service>.spec.ts`.

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

**Сигнал:** review-fix або попередня tester-сесія видалила dead state (typu `useState<X|null>(null)` + render-залежний компонент). Залишилась **affordance**: `<Toggle enabled={x.enabled} onToggle={x.toggle}/>`, `<Button onClick={openX}>`, hotkey-handler, або command palette entry — які керують hook/state, що більше **нічого не контролює**. tsc green, тести green, баг невидимий бо UI кнопка лишається. Користувач натискає → нічого не відбувається (або щось мутується у localStorage без візуального ефекту).
**Причина виникнення:** review-fix орієнтується на компонент-консумент (DetailPanel/Modal/Tooltip), видаляє його, але affordance live у іншому регіоні JSX і не помічена. Особливо ризиково коли affordance імпортує hook з shared utility (`useListPage` повертає `detailPanel` завжди), і destructure не позначений як unused (TS без `noUnusedLocals` мовчить).
**Підхід до виявлення:**

1. Після `Bug #496`-стилю dead-state fix у одному файлі — пройти ВСІ paired list-pages: `grep -rln "DetailPanel\b\|DetailPanelToggle\|<XPanel" apps/web/src/app/\(app\)`.
2. Для кожного знайденого консумента → перевірити чи його `open`/`enabled` prop отримує state, який десь у файлі set non-null/true з події. Якщо state set тільки до null/false → бо умовний rendering завжди false → affordance мертвий.
3. Grep affordance-pattern: `grep -rnE "<DetailPanelToggle |hotkey:|cmdK:|<MinimizeButton" apps/web/src --include="*.tsx"` → для кожного match знайти hook-стан що toggle мутує (`useDetailPanel.enabled`) → пошукати **єдиний** consumer-компонент у тому ж файлі → якщо немає або consumer-prop завжди false → bug.
4. Парний сигнал: review-fix commit з `delete` рядками >50% від `insert` — підозра що видалено renderable consumer без видалення affordance.

**Підхід до фіксу:**

- Видалити affordance (toggle button, hotkey, command entry) разом з destructure hook поля.
- Якщо affordance використовується у багатьох файлах і консумент мертвий лише у деяких → залишити affordance у працюючих файлах, видалити тільки у dead files.
- НЕ залишати "TODO: відновити DetailPanel" коментар — або відновити, або видалити. Mертвий код + TODO = подвоєний tech debt.

**Severity:** MEDIUM (UX confusion + dead localStorage writes via useDetailPanel; LOW якщо affordance не глобально-видима — наприклад hotkey без UI hint). HIGH якщо affordance декларована як key feature (toolbar з підказкою).
**Де шукати ще:** будь-який shared hook що повертає toggle-state (`useDetailPanel`, `useColumnsConfig`, `useSavedFilters`, `useBulkSelect`) — destructure без render consumer = bug-shaped. Команд-палітра entries що ведуть до неіснуючої сторінки (Bug #354 sub-pattern). Hotkey handlers що змінюють state не зчитуваний у JSX.
**Регресія-guard:** vitest snapshot тест на JSX layout страниці що падає коли affordance виник, але consumer ні. Альтернатива: rule-of-thumb commit hygiene "при видаленні React-компонента — обов'язково grep affordance у тому ж файлі".

---

### 2026-06-15 — Backend stale-FK cleanup у service.update() (Bug #473, paired Bugs #365, #367 frontend) — backend / business-logic / data-integrity

**Сигнал:** service.update() приймає `dto.parentFkId` (`supplierId`/`counterpartyId`/`vehicleId`) АЛЕ FE забуває включити dependent child FK (`contractId`/`agreementId`/...) у PATCH body. Якщо backend silent-keep-ає старий `child` FK → cross-parent orphan: `child.parentFk` тепер відмінне від `parent.id` (`po.contract.counterpartyId !== po.supplierId`). P2003 не спрацює (target row існує у self-org); UI показує "договір N" що насправді належить ІНШОМУ постачальнику.
**Підхід до виявлення:** для КОЖНОГО `service.update()` на ресурсі з ≥2 пов'язаними FK (`parentFkId` + dependent `childFkId`):

```bash
# 1. SELECT po має включати BOTH parent FK і dependent child FK
grep -nE "findFirst.*select:.*{(\s|$)" apps/api/src/modules/<resource>/<resource>.service.ts -A5 | \
  grep -E "Id:\s*true" | sort
# 2. Branch має: `if (dto.parentFkId !== po.parentFkId && po.childFkId) { newChildFkId = null; }`
grep -n "parentChanged\|supplierChanged" apps/api/src/modules/<resource>/<resource>.service.ts
```

**Підхід до фіксу:**

1. SELECT extends to include parent FK + ВСІ dependent FK у `findFirst().select`
2. Compute `<parent>Changed = dto.<parent>Id !== undefined && dto.<parent>Id !== po.<parent>Id`
3. Логіка для dependent child FK у 4 гілки:
   - (a) `dto.childFkId === string` — validate проти `effective<Parent>Id = dto.<parent>Id ?? po.<parent>Id` (cross-parent rejection)
   - (b) `dto.childFkId === null` — explicit clear (frontend manual unset)
   - (c) `<parent>Changed && po.<child>FkId` — auto-clear stale
   - (d) otherwise — keep existing (Prisma `undefined`)
4. ОБОВ'ЯЗКОВО парний regression-spec для всіх 4 гілок (особливо (c) — стає невидимою у refactor якщо нема тесту).
5. DTO: `child?: string | null` з `@ValidateIf((_, v) => v !== null) @IsUUID()` + `@Transform(emptyToUndefined)` (приймає null/UUID/'')

**Severity:** HIGH (silent cross-parent data corruption; frontend може правильно очищати, але backend silent-keep-ає, що особливо ризиково коли FE/BE розробляються паралельно і фронт reset робить ОДИН з трьох код-шляхів — picker modal, inline picker, manual unset).
**Де шукати ще:** `WorkOrderService.update` (counterpartyId + vehicleId), `InvoiceService.update` (counterpartyId + workOrderId + paymentMethodId), `StockDocumentService.update` (counterpartyId + warehouseId target), `SettlementService.transferTransaction` (fromAccountId + toAccountId), `PurchaseOrderService.update` ✅ (Bug #473), `SupplierPaymentService.update` ✅ (Bug #588 — supplierId + purchaseOrderId), `CounterpartyContractService` (parentId + currencyCode), `AppointmentService` (counterpartyId + vehicleId).
**Регресія-guard:** spec має ОКРЕМІ кейси для (b), (c), (d). Тест для (c) ОБОВ'ЯЗКОВО mocks `prisma.X.findFirst` повертає `po.childFkId !== null` І dto WITHOUT childFkId → asserts `update.data.childFkId === null`. Без цього specific кейсу будь-яке refactor видалення Branch (c) проходить CI зеленим. Парний regression-test для Bug #477: contract spec має кейс `PATCH /:id { childFkId: null } → 200` (захищає `@ValidateIf` від випадкового видалення).

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

**Сигнал:** Public endpoint (без auth, share-token чи magic-link based) повертає DTO зібраний через manual `parts.map(p => ({...whitelist}))`. Захист від витоку чутливих полів (`costPrice`, `batchCostPrice`, `paidAmount`, `orgId`, FK-и, `syncVersion`) тримається на тому, що автор НЕ написав `{...p}` spread. Жоден TypeScript guard цього не ловить — Prisma row тип ширший за DTO, і refactor може мовчки витекти sensitive поле.

**Причина виникнення:** Шортчат `parts.map(p => ({ ...p, computed: x }))` виглядає чище ніж 6-рядковий explicit whitelist — особливо коли DTO має 5+ полів. Або хтось додає `include: { parts: { include: { warehouse: true } } }` замість зараз narrow `select` → у `wo.parts[i]` з'являється `warehouseId`, `batchCostPrice` тощо → автоматичний spread у map їх витікає.

Контракт-дрейф також непомітний: `class EstimatePublicDto { ... }` оголошує `parts!: EstimatePublicPartDto[]` — TS не валідує що runtime об'єкт МАЄ лише ці поля; зайвий ключ просто проходить через JSON.stringify.

**Підхід до виявлення:**

```bash
# 1) Знайти public endpoints без auth/auth-guard:
grep -rn "@Public\|@Get.*share\|@Get.*public" apps/api/src/modules --include="*.controller.ts"

# 2) Для кожного — знайти service-метод що повертає DTO:
# (наприклад findByShareToken, getPublicInvoice, getEstimateData)

# 3) Перевірити що в handler НЕМАЄ:
#    - `parts: wo.parts.map(p => ({ ...p, ... }))` — spread шортчат
#    - `include: true` чи widely-include що тягне sensitive поля

# 4) Перевірити що EXIST spec файл `<endpoint>.share-public.spec.ts` чи аналог:
ls apps/api/src/modules/*/work-orders.share-public.spec.ts 2>/dev/null
ls apps/api/src/modules/*/invoices.share-public.spec.ts 2>/dev/null
```

**Підхід до фіксу:** Створити `<resource>.share-public.spec.ts` з трьома типами assertions:

```ts
// 1) Sensitive поля ВІДСУТНІ (key, не undefined-value):
expect(Object.prototype.hasOwnProperty.call(part, 'costPrice')).toBe(false);
// hasOwnProperty не реагує на ключ зі значенням undefined; це сильніше за `.costPrice === undefined`.

// 2) Точний whitelist keys:
expect(Object.keys(part).sort()).toEqual(
  ['amount', 'goodName', 'id', 'price', 'quantity', 'unitShortName'].sort(),
);
// Якщо хтось додасть зайве поле → spec падає.

// 3) Top-level public DTO теж whitelist:
expect(Object.prototype.hasOwnProperty.call(dto, 'orgId')).toBe(false);
expect(Object.prototype.hasOwnProperty.call(dto, 'paidAmount')).toBe(false);
expect(Object.prototype.hasOwnProperty.call(dto, 'syncVersion')).toBe(false);
```

Цей подхід комплементарний до `class-transformer @Expose`/serialization (бо у проєкті він не використовується для public endpoints) і не вимагає рефакторингу handler.

**Severity:** HIGH для public endpoints (без auth — будь-який витік = реальна leak). MEDIUM для authenticated endpoints (RBAC-protected — leak обмежена ролями).

**Де шукати ще:** Кожен public endpoint у `apps/api/src/modules/*/`\*.controller.ts`:

- WorkOrder estimate share (`/work-orders/share/:token`) — покрито Bug #530
- Invoice public viewer (якщо буде)
- Counterparty public profile (якщо буде)
- Будь-який `@Public()` endpoint що повертає aggregate з вкладеними рядками

---

### 2026-06-17 — Defensive take/limit cap regression-guard (Bug #531) — backend / perf / regression-guard

**Сигнал:** Service method виконує `findMany` чи `findFirst` з вкладеними рядками (`take: N` cap) як defense-in-depth проти unbounded зростання даних. Cap не випливає з business requirement, а з captured-by-design risk (legacy import, missing ArrayMaxSize на endpoint, scripted operations). Без regression-guard рефакторинг може:

1. Видалити `take` → unbounded findMany → OOM/timeout для великих агрегатів
2. Знизити `take` → silent truncation реальних даних → дезінформація у totals/звітах
3. Замінити `select` narrow на `include: true` → знижка perf без warning

**Причина виникнення:** "Це defensive — ніколи в реальності не спрацює" → автор не пише spec. Через 6 місяців хтось видаляє "зайвий" `take` під час cleanup рефакторингу. Defense не спрацював — sentry alerts після першого WO з 5000 рядків.

**Підхід до виявлення:**

```bash
# 1) Знайти всі захисні take: N у services (не paginated):
grep -rnE "take: (100|500|1000)\b" apps/api/src/modules --include="*.service.ts" | grep -v "spec\|page"

# 2) Для кожного — перевірити чи є spec що assertss кон��ретне значення take:
# (не просто `findMany.toHaveBeenCalled()` — потрібно `expect(callArgs.take).toBe(1000)`)
grep -rn "callArgs.take\|take: 1000" apps/api/src/modules --include="*.spec.ts"

# 3) Якщо немає — створити <method>.cap.spec.ts з:
#    - assertion take = exact value
#    - assertion select narrow keys
#    - boundary test (exactly N rows processed)
```

**Підхід до фіксу:** Create dedicated `*-cap.spec.ts` файл (не міксувати з business-logic specs). 3-4 тести:

```ts
it('передає take: 1000 у findMany (defense-in-depth)', async () => {
  // ...
  expect(callArgs.take).toBe(1000); // КРИТИЧНО — exact, не >=
  expect(callArgs.where.deletedAt).toBeNull();
});

it('правильні select поля — без full row', async () => {
  expect(callArgs.select).toEqual({
    /* narrow */
  });
});

it('обробляє рівно N рядків без truncation (boundary)', async () => {
  // Симулюємо findMany що повертає рівно N рядків.
  // Перевіряємо аґреговані суми коректні.
});
```

**Severity:** MEDIUM (defense-in-depth — runtime ОК зараз, але деградує тихо). HIGH якщо cap захищає hot path (per-request, наприклад recalcTotals в transaction).

**Де шукати ще:** `apps/api/src/modules/work-orders/work-orders.service.ts` (recalcTotals — покрито), `inventory.service.ts` (reserveParts — `take: 1000` теж), `purchase-orders.service.ts` (receive — bulk read рядків), `invoices.service.ts` (createFromWorkOrder — копіювання рядків).

---

### 2026-06-19 — Constructor DI drift breaks ALL specs of service (Bug #534, #536) — backend / test-infra

**Сигнал:** Feature commit що додає **новий dependency у constructor** існуючого `@Injectable()` сервісу (`private readonly newDep: NewService`) без парного оновлення усіх `*.service.spec.ts` файлів того ж модуля. Симптом у baseline: 100% тестів модуля (включно з тестами що не торкаються new dep) падають з `Nest can't resolve dependencies of the XService (..., ?). Please make sure that the argument NewService at index [N] is available in the RootTestModule context`. Це CRITICAL release-blocker — спрямований baseline-таблиця інших sessions ховає реальну регресію за шумом, а наступні tester-cycles не можуть розрізнити "новий баг" vs "test-infra drift".

Окремий вид drift у positional-arg специфікаціях (`new WorkOrdersService(prisma, null as never, null as never, ...)`): додавання нового arg у constructor зсуває порядок, але `null as never` всі однакові → TS не ловить, runtime падає коли тест викликає метод що читає поле з зсунутим індексом (e.g., recalcTotals читає `this.settingsService.getDefaultVatRate(orgId)` коли settingsService насправді = ConfigService у новому порядку).

**Причина виникнення:** Розробники свідомо не запускають повний test-suite перед commit (вузький fast-path: лише змінені файли). NestJS DI errors trapped у beforeEach compile() → у IDE/CI це покажеться як "30 failed" з однаковим повідомленням → swept under the rug. Pre-existing test rot накопичується (у нашій сесії — 55 тестів падали з 5 червня, не позначено).

**Підхід до виявлення:**

```bash
# 1) Constructor diff check у scope-коммітах:
for f in $(git diff HEAD~5 HEAD --name-only -- 'apps/api/src/modules/**/*.service.ts' | grep -v spec); do
  # Чи у поточному файлі додано новий dep у constructor?
  added_deps=$(git diff HEAD~5 HEAD -- "$f" | grep "^+.*private readonly.*Service$" | wc -l)
  if [ "$added_deps" -gt 0 ]; then
    spec="${f%.ts}.spec.ts"
    if [ -f "$spec" ]; then
      # Чи у spec оновлено? Має містити нові type imports чи нові provide-блоки.
      grep -q "$(git diff HEAD~5 HEAD -- "$f" | grep "^+.*private readonly" | head -1 | grep -oE '[A-Z][a-zA-Z]+Service')" "$spec" && echo "OK $spec" || echo "DRIFT $spec MISSING mock"
    fi
  fi
done

# 2) Baseline-run всього test-suite ДО будь-яких змін — фіксуй кількість failed/passed.
#    Якщо new fails з'являються лише після scope commits → що feature їх ввела.
#    Якщо baseline вже червоний → pre-existing test rot, теж блокує (#536 family).
pnpm --filter @sto/api test --run 2>&1 | tail -5

# 3) Positional-arg specs з `null as never` — підрахувати кількість args і порівняти з
#    constructor signature. Якщо ВСІ services у спеці використовують `new XService(prisma, null as never, ...)`
#    → ці спеки крихкі при будь-якому додаванні dep у constructor.
grep -rn "new [A-Z][a-zA-Z]*Service(" apps/api/src --include="*.spec.ts" | head -10
```

**Підхід до фіксу:**

1. Для **NestJS Test.createTestingModule specs**: додати `{ provide: NewService, useValue: stubObj }` у providers. Stub-обʼєкт повинен мокати методи що сервіс реально викликає (не порожній `{}` — це дасть `null.method` runtime error). Стандартний шаблон для services з side-effects: `vi.fn().mockResolvedValue(safeDefault)`.
2. Для **positional-arg specs** (`new XService(...)`): найти позицію new dep у constructor signature, замінити відповідний `null as never` на mock obj. Додати named comment до кожного arg: `null as never, // inventory` — щоб майбутні refactor-и не ламали порядок silent-но.
3. **MANDATORY**: запустити ПОВНИЙ test-suite (не лише змінений файл) ПЕРЕД commit. Будь-яке збільшення failed-count = release-blocker.

**Регресія-guard для майбутнього:**

- ESLint custom rule або pre-commit hook: для кожного `*.service.ts` що змінив constructor → перевірити що `*.service.spec.ts` теж торкнуло providers list.
- Tester baseline-check Krok 0 ВЖЕ запускає `pnpm test --run` для @sto/api **І** @sto/web. Якщо одне з них червоне → release-blocker (SKILL 76-79).

**Severity:** CRITICAL для feature-introduced (новий dep + 30+ failed тестів модуля — фіча мертва у CI). MEDIUM для pre-existing test rot (старий dep, але session виявила що 55 тестів давно червоні — треба фіксити цикли назад).

**Де шукати ще:** Кожен новий dep у будь-якому `@Injectable()` (services, processors, controllers). Особливо ризиковано: cross-module dep (`SettingsService` у `PurchaseOrdersService`, `DocumentNumberService` у `GoodsService` як у цій сесії). Список positional-arg specs (sniff-test): `grep -rn "new.*Service(.*null as never" apps/api/src --include="*.spec.ts"`.

---

### 2026-06-19 — Migration ADD VALUE без парного INSERT backfill для DocumentNumberConfig (Bug #533) — database / migration

**Сигнал:** Commit що додає нове значення у Prisma enum `DocumentType` (e.g. `'GOOD_INTERNAL_CODE'`, `'COMPLETION_ACT'`, `'STOCK_TRANSFER'`) + service-метод що викликає `documentNumberService.next(orgId, '<NEW_VALUE>')`. У `seed.ts` додано новий запис у `docConfigs[]`, АЛЕ міграція `migration.sql` містить ЛИШЕ `ALTER TYPE "DocumentType" ADD VALUE 'NEW_VALUE'` (та опціонально `ALTER TABLE ADD COLUMN`) — БЕЗ парного `INSERT INTO document_number_configs` для існуючих org-ів.

Результат: у production (де існуючі org-и не запускають `seed.ts` повторно), `DocumentNumberService.next(orgId, 'NEW_VALUE')` кидає `NotFoundException('Конфігурацію нумерації для "<NEW_VALUE>" не знайдено')` → весь mutation-flow (POST /goods, POST /work-orders) blocked. Фіча мертва у проді — НЕ ловиться tsc/unit tests/contract specs (бо моки prisma) — лише integration або runtime у проді.

**Причина виникнення:** Розробник правильно оновив schema.prisma + seed.ts, припустив що "seed.ts покриває все". Не врахував що migration runtime має дві відповідальності: (1) DDL зміни схеми, (2) data backfill для існуючих рядків. `seed.ts` запускається ТІЛЬКИ при initial-setup (`pnpm seed` під час installer setup), не при `prisma migrate deploy` у проді.

**Підхід до виявлення:**

```bash
# 1) Знайти commit що додає нове enum value у DocumentType:
git log --all --oneline -S "GOOD_INTERNAL_CODE" -- packages/database/prisma/schema.prisma | head -3

# 2) Перевірити що міграція додає лише ALTER TYPE без INSERT:
grep -l "ADD VALUE.*'GOOD_INTERNAL_CODE'" packages/database/prisma/migrations/*/migration.sql
# Для кожного знайденого файлу:
grep -l "INSERT INTO document_number_configs" packages/database/prisma/migrations/*/migration.sql
# Якщо у тому ж sprint нема INSERT-міграції з тимстампом ПІСЛЯ ALTER TYPE → bug.

# 3) Перевірити що service.create() викликає DocumentNumberService.next з новим enum:
grep -rn "docNumbers.next.*'GOOD_INTERNAL_CODE'" apps/api/src/modules --include="*.ts"

# Pattern: парна міграція з суфіксом _seed_X_doc_numbers, timestamp >= ALTER TYPE міграції:
ls packages/database/prisma/migrations/ | grep -i "_seed.*doc_numbers"
# Прецедент: 20260615120100_seed_supplier_return_doc_numbers, 20260619140001_seed_good_internal_code_doc_numbers.
```

**Підхід до фіксу:** Створити окрему migration з timestamp на 1 секунду пізніше ALTER TYPE міграції:

```sql
-- Postgres забороняє INSERT з новим enum-значенням у тій самій транзакції що ALTER TYPE.
-- Окрема міграція з пізнішим timestamp обов'язкова.

INSERT INTO document_number_configs (
    "id", "orgId", "documentType", "prefix", "includeDate", "dateFormat",
    "separator", "padding", "currentSeq", "resetPeriod", "updatedAt"
)
SELECT gen_random_uuid(), o.id, '<NEW_VALUE>'::"DocumentType",
       '<prefix>', <includeDate>, 'YYYYMMDD', '-', <padding>, 0,
       '<resetPeriod>'::"ResetPeriod", NOW()
FROM organisations o
WHERE NOT EXISTS (
    SELECT 1 FROM document_number_configs c
    WHERE c."orgId" = o.id AND c."documentType" = '<NEW_VALUE>'::"DocumentType"
);
```

Конфігурація має 1:1 відповідати `seed.ts:docConfigs[]` запису (prefix, padding, includeDate, resetPeriod) — інакше existing-org поведінка розійдеться з new-org.

**Регресія-guard для майбутнього:**

- Pre-commit hook що блокує commit якщо у `packages/database/prisma/migrations/*/migration.sql` додано `ADD VALUE.*'GOOD'` або інший новий enum-value у `DocumentType` БЕЗ парного `INSERT INTO document_number_configs` у тій же або наступній міграції.
- Static check у tester Krok 0: для кожного `git diff schema.prisma` що додає DocumentType enum value → автоматично виявити missing backfill migration.
- Інтеграційний тест у `*.integration.spec.ts` що використовує реальну тестову БД після `prisma migrate deploy` — runtime DocumentNumberService.next з новим enum → відловлює gap.

**Severity:** CRITICAL (release-blocker — фіча мертва у проді для всіх існуючих orgs).

**Де шукати ще:** Всі майбутні commits з `enum DocumentType { ... NEW_VALUE }` у `schema.prisma`. Подібний паттерн для інших seed-керованих enum'ів з config-таблицями: `PaymentMethodConfig.code`, `NotificationTemplate.eventType`, `TaxRate.rate`, `CurrencyCode.code`. Кожен потенційно потребує парного backfill INSERT для нових values.

### 2026-06-20 — Validation message Cyrillic encoding in Zod/class-validator (Bug #537) — frontend / validation / i18n

**Сигнал:** @Matches validator у DTO з `message` string що містить кирилицю, введеної у коді як UTF-8 але потім обробленої інструментом що змінює encoding (UTF-8 BOM removal, Windows PowerShell редактор, git diff --binary). Результат: рядок типу `'Р¤РѕСЂРјР°С‚ "Р"Р":РҐРҐ"'` замість `'Формат "ГГ:ХХ"'` → 400 response має garbled текст → користувач не розуміє що пішло не так.

**Причина виникнення:** Windows text editor (зокрема PowerShell ISE / VSCode з неправильними налаштуваннями) іноді додаватиме BOM або змінюватиме encoding на UTF-16. Коли файл перезаписується через sed/PowerShell `Set-Content` без явного `-Encoding utf8`, результат може мати мішану encoding або BOM. Наступний commit з BOM removal може залишити текст поламаним.

**Підхід до виявлення:**

```bash
# Step 1: знайти усі @Matches / @MinLength / @MaxLength validators з message
grep -rn "@Matches.*message:\|@MinLength.*message:\|@MaxLength.*message:" apps/api/src/modules --include="*.dto.ts"

# Step 2: перевірити чи message містить non-ASCII (запустити на кожному .dto.ts що мав BOM removal)
for f in $(git diff HEAD~2 HEAD --name-only -- "*.dto.ts"); do
  if grep -q "@Matches.*message:" "$f"; then
    # Перевіри кожен message: наявність ^Р^ або іншого non-standard char
    grep -n "message:" "$f" | head -10
  fi
done

# Step 3: простий regex-test у contract.spec.ts — передай невалідне значення, перевір що error message не містить Р/вЂ/и/ѐ/ѓ/нетиповий Unicode
# Приклад: expect(res.json().message).toMatch(/^[А-Яа-яІіЇїЄє0-9\s"():.–—-]*$/)
```

**Підхід до фіксу:**

1. Відкрити файл у VSCode (або іншому редакторі) з явним UTF-8 БЕЗ BOM
2. Виділити message string
3. Переписати кирилицю вручну (копіювати з правильного джерела, наприклад з UI)
4. Завантажити файл як UTF-8 БЕЗ BOM (для VSCode: `"files.encoding": "utf8"` без BOM)
5. Перевірити у contract.spec.ts що message відновлена
6. Commit: `fix(tester): Bug #5NN — validation message encoding`

**Severity:** LOW (UX confusion; error message не помилки виконання, а помилки валідації на input). MEDIUM якщо validation message ключовий для workflow (наприклад, дата-picker з HH:MM format requirement).

**Де шукати ще:** усі `@Matches` / `@IsString` / `@MinLength` validators у всіх DTO-файлах що:

- Недавно прошли через sed/BOM-removal commit (перевіри `git log --oneline -20 -- "*.dto.ts"`)
- Мають украї текст у message (кирилиця, дефіс, лапки)

---

### 2026-06-20 — E2E test seed race condition за 30s timeout (Bug #538) — E2E / test-infrastructure / flaky

**Сигнал:** Playwright spec повторює тест 3 рази (retries=3), але всіх 3 спроби містять `expect(...).toBeVisible({ timeout: 30_000 })` що не дочекається — `element(s) not found`. Один і той же тест в окремому запуску може пройти (flaky). Seed-функція у `beforeAll()` використовує API для creation.

**Причина виникнення:** Seed-логіка (наприклад, `seedEstimateWorkOrder()`) залежить від наявності DRAFT donor у БД. Якщо DB пустий або seed з попередньої сесії не спрацював → clone = null → тест пропускається молча (return null у beforeAll, але тест не має `expect(seededId).toBeTruthy()` гард). Або: clone endpoint успішно створює DRAFT, але transition DRAFT→ESTIMATE дає 500/400 → clone залишається у DRAFT → фронтенд фільтрує status=ESTIMATE → рядок не виявляється.

**Підхід до виявлення:**

```bash
# 1. Перевірити усі .spec.ts файли що мають beforeAll з seed API calls
grep -rn "beforeAll.*async\|seedEstimateWorkOrder\|seedXWorkOrder" apps/web/e2e --include="*.spec.ts"

# 2. Для кожного seed-spec: перевірити що test має гард
grep -A 5 "beforeAll" "$spec" | grep -E "expect.*toBeTruthy|expect.*not.toBeNull" || echo "MISSING GUARD"

# 3. Перевірити API seed-функцію на error handling — чи вона логує failure
# (у тесті seed видно якщо є "console.log" або "logger" вивід)
```

**Підхід до фіксу:**

1. У `beforeAll()` додати explicit гард: `expect(seededEstimateWoId, 'beforeAll must seed ESTIMATE WO').toBeTruthy()` вверху першого тесту
2. У seed-функції: якщо transition дає error → логувати весь error detail (не просто `return null`)
3. Опціонально: retry-loop у seed функції (`max 3 attempts` з exponential backoff) для транзиторних 500 errors
4. Перевірити що test DB має seed-donor (DRAFT WO) на старті → інакше skip spec із дружнім `test.skip(...)`

**Severity:** LOW за FLAKINESS (може пройти в наступної спроби, не блокує CI). MEDIUM якщо seed гарантує детерміністичність (test.only у локальній розробці).

**Де шукати ще:** будь-яка .spec.ts що має `beforeAll()` з API seeding (не просто DB direct insert, а POST endpoint). Особливо: estimate-share, public pages, auth flows, complex-state setups (multi-org, cross-org relations).

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

**Сигнал:** E2E test failure screenshot показує login форму замість очікуваної сторінки. `getByRole(...)` timeout одразу після `page.goto('/work-orders')`. У минулих сесіях документувалось як "seed race" чи "flaky" — насправді коренева причина — Playwright не restore-ить sessionStorage між контекстами.

**Причина виникнення:** Playwright `storageState({ path })` зберігає `sessionStorage` у admin.json для inspection, АЛЕ `test.use({ storageState: ... })` restore-ить тільки cookies + localStorage. sessionStorage **завжди порожній** у новому контексті. Це **відома обмеження** Playwright (1.40+), не баг — sessionStorage by definition tab-scoped, не persistable.

Якщо AuthProvider читає access token з sessionStorage (як у STO ERP, для запобігання cross-tab token sharing) → у E2E завжди `stored = null` → reducer init returns `{isLoading: true}` → useEffect goes into `else` branch → `refreshToken()` → 401 (no refresh cookie either) → silent LOGOUT → redirect /login.

**Підтверджено runtime check:**

```ts
test('debug', async ({ page }) => {
  await page.goto('/counterparties');
  const state = await page.evaluate(() => ({
    hasToken: !!sessionStorage.getItem('sto_access_token'), // false!
    hasCached: !!localStorage.getItem('sto_employee_cache'), // true ✓
    flag: localStorage.getItem('sto_e2e_skip_refresh'), // '1' ✓
  }));
});
// → hasToken: false despite admin.json having sessionStorage block
```

**Підхід до виявлення:**

```bash
# 1) E2E test fails з timeout на UI селектор, але screenshot test-failed-*.png показує login UI:
ls apps/web/test-results/*/test-failed-1.png | head -5
# Перевірити кожен screenshot — якщо там "Вхід до системи" замість очікуваного content → auth issue

# 2) Перевірити admin.json чи захоплено sto_refresh cookie:
cat apps/web/e2e/.auth/admin.json | jq '.cookies | length'
# 0 → cookie ніколи не захоплена → refresh fails завжди

# 3) Перевірити чи stored token має достатньо TTL:
node -e "const t=JSON.parse(Buffer.from('<token>'.split('.')[1], 'base64')); console.log({iat: new Date(t.iat*1000), exp: new Date(t.exp*1000), now: new Date()})"
# Якщо now > exp → token вже expired → навіть успішний refresh не врятує
```

**Підхід до фіксу (3-prong):**

1. **`setup-auth.ts`**: дзеркалити access token у `localStorage.sto_e2e_access_token` (localStorage Playwright restore-ить, sessionStorage — ні). Плюс зберегти `sto_e2e_skip_refresh = '1'` + `sto_employee_cache = JSON.stringify(employee)`.

2. **AuthProvider reducer init**: якщо `typeof window === 'object'` (client) + `sessionStorage.sto_access_token` порожній + `localStorage.sto_e2e_skip_refresh === '1'` + є `localStorage.sto_e2e_access_token` → скопіювати у sessionStorage ПЕРЕД першим читанням `stored`.

3. **AuthProvider useEffect**: коли flag + cached → пропустити refresh-on-mount (інакше refresh fails → 401 → LOGOUT → redirect).

У production жоден E2E ключ не встановлюється — zero impact.

**Регресія-guard:** при будь-якій зміні `apps/web/src/lib/auth/context.tsx` — перевірити що E2E flag шлях не зник. Додати spec: `describe('E2E escape hatch', () => it('skips refresh when sto_e2e_skip_refresh=1 + cached employee'))`.

**Severity:** CRITICAL — блокує всі захищені E2E тести довжиною >15 хв cumulative.

**Де шукати ще:** будь-який frontend-app з httpOnly refresh cookie + cross-port API + Playwright E2E — той самий патерн. Альтернативно — використати `webServer` block у `playwright.config.ts` що проксує API через web port (`/api/*` → API), що робить same-origin → cookies survive.

---

### 2026-06-20 — Node IPv6 default на Windows ламає server-side fetch (Bug #566) — e2e / infrastructure / dns-resolution

**Сигнал:** Інтермітентний `Error: apiRequestContext.get: connect ECONNREFUSED ::1:3000` у Playwright `request.newContext()` або Node `fetch()`. Браузерні запити з Chromium працюють (Chromium handles dual-stack автономно).

**Причина виникнення:** Node 18+ на Windows за замовчуванням повертає IPv6 (`::1`) перед IPv4 (`127.0.0.1`) при resolution `localhost`. NestJS+Fastify `app.listen(port, '0.0.0.0')` слухає тільки IPv4 → ECONNREFUSED. Туторіали показують `'0.0.0.0'` як "все мережеві інтерфейси" — це невірно для dual-stack.

**Підхід до виявлення:**

```bash
# Grep всі server-side localhost references у E2E:
grep -rn "fetch.*localhost:3000\|request.newContext\|http://localhost:3000" apps/web/e2e/ | grep -v "page.evaluate"
# Кожен match — кандидат на ECONNREFUSED під час прогону на Windows
```

**Підхід до фіксу:**

1. **Швидкий (per-file):** замінити `http://localhost:3000` → `http://127.0.0.1:3000` у server-side fetch contexts (estimate-share.spec.ts, setup-auth.ts). Браузерні `page.evaluate(() => fetch('http://localhost:3000'))` ОК — Chromium handles.

2. **Кращий (architectural):** змінити API на dual-stack `app.listen(port, '::')`. Ризик: всі production deployments полагаються на `0.0.0.0` semantics — змінити лише за згодою owner.

3. **Alternative (env-based):** Додати у `playwright.config.ts` webServer.env `NEXT_PUBLIC_API_URL=http://127.0.0.1:3000`. Centralized override — всі тести підбирають.

**Регресія-guard:** запустити test 3 рази підряд — якщо хоч раз ECONNREFUSED → проблема не вирішена.

**Severity:** HIGH (intermittent — особливо ризикне у flaky test investigations що йдуть кругом).

**Де шукати ще:** будь-який Node-side fetch до `localhost` де target сервер біндить IPv4-only. WatermelonDB sync clients, BullMQ workers, cross-service HTTP calls у monorepo dev.

---

### 2026-06-20 — Sidebar-preview pattern: row click НЕ навігує (Bug #574) — e2e / ux-pattern / list-pages

**Сигнал:** E2E тест ламається на `expect(page).toHaveURL(/\/<entity>\/[a-z0-9-]+/)` після `firstRow.click()`. Скріншот показує що сторінка залишилась на /<entity>, а сайдбар (DetailPanel) або відкритий з даними або закритий — без переходу URL.

**Причина виникнення:** Listing pages у STO ERP мігрували на pattern: row click → set `selectedWO/selectedInvoice/...` → DetailPanel side-preview праворуч; навігація на детальну сторінку відбувається або через **окрему кнопку "Відкрити" всередині сайдбара** (яка теж відкриває MODAL, не URL), або через action-button у останній колонці (icon-only з `title="..."` — теж модалка). Тест писався у часи коли row click робив `router.push(/<entity>/${id})`. UI еволюціонував — тест не оновили.

**Підхід до виявлення:**

```bash
# Знайти всі тести що очікують URL після row click:
grep -rn "firstRow\|tbody tr.*click\(\)" apps/web/e2e --include="*.spec.ts" -A 3 | grep -B 1 "toHaveURL.*\[a-z0-9-\]"

# Перехресна перевірка з UI: чи дійсно є router.push у list-page?
for page in apps/web/src/app/\(app\)/work-orders apps/web/src/app/\(app\)/invoices ...; do
  grep -nE "onClick.*setSelected|router\.push" $page/page.tsx
done
# Якщо тільки setSelected — UI не навігує
```

**Підхід до фіксу:** для тестів детальної сторінки — НЕ через row click, а через **API + page.goto**:

```typescript
// ❌ КРИХКО: row click → expect URL
await firstRow.click();
await expect(page).toHaveURL(/\/work-orders\/[a-z0-9-]+/);

// ✅ СТАБІЛЬНО: API → direct goto
await page.goto('/work-orders');
await expect(page.locator('h1:has-text("Наряди")')).toBeVisible();
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

**Severity:** MEDIUM — тести зеленіли коли row click DID навігувати; після migration UI на side-preview pattern стали failed. Не критично але потребує синхронної правки в усіх spec-ах list-pages.

**Де шукати ще:** invoices, purchase-orders, stock-documents, counterparties, employees — усі list-pages з `useListPage` хук-ом потенційно мають той самий pattern. Перевіряти всі `firstRow.click()` + `toHaveURL`.

---

### 2026-06-20 — Skeleton/loading row матчиться як data row (Bug #575) — e2e / async-state / table-loading

**Сигнал:** Тест читає `await expect(page.locator('table tbody tr').first()).toBeVisible()` і думає що таблиця завантажилась, потім `count = await page.locator('table tbody tr input[type="checkbox"]').count()` повертає 0 — хоча API запит свіжо створив 2 рядки. Скріншот показує текст "Завантаження" у таблиці.

**Причина виникнення:** NestJS+TanStack Query list-pages рендерять у `<tbody>` skeleton row коли `isLoading=true`:

```tsx
<TableBody>
  {loading && <TableRow><TableCell>Завантаження...</TableCell></TableRow>}
  {!loading && invoices.map(...)}
</TableBody>
```

Локатор `table tbody tr` матчить будь-який `<tr>` всередині `<tbody>` — і skeleton, і data row. `first()` дає skeleton; перевірки на checkbox/text/inline-edit count 0 — тест падає з confusing error.

**Підхід до виявлення:**

```bash
# Знайти всі тести що читають table tbody tr без фільтра на колонку даних:
grep -rn "table tbody tr.*first\(\)" apps/web/e2e --include="*.spec.ts"
# Кожен — кандидат на skeleton race
```

**Підхід до фіксу:** Чекати на елемент який є **тільки у data row**, не у skeleton:

```typescript
// ❌ КРИХКО: матчить skeleton row
await expect(page.locator('table tbody tr').first()).toBeVisible();
const count = await page.locator('table tbody tr input[type="checkbox"]').count(); // 0

// ✅ СТАБІЛЬНО: poll кількість checkbox-ів (skeleton не має checkbox)
await expect
  .poll(async () => await page.locator('table tbody tr input[type="checkbox"]').count(), {
    timeout: 20_000,
    message: 'Має бути >=2 чекбокси після створення 2 рахунків',
  })
  .toBeGreaterThanOrEqual(2);

// АБО — використати специфічний content селектор:
await expect(page.locator(`table tbody tr:has-text("${invoiceNumber}")`)).toBeVisible();
```

**Severity:** MEDIUM — flaky/false-fail; не критично, але важко дебажити (locator знаходить tr, але all assertions після — fail).

**Де шукати ще:** будь-яка list-page де `loading` rendering включає `<TableRow>` (invoices, work-orders, purchase-orders, stock-documents). Виправляти всі `await expect(page.locator('table tbody tr').first()).toBeVisible()` що передують `count()` або `nth(N)` запиту.

---

### 2026-06-20 — Hardcoded seed values vs E2E-generated fixtures (Bug #576) — e2e / fixture-drift / first-row-pollution

**Сигнал:** Тест очікує hardcoded seed values (`AA1234BB`, `Toyota`, `Camry`) на сторінці першого ресурсу з API. На сторінці натомість `E2E-Make E2E-Model-560110` — артефакт з раніших E2E прогонів. Test fail з `getByText(/AA1234BB|Toyota/).first() not found`.

**Причина виникнення:** E2E suite створює тестові ресурси через API (CRUD specs), не завжди cleanup-ить afterAll. Накопичення E2E-fixtures у DB → `GET /vehicles?limit=1` повертає E2E-артефакт замість seed.

**Підхід до виявлення:**

```bash
# Знайти hardcoded seed references у тестах:
grep -rn "AA1234BB\|Toyota Camry\|Honda Civic\|Іван Петренко" apps/web/e2e --include="*.spec.ts"
# Кожен match — крихкий до E2E-fixture pollution
```

**Підхід до фіксу:** замість hardcoded — fetch актуальні поля через API і regex з них:

```typescript
// ❌ КРИХКО: hardcoded seed values
await expect(page.getByText(/AA1234BB|2020|Toyota/i).first()).toBeVisible();

// ✅ СТАБІЛЬНО: динамічний regex з API
const vehicle = await page.evaluate(
  async ({ tok, id }) => {
    const r = await fetch(`http://localhost:3000/api/vehicles/${id}`, {
      headers: { Authorization: `Bearer ${tok}` },
    });
    return r.json();
  },
  { tok: token, id: vehicleId },
);

// make+model завжди є — присутні у h1
await expect(page.getByText(new RegExp(escapeRegex(vehicle.make), 'i')).first()).toBeVisible();

// Опціональні поля — якщо truthy:
const optional = [vehicle.licensePlate, vehicle.year, vehicle.vin].filter(Boolean);
if (optional.length > 0) {
  await expect(
    page.getByText(new RegExp(optional.map(escapeRegex).join('|'), 'i')).first(),
  ).toBeVisible();
}
```

**Severity:** MEDIUM — fail тільки якщо порядок rows у API список залежить від E2E artifacts; після seed reset (cleanup DB) знов працює. False positives у CI.

**Де шукати ще:** будь-який тест що очікує специфічних seed values (vehicles, counterparties, work-orders, goods) на першому елементі API list response. Перевіряти ВСІ hardcoded brand/model/name/phone strings.

---

### 2026-07-03 — Sprint-wide DTO drift detection: `@IsArray` без `@ArrayMaxSize` через 5-line context grep (Bug #587) — api / dto / anti-dos / drift

**Сигнал:** Проєкт має 30+ файлів з `@IsArray()` + `@ArrayMaxSize(N)` pattern (canonical DoS-guard) АЛЕ 5 файлів пропустили cap. Naïve grep `@IsArray` дає 20+ matches, ручна перевірка кожного = time-sink. TS зелений (arrays валідні), unit tests зелені (тести не шлють мільйон-elementних payload), review не ловить (checklist-item існує, але grep-based scan не використаний). Виявляється тільки systematic-audit-ом всіх DTO-полів.

**Причина виникнення:** Розробник копіює structure з існуючого DTO але забуває `@ArrayMaxSize` бо копіює тільки validate/type-guards. Простий один-файловий review пропускає (кожен окремо looks fine); тільки cross-file grep + context-check ловить drift від project-wide pattern. Ключова insight — canonical patterns (SKILL checklist item існує) не дотримуються 100%-но, тому audit має бути **grep+context**, не **manual-review**.

**Підхід до виявлення (загальний principle for canonical-pattern audits):**

Використовувати bash pipeline що:

1. Знаходить всі occurrences primary marker (`@IsArray()`)
2. Для кожного — читає N-line context навколо
3. Перевіряє чи парний marker (`@ArrayMaxSize`) є в contexті
4. Виводить false-negatives (occurrences що пропустили pattern)

```bash
# Template для audit будь-якого canonical pattern:
for line in $(grep -rn "<PRIMARY_MARKER>" <SCOPE> --include="*.<EXT>" | cut -d: -f1-2); do
  file=$(echo "$line" | cut -d: -f1)
  ln=$(echo "$line" | cut -d: -f2)
  start=$((ln - 5))  # 5-line context БЕЗ (декоратори зазвичай згруповані вгорі поля)
  end=$((ln + 5))    # 5-line context ПІСЛЯ
  ctx=$(sed -n "${start},${end}p" "$file")
  if ! echo "$ctx" | grep -qE "<PAIRED_MARKER_REGEX>"; then
    echo "MISSING: $file:$ln"
  fi
done
```

Приклади для STO ERP:

- `@IsArray()` + no `@ArrayMaxSize|@ArrayMinSize` → anti-DoS gap
- `@IsString()` + no `@MaxLength|@IsIn|@IsEmail|@IsUrl|@Matches|@IsUUID` → anti-DoS gap
- `@IsUUID()` + no `Transform` (у CreateDto) → nil-UUID injection (якщо потрібна strict v4)
- `?: number` у Create/UpdateDto + no `@IsInt|@IsNumber|@Min|@Max|@IsPositive|@Type` → number coercion attack (Bug #283)
- `$transaction(async` без парного `timeout:` — потенційний 5s default → PG killed (SKILL §1.1)

Виключати false-positives ФІЛЬТРУЮЧИ клас через parent-класу name grep:

```bash
# Знайти найближчий `export class .*Dto` вище цього line і пропустити Response/Paginated:
class_line=$(awk -v LN="$ln" 'NR<=LN && /^export class.*Dto/ {classline=$0} END {print classline}' "$file")
echo "$class_line" | grep -qE "Response|Paginated|Public|List" && continue
```

**Підхід до фіксу:** батчевий — для кожного знайденого поля:

1. Визначити realistic-бізнес максимум (small tables → 20, medium → 100, list-cap → 200)
2. Додати `@ArrayMaxSize(N, { message: '...' })` між `@IsArray()` та inner-element validator
3. Якщо inner element `@IsString()` → додати `@MaxLength(N, { each: true })` (per-element cap)
4. Import `ArrayMaxSize` з `class-validator`
5. Verify tsc + unit tests зелені

**Severity:** MEDIUM (auth-protected endpoints — потрібен insider), але systematic-consistency: SKILL checklist існує, значить treat as release-blocker.

**Де шукати ще:**

- КОЖЕН новий `@IsArray()` у review → чи парний `@ArrayMaxSize`?
- Query DTOs (`*QueryDto`) — часто пропускають cap для array filter параметрів (URL string може містити багато IDs)
- Update DTOs що успадковують через `extends PartialType(CreateDto)` — cap успадковується автоматично, але новий field у Create потребує cap одразу
- Аналогічний sprint-audit для інших canonical patterns: `@IsString + @MaxLength`, `?: number + @IsNumber/@Type`, `$transaction + timeout`, `@Controller + @UseGuards`.

---

### 2026-08-30 — Spec-vs-impl timezone-arithmetic parity (Bug #592) — api / test / dst-aware

**Сигнал:** Baseline API vitest падає з `expected 'YYYY-MM-DD_A' to be 'YYYY-MM-DD_B'` де різниця 1 день. Тест-спека обчислює `expected` через `new Date() + setUTCDate()` (UTC-арифметика), а impl-код використовує `kyivToday()/addDaysKyiv()` (Kyiv-арифметика). Падає у ~3-годинному вікні між UTC-північчю і Kyiv-північчю (23:00 UTC — 02:00 UTC літньою EEST). Днем — passes, вночі — flaky. Виглядає як «flaky тест», але насправді deterministic bug у spec (impl правильний).

**Причина виникнення:** Розробник знає що impl використовує Kyiv-timezone (є коментарі, `feedback_dst_kyiv.md` у MEMORY), але у spec інтуїтивно робить `new Date()` (UTC) без парного `kyivToday()`. Обидва працюють однаково днем (наприклад 12:00 UTC = 15:00 EEST — той самий календарний день), але на кордоні днів розходяться на 1 день.

**Підхід до виявлення:** будь-який spec що асертить дату отриману через impl-функції `kyivToday()/addDaysKyiv/kyivOffsetMs` — має ВИКОРИСТОВУВАТИ ТІ САМІ утиліти для обчислення `expected`, не `new Date()`. Grep:

```bash
# Знайти spec-и що робить дату-арифметику AJC UTC:
grep -rn "setUTCDate\|toISOString().slice(0, 10)" apps/api/src --include="*.spec.ts"

# Для кожного файлу — знайти паралельний impl і перевірити:
# imports kyivToday/addDaysKyiv/kyivOffsetMs ==> spec теж має їх використовувати
```

Регресія-guard-check: після кожного нового `kyivToday()`/`addDaysKyiv()` виклику у impl → prevent-check у корреспондентному spec-файлі. Baseline-red в conditional window (3h/day) видає bug шляхом того що CI/tester-сесії у певний час доби показують червоне.

**Підхід до фіксу:** заміна `new Date() + setUTCDate(+N)` на `addDaysKyiv(kyivToday(), N)` у spec. Додати inline-коментар що пояснює чому UTC-арифметика неправильна для перевірки Kyiv-boundary дати. Import з `../../common/utils/kyiv-date` (той самий модуль що impl).

**Severity:** HIGH — release-blocker у 3h/day вікні (ховає майбутні регресії у тому ж модулі; tester-сесії неможливі). Not CRITICAL бо (а) impl правильний; (б) 1-line fix; (в) flaky, не всеhoduring.

**Де шукати ще:**

- усі `*.spec.ts` що торкаються `paymentDate`, `dueDate`, `expiryDate`, `documentDate`, `warrantyExpiresAt`, будь-який `@db.Date` field
- специфічно auto-fill дати: `receive()` PO, `create()` Invoice (dueDate = today + N), `addDaysISO()` FE
- reports/calendar/schedule endpoints з date-window semantics — тести повинні використовувати той самий Kyiv-timezone helper

---

### 2026-08-30 — QueryClientProvider absent після React Query hook migration (Bug #593) — web / test / rq-migration

**Сигнал:** Baseline web vitest падає з `Error: No QueryClient set, use QueryClientProvider to set one`. Stack trace вказує на новий hook (`useUpdateSupplierPayment`, `useConfirmX`, будь-який `use*Mutation`) у компоненті, який раніше використовував raw `apiFetch`. Тест-файл існує і був зелений до commit-міграції на RQ (типовий commit-message: `feat(rq): migrate X` / `refactor(<area>): use useX hook`).

Особливо підступний варіант: **transitive rendering** — batch-тест для parent modal (`PurchaseOrderCreateModal`) падає бо parent транзитивно рендерить newly-migrated child (`SupplierPaymentCreateModal` з RQ hooks) через кнопку/попап. Grep parent тесту на `QueryClientProvider` — 0 matches; grep parent компонента на child modal → міграція child + parent тест не оновлені.

**Причина виникнення:** Refactor commit що мігрує компонент з raw fetch на React Query hooks (типово: `useUpdateX`, `useCreateX`, `useConfirmX`) додає нову залежність від `QueryClientProvider` context. Тести написані ДО міграції рендерять компонент напряму: `render(<Component .../>)` — без обгортки. Тест-мок для `apiFetch` продовжує працювати (raw path), але `useQueryClient()` throws бо context пустий.

**Підхід до виявлення (для нової міграції на RQ hook):**

```bash
# 1. Знайти нові RQ hooks у shared/api hooks:
git log --oneline -10 --name-only apps/web/src/hooks/api/ | head -30

# 2. Для кожного нового hook — знайти всіх consumers у components:
for hook in $(grep -rlE "^export function use(Create|Update|Delete|Confirm|Cancel)" apps/web/src/hooks/api --include="*.ts" | head); do
  # знайти всі імпорти цього hook
  grep -rln "$hook" apps/web/src/components --include="*.tsx" | grep -v test
done

# 3. Для кожного component-у — знайти парний test і перевірити wrapper:
for comp in $(git diff HEAD~5 HEAD --name-only apps/web/src/components/ui/*.tsx); do
  test="apps/web/src/components/ui/__tests__/$(basename $comp .tsx).test.tsx"
  [ -f "$test" ] || continue
  grep -q "QueryClientProvider\|renderWithQueryClient" "$test" || echo "MISSING QCP: $test"
done

# 4. Transitive check — для кожного PARENT modal у якому transitively рендериться
# newly-migrated child modal (grep parent for child-modal-name), теж потребує QCP:
grep -rn "<SupplierPaymentCreateModal\|<XCreateModal" apps/web/src/components/ui --include="*.tsx" -l | while read f; do
  test="apps/web/src/components/ui/__tests__/$(basename $f .tsx).test.tsx"
  [ -f "$test" ] && grep -q "QueryClientProvider" "$test" || echo "MISSING QCP (transitive): $test"
done
```

Alternative signal: baseline `vitest run` показує 4+ failures з ідентичною error message. Grep stack traces → всі вказують на `useQueryClient` у одному hook → знайти commit що додав hook у component → перевірити всі парні тести.

**Підхід до фіксу:** створити helper у test-файлі:

```typescript
function renderWithQueryClient(ui: ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}
```

`retry: false` — швидкий fail замість retry-цикл у тесті. Замінити всі `render(<Component ...>)` на `renderWithQueryClient(<Component ...>)`. Додати inline-коментар що пояснює причину (commit-hash міграції).

**Довгостроково-безпечніший pattern:** shared `test-utils.tsx` з `renderWithProviders(ui)` що обгортає QueryClient + Router + AuthProvider — використовувати у всіх нових тестах. Тоді нові тести автоматично захищені від майбутніх міграцій на context-based hooks.

**Severity:** HIGH — release-blocker baseline (тест-файл повністю мовчить, регресії ховаються). Особливо критично для regression-guard тестів (Bug #460 pattern).

**Де шукати ще:**

- кожен `*.test.tsx` для компонентів у `components/ui/*.tsx` що містять `useMutation`/`useQuery`/`useQueryClient`
- transitive: parent modals що рендерять newly-migrated child modals (grep parent-component-file на child-component-name)
- аналогічно для Router/AuthProvider міграцій — сам pattern однаковий (context absent → hook throws на mount)

---

### 2026-08-30 — Partial hook migration: один branch мігрований, інший — raw apiFetch (Bug #594) — web / cache / rq-migration-completeness

**Сигнал:** Компонент має 2+ branches у handleSave/handleSubmit що роблять POST/PATCH/DELETE:

- гілка A (наприклад `if (isEdit) updateMut.mutateAsync(payload)`) — через RQ hook, з auto-invalidate onSuccess
- гілка B (наприклад `else await apiFetch('/resource', {method:'POST', body:...})`) — raw fetch, БЕЗ invalidate

Результат: одна гілка правильно оновлює cache (список свіжий), інша — не оновлює (staleness до `staleTime=30s`). User бачить асиметричну поведінку: "оновлення працює одразу, а створення — з затримкою".

Симптом типовий: `usePaginatedList` (staleTime=30s) не показує new item після create; після 30s або manual refresh — з'являється. Легко сплутати з "backend повільний" або "not saving properly", коли фактично cache stale.

**Причина виникнення:** Refactor commit `feat(rq): migrate X` мігрує only-update path (updateMut вже існує) або only-create path (createMut існує), пропускає другий branch. Хук для іншого branch **існує** у файлі `use<X>.ts` (з `onSuccess: invalidate .all`), але не імпортується у компонент → forgotten pair. Класична партіальна міграція.

**Підхід до виявлення:**

```bash
# Для кожного use<X>Mutation hook у apps/web/src/hooks/api/*.ts:
grep -rn "^export function use\(Create\|Update\|Delete\|Confirm\|Cancel\)" apps/web/src/hooks/api --include="*.ts" -l | while read hookfile; do
  hookname=$(basename $hookfile .ts | sed 's/^use//')
  # Знайти endpoint URL що цей hook використовує (mutationFn):
  endpoint=$(grep -A 3 "^export function use\(Create\|Update\)" $hookfile | grep "apiFetch" | grep -oE "'/[^']*'" | head -1)
  [ -z "$endpoint" ] && continue

  # Grep всіх components що імпортують ЦЕЙ hook:
  grep -rln "use\(Create\|Update\|Delete\)$hookname" apps/web/src/components apps/web/src/app --include="*.tsx" | grep -v test | while read component; do
    # У кожному component-у — шукати парний RAW apiFetch на той самий endpoint:
    if grep -q "apiFetch($endpoint" "$component"; then
      echo "PARTIAL MIGRATION: $component uses BOTH hook AND raw apiFetch on $endpoint"
    fi
  done
done
```

Manual variant (faster у real audit): для кожного modal-компонента з `handleSave` — прочитати обидві gілки (`if (isEdit)` / `else`) — обидві мають бути mutation-hook, не змішано.

**Підхід до фіксу:** імпортувати парний hook (`useCreateSupplierPayment`), додати `const createMut = useCreateSupplierPayment();`, замінити raw `apiFetch(url, {method: 'POST', body: ...})` на `await createMut.mutateAsync(payload)`. Update `useCallback` deps: додати `createMut`. Payload shape зазвичай той самий об'єкт що вже підготовлений.

**Регресія-guard:** component-test `it('create-flow викликає mutation-hook')` — mock `apiFetch`, click "Створити", assert `apiFetch` called з правильним URL + `invalidateQueries` called (verify via mocked `useQueryClient`).

**Severity:** HIGH — silent UX gap (user думає "не зберіглось", насправді збереглось + stale cache). Не CRITICAL бо самовиправляється через 30s.

**Де шукати ще:**

- будь-який modal з `if (isEdit) updateMut.mutateAsync else await apiFetch(POST)` pattern — pair-check
- аналогічно `if (bulk) await apiFetch else deleteMut.mutateAsync` — асиметрія delete-hook vs bulk-raw
- specifically: modal-и що були нещодавно refactor-нуті ("feat(<area>): manual editing" / "feat(rq): migrate <component>") — check both branches

---

### 2026-08-30 — Regex-shape validation без semantic parseability (Bug #595) — api / dto / validator

**Сигнал:** DTO приймає рядок з `@Matches(/^\d{4}-\d{2}-\d{2}$/)` (YMD regex) як **єдину** валідацію дати. Endpoint приймає `?from=2026-99-99&to=2026-13-45` як 200 з empty/silent-wrong result (замість 400). Regex тільки перевіряє SHAPE (4-2-2 digits), не SEMANTIC validity (місяць 1-12, день 1-31, valid leap year).

Downstream: `new Date('2026-99-99T00:00:00Z')` → `Invalid Date` → NaN арифметика → або silent-empty result, або "NaN днів у діапазоні" тощо. Не крешить, але видає wrong data.

**Причина виникнення:** Розробник обирає `@Matches` бо (а) швидко, regex здається self-documenting; (б) не знає що `@IsDateString` accepts also full ISO-8601 (`"2026-08-30T12:00:00Z"`) і не хоче цього; (в) `@IsDateString` alias для `@IsISO8601` у class-validator може бути неочевидний. Комбо `@IsDateString + @Matches(YMD_RE)` = strict validation + YMD-only shape — але подвійна декорація не intuitive.

**Підхід до виявлення:**

```bash
# 1. Знайти всі @Matches з YMD-like regex:
grep -rnE "@Matches\(.*\\\\d\{4\}.*\\\\d\{2\}.*\\\\d\{2\}" apps/api/src/modules --include="*.dto.ts"

# 2. Для кожного match — перевірити чи парний @IsDateString у наступних 3 рядках:
grep -rnE "@Matches\(.*\\\\d\{4\}" apps/api/src/modules --include="*.dto.ts" -A 3 | grep -B 3 "!:\s*string" | grep -v "@IsDateString" | grep "@Matches"

# 3. Аналогічно для інших date-like patterns: @Matches(/^\d{2}\.\d{2}\.\d{4}/) для DD.MM.YYYY:
grep -rnE "@Matches\(.*\\\\d\{2\}.*\\\\d\{2\}.*\\\\d\{4\}" apps/api/src/modules --include="*.dto.ts"

# 4. Contract-test guard: для endpoint що приймає date-string — тест з invalid semantic date:
#    POST/GET з `?from=2026-99-99` → expect 400 (не 200 з empty)
```

Sanity-check: у Postman/curl `curl "/api/<endpoint>?from=2026-99-99" -H "Auth: ..."` → якщо 200 з empty дані замість 400 → bug.

**Підхід до фіксу:** додати `@IsDateString({ strict: true })` РАЗОМ з `@Matches(YMD_RE)`:

```typescript
@IsDateString({ strict: true }, { message: 'from має бути валідною датою' })
@Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from має бути у форматі YYYY-MM-DD' })
from!: string;
```

`@IsDateString({ strict: true })` перевіряє parseability через `new Date()` + strict-mode (відхиляє `2009-02-29`, `2026-99-99`). `@Matches` обмежує до YMD-only shape (без time-компонента).

Alternative pattern: custom validator `@IsYmdDate` що комбінує both check-и в одну декорацію.

**Регресія-guard:** contract-test для endpoint з invalid semantic date → expect 400 + Ukrainian message.

**Severity:** MEDIUM — silent empty result / silent-wrong data. Не HIGH бо: (а) валідні дати з UI date-picker — коректні; (б) DoS-vector обмежений; (в) якщо frontend відправить invalid date — user first bug report.

**Де шукати ще:**

- усі DTO що приймають YMD-date як параметр (query для reports, calendar, schedule, dashboard, filters `dateFrom/dateTo`)
- усі DTO що використовують `@Matches` з date-like regex — semantic-parse-check пропущений
- аналогічний pattern для other formats: phone (`@Matches(/^\+?\d{10,15}$/)` без range-check коду країни), IBAN (`@Matches(/^UA\d{27}$/)` без checksum-check), EDRPOU (`@Matches(/^\d{8,10}$/)` без mod-11 checksum)

### 2026-08-30 — E2E: seeded entity invisible через дефолтний date-фільтр списку (Bug #572) — e2e / seed-brittle / list-filters

**Сигнал:** Test сідить нову сутність (WorkOrder/Invoice/PurchaseOrder…) через API у `beforeAll`/inline, потім навігує на список і не знаходить її row. Screenshot показує «Нарядів не знайдено» (або аналог), при цьому date-input явно виставлений на «today». API GET підтверджує сутність існує; UI фільтр її ховає.

**Причина виникнення:**

- Prisma-модель має `documentDate DateTime @default(now()) @db.Date` — `now()` виконується на сервері (у Docker Postgres це UTC).
- UI-список має дефолт `dateFrom = kyivToday(), dateTo = kyivToday()` — Kyiv-локальна today.
- У вікні 00:00-03:00 Kyiv (літо, +3) UTC-дата на добу менша. Seed відбувається зараз (сервер UTC = 29-те), UI фільтр показує 30-те → row невидимий.
- Розробник тесту припускає що «today на сервері == today у UI» — це вірно 21 годину на добу, але 3 години невірно.

**Підхід до виявлення:**

- Runtime signal: `getByRole('row').filter({ hasText: /<label>/ })` timeout, screenshot показує «нічого не знайдено» з date-фільтром 30.XX.YYYY (Kyiv-today).
- Static grep: `grep -rn "new Date().*setSeededDate\|@default(now()).*@db.Date\|dateFrom.*kyivToday" apps/ --include="*.tsx" --include="*.ts"` — cross-match між Prisma-defaults і UI-defaults.
- Cross-reference: якщо у file є коментар типу «фільтр по даті за замовчуванням приховує seed-наряди ≠ today» (Bug #401 у estimate-share.spec.ts:181) — це вже задокументована grabля; шукати ВСІ тести на цьому файлі, не тільки той що падає.

**Підхід до фіксу:** У ТЕСТІ, а НЕ у продукті (продукт-дефолт "today" — валідний UX):

1. Seed API-helper повертає не тільки `id`, а й `number` (або той поле що відображається у search-box).
2. Перед пошуком row: очистити date-input (`fill('')` → `press('Escape')` — DatePickerInput.handleInputChange з empty string викликає `onChange('')` що видаляє фільтр).
3. Замість `filter({ hasText: /<label>/ })` (розмите) — search-box + exact number (детермінізм): `getByRole('textbox', { name: /Пошук/i }).fill(number)`.

**Anti-pattern:** обійти через API (як Bug #401 у same file line 179-206 «UI/E2E test для розкриття модалу через таблицю нестабільний... натомість перевіряємо backend»). Це фіксує один тест, але не root-cause — наступний UI-тест впаде так само. Кращий шлях — self-seed з cleanup.

**Severity:** HIGH — тест стабільно червоний у поточному оточенні, блокує зелений run 3 години на добу (+ завжди у CI runner з UTC TZ).

**Де шукати ще:**

- Усі e2e specs де beforeAll створює entity через API + перевіряє на UI: `grep -rn "beforeAll.*await\|await.*seed\|await.*create" apps/web/e2e --include="*.spec.ts"`
- Усі списки з дефолтом `dateFrom=kyivToday()`: work-orders, purchase-orders, stock-documents, invoices, supplier-payments (grep у apps/web/src/app для кожного `page.tsx`)
- Analogічно для будь-якого списку з дефолтним filter що не пропускає seed-дані (branchId, warehouseId, status).

### 2026-08-30 — E2E: DST-aware Kyiv timezone у test time-arithmetic (Bug #573) — e2e / dst / timezone

**Сигнал:** Test створює time-based ресурс (calendar slot, work-order plannedAt, invoice paidAt) через API і перевіряє його на UI. У певні години доби (00:00-03:00 Kyiv у літньому +3 DST, 00:00-02:00 у зимньому +2) тест падає з «element not found». Screenshot показує UI на правильному day view, але без створеного ресурсу.

**Причина виникнення:**

- Test використовує `new Date().toISOString().split('T')[0]` для отримання «today» → це **UTC**-дата, не Kyiv-дата. `.toISOString()` завжди UTC незалежно від Playwright `timezoneId: 'Europe/Kyiv'` (сеттінг впливає на `getDate()`/`getHours()`, але не на toISOString).
- Frontend отримує «today» через `Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv' }).format(new Date())` (наприклад calendar.utils.ts:65 `toDateString()` або format.ts:120 `kyivToday()`) → це Kyiv-дата.
- У 21:00-24:00 UTC (літо +3) Kyiv уже на добу вперед. Test створює ресурс на UTC-добу, UI відображає Kyiv-добу — mismatch.
- Додатковий підводний камінь: hardcoded UTC-час `${today}T07:00:00Z` (=10:00 Kyiv +3) працює тільки взимку/влітку по-різному; workDayStartHour defaults 8-18 Kyiv → «безпечний» діапазон UTC змінюється зі зміною DST.

**Підхід до виявлення:**

- Runtime signal: тест з `new Date().toISOString().split('T')[0]` падає непередбачувано (flaky) або стабільно у CI (UTC TZ) — pattern «green на dev, red на CI» типовий сигнал timezone-issue.
- Static grep: `grep -rn "toISOString.*split.*T.*\[0\]\|new Date().*toISOString" apps/web/e2e --include="*.spec.ts"` — усі такі тести на date-arithmetic вразливі.
- Cross-check: якщо продукт-код (frontend/backend) використовує `Intl` з `timeZone: 'Europe/Kyiv'`, а тест — `toISOString()`, це гарантовано mismatch у DST-boundary вікні.

**Підхід до фіксу:** У ТЕСТІ:

1. Kyiv-дата — той самий алгоритм що у продукті: `const kyivToday = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv' }).format(new Date());` (`sv-SE` дає `YYYY-MM-DD`).
2. Kyiv wall-clock → UTC ISO — DST-safe helper через двоетапний Intl round-trip:
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
     const shiftMs = (kyivHour - kyivHourOfGuess) * 3_600_000;
     return new Date(guess.getTime() + shiftMs).toISOString();
   }
   ```
   Обчислює реальний offset для конкретного моменту (не hardcoded +2/+3).
3. Iterate по Kyiv-годинах робочого дня (10-16), не по UTC — це узгоджено з UI workStartHour/workEndHour defaults.

**Anti-pattern:** hardcoded `+3` (літо) або `+2` (зима) offset у тесті — ламається при переході DST 2 рази на рік. Використання `date.getTimezoneOffset()` — залежить від хост-OS TZ, не від Playwright `timezoneId`.

**Severity:** HIGH — тест стабільно червоний у DST-boundary вікні (5% робочого часу) + завжди червоний у CI runner з UTC TZ. Категорія «CI-only failure» найгірша бо не reproducible локально без явного `TZ=UTC`.

**Де шукати ще:**

- Усі e2e тести з date/time arithmetic: `grep -rn "toISOString\|new Date(.*).*format\|hardcoded.*[+-]0[23]:00" apps/web/e2e --include="*.spec.ts"`.
- Backend spec-тести з дата-арифметикою: same issue, але тести використовують сервер-tz (`TZ=UTC` у Docker). Приклад — Bug #592 (purchase-orders.service.spec.ts:834).
- Frontend unit-тести з `new Date()` + Intl — Intl.DateTimeFormat не респектує `vi.setSystemTime()` timezone. Використовувати `vi.stubEnv('TZ', 'Europe/Kyiv')` перед `beforeEach`.
- Загальне правило: **e2e/spec тест НІКОЛИ не змішує UTC-arithmetic з Kyiv-UI/DB без явного round-trip через Intl.DateTimeFormat**.
