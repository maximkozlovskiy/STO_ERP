# MemoryManual — STO ERP

> Живий документ. Оновлюється автоматично після кожного git commit.
> Читається на початку кожної сесії разом із `CLAUDE.md` і `.claude/memory/`.
> Мета: швидка орієнтація в коді та оптимізація роботи Claude Code.

---

## Останній commit

```
bc5dbfa fix(review): SSE skip throttle + xlsx Buffer→ArrayBuffer slice + register @nestjs/throttler
80997d6 refactor(arch): split calendar/page.tsx into CalendarDayView/MonthView/StatsTab/SlotModal
637f9f0 refactor(arch): etap 3.1 — split catalog/page.tsx into WorksTab/GoodsTab/ServicesTab/BrandsTab/UnitsTab
06eab65 fix(arch): etap 2.1 — remove 6x 'as any' from xlsx.service.ts
8b2a1e0 feat(arch): etap 1.3 — rate limiting via @nestjs/throttler (global 200/min, login 10/min, upload 30/min)
e39d5ee perf(arch): etap 1.1+1.2 — MAX_QUERY_LIMIT on findMany + TRANSACTION_TIMEOUT_MS on $transaction
3d86bdc perf(web): Intl singletons via lib/format — replace per-render toLocaleString in 9 pages
bb2f2b0 perf(backend): parallel FK validation in pricing-rules + goods create/update
5077c92 perf(db): GIN trgm for counterparties/goods search + covering indexes for calendar/goods/counterparties list queries
efbff7a perf(backend): bulk-prefetch xlsx imports + parallel FK validation + Intl singletons
84f359d docs(memory,skills): record perf optimization session + 5 new patterns
331e4ca perf(db): covering indexes for audit-by-entity + settlement transactions
95a08ef perf(backend,web): parallelize remaining independent fetches
70bbaa6 perf(backend): parallelize independent FK validations + queue fan-out
66eb6e3 fix(tester): Bugs #200-#202 — repair stale PO service spec + cover new pricing public methods + status guard contract
e189793 docs(skills): add bulk-apply per-iteration-tx pattern to sto-review (Bug #194)
c1dc5dd fix(review): PO apply-pricing N+1 + status guard + catalog cache-stale on mutation
7ad293f fix(ui): add MIME types to file inputs — xlsx not selectable on Windows without MIME type
2a1b9c9 feat(purchase-orders): add Розцінити button + result in DetailPanel for RECEIVED/PARTIAL POs
647ec26 fix(nav): /settings stays active on /settings/sync — exact match for prefix routes
71bac78 docs(skills,memory): add detail-page-ref-cache-miss pattern to sto-optimize
f2a3d71 perf(catalog): seed Units/Brands tabs from ref-cache for instant first-paint
8baef48 perf(web): ref-cache works/employees/warehouses on WO detail + branches on calendar
31b00a8 perf(crm): skip user-preferences API fetch when localStorage cache < 5min old
0dae6f9 fix(ui): invoices payForm infinite loop + crm detail-panel vehicle fetch race condition
24bca1b perf(nav): enable prefetch on sidebar links — compile on hover not on click
0b5c89c docs(memory): record CORS preflight + ref-cache seed perf session (9fe62df + 448ae08)
448ae08 docs(skills): add CORS-preflight-cache + consumer-page-ref-cache-seed patterns to sto-optimize
9fe62df perf(cors,settings): cache CORS preflight 24h + seed settings branches from ref-cache
c24ffa7 fix(tester): Bugs #197-#199 — PricingRulesClient apiMultipartFetch + xlsx purchasePrice=null guard + applyPricing error surface
91bafc8 fix(review): pricing-rules update tenant guard + dead orConditions cleanup
a24b4dc feat(ui): useColumnDrag hook + drag CSS — column reorder via table header drag
4548036 feat(ui): column drag-and-drop in table headers via useColumnDrag hook
07fac23 docs(memory,skills): record sto-tester session b04e879 + add new-boolean-prop pattern
b04e879 fix(tester): Bugs #193-#196 — test coverage for SaveFilterButton/hideSaveButton/AnimatedBody/Modal size
(pending) docs(skills): add verify-before-fix pattern to sto-optimize (UI perf audit — 0 fixes)
c922503 feat(ui): SaveFilterButton component — icon-only bookmark button
51ff488 feat(ui): move save-filter to icon-only button before ColumnsDropdown on all pages
2381173 feat(ui): increase page-container max-width 80rem → 96rem for wider tables
1bee096 feat(ui): AnimatedBody on inline forms + wider modal sizes for list-heavy forms
e7d61b0 revert: undo DataTable refactor — restore original Table components
b1a083c fix(tester): Bugs #187-#192 — PO/XLSX pricing test coverage + multipart i18n + defense-in-depth updateMany
91b54b9 docs(memory): record PO pricing + xlsx list import feature (e754ad4 + cef188a)
cef188a fix(sync): align pricing-list template download with API contract
e754ad4 feat(pricing): apply pricing to PO + list import (XLSX/CSV)
0ff559c docs(skills): add detail-include-vs-list-include + premature-optimization-rejection patterns to sto-optimize
b39a25f docs(skills,memory): record Etap A-D review session — 4 new patterns to sto-review
93ccc25 fix(review): Etap A-D — brandId update normalize + AnimatedBody rAF cleanup + useDetailPanelConfig race + user-prefs key guard
c353de7 fix(tester): Bugs #182-#183 — @IsObject on DTO value field + user-preferences contract spec
5d003e4 feat(panel): configurable detail panel — UserPreference DB + API + useDetailPanelConfig hook + CRM/Employees
aa7ca6e feat(ui): AnimatedBody on all inline form sections — smooth expand animation
21587cf fix(tester): Bug #181 — brands fetch shape mismatch ({ items } not Brand[])
21a356e feat(pricing): brand + COST_TIER grade pricing UI — brand select + tier table
c5e8714 docs(skills): add bulk-apply scope-inconsistency pattern to sto-tester (Bug #178)
e7b0cbf fix(tester): Bugs #178-#180 — pricing brandId scope + COST_TIER coverage + normalizeScope hierarchy
23bf19c fix(review): pricing COST_TIER cleanValues + $transaction timeout + brandId index
fdcf7ea feat(pricing): brand markup + COST_TIER grade pricing — DB schema + backend
8491975 fix(tester): Bug #177 — stub ResizeObserver/IntersectionObserver in jsdom setup
f2410ae docs(skills,memory): record close-rAF id-capture + unmount cleanup pattern in sto-review
a6f9aea fix(review): cancel close-rAF + cleanup form hide-timer/rAF on unmount in calendar
b5add44 feat(ui): export AnimatedBody, apply ResizeObserver height to calendar form, document §14.4
26b3264 docs(tester): record AUTO session — 0 bugs CRM Наряди + Catalog Штрихкоди/Партії ModalTabs
613aef7 feat(crm,catalog): ModalTabs edit modal for 1-N — WO history + barcodes + batches tabs
561e08b fix(sync): align /goods/:id/batches response shape in catalog page
1eec17f docs(memory): record sto-tester session 8c3751e (Bugs #173-#176)
d5a4f18 docs(skills): add component-vs-test drift + web-suite baseline rules to sto-tester
8c3751e fix(tester): Bugs #173-#176 — test coverage ModalTabs/employees assignments/counterparties showDeleted + saved-filters empty-state
e69bf1e fix(review): guard CRM edit-modal vehicle fetch against stale-CP race
6b886ae feat(crm,employees): ModalTabs component + assignments in edit modal
cc44f73 fix(sync): align counterparties API with frontend showDeleted + deletedAt contract
921afb7 refactor(useDirtyForm): confirmClose returns Promise<boolean>, adds dialogProps
2a874fb fix(po,sd,wo): async confirmClose + DirtyConfirmDialog
ca77bec fix(crm,employees,invoices): async confirmClose + DirtyConfirmDialog
70487cd fix(catalog): async confirmClose + DirtyConfirmDialog
1f260e1 fix(crm): remove type from PATCH body — UpdateCounterpartyDto does not accept it
4968a88 docs(skills): update sto-web with visibleColumns.map pattern as standard
da693b7 refactor(ui): useTableColumns owns order+labels, ColumnsDropdown is pure UI
798c0cb refactor(work-orders,catalog): dynamic column order via visibleColumns.map
f529d0f feat(ui): detail panel system — useDetailPanel, DetailPanelToggle, tabs + PanelField
3fba789 feat(ui): column configurator, crm edit, panel tabs height
dfd5c3e fix(review): align catalog ColumnsDropdown with ml-auto like work-orders
3a11f60 feat(catalog): column visibility management — 3 tabs (works/goods/services), independent useTableColumns keys
4b77c87 feat(catalog): savedFilters + bulkActions + unsavedGuard
4c4fee2 feat(stock-documents): savedFilters + bulkActions + unsavedGuard
6817180 feat(purchase-orders): savedFilters + bulkActions + unsavedGuard
54ef4fc feat(invoices): savedFilters + bulkActions + unsavedGuard
7527261 feat(crm): savedFilters + bulkActions + unsavedGuard
49e80d0 feat(employees): savedFilters + bulkActions + unsavedGuard
8346b16 feat(calendar): replace inline errors with toast notifications
e1bf870 feat(calendar): smoother form open/close animation + fix Save button disabled state
5a0515c fix(calendar): save and restore counterpartyId on slots without work order
ea454ff fix(work-orders): transition response lacks lines/parts — merge instead of replace
ff87285 feat(ui): replace native confirm() with ConfirmDialog + useConfirm hook
(pending) fix(tester): Bugs #170-#172 — minio mc-ready healthcheck, work-orders query-shape spec, calendar fan-out error surface
ed3d043 docs(skills): add rgba(var()-phantom-var) + unbounded-fan-out checks to sto-review
bf41694 docs(memory): record calendar month-grid + stats review (HEAD b22a5f0 → efcfd97)
efcfd97 fix(review): theme-aware month heatmap + bounded/abortable calendar fan-out
f65b670 docs(sync): record full 3-direction audit HEAD b22a5f0 — 0 mismatches
b22a5f0 feat(calendar): stats with day / month / custom period filter
bb5f0a7 feat(calendar): month grid view + stats tab
507a7e8 fix(review): generate prisma client in api runner stage (pnpm layout)
5c7748f feat(phase18): installer + production build — Dockerfiles, Caddyfile, build script
751adcf fix(tester): Bug #163 — regression spec for counterparties ?q= search (plural relation names)
a0bc034 feat(calendar): read-only view for slots in closed/past period
d66067b fix(tester): Bugs #161-#162 — org-scoped FK validation in goods + spec
64dc4ef docs(memory): record goods unitId/brandId review (HEAD 5045007)
634536c fix(review): remove unused IsUUID import from goods.dto
5045007 fix(goods): add unitId + brandId to CreateGoodDto and GoodResponseDto
63640fb perf(optimize): hoist Intl formatters + drop per-render new Date() in calendar
d4de52a perf(optimize): parallel FK validation in calendar create/update slot
d98a968 docs(sync): record branches bare-array gotcha in MemoryManual
fbe66ad fix(sync): branches endpoint returns bare array, not {items}
e27cc22 fix(tester): Bugs #159-#160 — surface /branches error, remove dead WO-dropdown code
9d454d3 fix(review): add LiftType PIT/RAMP migration, strip BOM from 22 DTOs, surface SearchPicker errors
e0af6a8 feat(warehouses): warn when setting main warehouse displaces existing main
c213fc0 feat(infrastructure): rename Підйомник→Пост, add PIT/RAMP lift types (Яма/Естакада)
4ef25bb feat(calendar): SearchPickerModal for client/work-order — button opens modal list with search
4a3cdc0 fix(validation): replace @IsUUID() with @Matches UUID regex — accepts seed UUIDs
a6b154e fix(tester): Bugs #156-#158 — calendar contract spec, resize window clamp, search error surfacing
77d9452 docs(skills): add closest()-on-phantom-data-attr + partial-pointer-cancel checks to sto-review
0371c73 feat(calendar): interactive slot draw, edge resize, client name, PATCH endpoint
5702506 fix(review): calendar draw-guard selector, stuck resize on leave, dedup toISO
5afbadd docs(skills): add source-page-not-warming-ref-cache approach to sto-optimize
e0fd299 perf(optimize): warm shared ref-cache from infrastructure page
5bc5f5b docs(skills): add stale-spec-after-refactor approach to sto-tester + record #153-#155
8376435 fix(tester): Bugs #153-#155 — repair 3 stale service specs (CacheService DI + single-findFirst)
07e8075 docs(skills): add self-improvement mechanism to sto-optimize (Крок 7 + Накопичені підходи)
09b8a3b perf(optimize): Redis cache + parallel FK validation for currencies/bank-accounts/cash-registers
f13b9ad fix(review): SSR-safe today, cancel guard on CRM loadGarages, drop dead loadAudit
6a72c23 perf(round2): parallel queries + lazy img + today useMemo
ba14043 fix(review): make calendar memo effective + guard GET dedup against shared AbortSignal
5704435 perf(db): GIN trgm indexes applied
e59578b perf(web): memo calendar + dedup GET requests (api-client.ts)
8e4d346 perf(dashboard): Redis 25s TTL cache
2e180d9 perf(reports): $queryRaw groupBy aggregation (workOrders + profitability)
f040cde perf(db): 5 composite indexes
19a4c22 fix(review): narrow employee relation includes to select in create/update
945e264 perf(web+api): lazy-load reports charts + slim employee includes
9a9efeb perf(purchase-orders): lazy-load lines — remove from list, fetch on detail open
923aea5 perf(api): Redis cache for reference data (5 min TTL)
```

Дата: 2026-05-30

---

## Perf: CORS preflight + ref-cache seed (9fe62df)

### Gotcha (perf) — HAR "duplicate" це OPTIONS + GET, не дубль fetch у коді
DevTools/HAR показує кожен API endpoint двічі: спочатку `-X 'OPTIONS'` з `Access-Control-Request-Method: GET`, потім той самий URL без -X (реальний GET). Це нормальна CORS preflight + actual request пара для cross-origin запиту з `Authorization` header — це НЕ дубль fetch у React коді.
**Як перевірити:** дивися на `-X 'METHOD'` у curl-export. OPTIONS+GET = preflight; GET+GET = реальний дубль.
**Як виправити preflight:** `app.enableCors({ ..., maxAge: 86400 })` — браузер кешує OPTIONS-відповідь (Chrome cap 7200s). До фіксу: кожен fetch = 2 RTT. Після: перший fetch = 2 RTT, всі наступні в межах cache window = 1 RTT.
**НЕ виправляй:** useEffect / StrictMode / dedup — там немає реального дубля.

### Pattern: consumer-page без ref-cache seed
Сторінка-споживач (settings/dashboard/reports) що використовує довідник у side-UI (workdays tab, picker, фільтр) має робити seed з sessionStorage перед apiFetch:
```ts
const cached = getCached<Branch[]>('cache:branches');
if (cached?.length) setBranches(cached);
apiFetch<Branch[]>('/branches').then(d => { setBranches(d); setCache('cache:branches', d); });
```
Без seed dropdown показує `[]` під час cold-fetch. Безпечно якщо сторінка НЕ редагує цей довідник (settings не CRUD-ить branches — це окрема сторінка infrastructure).

---

## Pricing: розцінка по PO і по списку XLSX/CSV (e754ad4 + c24ffa7)

### Gotcha #197 — CRITICAL: `apiFetch` + FormData = завжди 406
`apiFetch` додає `Content-Type: application/json` → browser не може виставити `multipart/form-data; boundary=...` → fastify-multipart кидає "the request is not multipart".
**ПРАВИЛО:** для upload файлів завжди `apiMultipartFetch(path, formData)` — НЕ `apiFetch` з `body: FormData`.
Постраждало: `PricingRulesClient.tsx:626` (upload pricing list). Всі інші upload-точки вже правильні.

### Gotcha #198 — HIGH: `calculateSalePrice` при `purchasePrice = null` → затирає ціну у 0
`PERCENT/COMPETITOR_PLUS/COST_TIER` → `0 * (1 + p/100) = 0` → silent data corruption `Good.salePrice`.
**ПРАВИЛО:** перед `calculateSalePrice()` перевірити `costPrice > 0`. Якщо 0 або null — пропустити з поміщенням у `notFound[]`, не обчислювати.

---

## Pricing: розцінка по PO і по списку XLSX/CSV (e754ad4 + cef188a)

### Backend

- `POST /purchase-orders/:id/apply-pricing` — розцінює всі лінії PO за `PricingService.calculateSalePrice()`, оновлює `Good.salePrice`, записує `PriceHistory` з reason `PO pricing: {po.number}`. Доступно на статусах ORDERED/PARTIAL/RECEIVED (не перевіряє статус — просто обробляє всі лінії).
- `POST /xlsx/apply-pricing-from-list` — приймає XLSX або CSV (за розширенням), парсить SKU+barcode, знаходить товари по OR, розцінює, записує PriceHistory з reason `List pricing import`. CSV колонки: `sku`, `barcode`, `name`.
- `GET /xlsx/templates/pricing-list` — тепер як case у `templates/:type` switch, повертає base64 CSV з BOM.

### Frontend

- `apps/web/src/app/purchase-orders/page.tsx` — кнопка «Розцінити» у рядку таблиці (тільки RECEIVED/PARTIAL), inline result-таблиця (товар/собівартість/стара ціна/нова ціна).
- `apps/web/src/app/pricing-rules/PricingRulesClient.tsx` — кнопка «Розцінити список» у toolbar, розкривна секція з file input (XLSX/CSV), result-таблиця. Завантаження шаблону через `apiFetch('/xlsx/templates/pricing-list')` + blob download (не raw anchor).

### Gotcha (sync fix cef188a)
`@Get('templates/:type')` wild-card перехоплює будь-який шлях `templates/X`. Окремий `@Get('templates/pricing-list')` зареєстрований ПІСЛЯ wild-card → ніколи не спрацьовував. Фікс: додати `pricing-list` як case у існуючий switch замість окремого endpoint.

---

## UI: AnimatedBody — плавна зміна висоти Modal (b5add44+607bfd2)

`apps/web/src/components/ui/modal.tsx` — `AnimatedBody` тепер **export**.

**Паттерн:** outer div з `overflow:hidden` + `transition:height 260ms` анімується через `ResizeObserver` на inner div. Висота встановлюється миттєво при mount (`transition:none` → rAF → re-enable), щоб не конфліктувати з `zoom-in-95` відкриття.

**Де застосований:**
- Modal body — автоматично (всі `<Modal>` у проекті)
- `calendar/page.tsx` — форма нового слоту (замінено `maxHeight:'900px'` magic)
- `vehicles/[id]/PageClient.tsx` — showAddNode, showAddSchedule (Етап C)
- `work-orders/[id]/PageClient.tsx` — showInspection (Етап C)
- `crm/page.tsx` — showAddVehicle у ModalTabs (Етап C)
- `catalog/page.tsx` — showAddBarcode у ModalTabs (Етап C)
- `crm/[id]/PageClient.tsx` — showAddGarage (Етап C)

