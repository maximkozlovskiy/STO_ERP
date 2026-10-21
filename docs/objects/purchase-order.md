# PurchaseOrder — Dossier

> Замовлення постачальнику. Фіксує що і за якою ціною закупили, ініціює надходження товару на склад.

---

## Prisma модель

```prisma
model PurchaseOrder {
  id           String              @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId        String              @db.Uuid
  supplierId   String              @db.Uuid    // контрагент-постачальник
  warehouseId  String              @db.Uuid    // куди приймаємо товар
  contractId   String?             @db.Uuid    // договір з постачальником (optional)
  number       String
  status       PurchaseOrderStatus @default(DRAFT)
  totalAmount  Decimal             @default(0) @db.Decimal(12, 2)
  currencyId      String?          @db.Uuid   // мультивалюта Фаза 3: валюта документа
  totalAmountBase Decimal?         @db.Decimal(12, 2) // тотал у БАЗОВІЙ валюті по курсу на documentDate
  rateUsed        Decimal?         @db.Decimal(18, 6)
  paidAmount   Decimal             @default(0) @db.Decimal(12, 2) // payables Фаза 5: Σ проведених оплат (валюта PO)
  paidAt       DateTime?           @db.Date   // дата першої повної оплати (тригер payables FX)
  notes        String?
  documentDate DateTime            @default(now()) @db.Date
  syncVersion  BigInt              @default(0)
  createdAt    DateTime            @default(now())
  updatedAt    DateTime            @updatedAt
  deletedAt    DateTime?
}

// Мультивалюта (Фаза 3, 2026-09-14): totalAmount/рядки у валюті замовлення; totalAmountBase — у базовій
// по курсу на documentDate (create/update; fallbackToLatest). Прийом (receive) → SUPPLIER_CHARGE
// пробрасує currencyId+дату прийому → борг постачальнику у base (кожен частковий прийом — свій курс).
// Payables FX (Фаза 5, 2026-09-14): paidAmount — Σ проведених SupplierPayment (вісь ОПЛАТИ, окрема від
// status=прийом); повна оплата (paidAmount>=totalAmount−0.005 → paidAt) в іновалюті → supplier-payments.
// confirm() визнає realized FX (курс прийому≠курс оплати). ⚠️ ЗНАК ІНВЕРТОВАНИЙ vs клієнт: fx=chargeBase−
// paidBase → fx>0=FX_GAIN, fx<0=FX_LOSS (бо SUPPLIER_CHARGE=−1/SUPPLIER_PAYMENT=+1). Валюта SP==валюта PO (guard).

model PurchaseOrderLine {
  purchaseOrderId String    @db.Uuid
  goodId          String    @db.Uuid
  quantity        Float
  price           Decimal   @db.Decimal(12, 2)
  receivedQty     Float     @default(0)      // скільки вже прийнято
  unitOfMeasureId String?   @db.Uuid
}
```

**Відносини:**

- → `Counterparty` (supplier)
- → `Warehouse` (куди)
- → `CounterpartyContract` (optional)
- ← `PurchaseOrderLine[]`

---

## FSM

```
DRAFT → ORDERED → PARTIAL → RECEIVED
      ↘ CANCELLED  ↘ CANCELLED  ↘ CANCELLED
```

| Статус      | Значення                                      |
| ----------- | --------------------------------------------- |
| `DRAFT`     | Чернетка, редагується                         |
| `ORDERED`   | Відправлено постачальнику, очікуємо           |
| `PARTIAL`   | Часткове надходження (receivedQty < quantity) |
| `RECEIVED`  | Повністю прийнято                             |
| `CANCELLED` | Скасовано                                     |

**FSM файл:** `apps/api/src/modules/purchase-orders/purchase-orders.service.ts`

---

## API Endpoints (`/api/purchase-orders`)

