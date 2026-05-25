# MemoryManual — STO ERP

> Живий документ. Оновлюється автоматично після кожного git commit.
> Читається на початку кожної сесії разом із `CLAUDE.md` і `.claude/memory/`.
> Мета: швидка орієнтація в коді та оптимізація роботи Claude Code.

---

## Останній commit

```
6e88e6b docs(tester): record bugs #14-#25 from Phase 19 /sto-tester session
```

Дата: 2026-05-25

## Поточний стан тестів (після Phase 19 tester sweep, 2026-05-25)
```
TypeScript:  ✅ 0 errors        (web + api + shared)
Unit:        ✅ 105/105 passed  (12 files: + batches.contract, pricing-rules.contract; +3 Bug #14/#15 tests)
Contract:    ✅ 29/29 passed    (auth: 9, work-orders: 6, pricing-rules: 10, batches: 4)
Property:    ✅ 26/26 passed    (fsm: 11, inventory: 7, settlements: 8)
Components:  ✅ 42/42 passed    (button: 12, select: 9, modal: 10, empty-state: 11)
E2E:         ⏭  skipped         (dev server http://localhost:3001 офлайн)
Цикли QA:    ✅ Phase 19 tester — 12 багів знайдено + виправлено (1 CRITICAL / 3 HIGH / 3 MEDIUM / 5 LOW)
```

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

---

## Поточний стан проєкту

| Параметр | Значення |
|---|---|
| Фаза | **Фаза 17 — Enums, enriched models, MaintenanceSchedule + CompletionAct** (завершено + QA) |
| Прогрес | 17.1-17.3✅ backend + frontend + QA review |
| TypeScript | ✅ 0 errors (web + api) — verified 2026-05-25 |
| Unit тести | ✅ 26/26 passed (auth: 8, inventory: 8, settlements: 10) |
| Contract тести | ✅ 15/15 passed (auth: 9, work-orders: 6) |
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
