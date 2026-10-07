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

## Бізнес-правила (BR-WORK)

- **BR-WORK-001**: `normoHours` — базова одиниця оцінки (використовується для `plannedHours` наряду)
- **BR-WORK-002**: `isWarranty: true` — робота виконується безкоштовно в рамках гарантії
- **BR-WORK-003**: `WorkCategory.isSystem: true` — системні категорії, не видаляються через UI
- **BR-WORK-004**: `WorkGoodCategoryLink` — рекомендовані товари для категорій робіт (підказки у WO)
- **BR-WORK-005**: Ієрархія категорій — `parentId → children` (необмежена глибина, але UI показує 2 рівні)
- **BR-WORK-006**: Пошук по `name` через GIN trgm індекс

---

## Аспекти і тести, що їх стережуть

Правите один аспект — ганяєте один файл:

```bash
cd apps/api && npx vitest run src/modules/works/<файл>.spec.ts
```

**Модуль:** `apps/api/src/modules/works/`

**Маршрути UI:** `/catalog`, `/work-orders`

| Аспект          | Тест                    | Кейсів |
| --------------- | ----------------------- | ------ |
| сервісна логіка | `works.service.spec.ts` | 19     |

Разом: **19** кейсів (цифри з `vitest --reporter=json`, не з grep).

**Розходження з кодом.** Правила, де дос'є каже одне, а код робить інше. Агент цього не «лагодить»: рішення —
виправити код чи переписати правило — за людиною. Поки запис тут, гейт D правило не блокує,
але показує окремим рядком.

- **BR-WORK-002** — дос'є: `isWarranty: true` — робота виконується безкоштовно; код: прапорець лише зберігається й показується (чекбокс і бейдж у каталозі). Ціну рядка наряду чи рахунку ніщо не обнуляє; поза модулем `works` в api `isWarranty` не згадується.
- **BR-WORK-004** — дос'є: `WorkGoodCategoryLink` дає підказки товарів у наряді; код: модель, сід і два read-endpoint-и є, але ні web, ні mobile до них не звертаються — підказок у наряді немає.
- **BR-WORK-005** — дос'є: ієрархія необмеженої глибини, UI показує 2 рівні; код: бекенд справді без ліміту, але UI рендерить УСІ рівні рекурсивно (`category-tree.tsx`), а менеджер категорій дозволяє створити 3 рівні (`category-manager-modal.tsx`).
- **BR-WORK-006** — дос'є: пошук по `name` через GIN trgm індекс; код: `contains` + `insensitive` (ILIKE), а trgm-індексу на `works.name` немає в жодній міграції (є для work_orders, counterparties, goods). Живу БД не опитували.

**Чого тут НЕМА.** HTTP-контракту (`*.contract.spec.ts`) немає: DTO, статуси й валідацію покриває лише E2E.

Покриття мінімальне — один спек-файл на весь агрегат; розбиття за аспектами стане доречним, коли файл почне рости.

Правила без тесту-сторожа (у `works.service.spec.ts` їм місця немає — їх виконує не `WorksService`):

- BR-WORK-001 — `plannedHours` наряду рахує фронт: `calcPlannedHoursFromLines` у
  `CreateWorkOrderModal.tsx` (max(поточне, Σ `normoHours` рядків), лише коли
  `recalcPlannedHoursFromLines` увімкнено); API бере `plannedHours` із DTO як є. Компонентного
  тесту на перерахунок немає — `CreateWorkOrderModal.test.tsx` перевіряє лише, що `normoHours`
  роботи доходить у payload рядка, і що `prefill.plannedHours` не перераховується з дат.
- BR-WORK-003 — заборону видаляти системну категорію виконує `WorkCategoriesService.remove`
  (модуль `work-categories`, 400 `err.workCategory.systemUndeletable`), а UI ховає кнопку в
  `category-manager-modal.tsx`. Юніт-спеку сервісу в `work-categories` немає (лише контрактний,
  із замоканим сервісом), компонентного тесту модалки теж — потрібен
  `work-categories.service.spec.ts`.

→ [docs/BUSINESS-RULES.md](../BUSINESS-RULES.md)
