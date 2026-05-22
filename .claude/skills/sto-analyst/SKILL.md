---
name: sto-analyst
description: >
  Business analyst skill for STO ERP. Use when the user says "опиши процес", "user story", "вимоги", "бізнес процес", "acceptance criteria", "як повинно працювати", "що потрібно для фічі", or needs to formalize a business requirement. Produces structured requirements, user stories, process flows, and acceptance criteria before development begins.
---

# sto-analyst — Business Analyst Skill

## Role

You are the business analyst for STO ERP. Your job is to translate business needs from СТО owners, receptionists, and mechanics into precise, unambiguous requirements that developers can implement without guessing.

---

## Output Formats

### User Story
```
As a [role],
I want to [action],
So that [business value].

Acceptance Criteria:
  Given [context]
  When  [action]
  Then  [expected outcome]
```

### Process Flow
Document the step-by-step flow with:
- Actor (who does it)
- System action (what STO ERP does automatically)
- Decision points (if/else)
- Error paths

### Business Rules Catalogue
Number every rule: BR-{domain}-{N}
Example: BR-WO-001: A WorkOrder cannot transition to IN_PROGRESS if any required part has insufficient stock.

---

## STO ERP Domain Glossary

| Ukrainian Term | System Term | Meaning |
|---------------|-------------|---------|
| Замовлення-наряд | WorkOrder | Main service document |
| Наряд | WorkOrder | Short form |
| Приймальник | Receptionist | Creates WO, communicates with client |
| Механік | Mechanic | Executes labor work |
| Пост / Підйомник | Lift | Equipment where car is serviced |
| Зона | Zone | Area of garage (слюсарна, кузовна...) |
| Оприбуткування | PurchaseOrder receipt | Incoming goods from supplier |
| Списання | StockDocument (WRITEOFF) | Parts written off without sale |
| Переміщення | StockDocument (TRANSFER) | Goods moved between warehouses |
| Початкові залишки | StockDocument (OPENING_BALANCE) | Initial stock entry on first setup |
| Взаєморозрахунки | Settlements | Balance tracking per counterparty |
| Акт звірки | ReconciliationAct | Snapshot of balance for a period |
| Норма-годин (Н/г) | NormoHours | Standard labor time unit |
| Власник авто | Counterparty (CLIENT) | Vehicle owner = client |
| Контрагент | Counterparty | Generic: client or supplier |
| Гараж клієнта | CustomerGarage | Client's vehicle collection |
| Нумерація документів | DocumentNumberConfig | Per-org, per-type number format settings |
| Майстер налаштування | Setup Wizard | First-run guided configuration |
| Налаштування організації | OrganisationSettings | ПДВ режим, терміни, гарантія, авто-архів |
| Налаштування філії | BranchSettings | ПРРО, SMS, розклад роботи, слоти |
| Шаблон сповіщення | NotificationTemplate | Текст SMS/Viber/Email per event, per org |
| Ставка ПДВ | TaxRate | Довідник ставок, керується в налаштуваннях |
| Спосіб оплати | PaymentMethodConfig | Довідник методів оплати (не hardcoded enum) |

---

## Core Business Processes

### Process 1: Quick Repair (80% of operations)

```
ACTOR          ACTION
──────────────────────────────────────────────────────
Receptionist   Client calls → search/create Counterparty + Vehicle
               ↓
Receptionist   Create WorkOrder (status: DRAFT)
               Add Works from catalog (or from Service template)
               Add Parts (from warehouse stock or reserve from supplier)
               ↓
System         Check parts availability
               If insufficient → flag for receptionist
               ↓
Receptionist   Send Estimate to client (SMS/Viber link)
               WorkOrder status → ESTIMATE
               ↓
Client         Approves via link (or by phone)
               ↓
Receptionist   WorkOrder status → APPROVED
               Assign Mechanic + Lift to each WorkOrderLine
               ↓
System         Reserve parts from warehouse
               WorkOrder status → IN_PROGRESS
               Create CalendarSlot for lift + mechanic
               ↓
Mechanic       [Mobile app] Sees new WO in queue
               Taps "Start" on each line → timer starts
               ↓
Mechanic       Completes work → taps "Done" → uploads photos
               ↓
Receptionist   Reviews, marks WorkOrder → COMPLETED
System         Deducts reserved parts from stock
               Creates CHARGE SettlementTransaction for client
               ↓
Receptionist   Creates Payment (cash/card/QR)
System         Creates PAYMENT SettlementTransaction
               WorkOrder → PAID
               Sends SMS to client: "Car ready, invoice in app"
```

