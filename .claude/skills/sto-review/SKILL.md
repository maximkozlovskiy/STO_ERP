---
name: sto-review
description: >
  Perform a thorough code review of STO ERP changes. Use when the user says "зроби code review", "перевір код", "review PR", or after implementing a feature. Reviews cover: correctness, security, memory leaks, performance, TypeScript quality, NestJS/Next.js/Expo conventions, business rule compliance, sync-readiness.
model: claude-opus-4-7
---

# sto-review — Code Review Skill

## Режим Auto (ОБОВ'ЯЗКОВО)

**Запускай у режимі Auto:** знаходь усі проблеми → виправляй кожну одразу → без питань до користувача.

```
1. git diff HEAD --name-only          → список змінених файлів
2. Пройди по КОЖНІЙ секції нижче     → фіксуй знайдені проблеми
3. Кожну проблему виправляй одразу   → Edit/Write → tsc --noEmit
4. git commit -m "fix(review): ..."  → після всіх правок
5. Оновити MemoryManual.md           → Останній commit + Changelog
```

> Не питай дозволу на виправлення.
> Якщо fix потребує міграції БД або зміни публічного API — зафіксуй як CRITICAL і повідом після завершення всіх інших правок.

---

## 1. TypeScript / Problems Panel

> **ВАЖЛИВО:** VSCode показує помилки через Next.js TS plugin — він суворіший за plain `tsc`. `pnpm tsc --noEmit` може давати 0 errors через `incremental` кеш (`Check time: 0.00s`). Завжди перевіряй з `--incremental false`.

```bash
# Web — завжди з --incremental false, бо кеш приховує помилки
cd apps/web && node_modules/.bin/tsc --noEmit --incremental false

# API
pnpm --filter @sto/api exec tsc --noEmit

# Shared / UI
pnpm --filter @sto/shared exec tsc --noEmit
pnpm --filter @sto/ui exec tsc --noEmit
```

**Автоматичний grep для поширених помилок:**

```bash
# React namespace без імпорту (→ 56 VSCode errors)
grep -rn "React\." apps/web/src/ --include="*.tsx" --include="*.ts"

# any типи
grep -rn ": any" apps/api/src/ apps/web/src/ --include="*.ts" --include="*.tsx"

# console.log у продакшн-коді
grep -rn "console\.log" apps/api/src/ apps/web/src/ --include="*.ts" --include="*.tsx"

# Tailwind 4 — застаріла [var(--x)] форма (має бути canonical token або (--x) shorthand)
grep -rn "\[var(--" apps/web/src/ --include="*.tsx" --include="*.ts"

# Pixel значення замість Tailwind scale
grep -rnE "(w|h|top|left|right|bottom|max-w|min-w|p|m|gap)-\[[0-9]+px\]" apps/web/src/ --include="*.tsx"

# Застарілі утиліти
grep -rn "flex-shrink-0" apps/web/src/ --include="*.tsx"

# tsconfig валідація ignoreDeprecations
grep -rn "ignoreDeprecations.*6\.0" apps/ packages/ --include="tsconfig*.json"
```

**Таблиця авто-фіксів:**

| Помилка | Фікс |
|---|---|
| `Cannot find namespace 'React'` / `React.ReactNode` | `import type { ReactNode } from 'react'` → використовувати `ReactNode` |
| `React.HTMLAttributes<T>` | `import type { HTMLAttributes } from 'react'` |
| `React.SVGAttributes<T>` | `import type { SVGAttributes } from 'react'` |
| `Type '"default"' is not assignable to type 'Variant'` | Додати `'default'` до Variant union у `button.tsx` |
| `Property 'placeholder' does not exist on SelectProps` | Додати `placeholder?: string`; рендерити як `<option value="" disabled>` |
| `Type 'unknown'` на Prisma dynamic select | Cast: `(result as { field: type }).field` |
| `is not assignable to type 'never'` | Додати відсутні гілки switch/union або cast |
| `Object is possibly 'null'` | Guard або non-null assertion якщо неможливо runtime |
| `TS5103: Invalid value for '--ignoreDeprecations'` | На TS 5.x використовуй `"5.0"`, не `"6.0"`. `"6.0"` стане валідним з TS 6.0 |
| `Option 'baseUrl' is deprecated` | Видалити `baseUrl` повністю — у TS 5+ `paths` працює відносно tsconfig.json |
| `The class '[var(--color-x)]' can be written as 'bg-x'` | Замінити `[var(--color-x)]` на canonical Tailwind token (див. `/sto-dev` Tailwind 4 секцію) |
| `The class 'w-[Npx]' can be written as 'w-M'` | Перевести px → Tailwind scale: M = N/4 (52px→w-13, 216px→w-54, 420px→w-105) |
| `The class 'flex-shrink-0' can be written as 'shrink-0'` | Просто перейменувати |
| `The class 'tracking-[Nem]' can be written as 'tracking-X'` | 0.05em→wider, 0.08em→widest, 0.025em→wide |

