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
2. Класифікуй файли по шарах:
     api/   → §1 TS, §2 Security, §4 Architecture, §5 Business Rules, §6 DB, §7 Backend Perf, §9 Sync, §10 Offline
     web/   → §1 TS, §3 Memory, §7 Frontend Perf, §8 Web Frontend, §12 a11y, §13 i18n
     prisma → §6 DB, §9 Sync
     *.dto  → §2.3 Validation, §2.4 Data Leaks, §13 API Contract
3. Для кожного зміненого файлу — пройди тільки релевантні секції ГЛИБОКО
   Для незмінених файлів — тільки grep-команди для cross-cutting concerns
4. Кожну проблему виправляй одразу   → Edit/Write → tsc --noEmit
5. git commit -m "fix(review): ..."  → після всіх правок (БЕЗ запиту)
6. Оновити MemoryManual.md           → Останній commit + Changelog (БЕЗ запиту)
```

> Не питай дозволу на виправлення, коміт і оновлення MemoryManual.md — все виконується автоматично.
> Якщо fix потребує міграції БД або зміни публічного API — зафіксуй як CRITICAL і повідом після завершення всіх інших правок.

### Пріоритет перевірок по типу змін

| Тип зміни | Перевіряти В ПЕРШУ ЧЕРГУ |
|---|---|
| Новий `@Controller` | §2.1 Auth guards, §2.2 Tenant isolation, §13 API Contract |
| Новий `*.service.ts` | §5 Business Rules, §6 DB (N+1, take), §4 Architecture |
| Нова Prisma модель | §6 DB (indexes, unique), §9 Sync (syncVersion, PULL_TABLES) |
| Зміна `toResponseDto` | §13 API Contract (фронт-тип синхронізований?) |
| Нова `page.tsx` | §8.2 UI стани, §8.3 Hydration, §8.4 Auth, §12 a11y |
| Новий `*.dto.ts` | §2.3 Validation, §2.4 Data Leaks, §11 Configuration |
| Зміна BullMQ | §2.5 Queue Safety, §10 Offline |
| Новий UX хук (`use*.ts`) | §3.1 Memory Leaks (cleanup), §8.5 UX Features (bulk/toast/indeterminate) |
| Новий UI компонент (`components/ui/`) | §8.5 UX Features, §14 a11y, §12 Component test coverage |
| Зміна `TopShell.tsx` | §8.4 Auth guard, §8.5 useUiFeatures endpoint roles, §3.1 listeners |
| `bulkActions` / `bulkSelect` | §8.5: Promise.allSettled, stale IDs, colSpan, useMemo |

### Як оновлювати MemoryManual.md (крок 5)

Після коміту — одразу (без запиту) оновити два поля в `MemoryManual.md`:

```markdown
## Останній commit
<hash> <commit message>
Дата: YYYY-MM-DD

## Поточний стан проєкту
TypeScript: ✅ 0 errors  (або ❌ N errors)
```

Якщо під час review виявились нові gotchas або змінилась архітектура — дописати у відповідний розділ `MemoryManual.md` без запиту.

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

# Tailwind 4 — застаріла [var(--x)] форма (має бути canonical token)
grep -rn "\[var(--" apps/web/src/ --include="*.tsx" --include="*.ts"

# Tailwind 4 — (--color-X) shorthand теж не canonical, треба token (bg-primary замість bg-(--color-primary))
grep -rn "(--color-" apps/web/src/ --include="*.tsx" --include="*.ts"

# Tailwind 4 — інші shorthand токенів які мають бути canonical
grep -rnE "(rounded|shadow|text|bg|border|divide|ring)-\(--" apps/web/src/ --include="*.tsx" --include="*.ts"

# Tailwind 4 — inline HSL замість canonical semantic токенів (не перемикається в dark mode → WCAG fail)
# Винятки: badge.tsx purple, inventory reserved orange, button.tsx destructive-hover, input/select destructive focus-ring
grep -rnE "text-\[hsl\(|border-\[hsl\(|bg-\[hsl\(|ring-\[hsl\(" apps/web/src/app apps/web/src/components --include="*.tsx"

# Pixel значення замість Tailwind scale
grep -rnE "(w|h|top|left|right|bottom|max-w|min-w|p|m|gap)-\[[0-9]+px\]" apps/web/src/ --include="*.tsx"

# Tailwind 4 — незакрита квадратна дужка у arbitrary value (JIT тихо НЕ генерує клас)
# Шукає рядки де є `-[` без подальшого `]` на тому ж рядку
grep -rnE "\b[a-z:]+-\[[^]]*$" apps/web/src/ --include="*.tsx" --include="*.ts"
# Також: рядки з відкритою дужкою чий вміст не закривається до кінця токена/рядка
grep -rnE "(focus|hover|active|bg|text|border|ring|shadow|rounded|w|h|p|m|gap)-\[[^]]*[\",']" apps/web/src/ --include="*.tsx" | grep -v "\]'"

# Застарілі утиліти
grep -rn "flex-shrink-0" apps/web/src/ --include="*.tsx"

# Unused imports (dead code, не помилка TS бо noUnusedLocals=off, але засмічує)
# Для кожного імпорту з lucide-react / @/components — перевір що символ є в JSX
# Поширені винуватці після рефакторингу: ChevronRight, Button, GripVertical
grep -rnE "^import \{[^}]+\} from" apps/web/src/ --include="*.tsx" --include="*.ts" \
  | awk -F'[{},]' '{ for (i=2;i<NF;i++) if ($i ~ /^[ A-Z]/) print FILENAME":"NR":"$i }' \
  | head -50
# Альтернатива: ESLint з no-unused-vars (наразі немає в apps/web/eslint.config)

# tsconfig валідація ignoreDeprecations
grep -rn "ignoreDeprecations.*6\.0" apps/ packages/ --include="tsconfig*.json"

# Пакети без tsconfig.json — type-check мовчки ламається (tsc показує --help)
for f in packages/*/package.json apps/*/package.json; do
  dir=$(dirname "$f"); [ -f "$dir/tsconfig.json" ] || echo "MISSING tsconfig: $dir"
done
```

