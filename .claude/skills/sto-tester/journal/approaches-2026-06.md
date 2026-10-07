# sto-tester — журнал підходів, 2026-06

> Не читати цілком — шукати за ключовим словом.

### 2026-06-20 — Prisma `$queryRaw` + pg_trgm `%` без `::text` cast (Bug #572) — backend / sql / type-resolution

**Сигнал:** `$queryRaw` з `%`/similarity → 500 `42804 argument of OR must be type boolean, not text`. Падає при concatenation LHS (`COALESCE(a,'')||' '||COALESCE(b,'') % $N`): Prisma шле `$N` без типу → planner резолвить як text → `text % text` без trgm.

```bash
grep -rn "\$queryRaw" apps/api/src --include="*.ts" -A30 | grep -B1 "%\s*\${" | grep -v "::text"
```

**Фікс:** explicit cast для params у `%`/`ILIKE`/`similarity()`: `col % ${qText}::text`, `col ILIKE ${qLike}::text`, `similarity(col,${qText}::text)`. Так само `${uuid}::uuid`, `${num}::int`, `${date}::timestamptz`.
**Severity:** HIGH (500 у production на специфічних запитах).
**Де ще:** search/list з pg_trgm GIN (counterparties, work_orders, goods, brands), similarity-grouping, `$queryRaw` у concatenation/COALESCE/CASE.

### 2026-06-20 — pnpm-workspace.yaml overrides peer incompatibility (Bug #573) — infra / dependencies / startup

**Сигнал:** API/Web не стартує після `pnpm install`: `FST_ERR_PLUGIN_VERSION_MISMATCH` (`@fastify/X expected '5.x', '4.28.1' installed`) або `@nestjs/*` вимагає Nest 11 на 10. Security override з `>=` у `pnpm-workspace.yaml` (pnpm 11+ читає overrides звідти) → витяг найновішу з newer peer.

```bash
grep -A5 "^overrides:" pnpm-workspace.yaml   # для кожного звірити resolved major у pnpm-lock проти runtime peer
```

**Фікс:** pin до останньої runtime-сумісної major: `'@fastify/middie': '^8.0.0' # 9.x вимагає fastify 5.x; ми на 4.28`. Коментар CVE+чому major.
**Severity:** CRITICAL — не стартує; не у CI (cache), лише fresh install.
**Де ще:** всі `>=` у overrides; щотижня fresh `pnpm install`+dev sanity; CI `node dist/main` smoke.

### 2026-06-20 — Silent `test.skip(true)` як fake-green replacement (мета-патерн) — e2e / test-debt

**Сигнал:** `if (!data) return test.skip(true, '...')` де data — результат endpoint що seed надійно заповнює → skipped=«pass», нічого не перевіряє, прикриває bug коли seed/API ламається.

```bash
grep -rn "test.skip(true" apps/web/e2e --include="*.spec.ts"
```

**Фікс:** `expect(data,'Seed має ...').toBeTruthy(); if(!data) return;`. Виняток — conditional UI feature. Pre-commit `grep test.skip\(true && exit 1`. CI grep skipped>5→failure.
**Severity:** MEDIUM (приховує regressions).

### 2026-06-20 — E2E pagination-blind test з stale DB records (Bug #568) — e2e / test-debt / pagination

**Сигнал:** `table tbody tr:has-text("E2E-Foo-...")` БЕЗ search — passes на чистій CI, timeout у dev (sort ASC+pagination ховає новий рядок на page 2/3). Assume «новий→сторінка 1» лише коли total≤pageSize.

```bash
grep -rn "table tbody tr:has-text" apps/web/e2e --include="*.spec.ts"   # +перевірити чи є Пошук/filter вище
```

**Фікс:** перед `toBeVisible` — `page.getByPlaceholder('Пошук...').fill(uniqueName)`.
**Severity:** HIGH (інтермітентне у dev).
**Де ще:** crud-counterparties/vehicles/invoices/work-orders/stock-documents; модуль з pagination 30+ + alphabetic sort.

### 2026-06-20 — Reflector-based contract test для new @Decorator (Bug #569) — api / contract / regression-guard

**Сигнал:** review додає security/behavioral decorator (`@Throttle`,`@UseGuards(JwtAuthGuard)`,`@Roles`,`@HttpCode`) на існуючий method. Тести бізнес-логіки не бачать reflection metadata → жоден guard не падає при відсутності decorator → false security.

```bash
ls apps/api/src/modules/*/ | grep -E "throttle.*contract\.spec"
```

**Фікс:** `<module>.<decorator>.contract.spec.ts` з `new Reflector()`: `reflector.get(THROTTLER_LIMIT+'default', Ctrl.prototype.method)` `.toBe(5)`. Keys `@nestjs/throttler`: `THROTTLER_LIMIT+'default'`, `THROTTLER_TTL+'default'`.
**Severity:** LOW прямий, HIGH preventive.
**Де ще:** модуль з `@Throttle/@Roles/@UseGuards/@HttpCode` доданим після initial impl — публічні booking/share/webhooks.

### 2026-06-20 — Cross-package LABELS/BADGE контракт-тест для shared constants (Bug #570) — web / shared / drift-detection

**Сигнал:** FE `LABELS[status] ?? status` — backend додає enum value → LABELS не оновлено → fallback повертає raw `NEW_STATUS_X`. TS не падає (обидва `Record<string,string>`).

```bash
grep -rn "_LABELS\[.*\] ?? " apps/web/src --include="*.tsx" --include="*.ts"
```

**Фікс:** `<entity>-status-labels.test.ts` з `EXPECTED_STATUSES` (дзеркало prisma enum)+it.each: кожен має label/badge/description, кирилиця `/[Ѐ-ӿ]/`, all 3 maps однакові ключі.
**Severity:** LOW (regression guard).
**Де ще:** INVOICE_STATUS_LABELS, PO_STATUS_LABELS, STOCK_DOC_STATUS/TYPE_LABELS, COUNTERPARTY_TYPE_LABELS, GOOD_TYPE_LABELS, EMPLOYEE_ROLE_LABELS.

### 2026-06-17 — Local interface дрейфує від hook/DTO при новому полі (Bug #506 / #510) — frontend / type-duplication

**Сигнал:** тип `WorkOrder`/`Invoice`/`Counterparty` дублюється: `hooks/api/use<Entity>.ts` (авторитет) + `<entity>/page.tsx`/`[id]/PageClient.tsx` (inline). Backend додає поле → hook оновлено, локальний interface забутий → TS green, нове поле невидиме. Найгірше — формула `totalAmount` змінена, UI сумує `totalLabor+totalParts`.

```bash
grep -rn "^interface WorkOrder " apps/web/src --include="*.ts*"   # >1 = застарілий
```

**Фікс:** `import { WorkOrder } from '@/hooks/api/useWorkOrders'`; `interface WorkOrderDetail extends WorkOrder {...}`. Regression-guard `satisfies`: `const _check: WorkOrderDetail = {} as Awaited<ReturnType<typeof fetchWorkOrder>>;`.
**Severity:** MEDIUM (UI довіра); HIGH з gross-сумами.
**Де ще:** тріада `[id]/PageClient.tsx`+`Create<Entity>Modal.tsx`+`use<Entity>.ts`; aggregate-поля (totalAmount, paidAmount, balanceAmount).

### 2026-06-17 — Семантична зміна загального поля без оновлення downstream consumers (Bug #508) — backend / consistency

**Сигнал:** feature змінює формулу denormalized поля (`totalAmount`/`paidAmount`/`balance`/`cost`) що читається всюди (service, public/share, PDF, reports, sync). Автор оновив головний flow, пропустив semantic mismatch: estimate-share показує `wo.totalAmount`=«actual» (з actualHours) хоча контекст=PLAN.

```bash
grep -rn "\.totalAmount\|totalAmount:" apps/api/src --include="*.ts" | grep -v "spec\|test"
# "actual" (completion/invoice) → нова формула OK; "planned" (estimate/share/draft) → WRONG
```

**Фікс:** у share/public — обчислити ЛОКАЛЬНО з planning-компонентів: `totalAmount: Number(wo.totalLabor)+Number(wo.totalParts)`. Regression: estimate-share=totalLabor+totalParts (no actualHours leak) для WO з ненульовими actualHours.
**Severity:** LOW-MEDIUM (некоректна публічна сторінка заплутує клієнта).
**Де ще:** пари (denorm field, share/public): wo.totalAmount↔estimate, invoice.amount↔receipt, counterparty.balance↔self-service, vehicle.currentMileage↔public history.

### 2026-06-19 — Shared include-shape const (3 read paths) без regression-guard на DTO field propagation (Bug #541) — backend / test-coverage / refactor safety

**Сигнал:** review-fix витягує дублюваний Prisma `include` у shared const (`PART_GOOD_INCLUDE`) у 3+ read paths. Drift між callsites попереджено, але жоден test не асертить що поля const потрапляють у DTO. Видалення `internalCode:true` з const: TS green, `toDto`→null (silent), FE не показує.

```bash
grep -rnE "^const [A-Z_]+_INCLUDE\s*=" apps/api/src/modules --include="*.service.ts"
# paired spec mock-fixture <relation> має ВСІ scalar (internalCode/sku/brand.name/unit) — не лише name
```

**Фікс:** розширити mock-fixture до повного shape АБО regression-guard `it('DTO містить goodInternalCode/goodSku/goodBrandName')` з `toMatchObject`; дзеркальний guard у КОЖНОМУ callsite (findOne/addPart/updatePart).
**Severity:** LOW (silent gap); MEDIUM коли const-shape дає denormalized PII для share-link.
**Де ще:** `const <X>_INCLUDE`/`<X>_SELECT`/`<X>_DEFAULT_ARGS` ≥2 callsites: PART_GOOD_INCLUDE, PO_LINE_GOOD_INCLUDE, GOOD_UOM_SELECT.

### 2026-06-17 — Role-gated sensitive field у DTO без regression-guard у service spec (Bug #527, #529) — backend / security / test-coverage

**Сигнал:** `fix/feat: role-gate <Field>` додає `<X>_VISIBLE_ROLES=new Set([...])`, `canSeeX(role)`, `userRole?:string`. Поле чутливе (`costPrice`/`purchasePrice`/`margin`/`internalNotes`/`bankAccount`). Без тесту: refactor видаляє `userRole`; default 'OWNER'→leak; typo у Set→leak; нова роль забута.

```bash
grep -rnE "(VISIBLE_ROLES|canSee[A-Z])" apps/api/src --include="*.ts" | grep -v "spec\|test"
# для кожного: grep -rn "<sameName>" apps/api/src --include="*.spec.ts" → 0 = HIGH
grep -rn "to<DtoName>\(" apps/api/src --include="*.service.ts" | grep -v spec   # кожен callsite передає userRole?
grep -rn "Set<string>" apps/api/src --include="*.service.ts" | grep -i "role"   # case-sensitive vs JWT claim
```

