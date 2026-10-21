# sto-optimize — backend

> Частина скіла `sto-optimize`; винесено дослівно, щоб кожен файл влазив в один Read.

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

### 1.11 Пошук по кількох полях ОДНОГО зв'язку окремими умовами в OR — JOIN тієї самої таблиці на кожну умову

```bash
# Той самий зв'язок двічі й більше ПІДРЯД в одному OR/AND-масиві → друкує «файл зв'язок»
# (to-many через `some` — інший випадок, там кожна умова — окремий підзапит свідомо)
grep -rnE "^\s*\{ \w+: \{ \w+: (contains|\{)" apps/api/src/modules/ --include="*.service.ts" | grep -v spec \
  | sed -E 's/^([^:]+):[0-9]+:\s*\{ (\w+):.*/\1 \2/' | uniq -d
```

**Фікс:** `OR: [{ rel: { a } }, { rel: { b } }]` → `OR: [{ rel: { OR: [{ a }, { b }] } }]`. Prisma будує LEFT JOIN на КОЖНУ окрему умову зв'язку, тож N полів одного зв'язку = N з'єднань з тією самою таблицею; на малих таблицях планування стає дорожчим за виконання. Результат той самий. Підтверджувати ВИМІРОМ: SQL із `log: query` + `EXPLAIN (ANALYZE)` обох форм і порівняння id рядків на кількох рядках пошуку. Якщо тест перевіряє форму `where` — оновити очікування в тому ж кейсі (назва кейсу не міняється → baseline цілий).

### 1.12 Пошук «власних» рядків щойно створеного батька в тій самій транзакції — завжди порожній запит

```bash
# спільний хелпер «upsert дочірніх за батьком», який кличуть і з create, і з update
grep -rn "async upsert\w*(\s*$\|async upsert\w*(tx" apps/api/src/modules/ --include="*.service.ts" | grep -v spec
# у ньому першим кроком findMany({ where: { <parent>Id } }) — а з create батько щойно вставлений
```

**Фікс:** прапорець `isNew` у хелпері (передає лише `create`, де батько створений у цій же транзакції) — пропустити читання й узяти `[]`. Решта гілок (перевірка зайнятості, створення) без змін. Підтверджувати лічильником SQL (`log: query`) на живому API і тестом «findMany не викликано» на create. Виграш — один запит на створення; не застосовувати, якщо дочірні рядки могли з'явитися раніше в тій самій транзакції (тригер, інший хелпер).

### 1.13 `findMany` з кількома `include` для підколекції, що зазвичай ПОРОЖНЯ, — запит на кожен зв'язок навіть без рядків

```bash
# ендпоінти картки, що віддають підколекцію з include (часто — `take: 500`, за id батька)
grep -rn "include: [A-Z_]*INCLUDE" apps/api/src/modules/ --include="*.service.ts" -B6 | grep -E "Id, |Id: \w+, " | grep -v spec
```

**Фікс:** лічильник — `_count` у тому самому `findFirst`, що перевіряє батька (`select: { id: true, _count: { select: { rel: { where } } } }`), а `findMany` з `include` — лише коли `> 0`. Prisma без `relationJoins` шле `SELECT … WHERE id IN (NULL)` на кожен ключ `include` і для порожнього результату. **Підтверджувати ВИМІРОМ:** лог запитів на живому API (патч `log` у зібраному `dist-*`), порахувати `IN (NULL)`. Для фейкової Prisma у спеках — `_count` має виконувати `where` по-справжньому.

### 1.14 Хук іншого модуля в тій самій транзакції перечитує те, що виклик щойно прочитав чи порахував

```bash
# виклики хуків сусіднього модуля з tx після власних розрахунків
grep -rn "await this\.\w\+\.on[A-Z]\w*(\(tx\|db\)," apps/api/src/modules/ --include="*.service.ts" | grep -v spec
# у тілі хука — ті самі findMany (рядки документа, рухи, net-резерв), що й у виклику перед ним
```

**Фікс:** необов'язковий параметр із готовим значенням (без нього хук читає сам), одне читання підколекції на всі кроки хука. Те, що змінив попередній крок у цій транзакції (рухи, статуси), — перечитувати, а не рахувати в JS. Тест-лічильник викликів делегата фейкової Prisma.

---

### 1.15 Постановка задач черги по одній `add` у циклі на шляху запиту

```bash
grep -rn "for (const .* of .*)" -A2 apps/api/src/modules/ --include="*.service.ts" | grep "enqueue\|Queue\.add\|queue\.add" | grep -v spec
```

**Фікс:** `queue.addBulk` пачками (≤500 задач): один обмін з Redis замість N. Сталий `jobId` дедуплікує так само, як в `add`. Збій пачки — одна `updateMany({ id: { in: chunk } })` з причиною (sweep підхопить). **Підтверджувати ВИМІРОМ:** час відповіді на `127.0.0.1` при N задач проти N=0 (кеш); у спеку — `addBulk` викликано 1 раз на N пар.

### 1.16 Планувальник «що пора» вибирає рядки, які обробник пропускає, не посуваючи курсор (`nextPollAt`)

```bash
# обробник виходить раннім return (батько видалений / немає підключення), а вибірка за nextPollAt
grep -rn "nextPollAt: { lte\|nextRunAt: { lte\|dueAt: { lte" apps/api/src/modules/ --include="*.ts" | grep -v spec
```

