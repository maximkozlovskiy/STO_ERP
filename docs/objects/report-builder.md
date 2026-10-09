# Report Builder — Dossier

> Конструктор звітів: самообслуговуваний динамічний звіт (drag полів, фільтри, ієрархічне
> групування ≤5, поля зв'язків `Контрагент.Тип`, підсумки, збереження, експорт).

## Ключові факти

- **Метадата-реєстр** (`report-registry.ts`) — ЄДИНЕ ДЖЕРЕЛО ПРАВДИ. Описує сутності: `fields[]`
  ({key, label, type, prismaPath, enumName?, aggregations[], filterable, groupable, stateNotFlow?,
  signedByType?}), `relations[]` ({prismaPath, depth, advanced, targetHasSoftDelete}), прапорці
  `hasSoftDelete`/`profile: FULL|APPEND_ONLY`, `dateField`. Живить і backend-білдер, і фронт
  (`GET /reports/builder/metadata`).
- **9 сутностей:** WorkOrder (Наряди), WorkOrderPart (Запчастини), PurchaseOrderLine (Закупівлі),
  Invoice (Рахунки), Payment (Платежі, append-only), SettlementTransaction (Розрахунки, append-only),
  StockMovement (Рухи, append-only, знакова quantity), StockBatch (Партії, append-only), StockItem
  (Залишки). Розширення = один запис у REGISTRY, движок не міняється.
- **Профілі:** FULL (deletedAt-інжекція) vs APPEND_ONLY (без deletedAt — Payment/StockMovement/
  SettlementTransaction/StockBatch; звірено регрес-тестом registry.spec, бо StockBatch не має deletedAt).
- **3 компоненти движка:** `report-query.builder.ts` (config→Prisma findMany),
  `report-aggregator.ts` (JS-групування ≤5 + агрегації), `report-builder.service.ts` (оркестрація
  - SavedReport CRUD).

## Безпека (injection неможливий за побудовою)

- Користувач передає ЛИШЕ `field.key`/`entity.key` — вони резолвляться у реєстрові `prismaPath`
  (літерали у коді) через `getEntity`/`getField` з `Object.prototype.hasOwnProperty.call`-guard
  (захист від `__proto__`/`constructor`/`toString`, як `buildSortOrderBy`).
- Жоден ключ Prisma (`where`/`include`/`select`/`orderBy`) не походить із вводу. Значення фільтрів
  параметризує Prisma-клієнт. Enum-значення + `op` — з фіксованих whitelist.
- `orgId` інжектиться у КОЖЕН `where`; `deletedAt:null` — лише де `hasSoftDelete`; nested
  `deletedAt` на relation-хопах у WHERE (Bug #607).

## Prisma-нюанси (баги live-верифікації)

- **to-one relation НЕ приймає `where` у include** → Prisma "Unknown argument where". Усі relations
  тут belongs-to → soft-delete relation-колонок пропущено (рядок уже відфільтрований по кореневому
  deletedAt). Фікс 13861792.
- **`include`+`select` на одному рівні заборонено** (Bug #617). relation-branch будується ПОВНІСТЮ
  через nested `select` (`{good:{select:{name:true, brand:{select:{name:true}}}}}`), корінь — `include`.

## Pivot-модель (детальні рядки + агрегати)

Конструктор — справжній pivot, не лише group-by:

- **Без groupBy** → плоска таблиця детальних рядків (`result.detailRows`, проєкція columns).
- **З groupBy** → дерево груп; на листі детальні рядки (`node.rows`) розгортаються.
- **Авто-SUM:** числова колонка без явної агрегації → авто-SUM (`effectiveAggregations` у service).
  Response несе ефективні `aggregations` (явні + авто), збагачені `{type,label}` (Bug #620 — щоб
  форматувати MIN/MAX-дати навіть коли поле не в columns).
- **Сортування груп** за агрегатом: `sortByAggregate {alias, dir}`; клік по заголовку агрегату у UI.
  `∅`-група бере участь у sort-by-agg (не форсується в кінець). `hasOwnProperty`-guard на alias
  (proto-injection).
- `includeRows` завжди true (інакше «детальний звіт» неможливий).

## Агрегації (report-aggregator)

- SUM/AVG/MIN/MAX per-field; COUNT НЕ пропонується per-field (дублює group.count) — кількість
  записів через `node.count`/`rowCount`.
- **balance** → лише AVG/MIN/MAX (`stateNotFlow` → SUM=400 — стан, не потік).
- **знакова quantity** (`signedByType`) → знак за сусіднім type: WRITEOFF/RESERVATION_RELEASE = −,
  RECEIPT = +. **НЕ-фізичні рухи** (RESERVATION/RESERVATION_RELEASE, quantityDelta=0) → виключені
  з SUM (Bug #619 — інакше фантомні резервування спотворювали нетто). Cross-invariant:
  `stockMovement.SUM_quantity == stockItem.SUM_quantity`.
- StockMovement.quantity `filterable:false` — фільтр по знаковому вводить в оману; для «прихід/
  списання» — фільтр/групування по `type`.
- **grandTotals** — незалежний прохід по всій вибірці (AVG grand ≠ середнє груп — SQL-семантика).
- **ІНВАРІАНТ:** `Σ(листкові SUM) == grandTotal` — live-verified усі 9 сутностей, diff=0.
- `take` cap 5000 (`REPORT_TAKE_CAP`), `truncated = rowCount >= cap` → UI-банер.

## API Endpoints (`/api/reports/builder`)

| Метод            | URL              | Дія                                            |
| ---------------- | ---------------- | ---------------------------------------------- |
| GET              | `/metadata`      | Реєстр для фронта (сутності/поля/зв'язки/enum) |
| POST             | `/run`           | Ad-hoc звіт (ReportRunDto → tree+grandTotals)  |
| GET              | `/saved`         | Список збережених                              |
| POST             | `/saved`         | Зберегти (dry-run buildQuery перед create)     |
| GET              | `/saved/:id/run` | Запустити збережений                           |
| GET/PATCH/DELETE | `/saved/:id`     | Деталь / оновити / soft-delete                 |

Ролі: `OWNER`, `ADMIN`, `ACCOUNTANT`. Route ordering: специфічні перед `:id`.

## UI (Web)

| Компонент             | Файл                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------ |
| Вкладка «Конструктор» | `app/(app)/reports/ReportBuilder.tsx` (палітра+3 зони+таблиця)                             |
| Хуки                  | `hooks/api/useReportBuilder.ts`                                                            |
| Експорт CSV / XLSX    | `lib/report-export.ts` (рядки, CSV-текст, SpreadsheetML; завантаження — `lib/download.ts`) |

Native HTML5 drag (палітра→зона); ієрархічна таблиця з розгортанням + tfoot-підсумки; експорт
CSV/XLSX клієнтський (SpreadsheetML).

## Prisma модель

`SavedReport` (FULL-профіль): `orgId, name, entity, config Json, createdBy?, syncVersion, стандартні
поля`. Міграція `20260903120000_add_saved_reports`. `@@index([orgId, deletedAt])`.

→ [docs/ARCHITECTURE.md](../ARCHITECTURE.md) · [docs/objects/settlements.md](settlements.md)

## Бізнес-правила (BR-RPT)

> Правила виведено з коду 2026-10-08, власником не затверджені.

- **BR-RPT-001** — Джерело звіту обирається лише з реєстру (`REGISTRY`, 9 сутностей). Будь-який
  інший ключ `entity`, зокрема `__proto__` / `constructor` / `toString`, → 400; ім'я Prisma-моделі
  береться з реєстру, не з вводу.
- **BR-RPT-002** — Поле в `columns`, `groupBy`, `filters`, `sort` і `aggregations` — лише ключ із
  переліку полів обраної сутності в реєстрі; невідомий ключ → 400. Шлях у запиті (`where` /
  `include` / `orderBy`) будується з реєстрового `prismaPath`, а не з рядка, що прийшов від клієнта.
- **BR-RPT-003** — Оператор фільтра — лише один із дев'яти: `eq`, `ne`, `in`, `gt`, `gte`, `lt`,
  `lte`, `contains`, `isNull`; інший → 400. `in` вимагає масив (інакше 400). `contains` дозволено
  лише нечисловим не-enum полям (для `enum` / `number` / `decimal` → 400) і він нечутливий до регістру.
- **BR-RPT-004** — Значення фільтра по enum-полю (крім оператора `isNull`) мусить входити в перелік
  значень цього enum у реєстрі (`REGISTRY_ENUMS`); для `in` — кожен елемент масиву. Інакше → 400.
- **BR-RPT-005** — Фільтрувати можна лише поля з `filterable: true`; фільтр по нефільтровному полю
  → 400. Сьогодні таке поле одне — знакова кількість руху (`stockMovement.quantity`).
- **BR-RPT-006** — Кожен запит звіту несе `orgId` викликача в корені `where` — для всіх 9 сутностей,
  і для ad-hoc запуску, і для збереженого звіту (організація береться від викликача, а не зі
  збереженого config). Жоден фільтр користувача не може цю умову перезаписати чи зняти.
- **BR-RPT-007** — `deletedAt: null` у корені `where` додається сутностям профілю FULL (наряди,
  запчастини нарядів, рядки закупівель, рахунки, залишки) і НЕ додається APPEND_ONLY (платежі,
  розрахунки, рухи, партії — поля немає). Фільтр по полю зв'язку додає `deletedAt: null` і на хоп
  зв'язку, якщо цільова сутність має soft delete.
- **BR-RPT-008** — Звіт читає не більше 5000 рядків (`take = 5000` завжди, клієнт ліміт не задає).
  Якщо прочитано 5000 і більше — `truncated = true`; підсумки тоді пораховані лише по прочитаних рядках.
- **BR-RPT-009** — Період `dateRange` накладається на `dateField` сутності (наряди й рахунки —
  `documentDate`, решта — `createdAt`) у межах київської доби: від 00:00 `from` до кінця доби `to`
  за часом Europe/Kyiv з урахуванням літнього/зимового часу. `from` пізніше `to` → 400.
- **BR-RPT-010** — Групування по полю-даті йде за календарним днем у Києві (`YYYY-MM-DD`), а не за
  UTC і не за міткою часу: операція о 00:30 за Києвом належить новому дню.
- **BR-RPT-011** — Агрегація поля — лише з переліку `aggregations` цього поля в реєстрі; інша → 400
  (наприклад, для ціни дозволено AVG/MIN/MAX, але не SUM).
- **BR-RPT-012** — Числова колонка (`number` / `decimal`) без явно заданої агрегації отримує
  авто-SUM — лише якщо реєстр дозволяє цьому полю SUM. Явна агрегація поля авто-SUM скасовує.
- **BR-RPT-013** — Загальний підсумок рахується окремим проходом по всій вибірці: сума SUM по
  листкових групах дорівнює загальному SUM, а загальний AVG — середнє по рядках, не середнє груп.
- **BR-RPT-014** — Знакова кількість руху (`stockMovement.quantity`): резервування і зняття резерву
  (`RESERVATION`, `RESERVATION_RELEASE`) у суму не входять; списання (`WRITEOFF`) завжди від'ємне,
  навіть якщо збережене додатним.
- **BR-RPT-015** — Без групування детальні рядки з однаковими значеннями всіх нечислових колонок
  згортаються в один: числові колонки підсумовуються, `__mergedCount` показує, скільки рядків злито
  (сума `__mergedCount` дорівнює числу прочитаних рядків).
- **BR-RPT-016** — Групування — не більше 5 рівнів: шостий елемент `groupBy` → помилка валідації
  (`err.dto.reportBuilder.groupBy.max`).
- **BR-RPT-017** — Збережений звіт належить організації, а не користувачу: список, читання,
  оновлення, видалення і запуск ідуть за `id + orgId + deletedAt: null`; чужий або видалений → 404.
  Усередині організації всі, хто має доступ до конструктора, бачать і можуть змінювати всі збережені
  звіти; автор лише записується в `createdBy`.
- **BR-RPT-018** — Невалідний config не зберігається: і створення, і оновлення спершу проганяють
  config через побудову запиту (правила BR-RPT-001…005 і 009); помилка → 400, запису в БД немає.
- **BR-RPT-019** — Видалення збереженого звіту — soft delete (`deletedAt`), фізичного видалення немає.
- **BR-RPT-020** — Доступ до всіх 8 маршрутів конструктора мають лише ролі OWNER, ADMIN, ACCOUNTANT.
  Обмежень за роллю на окремі джерела чи колонки немає: хто має доступ до конструктора, бачить усі
  9 сутностей.
- **BR-RPT-021** — Експорт CSV / XLSX виконує браузер із уже отриманого результату звіту; окремого
  серверного маршруту експорту немає. Клітинки CSV проходять `escapeCsvCell` (захист від формул).
- **BR-RPT-022** — Кілька умов на одне поле діють разом (AND): друга умова фільтра на те саме поле
  і фільтр по полю дати поверх `dateRange` не замінюють попередню, а звужують вибірку. Діапазон по
  одному полю задається двома фільтрами (`gte` + `lte`).
- **BR-RPT-023** — Виручка у звітах — завжди три величини: **сума** (без ПДВ, `Σ totalNet`),
  **ПДВ** (`сума з ПДВ − сума`) і **сума з ПДВ** (`Σ totalAmount`). Фіксовані звіти «Виручка»
  (`revenue` / `vat` / `revenueWithVat` по днях і підсумки) та «Рентабельність» (`totalRevenue` /
  `totalVat` / `totalRevenueWithVat`); валовий прибуток і маржа рахуються від суми без ПДВ. ПДВ —
  різниця двох сум наряду, а не збережений `totalVat`: наряди, завершені до 2026-10-08 в режимі
  «ПДВ зверху», мають `totalNet = totalAmount`, і ПДВ за ними у звіті 0. У конструкторі сутність
  наряду має три відповідні поля: `totalNet` «Сума (без ПДВ)», `totalVat` «ПДВ», `totalAmount`
  «Сума з ПДВ». Колонки «Роботи» і «Запчастини» звіту «Виручка» та база собівартості робіт у
  «Рентабельності» — теж без ПДВ і від факту: суми рядків наряду множаться на частку
  `totalNet / (totalActualLabor + totalParts)` (1 без ПДВ і для «ПДВ зверху», менше 1 для «ПДВ у
  ціні»), тож «Роботи» + «Запчастини» = «Сума» (до копійки округлення на наряд).

### Знахідки 2026-10-08 (рішення за власником; правила вище описують, як код працює СЬОГОДНІ)

- **Значення фільтра не перевіряється за типом.** Для `eq` / `ne` / `gt`… об'єкт іде в Prisma як є:
  `{ op: 'eq', value: { startsWith: 'A' } }` обходить білий список операторів. За межі організації
  це не виводить (умова лягає під ключ поля, `orgId` у корені лишається).
- **`groupable` сервер не перевіряє** — прапорець лише для UI; API приймає `groupBy` по полю з
  `groupable: false` (наприклад, ціна).
- **Агрегації перевіряються лише під час запуску**, вже після читання з БД; збереження звіту
  (dry-run) їх не перевіряє — звіт із недозволеною агрегацією збережеться і падатиме 400 при запуску.
- **`stateNotFlow` і агрегація COUNT у реєстрі не використовуються** жодним полем; поля «баланс»,
  про яке сказано вище в розділі «Агрегації», у реєстрі немає.

---

## Аспекти і тести, що їх стережуть

Правите один аспект — ганяєте один файл:

```bash
cd apps/api && npx vitest run src/modules/report-builder/<файл>.spec.ts
```

**Модуль:** `apps/api/src/modules/report-builder/`, `apps/api/src/modules/reports/`

**Маршрути UI:** `/reports`

| Аспект                                             | Тест                                   | Кейсів |
| -------------------------------------------------- | -------------------------------------- | ------ |
| цілісність реєстру, tenant-умова по всіх сутностях | `report-registry.spec.ts`              | 9      |
| побудова запиту: білі списки, ліміт, період        | `report-query.builder.spec.ts`         | 28     |
| групування, агрегації, підсумки                    | `report-aggregator.spec.ts`            | 21     |
| авто-SUM і збагачення агрегацій                    | `report-builder.service.spec.ts`       | 3      |
| збережені звіти, tenant-межа запуску               | `report-builder.saved-reports.spec.ts` | 10     |
| ролі доступу                                       | `report-builder.access.spec.ts`        | 9      |
| межі config (DTO)                                  | `report-builder.dto.spec.ts`           | 1      |
| фіксовані звіти (сусідній модуль `reports`)        | `reports.service.spec.ts`              | 19     |
| фіксовані звіти: дати періоду в запиті (400)       | `reports.contract.spec.ts`             | 74     |
| фіксовані звіти: межі періоду за Києвом, ПДВ       | `reports.period-bounds.spec.ts`        | 42     |

Разом: **216** кейсів — 81 конструктора і 135 фіксованих звітів (цифри з `vitest --reporter=json`, не з grep).

Web-тест експорту (`BR-RPT-021`) лежить поза модулем:
`apps/web/src/lib/__tests__/report-export.test.ts` — 23 кейси. Перевіряє чисту частину
`apps/web/src/lib/report-export.ts` (винесена з `ReportBuilder.tsx`): дерево груп → плоскі рядки
(відступ за рівнем, підсумки груп, рядок «Разом»), плоский звіт (нумерація, колонка «Склеєно»),
значення клітинки (enum, дата, булеве), CSV (роздільник, лапки, захист від формул через
`escapeCsvCell`, BOM), XLSX-XML (екранування, числа як `Number`, заголовок, каркас книги). Запуск:
`cd apps/web && npx vitest run src/lib/__tests__/report-export.test.ts`.

**Чого тут НЕМА.**

- Експорт: саме завантаження файла (`exportReport` → `downloadBlob`, Blob і клік по посиланню) і
  кнопки CSV / XLSX у `ReportBuilder.tsx` тестом не покриті — перевірено лише побудову вмісту файла.
  Чи відкриває Excel отриманий SpreadsheetML, не перевіряє ніщо.
- HTTP-контракту (`*.contract.spec.ts`) немає: статуси й повну валідацію DTO (крім межі `groupBy`)
  покриває лише E2E `apps/web/e2e/report-builder.spec.ts`.
- Справжній SQL не виконується: unit-тести перевіряють форму аргументів Prisma, а не результат запиту.
