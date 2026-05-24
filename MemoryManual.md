# MemoryManual — STO ERP

> Живий документ. Оновлюється автоматично після кожного git commit.
> Читається на початку кожної сесії разом із `CLAUDE.md` і `.claude/memory/`.
> Мета: швидка орієнтація в коді та оптимізація роботи Claude Code.

---

## Останній commit

```
81765cb docs(tester): mark Bugs #10-#13 fixed in BUG_REPORT.md
b191792 fix(tester): Bug #13 — add E2E tests for API error resilience and inventory
04958b5 fix(tester): Bug #12 — add Testing Library component tests for UI primitives
ca08381 fix(tester): Bug #10 — add HTTP contract tests for auth and work-orders
a55b9fb fix(tester): Bug #11 — add fast-check property-based invariants tests
```

Дата: 2026-05-25

---

## Поточний стан проєкту

| Параметр | Значення |
|---|---|
| Фаза | **Фаза 16 — Installer та Production** (всі попередні `[x]`) |
| Наступна задача | `[sto-installer]` Inno Setup скрипт |
| TypeScript | ✅ 0 errors (web + api + shared) |
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
        TopShell.tsx       ← sidebar (згортається) + nav-групи + avatar
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
