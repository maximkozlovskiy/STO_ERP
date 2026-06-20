---
name: sto-optimize
description: >
  Performance optimization skill for STO ERP. Audits backend (NestJS/Prisma) and
  frontend (Next.js) for bottlenecks: N+1 queries, missing DB indexes, sequential
  fetches that could be parallel, bundle size, React re-renders, missing cache.
  Finds, fixes, and commits all issues automatically.
  Invoke: /sto-optimize
model: claude-opus-4-7
bypassPermissions: true
---

# sto-optimize — Performance & Efficiency Skill

## Режим Auto (ОБОВ'ЯЗКОВО)

**Все виконується без питань.** Алгоритм:

```
1. Крок 0 — зібрати контекст (git diff + MemoryManual)
2. Крок 1 — аудит backend (7 перевірок)
3. Крок 2 — аудит frontend (7 перевірок)
4. Крок 3 — аудит БД (індекси)
5. Крок 4 — виправити всі знайдені проблеми
6. Крок 5 — tsc 0 errors + git commit
7. Крок 6 — оновити MemoryManual.md
8. Крок 7 — самовдосконалення: записати нові підходи у "Накопичені підходи"
```

> Не питай дозволу між кроками. Фіксуй одним реченням що робиш.

---

## Крок 0 — Контекст

```bash
# Визначити scope (останні зміни або повний аудит)
git diff HEAD --name-only | head -30

# Прочитати стан проєкту
cat MemoryManual.md | head -50
```

Визнач агрегати зі scope → читай відповідні дос'є (`docs/objects/<entity>.md`).
Дос'є містять існуючі індекси, відомі N+1 патерни та кеш-патерни специфічні для агрегату.

**Lookup:** `WorkOrder→work-order.md` | `Invoice→invoice.md` | `PurchaseOrder→purchase-order.md` | `Good→good.md` | `Counterparty→counterparty.md` | `CalendarSlot→calendar.md` | `StockItem→inventory.md`

**Якщо передано аргумент** (`/sto-optimize backend` або `/sto-optimize frontend` або `/sto-optimize db`):
→ виконати тільки відповідний крок.

**Без аргументу** → виконати всі кроки.

---

## Крок 1 — Backend аудит

### 1.1 N+1 запити

```bash
# Async map — класичний N+1
grep -rn "\.map.*await\|await.*\.map\|Promise\.all.*map" apps/api/src/modules/ --include="*.service.ts" | grep -v spec

# For-await loops
grep -rn "for.*await\|forEach.*await" apps/api/src/modules/ --include="*.service.ts" | grep -v spec

# include: true замість select (тягне всі колонки)
grep -rn "include:.*true\b" apps/api/src/modules/ --include="*.service.ts" | grep -v spec | grep -v "//.*include"
```

**Патерн фіксу:**

```typescript
// ❌ include: true — тягне всі колонки join-таблиці
employeeZones: true;

// ✅ select — тільки потрібне поле
employeeZones: {
  select: {
    zoneId: true;
  }
}
```

### 1.2 Послідовні незалежні запити

```bash
# Два findFirst підряд (validation pattern)
grep -rn "const .* = await.*findFirst" apps/api/src/modules/ --include="*.service.ts" -A 3 | grep -B 1 "await.*findFirst" | grep -v spec | head -20
```

**Патерн фіксу:**

```typescript
// ❌ Sequential — кожен чекає попереднього
const cp = await prisma.counterparty.findFirst({ where: { id, orgId } });
if (dto.workOrderId) {
  const wo = await prisma.workOrder.findFirst({ where: { id: dto.workOrderId, orgId } });
}

// ✅ Parallel — обидва йдуть одночасно
const [cp, wo] = await Promise.all([
  prisma.counterparty.findFirst({ where: { id, orgId } }),
  dto.workOrderId ? prisma.workOrder.findFirst({ where: { id: dto.workOrderId, orgId } }) : null,
]);
```

### 1.3 findMany без take ліміту

```bash
grep -rn "findMany(" apps/api/src/modules/ --include="*.service.ts" | grep -v "take:" | grep -v spec | head -20
```

**Фікс:** додати `take: N` (reference data: 100-500; list endpoints: 20-200; reports: 10000 max).

### 1.4 Відсутній Redis кеш для довідників

```bash
# Знайти findMany без кешування що викликаються часто
grep -rn "async findAll" apps/api/src/modules/ --include="*.service.ts" | grep -v spec | head -20
# Перевірити що CacheService є в constructor
grep -rn "CacheService\|cache\.get\|cache\.set" apps/api/src/modules/ --include="*.service.ts" | head -20
```

**Кандидати для кешування (TTL 300s):** branches, warehouses, zones, lifts, work-categories, brands, units, payment-methods, currencies, bank-accounts, cash-registers — всі вже мають кеш.

Шаблон:

```typescript
async findAll(orgId: string): Promise<Dto[]> {
  const key = `ref:X:${orgId}`;
  const cached = await this.cache.get<Dto[]>(key);
  if (cached) return cached;
  const items = await this.prisma.X.findMany({ where: { orgId, deletedAt: null }, take: 200 });
  const result = items.map(i => this.toDto(i));
  await this.cache.set(key, result, 300);
  return result;
}
// + cache.del(key) у create/update/remove
```

### 1.5 Важкі list endpoints з lines/parts

```bash
# findMany що включають lines або parts
grep -rn "findMany" apps/api/src/modules/ --include="*.service.ts" -A 10 | grep -E "lines:|parts:" | head -10
```

**Фікс:** lines/parts у list endpoint → `_count: { select: { lines: ... } }` + lazy-load при відкритті деталей.

### 1.6 JS агрегація замість SQL

```bash
# Завантаження > 1000 рядків + JS reduce/forEach
grep -rn "take: 10000\|take: 5000\|take: 1000" apps/api/src/modules/ --include="*.service.ts" | grep -v spec
# Перевірити чи після findMany є reduce/forEach
grep -rn "\.reduce\|\.forEach\|\.map" apps/api/src/modules/reports/ --include="*.service.ts" | head -10
```

**Фікс:** замінити `findMany(take:10000) + JS reduce` на `$queryRaw GROUP BY` або `prisma.X.groupBy()`.

### 1.7 CORS preflight без maxAge

```bash
# enableCors без maxAge → кожен fetch коштує OPTIONS + GET (2 RTT)
grep -rn "enableCors" apps/api/src/main.ts
```

**Фікс:** додати `maxAge: 86400` у конфіг `enableCors()`. Chrome кепить на 7200s, інші — до 24h. Перевірити що `Authorization` входить у дозволені заголовки якщо `allowedHeaders` явно вказані (за замовчуванням NestJS дозволяє все).

**Як перевірити що проблема є:** у HAR/Network panel шукати парі OPTIONS+GET на той самий endpoint при кожному mount сторінки. Якщо є — `maxAge` не налаштований.

### 1.8 Dashboard і SSE без кешу

```bash
grep -rn "getSummary\|dashboard" apps/api/src/modules/dashboard/ --include="*.service.ts" | head -10
```

**Фікс:** кеш 25s (SSE polling кожні 30s → DB hit лише раз на interval).

---

## Крок 2 — Frontend аудит

### 2.1 Пошук без debounce

```bash
# Input onChange що напряму змінює state який тригерить API
grep -rn "onChange.*setSearch\|onChange.*setQ\b\|onChange.*setQuery" apps/web/src/app/ --include="*.tsx" | head -20
# Перевірити що використовується useDebounce
grep -rn "useDebounce\|debouncedSearch\|debouncedQ" apps/web/src/app/ --include="*.tsx" | head -20
```

**Фікс:** `const debouncedSearch = useDebounce(search, 300)` + замінити `search` → `debouncedSearch` у `useCallback` deps.

### 2.2 Послідовні useEffect при mount

```bash
# Кілька useEffect що залежать від [id] або [] — потенційні waterfall
grep -rn "useEffect.*\[id\]\|useEffect.*\[\]" apps/web/src/app/ --include="*.tsx" | head -20
```

**Патерн фіксу:**

```typescript
// ❌ 4 окремих useEffect — 4 мережевих хвилі
useEffect(() => {
  loadComments();
}, [loadComments]);
useEffect(() => {
  loadMedia();
}, [loadMedia]);
useEffect(() => {
  loadAudit();
}, [loadAudit]);

// ✅ Один Promise.all — одна хвиля
useEffect(() => {
  Promise.all([
    apiFetch(`/comments?...`).catch(() => ({ items: [] })),
    apiFetch(`/media?...`).catch(() => ({ items: [] })),
    apiFetch(`/audit?...`).catch(() => ({ items: [] })),
  ]).then(([comments, media, audit]) => {
    if (!mountedRef.current) return;
    setComments(comments.items);
    setMedia(media.items);
    setAuditEvents(audit.items);
  });
}, [id]);
```

### 2.3 Waterfall запитів (forEach → Promise.all)

```bash
grep -rn "forEach.*apiFetch\|\.forEach.*fetch\|forEach.*then" apps/web/src/app/ --include="*.tsx" | head -10
```

**Фікс:** замінити `garages.forEach(g => apiFetch(g.id))` на `Promise.all(garages.map(g => apiFetch(g.id)))`.

### 2.4 Відсутній sessionStorage кеш для reference data

```bash
# Сторінки що завантажують branches/warehouses/zones без getCached
grep -rn "apiFetch.*branches\|apiFetch.*warehouses\|apiFetch.*zones\|apiFetch.*lifts\|apiFetch.*work-categories" apps/web/src/app/ --include="*.tsx" | grep -v "getCached\|setCache" | head -20
```

**Фікс:** використати `getCached` / `setCache` з `@/lib/ref-cache`.

**Окремо — source/management сторінки довідників** (вони не лише читають, а й редагують список):

```bash
# Сторінки що фетчать довідник у loadAll/load І в mutation-хендлерах — але не пишуть у кеш
grep -rln "apiFetch.*/branches\|apiFetch.*/zones\|apiFetch.*/lifts\|apiFetch.*/warehouses" apps/web/src/app/ --include="*.tsx" | xargs grep -L "setCache"
```

Якщо `loadAll()` викликається і на mount, і після КОЖНОЇ мутації → безпечно додати `getCached` (first-paint) + `setCache` (warm cache + пропагація правок споживачам). Якщо ні — НЕ кешувати (ризик stale).

### 2.5 Важкі бандли без lazy loading

```bash
# Перевірити bundle sizes
pnpm --filter @sto/web build 2>&1 | grep -E "Route.*kB|First Load" | sort -t'k' -k1 -rn | head -15
```

**Кандидати для `next/dynamic`:** recharts, heavy chart libs, map components. Поріг: сторінка > 200kB First Load JS.

**Шаблон:**

```typescript
const HeavyChart = dynamic(() => import('./HeavyChart'), {
  ssr: false,
  loading: () => <div className="h-64 bg-surface-hover animate-pulse rounded-xl" />,
});
```

### 2.6 React.memo на list items

```bash
# Компоненти в map() що не мають memo
grep -rn "\.map.*<[A-Z]\|return.*map.*(" apps/web/src/app/ --include="*.tsx" | grep -v "memo\|spec\|import" | head -20
# Компоненти що рендеряться в grid/calendar без memo
grep -rn "function.*Row\|function.*Card\|function.*Cell\|function.*Item" apps/web/src/app/ --include="*.tsx" | grep -v "memo\|spec" | head -15
```

**Фікс:** `const MyRow = memo(function MyRow({ ... }) { ... })` — тільки якщо props є примітивами або стабільними refs.
**Увага:** memo марний якщо пропсам передають `array.filter()` inline → використовувати `useMemo` Map для груп.

### 2.7 Стейт замість useMemo/константи

```bash
# useState для значень що не змінюються
grep -rn "useState.*new Date\|useState.*Date\.now\|setToday\|setNow\b" apps/web/src/app/ --include="*.tsx" | head -10
# SSR-safe: не використовувати useMemo для дат у статично-експортованих сторінках!
grep -rn "output.*export" apps/web/next.config.ts
```

**CRITICAL для static export:** `new Date()` у `useMemo` запікає build-time дату → hydration mismatch.
**Правильно:** `useState<Date|null>(null)` + `useEffect(() => setToday(new Date()), [])`.

### 2.8 Intl.\*Format у hot-path хелперах + годинник у render

```bash
# Конструкція форматера у тілі функції-хелпера (locale-data init на кожен виклик)
grep -rn "new Intl\.\(DateTimeFormat\|NumberFormat\)\|\.toLocale\(Time\|Date\)String(" apps/web/src/ --include="*.tsx" | head -20
# Читання годинника всередині render/map (impure + per-element)
grep -rn "new Date()\|Date\.now()\|\.getMinutes()\|\.getHours()" apps/web/src/app/ --include="*.tsx" | grep -v "useEffect\|useCallback\|=>" | head -20
```

**Фікс Intl:** винести форматер у module-level `const` (опції мають бути константні), у хелпері лише `.format()`.
**Фікс годинника:** тримати `nowMs` у стейті + interval; похідні граничні значення через `useMemo([nowMs])`; передавати як props у дочірні компоненти (роблячи їх чистими/memo-friendly).

### 2.9 Навігаційний prefetch — відсутній або неповний PREFETCH_MAP

```bash
# Перевірити покриття — скільки NAV items мають prefetch
grep -n "'/[a-z]" apps/web/src/components/TopShell.tsx | grep "PREFETCH_MAP\|prefetchQuery" | wc -l

# Знайти маршрути що є у NAV_GROUPS але відсутні у PREFETCH_MAP
grep -n "href:.*'/[a-z]" apps/web/src/components/TopShell.tsx | grep -v "PREFETCH_MAP"

# Сторінки що досі на useEffect+apiFetch (не mіgровані на useQuery)
grep -rln "useEffect.*\[\]" apps/web/src/app/ --include="*.tsx" | xargs grep -l "apiFetch" | grep -v "spec\|test"
```

**Мета:** 17/17 NAV items у PREFETCH_MAP. При hover (~200мс) → API запит вже виконується → кліку дані вже в кеші.

**Патерн фіксу:**

```typescript
// TopShell.tsx — module-level, поза компонентом
const KYIV_DATE_FMT = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv' });

type PrefetchFn = (qc: ReturnType<typeof useQueryClient>) => void;
const PREFETCH_MAP: Record<string, PrefetchFn> = {
  '/work-orders': qc => void qc.prefetchQuery({
    queryKey: workOrdersKeys.list({}),
    queryFn: ({ signal }) => apiFetch('/work-orders?limit=50', { signal }),
    staleTime: 30_000,
  }),
  // Для сторінок з date-залежними даними (calendar):
  '/calendar': qc => {
    const today = KYIV_DATE_FMT.format(new Date());
    void qc.prefetchQuery({ queryKey: infraKeys.lifts, ... });
    void qc.prefetchQuery({ queryKey: ['calendar', 'slots', today], ... });
  },
};

// NavLink onMouseEnter — guard на employee (щоб не prefetch без auth)
onMouseEnter={() => employee && PREFETCH_MAP[item.href]?.(queryClient)}
```

**Правила:**

- `prefetchQuery` — no-op якщо дані вже fresh (staleTime не минув), безпечно викликати
- `employee` guard обов'язковий — без нього prefetch робить 401 → tryRefresh → зайвий RTT
- module-level Intl singleton для date-залежних ключів (не per-hover construction)
- Для сторінок що завантажують 4+ ресурси — запускати їх паралельно в одному `PrefetchFn`

### 2.10 Сторінки на useEffect+apiFetch — відсутній TanStack Query кеш

```bash
# Сторінки де головний список завантажується через useEffect, а не useQuery
grep -rn "useState.*\[\]\|setLoading.*true\|const load = " apps/web/src/app/ --include="*.tsx" \
  | grep -v "spec\|hooks/api\|node_modules" | grep "setLoading\|const load" | head -20

# Перевірити які сторінки вже мігровані
ls apps/web/src/hooks/api/
```

**Проблема:** `useEffect → apiFetch → setState` — при кожному повторному відвідуванні сторінки дані завантажуються з нуля (немає кешу). З `useQuery(gcTime: 5m)` — повторний візит протягом 5 хвилин = 0 мережевих запитів.

**Патерн міграції:**

```typescript
// ❌ ДО — перезавантаження кожного разу
const [items, setItems] = useState<Item[]>([]);
const [loading, setLoading] = useState(true);
const load = useCallback(() => {
  setLoading(true);
  apiFetch('/items')
    .then(setItems)
    .finally(() => setLoading(false));
}, [filters]);
useEffect(() => {
  load();
}, [load]);

// ✅ ПІСЛЯ — кеш 5 хв, keepPreviousData при зміні фільтрів
import { useQuery, keepPreviousData } from '@tanstack/react-query';
export const itemsKeys = {
  all: ['items'] as const,
  list: (f: Filter) => ['items', 'list', f] as const,
};
const { data, isLoading: loading } = useQuery({
  queryKey: itemsKeys.list(filters),
  queryFn: ({ signal }) => apiFetch(`/items?...`, { signal }),
  enabled: !!employee,
  staleTime: 30_000,
  placeholderData: keepPreviousData,
});
const items = data?.items ?? [];
// Після mutation: qc.invalidateQueries({ queryKey: itemsKeys.all })
```

**Файли hooks:** `apps/web/src/hooks/api/` — всі наявні hooks як зразок.

**Вже мігровано (не переписувати):** useWorkOrders, useCounterparties, useInvoices, useInventory, usePurchaseOrders, useEmployees, useBookingRequests, usePricingRules, useStockDocuments, useInfrastructure, useReports, useSyncStatus, useDashboardData, useWorks.

**Залишається немігрованим:** `calendar/page.tsx` (1460 рядків + dnd-kit — складний рефакторинг, відкладено).

### 2.11 View-mode shared-state — data fetch не guard-ed по active view

```bash
# Сторінки з view switcher (calView/viewMode/mode/tab) — знайти effects без view-guard
grep -rln "setCalView\|setViewMode\|setMode\|setActiveTab\|setTab" apps/web/src/app/ --include="*.tsx" | xargs grep -l "useEffect"

# В кожному файлі-кандидаті — пошук useEffect що викликає load/fetch без deps на view
# Шаблон: useEffect(() => { ... load() ... }, [shared_key]) — без calView/mode у deps
```

**Проблема:** Один `date`/`id`/`filters` state шарінгується між day/month/stats views. Effect що завантажує дані day-view має deps `[date]` без `calView` — стріляє і коли користувач у stats/month. Wasted RTT на кожну зміну shared key у не-активному виді.

**Фікс:** Додати guard у тіло ефекту + view-state у deps:

```typescript
// ❌ ДО — стріляє у всіх видах
useEffect(() => {
  load();
}, [load]);

// ✅ ПІСЛЯ — тільки у активному виді; при поверненні до виду — оновить
useEffect(() => {
  if (calView === 'day') load();
}, [load, calView]);
```

### 2.12 EMPTY*\*/DEFAULT*\* константа всередині компонента

```bash
# SCREAMING_CASE декларація всередині function body (не module-level)
grep -rn "^  const [A-Z][A-Z_]\+\s*[:=]" apps/web/src/app/ --include="*.tsx" | grep -v "//\|^[^:]*:\s*$" | head -10
```

**Фікс:** Підняти декларацію на module-level (поза функцією-компонентом). Якщо тип з того ж файлу — теж підняти. Не плутати з `useMemo`-залежними значеннями.

### 2.13 Inline React component всередині parent component body

```bash
# Local components оголошені у тілі великих Shell/Layout компонентів
grep -rn "^\s\+const [A-Z]\w\+ = (\|^\s\+function [A-Z]\w\+(" apps/web/src/components/ --include="*.tsx" | grep -v "memo\|spec\|^$" | head -20
```

**Фікс:** перевірити чи виклик через `<Name/>` JSX-syntax. Якщо так — або: (А) перейменувати на `renderName(...)` + кликати як function call `{renderName(...)}` (closure збережений, ніяких component-type змін); (Б) підняти на module-level + memo + props drilling. **Симптом для перевірки:** React DevTools profiler показує unmount+mount замість update коли setState батька fire-иться.

