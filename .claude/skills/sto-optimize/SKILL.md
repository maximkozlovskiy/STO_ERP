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
**Причина виникнення:** ref-cache додавався з боку _споживачів_ (де список — це дропдаун/лейбл). Сторінку-джерело пропускають, бо здається що "вона й так керує цими даними" — але вона теж платить cold-fetch і, головне, її правки не доходять до кешу споживачів
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

### 2026-05-30 — Verify-before-fix: коли запит звучить як "чи є cleanup/leak/issue?" — прочитати фактичний код перед діями

**Сигнал:** користувач ставить запитання у формі "чи є cleanup для setTimeout?", "скільки ResizeObserver одночасно?", "чи потрібна virtualization?", "transition при кожному ререндері чи тільки при зміні?". Це **діагностичні питання**, а не директиви на фікс
**Причина виникнення:** запит часто формулюється з підозрою на проблему, але код може бути вже правильним (cleanup є, RO мало, pagination вже обмежує, CSS transition спрацьовує лише при зміні значення). Аудит-агент має схильність "знайти щось щоб виправити" — і додає захисні зміни що ускладнюють код без impact
**Підхід до виявлення:** для кожного запитання-діагностики виконати **точкову верифікацію**:

1. Cleanup setTimeout/setInterval/observers? → прочитати `useEffect` return statement, перевірити `clearTimeout(id)`/`clearInterval(id)`/`.disconnect()`
2. Кількість одночасних observers? → grep по conditional renders (`{flag && <X/>}`); оцінити max active count
3. Virtualization потрібна? → знайти pagination ліміт (`limit: '20'`, `take: 20`); якщо < 100 видимих рядків — НЕ потрібна
4. CSS transition при ререндері? → CSS `transition: prop Xms` запускає анімацію **лише** при зміні значення `prop`, не при ререндері. Inline `style={{}}` об'єкт recreated each render — React diff'ить ефективно
   **Підхід до фіксу:** якщо верифікація показала що проблеми **немає** — **НЕ робити фікс**. Замість цього: чесно відповісти у звіті "0 проблем — cleanup є / pagination 20 / transition тільки при size change". Це валідно, це показує що код у хорошому стані. **Не вигадувати фіктивні фікси щоб виглядати продуктивним**
   **Реальний impact:** уникнення додавання захисних змін у вже-коректний код; чесний нульовий-фікс звіт зміцнює довіру до агента
   **Де шукати ще:** будь-який prompt з 3+ запитаннями типу "чи..." — імовірно це чек-лист на верифікацію, не на фікс

---

### 2026-05-30 — HAR/DevTools "duplicate" може бути CORS preflight + GET — read curl method before declaring N+1

**Сигнал:** користувач/звіт показує що один endpoint викликається "двічі" при відкритті сторінки. У HAR/curl-export перші N записів — `-X 'OPTIONS'`, наступні N — той самий URL без `-X` (GET). Це **не дубль у коді** — це нормальна CORS preflight + actual request пара браузера для cross-origin requests з `Authorization` header
**Причина виникнення:** Network tab підсвічує OPTIONS і GET одним кольором; curl-export з'єднує їх у послідовність. Без перевірки HTTP-методу легко прийняти кожен запит за окремий fetch з коду — і піти "виправляти" useEffect/StrictMode, чого там немає
**Підхід до виявлення:** **завжди** дивись на `-X 'METHOD'` у HAR/curl-export перед фіксом. Якщо першу запит-пара має `-X 'OPTIONS'` із заголовком `Access-Control-Request-Method: GET` — це preflight, не дубль. Реальні дублі мали б ОБА запити з ідентичним методом (GET/GET або POST/POST)
**Підхід до фіксу:** реального дубля немає → НЕ чіпай useEffect / StrictMode / dedup. Натомість фіксуй сам preflight: додати `maxAge` у `enableCors()` (NestJS) щоб браузер кешував результат OPTIONS. Chrome кепить на 7200s, Firefox — 24h. Це усуває ~50% мережевих round-trips без зміни коду сторінок
**Реальний impact:** у dev (3001→3000 cross-origin) кожен fetch коштує 2 RTT. З maxAge — 1 RTT після першого виклику. На дашборді з 5 fetches: 10 RTT → 5 RTT. У production за тим самим origin preflight зазвичай не потрібен — але як defense-in-depth налаштування все одно корисне
**Де шукати ще:** будь-який API сервіс що використовує `app.enableCors()` без `maxAge` — перевір whether dev/prod CORS налаштування симетричні. Інші CORS-сервери (S3, MinIO direct uploads, third-party APIs) — там той самий патерн

---

### 2026-05-30 — Consumer-page без ref-cache seed — сторінки де довідник це side-data, а не основний контент

**Сигнал:** сторінка робить `apiFetch('/branches')` (або іншого довідника) без попереднього `getCached`, і використовує результат тільки для dropdown/select. Першу відкриття вкладки сторінка показує порожній select, секундою пізніше — заповнений
**Причина виникнення:** ref-cache додається в першу чергу для сторінок-споживачів де довідник = головний UI (вибір клієнта в CRM). Сторінки з side-довідниками (settings з branches тільки для workdays tab; reports з warehouses; dashboard з зонами) пропускаються — здається "це і так одна вкладка, не критично". Але користувач все одно бачить порожній dropdown N мілісекунд
**Підхід до виявлення:** grep `apiFetch.*/branches\|apiFetch.*/warehouses\|apiFetch.*/zones\|apiFetch.*/lifts\|apiFetch.*/work-categories` по `apps/web/src/app/`, виключити сторінки що вже мають `getCached`. Для кожної залишеної — перевірити чи дані використовуються у dropdown/picker/select. Якщо так — це кандидат
**Підхід до фіксу:** на початку useEffect: `const cached = getCached<T[]>('cache:X'); if (cached?.length) setState(cached);`. Після successful fetch: `setCache('cache:X', data)`. Безпечно тому що ref-cache живе тільки в межах tab session — invalidation не потрібен якщо споживач не редагує цей довідник
**Реальний impact:** dropdown відображається без cold-fetch flash; перший рендер сторінки знаходить готові дані замість `[]`; запит на сервер все одно йде (refresh), але вже non-blocking для UI
**Де шукати ще:** будь-який settings/reports/dashboard endpoint що має tab-based UI — там кожна вкладка може фетчити окремий довідник якого вже немає в cache

---

### 2026-05-30 — Detail-page ref-cache miss — картка сутності тягне ті ж довідники що й список

**Сигнал:** detail-сторінка (`/X/[id]/PageClient.tsx`) робить `apiFetch('/works'/'employees'/'warehouses'/...)` без `getCached`/`setCache`, але parent list-сторінка (`/X/page.tsx`) той самий довідник у cache має. Користувач натискає рядок таблиці → детальна сторінка тягне 600+ рядків довідників із нуля, хоча 200ms тому ці ж дані вже були в кеші
**Причина виникнення:** ref-cache додавався в першу чергу для list-сторінок (де dropdown = частина UI). Detail-сторінки пропускаються бо «це окрема сторінка, і вона завантажується раз». Насправді користувач у нормальному workflow відкриває 3-5-10 карток поспіль (наряди, рахунки, замовлення) — кожна з них cold-fetch одних і тих самих довідників
**Підхід до виявлення:** після того як list-сторінка модуля закешована — обов'язково перевірити detail-сторінку (`apps/web/src/app/<module>/[id]/PageClient.tsx`). Грепнути `apiFetch.*/works\|/employees\|/warehouses\|/brands\|/units` без `getCached` поряд. Якщо знайдено — кандидат
**Підхід до фіксу:** на початку useEffect: `const cached = getCached<T>(...); if (cached) setState(cached);` для кожного довідника. Після successful fetch — `setCache(...)`. Кеш ділиться з list-сторінкою через спільний sessionStorage ключ → перший fetch у сесії єдиний, всі наступні відкриття детальних сторінок миттєві
**Реальний impact:** друге+ відкриття картки наряду у сесії: 3 fetch для works/employees/warehouses → 0 (cache hit). Перше відкриття не міняється (cold-start однаковий), але повторні навігації прискорюються драматично — типовий день: 30+ карток × 3 fetches = 90 RTT економії
**Де шукати ще:** будь-яка detail-сторінка модуля (`work-orders/[id]`, `invoices/[id]` якщо створиться, `purchase-orders/[id]` якщо створиться, `crm/[id]`, `vehicles/[id]`) — перевір що довідники (не контент сутності, а саме reference data: списки виборів) seed-аться з кешу

---

### 2026-05-30 — Sequential FK validation у NestJS create/update — будь-який сервіс що приймає DTO з кількома FK полями

**Сигнал:** у методі `create(orgId, dto)` або `addLine(orgId, dto)` сервісу йдуть два-три-чотири `await this.prisma.X.findFirst({ where: { id: dto.xId, orgId, deletedAt: null } })` поспіль — кожен для іншої сутності (work, employee, good, warehouse, counterparty). Кожен виклик блокує наступний на час одного RTT до Postgres
**Причина виникнення:** найприродніший спосіб писати валідацію: одна перевірка → if (!entity) throw → наступна перевірка. Виглядає лінійно і читабельно, але кожна перевірка незалежна (FK поля з різних таблиць), отже їх можна виконати конкурентно. Це не N+1 (немає циклу), а звичайний waterfall — менш помітний, але масовий: майже в кожному `addLine`/`create` сервісу
**Підхід до виявлення:** grep `await this\.prisma\.\w+\.findFirst` у `*.service.ts`, шукати послідовні рядки з різними моделями. Якщо їх в одному методі ≥2 і всі читають за `dto.xId` (а не по результату попереднього) — кандидат
**Підхід до фіксу:** `const [a, b, c] = await Promise.all([findFirst(...), findFirst(...), findFirst(...)])`; перевірки `if (!a) throw` залишити ПІСЛЯ Promise.all — порядок повідомлень про помилку не страждає, бо всі обидва запити вже виконані. Для опціональних FK — тернарка `dto.xId ? findFirst(...) : Promise.resolve(null)` зберігає типи
**Реальний impact:** N RTT → 1 RTT. На warranties.create з 4 послідовними findFirst (wo+cp+line+part) — 4× прискорення латенсі цього кроку. На work-orders.addLine — 2× (work+employee). Помітно при роботі через WAN/VPN де RTT 30-50ms
**Де шукати ще:** будь-який метод create/update/addX/addY/remove що валідує >1 FK поле з DTO. Особливо часто: warranty, work-order-line, work-order-part, service, invoice-line, settlement act, completion-act PDF generation. Перевіряти кожен новий backend module

---

### 2026-05-30 — Sequential queue.add у фан-аут хендлерах — webhook delivery, sms/notification dispatch

**Сигнал:** `for (const x of list) { await this.queue.add('job', {...}, opts); }` — сервіс кладе по черзі N independent jobs у BullMQ/Redis-чергу. Кожен `add` робить окремий Redis-PIPELINE round-trip
**Причина виникнення:** черга семантично надійна (job persists навіть якщо process crash), тому здається що додавання — внутрішня деталь і `await` у циклі прийнятний. Насправді Bull в Promise.all внутрішньо pipelines через ioredis multi/exec, тож паралельне додавання дешевше за послідовне
**Підхід до виявлення:** grep `for (const \w+ of \w+)` у backend сервісах, для кожного циклу перевірити чи тіло — це лише `queue.add` (або `apiQueue.something(payload, opts)` для іншої черги). Якщо так — це fan-out без межі і не потребує послідовності
**Підхід до фіксу:** `await Promise.all(list.map(x => this.queue.add('job', {...}, opts)))`. Семантика збереглася: всі jobs все одно отримають свій attempts/backoff із black-box-черги; failure одного не ломає інші
**Реальний impact:** N Redis RTT → 1 batch RTT. Для webhooks.publish з 5-50 endpoints — суттєве зниження p95 latency публікації події. Особливо актуально коли черга на віддаленому Redis (через мережу)
**Де шукати ще:** будь-який fan-out у backend: webhooks.publish, notifications.send (якщо batch), email/sms/queue.add цикли, periodic-job dispatch

---

### 2026-05-30 — Duplicate findFirst для тієї ж сутності з різним select — services що окремо тягнуть проекції

**Сигнал:** в одному методі є дві `findFirst({ where: { id: dto.xId, orgId } })` для однієї сутності, але з різним `select`/`include`. Наприклад: одна тягне `branchId`, інша тягне `status`. Виглядає як рефакторинг-релікт коли запит спочатку був без select, потім додався другий select для нової потреби
**Причина виникнення:** інкрементальний рефакторинг — нову потребу (status check) додають поряд із наявною (branchId for queue), не помічаючи що це той самий запис. ESLint/TS не попереджають
**Підхід до виявлення:** grep всі `findFirst({ where: { id: dto.\w+ ` у файлі і перевірити чи дві з них мають однаковий `id: dto.SAME_FIELD`. Якщо так — кандидат на merge
**Підхід до фіксу:** залишити одну `findFirst` що selectить ОБИДВА поля (branchId + status) — Postgres віддасть їх одним read; видалити дублікат, переписати наступні if-перевірки на властивості об'єкта
**Реальний impact:** 1 RTT економії + 1 query log менше. Якщо метод викликається часто (payments.create — на кожну оплату) — це примітивний, але стабільний win
**Де шукати ще:** будь-який сервіс де додавали нові business-rule перевірки поверх існуючої FK validation. payments.create, invoices.update, work-order transitions — типові місця

