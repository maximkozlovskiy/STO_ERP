---
name: sto-optimize
description: >
  Performance optimization skill for STO ERP. Audits backend (NestJS/Prisma) and
  frontend (Next.js) for bottlenecks: N+1 queries, missing DB indexes, sequential
  fetches that could be parallel, bundle size, React re-renders, missing cache.
  Finds, fixes, and commits all issues automatically.
  Invoke: /sto-optimize
model: claude-opus-4-8
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
git diff HEAD --name-only | head -30   # scope
cat MemoryManual.md | head -50          # стан проєкту
```

Визнач агрегати зі scope → читай дос'є (`docs/objects/<entity>.md`): існуючі індекси, відомі N+1 та кеш-патерни для агрегату.

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

Для кожної проблеми: прочитай файл → мінімальний точковий фікс → `pnpm --filter <package> exec tsc --noEmit` (0 errors) → якщо schema.prisma змінена: `cd packages/database && npx prisma db push --skip-generate`.

**Пріоритет:** (1) N+1 та waterfall; (2) відсутні індекси; (3) sequential→parallel; (4) cache miss; (5) bundle/memo (найменший ризик).

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

`## Останній commit` → `<hash> <message>` + `Дата`; `## Поточний стан` → `TypeScript: ✅ 0 errors`.

---

## Крок 7 — Самовдосконалення скіла (ОБОВ'ЯЗКОВО після кожної ітерації)

Запитай себе: **"Цей патерн вже покритий чеклістом? Чи є новий тип неефективності вперше?"**

**Записуй** новий: тип неефективності (анти-патерн) · контекстний сигнал (grep/структура/назва) · причину виникнення · наслідок (запити/ms/kB).
**Не записуй:** конкретні файли/рядки · готові шаблони коду (для цього Кроки 1-3) · те що вже в чеклісті.

**Формат запису** у секцію "Накопичені підходи":

```
### [Дата] — [Тип] — [Де]
**Сигнал:** ознака для авто-пошуку   **Причина виникнення:** чому так пишуть
**Підхід до виявлення:** принцип пошуку   **Підхід до фіксу:** принцип рішення
**Реальний impact:** що змінилось   **Де шукати ще:** суміжні місця
```

**Оновлення чекліста** (якщо патерн підтверджений у коді): додати grep-підрозділ у Крок 1/2/3 + запис у "Накопичені підходи" → коміт `docs(skills): add <pattern> to sto-optimize`.

---

## Накопичені підходи (оновлюється автоматично)

### 2026-09-02 (cycle 2) — Concurrency-guard `.select` на upsert НЕ додає RTT — Prisma UPDATE ... RETURNING одним statement

**Сигнал:** post-check `if (upserted.quantity < 0) throw` після `db.stockItem.upsert({..., select: {quantity, reserved}})` як race-захист. Prisma `upsert({select})` компілюється у `INSERT ... ON CONFLICT ... UPDATE ... RETURNING` — ОДИН statement; `.select` лише звужує returning-shape, НЕ додає окремий SELECT. Concurrency-guard безкоштовний по DB RTT (лишається 2 JS `if`).
**Сигнал-grep:** `grep -B5 -A5 "\.upsert\(" apps/api/src/modules/ --include="*.service.ts" | grep -E "\.select:|select: \{"`. Якщо після upsert є `if (result.X < 0) throw` — це guard, НЕ окремий RTT. НЕ пропонувати "злити select з upsert".
**Причина виникнення:** інтуїція «select — окремий query» з `findFirst({select})`. Для write ops (upsert/create/update/delete) Prisma завжди повертає row (`RETURNING`); `.select` — це проекція returning-shape.
**Підхід до виявлення/фіксу:** перед пропозицією "збенефічити upsert" — перевірити фактичний SQL (EXPLAIN / `prisma:query`). Для write ops `.select` безкоштовний. Це анти-паттерн: НЕ виправляти те що не зламане; **impact null** — документувати щоб не втратити цикл.
**Де шукати ще:** будь-який concurrency-fix що додає `.select` до upsert/update/create + post-check. Якщо PR message каже «post-check ЧЕРЕЗ додатковий select» — pushback з реальним SQL.

---

### 2026-09-02 (cycle 2) — Conditional-decrement через `updateMany + WHERE guard-col + count check` — race-safe безкоштовно, PK lookup O(1)

**Сигнал:** hot-path counter декремент (`stockBatch.remainingQty`, `stockItem.quantity`, `bankAccount.balance`, `remainingAllocation`) під concurrent write: read snapshot → decrement може дати negative без row-lock. Fix без блокуючого lock: `updateMany({where: {id, guardCol: {gte: take}}, data: {decrement}})` + `if (count === 0) throw`. При race інший tx декрементив між findMany і updateMany → guardCol < take → updateMany скіпає row → count=0 → throw → $tx rollback.
**Сигнал-grep:** для кожного `.update({where:{id}, data:{X:{decrement:qty}}})` на counter-таблиці (StockBatch, StockItem, Account, Wallet, Reservation) під polling — переписати у `updateMany({where:{id, X:{gte:qty}}, data:{X:{decrement:qty}}})` + count-check. НЕ додає RTT (count у тому ж response).
**Причина виникнення:** Prisma default isolation = ReadCommitted → row-lock тримається лише на statement, не між findMany + update. 2 read-и бачать той самий remainingQty → double decrement → negative.
**Підхід до виявлення:** counter-decrement у append/consume/reserve/allocate методах без conditional where; особливо у `while (remaining > 0)` циклах (consumeBatch, drainQueue, allocatePayments).
**Підхід до фіксу:** `.update → .updateMany({where:{id, counter:{gte:take}}})`. `if (updated.count === 0) throw` → $tx rollback. По PK id → primary index, heap re-filter counter, O(1). Не потрібно Serializable isolation.
**Де шукати ще:** StockBatch.remainingQty (fixed), StockItem.quantity (fixed), Invoice/Payment.remainingAllocation, Reservation.remainingQty, Voucher.remainingUses, Wallet.balance. Будь-який monotonic counter що може стати negative під race.

---

### 2026-09-02 (cycle 2) — `Object.values(obj).reduce()` після filter-loop → накопичувати суму під час фільтрації, один прохід

**Сигнал:** заповнюється `byX[key] = value` (з умовою `if (value > threshold)`), потім `total = Object.values(byX).reduce((s,v)=>s+v, 0)`. Два проходи. У `.map(supplier => {...})` × 50 suppliers = 50 Object.values-arrays + 50 closures. Merge у один цикл: `if (value > threshold) { byX[key] = value; sum += value; }`.
**Сигнал-grep:** `grep -rn "Object\.values\([a-zA-Z]\+\)\.reduce" apps/api/src/modules/ --include="*.service.ts"`. Cross-check: чи `Object.values.reduce` йде ПІСЛЯ циклу що будував той самий об'єкт з умовою.
**Причина виникнення:** декларативний стиль (1) заповнити мапу, (2) `total = sum of values`. У hot-path tight-loop N alloc + N iter per каскад.
**Підхід до виявлення/фіксу:** `.reduce()` де джерело — щойно побудований об'єкт (for/of у попередніх 5-10 рядках) → `let sumX = 0` перед loop, `sumX += v` у циклі (під тією ж filter-умовою), замінити `Object.values.reduce` на прямий `sumX`.
**Реальний impact:** 50 suppliers × ~20 dates: 50 alloc arrays + 1000 reduce iter → 0. GC pressure знижений, sustained p95 saving.
**Де шукати ще:** aggregation-service getSchedule/getSummary/getReport що будує `byX={}` з filter-inserts + `Object.values.reduce` для total; report generators, dashboard tiles, PDF summary. Родич — `.forEach(x=>acc[k]=v) + Object.values(acc).reduce`.

