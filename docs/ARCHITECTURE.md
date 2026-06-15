# ARCHITECTURE — STO ERP

> Де що живе, API модулі, Prisma моделі, ключові утиліти.
> Оновлюється при доданні нових модулів/моделей.

---

## Monorepo

```
sto-erp/
├── apps/
│   ├── api/         NestJS 10 + Fastify      :3000
│   ├── web/         Next.js 15 static export  :3001 (dev) / :80 (prod)
│   └── mobile/      Expo SDK 53 + RN
├── packages/
│   ├── database/    Prisma 5 + PostgreSQL 16
│   ├── shared/      TypeScript types, Zod schemas, constants (STOCK_DOC_TYPE_LABELS etc.)
│   ├── ui/          shadcn/ui базові компоненти
│   └── config/      ESLint, TSConfig, Vitest
└── installer/       Inno Setup + PowerShell
```

---

## API Модулі (`apps/api/src/modules/`)

| Модуль             | Controller prefix                                              | Ключові ендпоінти                                             |
| ------------------ | -------------------------------------------------------------- | ------------------------------------------------------------- |
| `auth`             | `/api/auth`                                                    | login, refresh, logout                                        |
| `work-orders`      | `/api/work-orders`                                             | CRUD + `/transition` + `/clone` + `/parts` + `/lines`         |
| `calendar`         | `/api/calendar`                                                | `/slots`, `/slots/by-work-order/:id`, `/conflicts/check`      |
| `invoices`         | `/api/invoices`                                                | CRUD + `/transition` + `/lines`                               |
| `purchase-orders`  | `/api/purchase-orders`                                         | CRUD + `/transition` + `/receive` + `/apply-pricing`          |
| `stock-documents`  | `/api/stock-documents`                                         | CRUD + `/transition`                                          |
| `inventory`        | `/api/stock-items`, `/api/stock-movements`, `/api/goods`       | `/by-document`, `/by-batch`, `/stock-totals`                  |
| `settlements`      | `/api/settlements`                                             | accounts, transactions, reconciliation-acts                   |
| `crm`              | `/api/counterparties`                                          | CRUD + `/contracts` + `/contracts/:id/set-primary`            |
| `catalog`          | `/api/works`, `/api/goods`, `/api/services`                    | CRUD + barcodes, batches                                      |
| `employees`        | `/api/employees`                                               | CRUD                                                          |
| `pricing-rules`    | `/api/pricing-rules`                                           | CRUD + `/apply`                                               |
| `xlsx`             | `/api/xlsx`                                                    | `/import`, `/apply-pricing-from-list`, `/templates/:type`     |
| `infrastructure`   | `/api/branches`, `/api/warehouses`, `/api/zones`, `/api/lifts` | CRUD                                                          |
| `settings`         | `/api/settings`                                                | `/organisation`, `/ui-features`                               |
| `user-preferences` | `/api/user-preferences`                                        | `GET/PUT /:key`                                               |
| `reports`          | `/api/reports`                                                 | dashboard, revenue, workload                                  |
| `notifications`    | `/api/notifications`                                           | list, read                                                    |
| `completion-acts`  | `/api/completion-acts`                                         | CRUD + PDF                                                    |
| `vehicles`         | `/api/vehicles`                                                | CRUD + vehicleNodes sub-resource                              |
| `payment-methods`  | `/api/payment-methods`                                         | CRUD довідника способів оплати                                |
| `payments`         | `/api/payments`                                                | create → `SettlementsService.createTransaction(PAYMENT)`      |
| `services`         | `/api/services`                                                | CRUD пакетів послуг (Work+Good bundle)                        |
| `work-categories`  | `/api/work-categories`                                         | CRUD ієрархії категорій                                       |
| `zones`            | `/api/zones`                                                   | CRUD + lifts sub-resource                                     |
| `document-number`  | (internal)                                                     | `next(orgId, type)` → генерує номер по `DocumentNumberConfig` |
| `files`            | `/api/files`                                                   | upload/download через MinIO                                   |
| `setup`            | `/api/setup`                                                   | `POST /setup` — перший запуск, seed org+admin                 |
| `sync`             | `/api/sync`                                                    | `pull(since)` + `push(records)` + `getStatus()`               |