### 2.14 Context Provider value object без useMemo

```bash
# Inline-літерал value у Provider
grep -rn "Context\.Provider value={{" apps/web/src/ --include="*.tsx" | head -20
# Або value змінна що створюється inline вище без useMemo
grep -rn "Context\.Provider value={value}" apps/web/src/ --include="*.tsx" | head -10
```

**Фікс:** `const value = useMemo(() => ({ ...поля }), [...reactive deps...])`. callback-и у value мають бути useCallback-стабільні щоб не bloat-ити deps. **Альтернатива** — context splitting (один Context для state, інший для actions) якщо є чітка границя.

### 2.15 Multiple mount-only useEffect з `[]` deps у одному компоненті

```bash
# Файли з 3+ окремими useEffect [] у одному файлі
grep -rln "useEffect.*\[\]" apps/web/src/ --include="*.tsx" | xargs -I {} sh -c 'count=$(grep -c "useEffect.*\[\]" {}); [ $count -ge 3 ] && echo "$count {}"' | sort -rn | head -10
```

**Фікс:** об'єднати у один useEffect якщо: (1) deps усіх — `[]`; (2) бодyx незалежні (один не пише `localStorage.X` що інший читає); (3) cleanup-функції можна об'єднати у один return. Виняток — якщо ефект справді концептуально окремий і має нетривіальну cleanup-логіку, лишити окремо.

### 2.16 Modal onClose без useCallback у parent — keydown/overflow listener thrashing

```bash
# Модальні компоненти що приймають onClose і Modal.useEffect для keydown
grep -rn "onClose:.*=>\|onClose={() => {\|onClose={\\s*saving" apps/web/src/components/ui/ --include="*.tsx" | head -20
```

**Фікс:** у parent компоненті обгорнути обробник у `const handleClose = useCallback(() => {...}, [deps])`. Без цього Modal.useEffect `[open, handleKey]` (де handleKey depends on onClose identity) re-fires на КОЖЕН render батька → addEventListener/removeEventListener + body.style.overflow re-write. Особливо помітно у модалках з частим typing у внутрішніх inputs.

---

## Крок 3 — DB аудит

### 3.1 Відсутні індекси на WHERE колонках

```bash
# Перевірити які колонки фільтруються без індексів
grep -rn "where.*status\|where.*completedAt\|where.*branchId\|where.*warehouseId\|where.*type\b" apps/api/src/modules/ --include="*.service.ts" | grep -v spec | head -20

# Існуючі індекси
grep -n "@@index\|@@unique" packages/database/prisma/schema.prisma | head -40
```

**Пріоритет індексів:**
| Таблиця | Колонки | Тип |
|---|---|---|
| WorkOrder | `(orgId, status, branchId, deletedAt)` | B-tree |
| WorkOrder | `(orgId, completedAt, deletedAt)` | B-tree |
| StockItem | `(orgId, warehouseId, deletedAt)` | B-tree |
| StockMovement | `(orgId, warehouseId, createdAt)` | B-tree |
| text search | `(number, firstName, lastName, name, sku)` | GIN trgm |

### 3.2 GIN trgm для пошуку

```bash
# Перевірити чи є тргм індекси
docker exec stoerp-postgres-1 psql -U sto -d sto_erp -c "SELECT indexname FROM pg_indexes WHERE indexname LIKE '%trgm%';" 2>/dev/null | head -15
```

**Фікс:** `CREATE INDEX IF NOT EXISTS idx_X_col_trgm ON X USING gin (col gin_trgm_ops);`

---

## Крок 4 — Виправлення

Для кожної знайденої проблеми:

1. Прочитай файл
2. Застосуй мінімальний точковий фікс
3. `pnpm --filter <package> exec tsc --noEmit` — 0 errors
4. Якщо зміна в schema.prisma → `cd packages/database && npx prisma db push --skip-generate`

**Пріоритет фіксів:**

1. N+1 та waterfall (найбільший impact)
2. Відсутні індекси (migration)
3. Послідовні → паралельні запити
4. Cache miss
5. Bundle/memo (найменший ризик)

---

## Крок 5 — TypeScript + Commit

```bash
pnpm --filter @sto/api exec tsc --noEmit
pnpm --filter @sto/web exec tsc --noEmit --incremental false

git add apps/ packages/
git commit -m "perf(optimize): <коротко що виправлено>"
```

---

## Крок 6 — Оновити MemoryManual.md

Оновити:

```markdown
## Останній commit

<hash> <message>
Дата: YYYY-MM-DD

## Поточний стан проєкту

TypeScript: ✅ 0 errors
```

---

## Крок 7 — Самовдосконалення скіла (ОБОВ'ЯЗКОВО після кожної ітерації)

Після кожного запуску — запитай себе:

> **"Цей патерн вже покритий чеклістом? Чи є новий тип неефективності що я виявив вперше?"**

### Що записувати

**Записуй** якщо знайшов:

- Новий **тип неефективності** якого не було в чеклісті (новий анти-патерн)
- Новий **контекстний сигнал** — ознаку за якою можна автоматично виявляти проблему (grep, структура, назва)
- **Причину** чому проблема виникла — це допомагає передбачити де шукати наступного разу
- **Наслідок** — що реально покращилось (кількість запитів, ms, kB) — для калібрування пріоритетів

**Не записуй:**

- Конкретні файли, функції, рядки коду (вони змінюються)
- Готові фікси або шаблони коду (для цього є Кроки 1-3)
- Речі які вже є в чеклісті

### Формат запису

Після кожної ітерації — оновлювати секцію **"Накопичені підходи"** нижче:

```
### [Дата] — [Тип проблеми] — [Де зустрічається]

**Сигнал:** ознака за якою можна знайти автоматично
**Причина виникнення:** чому розробники так пишуть (зрозуміло, але неефективно)
**Підхід до виявлення:** загальний принцип пошуку, не grep
**Підхід до фіксу:** загальний принцип рішення, не код
**Реальний impact:** що змінилось після фіксу
**Де шукати ще:** суміжні місця де той самий патерн може повторитись
```

### Як оновлювати чекліст

Якщо новий патерн **підтверджений у коді** (не гіпотетичний):

1. Додати в відповідний розділ (Крок 1 / Крок 2 / Крок 3) новий підрозділ з grep-командою
2. Додати до "Що вже оптимізовано" після фіксу
3. Коміт: `docs(skills): add <pattern> to sto-optimize`

---

## Накопичені підходи (оновлюється автоматично)

### 2026-06-20 — Ordered sub-sequence + independent cross-table write всередині `$transaction` — wrap sub-sequence у async IIFE, Promise.all з незалежним write

**Сигнал:** service `update()`/`replace()` метод усередині `$transaction` робить замінy дочірньої колекції (tiers/lines/parts/items) через "delete → create" pattern: `await tx.child.deleteMany({where: {parentId}})` + `await tx.child.createMany({data: [...]})`. ОДРАЗУ ПІСЛЯ цього — `await tx.parent.updateMany({where: {id, orgId}, data: scalarFields})` що пише у БАТЬКІВСЬКУ таблицю (інша таблиця, інший primary key, не залежить від результатів tier-операцій). 3 sequential `await` (`deleteMany → createMany → updateMany`) → 3 RTT. Tier sequence МУСИТЬ бути ordered (create після delete, інакше дублікати/конфлікти PK), але main updateMany ОРТОГОНАЛЬНИЙ — пише у іншу таблицю, не читає результат жодної з tier-операцій. Симптом у git diff: оптимізаційна migration paterна "Disjoint-set updateMany pairs" (2026-06-12) застосована тільки до DOUBLE-updateMany на ОДНІЙ таблиці; цей патерн — variant для TRIPLE-await де sub-sequence ordered, але hat-операція незалежна.
**Сигнал-grep:** `\$transaction\(\s*async tx => \{[\s\S]{0,200}await tx\.\w+\.deleteMany[\s\S]{0,300}await tx\.\w+\.createMany[\s\S]{0,300}await tx\.\w+\.updateMany`. Підтверджуюча ознака: перші дві операції на одній таблиці (наприклад `pricingRuleTier`), третя — на ІНШІЙ (`pricingRule`). Якщо всі три на одній таблиці — НЕ цей патерн (write-write на same table з різним PK може бути safe, але потребує окремого аналізу).
**Причина виникнення:** "delete-then-create" замінювач дочірньої колекції написаний linear-стилем — розробник інтуїтивно ставить main `update()` ПОСЛЕ tier-replace бо "tiers і main fields — це одна логічна транзакція". Не помічає що main update read-залежить ТІЛЬКИ від `id`+`orgId` (синхронно у scope), не від результату tier-операцій. Patтерн "Disjoint-set updateMany pairs" (2026-06-12) описує 2-операційний випадок (два updateMany на одній таблиці з disjoint WHERE) — інтуїтивно не екстраполюється на 3-операційний випадок з ordered-internal sub-sequence. Розробник не задумується "чи tier-replace блокує updateMany?" — це невинне виглядаюче sequential.
**Підхід до виявлення:** при перегляді service-методу `update()`/`replace()` з $transaction — для кожного блоку `await tx.X.deleteMany → await tx.X.createMany` перевірити чи наступний await ПИШЕ у іншу таблицю. Якщо так — кандидат на refactor "wrap delete+create як async IIFE → Promise.all з main update". Cross-check: подивитись чи main `updateMany` має where clause що залежить ТІЛЬКИ від синхронно-доступних (id, orgId) — не від результату tier-операцій (наприклад totalAmount розраховане з createMany результату — НЕ кандидат, ordered required).
**Підхід до фіксу:** обернути ordered sub-sequence у async IIFE: `const tierWork = (async () => { await tx.child.deleteMany(...); if (data.length > 0) await tx.child.createMany(...); })();`. Окремо створити неchained `tx.parent.updateMany(...)` promise — БЕЗ await (це Prisma Promise, виконується at-await або at-then). `await Promise.all([tierWork, mainUpdate])`. Після цього `findFirstOrThrow` (re-read для DTO) лишається останнім — потребує що ВСІ writes завершені. Race-safe бо два promise пишуть у РІЗНІ таблиці на одній pinned $tx connection. Не змішувати з case коли main update залежить від сумарного `tierTotal` обчисленого з нового tiers — там ordered required.
**Реальний impact:** pricing-rules.update() з зміною tiers + main fields: 3 sequential `await` всередині $tx → 2 RTT (`Promise.all` блок + final `findFirstOrThrow`). На SaaS з масовим оновленням rule-конфігів (бек-офісний bulk-edit) — 33% time-save на update. Локально (single-tenant) — менший impact, але звільняє pool connection швидше.
**Де шукати ще:** будь-який service-метод що замінює дочірню колекцію (`children: [...]` у DTO) разом з оновленням parent-scalars — invoice.update (lines + totals), workOrder.update (parts + notes), stockDocument.update (lines + warehouseId), purchaseOrder.update (lines + supplierId), bookingRequest.update (slots + status). Завжди шукати TRIPLE await pattern `delete + create + parent.update` де перші два на дочірній таблиці, третій на батьківській. Особлива увага коли в commit-діффі видно нову feature ("додано tier-edit у форму") — backend update метод майже завжди copy-paste з legacy sequential шаблону.

---

### 2026-06-19 — Trgm index drift у search OR clause — нова/прогаяна колонка у `where.OR = [{ a contains }, { b contains }, { c contains }]` без парного `idx_X_col_trgm`

**Сигнал:** service-метод `findAll(query)` має `where.OR = [{ colA: { contains: q, mode: 'insensitive' }}, { colB: { contains: q, mode: 'insensitive' }}, { colC: { contains: q, mode: 'insensitive' }}]` (типово 2-5 OR-гілок). Один або кілька стовпців покриті GIN trgm індексами (`idx_X_colA_trgm`, `idx_X_colB_trgm`), але як мінімум один стовпець — НІ. Найчастіше це happens після: (1) batch trgm-міграції що додавала покриття для перших 2-3 стовпців ("важливих"), потім третій-четвертий стовпець залишився обділеним; (2) пізніша feature додала ще одну OR-гілку (наприклад `internalCode`) без супутньої міграції-індексу; (3) перейменування стовпця між міграціями (старий `barcode` лишився, новий not yet). На запит з `q=value` Postgres звужує по tenant-guard index (`orgId+deletedAt`), потім робить per-row `LIKE` на не-індексованих стовпцях OR. Симптом — у git diff видно `feat(X)` commit що додає search predicate або новий filtered column без супутньої `CREATE INDEX ... gin_trgm_ops` лінії.
**Сигнал-grep:** для кожної таблиці з search — порівняти dirext `where.OR` columns vs existing `idx_X_*_trgm` indexes. Для модуля `goods`: search columns `[name, sku, barcode]`, existing trgm = `[name, sku]` → drift на `barcode`.
**Причина виникнення:** trgm-міграції зазвичай batched один раз ("додати пошук по таблицям X/Y/Z") і не reаудиту-ються при кожній feature. Розробник що додає нову search column ("давайте додамо barcode у пошук") або новий filter column бачить що search працює (бо tenant-guard index ще звужує) — не помічає що план фолбекає на seq+LIKE на non-trgm column. Cycle-N gap частий: одна search column отримала trgm у feat-commit (`name`/`sku` отримали свій), наступна додалась пізніше БЕЗ окремої trgm-міграції. Patterns `Reverse-FK index miss` (2026-06-09) та `Detail-include vs list-include` (2026-05-30) обидва підкреслюють що нові feature commits майже завжди забувають про супутні індекси — це специфічна форма того ж патерну для пошуку.
**Підхід до виявлення:** для service-методу з search — зчитати ВСІ колонки у `where.OR` array. Для кожної — `grep "_<column>_trgm" packages/database/prisma/migrations/`. Якщо відсутній — drift. Cross-check: подивитись чи pg*trgm extension вмикнутий у попередніх міграціях (якщо ні — окремий fix додати `CREATE EXTENSION IF NOT EXISTS pg_trgm`). Особливо обережно з recently-added FE polish features (наприклад "secondary line у каталозі показує internalCode") — якщо UI рендерить, backend часто додає search-by-X пізніше; drift гарантовано.
**Підхід до фіксу:** окрема migration-папка `YYYYMMDDHHMMSS_add*<table>_<column>\_trgm_index/migration.sql`з`CREATE INDEX IF NOT EXISTS "idx_<table>_<column>\_trgm" ON <table> USING gin ("<column>" gin_trgm_ops);`. IF NOT EXISTS для idempotency (re-run safety). Не торкатися Prisma schema — GIN-trgm не expressed у Prisma DSL (тільки B-tree через `@@index`). Коментар у SQL пояснює яка OR-гілка покривається. Якщо drift у >1 column — одна migration з кількома CREATE INDEX рядками (атомарна група, простіше rollback). Не плодити покриття для стовпців що НЕ в WHERE — GIN trgm дорогий на write (≈30% INSERT overhead), додавати лише коли є реальна OR-гілка.
**Реальний impact:** для `goods`з 50k рядків на org,`q=ART-001`(barcode hit): seqscan на (orgId+deletedAt)-narrowed subset ≈10-50мс → trgm bitmap-scan ≈1-3мс. Малий impact індивідуально, але search-by-barcode — це primary lookup path для barcode scanner у GoodPickerModal/POS workflow — кожен сканбар реактивно тригерить fetch. Сумарно по робочому дню СТО — десятки тисяч сканів.
**Де шукати ще:** для КОЖНОЇ моделі з search OR predicate (Good, Counterparty, WorkOrder, Invoice, PurchaseOrder, StockDocument, Employee, Vehicle) — порівняти`where.OR` колонки vs existing trgm indexes. Особливо: WorkOrder.findAll() OR=[number, counterparty.companyName/firstName/lastName] — counterparty join columns мають свої trgm (`idx_counterparties_\*\_trgm`); WorkOrder.number — `idx_work_orders_number_trgm`. Перевірити чи кожна search column має парний індекс. Checkpoint при кожному PR що додає search column: разом з code-change має бути migration-change.

---

### 2026-06-17 — Twin-scan `reduce()` у backend mutation-hot-path recalc/aggregate helper — single-pass `for…of` з двома акумуляторами

**Сигнал:** service-helper `recalcTotals` / `recomputeAggregates` / `applyDocBalances` (викликається з кожного create/update/delete по child rows — addLine, updateLine, removeLine, addPart, updatePart, removePart, тобто 6+ entry-points у service) робить `findMany({ select: { amount, normo, actual, price } })` потім ДВА окремих `.reduce()` по тому ж масиву: один для `totalLabor = SUM(amount)`, другий для `totalActualLabor = SUM((actualHours ?? normoHours) × price)`. Frontend-варіант цього патерну (Twin-scan reduce у tfoot/footer, 2026-06-11) — про React render-rate; backend-варіант — про per-mutation CPU/GC у hot path. Симптоми: array.reduce викликається 2+ рази підряд з тим самим джерелом + різними accumulator-семантиками. У git diff видно formula change з `SUM(amount)` на `SUM((actualHours ?? normoHours) × price)` — розробник додає НОВУ reduce поряд зі старою бо "семантика інша", не задумується що дві формули можна виконати у одному проході.
**Grep:** `lines\.reduce\([\s\S]{0,200}\);[\s\S]{0,300}lines\.reduce\(` АБО `\w+\.reduce\([^)]+\);[\s\S]{0,300}\w+\.reduce\(` (де перший і другий `\w+` — той самий identifier у тому ж scope). Підтверджуючий сигнал: aggregate замість одного — два, кожен має різний accumulator. Допоміжний — наявність `findMany` ВИЩЕ з `select` що містить точно ті поля що читаються обома reduce-ами.
**Причина виникнення:** коли формула totals змінюється (наприклад totalAmount тепер залежить від actualHours, а не normoHours), розробник додає НОВУ reduce поряд зі старою замість того щоб модифікувати існуючу. Декларативний "одна reduce — одна формула" патерн виглядає чисто. Backend-mode хибне відчуття безпеки: "це викликається 1 раз на mutation, не варто оптимізувати". Реально — recalcTotals викликається у кожному з 6+ mutation entry-points (addLine, updateLine, removeLine, addPart, updatePart, removePart, transition writes); WO з 50 лініями = 100 reduce iterations на кожен mutation × 6 типів операцій = 600 wasted ops при кожному масовому редагуванні. Plus двойний прохід по масиву Decimals означає 2× Number() casts (Prisma Decimal → Number alloc).
**Підхід до виявлення:** при перегляді service-помічника типу `recalc*` / `recompute*` / `apply*` — перевірити чи є array.reduce. Якщо є — порахувати скільки reduce-ів по тому ж масиву. >1 → кандидат на single-pass. Якщо ОДИН — перевірити чи інший aggregate (`forEach` / `for-of`) НЕ читає той самий масив поряд. Cross-check: у git blame коли була формула single → twin? Якщо нещодавно (feat commit changes formula) — ймовірно знаходимось у вікні де старий reduce лишився, а новий додався без merge. Перевіряти кожен helper що читає N child rows і пише M aggregate fields — там завжди є ризик twin-scan.
**Підхід до фіксу:** один `for (const x of array) { acc1 += ...; acc2 += ...; }` блок із локальними `let acc1 = 0; let acc2 = 0;` ПЕРЕД циклом. Семантично еквівалентно, але half CPU + half GC pressure для Decimal→Number casts. Також додати `take: N` ліміт у findMany якщо немає захисту (recalc/recompute helpers особливо ризиковані — addLine/addPart endpoints зазвичай без ArrayMaxSize). Захисний поріг має співпадати з upper bound інших bulk reads у тому ж service (reserveParts/releaseReservations/тощо — типово 1000). Альтернативний шлях: якщо різні reduce-и пишуть у DIFFERENT child collections (lines vs parts), не зливати — кожен collection один-прохід ще раз.
**Реальний impact:** на WO з 50 рядками: 100 reduce iterations + 100 Number() casts на mutation → 50 iterations + 50 casts. На повний edit-сеансі (10 mutations) — економія 500 iterations + 500 allocs. Незначно у мс per-request, але прибирає двойний прохід з hot path mutation потоку (де latency має значення для UX інспекторів механіка що швидко додають рядки). Cross-cutting: те саме поліпшення для invoices.recalcTotals, stock-document.recompute, purchase-order.recalc — всі мають симетричні reduce-pairs.
**Де шукати ще:** будь-який helper `recalc*` / `recompute*` / `applyTotals*` / `refreshAggregates*` у service-шарі — work-orders, invoices, stock-documents, purchase-orders, supplier-returns, estimates. Якщо у моделі є aggregate fields (totalLabor + totalActualLabor, totalAmount + totalVat, totalDiscount + totalNet) — helper що їх перераховує МАЙЖЕ ЗАВЖДИ робить parallel reduce-и які можна злити. Особливо — checkpoint при додаванні нового aggregate field: коли feat commit додає `totalActualLabor` поряд з `totalLabor`, recalcTotals переписаний у naive twin-scan стилі.

