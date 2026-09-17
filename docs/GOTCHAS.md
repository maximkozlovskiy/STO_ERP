# GOTCHAS — STO ERP

> Відомі пастки. Append-only: новий запис додається зверху. Не дублювати — одне місце правди.

---

## [2026-09-17] Cookie `path` мусить синхронно змінюватись разом з версійним префіксом роуту

Симптом: після додавання `enableVersioning({type:URI, defaultVersion:'1'})` (усі роути → `/api/v1/*`)
клієнтські URL можна виправити на `/api/v1/auth/...`, але якщо backend встановлює httpOnly-cookie
з явним `path: '/api/auth'` (`res.cookie(...)`/`res.clearCookie(...)`), браузер продовжує прив'язувати
cookie до СТАРОГО шляху і НЕ надсилає її на новий `/api/v1/auth/...` — silent auth-breakage навіть
після виправлення самих URL (симптоми: refresh/logout виглядають як мережевий запит 200, але cookie
не долітає / не очищається). Правило: будь-яка зміна base-path контролера (версіонування, rename,
global prefix) МУСИТЬ синхронно оновити ВСІ `path:` у `res.cookie()/clearCookie()` цього контролера —
grep `path: '/api/` при кожній зміні base-path. Знайдено в аудиті backend #3 (`AuthController`,
`sto_refresh` cookie), коміт ecb688e2.

## [2026-09-15] Service Worker у DEV віддає застарілий JS-бандл → форми «не сабмітяться» / зламаний HMR

Симптом: у dev-Chrome клік по кнопці форми (напр. «Увійти») НЕ надсилає жодного запиту на бекенд
(у Network 0 запитів на /api/…), хоча той самий вхід через API (curl) та через чистий Playwright-браузер
працює (200). У Network видно `sw.js` як ініціатор і відсутність JS-чанків Next.js (вони прийшли з
SW-кешу `sto-erp-v1`, а не з мережі).

Причина: `ServiceWorkerRegistrar` реєстрував `/sw.js` БЕЗУМОВНО (включно з dev). SW робить cache-first
на статику (sw.js:100-121) → після оновлення коду браузер тримає СТАРИЙ бандл, у якому обробник форми
інший/зламаний → клік нічого не робить. SW коректно НЕ чіпає /api/ і не-GET, тож сам POST не блокується —
ламається саме доставка актуального JS. Ламає HMR так само.

Fix (застосовано): `ServiceWorkerRegistrar` реєструє SW ЛИШЕ у production (`NODE_ENV==='production'`),
а в dev — активно `getRegistrations().unregister()` + чистить `caches` з префіксом `sto-erp`.
Ручний воркараунд для вже-зараженого браузера: DevTools → Application → Service Workers → Unregister +
Clear site data + Ctrl+Shift+R (або інкогніто). Не плутати з auth: пароль/бекенд тут ні до чого.

---

## [2026-09-15] `prisma.X.update({where:{id}})` без orgId → A1 tenant-guard кидає 500

Клас багів, що траплявся вже ТРИЧІ (report-builder `updateSaved`, `auth.changePassword`, і мало не
optimize-рефактори). A1 fail-closed tenant-guard ($extends, `tenant-guard.extension.ts`) вимагає, щоб
КОЖЕН guarded `update`/`updateMany`/`delete` ніс tenant-токен (orgId/branchId) у `where` — інакше
`TenantIsolationError` → замаскований HTTP 500 «Внутрішня помилка сервера». Виняток лише для моделей
у `TENANT_EXEMPT_MODELS` (junction-таблиці, Organisation, SystemTemplate, append-only-child).

**Симптом:** endpoint що робить update повертає 500 (не 400/404), у dev-лозі TenantIsolationError.
Часто ховається бо: (а) unit-специ мокають Prisma → guard не виконується → зелено; (б) «оптимізація»
`updateMany({where:{id,orgId}})` → `update({where:{id}})` виглядає безпечно бо `findFirst({orgId})`
стоїть вище — АЛЕ guard оцінює кожен виклик НЕЗАЛЕЖНО, попередній read його не задовольняє.

**Grep-детектор:** `grep -rnE "\.update\(\{\s*where:\s*\{\s*id[,}]" apps/api/src --include=*.service.ts`
→ кожен match де where НЕ містить orgId/branchId і модель НЕ у TENANT_EXEMPT_MODELS = потенційний 500.

**Fix:** `where:{ id, orgId }` (Prisma приймає non-unique поля у where update — компаунд типізується
через extendedWhereUnique, що в проєкті увімкнено). Verify: unit-мок НЕ ловить → перевіряти НАЖИВО
проти tenant-guarded БД (curl create→update→200), не лише специ.

