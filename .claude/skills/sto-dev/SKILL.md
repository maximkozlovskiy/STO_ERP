---
name: sto-dev
description: >
  STO ERP coding standards — applied DURING code writing, not after. Covers TypeScript quality rules, NestJS patterns, Next.js 15 patterns, Tailwind 4 canonical syntax, Prisma 5 patterns, and domain-specific invariants. Use as a reference while implementing sto-backend, sto-web, sto-database tasks. Prevents the bugs that sto-review and sto-tester catch.
model: claude-sonnet-4-6
---

# sto-dev — Coding Standards

> Цей скіл застосовується **під час написання** — не після.  
> Мета: щоб `/sto-review` знаходив 0 проблем.

---

## TypeScript

### tsconfig.json — валідні значення

```json
// ❌ "ignoreDeprecations": "6.0" — TS 5.9 дає TS5103 "Invalid value"
// ❌ "baseUrl": "."             — deprecated, видалити (paths працює без нього у TS 5+)
// ❌ "rootDir": "src" + paths поза src — конфлікт "common source directory"

// ✅ TS 5.x
{
  "ignoreDeprecations": "5.0",  // тільки "5.0" валідне до TS 6.0
  "moduleResolution": "node",   // для NestJS (commonjs)
  "module": "commonjs",         // NestJS не сумісний з node16 module
  // НЕМАЄ baseUrl — paths відносні до tsconfig.json
  "paths": { "@sto/shared": ["../../packages/shared/src"] }
}
```

> **Чому "6.0" не працює:** значення `ignoreDeprecations` має бути ≤ поточної TS major. На TS 5.9 валідне тільки `"5.0"`. `"6.0"` стане валідним коли вийде TS 6.

### Заборонені патерни

```typescript
// ❌ any
const user: any = ...;
function process(data: any) {}

// ❌ React namespace без імпорту
function Card({ children }: { children: React.ReactNode })  // → import type { ReactNode }

// ❌ non-null assertion без причини
const id = user!.id;  // якщо user може бути undefined — додай guard

// ❌ as-cast замість перевірки
const result = data as WorkOrder;  // → перевір тип або використай type guard

// ❌ Enum як magic string
status: 'IN_PROGRESS'  // → status: WorkOrderStatus.IN_PROGRESS (або з Prisma enum)
```

### Обов'язкові патерни

```typescript
// ✅ Explicit React type imports
import type { ReactNode, HTMLAttributes, SVGAttributes } from 'react';
import { useState, useEffect, type FC } from 'react';

// ✅ Discriminated union замість флагів
type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: WorkOrder[] }
  | { status: 'error'; message: string };

// ✅ Exhaustive switch
function getLabel(status: WorkOrderStatus): string {
  switch (status) {
    case 'DRAFT':       return 'Чернетка';
    case 'ESTIMATE':    return 'Кошторис';
    // ... всі варіанти
    default: {
      const _: never = status;  // compile-time exhaustiveness check
      return status;
    }
  }
}

// ✅ Zod для runtime validation на boundary
const dto = CreateWorkOrderSchema.parse(body);  // не cast, а parse
```

---

## NestJS / API

### Структура модуля

```
apps/api/src/modules/{domain}/
  {domain}.module.ts      ← DI тільки
  {domain}.controller.ts  ← HTTP шар: routing, guards, DTOs, @OrgContext()
  {domain}.service.ts     ← бізнес логіка + Prisma
  {domain}.dto.ts         ← class-validator DTOs + ResponseDTOs
  {domain}.spec.ts        ← unit tests
```

### Controller — тільки HTTP шар

```typescript
// ❌ Бізнес-логіка в контролері
@Post()
async create(@Body() dto: CreateWorkOrderDto) {
  const count = await this.prisma.workOrder.count();  // ← БД у контролері!
  if (count > 1000) throw new BadRequestException('...');
  return this.service.create(dto);
}

// ✅ Контролер тонкий
@Post()
@Roles(UserRole.RECEPTIONIST, UserRole.ADMIN, UserRole.OWNER)
create(@OrgContext() orgId: string, @Body() dto: CreateWorkOrderDto) {
  return this.service.create(orgId, dto);
}
```

### Service — обов'язкові правила