---

### 2026-06-17 — Sequential post-token `wo + org + uoms` lookup у public share-endpoint — `findFirst(token) → findFirst(org)` `→ findMany(uoms)` ланцюг 3 RTT, merge tail-pair у Promise.all

**Сигнал:** public read-endpoint що знаходить агрегат через share-token (estimate-share, invoice-public, document-view) має класичний 3-step ланцюг: (1) `findFirst({ where: { shareToken } })` — гідрує `wo` з orgId+parts.unitOfMeasureId, (2) `findFirst({ where: { id: wo.orgId } })` — гідрує `org` (name/logoUrl для рендеру), (3) `findMany({ where: { id: { in: uomIds } } })` — гідрує `uoms` (shortName для кожної парт). Перші 2 не паралелізовані бо `org.id = wo.orgId` (залежність), але 2+3 паралельні бо обидва залежать ТІЛЬКИ від `wo`. Sequential 3 RTT де можна 2 RTT (token-lookup + Promise.all([org, uoms])). У git diff видно цей патерн у findByShareToken + getEstimateData симетрично: коли один з них оптимізується, другий лишається не зачеплений (sibling-drift, 2026-06-15 Form/modal totals pattern).
**Grep:** `findFirst\([^)]+shareToken[\s\S]{0,1500}await this\.prisma\.organisation\.findFirst[\s\S]{0,500}await this\.prisma\.\w+\.findMany\(` — pattern token-lookup → sequential org → sequential children lookup. Перевіряти багатоповторні export-endpoint-и (PDF/XLSX/DOCX) які кожен викликає shared data-builder helper — економія множиться по числу формат-варіантів.
**Причина виникнення:** при first-pass реалізації share-endpoint розробник пише послідовно бо "спочатку треба знати чи wo існує (404 інакше), потім тягнути все інше". Token-validation як first guard — semantically правильно. Але після першого if-throw blocks подальші lookups стають незалежні — це не очевидно при copy-paste. Patterns "tier merger" що документувались для tenant-guard + FK-validation (counterparty + branch) не екстраполюються інтуїтивно на "post-guard hydration" sibling lookups (org + uoms) — інша природа queries (один scalar, один array), легко пропустити що теж кандидат на merger.
**Підхід до виявлення:** для кожного public-token endpoint (`findBy*Token`, `getPublicView`, `getEstimateData`) — після `if (!entity) throw NotFound` перевірити кожен наступний await. Якщо є 2+ незалежні await (одночасно НЕ читають вихід попереднього у where-clauses) — кандидат на Promise.all merger. Особливо: один з них `findFirst({ where: { id: entity.someFkId } })` (singular hydration) + інший `findMany({ where: { id: { in: entity.childrenIds } } })` (collection hydration) — типова pair. Cross-check: якщо є sibling-helper (`getEstimateData` поряд з `findByShareToken`) — він майже завжди має такий же sequential patterns (copy-paste evolve без cross-sync).
**Підхід до фіксу:** виlift `const uomIds = wo.X.map(c => c.fkId).filter(...)` ПЕРЕД Promise.all (фіксує input для children-lookup); `const [org, uoms] = await Promise.all([findFirst(org), uomIds.length > 0 ? findMany(uoms) : Promise.resolve([] as typeof PlaceholderType[])])`. Ternary з `Promise.resolve([])` зберігає skip-RTT behavior коли uoms empty. Звузити TYPE-asserted placeholder до точного shape що повертає findMany select — TS зрозуміє union без widening. Map-fill loop виносити ПІСЛЯ Promise.all (uniform розподіл, легко читати). НЕ зливати з token-lookup (це pre-guard) — fail-fast 404 семантика залишається першим step.
**Реальний impact:** share-endpoint TTFB: ~3 × P50_RTT (Postgres ~5ms кожен) = ~15ms → ~10ms (33% save). Multiplexed по 3 export-формат (PDF/XLSX/DOCX) — total saved RTT/day на high-traffic share-link = N_shares × 3 × 5ms = N_shares × 15ms aggregate. На public endpoint (без auth, цільовий user-flow клієнта) це різниця між "snappy" і "slightly laggy" preview-link. Для batch send-estimate-SMS workflow (1 share-link → 3-5 хв до open у клієнта → PDF download) — share-window TTL коротший, lookups cold (cache miss).
**Де шукати ще:** будь-який public read-endpoint що знаходить агрегат через share-token або public-id — work-orders.findByShareToken / estimate-export.getEstimateData / invoice-public.findByToken / document-view.getByPublicId / pricing-list-share.findByToken. Завжди парний паттерн: коли один з них оптимізовано, sibling-helper (інший виконуючий ту саму бізнес-логіку) майже завжди лишається sequential через copy-paste evolve. Перевіряти КОЖНУ пару `findBy*Token + getExport*` / `findBy*Token + buildPublicDto*` — sibling-sync mandatory.

---

### 2026-06-16 — Settings/config read-endpoint без Redis cache при high-mount-frequency UI-патерні — sibling settings.X методи мають cache, новий тонкий getter (work-hours/feature-flags/quick-config) НЕ має

**Сигнал:** service-метод (`getWorkHours`/`getFeatureFlags`/`getQuickConfig`) повертає тонке value-object (1-2 scalar fields) з findFirst на settings/config таблиці. Викликається з useEffect `[]` у компоненті-вкладці (Calendar/Dashboard/PriceListPicker) → DB hit на КОЖЕН mount у сесії. Sibling-методи у тому самому service (`getOrganisationSettings`, `getBranchSettings`) уже мають Redis cache 300s з invalidation в update-methods, але новий тонкий getter додавався у naked стилі ("він же тонкий, switch один findFirst — навіщо cache?"). Симптом: у git diff видно invalidation методи (`invalidateOrgCache`, `invalidateBranchCache`) поряд з новим getter без власної інвалідації.
**Grep:** `async get\w+\(orgId.*\): Promise<\{[^}]*Hour\|Days\|Mode\|Enabled` БЕЗ `redis\.get` поряд + `private readonly redis` у constructor → кеш є але не використовується у новому методі. Підтверджуючий сигнал — у `updateBranchSettings`/`updateOrganisationSettings` є `await this.invalidate*Cache()` calls, але вони ОДИНОЧНІ — нових invalidate\*Cache не додавалось коли getter був представлений.
**Причина виникнення:** новий feature додає тонкий read endpoint для специфічного UI потоку (calendar grid potrebує тільки work hours, не full BranchSettings). Розробник копіює findFirst pattern з sibling-getter, але не помічає що у sibling є `try { cached = await redis.get } catch {}` обгортка — code-block виглядає як "boilerplate", легко пропустити. Сам endpoint називається "дешевим" (single field) — інтуїтивно не вартий cache. Реально: викликається з mount-effect що тригериться 5-20 раз на сесію (calendar tab toggle, modal re-open, navigation back/forward).
**Підхід до виявлення:** при перегляді settings.service.ts (або analogous config-service) — порівняти всі public get-методи: чи мають вони патерн `cacheKey + redis.get + JSON.parse + fallback + redis.set + TTL`? Якщо у service є один getter без cache при наявності RedisService у constructor — кандидат на додавання. Перевірити викликаюче UI (mount frequency) у компоненті: useEffect `[]` → точно треба cache. useEffect `[id]` де id рідко змінюється → теж треба.
**Підхід до фіксу:** (1) Додати окрему cacheKey + TTL constant (`WORK_HOURS_TTL_SECONDS = 60` — коротший за головний settings бо work-hours можуть бути terra-incognita-quick-change). (2) Wrap: `try { const cached = await this.redis.get(key); if (cached) return JSON.parse(cached) } catch {}` → query → `try { await this.redis.set(key, JSON.stringify(result), 'EX', TTL) } catch {}`. (3) Додати `invalidateXCache(orgId)` метод. (4) У відповідному update-методі (наприклад `updateBranchSettings`) додати conditional invalidation тільки коли relevant fields (workStartTime/workEndTime) реально змінилися у dto — інакше плодиш cache misses при PATCH-ах інших полів. (5) Cache scope (orgId vs orgId+branchId) має відповідати actual scope значення — якщо метод повертає org-wide config, ключ orgId-only.
**Реальний impact:** Calendar mount: 1 DB findFirst з orderBy за nested relation (`branch.createdAt`) → 1 Redis GET. Per orgId / per 60s: ~5-20 mount events stay у cache → 1 DB hit замість 5-20. На SaaS з 50+ org-ів полегшує DB connection pressure у peak-години (ранкова навігація операторів). У single-tenant deployment — instant calendar mount замість cold-DB вікна.
**Де шукати ще:** будь-який settings/config service (settings.service.ts, app-config.service.ts, infrastructure.service.ts) з тонкими getter-ами для specifіc UI потоків — UI-features, dashboard-config, quick-stats, notification-defaults, theme-config, default-warehouse. Особливо суміжно — checkpoint для нових features: коли додаєш UI-вкладку що читає `GET /settings/X` — додай інвалідацію поряд з кешем у тому самому commit (інакше cycle-N gap у наступному оптимізаційному раунді).

---

### 2026-06-16 — Nested loop `outerList.find(o => innerList.some(i => i.fkField === o.id && intervalOverlap(i, slot)))` у hot-path availability/conflict-detection — bucket inner list by FK у Map<fkValue, []> один раз + pre-parse Date→Ms у числа

**Сигнал:** service-метод (booking.getAvailability, calendar conflict-check, scheduling helpers) генерує candidate window list (timeslots, dates, intervals) і для КОЖНОГО елемента window-у викликає `outerArr.find(outer => !innerArr.some(inner => inner.fk === outer.id && new Date(inner.startAt) < window.end && new Date(inner.endAt) > window.start))`. Той самий патерн на frontend — `bookings.map(b => lifts.find(lift => !calSlots.some(s => s.liftId === lift.id && ...)))`. Структура: outer collection (N=5-50 lifts/branches/employees), inner collection (M=100-500 slots/movements/transactions) фільтрується по FK + interval overlap. Outer цикл (T=20-50 candidate windows) множить вартість на T×N×M. Plus кожен interval check робить `new Date(inner.X)` allocation — alloc-heavy hot path.
**Grep:** `\.find\([^)]+=>\s*!\w+\.some\(` АБО `\.find\([^)]+=>\s*\w+\.some\([^)]+\w+Id === \w+\.id[\s\S]{0,200}new Date\(`
**Причина виникнення:** код виглядає декларативно ("знайди вільний lift" = "find lift where no slot overlaps") — читабельний, легко reasoning. Розробник не задумується про N×M складність бо колекції здаються малими у dev (5 lifts, 10 slots). Production з 50 lifts × 500 slots × 20 timeslots раптом стає 500_000 ops + 10_000 Date allocs per request. `new Date(string)` всередині .some() — частий приховуваний винуватець: один find() з 50 elements внутрішнього циклу — 100 Date allocations.
**Підхід до виявлення:** при перегляді service-методу що повертає availability/conflicts/free-resource list — знайти `.find()` АБО `.filter()` у outer циклі ЯКЩО predicate робить `.some()`/`.find()` по другому масиву з FK-equality match. Якщо є — кандидат на bucket-by-FK. Особливо: predicate з `new Date(stringField) < end && new Date(stringField) > start` — додатковий сигнал alloc-heavy hot path. Frontend еквівалент: useMemo-обернений booking-to-lift assignment, або render-time `.find()` у map-loop.
**Підхід до фіксу:** двофазна трансформація: (1) **Bucket inner array by FK у Map<fkValue, []>** перед outer циклом — `const bucketByFk = new Map(); for (const i of innerArr) { if (!i.fk) continue; const arr = bucketByFk.get(i.fk); if (arr) arr.push(i); else bucketByFk.set(i.fk, [i]); }`. O(M) one-time setup. (2) **Pre-parse Date→Ms numbers** під час bucket-побудови — `const parsed = { startMs: new Date(i.startAt).getTime(), endMs: new Date(i.endAt).getTime() }; arr.push(parsed)`. Один Date.parse() per inner element замість T×N×Date.parse(). (3) У predicate замість `.some()` — explicit for-loop з числовим порівнянням: `const busy = bucketByFk.get(outer.id); if (!busy) return true; for (const p of busy) { if (p.startMs < windowEndMs && p.endMs > windowStartMs) return false; } return true;`. Семантично еквівалентно, але O(T × N × avg(M/N)) замість O(T × N × M) + 0 Date allocs у hot loop.
**Реальний impact:** booking.getAvailability з 50 lifts × 500 busy slots × 20 timeslots: ~500_000 ops + ~10_000 Date allocations per request → ~10_000 ops + ~1000 Date allocations (50× CPU, 10× GC pressure reduction). На public endpoint (без auth, високий RPS) це різниця між survivable і lock-up. Frontend еквівалент (useCalendarState.load): кожна зміна date перебудовує асигнацію bookings → ріжемо blocking time у main thread.
**Де шукати ще:** будь-який scheduling/availability/conflict-detection код — calendar (slot conflicts), booking (free resource picking), inventory (FIFO/LIFO batch selection з overlapping reservations), settlements (period transactions overlap), pricing rules (overlapping date ranges). Frontend: useMemo-обернутий filtered subset де outer.map → inner.find/.some з FK match. Завжди перевіряти чи inner-collection парситься з string→Date inside hot loop — це індикатор додаткового виграшу.

---

### 2026-06-16 — `useMemo<T[]>(() => [], [])` всередині компонента для stable-empty-array placeholder — module-level const замінює без зміни семантики

**Сигнал:** компонент має `const EMPTY_X = useMemo<X[]>(() => [], [])` (або з `useMemo(() => new Map(), [])`) — empty-collection placeholder для default fallback (`slotsByLift.get(id) ?? EMPTY_X`). useMemo з deps `[]` повертає той самий ref між render-ами поточного mount, але на КОЖНОМУ mount створює новий `[]`. Семантично identity-stable між render-ами одного mount; alloc на mount без потреби.
**Grep:** `useMemo<\w+\[\]>\(\(\) => \[\], \[\]\)` АБО `useMemo\(\(\) => new Map\(\), \[\]\)` АБО `useMemo\(\(\) => new Set\(\), \[\]\)`
**Причина виникнення:** розробник пам'ятає правило "literal `[]` у JSX → нова reference кожен render → memo дочірніх скидаються". Інтуїтивно тягне useMemo. Не задумується що empty collection — стале значення; для нього достаточно module-level const (один alloc на entire app lifetime, не на mount).
**Підхід до виявлення:** grep по useMemo з `() => []`/`() => new Map()` deps `[]`. Якщо колекція ніколи не модифікується (frozen-empty placeholder) — кандидат на module-level. Якщо ж замість деструктурування з deps використовується нова empty-collection при певних умовах (наприклад dynamic-import or feature-flag fallback) — лишити useMemo.
**Підхід до фіксу:** просто перенести: `const EMPTY_BOOKINGS: BookingSlot[] = [];` на module-level (поза функцією-компонентом). Видалити рядок `const EMPTY_X = useMemo(...)` всередині. Identity-стабільність зберігається (та сама reference на всі mounts всіх instances). Якщо колекція використовується між модулями — export const.
**Реальний impact:** на mount компонента: -1 alloc (`[]`) + -1 useMemo hook slot. Незначно у мс, але "чистіше" — empty-collection не є реактивним значенням, не потребує hook infrastructure. Особливо корисно у списках/grids що часто re-mount-яться (calendar day toggle, modal open/close).
**Де шукати ще:** усі компоненти з `EMPTY_*`/`DEFAULT_*` через useMemo `[]` — calendar widgets, DetailPanel containers, EntityPickerField fallback states, useReducer initial empties. Часто симптом copy-paste з реальної useMemo-обгорненої колекції.

---

### 2026-06-15 — Collapsible-header `chips` массив у form-modal: inline IIFE `headerCollapsed ? [supplierDisplay, refList.find(...).name, contractNumber].filter(Boolean) : []` всередині render — recompute на КОЖЕН typing keystroke у inner Input

**Сигнал:** form-modal (PurchaseOrderCreateModal, StockDocumentCreateModal, CreateWorkOrderModal) має collapsible header з `headerChips` = масив бейджів що зʼявляються коли header згорнутий. Розробник пише inline: `const headerChips = headerCollapsed ? [supplierDisplay || null, form.warehouseId ? warehouses.find(w => w.id === form.warehouseId)?.name ?? null : null, contractNumber ? \`Дог. ${contractNumber}\` : null].filter(Boolean) : [];` ПЕРЕД return-блоком. На КОЖЕН render (зокрема `setForm(...)` після typing у Input "Примітки") масив пересоздається, `warehouses.find()` робить O(N) скан, `.filter()` алокує новий array. Якщо колекція `warehouses` дорога (хоча зазвичай малі ~5-20 елементів) — це 3-5× O(N) на typing.
**Grep:** `const \w+Chips = \w+Collapsed \?[\s\S]{0,400}\.find\([\s\S]{0,200}\.filter\(Boolean\)` АБО `^\s*const \w+ = .*\? \[\s*$`блоки де array будується inline з`.find()`всередині елементів.
**Причина виникнення:** "chips — це похідне від collapsed state" виглядає як inline-обчислення, не потребує useMemo. Розробник інтуїтивно ставить декларацію поруч з JSX де chips рендеряться. Не помічає що Inputs у тому ж компоненті фірять`setForm(...)`на кожен keystroke → re-render → headerChips recompute → новий array identity →`.map(chip => <span key={chip}>...)`теж recompute (key-based DOM diff лишається стабільним, але React-reconciler все одно витрачає JS overhead на порівняння).
**Підхід до виявлення:** при перегляді form-modal шукати JSX-attr`<HeaderToggle headerChips={headerChips} />`АБО`{headerChips.map(...)}`. Простежити decl `headerChips`— якщо inline ternary з`.find()`всередині → recomputed на render. Перевірити чи Modal містить controlled Input/Textarea що фірять`setForm`/`setNotes` — підтверджує ризик. Особливо коли header містить supplier/warehouse/contract — три ref-data lookups.
**Підхід до фіксу:** двофазний refactor: (1) Підняти reference-data Map (`warehouseById = useMemo(() => new Map(warehouses.map(w => [w.id, w])), [warehouses])`) — O(1) lookup замість O(N) find. (2) `useMemo`навколо`headerChips`з deps`[headerCollapsed, supplierDisplay, form.warehouseId, warehouseById, contractNumber]`. Тепер chips identity-стабільні поки collapsed або одне з реактивних полів не зміниться → typing у `notes` не тригерить chips recompute → no JSX-children identity-thrash для child Header strip.
**Реальний impact:** PurchaseOrderCreateModal має ~50 fields/inputs у формі; typing у "Примітки" зазвичай 20-50 keystrokes. Кожен setForm: 50 keystrokes × 3 ref-list-find + 3 elem alloc + 1 array alloc → 250-300 wasted ops on collapse-strip per editing session. Незначно у мс, але важлива чистота для majority render-frequency components (controlled forms + chip displays).
**Де шукати ще:** будь-який form-modal/edit-page з collapsible header (всі великі creation modals: WO, Invoice, Estimate, PO, SD, SR, BookingRequest). Той самий патерн діє для breadcrumb-strips, tag-displays, "Recent items" widgets у sidebar — будь-яких inline array-builders з reference-data lookups.