**Таблиця авто-фіксів:**

| Помилка | Фікс |
|---|---|
| `Cannot find namespace 'React'` / `React.ReactNode` | `import type { ReactNode } from 'react'` → використовувати `ReactNode` |
| `React.HTMLAttributes<T>` | `import type { HTMLAttributes } from 'react'` |
| `React.SVGAttributes<T>` | `import type { SVGAttributes } from 'react'` |
| `React.ChangeEvent<T>` / `React.FormEvent<T>` / `React.MouseEvent<T>` | `import type { ChangeEvent, FormEvent, MouseEvent } from 'react'` |
| `Type '"default"' is not assignable to type 'Variant'` | Додати `'default'` до Variant union у `button.tsx` |
| `Property 'placeholder' does not exist on SelectProps` | Додати `placeholder?: string`; рендерити як `<option value="" disabled>` |
| `Type 'unknown'` на Prisma dynamic select | Cast: `(result as { field: type }).field` |
| `is not assignable to type 'never'` | Додати відсутні гілки switch/union або cast |
| `Object is possibly 'null'` | Guard або non-null assertion якщо неможливо runtime |
| `TS5103: Invalid value for '--ignoreDeprecations'` | На TS 5.x використовуй `"5.0"`, не `"6.0"`. `"6.0"` стане валідним з TS 6.0 |
| `Option 'baseUrl' is deprecated` | Видалити `baseUrl` повністю — у TS 5+ `paths` працює відносно tsconfig.json |
| `The class '[var(--color-x)]' can be written as 'bg-x'` | Замінити `[var(--color-x)]` на canonical Tailwind token (див. `/sto-dev` Tailwind 4 секцію) |
| `bg-(--color-X)` / `border-(--color-X)` shorthand | Замінити на canonical token: `bg-X` / `border-X` (`bg-(--color-primary)` → `bg-primary`) |
| `shadow-(--shadow-xl)` / `rounded-(--radius)` | Canonical: `shadow-xl` / `rounded` |
| `focus:ring-[hsl(...)` без закриваючої `]` | Tailwind 4 JIT тихо ігнорує клас. Додати закриваючу `]` — обов'язково перевірити парність дужок у кожному `*-[...]` arbitrary value |
| `URL.revokeObjectURL(url)` синхронно після `a.click()` | Загорнути в `setTimeout(() => URL.revokeObjectURL(url), 100)` — Chromium іноді зриває завантаження blob якщо URL відкликаний до старту fetch |
| `findMany` без `take` ліміту | Додати `take: N` (зони/підйомники: 100, авто/співробітники: 200, slots: 500, list endpoints: 200) — інакше при N → ∞ записах піде OOM |
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

# Endpoints без @Roles — RolesGuard пропустить будь-якого авторизованого
# (особливо критично для cost/price/financial data)
grep -rln "@Get\|@Post\|@Patch\|@Delete\|@Put" apps/api/src/modules --include="*.controller.ts" \
  | while read f; do
    grep -A1 "@Get\|@Post\|@Patch\|@Delete\|@Put" "$f" | grep -L "@Roles\|@Public" >/dev/null && echo "$f"
  done