---

### 2026-05-30 — Sequential file/media upload у формі — будь-який handleUpload з for-await на FormData

**Сигнал:** у frontend хендлері завантаження кількох файлів: `for (const file of Array.from(files)) { await apiMultipartFetch(url, fd); }`. Кожен upload блокує наступний на час повного HTTP round-trip. Користувач завантажує 5 фото → чекає sum(file) часу замість max(file)
**Причина виникнення:** обробка помилок per-file найпростіша через for+try/catch. Здається що паралельне завантаження ускладнить tracking failure count
**Підхід до виявлення:** grep `for (const \w+ of (Array\.from\()?files\)?)` у `*.tsx`, або `Array.from(files)\.\w*\.forEach.*await`. Перевірити чи тіло циклу — fetch/upload
**Підхід до фіксу:** `Promise.allSettled(Array.from(files).map(file => ...))`. Failure count = `results.filter(r => r.status === 'rejected').length`. Логіка обробки results однаково проста, а wall-clock падає до max(file)
**Реальний impact:** 5 файлів × 2s upload → 10s послідовно vs ~2.5s паралельно. На повільних 4G/Wi-Fi — драматично. Сервер тримає окремий обробник на кожен файл, тож паралелізм не "бомбардує" — Nginx/Caddy queue ще одного в worker pool
**Де шукати ще:** будь-який handler що приймає `FileList`: work-order media, invoice attachments, vehicle photos, employee documents, signing scans

---

### 2026-05-30 — Sequential UPDATE у post-WO hook без транзакції — maintenance, schedules, notifications batch

**Сигнал:** службовий метод що викликається після завершення наряду (`updateAfterWorkOrder`, `notifyAll`, `propagateChange`) робить `for (const x of list) { await prisma.X.update(...) }` поза транзакцією. На відміну від циклу всередині `$transaction` (де sequential семантично потрібен для consistency) — тут списки можна обробляти конкурентно
**Причина виникнення:** код виглядає як список простих updates: природно писати for-await. Якщо ніхто явно не подумав «це поза tx — паралель ОК», лишається послідовним
**Підхід до виявлення:** grep `for (const \w+ of \w+)` → перевірити, чи цей цикл всередині `$transaction(async (tx) => {...})`. Якщо НІ, і тіло — це лише `await this.prisma.X.update({ where: { id: x.id }, ... })` без залежностей між ітераціями → кандидат
**Підхід до фіксу:** `await Promise.all(list.map(x => this.prisma.X.update({ where: { id: x.id }, ... })))`. Failure одного: Promise.all reject — це той самий контракт що й перший await-помилка у for-await
**Реальний impact:** N RTT → 1 RTT batch. Для maintenance-schedules.updateAfterWorkOrder з 3-5 schedules на авто — 3-5× прискорення WO COMPLETED transition. Особливо помітно на flotах де графіків багато
**Де шукати ще:** post-WO completion hooks, post-payment fan-out, bulk soft-delete loops, periodic job per-tenant updates

---

### 2026-05-30 — Covering index для WHERE+ORDER BY combo — list endpoints що показують найновіше

**Сигнал:** на сторінці-вкладці "Аудит"/"Транзакції"/"Історія" Postgres сканує тисячі рядків, потім сортує їх у пам'яті. Existing index покриває WHERE (orgId+entityType+entityId), але не сортувальний стовпець (createdAt). EXPLAIN показує `Sort` node поверх `Index Scan`
**Причина виникнення:** індекси проєктують на запит спочатку через WHERE — додають orgId, потім filter columns. ORDER BY часто додається пізніше у фічу або як UX-полірування. Створювати окремий індекс лише для sort коштовно, тому забувають розширити існуючий
**Підхід до виявлення:** для кожного списку у UI що сортується за `createdAt DESC` і має filter — знайти відповідний `findMany({ where, orderBy: { createdAt: 'desc' }, take: N })`. Дивитись на існуючі `@@index` моделі: якщо там `(orgId, ...filterCols)` без `createdAt` в кінці — кандидат. Особливо коли `take` маленький (≤100) — sort на великому result-set за кадром
**Підхід до фіксу:** замінити існуючий індекс на `(orgId, ...filterCols, createdAt)` — covering. Postgres віддасть результат в індекс-order, sort node зникає. Окремий індекс лише на createdAt лишити (для full-org scans)
**Реальний impact:** для timeline-вкладок (audit, settlement transactions) на даних ≥10k записів — Sort node з 50-200ms падає в 0. Перші запити (cold cache) можуть прискоритися 5-10×. На малих таблицях ефект непомітний, але індекс не шкодить
**Де шукати ще:** будь-який list endpoint з `WHERE filter + ORDER BY createdAt DESC + take`: audit events, settlement transactions, payments, invoices, work orders timeline, stock movements log, webhook deliveries

---

### 2026-05-30 — Per-row N+1 у xlsx/csv line importers — будь-який bulk import з for-await пошуком entity per row

**Сигнал:** import-метод приймає масив рядків з файлу (xlsx/csv), для кожного рядка робить `good.findFirst({ where: { OR: [{ sku }, { name }] } })` + `existingLine.findFirst({ where: { goodId, parentId } })` + create/update. На 1000 рядків — 2000-3000 RTT
**Причина виникнення:** import пишеться як CRUD — рядок прийшов, шукаємо існуючий entity, оновлюємо/створюємо. for-await — найбільш звичний паттерн для error reporting per row (try/catch у тілі). Видається безпечним бо "юзер один раз імпортує", але вже 100 рядків × 30ms RTT = 3 секунди + ризик connection-pool exhaustion при паралельних імпортах
**Підхід до виявлення:** грепнути `for (const \w+ of rows)` у services, перевірити чи тіло циклу містить `findFirst` за полями що походять з row (sku, name, barcode, externalId). Якщо так — кандидат
**Підхід до фіксу:** виділити helper `lookupEntitiesBulk(orgId, rows)` що робить ОДИН `findMany({ where: { orgId, OR: [{ sku: { in: skus } }, { name: { in: names } }] } })` і повертає Map<key, entity>. Перед циклом - prefetch existing lines одним `findMany({ where: { parentId, goodId: { in: [...] } } })` теж у Map. Цикл стає чистим: lookup + decide create/update + накопичити в errors. Лишити create/update послідовними якщо вони впливають на той самий аггрегат (сума), або замінити на `createMany` для нових і `updateMany`+CASE для оновлень якщо незалежні
**Реальний impact:** 1000 рядків × (findFirst + findFirst) ~= 2000 RTT → 2 batch RTT + N localhost Map lookups. Реалістичне прискорення з 60s → 3s для типового імпорту 500 запчастин
**Де шукати ще:** будь-який importX метод сервісу де X = lines/items/parts — line importers це системно повторюваний паттерн (PO, SD, WO parts, invoice lines, services, інспекція)

---

### 2026-05-30 — Pure compute extraction з async rule resolver — calculateX що внутрішньо тягне правила/конфіг з БД

**Сигнал:** сервіс має метод `calculateX(orgId, ...inputs): Promise<number>` що **завжди** починається з `prisma.rules.findMany({ where: { orgId, isActive } })` потім робить чистий розрахунок. Виклик у hot loop робить N×fetch однієї й тієї ж колекції правил
**Причина виникнення:** найприродніша інкапсуляція: «один публічний метод який все робить». Викликач не знає про правила — він має просто отримати ціну. Але при batch-операціях (apply pricing to 1000 goods) кожен виклик re-fetch'ить статичні правила. Кешування на рівні методу не допомагає бо TTL не очевидний, а invalidation складна
**Підхід до виявлення:** для кожного `async calculate*` у сервісі прочитати тіло. Якщо перший await — це `findMany`/`findFirst` для довідника, не для основного entity input — кандидат на split. Перевірити чи метод викликається у циклі деінде (grep `calculateX(`)
**Підхід до фіксу:** split на дві функції: `getRulesForOrg(orgId)` (async, тримати у PricingService) + `computeFromRules(rules, ...inputs)` (sync, чистий розрахунок). Existing `calculateX` робить обидві операції підряд — зворотно-сумісний. Batch-споживачі викликають `getRulesForOrg` ОДИН раз і map'ять `computeFromRules` синхронно
**Реальний impact:** для applyPricingFromList з 500 items: 500 fetch правил → 1 fetch + 500 синхронних compute. Раніше було ~15s (500 × 30ms RTT) → < 1s. Аналогічно для tax/discount/loyalty калькуляторів
**Де шукати ще:** будь-який \*Service з методом «розрахуй X»: pricing, tax, discount, loyalty earn, commission. Коли вони викликаються у репортах, bulk-операціях, batch-операціях — extract pure compute

---

### 2026-05-30 — Backend hot-loop Intl construction — звіти, PDF рендеринг, групування по даті

**Сигнал:** хелпер-функція `kyivDate = (d) => new Intl.DateTimeFormat('sv-SE', {...}).format(d)` оголошений у тілі методу, а не на module-level. Викликається у `for (const x of rows)` циклі що проходить 1000+ рядків. Те саме для `fmtMoney`/`fmtDate` у PDF builderах (called per .map cell)
**Причина виникнення:** Intl.DateTimeFormat/NumberFormat сприймається як «дешевий хелпер» — особливо коли він вкладений у метод, бо опції локалі (`timeZone: 'Europe/Kyiv'`) виглядають як частина «контексту звіту». Але locale-data init — найдорожча частина: ~0.5-1ms на конструкцію. У циклі × 10000 → 5-10 секунд CPU
**Підхід до виявлення:** grep `new Intl\.(DateTimeFormat|NumberFormat)\(` у `apps/api/src/modules/**/*.service.ts`. Для кожного збігу спитати: «чи цей форматер у hot loop або per-row map?» Reports (revenue, transactions), PDF generators (рядки таблиці накладної), CSV exporters — типові гарячі шляхи. Якщо options константні (TZ/locale фіксовані) — кандидат на hosting
**Підхід до фіксу:** module-level `const KYIV_DATE_FMT = new Intl.DateTimeFormat(...)`. У хелпері/циклі — лише `.format(d)`. Опції мають бути статичними. Якщо локаль/TZ зчитуються з config — кешувати через Map<key, Formatter>. NestJS DI це не псує — module-level const живе весь час процесу
**Реальний impact:** для revenue звіту 10000 WO: 10000 конструкцій → 1. PDF з накладною 50 рядків: 100 формат-конструкцій (money+date×2) → 2. Сумарно прибирає 5-10s CPU з кожного важкого звіту
**Де шукати ще:** reports.service всі методи, pdf.service builders, csv/xlsx export-генератори, settlements act builders, document number formatters (якщо викликається batch-ом)

---

### 2026-05-30 — Frontend Intl singletons via dedicated lib helper — масові table-cell `.toLocaleString` у списках

**Сигнал:** на сторінці-списку (таблиця/grid/detail-card) кожна grow-комірка з ціною/датою має inline `value.toLocaleString('uk-UA', {...})` або `new Date(value).toLocaleDateString('uk-UA')`. Або є локальна функція `fmt(n)` у файлі що теж робить inline `toLocaleString`. Множиться через `.map()` × ререндери (search, filter)
**Причина виникнення:** `.toLocaleString` виглядає як «вбудована JS-фіча, дешеве» — розробник не помічає що під капотом це `new Intl.NumberFormat(...).format(...)` де **конструкція** locale-data дорога. Локальний `fmt` хелпер створює ілюзію оптимізації, але він теж викликає `toLocaleString` під капотом, отже не дає виграшу
**Підхід до виявлення:** **не точково** по одному файлу — потрібен **systematic sweep**: `grep -rn "toLocaleString\|toLocaleDateString\|toLocaleTimeString\|new Intl\." apps/web/src/app/ --include="*.tsx"`. Для кожного збігу спитати: «це у `.map()` / у table cell / у списку?». Якщо так — кандидат. Локальні `fmt()` хелпери у файлі — теж кандидати (рекурсивно)
**Підхід до фіксу:** створити `apps/web/src/lib/format.ts` з module-level Intl singletons (`MONEY_FMT`, `DATE_FMT`, `DATETIME_FMT`, `SHORT_DATETIME_FMT`, `INT_FMT`) і експортувати thin wrappers (`fmtMoney(n)`, `fmtDate(d)`, ...). Опції форматерів **зафіксовані як константи** — `uk-UA`, `minimumFractionDigits: 2`. Сторінки імпортують і використовують замість inline `toLocaleString`. Локальні `fmt` хелпери або викидаються, або стають проксі до `lib/format`. Це paralleлить backend pattern (PDF/reports module-level KYIV_DATE_FMT) на фронт
**Реальний impact:** усуває O(rows × cells × renders) конструкцій Intl об'єкту. Для таблиці 20 рядків × 3 currency cells × 10 ререндерів за сесію — 600 конструкцій → 1. Найпомітніше у списках з фільтрами/пошуком (часті ререндери). Bonus: централізує формат — зміна локалі/precision вимагає правки одного файлу
**Де шукати ще:** будь-який новий список/таблиця/detail card; будь-який локальний `fmt` хелпер у `.tsx` файлі; reports preview, dashboards, PDF preview-modals. **Перевіряти при кожному додаванні нової сторінки-списку** — це системно повторюваний патерн

