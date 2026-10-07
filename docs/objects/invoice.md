# Invoice — Dossier

> Рахунок клієнту. Може бути прив'язаний до наряду або виставлений окремо.

---

## Prisma модель

```prisma
model Invoice {
  id              String        @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId           String        @db.Uuid
  counterpartyId  String        @db.Uuid
  workOrderId     String?       @db.Uuid
  number          String
  amount          Decimal       @db.Decimal(12, 2)
  status          InvoiceStatus @default(DRAFT)
  dueDate         DateTime?
  invoiceType     String        @default("INVOICE")
  notes           String?
  paidAmount      Decimal       @default(0) @db.Decimal(12, 2)
  totalWithoutVat Decimal       @default(0) @db.Decimal(12, 2)
  totalVat        Decimal       @default(0) @db.Decimal(12, 2)
  totalWithVat    Decimal       @default(0) @db.Decimal(12, 2)
  currencyId      String?       @db.Uuid   // мультивалюта Фаза 3: валюта документа
  totalAmountBase Decimal?      @db.Decimal(12, 2) // amount у БАЗОВІЙ валюті org по курсу на documentDate
  rateUsed        Decimal?      @db.Decimal(18, 6)
  documentDate    DateTime      @default(now()) @db.Date
  syncVersion     BigInt        @default(0)
  createdAt       DateTime      @default(now())
  updatedAt       DateTime      @updatedAt
  deletedAt       DateTime?
}
```

> **Мультивалюта (Фаза 3, 2026-09-14):** `amount`/`paidAmount`/`total*` тепер у **валюті документа**
> (`currencyId`; nullable → base UAH для історичних). `totalAmountBase`/`rateUsed` — тотал у базовій
> валюті по курсу на `documentDate` (recalcTotals; fallbackToLatest). createFromWorkOrder успадковує
> валюту наряду. Standalone CHARGE (SEND) і mirror PAYMENT (manual→PAID) пробрасують `currencyId`+`date`
> у settlement → борг у base. **Оплата рахунку має бути у ТІЙ САМІЙ валюті** (payments.service: валюта
> оплати == валюта рахунку, інакше 400; overpay/paidAmount порівнюються у валюті документа). Іновалютний
> рахунок структурно нефіскалізовний. FX-різниці — поза Фазою 3.

**Відносини:**

- → `Counterparty` (M:1 через `counterpartyId`)
- → `WorkOrder` (M:1 через `workOrderId`, optional — рахунок може бути без наряду)
- ← `Payment[]` (платежі по рахунку)
- ← `InvoiceLine[]` (рядки: роботи + товари)

**Індекси:**

- `(orgId, status, deletedAt)` — список по статусу
- `(orgId, workOrderId, deletedAt, createdAt)` — covering для getLinkedDocuments (WO Documents tab)

---

## FSM

```
DRAFT → SENT → PARTIALLY_PAID → PAID
      ↘ CANCELLED   ↘ PAID       ↘ CANCELLED
OVERDUE → PAID / CANCELLED
```

| Статус           | Значення                                      |
| ---------------- | --------------------------------------------- |
| `DRAFT`          | Чернетка, редагується                         |
| `SENT`           | Надіслано клієнту                             |
| `PARTIALLY_PAID` | Частково оплачено (`0 < paidAmount < amount`) |
| `PAID`           | Оплачено (`paidAmount >= amount`)             |
| `OVERDUE`        | Прострочено (dueDate < today)                 |
| `CANCELLED`      | Скасовано                                     |

**FSM файл:** `apps/api/src/modules/invoices/invoices.service.ts` (`INV_TRANSITIONS`),
дзеркалить `INVOICE_STATUS_TRANSITIONS` у `@sto/shared`.

**Важливо:** `PARTIALLY_PAID` виставляється **лише** частковим платежем
(`PaymentsService.create`), а НЕ через FSM-endpoint. FSM-перехід у `PARTIALLY_PAID`
відсутній у мапі навмисно (`SENT → [PAID, CANCELLED]`).

---

