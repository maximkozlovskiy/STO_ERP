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
| POST   | `/api/purchase-orders`                   | Створити (lines у body)                                                                                                                                                |
| PATCH  | `/api/purchase-orders/:id`               | Оновити (тільки DRAFT)                                                                                                                                                 |
| DELETE | `/api/purchase-orders/:id`               | Soft-delete (тільки DRAFT/CANCELLED)                                                                                                                                   |
| POST   | `/api/purchase-orders/:id/transition`    | FSM перехід (DRAFT → ORDERED)                                                                                                                                          |
| POST   | `/api/purchase-orders/:id/receive`       | Приймання товару → StockMovement(RECEIPT) + CHARGE                                                                                                                     |
| POST   | `/api/purchase-orders/:id/apply-pricing` | Застосувати ціни закупки до Good.purchasePrice                                                                                                                         |

---

## UI (Web)

| Компонент / сторінка  | Файл                                                  |
| --------------------- | ----------------------------------------------------- |
| Список                | `app/(app)/purchase-orders/page.tsx`                  |
| Модалка створення     | `components/ui/PurchaseOrderCreateModal.tsx`          |
| Detail Panel schema   | `lib/panel-schema.ts` → `PURCHASE_ORDER_PANEL_SCHEMA` |
| Hook (TanStack Query) | `hooks/api/usePurchaseOrders.ts`                      |

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

## Бізнес-правила: receive() інваріанти

1. `activeLines` = лише рядки де `line.quantity - line.receivedQty > 0`
2. `deduplicateBy(receivedLines, l => l.lineId)` ПЕРЕД `$transaction` — запобігає дублям у payload
3. `receivedQty` не може перевищити `line.quantity` (guard у DTO)
4. **create/update: `validateLineGoodIds(orgId, lines)`** — усі goodId рядків мусять належати org
   (Good.id глобально унікальний → інакше cross-tenant FK-injection). Кидає 404 ДО запису.
5. receive() у `$transaction` (2 кроки, порядок критичний):
   - **КРОК 1 — CAS per-line (НЕ просто stale-read!):** `purchaseOrderLine.updateMany({where:{id,orgId,
receivedQty:<очікуване>}, data:{increment}})` ПОСЛІДОВНО; `count===0`→throw. Concurrent/дубльований
     receive() уже змінив receivedQty → CAS не матчить → rollback ДО руху/боргу (без подвоєння).
   - **КРОК 2** (після CAS усіх рядків): `InventoryService.createMovement(RECEIPT)` (Promise.all) +
     один `SettlementsService.createTransaction(SUPPLIER_CHARGE)` — борг перед постачальником.

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
