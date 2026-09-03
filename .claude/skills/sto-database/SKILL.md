---
name: sto-database
description: >
  Create or modify Prisma schema, generate migrations, and write seed data for STO ERP. Use when the user says "зміни схему", "додай таблицю", "нова модель", "міграція", "prisma", or when a feature requires DB changes. Always run this BEFORE sto-backend. Handles full DB layer: schema design, migrations, indexes, seed data.
model: claude-sonnet-5
bypassPermissions: true
---

# sto-database — Prisma Schema Skill

## Before Starting

1. Read `MemoryManual.md` — current project state, gotchas, last migration
2. **Identify the aggregate** being touched → read its `docs/objects/<entity>.md` dossier — existing Prisma model, relations, indexes, business rules
3. Read `docs/BUSINESS-RULES.md` — FSM rules, append-only tables (StockMovement, SettlementTransaction have NO deletedAt), soft-delete rules
4. Read `packages/database/schema.prisma` — know current state
5. Identify which Bounded Context you're modifying

**Aggregate → dossier lookup:**
`WorkOrder→work-order.md` | `Invoice→invoice.md` | `PurchaseOrder→purchase-order.md` | `StockDocument→stock-document.md` | `Counterparty→counterparty.md` | `Good→good.md` | `Work/WorkCategory→work.md` | `CalendarSlot→calendar.md` | `StockItem/StockMovement→inventory.md` | `SettlementAccount/Transaction→settlements.md`

**Red flags from dossiers to check before migrating:**

- Models without `deletedAt`: SettlementAccount, SettlementTransaction, StockMovement, Payment, WorkOrderLineEmployee — never add soft-delete to these
- GIN trgm indexes (Good.name/sku, Counterparty.firstName/lastName) are manual migrations — do NOT add to schema.prisma

---

## Mandatory Field Pattern (every model)

```prisma
model WorkOrder {
  id          String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId       String    @db.Uuid
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt
  deletedAt   DateTime?
  syncVersion BigInt    @default(0)

  // ... domain fields

  org         Organisation @relation(fields: [orgId], references: [id])

  @@index([orgId, deletedAt])
  @@index([orgId, syncVersion])  // for delta-sync queries
  @@map("work_orders")
}
```

---

## Naming Conventions

```prisma
// Models: PascalCase → tables: snake_case via @@map
// Fields: camelCase → columns: snake_case via @map
// FKs: parentModelId (e.g., orgId, workOrderId)
// Soft delete: deletedAt DateTime?
// Enums: SCREAMING_SNAKE_CASE values
```

---

## Core Schema Template

