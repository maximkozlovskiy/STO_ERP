# MaintenanceSchedule — Dossier

> Графіки планового ТО автомобілів: інтервал у днях та/або пробігу, дата/пробіг
> наступного ТО. Джерело нагадувань «час на ТО» у follow-up-розсилці.

---

## Prisma модель

```prisma
model MaintenanceSchedule {
  id                     String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId                  String    @db.Uuid
  vehicleId              String    @db.Uuid
  maintenanceType        String    @default("REGULAR")   // рядковий тип ТО (напр. REGULAR)
  intervalDays           Int?                            // інтервал у днях
  intervalMileage        Int?                            // інтервал у км
  lastMaintenanceDate    DateTime?
  lastMaintenanceMileage Int?
  nextMaintenanceDate    DateTime?                       // обчислюється: last + intervalDays (Kyiv-DST)
  nextMaintenanceMileage Int?                            // обчислюється: lastMileage + intervalMileage
  notes                  String?
  isActive               Boolean   @default(true)
  syncVersion            BigInt    @default(0)
  createdAt              DateTime  @default(now())
  updatedAt              DateTime  @updatedAt
  deletedAt              DateTime?
}
```

**Відносини:**

- → `Vehicle` (M:1 через `vehicleId`) — авто може мати кілька графіків (різні типи ТО)

**Індекси:**

- `(orgId, vehicleId, deletedAt)` — графіки авто
- `(orgId, nextMaintenanceDate)` — вибірка «наступні до дати» (upcoming + follow-up forecast)
- `(orgId, syncVersion)` — delta-pull

---

## API Endpoints (`/api/maintenance-schedules`)

| Метод  | URL                                   | Дія                                                                                     | Ролі                                 |
| ------ | ------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------ |
| GET    | `/api/maintenance-schedules/upcoming` | Графіки з `nextMaintenanceDate <= today+days` (тільки `isActive`); `?days` (default 30) | RECEPTIONIST, ADMIN, OWNER           |
| GET    | `/api/maintenance-schedules`          | Список; фільтр `?vehicleId=` АБО `?vehicleIds=` (CSV UUID, bulk ≤200)                   | RECEPTIONIST, ADMIN, OWNER, MECHANIC |
| GET    | `/api/maintenance-schedules/:id`      | Деталь                                                                                  | RECEPTIONIST, ADMIN, OWNER, MECHANIC |
| POST   | `/api/maintenance-schedules`          | Створити (`CreateMaintenanceScheduleDto`)                                               | RECEPTIONIST, ADMIN, OWNER           |
| PATCH  | `/api/maintenance-schedules/:id`      | Оновити (`UpdateMaintenanceScheduleDto`)                                                | RECEPTIONIST, ADMIN, OWNER           |
| DELETE | `/api/maintenance-schedules/:id`      | Soft-delete (atomic `updateMany` з `orgId` guard)                                       | ADMIN, OWNER                         |

Відповідь (`MaintenanceScheduleResponseDto`) додає `vehicleLabel` = `"{make} {model} ({licensePlate})"`.
`vehicleIds` — bulk-фільтр для CRM-картки контрагента (усі авто одним запитом замість N×RTT).

---

## Бізнес-правила

- **Розрахунок `nextMaintenanceDate`:** `calcNextDate(lastDate, intervalDays)` = `addDaysKyiv()`
  (Kyiv-DST-aware, не server-local `setDate` — інакше зсув на межі доби/DST). `null` якщо немає
  `lastDate` або `intervalDays`.
- **Розрахунок `nextMaintenanceMileage`:** `lastMaintenanceMileage + intervalMileage` (`null` якщо неповні дані).
- **Recalc при PATCH** лише коли змінюється поле, що впливає (`lastMaintenanceDate`,
  `lastMaintenanceMileage`, `intervalDays`, `intervalMileage`); інакше `next*` лишаються.
- `create` перевіряє існування `Vehicle` (org-scoped) → `NotFound('Авто не знайдено')`.
- Усі reads фільтруються `orgId`, `deletedAt: null`, `vehicle.deletedAt: null`.

---

## Side-effects

| Джерело                                                    | Ефект                                                                                                                                                                                                                                 |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **WorkOrder → COMPLETED** з `repairCategory = MAINTENANCE` | `MaintenanceSchedulesService.updateAfterWorkOrder(orgId, vehicleId, completedAt, outMileage)` — для всіх активних графіків авто оновлює `lastMaintenanceDate/Mileage` і перераховує `next*` (fire-and-forget, помилка лише логується) |
| **FollowUpProcessor** (щоденний cron 09:00 Kyiv)           | Читає активні графіки з `nextMaintenanceDate ∈ [today, today+forecast]` → SMS-нагадування «час на ТО»                                                                                                                                 |

### Нагадування про ТО (follow-up)

- Живе у `notifications/followup.processor.ts` + `followup.scheduler.ts` (cron `0 9 * * *`, tz `Europe/Kyiv`,
  per active org, `attempts: 10`).
- Активація: `OrganisationSettings.followUpActive`. Горизонт прогнозу:
  **`OrganisationSettings.maintenanceForecastDays`** (default 14, міграція `20260909220000`) — вікно
  `[today, today+forecastDays]`, вже-прострочені графіки виключено (щоб не слати SMS про давно
  пропущене ТО щодня).
- Отримувач: `vehicle.customerGarage.counterparty.phone`; SMS-конфіг per-branch (останній наряд авто)
  або fallback-філія (найстаріша) для авто без наряду. Шаблон `FOLLOWUP_REMINDER`; дедуплікація по phone.
- Cap `MAX_SCHEDULES_PER_RUN = 1000` (при досягненні — warn у лог: потрібна пагінація).

## Пов'язані об'єкти

- [work-order.md](work-order.md) — тригер оновлення (MAINTENANCE COMPLETED) · Vehicle (власник графіка)

→ [docs/BUSINESS-RULES.md](../BUSINESS-RULES.md)