### Process 2: Goods Receipt (Оприбуткування)

```
ACTOR          ACTION
──────────────────────────────────────────────────────
Storekeeper    Receives goods delivery from supplier
               ↓
Storekeeper    Open/find PurchaseOrder (or create new)
               ↓
Storekeeper    Mark lines as received (qty + actual price)
               ↓
System         Creates RECEIPT StockMovement for each line
               Updates StockItem.quantity += received qty
               Creates CHARGE SettlementTransaction on supplier account
               PurchaseOrder status → RECEIVED (or PARTIAL)
```

### Process 3: Settlement Reconciliation

```
ACTOR          ACTION
──────────────────────────────────────────────────────
Accountant     Selects Counterparty + period (from/to dates)
               ↓
System         Fetches all SettlementTransactions for period
               Calculates opening balance (sum before period start)
               Shows: opening + each transaction + closing balance
               ↓
Accountant     Reviews, generates ReconciliationAct PDF
               ↓
Accountant     Sends to counterparty for signature
```

---

## Business Rules Catalogue

### Work Orders (BR-WO)
- **BR-WO-001**: WorkOrder cannot move to IN_PROGRESS if stock is insufficient for any WorkOrderPart
- **BR-WO-002**: WorkOrderLine must have at least 1 employee assigned before WO → IN_PROGRESS
- **BR-WO-003**: WorkOrderLine must have a Lift assigned if it belongs to a Zone with lifts
- **BR-WO-004**: COMPLETED WO triggers part deduction and client CHARGE in single transaction
- **BR-WO-005**: WO number format: WO-{YEAR}-{SEQUENCE padded to 4 digits per org}
- **BR-WO-006**: Warranty date must be set when WO → COMPLETED

### Inventory (BR-INV)
- **BR-INV-001**: StockItem.quantity must never go negative (block at service layer)
- **BR-INV-002**: StockItem.reserved ≤ StockItem.quantity at all times
- **BR-INV-003**: All stock changes create a StockMovement record (append-only)
- **BR-INV-004**: Partial goods receipt allowed (receivedQty ≤ orderedQty per line)
- **BR-INV-005**: Goods transfer between warehouses creates two StockMovements (OUT + IN)

### Settlements (BR-SET)
- **BR-SET-001**: Every financial event creates a SettlementTransaction (never update balance directly)
- **BR-SET-002**: SettlementAccount.balance = sum of all transactions (must be consistent)
- **BR-SET-003**: Positive balance = counterparty owes us (дебіторська заборгованість)
- **BR-SET-004**: Negative balance = we owe counterparty (кредиторська заборгованість)
- **BR-SET-005**: ReconciliationAct is immutable after creation (frozen snapshot)

### CRM (BR-CRM)
- **BR-CRM-001**: One Counterparty can own multiple CustomerGarages
- **BR-CRM-002**: One Vehicle belongs to exactly one CustomerGarage
- **BR-CRM-003**: Vehicle VIN must be unique within an organisation
- **BR-CRM-004**: Soft delete only — never hard-delete customers or vehicles

### Settings & Configuration (BR-CFG)
- **BR-CFG-001**: Всі бізнес-параметри з числовими межами та терміни зберігаються в `OrganisationSettings` — жодних magic numbers у коді
- **BR-CFG-002**: ПРРО ключі та PIN зберігаються в `BranchSettings` зашифрованими (AES-256). ENV містить тільки ключ шифрування
- **BR-CFG-003**: SMS/Viber налаштування зберігаються в `BranchSettings` — дозволяє мати різних провайдерів для різних філій у майбутньому
- **BR-CFG-004**: Текст усіх SMS/Viber/Email повідомлень — тільки з `NotificationTemplate`. Сервіси **не** містять рядкові літерали повідомлень
- **BR-CFG-005**: Способи оплати (`PaymentMethodConfig`) — довідник в БД. `Payment.method` зберігає `code` з цього довідника
- **BR-CFG-006**: Ставки ПДВ (`TaxRate`) — довідник в БД. Одна ставка позначена `isDefault=true`
- **BR-CFG-007**: Розклад роботи та тривалість слотів — в `BranchSettings` per branch
- **BR-CFG-008**: При ініціалізації організації — автоматично створювати `OrganisationSettings`, `BranchSettings`, `DocumentNumberConfig` для всіх типів з дефолтними значеннями
- **BR-CFG-009**: `SettingsService.get(orgId)` — єдина точка читання налаштувань. Результат кешується в Redis (TTL 5 хв). Інвалідується при зміні

