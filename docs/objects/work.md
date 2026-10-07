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

| Метод  | URL                      | Дія                                                       |
| ------ | ------------------------ | --------------------------------------------------------- |
| GET    | `/api/works`             | Список (фільтри: q, categoryId, categoryIds, showDeleted) |
| GET    | `/api/works/:id`         | Деталь                                                    |
| POST   | `/api/works`             | Створити                                                  |
| PATCH  | `/api/works/:id`         | Оновити                                                   |
| DELETE | `/api/works/:id`         | Soft-delete                                               |
| POST   | `/api/works/:id/restore` | Відновити                                                 |

### `/api/work-categories`

| Метод  | URL                                               | Дія                                             |
| ------ | ------------------------------------------------- | ----------------------------------------------- |
| GET    | `/api/work-categories`                            | Дерево категорій                                |
| GET    | `/api/work-categories/:id`                        | Категорія                                       |
| GET    | `/api/work-categories/:id/linked-good-categories` | ID пов'язаних категорій товарів (лише читання)  |
| POST   | `/api/work-categories`                            | Створити                                        |
| PATCH  | `/api/work-categories/:id`                        | Оновити                                         |
| PATCH  | `/api/work-categories/:id/toggle-active`          | Увімкнути/вимкнути категорію разом із нащадками |
| DELETE | `/api/work-categories/:id`                        | Soft-delete категорії та всіх нащадків          |

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
- **BR-WORK-002**: `isWarranty` — лише інформаційна позначка в довіднику робіт (чекбокс і бейдж у каталозі). На ціну рядка наряду чи рахунку НЕ впливає; ціну гарантійної роботи майстер ставить у наряді сам. Гарантійність на рядку наряду — окрема фіча в беклозі.
- **BR-WORK-003**: `WorkCategory.isSystem: true` — системні категорії, не видаляються через UI
- **BR-WORK-004**: зв'язки `WorkGoodCategoryLink` і два read-endpoint-и (`GET /work-categories/:id/linked-good-categories`, `GET /good-categories/:id/linked-work-categories`) існують як заділ; форма наряду у web і mobile їх не викликає, редагувати зв'язки ніде (лише seed). Підказки товарів у наряді — нереалізована фіча в беклозі.
- **BR-WORK-005**: Ієрархія категорій — `parentId → children`. Бекенд глибину не обмежує: дерево будується рекурсивно, а `create`/`update` перевіряють лише, що батько існує у своїй організації. UI показує всі рівні (`category-tree.tsx` рендерить рекурсивно; обмежено лише відступ — не більше трьох кроків). Менеджер категорій (`category-manager-modal.tsx`) дозволяє створити три рівні: кнопка «Додати підкатегорію» вимкнена на вузлі третього рівня (`depth >= 2`).
- **BR-WORK-006**: Пошук по `name` через GIN trgm індекс

---

## Аспекти і тести, що їх стережуть

Правите один аспект — ганяєте один файл:

```bash
cd apps/api && npx vitest run src/modules/works/<файл>.spec.ts
cd apps/api && npx vitest run src/modules/work-categories/<файл>.spec.ts
```

**Модуль:** `apps/api/src/modules/works/`, `apps/api/src/modules/work-categories/`

**Маршрути UI:** `/catalog`, `/work-orders`

Окремого дос'є категорій робіт немає — спеки модуля `work-categories` ведуться тут.

| Аспект                                         | Тест                               | Кейсів |
| ---------------------------------------------- | ---------------------------------- | ------ |
| сервісна логіка робіт (каталог, `isWarranty`)  | `works.service.spec.ts`            | 22     |
| сервісна логіка категорій (системні, ієрархія) | `work-categories.service.spec.ts`  | 10     |
| HTTP-контракт категорій                        | `work-categories.contract.spec.ts` | 10     |

Разом: **42** кейси (цифри з `vitest --reporter=json`, не з grep).

Web-тест поза модулем api (у суму вище не входить):
`apps/web/src/components/ui/__tests__/CreateWorkOrderModal.planned-hours.test.tsx` — 3 кейси,
перерахунок планових нормо-годин наряду з рядків робіт (BR-WORK-001).

**Що саме стережуть мітки — і чого ні.** Три правила покриті частково; непокрита частина
лежить поза модулями цього дос'є:

- BR-WORK-001 — тест проходить шлях «видалити рядок» у режимі редагування наряду. Шлях
  «додати рядок» і застосування пакета послуг викликають ту саму `calcPlannedHoursFromLines`,
  але потребують `SearchCombobox` і тестом не проходяться. Функція не експортується, тож
  прямого тесту на неї немає. API бере `plannedHours` із DTO як є.
- BR-WORK-002 — у `works.service.spec.ts` стережеться лише довідник: прапорець зберігається
  й повертається, ціна роботи від нього не залежить. Що `addLine` наряду бере ціну роботи
  незалежно від `isWarranty`, не стереже жоден тест — закривати в
  `apps/api/src/modules/work-orders/work-orders.service.spec.ts` (зараз `isWarranty` у модулі
  `work-orders` не згадується взагалі). Чекбокс і бейдж у каталозі (`WorksTab.tsx`) — без
  компонентного тесту.
- BR-WORK-004 — стережеться endpoint категорій робіт і читання зв'язків у межах організації.
  Парний endpoint `GET /good-categories/:id/linked-work-categories` має контрактний кейс у
  `good-categories.contract.spec.ts`, але без мітки (модуль агрегату Good). Твердження «web і
  mobile endpoint-ів не викликають» і «редагувати зв'язки ніде» — це відсутність коду, тестом
  не перевіряється.
- BR-WORK-005 — стережеться бекенд (глибина не обмежена). UI-частина — рекурсивний рендер у
  `category-tree.tsx` і ліміт `depth >= 2` у `category-manager-modal.tsx` — без компонентного
  тесту.

**Чого тут НЕМА.** HTTP-контракту для `/api/works` (`works.contract.spec.ts`) немає: DTO, статуси
й валідацію робіт покриває лише E2E. Компонентних тестів `category-tree.tsx` і
`category-manager-modal.tsx` немає.

→ [docs/BUSINESS-RULES.md](../BUSINESS-RULES.md)
