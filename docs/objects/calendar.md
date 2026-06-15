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

## Бізнес-правила

- `counterpartyId` може бути заданий прямо (без `workOrderId`) для записів без наряду
- `employeeId` — nullable (підйомник без призначеного механіка — теж валідний слот)
- `type: MAINTENANCE | BREAK | MEETING` — слот без наряду і без клієнта
- `status: AVAILABLE` — відкритий слот для запису (BookingRequest)
- Alternate-mutation endpoint (syncWorkOrderSlots) ОБОВ'ЯЗКОВО повторює conflict probe

→ [docs/BUSINESS-RULES.md](../BUSINESS-RULES.md) (CalendarSlot split-day invariant)