**Parity rules (тримати синхронно):**
- `Button` Variant: `'primary' | 'secondary' | 'outline' | 'ghost' | 'destructive' | 'link' | 'default'`
- `Select` props: `label`, `errorMessage`, `hint`, `placeholder` — всі optional
- `Input` props: `label`, `errorMessage`, `hint`, `leftElement`, `rightElement` — всі optional

---

## 2. Security (Безпека)

### 2.1 Auth & Guards

```bash
# Контролери без @UseGuards — потенційно відкриті endpoints
grep -rn "@Controller" apps/api/src/ -l | while read f; do
  grep -L "UseGuards\|@Public" "$f"
done
```

- [ ] Кожен `@Controller` має `@UseGuards(JwtAuthGuard, RolesGuard)` або явний `@Public()`
- [ ] `@Public()` endpoints перелічені і обґрунтовані (тільки: `/auth/login`, `/auth/refresh`, `/setup/*`, `/health`)
- [ ] `/setup/init` — перевіряє `isAlreadyInitialized()` перед виконанням (anti-replay)
- [ ] `@Roles(...)` присутній на кожному методі або контролері — не покладатись тільки на JwtAuthGuard
- [ ] `@CurrentUser()` декоратор повертає `{ sub: string; orgId: string; role: string }` — не `any`

### 2.2 Tenant Isolation (Multi-tenancy)

```bash
# findUnique без orgId — потенційний cross-tenant доступ
grep -rn "findUnique\|findFirst\|findMany\|update\|delete" apps/api/src/modules/ --include="*.ts" \
  | grep -v "orgId" | grep -v "spec.ts" | grep -v "//.*find"
```

- [ ] **Кожен** `findFirst` / `findMany` / `update` / `delete` на бізнес-сутностях містить `orgId` у `where`
- [ ] Параметри з URL (`@Param('id')`) ніколи не використовуються без перевірки приналежності до `orgId`
- [ ] FK у sync push (`customerGarageId`, `liftId`, `employeeId`, `workOrderId`) перевіряються через `validateForeignKeys(orgId, ...)`
- [ ] Пагінація: `page` і `limit` з query params мають верхні межі (limit ≤ 200, page ≥ 1)

### 2.3 Injection & Input Validation

```bash
# Прямий SQL
grep -rn "queryRaw\|executeRaw\|\$queryRaw" apps/api/src/ --include="*.ts" | grep -v "plainto_tsquery"

# eval / Function constructor
grep -rn "eval(" apps/api/src/ apps/web/src/ --include="*.ts" --include="*.tsx"

# process.env прямо в сервісах (має бути через ConfigService)
grep -rn "process\.env\." apps/api/src/ --include="*.ts" | grep -v "main.ts" | grep -v "spec.ts"
```

- [ ] Немає рядкової інтерполяції у `$queryRaw` — тільки `Prisma.sql` або `prisma.$queryRaw\`...\``
- [ ] Всі вхідні дані валідуються через `class-validator` DTO, не вручну
- [ ] `process.env` доступ тільки в `main.ts` та конфіг-файлах — сервіси використовують `ConfigService`
- [ ] `eval()`, `new Function()`, `child_process.exec()` — відсутні
- [ ] Файлові upload paths не конкатенуються з user input без санітизації

### 2.4 Витік чутливих даних

