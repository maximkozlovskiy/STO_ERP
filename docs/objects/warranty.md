# Warranty — Dossier

> Гарантія на роботи наряду: створюється сама, коли наряд стає «Виконано» (`autoCreate`, строк —
> `warrantyDays` з налаштувань), або вручну. Клієнт звертається за гарантією — на гарантію
> записується наряд-звернення. Окремої сторінки немає: вкладка «Гарантії» в розділі «Наряди»
> (рішення власника 2026-10-22).

---

## Prisma модель

`Warranty` (`packages/database/prisma/schema/06_work-orders.prisma`): `workOrderId` (наряд, на який
дано гарантію), `workOrderLineId` / `workOrderPartId` (необов'язково — гарантія на рядок),
`counterpartyId`, `expiresAt`, `description`, `claimedAt` + `claimWoId` (звернення і наряд-звернення);
soft delete (`deletedAt`), `syncVersion`. Авто гарантії — авто її наряду (`workOrder.vehicle`).

## API Endpoints (`/api/warranties`)

| Метод | URL                                   | Дія                                      | Ролі                                   |
| ----- | ------------------------------------- | ---------------------------------------- | -------------------------------------- |
| GET   | `/api/warranties`                     | Список гарантій вкладки (BR-WAR-001…003) | OWNER, ADMIN, RECEPTIONIST, ACCOUNTANT |
| POST  | `/api/warranties`                     | Створити гарантію вручну                 | OWNER, ADMIN, RECEPTIONIST             |
| GET   | `/api/warranties/expiring?days=`      | Гарантії, що закінчуються (дашборд)      | OWNER, ADMIN, RECEPTIONIST, ACCOUNTANT |
| GET   | `/api/warranties/by-counterparty/:id` | Гарантії контрагента                     | OWNER, ADMIN, RECEPTIONIST, ACCOUNTANT |
| GET   | `/api/warranties/by-work-order/:id`   | Гарантії наряду                          | OWNER, ADMIN, RECEPTIONIST, MECHANIC   |
| POST  | `/api/warranties/:id/claim`           | Звернення: `{ claimWoId }` (BR-WAR-004)  | OWNER, ADMIN, RECEPTIONIST             |

## UI (Web)

Вкладка «Гарантії» сторінки `/work-orders` (`?tab=warranties`) — поряд із «Наряди», як вкладки
сторінки «Каса». Список за стандартом списків (BR-WAR-005).

## Бізнес-правила (BR-WAR)

- **BR-WAR-001**: **Список гарантій** — `GET /warranties`: лише гарантії своєї організації, без
  видалених (`deletedAt`), гарантія видаленого наряду теж не показується. Відповідь — `{ items,
total, page, limit }` за стандартом списків (`page`, `limit` до 200, `calculatePagination`).
  Рядок — поля `WarrantyResponseDto` плюс `vehicleSummary` (марка, модель, номер авто наряду) і
  `state` (BR-WAR-002). Порядок за замовчуванням — `expiresAt` за зростанням (спершу ті, що
  закінчуються раніше), другий ключ — `id`; `sortBy` — whitelist `expiresAt` / `createdAt`.
- **BR-WAR-002**: **Стан гарантії** обчислюється на сервері, одним правилом для списку й фільтра:
  `CLAIMED` — є звернення (`claimedAt`); інакше `EXPIRED` — `expiresAt ≤ зараз`; інакше `EXPIRING` —
  `expiresAt ≤ зараз + WARRANTY_EXPIRING_DAYS` календарних днів за Києвом (`addDaysKyiv`, той самий
  поріг, що віджет дашборду — одна константа в `@sto/shared`, дашборд бере її ж); інакше `ACTIVE`.
  Фільтр `?state=ACTIVE|EXPIRING|EXPIRED|CLAIMED` (кілька — через кому) відбирає в базі тими самими
  межами, що й обчислення; невідоме значення — 400.
- **BR-WAR-003**: **Пошук** `?q=` — без урахування регістру за номером наряду, назвою / прізвищем /
  ім'ям клієнта і номером авто наряду (`searchContains`, `_` і `%` — звичайні символи).
- **BR-WAR-004**: **Звернення за гарантією** — `POST /warranties/:id/claim { claimWoId }`: наряд-звернення
  своєї організації, не видалений; звернутися можна раз і лише за чинною гарантією (`expiresAt` у
  майбутньому). Запис атомарний: `updateMany` з умовою `claimedAt: null` і `expiresAt > зараз`;
  `count = 0` → повторне читання і 400 «Гарантію вже використано» / «Гарантія закінчилась» — два
  одночасні звернення дають одне звернення й одну відмову (раніше друге мовчки переписувало перше).
- **BR-WAR-005**: **Вкладка «Гарантії»** на `/work-orders`: вкладки «Наряди» / «Гарантії», вкладка в
  URL (`?tab=warranties`), список нарядів не змінюється. Список — `useListPage` (пошук, фільтр стану,
  пагінація, колонки, збережені фільтри, бічна панель): № наряду (посилання на наряд), клієнт / авто,
  опис, виписано (`createdAt`), дійсна до (`expiresAt`, `DD.MM.YYYY`), стан — мітка (діє / закінчується /
  закінчилась / звернення). Дія «Звернення» — лише для `ACTIVE` / `EXPIRING` і ролей OWNER, ADMIN,
  RECEPTIONIST: вікно вибору наряду-звернення (наряди того самого клієнта, крім скасованих); після
  звернення список і лічильники перечитуються. «Пов'язані документи» наряду ведуть клік по гарантії
  на цю вкладку з відкритою гарантією (`useLinkedNav`).

## Аспекти і тести, що їх стережуть

**Модуль:** `apps/api/src/modules/warranties/`

| Аспект          | Файл                         | Кейсів |
| --------------- | ---------------------------- | ------ |
| сервісна логіка | `warranties.service.spec.ts` | 7      |

Реєстр доповнює виконавець вкладки (кейси — з `vitest --reporter=json`).
