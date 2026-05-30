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

### 2.8 Intl.*Format у hot-path хелперах + годинник у render
```bash
# Конструкція форматера у тілі функції-хелпера (locale-data init на кожен виклик)
grep -rn "new Intl\.\(DateTimeFormat\|NumberFormat\)\|\.toLocale\(Time\|Date\)String(" apps/web/src/ --include="*.tsx" | head -20
# Читання годинника всередині render/map (impure + per-element)
grep -rn "new Date()\|Date\.now()\|\.getMinutes()\|\.getHours()" apps/web/src/app/ --include="*.tsx" | grep -v "useEffect\|useCallback\|=>" | head -20
```

**Фікс Intl:** винести форматер у module-level `const` (опції мають бути константні), у хелпері лише `.format()`.
**Фікс годинника:** тримати `nowMs` у стейті + interval; похідні граничні значення через `useMemo([nowMs])`; передавати як props у дочірні компоненти (роблячи їх чистими/memo-friendly).

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

### 2026-05-28 — Довідники без кешу — settings/catalog/infrastructure модулі

**Сигнал:** `findAll()` в сервісах що повертають незмінні reference lists без `CacheService` в constructor
**Причина виникнення:** кеш додавався поступово по сервісах, нові модулі створювались за шаблоном без CacheService
**Підхід до виявлення:** порівняти список `findAll` методів з тим, які сервіси мають `CacheService` в constructor — різниця = кандидати
**Підхід до фіксу:** inject CacheService → get → якщо miss → query → set; інвалідація у кожному mutating методі
**Реальний impact:** settings page: 5 sequential DB queries → 0 (з кешу); ~150ms → ~5ms на повторний відкрит
**Де шукати ще:** будь-який новий модуль-довідник (currencies, tax-rates, document-configs, notification-templates)

---

### 2026-05-28 — Waterfall fetch у settings page — сторінки з декількома незалежними секціями

**Сигнал:** декілька `apiFetch()` у `useEffect([], [])` що не залежать один від одного, але написані послідовно
**Причина виникнення:** сторінки будуються поступово — спочатку один fetch, потім інші додаються "знизу" без рефакторингу
**Підхід до виявлення:** в useEffect шукати кілька `apiFetch` що не пов'язані ланцюгом `.then()` — якщо кожен веде до окремого `setState`, вони незалежні
**Підхід до фіксу:** Promise.all([...]) → деструктурувати результати → setState для кожного
**Реальний impact:** settings: 5 послідовних fetches (~300ms кожен) → 1 паралельний (~300ms total)
**Де шукати ще:** будь-яка сторінка з декількома вкладками що завантажують різні типи даних при mount

---

### 2026-05-28 — Source/management page не наповнює спільний ref-cache — сторінки що редагують довідники

**Сигнал:** сторінка-власник довідника (CRUD UI для branches/zones/lifts/warehouses/brands/units) фетчить ті самі списки що й consumer-сторінки, але БЕЗ `getCached`/`setCache` — хоча consumer-сторінки той самий список кешують
**Причина виникнення:** ref-cache додавався з боку *споживачів* (де список — це дропдаун/лейбл). Сторінку-джерело пропускають, бо здається що "вона й так керує цими даними" — але вона теж платить cold-fetch і, головне, її правки не доходять до кешу споживачів
**Підхід до виявлення:** не плутати з Кроком 2.4. Тут шукати **source-сторінку** довідника: знайти у grep сторінку де той самий endpoint викликається і в `loadAll`/`load`, і у mutation-хендлерах (create/update/delete) — це ознака management UI. Перевірити чи вона торкається ref-cache взагалі
**Підхід до фіксу:** safe-умова обов'язкова — фіксувати ТІЛЬКИ якщо `loadAll()` викликається і на mount, і після КОЖНОЇ мутації (інакше кеш стане джерелом stale-даних). Якщо так: seed з `getCached` для миттєвого first-paint + `setCache` після кожного свіжого фетчу. Це не лише прискорює саму сторінку — це пропагує її правки/видалення у кеш споживачів на їхній наступний mount
**Реальний impact:** management-сторінка більше не cold-fetch при кожному відкритті; правки довідника видно на consumer-сторінках без чекання їхнього TTL
**Де шукати ще:** будь-яка адмінська/CRUD сторінка довідника (infrastructure, catalog tabs, settings) — перевірити що вона і читає, і ПИШЕ у ref-cache, а не лише читає

---

### 2026-05-28 — `new Intl.DateTimeFormat()` у hot-path хелперах — будь-який компонент з форматуванням дати/часу/чисел у списку

