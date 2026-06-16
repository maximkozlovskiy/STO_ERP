# WorkOrder — Dossier

> Основний агрегат STO ERP. Наряд на ремонт авто.

---

## Prisma модель

```prisma
model WorkOrder {
  id               String           @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId            String           @db.Uuid
  number           String           // авто-генерується DocumentNumberService.next()
  status           WorkOrderStatus  @default(DRAFT)
  priority         WorkOrderPriority @default(NORMAL)
  vehicleId        String?          @db.Uuid
  counterpartyId   String?          @db.Uuid
  branchId         String           @db.Uuid
  liftId           String?          @db.Uuid
  plannedHours     Decimal?         @db.Decimal(8,2)
  actualHours      Decimal?         @db.Decimal(8,2)
  description      String?
  completedAt      DateTime?
  createdAt        DateTime         @default(now())
  updatedAt        DateTime         @updatedAt
  deletedAt        DateTime?
  syncVersion      BigInt           @default(0)

  lines            WorkOrderLine[]
  parts            WorkOrderPart[]
  calendarSlots    CalendarSlot[]
  invoices         Invoice[]
}
```

**Відносини:**

- → `Vehicle` (M:1 через `vehicleId`, optional)
- → `Counterparty` (M:1 через `counterpartyId`, optional)
- → `GarageBranch` (M:1 через `branchId`)
- → `Lift` (M:1 через `liftId`, optional)
- ← `WorkOrderLine[]` (роботи)
- ← `WorkOrderPart[]` (запчастини)
- ← `CalendarSlot[]` (слоти календаря)
- ← `Invoice[]` (рахунки)

---

## FSM

```
DRAFT → ESTIMATE → APPROVED → IN_PROGRESS → ON_HOLD
                 ↘ CANCELLED    ↘ CANCELLED    ↘ CANCELLED
                                               ↓
                                         IN_PROGRESS ← (ON_HOLD)
                                               ↓
                                          COMPLETED → INVOICED → PAID → ARCHIVED
                                         ↘ CANCELLED  ↘ CANCELLED
```

Файл FSM: `apps/api/src/modules/work-orders/work-orders.fsm.ts`

| Перехід                     | Side-effects (у `$transaction`)                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------- |
| → `IN_PROGRESS`             | `InventoryService.createMovement(RESERVATION)` для кожної запчастини (sequential for-loop)        |
| → `COMPLETED`               | RESERVATION_RELEASE → WRITEOFF → `SettlementsService.createTransaction(CHARGE)` (у цьому порядку) |
| → `CANCELLED` з IN_PROGRESS | `InventoryService.createMovement(RESERVATION_RELEASE)` для кожної запчастини                      |
| → `CANCELLED` з ON_HOLD     | `InventoryService.createMovement(RESERVATION_RELEASE)` для кожної запчастини                      |

### Константи (з `@sto/shared`)

```typescript
WO_EDITABLE_STATUSES = ['DRAFT', 'ESTIMATE', 'APPROVED'] as readonly WorkOrderStatus[];
WO_SHAREABLE_STATUSES = ['DRAFT', 'ESTIMATE', 'APPROVED'] as readonly WorkOrderStatus[];
WO_INVOICEABLE_STATUSES = ['COMPLETED', 'INVOICED'] as readonly WorkOrderStatus[];
WO_DELETABLE_STATUSES = ['DRAFT', 'CANCELLED'] as readonly WorkOrderStatus[];
```

---

## API Endpoints (`/api/work-orders`)

| Метод  | URL                               | Дія                                               |
| ------ | --------------------------------- | ------------------------------------------------- |
| POST   | `/api/work-orders`                | Створити наряд (lines у body)                     |
| GET    | `/api/work-orders`                | Список (фільтри: status, branchId, q, date range) |
| GET    | `/api/work-orders/:id`            | Деталь з lines + parts                            |
| PATCH  | `/api/work-orders/:id`            | Оновити (WO_EDITABLE_STATUSES)                    |
| POST   | `/api/work-orders/:id/transition` | FSM перехід                                       |
| POST   | `/api/work-orders/:id/clone`      | Клонувати наряд                                   |
| POST   | `/api/work-orders/:id/share`      | Поширити кошторис                                 |
| GET    | `/api/work-orders/:id/parts`      | Запчастини наряду                                 |
| POST   | `/api/work-orders/:id/parts`      | Додати запчастину                                 |
| PATCH  | `/api/work-orders/:id/parts/:pId` | Оновити запчастину                                |
| DELETE | `/api/work-orders/:id/parts/:pId` | Видалити запчастину                               |
| GET    | `/api/work-orders/:id/lines`      | Роботи наряду                                     |
| DELETE | `/api/work-orders/:id`            | Soft-delete (тільки WO_DELETABLE_STATUSES)        |

---

## UI (Web)

| Компонент / сторінка          | Файл                                             |
| ----------------------------- | ------------------------------------------------ |
| Список                        | `app/(app)/work-orders/page.tsx`                 |
| Деталь (картка)               | `app/(app)/work-orders/[id]/PageClient.tsx`      |
| Модалка створення/редагування | `components/ui/CreateWorkOrderModal.tsx`         |
| Detail Panel schema           | `lib/panel-schema.ts` → `WO_PANEL_SCHEMA`        |
| FSM кнопки                    | `components/ui/fsm-buttons.tsx` → `<FSMButtons>` |

**Картка наряду — секції (PageClient.tsx, у порядку рендеру):**

1. Заголовок + статус-бейдж + FSM кнопки
2. Метадані (клієнт, авто, склад, відповідальний)
3. Підсумки (плановані/фактичні години, сума, оплачено)
4. **Акт виконаних робіт** (`WO_INVOICEABLE_STATUSES` гейт)
5. **Рахунок** (`WO_INVOICEABLE_STATUSES` гейт + `invoiceRef !== undefined`) — використовує `INVOICE_STATUS_LABELS` з `@sto/shared`; `InvoiceRef` interface = `{ id, number, status: InvoiceStatus, amount, documentDate }`. Endpoint `/invoices/from-work-order/:id/find` для preload + `POST /invoices/from-work-order/:id` (create) + `/refresh` (DRAFT only) + `/pdf` (download)
6. Роботи (`WorkOrderLinesSection`)
7. Запчастини (`WorkOrderPartsSection`)
8. Огляд авто
9. Медіа
10. Audit log
11. Коментарі

---

## Бізнес-правила

- FSM: тільки через `WORK_ORDER_TRANSITIONS` map — ніколи прямий `update({ status })`
- RESERVATION → RELEASE → WRITEOFF порядок обов'язковий (guard `available >= qty`)
- WO parts loops — **sequential** for-loop (shared StockItem composite key — unsafe to parallelize)
- Номер авто-генерується: `DocumentNumberService.next(orgId, 'WorkOrder')`
- `plannedHours` / `actualHours` — Decimal(8,2), nullable

→ Детально у [docs/BUSINESS-RULES.md](../BUSINESS-RULES.md)