**Gotcha — jsdom (Bug #177, 8491975):** `ResizeObserver` відсутній у jsdom → 9/10 modal.test.tsx падали. Фікс: noop-стаб у `apps/web/src/__tests__/setup.ts`. Правило: будь-який новий browser API у `components/ui/` потребує jsdom-стабу.

**Gotcha — close-rAF (a6f9aea):** `requestAnimationFrame` без id-capture → rapid toggle писав `height:0` поверх відкритої форми. Фікс: `formCloseRafRef = useRef<number|null>(null)` + `cancelAnimationFrame` на старті toggle + unmount cleanup.

## UI: CRM edit modal — вкладка «Наряди» (613aef7)

`apps/web/src/app/crm/page.tsx` — ModalTabs тепер має 2 вкладки:
- **Авто {N}** — існуюча (+ vehiclesError error banner)
- **Наряди {N}** — нова: `GET /work-orders?counterpartyId=&limit=50`, read-only таблиця зі статус-badge та кліком на рядок → навігація у наряд

State: `modalWorkOrders[]`, `modalWorkOrdersLoading`, `woError`, `vehiclesError`, `modalWoReqRef` (race guard паралельний із `modalVehiclesReqRef`).

## UI: Catalog GoodsTab edit modal — вкладки «Штрихкоди» + «Партії» (613aef7)

`apps/web/src/app/catalog/page.tsx` GoodsTab — ModalTabs з 2 вкладками:
- **Штрихкоди {N}** — `GET /goods/:id/barcodes`, inline add (barcode+type select) + delete
- **Партії {active}** — `GET /goods/:id/batches` (розпаковується `.items`, sync fix 561e08b), read-only grid: партія/накладна, отримано, залишок, собів., ціна продажу, дата

State: `modalBarcodes[]`, `modalBatches[]`, `barcodeError`, `batchError`, `showAddBarcode`, `addBarcodeForm`, `addingBarcode2`, `deletingBarcodeId2`, `modalBarcodeReqRef`, `modalBatchReqRef`.

**Gotcha — /goods/:id/batches повертає `{items, total}`, не bare array** (561e08b).

**Gotcha — /brands повертає `{items, total}`, НЕ bare Brand[]** (Bug #181, 21587cf). Виняток: `/branches` повертає bare array (fbe66ad). Перевіряй controller кожного endpoint перед `apiFetch<T[]>`. Правило: стандарт STO ERP list = `{ items, total }`, але є винятки довідникових endpoint-ів.

## sto-dev §14 — Modal+ModalTabs паттерн для 1-N (613aef7)

Новий розділ у `.claude/skills/sto-dev/SKILL.md`:
- **§14.1** Структура Modal з ModalTabs (layout, state-блоки на колекцію, PATCH+оновлення списку)
- **§14.2** Loading/Error/Empty/List у tab.content (не на рівні ModalTabs), count з поточного state
- **§14.3** Race guard + скидання стану при відкритті (++reqRef.current, гейт у .then/.catch/.finally)

## Pricing: brand markup + COST_TIER grade pricing (fdcf7ea)

**Нові можливості:**
- `PricingRuleType.COST_TIER` — ціноутворення на основі градацій собівартості (тіри)
- `brandId` поле у `PricingRule` — прив'язка правила до бренду (пріоритет 2 у ієрархії)
- `PricingRuleTier` модель — тіри з `costMin/costMax/percentValue/sortOrder` (cascade delete, без soft-delete)

**Ієрархія пріоритетів `calculateSalePrice`:**
1. `goodId` — конкретний товар
2. `brandId` — бренд товару
3. `goodCategory` — категорія
4. `goodType` — тип (SPARE_PART/CONSUMABLE/...)
5. all (null scope) — загальне правило

**COST_TIER логіка:** знайти тір де `costMin <= costPrice < costMax` (або `costMax IS NULL` = останній); `percentValue` тіру = markup %.

**API зміни:**
- `GET /pricing-rules` — тепер включає `brand`, `tiers` у response
- `POST /pricing-rules` — приймає `brandId`, `tiers[]`
- `PATCH /pricing-rules/:id` — replace-semantics для тірів (deleteMany + createMany в $transaction)
- Response shape: `{ brandId, brandName, tiers: [{id,costMin,costMax,percentValue,sortOrder}] }`

**Spec coverage:** pricing.service.spec.ts оновлено (нова 6-arg сигнатура), pricing-rules.contract.spec.ts оновлено (brand/tiers у mock, pricingRuleTier mock).

**Migration:** `20260530100000_add_pricing_brand_cost_tier` — ALTER TYPE + ALTER TABLE + CREATE TABLE + FK constraints.

## UI: Конфігурована бокова панель — useDetailPanelConfig + UserPreference (5d003e4)

**Нова модель БД:** `UserPreference` у `packages/database/prisma/schema.prisma` — зберігає JSON-конфіг per (orgId, employeeId, key). Без soft-delete (config data). Міграція `20260530200000_add_user_preferences`.

**Новий API-модуль:** `apps/api/src/modules/user-preferences/`
- `GET /user-preferences/:key` — повертає `{ key, value }` для поточного employee
- `PUT /user-preferences/:key` — зберігає `{ key, value }` (204 No Content)
- Auth-scoped: employeeId береться з `@CurrentUser() user.id` (AuthenticatedUser, не JwtPayload)
- Всі ролі мають доступ (OWNER|ADMIN|RECEPTIONIST|MECHANIC|ACCOUNTANT|STOREKEEPER)

**Новий хук:** `apps/web/src/hooks/useDetailPanelConfig.ts`
- `useDetailPanelConfig(pageKey)` → `{ isFieldHidden, toggleField, reset, loading, config }`
- Offline-first: optimistic localStorage + fire-and-forget API save
- API key = `detail_panel_${pageKey}`, storage key = `sto_panel_cfg_${pageKey}`

**Розширений DetailPanel:** `apps/web/src/components/ui/detail-panel.tsx`
- Нові props: `configFields?: PanelConfigField[]`, `onToggleField?`, `onReset?`
- Кнопка ⚙ у хедері (Settings icon, тільки якщо є configFields)
- `showConfig` state — при click замінює контент панелі на checkbox-список полів
- `PanelField` отримав `fieldKey?: string` і `hidden?: boolean` — якщо `hidden=true`, не рендерить

**Сторінки з конфігуратором:**
- `crm/page.tsx` — 6 полів: phone, email, edrpou, balance, contactPerson, type
- `employees/page.tsx` — 6 полів: status, role, phone, email, rateScheme, dateOfHire

**Gotcha — Prisma Json type у upsert:** `Record<string, unknown>` не assignable до `InputJsonValue` → cast `value as Prisma.InputJsonValue` у service.

**Gotcha — CurrentUser decorator:** повертає `AuthenticatedUser` з полем `id` (не `sub`). `sub` є у `JwtPayload` але контролери отримують `AuthenticatedUser` після `validate()`.

## Поточний стан проєкту
TypeScript: ✅ 0 errors (web + api + shared) — після arch optimization review session (verified 2026-05-30, HEAD bc5dbfa)
Latest review: 2026-05-30 (sto-review-agent Auto, HEAD bc5dbfa) — knaown gaps: SSE під global throttler (fixed з @SkipThrottle), `buffer.buffer as ArrayBuffer` ризикує даними з пула Buffer (fixed з slice helper), @nestjs/throttler dep був не зафіксовано у попередньому коміті (fixed)
Unit+Contract: ✅ 419/419 passed API (39 файлів) — без змін (xlsx.service.spec оновлено для findMany+computePriceFromRules моків — 12/12 passed). Web vitest: ✅ 179/179 passed.
Latest optimize: 2026-05-30 (AUTO, HEAD 84f359d → efbff7a) — другий цикл після 84f359d (попередній: 17 фіксів). Скан свіжого коду (purchase-orders applyPricing, pricing-rules, files/upload). **7 нових фіксів backend:** (1) xlsx importPOLines/importSDLines/importWOParts — per-row good.findFirst + line.findFirst → bulk lookupGoodsBulk + existing-lines findMany IN. 1000 рядків: 3000 RTT → 2 batch RTT (1000-кратне прискорення для типового імпорту). (2) xlsx applyPricingFromList — calculateSalePrice (внутрішньо fetch pricingRules) у циклі → prefetch rules один раз + sync computePriceFromRules. N items: 2N RTT → 2 RTT. Goods bulk-prefetched теж (SKU IN OR barcode IN). (3) reports.revenue: kyivDate форматер створювався per-row у 10k loop → KYIV_DATE_FMT module-level singleton. (4) pdf.service fmtMoney/fmtDate створювали Intl per `.map()` table cell → UAH_FMT/UA_DATE_FMT module-level. (5) stock-documents.create: 3-й FK (targetWarehouse) після Promise.all sequential → conditional у Promise.all (3 RTT → 1 для TRANSFER). (6) loyalty.getBalance/getTransactions: assertCounterparty потім loyaltyAccount.findFirst sequential → Promise.all (entity query вже tenant-safe через orgId). -1 RTT кожен. (7) inspection.findByWorkOrder: WO guard потім inspectionReport.findFirst sequential → Promise.all. -1 RTT. Тести: 419/419 API + 179/179 web passed (xlsx spec оновлено для нових моків). 4 нові накопичені підходи у SKILL.md: bulk-prefetch line importers, pure compute extraction з async rule resolver, backend hot-loop Intl construction, tenant-guard + side-entity parallel.
Latest tester: 2026-05-30 (FULL, HEAD e189793 → 66eb6e3) — повний прогін після review-сесії c1dc5dd (PO apply-pricing N+1 + status guard + catalog cache fromCache). **3 баги виправлено** (всі test-coverage; production-логіка c1dc5dd коректна). Baseline: API tsc/web tsc/shared tsc 0 errors ✅, web 179/179 ✅, **API 398/403 ❌ — release-blocker baseline**: 5 фейлів у `purchase-orders.service.spec.ts` після рефактору c1dc5dd. #200 HIGH process — stale spec (Bug #187 регресія): моки `findFirst` НЕ мали поля `status` → новий status guard `if (po.status !== RECEIVED && po.status !== PARTIAL) throw BadRequestException` кидав на ВСЕ fixtures → 5/6 тестів падали з `BadRequestException: Розцінити можна лише отримані товари ...`. Плюс рефактор замінив `pricingService.calculateSalePrice(...)` на нові публічні `getActiveRulesForOrg` + `computePriceFromRules`, але мок ще був на старий метод. Фікс: додав `status: PurchaseOrderStatus.RECEIVED` у всі fixtures, замінив pricing-mock на нові методи, додав 2 status-guard тести (DRAFT → throws, PARTIAL → success). 8/8 passed. #201 MEDIUM test-coverage — нові публічні методи `computePriceFromRules` і `getActiveRulesForOrg` (c1dc5dd) без жодного unit-тесту. Фікс: +12 тестів у `pricing.service.spec.ts` — 10 для `computePriceFromRules` (PERCENT/FIXED_AMOUNT/FIXED_PRICE/COMPETITOR_PLUS/COST_TIER усі гілки + roundTo + Math.max(0) + empty rules + priority hierarchy + brand-over-type) + 2 для `getActiveRulesForOrg` (асерт where shape + orderBy + take + include). 32/32 passed. #202 MEDIUM api-contract — `purchase-orders.contract.spec.ts` не покривав новий status guard на HTTP-рівні. Фікс: +1 contract тест «status guard: 400 коли service кидає BadRequestException» з асертом `res.statusCode === 400` + укр. message матч. 6/6 contract passed. **Після фіксів: tsc clean + 419/419 API + 179/179 web.** SKILL-патерн "stale spec after refactor" (2026-05-27) вже у накопичених підходах — повторне підтвердження.
Latest review: 2026-05-30 (AUTO, HEAD 0b5c89c → c1dc5dd) — review останніх 9 коммітів сесії (catalog/calendar/WO/PO ref-cache + invoices payForm fix + crm vehicle race + nav prefetch + /settings active route + xlsx MIME types + PO Розцінити в DetailPanel). **3 проблеми виправлено:** (1) CRITICAL — `purchase-orders.service.applyPricing` мав N+1 + missing transaction timeout: `calculateSalePrice` всередині for-loop робив окремий `findMany pricingRule` ПЛЮС окремий `$transaction([...])` (без timeout) на кожну лінію PO. PO з 50 лініями = 50 окремих TX + 50 fetch правил → потенційний default-5s timeout на велике PO, перевантаження connection pool. Фікс: prefetch правил один раз через нову `pricingService.getActiveRulesForOrg(orgId)`, compute у пам'яті через щойно зроблений public `pricingService.computePriceFromRules`, batch updates у `$transaction` з explicit `{ timeout: 10_000 }` (chunks по 100 — як уже працює `applyRuleToGoods`). (2) IMPORTANT — `applyPricing` без status guard на бекенді: UI рендерить кнопку «Розцінити» лише для RECEIVED/PARTIAL, але клієнт міг бути обійдений (curl POST → можна розцінити DRAFT/ORDERED/CANCELLED). Defense-in-depth: додано `if (po.status !== RECEIVED && po.status !== PARTIAL) throw BadRequestException`. (3) SUGGESTION — `catalog UnitsTab/BrandsTab.load()` сидив cached список і ПІСЛЯ mutations (POST/DELETE → load()), показуючи STALE дані на 200-500ms до приходу свіжого fetch. Фікс: `load({ fromCache?: boolean })` — `useEffect` передає `true`, mutations передають дефолтно `false`. Інші зміни сесії перевірено OK: invoices payForm functional update коректно уникає infinite loop; CRM detail-panel vehicle fetch має cancelled flag; calendar/work-orders/purchase-orders ref-cache seed з mountedRef guards; TopShell prefetch={true} + isActive exact-match для /settings; xlsx MIME types додано для Windows.
Latest review: 2026-05-30 (AUTO, HEAD 0b5c89c → c1dc5dd) — review останніх 9 коммітів сесії (catalog/calendar/WO/PO ref-cache + invoices payForm fix + crm vehicle race + nav prefetch + /settings active route + xlsx MIME types + PO Розцінити в DetailPanel). **3 проблеми виправлено:** (1) CRITICAL — `purchase-orders.service.applyPricing` мав N+1 + missing transaction timeout: `calculateSalePrice` всередині for-loop робив окремий `findMany pricingRule` ПЛЮС окремий `$transaction([...])` (без timeout) на кожну лінію PO. PO з 50 лініями = 50 окремих TX + 50 fetch правил → потенційний default-5s timeout на велике PO, перевантаження connection pool. Фікс: prefetch правил один раз через нову `pricingService.getActiveRulesForOrg(orgId)`, compute у пам'яті через щойно зроблений public `pricingService.computePriceFromRules`, batch updates у `$transaction` з explicit `{ timeout: 10_000 }` (chunks по 100 — як уже працює `applyRuleToGoods`). (2) IMPORTANT — `applyPricing` без status guard на бекенді: UI рендерить кнопку «Розцінити» лише для RECEIVED/PARTIAL, але клієнт міг бути обійдений (curl POST → можна розцінити DRAFT/ORDERED/CANCELLED). Defense-in-depth: додано `if (po.status !== RECEIVED && po.status !== PARTIAL) throw BadRequestException`. (3) SUGGESTION — `catalog UnitsTab/BrandsTab.load()` сидив cached список і ПІСЛЯ mutations (POST/DELETE → load()), показуючи STALE дані на 200-500ms до приходу свіжого fetch. Фікс: `load({ fromCache?: boolean })` — `useEffect` передає `true`, mutations передають дефолтно `false`. Інші зміни сесії перевірено OK: invoices payForm functional update коректно уникає infinite loop; CRM detail-panel vehicle fetch має cancelled flag; calendar/work-orders/purchase-orders ref-cache seed з mountedRef guards; TopShell prefetch={true} + isActive exact-match для /settings; xlsx MIME types додано для Windows.
Latest optimize: 2026-05-30 (HAR analysis з користувача) — користувач переслав `Аналіз.txt` (curl-export з DevTools Network panel) з ствердженням що settings/dashboard/employees/calendar/crm роблять подвійні API виклики на mount. **Висновок:** реальних дублів у коді **немає** — всі сторінки використовують Promise.all/cancelled-flag/ref-cache коректно (verified settings/page.tsx 2 useEffect з [] deps, dashboard.tsx Promise.allSettled, employees.tsx loadReference + filter-only load split). Що бачив користувач у HAR — це CORS preflight (`-X 'OPTIONS'` з `Access-Control-Request-Method: GET`) + actual GET, тобто 2 запити на endpoint, але другий — це сам preflight браузера, не дубль fetch у коді. **2 фікси:** (1) HIGH IMPACT — `apps/api/src/main.ts:51` `enableCors({ origin, credentials: true })` без `maxAge` → браузер не кешує preflight → кожен autenticated GET = 2 RTT (OPTIONS + GET). Фікс: +`maxAge: 86400` (Chrome cap 7200s, інші ≤86400s). У dev (3001→3000) на дашборді 5 fetches: 10 RTT → 5 RTT після першого. (2) LOW — `settings/page.tsx:244` `apiFetch('/branches')` без `getCached` seed → workdays tab показує порожній select до cold-fetch. Фікс: seed `cache:branches` на старті useEffect + `setCache` після fresh fetch. SKILL оновлено: +1.7 чек CORS maxAge, +2 нових "Накопичених підходи" (HAR OPTIONS-vs-duplicate і consumer-page ref-cache seed).
Latest tester: 2026-05-30 (FULL, HEAD 91bafc8 → pending) — повний прогін по фічі e754ad4 (PO apply-pricing + xlsx apply-pricing-from-list + pricing-list template + frontend кнопка/секція). Baseline зелений (401/401 API + 179/179 web), `[x]`-маркери попередньої сесії b1a083c — реально застосовані у коді (не docs-only). **3 нових баги виправлено:** #197 CRITICAL — `PricingRulesClient.tsx:626` `apiFetch<PricingImportResult>('/xlsx/apply-pricing-from-list', { method:'POST', body: fd })` де `fd = new FormData()`. `apiFetch` ЖОРСТКО додає `Content-Type: application/json` → browser НЕ виставляє `multipart/form-data; boundary=...` → `fastify-multipart` кидає «not multipart» → upload завжди валиться 400/406. **Уся клієнтська фіча e754ad4 не працює у проді.** Фікс: заміна на `apiMultipartFetch<PricingImportResult>('/xlsx/apply-pricing-from-list', fd)` + додано імпорт. Інші upload-точки проєкту (xlsx-import-button, settings, work-orders media) уже використовують `apiMultipartFetch` — це була єдина регресія. #198 HIGH — `xlsx.service.ts applyPricingFromList`: `costPrice = Number(good.purchasePrice ?? 0)` для товарів без `purchasePrice` (схема `Decimal?`) → `calculateSalePrice` для PERCENT/COMPETITOR_PLUS/COST_TIER повертає `0 * (1 + p/100) = 0` → **`Good.salePrice` затирається у 0** без помилки. Silent data corruption: користувач завантажує список з 100 SKU → 30 товарів без cost отримують ціну 0 грн → запис у PriceHistory `oldPrice=130, newPrice=0`. Фікс: prep-guard `if (good.purchasePrice == null || Number(good.purchasePrice) <= 0)` → пушає `${sku} (без собівартості)` у `notFound[]` + `continue` без виклику `calculateSalePrice`. Додано 2 нові тести у `xlsx.service.spec.ts` (12/12 passed). #199 MEDIUM — `purchase-orders/page.tsx applyPricing`: `catch (e) { if (features.toastEnabled) toast.error(...) }` → користувачі з `toastEnabled=false` нічого не бачать. Фікс: `setError(msg)` завжди + toast як додаток. Унmount race — залишено LOW (warning у dev console, не критично). Після фіксів: tsc api+web+shared 0 errors, **403/403 API + 179/179 web**. SKILL оновлено: §1.1 +чек nullable cost-input → data corruption, §1.3 +чек apiFetch+FormData → CRITICAL, +2 нових "Накопичених підходи".
Latest review: 2026-05-30 (AUTO, HEAD a24b4dc → pending) — повний review повного scope сесії (Pricing brand+COST_TIER + UserPreference + AnimatedBody + DataTable revert + SaveFilterButton + useColumnDrag + Modal sizes + page-container 96rem + PO apply-pricing + xlsx apply-pricing-from-list). **3 проблеми виправлено:** (1) IMPORTANT — `useColumnDrag.ts` використовував `React.DragEvent` і `React.CSSProperties` namespace types → §1 TypeScript violation (skill вимагає named imports з 'react'). Фікс: `import { type DragEvent, type CSSProperties } from 'react'`. Паралельно user/linter додав 3-й параметр `allColumns: { key }[]` щоб preserve hidden-column slot positions при drag — оновлено 9 call-sites (catalog x3, crm/employees/work-orders/invoices/stock-documents/purchase-orders x1 кожен) щоб передавати `orderedColumns`. (2) IMPORTANT — `pricing-rules.controller.ts` PATCH і DELETE використовували `prisma.pricingRule.update({ where: { id } })` без orgId у where → defense-in-depth tenant guard відсутній (хоч `existing` findFirst раніше перевіряв orgId, race-window між findFirst і update теоретично можливий якщо інша сесія soft-delete-ує правило). Фікс: заміна на `updateMany({ where: { id, orgId, deletedAt: null } })` + окремий `findFirstOrThrow` для повернення з include для PATCH; DELETE використовує `updateMany.count === 0` для 404 (Bug #191 pattern). Тест-мок оновлено: `pricingRule.updateMany` + `pricingRule.findFirstOrThrow`. (3) SUGGESTION — `pricing.service.ts` `orConditions.push({ goodId: null, brandId, good: undefined })` — `good: undefined` dead code (не фільтрує нічого). Фікс: прибрано. **Підтвердження:** API tsc ✅ 0 errors, Web tsc ✅ 0 errors, pricing-rules+pricing.service tests 35/35 passed, цілий блок (user-preferences + xlsx + purchase-orders + inventory) 103/103 passed, web tests (modal+saved-filters+useDetailPanelConfig) 50/50.
TypeScript: ✅ 0 errors (web + api + shared) — після SaveFilterButton/hideSaveButton/AnimatedBody/Modal size test coverage (verified 2026-05-30, HEAD b04e879)
Unit+Contract: ✅ 401/401 passed (39 файлів) — без змін за сесію (test-coverage додано лише у web suite)
Web component suite: ✅ 179/179 passed (15 файлів) — +20 за сесію (saved-filters-bar +11 [8 SaveFilterButton + 3 hideSaveButton], modal +9 [5 size prop + 4 AnimatedBody])
Latest tester: 2026-05-30 (FULL, HEAD c922503 → b04e879) — UI зміни 5 коммітів (SaveFilterButton + hideSaveButton + AnimatedBody inline forms + Modal sizes lg/xl + page-container 80→96rem). **4 баги виправлено** (test-coverage only — production-код був коректним). #193 MEDIUM — новий `SaveFilterButton` shared-компонент (icon-only bookmark, inline input при кліку, 8 prod-сторінок) без жодного component-тесту → регресія беззвучна. Фікс: `describe('SaveFilterButton')` x8 кейсів (icon+title a11y, click→open, Enter trim+close, Save click, whitespace disabled, Escape resets, X-button closes, className). #194 MEDIUM — новий `hideSaveButton` prop у `SavedFiltersBar` (8 production-використань) без покриття; інверсія guard `!hideSaveButton` → `!!hideSaveButton` проходить existing-suite зеленою. Фікс: +3 кейси (hides inline-Зберегти, hides "Немає збережених фільтрів" hint, preserves preset+remove buttons). #195 LOW — `AnimatedBody` тепер експортується standalone і використовується у 6 inline-форм (catalog/crm/crm[id]/vehicles[id]/work-orders[id]/pricing-rules) поза Modal; regression cleanup (ResizeObserver.disconnect + cancelAnimationFrame) була непокрита. Фікс: `describe('AnimatedBody (standalone)')` x4 (standalone render, className passthrough, cleanup chains disconnect+cancelAnimationFrame на unmount, Modal-integration smoke). #196 LOW — Modal `size` prop (`sm/md/lg/xl/full`) визначає max-width inline-style, але regression Record-key swap (lg↔xl) проходила зеленою. Фікс: +5 кейсів (md=512px default, sm=384px, lg=672px [employees/catalog works/stock-documents], xl=896px [work-orders/catalog goods/purchase-orders/pricing-rules], full=95vw). Після фіксів: tsc api+web 0 errors, 401/401 API + 179/179 web.
Latest tester: 2026-05-30 (AUTO, HEAD 91b54b9 → b1a083c) — PO розцінка + XLSX/CSV pricing import (e754ad4 + cef188a). **6 багів виправлено** (5 test-coverage + 1 i18n/api-contract; production-логіка коректна). Baseline зелений (376/376 API + 159/159 web). #187 HIGH — `applyPricing` у purchase-orders.service зовсім без unit-тестів (нуль regression-захисту для PO not found, PO empty lines, no-change skip, change writes). Фікс: `purchase-orders.service.spec.ts` (6 тестів). #188 HIGH — `applyPricingFromList` у xlsx.service без unit-тестів (CSV BOM/headers, XLSX worksheets, товар не знайдено, no-change). Фікс: `xlsx.service.spec.ts` (10 тестів — CSV/XLSX/template). #189 MEDIUM — controller `POST /purchase-orders/:id/apply-pricing` без contract-spec. Фікс: `purchase-orders.contract.spec.ts` (5 тестів — 201 ok, 400 invalid UUID, 403 no JWT, 404 not found, empty details). #190 MEDIUM — controller `xlsx` нові endpoints (templates/pricing-list + apply-pricing-from-list) без contract-spec. Фікс: `xlsx.contract.spec.ts` (4 тести — template 200/400/403 + multipart-missing 400). #191 LOW — defense-in-depth: `prisma.good.update({ where: { id } })` без `orgId` у `applyPricing` обох сервісів (хоча id уже org-trusted через parent read). Фікс: заміна на `updateMany({ where: { id, orgId, deletedAt: null } })` у обох службах. #192 MEDIUM (виявлено через contract-test) — `xlsx.controller.getUploadedFile` пропускав FastifyError "the request is not multipart" → клієнт отримував HTTP 406 з англ. messageом замість 400+UA. Фікс: try/catch у helper мапить FastifyError у `BadRequestException` українською; покриває всі 7 multipart-endpoints одночасно. Після фіксів: tsc api+web+shared 0, 401/401 API + 159/159 web, nest build OK. SKILL оновлено: §1.1 +чек defense-in-depth `updateMany`, §1.2 +чек multipart try/catch, +2 нових "Накопичених підходи".
Previous tsc state (after #184-#186):
Latest tester: 2026-05-30 (FULL, HEAD 5b4eafc → b39a25f) — Етапи A-D повне тестування. **3 баги виправлено** (test-coverage only — production-код був коректним). #184 MEDIUM — `pricing.service.spec` COST_TIER edge cases відсутні (empty tiers, cost=0, cost точно на верхній/нижній межі); фікс: +4 тести (19/19). #185 MEDIUM — `useDetailPanelConfig` без unit-тесту (юзер явно запросив); фікс: `useDetailPanelConfig.test.tsx` +11 тестів (optimistic localStorage read, API success/error, toggle/reset + PUT, rapid-toggle AbortController, різні pageKey). #186 MEDIUM — `pricing-rules.contract.spec` без `brandId` cross-tenant перевірки (новий FK без regression-захисту, той самий патерн Bug #161); фікс: +3 тести (POST own-org→201, POST other-org→404, PATCH other-org→404). Усі 3 — test-only, prod-код не чіпали.
Latest review: 2026-05-30 (AUTO, HEAD c353de7 → 93ccc25) — Етапи A-D повний code review (pricing brand/COST_TIER + AnimatedBody + configurable detail panel + user-preferences). **5 проблем виправлено:** (1) CRITICAL — `pricing-rules.controller.ts` PATCH `brandId` залишався з `existing.brandId` навіть коли `normalizeScope` його очищав через goodId-пріоритет → правило могло мати goodId+brandId одночасно (порушення взаємної виключності scope-полів). Фікс: `brandId: normalized.brandId ?? null` (той самий патерн, що goodId/goodCategory/goodType). (2) CRITICAL — `AnimatedBody` (modal.tsx) `requestAnimationFrame` без id-capture + без cancel при unmount → rapid toggle/unmount лишав pending rAF що мутував `.style.transition` після disconnect. Фікс: `rafRef` + `cancelAnimationFrame` у RO-cleanup. (3) IMPORTANT — `useDetailPanelConfig` useEffect без cancelled-flag, fire-and-forget PUT без AbortController → race on unmount + рапідні toggle-PUTs могли резолвитись out-of-order. Фікс: cancelled-flag, mountedRef, AbortController-ref що abort-ить попередній PUT, окремий unmount-effect. (4) IMPORTANT — `user-preferences.controller.ts` `@Param('key')` не валідувався → 10KB-рядок у URL потрапляв у Prisma. Додано `ensureValidKey()` guard (MaxLength 200) + 400 якщо `dto.key !== :key`. (5) IMPORTANT — PATCH `pricing-rules` при перемиканні `type` з COST_TIER → старі тіри лишались у БД як "mertvyi vantazh" і "відроджувались" при поверненні на COST_TIER. Фікс: `switchedAwayFromCostTier` → `tiers.deleteMany` у тій самій транзакції. **Підтвердження:** API tsc ✅ 0 errors, Web tsc ✅ 0 errors, pricing.service.spec 19/19, user-preferences.contract.spec 7/7.
Previous sync-audit: 2026-05-30 (Етапи A-D) — **0 розбіжностей.** Dir1: user-preferences без окремої сторінки — норма (хук-only). Dir2: `/pricing-rules`, `/brands` (shape `{items,total}` вже виправлено у Bug #181), `/user-preferences/:key` GET+PUT — всі URL коректні. Dir3: PricingRule interface ≡ toDto() (brandId/brandName/tiers — optional у interface, але завжди присутні у response — не баг); UserPreference `{key,value}` — shape коректний, guard `'hiddenFields' in res.value` захищає від порожнього `{}`. PUT body `{key,value}` ≡ UpsertUserPreferenceDto. AnimatedBody imports — всі 6 файлів імпортують з `@/components/ui/modal`, URL не змінювались. tsc web+api ✅ 0 errors.
Latest tester: 2026-05-30 (AUTO, HEAD 5d003e4 → c353de7) — Етап D configurable detail panel. **2 баги виправлено.** #182 HIGH — `UpsertUserPreferenceDto.value` поле без `@IsObject()` → whitelist:true знімав його з body → `dto.value === undefined` → Prisma записувала `undefined`. Фікс: `@IsObject()` на `value`. #183 MEDIUM — відсутній `user-preferences.contract.spec.ts` → +7 тестів (GET 200/{key,value}/empty/403, PUT 204/400-missing/400-non-object/403). Після фіксів: tsc 0 errors, 369/369 API tests + 148/148 web tests.
Latest tester: 2026-05-30 (AUTO, HEAD aa7ca6e) — AnimatedBody inline forms Етап C. **0 нових багів у scope.** 6 секцій у 5 файлах анімовані: showAddNode+showAddSchedule (vehicles/[id]), showInspection (work-orders/[id]), showAddVehicle (crm/page), showAddBarcode (catalog/page), showAddGarage (crm/[id]). ResizeObserver вже застабований (Bug #177). API 362/362 + Web 148/148 baseline ✅.
Previous tester: 2026-05-30 (AUTO, HEAD 21a356e → 21587cf)
Latest review: 2026-05-30 (auto, HEAD fdcf7ea → 23bf19c) — pricing brand+COST_TIER backend. 2 Important fixes: (1) `cleanValuesForType` не мав `case 'COST_TIER'` → при збереженні COST_TIER правила старі `percentValue`/`fixedAmount`/`fixedPrice` лишались у БД; (2) `$transaction(async tx)` для replace-semantics тірів без `{ timeout: 10_000 }`. 1 IMPORTANT структурне: `@@index([orgId, brandId])` відсутній у PricingRule (нове FK поле без індексу). Всі виправлено у 23bf19c. tsc 0 errors, 357/357 tests.
Latest tester: 2026-05-30 (AUTO, HEAD 21a356e → 21587cf) — pricing brand+COST_TIER UI. **1 баг виправлено:** #181 MEDIUM frontend — `apiFetch<Brand[]>('/brands')` очікував голий масив, але endpoint повертає `{ items, total }` (стандарт STO ERP) → `brands.map()` TypeError → бренди не завантажувались у Select. Фікс: `apiFetch<{ items: Brand[]; total: number }>('/brands').then(r => setBrands(r.items))`. Після фіксу: tsc 0 errors, 362/362 + 148/148 ✅.
Previous tester: 2026-05-30 (AUTO, HEAD fdcf7ea+23bf19c → e7b0cbf) — pricing brand+COST_TIER backend. **3 баги виправлено:** #178 HIGH business-logic — `applyRuleToGoods` не фільтрував товари по `brandId` коли правило brand-scoped → всі товари org перераховувались; #179 MEDIUM test-coverage — 0 тестів для COST_TIER типу і brandId пріоритету; #180 MEDIUM business-logic — `normalizeScope` не очищала `brandId` при заданому `goodId` (порушення ієрархії priority 1>2). Після фіксів: tsc 0 errors, 362/362 tests (+5 нових COST_TIER+brandId).
Latest review: 2026-05-30 (auto, HEAD a6f9aea → b5add44) — AnimatedBody export + calendar collapse refactor + sto-dev §14.4. **1 Important fix:** close-branch `requestAnimationFrame` не зберігав id → неможливо скасувати при rapid re-open/unmount → stale rAF писав height=0 на щойно відкриту форму; `formHideTimerRef` і новий `formCloseRafRef` не мали unmount-cleanup. Виправлено: id-capture у `formCloseRafRef`, `cancelAnimationFrame` на старті ефекту і в окремому unmount-only useEffect; ResizeObserver-cleanup і так був коректний (disconnect у return). Перевірено `AnimatedBody`: rAF guard через `if (outerRef.current)` достатній (ref → null після detach), RO.disconnect у cleanup ✓.
Latest tester: 2026-05-30 (FULL, HEAD f2410ae → b5add44+a6f9aea+eb16f51+f2410ae) — AnimatedBody export + calendar ResizeObserver/close-rAF refactor. **1 Bug #177 HIGH** виправлено: `apps/web/src/__tests__/setup.ts` НЕ стабав `ResizeObserver` → 9 modal.test.tsx падали при mount (`AnimatedBody` нового модалу використовує `new ResizeObserver`). Baseline був ❌ Web 139/148. Фікс: noop-стаби `ResizeObserver` + `IntersectionObserver` під guard `typeof globalThis.X === 'undefined'`. tsc не ловить (типи в `lib.dom.d.ts`), prod browser має API нативно — суто jsdom-polyfill. Після фіксу: API 357/357 + Web 148/148 ✅. Додано до SKILL.md: §1.6 jsdom-stub чек-ліст + §1.3 grep + новий "Накопичений підхід" про browser-API без jsdom-стабу.
Previous tester: 2026-05-29 (AUTO, HEAD fa83635 → 613aef7+561e08b+fc0d1ad+fa83635) — CRM Наряди + Catalog Штрихкоди/Партії ModalTabs. **0 нових багів у scope.** API 357/357 + Web 148/148 baseline ✅. Перевірено: race-guard у обох openEdit (`modalVehiclesReqRef`+`modalWoReqRef` у CRM, `modalBarcodeReqRef`+`modalBatchReqRef` у Catalog) — окремі токени для кожного асинхронного джерела, гейт на КОЖНОМУ `.then`/`.catch`/`.finally`; `setModalGarageId` всередині early-return guard'у (не виставляється з stale-даними); StockBatchDto `.items` unwrap після 561e08b узгоджений з бекенд `{items,total}` shape; `/work-orders?counterpartyId=` filter присутній у DTO+service з tenant-isolation; усі 10 WorkOrderStatus покриті у WO_STATUS_LABELS/BADGE; inline add/delete барcode у ModalTabs з guard `if (!editGood) return` + try/catch + toast feedback; error-state не silent (видимий inline у ModalTabs контенті).
Previous review: 2026-05-29 (auto, HEAD fc0d1ad → 613aef7+561e08b+fc0d1ad) — crm/page.tsx Наряди-таб + catalog/page.tsx Штрихкоди+Партії-таби + sto-dev §14.1–14.3. **0 проблем знайдено**: race-guard ref (modalWoReqRef, modalBarcodeReqRef, modalBatchReqRef) застосовано згідно патерну з e69bf1e; reset похідного стану на старті openEdit/openEditGood; всі 10 WorkOrderStatus покриті у WO_STATUS_LABELS/BADGE; катаlог не імпортує `cn` (не потрібний); BOM-чистий; немає React.X / any / console.log / Tailwind anti-patterns.
Previous review: 2026-05-29 (auto, HEAD e69bf1e) — modal-tabs.tsx + crm/employees ModalTabs + counterparties showDeleted/deletedAt. 1 Important fix (CRM edit-modal vehicle fetch race + stale modalGarageId). Backend DTO/service вже коректні після cc44f73 (showDeleted @Transform, orgId зберігається при showDeleted=true, toDto включає deletedAt).

## UI: ModalTabs — нижній таб-секція модалок для 1→N зв'язків (6b886ae)

`apps/web/src/components/ui/modal-tabs.tsx` — SSR-safe (no window/document), кнопки `type="button"`, canonical Tailwind tokens (border-border, text-primary, bg-secondary). Використовується у crm (Авто клієнта) та employees (Зони/Підйомники/Категорії/Філії) edit-модалках. `key={tab.key}` стабільний.

**CRM edit-modal gotcha (e69bf1e):** `openEdit` робить fetch гаражів+авто в обробнику події (не useEffect) → потрібен request-token ref щоб повільніший fetch попереднього CP не перезаписав поточний; `modalGarageId` скидати на `null` при відкритті (інакше addVehicle POST-ить у чужий гараж при fetch failure).

## UI: useDirtyForm — async confirmClose + DirtyConfirmDialog (921afb7)

`useDirtyForm` переписаний — `confirmClose()` тепер `Promise<boolean>`, не `boolean`.

**Що змінилось:**
- `confirmClose(): Promise<boolean>` — показує власний `ConfirmDialog`, не `window.confirm()`
- `dialogProps: { open, onConfirm, onCancel }` — spread на `<DirtyConfirmDialog>`
- Новий компонент `apps/web/src/components/ui/dirty-confirm-dialog.tsx`

**Паттерн використання:**
```ts
const dirty = useDirtyForm({ enabled: features.unsavedGuardEnabled });

// В функціях — await:
const closeModal = async () => {
  if (!(await dirty.confirmClose())) return;
  setShowModal(false);
};

// В Modal onClose — async arrow:
onClose={async () => { if (!(await dirty.confirmClose())) return; setModal(false); }}

// В JSX — додати компонент:
<DirtyConfirmDialog {...dirty.dialogProps} />
```

**Gotcha:** `onClose` пропc Modal — тип `() => void`, але async arrow `async () => void` сумісний (Promise<void> assignable to void). TypeScript не скаржиться.

**Файли оновлені:** catalog, crm, employees, invoices, purchase-orders, stock-documents, work-orders/[id]/PageClient

---

## UI: Бокова інформаційна панель — detail panel system (f529d0f)

**Нові хуки/компоненти:**
- `apps/web/src/hooks/useDetailPanel.ts` — `useDetailPanel(key)` → `{ enabled, toggle }`, зберігає в localStorage
- `apps/web/src/components/ui/detail-panel-toggle.tsx` — `<DetailPanelToggle>` кнопка поруч з `ColumnsDropdown`
- `DetailPanel` оновлений — `tabs?: DetailPanelTab[]`, `subtitle?`, відступ `ml-3 rounded-xl border`
- `PanelField` / `PanelSection` — хелпери для вмісту панелі

**Паттерн:**
```tsx
const detailPanel = useDetailPanel('page-key');
// В рядку фільтрів:
<div className="flex items-center gap-2 ml-auto">
  <DetailPanelToggle enabled={detailPanel.enabled} onToggle={detailPanel.toggle} />
  <ColumnsDropdown ... />
</div>
// Клік на рядок — тільки якщо enabled:
onClick={() => { if (detailPanel.enabled) setSelected(item); }}
// Панель:
<DetailPanel open={!!selected && detailPanel.enabled} title={...} tabs={buildTabs(selected)} ... />
```

**По сторінках:**
| Сторінка | Вкладки панелі |
|---|---|
| employees | Основне · Зони/Підйомники |
| crm | Основне · Авто (реальні авто клієнта з API) |
| invoices | Основне · Позиції |
| purchase-orders | Основне · Позиції |
| stock-documents | Основне · Позиції |
| catalog/works | Основне |
| catalog/goods | Основне · ШК · Партії (існуючі вкладки) |
| catalog/services | Основне · Роботи (N) · Товари (N) |

---

## UI: Конфігуратор колонок — useTableColumns рефакторинг (da693b7)

**Архітектурне рішення:** `useTableColumns` є єдиним власником порядку і назв колонок. `ColumnsDropdown` — чистий UI без localStorage.

**useTableColumns повертає:**
```ts
{
  visibleKeys,    // Set — для допоміжних перевірок
  visibleColumns, // ← ПО ЦЬОМУ рендерь TableHead і TableCell (порядок і label вже правильні)
  orderedColumns, // ← ЦЕ передавай в ColumnsDropdown
  order, customLabels,
  toggle, reorder, renameColumn, resetConfig
}
```

**localStorage keys:** `sto_columns_<key>` (visible), `sto_col_order_<key>`, `sto_col_labels_<key>`

**ColumnsDropdown props:**
```tsx
<ColumnsDropdown
  columns={orderedColumns}        // НЕ COLUMNS — вже з user order і label
  visibleKeys={colVisible}
  onToggle={toggleCol}
  onReorder={reorder}
  onRename={renameColumn}
  onReset={resetConfig}
  hasCustomization={JSON.stringify(order) !== JSON.stringify(COLUMNS.map(c=>c.key)) || Object.keys(customLabels).length > 0}
/>
```

**❌ Старий паттерн (не використовувати):**
```tsx
{colVisible.has('name') && <TableHead>Назва</TableHead>}
colSpan={colVisible.size + ...}
```

**✅ Новий паттерн:**
```tsx
{visibleColumns.map(col => <TableHead key={col.key}>{col.label}</TableHead>)}
{visibleColumns.map(col => { if (col.key==='name') return <TableCell key="name">...</TableCell>; return null; })}
colSpan={visibleColumns.length + ...}
```

---

## Gotcha — UpdateCounterpartyDto не має поля type (1f260e1)

`UpdateCounterpartyDto` не містить `type` — тип контрагента immutable після створення.
`forbidNonWhitelisted: true` → 400 якщо передаєш `type` в PATCH `/counterparties/:id`.
**Рішення:** прибрати `type` з тіла PATCH запиту.

---

## UI: Управління колонками — розповсюджено на 6 сторінок (2026-05-29)

`useTableColumns` + `ColumnsDropdown` тепер є на **всіх** сторінках-списках (раніше тільки work-orders):

| Сторінка | Ключ localStorage | Прихованих за замовч. |
|---|---|---|
| `employees` | `sto_columns_employees` | rate, zones, lifts |
| `crm` | `sto_columns_crm` | edrpou |
| `invoices` | `sto_columns_invoices` | — |
| `purchase-orders` | `sto_columns_purchase-orders` | — |
| `stock-documents` | `sto_columns_stock-documents` | — |
| `catalog-works` | `sto_columns_catalog-works` | — |
| `catalog-goods` | `sto_columns_catalog-goods` | unit |
| `catalog-services` | `sto_columns_catalog-services` | — |

**Паттерн** (COLUMNS — не включають чекбокс bulk і кнопки дій):
```ts
const COLUMNS = useMemo(() => [{ key: 'name', label: 'Назва', defaultVisible: true }], []);
const { visibleKeys: colVisible, toggle: toggleCol } = useTableColumns('page-key', COLUMNS);
// colSpan: colVisible.size + (features.bulkActionsEnabled ? 2 : 1)
```

## UI: Збережені фільтри + Групові дії + Захист змін — розповсюджено на 6 сторінок (2026-05-29)

Три UI-фічі керовані через `useUiFeatures()` (`savedFiltersEnabled`, `bulkActionsEnabled`, `unsavedGuardEnabled`) тепер є на **всіх** сторінках-списках:

| Сторінка | Збережені фільтри | Групові дії | Захист змін |
|---|---|---|---|
| `work-orders` | ✅ (еталон) | ✅ (еталон) | ✅ (еталон) |
| `employees` | search+role+showDeleted | Видалити/Звільнити | create+edit |
| `crm` | search+type+showDeleted | Видалити | create |
| `invoices` | search+status | Скасувати | create |
| `purchase-orders` | status+search+showDeleted | Видалити | create+receive |
| `stock-documents` | type+status+showDeleted | Видалити | create |
| `catalog` | search/tab (works/goods/services) | Видалити (кожна вкладка) | 5 форм |

**Готові хуки/компоненти** (не треба писати з нуля):
- `apps/web/src/hooks/useSavedFilters.ts` — localStorage пресети фільтрів
- `apps/web/src/hooks/useBulkSelect.ts` — Set-based вибір рядків
- `apps/web/src/hooks/useDirtyForm.ts` — захист форми від втрати змін (sync `confirmClose()`)
- `apps/web/src/components/ui/saved-filters-bar.tsx` — UI панель пресетів
- `apps/web/src/components/ui/bulk-actions-bar.tsx` — UI панель групових дій

**Паттерн підключення** (дивись `work-orders/page.tsx` рядки 155-200, 424-570 як еталон):
```ts
const features = useUiFeatures();
const { saved, save, remove } = useSavedFilters<Filters>('page-key');
const bulkSelect = useBulkSelect(items);
const dirty = useDirtyForm({ enabled: features.unsavedGuardEnabled });
```

**Перемикачі** в Налаштування → Інтерфейс — діють для всієї організації.

## UI: Toast-сповіщення в calendar/page.tsx (8346b16)

`apps/web/src/app/calendar/page.tsx` тепер використовує `toast` з `@/lib/toast` замість inline `setError`:
- `toast.success` — створення/оновлення/видалення слоту, створення наряду
- `toast.warning` — drag/resize у минулий час або день
- `toast.error` — всі API помилки
- Валідаційні помилки **всередині форми** лишилися inline (поряд з полями)

**Toast-система** (`@/lib/toast` + `ToastContainer` у `TopShell`) вже підключена. Додавати на нові сторінки просто: `import { toast } from '@/lib/toast'`.

## UI: Анімація форми в calendar/page.tsx (e1bf870)

Двошарова анімація відкриття/закриття панелі слоту:
- Зовнішній wrapper: `max-height 0→900px`, spring `cubic-bezier(0.22,1,0.36,1)` 480ms
- Внутрішня панель: `opacity + translateY`, з затримкою 60ms (stagger)
- Закриття: 280-320ms ease-in, unmount через 420ms

Паттерн: `showAdd` → `formMounted` (монтування) + `formVisible` (CSS стан) через double-rAF.

## Fix: calendar counterpartyId збереження (5a0515c)

**Проблема:** `CalendarSlot` має пряме поле `counterpartyId` в БД (міграція `20260529120000`), але до фіксу воно не зберігалось і не поверталось.

**Що виправлено:**
- `calendar.service.ts`: `toDto()` тепер повертає `counterpartyId` (зі слоту або fallback з `workOrder.counterpartyId`); всі три методи (`findSlots`/`createSlot`/`updateSlot`) include `counterparty` напряму
- `calendar.dto.ts`: `CalendarSlotResponseDto` має поле `counterpartyId`
- `calendar/page.tsx`: `handleEditSlot` відновлює `counterpartyId` зі слоту; валідація дозволяє `workOrderId` як альтернативу; `disabled` кнопки враховує обидва поля

**Gotcha:** якщо API сервер запущений до змін коду і `nest start --watch` не підхопив нові файли — `counterpartyId` не буде в response навіть якщо код правильний. Перевіряти через `Get-NetTCPConnection -LocalPort 3000 | Select OwningProcess` і дату запуску процесу vs дату останнього зміненого файлу.

## UI: AnimatedBody — плавна зміна висоти (b5add44)

`AnimatedBody` (ResizeObserver + overflow:hidden outer + transition:height inner) вбудований у `<Modal>` та тепер **експортується** з `apps/web/src/components/ui/modal.tsx`.

- **Всі `<Modal>` компоненти** анімують висоту автоматично — нічого додаткового не потрібно.
- **Поза Modal** (accordion, collapsible panel) — імпортувати `AnimatedBody` або копіювати паттерн з refs.
- **calendar/page.tsx форма слоту** — замінено `maxHeight: '900px'` magic number на ResizeObserver-driven height (outer `formCollapseRef` + inner `formInnerRef`). Тепер форма коректно розширюється коли відкривається "Новий наряд" mini-form.
- **Gotcha:** AnimatedBody анімує висоту ВГОРУ (0→контент). Для анімації закриття (контент→0) потрібен додатковий rAF: спочатку пін поточної висоти, потім transition до 0. Дивись §14.4 SKILL.md та `calendar/page.tsx::showAdd useEffect`.

## UI: ConfirmDialog + useConfirm (ff87285)
Нативні `window.confirm()` у компонентах замінено на промісний `useConfirm()` хук + `<ConfirmDialog>` (на базі Modal/Button).
- Компонент: `apps/web/src/components/ui/confirm-dialog.tsx` (`title`/`onConfirm`/`onCancel` опціональні — щоб `dialogProps` union `{open:false}` був структурно сумісним).
- Хук: `apps/web/src/hooks/useConfirm.ts` — `const { confirm, dialogProps } = useConfirm();` → `if (!(await confirm({ title, message?, variant? }))) return;` + `<ConfirmDialog {...dialogProps} />` перед закриваючим тегом return. `handleConfirm`/`handleCancel` через functional setState updater → стабільні (не залежать від state, безпечні в `useCallback` deps).
- Замінено 28 викликів у 12 файлах: calendar(3), catalog(5 — кожен Tab має власний useConfirm+ConfirmDialog), employees(1), infrastructure(1), invoices(1), pricing-rules(2), purchase-orders(1), settings(8 — у задачі вказано 6, grep знайшов 8), work-orders/[id](3), vehicles/[id](2), TopShell(1 logout). Видалення → `variant:'destructive'`; status-переходи/reset лічильника → default.
- Gotcha: у `calendar/page.tsx` два confirm всередині `SearchPickerModal.onSelect` — onSelect зроблено `async`; `onSelect: (item)=>void` приймає `async`-функцію (Promise<void> assignable to void). `removeSlot` у `useCallback([load])` → додано `confirm` у deps (стабільний).
- НЕ чіпали: `useDirtyForm.ts` `window.confirm` (рядок 34) — синхронний navigation-guard контракт (`confirmClose():boolean` викликається інлайн перед onClose + поряд з beforeunload); промісний useConfirm зламав би sync API всіх callers. Свідомо лишено.
Unit+Contract: ✅ 357/357 passed (34 файли) — +4 counterparties showDeleted + 19 employees assignment contract (Bug #173+#175)
Web components: ✅ 148/148 passed (14 файлів) — +9 ModalTabs (Bug #174); виправлено пре-існуючий saved-filters-bar empty-state (Bug #176)
Latest tester: 2026-05-29 (AUTO, HEAD 8c3751e→d5a4f18) — scope: 3 комміти (e69bf1e CRM stale-fetch race-guard + cc44f73 counterparties showDeleted/deletedAt contract + 6b886ae ModalTabs + employees assignments). Baseline: API tsc 0 / Web tsc 0 / Shared tsc 0; API 334/334; Web baseline mid-suite ❌ — saved-filters-bar empty-state test падав (component drift). Перевірки коду усі OK (не баги): counterparties.service findAll where = {orgId, ...(showDeleted?{}:{deletedAt:null}),...} — showDeleted прибирає лише soft-delete-фільтр, orgId завжди; count() використовує той самий where; CRM openEdit race-guard через modalVehiclesReqRef (reqId=++ref.current, кожен then/finally гейтить ref.current===reqId — стара повільна вкладка не перезапише поточний CP); employees saveEditEmp PATCH→Promise.all([branches,zones,lifts,work-categories]) всі 4 паралельно, кожен endpoint org-scoped FK-валідовано у сервісі (findMany id:in+orgId+deletedAt+count-check). Виправлено 4 баги (всі MEDIUM, test-coverage): #173 counterparties.service.spec +4 тести showDeleted (drops deletedAt, keeps orgId, count same where, +?q=); #174 modal-tabs.test.tsx (9 тестів — render/click-switch/badge включно з count=0/defaultTab/невідомий defaultTab fallback/порожній масив toBeEmptyDOMElement); #175 employees.contract.spec.ts (19 тестів — describe.each для zones/lifts/work-categories + окремий branches: 200/201 валідне body + service-call assert, порожній масив, невалідний UUID→400, невалідний :id→400 ParseUUIDPipe, 403 без auth; UUID v4-layout); #176 saved-filters-bar.tsx — додано empty-state hint «Немає збережених фільтрів» коли saved=[]&&!saveOpen (виправлено компонент: тест документував легітимний UX-намір, не stale-assertion). Після фіксів: API 357/357, Web 148/148. ⚠️ Урок самовдосконалення: Крок 0 baseline у старій SKILL запускав лише @sto/api test → web-component drift був невидимий до Кроку 4 (#176 виявився під час верифікації). SKILL оновлено: (1) Крок 0 тепер обов'язково ганяє ОБИДВА suite (api + web vitest); (2) §1.6 — новий пункт component-vs-test drift (тест асертить UX-намір якого компонент не має → виправляти компонент якщо намір легітимний, інакше тест); (3) додано accumulated approach для drift-паттерну. d5a4f18.
Latest tester: 2026-05-29 (FULL, HEAD efcfd97) — scope: calendar page.tsx (month/stats fan-out + AbortController + color-mix heatmap) + work-orders calendarSlots take:1/toDto + phase18 infra re-audit. Baseline ✅ (tsc api+web 0, unit 330/330). Завдання-перевірки усі OK (не баги): apiFetch(path, init?:RequestInit) спредить signal у fetch → abort працює (+ GET зі signal свідомо обходить in-flight dedup); STATS_MAX_DAYS=92 clamp у while-умові ДО Promise.all; statsRangeTooLong UI-warning; color-mix N% = round(bgAlpha*100) ∈ 8-50%; mountedRef гард на всіх setState. 3 баги виправлено: #170 CRITICAL deploy — minio healthcheck `curl -f /minio/health/live` у docker-compose.yml ТА .dev.yml, але minio/minio образ НЕ має curl/wget (емпірично: лише /usr/bin/mc) → minio назавжди unhealthy → api depends_on service_healthy НІКОЛИ не стартує → web+caddy каскад мертвий (blast-radius як #164/#165 але для minio, пропущено бо minio не alpine). Фікс: `["CMD","mc","ready","local"]` (офіційний MinIO HC, mc бандлиться, local-alias вбудований — перевірено exit 0) + пін образу RELEASE.2024-01-16 для offline; #171 MEDIUM test-coverage — calendarSlots include (b22a5f0/efcfd97) без service-spec, лише contract spec що мокає сервіс → query-shape gap (Bug #163 патерн). Фікс: work-orders.service.spec.ts (4 тести) — прямий new Service(prisma,...null) + $transaction(ops=>Promise.all) мок, асертить include.calendarSlots present AND calendarSlot absent, deletedAt:null, orderBy startAt asc, take:1, orgId tenant scope, ?q= nested counterparty, employeeId some; #172 LOW frontend — loadMonth/loadStats .catch(()=>[]) ховають повний провал fan-out → порожній view не відрізнити від «немає даних». Фікс: monthError/statsError стани (true лише коли failures===days.length) + inline-hint у month-панелі та під stats period-селектором. Після фіксів: tsc api+web 0, unit 334/334, docker compose config валідний обидва файли.
Latest review: 2026-05-29 (AUTO, HEAD b22a5f0 → efcfd97) — calendar month grid + stats scope (apps/web/src/app/calendar/page.tsx; work-orders dto/service slot fields і Docker/nginx інфра перевірені OK без правок). tsc api+web 0 errors; 330/330 tests. Виправлено у efcfd97: (1) IMPORTANT — month-view heatmap `style={{ backgroundColor: rgba(var(--color-primary-rgb, 59,130,246), alpha) }}` — CSS var `--color-primary-rgb` НЕ існує у globals.css (є лише `--color-primary: hsl(221 83% 53%)` — hsl-форма, НЕ rgb-триплет → не годиться всередині rgba()), тому rgba() мовчки падав на hardcoded синій fallback, ігноруючи тему/dark mode. Фікс: `color-mix(in srgb, var(--color-primary) ${round(alpha*100)}%, transparent)` (Tailwind 4 baseline підтримує color-mix). (2) IMPORTANT — loadMonth (до 31 паралельних per-day запитів) і loadStats (необмежено для custom range, напр. рік=365) не мали скасування: швидке перемикання місяця/діапазону влаштовувало race — застаріла партія перезаписувала свіжу (виграє остання що зарезолвилась, не остання запитана). Фікс: AbortController-ref на кожен loader (`ref.abort()` перед стартом, signal у apiFetch, `if(signal.aborted) return` guard перед setState). (3) IMPORTANT — custom range без guard на max днів → сотні паралельних запитів. Фікс: `STATS_MAX_DAYS=92` cap на fan-out + clamp days-знаменника load% до того ж cap + UI-підказки: `text-warning-text` «діапазон задовгий, показано перші N» та `text-destructive-text` «Від > До». Перевірено OK: T12:00:00-парсинг дат DST-safe (noon-buffer проти roll-over); load% multi-day = totalMin/60/(11h×days) коректно; work-orders calendarSlots include = nested select+take:1+deletedAt:null (не N+1), toDto повертає Date|null (не BigInt). var(--color-destructive)/var(--color-primary) у load-bar inline style — OK (токени існують, inline style ≠ Tailwind arbitrary).
Previous review: 2026-05-29 (AUTO, HEAD 5c7748f → 507a7e8) — phase18 infra scope (apps/api/Dockerfile, apps/web/Dockerfile, apps/web/nginx.conf, Caddyfile, scripts/build-prod.ps1, docs/PHASES.md). tsc api+web 0 errors; 330/330 tests. 1 CRITICAL виправлено (507a7e8): apps/api/Dockerfile runner stage копіював `/app/node_modules/.prisma` з builder — шлях НЕ існує у pnpm-layout (генерований client живе у .pnpm virtual store + packages/database/node_modules/.prisma per @sto/database "exports", не у root). Runtime: "@prisma/client did not initialize yet". Фікс: install з dev deps → `prisma generate` проти власних runner node_modules (engine bundled, offline OK) → `pnpm prune --prod` (прибирає лише prisma CLI devDep, @prisma/client+генерований .prisma лишаються бо prod-dep). Перевірено OK без правок: web Dockerfile (next output:'export'→out/ default, nginx serves /usr/share/nginx/html); nginx.conf SPA fallback `try_files $uri $uri/ $uri.html /index.html` коректний для trailingSlash:true (директорний layout /login/index.html → $uri/ матчить); Caddyfile `handle /api/*`→`reverse_proxy api:3000` НЕ страйпить prefix → API має setGlobalPrefix('api') → шлях збігається, strip-prefix НЕ потрібен; Update.ps1 health-check http://localhost:3000/api/health збігається з @Controller('health')+globalPrefix. ⚠️ Suggestion (не фіксив, поза scope): build-prod.ps1 копіює out/→apps/api/public/ (monolith model) але main.ts НЕ реєструє @fastify/static → цей шлях не обслуговує статику; Docker/Caddy split — канонічна модель.
Latest tester: 2026-05-29 (FULL, HEAD 507a7e8) — phase18 infra RE-AUDIT. ⚠️ ВИЯВЛЕНО: попередня tester-сесія (BUG_REPORT Session phase18) записала Bugs #164-#168 з коректним аналізом і позначила всі `[x] виправлено`, АЛЕ її commit fc87206 був docs-only (лише MemoryManual.md) — жоден код-фікс не застосовано. Перевірка реальних файлів: усі 5 дефектів ЖИВІ (2× CRITICAL release-blocker). Цією сесією РЕАЛЬНО виправлено: #164+#165 CRITICAL — docker-compose.yml healthcheck `curl -f localhost:3000/health` (curl немає у node:20-alpine + шлях невірний бо setGlobalPrefix('api')) → list-form Node-one-liner http.get('localhost:3000/api/health') exit 0/1, +timeout/retries; #166 HIGH — створено root .dockerignore (node_modules/.git/dist/out/.next/.env*/.claude/тести/*.md; prisma schema лишається); #167 HIGH — build-prod.ps1 прибрано dead Copy-Item out→apps/api/public (main.ts без @fastify/static), export лишається у apps/web/out (пакує web Dockerfile); #168 LOW — nginx.conf gzip_types +svg/text-javascript/xml +gzip_vary +окрема location /_next/static/ immutable; build-prod.ps1 $PSScriptRoot fallback на $MyInvocation для pwsh -File/dot-source. +Bug #169 HIGH (process) — `[x]` без diff = хибно-зелений приховав release-blocker. Після фіксів: tsc api+web 0, unit 330/330, `docker compose config` валідний. ⚠️ Урок Крок-0: ЗАВЖДИ перевіряти реальний стан файлів проти `[x]`-маркерів попередніх сесій — commit міг бути docs-only; статус БЕЗ парного diff не довіряти.
Latest tester (попередній): 2026-05-29 (FULL, HEAD a0bc034) — scope: calendar read-only/past (isEditingPast) + WO picker зі slotStartAt/EndAt/LiftName + client↔WO sync; work-orders.findAll calendarSlots include take:1 + toDto slot mapping; counterparties ?q= relation fix (32e9a49); goods validateFkReferences. Baseline ✅ (tsc api+web+shared 0, unit 325/325). 1 баг: #163 MEDIUM test-coverage — counterparties ?q= fix (singular→plural relation customerGarages→vehicles, що усував PrismaClientValidationError) НЕ мав regression-тесту; HTTP-contract spec мокає сервіс → не виконує реальний where. Фікс: counterparties.service.spec.ts (5 тестів) — findAll(?q=) асертить where.OR з plural relation-іменами + nested deletedAt:null + tenant isolation, без singular. Перевірено без дефектів: isEditingPast minHour-boundary (09:00 при 09:22 → 9.0<9=false → НЕ past, OK); ВСІ timeline px→time converter-и (draw/pending-resize/saved-resize/drag) clamp у [WINDOW_START,WINDOW_END] перед toISOString → Invalid Date неможливий; calendarSlots include nullable lift + toDto ?.[0]?.x??null safe у findOne. Після фіксу: tsc 0, unit 330/330. ⚠️ Урок: query-shape фікс (relation-ім'я, nested where) НЕ ловиться mock-based contract spec — потрібен service-spec що асертить реальний where через Prisma-мок-шпигун.
Latest optimize: 2026-05-28 (AUTO, HEAD 63640fb) — calendar scope. Backend: createSlot 3 sequential FK findFirst → Promise.all; updateSlot 4 sequential reads (existing+3 FK) → Promise.all (error priority збережено). Frontend: kyivHours/fmtTime/toDateString new Intl.DateTimeFormat на кожен виклик → 4 module-level singletons; TimeSelect new Date().getMinutes() per-option у render → nowMs-derived minMinute prop. DB: CalendarSlot вже добре проіндексований ((orgId,deletedAt),(orgId,liftId,startAt,endAt),(orgId,employeeId,startAt)) — змін не потрібно. 14/14 calendar тестів passed.
Latest sync: 2026-05-29 (AUTO, HEAD b22a5f0) — 0 mismatches. Full 3-direction audit post calendar stats/month + work-orders calendarSlots + counterparties search fix. Dir1: all backend modules covered (auth/sync/health/files/notifications = known exceptions). Dir2: /calendar/slots?date= matches @Controller('calendar/slots')+@Get()+@Query('date'); statsSlots/loadStats loop same endpoint — correct; all 26 apiFetch calls verified. Dir3: CalendarSlot interface matches CalendarSlotResponseDto; WorkOrderOption.slotStartAt/slotEndAt/slotLiftName match work-orders.dto.ts lines 126-128 + service toDto() lines 740-742; fmtTime(iso:string) on JSON-serialized Date (ISO string) — correct; toDateString(cur:Date) on new Date(from+'T12:00:00') — correct; statsSlots filter by liftId safe; monthSlots byLift keyed by liftId, month view shows only total count (no liftName needed) — correct. tsc web+api: 0 errors. No fixes needed, no commit.
Latest sync (попередній): 2026-05-28 (AUTO, HEAD fbe66ad) — 1 bug fixed: branches bare-array vs {items} mismatch
Latest review: 2026-05-28 (auto, HEAD 5045007 → 634536c) — goods scope (goods.dto.ts + goods.service.ts). 1 Suggestion виправлено (unused IsUUID import). TS 0 errors (web --incremental false, api, shared); 316/316 тестів. Перевірено: unitId/brandId @Matches UUID regex (консистентно з preferredSupplierId, конвенція 4a3cdc0) + @IsOptional; UpdateGoodDto = PartialType(CreateGoodDto) успадковує всі поля; ValidationPipe whitelist:true + forbidNonWhitelisted:true → create() `{...dto, orgId}` spread безпечний (тільки DTO-поля у Prisma); brandId/unitId optional FK без explicit валідації — Prisma P2003 при невалідному ref прийнятний (як preferredSupplierId); toDto() type signature повна + повертає unitId/brandId; frontend Good interface + create/edit форми синхронні (unitId/brandId надсилаються form.X||undefined); findMany мають take; всі find* з orgId+deletedAt:null; немає BOM/any/secrets. Контролер: JwtAuthGuard+RolesGuard+@Roles на кожному методі. Попередній review HEAD b4068a6 — calendar scope, 0 проблем.
Latest tester: 2026-05-28 (AUTO, HEAD d66067b) — goods scope (goods.dto.ts + goods.service.ts після 5045007/634536c). Baseline ✅ (tsc api+web+shared 0 errors, unit 316/316). 2 баги: #161 HIGH business-logic/tenant-isolation — goods create/update spread brandId/unitId/preferredSupplierId у Prisma БЕЗ org-scoped валідації; після того як 5045007 зробив brandId/unitId досяжними через {...dto} (раніше whitelist їх зрізав), FK з ІНШОЇ org проходить сирий DB constraint → cross-tenant linkage (порушення правила #6); неіснуючий ID → generic P2003 замість конкретного. Фікс: validateFkReferences() — Promise.all з findFirst({id,orgId,deletedAt:null}) per Bug #90 pattern → BadRequestException укр., викликається перед create+update; #162 MEDIUM test-coverage — goods.service.spec.ts взагалі не існував → додано 9 тестів (create happy/SKU-conflict/cross-tenant brandId+unitId+supplier throws/valid FK passthrough, update happy + bad FK throws). Після фіксу: tsc 0 errors, unit 325/325. ⚠️ Урок: review HEAD 634536c свідомо вирішив "P2003 при невалідному ref прийнятний" — АЛЕ P2003 ловить лише НЕіснуючий ID, не cross-tenant (ID існує у чужій org); optional FK у multi-tenant ЗАВЖДИ потребує org-scoped findFirst, не покладатись на DB FK. Property/Components/E2E не перезапускались (AUTO scope: 1 backend service+dto).

> /sto-review (auto) на HEAD e0af6a8 (2026-05-28, infra rename + warehouse warn + validation @Matches + SearchPickerModal):
> 0 TS errors (web/api/shared). Виправлено 4 проблеми (commit 9d454d3):
> 1. CRITICAL — schema.prisma додав LiftType PIT/RAMP enum значення БЕЗ міграції → insert
>    lift з type='PIT'/'RAMP' = runtime error (значення немає в БД). Фікс: створено
>    migration 20260528150000_add_lift_type_pit_ramp з `ALTER TYPE "LiftType" ADD VALUE IF NOT EXISTS`.
>    Урок: будь-яка зміна enum/моделі у schema.prisma ОБОВ'ЯЗКОВО потребує супутньої міграції.
> 2. IMPORTANT — fix(validation) commit 4a3cdc0 (PowerShell/редактор) додав UTF-8 BOM (ef bb bf)
>    у 22 *.dto.ts. Решта 17 dto без BOM → неконсистентність; BOM ламає деякі парсери/JSON-імпорти,
>    git diff показує ﻿. Фікс: вирізано BOM з усіх 22 (tail -c +4). Валідація НЕ ослаблена:
>    @Matches(/^[0-9a-f]{8}-...{12}$/i) зберігає структурну форму UUID 8-4-4-4-12, лише не
>    енфорсить version/variant nibble (навмисно — приймає seed UUID з version 0). Malformed string
>    усе одно reject. tsc толерує BOM, тому помилки не було — суто гігієна/консистентність.
> 3. IMPORTANT — SearchPickerModal (новий components/ui) ковтав помилки fetch через .catch(() => {})
>    у двох місцях (initial load + search) без error-стану → юзер бачив "Нічого не знайдено" замість
>    реальної помилки. Фікс: додано error state + UI-банер; reset на open/close. §8.2.
> 4. SUGGESTION — infrastructure/page.tsx warehouse-модал мав inline IIFE {(() => {...})()} у JSX
>    (warehouses.find кожен render). Фікс: винесено в named WarehouseMainCheckbox component. §8.6.
> Verified OK (без правок):
>   • calendar/page.tsx pointer-логіка (window listeners): onCancel скидає ВСІ 3 режими
>     (drawingRef+ghost, pendingResizing, resizing+resizePreview); closest('[data-calendar-slot]')
>     використовує власний маркер (не phantom dnd-data); listeners cleanup парний.
>   • fetchCpItems/fetchWoItems: apiFetch + encodeURIComponent (no injection), typed.
>   • infrastructure rename Підйомник→Пост + LIFT_TYPE_LABELS PIT='Яма'/RAMP='Естакада' консистентні.
> ---
> /sto-review (auto) на HEAD 5702506 (2026-05-28, calendar interactive feature): 0 TS errors.
> Виправлено 3 проблеми у calendar (commit 5702506):
> 1. IMPORTANT — calendar/page.tsx handleDrawStart: guard перевіряв `[data-dnd-draggable]`,
>    якого dnd-kit НЕ ставить (useDraggable.attributes = role/aria-*, не data-dnd-draggable).
>    → pointer-down на існуючому слоті стартував ghost-draw паралельно з dnd-kit drag.
>    Фікс: додано `data-calendar-slot` на корінь DraggableSlot + перевірка `.closest('[data-calendar-slot]')`.
> 2. IMPORTANT — handleTimelinePointerLeave скидав тільки drawing (drawingRef/ghost),
>    але НЕ resize. Покинутий resize off-timeline → застряглий resizePreview + наступний
>    pointermove продовжував маніпуляцію. Фікс: leave також `setResizing(null); setResizePreview(null)`.
> 3. SUGGESTION — дубльований `toISO(h)` (decimal hours → ISO) у handleTimelinePointerUp та
>    slotsWithPreview → винесено в module-level `decimalHoursToISO(date, h)`. calendar.service toDto
>    тепер використовує спільний `formatPersonName` замість inline `[lastName, firstName].join`.
> Verified OK (без правок):
>   • calendar.controller — @UseGuards(JwtAuthGuard, RolesGuard) + @Roles на кожному методі;
>     POST/PATCH/DELETE = OWNER/ADMIN/RECEPTIONIST; GET додатково MECHANIC. ParseUUIDPipe на :id
>     та optional query branchId/employeeId.
>   • calendar.service — усі find/update фільтрують orgId; FK (lift/employee/workOrder) у create+update
>     валідуються `{ id, orgId, deletedAt: null }` (anti cross-tenant FK injection). 2 $transaction = 2 timeouts (5s).
>     removeSlot = soft delete (update deletedAt), не hard delete. UpdateCalendarSlotDto liftId nullable +
>     @IsOptional → `liftId: null` (move to unassigned) проходить валідацію коректно.
>   • DTO startAt/endAt: Date — збігається з project convention (createdAt!: Date у 15+ модулях);
>     фронт string коректний (JSON-серіалізація). toISO local-tz parse = той самий патерн що addSlot (Kyiv-pinned).
> ---
> /sto-review verify pass на HEAD 5704435 (2026-05-28, perf commits f040cde..5704435):
> CRITICAL/Important checks усі пройшли. Виправлено 2 ефективність-проблеми (commit ba14043):
> 1. calendar/page.tsx — memo() на DroppableLiftRow був неефективний: `slotsForLift(id)`
>    створював новий .filter() масив кожен render → memo завжди re-render. Фікс: useMemo Map<liftId,slots[]>
>    + stable EMPTY_SLOTS → liftSlots reference стабільна.
> 2. api-client.ts — GET dedup keyed на path: безпечно для plain GET (shared promise rejection
>    коректно прокидається всім callers), АЛЕ небезпечно якщо GET має AbortSignal (abort одного
>    caller валив би проміс іншого). Фікс: `method === 'GET' && !init?.signal` — abortable GET не дедупиться.
> Verified OK (без правок):
>   • reports.service.ts $queryRaw — усі колонки camelCase у лапках ("employeeId", "normoHours",
>     "amount", "deletedAt", "orgId", "workOrderId", "totalAmount", "totalLabor", "completedAt",
>     "batchCostPrice", "purchasePrice", "firstName", "lastName") звірені зі schema.prisma (без @map).
>     Table names = @@map plural (work_order_lines, work_orders, employees, work_order_parts, goods).
>     Conditional fragment через Prisma.sql / Prisma.empty (НЕ string interpolation). BETWEEN = gte/lte
>     inclusive — збігається зі старою логікою. Bug #74 fallback (batchCostPrice→good.purchasePrice)
>     + unknownCount FILTER збережені; SUM ігнорує NULL → unknown parts contribute 0 (як раніше).
>   • dashboard.service.ts — CacheService DI ОК (RedisModule @Global + AppModule import). Cache key
>     містить orgId (`dashboard:summary:${orgId}`) → 25s TTL не плутає org-и. CacheService get/set
>     мають try/catch fallback → Redis down не ламає request (offline-first).
> ---
> Попередній /sto-review verify pass на HEAD 2e8b4ce (2026-05-28): 0 issues to fix, no review commit needed.
> Перевірено: brands/units/payment-methods.service (resurrection pattern), exchange-rates.service
> (parseDateOnly + merged findFirst), currencies.service (merged findFirst), picker-modal.tsx
> (IIFE removed), settings/page.tsx (logoPreview cleared on success + objectURL revoke).
> Усі три resurrection-сервіси мають `@@unique([orgId, X])` що НЕ включає deletedAt → soft-deleted
> рядок блокує re-create → resurrection через update() коректний + bumps syncVersion (sync-safe).
> goods.service.ts (sku/barcode) — НЕ потребує resurrection: `@@index` (не `@@unique`), P2002 неможливий.
> Контролери: повні guards (Jwt+Roles), @Roles на кожному методі, ParseUUIDPipe на :id. API tsc: 0 errors.

## Поточний стан проєкту
```
TypeScript:      ✅ 0 errors           (apps/web + apps/api + shared — після a6b154e)
Unit+Contract:   ✅ 316/316 passed     (30 файлів — backend; +calendar.contract 14 tests)
Contract:        ✅ 14 contract spec files (auth, work-orders, warehouses, counterparties,
                                       sync, settings, audit, pricing-rules, batches,
                                       currencies, bank-accounts, exchange-rates, cash-registers,
                                       calendar)
Property-based:  ✅ 26 invariants passed (inventory, settlements, FSM)
Components:      ✅ 139/139 passed     (13 файлів, @testing-library/react)
E2E (Playwright):✅ 42/42 passed (smoke 8, console-errors 22, inventory 4, api-errors 8)
                  • console-errors: 0 flaky після serial + warm-up (Bug #134)
                  • smoke включає Bug #135 security headers test
Build:           ✅ @sto/api build OK
Security headers:✅ X-Content-Type-Options, X-Frame-Options, HSTS, CORP через @fastify/helmet@11 (Bug #135)
$transaction timeouts: ✅ ВСІ interactive callbacks мають explicit { timeout } (work-orders transition 10s + 6 line/part 5s; warehouses 2; +calendar/completion-acts/counterparties/document-number/employees/loyalty/payments/purchase-orders/services/setup/stock-documents; Bug #130/#138/#141/#144)
Latest tester:   2026-05-28 (AUTO, HEAD a6b154e) — calendar feature (interactive draw/resize + PATCH, після 0371c73/5702506/77d9452). Baseline ✅ (tsc api+web+shared 0 errors, unit 302/302). 3 баги: #156 MEDIUM test-coverage — новий CalendarController (4 endpoints, з них PATCH resize/drag) без contract-spec → додано calendar.contract.spec.ts (14 HTTP-тестів); #157 MEDIUM frontend — resize краю слоту не обмежений вікном 08:00–20:00 → endH>20/startH<8 → decimalHoursToHHMM будує "24:30"/"-1:00" → new Date Invalid → toISOString() RangeError → resize мовчки ламається з нерелевантним повідомленням; фікс: clamp у [WINDOW_START=8, WINDOW_END=20] + hard-clamp у decimalHoursToHHMM як остання лінія; #158 LOW frontend — searchWorkOrders порожній catch ховав помилки пошуку → surface через setError + clear options. Після фіксу: tsc 0 errors, unit 316/316. Property/Components/E2E не перезапускались (AUTO scope: backend service+controller + 1 frontend page). ⚠️ Урок: будь-який px→time/decimal-hours converter у timeline UI ОБОВ'ЯЗКОВО clamp у валідне вікно ПЕРЕД побудовою Date — інакше Invalid Date → RangeError у toISOString().
Latest tester (попередній): 2026-05-28 (AUTO, HEAD 8376435) — docs-only diff (skill files rewrite, 0 source змін). Матриця → §0 (tsc) only. TS 0 errors api+web+shared. Але baseline unit ❌ 12 failed/290: 3 СТАЛІ specs які попередні perf/simplify commits зламали без оновлення. 3 баги (всі test-coverage, prod-код коректний): #153 MEDIUM warehouses.service.spec — TestingModule не надавав CacheService мок (доданий у 923aea5) → NestJS DI fail на 6 тестах; #154 MEDIUM currencies.service.spec — той самий CacheService DI fail (доданий 09b8a3b) + застарілий double-findFirst mock (simplify звів create() до одного findFirst); #155 MEDIUM exchange-rates.service.spec — застарілий double-findFirst mock (3d2c185 simplify, тут CacheService нема). Фікс: мок CacheService (get→null) + single-findFirst resurrection mocks. Після фіксу API 302/302. ⚠️ Урок: perf/simplify рефактор сигнатур/логіки сервісу ЗАВЖДИ оновлювати парний spec (DI providers + mock-call-count). Property 26/26, Components 139/139, E2E 42/42 — не перезапускались (AUTO docs-only).
Latest optimize: 2026-05-28 (AUTO, HEAD 5afbadd) — регресійний прохід (з 09b8a3b у apps/ змінились лише 3 .spec.ts → tester #153-155, prod-код 0 змін). Перевірено N+1 (1.1: усі `.map` — це `createMany({data:[...].map})`, in-memory batch, не async-per-element → OK), Redis cache (1.4: усі 10 ref-сервісів мають CacheService; exchange-rates свідомо БЕЗ кешу — findAll бере filters currencyId/from/to + rates time-sensitive, кеш зламав би логіку; lifts окремого backend-сервісу нема), sessionStorage ref-cache (2.4). Знайдено 1 проблему: infrastructure/page.tsx (source/management UI для branches/zones/lifts/warehouses) фетчила ці списки cold БЕЗ getCached/setCache, тоді як consumer-сторінки їх кешують → її правки не доходили до кешу споживачів + cold-fetch при кожному відкритті. Фікс (e0fd299): seed з getCached (first-paint) + setCache після кожного свіжого фетчу. Safe бо loadAll() завжди re-fetch на mount + після КОЖНОЇ мутації (save/delete/set-main) → ніколи не читає stale. TS 0 errors api+web. Новий патерн (5afbadd) → Накопичені підходи + Крок 2.4 grep розширено.
Latest review:   2026-05-28 (perf optimization series 016f041..945e264 — HEAD 19a4c22) — AUTO review всіх perf-коммітів. 0 Critical / 0 Important. 1 Suggestion фіксовано (19a4c22): employees create()/update() використовували `include: { employeeZones: true, ... }` (SELECT *) замість `select: { zoneId: true }` як у findAll/findOne — звужено для консистентності. Перевірено: (1) CacheService — try/catch на всіх Redis-викликах (get/set/del/delPattern), offline-first never breaks request; (2) інвалідація кешу на КОЖНОМУ мутаторі (create/update/remove) у всіх 7 ref-сервісах (branches/warehouses/zones+lifts/work-categories/brands/units/payment-methods); (3) delPattern `ref:X:${orgId}*` коректно чистить і unfiltered, і branch/zone-scoped ключі (warehouses+branchId, zones+branchId, lifts+zoneId); single-key сервіси (branches/brands/units/payment-methods/work-categories) використовують del(); (4) RedisModule @Global + у app.module → всі 7 сервісів інжектять CacheService (tsc 0 errors підтверджує DI); жоден інший модуль не пише в ці моделі повз cached-сервіси; (5) purchase-orders toDto: `lines: (po.lines ?? []).map(...)` + `linesCount: po._count?.lines ?? po.lines?.length ?? 0` — no crash коли lines=undefined у findAll (lines omitted, _count.lines використано); frontend loadDetail() перевіряє `po.linesCount === 0` перед on-demand findOne; (6) useDebounce — cleanup clearTimeout; усі 8 сторінок (work-orders/purchase-orders/invoices/inventory/employees/crm/catalog×3) використовують debouncedX у deps+URL, ніде raw X; (7) ReportsCharts типи (RevenueRow/SettlementRow/LoadRow/ProfitabilityData) точно збігаються з reports/page.tsx; dynamic import named exports коректний; (8) SW skipWaiting тепер ВСЕРЕДИНІ waitUntil ПІСЛЯ cache.addAll — новий SW не перехоплює control mid-precache; (9) ref-cache.ts SSR-safe (typeof window guard + try/catch); усі getCached/setCache у effects, 0 lazy useState(getCached(...)) initializers. Suggestion-only (не фіксовано): Redis client lazyConnect+enableOfflineQueue може повільно фейлити offline (немає connectTimeout/maxRetriesPerRequest) — змінювати connection semantics ризиковано; delPattern використовує redis.keys() O(N) — прийнятно для малих ref-наборів.
Previous review: 2026-05-28 (verify pass, no fixes — HEAD aa5aefd) — повний AUTO review feature surface: 4 нові модулі (currencies/exchange-rates/bank-accounts/cash-registers), settings org-info endpoint (logoUrl/legalAddress/actualAddress/bankAccountId + explicit orgSelect виключає BigInt syncVersion), web settings 4 нові вкладки + Organisation tab з logo upload (apiMultipartFetch), TopShell public-route guard перед employee-check. 0 Critical / 0 Important — код чистий (пройшов попередній review ebbf746 + tester bb26737). TS 0 errors api+web. Перевірено: tenant isolation (orgId у всіх query), cross-tenant FK guard на create+update, soft-delete, toDto Decimal→Number + syncVersion виключено, sync-ready schema (всі моделі мають id/orgId/syncVersion/timestamps + @@index orgId,deletedAt/syncVersion), PULL_TABLES обґрунтовано виключені (admin reference data, не для mobile mechanic), Select placeholder уникає async-init race (§8.2.1), SearchCombobox paired displayName reset (§8.2). Suggestion-only (не фіксовано): saveUiFeatures unguarded toast (pre-existing phase19); BankAccount/CashRegister currencyId/branchId без dedicated @@index (малі settings-таблиці take:200); combobox q-param ігнориться бекендом (client-side display, OK для малих таблиць).
```

### Gotcha — /sto-sync 2026-05-29 (commit 561e08b)

**Direction 3 — /goods/:id/batches повертає { items, total }, але фронт очікував bare array:**
`GoodsController.getBatches()` повертає `{ items: StockBatchDto[], total: number }` (пагінований shape),
але `catalog/page.tsx` викликав `apiFetch<StockBatchDto[]>('/goods/${g.id}/batches')` і
присвоював відповідь напряму до `modalBatches: StockBatchDto[]` — масив був об'єктом.
Результат: таб «Партії» в edit modal каталогу падав із `TypeError: data.filter is not a function`.
Фікс: `apiFetch<{ items: StockBatchDto[]; total: number }>` → `.then(data => setModalBatches(data.items))`.
**Правило:** sub-resource endpoints на goods controller (`/batches`, `/price-history`) пагіновані
і повертають `{ items, total }` — на відміну від `/barcodes` який повертає plain array.
Перевіряти контролер перед типізацією apiFetch для кожного sub-resource.

### Gotcha — /sto-sync 2026-05-28 (commit fbe66ad)

**Direction 2 — /branches повертає bare array, але фронт очікував {items}:**
`BranchesService.findAll()` повертає `BranchResponseDto[]` (plain array без пагінації),
але `calendar/page.tsx` викликав `apiFetch<{ items: [...] }>('/branches?limit=50')` і
читав `d.items` — завжди `undefined`. Результат: select «Філія» у формі нового наряду
був завжди порожній → створити наряд неможливо.
Фікс: `apiFetch<{id:string;name:string}[]>('/branches')` → `setBranches(d)`.
**Правило:** завжди перевіряти сигнатуру сервісу перед `apiFetch<{items:T[]}>` —
не всі endpoints пагіновані. `/branches`, `/lifts`, `/vehicles`, `/maintenance-schedules`,
`/calendar/slots`, `/counterparties/:id/garages` повертають plain array.

### Gotcha — /sto-review модульність/універсальність UI (2026-05-28, commit 06e2ccb)

Спеціалізований review-прохід на дотримання `<PickerModal<T>>` (`ui/picker-modal.tsx`) + §14 модульності. Знайдено й виправлено:

- **Дубльована "days-until-date → badge" логіка ×4 (винесена у `daysUntil()` + `<ExpiryBadge>`).** Однакова обчислювалка `Math.ceil((date.getTime() - nowMs) / 86_400_000)` + `if (<0) червоний badge; if (<=N) жовтий badge` була inline-IIFE у 4 місцях: `vehicles/[id]` (страховка / техогляд / наступне ТО) і `crm/[id]` (ТО "скоро"). Канон: helper `daysUntil(date, nowMs): number | null` у `lib/utils.ts` (SSR-safe: `nowMs=0` → `null`, NaN-guard) + компонент `<ExpiryBadge date nowMs expiredLabel soonLabel? soonDays?>` у `ui/expiry-badge.tsx`. `infrastructure/page.tsx isWithin14Days()` теж переписано через `daysUntil`. Лейбли різні ("Страховка прострочена" / "Техогляд прострочений" / "Прострочено") і поріг різний (30 / 14 дн) → саме тому helper + конфігурований компонент, а не один badge.
- **Pointless wrapper IIFE `{(() => { return arr.map(...) })()}`.** У `crm/[id]` `.map()` був обгорнутий у IIFE без жодної логіки до `return`. Прибрано — `{arr.map(...)}` напряму. Запах: IIFE у JSX чий тіло одразу `return map/filter/find` — завжди зайвий wrapper.
- **Picker-trigger IIFE у `settings/page.tsx` (рахунок банку).** `{(() => { const selected = bankAccounts.find(...); return (<...>) })()}` → `selectedBankAccount` обчислено один раз у component body перед `return`, JSX без IIFE. (Сам `<PickerModal<BankAccount>>` уже використовувався коректно — це був лише trigger-button computation.)

**Чисто (порушень немає):**
- `<PickerModal<T>>` уже коректно застосований у `settings/page.tsx` (єдина page що його потребує). Інші "selectGood" — це або `<SearchCombobox>` (work-orders part picker — server-side search, правильний примітив для великого датасету), або master-detail список (catalog) — НЕ picker-modal кейси.
- page-level `search`/`setSearch` у crm/employees/invoices/work-orders — це фільтр списку сторінки (з пагінацією), НЕ власний modal-picker. Не плутати.

**Backend (MEDIUM, НЕ рефакторено за вказівкою):** 30 сервісів мають власний `toDto()`/`toResponseDto()` мапер (по 1 на модуль). Це стандартний per-module патерн — кожен мапить різні поля, спільний helper дав би leaky abstraction. Залишено як є (ризик для стабільного коду). `syncVersion: Number(...)` cast — лише у 2 файлах (notifications, sync), не варто виносу.

### Gotcha — /sto-tester FULL 2026-05-28 (catalog modules — Bug #145 + contract specs, commits bb26737, 27a7063)

- **STALE DEV API = E2E console-errors false-positive (404 на нових routes).** Запуск console-errors.spec знайшов 10× `Failed to load resource: 404` на `/settings`. Виглядало як баг фронту, АЛЕ причина: dev-API процес (port 3000) був запущений ДО merge нового feature-коміту (`4ff6454` catalog) і не мав зареєстрованих routes `/currencies`, `/exchange-rates`, `/bank-accounts`, `/cash-registers`, `/settings/org-info`. Діагностика: `curl /api/currencies` → `404 "Cannot GET /api/currencies"` (Nest no-route) замість `401` (route exists, auth required). Канон: ПЕРЕД будь-яким E2E на сторінці що кличе нові endpoints — рестартнути API (`kill port 3000` → `pnpm --filter @sto/api dev`) і підтвердити `curl /api/<new-route>` → **401, не 404**. 404 на route який є у коді = stale server, НЕ код-баг. NestJS dev (`nest start --watch`) не завжди підхоплює нові модулі що додані поки сервер вже працював.
- **`.catch(() => {})` на mount-fetch ховає loading/error стан (Bug #145).** 5 нових вкладок settings (currencies/exchange-rates/bank-accounts/cash-registers/org-info) завантажувались через `apiFetch().then(setX).catch(() => {})` у спільному mount-effect. Проблеми: (1) loading-прапорці оголошені але `setLoading(true)` ніколи не викликався → empty-state блимав під час завантаження; (2) помилки API тихо ковтались → 500 виглядав ідентично до "немає даних"; (3) без cancelled-flag → setState після unmount. Канон: будь-який список-fetch у `useEffect` повинен мати (а) `let cancelled=false` + `return () => {cancelled=true}`, (б) `setLoading(true)` перед / `.finally(setLoading(false))`, (в) `.catch` що викликає `setError(...)` укр. повідомленням — НЕ `() => {}`, (г) у JSX `!loading && items.length===0` для empty-state. Мертвий loading-state (оголошений, ніколи не set) — окремий запах.
- **`@IsUUID()` (default version 'all') ВІДХИЛЯЄ nil/zero-version UUID.** Контракт-тест `POST /exchange-rates` з `currencyId: '00000000-0000-0000-0000-000000000001'` несподівано 400'ив (`"currencyId must be a UUID"`) — version nibble (13-й hex) = `0` не є валідною UUID-версією (1-5). Це test-only баг (фіксуємо ТЕСТ, не код). Канон: у контракт-тестах для UUID-полів використовувати UUID з валідною версією, напр. `11111111-1111-4111-8111-111111111111` (v4 layout). Nil-UUID годиться лише там де треба явно тестувати rejection.

### Gotcha — /sto-tester FULL 2026-05-27 (commits fc3d15d, be9eb58, f8c97d8 — bugs #139, #140, #141)

- **`$transaction(async)` timeout coverage MUST бути 100%, не "більшість"** (Bug #141, warehouses.service). Bug #130/#132/#138 додали explicit `{ timeout: 5_000 }` майже всюди — але warehouses.service:33,54 потрапили у "non-critical service" категорію і пропустилися. Кожен interactive callback що робить `updateMany` (зачіпає несколько рядків) + `create`/`update` ризикує lock contention при race з паралельною транзакцією. Канон: grep `prisma.\$transaction(async` ОБОВ'ЯЗКОВО проганяти у кожному tester sweep і порівнювати з `grep -c "timeout:"` для тих самих файлів. Сполучення `\d+ matches` для transactions і `< той же\d+` matches для timeout = bug.
  ```bash
  # Регресія-grep:
  for f in $(grep -rl "\$transaction(async" apps/api/src --include="*.ts" | grep -v spec); do
    tx=$(grep -c "\$transaction(async" "$f")
    to=$(grep -c "timeout:" "$f")
    if [ "$tx" -gt "$to" ]; then echo "MISMATCH $f: $tx transactions, $to timeouts"; fi
  done
  ```
- **SearchCombobox: `value` без `displayValue` → empty input → "втратив вибір"** (Bug #140). Стара логіка `showSelected = !!value && !!displayValue && !query` падала у edge-case: форма Edit відкривається з server-state → `goodId` встановлено одразу, але `goodDisplayName` тільки після окремого fetch. На мить combobox показував порожній search input замість selected pill — користувач думав що дані не завантажилися. Канон: для будь-якого combobox/autocomplete з зовнішнім `value` контролером, потрібен **третій візуальний стан**: `value && !displayValue && !query` → loading pill (spinner + "Завантаження…" з `role="status"` + `aria-busy="true"`). Це сидить між selected pill і empty search input. Для screen readers це сигналізує що вибір НЕ скинутий — просто display lookup ще йде.
- **`?? ''` як третій fallback після `.join(' ')` — dead code, але hides UX bug** (Bug #139). `cp.companyName ?? [cp.lastName, cp.firstName].filter(Boolean).join(' ') ?? ''` — третій `?? ''` ніколи не спрацьовує бо `Array.join` завжди повертає `string` (можливо `''`). АЛЕ той порожній рядок є справжнім UX-багом: combobox primary text для анонімного контрагента (companyName/firstName/lastName всі null) → порожній dropdown row. Користувач бачить що список не порожній (є rows), але не може зрозуміти що вибрати. Канон: помістити дисплейну логіку у helper `displayCounterpartyName(cp)` у `lib/utils.ts` з fallback `'(без імені)'`. Той самий fallback застосувати у `primary` (для combobox) і `displayValue` (для selected pill). Помітники: повторення 6 разів inline patterm — це **завжди** сигнал що helper потрібен; коли захочеться додати 7-й сайт використання, винесення вже мусить бути зроблене.
- **Bug #136 / #137 уже були виправлені до запуску tester'а** — попередні commits 15e451e/4953500 закрили infrastructure PATCH FK strip і auth/booking message[] join. Tester повинен СПОЧАТКУ грепнути BUG_REPORT для відкритих [ ] і верифікувати чи фікс уже в коді (`git log --grep="Bug #N"`), потім перевіряти статус — інакше можна випадково "повторно виправити" вже закритий баг.
- **`where: { id, orgId }` у Prisma 5 update — це OK, не баг.** Prisma 5+ підтримує extended unique-where з додатковими filter полями. `id` є primary unique → satisfies `WhereUniqueInput`; `orgId` діє як AND-filter і запис не оновиться якщо belongs до іншої org. Старий стиль (`where: { id }` + previous `findFirst` check by orgId) теж працює, але explicit `{ id, orgId }` дає атомарну multi-tenant guard в одному виклику.

### Gotcha — /sto-review 2026-05-27 (commit 6ecc7a1, after 2822912)

- **`React.ChangeEvent<...>` всередині нового UI компонента — TS-plugin error** (search-combobox.tsx:86). У файлі вже був `import { type KeyboardEvent } from 'react'`, але обробник `handleInputChange` потайки використовував `React.ChangeEvent` через namespace, який не імпортувався. plain tsc проходить (next-env.d.ts), але VSCode Next.js плагін червонить. Канон: при додаванні нового `*.tsx` файлу — імпортувати ВСІ React types через named import (`type ChangeEvent, type KeyboardEvent, type MouseEvent`), ніколи через `React.X`. Перевіряти grep `React\.` після кожного нового UI компонента.
- **`setTimeout` debounce у custom hook/component без `clearTimeout` у cleanup** — типовий патерн "пишу debounce, mountedRef ловить setState після unmount, готово". НЕ готово: коли unmount стається між keystroke і fire-timer, setTimeout усе одно виконує callback, який ініціює `fetchItems()` (HTTP запит). MountedRef ловить setState, але мережевий round-trip уже відбувся. Канон: у `return () => { ... }` cleanup'і useEffect, що тримає `mountedRef`, ОБОВ'ЯЗКОВО додавати `if (debounceRef.current) clearTimeout(debounceRef.current)`. Та сама вимога стосується `pollRef`, `idleRef` тощо.
- **Custom combobox без WAI-ARIA wiring** = screen-reader users бачать порожній `<input>` без feedback що це combobox, чи показаний listbox, який option зараз active. Канон для будь-якого свого autocomplete/combobox: input має `role="combobox"`, `aria-expanded`, `aria-controls={listboxId}`, `aria-autocomplete="list"`, `aria-activedescendant={optionId(activeIndex)}`; listbox `<ul>` має фіксований `id={listboxId}`; кожен `<li>` опція має `id={optionId(idx)}` + `role="option"` + `aria-selected`. Використовувати `useId()` для базового префіксу — стабільний між server і client paint.
- **Display name state ≠ form state — треба синхронно скидати обидва** на modal close/create success. Якщо `counterpartyId: ''` але `counterpartyDisplayName: 'ТОВ Старий клієнт'` — наступне відкриття modal покаже stale ім'я в полі без id, заплутає користувача. Фікс: будь-який handler що скидає FK ID у формі (`onClose`, after successful POST, on `onClear`) повинен також скидати парний `*DisplayName` стейт. Шаблон для self-check: grep `setForm(.*counterpartyId|supplierId|goodId): ''` — кожен match має поряд `set*DisplayName('')`.
- **TS чистий** після всіх фіксів (`apps/web tsc --noEmit --incremental false` і `apps/api` — 0 errors).

### Gotcha — /sto-review 2026-05-27 (commit 0c3b661, after 0af89fd)

- **`message: string[]` fix мусить покривати ВСІ http helpers, не лише `apiFetch`** — попередній commit 0af89fd залатав `apiFetch` (NestJS class-validator повертає `{ message: string[] }` на 400), але `apiBlobFetch` і `apiMultipartFetch` у тому ж файлі залишились на старій сигнатурі `{ message?: string }`. Симптом для користувача: при 400 з валідатором на PDF download (invoices/settlements/work-orders) або multipart upload (work-orders media) фронт показує `[object Object]` або тільки перший елемент масиву через implicit `Array.prototype.toString`. Канон: фіксити **всі три** функції в `api-client.ts` синхронно одним коммітом. Урок для review: коли бачиш fix у `apiFetch` — обов'язково grep'ни сусідні helpers того ж файлу (`apiBlobFetch`, `apiMultipartFetch`).
- **Regex/Set literals у render body — re-allocation на кожен render**. `const UUID_RE = /.../` всередині component body (calendar/page.tsx) створює нову RegExp instance щоразу. Сам по собі не bug, але noise GC + не canonical стиль файлу (поряд лежить module-level `KYIV_TZ`). Канон: всі stateless конст��нти — module-level (поза `export default function`).
- **TS чистий** (`apps/web tsc --noEmit --incremental false` 0 errors) — після виправлень.

### Gotcha — /sto-tester FULL 2026-05-27 (commit 2bf6c3b, Bug #135)

- **NestJS Fastify adapter за замовчуванням НЕ повертає security headers** — `helmet` не auto-registers. `curl -I /api/health` показував тільки CORS + content-type, жодного `X-Content-Type-Options`, `X-Frame-Options`, HSTS, CORP. Per skill checklist §4.9.2 це обов'язкові поля для prod. Канон: `pnpm --filter @sto/api add @fastify/helmet@11` (Fastify 4 line; helmet 12+/13 потребують Fastify 5 — у нас 4.28.1), потім `await app.register(fastifyHelmet, { contentSecurityPolicy: false, crossOriginEmbedderPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } })`. CSP і COEP вимкнено: CSP блокує Swagger UI inline scripts, COEP перешкоджає MinIO presigned downloads.
- **CORP must be `cross-origin` в dev** — інакше веб з порту 3001 не може фетчити з API на 3000 (CORP за замовчуванням `same-origin`). Це не security regression: CORS залишається обмеженим `WEB_ORIGIN`, CORP лише дозволяє ресурсу бути embedded.
- **Contract test не годиться для helmet headers** — `Test.createTestingModule(...).compile().createNestApplication()` викликає `app.init()` (Test fixture), не bootstrap. Helmet реєструється в `main.ts::bootstrap()`. Перевіряти через **E2E** проти живого dev API (`apps/web/e2e/smoke.spec.ts` describe "Smoke — API security headers (Bug #135)").
- **Helmet версія залежить від версії Fastify** — `@fastify/helmet@13.x` → Fastify 5; `@fastify/helmet@11.x` → Fastify 4. Помилкова версія = `FST_ERR_PLUGIN_VERSION_MISMATCH` при bootstrap і API не стартує. Перевіряти `tail /tmp/sto-api-dev.log`.

### Gotcha — /sto-review (2026-05-27, commit 8c1a760)

- **Залишковий `React.ReactNode` у `inline-edit-cell.tsx:89`** — попередній review (f2e8182) свідомо пропустив цей файл як "не в скоупі поточних змін". Цикл review після додаткових тестерських фіксів виявив його: grep `React\.` стабільно повертає його щоразу. Виправлено: `import { ..., type ReactNode } from 'react'` + `children?: ReactNode`. Урок: коли grep знаходить старий патерн у файлі поза скоупом — все одно виправляти, бо повторні запуски review повторно його піднімають і марнують контекст. Web `tsc --noEmit --incremental false` чистий (0 errors).
- **Файли цього скоупу review (24 файли з f2e8182..HEAD) — TS чистий**: api services з explicit `$transaction` timeouts (#130/#132), batch FEFO `nulls: 'last'` (#133), HttpExceptionFilter Prisma mapping (#127/#128), auth context PUBLIC_ROUTES (#131), console-errors serial mode + warm-up (#134), inventory text-warning-text (#129). Всі патерни консистентні; жодних повторних порушень skill §1/§2/§3/§5/§13.

### Gotcha — /sto-tester FULL 2026-05-27 (commits d544706, ae7d51d, a262d1a, bugs #132-#134)

- **`prisma.$transaction([array], { timeout })` НЕ ПІДТРИМУЄТЬСЯ Prisma 5** (Bug #132, pricing.service.ts). Тільки interactive callback-form приймає `{ timeout }` як другий аргумент: `prisma.$transaction(async (tx) => {...}, { timeout: N })`. Array-form `prisma.$transaction([promises], { isolationLevel })` приймає **тільки** `isolationLevel`. TS-помилка: "Object literal may only specify known properties, and 'timeout' does not exist in type '{ isolationLevel?: TransactionIsolationLevel }'". Канон: якщо потрібен timeout — переписати array на callback-form (loop замість `[...arr.map(p)]`). Перевірено в `apps/api/src/modules/inventory/pricing.service.ts:119` — переписаний з `$transaction([...100 promises])` на `$transaction(async tx => { for ... })`.
- **Bug #130 не покрив усі transaction callbacks — 11 з 16 залишались** (Bug #132). Перевірка кожного `$transaction(async ... =>)` після Bug #130:
  - `setup.service.ts`: 15s (одноразовий bootstrap 14+ writes — Inno Setup перший запуск може бути повільним)
  - `stock-documents.transition CONFIRMED` + `purchase-orders.receive`: 15s (N лін×createMovement з батч-tracking + StockBatch update + BatchConsumption create + StockMovement create + stockItem upsert = 5 writes/лінія)
  - `inventory/pricing.applyRuleToGoods`: 10s (CHUNK=100)
  - `batch.consumeBatch` standalone tx: 10s (loop по партіях)
  - Решта (employees×4, services×2, payments, loyalty, counterparties, settlements, purchase-orders crud, stock-documents.create/update): 5s
- **FEFO ordering без explicit `nulls: 'last'` — silent dependency on Postgres ASC default** (Bug #133, batch.service.ts:152). Postgres ASC ORDER BY за замовчуванням ставить NULLs LAST, але це **database-specific**. Якщо хтось зробить `nulls: 'first'` migration або переключиться на іншу БД — партії без `expiryDate` стануть FIRST → товари що скоро прострочаться лежатимуть на складі. Канон: для FEFO ВСІ orderBy на nullable date поля повинні мати explicit `{ sort: 'asc', nulls: 'last' }`. Прісма 5 syntax: `[{ expiryDate: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }]`.
- **Playwright `fullyParallel: true` + Next.js dev = "Invalid or unexpected token" race** (Bug #134, console-errors.spec.ts). 8 workers одночасно навігують на різні routes; Next.js dev компілює chunks on-demand для кожного route; повертає браузеру partial JS до завершення webpack. Браузер ловить SyntaxError. Фікси: (1) `test.describe.configure({ mode: 'serial' })` — тести одного describe виконуються послідовно (інші файли паралельно); (2) `beforeAll` warm-up на /dashboard щоб скомпілювати layout + vendor chunks до першого реального тесту. Канон: для будь-якого e2e файлу що навігує >5 routes у Next.js dev → mode 'serial' + beforeAll warm-up. Альтернатива — `next build` перед тестами (повільніше, але без race).

### Gotcha — /sto-review (2026-05-27, commit f2e8182)

- **`React.ReactNode` / `React.CSSProperties` / `import('react').ReactNode` без іменованих імпортів** — Next.js TS-plugin суворіший за plain tsc; форма `React.X` (з global namespace) проходить tsc через `next-env.d.ts`, але це антипатерн skill §1. Канон: `import type { ReactNode, CSSProperties } from 'react'`. Виправлено у `apps/web/src/app/calendar/page.tsx`, `apps/web/src/app/layout.tsx`, `apps/web/src/components/SentryProvider.tsx`. Інші файли (наприклад `inline-edit-cell.tsx`) залишені бо не в скоупі поточних змін — фікс відбудеться коли файл наступного разу торкнеться.
- **AuthProvider on-mount `refreshToken().then(...)` без `cancelled` flag** — типовий патерн "useEffect з апі-викликом і []-deps". React не варнить про setState на unmounted у виробництві, але:
  1) Якщо користувач залишить root layout (повний reload) до завершення мережевого запиту — `dispatch` все одно виконається після unmount.
  2) Skill §3.1: `useEffect з apiFetch і [] deps на сторінках з навігацією — теж потребує let cancelled=false`.
  Канон: `let cancelled = false; ...then((ok) => { if (cancelled) return; ...dispatch(...) }); return () => { cancelled = true }`. Виправлено в `apps/web/src/lib/auth/context.tsx`.

### Gotcha — /sto-tester cycle-5 (2026-05-27, commit pending, bugs #127, #128)

- **CRITICAL — Prisma plural-table → singular-model lookup trap (Bug #127, sync.service.ts).** Прісма client експонує моделі **тільки в СІНГУЛЯР camelCase** (`prisma.workOrder`, `prisma.counterparty`, `prisma.warranty`), але Postgres таблиці через `@@map` — ПЛЮРАЛ (`work_orders`, `counterparties`, `warranties`). `SyncService.model()` робив наївний `snake_to_camel('work_orders') → 'workOrders'` → `prisma.workOrders === undefined` → `TypeError: Cannot read properties of undefined (reading 'aggregate')` синхронно при доступі до методу. `.catch()` на async не ловить це бо помилка кидається ДО створення Promise. У `getStatus()` через `Promise.all([...PULL_TABLES.map(t => this.model(t).aggregate(...).catch(...))])` весь Promise.all падає з 500. У `pull()` ховається `try/catch` всередині `.map()` — кожна таблиця тихо скіпається і клієнт завжди отримує `[]`. **Канон:** для будь-якого dynamic `(prisma as any)[modelName]` треба **explicit `TABLE_TO_MODEL: Record<string,string>` мапінг** + `if (!model) throw new Error(...)` (швидке провалення замість тихого undefined). Hairy bit: код проходив TSC бо `(this.prisma as unknown as Record<string, DynamicPrismaModel>)` — тип hides що ключ може не існувати. Регресія: `sync.contract.spec.ts` робить Prisma мок з ТІЛЬКИ сингулярами — якщо хтось знову додасть plural, мок не матиме методу і тест впаде.

- **CRITICAL — Sync pull payload spread BigInt → JSON.stringify 500 (Bug #128, sync.service.ts).** Після фіксу #127 `pull` почав реально знаходити рядки. `payload = { ...row }` копіює row.syncVersion (BigInt) у payload. Outer `syncVersion: Number(row.syncVersion)` сконвертовано, але payload-копія залишається BigInt. Fastify робить `JSON.stringify(response)` → `TypeError: Do not know how to serialize a BigInt`. Окремий патерн від звичайного DTO-mapper: тут BigInt сидить ВСЕРЕДИНІ payload-об'єкту (вкладений рівень), не у top-level response. **Канон:** для sync/pull-like ендпоінтів робити ручний прохід по полях — `if (typeof v === 'bigint') Number(v); else if ('toNumber' in v) v.toNumber()`. Об'єднати з PULL_FIELD_BLACKLIST в один цикл (одна ітерація замість двох). Регресія: `sync.contract.spec.ts` мокає `findMany` з `syncVersion: 5n` і перевіряє `typeof body.payload.syncVersion === 'number'`.

- **Why cycle-4 sweep missed it:** попередні sweep'и перевіряли `findAll` що повертають bare arrays, BigInt у top-level response, raw SQL casing. Але dynamic model lookup і payload-spread — нові патерни що проявилися тільки після того як sync почав використовуватись через WEB (settings/sync page). Pull endpoint завжди повертав `[]` через silent try/catch — баг сидів місяцями і ніхто не бачив. Знайдено тільки тому що **тестувальник curl-нув кожен endpoint** із list із SKILL §1 і перевірив 200/500 на всі шляхи включно з `/sync/status`. Канон: regression sweep MUST включати `/sync/status` + `/sync/pull` як обов'язкові ендпоінти для smoke check.

### Gotcha — /sto-review 2026-05-27 (commit b51e2dd)

- **BigInt у JSON.stringify крашить endpoint з 500** — будь-який Prisma model з `syncVersion BigInt @default(0)` що повертається з ендпоінта **без** `toResponseDto()`/`toDto()`/explicit `Number()` cast викликає `TypeError: Do not know how to serialize a BigInt`. Real bug: `NotificationsService.findTemplates()` повертав `findMany()` напряму (commit ea8f5a6). Канон: `rows.map(r => ({ ...r, syncVersion: Number(r.syncVersion) }))` або `select` без syncVersion або повний DTO mapper. Sweep по всіх services + check у `/sto-review` §13.

- **Manifest icons мають фізично існувати** — `apps/web/public/manifest.json` посилається на `/icons/icon-192.png` + `/icons/icon-512.png`; якщо файлів немає, PWA install падає + браузер пише 404 в логи + service worker не може кешувати. Канон: smoke-тест у `apps/web/e2e/smoke.spec.ts` робить GET на кожен static asset і чекає 200.

- **`@Max(200)` для list query limits** — frontend часто запитує `limit=200` для dropdown-списків (counterparties, work-orders); попередній `@Max(100)` тихо повертав 400. Підняли до 200 у обох DTO; додали contract test що захищає від регресу (приймає 200, відхиляє 201).

### Gotcha — /sto-tester cycle-2 post-review (2026-05-27, commit c30c38c, bugs #120-#126)

- **`total: items.length` після `take: N` — повторюваний шаблон, що проростає у нові endpoints** (Bug #120, #121, goods.controller.getBatches/getPriceHistory). Це 4-й інстанс цього патерну (попередні: #88 audit, #28 batches list, #83 dashboard low-stock). Канон: будь-який `findMany` з `take`-обмеженням MUST бути парою з `count()` без обмежень через `$transaction([findMany, count])` (або `Promise.all` для cross-table). `total: items.length` ВСЕРЕДИНІ controller з explicit `take` — це **завжди** баг навіть якщо frontend не використовує `total`. Документувати у MockResponseDto через `@ApiProperty({ description: 'Capped total (≤ limit)' })` тільки коли count умисно дорогий (search-like).
  ```bash
  # Регулярний grep для регресу (3+ інстансів за 2 тижні):
  grep -rn "total: items.length\|total: .*\\.length" apps/api/src --include="*.ts" | grep -v spec | grep -v "Capped"
  ```

- **Node URL parser НОРМАЛІЗУЄ IPv6 hostname до hex compressed form** (Bug #123, url-guard IPv4-in-IPv6). `new URL('http://[::ffff:127.0.0.1]').hostname` повертає `'[::ffff:7f00:1]'`, НЕ `'[::ffff:127.0.0.1]'`. Те ж саме для `[::10.0.0.1]` → `'[::a00:1]'`. Будь-який SSRF check написаний для dotted-quad формату (`::ffff:a.b.c.d`) тихо пропускає всі URL що користувач ввів — Node нормалізує до того як ваш regex побачить адресу. **Канон: пишіть regex/check проти НОРМАЛІЗОВАНИХ форм (`/^(?:::ffff:)?7f[0-9a-f]{0,2}:/` для loopback)**. Кращий підхід: парсити останні два хекстети як uint16+uint16 = 4 байти IPv4 і прогнати через звичайний IPv4 блок-лист. Це покриває `::ffff:` (IPv4-mapped), `::` (IPv4-compatible deprecated, але resolvable), і `::ffff:0:` (IPv4-translated RFC 2765). Помилка cycle-2 була "написати regex для dotted-quad що ніколи не з'явиться", правильно — "розпарсити нормалізовану compressed-hex форму як IPv4". Тестувати `validatePublicUrl(x)` ОБОВ'ЯЗКОВО через `new URL(x)` round-trip, не через hardcoded strings.

- **Двоступеневий `try/catch` з write-on-fail-path створює double-write** (Bug #126, webhooks.processor 3xx redirect path). Inner block (`if (res.status >= 300)`) робить explicit `await prisma.webhookDelivery.create(...) + throw deliveryError`. Throw escape-ить до outer `catch (err)` що robить `status='FAILED'; deliveryError=err`. Виконання продовжується ПОЗА try і доходить до загального delivery-log блоку (line 137) який пише ДРУГИЙ запис. Замість 1 webhookDelivery на 1 спробу — отримуємо 2 для кожного 302/301. Канон: коли processor має 2+ failure-paths що логуються в одну таблицю, ВСІ paths повинні встановлювати **тільки змінні** (status/responseCode/responseBody/deliveryError) і дозволити ЄДИНОМУ write-блоку наприкінці зробити одне `create`. Знайдено тільки тому що написали тести (Bug #125) — без них регрес сидів би у production створюючи штучний counter inflation і подвоєний log-spam.

- **Жоден security-helper не йде у main без unit-тестів** (Bug #124, url-guard.spec.ts). Cycle-1 helper мав регрес з IPv6 brackets (cycle-2 review знайшов). Cycle-2 helper мав регрес з IPv4-compatible IPv6 (цикл тестера знайшов). Без тестів кожен майбутній рефакторинг буде новим регресом. Канон: ЛЮБИЙ security utility (SSRF guard, sanitizer, validator) MUST мати щонайменше 30 тест-кейсів, що покривають: всі ALLOW edge-cases (sanity), всі BLOCK ranges (1 case per CIDR), всі scheme-types, всі normalization-quirks (URL constructor, encoding, case). Якщо тести треба переписати на кожному фіксі — це сигнал що канон правил у helper-і не виражений у тестах правильно.

### Gotcha — /sto-review cycle-2 (2026-05-27)

- **CRITICAL — `validatePublicUrl` IPv6 regex не враховує квадратні дужки**: `URL.hostname` для IPv6 повертає рядок з брекетами (`'[fc00::1]'`, `'[fe80::1]'`). Cycle-1 helper порівнював `host === '[::1]'` напряму, але паралельні regex'и `/^f[cd][0-9a-f]{2}:/i` і `/^fe[89ab][0-9a-f]:/i` ПАДАЛИ на брекетах — будь-яка ULA/link-local IPv6 адреса проходила як "безпечна". Атакер міг налаштувати webhook на `http://[fc00::1]:6379/` (внутрішній Redis) або `http://[fe80::1]/` і обійти весь SSRF захист, незважаючи на існування url-guard. **Канон: завжди розпаковуй IPv6 brackets ОДРАЗУ через `host.startsWith('[') ? host.slice(1,-1) : host` ДО будь-яких regex/literal-порівнянь**. Також додано перевірку `::ffff:127.0.0.1` IPv4-mapped адрес — без неї `http://[::ffff:127.0.0.1]/` (loopback переплетений) обходив би IPv4 блок-лист. Це 2-й SSRF-related баг за тиждень — недостатньо валідатор-функцію написати; треба unit-тестувати з реальними URL constructors `(new URL(x)).hostname`.
- **CRITICAL — `fetch(url)` без `redirect: 'manual'` повністю нівелює SSRF guard через redirect**: cycle-1 додав `validatePublicUrl` у processor перед `fetch`, але `fetch` за замовчуванням `redirect: 'follow'`. Якщо attacker контролює зовнішній endpoint (`https://attacker.com/webhook`), він повертає `302 Location: http://localhost:6379/FLUSHDB` — Node `fetch` тихо переходить, надсилає POST з webhook payload на внутрішній Redis. URL валідація на оригіналі вже пройшла. **Канон для будь-якого server-side fetch на user-controlled URL: `redirect: 'manual'` + явна перевірка `res.status` 3xx → reject. Не `redirect: 'follow'` ніколи. Не `redirect: 'error'` (бо тоді 3xx стає мережевим errror без логування статусу).** Логуємо 3xx як FAILED webhookDelivery з `Redirect to <Location> blocked` body — оператор бачить що endpoint redirect-ить, не вгадує "чому не доставляється".
- **IMPORTANT — `new Date().toISOString().split('T')[0]` у render path** (booking/page.tsx min date): SSR prerender на UTC сервері дає одну дату, клієнт у Kyiv після UTC midnight дає іншу → hydration mismatch + `min` attribute на DatePicker блокує сьогоднішню дату для частини користувачів. **Канон: будь-яке `new Date()` що читається у JSX (`min`, `max`, default value, formatted strings) — `useState('')` + `useEffect(() => setX(format(new Date())), [])`**. Це 4-й рецидив hydration-mismatch патерну з minor variations (попередні: `useState(new Date())`, `useState(() => localStorage.get())`, `useState(() => new Date()...)`).
- **IMPORTANT — `key={i}` у list з фільтрами/sort/refetch** (booking page slots): React reuses DOM nodes by key; з `key={i}` після фільтру slots `[A, C]` → `[B, C]` слот B дістає DOM індекс A, slot C дістає індекс C. Якщо button мав focus, hover, або animation state — переходить на не той slot. Канон: для будь-якого list з можливою re-order/filter операцією — stable per-item key (`item.id` для DB-сутностей, derived hash для синтетичних об'єктів типу `${liftId}-${startAt}` для slots без id).

### Gotcha — /sto-tester cycle-2 (2026-05-27, commit f11f028, bugs #111-#119)

- **Public widget pages ЗА ЖОДНИХ умов не повинні використовувати `apiFetch`** (Bug #111, booking/page.tsx). `apiFetch` на 401 робить `window.location.replace('/login')` що смертельно для публічної сторінки (`/booking` був у PUBLIC_ROUTES але викликав auth-guarded `/branches`). Канон: для будь-якої сторінки у TopShell `PUBLIC_ROUTES` — створити окремий `publicFetch` хелпер (звичайний `fetch` без token + без redirect) АБО окремий public endpoint `/api/booking/branches` під @Public (без JwtAuthGuard). Перевірити: grep `apiFetch` в усіх сторінках з PUBLIC_ROUTES — `/login`, `/setup`, `/booking`, `/403`. Якщо знаходить — це BUG.

- **`service['prisma']` bracket access обходить TS private** (Bug #112, booking.controller.ts). TS private — compile-time only; `service['prisma']` працює на рантаймі і компайл-чек проходить. Це anti-pattern бо: (1) circumvents API design (контролер мав би використовувати public метод сервісу), (2) делає рефакторинг ризиковим (приватний `prisma` field — internal contract, при заміні на DI чи repository pattern зламається). Канон: ВСІ controller→data звернення йдуть ТІЛЬКИ через public методи сервісу. grep `service\['` або `\['prisma'\]` — code smell, потребує refactor у service-level public API.

- **Soft-deleted `findFirst({ where: { id } })` без `deletedAt: null` — повторюваний шаблон** (Bug #112). Це Bug #95-pattern (Soft-deleted FK pre-check на clone), але у новому контексті — public lookups. Канон: ЖОДЕН `findFirst`/`findUnique`/`findMany` на soft-deletable моделі НЕ обходиться без `deletedAt: null` (виняток — admin tools/audit). grep `findFirst.*where:\s*\{\s*id` без `deletedAt` — кандидат на bug.

- **UTC "T...Z" hardcode для робочих годин — DST-naïve booking slots** (Bug #113, booking.service.ts). `new Date('2026-05-27T09:00:00.000Z')` = 12:00 Київ влітку, 11:00 Київ взимку. Канон для робочих годин: ISO offset з timezone-aware обчислення. `kyivOffsetForDate(date)` — мінімальний хелпер через `Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Kyiv' })` + `toLocaleString` round-trip обчислює `+02:00`/`+03:00`. Не покладатись на `new Date()` (server-local) і не на `Z` (UTC). Це 3-й DST-related баг у проекті (B8 followup processor, dst_kyiv feedback, тепер booking).

- **`@IsUrl({ require_tld: false })` = SSRF vector** (Bug #114, webhooks.dto.ts). `require_tld: false` дозволяє `localhost`, `192.168.*`, `10.*`, `169.254.*`, `[::1]`. Класичний SSRF на внутрішні Redis/Postgres/cloud-metadata. Канон: для ЛЮБОГО user-supplied URL що server потім fetch-ить — окремий `validatePublicUrl()` helper з блок-листом RFC1918/loopback/link-local/ULA/non-http(s). `apps/api/src/common/utils/url-guard.ts` — single source of truth. Defense-in-depth: ВАЛІДАЦІЯ І при create/update DTO, І в processor перед fetch (DNS rebinding mitigation). У processor для SSRF — НЕ re-throw (retry безглуздий, це config bug, не transient).

- **`@IsArray()` БЕЗ `@ArrayMaxSize(N)` = OOM DoS** (Bug #115, inspection.dto.ts). `class-validator` пропустить будь-який розмір; `ValidateNested({ each: true })` валідує **КОЖЕН** елемент → 1M елементів = 1M validation iterations + 1M heap allocations. Канон: для КОЖНОГО `@IsArray()` поля у DTO — `@ArrayMaxSize(N)` де N — реалістичний бізнес-потолок (50 inspection points, 100 WO parts, 500 invoice lines). grep `@IsArray()` без `@ArrayMaxSize` — патерн.

- **MinIO/S3 delete порядок: DB-row FIRST, then external** (Bug #116, work-order-media.service.ts). Інверсний порядок (file→row) при MinIO fail дає orphan DB record що в findAll генерує broken signedUrl → 404 для користувача. Правильно: row first (transient DB fail → file лишається, можна повторити), file second (transient MinIO fail → garbage у MinIO, але DB consistent, batch-cleanup пізніше). Те ж для будь-якої external storage: avatar deletion, audit log archival, external email service.

- **`@MaxLength` без `@MinLength` для search-style полів = short-query DoS** (Bug #117, search.dto.ts). `q='a'` тригерить `similarity(text, 'a') > 0.1` — match-ить майже все, але кожен match — heavy GIN-scan. Frontend filter `q.length >= 2` не достатньо — atacker може robust HTTP curl. Канон: `@MinLength(2)` обов'язково для search/filter/autocomplete полів.

- **Auth/refresh dup-ed у per-component fetch helpers** (Bug #118, xlsx-import-button.tsx). Це класична regression-risk: ОДНА change в `tryRefresh()` (cookie semantics, retry policy, redirect target) — БУДЕ забута у дублі. Канон: ЄДИНІ помічники — `apiFetch`, `apiBlobFetch`, `apiMultipartFetch` з `lib/api-client.ts`. grep `function tryRefresh\|async function fetchWithAuth` у `apps/web/src` поза `lib/api-client.ts` — code smell.

- **`@Query('xxxId') id: string` без `ParseUUIDPipe` на public endpoint = 500 spam** (Bug #119, booking.controller.ts). Невалідний UUID → P2023 → 500. На auth-guarded endpoint це internal log noise; на public endpoint — будь-хто може спамити 500-помилками і wear alerting. Канон для ВСІХ public endpoints (`@Public` декоратор або controller без JwtAuthGuard): runtime regex-validation (UUID, date YYYY-MM-DD) перед service call. ParseUUIDPipe як швидкий drop-in для UUID; для date — `@Matches` у DTO або inline regex.

- **`validatePublicUrl` helper** (apps/api/src/common/utils/url-guard.ts): нова canonical utility для SSRF defense. Блокує: loopback (127.0.0.0/8, ::1), RFC1918 (10/8, 172.16/12, 192.168/16), link-local (169.254/16, fe80::/10), ULA (fc00::/7), CGNAT (100.64/10), 0.0.0.0/8, "localhost"-style hostnames, non-http(s) schemes. Використовувати для будь-якого user-supplied URL що server потім touch-не: webhooks, image proxies, external API integrations, OAuth callbacks (whitelist домени).

### Gotcha — /sto-review cycle-1 (2026-05-27, commit e4ce8b1)

- **`@CurrentUser() user: { sub: string }` антипатерн — НЕ обмежується одним контролером, повторюється** (4 нових інстанси в auth/purchase-orders/stock-documents/payments). Bug #92 виправили лише для invoices та work-orders, проте grep `@CurrentUser.*sub` показав ще 4 controller-и де `user.sub` був тихо `undefined` (downstream `findFirst({ where: { id: undefined, orgId } })` повертає БУДЬ-який запис у org — у getMe користувач міг побачити іншого employee). Канон: ПІСЛЯ кожного fix цього патерну ОБОВ'ЯЗКОВО зробити global grep `@CurrentUser.*sub` і поправити всі — частковий fix залишає latent silent bugs. Додано до §1 grep-ів. Майбутній попереджувач: pre-commit hook `! grep -rn "@CurrentUser.*sub" apps/api/src --include="*.ts"`.
- **`@IsString()` на union-string type — `'OK' | 'WARN' | 'CRITICAL'` приймає будь-який рядок** (inspection.dto InspectionPointDto.status): TS-тип у DTO `'OK' | 'WARN' | 'CRITICAL'` — fiction для runtime. `class-validator` бачить тільки декоратори; `@IsString()` пропускає `'EVIL'`. Канон: для будь-якого `field!: 'A' | 'B' | 'C'` обов'язково `@IsIn(['A','B','C'])` (або генерувати const tuple + type from it). Додавати `@MaxLength` для всіх вільних `@IsString` полів — анти-DoS захист (без нього `notes: '...'.repeat(1_000_000)` стискає API request body).
- **Loyalty redeem race — `findFirst + balance check + decrement` всередині $transaction НЕ є атомарним** (loyalty.service.ts redeem): READ COMMITTED isolation дозволяє двом одночасним redeem-ам обидвом прочитати `balance=100`, обидвом передати check `balance >= 100`, обидвом decrement → final balance = -100. Канон для check-and-decrement на лічильниках/рахунках: `updateMany({ where: { id, balance: { gte: points } }, data: { balance: { decrement: points } } })` → Postgres UPDATE ... WHERE balance >= N — атомарний. Якщо `count === 0` — або записа немає, або балансу не вистачило (унифікований error path). Те ж стосується: stock decrement, loyalty wallet, prepayment redemption.
- **`total: items.length` після `take: N` — шаблонний баг #88 з пам'яті, повторюється в new code** (work-order-media.service.ts findAll): На media review був пропущений під час review #93 (фокус на `fileKey` витоці). Канон: grep `total: items.length` пробігати на КОЖНОМУ /sto-review циклі — це повторюваний шаблон з 4+ задокументованих інцидентів.
- **`React.ChangeEvent<...>` без імпорту `import type React` — VSCode помилка, tsc може мовчати** (date-picker-input.tsx): додано до §1 SKILL.md як одна з типових помилок. Канон: ЗАВЖДИ `import type { ChangeEvent } from 'react'` + use `ChangeEvent<HTMLInputElement>` без префікса. Те ж для `HTMLAttributes`, `SVGAttributes`, `MouseEvent`, `FormEvent`, `ReactNode`.
- **Migration без trgm-defense block — Prisma migrate dev silently DROPs B6 indexes** (4 нових міграції). Це 3-й цикл з тією ж проблемою (per Memory: 20260526113130, 20260526124850, тепер +4). Канон CRITICAL: КОЖНА нова `migration.sql` має ЗАКІНЧУВАТИСЬ `CREATE INDEX IF NOT EXISTS idx_*_trgm` блоком (повний список з 20260526061209_b6_trgm_gin_indexes). Без виключень — навіть для міграцій що не торкаються `goods`/`counterparties`/`work_orders`. Запропонувати pre-commit: `for m in $(git diff --name-only --cached | grep migration.sql$); do grep -q "idx_work_orders_number_trgm" "$m" || exit 1; done`.

### Gotcha — /sto-tester FULL on 3c6d233..fab5fd1 (2026-05-26, bugs #97-#110, B8 FollowUp CRON)

- **BullMQ scheduler + soft-deleted org = щоденне будіння мертвих tenants** (Bug #97, followup.scheduler.ts): `prisma.organisation.findMany({ select: { orgId: true } })` без `where: { deletedAt: null }` означає CRON-job для кожного клонованого/видаленого tenant'а. Канон: КОЖЕН `organisation.findMany` має `where: { deletedAt: null }` — нема жодного use-case коли потрібні deleted orgs (audit-trail використовує `findFirst` без soft-delete фільтра, не findMany).

- **`Organisation.id` vs `Organisation.orgId` — convention яка чекає першого розробника що зламає її** (Bug #98): Schema має ДВА UUID колонки на Organisation: `id` (PK) і `orgId` (sibling). Усі FK у проекті (counterparties, vehicles, garage_branches, organisation_settings, ...) REFERENCES `organisations(id)`. Колонка `orgId` дорівнює `id` лише завдяки конвенції в `setup.service.ts` де `update({ orgId: org.id })`. Канон: ВСЯ кодова база читає org через `findFirst({ where: { id: orgId } })` і `select: { id: true }` (підтверджено grep — `followup.scheduler.ts` був єдиним consumer-ом field `orgId`). Майбутньому розробнику зрозуміліше було б видалити `orgId` колонку взагалі і використовувати тільки `id`, але це міграційний ризик. На зараз — DEV-rule: ніколи не читати `Organisation.orgId`, тільки `Organisation.id`.

- **`new Date()` у CRON-processor + server-local arithmetic = DST/timezone landmines** (Bug #99, followup.processor.ts): На UTC-сервері (Docker default) і Kyiv-сервері (Windows on-prem) `setDate(d.getDate() + N)` поводиться по-різному біля DST-границь і опівночі. Канон для CRON-обчислень дат: завжди прив'язувати "today" anchor до фіксованого UTC-часу всередині Kyiv-дня: `today.setUTCHours(9, 0, 0, 0)` дає 11/12:00 Kyiv (стабільний полудень, ±1h DST не виштовхує за межі дня). Це найдешевший фікс — без `Intl.DateTimeFormat('Europe/Kyiv')` чи `kyivOffsetMs()`.

- **`findFirst` без `orderBy` для "primary" branch = non-deterministic SMS sender в multi-branch орг** (Bug #100): Postgres heap-order для `findFirst` нестабільний між запусками. У multi-branch орг (типовий продакшен-кейс — мережа СТО з 2-5 точками) це означає що ранкові SMS клієнтам можуть йти з імені різних branch-ів день у день. Канон: ЗАВЖДИ `orderBy` для будь-якого "primary/main/default" findFirst — мінімум `{ createdAt: 'asc' }` для "найперший створений", краще explicit `isMain/isPrimary` flag з partial unique index (див. Bug #69 для прикладу).

- **Prisma `none: { completedAt: { gte: cutoff } }` ВКЛЮЧАЄ авто з порожнім зв'язком** (Bug #101): SQL semantics `NOT EXISTS (subquery)` true коли SUBQUERY RESULT IS EMPTY. Тобто vehicle з 0 WO підпадає під `workOrders: { none: {...} }`. Для "тихих клієнтів" треба пара: `some: { completedAt: { lt: cutoff } }` (мав WO в минулому) + `none: { completedAt: { gte: cutoff } }` (нічого недавно). Інакше нагадування "ми скучили" летить новому клієнту що тільки зареєстрував авто.

- **`MaintenanceSchedule.nextMaintenanceDate { lte }` без `{ gte: today }` = SMS-спам на роки** (Bug #102): Якщо клієнт пропустив ТО 6 місяців тому і schedule не reset, CRON надсилав однакову SMS щодня з тієї дати. Канон для будь-яких reminder-CRON: `{ gte: today, lte: today + forecastDays }` — нагадуємо тільки про "скоро настане", не "давно пропущено". Для overdue maintenance — окремий процес/notification (escalation campaign), не той самий CRON.

- **Прихована залежність: feature вимагає `NotificationTemplate` яка не у migration/seed** (Bug #103): B8 додав FOLLOWUP_REMINDER enum, але `NotificationsService.send()` шукає `findFirst({ eventType, channel, isActive: true })` → null → return мовчки. Канон для будь-якого нового NotificationEventType: ОБОВ'ЯЗКОВО парна міграція з `INSERT NOT EXISTS` для існуючих orgs + seed.ts оновлення. Без template feature dead на свіжому інсталі.

- **`.catch()` per-iteration без re-throw на ВСІ-fail = BullMQ ніколи не retry-ть** (Bug #104): Класичний анти-pattern з SKILL §4.9.4. Per-message catch (один поганий phone не валить batch) — OK, але потрібен лічильник: якщо `sendErrors > 0 && sendSuccess === 0` → `throw lastError`. Інакше Redis-fail виглядає як success у логах, операційники не знають що щось зламано.

- **Migration SQL що містить ALTER TYPE + USE того TYPE в одному файлі краще розбити** (Bug #103 fix): Postgres вимагає commit-у ENUM-value перед використанням. Канон: ALTER TYPE у migration N, INSERT з новим value — у migration N+1. Інакше CI може фейлити з `ERROR: unsafe use of new value`.

- **`take: 5000` для CRON-batch на per-org — peak memory bomb** (Bug #106): 5000 records × {include vehicle, counterparty, workOrders[1]} ≈ 100MB heap per org. Multi-org concurrent execution (BullMQ default concurrency 5) = 500MB peak. Канон для periodic batches: explicit `MAX_*_PER_RUN` константи на топі файлу + warning при reach + TODO про cursor pagination. Дешевший за full pagination на цей етап.

- **`getRepeatableJobs` + `removeRepeatableByKey` + `add` = race window на кожен restart** (Bug #108): На API-рестарті віконце між delete і add (~50ms) — CRON втрачено якщо crash. BullMQ `jobId` сам дедуплікує — `add({ jobId: 'fixed-key' })` ідемпотентний. Канон: НЕ робити preliminary remove у onModuleInit, лише `add` з фіксованим jobId.

- **Migration без захисного `CREATE INDEX IF NOT EXISTS` для pg_trgm GIN — Prisma migrate dev мовчки drop-не** (зв'язок з gotcha від commit 7b899e4): `prisma migrate dev` додає `DROP INDEX` для raw-SQL trgm GIN indexes з `20260526061209_b6_trgm_gin_indexes` коли генерується НОВА міграція. Канон: новий міграція = пара `CREATE INDEX IF NOT EXISTS "idx_*_trgm"` block наприкінці для defense. Без цього B6 search падає на seq scan після КОЖНОЇ schema-change міграції. Тут — додано у `20260526230500_followup_reminder_default_template/migration.sql`.

- **Per-tenant SMS sender = per-branch — який branch обрати?** (Bug #100 deep dive): Multi-branch architecture B10 створила питання яке B8 не вирішила: SMS-sender (`senderName`, `smsApiKey`) живе на `BranchSettings`, але FollowUp реагує вище — на orgId-rivni. Tier-1 фікс: oldest branch. Tier-2 правильне рішення: або per-vehicle resolve через `lastWorkOrderBranchId` (потрібен новий FK), або brand-level SMS config окрема таблиця `OrganisationSmsConfig`. Розглянути для майбутньої feature.

- **CRON-processor unit-тести: 13 кейсів які стоять писати** (Bug #105, followup.processor.spec.ts шаблон): (1) followUpActive=false → no send, (2) no branch → no send, (3) soft-deleted vehicle/garage/counterparty фільтруються, (4) phone dedup один клієнт → 1 SMS, (5) no phone skip, (6) inactive vehicle з минулим WO → send, (7) vehicle never had WO → no send (defensive), (8) all-fail → throw для retry, (9) partial-fail → no throw, (10) formatName fallback, (11)-(13) DB-filter shape assertions (`expect.objectContaining({ where: ... })` для critical filters). Це baseline для будь-якого нового @Processor.

### Gotcha — /sto-tester FULL on e7e0c83..0aa4cb3 (2026-05-26, bugs #0a + #91-#96)

- **Baseline TS-помилка маскується пропущеним `mapXxx()` shape оновленням** (Bug #0a, settings.service.ts): попередня сесія додала `followUpActive`/`followUpDays` у DTO/Response, але приватний `mapOrgSettings` мав inline тип параметра — оновлення цього inline shape тихо пропустили. `tsc --noEmit` ламається на КОЖНОМУ запуску. Канон: коли додаєш поле у Response DTO + DB schema, обов'язково оновити: (a) DTO `OrganisationSettingsResponseDto`, (b) Request DTO `UpdateOrganisationSettingsDto` з валідацією, (c) **усі `mapXxx()` shape**-визначення, (d) seed/mock у contract тестах. Краще пара generic helper-ів типу `Pick<Prisma.OrganisationSettings, keyof OrganisationSettingsResponseDto>` ніж дублювати inline shape. Тестуй регресію — додав contract test `Bug #84 regression: followUp fields end-to-end` (4 кейси).

- **`@CurrentUser() user: { sub: string }` повторюється у нових контролерах попри попередню Gotcha** (Bug #92, invoices.controller.ts create + createFromWorkOrder): попередня сесія зафіксувала цей анти-паттерн для work-orders, але invoices, які `@CurrentUser` теж використовують, пропустили. Канон: загальний grep `@CurrentUser.*sub` як precommit check.
  ```bash
  grep -rn "@CurrentUser.*sub" apps/api/src --include="*.ts" && exit 1 || exit 0
  ```

- **Clone-операції — окремий клас invariantів** (Bugs #81, #82, #90, #91, #94, #96): дублювання сутності з релейтед records (lines/parts, FK на vehicle/counterparty/branch) має 6+ скритих pitfalls:
  1. **Totals** — Prisma defaults все обнуляють, обов'язково pre-compute (#81, #82).
  2. **workOrderId/parentId reference** — НЕ копіювати owning FK (один-до-одного зв'язок) (#91). Клон — самостійна сутність.
  3. **Soft-deleted FK** — pre-check кожен FK у `findFirst({ deletedAt: null })`, інакше P2003 → HTTP 500 замість дружнього 404 (#90).
  4. **State-related fields** — `actualHours`, `completedAt`, `paidAmount` мають reset до DRAFT-defaults (#94). НЕ копіювати "виконано/оплачено" у новий DRAFT.
  5. **AuditEvent** — клон ЦЕ create operation, потребує `audit.record('CREATE', ..., { clonedFromId })` (#96).
  6. **Document number sequence** — `docNumbers.next` поза `$transaction` → "дірка" у numbering при FK fail (#95, поки відкритий — LOW).

- **`apiMultipartFetch` — третій canonical fetch helper** (Bug #85, api-client.ts): тепер три варіанти silent-refresh:
  | Helper | Content-Type | Body | Returns |
  |---|---|---|---|
  | `apiFetch<T>(path, init?)` | application/json | string/JSON | `T` (parsed JSON) |
  | `apiBlobFetch(path, init?)` | (не задається) | (зазвичай undefined) | `Blob` |
  | `apiMultipartFetch<T>(path, formData, init?)` | (multipart/form-data automatic) | `FormData` | `T` (parsed JSON) |
  ВСІ роблять `tryRefresh()` при 401, `window.location.replace('/login')` при refresh fail. **Ніколи** не використовуй native `fetch(...)` напряму у компонентах — це обхід refresh+redirect logic.

- **AuditEvent `findByEntity` total мав bug-pattern `total: items.length` після `take: N`** (Bug #88): класична помилка пагінації — `total` cap-ується разом з items. Frontend думає що бачить ВСЕ. Канон: `$transaction([findMany, count])` де `count` без `take`/`skip`/`orderBy`. Той же патерн застосуй у будь-якому новому `findX` що має `take: N`. Grep:
  ```bash
  grep -rn "total: items.length\|total: .*\\.length" apps/api/src --include="*.service.ts"
  ```

- **DTO `fileKey` витік на frontend = least-privilege порушення** (Bug #93, work-order-media.dto.ts): внутрішній MinIO object path `org/<uuid>/work-orders/<uuid>/<uuid>.jpg` повертався у DTO, але frontend його не використовує (тільки signedUrl). Канон: response DTO містить **лише поля які реально потрібні UI**. Будь-яке поле що не споживається — кандидат на видалення (грeп у frontend).

- **`min`/`max` props у DatePickerInput треба ВЖИВАТИ, а не лише декларувати** (Bug #87): TS-інтерфейс мав `min?: string; max?: string`, але `DayPicker` не отримував `disabled={[...]}` matcher. Це класична TS-довірливість: тип проходить compile, runtime ігнорує. Канон: будь-який prop у TS interface — у JSX має бути спожитий. Lint-правило `react/no-unused-prop-types` від `eslint-plugin-react` ловить це. Без нього — code review.

- **`useEffect` для Escape handler лише при `lightboxUrl` truthy** (Bug #89, work-orders/[id]/PageClient.tsx): `useEffect(() => { ... }, [lightboxUrl])` з early-return `if (!lightboxUrl) return` робить subscribe тільки коли модалка відкрита, і автоматично unsubscribe при закритті. Канон для будь-якої наступної lightbox/popover/dropdown реалізації: pair з `role="dialog" aria-modal="true" aria-label="..."` І keydown listener у `useEffect([open])`. 

### Gotcha — /sto-review on e7e0c83..cdeb9f6 (2026-05-26, commit 7ee1db4)

- **EventSource не передає Bearer header — SSE авторизація через query token обов'язково має manual verify** (dashboard.controller.ts B9): нативний `EventSource` не підтримує custom headers, тому SSE endpoint не можна захистити стандартним `@UseGuards(JwtAuthGuard)` — guard очікує `Authorization: Bearer`. Канон: для SSE окремий endpoint який приймає `?token=<jwt>`, вручну викликає `jwtService.verify(token, { secret: config.getOrThrow('JWT_ACCESS_SECRET') })`, валідує `payload.sub && payload.orgId`, кидає `UnauthorizedException` інакше. **АЛЕ паралельний non-SSE endpoint (`/dashboard/summary`) ВСЕ ОДНО треба захистити** контролер-рівневим `@UseGuards(JwtAuthGuard, RolesGuard)` + `@Roles(...)` — інакше це open hole. Грeп `@Controller` без `@UseGuards` на рівні класу І без `@UseGuards` на кожному методі — це CRITICAL.
- **Hardcoded `'sto_token'` рядок як ключ sessionStorage = німий auth fail** (useDashboardStream.ts + work-orders/[id]/PageClient.tsx): канонічний ключ — `TOKEN_KEY = 'sto_access_token'` (експортується з `@/lib/auth`). Hardcoded `'sto_token'` ніколи не повертає валідний токен, але `sessionStorage.getItem` повертає `null` мовчки — fetch стартує без header, API відповідає 401, EventSource onerror зриває reconnect loop. Канон: ЗАВЖДИ `import { TOKEN_KEY } from '@/lib/auth'`. Grep на `sessionStorage.getItem.*sto_` без TOKEN_KEY — CRITICAL.
- **Env var drift `NEXT_PUBLIC_API_BASE` vs `NEXT_PUBLIC_API_URL`** (useDashboardStream.ts): в проекті прийнято `NEXT_PUBLIC_API_URL` (api-client.ts, auth/context.tsx, xlsx-import-button.tsx). Hook `useDashboardStream` шукав `NEXT_PUBLIC_API_BASE` що ніколи не існував → `localhost:3000` у проді, SSE не конектиться. Канон: одна канонічна env-змінна на API base URL, винесена у `lib/api-client.ts` як `export const API_URL`. Уникнути копі-паст hardcoded `process.env.NEXT_PUBLIC_API_*` у нових файлах — імпортуй з api-client.
- **Multipart file upload через нативний `fetch` потребує `/api` префіксу І `credentials: 'include'`** (work-orders/[id]/PageClient.tsx handleMediaUpload): `apiFetch` сам додає `/api`, але `apiFetch` не підтримує `FormData` (фіксує Content-Type у JSON). При використанні raw `fetch(${API_URL}/work-orders/...)` забули `/api` префікс І `credentials: 'include'` для refresh-cookie. Канон: коли upload вимагає `multipart/form-data` — `fetch(\`\${apiBase}/api/<path>\`, { credentials: 'include', headers: { Authorization: \`Bearer \${token}\` } })` БЕЗ Content-Type (браузер сам додасть boundary). Альтернатива: розширити `apiFetch` щоб detect-ив `FormData` body і пропускав Content-Type — TODO у follow-up.
- **`@CurrentUser() user: { sub: string }` тип-брехня** (work-orders.controller.ts transition/clone): `AuthenticatedUser` (jwt.strategy.ts) реально повертає `{ id, orgId, role }` — НЕ `{ sub }`. `sub` присутній лише у raw JWT payload. Анотація `{ sub: string }` ламає TS у боку розробника: TS приймає `user.sub` (поле є в типі), runtime повертає `undefined`. Будь-який downstream код що передає `userId` далі (audit, settlement.createTransaction) тихо отримує `undefined` → audit log skip, settlements creator missing. Канон: ЗАВЖДИ `@CurrentUser() user: { id: string }` для controllers що потребують auth user. Глобально grep `@CurrentUser.*sub` — це регулярний bug-pattern (8+ контролерів у проекті досі мають цю помилку).
- **Path traversal у multipart filename → object-storage** (work-order-media.service.ts upload): `file.filename.split('.').pop()` для extension без sanitization не дає traversal (`crypto.randomUUID()` робить шлях унікальним), АЛЕ `filename` зберігається в DB і повертається у DTO; HTML `<img alt={m.filename}>` міг би показати XSS-нерелевантне `../../etc/passwd.jpg`. Канон: `path.basename(filename.replace(/\\/g, '/'))` + control-char strip + 255-char cap + ext whitelist. Те ж стосується будь-яких file upload endpoints: `xlsx-import`, `attachment-upload`, custom logo upload.
- **`take: N` на `prisma.X.count()` — мовчки ігнорується** (dashboard.service.ts stockItem): `count()` повертає число, не масив — `take` параметр не входить у `Prisma.XCountArgs`. TS не ловить бо `count` приймає `{ where, ... }` без обмеження keys. Канон: НЕ передавати `take` у `count()` — нема ефекту, плутає reviewer. Якщо реально треба capped count — `take` у `findMany({ select: { id: true } }).then(r => r.length)`.
- **`(decimal as any).toNumber()` ховає тип Prisma.Decimal** (dashboard.service.ts revenue sum): Prisma `_sum.amount` повертає `Prisma.Decimal | null`. Cast `as any` → виклик `.toNumber()` працює, але type lost і null-check не gerada (NaN при null). Канон: `Number(decimalValue)` (працює і для Decimal і для null → NaN → треба guard) АБО `decimalValue != null ? Number(decimalValue) : 0`. Ніколи `as any` навколо Prisma результатів — використовуй `Number(x)` cast який TS розуміє через Decimal.toNumber вбудоване coercion.
- **`audit-log` endpoint без ParseUUIDPipe → P2023 → HTTP 500** (audit.controller.ts findByEntity): `@Query('entityId')` без `ParseUUIDPipe` приймає будь-який string, Prisma `where: { entityId: 'not-a-uuid' }` падає `PrismaClientKnownRequestError P2023`, NestJS повертає 500 замість 400. Канон: `@Query('xxxId', new ParseUUIDPipe())` для будь-якого param/query очікуваного UUID. Те ж для polymorphic `entityType` — whitelist у `@IsIn(...)` або in-controller `if (!ENTITY_TYPES.includes(entityType)) throw new BadRequestException(...)`.


### Gotcha — /sto-review on commit 7b899e4 (2026-05-26, d53b626)

- **Prisma auto-migrations silently DROP untracked indexes (pg_trgm GIN, custom raw-SQL).** Each `prisma migrate dev` re-generates a draft with `DROP INDEX "idx_*_trgm"` for the trigram GIN indexes created by `20260526061209_b6_trgm_gin_indexes` (raw SQL — Prisma schema parser doesn't see them). Two migrations have now repeated this mistake (`20260526113130_warehouse_is_main` was caught; `20260526124850_stock_document_receipt_work_warranty` was not until this review). **Canon:** every new migration must be diff-checked for `DROP INDEX "idx_.*_trgm"` and patched with `CREATE INDEX IF NOT EXISTS ...` defense block. Consider a pre-commit hook: `grep -L "DROP INDEX.*trgm" packages/database/prisma/migrations/*/migration.sql || exit 1`.
- **Nested-controller route + standalone frontend URL = path drift.** Frontend called `/api/settlements/reconciliation-acts/:id/pdf` while controller mounted at `@Controller('counterparties/:counterpartyId')`. Real route is `/api/counterparties/:cpId/reconciliation-acts/:actId/pdf`. **Canon:** when adding a new endpoint to a nested-prefix controller, grep frontend `apiFetch`/`apiBlobFetch` calls for the resource name and verify path prefix matches. Add cross-FK tenant isolation in service (`findFirst({ id, orgId, counterpartyId })`) — `@Param('counterpartyId')` alone doesn't validate it belongs to the act.
- **Cross-tenant FK validation on ADD-line / UPDATE endpoints** (invoices.addLine `goodId`/`workId`). The skill calls this out in §2.2, but it's easy to forget for sub-entity CRUD (lines, parts, comments). **Canon:** every endpoint that accepts an FK uuid in body — even on a child resource — must do `findFirst({ id, orgId })` before linking. The parent being in-org does NOT imply the new FK is in-org.
- **Soft-delete vs hard-delete for config tables**: `TaxRate` has no `deletedAt` but IS referenced (by `vatRate` decimal value) in past `InvoiceLine` rows. Hard delete loses audit trail. **Canon:** for config tables snapshotted into business records (rate copies, name copies), use `isActive=false` as soft-delete + reject delete on `isDefault=true`. Same pattern: `PaymentMethodConfig`, `NotificationTemplate`.
- **Magic-number cost ratio in financial reports** (reports.profitability `0.4` labor cost). Even when not yet wired to a DB setting, factor into named `const` with TODO comment — makes refactor to `OrganisationSettings.laborCostRatio` discoverable via grep.
- **Inline PATCH on every onChange** (settings/page.tsx docNumbers prefix/separator): fires DB write per keystroke. **Canon:** auto-save inputs use `onBlur`, not `onChange`. Surface errors in page-level `error` state instead of silent `.catch(() => {})`.
- **Enum-string `@Param` casting to Prisma enum at service layer** (settings.controller `documentType: string` → `documentType as DocumentType`). Invalid string passes controller, then either silently misses by `findFirst` (404) or P2009-crashes Prisma (500). Add `@IsIn(Object.values(EnumName))` on DTO fields cast to Prisma enums.

### Gotcha — /sto-tester FULL on commit 7b899e4 (2026-05-26, bugs #74–#80)

- **Cost fallback в звітності НІКОЛИ не дорівнює sale-price** (Bug #74, `reports.service.ts profitability()`): код мав `const cost = part.batchCostPrice ?? part.price` де `part.price` — це САЛЕ-ціна позиції WO. Коли `batchCostPrice IS NULL` (запчастина додана без батча), собівартість дорівнювала виручці і прибуток ≈ 0 — катастрофічно неправильно для P&L звітності. Канон: при будь-якому fallback на "cost" НІКОЛИ не використовувати sale-price. Послідовність: `batchCostPrice ?? good.purchasePrice ?? null`. Якщо все ще null — додавати позицію до `unknownCostPartsCount` лічильника, не до `totalCost`. Краще завищити прибуток (and surface that some parts are uncosted) ніж занизити підставою sale-price як cost.
- **Prisma `lt`/`gt` filter EXCLUDES NULL rows** (Bug #75, work-orders.service.ts mileage sync): `prisma.vehicle.updateMany({ where: { currentMileage: { lt: N } }, data: { currentMileage: N } })` НЕ оновлює рядки з `currentMileage IS NULL` (SQL: NULL vs число → UNKNOWN → row excluded). Канон: будь-який числовий "update if smaller OR if missing" — обов'язково `OR: [{ currentMileage: null }, { currentMileage: { lt: N } }]`. Те ж стосується дат: `updatedAt`, `lastSeenAt`, `dateOfLastService` — не покладатись на implicit NULL semantics у фільтрах.
- **PDF/Blob downloads повинні мати silent refresh як `apiFetch`** (Bug #77, settlements + work-orders pages): прямий `fetch(${apiBase}/api/...)` з ручним Bearer-токеном не робить retry після 401 — користувач отримує помилку замість файлу через 15 хв простою. Канон: винести `apiBlobFetch(path)` у `lib/api-client.ts` що дублює auth/refresh логіку `apiFetch` але повертає `Blob`. Використовувати ВСЮДИ де PDF/Excel/CSV downloads. Не дублювати inline fetch у компонентах — кожна inline-копія втрачає silent-refresh + redirect-on-logout логіку.
- **`||` має нижчий пріоритет за `?:`, призводить до dead-branch ternary** (Bug #76, invoices.recalcTotals): `const x = a || b ? c : c;` парситься як `(a || b) ? c : c` — обидві гілки `c`, конструкція безглузда. Якщо в код проходить тернарник з ідентичними `true`/`false` гілками — це 99% copy-paste артефакт. Канон: спрощувати негайно. Якщо потрібна реальна умова — писати її явно з parentheses і коментарем.
- **VAT/percent fields потребують `@Max(100)` поряд із `@Min(0)`** (Bug #78, invoices.dto.ts): `@IsNumber() @Min(0) vatRate?: number;` приймає 9999%. Канон: будь-яке поле що означає percent — і `@Min(0) і @Max(100)`. Стосується: `vatRate`, `discountPercent`, `marginPercent`, `loadPercent`, `tax` etc. Grep на `@IsNumber.*percent|vatRate|@Min\(0\)` без `@Max(100)` — це регулярний баг-шаблон.
- **Time math з `% 24` робить тихий wrap до попереднього дня** (Bug #79, calendar normoHours auto-end): `(h*60 + m + normoMin) % (24*60)` для 14:00 + 15h дає 05:00 — на тій же даті — раніше за початок. UX-проблема: фронт показує валідне з вигляду значення, API падає 400. Канон: для time-math у тому ж calendar-day — clamp до `23:59`: `Math.min(totalMin, 23*60 + 59)`. Wrap (`% 24`) — лише коли явно потрібен перехід на наступний день, що для слотів СТО недопустимо.
- **DELETE/cancel endpoint що повертає void → завжди `@HttpCode(HttpStatus.NO_CONTENT)`** (Bug #80, completion-acts cancel): NestJS за замовч. видає 200 + порожнє тіло, але REST-стандарт + UI-очікування — 204. Канон: коли метод повертає `Promise<void>` — додати `@HttpCode(HttpStatus.NO_CONTENT)`. Узгодженість з логаут/`removeSlot`/`removeLine` важлива для frontend (`apiFetch` перевіряє `status === 204` щоб не парсити JSON).

### Gotcha — /sto-review costMethod selector (2026-05-26, commit 18598d7)
- **Frontend enum literal drift from Prisma enum** (settings/page.tsx costMethod selector): Prisma enum `BatchCostMethod = { FIFO, FEFO, LIFO, AVG_COST }`. New UI shipped `[['FIFO', ...], ['LIFO', ...], ['AVERAGE', ...]]` — `AVERAGE` is not in the enum and `FEFO` is missing entirely. Backend `@IsEnum(BatchCostMethod)` returns 400 on any "Середній" pick → user can never change the default. Канон: when an enum is shared across the boundary, declare a literal-union type on the frontend (`type CostMethod = 'FIFO' | 'FEFO' | 'LIFO' | 'AVG_COST'`) and derive the option list from that single source of truth. NEVER let the field be typed `string` in the frontend `interface` — that defeats TS as a safety net for enum drift. Also: every Prisma enum that surfaces in UI needs a contract test that PATCHes each valid value AND asserts an invalid string 400s (regression guard).
- **List/option arrays in JSX should be `const OPTIONS = [...]` at module top, not inline `[as [string,string,string][]]`** — the inline tuple-literal cast hides typos behind verbose syntax. Canonical pattern: `const X_OPTIONS: { value: X; label: string; hint: string }[] = [...]; X_OPTIONS.map(...)`. Also makes the labels accessible to future i18n extraction.
- **Radio-group semantics on segmented buttons**: a vertically/horizontally stacked group of mutually exclusive `<button>`s is functionally a radio group. Wrap in `role="radiogroup"` with `aria-label`, give each option `role="radio"` and `aria-checked={selected}` — otherwise screen readers announce "10 buttons" without conveying mutual exclusivity.

### Gotcha — /sto-tester FULL on warehouse isMain feature (2026-05-26, baгs #69-#73)

- **Service-layer `updateMany; create` для single-flag-per-org НЕ є атомарним** (Bug #69, warehouses.service.ts): паттерн `await tx.warehouse.updateMany({ isMain: false }); await tx.warehouse.create({ isMain: true })` в одній `$transaction` НЕ дає DB-рівневого інваріанту. `updateMany` бере row-locks на EXISTING рядки; `create` додає новий — не конфліктує. Дві паралельні транзакції в `READ COMMITTED` обидві проходять. Результат: 2+ `isMain=true` в одній org. Канон: для будь-якого "тільки одна-Х-на-org/branch/контекст" — **partial unique index** на DB рівні: `CREATE UNIQUE INDEX ... ON tbl (orgId) WHERE flag = true AND deletedAt IS NULL`. Service-guard лишається для UX (миттєвий toggle), але інваріант — у БД. У сервісі обернути `Prisma.P2002` у `ConflictException` з UI-friendly повідомленням. Прийом застосуємо також до: `Counterparty.isPrimaryContact`, `Branch.isHeadquarters` (якщо з'явиться), `PaymentMethodConfig.isDefault` — будь-який "primary/default/main" flag.
- **MECHANIC-доступ до reference endpoints, які потрібні для WO parts** (Bug #70, warehouses.controller.ts): `WorkOrdersController.@Roles('OWNER','ADMIN','RECEPTIONIST','MECHANIC')` на POST /work-orders/:id/parts дозволяє MECHANIC додавати запчастини; модалка "Додати запчастину" викликає `GET /warehouses` для заповнення dropdown; `WarehousesController.findAll` мав `@Roles('OWNER','ADMIN','RECEPTIONIST','STOREKEEPER')` — без MECHANIC. Запит повертає 403, dropdown порожній, MECHANIC не може додати запчастину. Канон: коли роль X отримує WRITE на доменну сутність Y, перевірити що X має READ на ВСІ reference resources які UI використовує у формі для Y. Grep: `apiFetch.*/<resource>` у компонентах де можливі MECHANIC/role-X — porівняти з `@Roles` у відповідних контролерах.
- **`useEffect([])` для one-shot auto-fill не виконається після form reset** (Bug #71, work-orders/[id]/PageClient.tsx): `useEffect(() => { apiFetch('/warehouses').then(d => setPartForm(f => f.warehouseId ? f : {...f, warehouseId: mainW.id})) }, [])` спрацьовує лише раз. Якщо handler-saver обнуляє форму `setPartForm({...empty})`, наступне відкриття модалки покаже порожній dropdown — useEffect не re-fire. Канон: при reset форми зберегти "sticky" defaults: `setPartForm(f => ({ goodId:'', warehouseId: f.warehouseId, quantity:'1', price:'' }))` — explicitly preserve fields що мають "залипати" між послідовними інстансами модалки. Не використовувати `setForm({...empty})` для форм, що auto-fill-яться через mount-only useEffect.
- **Race-patron consistency: `f.x ? f : {...}` має бути ВСЮДИ де auto-select** (Bug #72, work-orders/page.tsx loadVehicles): review-фікс 83921d2 додав цей patron у branchId і warehouseId auto-selects, але пропустив `loadVehicles` (там guard є тільки на reqId staleness — а не на user's manual pick). Канон: при додаванні auto-select feature робити **сplit-screen sweep** — знайти grep-ом всі `setForm(f => ({ ...f, X: result }))` і застосувати один і той же patron `f.X ? f : {...}` синхронно. Pre-existing auto-selects, які приймають patron в окремому commit, ризик регресії.
- **Pre-existing failing tests маскуються у CI-output** (Bug #73, command-palette.test.tsx): тест `показує "Нічого не знайдено"` ламається тиху і безшумно після `feat(phases21-22)` що додав `apiFetch('/search')` debounce у компонент — у jsdom нема fetch, `dataLoading` лишається true, "empty state" не рендериться. 12/13 passed виглядає здорово для людини що дивиться лише на summary, але реально це регресія яка пройшла кілька commit-ів. Канон: будь-який тест що використовує `screen.getByText(...)` після `userEvent.type` має або (a) `vi.mock('@/lib/api-client', ...)` у файлі-тесті щоб контрольовано resolved-ить API виклики, або (b) `findByText` (async) — синхронні assertion-и проти post-debounce UI = flaky timer-залежність. `/sto-tester` тепер ЗАВЖДИ запускає `pnpm --filter @sto/web exec vitest run` у FULL mode і блокує на 0 failures, навіть якщо помилка не у файлах diff.


### Gotcha — /sto-review warehouse auto-select cycle (2026-05-26, commit fix(review): warehouse auto-select)
- **`prisma migrate dev` drops raw-SQL "drift" indexes silently** (migrations/20260526113130_warehouse_is_main): the trgm GIN indexes from `20260526061209_b6_trgm_gin_indexes` are created by hand-written `CREATE INDEX IF NOT EXISTS ...` *outside* schema.prisma. When the next `migrate dev` was generated for the unrelated `Warehouse.isMain` column, Prisma saw 6 indexes present in DB but not in schema → emitted `DROP INDEX` statements at the top of the auto-generated migration. This silently killed B6 fuzzy search (HTTP 200 still, just sequential scans on every search). Канон: every raw-SQL migration MUST be paired with **either** a corresponding schema.prisma directive (`@@index([...], type: Gin, ops: ...)` for trgm if supported) **or** the next auto-generated migration MUST be reviewed line-by-line for unexpected DROPs. The fix re-creates indexes idempotently inside the same migration, and updates the recorded checksum in `_prisma_migrations` so future `migrate dev` does not warn about drift.
- **Stale async response overrides user input** (work-orders/page.tsx loadVehicles): a counterparty change triggers a multi-step fetch (garages → vehicles per garage). If the user switches counterparty before the older fetch resolves, the older `length === 1` branch hijacks `form.vehicleId`. Канон: increment-on-call counter ref + guard at resolution (`if (reqId !== ref.current) return;`). The same pattern applies anywhere `setForm(f => ({ ...f, X: result }))` runs after an `await` whose source can re-fire faster than the network — counterparty/garage/vehicle cascades, dependent selects, search-driven combobox auto-select.
- **Auto-select effects must preserve manual user pick** (stock-documents, purchase-orders, work-orders, WO card part form): pattern `if (single) setForm(f => ({ ...f, x: single.id }))` looks innocent but clobbers a value the user has just typed/picked when the effect re-fires (modal re-opens, deps change, slow fetch resolves after re-mount). Канон: `setForm(f => (f.x ? f : { ...f, x: single.id }))` — only fill empty fields. Apply to every "default selection" code path; do not assume the field is always empty at effect time.
- **`findMany` ordering should reflect "canonical first" semantics** (warehouses.service.ts): adding an `isMain` boolean without bumping the `orderBy` means dropdowns still alphabetize, hiding the main warehouse below others. Канон: when a model gains a "primary/main/default" boolean flag, the default `findMany` order becomes `[{ isMain: 'desc' }, ...originalOrder]` so consumers naturally land on the canonical record.


### Gotcha — /sto-tester FULL pass 2026-05-26 after commit 8ed0a42 (Bug #68)

- **pdfmake v0.3.x server-side: Buffer descriptors crash, ONLY string paths work**: pdfmake's URLResolver does `font.normal.url.toLowerCase()` inside `Printer.resolveUrls`. If you pass a Buffer it reads `buffer.url` → `undefined.toLowerCase()` → `TypeError`. The correct server recipe is `pdfMake.setFonts(require('pdfmake/fonts/Roboto'))` — that module returns `{ Roboto: { normal: '/abs/path/Roboto-Regular.ttf', ... } }` pointing at the ttf files bundled inside `node_modules/pdfmake/fonts/Roboto/`. The legacy v0.1 vfs envelope (`{ pdfMake: { vfs } }`) does NOT exist in v0.3.9 — `pdfmake/build/vfs_fonts` is `module.exports = vfs;` (flat map), and feeding Buffers from that map still hits the URLResolver crash. Never trust an `as { ... }` cast on `require()` results without runtime smoke-testing.
- **Integration tests for any pdfmake-dependent code are mandatory**: tsc cannot validate the shape of `require()` output, and the URLResolver crash only fires on actual `getBuffer()`. The Bug #68 fix added `pdf.service.spec.ts` with three tests that generate real PDF buffers and assert `%PDF` magic — this is the cheapest guard against future regressions in font wiring or pdfmake upgrades.

### Gotcha — /sto-tester follow-up 2026-05-26 (commit fix(tester): Bugs #61-#67)

- **Raw SQL must mirror Prisma column names exactly**: schema field `StockItem.reserved` becomes Postgres column `"reserved"` (camelCase, double-quoted). Search service had `si."reservedQty"` which does not exist → `/search` 500 for every query (Promise.all rejected took down WO and counterparty buckets too). Also added missing `LEFT JOIN ... AND si."orgId" = ...` predicate plus GROUP BY g.id to prevent row multiplication when a good is in N warehouses.
- **`/branches` shape is `Branch[]` (plain array)** — NOT `{ items, total }`. employees/page.tsx assumed pagination envelope, fell back to `[]`, blocked B10 branch assignment. work-orders/page.tsx had the correct typing. Lesson: every contract refactor needs a sweep across ALL consumers, not just the one being edited.
- **NestJS `@Query()` without DTO silently drops params**: `forbidNonWhitelisted` only applies when a class is provided. `EmployeesController.findAll` accepted no DTO, so frontend's q/role/showDeleted were never read — UI filters looked working but did nothing. Pattern fix: every `findAll` that takes filters MUST have a typed `*QueryDto` annotation.
- **PDF endpoints need fetch+Bearer+Blob**, never bare `<a href>`. WO/PageClient had been fixed in the previous pass; invoices/page.tsx was missed and still used `<a href>` PLUS a bogus baseURL (`'http://localhost:3000/api'` fallback didn't match the env var convention used everywhere else).
- **Command palette data results need detail routes**: `r.push('/crm')` for a counterparty result loses the click context. Mapped each type to `{ list, detail?: (id) => string }` so `/crm/${id}` and `/work-orders/${id}` route correctly; goods still hit list (no detail page yet).
- **Tenant defense-in-depth even after findOne()**: `WorkOrderTemplatesService.update/remove` used `where: { id }` only. The preceding `findOne(orgId, id)` mitigated cross-tenant access, but any future refactor that drops findOne would silently leak. Pattern: always `where: { id, orgId }` for update/delete, regardless of preceding guards.
- **Template select that overwrites description**: setting `form.description = tpl.name` was confusing (looked like a noop, the user thought template feature was broken). Prefix with «Створено за шаблоном «...»» until full lines/parts auto-apply is implemented in a follow-up sprint.


### Gotcha — /sto-review Phases 21-22 cycle (2026-05-26, commit fix(review): ...)
- **TDZ у `useEffect` що читає `useRef`/`useState` оголошені нижче** (work-orders/page.tsx): рефакторинг "auto-init my-orders chip" зсунув `myOrdersInitRef = useRef(false)` нижче `useEffect` що його читає → `ReferenceError: Cannot access 'myOrdersInitRef' before initialization` при першому render для всіх ролей. Канон: ВСІ `useRef`/`useState` декларації йдуть ПЕРЕД будь-яким `useEffect`/`useCallback`/`useMemo` що їх читає. Не покладатися на JS hoisting — `let`/`const` не hoisted, виконання падає на стрічці `useEffect(...)`. Той самий ризик при додаванні нових ефектів зверху файлу під час інкрементальних feature builds.
- **F6 "Мої наряди" chip не фільтрує — `employeeId` відсутній у `WorkOrderQueryDto`** (work-orders.dto.ts): фронт надсилає `?employeeId=X` але `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })` повертає HTTP 400 "property employeeId should not exist". Філ не валідується тихо — endpoint крашиться. Канон: будь-який новий query-param фільтр на фронті → парний `@IsOptional() @IsUUID() field?` у DTO + handler у `findAll`. Перевірка: на кожен `apiFetch(\`?${param}\`)` має бути присутнє поле у відповідному `QueryDto`.
- **Polymorphic `entityType` casing mismatch** (comments F8): DTO whitelist `['WorkOrder', 'Counterparty', 'Vehicle', 'Invoice']` (PascalCase), фронт надсилав `'work_order'` (snake_case) → POST `400`, GET повертає `[]` (мовчки 0 матчів). Канон: експортувати `COMMENT_ENTITY_TYPES` константу з DTO і використовувати її у фронті через імпорт. Або принаймні задокументувати канонічну форму поряд із `@IsIn(...)`. Той самий ризик для будь-яких polymorphic discriminator strings — sync, audit, notifications.
- **pdfmake v0.3.x server-side API повністю відрізняється від UMD/browser** (pdf.service.ts): `require('pdfmake/build/pdfmake')` повертає browser bundle БЕЗ `PdfPrinter` класу → endpoint крашиться при першому виклику `new PdfPrinter(fonts)`. Канон для server (Node): `require('pdfmake')` (singleton) → `pdfMake.setFonts({...})` → `pdfMake.createPdf(docDef).getBuffer()` повертає `Promise<Buffer>`. Никогда `pdfmake/build/*` на бекенді.
- **`<a href>` download з JWT-guarded endpoint = HTTP 401** (PageClient.tsx downloadPdf): нативний браузерний download не може прикрутити `Authorization: Bearer` header. Канон: `fetch(url, { headers: { Authorization: \`Bearer \${token}\` } })` → `res.blob()` → `URL.createObjectURL(blob)` → `<a>` click → `setTimeout(revokeObjectURL, 100)`. Та сама проблема для будь-якого download endpoint захищеного `JwtAuthGuard`: PDF, Excel, ZIP, image-with-watermark.
- **`useState(() => localStorage.getItem(...))` lazy initializer крашить SSR + дає hydration mismatch** (useTableColumns.ts): Next.js static-export prerender виконує initializer на сервері де `localStorage` undefined → throw / hydration mismatch (server `defaults` ≠ client `stored`). Канон: ініціалізувати дефолтами, читати localStorage в `useEffect([])` після mount, defensive `typeof window !== 'undefined'` guard на write. Те саме для будь-якого hook що hydrate-ить state з storage: `useSavedFilters`, `useColumnOrder`, `useUserPreferences`.
- **Comment DELETE без author/role check = кожен може стерти будь-який коментар** (comments.service.ts): тільки `findFirst({ id, orgId })` потім `delete()` — будь-який авторизований у `orgId` може видалити comment колеги. Канон: `if (comment.authorId !== user.id && user.role !== 'OWNER' && user.role !== 'ADMIN') throw new ForbiddenException(...)`. Той самий патерн для будь-яких user-generated content: notes, attachments, files, reminders.
- **`Promise.all` + `slice(N)` для багатотипного пошуку дає non-deterministic ordering** (search.service.ts): `results.push(...items)` у `Promise.all` callbacks порядок залежить від latency окремих query → switch goods/wo раз від разу. Канон: `Promise.all(types.map(t => searchByType(t)))` → результат — массив **в порядку types** → `.flat().slice(0, limit)` детермінований.
- **B6 search by company name не покривається** (search.service.ts): початкова версія `similarity(firstName || ' ' || lastName, q)` — B2B клієнти невидимі. Канон: окрема similarity для `companyName` + label у respose має fallback на companyName.

### Gotcha — /sto-tester invoices/page sweep (2026-05-26, баги #58-#60, commit e867ba4)
- **Closure-check + functional-setter race у `handleTransition`** (Bug #58): `if (selectedInv?.id === inv.id) setSelectedInv(prev => ({...prev, status: newStatus}))` змішує JS-closure value (для перевірки `if`) і live React state (`prev` у setter). Якщо панель перемикається на іншу invoice між кліком і відповіддю API — newStatus застосовується до НОВОЇ invoice. Канон: ВСЯ перевірка має бути всередині функціонального setter — `setSelectedInv(prev => prev && prev.id === inv.id ? {...prev, status: newStatus} : prev)`. Той самий патерн потрібен скрізь де `if (selectedX) setSelectedX(prev => ...)` після `await` — детальні панелі, відкриті модалки, токенізовані selection.
- **Server-side side-effects не віддзеркалюються в selectedDetail** (Bug #59): `POST /payments` тригерить `invoice.status = 'PAID'` (PaymentsService:101), але клієнтський `handlePay` оновлює лише список через `load()` — DetailPanel показує застарілий SENT з активною кнопкою «Оплатити», що 400. Канон: після кожної мутації, що змінює статус через side-effect — оновити локально через functional setter ДО `load()`: `setSelectedInv(prev => prev && prev.id === id ? {...prev, status: 'PAID'} : prev)`. Шаблон: detail-panel-state-after-mutation = (mutate) → (sync local visible) → (refetch list).
- **VAT/totals defaults у Prisma = 0 рендеряться як «реальні» нулі** (Bug #60): `totalWithVat?: number` з API завжди present (default 0) для рахунків створених вручну без InvoiceLines. Перевірка `totalWithVat != null` truthy для 0 → секція «Підсумок» показує «Без ПДВ: 0,00 ₴ / ПДВ: 0,00 ₴ / З ПДВ: 0,00 ₴» поряд із `amount=1000 ₴`. Канон: для полів-сум з Prisma default 0 використовувати `(field ?? 0) > 0` як guard на рендер, не `!= null`. Те саме для будь-яких aggregated Decimal колонок: `totalAmount`, `totalLabor`, `totalParts`, `totalCost` — `> 0` фільтрує і undefined, і нулі.

### Gotcha — /sto-tester Phase 20 UX Groups 4-6 sweep (2026-05-26, баги #53-#57, commit 18f1d48)
- **`useBulkSelect` без pruning при зміні items → stale Set across pages** (Bug #53): Set обраних ID зберігається при пагінації/фільтрації/refetch, що дає невидимі вибори у count + хибний allSelected/someSelected + bulk actions проти невидимих ID. Канон: `useEffect(() => { setSelected(prev => prev ∩ visibleIds) }, [items])` з early-return `prev.size === 0`, щоб не тригерити re-render для порожньої виборки. Цей патерн обов'язковий для будь-якого хука що тримає `Set<string>` IDs прив'язаних до зовнішнього масиву.
- **`Promise.all` для bulk-операцій → fail-fast псує UX** (Bug #54): один FSM-invalid перехід (ARCHIVE з не-PAID, CANCEL з ARCHIVED/CANCELLED) реджектить ВЕСЬ батч; success-toast і `bulkSelect.clear()` не викликаються, але частина WO вже трансформувалась — UI неконсистентний. Канон: `Promise.allSettled` + рахунок fulfilled/rejected + ЗАВЖДИ викликати `clear()` і `load()` у `finally`-логіці + агрегований toast вигляду "Скасовано 3 з 5. 2 не змінено". Те саме для `bulkArchive`, `bulkRemove`, `bulkRestore`, `bulkExport` — будь-яка масова мутація.
- **Bulk-actions UI що не враховує FSM → завжди фейлить для частини selection** (Bug #55): `ARCHIVE` дозволено тільки з `PAID` (per `WORK_ORDER_TRANSITIONS`); інші 9 статусів повертатимуть 400. Аналогічно `CANCEL` з `IN_PROGRESS/COMPLETED/INVOICED/PAID/ARCHIVED/CANCELLED` неможливий. Мінімальний фікс — `Promise.allSettled` гасить регресію (#54). Якісне виправлення — disable / count-down кнопки на основі реальної кількості сумісних із FSM. TODO у follow-up: показувати "Архівувати (2 з 5)" або фільтрувати selection до compatible IDs перед mutation.
- **`onKeyDown` на `role="button"` рядку без `target !== currentTarget` guard → подвійне спрацювання** (Bug #56): Space на вкладеній `<button>` (наприклад X delete) нативно клікає кнопку АЛЕ keydown bubble-up до батьківського div з `onKeyDown` → друга дія (markRead) на щойно видаленому ID. Канон: `onKeyDown={e => { if (e.target !== e.currentTarget) return; ... }}` для всіх клавіатурних handler-ів на елементах-обгортках з інтерактивними нащадками.
- **Component coverage для Phase X нових компонентів — частина того ж sweep** (Bug #57): нові UI компоненти не отримують тестів автоматично в первинному PR — sto-review зосереджується на коді, не на test gaps. Канон: `/sto-tester` після кожного фічевого commit має grep-ом за `git diff --name-only HEAD~5..HEAD | grep components/ui` знайти нові файли і перевірити наявність `__tests__/<name>.test.tsx`; якщо відсутні — додати як LOW bug. Мін. coverage: рендер всіх variant пропс, всі callbacks (toggle/clear/onClick), edge cases (count=0, items=[], unread=12).

### Gotcha — /sto-review Group 4-6 cycle 1 (2026-05-26, commit f947021)
- **`opacity-0 hover:opacity-100` на тому ж елементі = unreachable** (notification-center per-row delete X): кнопка `opacity-0` має ефективну площу 0px, тож курсор не може приземлитись щоб `hover:` спрацював. Канон: показувати on-hover дочірнього елементу — додавати `group` на батьківську карточку, на дочірньому `opacity-0 group-hover:opacity-100`. Завжди дублювати `focus:opacity-100` щоб клавіатурні користувачі через Tab могли побачити кнопку.
- **`React.ReactNode` без `import React`** — tsc може мовчки пройти через next-env.d.ts глобали, але VSCode Next.js TS plugin суворіший і блимає червоним; також згідно sto-dev §1 — заборонено. Канон: `import type { ReactNode } from 'react'` + використовувати голий `ReactNode`. Той самий патерн для всіх React.X типів (`HTMLAttributes`, `ChangeEvent`, `SVGAttributes`).
- **HTMLInputElement.indeterminate через ref callback** — працює (інлайн arrow має нову identity на кожен render → React викликає cleanup + re-attach), але це implicit поведінка React 19 і легко зламати при додаванні React Compiler / memo. Канон: `const ref = useRef<HTMLInputElement>(null); useEffect(() => { if (ref.current) ref.current.indeterminate = X; }, [X]);` — explicit і future-proof.
- **`useMemo` для inline literal arrays що передаються у дочірні компоненти** — `const actions = [{ ... }]` створюється новою референцією на кожен рендер. Якщо дочка робить `useEffect` / `useMemo` з `actions` у deps — тригерить зайве. Канон: `useMemo(() => [...], [deps])` коли елементи містять `useCallback`-references.
- **Dead useEffect listener** — `addEventListener('event', () => {})` з no-op handler. Виглядає невинно, але алокує DOM-listener на кожен mount + плутає reviewer (намір незрозумілий). Канон: видаляти повністю якщо handler нічого не робить; якщо event used elsewhere — додати TODO коментар з реальним handler-кодом.

### Gotcha — Group 3 tester sweep (2026-05-26, баги #47-#52)
- **class-validator messages — повинні бути локалізовані глобальним `exceptionFactory`** (Bug #47): без нього кожне `@IsUUID`/`@IsISO8601`/`@IsEnum` повертає англійський текст у toast користувача, що порушує "UI українською" правило CLAUDE.md §16. Канон: створити `apps/api/src/common/pipes/validation-error.factory.ts` з мапою constraint-keys → укр. шаблонів і підключити у `main.ts:ValidationPipe({ exceptionFactory })`. Особливо помітно у inline-edit flows, де помилки валідації виходять прямо в toast.
- **`async commitEdit` що re-throws — call-сайти повинні мовчки ловити reject** (Bug #48): pattern де hook re-throws для збереження edit state на retry, але показ toast вже у `onSave`. Якщо `<select onChange={e => hook.commitEdit(e.target.value)}>` без `.catch` → unhandled Promise rejection у консолі + Next.js dev error overlay. Канон: `onChange={e => { void hook.commitEdit(e.target.value).catch(() => {}); }}`. Те саме для `onCommit`/`onSubmit`/`onBlur`-обгорток async re-throw API.
- **`<input type="text">` для дат — приховує помилку до server round-trip** (Bug #49): user типує "25/05/2026", "tomorrow", "abc" — все проходить frontend, бекенд кидає 400. Канон: для дат використовувати `<input type="date">` (native picker, YYYY-MM-DD enforced). Для inline-edit компонентів — приймати union `'text' | 'number' | 'date' | 'datetime-local'`. Додатково: `inputRef.current?.select()` кидає `InvalidStateError` для date/datetime-local → обгортати у try/catch.
- **`role="button"` БЕЗ `aria-label` коли children — Badge/icon** (Bug #50): `title` атрибут НЕ озвучується надійно у NVDA/JAWS. Якщо інтерактивний span має тільки візуальний контент (іконка, бейдж без текстового імені), screen reader прочитає "клацабельний елемент" без контексту. Канон: завжди передавати `aria-label={\`Редагувати: \${value}\`}` (або еквівалент дії). Не покладатися на `title` для accessibility.
- **localStorage corruption defense — Array.isArray на parsed payload** (Bug #51): `JSON.parse` повертає що завгодно (null, число, об'єкт). Якщо інший таб / devtools / стара версія додатку вставили `localStorage.setItem('sto_filters_x', '{}')` → наступний `.map()` у компоненті крашить error boundary. Канон: `Array.isArray(parsed) ? parsed : []`. Той самий захист для `boolean`/`number`/`string` cache — type guard перед використанням.
- **Component coverage для нових UI примітивів — обов'язково в межах PR**: будь-який новий компонент у `apps/web/src/components/ui/` ПОВИНЕН мати `__tests__/xxx.test.tsx` у тому ж commit (Bug #52). Hook у `apps/web/src/hooks/` — поряд `xxx.test.tsx`. Min coverage: рендер з усіма пропс-комбінаціями, кожен callback (onClick/onChange/onCommit/onCancel), keyboard навігація (Enter/Escape/Space), aria-attributes, edge cases (порожній стан, disabled, error). vitest config вже сканує `src/**/*.test.{ts,tsx}` — додавати тести в той самий PR що додає компонент.

### Gotcha — Command Palette tester sweep (2026-05-25, баги #42-#46)
- **Backdrop-click через `e.target === e.currentTarget`** — анти-патерн коли backdrop є дочірнім `absolute inset-0` сібінгом панелі: backdrop ВІЗУАЛЬНО покриває outer flex container, тож клік завжди приземляється на backdrop, а не на outer div → onClose ніколи не викликається. Канон: вішати `onMouseDown` НА САМ backdrop (`<div className="absolute inset-0 ..." onMouseDown={onClose} aria-hidden="true" />`), а не на outer dialog wrapper (Bug #42).
- **`onMouseEnter` vs `onMouseMove` у списках з клавіатурною навігацією**: `onMouseEnter` спрацьовує коли список зсувається ПІД нерухомий курсор (після фільтру/перебудови) → активний індекс стрибає, перебиваючи стрілки. Канон: `onMouseMove` (потребує реального руху курсора) + дешева guard `if (activeIndex !== idx) setActiveIndex(idx)` (Bug #43).
- **O(N²) flatList.indexOf у рендері** — для будь-якого list-у з груповим рендером, де треба знайти індекс у плоскому списку. Канон: `useMemo` побудувати `Map<Item, number>` один раз, в map-і груп брати `map.get(item)` за O(1) (Bug #44).
- **Combobox/Listbox ARIA pattern для command palette / autocomplete**: input має `role="combobox"`, `aria-controls={listboxId}`, `aria-activedescendant={activeOptionId}`, `aria-autocomplete="list"`. Контейнер результатів — `role="listbox"` + id. Кожен option — `role="option"`, `aria-selected={isActive}`, унікальний `id` (через `useId`, НЕ `Math.random` — non-deterministic + hydration risk). Без цього screen reader не оголошує зміну активного пункту під час ArrowDown/Up у текстовому полі (Bug #45).
- **Restore focus pattern для modal dialog**: WAI-ARIA вимагає повертати фокус на елемент-тригер після закриття. Канон: `previousFocusRef = useRef(null)`; у `useEffect` при `open=true` зберегти `document.activeElement`; при `open=false` — `setTimeout(() => previousFocusRef.current?.focus(), 0)` (defer один tick щоб модалка встигла unmount-нутись) (Bug #46).
- **jsdom не має `Element.prototype.scrollIntoView`** — компоненти що скролять активний елемент у видимість (palette, select, list virtualizer) крашать тести з `TypeError`. Канон: глобальний стуб у `apps/web/src/__tests__/setup.ts`: `Element.prototype.scrollIntoView = function () {}`.

### Gotcha — /sto-review Command Palette (2026-05-25, commit aed69c3)
- **Shift+/ vs '?'**: на US-розкладці `e.key` для Shift+/ → `'?'`, НЕ `'/'`. Hook що порівнює `e.key.toLowerCase() === mainKey` де `mainKey='/'` тихо не спрацьовує — ярлик `'?'` "є", але ніколи не фаєриться. Канон у `useKeyboardShortcut`: таблиця `SHIFT_ALIAS` (`'?':'/'`, `'!':'1'`, ...) + layout-independent fallback на `e.code` (`'Slash'`, `'KeyA'`, `'Digit1'`). Перевірити власноруч: Shift+/ показує help toast.
- **Modal + global shortcuts**: коли відкритий модальник з власним `window.addEventListener('keydown')`, БЕЗ `{ capture: true }` глобальні Alt+W/D/C/I/N все одно фаєряться у фоні (router.push під модалкою — UI лишається відкритим зі stale state). Канон: модальник реєструє listener з `{ capture: true }` + `e.stopPropagation()` на Escape; додатково — disable глобальних шорткатів через `enabled: !modalOpen` у parent.
- **useEffect deps з ре-обчислюваними масивами**: якщо у dep array є `flatList`/`filtered`/`groups`, що створюються через `.reduce`/`.map` у тілі компонента — listener видаляється/додається на КОЖНОМУ рендері. Канон: `useMemo` для всіх похідних колекцій + `useRef` для значень, які listener читає під час події (не пере-підписувати listener на кожному кадрі). Особливо болить для `addEventListener('keydown')` бо setState→render→re-subscribe створює гонку.
- **setTimeout у useEffect завжди має cleanup**: `setTimeout(() => ref.current?.focus(), 50)` без `clearTimeout` ламається коли `open` фліпає швидко. Канон: `const id = window.setTimeout(...); return () => window.clearTimeout(id);` навіть якщо інтервал малий.
- **Modal a11y baseline**: `role="dialog"` + `aria-modal="true"` + `aria-labelledby={titleId}` (sr-only `<h2>`) + `aria-hidden="true"` на декоративні іконки + Tab focus trap (preventDefault + .focus() назад на єдиний focusable). Без цього screen reader читає модалку як body content.

### Gotcha — Phase 19.2 tester sweep (2026-05-25, бaги #37-#41)
- **Module-level cache vs auth lifecycle** (Bug #37): React-хуки з модульно-глобальним `cache` (типу `useUiFeatures`) повинні очищатись при logout. Інакше на shared kiosk наступний користувач бачить кешовані flag-и попереднього орг. Канон: dispatch `sto:logout` Event у `AuthProvider.logout()` + кожен per-tenant cache hook слухає його і робить `invalidate() + setFeatures(DEFAULTS)`. Те саме треба робити для будь-яких client-side кешів (savedFilters, notifications counter, etc.).
- **JSON column whitelist** (Bug #38): Prisma JSON колонки + `@IsObject()` DTO = безмежний DoS-вектор. Канон: завжди ДВІ окремі функції — `parseFromDb()` (повертає повний об'єкт з defaults, чистить legacy junk) і `pickAllowedKeys(dto)` (повертає Partial лише з whitelisted keys + правильним type guard на value). Merge у service: `{ ...currentFromDb, ...pickedFromDto }`. **НЕ дзеркали defaults у pick — затре поля які користувач не змінював.**
- **Feature flag без consumer = dead code** (Bug #39): Якщо вводиш у `OrganisationSettings.uiFeatures` новий toggle (`unsavedGuardEnabled`), MUST у тому ж commit / phase підключити hook-консьюмер хоча б до одного реального компонента (мінімум до WorkOrder modal). Інакше toggle обіцяє функціонал, який не реалізовано. Канон: grep на `uiFeatures.<keyName>Enabled` повинен повертати ≥1 use site не у тестах/settings UI.
- **Симетричні useEffect cleanup-и** (Bug #40): Якщо в одному useEffect ввели `let cancelled = false` + check у `.then()`, ОБОВ'ЯЗКОВО додати такий guard і у всі сусідні useEffect-и (event handlers, post-event refetch). Patterns тримати ідентичними у межах файлу.
- **Settings module specs** (Bug #41): Кожен новий controller + DTO у `apps/api/src/modules/*` повинен супроводжуватись хоча б `*.contract.spec.ts`. Без нього: (a) контрактні зміни не помічаються, (b) authz регресії тихі, (c) `forbidNonWhitelisted: true` поведінка не верифікована. Settings контракт-тести використовують fresh Postgres row state per-beforeEach + redisMock без real Redis.

### Gotcha — /sto-review cycle 81534e0 (2026-05-25, Phase 19.2)
- **Role-gated GET endpoint, що споживає всі ролі** — критичний анти-патерн. `useUiFeatures` хук викликається на `/work-orders/[id]` (доступна RECEPTIONIST/MECHANIC/ACCOUNTANT), але `/settings/organisation` має `@Roles('OWNER', 'ADMIN')`. Кожна навігація = 403 в network logs. Канон: для UI-feature-flags / branding / theme — окремий endpoint `/settings/ui-features` з `@Roles` для ВСІХ авторизованих ролей. Те саме стосується будь-яких "загально-читальних" даних, що mount-у завантажуються глобальними хуками.
- **Module-level fetch cache MUST cache failures too** — інакше після першого 403/network-fail кожен mount компонента повторно стрілятиме у backend. Канон: на `.catch` зберігати DEFAULTS у `cache` з коротким TTL (наприклад, 60 сек), щоб recovery після зміни ролі/відновлення мережі залишився можливим.

### Gotcha — /sto-web review + tester cycle 7 (2026-05-25)
- **setup/page.tsx** — публічна сторінка не повинна імпортувати axios-клієнт із auth-interceptors; вона використовує `apiFetch` напряму (без Bearer). Для public endpoints `/setup/*` `apiFetch` правильний вибір (Bug #37-part).
- **mountedRef охоплення**: review cycle 3 підтвердив — після введення `mountedRef` в один файл треба відразу сканувати ВСІХ сусідів що завантажують дані при mount. Решта без guards: `work-orders/page.tsx`, `vehicles/[id]`, `employees/page.tsx`, `catalog/page.tsx` — заплановані на наступний цикл.
- **LowStockItem ≠ StockItem**: `/stock-items/low` повертає агрегований SQL-результат без `id/reserved/available/salePrice`. Завжди мати окремий тип для кожного endpoint (Bug #37-frontend).
- **vitest.config.ts для web**: без нього `pnpm --filter @sto/web test` не підхоплює `src/**/*.test.tsx` — 42 component тести мовчки пропускалися. Виправлено створенням конфігу.

### Gotcha — Phase 19 tester cycle 6 findings (2026-05-25)
- **DTO enum-валідація для FK полів-енумів**: Якщо BD стовпець — `enum` (Postgres ENUM), а DTO приймає `@IsString()`, runtime каст `value as Enum` у Prisma where ламається з `invalid input value for enum`. Канон: завжди `@IsEnum(EnumType)` + типізація `field?: EnumType` у DTO (Bug #33: `PricingRule.goodType`).
- **Relation soft-delete фільтри**: `findStockItems` фільтрував лише `StockItem.deletedAt`, але не `good.deletedAt`/`warehouse.deletedAt`. Узгоджуй з `findLowStockItems` raw SQL (там `g.deletedAt IS NULL`/`w.deletedAt IS NULL`). Канон: будь-який list endpoint з `include` повинен мати `deletedAt: null` фільтр у relation-where (Bug #34).
- **PATCH normalize з merge існуючого стану**: `normalizeScope(dto)` без merge існуючого — НЕ зачіпає поля, які клієнт не передав. PATCH `{ goodCategory: 'X' }` при існуючому `goodId` залишає suite goodId+goodCategory. Канон: `const merged = { ...dto, ...mergedScope }`, потім `normalizeScope(merged)` + explicit `null` для пониззених scope-полів у `UncheckedUpdateInput` (Bug #35).
- **TS interface для API response — не "вільне поле"**: `apiFetch<WrongType[]>` проходить TS, але приховує невідповідність контракту. Завжди писати окремий `interface FooDto { ... }` для кожної API-відповіді, навіть якщо runtime використовує лише `.length` (Bug #36).

### Gotcha — Phase 19 review cycle 4 findings (2026-05-25)
- mountedRef guard pattern: коли вводиш `mountedRef.current` для одного async handler (`load`), застосовуй ТОЙ САМИЙ guard до УСІХ інших async setState handlers у тому ж компоненті (`deleteRule`, `applyAll`, `updateRule`). Інакше навігація під час in-flight операції викличе setState на unmounted (Bug #30 був неповним).
- StockBatch — append-only без `deletedAt` (як StockMovement, SettlementTransaction). Додано до §5 виключень у SKILL.md.

### Gotcha — Phase 19 tester cycle 5 findings (2026-05-25)
- DTO `@Max(N)` ліміти на pagination-параметрах — звіряти на ВСІХ сторінках frontend. Сторінка може використовувати `limit=N+M`, ValidationPipe відкине запит з 400, а soft error-handling (`console.warn` замість throw) сховає проблему від QA. Канон: усі сторінки використовують один і той самий `limit=200` (Bug #32 = пост-фікс Bug #29 розкрив дефект, який жив з самого Phase 19).
- Soft error-handling після fetch — палиця з двома кінцями: захищає UX від rare API-failure, але приховує детермінований bug у параметрах запиту. При додаванні `console.warn`-fallback одразу перевіряти, чи запит сам по собі валідний (curl + ValidationPipe rules).

### Gotcha — Phase 19 tester cycle 4 findings (2026-05-25)
- Hard `BadRequestException` на відсутньому `RECEIPT.price` блокує StockDocument TRANSFER/RECEIPT, бо `StockDocumentLine.price` — `Decimal?`. Канон: fallback на `good.purchasePrice ?? 0`, guard лише на `NaN`. Не повторювати "захист" що ламає сусідній модуль (Bug #26 = регресія від Bug #15).
- При додаванні валідаторів у CreateDTO — **завжди дзеркалити** в UpdateDTO. PATCH без `@Min(0)`/`@Max(N)` зводить нанівець бізнес-інваріант (Bug #27: PATCH `percentValue: -50` → ціна вдвічі менша за собівартість).
- Sub-resource list endpoints (`/goods/:id/batches`, `/goods/:id/price-history`) повинні: (a) перевіряти існування parent у org → 404, (b) повертати `{ items, total }` shape. Bare array + порожній 200 ховає неіснуючий goodId.
- `.catch(() => {})` на fetch у `useEffect` — анти-патерн. Мінімум `console.warn`, щоб QA міг засікти API-failure. Не блокуй UI, але не мовчи.
- `useEffect` для initial-fetch ТА `useCallback load` для refetch після CRUD — дублікація. Один `load` з `mountedRef.current` guard; `useEffect(() => { setLoading(true); load(); }, [load])` для initial.



### Gotcha — Phase 19 cycle 3 review findings (2026-05-25)
- `new Date()` всередині IIFE `(() => { const now = new Date(); return list.map(...)})()` у render — все одно виконується на SSR pass (для 'use client' компонентів, які Next.js 15 pre-renders). Канонічний фікс: `const [nowMs, setNowMs] = useState(0); useEffect(() => setNowMs(Date.now()), []);` + guard `nowMs > 0` у render. Той самий патерн що у `work-orders/page.tsx`.
- `React.ChangeEvent<HTMLInputElement>` без `import type { ChangeEvent } from 'react'` — VSCode TS plugin падає з `Cannot find namespace 'React'`. Завжди іменовані імпорти типів подій з 'react', НЕ `React.*`.
- `@Query('xxxId') id: string` для UUID параметрів — обгорнути `ParseUUIDPipe()`. Без нього невалідний UUID → Prisma P2023 → HTTP 500. Не вказуй `version: '4'` явно (тести часто кидають UUIDs з версією 0 → 400).


### Gotcha — Phase 19 tester findings (2026-05-25)
- `BatchService.createFromReceipt`: при безкоштовному прийомі (`costPrice=0`) — НЕ перезаписувати `Good.salePrice` нулем; партія створюється з `salePrice = Good.salePrice` поточним. Пайтерн: `salePrice = (costPrice > 0 && computed > 0) ? computed : currentSalePrice`.
- `InventoryService.createMovement(RECEIPT, qty>0)` обов'язково має `price` (можна 0). Без price — кидати `BadRequestException`. Інакше quantity++ без батча, далі consumeBatch ламається в FIFO/LIFO/FEFO режимах.
- `getAvgCost(orgId, goodId, warehouseId?)` — третій параметр опціональний. Передавати `undefined` (не `''`) коли потрібна агрегація по всіх складах. Контролер: `getAvgCost(orgId, goodId, warehouseId)` — НЕ `warehouseId ?? ''`.
- `consumeBatch`/`returnToBatch` без `tx` — обертати у `prisma.$transaction(innerTx => self(...innerTx))` рекурсивно, щоб update + log було атомарним.
- `calculateSalePrice` + `findAll PricingRules` — фільтрувати правила, прив'язані до soft-deleted Good: `OR: [{ goodId: null }, { goodId, good: { deletedAt: null } }]`.
- `findAll` для нових list endpoints — завжди `{ items, total, page, limit }` (навіть якщо без реальної пагінації). Майбутні консумери очікують paginated shape.
- `as never` в `where` clause Prisma — анти-патерн. Використовуй явний enum: `goodType: x as GoodType`. Інакше runtime P2009 не вловиться TS.
- Scope-поля в pricing rules взаємовиключні: `goodId` > `goodCategory` > `goodType`. Backend нормалізує (`normalizeScope`), щоб менеджер не зберігав суперечливі дані.
- Value-поля для type обнуляти при PATCH: `PERCENT` зберігає лише `percentValue`, `FIXED_AMOUNT` — `fixedAmount`, `FIXED_PRICE` — `fixedPrice`. Backend `cleanValuesForType()` + frontend `buildPayload()`.
- `margin(sale, cost)` у фронті — захист від `sale=0`: `if (!sale || !cost) return null`. Інакше `NaN%` в UI.

### Gotcha — Phase 19 cycle 2 review findings (2026-05-25)
- `PATCH /pricing-rules/:id` має валідувати `dto.goodId` (cross-tenant attack): POST вже валідує, але UPDATE може змінити goodId на чужий orgId. Якщо updateDTO дозволяє змінити FK поле — перевіряти приналежність до orgId.
- Нова Prisma модель з `syncVersion` → додавати `@@index([orgId, syncVersion])` — без нього sync pull робить full-table scan на `where: { orgId, syncVersion: { gt: since } }`. Перевір кожну нову sync-ready таблицю.
- Icon-only `<Button>` з `title="..."` — потребує також `aria-label` (title HTML attr не завжди читається screen readers як accessible name). Icon-svg всередині → `aria-hidden="true"`.

### Gotcha — Phase 19 batch/pricing review findings (2026-05-25)
- `BatchesController.lookup` потребує `@Roles(...)` явно — без декоратора RolesGuard пропускає будь-кого авторизованого. Завжди додавати roles навіть на read-only endpoints де є cost/price дані.
- `applyRuleToGoods`-стиль операції: prefetch усіх rules один раз, обчислення в пам'яті, batch-update через `$transaction` чанками по 100. Не викликати `calculateSalePrice` в loop (внутрішнє findMany → N+1).
- Нові sync-ready моделі (з `syncVersion`) додавати в `PULL_TABLES` в sync.service.ts. Append-only логи (без syncVersion) — пропускати.
- Custom inline modals (поза `<Modal>` компонентом) — додавати `role="dialog"`, `aria-modal="true"`, `aria-labelledby` + клік на backdrop із `e.stopPropagation()` на body.

### Gotcha — Inline HSL не адаптується в dark mode (Bugs #1-#5)
`text-[hsl(0_84%_42%)]` працює в light mode але **не змінюється** коли `.dark { --color-destructive-text: hsl(0 84% 72%) }` спрацьовує. Завжди використовуй token-класи (`text-destructive-text`, `border-destructive-border`, `text-success-text`, `text-warning-text`, `text-info-text`) — вони підставляють CSS-змінну і автоматично перемикаються в dark mode.

**grep для виявлення регресій:**
```bash
grep -rnE "text-\[hsl\(|border-\[hsl\(|bg-\[hsl\(|ring-\[hsl\(" apps/web/src/app apps/web/src/components --include="*.tsx"
```
Допустимі винятки: purple badge variant (немає purple токена), inventory reserved orange `25_95%_53%`, button destructive hover `0_84%_52%`, input/select destructive focus ring `0_86%_93%`.

### Gotcha — Tailwind 4 arbitrary value must be fully closed (попередній цикл)
`focus:ring-[hsl(0_86%_93%)` (без `]`) **компілюється тихо**, але клас не з'являється в CSS бо JIT не парсить незакриту dynamic-value. Подвійно перевіряй парні `[...]` в усіх `*-[...]` класах при ручному кодуванні. /sto-review має grep на незакриті дужки.

### Gotcha — Blob URL revoke must defer past click()
`URL.revokeObjectURL(url)` викликаний **синхронно** після `a.click()` зриває завантаження в Chromium (іноді). Завжди `setTimeout(() => URL.revokeObjectURL(url), 100)`. Патерн уже застосований у reports/page.tsx — використовуй як еталон.

### Gotcha — useState(() => localStorage.getItem(...)) теж hydration mismatch (review 2026-05-25)
Lazy initializer з `localStorage` має ТУ Ж проблему що `useState(new Date())`: SSR повертає `[]`, клієнт відразу читає збережене → перший рендер клієнта НЕ збігається з server HTML → hydration mismatch warning + DOM patch. Канон: `useState(initialEmpty)` + `useEffect(() => setX(read()), [])`. Виявлено у `useSavedFilters.ts` після початкового feat-комміту.

### Gotcha — Inline edit Check/X button onMouseDown без onClick = no keyboard (review 2026-05-25)
`onMouseDown={e => { e.preventDefault(); commit(); }}` тримає фокус на інпуті (mouse path), але keyboard користувач, який tab'ом дійшов до Check кнопки, активує її через `Enter`/`Space` що генерує `click`, а не `mousedown`. Без `onClick` кнопка мертва для клавіатури. Канон: `onMouseDown` (mouse) + `onClick` (keyboard) — обидва. `useInlineEdit.savingRef` запобігає double-commit.

### Gotcha — Controlled select `value={editing.value}` зриває візуальний вибір при inline-edit (review 2026-05-25)
Якщо select має `value={editing.value}` де `editing.value` НЕ оновлюється при `onChange` (бо ми коммітимо одразу), React насильно повертає select до старого значення під час in-flight save → користувач бачить як його вибір "відскакує". Канон: для inline-edit select використовуй `defaultValue` (uncontrolled) + `onChange` -> `commitEdit(e.target.value)` + `disabled={saving}`.

### Gotcha — Prisma update з `dueDate ? new Date(dto.dueDate) : undefined` не дозволяє очистити поле (review 2026-05-25)
Прийнятий шаблон у багатьох сервісах: `field: dto.field ? transform(dto.field) : undefined`. Це робить поле **не очищуваним**: і коли DTO не передає поле (undefined), і коли передає `null` — Prisma отримує `undefined` і ПРОПУСКАЄ оновлення. Inline-edit з кнопкою "очистити" не працює. Канон у Update методах для nullable полів: `field: dto.field === undefined ? undefined : dto.field === null ? null : transform(dto.field)`. DTO має бути типу `string | null`, з `@IsOptional() @IsISO8601()` (валідація скіпається на null).

### Gotcha — onSave handler без try/catch ховає помилки від користувача (review 2026-05-25)
Хук `useInlineEdit` ловить помилку з `onSave` тільки щоб скинути `savingRef`, але НЕ показує її. Якщо викликаюча сторона теж не loger'ує — користувач бачить що нічого не сталося (без toast про помилку, без `error` state). Канон: `onSave: async (...) => { try { await apiFetch(...); toast.success(...); load(); } catch (e) { toast.error(msg); throw e; } }` — throw зберігає editing state для повторного спробування.

---

## Поточний стан проєкту

| Параметр | Значення |
|---|---|
| Фаза | **Фаза 17 — Enums, enriched models, MaintenanceSchedule + CompletionAct** (завершено + QA) |
| Прогрес | 17.1-17.3✅ backend + frontend + QA review |
| TypeScript | ✅ 0 errors (web + api + shared) — verified 2026-05-25 cycle 5 |
| Unit тести | ✅ 111/111 passed (включно з contract і property у 12 файлах) |
| Contract тести | ✅ 32/32 passed (auth: 9, work-orders: 6, pricing-rules: 13, batches: 4) |
| Property-based | ✅ 26/26 passed (fsm: 11, inventory: 7, settlements: 8) |
| Component тести | ✅ 42/42 passed (button: 12, select: 9, modal: 11, empty-state: 10) |
| E2E тести | ✅ 16/16 Playwright passed (smoke: 4, inventory: 5, api-errors: 8 — minus 1 dedup) |
| Build | ✅ API build OK (webpack 9.3s) |
| Dev сервер | Next.js на `http://localhost:3001`, API на `http://localhost:3000` |
| CSS | Tailwind 4 через `@tailwindcss/postcss` (postcss.config.mjs) |

### Test coverage closed this cycle (Bugs #10-#13)
- **Bug #10** — добавлено supertest + 15 contract тестів (auth + work-orders) використовуючи Fastify `app.inject()`
- **Bug #11** — встановлено fast-check@4 + 26 property-based тестів (FSM, inventory, settlements). Грошові суми зберігаються в integer cents щоб уникнути 32-bit float обмежень fast-check.
- **Bug #12** — встановлено @testing-library/react + @vitejs/plugin-react@4 (v6 несумісний з vitest 2.1 через Vite 6). Vitest config в `vitest.config.mts` (ESM). 42 component тести.
- **Bug #13** — додано `api-errors.spec.ts` + `inventory.spec.ts` (13 E2E тестів, error resilience + auth guard).

### Gotcha — @vitejs/plugin-react version pinning
- vitest@2.1 (uses Vite 5) **несумісний** з @vitejs/plugin-react@6 (requires Vite 6) — кидає `ERR_PACKAGE_PATH_NOT_EXPORTED` для `vite/internal`
- Рішення: pin @vitejs/plugin-react@^4.3.0
- Config file має бути `.mts` (не `.ts`) щоб подружитися з ESM-only плагіном

### Gotcha — fast-check float constraints
- `fc.float({ min: 0.01, max: 100_000 })` кидає "constraints.min must be a 32-bit float"
- Для грошових сум використовуй `fc.integer({ min: 1, max: 10_000_000 })` (центи)
- Це додатково усуває помилки округлення IEEE 754 у тестах

### Critical bugs fixed this session
- **Bug #7** — `DocumentNumberService.next()` використовував snake_case у raw SQL → ламав створення WO/Invoice/PO/StockDocument. Виправлено: camelCase з лапками + `LIMIT 1`.
- **Bug #8** — `InventoryService.findLowStockItems()` використовував snake_case → `GET /stock-items/low` 500. Виправлено: camelCase з лапками.

### Gotcha — Canonical Tailwind tokens for semantic colors (Phase 17)
`globals.css` defines `-text` and `-border` variants for all semantic colors for use on subtle backgrounds:
- `text-destructive-text` / `border-destructive-border` — dark red on `bg-destructive-subtle`
- `text-success-text` / `border-success-border` — dark green on `bg-success-subtle`
- `text-warning-text` / `border-warning-border` — dark amber on `bg-warning-subtle`
- `text-info-text` / `border-info-border` — dark teal on `bg-info-subtle`
Never use raw `text-[hsl(0_84%_42%)]` etc. — use the token. `badge.tsx` already updated.

### Gotcha — Recharts inline styles must use CSS var() not hsl()
Recharts `stroke`, `fill`, `tick.fill`, `contentStyle.border` are JS style strings.
Use `var(--color-border)` not `hsl(214 32% 91%)`, `var(--color-primary)` not `hsl(221 83% 53%)`,
`var(--color-muted-foreground)` not `hsl(215 16% 55%)`, `var(--color-primary-subtle)` not `hsl(214 95% 97%)`.

### Gotcha — MaintenanceSchedule API supports single vehicleId only
`GET /maintenance-schedules?vehicleId=X` accepts one vehicleId at a time.
To fetch schedules for multiple vehicles (e.g. CRM garage tab), fire parallel calls per vehicle
and merge results client-side. Do NOT fetch all org schedules and filter client-side.

### Gotcha — Контракт endpoints: завжди `{ items, total }`, ніколи bare array
- Усі list endpoints у проєкті повертають paginated shape `{ items, total, page?, limit? }` — `work-orders`, `invoices`, `purchase-orders`, `maintenance-schedules` (масив бо ≤200), `completion-acts` (тепер `{ items, total }` після Bug #1).
- Frontend всюди робить `apiFetch<{ items: X[] }>(...)` — якщо сервіс повертає bare array, `.items` → `undefined.length` → TypeError. У комбінації з `.catch(() => {})` баг ховається.
- При додаванні нового list endpoint — **завжди** обертай у paginated DTO навіть якщо `take` фіксовано.

### Gotcha — FSM bypass всередині cross-service transactions
- При підписанні CompletionAct авто-переводимо WO у `INVOICED`. Спокусливо зробити `tx.workOrder.update({ status: 'INVOICED' })` — це **обходить** FSM map. Окрім втрати валідації, такий код:
  1. Робить race vікно (читання act поза tx, write всередині)
  2. Дозволяє duplicate transitions якщо хтось паралельно перевів WO іншим шляхом
- Правильно: re-read entity **всередині** tx + явна перевірка status (`if (workOrder.status === 'COMPLETED')`) + єдиний `update`.

### Gotcha — Auto-side-effect помилки: log non-business, suppress only expected
- Фон. дія типу `this.invoices.createFromWorkOrder().catch(() => {})` ковтає ВСЕ. Згодом баг "чому рахунки не створюються?" дуже важко відловити.
- Шаблон: `.catch(e => { const msg = e.message; if (!msg.includes('очікувана_бізнес-помилка')) logger.warn(...) })`.

### Gotcha — Soft delete у relation filters
- `findMany({ where: { vehicle: { deletedAt: null }, ... } })` — Prisma підтримує relation-фільтри. Без цього widget "Наближається ТО" показує авто, які користувач уже видалив.
- Правило: будь-яка `findMany` що рендериться у UI через FK має додавати `relation: { deletedAt: null }`.

### Gotcha — Selective recalc у PATCH — recompute тільки коли input змінено
- ❌ BAD: `const next = dto.next ?? calc(...)` — будь-який PATCH перераховує і затирає існуюче значення (`calc` може дати null якщо інтервалу немає в БД).
- ✅ GOOD: `const shouldRecalc = INPUT_FIELDS.some(f => dto[f] !== undefined); const next = shouldRecalc ? calc(...) : existing.next`
- Стосується: MaintenanceSchedule.update (виправлено), будь-який інший derived field.

### Gotcha — Raw SQL camelCase identifiers
Prisma schema **без `@map`** → Postgres колонки double-quoted camelCase (`"orgId"`, `"goodId"`, `"deletedAt"`, `"minStock"`, тощо). Будь-який `$queryRaw` / `$executeRaw` повинен:
- Використовувати **camelCase з лапками**: `WHERE "orgId" = ${orgId}::uuid`
- Не покладатись на Postgres lowering (`org_id` → не знайде `"orgId"`)
- Перевірити проти `information_schema.columns` перед написанням

---

## Архітектура — де що живе

```
apps/
  api/                     NestJS 10 + Fastify  (port 3000)
    src/
      app.module.ts        ← реєстрація всіх модулів
      auth/                ← JWT (access 15хв Bearer + refresh 30д httpOnly cookie)
        auth.service.ts    ← login / refresh / logout
        auth.spec.ts       ← 8 unit-тестів (vitest)
        guards/            ← JwtAuthGuard, RolesGuard
        decorators/        ← @OrgContext(), @Roles(), @CurrentUser()
      prisma/
        prisma.service.ts  ← PrismaClient + soft-delete middleware (syncVersion auto-increment)
      modules/             ← 28 доменних модулів (по 1 на сутність)
  web/                     Next.js 15 static export  (port 3001)
    src/
      app/
        layout.tsx         ← AuthProvider → TopShell (всі маршрути захищені)
        globals.css        ← Tailwind 4 @theme токени + .page-* + .kpi-card-* класи
        (auth)/login/      ← публічний маршрут (split-panel layout)
        setup/             ← публічний маршрут (перший запуск)
        dashboard/         ← KPI-картки + recharts
        work-orders/       ← список + detail [id]/
        crm/               ← контрагенти + detail [id]/
        vehicles/          ← [id]/ detail
        calendar/          ← слоти підйомників/механіків
        inventory/         ← залишки
        purchase-orders/   ← замовлення постачальникам
        stock-documents/   ← списання / переміщення / початкові залишки
        invoices/          ← рахунки
        settlements/       ← розрахунки
        reports/           ← звіти
        catalog/           ← роботи, товари, послуги
        employees/         ← співробітники
        infrastructure/    ← філії, зони, підйомники, склади
        settings/          ← налаштування + sync/
        403/               ← сторінка помилки доступу
      components/
        TopShell.tsx       ← sidebar (3 секції: Документи/Звіти/Довідники) + bookmarks + avatar
        ui/
          button.tsx       ← Variant: primary|secondary|outline|ghost|destructive|link|default
          input.tsx        ← props: label, errorMessage, hint, leftElement, rightElement
          select.tsx       ← props: label, errorMessage, hint, placeholder
          badge.tsx        ← variants: default|success|warning|destructive|info|outline
          card.tsx         ← Card, CardHeader, CardContent, CardFooter
          modal.tsx        ← prop: footer (кнопки дій), title, children
          table.tsx        ← Table, Thead, Tbody, Tr, Th, Td
          spinner.tsx      ← розміри: xs|sm|md|lg + PageSpinner + InlineSpinner
          empty-state.tsx  ← розміри: sm|md|lg
          detail-panel.tsx ← inline flex panel w-80/w-0, slide transition, title + X close
      lib/
        api-client.ts      ← apiFetch<T>() з auto-refresh токена
        auth.ts            ← TOKEN_KEY, useAuth(), AuthProvider
packages/
  database/
    prisma/schema.prisma   ← 41 модель, 15 enum-ів
  shared/
    src/
      types.ts             ← BaseEntity, SyncRecord, PaginatedResponse, UserRole, ...
      schemas.ts           ← Zod схеми (uuidSchema, paginationSchema, ...)
      constants.ts         ← uk-UA locale, timezone, currency constants
```

---

## Всі API модулі (28)

| Модуль | Файл | Ключові методи |
|---|---|---|
| `branches` | `branches.service.ts` | findAll, findOne, create, update, delete (soft) |
| `calendar` | `calendar.service.ts` | findSlots, createSlot, updateSlot, deleteSlot — conflict check |
| `counterparties` | `counterparties.service.ts` | CRUD + garages sub-resource |
| `document-number` | `document-number.service.ts` | `next(orgId, type)` → генерує номер по `DocumentNumberConfig` |
| `employees` | `employees.service.ts` | CRUD + zones/lifts/categories M:M |
| `files` | `files.service.ts` | upload/download через MinIO |
| `goods` | `goods.service.ts` | CRUD + пошук по sku/barcode |
| `inventory` | `inventory.service.ts` | **`createMovement()`** ← ЄДИНА точка мутації stock |
| `invoices` | `invoices.service.ts` | CRUD + `markPaid()` |
| `notifications` | `notifications.service.ts` | BullMQ → SMS/Viber/Email через шаблони |
| `payment-methods` | `payment-methods.service.ts` | CRUD довідника способів оплати |
| `payments` | `payments.service.ts` | create → `SettlementsService.createTransaction(PAYMENT)` |
| `purchase-orders` | `purchase-orders.service.ts` | CRUD + confirm → stock RECEIPT |
| `reports` | `reports.service.ts` | revenue, stock-value, employee-performance |
| `services` | `services.service.ts` | CRUD пакетів послуг (Work+Good bundle) |
| `settings` | `settings.service.ts` + `document-numbering.service.ts` | get/set org settings, numbering config |
| `settlements` | `settlements.service.ts` + `settlements-account.service.ts` | **`createTransaction()`** ← ЄДИНА точка мутації balance |
| `setup` | `setup.service.ts` | `POST /setup` — перший запуск, seed org+admin |
| `stock-documents` | `stock-documents.service.ts` | WRITEOFF / TRANSFER / OPENING_BALANCE |
| `sync` | `sync.service.ts` | pull(since) + push(records) + getStatus() |
| `vehicles` | `vehicles.service.ts` | CRUD + vehicleNodes sub-resource |
| `warehouses` | `warehouses.service.ts` | CRUD |
| `work-categories` | `work-categories.service.ts` | CRUD ієрархії категорій |
| `work-orders` | `work-orders.service.ts` | CRUD + FSM `transition()` + lines + parts |
| `works` | `works.service.ts` | CRUD норм-годин |
| `zones` | `zones.service.ts` | CRUD + lifts sub-resource |

---

## Критичні бізнес-правила (завжди пам'ятати)

### FSM нарядів (`work-orders.fsm.ts`)
```
DRAFT → ESTIMATE → APPROVED → IN_PROGRESS → COMPLETED → INVOICED → PAID → ARCHIVED
         ↕            ↕          ↕
       DRAFT      CANCELLED  ON_HOLD ↔ IN_PROGRESS
                             CANCELLED
```
- `IN_PROGRESS`: `InventoryService.createMovement(RESERVATION)` для кожної запчастини
- `COMPLETED`: `createMovement(RESERVATION_RELEASE)` + `createMovement(WRITEOFF)` + `SettlementsService.createTransaction(CHARGE)` — у `$transaction`
- `CANCELLED` з `IN_PROGRESS`/`ON_HOLD`: `createMovement(RESERVATION_RELEASE)`
- Файл FSM: `apps/api/src/modules/work-orders/work-orders.fsm.ts`

### Інвентар — захисти в `inventory.service.ts`
- `qty = 0` → `BadRequestException`
- `RESERVATION_RELEASE` з `qty > 0` → `BadRequestException`
- `RESERVATION` якщо `available < qty` → `BadRequestException`
- `WRITEOFF` якщо `quantity < |qty|` → `BadRequestException`

### Розрахунки — дельти балансу (`settlements.service.ts`)
- `CHARGE` → `+amount` (клієнт нам винен)
- `PAYMENT`, `PREPAYMENT`, `REFUND`, `CREDIT_NOTE` → `-amount`

### Soft delete — винятки (БЕЗ `deletedAt`)
Ці моделі не мають поля `deletedAt` — не фільтрувати:
- `SettlementAccount`, `SettlementTransaction`, `StockMovement`, `Payment`, `WorkOrderLineEmployee`

### Tenant isolation
- Кожен `findFirst`/`findMany` — завжди `where: { orgId, ... }`
- `create` — `{ ...dto, orgId }` де `orgId` ОСТАННІЙ (щоб перезаписати forged field)

---

## Фаза 16 прогрес (поточна сесія, 2026-05-25)

### Завершено (backend)
- **16.1** — Brand model (CRUD /brands) + Good.brandId FK + UI Select у формі товару
  - Files: `packages/database/prisma/schema.prisma`, `apps/api/src/modules/brands/`
  - Migration: `20260524221751_add_brand_model`
  - UI: GoodsTab form з Brand Select
- **16.2** — GoodBarcode model + endpoints (GET/POST/DELETE /goods/:goodId/barcodes)
  - Migration: `20260524221943_add_good_barcodes`
  - Service: getBarcodes, createBarcode, deleteBarcode
- **16.3** — UnitOfMeasure model + UnitsModule (CRUD /units-of-measure)
  - Migration: `20260524222044_add_units_of_measure`
  - Good.unitId FK для зворотної сумісності
- **16.4** — XLSX_MANAGER role додана до UserRole enum
  - Migration: `20260524222133_add_xlsx_manager_role`
- **16.5** — XlsxModule (/xlsx) з exceljs
  - Templates: goods, works, brands, units, po-lines, sd-lines, wo-parts
  - Parse методи: parseGoods, parseWorks, parseBrands, parseUnits, parsePOLines
  - Import endpoints: POST /xlsx/import/goods, brands, units
  - Результат: {created, updated, errors[]}
- **16.7** — CRM default garage auto-creation
  - CounterpartiesService.create() → auto-create CustomerGarage(name='Основний', isDefault=true)
  - Migration: `20260524222539_add_customer_garage_is_default`

### Завершено (frontend, 2026-05-25 session 2)
- **16.2** ✅ — Barcodes DetailTab (info/barcodes tabs, add/delete, Star isPrimary icon)
- **16.3** ✅ — Units select у GoodsTab form + UnitsTab CRUD у /catalog
- **16.4** ✅ — XLSX_MANAGER у ROLE_LABELS (TopShell + employees page)
- **16.5** ✅ — XlsxImportButton component + toolbar integration у GoodsTab, WorksTab
- **16.7** ✅ — isDefault badge у гаражах (CRM card)
- **16.8** ✅ — CRM /crm/[id]/PageClient повністю 4 таби з inline edit, accordion garages
- **16.9** ✅ — Nav mode toggle (NAV_GROUPS_FUNCTIONS + navMode state + localStorage)
- **16.10** ✅ — color-mode.ts + ColorModeProvider + anti-flash script + dark CSS vars + settings UI

### TODO (залишилось)
- **16.6** — XLSX import для PO/SD/WO лінійок (бекенд + фронтенд)
- **16.10** — Skeleton dark variant у globals.css

## Архітектура змін Фаза 16

### 16.1 Довідник брендів + розширення Good
- Нова модель `Brand` (orgId, name unique per org)
- `Good.brandId` (optional FK → Brand)
- `BrandModule` CRUD `/brands`
- У формі товару: Select бренду + inline "+ Новий бренд"

### 16.2 Штрихкоди — окрема вкладка в картці товару
- Нова модель `GoodBarcode` (goodId, barcode, type, isPrimary). Append-only (без deletedAt).
- `@@index([orgId, barcode])` для швидкого пошуку по скануванню
- В `/catalog` Goods tab: розгортається модалка/слайд з 2 вкладками "Основна" + "Штрихкоди"
- Endpoints: `GET/POST/DELETE /goods/:id/barcodes`

### 16.3 Одиниці виміру
- Нова модель `UnitOfMeasure` (orgId, name, shortName unique per org, isSystem). Seed: шт, кг, л, м, компл, пара, набір, уп, рул, м²
- `Good.unitId` (optional FK) + зворотна сумісність з `Good.unit String`
- `UnitsModule` CRUD `/units-of-measure`
- Select у формі товару

### 16.4 Нова роль XLSX_MANAGER
- Додати до `UserRole` enum значення `XLSX_MANAGER`
- Захист всіх XLSX-endpoints через `@Roles('OWNER', 'ADMIN', 'XLSX_MANAGER')`
- UI: роль відображається в `ROLE_LABELS`, доступна при створенні співробітника

### 16.5 XLSX-імпорт довідників
- `XlsxModule` (`/xlsx`), використовує **exceljs** (npm)
- `GET /xlsx/templates/:type` — завантажити шаблон (goods | works | brands | units)
- `POST /xlsx/import/:type` — multipart .xlsx → upsert + відповідь `{ created, updated, errors }`
- Компонент `XlsxImportButton` — пара кнопок "Шаблон" + "Імпорт" з результатом toast
- Інтегрувати у `/catalog` (Товари, Роботи, Бренди вкладки)

### 16.6 XLSX-імпорт табличних частин
- `POST /xlsx/import/purchase-order-lines/:poId` — SKU+qty+price → POLines (тільки DRAFT)
- `POST /xlsx/import/stock-document-lines/:docId` — аналогічно StockDocument (DRAFT)
- `POST /xlsx/import/work-order-parts/:woId` — аналогічно WorkOrder (DRAFT/ESTIMATE)
- Шаблони: `GET /xlsx/templates/po-lines`, `sd-lines`, `wo-parts`
- `XlsxImportButton` в картці PO, StockDoc, WorkOrder

### 16.7 CRM — гараж "Основний" за замовчуванням
- `CustomerGarage.isDefault Boolean @default(false)` — нове поле, міграція
- `POST /counterparties` автоматично створює гараж з назвою "Основний" і `isDefault: true`
- Основний гараж відображається першим із позначкою в UI

### 16.8 CRM — картка клієнта (вкладки)
- `/crm/[id]` реорганізована в 4 вкладки:
  1. **Загальна інформація** — поля + редагування inline
  2. **Гаражі та авто** — accordion гаражів, у кожному список авто + "Додати авто", форма "Додати гараж"
  3. **Взаєморозрахунки** — баланс + транзакції
  4. **Наряди** — наряди цього контрагента

### 16.9 Налаштування навігації
- `localStorage` ключ `sto_nav_mode`: `'sections'` | `'functions'`
- Режим **"По розділах"** (default): Документи / Звіти / Довідники (поточний)
- Режим **"По функціях"**: плоска структура без секцій, порядок: Дашборд, Наряди, Календар, CRM, Склад, Замовлення, Документи складу, Рахунки, Розрахунки, Звіти, Каталог, Персонал, Підрозділи, Налаштування, Cloud Sync
- Перемикач у `/settings` вкладка "Оформлення"
- `TopShell.tsx` зчитує `sto_nav_mode` через useEffect (SSR-safe)

---

## UI Patterns (2026-05-25)

### Navigation структура TopShell
```
Секція "Документи":  /work-orders, /invoices, /purchase-orders, /stock-documents
Секція "Звіти":      /calendar, /settlements, /reports (OWNER/ADMIN/ACCOUNTANT)
Секція "Довідники":  /crm, /inventory, /catalog, /employees, /infrastructure, /settings, /settings/sync
```
- `ALL_NAV_ITEMS` — flat array для bookmark lookup
- `BOOKMARKS_KEY = 'sto_bookmarks'` — localStorage, SSR-safe (useState([]) → useEffect hydrate)
- Star button: `opacity-0 group-hover:opacity-100`, `fill-current` коли активна

### DetailPanel — патерн використання
```tsx
import { DetailPanel } from '@/components/ui/detail-panel';

// State
const [selectedItem, setSelectedItem] = useState<Item | null>(null);

// Layout (після таблиці або навколо)
<div className="flex gap-0">
  <div className="flex-1 min-w-0 overflow-auto border border-border rounded-xl">
    <Table>
      <TableBody>
        {items.map(item => (
          <TableRow key={item.id} onClick={() => setSelectedItem(s => s?.id === item.id ? null : item)}>
            ...
            <TableCell>
              <Button onClick={e => { e.stopPropagation(); /* action */ }}>...</Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  </div>
  <DetailPanel
    open={!!selectedItem}
    onClose={() => setSelectedItem(null)}
    title={selectedItem?.name ?? ''}
  >
    {/* detail content */}
  </DetailPanel>
</div>
```

### Soft Delete UI — патерн
- **Немає кнопки "Видалити"** — лише "Помітити на видалення"
- Кнопка: `variant="ghost"` + `Trash2` icon + `text-muted-foreground hover:text-destructive hover:bg-destructive/10`
- Confirm: `'Помітити X на видалення?'` (не "Видалити X?")
- Toggle "Показати видалені": Eye/EyeOff icon, `?showDeleted=true` у API params
- Видалені рядки: `opacity-60` + Badge variant="secondary" "видалено"
- Виняток: `StockItem`, `StockMovement`, `SettlementTransaction`, `Payment`, `WorkOrderLineEmployee` — не мають `deletedAt`

---

## Design System (Tailwind 4)

### Ключові токени (`globals.css` → `@theme`)
```
--color-brand-{50..900}    ← синя шкала (primary)
--color-primary            = brand-600 (#2563eb)
--color-primary-hover      = brand-700
--color-sidebar-bg         = hsl(224 44% 13%)   ← темно-синій sidebar
--color-sidebar-fg         = hsl(213 31% 85%)
--color-border             = hsl(214 32% 91%)
--color-border-hover       = hsl(214 32% 80%)
```

### Canonical Tailwind 4 синтаксис (IDE перевіряє!)
```
✅ border-border           ❌ border-(--color-border)
✅ ring-brand-100          ❌ ring-(--color-brand-100)
✅ hover:border-border-hover ❌ hover:border-(--color-border-hover)
✅ bg-secondary            ❌ bg-(--color-secondary)
```
Виключення: якщо токен НЕ в `@theme` (кастомний hsl) — тоді `bg-[hsl(...)]`.

### Утилітні CSS-класи
```css
.page-container    ← max-w + padding для всіх сторінок
.page-header       ← flex row між заголовком та діями
.page-title        ← h1 стиль
.page-subtitle     ← підзаголовок muted
.kpi-card-blue/green/amber/red/violet/teal  ← кольори KPI-карток
```

### Button variants
`primary` | `secondary` | `outline` | `ghost` | `destructive` | `link` | `default` (= outline)

---

## Prisma — всі 41 моделей

**Infrastructure:** Organisation, GarageBranch, Zone, Lift, Warehouse, BranchSettings, OrganisationSettings, DocumentNumberConfig, TaxRate, PaymentMethodConfig, NotificationTemplate

**Auth:** AuthAccount

**CRM:** Counterparty, CustomerGarage, Vehicle, VehicleNode

**Catalog:** WorkCategory, Work, Good, Service, ServiceWork, ServiceGood

**Employees:** Employee, EmployeeZone, EmployeeLift, EmployeeWorkCategory

**Work Orders:** WorkOrder, WorkOrderLine, WorkOrderLineEmployee, WorkOrderPart

**Inventory:** StockItem, StockMovement, StockDocument, StockDocumentLine, PurchaseOrder, PurchaseOrderLine

**Finance:** Invoice, Payment, SettlementAccount, SettlementTransaction, ReconciliationAct

**Scheduling:** CalendarSlot

**Sync:** SyncJob

### Обов'язкові поля КОЖНОЇ моделі
```prisma
id          String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
orgId       String   @db.Uuid
createdAt   DateTime @default(now())
updatedAt   DateTime @updatedAt
deletedAt   DateTime?
syncVersion BigInt   @default(0)
```

---

## Синхронізація (`sync.service.ts`)

- **Pull tables** (read-only для клієнта): `work_orders`, `work_order_lines`, `work_order_parts`, `counterparties`, `vehicles`, `customer_garages`, `stock_items`, `invoices`, `payments`, `calendar_slots`
- **Push-safe tables**: `counterparties`, `vehicles`, `customer_garages`, `calendar_slots`
- **Pull blacklist**: `counterparties → phone, edrpou, email` (не відправляти на мобільний)
- **Push whitelist**: по таблиці — тільки дозволені поля проходять
- **Delta-sync**: `WHERE orgId = ? AND syncVersion > ?`
- **FK validation при push**: `liftId`, `employeeId`, `workOrderId` → перевірка по `orgId`

---

## Автоматичний QA флоу (після кожного завдання)

```
завдання виконано + git commit
        │
        ▼
  /sto-review (auto)
  — code review, фіксує всі знайдені проблеми
        │
        ▼
  /sto-tester (auto)
  — BUG_REPORT.md, фіксує всі баги
        │
        ▼
  MemoryManual.md update
  — нові gotchas / зміни архітектури
        │
        ▼
  git commit "docs(memory): ..."
```

> Не запускається рекурсивно якщо запит сам по собі був `/sto-review` або `/sto-tester`.

## Щогодинний моніторинг (loop)

- **Cron**: кожну годину о :13 (налаштовано через CronCreate)
- **Файл промпту**: `.claude/scheduled_tasks.json`
- **Дія**: читає `MemoryManual.md` + `PHASES.md` + `MEMORY.md`, визначає стан, продовжує або запускає QA
- **Обмеження**: cron живе тільки в рамках сесії. При старті нової сесії — `/loop 1h`

## Скіли Claude Code

| Скіл | Коли використовувати |
|---|---|
| `/sto-context` | **ЗАВЖДИ ПЕРШИМ** — читає `docs/PHASES.md`, показує статус |
| `/sto-analyst` | Вимоги, user stories, бізнес-процеси |
| `/sto-feature` | Планування нової фічі (до коду) |
| `/sto-architect` | ADR, архітектурні рішення |
| `/sto-database` | Зміни `schema.prisma`, міграції |
| `/sto-backend` | NestJS модуль (DTO + Service + Controller + spec) |
| `/sto-web` | Next.js сторінки і компоненти |
| `/sto-mobile` | Expo / React Native |
| `/sto-review` | Code review + TypeScript errors (`tsc --noEmit`) |
| `/sto-tester` | Автотестування: знаходить баги → `BUG_REPORT.md` → фіксить |
| `/sto-installer` | Inno Setup + PowerShell installer |
| `/sto-git` | Commits, branches, changelog |

**Workflow нової фічі:**
```
/sto-context → /sto-analyst → /sto-feature → /sto-database → /sto-backend → /sto-web → /sto-review → /sto-tester
```

---

## Відомі пастки (gotchas)

| # | Пастка | Правильно |
|---|---|---|
| 1 | `Button asChild` — не підтримується | Використовуй `<Link>` з inline Tailwind |
| 2 | `deletedAt: null` у `SettlementAccount` — поля немає | Не додавати фільтр на цих моделях |
| 3 | Tailwind 4: `border-(--color-border)` не canonical | `border-border` якщо токен є в `@theme` |
| 4 | `orgId` у `create` йде ОСТАННІМ | `{ ...dto, orgId }` — щоб перекрити forged field |
| 5 | Timezone Київ — не хардкодити `+03:00` | `kyivOffsetMs()` через `Intl.DateTimeFormat` (DST) |
| 6 | `setup/` маршрут — без `AuthProvider` shell | Окремий `layout.tsx` без `TopShell` |
| 7 | Пряме `prisma.stockItem.update` — заборонено | Тільки `InventoryService.createMovement()` |
| 8 | Пряме `prisma.settlementAccount.update` — заборонено | Тільки `SettlementsService.createTransaction()` |
| 9 | `postcss.config.mjs` — критичний файл | Без нього Tailwind 4 не генерує CSS у Next.js |
| 10 | `Select placeholder` — НЕ нативний HTML атрибут | Рендериться як `<option value="" disabled>` |
| 11 | Hydration mismatch: `border-primary` у spinner на root page | SSR резолвить у `border-blue-600`, клієнт лишає `border-primary` → різні рядки. Фікс: `border-(--color-primary)` — CSS var-синтаксис identity-stable на обох сторонах |
| 12 | `new Date().toLocaleDateString(...)` у render path | SSR рендерить у UTC, клієнт у Europe/Kyiv → mismatch. Фікс: `useEffect(() => setState(...), [])` |
| 13 | `createPortal(…, document.body)` без SSR-гарду | `document` відсутній під час prerender. Фікс: `const [mounted, setMounted] = useState(false); useEffect(() => setMounted(true), [])` |
| 14 | Глобальний `saving` стан у списку | Всі рядки таблиці потрапляють у loading. Фікс: `savingId: string | null` — по одному рядку |
| 15 | `transition()` без `$transaction` | Між findFirst і update може змінитись статус (race condition). Фікс: загорнути обидва у `prisma.$transaction` |
| 16 | `RESERVATION_RELEASE` без перевірки `reserved >= qty` | Від'ємний резерв у StockItem. Фікс: перевірити `Math.abs(dto.quantity) > reserved` |
| 17 | `React.ReactNode` без імпорту → 56 VSCode помилок | Next.js TS plugin суворіший ніж plain `tsc`. Фікс: `import type { ReactNode } from 'react'` і `ReactNode` напряму. Grep: `grep -rn "React\." apps/web/src/ --include="*.tsx"` |
| 18 | `tsc --noEmit` приховує помилки через `incremental` кеш | `Check time: 0.00s` — кеш пропускає перевірку. Фікс: `tsc --noEmit --incremental false` |
| 19 | `useMemo(() => new Date(), [])` для "now" у render | Так само небезпечно як `useState(() => new Date())` — мемо виконується під час static-export prerender → build-time timestamp запікається в shell → hydration mismatch + застаріле "сьогодні". Фікс: `useState<Date\|null>(null)` + `useEffect(() => setToday(new Date()), [])`; передавати `today?.getTime() ?? 0` у `ExpiryBadge` (nowMs=0 → `daysUntil` → null → бейдж прихований на сервері) |
| 20 | Async-рефакторинг fire-and-forget loader без `cancelled`/`mountedRef` | Перехід `.then()`-ланцюга на `async/await` втрачає захист від race: два паралельні запуски (перемикання вкладок, refresh після мутації) інтерлівлять `setState` стейлом + setState-after-unmount. Фікс: `let cancelled=false` навколо кожного `setX`, `return () => { cancelled = true }`, і `return loadX()` у `useEffect`. Має бути консистентним з сусідніми loader'ами того ж компонента |

---

## Команди розробки

```bash
# Запуск (dev)
docker-compose -f docker-compose.dev.yml up -d   # DB + Redis + MinIO
pnpm dev                                          # API :3000 + Web :3001

# TypeScript перевірка
pnpm --filter @sto/web exec tsc --noEmit
pnpm --filter @sto/api exec tsc --noEmit

# Тести
pnpm --filter @sto/api test --run

# Prisma
pnpm --filter @sto/database prisma migrate dev --name <name>
pnpm --filter @sto/database prisma studio

# Build
pnpm --filter @sto/api build
pnpm --filter @sto/web build
```

---

## Changelog (останні коміти)

| Hash | Опис |
|---|---|
| `f13b9ad` | fix(review): SSR-safe today (useMemo→useState+useEffect), cancel guard on CRM loadGarages + wired into tab effect, removed dead loadAudit useCallback in WO detail |
| `6a72c23` | perf(round2): parallel Promise.all queries (invoices, completion-acts, CRM staged loads, WO loadSecondary) + img lazy/decoding |
| `f70c7c7` | docs(tester): record Bugs #61-#67 from /sto-tester FULL pass + update MemoryManual |
| `aef124b` | fix(tester): Bugs #61-#67 — search reservedQty column, /branches shape mismatch, invoice PDF Bearer fetch, employees filter DTO, palette deep-link, WO template orgId scope + description prefix |
| `4cc4e6f` | fix(review): Phases 21-22 — TDZ, broken pdfmake, employeeId filter, polymorphic entityType, comment DELETE auth, SSR-unsafe localStorage, search ordering |
| `ef146d3` | feat(phases21-22): B6 search, B7 PDF, B10 branch ACL, F1-F2-F6-F8-F10-F12 UX features |
| `c938dc0` | fix(review): invoices page — mountedRef guards on all setState-after-await, selectTokenRef to drop stale detail responses on fast row-switching |
| `a60d3d3` | fix(review): Group 3 — SSR safety (useSavedFilters), a11y (Check/X onClick), nullable dueDate, uncontrolled priority select |
| `aed69c3` | fix(review): Command Palette + keyboard shortcuts — 7 issues (shift+/, useMemo deps, focus trap, a11y) |
| `bef35b7` | fix(tester): 6 bugs (settlement validate, low-stock LIMIT, CSV revoke, take, +tests) |
| `9295d6e` | fix(review): N+1 work-categories descendants + dead findOneDetail |
| `4910014` | docs(skills): hydration trap useState(new Date()) + missing tsconfig check |
| `183f20d` | fix(review): hydration mismatches + process.env in service + missing tsconfigs |
| `a11580d` | fix(api): take:1000 safety guard on FK-bounded findMany |
| `00cb288` | chore(claude): simplify settings.local.json — wildcard bash permissions |
| `be1be58` | docs(memory): update MemoryManual after review pass |
| `8cbbcb3` | fix(review): take limits on list/report queries + canonical shadow-xs |
| `6bbcb58` | feat(workflow): continuous skill self-improvement after every review/test |
| `2d34e4d` | feat(skills): overhaul sto-review — 11 sections: memory leaks, security, perf |
| `f317ae5` | fix(web): remove React namespace (56 VSCode errors) + skill auto-mode + models |
| `f2c8a9c` | fix(review): apply sto-review auto-fix pass — 11 bugs resolved |
| `ec6acac` | fix(web): fix hydration mismatch on root page spinner |
| `394156d` | feat(workflow): hourly loop + auto QA after every task |
| `d9ebecd` | docs(memory): add MemoryManual.md + wire into session flow |
| `11b468b` | feat(skills): add /sto-tester skill |
| `900c24b` | fix(web): Button 'default' variant + Select placeholder prop |
| `a6cafd5` | fix(web): postcss.config.mjs — Tailwind 4 CSS processing |
| `29cb3da` | feat(web): redesign crm, work-orders, calendar, dashboard, vehicles |
| `c57e85b` | fix(review): remove as any from auth.spec.ts |
| `f511ea8` | fix(review): Tailwind tokens in 403, setup, root, auth pages |
| `aa79a5b` | fix(review): Tailwind tokens in settings, calendar, detail pages |
| `df612e7` | feat(web): redesign catalog, employees, infrastructure, reports, settlements |
| `d415d8a` | fix(review): Tailwind tokens in settlements and reports |
| `27fbb06` | fix(review): any types + Tailwind tokens across web pages |
| `5802de7` | feat(web): full UI redesign — design system, components, pages |
| `b203ab0` | fix(services): validate workId/goodId FK ownership |
| `ebb31f3` | fix(web): NaN/invalid numeric input guards |
| `4bce74e` | fix(web): form validation + modal error guard |
| `bd8558f` | fix(review): DTO spread orgId override + zero-amount charge guard |

---

*Файл генерується автоматично. Не редагувати вручну.*
