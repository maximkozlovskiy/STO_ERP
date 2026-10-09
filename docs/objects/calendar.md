# CalendarSlot — Dossier

> Слот у календарі підйомника або механіка. Прив'язується до наряду (опціонально) або є незалежним записом.

---

## Prisma модель

```prisma
model CalendarSlot {
  id             String             @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId          String             @db.Uuid
  liftId         String?            @db.Uuid    // підйомник (optional)
  employeeId     String?            @db.Uuid    // механік (optional)
  workOrderId    String?            @db.Uuid    // наряд (optional)
  counterpartyId String?            @db.Uuid    // клієнт без наряду (direct booking)
  vehicleId      String?            @db.Uuid    // авто (optional)
  parentSlotId   String?            @db.Uuid    // split-day continuation (child slot)
  startAt        DateTime
  endAt          DateTime
  status         CalendarSlotStatus @default(BOOKED)  // AVAILABLE | BOOKED | BLOCKED
  type           CalendarSlotType   @default(WORK)    // WORK | MAINTENANCE | BREAK | MEETING
  notes          String?
  syncVersion    BigInt             @default(0)
  createdAt      DateTime           @default(now())
  updatedAt      DateTime           @updatedAt
  deletedAt      DateTime?
}
```

**Відносини:**

- → `Lift` (optional)
- → `WorkOrder` (optional)
- → `Counterparty` (optional — прямий запис клієнта без наряду)
- → `Vehicle` (optional)
- → `CalendarSlot` parent (self-referencing для split-day)
- ← `CalendarSlot[]` continuation (child slots)

**Індекси:**

- `(orgId, startAt, deletedAt)` — range query по даті
- `(orgId, liftId, startAt, endAt)` — конфлікти підйомника
- `(orgId, employeeId, startAt)` — завантаженість механіка
- `(orgId, workOrderId, deletedAt, startAt)` — covering для linked-docs панелі

---

## API Endpoints (`/api/calendar`)

