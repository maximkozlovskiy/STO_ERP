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

// Кастомні статуси-мітки (VIP / Постійний / Проблемний / Чорний список) — per-org довідник.
model CounterpartyStatus {
  id          String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId       String    @db.Uuid
  name        String
  color       String    @default("#6b7280")   // hex, керує кольором badge-мітки у картці
  syncVersion BigInt    @default(0)
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt
  deletedAt   DateTime?
  // @@unique([orgId, name]); @@index([orgId, deletedAt]); @@index([orgId, syncVersion])
}

// Junction M:N (контрагент ↔ статус). Без deletedAt/syncVersion (як інші junction).
model CounterpartyStatusLink {
  id             String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId          String   @db.Uuid
  counterpartyId String   @db.Uuid
  statusId       String   @db.Uuid
  createdAt      DateTime @default(now())
  // @@unique([counterpartyId, statusId]); @@index([orgId, counterpartyId]); @@index([orgId, statusId])
}
```

**Відносини:**

- ← `CustomerGarage[]` (гаражі клієнта, кожен може мати кілька авто)
- ← `CounterpartyContract[]` (договори: PURCHASE для постачальника, SALE для клієнта)
- ← `CounterpartyStatusLink[]` (statusLinks — M:N до `CounterpartyStatus`, кастомні мітки)
- ← `SettlementAccount?` (один рахунок розрахунків per counterparty)
- ← `WorkOrder[]`, `Invoice[]`, `PurchaseOrder[]`, `Payment[]`
- ← `CalendarSlot[]` (прямий запис без наряду)
- → `Good[]` (as `preferredSupplier`)

**Індекси:**

- `(orgId, deletedAt)`, `(orgId, type, deletedAt)`, `(orgId, syncVersion)`

---

## API Endpoints (`/api/counterparties`)

| Метод  | URL                                                     | Дія                                                                            |
| ------ | ------------------------------------------------------- | ------------------------------------------------------------------------------ |
| GET    | `/api/counterparties`                                   | Список (фільтри: type, q — пошук по імені/телефону)                            |
| GET    | `/api/counterparties/:id`                               | Деталь                                                                         |
| POST   | `/api/counterparties`                                   | Створити                                                                       |
| PATCH  | `/api/counterparties/:id`                               | Оновити                                                                        |
| DELETE | `/api/counterparties/:id`                               | Soft-delete                                                                    |
| GET    | `/api/counterparties/:id/garages`                       | Гаражі контрагента                                                             |
| POST   | `/api/counterparties/:id/garages`                       | Додати гараж                                                                   |
| DELETE | `/api/counterparties/:id/garages/:garageId`             | Видалити гараж                                                                 |
| GET    | `/api/counterparties/:id/contracts`                     | Договори (?showDeleted=true → з soft-deleted)                                  |
| POST   | `/api/counterparties/:id/contracts`                     | Додати договір                                                                 |
| PATCH  | `/api/counterparties/:id/contracts/:contractId`         | Оновити договір                                                                |
| DELETE | `/api/counterparties/:id/contracts/:contractId`         | Soft-delete договору (→ promote isPrimary на наступний)                        |
| POST   | `/api/counterparties/:id/contracts/:contractId/restore` | Відновити (deletedAt→null, isPrimary→false) — OWNER/ADMIN                      |
| POST   | `/api/counterparties/:id/statuses`                      | Призначити статус-мітку `{statusId}` (ідемпотентно) — OWNER/ADMIN/RECEPTIONIST |
| DELETE | `/api/counterparties/:id/statuses/:statusId`            | Зняти статус-мітку — OWNER/ADMIN/RECEPTIONIST                                  |

**Довідник статусів** (`/api/counterparty-statuses`, окремий модуль — дзеркалить brands):

| Метод  | URL                                      | Дія                                              |
| ------ | ---------------------------------------- | ------------------------------------------------ |
| GET    | `/api/counterparty-statuses`             | Список (?showDeleted=true) + `counterpartyCount` |
| POST   | `/api/counterparty-statuses`             | Створити `{name, color?}` — OWNER/ADMIN          |
| PATCH  | `/api/counterparty-statuses/:id`         | Rename/recolor — OWNER/ADMIN                     |
| DELETE | `/api/counterparty-statuses/:id`         | Soft-delete (links лишаються) — OWNER/ADMIN      |
| POST   | `/api/counterparty-statuses/:id/restore` | Відновити (active-dup → 409) — OWNER/ADMIN       |

> `GET /api/counterparties` (список) і `/:id` (detail) обидва повертають `statuses: {id,name,color}[]`
> (лише активні, `deletedAt:null`) — badge-и у таблиці списку + у картці. `edrpou` лишається detail-only
> (toDto без `includeEdrpou`-прапора мапить statuses, але НЕ edrpou). `counterpartyCount` рахує лише
> активних контрагентів (`_count.links where counterparty.deletedAt:null` — Bug #723).

> Restore авто — `POST /api/vehicles/:id/restore` (OWNER/ADMIN). Перевіряє ланцюг parent'ів:
> `BadRequest` якщо гараж або контрагент авто видалені (спочатку відновити їх — Bug #601/#602).
> Vehicles `GET /api/vehicles?...&showDeleted=true` теж повертає soft-deleted (з `deletedAt`).

---

## UI (Web)

| Компонент / сторінка     | Файл                                                                                                                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Список + вкладки         | `app/(app)/counterparties/page.tsx` (таб-роутер `?tab`: список / статуси)                                                                                              |
| Картка контрагента       | `app/(app)/counterparties/[id]/page.tsx`                                                                                                                               |
| Довідник статусів (таб)  | `app/(app)/counterparties/CounterpartyStatusesTab.tsx`                                                                                                                 |
| Керування мітками        | `components/ui/CounterpartyStatusManager.tsx` (badge-и + dropdown; режими: керований / self-fetch) — у `CounterpartyEditModal` (вкладка «Основне») + `[id]/PageClient` |
| Edit Modal (з вкладками) | `components/ui/CounterpartyEditModal.tsx`                                                                                                                              |
| Detail Panel schema      | `lib/panel-schema.ts` → `COUNTERPARTY_PANEL_SCHEMA`                                                                                                                    |
| Hook (TanStack Query)    | `hooks/api/useCounterparties.ts`                                                                                                                                       |

**Вкладки CounterpartyEditModal:** main / vehicles / contracts / work-orders
**Вкладки сторінки контрагентів (`?tab`):** список «Контрагенти» / довідник «Статуси» (мітки)

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
- **Статуси-мітки (кастомні, M:N):** per-org довідник `CounterpartyStatus` (name+color, configuration-over-hardcode — не enum), M:N через `CounterpartyStatusLink`. Assign/unassign валідують, що і контрагент, і статус належать org (tenant-isolation); assign ідемпотентний (`@@unique[counterpartyId,statusId]`, P2002→no-op); unassign неіснуючого → 404. **Soft-delete статусу лишає links** (не каскадить) — `toDto` контрагента фільтрує `status.deletedAt:null`, restore статусу відновлює призначення. Assign/unassign скидають кеш довідника (`counterpartyCount` застаріває). Керування правами: assign/unassign — OWNER/ADMIN/RECEPTIONIST; CRUD довідника — OWNER/ADMIN.
- **isDefault в CustomerGarage:** аналогічна поведінка при видаленні
- `SettlementAccount` створюється автоматично (lazy upsert) при першій транзакції
- `syncVersion` — поле для cloud sync (pull blacklist: `phone`, `edrpou`, `email` не синхронізуються на мобільний)

→ [docs/BUSINESS-RULES.md](../BUSINESS-RULES.md)
→ [docs/PATTERNS.md](../PATTERNS.md) (EntityPickerField для вибору в формах)

---

## Аспекти і тести, що їх стережуть

Правите один аспект — ганяєте один файл:

```bash
cd apps/api && npx vitest run src/modules/counterparties/<файл>.spec.ts
```

**Модуль:** `apps/api/src/modules/counterparties/`

| Аспект                                  | Тест                                            | Кейсів |
| --------------------------------------- | ----------------------------------------------- | ------ |
| audit snapshot                          | `counterparties.audit-snapshot.spec.ts`         | 4      |
| HTTP-контракт (DTO, статуси, валідація) | `counterparties.contract.spec.ts`               | 21     |
| counterparty contracts                  | `counterparties.counterparty-contracts.spec.ts` | 22     |
| crud search                             | `counterparties.crud-search.spec.ts`            | 16     |
| пов'язані документи                     | `counterparties.linked-docs.spec.ts`            | 4      |
| supplier naming                         | `counterparties.supplier-naming.spec.ts`        | 4      |

Разом: **71** кейсів (цифри з `vitest --reporter=json`, не з grep).

**Чого тут НЕМА.** Істотних прогалин не видно: є і контракт, і аспектні спеки. Перевіряти при додаванні нового бізнес-правила — чи з'явився тест.
