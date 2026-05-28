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
employeeZones: true

// ✅ select — тільки потрібне поле
employeeZones: { select: { zoneId: true } }
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

**Кандидати для кешування (TTL 300s):** branches, warehouses, zones, lifts, work-categories, brands, units, payment-methods — всі вже мають кеш. Нові довідники: currencies, bank-accounts, cash-registers.

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

### 1.7 Dashboard і SSE без кешу
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
useEffect(() => { loadComments(); }, [loadComments]);
useEffect(() => { loadMedia(); }, [loadMedia]);
useEffect(() => { loadAudit(); }, [loadAudit]);

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

## Що вже оптимізовано (не повторювати)

**Backend:**
- ✅ CacheService + Redis TTL 300s: branches, warehouses, zones, lifts, work-categories, brands, units, payment-methods
- ✅ Dashboard cache 25s TTL
- ✅ Reports: $queryRaw GROUP BY замість JS aggregation
- ✅ Purchase-orders list без lines
- ✅ Employees: `select: { xId: true }` замість `include: true`
- ✅ Invoices create: parallel Promise.all
- ✅ CompletionActs create: parallel Promise.all

**Frontend:**
- ✅ useDebounce(300ms) на 8 сторінках (work-orders, crm, invoices, purchase-orders, inventory, employees, catalog ×3)
- ✅ next/dynamic recharts: dashboard (235→124kB), reports (269→149kB)
- ✅ sessionStorage ref-cache: branches, warehouses, zones, lifts, work-categories, brands, units, suppliers, wo-templates
- ✅ SW: skipWaiting після precache; API routes не кешуються
- ✅ Promise.all parallel fetches на 9 сторінках
- ✅ GET dedup в api-client.ts (без AbortSignal)
- ✅ React.memo + useMemo Map: DraggableSlot, DroppableLiftRow (calendar)
- ✅ CRM loadGarages: waterfall → staged parallel
- ✅ WO detail: loadComments+Media+Audit → loadSecondary Promise.all
- ✅ img lazy loading + decoding="async"

**DB:**
- ✅ work_orders: `(orgId, status, branchId, deletedAt)`, `(orgId, completedAt, deletedAt)`
- ✅ stock_items: `(orgId, warehouseId, deletedAt)`
- ✅ stock_movements: `(orgId, warehouseId, createdAt)`
- ✅ stock_batches: `(orgId, warehouseId, isActive, createdAt)`
- ✅ GIN trgm: work_orders.number, counterparties.(firstName/lastName/companyName), goods.(name/sku)
