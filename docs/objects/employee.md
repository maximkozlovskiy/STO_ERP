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

| Аспект                                       | Тест                                     | Кейсів |
| -------------------------------------------- | ---------------------------------------- | ------ |
| звільнення: сесії гаснуть, не себе           | `employees.fire.spec.ts`                 | 14     |
| вхід і оновлення токена                      | `../../auth/auth.spec.ts`                | 18     |
| перевірка сесії на кожному запиті            | `../../auth/jwt.strategy.spec.ts`        | 8      |
| панель черг                                  | `../bull-board/bull-board.guard.spec.ts` | 23     |
| фільтр `liftId` — механіки підйомника запису | `employees.lift-filter.spec.ts`          | 5      |
| збереження філій картки — tenant-фільтр      | `employees.assign-branches.spec.ts`      | 1      |
| HTTP-контракт (DTO, статуси, валідація)      | `employees.contract.spec.ts`             | 26     |
| видалення: блок за активним нарядом, каскад  | `employees.remove-guard.spec.ts`         | 3      |

Разом: **98** кейсів (цифри з `vitest --reporter=json`, не з grep).