```typescript
// 1. ЗАВЖДИ scope by orgId
// ❌
const wo = await this.prisma.workOrder.findUnique({ where: { id } });
// ✅
const wo = await this.prisma.workOrder.findFirst({
  where: { id, orgId, deletedAt: null },
});
if (!wo) throw new NotFoundException('Наряд не знайдено');

// 2. НІКОЛИ не видаляти — soft delete
// ❌
await this.prisma.workOrder.delete({ where: { id } });
// ✅
await this.prisma.workOrder.update({
  where: { id },
  data: { deletedAt: new Date() },
});

// 3. Зміни складу — тільки через InventoryService
// ❌
await this.prisma.stockItem.update({ where: { id }, data: { quantity: { decrement: qty } } });
// ✅
await this.inventoryService.createMovement(orgId, { type: 'WRITEOFF', goodId, warehouseId, quantity: -qty, ... });

// 4. Зміни балансу — тільки через SettlementsService
// ❌
await this.prisma.settlementAccount.update({ where: { id }, data: { balance: { decrement: amount } } });
// ✅
await this.settlementsService.createTransaction(orgId, { counterpartyId, type: 'CHARGE', amount, documentType: 'WorkOrder', documentId: wo.id });

// 5. FSM — тільки через transition map
// ❌
await this.prisma.workOrder.update({ where: { id }, data: { status: newStatus } });
// ✅
const allowed = WORK_ORDER_TRANSITIONS[wo.status];
if (!allowed.includes(newStatus)) throw new BadRequestException(`Неможливо перевести з ${wo.status} у ${newStatus}`);

// 6. Кілька таблиць — транзакція
await this.prisma.$transaction(async (tx) => {
  await tx.workOrder.update(...);
  await tx.stockMovement.create(...);
  await tx.settlementTransaction.create(...);
});

// 7. Помилки — українською
throw new NotFoundException('Наряд не знайдено');
throw new BadRequestException('Недостатньо запчастин на складі');
throw new ConflictException('Підйомник вже зайнятий');
```

### DTO — обов'язкові декоратори

```typescript
export class CreateWorkOrderDto {
  @ApiProperty({ description: 'ID автомобіля', example: 'uuid' })
  @IsUUID()
  vehicleId: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

export class WorkOrderResponseDto {
  @ApiProperty() id: string;
  @ApiProperty({ enum: WorkOrderStatus }) status: WorkOrderStatus;
  // ⚠️ Ніколи не повертай raw Prisma model — маппи через toResponseDto()
}
```

### Запобігання N+1

```typescript
// ❌ N+1
const orders = await this.prisma.workOrder.findMany({ where: { orgId } });
for (const o of orders) {
  const v = await this.prisma.vehicle.findUnique({ where: { id: o.vehicleId } });
}

// ✅ include / select
const orders = await this.prisma.workOrder.findMany({
  where: { orgId, deletedAt: null },
  include: {
    vehicle: { select: { id: true, make: true, model: true, licensePlate: true } },
    counterparty: { select: { id: true, firstName: true, lastName: true, phone: true } },
  },
});
```

---

## Next.js 15 / Web

### Обов'язкові правила компонентів

```typescript
// ❌ SSR hydration mismatch — Date у render path
export default function Page() {
  const today = new Date().toLocaleDateString('uk-UA');  // UTC на сервері ≠ Kyiv на клієнті
  return <div>{today}</div>;
}

// ✅ useEffect + useState для date/time
const [today, setToday] = useState('');
useEffect(() => {
  setToday(new Date().toLocaleDateString('uk-UA', { timeZone: 'Europe/Kyiv' }));
}, []);

// ❌ fetch/axios прямо в компоненті
useEffect(() => { fetch('/api/work-orders').then(...) }, []);

// ✅ TanStack Query hook
const { data, isLoading, error } = useWorkOrders(orgId, filters);

// ❌ Global loading/saving boolean для списку
const [saving, setSaving] = useState(false);
// ✅ Per-row id
const [savingId, setSavingId] = useState<string | null>(null);
// button: loading={savingId === row.id}

// ❌ Один error стейт для сторінки і форми
setError(formLoadError);  // перезаписує помилку списку
// ✅ Окремі стейти
const [pageError, setPageError] = useState<string | null>(null);
const [formError, setFormError] = useState<string | null>(null);
```

### Event handler cleanup

```typescript
// ❌ Витік пам'яті — немає cleanup
useEffect(() => {
  window.addEventListener('resize', handleResize);
}, []);

// ✅ Завжди повертай cleanup
useEffect(() => {
  window.addEventListener('resize', handleResize);
  return () => window.removeEventListener('resize', handleResize);
}, []);

// ❌ setInterval без cleanup
useEffect(() => {
  setInterval(tick, 1000);
}, []);

// ✅
useEffect(() => {
  const id = setInterval(tick, 1000);
  return () => clearInterval(id);
}, []);
```