---

### 2026-06-15 — Form/modal totals `reduce(...)` поза useMemo — викликається на КОЖЕН render навіть коли lines не змінились (typing у unrelated Input)

**Сигнал:** form-modal з табличкою рядків (lines/items/parts/products) має footer/total: `const total = totalFromLines(lines);` АБО inline `const total = lines.reduce((s, l) => s + qty * price, 0);` без useMemo. Поряд є кілька controlled Inputs (notes/date/supplier) що фірять setState на typing. Кожен render → total recompute O(N) reduce навіть коли lines незмінні. PurchaseOrderCreateModal вже мав memo на total. SupplierReturnCreateModal — НІ (наслідок copy-paste-evolve розриву). На малих listах (5-10 lines) impact мізерний, але це регресія консистенції — паралельні components мають консистентну memo-ізацію.
**Grep:** `const total = \w+\(\w+\);$` АБО `const total = \w+\.reduce\([\s\S]{0,300}\);[\s\S]{0,100}return \(` (без `useMemo`/`useCallback` між decl і use).
**Причина виникнення:** модалки створюються через copy-paste старшого компонента, потім розходяться у розвитку. Один отримує `useMemo` під час оптимізаційного циклу, інший лишається з inline-call. При наступному перегляді розробник дивиться на `const total = ...` рядок і не задумується "коли це викликається?" — приймає як cheap.
**Підхід до виявлення:** при перегляді form-modal знайти `const total = ` (або `Total`/`subtotal`/`sum`/`amount` decl). Перевірити чи помічений `useMemo`. Якщо ні — простежити чи lines у parent-state. Якщо так — потенціал для memo. Перевірка кросс-component консистентності: коли paired-file (similar modal) має memo, інший має inline call — fix the inconsistency.
**Підхід до фіксу:** `const total = useMemo(() => totalFromLines(lines), [lines]);` АБО якщо total потребує VAT/discount — single-pass `useMemo(() => { let total = 0; let vat = 0; for (const l of lines) {...}; return { total, vat }; }, [lines])` (див. також 2026-06-11 Twin-scan reduce у tfoot/footer pattern). Header chips/derived strings слідують тій самій парадигмі.
**Реальний impact:** typing у "Примітки" поля з 10-рядковою таблицею: 30 keystrokes × 10 reduce iterations = 300 wasted ops per editing session. На великих документах (100+ позицій) — 3000 wasted iterations. Мінорно у мс, важливо як консистентність патерну.
**Де шукати ще:** парні modal-компоненти що були copy-pasted один з одного: PurchaseOrderCreateModal ↔ SupplierReturnCreateModal, EstimateModal ↔ InvoiceModal, StockDocumentCreateModal ↔ ReceiveModal, CreateWorkOrderModal ↔ EditWorkOrderModal. Завжди перевіряти кросс-консистентність memo після рефакторингу одного з пари.

---

### 2026-06-15 — Row-handler async function inline `const X = async (item) => {...}` без useCallback у list-page → inline arrow `onClick={() => void markX(item)}` для КОЖНОГО з 20 рядків → нова arrow identity на render

**Сигнал:** list-page (purchase-orders, stock-documents, work-orders, counterparties) має 5-10 row-handlers: `handleTransition`, `markDeleted`, `applyPricing`, `loadDetail`, `openReceive`. Усі — `const X = async (po: PurchaseOrder, ...) => {...}` БЕЗ useCallback. У `.map(po => <TableRow><button onClick={() => void markDeleted(po)}>...)` — inline arrow recreated × 20 rows × кожен render. Поки що рядки НЕ memo-узовані (нема React.memo на TableRow), тож impact obscured. Але це гальмує майбутнє введення memo. Симптом: при switching tabs/typing у global filters парент re-renders → всі 20 button onClicks мають нові references → React fiber-reconciler треба порівняти props у всі 20 cells.
**Grep:** `const handle\w+ = async \([^)]+\) => \{` без `useCallback` навколо у list-page файлах. Парено з `onClick=\{\(\) => void handle\w+\(\w+\)\}` у `.map()`.
**Причина виникнення:** list-page файли великі (300-1500 LOC). Розробник пише handler швидко як `const = async` бо це менше boilerplate ніж `const = useCallback(async, [...])`. Усвідомлення приходить пізно — коли треба ввести memoized TableRow і виявляється що props identity нестабільна.
**Підхід до виявлення:** при перегляді list-page файлу шукати ВСІ `const handle\w+ = async`. Кожен такий handler який використовується у row-render-context (всередині `.map()` через inline arrow або direct prop) — кандидат на useCallback. Стратегія повна: усі row-handlers одночасно, не точково. Опір "але я не memo-узую row" — false economy, useCallback дешевий і готує файл для майбутніх змін.
**Підхід до фіксу:** обгорнути кожен handler у useCallback з мінімальними deps: `useCallback(async (po) => {...}, [confirm, queryClient])`. Для handler-ів що залежать від іншого handler-а (наприклад `openReceive → loadDetail`) — порядок declaration важливий: спершу залежний handler з useCallback, потім зовнішній з useCallback що включає його в deps. Якщо handler використовує функцію типу `load` (recreated кожен render) — eslint-disable-next-line з коментарем чому це OK (semantically той самий load, identity-change irrelevant for click-time closure).
**Реальний impact:** stable button onClick identities дозволяють у майбутньому ввести `memo(TableRow)` без identity-thrash → 20 row re-renders → 0 коли selection/filter не зачіпає row. Зараз без memo на TableRow impact ≈ 0мс, але це інвестиція у наступний рефакторинг.
**Де шукати ще:** усі list-page файли (catalog/inventory/work-orders/invoices/counterparties/employees тощо). Уніфікувати стиль: ВСІ async row-handlers — useCallback. Workflow: один pass на файл, не точково.

---

### 2026-06-15 — Branching ternary `cond ? findFirst(validate-by-id) : findFirst(auto-pick-by-criteria)` всередині Promise.all — single optional FK з двома різними query shapes у одному слоті

**Сигнал:** create-сервіс приймає optional FK (contractId/employeeId/branchId) з двома гілками логіки: (A) якщо клієнт надав ID — validate що entity належить scope (orgId + parentEntityFK + type-discriminator), (B) якщо не надав — auto-pick "primary" entity за критерієм (isPrimary=true OR createdAt min/max). Колишній код пише `let entityId = dto.X ?? null; if (entityId) { const provided = await ..findFirst({where:exact-id}); ... } else { const auto = await ..findFirst({where:criteria, orderBy:...}); entityId = auto?.id ?? null; }` ПІСЛЯ Promise.all для основних FK guards (supplier/warehouse). Sequential `if/else` додає 1 RTT навіть коли основні FK guards проходять миттєво.
**Grep:** `let \w+Id = dto\.\w+Id \?\? null;[\s\S]{0,500}if \(\w+Id\) \{[\s\S]{0,300}findFirst[\s\S]{0,300}\} else \{[\s\S]{0,300}findFirst[\s\S]{0,300}orderBy`
**Причина виникнення:** код виглядає лінійно "якщо дано — провалідуємо, не дано — авто-вибір". Розробник інтуїтивно поза Promise.all сприймає це як "розрізнення логіки" (різні where/orderBy). Не помічає що предикати обох гілок відомі синхронно з DTO + scalars (counterpartyId=dto.supplierId, типу контракту). Жодна гілка не залежить від результату supplier-guard у Promise.all.
**Підхід до виявлення:** при перегляді create()/update() сервісу шукати `if (dto.X) {...validate...} else {...auto-pick...}` БЛОК ПІСЛЯ Promise.all для FK guards. Перевіряти чи обидві гілки findFirst мають синхронно-доступні where-предикати (lookup-by-id або lookup-by-criteria). Якщо так — мерджити у Promise.all як третій ternary-slot.
**Підхід до фіксу:** трирядковий refactor: (1) Додати тернарку `const hasContractId = !!dto.X;` ДО Promise.all (фіксує гілку). (2) Виlift тернарку у Promise.all: `hasContractId ? findFirst({where:exact-id}) : findFirst({where:criteria, orderBy:...})`. (3) Post-Promise.all: `if (hasContractId && !contract) throw NotFound; const contractId = hasContractId ? (contract as {id:string}).id : (contract?.id ?? null);` — типобезпека через cast у validate-branch (NotFound уже забезпечує не-null). Throw order збережено.
**Реальний impact:** PO create() з contractId переданим: 3 RTT → 2 RTT (33% time-save). Без contractId — 3 RTT → 2 RTT (auto-pick parallel з supplier/warehouse). На high-RPS endpoint це звільняє Prisma connection швидше.
**Де шукати ще:** будь-який create()/addX() сервісу що приймає optional FK з auto-pick fallback (primary contract, default warehouse, primary employee, default branch, primary bank account, default currency). Особливо коли поверх стоїть "Auto-pick optional FK резолюція ПІСЛЯ паrallel FK guards" pattern — він описує єдину гілку (auto-pick), цей — описує обидві гілки (validate + auto-pick) у тому самому слоті.

---

### 2026-06-15 — Sequential `findFirst (tenant guard) → create + update` пара у $transaction де create і update пишуть у РІЗНІ таблиці але читають той самий entity.id зі scope — settlements/payments/balance-update триплет

**Сигнал:** сервіс-метод (settlements.createTransaction, account-update, balance-mutate) має шаблон: `const account = await db.X.findFirst({where:tenant guard}); if (!account) throw; await db.Y.create({data:{settlementAccountId: account.id, ...}}); await db.X.update({where:{id: account.id}, data:{balance: {increment: delta}}})`. Sequential `create` (append-only event-log row) + `update` (mutate aggregate balance) — обидва читають `account.id` зі scope, не залежать один від одного. Між create і update РІЗНІ таблиці (SettlementTransaction vs SettlementAccount), різні primary keys. У Postgres-tx на одному pinned connection writes resolve concurrently.
**Grep:** `await \w+\.\w+\.findFirst[\s\S]{0,200}await \w+\.\w+\.create\([\s\S]{0,400}await \w+\.\w+\.update\(`
**Причина виникнення:** сервіс-метод читається як event-log paтterн (create-event → mutate-aggregate). Розробник інтуїтивно ставить update ПІСЛЯ create — "спочатку записати подію, потім оновити баланс". Реально: і create і update залежать ТІЛЬКИ від account.id (read once у findFirst), порядок між ними не має значення для бізнес-семантики (балансовий increment атомарний у $transaction). Бесь sequential pattern — лише JS-event-loop overhead.
**Підхід до виявлення:** у service-методі знайти триплет `findFirst + create + update` де: (1) findFirst — tenant guard з `select: {id: true}` (або вузький projection), (2) create читає лише `.id` зі scope, (3) update читає лише `.id` зі scope. Якщо так — кандидат на post-guard Promise.all. Інша евристика: якщо метод приймає типу "create event + mutate aggregate" → майже завжди фіксуємо.
**Підхід до фіксу:** (1) Якщо є sync pre-compute (наприклад `balanceDelta` через if-else по type-enum) — підняти ДО $transaction для fail-fast на unknown enum. (2) Усередині $transaction: `findFirst` залишити sequential (entity мусить існувати), потім `await Promise.all([X.create(...), X.update(...)])`. (3) Звузити findFirst до `select: { id: true }` якщо інші поля не використовуються.
**Реальний impact:** settlement.createTransaction викликається на: WO COMPLETED (1× в потоці), invoice PAID (1×), payment.create (1×). На 100 WO/day з PO receive + WO complete + invoice + payment ~4 settlement.createTransaction/WO × 100 WO = 400 викликів/day → 400 RTT saved/day. Малий impact індивідуально, але на high-volume SaaS суттєвий.
**Де шукати ще:** будь-який append-only event-log + aggregate-mutate тandem: payment.create + invoice.balanceDue.decrement, stock-movement.create + stock-item.quantity.increment, audit-event.create + entity.update. Особлива увага: якщо create та update пишуть у ту саму таблицю → ОБЕРЕЖНО (race-condition можливий навіть на pinned connection якщо updateMany torgує одним рядком), завжди писати у РІЗНІ таблиці.

---

### 2026-06-15 — Chunked bulk-update loop `for (const u of chunk) await tx.X.update(...)` у $transaction де input plan МОЖЕ мати duplicate PK — Promise.all + Map-dedup last-wins

**Сигнал:** bulk-pricing/bulk-import-сервіс (applyRule, applyPricing з PO/xlsx) будує `plan: {goodId, newPrice, ...}[]` через ітерацію по lines/rows, потім `for (let i = 0; i < plan.length; i += CHUNK) { await $transaction(async tx => { for (const u of chunk) await tx.X.update({where: {id: u.goodId}, data:...}) }) }`. Sequential `tx.X.update` у chunk пишуть disjoint PK rows (різні goodId) — кандидат на Promise.all. АЛЕ: коли plan будується з джерела де ОДИН товар може з'явитися кілька разів (PO має кілька ліній того ж goodId за різну ціну, xlsx import має multi-SKU lookup на той самий good) — sequential loop неявно мав last-write-wins семантику. Promise.all на duplicate goodId викликає race-condition: невизначено, яка з двох конкуруючих update перемагає. Окремо: priceHistory.createMany усередині того ж chunk теж пише по N рядків — N duplicates у audit log.
**Grep:** `for \(const \w+ of chunk\) \{[\s\S]{0,200}await tx\.\w+\.(update|updateMany)`
**Причина виникнення:** chunked bulk pattern — стандартна оптимізація проти ловлі великих транзакцій. Sequential await читається безпечно ("обережно, по одному"). Розробник не задумувався чи входи унікальні — plan accumulator проходить через ввід "rows/lines" які можуть мати дублі.
**Підхід до виявлення:** для кожного chunked bulk-update loop у $transaction — простежити походження plan accumulator. Якщо `plan` будується з `findMany(table).map(...)` де table має unique PK — дублі неможливі (safe to Promise.all). Якщо `plan` будується з `for (const line of parent.lines) plan.push({goodId: line.goodId, ...})` — duplicates можливі коли parent має >1 line з тим самим FK. Те саме для xlsx/csv import: дві row з різним SKU можуть резолвити в той самий good.
**Підхід до фіксу:** spec-аналіз джерела plan ДО Promise.all: (1) Якщо джерело гарантує unique PK (findMany результат, IDs з Set) — просто Promise.all (race-safe бо disjoint writes). (2) Якщо джерело МОЖЕ мати duplicate PK — `const deduped = Array.from(new Map(plan.map(u => [u.pkField, u])).values())` ДО Promise.all. Map last-wins зберігає старий sequential semantic ("остання спроба перемагає"). priceHistory.createMany (audit log) сам по собі тепер пише унікальні рядки — це позитивний side-effect (не дублює N записів аудиту на одну зміну).
**Реальний impact:** chunk=100, N=10 chunks → 1000 sequential `await` мікрозадач event-loop → 10 batches of Promise.all (100 microtasks per batch resolved у єдиній мікротасці). У Prisma $transaction справжнього паралелізму немає (pinned connection serializes SQL), але економія JS-event-loop overhead помітна на великих listах (1000+ goods).
**Де шукати ще:** будь-який chunked update loop у $transaction для bulk operations: pricing rules, list pricing import, bulk discount apply, mass status change, cleanup workers. Особлива увага коли plan будується з parent.lines/parent.children (можливі дублі) vs з findMany результату (PK-unique).

---

### 2026-06-15 — Inventory-mutation helper + parent-line metadata update — sequential await пара у per-line $transaction loop де writes ідуть у РІЗНІ таблиці (cross-table side-effect helper vs scalar column update)

**Сигнал:** service-метод що applies effect документу (PO receive(), SD transition(CONFIRMED), WO complete) має `await this.prisma.$transaction(async tx => { for (const line of doc.lines) { await this.inventory.createMovement(...) ; await tx.purchaseOrderLine.update({ ...UoM persist... }) ; ... } })`. Перший await — high-level helper що внутрішньо пише у >1 таблиць (StockMovement + StockBatch + StockItem upsert + ...). Другий — узкоспеціалізований `tx.X.update({ where: { id: line.id, ...}, data: { unitOfMeasureId, receivedQty: { increment } } })` що пише у parent line row. Sequential await блокує — кожен RTT × N ліній множиться. Для TRANSFER-документів додатково має 2 послідовних `createMovement` (writeoff source warehouse → receipt target warehouse) — disjoint StockItem keys, race-safe.
**Grep:** `for \(const \w+ of \w+\.lines\) \{[\s\S]{0,500}await this\.inventory\.createMovement[\s\S]{0,300}await tx\.\w+Line\.update`
**Причина виникнення:** helper-методи (`inventory.createMovement`, `settlements.createTransaction`) виглядають "важкими" — розробник інтуїтивно ставить їх sequential. Parent-line `update` бачиться як "продовження тієї ж операції" — інтуїція "це треба робити після того, як движение створено". Реально: `createMovement` пише в `StockMovement`/`StockBatch`/`StockItem` (composite key `orgId+goodId+warehouseId`), `parentLine.update` пише в `PurchaseOrderLine` (composite key `id+orgId`). НЕ перетинаються — Postgres резолвить writes на тій самій tx connection concurrently без deadlock.
**Підхід до виявлення:** при перегляді `$transaction` callback з `for (const line of doc.lines)` — для кожної пари await перевірити чи writes ідуть у РІЗНІ таблиці. Якщо так — Promise.all. Особливо звертати увагу на helper-методи (`inventory.X`, `settlements.X`, `pricing.X`) бо їхні внутрішні writes ховаються від огляду — потрібно знати схему side-effects helper'у.
**Підхід до фіксу:** `await Promise.all([inventory.createMovement(...), tx.parentLine.update(...)])`. Conditional UoM update — `lineUnitId ? tx.parentLine.update(...) : Promise.resolve()` зберігає тип Promise<unknown>. Для TRANSFER — все три (writeoff + receipt + UoM update) у Promise.all, бо source/target warehouses disjoint. Loop-carried state (receivedAmount += ..., results.push) лишається post-await — ітерації сериальні (правильно), всередині — concurrent.
**Реальний impact:** на PO receive() з 10 partial-receive lines: 10×2=20 sequential RTTs → 10×1=10 parallel-pair RTTs (50% time-save). На SD CONFIRMED transition з 5 lines: 10 RTTs → 5 RTTs. На TRANSFER: 15 RTTs → 5 RTTs.
**Де шукати ще:** будь-який `service.X(...)` що applies side-effects з документу на inventory/settlements/queue: invoice payment apply (line-update + payment-record-create), credit note refund (line-update + settlement-create), WO complete (createMovement per part + part.update), receive po (createMovement + line.update + settlement.createTransaction в кінці), credit-charge reversal у CRM.

---

### 2026-06-15 — N-FK guards у update() з conditional шляхами (if dto.X) — третій FK validation з cross-dependency на dto.supplierId/effective entity