---

### 2026-09-02 (cycle 2) — Три `.reduce()` підряд по одному масиву → merge у single-pass for-of з 3+ accumulators

**Сигнал:** `const A = lineData.reduce(s+priceWithoutVat); const B = lineData.reduce(s+vatAmount); const C = lineData.reduce(s+priceWithVat)`. Три проходи × 3 closure. 100 рядків: 300 iter → 100 iter + 0 closure. Розширення "multi-scan reduce" (2026-08-30) для DTO/save.
**Сигнал-grep:** `grep -rn "reduce.*=>.*reduce" apps/api/src/modules/`; або 2-3 підряд рядки `const \w+ = \w+\.reduce(...)`.
**Причина виникнення:** кожна формула окремо для читабельності. У save-path (invoice clone, WO save, PO recompute) — hot-path з polling/typing.
**Підхід до виявлення/фіксу:** для service-method що будує DTO/persist entity — consecutive `.reduce()` на тому самому array (≥2 з різними extracts) → `let A=0; let B=0; let C=0; for (const l of lines) { A += Number(l.a); ... }`. Не merge коли reduce мають різні seed/transform (average, product, fold) — тільки sums.
**Реальний impact:** 100-line invoice: 300→100 iter. p95 gain 0.1-0.5ms/call.
**Де шукати ще:** invoice clone/updateInvoiceFromWO, PO recomputeTotals, WO recalcTotals, stock-document totals, receipt-doc save, supplier-return totals. Будь-який entity з lines що після build-loop збирає multiple sum totals.

---

### 2026-09-02 — Compound-index sort-tail miss на INTERNAL paginated hot-path helper — WHERE-префікс покритий, ORDER BY-column НЕ у tail → external sort per page

**Сигнал:** append-only child-table (StockBatch, StockMovement, AuditLog, BatchConsumption) читається з paginated service-helper (не HTTP) через `findMany({where: {orgId, fk1, fk2, bool_flag: true, remainingQty: {gt:0}}, orderBy: {createdAt}, take: PAGE})` у `while (remaining > 0)`. WHERE-equality покрито `(orgId, fk1, fk2, bool_flag)`, але sort-column (`createdAt`) НЕ у tail → **external sort** на КОЖНІЙ сторінці. Під polling (кожен WRITEOFF/WO-COMPLETED/TRANSFER-out) — sustained CPU, невидимо у single-call. Родич "Public hot-path multi-field WHERE" (2026-06-20), але для INTERNAL helper з sort у tight loop.
**Сигнал-grep:** `findMany({...orderBy: {createdAt|expiryDate|documentDate}, take:...})` всередині циклу (`while`/`for`/`.map(async)`). Якщо WHERE = усе equality + sort = один column → потрібен `(orgId, ...equality_cols, sort_col)`. Cross-check schema.prisma: `(orgId, fk1, fk2, bool_flag)` БЕЗ tail `createdAt` = drift. Особливо consumeBatch/returnToBatch/processQueue/drainOutbox.
**Причина виникнення:** compound-index створювався під CRUD (`findFirst` без orderBy — покриває повністю). Пізніша pagination-feature додала `orderBy` — "WHERE вже покритий → швидко". EXPLAIN `Sort` node видно тільки при профілюванні.
**Підхід до фіксу:** migration `CREATE INDEX IF NOT EXISTS ... ON <table> (orgId, ...equality_FK у порядку selectivity, low-card bool_flag, sort_col ОСТАННІМ)`. B-tree покриває asc+desc одним index. НЕ додавати range-cols (`remainingQty > 0`) — heap re-filter. Дзеркалити у `@@index([...])`.
**Реальний impact:** stock_batches 10-50k/org, consumeBatch кожні 100мс: per-page sort ~1-3мс → index-order scan ~0.2-0.5мс × N pages. Sustained percentile saving + звільняє shared_buffers.
**Де шукати ще:** consumeBatch (FIFO/LIFO), drainOutbox, processQueue, auditLog cleanup, reconciliation act, notifications dispatch. Checkpoint при feat що додає paginated internal helper — index на `(where_cols, sort_col)` майже завжди відсутній якщо index створювався під CRUD-list без orderBy.

---

### 2026-08-30 (cycle 3/3) — Sibling-drift audit: після нового hot-path fix одразу пройтись по ВСІХ sibling-services/components і зафіксувати у той же коміт

**Сигнал:** попередній цикл фіксив один hot-path патерн (напр. SP*SORT_FIELDS у одному CRUD-модулі), але наступний grep біжить тільки по нещодавно зміненому файлі. Sibling-модулі (invoices/WO/PO/SD — усі мають `findAll(sortBy?)` з `SORT: Record<string,string>` у body) лишаються не-міграцованими (copy-paste-legacy). Пропущений цикл-2 фікс → цикл-3 фіксить ще 4 sibling.
**Сигнал-grep:** після кожного perf-фіксу — виконувати ІДЕНТИЧНИЙ grep-signature (той що знайшов original) на ВСІХ файлах шару, не тільки git-diff-scope. Приклад: `grep -rn "^\s\+const [A-Z*]\+: Record<" apps/api/src/modules/ --include="_.service.ts"`дає повний список drift. Той самий підхід для frontend`EMPTY\__` літералів у body.
**Причина виникнення:** розробники копіюють CRUD-модулі один з одного; sort-whitelist "в body бо тільки тут" переноситься з файлу в файл. Perf-audit цикл N рухається fresh по recent changes — legacy код не отримує аудиту automatically. Треба явно EXTEND scope grep-у.
**Підхід до виявлення/фіксу:** після "hoist alloc from body" fix — grep-signature на ВСІХ файлах directory; hits тепер vs до = має бути N-1; якщо >1 — усі fixed у той самий atomic commit. Prefix консистентний (`<MODULE>_SORT_FIELDS`, `<MODULE>\_INCLUDE`). Commit body перераховує всі sibling. НЕ merge у shared const якщо семантика різна (invoices sort by dueDate vs PO by totalAmount) — merge тільки copy-paste identical.
**Реальний impact:** цикл-3 фіксив 8 sibling-drifts за прохід (5 sort-fields + 1 balance-sign + 2 calendar shapes). Без sibling-audit — O(N) circular repetition; atomic protocol = 1 pass, O(1) commits.
**Де шукати ще:** ЛЮБИЙ perf pattern — після fix у 1-му модулі extend grep на весь directory. Особливо: sort-whitelists (10+ CRUD services), Prisma include/select shapes у mutations, EMPTY__/DEFAULT\__ літерали, frontend regex constants, balance/status/discriminator maps.

---

### 2026-08-30 — Sort-field whitelist Record/tuple-array declared INSIDE service `findAll` body — re-allocated on every list request under polling

