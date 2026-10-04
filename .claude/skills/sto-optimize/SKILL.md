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

**Все виконується без питань.** Не питай дозволу між кроками; фіксуй одним реченням що робиш.

```
Крок 0 — контекст (git diff + MemoryManual)
Крок 1 — backend аудит   Крок 2 — frontend аудит   Крок 3 — DB (індекси)
Крок 4 — виправити все    Крок 5 — tsc 0 + commit   Крок 6 — MemoryManual.md
Крок 7 — самовдосконалення: нові підходи у "Накопичені підходи"
```

---

## Крок 0 — Контекст

```bash
git diff HEAD --name-only | head -30   # scope
cat MemoryManual.md | head -50          # стан проєкту
```

Визнач агрегати зі scope → читай дос'є (`docs/objects/<entity>.md`): існуючі індекси, відомі N+1 та кеш-патерни.

**Lookup:** `WorkOrder→work-order.md` | `Invoice→invoice.md` | `PurchaseOrder→purchase-order.md` | `Good→good.md` | `Counterparty→counterparty.md` | `CalendarSlot→calendar.md` | `StockItem→inventory.md`

**Аргумент** (`/sto-optimize backend|frontend|db`) → тільки відповідний крок. Без аргументу → всі.

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
# Redundant full-scan: ≥2 приватні tree/graph-хелпери (getDepth/getSubtreeHeight/getDescendantIds/
# getAncestors) викликані ПІДРЯД у одному mutation — кожен робить власний findMany(усе піддерево)
grep -rn "await this\.get\(Depth\|SubtreeHeight\|DescendantIds\|Ancestors\|Descendants\|Children\)" \
  apps/api/src/modules/ --include="*.service.ts" | grep -v spec
# Cache-bypass N+1: cached findAll додає «свіже/поза кешем» derived-поле per-row через service-виклик,
# а той сам ≥2 запити (getBalance/getStock/getStatus). N+1 І обхід ref-кешу одночасно.
grep -rn "\.map(async" apps/api/src/modules/ --include="*.service.ts" -B4 | grep -iE "cache\.get|cache\.set|поза кеш|свіж|fresh|always" | grep -v spec
grep -rn "await this\.\w\+\.get\(Balance\|Stock\|Total\|Status\|Count\)" apps/api/src/modules/ --include="*.service.ts" | grep -v spec | grep -iE "\.map|for "
```

**Фікс:**

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

```typescript
// ❌ Sequential — кожен чекає попереднього
const cp = await prisma.counterparty.findFirst({ where: { id, orgId } });
if (dto.workOrderId) {
  const wo = await prisma.workOrder.findFirst({ where: { id: dto.workOrderId, orgId } });
}
// ✅ Parallel — обидва одночасно
const [cp, wo] = await Promise.all([
  prisma.counterparty.findFirst({ where: { id, orgId } }),
  dto.workOrderId ? prisma.workOrder.findFirst({ where: { id: dto.workOrderId, orgId } }) : null,
]);
```

### 1.3 findMany без take ліміту

```bash
grep -rn "findMany(" apps/api/src/modules/ --include="*.service.ts" | grep -v "take:" | grep -v spec | head -20
```

**Фікс:** `take: N` (reference: 100-500; list: 20-200; reports: 10000 max).

### 1.4 Відсутній Redis кеш для довідників

```bash
grep -rn "async findAll" apps/api/src/modules/ --include="*.service.ts" | grep -v spec | head -20
grep -rn "CacheService\|cache\.get\|cache\.set" apps/api/src/modules/ --include="*.service.ts" | head -20
```

**Кандидати (TTL 300s):** branches, warehouses, zones, lifts, work-categories, brands, units, payment-methods, currencies, bank-accounts, cash-registers — всі вже мають кеш.

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
grep -rn "findMany" apps/api/src/modules/ --include="*.service.ts" -A 10 | grep -E "lines:|parts:" | head -10
```

**Фікс:** lines/parts у list → `_count: { select: { lines: ... } }` + lazy-load при відкритті деталей.

### 1.6 JS агрегація замість SQL

```bash
grep -rn "take: 10000\|take: 5000\|take: 1000" apps/api/src/modules/ --include="*.service.ts" | grep -v spec
grep -rn "\.reduce\|\.forEach\|\.map" apps/api/src/modules/reports/ --include="*.service.ts" | head -10
```

**Фікс:** `findMany(take:10000) + JS reduce` → `$queryRaw GROUP BY` або `prisma.X.groupBy()`.

### 1.7 CORS preflight без maxAge

```bash
grep -rn "enableCors" apps/api/src/main.ts
```

**Фікс:** `maxAge: 86400` у `enableCors()`. Chrome кепить на 7200s, інші — до 24h. Перевірити `Authorization` у дозволених заголовках якщо `allowedHeaders` явно вказані. **Перевірка проблеми:** у HAR/Network — пара OPTIONS+GET на той самий endpoint при кожному mount → `maxAge` не налаштований.

### 1.8 Dashboard і SSE без кешу

```bash
grep -rn "getSummary\|dashboard" apps/api/src/modules/dashboard/ --include="*.service.ts" | head -10
```

**Фікс:** кеш 25s (SSE polling 30s → DB hit раз на interval).

### 1.9 Redundant return-refetch після tenant-scoped updateMany (guard-getX уже підтвердив ownership)

```bash
# mutation що після updateMany робить return this.getX/findX — потенційно зайвий 3-й запит
grep -rn "updateMany(" apps/api/src/modules/ --include="*.service.ts" -A8 | grep -B6 "return this\.get\|return this\.find" | grep -v spec | head -20
```

**Фікс:** якщо метод має guard-`getX`/`findFirst` НА ВХОДІ (404 + tenant) і `updateMany({where:{id,orgId,deletedAt:null}})` + фінальний `return this.getX(orgId,id)` → злити write+return у `return this.prisma.X.update({where:{id}, data})` (повертає рядок через `UPDATE...RETURNING`; guard уже підтвердив org-ownership). Guard-getX лишити. Zero-risk. НЕ застосовувати якщо `data` залежить від concurrent-стану (тоді updateMany+count-guard).

### 1.10 Повторна ДОРОГА обробка того самого завантаженого файлу у two-step wizard (OCR/парсинг двічі)

```bash
# Та сама дорога трансформація буфера у ДВОХ методах (preview vs apply/identify) одного флоу
grep -rn "parseGrid\|\.extract(buffer\|parse(buffer" apps/api/src/modules/ --include="*.service.ts" | grep -v spec | head -20
# OCR/растеризація/ML-гілка у трансформації (секунди, не мс) + наявний Redis CacheService
grep -rln "OCR\|tesseract\|rasterize\|\.recognize(" apps/api/src/modules/ --include="*.service.ts" | grep -v spec
```

**Фікс:** `parseCached(buffer, filename)` над Redis `CacheService`, ключ `sha256(buffer)` (+kind), TTL 300с — ЛИШЕ для дорогих каналів (gate по `detectKind`: pdf/image так, xlsx/csv — прямий розбір). Трансформація МУСИТЬ бути чистою функцією байтів (без orgId/БД усередині); tenant-логіку (мапінг/резолв) лишати ПІСЛЯ кешу. Offline-safe: CacheService деградує без Redis → поведінка = поточна. **НЕ** приймати результат з клієнта; **НЕ** конвеєризувати rasterize‖recognize замість кешу (кеш прибирає цілий 2-й прохід, конвеєр — лише ~10% одного). Деталі: «Накопичені підходи» 2026-10-02.

---

## Крок 2 — Frontend аудит

### 2.1 Пошук без debounce

```bash
grep -rn "onChange.*setSearch\|onChange.*setQ\b\|onChange.*setQuery" apps/web/src/app/ --include="*.tsx" | head -20
grep -rn "useDebounce\|debouncedSearch\|debouncedQ" apps/web/src/app/ --include="*.tsx" | head -20
```

**Фікс:** `const debouncedSearch = useDebounce(search, 300)` + замінити `search` → `debouncedSearch` у `useCallback` deps.

### 2.2 Послідовні useEffect при mount

```bash
grep -rn "useEffect.*\[id\]\|useEffect.*\[\]" apps/web/src/app/ --include="*.tsx" | head -20
```

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

**Фікс:** `garages.forEach(g => apiFetch(g.id))` → `Promise.all(garages.map(g => apiFetch(g.id)))`.

### 2.4 Відсутній sessionStorage кеш для reference data

```bash
grep -rn "apiFetch.*branches\|apiFetch.*warehouses\|apiFetch.*zones\|apiFetch.*lifts\|apiFetch.*work-categories" apps/web/src/app/ --include="*.tsx" | grep -v "getCached\|setCache" | head -20
```

**Фікс:** `getCached` / `setCache` з `@/lib/ref-cache`.

**Source/management сторінки довідників** (читають І редагують список):

```bash
grep -rln "apiFetch.*/branches\|apiFetch.*/zones\|apiFetch.*/lifts\|apiFetch.*/warehouses" apps/web/src/app/ --include="*.tsx" | xargs grep -L "setCache"
```

Якщо `loadAll()` викликається і на mount, і після КОЖНОЇ мутації → безпечно `getCached` (first-paint) + `setCache` (warm cache + пропагація правок). Якщо ні — НЕ кешувати (ризик stale).

### 2.5 Важкі бандли без lazy loading

```bash
pnpm --filter @sto/web build 2>&1 | grep -E "Route.*kB|First Load" | sort -t'k' -k1 -rn | head -15
```

**Кандидати для `next/dynamic`:** recharts, heavy chart libs, map components. Поріг: > 200kB First Load JS.

```typescript
const HeavyChart = dynamic(() => import('./HeavyChart'), {
  ssr: false,
  loading: () => <div className="h-64 bg-surface-hover animate-pulse rounded-xl" />,
});
```

### 2.6 React.memo на list items

```bash
grep -rn "\.map.*<[A-Z]\|return.*map.*(" apps/web/src/app/ --include="*.tsx" | grep -v "memo\|spec\|import" | head -20
grep -rn "function.*Row\|function.*Card\|function.*Cell\|function.*Item" apps/web/src/app/ --include="*.tsx" | grep -v "memo\|spec" | head -15
```

**Фікс:** `const MyRow = memo(function MyRow({ ... }) { ... })` — тільки якщо props примітивні/стабільні refs. **Увага:** memo марний якщо передають `array.filter()` inline → useMemo Map для груп.

### 2.7 Стейт замість useMemo/константи

```bash
grep -rn "useState.*new Date\|useState.*Date\.now\|setToday\|setNow\b" apps/web/src/app/ --include="*.tsx" | head -10
grep -rn "output.*export" apps/web/next.config.ts
```

**CRITICAL для static export:** `new Date()` у `useMemo` запікає build-time дату → hydration mismatch. **Правильно:** `useState<Date|null>(null)` + `useEffect(() => setToday(new Date()), [])`.

### 2.8 Intl.*Format у hot-path хелперах + годинник у render

```bash
grep -rn "new Intl\.\(DateTimeFormat\|NumberFormat\)\|\.toLocale\(Time\|Date\)String(" apps/web/src/ --include="*.tsx" | head -20
grep -rn "new Date()\|Date\.now()\|\.getMinutes()\|\.getHours()" apps/web/src/app/ --include="*.tsx" | grep -v "useEffect\|useCallback\|=>" | head -20
```

**Фікс Intl:** форматер у module-level `const` (опції константні), у хелпері лише `.format()`. **Фікс годинника:** `nowMs` у стейті + interval; похідні через `useMemo([nowMs])`; передавати як props (чисті/memo-friendly).

### 2.9 Навігаційний prefetch — відсутній/неповний PREFETCH_MAP

```bash
grep -n "'/[a-z]" apps/web/src/components/TopShell.tsx | grep "PREFETCH_MAP\|prefetchQuery" | wc -l
grep -n "href:.*'/[a-z]" apps/web/src/components/TopShell.tsx | grep -v "PREFETCH_MAP"
grep -rln "useEffect.*\[\]" apps/web/src/app/ --include="*.tsx" | xargs grep -l "apiFetch" | grep -v "spec\|test"
```

**Мета:** 17/17 NAV items у PREFETCH_MAP. Hover (~200мс) → API запит виконується → кліку дані в кеші.

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
  '/calendar': qc => {                       // date-залежні дані
    const today = KYIV_DATE_FMT.format(new Date());
    void qc.prefetchQuery({ queryKey: infraKeys.lifts, ... });
    void qc.prefetchQuery({ queryKey: ['calendar', 'slots', today], ... });
  },
};
onMouseEnter={() => employee && PREFETCH_MAP[item.href]?.(queryClient)}   // guard на employee
```

**Правила:** `prefetchQuery` no-op якщо fresh (безпечно); `employee` guard обов'язковий (без нього 401→tryRefresh→зайвий RTT); module-level Intl singleton для date-ключів; 4+ ресурси — паралельно в одному `PrefetchFn`.

### 2.10 Сторінки на useEffect+apiFetch — відсутній TanStack Query кеш

```bash
grep -rn "useState.*\[\]\|setLoading.*true\|const load = " apps/web/src/app/ --include="*.tsx" \
  | grep -v "spec\|hooks/api\|node_modules" | grep "setLoading\|const load" | head -20