**Проблема:** рядок назавжди «на черзі»: кожен тік читається разом із побічними кроками (перерахунок підсумку батька = UPDATE + `syncVersion`++), а набравши `take` — витісняє живі рядки з вікна. **Фікс:** умову пропуску — у `where` вибірки (фільтр через зв'язок, напр. `connection: { deletedAt: null }`), щоб обробник отримував лише те, що може обробити. **Виміряти:** `count(*)` вибірки з умовою і без на dev-базі + `syncVersion` батька між двома тіками.

---

### 1.17 Пакетний хелпер, покликаний з масивом з ОДНОГО елемента всередині «одиничної» функції, яку кличуть у циклі — прихований N+1

```bash
# одиничні функції, що звертаються до пакетного хелпера з [item] / [row] / [id]
grep -rnE "await this\.\w+\((tx|db|this\.prisma), \w+, \[\w+\]\)" apps/api/src/modules/ --include="*.ts" | grep -v spec
# і хто кличе цю одиничну функцію в циклі (часто — з ІНШОГО модуля, тож 1.1 її не бачить)
grep -rn "for (const .* of " -A6 apps/api/src/modules/ --include="*.service.ts" | grep "await this\.\w\+\.\w\+(tx, orgId, item"
```

**Проблема:** хелпер `xxxIds(tx, orgId, items)` писався пакетним (`id: { in }`), але одинична функція (`releaseOne(item)`) кличе його з `[item]`, а сусідній сервіс кличе одиничну функцію в циклі по позиціях — N запитів замість одного. Детектор 1.1 це пропускає: у тілі циклу немає `findMany`, лише виклик чужого методу.
**Фікс:** необов'язковий параметр із готовою множиною (`activeIds?: ReadonlySet<string>`), без нього — читає сама; викликач читає пакетно ОДИН раз (у транзакції — після блокувань, щоб стан був той самий). Пакетний хелпер робиться публічним, якщо викликач в іншому модулі. **Тест-лічильник:** кілька позицій різних батьків → `findMany` делегата = 1 (до фіксу — N).

### 1.18 Спільне ядро мутації читає й віддає більше, ніж потрібно шляхам, що його кличуть (повторне читання рядка й налаштувань, `include` картки, повторне блокування)

```bash
# ядро (applyUpdate/applyX), яке кличуть ≥3 шляхи; у ньому findFirst рядка + update з include
grep -rn "private async apply\w*(" apps/api/src/modules/ --include="*.service.ts" | grep -v spec
grep -rn "await this\.apply\w*(" apps/api/src/modules/ --include="*.service.ts" | grep -v spec
# налаштування, що читаються на кількох рівнях одного виклику (години філії, ставки, курси)
grep -rn "resolveWorkHours\|getOrganisationSettings\|resolve\w*Settings" apps/api/src/modules/ --include="*.service.ts" | grep -v spec
# хелпер, що сам блокує (FOR UPDATE) і перечитує рядок, викликаний із транзакції, що вже заблокувала
grep -rn "lock\w*ForUpdate" apps/api/src/modules/ --include="*.ts" | grep -v spec
```

**Проблема:** ядро PATCH-а (з `include` під відповідь картки) перевикористали календар, планшет і перев'язка: кожен шлях сам читає рядок і налаштування (для своїх перевірок), а ядро читає їх удруге; `update({ include })` — це UPDATE + повторний SELECT рядка + по SELECT на кожен зв'язок, хоча шлях відповідь викидає (віддає своє). Хелпер «зняти дати» сам блокує й перечитує рядок, який транзакція виклику вже заблокувала й прочитала.
**Фікс:** опції ядра — `current` (рядок викликача цілим, тож ядро його не читає), `hours`/налаштування викликача, `lean` (`select` скалярів → `UPDATE … RETURNING`, без зв'язків; перевантаження сигнатури тримає тип відповіді для обох режимів); хелпер блокування — `lockedRow` від викликача (рядок під тим самим блокуванням не змінюється). Публічний PATCH лишається без змін. **Виміряти:** `log: query` у зібраному `dist-*` на живому API, лічильник SQL на кожен шлях до/після (тут: 20→12, 27→18, 31→22).

### 1.19 `distinct` у `findMany` як заміна `take`: SQL не обмежений

```bash
grep -rn "distinct: \[" apps/api/src/modules/ --include="*.ts" | grep -v spec
grep -n "nativeDistinct" packages/database/prisma/schema/*.prisma   # немає → distinct у пам'яті
```

**Проблема:** без preview-прапорця `nativeDistinct` Prisma читає ВСІ рядки за `where` і знімає дублікати після читання; у SQL немає ні `DISTINCT`, ні `LIMIT`. Зміна `take: N` → `distinct` прибирає обмеження, хоча виглядає як «по рядку на ключ».
**Рішення:** спершу кардинальність. Набір обмежений доменом (одиниці рядків на організацію) → лишити, виправити лише міркування в коментарі. Набір росте з даними → фільтр за потрібним ключем (`findFirst`), `groupBy` (справжній `GROUP BY`) або `EXISTS` через зв'язок. Не робити паралельне читання послідовним заради цього: це додає RTT. **Виміряти:** `log: query` — чи є `DISTINCT`/`LIMIT` у SQL, скільки рядків повертається.