| Метод  | URL                                      | Дія                                                                                                                                                                    |
| ------ | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/purchase-orders`                   | Список (фільтри: status, supplierId, dateFrom, dateTo; sort: documentDate/createdAt/totalAmount/paymentDate; DTO += `paidAmount`/`outstanding`/`isFullyPaid`/`paidAt`) |
| GET    | `/api/purchase-orders/:id`               | Деталь з lines (той самий `toDto()` → `paidAmount`/`outstanding`/`isFullyPaid`/`paidAt` присутні й тут, персистентні з `PurchaseOrder.paidAmount`, Фаза 5)             |
| GET    | `/api/purchase-orders/:id/lines-summary` | Зведення по рядках замовлення (BR-WO-009 у `work-order.md`); ролі — як у списку. Те саме для повернення: `/api/supplier-returns/:id/lines-summary`                     |
| POST   | `/api/purchase-orders`                   | Створити (lines у body)                                                                                                                                                |
| PATCH  | `/api/purchase-orders/:id`               | Оновити (тільки DRAFT)                                                                                                                                                 |
| DELETE | `/api/purchase-orders/:id`               | Soft-delete (тільки DRAFT; позиції списків купівлі → OPEN, BR-PO-010)                                                                                                  |
| POST   | `/api/purchase-orders/:id/transition`    | FSM перехід (DRAFT → ORDERED)                                                                                                                                          |
| POST   | `/api/purchase-orders/:id/receive`       | Приймання товару → StockMovement(RECEIPT) + CHARGE                                                                                                                     |
| POST   | `/api/purchase-orders/:id/apply-pricing` | Застосувати ціни закупки до Good.purchasePrice                                                                                                                         |

---

## UI (Web)

| Компонент / сторінка   | Файл                                                                                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Список                 | `app/(app)/purchase-orders/page.tsx`                                                                                                                  |
| Модалка створення      | `components/ui/PurchaseOrderCreateModal.tsx`                                                                                                          |
| Detail Panel schema    | `lib/panel-schema.ts` → `PURCHASE_ORDER_PANEL_SCHEMA`                                                                                                 |
| Detail Panel повернень | `lib/panel-schema.ts` → `SUPPLIER_RETURN_PANEL_SCHEMA` (вкладка «Повернення»; ключ панелі `supplier-returns`)                                         |
| Hook (TanStack Query)  | `hooks/api/usePurchaseOrders.ts`                                                                                                                      |
| Вкладка «Графік оплат» | `app/(app)/purchase-orders/SupplierPaymentScheduleTab.tsx` (`?tab=schedule`; ролі `GET /supplier-payments/schedule`)                                  |
| Кнопка «Оплатити»      | `components/ui/PurchaseOrderCreateModal.tsx` → `SupplierPaymentCreateModal` (створює й проводить оплату)                                              |
| Передача в API         | `components/ui/purchase-order/SupplierApiOrderBlock.tsx` у картці (BR-PO-011); скасування / видалення відправленого — `useSentOrderForce` (BR-PO-012) |

**Вкладки сторінки «Купівлі»:** «Замовлення» · «Повернення» · «Графік оплат» (колишня сторінка оплат
постачальникам; бухгалтер бачить лише її). Старі адреси `/supplier-payments*` ведуть на `?tab=schedule`.

**Колонки списку** (`COLUMNS` у page.tsx, toggle/reorder через `useListPage`): Номер, Постачальник,
Склад, Статус, Сума, Дата документа, **Дата оплати** (сортовна, `paymentDate`, NULLS LAST при DESC —
Bug #598), **Днів до оплати** (`ExpiryBadge` «N дн.»/«Прострочено N дн.», кольори warning/destructive,
показується ЛИШЕ де `outstanding > 0`), Розцінено. `today` через SSR-safe `useState`+`useEffect`.

---

## Імпорт позицій з файлу накладної

Майстер `ExcelImportWizard` (web) + модуль `apps/api/src/modules/xlsx/`. Працює і для
`PurchaseOrder`, і для `StockDocument` (адаптери у `document-line-import.adapter.ts`).

**Формати:** `.xlsx` / `.csv` / `.pdf` (текстовий **і скан**) / `.jpg`, `.png` (фото, скан). Усі зводяться до спільної сітки `string[][]`
у `DocumentGridParserService.parseGrid(buffer, filename)` — диспатч за розширенням, архітектура
дзеркалить `BankStatementParserService`.

**Ланцюжок постачальників тексту** (`TEXT_LAYER_PROVIDERS`): спершу `pdfjs` — дешевий і ТОЧНИЙ
текстовий шар (мілісекунди); якщо його немає — `ocr` (секунди, приблизно). `fragmentsToGrid`
джерело-агностична, тож обидва шляхи сходяться в одну сітку.

**PDF-текст:** `pdf-grid.extractor.ts` читає шар через `pdfjs-dist` і відновлює колонки з координат
(смуги — за ОРДИНАЛЬНОЮ позицією у тілі таблиці; кластеризація за лівим краєм x ламається на
правовирівняних числах).

**OCR (фото і скани):** `ocr-text-layer.provider.ts` — локальний `tesseract.js` (WASM), моделі
`ukr+eng` у `apps/api/assets/tessdata`, `cacheMethod:'none'` → **жодної мережі** (ADR-001).
PDF-скан спершу растеризується (`pdf-rasterizer.ts`, 200 DPI, async-генератор — пік памʼяті = одна
сторінка при `mem_limit: 1g`); фото йде в OCR напряму.
⚠️ Tesseract віддає **окремі слова**, а не комірки → обовʼязковий `mergeWordsIntoCells` перед
`fragmentsToGrid`, інакше назва товару дає зайву колонку.
Точність: назви/кількості/ціни добре, артикули залежно від кегля — нерозпізнані йдуть у
«ambiguous/notFound → ручний вибір». OCR-нормалізацію символів свідомо НЕ робимо.
`ParsedGrid.ocr` → UI попереджає про звірку лише для OCR, не для текстового PDF.
HEIC не підтримуємо (не читають ні tesseract, ні canvas) — чесна помилка з інструкцією.

**Колонки:** визначаються автоматично за рядком-заголовком (`detectMappingFromGrid` із
`@sto/shared`, рахується на клієнті). Пріоритет: ручна правка > збережений мапінг контрагента
(`CounterpartyImportMapping`) > автодетект > дефолт. ⚠️ `isMeaningfulMapping` обовʼязковий:
сервіс мапінгу віддає дефолтну пустушку, а не `null`.

**Режим запису** (`ApplyImportDto.mode`):

- `replace` (дефолт) — `adapter.replaceLines`: soft-delete усіх наявних + createMany нових;
- `append` — `adapter.appendLines`: наявні лишаються, тотали перераховуються по **обʼєднаному**
  набору (інакше наявні позиції зникли б із `totalAmount`/`totalVat`/`totalAmountBase`), колізія
  `goodId` з наявним рядком **доливає кількість** (ціна нова) — `@@unique(docId, goodId)` немає,
  тож другий рядок задвоїв би позицію.

UI показує режим лише коли в документі вже є позиції (`existingLineCount` з `fields.length`).
Імпорт дозволений лише у статусі `DRAFT` (`adapter.assertDraft`).

---

## Бізнес-правила: receive() інваріанти (BR-PO)

1. **BR-PO-001**: `activeLines` — рядки ЗАПИТУ (`dto.lines`), у яких `lineId` належить цьому замовленню
   і `receivedQty` у запиті > 0. На залишок рядка (`quantity - receivedQty`) фільтр НЕ дивиться:
   рядок запиту з `receivedQty = 0` пропускається без запису; `lineId`, якого немає серед рядків
   замовлення, мовчки відкидається (без 4xx); повністю прийнятий рядок із `receivedQty > 0` у запиті
   не відфільтровується, а дає 400 від over-receipt guard (BR-PO-003).
2. **BR-PO-002**: дубль `lineId` у `dto.lines` → 400 `err.purchaseOrder.receiveLineMustBeUnique` ДО
   `$transaction` (перевірка через `Set`, жодного запису). Дублі НЕ схлопуються: два рядки з тим самим
   `lineId` дали б подвійний `increment`. `deduplicateBy` у `receive()` не вживається — єдиний його
   виклик у сервісі стоїть в `applyPricing()` і схлопує план за `goodId` перед оновленням `Good.salePrice`.
3. **BR-PO-003**: `receivedQty` не може перевищити `line.quantity` (guard у DTO)
4. **BR-PO-004**: **create/update: `validateLineGoodIds(orgId, lines)`** — усі goodId рядків мусять належати org
   (Good.id глобально унікальний → інакше cross-tenant FK-injection). Кидає 404 ДО запису.
5. **BR-PO-005**: receive() у `$transaction` (2 кроки, порядок критичний):
   - **КРОК 1 — CAS per-line (НЕ просто stale-read!):** `purchaseOrderLine.updateMany({where:{id,orgId,
receivedQty:<очікуване>}, data:{increment}})` ПОСЛІДОВНО; `count===0`→throw. Concurrent/дубльований
     receive() уже змінив receivedQty → CAS не матчить → rollback ДО руху/боргу (без подвоєння).
   - **КРОК 2** (після CAS усіх рядків): `InventoryService.createMovement(RECEIPT)` (Promise.all) +
     один `SettlementsService.createTransaction(SUPPLIER_CHARGE)` — борг перед постачальником.

6. **BR-PO-006**: **«Розцінити правилом» (`applyPricing` з `ruleId`) змінює лише рядки, які обране
   правило покриває.** Рядок поза областю правила (товар не у списку правила, інший бренд чи
   категорія; правило вимкнене, видалене або чуже) не потрапляє ні в `Good.salePrice`, ні в
   `PriceHistory`, ні в `pricedSalePrice` рядка, і його немає в `details` відповіді. Без `ruleId`
   поведінка стара: рядок без жодного правила отримує ціну = собівартість. `ruleId` — UUID
   (`ApplyPricingDto`), інакше 400 (Bug #832, #835).
7. **BR-PO-007**: **Швидкий імпорт рядків із шаблону XLSX (`POST /xlsx/import/purchase-order-lines/:id`,
   кнопка «Імпорт XLSX» у картці) лишає документ узгодженим.** Імпорт пише рядки напряму
   (оновлює кількість і ціну наявних, додає нові; частковий успіх допускається), тому одразу після
   запису — окремою транзакцією і лише якщо щось записано — перераховуються ПДВ кожного активного
   рядка за чинним режимом організації і тотали замовлення (`totalAmount`, `totalVat`,
   `totalAmountBase`) по всіх активних рядках: `PurchaseOrderImportAdapter.syncAfterDirectLineWrite`.
   Сума документа після імпорту дорівнює сумі рядків без натискання «Зберегти» (Bug #843).
8. **BR-PO-008**: **У поверненні постачальнику той самий товар може стояти кількома рядками** (рішення власника 2026-10-13; наприклад, із різною ціною). Створення й оновлення зберігають усі надіслані рядки без злиття за товаром, у надісланому порядку; сума документа — сума всіх рядків, кожен округлений окремо. Проведення створює окремий рух списання на кожен рядок, послідовно, тому достатність залишку перевіряється за сумою по товару: якщо разом рядки перевищують доступний залишок, проведення відхиляється цілком («Недостатньо товару на складі») і нічого не списано. Розрахунок із постачальником один, на суму документа. Раніше повтори мовчки зливались (`deduplicateBy`), і перший рядок зникав разом із кількістю. Модуль `supplier-returns` (`create`, `update`, `confirm`)
9. **BR-PO-009**: **Приймання резервує отримане під наряди** (рішення власника 2026-10-17). Після руху RECEIPT і до боргу постачальнику `receive()` у тій самій транзакції розподіляє отримане між ORDERED-позиціями списків купівлі цього замовлення й резервує під їхні наряди (BR-PL-011); залишок — вільний. Розподіл не може спричинити відмову приймання. Рух RECEIPT несе `purchaseOrderLineId` рядка — партія прив'язана до рядка замовлення.
10. **BR-PO-010**: **Замовлення і позиції списків купівлі.** Перезапис рядків чернетки (`update` з `lines`, імпорт XLSX), видалення чернетки, скасування й повне приймання з недостачею повертають незамовлене чи неотримане в позиції списків (BR-PL-009, BR-PL-010, BR-PL-012). Замовлення зі списку пише `insertInTx` — той самий запис, що й `create()` (`createInTx` = `insertInTx` + перечитування), у транзакції виклику (BR-PL-008).
11. **BR-PO-011**: **Передача постачальнику через API** (рішення власника 2026-10-18; [supplier-connection.md](supplier-connection.md) BR-SCON-009…013). Кнопкою «Відправити в API» або автоматично при переході в «Замовлено» — за налаштуванням `supplierOrderSendMode`. Підсумок — `supplierApiStatus` (`NOT_SENT` / `QUEUED` / `SENT` / `PARTIAL` / `CONFIRMED` / `FAILED` / `NEEDS_ATTENTION`), деталі — `SupplierOrder`. Зовнішній статус не змінює залишків, боргу й FSM: приймання — лише вручну.
12. **BR-PO-012**: **Скасування відправленого в API.** Скасування чи видалення замовлення з уже прийнятим постачальником зовнішнім замовленням — 400 `err.supplierApi.cancelSentOrder` без `force`; із `force` — дозволено (BR-SCON-014), постачальнику нічого не надсилається.

> Борг, створений `receive()`, закривається документом [SupplierPayment](supplier-payment.md)
> (`SettlementTransaction(PAYMENT)`). PO можна опціонально прив'язати до оплати для аналітики.

### update() — contract resolution

```
shouldValidateContract = !!dto.contractId      // null/undefined/'' → false
supplierChanged = dto.supplierId && dto.supplierId !== po.supplierId

