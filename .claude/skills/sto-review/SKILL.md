---
name: sto-review
description: >
  Perform a thorough code review of STO ERP changes. Use when the user says "зроби code review", "перевір код", "review PR", or after implementing a feature. Reviews cover: correctness, security, performance, TypeScript quality, NestJS/Next.js/Expo conventions, business rule compliance, sync-readiness.
model: claude-opus-4-7
---

# sto-review — Code Review Skill

## Режим Auto (ОБОВ'ЯЗКОВО)

**Запускай у режимі Auto:** знаходь усі проблеми → виправляй кожну одразу → без питань до користувача.

Алгоритм:
1. `git diff HEAD --name-only` — отримай список змінених файлів
2. Пройди по кожному чеклисту нижче
3. Кожну знайдену проблему **одразу виправляй** (Edit/Write), потім `tsc --noEmit`
4. Після всіх правок — `git commit -m "fix(review): <опис>"`
5. Оновити `MemoryManual.md` (Останній commit + Changelog)

> Не питай дозволу на виправлення. Якщо fix потребує міграції БД — зафіксуй як CRITICAL і повідом.

## Review Checklist

### Architecture & Patterns
- [ ] Module structure follows `apps/api/src/modules/{domain}/` pattern
- [ ] Controller contains HTTP layer only — no business logic
- [ ] Business logic + Prisma calls are in Service
- [ ] `toResponseDto()` maps every Prisma result — no raw models leaked
- [ ] New Prisma models have all sync-ready fields: `id`, `orgId`, `createdAt`, `updatedAt`, `deletedAt`, `syncVersion`

### Security
- [ ] Every controller endpoint has `@UseGuards(JwtAuthGuard, RolesGuard)` (or explicit public mark)
- [ ] Every service method scopes queries by `orgId` — no cross-tenant data leaks
- [ ] Sensitive fields (phone, EDRPOU, rates) not exposed in response DTOs
- [ ] Input validated by class-validator DTOs (not manual checks)
- [ ] No raw SQL with string interpolation

### Business Rules
- [ ] WorkOrder FSM transitions go through transition map — no direct status writes
- [ ] Stock mutations go through `InventoryService.createMovement()` — never `StockItem.update()` directly
- [ ] Settlement mutations go through `SettlementsService.createTransaction()` — never `SettlementAccount.update()` directly
- [ ] Soft delete used everywhere — `deletedAt = null` filter in all queries
- [ ] Parts reserved (not deducted) when WO → IN_PROGRESS
- [ ] Parts deducted + settlement charged when WO → COMPLETED

### Database
- [ ] No N+1 queries — use `include` or `select` with Prisma
- [ ] Indexes exist for all foreign keys and frequent filter columns
- [ ] Transactions (`prisma.$transaction`) used when multiple tables change together
- [ ] `@unique` constraints where business requires uniqueness (e.g., StockItem: goodId + warehouseId)
- [ ] No hard deletes (`prisma.X.delete()`) on business entities

### TypeScript Quality
- [ ] No `any` types
- [ ] Shared types/schemas imported from `@sto/shared` — not redefined locally
- [ ] Enums from Prisma used (not magic strings)
- [ ] All async functions have proper error handling or propagate HttpExceptions

### Problems Panel (run after every change)

> **ВАЖЛИВО:** VSCode показує помилки через Next.js TS plugin (`"name": "next"` у tsconfig), який суворіший за plain `tsc`. `pnpm tsc --noEmit` може давати 0 errors, але VSCode — 56+. Перевіряй ОБИДВА способи.

After every batch of changes, run TypeScript checks and fix ALL errors before committing:

```bash
# Web app (incremental cache often hides errors — завжди з --incremental false)
cd apps/web && node_modules/.bin/tsc --noEmit --incremental false

# API
pnpm --filter @sto/api exec tsc --noEmit

# All packages
pnpm --filter @sto/shared exec tsc --noEmit
pnpm --filter @sto/ui exec tsc --noEmit
```

**КРИТИЧНА ПЕРЕВІРКА — React namespace без імпорту:**

VSCode/Next.js TS plugin помічає `React.ReactNode`, `React.HTMLAttributes` і т.д. без `import React` як помилки, навіть якщо plain `tsc` мовчить.

```bash
# Знайти всі проблемні місця:
grep -rn "React\." apps/web/src/ --include="*.tsx" --include="*.ts"
```

**Фікс:** замінити `React.ReactNode` → `import type { ReactNode } from 'react'` і використовувати `ReactNode` напряму. Аналогічно для всіх `React.*` типів.