```bash
# Поля які не мають потрапляти у response
grep -rn "passwordHash\|password\b\|apiKey\|secret\b" apps/api/src/modules/ --include="*.dto.ts"

# Password в Swagger
grep -rn "password\|hash" apps/api/src/modules/ --include="*.dto.ts" | grep "ApiProperty"
```

- [ ] `passwordHash`, `apiKey`, `secret` відсутні у `*ResponseDto` — тільки у `CreateDto` якщо треба
- [ ] `phone`, `edrpou`, `email` відфільтровані у sync pull payload (PULL_FIELD_BLACKLIST)
- [ ] `SetupInitDto.password` — поле присутнє в Swagger, але endpoint `@Public()` і одноразовий
- [ ] Rate та `rateScheme` з `Employee` не потрапляють у публічні endpoint

### 2.5 BullMQ Queue Safety

```bash
# Queue .add() без attempts/backoff
grep -rn "\.add(" apps/api/src/ --include="*.ts" | grep -v "attempts"
```

- [ ] **Кожен** `.add()` має `attempts ≥ 10` і `backoff: { type: 'exponential' }`
- [ ] ПРРО (Checkbox) черга: `attempts: 288` (24 год), `backoff: { delay: 300_000 }`
- [ ] SMS черга: `attempts: 10`, `backoff: { delay: 60_000 }`
- [ ] Процесори черги мають `try/catch` — помилки логуються і прокидаються далі (щоб BullMQ retry спрацював)
- [ ] Ніяких прямих HTTP-викликів до зовнішніх API поза чергою (SMS, ПРРО, постачальники)

---

## 3. Memory Leaks (Витоки пам'яті)

### 3.1 Frontend — React Hooks

```bash
# useEffect без cleanup
grep -rn "addEventListener\|setInterval\|setTimeout\|subscribe\|on(" \
  apps/web/src/ --include="*.tsx" --include="*.ts" -l
```

**Патерни які ВИМАГАЮТЬ cleanup у `return () => {}`:**

| Патерн | Без cleanup | З cleanup |
|---|---|---|
| `addEventListener` | витік listener | `return () => el.removeEventListener(...)` |
| `setInterval` | таймер продовжує після unmount | `return () => clearInterval(id)` |
| `setTimeout` | може оновити стан unmounted компоненту | `return () => clearTimeout(id)` |
| `EventEmitter.on` | listener накопичуються | `return () => emitter.off(...)` |
| AbortController відсутній на fetch | fetch продовжується після unmount | `const ac = new AbortController(); fetch(url, { signal: ac.signal }); return () => ac.abort()` |

```typescript
// ❌ BAD — listener висить після unmount
useEffect(() => {
  window.addEventListener('resize', handler);
}, []);

// ✅ GOOD
useEffect(() => {
  window.addEventListener('resize', handler);
  return () => window.removeEventListener('resize', handler);
}, []);

// ❌ BAD — fetch без AbortController
useEffect(() => {
  apiFetch('/data').then(setData);
}, [id]);

// ✅ GOOD — cancel inflight request on id change or unmount
useEffect(() => {
  const ac = new AbortController();
  apiFetch('/data', { signal: ac.signal }).then(setData).catch(() => {});
  return () => ac.abort();
}, [id]);
```

- [ ] Кожен `useEffect` з `addEventListener` має `return () => removeEventListener`
- [ ] Кожен `useEffect` з `setInterval` має `return () => clearInterval`
- [ ] `useEffect` з `apiFetch` при залежності від `id`/`page` — має AbortController або ignore-flag
- [ ] Стани не оновлюються після unmount (`isMounted` ref або AbortController)
- [ ] `useCallback` і `useMemo` не пропущені для функцій що передаються у дочірні компоненти з великим ре-рендером

### 3.2 Frontend — Стан і ре-рендери

```bash
# Глобальний saving замість per-row (всі кнопки входять у loading одночасно)
grep -rn "saving\b" apps/web/src/app/ --include="*.tsx" | grep "useState(false)"
```

- [ ] `saving: boolean` у таблицях замінено на `savingId: string | null` — по одному рядку
- [ ] `loading` ініціалізується `true` якщо дані завантажуються одразу при mount (не `false`)
- [ ] `error` сторінки не перезаписується помилками завантаження форм — окремий `formError`
- [ ] Немає об'єктів/масивів що створюються inline в JSX як пропи → кожен ре-рендер створює нову референцію

