# Vehicle — Dossier

> Авто клієнта: картка, вузли, історія пробігу. Належить гаражу контрагента
> (`CustomerGarage`), на авто посилаються наряди, графіки ТО й гарантії.

---

## Prisma модель

`Vehicle` (`packages/database/prisma/schema/04_crm.prisma`): `vin`, `licensePlate`, `makeId`,
`modelId`, `make`, `model`, `year`, `currentMileage`, `customerGarageId`; soft delete (`deletedAt`),
`syncVersion`. `VehicleNode` — вузли авто (`mileageAtInstall`), теж soft delete.

Марка й модель — з довідників `VehicleMake` / `VehicleModel` (з 2026-10-23, міграція
`20261023180000_vehicle_makes_and_models`). `make` / `model` у `Vehicle` — знімок назви, який пише
лише сервіс: його читають PDF наряду й акту (`formatVehicleLabel`), `vehicleSummary` нарядів і
календаря, шаблони нагадувань (`{{vehicleMake}}`), сирий SQL зарплати, конструктор звітів,
експорт і мобільний застосунок. `VehicleMake`: `name`, `nameKey` (унікальний у організації разом із
видаленими); `VehicleModel`: `makeId`, `name`, `nameKey` (унікальний у марці). Обидві — soft
delete, `syncVersion`.

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

`POST /` і `PATCH /:id` приймають `makeId` / `modelId` (BR-VEH-008), а не назви; відповідь несе і
ідентифікатори, і знімок назв `make` / `model`. `POST /sync/push` для `vehicles` — так само.

### Довідник марок і моделей (`/api/vehicle-makes`, `/api/vehicle-models`, BR-VEH-006…013)

Модуль `apps/api/src/modules/vehicle-makes/`. Записи — під транзакційним блокуванням організації
(`pg_advisory_xact_lock`), записи авто беруть його спільно (`vehicle-directory.ts`): перевірка
«марку мають живі авто» й перенесення авто при злитті не розминаються з одночасним збереженням авто.

| Метод  | Шлях                          | Ролі                                             | Що робить                                            |
| ------ | ----------------------------- | ------------------------------------------------ | ---------------------------------------------------- |
| GET    | `/vehicle-makes`              | OWNER, ADMIN, RECEPTIONIST, ACCOUNTANT, MECHANIC | марки (`?showDeleted`), `vehicleCount`, `modelCount` |
| POST   | `/vehicle-makes`              | OWNER, ADMIN, RECEPTIONIST                       | додати марку `{name}`                                |
| PATCH  | `/vehicle-makes/:id`          | OWNER, ADMIN, RECEPTIONIST                       | перейменувати (знімок назви в авто)                  |
| DELETE | `/vehicle-makes/:id`          | OWNER, ADMIN                                     | видалити (400 з живими авто; моделі — разом)         |
| POST   | `/vehicle-makes/:id/restore`  | OWNER, ADMIN                                     | відновити разом із моделями, видаленими з нею        |
| POST   | `/vehicle-makes/:id/merge`    | OWNER, ADMIN                                     | злити в `{targetId}`                                 |
| GET    | `/vehicle-makes/:id/models`   | OWNER, ADMIN, RECEPTIONIST, ACCOUNTANT, MECHANIC | моделі марки (`?showDeleted`), `vehicleCount`        |
| POST   | `/vehicle-makes/:id/models`   | OWNER, ADMIN, RECEPTIONIST                       | додати модель `{name}`                               |
| PATCH  | `/vehicle-models/:id`         | OWNER, ADMIN, RECEPTIONIST                       | перейменувати                                        |
| DELETE | `/vehicle-models/:id`         | OWNER, ADMIN                                     | видалити (400 з живими авто)                         |
| POST   | `/vehicle-models/:id/restore` | OWNER, ADMIN                                     | відновити (марка має бути живою)                     |
| POST   | `/vehicle-models/:id/merge`   | OWNER, ADMIN                                     | злити в модель тієї ж марки `{targetId}`             |

