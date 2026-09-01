# Counterparty — Dossier

> Контрагент: клієнт (CLIENT), постачальник (SUPPLIER), або обидва (BOTH).
> Центральний агрегат CRM — пов'язаний з нарядами, рахунками, замовленнями, розрахунками.

---

## Prisma модель

```prisma
model Counterparty {
  id            String           @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId         String           @db.Uuid
  type          CounterpartyType              // CLIENT | SUPPLIER | BOTH
  firstName     String?
  lastName      String?
  companyName   String?
  edrpou        String?
  vatPayer      Boolean          @default(false)
  phone         String?
  email         String?
  notes         String?
  legalForm     LegalForm?                    // INDIVIDUAL | FOP | TOV | AT | PP | OTHER
  legalAddress  String?
  actualAddress String?
  bankAccount   String?
  bankName      String?
  contactPerson String?
  taxNumber     String?
  syncVersion   BigInt           @default(0)
  createdAt     DateTime         @default(now())
  updatedAt     DateTime         @updatedAt
  deletedAt     DateTime?
}

model CounterpartyContract {
  id               String       @id ...
  orgId            String       @db.Uuid
  counterpartyId   String       @db.Uuid
  number           String
  contractType     ContractType              // PURCHASE | SALE
  startDate        DateTime     @db.Date
  endDate          DateTime?    @db.Date
  isPrimary        Boolean      @default(false)
  creditLimit      Decimal?     @db.Decimal(15, 2)
  paymentDeferDays Int?
}
```

**Відносини:**

- ← `CustomerGarage[]` (гаражі клієнта, кожен може мати кілька авто)
- ← `CounterpartyContract[]` (договори: PURCHASE для постачальника, SALE для клієнта)
- ← `SettlementAccount?` (один рахунок розрахунків per counterparty)
- ← `WorkOrder[]`, `Invoice[]`, `PurchaseOrder[]`, `Payment[]`
- ← `CalendarSlot[]` (прямий запис без наряду)
- → `Good[]` (as `preferredSupplier`)

**Індекси:**

- `(orgId, deletedAt)`, `(orgId, type, deletedAt)`, `(orgId, syncVersion)`

---

## API Endpoints (`/api/counterparties`)

| Метод  | URL                                                     | Дія                                                       |
| ------ | ------------------------------------------------------- | --------------------------------------------------------- |
| GET    | `/api/counterparties`                                   | Список (фільтри: type, q — пошук по імені/телефону)       |
| GET    | `/api/counterparties/:id`                               | Деталь                                                    |
| POST   | `/api/counterparties`                                   | Створити                                                  |
| PATCH  | `/api/counterparties/:id`                               | Оновити                                                   |
| DELETE | `/api/counterparties/:id`                               | Soft-delete                                               |
| GET    | `/api/counterparties/:id/garages`                       | Гаражі контрагента                                        |
| POST   | `/api/counterparties/:id/garages`                       | Додати гараж                                              |
| DELETE | `/api/counterparties/:id/garages/:garageId`             | Видалити гараж                                            |
| GET    | `/api/counterparties/:id/contracts`                     | Договори (?showDeleted=true → з soft-deleted)             |
| POST   | `/api/counterparties/:id/contracts`                     | Додати договір                                            |
| PATCH  | `/api/counterparties/:id/contracts/:contractId`         | Оновити договір                                           |
| DELETE | `/api/counterparties/:id/contracts/:contractId`         | Soft-delete договору (→ promote isPrimary на наступний)   |
| POST   | `/api/counterparties/:id/contracts/:contractId/restore` | Відновити (deletedAt→null, isPrimary→false) — OWNER/ADMIN |

