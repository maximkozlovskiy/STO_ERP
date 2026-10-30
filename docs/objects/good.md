# Good / Товар — Dossier

> Запчастина, витратний матеріал, інструмент. Центр каталогу товарів.
> Має залишки (StockItem), рухи (StockMovement), партії (StockBatch), штрихкоди, одиниці виміру.

---

## Prisma модель

```prisma
model Good {
  id                  String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId               String    @db.Uuid
  brandId             String?   @db.Uuid
  unitId              String?   @db.Uuid           // основна одиниця виміру
  goodCategoryId      String?   @db.Uuid
  sku                 String?
  name                String
  unit                String    @default("шт")     // текстовий fallback
  purchasePrice       Decimal?  @db.Decimal(12, 2) // ціна закупки
  salePrice           Decimal   @db.Decimal(12, 2) // ціна продажу
  category            String?                      // текстовий fallback
  barcode             String?                      // основний штрихкод (дублює GoodBarcode)
  notes               String?
  goodType            GoodType?                    // SPARE_PART | CONSUMABLE | MATERIAL | TOOL
  preferredSupplierId String?   @db.Uuid
  syncVersion         BigInt    @default(0)
  createdAt           DateTime  @default(now())
  updatedAt           DateTime  @updatedAt
  deletedAt           DateTime?
}

model GoodBarcode {
  goodId    String
  barcode   String
  type      String  @default("EAN13")
  isPrimary Boolean @default(false)
  // @@index([orgId, barcode])  ← пошук по штрихкоду
}

model GoodUoM {
  goodId          String
  unitOfMeasureId String
  isDefault       Boolean @default(false)
  coefficient     Float   @default(1)   // скільки базових одиниць в цій
  width/height/depth/volume/weight Float?
  // @@unique([orgId, goodId, unitOfMeasureId])
}

// Кастомні мітки-статуси товарів (Акція / Новинка / Хіт / Розпродаж). Per-org довідник,
// керований вкладкою «Статуси товарів» у Каталозі. M:N із Good через GoodStatusLink.
model GoodStatus {
  id String; orgId String; name String; color String @default("#6b7280")
  syncVersion BigInt; createdAt; updatedAt; deletedAt DateTime?
  // @@unique([orgId, name]); @@index([orgId, deletedAt]); @@index([orgId, syncVersion])
}
model GoodStatusLink {   // junction M:N, без syncVersion/deletedAt
  id String; orgId String; goodId String; statusId String; createdAt
  // @@unique([goodId, statusId]); @@index([orgId, goodId]); @@index([orgId, statusId])
}
```

**Відносини:**

- → `Brand` (optional)
- → `UnitOfMeasure` (основна)
- → `GoodCategory` (optional)
- → `Counterparty` (preferredSupplier)
- ← `GoodBarcode[]` (штрихкоди)
- ← `GoodUoM[]` (альтернативні одиниці виміру з коефіцієнтом)
- ← `StockItem[]` (залишки по складах)
- ← `StockMovement[]` (всі рухи)
- ← `StockBatch[]` (партії FIFO/LIFO)
- ← `PricingRule[]` (правила ціноутворення)
- ← `PriceHistory[]` (журнал цін)
- ← `GoodStatusLink[]` (statusLinks — M:N до `GoodStatus`, кастомні мітки)
- ← `WorkOrderPart[]`, `PurchaseOrderLine[]`, `StockDocumentLine[]`, `InvoiceLine[]`

**Індекси:**

- `(orgId, sku)` — пошук по SKU
- `(orgId, goodType, deletedAt)` — фільтр по типу
- GIN trgm на `name`, `sku` — full-text fuzzy search (ручні міграції, не Prisma schema)

---

## API Endpoints (`/api/goods`)

