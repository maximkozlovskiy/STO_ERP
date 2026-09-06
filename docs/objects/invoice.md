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
  documentDate    DateTime      @default(now()) @db.Date
  syncVersion     BigInt        @default(0)
  createdAt       DateTime      @default(now())
  updatedAt       DateTime      @updatedAt
  deletedAt       DateTime?
}
```

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

## Бізнес-правила

- Номер авто-генерується: `DocumentNumberService.next(orgId, 'INVOICE')`
- Рахунок з наряду: `POST /from-work-order/:id` автоматично переносить роботи і товари з WO
- `dueDate` контролюється `invoiceDueDays` з `SettingsService.get(orgId)` — не хардкодиться
- `OVERDUE` встановлюється автоматично (scheduler або при відкритті списку)
- При оплаті → `SettlementsService.createTransaction(PAYMENT)` (не пряма зміна балансу)
- `InvoiceLine`: кожен рядок має `vatRate`, `priceWithoutVat`, `vatAmount`, `priceWithVat`
- `calcVatTotals()` з `apps/web/src/lib/utils.ts` — для розрахунку підсумків на фронті

### Часткова оплата (модель грошей, Фаза 1)

- `paidAmount` — **авторитетна колонка** сплаченого. Оновлюється транзакційно при кожному
  платежі. `toDto` читає її; фолбек на `sum(payments)` лише коли колонки немає у вибірці.
- **Оплата** (`PaymentsService.create` з `invoiceId`): дозволена лише для `SENT`/`PARTIALLY_PAID`;
  переплата (`amount > amount − paidAmount`) → 400. Атомарно: **CAS** `updateMany({ where:
paidAmount = прочитане }, data: paidAmount += amount, status: newPaid>=amount ? PAID :
PARTIALLY_PAID)`. `count=0` (гонка паралельного платежу) → throw → rollback усього
  (Payment + PAYMENT-settlement) у тій самій `$transaction`. **FIN-C1 інваріант** — під
  ReadCommitted захищає оптимістичний CAS по `paidAmount`, не рівень ізоляції.
- **Ledger:** кожен частковий платіж створює один `PAYMENT`-settlement своєї суми
  (`BALANCE_SIGN[PAYMENT] = −1`) → борг зменшується рівно на суму кожного платежу; подвійного
  списання немає.
- **Ручний PAID** (`transition` → `PAID`): синхронізує `paidAmount = amount` (щоб «залишок» був 0),
  але **НЕ створює** `Payment`/`PAYMENT`-settlement. Це статус-узгодження, не рух грошей.
  ⚠️ Наслідок: для **standalone**-рахунку (CHARGE нараховано при `SENT`) ручний PAID лишає
  CHARGE без offset-PAYMENT у settlement-ledger → баланс контрагента покаже борг попри «PAID»
  статус рахунку. Правильний шлях повного погашення — реєстрація платежу (кнопка «Оплатити»),
  не ручний FSM-перехід. Ручний PAID призначений для WO-рахунків (CHARGE вже net при COMPLETED)
  або як адмін-корекція.

### Рахунок-призначення платежу (`Payment.sourceType`)

- `Payment` знає, **куди фізично лягли гроші**: `sourceType` (`BANK_ACCOUNT`/`CASH_REGISTER`) +
  `bankAccountId`/`cashRegisterId`. Джерело: DTO явно → інакше дефолт з `PaymentMethodConfig`
  (`defaultSourceType`/`defaultBankAccountId`/`defaultCashRegisterId`) → інакше `null`.
- Валідація (`resolveDestinationAccount`): рахунок мусить бути в межах org (не крос-tenant) і живий.
  **Явний** з DTO невалідний рахунок → 4xx; **дефолт з config** що з тих пір видалено (stale) →
  тихо `null` (offline-first: не валимо легітимний платіж через застарілий конфіг).
- Source-link — **опційна метадані**; борг/settlement від нього не залежать (два різні виміри).
- FK `ON DELETE SET NULL` (рахунки нормально soft-delete-яться; hard-delete лишає Payment з
  `null`-source, зберігаючи суму й settlement).

→ [docs/BUSINESS-RULES.md](../BUSINESS-RULES.md)