| React namespace | Правильний імпорт |
|---|---|
| `React.ReactNode` | `import type { ReactNode } from 'react'` |
| `React.HTMLAttributes<T>` | `import type { HTMLAttributes } from 'react'` |
| `React.SVGAttributes<T>` | `import type { SVGAttributes } from 'react'` |
| `React.ThHTMLAttributes<T>` | `import type { ThHTMLAttributes } from 'react'` |
| `React.TdHTMLAttributes<T>` | `import type { TdHTMLAttributes } from 'react'` |

**Fix automatically — do not skip errors:**

| Error pattern | Fix |
|---|---|
| `Type '"default"' is not assignable to type 'Variant'` | Add `'default'` to the `Variant` union in `button.tsx` (alias for `'outline'`) |
| `Property 'placeholder' does not exist on type '...SelectProps'` | Add `placeholder?: string` to `SelectProps`; render as `<option value="" disabled>{placeholder}</option>` |
| `Type 'unknown'` on Prisma dynamic select result | Cast: `(result as { field: type }).field` |
| `Property 'X' does not exist on type 'IntrinsicAttributes'` | Add the missing prop to the component's interface |
| `is not assignable to type 'never'` | Check for exhaustive switch/union — add missing branches or cast |
| `Object is possibly 'null' or 'undefined'` | Add null-check guard or non-null assertion if impossible at runtime |
| `Cannot find namespace 'React'` | Add `import type { ReactNode } from 'react'` and replace `React.ReactNode` → `ReactNode` |

**Component prop parity rules (keep in sync):**
- `Button` `Variant`: `'primary' | 'secondary' | 'outline' | 'ghost' | 'destructive' | 'link' | 'default'`
- `Select` props: `label`, `errorMessage`, `hint`, `placeholder` — all optional
- `Input` props: `label`, `errorMessage`, `hint`, `leftElement`, `rightElement` — all optional

### Web Frontend
- [ ] No direct `fetch`/`axios` calls in components — all through TanStack Query hooks
- [ ] Forms use React Hook Form + Zod schema from `@sto/shared`
- [ ] Role-based UI elements wrapped with `<RoleGuard>`
- [ ] Loading and error states handled in every page
- [ ] No `console.log` left in production code

### Mobile
- [ ] Offline-critical screens read from WatermelonDB (not only from server)
- [ ] Timer state persisted via MMKV
- [ ] Camera permissions requested before use
- [ ] No heavy computation on main thread (use `InteractionManager` or workers)

### Tests
- [ ] Unit tests cover: happy path + every thrown exception
- [ ] Mocks are typed (no `as any` on mocks)
- [ ] Tests don't depend on order of execution
- [ ] `pnpm test` passes

### Sync Readiness
- [ ] `syncVersion` is incremented in Prisma middleware (not manually)
- [ ] Queries support delta-sync pattern: `WHERE orgId = ? AND syncVersion > ? AND updatedAt > ?`
- [ ] Append-only tables (StockMovement, SettlementTransaction) never updated or deleted

---

## Common Issues to Flag

```typescript
// ❌ BAD — business logic in controller
@Post()
async create(@Body() dto: CreateWorkOrderDto) {
  const count = await this.prisma.workOrder.count(); // DB call in controller
  return this.workOrdersService.create(dto);
}

// ✅ GOOD — controller is thin
@Post()
create(@OrgContext() orgId: string, @Body() dto: CreateWorkOrderDto) {
  return this.service.create(orgId, dto);
}

// ❌ BAD — no orgId scoping
const workOrder = await this.prisma.workOrder.findUnique({ where: { id } });

// ✅ GOOD — always scope by orgId
const workOrder = await this.prisma.workOrder.findFirst({
  where: { id, orgId, deletedAt: null }
});

// ❌ BAD — direct stock update
await this.prisma.stockItem.update({ where: {...}, data: { quantity: { decrement: qty } } });

// ✅ GOOD — via InventoryService
await this.inventoryService.createMovement(orgId, { type: 'WRITEOFF', goodId, warehouseId, quantity: -qty, ... });

// ❌ BAD — N+1 query
const orders = await this.prisma.workOrder.findMany({ where: { orgId } });
for (const order of orders) {
  const vehicle = await this.prisma.vehicle.findUnique({ where: { id: order.vehicleId } }); // N+1!
}

// ✅ GOOD — single query with include
const orders = await this.prisma.workOrder.findMany({
  where: { orgId },
  include: { vehicle: { select: { make: true, model: true, licensePlate: true } } }
});
```

## Output Format

Structure your review as:
1. **Critical** — bugs, security issues, data integrity violations (must fix)
2. **Important** — performance issues, missing business rules, missing tests (should fix)
3. **Suggestion** — style, naming, minor improvements (nice to have)

For each issue: file + line reference, what's wrong, how to fix.
