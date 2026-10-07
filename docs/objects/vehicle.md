# Vehicle — Dossier

> Авто клієнта: картка, вузли, історія пробігу. Належить гаражу контрагента
> (`CustomerGarage`), на авто посилаються наряди, графіки ТО й гарантії.

---

## Prisma модель

`Vehicle` (`packages/database/prisma/schema/04_crm.prisma`): `vin`, `licensePlate`, `make`,
`model`, `year`, `currentMileage`, `customerGarageId`; soft delete (`deletedAt`), `syncVersion`.
`VehicleNode` — вузли авто (`mileageAtInstall`), теж soft delete.

Пробіг зберігається у двох місцях: `Vehicle.currentMileage` (останнє відоме значення; росте
лише вгору — оновлюється подією завершення наряду та sync) і `WorkOrder.inMileage` /
`outMileage` (пробіг на момент конкретного наряду). Окремої таблиці історії пробігу немає —
історія будується з нарядів (BR-VEH-001).

## API Endpoints (`/api/vehicles`)

| Метод  | Шлях                 | Ролі                                 | Що робить                          |
| ------ | -------------------- | ------------------------------------ | ---------------------------------- |
| GET    | `/`                  | OWNER, ADMIN, RECEPTIONIST, MECHANIC | список (пошук, фільтр за клієнтом) |
| GET    | `/:id`               | OWNER, ADMIN, RECEPTIONIST, MECHANIC | картка авто                        |
| POST   | `/`                  | OWNER, ADMIN, RECEPTIONIST           | створити                           |
| PATCH  | `/:id`               | OWNER, ADMIN, RECEPTIONIST           | оновити                            |
| DELETE | `/:id`               | OWNER, ADMIN                         | soft delete                        |
| POST   | `/:id/restore`       | OWNER, ADMIN                         | відновити                          |
| GET    | `/:id/nodes`         | OWNER, ADMIN, RECEPTIONIST, MECHANIC | вузли авто                         |
| POST   | `/:id/nodes`         | OWNER, ADMIN, RECEPTIONIST, MECHANIC | додати вузол                       |
| DELETE | `/:id/nodes/:nodeId` | OWNER, ADMIN                         | soft delete вузла                  |
| GET    | `/:id/mileage`       | OWNER, ADMIN, RECEPTIONIST, MECHANIC | історія пробігу (BR-VEH-001…005)   |

`GET /:id/mileage` → `VehicleMileagePoint[]` (тип у `packages/shared/src/types.ts`): масив без
пагінації, від старішого запису до новішого.

## UI (Web)

| Компонент / сторінка | Файл                                         |
| -------------------- | -------------------------------------------- |
| Картка авто          | `app/(app)/vehicles/[id]/PageClient.tsx`     |
| Історія пробігу      | `app/(app)/vehicles/[id]/MileageHistory.tsx` |
| Графік пробігу       | `app/(app)/vehicles/[id]/MileageChart.tsx`   |
| Hook історії пробігу | `hooks/api/useVehicleMileage.ts`             |
| Створення авто       | `app/(app)/vehicles/new/PageClient.tsx`      |

Окремої сторінки-списку авто немає: авто відкривають із картки контрагента.

Кеш історії пробігу (`vehicleMileageKeys`) скидає `invalidateWorkOrderSideEffects`
(`lib/cache-invalidation.ts`): історія будується з нарядів, тож перехід наряду її змінює.
Графік має власний тест реального рендера recharts —
`vehicles/[id]/__tests__/MileageChart.test.tsx` (часова вісь, дата за Києвом, точка відкату,
підказка на токенах теми).

## Бізнес-правила (BR-VEH)

- **BR-VEH-001**: Історія пробігу будується з нарядів цього авто у своїй організації: не
  видалених (`deletedAt: null`), не `CANCELLED`, у яких зафіксовано пробіг. Пробіг запису =
  `outMileage`, а якщо його немає — `inMileage`. Наряд без обох значень у історію не входить.
- **BR-VEH-002**: Дата запису = `completedAt`, а якщо наряд ще не завершено — `documentDate`.
  Записи впорядковано за датою від старішого до новішого; за рівної дати — за номером наряду.
- **BR-VEH-003**: Запис, чий пробіг менший за пробіг попереднього запису, позначається
  `isRollback: true` (помилка вводу або скручений одометр). Він НЕ відкидається й не
  виправляється: історія показує те, що внесено.
- **BR-VEH-004**: Авто чужої організації або видалене → 404 (той самий текст, що в
  `GET /vehicles/:id`). Перевірка авто — окремим запитом з `orgId` і `deletedAt: null`.
- **BR-VEH-005**: Повертається не більше 200 останніх записів; порядок у відповіді все одно
  від старішого до новішого.

## Аспекти і тести, що їх стережуть

Правите один аспект — ганяєте один файл:

```bash
cd apps/api && npx vitest run src/modules/vehicles/<файл>.spec.ts
```

**Модуль:** `apps/api/src/modules/vehicles/`

**Маршрути UI:** `/vehicles`, `/counterparties`

| Аспект                                        | Тест                               | Кейсів |
| --------------------------------------------- | ---------------------------------- | ------ |
| сервіс: список, VIN, soft delete, відновлення | `vehicles.service.spec.ts`         | 17     |
| історія пробігу (BR-VEH-001…005)              | `vehicles.mileage-history.spec.ts` | 20     |

Разом: **37** кейсів (цифри з `vitest --reporter=json`, не з grep).

**Чого тут НЕМА.** Індексу `work_orders (orgId, vehicleId)` у схемі немає: запит історії
пробігу (і фільтр нарядів за авто) іде через індекси з префіксом `orgId` і відсіює `vehicleId`
фільтром — потрібна міграція (знайдено на review 2026-10-07, не зроблено). Contract-спеку для `vehicles.controller.ts` немає — ролі й
`ParseUUIDPipe` (зокрема для `GET /:id/mileage`) перевіряються лише читанням.
Вузли авто (`createNode` / `removeNode`) unit-тестами не покриті. Правил для самого авто
(унікальність VIN, заборона видалення авто з активними нарядами) у дос'є ще не сформульовано,
хоча код їх виконує.