| Метод  | URL                                      | Дія                                                                                            |
| ------ | ---------------------------------------- | ---------------------------------------------------------------------------------------------- |
| GET    | `/api/goods`                             | Список (фільтри: q, goodType, brandId, categoryId, `ids` — до 200 id через кому, BR-WO-036)    |
| GET    | `/api/goods/stock-totals`                | Залишки по всіх складах (агрегат); по складу — `quantity`, `reserved`, `available` (BR-WO-029) |
| GET    | `/api/goods/:id`                         | Деталь                                                                                         |
| POST   | `/api/goods`                             | Створити                                                                                       |
| PATCH  | `/api/goods/:id`                         | Оновити                                                                                        |
| DELETE | `/api/goods/:id`                         | Soft-delete                                                                                    |
| POST   | `/api/goods/:id/restore`                 | Відновити (знімає deletedAt)                                                                   |
| GET    | `/api/goods/:goodId/uoms`                | Одиниці виміру                                                                                 |
| POST   | `/api/goods/:goodId/uoms`                | Додати UoM                                                                                     |
| PATCH  | `/api/goods/:goodId/uoms/:uomId`         | Оновити UoM                                                                                    |
| PATCH  | `/api/goods/:goodId/uoms/:uomId/default` | Встановити UoM по замовчуванню                                                                 |
| DELETE | `/api/goods/:goodId/uoms/:uomId`         | Видалити UoM                                                                                   |
| GET    | `/api/goods/:goodId/barcodes`            | Штрихкоди                                                                                      |
| POST   | `/api/goods/:goodId/barcodes`            | Додати штрихкод                                                                                |
| DELETE | `/api/goods/:goodId/barcodes/:barcodeId` | Видалити штрихкод                                                                              |
| GET    | `/api/goods/:id/batches`                 | Партії (StockBatch)                                                                            |
| GET    | `/api/goods/:id/price-history`           | Журнал цін                                                                                     |
| POST   | `/api/goods/:goodId/statuses`            | Призначити статус-мітку `{statusId}` (ідемпотентно) — OWNER/ADMIN/STOREKEEPER                  |
| DELETE | `/api/goods/:goodId/statuses/:statusId`  | Зняти статус-мітку — OWNER/ADMIN/STOREKEEPER                                                   |

**Довідник статусів** (`/api/good-statuses`, окремий модуль — дзеркалить counterparty-statuses):

| Метод  | URL                              | Дія                                         |
| ------ | -------------------------------- | ------------------------------------------- |
| GET    | `/api/good-statuses`             | Список (?showDeleted=true) + `goodCount`    |
| POST   | `/api/good-statuses`             | Створити `{name, color?}` — OWNER/ADMIN     |
| PATCH  | `/api/good-statuses/:id`         | Rename/recolor — OWNER/ADMIN                |
| DELETE | `/api/good-statuses/:id`         | Soft-delete (links лишаються) — OWNER/ADMIN |
| POST   | `/api/good-statuses/:id/restore` | Відновити (active-dup → 409) — OWNER/ADMIN  |