| Метод  | URL                                        | Дія                                                    |
| ------ | ------------------------------------------ | ------------------------------------------------------ |
| GET    | `/api/calendar`                            | Слоти за датою/діапазоном (liftId, employeeId, date)   |
| POST   | `/api/calendar/check-conflicts`            | Перевірити конфлікти (excludeWorkOrderId обов'язковий) |
| POST   | `/api/calendar`                            | Створити слот                                          |
| PATCH  | `/api/calendar/by-work-order/:workOrderId` | Bulk-update слотів наряду (syncWorkOrderSlots)         |
| PATCH  | `/api/calendar/:id`                        | Оновити один слот                                      |
| DELETE | `/api/calendar/:id`                        | Soft-delete слота                                      |

---

## UI (Web)

| Компонент / сторінка  | Файл                                         |
| --------------------- | -------------------------------------------- |
| Календар (DnD)        | `app/(app)/calendar/page.tsx` (1460+ рядків) |
| Модалка слота         | `app/(app)/calendar/CalendarSlotModal.tsx`   |
| Hook (conflict check) | `hooks/useConflictCheck.ts`                  |

---

## Split-day continuation — ключовий інваріант

Слот що перетинає опівніч розбивається на два:

```
parent: startAt=2026-06-14 18:00 → endAt=2026-06-14 20:00  (parentSlotId = null)
child:  startAt=2026-06-15 08:00 → endAt=2026-06-15 11:00  (parentSlotId = parent.id)
```

**Інваріант:** `parent.endAt < child.startAt` (gap = нічний час).

### Cascade-update через syncWorkOrderSlots

При зміні часу WO через `PATCH /by-work-order/:workOrderId`:

1. Soft-delete continuations (`parentSlotId IS NOT NULL`)
2. Update тільки parent (`parentSlotId IS NULL`)
3. Recreate child якщо range перевищує `WORK_DAY_END_H (20:00)`

**Увага:** `updateMany({ workOrderId })` з одним `{startAt, endAt}` — data corruption.

---

## Conflict check — обов'язковий при кожній мутації

```typescript
// excludeWorkOrderId — власний WO не є конфліктом з собою
const conflicts = await this.calendarService.checkConflicts({
  liftId,
  startAt,
  endAt,
  excludeWorkOrderId: workOrder.id,
});
if (conflicts.length > 0) throw new ConflictException('Підйомник вже зайнятий');
```

**КРИТИЧНО:** будь-який метод що мутує `startAt/endAt` ОБОВ'ЯЗКОВО викликає conflict probe.  
Пропуск → silent double-booking (Bug #444).

---

## Бізнес-правила (BR-CAL)

- **BR-CAL-001**: `counterpartyId` може бути заданий прямо (без `workOrderId`) для записів без наряду
- **BR-CAL-002**: `employeeId` — nullable (підйомник без призначеного механіка — теж валідний слот)
- **BR-CAL-003**: `type: MAINTENANCE | BREAK | MEETING` — слот без наряду і без клієнта
- **BR-CAL-004**: «Відкритих» слотів для онлайн-запису немає — вільний час не зберігається, а обчислюється. `BookingService.getAvailability` будує сітку з `BranchSettings` (`workStartTime` / `workEndTime` / `slotDurationMinutes` / `workDays`; без налаштувань — 09:00–18:00, крок 30 хв, пн–пт) і прибирає з неї час, зайнятий на підйомнику БУДЬ-ЯКИМ невидаленим `CalendarSlot` (статус значення не має) і заявками `BookingRequest` зі статусом `CONFIRMED`; вікно доступне, якщо вільний хоч один підйомник філії. Слот без явного статусу створюється як `BOOKED`; підтвердження заявки з обраним підйомником створює новий слот `BOOKED`. Значення `AVAILABLE` в enum `CalendarSlotStatus` існує, і `CreateCalendarSlotDto` його приймає, але ніхто його не створює і не читає (api, web, mobile; у web є лише підпис «Вільний» у `lib/linked-configs.tsx`) — такий слот займає час так само, як `BOOKED`. Справжні «відкриті слоти» — окрема фіча в беклозі
- **BR-CAL-005**: Alternate-mutation endpoint (syncWorkOrderSlots) ОБОВ'ЯЗКОВО повторює conflict probe
- **BR-CAL-006** _(виведено з коду, не затверджено власником)_: слот не може перетинатися в часі з іншим невидаленим слотом тієї самої організації на тому самому підйомнику або в того самого механіка — `createSlot` і `updateSlot` відмовляють 400 (`err.calendar.liftBusy` / `employeeBusy`; для продовження split-day — `liftBusyNextDay` / `employeeBusyNextDay`) і нічого не записують. Перетин напіввідкритий: `startAt < інший.endAt AND endAt > інший.startAt`, тож дотик меж — не конфлікт. Статус і тип іншого слота значення не мають; інший підйомник — не конфлікт; слот без підйомника й механіка ні з чим не конфліктує. `updateSlot` виключає з проби сам слот і перевіряє НОВИЙ підйомник/механіка. Гонку, що обійшла пробу, ловить EXCLUDE `calendar_slots_no_overlap` (лише підйомник) → 409
- **BR-CAL-007** _(з виправлення Bug #819, не затверджено власником)_: на межі робочого дня ділиться лише слот, що ПОЧИНАЄТЬСЯ в робочий час і закінчується після його кінця. Слот, що починається о кінці робочого дня або пізніше (як і той, що починається до відкриття), зберігається одним записом із запитаним часом — без продовження наступного дня. Чи приймати слоти поза робочим часом узагалі — рішення власника

→ [docs/BUSINESS-RULES.md](../BUSINESS-RULES.md) (CalendarSlot split-day invariant)

---

## Аспекти і тести, що їх стережуть

Правите один аспект — ганяєте один файл:

```bash
cd apps/api && npx vitest run src/modules/calendar/<файл>.spec.ts
```

**Модуль:** `apps/api/src/modules/calendar/`

| Аспект                                                                              | Тест                          | Кейсів |
| ----------------------------------------------------------------------------------- | ----------------------------- | ------ |
| HTTP-контракт (DTO, статуси, валідація)                                             | `calendar.contract.spec.ts`   | 31     |
| сервісна логіка                                                                     | `calendar.service.spec.ts`    | 21     |
| види слотів (без наряду / без механіка / службові / статус)                         | `calendar.slot-kinds.spec.ts` | 7      |
| конфлікти слотів у `createSlot` / `updateSlot` (підйомник, механік, split-day, 409) | `calendar.conflicts.spec.ts`  | 27     |
| межі дня у `findSlots` (київська доба, переведення годинника, перевірка дати)       | `calendar.day-bounds.spec.ts` | 18     |

Разом: **86** кейсів (цифри з `vitest --reporter=json`, не з grep).

Спільний сетап — `calendar.spec-fixture.ts`: сховище слотів у пам'яті, яке ВИКОНУЄ Prisma `where`
(а не повертає заготовку), тож кейси конфліктів описують поведінку, а не форму запиту.

Вільний час онлайн-запису (те саме правило про статус слота) стережуть ще 9 кейсів поза модулем —
у спеку сервісу онлайн-запису `apps/api/src/modules/booking/` (`booking.service.spec.ts`: блок
«getAvailability — вільний час онлайн-запису» і три позначені міткою старі кейси).

**Чого тут НЕМА.** Контракт і аспектні спеки є, але стережуть вони не все:

- Conflict probe стережеться лише над сховищем у пам'яті. Справжній перетин проти БД не ганяє ніхто: integration-спек `apps/api/src/prisma/schema-integrity.integration.spec.ts` перевіряє тільки, що EXCLUDE `calendar_slots_no_overlap` ІСНУЄ, а не що він відхиляє пересічні слоти. `syncWorkOrderSlots` перевірено на моках-заготовках (форма `where`, не поведінка).
- `checkConflicts()` (read-only проба для UI, `excludeSlotId` / `excludeWorkOrderId`) unit-тестом не стережеться зовсім: контракт-спек мокає сервіс цілком.
- Зайнятість механіка страхує лише app-проба: EXCLUDE-констрейнт покриває підйомник, тож дві одночасні транзакції можуть подвоїти механіка — тестом це не відтворюється.
- Службові типи слота (`MAINTENANCE` / `BREAK` / `MEETING`) перевірені лише як «тип зберігається і слот створюється без наряду й клієнта». Заборони прив'язати до такого слота наряд чи клієнта в коді немає, тож і тесту на неї немає.
- Знімання механіка (`employeeId: null`) перевірене на рівні сервісу; чи пропускає `null` HTTP-валідація `UpdateCalendarSlotDto` (`@IsOptional` + `@IsUUID`), контракт-спек не перевіряє.
- `status` і `type` слота після створення змінити неможливо (`UpdateCalendarSlotDto` їх не містить) — це ніде не зафіксовано тестом.