**Фікс:** dedicated `<module>.role-gate.spec.ts` матриця: (1) кожна привілейована роль→візібл; (2) кожна непривілейована (MECHANIC/RECEPTIONIST/CLIENT)→undefined; (3) `userRole===undefined`→fail-closed; (4) `''`→fail-closed; (5) невідома (`'GUEST'`)→fail-closed; (6) lowercase (`'owner'`)→fail-closed; (7) `<Field>===null` для привілейованої→`null` (не undefined — «доступ є, value not set»). ВСІ mutation endpoint (addX/updateX не тільки findOne) приймають userRole.
**Severity:** HIGH (release-blocker Auth) фінансове/PII; MEDIUM informational.
**Де ще:** DTO prefix `cost*`/`purchase*`/`internal*`/`audit*`/`private*`/`secret*`/`bankAccount`/`taxId`/`salary`/`margin`.

### 2026-06-17 — React inline-edit merge втрачає DB-only fields (id, createdAt) → save() filter пропускає рядок (Bug #526) — frontend / state-merge

**Сигнал:** inline-row-edit commit ✓ merge губить `id`: `setItems(prev=>prev.map(it=>it._key===target._key?{...editing,_key:it._key}:it))` де `editing:Omit<Item,'id'>`. Далі `save()` робить `items.filter(i=>!!i.id)` → row пропадає → PATCH не надсилається → після reload старе value. WO-level sum виглядає збереженим (маскує).

```bash
grep -rn "\.\.\.editing.*_key" apps/web/src --include="*.tsx" --include="*.ts"
grep -rn "filter.*!!.*\.id\|filter.*l\.id" apps/web/src --include="*.tsx" --include="*.ts"
grep -rn "Omit<.*'_key'>" apps/web/src --include="*.ts*"
```

**Фікс:** spread base FIRST: `{ ...l, ...editing, _key: l._key }`. Regression (RTL): після ✓ assert `lines[0].id===<original-id>` або spy PATCH `/lines/<originalId>`.
**Severity:** CRITICAL — silent data-loss маскований UI feedback.
**Де ще:** CreateInvoiceModal, CreatePurchaseOrderModal, CreateStockDocumentModal, BudgetTab, будь-яка двофазна editing UI (server list+local edit buffer).

### 2026-06-16 — Time-of-day string DTO field без regex + cross-field guard (Bug #515) — backend / validation

**Сигнал:** `@IsString()` для `*Time`/`*Hour` без `@Matches(/^\d{2}:\d{2}$/)`. Сервіс не валідує `workEnd>workStart` → `dynHours=[]` → division by zero → NaN у CSS.

```bash
grep -rn "@IsString()" apps/api/src --include="*.dto.ts" | grep -i "time\|hour\|start\|end" | grep -v "@Matches"
```

**Фікс:** `@Matches(HH_MM_RE)` + cross-field `if(startH>=endH)throw` + defense fallback у `getWorkHours()`.
**Severity:** MEDIUM.
**Де ще:** BranchSettings, OperatingHours, EmployeeShift, EventSchedule.

### 2026-06-16 — jsdom missing URL.createObjectURL/revokeObjectURL stub (Bug #518) — frontend / test-infrastructure

**Сигнал:** `vitest exit 1` при всіх green tests + `Uncaught: TypeError: URL.createObjectURL is not a function` (видно лише по exit code).

```bash
grep -n "createObjectURL\|revokeObjectURL" apps/web/src -r   # → перевірити setup.ts на stub
```

**Фікс:** у `apps/web/src/__tests__/setup.ts`: `if(typeof URL.createObjectURL==='undefined'){URL.createObjectURL=()=>'';URL.revokeObjectURL=()=>{}}`.

### 2026-06-16 — Dead exports у \*.utils.ts після refactor на dynamic config (Bug #517) — frontend / dead-code

**Сигнал:** exported `const` у `calendar.utils.ts` має 0 usages після переходу на `useState(fetched)`. TS не видає error на unused exports.

```bash
grep -rn "HOURS\|TOTAL_HOURS\|WINDOW_START\|pxToHours" apps/web/src --include="*.ts" --include="*.tsx" | grep -v "\.utils\.ts"   # 0 = dead
```

**Фікс:** видалити. Після refactor module-const→dynamic fetch перевіряти всі exports на 0 references.

### 2026-06-16 — Set key з getUTCHours() для порівняння з Kyiv-локальними слотами (Bug #511) — backend / time-zone semantics

**Сигнал:** ключ Map/Set через `getUTCHours()` як `HH:MM`, а інший масив ключів — з Kyiv-локальних `BranchSettings.workStartTime`. Ключі НЕ перетинаються (Kyiv +02/+03 ≠ UTC) → `Set.has()` always false → guard silently не спрацьовує.

```bash
grep -rn "getUTCHours\|getUTCMinutes" apps/api/src/modules --include="*.ts" | grep -v spec
grep -rn "toISOString().slice(11" apps/web/src --include="*.ts*" | grep -v test   # frontend mirror UTC HH:MM
```

**Фікс:** module-level `Intl.DateTimeFormat` singleton `{timeZone:'Europe/Kyiv',hour12:false,hour/minute:'2-digit'}` (locale `'en-GB'` padded)+`.format(date)` (авто-DST). Regression: date що переходить UTC midnight у Kyiv (`2026-06-01T22:30:00Z`→01:30 Kyiv NEXT day).
**Severity:** CRITICAL коли guard блокує бронювання/payment/inventory; HIGH UI; MEDIUM log.
**Де ще:** модуль що порівнює BookingRequest.requestedDate/CalendarSlot.startAt/WorkOrder.scheduledAt/Payment.paidAt з user-часами; frontend useCalendarState, `<TimeInput>` persist UTC vs Kyiv.

### 2026-06-16 — useRef для уникнення ре-рендерів стає stale коли ініціалізація async (Bug #512) — frontend / race condition

**Сигнал:** два паралельні `useEffect` mount: один fetch A пише у `useRef`, інший `useCallback` читає ref у `.then()` з deps `[date]` (НЕ `[lifts]`). Якщо B резолвиться ДО A → ref читає `[]` → derived state порожній назавжди. Тест passes (моки одразу).

```bash
grep -rnE "useRef\(\[?\]?\)" apps/web/src --include="*.ts*" | grep -v test
```

**Фікс:** додати proxy `.length` у deps callback (`lifts.length` 0→N перевикликає з готовим ref). Або Promise.all у єдиному effect. Regression: `mockResolvedValueOnce(new Promise(r=>setTimeout(()=>r(data),100)))` повільний /lifts.
**Severity:** HIGH коли feature видимо ламається; MEDIUM приховані індикатори.
**Де ще:** hook з `useRef([])` async-init + `useCallback` без проксі (useChatState, useDashboardState, useTimelineState).

### 2026-06-16 — Unclamped UI math для нових feature-блоків копіюється але втрачає back-end guard (Bug #513, #514) — frontend / UI overflow

**Сигнал:** новий component копіює positioning math (`left=((startH-HOURS[0])/TOTAL_HOURS)*100`) з existing. Existing працює бо дані clamp через service (`createSlot()→kyivEndOfWorkDay`), новий бере з іншого джерела (`BookingRequest.requestedDate`) БЕЗ clamp → `left<0`/`width>100%` → блок невидимий. `overflow:hidden` ховає.

```bash
grep -rn "((startH - HOURS\[0\])\|left = .* % \|kyivHours(slot" apps/web/src --include="*.tsx"
```