**Сигнал:** `findAll(sortBy?, sortDir?)` містить `const SORT_FIELDS: Record<string, string> = {...}` (або tuple/enum-labels) у тілі функції. Кожен list-запит (polling 30s + filter/pagination + tab switch) → alloc заново. Frontend-варіант: той самий Record у `visibleColumns.map(col => {...})` callback (N×render amplification). Той самий підпис для tuple-arrays — static filter options `[['', 'Всі'], ...]` у body.
**Сигнал-grep:** backend `grep -rn "^\s\+const [A-Z_]\{3,\}: Record<" apps/api/src/modules/ --include="*.service.ts"` (indent-guard забирає module-level). Frontend `grep -rn "^\s\+const [A-Z_]\{3,\}: (Record|Array|\{)" apps/web/src/app/ --include="*.tsx"` + `grep -rn "\.map(.*=> {[\s\S]{0,200}const [A-Z_]" apps/web/src/` (inside-map). Regex-версія — `grep -rn "^\s\+const [A-Z_]\+_RE = /" apps/web/src/`.
**Причина виникнення:** whitelist ставлять поруч з єдиним споживачем ("одне місце правди"). Не помічають: (a) backend service метод request-scoped, не JIT-optimized як tight loop; (b) React re-runs body top-to-bottom; (c) inside `.map()` — N× amplification. Compilation-time constants семантично identical до module-level.
**Підхід до виявлення/фіксу:** для public `findAll`/`findMany` — перші 20-30 рядків, `const [A-Z_]+: (Record|Array|readonly) = {...}` з literal values → hoist на module-level з owner-prefix (`SP_SORT_FIELDS`, `INV_SORT_FIELDS`; regex `PO_UUID_RE`). Замінити callsite-refs. НЕ виносити коли: whitelist depends on reactive prop / useMemo-subresult / містить closure-scope callbacks.
**Реальний impact:** backend 1 hash+4 strings/call → 0. Frontend inside `.map()`: typing 20 chars @ 7 columns × 20 renders = 140 alloc → 0. Regex compile переноситься з render у module load.
**Де шукати ще:** будь-який `findAll`/`findMany`/`search`/`filter` — sort-whitelists, filter-key allowlists, field-alias maps. Frontend SORTABLE Records inside `.map()`; error-message Records у validate(); regex у effect body. Checkpoint при feat що додає sortable колонку / list endpoint.

---

### 2026-08-30 — Multi-scan reduce accumulator у aggregation service — суперSet of 2026-06-17 twin-scan для 3+ reduce з різними semantics