### 3.3 Backend — NestJS / Node.js

```bash
# Потенційні circular references в includes
grep -rn "include:.*include:" apps/api/src/ --include="*.ts" | grep -v "spec"
```

- [ ] Prisma `include` не утворює циклічних зв'язків (A → B → A) — може спричинити stack overflow
- [ ] `@InjectQueue` черги — не зберігаються як великі масиви в пам'яті між запитами
- [ ] Event emitters (`EventEmitter2`) — listeners реєструються один раз (у `onModuleInit`), не в кожному request handler
- [ ] Великі `findMany` без `take` ліміту — потенційно тягнуть усю таблицю в RAM
  ```bash
  grep -rn "findMany(" apps/api/src/ --include="*.ts" | grep -v "take:" | grep -v "spec"
  ```
- [ ] `Buffer.alloc` / `Buffer.from` у циклах — звільняються після використання
- [ ] MinIO / файлові потоки закриваються після читання (`stream.destroy()` у catch)

### 3.4 Backend — Database Connections

- [ ] Prisma `$transaction` не тримається відкритим довше 5 секунд (timeout)
- [ ] `prisma.$disconnect()` у тестах після кожного suite
- [ ] Немає `new PrismaClient()` поза `PrismaService` — singleton через DI

---

## 4. Architecture & Patterns

- [ ] Структура модуля: `{domain}.module.ts`, `{domain}.controller.ts`, `{domain}.service.ts`, `{domain}.dto.ts`
- [ ] Controller: тільки HTTP layer — ніяких Prisma викликів, бізнес-логіки, `if/else` умов
- [ ] Service: вся бізнес-логіка + Prisma — ніякого `req`, `res`, HTTP-специфіки
- [ ] `toResponseDto()` / `toDto()` присутній — жоден Prisma об'єкт не повертається напряму
- [ ] Нові Prisma моделі мають всі sync-ready поля: `id` (UUID), `orgId`, `createdAt`, `updatedAt`, `deletedAt`, `syncVersion`
- [ ] Модуль зареєстрований у `app.module.ts`

```typescript
// ❌ BAD — бізнес-логіка в контролері
@Post() async create(@Body() dto) {
  const count = await this.prisma.workOrder.count();
  return this.service.create(dto);
}

// ✅ GOOD — тонкий контролер
@Post()
create(@OrgContext() orgId: string, @Body() dto: CreateWorkOrderDto) {
  return this.service.create(orgId, dto);
}
```

---

## 5. Business Rules

- [ ] WorkOrder FSM: переходи тільки через `WORK_ORDER_TRANSITIONS` map — ніяких прямих записів статусу
- [ ] Stock: тільки через `InventoryService.createMovement()` — ніяких `prisma.stockItem.update()`
- [ ] Settlement: тільки через `SettlementsService.createTransaction()` — ніяких `prisma.settlementAccount.update()`
- [ ] `transition()` читає і пише у межах `prisma.$transaction` — захист від race condition
- [ ] При WO → `IN_PROGRESS`: RESERVATION рухи для всіх запчастин
- [ ] При WO → `COMPLETED`: WRITEOFF + RESERVATION_RELEASE + CHARGE settlement — все в одній транзакції
- [ ] При WO → `CANCELLED` зі статусу `IN_PROGRESS`/`ON_HOLD`: RESERVATION_RELEASE
- [ ] `RESERVATION_RELEASE`: перевіряє `reserved >= Math.abs(qty)` — запобігає від'ємному резерву
- [ ] Invoice cross-reference: `inv.workOrderId === dto.workOrderId` — запобігає підміні документів
- [ ] Soft delete скрізь — `deletedAt: null` у всіх `where`
- [ ] **Виключення без `deletedAt`**: `SettlementAccount`, `SettlementTransaction`, `StockMovement`, `Payment`, `WorkOrderLineEmployee`

---

## 6. Database