### Завантаження даних — loading state init

```typescript
// ❌ loading: false — нема спінера при першому рендері
const [loading, setLoading] = useState(false);
useEffect(() => {
  setLoading(true);
  fetch(...).finally(() => setLoading(false));
}, []);

// ✅ loading: true — спінер відразу
const [loading, setLoading] = useState(true);
useEffect(() => {
  fetch(...).finally(() => setLoading(false));
}, []);
```

### apiFetch — завжди через централізований клієнт

```typescript
// ❌ Прямий fetch
const res = await fetch(`/api/work-orders`, { headers: { Authorization: `Bearer ${token}` } });

// ✅ apiFetch (автоматично додає auth + base URL + error handling)
import { apiFetch } from '@/lib/api';
const data = await apiFetch<WorkOrder[]>('/work-orders');
```

---

## Tailwind 4 — Canonical Syntax

### CSS var → canonical

```
// ❌ [var(--color-x)]  → ✅ (--color-x)  → ✅✅ canonical token (якщо є в @theme)
bg-[var(--color-background)]   → bg-(--color-background)  → bg-background
text-[var(--color-foreground)] → text-(--color-foreground) → text-foreground
border-[var(--color-border)]   → border-(--color-border)   → border-border
rounded-[var(--radius-lg)]     → rounded-(--radius-lg)     → rounded-lg
shadow-[var(--shadow-xs)]      → shadow-(--shadow-xs)      ← залишити (не є Tailwind token)
bg-[var(--kpi-bg)]             → bg-(--kpi-bg)             ← залишити (компонентна змінна)
```

### Tailwind токени (є в globals.css `@theme`)
| CSS var | Canonical |
|---|---|
| `--color-background` | `bg-background` |
| `--color-foreground` | `text-foreground` |
| `--color-muted-foreground` | `text-muted-foreground` |
| `--color-foreground-muted` | `text-foreground-muted` |
| `--color-border` | `border-border` |
| `--color-border-hover` | `border-border-hover` (hover:) |
| `--color-primary` | `bg-primary` / `text-primary` |
| `--color-secondary` | `bg-secondary` |
| `--color-destructive` | `text-destructive` / `border-destructive` |
| `--color-success` | `text-success` |
| `--color-muted` | `bg-muted` |
| `--color-sidebar-bg` | `bg-sidebar-bg` |
| `--color-sidebar-fg` | `text-sidebar-fg` |
| `--color-sidebar-muted` | `text-sidebar-muted` |
| `--color-sidebar-active` | `bg-sidebar-active` |
| `--color-sidebar-hover` | `bg-sidebar-hover` (hover:) |
| `--color-sidebar-border` | `border-sidebar-border` |
| `--color-brand-100` | `ring-brand-100` / `bg-brand-100` |
| `--radius` | `rounded` |
| `--radius-sm` | `rounded-sm` |
| `--radius-md` | `rounded-md` |
| `--radius-lg` | `rounded-lg` |
| `--radius-xl` | `rounded-xl` |

### Pixel → Tailwind scale

```
w-[52px]   → w-13      (52/4 = 13)
w-[216px]  → w-54      (216/4 = 54)
w-[420px]  → w-105     (420/4 = 105)
max-w-[360px] → max-w-90   (360/4 = 90)
top-[54px] → top-13.5  (54/4 = 13.5)
left-[40px] → left-10  (40/4 = 10)
h-[15px]   → h-3.75    (15/4 = 3.75)
w-[15px]   → w-3.75
```

### Інші canonical заміни

```
flex-shrink-0     → shrink-0
tracking-[0.05em] → tracking-wider
tracking-[0.08em] → tracking-widest
```

---

## Prisma 5

### Обов'язкові поля кожної моделі

```prisma
model AnyModel {
  id          String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId       String    @db.Uuid
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt
  deletedAt   DateTime? // soft delete — ніколи не видаляти hard
  syncVersion BigInt    @default(0)

  @@index([orgId, deletedAt])
  @@index([orgId, syncVersion])  // для delta-sync
}
```

### Заборонені операції

```typescript
// ❌ Hard delete
prisma.workOrder.delete({ where: { id } })

// ❌ Пряме оновлення StockItem
prisma.stockItem.update({ data: { quantity: { decrement: qty } } })

// ❌ Пряме оновлення SettlementAccount
prisma.settlementAccount.update({ data: { balance: { decrement: amount } } })

// ❌ Запит без orgId
prisma.workOrder.findUnique({ where: { id } })

// ❌ findMany без take (необмежена вибірка)
prisma.stockMovement.findMany({ where: { orgId } })  // може повернути мільйони рядків
// ✅
prisma.stockMovement.findMany({ where: { orgId }, take: limit, skip: offset })
```