> `GET /api/goods` (список) і `/:id` (detail) обидва повертають `statuses: {id,name,color}[]` (активні,
> `deletedAt:null`) — badge-и у таблиці + у картці. `goodCount` рахує лише активні товари
> (`_count.links where good.deletedAt:null`); soft-delete/restore товару з міткою скидає кеш довідника (Bug #725).

---

## UI (Web)

| Компонент / сторінка     | Файл                                                                              |
| ------------------------ | --------------------------------------------------------------------------------- |
| Каталог (вкладка Товари) | `app/(app)/catalog/page.tsx`                                                      |
| Довідник статусів (таб)  | `app/(app)/catalog/GoodStatusesTab.tsx` (вкладка «Статуси товарів»)               |
| Керування мітками        | `components/ui/GoodStatusManager.tsx` (badge-и + dropdown; controlled/self-fetch) |
| Edit Modal (з вкладками) | `components/ui/GoodEditModal.tsx` (GoodsTab; секція «Статуси» у формі)            |
| Hook (TanStack Query)    | `hooks/api/useInventory.ts`                                                       |

**Вкладки GoodEditModal:** info / barcodes / batches
**Вкладки Каталогу:** Роботи / Товари / Комплексні послуги / Одиниці / Бренди / **Статуси товарів**

---

## Ціноутворення (PricingService.resolveRule)

Розцінка бере всі активні правила організації: без межі вибірки, сторінками за курсором (`findAllInPages`). До 2026-10-22 тут був `take: 200`, і правила за цією межею мовчки не діяли. Сторінка «Ціноутворення» теж показує всі правила.

Ієрархія правил (від конкретного до загального); у межах рівня — менше число `priority`:

0. правило постачальника — лише коли розцінюється документ цього постачальника
1. товар є у списку правила (`PricingRuleGood`, BR-GOOD-009)
2. `brandId` — бренд
3. `goodCategoryId` — категорія з довідника, разом з усіма підкатегоріями; ближча до товару
   категорія перемагає (BR-GOOD-010). Після них — старі правила з текстовою `goodCategory`
4. `goodType` — тип
5. весь асортимент (область порожня)

Резолвер — `PricingService.resolveRule(ctx, good, costPrice, supplierId?)`; контекст (правила,
списки товарів лише для потрібних товарів, батьки категорій) дає `getPricingContext(orgId, goodIds)`.

**COST_TIER:** знайти тір де `costMin <= costPrice < costMax`; `costMax IS NULL` = останній тір.

**Guard:** `if (!costPrice || costPrice <= 0) skip` — без guard `0 * (1+p/100) = 0` перезаписує salePrice (Bug #198).

---

## Бізнес-правила (BR-GOOD)

- **BR-GOOD-001**: `GoodUoM.id ≠ UnitOfMeasure.id` — при роботі з UoM завжди зберігай `goodUoM.unitOfMeasureId`
- **BR-GOOD-002**: `deduplicateBy(plan, u => u.goodId)` ПЕРЕД `Promise.all` bulk-update цін (Bug #483)
- **BR-GOOD-003**: Pошук по `name + sku + barcode` через GIN trgm індекс (не LIKE — повільно без індексу)
- **BR-GOOD-004**: `preferredSupplierId` — підказка для PO, не обов'язковий
- **BR-GOOD-005**: Партії `StockBatch` — FIFO за замовчуванням (найстаріша `createdAt` першою)
- **BR-GOOD-006**: **Статуси-мітки (кастомні, M:N):** per-org довідник `GoodStatus` (name+color, configuration-over-hardcode — не enum), M:N через `GoodStatusLink`. Assign/unassign валідують good+status належать org (tenant-isolation); assign ідемпотентний (`@@unique[goodId,statusId]`, P2002→no-op); unassign неіснуючого → 404. Soft-delete статусу лишає links — `toDto` фільтрує `status.deletedAt:null`, restore відновлює призначення. Кеш довідника (`ref:good-statuses`, TTL 300с) скидається на assign/unassign І на soft-delete/restore товару з міткою (Bug #725). Права: assign/unassign — OWNER/ADMIN/STOREKEEPER; CRUD довідника — OWNER/ADMIN.
- **BR-GOOD-007**: **Бренди — одне написання належить одному бренду** (рішення власника 2026-10-12). Синонім бренду не може бути активним синонімом іншого бренду тієї самої організації, не може збігатися з назвою іншого бренду, а назва бренду — із синонімом іншого бренду. Порівняння без урахування регістру й пробілів по краях («Bosch» = «BOSCH»). Порушення → 409 до будь-якого запису, у тексті названо написання і бренд, з яким воно збіглось. Не вважаються зайнятими: знятий (soft-deleted) синонім, синонім видаленого бренду, дані іншої організації. У межах одного бренду повтори зводяться до першого написання; синонім, що збігається з назвою самого бренду, відкидається. Символи `_` і `%` у написанні — звичайні символи, не шаблон; пробіли всередині значущі («Kavo Parts» ≠ «Kavo Parts»). Правило діє на всіх шляхах запису: створення (зокрема воскресіння видаленого бренду), редагування, **відновлення** (назву могли додати синонімом іншому бренду, поки бренд був видалений → 409; синоніми видаленого бренду з ним не повертаються — вони зняті разом із брендом і вільні для інших) та імпорт брендів з XLSX (рядок, якому відмовило правило, пропускається з поясненням у `errors`, решта файла імпортується; наявний бренд — пропуск без помилки). Вільне написання (знятий синонім або синонім видаленого бренду) при додаванні переїжджає до нового власника, а не губиться мовчки; вільний рядок шукається теж без урахування регістру і переїжджає з новим написанням. База тримає унікальність активних синонімів без урахування регістру (індекс `(orgId, lower(synonym)) WHERE deletedAt IS NULL`), тому при збереженні знятий синонім знімається ДО запису нових: зміна регістру в межах бренду («Bosch» → «BOSCH») зберігає нове написання, а не пропускає його мовчки (2026-10-26). Перевірка і запис ідуть однією транзакцією під блокуванням організації (`pg_advisory_xact_lock('brands:<orgId>')`): два одночасні збереження з тим самим новим синонімом дають один успіх і один 409, у будь-якому регістрі. Імпорт товарів з Excel впізнає бренд спершу за нормалізованим написанням (A-Z0-9), потім за точним написанням без урахування регістру — тому кириличні назви й синоніми резолвляться, а не створюють дубль бренду. Модуль `brands` (`BrandsService.assertWritingsFree`, `underWritingsLock`, `resolveByNameOrSynonym`)
- **BR-GOOD-008**: **Єдиний пошук товару при завантаженні з файла** (рішення власника 2026-10-12). Рядок файла розв'язується каскадом, перший крок із рівно одним товаром перемагає: (1) код (`internalCode`, без регістру — порівняння в базі, зокрема для кирилиці й змішаного регістру); (2) артикул + бренд — артикул нормалізовано (`normalizeArticle`), бренд за назвою або синонімом, зокрема нормалізованим і кириличним (BR-GOOD-007); (3) штрихкод (таблиця штрихкодів або поле картки); (4) артикул без бренду; (5) точна назва — лише коли в рядку немає ні коду, ні артикула, ні штрихкоду. Кілька товарів на одному кроці → рядок неоднозначний (кандидати на вибір), а не «який трапився першим». Бренд у файлі розпізнано, а товар із таким артикулом має ІНШИЙ бренд → не підставляється сам, пропонується на вибір; товар без бренду в картці — підходить. Невідомий системі бренд не заважає пошуку за артикулом. Видалені товари й товари іншої організації не знаходяться. Діє в усіх завантаженнях: рядки закупівлі, складського документа й запчастин наряду (шаблон із необов'язковими колонками «Код», «Бренд», «Штрихкод» у кінці — старі файли читаються як раніше), «Розцінити список», імпорт товарів каталогу (наявність товару — за нормалізованим артикулом; наявний товар чи повтор у файлі — «пропущено», рядок без ціни продажу відхиляє весь файл із номером рядка, а якщо дійде до збереження — це помилка рядка, не «створено»), майстер імпорту рядків (колонки коду й штрихкоду беруть участь у пошуку; назва й частина артикула дають лише підказки-кандидати), список товарів правила ціноутворення. Не знайдений або неоднозначний рядок у шляхах без майстра стає помилкою рядка з переліком знайдених товарів; у «Розцінити список» — рядком у «не знайдено». Невідомий артикул більше не підміняється товаром з такою самою назвою. Модуль `goods` (`GoodMatcherService.matchMany`)
- **BR-GOOD-009**: **Правило ціноутворення націлюється на список товарів** (рішення власника 2026-10-12). Список — до 5000 товарів, вноситься вручну або з файла Excel/CSV (пошук товару — BR-GOOD-008; файл нічого не пише, список зберігається разом із правилом; при завантаженні користувач обирає «додати до списку» чи «замінити список»). Правило зі списком діє ЛИШЕ на товари списку — на решту воно не діє навіть як «весь асортимент». Область правила має один вимір: список товарів > бренд > категорія > тип; точніший вимір очищає загальніші. Товар чужої організації або видалений у списку → 404, правило не зберігається. Список заміщується цілком, в одній транзакції з правилом. PATCH без поля `goodIds` список не чіпає; форма надсилає `goodIds` лише після того, як користувач список змінив (у формі видно тільки живі товари). Одночасні PATCH одного правила виконуються послідовно (блокування на правило), стан зливається вже під блокуванням. Видалений товар у списку не показується й не рахується, але правило через це не стає загальним. Виняток — явний вибір: якщо в списку лишились тільки видалені товари, а PATCH без `goodIds` обирає бренд, категорію або тип, правило стає правилом цього виміру, зв'язки з видаленими товарами знімаються (Bug #834). Таблиця правил показує таке правило окремим підписом «Перелік: лише видалені товари (не діє)» — відповідь API має `hasGoodsList: true` при `goodsCount: 0`. Форма, з якої прибрали останній товар (і не обрано бренду, категорії чи типу), перед збереженням питає підтвердження: порожня область — це весь асортимент. «Застосувати до всіх» перераховує саме товари списку. Модуль `inventory` (`PricingRulesController`, `PricingService`)
- **BR-GOOD-010**: **Категорія правила ціноутворення — з довідника категорій товарів** (рішення власника 2026-10-12). Правило діє на товари обраної категорії й усіх її підкатегорій будь-якої глибини. Якщо товару підходять правила кількох рівнів дерева — перемагає правило ближчої категорії, незалежно від `priority`; `priority` розсуджує лише правила однієї категорії. Категорія чужої організації або видалена → 404 — коли її надсилає сам запит; категорію (і бренд), які вже стояли на правилі й були видалені пізніше, PATCH не перевіряє: правило лишається редагованим. Старі правила з текстовою категорією, яким міграція не знайшла рівно одну категорію з такою назвою, працюють як раніше (точний збіг із текстовим полем картки) і поступаються правилам із довідниковою категорією; вибір або зняття категорії у формі прибирає текст назавжди. Модуль `inventory` (`PricingService.resolveRule`, `applyRuleToGoods`)
- **BR-GOOD-011**: **«Застосувати до всіх» (`POST /pricing-rules/:id/apply-all`)** (TECH-DEBT §8 L644, 2026-10-26). Вимкнене правило → 400 «Правило вимкнене — увімкніть його…» (`err.pricingRule.inactive`), жоден товар не читається й не пишеться: вимкнене правило в розцінці участі не бере, і «застосувати» його означало б розцінити товари іншими правилами під його назвою. Перераховуються ВСІ невидалені товари області правила (область — BR-GOOD-009/010) — сторінками за курсором `id` (`APPLY_PAGE`), без стелі (до 2026-10-26 — `take: 5000` мовчки). Кожен товар розцінюється правилом-переможцем резолвера серед усіх активних правил, тож ціну товару може дати точніше правило (список, бренд, ближча категорія); саме воно, а не застосоване, пишеться в історію цін (`priceHistory.pricingRuleId`, `reason: "PricingRule: <назва>"`). Жодне правило не підійшло (застосовано правило постачальника, яке без постачальника не діє) → ціна = собівартість, `pricingRuleId: null`. Змінені лише товари, чия ціна відрізняється більш ніж на 0,001. Права — OWNER / ADMIN; на сторінці правил кнопки «+ Правило», «Перерахувати», «Редагувати», «Видалити» і шаблон списку розцінки бачать лише вони (комірник бачить правила й «Розцінити список», рішення власника №19). Модуль `inventory` (`PricingService.applyRuleToGoods`)

→ [docs/BUSINESS-RULES.md](../BUSINESS-RULES.md) (ціноутворення, deduplicateBy)
→ [docs/objects/inventory.md](inventory.md) (StockItem, StockMovement)

---

## Аспекти і тести, що їх стережуть

Правите один аспект — ганяєте один файл:

```bash
cd apps/api && npx vitest run src/modules/goods/<файл>.spec.ts
```

**Модуль:** `apps/api/src/modules/goods/`

**Маршрути UI:** `/catalog`, `/inventory`, `/pricing-rules`

| Аспект                                    | Тест                                      | Кейсів |
| ----------------------------------------- | ----------------------------------------- | ------ |
| dto                                       | `goods-query.dto.spec.ts`                 | 9      |
| HTTP-контракт (DTO, статуси, валідація)   | `goods-stock-totals.contract.spec.ts`     | 13     |
| рольовий доступ                           | `goods.role-gate.spec.ts`                 | 14     |
| сервісна логіка                           | `goods.service.spec.ts`                   | 59     |
| вільна кількість по складах (BR-WO-029)   | `goods.stock-free.spec.ts`                | 4      |
| статуси-мітки (assign / unassign, ролі)   | `goods.statuses.spec.ts`                  | 11     |
| бренди: одне написання — один бренд       | `../brands/brands.synonym-unique.spec.ts` | 22     |
| пошук товару за рядком файла (каскад)     | `good-matcher.spec.ts`                    | 20     |
| читання переліку товарів із файла         | `../xlsx/good-ref-rows.parser.spec.ts`    | 14     |
| перелік товарів для правила ціноутворення | `../xlsx/xlsx.pricing-rule-goods.spec.ts` | 4      |
| єдиний пошук товару в шляхах завантаження | `../xlsx/xlsx.good-matching.spec.ts`      | 11     |
| імпорт довідників: правдиві лічильники    | `../xlsx/xlsx.catalog-import.spec.ts`     | 6      |

Разом: **186** кейси (цифри з `vitest --reporter=json`, не з grep).

Web: `apps/web/src/components/ui/__tests__/XlsxImportButton.summary.test.tsx` — підсумок імпорту
(«пропущено» окремо, нульове «оновлено» не показується) і назви кнопок імпорту.

**Чого тут НЕМА.** Мітки `guards:` стоять, але unit-тести стережуть не все, що сказано у правилах:

- Пошук: тест фіксує форму запиту (рівно три поля, `contains` + `insensitive`), але не існування самих GIN trgm-індексів — вони живуть у ручних міграціях, і зниклий індекс unit-тест не помітить; це видно лише з `EXPLAIN` на живій БД.
- Статуси-мітки: у цьому модулі покрито assign / unassign, фільтр soft-deleted статусу в DTO, скидання кешу і ролі двох endpoint-ів. CRUD довідника, TTL кешу і restore статусу стереже сусідній `good-statuses.service.spec.ts`; ролі OWNER/ADMIN на `/api/good-statuses` не асертить ніхто. UI (`GoodStatusManager`, `GoodStatusesTab`) без компонентних тестів.
- Тотожність UoM: стережеться лише запис `Good.unitId` у трьох методах сервісу (addUoM / setDefaultUoM / removeUoM). Споживачі `unitOfMeasureId` в інших модулях і на фронті (рядки документів, вибір одиниці у формах) цим не покриті.
- Необов'язковість постачальника перевіряється на рівні сервісу (create без FK проходить); `@IsOptional` у DTO окремим кейсом не асертиться.