```prisma
// packages/database/schema.prisma

generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// ─── ENUMS ───────────────────────────────────────────────

enum UserRole {
  OWNER
  ADMIN
  RECEPTIONIST
  MECHANIC
  STOREKEEPER
  ACCOUNTANT
  CLIENT
}

enum WorkOrderStatus {
  DRAFT
  ESTIMATE
  APPROVED
  IN_PROGRESS
  ON_HOLD
  COMPLETED
  INVOICED
  PAID
  ARCHIVED
  CANCELLED
}

enum ZoneType {
  MECHANICAL
  BODY
  TIRE
  WASH
  ELECTRICAL
  OTHER
}

enum LiftType {
  TWO_POST
  FOUR_POST
  ALIGNMENT
  STENCIL
  STAND
  OTHER
}

enum WarehouseType {
  MAIN
  WORKSHOP
  TIRE_HOTEL
  MOBILE
}

enum CounterpartyType {
  CLIENT
  SUPPLIER
  BOTH
}

enum StockMovementType {
  RECEIPT
  WRITEOFF
  TRANSFER
  RESERVATION
  RESERVATION_RELEASE
  OPENING_BALANCE      // Введення початкових залишків через StockDocument
}

enum StockDocumentType {
  WRITEOFF             // Списання ТМЦ
  TRANSFER             // Переміщення між складами
  OPENING_BALANCE      // Введення початкових залишків
}

enum StockDocumentStatus {
  DRAFT
  CONFIRMED            // Підтверджено → створює StockMovement записи
  CANCELLED
}

enum DocumentType {
  WORK_ORDER
  INVOICE
  PURCHASE_ORDER
  STOCK_RECEIPT        // Прихід від постачальника (PurchaseOrder)
  STOCK_WRITEOFF       // Списання (StockDocument type=WRITEOFF)
  STOCK_TRANSFER       // Переміщення (StockDocument type=TRANSFER)
  STOCK_OPENING        // Початкові залишки (StockDocument type=OPENING_BALANCE)
  RECONCILIATION_ACT
}

enum ResetPeriod {
  NEVER
  YEARLY
  MONTHLY
}

enum VatMode {
  NONE             // Без ПДВ
  EXCLUSIVE        // ПДВ зверху (ціна без ПДВ + ПДВ = кінцева)
  INCLUSIVE        // ПДВ включено в ціну
}

enum NotificationEventType {
  WO_CREATED
  WO_ESTIMATE_READY
  WO_APPROVED
  WO_IN_PROGRESS
  WO_COMPLETED
  WO_READY_FOR_PICKUP
  PAYMENT_RECEIVED
  INVOICE_SENT
  LOW_STOCK_ALERT
}

enum NotificationChannel {
  SMS
  VIBER
  EMAIL
}

enum SettlementTransactionType {
  CHARGE
  PAYMENT
  REFUND
  PREPAYMENT
  CREDIT_NOTE
}

// PaymentMethod — довідник способів оплати, керується через UI (не enum!)
// Зберігається як string у Payment.method, налаштовується в PaymentMethodConfig per org
// Стандартні значення при ініціалізації: cash, card_terminal, bank_transfer, privat24_qr, monobank_qr

// ─── INFRASTRUCTURE ──────────────────────────────────────

model Organisation {
  id          String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId       String    @db.Uuid  // self-reference for consistency
  name        String
  edrpou      String?   @unique
  syncVersion BigInt    @default(0)
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt
  deletedAt   DateTime?

  branches              GarageBranch[]
  employees             Employee[]
  counterparties        Counterparty[]
  documentNumberConfigs DocumentNumberConfig[]
  settings              OrganisationSettings?
  notificationTemplates NotificationTemplate[]
  taxRates              TaxRate[]
  paymentMethods        PaymentMethodConfig[]

  @@map("organisations")
}

model GarageBranch {
  id          String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId       String    @db.Uuid
  name        String
  address     String
  timezone    String    @default("Europe/Kyiv")
  syncVersion BigInt    @default(0)
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt
  deletedAt   DateTime?

  org         Organisation  @relation(fields: [orgId], references: [id])
  zones       Zone[]
  warehouses  Warehouse[]

  @@index([orgId, deletedAt])
  @@map("garage_branches")
}

model Zone {
  id          String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId       String    @db.Uuid
  branchId    String    @db.Uuid
  name        String
  type        ZoneType
  syncVersion BigInt    @default(0)
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt
  deletedAt   DateTime?

  branch      GarageBranch        @relation(fields: [branchId], references: [id])
  lifts       Lift[]
  employeeZones EmployeeZone[]

  @@index([orgId, deletedAt])
  @@map("zones")
}

model Lift {
  id           String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId        String    @db.Uuid
  zoneId       String    @db.Uuid
  name         String
  type         LiftType
  maxWeightKg  Int?
  syncVersion  BigInt    @default(0)
  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt
  deletedAt    DateTime?

  zone         Zone          @relation(fields: [zoneId], references: [id])
  employeeLifts EmployeeLift[]
  calendarSlots CalendarSlot[]
  workOrderLines WorkOrderLine[]

  @@index([orgId, deletedAt])
  @@map("lifts")
}

model Warehouse {
  id          String        @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId       String        @db.Uuid
  branchId    String        @db.Uuid
  name        String
  type        WarehouseType @default(MAIN)
  syncVersion BigInt        @default(0)
  createdAt   DateTime      @default(now())
  updatedAt   DateTime      @updatedAt
  deletedAt   DateTime?

  branch      GarageBranch  @relation(fields: [branchId], references: [id])
  stockItems  StockItem[]
  movements   StockMovement[]

  @@index([orgId, deletedAt])
  @@map("warehouses")
}

// ─── EMPLOYEES ───────────────────────────────────────────

model Employee {
  id          String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId       String    @db.Uuid
  userId      String?   @db.Uuid  // linked auth user
  firstName   String
  lastName    String
  role        UserRole
  rateScheme  Json      // { type: 'percent_normo' | 'fixed_plus_bonus', params: {...} }
  syncVersion BigInt    @default(0)
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt
  deletedAt   DateTime?

  org                    Organisation @relation(fields: [orgId], references: [id])
  employeeZones          EmployeeZone[]
  employeeLifts          EmployeeLift[]
  employeeWorkCategories EmployeeWorkCategory[]
  workOrderLines         WorkOrderLine[]
  workOrderLineAssists   WorkOrderLineEmployee[]

  @@index([orgId, deletedAt])
  @@map("employees")
}

// Junction tables for M:M
model EmployeeZone {
  employeeId  String  @db.Uuid
  zoneId      String  @db.Uuid
  employee    Employee @relation(fields: [employeeId], references: [id])
  zone        Zone     @relation(fields: [zoneId], references: [id])
  @@id([employeeId, zoneId])
  @@map("employee_zones")
}

model EmployeeLift {
  employeeId  String  @db.Uuid
  liftId      String  @db.Uuid
  employee    Employee @relation(fields: [employeeId], references: [id])
  lift        Lift     @relation(fields: [liftId], references: [id])
  @@id([employeeId, liftId])
  @@map("employee_lifts")
}

model EmployeeWorkCategory {
  employeeId      String       @db.Uuid
  workCategoryId  String       @db.Uuid
  employee        Employee     @relation(fields: [employeeId], references: [id])
  workCategory    WorkCategory @relation(fields: [workCategoryId], references: [id])
  @@id([employeeId, workCategoryId])
  @@map("employee_work_categories")
}

// ─── CRM ─────────────────────────────────────────────────

model Counterparty {
  id          String           @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId       String           @db.Uuid
  type        CounterpartyType
  firstName   String?
  lastName    String?
  companyName String?
  edrpou      String?
  vatPayer    Boolean          @default(false)
  phone       String?
  email       String?
  notes       String?
  syncVersion BigInt           @default(0)
  createdAt   DateTime         @default(now())
  updatedAt   DateTime         @updatedAt
  deletedAt   DateTime?

  org               Organisation       @relation(fields: [orgId], references: [id])
  customerGarages   CustomerGarage[]
  settlementAccount SettlementAccount?
  purchaseOrders    PurchaseOrder[]
  invoices          Invoice[]

  @@index([orgId, type, deletedAt])
  @@map("counterparties")
}

model CustomerGarage {
  id             String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId          String    @db.Uuid
  counterpartyId String    @db.Uuid
  name           String
  address        String?
  notes          String?
  syncVersion    BigInt    @default(0)
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt
  deletedAt      DateTime?

  counterparty   Counterparty @relation(fields: [counterpartyId], references: [id])
  vehicles       Vehicle[]

  @@index([orgId, deletedAt])
  @@map("customer_garages")
}

model Vehicle {
  id              String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId           String    @db.Uuid
  customerGarageId String   @db.Uuid
  vin             String?
  licensePlate    String?
  make            String
  model           String
  year            Int?
  engineVolume    Float?
  fuelType        String?
  currentMileage  Int?
  color           String?
  notes           String?
  syncVersion     BigInt    @default(0)
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt
  deletedAt       DateTime?

  customerGarage  CustomerGarage @relation(fields: [customerGarageId], references: [id])
  vehicleNodes    VehicleNode[]
  workOrders      WorkOrder[]

  @@index([orgId, deletedAt])
  @@index([orgId, vin])
  @@map("vehicles")
}

model VehicleNode {
  id          String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId       String    @db.Uuid
  vehicleId   String    @db.Uuid
  category    String    // engine, gearbox, suspension, electrical, AC, body
  name        String
  mileageAtInstall Int?
  notes       String?
  syncVersion BigInt    @default(0)
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt
  deletedAt   DateTime?

  vehicle     Vehicle   @relation(fields: [vehicleId], references: [id])

  @@index([orgId, vehicleId, deletedAt])
  @@map("vehicle_nodes")
}

// ─── SERVICE CATALOG ─────────────────────────────────────

model WorkCategory {
  id          String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId       String    @db.Uuid
  parentId    String?   @db.Uuid
  name        String
  icon        String?
  sortOrder   Int       @default(0)
  syncVersion BigInt    @default(0)
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt
  deletedAt   DateTime?

  parent      WorkCategory?  @relation("CategoryHierarchy", fields: [parentId], references: [id])
  children    WorkCategory[] @relation("CategoryHierarchy")
  works       Work[]
  employeeWorkCategories EmployeeWorkCategory[]

  @@index([orgId, deletedAt])
  @@map("work_categories")
}

model Work {
  id             String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId          String    @db.Uuid
  categoryId     String    @db.Uuid
  name           String
  normoHours     Float
  price          Decimal   @db.Decimal(12, 2)
  description    String?
  syncVersion    BigInt    @default(0)
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt
  deletedAt      DateTime?

  category       WorkCategory @relation(fields: [categoryId], references: [id])
  serviceWorks   ServiceWork[]

  @@index([orgId, deletedAt])
  @@map("works")
}

model Good {
  id             String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId          String    @db.Uuid
  sku            String?
  name           String
  unit           String    @default("шт")
  purchasePrice  Decimal?  @db.Decimal(12, 2)
  salePrice      Decimal   @db.Decimal(12, 2)
  category       String?
  barcode        String?
  notes          String?
  syncVersion    BigInt    @default(0)
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt
  deletedAt      DateTime?

  stockItems     StockItem[]
  serviceGoods   ServiceGood[]

  @@index([orgId, deletedAt])
  @@index([orgId, sku])
  @@map("goods")
}

model Service {
  id          String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId       String    @db.Uuid
  name        String
  description String?
  price       Decimal?  @db.Decimal(12, 2)  // null = calculated from lines
  syncVersion BigInt    @default(0)
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt
  deletedAt   DateTime?

  serviceWorks ServiceWork[]
  serviceGoods ServiceGood[]

  @@index([orgId, deletedAt])
  @@map("services")
}

model ServiceWork {
  serviceId   String  @db.Uuid
  workId      String  @db.Uuid
  quantity    Float   @default(1)
  service     Service @relation(fields: [serviceId], references: [id])
  work        Work    @relation(fields: [workId], references: [id])
  @@id([serviceId, workId])
  @@map("service_works")
}

model ServiceGood {
  serviceId   String  @db.Uuid
  goodId      String  @db.Uuid
  quantity    Float   @default(1)
  service     Service @relation(fields: [serviceId], references: [id])
  good        Good    @relation(fields: [goodId], references: [id])
  @@id([serviceId, goodId])
  @@map("service_goods")
}

// ─── WORK ORDERS ─────────────────────────────────────────

model WorkOrder {
  id               String          @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId            String          @db.Uuid
  branchId         String          @db.Uuid
  vehicleId        String          @db.Uuid
  counterpartyId   String          @db.Uuid
  number           String          // human-readable: WO-2024-0001
  status           WorkOrderStatus @default(DRAFT)
  description      String?
  inMileage        Int?
  outMileage       Int?
  plannedAt        DateTime?
  completedAt      DateTime?
  warrantyUntil    DateTime?
  totalLabor       Decimal         @default(0) @db.Decimal(12, 2)
  totalParts       Decimal         @default(0) @db.Decimal(12, 2)
  totalAmount      Decimal         @default(0) @db.Decimal(12, 2)
  paidAmount       Decimal         @default(0) @db.Decimal(12, 2)
  syncVersion      BigInt          @default(0)
  createdAt        DateTime        @default(now())
  updatedAt        DateTime        @updatedAt
  deletedAt        DateTime?

  vehicle          Vehicle         @relation(fields: [vehicleId], references: [id])
  counterparty     Counterparty    @relation(fields: [counterpartyId], references: [id])
  lines            WorkOrderLine[]
  parts            WorkOrderPart[]
  payments         Payment[]
  invoices         Invoice[]
  calendarSlots    CalendarSlot[]

  @@index([orgId, status, deletedAt])
  @@index([orgId, syncVersion])
  @@index([orgId, counterpartyId])
  @@map("work_orders")
}

model WorkOrderLine {
  id             String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId          String    @db.Uuid
  workOrderId    String    @db.Uuid
  workId         String    @db.Uuid
  employeeId     String    @db.Uuid  // primary executor
  liftId         String?   @db.Uuid
  normoHours     Float
  price          Decimal   @db.Decimal(12, 2)
  amount         Decimal   @db.Decimal(12, 2)
  startedAt      DateTime?
  completedAt    DateTime?
  notes          String?
  syncVersion    BigInt    @default(0)
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt

  workOrder      WorkOrder  @relation(fields: [workOrderId], references: [id])
  work           Work       @relation(fields: [workId], references: [id])
  employee       Employee   @relation(fields: [employeeId], references: [id])
  lift           Lift?      @relation(fields: [liftId], references: [id])
  assistEmployees WorkOrderLineEmployee[]

  @@index([orgId, workOrderId])
  @@index([orgId, employeeId])
  @@map("work_order_lines")
}

model WorkOrderLineEmployee {
  workOrderLineId String  @db.Uuid
  employeeId      String  @db.Uuid
  line            WorkOrderLine @relation(fields: [workOrderLineId], references: [id])
  employee        Employee      @relation(fields: [employeeId], references: [id])
  @@id([workOrderLineId, employeeId])
  @@map("work_order_line_employees")
}

model WorkOrderPart {
  id             String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId          String    @db.Uuid
  workOrderId    String    @db.Uuid
  goodId         String    @db.Uuid
  warehouseId    String    @db.Uuid
  quantity       Float
  price          Decimal   @db.Decimal(12, 2)
  amount         Decimal   @db.Decimal(12, 2)
  syncVersion    BigInt    @default(0)
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt

  workOrder      WorkOrder  @relation(fields: [workOrderId], references: [id])
  good           Good       @relation(fields: [goodId], references: [id])
  warehouse      Warehouse  @relation(fields: [warehouseId], references: [id])

  @@index([orgId, workOrderId])
  @@map("work_order_parts")
}

// ─── INVENTORY ───────────────────────────────────────────

model StockItem {
  id           String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId        String    @db.Uuid
  goodId       String    @db.Uuid
  warehouseId  String    @db.Uuid
  quantity     Float     @default(0)
  reserved     Float     @default(0)
  minStock     Float?
  syncVersion  BigInt    @default(0)
  updatedAt    DateTime  @updatedAt

  good         Good      @relation(fields: [goodId], references: [id])
  warehouse    Warehouse @relation(fields: [warehouseId], references: [id])

  @@unique([orgId, goodId, warehouseId])
  @@index([orgId, warehouseId])
  @@map("stock_items")
}

model StockMovement {
  id             String            @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId          String            @db.Uuid
  goodId         String            @db.Uuid
  warehouseId    String            @db.Uuid
  type           StockMovementType
  quantity       Float             // positive = in, negative = out
  price          Decimal?          @db.Decimal(12, 2)
  documentType   String?           // WorkOrder | PurchaseOrder | Writeoff | Transfer
  documentId     String?           @db.Uuid
  notes          String?
  createdAt      DateTime          @default(now())
  createdBy      String?           @db.Uuid  // employeeId

  good           Good      @relation(fields: [goodId], references: [id])
  warehouse      Warehouse @relation(fields: [warehouseId], references: [id])

  @@index([orgId, goodId, warehouseId])
  @@index([orgId, documentType, documentId])
  @@map("stock_movements")
}

model PurchaseOrder {
  id             String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId          String    @db.Uuid
  supplierId     String    @db.Uuid
  warehouseId    String    @db.Uuid
  number         String
  status         String    @default("DRAFT") // DRAFT | ORDERED | RECEIVED | PARTIAL | CANCELLED
  totalAmount    Decimal   @default(0) @db.Decimal(12, 2)
  notes          String?
  syncVersion    BigInt    @default(0)
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt
  deletedAt      DateTime?

  supplier       Counterparty @relation(fields: [supplierId], references: [id])
  warehouse      Warehouse    @relation(fields: [warehouseId], references: [id])
  lines          PurchaseOrderLine[]

  @@index([orgId, status, deletedAt])
  @@map("purchase_orders")
}

model PurchaseOrderLine {
  id              String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  purchaseOrderId String    @db.Uuid
  goodId          String    @db.Uuid
  quantity        Float
  price           Decimal   @db.Decimal(12, 2)
  receivedQty     Float     @default(0)

  purchaseOrder   PurchaseOrder @relation(fields: [purchaseOrderId], references: [id])
  good            Good          @relation(fields: [goodId], references: [id])

  @@map("purchase_order_lines")
}

// Складський документ: списання, переміщення, початкові залишки
model StockDocument {
  id               String              @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId            String              @db.Uuid
  branchId         String              @db.Uuid
  number           String              // авто через DocumentNumberingService
  type             StockDocumentType
  status           StockDocumentStatus @default(DRAFT)
  warehouseId      String              @db.Uuid  // склад-джерело
  targetWarehouseId String?            @db.Uuid  // тільки для TRANSFER
  notes            String?
  confirmedAt      DateTime?
  confirmedBy      String?             @db.Uuid  // employeeId
  syncVersion      BigInt              @default(0)
  createdAt        DateTime            @default(now())
  updatedAt        DateTime            @updatedAt
  deletedAt        DateTime?

  warehouse        Warehouse           @relation("SourceWarehouse", fields: [warehouseId], references: [id])
  targetWarehouse  Warehouse?          @relation("TargetWarehouse", fields: [targetWarehouseId], references: [id])
  lines            StockDocumentLine[]

  @@index([orgId, status, deletedAt])
  @@index([orgId, type, deletedAt])
  @@index([orgId, syncVersion])
  @@map("stock_documents")
}

model StockDocumentLine {
  id              String        @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId           String        @db.Uuid
  stockDocumentId String        @db.Uuid
  goodId          String        @db.Uuid
  quantity        Float
  price           Decimal?      @db.Decimal(12, 2)  // облікова ціна для OPENING_BALANCE

  stockDocument   StockDocument @relation(fields: [stockDocumentId], references: [id])
  good            Good          @relation(fields: [goodId], references: [id])

  @@index([orgId, stockDocumentId])
  @@map("stock_document_lines")
}

// Налаштування нумерації документів (per org, per DocumentType)
model DocumentNumberConfig {
  id           String       @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId        String       @db.Uuid
  documentType DocumentType
  prefix       String?      // "СТО", "АВТО" — опціональний префікс
  includeDate  Boolean      @default(true)
  dateFormat   String       @default("YYYYMMDD")  // YYYY | YYYYMM | YYYYMMDD
  separator    String       @default("-")
  padding      Int          @default(6)           // 000001
  currentSeq   BigInt       @default(0)
  resetPeriod  ResetPeriod  @default(NEVER)
  updatedAt    DateTime     @updatedAt

  org          Organisation @relation(fields: [orgId], references: [id])

  @@unique([orgId, documentType])
  @@index([orgId])
  @@map("document_number_configs")
}

// ─── SETTINGS ───────────────────────────────────────────

// Загальні налаштування організації (один запис на org)
model OrganisationSettings {
  orgId                  String   @id @db.Uuid
  currency               String   @default("UAH")
  vatMode                VatMode  @default(EXCLUSIVE)
  defaultVatRateId       String?  @db.Uuid       // FK → TaxRate
  invoiceDueDays         Int      @default(7)     // дефолтний термін оплати рахунку
  autoArchiveDays        Int      @default(30)    // PAID → ARCHIVED через N днів (0 = вимкнено)
  defaultWarrantyDays    Int      @default(30)    // гарантія за замовч. при COMPLETED
  requireClientApproval  Boolean  @default(true)  // клієнт повинен підтвердити кошторис
  allowPartialPayment    Boolean  @default(true)  // дозволити часткову оплату
  workOrderPrefix        String?                  // legacy, замінено на DocumentNumberConfig
  updatedAt              DateTime @updatedAt

  org                    Organisation @relation(fields: [orgId], references: [id])
}

// Налаштування філії: ПРРО, SMS, розклад
model BranchSettings {
  branchId               String   @id @db.Uuid
  orgId                  String   @db.Uuid
  // Розклад роботи
  workStartTime          String   @default("09:00")
  workEndTime            String   @default("18:00")
  workDays               Json     @default("[1,2,3,4,5]")  // 1=Пн..7=Нд
  slotDurationMinutes    Int      @default(60)
  // ПРРО (Checkbox) — per branch бо у кожної філії своя каса
  fiscalEnabled          Boolean  @default(false)
  checkboxApiUrl         String?
  checkboxLicenseKey     String?  // шифрується at rest
  checkboxPinCode        String?  // шифрується at rest
  checkboxCashRegisterId String?
  // SMS / Viber — per org (може бути і per branch якщо треба)
  smsEnabled             Boolean  @default(false)
  smsProvider            String?  // turbosms | alphasms | kyivstar
  smsApiKey              String?  // шифрується at rest
  smsSenderName          String?
  updatedAt              DateTime @updatedAt

  branch                 GarageBranch @relation(fields: [branchId], references: [id])
}

// Шаблони сповіщень (SMS/Viber/Email) — повністю керовані з UI
model NotificationTemplate {
  id          String                 @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId       String                 @db.Uuid
  eventType   NotificationEventType
  channel     NotificationChannel
  subject     String?                // для Email
  body        String                 // плейсхолдери: {{clientName}}, {{woNumber}}, {{totalAmount}}, {{vehiclePlate}}, {{branchName}}
  isActive    Boolean                @default(true)
  updatedAt   DateTime               @updatedAt

  @@unique([orgId, eventType, channel])
  @@index([orgId])
  @@map("notification_templates")
}

// Ставки ПДВ — керуються в налаштуваннях
model TaxRate {
  id          String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId       String   @db.Uuid
  name        String   // "ПДВ 20%", "ПДВ 7%", "Без ПДВ", "Не платник ПДВ"
  rate        Decimal  @db.Decimal(5, 2)  // 20.00, 7.00, 0.00
  isDefault   Boolean  @default(false)
  isActive    Boolean  @default(true)
  updatedAt   DateTime @updatedAt

  @@unique([orgId, rate])
  @@index([orgId])
  @@map("tax_rates")
}

// Способи оплати — довідник, керується в налаштуваннях (замість hardcoded enum)
model PaymentMethodConfig {
  id          String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId       String   @db.Uuid
  code        String   // cash | card_terminal | bank_transfer | privat24_qr | monobank_qr | crypto
  name        String   // "Готівка", "Картка (термінал)", ...
  isActive    Boolean  @default(true)
  sortOrder   Int      @default(0)
  requiresFiscal Boolean @default(false)  // чи потрібна фіскалізація для цього методу
  updatedAt   DateTime @updatedAt

  @@unique([orgId, code])
  @@index([orgId])
  @@map("payment_method_configs")
}

// ─── FINANCE & SETTLEMENTS ───────────────────────────────

model Invoice {
  id             String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId          String    @db.Uuid
  counterpartyId String    @db.Uuid
  workOrderId    String?   @db.Uuid
  number         String
  amount         Decimal   @db.Decimal(12, 2)
  status         String    @default("DRAFT") // DRAFT | SENT | PAID | CANCELLED
  dueDate        DateTime?
  syncVersion    BigInt    @default(0)
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt
  deletedAt      DateTime?

  counterparty   Counterparty @relation(fields: [counterpartyId], references: [id])
  workOrder      WorkOrder?   @relation(fields: [workOrderId], references: [id])
  payments       Payment[]

  @@index([orgId, status, deletedAt])
  @@map("invoices")
}

model Payment {
  id             String        @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId          String        @db.Uuid
  counterpartyId String        @db.Uuid
  workOrderId    String?       @db.Uuid
  invoiceId      String?       @db.Uuid
  amount         Decimal       @db.Decimal(12, 2)
  method         String        // код з PaymentMethodConfig.code
  notes          String?
  fiscalReceiptId String?      // Checkbox receipt ID
  syncVersion    BigInt        @default(0)
  createdAt      DateTime      @default(now())

  workOrder      WorkOrder?   @relation(fields: [workOrderId], references: [id])
  invoice        Invoice?     @relation(fields: [invoiceId], references: [id])

  @@index([orgId, workOrderId])
  @@index([orgId, counterpartyId])
  @@map("payments")
}

model SettlementAccount {
  id             String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId          String    @db.Uuid
  counterpartyId String    @unique @db.Uuid
  balance        Decimal   @default(0) @db.Decimal(12, 2)
  updatedAt      DateTime  @updatedAt

  counterparty   Counterparty          @relation(fields: [counterpartyId], references: [id])
  transactions   SettlementTransaction[]

  @@index([orgId])
  @@map("settlement_accounts")
}

model SettlementTransaction {
  id                  String                    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId               String                    @db.Uuid
  settlementAccountId String                    @db.Uuid
  type                SettlementTransactionType
  amount              Decimal                   @db.Decimal(12, 2)
  documentType        String?                   // WorkOrder | Invoice | Payment | PurchaseOrder
  documentId          String?                   @db.Uuid
  notes               String?
  createdAt           DateTime                  @default(now())
  createdBy           String?                   @db.Uuid

  account             SettlementAccount @relation(fields: [settlementAccountId], references: [id])

  @@index([orgId, settlementAccountId])
  @@index([orgId, documentType, documentId])
  @@map("settlement_transactions")
}

model ReconciliationAct {
  id             String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId          String    @db.Uuid
  counterpartyId String    @db.Uuid
  periodFrom     DateTime
  periodTo       DateTime
  openingBalance Decimal   @db.Decimal(12, 2)
  closingBalance Decimal   @db.Decimal(12, 2)
  snapshotJson   Json      // frozen array of transactions
  createdAt      DateTime  @default(now())
  createdBy      String?   @db.Uuid

  @@index([orgId, counterpartyId])
  @@map("reconciliation_acts")
}

// ─── SCHEDULING ──────────────────────────────────────────

model CalendarSlot {
  id           String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId        String    @db.Uuid
  liftId       String?   @db.Uuid
  employeeId   String?   @db.Uuid
  workOrderId  String?   @db.Uuid
  startAt      DateTime
  endAt        DateTime
  notes        String?
  syncVersion  BigInt    @default(0)
  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt

  lift         Lift?      @relation(fields: [liftId], references: [id])
  workOrder    WorkOrder? @relation(fields: [workOrderId], references: [id])

  @@index([orgId, liftId, startAt, endAt])
  @@index([orgId, employeeId, startAt])
  @@map("calendar_slots")
}
```

---

## Migration Workflow

```bash
cd packages/database

# New migration
pnpm prisma migrate dev --name add_vehicle_nodes

# After migrate dev, always run:
pnpm prisma generate

# Check migration SQL before applying to prod:
cat prisma/migrations/*/migration.sql

# Production apply (CI/CD):
pnpm prisma migrate deploy
```

## After Schema Changes

1. `pnpm prisma migrate dev --name <descriptive_name>`
2. `pnpm prisma generate`
3. Rebuild API: `pnpm --filter @sto/api build`
4. Update seed file if new required data
5. Run `sto-backend` skill to create/update the NestJS module

## Seed Data Pattern

```typescript
// packages/database/seed.ts
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const org = await prisma.organisation.upsert({
    where: { id: 'org-seed-uuid-...' },
    update: {},
    create: { id: 'org-seed-uuid-...', orgId: 'org-seed-uuid-...', name: 'СТО Демо' },
  });
  // ... seed branches, zones, lifts, catalog
}
```
