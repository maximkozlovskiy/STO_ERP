---
name: sto-feature
description: >
  Plan and break down a new feature for STO ERP from scratch. Use when the user says "додай фічу", "реалізуй", "потрібна функціональність", "implement", or describes a new capability. Produces a complete feature plan: requirements, DB changes, API endpoints, web screens, mobile impact, tasks, and acceptance criteria — before any code is written. Use as the FIRST step in any feature development.
---

# sto-feature — Feature Planning Skill

## Output Format

When planning a feature, produce all sections below. Be specific about file names, endpoint paths, and DB changes.

---

## Feature Plan Template

### 1. Context & Goal
- What user problem does this solve?
- Which roles are affected?
- Which Bounded Context does this belong to?

### 2. Domain Model Changes
List every Prisma model that needs to be created or modified:
```
NEW:
  ModelName — fields, relations, indexes

MODIFY:
  ExistingModel — add field X (type), add relation to Y
```

### 3. API Endpoints
```
POST   /resource           — create
GET    /resource           — list (paginated)
GET    /resource/:id       — detail
PATCH  /resource/:id       — update
PATCH  /resource/:id/status — FSM transition
DELETE /resource/:id       — soft delete
```
For each: DTO fields, roles that can call it, side effects (stock movements, settlement transactions, events emitted).

### 4. Web UI Changes
```
NEW PAGE:    app/(dashboard)/path/page.tsx
NEW COMPONENT: components/domain/ComponentName.tsx
MODIFY:      existing page — add section/column/button
```

### 5. Mobile Impact
Does this feature affect the mechanic's tablet app?
- If yes: which screen changes, new screens needed?
- Offline behavior?

### 6. Business Rules & Edge Cases
List all invariants that must be enforced:
- "Cannot do X if Y is in state Z"
- "When A happens, B must also happen (transaction)"
- "Field X is required only when Y = true"

### 7. Task Breakdown (Sprints)

| # | Task | Skill to use | Est. |
|---|------|-------------|------|
| 1 | DB schema + migration | sto-database | 1h |
| 2 | Backend module (API) | sto-backend | 2h |
| 3 | Web list + form pages | sto-web | 2h |
| 4 | Mobile changes (if any) | sto-mobile | 1h |
| 5 | Tests | (inline with above) | 1h |

### 8. Acceptance Criteria
Concrete, testable:
- [ ] As a RECEPTIONIST, I can create X with fields A, B, C
- [ ] Validation: X cannot be created if Y already exists
- [ ] When X transitions to status Z, stock item Q decreases by N
- [ ] Settlement account balance updates correctly

---

## Example: "Add Goods Receipt (Оприбуткування)" Feature Plan

### 1. Context & Goal
Reception and storekeeper need to record incoming goods from suppliers, updating stock balances and supplier settlement accounts.
Roles: STOREKEEPER, ADMIN, OWNER.
Bounded Context: Inventory + Settlements.

### 2. Domain Model Changes
```
USE EXISTING: PurchaseOrder, PurchaseOrderLine, StockMovement, SettlementTransaction
No new models needed.
MODIFY PurchaseOrder: add receivedAt DateTime?, add receivedBy String? (employeeId)
```

### 3. API Endpoints
```
POST   /purchase-orders               — create PO (draft)
GET    /purchase-orders               — list with filters (status, supplierId)
GET    /purchase-orders/:id           — detail with lines
PATCH  /purchase-orders/:id/receive   — mark as received → creates StockMovements + SettlementTransaction(CHARGE)
```

### 4. Web UI Changes
```
NEW PAGE: app/(dashboard)/inventory/purchase-orders/page.tsx
NEW PAGE: app/(dashboard)/inventory/purchase-orders/new/page.tsx
NEW PAGE: app/(dashboard)/inventory/purchase-orders/[id]/page.tsx
NEW COMPONENT: components/inventory/PurchaseOrderForm.tsx
NEW COMPONENT: components/inventory/ReceiveGoodsModal.tsx
```

### 5. Mobile Impact
None for MVP — storekeeper works on desktop.

### 6. Business Rules
- PO can only be "received" when status = ORDERED
- Receiving creates a RECEIPT StockMovement for each line
- Receiving creates a CHARGE SettlementTransaction on supplier account
- Partial receipt allowed — track receivedQty per line
- Cannot receive more than ordered quantity

### 7. Task Breakdown
| # | Task | Skill | Est. |
|---|------|-------|------|
| 1 | Add receivedAt/receivedBy to PurchaseOrder schema | sto-database | 30m |
| 2 | PurchaseOrdersService + Controller | sto-backend | 2h |
| 3 | InventoryService.createMovement() method | sto-backend | 1h |
| 4 | Web pages (list, create, receive modal) | sto-web | 2h |
| 5 | Unit tests | sto-backend | 1h |

### 8. Acceptance Criteria
- [ ] STOREKEEPER can create a PO with supplier + warehouse + lines
- [ ] PO receipt creates correct RECEIPT StockMovements
- [ ] PO receipt creates CHARGE transaction on supplier settlement account
- [ ] Stock balance increases correctly after receipt
- [ ] Cannot receive more than ordered qty (validation error)