> Restore авто — `POST /api/vehicles/:id/restore` (OWNER/ADMIN). Перевіряє ланцюг parent'ів:
> `BadRequest` якщо гараж або контрагент авто видалені (спочатку відновити їх — Bug #601/#602).
> Vehicles `GET /api/vehicles?...&showDeleted=true` теж повертає soft-deleted (з `deletedAt`).

---

## UI (Web)

| Компонент / сторінка     | Файл                                                |
| ------------------------ | --------------------------------------------------- |
| Список                   | `app/(app)/counterparties/page.tsx`                 |
| Картка контрагента       | `app/(app)/counterparties/[id]/page.tsx`            |
| Edit Modal (з вкладками) | `components/ui/CounterpartyEditModal.tsx`           |
| Detail Panel schema      | `lib/panel-schema.ts` → `COUNTERPARTY_PANEL_SCHEMA` |
| Hook (TanStack Query)    | `hooks/api/useCounterparties.ts`                    |

**Вкладки CounterpartyEditModal:** main / vehicles / contracts / work-orders

---

## Бізнес-правила

- `CounterpartyType`: CLIENT — тільки у клієнтських WO/Invoice; SUPPLIER — тільки у PO; BOTH — обидва потоки
- Пошук по `firstName + lastName` АБО `companyName` (similarity окремо для кожного)
- `companyName` — B2B клієнти, `firstName + lastName` — фізичні особи; поля nullable у схемі, але **«назва» обов'язкова на рівні сервісу** (cross-field, гнучко): `create`/`update` вимагають `companyName` АБО `firstName`/`lastName` (`hasCounterpartyName()` guard, `BadRequest`). PATCH перевіряє merged-стан (очищення останньої назви теж → 400). Frontend: 3 точки створення (`CounterpartyEditModal` create/edit + `CalendarSlotModal` майстер) синхронізовані — guard з `.trim()` + однакове повідомлення; кнопка «Зберегти» disabled без назви; SUPPLIER → «Назва компанії» required
- **isPrimary в CounterpartyContract:** при soft-delete договору з `isPrimary: true` → promote наступного (`findFirst({ orderBy: { createdAt: 'asc' } })`) у той самий `$transaction`
- **Вид договору у формі (CounterpartyEditModal):** поле «Вид договору» — завжди редагований `<Select>` (НЕ disabled-блок), пункти ФІЛЬТРУЮТЬСЯ за типом контрагента через `contractTypesForCounterparty()`: SUPPLIER → лише `PURCHASE`, CLIENT → лише `SALE`, BOTH → обидва + порожній placeholder (обов'язковий вибір, guard на кнопці «Зберегти»). Дефолт при відкритті форми — `defaultContractType()` (єдиний доступний тип, або '' для BOTH). Submit бере вибір користувача (не перевизначає за типом контрагента).
- **CRUD договору у формі (CounterpartyEditModal):** рядок договору має кнопки олівець (редагувати) + кошик (soft-delete з `useConfirm`). `saveContract()` об'єднує POST (create) та PATCH (edit за `editingContractId`); `deleteContract()` → `DELETE` + optimistic filter із промоутом наступного головного ТОГО Ж `contractType`. isPrimary-optimistic scoped по `contractType` — дзеркалить бековий `swapType`-scope (для BOTH не чіпає інший тип). Усі handler'и з tenant-guard (`cpIdAtStart` vs `currentCpIdRef`).
- **CRUD авто у формі (CounterpartyEditModal, вкладка «Авто»):** рядок авто має кнопки олівець (редагувати) + кошик (delete з `useConfirm`). `saveVehicle()` об'єднує POST (create, auto-створює гараж «Основний» якщо нема) та PATCH `/vehicles/:id` (edit за `editingVehicleId`, БЕЗ `customerGarageId`). Форма редагує 5 базових полів (make/model/year/licensePlate/vin) — повне редагування на сторінці авто. tenant-guard як у договорів.
- **Картка лишається відкритою після create (CounterpartyEditModal):** `onSaved(cp, isNew)` — після СТВОРЕННЯ (`isNew=true`) батько (`counterparties/page`) не закриває модалку, а передає створеного назад як `counterparty` proc → модалка перемикається в edit-режим (вкладки Авто/Договори/Історія) для одразу-заповнення. `update` (`isNew=false`) закриває як раніше. Edit-only споживачі (CalendarSlotModal та ін.) ігнорують 2-й параметр.
- **Показ видалених + відновлення (CounterpartyEditModal, вкладки «Договори»/«Авто»):** галка «Показувати видалені» → GET з `?showDeleted=true`; видалені рядки приглушені (opacity-60) + бейдж «Видалено», дії → кнопка «Відновити» (RotateCcw) замість олівець/кошик. Restore: `deletedAt→null`; для договору `isPrimary→false` (уникнення дубля-головного). **Restore авто перевіряє ланцюг parent'ів** — не можна відновити авто у видалений гараж/контрагента (Bug #601/#602 — silent orphan). Окремі toggle-useEffect на кожну галку (both directions, skip-first-run ref скидається на CP-switch), stale-guard reqRef.
- **isDefault в CustomerGarage:** аналогічна поведінка при видаленні
- `SettlementAccount` створюється автоматично (lazy upsert) при першій транзакції
- `syncVersion` — поле для cloud sync (pull blacklist: `phone`, `edrpou`, `email` не синхронізуються на мобільний)

→ [docs/BUSINESS-RULES.md](../BUSINESS-RULES.md)
→ [docs/PATTERNS.md](../PATTERNS.md) (EntityPickerField для вибору в формах)
