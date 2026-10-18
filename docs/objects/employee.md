# Employee — Співробітник

> Дос'є агрегату. Тут — доступ працівника до системи; зарплата — [payroll.md](payroll.md).

**Модуль:** `apps/api/src/modules/employees/`
**Автентифікація:** `apps/api/src/auth/`
**Маршрути UI:** `/employees`

## Prisma модель

`Employee` (`packages/database/prisma/schema/03_employees.prisma`): `status EmployeeStatus`
(`ACTIVE` | `ON_LEAVE` | `FIRED`), `dateOfHire`, `dateOfFire`, `deletedAt`; акаунт входу —
`AuthAccount` (1:1, `tokenVersion`, `failedAttempts`, `lockedUntil`).

## API Endpoints (`/api/employees`, `/api/auth`)

| Метод | URL                  | Дія                                                                                        | Ролі                                   |
| ----- | -------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------- |
| GET   | `/api/employees`     | Список; `liftId` — лише закріплені за підйомником, не звільнені й не видалені (BR-CAL-012) | OWNER, ADMIN, RECEPTIONIST, ACCOUNTANT |
| PATCH | `/api/employees/:id` | Зміна картки, зокрема статусу (звільнення — BR-EMP-001)                                    | OWNER, ADMIN                           |
| POST  | `/api/auth/login`    | Вхід; звільнений → 403                                                                     | публічний                              |
| POST  | `/api/auth/refresh`  | Оновлення токена; звільнений → 401                                                         | cookie                                 |

## Бізнес-правила (BR-EMP)

- **BR-EMP-001**: **Працівник зі статусом «звільнено» (`FIRED`) не має доступу до системи**
  (рішення власника 2026-10-13). Вхід із правильним паролем дає 403 «Обліковий запис заблоковано»
  і не змінює лічильник невдалих спроб; із неправильним — звичайну 401, тобто статус без пароля
  не розкривається. Чинна сесія гасне на наступному запиті (401 «Сесія недійсна»), оновлення
  токена дає 401 без нової cookie; те саме для панелі черг. Перехід статусу в `FIRED` у тій самій
  транзакції збільшує `tokenVersion` акаунта, тому видані раніше токени не оживають і після
  повернення статусу — потрібен новий вхід. Повторне збереження вже звільненого версію не чіпає.
  Поставити «звільнено» самому собі не можна (400). Статус «у відпустці» (`ON_LEAVE`) нічого не
  блокує. Працівник, створений одразу зі статусом `FIRED`, просто не зможе увійти.
  (`AuthService.login` / `refresh`, `JwtStrategy.validate`, `BullBoardGuard`,
  `EmployeesService.update`)

## Аспекти і тести, що їх стережуть

**Модуль:** `apps/api/src/modules/employees/`

| Аспект                                                                                                                                                                                                  | Тест                                     | Кейсів |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------ |
| звільнення: сесії гаснуть, не себе                                                                                                                                                                      | `employees.fire.spec.ts`                 | 14     |
| вхід і оновлення токена                                                                                                                                                                                 | `../../auth/auth.spec.ts`                | 18     |
| перевірка сесії на кожному запиті                                                                                                                                                                       | `../../auth/jwt.strategy.spec.ts`        | 8      |
| панель черг                                                                                                                                                                                             | `../bull-board/bull-board.guard.spec.ts` | 23     |
| фільтр `liftId` — механіки підйомника запису, без звільнених і відпустки                                                                                                                                | `employees.lift-filter.spec.ts`          | 5      |
| збереження філій картки — tenant-фільтр                                                                                                                                                                 | `employees.assign-branches.spec.ts`      | 1      |
| HTTP-контракт (DTO, статуси, валідація)                                                                                                                                                                 | `employees.contract.spec.ts`             | 26     |
| видалення: блок за активним нарядом, каскад                                                                                                                                                             | `employees.remove-guard.spec.ts`         | 3      |
| довідники картки наряду: механік — 200, лише id та ім'я активних механіків і id/номер/тип договору; приймальня й комірник — звужені налаштування й ставки ПДВ; інші ролі — повні відповіді; зміни — 403 | `employees.mechanic-lookups.spec.ts`     | 30     |

