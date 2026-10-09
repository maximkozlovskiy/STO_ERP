# sto-optimize — frontend

> Частина скіла `sto-optimize`; винесено дослівно, щоб кожен файл влазив в один Read.

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

### 2.18 Рідне поле дати (`type="date"`) напряму у фільтрі запиту — запит на кожну проміжну дату під час набору року

```bash
# рідні поля дати, чиє значення йде у стан сторінки-списку
grep -rn 'type="date"' apps/web/src/app/ --include="*.tsx" | grep -v __tests__
# для кандидата: стан із onChange потрапляє у фільтр хука / queryKey БЕЗ useDebounce?
```

**Проблема:** рідне поле під час набору року з клавіатури віддає `onChange` на кожну цифру, і кожне значення — формально повна дата (`0002-..` → `0020-..` → `0202-..` → `2026-..`). Без затримки це 4 запити на одну дату; проміжна межа «з року 2» рівна відсутності межі — сервер повертає всю вибірку. 2.1 цього не ловить: grep там шукає `setSearch`/`setQ`.
**Фікс:** `useDebounce` на значенні межі перед фільтром хука; поле лишається керованим миттєвим значенням. Компонент-обгортка, що віддає лише завершену дату (вибір із календаря), затримки не потребує. **Підтверджувати ВИМІРОМ:** у браузері набрати дату з клавіатури із затримкою між клавішами й порахувати запити до й після; у тесті — множина різних значень межі, з якими викликано хук.
