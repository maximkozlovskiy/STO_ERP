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

| Модуль             | Controller prefix                                              | Ключові ендпоінти                                         |
| ------------------ | -------------------------------------------------------------- | --------------------------------------------------------- |
| `auth`             | `/api/auth`                                                    | login, refresh, logout                                    |
| `work-orders`      | `/api/work-orders`                                             | CRUD + `/transition` + `/clone` + `/parts` + `/lines`     |
| `calendar`         | `/api/calendar`                                                | `/slots`, `/slots/by-work-order/:id`, `/conflicts/check`  |
| `invoices`         | `/api/invoices`                                                | CRUD + `/transition` + `/lines`                           |
| `purchase-orders`  | `/api/purchase-orders`                                         | CRUD + `/transition` + `/receive` + `/apply-pricing`      |
| `stock-documents`  | `/api/stock-documents`                                         | CRUD + `/transition`                                      |
| `inventory`        | `/api/stock-items`, `/api/stock-movements`, `/api/goods`       | `/by-document`, `/by-batch`, `/stock-totals`              |
| `settlements`      | `/api/settlements`                                             | accounts, transactions, reconciliation-acts               |
| `crm`              | `/api/counterparties`                                          | CRUD + `/contracts` + `/contracts/:id/set-primary`        |
| `catalog`          | `/api/works`, `/api/goods`, `/api/services`                    | CRUD + barcodes, batches                                  |
| `employees`        | `/api/employees`                                               | CRUD                                                      |
| `pricing-rules`    | `/api/pricing-rules`                                           | CRUD + `/apply`                                           |
| `xlsx`             | `/api/xlsx`                                                    | `/import`, `/apply-pricing-from-list`, `/templates/:type` |
| `infrastructure`   | `/api/branches`, `/api/warehouses`, `/api/zones`, `/api/lifts` | CRUD                                                      |
| `settings`         | `/api/settings`                                                | `/organisation`, `/ui-features`                           |
| `user-preferences` | `/api/user-preferences`                                        | `GET/PUT /:key`                                           |
| `reports`          | `/api/reports`                                                 | dashboard, revenue, workload                              |
| `notifications`    | `/api/notifications`                                           | list, read                                                |
| `completion-acts`  | `/api/completion-acts`                                         | CRUD + PDF                                                |

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

### Ключові моделі

| Модель                  | Файл          | Примітка                                           |
| ----------------------- | ------------- | -------------------------------------------------- |
| `Organisation`          | schema.prisma | один тенант                                        |
| `GarageBranch`          | schema.prisma | філія СТО                                          |
| `Warehouse`             | schema.prisma | склад (MAIN/WORKSHOP/TIRE_HOTEL/MOBILE)            |
| `WorkOrder`             | schema.prisma | FSM: DRAFT→...→ARCHIVED                            |
| `CalendarSlot`          | schema.prisma | `parentSlotId` для split-day continuation          |
| `StockItem`             | schema.prisma | поточний залишок (агрегат)                         |
| `StockMovement`         | schema.prisma | append-only: RECEIPT/WRITEOFF/TRANSFER/RESERVATION |
| `StockBatch`            | schema.prisma | партії (FIFO/LIFO)                                 |
| `StockDocument`         | schema.prisma | FSM: DRAFT→CONFIRMED/CANCELLED                     |
| `Invoice`               | schema.prisma | FSM: DRAFT→SENT→PAID/CANCELLED                     |
| `PurchaseOrder`         | schema.prisma | FSM: DRAFT→ORDERED→PARTIAL→RECEIVED/CANCELLED      |
| `SettlementAccount`     | schema.prisma | balance per counterparty                           |
| `SettlementTransaction` | schema.prisma | append-only                                        |
| `ReconciliationAct`     | schema.prisma | `@@index([orgId, counterpartyId, createdAt])`      |
| `PricingRule`           | schema.prisma | з `PricingRuleTier` (cascade delete)               |
| `UserPreference`        | schema.prisma | `{ key, value: Json }` per (orgId, employeeId)     |
| `CounterpartyContract`  | schema.prisma | PURCHASE/SALE, `isPrimary`                         |

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

## Cloud Sync (опціонально)

Outbox Pattern → Sync Hub. Не залежність — система повністю офлайн-ready без нього.

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