ls apps/web/src/hooks/api/
```

**Проблема:** `useEffect → apiFetch → setState` перезавантажує з нуля щоразу. З `useQuery(gcTime: 5m)` — повторний візит <5хв = 0 запитів.

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

**Зразок hooks:** `apps/web/src/hooks/api/`.
**Вже мігровано (не переписувати):** useWorkOrders, useCounterparties, useInvoices, useInventory, usePurchaseOrders, useEmployees, useBookingRequests, usePricingRules, useStockDocuments, useInfrastructure, useReports, useSyncStatus, useDashboardData, useWorks.
**Немігроване:** `calendar/page.tsx` (1460 рядків + dnd-kit — відкладено).

### 2.11 View-mode shared-state — fetch не guard-ed по active view

```bash
grep -rln "setCalView\|setViewMode\|setMode\|setActiveTab\|setTab" apps/web/src/app/ --include="*.tsx" | xargs grep -l "useEffect"
# у кандидатах: useEffect що load-ить без deps на view (напр. [date] без calView)
```

**Проблема:** один `date`/`id`/`filters` шариться між day/month/stats. Effect з deps `[date]` без `calView` стріляє і коли користувач у stats/month. Wasted RTT.

```typescript
// ❌ стріляє у всіх видах
useEffect(() => {
  load();
}, [load]);
// ✅ тільки у активному; при поверненні до виду — оновить
useEffect(() => {
  if (calView === 'day') load();
}, [load, calView]);
```

### 2.12 EMPTY__/DEFAULT__ константа всередині компонента

```bash
grep -rn "^  const [A-Z][A-Z_]\+\s*[:=]" apps/web/src/app/ --include="*.tsx" | grep -v "//\|^[^:]*:\s*$" | head -10
```

**Фікс:** підняти на module-level (з типом якщо з того ж файлу). Не плутати з `useMemo`-залежними.

### 2.13 Inline React component всередині parent body

```bash
grep -rn "^\s\+const [A-Z]\w\+ = (\|^\s\+function [A-Z]\w\+(" apps/web/src/components/ --include="*.tsx" | grep -v "memo\|spec\|^$" | head -20
```

**Фікс:** якщо виклик через `<Name/>` JSX — або (А) `renderName(...)` + `{renderName(...)}` (closure збережений, без component-type змін); (Б) module-level + memo + props drilling. **Симптом:** DevTools profiler показує unmount+mount замість update коли setState батька fire-иться.

### 2.14 Context Provider value object без useMemo

```bash
grep -rn "Context\.Provider value={{" apps/web/src/ --include="*.tsx" | head -20
grep -rn "Context\.Provider value={value}" apps/web/src/ --include="*.tsx" | head -10
```

**Фікс:** `const value = useMemo(() => ({ ...поля }), [...reactive deps...])`. callback-и у value — useCallback-стабільні. **Альтернатива** — context splitting (state / actions).

### 2.15 Multiple mount-only useEffect з `[]` deps у одному компоненті

```bash
grep -rln "useEffect.*\[\]" apps/web/src/ --include="*.tsx" | xargs -I {} sh -c 'count=$(grep -c "useEffect.*\[\]" {}); [ $count -ge 3 ] && echo "$count {}"' | sort -rn | head -10
```

**Фікс:** об'єднати якщо: (1) deps усіх `[]`; (2) тіла незалежні (один не пише `localStorage.X` що інший читає); (3) cleanup об'єднувані у один return. Виняток — концептуально окремий ефект з нетривіальним cleanup.

### 2.16 Modal onClose без useCallback у parent — keydown/overflow listener thrashing

```bash
grep -rn "onClose:.*=>\|onClose={() => {\|onClose={\\s*saving" apps/web/src/components/ui/ --include="*.tsx" | head -20
# ГОЛОВНЕ: баг живе у CONSUMER-і Modal (app/ + components/ поза ui/):
#   (а) inline arrow: onClose={() => ...}  (б) plain-const handler (const closeX = () => ...; onClose={closeX})
grep -rn "onClose={() =>\|onClose={close\|onClose={handleClose" apps/web/src/app/ apps/web/src/components/ --include="*.tsx" | grep -v "components/ui/" | head -20
# Для кандидата: чи модалка містить input/textarea що typing на КОЖЕН символ (setState у onChange) → thrashing.
```

**Фікс:** у parent обгорнути у `const handleClose = useCallback(() => {...}, [deps])` (для `() => setX(null)` deps порожні). Без цього Modal.useEffect `[open, handleKey]` re-fires на КОЖЕН render батька → addEventListener/removeEventListener + body.style.overflow re-write. Помітно у модалках з typing-inputs.

**Пріоритет-фільтр (не фіксувати marginal):** лише `DatePickerInput`/date-picker (кліки) → амплітуда низька. Фіксувати ЛИШЕ модалки з `<Input>`/`<textarea>` що typing на КОЖЕН символ. 73 inline-onClose по app/ — більшість confirm/view-only без typing; цілитись у typing-форми. SHARED панелі (reused N×, напр. ProviderRegistryPanel) — пріоритет: один фікс покриває всі точки.

### 2.17 Стабільно-пропний дочірній без React.memo під частим parent-render — reconcile дарма (chart під SSE-tick / суб-форма під keystroke)

```bash
# (а) Lazy-chart під SSE/polling parent — recharts full-reconcile на кожен live-tick
grep -rn "dynamic(() => import" apps/web/src/app/ --include="*.tsx" | grep -iE "Chart|Graph|Plot"
grep -rn "export default function\|export default memo" apps/web/src/app/ --include="*.tsx" | grep -iE "Chart|Graph"
grep -rln "useDashboardStream\|EventSource\|refetchInterval\|Stream(" apps/web/src/app/ --include="*.tsx"
# (б) Decomposition-регресія: суб-компонент виділено з keystroke-frequent модалки БЕЗ memo (пропси вже стабільні)
for d in apps/web/src/components/ui/*/; do grep -rL "memo" "$d"*.tsx 2>/dev/null; done  # суб-файли декомпозицій без memo
# для кандидата: пропси лише примітиви+useCallback-хендлери у батька? батько має typing-input? → memo-кандидат
```

**Фікс (а) chart:** `export default memo(Chart)` — ЛИШЕ коли всі пропси стабільні (data з frozen-`EMPTY_*`-fallback/прямого query-ref; 0 inline-обʼєкт/масив/callback пропсів). recharts-callbacks усередині chart memo НЕ бачить. Lazy-loading ріже BUNDLE, НЕ runtime-reconcile — memo додає runtime-барʼєр.
**Фікс (б) суб-форма:** `function XBase(...){}` + `export const X = memo(XBase);`. Тригер тут — не live-tick, а typing у СУСІДНЬОМУ полі тієї ж форми (батько ре-рендериться на кожен символ). Zero-risk коли пропси = примітиви + useCallback-хендлери батька. Момент декомпозиції великої модалки = момент коли memo стає можливим і потрібним, але про нього забувають (фокус на розмірі файлу). Skip суб-модалки з inline-arrow-пропсами (`onClose={() => setX(false)}` → memo no-op) чи рідко-видимі (`open &&`-gated, дешеві коли closed). Відрізняти від list-item-memo (там ЛАМАЮТЬ inline-callbacks): тут пропси вже стабільні, готовий кандидат.

---

## Крок 3 — DB аудит

### 3.1 Відсутні індекси на WHERE колонках

```bash
grep -rn "where.*status\|where.*completedAt\|where.*branchId\|where.*warehouseId\|where.*type\b" apps/api/src/modules/ --include="*.service.ts" | grep -v spec | head -20
grep -n "@@index\|@@unique" packages/database/prisma/schema.prisma | head -40
```

| Таблиця       | Колонки                                    | Тип      |
| ------------- | ------------------------------------------ | -------- |
| WorkOrder     | `(orgId, status, branchId, deletedAt)`     | B-tree   |
| WorkOrder     | `(orgId, completedAt, deletedAt)`          | B-tree   |
| StockItem     | `(orgId, warehouseId, deletedAt)`          | B-tree   |
| StockMovement | `(orgId, warehouseId, createdAt)`          | B-tree   |
| text search   | `(number, firstName, lastName, name, sku)` | GIN trgm |

### 3.2 GIN trgm для пошуку

```bash
docker exec stoerp-postgres-1 psql -U sto -d sto_erp -c "SELECT indexname FROM pg_indexes WHERE indexname LIKE '%trgm%';" 2>/dev/null | head -15
```

**Фікс:** `CREATE INDEX IF NOT EXISTS idx_X_col_trgm ON X USING gin (col gin_trgm_ops);`

### 3.3 FK-колонка з `@relation` але БЕЗ `@@index` (Postgres не індексує FK автоматично)

> Пастка: «це ж relation, точно проіндексовано». Ні — PG індексує лише PK і UNIQUE, під FK-constraint — ніколи. Легко пропустити коли нова cross-document фіча (linked-counts, reverse-lookup) додає `groupBy`/`findMany` по `fkColumn: { in: [...] }`.

```bash
grep -rn "groupBy\|findMany" apps/api/src/modules/ --include="*.service.ts" -A3 \
  | grep -E "Id: \{ in:|Id: \{ *in:" | grep -v spec | head -20
grep -n "@@index\|@relation\|model " packages/database/prisma/schema.prisma
```

**Особливо небезпечно:** append-only без `deletedAt` (Payment, AuditLog, рухи) — часто немає навіть `(orgId, fk)`. Batched `IN`-груп-бай → org-wide scan.
**Фікс:** covering `@@index([orgId, <fk>])` (+`, <sortKey>` якщо є `orderBy`; для `_count` groupBy sortKey не треба) + additive `CREATE INDEX IF NOT EXISTS`. Ім'я = `<mappedTable>_orgId_<fk>_idx`. Звірити `@@map` — одна назва колонки (`invoiceId`) живе і в parent-lines, і в append-only payments.

### 3.4 Dashboard/summary aggregate по append-only — WHERE без owningFk, індекс веде owningFk (leftmost-prefix miss)

> Пастка: «є `(orgId, fk, createdAt)` — прикрито». Ні: якщо dashboard-гілка не подає `fk`, leading-col між orgId і createdAt вбиває прикриття → org-wide scan.

```bash
grep -rn "\.aggregate(\|\.count(" apps/api/src/modules/dashboard/ apps/api/src/modules/reports/ --include="*.service.ts" -A6 | grep -v spec
grep -n "@@index" packages/database/prisma/schema.prisma
# Для кожного: WHERE = (orgId, type|status: '<літерал>', createdAt-range) БЕЗ owningFk? Чи Є @@index що ПОЧИНАЄТЬСЯ (orgId, <discriminator>, ...)?
```

**Фікс:** covering `@@index([orgId, <discriminator>, createdAt])` — discriminator (equality) leftmost після orgId, createdAt (range) останнім. Additive `CREATE INDEX IF NOT EXISTS`. НЕ дублювати якщо discriminator уже leading-col. Кеш дашборду (25s) НЕ знімає потреби — scan болить кожен SSE-інтервал × N users.

### 3.5 Append-only (LOG/AUDIT **АБО CORE ENTITY**) — list/findAll фільтрує по non-FK descriptor (provider/operation/status/fiscalStatus), єдиний індекс веде createdAt-sort

> Пастка: «є `(orgId, createdAt)` під сортування — прикрито». Ні: equality-фільтр по descriptor (не FK, не aggregate — просто `where.provider=x`) не покривається → scan усіх рядків орг у createdAt-порядку + heap-filter.
> **Scope НЕ обмежений `*_logs`:** той самий miss у CORE append-only (`payments.fiscalStatus`, `supplier_payments.status`, `stock_movements.type`) — таблиця без «log» у назві, але монотонна + list зі status-дропдауном. FK-індекси + `(orgId, createdAt)` виглядають покриттям, але жоден не веде descriptor-рівність між orgId і createdAt (2026-09-09 Цикл 2).

```bash
grep -rn "async findAll" apps/api/src/modules/ --include="*.service.ts" -A25 | grep -v spec \
  | grep -E "where\.\w+ = |orderBy: \{ createdAt"
grep -n "model \|@@index\|@@map" packages/database/prisma/schema.prisma
# payments/supplier-payments/movements/transactions/receipts — теж кандидати, не тільки logs.
```

**ДОМІНАНТНИЙ фільтр:** відкрити UI-таб — колонка з `<select>`/дропдауном (provider/operation/status/type) = найчастіший equality-фільтр.
**Фікс:** covering `@@index([orgId, <descriptor>, createdAt])` — descriptor leftmost після orgId, createdAt tail → index-range scan + готовий порядок. Additive `CREATE INDEX IF NOT EXISTS`. Zero-risk. Родич 3.4, але тут list-endpoint (не aggregate) і колонка — descriptor (не owningFk).

### 3.6 Default-view index-miss: єдиний sort-індекс веде discriminator/deletedAt як GAP перед sort-ключем, а ДЕФОЛТНИЙ таб-вид — БЕЗ цього фільтра

> Пастка: «є `(orgId, status, deletedAt, sortKey)` — і статус, і дата, і soft-delete прикрито». Ні: у дефолтному «Усі»-виді (status-pill порожній) `where` БЕЗ status → status стає gap-колонкою, leftmost-prefix обривається на `orgId`, sortKey (3-тя/4-та колонка) для ORDER BY недосяжний → scan усіх status-бакетів + external sort. Другий `(orgId, sortKey)` часто Є, але без `deletedAt` → heap-filter.

```bash
# Знайти таби з дефолтом-«Усі» (порожній фільтр на mount) → їх list-запит іде БЕЗ discriminator-а
grep -rn "useState('')" apps/web/src/app/ --include="*Tab.tsx" --include="*page.tsx" | grep -iE "status|type|filter"
# Для таблиці такого табу: чи єдиний sort-індекс має discriminator/deletedAt ПЕРЕД sortKey?
grep -n "@@index" packages/database/prisma/schema/*.prisma
```

**Фікс:** covering `@@index([orgId, deletedAt, <sortKey>])` — deletedAt-рівність (IS NULL) leftmost, sortKey tail → index-range scan з готовим DESC. Additive `CREATE INDEX IF NOT EXISTS`. Filtered-вид лишає свій `(orgId, status, deletedAt, sortKey)` — це ОКРЕМИЙ індекс під дефолтний unfiltered-вид. Тільки схема+міграція (індекс типи не зачіпає → tsc не регресує без prisma generate). Родич 3.4/3.5, але тригер: descriptor ПРИСУТНІЙ як gap, і дефолтний вид його не подає.

---

## Крок 3b — Test-suite performance (vitest/jest)

> Не рантайм продукту, але реальна ціна в CI і в dev-циклі. Перевіряти коли scope включає тести АБО коли ТЗ згадує час набору.

### 3b.1 Vitest isolate — повторна оцінка спільних модулів на кожен файл

```bash
# НЕ grep — вимір. Сам Vitest діагностує у хвості звіту:
pnpm --filter @sto/api exec vitest run --reporter=verbose 2>&1 | tail -5
# Шукати: "evaluated M times" + "~Zs faster with isolate: false". import-частка Duration 70-80% = прапор.
```

**Сигнал:** `Duration` з часткою `import` 70-80% (не `tests`); рядок «Import N modules were evaluated M times» де M ≈ кількість spec-файлів; власна порада Vitest «faster with isolate: false».

**Безпека ПЕРЕД зміною** (shared-worker leak інакше валить тести):

```bash
grep -rln "resetModules\|isolateModules\|vi.doMock" apps/api/src --include="*.spec.ts"   # має бути порожньо
grep -rn "global\.\|globalThis\.\|process\.env\.[A-Z_]* =" apps/api/src --include="*.spec.ts" | grep -v stubEnv  # глоб. monkeypatch без restore
for f in $(grep -rln "useFakeTimers" apps/api/src --include="*.spec.ts"); do grep -q "useRealTimers\|afterEach" "$f" || echo "NO-RESTORE: $f"; done  # має бути порожньо
```

**Фікс:** підтвердити прапорцем `vitest run --no-isolate` (baseline vs no-isolate, обидва green) → лише тоді `isolate: false` у конфізі. Якщо no-isolate валить файли — це leak-и без restore: долагодити ТІ файли, не вертати глобальний isolate. `--no-isolate` — ще й детектор брудної cross-file ізоляції (виявляє тести що тихо залежать від стану іншого файлу). Деталі: «Накопичені підходи» 2026-10-04.

---

## Крок 4 — Виправлення

Для кожної: прочитай файл → мінімальний точковий фікс → `pnpm --filter <package> exec tsc --noEmit` (0 errors) → якщо schema.prisma змінена: `cd packages/database && npx prisma db push --skip-generate`.

**Пріоритет:** (1) N+1/waterfall; (2) відсутні індекси; (3) sequential→parallel; (4) cache miss; (5) bundle/memo (найменший ризик).

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

Запитай: **"Цей патерн вже покритий чеклістом? Чи новий тип неефективності вперше?"**

**Записуй** новий: тип (анти-патерн) · сигнал (grep/структура/назва) · причину · наслідок (запити/ms/kB).
**Не записуй:** конкретні файли/рядки · готові шаблони коду (Кроки 1-3) · те що вже в чеклісті.

**Формат** у "Накопичені підходи":

```
### [Дата] — [Тип] — [Де]
**Сигнал:** ознака для авто-пошуку   **Причина:** чому так пишуть
**Виявлення:** принцип пошуку   **Фікс:** принцип рішення
**Impact:** що змінилось   **Де шукати ще:** суміжні місця
```

**Оновлення чекліста** (якщо патерн підтверджений): grep-підрозділ у Крок 1/2/3 + запис у "Накопичені підходи" → коміт `docs(skills): add <pattern> to sto-optimize`.

---

## Накопичені підходи (оновлюється автоматично)

> Формат кожного запису: **Сигнал** (+grep) · **Причина** · **Виявлення** · **Фікс** · **Impact** · **Де шукати ще**. Записи від найновіших до найстаріших.

### 2026-10-04 — Vitest isolate:true: повторна оцінка спільних модулів по разу на кожен spec-файл (найбільша стаття часу набору)

**Сигнал:** час проходу тестів росте лінійно з кількістю spec-файлів, а не з обсягом логіки; у звіті Vitest рядок виду «Import N modules were evaluated M times · Xs total, Y% of tracked time» + його власна порада «~Zs faster with isolate: false». Повний набір витрачає 70-80% tracked-часу на `import`, не на `tests`. Дефолт `isolate: true` дає кожному spec-файлу СВІЙ модульний граф → спільне ядро (Nest/Prisma-client/zod/реєстри) компілюється й оцінюється знову для КОЖНОГО файлу (modules × files разів).
**Grep/вимір:** НЕ grep по коду — вимір прогону. `pnpm --filter <pkg> exec vitest run --reporter=verbose 2>&1 | tail -5` → шукати «evaluated M times» і «faster with isolate: false». Зафіксувати wall-time baseline (`Duration`), тоді `vitest run --no-isolate` → порівняти. Win реальний ЛИШЕ коли підтверджено вимір обох прогонів + 100% green у no-isolate.
**Причина:** isolate:true — безпечний дефолт (кожен файл чистий), але для mock-based unit-набору (без e2e-БД, без module-level mutable singletons) ізоляція дає нульову користь і повну ціну повторної оцінки. Набір ростився по файлу на модуль; ніхто не переглянув дефолт після того як кількість файлів перейшла за ~100.
**Виявлення:** великий unit-набір (100+ spec-файлів) з важким спільним ядром. ПЕРЕД зміною ПІДТВЕРДИТИ безпеку (інакше ламаються тести через shared-worker leak): (1) немає `vi.resetModules`/`isolateModules`/`vi.doMock` (жоден спек не покладається на свіжий модуль на файл); (2) немає глобального monkeypatch без restore (`global.X=`, `process.env.X=` поза stubEnv); (3) усі `useFakeTimers` мають `useRealTimers`/afterEach; (4) `vi.mock` лишається file-scoped і скидається між файлами незалежно від isolate — НЕ ризик. Якщо хоч одна умова не виконана — або лишити isolate:true, або спершу долагодити restore-гігієну.
**Фікс:** `isolate: false` у `vitest.config.ts` (топ-рівень `test`). Перевірити прапорцем `--no-isolate` ДО редагування конфіга (не комітити наосліп). Якщо no-isolate валить N файлів — це leak-и stubEnv/timers/spy без restore: НЕ вертати глобальний isolate, а долагодити ті файли (або лишити ТІЛЬКИ їх ізольованими через `test.sequence`/окремий project). Докласти `maxWorkers` уже стоїть — isolate:false ортогональний.
**Impact:** вимір на реальному наборі — 76.7s → 15-16s wall (×4.7), import-частка 79% → 31%, 3099/3099 green без зміни коду/тестів. Пастка-вимір: `--no-isolate` виявляє ПРИХОВАНІ cross-file залежності (стрей-edit env.schema без оновлення spec валив 2 тести і в isolate:true при запуску файлу окремо — isolate маскувало через те, що повний набір ДАВАВ іншому файлу запис process.env). Тобто no-isolate — ще й детектор брудної ізоляції.
**Де шукати ще:** будь-який пакет з власним vitest/jest-конфігом і великим unit-набором (web-component-набір, packages/shared). Jest-аналог — `--runInBand` vs workers + `testEnvironment`; там ціна інша (процеси, не модульні графи), але принцип «дефолт ізоляції vs розмір набору» той самий. НЕ чіпати e2e/integration-набори що РЕАЛЬНО піднімають БД/додаток на файл — там ізоляція несе сенс.

### 2026-10-02 — Повторне ДОРОГЕ перетворення того самого завантаженого файлу у multi-request wizard (OCR/парсинг двічі) → кеш за хешем вмісту

**Сигнал:** фіча-майстер читає ОДИН файл у ДВА окремі HTTP-запити: `/raw-preview` (показати вміст/структуру) → користувач налаштовує мапінг → `/preview` (резолв сутностей за мапінгом). Обидва ендпоінти незалежно викликають ОДНУ дорогу pure-трансформацію `parse(buffer)` над ТИМ САМИМ буфером. Для дешевих форматів (xlsx/csv) повторний розбір — мілісекунди (так і лишити). Але якщо канал включає OCR/розпізнавання/важкий CV — це ОКРЕМИЙ прогін 1-5 с × сторінку ВДРУГЕ. review часто фіксує як «Suggestion», бо для більшості форматів дешево — і справжню ціну (секунди для скана) пропускають.
**Grep:** `grep -rn "parseGrid\|parse(buffer\|\.extract(buffer" apps/api/src/modules/<feature>/ --include="*.service.ts"` — ДВА+ call-site тієї самої трансформації над завантаженим буфером у різних методах (preview vs apply/identify). Cross-check: (1) чи трансформація має дорогу гілку (OCR/растеризація/ML/зовнішній парсер — секунди)? (2) чи обидва методи працюють з ТИМ САМИМ файлом у межах одного UX-флоу (кілька секунд між запитами)? Обидва «так» → кеш-кандидат.
**Причина:** два ендпоінти писали в різний час під різні цілі (preview — рано, для UX; identify — пізніше, бізнес-логіка), кожен самодостатній. Клієнт перезавантажує файл кожним запитом (stateless multipart), сервер щоразу парсить з нуля. Для OCR ціна = дубльований прогін, який у dev на xlsx-фікстурах непомітний.
**Виявлення:** будь-який two-step upload-wizard (preview→commit) де крок 1 і крок 2 обидва парсять файл, і парсинг має OCR/важку гілку. Також: конвертація зображень, ML-класифікація завантажень, будь-який «показати→підтвердити» над дорого-обробленим файлом.
**Фікс:** `parseCached(buffer, filename)` над наявним Redis `CacheService`: ключ = `sha256(buffer)` (+kind), TTL ~300с (покриває ручний крок між запитами). **Кешувати ЛИШЕ дорогі канали** (gate по `detectKind`: pdf/image так, xlsx/csv — прямий розбір, зайвий серіалайз сітки не виправданий). sha256 25МБ ≈ 13мс vs OCR 1-5с/стор → 0.3-1% накладних на економію цілого проходу. **Безпека:** ключ ЛИШЕ за хешем вмісту — трансформація має бути ЧИСТОЮ функцією байтів (без orgId/БД-читок усередині), інакше орендарі змішаються; tenant-специфічну логіку (мапінг, резолв) лишати ПІСЛЯ кешу, на вже-довіреному результаті; клієнт результат НЕ постачає. **Офлайн:** CacheService мовчки деградує без Redis (get→null, set→no-op) → поведінка = поточна (трансформація двічі), нульовий ризик регресії.
**НЕ робити:** (а) приймати готовий результат з клієнта (небезпечно — сервер має парсити довірений буфер сам); (б) конвеєризувати rasterize(N+1)‖recognize(N) замість кешу — оцінка: растеризація 1 стор ≈ 10% per-page-часу, recognize не reentrant (enqueue-серіалізація), конвеєр тримав би 2 растри (×15МБ RGBA) одночасно під mem_limit:1g → економить ~10% ОДНОГО проходу ціною памʼяті+складності, тоді як кеш прибирає ЦІЛИЙ другий прохід. Кеш виграє на порядок.
**Impact:** імпорт скана/фото: OCR 1-5с/стор × (сторінки) ДВІЧІ → ОДИН раз (другий запит — Redis-hit). xlsx/csv — без змін. Найпомітніше на багатосторінкових сканах під реальним навантаженням.
**Де шукати ще:** xlsx-import rawPreview↔previewImport (fixed); bank-statements (parser двічі?); будь-який майбутній upload-wizard з OCR/ML/конвертацією. Родич 1.4 (ref-кеш довідників) — тут кеш не за orgId, а за ХЕШЕМ ВМІСТУ незмінного артефакту.

### 2026-09-21 (Цикл 1) — Default-view index-miss: єдиний date-sort індекс списку веде discriminator/deletedAt як GAP-колонку перед sort-ключем, а ДЕФОЛТНИЙ вид табу — БЕЗ цього фільтра → gap обриває leftmost-prefix, sort не покрито

**Сигнал:** staging/list-таблиця з композитним індексом `(orgId, <status|discriminator>, deletedAt, <sortKey>)` — спроектованим під ВІДФІЛЬТРОВАНИЙ вид (напр. «UNMATCHED, сортовано по даті»). Але UI-таб відкривається на pill/дропдауні «Усі» (порожній фільтр → `where` БЕЗ discriminator-а): `WHERE (orgId, deletedAt IS NULL) ORDER BY <sortKey> DESC`. discriminator стоїть 2-ю колонкою → коли його немає у WHERE, leftmost-prefix обривається одразу після `orgId`, а `<sortKey>` (3-тя/4-та колонка) для ORDER BY недосяжний → scan усіх discriminator-бакетів + external sort. Другий «date» індекс (`(orgId, <sortKey>)`) часто Є, але БЕЗ `deletedAt` → heap-filter м'яких видалень. Тонка відмінність від 3.4/3.5: там descriptor ВІДСУТНІЙ в індексах; тут descriptor ПРИСУТНІЙ, але як gap ПЕРЕД sort-ключем, і болить саме коли UI його НЕ подає (дефолтний = найчастіший вид).
**Grep:** для кожної list/staging-таблиці — відкрити UI-таб, знайти ДЕФОЛТНЕ значення status-pill/дропдауна (`useState('')` / «Усі» активний на mount = порожній фільтр). Якщо дефолт = БЕЗ discriminator-а → звірити чи Є `@@index([orgId, deletedAt, <sortKey>])` (АБО `(orgId, <sortKey>)` з deletedAt). Пастка: `(orgId, status, deletedAt, sortKey)` виглядає повним покриттям («і статус, і дата, і soft-delete!»), але у дефолтному виді status — gap, індекс не вибереться під сорт. `grep -n "useState('')" ...Tab.tsx` + `where.<x> = ` тільки за наявності фільтра.
**Причина:** індекс пишуть під «показати непрознесені/активні, сортовано» — очевидний робочий сценарій. Дефолтний «Усі»-вид (найчастіший на відкритті) не має discriminator-а у WHERE, тож той самий індекс НЕ покриває його сорт. На порожній dev-БД EXPLAIN не болить; регресія проявляється лише під об'єм.
**Виявлення:** будь-який таб зі status/type-pill де ДЕФОЛТ = «Усі» (не конкретний бакет), а єдиний sort-індекс має discriminator ПЕРЕД sortKey. Особливо append-only staging (bank_transactions, import-staging, inbox) — дефолт «усі записи по даті».
**Фікс:** covering `@@index([orgId, deletedAt, <sortKey>])` — `deletedAt`-рівність (IS NULL) leftmost після orgId, sortKey у tail → index-range scan з готовим DESC-порядком. Additive `CREATE INDEX IF NOT EXISTS`. Zero-risk. Filtered-вид лишає свій `(orgId, status, deletedAt, sortKey)`; це — окремий індекс під дефолтний unfiltered-вид. Тільки схема — client-типи не змінюються (індекс типи не зачіпає), tsc не регресує без prisma generate.
**Impact:** дефолтний список: org-wide scan усіх status-бакетів + external sort → index-range scan без sort. Найпомітніше на high-volume append-only під великий орг; sustained на КОЖНЕ відкриття табу (домінантний вид).
**Де шукати ще:** bank_transactions (fixed — дефолт «Усі»); будь-який staging/inbox-таб; списки де pill-дефолт = «Усі», а не конкретний статус. Родич 3.4/3.5 (equality не leftmost), але тригер інший: не «descriptor відсутній», а «descriptor присутній як gap, і дефолтний вид його не подає».

### 2026-09-19 (Цикл 1/3) — Cache-bypass N+1: cached list-endpoint додає «свіже/поза кешем» derived-поле per-row через service-виклик, а той сам = ≥2 запити → N+1 І обхід ref-кешу одночасно

**Сигнал:** `findAll` довідника має ref-кеш (Redis TTL) на СТАТИЧНУ частину, але один derived-стовпець (`balance`/`stock`/`availableQty`/`liveStatus`) свідомо рахується «свіжим, поза кешем» ПІСЛЯ читки кешу через `payload.items.map(async i => ({ ...i, balance: await this.svc.getX(orgId, i.id) }))`. Коментар прямо каже «завжди свіже / поза кешем / fresh / always» — і це присипляє: кеш ЛИШЕ на статику, а derived-поле б'є БД на КОЖНОМУ запиті. Гірше: сам `getX(id)` — не один запит, а КОМПОЗИТ (напр. `getBalance` = `findFirst(register)` + 2× `aggregate(IN/OUT)` = 3 запити). Разом = 3×N запитів на список + повний обхід кешу. Не просто «map з await» (1.1) — тут ще й (а) ref-кеш присутній але не покриває derived-поле, (б) per-item виклик — багатозапитний service-метод, не голий Prisma-call. Кеш маскує проблему при аудиті («findAll кешований → швидкий»), але derived-гілка нижче нівелює кеш.
**Grep:** `grep -rn "\.map(async" ... -B4 | grep -iE "cache\.get|поза кеш|свіж|fresh|always"` — map(async) одразу після/поряд з кеш-читкою + fresh-коментар. Плюс `grep "await this\.\w+\.get(Balance|Stock|Total|Status|Count)"` у `.map`/`for` — per-item виклик агрегуючого хелпера. Cross-check: чи `getX(id)` усередині робить ≥2 запити (findFirst+aggregate/2×aggregate)? чи derived-поле рахується per-row у циклі? Обидва «так» → cache-bypass N+1.
**Причина:** «static кешуємо, але баланс змінюється кожною операцією → мушу рахувати свіжим». Автор кешує правильну частину, а derived-поле лишає per-row бо «getBalance уже є, просто виклич його в map». Ніхто не бачить що (1) getBalance сам 3 запити, (2) виклик у map = ×N, (3) весь сенс кешу (не бити БД) зникає бо derived-гілка все одно б'є 3×N. Часто регресія: раніше endpoint віддавав чистий кеш, derived-поле додали пізніше під нову вимогу.
**Виявлення:** будь-який cached `findAll`/`list` що після кеш-читки МАПить derived/live-поле через service-виклик. Особливо money/inventory-довідники (cash-registers.balance, warehouses.stockTotal, accounts.balance) де «поточне значення» — агрегат append-only-руху. Момент коли до кешованого списку додають «а ще покажи актуальний баланс/залишок» = момент народження патерну.
**Фікс:** додати ПАКЕТНИЙ хелпер `getXs(orgId, initials: Map<id, seed>)` — ОДИН `groupBy` по `(entityId, discriminator)` з `entityId IN [ids]`, акумулювати sign*value у памʼяті, повернути `Map<id, value>`. Виклик у `findAll`: зібрати `initials` з уже-кешованих DTO (seed-поле типу `initialBalance` вже в кеші → сутність НЕ перечитується), викликати batch, змапити `balances.get(id) ?? seed`. Семантика byte-identical (та сама формула, менше запитів). Index: `groupBy` без discriminator-у WHERE → `(orgId, entityId)`-prefix наявного composite покриває (краще за per-item що heap-filter-ив discriminator). Zero-risk. НЕ прибирати кеш — прибрати САМЕ per-row derived-fan-out.
**Impact:** cash-registers findAll: 3×N (до 600 при take:200) → 1 запит. Масштабується з кількістю сутностей × частотою list-load; найбільше на дашборд-віджетах що ганяють список часто.
**Де шукати ще:** cash-registers.balance (fixed), warehouses/stock-totals, settlement-accounts.balance, bank-accounts.balance, будь-який довідник з «поточний залишок/лічильник» derived-полем над append-only рухом. Родич 1.1 (map-await N+1) і 1.4 (ref-кеш) — тут ОБИДВА разом: кеш є, але derived-гілка його обходить N+1-но.

### 2026-09-15 (Цикл 3/3) — Redundant re-fetch: mutation робить guard-`getX` → `updateMany` (tenant-scoped where) → повторний `getX` для return-значення = 3 RTT там де вистачає 2 (write-op повертає рядок через RETURNING)

**Сигнал:** service-mutation (`updateSaved`/`update`/`rename`/`patch`) починається з guard-читки (`await this.getX(orgId, id)` — 404 + tenant + not-deleted), далі пише через `updateMany({where:{id, orgId, deletedAt:null}, data})` (щоб tenant-фільтр жив у WHERE), а в кінці РОБИТЬ ЩЕ ОДИН `return this.getX(orgId, id)` бо `updateMany` повертає лише `{count}`, не рядок. Разом = 3 запити (read-guard + write + read-return), де середній write і фінальний read можна злити в один `update({where:{id}, data})` що повертає оновлений рядок через `UPDATE...RETURNING` (guard вище вже підтвердив приналежність org + not-deleted у ТОМУ Ж запиті, тож `update` по голому `{id}` безпечний). НЕ плутати з наявним guard-getX (він потрібен — дає 404-семантику + дозволяє dry-run валідацію config ПЕРЕД записом). Проблема — саме ТРЕТІЙ запит (return-refetch), не перший.
**Grep:** `grep -rn "updateMany(" apps/api/src/modules/ --include="*.service.ts" -A8 | grep -B6 "return this\.get\|return this\.find" | grep -v spec` — mutation що після `updateMany` робить `return this.getX/findX`. Cross-check: (1) чи Є guard-getX/findFirst НА ПОЧАТКУ методу що вже підтвердив tenant+not-deleted? (2) чи `updateMany`-where = `{id, orgId, deletedAt:null}` а `data` не залежить від race-стану? Обидва «так» → фінальний refetch зайвий, злити з write через `update({where:{id}})`.
**Причина:** `updateMany` обрали свідомо (треба `orgId`+`deletedAt` у WHERE, а `update` вимагає unique-where і не приймає composite tenant-фільтр напряму). Але `updateMany` повертає `{count}` → «щоб віддати свіжий DTO — перечитаю getX». Ніхто не помічає що guard-getX на початку вже зробив tenant-перевірку, тож `update({where:{id}})` (unique, повертає рядок) закриває і write, і return одним statement.
**Виявлення:** будь-який CRUD-update із tenant-guard-на-вході що завершується re-fetch. Особливо де є ще й dry-run валідація між guard і write (report-builder config) — там guard мусить лишитись, ріжеться тільки return-refetch.
**Фікс:** `updateMany(tenant-where)+return getX` → `return this.prisma.X.update({where:{id}, data})`. Guard-getX на початку ЛИШИТИ (404 + dry-run). Zero-risk: id щойно підтверджено як org-owned+not-deleted у тому ж синхронному потоці; `update` по PK повертає рядок через RETURNING без окремого SELECT. НЕ застосовувати якщо між guard і write є `await` що може змінити ownership (немає у CRUD), або якщо data залежить від concurrent-стану (тоді updateMany+count-guard, див. 2026-09-02 conditional-decrement).
**Impact:** rename/edit saved-report: 3→2 DB RTT (−33%). Масштабується з частотою edit-операцій; найпомітніше на low-latency-очікуваних inline-edit (rename-модалка).
**Де шукати ще:** усі `updateSaved`/`update`/`patch`-методи з guard-на-вході + return-refetch: report-builder (fixed), saved-filters, nav-config, notification-templates, будь-який settings-CRUD. Родич 2026-09-02 (upsert `.select` — write-op повертає рядок безкоштовно): обидва про «write повертає рядок через RETURNING», тут — прибрати зайвий refetch, там — не боятись `.select`.

### 2026-09-15 (Цикл 2/3) — Redundant full-scan: 2-3 приватні tree/graph-хелпери викликані підряд у одному mutation, кожен робить власний findMany(усе піддерево) → N ідентичних сканів на одну операцію

**Сигнал:** ієрархічний-довідник service (expense-categories, work-categories, будь-який parentId-tree) з guard-логікою на mutation-path — гілка-перенос/create-з-глибиною/каскад — викликає ПІДРЯД кілька приватних async-хелперів `getDepth()` + `getSubtreeHeight()` + `getDescendantIds()` (або `getAncestors`/`getChildren`). Кожен хелпер САМОСТІЙНО робить `findMany({where:{orgId,deletedAt:null}, select:{id,parentId}})` усього дерева і будує власну adjacency-мапу у памʼяті. Кожен окремо «без N+1» (обхід у памʼяті — і навіть коментар так каже), але разом = N ідентичних full-scan на одну mutation. Тут: update() reparent робив 3 однакові findMany. Це НЕ класичний N+1 (не ітерація по колекції) — це та сама читка, повторена бо кожен хелпер самодостатній.
**Grep:** `grep -rn "await this\.get(Depth|SubtreeHeight|DescendantIds|Ancestors|Descendants|Children)" apps/api/src/modules/ --include="*.service.ts"`. Для КОЖНОГО методу-споживача — чи ≥2 таких виклики у ОДНОМУ code-path (послідовно, не в різних гілках if)? Відкрити хелпери: чи кожен починається з власного `findMany(...tree...)`? 2+ у одному path + identичний findMany усередині → redundant-scan. Пастка: коментар «обхід у памʼяті — без N+1» присипляє — він правдивий per-helper, але scope хибний (кожен свій scan).
**Причина:** хелпери спроектовані самодостатніми (single-use — remove/toggleActive кличе лише getDescendantIds; create лише getDepth). Пізніший складніший guard (branch-move з MAX_DEPTH) потребує 3 метрик і просто кличе 3 готові хелпери підряд — «вони ж усі memory-обхід, дешево». Ніхто не бачить що кожен окремо тягне все дерево.
**Виявлення:** будь-який mutation-guard що читає ≥2 структурні метрики дерева/графа (глибина+висота+нащадки, ancestors+descendants, cycle-check+depth-check). Один знімок джерела покриває всі. Особливо в ієрархічних довідниках (categories, org-units, BOM, account-plan).
**Фікс:** виділити `loadTree(orgId)` (або `loadGraph`) що робить ОДИН findMany → повертає готові adjacency-мапи (`parentOf`, `childrenByParent`); перетворити хелпери на СИНХРОННІ pure-функції над цими мапами (`depthFrom(parentOf,id)`, `subtreeHeightFrom(children,id)`, `descendantsFrom(children,id)`). Multi-metric path кличе loadTree ОДИН раз + усі pure-функції. Single-use async-обгортки лишити тонкими (`getX = loadTree().then(pure)`) для їх одиничних call-site-ів — behavior/guard незмінні, а redundant-path тепер 1 scan. Zero-risk (та сама логіка, менше читок).
**Impact:** branch-move: 3 identичні full-tree findMany → 1 (−67% DB RTT на цю операцію). Масштабується з розміром дерева × частотою reparent.
**Де шукати ще:** усі parentId-tree довідники (expense-categories — fixed, work-categories — має getDescendantIds але single-use per-path, org-units, account-plan, BOM); графові guard-и (dependency-cycle + topo-depth); будь-який mutation що валідує І структуру І метрику окремими хелперами. Родич N+1 (1.1), але вимір інший: не «запит-на-елемент», а «однаковий запит-на-хелпер».

### 2026-09-15 (Цикл 1/3) — Decomposition-регресія memo: cohesive суб-компонент виділено з keystroke-frequent модалки/форми, memo НЕ додано, хоча пропси ВЖЕ стабільні (батько має useCallback-хендлери)

**Сигнал:** великий модал/форма з typing-полями (`CreateWorkOrderModal`, `PurchaseOrderCreateModal` — batched setState на кожен символ, батько ре-рендериться постійно) розбито у TD-декомпозиції на суб-компоненти (`./work-order/`, `./purchase-order/`). Виділений суб-компонент — `export function X(...)` БЕЗ memo, приймає ЛИШЕ примітиви + хендлери, а батько ті хендлери вже загорнув у `useCallback`. Тобто пропси стабільні за ідентичністю, але суб-компонент реконсилюється на кожен keystroke бо React рендерить дочірні при render батька без memo-барʼєра. Відрізняється від 2.17 (chart-під-SSE): тут тригер — не live-tick, а typing у СУСІДНЬОМУ полі тієї ж форми; від 2.6/list-item — там memo ламають inline-callbacks, тут callbacks вже useCallback-стабільні (готовий кандидат).
**Grep:** нові суб-компоненти від декомпозиції — `ls apps/web/src/components/ui/<parent-slug>/`, для кожного `grep -L "memo" X.tsx`. Cross-check у батька: (1) чи всі пропси примітиви/стабільні refs? (2) чи хендлери `useCallback`? (3) чи батько має typing-input (setState на символ)? Усі 3 «так» → memo-кандидат з реальним impact. Якщо у виклику inline-arrow-проп (`onClose={() => setX(false)}`) — memo no-op, спершу стабілізувати АБО skip якщо модалка рідко-видима (returns null коли closed).
**Причина:** декомпозиція фокусується на розмірі файлу («2337→2224 рядків»), не на runtime-барʼєрах. Автор бачить «виділив шматок як був» — але inline-JSX-блок у батьку реконсилювався разом з батьком «безкоштовно» (React не порівнює), а виділений компонент БЕЗ memo так само реконсилюється, лише тепер це окрема функція яку легко обгорнути. Момент декомпозиції = момент коли memo стає можливим і потрібним, але про нього забувають.
**Виявлення:** після КОЖНОЇ модалко/форм-декомпозиції (TD-рефактор «розбито N→M») — пройтись новоствореними суб-файлами, звірити стабільність пропсів у батьку. Пріоритет — суб-компоненти з кількома input/picker (дорогий рендер), під формою де є typing.
**Фікс:** `function XBase(...){}` + `export const X = memo(XBase);` (перейменувати internal, export через memo). Zero-risk коли пропси стабільні. НЕ чіпати суб-компоненти-модалки з inline-arrow-пропсами (no-op) чи рідко-видимі (`open &&` gated, дешеві коли closed).
**Impact:** typing 20 символів у формі × дорогий суб-компонент (2+ picker/input) → 20 зайвих реконсиляцій → 0. Звільняє main-thread під час набору.
**Де шукати ще:** усі `apps/web/src/components/ui/{work-order,purchase-order}/` суб-компоненти (PlannedActualMetrics — fixed; InvoiceConflictDialog/RulePricerModal — inline-arrow, skip); будь-яка майбутня декомпозиція великих модалок; header-форма CreateWorkOrderModal коли її винесуть у useWorkOrderForm-хук. Родич 2.17 (chart-memo під live-parent) і 2.6 (list-item memo) — усі три = «дочірній реконсилюється дарма під частим parent-render», різняться природою тригера і стабільністю пропсів.

### 2026-09-09 (Цикл 2) — Descriptor-фільтр-miss живе не лише у _\_logs/__audit, а й у CORE append-only ENTITY (payments.fiscalStatus, *_payments.status) — status/descriptor-дропдаун на entity-list-сторінці

**Сигнал:** core-money/append-only entity («1 рядок на операцію» без edit: payments, supplier_payments) має list-сторінку з `<select>`-дропдауном по status-подібній descriptor-колонці (`fiscalStatus`/`status`/`method`/`type`) — центральний use-case сторінки (напр. `/payments` фільтрує `fiscalStatus=FAILED` для повторної фіскалізації — raison d'être сторінки з retry-кнопкою). `findAll` робить `WHERE (orgId, <descriptor>=X) ORDER BY createdAt DESC`, але ВСІ індекси ведуть FK-осі (`workOrderId`/`counterpartyId`/`invoiceId`) + голий `(orgId, createdAt)`. Descriptor-рівність НЕ leftmost у жодному → лише сортування, descriptor heap-filter → org-wide scan. Розширення 3.5 (scoped на `*_logs/*_audit/*_events`) на CORE ENTITIES — той самий miss, але детектор 3.5 (grep за `*_logs`) її пропускає.
**Grep:** НЕ обмежувати `*_logs`. Для КОЖНОЇ append-only таблиці (без `deletedAt` АБО монотонно росте: payments, supplier_payments, movements, transactions, receipts) з `findAll(<optional status/descriptor>)` — відкрити list-сторінку, знайти `<select>` що йде у `where.<col>` → домінантний descriptor → звірити чи Є `@@index([orgId, <descriptor>, createdAt])`. Пастка: FK-індекси + `(orgId, createdAt)` виглядають покриттям, але жоден не веде descriptor-рівність між orgId і createdAt.
**Причина:** індекси core-entity проектуються під FK-drill-down + default-sort. Status/fiscal-дропдаун додається пізніше, equality-природа маскується «payments і так має купу індексів з orgId+createdAt».
**Фікс:** covering `@@index([orgId, <descriptor>, createdAt])` — descriptor equality leftmost, createdAt tail. Nullable descriptor OK (IS NULL-гілка активує індекс: 'none'→null). Additive `CREATE INDEX IF NOT EXISTS`. Zero-risk. ОДИН домінантний descriptor, не плодити на кожен optional-фільтр (append-only = INSERT-overhead; secondary комбінуються з domінантним, покриваються leading-col).
**Impact:** fiscalStatus-фільтр: org-wide scan+sort → index-range scan без sort. Найпомітніше на retry-workflow (постійний FAILED) під великий орг.
**Де шукати ще:** payments.fiscalStatus (fixed), payments.method, supplier_payments.status, stock_movements.type, invoices.status. Родич 3.4 (dashboard-aggregate) і 3.5 (log-list) — усі = «equality-col не leftmost між orgId і createdAt».

### 2026-09-09 (Цикл 2) — Lazy-chart child з єдиним stable-identity data-пропом БЕЗ React.memo під SSE/polling parent → recharts full-reconcile на кожен parent re-render (data стабільна → useMemo не «спрацьовує» як детектор, memo-gap маскується)

**Сигнал:** dashboard/reports з live-джерелом (`useDashboardStream`/SSE-tick, polling, або кілька дрібних state — `todayStr`/`greeting`/`qaConfigOpen`) рендерить lazy-chart (`<RevenueChart data={rows}/>` через `next/dynamic`). Data-проп зі СТАБІЛЬНОЮ ідентичністю (frozen `EMPTY_*` fallback + пряме query-посилання — вже правильно, useMemo не потрібен). АЛЕ chart — `export default function Chart(...)` БЕЗ `memo`. Parent ре-рендер на кожен tick → chart ре-рендер → recharts повний reconcile (SVG-дерево, шкали, тіки) попри незмінний data. Класичний детектор «rebuilt-inline array/useMemo-miss» дає false-negative: проблема не в НЕстабільному пропі, а у ВІДСУТНОСТІ memo на дорогому дочірньому під частим parent-render.
**Grep:** `dynamic(() => import(...Chart` у dashboard/reports. Для кожного: `export default memo(...)` чи голий `export default function`? Cross-check parent: SSE/polling/stream-hook (`useXStream`, `useQuery` з `refetchInterval`, `EventSource`) АБО 3+ дрібних `useState` що часто змінюються? Голий-function + часто-render parent + стабільний data-проп → memo-gap.
**Причина:** «chart lazy-loaded + data стабільна — done». Не помічають: lazy-loading ріже BUNDLE, НЕ RUNTIME reconcile — після монтування chart ре-рендериться з parent. memo здається зайвим бо «пропси не змінюються», але без нього React все одно викликає render + recharts reconcile.
**Фікс:** `export default memo(Chart)`. Безпечно ЛИШЕ коли всі пропси стабільні (data з frozen-fallback/query-ref; callbacks useCallback/відсутні). Inline recharts-callbacks (`tickFormatter`, `formatter`) живуть УСЕРЕДИНІ chart → memo їх не бачить. Якщо parent передає inline-обʼєкт/масив/callback — спершу стабілізувати, інакше memo no-op.
**Impact:** SSE-tick 30s × N-tiles: recharts full-reconcile → 0 поки data незмінна. Звільняє main-thread під live-update.
**Де шукати ще:** dashboard RevenueChart (fixed), reports ProfitabilityChart/SettlementsChart/LoadChart (перевірити memo), будь-який `<Chart data={...}/>` під SSE/refetchInterval/live-clock. Родич — важкий не-chart дочірній (таблиця/grid/map) під тим самим live-parent зі стабільними пропсами.

### 2026-09-09 — Нова append-only LOG/AUDIT-таблиця має covering-index під СОРТУВАННЯ (orgId, createdAt), але не під ДОМІНАНТНИЙ list-фільтр по non-FK descriptor (provider/operation/status)

**Сигнал:** нова `*_logs`/`*_audit`/`*_events` (append-only, без deletedAt) з `findAll(orgId, page, limit, <optional-фільтри>)` що `orderBy: {createdAt: 'desc'}`. Має `@@index([orgId, createdAt])` (сортування/пагінація) + інколи `@@index([orgId, documentType, documentId])` (drill-down). АЛЕ головний UI-фільтр — descriptor-колонка (`provider`/`operation`/`action`/`status`) як `<select>` у адмін-табі → домінантний equality. Жодного `@@index([orgId, <descriptor>, createdAt])` → `where.provider=x ORDER BY createdAt` не покривається → scan УСІХ рядків орг + heap-filter на кожен показ табу.
**Grep:** для кожної нової log/audit — виписати descriptor-колонки з optional-фільтрів, відкрити UI-таб → колонка-дропдаун = домінантний → звірити чи Є `@@index` що ПОЧИНАЄТЬСЯ `(orgId, <descriptor>, createdAt)`. Пастка: `(orgId, createdAt)` виглядає релевантним, але між ними немає descriptor.
**Причина:** індекси нової таблиці під «сортований список за часом» + drill-down по documentId — очевидні патерни. Descriptor-дропдаун додається у UI пізніше, equality маскується. На порожній dev-БД EXPLAIN не болить.
**Фікс:** covering `@@index([orgId, <descriptor>, createdAt])` — descriptor leftmost після orgId, createdAt tail. Additive `CREATE INDEX IF NOT EXISTS "<map>_orgId_<descriptor>_createdAt_idx"`. Zero-risk. Purge/deleteMany гілку (orgId, createdAt<cutoff) наявний `(orgId,createdAt)` покриває — окремий індекс не потрібен.
**Impact:** provider-фільтр: org-wide scan+sort → index-range scan логів провайдера без sort. Sustained на кожен показ адмін-табу; найбільший win під великий орг/cold cache.
**Де шукати ще:** integration_logs.provider (fixed), audit_events.action, notification_logs.channel|status, sync_logs.entity, webhook_logs.event. Родич 3.4 (aggregate), але тут list-endpoint + descriptor (не owningFk).

### 2026-09-07 — Modal-thrashing детектор дивився лише в ui/, а анти-патерн живе у consumer-і; shared reused-панель множить impact

**Сигнал:** SHARED панель (`ProviderRegistryPanel`, reused 3× — ПРРО/еквайринг/доставка) рендерить `<Modal onClose={closeX}>`, де `closeX` — plain-const `() => setState(null)` (НЕ useCallback). Модалка містить `<Input onChange={e => setCreds(...)}>` → кожне натискання = setState = ре-рендер панелі = нова ідентичність `closeX` → Modal.useEffect `[open, handleKey]` знімає+вішає keydown-listener І переписує `body.style.overflow` на КОЖЕН символ. Крок 2.16 покривав патерн, але grep сканував ЛИШЕ `components/ui/` — баг за визначенням у consumer-і (сторінка/панель під `app/`).
**Grep:** `onClose={() =>` (inline) АБО `onClose={closeX}`/`onClose={handleClose}` де handler plain-const без useCallback, скануючи `app/ + components/` ПОЗА `ui/`. Cross-check: чи модалка містить typing-input що б'є на кожен символ. Shared-панель (default-export reused) = пріоритет.
**Причина:** «`() => setX(null)` тривіальний, навіщо useCallback». Автор бачить один render-контекст. Детектор-грепи природно цілять у ui/ (де визначено Modal), не у consumer-и.
**Фікс:** `useCallback(() => setX(null), [])` (deps порожні для чистого setter). Zero-risk.
**Impact:** typing 20-символьного ключа: 20× (removeEventListener+addEventListener+2× body.style write) → 0. × кожна точка shared-панелі.
**Де шукати ще:** креди-модалки (ProviderRegistryPanel, NotificationProvidersPanel), create/edit-модалки з полями, search-модалки. Родич — onSubmit/onPaid inline-arrow у того ж Modal.

### 2026-09-06 — Cached/SSE dashboard-tile aggregate по append-only high-volume фільтрує по non-FK discriminator+date, а composite index веде leading-FK якого гілка НЕ подає (leftmost-prefix miss)

**Сигнал:** тонкий dashboard-tile (getSummary «виручка сьогодні»/«лічильник за сьогодні») робить `X.aggregate({where: {orgId, type|status: '<літерал>', createdAt: {gte: dayStart}}, _sum})` по append-only high-volume (settlement_transactions, payments, stock_movements, audit_events, loyalty_transactions). Гілка НЕ подає `<owningFk>`, але ЄДИНИЙ composite — `(orgId, <owningFk>, createdAt)` (під per-account list). B-tree leftmost-prefix: `<owningFk>` перед `createdAt` не заданий → org-wide scan + heap-filter. Кеш (Redis 25s) + `withTimeout(8s)` маскують у dev, але при обсягах кожен SSE-інтервал × user = повний scan.
**Grep:** для кожного `*.aggregate/count` у dashboard/summary виписати WHERE-shape. Append-only (без deletedAt) І WHERE = `(orgId, <літерал-discriminator>, createdAt-range)` БЕЗ owningFk → чи Є `@@index` що починається `(orgId, <discriminator>, ...)`? Пастка: `(orgId, <owningFk>, createdAt)` виглядає релевантним, але leading-FK вбиває прикриття.
**Причина:** composite під per-account paginated list. Пізніший tile читає під ортогональним кутом (org-wide зріз). Дашборд «дешевий бо кешований» → аудит пропускає.
**Фікс:** covering `@@index([orgId, <discriminator>, createdAt])` — discriminator leftmost, createdAt tail. Additive `CREATE INDEX IF NOT EXISTS`. Zero-risk. НЕ дублювати якщо discriminator сам leading-col.
**Impact:** aggregate: org-wide scan → index-range scan (транз-за-день-типу). Sustained per-SSE × N users.
**Де шукати ще:** dashboard/summary/KPI-tile що aggregate/count-ить append-only за (тип|статус) + createdAt-window: settlement_transactions (type=PAYMENT — fixed), payments (method), stock_movements (type), audit_events (action), loyalty_transactions (type).

### 2026-09-06 — FK-колонка з `@relation` але без `@@index` — batched `groupBy(fk IN [...])` у linked-counts фічі

**Сигнал:** нова cross-document фіча (linked-counts) додає `payment.groupBy({by:['invoiceId'], where:{invoiceId:{in:[...до 500]}, orgId}})` на КОЖНУ list-сторінку. FK `payments.invoiceId` мав лише `@relation` — жодного `@@index`. PG не індексує FK автоматично → groupBy йшов org-wide scan по `(orgId, createdAt)` з per-row `invoiceId IN` = O(N) по всіх оплатах орг.
**Grep:** у linked/counts-методах — кожен batched `<fk>Id: { in: [...] }` → модель у schema → чи `<fk>` у ПРЕФІКСІ якогось `@@index`. Пастка: та сама назва колонки (`invoiceId`) живе і в `invoice_lines` (індекс Є), і в append-only `payments` (немає) — звірити `@@map`.
**Причина:** «це relation, точно проіндексовано». Історично FK читали поодинці; append-only без `deletedAt` часто без жодного FK-індексу.
**Фікс:** covering `@@index([orgId, <fk>])` (+sortKey лише якщо `orderBy`; для `_count` не треба) + additive `CREATE INDEX IF NOT EXISTS "<map>_orgId_<fk>_idx"`. Zero-risk.
**Impact:** groupBy стає index-only; прибирає O(всі-оплати-орг) scan на кожен list-render.
**Де шукати ще:** append-only/join таблиці з nullable FK на документ під linked-counts — Payment.workOrderId (індекс Є), Payment.invoiceId (був відсутній), нова audit/log/movement у reverse-lookup.

### 2026-09-06 — linked-counts useQuery стріляє навіть коли колонка «Зв'язки» прихована — keyed лише на ids, не на visibleColumns (marginal, observation)

**Сигнал:** list-сторінка з toggleable колонкою `linkedDocs`/«Зв'язки» + `useQuery(queryKey:[...,'linked-counts', ids], enabled: ids.length>0)`. `enabled` не враховує видимість колонки → POST /linked-counts виконується навіть коли колонка схована. **impact marginal:** запит потрібен для вкладки «Документи» detail-панелі (badge-и), staleTime:30s кешує, тіло легке → зазвичай НЕ фіксимо. Записано щоб не «відкривати» вкол-фікс повторно.
**Якщо фіксити (лише коли counts НЕ потрібні деінде):** `&& colVisible.includes('linkedDocs')` у `enabled`. Не робити якщо ті самі counts живлять detail-панель/popup (badge зникне).

### 2026-09-02 (cycle 2) — Concurrency-guard `.select` на upsert НЕ додає RTT — Prisma UPDATE...RETURNING одним statement

**Сигнал:** post-check `if (upserted.quantity < 0) throw` після `db.stockItem.upsert({..., select: {quantity, reserved}})` як race-захист. Prisma `upsert({select})` компілюється у `INSERT ... ON CONFLICT ... UPDATE ... RETURNING` — ОДИН statement; `.select` лише звужує returning-shape, НЕ додає SELECT. Guard безкоштовний по RTT.
**Grep:** `grep -B5 -A5 "\.upsert\(" apps/api/src/modules/ --include="*.service.ts" | grep -E "\.select:|select: \{"`. Якщо після upsert `if (result.X < 0) throw` — guard, НЕ окремий RTT. НЕ пропонувати «злити select з upsert».
**Причина:** інтуїція «select — окремий query» з `findFirst({select})`. Для write ops Prisma завжди повертає row (`RETURNING`); `.select` — проекція.
**Фікс:** перед «збенефічити upsert» — перевірити фактичний SQL (EXPLAIN/`prisma:query`). Для write ops `.select` безкоштовний. Анти-паттерн: НЕ виправляти те що не зламане; **impact null** — документувати.
**Де шукати ще:** будь-який concurrency-fix що додає `.select` до upsert/update/create + post-check. Якщо PR каже «post-check ЧЕРЕЗ додатковий select» — pushback з реальним SQL.

### 2026-09-02 (cycle 2) — Conditional-decrement через `updateMany + WHERE guard-col + count check` — race-safe безкоштовно, PK lookup O(1)

**Сигнал:** hot-path counter декремент (`stockBatch.remainingQty`, `stockItem.quantity`, `bankAccount.balance`, `remainingAllocation`) під concurrent write: read snapshot → decrement може дати negative без row-lock. Fix без блокуючого lock: `updateMany({where: {id, guardCol: {gte: take}}, data: {decrement}})` + `if (count === 0) throw`. При race інший tx декрементив між findMany і updateMany → guardCol < take → skip → count=0 → throw → $tx rollback.
**Grep:** для кожного `.update({where:{id}, data:{X:{decrement:qty}}})` на counter-таблиці (StockBatch, StockItem, Account, Wallet, Reservation) під polling — переписати у `updateMany({where:{id, X:{gte:qty}}, data:{X:{decrement:qty}}})` + count-check. НЕ додає RTT.
**Причина:** Prisma default isolation = ReadCommitted → row-lock лише на statement, не між findMany+update. 2 read-и бачать той самий remainingQty → double decrement → negative.
**Фікс:** `.update → .updateMany({where:{id, counter:{gte:take}}})` + `if (updated.count === 0) throw` → $tx rollback. По PK → primary index, heap re-filter counter, O(1). Не потрібно Serializable.
**Де шукати ще:** StockBatch.remainingQty (fixed), StockItem.quantity (fixed), Invoice/Payment.remainingAllocation, Reservation.remainingQty, Voucher.remainingUses, Wallet.balance. Особливо у `while (remaining > 0)` (consumeBatch, drainQueue, allocatePayments).

### 2026-09-02 (cycle 2) — `Object.values(obj).reduce()` після filter-loop → накопичувати суму під час фільтрації, один прохід

**Сигнал:** заповнюється `byX[key] = value` (з `if (value > threshold)`), потім `total = Object.values(byX).reduce((s,v)=>s+v, 0)`. Два проходи. У `.map(supplier => {...})` × 50 = 50 Object.values-arrays + 50 closures. Merge: `if (value > threshold) { byX[key] = value; sum += value; }`.
**Grep:** `grep -rn "Object\.values\([a-zA-Z]\+\)\.reduce" apps/api/src/modules/ --include="*.service.ts"`. Cross-check: чи reduce йде ПІСЛЯ циклу що будував той об'єкт з умовою.
**Причина:** декларативний стиль (1) заповнити мапу, (2) total = sum of values. У hot-path N alloc + N iter per каскад.
**Фікс:** `.reduce()` де джерело — щойно побудований об'єкт → `let sumX = 0` перед loop, `sumX += v` під тією ж filter-умовою, замінити `Object.values.reduce` на прямий `sumX`.
**Impact:** 50 suppliers × ~20 dates: 50 alloc arrays + 1000 reduce iter → 0. GC pressure знижений.
**Де шукати ще:** getSchedule/getSummary/getReport що будує `byX={}` з filter-inserts + `Object.values.reduce`; report generators, dashboard tiles, PDF summary. Родич — `.forEach(x=>acc[k]=v) + Object.values(acc).reduce`.

### 2026-09-02 (cycle 2) — Три `.reduce()` підряд по одному масиву → merge у single-pass for-of з 3+ accumulators

**Сигнал:** `const A = lineData.reduce(s+priceWithoutVat); const B = lineData.reduce(s+vatAmount); const C = lineData.reduce(s+priceWithVat)`. Три проходи × 3 closure. 100 рядків: 300 iter → 100 iter + 0 closure. Розширення «multi-scan reduce» (2026-08-30) для DTO/save.
**Grep:** `grep -rn "reduce.*=>.*reduce" apps/api/src/modules/`; або 2-3 підряд `const \w+ = \w+\.reduce(...)`.
**Причина:** кожна формула окремо для читабельності. У save-path (invoice clone, WO save, PO recompute) — hot-path.
**Фікс:** consecutive `.reduce()` на тому масиві (≥2 різних extracts) → `let A=0; let B=0; let C=0; for (const l of lines) { A += Number(l.a); ... }`. Не merge коли reduce мають різні seed/transform (average, product, fold) — тільки sums.
**Impact:** 100-line invoice: 300→100 iter. p95 gain 0.1-0.5ms/call.
**Де шукати ще:** invoice clone/updateInvoiceFromWO, PO recomputeTotals, WO recalcTotals, stock-document totals, receipt-doc save, supplier-return totals.

### 2026-09-02 — Compound-index sort-tail miss на INTERNAL paginated hot-path helper — WHERE-префікс покритий, ORDER BY-column НЕ у tail → external sort per page

**Сигнал:** append-only child-table (StockBatch, StockMovement, AuditLog, BatchConsumption) читається з paginated service-helper (не HTTP) через `findMany({where: {orgId, fk1, fk2, bool_flag: true, remainingQty: {gt:0}}, orderBy: {createdAt}, take: PAGE})` у `while (remaining > 0)`. WHERE-equality покрито `(orgId, fk1, fk2, bool_flag)`, але sort-column НЕ у tail → **external sort** на КОЖНІЙ сторінці. Під polling (кожен WRITEOFF/WO-COMPLETED/TRANSFER-out) — sustained CPU. Родич «Public hot-path multi-field WHERE» (2026-06-20), але для INTERNAL helper з sort у tight loop.
**Grep:** `findMany({...orderBy: {createdAt|expiryDate|documentDate}, take:...})` всередині циклу (`while`/`for`/`.map(async)`). WHERE = усе equality + sort = один column → потрібен `(orgId, ...equality_cols, sort_col)`. Cross-check: `(orgId, fk1, fk2, bool_flag)` БЕЗ tail `createdAt` = drift. Особливо consumeBatch/returnToBatch/processQueue/drainOutbox.
**Причина:** compound-index під CRUD (`findFirst` без orderBy). Пізніша pagination додала `orderBy` — «WHERE вже покритий». EXPLAIN `Sort` node видно лише при профілюванні.
**Фікс:** `CREATE INDEX IF NOT EXISTS ... ON <table> (orgId, ...equality_FK у порядку selectivity, low-card bool_flag, sort_col ОСТАННІМ)`. B-tree покриває asc+desc. НЕ додавати range-cols (`remainingQty > 0`) — heap re-filter. Дзеркалити у `@@index`.
**Impact:** stock_batches 10-50k/org, consumeBatch кожні 100мс: per-page sort ~1-3мс → index-order scan ~0.2-0.5мс × N pages.
**Де шукати ще:** consumeBatch (FIFO/LIFO), drainOutbox, processQueue, auditLog cleanup, reconciliation act, notifications dispatch. Checkpoint при paginated internal helper.

### 2026-08-30 (cycle 3/3) — Sibling-drift audit: після нового hot-path fix одразу пройтись по ВСІХ sibling-services/components і зафіксувати у той же коміт

**Сигнал:** попередній цикл фіксив один hot-path патерн (SP_SORT_FIELDS у одному CRUD-модулі), але наступний grep біжить тільки по нещодавно зміненому файлі. Sibling-модулі (invoices/WO/PO/SD — усі мають `findAll(sortBy?)` з `SORT: Record<string,string>` у body) лишаються не-міграцованими (copy-paste-legacy).
**Grep:** після кожного фіксу — ІДЕНТИЧНИЙ grep-signature (той що знайшов original) на ВСІХ файлах шару, не тільки git-diff-scope. Напр. `grep -rn "^\s\+const [A-Z_]\+: Record<" apps/api/src/modules/ --include="*.service.ts"` дає повний список drift. Той підхід для frontend `EMPTY_*` літералів.
**Причина:** розробники копіюють CRUD-модулі; sort-whitelist «в body бо тільки тут» переноситься. Perf-audit рухається fresh по recent changes — legacy не отримує аудиту.
**Фікс:** після «hoist alloc from body» — grep-signature на ВСІХ файлах directory; hits тепер vs до = має бути N-1; якщо >1 — усі fixed у той atomic commit. Prefix консистентний (`<MODULE>_SORT_FIELDS`, `<MODULE>_INCLUDE`). Commit body перераховує sibling. НЕ merge у shared const якщо семантика різна (invoices dueDate vs PO totalAmount) — merge тільки copy-paste identical.
**Impact:** цикл-3 фіксив 8 sibling-drifts за прохід. Без sibling-audit — O(N) circular repetition; atomic protocol = 1 pass, O(1) commits.
**Де шукати ще:** ЛЮБИЙ perf pattern — після fix у 1-му модулі extend grep на весь directory. Особливо: sort-whitelists (10+ CRUD), Prisma include/select shapes, EMPTY__/DEFAULT__ літерали, frontend regex constants, balance/status/discriminator maps.

### 2026-08-30 — Sort-field whitelist Record/tuple-array declared INSIDE service `findAll` body — re-allocated on every list request under polling

**Сигнал:** `findAll(sortBy?, sortDir?)` містить `const SORT_FIELDS: Record<string, string> = {...}` (або tuple/enum-labels) у тілі функції. Кожен list-запит (polling 30s + filter/pagination + tab switch) → alloc заново. Frontend-варіант: той Record у `visibleColumns.map(col => {...})` (N×render). Той підпис для tuple-arrays — static filter options `[['', 'Всі'], ...]` у body.
**Grep:** backend `grep -rn "^\s\+const [A-Z_]\{3,\}: Record<" apps/api/src/modules/ --include="*.service.ts"` (indent-guard забирає module-level). Frontend `grep -rn "^\s\+const [A-Z_]\{3,\}: (Record|Array|\{)" apps/web/src/app/ --include="*.tsx"` + `grep -rn "\.map(.*=> {[\s\S]{0,200}const [A-Z_]" apps/web/src/`. Regex-версія `grep -rn "^\s\+const [A-Z_]\+_RE = /" apps/web/src/`.
**Причина:** whitelist ставлять поруч зі споживачем. Не помічають: (a) backend service метод request-scoped; (b) React re-runs body top-to-bottom; (c) inside `.map()` — N× amplification. Compilation-time constants семантично identical до module-level.
**Фікс:** для public `findAll`/`findMany` — перші 20-30 рядків, `const [A-Z_]+: (Record|Array|readonly) = {...}` з literal values → hoist на module-level з owner-prefix (`SP_SORT_FIELDS`, `INV_SORT_FIELDS`; regex `PO_UUID_RE`). НЕ виносити коли: залежить від reactive prop / useMemo-subresult / містить closure-callbacks.
**Impact:** backend 1 hash+4 strings/call → 0. Frontend inside `.map()`: typing 20 chars @ 7 columns × 20 renders = 140 alloc → 0. Regex compile переноситься з render у module load.
**Де шукати ще:** `findAll`/`findMany`/`search`/`filter` — sort-whitelists, filter-key allowlists, field-alias maps. Frontend SORTABLE Records inside `.map()`; error-message Records у validate(); regex у effect body.

### 2026-08-30 — Multi-scan reduce accumulator у aggregation service — суперSet 2026-06-17 twin-scan для 3+ reduce з різними semantics

**Сигнал:** aggregation service (getSchedule/getSummary/getReport/getBalances) після compute-loop будує totals через 3+ `.reduce()` на тому масиві (`suppliers`/`entities`/`lines`) + loop-with-reduce на 2-му вимірі (`dates` × per-date reduce). Розширення «twin-scan reduce» (2026-06-17) на двовимірну aggregation.
**Grep:** `const \w+ = \{[\s\S]{0,300}\.reduce\([\s\S]{0,200}\.reduce\([\s\S]{0,200}\.reduce\(` (3+ reduce у object-літерал); або `for (const \w+ of \w+) {[\s\S]{0,100}reduce\(` (reduce у for-of). Підтверджуючий: `if (sum > 0) totals.byDate[d] = sum` після reduce.
**Причина:** кожна формула окремо (overdue-sum, planned-sum, per-date-sum). N-times passes; для report з 2+ вимірами.
**Фікс:** single-pass for-of з локальними `let`; для двовимірного — nested for-in по inner keys (plain object швидший для string keys); post-loop prune порожніх buckets; preserve `?? 0`.
**Impact:** getSchedule 50 suppliers × 20 dates: 1150 iter + 23 closures → ~500-800 ops + 0 closures.
**Де шукати ще:** `get{Schedule|Summary|Report|Balances|Statistics}` з двовимірним output (suppliers×dates, customers×months, branches×status). `{items, totals}` → totals кандидат.

### 2026-08-30 — Aggregation-endpoint фільтрує reference-таблицю за discriminator-ом що не є FK — базовий `(orgId, fkId, deletedAt)` не покриває, потрібен `(orgId, discriminator, deletedAt)`

**Сигнал:** aggregation-метод (`getSchedule`/`getSummary`/`getBalances`/`getReport`) читає reference-таблицю (contracts, price-lists, warranties, categories, rates) не через FK, а через SEMANTIC-discriminator: `where: {orgId, contractType: 'PURCHASE', creditLimit: {not: null}, deletedAt: null}`. Базовий `(orgId, fkId, deletedAt)` (CRUD-list) НЕ активується → звуження лише по orgId + heap re-filter. Fetched у Promise.all, час maskується, але polling staleTime=30s × N users. feat-commit додає endpoint БЕЗ супутньої migration.
**Grep:** для методу з `Promise.all([...])` з ≥2 findMany/groupBy — виписати WHERE-shape. Для reference (Contract, PriceList, Rate, Warranty, Category) чи є `(orgId, ...discriminators, deletedAt)` де discriminators = літерал-value fields, не FK. Якщо лише `(orgId, fkId, deletedAt)` + `(orgId, syncVersion)` → drift.
**Причина:** reference-index під «показати X-и цього Y-а» (CRUD). Нова feature читає cross-cutting («всі PURCHASE-контракти org-а»). EXPLAIN: `Bitmap Heap Scan` з `Filter:` по discriminator, або `Seq Scan`.
**Фікс:** `CREATE INDEX IF NOT EXISTS "<table>_orgId_<discriminator>_deletedAt_idx"` — discriminator leftmost після orgId (селективність спадно: contractType раніше ніж isPrimary), deletedAt останнім. НЕ включати `creditLimit: {not: null}` (heap re-filter швидший за partial). Дзеркалити у `@@index`. Одна migration для всіх reference-tables.
**Impact:** counterparty_contracts 1000/org, polling 30s: bitmap heap scan ≈5-15ms → index-narrow ≈0.5-2ms. Endpoint fetch-ає ~5-10 reference-tables → 20-100ms P50.
**Де шукати ще:** aggregation/report/schedule з Promise.all: SupplierPayment.getSchedule (contractType), Report.getPricing (isActive+scope), Report.getWarranties (status+expiring), Dashboard.getSummary (rates by currency), Inventory.getLowStock (category+isActive).

### 2026-08-30 — Reverse-FK axis miss на child-table що не має власного CRUD-endpoint — indexed тільки прямий FK, нема compound з orgId+reverse-fk+deletedAt

**Сигнал:** child-table «документ-attachment» (SupplierPayment, InvoiceLine, StockBatch, WorkOrderPart) до parent (PO, Invoice, SD, WO) читається 3 способами: (1) `findAll(parentId=?)`, (2) nested include `where: {<childFk>: {in: [...]}}`, (3) `groupBy` з `<childFk>: null`. Existing indexes покривають self-CRUD (`orgId,deletedAt`; `orgId,ownerFkId,createdAt`; `orgId,status,createdAt`) але НЕ `(orgId, <parentFkId>, deletedAt)`. Причина: parentFkId був nullable optional discriminator, не primary access path.
**Grep:** для child з nullable FK на parent (`purchaseOrderId String? @db.Uuid`) — чи є `@@index([orgId, <parentFkId>, deletedAt])`. Якщо нема — grep service за (a) `findAll(...parentId?)`, (b) `where: {<childFk>: null | {in:[...]}}`, (c) parent-service include `<childCollection>`. Хоча б один → drift.
**Причина:** child-generator створює index під self-CRUD. Parent detail-view + aggregation пізніше; Prisma nested include генерує `WHERE parentFkId IN (...)` — розробник не бачить query.
**Фікс:** `(orgId, <parentFkId>, deletedAt)` — orgId, parentFkId (equality-narrow), deletedAt (low-card). Не додавати createdAt (include без orderBy). Не partial index — nested include використовує `IN`, не `IS NOT NULL`.
**Impact:** supplier_payments 10k/org, PO деталь: seq-scan ≈15-30ms → index-narrow ≈1-3ms.
**Де шукати ще:** StockBatch.stockDocumentId, WarrantyClaim.workOrderId, Attachment.entityId (polymorphic). Bonus: `groupBy` з `<childFk>: null` майже завжди triggerить drift.

### 2026-06-20 — Public hot-path multi-field WHERE без супутнього compound B-tree — `(equality_cols, range_col)` index що ставить equality columns першими

**Сигнал:** public-endpoint TTFB-path (`BookingService.getAvailability()` — widget без auth, throttle є, кеша нема) робить `findMany` з multi-field WHERE — 3-5 equality (`orgId`, `branchId`, `status='CONFIRMED'`, `deletedAt IS NULL`) + 1 range (`requestedDate: {gte, lte}`). Existing indexes покривають лише ПРЕФІКС (`(orgId, status, deletedAt)`) — branchId equality + requestedDate range heap re-filter.
**Grep:** для public-route (`@Throttle` без `@UseGuards(JwtAuthGuard)`/`@ApiBearerAuth()`) — `where` у findMany/findFirst/count; equality cols + range cols (`gte`/`lte`/`in`>1). Cross-check `@@index`: чи перші N equality збігаються з ОДНИМ index (equality перші, range останнім)? EXPLAIN: `Bitmap Index Scan` з `Filter:` = heap re-filter.
**Причина:** B-tree leftmost-prefix: WHERE на `(a, c)` без `b` НЕ покриває `(a, b, c)`. Розробник додає equality discriminator (branchId) без розуміння що він має бути перед range column. Throttling маскує.
**Фікс:** `CREATE INDEX IF NOT EXISTS ... ON <table> (tenant-guard orgId[+branchId], equality discriminators у порядку selectivity, range column ОСТАННІМ)`. НЕ включати `deletedAt` у leftmost prefix при tenant-guard (cardinality 2). Дзеркалити у `@@index`.
**Impact:** booking_requests 5k/org, getAvailability: bitmap heap scan ≈5-15ms → index-range scan ≈0.5-2ms.
**Де шукати ще:** public/throttled endpoint з filtered list — getAvailability, findByShareToken + downstream lists, public CalendarSlot, quote-share. Smell test: EXPLAIN `Filter:` rows-removed >0 на public endpoint.

### 2026-06-20 — Ordered sub-sequence + independent cross-table write всередині `$transaction` — wrap sub-sequence у async IIFE, Promise.all з незалежним write

**Сигнал:** `update()`/`replace()` у `$transaction` замінює дочірню колекцію (tiers/lines/parts): `await tx.child.deleteMany` + `await tx.child.createMany`, ОДРАЗУ — `await tx.parent.updateMany({where: {id, orgId}, data: scalars})` (інша таблиця, не залежить від tier). 3 sequential await → 3 RTT. Tier-sequence МУСИТЬ бути ordered (create після delete), але main updateMany ОРТОГОНАЛЬНИЙ. Variant «Disjoint-set updateMany pairs» (2026-06-12) для TRIPLE-await.
**Grep:** `\$transaction\(\s*async tx => \{[\s\S]{0,200}await tx\.\w+\.deleteMany[\s\S]{0,300}await tx\.\w+\.createMany[\s\S]{0,300}await tx\.\w+\.updateMany`. Перші дві на одній таблиці (childTier), третя на ІНШІЙ (parent). Якщо всі три на одній — НЕ цей патерн.
**Причина:** linear-стиль; main update read-залежить ТІЛЬКИ від `id`+`orgId`, не від tier-результату.
**Фікс:** обернути ordered sub-sequence у async IIFE: `const tierWork = (async () => { await tx.child.deleteMany(...); if (data.length) await tx.child.createMany(...); })();`; окремо `tx.parent.updateMany(...)` БЕЗ await; `await Promise.all([tierWork, mainUpdate])`; final `findFirstOrThrow` останнім. Race-safe (РІЗНІ таблиці). НЕ коли main залежить від `tierTotal`.
**Impact:** pricing-rules.update() з tiers + main: 3 await → 2 RTT (33%).
**Де шукати ще:** service-метод що замінює дочірню колекцію + оновлює parent-scalars — invoice.update (lines+totals), workOrder.update (parts+notes), stockDocument.update (lines+warehouseId), PO.update (lines+supplierId), bookingRequest.update (slots+status).

### 2026-06-19 — Trgm index drift у search OR clause — нова/прогаяна колонка у `where.OR = [{ a contains }, ...]` без парного `idx_X_col_trgm`

**Сигнал:** `findAll(query)` має `where.OR = [{colA: {contains: q, mode: 'insensitive'}}, {colB: ...}, {colC: ...}]` (2-5 гілок). Деякі cols покриті GIN trgm, але мінімум один — НІ. PG звужує по `orgId+deletedAt`, потім per-row `LIKE` на non-trgm col.
**Grep:** для таблиці з search — `where.OR` columns vs existing `idx_X_*_trgm`. `goods`: search `[name, sku, barcode]`, trgm = `[name, sku]` → drift на `barcode`. Per column: `grep "_<column>_trgm" packages/database/prisma/migrations/`.
**Причина:** trgm-міграції batched один раз, не re-аудиту-ються. Нова search column працює (tenant-guard index звужує), але план фолбекає на seq+LIKE.
**Фікс:** `CREATE INDEX IF NOT EXISTS "idx_<table>_<column>_trgm" ON <table> USING gin ("<column>" gin_trgm_ops);`. Cross-check `pg_trgm` extension (якщо нема — `CREATE EXTENSION IF NOT EXISTS pg_trgm`). НЕ у Prisma schema (GIN не expressed у DSL). Drift у >1 column → одна migration. НЕ плодити для non-WHERE cols (GIN ≈30% INSERT overhead).
**Impact:** goods 50k/org, `q=ART-001` (barcode): seqscan ≈10-50мс → trgm bitmap ≈1-3мс.
**Де шукати ще:** для КОЖНОЇ моделі з search OR (Good, Counterparty, WorkOrder, Invoice, PO, SD, Employee, Vehicle) — OR колонки vs trgm indexes. WorkOrder.findAll OR=[number, counterparty.*] — counterparty join cols мають свої trgm.

### 2026-06-17 — Twin-scan `reduce()` у backend mutation-hot-path recalc/aggregate helper — single-pass `for…of` з двома акумуляторами

**Сигнал:** service-helper `recalcTotals`/`recomputeAggregates`/`applyDocBalances` (з 6+ mutation entry-points — addLine/updateLine/removeLine/addPart/...) робить `findMany({select})` потім ДВА `.reduce()` по тому масиву (`totalLabor = SUM(amount)`; `totalActualLabor = SUM((actualHours ?? normoHours) × price)`). Backend-варіант «Twin-scan reduce у tfoot» (2026-06-11) — per-mutation CPU/GC.
**Grep:** `\w+\.reduce\([^)]+\);[\s\S]{0,300}\w+\.reduce\(` (той identifier). Допоміжний: `findMany` ВИЩЕ з `select` що містить поля обох reduce.
**Причина:** формула змінилась → нова reduce поряд зі старою. Хибне «1 раз на mutation». Реально: WO 50 ліній × 6 mutation типів = 600 wasted ops; +2× Number() casts (Decimal→Number alloc).
**Фікс:** один `for (const x of array) { acc1 += ...; acc2 += ...; }` з `let acc1=0; let acc2=0;`. Half CPU + half GC. Додати `take: N` у findMany (~1000). Не зливати reduce у DIFFERENT collections (lines vs parts).
**Impact:** WO 50 рядків: 100 iter + 100 casts → 50+50. Edit-сеанс 10 mutations: -500 iter + -500 allocs.
**Де шукати ще:** `recalc*`/`recompute*`/`applyTotals*`/`refreshAggregates*` — WO, invoices, SD, PO, supplier-returns, estimates. Моделі з aggregate-парами (totalLabor+totalActualLabor, totalAmount+totalVat, totalDiscount+totalNet).

### 2026-06-17 — Sequential post-token `wo + org + uoms` lookup у public share-endpoint — 3 RTT ланцюг, merge tail-pair у Promise.all

**Сигнал:** public share-token endpoint (estimate-share, invoice-public, document-view) має 3-step: (1) `findFirst({where: {shareToken}})` → `wo`, (2) `findFirst({where: {id: wo.orgId}})` → `org`, (3) `findMany({where: {id: {in: uomIds}}})` → `uoms`. Перші 2 sequential (org.id=wo.orgId), але 2+3 паралельні (обидва залежать від wo). 3 RTT де можна 2. Sibling-drift: findByShareToken ↔ getEstimateData.
**Grep:** `findFirst\([^)]+shareToken[\s\S]{0,1500}await this\.prisma\.organisation\.findFirst[\s\S]{0,500}await this\.prisma\.\w+\.findMany\(`. Перевіряти export-endpoint-и (PDF/XLSX/DOCX) що викликають shared data-builder.
**Причина:** послідовно бо «спочатку 404-guard, потім все інше». Після if-throw подальші lookups незалежні.
**Фікс:** виlift `const uomIds = wo.X.map(c => c.fkId).filter(...)` ПЕРЕД; `const [org, uoms] = await Promise.all([findFirst(org), uomIds.length ? findMany(uoms) : Promise.resolve([])])`. Map-fill loop ПІСЛЯ. НЕ зливати з token-lookup (pre-guard).
**Impact:** TTFB ~15ms → ~10ms (33%). × 3 export-формати.
**Де шукати ще:** findByShareToken, getEstimateData, invoice-public.findByToken, document-view.getByPublicId, pricing-list-share. Парний паттерн: коли один оптимізовано, sibling майже завжди лишається sequential.

### 2026-06-16 — Settings/config read-endpoint без Redis cache при high-mount-frequency UI — sibling settings.X мають cache, новий тонкий getter НЕ має

**Сигнал:** `getWorkHours`/`getFeatureFlags`/`getQuickConfig` повертає тонке value-object з findFirst на settings/config. Викликається з useEffect `[]` у вкладці (Calendar/Dashboard/PriceListPicker) → DB hit на КОЖЕН mount. Sibling (`getOrganisationSettings`, `getBranchSettings`) мають Redis cache 300s з invalidation, але новий naked («він же тонкий»).
**Grep:** `async get\w+\(orgId.*\): Promise<\{[^}]*Hour\|Days\|Mode\|Enabled` БЕЗ `redis\.get` поряд + `private readonly redis` у constructor. Підтверджуючий: у `updateBranchSettings`/`updateOrganisationSettings` є `invalidate*Cache()`, але нових не додавалось.
**Причина:** copy findFirst з sibling, але `try { redis.get } catch {}` виглядає boilerplate, пропущена. Endpoint «дешевий» — але тригериться 5-20 раз/сесію (tab toggle, modal re-open, nav back/forward).
**Фікс:** (1) cacheKey + TTL (`WORK_HOURS_TTL = 60`, коротший бо quick-change); (2) `try { cached = redis.get(key); if (cached) return JSON.parse } catch {}` → query → `try { redis.set(key, ..., 'EX', TTL) } catch {}`; (3) `invalidateXCache(orgId)`; (4) у update — conditional invalidation ТІЛЬКИ коли relevant fields (workStartTime/End) змінились; (5) cache scope (orgId vs orgId+branchId) = actual scope.
**Impact:** Calendar mount: findFirst з nested orderBy → Redis GET. Per 60s: 1 DB hit замість 5-20.
**Де шукати ще:** settings/config service (settings.service, app-config.service, infrastructure.service) з тонкими getter-ами — UI-features, dashboard-config, quick-stats, notification-defaults, theme-config, default-warehouse.

### 2026-06-16 — Nested loop `outerList.find(o => innerList.some(i => i.fkField === o.id && intervalOverlap(i, slot)))` у hot-path availability/conflict — bucket inner list by FK у Map один раз + pre-parse Date→Ms

**Сигнал:** service-метод (booking.getAvailability, calendar conflict-check, scheduling) генерує candidate windows і для КОЖНОГО `outerArr.find(outer => !innerArr.some(inner => inner.fk === outer.id && new Date(inner.startAt) < window.end && new Date(inner.endAt) > window.start))`. Frontend: `bookings.map(b => lifts.find(lift => !calSlots.some(s => s.liftId === lift.id && ...)))`. Outer T=20-50 × inner N=5-50 × M=100-500 = T×N×M + `new Date()` alloc-heavy.
**Grep:** `\.find\([^)]+=>\s*!\w+\.some\(` АБО `\.find\([^)]+=>\s*\w+\.some\([^)]+\w+Id === \w+\.id[\s\S]{0,200}new Date\(`
**Причина:** декларативно. Колекції малі у dev; production 50 lifts × 500 slots × 20 timeslots = 500_000 ops + 10_000 Date allocs.
**Фікс:** (1) bucket inner by FK у `Map<fkValue, []>` перед outer (O(M) setup, `if (!i.fk) continue`); (2) pre-parse Date→Ms під час bucket (`startMs: new Date(i.startAt).getTime()`); (3) у predicate замість `.some()` — explicit for-loop з числовим порівнянням (`busy = bucketByFk.get(outer.id); for (const p of busy) if (p.startMs < windowEndMs && p.endMs > windowStartMs) return false`). O(T×N×avg(M/N)) + 0 Date allocs.
**Impact:** 50 lifts × 500 slots × 20 timeslots: ~500_000 ops + ~10_000 allocs → ~10_000 ops + ~1000 (50× CPU, 10× GC).
**Де шукати ще:** scheduling/availability/conflict — calendar slot conflicts, booking free-resource, inventory FIFO/LIFO з overlapping reservations, settlements period overlap, pricing overlapping ranges. Frontend: useMemo filtered subset де outer.map → inner.find/.some з FK.

### 2026-06-16 — `useMemo<T[]>(() => [], [])` всередині компонента для stable-empty-array placeholder — module-level const замінює без зміни семантики

**Сигнал:** `const EMPTY_X = useMemo<X[]>(() => [], [])` (або `useMemo(() => new Map(), [])`) — empty-collection placeholder (`slotsByLift.get(id) ?? EMPTY_X`). useMemo `[]` стабільний між render-ами mount, але alloc новий `[]` на КОЖНОМУ mount.
**Grep:** `useMemo<\w+\[\]>\(\(\) => \[\], \[\]\)` АБО `useMemo\(\(\) => new (Map|Set)\(\), \[\]\)`
**Причина:** пам'ятають «literal `[]` у JSX → нова ref → memo скидається», тягнуть useMemo. Empty collection — стале значення; достатньо module-level const.
**Фікс:** `const EMPTY_BOOKINGS: BookingSlot[] = [];` на module-level, видалити useMemo. Не чіпати якщо нова empty-collection при умовах (dynamic-import/feature-flag).
**Impact:** -1 alloc + -1 hook slot на mount. Корисно у grids що re-mount (calendar toggle, modal).
**Де шукати ще:** `EMPTY_*`/`DEFAULT_*` через useMemo `[]` — calendar widgets, DetailPanel, EntityPickerField fallback, useReducer initial empties.

### 2026-06-15 — Collapsible-header `chips` inline IIFE `headerCollapsed ? [...].filter(Boolean) : []` у render — recompute на КОЖЕН keystroke у inner Input

**Сигнал:** form-modal (PO/SD/WO Create) з collapsible header + `headerChips` inline: `const headerChips = headerCollapsed ? [supplierDisplay, form.warehouseId ? warehouses.find(w => w.id === ...)?.name : null, contractNumber ? ...].filter(Boolean) : [];`. На КОЖЕН render (typing → setForm) масив пересоздається, `warehouses.find()` O(N), `.filter()` alloc.
**Grep:** `const \w+Chips = \w+Collapsed \?[\s\S]{0,400}\.find\([\s\S]{0,200}\.filter\(Boolean\)`
**Причина:** «chips — похідне від collapsed» виглядає inline. Не помічають що Inputs фірять setForm на keystroke → chips recompute → JSX-children identity-thrash.
**Фікс:** (1) reference-Map `warehouseById = useMemo(() => new Map(warehouses.map(w => [w.id, w])), [warehouses])`; (2) `useMemo` навколо headerChips з deps `[headerCollapsed, supplierDisplay, form.warehouseId, warehouseById, contractNumber]`.
**Impact:** typing у «Примітки» 20-50 keystrokes × 3 find + allocs → 250-300 wasted ops/сесію.
**Де шукати ще:** form-modal з collapsible header (WO, Invoice, Estimate, PO, SD, SR, BookingRequest); breadcrumb-strips, tag-displays, «Recent items».

### 2026-06-15 — Form/modal totals `reduce(...)` поза useMemo — викликається на КОЖЕН render навіть коли lines не змінились

**Сигнал:** form-modal з табличкою рядків має `const total = totalFromLines(lines);` АБО inline `lines.reduce(...)` без useMemo. Поряд controlled Inputs (notes/date) → setState на typing → total recompute O(N) навіть коли lines незмінні. PO CreateModal мав memo, SupplierReturn — НІ (copy-paste-evolve розрив).
**Grep:** `const total = \w+\(\w+\);$` АБО `const total = \w+\.reduce\([\s\S]{0,300}\);[\s\S]{0,100}return \(` (без useMemo між decl і use).
**Причина:** copy-paste; один отримав useMemo, інший inline.
**Фікс:** `const total = useMemo(() => totalFromLines(lines), [lines])`; якщо VAT/discount — single-pass `useMemo(() => { let total=0; let vat=0; for (const l of lines) {...}; return {total, vat}; }, [lines])`.
**Impact:** typing 30 keystrokes × 10 lines = 300 wasted ops; 100+ позицій → 3000.
**Де шукати ще:** парні modal copy-pasted: PO CreateModal ↔ SupplierReturn, Estimate ↔ Invoice, SD Create ↔ Receive, WO Create ↔ Edit.

### 2026-06-15 — Row-handler async `const X = async (item) => {...}` без useCallback у list-page → inline arrow `onClick={() => void markX(item)}` × 20 рядків

**Сигнал:** list-page з 5-10 row-handlers (`handleTransition`, `markDeleted`, `loadDetail`) як `const X = async (po) => {...}` БЕЗ useCallback. У `.map(po => <button onClick={() => void markDeleted(po)}>)` — inline arrow × 20 rows × render. Гальмує майбутнє memo(TableRow).
**Grep:** `const handle\w+ = async \([^)]+\) => \{` без useCallback + `onClick=\{\(\) => void handle\w+\(\w+\)\}` у `.map()`.
**Причина:** великі файли (300-1500 LOC); `const = async` менше boilerplate.
**Фікс:** useCallback з мінімальними deps `useCallback(async (po) => {...}, [confirm, queryClient])`. Для handler→handler порядок declaration (залежний перший). Якщо use `load` (recreated) — eslint-disable з коментарем. Стратегія: усі row-handlers одночасно, один pass.
**Impact:** stable onClick → майбутній memo(TableRow) без identity-thrash. Зараз ≈0мс, інвестиція.
**Де шукати ще:** усі list-page (catalog/inventory/WO/invoices/counterparties/employees).

### 2026-06-15 — Branching ternary `cond ? findFirst(validate-by-id) : findFirst(auto-pick-by-criteria)` всередині Promise.all — single optional FK з двома query shapes у одному слоті

**Сигнал:** create-сервіс приймає optional FK (contractId) з двома гілками ПІСЛЯ Promise.all основних guards: (A) `if (dto.X) findFirst({where:exact-id})` (validate), (B) `else findFirst({where:criteria, orderBy})` (auto-pick primary). Sequential if/else додає 1 RTT.
**Grep:** `let \w+Id = dto\.\w+Id \?\? null;[\s\S]{0,500}if \(\w+Id\) \{[\s\S]{0,300}findFirst[\s\S]{0,300}\} else \{[\s\S]{0,300}findFirst[\s\S]{0,300}orderBy`
**Причина:** лінійне «дано→validate, ні→auto-pick». Обидві гілки мають синхронно-доступні предикати (dto+scalars).
**Фікс:** (1) `const hasContractId = !!dto.X;` ДО Promise.all; (2) виlift тернарку у Promise.all `hasContractId ? findFirst(exact-id) : findFirst(criteria, orderBy)`; (3) post: `if (hasContractId && !contract) throw NotFound; const contractId = hasContractId ? (contract as {id:string}).id : (contract?.id ?? null)`.
**Impact:** PO create() 3 RTT → 2 RTT (33%).
**Де шукати ще:** create()/addX() з optional FK + auto-pick fallback (primary contract, default warehouse/branch/currency, primary employee/bank-account). Розширення «Auto-pick optional FK ПІСЛЯ parallel guards» на обидві гілки у тому слоті.

### 2026-06-15 — Sequential `findFirst (tenant guard) → create + update` де create і update пишуть у РІЗНІ таблиці але читають той entity.id — settlements/payments/balance триплет

**Сигнал:** сервіс (settlements.createTransaction, balance-mutate): `const account = await db.X.findFirst({tenant guard}); if (!account) throw; await db.Y.create({settlementAccountId: account.id}); await db.X.update({where:{id: account.id}, data:{balance:{increment: delta}}})`. Sequential create (event-log) + update (aggregate balance) — обидва читають `account.id`, РІЗНІ таблиці. Writes resolve concurrently на pinned tx connection.
**Grep:** `await \w+\.\w+\.findFirst[\s\S]{0,200}await \w+\.\w+\.create\([\s\S]{0,400}await \w+\.\w+\.update\(`
**Причина:** event-log «спочатку подія, потім баланс». Порядок не має значення (increment атомарний у $tx).
**Фікс:** (1) sync pre-compute (`balanceDelta` по type-enum) ДО $transaction (fail-fast); (2) findFirst sequential, потім `await Promise.all([X.create(...), X.update(...)])`; (3) `select: {id: true}`.
**Impact:** settlement.createTransaction на WO COMPLETED/invoice PAID/payment.create. 100 WO/day × ~4 → 400 RTT saved/day.
**Де шукати ще:** append-only event-log + aggregate-mutate: payment.create + invoice.balanceDue.decrement, stock-movement.create + stock-item.quantity.increment, audit-event.create + entity.update. ОБЕРЕЖНО коли create+update у ту саму таблицю (race) — завжди РІЗНІ таблиці.

### 2026-06-15 — Chunked bulk-update loop у $transaction де input plan МОЖЕ мати duplicate PK — Promise.all + Map-dedup last-wins

**Сигнал:** bulk-pricing/import (applyRule, applyPricing з PO/xlsx) будує `plan: {goodId, ...}[]`, потім `for (i += CHUNK) { $transaction(tx => for (const u of chunk) await tx.X.update({where: {id: u.goodId}})) }`. Disjoint PK → кандидат на Promise.all. АЛЕ коли ОДИН товар кілька разів (PO кілька ліній того goodId; xlsx multi-SKU→той good) — sequential мав last-write-wins; Promise.all на duplicate PK = race.
**Grep:** `for \(const \w+ of chunk\) \{[\s\S]{0,200}await tx\.\w+\.(update|updateMany)`
**Причина:** chunked bulk pattern; sequential «по одному» безпечно. Не задумувались чи входи унікальні.
**Фікс:** аналіз джерела plan ДО Promise.all: (1) unique PK (findMany.map, IDs з Set) → просто Promise.all; (2) МОЖЕ мати duplicate PK → `const deduped = Array.from(new Map(plan.map(u => [u.pkField, u])).values())` ДО Promise.all. priceHistory.createMany пише унікальні рядки.
**Impact:** chunk=100 × 10 → 1000 sequential await → 10 batches Promise.all.
**Де шукати ще:** chunked update loop у $transaction: pricing rules, list import, bulk discount, mass status change, cleanup workers. Увага коли plan з parent.lines (дублі) vs findMany (PK-unique).

### 2026-06-15 — Inventory-mutation helper + parent-line metadata update — sequential await пара у per-line $transaction loop де writes у РІЗНІ таблиці

**Сигнал:** service applies effect документу (PO receive, SD CONFIRMED, WO complete): `$transaction(tx => for (const line of doc.lines) { await inventory.createMovement(...); await tx.purchaseOrderLine.update({unitOfMeasureId, receivedQty: {increment}}) })`. createMovement пише у StockMovement/StockBatch/StockItem, parentLine.update у PurchaseOrderLine — НЕ перетинаються. Sequential × N. TRANSFER має 2 createMovement (writeoff→receipt, disjoint keys).
**Grep:** `for \(const \w+ of \w+\.lines\) \{[\s\S]{0,500}await this\.inventory\.createMovement[\s\S]{0,300}await tx\.\w+Line\.update`
**Причина:** helper «важкий» → sequential; parentLine.update «продовження». Реально writes у різні composite keys.
**Фікс:** `await Promise.all([inventory.createMovement(...), tx.parentLine.update(...)])`. Conditional UoM: `lineUnitId ? tx.parentLine.update(...) : Promise.resolve()`. TRANSFER: writeoff+receipt+UoM у Promise.all. Loop-carried (receivedAmount +=, results.push) post-await.
**Impact:** PO receive() 10 lines: 20 RTT → 10 (50%). SD CONFIRMED 5 lines: 10→5. TRANSFER: 15→5.
**Де шукати ще:** invoice payment apply (line-update + payment-create), credit note refund, WO complete (createMovement + part.update), PO receive (+settlement.createTransaction), credit-charge reversal.

### 2026-06-15 — N-FK guards у update() з conditional шляхами (if dto.X) — третій FK validation з cross-dependency на dto.supplierId/effective entity

**Сигнал:** update() з кількома optional FK (`dto.supplierId`, `dto.warehouseId`, `dto.contractId`). Три послідовних `if (dto.X) { const X = await findFirst({...}); if (!X) throw }`. Останній FK може мати cross-dependency `effectiveSupplierId = dto.supplierId ?? po.supplierId` — але це scalar lookup, НЕ блокування на попередній findFirst.
**Grep:** `update\(orgId.*dto.*\)[\s\S]{0,200}if \(dto\.\w+Id\) \{[\s\S]{0,300}findFirst[\s\S]{0,300}if \(dto\.\w+Id\) \{[\s\S]{0,300}findFirst`
**Причина:** «захищаємо кожен FK окремо». Cross-dependency `effectiveSupplierId` маскує що contract validation читає лише скаляр у scope.
**Фікс:** `effectiveXxxId = dto.xxxId ?? po.xxxId` синхронно ДО Promise.all. У Promise.all три тернарки `dto.X ? findFirst({...}) : Promise.resolve(null)`. ПІСЛЯ — `if (dto.X && !result) throw NotFound`.
**Impact:** update() supplier+warehouse+contract у одному PATCH: 3 RTT → 1 (67%).
**Де шукати ще:** invoice.update (counterpartyId+warehouseId+priceListId), workOrder.update (vehicleId+counterpartyId+contractId+liftId), stockDocument.update.

### 2026-06-14 — Detail-panel/Drawer/Modal будівник через IIFE у тілі parent list-page — tabs object identity рекреюється на КОЖЕН render

**Сигнал:** list-page з secondary panel + tabs у JSX через IIFE `(() => { const buildX = item => [...]; return <Panel tabs={selectedItem ? buildX(selectedItem) : undefined} configFields={schemaToConfigFields(...)} /> })()`. tabs+configFields пересоздаються на КОЖЕН render навіть коли selectedItem не мінявся. Якщо panel.useEffect deps містять onClose/tabs identity → re-fires → addEventListener/removeEventListener + Input focus скидається.
**Grep:** `\{\(\(\) =>` у JSX-тілі >300 LoC компонентів поряд з `<DetailPanel|<Modal|<Drawer|<SlidePanel`.
**Причина:** inline закриття дає доступ до state без props drilling. IIFE «нічого не коштує», але tabs.content має controlled `<Input onChange={inline arrow}>` → каскад re-render.
**Фікс:** (1) memo-компонент `XDetailPanel` на module-level з explicit props (selectedItem, editingX, onCloseX, onSaveX, panelConfig); (2) всередині `const tabs = useMemo(() => {...}, [selectedItem, editingX, ...])`, configFields теж useMemo; (3) parent handlers через useCallback. panelConfig type — `ReturnType<typeof useDetailPanelConfig>`.
**Impact:** typing у parent debounce → tabs identity stable → Input focus не зривається.
**Де шукати ще:** list-page з DetailPanel/Drawer/Modal inline (counterparties, WO, invoices, PO, SD).

### 2026-06-14 — Новий list/report endpoint з date sort без covering index — `findMany({orderBy: createdAt, take})` seqscan коли existing index не покриває WHERE

**Сигнал:** новий endpoint робить `findMany({where: {orgId, [optionalCol1], [createdAt range]}, orderBy: {createdAt}, take: N})` на append-only (StockMovement, AuditLog, Notification, BatchConsumption). Existing `(orgId, warehouseId, createdAt)`, але новий WHERE more permissive (warehouseId optional). warehouseId IS NULL → index не вибирається → seqscan + external sort.
**Grep:** `findMany.*orderBy.*createdAt` + `take: \d{3,}` + `grep "@@index" packages/database/prisma/schema.prisma`. Якщо найкращий index має >1 col перед `createdAt` що query не фільтрує — гап.
**Причина:** старі індекси під старі endpoint-и; новий звітний з ширшою area.
**Фікс:** covering `@@index([orgId, sortKey])` для unfiltered + `@@index([orgId, optionalCol, sortKey])` для типового фільтру. Не плодити надлишкові (PG бере prefix). Commit з explain trace.
**Impact:** take:3000 на 100k-500k рядків: seqscan ~150-300мс → index scan ~5-15мс.
**Де шукати ще:** після нового report/list на append-only (StockMovement, AuditLog, BatchConsumption, Notification, WorkOrderStatusLog).

### 2026-06-14 — Sequential `await tx.X.update(...); await tx.Y.create(...)` у loop-карриджних батч-операціях — Promise.all всередині ітерації без злому loop-carried стану

**Сигнал:** `for (const x of batches) { await db.X.update(...); await db.Y.create(...); remaining -= take; }` — два writes на ітерацію не залежать (update на batchId, create batchConsumption), але loop-carried (`remaining`) сериальний.
**Grep:** `for \(const .* of .*\)\s*\{[\s\S]{0,300}await .*\.\w+\.update[\s\S]{0,200}await .*\.\w+\.create`
**Причина:** «update partition, потім create record»; результат update нікуди не йде.
**Фікс:** `await Promise.all([db.X.update({...}), db.Y.create({...})])` (race-safe, різні таблиці). Loop-carried post-await. Той для `findFirst → update + create` де update+create залежать лише від `.id`.
**Impact:** consumeBatch 5 partitions: 10 RTT → 5 (50%). returnToBatch 10 parts → 10 RTT.
**Де шукати ще:** batch-consume/release/return у inventory/batch/work-orders.service; settlement reconciliation, invoice payment apply.

### 2026-06-12 — Disjoint-set `tx.X.updateMany()` pairs всередині `$transaction` — Promise.all замість sequential await

**Сигнал:** sync/refresh/cascade у `$transaction` робить 2+ послідовні `await tx.X.updateMany({where:A})` потім `await tx.X.updateMany({where:B})` де A і B DISJOINT (children `parentSlotId: {not: null}` vs parent `parentSlotId: null`). Sequential = 2 RTT.
**Grep:** `await tx\.\w+\.updateMany[\s\S]{0,300}await tx\.\w+\.updateMany`
**Причина:** «soft-delete A, потім update B»; updateMany виглядає «небезпечніше» за розноску у Promise.all.
**Фікс:** `const [, r2] = await Promise.all([tx.X.updateMany({where:A}), tx.X.updateMany({where:B})])`. Prisma parallel у interactive tx на одну connection. Race-safe (WHERE disjoint). Той для tenant-guard + parentSlot lookup у tx.
**Impact:** sync ~30% швидші (2 RTT → 1). 100-RPS: ~50ms savings.
**Де шукати ще:** cascade-update/sync/refresh/propagate/`markAsX`; bulk soft-delete після transition; refresh-totals helpers.

### 2026-06-12 — `kyivToday()`/date helper всередині render `.map()` callback — lift у useMemo на рівень компонента

**Сигнал:** `array.map(item => { const todayKyiv = kyivToday(); const isOverdue = item.date < todayKyiv; ... })` — `kyivToday()` (`new Date() + Intl.format()`) у тілі `.map()`. 8-row → 8× per render.
**Grep:** `\.map\([^)]*=>\s*\{[^}]*kyivToday\(\)|\.map\([^)]*=>\s*\{[^}]*Date\.now\(\)`
**Причина:** kyivToday() виглядає константою; ставлять у map-body.
**Фікс:** `const todayKyiv = useMemo(() => kyivToday(), [])` над JSX (deps `[]` + eslint-disable з коментарем mount-stable). Auto-refresh → useState + useEffect interval. Fix pure-render (race з timer).
**Impact:** 8-row dashboard: 8× → 1×. Для high-render-frequency (15s polling, table cells).
**Де шукати ще:** date-helper з `new Date()` — kyivNow, kyivToday, isoToday, todayMs; `Date.now()`, `new Date()` direct; reports/audit lists з `item.date < today`. Той для `formatXyz` з Intl singleton.

### 2026-06-11 — Dead `Object.keys(MAP)[0]` / `Object.keys(MAP)` в IIFE-render — module-level frozen `*_ORDER` const

**Сигнал:** компонент-форма має `const initialStatus = Object.keys(STATUS_LABELS)[0] ?? 'DRAFT'` (раз на рендер) АБО IIFE-pattern `{(() => { const statusOrder = Object.keys(STATUS_LABELS); const curIdx =...
**Grep:** `Object\.keys\(\w+\_LABELS\)|Object\.keys\(.*\_MAP\)|Object\.keys\(._STATUS._\)`**Фікс:** module-level`const X_ORDER: readonly string[] = Object.freeze(Object.keys(X_LABELS))`поза компонентом. Імпорт у IIFE замість recompute.`[...arr].reverse().find(...)` patterns переписати як reverse...

### 2026-06-11 — Inline status-list literals `['DRAFT', 'X', 'Y'].includes(v)` у render path — module-level frozen sets

**Сигнал:** компонент має `const canX = status === 'A' || status === 'B'` АБО `const canY = isMode && ['DRAFT', 'ESTIMATE', 'APPROVED'].includes(currentStatus)` всередині render body. На КОЖЕН render створюється...
**Grep:** `\['[A-Z_]+'(,\s*'[A-Z_]+')+\]\.includes\(`
**Фікс:** module-level `const EDITABLE_STATUSES = Object.freeze(['DRAFT', 'ESTIMATE', 'APPROVED'] as const)`. У render: `(EDITABLE_STATUSES as readonly string[]).includes(currentStatus)`. Якщо backend має той...

### 2026-06-11 — Race-window guard через двошарову state (useRef + useState) — wrapper-setters замість додавання state у useCallback deps

**Сигнал:** modal/dialog має guard у `onClose`/`handleClose`: `if (saving || transitioning) return` — щоб НЕ закривати під час pending POST. Коли guard читає `saving` через React closure у `useCallback([saving,...
**Фікс:** пара `const xRef = useRef(false); const [x, setX] = useState(false);`+ wrapper-setter`const setXBoth = useCallback((v: boolean) => { xRef.current = v; setX(v); }, [])`. Кожен виклик...

### 2026-06-11 — Twin-scan `reduce()` у tfoot/footer для VAT + total — single-pass useMemo з двома акумуляторами

**Сигнал:** modal/form з таблицею редагування рядків (lines/parts/items) має `<tfoot>` який рендерить підсумок VAT + total. Розробник пише два окремих `lines.reduce(...)` блоки (один для VAT, один для total) у...
**Grep:** `\.reduce\(.*\n.*\.reduce\(`
**Фікс:** один `useMemo(() => { let total = 0; let vat = 0; for (const l of lines) { const h = toNumberOrUndefined(...); ...; if (vatRate > 0) vat += sum * vatRate / 100; } return { total, vat }; }, [lines,...

### 2026-06-11 — Per-row `array.find(x => x.id === row.foreignKey)` у `.map()` і onChange — O(N×M) → useMemo Map.get O(1)

**Сигнал:** компонент має reference-data масиви (employees/warehouses/units/branches/lifts/vehicles) у стейті або prop, і у `lines.map(line => { const emp = employees.find(e => e.id === line.employeeId); ... })`...
**Grep:** `\.find\(.*=>.*\.id\s*===`
**Фікс:** для кожного reference-data масиву — `const xById = useMemo(() => { const m = new Map<string, X>(); for (const x of xArray) m.set(x.id, x); return m; }, [xArray])`. У map / onChange:...

### 2026-06-10 — Overfetch `include: { childRel: take:1000 }` у FSM transition/guard методах де child-rel не читається у тілі — "повний WO для side-effects" що re-fetch внутрішньо

**Сигнал:** FSM/transition метод починається з `findFirst({ include: { childRel: { where: { deletedAt: null }, take: N } } })` де childRel — one-to-many (parts, lines, items, allocations) на...
**Grep:** `wo\.`
**Фікс:** замінити `include: {childRel}` на `select: {...scalar fields actually used...}`. Перерахувати точний набір через grep `wo\.` у тілі. Залишити лише ID/scalar/FK що читаються....

### 2026-06-10 — Inline arrow handlers у row-репитері list-page (status pills, tabs, filter chips) — кліку-кнопки у `.map()` без memo-component

**Сигнал:** list-page має константу типу `STATUS_TABS = [...]` (10-20) і у JSX рендерить через `.map(([v, l]) => <button onClick={() => { setX(v); resetPage(); ... }} className={cn(...)}>{l}</button>)`...
**Фікс:** виокремити module-level memo-component `const StatusPill = memo(function StatusPill({ value, label, active, description, onSelect }: Props) { return description ? <Tooltip>{btn}</Tooltip> : btn })`....

### 2026-06-10 — IIFE `(() => { const builder = ...; return <X tabs={builder(selectedItem)} /> })()` у тілі return батьківського компонента — DetailPanel/Drawer/Modal tabs побудова у render

**Сигнал:** у JSX батьківського компонента (list-page, dashboard, settings) є блок `{(() => { const buildTabs = (item) => [...]; return <Panel tabs={selectedItem ? buildTabs(selectedItem) : undefined} /> })()` —...
**Grep:** `\{\(\(\) =>`
**Фікс:** двофазний refactor: (1) Lift inner function body у `useMemo(() => { if (!selectedItem) return undefined; const item = selectedItem; return [...tabs...]; }, [selectedItem, ...deps])`. Параметер...

### 2026-06-10 — `.some()` + `.filter().map().join()` twin-scan derived string у warning/badge UI — conflict slots, error chips, batch summary

**Сигнал:** UI рендерить попередження/підсумок з derived string з масиву: `{calConflict.conflictSlots.length} слотом(и) {calConflict.conflictSlots.some(s => s.workOrderNumber) && (<>...
**Grep:** `\.some\(._=>._\)\s*(&&|\?)`**Фікс:** useMemo single-pass:`const derived = useMemo(() => { const result: string[] = []; for (const s of array ?? []) { if (s.predicate) result.push(s.field); } return result.join(', '); }, [array])`. Деps...

### 2026-06-10 — Inline React component declared inside parent component body — sidebar/shell/layout композити з вкладеними NavLink/Row/Cell

**Сигнал:** усередині функції-компонента (особливо великих `Shell`/`Layout`/`Wizard`) оголошений локальний підкомпонент через `const NavLink = ({ item }) => (...)` або `function Row(props) { return...
**Фікс:** дві стратегії: **(A) render-helper** — перейменувати на `renderNavLink(item, opts?)`і кликати як **function call**`{renderNavLink(item)}` замість JSX-element. React тоді...

### 2026-06-10 — React Context Provider value object без useMemo — providers що тримають частину state у useState + частину callbacks у useCallback

**Сигнал:** Provider рендерить `<XContext.Provider value={{ state1, state2, callback1, callback2 }}>` — об'єкт-літерал inline у JSX. `state1`/`state2` живуть у useState (стабільні поки не змінюються),...
**Фікс:** обгорнути value у `useMemo(() => ({ state1, state2, callback1, callback2 }), [state1, state2, callback1, callback2])`. callback-и у deps безпечні бо стабільні через useCallback. Якщо у Provider...

### 2026-06-10 — Multiple mount-only useEffect з `[]` deps у одному компоненті — localStorage seeding/window event setup розпорошений по 3+ ефектах

**Сигнал:** великий компонент (Shell/Page/Layout) має 3+ окремих `useEffect(() => {...}, [])` що всі виконуються ОДИН раз при mount. Типово: `localStorage.getItem(KEY1)` + `setStateFromSaved`,...
**Фікс:** об'єднати в один `useEffect(() => { /* all mount-only logic */; return () => { /* cleanups */ } }, [])`. Зберегти `try/catch` навколо кожного localStorage read (один впав не зупиняє інших)....

### 2026-06-10 — `findMany({where: {id: {in:[...]}, take})` для FK-existence замість `count()` — services/validators bulk-FK guard

**Сигнал:** Backend service (типу `create`/`update` що приймає DTO з масивом FK — `dto.works[]`, `dto.goods[]`, `dto.serviceIds[]`) валідує IDs через `findMany({ where: { id: { in: ids },...
**Фікс:** замінити `tx.X.findMany({...})`на`tx.X.count({where})`. Постгрес виконає `COUNT(*) WHERE...`що при composite index`(orgId, id)` дає index-only scan (vs full row...

### 2026-06-10 — Redundant @@index([orgId]) поверх @@unique([orgId, X]) — reference моделі з composite unique key

**Сигнал:** модель Prisma має `@@unique([orgId, X])` (де X = code/rate/eventType+channel/key+...) і
**Фікс:** видалити `@@index` (НЕ `@@unique` — він несе constraint-семантику). Залишити коментар над `@@unique` чому окремий `@@index` не потрібен. `prisma db push...

### 2026-06-10 — Cycle-N gap у дубльованих файлах з однією назвою — settings/PaymentsTab vs ndi/PaymentsTab

**Сигнал:** у різних роутах (`apps/web/src/app/(app)/settings/X.tsx` і `apps/web/src/app/(app)/ndi/X.tsx`) існують
**Фікс:** застосувати ТОЙ самий patтерн (Promise.allSettled, etc.) до sibling-файлу. У commit-message «cycle-N gap — pattern applied to sibling X.tsx». Якщо файли семантично дублікати (один і той...

### 2026-06-10 — Frontend для-await POST у "Import from templates" handlers — bulk-create незалежних reference rows із серійним RTT

**Сигнал:** UI sub-tab (PaymentsTab/CurrenciesTab/UnitsTab/reference-CRUD з "Додати з шаблону") має handler `importFromTemplates(templates)` що ітерує `for (const t of templates) {...
**Grep:** `for \(const \w+ of templates\)`**Фікс:**`Promise.allSettled(templates.map(t => apiFetch(POST, body)))`→ iterate results:`for (const r of results) { if (r.status === 'fulfilled') created.push(r.value) }`. Batch state update в кінці:...

### 2026-06-10 — Duplicate getCached() у парних useState lazy initializers — composable hooks з data+loading pair

**Сигнал:** composable hook (`useCachedRefData`, `useSavedFilters`, `useCachedQuery`): `const [data, setData] = useState<T>(() => getCached<T>(key) ?? fallback); const [loading, setLoading] =...
**Фікс:** `const initialCacheRef = useRef<T | null | undefined>(undefined); const readOnce = (): T | null => { if (initialCacheRef.current === undefined) initialCacheRef.current = getCached<T>(key); return...

### 2026-06-10 — Static toolbar comparison `JSON.stringify(CONSTANTS.map(c => c.key))` у render path — column-config hasCustomization check

**Сигнал:** list-page toolbar (`work-orders/page.tsx`, `invoices/page.tsx`, ... 9 файлів) має `ColumnsDropdown hasCustomization={JSON.stringify(order) !== JSON.stringify(CONSTANTS.map(c => c.key)) || ...}`....
**Grep:** `JSON\.stringify\([^)]*\.map\(`
**Фікс:** двофазний refactor: (1) **лифт CONSTANTS** з useMemo (або in-component) до module-level — `const WO_COLUMNS: Array<{ key: string; label: string; defaultVisible?: boolean }> = [...]`. **Тип явно**, не...

### 2026-06-10 — Sequential conflict checks всередині $transaction для disjoint-where queries у одній таблиці

**Сигнал:** service метод (`calendar.createSlot`, `calendar.updateSlot`) всередині `await this.prisma.$transaction(async tx => { ... })` робить кілька
**Фікс:** обернути конфлікт-перевірки у `const [conflict, empConflict] = await Promise.all([cond1 ? tx.X.findFirst({where:..., select:{id:true}}) : Promise.resolve(null), cond2 ? tx.X.findFirst({where:...,...

### 2026-06-10 — Per-item `$transaction(callback, { timeout })` у row-importer циклах — bulk import окрема транзакція для КОЖНОГО рядка

**Сигнал:** import-метод (`xlsx.applyPricingFromList`, `xlsx.importX`, bulk CRUD imports) має для кожного row окремий `await this.prisma.$transaction(async tx => { ...mutation +...
**Grep:** `for \(const \w+ of \w+\) \{[\s\S]{0,500}await this\.prisma\.\$transaction\(`**Фікс:** двофазний refactor: (1) **plan phase** — у циклі зібрати масив`Plan[]` (`{ id, ...changes }`) у пам'яті, без mutations. Filter early-skip (no change, validation failures) у...

### 2026-06-10 — Sequential update/create per-row у post-prefetch row-importer — bulk import де prefetch усуває N+1 reads, але writes sequential

**Сигнал:** import-метод робить bulk prefetch (`goodsByKey`, `existingByGoodId` map) ДО циклу (видалено read N+1). Але всередині `for (const row of rows)` тіло все одно робить `if (existingId)...
**Grep:** `for \(const \w+ of \w+\) \{[\s\S]{0,300}existingByGoodId\.get|existingById\.get|await this\.prisma\.\w+\.update[\s\S]{0,200}await this\.prisma\.\w+\.create`**Фікс:** трифазний refactor: (1) **plan phase** —`updatesPlan: {id, ...changes, label}[]`+`createsPlan: Prisma.XCreateManyInput[]`+`seenGoodIds: Set<string>` для dedup. У циклі: dup check, FK resolve,...

### 2026-06-09 — Коментар обіцяє «RepeatableRead/Serializable» але `$transaction(callback, { timeout })` лишається default ReadCommitted — refresh/update методи що переписують агрегатні стани

**Сигнал:** усередині service-методу `await this.prisma.$transaction(async tx => { ... }, { timeout: N })` БЕЗ `isolationLevel`. У коментарях вище — фраза «inside tx (RepeatableRead) to prevent...
**Grep:** `\$transaction\b`
**Фікс:** (1) bump до `isolationLevel: 'Serializable'`; (2) inner re-check критичного інваріанту (status, existence, deletedAt:null) усередині $tx з `select: { ...тільки потрібне }` — двопоясна страховка:...

### 2026-06-09 — Reverse-FK index miss на `(orgId, parentFK, deletedAt[, sortKey])` — list/groupBy endpoints що фільтрують дочірні документи по батьківському FK

**Сигнал:** новий feature додає cross-aggregate query на дочірній таблиці (Invoice/CalendarSlot/Warranty/Payment) фільтруючи по FK на батьківську сутність (workOrderId, counterpartyId, etc.) + tenant guard...
**Фікс:** covering `@@index([orgId, parentFK, deletedAt, sortKey])` де `sortKey` — orderBy колонка (createdAt/startAt/documentDate). Sort key потрібен якщо endpoint має `orderBy` — інакше...

### 2026-06-09 — Manual padStart/concat date formatter як локальна функція — фронт-сторінки де `fmtDate` уже імпортовано

**Сигнал:** на сторінці локальна `function formatDate(iso: string): string { const d = new Date(iso); const day = String(d.getDate()).padStart(2, '0'); const month = String(d.getMonth() +...
**Grep:** `function formatDate\|const formatDate = \|function fmtDt\|function fmtDate `**Фікс:** замінити тіло на`return fmtDate(iso);`— проксі-патерн (як`fmt() = fmtMoney(Number(n))` для LinkedDocumentsPanel). Сигнатура збережена, call-sites не торкаються....

### 2026-06-09 — Auto-pick/auto-select optional FK резолюція ПІСЛЯ parallel FK guards — sequential гілка `if (dto.X) validate; else autoSelect` на create-методах

**Сигнал:** create-метод починається з `Promise.all([fk1, fk2, fk3, fk4])` для tenant-validation FK (branch/vehicle/counterparty/lift), потім послідовний `if (dto.contractId) { provided = await...
**Фікс:** замість `if/else`блоку з двома послідовними`await findFirst`— додати n+1-й елемент у Promise.all:`dto.xId ? prisma.X.findFirst({where composite}) : prisma.X.findFirst({where autoPickKey,...

### 2026-06-09 — Sequential per-item idempotent service.create() у scheduler/job — multi-tenant bootstrap fetchers

**Сигнал:** scheduler/job (nbu-fetch, daily-rate-sync, bulk-import) ітерує колекцію (currencies/orgs/templates) через `for (const x of list) { await this.someService.create(orgId, ...) }`. Кожна...
**Grep:** `for \(const \w+ of \w+\)`
**Фікс:** `const results = await Promise.allSettled(list.map(async x => { ...body... return { ok, code, reason } }));` потім `for (const r of results) { if (r.status === 'fulfilled' && r.value.ok) fetched++;...

### 2026-06-09 — `findOne(dto) + secondary findFirst` partial-overlap pattern — PDF/export endpoints

**Сигнал:** export-endpoint (generatePdf/generateXlsx/exportReport): (1) `const dto = await this.findOne(orgId, id)` — публічний getter повертає DTO з частковим включенням relations,...
**Фікс:** inline'ити повний read всередину generatePdf — БЕЗ findOne — з extended `select`/`include` що покриває ВСІ поля для PDF (включно з phone/address). Promise.all з другим незалежним read...

### 2026-06-08 — Redundant @@index([X]) поверх @@unique([X]) — Prisma schema моделі з композитним unique-ключем

**Сигнал:** модель має одночасно `@@unique([orgId, email])` і `@@index([orgId, email])` — однакові колонки в однаковому порядку. У `pg_indexes` два B-tree на...
**Фікс:** видалити `@@index` (НЕ `@@unique`). У DB `DROP INDEX IF EXISTS "X_col1_col2_idx"` напряму (швидка операція, не вимагає міграції файлу — Prisma не...

### 2026-06-08 — Scroll/resize listeners без `passive:true` у portal-dropdown компонентах — datetime/date pickers, tooltip позиціонери, sticky popovers

**Сигнал:** portal-rendered dropdown (date picker, autocomplete, tooltip) має `useEffect` що `window.addEventListener('scroll', handler, true)` для repositioning через `getBoundingClientRect`....
**Grep:** `addEventListener\(['"]scroll['"]\s*,\s*\w+\s*,\s*(true|false)\b`
**Фікс:** замінити третій аргумент на `{ capture: true, passive: true }` (зберегти capture якщо був). У `removeEventListener` та сама options object (capture повинен матчитись)....

### 2026-06-08 — memo() без stable handler refs — list-item рендерери у формах з частим typing

**Сигнал:** компонент-список елементів (checkbox-list, item-grid, row-list) обгорнутий у `React.memo()`, але батько передає `onChange={ids => { setX(ids); doY(); }}` — inline arrow на кожен...
**Фікс:** перетворити inline handlers на `useCallback`. Якщо handler читає state через сетер (`setX(ids)`) → setX стабільний → deps порожні. Якщо handler читає state value → useRef +...

### 2026-06-05 — Status-guarded soft-delete з sequential findFirst + update — invoices/PO/SD/WO remove()

**Сигнал:** `remove()` має business-rule guard через статус: `findFirst({ where: { id, orgId, deletedAt: null } })` повертає
**Фікс:** **двоступінчатий race-safe patern**: (1) `findFirst({ where: { id, orgId, deletedAt: null }, select: { status: true } })` — narrow, для status guard; (2) `if (!doc) throw NotFound; if (doc.status !==...

### 2026-06-05 — FK guard без narrow projection у Promise.all FK validation — будь-який create/update що валідує >1 FK

**Сигнал:** `Promise.all` з 2-5 паралельних `findFirst({ where: { id: dto.xId, orgId, deletedAt: null } })` для FK validation — БЕЗ `select: { id: true }`. Кожен тягне ВЕСЬ запис цільової...
**Grep:** `findFirst({ where: { id: dto\.`
**Фікс:** для кожного FK guard у Promise.all додати `select: { id: true }`. Якщо одне поле потрібне (`existing.shortName` для post-filter у units.update) — `select: { id: true, shortName: true }`....

### 2026-06-05 — Static tab/option arrays оголошені у тілі компонента — view switchers, period selectors, tab definitions

**Сигнал:** усередині функції-компонента статичний масив: `const TABS: { key, label }[] = [...]` або inline JSX `{[['day', 'День', Icon], ['month', 'Місяць',...
**Фікс:** підняти на module-level як `const X = [...] as const`(для tuple-arrays —`ReadonlyArray<readonly [...]>`). Icon components з lucide-react — pure refs, безпечно capture-ити....

### 2026-06-05 — Detail-в-list × DetailPanel — list endpoint тягне повну дочірню колекцію, хоча UI рендерить її ЛИШЕ для ОДНОГО вибраного row

**Сигнал:** list-endpoint містить `include: { lines/parts/children: { take: 1000, include: {...}}}` для O(20) rows. На фронті UI використовує це у ДВОХ місцях: (1) у table-cell — тільки...
**Фікс:** на backend — замінити `include: { X: { take: N, include: {...}}}` на `_count: { select: { X: { where: { deletedAt: null }}}}` + додати `linesCount?: number` у DTO; у `toDto` — fallback `doc._count?.X...

### 2026-06-05 — Cycle-N gap у міграції паттерну: один сервіс випав із попереднього аудиту, бо grep був неповний

**Сигнал:** новий аудит знаходить ВЖЕ-описаний у "Накопичених підходах" паттерн у конкретному сервісі (X.service.ts), хоча минулий аудит явно фіксав цей паттерн у 7-8 інших. Перевіряєш — так, цей файл...
**Фікс:** застосувати той самий fix-pattern. Зазначити у commit «cycle-N gap — pattern from <prev cycle>». У MemoryManual.md — рядок «Verified non-issues» НЕ...

### 2026-06-05 — Frontend N+1 через per-item GET у nested fetch loop — детальні сторінки що завантажують вкладену колекцію per-row

**Сигнал:** detail-сторінка (`/X/[id]/PageClient.tsx`) має 2-stage fetch — stage 1 завантажує колекцію parents (garages, vehicles, items), stage 2 робить `Promise.all(parents.map(p => apiFetch('/child?parentId='...
**Фікс:** на backend — CSV-параметр `?xIds=`+ parse →`vehicleId: { in: ids }`у where; cap 200 IDs + take 500. Frontend —`apiFetch(\`${url}?xIds=${ids.join(',')}\`)` ОДИН раз. Тип...

### 2026-06-06 — Bulk-filter через GRANDPARENT-relation замість CSV IDs — коли intermediate-FK list (garages, branches) суто проміжний

**Сигнал:** Frontend має триступеневу ієрархію: grandparent (counterparty) → parent (garage) → child (vehicle). API має filter `?parentId=X` (single FK). Frontend робить waterfall: `GET...
**Фікс:** на backend — у child controller `@Query('grandparentId')` (`?counterpartyId=`). У service: `where: { ..., parent: { grandparentId, orgId, deletedAt: null } }` — Prisma nested...

### 2026-06-05 — Bootstrap scheduler з per-org secondary fetch — onModuleInit/cron-init що читає settings/config окремо для кожної org

**Сигнал:** scheduler (`OnModuleInit`) робить `Promise.all(orgs.map(org => this.scheduleForOrg(org.id)))` де `scheduleForOrg` починається з `await prisma.organisationSettings.findUnique({ where: {...
**Фікс:** на onModuleInit — prefetch ВСІХ settings одним `findMany({ select: { orgId, X } })`→ Map<orgId, X>. Helper розбити: public`scheduleForOrg(orgId)` (single-use, тягне settings всередині) +...

### 2026-06-10 — `data: X = {}` destructure default у useQuery — Bug #328 cascade для object literals (не лише arrays)

**Сигнал:** компонент `const { data: linkedCounts = {} } = useQuery<Map>(...)` — fallback empty object при initial-load. Pattern «Fresh `[]` literal у `data?.items ?? []`» уже...
**Grep:** `useQuery.*\n.*data: \w+ = \{\}`
**Фікс:** module-level `const EMPTY_X: T = Object.freeze({}) as T` поза функцією-компонентом. Cast потрібен бо TypeScript не дозволяє `Readonly<{}>` присвоювати до mutable map — runtime семантика...

### 2026-06-05 — Per-render `getCached()`/sessionStorage read — composable hook без lazy state initializer

**Сигнал:** composable hook (`useCachedRefData`) робить `const cached = getCached(cacheKey)` як
**Фікс:** `const [state, setState] = useState<T>(() => getCached<T>(cacheKey) ?? fallback)`. Парні `useState` що залежать від того самого read — переписати кожен як окремий lazy initializer....

### 2026-06-04 — BullMQ processor без `concurrency` — I/O-bound job processors з external HTTP calls

**Сигнал:** `@Processor('queue-name')` + `@Process('job-name')` без `concurrency`. За замовчуванням `@nestjs/bull` обробляє 1 job одночасно. Якщо кожен job — окремий зовнішній HTTP виклик з...
**Grep:** `@Process(`
**Фікс:** `@Process({ name: 'job-name', concurrency: N })`. N = кількість одночасних HTTP connections безпечна для провайдера. Значення: webhook delivery: 5; SMS TurboSMS: 3...

### 2026-06-04 — Shared config fetched per-recipient in N-to-1 broadcast processor — batch notification dispatchers

**Сигнал:** BullMQ processor (або scheduled job) будує список N recipients і для кожного `service.send(orgId, recipientId, event, payload)`, де `send()` всередині тягне
**Фікс:** розбити `sendX()` на (1) `resolveConfig(orgId, branchId, event): Config | null` (async, DB reads) + (2) `sendWithConfig(orgId, recipient, config, vars)` (async, лише queue.add без DB). Processor:...

### 2026-06-03 — Fresh `[]` literal у `data?.items ?? []` → useEffect([items]) фаєрить кожен рендер — Bug-#328 cascade pattern

**Сигнал:** list читає React Query result як `const orders = queryData?.items ?? []` або `const { data: list = [] } = useX()`. Далі `useBulkSelect(orders)` або інший hook з...
**Фікс:** у hook що повертає paginated дані експортувати module-level `export const EMPTY_ITEMS: readonly never[] = Object.freeze([])`. Call-sites → `data?.items ?? (EMPTY_ITEMS as unknown as...

### 2026-06-03 — Bug fix у hook не пропагований на call-sites — `useListPage` приклад

**Сигнал:** comprehensive QA знаходить regression bug (Bug #328: fresh `[]` → useEffect race), виправляє у новому композитному hook (`useListPage`), додає regression test. Але call-sites не...
**Фікс:** опція А — export shared primitive (`EMPTY_ITEMS`, `STABLE_FALLBACK`) з hook; call-sites імпортують до повної міграції. Опція Б — мігрувати негайно (якщо...

### 2026-06-03 — Limit cap на endpoints що приймають user-controlled pagination — DoS hardening для `?limit=999999`

**Сигнал:** controller `@Query('limit') limit = '20'` → service як `+limit` без cap. Service `findMany({ take: limit })`. Захист на limit тільки у деяких endpoints...
**Фікс:** на початку service findAll: `const safeLimit = Math.min(Math.max(limit, 1), 200); limit = safeLimit;`. Опціонально `page = Math.max(page, 1)`. 200 — типовий cap для list...

### 2026-06-03 — Optional guard блокує main aggregation у reports — sequential branch/employee/warehouse findFirst перед raw SQL

**Сигнал:** report-метод (revenue, workOrders, stock, load, profitability) починається з `if (branchId) { const branch = await this.prisma.X.findFirst(...); if (!branch) throw }`, потім тяжкий `$queryRaw`...
**Фікс:** `const [guard, rows] = await Promise.all([X ? findFirst(select:id) : Promise.resolve(null), $queryRaw...])`. ПІСЛЯ: `if (X && !guard) throw NotFound`. Failure mode: aggregation на неіснуючому...

### 2026-06-03 — findOne як guard у update/create методах де update сам повертає DTO — narrow до id-only select

**Сигнал:** `update(orgId, id, dto)` або `createChild(orgId, parentId, dto)` починається з `await this.findOne(orgId, id)` — повертає повний DTO з усіма include relations, але результат
**Фікс:** замінити на `const existing = await this.prisma.X.findFirst({ where: { id, orgId, deletedAt: null }, select: { id: true } }); if (!existing) throw...

### 2026-06-03 — Weighted SUM у JS reduce замість Postgres aggregate — `findMany(select scalars) + reduce(qty * cost)`

**Сигнал:** helper що рахує середньозважене (avg cost, avg margin, weighted score) робить `findMany({ select: { qty, cost } })` потім `.reduce((s, b) => s + b.qty * b.cost, 0)` + `.reduce((s, b) => s +...
**Фікс:** `$queryRaw<{total_cost, total_qty}[]>SELECT SUM(qty * cost) AS total_cost, SUM(qty) AS total_qty FROM X WHERE...` У CTE зберегти determinism (ORDER BY createdAt DESC + LIMIT N)...

### 2026-06-02 — Soft-delete `remove()` з business-rule guard (isSystem/isLocked) — updateMany з guard у WHERE + fallback на cheap re-read

**Сигнал:** `async remove(orgId, id)` завжди робить (1) `findFirst` для tenant + business-rule guard (isSystem/isLocked/status check), (2) `update` для soft-delete. Існуючий паттерн...
**Grep:** `async remove\(orgId.*id\)`
**Фікс:** `updateMany({ where: { id, orgId, deletedAt: null, isSystem: false }, data: { deletedAt: new Date() } })`. Якщо count===0 → cheap fallback `findFirst({ where: { id, orgId, deletedAt: null }, select:...

### 2026-06-02 — Speculative duplicate-check у update з business-rule перевіркою — паралелити Promise.all навіть коли duplicate check умовна

**Сигнал:** `async update(orgId, id, dto)` робить `findFirst` для tenant guard, потім умовно `if (dto.X && dto.X !== existing.X) { duplicate.findFirst }` — другий запит на основі результату...
**Фікс:** запустити обидва у `Promise.all([existing, dto.X ? duplicate : Promise.resolve(null)])`. ПІСЛЯ: `if (!existing) throw NotFound; if (dto.X && existing.X !== dto.X && duplicate) throw...

### 2026-06-01 — Sequential `tx.X.create` у $transaction callback — runtime hot-path (не bootstrap)

**Сигнал:** `for (const x of list) { await tx.X.create({...}) }` всередині `$transaction(async tx => {...})` де: (a) кожен create незалежний (немає read-залежностей), (b) не...
**Grep:** `for \(const \w+ of \w+\) \{[\s\S]{0,200}tx\.\w+\.create\(`
**Фікс:** build `linesData: Prisma.XCreateManyInput[]` array у циклі замість `tx.X.create()`, потім `await tx.X.createMany({ data: linesData })`. createMany робить **один** INSERT з N рядками — найшвидший...

### 2026-06-01 — Dev-only npm package у production bundle — static import гарантує bundle inclusion навіть за runtime гілку

**Сигнал:** компонент-провайдер (QueryProvider, ThemeProvider, FeatureFlagsProvider) робить
**Фікс:** замінити static import на conditional `next/dynamic`:

### 2026-06-01 — Auth-gated UI widgets у root layout — render-blocked для unauthenticated, але код у layout chunk

**Сигнал:** `TopShell`/`AppShell`/`AuthenticatedLayout` (у root `layout.tsx` через `<TopShell>{children}</TopShell>`) робить статичний `import { CommandPalette,...
**Фікс:** замінити статичні імпорти на `next/dynamic` для conditional widgets:

### 2026-06-01 — Heavy modal у page chunk блокує table view — `Modal` із 300+ LOC форми у тому самому файлі що list view

**Сигнал:** сторінка-список (`PricingRulesClient.tsx`, `EmployeesClient.tsx`, `CrmPage.tsx`) має `function XFormModal({...}) { ... 300+ LOC ... }` у тому самому файлі що render таблиці. Modal використовує...
**Фікс:** трикомпонентний refactor:

### 2026-06-01 — Multi-loop sequential fan-out з shared dedup state — notification/email/sms dispatcher методи

**Сигнал:** processor/scheduler має 2+ окремих `for (const x of source) { ... if (!shared.has(key)) shared.add(key); await dispatcher.send(...) }` циклів. Між циклами шарується `Set<string>` для...
**Grep:** `for \(const .* of .*\) \{[\s\S]{0,200}await this\.\w+\.send\(`
**Фікс:** 1-й pass: collect+dedupe → `recipients: Recipient[]` (sync). 2-й pass: `await Promise.allSettled(recipients.map(r => dispatcher.send(...)))`. 3-й pass: iterate `results[]` для error tracking +...

### 2026-06-01 — View-state-gated fetch effects — багатовидові сторінки (day/month/stats, list/grid/calendar)

**Сигнал:** сторінка з тумблером виду (`useState<'day'|'month'|'stats'>`), окремі `useEffect` для кожного виду, АЛЕ один залежить тільки від data-key (`[date]`, `[id]`, `[filters]`) без...
**Фікс:** guard `if (viewMode === 'X') load()` до effect; додати `viewMode` у dep array. При поверненні до виду дані оновляться. Альтернатива — `useQuery({ enabled: viewMode === 'X' })`.

### 2026-06-01 — Object literals як local const у тілі компонента — DEFAULT/EMPTY initializers

**Сигнал:** `const EMPTY_FORM = {...}` або `const DEFAULT_FILTERS = {...}` всередині функції-компонента (capslock = натяк на константу, але scope локальний).
**Фікс:** підняти на module level. Якщо потрібна type-аннотація і тип у тому файлі — перенести оголошення типу вище. Перевірити що значення не залежить від props/state.

### 2026-05-28 — Довідники без кешу — settings/catalog/infrastructure модулі

**Сигнал:** `findAll()` в сервісах що повертають незмінні reference lists без `CacheService` в constructor
**Фікс:** inject CacheService → get → miss → query → set; інвалідація у кожному mutating методі
**Impact:** settings page: 5 sequential DB queries → 0 (з кешу); ~150ms → ~5ms на повторний...

### 2026-05-28 — Waterfall fetch у settings page — сторінки з декількома незалежними секціями

**Сигнал:** декілька `apiFetch()` у `useEffect([], [])` що не залежать один від одного, але написані послідовно
**Фікс:** Promise.all([...]) → деструктурувати результати → setState для кожного
**Impact:** settings: 5 послідовних fetches (~300ms кожен) → 1 паралельний (~300ms total)
**Де шукати ще:** будь-яка...

### 2026-05-28 — Source/management page не наповнює спільний ref-cache — сторінки що редагують довідники

**Сигнал:** сторінка-власник довідника (CRUD UI для branches/zones/lifts/warehouses/brands/units) фетчить ті самі списки що й consumer-сторінки, але БЕЗ `getCached`/`setCache` — хоча consumer той самий...
**Фікс:** safe-умова обов'язкова — фіксувати ТІЛЬКИ якщо `loadAll()` викликається і на mount, і після КОЖНОЇ мутації (інакше кеш стане джерелом stale). Якщо так: seed з `getCached` для миттєвого...

### 2026-05-28 — `new Intl.DateTimeFormat()` у hot-path хелперах — будь-який компонент з форматуванням дати/часу/чисел у списку

**Сигнал:** хелпер-функція форматування (час, дата, число, валюта) що створює `new Intl.DateTimeFormat()` / `new Intl.NumberFormat()`
**Grep:** `new Intl.`
**Фікс:** винести форматер у module-level `const` (один інстанс на модуль), у хелпері лише `.format()`. Опції статичні — якщо локаль/TZ динамічні, кешувати через Map за...

### 2026-05-28 — Читання `new Date()` / годинника всередині render — компоненти з time-залежним UI

**Сигнал:** `new Date()`, `Date.now()`, `.getMinutes()`/`.getHours()` викликані прямо у JSX або у `.map()` що генерує опції/комірки — особливо для disabled-логіки «минулий час». Це impure render (різний...
**Grep:** `new Date()`
**Фікс:** тримати поточний час у стейті (`nowMs`), оновлювати по інтервалу в `useEffect`; похідні граничні (minHour, minMinute) через `useMemo([nowMs])`; передавати у дочірні як...

### 2026-05-30 — Detail-include vs list-include розрізнення — список з вкладеною колекцією

**Сигнал:** list endpoint робить `include: { children: { orderBy } }` (вкладена one-to-many) — здається O(N×M) і треба «оптимізувати» прибравши include. Перевіряти ПЕРЕД фіксом —...
**Фікс:** **НЕ фіксувати** якщо UI використовує. Якщо preview не потрібен — замінити include на `_count: { select: { children: true } }` для бейджу N і додати окремий `GET /:id` що повертає повний об'єкт з...

### 2026-05-30 — "Pre-mature optimization rejection" — коли НЕ фіксувати знайдене

**Сигнал:** запит містить «чи варто кешувати», «чи потрібен debounce», «чи ефективно» — це питання, не директива. Перед фіксом перевіряй чи проблема
**Фікс:** **записати в звіт "не виправлено, бо X"** замість тихо ігнорувати. Приклади: «GET /user-preferences/:key не кешується бо викликається 1× per mount + apiFetch уже дедуплить...

### 2026-05-30 — Verify-before-fix: коли запит звучить як "чи є cleanup/leak/issue?" — прочитати фактичний код перед діями

**Сигнал:** користувач ставить запитання «чи є cleanup для setTimeout?», «скільки ResizeObserver одночасно?», «чи потрібна virtualization?», «transition при кожному ререндері чи тільки при зміні?».
**Фікс:** якщо верифікація показала що проблеми **немає** — **НЕ робити фікс**. Чесно у звіті «0 проблем — cleanup є / pagination 20 / transition тільки при size change». Це валідно,...

### 2026-05-30 — HAR/DevTools "duplicate" може бути CORS preflight + GET — read curl method before declaring N+1

**Сигнал:** звіт показує що один endpoint викликається «двічі» при відкритті сторінки. У HAR/curl-export перші N — `-X 'OPTIONS'`, наступні N — той самий URL без `-X` (GET).
**Фікс:** реального дубля немає → НЕ чіпай useEffect / StrictMode / dedup. Фіксуй сам preflight: `maxAge` у `enableCors()` (NestJS) щоб браузер кешував OPTIONS. Chrome кепить на...

### 2026-05-30 — Consumer-page без ref-cache seed — сторінки де довідник це side-data, а не основний контент

**Сигнал:** сторінка робить `apiFetch('/branches')` без попереднього `getCached`, і використовує результат тільки для dropdown/select. Першу відкриття показує порожній...
**Grep:** `apiFetch.*/branches\|apiFetch.*/warehouses\|apiFetch.*/zones\|apiFetch.*/lifts\|apiFetch.*/work-categories`
**Фікс:** на початку useEffect: `const cached = getCached<T[]>('cache:X'); if (cached?.length) setState(cached);`. Після fetch: `setCache('cache:X', data)`. Безпечно бо ref-cache живе тільки в...

### 2026-05-30 — Detail-page ref-cache miss — картка сутності тягне ті ж довідники що й список

**Сигнал:** detail-сторінка (`/X/[id]/PageClient.tsx`) робить `apiFetch('/works'/'employees'/'warehouses'/...)` без `getCached`/`setCache`, але parent list-сторінка той самий довідник у cache...
**Фікс:** на початку useEffect: `const cached = getCached<T>(...); if (cached) setState(cached);` для кожного. Після fetch — `setCache(...)`. Кеш ділиться з list-сторінкою через спільний...

### 2026-05-30 — Sequential FK validation у NestJS create/update — будь-який сервіс що приймає DTO з кількома FK полями

**Сигнал:** у `create(orgId, dto)`/`addLine(orgId, dto)` йдуть два-три-чотири `await this.prisma.X.findFirst({ where: { id: dto.xId, orgId, deletedAt: null } })` поспіль — кожен для іншої...
**Grep:** `await this\.prisma\.\w+\.findFirst`
**Фікс:** `const [a, b, c] = await Promise.all([findFirst(...), findFirst(...), findFirst(...)])`; `if (!a) throw` ПІСЛЯ Promise.all — порядок повідомлень не страждає, бо всі...

### 2026-05-30 — Sequential queue.add у фан-аут хендлерах — webhook delivery, sms/notification dispatch

**Сигнал:** `for (const x of list) { await this.queue.add('job', {...}, opts); }` — по черзі N independent jobs у BullMQ/Redis. Кожен `add` робить окремий Redis-PIPELINE round-trip
**Grep:** `for (const \w+ of \w+)`
**Фікс:** `await Promise.all(list.map(x => this.queue.add('job', {...}, opts)))`. Семантика збереглася: всі jobs отримають attempts/backoff; failure одного не ломає...

### 2026-05-30 — Duplicate findFirst для тієї ж сутності з різним select — services що окремо тягнуть проекції

**Сигнал:** в одному методі дві `findFirst({ where: { id: dto.xId, orgId } })` для однієї сутності, але з різним `select`/`include`. Одна тягне `branchId`, інша `status`.
**Фікс:** залишити одну `findFirst` що selectить ОБИДВА поля — Postgres віддасть одним read; видалити дублікат, переписати if-перевірки на властивості об'єкта.

### 2026-05-30 — Sequential file/media upload у формі — будь-який handleUpload з for-await на FormData

**Сигнал:** `for (const file of Array.from(files)) { await apiMultipartFetch(url, fd); }`. Кожен upload блокує наступний на HTTP round-trip.
**Grep:** `for (const \w+ of (Array\.from\()?files\)?)`
**Фікс:** `Promise.allSettled(Array.from(files).map(file => ...))`. Failure count = `results.filter(r => r.status === 'rejected').length`. wall-clock падає до...

### 2026-05-30 — Sequential UPDATE у post-WO hook без транзакції — maintenance, schedules, notifications batch

**Сигнал:** метод після завершення наряду (`updateAfterWorkOrder`, `notifyAll`, `propagateChange`) робить `for (const x of list) { await prisma.X.update(...) }` поза транзакцією.
**Grep:** `for (const \w+ of \w+)`
**Фікс:** `await Promise.all(list.map(x => this.prisma.X.update({ where: { id: x.id }, ... })))`. Failure одного: Promise.all reject — той самий контракт що й перший await-помилка.

### 2026-05-30 — Covering index для WHERE+ORDER BY combo — list endpoints що показують найновіше

**Сигнал:** на вкладці «Аудит»/«Транзакції»/«Історія» Postgres сканує тисячі рядків, потім сортує у пам'яті. Existing index покриває WHERE (orgId+entityType+entityId), але не сортувальний стовпець...
**Фікс:** замінити існуючий індекс на `(orgId, ...filterCols, createdAt)` — covering. Postgres віддасть в індекс-order, sort node зникає. Окремий індекс лише на createdAt лишити (для full-org...

### 2026-05-30 — Per-row N+1 у xlsx/csv line importers — будь-який bulk import з for-await пошуком entity per row

**Сигнал:** import-метод для кожного рядка робить `good.findFirst({ where: { OR: [{ sku }, { name }] } })` + `existingLine.findFirst({ where: { goodId, parentId } })` +...
**Фікс:** helper `lookupEntitiesBulk(orgId, rows)` що робить ОДИН `findMany({ where: { orgId, OR: [{ sku: { in: skus } }, { name: { in: names } }] } })` → Map<key, entity>. Перед циклом.

### 2026-05-30 — Pure compute extraction з async rule resolver — calculateX що внутрішньо тягне правила/конфіг з БД

**Сигнал:** сервіс має `calculateX(orgId, ...inputs): Promise<number>` що
**Grep:** `calculateX(`
**Фікс:** split на дві: `getRulesForOrg(orgId)` (async) + `computeFromRules(rules, ...inputs)` (sync). Existing `calculateX` робить обидві підряд —...

### 2026-05-30 — Backend hot-loop Intl construction — звіти, PDF рендеринг, групування по даті

**Сигнал:** `kyivDate = (d) => new Intl.DateTimeFormat('sv-SE', {...}).format(d)` оголошений у тілі методу, а не module-level. Викликається у `for (const x of rows)` циклі 1000+...
**Grep:** `new Intl\.(DateTimeFormat|NumberFormat)\(`
**Фікс:** module-level `const KYIV_DATE_FMT = new Intl.DateTimeFormat(...)`. У циклі — лише `.format(d)`. Опції статичні. Якщо локаль/TZ з config — кешувати через Map<key,...

### 2026-05-30 — Frontend Intl singletons via dedicated lib helper — масові table-cell `.toLocaleString` у списках

**Сигнал:** на сторінці-списку кожна комірка з ціною/датою має inline `value.toLocaleString('uk-UA', {...})` або `new Date(value).toLocaleDateString('uk-UA')`. Або локальна...
**Фікс:** `apps/web/src/lib/format.ts` з module-level Intl singletons (`MONEY_FMT`, `DATE_FMT`, `DATETIME_FMT`, `SHORT_DATETIME_FMT`, `INT_FMT`) + thin wrappers (`fmtMoney(n)`,...

### 2026-05-30 — Tenant guard + side-entity fetch sequential — assertX() потім findFirst(X-related) у різних таблицях

**Сигнал:** метод починається з `await this.assertCounterparty(orgId, cpId)` (tenant-guard) потім `await this.prisma.loyaltyAccount.findFirst({ where: { counterpartyId, orgId } })`.
**Фікс:** `const [guard, entity] = await Promise.all([assertQuery, entityQuery])`. `if (!guard) throw NotFound` ПІСЛЯ Promise.all — порядок не страждає бо обидва вже...

### 2026-05-31 — SSE/long-poll endpoints без throttle на нові підключення — `@SkipThrottle()` на @Sse()

**Сигнал:** контролер з `@Sse()` або `@Get('stream')`/SSE/long-poll помічений `@SkipThrottle()` щоб throttler не лічив rapid-fire. Логіка коректна за наявності самого з'єднання (вже...
**Grep:** `@SkipThrottle\(\)`
**Фікс:** замінити `@SkipThrottle()` на `@Throttle({ default: { ttl: 60_000, limit: 5 } })`. Throttler рахує тільки нові request'и — вже відкритий...

### 2026-05-31 — Sub-query timeout у Promise.allSettled fan-out — dashboard/aggregated endpoints

**Сигнал:** `getSummary`/`getDashboard`/`getAggregatedReport` робить `Promise.allSettled([q1, q2, q3, q4])` з незалежних DB-запитів. `allSettled` ловить exception per-query, але
**Grep:** `Promise\.allSettled\(`
**Фікс:** приватний helper `withTimeout<T>(p, ms): Promise<T | null>` через `Promise.race([p, timeoutPromise])`. timeoutPromise resolves `null` (НЕ reject — інакше allSettled поверне `rejected`)...

### 2026-05-31 — Прихована відсутність Prisma connection pool sizing — DATABASE_URL без `connection_limit`/`pool_timeout`

**Сигнал:** PrismaService через `new PrismaClient()` без явного `datasourceUrl`. Prisma default = `num_physical_cpus * 2 + 1` connection limit і `pool_timeout=10s`. На багатоядерній...
**Фікс:** helper `withConnectionPool(url): string` через `new URL(url)` + `searchParams.set()` тільки якщо key ще не виставлений (operator override precedence). Рекомендовані дефолти:...

### 2026-05-31 — Same-aggregate parent + child sequential read — addLine/updateLine/removeLine та createFromX

**Сигнал:** `updateLine(orgId, parentId, childId, dto)` чи `removeLine(...)` робить дві послідовні findFirst: `parent.findFirst({ id: parentId, orgId, deletedAt: null })` для...
**Grep:** `await this\.prisma\.\w+\.findFirst`
**Фікс:** `const [parent, child] = await Promise.all([parent.findFirst(...), child.findFirst(...)])`. `if (!parent) throw NotFound` + status-guards ПІСЛЯ Promise.all.

### 2026-05-31 — Local fmt() helper що внутрішньо викликає toLocaleString — page-level «оптимізація» що нічого не оптимізує

**Сигнал:** локальна `function fmt(n: number) { return n.toLocaleString('uk-UA', {...}) + ' ₴' }` (або `fmtDate`/`fmtTime`) у `.map()` cells. Виглядає як...
**Grep:** `function fmt\(`
**Фікс:** імпортувати `fmtMoney`/`fmtInt`/`fmtDate`/`fmtDateTime` з `@/lib/format` і переписати локальний як thin proxy: `function fmt(n) { return \`${fmtMoney(n)} ₴\` }`. Бажано злити з singleton повністю.

### 2026-05-31 — Tiered parallelization stops at first Promise.all — addX/createX де є кілька груп незалежних reads

**Сигнал:** `addX(orgId, parentId, dto)`/`createX(orgId, dto)` вже має один `Promise.all([parent.findFirst, fk.findFirst])`. Але одразу після нього —...
**Фікс:** додати ДРУГИЙ `Promise.all([dup, count, ...])` після першого. Або, якщо обидві хвилі читають за одним ключем (orgId+goodId), злити у ОДИН `Promise.all` коли parent-guard не блокує...

### 2026-05-31 — `include: { fk: true }` для many-to-one relation що використовує 2-3 поля — не лише join-таблиць

**Сигнал:** `include: { unitOfMeasure: true }`, `include: { brand: true }`, `include: { category: true }` у `findMany`/`findFirst`/`create` — single related row. У toDto/.map()...
**Фікс:** `include: { fk: true }` → `select: { ...neededFields, fk: { select: { name: true, ...neededFields } } }`. Якщо кілька relations — увесь top-level стає select. TypeScript авто-наведе...

### 2026-05-31 — Public widget без shared lib доступу — booking/embed сторінки що не імпортують `@/lib/format`

**Сигнал:** публічна сторінка-віджет (booking, signup, reset-password) — чорний-box без авторизації що рендерить `.map()` зі слотами/датами через inline `toLocaleString`/`toLocaleTimeString`.
**Grep:** `toLocaleTimeString\|toLocaleString`
**Фікс:** module-level `const SLOT_TIME_FMT = new Intl.DateTimeFormat('uk-UA', { hour: '2-digit', minute: '2-digit' })` **в тому самому файлі** — без імпорту з `lib/format`....

### 2026-05-31 — Private parent-guard helper блокує tier merger — `await this.assertX/getEditableX` як перший рядок hot-path методу

**Сигнал:** приватний helper `getEditableWorkOrder(orgId, id)` / `assertCounterparty(orgId, id)` робить parent.findFirst + business-rule check (status, isActive, deletedAt) і кидає виключення.
**Фікс:** inline parent.findFirst всередину `Promise.all([wo, fk1, fk2])`. `if (!wo) throw NotFound` та business-rule (`if (!EDITABLE.includes(wo.status)) throw`) ПІСЛЯ awaits — порядок...

### 2026-05-31 — Over-fetched many-to-one include для scalar-only consumer — `include: { brand: true }` коли тіло читає лише `entity.brandId`

**Сигнал:** `include: { brand: true }` (або інший fkRelation), але тіло читає лише foreign-key scalar — `line.good.brandId` чи `g.brandId` — без жодного...
**Фікс:** замінити `include` на `select` з narrow projection: явно всі поля parent entity + які FK scalars (brandId, categoryId). Видалити nested include...

### 2026-05-31 — Assignment/bulk-replace методи з findOne+FK guard sequential — `assignX(orgId, id, dto)` де findOne блокує FK перевірку

**Сигнал:** `assignX(orgId, id, dto: {idList: string[]})` починається з `await this.findOne(orgId, id)` (tenant guard) і далі `findMany({ where: { id: { in: dto.idList },...
**Grep:** `await this\.findOne\(orgId, id\)`**Фікс:**`const [parent, items] = await Promise.all([prisma.parent.findFirst({...select: { id: true }}), dto.list.length ? prisma.child.findMany({...}) : Promise.resolve([])])`. Заміна findOne на findFirst з...

### 2026-05-31 — Sequential `tx.X.create` loop у bootstrap/seed/init transaction — `createMany` пропущено для defaults

**Сигнал:** bootstrap/setup (setup.init, seed, fresh-org init) робить `for (const x of defaults) { await tx.X.create({ data: { orgId, ...x } }) }` у `$transaction`.
**Grep:** `for \(const \w+ of \w+\) { await tx\.\w+\.create\(`
**Фікс:** `await tx.X.createMany({ data: defaults.map(d => ({ orgId, ...d })) })`. createMany не повертає рядки (`{count}`) — якщо потрібні IDs для наступних кроків, лишити...

### 2026-05-31 — JS aggregation у post-mutation recalc helpers — `findMany({ select: { amount: true } }).reduce(...)` для перерахунку totals

**Сигнал:** `recalcTotals(parentId, tx)` робить `tx.X.findMany({ where: { parentId, orgId, deletedAt: null }, select: { amount: true }, take: 1000 })` потім `.reduce((s, l) => s +...
**Grep:** `findMany.*select.*amount.*reduce`**Фікс:**`prisma.X.aggregate({ where, _sum: { amount: true } })`замість findMany + JS reduce.`Number(result._sum.amount ?? 0)`. Для кількох...

### 2026-05-31 — Inline Intl.* construction у `useEffect` loadData callback — page-mount setup-функції з 2-4 форматерами підряд

**Сигнал:** на сторінці-дашборді/звіті `useEffect(() => { ... }, [])` (mount-only) робить `const fmt = (d) => new Intl.DateTimeFormat(...).format(d)` всередині callback АБО прямі `new...
**Grep:** `new Intl\.\(DateTimeFormat\|NumberFormat\)`**Фікс:** винести **всі** форматери у module-level`const`блок над компонентом. Local`kyivDate`як thin`.format()` wrapper. Опції константні (TZ, locale, options object повністю...

### 2026-05-31 — Async wrapper-method блокує parallelism викликача — `calculateX(...)` що сам тягне rules перед чистим compute

**Сигнал:** hot-path (`batch.createFromReceipt`) робить `entity = await prisma.X.findFirst(...)` потім `result = await this.other.calculateY(entity.fields, costPrice)`, де `calculateY` внутрішньо...
**Фікс:** `const [entity, rules] = await Promise.all([prisma.X.findFirst(...), this.other.getRulesForY(orgId)])`. Далі sync `this.other.computeYFromRules(rules, entity.fields, costPrice)`. Wrapper-метод...

### 2026-05-31 — 3rd-party UI lib props rebuilt each render — DayPicker/Combobox/Table з inline classNames/disabled/columns

**Сигнал:** обгортка над сторонньою UI-бібліотекою (DayPicker, React-Table, Combobox, MultiSelect) передає inline object/array літерал як props (`classNames={{...}}`, `disabled={[{before:...},...
**Фікс:** statically-known props → module-level `const DAY_PICKER_CLASS_NAMES = {...}`. Props що залежать від render input → `useMemo(() => [...], [dep1, dep2])`.

### 2026-05-31 — List item component без React.memo + inline callback — toggle expansion/selection у списку

**Сигнал:** компонент-рядок у `.map()` приймає stable primitive props (`{batch, expanded, onToggle, depleted}`) і
**Фікс:** `const Row = memo(function Row({...}) {...})`. Inline callback на батьку → `const handleX = useCallback((id) => setX(prev => prev === id ? null : id), [])`. Передавати `id` параметром (не...

### 2026-05-31 — Sequential cron-/scheduler queue.add у onModuleInit — N-orgs scheduler enqueue блокує application bootstrap

**Сигнал:** OnModuleInit hook (`FollowUpScheduler`, `ReminderScheduler`) проходить `for (const org of orgs) { await this.queue.add('job', ..., { repeat: cron, jobId:...
**Фікс:** `await Promise.all(items.map(item => queue.add(..., { jobId: \`x-${item.id}\`, repeat: cron, ... })))`. BullMQ deduplicates by jobId — паралель add = N concurrent Redis multi/exec...

### 2026-05-31 — PDF/export endpoints over-fetch via include — generatePdf методи з повним include для render data

**Сигнал:** `async generatePdf(orgId, id)` / `async exportX()` робить `findFirst({ where, include: { lines: {...}, parts: {...}, counterparty: true, organisation: findFirst({...}) } })`.
**Фікс:** замінити `include` на `select` з точним переліком полів що рендеряться у docDef. organisation findFirst → `select: { name: true, edrpou?: true, address?: true }`. lines/parts → `select: {...

### 2026-05-31 — Clone/duplicate операції з ID-only create патерном — `clone(id)` що include тягне labels що НЕ використовуються у create

**Сигнал:** `async clone(orgId, id, userId)` / `async duplicate(...)` робить `findFirst({ include: { related: { select: { name: true } }, lines: { include: { fk: { select: { name: true } } } } } })`.
**Фікс:** замінити include на narrow select що залишає ЛИШЕ FK scalars + business поля що йдуть у create (price/quantity/normoHours/amount/notes). Видалити related entity nested select. AuditEvent...

### 2026-05-31 — `similarity()` обчислюється кілька разів per row у $queryRaw search — pg_trgm `%` оператор vs `similarity() > threshold`

**Сигнал:** raw SQL search використовує `similarity(col, $q) > 0.1` у WHERE І `ORDER BY similarity(col, $q) DESC` у тому запиті. Postgres не дедуплікує — обчислює `similarity()` двічі per row.
**Grep:** `similarity(`
**Фікс:** subquery/CTE винесе `similarity()` як column → ORDER BY читає pre-computed. WHERE замінити на `col % $q` (set-similarity operator) — planner використовує GIN trgm index для...

### 2026-05-31 — Speculative duplicate-check у tier-merger update — коли значення-для-порівняння живе в existing row

**Сигнал:** `update(orgId, id, dto)` має 2-фазний «оптимізований» паттерн: (1) findFirst для existing, (2) IF dto.field !== existing.field — findFirst для duplicate-check. Друга фаза умовна.
**Фікс:** speculative — запустити duplicate.findFirst у Promise.all з existing.findFirst незалежно від `dto.X !== existing.X`. ПІСЛЯ awaits — `if (dto.X && dto.X !== existing.X &&...

### 2026-05-31 — `findOne + update` 2-RTT pattern для simple soft-delete/update — заміна на `updateMany` з orgId guard

**Сигнал:** простий CRUD `async update(orgId, id, dto)` робить `await this.findOne(orgId, id)` (404 guard через findFirst) → `await prisma.X.update({ where: { id, orgId }, data: {...} })`.
**Фікс:** `await prisma.X.updateMany({ where: { id, orgId, deletedAt: null }, data })` → `if (updated.count === 0) throw NotFoundException`. Для `update` що має повернути updated row — окремий findFirst...

### 2026-05-31 — Навігаційний prefetch при hover — дані готові до кліку (~200 мс)

**Сигнал:** при переході між сторінками помітна пауза — spinner/skeleton після кліку на NavLink. Дані API завантажуються тільки після mount, хоча JS chunk вже prefetch'ений...
**Фікс:** module-level `PREFETCH_MAP: Record<string, (qc) => void>` з `qc.prefetchQuery(...)` для кожного NAV item. `onMouseEnter={() => employee && PREFETCH_MAP[href]?.(queryClient)}`. Обов'язково: (1)...

### 2026-05-31 — TanStack Query міграція list-сторінок — useEffect+apiFetch без кешу

**Сигнал:** при повторному відвідуванні (A→B→A) — знову spinner/skeleton хоча дані щойно були. `useEffect → apiFetch → setState` не кешує нічого між unmount/mount.
**Grep:** `const load = useCallback\|useState.*\[\]\|setLoading.*true`
**Фікс:** (1) `hooks/api/useX.ts` з `useQuery(staleTime:30s, gcTime:5m, placeholderData:keepPreviousData, enabled:!!employee)`; (2) замінити useState/load/useEffect на `const { data, isLoading } =...

### 2026-05-31 — keepPreviousData у useQuery — таблиця не мерехтить при зміні фільтрів

**Сигнал:** при зміні статус-фільтра/search — таблиця зникає (spinner) на 300-500мс. Навіть при швидкій мережі.
**Grep:** `useQuery`
**Фікс:** `import { keepPreviousData } from '@tanstack/react-query'` + `placeholderData: keepPreviousData` у кожному `useQuery` для paginated list.
**Impact:** UX плавний — старі дані...

### 2026-05-31 — Частковий prefetch — сторінка має N hooks, у PREFETCH_MAP покрито лише M<N

**Сигнал:** маршрут є у PREFETCH_MAP, але сторінка викликає кілька useQuery hooks (5 для dashboard, 4 для infrastructure). Покрита тільки частина — інші fetch після...
**Фікс:** додати решту `qc.prefetchQuery` у тому PrefetchFn — паралельно, у тому closure. Для date-залежних (revenue chart з today+weekStart) — module-level KYIV_DATE_FMT singleton...

### 2026-05-31 — keepPreviousData у hooks з form-control параметрами — не лише filter pills, а й from/to/tab dropdowns

**Сигнал:** reports/analytics-сторінка має 2-3 form controls (`from` date, `to` date, `tab` selector) — кожна зміна = новий запит з новим queryKey. Без `keepPreviousData` — графік/таблиця...
**Grep:** `useQuery`
**Фікс:** `import { keepPreviousData }` + `placeholderData: keepPreviousData` у hook. При зміні параметрів React Query повертає `data` попередньої успішної...

### 2026-09-05 — Subscribing-hook у base/wrapper компоненті → фан-аут window-listeners × N інстансів (Modal, ListRow, Cell)

**Сигнал:** глобально-використовуваний примітив UI (`Modal`, `Popover`, `Row`, `Cell`, `Tooltip`) починає викликати hook, що у `useEffect` робить `window.addEventListener` (3+ подій) та/або тримає `useState`-subscription (`useUiFeatures`, `useMediaQuery`, `useOnlineStatus`). Примітив інстанціюється десятки разів — часто в **закритому** стані (модалка рендерить `null`, але hooks виконуються ДО `if (!open) return null`). Кожен інстанс тепер прив'язує N idle-listeners + окрему підписку. Особливо небезпечно: батьківський компонент (create-modal) ВЖЕ викликав той hook напряму → **подвійна підписка** (6 listeners замість 3, 2 mount-fetch).
**Grep:** порівняти `git show <base>~1:<Modal-file> | grep useXxx` з поточним — якщо subscribing-hook доданий у base, і `grep -rln "useXxx()" apps/web/src | wc -l` показує багато call-sites → фан-аут. Плюс: чи base тримає інстанси при `open=false` (hooks над early-return `null`).
**Причина:** зручно централізувати feature-flag/keyboard-shortcut у base Modal. Але base інстанціюється частіше (ConfirmDialog, picker, nested).
**Виявлення:** (1) hook над early-return у широко-інстанційованому примітиві; (2) той hook і в батьку, і в base (дубль); (3) event-listener effects з `[]` deps (фіксований per-instance cost).
**Фікс (обережно — може міняти поведінку):** значення потрібне лише для опційної фічі (Ctrl+Enter гейтиться на `onSubmit`) → або лишити (idle-listeners дешеві — login/logout/settings), або звузити підписку lightweight-селектором що біндить listener лише коли фіча активна. НЕ conditional hook. Якщо hook робить `invalidateCache()` у кожному listener → N subscribers = thundering-herd на event (кожен null-ить `pending` → 2+ fetch). Часто вердикт: **marginal, документувати як observation**, не чіпати.
**Impact:** зазвичай marginal (idle-listeners, рідкісні події) — кількісно: ~3-9 зайвих window-listeners на сторінку; подвійні підписки у 5 великих модалках.
**Де шукати ще:** будь-який `components/ui/*` примітив (Modal/Popover/Sheet/Drawer/Tooltip/Menu) що набув subscribing-hook; `useMediaQuery`/`useOnlineStatus`/`useUiFeatures`/`useTheme` у list-row чи cell.

### 2026-09-05 — Дисципліна «не оптимізувати marginal per-row алокацію у чистому хелпері» (page-limit малий, Date/obj дешеві)

**Сигнал:** чистий per-row хелпер (`rowStatusTone(input, nowMs)`) створює `new Date(nowMs)`/`new Date(iso)` або дрібний обʼєкт на КОЖЕН виклик, у `.map()` списку. Спокуса «підняти» константу з тіла. АЛЕ: page-limit 20-50 рядків, `new Date()` коштує десятки нс → µs на рендер. Хоістинг всередину pure-хелпера ламає чистоту/сигнатуру заради невимірного виграшу.
**Grep:** `new Date(` у файлі `lib/*.ts` що імпортується у `.map()`. Перевірити page-limit (`defaultLimit`) — якщо ≤ ~100 і алокація дрібна → marginal.
**Причина:** механічне застосування «hoist per-row allocation» без урахування масштабу (N рядків) та вартості.
**Виявлення/Фікс:** спершу оцінити N × cost. Хоістити лише коли: (а) алокація важка (`new Intl.*Format` — locale-data init, ~µs-ms), АБО (б) N великий (virtualized-list 1000+, calendar-grid). Для дрібних Date/obj при N≤100 — **observation, не фікс**. Реальний хоістинг-виграш у Intl-форматерах (Крок 2.8), не у `new Date`.
**Impact:** null (свідомо не чіпати) — документувати щоб наступний цикл не «виправляв» повторно.
**Де шукати ще:** `lib/format.ts`/`lib/*-status.ts`/`lib/*-badge.ts` у `.map()`; відрізняти дешевий `new Date`/spread від дорогого `new Intl.*Format`/`.toLocaleString()`.