```

- [ ] Кожен `@Controller` має `@UseGuards(JwtAuthGuard, RolesGuard)` або явний `@Public()`
- [ ] `@Public()` endpoints перелічені і обґрунтовані (тільки: `/auth/login`, `/auth/refresh`, `/setup/*`, `/health`)
- [ ] `/setup/init` — перевіряє `isAlreadyInitialized()` перед виконанням (anti-replay)
- [ ] `@Roles(...)` присутній на **кожному методі або контролері** — RolesGuard БЕЗ @Roles пропускає всіх авторизованих (включаючи MECHANIC до cost даних!)
- [ ] Будь-який endpoint що повертає `costPrice`, `purchasePrice`, `salePrice`, `priceHistory`, `margin` має `@Roles('OWNER', 'ADMIN', 'STOREKEEPER'[, 'ACCOUNTANT'])` — НЕ давати MECHANIC доступу
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
- [ ] **PATCH/UPDATE з body FK полем** (`goodId`, `vehicleId`, `customerId`, ...) — валідує що FK належить тому ж `orgId`. POST зазвичай валідує, але UPDATE часто пропускає → дозволяє cross-tenant attach. Шаблон: перед `update()` робити `findFirst({ id: dto.goodId, orgId })` і `throw NotFoundException`.
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
- [ ] `@Query('xxxId')` / `@Param('xxxId')` що очікують UUID — обгорнути `ParseUUIDPipe()` (або `new ParseUUIDPipe({ optional: true })` для optional). Без нього невалідний UUID → Prisma P2023 → HTTP 500 замість 400. Не використовуй `version: '4'` явно — тести часто використовують UUIDs з версією 0.

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

# Прямі HTTP до зовнішніх API поза чергою
grep -rn "axios\|node-fetch\|https\.request\|http\.request" apps/api/src/modules/ --include="*.ts" | grep -v "spec\|queue\|processor"
```

- [ ] **Кожен** `.add()` має `attempts ≥ 10` і `backoff: { type: 'exponential' }`
- [ ] ПРРО (Checkbox) черга: `attempts: 288` (24 год), `backoff: { delay: 300_000 }`
- [ ] SMS черга: `attempts: 10`, `backoff: { delay: 60_000 }`
- [ ] Процесори черги мають `try/catch` — помилки логуються і прокидаються далі (щоб BullMQ retry спрацював)
- [ ] Ніяких прямих HTTP-викликів до зовнішніх API поза чергою (SMS, ПРРО, постачальники)

### 2.6 JWT & Token Security

```bash
# Hardcoded секрети або дефолтні значення
grep -rn "secret.*:.*['\"].*['\"]" apps/api/src/ --include="*.ts" | grep -v "spec\|config"
grep -rn "JWT_SECRET\|ACCESS_SECRET\|REFRESH_SECRET" apps/api/src/ --include="*.ts" | grep -v "ConfigService\|config()"

# refresh token зберігається в httpOnly cookie?
grep -rn "refreshToken\|refresh_token" apps/api/src/ --include="*.ts" | grep -v "spec"
```

- [ ] JWT секрети читаються тільки через `ConfigService` — не `process.env` напряму
- [ ] Access token короткоживучий (≤ 15хв у prod) — перевір `expiresIn` у конфіг-файлі
- [ ] Refresh token зберігається в httpOnly cookie або у SecureStore (mobile), НЕ у localStorage
- [ ] При logout — refresh token інвалідується (видаляється з whitelist або blacklist)
- [ ] `@Public()` не застосований до endpoint що повертає чутливі дані

### 2.7 Rate Limiting & DoS

```bash
# Endpoint без throttle guard
grep -rn "@Controller" apps/api/src/ -l | xargs grep -L "Throttle\|SkipThrottle" 2>/dev/null | head -10
```

- [ ] `ThrottlerModule` налаштований у `app.module.ts`
- [ ] Auth endpoints (`/auth/login`, `/auth/refresh`) мають суворіший throttle (≤ 5 req/хв)
- [ ] Публічні endpoints (`/setup/*`) мають throttle
- [ ] `@SkipThrottle()` використовується тільки для внутрішніх health-check endpoints

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
- [ ] **Dead useEffect listeners (no-op `() => {}` handler)** — видаляти повністю; виглядає невинно, але алокує DOM-listener і плутає reviewer. Шукати: `addEventListener\([^,]+,\s*\(\)\s*=>\s*\{\s*\}\s*\)`.
- [ ] **Імперативне оновлення DOM-property (`indeterminate`, `selectionStart`, ...) через інлайн `ref={el => ...}` callback** — працює в React 19 (новий identity callback re-fires), але крихко (React Compiler / memo можуть стабілізувати identity). Канон: `useRef` + `useEffect([dep])`:
  ```typescript
  // ❌ FRAGILE — relies on React re-invoking inline ref callbacks
  <input ref={el => { if (el) el.indeterminate = someSelected; }} />

  // ✅ STABLE
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = someSelected; }, [someSelected]);
  <input ref={ref} />
  ```
- [ ] `useEffect` з `apiFetch` при залежності від `id`/`page` — має AbortController або ignore-flag
- [ ] `useEffect` з `apiFetch` і `[]` deps (mount-only) на сторінках з навігацією — **теж** потребує `let cancelled = false; ... if (!cancelled) setX(...); return () => { cancelled = true }` бо користувач може покинути сторінку до завершення Promise (dashboard, settings, list pages)
- [ ] Стани не оновлюються після unmount (`isMounted` ref або AbortController)
- [ ] **mountedRef consistency**: коли в компоненті є `mountedRef` guard на `load()` — застосовуй ТОЙ САМИЙ guard у ВСІХ async handlers (`createX`, `updateX`, `deleteX`, `applyX`). Часткове застосування (тільки в `load`) — анти-патерн: навігація під час in-flight CRUD усе одно викличе setState на unmounted. Шаблон: кожен `setX(...)` після `await apiFetch(...)` обгортати в `if (mountedRef.current) setX(...)`.
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
- [ ] Нові sync-ready моделі додані у `sync.service.ts` `PULL_TABLES` (інакше mobile clients не отримають)
- [ ] Модуль зареєстрований у `app.module.ts`
- [ ] **List endpoint завжди повертає `{ items, total, page?, limit? }`** — не bare array. Frontend всюди очікує `data.items.length`; bare array крашне з `TypeError: Cannot read properties of undefined`. Якщо `take` фіксований (≤500) — все одно обгортай у `{ items, total }`. Перевірка:
  ```bash
  grep -rn "async findAll\|Promise<.*\[\]>" apps/api/src/modules/ --include="*.service.ts" | grep -v "ResponseDto\[\]\|Dto\[\]>" | head
  # Кожен findAll має повертати Paginated*Dto, не голий масив
  ```
- [ ] **Cross-service auto-side-effects обробляються БЕЗ swallow-all**: `.catch(() => {})` ховає реальні баги (auto-invoice не створюється, schedule не оновлюється). Шаблон: `.catch(e => { if (!msg.includes('очікувана_бізнес_помилка')) logger.warn(...) })`
- [ ] **Auto-FSM-transition у cross-service tx — re-read entity всередині tx + явна перевірка status**: ❌ `tx.workOrder.update({ status: 'INVOICED' })` після читання поза tx → race + FSM bypass. ✅ Read entity in tx → check `status === expected` → update.

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

### 4.1 Circular DI та Event Loop

```bash
# Сервіси що інжектують один одного (circular DI)
grep -rn "constructor(" apps/api/src/modules/ --include="*.service.ts" -A 10 | grep "Service"
# Якщо A інжектує B, а B інжектує A — circular DI → NestJS кине помилку або зависне

# EventEmitter listeners в request handlers (не в onModuleInit)
grep -rn "this\.events\.on\|this\.eventEmitter\.on" apps/api/src/modules/ --include="*.service.ts" | grep -v "onModuleInit\|constructor"
```

- [ ] Немає circular DI — якщо треба двонаправлена залежність, використовуй `forwardRef(() => ServiceB)`
- [ ] `EventEmitter2.on()` викликається тільки в `onModuleInit()` або `constructor` — не в request handler
- [ ] `@OnEvent('...')` декоратор замість ручного `.on()` — NestJS прибирає listener автоматично
- [ ] Сервіси не зберігають стан між запитами (`private data: X[]` що накопичується) — для стану між запитами Redis/DB

### 4.2 Error Handling

```bash
# Необроблені Promise rejections у fire-and-forget
grep -rn "\.emit(\|this\.events\.emit(" apps/api/src/modules/ --include="*.service.ts" | grep -v "await\|\.catch("
```

- [ ] `this.events.emit(...)` — якщо listener async, виняток не прокидається до caller. Критична логіка не йде через EventEmitter
- [ ] Fire-and-forget задачі (`.add()` до черги) мають `.catch(this.logger.error)` якщо черга недоступна
- [ ] `try/catch` у BullMQ processors — прокидає помилку далі (`throw err`), щоб BullMQ зробив retry
- [ ] `HttpException` фільтр зареєстрований глобально — некеровані помилки не повертають stack trace клієнту

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
- [ ] **Виключення без `deletedAt`**: `SettlementAccount`, `SettlementTransaction`, `StockMovement`, `StockBatch`, `BatchConsumption`, `PriceHistory`, `Payment`, `WorkOrderLineEmployee`
- [ ] `SettlementsService.createTransaction` — internal `amount > 0 && Number.isFinite(amount)` guard (defense-in-depth, окрім DTO `@Min`)
- [ ] `URL.createObjectURL` на frontend — обов'язково `URL.revokeObjectURL(url)` через setTimeout після click
  ```bash
  grep -rn "URL.createObjectURL" apps/web/src --include="*.tsx"
  ```

### 5.1 Algorithm Correctness (Pricing, Batches, Totals)

> Перевіряти при будь-якій зміні `pricing.service.ts`, `batch.service.ts`, `work-orders.service.ts` або `inventory.service.ts`.

#### Pricing formulas (`pricing.service.ts` → `calculateSalePrice`)

```bash
grep -n "PERCENT\|FIXED_AMOUNT\|FIXED_PRICE\|COMPETITOR_PLUS\|roundTo\|Math.max\|Math.round" \
  apps/api/src/modules/inventory/pricing.service.ts
```

- [ ] `PERCENT`: `result = costPrice * (1 + percentValue / 100)` — не `costPrice + percentValue / 100`
- [ ] `FIXED_AMOUNT`: `result = costPrice + fixedAmount` — не `costPrice * fixedAmount`
- [ ] `FIXED_PRICE`: `result = fixedPrice ?? costPrice` — якщо `fixedPrice` відсутній → fallback на `costPrice`, не `0`
- [ ] `COMPETITOR_PLUS`: використовує competitorPrice як базу, не costPrice
- [ ] Округлення: `Math.round(result / r) * r` — саме `round`, не `ceil` / `floor`
- [ ] Floor guard обов'язковий: `return Math.max(0, result)` — ціна не може бути від'ємною
- [ ] `Number(rule.percentValue ?? 0)` — явний cast з `?? 0` захисником від `null` Decimal

```typescript
// ❌ BAD — percentValue як Decimal без cast → NaN у результаті
result = costPrice * (1 + rule.percentValue / 100);

// ✅ GOOD
result = costPrice * (1 + Number(rule.percentValue ?? 0) / 100);
```

#### Batch cost methods (`batch.service.ts` → `consumeBatch`)

```bash
grep -n "FIFO\|FEFO\|LIFO\|AVG_COST\|orderBy\|expiryDate\|createdAt\|remainingQty\|totalCost" \
  apps/api/src/modules/inventory/batch.service.ts
```

- [ ] FIFO: `orderBy: [{ createdAt: 'asc' }]` — старіші партії списуються першими
- [ ] LIFO: `orderBy: [{ createdAt: 'desc' }]` — новіші першими
- [ ] FEFO: `orderBy: [{ expiryDate: 'asc', nulls: 'last' }, { createdAt: 'asc' }]` — без `nulls: 'last'` товари без терміну придатності йдуть першими (КРИТИЧНИЙ баг для харчових/фармо товарів)
- [ ] AVG_COST формула: `totalCost / totalQty` де `totalCost = SUM(batch.remainingQty * batch.costPrice)` і `totalQty = SUM(batch.remainingQty)` — не просте середнє `SUM(costPrice) / count`
- [ ] Цикл списання: `const take = Math.min(remaining, batch.remainingQty)` — не перевищує доступний залишок батча
- [ ] Після циклу: `remaining === 0` (все списано) — якщо `remaining > 0` після всіх батчів → `throw BadRequestException`
- [ ] `BatchConsumption.create()` викликається для кожного батча, не тільки для першого

```typescript
// ❌ BAD — просте середнє ціни (неправильно при різних залишках)
const avgCost = batches.reduce((sum, b) => sum + Number(b.costPrice), 0) / batches.length;

// ✅ GOOD — зважене середнє
const totalCost = batches.reduce((sum, b) => sum + b.remainingQty * Number(b.costPrice), 0);
const totalQty  = batches.reduce((sum, b) => sum + b.remainingQty, 0);
const avgCost   = totalQty > 0 ? totalCost / totalQty : 0;
```

#### WorkOrder totals (`work-orders.service.ts` → `recalcTotals`)

```bash
grep -n "recalcTotals\|totalLabor\|totalParts\|totalAmount\|normoHours\|amount" \
  apps/api/src/modules/work-orders/work-orders.service.ts
```

- [ ] Рядок роботи: `amount = normoHours * price` (не `price` окремо)
- [ ] Запчастина: `amount = quantity * price`
- [ ] `totalLabor = SUM(lines.amount)` — тільки рядки робіт
- [ ] `totalParts = SUM(parts.amount)` — тільки запчастини
- [ ] `totalAmount = totalLabor + totalParts` — не `SUM(всіх amount разом)`
- [ ] `Number(l.amount)` cast — `amount` у Prisma зберігається як `Decimal`, без cast дасть конкатенацію рядків

```typescript
// ❌ BAD — amount Decimal без cast → "10.0020.00" замість 30
const totalLabor = lines.reduce((s, l) => s + l.amount, 0);

// ✅ GOOD
const totalLabor = lines.reduce((s, l) => s + Number(l.amount), 0);
```

#### PriceHistory trigger (`pricing.service.ts` або `goods.service.ts`)

```bash
grep -n "PriceHistory\|priceHistory\|priceChanged\|salePrice" \
  apps/api/src/modules/inventory/pricing.service.ts \
  apps/api/src/modules/goods/goods.service.ts
```

- [ ] `PriceHistory.create()` викликається **тільки** коли нова ціна відрізняється від поточної `good.salePrice` — не при кожному розрахунку
- [ ] Порівняння: `Math.abs(newPrice - Number(good.salePrice)) > 0.001` — floating point safe comparison

---

## 6. Database

```bash
# N+1 — findMany без include, з подальшим циклом
grep -rn "for.*of\|forEach\|map(" apps/api/src/modules/ --include="*.ts" | grep -v "spec" | grep -v ".dto."
# Потім вручну перевір чи є prisma виклик всередині циклу

# findMany без take — потенційно тягне всю таблицю
grep -rn "findMany(" apps/api/src/ --include="*.ts" | grep -v "take:" | grep -v "spec"

# include з relation що приймає take (lines/parts/movements/transactions) — без take
grep -rnE "(lines|parts|movements|transactions): \{ where: \{ deletedAt: null \}, include:" apps/api/src --include="*.ts" | grep -v "take:"

# $queryRaw / $executeRaw — повинні мати LIMIT N у SQL
grep -rn "queryRaw\|executeRaw" apps/api/src --include="*.ts" | grep -v "spec\|plainto_tsquery"
# Для кожного — Read файл і перевір що SQL завершується LIMIT N

# КРИТИЧНО: Raw SQL identifier casing — Prisma schema без @map → camelCase з лапками.
# Snake_case identifiers НЕ ПРАЦЮЮТЬ: Postgres folds unquoted до lowercase,
# не знайде "orgId" коли пишеш org_id. Endpoint крашиться з HTTP 500.
grep -rn "queryRaw\|executeRaw" apps/api/src --include="*.ts" -A 30 \
  | grep -E "org_id|deleted_at|created_at|updated_at|good_id|warehouse_id|min_stock|current_seq|reset_period|last_reset|include_date|document_type"
# Якщо знаходить snake_case у raw SQL — це CRITICAL bug.
# Перевір реальні колонки: docker exec stoerp-postgres-1 psql -U sto -d sto_erp -c "\d <table>"
```

- [ ] Немає N+1 запитів — `include` або окремий `findMany` з `in` замість циклу
- [ ] `findMany` завжди має `take` ліміт
- [ ] **Виключення з вимоги `take`** (допустимі без ліміту):
  - FK-валідація: `where: { id: { in: dtoArray.map(...) } }` — ліміт задає DTO довжина
- [ ] Запити за конкретним батьком (`workOrderId`, `purchaseOrderId`, `parentId`) — **все одно додавати `take: 1000`** як safety guard проти корумпованих/тестових даних. "Теоретично ≤ 100" не захищає від реального OOM.
- [ ] `prisma.$transaction` при зміні ≥ 2 таблиць
- [ ] Indexes для FK і частих фільтрів (`orgId`, `status`, `deletedAt`)
- [ ] `@unique` де бізнес вимагає (StockItem: `orgId + goodId + warehouseId`)
- [ ] Ніяких `prisma.X.delete()` на бізнес-сутностях

### 6.1 select vs include — зайвий SELECT *

```bash
# include без select — тягне всі поля зв'язаної моделі
grep -rn "include:" apps/api/src/modules/ --include="*.ts" | grep -v "select:\|spec\|take:" | head -20
# Для кожного — перевір чи вся модель потрібна або можна додати select: { id, name, ... }
```

- [ ] `include: { vehicle: true }` → `include: { vehicle: { select: { make, model, licensePlate } } }` — не тягнути зайві поля
- [ ] Список endpoints (`findAll`) — мінімальний `select`, деталі тільки у `findOne`
- [ ] `include` вкладеного рівня (A → B → C) — завжди з `select` на кожному рівні

```typescript
// ❌ BAD — тягне всі поля Vehicle + всі поля CustomerGarage + Counterparty
include: { vehicle: { include: { customerGarage: true } } }

// ✅ GOOD
include: {
  vehicle: { select: { make: true, model: true, licensePlate: true, year: true } },
}
```

### 6.2 Нові FK поля — перевірка індексів

```bash
# FK поля без @@index в schema
grep -rn "@db.Uuid" packages/database/prisma/schema.prisma | grep -v "id\s" | grep -v "@@index\|@@unique"
# Після grep — відкрий schema і перевір @@index для кожного нового FK поля
```

- [ ] Кожне нове FK поле (`xyzId String @db.Uuid`) має `@@index([orgId, xyzId])` або включене в існуючий індекс
- [ ] `@@index([orgId, syncVersion])` присутній для кожної sync-ready таблиці (для delta-sync queries)
- [ ] `@@index([orgId, deletedAt])` присутній для кожної таблиці з soft delete

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

```typescript
// ❌ BAD — bulk-recalc що викликає `calculateSalePrice` в loop (N+1 на rules)
async applyRuleToGoods(orgId: string, ruleId: string): Promise<number> {
  const goods = await this.prisma.good.findMany({ where: {...}, take: 5000 });
  for (const good of goods) {
    // Кожен виклик робить ще один findMany на pricingRule → 5000 × findMany
    const newPrice = await this.calculateSalePrice(orgId, good.id, ...);
    await this.prisma.good.update({ where: { id: good.id }, data: { salePrice: newPrice } });
    await this.prisma.priceHistory.create({ data: {...} });
  }
}

// ✅ GOOD — prefetch + in-memory compute + chunked $transaction
async applyRuleToGoods(orgId: string, ruleId: string): Promise<number> {
  const goods = await this.prisma.good.findMany({ where: {...}, take: 5000 });
  const allRules = await this.prisma.pricingRule.findMany({
    where: { orgId, isActive: true, deletedAt: null }, take: 200,
  });
  const updates = goods
    .map(g => ({ goodId: g.id, newPrice: this.computeInMemory(allRules, g, ...) }))
    .filter(u => priceChanged(u));
  const CHUNK = 100;
  for (let i = 0; i < updates.length; i += CHUNK) {
    const chunk = updates.slice(i, i + CHUNK);
    await this.prisma.$transaction([
      ...chunk.map(u => this.prisma.good.update({ where: { id: u.goodId }, data: { salePrice: u.newPrice } })),
      this.prisma.priceHistory.createMany({ data: chunk.map(u => ({...})) }),
    ]);
  }
  return updates.length;
}
```

```typescript
// ❌ BAD — рекурсивний findMany по дереву (N+1, без take)
private async getDescendantIds(orgId: string, parentId: string): Promise<string[]> {
  const children = await this.prisma.workCategory.findMany({
    where: { parentId, orgId, deletedAt: null },
    select: { id: true },
  });
  const nested = await Promise.all(children.map(c => this.getDescendantIds(orgId, c.id)));
  return [...children.map(c => c.id), ...nested.flat()];
}

// ✅ GOOD — один запит + in-memory walk
private async getDescendantIds(orgId: string, parentId: string): Promise<string[]> {
  const all = await this.prisma.workCategory.findMany({
    where: { orgId, deletedAt: null },
    select: { id: true, parentId: true },
    take: 1000,
  });
  const childrenByParent = new Map<string, string[]>();
  for (const c of all) {
    if (!c.parentId) continue;
    (childrenByParent.get(c.parentId) ?? childrenByParent.set(c.parentId, []).get(c.parentId)!).push(c.id);
  }
  const result: string[] = []; const stack = [parentId];
  while (stack.length) {
    const children = childrenByParent.get(stack.pop()!) ?? [];
    result.push(...children); stack.push(...children);
  }
  return result;
}
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
- [ ] **`useState(new Date())` або `useState(() => new Date()...)` теж заборонено** — lazy initializer виконується І на server, І на client з різним часом → hydration mismatch. Шаблон: `useState('')` + `useEffect(() => { setX(new Date()...) }, [])`
  ```typescript
  // ❌ BAD — server: 2026-05-24 (UTC), client: 2026-05-25 (Kyiv)
  const [date, setDate] = useState(toDateString(new Date()));

  // ✅ GOOD
  const [date, setDate] = useState('');
  useEffect(() => { setDate(toDateString(new Date())); }, []);
  ```
- [ ] `createPortal` → `mounted` guard

### 8.4 Routing & Auth

- [ ] Захищені сторінки мають `useRequireAuth(roles)` або redirect
- [ ] `/setup` доступний без авторизації
- [ ] `/setup` має окремий `layout.tsx` без `AuthProvider`/`TopShell` (щоб уникнути circular redirect)

### 8.5 UX Features System

```bash
# toast без перевірки features.toastEnabled (може бути вимкнено)
grep -rn "toast\." apps/web/src/app/ apps/web/src/components/ --include="*.tsx" \
  | grep -v "features\.toastEnabled\|// toast\|ToastContainer\|useNotif"

# Promise.all для bulk-мутацій — має бути Promise.allSettled
grep -rn "Promise\.all(" apps/web/src/ --include="*.tsx" --include="*.ts" \
  | grep -i "bulk\|transition\|map.*apiFetch" | grep -v "allSettled"

# useBulkSelect без очищення при зміні items
# (перевірити що в хуку є useEffect([items]) що пересікає Set)
grep -rn "useBulkSelect\|bulkSelect\.selected" apps/web/src/ --include="*.tsx" | head -10

# indeterminate через inline ref callback (крихко — React Compiler може зламати)
grep -rn "indeterminate" apps/web/src/ --include="*.tsx" \
  | grep -v "useEffect\|useRef\|// indeterminate"

# onKeyDown на role="button" обгорткою без target guard
grep -rn 'role="button"' apps/web/src/ --include="*.tsx" -A 5 \
  | grep "onKeyDown" | grep -v "currentTarget\|target !=="

# opacity-0 hover:opacity-100 на тому ж елементі (недосяжна кнопка)
grep -rn "opacity-0.*hover:opacity-100\|hover:opacity-100.*opacity-0" \
  apps/web/src/ --include="*.tsx" | grep -v "group-hover"

# useUiFeatures в компонентах що доступні неадмінам, але GET endpoint обмежений
# (перевірити що endpoint /settings/ui-features є і не @Roles обмежений)
grep -rn "useUiFeatures" apps/web/src/ --include="*.tsx" | head -10
# Потім перевір: GET /settings/ui-features у settings.controller.ts є @Roles для всіх ролей
```

**UX Features чеклісти:**
- [ ] `toast.X(...)` завжди за `if (features.toastEnabled)` — НЕ голий виклик
- [ ] При `!features.toastEnabled` є fallback: `setError(msg)` або `setFormError(msg)`
- [ ] Bulk-мутації через `Promise.allSettled` + `bulkSelect.clear()` + `load()` в finally
- [ ] Частковий успіх bulk → агрегований toast `"OK N з M. K не змінено"` (не мовчки)
- [ ] `indeterminate` checkbox: `useRef` + `useEffect([dep])`, НЕ `ref={el => el.indeterminate = x}`
- [ ] `useBulkSelect` — `items` prop оновлюється при `setData` → stale IDs авто-прибираються
- [ ] `colSpan` у loading/empty rows: `features.bulkActionsEnabled ? baseColCount + 1 : baseColCount`
- [ ] `useMemo` для `bulkActions: BulkAction[]` — array literal не пере-створюється на кожен render
- [ ] `useSavedFilters` — `Array.isArray` guard при читанні localStorage (corruption defense)
- [ ] Кнопка delete у списках з `opacity-0` — `group` на батьківській картці + `group-hover:opacity-100` на кнопці + `focus:opacity-100` (не `self-hover:opacity-100`)
- [ ] `onKeyDown` на `role="button"` обгортках з інтерактивними нащадками: guard `if (e.target !== e.currentTarget) return`
- [ ] `useUiFeatures` endpoint: `GET /settings/ui-features` відкритий для всіх авторизованих ролей (не тільки OWNER/ADMIN)

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

## 11. Configuration over Hardcode

> **Правило:** якщо значення може змінитись між клієнтами або з часом — воно в БД, не в коді.

```bash
# Magic numbers у сервісах (крім технічних констант)
grep -rn "= [0-9]\{2,\}" apps/api/src/modules/ --include="*.ts" | grep -v "spec\|take:\|skip:\|1000\|200\|100\|60_000\|300_000"
# Перевір кожне знайдене число: чи це бізнес-параметр що має бути в БД?

# Hardcoded рядки повідомлень (мають бути в NotificationTemplate)
grep -rn "\"Шановний\|\"Ваш наряд\|\"Рахунок №\|'Дякуємо" apps/api/src/ --include="*.ts" | grep -v "spec"

# Hardcoded терміни та ліміти
grep -rn "invoiceDue\|autoArchive\|warranty\|slotDuration\|maxDiscount" apps/api/src/ --include="*.ts" | grep -v "SettingsService\|settings\.get\|spec"
```

- [ ] `invoiceDueDays`, `autoArchiveDays`, `warrantyDays` — читаються з `SettingsService.get(orgId)`, не захардкоджені
- [ ] `slotDurationMinutes`, `maxConcurrentSlots` — з `BranchSettings`, не const у коді
- [ ] Шаблони SMS/Viber/Email — тільки з `NotificationTemplate` моделі, не рядкові літерали
- [ ] Способи оплати — з `PaymentMethodConfig`, не enum у коді
- [ ] Ставки ПДВ — з `TaxRate` моделі, не захардкоджений `0.2`
- [ ] ПРРО та SMS credentials — з `BranchSettings` (per branch), не тільки `.env`

```typescript
// ❌ BAD — hardcoded бізнес-параметр
const dueDate = addDays(new Date(), 14); // звідки 14 днів?

// ✅ GOOD
const { invoiceDueDays } = await this.settings.get(orgId);
const dueDate = addDays(new Date(), invoiceDueDays);

// ❌ BAD — hardcoded шаблон повідомлення
const text = `Шановний ${name}, ваш наряд №${number} готовий до видачі`;

// ✅ GOOD
const tpl = await this.notifications.getTemplate(orgId, 'WO_COMPLETED');
const text = tpl.render({ name, number });
```

---

## 12. Tests

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

## 13. API Contract (Frontend ↔ Backend)

> **Ціль:** виявити розрив між `toResponseDto()` у сервісі та `interface` у `page.tsx` до того як це побачить користувач.

```bash
# Всі interface у page.tsx файлах (фронтенд-типи)
grep -rn "^interface \|^type [A-Z]" apps/web/src/app/ --include="*.tsx" | grep -v "Props\b"

# Всі toResponseDto / toDto у сервісах
grep -rn "toResponseDto\|toDto\|toDetailDto" apps/api/src/modules/ --include="*.ts" | grep -v "spec"
```

**Алгоритм перевірки:**
1. Для кожного `interface WorkOrder { ... }` у `page.tsx` — знайди відповідний `toResponseDto()` у сервісі
2. Порівняй **обов'язкові** поля фронтенд-типу з тим що реально повертається
3. Якщо поле обов'язкове у фронті але відсутнє або `undefined` в DTO — це **Critical**

- [ ] Кожне обов'язкове поле фронтенд-`interface` повертається у відповідному `toResponseDto()`
- [ ] Якщо API свідомо пропускає поле (security/роль) — у фронтенд-типі воно `field?: Type`, не обов'язкове
- [ ] Optional поля захищені guard-ом: `data?.field` або `{data.field && ...}`
- [ ] Числові поля з Prisma `Decimal` → `Number(x)` у `toResponseDto()` — не повертається як об'єкт
- [ ] `createdAt`, `updatedAt` → передаються як `string` (JSON серіалізація) — фронтенд-тип має `string`, не `Date`

```typescript
// ❌ BAD — фронт очікує number, API повертає Decimal об'єкт
interface WorkOrder { totalAmount: number }
// toResponseDto: { totalAmount: wo.totalAmount }  ← Decimal об'єкт → фронт отримає "{}"

// ✅ GOOD
// toResponseDto: { totalAmount: Number(wo.totalAmount) }

// ❌ BAD — createdAt: Date у фронтенд-типі (JSON дає string)
interface WorkOrder { createdAt: Date }

// ✅ GOOD
interface WorkOrder { createdAt: string }
```

---

## 14. Accessibility (a11y)

> Стосується тільки змінених `*.tsx` файлів. Не перевіряй весь проект кожен раз.

```bash
# Кнопки-іконки без aria-label
grep -rn "<button" apps/web/src/ --include="*.tsx" -A 2 | grep -B 1 "Icon\|icon\|svg" | grep "<button" | grep -v "aria-label"

# img без alt
grep -rn "<img " apps/web/src/ --include="*.tsx" | grep -v "alt="

# onClick на не-інтерактивних елементах (без role)
grep -rn "onClick" apps/web/src/ --include="*.tsx" | grep -E "<div |<span |<td " | grep -v "role=" | head -10
```

- [ ] `<button>` без видимого тексту має `aria-label` або `title`
- [ ] `<img>` завжди має `alt=""` (декоративне) або `alt="опис"` (змістовне)
- [ ] `onClick` на `<div>`/`<span>` → замінити на `<button>` або додати `role="button"` + `tabIndex={0}` + `onKeyDown`
- [ ] Форми: кожен `<input>`/`<select>`/`<textarea>` має `<label>` або `aria-label`
- [ ] Модальні вікна: `role="dialog"` + `aria-modal="true"` + `aria-labelledby` (вже у `Modal` компоненті — перевір що використовується `title` проп)
- [ ] Статус-Badge не покладається лише на колір — є текстова мітка або `aria-label`
- [ ] **`opacity-0 hover:opacity-100` на тому ж елементі = unreachable**: невидима кнопка з нульовою hover-площею ніколи не показується. Канон: hover на батьку через `group` + `group-hover:opacity-100` на дитині + `focus:opacity-100` для клавіатури. Grep:
  ```bash
  grep -rnE "opacity-0\s+hover:opacity-100" apps/web/src/ --include="*.tsx"
  ```

```typescript
// ❌ BAD — іконка-кнопка без доступного імені
<button onClick={handleClose}>
  <XIcon className="w-4 h-4" />
</button>

// ✅ GOOD
<button onClick={handleClose} aria-label="Закрити">
  <XIcon className="w-4 h-4" aria-hidden="true" />
</button>
```

---

## 15. i18n & Ukrainian UI Consistency

```bash
# Англійські рядки-кнопки та заголовки (не className/href/src)
grep -rn ">[A-Z][a-z][a-z ]" apps/web/src/app/ --include="*.tsx" | grep -v "className=\|href=\|src=\|data-\|aria-\|//\|import\|export\|\.ts\b" | grep -v "[А-ЯҐЄІЇа-яґєії]" | head -20

# Англійські повідомлення про помилки в API
grep -rn "throw new.*Exception" apps/api/src/modules/ --include="*.ts" | grep -v "spec" | grep -E "['\"][A-Z][a-z ]{3,}" | grep -v "[А-ЯҐЄІЇа-яґєії]" | head -10

# Дати виведені через toISOString або toString (не форматовані)
grep -rn "\.toISOString()\b\|\.toString()" apps/web/src/app/ --include="*.tsx" | grep -v "useEffect\|spec\|JSON\|url\|id"
```

- [ ] Всі видимі рядки у JSX — кирилицею (uk-UA)
- [ ] Повідомлення про помилки API — українською (`throw new NotFoundException('Запис не знайдено')`)
- [ ] Дати у форматі `DD.MM.YYYY`, час `HH:mm` (24-год) — не ISO строки напряму в UI
- [ ] Валюта: `1 250,00 ₴` (пробіл-роздільник тисяч, кома-десяткова)
- [ ] Порожні стани (`<EmptyState>`) мають текст українською
- [ ] Placeholder у полях — українська: `placeholder="Введіть назву..."`
- [ ] Validation messages у Zod/class-validator — українські

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
1. Додати новий checklist item у відповідну секцію (§1–§15)
2. Якщо баг виявляється grep'ом — додати bash команду до секції
3. Якщо це повторюваний anti-pattern — додати приклад `❌ BAD` / `✅ GOOD`
4. Якщо специфічний для STO ERP (FSM, інвентар, sync) — у §5 Business Rules
5. Якщо новий тип файлу → оновити таблицю "Пріоритет перевірок по типу змін"
6. Commit: `docs(skills): add <назва патерну> check to sto-review`

**Мета:** скіл має відображати реальні баги що траплялись у цьому проекті — не гіпотетичні.

---

## Карта секцій (quick reference)

| # | Секція | Стосується |
|---|---|---|
| 1 | TypeScript / TS errors | api/, web/, packages/ |
| 2 | Security | api/ — guards, tenant, injection, secrets, queues, JWT, throttle |
| 3 | Memory Leaks | web/ — hooks, state; api/ — DB connections |
| 4 | Architecture | api/ — DI, events, error handling |
| 5 | Business Rules | api/ — FSM, inventory, settlements |
| 6 | Database | prisma, api/ — N+1, take, indexes, select vs include |
| 7 | Performance | api/ — parallel queries; web/ — hydration, useMemo |
| 8 | Web Frontend | web/ — API calls, UI states, SSR, auth routing, UX features |
| 9 | Sync Readiness | prisma, api/sync/ |
| 10 | Offline-First | api/ — BullMQ, зовнішні API |
| 11 | Configuration | api/ — magic numbers, hardcoded templates |
| 12 | Tests | api/*.spec.ts coverage |
| 13 | API Contract | web/page.tsx ↔ api/toResponseDto() |
| 14 | Accessibility | web/*.tsx — aria, keyboard nav |
| 15 | i18n / Ukrainian | web/*.tsx + api errors — кирилиця, формати |