---

### 2026-05-30 — Tenant guard + side-entity fetch sequential — assertX() потім findFirst(X-related) у різних таблицях

**Сигнал:** метод сервісу починається з `await this.assertCounterparty(orgId, cpId)` (або `findFirst` для tenant-guard) потім `await this.prisma.loyaltyAccount.findFirst({ where: { counterpartyId, orgId } })`. Дві послідовні RTT — перша лише для авторизації, друга для основних даних. Обидва запити мають orgId у where → tenant ізоляція дублюється
**Причина виникнення:** assertX() helpers — рекомендована практика для DRY tenant guard у NestJS. Але у вузьких місцях (getBalance, getDetails, getReport) це створює два sequential round-trips де другий має ту саму safety через orgId. Розробник не помічає бо `assertX` виглядає як «дешевий call»
**Підхід до виявлення:** грепнути `await this\.assert\w+\(` у `*.service.ts`. Для кожного збігу перевірити чи наступний рядок — це `await this.prisma.X.findFirst(...)`. Якщо у `X.findFirst` є orgId фільтр — друге query вже tenant-safe, можна паралелити
**Підхід до фіксу:** `const [guard, entity] = await Promise.all([assertQuery, entityQuery])`. Перевірку `if (!guard) throw NotFound` робити ПІСЛЯ Promise.all — порядок повідомлень не страждає бо обидва запити вже виконані. Це безпечно навіть якщо entity знайдено для іншого tenant'а — entity query сам перевірив orgId і повернув null
**Реальний impact:** -1 RTT per call для loyalty.getBalance, getTransactions, inspection.findByWorkOrder. Для часто-викликаних endpoints (live dashboard polling, sidebar widgets) це ~30-50ms × N tabs відкритих
**Де шукати ще:** будь-який getX/getDetail/getBalance/getReport що починається з assertY guard. Особливо часто: loyalty, settlements, balance APIs, audit-by-entity, comments-by-entity. Перевір кожен «один-помічник-потім-один-запит» паттерн

---

### 2026-05-31 — SSE/long-poll endpoints без throttle на нові підключення — `@SkipThrottle()` на @Sse() через тривале з'єднання

