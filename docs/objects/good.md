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
- ← `WorkOrderPart[]`, `PurchaseOrderLine[]`, `StockDocumentLine[]`, `InvoiceLine[]`

**Індекси:**

- `(orgId, sku)` — пошук по SKU
- `(orgId, goodType, deletedAt)` — фільтр по типу
- GIN trgm на `name`, `sku` — full-text fuzzy search (ручні міграції, не Prisma schema)

---

## API Endpoints (`/api/goods`)

| Метод  | URL                                      | Дія                                                |
| ------ | ---------------------------------------- | -------------------------------------------------- |
| GET    | `/api/goods`                             | Список (фільтри: q, goodType, brandId, categoryId) |
| GET    | `/api/goods/stock-totals`                | Залишки по всіх складах (агрегат)                  |
| GET    | `/api/goods/:id`                         | Деталь                                             |
| POST   | `/api/goods`                             | Створити                                           |
| PATCH  | `/api/goods/:id`                         | Оновити                                            |
| DELETE | `/api/goods/:id`                         | Soft-delete                                        |
| POST   | `/api/goods/:id/restore`                 | Відновити (знімає deletedAt)                       |
| GET    | `/api/goods/:goodId/uoms`                | Одиниці виміру                                     |
| POST   | `/api/goods/:goodId/uoms`                | Додати UoM                                         |
| PATCH  | `/api/goods/:goodId/uoms/:uomId`         | Оновити UoM                                        |
| PATCH  | `/api/goods/:goodId/uoms/:uomId/default` | Встановити UoM по замовчуванню                     |
| DELETE | `/api/goods/:goodId/uoms/:uomId`         | Видалити UoM                                       |
| GET    | `/api/goods/:goodId/barcodes`            | Штрихкоди                                          |
| POST   | `/api/goods/:goodId/barcodes`            | Додати штрихкод                                    |
| DELETE | `/api/goods/:goodId/barcodes/:barcodeId` | Видалити штрихкод                                  |
| GET    | `/api/goods/:id/batches`                 | Партії (StockBatch)                                |
| GET    | `/api/goods/:id/price-history`           | Журнал цін                                         |

---

## UI (Web)

| Компонент / сторінка     | Файл                                         |
| ------------------------ | -------------------------------------------- |
| Каталог (вкладка Товари) | `app/(app)/catalog/page.tsx`                 |
| Edit Modal (з вкладками) | `components/ui/GoodEditModal.tsx` (GoodsTab) |
| Hook (TanStack Query)    | `hooks/api/useInventory.ts`                  |

**Вкладки GoodEditModal:** info / barcodes / batches

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

→ [docs/BUSINESS-RULES.md](../BUSINESS-RULES.md) (ціноутворення, deduplicateBy)
→ [docs/objects/inventory.md](inventory.md) (StockItem, StockMovement)
