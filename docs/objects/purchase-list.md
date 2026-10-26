# PurchaseList — Список купівлі (dossier)

> Товари під замовлення у постачальника: що треба закупити для нарядів і вручну. Рішення власника
> 2026-10-17 (етап 1 із трьох; етап 2 — API постачальників, етап 3 — розподіл за стратегією).
> Список не є документом обліку: залишків і розрахунків сам не змінює. Залишки змінює замовлення
> постачальнику ([purchase-order.md](purchase-order.md)), резерв під наряд — `InventoryService.createMovement`
> ([inventory.md](inventory.md), BR-INVT-018).

---

## Prisma модель

`packages/database/prisma/schema/07_inventory.prisma` — `PurchaseList`, `PurchaseListItem`; енуми в
`01_enums.prisma`. Міграції `20261017120000_purchase_lists` (таблиці, CHECK, partial-unique номера) і
`20261017120001_seed_purchase_list_doc_numbers` (нумерація `СК` наявним організаціям).

```prisma
model PurchaseList {
  number       String              // СК-…, DocumentType.PURCHASE_LIST; унікальний серед невидалених
  name         String?
  status       PurchaseListStatus  // OPEN | CLOSED | CANCELLED
  warehouseId  String?             // типовий склад для ручних позицій
  notes        String?
  mergedIntoId String?             // злито в інший список (BR-PL-006)
  closedAt     DateTime?
  items        PurchaseListItem[]
}

model PurchaseListItem {
  listId          String
  goodId          String
  warehouseId     String
  quantity        Float     // БАЗОВІ одиниці (BR-PL-002)
  receivedQty     Float     // отримано від постачальника за цією позицією
  reservedQty     Float     // з отриманого зарезервовано під наряд позиції (≤ receivedQty, CHECK)
  status          PurchaseListItemStatus  // OPEN | ORDERED | RECEIVED | CANCELLED
  source          PurchaseListItemSource  // WORK_ORDER | MANUAL
  workOrderId     String?
  workOrderPartId String?
  supplierId      String?   // може бути не визначений до створення замовлення
  expectedPrice   Decimal?
  purchaseOrderId String?   // зв'язок із замовленням — purchaseOrderId + goodId (НЕ id рядка)
}
```

**Відносини:** список → позиції (1:M); позиція → товар, склад, наряд і рядок наряду, постачальник
(`Counterparty`), замовлення постачальнику — усе M:1, необов'язкові крім товару, складу й списку.
Таблиці не синхронізуються з мобільним клієнтом (`sync.service.ts`, коментар до виключень).

---

## Статуси

```
Список:   OPEN ──close──→ CLOSED          OPEN ──merge (джерело)──→ CLOSED (+mergedIntoId)
              └──cancel──→ CANCELLED      (лише без ORDERED/RECEIVED позицій)

Позиція:  OPEN ──create-orders──→ ORDERED ──приймання (повністю)──→ RECEIVED
            │                        │
            └──cancel──→ CANCELLED   └──замовлення скасовано / видалено / рядок зник──→ OPEN
```

---

## Бізнес-правила (BR-PL)