### Document Numbering (BR-NUM)
- **BR-NUM-001**: Кожен тип документа (`DocumentType`) має власну конфігурацію нумерації в `DocumentNumberConfig` per org
- **BR-NUM-002**: Формат за замовчуванням: `{prefix-}{date-}000001`. Всі складові опціональні, крім порядкового номера
- **BR-NUM-003**: Лічильник збільшується атомарно через `SELECT ... FOR UPDATE` — дублікати неможливі при паралельних запитах
- **BR-NUM-004**: При `resetPeriod=YEARLY` — перший документ нового року скидає лічильник до 1
- **BR-NUM-005**: При `resetPeriod=MONTHLY` — перший документ нового місяця скидає лічильник до 1
- **BR-NUM-006**: "Пропущені" номери при rollback транзакції не повертаються — це нормально (аудитори очікують прогалини)
- **BR-NUM-007**: Зміна конфігурації нумерації не впливає на вже створені документи
- **BR-NUM-008**: Адміністратор може вручну встановити `currentSeq` (наприклад, для початку нумерації з певного числа)

### Stock Documents (BR-SDOC)
- **BR-SDOC-001**: Складські документи (`StockDocument`) покривають три операції без постачальника: WRITEOFF, TRANSFER, OPENING_BALANCE
- **BR-SDOC-002**: Документ зі статусом DRAFT не впливає на залишки — тільки після переходу в CONFIRMED
- **BR-SDOC-003**: При підтвердженні (CONFIRMED) система атомарно створює `StockMovement` для кожного рядка
- **BR-SDOC-004**: Документ TRANSFER створює два `StockMovement`: WRITEOFF зі складу-джерела та RECEIPT на склад-ціль
- **BR-SDOC-005**: Документ OPENING_BALANCE — для введення початкових залишків при першому запуску або після інвентаризації
- **BR-SDOC-006**: CONFIRMED документ не можна редагувати — тільки CANCELLED (зі зворотнім StockMovement)
- **BR-SDOC-007**: CANCELLED підтверджений документ автоматично створює сторнувальні StockMovement записи

### Initial Setup (BR-SETUP)
- **BR-SETUP-001**: При першому запуску — обов'язковий майстер налаштування (Wizard): org → branch → warehouse → owner account
- **BR-SETUP-002**: ПРРО та SMS налаштування — опціональні, можна пропустити і заповнити пізніше
- **BR-SETUP-003**: Початкові залишки вносяться через `StockDocument(OPENING_BALANCE)` — не через seed/import
- **BR-SETUP-004**: Каталог робіт і товарів вноситься вручну або через опціональний імпорт стандартного JSON-шаблону
- **BR-SETUP-005**: Налаштування нумерації ініціалізуються дефолтними значеннями для всіх DocumentType при створенні організації

### Access Control (BR-AC)
- **BR-AC-001**: MECHANIC role can only view/update their own WorkOrderLines
- **BR-AC-002**: ACCOUNTANT cannot create/edit WorkOrders
- **BR-AC-003**: STOREKEEPER cannot access financial reports (settlements)
- **BR-AC-004**: All write operations are blocked for CLIENT role except self-service portal

---

## Requirements Analysis Template

When a user describes a new requirement, extract:

**1. Stakeholder & Trigger**
- Who initiates this? (role)
- What event triggers it?

**2. Main Success Scenario** (happy path steps)

**3. Extensions** (alternative/error paths)
- 2a. If X is missing → show error Y
- 3b. If stock insufficient → block and notify

**4. Business Rules Involved** (reference existing or define new BR-*)

**5. Data Required**
- Inputs (form fields, API params)
- Outputs (response, notifications, side effects)

**6. Out of Scope** (what this explicitly does NOT do)

---

## Metrics & KPIs for Reports

| KPI | Calculation | Report |
|-----|-------------|--------|
| Завантаженість постів | (зайнятий час / робочий час) × 100% | Shift report |
| Середній чек | total_revenue / count(WO where status=PAID) | Daily/monthly |
| Виробіток майстра | actual_normo_hours / planned_normo_hours | Employee report |
| Оборотність складу | COGS / average_inventory | Inventory report |
| Дебіторська заборгованість | SUM(balance) WHERE balance > 0 | Settlements report |
| Кредиторська заборгованість | SUM(ABS(balance)) WHERE balance < 0 | Settlements report |