**Фікс:** (1) defensive clamp у component `if(endH<=MIN||startH>=MAX)return null;`+`Math.max(MIN,startH)`,`Math.min(MAX,endH)`; (2) парний back-end guard джерела (#514). Regression: out-of-bounds startH → `left:'0%'` або null.
**Severity:** MEDIUM (invisible block ховає data); HIGH коли block=CTA.
**Де ще:** Gantt timelines, schedule grids, sparklines, progress bars з `width %` з user input.

### 2026-06-15 — Queue.add(name,data) shape не співпадає з processor process(job) (Bug #506, #507) — backend / queue / contract drift

**Сигнал:** `someQueue.add('job-name',{fieldA,fieldB})` у service-A, `@Processor WorkerHost.process(job)` робить `const {fieldX,fieldY}=job.data` — жодне поле не співпадає. tsc green (payload any), specs обох сторін passing окремо. Runtime: processor читає undefined → silent skip → BullMQ НЕ retry. Причина: `bull→bullmq` refactor (`@Process({name})` фільтрував job.name, `WorkerHost.process()` не фільтрує → всі jobs в один).

```bash
grep -rnE "Queue.*add\(\s*['\"]([^'\"]+)['\"]" apps/api/src --include="*.ts" | grep -v spec
grep -rnE "@Processor\(['\"]([^'\"]+)['\"]" apps/api/src --include="*.processor.ts"
# interface XxxJob у processor → порівняти ключі; unique callsite key відсутній у Job = bug
```

**Фікс:** canonical service черги (NotificationsService.send для SMS, SettlementsService.createTransaction, InventoryService.createMovement) що агрегує resolve+ставить правильний shape; переписати callsite на нього, прибрати `@InjectQueue`. Новий event-type→enum+`ALTER TYPE ADD VALUE`+seed NotificationTemplate (#220,#478-#480). Spec (#507 — лише options): видалити `expect(opts.attempts).toBe(10)`; `expect(canonicalService.send).toHaveBeenCalledWith(orgId, String, objectContaining({branchId,phone,...}))`.
**Severity:** HIGH (silent gap); CRITICAL для фінансової (ПРРО чек, settlement); MEDIUM non-critical (loyalty).
**Де ще:** `@InjectQueue(name)` поза canonical service — public/widget (booking, form, lead); після queue-library migration — audit shape vs interface. Парне #267/#268.

### 2026-06-16 — Widened service return-type + stale paired spec (Bugs #508-#509) — backend / contract / tests symmetry

**Сигнал:** service розширюється `Promise<{id,number}>`→`Promise<{id,number,status,amount,documentDate}>` (розширений select+mapping). Baseline unit падає `expected {…5} to equal {…2}` (mock повертав 2 поля, mapping `Number(undefined)→NaN`). Contract тихіше: `toMatchObject({id,number})` пропускає нові undefined → silent regression-guard gap.

```bash
git diff HEAD~3 HEAD -- "*/*.service.ts" | grep -E "^\+\s+(status|amount|documentDate|[a-z]+At|[a-z]+Count):\s*(true|inv\.|Number|\.toISOString|\?\?\s*null)"
grep -rn "toMatchObject({" apps/api/src --include="*.contract.spec.ts"   # підмножина-assert без negation = gap
```

**Фікс:** unit mock — всі нові поля (Decimal/Date, null); unit assert `toEqual({..5..})` (НЕ `expect.any`); contract mock той самий shape; contract assert `toEqual` (НЕ `toMatchObject` — видалення поля→undefined→JSON без ключа→підмножина проходить); окремий null-branch. **Stale `$transaction` callback mock** (sub-pattern #489):

```ts
// ❌ $transaction: vi.fn(async (ops) => ops),   ← callback НЕ викликається
// ✅ розпізнає обидві форми:
$transaction: vi.fn().mockImplementation((arg) => {
  if (Array.isArray(arg)) return Promise.all(arg);
  if (typeof arg === 'function') return arg(prisma);
  return Promise.resolve(arg);
}),
```

Якщо service спрощено array→callback АЛЕ мок не оновлено → INNER логіка $transaction body МОВЧКИ пропускається (всі inner asserts зелені без виклику).
**Severity:** HIGH якщо unit падає (release-blocker); MEDIUM лише contract gap.
**Де ще:** service.ts чіпнутий review після feature; lightweight-read «це існує?» що пізніше отримує fields. Парне #390,#478-#480,#432-#433.

### 2026-06-15 — setX(value) викликається у async, але x не читається у JSX (Bug #497) — frontend / dead-state / UX feedback

**Сигнал:** `loading`/`loadingId`/`saving` setter викликається (перед await, false у finally), але НІКОЛИ не читається у JSX (`{loading&&<Spinner/>}`/`disabled={loading}`) → extra renders + user не бачить реакції. Гірше за класичний dead-state (там обидві сторони мертві).

```bash
grep -rnE "useState[<(](bool|number|null|string)" apps/web/src/app --include="*.tsx" -A5
# decl>0 && read==0 (немає {name}/name &&/disabled={name}/loading={name}) → MUTE STATE
```

**Фікс:** (1) видалити state якщо <100ms; (2) render-time `disabled={saving}`/`loading={saving}`; per-row `loading={detailLoadingId===row.id}`.
**Severity:** MEDIUM. Парне #303.
**Де ще:** `loadDetail`/`fetchOne`/`loadOptions` async→per-row loading; search debounced fetch; inline-edit savingIds.

### 2026-06-15 — mutateAsync() у inline click-handler без try/catch — silent failure (Bug #499) — frontend / silent UX failure

**Сигнал:** `onClick={async()=>{await mut.mutateAsync(arg);toast.success('...')}}` без try/catch, без `useMutation({onError})`, без глобального `MutationCache.onError` → rejects перериває handler → ні success ні error toast.

```bash
grep -rn "MutationCache\|mutationCache:" apps/web/src   # пусто → ВСІ inline mutateAsync без try/catch = bug
grep -rnE "await\s+\w+\.mutateAsync\(" apps/web/src/app --include="*.tsx" -B2 -A3
```

**Фікс:** (1) per-hook `onError:e=>toast.error(e.message)` (SSOT); (2) inline try/catch; (highest) глобальний `MutationCache.onError`. Regression: `mockRejectedValue`→click→assert `toast.error`.
**Severity:** MEDIUM; HIGH якщо видаляє Invoice/Payment/WO transition (duplicate-click→data inconsistency).
**Де ще:** inline `onClick={async()=>` single-step mutation (Trash2/Pencil/Zap); `useEffect(()=>{mutation.mutateAsync()},[])`.

### 2026-06-15 — Partial<Record<Enum,V>> lookup з runtime fallthrough ховає TS-exhaustiveness (Bug #488) — backend / type-safety

**Сигнал:** `Partial<Record<EnumX,V>>` для look-up знаку/типу + `if(sign===undefined)throw`. Зараз всі enum присутні, АЛЕ `Partial<>` пропускає новий `ALTER TYPE ADD VALUE` без compile-error → runtime exception.

```bash
grep -rnE "Partial<Record<[A-Z][a-zA-Z]+(Type|Status|Role|Kind),\s" apps/api/src/modules --include="*.ts" | grep -v spec
```

**Фікс:** `Partial<Record<Enum,V>>`→плоский `Record<Enum,V>` (TS вимагає всі values → новий enum→compile-error); видалити runtime guard. Якщо Partial потрібна — коментар + regression-guard default-branch.
**Severity:** MEDIUM; HIGH якщо map гейтить фінансову (BALANCE_SIGN, TAX_RATE, VAT_FACTOR).
**Де ще:** MOVEMENT_TYPES, docTypeMap, TRANSITIONS (FSM); LABELS/BADGE/COLOR (Partial з fallback «—» OK).

### 2026-06-15 — Dedup invariant додано після simplify-to-Promise.all БЕЗ regression-guard (Bug #489) — test-coverage / silent data corruption

**Сигнал:** simplify замінив sequential `for{await tx.X.update()}` (last-wins) на `Promise.all(plan.map(u=>tx.X.update()))` + `dedupedPlan=deduplicateBy(plan,u=>u.pk)`. Парний spec не перевіряє invariant → refactor що дропне `deduplicateBy` пройде CI (fixtures унікальні PK). Production має дублікати (PO multi-lot на той самий goodId, xlsx з повтором SKU).

```bash
grep -rn "deduplicateBy\|new Map(.*\.map.*=> \[" apps/api/src/modules --include="*.service.ts" -l
# для кожного: grep -cE "deduplicate|duplicate.*(goodId|lineId|id)" $spec → 0 = bug
```

**Фікс:** regression — `plan` з 2+ entries одним PK (різні values); `expect(prisma.X.updateMany).toHaveBeenCalledTimes(1)` (НЕ 2!); `data:{<field>:<last-value>}`. Плюс sub-pattern stale `$transaction` callback mock (див. #508-509).
**Severity:** MEDIUM (silent data corruption на duplicate-PK).
**Де ще:** `applyX`/`bulkUpdateX`/`recalculateX`/`syncFromY` з масивом можливих duplicate-PK: pricing, reservation release, batch FEFO writeoff, settlement reconciliation.

### 2026-06-15 — Новий documentType literal не зареєстрований у DOC_TYPE_LABELS map (Bug #491) — backend / i18n

**Сигнал:** новий ресурс пише StockMovement/SettlementTransaction з `documentType:'<NewName>'`, `inventory.service.ts:DOC_TYPE_LABELS` без парного запису → UI показує англомовний `'SupplierReturn'`. Map у ЧУЖОМУ модулі, TS не падає.

```bash
grep -rnE "documentType:\s*'[A-Z][a-zA-Z]+'" apps/api/src/modules --include="*.service.ts" | grep -oE "'[A-Z][a-zA-Z]+'" | sort -u
# diff проти ключів DOC_TYPE_LABELS → unmapped = bug
```

**Фікс:** `<NewModel>:'Український label'`. Better: `packages/shared/.../document-labels.ts` як `Record<DocumentType,string>` (не Partial) — TS-exhaustiveness.
**Severity:** MEDIUM; LOW admin-only.
**Де ще:** StockMovement.documentType, SettlementTransaction.documentType, AuditEvent.entityType, NotificationEvent.relatedDocumentType.

### 2026-06-15 — DTO line-level FK через createMany без cross-tenant guard (Bug #495) — backend / tenant isolation / Bug #161 family

**Сигнал:** `create()/update()` приймає `dto.lines:Array<{goodId,unitOfMeasureId?}>` і пише `tx.<resource>Line.createMany({data})` БЕЗ preceding `findFirst({orgId,id:l.goodId})` для КОЖНОГО FK (Prisma FK валідує лише глобальне існування).

```bash
grep -rnE "tx\.\w+Line\.createMany\s*\(\s*\{" apps/api/src/modules --include="*.service.ts" -l
```

**Фікс:** `validateLineRefs(orgId,lines)` batch ПЕРЕД `$transaction`:

```ts
const goodIds = Array.from(new Set(lines.map(l => l.goodId)));
const goods = await prisma.good.findMany({
  where: { id: { in: goodIds }, orgId, deletedAt: null },
  select: { id: true },
});
if (goods.length !== goodIds.length)
  throw new NotFoundException(`Товар не знайдено: ${missing[0]}`);
```

Regression: cross-tenant fixture (N-1)→`rejects NotFoundException`+`expect(prisma.X.create).not.toHaveBeenCalled()`.
**Severity:** HIGH; CRITICAL якщо UI drop-down лише own-org але API дозволяє.
**Де ще:** `<resource>Line[]` create/update: SupplierReturn, PurchaseOrder, Invoice, StockDocument, WorkOrder parts, ReconciliationAct; nested recipients[]/permissions[]/vehicleIds[].

### 2026-06-14 — Multi-mode page викликає всі data hooks одночасно замість gate по mode (Bug #457) — frontend / perf

**Сигнал:** сторінка з `viewMode` switcher, hooks (`useStockByDocument`, `useStockByBatch`) викликані безумовно top-level → ВСІ N запитів на mount (1 visible).

```bash
# useState<.*ViewMode> у .tsx → count(useQuery)>1 АЛЕ count(enabled.*viewMode)=0 → bug
```

**Фікс:** opt-in `enabled?:boolean` у кожен mode-hook, `enabled:!!employee&&enabled`; споживач передає `viewMode==='documents'`. Regression: `renderHook(useX({},false))`→НЕ apiFetch.
**Severity:** MEDIUM; HIGH якщо endpoint важкий.
**Де ще:** `*/page.tsx` зі switcher: inventory, reports, dashboard, analytics, calendar, dispatch board.

### 2026-06-14 — useEffect deps на array-of-object refetches на кожну mutation НЕ-key поля (Bug #454) — frontend / perf

**Сигнал:** useEffect фетчить за «key» полями (`goodId` set), але deps сам масив (`[parts]`) → typing у quantity/price створює нову reference → network на кожен keystroke.
**Фікс:** memoize fingerprint `useMemo(()=>sortedSetOfKeys.join(','),[array])`→deps `[fingerprint]` (sort обов'язковий).
**Severity:** MEDIUM; HIGH якщо race-conditions/дорогий endpoint.
**Де ще:** BulkActionsBar, list pages з batch-select, filter sidebar debounce, settings `Promise.all().then(setMap)`.

### 2026-06-15 — Нове enum value додано БЕЗ regression-guard для самого value (Bugs #478-#480) — test-coverage / regression-guard gap

**Сигнал:** `feat: add <NEW_VALUE> to <Enum>` змінює: prisma enum+migration; `@sto/shared` LABELS; DTO `@IsEnum` (Create+Query); service maps; FE array. Парний spec без `<NEW_VALUE>` → grep у spec=0. «Логіка як WRITEOFF» хибно (RECEIPT vs TRANSFER різна гілка, RECEIPT vs WRITEOFF sign).

```bash
grep -rn "<NEW_VALUE>" apps/api/src/modules/<scope>/ --include="*.spec.ts"   # 0 = bug
```

**Фікс:** 3 regression-guards contract+service: (1) POST `type:NEW`→201; (2) GET `?type=NEW`→200; (3) `transition(NEW-doc,CONFIRMED)`→`inventory.createMovement toHaveBeenCalledTimes(1)` (NEW у TRANSFER=двічі), `dtoArg.type===StockMovementType.NEW`, `dtoArg.quantity>0` (sign), `docNumbers.next(orgId,'PARENT_DOC_TYPE')` (docTypeMap), `dtoArg.warehouseId` (НЕ targetWarehouseId). Якщо service spec нема (#480) — створити (`stock-documents.service.spec.ts`).
**Severity:** HIGH (3 рівні мовчки ламаються; live 400/«Непідтримуваний тип»).
**Де ще:** WorkOrderStatus/InvoiceStatus/PurchaseOrderStatus (FSM side-effects), StockMovementType/StockDocumentType, DocumentType (numbering e2e), PaymentMethod/CounterpartyType/EmployeeRole, `switch(type)`/`Record<EnumType,X>`.

### 2026-06-14 — Новий endpoint без service spec + contract spec (Bugs #452, #453) — test-coverage / regression-guard gap

**Сигнал:** новий `@Get('endpoint')`+method → grep spec=0. Автор browser-test через Network tab.

```bash
git diff HEAD~N HEAD --name-only -- "*/*.controller.ts" "*.service.ts"   # для method grep парний .spec.ts
```

**Фікс:** `describe('newMethod')` service spec 5-7 (empty, tenant, soft-delete, null/0, cross-tenant); `*-<feature>.contract.spec.ts` 10-12 HTTP (400/403/boundary/dups/malformed).
**Severity:** MEDIUM (release-blocker якщо guard CRITICAL — UUID/ліміти). Auto-rule: commit що додає method у service МАЄ мати діф у `<service>.spec.ts`.

### 2026-06-11 — Shared FE-BE константа: backend inline literals замість спільної const (Bug #432) — backend / FE-BE drift

**Сигнал:** shared const оновлена для FE, backend service має inline `['STATUS_A','STATUS_B']` → FE=single source (порушує принцип «BE — джерело, FE — mirror» #401).

```bash
grep -rn "'COMPLETED', 'INVOICED'" apps/api/src --include="*.ts" | grep -v spec
```

**Фікс:** backend const у `<entity>.fsm.ts`, замінити inline. FSM-spec `expect(BE_STATUSES.sort()).toEqual([...FE_STATUSES].sort())`.
**Severity:** HIGH (silent drift → додавання статусу: FE gate ok, backend 400). Особливо CRITICAL коли whitelist гейтить фінансово/legal (invoice, completion-act).
**Де ще:** будь-який FSM/gate-whitelist модуль (PO, Invoice, StockDocument, CompletionAct, Calendar).

### 2026-06-11 — Audit-track list неповний для нових полів у update().data (Bug #433, family #421) — backend / audit / compliance

**Сигнал:** `update({data:{documentDate,liftId,...}})` має більше keys ніж `trackField([...] as const)`. Split-fix: один `fix(tester): audit gap` пропускає суміжні. AuditEvent.diff силентно порожній для незатрекованого поля.
**Фікс:** додати поле у trackField array. Regression: `it('update з {X} включає X у audit.diff')`. Особливо ризиково FK (liftId/branchId/contractId), дати, суми.
**Severity:** HIGH (audit-trail).
**Де ще:** усі `*.service.ts` з update+auditService — недавно додані поля.

### 2026-06-11 — Local FE interface ↔ backend DTO field-list drift (Bug #434) — sync / type-drift

**Сигнал:** компонент має локальний `interface <ResourceDetail>` без імпорту з shared. Backend DTO додав `<field>?:<type>` — FE interface пропустив → load-mapper хардкодить дефолт. tsc green. Симптом: display працює, inline-edit/clone хардкодить (FK dropdown показує «шт» замість «kg»).

```bash
git diff HEAD~N HEAD -- "*/*.dto.ts" | grep "^+.*?: " | grep -E "@ApiPropertyOptional"
```

**Фікс:** додати поле у local interface (або експортувати у `packages/shared/src/types.ts`). Regression: `it('edit existing X зберігає <new field>')`.
**Severity:** MEDIUM; HIGH якщо submit-path пише hardcoded default.
**Де ще:** `CreateXModal`/`EditXModal`/`[id]/PageClient.tsx` з локальним interface; FK з default-value.

### 2026-06-11 — Dead JSX <></> Fragment після refactor IIFE→inline (Bug #431) — frontend / code-cleanliness

**Сигнал:** refactor/simplify у `.tsx` → `<>...</>` де батько вже має siblings.

```bash
grep -nE '^\s+<>\s*$|^\s+</>\s*$' apps/web/src/**/*.tsx
```

**Виключення:** `return <>...</>`, `condition && <></>` — не dead.
**Severity:** LOW (cosmetic, накопичується).

### 2026-06-11 — Stale vi.mock після refactor-extract нового export (Bug #429) — frontend / test-staleness

**Сигнал:** `vi.mock('@/lib/X')` без нового export що компонент імпортує. Тест fail-ить за не-пов'язаним assert (catch+finally нормалізують стан).

```bash
git diff HEAD~N HEAD -- "apps/web/src/lib/*.ts" | grep "^+export"   # → grep -rln "vi.mock.*@/lib/<libName>" apps/web/src --include="*.test.tsx"
```

**Фікс:** `vi.mock('@/lib/X', async () => { const actual = await vi.importActual('@/lib/X'); return { ...actual, override: stub }; })`.
**Severity:** HIGH (release-blocker, ховає реальні регресії). Парне #430.

### 2026-06-11 — React state guard у async handler race-window (Bug #430) — frontend / race-condition / data-integrity

**Сигнал:** `handleClose` читає `if(saving)return` через state closure; async handler `setSaving(true)→await apiFetch()` → React не flush до завершення handler → Escape між кроками закриває modal на pending POST → orphan.

```bash
grep -rn "if (saving\|if (loading\|if (transitioning" apps/web/src/components --include="*.tsx" | grep -v "Ref\.current"
```

**Фікс:** двошарова state: `useState` для render + `useRef` для guard reads; wrapper-setter оновлює обидва. Regression: pending Promise mock→submit→Escape→`expect(onClose).not.toHaveBeenCalled()`.
**Severity:** HIGH (orphan rows, silent failed POST).

### 2026-06-10 — Asymmetric-write nullable col у clone()/copy mutation (Bug #426) — backend / data integrity

**Сигнал:** sprint додає `nullable colX` у line-model. `transition()/clone()` обчислює `resolvedValue` і передає у side-effect, але НЕ `tx.<row>.update({data:{colX:resolvedValue}})`.

```bash
grep -rnE "[a-z]*Id:\s*l\.[a-z]*Id\s*\?\?\s*null" apps/api/src/modules --include="*.service.ts"
```

**Severity:** HIGH (silent: movement має X, line NULL → audit/sync ламається).

### 2026-06-10 — E2E тест застарів після UI refactor: dropdown→pills (Bug #428) — E2E / test staleness

**Правило:** тест падає=щось зламано → знайти ЩО (UI зламаний або тест застарів). Intentional refactor→оновити тест, НЕ обходити. `data-testid` стабільніше за text/role.
**Severity:** MEDIUM.

### 2026-06-10 — Token-guard debouncer: early-return не інкрементує reqId (Bug #396) — frontend / async race

**Сигнал:** хук з `reqIdRef` — early-return (`!startAt||endAt<=startAt`) робить `setX(null)` БЕЗ `reqIdRef.current++` → in-flight fetch resolve перезаписує очищений стан.

```bash
grep -rn "reqIdRef\|requestIdRef" apps/web/src --include="*.ts" --include="*.tsx" -l
```

**Фікс:** усі гілки що змінюють стан (включно early-return) бамптять `reqIdRef.current++` ПЕРЕД `setX(null)`. Regression: in-flight never-resolving Promise + early-return + delayed resolve → state still null.
**Severity:** MEDIUM.

### 2026-06-10 — Conflict-check без excludeParentId у контексті edit parent (Bug #397) — backend+frontend

**Сигнал:** `POST /X/check-conflicts` з `excludeSelfId` АЛЕ виклик з modal батьківської entity (1:N до self) без `excludeParentId` → backend знаходить власні slots → false-positive при кожному відкритті.

```bash
grep -rn "check-conflicts\|checkConflict" apps/web/src --include="*.tsx" -l   # чи context = parent-entity
```

**Фікс:** симетричний `excludeParentId` field у DTO + фільтр у сервісі (обидва прапори незалежні). Тест: прокидання + 400 на не-UUID + deps у useEffect модалки.
**Severity:** MEDIUM (UX false-positive).

### 2026-06-09 — Read-only DTO degraded-form → contract drift (Bug #398) — backend / contract drift

**Сигнал:** локальний `toDtoSimple()`/`mapBriefly()` повертає той самий тип без enrichment → optional поля undefined → TS green → майбутній рендер деталей broken.

```bash
grep -rn "const toDto[A-Z]\w* = " apps/api/src/modules --include="*.service.ts" -A2
```

**Фікс:** `this.toDto(s)`; публічний endpoint → окремий `PublicXDto`; розширити CONFLICT_SELECT/SEARCH_SELECT.
**Severity:** MEDIUM (latent regression).

### 2026-06-09 — Swallowed-fetch mapped to empty-state у read-only panel (Bug #414) — frontend / error handling

**Сигнал:** `<LinkedDocumentsPanel>` `.catch((e)=>setData(emptyShape))` → 500/network=«немає документів» → UX false reassurance (user приймає рішення «створимо рахунок бо немає активного»).

```bash
grep -rn "\.catch.*=>" apps/web/src/components/ui apps/web/src/app --include="*.tsx" -A2 | grep -B1 "setData\|setItems"
```

**Фікс:** окремий `error` state + `if(error)return <ErrorBanner/>` + Retry (bumps retryKey у deps).
**Severity:** MEDIUM.

### 2026-06-09 — Cross-endpoint status-filter inconsistency (Bug #415) — backend / API contract

**Сигнал:** `findByWorkOrder` має `status:{not:CANCELLED}`, `getLinked/getCounts` — БЕЗ → badge count N+1 над мертвим записом.
**Фікс:** уніфікувати `where.status` через усі service-методи модуля; import enum з `@prisma/client` (TS ловить typo). Regression: contract «WO 1 CANCELLED+1 DRAFT→counts.X===1».
**Severity:** LOW (UX); MEDIUM якщо призводить до помилкового рішення. Парне #401.

### 2026-06-09 — Inner $tx re-check spec для Serializable race fix (Bug #416, paired #412) — backend / test coverage

**Сигнал:** `$transaction({Serializable})` з inner `tx.X.findFirst` re-check — spec має один constant `mockResolvedValue`, не двічі → видалення re-check блоку пройде CI.
**Фікс:** `mockResolvedValueOnce(null).mockResolvedValueOnce({id})` + `expect(prisma.X.create).not.toHaveBeenCalled()` (ключовий assert).
**Severity:** MEDIUM (regression risk для CRITICAL race fix).

### 2026-06-09 — Concurrent-create race «1 active per parent» без unique index (Bug #412) — backend / concurrency

**Сигнал:** `find existing→if(existing)throw→create` (FK `Invoice.workOrderId`, `FiscalReceipt.paymentId`) БЕЗ `$transaction({Serializable})` АБО `@@unique` partial → 2 паралельних POST обидва бачать null → 2 invoice.

```bash
grep -rnE "async (create|createFrom|issueFor|generateFor)[A-Z]" apps/api/src/modules --include="*.service.ts"
```

**Фікс:** pre-fetch `docNumbers.next()`, обгорнути read+create у Serializable з inner re-check; map P2034→friendly BadRequest. `DocumentNumberService.next()` серіалізує по docType, НЕ по parent FK. Spec 2-3 кейси (existing→400, status guard→400, non-existent→404).
**Severity:** HIGH (фінансовий).

### 2026-06-09 — Sibling-panel stale state після parent action (Bug #409) — frontend / state staleness

**Сигнал:** «Документи» tab відкритий → footer «Виставити рахунок»→toast.success→tab показує старий список.

```bash
grep -rnE "useEffect\(.*\[[a-zA-Z]+Id\]" apps/web/src/components/ui --include="*.tsx" -B5 -A10 | grep -B12 "apiFetch"
```

**Фікс:** prop `refreshKey?:number`→useEffect deps `[parentId,refreshKey]`+parent increment після успіху; ОБОВ'ЯЗКОВО `setPreview(null)` у тому ж useEffect. Regression: render→fetch1→rerender bumped refreshKey→fetch2 (2 apiFetch).
**Severity:** MEDIUM; HIGH для critical financial panels.

### 2026-06-09 — Alternate-mutation endpoint обходить canonical guards (Bug #403, #444) — backend / FSM enforcement / capacity invariants

**Сигнал:** `refreshFromWorkOrder`/`syncFromX`/`recalculateZ`/`syncWorkOrderSlots` мутує той самий resource без guards `update()`: (а) FSM `if(X.status!==DRAFT)throw`; (б) **capacity/conflict probe** (#444: slot write має перевіряти overlap на тому ж lift/employee — інакше double-booking); (в) `isLocked/isSystem`. Або `deleteMany+createMany` full-overwrite без parent status-check.

```bash
grep -rnE "async (refresh|sync|import|recalculate|regenerate|rebuild)[A-Z]" apps/api/src/modules --include="*.service.ts"
```

**Фікс:** скопіювати ВСІ `if(...)throw`+conflict-check з canonical `update()`. Regression: mock conflict-row→throw+`expect(updateMany).not.toHaveBeenCalled()`.
**Severity:** CRITICAL (FSM перезаписує SENT/PAID); HIGH (capacity overlap→double-booking).

### 2026-06-09 — FE status-whitelist асиметрія з backend (Bug #401) — frontend / UX

**Сигнал:** `const canShare=[...].includes(status)` — масив ≠ backend `SHAREABLE_STATUSES`. FE⊃BE→400 (HIGH); FE⊂BE→silent обмеження (MEDIUM). Backend=джерело правди.

```bash
grep -rnE "const can(Share|Edit|Delete|Reserve|Transition)\s*=" apps/web/src --include="*.tsx" --include="*.ts"
grep -rnE "(SHAREABLE|EDITABLE|DELETABLE|RESERVATION_ACTIVE)_STATUSES\s*[:=]" apps/api/src/modules --include="*.ts"
```

**Фікс:** дзеркалити BE. Regression: contract кожен статус з BE→200; поза масивом→400.
**Severity:** HIGH якщо FE обіцяє кнопку→400.

### 2026-06-09 — ID-namespace contract mismatch FE↔BE "silently ignore" (Bugs #396, #399) — full-stack / data loss

**Сигнал:** FE надсилає `itemId`, backend очікує `lineId` — whitelist:true мовчки ігнорує → «успішна» операція без ефекту.
**Фікс:** порівняти body apiFetch POST з DTO fields контролера.
**Severity:** HIGH (silent data loss).

### 2026-06-09 — Soft-delete primary без auto-promote next sibling (Bugs #351, #398) — backend / business invariant

**Сигнал:** `remove()` для `isPrimary/isDefault` не promote-ить наступного sibling → downstream auto-selection повертає неправильні.

```bash
grep -rnE "isPrimary\s+Boolean|isDefault\s+Boolean|isMain\s+Boolean" packages/database/prisma/schema/*.prisma | awk '{print $1}'
```

**Фікс:** `$transaction`: soft-delete X; `if(existing.isPrimary)findFirst({<scope>,deletedAt:null,id:{not:id}},orderBy:{createdAt:'asc'})→update({isPrimary:true})`.
**Severity:** HIGH. Парне #226-#227 (frontend refetch).

### 2026-06-09 — Stale URL-serialization test після backend-compat fix (Bug #390) — frontend / test drift

**Сигнал:** `fix: remove [] suffix` змінює URL params, `*.test.tsx` ще асертить `categoryIds%5B%5D=`. `.toContain` фейлиться, повідомлення виглядає як component-bug.

```bash
git diff HEAD~3 HEAD -- 'apps/web/src/**/*.tsx' | grep -E "^\+.*params\.(append|set)\b" | grep -v test
```

**Фікс:** оновити assertion + `expect(url).not.toContain('<old-form>')` negation guard.
**Severity:** CRITICAL коли весь web suite червоний (release-blocker). Парне §1.5 #163.

### 2026-06-08 — Imperative .focus()/.scrollIntoView() на conditionally-rendered ref (Bug #386) — frontend / UX

**Сигнал:** `xxxRef.current?.focus()` у click handler де ref = `{cond&&<input ref={xxxRef}/>}` — handler змінює state-умову → focus ДО React commit → ref null → focus loss.

```bash
grep -rnE "[a-zA-Z]Ref\.current\?\.(focus|select|scrollIntoView|click)" apps/web/src/components/ui --include="*.tsx" -B3
```

**Фікс:** `requestAnimationFrame(()=>xxxRef.current?.focus())` або declarative `useEffect([cond])`. Regression: `await user.click(clearBtn); expect(input).toHaveFocus()`.
**Severity:** LOW (UX) до HIGH (`.scrollIntoView` у list-modal).

### 2026-06-08 — Soft-delete remove() не каскадить на 1:1 @unique related table (Bug #373) — backend / soft-delete

**Сигнал:** `parent.remove()` soft-delete parent, `@unique(FK)` таблиця не soft-deleted → `create()` нового батька→P2002.

```bash
grep -rn "@@unique" packages/database/prisma/schema/*.prisma | grep -v "orgId,"
```

**Severity:** HIGH.

### 2026-06-08 — seed.ts залежить від іншого seed-скрипту (Bug #377) — db / seed orchestration

**Сигнал:** `seed.ts` використовує дані з таблиці що заповнюється `seed-catalog.ts` (не авто) → RuntimeError у CI.
**Фікс:** об'єднати або `seedCatalog()→seedMain()` orchestration.
**Severity:** MEDIUM.

### 2026-06-08 — Controlled <select value> default ігнорує dynamic option filter (Bug #378) — frontend

**Сигнал:** `value={form.X}` де options фільтруються по parent → зміна parent → `form.X` не існує у нових options → порожній вибір без reset.
**Фікс:** `useEffect([parent],()=>{if(!options.find(o=>o.id===form.X))setForm(f=>({...f,X:''}))})`.
**Severity:** MEDIUM.

### 2026-06-06 — Sibling-handler pattern miss (Bug #370) — frontend

**Сигнал:** `fix(review)` виправив один з 2-3 парних handlers (handleCreate/handleUpdate/handleDelete). Решта той самий патерн.

```bash
grep -n "handle(Create|Update|Delete|Restore)" <file>   # після review-fix перевірити кожен
```

**Severity:** успадковує severity original.

### 2026-06-06 — Mask wrapper re-extracts digits із форматованого prefix (Bug #369) — frontend / controlled-input

**Сигнал:** PhoneInput iterative typing → `+38 (380)...` замість `+38 (038)...` — `replace(/\D/g,'')` витягує prefix `+38 (` разом з input. One-shot paste ok, iterative fails silently → невалідний номер у БД.

```bash
grep -rn "e\.target\.value\s*=\s*" apps/web/src/components/ui --include="*.tsx"
```

**Фікс:** `applyMask(v)` strip фіксований prefix перед digit-extraction. Regression: `it('iterative typing matches one-shot paste')`+`it('idempotency applyMask(applyMask(x))===applyMask(x)')`.
**Severity:** HIGH (silent data corruption, backend приймає 10 цифр).
**Де ще:** майбутні CardNumberInput/IBANInput/VinInput/EDRPOUInput.

### 2026-06-06 — Cascade-clear stale linked FK при зміні parent picker (Bugs #365, #367) — frontend / form-state

**Сигнал:** обрав counterparty→vehicle→змінив counterparty→`vehicleId` лишається від попереднього.

```bash
# <EntityPickerField.*onChange → чи setForm(f=>({...f,parentFk,childFk:''}))
```

**Severity:** HIGH (FK з іншої org→cross-tenant/404).

### 2026-06-15 — Orphan affordance UI: toggle/button без consumer-а після dead-code cleanup (Bugs #504, #505, #341 sub) — frontend / UX

**Сигнал:** review-fix видалив dead state + render-компонент, але лишилась **affordance**: `<Toggle enabled={x.enabled} onToggle={x.toggle}/>`, hotkey, command palette — керує hook/state що НІЧОГО не контролює. tsc/тести green, натиск→нічого (або localStorage без ефекту).

```bash
grep -rln "DetailPanel\b\|DetailPanelToggle\|<XPanel" apps/web/src/app/\(app\)
grep -rnE "<DetailPanelToggle |hotkey:|cmdK:|<MinimizeButton" apps/web/src --include="*.tsx"
```

**Фікс:** видалити affordance разом з destructure; якщо мертвий лише у деяких файлах — тільки у dead. НЕ «TODO: відновити». Regression: vitest snapshot JSX.
**Severity:** MEDIUM; LOW hotkey без hint; HIGH якщо affordance=key feature.
**Де ще:** shared hook з toggle-state (useDetailPanel, useColumnsConfig, useSavedFilters, useBulkSelect); command-palette до неіснуючої сторінки (#354); hotkey що змінює state не у JSX.

### 2026-06-15 — Backend stale-FK cleanup у service.update() (Bug #473, #477, paired #365/#367 frontend) — backend / data-integrity

**Сигнал:** `update()` приймає `dto.parentFkId` (supplierId/counterpartyId) АЛЕ FE забуває dependent child FK (contractId) у PATCH → backend silent-keep старий child → cross-parent orphan (`po.contract.counterpartyId !== po.supplierId`). P2003 не спрацює (self-org).

```bash
grep -nE "findFirst.*select:.*{(\s|$)" apps/api/src/modules/<resource>/<resource>.service.ts -A5 | grep -E "Id:\s*true"   # SELECT має BOTH
```

**Фікс:** SELECT parent+ВСІ dependent FK; `parentChanged=dto.parentId!==undefined && dto.parentId!==po.parentId`; child FK 4 гілки: (a) string→validate проти `effectiveParentId=dto.parentId??po.parentId`; (b) null→clear; (c) `parentChanged&&po.childFkId`→auto-clear stale; (d) keep. DTO `child?:string|null` з `@ValidateIf @IsUUID`+`@Transform(emptyToUndefined)`. Regression: (b)(c)(d) окремо; (#477) contract `PATCH {childFkId:null}→200`.
**Severity:** HIGH (silent cross-parent corruption).
**Де ще:** WorkOrder.update (counterpartyId+vehicleId), Invoice.update (counterpartyId+workOrderId+paymentMethodId), StockDocument, SettlementService.transferTransaction, PurchaseOrder ✅(#473), SupplierPayment ✅(#588), CounterpartyContract, Appointment.

### 2026-06-06 — Toggle callback виконує full open-logic при CLOSING (Bug #364) — frontend / callback design

**Сигнал:** `onToggle(open)` при `open=false` виконує open-логіку (reset/fetch) замість cleanup.
**Grep:** `grep -rn "onToggle\|onOpenChange\|onClose" apps/web/src --include="*.tsx" -A5 | grep "fetch\|reset\|load"`.
**Фікс:** `if(!open)return;`.
**Severity:** MEDIUM.

### 2026-06-06 — Soft string FK без validation (Bugs #359, #361) — backend / data-integrity

**Сигнал:** DTO `currencyCode:string` (Prisma plain `String`) без `findFirst({orgId,code:dto.currencyCode})` → `'XYZ'` проходить → DB corrupted (`1 000.00 XYZ`). Guard у БОТКИ create+update (PATCH attack).

```bash
grep -rnE "String\s*$|String\s+@db\.VarChar" packages/database/prisma/schema/*.prisma | grep -iE "code|type|status"
```

**Severity:** HIGH. Regression: `POST {code:'INVALID'}→400`.

### 2026-06-06 — Auto-create child ignores parent settings inheritance (Bug #360) — backend / business-logic

**Сигнал:** `tx.Contract.create({data:{currencyCode:'UAH'}})` hardcoded замість `OrganisationSettings.currency`.

```bash
grep -rnE "tx\.[a-z]+\.create\(\s*\{\s*data:\s*\{[^}]*\b(currencyCode|currency|paymentDeferDays|warrantyDays|slotDurationMinutes):" apps/api/src/modules --include="*.service.ts"
```

**Фікс:** fetch `organisationSettings.findUnique({where:{orgId}})` ПЕРЕД `$transaction` (Promise.all з documentNumberService.next), передати у create.data.
**Severity:** HIGH (порушує UX-tooltip інваріант).

### 2026-06-06 — Case-sensitive lookup vs canonical-form (Bug #359) — backend / DTO normalization

**Сигнал:** `findFirst({code:dto.currencyCode})` — user `'uah'`, БД `'UAH'` → 400 з валідним кодом (Postgres case-sensitive).

```bash
grep -rnE "findFirst\(\s*\{\s*where:\s*\{[^}]*\b(code|type|status):\s*dto\." apps/api/src/modules --include="*.service.ts"
```

**Фікс:** `@Transform(toUpperCurrencyCode)`/`@Transform(toLowerCase)` у DTO + `<Input onChange={e=>set(e.target.value.toUpperCase())}>`.
**Severity:** HIGH (valid input→400→perceived broken).

### 2026-06-05 — Dead /X/new маршрут у keyboard shortcut / Command Palette (Bug #354) — frontend / routing

**Сигнал:** `router.push('/<resource>/new')` але `new/` dir не існує → `[id]` ловить `'new'` як id → broken detail.

```bash
grep -rn "router\.push('/[^']*/new')\|href:\s*'/[^']*/new'" apps/web/src --include="*.ts" --include="*.tsx"
# test -d apps/web/src/app/(*)/<resource>/new
```

**Фікс:** `?action=new` query + `useSearchParams` + `<Suspense fallback={null}>` (Next.js static-export).
**Severity:** HIGH (feature broken).

### 2026-06-05 — TanStack Query queryKey shape mismatch: helper vs factory vs prefetch (Bugs #355-#356) — frontend / react-query

**Сигнал:** `usePaginatedList({queryKey:'X'})` будує `[key,filters]` але factory `xKeys.list(f)=[...xKeys.all,'list',filters]` (3-element) → різні cache slots → prefetch не hit. Або TopShell prefetch пропускає sortBy/dateFrom/специфічні фільтри.

```bash
grep -rn "queryKey:\s*\[.*filters\]" apps/web/src/hooks/api/ --include="*.ts"   # без 'list' = bug
```

**Фікс:** hook `queryKey:[key,'list',filters]`; TopShell PREFETCH_MAP оновлюється з кожним новим фільтром сторінки. Preferable: `defaultXFilters()` з hook-файлу, обидві сторони з неї. Regression: `qc.getQueryCache().getAll()`→`cache.length===1`.
**Severity:** MEDIUM (prefetch silent miss).

### 2026-06-04 — Hardcoded document-number обходить DocumentNumberService (Bug #348) — backend / bizlogic

**Сигнал:** `tx.Contract.create({data:{number:'<literal>'}})` замість `documentNumberService.next()` (модель у DocumentNumberConfig seed).

```bash
grep -rnE "tx\.[a-z]+\.create\(\s*\{\s*data:\s*\{[^}]*\bnumber:\s*['\"]" apps/api/src/modules --include="*.service.ts"
```

**Фікс:** `documentNumberService.next()` ПЕРЕД `$transaction` (next() сам відкриває $tx з SELECT FOR UPDATE — nesting deadlock).
**Severity:** HIGH (monotonic numbering порушена).

### 2026-06-03 — Stale contract-spec: arg-count drift після нового query-param (Bug #340) — backend / contract tests

**Сигнал:** controller `service.findAll(orgId,...,query.NEW)` — `toHaveBeenCalledWith(orgId,...8 args)` ламається при 9. tsc green (варіадичне передавання).

```bash
git diff HEAD~N HEAD -- "*.controller.ts" | grep -E "^\+.*service\.findAll\(.*\bquery\.[a-zA-Z]+\b"
```

**Фікс:** додати `undefined` для нових. Preferable: передавати **об'єкт** `{page,...,sortBy}` замість positional (нові поля не ламають `expect.objectContaining`).
**Severity:** MEDIUM (red baseline).

### 2026-06-03 — Stale mock після додавання cascade-helper у service (Bug #340b) — backend / test-coverage

**Сигнал:** review-fix додав `getDescendantIds()` у service-метод → spec ловить `TypeError: X is not iterable` (findMany у helper не замокано).

```bash
git diff HEAD~N HEAD -- "*.service.ts" | grep -E "^\+.*await this\.(getDescendantIds|getAncestorIds|getLinkedX|cascade)"
```

**Фікс:** `prisma.<model>.findMany.mockResolvedValueOnce([])` ПЕРЕД викликом.
**Severity:** MEDIUM. Парне #200.

### 2026-06-03 — Review-fix completeness: крос-файловий патерн частково виправлений (Bug #341) — frontend

**Сигнал:** `fix(review): replace X with Y` чіпає N файлів — є ще M з тим самим патерном поза scope.

```bash
git show --stat <last-review-commit> -- '*.tsx' '*.ts'   # той самий grep-pattern по ВСЬОМУ codebase без file-filter
```

Типові пропуски: `[id]/PageClient.tsx`, `*Tab.tsx`, sub-components, shared hooks/lib. Виняток (легітимні): toast-double-protection, optional PWA SW, fire-and-forget telemetry — з парним user-feedback каналом.
**Severity:** успадковує original.

### 2026-06-03 — Нові query-param фільтри без contract-spec coverage (Bugs #338, #339) — backend / contract tests

**Сигнал:** `QueryDto` отримав нові поля (dateFrom/branchId), contract spec не перевіряє forwarding.

```bash
git diff HEAD~5 HEAD --name-only | grep "\.dto\.ts$"   # для кожного QueryDto → spec coverage нових
```

**Severity:** MEDIUM.

### 2026-06-03 — Bool prop early-return у useEffect: обидві гілки потребують test (Bug #336) — frontend / hooks

**Сигнал:** `useEffect(()=>{if(!enabled){cleanup();return;}init();},[enabled])` — тест лише `enabled=true`.
**Фікс:** тест `enabled=false` (`expect(cleanup).toHaveBeenCalled()`).
**Severity:** MEDIUM (інверсія `!enabled`↔`enabled` проходить зеленою).

### 2026-06-03 — Animation hook без tests + CSS marker contract (Bugs #332-#335) — frontend / animation

**Сигнал:** `useAnimatedPresence` без `*.test.ts`; CSS `[data-animate][data-state="open"]` без assertion що атрибут на правильному елементі. Плюс rAF-dance `setVisible(true);requestAnimationFrame(()=>setState('open'))` → 1-frame paint at previous state (flicker).

```bash
grep -nE "\[data-[a-z]+\](\[data-[a-z]+\=)?" apps/web/src/app/globals.css   # кожен data-* selector → assertion у *.test.tsx
grep "requestAnimationFrame.*setState\(" apps/web/src/hooks/use*.ts
```

**Фікс:** integration-test `expect(dialog).toHaveAttribute('data-animate')`+`data-state=open`+`querySelector(':scope > [data-backdrop]')`. rAF: `useLayoutEffect`+`setState('open')` без rAF (CSS `fill-mode:both`) або `data-just-mounted`.
**Severity:** LOW (visual jank).

### 2026-06-02 — Coefficient-zero у нових UoM endpoints (Bug #312) — backend+frontend

**Сигнал:** `coefficient?:number` без `@Min(0.0001)` → 0 → division by zero.

```bash
grep -rn "coefficient" apps/api/src/modules --include="*.dto.ts" | grep -v "@Min\|@IsPositive"
```

**Severity:** HIGH.

### 2026-06-02 — window.confirm замість useConfirm (Bug #313) — frontend / UX

```bash
grep -rn "window\.confirm" apps/web/src --include="*.tsx"
```

**Фікс:** `const confirm=useConfirm(); await confirm({...})`. **Severity:** LOW.

### 2026-06-02 — Reusable UI компонент без type="button" (Bug #314) — frontend / a11y

```bash
grep -rn "<button" apps/web/src/components/ui --include="*.tsx" | grep -v "type="
```

**Severity:** MEDIUM (при вбудові у форму→submission).

### 2026-06-02 — Promise.all для reference data без AbortController (Bug #315) — frontend / memory

**Сигнал:** `useEffect(()=>{Promise.all([apiFetch(A),apiFetch(B)]).then(set)},[])` без cleanup → memory leak.
**Фікс:** `const ac=new AbortController();...return ()=>ac.abort()`.
**Severity:** MEDIUM.

### 2026-06-02 / 2026-09-04 — Toggle-state UI desync: highlight/cursor/selection без enabled-gate (Bugs #310-#311, #624 sub) — frontend / UI

**Сигнал:** `selectedX?.id===item.id&&'bg-secondary'` рендериться після `detailPanel.toggle()`→`enabled=false` але selectedX non-null. Варіант #624: список з ref-based toggle-close (`selectedXIdRef`) — при disable скидається лише ВИДИМІСТЬ (`open={...&&enabled}`), ref/state лишаються → після re-enable клік по ТОМУ Ж рядку→`selectX` бачить `ref.current===row.id`→toggle-close→no-op (панель не з'являється). tsc/unit green — ловиться ЛИШЕ E2E off→on-цикл-кліком.

```bash
grep -rnE "selected[A-Z][a-zA-Z]*\?.id\s*===\s*[a-z]+\.id\s*&&\s*'bg-" apps/web/src/app --include="*.tsx" | grep -v "detailPanel\.enabled\|enabled &&"
grep -rnE "selected[A-Z]\w*IdRef" apps/web/src/app --include="*.tsx"   # #624
```

**Фікс:** `&& detailPanel.enabled` до КОЖНОЇ affordance class (cursor+highlight+hover); АБО `useEffect(()=>{if(!enabled){selectedXIdRef.current=null;setSelectedX(null);}},[enabled])` (синхронно скинути ОБА). Симетрія: одне gated→друге теж. E2E-цикл: клік рядка→тогл off→on→клік ТОГО Ж рядка→панель має відкритись (не `toHaveCount` — width-collapse лишає DOM; assert стан тогла/скрін).
**Severity:** MEDIUM (stale highlight); LOW cursor-only.
**Де ще:** будь-який список з selection persist окремо від enabled-toggle + клік-по-вибраному=закрити (purchase-orders). Playwright `toBeVisible` false-positive на `w-0 overflow-hidden`.

### 2026-06-02 — Multi-module sprint: pattern dilution між модулями (Bug #306) — backend

**Сигнал:** sprint додає soft-delete до N модулів — деякі пропускають `@@unique` partial filter/resurrection.
**Правило:** після multi-module sprint — grep ВСІХ нових модулів на повний pattern checklist.
**Severity:** HIGH (P2002 при re-create).

### 2026-06-02 — Soft-delete filter pill chicken-and-egg (Bug #295) — frontend / UX

**Сигнал:** `{deletedCount>0||showDeleted?<Toggle/>:null}` — count=0 поки `showDeleted=false`→Toggle не рендериться→архів недосяжний.

```bash
grep -rnE "(deleted|archived|hidden|removed)Count\s*>\s*0\s*\|\|" apps/web/src/app --include="*.tsx"
```

**Фікс:** Toggle завжди видимий; count лише коли `showDeleted=true`.
**Severity:** CRITICAL (feature недосяжна без URL hack).

### 2026-06-02 — Postgres NULLS LAST ламає sort по nullable soft-delete (Bug #296) — backend / Prisma

**Сигнал:** `orderBy:{deletedAt:'asc'}`→NULL (активні) в кінець→видалені перед активними.

```bash
grep -rn "orderBy.*deletedAt.*['\"]asc['\"]" apps/api/src/modules --include="*.service.ts" | grep -v "nulls"
```

**Фікс:** `{deletedAt:{sort:'asc',nulls:'first'}}` (активні зверху). Для FEFO expiryDate: `nulls:'last'`.
**Severity:** HIGH.

### 2026-06-02 — Soft-delete + @@unique без partial filter = P2002 (Bugs #297, #298, #305, #152, #151) — backend

**Сигнал:** `@@unique([orgId,X])` без `deletedAt` partial → `create()` повторний→P2002. `update()` re-check `findFirst({orgId,field,NOT:{id}})` без `deletedAt:null` (для дублю); `restore()` без prep-check active duplicate.

```bash
grep -n "@@unique" packages/database/prisma/schema/*.prisma
grep -rn "CREATE UNIQUE INDEX" packages/database/prisma/migrations/ | grep -v "WHERE"
```

**Фікс:** create resurrection `findFirst({NOT:{deletedAt:null}})→update({...dto,deletedAt:null})`. update re-check (#297): НЕ фільтрувати `deletedAt:null`; якщо `duplicate.deletedAt!=null`→`ConflictException('...існує у архіві. Спочатку відновіть.')`. restore (#298,#305): prep-check active duplicate→ConflictException; `if(existing.isSystem)throw` (системні не мають бути soft-deleted). update unique-поле (#151): `findFirst({orgId,field,NOT:{id}})→ConflictException`.
**Severity:** HIGH (P2002 500).

### 2026-06-01 — Optional numeric DTO field з тільки @IsOptional() (Bug #283) — backend / validation

```bash
grep -rn "?: number\b" apps/api/src/modules --include="*.dto.ts"   # перевірити @IsInt/@IsNumber/@Min/@Max/@Type(()=>Number)
```

**Сигнал:** class-validator без type-decorator пропускає string/Infinity/негативні/floats у Int. Особливо weight/quantity/limit/page/percent/days/year. Regression: POST `"abc"`/`-1`/`99999999`/`2.5`→400.
**Severity:** HIGH (runtime crash / data corruption).

### 2026-06-01 — Stale .next/ cache після route group рефакторингу (Bug #291) — infra

**Сигнал:** переміщення `app/X/page.tsx`→`app/(group)/X/page.tsx`→webpack chunk-id mismatch→CRITICAL 500→React не гідрується→auth guards не виконуються.

```bash
git diff HEAD~5 HEAD --name-status | grep -E "^R.*app/.*page\.tsx"   # → rm -rf apps/web/.next apps/web/tsconfig.tsbuildinfo
curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/_next/static/chunks/main-app.js
```

**Severity:** CRITICAL.

### 2026-06-02 — ?? 1 не ловить 0 від БД-дільника (Bug #316) — backend / defense-in-depth

**Сигнал:** `coefficient ?? 1` — `coefficient=0` у БД→division by zero (`??` ловить лише null/undefined).

```bash
grep -rn "coefficient ?? 1\|denominator ?? 1" apps/api/src --include="*.ts"
```

**Фікс:** `coefficient || 1` або `coefficient>0?coefficient:1`. Парне: `CHECK (coefficient>0)`.
**Severity:** HIGH.

### 2026-06-02 — isSystem-guard у update()/remove() (Bugs #319-#320) — backend / business-rule

**Сигнал:** сутність з `isSystem Boolean` (seed: WorkCategory/GoodCategory/UnitOfMeasure/NotificationTemplate/PaymentMethodConfig/Currency) — `update()` має `if(existing.isSystem && (dto.name!==undefined||dto.parentId!==undefined||dto.code!==undefined))throw`; `remove()`→`if(existing.isSystem)throw`. Косметичні (sortOrder/icon/isActive) дозволені. UI ховає кнопки — backend авторитет (ADMIN curl PATCH/DELETE системну).

```bash
grep -rn "isSystem\s*Boolean" packages/database/prisma/schema/*.prisma
grep -rn "isSystem: true" packages/database/prisma/seed.ts   # звірити з grep -rln "existing.isSystem" apps/api/src/modules → різниця=незахищені
```

**Coverage-gap:** split-coverage — guard був у UnitOfMeasure/WorkCategory/GoodCategory, відсутній у Currency+PaymentMethodConfig. **Frontend-coupling:** «reject-if-present» guard (`if(dto.name!==undefined)throw`) реджектить НАЯВНІСТЬ поля → FE що PATCH-ить незмінений immutable-field системного→спурінний 400; фікс — **ОМІТити immutable-поля з PATCH-body** (`body={...(isSystem?{}:{name,code}),...editable}`), не лише `disabled`. **Міграція:** нова `isSystem`-колонка потребує backfill (`UPDATE ... SET isSystem=true WHERE code IN (...)`). Contract 4 кейси: PATCH system {name}→400; {parentId}→400; {sortOrder}→200; DELETE→400.
**Severity:** HIGH (system seed corrupted via API).
**Де ще:** TaxRate, DocumentNumberConfig, NotificationTemplate, PaymentMethodConfig, Currency, UnitOfMeasure, Work/GoodCategory → guard + frontend-omit у Tab.

### 2026-06-02 — refetch-callback (onChanged) без race-guard (Bug #323) — frontend / race-condition

**Сигнал:** `<CategoryManagerModal onChanged={()=>loadCategories()}/>` без cancelled-flag→setState on unmounted.

```bash
grep -rn "onChanged\|onUpdated\|onCreated" apps/web/src/app --include="*.tsx" -A2 | grep "load\|fetch"
```

**Severity:** MEDIUM.

### 2026-06-03 — Literal []/{} як аргумент до custom hook (Bug #328) — frontend / React anti-pattern

**Сигнал:** `useX(filters,[])`→нова reference кожен render→`useEffect([deps,[]])` infinitely.

```bash
grep -rnE "use[A-Z]\w*\(.*\[\]|\{\}\s*\)" apps/web/src/app --include="*.tsx"
```

**Фікс:** `const EMPTY=useMemo(()=>[],[])`.
**Severity:** HIGH (infinite re-render).

### 2026-06-03 — Stale closure у useCallback з eslint-disable exhaustive-deps (Bug #330) — frontend / hooks

**Сигнал:** `useCallback(()=>apiFetch(url,{body:data}),[])` з `eslint-disable`→stale closure.

```bash
grep -rn "eslint-disable.*exhaustive-deps" apps/web/src --include="*.tsx" --include="*.ts"
```

**Severity:** HIGH (stale data у mutation).

### 2026-06-04 — BullMQ processor без idempotency guard (Bug #346) — backend / BullMQ

**Сигнал:** `@Process` з `fetch(externalApi)`+`attempts>1` БЕЗ перевірки `existingResult`→retry дублює (2 SMS, 2 чеки).

```bash
grep -rn "async handle" apps/api/src/modules --include="*.processor.ts" -l | while read f; do grep -q "fetch(\|axios\." "$f" && ! grep -q "findFirst\|findUnique" "$f" && echo "MISSING idempotency: $f"; done
```

**Фікс:** читати DB-запис ПЕРЕД external call, перевірити результат вже записаний (`fiscalReceiptId`/`sentAt`). Regression: `it('пропускає якщо result-field вже встановлено')`+`it('пропускає якщо запис не знайдено')`.
**Severity:** MEDIUM (ПРРО fiscal compliance); LOW webhook retry.

### 2026-06-05 — Stable callback identity invariant у composable hooks — frontend / hooks

**Сигнал:** `useCallback(()=>...,[])` у composable hook без regression-guard identity. eslint --fix що додасть `[setPage]` каскадно перестворює consumers' useCallback.

```bash
grep -rn "useCallback(.*, \[\])" apps/web/src/hooks --include="*.ts" | grep -v test
```

**Фікс-тест:** `const first=result.current.cb; rerender(); expect(result.current.cb).toBe(first); act(()=>setter(N)); expect(cb).toBe(first)`.
**Severity:** MEDIUM (perf cascade).

### 2026-06-05 — new Date(`${date}T${time}:00`) без TZ суфіксу (Bugs #354, #358) — frontend / timezone

**Сигнал:** FE парсить як local замість UTC→3-year drift.

```bash
grep -rnE "new Date\(\`\$\{[^}]*\}T\$\{[^}]*\}:00\`\)" apps/web/src/app --include="*.tsx"
```

**Фікс:** `localDateTimeToISO(date,time)` з `apps/web/src/lib/format.ts`.
**Severity:** HIGH.

### 2026-06-05 — Boolean-flag (isPrimary/isDefault) без unset previous (Bug #357) — backend

**Сигнал:** `create({isPrimary:true})` без `updateMany({where:{isPrimary:true},data:{isPrimary:false}})`→кілька primary.

```bash
grep -rn "isPrimary.*true\|isDefault.*true" apps/api/src/modules --include="*.service.ts" | grep -v "updateMany"
```

**Фікс:** у `$transaction`: спочатку `updateMany` unset, потім create/update.
**Severity:** HIGH.

### 2026-06-08 — Multi-row form: дублікат/pre-validate/half-typed row (Bugs #382, #383, #384) — frontend / UX / data-loss

**Сигнал:** #382 `addRow()` дозволяє той самий goodId двічі→duplicate movements (`if(rows.some(r=>r.goodId===newRow.goodId))return`). #383 submit batch POST без front-validation→partial-create без указання failed row (`rows.forEach((r,i)=>{if(!r.quantity||r.quantity<=0)throw \`Рядок ${i+1}: кількість обов'язкова\`})`). #384 `rows.filter(r=>r.goodId&&r.quantity>0)`→half-typed row мовчки пропускається (`if(rows.some(r=>r.goodId&&!r.quantity))confirm("Незаповнені рядки будуть пропущені")`).
**Severity:** MEDIUM (#384 data-loss без feedback).

### 2026-06-17 — Public DTO leak whitelist test (Bug #530) — backend / security / regression-guard

**Сигнал:** public endpoint (share-token) повертає DTO через manual `parts.map(p=>({...whitelist}))`. Захист тримається на тому що автор НЕ написав `{...p}` spread. TS не ловить (`parts!:Dto[]` не валідує runtime). Ризик: `{...p,computed}` шортчат або `include:{warehouse:true}`→leak (`costPrice`,`batchCostPrice`,`paidAmount`,`orgId`,`syncVersion`).

```bash
grep -rn "@Public\|@Get.*share\|@Get.*public" apps/api/src/modules --include="*.controller.ts"
# handler НЕ має: parts.map(p=>({...p})) spread; include:true
```

**Фікс:** `<resource>.share-public.spec.ts` (hasOwnProperty ловить ключ навіть з undefined):

```ts
expect(Object.prototype.hasOwnProperty.call(part, 'costPrice')).toBe(false);
expect(Object.keys(part).sort()).toEqual(
  ['amount', 'goodName', 'id', 'price', 'quantity', 'unitShortName'].sort(),
);
expect(Object.prototype.hasOwnProperty.call(dto, 'orgId')).toBe(false); // + paidAmount, syncVersion
```

**Severity:** HIGH public; MEDIUM authenticated (RBAC).
**Де ще:** кожен `@Public()` з aggregate+вкладеними: WorkOrder estimate share ✅, Invoice public viewer, Counterparty public profile.

### 2026-06-17 — Defensive take/limit cap regression-guard (Bug #531) — backend / perf / regression-guard

**Сигнал:** `findMany` з `take:N` cap (defense проти unbounded). Без regression-guard refactor видалить `take`→OOM або знизить→silent truncation.

```bash
grep -rnE "take: (100|500|1000)\b" apps/api/src/modules --include="*.service.ts" | grep -v "spec\|page"
```

**Фікс:** dedicated `*-cap.spec.ts`:

```ts
expect(callArgs.take).toBe(1000); // exact, НЕ >=
expect(callArgs.where.deletedAt).toBeNull();
expect(callArgs.select).toEqual({/* narrow */});
```

**Severity:** MEDIUM; HIGH якщо cap захищає hot path (recalcTotals у transaction).
**Де ще:** work-orders (recalcTotals ✅), inventory (reserveParts take:1000), purchase-orders (receive bulk), invoices (createFromWorkOrder).

### 2026-06-19 — Constructor DI drift breaks ALL specs of service (Bug #534, #536) — backend / test-infra

**Сигнал:** новий `private readonly newDep:NewService` у constructor без оновлення `*.service.spec.ts`→100% тестів падають `Nest can't resolve dependencies ... NewService at index [N]`. positional-arg specs (`new WorkOrdersService(prisma,null as never,...)`): новий arg зсуває, `null as never` однакові→TS не ловить.

```bash
for f in $(git diff HEAD~5 HEAD --name-only -- 'apps/api/src/modules/**/*.service.ts' | grep -v spec); do git diff HEAD~5 HEAD -- "$f" | grep "^+.*private readonly.*Service$" && echo "$f — verify spec"; done
grep -rn "new [A-Z][a-zA-Z]*Service(" apps/api/src --include="*.spec.ts"   # positional крихкі
pnpm --filter @sto/api test --run 2>&1 | tail -5
```

**Фікс:** (1) `{provide:NewService,useValue:vi.fn().mockResolvedValue(safeDefault)}` (не `{}`→null.method); (2) positional — замінити `null as never` на mock, named comment `null as never, // inventory`; (3) MANDATORY full-suite (@sto/api І @sto/web) у Krok 0 ПЕРЕД commit.
**Severity:** CRITICAL feature-introduced; MEDIUM pre-existing test rot.
**Де ще:** cross-module dep (SettingsService у PurchaseOrders, DocumentNumberService у Goods).

### 2026-06-19 — Migration ADD VALUE без парного INSERT backfill для DocumentNumberConfig (Bug #533) — database / migration

**Сигнал:** commit додає enum `DocumentType` value (`'GOOD_INTERNAL_CODE'`)+`documentNumberService.next(orgId,'<NEW>')`; `seed.ts:docConfigs[]` є, АЛЕ міграція лише `ALTER TYPE ADD VALUE` БЕЗ `INSERT INTO document_number_configs` для існуючих org → prod `next()`→`NotFoundException('Конфігурацію нумерації...не знайдено')`. seed.ts лише при initial setup, не `migrate deploy`.

```bash
grep -l "ADD VALUE.*'GOOD_INTERNAL_CODE'" packages/database/prisma/migrations/*/migration.sql
grep -l "INSERT INTO document_number_configs" packages/database/prisma/migrations/*/migration.sql   # нема INSERT ПІСЛЯ ALTER = bug
```

**Фікс:** окрема migration timestamp +1s (Postgres забороняє INSERT з новим enum у тій же tx що ALTER TYPE):

```sql
INSERT INTO document_number_configs (...) SELECT gen_random_uuid(), o.id, '<NEW>'::"DocumentType", '<prefix>', ..., NOW()
FROM organisations o WHERE NOT EXISTS (SELECT 1 FROM document_number_configs c WHERE c."orgId"=o.id AND c."documentType"='<NEW>'::"DocumentType");
```

Config 1:1 з `seed.ts:docConfigs[]`. Прецеденти: `20260615120100_seed_supplier_return_doc_numbers`, `20260619140001_seed_good_internal_code_doc_numbers`.
**Severity:** CRITICAL (фіча мертва у проді для існуючих orgs).
**Де ще:** seed-керовані enum з config-таблицями: PaymentMethodConfig.code, NotificationTemplate.eventType, TaxRate.rate, CurrencyCode.code.

### 2026-06-20 — Validation message Cyrillic encoding в Zod/class-validator (Bug #537) — frontend / validation / i18n

**Сигнал:** `@Matches` з message-кирилицею обробленою BOM-removal/PowerShell `Set-Content` без `-Encoding utf8`→`'Р¤РѕСЂРјР°С‚...'`→400 з garbled.

```bash
grep -rn "@Matches.*message:\|@MinLength.*message:" apps/api/src/modules --include="*.dto.ts"
# contract: expect(res.json().message).toMatch(/^[А-Яа-яІіЇїЄє0-9\s"():.–—-]*$/)
```

**Фікс:** переписати вручну, UTF-8 БЕЗ BOM.
**Severity:** LOW; MEDIUM якщо ключовий (HH:MM).

### 2026-06-20 — E2E test seed race condition за 30s timeout (Bug #538) — E2E / flaky

**Сигнал:** Playwright всі 3 спроби `toBeVisible({timeout:30_000})`→not found; окремий запуск проходить. Seed у `beforeAll()` через API залежить від DRAFT donor; якщо порожній→clone=null→тест мовчки пропускається (нема `expect(seededId).toBeTruthy()`).

```bash
grep -rn "beforeAll.*async\|seedEstimateWorkOrder\|seedXWorkOrder" apps/web/e2e --include="*.spec.ts"
grep -A5 "beforeAll" "$spec" | grep -E "expect.*toBeTruthy|not.toBeNull" || echo "MISSING GUARD"
```

**Фікс:** `expect(seededId,'beforeAll must seed').toBeTruthy()`; seed логує error (не `return null`); retry-loop max 3 backoff.
**Severity:** LOW-MEDIUM.

### 2026-06-20 — E2E sessionStorage НЕ restored через storageState (Bug #567) — e2e / playwright / sessionStorage-limitation

**Сигнал:** E2E screenshot=login замість сторінки; `getByRole` timeout після `page.goto`. Playwright `storageState` restore-ить лише cookies+localStorage, sessionStorage завжди порожній (tab-scoped). AuthProvider читає token з sessionStorage→null→`refreshToken()`→401→silent LOGOUT.

```bash
cat apps/web/e2e/.auth/admin.json | jq '.cookies | length'   # 0 → refresh fails
```

**Фікс (3-prong):** (1) `setup-auth.ts`: token у `localStorage.sto_e2e_access_token`+`sto_e2e_skip_refresh='1'`+`sto_employee_cache`; (2) AuthProvider reducer init: sessionStorage порожній+`sto_e2e_skip_refresh==='1'`+є `sto_e2e_access_token`→скопіювати ПЕРЕД читанням; (3) useEffect flag+cached→пропустити refresh. Prod не ставить E2E ключі. Обидві сторони escape-hatch мають 2+ matches (§1.3 grep).
**Severity:** CRITICAL — блокує всі захищені E2E.
**Де ще:** frontend з httpOnly refresh cookie + cross-port API + Playwright.

### 2026-06-20 — Node IPv6 default на Windows ламає server-side fetch (Bug #566) — e2e / dns-resolution

**Сигнал:** інтермітентний `ECONNREFUSED ::1:3000` у Playwright `request.newContext()`/Node `fetch()`; браузерні (Chromium dual-stack) працюють. Node 18+ Windows повертає `::1` перед `127.0.0.1`; NestJS `listen(port,'0.0.0.0')` слухає IPv4.

```bash
grep -rn "fetch.*localhost:3000\|request.newContext\|http://localhost:3000" apps/web/e2e/ | grep -v "page.evaluate"
```

**Фікс:** `http://localhost:3000`→`http://127.0.0.1:3000` у server-side fetch; браузерні ОК; або `listen(port,'::')` dual-stack; або webServer.env `NEXT_PUBLIC_API_URL=http://127.0.0.1:3000`.
**Severity:** HIGH (intermittent).
**Де ще:** WatermelonDB sync, BullMQ workers, cross-service HTTP у monorepo dev.

### 2026-06-20 — Sidebar-preview pattern: row click НЕ навігує (Bug #574) — e2e / ux-pattern / list-pages

**Сигнал:** E2E ламається на `toHaveURL(/\/<entity>\/[a-z0-9-]+/)` після `firstRow.click()`. List-pages мігрували: row click→`setSelected`→DetailPanel; навігація через окрему кнопку.

```bash
grep -rn "firstRow\|tbody tr.*click\(\)" apps/web/e2e --include="*.spec.ts" -A3 | grep -B1 "toHaveURL.*\[a-z0-9-\]"
```

**Фікс:** detail-page тести — НЕ row click, а API+page.goto:

```typescript
await page.goto('/work-orders');
await expect(page.locator('table tbody tr').first()).toBeVisible();
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

**Severity:** MEDIUM.
**Де ще:** invoices, purchase-orders, stock-documents, counterparties, employees — усі з `useListPage`.

### 2026-06-20 — Skeleton/loading row матчиться як data row (Bug #575) — e2e / async-state / table-loading

**Сигнал:** `table tbody tr').first()` матчить skeleton `<TableRow>` при isLoading; `.count()` checkbox=0 попри створені рядки.

```bash
grep -rn "table tbody tr.*first\(\)" apps/web/e2e --include="*.spec.ts"
```

**Фікс:** чекати елемент ТІЛЬКИ у data row:

```typescript
await expect
  .poll(async () => await page.locator('table tbody tr input[type="checkbox"]').count(), {
    timeout: 20_000,
  })
  .toBeGreaterThanOrEqual(2);
// АБО: await expect(page.locator(`table tbody tr:has-text("${invoiceNumber}")`)).toBeVisible();
```

**Severity:** MEDIUM (flaky).
**Де ще:** invoices, work-orders, purchase-orders, stock-documents.

### 2026-06-20 — Hardcoded seed values vs E2E-generated fixtures (Bug #576) — e2e / fixture-drift

**Сигнал:** тест очікує hardcoded seed (`AA1234BB`, `Toyota`) на першому ресурсі, але там `E2E-Make...` (артефакт з CRUD specs без cleanup).

```bash
grep -rn "AA1234BB\|Toyota Camry\|Honda Civic\|Іван Петренко" apps/web/e2e --include="*.spec.ts"
```

**Фікс:** динамічний regex з API:

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
```

**Severity:** MEDIUM (false positives у CI).
