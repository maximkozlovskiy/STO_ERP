# GOTCHAS — STO ERP

> Відомі пастки. Append-only: новий запис додається зверху. Не дублювати — одне місце правди.

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
