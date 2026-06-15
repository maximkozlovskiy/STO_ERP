# Work / Робота — Dossier

> Робота (норма-година) — одиниця каталогу послуг. Входить у рядки нарядів та рахунків.
> Організована через ієрархію WorkCategory.

---

## Prisma моделі

```prisma
model WorkCategory {
  id          String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId       String    @db.Uuid
  parentId    String?   @db.Uuid    // дерево категорій (self-referencing)
  name        String
  code        String?
  icon        String?
  sortOrder   Int       @default(0)
  isSystem    Boolean   @default(false)
  isActive    Boolean   @default(true)
  syncVersion BigInt    @default(0)
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt
  deletedAt   DateTime?
}

model Work {
  id          String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId       String    @db.Uuid
  categoryId  String    @db.Uuid    // → WorkCategory
  name        String
  normoHours  Float                 // нормо-годин для виконання
  price       Decimal   @db.Decimal(12, 2)  // вартість
  description String?
  isWarranty  Boolean   @default(false)
  syncVersion BigInt    @default(0)
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt
  deletedAt   DateTime?
}
```

**Відносини Work:**

- → `WorkCategory`
- ← `WorkOrderLine[]` (рядки нарядів)
- ← `InvoiceLine[]` (рядки рахунків)
- ← `ServiceWork[]` (пакет послуг включає роботи)

**Відносини WorkCategory:**

- ← `Work[]`
- ← `WorkCategory[]` (children, дерево)
- ← `EmployeeWorkCategory[]` (M:M механіки ↔ категорії)
- ← `WorkGoodCategoryLink[]` (зв'язок з категоріями товарів)

---

## API Endpoints

### `/api/works`

| Метод  | URL                      | Дія                                         |
| ------ | ------------------------ | ------------------------------------------- |
| GET    | `/api/works`             | Список (фільтри: q, categoryId, isWarranty) |
| GET    | `/api/works/:id`         | Деталь                                      |
| POST   | `/api/works`             | Створити                                    |
| PATCH  | `/api/works/:id`         | Оновити                                     |
| DELETE | `/api/works/:id`         | Soft-delete                                 |
| POST   | `/api/works/:id/restore` | Відновити                                   |

### `/api/work-categories`

| Метод  | URL                        | Дія              |
| ------ | -------------------------- | ---------------- |
| GET    | `/api/work-categories`     | Дерево категорій |
| GET    | `/api/work-categories/:id` | Категорія        |
| POST   | `/api/work-categories`     | Створити         |
| PATCH  | `/api/work-categories/:id` | Оновити          |
| DELETE | `/api/work-categories/:id` | Soft-delete      |

---

## UI (Web)

| Компонент / сторінка     | Файл                                        |
| ------------------------ | ------------------------------------------- |
| Каталог (вкладка Роботи) | `app/(app)/catalog/page.tsx`                |
| Detail Panel schema      | `lib/panel-schema.ts` → `WORK_PANEL_SCHEMA` |
| Hook (TanStack Query)    | `hooks/api/useWorks.ts`                     |

---

## Модель Service (пакет послуг)

```prisma
model Service {
  id          String    @id ...
  orgId       String    @db.Uuid
  name        String
  description String?
  // ← ServiceWork[] — роботи що входять у пакет
  // ← ServiceGood[] — товари що входять у пакет
}
```

Endpoint: `/api/services` — CRUD. Panel schema: `SERVICE_PANEL_SCHEMA`.

---

## Бізнес-правила

- `normoHours` — базова одиниця оцінки (використовується для `plannedHours` наряду)
- `isWarranty: true` — робота виконується безкоштовно в рамках гарантії
- `WorkCategory.isSystem: true` — системні категорії, не видаляються через UI
- `WorkGoodCategoryLink` — рекомендовані товари для категорій робіт (підказки у WO)
- Ієрархія категорій — `parentId → children` (необмежена глибина, але UI показує 2 рівні)
- Пошук по `name` через GIN trgm індекс

→ [docs/BUSINESS-RULES.md](../BUSINESS-RULES.md)