if (dto.contractId === null) → newContractId = null          // explicit clear
else if (supplierChanged && po.contractId) → newContractId = null  // auto-clear stale
else if (dto.contractId) → validate counterpartyId = effectiveSupplierId
else → newContractId = po.contractId                         // unchanged
```

→ [docs/BUSINESS-RULES.md](../BUSINESS-RULES.md)

---

## Аспекти і тести, що їх стережуть

Спек `purchase-orders.service.spec.ts` був 1960 рядків; 2026-10-05 розбито за
аспектами (182 кейси до і після). Правите один аспект — ганяєте один файл:

**Модуль:** `apps/api/src/modules/purchase-orders/`

```bash
cd apps/api && npx vitest run src/modules/purchase-orders/purchase-orders.fsm.spec.ts
```

| Аспект                                                         | Тест                                                             | Кейсів |
| -------------------------------------------------------------- | ---------------------------------------------------------------- | ------ |
| `applyPricing` — правила ціноутворення                         | `purchase-orders.pricing.spec.ts`                                | 13     |
| `receive()` — UoM-override + tenant-валідація                  | `purchase-orders.receive-uom.spec.ts`                            | 13     |
| `receive()` — activeLines, CAS → RECEIPT, борг                 | `purchase-orders.receive-ledger.spec.ts`                         | 5      |
| `create`/`update` — tenant-guard goodId рядків                 | `purchase-orders.line-goods.spec.ts`                             | 3      |
| `update()` — резолв контракту контрагента                      | `purchase-orders.contract-resolution.spec.ts`                    | 9      |
| `transition()` — карта `PO_TRANSITIONS`                        | `purchase-orders.fsm.spec.ts`                                    | 15     |
| `findAll` — `sortBy=paymentDate`, nulls-last                   | `purchase-orders.sort.spec.ts`                                   | 7      |
| linked-documents — межові випадки, списки купівлі замовлення   | `purchase-orders.linked-docs.spec.ts`                            | 6      |
| `create` — Σ(lines.amount) === totalAmount                     | `purchase-orders.totals.spec.ts`                                 | 1      |
| швидкий імпорт рядків XLSX: виклик перерахунку                 | `../xlsx/xlsx.po-lines-import-totals.spec.ts`                    | 3      |
| імпорт рядків: ПДВ рядків і тотали, звірка списків (адаптер)   | `../xlsx/document-line-import.adapter.spec.ts`                   | 14     |
| HTTP-контракт (DTO, статуси, валідація)                        | `purchase-orders.contract.spec.ts`                               | 48     |
| документ, позначений на видалення, — лише перегляд (BR-WO-012) | `purchase-orders.with-deleted.spec.ts`                           | 11     |
| Доставка (Нова Пошта)                                          | `delivery/*.spec.ts`, `purchase-orders.delivery.service.spec.ts` | —      |

Правило → тест для BR-PO-009 / BR-PO-010 (списки купівлі, мітки `// guards:`) — у спеках
`apps/api/src/modules/purchase-lists/`: `purchase-lists.receive-allocation.spec.ts` (RECEIPT з
`purchaseOrderLineId`, резерв до боргу), `purchase-lists.create-orders.spec.ts` (`insertInTx` —
той самий запис, що й `create()`), `purchase-lists.po-lifecycle.spec.ts` (звірка чернетки,
видалення й скасування, остача після RECEIVED); адаптер імпорту — `document-line-import.adapter.spec.ts`.

Передача в API постачальника (BR-PO-011, 012) — спеки модуля `supplier-api`
(`orders/supplier-orders.send.spec.ts`, реєстр — [supplier-connection.md](supplier-connection.md));
тут — лише `force` у переході (`purchase-orders.contract.spec.ts`).

Спільні DI-провайдери — `purchase-orders.spec-fixture.ts` (`purchaseListProviders()` — заглушки
хуків списків купівлі й розподілу отриманого). Якщо у конструктор
`PurchaseOrdersService` додається сервіс, усі спеки впадуть із «Nest can't resolve
dependencies» — це очікувано (клас Bug #536, #724): падіння видно одразу.

**Чого тут НЕМА.** Інваріантного спеку (`*.invariants.spec.ts`) у PurchaseOrder немає,
хоча агрегат на шляху грошей і статусів. `fsm.spec.ts` перевіряє карту переходів, але
не властивості на кшталт «фінальний статус не має виходів» — так, як це робить
`work-orders.fsm.invariants.spec.ts`. Це усвідомлена прогалина, не недогляд.

Справжня гонка двох `receive()` на живій БД не перевіряється: спеки моделюють програний CAS
моком `updateMany → { count: 0 }` і стежать за порядком викликів, але відкат уже інкрементованого
рядка і те, що конкурентна транзакція справді бачить змінений `receivedQty`, — властивість
PostgreSQL, і довести її може лише інтеграційний тест. Tenant-guard goodId перевірено для
`create`/`update`; шлях імпорту рядків із накладної (`document-line-import.adapter.ts`) має
власну валідацію і цими спеками не покритий.
