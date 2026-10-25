# Task (Задача співробітнику) — Dossier

> Задачі, які керівники ставлять працівникам (найчастіше механікам). Окремий список `/tasks`,
> окремий тип запису в календарі, вкладка «Задачі» в планшеті механіка. Рішення власника
> 2026-10-26: ставлять наявні ролі OWNER / ADMIN / RECEPTIONIST (нової ролі немає); задача **не
> займає** календарний час.

---

## Prisma модель

`packages/database/prisma/schema/12_tasks.prisma`, міграція `20261026120000_tasks`.

```prisma
model Task {
  id             String            @id @db.Uuid
  orgId          String            @db.Uuid
  title          String            // ≤ 200 (TASK_TITLE_MAX)
  description    String?           // ≤ 2000 (TASK_DESCRIPTION_MAX)
  status         TaskStatus        @default(NEW)
  priority       WorkOrderPriority @default(NORMAL)   // LOW | NORMAL | HIGH | URGENT
  assigneeId     String            @db.Uuid           // → Employee (TaskAssignee)
  createdById    String            @db.Uuid           // → Employee (TaskCreator)
  startAt        DateTime?         // мітка часу, не @db.Date
  dueAt          DateTime?
  completedAt    DateTime?
  workOrderId    String?           // → WorkOrder
  vehicleId      String?           // → Vehicle
  counterpartyId String?           // → Counterparty
  syncVersion    BigInt            // у SYNC_VERSION_MODELS
  createdAt, updatedAt, deletedAt
}
```

**Відносини:** → `Organisation`, `Employee` ×2 (виконавець, автор), `WorkOrder?`, `Vehicle?`,
`Counterparty?`. Коментарі — поліморфний `Comment` з `entityType = 'Task'` (BR-TASK-008).

Спільний код (`packages/shared`): `TASK_STATUS_LABELS/_DESCRIPTIONS/_BADGE/_TRANSITIONS`,
`TASK_MANAGE_ROLES`, `isTaskManagerRole`, `isTaskManagerOnlyTransition`, `canTransitionTask`
(`constants/statuses.ts`), `taskFormSchema` (`schemas/forms/task.schema.ts`), ключі `v.task.*`,
`err.task.*`.

---

## FSM

```
NEW ──→ IN_PROGRESS ──→ DONE
 │           │            │
 └──→ DONE   │            └──→ IN_PROGRESS (лише керування)
 └──→ CANCELLED ←─────────┘ (з NEW / IN_PROGRESS, лише керування)
```

| Перехід                | Хто                                    | Side-effects         |
| ---------------------- | -------------------------------------- | -------------------- |
| → `IN_PROGRESS`        | виконавець (своя задача) або керування | —                    |
| → `DONE`               | виконавець (своя) або керування        | `completedAt = now`  |
| `DONE` → `IN_PROGRESS` | лише керування                         | `completedAt = null` |
| → `CANCELLED`          | лише керування                         | —                    |

---

## API Endpoints

| Метод  | URL                     | Ролі                                         |
| ------ | ----------------------- | -------------------------------------------- |
| GET    | `/tasks`                | усі ролі персоналу (видимість — BR-TASK-002) |
| GET    | `/tasks/:id`            | усі ролі персоналу (видимість — BR-TASK-002) |
| POST   | `/tasks`                | OWNER, ADMIN, RECEPTIONIST                   |
| PATCH  | `/tasks/:id`            | OWNER, ADMIN, RECEPTIONIST                   |
| DELETE | `/tasks/:id` (soft)     | OWNER, ADMIN, RECEPTIONIST                   |
| POST   | `/tasks/:id/transition` | усі ролі персоналу (BR-TASK-003)             |

`GET /tasks` — фільтри `status[]`, `assigneeId`, `mine`, `priority`, `from`/`to` (перетин інтервалу
задачі з діапазоном), `overdue`, `workOrderId`, `search` (назва); пагінація, сортування.
Відповідь: поля моделі + `assigneeName`, `createdByName`, `workOrderNumber`, `vehicleSummary`,
`counterpartyName`, `overdue`.

---

## UI (Web)

| Компонент / сторінка | Файл                                                             |
| -------------------- | ---------------------------------------------------------------- |
| Список               | `apps/web/src/app/(app)/tasks/page.tsx`                          |
| Картка               | `apps/web/src/components/ui/TaskEditModal.tsx`                   |
| Коментарі            | спільний `CommentsSection` (і в картці наряду)                   |
| Календар             | смуга «Задачі» (день), картки категорії `task` (місяць), легенда |
| Наряд                | секція «Задачі» в пов'язаних документах, «Створити задачу»       |

Планшет механіка (`apps/mobile`): вкладка «Задачі», екран задачі, зміна статусу офлайн.

---

## Бізнес-правила

- **BR-TASK-001** — Ставлять, правлять, переназначають, скасовують і видаляють задачі лише
  OWNER, ADMIN, RECEPTIONIST (`TASK_MANAGE_ROLES`). Виконавець — працівник своєї організації зі
  статусом ACTIVE: звільнений або невідомий — 400 `err.task.assigneeNotFound`, у відпустці — 400
  `err.task.assigneeOnLeave`.
- **BR-TASK-002** — Видимість: ролі керування бачать усі задачі організації; решта — лише ті, де
  вони виконавці. Фільтр стоїть у `where` запиту (список, картка, перехід, коментарі), не в UI:
  чужа задача — 404 `err.task.notFound`.
- **BR-TASK-003** — Статуси за `TASK_STATUS_TRANSITIONS` (див. FSM); недопустимий перехід — 400.
  Виконавець змінює статус лише своєї задачі й не може скасувати чи повернути виконану в роботу
  (400 `err.task.transitionForbidden`). `DONE` ставить `completedAt`, вихід із `DONE` його знімає.
- **BR-TASK-004** — Якщо задано і початок, і термін — початок не пізніше терміну (400
  `err.task.dueBeforeStart`). Це мітки часу; день задачі в календарі — за Києвом.
- **BR-TASK-005** — Прострочена = термін минув і статус `NEW` або `IN_PROGRESS`. Обчислюється
  під час читання (`overdue` у відповіді, фільтр `overdue`), не зберігається.
- **BR-TASK-006** — Прив'язки (наряд, авто, клієнт) — лише записи своєї організації, не видалені
  на момент збереження (400 `err.task.workOrderNotFound` / `vehicleNotFound` /
  `counterpartyNotFound`). Видалення наряду пізніше задачу не прибирає.
- **BR-TASK-007** — Задача не займає календарний час: вона не входить у перевірку конфліктів
  календаря (`busyWhere`, EXCLUDE-обмеження `calendar_slots`) і не зменшує вільні слоти
  онлайн-запису (BR-CAL-004). Запис наряду на той самий час і того самого механіка дозволено.
- **BR-TASK-008** — Коментарі до задачі — поліморфний `Comment` (`entityType = 'Task'`). Читають і
  пишуть ті, хто бачить задачу за BR-TASK-002.

---

## Аспекти і тести, що їх стережуть

**Модуль:** `apps/api/src/modules/tasks/`

**Маршрути UI:** `/tasks`

| Аспект | Файл | Кейсів |
| ------ | ---- | ------ |

Разом api: **0** кейсів (цифри з `vitest --reporter=json`, не з grep).

**Чого тут НЕМА.**

- Сповіщень виконавцю про нову задачу немає: серверного каналу до працівників у системі немає
  (дзвіночок у web — лише локальний).
- Вкладень-файлів, повторюваних задач і нумерації задач немає (поза першою версією).