---

## [2026-09-15] E2E редіректять на /login, якщо web підняли БЕЗ NEXT_PUBLIC_E2E=1

Симптом: `npx playwright test` → усі тести падають на `readyPage` з навігацією на
`http://localhost:3001/login/`, навіть коли globalSetup успішно мінтить свіжий JWT
(`E2E auth state saved…` без помилки) і creds валідні (`admin@sto.local/admin123` → 200 на API).

Причина: auth-escape-hatch у `apps/web/src/lib/auth/context.tsx` гейтований
`E2E_HATCH_ENABLED = process.env.NEXT_PUBLIC_E2E === '1'` — **build-time** прапорець Next.js.
Без нього хатч (skip refresh-on-mount + гідрація токена з `localStorage.sto_e2e_access_token`)
tree-shake-иться геть → AuthProvider робить refresh-on-mount → 401 (refresh-cookie не
захоплюється cross-origin у Playwright) → LOGOUT → `/login`. `playwright.config.ts` задає
`webServer.env.NEXT_PUBLIC_E2E='1'`, АЛЕ `reuseExistingServer: true` → якщо dev-сервер :3001
вже піднято звичайним `pnpm --filter @sto/web dev` (без прапорця), Playwright його **reuse-ить**
і власний env НЕ застосовує. storageState має усі прапорці (`sto_e2e_skip_refresh` тощо), але
код що їх читає скомпільований геть.

**Фікс:** зупинити звичайний web-сервер :3001 і дати Playwright підняти свій (з
`NEXT_PUBLIC_E2E=1`), або одразу піднімати web з `NEXT_PUBLIC_E2E=1 pnpm --filter @sto/web dev`.
Після цього PO-E2E 11/11 зелені проти живої БД. Це harness/env-умова, не баг застосунку.

---

## [2026-09-14] Новий enum-value: hunt поширюється і на BACKEND PDF/print-шар, не лише фронт

Мультивалюта Фаза 4 (`FX_GAIN`/`FX_LOSS`) вже консолідувала дубль-мітки на фронті
(`SettlementsTabContent`/`PageClient` → shared `SETTLEMENT_TX_TYPE_LABELS`). Sync-аудит
знайшов ЩЕ один дубль, якого попередня консолідація не торкнулась — **на бекенді**:
`PdfService.generateReconciliationActPdf` (`apps/api/src/modules/pdf/pdf.service.ts`) мав
власний inline `txTypeLabel()` object-literal лише на 5 старих клієнтських типів
(`CHARGE`/`PAYMENT`/`PREPAYMENT`/`REFUND`/`CREDIT_NOTE`), без `SUPPLIER_*` і без нових
`FX_GAIN`/`FX_LOSS` → друкований акт звірки показував сирий enum-рядок замість українського
тексту. Причина: `docs/GOTCHAS.md` (запис нижче, 2026-06-15) вчив grep-ити лише
`apps/web/src/`, backend pdf/print-сервіси лишались поза чеклістом.

**Фікс:** `pdf.service.ts` тепер імпортує `SETTLEMENT_TX_TYPE_LABELS` з `@sto/shared`
(так само як `settlements.service.ts` вже імпортує `TRANSACTION_TIMEOUT_MS` звідти — `@sto/shared`
резолвиться в API рантаймі, окремого CJS-білда не треба).

**Правило на майбутнє при додаванні нового значення enum:** grep НЕ лише
`apps/web/src/`, а й `apps/api/src/**/pdf.service.ts`, `**/*.service.ts` на локальні
`{ TYPE: 'мітка' }` object-literal мапи того самого enum:

```bash
grep -rn "CHARGE:.*'.*Оплата\|txTypeLabel\|StatusLabel = {" apps/api/src/ apps/web/src/
```

**Severity:** MEDIUM — не блокує функціонал (сума/знак коректні), але друкований документ,
що йде контрагенту, показує технічний enum замість людського тексту.

---

## [2026-06-16] NestJS + SWC builder на Windows: paths aliases не резолвяться

**SWC не виконує `tsconfig paths` transform при emit** — копіює alias literal (`@sto/shared`) як є у dist JS. Node не знаходить модуль → `Cannot find module '@sto/shared'`.

**Симптом:** API стартує, але runtime помилка `Cannot find module` при першому import.

**Рішення:**

1. `nest-cli.json` — НЕ використовувати `builder: "swc"` у dev на Windows monorepo
2. `apps/api/package.json` — `"dev": "nest start --watch"` (tsc builder за замовчуванням)
3. Якщо є `paths` у `tsconfig.json` — видалити (tsc резолвить через node_modules symlink)
4. `baseUrl: "."` залишити — SWC потребує непустий baseUrl навіть коли не builder