**Сигнал:** хелпер-функція форматування (час, дата, число, валюта) що створює `new Intl.DateTimeFormat()` / `new Intl.NumberFormat()` **всередині тіла** і викликається у `.map()`, у render списку, або у pointer/resize-хендлерах. Те саме стосується `.toLocaleTimeString()` / `.toLocaleDateString()` з опціями — вони теж конструюють форматер під капотом на кожен виклик
**Причина виникнення:** конструктор `Intl.*Format` виглядає дешевим, тому його ставлять у функцію поруч із `.format()`. Насправді ініціалізація locale-data — найдорожча частина; сам `.format()` дешевий. У списку зі слотами/рядками × ре-рендери це сотні зайвих конструкцій
**Підхід до виявлення:** grep `new Intl.` та `.toLocale` у компонентах; для кожного збігу спитати «чи ця функція викликається в циклі/render/хендлері?». Якщо опції форматера константні (TZ, locale фіксовані) — кандидат на хостинг
**Підхід до фіксу:** винести форматер у module-level `const` (один інстанс на весь модуль), у хелпері викликати лише `.format()`. Опції мають бути статичними — якщо локаль/TZ динамічні, кешувати через Map за ключем
**Реальний impact:** усуває O(slots × renders) конструкцій важкого об'єкта; найпомітніше на календарі/таблицях/звітах де форматування у кожному рядку
**Де шукати ще:** таблиці зі стовпцями дат/сум, календар, дашборд-картки, будь-який `formatX` хелпер у `lib/` що приймає опції

---

### 2026-05-30 — Detail-include vs list-include розрізнення — список з вкладеною колекцією

**Сигнал:** list endpoint робить `include: { children: { orderBy } }` (вкладена one-to-many таблиця) — складається враження що це O(N×M) і треба «оптимізувати» прибравши include. Перевіряти треба ПЕРЕД фіксом — UI може реально показувати вкладені елементи у самій таблиці списку (preview), і тоді include обов'язковий
**Причина виникнення:** автоматичний рефлекс «вкладена колекція в list = N+1» спрацьовує без перегляду споживача. Якщо UI відображає `{rule.tiers.map(t => ...)}` у комірці таблиці — це **detail-в-list** патерн (свідоме рішення UX-у), не баг
**Підхід до виявлення:** **завжди** грепнути по полю-колекції в frontend (`*.tsx`) перед фіксом. Якщо є `.map()` у table cell/row — це навмисний preview, ЛИШИТИ include. Якщо є тільки у `editForm`/modal-у — `tiers` потрібні лише при відкритті форми → перенести у GET /:id endpoint
**Підхід до фіксу:** **НЕ фіксувати** якщо UI використовує. Якщо preview не потрібен — замінити include на `_count: { select: { children: true } }` для бейджу N і додати окремий `GET /:id` що повертає повний об'єкт з дітьми. Не пропускати UI-перевірку — інакше фікс зламає рендер
**Реальний impact:** для COST_TIER pricing rules з 3-5 тірами на правило і 50 правилами — include тягне 200-300 рядків, JSON ~50KB — терпимо (< 50ms). Без preview UX-у це було б 0KB зайвих, з preview це необхідні дані
**Де шукати ще:** будь-який list endpoint з `include: { tiers/lines/items/children: ... }` — спочатку перевір UI, тоді приймай рішення

---

### 2026-05-30 — "Pre-mature optimization rejection" — коли НЕ фіксувати знайдене

**Сигнал:** запит від користувача містить фразу «чи варто кешувати», «чи потрібен debounce», «чи ефективно» — це питання, не директива. Перед фіксом перевіряй чи проблема **вимірна** і чи **частота виклику** виправдовує складність
**Причина виникнення:** аудит-агент бачить кожне «можна було б покращити» як проблему. Реальність: 80% таких «оптимізацій» додають складність без impact, бо: low-frequency call, dedup вже існує на нижньому рівні (apiFetch in-flight Map), data invalidation складніша за виграш
**Підхід до виявлення:** для кожного знайденого patterns спитати:
  1. Скільки викликів на сесію? (1-10 = low; 100+ = high)
  2. Чи є dedup на нижчому рівні? (apiFetch inFlight, browser HTTP cache, Prisma query batching)
  3. Чи інвалідація складніша за виграш? (multi-key cache, cross-tenant TTL)
  4. Чи буде візуальний/measurable impact? (< 50ms total = ні)