**Сигнал:** PATCH/update service-метод приймає DTO де декілька FK (`dto.supplierId`, `dto.warehouseId`, `dto.contractId`) — всі optional. Розробник пише три послідовних `if (dto.X) { const X = await prisma.X.findFirst({...}); if (!X) throw NotFound }` блоків (validation для кожного FK). Іноді останній FK має cross-dependency на попередній — `effectiveSupplierId = dto.supplierId ?? po.supplierId` для contract validation. Конкретний симптом: 3 послідовних findFirst де перші два повністю незалежні, а третій залежить лише від dto-state і поточного rec (поточного `po.supplierId`), НЕ від результату попередніх findFirst.
**Grep:** `update\(orgId.*dto.*\)[\s\S]{0,200}if \(dto\.\w+Id\) \{[\s\S]{0,300}findFirst[\s\S]{0,300}if \(dto\.\w+Id\) \{[\s\S]{0,300}findFirst`
**Причина виникнення:** код виглядає лінійно "захищаємо кожен FK окремо" — це безпечно і легко read. Conditional шляхи (`if (dto.X)`) інтуїтивно сприймаються як "не треба чіпати якщо не передано". Cross-dependency на `effectiveSupplierId` маскує що contract validation НЕ блокована результатом supplier validation — третій запит лише читає `dto.supplierId ?? po.supplierId` (скаляр у scope).
**Підхід до виявлення:** при перегляді update()/patch() — зчитати ВСІ FK validation блоки і запитати "які з них дійсно потребують результату попереднього?". Cross-dependent FK (наприклад contract validation через `dto.supplierId ?? po.supplierId`) — ЦЕ НЕ блокування на результат findFirst, це scalar lookup. Все три у Promise.all валідно якщо предикат лежить у dto/existing-rec (доступний синхронно).
**Підхід до фіксу:** обчислити `effectiveXxxId = dto.xxxId ?? po.xxxId` синхронно ДО Promise.all. У Promise.all — три тернарки `dto.X ? findFirst({...}) : Promise.resolve(null)`. ПІСЛЯ awaits — guard `if (dto.X && !result) throw NotFound` (порядок не страждає: throw кидається з першої проблеми, всі запити вже виконані). Якщо є post-processing (наприклад `newContractId = contract.id`), він йде після всіх throw-блоків — той самий fast-fail контракт що sequential pattern.
**Реальний impact:** на update() запит що змінює супplier+warehouse+contract в одному PATCH (типова форма "edit all fields у DRAFT") — 3 sequential RTT → 1 parallel RTT = 67% time-save. На SaaS з 50+ org-ів полегшує shared connection pressure при concurrent edits.
**Де шукати ще:** будь-який update()/patch() сервісу що приймає optional FK + cross-dependent third lookup — invoice.update (counterpartyId+warehouseId+priceListId), workOrder.update (vehicleId+counterpartyId+contractId+liftId), stockDocument.update (warehouseId+targetWarehouseId+contractId якщо буде).

---

### 2026-06-14 — Detail-panel/Drawer/Modal будівник через IIFE `(() => { const build = ...; return <Panel tabs={selectedItem ? build(selectedItem) : undefined} /> })()` у тілі parent list-page — tabs object identity рекреюється на КОЖЕН render

**Сигнал:** list-page має secondary panel (DetailPanel/Drawer/Modal/Slide-over) з вкладеним tabs масивом будуваним у JSX-тілі parent через IIFE `(() => { const buildX = (item) => [...]; return <Panel tabs={selectedItem ? buildX(selectedItem) : undefined} configFields={schemaToConfigFields(SCHEMA, panelConfig.config)} ... /> })()`. tabs array і configFields пересоздаються при КОЖНОМУ render parent — навіть якщо selectedItem не мінявся. Якщо у panel.useEffect deps містять onClose/tabs identity (типовий case у Modal/keydown listeners) → ефект re-fires → `addEventListener`/`removeEventListener` чашка + Input focus у inner controls (наприклад редагування minStock) скидається.
**Grep:** `\{\(\(\) =>` у JSX-тілі великих компонентів (>300 LoC) поряд з `<DetailPanel|<Modal|<Drawer|<SlidePanel`.
**Причина виникнення:** натуральна реакція коли "tabs залежать від selectedItem" — інлайн закриття дає миттєвий доступ до state без props drilling. IIFE здається легким — "lambda всередині JSX, нічого не коштує". Реально: tabs.content включає вкладений `<Input value={minStockVal} onChange={e => onChangeX(e.target.value)} />` де onChange — inline arrow, recreated на render → memo дочірніх не зловить identity-stable і re-render піде каскадом до Modal/keydown effects.
**Підхід до виявлення:** при перегляді list-page файлу шукати IIFE pattern перед `<Panel tabs={...} />`. Перевіряти що (1) tabs будуються динамічно, (2) контент tabs має controlled Input/Select (особливо minStock-edit, deviceId-pick, password-set). Якщо хоча б одне виконано — потенційний focus-loss бажано перевірити вручну у DevTools profiler.
**Підхід до фіксу:** двофазний refactor: (1) Винести у memo-компонент `XDetailPanel` на module-level з explicit props (selectedItem, editingX, onCloseX, onSaveX, panelConfig...). (2) Всередині — `const tabs = useMemo(() => { ... }, [selectedItem, editingX, ...])`. configFields теж useMemo з deps на `panelConfig.config`. (3) У parent — всі handlers через useCallback (onCloseDetail, onStartEditX, onSaveX...). Type для panelConfig prop — `ReturnType<typeof useDetailPanelConfig>` (alias на module-level для перевикористання).
**Реальний impact:** typing у parent search debounce: кожен render → tabs identity stable → Modal.useEffect skips re-add listener → Input focus у edit-mode не зривається. Subjective UX (Input focus loss) > мс.
**Де шукати ще:** будь-яка list-page з DetailPanel/Drawer/Modal збудованим inline (counterparties, work-orders, invoices, purchase-orders, stock-documents — всі мають "edit field у panel" pattern). Особливо ризиковано при поєднанні з debounce-search у parent.

---

### 2026-06-14 — Новий list/report endpoint з date sort без covering index — `findMany({orderBy: createdAt, take})` сканує таблицю seqscan коли existing index не покриває WHERE pattern

**Сигнал:** новий feature додає endpoint що робить `findMany({where: {orgId, [optionalCol1], [optionalCol2], [createdAt range]}, orderBy: {createdAt}, take: N})` на high-write append-only таблицю (StockMovement, AuditLog, Notification, BatchConsumption). Існуючі індекси покривають типові паттерни старих endpoint-ів (наприклад `(orgId, warehouseId, createdAt)`), але новий endpoint має more permissive WHERE — `warehouseId` тепер optional, або filter тільки по `goodId`. Postgres вимагає leading-cols match для index seek — якщо `warehouseId` IS NULL у WHERE, index `(orgId, warehouseId, createdAt)` не вибирається → seqscan + external sort на take:N рядках.
**Grep:** `findMany.*orderBy.*createdAt` + `take: \d{3,}` + перевірити `grep "@@index" packages/database/prisma/schema.prisma` на таблиці. Якщо найкращий індекс має >1 col перед `createdAt` що ця query не фільтрує — гап.
**Причина виникнення:** старі індекси проектувались під старі endpoint-и. Новий звітний endpoint часто має ширшу area (all-warehouses, all-goods, by-date). Розробник пише `findMany` стандартно, не задумуючись про explain.
**Підхід до виявлення:** при review-of-perf — спершу зібрати усі WHERE patterns для конкретної таблиці (grep по `prisma.X.findMany` + наступні рядки `where:` block). Для кожного унікального set фільтрів — перевірити чи існує index що (a) має `orgId` (tenant guard) як leading col, (b) включає sortKey у tail, (c) optional cols вкладені у середині (порядок: фікс → optional → sort).
**Підхід до фіксу:** додати COVERING index у форматі `@@index([orgId, sortKey])` для unfiltered case + `@@index([orgId, optionalCol, sortKey])` для кожного типового фільтру. Не плодити надлишкові — Postgres може брати prefix існуючого `(a,b,c,d)` як `(a,b,c)` index, тому додаємо тільки коли prefix не покриває. У commit-message — explain trace (current plan: seqscan; expected: index scan).
**Реальний impact:** для звітного endpoint з take:3000 на таблиці 100k-500k рядків — seqscan ~150-300мс → index scan ~5-15мс. На SaaS з 50+ org-ів полегшує shared connection pressure.
**Де шукати ще:** після кожного нового report/list endpoint (особливо append-only models: StockMovement, AuditLog, BatchConsumption, Notification, WorkOrderStatusLog) — grep `@@index` поверх таблиці і compare з actual WHERE patterns у service.

---

### 2026-06-14 — Sequential `await tx.X.update(...); await tx.Y.create(...)` у loop-карриджних батч-операціях — Promise.all всередині ітерації без злому loop-carried стану

**Сигнал:** loop `for (const x of batches) { ... await db.X.update(...); await db.Y.create(...); remaining -= take; }` — два writes на ту саму ітерацію не залежать один від одного (update на batchId, create нового batchConsumption), але loop-carried state (`remaining`, `consumed`, etc.) лишається сериально. Sequential await ВСЕРЕДИНІ ітерації коштує зайвий RTT, multiply на N-iter.
**Grep:** `for \(const .* of .*\)\s*\{[\s\S]{0,300}await .*\.\w+\.update[\s\S]{0,200}await .*\.\w+\.create`
**Причина виникнення:** "update partition, потім create consumption record" виглядає як sequential business event — update partition повертає void, create отримує partition.id з batch object у scope. Розробник не помічає що результат update нікуди не йде.
**Підхід до виявлення:** при перегляді циклу — для кожного `await db.X.action(...)` всередині запитати "чи наступний рядок читає РЕЗУЛЬТАТ цієї операції?". Якщо ні (void return або просто `await` без destructure) — кандидат на `Promise.all` ВСЕРЕДИНІ ітерації. Loop-carried state (`remaining`, accumulators) лишається outside Promise.all → ітерації між собою сериальні (правильно), всередині — parallel (виграш).
**Підхід до фіксу:** `await Promise.all([db.X.update({...}), db.Y.create({...})])`. Запити йдуть на одну Prisma connection concurrently — race-safe бо різні таблиці/різні primary keys. Loop-carried mutations (`remaining -= take`, `results.push`) лишаються post-await — ітерації сериальні. Той самий патерн працює для `findFirst(tenant guard) → update + create` де update + create незалежні від результату findFirst (лише від `.id`/`.foreignKey` поля).
**Реальний impact:** на consumeBatch (FIFO/LIFO) з 5 partitions: 5×2=10 sequential RTTs → 5×1=5 parallel-pair RTTs (50% time-save для DB roundtrips). Аналогічно для returnToBatch у WO cancellation з 10 parts → 10 RTT економії.
**Де шукати ще:** будь-який batch-consume/release/return loop у inventory.service, batch.service, work-orders.service; також settlement reconciliation (debt-update + transaction-create), invoice payment apply (line-update + payment-record-create).

---

### 2026-06-12 — Disjoint-set `tx.X.updateMany()` pairs всередині `$transaction` callback — Promise.all замість sequential await