**Окремо: `@sto/shared` package.json `main` не має вказувати на raw `.ts`** — Node/CJS не може виконати TypeScript. Рішення: `tsconfig.cjs.json` + `build:cjs` → `dist/cjs/index.js`.

**Окремо: `rootDir` у api tsconfig** — має бути `"src"` не `"../.."`; інакше dist стає `dist/apps/api/src/main.js` і `node dist/main` падає.

---

## [2026-06-15] Новий enum-value: hunt for hardcoded arrays на фронті

При додаванні нового значення до enum (`StockDocumentType.RECEIPT`, `WorkOrderStatus.X`, etc.) — grep по фронту на наявність **жорстко-закодованих масивів старих значень**, які не імпортують з `@sto/shared`.

```bash
grep -rnE "'WRITEOFF',\s*'TRANSFER',\s*'OPENING_BALANCE'" apps/web/src/
```

**Фікс:** замінити на `Object.keys(STOCK_DOC_TYPE_LABELS)` з `''` prepend — щоб майбутні значення підхоплювались автоматично.
**Severity:** CRITICAL — фіча відвантажена, але тип-таб відсутній у UI.

---

## [2026-06-15] Edit-mode modal: lines sync pattern (Bugs #460–#461)

1. **POST /:id/lines не існує** (Bug #460): якщо backend `CreateDto` вже приймає `lines: [...]` у body POST root і `service.create()` атомарно в `$transaction` — окремий endpoint для рядків не потрібен. `handleCreate` включає всі рядки в body основного POST.

2. **handleSave не видаляє pruned рядки** (Bug #461): snapshot `initialLineIds` при завантаженні документа. Рядки що були але зникли → `DELETE /resource/:id/lines/:lineId`. Інакше після PATCH reload вони повернуться.

**Правило перед написанням handleCreate/handleSave:** перевірити backend controller на наявність `POST /:id/lines`. Якщо немає — рядки у body root endpoint або PATCH з `lines: allLines` (replace-all pattern).

---

## [2026-06-15] Conditional required field у modal без disabled guard (Bug #462)

```tsx
// disabled коли TRANSFER але targetWarehouseId відсутній
disabled={saving || !form.branchId || !form.warehouseId || (form.type === 'TRANSFER' && !form.targetWarehouseId)}
```

І окрема inline-перевірка у `handleCreate`: `if (form.type === 'TRANSFER' && !form.targetWarehouseId) { setError('...'); return; }`.

---

## [2026-06-15] Partial<Record<Enum>> ховає TS-exhaustiveness (Bug #488)

`Partial<Record<SomeEnum, value>>` + runtime `throw` → новий enum value пройде compile але впаде в runtime.  
**Фікс:** плоский `Record<SomeEnum, value>` без `Partial<>` — TS сигналізує compile-time при додаванні нового варіанту.

---

## [2026-06-15] dedup guard потрібен ПЕРЕД Promise.all bulk-update (Bug #489)

При переході sequential → `Promise.all(array.map(async item => tx.X.updateMany(...)))` — якщо `array` може мати дублі по PK — `Promise.all` розіб'є їх у паралельні writes на той самий рядок.  
**Фікс:** `deduplicateBy(array, i => i.primaryKey)` ПЕРЕД `Promise.all`. Використовувати `apps/api/src/common/utils/array.ts`.

---

## [2026-06-15] Stale `$transaction` mock не виконує callback (Bug #489)

```typescript
// ❌ Мок що повертає, але не викликає callback → INNER логіка (updateMany + orgId) не виконується у тестах
prisma.$transaction.mockResolvedValue(undefined);

// ✅ Правильний мок
prisma.$transaction.mockImplementation(fn => fn(prisma));
```

---

## [2026-06-14] IIFE detail-panel у render батьківського компонента

`(() => { const buildTabs = item => [...]; return <DetailPanel tabs={buildTabs(item)} /> })()` — tabs array + content JSX перестворюються на КОЖЕН render батька. Симптом: введення у фільтр → фокус input скидається.  
**Фікс:** окремий `memo` компонент з `useMemo(tabs, [selectedItem, ...])`.  
**Загальне правило:** якщо JSX містить IIFE що повертає React елемент з масивом — це сигнал для memo-компонента.

---

## [2026-06-14] Stock report queries не покривались existing indexes

При unfiltered або тільки goodId-filter — Postgres seqscan. Додано:

- `stock_movements(orgId, goodId, createdAt)` — goodId-only filter
- `stock_movements(orgId, createdAt)` — unfiltered
- `stock_batches(orgId, createdAt)` — byBatch без isActive

**Загальне правило:** при новому list-endpoint з date sort — grep @@index на цій таблиці і перевірити covering для кожного типового фільтр-сценарію.

---

## [2026-06-12] kyivToday() всередині `.map()` render hot-path

`upcomingTO.slice(0,8).map(item => { const todayKyiv = kyivToday(); ... })` — impure + витратне.  
**Фікс:** `const todayKyiv = useMemo(() => kyivToday(), [])` на рівні компонента.  
Загальне: будь-який `kyivToday()/kyivDate()/nowMs()` всередині `.map()` callback → lift у компонент.

---

## [2026-06-12] Disjoint-set updateMany pairs всередині $transaction — Promise.all замість sequential

Два `tx.X.updateMany` з disjoint WHERE (різні значення `parentSlotId`) — незалежні writes на одній connection. Prisma підтримує `Promise.all` всередині interactive tx.  
**Підхід:** перевірити чи всі `await tx.X.Y(...)` справді залежать від попередніх. Якщо ні — `Promise.all`.

---

## [2026-06-12] Settings Tab PATCH весь об'єкт замість diff

PATCH надсилав ВСІ boolean-поля незалежно що змінено → server-side merge-баги невидимі у спеках.  
**Правильно:** snapshot у `useRef`, `patch = diff(initial, current)`, `if no keys → skip`.  
Той самий патерн при додаванні нових toggle у Settings tab.

---

## [2026-06-12] Silent calendar sync failure всупереч коментарю

`catch { console.warn }` + коментар «Surface the error to user» — обіцяє UX, доставляє лише dev-tools log.  
**Правило:** якщо коментар обіцяє user-visible feedback → `toast.warning(...)`. Grep pattern для review: `catch.*console\.warn` після API await.

---

## [2026-06-12] Calendar slot continuation колапс при updateMany

`CalendarSlot.parentSlotId` — split-day continuation інваріант: `parent.endAt < child.startAt`. Bulk `updateMany({ workOrderId })` з одним `{startAt, endAt}` колапсує parent+child → data corruption.  
**Правильний патерн:** (1) soft-delete continuations (parentSlotId IS NOT NULL); (2) update тільки parent (parentSlotId IS NULL); (3) recreate child якщо range перевищує день.

---

## [2026-06-12] Alternate-mutation endpoint обходить canonical guards (Bug #444)

Будь-який bulk/sync метод що мутує той самий resource що canonical `update()` ОБОВ'ЯЗКОВО повторює ВСІ business-guards (conflict check, FSM, etc.).  
`syncWorkOrderSlots()` не мав conflict probe — silent double-booking.

---

## [2026-06-12] Ad-hoc `<div className="fixed inset-0 z-[N]">` замість ConfirmDialog/useConfirm

Inline confirm-div без `role="dialog"`, `aria-modal`, Escape handler, focus trap, exit-animation.  
**Правило:** `const ok = await confirm({ title, message })` через `useConfirm()` hook (вже у codebase).

---

## [2026-06-12] RELEASE перед WRITEOFF у тій самій WO-COMPLETED транзакції

`InventoryService.createMovement` гейтить WRITEOFF через `available = quantity - reserved`.  
Якщо WO зарезервував саме той залишок → `available=0` → WRITEOFF падає.  
**Порядок:** (1) `RESERVATION_RELEASE -baseQty`; (2) `WRITEOFF -baseQty`. Не послаблювати guard.

---

## [2026-06-12] `new Date('YYYY-MM-DD').getTime() < Date.now()` на полях типу date

Парсить як UTC midnight → Kyiv +03 → `03:00 ранку` already-past.  
**Правильно:** `dateStr.slice(0,10) < kyivToday()` (string-compare).

---

## [2026-06-12] FE↔BE constants symmetry потребує enforce-spec, не лише коментар (Bug #439)

«Must mirror …» у коментарі — інтенція, не invariant. Без `expect(BE.sort()).toEqual([...FE].sort())` у `*.fsm.spec.ts` — одна сторона може тихо розійтись.  
**Правило:** при додаванні shared status-сету → одразу писати symmetry-spec у BE invariants file.

---

## [2026-06-12] `@Get('templates/:type')` wild-card перехоплює специфічний endpoint

`@Get('templates/pricing-list')` зареєстрований ПІСЛЯ wild-card `@Get('templates/:type')` → ніколи не спрацьовував.  
**Правило Fastify:** специфічний sub-route ПЕРЕД параметричним (`:type`, `:id`). Або додати як case у switch.

---

## [2026-06-14] /brands повертає `{items, total}`, НЕ bare Brand[] (Bug #181)

Виняток: `/branches` повертає bare array. Перевіряй controller кожного endpoint перед `apiFetch<T[]>`.  
**Правило:** стандарт STO ERP list = `{ items, total }`, але є винятки довідникових endpoints.

---

## [2026-06-14] Prisma Json type у upsert

`Record<string, unknown>` не assignable до `InputJsonValue` → cast `value as Prisma.InputJsonValue`.

---

## [2026-06-14] CurrentUser decorator повертає AuthenticatedUser.id, не sub

`@CurrentUser()` повертає `AuthenticatedUser` з полем `id`. `sub` є у `JwtPayload` але контролери отримують `AuthenticatedUser` після `validate()`.

---

## [2026-06-14] Контрактний spec ламається при зміні signature сервісу

`toHaveBeenCalledWith(...positional)` — будь-яка зміна параметрів тихо ламає лише деякі кейси.  
**Правило:** при зміні signature → оновити всі `toHaveBeenCalledWith` + regression test що верифікує новий параметр пробрасується.

---

## [2026-06-14] Не SELECT'и поля які потім дропає DTO

MECHANIC-гілка selects `counterpartyId: true`, але `toConflictDto()` повертає `null` завжди.  
**Правило:** якщо DTO mapping повертає `null` для поля → НЕ select'ити його з БД.

---

## [2026-06-14] jsdom: ResizeObserver відсутній (Bug #177)

`ResizeObserver` відсутній у jsdom → modal.test.tsx падали.  
**Фікс:** noop-стаб у `apps/web/src/__tests__/setup.ts`. Правило: будь-який новий browser API у `components/ui/` потребує jsdom-стабу.

---

## [2026-06-14] close-rAF без id-capture

`requestAnimationFrame` без id-capture → rapid toggle писав `height:0` поверх відкритої форми.  
**Фікс:** `formCloseRafRef = useRef<number|null>(null)` + `cancelAnimationFrame` на старті toggle + unmount cleanup.

---

## [2026-06-14] HAR "duplicate" це OPTIONS + GET, не дубль fetch у коді

DevTools показує кожен endpoint двічі: OPTIONS (preflight) + GET (actual). НЕ React дубль.  
**Як виправити preflight:** `app.enableCors({ maxAge: 86400 })` — Chrome кешує на 7200s.

---

## [2026-06-14] apiFetch + FormData = завжди 406 (Bug #197)

`apiFetch` додає `Content-Type: application/json` → fastify-multipart кидає "not multipart".  
**ПРАВИЛО:** для upload файлів завжди `apiMultipartFetch(path, formData)`.

---

## [2026-06-14] `calculateSalePrice` при `purchasePrice = null` → затирає ціну у 0 (Bug #198)

`0 * (1 + p/100) = 0` → silent data corruption `Good.salePrice`.  
**ПРАВИЛО:** перед `calculateSalePrice()` перевірити `costPrice > 0`. Якщо ні → пропустити.

---

## [2026-06-14] CounterpartyContract feature pitfalls (Bugs #347–#351)

- **#347** Нова `private readonly X` у конструкторі → одразу `{ provide: X, useValue: mock }` у всі парні spec-и.
- **#348** Auto-create документа (контракт, акт) → завжди `DocumentNumberService.next()`, НЕ hardcode.
- **#349/#350** Новий nested field у `toDto()` → пройти ВСІ `findFirst/findMany/create/update` що повертають через цей `toDto()` і додати парний `include`.
- **#351** Soft-delete `isPrimary/isDefault` entity → у `$transaction` promote наступного sibling за `createdAt:'asc'`.

---

## [2026-06-12] TanStack Query queryKey shape contract (Bugs #354–#356)

- **#354** Command Palette `/X/new` → якщо create-flow це модалка → `?action=new` query param + listener у page.tsx + `<Suspense>`.
- **#355** `usePaginatedList(endpoint, filters, { queryKey })` → queryKey: `[key, 'list', filters]` (НЕ `[key, filters]`).
- **#356** TopShell prefetch payload-shape має МАТЧИТИ initial filter object сторінки: sortBy/sortDir/dateFrom/dateTo включно.

---

## [2026-06-12] CRM edit-modal request token ref

`openEdit` робить fetch у обробнику події → request-token ref щоб slow-fetch попереднього CP не перезаписав поточний. `modalGarageId` скидати на `null` при відкритті.

---

## [2026-06-12] useDirtyForm: onClose пропс Modal — async arrow сумісний з `() => void`

`async () => void` сумісний з `() => void`. TypeScript не скаржиться.
