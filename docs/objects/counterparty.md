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

| Метод  | URL                                             | Дія                                                     |
| ------ | ----------------------------------------------- | ------------------------------------------------------- |
| GET    | `/api/counterparties`                           | Список (фільтри: type, q — пошук по імені/телефону)     |
| GET    | `/api/counterparties/:id`                       | Деталь                                                  |
| POST   | `/api/counterparties`                           | Створити                                                |
| PATCH  | `/api/counterparties/:id`                       | Оновити                                                 |
| DELETE | `/api/counterparties/:id`                       | Soft-delete                                             |
| GET    | `/api/counterparties/:id/garages`               | Гаражі контрагента                                      |
| POST   | `/api/counterparties/:id/garages`               | Додати гараж                                            |
| DELETE | `/api/counterparties/:id/garages/:garageId`     | Видалити гараж                                          |
| GET    | `/api/counterparties/:id/contracts`             | Договори                                                |
| POST   | `/api/counterparties/:id/contracts`             | Додати договір                                          |
| PATCH  | `/api/counterparties/:id/contracts/:contractId` | Оновити договір                                         |
| DELETE | `/api/counterparties/:id/contracts/:contractId` | Soft-delete договору (→ promote isPrimary на наступний) |

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
- `companyName` — B2B клієнти, `firstName + lastName` — фізичні особи; обидва поля nullable
- **isPrimary в CounterpartyContract:** при soft-delete договору з `isPrimary: true` → promote наступного (`findFirst({ orderBy: { createdAt: 'asc' } })`) у той самий `$transaction`
- **Вид договору у формі (CounterpartyEditModal):** поле «Вид договору» — завжди редагований `<Select>` (НЕ disabled-блок), пункти ФІЛЬТРУЮТЬСЯ за типом контрагента через `contractTypesForCounterparty()`: SUPPLIER → лише `PURCHASE`, CLIENT → лише `SALE`, BOTH → обидва + порожній placeholder (обов'язковий вибір, guard на кнопці «Зберегти»). Дефолт при відкритті форми — `defaultContractType()` (єдиний доступний тип, або '' для BOTH). Submit бере вибір користувача (не перевизначає за типом контрагента).
- **isDefault в CustomerGarage:** аналогічна поведінка при видаленні
- `SettlementAccount` створюється автоматично (lazy upsert) при першій транзакції
- `syncVersion` — поле для cloud sync (pull blacklist: `phone`, `edrpou`, `email` не синхронізуються на мобільний)

→ [docs/BUSINESS-RULES.md](../BUSINESS-RULES.md)
→ [docs/PATTERNS.md](../PATTERNS.md) (EntityPickerField для вибору в формах)