**Сигнал:** aggregation service (getSchedule/getSummary/getReport/getBalances) після compute-loop будує totals через 3+ `.reduce()` на тому самому масиві (`suppliers`/`entities`/`lines`) + loop-with-reduce на 2-му вимірі (`dates` × per-date reduce). Розширення "twin-scan reduce" (2026-06-17) на report-hot-path з двовимірною aggregation.
**Сигнал-grep:** `const \w+ = \{[\s\S]{0,300}\.reduce\([\s\S]{0,200}\.reduce\([\s\S]{0,200}\.reduce\(` (3+ reduce у object-літерал); або `for (const \w+ of \w+) {[\s\S]{0,100}reduce\(` (reduce у for-of, N×D). Підтверджуючий: `if (sum > 0) totals.byDate[d] = sum` після reduce.
**Причина виникнення:** кожна формула окремо для читабельності (overdue-sum, planned-sum, per-date-sum). N-times passes; специфічно для report з 2+ вимірами (суб'єкт × горизонт).
**Підхід до фіксу:** single-pass for-of з локальними `let`-акумуляторами; для двовимірного — nested for-in по inner keys (plain object швидший для string keys); post-loop prune порожніх buckets; preserve `?? 0` undefined-handling.
**Реальний impact:** getSchedule 50 suppliers × 20 dates: 1150 iter + 23 closures → ~500-800 ops + 0 closures. ~50% CPU у totals, 100% closure-alloc elimination.
**Де шукати ще:** `get{Schedule|Summary|Report|Balances|Statistics}` з двовимірним output (suppliers×dates, customers×months, branches×status). `{items, totals}` → totals завжди кандидат. Checkpoint при feat з 3+ агрегатами у response.

---

### 2026-08-30 — Aggregation-endpoint фільтрує reference-таблицю за discriminator-ом що не є FK — базовий `(orgId, fkId, deletedAt)` не покриває, потрібен `(orgId, discriminator, deletedAt)` окремо

**Сигнал:** aggregation-метод (`getSchedule`/`getSummary`/`getBalances`/`getReport`) читає reference-таблицю (contracts, price-lists, warranties, categories, rates) не через FK, а через SEMANTIC-discriminator: `where: {orgId, contractType: 'PURCHASE', creditLimit: {not: null}, deletedAt: null}` — жодного FK-id. Базовий `(orgId, fkId, deletedAt)` (під CRUD-list) НЕ активується → Postgres звужує лише по orgId + heap re-filter. Fetched у Promise.all, час maskується, але polling staleTime=30s × N users. feat-commit додає endpoint БЕЗ супутньої migration.
**Сигнал-grep:** для service-методу з `Promise.all([...])` з ≥2 findMany/groupBy — виписати WHERE-shape кожного. Для reference-таблиці (Contract, PriceList, Rate, Warranty, Category) перевірити чи є `(orgId, ...discriminators, deletedAt)` де discriminators = літерал-value fields, не FK. Якщо index-и лише `(orgId, fkId, deletedAt)` + `(orgId, syncVersion)` → drift.
**Причина виникнення:** reference-index створювався під "показати X-и цього Y-а" (CRUD). Нова feature читає cross-cutting ("всі PURCHASE-контракти org-а") — WHERE ортогональний до CRUD-index. EXPLAIN: `Bitmap Heap Scan` з `Filter:` по discriminator, або `Seq Scan`.
**Підхід до фіксу:** migration `CREATE INDEX IF NOT EXISTS "<table>_orgId_<discriminator>_deletedAt_idx"` — discriminator у leftmost position ПІСЛЯ orgId (селективність спадно: contractType раніше ніж isPrimary), deletedAt останнім. НЕ включати `creditLimit: {not: null}` (heap re-filter швидший за partial index). Дзеркалити у `@@index`. Одна migration для всіх reference-tables (atomic).
**Реальний impact:** counterparty_contracts 1000/org, polling 30s: bitmap heap scan ≈5-15ms → index-narrow ≈0.5-2ms. Endpoint fetch-ає ~5-10 reference-tables → sum 20-100ms P50. Найбільший win під cold cache.
**Де шукати ще:** aggregation/report/schedule метод з Promise.all що читає reference через discriminator: SupplierPayment.getSchedule (contractType), Report.getPricing (isActive+scope), Report.getWarranties (status+expiring), Dashboard.getSummary (rates by currency), Inventory.getLowStock (category+isActive). Checkpoint при feat що додає `get{Schedule|Summary|Report|Balances}`.

---

### 2026-08-30 — Reverse-FK axis miss на child-table що не має власного CRUD-endpoint — indexed тільки прямий FK, нема compound з orgId+reverse-fk+deletedAt

**Сигнал:** child-table "документ-attachment" (SupplierPayment, InvoiceLine, StockBatch, WorkOrderPart) до parent (PO, Invoice, SD, WO) читається 3 способами: (1) `findAll(parentId=?)`, (2) Prisma nested include `where: {<childFk>: {in: [...]}}`, (3) `groupBy` з `<childFk>: null`. Existing indexes покривають self-CRUD (`orgId,deletedAt`; `orgId,ownerFkId,createdAt`; `orgId,status,createdAt`) але НЕ `(orgId, <parentFkId>, deletedAt)`. Причина: parentFkId був nullable optional discriminator при створенні, не primary access path.
**Сигнал-grep:** для child-table з nullable FK на parent (`purchaseOrderId String? @db.Uuid`, ...) — перевірити чи є `@@index([orgId, <parentFkId>, deletedAt])`. Якщо нема — grep service за (a) `findAll(...parentId?)`, (b) `where: {<childFk>: null | {in:[...]}}`, (c) parent-service include `<childCollection>`. Хоча б один з (a)(b)(c) → drift.
**Причина виникнення:** child-generator створює index під self-CRUD. Parent detail-view + aggregation додаються пізніше; Prisma nested include автоматично генерує `WHERE parentFkId IN (...)` — розробник не бачить query.
**Підхід до фіксу:** `(orgId, <parentFkId>, deletedAt)` — orgId, parentFkId (equality-narrow), deletedAt (low-card). Не додавати createdAt (include-и без orderBy). Не partial index — nested include використовує `IN`, не `IS NOT NULL`.
**Реальний impact:** supplier_payments 10k/org, PO деталь: seq-scan ≈15-30ms → index-narrow ≈1-3ms. Prisma include у getSchedule (500 PO × 3-5 payments): N+1-like heap-lookups → clean index seek.
**Де шукати ще:** child-модель з nullable FK на parent-документ + власним controller: StockBatch.stockDocumentId, WarrantyClaim.workOrderId, Attachment.entityId (polymorphic). Checkpoint при новій child-моделі — index у ту саму migration. Bonus: `groupBy` з `<childFk>: null` майже завжди triggerить drift.

---

### 2026-06-20 — Public hot-path multi-field WHERE без супутнього compound B-tree — `(equality_cols, range_col)` index що ставить equality columns першими

**Сигнал:** public-endpoint TTFB-path (напр. `BookingService.getAvailability()` — widget без auth, throttle є, кеша нема) робить `findMany` з multi-field WHERE — 3-5 equality (`orgId`, `branchId`, `status='CONFIRMED'`, `deletedAt IS NULL`) + 1 range (`requestedDate: {gte, lte}`). Existing B-tree indexes покривають лише ПРЕФІКС (`(orgId, status, deletedAt)`) — branchId equality + requestedDate range лишаються heap re-filter. Compound B-tree drift для public hot-path з mix equality+range.
**Сигнал-grep:** для public-route controller (`@Throttle` без `@UseGuards(JwtAuthGuard)` / без `@ApiBearerAuth()`) — зчитати `where` у findMany/findFirst/count; виписати equality cols + range cols (`gte`/`lte`/`in`>1). Cross-check `@@index([...])`: чи перші N equality збігаються з ОДНИМ index у порядку (equality перші, range останнім)? EXPLAIN: `Bitmap Index Scan` з `Filter:` = heap re-filter.
**Причина виникнення:** B-tree leftmost-prefix: WHERE на `(a, c)` без `b` НЕ покриває `(a, b, c)`. Розробник додає новий equality discriminator (branchId) без розуміння що він має бути перед range column. Throttling маскує проблему, але кожен legitimate request платить за heap filter.
**Підхід до фіксу:** migration `CREATE INDEX IF NOT EXISTS ... ON <table> (tenant-guard orgId[+branchId], equality discriminators у порядку selectivity, range column ОСТАННІМ)`. НЕ включати `deletedAt` у leftmost prefix при наявному tenant-guard (cardinality 2). Дзеркалити у `@@index`.
**Реальний impact:** booking_requests 5k/org, getAvailability: bitmap heap scan ≈5-15ms → index-range scan ≈0.5-2ms. Найбільший win під cold cache.
**Де шукати ще:** public/throttled endpoint з filtered list — getAvailability, findByShareToken + downstream lists, public CalendarSlot, quote-share. Checkpoint при feature з 4+ field WHERE на public path; при кожному новому `@Throttle` декораторі з >2 equality + range. Smell test: EXPLAIN `Filter:` rows-removed >0 на public endpoint.

---

### 2026-06-20 — Ordered sub-sequence + independent cross-table write всередині `$transaction` — wrap sub-sequence у async IIFE, Promise.all з незалежним write

**Сигнал:** `update()`/`replace()` у `$transaction` замінює дочірню колекцію (tiers/lines/parts): `await tx.child.deleteMany` + `await tx.child.createMany`, ОДРАЗУ ПІСЛЯ — `await tx.parent.updateMany({where: {id, orgId}, data: scalars})` (інша таблиця, не залежить від tier-операцій). 3 sequential await → 3 RTT. Tier-sequence МУСИТЬ бути ordered (create після delete), але main updateMany ОРТОГОНАЛЬНИЙ. Variant "Disjoint-set updateMany pairs" (2026-06-12) для TRIPLE-await з ordered sub-sequence.
**Сигнал-grep:** `\$transaction\(\s*async tx => \{[\s\S]{0,200}await tx\.\w+\.deleteMany[\s\S]{0,300}await tx\.\w+\.createMany[\s\S]{0,300}await tx\.\w+\.updateMany`. Перші дві операції на одній таблиці (childTier), третя на ІНШІЙ (parent). Якщо всі три на одній — НЕ цей патерн.
**Причина виникнення:** linear-стиль; main update read-залежить ТІЛЬКИ від `id`+`orgId` (sync у scope), не від tier-результату.
**Підхід до фіксу:** обернути ordered sub-sequence у async IIFE: `const tierWork = (async () => { await tx.child.deleteMany(...); if (data.length) await tx.child.createMany(...); })();`; окремо `tx.parent.updateMany(...)` БЕЗ await; `await Promise.all([tierWork, mainUpdate])`; final `findFirstOrThrow` останнім. Race-safe (РІЗНІ таблиці). НЕ коли main update залежить від `tierTotal` з нового tiers (ordered required).
**Реальний impact:** pricing-rules.update() з tiers + main: 3 await → 2 RTT (33% на bulk-edit).
**Де шукати ще:** service-метод що замінює дочірню колекцію + оновлює parent-scalars — invoice.update (lines+totals), workOrder.update (parts+notes), stockDocument.update (lines+warehouseId), PO.update (lines+supplierId), bookingRequest.update (slots+status). TRIPLE await `delete + create + parent.update` де перші два на child, третій на parent.

---

### 2026-06-19 — Trgm index drift у search OR clause — нова/прогаяна колонка у `where.OR = [{ a contains }, { b contains }, { c contains }]` без парного `idx_X_col_trgm`

**Сигнал:** `findAll(query)` має `where.OR = [{colA: {contains: q, mode: 'insensitive'}}, {colB: ...}, {colC: ...}]` (2-5 OR-гілок). Деякі cols покриті GIN trgm (`idx_X_colA_trgm`), але мінімум один — НІ. Після: batch trgm-міграції для "важливих" cols, або пізніша feature додала OR-гілку (`internalCode`) без index. Postgres звужує по `orgId+deletedAt`, потім per-row `LIKE` на non-trgm col.
**Сигнал-grep:** для таблиці з search — порівняти `where.OR` columns vs existing `idx_X_*_trgm`. `goods`: search `[name, sku, barcode]`, trgm = `[name, sku]` → drift на `barcode`. Per column: `grep "_<column>_trgm" packages/database/prisma/migrations/`.
**Причина виникнення:** trgm-міграції batched один раз, не re-аудиту-ються. Нова search column працює (tenant-guard index звужує), але план фолбекає на seq+LIKE.
**Підхід до фіксу:** migration `CREATE INDEX IF NOT EXISTS "idx_<table>_<column>_trgm" ON <table> USING gin ("<column>" gin_trgm_ops);`. Cross-check `pg_trgm` extension (якщо нема — `CREATE EXTENSION IF NOT EXISTS pg_trgm`). НЕ у Prisma schema (GIN не expressed у DSL). Drift у >1 column → одна migration з кількома CREATE INDEX. НЕ плодити для non-WHERE cols (GIN ≈30% INSERT overhead).
**Реальний impact:** goods 50k/org, `q=ART-001` (barcode): seqscan ≈10-50мс → trgm bitmap ≈1-3мс. Barcode scanner у GoodPicker/POS — десятки тисяч сканів/день.
**Де шукати ще:** для КОЖНОЇ моделі з search OR (Good, Counterparty, WorkOrder, Invoice, PO, SD, Employee, Vehicle) — порівняти OR колонки vs trgm indexes. WorkOrder.findAll OR=[number, counterparty.*] — counterparty join cols мають свої trgm. Checkpoint при PR що додає search column.

---

### 2026-06-17 — Twin-scan `reduce()` у backend mutation-hot-path recalc/aggregate helper — single-pass `for…of` з двома акумуляторами

**Сигнал:** service-helper `recalcTotals`/`recomputeAggregates`/`applyDocBalances` (з 6+ mutation entry-points — addLine/updateLine/removeLine/addPart/...) робить `findMany({select})` потім ДВА `.reduce()` по тому ж масиву (`totalLabor = SUM(amount)`; `totalActualLabor = SUM((actualHours ?? normoHours) × price)`). Backend-варіант "Twin-scan reduce у tfoot" (2026-06-11) — per-mutation CPU/GC у hot path.
**Grep:** `\w+\.reduce\([^)]+\);[\s\S]{0,300}\w+\.reduce\(` (той самий identifier). Допоміжний: `findMany` ВИЩЕ з `select` що містить поля обох reduce.
**Причина виникнення:** формула змінилась → нова reduce поряд зі старою. Хибне "1 раз на mutation". Реально: WO з 50 лініями × 6 mutation типів = 600 wasted ops; +2× Number() casts (Decimal→Number alloc).
**Підхід до фіксу:** один `for (const x of array) { acc1 += ...; acc2 += ...; }` з `let acc1=0; let acc2=0;` перед циклом. Half CPU + half GC. Додати `take: N` у findMany (recalc endpoints без ArrayMaxSize; поріг = bulk-read upper bound service, ~1000). Не зливати reduce у DIFFERENT collections (lines vs parts).
**Реальний impact:** WO 50 рядків: 100 iter + 100 casts → 50+50. Edit-сеанс 10 mutations: -500 iter + -500 allocs.
**Де шукати ще:** helper `recalc*`/`recompute*`/`applyTotals*`/`refreshAggregates*` — WO, invoices, SD, PO, supplier-returns, estimates. Моделі з aggregate-парами (totalLabor+totalActualLabor, totalAmount+totalVat, totalDiscount+totalNet) — recalc майже завжди twin-scan. Checkpoint при додаванні нового aggregate field.

---

### 2026-06-17 — Sequential post-token `wo + org + uoms` lookup у public share-endpoint — `findFirst(token) → findFirst(org)` `→ findMany(uoms)` ланцюг 3 RTT, merge tail-pair у Promise.all

**Сигнал:** public share-token endpoint (estimate-share, invoice-public, document-view) має 3-step ланцюг: (1) `findFirst({where: {shareToken}})` → `wo`, (2) `findFirst({where: {id: wo.orgId}})` → `org`, (3) `findMany({where: {id: {in: uomIds}}})` → `uoms`. Перші 2 sequential (org.id=wo.orgId), але 2+3 паралельні (обидва залежать ТІЛЬКИ від wo). 3 RTT де можна 2. Sibling-drift: findByShareToken ↔ getEstimateData.
**Grep:** `findFirst\([^)]+shareToken[\s\S]{0,1500}await this\.prisma\.organisation\.findFirst[\s\S]{0,500}await this\.prisma\.\w+\.findMany\(`. Перевіряти export-endpoint-и (PDF/XLSX/DOCX) що викликають shared data-builder.
**Причина виникнення:** послідовно бо "спочатку 404-guard, потім все інше". Після if-throw подальші lookups незалежні — не очевидно при copy-paste.
**Підхід до фіксу:** виlift `const uomIds = wo.X.map(c => c.fkId).filter(...)` ПЕРЕД; `const [org, uoms] = await Promise.all([findFirst(org), uomIds.length ? findMany(uoms) : Promise.resolve([] as ...)])`. Map-fill loop ПІСЛЯ. НЕ зливати з token-lookup (pre-guard).
**Реальний impact:** TTFB ~15ms → ~10ms (33%). × 3 export-формати. Cold cache (share-window TTL короткий).
**Де шукати ще:** public read через share-token/public-id — findByShareToken, getEstimateData, invoice-public.findByToken, document-view.getByPublicId, pricing-list-share. Парний паттерн: коли один оптимізовано, sibling майже завжди лишається sequential. Перевіряти КОЖНУ пару `findBy*Token + getExport*`/`+ buildPublicDto*`.

---

### 2026-06-16 — Settings/config read-endpoint без Redis cache при high-mount-frequency UI-патерні — sibling settings.X методи мають cache, новий тонкий getter (work-hours/feature-flags/quick-config) НЕ має

**Сигнал:** `getWorkHours`/`getFeatureFlags`/`getQuickConfig` повертає тонке value-object з findFirst на settings/config. Викликається з useEffect `[]` у вкладці (Calendar/Dashboard/PriceListPicker) → DB hit на КОЖЕН mount. Sibling-методи (`getOrganisationSettings`, `getBranchSettings`) уже мають Redis cache 300s з invalidation, але новий тонкий getter — naked ("він же тонкий, навіщо cache?").
**Grep:** `async get\w+\(orgId.*\): Promise<\{[^}]*Hour\|Days\|Mode\|Enabled` БЕЗ `redis\.get` поряд + `private readonly redis` у constructor. Підтверджуючий: у `updateBranchSettings`/`updateOrganisationSettings` є `invalidate*Cache()`, але нових не додавалось.
**Причина виникнення:** copy findFirst з sibling, але `try { redis.get } catch {}` обгортка виглядає як boilerplate, пропущена. Endpoint "дешевий" — але тригериться 5-20 раз/сесію (tab toggle, modal re-open, nav back/forward).
**Підхід до фіксу:** (1) cacheKey + TTL (`WORK_HOURS_TTL = 60`, коротший бо quick-change); (2) `try { cached = redis.get(key); if (cached) return JSON.parse } catch {}` → query → `try { redis.set(key, ..., 'EX', TTL) } catch {}`; (3) `invalidateXCache(orgId)`; (4) у update-методі — conditional invalidation ТІЛЬКИ коли relevant fields (workStartTime/End) змінились у dto; (5) cache scope (orgId vs orgId+branchId) = actual scope.
**Реальний impact:** Calendar mount: findFirst з nested orderBy → Redis GET. Per 60s: 1 DB hit замість 5-20.
**Де шукати ще:** settings/config service (settings.service, app-config.service, infrastructure.service) з тонкими getter-ами — UI-features, dashboard-config, quick-stats, notification-defaults, theme-config, default-warehouse. Checkpoint: нова UI-вкладка що читає `GET /settings/X` → додати інвалідацію поряд з кешем у той самий commit.

---

### 2026-06-16 — Nested loop `outerList.find(o => innerList.some(i => i.fkField === o.id && intervalOverlap(i, slot)))` у hot-path availability/conflict-detection — bucket inner list by FK у Map<fkValue, []> один раз + pre-parse Date→Ms у числа

**Сигнал:** service-метод (booking.getAvailability, calendar conflict-check, scheduling) генерує candidate windows і для КОЖНОГО викликає `outerArr.find(outer => !innerArr.some(inner => inner.fk === outer.id && new Date(inner.startAt) < window.end && new Date(inner.endAt) > window.start))`. Frontend: `bookings.map(b => lifts.find(lift => !calSlots.some(s => s.liftId === lift.id && ...)))`. Outer T=20-50 × inner N=5-50 × M=100-500 = T×N×M + `new Date()` alloc-heavy hot path.
**Grep:** `\.find\([^)]+=>\s*!\w+\.some\(` АБО `\.find\([^)]+=>\s*\w+\.some\([^)]+\w+Id === \w+\.id[\s\S]{0,200}new Date\(`
**Причина виникнення:** декларативно ("find lift where no slot overlaps"). Колекції малі у dev (5 lifts, 10 slots); production 50 lifts × 500 slots × 20 timeslots = 500_000 ops + 10_000 Date allocs.
**Підхід до фіксу:** (1) bucket inner array by FK у `Map<fkValue, []>` перед outer циклом (O(M) setup, `if (!i.fk) continue; get/push else set`); (2) pre-parse Date→Ms під час bucket (`startMs: new Date(i.startAt).getTime()`) — один parse per inner замість T×N×; (3) у predicate замість `.some()` — explicit for-loop з числовим порівнянням (`busy = bucketByFk.get(outer.id); for (const p of busy) if (p.startMs < windowEndMs && p.endMs > windowStartMs) return false`). O(T×N×avg(M/N)) + 0 Date allocs.
**Реальний impact:** 50 lifts × 500 slots × 20 timeslots: ~500_000 ops + ~10_000 allocs → ~10_000 ops + ~1000 (50× CPU, 10× GC). Frontend: ріжемо blocking time у main thread.
**Де шукати ще:** scheduling/availability/conflict — calendar slot conflicts, booking free-resource, inventory FIFO/LIFO з overlapping reservations, settlements period overlap, pricing overlapping ranges. Frontend: useMemo filtered subset де outer.map → inner.find/.some з FK. Перевіряти string→Date inside hot loop.

---

### 2026-06-16 — `useMemo<T[]>(() => [], [])` всередині компонента для stable-empty-array placeholder — module-level const замінює без зміни семантики

**Сигнал:** `const EMPTY_X = useMemo<X[]>(() => [], [])` (або `useMemo(() => new Map(), [])`) — empty-collection placeholder (`slotsByLift.get(id) ?? EMPTY_X`). useMemo `[]` стабільний між render-ами mount, але alloc новий `[]` на КОЖНОМУ mount без потреби.
**Grep:** `useMemo<\w+\[\]>\(\(\) => \[\], \[\]\)` АБО `useMemo\(\(\) => new (Map|Set)\(\), \[\]\)`
**Причина виникнення:** пам'ятають "literal `[]` у JSX → нова ref → memo скидається", тягнуть useMemo. Empty collection — стале значення; достатньо module-level const.
**Підхід до фіксу:** перенести `const EMPTY_BOOKINGS: BookingSlot[] = [];` на module-level, видалити useMemo. Identity стабільна на всі mounts. Не чіпати якщо нова empty-collection при умовах (dynamic-import/feature-flag).
**Реальний impact:** -1 alloc + -1 hook slot на mount. Корисно у grids що часто re-mount (calendar toggle, modal).
**Де шукати ще:** `EMPTY_*`/`DEFAULT_*` через useMemo `[]` — calendar widgets, DetailPanel, EntityPickerField fallback, useReducer initial empties.

---

### 2026-06-15 — Collapsible-header `chips` массив у form-modal: inline IIFE `headerCollapsed ? [supplierDisplay, refList.find(...).name, contractNumber].filter(Boolean) : []` всередині render — recompute на КОЖЕН typing keystroke у inner Input

**Сигнал:** form-modal (PO/SD/WO Create) має collapsible header з `headerChips` inline перед return: `const headerChips = headerCollapsed ? [supplierDisplay, form.warehouseId ? warehouses.find(w => w.id === ...)?.name : null, contractNumber ? ...].filter(Boolean) : [];`. На КОЖЕН render (typing у "Примітки" → setForm) масив пересоздається, `warehouses.find()` O(N), `.filter()` alloc.
**Grep:** `const \w+Chips = \w+Collapsed \?[\s\S]{0,400}\.find\([\s\S]{0,200}\.filter\(Boolean\)`
**Причина виникнення:** "chips — похідне від collapsed" виглядає як inline. Не помічають що Inputs фірять setForm на keystroke → chips recompute → JSX-children identity-thrash.
**Підхід до фіксу:** (1) reference-Map `warehouseById = useMemo(() => new Map(warehouses.map(w => [w.id, w])), [warehouses])` (O(1)); (2) `useMemo` навколо headerChips з deps `[headerCollapsed, supplierDisplay, form.warehouseId, warehouseById, contractNumber]`.
**Реальний impact:** typing у "Примітки" 20-50 keystrokes × 3 find + allocs → 250-300 wasted ops/сесію.
**Де шукати ще:** form-modal з collapsible header (WO, Invoice, Estimate, PO, SD, SR, BookingRequest); breadcrumb-strips, tag-displays, "Recent items" — inline array-builders з ref-data lookups.

---

### 2026-06-15 — Form/modal totals `reduce(...)` поза useMemo — викликається на КОЖЕН render навіть коли lines не змінились (typing у unrelated Input)

**Сигнал:** form-modal з табличкою рядків має `const total = totalFromLines(lines);` АБО inline `lines.reduce(...)` без useMemo. Поряд controlled Inputs (notes/date) → setState на typing → total recompute O(N) навіть коли lines незмінні. PO CreateModal мав memo, SupplierReturn — НІ (copy-paste-evolve розрив). Регресія консистенції.
**Grep:** `const total = \w+\(\w+\);$` АБО `const total = \w+\.reduce\([\s\S]{0,300}\);[\s\S]{0,100}return \(` (без useMemo між decl і use).
**Причина виникнення:** copy-paste; один отримав useMemo у циклі, інший лишився inline. `const total = ...` приймається як cheap.
**Підхід до фіксу:** `const total = useMemo(() => totalFromLines(lines), [lines])`; якщо VAT/discount — single-pass `useMemo(() => { let total=0; let vat=0; for (const l of lines) {...}; return {total, vat}; }, [lines])` (2026-06-11 twin-scan).
**Реальний impact:** typing 30 keystrokes × 10 lines = 300 wasted ops; 100+ позицій → 3000.
**Де шукати ще:** парні modal copy-pasted: PO CreateModal ↔ SupplierReturn, Estimate ↔ Invoice, SD Create ↔ Receive, WO Create ↔ Edit. Перевіряти memo-консистентність після рефакторингу одного з пари.

---

### 2026-06-15 — Row-handler async function inline `const X = async (item) => {...}` без useCallback у list-page → inline arrow `onClick={() => void markX(item)}` для КОЖНОГО з 20 рядків → нова arrow identity на render

**Сигнал:** list-page має 5-10 row-handlers (`handleTransition`, `markDeleted`, `loadDetail`) як `const X = async (po) => {...}` БЕЗ useCallback. У `.map(po => <button onClick={() => void markDeleted(po)}>)` — inline arrow × 20 rows × render. Гальмує майбутнє введення memo(TableRow).
**Grep:** `const handle\w+ = async \([^)]+\) => \{` без useCallback + `onClick=\{\(\) => void handle\w+\(\w+\)\}` у `.map()`.
**Причина виникнення:** великі файли (300-1500 LOC); `const = async` менше boilerplate. Усвідомлення пізно — коли треба memo(TableRow).
**Підхід до фіксу:** useCallback з мінімальними deps `useCallback(async (po) => {...}, [confirm, queryClient])`. Для handler→handler (openReceive→loadDetail) — порядок declaration (залежний перший). Якщо use `load` (recreated) — eslint-disable з коментарем (identity irrelevant для click-time closure). Стратегія: усі row-handlers одночасно, один pass на файл.
**Реальний impact:** stable onClick → майбутній memo(TableRow) без identity-thrash (20 re-renders → 0). Зараз ≈0мс, інвестиція.
**Де шукати ще:** усі list-page (catalog/inventory/WO/invoices/counterparties/employees). ВСІ async row-handlers — useCallback.

---

### 2026-06-15 — Branching ternary `cond ? findFirst(validate-by-id) : findFirst(auto-pick-by-criteria)` всередині Promise.all — single optional FK з двома різними query shapes у одному слоті

**Сигнал:** create-сервіс приймає optional FK (contractId) з двома гілками ПІСЛЯ Promise.all основних guards: (A) `if (dto.X) findFirst({where:exact-id})` (validate), (B) `else findFirst({where:criteria, orderBy})` (auto-pick primary). Sequential if/else додає 1 RTT.
**Grep:** `let \w+Id = dto\.\w+Id \?\? null;[\s\S]{0,500}if \(\w+Id\) \{[\s\S]{0,300}findFirst[\s\S]{0,300}\} else \{[\s\S]{0,300}findFirst[\s\S]{0,300}orderBy`
**Причина виникнення:** лінійне "дано→validate, ні→auto-pick". Обидві гілки мають синхронно-доступні предикати (dto+scalars), не залежать від supplier-guard.
**Підхід до фіксу:** (1) `const hasContractId = !!dto.X;` ДО Promise.all; (2) виlift тернарку у Promise.all `hasContractId ? findFirst(exact-id) : findFirst(criteria, orderBy)`; (3) post: `if (hasContractId && !contract) throw NotFound; const contractId = hasContractId ? (contract as {id:string}).id : (contract?.id ?? null)`.
**Реальний impact:** PO create() 3 RTT → 2 RTT (33%), з contractId чи без.
**Де шукати ще:** create()/addX() з optional FK + auto-pick fallback (primary contract, default warehouse/branch/currency, primary employee/bank-account). Розширення "Auto-pick optional FK ПІСЛЯ parallel guards" на обидві гілки у тому слоті.

---

### 2026-06-15 — Sequential `findFirst (tenant guard) → create + update` пара у $transaction де create і update пишуть у РІЗНІ таблиці але читають той самий entity.id зі scope — settlements/payments/balance-update триплет

**Сигнал:** сервіс (settlements.createTransaction, balance-mutate): `const account = await db.X.findFirst({tenant guard}); if (!account) throw; await db.Y.create({settlementAccountId: account.id}); await db.X.update({where:{id: account.id}, data:{balance:{increment: delta}}})`. Sequential create (event-log) + update (aggregate balance) — обидва читають лише `account.id`, РІЗНІ таблиці. Writes resolve concurrently на pinned tx connection.
**Grep:** `await \w+\.\w+\.findFirst[\s\S]{0,200}await \w+\.\w+\.create\([\s\S]{0,400}await \w+\.\w+\.update\(`
**Причина виникнення:** event-log паттерн "спочатку подія, потім баланс". Порядок не має значення (increment атомарний у $tx).
**Підхід до фіксу:** (1) sync pre-compute (`balanceDelta` по type-enum) ДО $transaction (fail-fast); (2) findFirst sequential, потім `await Promise.all([X.create(...), X.update(...)])`; (3) `select: {id: true}`.
**Реальний impact:** settlement.createTransaction на WO COMPLETED/invoice PAID/payment.create. 100 WO/day × ~4 → 400 RTT saved/day.
**Де шукати ще:** append-only event-log + aggregate-mutate: payment.create + invoice.balanceDue.decrement, stock-movement.create + stock-item.quantity.increment, audit-event.create + entity.update. ОБЕРЕЖНО коли create+update у ту саму таблицю (race) — завжди РІЗНІ таблиці.

---

### 2026-06-15 — Chunked bulk-update loop `for (const u of chunk) await tx.X.update(...)` у $transaction де input plan МОЖЕ мати duplicate PK — Promise.all + Map-dedup last-wins

**Сигнал:** bulk-pricing/import (applyRule, applyPricing з PO/xlsx) будує `plan: {goodId, ...}[]` по lines/rows, потім `for (i += CHUNK) { $transaction(tx => for (const u of chunk) await tx.X.update({where: {id: u.goodId}})) }`. Disjoint PK → кандидат на Promise.all. АЛЕ: коли plan з джерела де ОДИН товар з'являється кілька разів (PO кілька ліній того ж goodId; xlsx multi-SKU→той самий good) — sequential loop мав last-write-wins; Promise.all на duplicate PK = race-condition.
**Grep:** `for \(const \w+ of chunk\) \{[\s\S]{0,200}await tx\.\w+\.(update|updateMany)`
**Причина виникнення:** chunked bulk pattern; sequential "по одному" безпечно. Розробник не задумувався чи входи унікальні (plan з rows/lines).
**Підхід до фіксу:** аналіз джерела plan ДО Promise.all: (1) unique PK (findMany.map, IDs з Set) → просто Promise.all; (2) МОЖЕ мати duplicate PK → `const deduped = Array.from(new Map(plan.map(u => [u.pkField, u])).values())` ДО Promise.all (Map last-wins). priceHistory.createMany теж пише унікальні рядки (позитивний side-effect).
**Реальний impact:** chunk=100 × 10 → 1000 sequential await → 10 batches Promise.all. Prisma serializes SQL, але JS-event-loop overhead помітний на 1000+ goods.
**Де шукати ще:** chunked update loop у $transaction: pricing rules, list import, bulk discount, mass status change, cleanup workers. Увага коли plan з parent.lines (дублі) vs findMany (PK-unique).

---

### 2026-06-15 — Inventory-mutation helper + parent-line metadata update — sequential await пара у per-line $transaction loop де writes ідуть у РІЗНІ таблиці (cross-table side-effect helper vs scalar column update)

**Сигнал:** service applies effect документу (PO receive, SD CONFIRMED, WO complete): `$transaction(tx => for (const line of doc.lines) { await inventory.createMovement(...); await tx.purchaseOrderLine.update({unitOfMeasureId, receivedQty: {increment}}) })`. createMovement пише у StockMovement/StockBatch/StockItem (`orgId+goodId+warehouseId`), parentLine.update у PurchaseOrderLine (`id+orgId`) — НЕ перетинаються. Sequential × N ліній. TRANSFER має 2 createMovement (writeoff→receipt, disjoint keys).
**Grep:** `for \(const \w+ of \w+\.lines\) \{[\s\S]{0,500}await this\.inventory\.createMovement[\s\S]{0,300}await tx\.\w+Line\.update`
**Причина виникнення:** helper "важкий" → sequential; parentLine.update "продовження". Реально writes у різні composite keys, concurrent без deadlock.
**Підхід до фіксу:** `await Promise.all([inventory.createMovement(...), tx.parentLine.update(...)])`. Conditional UoM: `lineUnitId ? tx.parentLine.update(...) : Promise.resolve()`. TRANSFER: writeoff+receipt+UoM у Promise.all. Loop-carried (receivedAmount +=, results.push) post-await.
**Реальний impact:** PO receive() 10 lines: 20 RTT → 10 (50%). SD CONFIRMED 5 lines: 10→5. TRANSFER: 15→5.
**Де шукати ще:** service що applies side-effects на inventory/settlements/queue: invoice payment apply (line-update + payment-create), credit note refund, WO complete (createMovement + part.update), PO receive (+settlement.createTransaction), credit-charge reversal.

---

### 2026-06-15 — N-FK guards у update() з conditional шляхами (if dto.X) — третій FK validation з cross-dependency на dto.supplierId/effective entity

**Сигнал:** update() приймає DTO з кількома optional FK (`dto.supplierId`, `dto.warehouseId`, `dto.contractId`). Три послідовних `if (dto.X) { const X = await findFirst({...}); if (!X) throw }`. Останній FK може мати cross-dependency `effectiveSupplierId = dto.supplierId ?? po.supplierId` — але це scalar lookup, НЕ блокування на результат попереднього findFirst.
**Grep:** `update\(orgId.*dto.*\)[\s\S]{0,200}if \(dto\.\w+Id\) \{[\s\S]{0,300}findFirst[\s\S]{0,300}if \(dto\.\w+Id\) \{[\s\S]{0,300}findFirst`
**Причина виникнення:** "захищаємо кожен FK окремо". Cross-dependency `effectiveSupplierId` маскує що contract validation читає лише `dto.supplierId ?? po.supplierId` (скаляр у scope).
**Підхід до фіксу:** `effectiveXxxId = dto.xxxId ?? po.xxxId` синхронно ДО Promise.all. У Promise.all три тернарки `dto.X ? findFirst({...}) : Promise.resolve(null)`. ПІСЛЯ — guard `if (dto.X && !result) throw NotFound`.
**Реальний impact:** update() supplier+warehouse+contract у одному PATCH: 3 RTT → 1 (67%).
**Де шукати ще:** update()/patch() з optional FK + cross-dependent third lookup — invoice.update (counterpartyId+warehouseId+priceListId), workOrder.update (vehicleId+counterpartyId+contractId+liftId), stockDocument.update.

---

### 2026-06-14 — Detail-panel/Drawer/Modal будівник через IIFE `(() => { const build = ...; return <Panel tabs={selectedItem ? build(selectedItem) : undefined} /> })()` у тілі parent list-page — tabs object identity рекреюється на КОЖЕН render

**Сигнал:** list-page має secondary panel з tabs масивом у JSX-тілі через IIFE `(() => { const buildX = item => [...]; return <Panel tabs={selectedItem ? buildX(selectedItem) : undefined} configFields={schemaToConfigFields(...)} /> })()`. tabs+configFields пересоздаються на КОЖЕН render навіть коли selectedItem не мінявся. Якщо panel.useEffect deps містять onClose/tabs identity → re-fires → addEventListener/removeEventListener + Input focus скидається.
**Grep:** `\{\(\(\) =>` у JSX-тілі >300 LoC компонентів поряд з `<DetailPanel|<Modal|<Drawer|<SlidePanel`.
**Причина виникнення:** inline закриття дає доступ до state без props drilling. IIFE "нічого не коштує", але tabs.content має controlled `<Input onChange={inline arrow}>` → каскад re-render до Modal/keydown effects.
**Підхід до фіксу:** (1) memo-компонент `XDetailPanel` на module-level з explicit props (selectedItem, editingX, onCloseX, onSaveX, panelConfig); (2) всередині `const tabs = useMemo(() => {...}, [selectedItem, editingX, ...])`, configFields теж useMemo; (3) parent handlers через useCallback. panelConfig type — `ReturnType<typeof useDetailPanelConfig>`.
**Реальний impact:** typing у parent debounce → tabs identity stable → Input focus не зривається. Subjective UX > мс.
**Де шукати ще:** list-page з DetailPanel/Drawer/Modal inline (counterparties, WO, invoices, PO, SD — "edit field у panel"). Ризиковано з debounce-search у parent.

---

### 2026-06-14 — Новий list/report endpoint з date sort без covering index — `findMany({orderBy: createdAt, take})` сканує таблицю seqscan коли existing index не покриває WHERE pattern

**Сигнал:** новий endpoint робить `findMany({where: {orgId, [optionalCol1], [createdAt range]}, orderBy: {createdAt}, take: N})` на append-only таблицю (StockMovement, AuditLog, Notification, BatchConsumption). Existing index `(orgId, warehouseId, createdAt)`, але новий WHERE more permissive (warehouseId optional). Postgres вимагає leading-cols match — warehouseId IS NULL → index не вибирається → seqscan + external sort.
**Grep:** `findMany.*orderBy.*createdAt` + `take: \d{3,}` + `grep "@@index" packages/database/prisma/schema.prisma`. Якщо найкращий index має >1 col перед `createdAt` що query не фільтрує — гап.
**Причина виникнення:** старі індекси під старі endpoint-и; новий звітний має ширшу area (all-warehouses, by-date).
**Підхід до фіксу:** covering `@@index([orgId, sortKey])` для unfiltered + `@@index([orgId, optionalCol, sortKey])` для типового фільтру. Не плодити надлишкові (Postgres бере prefix). Commit-message з explain trace.
**Реальний impact:** take:3000 на 100k-500k рядків: seqscan ~150-300мс → index scan ~5-15мс.
**Де шукати ще:** після нового report/list endpoint на append-only models (StockMovement, AuditLog, BatchConsumption, Notification, WorkOrderStatusLog) — compare `@@index` з actual WHERE.

---

### 2026-06-14 — Sequential `await tx.X.update(...); await tx.Y.create(...)` у loop-карриджних батч-операціях — Promise.all всередині ітерації без злому loop-carried стану

**Сигнал:** `for (const x of batches) { await db.X.update(...); await db.Y.create(...); remaining -= take; }` — два writes на ітерацію не залежать (update на batchId, create batchConsumption), але loop-carried state (`remaining`) сериальний. Sequential await всередині ітерації × N-iter.
**Grep:** `for \(const .* of .*\)\s*\{[\s\S]{0,300}await .*\.\w+\.update[\s\S]{0,200}await .*\.\w+\.create`
**Причина виникнення:** "update partition, потім create record"; update void, create бере partition.id зі scope. Результат update нікуди не йде.
**Підхід до фіксу:** `await Promise.all([db.X.update({...}), db.Y.create({...})])` (race-safe, різні таблиці). Loop-carried (`remaining -= take`, `results.push`) post-await. Той самий для `findFirst → update + create` де update+create залежать лише від `.id`.
**Реальний impact:** consumeBatch 5 partitions: 10 RTT → 5 (50%). returnToBatch 10 parts → 10 RTT.
**Де шукати ще:** batch-consume/release/return у inventory/batch/work-orders.service; settlement reconciliation, invoice payment apply.

---

### 2026-06-12 — Disjoint-set `tx.X.updateMany()` pairs всередині `$transaction` callback — Promise.all замість sequential await

**Сигнал:** sync/refresh/cascade-update у `$transaction` робить 2+ послідовні `await tx.X.updateMany({where:A})` потім `await tx.X.updateMany({where:B})` де A і B DISJOINT (напр. children `parentSlotId: {not: null}` vs parent `parentSlotId: null`). Sequential = 2 RTT.
**Grep:** `await tx\.\w+\.updateMany[\s\S]{0,300}await tx\.\w+\.updateMany`
**Причина виникнення:** "soft-delete A, потім update B"; updateMany виглядає "небезпечніше" за розноску у Promise.all.
**Підхід до фіксу:** `const [, r2] = await Promise.all([tx.X.updateMany({where:A}), tx.X.updateMany({where:B})])`. Prisma parallel queries у interactive tx на одну connection. Race-safe (WHERE disjoint). Той самий для tenant-guard + parentSlot lookup у tx (404 throw скасовує tx без mutation cost).
**Реальний impact:** sync ~30% швидші (2 RTT → 1). 100-RPS: ~50ms savings.
**Де шукати ще:** cascade-update/sync/refresh/propagate/`markAsX`; bulk soft-delete після transition; refresh-totals helpers.

---

### 2026-06-12 — `kyivToday()`/date helper всередині render `.map()` callback — lift у useMemo на рівень компонента

**Сигнал:** `array.map(item => { const todayKyiv = kyivToday(); const isOverdue = item.date < todayKyiv; ... })` — `kyivToday()` (`new Date() + Intl.format()`) у тілі `.map()`. 8-row → 8× per render.
**Grep:** `\.map\([^)]*=>\s*\{[^}]*kyivToday\(\)|\.map\([^)]*=>\s*\{[^}]*Date\.now\(\)`
**Причина виникнення:** kyivToday() виглядає як константа; ставлять у map-body де порівняння.
**Підхід до фіксу:** `const todayKyiv = useMemo(() => kyivToday(), [])` над JSX (deps `[]` + eslint-disable з коментарем mount-stable). Auto-refresh → useState + useEffect interval. Також fix pure-render (race з timer).
**Реальний impact:** 8-row dashboard: 8× → 1×. Чистота для high-render-frequency (15s polling, table cells).
**Де шукати ще:** date-helper з `new Date()` — kyivNow, kyivToday, isoToday, todayMs; `Date.now()`, `new Date()` direct; reports/audit lists з `item.date < today`. Той самий для `formatXyz` з Intl singleton.

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