Список марок кешується в Redis (`ref:vehicle-makes:<orgId>`); кеш скидають записи довідника й авто
(лічильник `vehicleCount`). Записи авто з `POST /sync/push` кеш не скидають — лічильник у вкладці
може відставати до 5 хв (TTL); перевірка видалення рахує по базі. На клієнті форма авто тримає
список 5 хв, а вкладка «Марки авто» перечитує марки й моделі при кожному відкритті (`fresh`, Bug #957):
записи авто з форм кеш довідника на клієнті не скидають.

`GET /:id/mileage` → `VehicleMileagePoint[]` (тип у `packages/shared/src/types.ts`): масив без
пагінації, від старішого запису до новішого.

## UI (Web)

| Компонент / сторінка     | Файл                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Картка авто              | `app/(app)/vehicles/[id]/PageClient.tsx`                                                                           |
| Історія пробігу          | `app/(app)/vehicles/[id]/MileageHistory.tsx`                                                                       |
| Графік пробігу           | `app/(app)/vehicles/[id]/MileageChart.tsx`                                                                         |
| Hook історії пробігу     | `hooks/api/useVehicleMileage.ts`                                                                                   |
| Створення авто           | `app/(app)/vehicles/new/PageClient.tsx`                                                                            |
| Марка й модель у формі   | `components/ui/VehicleMakeModelFields.tsx` (у `VehicleForm`, `CounterpartyEditModal`, майстрі `CalendarSlotModal`) |
| Довідник марок (вкладка) | `app/(app)/counterparties/VehicleMakesTab.tsx` («Контрагенти → Марки авто», `?tab=vehicle-makes`)                  |
| Hook довідника           | `hooks/api/useVehicleMakes.ts`                                                                                     |

Окремої сторінки-списку авто немає: авто відкривають із картки контрагента.

Історія пробігу перечитується на кожне відкриття картки авто (`staleTime: 0` у
`useVehicleMileage`, Bug #799): наряд міняють у багатьох місцях — реквізити в картці наряду,
створення наряду, планшет механіка, — і не кожне з них знає про цей кеш. Поки картка відкрита
(наряд у модалці поверх неї), кеш `vehicleMileageKeys` скидає `invalidateWorkOrderSideEffects`
(`lib/cache-invalidation.ts`).
Графік має власний тест реального рендера recharts —
`vehicles/[id]/__tests__/MileageChart.test.tsx` (часова вісь, дата за Києвом, точка відкату,
підказка на токенах теми).

## Бізнес-правила (BR-VEH)

- **BR-VEH-001**: Історія пробігу будується з нарядів цього авто у своїй організації: не
  видалених (`deletedAt: null`), не `CANCELLED`, у яких зафіксовано пробіг. Пробіг запису =
  `outMileage`, а якщо його немає — `inMileage`. Наряд без обох значень у історію не входить.
- **BR-VEH-002**: Дата запису = `completedAt`, а якщо наряд ще не завершено — `documentDate`.
  Записи впорядковано за календарним днем цієї дати (за Києвом) від старішого до новішого; у
  межах одного дня — за номером наряду. Порівнюється саме день, а не мітка часу:
  `documentDate` — дата без часу (у відповіді це опівніч UTC), `completedAt` — момент. Як
  мітки часу їх порівнювати не можна — наряд, відкритий після вже завершеного того ж дня,
  став би перед ним, і завершений отримав би хибний відкат (Bug #798). Тому `date` у
  відповіді в межах одного дня не мусить зростати; графік через це не дає X спадати.
- **BR-VEH-003**: Запис, чий пробіг менший за пробіг попереднього запису, позначається
  `isRollback: true` (помилка вводу або скручений одометр). Він НЕ відкидається й не
  виправляється: історія показує те, що внесено.
- **BR-VEH-004**: Авто чужої організації або видалене → 404 (той самий текст, що в
  `GET /vehicles/:id`). Перевірка авто — окремим запитом з `orgId` і `deletedAt: null`.
- **BR-VEH-005**: Повертається не більше 200 останніх записів; порядок у відповіді все одно
  від старішого до новішого.

### Довідники марок і моделей (рішення власника 2026-10-23)

- **BR-VEH-006**: Назва марки — до 100 символів, крайні пробіли прибрано, внутрішні стиснуто до
  одного. Ключ `nameKey` = та сама назва в нижньому регістрі (`vehicleNameKey` у
  `@sto/shared`, у SQL — `lower(regexp_replace(btrim(x), '\s+', ' ', 'g'))`). Ключ унікальний в
  організації разом із видаленими. Назва живої марки → 409 `err.vehicleMake.nameExists`; видаленої →
  409 `err.vehicleMake.nameExistsDeleted` (відновити її, а не створити другу). Те саме при
  перейменуванні.
- **BR-VEH-007**: Модель належить марці; назва й ключ — як у BR-VEH-006, ключ унікальний у межах
  марки (`err.vehicleModel.nameExists` / `nameExistsDeleted`). Модель видаленої марки не
  створюється й не відновлюється (`err.vehicleModel.makeDeletedRestoreFirst`).
- **BR-VEH-008**: Авто має марку й модель із довідника (`makeId`, `modelId` обов'язкові, у
  формі — лише вибір). Модель мусить належати цій марці (`err.vehicle.modelNotOfMake`), обидві живі
  й своєї організації (`err.vehicle.makeNotFound` / `modelNotFound`), інакше 400. Зміна марки без
  моделі — 400 (`err.vehicle.makeRequiresModel`). `make` / `model` авто пише сервіс — назвами з
  довідника; клієнт їх не передає. Так само для `POST /sync/push` (`makeId` / `modelId`).
- **BR-VEH-009**: Марку чи модель, яку мають живі авто, видалити не можна — 400
  `err.vehicleMake.inUse` / `err.vehicleModel.inUse` з пропозицією злити. Видалення марки без живих
  авто видаляє й її живі моделі.
- **BR-VEH-010**: Злиття марки A в B: авто A переходять на B; моделі A, чий ключ уже є в B,
  зливаються з моделлю B (авто переходять на неї), решта моделей переходять до B; A видаляється.
  Злиття моделі — так само, лише в межах однієї марки (`err.vehicleModel.mergeOtherMake`). Злиття з
  собою — 400. Ціль мусить бути живою.
- **BR-VEH-011**: Перейменування й злиття оновлюють знімок назви (`make` / `model`) в усіх авто
  марки чи моделі, разом із видаленими авто, у тій самій транзакції (`syncVersion + 1`).
- **BR-VEH-012**: Стартовий список марок (`vehicle-make-defaults.ts`, без моделей) сіється при
  створенні організації; для наявних організацій — міграцією; для dev/CI-організації — `seed.ts`
  (`packages/database/prisma/seed-vehicle-makes.ts`: пакет бази не імпортує api, тому копія назв,
  Bug #956). Списки в міграції й у seed збігаються зі списком у коді.
- **BR-VEH-013**: Ролі довідника: читання — OWNER, ADMIN, RECEPTIONIST, ACCOUNTANT, MECHANIC
  (механік обирає марку у формі авто); створення й перейменування — OWNER, ADMIN, RECEPTIONIST;
  видалення, відновлення, злиття — OWNER, ADMIN.
- **BR-VEH-014**: Відновлення видаленого авто, чию марку чи модель видалено з довідника, — 400
  `err.vehicle.makeModelDeletedRestoreFirst` (спершу відновити марку чи модель). Пара читається в
  транзакції відновлення під спільним блокуванням довідника (як створення авто): злиття марки
  переносить і видалені авто, а видалення марки перевіряє «живі авто» під ексклюзивним.

Перенесення старих даних (міграція): ключ назви як у BR-VEH-006; аліаси стартового списку (VW,
Мерседес, ВАЗ, кирилиця) зводяться до марки зі списку; назва нової марки чи моделі — найчастіше
написання в організації; не впізнане («ferari», «Майота») стає окремою маркою для ручного злиття.
Переносяться всі авто, разом із видаленими.

## Аспекти і тести, що їх стережуть

Правите один аспект — ганяєте один файл:

```bash
cd apps/api && npx vitest run src/modules/vehicles/<файл>.spec.ts
```

**Модуль:** `apps/api/src/modules/vehicles/`, `apps/api/src/modules/vehicle-makes/`

**Маршрути UI:** `/vehicles`, `/counterparties`

| Аспект                                                                                                                                                     | Тест                                 | Кейсів |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ------ |
| сервіс: список, VIN, soft delete, відновлення, блокування гаража при створенні й відновленні (BR-CP-015), живі марка й модель при відновленні (BR-VEH-014) | `vehicles.service.spec.ts`           | 24     |
| історія пробігу (BR-VEH-001…005)                                                                                                                           | `vehicles.mileage-history.spec.ts`   | 25     |
| HTTP-контракт `GET /:id/mileage`: ролі, UUID                                                                                                               | `vehicles.contract.spec.ts`          | 15     |
| марка й модель авто з довідника (BR-VEH-008)                                                                                                               | `vehicles.make-model.spec.ts`        | 10     |
| довідник: ключ назви, перейменування й знімок назви в авто (BR-VEH-006, 007, 011)                                                                          | `vehicle-makes.names.spec.ts`        | 15     |
| довідник: видалення, відновлення, злиття (BR-VEH-009…011)                                                                                                  | `vehicle-makes.delete-merge.spec.ts` | 11     |
| HTTP-контракт довідника: ролі всіх маршрутів, UUID, zod (BR-VEH-013)                                                                                       | `vehicle-makes.contract.spec.ts`     | 88     |
| стартовий список марок: код ↔ SQL міграції ↔ dev/CI seed (BR-VEH-012)                                                                                      | `vehicle-make-defaults.spec.ts`      | 4      |

Разом: **188** кейсів (цифри з `vitest --reporter=json`, не з grep).

Поза модулями правила довідника стережуть ще:

- `apps/api/src/modules/sync/sync.vehicle-make-model.spec.ts` — 8 кейсів: `POST /sync/push` авто
  з `makeId` / `modelId`, назви пише сервер (BR-VEH-008), запис пари скидає кеш списку марок;
- `apps/api/src/modules/setup/setup.service.spec.ts` — стартовий список марок нової організації
  (BR-VEH-012, 2 кейси з 15);
- web: `components/ui/__tests__/VehicleMakeModelFields.test.tsx` (7), `vehicle.schema.test.ts`
  (14), `VehicleForm.test.tsx` (5), `CounterpartyEditModal.test.tsx` (18),
  `app/(app)/calendar/__tests__/CalendarSlotModal.new-client-vehicle.test.tsx` (2),
  `app/(app)/counterparties/__tests__/VehicleMakesTab.test.tsx` (9);
- E2E: `apps/web/e2e/vehicle-makes.spec.ts` (марка й модель у вкладці → авто з вибору →
  видалення заблоковане → злиття переносить авто), `vehicles.spec.ts` (вибір у формі). Авто-передумови
  інших E2E беруть пару з `e2e/vehicle-directory.ts` (`ensureVehicleModel`).

**Чого тут НЕМА.** Інтеграційного тесту міграції `20261023180000_vehicle_makes_and_models` на
засіяних текстових даних немає: перенесення перевірено на копії dev-бази (головним агентом) і
застосуванням до dev-бази (876 авто, усі з `makeId` / `modelId`). Contract-спек авто покриває лише `GET /:id/mileage` (ролі через справжній
`RolesGuard`, `ParseUUIDPipe`, 404). Для решти endpoint-ів `vehicles.controller.ts` ролі й
`ParseUUIDPipe` перевіряються лише читанням.
Вузли авто (`createNode` / `removeNode`) unit-тестами не покриті. Правил для самого авто
(унікальність VIN, заборона видалення авто з активними нарядами) у дос'є ще не сформульовано,
хоча код їх виконує.