---

## Offline-first / BullMQ

```typescript
// ❌ Прямий виклик зовнішнього API
await this.smsService.send(phone, message);  // впаде без інтернету

// ✅ Через BullMQ чергу — retry при відновленні
await this.smsQueue.add('send', { phone, message }, {
  attempts: 10,
  backoff: { type: 'exponential', delay: 60_000 },
});
```

Зовнішні API що завжди через чергу: **TurboSMS**, **Checkbox (ПРРО)**, **постачальники прайсів**, **Cloud Sync**.

---

## Безпека

```typescript
// ❌ Cross-tenant — немає orgId у запиті
const invoice = await this.prisma.invoice.findUnique({ where: { id } });

// ✅ Завжди orgId
const invoice = await this.prisma.invoice.findFirst({ where: { id, orgId, deletedAt: null } });

// ❌ Сирий SQL з інтерполяцією
await this.prisma.$queryRaw(`SELECT * FROM users WHERE name = '${name}'`);

// ✅ Параметризований
await this.prisma.$queryRaw`SELECT * FROM users WHERE name = ${name}`;

// ❌ Чутливі поля в response DTO
return { id, phone, edrpou, rateScheme, passwordHash };  // ← ніколи!

// ✅ Тільки потрібні поля
return { id, firstName, lastName, phone };
```

---

## Коментарі — коли і як

```typescript
// ❌ Коментар що пояснює ЩО (код вже це каже)
// Знаходимо замовлення по id
const order = await this.prisma.workOrder.findFirst({ where: { id, orgId } });

// ❌ Коментар що згадує задачу/PR
// Додано для issue #123

// ✅ Коментар пояснює ЧОМУ (неочевидне)
// SettlementAccount не має deletedAt — це singleton per counterparty, ніколи не видаляється
const account = await this.prisma.settlementAccount.findFirst({ where: { counterpartyId } });

// ✅ Workaround з причиною
// Prisma не підтримує upsert з composite unique в транзакції до v5.8 — робимо вручну
```

---

## Checklist перед здачею коду

```
TypeScript
  [ ] Немає `any` типів
  [ ] Немає `React.X` namespace без імпорту
  [ ] Немає `console.log`
  [ ] Enums з Prisma/shared, не magic strings

NestJS
  [ ] Кожен запит фільтрується по `orgId`
  [ ] `deletedAt: null` у кожному findMany/findFirst
  [ ] FSM через transition map
  [ ] Зміни складу через InventoryService
  [ ] Зміни балансу через SettlementsService
  [ ] Кілька таблиць → $transaction
  [ ] Помилки українською
  [ ] toResponseDto() — без raw Prisma моделей

Next.js
  [ ] Date/time тільки в useEffect, не в render
  [ ] Per-row savingId, не глобальний saving
  [ ] Окремий formError від pageError
  [ ] loading: true при ініціалізації
  [ ] Cleanup у useEffect (removeEventListener, clearInterval)
  [ ] apiFetch, не fetch/axios напряму

Tailwind
  [ ] `[var(--x)]` → `(--x)` або canonical token
  [ ] Pixel значення → Tailwind scale (px/4)
  [ ] `flex-shrink-0` → `shrink-0`

Prisma
  [ ] Усі нові моделі мають 6 обов'язкових полів
  [ ] findMany з take (pagination)
  [ ] Немає .delete() на бізнес-сутностях

Безпека
  [ ] orgId у кожному запиті
  [ ] Немає чутливих полів у response DTO
  [ ] Параметризований SQL (template literals)
  [ ] BullMQ для зовнішніх API
```

---

## Інтеграція у флоу

```
/sto-context
    ↓
/sto-database  ← schema: обов'язкові поля, soft delete, індекси
    ↓
/sto-backend   ← [читай цей скіл] сервіси, контролери, DTOs
    ↓
/sto-web       ← [читай цей скіл] компоненти, хуки, Tailwind
    ↓
/sto-review    ← перевіряє що цей скіл дотриманий
    ↓
/sto-tester    ← знаходить runtime баги
```

> `/sto-dev` — це живий документ.  
> Після кожного `/sto-review` або `/sto-tester` — якщо знайдено баг якого тут немає, **одразу додай** новий патерн.