### Singleton сервіси (critical, одна точка мутації)

| Сервіс                       | Метод                 | Мутує                        |
| ---------------------------- | --------------------- | ---------------------------- |
| `inventory.service.ts`       | `createMovement()`    | StockItem залишки            |
| `settlements.service.ts`     | `createTransaction()` | SettlementAccount баланс     |
| `document-number.service.ts` | `next(orgId, type)`   | DocumentNumberConfig counter |

---

## Fastify route ordering — CRITICAL

Специфічний sub-route ПЕРЕД параметричним `:id`:

```typescript
// ✅ Правильно
@Patch(':id/toggle-active')   // ПЕРШИЙ
@Get(':id/linked')            // ПЕРШИЙ
@Get(':id')                   // після
@Patch(':id')                 // після
@Delete(':id')                // після
```

---

## Prisma моделі та міграції

### Обов'язкові поля кожної таблиці

```prisma
id          String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
orgId       String    @db.Uuid
createdAt   DateTime  @default(now())
updatedAt   DateTime  @updatedAt
deletedAt   DateTime?
syncVersion BigInt    @default(0)
```

### Всі 41 модель

**Infrastructure:** `Organisation`, `GarageBranch`, `Zone`, `Lift`, `Warehouse`, `BranchSettings`, `OrganisationSettings`, `DocumentNumberConfig`, `TaxRate`, `PaymentMethodConfig`, `NotificationTemplate`

**Auth:** `AuthAccount`

**CRM:** `Counterparty`, `CustomerGarage`, `Vehicle`, `VehicleNode`

**Catalog:** `WorkCategory`, `Work`, `Good`, `Service`, `ServiceWork`, `ServiceGood`

**Employees:** `Employee`, `EmployeeZone`, `EmployeeLift`, `EmployeeWorkCategory`

**Work Orders:** `WorkOrder`, `WorkOrderLine`, `WorkOrderLineEmployee`, `WorkOrderPart`

**Inventory:** `StockItem`, `StockMovement`, `StockDocument`, `StockDocumentLine`, `PurchaseOrder`, `PurchaseOrderLine`, `StockBatch`

**Finance:** `Invoice`, `Payment`, `SettlementAccount`, `SettlementTransaction`, `ReconciliationAct`

**Scheduling:** `CalendarSlot`

**Sync:** `SyncJob`

**Other:** `UserPreference`, `CounterpartyContract`, `PricingRule`, `PricingRuleTier`

### Примітки щодо ключових моделей

| Модель                  | Примітка                                              |
| ----------------------- | ----------------------------------------------------- |
| `WorkOrder`             | FSM: DRAFT→ESTIMATE→APPROVED→IN_PROGRESS→...→ARCHIVED |
| `CalendarSlot`          | `parentSlotId` для split-day continuation             |
| `StockItem`             | поточний залишок (агрегат)                            |
| `StockMovement`         | append-only: RECEIPT/WRITEOFF/TRANSFER/RESERVATION    |
| `StockDocument`         | FSM: DRAFT→CONFIRMED/CANCELLED                        |
| `Invoice`               | FSM: DRAFT→SENT→PAID/CANCELLED                        |
| `PurchaseOrder`         | FSM: DRAFT→ORDERED→PARTIAL→RECEIVED/CANCELLED         |
| `SettlementTransaction` | append-only (немає `deletedAt`)                       |
| `SettlementAccount`     | balance per counterparty (немає `deletedAt`)          |
| `ReconciliationAct`     | `@@index([orgId, counterpartyId, createdAt])`         |
| `PricingRule`           | з `PricingRuleTier` (cascade delete)                  |
| `UserPreference`        | `{ key, value: Json }` per (orgId, employeeId)        |
| `CounterpartyContract`  | PURCHASE/SALE, `isPrimary`                            |