## API Endpoints (`/api/invoices`)

| Метод  | URL                                                  | Дія                                                                                                                                                             |
| ------ | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/invoices`                                      | Список (фільтри: status, counterpartyId, dateFrom, dateTo)                                                                                                      |
| GET    | `/api/invoices/:id`                                  | Деталь з lines                                                                                                                                                  |
| POST   | `/api/invoices`                                      | Створити рахунок (lines у body)                                                                                                                                 |
| POST   | `/api/invoices/from-work-order/:workOrderId`         | Створити з наряду (auto-fill lines)                                                                                                                             |
| POST   | `/api/invoices/from-work-order/:workOrderId/refresh` | Оновити рядки з наряду                                                                                                                                          |
| GET    | `/api/invoices/from-work-order/:workOrderId/find`    | Знайти існуючий рахунок по наряду (lightweight: `{ id, number, status: InvoiceStatus, amount, documentDate: string \| null }` або `null`); виключає `CANCELLED` |
| PATCH  | `/api/invoices/:id`                                  | Оновити (тільки DRAFT)                                                                                                                                          |
| POST   | `/api/invoices/:id/transition`                       | FSM перехід                                                                                                                                                     |
| POST   | `/api/invoices/:id/clone`                            | Клонувати рахунок                                                                                                                                               |
| GET    | `/api/invoices/:id/pdf`                              | Завантажити PDF                                                                                                                                                 |
| DELETE | `/api/invoices/:id`                                  | Soft-delete                                                                                                                                                     |
| POST   | `/api/invoices/:id/lines`                            | Додати рядок                                                                                                                                                    |
| PATCH  | `/api/invoices/:id/lines/:lineId`                    | Оновити рядок                                                                                                                                                   |
| DELETE | `/api/invoices/:id/lines/:lineId`                    | Видалити рядок                                                                                                                                                  |

---

## UI (Web)

| Компонент / сторінка  | Файл                                           |
| --------------------- | ---------------------------------------------- |
| Список                | `app/(app)/invoices/page.tsx`                  |
| Модалка створення     | `components/ui/InvoiceCreateModal.tsx`         |
| Detail Panel schema   | `lib/panel-schema.ts` → `INVOICE_PANEL_SCHEMA` |
| Hook (TanStack Query) | `hooks/api/useInvoices.ts`                     |

---

## Бізнес-правила (BR-INV)

- **BR-INV-001**: Номер авто-генерується: `DocumentNumberService.next(orgId, 'INVOICE')`
- **BR-INV-002**: Рахунок з наряду: `POST /from-work-order/:id` автоматично переносить роботи і товари з WO
- **BR-INV-003**: `invoiceType` — UI-enum `STANDARD`/`PREPAYMENT`/`CREDIT_NOTE` (`INVOICE_TYPE_VALUES`/
  `INVOICE_TYPE_LABELS` у `@sto/shared`). Prisma-колонка має `@default("INVOICE")` (legacy,
  поза enum-ом) — тому `create()` і `createFromWorkOrder()` в `invoices.service.ts` ЗАВЖДИ
  ставлять `invoiceType` явно (`'STANDARD'`), ніколи не покладаються на DB-дефолт.
  `InvoiceCreateModal` при завантаженні рахунку нормалізує будь-яке значення поза enum-ом
  (старі рядки з БД) на `'STANDARD'` через `normalizeInvoiceType()` — інакше zodResolver
  валить submit формою `invoiceFormSchema` (fix 675d6b4c, Аудит #1 Фаза 3).
- **BR-INV-004**: `dueDate` контролюється `invoiceDueDays` з `SettingsService.get(orgId)` — не хардкодиться
- **BR-INV-005**: `OVERDUE` встановлюється автоматично (scheduler або при відкритті списку)
- **BR-INV-006**: При оплаті → `SettlementsService.createTransaction(PAYMENT)` (не пряма зміна балансу)
- **BR-INV-007**: `InvoiceLine`: кожен рядок має `vatRate`, `priceWithoutVat`, `vatAmount`, `priceWithVat`
- **BR-INV-008**: `calcVatTotals()` з `apps/web/src/lib/utils.ts` — для розрахунку підсумків на фронті

### Часткова оплата (модель грошей, Фаза 1)

- **BR-INV-009**: `paidAmount` — **авторитетна колонка** сплаченого. Оновлюється транзакційно при кожному
  платежі. `toDto` читає її; фолбек на `sum(payments)` лише коли колонки немає у вибірці.
- **BR-INV-010**: **Оплата** (`PaymentsService.create` з `invoiceId`): дозволена лише для `SENT`/`PARTIALLY_PAID`;
  переплата (`amount > amount − paidAmount`) → 400. Атомарно: **CAS** `updateMany({ where:
paidAmount = прочитане }, data: paidAmount += amount, status: newPaid>=amount ? PAID :
PARTIALLY_PAID)`. `count=0` (гонка паралельного платежу) → throw → rollback усього
  (Payment + PAYMENT-settlement) у тій самій `$transaction`. **FIN-C1 інваріант** — під
  ReadCommitted захищає оптимістичний CAS по `paidAmount`, не рівень ізоляції.
- **BR-INV-011**: **Ledger:** кожен частковий платіж створює один `PAYMENT`-settlement своєї суми
  (`BALANCE_SIGN[PAYMENT] = −1`) → борг зменшується рівно на суму кожного платежу; подвійного
  списання немає.
- **BR-INV-012**: **Ручний PAID** (`transition` → `PAID`): синхронізує `paidAmount = amount` (щоб «залишок» був 0),
  але **НЕ створює** `Payment`/`PAYMENT`-settlement. Це статус-узгодження, не рух грошей.
  ⚠️ Наслідок: для **standalone**-рахунку (CHARGE нараховано при `SENT`) ручний PAID лишає
  CHARGE без offset-PAYMENT у settlement-ledger → баланс контрагента покаже борг попри «PAID»
  статус рахунку. Правильний шлях повного погашення — реєстрація платежу (кнопка «Оплатити»),
  не ручний FSM-перехід. Ручний PAID призначений для WO-рахунків (CHARGE вже net при COMPLETED)
  або як адмін-корекція.

### Рахунок-призначення платежу (`Payment.sourceType`)

- **BR-INV-013**: `Payment` знає, **куди фізично лягли гроші**: `sourceType` (`BANK_ACCOUNT`/`CASH_REGISTER`) +
  `bankAccountId`/`cashRegisterId`. Джерело: DTO явно → інакше дефолт з `PaymentMethodConfig`
  (`defaultSourceType`/`defaultBankAccountId`/`defaultCashRegisterId`) → інакше `null`.
- **BR-INV-014**: Валідація (`resolveDestinationAccount`): рахунок мусить бути в межах org (не крос-tenant) і живий.
  **Явний** з DTO невалідний рахунок → 4xx; **дефолт з config** що з тих пір видалено (stale) →
  тихо `null` (offline-first: не валимо легітимний платіж через застарілий конфіг).
- **BR-INV-015**: Source-link — **опційна метадані**; борг/settlement від нього не залежать (два різні виміри).
- **BR-INV-016**: FK `ON DELETE SET NULL` (рахунки нормально soft-delete-яться; hard-delete лишає Payment з
  `null`-source, зберігаючи суму й settlement).

---

## Аспекти і тести, що їх стережуть

Правите один аспект — ганяєте один файл:

```bash
cd apps/api && npx vitest run src/modules/invoices/<файл>.spec.ts
```

**Модуль:** `apps/api/src/modules/invoices/`

| Аспект                                  | Тест                                       | Кейсів |
| --------------------------------------- | ------------------------------------------ | ------ |
| BullMQ-processor                        | `invoice-overdue.processor.spec.ts`        | 4      |
| HTTP-контракт (DTO, статуси, валідація) | `invoices.contract.spec.ts`                | 27     |
| create defaults (номер, invoiceType)    | `invoices.create-defaults.spec.ts`         | 5      |
| create from work order                  | `invoices.create-from-work-order.spec.ts`  | 5      |
| dto and linked docs                     | `invoices.dto-and-linked-docs.spec.ts`     | 8      |
| due date                                | `invoices.due-date.spec.ts`                | 7      |
| find by work order                      | `invoices.find-by-work-order.spec.ts`      | 5      |
| refresh from work order                 | `invoices.refresh-from-work-order.spec.ts` | 10     |
| transition settlements                  | `invoices.transition-settlements.spec.ts`  | 10     |

Разом: **81** кейсів (цифри з `vitest --reporter=json`, не з grep).

**Розходження з кодом.** Правила, де дос'є каже одне, а код робить інше. Агент цього не «лагодить»: рішення —
виправити код чи переписати правило — за людиною. Поки запис тут, гейт D правило не блокує,
але показує окремим рядком.

- **BR-INV-002** — дос'є: `POST /from-work-order/:id` переносить роботи й товари; код: `createFromWorkOrder` створює рахунок лише із сумою наряду, без рядків (`invoices.service.ts`, create). Рядки переносить тільки `refreshFromWorkOrder`.
- **BR-INV-008** — дос'є: `calcVatTotals()` рахує підсумки на фронті рахунку; код: `InvoiceCreateModal` і сторінка рахунків його не викликають — єдиний споживач `CreateWorkOrderModal`.
- **BR-INV-010** — дос'є: оплата дозволена лише для `SENT`/`PARTIALLY_PAID`; код приймає ще й `OVERDUE` (`payments.service.ts`), і BR-PAY-003 у `payments.md` каже так само. Два дос'є суперечать одне одному.
- **BR-INV-012** — дос'є: ручний перехід у PAID НЕ створює PAYMENT-settlement; код після Bug #675 створює дзеркальний PAYMENT для standalone-рахунку, і тест це стереже. Текст правила описує вже виправлений баг.

**Чого тут НЕМА.** Інваріантного спеку (`*.invariants.spec.ts`) немає, хоча агрегат на шляху грошей або статусів: властивості на кшталт «фінальний статус без виходів» не стережуться нічим. Свідома прогалина — кандидат на окремий крок.

Правила, які живуть у `PaymentsService` (модуль `payments`), а не тут — у спеках `invoices` тесту
на них немає й бути не може; мітку `guards:` на них у цьому модулі не ставимо:

- BR-INV-011 — «один платіж = один `PAYMENT`-settlement своєї суми» виконує `PaymentsService.create`;
  стереже `payments.money-model.spec.ts` («Bug #668: часткова оплата 200 → рівно 1
  PAYMENT-settlement на 200»), без мітки з цим ID.
- BR-INV-013 — резолв джерела платежу (DTO → дефолт `PaymentMethodConfig` → `null`) у
  `PaymentsService`; стереже `payments.money-model.spec.ts` (Bug #673, #674), без мітки з цим ID.
- BR-INV-014 — `resolveDestinationAccount` (явний невалідний → 4xx, stale-дефолт → `null`) у
  `PaymentsService`; стережуть `payments.money-model.spec.ts` (Bug #673) і
  `payments.idempotency.spec.ts` («config-дефолт … stale → degrade to null»), без мітки з цим ID.
- BR-INV-015 — «source-link — опційні метадані, борг від нього не залежить»: окремого тесту на
  незалежність settlement від джерела немає; найближче — `payments.money-model.spec.ts`
  («Bug #674: methodConfig=null → джерело null, платіж успішний»).
- BR-INV-016 — FK `ON DELETE SET NULL` на `Payment.bankAccountId`/`cashRegisterId`: властивість
  схеми БД, unit-тестом із моком Prisma не перевіряється; потрібен integration-тест на живій БД.

Web-половина правила про `invoiceType` (нормалізація значення поза enum-ом у `InvoiceCreateModal`
через `normalizeInvoiceType()`) тесту не має: функція не експортована, потрібен компонентний тест.

→ [docs/BUSINESS-RULES.md](../BUSINESS-RULES.md)