**Підхід до фіксу:** **записати в звіт "не виправлено, бо X"** замість тихо ігнорувати. Користувач має знати чому. Приклади: «GET /user-preferences/:key не кешується бо викликається 1× per mount + apiFetch уже дедуплить in-flight», «calculateSalePrice cache key (orgId+goodId+brandId+costPrice) дав би < 5% hit rate і складну інвалідацію — пропущено»
**Реальний impact:** уникнення збільшення складності коду в low-impact гарячих шляхах; чесний звіт, який не маскує бездіяльність як «все ОК»
**Де шукати ще:** будь-яке запитання-аудит з «чи варто/чи ефективно» — застосовувати 4-чек філтр перед діями

---

### 2026-05-28 — Читання `new Date()` / годинника всередині render — компоненти з time-залежним UI

**Сигнал:** `new Date()`, `Date.now()`, `.getMinutes()`/`.getHours()` викликані прямо у JSX або у `.map()` що генерує опції/комірки — особливо для disabled-логіки «минулий час». Це і impure render (різний результат при однакових props), і повторний виклик на кожен елемент
**Причина виникнення:** «потрібен поточний час щоб задизейблити минулі опції» — найпростіше прочитати годинник там де він потрібен. Але render має бути чистим; час — це зовнішній стан
**Підхід до виявлення:** grep `new Date()`/`Date.now()`/`.getMinutes()`/`.getHours()` у *.tsx поза `useEffect`/`useCallback`/хендлерами; якщо збіг у render-гілці або в `.map` колбеку — проблема
**Підхід до фіксу:** тримати поточний час у стейті (`nowMs`), оновлювати по інтервалу в `useEffect`; похідні граничні значення (minHour, minMinute) рахувати через `useMemo([nowMs])`; передавати їх у дочірні компоненти як props замість читання годинника в них. Дочірній компонент стає чистим і memo-friendly
**Реальний impact:** прибирає impure render + per-element виклики Date; робить time-gated списки опцій детермінованими і memo-сумісними
**Де шукати ще:** time/date picker'и з disabled минулих значень, «сьогодні»-підсвітка у календарі/таблицях, countdown/таймери, будь-який disabled на основі «зараз»

---

## Що вже оптимізовано (не повторювати)

**Backend:**
- ✅ CacheService + Redis TTL 300s: branches, warehouses, zones, lifts, work-categories, brands, units, payment-methods, currencies, bank-accounts, cash-registers
- ✅ Dashboard cache 25s TTL
- ✅ Reports: $queryRaw GROUP BY замість JS aggregation
- ✅ Purchase-orders list без lines
- ✅ Employees: `select: { xId: true }` замість `include: true`
- ✅ Invoices create: parallel Promise.all
- ✅ CompletionActs create: parallel Promise.all
- ✅ Calendar createSlot/updateSlot: parallel FK validation (Promise.all)

**Frontend:**
- ✅ useDebounce(300ms) на 8 сторінках (work-orders, crm, invoices, purchase-orders, inventory, employees, catalog ×3)
- ✅ next/dynamic recharts: dashboard (235→124kB), reports (269→149kB)
- ✅ sessionStorage ref-cache: branches, warehouses, zones, lifts, work-categories, brands, units, suppliers, wo-templates, currencies, bank-accounts
- ✅ infrastructure (source page): warm ref-cache (branches/zones/lifts/warehouses) → пропагація правок споживачам
- ✅ settings/page.tsx: parallel Promise.all for currencies+rates+bank-accounts+cash-registers+org-info
- ✅ SW: skipWaiting після precache; API routes не кешуються
- ✅ Promise.all parallel fetches на 9 сторінках
- ✅ GET dedup в api-client.ts (без AbortSignal)
- ✅ React.memo + useMemo Map: DraggableSlot, DroppableLiftRow (calendar)
- ✅ calendar: module-level Intl.DateTimeFormat singletons (kyivHours/fmtTime/toDateString) замість per-call construction
- ✅ calendar TimeSelect: per-render new Date().getMinutes() → nowMs-derived minMinute prop
- ✅ CRM loadGarages: waterfall → staged parallel
- ✅ WO detail: loadComments+Media+Audit → loadSecondary Promise.all
- ✅ img lazy loading + decoding="async"

**DB:**
- ✅ work_orders: `(orgId, status, branchId, deletedAt)`, `(orgId, completedAt, deletedAt)`
- ✅ stock_items: `(orgId, warehouseId, deletedAt)`
- ✅ stock_movements: `(orgId, warehouseId, createdAt)`
- ✅ stock_batches: `(orgId, warehouseId, isActive, createdAt)`
- ✅ GIN trgm: work_orders.number, counterparties.(firstName/lastName/companyName), goods.(name/sku)