Разом: **128** кейсів (цифри з `vitest --reporter=json`, не з grep).

**Читання довідників механіком (рішення власника 2026-10-16).** Роль MECHANIC отримує лише читання довідників, які запитує картка наряду: `GET /employees?role=MECHANIC`, `GET /settings/organisation`, `GET /settings/tax-rates`, `GET /counterparties/:id/contracts` — без ставок (`rateScheme`) і без персональних даних понад те, що вже бачить RECEPTIONIST; змінювати їх механік не може. Реалізація: `GET /employees` для MECHANIC завжди віддає лише невидалених механіків (інші `role`/`showDeleted` ігноруються); `GET /settings/organisation` для MECHANIC — лише поля картки (`OrganisationCardSettingsDto`: валюта, ПДВ, мова, перерахунок годин, синхронізація запису), без `laborCostRatio`, лояльності й інтеграцій.

**Звуження й приймальня (рішення власника 2026-10-16, друге).** Приймальня (RECEPTIONIST) отримує `GET /settings/organisation` у тій самій звуженій формі картки наряду (7 полів, `OrganisationCardSettingsDto`), що й механік, і `GET /settings/tax-rates` — картка наряду приймальні рахує ПДВ організації, а не за замовчуванням. Механік бачить мінімум: `GET /employees` — лише `id`, прізвище та ім'я механіків (без телефону, e-mail, дат найму/звільнення, `userId` тощо); `GET /counterparties/:id/contracts` — лише `id`, номер і тип договору (без кредитного ліміту, відстрочки, сум і дат). Реалізація: `GET /settings/organisation` для RECEPTIONIST — той самий `OrganisationCardSettingsDto`; `GET /employees` для MECHANIC — `EmployeeLookupListDto` (`select` id, ім'я, прізвище) лише АКТИВНИХ (не звільнених, не у відпустці) невидалених механіків — список вибору виконавця картки (BR-WO-018); пошук `q` — лише за ім'ям і прізвищем; `GET /counterparties/:id/contracts` для MECHANIC — `ContractLookupDto` без видалених (`showDeleted` не діє). E2E: `apps/web/e2e/work-order-lookups-roles.spec.ts` — приймальня відкриває й редагує картку наряду без 403 з ПДВ організації; у відповідях механіку — лише мінімальні поля

**Комірник і картка замовлення постачальнику (рішення власника 2026-10-18).** Комірник (STOREKEEPER) отримує `GET /settings/organisation` у тій самій звуженій формі (`OrganisationCardSettingsDto`, 7 полів: валюта, ПДВ, мова, перерахунок годин, синхронізація запису — без `laborCostRatio`, лояльності, термінів і інтеграцій) і `GET /settings/tax-rates` — картка замовлення постачальнику (`PurchaseOrderCreateModal`) рахує ПДВ організації; без них картка комірника рахувала замовлення «без ПДВ» і отримувала 403. Запис (`PATCH /settings/organisation`, `POST /settings/tax-rates`) — 403, як і раніше. Реалізація: `CARD_SETTINGS_ONLY_ROLES` у `settings.controller.ts`; тести — `employees.mechanic-lookups.spec.ts`, ролі — `settings.contract.spec.ts`.

**Комірник обирає постачальника (рішення власника 2026-10-18, [counterparty.md](counterparty.md) BR-CP-014).** Комірник (STOREKEEPER) читає `GET /counterparties` — лише невидалених постачальників (SUPPLIER/BOTH, фільтр на сервері, а не з параметра) і лише id, тип, назву, ім'я та ЄДРПОУ — і `GET /counterparties/:id/contracts` постачальника — лише договори закупівлі (номер, відстрочка). Клієнтів, телефонів, e-mail, балансів і розрахунків не бачить; картка контрагента (`GET /counterparties/:id`) і будь-який запис — 403. Реалізація: `CounterpartiesService.findSupplierLookups` / `findSupplierContracts`; тести — `counterparties.storekeeper-suppliers.spec.ts`; web — «Позиції» → «Постачальник і ціна» і пошук постачальника в картці замовлення.
