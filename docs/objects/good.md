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

| Метод  | URL                                      | Дія                                                                           |
| ------ | ---------------------------------------- | ----------------------------------------------------------------------------- |
| GET    | `/api/goods`                             | Список (фільтри: q, goodType, brandId, categoryId)                            |
| GET    | `/api/goods/stock-totals`                | Залишки по всіх складах (агрегат)                                             |
| GET    | `/api/goods/:id`                         | Деталь                                                                        |
| POST   | `/api/goods`                             | Створити                                                                      |
| PATCH  | `/api/goods/:id`                         | Оновити                                                                       |
| DELETE | `/api/goods/:id`                         | Soft-delete                                                                   |
| POST   | `/api/goods/:id/restore`                 | Відновити (знімає deletedAt)                                                  |
| GET    | `/api/goods/:goodId/uoms`                | Одиниці виміру                                                                |
| POST   | `/api/goods/:goodId/uoms`                | Додати UoM                                                                    |
| PATCH  | `/api/goods/:goodId/uoms/:uomId`         | Оновити UoM                                                                   |
| PATCH  | `/api/goods/:goodId/uoms/:uomId/default` | Встановити UoM по замовчуванню                                                |
| DELETE | `/api/goods/:goodId/uoms/:uomId`         | Видалити UoM                                                                  |
| GET    | `/api/goods/:goodId/barcodes`            | Штрихкоди                                                                     |
| POST   | `/api/goods/:goodId/barcodes`            | Додати штрихкод                                                               |
| DELETE | `/api/goods/:goodId/barcodes/:barcodeId` | Видалити штрихкод                                                             |
| GET    | `/api/goods/:id/batches`                 | Партії (StockBatch)                                                           |
| GET    | `/api/goods/:id/price-history`           | Журнал цін                                                                    |
| POST   | `/api/goods/:goodId/statuses`            | Призначити статус-мітку `{statusId}` (ідемпотентно) — OWNER/ADMIN/STOREKEEPER |
| DELETE | `/api/goods/:goodId/statuses/:statusId`  | Зняти статус-мітку — OWNER/ADMIN/STOREKEEPER                                  |

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

## Ціноутворення (calculateSalePrice)

Ієрархія правил (від конкретного до загального):

1. `goodId` — конкретний товар
2. `brandId` — бренд
3. `goodCategory` — категорія
4. `goodType` — тип
5. all (null scope) — загальне правило

**COST_TIER:** знайти тір де `costMin <= costPrice < costMax`; `costMax IS NULL` = останній тір.

**Guard:** `if (!costPrice || costPrice <= 0) skip` — без guard `0 * (1+p/100) = 0` перезаписує salePrice (Bug #198).

---

## Бізнес-правила

- `GoodUoM.id ≠ UnitOfMeasure.id` — при роботі з UoM завжди зберігай `goodUoM.unitOfMeasureId`
- `deduplicateBy(plan, u => u.goodId)` ПЕРЕД `Promise.all` bulk-update цін (Bug #483)
- Pошук по `name + sku + barcode` через GIN trgm індекс (не LIKE — повільно без індексу)
- `preferredSupplierId` — підказка для PO, не обов'язковий
- Партії `StockBatch` — FIFO за замовчуванням (найстаріша `createdAt` першою)
- **Статуси-мітки (кастомні, M:N):** per-org довідник `GoodStatus` (name+color, configuration-over-hardcode — не enum), M:N через `GoodStatusLink`. Assign/unassign валідують good+status належать org (tenant-isolation); assign ідемпотентний (`@@unique[goodId,statusId]`, P2002→no-op); unassign неіснуючого → 404. Soft-delete статусу лишає links — `toDto` фільтрує `status.deletedAt:null`, restore відновлює призначення. Кеш довідника (`ref:good-statuses`, TTL 300с) скидається на assign/unassign І на soft-delete/restore товару з міткою (Bug #725). Права: assign/unassign — OWNER/ADMIN/STOREKEEPER; CRUD довідника — OWNER/ADMIN.

→ [docs/BUSINESS-RULES.md](../BUSINESS-RULES.md) (ціноутворення, deduplicateBy)
→ [docs/objects/inventory.md](inventory.md) (StockItem, StockMovement)

---

## Аспекти і тести, що їх стережуть

Правите один аспект — ганяєте один файл:

```bash
cd apps/api && npx vitest run src/modules/goods/<файл>.spec.ts
```

**Модуль:** `apps/api/src/modules/goods/`

| Аспект                                  | Тест                                  | Кейсів |
| --------------------------------------- | ------------------------------------- | ------ |
| dto                                     | `goods-query.dto.spec.ts`             | 6      |
| HTTP-контракт (DTO, статуси, валідація) | `goods-stock-totals.contract.spec.ts` | 12     |
| рольовий доступ                         | `goods.role-gate.spec.ts`             | 14     |
| сервісна логіка                         | `goods.service.spec.ts`               | 55     |

Разом: **87** кейсів (цифри з `vitest --reporter=json`, не з grep).

**Чого тут НЕМА.** Істотних прогалин не видно: є і контракт, і аспектні спеки. Перевіряти при додаванні нового бізнес-правила — чи з'явився тест.
