# CHANGELOG — STO ERP

> Журнал комітів по фічах. Append-only. Найновіше — зверху.
> Архівується раз на фазу: старі записи переносяться у `docs/archive/CHANGELOG-phaseN.md`.

---

## 2026-06-19

### a257dc8c fix(tester): bugs #541-#543 — regression-guards for include drift + dead-code cleanup

- #541 LOW backend regression-coverage: PO_LINE_GOOD_INCLUDE / PART_GOOD_INCLUDE drift would not fail any test → extended mock fixtures у `work-orders.role-gate.spec.ts` (findOne+addPart) і `purchase-orders.service.spec.ts` (transition→findOne) з повним shape (internalCode/sku/brand) + асерції що поля потрапляють у DTO
- #542 LOW frontend regression-coverage: новий `WorkOrderPartsSection.test.tsx` (4 кейси) guards sub-line render — all 3, lone brand, all null no-render, empty parts empty-state
- #543 MEDIUM frontend dead-code: видалено onShowBatches prop + Layers import + button з WorkOrderPartsSection (PageClient ніколи не передавав callback з extraction commit e880a2f3 2026-06-05, silent UX no-op ~14 days)
- Тести: API 928/928 → 931/931 (+3); Web 434/434 → 438/438 (+4); TS green

### 9ea58b9e feat(goods): add internalCode (sequential internal good code)

- GOOD_INTERNAL_CODE в DocumentType enum + seed config (prefix T, NEVER reset)
- internalCode поле на Good + міграція 20260619140000
- GoodsService генерує internalCode при create через DocumentNumberService
- GoodsService: brand включений у всі відповіді (brandName в GoodResponseDto)
- PurchaseOrderLineResponseDto: goodInternalCode, goodBrandName
- WorkOrderPartResponseDto: goodInternalCode, goodSku, goodBrandName
- UI: GoodPickerModal, GoodsTab, GoodEditModal, PurchaseOrderCreateModal, CreateWorkOrderModal — показ код · артикул · бренд

### d1a12539 fix(review): PO/WO include drift + GoodPickerModal brandName mapping

### 34259b7a fix(tester): bugs #533-#540 — internalCode session + backfill migration 20260619140001

---

## 2026-06-17

### fe9c741c fix(review): VAT report filters + broken endpoint + VatMode typing

- CRITICAL (UI dead code): `PurchaseOrderCreateModal` викликав `/organisations/my` —
  endpoint НЕ існує (backend має `/settings/organisation`). Silent `.catch(() => {})`
  ховав факт що `vatMode`/`vatRate` ніколи не сетяться → ПДВ-колонка/рядок ніколи не
  показувались. Замінено на `/settings/organisation` + `/settings/tax-rates` (resolve
  rate by `defaultVatRateId` або `isDefault`); error → `console.error`. Симетрія з
  `CreateWorkOrderModal.tsx:597`
- CRITICAL (звітність): `ReportsService.vatReport()` агрегував ВСІ Invoice (включно з
  DRAFT/CANCELLED) і ВСІ PurchaseOrder крім CANCELLED (включно з DRAFT/ORDERED). За
  податковим обліком (1) sales VAT — лише виставлені рахунки (SENT/PAID/OVERDUE);
  DRAFT не є податковою подією, CANCELLED анульовано; (2) purchase VAT credit виникає
  лише після фактичної поставки (PARTIAL/RECEIVED), бо DRAFT/ORDERED не отримано.
  Додано `status: { in: [...] }` фільтри
- IMPORTANT (TS contract): `SettingsService.getDefaultVatRate()` повертав
  `{ vatMode: string; vatRate: number }` (bare string) → консумери писали
  `as 'NONE' | 'EXCLUSIVE' | 'INCLUSIVE'` каст. Тепер `vatMode: VatMode` (Prisma enum),
  drops 2 cast sites у purchase-orders.service.ts