- **BR-PL-001**: **Нумерація.** Номер списку — `DocumentNumberService.next(orgId, 'PURCHASE_LIST')`, типовий префікс `СК` (рішення власника 2026-10-17; змінюється в «Налаштування → Нумерація»). Номер береться ДО транзакції створення (пропуск номера при відмові допустимий, як в інших документах); серед невидалених номер унікальний (partial-unique `purchase_lists_orgId_number_active_uq`).
- **BR-PL-002**: **Кількості позиції — у базових одиницях товару.** Позиція з наряду отримує `кількість рядка × коефіцієнт його одиниці` (той самий коефіцієнт, що й резерв наряду, `fetchPartCoefficients`); ручна позиція — у базових одиницях. `quantity > 0`, `0 ≤ reservedQty ≤ receivedQty` (CHECK у БД); усі порівняння кількостей — з епсилоном `1e-6`. Нестача, прибуле й зарезервоване в картці наряду підписуються базовою одиницею товару, а не одиницею рядка (Bug #886).
- **BR-PL-003**: **Надсилання товарів із наряду** (`POST /purchase-lists/from-work-order`). Лише наряд організації, не видалений, у статусі з `WO_PROCUREMENT_ACTIVE_STATUSES` (DRAFT, ESTIMATE, APPROVED, IN_PROGRESS, ON_HOLD), інакше 400 `workOrderNotActive`; лише збережені рядки товарів цього наряду (чужий чи видалений рядок → 400 `partNotFound`). Ціль — наявний OPEN-список (`listId`) або новий (`newList`); закритий чи скасований → 400 `listNotOpen`. Кількість за замовчуванням — непокрита потреба рядка (BR-PL-014); якщо вона ≤ 0 → 400 `partAlreadyCovered`; рядок, повторений у тілі запиту, ту саму потребу вдруге не бере. OPEN-позиція того самого рядка наряду в цільовому списку збільшується, а не дублюється. Постачальник за замовчуванням — `Good.preferredSupplierId`. Рядок наряду блокується (`SELECT … FOR UPDATE`) до зміни позицій. Ролі: OWNER, ADMIN, STOREKEEPER, RECEPTIONIST.
- **BR-PL-004**: **Ручна позиція** (`POST /purchase-lists/:id/items`): товар і склад — організації й не видалені (404 інакше), постачальник — контрагент організації з роллю постачальника (`assertCounterpartyRole`, BR-CP-001); список — OPEN. `source = MANUAL`, без наряду. Ролі: OWNER, ADMIN, STOREKEEPER.
- **BR-PL-005**: **Змінюється лише OPEN-позиція** (кількість, постачальник, очікувана ціна, примітка, перенесення, розділення, скасування). Кожна зміна стану — `updateMany` з умовою на статус (і `purchaseOrderId: null`) та перевіркою кількості змінених рядків; розбіжність → 409 `concurrentChange` і відкат. ORDERED/RECEIVED/CANCELLED → 400 `itemNotOpen`.
- **BR-PL-006**: **Об'єднання списків** (`POST /purchase-lists/merge`): ціль і всі джерела — OPEN, ціль не серед джерел (400 `mergeIntoItself`). Усі невидалені позиції джерел (будь-якого статусу) переходять у цільовий список; джерела стають CLOSED з `mergedIntoId = ціль` і `closedAt`. Склади позицій не обмежуються — кожна позиція має свій склад.
- **BR-PL-007**: **Перенесення й розділення.** Перенести можна лише OPEN-позиції — в наявний OPEN-список або в новий (`newListName`); перенесення в той самий список → 400 `moveToSameList`. Розділення OPEN-позиції: `0 < кількість < quantity` (400 `splitQuantityInvalid` інакше) — нова OPEN-позиція з тими самими наряд, рядок наряду, товар, склад, постачальник, ціна; у вихідної кількість зменшується.
- **BR-PL-008**: **Створення замовлень постачальникам** (`POST /purchase-lists/create-orders`, ролі OWNER, ADMIN, STOREKEEPER). Усі позиції — OPEN, без замовлення, не видалені; у кожної є постачальник (інакше 400 `supplierRequired` з назвами товарів, нічого не створено). Позиції групуються за (постачальник, склад) — одне замовлення DRAFT на групу; рядок замовлення — на (товар, ціна) з сумою кількостей, ціна = `expectedPrice ?? Good.purchasePrice ?? 0`. Номери беруться до транзакції; замовлення (`PurchaseOrdersService.insertInTx` — той самий запис, що й `createInTx` у `create()`) і перехід позицій у ORDERED з `purchaseOrderId` — в одній транзакції з CAS (BR-PL-005).
- **BR-PL-009**: **Звірка чернетки замовлення.** Коли рядки DRAFT-замовлення переписано (`PATCH /purchase-orders/:id` з `lines`, імпорт рядків XLSX — заміна й додавання), позиції цього замовлення звіряються за товаром: товару в замовленні більше немає → позиція повертається в OPEN (`purchaseOrderId = null`); сума кількостей позицій товару більша за кількість у рядках → новіші позиції відв'язуються (або розділяються) так, щоб прив'язане вміщалось у замовлене. Змінено склад чернетки (`PATCH` з `warehouseId`) → позиції іншого складу повертаються в OPEN без замовлення: приймання розподіляє отримане лише між позиціями складу замовлення (BR-PL-011). Позиції пишуться ДО рядка замовлення — той самий порядок блокувань, що в прийманні, скасуванні й видаленні (без deadlock). Відв'язане від завершеного, скасованого чи видаленого наряду стає «Скасовано», а не «Не замовлено» (як у BR-PL-010).
- **BR-PL-010**: **Скасування й видалення замовлення.** Видалене (DRAFT) чи скасоване замовлення повертає свої позиції: не отримана жодна одиниця → OPEN без `purchaseOrderId`; частково отримана → позиція стає RECEIVED із `quantity = receivedQty`, а на решту створюється нова OPEN-позиція з тими самими зв'язками. Якщо наряд позиції вже завершено, скасовано чи видалено, решта отримує статус «Скасовано», а не «Не замовлено» — закуповувати її для наряду вже не треба (рішення власника 2026-10-18).
- **BR-PL-011**: **Розподіл отриманого.** У `PurchaseOrdersService.receive`, у тій самій транзакції, після руху RECEIPT і до нарахування боргу: для кожного отриманого рядка (товар, кількість) ORDERED-позиції цього замовлення й товару на складі замовлення беруться за FIFO (`createdAt`); кожна отримує `min(залишок отриманого, quantity − receivedQty)` (CAS на `receivedQty`; повністю отримана → RECEIVED). Під наряд позиції резервується `min(отримане позицією, непокрита потреба наряду за товаром і складом, available)` — рухом `RESERVATION` з `documentType 'WorkOrder'` і id наряду (BR-INVT-018), і лише для невидаленого наряду в `WO_PROCUREMENT_ACTIVE_STATUSES`; `reservedQty` позиції зростає на зарезервоване. Решта лишається вільним залишком. Розподіл ніколи не спричиняє відмову приймання через брак `available`. Наряди-кандидати блокуються (`FOR UPDATE`, за id) ДО змін залишку — порядок блокувань «наряд → склад» той самий, що й у переходах наряду. Порядок FIFO — за інтерфейсом стратегії (гачок етапу 3).
- **BR-PL-012**: **Остача після повного приймання.** Коли замовлення стало RECEIVED — повним прийманням або переходом «Отримано» (`POST /purchase-orders/:id/transition`, постачальник більше не привезе; Bug #885), — а ORDERED-позиції мають недоотримане (постачальник привіз менше, ніж у позиціях), отримана частина стає RECEIVED, а на решту створюється нова OPEN-позиція з тими самими зв'язками. Якщо наряд позиції вже завершено, скасовано чи видалено, решта отримує статус «Скасовано», а не «Не замовлено» — закуповувати її для наряду вже не треба (рішення власника 2026-10-18).
- **BR-PL-013**: **Зміни наряду.** Зменшено кількість чи прибрано рядок товару (у редагованих статусах, зокрема імпортом XLSX): OPEN-позиції наряду за цим товаром і складом урізаються, новіші першими, на надлишок покриття (`покриття = резерв наряду + недоотримане ORDERED + OPEN`); позиція з обраною пропозицією урізається до кратності вгору (BR-SOFR-006), а надлишок, якого через кратність не зняли, переходить на старіші; ORDERED не змінюються (при прийманні резерв обмежить потреба, BR-PL-011). Наряд скасовано, видалено або завершено: його OPEN-позиції → CANCELLED; ORDERED лишаються, а отримане за ними не резервується. `reservedQty` позицій наряду не перевищує його net-резерв за товаром і складом: після скасування, видалення чи зменшення потреби (резерв знято, BR-WO-021) він зменшується, новіші першими. Потребу зменшили, поки позиція була в замовленні (ORDERED не урізаються): кожне повернення позиції з замовлення в OPEN — звірка чернетки (BR-PL-009), скасування й видалення (BR-PL-010), остача (BR-PL-012), «Повернути непідтверджене» (BR-SCON-013) — урізає OPEN-позиції наряду до непокритої потреби за тим самим правилом (Bug #912, #916).
- **BR-PL-014**: **Нестача** (`GET /purchase-list-items/shortage`). Для кожного рядка товару невидаленого наряду в `WO_PROCUREMENT_ACTIVE_STATUSES`: `потреба = кількість × коефіцієнт`; покрито резервом наряду (net-резерв за товаром і складом розподіляється між рядками наряду FIFO), позиціями цього рядка (OPEN + недоотримане ORDERED) і пулом складу: вільний залишок (`quantity − reserved`) плюс ручні позиції (OPEN + недоотримане ORDERED) за товаром і складом, розподілений між нарядами FIFO за `plannedAt ?? createdAt`. Повертаються рядки з нестачею > 0; ліміт рядків із прапорцем `truncated`. Та сама непокрита потреба — кількість за замовчуванням у BR-PL-003.
- **BR-PL-015**: **Ролі.** Перегляд списків, позицій і нестачі, надсилання з наряду, створення списку — OWNER, ADMIN, STOREKEEPER, RECEPTIONIST. Позиції наряду в картці (`GET /purchase-list-items/by-work-order/:id`) — ці ж ролі й MECHANIC. Редагування списків і позицій, ручні позиції, об'єднання, перенесення, розділення, скасування, створення замовлень і зняття резерву — OWNER, ADMIN, STOREKEEPER. У web приймальня бачить на сторінці «Купівля» лише вкладку «Управління купівлями» (рішення власника 2026-10-17). Очікувана ціна позиції — закупівельна: у відповідях для ролей без доступу до `Good.purchasePrice` (приймальня, механік) вона `null` (`maskItemCost`, §2.1).
- **BR-PL-016**: **Зняти резерв** (`POST /purchase-list-items/:id/release-reservation`, OWNER, ADMIN, STOREKEEPER; рішення власника 2026-10-17): рух `RESERVATION_RELEASE` на `min(reservedQty, net-резерв наряду за товаром і складом)`, `reservedQty` позиції зменшується; нічого не зарезервовано → 400 `nothingToRelease`. Потрібно, щоб повернути отримане постачальнику чи віддати в інший наряд: повернення й списання зарезервованого без цього не проходять (BR-INVT-003).
- **BR-PL-017**: **Знімок пропозиції йде за позицією** (рішення власника 2026-10-18). Обрана пропозиція постачальника зберігається на позиції (`offer*`, BR-SOFR-006). Кожне розділення позиції — «Розділити», остача при прийманні й скасуванні (BR-PL-010, BR-PL-012), повернення непідтвердженого (BR-SCON-013), автопідбір (BR-SOFR-009) — копіює знімок у нову частину (`copyOfferSnapshot`); повернення непідтвердженого постачальником знімок не копіює. Відкрита частина зі знімком і змінена кількість позиції зі знімком кратні пропозиції — некратна округлюється вгору (BR-SOFR-006, `setItemQuantity`); скасована частина — як є.
- **BR-PL-018**: **Замовлення зі списку з пропозиціями.** `create-orders` групує позиції, як і раніше, за (постачальник, склад); рядок замовлення — на (товар, ціна, `offerKey`), тож дві пропозиції того самого товару з різних складів постачальника не зливаються. Ціна рядка — `expectedPrice` у гривні; замовлення завжди в гривні (рішення власника).
- **BR-PL-019**: **Ручна зміна позиції й пропозиція.** Зміна постачальника на іншого контрагента скидає знімок пропозиції; збільшення кількості понад кількість пропозиції знімок лишає, а відповідь позначає `offerQtyExceeded` (крім обмеженої кількості «≥N» — це нижня межа). Масова зміна постачальника (`bulk-update`) скидає знімок так само.

---

## API Endpoints

Тіла запитів — zod-схеми `packages/shared/src/schemas/forms/purchase-list.schema.ts`
(`ZodValidationPipe`); помилки — `err.purchaseList.*`. R = OWNER, ADMIN, STOREKEEPER, RECEPTIONIST;
S = OWNER, ADMIN, STOREKEEPER (BR-PL-015). Контролери — `apps/api/src/modules/purchase-lists/`.

| Метод  | Шлях                                                  | Ролі         | Що                                                                                        |
| ------ | ----------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------- |
| GET    | `/api/purchase-lists`                                 | R            | Списки (`status`, `q`, пагінація) з лічильниками позицій                                  |
| POST   | `/api/purchase-lists`                                 | R            | Новий список (BR-PL-001), Idempotency-Key                                                 |
| POST   | `/api/purchase-lists/from-work-order`                 | R            | Товари наряду → список (BR-PL-003), Idempotency-Key                                       |
| POST   | `/api/purchase-lists/linked-counts`                   | R            | Лічильники зв'язків (наряди, замовлення, злиті списки)                                    |
| GET    | `/api/purchase-lists/:id`                             | R            | Список з позиціями                                                                        |
| GET    | `/api/purchase-lists/:id/linked-documents`            | R            | Наряди й замовлення позицій, злиті списки                                                 |
| PATCH  | `/api/purchase-lists/:id`                             | S            | Назва, типовий склад, примітка (лише OPEN)                                                |
| POST   | `/api/purchase-lists/:id/items`                       | S            | Ручна позиція (BR-PL-004)                                                                 |
| POST   | `/api/purchase-lists/merge`                           | S            | Об'єднання (BR-PL-006)                                                                    |
| POST   | `/api/purchase-lists/create-orders`                   | S            | Замовлення постачальникам з позицій (BR-PL-008), Idempotency-Key                          |
| POST   | `/api/purchase-lists/:id/close`                       | S            | Закрити (OPEN → CLOSED)                                                                   |
| POST   | `/api/purchase-lists/:id/cancel`                      | S            | Скасувати — лише без ORDERED/RECEIVED (`cancelHasOrdered`)                                |
| DELETE | `/api/purchase-lists/:id`                             | S            | Soft-delete — лише без ORDERED/RECEIVED; позиції видаляються разом                        |
| GET    | `/api/purchase-list-items`                            | R            | Позиції (`status`, `supplierId` / `none`, `warehouseId`, `workOrderId`, `listId`, `q`)    |
| GET    | `/api/purchase-list-items/shortage`                   | R            | Нестача по нарядах (BR-PL-014), `truncated`                                               |
| GET    | `/api/purchase-list-items/by-work-order/:workOrderId` | R + MECHANIC | Позиції наряду й нестача кожного його рядка з базовою одиницею `goodUnit` (картка наряду) |
| PATCH  | `/api/purchase-list-items/:id`                        | S            | Кількість, постачальник, ціна, примітка (лише OPEN, BR-PL-005)                            |
| POST   | `/api/purchase-list-items/:id/split`                  | S            | Розділити (BR-PL-007)                                                                     |
| POST   | `/api/purchase-list-items/move`                       | S            | Перенести в наявний або новий список (BR-PL-007)                                          |
| POST   | `/api/purchase-list-items/bulk-update`                | S            | Масово: постачальник, очікувана ціна                                                      |
| POST   | `/api/purchase-list-items/bulk-cancel`                | S            | Масово скасувати OPEN-позиції                                                             |
| POST   | `/api/purchase-list-items/:id/release-reservation`    | S            | Зняти резерв (BR-PL-016)                                                                  |

**Модулі.** `PurchaseListCoreModule` — `PurchaseListLinkService` (хуки наряду й замовлення,
BR-PL-009/010/012/013) і `PurchaseListReceiptService` (розподіл отриманого, BR-PL-011; порядок —
`AllocationStrategy`, етап 1 — FIFO); залежить лише від складу, тож його імпортують
`WorkOrderStockEffectsModule`, `PurchaseOrdersModule` і `XlsxModule` без циклу.
`PurchaseListsModule` — контролери, `PurchaseListsService`, `PurchaseListItemsService`,
`PurchaseShortageService`, `PurchaseListOrdersService`. Потреба й резерв наряду — спільні
`apps/api/src/modules/work-orders/work-order-stock-requirements.ts`.

---

## UI (Web)

**Маршрути UI:** `/purchase-orders`, `/work-orders`

Вкладка «Управління купівлями» на сторінці «Купівля» (`app/(app)/purchase-orders/page.tsx`,
`?tab=procurement`; приймальня бачить лише її — `PurchaseProcurementPage`, BR-PL-015):

- `purchase-orders/ProcurementTab.tsx` — види `?view=shortage|items|lists`; `?list=<id>` відкриває
  картку списку (deep link `nav.toPurchaseList` з пов'язаних документів наряду й замовлення);
- `purchase-orders/procurement/ShortageView.tsx` — нестача (BR-PL-014) → «До списку купівлі»;
- `purchase-orders/procurement/ItemsView.tsx` — позиції з фільтрами (статус, постачальник / «без
  постачальника», склад, список, пошук) і масовими діями: постачальник і ціна, перенесення,
  «Створити замовлення», скасування; у рядку — «Розділити», «Зняти резерв»;
- `purchase-orders/procurement/ListsView.tsx` — списки, новий, «Обʼєднати»; картка списку:
  «Винести в новий список», ручна позиція, «Створити замовлення», закрити / скасувати / видалити.

Картка наряду (`components/ui/CreateWorkOrderModal.tsx` → `work-order/PartsTable.tsx`; сторінка
`/work-orders/[id]` → `WorkOrderPartsSection.tsx`): бейдж стану біля залишку збереженого рядка
(`purchase-list/ProcurementBadge.tsx`) і «До списку купівлі» (`purchase-list/WorkOrderProcurement.tsx`,
спільний діалог `purchase-list/AddToListDialog.tsx`). Товар і склад збереженого рядка — лише для
читання. Хук — `hooks/api/usePurchaseLists.ts`; кеш після дій — `invalidateProcurementSideEffects`.

---

## Аспекти і тести, що їх стережуть

Правите один аспект — ганяєте один файл:

```bash
cd apps/api && npx vitest run src/modules/purchase-lists/<файл>.spec.ts
```

**Модуль:** `apps/api/src/modules/purchase-lists/`

| Аспект                                                                                                                                                                   | Тест                                        | Кейсів |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- | ------ |
| HTTP-контракт: ролі (BR-PL-015), zod-тіла                                                                                                                                | `purchase-lists.contract.spec.ts`           | 26     |
| надсилання з наряду, нумерація, базові одиниці (BR-PL-001…003), позиції в картці наряду                                                                                  | `purchase-lists.from-work-order.spec.ts`    | 18     |
| ручна позиція, лише OPEN, об'єднання, перенесення й розділення (BR-PL-004…007)                                                                                           | `purchase-lists.merge-split.spec.ts`        | 15     |
| нестача по нарядах (BR-PL-014)                                                                                                                                           | `purchase-lists.shortage.spec.ts`           | 4      |
| вплив змін наряду на позиції (BR-PL-013)                                                                                                                                 | `purchase-lists.work-order-changes.spec.ts` | 8      |
| замовлення зі списку, рядки за пропозицією (BR-PL-008, 018, BR-PO-010)                                                                                                   | `purchase-lists.create-orders.spec.ts`      | 7      |
| розподіл отриманого й резерв (BR-PL-011, BR-PO-009, BR-INVT-018), «Зняти резерв» (BR-PL-016)                                                                             | `purchase-lists.receive-allocation.spec.ts` | 15     |
| звірка чернетки, видалення й скасування, остача; решта позиції закритого (завершеного, скасованого, видаленого) наряду — «Скасовано» (BR-PL-009, 010, 012)               | `purchase-lists.po-lifecycle.spec.ts`       | 18     |
| звʼязки списку й наряду                                                                                                                                                  | `purchase-lists.linked-docs.spec.ts`        | 4      |
| знімок пропозиції постачальника: розділення, остача, повернення непідтвердженого, зміна постачальника, кратність після вибору (BR-PL-017, 019, BR-SCON-013, BR-SOFR-006) | `purchase-lists.offer-snapshot.spec.ts`     | 11     |

Разом: **120** кейсів (цифри з `vitest --reporter=json`, не з grep).

Спеки — справжні сервіси над таблицями в пам'яті (`purchase-lists.spec-fixture.ts` поверх
`work-orders/work-order-stock.spec-fixture.ts`: справжній InventoryService, відкат транзакції,
журнал блокувань нарядів).

Жива БД: `purchase-lists.receive-vs-cancel.integration.spec.ts` — одночасні приймання (резерв під
наряд) і скасування наряду: без deadlock, скасований наряд резерву не тримає (BR-PL-011, BR-WO-021).

Поза модулем: `work-orders/work-order-stock-effects.reservation-lifecycle.spec.ts` (BR-WO-021,
BR-INVT-018), `xlsx/document-line-import.adapter.spec.ts` і `xlsx/xlsx.service.spec.ts` (імпорт рядків —
BR-PL-009, BR-WO-021). Web: `purchase-orders/__tests__/PurchaseOrdersPage.procurement-tab.test.tsx`,
`ProcurementTab.test.tsx`, `ItemsView.po-link-release.test.tsx` (номер замовлення для приймальні — текст, «Зняти резерв» лише для активного наряду), `procurement/__tests__/FormDialog.test.tsx` (повторне надсилання, поки запит іде), `components/ui/purchase-list/__tests__/*`,
`components/ui/__tests__/CreateWorkOrderModal.procurement.test.tsx`,
`settings/__tests__/NumbersTab.purchase-list.test.tsx`. E2E через браузер — `apps/web/e2e/purchase-lists.spec.ts`.
