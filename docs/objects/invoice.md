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
DRAFT → SENT → PAID
      ↘ CANCELLED  ↘ CANCELLED
OVERDUE → PAID / CANCELLED
```

| Статус      | Значення                      |
| ----------- | ----------------------------- |
| `DRAFT`     | Чернетка, редагується         |
| `SENT`      | Надіслано клієнту             |
| `PAID`      | Оплачено                      |
| `OVERDUE`   | Прострочено (dueDate < today) |
| `CANCELLED` | Скасовано                     |

**FSM файл:** `apps/api/src/modules/invoices/invoices.service.ts`

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

→ [docs/BUSINESS-RULES.md](../BUSINESS-RULES.md)
