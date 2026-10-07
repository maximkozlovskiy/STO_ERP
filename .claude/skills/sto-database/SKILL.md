---
name: sto-database
description: >
  Create or modify Prisma schema, generate migrations, and write seed data for STO ERP. Use when the user says "зміни схему", "додай таблицю", "нова модель", "міграція", "prisma", or when a feature requires DB changes. Always run this BEFORE sto-backend. Handles full DB layer: schema design, migrations, indexes, seed data.
model: sonnet
bypassPermissions: true
---

# sto-database — Prisma Schema Skill

> **СПЕЦИФІКАЦІЯ ПЕРШОЮ.** Перед написанням коду прочитай дос'є агрегату
> `docs/objects/<entity>.md` — секції «Бізнес-правила (BR-XXX)» і «Аспекти і тести,
> що їх стережуть».
>
> - нове бізнес-правило → новий `BR-XXX-NNN` у дос'є **і** тест в аспектному спеку
>   (`<module>.<аспект>.spec.ts`), не `it()` у найбільший файл;
> - новий спек-файл → рядок у таблиці реєстру, інакше падає гейт C;
> - кількість кейсів у реєстрі — з `vitest --reporter=json`, не з `grep -c "it("`.
>
> Перевірка: `python scripts/check-spec-registry.py --gate-size --gate-registry`.

## Before Starting

1. Read `MemoryManual.md` — current project state, gotchas, last migration
2. **Identify the aggregate** being touched → read its `docs/objects/<entity>.md` dossier — existing Prisma model, relations, indexes, business rules
3. Read `docs/BUSINESS-RULES.md` — FSM rules, append-only tables (StockMovement, SettlementTransaction have NO deletedAt), soft-delete rules
4. Read `packages/database/prisma/schema/*.prisma` — know current state
5. Identify which Bounded Context you're modifying

**Aggregate → dossier lookup:**
`WorkOrder→work-order.md` | `Invoice→invoice.md` | `PurchaseOrder→purchase-order.md` | `StockDocument→stock-document.md` | `Counterparty→counterparty.md` | `Good→good.md` | `Work/WorkCategory→work.md` | `CalendarSlot→calendar.md` | `StockItem/StockMovement→inventory.md` | `SettlementAccount/Transaction→settlements.md`

**Red flags from dossiers to check before migrating:**

- Models without `deletedAt`: SettlementAccount, SettlementTransaction, StockMovement, Payment, WorkOrderLineEmployee — never add soft-delete to these
- GIN trgm indexes (Good.name/sku, Counterparty.firstName/lastName) are manual migrations — do NOT add to the schema files

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

## Core Schema Template → `sections/schema-template.md`

Винесено дослівно; читати цілком, коли задача цього стосується.

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

## Append-only immutability тригери (ledger)

Фінансовий/складський ledger (`settlement_transactions`, `stock_movements`) = append-only. Незмінність
трималась лише конвенцією коду + guard-тестом → фізично закріплена BEFORE ROW plpgsql-тригерами
(migration `20260917120000_append_only_immutability_triggers`). Це manual-SQL конструкт (не у
schema.prisma) → ОБОВʼЯЗКОВО покрити existence-check у `schema-integrity.integration.spec.ts` (SELECT з
`pg_trigger` WHERE `NOT tgisinternal`) + behavioral-spec (`append-only-triggers.integration.spec.ts`).

**Класифікація append-only (тригер = повна заборона UPDATE+DELETE):** модель без
`updatedAt`/`deletedAt`/`syncVersion` і БЕЗ мутацій у коді (`settlement_transactions`). НЕ вішати тригер
на моделі з полями що легітимно мутуються: `Payment` (`fiscalStatus`/`fiscalError`/`fiscalReceiptId`/
`syncVersion` оновлює ПРРО-процесор), `StockBatch` (`remainingQty`/`updatedAt`/`syncVersion`).

**Частковий виняток (`stock_movements`):** рядок отримує ОДИН пост-insert `UPDATE "batchId"` (NULL→value)
у тій самій `createMovement`-tx (рух вставляється першим — його id вхід для consumeBatch). Тригер: DELETE
завжди заборонено; UPDATE дозволено ЛИШЕ якщо змінився виключно `batchId`.

❌ **Перелік колонок через `IS NOT DISTINCT` — крихкий:** пропущена/нова колонка (`price`, `notes`,
`createdBy`, `unitOfMeasureId`) проскочить разом з batchId → мутація ledger-money-поля `price`.

✅ **Порівнюй ЦІЛИЙ рядок з зануленим полем-винятком** (core PG, без extension, авто-покриває нові колонки):

```sql
IF (OLD."batchId" IS NULL
    AND NEW."batchId" IS NOT NULL
    AND (to_jsonb(NEW) - 'batchId') = (to_jsonb(OLD) - 'batchId')) THEN
  RETURN NEW;  -- лише batchId змінився
END IF;
RAISE EXCEPTION '... append-only ...' USING ERRCODE = 'raise_exception';
```

- Idempotent: `CREATE OR REPLACE FUNCTION` + `DROP TRIGGER IF EXISTS ... CREATE TRIGGER`.
- Правка тіла тригера у вже-застосованій міграції → Prisma НЕ переприкладе. Переприклади функцію на
  dev-БД вручну (node + PrismaClient `$executeRawUnsafe`), інакше behavioral-spec червоніє на старій логіці.
- Behavioral-spec cleanup: `ALTER TABLE ... DISABLE TRIGGER` → DELETE throwaway → `ENABLE TRIGGER` у `afterAll`.
- Реверс/сторно ledger = компенсуючий запис (нова BatchConsumption/рух), НІКОЛИ DELETE/UPDATE існуючого.

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
