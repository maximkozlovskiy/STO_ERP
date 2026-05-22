# STO ERP — Entity-Relationship Diagram

> Авторитетна візуальна модель БД. Джерело правди — `packages/database/schema.prisma`  
> Оновлювати синхронно з кожною зміною схеми.

---

## Зміст

- [Огляд bounded contexts](#огляд-bounded-contexts)
- [1. Інфраструктура](#1-інфраструктура)
- [2. Співробітники](#2-співробітники)
- [3. CRM — Контрагенти та Гараж клієнта](#3-crm)
- [4. Каталог послуг](#4-каталог-послуг)
- [5. Наряди (Work Orders)](#5-наряди)
- [6. Склад та Запаси](#6-склад)
- [7. Фінанси та Взаєморозрахунки](#7-фінанси)
- [8. Календар](#8-календар)
- [9. Налаштування та нумерація](#9-налаштування)
- [Повна схема зв'язків](#повна-схема-звязків)

---

## Огляд bounded contexts

```
┌─────────────────────────────────────────────────────────────┐
│                      Organisation                           │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ Infrastructure│  │  Employees   │  │       CRM        │  │
│  │ GarageBranch  │  │  Employee    │  │  Counterparty    │  │
│  │ Zone / Lift   │  │  Zones/Lifts │  │  CustomerGarage  │  │
│  │ Warehouse     │  │  WorkCats    │  │  Vehicle/Node    │  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │   Catalog    │  │ Work Orders  │  │    Inventory     │  │
│  │ WorkCategory  │  │  WorkOrder   │  │  StockItem       │  │
│  │ Work / Good   │  │  Lines/Parts │  │  StockMovement   │  │
│  │ Service       │  │  CalSlots    │  │  PurchaseOrder   │  │
│  └──────────────┘  └──────────────┘  │  StockDocument   │  │
│                                       └──────────────────┘  │
│  ┌──────────────────────────────────────────────────────┐   │
│  │                     Finance                          │   │
│  │  Invoice  →  Payment  →  SettlementAccount           │   │
│  │                       →  SettlementTransaction       │   │
│  │                       →  ReconciliationAct           │   │
│  └──────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │                    Settings                          │   │
│  │  OrganisationSettings  BranchSettings                │   │
│  │  DocumentNumberConfig  PaymentMethodConfig           │   │
│  │  NotificationTemplate  TaxRate                       │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

> **Ключові правила схеми:**
> - Кожна таблиця має: `id UUID`, `orgId UUID`, `createdAt`, `updatedAt`, `deletedAt?`, `syncVersion BigInt`
> - Soft delete скрізь: `deletedAt IS NULL` у всіх запитах
> - Append-only таблиці (без deletedAt): `StockMovement`, `SettlementTransaction`, `Payment`, `ReconciliationAct`

---

## 1. Інфраструктура

```mermaid
erDiagram
    Organisation {
        uuid id PK
        uuid orgId
        string name
        string edrpou "unique, optional"
        bigint syncVersion
    }

    GarageBranch {
        uuid id PK
        uuid orgId FK
        string name
        string address
        string timezone
    }

    Zone {
        uuid id PK
        uuid orgId FK
        uuid branchId FK
        string name
        enum type "MECHANICAL|BODY|TIRE|WASH|ELECTRICAL|OTHER"
    }

    Lift {
        uuid id PK
        uuid orgId FK
        uuid zoneId FK
        string name
        enum type "TWO_POST|FOUR_POST|ALIGNMENT|STENCIL|STAND|OTHER"
        int maxWeightKg "optional"
    }

    Warehouse {
        uuid id PK
        uuid orgId FK
        uuid branchId FK
        string name
        enum type "MAIN|WORKSHOP|TIRE_HOTEL|MOBILE"
    }

    Organisation ||--o{ GarageBranch : "має філії"
    GarageBranch ||--o{ Zone : "має зони"
    GarageBranch ||--o{ Warehouse : "має склади"
    Zone ||--o{ Lift : "має підйомники"
```

---

## 2. Співробітники

```mermaid
erDiagram
    Employee {
        uuid id PK
        uuid orgId FK
        uuid userId "optional, auth user"
        string firstName
        string lastName
        enum role "OWNER|ADMIN|RECEPTIONIST|MECHANIC|STOREKEEPER|ACCOUNTANT"
        json rateScheme "percent_normo | fixed_plus_bonus"
    }

    EmployeeZone {
        uuid employeeId PK,FK
        uuid zoneId PK,FK
    }

    EmployeeLift {
        uuid employeeId PK,FK
        uuid liftId PK,FK
    }

    EmployeeWorkCategory {
        uuid employeeId PK,FK
        uuid workCategoryId PK,FK
    }

    WorkCategory {
        uuid id PK
        uuid orgId FK
        uuid parentId "optional, self-ref"
        string name
        int sortOrder
    }

    Employee ||--o{ EmployeeZone : "працює в зонах"
    Employee ||--o{ EmployeeLift : "сертифікований на підйомниках"
    Employee ||--o{ EmployeeWorkCategory : "виконує категорії робіт"
    WorkCategory ||--o{ EmployeeWorkCategory : ""
    WorkCategory ||--o{ WorkCategory : "підкатегорії (self-ref)"
```

---

## 3. CRM

```mermaid
erDiagram
    Counterparty {
        uuid id PK
        uuid orgId FK
        enum type "CLIENT|SUPPLIER|BOTH"
        string firstName "optional"
        string lastName "optional"
        string companyName "optional"
        string edrpou "optional"
        boolean vatPayer
        string phone
        string email
    }

    CustomerGarage {
        uuid id PK
        uuid orgId FK
        uuid counterpartyId FK
        string name
        string address "optional"
    }

    Vehicle {
        uuid id PK
        uuid orgId FK
        uuid customerGarageId FK
        string vin "optional"
        string licensePlate "optional"
        string make
        string model
        int year
        float engineVolume
        string fuelType
        int currentMileage
    }

    VehicleNode {
        uuid id PK
        uuid orgId FK
        uuid vehicleId FK
        string category "engine|gearbox|suspension|electrical|AC|body"
        string name
        int mileageAtInstall "optional"
    }

    Counterparty ||--o{ CustomerGarage : "має гаражі"
    CustomerGarage ||--o{ Vehicle : "містить авто"
    Vehicle ||--o{ VehicleNode : "має вузли"
```

---

## 4. Каталог послуг

```mermaid
erDiagram
    WorkCategory {
        uuid id PK
        uuid orgId FK
        uuid parentId "optional, self-ref"
        string name
    }

    Work {
        uuid id PK
        uuid orgId FK
        uuid categoryId FK
        string name
        float normoHours
        decimal price
    }

    Good {
        uuid id PK
        uuid orgId FK
        string sku "optional"
        string name
        string unit "шт за замовч."
        decimal purchasePrice
        decimal salePrice
        string barcode "optional"
    }

    Service {
        uuid id PK
        uuid orgId FK
        string name
        decimal price "optional, якщо null — рахується з рядків"
    }

    ServiceWork {
        uuid serviceId PK,FK
        uuid workId PK,FK
        float quantity
    }

    ServiceGood {
        uuid serviceId PK,FK
        uuid goodId PK,FK
        float quantity
    }

    WorkCategory ||--o{ Work : "містить роботи"
    Service ||--o{ ServiceWork : "включає роботи"
    Service ||--o{ ServiceGood : "включає товари"
    Work ||--o{ ServiceWork : ""
    Good ||--o{ ServiceGood : ""
```

---

## 5. Наряди

```mermaid
erDiagram
    WorkOrder {
        uuid id PK
        uuid orgId FK
        uuid branchId FK
        uuid vehicleId FK
        uuid counterpartyId FK
        string number "WO-2024-0001"
        enum status "DRAFT|ESTIMATE|APPROVED|IN_PROGRESS|ON_HOLD|COMPLETED|INVOICED|PAID|ARCHIVED|CANCELLED"
        int inMileage
        int outMileage
        datetime plannedAt
        datetime completedAt
        datetime warrantyUntil
        decimal totalLabor
        decimal totalParts
        decimal totalAmount
        decimal paidAmount
    }

    WorkOrderLine {
        uuid id PK
        uuid orgId FK
        uuid workOrderId FK
        uuid workId FK
        uuid employeeId FK "головний виконавець"
        uuid liftId "optional"
        float normoHours
        decimal price
        decimal amount
        datetime startedAt
        datetime completedAt
    }

    WorkOrderLineEmployee {
        uuid workOrderLineId PK,FK
        uuid employeeId PK,FK
        "асистенти на операції"
    }

    WorkOrderPart {
        uuid id PK
        uuid orgId FK
        uuid workOrderId FK
        uuid goodId FK
        uuid warehouseId FK
        float quantity
        decimal price
        decimal amount
    }

    Vehicle ||--o{ WorkOrder : "приїжджає на"
    Counterparty ||--o{ WorkOrder : "є власником"
    WorkOrder ||--o{ WorkOrderLine : "складається з операцій"
    WorkOrder ||--o{ WorkOrderPart : "використовує запчастини"
    WorkOrderLine ||--o{ WorkOrderLineEmployee : "мають асистентів"
    Work ||--o{ WorkOrderLine : ""
    Employee ||--o{ WorkOrderLine : "виконує"
    Good ||--o{ WorkOrderPart : ""
    Warehouse ||--o{ WorkOrderPart : ""
```

---

## 6. Склад

```mermaid
erDiagram
    StockItem {
        uuid id PK
        uuid orgId FK
        uuid goodId FK
        uuid warehouseId FK
        float quantity "поточний залишок"
        float reserved "зарезервовано"
        float minStock "optional, поріг сигналу"
        "UNIQUE(orgId, goodId, warehouseId)"
    }

    StockMovement {
        uuid id PK
        uuid orgId FK
        uuid goodId FK
        uuid warehouseId FK
        enum type "RECEIPT|WRITEOFF|TRANSFER|RESERVATION|RESERVATION_RELEASE"
        float quantity "позитивне=прихід, від'ємне=витрата"
        decimal price "optional"
        string documentType "WorkOrder|PurchaseOrder|Writeoff|Transfer"
        uuid documentId "optional"
        "APPEND-ONLY — не редагується"
    }

    PurchaseOrder {
        uuid id PK
        uuid orgId FK
        uuid supplierId FK
        uuid warehouseId FK
        string number
        string status "DRAFT|ORDERED|RECEIVED|PARTIAL|CANCELLED"
        decimal totalAmount
    }

    PurchaseOrderLine {
        uuid id PK
        uuid purchaseOrderId FK
        uuid goodId FK
        float quantity
        decimal price
        float receivedQty
    }

    StockDocument {
        uuid id PK
        uuid orgId FK
        uuid branchId FK
        string number "авто, з DocumentNumberConfig"
        enum type "WRITEOFF|TRANSFER|OPENING_BALANCE"
        enum status "DRAFT|CONFIRMED|CANCELLED"
        uuid warehouseId FK "склад-джерело"
        uuid targetWarehouseId "optional, для TRANSFER"
        string notes "optional"
    }

    StockDocumentLine {
        uuid id PK
        uuid orgId FK
        uuid stockDocumentId FK
        uuid goodId FK
        float quantity
        decimal price "optional, облікова ціна для OPENING_BALANCE"
    }

    Good ||--o{ StockItem : "залишки по складах"
    Warehouse ||--o{ StockItem : ""
    Good ||--o{ StockMovement : "рухи по товару"
    Warehouse ||--o{ StockMovement : ""
    Counterparty ||--o{ PurchaseOrder : "постачальник"
    Warehouse ||--o{ PurchaseOrder : "на склад"
    PurchaseOrder ||--o{ PurchaseOrderLine : "рядки замовлення"
    Good ||--o{ PurchaseOrderLine : ""
    Warehouse ||--o{ StockDocument : "склад операції"
    StockDocument ||--o{ StockDocumentLine : "рядки документа"
    Good ||--o{ StockDocumentLine : ""
```

---

## 7. Фінанси

```mermaid
erDiagram
    Invoice {
        uuid id PK
        uuid orgId FK
        uuid counterpartyId FK
        uuid workOrderId "optional"
        string number
        decimal amount
        string status "DRAFT|SENT|PAID|CANCELLED"
        datetime dueDate "optional"
    }

    Payment {
        uuid id PK
        uuid orgId FK
        uuid counterpartyId FK
        uuid workOrderId "optional"
        uuid invoiceId "optional"
        decimal amount
        enum method "CASH|CARD_TERMINAL|BANK_TRANSFER|PRIVAT24_QR|MONOBANK_QR|CRYPTO"
        string fiscalReceiptId "Checkbox ID"
        "APPEND-ONLY"
    }

    SettlementAccount {
        uuid id PK
        uuid orgId FK
        uuid counterpartyId FK,UNIQUE
        decimal balance "поточний баланс"
    }

    SettlementTransaction {
        uuid id PK
        uuid orgId FK
        uuid settlementAccountId FK
        enum type "CHARGE|PAYMENT|REFUND|PREPAYMENT|CREDIT_NOTE"
        decimal amount
        string documentType "WorkOrder|Invoice|Payment|PurchaseOrder"
        uuid documentId "optional"
        "APPEND-ONLY"
    }

    ReconciliationAct {
        uuid id PK
        uuid orgId FK
        uuid counterpartyId FK
        datetime periodFrom
        datetime periodTo
        decimal openingBalance
        decimal closingBalance
        json snapshotJson "заморожений масив транзакцій"
    }

    Counterparty ||--|| SettlementAccount : "має рахунок"
    SettlementAccount ||--o{ SettlementTransaction : "транзакції"
    Counterparty ||--o{ Invoice : "виставлені рахунки"
    WorkOrder ||--o{ Invoice : "до наряду"
    Invoice ||--o{ Payment : "оплати"
    WorkOrder ||--o{ Payment : "прямі оплати"
    Counterparty ||--o{ ReconciliationAct : "акти звірки"
```

---

## 9. Налаштування

```mermaid
erDiagram
    DocumentNumberConfig {
        uuid id PK
        uuid orgId FK
        enum documentType "WORK_ORDER|INVOICE|PURCHASE_ORDER|STOCK_RECEIPT|STOCK_WRITEOFF|STOCK_TRANSFER|STOCK_OPENING|RECONCILIATION_ACT"
        string prefix "optional, напр. СТО або АВТО"
        boolean includeDate "default true"
        string dateFormat "YYYY | YYYYMM | YYYYMMDD"
        string separator "default -"
        int padding "кількість цифр, default 6"
        bigint currentSeq "поточний лічильник"
        string resetPeriod "never | yearly | monthly"
        "UNIQUE(orgId, documentType)"
        "Приклад: СТО-20240521-000001"
    }

    Organisation ||-