**Сигнал:** service-метод (sync/refresh/cascade-update) всередині `await this.prisma.$transaction(async tx => { ... })` робить 2+ послідовні `await tx.X.updateMany({where:A,data:...})` потім `await tx.X.updateMany({where:B,data:...})` де A і B — DISJOINT row sets (різні значення FK/предикату, не перетинаються). Наприклад: одна оновлює children-rows (`parentSlotId: { not: null }`), інша parent (`parentSlotId: null`). Sequential await блокує — кожен write коштує 1 RTT + DB execution time. Симптом у git diff: дві updateMany підряд з різним `where` але однаковою mutation-семантикою.
**Grep:** `await tx\.\w+\.updateMany[\s\S]{0,300}await tx\.\w+\.updateMany`
**Причина виникнення:** розробник пише код «зрозуміло-сильно» — спочатку soft-delete A, потім update B. Sequential reads легко рознести у Promise.all (немає ризику), але `updateMany` виглядає «небезпечніше» через схожість з sync logic.
**Підхід до виявлення:** при перегляді $transaction callback зчитати ВСІ `await tx.X.Y(...)` що йдуть підряд → перевірити чи кожен реально залежить від попереднього результату. Якщо результат не читається або where-clauses disjoint → кандидат на Promise.all.
**Підхід до фіксу:** `const [, result2] = await Promise.all([tx.X.updateMany({where:A,data:...}), tx.X.updateMany({where:B,data:...})])`. Prisma підтримує parallel queries всередині interactive tx — обидва запити йдуть на одну connection concurrently. Race-safe бо WHERE disjoint. Той самий патерн діє для tenant-guard + parentSlot lookup (раніше workOrder.findFirst поза tx, потім parentSlot всередині tx — об'єднати в `Promise.all([tx.workOrder.findFirst, tx.calendarSlot.findFirst])` всередині tx; 404 throw скасовує tx без mutation cost).
**Реальний impact:** sync endpoints ~30% швидші у hot path — 2 sequential round-trips → 1 parallel. На 100-RPS endpoint це ~50ms loop savings.
**Де шукати ще:** будь-який cascade-update / sync / refresh / propagate / `markAsX` метод; bulk soft-delete після status transition; refresh-totals helpers які одночасно скидають кеш і оновлюють агрегат.

---

### 2026-06-12 — `kyivToday()`/date helper всередині render `.map()` callback — lift у useMemo на рівень компонента

**Сигнал:** компонент-сторінка (dashboard, reports, calendar widgets) має `array.map(item => { const todayKyiv = kyivToday(); const isOverdue = item.date < todayKyiv; ... })` — `kyivToday()` (module-level helper що робить `new Date() + Intl.format()`) викликається у тілі callback `.map()`. На 8-row список — 8× `new Date() + Intl.format()` per render. Helper сам по собі «cheap» (module-level Intl singleton), але кумулятивно вартість росте з row count + ререндер-частотою.
**Grep:** `\.map\([^)]*=>\s*\{[^}]*kyivToday\(\)|\.map\([^)]*=>\s*\{[^}]*Date\.now\(\)`
**Причина виникнення:** kyivToday() виглядає як константа («сьогодні»), розробник інтуїтивно ставить її у map-body де відбувається порівняння. Виносити "сьогодні" поза map здається передчасним.
**Підхід до виявлення:** при перегляді render `.map()` callback — шукати виклики helpers `kyivToday()/now()/Date.now()/new Date()`. Якщо результат функції не залежить від `item` — це по суті константа на render → lift up.
**Підхід до фіксу:** `const todayKyiv = useMemo(() => kyivToday(), [])` на компонент-рівні над JSX. Deps `[]` (eslint-disable-next-line react-hooks/exhaustive-deps з коментарем — mount-stable, якщо UX flow не перетинає опівніч у одній page-сесії). Якщо потрібен auto-refresh — `useState` + `useEffect` interval. Це також виправляє pure-render порушення: значення може фактично змінитись між викликами всередині одного render (race з timer).
**Реальний impact:** 8-row dashboard render: 8× new Date() + Intl.format() → 1× на компонент. Незначно у мс, але важлива чистота render для majior render frequency components (dashboards з 15s polling, table cells у great-длinm scroll).
**Де шукати ще:** будь-яка date-helper функція з `new Date()` всередині — kyivNow, kyivToday, isoToday, todayMs, dateNow; також `Date.now()`, `new Date()` direct; reports/audit/maintenance lists з порівнянням `item.date < today`. Той самий патерн діє для `formatXyz` helpers що мають Intl singleton всередині (cheap але per-row alloc).

---

### 2026-06-11 — Dead `Object.keys(MAP)[0]` / `Object.keys(MAP)` в IIFE-render — module-level frozen `*_ORDER` const

**Сигнал:** компонент-форма має `const initialStatus = Object.keys(STATUS_LABELS)[0] ?? 'DRAFT'` (раз на рендер) АБО IIFE-pattern `{(() => { const statusOrder = Object.keys(STATUS_LABELS); const curIdx =...
**Grep:** `Object\.keys\(\w+\_LABELS\)|Object\.keys\(.*\_MAP\)|Object\.keys\(.*STATUS.\*\)`**Фікс:** module-level`const X_ORDER: readonly string[] = Object.freeze(Object.keys(X_LABELS))`поза компонентом. Імпорт у IIFE замість recompute.`[...arr].reverse().find(...)` patterns переписати як reverse...

---

### 2026-06-11 — Inline status-list literals `['DRAFT', 'X', 'Y'].includes(v)` у render path — module-level frozen sets

**Сигнал:** компонент має `const canX = status === 'A' || status === 'B'` АБО `const canY = isMode && ['DRAFT', 'ESTIMATE', 'APPROVED'].includes(currentStatus)` всередині render body. На КОЖЕН render створюється...
**Grep:** `\['[A-Z_]+'(,\s*'[A-Z_]+')+\]\.includes\(`
**Фікс:** module-level `const EDITABLE_STATUSES = Object.freeze(['DRAFT', 'ESTIMATE', 'APPROVED'] as const)`. У render: `(EDITABLE_STATUSES as readonly string[]).includes(currentStatus)`. Якщо backend має той...

---

### 2026-06-11 — Race-window guard через двошарову state (useRef + useState) — wrapper-setters замість додавання state у useCallback deps

**Сигнал:** modal/dialog має guard у `onClose`/`handleClose`: `if (saving || transitioning) return` — щоб НЕ закривати під час pending POST. Коли guard читає `saving` через React closure у `useCallback([saving,...
**Фікс:** пара `const xRef = useRef(false); const [x, setX] = useState(false);`+ wrapper-setter`const setXBoth = useCallback((v: boolean) => { xRef.current = v; setX(v); }, [])`. Кожен виклик...

---

### 2026-06-11 — Twin-scan `reduce()` у tfoot/footer для VAT + total — single-pass useMemo з двома акумуляторами

**Сигнал:** modal/form з таблицею редагування рядків (lines/parts/items) має `<tfoot>` який рендерить підсумок VAT + total. Розробник пише два окремих `lines.reduce(...)` блоки (один для VAT, один для total) у...
**Grep:** `\.reduce\(.*\n.*\.reduce\(`
**Фікс:** один `useMemo(() => { let total = 0; let vat = 0; for (const l of lines) { const h = toNumberOrUndefined(...); ...; if (vatRate > 0) vat += sum \* vatRate / 100; } return { total, vat }; }, [lines,...

---

### 2026-06-11 — Per-row `array.find(x => x.id === row.foreignKey)` у `.map()` рендерах і onChange handlers — O(N×M) → useMemo Map.get O(1)

**Сигнал:** компонент має reference-data масиви (employees/warehouses/units/branches/lifts/vehicles) у стейті або prop, і у `lines.map(line => { const emp = employees.find(e => e.id === line.employeeId); ... })`...
**Grep:** `\.find\(.*=>.*\.id\s*===`
**Фікс:** для кожного reference-data масиву — `const xById = useMemo(() => { const m = new Map<string, X>(); for (const x of xArray) m.set(x.id, x); return m; }, [xArray])`. У map / onChange:...

---

### 2026-06-10 — Overfetch `include: { childRel: take:1000 }` у FSM transition/guard методах де child-rel не читається у тілі функції — service methods з конвенцією "повний WO для side-effects" що насправді re-fetch внутрішньо

**Сигнал:** FSM/transition метод сервісу починається з `findFirst({ include: { childRel: { where: { deletedAt: null }, take: N } } })` де childRel — це one-to-many relation (parts, lines, items, allocations) на...
**Grep:** `wo\.`
**Фікс:** замінити `include: {childRel}` на `select: {...scalar fields actually used...}`. Перерахувати точний набір полів через grep `wo\.` у тілі функції. Залишити лише ID/scalar/FK що читаються....

---

### 2026-06-10 — Inline arrow handlers у row-репитері list-page (status pills, tabs, filter chips) — кліку-кнопки що рендеряться в `.map()` без виокремлення у memo-component

**Сигнал:** list-page має константу типу `STATUS_TABS = [...]` (10-20 елементів) і у JSX рендерить через `.map(([v, l]) => <button onClick={() => { setX(v); resetPage(); ... }} className={cn(...)}>{l}</button>)`...
**Фікс:** виокремити module-level memo-component `const StatusPill = memo(function StatusPill({ value, label, active, description, onSelect }: Props) { return description ? <Tooltip>{btn}</Tooltip> : btn })`....

---

### 2026-06-10 — IIFE `(() => { const builder = ...; return <X tabs={builder(selectedItem)} /> })()` у тілі return батьківського компонента — DetailPanel/Drawer/Modal tabs побудова у render

**Сигнал:** у JSX батьківського компонента (list-page, dashboard, settings) є блок `{(() => { const buildTabs = (item) => [...]; return <Panel tabs={selectedItem ? buildTabs(selectedItem) : undefined} /> })()` —...
**Grep:** `\{\(\(\) =>`
**Фікс:** двофазний refactor: (1) Lift inner function body у `useMemo(() => { if (!selectedItem) return undefined; const item = selectedItem; return [...tabs...]; }, [selectedItem, ...deps])`. Параметер...

---

### 2026-06-10 — `.some()` + `.filter().map().join()` twin-scan derived string у warning/badge UI — conflict slots, error chips, batch operations summary

**Сигнал:** UI компонент рендерить попередження/підсумок з derived string з масиву об'єктів: `{calConflict.conflictSlots.length} слотом(и) {calConflict.conflictSlots.some(s => s.workOrderNumber) && (<>...
**Grep:** `\.some\(._=>._\)\s\*(&&|\?)`**Фікс:** useMemo single-pass:`const derived = useMemo(() => { const result: string[] = []; for (const s of array ?? []) { if (s.predicate) result.push(s.field); } return result.join(', '); }, [array])`. Деps...

---

### 2026-06-10 — Inline React component declared inside parent component body — sidebar/shell/layout композити з вкладеними NavLink/Row/Cell

**Сигнал:** усередині функції-компонента (особливо великих `Shell`/`Layout`/`Wizard` компонентів) оголошений локальний підкомпонент через `const NavLink = ({ item }) => (...)` або `function Row(props) { return...
**Фікс:** дві стратегії, обидві валідні: **(A) функція-render-helper** — перейменувати на `renderNavLink(item, opts?)`і кликати як **function call**`{renderNavLink(item)}` замість JSX-element. React тоді...

---

### 2026-06-10 — React Context Provider value object без useMemo — providers що тримають частину state у useState + частину callbacks у useCallback

**Сигнал:** Provider компонент рендерить `<XContext.Provider value={{ state1, state2, callback1, callback2 }}>` — об'єкт-літерал inline у JSX. `state1`/`state2` живуть у useState (стабільні поки не змінюються),...
**Фікс:** обгорнути value у `useMemo(() => ({ state1, state2, callback1, callback2 }), [state1, state2, callback1, callback2])`. callback-и у deps безпечні бо самі стабільні через useCallback. Якщо у Provider...

---

### 2026-06-10 — Multiple mount-only useEffect з `[]` deps у одному компоненті — localStorage seeding/window event setup розпорошений по 3+ окремих ефектах

**Сигнал:** великий компонент (Shell/Page/Layout) має 3+ окремих `useEffect(() => {...}, [])` що всі виконуються ОДИН раз при mount. Типовий вміст: `localStorage.getItem(KEY1)` + `setStateFromSaved`,...
**Фікс:** об'єднати в один `useEffect(() => { /* all mount-only logic */; return () => { /* cleanups */ } }, [])`. Зберегти `try/catch` блоки навколо кожного localStorage read (один впав не зупиняє інших)....

---

### 2026-06-10 — `findMany({where: {id: {in:[...]}, take})` для FK-existence перевірки замість `count()` — services/validators bulk-FK guard

**Сигнал:** Backend service метод (типу `create`/`update` що приймає DTO з масивом FK — `dto.works[]`, `dto.goods[]`, `dto.serviceIds[]`) валідує всі переданi IDs через `findMany({ where: { id: { in: ids },...
**Фікс:** замінити `tx.X.findMany({...})`на`tx.X.count({where})`. Постгрес виконає `COUNT(\*) WHERE...`що при наявності composite index`(orgId, id)` дає index-only scan з декількома page reads (vs full row...

---

### 2026-06-10 — Redundant @@index([orgId]) поверх @@unique([orgId, X]) — reference моделі з composite unique key

**Сигнал:** модель Prisma має `@@unique([orgId, X])` (де X = code/rate/eventType+channel/key+...) і
**Фікс:** видалити `@@index` (НЕ `@@unique` — він несе constraint-семантику). Залишити коментар над `@@unique` що пояснює чому окремий `@@index` не потрібен (для майбутніх розробників). `prisma db push...

---

### 2026-06-10 — Cycle-N gap у дубльованих файлах з однією назвою — settings/PaymentsTab vs ndi/PaymentsTab

**Сигнал:** у різних роутах (`apps/web/src/app/(app)/settings/X.tsx` і `apps/web/src/app/(app)/ndi/X.tsx`) існують
**Фікс:** застосувати ТОЙ самий patтерн (Promise.allSettled, etc.) до sibling-файлу. У commit-message зазначити "cycle-N gap — pattern applied to sibling X.tsx". Якщо файли семантично дублікати (один і той...

---

### 2026-06-10 — Frontend для-await POST у "Import from templates" handlers — bulk-create незалежних reference rows із серійним RTT

**Сигнал:** UI sub-tab (PaymentsTab/CurrenciesTab/UnitsTab/будь-який reference-CRUD з "Додати з шаблону") має handler `importFromTemplates(templates: SystemTemplate[])` що ітерує `for (const t of templates) {...
**Grep:** `for \(const \w+ of templates\)`**Фікс:**`Promise.allSettled(templates.map(t => apiFetch(POST, body)))`→ iterate results:`for (const r of results) { if (r.status === 'fulfilled') created.push(r.value) }`. Batch state update в кінці:...

---

### 2026-06-10 — Duplicate getCached() у парних useState lazy initializers — composable hooks з data+loading pair

**Сигнал:** composable hook (типу `useCachedRefData`, `useSavedFilters`, `useCachedQuery`) має паттерн: `const [data, setData] = useState<T>(() => getCached<T>(key) ?? fallback); const [loading, setLoading] =...
**Фікс:** `const initialCacheRef = useRef<T | null | undefined>(undefined); const readOnce = (): T | null => { if (initialCacheRef.current === undefined) initialCacheRef.current = getCached<T>(key); return...

---

### 2026-06-10 — Static toolbar comparison `JSON.stringify(CONSTANTS.map(c => c.key))` у render path — column-config hasCustomization check

**Сигнал:** list-page toolbar (`work-orders/page.tsx`, `invoices/page.tsx`, ... 9 файлів) має `ColumnsDropdown hasCustomization={JSON.stringify(order) !== JSON.stringify(CONSTANTS.map(c => c.key)) || ...}`....
**Grep:** `JSON\.stringify\([^)]*\.map\(`
**Фікс:** двофазний refactor: (1) **лифт CONSTANTS** з useMemo (або in-component) до module-level — `const WO_COLUMNS: Array<{ key: string; label: string; defaultVisible?: boolean }> = [...]`. **Тип явно**, не...

---

### 2026-06-10 — Sequential conflict checks всередині $transaction для disjoint-where queries у одній таблиці

**Сигнал:** service метод (приклад: `calendar.createSlot`, `calendar.updateSlot`) всередині `await this.prisma.$transaction(async tx => { ... })` робить кілька
**Фікс:** обернути конфлікт-перевірки у `const [conflict, empConflict] = await Promise.all([cond1 ? tx.X.findFirst({where:..., select:{id:true}}) : Promise.resolve(null), cond2 ? tx.X.findFirst({where:...,...

---

### 2026-06-10 — Per-item `$transaction(callback, { timeout })` у row-importer циклах — bulk import що відкриває окрему транзакцію для КОЖНОГО рядка

**Сигнал:** import-метод сервісу (приклад: `xlsx.applyPricingFromList`, `xlsx.importX`, bulk CRUD imports) має для кожного row окремий виклик `await this.prisma.$transaction(async tx => { ...mutation +...
**Grep:** `for \(const \w+ of \w+\) \{[\s\S]{0,500}await this\.prisma\.\$transaction\(`**Фікс:** двофазний refactor: (1) **plan phase** — у циклі через items зібрати масив`Plan[]` (`{ id, ...changes }`) у пам'яті, без mutations. Filter early-skip cases (no change, validation failures) у...

---

### 2026-06-10 — Sequential update/create per-row у post-prefetch row-importer — bulk import де prefetch вже усуває N+1 reads, але writes залишаються sequential

**Сигнал:** import-метод робить bulk prefetch (`goodsByKey`, `existingByGoodId` map) ДО циклу — це корисно (видалено read N+1). Але всередині `for (const row of rows)` тіло цикла все одно робить `if (existingId)...
**Grep:** `for \(const \w+ of \w+\) \{[\s\S]{0,300}existingByGoodId\.get|existingById\.get|await this\.prisma\.\w+\.update[\s\S]{0,200}await this\.prisma\.\w+\.create`**Фікс:** трифазний refactor: (1) **plan phase** —`updatesPlan: {id, ...changes, label}[]`+`createsPlan: Prisma.XCreateManyInput[]`+`seenGoodIds: Set<string>` для dedup. У циклі: dup check, FK resolve,...

---

### 2026-06-09 — Коментар обіцяє «RepeatableRead/Serializable» але `$transaction(callback, { timeout })` лишається default ReadCommitted — refresh/update методи що перепи��ують агрегатні стани

**Сигнал:** усередині service-методу є `await this.prisma.$transaction(async tx => { ... }, { timeout: N })` БЕЗ `isolationLevel`. У коментарях вище — фраза на кшталт «inside tx (RepeatableRead) to prevent...
**Grep:** `\\$transaction\\b`
**Фікс:** (1) bump до `isolationLevel: 'Serializable'`; (2) inner re-check критичного інваріанту (status, existence, deletedAt:null) усередині $tx з `select: { ...тільки потрібне }` — це двопоясна страховка:...

---

### 2026-06-09 — Reverse-FK index miss на `(orgId, parentFK, deletedAt[, sortKey])` — list/groupBy endpoints що фільтрують дочірні документи по batьківському FK

**Сигнал:** новий feature додає cross-aggregate query на дочірній таблиці (Invoice/CalendarSlot/Warranty/Payment) фільтруючи по FK на batьківську сутність (workOrderId, counterpartyId, etc.) + tenant guard...
**Фікс:** додати covering `@@index([orgId, parentFK, deletedAt, sortKey])` де `sortKey` — це orderBy колонка endpoint'у (createdAt/startAt/documentDate). Sort key потрібен якщо endpoint має `orderBy` — інакше...

---

### 2026-06-09 — Manual padStart/concat date formatter як локальна функція — фронт-сторінки де `fmtDate` уже імпортовано

**Сигнал:** на сторінці існує локальна функція `function formatDate(iso: string): string { const d = new Date(iso); const day = String(d.getDate()).padStart(2, '0'); const month = String(d.getMonth() +...
**Grep:** `function formatDate\|const formatDate = \|function fmtDt\|function fmtDate `**Фікс:** замінити тіло локальної функції на`return fmtDate(iso);`— це проксі-патерн (як`fmt() = fmtMoney(Number(n))` для LinkedDocumentsPanel). Сигнатура збережена, всі call-sites не торкаються....

---

### 2026-06-09 — Auto-pick/auto-select optional FK резолюція ПІСЛЯ парallel FK guards — sequential гілка `if (dto.X) validate; else autoSelect` на create-методах

**Сигнал:** create-метод сервісу починається з `Promise.all([fk1, fk2, fk3, fk4])` для tenant-validation FK (branch/vehicle/counterparty/lift), потім має послідовний блок `if (dto.contractId) { provided = await...
**Фікс:** замість `if/else`блоку з двома послідовними`await findFirst`— додати n+1-й елемент у Promise.all:`dto.xId ? prisma.X.findFirst({where composite}) : prisma.X.findFirst({where autoPickKey,...

---

### 2026-06-09 — Sequential per-item idempotent service.create() у scheduler/job — multi-tenant bootstrap fetchers

**Сигнал:** scheduler/job метод (приклад: nbu-fetch, daily-rate-sync, bulk-import) ітерує колекцію (currencies/orgs/templates) через `for (const x of list) { await this.someService.create(orgId, ...) }`. Кожна...
**Grep:** `for \(const \w+ of \w+\)`
**Фікс:** `const results = await Promise.allSettled(list.map(async x => { ...body... return { ok, code, reason } }));` потім `for (const r of results) { if (r.status === 'fulfilled' && r.value.ok) fetched++;...

---

### 2026-06-09 — `findOne(dto) + secondary findFirst` partial-overlap pattern — PDF/export endpoints

**Сигнал:** export-endpoint (generatePdf/generateXlsx/exportReport) має шаблон: (1) `const dto = await this.findOne(orgId, id)` — публічний getter повертає DTO з частковим включенням relations (наприклад,...
**Фікс:** inline'ити повний read всередину generatePdf — БЕЗ findOne — з extended `select`/`include` що покриває ВСІ поля потрібні для PDF (включно з phone/address). Promise.all з другим незалежним read...

---

### 2026-06-08 — Redundant @@index([X]) поверх @@unique([X]) — Prisma schema моделі з композитним unique-ключем

**Сигнал:** Модель Prisma має одночасно `@@unique([orgId, email])` і `@@index([orgId, email])` (або інший композитний ключ) — однакові колонки в однаковому порядку. У `pg_indexes` видно ДВА B-tree індекси на...
**Фікс:** видалити `@@index` (НЕ `@@unique` — unique несе додаткову constraint-семантику). У DB виконати `DROP INDEX IF EXISTS "X_col1_col2_idx"` напряму (швидка операція, не вимагає міграції файлу — Prisma не...

---

### 2026-06-08 — Scroll/resize listeners без `passive:true` у portal-dropdown компонентах — datetime/date pickers, tooltip позиціонери, sticky popovers

**Сигнал:** компонент з portal-rendered dropdown (date picker, autocomplete, tooltip) має `useEffect` що додає `window.addEventListener('scroll', handler, true)` для repositioning через `getBoundingClientRect`....
**Grep:** `addEventListener\(['"]scroll['"]\s*,\s*\w+\s*,\s*(true|false)\b`
**Фікс:** замінити третій аргумент на `{ capture: true, passive: true }` (зберегти capture якщо був). У `removeEventListener` використати ту саму options object (capture повинен матчитись, інакше listener не...

---

### 2026-06-08 — memo() без stable handler refs — list-item рендерери у формах з частим typing

**Сигнал:** компонент-список елементів (checkbox-list, item-grid, row-list) обгорнутий у `React.memo()`, але батьківський компонент передає `onChange={ids => { setX(ids); doY(); }}` — inline arrow на кожен...
**Фікс:** перетворити inline handlers на `useCallback`. Якщо handler читає state через сетер (`setX(ids)`) → setX є стабільний → deps можуть бути порожніми. Якщо handler читає state value → useRef +...

---

### 2026-06-05 — Status-guarded soft-delete з sequential findFirst + update — invoices/PO/SD/WO remove() та подібні

**Сигнал:** Метод `remove()` має business-rule guard через статус: `findFirst({ where: { id, orgId, deletedAt: null } })` повертає
**Фікс:** **двоступінчатий race-safe patern**: (1) `findFirst({ where: { id, orgId, deletedAt: null }, select: { status: true } })` — narrow, для status guard; (2) `if (!doc) throw NotFound; if (doc.status !==...

---

### 2026-06-05 — FK guard без narrow projection у Promise.all FK validation — будь-який create/update що валідує >1 FK у Promise.all

**Сигнал:** Сервіс має `Promise.all` з 2-5 паралельних `findFirst({ where: { id: dto.xId, orgId, deletedAt: null } })` для FK validation — БЕЗ `select: { id: true }`. Кожен запит тягне ВЕСЬ запис цільової...
**Grep:** `findFirst({ where: { id: dto\.`
**Фікс:** для кожного FK guard у Promise.all додати `select: { id: true }`. Якщо одне поле потрібне (наприклад, `existing.shortName` для post-filter у units.update) — `select: { id: true, shortName: true }`....

---

### 2026-06-05 — Static tab/option arrays оголошені у тілі компонента — view switchers, period selectors, tab definitions

**Сигнал:** Усередині функції-компонента оголошений масив об'єктів/кортежів зі статичним вмістом: `const TABS: { key, label }[] = [...]` або інline JSX `{[['day', 'День', Icon], ['month', 'Місяць',...
**Фікс:** Підняти на module-level як `const X = [...] as const`(для tuple-arrays —`ReadonlyArray<readonly [...]>` annotation). Icon components з lucide-react — pure refs, безпечно capture-ити в module scope....

---

### 2026-06-05 — Detail-в-list × DetailPanel — list endpoint тягне повну дочірню колекцію, хоча UI рендерить її ЛИШЕ для ОДНОГО вибраного rows

**Сигнал:** list-endpoint містить `include: { lines/parts/children: { take: 1000, include: {...}}}` для O(20) rows. На фронті UI використовує цю колекцію у ДВОХ місцях: (1) у table-cell — тільки...
**Фікс:** на backend — замінити `include: { X: { take: N, include: {...}}}` на `_count: { select: { X: { where: { deletedAt: null }}}}` + додати `linesCount?: number` у DTO; у `toDto` — fallback `doc.\_count?.X...

---

### 2026-06-05 — Cycle-N gap у міграції паттерну: один сервіс випав із попереднього аудиту, бо grep був неповний

**Сигнал:** новий аудит знаходить ВЖЕ-описаний у "Накопичених підходах" паттерн у конкретному сервісі (X.service.ts), хоча минулий аудит явно фіксав цей паттерн у 7-8 інших сервісах. Перевіряєш — так, цей файл...
**Фікс:** застосувати той самий fix-pattern що було документовано минулого циклу. Зазначити у commit message «cycle-N gap — pattern from <prev cycle>». У MemoryManual.md — додати рядок «Verified non-issues» НЕ...

---

### 2026-06-01 — View-state-gated fetch effects — багатовидові сторінки (day/month/stats, list/grid/calendar)

**Сигнал:** Сторінка має тумблер виду (`useState<'day'|'month'|'stats'>` або подібне), окремі `useEffect` для кожного виду, АЛЕ один із них залежить тільки від data-key (`[date]`, `[id]`, `[filters]`) без...
**Фікс:** Додати guard `if (viewMode === 'X') load()` до effect; додати `viewMode` у dep array. Так при поверненні до виду дані оновляться. Альтернатива — переписати з `useQuery({ enabled: viewMode === 'X' })`.

---

### 2026-06-01 — Object literals як local const у тілі компонента — DEFAULT/EMPTY initializers

**Сигнал:** `const EMPTY_FORM = {...}` або `const DEFAULT_FILTERS = {...}` оголошені всередині функції-компонента (capslock назва = натяк на константу, але scope локальний).
**Фікс:** Підняти на module level. Якщо потрібна type-аннотація і тип оголошений у тому ж файлі — перенести оголошення типу вище. Перевірити що значення не залежить від props/state (якщо залежить — це не...

---

### 2026-05-28 — Довідники без кешу — settings/catalog/infrastructure модулі

**Сигнал:** `findAll()` в сервісах що повертають незмінні reference lists без `CacheService` в constructor
**Фікс:** inject CacheService → get → якщо miss → query → set; інвалідація у кожному mutating методі
**Реальний impact:** settings page: 5 sequential DB queries → 0 (з кешу); ~150ms → ~5ms на повторний...

---

### 2026-05-28 — Waterfall fetch у settings page — сторінки з декількома незалежними секціями

**Сигнал:** декілька `apiFetch()` у `useEffect([], [])` що не залежать один від одного, але написані послідовно
**Фікс:** Promise.all([...]) → деструктурувати результати → setState для кожного
**Реальний impact:** settings: 5 послідовних fetches (~300ms кожен) → 1 паралельний (~300ms total)
**Де шукати ще:** будь-яка...

---

### 2026-05-28 — Source/management page не наповнює спільний ref-cache — сторінки що редагують довідники

**Сигнал:** сторінка-власник довідника (CRUD UI для branches/zones/lifts/warehouses/brands/units) фетчить ті самі списки що й consumer-сторінки, але БЕЗ `getCached`/`setCache` — хоча consumer-сторінки той самий...
**Фікс:** safe-умова обов'язкова — фіксувати ТІЛЬКИ якщо `loadAll()` викликається і на mount, і після КОЖНОЇ мутації (інакше кеш стане джерелом stale-даних). Якщо так: seed з `getCached` для миттєвого...

---

### 2026-05-28 — `new Intl.DateTimeFormat()` у hot-path хелперах — будь-який компонент з форматуванням дати/часу/чисел у списку

**Сигнал:** хелпер-функція форматування (час, дата, число, валюта) що створює `new Intl.DateTimeFormat()` / `new Intl.NumberFormat()`
**Grep:** `new Intl.`
**Фікс:** винести форматер у module-level `const` (один інстанс на весь модуль), у хелпері викликати лише `.format()`. Опції мають бути статичними — якщо локаль/TZ динамічні, кешувати через Map за...

---

### 2026-05-30 — Detail-include vs list-include розрізнення — список з вкладеною колекцією

**Сигнал:** list endpoint робить `include: { children: { orderBy } }` (вкладена one-to-many таблиця) — складається враження що це O(N×M) і треба «оптимізувати» прибравши include. Перевіряти треба ПЕРЕД фіксом —...
**Фікс:** **НЕ фіксувати** якщо UI використовує. Якщо preview не потрібен — замінити include на `_count: { select: { children: true } }` для бейджу N і додати окремий `GET /:id` що повертає повний об'єкт з...

---

### 2026-05-30 — "Pre-mature optimization rejection" — коли НЕ фіксувати знайдене

**Сигнал:** запит від користувача містить фразу «чи варто кешувати», «чи потрібен debounce», «чи ефективно» — це питання, не директива. Перед фіксом перевіряй чи проблема
**Фікс:** **записати в звіт "не виправлено, бо X"** замість тихо ігнорувати. Користувач має знати чому. Приклади: «GET /user-preferences/:key не кешується бо викликається 1× per mount + apiFetch уже дедуплить...

---

### 2026-05-30 — Verify-before-fix: коли запит звучить як "чи є cleanup/leak/issue?" — прочитати фактичний код перед діями

**Сигнал:** користувач ставить запитання у формі "чи є cleanup для setTimeout?", "скільки ResizeObserver одночасно?", "чи потрібна virtualization?", "transition при кожному ререндері чи тільки при зміні?". Це
**Фікс:** якщо верифікація показала що проблеми **немає** — **НЕ робити фікс**. Замість цього: чесно відповісти у звіті "0 проблем — cleanup є / pagination 20 / transition тільки при size change". Це валідно,...

---

### 2026-05-30 — HAR/DevTools "duplicate" може бути CORS preflight + GET — read curl method before declaring N+1

**Сигнал:** користувач/звіт показує що один endpoint викликається "двічі" при відкритті сторінки. У HAR/curl-export перші N записів — `-X 'OPTIONS'`, наступні N — той самий URL без `-X` (GET). Це
**Фікс:** реального дубля немає → НЕ чіпай useEffect / StrictMode / dedup. Натомість фіксуй сам preflight: додати `maxAge` у `enableCors()` (NestJS) щоб браузер кешував результат OPTIONS. Chrome кепить на...

---

### 2026-05-30 — Consumer-page без ref-cache seed — сторінки де довідник це side-data, а не основний контент

**Сигнал:** сторінка робить `apiFetch('/branches')` (або іншого довідника) без попереднього `getCached`, і використовує результат тільки для dropdown/select. Першу відкриття вкладки сторінка показує порожній...
**Grep:** `apiFetch.*/branches\|apiFetch.*/warehouses\|apiFetch.*/zones\|apiFetch.*/lifts\|apiFetch.*/work-categories`
**Фікс:** на початку useEffect: `const cached = getCached<T[]>('cache:X'); if (cached?.length) setState(cached);`. Після successful fetch: `setCache('cache:X', data)`. Безпечно тому що ref-cache живе тільки в...

---

### 2026-05-30 — Detail-page ref-cache miss — картка сутності тягне ті ж довідники що й список

**Сигнал:** detail-сторінка (`/X/[id]/PageClient.tsx`) робить `apiFetch('/works'/'employees'/'warehouses'/...)` без `getCached`/`setCache`, але parent list-сторінка (`/X/page.tsx`) той самий довідник у cache...
**Фікс:** на початку useEffect: `const cached = getCached<T>(...); if (cached) setState(cached);` для кожного довідника. Після successful fetch — `setCache(...)`. Кеш ділиться з list-сторінкою через спільний...

---

### 2026-05-30 — Sequential FK validation у NestJS create/update — будь-який сервіс що приймає DTO з кількома FK полями

**Сигнал:** у методі `create(orgId, dto)` або `addLine(orgId, dto)` сервісу йдуть два-три-чотири `await this.prisma.X.findFirst({ where: { id: dto.xId, orgId, deletedAt: null } })` поспіль — кожен для іншої...
**Grep:** `await this\.prisma\.\w+\.findFirst`
**Фікс:** `const [a, b, c] = await Promise.all([findFirst(...), findFirst(...), findFirst(...)])`; перевірки `if (!a) throw` залишити ПІСЛЯ Promise.all — порядок повідомлень про помилку не страждає, бо всі...

---

### 2026-05-30 — Sequential queue.add у фан-аут хендлерах — webhook delivery, sms/notification dispatch

**Сигнал:** `for (const x of list) { await this.queue.add('job', {...}, opts); }` — сервіс кладе по черзі N independent jobs у BullMQ/Redis-чергу. Кожен `add` робить окремий Redis-PIPELINE round-trip
**Grep:** `for (const \w+ of \w+)`
**Фікс:** `await Promise.all(list.map(x => this.queue.add('job', {...}, opts)))`. Семантика збереглася: всі jobs все одно отримають свій attempts/backoff із black-box-черги; failure одного не ломає...

---

### 2026-05-30 — Duplicate findFirst для тієї ж сутності з різним select — services що окремо тягнуть проекції

**Сигнал:** в одному методі є дві `findFirst({ where: { id: dto.xId, orgId } })` для однієї сутності, але з різним `select`/`include`. Наприклад: одна тягне `branchId`, інша тягне `status`. Виглядає як...
**Фікс:** залишити одну `findFirst` що selectить ОБИДВА поля (branchId + status) — Postgres віддасть їх одним read; видалити дублікат, переписати наступні if-перевірки на властивості об'єкта
\*\*Реальний...

---

### 2026-05-30 — Sequential file/media upload у формі — будь-який handleUpload з for-await на FormData

**Сигнал:** у frontend хендлері завантаження кількох файлів: `for (const file of Array.from(files)) { await apiMultipartFetch(url, fd); }`. Кожен upload блокує наступний на час повного HTTP round-trip....
**Grep:** `for (const \w+ of (Array\.from\()?files\)?)`
**Фікс:** `Promise.allSettled(Array.from(files).map(file => ...))`. Failure count = `results.filter(r => r.status === 'rejected').length`. Логіка обробки results однаково проста, а wall-clock падає до...

---

### 2026-05-30 — Sequential UPDATE у post-WO hook без транзакції — maintenance, schedules, notifications batch

**Сигнал:** службовий метод що викликається після завершення наряду (`updateAfterWorkOrder`, `notifyAll`, `propagateChange`) робить `for (const x of list) { await prisma.X.update(...) }` поза транзакцією. На...
**Grep:** `for (const \w+ of \w+)`
**Фікс:** `await Promise.all(list.map(x => this.prisma.X.update({ where: { id: x.id }, ... })))`. Failure одного: Promise.all reject — це той самий контракт що й перший await-помилка у for-await
\*\*Реальний...

---

### 2026-05-30 — Covering index для WHERE+ORDER BY combo — list endpoints що показують найновіше

**Сигнал:** на сторінці-вкладці "Аудит"/"Транзакції"/"Історія" Postgres сканує тисячі рядків, потім сортує їх у пам'яті. Existing index покриває WHERE (orgId+entityType+entityId), але не сортувальний стовпець...
**Фікс:** замінити існуючий індекс на `(orgId, ...filterCols, createdAt)` — covering. Postgres віддасть результат в індекс-order, sort node зникає. Окремий індекс лише на createdAt лишити (для full-org...

---

### 2026-05-30 — Per-row N+1 у xlsx/csv line importers — будь-який bulk import з for-await пошуком entity per row

**Сигнал:** import-метод приймає масив рядків з файлу (xlsx/csv), для кожного рядка робить `good.findFirst({ where: { OR: [{ sku }, { name }] } })` + `existingLine.findFirst({ where: { goodId, parentId } })` +...
**Фікс:** виділити helper `lookupEntitiesBulk(orgId, rows)` що робить ОДИН `findMany({ where: { orgId, OR: [{ sku: { in: skus } }, { name: { in: names } }] } })` і повертає Map<key, entity>. Перед циклом -...

---

### 2026-05-30 — Pure compute extraction з async rule resolver — calculateX що внутрішньо тягне правила/конфіг з БД

**Сигнал:** сервіс має метод `calculateX(orgId, ...inputs): Promise<number>` що
**Grep:** `calculateX(`
**Фікс:** split на дві функції: `getRulesForOrg(orgId)` (async, тримати у PricingService) + `computeFromRules(rules, ...inputs)` (sync, чистий розрахунок). Existing `calculateX` робить обидві операції підряд —...

---

### 2026-05-30 — Backend hot-loop Intl construction — звіти, PDF рендеринг, групування по даті

**Сигнал:** хелпер-функція `kyivDate = (d) => new Intl.DateTimeFormat('sv-SE', {...}).format(d)` оголошений у тілі методу, а не на module-level. Викликається у `for (const x of rows)` циклі що проходить 1000+...
**Grep:** `new Intl\.(DateTimeFormat|NumberFormat)\(`
**Фікс:** module-level `const KYIV_DATE_FMT = new Intl.DateTimeFormat(...)`. У хелпері/циклі — лише `.format(d)`. Опції мають бути статичними. Якщо локаль/TZ зчитуються з config — кешувати через Map<key,...

---

### 2026-05-30 — Frontend Intl singletons via dedicated lib helper — масові table-cell `.toLocaleString` у списках

**Сигнал:** на сторінці-списку (таблиця/grid/detail-card) кожна grow-комірка з ціною/датою має inline `value.toLocaleString('uk-UA', {...})` або `new Date(value).toLocaleDateString('uk-UA')`. Або є локальна...
**Фікс:** створити `apps/web/src/lib/format.ts` з module-level Intl singletons (`MONEY_FMT`, `DATE_FMT`, `DATETIME_FMT`, `SHORT_DATETIME_FMT`, `INT_FMT`) і експортувати thin wrappers (`fmtMoney(n)`,...

---

### 2026-05-30 — Tenant guard + side-entity fetch sequential — assertX() потім findFirst(X-related) у різних таблицях

**Сигнал:** метод сервісу починається з `await this.assertCounterparty(orgId, cpId)` (або `findFirst` для tenant-guard) потім `await this.prisma.loyaltyAccount.findFirst({ where: { counterpartyId, orgId } })`....
**Фікс:** `const [guard, entity] = await Promise.all([assertQuery, entityQuery])`. Перевірку `if (!guard) throw NotFound` робити ПІСЛЯ Promise.all — порядок повідомлень не страждає бо обидва запити вже...

---

### 2026-05-31 — SSE/long-poll endpoints без throttle на нові підключення — `@SkipThrottle()` на @Sse() через тривале з'єднання

**Сигнал:** контролер з `@Sse()` або `@Get('stream')`/SSE/long-poll помічений `@SkipThrottle()` для того щоб throttler не лічив це як rapid-fire request. Логіка коректна за наявністю самого з'єднання (вже...
**Grep:** `@SkipThrottle\(\)`
**Фікс:** замінити `@SkipThrottle()` на `@Throttle({ default: { ttl: 60_000, limit: 5 } })` (або інші числа залежно від профілю). Throttler `@nestjs/throttler` рахує тільки нові HTTP request'и — вже відкритий...

---

### 2026-05-31 — Sub-query timeout у Promise.allSettled fan-out — dashboard/aggregated endpoints що збирають кілька незалежних метрик

**Сигнал:** метод `getSummary`/`getDashboard`/`getAggregatedReport` робить `Promise.allSettled([q1, q2, q3, q4])` з декількох незалежних DB-запитів. `allSettled` ловить exception per-query, але
**Grep:** `Promise\.allSettled\(`
**Фікс:** додати приватний helper `withTimeout<T>(p, ms): Promise<T | null>` через `Promise.race([p, timeoutPromise])`. timeoutPromise resolves `null` (НЕ reject — інакше allSettled поверне `rejected` що...

---

### 2026-05-31 — Прихована відсутність Prisma connection pool sizing — DATABASE_URL без `connection_limit`/`pool_timeout`

**Сигнал:** PrismaService створюється через `new PrismaClient()` без явного `datasourceUrl`. Prisma за замовчуванням бере `num_physical_cpus * 2 + 1` connection limit і `pool_timeout=10s`. На багатоядерній...
**Фікс:** обгорнути URL в helper `withConnectionPool(url): string` через `new URL(url)` + `searchParams.set()` тільки якщо key ще не виставлений (operator override has precedence). Рекомендовані дефолти:...

---

### 2026-05-28 — Читання `new Date()` / годинника всередині render — компоненти з time-залежним UI

**Сигнал:** `new Date()`, `Date.now()`, `.getMinutes()`/`.getHours()` викликані прямо у JSX або у `.map()` що генерує опції/комірки — особливо для disabled-логіки «минулий час». Це і impure render (різний...
**Grep:** `new Date()`
**Фікс:** тримати поточний час у стейті (`nowMs`), оновлювати по інтервалу в `useEffect`; похідні граничні значення (minHour, minMinute) рахувати через `useMemo([nowMs])`; передавати їх у дочірні компоненти як...

---

### 2026-05-31 — Same-aggregate parent + child sequential read — addLine/updateLine/removeLine та createFromX сервісів

**Сигнал:** метод `updateLine(orgId, parentId, childId, dto)` чи `removeLine(orgId, parentId, childId)` робить дві послідовні findFirst: спочатку `parent.findFirst({ id: parentId, orgId, deletedAt: null })` для...
**Grep:** `await this\.prisma\.\w+\.findFirst`
**Фікс:** `const [parent, child] = await Promise.all([parent.findFirst(...), child.findFirst(...)])`. Перевірки `if (!parent) throw NotFound` та status-guards йдуть ПІСЛЯ Promise.all — порядок повідомлень про...

---

### 2026-05-31 — Local fmt() helper що внутрішньо викликає toLocaleString — page-level «оптимізація» що нічого не оптимізує

**Сигнал:** на сторінці є локальна функція `function fmt(n: number) { return n.toLocaleString('uk-UA', {...}) + ' ₴' }` (або `fmtDate`/`fmtTime`) що використовується у `.map()` table cells. Виглядає як...
**Grep:** `function fmt\(`
**Фікс:** імпортувати `fmtMoney`/`fmtInt`/`fmtDate`/`fmtDateTime` з `@/lib/format` і переписати локальний `fmt` як thin proxy: `function fmt(n) { return ${fmtMoney(n)} ₴ }`. Бажано злити з singleton повністю —...

---

### 2026-05-31 — Tiered parallelization stops at first Promise.all — addX/createX де є кілька груп незалежних reads

**Сигнал:** метод сервісу `addX(orgId, parentId, dto)` або `createX(orgId, dto)` вже має один `Promise.all([parent.findFirst, fk.findFirst])` для першої групи перевірок (parent + FK). Але одразу після нього —...
**Фікс:** додати ДРУГИЙ `Promise.all([dup, count, ...])` після першого. Або, якщо обидві хвилі читають за одним базовим ключем (orgId+goodId), злити їх у ОДИН `Promise.all` коли parent-guard не блокує...

---

### 2026-05-31 — `include: { fk: true }` для many-to-one relation що використовує 2-3 поля — не лише join-таблиць

**Сигнал:** `include: { unitOfMeasure: true }`, `include: { brand: true }`, `include: { category: true }` у `findMany`/`findFirst`/`create` — single related row, не one-to-many колекція. У toDto/.map()...
**Фікс:** `include: { fk: true }` → `select: { ...neededFields, fk: { select: { name: true, ...neededFields } } }`. Якщо у scope є кілька relations — увесь top-level теж стає select. TypeScript авто-наведе...

---

### 2026-05-31 — Public widget без shared lib доступу — booking/embed сторінки що не імпортують `@/lib/format`

**Сигнал:** публічна сторінка-віджет (booking, signup, reset-password) — це чорний-box без авторизації що рендерить `.map()` зі слотами/датами через inline `toLocaleString` чи `toLocaleTimeString`. На відміну...
**Grep:** `toLocaleTimeString\|toLocaleString`
**Фікс:** оголосити module-level `const SLOT_TIME_FMT = new Intl.DateTimeFormat('uk-UA', { hour: '2-digit', minute: '2-digit' })` (або інший опції) **в тому самому файлі** — без імпорту з `lib/format`....

---

### 2026-05-31 — Private parent-guard helper блокує tier merger — `await this.assertX/getEditableX` як перший рядок hot-path методу

**Сигнал:** сервіс має приватний helper типу `getEditableWorkOrder(orgId, id)` / `assertCounterparty(orgId, id)` що робить parent.findFirst + business-rule check (status, isActive, deletedAt) і кидає виключення....
**Фікс:** inline parent.findFirst всередину `Promise.all([wo, fk1, fk2])`. Перевірки `if (!wo) throw NotFound` та business-rule (`if (!EDITABLE.includes(wo.status)) throw`) перенести ПІСЛЯ awaits — порядок...

---

### 2026-05-31 — Over-fetched many-to-one include для scalar-only consumer — `include: { brand: true }` коли тіло читає лише `entity.brandId`

**Сигнал:** `findMany`/`findFirst` має `include: { brand: true }` (або інший fkRelation) у запиті, але тіло методу/циклу читає лише foreign-key scalar — наприклад `line.good.brandId` чи `g.brandId` — без жодного...
**Фікс:** замінити `include` на `select` з narrow projection: явно перелічити всі поля parent entity що читаються + явно вказати які FK scalars потрібні (brandId, categoryId, etc.). Видалити nested include...

---

### 2026-05-31 — Assignment/bulk-replace методи з findOne+FK guard sequential — `assignX(orgId, id, dto)` де findOne блокує FK перевірку

**Сигнал:** сервіс має `assignX(orgId, id, dto: {idList: string[]})` що починається з `await this.findOne(orgId, id)` (tenant guard на parent сутність) і далі робить `findMany({ where: { id: { in: dto.idList },...
**Grep:** `await this\.findOne\(orgId, id\)`**Фікс:**`const [parent, items] = await Promise.all([prisma.parent.findFirst({...select: { id: true }}), dto.list.length ? prisma.child.findMany({...}) : Promise.resolve([])])`. Заміна findOne на findFirst з...

---

### 2026-05-31 — Sequential `tx.X.create` loop у bootstrap/seed/init transaction — `createMany` пропущено для defaults

**Сигнал:** метод bootstrap/setup (setup.init, seed скрипти, fresh-org init) робить `for (const x of defaults) { await tx.X.create({ data: { orgId, ...x } }) }` у середині `prisma.$transaction`. На відміну від...
**Grep:** `for \(const \w+ of \w+\) { await tx\.\w+\.create\(`
**Фікс:** `await tx.X.createMany({ data: defaults.map(d => ({ orgId, ...d })) })`. createMany не повертає створені рядки (повертає `{count}`) — якщо потрібні IDs для наступних кроків transaction, лишити...

---

### 2026-05-31 — JS aggregation у post-mutation recalc helpers — `findMany({ select: { amount: true } }).reduce(...)` для перерахунку totals

**Сигнал:** приватний helper типу `recalcTotals(parentId, tx)` робить `tx.X.findMany({ where: { parentId, orgId, deletedAt: null }, select: { amount: true }, take: 1000 })` потім `.reduce((s, l) => s +...
**Grep:** `findMany.*select.*amount.\*reduce`**Фікс:**`prisma.X.aggregate({ where, \_sum: { amount: true } })`замість findMany + JS reduce. Result:`{ \_sum: { amount: Decimal | null } }`. `Number(result.\_sum.amount ?? 0)` дає число. Для кількох...

---

### 2026-05-31 — Inline Intl.\* construction у `useEffect` loadData callback — page-mount setup-функції з 2-4 форматерами підряд

**Сигнал:** на сторінці-дашборді/звіті/головній page `useEffect(() => { ... }, [])` (mount-only) робить `const fmt = (d) => new Intl.DateTimeFormat(...).format(d)` хелпер всередині callback АБО прямі `new...
**Grep:** `new Intl\.\(DateTimeFormat\|NumberFormat\)`**Фікс:** винести **всі** форматери у module-level`const`блок над компонентом. Local`kyivDate`helper переписати як thin`.format()` wrapper. Опції мають бути константні (TZ, locale, options object повністю...

---

### 2026-05-31 — Async wrapper-method блокує parallelism викликача — `calculateX(... )` що сам тягне rules перед чистим compute

**Сигнал:** hot-path сервіс (приклад: `batch.createFromReceipt`) робить `entity = await prisma.X.findFirst(...)` потім `result = await this.other.calculateY(entity.fields, costPrice)`, де `calculateY` внутрішньо...
**Фікс:** `const [entity, rules] = await Promise.all([prisma.X.findFirst(...), this.other.getRulesForY(orgId)])`. Далі sync `this.other.computeYFromRules(rules, entity.fields, costPrice)`. Wrapper-метод...

---

### 2026-05-31 — 3rd-party UI lib props rebuilt each render — DayPicker/Combobox/Table з inline classNames/disabled/columns

**Сигнал:** компонент-обгортка над сторонньою UI-бібліотекою (DayPicker, React-Table, Combobox, MultiSelect) передає inline object/array літерал як props (`classNames={{...}}`, `disabled={[{before:...},...
**Фікс:** statically-known props → module-level `const DAY_PICKER_CLASS_NAMES = {...}`поза компонентом (один alloc на module load). Props що залежать від render input →`useMemo(() => [...], [dep1, dep2])`....

---

### 2026-05-31 — List item component без React.memo + inline callback — toggle expansion/selection у списку

**Сигнал:** компонент-рядок у `.map()` приймає stable primitive props (`{batch, expanded, onToggle, depleted}`) і
**Фікс:** `const Row = memo(function Row({...}) {...})`. Inline callback на батьку → `const handleX = useCallback((id) => setX(prev => prev === id ? null : id), [])`. Передавати `id` параметром у callback (не...

---

### 2026-05-31 — Sequential cron-/scheduler queue.add у onModuleInit — N-orgs scheduler enqueue блокує application bootstrap

**Сигнал:** OnModuleInit hook (типу `FollowUpScheduler`, `ReminderScheduler`, периодичний bootstraper) проходить `for (const org of orgs) { await this.queue.add('job', ..., { repeat: cron, jobId:...
**Фікс:** `await Promise.all(items.map(item => queue.add(..., { jobId: \`x-\${item.id}\`, repeat: cron, ... })))`. BullMQ deduplicates by jobId — paralel add робить N concurrent Redis multi/exec calls (Bull...

---

### 2026-05-31 — PDF/export endpoints over-fetch via include — generatePdf методи з повним include для render data

**Сигнал:** `async generatePdf(orgId, id)` / `async exportX()` робить `findFirst({ where, include: { lines: {...}, parts: {...}, counterparty: true, organisation: findFirst({ where: { id }}) } })`. PDF/CSV...
**Фікс:** замінити `include` на `select` з точним переліком полів що рендеряться у docDef. organisation findFirst → `select: { name: true, edrpou?: true, address?: true }`. lines/parts include → `select: {...

---

### 2026-05-31 — Clone/duplicate операції з ID-only create патерном — `clone(id)` що include тягне labels що НЕ використовуються у create

**Сигнал:** `async clone(orgId, id, userId)` / `async duplicate(...)` робить `findFirst({ include: { related: { select: { name: true } }, lines: { include: { fk: { select: { name: true } } } } } })` — include...
**Фікс:** замінити include на narrow select що залишає ЛИШЕ FK scalars + business поля що йдуть у create (price/quantity/normoHours/amount/notes). Видалити related entity nested select entirely. AuditEvent...

---

### 2026-05-31 — `similarity()` обчислюється кілька разів per row у $queryRaw search — pg_trgm `%` оператор vs `similarity() > threshold`

**Сигнал:** raw SQL search query використовує `similarity(col, $q) > 0.1` у WHERE І `ORDER BY similarity(col, $q) DESC` у тому ж запиті. Postgres не може дедуплікувати — обчислює `similarity()` двічі per row....
**Grep:** `similarity(`
**Фікс:** subquery або CTE винесе обчислення `similarity()` як column → ORDER BY читає pre-computed value. WHERE замінити на `col % $q` (set-similarity operator) — planner використовує GIN trgm index для...

---

### 2026-05-31 — Speculative duplicate-check у tier-merger update — коли значення-для-порівняння живе в existing row

**Сигнал:** метод `update(orgId, id, dto)` має класичний "оптимізований" 2-фазний паттерн: (1) findFirst для existing, (2) IF dto.field !== existing.field — findFirst для duplicate-check. Друга фаза умовна на...
**Фікс:** speculative — запустити duplicate.findFirst у Promise.all з existing.findFirst незалежно від того чи `dto.X !== existing.X`. ПІСЛЯ awaits — звичайна перевірка `if (dto.X && dto.X !== existing.X &&...

---

### 2026-05-31 — `findOne + update` 2-RTT pattern для simple soft-delete/update — заміна на `updateMany` з orgId guard

**Сигнал:** простий CRUD-сервіс має `async update(orgId, id, dto)` що робить `await this.findOne(orgId, id)` (404 guard через findFirst) → `await prisma.X.update({ where: { id, orgId }, data: {...} })`. Те саме...
**Фікс:** `await prisma.X.updateMany({ where: { id, orgId, deletedAt: null }, data })` → `if (updated.count === 0) throw NotFoundException`. Для `update` що має повернути updated row — додати окремий findFirst...

---

### 2026-05-31 — Навігаційний prefetch при hover — дані готові до кліку (~200 мс)

**Сигнал:** при переході між сторінками завжди є помітна пауза — spinner або skeleton після кліку на NavLink. Дані API починають завантажуватись тільки після mount компонента, хоча JS chunk вже prefetch'ений...
**Фікс:** module-level `PREFETCH_MAP: Record<string, (qc) => void>` з `qc.prefetchQuery(...)` для кожного NAV item. `onMouseEnter={() => employee && PREFETCH_MAP[href]?.(queryClient)}`. Обов'язково: (1)...

---

### 2026-05-31 — TanStack Query міграція list-сторінок — useEffect+apiFetch без кешу

**Сигнал:** при повторному відвідуванні сторінки (A→B→A) — знову spinner/skeleton хоча дані тільки що були. `useEffect → apiFetch → setState` не кешує нічого між unmount/mount.
**Grep:** `const load = useCallback\|useState.*\[\]\|setLoading.*true`
**Фікс:** (1) створити `hooks/api/useX.ts` з `useQuery(staleTime:30s, gcTime:5m, placeholderData:keepPreviousData, enabled:!!employee)`; (2) замінити useState/load/useEffect на `const { data, isLoading } =...

---

### 2026-05-31 — keepPreviousData у useQuery — таблиця не мерехтить при зміні фільтрів

**Сигнал:** при зміні статус-фільтра або введенні в search — таблиця зникає (spinner) на 300-500мс, потім з'являються нові дані. Спостерігається навіть при швидкій мережі.
**Grep:** `useQuery`
**Фікс:** `import { keepPreviousData } from '@tanstack/react-query'` + `placeholderData: keepPreviousData` у кожному `useQuery` для paginated list.
**Реальний impact:** UX відчувається плавним — старі дані...

---

### 2026-05-31 — Частковий prefetch — сторінка має N hooks, у PREFETCH_MAP покрито лише M<N

**Сигнал:** маршрут є у PREFETCH_MAP, але сторінка викликає кілька різних useQuery hooks (5 для dashboard, 4 для infrastructure). У PREFETCH_MAP покрита тільки частина — інші hooks все одно роблять fetch після...
**Фікс:** додати решту `qc.prefetchQuery` у тому самому PrefetchFn — паралельно, у тому ж closure. Для date-залежних ключів (revenue chart з today+weekStart) — використати module-level KYIV_DATE_FMT singleton...

---

### 2026-05-31 — keepPreviousData у hooks з form-control параметрами — не лише filter pills, а й from/to/tab dropdowns

**Сигнал:** reports/analytics-сторінка має 2-3 form controls (`from` date, `to` date, `tab` selector) — кожна зміна викликає новий запит з новим queryKey. Без `placeholderData: keepPreviousData` — графік/таблиця...
**Grep:** `useQuery`
**Фікс:** додати `import { keepPreviousData } from '@tanstack/react-query'` + `placeholderData: keepPreviousData` у hook конфіг. Поведінка: при зміні параметрів React Query повертає `data` попередньої успішної...

---

### 2026-06-01 — Sequential `tx.X.create` у $transaction callback — runtime hot-path (не bootstrap)

**Сигнал:** `for (const x of list) { await tx.X.create({...}) }` всередині `$transaction(async tx => {...})` де: (a) кожен create незалежний (немає read-залежностей від попередніх iterations), (b) не...
**Grep:** `for \(const \w+ of \w+\) \{[\s\S]{0,200}tx\.\w+\.create\(`
**Фікс:** build `linesData: Prisma.XCreateManyInput[]` array у циклі замість `tx.X.create()`, потім `await tx.X.createMany({ data: linesData })`. createMany робить **один** INSERT з N рядками — найшвидший...

---

### 2026-06-01 — Dev-only npm package у production bundle — static import гарантує bundle inclusion навіть за runtime гілку

**Сигнал:** компонент-провайдер (QueryProvider, ThemeProvider, FeatureFlagsProvider) робить
**Фікс:** замінити static import на conditional `next/dynamic`:

---

### 2026-06-01 — Auth-gated UI widgets у root layout — render-blocked для unauthenticated, але код у layout chunk

**Сигнал:** `TopShell`/`AppShell`/`AuthenticatedLayout` (компонент що рендериться у root `layout.tsx` через `app/layout.tsx` → `<TopShell>{children}</TopShell>`) робить статичний `import { CommandPalette,...
**Фікс:** замінити статичні імпорти на `next/dynamic` для conditional widgets:

---

### 2026-06-01 — Heavy modal у page chunk блокує table view — `Modal` із 300+ LOC форми у тому самому файлі що list view

**Сигнал:** сторінка-список (`PricingRulesClient.tsx`, `EmployeesClient.tsx`, `CrmPage.tsx`) має `function XFormModal({...}) { ... 300+ LOC ... }` у тому самому файлі що render таблиці. Modal використовує...
**Фікс:** трикомпонентний refactor:

---

### 2026-06-01 — Multi-loop sequential fan-out з shared dedup state — notification/email/sms dispatcher методи

**Сигнал:** processor/scheduler метод має 2+ окремих `for (const x of source) { ... if (!shared.has(key)) shared.add(key); await dispatcher.send(...) }` циклів. Між циклами шарується `Set<string>` для...
**Grep:** `for \(const .* of .*\) \{[\s\S]{0,200}await this\.\w+\.send\(`
**Фікс:** 1-й pass: collect+dedupe → `recipients: Recipient[]` (sync, fast). 2-й pass: `await Promise.allSettled(recipients.map(r => dispatcher.send(...)))`. 3-й pass: iterate `results[]` для error tracking +...

---

### 2026-06-02 — Soft-delete `remove()` з business-rule guard (isSystem/isLocked) — переписати на updateMany з guard у WHERE з fallback на cheap re-read

**Сигнал:** Service має простий `async remove(orgId, id)` що завжди робить (1) `findFirst` для tenant guard + business-rule guard (isSystem/isLocked/status check), (2) `update` для soft-delete. Існуючий паттерн...
**Grep:** `async remove\(orgId.*id\)`
**Фікс:** `updateMany({ where: { id, orgId, deletedAt: null, isSystem: false }, data: { deletedAt: new Date() } })`. Якщо count===0 → cheap fallback `findFirst({ where: { id, orgId, deletedAt: null }, select:...

---

### 2026-06-02 — Speculative duplicate-check у update з business-rule перевіркою — paralleлити Promise.all навіть коли duplicate check умовна

**Сигнал:** `async update(orgId, id, dto)` робить `findFirst` для tenant guard, потім (умовно) `if (dto.X && dto.X !== existing.X) { duplicate.findFirst }` — другий запит вирішують виконати на основі результату...
**Фікс:** запустити обидва запити у `Promise.all([existing, dto.X ? duplicate : Promise.resolve(null)])`. ПІСЛЯ awaits — `if (!existing) throw NotFound; if (dto.X && existing.X !== dto.X && duplicate) throw...

---

### 2026-06-03 — Fresh `[]` literal у `data?.items ?? []` → useEffect([items]) фаєрить кожен рендер — Bug-#328 cascade pattern

**Сигнал:** сторінка-список читає React Query result як `const orders = queryData?.items ?? []` або `const { data: list = [] } = useX()` (destructure default). Далі `useBulkSelect(orders)` або інший hook з...
**Фікс:** у hook що повертає paginated дані експортувати module-level `export const EMPTY_ITEMS: readonly never[] = Object.freeze([])`. Call-sites переходять на `data?.items ?? (EMPTY_ITEMS as unknown as...

---

### 2026-06-03 — Bug fix у hook не пропагований на call-sites — `useListPage` приклад

**Сигнал:** comprehensive QA знаходить regression bug (Bug #328: fresh `[]` → useEffect race), виправляє у новому композитному hook (`useListPage`), додає regression test. Бачимо в memo manual "Bug #328 fixed"....
**Фікс:** опція А — export shared primitive (`EMPTY_ITEMS`, `STABLE_FALLBACK`) з hook що його використовує; call-sites імпортують і використовують напряму до повної міграції. Опція Б — мігрувати негайно (якщо...

---

### 2026-06-03 — Limit cap на endpoints що приймають user-controlled pagination — DoS hardening для `?limit=999999`

**Сигнал:** controller метод приймає `@Query('limit') limit = '20'` і передає у service як `+limit` (Number conversion) без cap. Service `findMany({ take: limit })`. Захист на limit є тільки у деяких endpoints...
**Фікс:** на початку service findAll: `const safeLimit = Math.min(Math.max(limit, 1), 200); limit = safeLimit;`. Опціонально `page = Math.max(page, 1)` (захист від `?page=-1`). 200 — типовий cap для list...

---

### 2026-06-03 — Optional guard блокує main aggregation у reports — sequential branch/employee/warehouse findFirst перед raw SQL

**Сигнал:** report-метод (revenue, workOrders, stock, load, profitability) починається з `if (branchId) { const branch = await this.prisma.X.findFirst(...); if (!branch) throw }`, потім робить тяжкий `$queryRaw`...
**Фікс:** `const [guard, rows] = await Promise.all([X ? findFirst(select:id) : Promise.resolve(null), $queryRaw...])`. ПІСЛЯ awaits: `if (X && !guard) throw NotFound`. Failure mode: aggregation на неіснуючому...

---

### 2026-06-03 — findOne як guard у update/create методах де update сам повертає DTO — narrow до id-only select

**Сигнал:** метод `update(orgId, id, dto)` або `createChild(orgId, parentId, dto)` починається з `await this.findOne(orgId, id)` — повертає повний DTO з усіма include relations, але результат
**Фікс:** замінити `await this.findOne(orgId, id)` на `const existing = await this.prisma.X.findFirst({ where: { id, orgId, deletedAt: null }, select: { id: true } }); if (!existing) throw...

---

### 2026-06-03 — Weighted SUM у JS reduce замість Postgres aggregate — `findMany(select scalars) + reduce(qty * cost)`

**Сигнал:** хелпер що рахує середньозважене значення (avg cost, avg margin, weighted score) робить `findMany({ select: { qty, cost } })` потім `.reduce((s, b) => s + b.qty * b.cost, 0)` + `.reduce((s, b) => s +...
**Фікс:** `$queryRaw<{total_cost, total_qty}[]>SELECT SUM(qty \* cost) AS total_cost, SUM(qty) AS total_qty FROM X WHERE...` У CTE можна зберегти detminism (ORDER BY createdAt DESC + LIMIT N), якщо потрібно...

---

### 2026-06-04 — BullMQ processor без `concurrency` — I/O-bound job processors з external HTTP calls

**Сигнал:** `@Processor('queue-name')` + `@Process('job-name')` без `concurrency` опції. За замовчуванням `@nestjs/bull` обробляє 1 job одночасно на processor. Якщо кожен job — окремий зовнішній HTTP виклик з...
**Grep:** `@Process(`
**Фікс:** `@Process({ name: 'job-name', concurrency: N })`. Де N = кількість одночасних HTTP connections безпечна для провайдера. Хороші значення: webhook delivery: 5 (загальні HTTP endpoints); SMS TurboSMS: 3...

---

### 2026-06-04 — Shared config fetched per-recipient in N-to-1 broadcast processor — batch notification dispatchers

**Сигнал:** BullMQ processor (або scheduled job) будує список N recipients і для кожного викликає `service.send(orgId, recipientId, event, payload)`, де `send()` всередині тягне
**Фікс:** розбити `sendX()` на (1) `resolveConfig(orgId, branchId, event): Config | null` (async, DB reads) + (2) `sendWithConfig(orgId, recipient, config, vars)` (async, лише queue.add без DB). Processor:...

---

### 2026-06-05 — Frontend N+1 через per-item GET у nested fetch loop — детальні сторінки що завантажують вкладену колекцію per-row

**Сигнал:** detail-сторінка (`/X/[id]/PageClient.tsx`) має 2-stage fetch — stage 1 завантажує колекцію parents (garages, vehicles, items), stage 2 робить `Promise.all(parents.map(p => apiFetch('/child?parentId='...
**Фікс:** на backend — додати CSV-параметр `?xIds=`+ parse →`vehicleId: { in: ids }`у where; cap 200 IDs + take 500 для захисту. Frontend —`apiFetch(`${url}?xIds=${ids.join(',')}`)` ОДИН раз. Тип...

---

### 2026-06-06 — Bulk-filter через GRANDPARENT-relation замість CSV IDs — коли intermediate-FK list (garages, branches) суто проміжний

**Сигнал:** Frontend має триступеневу ієрархію: grandparent (counterparty) → parent (garage) → child (vehicle). API має filter `?parentId=X` (single FK). Frontend робить класичний waterfall: `GET...
**Фікс:** на backend — додати у child controller новий `@Query('grandparentId')`(i.e.`?counterpartyId=`). У service: `where: { ..., parent: { grandparentId, orgId, deletedAt: null } }` — Prisma nested...

---

### 2026-06-05 — Bootstrap scheduler з per-org secondary fetch — onModuleInit/cron-init що читає settings/config окремо для кожної org

**Сигнал:** scheduler (`OnModuleInit`) робить `Promise.all(orgs.map(org => this.scheduleForOrg(org.id)))` де `scheduleForOrg` всередині починається з `await prisma.organisationSettings.findUnique({ where: {...
**Фікс:** на onModuleInit — prefetch ВСІХ settings одним `findMany({ select: { orgId, X } })`→ Map<orgId, X>. Helper розбити на: public`scheduleForOrg(orgId)` (single-use, тягне settings всередині як було) +...

---

### 2026-06-10 — `data: X = {}` destructure default у useQuery — Bug #328 cascade для object literals (не лише arrays)

**Сигнал:** компонент-сторінка викликає `const { data: linkedCounts = {} } = useQuery<Map>(...)` (або інша назва) — fallback empty object при initial-load. Pattern «Fresh `[]` literal у `data?.items ?? []`» уже...
**Grep:** `useQuery.*\n.*data: \w+ = \{\}`
**Фікс:** оголосити module-level `const EMPTY_X: T = Object.freeze({}) as T` поза функцією-компонентом. Cast потрібен бо TypeScript не дозволяє `Readonly<{}>` присвоювати до mutable map — runtime семантика...

---

### 2026-06-05 — Per-render `getCached()`/sessionStorage read — composable hook без lazy state initializer

**Сигнал:** composable hook (типу `useCachedRefData`) робить `const cached = getCached(cacheKey)` як
**Фікс:** `const [state, setState] = useState<T>(() => getCached<T>(cacheKey) ?? fallback)`. Парні `useState` що залежать від того самого read — переписати кожен як окремий lazy initializer (з вкладеним...

---