```bash
# N+1 — findMany без include, з подальшим циклом
grep -rn "for.*of\|forEach\|map(" apps/api/src/modules/ --include="*.ts" | grep -v "spec" | grep -v ".dto."
# Потім вручну перевір чи є prisma виклик всередині циклу

# findMany без take — потенційно тягне всю таблицю
grep -rn "findMany(" apps/api/src/ --include="*.ts" | grep -v "take:" | grep -v "spec"
```

- [ ] Немає N+1 запитів — `include` або окремий `findMany` з `in` замість циклу
- [ ] `findMany` завжди має `take` ліміт
- [ ] `prisma.$transaction` при зміні ≥ 2 таблиць
- [ ] Indexes для FK і частих фільтрів (`orgId`, `status`, `deletedAt`)
- [ ] `@unique` де бізнес вимагає (StockItem: `orgId + goodId + warehouseId`)
- [ ] Ніяких `prisma.X.delete()` на бізнес-сутностях

```typescript
// ❌ BAD — N+1
const orders = await this.prisma.workOrder.findMany({ where: { orgId } });
for (const o of orders) {
  const v = await this.prisma.vehicle.findUnique({ where: { id: o.vehicleId } });
}

// ✅ GOOD
const orders = await this.prisma.workOrder.findMany({
  where: { orgId },
  include: { vehicle: { select: { make: true, model: true, licensePlate: true } } },
  take: 50,
});
```

---

## 7. Performance

### 7.1 Backend

```bash
# Blocking sync у async context
grep -rn "readFileSync\|writeFileSync\|existsSync" apps/api/src/ --include="*.ts"
```

- [ ] Немає `fs.readFileSync` / `writeFileSync` в request handlers — тільки async варіанти
- [ ] Паралельні незалежні запити через `Promise.all` / `Promise.allSettled` — не sequential `await`
- [ ] Важкі операції (генерація PDF, масовий import) — в BullMQ, не в request handler
- [ ] `SELECT *` через відсутній `select` у Prisma — явно вказуй потрібні поля

```typescript
// ❌ BAD — sequential (2x повільніше)
const supplier = await this.prisma.counterparty.findFirst(...);
const warehouse = await this.prisma.warehouse.findFirst(...);

// ✅ GOOD — parallel
const [supplier, warehouse] = await Promise.all([
  this.prisma.counterparty.findFirst(...),
  this.prisma.warehouse.findFirst(...),
]);
```

### 7.2 Frontend

```bash
# Date/time у render path (SSR hydration mismatch)
grep -rn "new Date()\|toLocaleDateString\|toLocaleTimeString" apps/web/src/app/ --include="*.tsx" | grep -v "useEffect"

# Inline об'єкти/масиви як пропи (нова референція на кожен рендер)
grep -rn "={{" apps/web/src/app/ --include="*.tsx" | grep -v "className\|style\|data-"
```

- [ ] `new Date().toLocaleDateString(...)` у render path → перенести у `useEffect` + `useState('')`
- [ ] `new Intl.DateTimeFormat(...)` для timezone → `useEffect` (SSR не знає timezone клієнта)
- [ ] `createPortal(…, document.body)` — є `mounted` guard (`useEffect(() => setMounted(true), [])`)
- [ ] Важкі обчислення у render → `useMemo` з правильним dep array
- [ ] Немає `console.log` у production коді

---

## 8. Web Frontend

### 8.1 API Calls

```bash
# Прямі fetch без apiFetch
grep -rn "fetch(" apps/web/src/ --include="*.tsx" --include="*.ts" | grep -v "apiFetch\|api-client\|auth/context\|spec"
```

- [ ] Всі API виклики через `apiFetch` (не прямий `fetch`) — забезпечує auto token refresh
- [ ] Немає `axios` або `XMLHttpRequest`

### 8.2 UI Стани

- [ ] Кожна сторінка з async даними: `loading` стан (`<PageSpinner />` або skeleton)
- [ ] Кожна сторінка: `error` стан з повідомленням
- [ ] Кожна сторінка: `empty` стан (`<EmptyState />`)
- [ ] `loading` ініціалізується `true` якщо дані завантажуються при mount
- [ ] Форм data load errors → `formError` (не перезаписує page-level `error`)
- [ ] Per-row actions → `savingId: string | null` (не глобальний `saving: boolean`)

### 8.3 Hydration Safety (SSR)