### Моделі БЕЗ `deletedAt` (soft delete не застосовується)

`SettlementAccount`, `SettlementTransaction`, `StockMovement`, `Payment`, `WorkOrderLineEmployee`

### Активні міграції

| Файл                                                 | Зміст                                                 |
| ---------------------------------------------------- | ----------------------------------------------------- |
| `20260526124850_...`                                 | StockDocumentType.RECEIPT, DocumentType.STOCK_RECEIPT |
| `20260530100000_add_pricing_brand_cost_tier`         | PricingRuleTier + brandId + COST_TIER                 |
| `20260530200000_add_user_preferences`                | UserPreference                                        |
| `20260610120000_add_work_order_planned_actual_hours` | plannedHours, actualHours на WorkOrder                |

---

## Shared Constants (`packages/shared/src/constants/`)

`statuses.ts` — єдине джерело правди для всіх labels/badges/transitions:

| Константа                                    | Використання                                       |
| -------------------------------------------- | -------------------------------------------------- |
| `STOCK_DOC_TYPE_LABELS`                      | `{ WRITEOFF, TRANSFER, OPENING_BALANCE, RECEIPT }` |
| `STOCK_DOC_TYPE_BADGE`                       | badge variants                                     |
| `STOCK_DOC_STATUS_LABELS/BADGE/TRANSITIONS`  |                                                    |
| `WO_STATUS_LABELS/BADGE/TRANSITIONS`         |                                                    |
| `WO_EDITABLE/SHAREABLE/INVOICEABLE_STATUSES` | `readonly string[]` (Object.freeze)                |
| `PO_STATUS_LABELS/BADGE/TRANSITIONS`         |                                                    |
| `INVOICE_STATUS_LABELS/BADGE/TRANSITIONS`    |                                                    |

---

## Утиліти (`apps/api/src/common/utils/`)

| Файл            | Експортує                                           |
| --------------- | --------------------------------------------------- |
| `array.ts`      | `deduplicateBy<T>(arr, key)` — Map last-wins dedup  |
| `fsm.ts`        | `assertFsmTransition(current, next, transitionMap)` |
| `math.ts`       | розрахунки цін, ПДВ                                 |
| `pagination.ts` | paginatedResponse                                   |
| `url-guard.ts`  | UUID validation                                     |

## Утиліти (`apps/web/src/lib/`)

| Файл            | Експортує                                                   |
| --------------- | ----------------------------------------------------------- |
| `utils.ts`      | `toIdMap<T extends {id}>`, `calcVatTotals`, `cn`            |
| `api-client.ts` | `apiFetch`, `apiMultipartFetch`                             |
| `ref-cache.ts`  | `getCached`, `setCache` (sessionStorage, TTL)               |
| `format.ts`     | `formatCurrency`, `formatDate`, `kyivToday`, `kyivOffsetMs` |
| `toast.ts`      | `toast.success/error/warning/info`                          |

---

## Cloud Sync / sync.service.ts (опціонально)

Outbox Pattern → Sync Hub. Не залежність — система повністю офлайн-ready без нього.

- **Pull tables** (read-only для клієнта): `work_orders`, `work_order_lines`, `work_order_parts`, `counterparties`, `vehicles`, `customer_garages`, `stock_items`, `invoices`, `payments`, `calendar_slots`
- **Push-safe tables**: `counterparties`, `vehicles`, `customer_garages`, `calendar_slots`
- **Pull blacklist**: `counterparties → phone, edrpou, email` (не відправляти на мобільний)
- **Push whitelist**: по таблиці — тільки дозволені поля проходять
- **Delta-sync**: `WHERE orgId = ? AND syncVersion > ?`
- **FK validation при push**: `liftId`, `employeeId`, `workOrderId` → перевірка по `orgId`

---

## Розгортання

```
STO-ERP-Setup.exe → Docker Compose stack:
  api      :3000  (NestJS)
  web      :80    (Next.js static)
  postgres :5432
  redis    :6379
  minio    :9000
  caddy    :80/443
```