- IMPORTANT (DRY): `vat.ts` мав local `type VatMode = 'NONE' | 'EXCLUSIVE' | 'INCLUSIVE'`
  замість Prisma `VatMode`. Імпорт з `@prisma/client` робить DRY single-source
- IMPORTANT (TS): `reports.service.ts` мав ugly `(invoicedAgg._sum as { totalVat?: unknown }).totalVat`
  cast. Prisma `_sum.totalVat: Decimal | null` доступний directly без касту

### test(tester): Bugs #530-#532 — Cycle 2 final regression-guards (14 нових тестів)

- Bug #530 (HIGH): public DTO leak guard для findByShareToken — costPrice/batchCostPrice/orgId/sensitive поля ВІДСУТНІ
- Bug #531 (MEDIUM): recalcTotals defensive `take: 1000` cap — regression-guard від видалення/зниження
- Bug #532 (LOW): Cycle 2 simplify audit — clean, без cleanup-debt
- 9 тестів у work-orders.share-public.spec.ts: hasOwnProperty whitelist, Promise.all parallel, skip empty uomIds
- 5 тестів у work-orders.recalc-cap.spec.ts: exact take:1000, narrow select, boundary 1000 рядків
- SKILL.md: 2 нові накопичені підходи — public DTO leak whitelist + defensive cap regression-guard
- API tests: 908 → 922 (+14, 100% green)

### 6d35157a fix(review): role-gate part.costPrice + UI cleanups

- §2.1 CRITICAL: GET /work-orders/:id повертав WorkOrderPartResponseDto.costPrice (batchCostPrice)
  для MECHANIC/RECEPTIONIST — порушував field-visibility інваріант goods/price-history
- service: COST_PRICE_VISIBLE_ROLES (OWNER/ADMIN/STOREKEEPER/ACCOUNTANT) + canSeeCostPrice() guard
- toPartDto(part, userRole?) — emit costPrice лише для дозволених ролей; fail-closed default
- controller: findOne(@CurrentUser() user: {role}) → передається у service
- WO list page: simplify hasActual = abs(totalActualLabor - totalLabor) ≥ 0.01 (totalParts cancels)
- CreateWorkOrderModal: align new-input cost cell з view/edit (text-left tabular-nums)
- skills: новий шаблон sto-review для nested-DTO role-gated полів + UI mode alignment

### 99f0e406 fix(tester): Bugs #506-#510 — totalActualLabor regression-guard + UI sync

- Bug #506/#510 (MEDIUM): PageClient.tsx не відображав різницю план/факт + дублював interface без totalActualLabor
- Bug #507 (HIGH): відсутні regression-тести для нової формули → додано work-orders.recalc-totals.spec.ts (6 тестів)
- Bug #508 (MEDIUM): публічний estimate показував totalActualLabor+totalParts замість totalLabor+totalParts (кошторис = план)

### ca5aef48 fix(review): line totals + invoice refresh + completion act on actualHours

- WO PDF рядків: `total = actualHours ?? normoHours × price` (не l.amount = normoHours × price)
- invoices.refreshFromWorkOrder: SUM з `actualHours ?? normoHours` симетрично з createFromWorkOrder
- completion-acts.buildLines: акт виконаних робіт тепер показує actualHours і фактичну суму
- EstimatePublicDto — без змін (SHAREABLE статуси де actualHours=null → totalAmount незмінний)

### 0665024c feat(work-orders): invoice/totalAmount on actual labor (actualHours ?? normoHours × price)

- WorkOrder.totalActualLabor (новий Decimal 12,2) = SUM((actualHours ?? normoHours) × price)
- totalAmount = totalActualLabor + totalParts (не totalLabor + totalParts)
- Migration: 20260617140000_add_total_actual_labor
- Invoice.createFromWorkOrder автоматично отримує правильну суму через wo.totalAmount

### 527011c9 fix(tester): Bugs #521-#525 — actualHours feature critical bugs