```bash
grep -rn "new Date()\|localStorage\|sessionStorage\|window\.\|document\." \
  apps/web/src/ --include="*.tsx" --include="*.ts" | grep -v "useEffect\|'use client'\|spec"
```

- [ ] `localStorage` / `sessionStorage` / `window.*` / `document.*` — тільки всередині `useEffect` або у `'use client'` компонентах
- [ ] `new Date()` у render → `useEffect` + `useState('')`
- [ ] `createPortal` → `mounted` guard

### 8.4 Routing & Auth

- [ ] Захищені сторінки мають `useRequireAuth(roles)` або redirect
- [ ] `/setup` доступний без авторизації
- [ ] `/setup` має окремий `layout.tsx` без `AuthProvider`/`TopShell` (щоб уникнути circular redirect)

---

## 9. Sync Readiness

```bash
# Моделі без syncVersion
grep -rn "model " packages/database/prisma/schema.prisma | grep -v "//"
# Потім перевір кожну модель на syncVersion
```

- [ ] `syncVersion` інкрементується у Prisma middleware — ніяких ручних записів
- [ ] Нові таблиці включені у `PULL_TABLES` або обґрунтовано виключені
- [ ] Push-безпечні таблиці додані до `PUSH_SAFE_TABLES` + `PUSH_FIELD_WHITELIST`
- [ ] Blacklist PII полів у `PULL_FIELD_BLACKLIST` (phone, edrpou, email)
- [ ] Append-only таблиці (`StockMovement`, `SettlementTransaction`) — ніколи не оновлюються і не видаляються

---

## 10. Offline-First

- [ ] Зовнішні API (SMS, ПРРО, постачальники) — тільки через BullMQ — ніяких прямих HTTP
- [ ] Черга працює на локальному Redis — offline не ламає бізнес-функції
- [ ] Retry при відновленні інтернету відбувається автоматично (BullMQ backoff)
- [ ] Конфігурація (терміни, ліміти, шаблони) читається з БД через `SettingsService.get(orgId)` — не hardcode

---

## 11. Tests

```bash
# Сервіси без spec файлів
find apps/api/src/modules -name "*.service.ts" | while read f; do
  spec="${f%.service.ts}.spec.ts"
  [ ! -f "$spec" ] && echo "MISSING TEST: $spec"
done
```

- [ ] `.spec.ts` існує для кожного сервісу
- [ ] Happy path + кожен `throw` покритий тестом
- [ ] Моки типізовані (не `as any`)
- [ ] Тести не залежать від порядку виконання
- [ ] `pnpm --filter @sto/api test --run` — всі проходять

---

## Output Format

Структуруй результат:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔍 CODE REVIEW — STO ERP
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Файлів перевірено: N
Знайдено проблем:  N (Critical: X / Important: Y / Suggestion: Z)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

### 🔴 Critical (must fix)
1. [файл:рядок] — що не так → як виправити

### 🟡 Important (should fix)
1. [файл:рядок] — що не так → як виправити

### 🔵 Suggestion (nice to have)
1. [файл:рядок] — пропозиція

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**Severity:**
- `Critical` — втрата даних, security вразливість, memory leak що падить сервіс, cross-tenant витік, фінансова помилка
- `Important` — порушення бізнес-правила, N+1 query, відсутній cleanup, неправильний стан UI
- `Suggestion` — стиль, іменування, minor UX

---

## Самовдосконалення скіла (ОБОВ'ЯЗКОВО після кожного запуску)

Після виправлення кожного знайденого бага — запитай себе:

> "Цей баг був охоплений існуючим пунктом чекліста?"

Якщо **НІ** — одразу оновити цей файл (`SKILL.md`):
1. Додати новий checklist item у відповідну секцію (§1–§11)
2. Якщо баг виявляється grep'ом — додати bash команду до секції
3. Якщо це повторюваний anti-pattern — додати приклад `❌ BAD` / `✅ GOOD`
4. Якщо специфічний для STO ERP (FSM, інвентар, sync) — у §5 Business Rules
5. Commit: `docs(skills): add <назва патерну> check to sto-review`

**Мета:** скіл має відображати реальні баги що траплялись у цьому проекті — не гіпотетичні.