**Сигнал:** контролер з `@Sse()` або `@Get('stream')`/SSE/long-poll помічений `@SkipThrottle()` для того щоб throttler не лічив це як rapid-fire request. Логіка коректна за наявністю самого з'єднання (вже відкритий stream — це 1 з'єднання, не 1 запит/30с), але **нові підключення** (initial connect, browser reconnect, broken proxy retries) повністю безконтрольні
**Причина виникнення:** автори SkipThrottle для SSE йдуть за міркуванням «throttler рахує запити, а SSE — один тривалий запит, тому виключаємо». Не помічають що сам акт connect — це окремий запит, і broken proxy/reverse-tunnel може ретриєвати connect десятки разів на секунду. На стороні API це cold-start + JWT verify + initial DB fetch на кожен connect
**Підхід до виявлення:** grep `@SkipThrottle\(\)` у контролерах разом із `@Sse()` / `@Get.*stream` / `@Post.*upload-chunks` / будь-який long-lived. Якщо метод повертає Observable з `interval()` або довгий stream — це кандидат на throttling **підключень**
**Підхід до фіксу:** замінити `@SkipThrottle()` на `@Throttle({ default: { ttl: 60_000, limit: 5 } })` (або інші числа залежно від профілю). Throttler `@nestjs/throttler` рахує тільки нові HTTP request'и — вже відкритий stream не тригерить лічильник. Це лімітує лише **спам connect'ів** з однієї IP, не впливає на normal flow (5 нових з'єднань/хв з однієї машини більш ніж достатньо для legitimate reconnect після network blip)
**Реальний impact:** при broken proxy / unstable network у клієнта — ~50-500 connect/min блокується до 5/min на IP. Усуває cold-start DDoS-shape spike на дашборді/SSE. Перший connect завжди проходить
**Де шукати ще:** будь-який `@Sse()`, WebSocket upgrade endpoint, long-poll `Get('/notifications')` з interval, file-upload streaming endpoints, server-side render endpoints що тримають з'єднання

---

### 2026-05-31 — Sub-query timeout у Promise.allSettled fan-out — dashboard/aggregated endpoints що збирають кілька незалежних метрик

**Сигнал:** метод `getSummary`/`getDashboard`/`getAggregatedReport` робить `Promise.allSettled([q1, q2, q3, q4])` з декількох незалежних DB-запитів. `allSettled` ловить exception per-query, але **не обмежує час**: якщо один запит зависне (slow plan, lock wait, pool starvation) — увесь endpoint чекатиме до Prisma default timeout (немає таймауту on query, тільки на connection). У SSE-контексті це валить tick для всіх клієнтів
**Причина виникнення:** `Promise.allSettled` сприймається як «безпечна паралельність — одна помилка не вб'є інші». Але failure mode «зависання» (не reject) залишається без обробки. Розробник пише isolation per-query через allSettled і вважає це достатнім
**Підхід до виявлення:** grep `Promise\.allSettled\(` у backend сервісах, особливо у dashboard/reports/aggregated endpoints. Перевірити чи будь-який з sub-queries може бути повільним (cross-join, JSON aggregate, $queryRaw з великим scan). Якщо endpoint викликається у hot polling loop (SSE, websocket, frequent client poll) — обов'язковий timeout per query
**Підхід до фіксу:** додати приватний helper `withTimeout<T>(p, ms): Promise<T | null>` через `Promise.race([p, timeoutPromise])`. timeoutPromise resolves `null` (НЕ reject — інакше allSettled поверне `rejected` що ускладнює downstream код). `setTimeout(...).unref()` щоб не тримати Node event loop alive. Обгорнути кожен sub-query у `this.withTimeout(query, 8_000)`. Downstream check: `result.status === 'fulfilled' && result.value !== null` (null → timeout, log warn, fallback значення)
**Реальний impact:** одне повільне поле більше не валить весь tick. Дашборд показує `lowStockCount: 0` з warn-логом замість 504 для всіх клієнтів. SLA для polled endpoints стає predictable (ceiling 8s × N queries ÷ parallelism)
**Де шукати ще:** будь-який Promise.allSettled у backend (особливо dashboard, reports aggregated, multi-stream readers, batch validators). Прикладні зони: `getSummary`, `getOverview`, `getStats`, multi-resource search endpoints

---

### 2026-05-31 — Прихована відсутність Prisma connection pool sizing — DATABASE_URL без `connection_limit`/`pool_timeout`

**Сигнал:** PrismaService створюється через `new PrismaClient()` без явного `datasourceUrl`. Prisma за замовчуванням бере `num_physical_cpus * 2 + 1` connection limit і `pool_timeout=10s`. На багатоядерній машині це може бути 17-25 на сервер; в Docker/CI з обмеженням CPU — лише 3-5. Symptom: під навантаженням `Timed out fetching a new connection from the connection pool` без жодних інших помилок
**Причина виникнення:** Prisma docs згадують connection pooling у production checklist, але dev-режим зазвичай працює без явного sizing — `pnpm dev` на потужній dev-машині отримує 17 з'єднань і ніколи не уперлось. У production контейнерах із CPU limit пул стає 3-5 і будь-який бурст падає. Розробники не помічають бо staging часто має той самий small-shape що й dev
**Підхід до виявлення:** read `PrismaService` constructor — якщо `super()` без аргументів або без `datasourceUrl` з URL-параметрами, перевірити `DATABASE_URL` у `.env*`. Якщо URL чистий (без `?connection_limit=`/`&pool_timeout=`), Prisma бере дефолти що залежать від cpus → unpredictable. Будь-який endpoint що робить `Promise.all([...])` з 5+ paralel queries у hot path — multiplier до пулу
**Підхід до фіксу:** обгорнути URL в helper `withConnectionPool(url): string` через `new URL(url)` + `searchParams.set()` тільки якщо key ще не виставлений (operator override has precedence). Рекомендовані дефолти: `connection_limit=25` (10 per cpu вистачає для типового API + дашборд + reports + SSE), `pool_timeout=20` (запит чекає 20s на вільне з'єднання, потім throw). Передати у `super({ datasourceUrl, log })`. Logger conditional на NODE_ENV щоб уникнути spammy info-логів у prod
**Реальний impact:** на dev-машині незмінно (operator може override). На staging/prod у Docker з CPU limit — пул із 3-5 стає 25, перестають з'являтись pool-timeout 504. Bonus: explicit logging level фіксує prod на `error` (раніше Prisma міг емітити query log на default → noise)
**Де шукати ще:** будь-який сервіс з `extends PrismaClient` — перевір чи constructor оголошує `datasourceUrl` з pool params. Аналогічно: інші клієнти БД (MongoClient, Redis ioredis cluster mode), черги BullMQ Redis connection (`maxRetriesPerRequest`)

---

### 2026-05-28 — Читання `new Date()` / годинника всередині render — компоненти з time-залежним UI

**Сигнал:** `new Date()`, `Date.now()`, `.getMinutes()`/`.getHours()` викликані прямо у JSX або у `.map()` що генерує опції/комірки — особливо для disabled-логіки «минулий час». Це і impure render (різний результат при однакових props), і повторний виклик на кожен елемент
**Причина виникнення:** «потрібен поточний час щоб задизейблити минулі опції» — найпростіше прочитати годинник там де він потрібен. Але render має бути чистим; час — це зовнішній стан
**Підхід до виявлення:** grep `new Date()`/`Date.now()`/`.getMinutes()`/`.getHours()` у \*.tsx поза `useEffect`/`useCallback`/хендлерами; якщо збіг у render-гілці або в `.map` колбеку — проблема
**Підхід до фіксу:** тримати поточний час у стейті (`nowMs`), оновлювати по інтервалу в `useEffect`; похідні граничні значення (minHour, minMinute) рахувати через `useMemo([nowMs])`; передавати їх у дочірні компоненти як props замість читання годинника в них. Дочірній компонент стає чистим і memo-friendly
**Реальний impact:** прибирає impure render + per-element виклики Date; робить time-gated списки опцій детермінованими і memo-сумісними
**Де шукати ще:** time/date picker'и з disabled минулих значень, «сьогодні»-підсвітка у календарі/таблицях, countdown/таймери, будь-який disabled на основі «зараз»

---

### 2026-05-31 — Same-aggregate parent + child sequential read — addLine/updateLine/removeLine та createFromX сервісів

**Сигнал:** метод `updateLine(orgId, parentId, childId, dto)` чи `removeLine(orgId, parentId, childId)` робить дві послідовні findFirst: спочатку `parent.findFirst({ id: parentId, orgId, deletedAt: null })` для tenant-guard + status-перевірки, потім `child.findFirst({ id: childId, parentId, orgId })` щоб переконатися що child існує всередині цього parent. Друге query вже має orgId+parentId фільтр — отже воно безпечне tenant-wise, його не треба чекати після parent. Аналогічно `createFromX(orgId, sourceId)` робить `source.findFirst` потім `child.findFirst` для перевірки duplicate
**Причина виникнення:** код виглядає лінійно та читабельно: «знайди batьковий, перевір статус, тоді знайди дочірній». Не помічають що дочірній запит має повну ізоляцію (orgId+parentId у where) і незалежний від результату першого. Це не FK validation з DTO (там очевидно паралель), а perceived-as-sequential aggregate-level check. На addLine/removeLine — це найгарячіший шлях редагування документів (рахунок-фактура, наряд-замовлення, акт) → multiplier per kожне натискання користувача
**Підхід до виявлення:** grep `await this\.prisma\.\w+\.findFirst` у service-методах де перші 2-3 рядки методу — це послідовні findFirst для **різних** prisma моделей. Якщо обидва запити мають orgId у where, і другий додатково має foreign-key у where (на батьківський entity id з первого) — кандидат. Не плутати з аналізом по DTO (FK validation з dto.xId) — тут id приходить як параметр методу, не з DTO
**Підхід до фіксу:** `const [parent, child] = await Promise.all([parent.findFirst(...), child.findFirst(...)])`. Перевірки `if (!parent) throw NotFound` та status-guards йдуть ПІСЛЯ Promise.all — порядок повідомлень про помилку зберігається бо обидва запити вже виконані. Третій випадок (addLine з опціональними DTO-FK): можна злити всі три у єдиний Promise.all замість «батьківський, потім [good, work]» — економить ще один RTT
**Реальний impact:** -1 RTT per call. На рахунках з 10 рядків редагування: 10× updateLine + 1× removeLine = 11 RTT економії за сесію редагування. Помітно на повільному WAN/VPN де RTT 30-50ms
**Де шукати ще:** будь-який метод сервісу з шаблоном `parent.findFirst → child.findFirst({ ..., parentId })`. Особливо часто: invoiceLine.updateLine/removeLine, workOrderLine.update/remove, workOrderPart.update/remove, stockDocumentLine.update/remove, purchaseOrderLine.update. Також `createFromX(sourceId)` що валідує source + перевіряє duplicate target — теж парний паттерн

---

### 2026-05-31 — Local fmt() helper що внутрішньо викликає toLocaleString — page-level «оптимізація» що нічого не оптимізує

**Сигнал:** на сторінці є локальна функція `function fmt(n: number) { return n.toLocaleString('uk-UA', {...}) + ' ₴' }` (або `fmtDate`/`fmtTime`) що використовується у `.map()` table cells. Виглядає як абстракція що централізує форматування — насправді вона викликає `toLocaleString` під капотом, який створює `new Intl.NumberFormat(locale, options)` за кожним викликом. Тобто `fmt()` маскує проблему — імена різні, але hot-path той самий що і у inline `toLocaleString`
**Причина виникнення:** розробник додає `fmt` як DRY-абстракцію поверх рекурсивного `toLocaleString` — здається що це і чистіше, і ефективніше. Не помічають що Intl-конструкція все одно відбувається; локальний хелпер не кешує форматер. У підсумку: 10 таблиць × 10 рядків × 5 ререндерів × 1 виклик `fmt` = 500 конструкцій Intl.NumberFormat
**Підхід до виявлення:** grep `function fmt\(` / `const fmt = ` у `*.tsx` сторінках. Прочитати тіло — якщо там `n.toLocaleString(...)` без виклику module-level singleton — кандидат на проксі до `lib/format`. Те саме для локальних `fmtNumber`, `formatMoney`, `dt`, тощо
**Підхід до фіксу:** імпортувати `fmtMoney`/`fmtInt`/`fmtDate`/`fmtDateTime` з `@/lib/format` і переписати локальний `fmt` як thin proxy: `function fmt(n) { return ${fmtMoney(n)} ₴ }`. Бажано злити з singleton повністю — але якщо `fmt` додає суфікс (` ₴`, ` км`, ` балів`) — proxy достатньо, не треба переписувати кожен виклик. Стара сигнатура збережена, hot-path тепер 1 інстанс на модуль
**Реальний impact:** для сторінки списку із 30 рядків × 2 currency-комірок × 5 ререндерів (filter changes, search) — 300 конструкцій Intl → 1. Найпомітніше на settlements/inventory/dashboard/reports де `fmt` викликається у `.map()` і у summary-картках
**Де шукати ще:** **кожен** новий `.tsx` файл-сторінка у `apps/web/src/app/`; при додаванні нової сторінки списку — перевір чи новий `fmt` хелпер не повторює стару пастку. Audit pattern: запускати `grep -rn "function fmt\|const fmt = " apps/web/src/app/ --include='*.tsx'` після кожного UI feature — якщо нові incidents — отримай `lib/format` proxy

---

### 2026-05-31 — Tiered parallelization stops at first Promise.all — addX/createX де є кілька груп незалежних reads

**Сигнал:** метод сервісу `addX(orgId, parentId, dto)` або `createX(orgId, dto)` вже має один `Promise.all([parent.findFirst, fk.findFirst])` для першої групи перевірок (parent + FK). Але одразу після нього — два-три послідовних awaits (типово: existing-dup-check + count + інший FK), кожен з яких незалежний від результату попереднього і має повну tenant-isolation у where. Розробник зробив перший крок оптимізації (parent + FK parallel), але другу хвилю перевірок лишив послідовною
**Причина виникнення:** перший Promise.all додається коли N+1/sequential FK validation стає очевидним (типово під час review). Решта `await`ів виглядають як «бізнес-логіка» (dup-check, count, secondary FK) і не сприймаються як кандидати на parallelize. Між хвилями немає dependency, але між ними часто стоїть `if (!parent) throw` — це **не блокує** парареллі, бо throw зупиняє виконання до наступних кроків лише якщо вони ВИКОНУЮТЬСЯ; параллельне виконання все одно усуває latency
**Підхід до виявлення:** для кожного методу що вже має `Promise.all` грепнути наступні 15-20 рядків на `await this.prisma`. Якщо є ≥2 послідовних `findFirst`/`count`/`findMany` що читають за `orgId+goodId` (або іншою спільною ключовою парою) і не залежать від результату першого `Promise.all` — це друга хвиля що теж заслуговує бути parallel
**Підхід до фіксу:** додати ДРУГИЙ `Promise.all([dup, count, ...])` після першого. Або, якщо обидві хвилі читають за одним базовим ключем (orgId+goodId), злити їх у ОДИН `Promise.all` коли parent-guard не блокує (parent.findFirst не дає інформації потрібної child queries). Перевірки `if (!parent) throw NotFound` робити ПІСЛЯ всіх awaits — порядок повідомлень про помилку зберігається бо всі запити вже виконані
**Реальний impact:** addX/createX типово робить 3-4 RTT (parent + FK + dup + count). Після першого Promise.all — 2 RTT. Після другого (або злиття) — 1 RTT. Помітно на hot-path операціях (addUoM, addBarcode, addLine, addPart) які викликаються при кожному save рядка форми
**Де шукати ще:** будь-який сервіс де вже зроблений один Promise.all — перевір наступні 15 рядків методу. Особливо часто: addLine/addPart/addUoM/addBarcode/createReconciliation/createPayment — там зазвичай є парент + FK + дуплікат + count

---

### 2026-05-31 — `include: { fk: true }` для many-to-one relation що використовує 2-3 поля — не лише join-таблиць

**Сигнал:** `include: { unitOfMeasure: true }`, `include: { brand: true }`, `include: { category: true }` у `findMany`/`findFirst`/`create` — single related row, не one-to-many колекція. У toDto/.map() використовуються ЛИШЕ 2-3 поля (`name`, `shortName`, `coefficient`). Решта колонок (orgId, createdAt, updatedAt, deletedAt, syncVersion, додаткові nullable поля) пересилаються з Postgres → Node → JSON serialization → ігноруються
**Причина виникнення:** `include: { fk: true }` — найкоротший синтаксис коли потрібно «протягнути назву», особливо для many-to-one (наприклад «showcase unit shortName разом з UoM record»). Розробник пише `include: true` бо це чотири символи менше за select projection. Не помічається бо response shape DTO вже фільтрує — лишається лише payload-overhead на wire + JIT/V8 object allocation
**Підхід до виявлення:** не плутати з Кроком 1.1 (N+1 для include: true у join-таблицях). Тут — `findFirst`/`create`/`update` single-row. Грепнути `include: { \w+: true }` у service.ts, для кожного збігу прочитати `toDto`/return — якщо використовуються лише 2-3 поля related entity, замінити include на select projection
**Підхід до фіксу:** `include: { fk: true }` → `select: { ...neededFields, fk: { select: { name: true, ...neededFields } } }`. Якщо у scope є кілька relations — увесь top-level теж стає select. TypeScript авто-наведе вузький тип, toDto signature за потреби звузити
**Реальний impact:** ~30-50% менший row payload на wire (для UnitOfMeasure: 10 колонок → 3). За рік на середній СТО з 1000 запит-операцій × ~50 UoM records — ~150KB менше JSON serialization + менше V8 allocation pressure. Кумулятивно з backend кешем на reference-data — суттєвий
**Де шукати ще:** усі `include: { brand: true }`, `include: { unitOfMeasure: true }`, `include: { category: true }`, `include: { author: true }` що супроводжують toDto яка читає лише `.name`/`.shortName`/`.code`. Особливо ймовірно: catalog (goods.uoms), exchange-rates, services (work/good), comments (author), counterparties (settlementAccount)

---

### 2026-05-31 — Public widget без shared lib доступу — booking/embed сторінки що не імпортують `@/lib/format`

**Сигнал:** публічна сторінка-віджет (booking, signup, reset-password) — це чорний-box без авторизації що рендерить `.map()` зі слотами/датами через inline `toLocaleString` чи `toLocaleTimeString`. На відміну від звичайних сторінок, тут імпорт `@/lib/format` може бути небажаним (зайвий код у public bundle) або **здаватися** небажаним
**Причина виникнення:** автори widget-сторінок свідомо мінімізують залежності — навіть `lib/format` (~50 рядків коду) виглядає як «зайве, бо widget сам себе обслуговує». Але мінімальні `Intl.DateTimeFormat`/`NumberFormat` синглтони (3-5 рядків) можна оголосити локально, не імпортуючи нічого. Без них кожен slot рендериться через `toLocaleTimeString` що конструює форматер на місці
**Підхід до виявлення:** grep `toLocaleTimeString\|toLocaleString` у `apps/web/src/app/booking/`, `apps/web/src/app/(public)/`, будь-яких `*Widget.tsx`, `embed/*` сторінках. Якщо знайдено в `.map()` коллбеку — кандидат
**Підхід до фіксу:** оголосити module-level `const SLOT_TIME_FMT = new Intl.DateTimeFormat('uk-UA', { hour: '2-digit', minute: '2-digit' })` (або інший опції) **в тому самому файлі** — без імпорту з `lib/format`. Замінити inline `.toLocaleTimeString('uk-UA', {...})` на `SLOT_TIME_FMT.format(date)`. Bundle не росте бо `Intl` global, синглтон — 1 рядок коду
**Реальний impact:** booking widget з 24-48 slots × ререндери при зміні дати — 100+ конструкцій Intl → 1. Для public-сторінки де performance критична (повільні мобільні клієнти, embeds на сторонніх сайтах) це особливо важливо
**Де шукати ще:** будь-яка public widget сторінка; embed-сторінки що рендерять списки часу/дат; `not-found.tsx`/`error.tsx` що показують timestamps; будь-який `*.tsx` що НЕ можна або не варто залежити від `@/lib/format`

---

### 2026-05-31 — Private parent-guard helper блокує tier merger — `await this.assertX/getEditableX` як перший рядок hot-path методу

**Сигнал:** сервіс має приватний helper типу `getEditableWorkOrder(orgId, id)` / `assertCounterparty(orgId, id)` що робить parent.findFirst + business-rule check (status, isActive, deletedAt) і кидає виключення. Hot-path метод (addLine/addPart/updateLine/removeLine) починається з `await this.getEditableX(orgId, id)` — sequential — потім має `Promise.all([fk1, fk2])` parallel. Helper SEEM безпечним бо DRY, але він блокує tier merger: parent FK reads відбуваються в окремому RTT перед FK Promise.all
**Причина виникнення:** parent-guard helper це рекомендована практика DRY у NestJS (тестабельний, переюзний, чітка відповідальність). Розробник не помічає що `await helper(...)` створює sequential point: parent fetch блокує наступні незалежні FK reads. Це антипатерн «encapsulation locked optimization» — добра абстракція стає performance bottleneck у вузьких місцях. Особливо болить на hot-path WO/invoice/PO/SD редагуванні де кожен click = +1 RTT
**Підхід до виявлення:** для кожного hot-path методу (add/update/remove на дочірніх сутностях) перевірити чи перший await — це приватний helper-guard. Якщо так, прочитати helper: якщо він тільки робить parent.findFirst + sync business-rule check (без write/side-effect) — кандидат на inline merge. Helper можна СТЕРТИ або залишити для не-hot-path методів, а у гарячих — inline parent fetch у Promise.all з FK reads
**Підхід до фіксу:** inline parent.findFirst всередину `Promise.all([wo, fk1, fk2])`. Перевірки `if (!wo) throw NotFound` та business-rule (`if (!EDITABLE.includes(wo.status)) throw`) перенести ПІСЛЯ awaits — порядок повідомлень про помилку зберігається. FK reads все одно безпечні від cross-tenant (їхній where має orgId). «Зайва» FK read для невалідного wo — це 1 RTT тратиться даремно у НЕЩАСНОМУ випадку (wo missing або locked) — копійки порівняно з виграшем у НОРМАЛЬНОМУ. Helper можна видалити якщо більше не використовується (DRY-програш менший за perf-виграш на hot-path)
**Реальний impact:** для work-orders.addLine/addPart типового naryad-day flow (10+ edits на наряд) — кожен edit економить 1 RTT. На WAN 30-50ms × 10 edits × 5 нарядів на день = 1.5-2.5 сек збереження UI-латенсі на одного механіка. Recalc-помічники теж страждають від цього патерну
**Де шукати ще:** будь-який приватний `async assertX/getEditableX/findOrThrow` у сервісі — для кожного use-site перевірити чи це hot-path (frequent calls per user session). Часті місця: WO line/part editing, invoice line editing, PO line editing, SD line editing, calendar slot updates. Helper-методи `private async findActive...` — теж кандидати

---

### 2026-05-31 — Over-fetched many-to-one include для scalar-only consumer — `include: { brand: true }` коли тіло читає лише `entity.brandId`

**Сигнал:** `findMany`/`findFirst` має `include: { brand: true }` (або інший fkRelation) у запиті, але тіло методу/циклу читає лише foreign-key scalar — наприклад `line.good.brandId` чи `g.brandId` — без жодного звернення до `brand.name`/`brand.id`/`brand.x`. include тягне всю Brand row (orgId, createdAt, updatedAt, deletedAt, syncVersion + payload) лише щоб фронт-end-незалежний бекенд-розрахунок прочитав scalar який вже є на Good
**Причина виникнення:** при додаванні brand-aware логіки (`computePriceFromRules(... brandId)`) розробник природно додає `include: { brand: true }` щоб «протягнути brand зв'язок». Не помічається що brandId scalar вже є на Good — Brand row entirely unused. Particularly common у applyPricing / report builders / migration scripts де FK тільки для ID-based dispatch
**Підхід до виявлення:** для кожного `include: { brand: true }` (або brand/category/unitOfMeasure/supplier/currency single-row include) grep наступних 30 рядків тіла на `entity.brand.\w+` — якщо знаходить тільки `entity.brand` без властивостей АБО лише `entity.brandId` (scalar з parent table) — кандидат на видалення include
**Підхід до фіксу:** замінити `include` на `select` з narrow projection: явно перелічити всі поля parent entity що читаються + явно вказати які FK scalars потрібні (brandId, categoryId, etc.). Видалити nested include entirely. Wire payload падає 30-50% бо Brand record ~10 колонок проти 1 FK scalar
**Реальний impact:** на PO з 100 рядків кожен рядок мав `good.brand` join → 100 додаткових Brand rows × ~150 bytes JSON = ~15KB зайвого payload. На xlsx applyPricingFromList з 1000 goods — ще більше. Cumulative effect: менше bytes over the wire, менше V8 allocation pressure, менша time-to-first-byte на pricing endpoints
**Де шукати ще:** будь-який pricing/report/migration сервіс що приймає FK і дисtch'ить логіку на основі ID. Особливо часто: pricing.computeFromRules, applyPricing у PO/SD/xlsx, recommendation engines, tax calculators, loyalty earners. Перевіряти кожен новий «розрахунок з правил» — чи дійсно потрібен related entity object, чи лише його ID

---

### 2026-05-31 — Assignment/bulk-replace методи з findOne+FK guard sequential — `assignX(orgId, id, dto)` де findOne блокує FK перевірку

**Сигнал:** сервіс має `assignX(orgId, id, dto: {idList: string[]})` що починається з `await this.findOne(orgId, id)` (tenant guard на parent сутність) і далі робить `findMany({ where: { id: { in: dto.idList }, orgId, deletedAt: null } })` для cross-tenant FK validation. Обидва запити мають orgId у where, отже tenant-safe — але findOne блокує FK-перевірку. На відміну від «tenant guard + side-entity fetch» (там guard повертає той самий парент що використовується далі), тут результат findOne **не використовується** — він лише для 404
**Причина виникнення:** assign-методи на M:N relations (employee.zones, employee.lifts, employee.workCategories, employee.branches) — стандартний CRUD-патерн «replace assignments». Сприймається як «спочатку перевір що batьківський entity існує, потім перевір що дочірні існують». Розробник не помічає що ці перевірки незалежні: parent existence перевіряється однією findFirst (1 RTT), FK list — окремою findMany (1 RTT), і ці запити **не залежать один від одного** бо обидва читають за orgId і використовують ID з вхідних параметрів. На typical orgs з ~10 співробітників × 5 zones/lifts/branches = 50 assignment calls на тиждень, кожен економить 1 RTT
**Підхід до виявлення:** grep `await this\.findOne\(orgId, id\)` у service-методах де наступний рядок — це `prisma.X.findMany({ where: { id: { in: dto.\w+Ids } ... } })`. Якщо результат findOne використовується ТІЛЬКИ як guard (немає звернень до полів) — кандидат
**Підхід до фіксу:** `const [parent, items] = await Promise.all([prisma.parent.findFirst({...select: { id: true }}), dto.list.length ? prisma.child.findMany({...}) : Promise.resolve([])])`. Заміна findOne на findFirst з narrow select — DTO не повертається, лише id для 404. Перевірки `if (!parent) throw NotFound` + `if (items.length !== dto.list.length) throw` ПІСЛЯ Promise.all — порядок повідомлень про помилку зберігається. Конкретний DTO повертається через `findOne(orgId, id)` У КІНЦІ методу (вже після assignments) — тут sequential ОК бо потрібен повний DTO для response
**Реальний impact:** -1 RTT per assignX call. На employee форму з 4 assignment секціями (zones+lifts+workCategories+branches) — економія 4 RTT при кожному "Save". На WAN/VPN 30-50ms × 4 = 120-200ms покращення латенсі
**Де шукати ще:** будь-який `assignX/setX/replaceX(orgId, parentId, dto: {idList})` метод сервісу. Особливо часто: employee permissions/assignments, role permissions, vehicle owners, garage technicians, work-order tag assignments. Перевіряти кожен M:N relationship endpoint

---

### 2026-05-31 — Sequential `tx.X.create` loop у bootstrap/seed/init transaction — `createMany` пропущено для defaults

**Сигнал:** метод bootstrap/setup (setup.init, seed скрипти, fresh-org init) робить `for (const x of defaults) { await tx.X.create({ data: { orgId, ...x } }) }` у середині `prisma.$transaction`. На відміну від app-runtime fan-out (там можна параллелити поза tx через Promise.all), тут tx серіалізує запити на одному з'єднанні — параллельність не виграє. Виграє `createMany` — один SQL INSERT з N рядками
**Причина виникнення:** для-await з `tx.X.create` читається лінійно — особливо у setup-скриптах де кожна row має свій prefix/configuration block. Здається що це необхідно бо relationship setup (`tx.org.update(orgId: org.id)`). Але якщо рядки незалежні (немає FK chains між собою), createMany робить ОДИН INSERT з усім масивом — 1 RTT замість N. У bootstrap-транзакції що створює 13+ дефолтних рядків (8 doc-configs + 5 payment-methods) — суттєва економія
**Підхід до виявлення:** grep `for \(const \w+ of \w+\) { await tx\.\w+\.create\(` у service.ts. Перевірити чи тіло циклу — це лише `tx.X.create({ data: {...} })` без read-залежностей від попередніх iterations. Якщо так — кандидат. Особливо часто у setup, fresh-org init, fixture seeders
**Підхід до фіксу:** `await tx.X.createMany({ data: defaults.map(d => ({ orgId, ...d })) })`. createMany не повертає створені рядки (повертає `{count}`) — якщо потрібні IDs для наступних кроків transaction, лишити for-await або pre-generate UUIDs + createMany. У 90% setup сценаріїв створені рядки не потрібні відразу — createMany ОК. **Важливо:** createMany не підтримує relations у data — для cases з nested writes лишити for-await
**Реальний impact:** для setup.init (8 doc-configs + 5 payment methods) — 13 sequential creates → 2 createMany batches. На повільному disk у Docker з обмеженим CPU це 50-100ms економії, що відчутно на initial bootstrap UX. Аналогічно для будь-якого seed скрипту з 50+ рядків defaults
**Де шукати ще:** setup/init сервіси, fixture seeders, default-config injectors при створенні нового tenant/org/branch, bulk-import з контрольованими дефолтами (default permissions, default categories). Перевіряти при додаванні нової «нова org → дефолти» функції

---

### 2026-05-31 — JS aggregation у post-mutation recalc helpers — `findMany({ select: { amount: true } }).reduce(...)` для перерахунку totals

**Сигнал:** приватний helper типу `recalcTotals(parentId, tx)` робить `tx.X.findMany({ where: { parentId, orgId, deletedAt: null }, select: { amount: true }, take: 1000 })` потім `.reduce((s, l) => s + Number(l.amount), 0)`. Викликається після кожного add/update/remove на дочірніх сутностях (lines/parts/installments). На наряді з 20 рядками × 10 редагувань = 200 завантажень масиву + 200 JS reduce, хоча потрібен лише SUM
**Причина виникнення:** "перевантажити з БД у пам'ять і обчислити" — найзвичніший підхід коли треба порахувати total. `findMany + reduce` читається лінійно. Розробник не помічає що Postgres має `SUM()` що рахує те саме у БД і повертає 1 рядок замість N. Take:1000 створює false-sense-of-safety («бо є ліміт»), але навіть 1000 рядків × N edits = непотрібний row marshaling N×1000
**Підхід до виявлення:** grep `findMany.*select.*amount.*reduce` (або інші числові поля) у backend services. Для кожного збігу спитати: «це використання тільки для SUM/AVG/COUNT/MIN/MAX?» Якщо так — заміна на aggregate тривіальна. Особливо часто у helpers `recalcX`, `computeTotalY`, `updateBalance`, post-mutation hooks
**Підхід до фіксу:** `prisma.X.aggregate({ where, _sum: { amount: true } })` замість findMany + JS reduce. Result: `{ _sum: { amount: Decimal | null } }`. `Number(result._sum.amount ?? 0)` дає число. Для кількох агрегацій з різних таблиць — `Promise.all([aggX, aggY])`. Index покриває WHERE — Postgres зазвичай робить index-only scan або bitmap scan без читання heap для непотрібних колонок. Видалити `take` (для aggregate не потрібен — Postgres сам ефективно агрегує всі рядки що відповідають WHERE)
**Реальний impact:** для work-orders.recalcTotals (виклик на кожен add/update/remove line/part): 2× findMany(take:1000) + 2× JS reduce → 2× aggregate. Wire payload зменшується від 2× 1000 row × 4 bytes (Decimal) ≈ 8KB до 2× 1 row × 4 bytes ≈ 16 bytes. На наряді з активним редагуванням 10× recalcTotals — економія 80KB+ network + JS work. Найпомітніше у WO/PO/SD/Invoice де aggregates рахуються після кожного редагування рядка
**Де шукати ще:** будь-який helper з ім'ям `recalc*/compute*/update*Totals/refresh*Balance` що приймає parentId і `tx`. Аналогічно: COUNT-only лічильники (`findMany(...).length` → `count(...)`), MIN/MAX через сортування + take:1. Перевіряти кожен post-mutation hook що рахує метрики

---

### 2026-05-31 — Inline Intl.\* construction у `useEffect` loadData callback — page-mount setup-функції з 2-4 форматерами підряд

**Сигнал:** на сторінці-дашборді/звіті/головній page `useEffect(() => { ... }, [])` (mount-only) робить `const fmt = (d) => new Intl.DateTimeFormat(...).format(d)` хелпер всередині callback АБО прямі `new Intl.DateTimeFormat(...).format(now)` 2-4 рази підряд для різних форматів (today, monthStart, weekStart, greeting). Це не render hot-path і не `.map()`, але кожен mount = 4 нових форматер-інстансів які одразу викидаються
**Причина виникнення:** code-locality — форматер декларується поряд з використанням бо «це private до setup-логіки». Виглядає дешево бо викликається 1 раз за mount. Не помічається що: (a) користувач часто навігує до dashboard/reports per session (10-20 mount/day), (b) на SPA без full-reload кожен mount = full Intl init, (c) `loadData()` може повторно викликатись на refresh або з useCallback dep change. Сумарно: 40-80 unnecessary Intl-конструкцій на сесію тільки за один тип сторінки
**Підхід до виявлення:** grep `new Intl\.\(DateTimeFormat\|NumberFormat\)` у `apps/web/src/app/**/*.tsx`. Для кожного збігу перевірити: чи всередині `useEffect`/`useCallback`/`useMemo`? Якщо у render/`.map` — Кроки 2.8/2.10 (вже покрито). Якщо у `useEffect(..., [])` setup — це **інший** кандидат. Особливо коли поряд 2+ форматера з різними options
**Підхід до фіксу:** винести **всі** форматери у module-level `const` блок над компонентом. Local `kyivDate` helper переписати як thin `.format()` wrapper. Опції мають бути константні (TZ, locale, options object повністю static). Це уніфікує підхід frontend з backend (PDF service KYIV_DATE_FMT pattern). Bundle size не зростає бо Intl — global
**Реальний impact:** dashboard mount × 20/day × 4 форматерів = 80 alloc/day → 0 (alloc лише при initial module load). Найпомітніше на сторінках з multiple time/date logic (dashboard greeting + today/weekStart/monthStart + revenue chart range)
**Де шукати ще:** dashboard pages, reports pages, settings sub-tabs з date-range filtering, calendar setup. Будь-який `loadData`/`onMount`/`refresh` що поряд з API calls форматує дати для query params. Перевіряти при додаванні **нової** сторінки з date-aware loadData

---

### 2026-05-31 — Async wrapper-method блокує parallelism викликача — `calculateX(... )` що сам тягне rules перед чистим compute

**Сигнал:** hot-path сервіс (приклад: `batch.createFromReceipt`) робить `entity = await prisma.X.findFirst(...)` потім `result = await this.other.calculateY(entity.fields, costPrice)`, де `calculateY` внутрішньо починає з `prisma.rules.findMany(...)`. Виглядає лінійно і чисто: знайди entity, передай у калькулятор. Насправді entity fetch і rules fetch — обидва незалежні від результату одне одного, отже мають бути паралельними. Сервіс уже має pure-compute helper (`computeYFromRules(rules, ...inputs)`) + async rule-source helper (`getActiveRulesForOrg`) — інкапсуляція доступна, її просто не використовують в hot-path
**Причина виникнення:** «один API метод який все робить» — оригінальна абстракція. Викликач не знає про правила, він просто хоче відповідь. Паралелізація вимагає викликача знати про два внутрішніх helper'и (rules fetch + sync compute) замість одного wrapper. Розробник у hot-path виборав DRY (`await this.pricing.calculateSalePrice(...)`) над perf. **Pre-existing extraction** — patterт «Pure compute extraction» (2026-05-30) — створив helper'и, але hot-path call-site їх не використовує
**Підхід до виявлення:** для кожного hot-path методу прочитай чи перший `await` — це wrapper-метод іншого сервісу що повертає `Promise<number>`/`Promise<X>`. Якщо такий wrapper існує, перевір чи сервіс має ДВА окремих helper: async data-source + sync compute. Якщо так — wrapper можна **inline'нути** у Promise.all з основним entity fetch
**Підхід до фіксу:** `const [entity, rules] = await Promise.all([prisma.X.findFirst(...), this.other.getRulesForY(orgId)])`. Далі sync `this.other.computeYFromRules(rules, entity.fields, costPrice)`. Wrapper-метод `calculateY` НЕ видаляти — він потрібен для одиничних викликів де rule fetch overhead копійки. Hot-path inline'ить компоненти
**Реальний impact:** -1 RTT per hot-path call. На batch.createFromReceipt (викликається при кожному прийомі товару — приймальні, інвентаризації, повернення) — типово 10-50 викликів на день × 30ms RTT = 300ms-1.5s збереження UI-латенсі. Sequential read-фаза одна з двох RTT, тепер one parallel
**Де шукати ще:** будь-який hot-path сервіс що викликає external/async wrapper-калькулятор. pricing, tax, discount, loyalty earn, commission, validate — всі мають pure-compute extraction; перевір чи всі викликачі використовують extraction або wrapper. Якщо змішано — wrapper-калькулятори лишилися як «зручні» в hot-path, паралель не досягнуто

---

### 2026-05-31 — 3rd-party UI lib props rebuilt each render — DayPicker/Combobox/Table з inline classNames/disabled/columns

**Сигнал:** компонент-обгортка над сторонньою UI-бібліотекою (DayPicker, React-Table, Combobox, MultiSelect) передає inline object/array літерал як props (`classNames={{...}}`, `disabled={[{before:...}, {after:...}]}`, `columns={[{header:...}, ...]}`). Лібка всередині має `useMemo` що diff-ить ці props по reference. Кожен ререндер батька → новий object reference → memoization інвалідується → бібліотека re-обчислює внутрішню data-structure (матриця днів, sort/filter, virtualized rows)
**Причина виникнення:** code-locality — конфіг props пишеться поруч з JSX. classNames object виглядає readonly («це константи»), але JS все одно створює новий object на кожен виклик функції-компонента. Розробник не помічає бо UI працює коректно — продуктивність буває помітна тільки на повільних мобільних пристроях або при частих ререндерах батька (search/filter)
**Підхід до виявлення:** для кожного UI-компонента що обгортає external lib (особливо ті що дисплеять колекції/grids/matrices), переглянути props: object literal? array literal через push()? `cn(...)` поверх кожного key? Якщо props великий і **похідний від stable inputs** — hoisтуй у module-level const або обгорни в `useMemo([deps])`. Особливо: `classNames`, `style`, `options`, `disabled`, `columns`, `rows`, `data`
**Підхід до фіксу:** statically-known props → module-level `const DAY_PICKER_CLASS_NAMES = {...}` поза компонентом (один alloc на module load). Props що залежать від render input → `useMemo(() => [...], [dep1, dep2])`. Якщо в значенні є `cn(...)` чи інший виклик funcції — теж обгорнути у useMemo (cn не безкоштовний, і його результат — новий string). Перевірити що props не змінюються випадково (eg `cn(static-classes)` повертає той самий string, але виклик кожен раз робить роботу)
**Реальний impact:** для DatePicker з 35-42 днями × ререндери батька (form change, validation) — без memoization кожен ререндер передраховує matchers і весь сітковий grid. З memoization — only at min/max change. Для table-grids з 50+ columns × 100+ rows — драматично (cells мають свою memoization що сильно залежить від stable columns array)
**Де шукати ще:** будь-який `*.tsx` що оголошує component-wrapper над external UI lib. DatePicker (react-day-picker), Table (TanStack Table), Combobox (Headless UI), Select (react-select), Tree, Charts (recharts). Перевіряти при кожному додаванні нового UI-обгортки

---

### 2026-05-31 — List item component без React.memo + inline callback — toggle expansion/selection у списку

**Сигнал:** компонент-рядок у `.map()` приймає stable primitive props (`{batch, expanded, onToggle, depleted}`) і **не обгорнутий у `memo`**. Батько передає `onToggle={() => setExpandedId(...)}` inline — нова функція на кожен ререндер → memo не врятує (props різні). Користувач клік на один рядок → setState змінює тільки `expandedId` → батько ререндериться → всі N рядків ререндеряться попри непомітну зміну. Особливо болить коли N>10 або всередині рядка є expensive computation (format, useMemo, nested map)
**Причина виникнення:** memo сприймається як «оптимізація для пізніше». Inline callback виглядає чистим у JSX. Якщо рядок простий (одна div + text), memo не дає виграшу. Але як тільки рядок отримує expanded-section з grid/aggregations, кожен зайвий ререндер коштує. Розробник не помічає бо UI не «лагає» візуально — затримка ~1-2ms × 20 рядків = 20-40ms додаткового рендеру на клік
**Підхід до виявлення:** для кожної сторінки-списку (table, grid, accordion, virtualized list) знайти інлайн-компонент-рядок (`Row`/`Card`/`Cell`/`Item` в тому ж файлі). Якщо рядок: (a) приймає primitive/stable props, (b) використовується у `.map()`, (c) рендерить більше ніж тривіальний JSX — кандидат на memo. Парно: батько передає event handlers inline (`onClick={() => ...}`)? — їх теж треба `useCallback` для memo щоб спрацювало
**Підхід до фіксу:** `const Row = memo(function Row({...}) {...})`. Inline callback на батьку → `const handleX = useCallback((id) => setX(prev => prev === id ? null : id), [])`. Передавати `id` параметром у callback (не closure через map-scope) — це робить callback stable незалежно від ітерації. Перевірити що всі props — primitive або memoized (massive arrays через useMemo). Якщо рядок має внутрішні `.filter()`/`.map()` що залежить від props.list — теж useMemo
**Реальний impact:** для batch-viewer modal з 5-20 активних батчів + 0-20 вичерпаних: клік на «expand» → раніше всі 20-40 рядків ререндерились; тепер 1-2 (новий + старий expanded). Multiplier × частота кліків × deep nested JSX = відчутна UI responsiveness. Найпомітніше на повільних пристроях (планшет механіка, mobile)
**Де шукати ще:** modal-и з accordion/expansion (BatchViewerModal, FollowUpModal, MaintenanceScheduleModal), table-rows з selection (employees, work-orders list), card-grids (calendar slots, dashboard widgets). Перевіряти при додаванні **нового** списку-компонента у `.tsx` — це системно повторюваний патерн

---

### 2026-05-31 — Sequential cron-/scheduler queue.add у onModuleInit — N-orgs scheduler enqueue блокує application bootstrap

**Сигнал:** OnModuleInit hook (типу `FollowUpScheduler`, `ReminderScheduler`, периодичний bootstraper) проходить `for (const org of orgs) { await this.queue.add('job', ..., { repeat: cron, jobId: \`x-\${org.id}\` }) }`. Кожен `add`— Redis RTT з ioredis. На on-prem (1 org) — no-op. На multi-tenant cloud з 100-1000 orgs — application startup блокується на N×RTT доки всі repeatable jobs зареєструються
**Причина виникнення:** OnModuleInit виглядає «один раз на старт — sequential ОК». Не помічається що: (a) cloud multi-tenant deploy з 1000 orgs може давати 30-50 секунд startup latency (1000 × 30ms RTT), (b) Kubernetes/Docker healthcheck має короткі timeouts (5-10s) — pod marked unhealthy ДО завершення scheduler bootstrap. Це не runtime фан-аут (як webhook delivery), а startup ledger — але семантично той самий патерн
**Підхід до виявлення:** grep`OnModuleInit`+`for (const \w+ of \w+) { await this\.\w+Queue\.add`у backend. Якщо в тілі циклу —`queue.add`без cross-iteration dependencies (jobId унікальний per org/entity) — кандидат на паралелізацію
**Підхід до фіксу:**`await Promise.all(items.map(item => queue.add(..., { jobId: \`x-\${item.id}\`, repeat: cron, ... })))`. BullMQ deduplicates by jobId — paralel add робить N concurrent Redis multi/exec calls (Bull internally pipelines через ioredis), фінальний стан стейту черги idempotent: всі jobs зареєструються рівно один раз. Failure одного не валить інші (хоча тут зазвичай want fail-fast — Promise.all семантика підходить, при rejection pod-у не вдасться стати ready що коректно)
**Реальний impact:** cloud з 1000 orgs: 30s sequential startup → 1-2s parallel. На on-prem незмінно (1 org). Окремо — ефект на dev: rapid file-change cycle (hot-reload модуля): кожне перевантаження більше не чекає 1000 RTT
**Де шукати ще:** будь-який scheduler/cron bootstraper (notifications, reminders, sync, dump-rotation), DI lifecycle hooks що масово ініціалізують ресурси. Перевіряти при додаванні нової @Cron-задачі що per-org

---

### 2026-05-31 — PDF/export endpoints over-fetch via include — generatePdf методи з повним include для render data

**Сигнал:** `async generatePdf(orgId, id)` / `async exportX()` робить `findFirst({ where, include: { lines: {...}, parts: {...}, counterparty: true, organisation: findFirst({ where: { id }}) } })`. PDF/CSV render використовує лише 5-10 scalar полів per row (description, quantity, price, amount, name). Раніше include тягнув всі колонки (id/orgId/createdAt/updatedAt/syncVersion/deletedAt + business поля які не показані у PDF: costPrice/sortOrder/branchId/cashRegisterId/discount). На PDF з 500 lines × 20 колонок = 10000 cells over-fetched
**Причина виникнення:** PDF generation був написаний коли include був простіший («тягни все, потім сортуй у JS»). Як шаблон PDF стабілізувався, авторам не приходило в голову переглянути запит — він і так "робить роботу". Особливо часто: `this.prisma.organisation.findFirst({ where: { id: orgId } })` БЕЗ select — тягне 15+ settings колонок коли PDF використовує лише `name`. PDF це side-flow (не hot-path UI), тому review агенти його не зачіпали
**Підхід до виявлення:** для кожного `generatePdf`/`generateXlsx`/`export*` методу прочитати скільки полів реально використовується в return docDef.body / output.cells (`.map(l => ({ description: l.X, quantity: l.Y, ... }))`). Якщо менше за 50% колонок — кандидат. Особливо `findFirst({where:{id:orgId}})` без select для organisation — це стабільний сигнал over-fetch (15+ unused settings columns)
**Підхід до фіксу:** замінити `include` на `select` з точним переліком полів що рендеряться у docDef. organisation findFirst → `select: { name: true, edrpou?: true, address?: true }`. lines/parts include → `select: { description, quantity, unitPrice, amount, ... + nested narrow projection for related entity name only }`. Lines/parts type signatures для приватних `buildLines()` хелперів треба звузити одночасно (TypeScript наведе на необхідну зміну)
**Реальний impact:** payload з 500-row PDF: ~50KB → ~15KB (зменшується overhead serialize + memory pressure у pdfmake docDef build). Кумулятивно на день генерації 50-100 PDF — суттєва економія DB → API memory transfer. Бонус: явний select показує що ДІЙСНО потрібно у PDF — якщо нове поле треба додати, помітно одразу
**Де шукати ще:** усі PDF generators (`generateInvoicePdf`/`generateCompletionActPdf`/`generateReconciliationActPdf`/`generateWorkOrderPdf`), xlsx exporters, csv exporters, report generators. Перевіряти кожен новий PDF/export endpoint при додаванні. Перевіряти `findFirst({where:{id:orgId}})` для organisation БЕЗ select — це маркер для запиту-без-проекції що тягне всі settings

---

### 2026-05-31 — Clone/duplicate операції з ID-only create патерном — `clone(id)` що include тягне labels що НЕ використовуються у create

**Сигнал:** `async clone(orgId, id, userId)` / `async duplicate(...)` робить `findFirst({ include: { related: { select: { name: true } }, lines: { include: { fk: { select: { name: true } } } } } })` — include тягне related entity labels (work.name, employee.firstName/lastName, good.name, vehicle.make/model). Далі у `create({ data: { ...original (FK scalars), lines: { create: original.lines.map(l => ({ workId: l.workId, ... })) } } })` НЕ використовуються related labels — лише FK ID scalars. labels тягнулись з якоїсь історичної причини (можливо для логування), не для create
**Причина виникнення:** clone-методи часто пишуться як «знайди original з усіма зв'язками → створи новий з тих самих полів». Розробник копіює `include` з findOne (бо «треба ж все знати про original»), не помічаючи що `.map(l => ({...}))` бере лише ID scalars. Labels це pre-fetch для майбутнього використання якого ніколи не сталося — або ж потрібно для audit log, але audit log читає лише `cloned.number` та `original.number` (з parent WorkOrder, не з lines/parts)
**Підхід до виявлення:** для кожного `clone`/`duplicate`/`copyOver` методу прочитати тіло після findFirst → перевірити чи `.map(...)` всередині `create.data.X.create` використовує тільки `.id`/`.xId` scalars. Якщо так — include на nested `work/employee/good/vehicle` (для лейблів) дармовий
**Підхід до фіксу:** замінити include на narrow select що залишає ЛИШЕ FK scalars + business поля що йдуть у create (price/quantity/normoHours/amount/notes). Видалити related entity nested select entirely. AuditEvent extra payload — тільки parent-level fields (original.number, cloned.number) — ці поля лишаються у top-level select. Бонус: docNumbers.next можна додати у Promise.all з FK validation — він не залежить від original, але блокував sequential після
**Реальний impact:** для clone WO з 20 lines + 30 parts: include тягло 20 work labels + 20 employee labels + 30 good labels + UoM = ~80 додаткових scalar reads + JSON serialization → 0. На повільному WAN — економія ~50-100ms per clone. Найпомітніше у роботі з масивними нарядами (DRAFT clone під час швидкого створення повторних візитів). Параллелизація docNumbers.next додатково -1 RTT
**Де шукати ще:** будь-який clone/duplicate/createFromX метод сервісу. Особливо часто: work-orders.clone, invoices.createFromWorkOrder, completion-acts.createFromWorkOrder, calendar-slots.duplicate, work-order-templates.applyToWorkOrder. Перевіряти при додаванні нової «копіювати з існуючого» операції

---

### 2026-05-31 — `similarity()` обчислюється кілька разів per row у $queryRaw search — pg_trgm `%` оператор vs `similarity() > threshold`

**Сигнал:** raw SQL search query використовує `similarity(col, $q) > 0.1` у WHERE І `ORDER BY similarity(col, $q) DESC` у тому ж запиті. Postgres не може дедуплікувати — обчислює `similarity()` двічі per row. Для multi-column пошуку (firstName+lastName+companyName) це може бути 4-6 викликів `similarity` per row. Окремо: `similarity() > threshold` робить sequential scan, бо planner не використовує GIN trgm index для **обчислення** similarity — індекс підтримує тільки оператори `%`, `<%`, `<<%`
**Причина виникнення:** `similarity()` функція виглядає природньо для search — explicit threshold + ORDER BY за тим самим score. Розробник не знає що `%` оператор (`pg_trgm`) **використовує** GIN trgm index, а `similarity()` без оператора — НЕ використовує. На малих таблицях (< 1000 рядків) різниця непомітна, на 10k+ рядків — sequential scan на кожне натискання клавіші у command palette
**Підхід до виявлення:** grep `similarity(` у `.service.ts` що використовує `$queryRaw`. Для кожного збігу полічити кількість викликів per query (WHERE + ORDER BY + кілька колонок). Якщо ≥2 — кандидат на subquery rewrite. Окремо перевірити WHERE: якщо `similarity() > N` замість `col % $q` — індекс не використовується, навіть якщо він є
**Підхід до фіксу:** subquery або CTE винесе обчислення `similarity()` як column → ORDER BY читає pre-computed value. WHERE замінити на `col % $q` (set-similarity operator) — planner використовує GIN trgm index для filter; ще раз перевіряти `sim > 0.1` у outer query для довизначення threshold. Multi-column: окремі sim_X colonки + GREATEST(...) для ORDER BY. Для goods з aggregate stock — CTE pre-filter goods (мала вибірка) → LEFT JOIN stock_items → GROUP BY
**Реальний impact:** для search палітра що викликається на кожен keystroke (з debounce 300ms): sequential scan з 10000 рядків × 6 викликів similarity → index scan з GIN trgm + 1 обчислення similarity per matched row. Типово 10-50ms → < 5ms. На UI: search-results з'являються миттєво замість 100-300ms лагу
**Де шукати ще:** будь-який $queryRaw з `similarity(` або `LIKE '%pattern%'` що проганяється через index-aware operator. Особливо часто: command palette search, autocomplete dropdowns, full-text search across multiple tables. Перевіряти `% оператор` коли є GIN trgm індекс

---

### 2026-05-31 — Speculative duplicate-check у tier-merger update — коли значення-для-порівняння живе в existing row

**Сигнал:** метод `update(orgId, id, dto)` має класичний "оптимізований" 2-фазний паттерн: (1) findFirst для existing, (2) IF dto.field !== existing.field — findFirst для duplicate-check. Друга фаза умовна на результат першої — тому здається що тут НЕ МОЖНА паралелити. Але duplicate-check фактично читає за **новим значенням з DTO** (а не за existing) — отже не залежить ВІД РЕЗУЛЬТАТУ existing, лише від того чи треба його робити взагалі
**Причина виникнення:** "не робити запит якщо не треба" — економний інстинкт. Проте duplicate-check на warm-cache — це індекс-hit на unique constraint (~1ms). Платити 1ms даремно у 5% випадків коли DTO повторює існуюче значення — дешевше за втрату 1 RTT (~30ms) у 95% коли значення дійсно змінилось
**Підхід до виявлення:** метод update з patterной "if (dto.X && dto.X !== existing.X) { findFirst duplicate-check }". Перевірити чи duplicate-check where використовує DTO значення (а не existing) — якщо так, кандидат на speculative parallel. Особливо часто: unique-code reference data (currencies/units/brands), unique-key з дати (exchange-rates), name-уникальність (tax-rate, payment-method)
**Підхід до фіксу:** speculative — запустити duplicate.findFirst у Promise.all з existing.findFirst незалежно від того чи `dto.X !== existing.X`. ПІСЛЯ awaits — звичайна перевірка `if (dto.X && dto.X !== existing.X && duplicate) throw Conflict`. Якщо duplicate-check читає за compound key (orgId+currencyId+date), і dto має лише date — широчити where до `{orgId, date}` без currencyId, потім фільтрувати `duplicate.currencyId === existing.currencyId` ПОСТ-факто. Це робить запит трохи ширшим, але не unsafe (unique index покриває обидва — Postgres все одно швидко знаходить)
**Реальний impact:** -1 RTT у happy-path (95%+ випадків). Для reference-CRUD admin сторінок (currencies/exchange-rates/tax-rates) — латенсі update падає з 100-150ms до 50-80ms (на WAN). Cache.del лишається синхронним після, не змінюючи pattern
**Де шукати ще:** будь-який update що має умовну duplicate-check логіку (типово unique-constraint reference data). Особливо: currencies.update, exchange-rates.update, tax-rates.update, payment-methods.update, units.update, brands.update. Перевіряти кожен endpoint що повертає 409 Conflict (це маркер унікального констрейнту)

---

### 2026-05-31 — `findOne + update` 2-RTT pattern для simple soft-delete/update — заміна на `updateMany` з orgId guard

**Сигнал:** простий CRUD-сервіс має `async update(orgId, id, dto)` що робить `await this.findOne(orgId, id)` (404 guard через findFirst) → `await prisma.X.update({ where: { id, orgId }, data: {...} })`. Те саме для `remove(orgId, id)` — soft-delete. 2 RTT для операції що могла би бути 1
**Причина виникнення:** `findOne + update` патерн природний бо findOne робить tenant guard + 404 throw. Розробник не знає що `updateMany` дозволяє tenant guard у WHERE: rows що не належать orgId не оновлюються, `count` повертає 0 → можна кинути 404. На відміну від `update`, який кидає P2025 при відсутності — це менш юзабельно, бо exception type leak з Prisma. `updateMany` обходить це
**Підхід до виявлення:** для кожного service `update`/`remove` методу прочитати чи перший await — це `findOne`/`assertX` що повертає DTO **який не використовується далі** (тільки як guard). Якщо так — 1-RTT кандидат. Особливо часто у простих CRUD моделях без relations (templates, settings, configs)
**Підхід до фіксу:** `await prisma.X.updateMany({ where: { id, orgId, deletedAt: null }, data })` → `if (updated.count === 0) throw NotFoundException`. Для `update` що має повернути updated row — додати окремий findFirst після (це все одно 2 RTT, але тенант-safe + чіткіше відлювлення 404). Для `remove` (void return) — справді 1 RTT. Для soft-delete (`data: { deletedAt: new Date() }`) — той самий патерн
**Реальний impact:** для CRUD update/delete що викликаються 10-50 разів на сесію (settings, templates, configs) — економія 10-50 RTT. На повільному WAN 30-50ms × 50 = 1.5-2.5 sec UI latency покращення. Найпомітніше у адмінських flow (settings page, infrastructure manage, catalog edit)
**Де шукати ще:** будь-який сервіс з простими CRUD (без relations що потрібні у відповіді). Особливо: templates, configs, settings, infrastructure (branches/zones/lifts/warehouses), catalog (units/brands), reference data. Перевіряти при додаванні нового CRUD endpoint — або відразу писати updateMany патерн

---

## Що вже оптимізовано (не повторювати)

**Backend:**

- ✅ CORS preflight cache: `enableCors({ maxAge: 86400 })` — браузер кешує OPTIONS, ~50% менше RTT в dev
- ✅ CacheService + Redis TTL 300s: branches, warehouses, zones, lifts, work-categories, brands, units, payment-methods, currencies, bank-accounts, cash-registers
- ✅ Dashboard cache 25s TTL
- ✅ Reports: $queryRaw GROUP BY замість JS aggregation (revenue/workOrders/profitability — всі 3 hot reports)
- ✅ DashboardService.getSummary: Promise.race 8s timeout на кожен sub-query (slow PG → null → 0, не валить tick)
- ✅ Dashboard SSE: Throttle 5 connections / 60s — лімітує лише нові connect, не data stream
- ✅ PurchaseOrders.receive: tx timeout 30s (для великих PO з сотнями рядків × batch tracking)
- ✅ PrismaService: explicit `datasourceUrl` з `connection_limit=25` + `pool_timeout=20` (operator override через env працює)
- ✅ Purchase-orders list без lines
- ✅ Employees: `select: { xId: true }` замість `include: true`
- ✅ Invoices create: parallel Promise.all
- ✅ CompletionActs create: parallel Promise.all
- ✅ Calendar createSlot/updateSlot: parallel FK validation (Promise.all)
- ✅ Work-orders addLine: parallel work+employee findFirst (2 RTT → 1)
- ✅ Work-orders addPart: parallel good+warehouse findFirst (2 RTT → 1)
- ✅ Warranties create: parallel wo+cp+line+part FK validation (4 RTT → 1)
- ✅ Services create/update: parallel works+goods FK validation in tx
- ✅ Settlements-account createReconciliationAct: parallel counterparty+account
- ✅ Invoices addLine: parallel good+work FK validation
- ✅ Completion-acts generatePdf: parallel org+wo fetch
- ✅ Payments create: merge duplicate workOrder findFirst (branchId+status in one select)
- ✅ Maintenance-schedules updateAfterWorkOrder: parallel per-schedule update (Promise.all map)
- ✅ Webhooks publish: parallel queue.add for all endpoints (Bull pipelines)
- ✅ Booking getAvailability: parallel lifts + busy slots + work durations (3 RTT → 1)
- ✅ Reports stock: parallel stockItems + stockMovements findMany
- ✅ Reports revenue: KYIV_DATE_FMT module-level Intl singleton (раніше per-row у 10k loop)
- ✅ PDF service: UAH_FMT/UA_DATE_FMT module-level Intl singletons (раніше per .map() cell)
- ✅ xlsx importPOLines/importSDLines/importWOParts: bulk lookupGoodsBulk + existing lines IN-prefetch (N+1 → 2 RTT)
- ✅ xlsx applyPricingFromList: prefetch pricing rules once + sync computePriceFromRules (раніше N×fetch правил)
- ✅ stock-documents create: 3-FK Promise.all з conditional targetWarehouse (3 RTT → 1)
- ✅ loyalty getBalance/getTransactions: parallel counterparty guard + loyaltyAccount (-1 RTT)
- ✅ inspection findByWorkOrder: parallel WO guard + inspectionReport (-1 RTT)
- ✅ pricing-rules create/update: parallel goodId + brandId FK validation (+ tenant guard merged for update)
- ✅ goods create: parallel sku-uniqueness check + validateFkReferences (2 RTT → 1)
- ✅ goods update: parallel findOne tenant guard + sku-uniqueness + FK validation (3 RTT → 1)
- ✅ invoices updateLine/removeLine: parallel invoice + invoiceLine fetch (-1 RTT per call)
- ✅ invoices createFromWorkOrder: parallel workOrder + duplicate-invoice check (-1 RTT)
- ✅ invoices addLine: collapsed «invoice-then-parallel good+work» into single Promise.all (-1 RTT)
- ✅ goods getUoMs/addUoM/setDefaultUoM/removeUoM/getBarcodes/createBarcode: same-aggregate parent+child + dup+count parallelized (-1..-2 RTT each)
- ✅ goods UoM `include: { unitOfMeasure: true }` → `select: { name, shortName, coefficient }` (4 sites) — drops orgId/createdAt/syncVersion/decimals over-fetch
- ✅ exchange-rates create: currency FK + duplicate-row check у Promise.all (-1 RTT)
- ✅ works/work-categories update: tenant guard + optional FK check у Promise.all
- ✅ counterparties findGarages/removeGarage: parent (CP) + child (garage) у Promise.all (-1 RTT)
- ✅ vehicles findNodes/removeNode: parent (vehicle) + child (node list/fetch) у Promise.all (-1 RTT)
- ✅ inspection create: WO guard + @@unique inspectionReport check у Promise.all (-1 RTT)
- ✅ work-orders addLine/addPart: tier merger — wo (parent-guard) + work/employee/good/warehouse у єдиний Promise.all (3 RTT → 1); helper getEditableWorkOrder inlined → removed
- ✅ work-orders updateLine/removeLine/updatePart/removePart: same-aggregate parent (WO) + child (line/part) у Promise.all (-1 RTT each)
- ✅ work-orders recalcTotals: findMany(take:1000) + JS reduce → prisma.aggregate({\_sum: amount}) — Postgres рахує SUM, повертає 2 числа замість 2000 рядків
- ✅ loyalty redeem: assertCounterparty + organisationSettings у Promise.all (-1 RTT)
- ✅ purchase-orders applyPricing + xlsx applyPricingFromList: include: { brand: true } → select narrow projection (Brand record entirely unused — only brandId scalar read)
- ✅ settlements-account generateReconciliationPdf: act + organisation у Promise.all (-1 RTT)
- ✅ brands.update: tenant guard + duplicate-name check у Promise.all (-1 RTT)
- ✅ settings.updateOrganisation: org guard + optional bankAccount FK validation у Promise.all (-1 RTT)
- ✅ warranties.autoCreate: WO guard + idempotent existing check у Promise.all (-1 RTT post-WO COMPLETED hook)
- ✅ warranties.claim: warranty tenant guard + claimWo FK validation у Promise.all (-1 RTT у happy path)
- ✅ employees.assignZones/Lifts/WorkCategories/Branches: parallel tenant guard + FK validation (-1 RTT each)
- ✅ notifications.send: parallel branchSettings + notificationTemplate (-1 RTT per fan-out)
- ✅ document-number.next: hoist KYIV_YEAR_MONTH_FMT module-level Intl singleton (called on every doc# generation)
- ✅ settlements-account: hoist KYIV_HOUR_FMT for kyivStartOfDay/EndOfDay (createReconciliationAct: 2 allocs → 0)
- ✅ reports.kyivOffsetMs: hoist KYIV_HOUR_FMT module-level (normalizeDateRange: 2 allocs → 0)
- ✅ calendar.kyivOffsetMs: hoist KYIV_HOUR_FMT module-level (findSlots/createSlot: 1 alloc → 0)
- ✅ setup.init: for-await tx.documentNumberConfig.create + tx.paymentMethodConfig.create → tx.createMany (13 RTT → 2)
- ✅ payments.create: hoist UAH_AMOUNT_FMT Intl.NumberFormat for SMS amount payload
- ✅ booking.create: hoist UA_DATE_FMT Intl.DateTimeFormat for SMS confirmation date
- ✅ followup.processor: settings + branch findFirst parallel + hoist UA_DATE_FMT for per-schedule SMS date (hot daily-tick)
- ✅ followup.scheduler.onModuleInit: for-await queue.add → Promise.all map (cloud N-orgs startup)
- ✅ audit.findByEntity: include user → narrow select projection (drop orgId/entityType/entityId/userId over-fetch)
- ✅ batch.createFromReceipt: parallel good.findFirst + pricing.getActiveRulesForOrg + sync computePriceFromRules (раніше wrapper calculateSalePrice блокував — sequential 2 RTT → parallel 1 RTT)
- ✅ inventory.updateMinStock: findFirst (404 guard) + update → updateMany з orgId+deletedAt + count check (2 RTT → 1)
- ✅ pricing.applyRuleToGoods: goods.findMany + pricingRule.findMany (allRules) — sequential → Promise.all (2 RTT → 1)
- ✅ invoices.generatePdf: include → narrow select (drop syncVersion/orgId/branchId/sortOrder/priceWithoutVat/vatAmount; reuse uoMshortName що раніше тягнули але хардкодили 'шт')
- ✅ work-orders.generatePdf: include → narrow select (drop costPrice/description/sortOrder/orgId per row × 1000 take)
- ✅ completion-acts.findOne + generatePdf: workOrder.lines/parts include → narrow select; org findFirst() без select → { name: true } (раніше тягнуло всі settings/syncVersion/logoUrl)
- ✅ settlements-account.generateReconciliationPdf: act.include → narrow select (drop id/orgId/createdAt/syncVersion); organisation findFirst() без select → { name: true }
- ✅ work-orders.clone: include тягнув vehicle/counterparty/branch labels + lines.work/employee + parts.good/UoM — все НЕ використовується (clone оперує FK scalars); docNumbers.next додано у Promise.all з 3 FK validation (4 RTT → 1)
- ✅ search.workOrders/Counterparties/Goods: similarity() рахується 2-4 рази per row у raw SQL — subquery/CTE для pre-computed sim column + `%` оператор (pg_trgm set-similarity) замість `similarity() > threshold` — GIN trgm index реально використовується (seq scan → index scan)
- ✅ work-order-templates update/remove: findOne + update sequential (2 RTT) → updateMany з orgId guard + count===0 404 check (1 RTT)
- ✅ sync.getStatus: lastJob.findFirst inlined у Promise.all з counts+aggregates (раніше sequential post-Promise.all; -1 RTT для sidebar widget)
- ✅ bank-accounts/cash-registers.update: tier-merger — existing tenant guard + FK validation у єдиний Promise.all (3 RTT → 1 RTT, select narrow projection лише id/branchId за потреби кеш-інвалідації)
- ✅ currencies.update: tier-merger — existing(select code) + speculative duplicate-code check у Promise.all з post-filter NOT id (2 RTT → 1 RTT)
- ✅ exchange-rates.update: tier-merger — existing + speculative duplicate-date check у Promise.all (без currencyId у duplicate where — post-filter currencyId match) (2 RTT → 1 RTT)
- ✅ maintenance-schedules.remove: findFirst + soft-delete update → updateMany з orgId guard (2 RTT → 1)

**Frontend:**

- ✅ useDebounce(300ms) на 8 сторінках (work-orders, crm, invoices, purchase-orders, inventory, employees, catalog ×3)
- ✅ next/dynamic recharts: dashboard (235→124kB), reports (269→149kB)
- ✅ sessionStorage ref-cache: branches, warehouses, zones, lifts, work-categories, brands, units, suppliers, wo-templates, currencies, bank-accounts, works
- ✅ WO detail card (`/work-orders/[id]`): works/employees/warehouses seeded from ref-cache — повторні відкриття карток 0 RTT для довідників
- ✅ Calendar branches: ref-cache seed (читач) — узгоджено з consumer-pattern
- ✅ Catalog Units/Brands tabs (source pages): seed + warm ref-cache → instant first-paint при перемиканні вкладок
- ✅ infrastructure (source page): warm ref-cache (branches/zones/lifts/warehouses) → пропагація правок споживачам
- ✅ settings/page.tsx: parallel Promise.all for currencies+rates+bank-accounts+cash-registers+org-info
- ✅ settings/page.tsx: branches seeded from `cache:branches` ref-cache (workdays tab instant render)
- ✅ SW: skipWaiting після precache; API routes не кешуються
- ✅ Promise.all parallel fetches на 9 сторінках
- ✅ GET dedup в api-client.ts (без AbortSignal)
- ✅ React.memo + useMemo Map: DraggableSlot, DroppableLiftRow (calendar)
- ✅ calendar: module-level Intl.DateTimeFormat singletons (kyivHours/fmtTime/toDateString) замість per-call construction
- ✅ calendar TimeSelect: per-render new Date().getMinutes() → nowMs-derived minMinute prop
- ✅ CRM loadGarages: waterfall → staged parallel
- ✅ WO detail: loadComments+Media+Audit → loadSecondary Promise.all
- ✅ img lazy loading + decoding="async"
- ✅ work-orders/[id] load(): WO + completion-acts + inspection → Promise.all (3 fire-and-forget → 1 batch, з explicit error fan-out)
- ✅ work-orders/[id] handleMediaUpload: sequential for-await → Promise.allSettled (5 files: ~10s → ~2.5s)
- ✅ lib/format.ts Intl singletons (fmtMoney/fmtInt/fmtDate/fmtDateTime/fmtShortDateTime): 13 сторінок (catalog/crm[list+detail]/employees/invoices/pricing-rules/purchase-orders/stock-documents/work-orders[list+detail]/settlements/inventory) — заміна inline `n.toLocaleString('uk-UA', {...})` і `new Date(...).toLocaleDateString(...)` у table-cell rendering hot-path; локальні `fmt()` хелпери переписані як thin proxy
- ✅ booking/page.tsx (public widget): module-level SLOT_TIME_FMT Intl singleton — без імпорту lib/format для мінімального public bundle
- ✅ CalendarSlotModal: ref-cache seed для branches (instant dropdown second mount у newWo wizard)
- ✅ dashboard/page.tsx + RevenueChart.tsx: local fmt → fmtMoney/fmtInt proxy; upcomingTO.map() → fmtDate/fmtInt; tickFormatter → module-level TICK_DATE_FMT
- ✅ vehicles/[id]/PageClient.tsx: 6× inline .toLocaleString/.toLocaleDateString → fmtInt/fmtDate (nodes + schedules .map() + expiry blocks)
- ✅ reports/page.tsx + ReportsCharts.tsx: local fmt/fmtNum → fmtMoney + NUM_FMT_1 singleton; kyivDate → module-level KYIV_DATE_FMT/KYIV_YMD_FMT
- ✅ settings/page.tsx: webhook delivery log timestamp → fmtShortDateTime
- ✅ calendar/CalendarSlotModal.tsx: select-list item date → fmtKyivDate helper у calendar.utils (Kyiv-TZ DD.MM.YYYY singleton)
- ✅ infrastructure/page.tsx: local formatDate (inline toLocaleDateString) → fmtDate proxy з @/lib/format — LiftRow рендерить 2× дати на рядок
- ✅ lib/format.ts: add fmtTime(d) HH:mm singleton — replaces per-call .toLocaleTimeString anti-pattern
- ✅ notification-center.tsx: items.map() inline toLocaleTimeString → fmtTime (TopShell hot-path rendered on every page)
- ✅ sync-indicator.tsx: lastSync.toLocaleTimeString → fmtTime (TopShell hot-path)
- ✅ settings/sync/page.tsx: local fmtDate (2× inline toLocale\*) → fmtDateTime proxy
- ✅ calendar.utils.ts: hoist KYIV_MONTH_YEAR_FMT + KYIV_FULL_DATE_FMT singletons; fmtKyivMonthYear helper
- ✅ calendar/page.tsx + CalendarStatsTab.tsx: 2× inline new Date(...).toLocaleDateString → fmtKyivMonthYear singleton (month-view headers)
- ✅ dashboard/page.tsx: 4 inline Intl у useEffect → module-level KYIV_YMD_FMT/KYIV_YEAR_MONTH_DAY_FMT/KYIV_FULL_DATE_FMT/KYIV_HOUR_FMT (per-mount setup forms)
- ✅ date-picker-input.tsx: DAY_PICKER_CLASS_NAMES module-level const + useMemo для minDate/maxDate/disabledMatchers/selected — DayPicker внутрішня memoization матриці днів збережена
- ✅ batch-viewer-modal.tsx: BatchRow → React.memo + useCallback(handleToggle) + useMemo(activeBatches/depletedBatches) — клік на expand тепер чіпає 2 рядки замість всіх N
- ✅ pricing-rules/PricingRulesClient.tsx: brands seeded from cache:brands ref-cache + warm cache на successful fetch — dropdown миттєвий за повторне відкриття
- ✅ settings/sync/page.tsx: triggerSync пулл+пуш у Promise.all — web push always empty records (independent ops), -1 RTT

**DB:**

- ✅ work_orders: `(orgId, status, branchId, deletedAt)`, `(orgId, completedAt, deletedAt)`
- ✅ stock_items: `(orgId, warehouseId, deletedAt)`
- ✅ stock_movements: `(orgId, warehouseId, createdAt)`
- ✅ stock_batches: `(orgId, warehouseId, isActive, createdAt)`
- ✅ GIN trgm: work_orders.number, counterparties.(firstName/lastName/companyName), goods.(name/sku)
- ✅ audit_events: `(orgId, entityType, entityId, createdAt)` covering — findByEntity timeline без sort node
- ✅ settlement_transactions: `(orgId, settlementAccountId, createdAt)` covering — paginated list + reconciliation period scans
- ✅ work_order_lines: `(workOrderId, deletedAt)` — list lines by WO без orgId fan-out у nested fetch
- ✅ batch_consumptions: `(orgId, batchId, createdAt)` — chronological FIFO/LIFO traversal per-batch
- ✅ work_order_media: `(orgId, workOrderId, createdAt)` covering — findAll sorted DESC без Sort node
- ✅ payments: `(orgId, counterpartyId, createdAt)` + `(orgId, createdAt)` covering — list endpoint paginated by createdAt DESC, eliminates Sort node for both filtered + unfiltered paths
- ✅ completion_acts: `(orgId, workOrderId, deletedAt, createdAt)` covering (replaces 3-col) — findAll sorted by createdAt DESC
- ✅ warranties: `(orgId, counterpartyId, deletedAt, createdAt)` covering (replaces 3-col) — findByCounterparty/findByWorkOrder sorted by createdAt DESC
- ✅ webhook_endpoints: `(orgId, deletedAt, createdAt)` covering (replaces 2-col) — findAll sorted by createdAt DESC
- ✅ booking_requests: `(orgId, deletedAt, createdAt)` covering (replaces single `(orgId, createdAt)`) — findAll with deletedAt=null filter + sort by createdAt DESC
- ✅ purchase_orders: `(orgId, deletedAt, createdAt)` covering — findAll без status filter (hot path) sort eliminated
- ✅ stock_documents: `(orgId, deletedAt, createdAt)` covering — findAll без type/status filter (default browse) sort eliminated
- ✅ invoices: `(orgId, deletedAt, createdAt)` covering — findAll без status filter (default list) sort eliminated