- Bug #521 (CRITICAL): UpdateWorkOrderLineDto відхиляв null actualHours → 400 при save() з порожнім Год (факт.)
- Bug #522 (CRITICAL): canEdit ∩ canEditActual = ∅ — Год (факт.) ніколи не можна було зберегти через FSM-конфлікт
- Bug #523 (HIGH): default drift recalcPlannedHoursFromLines між DocumentsTab (true) і WO Modal (false)
- Bug #524 (MEDIUM): actualTotals.hasAny=true при порожніх actualHours (fallback на normoHours) — tfoot дублював рядок
- Bug #525 (HIGH): computedActualHours=null при lines.length=0 коли recalcEnabled → data loss (overwrote existing value)

### ac2ced81 fix(review): recalcActualHoursFromLines contract mock + actualTotals toNumberOrUndefined

- settings.contract.spec.ts: додано recalcActualHoursFromLines у freshOrgRow() мок
- actualTotals useMemo: parseFloat → toNumberOrUndefined (узгодженість з save())

### 5d526ba9 feat(work-orders): recalcActualHoursFromLines setting + actual sum fallback to normoHours

- Нове поле recalcActualHoursFromLines в OrganisationSettings (Prisma + міграція + DTO + service)
- DocumentsTab: toggle "Перераховувати фактичні нормогодини по роботах"
- CreateWorkOrderModal: колонка "Год (факт.)", "Сума (факт.) = (ah ?? nh) × price", PATCH existing lines, computedActualHours

### 62785537 feat(work-orders): actual hours column in lines table

- Колонка "Год (факт.)" — editable в IN_PROGRESS/ON_HOLD, read-only інакше
- ARROW_SKIP_STATUSES: ON_HOLD/ARCHIVED/CANCELLED виключені зі стрілкової навігації

## 2026-06-16

### 7ec6dead docs(skills): add 3 new patterns to sto-tester (Bugs #515, #517, #518)

- Time-of-day DTO без @Matches regex + cross-field guard (Bug #515)
- jsdom URL.createObjectURL stub missing → vitest exit 1 shadow error (Bug #518)
- Dead exports у \*.utils.ts після refactor на dynamic config (Bug #517)

### 27854f05 perf(calendar): merge mount effects + statsTab useMemo

- useCalendarState: 2 окремих mount useEffect → 1 Promise.all (1 мережева хвиля)
- CalendarStatsTab: days, periodLabel, liftStats, totalMinAll — усе у useMemo

### e3a044df docs(skills): add settings/config endpoint cache pattern to sto-optimize

- Новий патерн у sto-optimize SKILL.md: read-endpoint без Redis при high-mount-frequency

### 3d8f4ad5 perf(calendar): Redis cache work-hours + statsTab single-pass aggregation (Bug #520)

- getWorkHours(): Redis TTL 60s (key=settings:work-hours:{orgId}) + conditional invalidation у updateBranchSettings
- CalendarStatsTab: liftStats bucket-by-liftId Map, O(N×M) → O(N+M), 30k Date allocs/render → 0

### add05f53 fix(tester): DTO regex, dead exports, jsdom stubs, spec coverage (Bugs #515-#518)

- settings.dto.ts: @Matches(HH_MM_RE) на workStartTime/workEndTime + cross-field guard
- calendar.utils.ts: видалено dead exports HOURS/TOTAL_HOURS/WINDOW_START/WINDOW_END/pxToHours
- setup.ts: typeof-guard stubs для URL.createObjectURL/revokeObjectURL
- settings.contract.spec.ts: +13 тестів для GET /settings/work-hours + PATCH validation

### b7bbd0d3 perf(optimize): EMPTY_BOOKINGS module-level + skill improvement

- CalendarDayGrid: `useMemo<BookingSlot[]>(() => [], [])` → module-level `EMPTY_BOOKINGS` (0 hook slot, 0 alloc per mount)
- optimize SKILL.md: додано 2 патерни — bucket-by-FK для date-overlap loops, module-level empty collection

### c4f6ab06 perf(optimize): GoodPickerModal stable refs + lift qty IIFE

- `setStockMap(new Map())` → module-level `EMPTY_STOCK_MAP` stable reference
- qty IIFE у `.map()` row → `const qty = stockMap.get(item.id) ?? 0` (1 alloc/row замість 1/render)

### 50cd6434 perf(optimize): bucket busy slots by liftId in getAvailability + useCalendarState

- `getAvailability()`: O(T×L×B) → O(T×L×avg(B/L)) + pre-parsed `startMs/endMs` (0 Date allocs у hot-path)
- `useCalendarState.load()` booking→lift assignment: Map pre-bucketed, 0 Date allocs для PENDING bookings

### 6987c7fa fix(tester): Bug #511-#514 — booking DST-safe bookedTimes + calendar race + clamp + workhours guard

- Bug #511 [CRITICAL]: bookedTimes використовував getUTCHours() → KYIV_HM_FMT.format() (DST-safe)
- Bug #512 [HIGH]: lifts.length додано до load() useEffect deps (race condition fix)
- Bug #513 [MEDIUM]: BookingSlotBlock left/width clamped (Math.max/min)
- Bug #514 [MEDIUM]: create() валідує requestedDate проти workDays + [workStart,workEnd)

### feat(session): booking widget + calendar bookings display + WO status on slots

- /booking: дедуплікація слотів (Map<timeKey>), телефон normalize перед POST, BranchSettings інтеграція
- /bookings admin: fmtDateTime для requestedDate (час + дата)
- CalendarSlotModal: підйомник обов'язковий (required validation + \*)
- GoodPickerModal: GET /goods/stock-totals → "N на складі" / "немає на складі" per item
- CalendarDayGrid: BookingSlotBlock (PENDING bookings, green dashed, read-only)
- CalendarSlot: workOrderStatus через всі шари (DB select → DTO → frontend → рендер)

### f337e4e9 revert(api): nest tsc builder + @sto/shared CJS build fix

- Reverted `nest start --builder swc` → `nest start --watch` (tsc builder): SWC on Windows emits `tsconfig paths` aliases as literal strings in dist JS, breaking monorepo resolution
- `packages/shared/tsconfig.cjs.json` (new): builds `@sto/shared` as CommonJS to `dist/cjs/`
- `packages/shared/package.json`: `main` → `./dist/cjs/index.js` (was raw `.ts`)
- `apps/api/tsconfig.json`: `rootDir: "src"` (was `"../.."`), removed `paths`, `baseUrl: "."` kept
- `apps/api/nest-cli.json`: removed `builder: "swc"`, reverted to default tsc

---

### aa3b03c5 fix(review): invoice section — deferred revokeObjectURL + shared labels + narrow types

- WO card `downloadInvoicePdf`: `setTimeout(() => URL.revokeObjectURL(url), 100)` + `appendChild(a)` / `removeChild(a)` — mirrors `downloadPdf` / `downloadActPdf` pattern (Bug #77 hardening).
- Filename now uses invoice number (`invoice-${number}.pdf`) instead of UUID.
- Status badge: replaced 5-branch hardcoded ternary with `INVOICE_STATUS_LABELS[invoiceRef.status]` (`@sto/shared`). Eliminates divergent local "Відправлено" vs shared "Надіслано" for SENT.
- 5 inline duplicates of `{ id, number, status, amount, documentDate }` → single `InvoiceRef` interface + `InvoicePayload` helper type.
- `findByWorkOrder()` return type: `status: string` → `status: InvoiceStatus` literal union.

---

## 2026-06-15

### cc2cd2e1 fix(tester): Bugs #487-#490 — post-cycle3 spec gaps + BALANCE_SIGN exhaustiveness

- array.spec.ts: 9 кейсів для `deduplicateBy<T>`
- BALANCE_SIGN: `Partial<Record>` → плоский `Record` (TS-exhaustive)
- regression-guards для deduplicateBy у PO/xlsx/pricing
- стаб `$transaction` mock у pricing.service.spec.ts виправлено

### 93473ad7 refactor(simplify): Cycle 3 — deduplicateBy<T> shared utility + BALANCE_SIGN lookup table

- `apps/api/src/common/utils/array.ts` NEW: `deduplicateBy<T>(arr, key)`
- purchase-orders.service.ts + xlsx.service.ts: call-sites → `deduplicateBy(plan, u => u.goodId)`
- settlements.service.ts: 5-branch if/else → `BALANCE_SIGN: Record<SettlementTransactionType, 1|-1>` lookup

### 4648446b docs(memory): update MemoryManual after Cycle 3 simplify

### c24014ed refactor(simplify): Cycle 3 — readonly FSM arrays, toIdMap/calcVatTotals helpers, dep fix

- work-orders.fsm.ts: все → `readonly WorkOrderStatus[] + Object.freeze`
- apps/web/src/lib/utils.ts: `toIdMap<T extends {id}>` + `calcVatTotals` helpers
- CreateWorkOrderModal: 6 useMemo Map blocks → toIdMap(), 2 reduce blocks → calcVatTotals()
- useMemo deps: `[currentStatus, isEditMode]` (allowedTransitions derived, redundant dep removed)

### 4400dfb7 docs(skills): branching ternary inside Promise.all + tenant-guard patterns to sto-optimize

### f23abfd3 perf(optimize): tier-merger contract Promise.all + settlements parallel write + ReconciliationAct covering index

- purchase-orders.service.ts create(): contract resolution merged into Promise.all 3rd slot
- settlements.service.ts createTransaction(): `Promise.all([create, update])` inside $transaction
- ReconciliationAct: `@@index([orgId, counterpartyId])` → covering `@@index([orgId, counterpartyId, createdAt])`

### 852d5fa4 fix(review): defense-in-depth orgId tenant guard on tx.X.update writes (pricing+SD)

- pricing.service.ts: `tx.good.update({ id })` → `tx.good.updateMany({ id, orgId, deletedAt: null })`
- stock-documents.service.ts: `tx.stockDocumentLine.update({ id: line.id })` → `{ id: line.id, orgId }`

### e33a5b58 docs(skills): chunked bulk-update + dedup pattern to sto-optimize

### 8fff4289 perf(optimize): parallelize chunked good.update loops with dedup safety

- pricing.service.ts applyRuleToGoods: for-loop → `Promise.all(chunk.map(...))`
- purchase-orders.service.ts applyPricing: dedup + `Promise.all`
- xlsx.service.ts applyPricingFromList: dedup + `Promise.all`

### a26cd68a fix(review): purchase-orders dedup lineId guard + drop redundant StockDocumentType casts

- receive(): pre-$transaction `Set` dedup guard → `BadRequestException` (Bug #483)
- stock-documents.service.ts: зайві `as StockDocumentType` касти видалено

### 705e25e7 refactor(simplify): cleanup after /simplify review

- TYPE_FILTERS/STATUS_FILTERS → module-level `Object.freeze(['', ...Object.keys(LABELS)])`
- @IsEnum(StockDocumentType) → Prisma enum import (not hardcoded array)
- stock-documents/page.tsx: aliases TYPE_LABELS/STATUS_LABELS видалено

### 147cd3fe test(e2e): add coverage for RECEIPT tab and purchase-orders edit-mode

### 46b5df7f perf(optimize): parallel FK guards + per-line writes in PO/SD services

- purchase-orders.service.ts update(): 3 sequential findFirst → `Promise.all`
- stock-documents.service.ts transition(): createMovement + updateLine → `Promise.all` per line
- purchase-orders.service.ts receive(): createMovement + updateLine → `Promise.all` per line

### 96579181 test(purchase-orders): Bug #481-#482 — FSM transition regression guards (+23 tests)

### 821de2d2 fix(sync): align StockDoc interface with StockDocumentResponseDto

### f59c6a47 test(stock-documents): Bug #478-#480 — regression guards for RECEIPT type (+22 tests)

### a067ec21 fix(review): CRITICAL — expose RECEIPT in stock-documents type tabs

### d059b9a9 feat(stock-documents): add RECEIPT type (Оприбуткування)

- STOCK_DOC_TYPE_LABELS/BADGE: `RECEIPT: 'Оприбуткування'` / `'success'`
- stock-documents.dto.ts: @IsEnum(StockDocumentType) + `type!: StockDocumentType`
- stock-documents.service.ts: `MOVEMENT_TYPES.RECEIPT`, `docTypeMap.RECEIPT = 'STOCK_RECEIPT'`

### 65552dcb test(purchase-orders): Bug #473-#477 — regression guards for update() contract resolution

### 32c6115f fix(review): purchase-orders contract clear + stale-contract guard on supplier change

- CRITICAL: auto-clear stale contract when supplierId changes
- IMPORTANT: SearchPickerModal onSelect clear contractId/contractNumber
- IMPORTANT: handleSave `contractId: contractId ?? null`

### 115fea9e feat(purchase-orders): editable supplier/warehouse/contract in DRAFT, FSM arrows, receivedQty column

---

## 2026-06-14

### 355fb445 fix(e2e): align spec locators with redesigned modals + fix Modal id collision (Bugs #467-#472)

- Modal.tsx: useId() per instance (was fixed `id="modal-title"`)

### 0b144de9 fix(tester): Bugs #459-#466 — modal contract fixes + baseline spec restore

- PurchaseOrderCreateModal: lines у body POST /purchase-orders (не POST /lines)
- InvoiceCreateModal: initialLineIdsRef snapshot + DELETE /invoices/:id/lines/:lineId для removed
- StockDocumentCreateModal: TRANSFER targetWarehouseId validation
- InvoiceCreateModal: computedTotal = sum(qty\*unitPrice)

### d08efb8d fix(review): surface ref-load errors + fix stale-closure auto-select in PO/StockDoc modals

### 71677c94 fix(sync): align modal interfaces and endpoints with backend API contracts

### 4a05d7c7 fix(review): pricing leak + types + per-warehouse stock

- CRITICAL: MECHANIC роль видалено з GET /stock-items/by-batch (costPrice/salePrice PII)
- ConsumptionRow type tightened (non-null alignment with schema)
- goods.service.stockTotals(): `take: 2000`
- CreateWorkOrderModal: `setStockWarehouseMap(new Map())` на reset

### fd8be3b3 perf(inventory): parallelize batch.service writes

### c4b249f2 perf(inventory): optimize 3-view report (DB indexes + memo + parallel FK guards)

- Додано 3 covering indexes: `stock_movements(orgId, goodId, createdAt)` + `(orgId, createdAt)` + `stock_batches(orgId, createdAt)`

### 1752a75 fix(inventory): Fragment keys + MOVEMENT_TYPE_LABELS enum sync + Intl singleton + relation soft-delete filters

### a5f01d37 feat(inventory): add 3-view stock report (По товарах / По документах / По партіях)

### c0879445 fix(review): stock-totals column — tfoot colSpan, race guard, UUID validation

### 0618c621 feat(work-orders): add "К-т на складі" column to parts table

### 94de0b34 fix(calendar): correct WO prefill from calendar slot (Bug #448)

- WINDOW*END * 60 замість hardcoded `19 _ 60`
- plannedHours у CreateWOPrefill interface

### af09a681 fix(tester): Bugs #449, #451 — regression tests + date='' guard

---

## 2026-06-12

### fef027b0 fix(review): calendar comment drift, silent sync failure, DocumentsTab PATCH/label

### 7640de9b fix(review): calendar sync — endAt>startAt guard, parent-only update, ConfirmDialog reuse

### fba87ce4 fix(tester): Bugs #444, #446, #447 — calendar sync hardening + settings coverage

### 29fc97f0 fix(settings): syncCalendarSlotWithPlannedHours in DocumentsTab PATCH body

### 307d1e39 feat(settings): add syncCalendarSlotWithPlannedHours setting

### e266f4a2 fix(settings): Toggle style for recalcPlannedHoursFromLines, default true

### 8778d3f1 feat(settings): add 'Налаштування документів' tab with plannedHours recalc toggle

### 50c550bd fix(review): WO completion deadlock, kyivOffsetMs unit, dashboard TO overdue

### 1d9cd19d fix(review): calendar contract spec + MECHANIC PII defense-in-depth

### 11c8ded7 fix(security): strip PII from GET /calendar/slots for MECHANIC role

### 86d22367 fix(review): drop counterpartyId from checkConflicts response

### 9d87c119 fix(security): strip PII from checkConflicts response

---

## 2026-06-11

### c24014ed refactor(simplify): Cycle 3 (prev) — readonly FSM arrays, toIdMap/calcVatTotals

### 51c22418 test(e2e): plannedHours/actualHours E2E specs

### 2a8da05a perf(optimize): CreateWorkOrderModal twin-scan reduce + N×M finds → useMemo Maps

### f1d3f805 docs(skills): optimize skill files — reduce total size by 46%

### f3633cd7 chore: remove leftover .bak file

---

## 2026-06-10 (Calendar sync + plannedHours)

### 231b0be2 test(e2e): Bug #486 — estimate-share self-seeding pattern

- beforeAll: clone DRAFT WO → transition to ESTIMATE
- afterAll: ESTIMATE → CANCELLED → DELETE (FSM-aware cleanup)

### 493c46ad docs(memory+skills): record self-seeding pattern

### 747cc445 perf(optimize): dashboard kyivToday hoist + calendar sync spec

### 294a5ed6 docs(skills): 2 perf patterns to sto-optimize

### 4d7eef47 docs(memory): update after review fef027b0

---

## Попередні фази (довідка)

### Inventory 3-view (a5f01d37)

Звіт «По товарах / По документах / По партіях» з DB covering indexes.

### PurchaseOrder edit-mode (115fea9e)

Editable supplier/warehouse/contract у DRAFT, FSM arrows завжди видимі, receivedQty column.

### StockDocuments (d059b9a9)

RECEIPT тип (Оприбуткування): 3 файли, без міграції (enum вже був у Prisma).

### Pricing: brand markup + COST_TIER (fdcf7ea)

`PricingRuleType.COST_TIER`, `brandId` у PricingRule, `PricingRuleTier` модель.  
Міграція: `20260530100000_add_pricing_brand_cost_tier`.

### UserPreference + Detail Panel Config (5d003e4)

`UserPreference` модель, `GET/PUT /user-preferences/:key`, `useDetailPanelConfig(pageKey)`.  
Міграція: `20260530200000_add_user_preferences`.

### CounterpartyContract (4f7a9be)

Contract entity + PURCHASE/SALE types + auto-primary promote + DocumentNumberService.

### TabBar — taskbar для згорнутих модалок (6f9515c6–f2ef7758)

`TabBarContext`, `useTabBar`, dedupe by (modalKey + identity-keys), fetch race guard.

### CreateWorkOrderModal — inline таблиці (eb929140)

Роботи + Товари pre-save рядки, toNumberOrUndefined(), close-guard Bug #381.

### PhoneInput — маска +38 (0XX) XXX-XX-XX (225ff70)

### AnimatedBody — плавна зміна висоти Modal (b5add44)

### useDirtyForm — async confirmClose + DirtyConfirmDialog (921afb7)

### Detail Panel System — useDetailPanel + DetailPanelToggle (f529d0f)

### ModalTabs — нижній таб-секція модалок (6b886ae)
