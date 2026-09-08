---
name: sto-dev
description: >
  STO ERP coding standards — applied DURING code writing, not after. Covers TypeScript quality rules, NestJS patterns, Next.js 15 patterns, Tailwind 4 canonical syntax, Prisma 5 patterns, and domain-specific invariants. Use as a reference while implementing sto-backend, sto-web, sto-database tasks. Prevents the bugs that sto-review and sto-tester catch.
model: claude-haiku-4-5-20251001
bypassPermissions: true
---

# sto-dev — Coding Standards

> Цей скіл застосовується **під час написання** — не після.  
> Мета: щоб `/sto-review` знаходив 0 проблем.

## Зміст

| §   | Секція                                                                   | Для кого                                      |
| --- | ------------------------------------------------------------------------ | --------------------------------------------- |
| §1  | [TypeScript](#typescript)                                                | Всі файли `.ts`/`.tsx`                        |
| §2  | [NestJS / API](#nestjs--api)                                             | `*.controller.ts`, `*.service.ts`, `*.dto.ts` |
| §3  | [Next.js 15 / Web](#nextjs-15--web)                                      | `apps/web/src/**`                             |
| §4  | [UX/UI Features System](#uxui-features-system-phase-20)                  | Хуки та компоненти UI                         |
| §5  | [Tailwind 4 — Canonical Syntax](#tailwind-4--canonical-syntax)           | Будь-який `.tsx` з className                  |
| §6  | [Prisma 5](#prisma-5)                                                    | `schema.prisma`, `*.service.ts` з Prisma      |
| §7  | [SSE — Real-time](#sse-server-sent-events--real-time-дані-без-websocket) | Streaming endpoints, EventSource              |
| §8  | [Optimistic UI](#optimistic-ui--миттєвий-відгук-без-очікування-api)      | FSM кнопки, форми з негайним відгуком         |
| §9  | [Polymorphic entities](#polymorphic-entities--comments-auditlog-media)   | Comments, AuditLog, Media                     |
| §10 | [Webhook pattern](#webhook-pattern--вихідні-нотифікації)                 | Outbound webhooks                             |
| §11 | [Offline-first / BullMQ](#offline-first--bullmq)                         | Зовнішні API, SMS, ПРРО                       |
| §12 | [Безпека](#безпека)                                                      | Auth guards, tenant isolation                 |
| §13 | [Checklist перед здачею](#checklist-перед-здачею-коду)                   | Всі зміни перед комітом                       |

> **Швидкий старт:** для нового контролера → §1 + §2 + §12. Для нової сторінки → §1 + §3 + §5. Для Prisma моделі → §1 + §6.

---

## TypeScript

### tsconfig.json — валідні значення

```json
// ❌ "ignoreDeprecations": "6.0" — TS 5.9 дає TS5103 "Invalid value"
// ❌ "baseUrl": "."             — deprecated, видалити (paths працює без нього у TS 5+)
// ❌ "rootDir": "src" + paths поза src — конфлікт "common source directory"

// ✅ TS 5.x
{
  "ignoreDeprecations": "5.0", // тільки "5.0" валідне до TS 6.0
  "moduleResolution": "node", // для NestJS (commonjs)
  "module": "commonjs", // NestJS не сумісний з node16 module
  // НЕМАЄ baseUrl — paths відносні до tsconfig.json
  "paths": { "@sto/shared": ["../../packages/shared/src"] }
}
```

> `ignoreDeprecations` має бути ≤ поточної TS major. На TS 5.9 валідне тільки `"5.0"`.

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
    case 'DRAFT':
      return 'Чернетка';
    case 'ESTIMATE':
      return 'Кошторис';
    // ... всі варіанти
    default: {
      const _: never = status; // compile-time exhaustiveness check
      return status;
    }
  }
}

// ✅ Zod для runtime validation на boundary
const dto = CreateWorkOrderSchema.parse(body); // не cast, а parse
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

### Fastify route ordering — специфічні роути ПЕРЕД параметричними

```typescript
// ❌ :id матчить "toggle-active" як параметр → Cannot PATCH /resource/:id/toggle-active
@Patch(':id')          update(...)    // захоплює "uuid/toggle-active" цілком
@Patch(':id/toggle-active')  toggle(...)

// ✅ Специфічний суброут ПЕРЕД загальним :id
@Patch(':id/toggle-active')  toggle(...)   // ← ПЕРШИЙ
@Get(':id/linked-something')  getLinks(...)  // ← ПЕРШИЙ
@Get(':id')           findOne(...)    // ← після всіх sub-routes
@Patch(':id')         update(...)     // ← після всіх sub-routes
@Delete(':id')        remove(...)     // ← після всіх sub-routes
```

> **Правило:** у Fastify (на відміну від Express) роути матчаться в порядку оголошення.
> `:id` — жадібний параметр, він захоплює `uuid/toggle-active` якщо оголошений першим.
> Завжди: `GET/PATCH :id/action` → вище за `GET/PATCH :id` у контролері.

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

// 8. Exactly-once ЗОВНІШНІЙ ефект (Z-звіт, чек, SMS) — CAS-claim ПЕРЕД викликом (Bug #711)
// ❌ stale head-check → external → update: 2 concurrent = 2 Z-звіти/чеки/SMS
const s = await prisma.cashShift.findFirst({ where: { id, orgId } });
if (s.status !== 'OPEN') throw new BadRequestException('Зміна вже закрита');
await provider.closeShift(cfg, token);              // ← обидва потоки сюди
await prisma.cashShift.update({ where: { id }, data: { status: 'CLOSED' } });
// ✅ CAS-claim статусу ПЕРШИМ; count===0 → програвший не робить другий ефект
const claim = await prisma.cashShift.updateMany({
  where: { id, orgId, status: 'OPEN', deletedAt: null },
  data: { status: 'CLOSED', closedAt: new Date() },
});
if (claim.count === 0) throw new BadRequestException('Зміна вже закрита');
try { await provider.closeShift(cfg, token); }      // рівно 1 переможець
catch (e) { await prisma.cashShift.updateMany({ where: { id, orgId, status: 'CLOSED', zReportId: null }, data: { status: 'OPEN', closedAt: null } }); throw e; }

// 9. CAS проти гонки ≠ перевірка бізнес-max (Bug #712) — потрібні ОБИДВА
// ❌ CAS захищає від подвоєння, але прийом 100 на замовлені 10 проходить чисто
await tx.purchaseOrderLine.updateMany({ where: { id, receivedQty: line.receivedQty }, data: { receivedQty: { increment: recv.qty } } });
// ✅ fail-fast стеля ПЕРЕД tx (Float → EPSILON проти IEEE-754-дрейфу), потім CAS
if (line.receivedQty + recv.qty > line.quantity + 1e-6) throw new BadRequestException('Кількість прийому перевищує залишок');
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
import { apiFetch } from '@/lib/api-client';
const data = await apiFetch<WorkOrder[]>('/work-orders');
```

---

## UX/UI Features System (Phase 20)

> 10 UX-прапорців у `OrganisationSettings.uiFeatures` (JSON, per-org), всі за замовчуванням `true`. Endpoint `GET /settings/ui-features` (всі ролі). Module-level cache з TTL — один fetch/сесію; при помилці кешує DEFAULTS на 60 сек. Слухає `sto:logout` → скидає до DEFAULTS.

### uiFeatures — повна схема

```typescript
// apps/api/src/modules/settings/settings.dto.ts
interface UiFeatures {
  toastEnabled: boolean; // Toast-сповіщення після мутацій
  unsavedGuardEnabled: boolean; // Попередження при закритті брудної форми
  stockIndicatorEnabled: boolean; // "Доступно: N шт." при виборі запчастини
  commandPaletteEnabled: boolean; // Ctrl+K → Command Palette
  keyboardShortcutsEnabled: boolean; // Alt+W/D/C/I/N та інші глобальні шорткати
  savedFiltersEnabled: boolean; // Збережені пресети фільтрів (localStorage)
  inlineEditEnabled: boolean; // Редагування прямо у рядку таблиці
  syncIndicatorEnabled: boolean; // Індикатор online/offline у sidebar
  notificationCenterEnabled: boolean; // Дзвоник з лічильником непрочитаних
  bulkActionsEnabled: boolean; // Чекбокси + BulkActionsBar у таблицях
}
const UI_FEATURES_DEFAULTS: UiFeatures = {
  /* всі true */
};
```

### useUiFeatures — отримання прапорців

```typescript
const features = useUiFeatures();
if (features.toastEnabled) toast.success('Збережено');
{features.bulkActionsEnabled && <BulkActionsBar ... />}
// Інвалідація після зміни: invalidateUiFeaturesCache() → dispatch 'sto:ui-features-change'
```

### Toast — сповіщення після мутацій

- Завжди перевіряй прапорець: `if (features.toastEnabled) toast.success('Збережено')`
- При вимкненому toast — fallback: `else setError(msg)` (inline error display)
- `ToastContainer` монтується в `TopShell.tsx` — не підключати в новому layout

### useDirtyForm — захист від випадкового закриття

API: `const { isDirty, markDirty, resetDirty, confirmClose } = useDirtyForm({ enabled: features.unsavedGuardEnabled })`

- `onChange` → `markDirty()`; після збереження → `resetDirty()` (ОБОВ'ЯЗКОВО)
- `confirmClose()` → `Promise<boolean>`; `isDirtyRef` (useRef) для `beforeunload`, `isDirty` (useState) для рендеру

### useInlineEdit — редагування у таблиці

API: `const inlineEdit = useInlineEdit({ enabled, onSave: async (rowId, field, value) => ... })`

- `inlineEdit.isEditing(row.id, 'field')` → рендерить `<InlineEditCell>` або `<InlineViewCell>`
- `commitEdit(v).catch(() => {})` — ЗАВЖДИ `.catch` бо re-throws після toast
- `<select>` → `defaultValue` (uncontrolled) — controlled `value` "відскакує" при in-flight save
- `savingRef` блокує подвійний коміт (blur + click)

### useBulkSelect — множинний вибір у таблиці

API: `const bulkSelect = useBulkSelect(data?.items ?? [])` — auto-prunes stale IDs при рефетч

- `indeterminate` → imperative через `useEffect + ref`, НЕ inline ref callback
- Bulk-мутації → `Promise.allSettled` (НЕ `Promise.all`); завжди `bulkSelect.clear()` + `load()`
- colSpan у loading/empty: `features.bulkActionsEnabled ? cols + 1 : cols`
- `useMemo` для `bulkActions` array

### useSavedFilters — збережені пресети фільтрів

API: `const { saved, save, remove } = useSavedFilters<MyFilters>('page-key')`

- SSR-safe: `useState([])` → гідратація у `useEffect` з localStorage
- `Array.isArray` guard при читанні — захист від corruption
- `pageKey` — унікальний per-page рядок (`'work-orders'`, `'inventory'`, `'employees'`)

### Hover-actions у рядках таблиці

- `group` на `<TableRow>`, кнопки: `opacity-0 group-hover:opacity-100 focus-visible:opacity-100`
- `size="icon-sm"` для icon-only кнопок; `onClick={e => e.stopPropagation()}` на `<TableCell>`
- Trash2 у `{!isDeleted && ...}`; перед DELETE — `confirm({ variant: 'destructive' })`
- Навігація до деталей → `ExternalLink`; додаткові дії (Розцінити) → `Zap` зліва від Pencil
- Застосовується: work-orders (ExternalLink+Trash2), invoices/purchase-orders/stock-documents (Pencil+Trash2), catalog tabs (Pencil+Trash2/RotateCcw)

### NotificationCenter — сповіщення у sidebar

API: `const { add } = useNotifications(); add('success'|'error'|'warning', title, body)`

- `group` + `opacity-0 group-hover:opacity-100 focus:opacity-100` на кнопці delete
- `onKeyDown` на `role="button"` → guard `if (e.target !== e.currentTarget) return`

### SyncIndicator — статус синхронізації

`window.dispatchEvent(new CustomEvent('sto:sync-status', { detail: { status: 'syncing' } }))` — `'idle'|'syncing'|'offline'|'error'`; wired у TopShell, показується коли `status !== 'idle'` або `lastSync !== null`

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

| CSS var                    | Canonical                                 |
| -------------------------- | ----------------------------------------- |
| `--color-background`       | `bg-background`                           |
| `--color-foreground`       | `text-foreground`                         |
| `--color-muted-foreground` | `text-muted-foreground`                   |
| `--color-foreground-muted` | `text-foreground-muted`                   |
| `--color-border`           | `border-border`                           |
| `--color-border-hover`     | `border-border-hover` (hover:)            |
| `--color-primary`          | `bg-primary` / `text-primary`             |
| `--color-secondary`        | `bg-secondary`                            |
| `--color-destructive`      | `text-destructive` / `border-destructive` |
| `--color-success`          | `text-success`                            |
| `--color-muted`            | `bg-muted`                                |
| `--color-sidebar-bg`       | `bg-sidebar-bg`                           |
| `--color-sidebar-fg`       | `text-sidebar-fg`                         |
| `--color-sidebar-muted`    | `text-sidebar-muted`                      |
| `--color-sidebar-active`   | `bg-sidebar-active`                       |
| `--color-sidebar-hover`    | `bg-sidebar-hover` (hover:)               |
| `--color-sidebar-border`   | `border-sidebar-border`                   |
| `--color-brand-100`        | `ring-brand-100` / `bg-brand-100`         |
| `--radius`                 | `rounded`                                 |
| `--radius-sm`              | `rounded-sm`                              |
| `--radius-md`              | `rounded-md`                              |
| `--radius-lg`              | `rounded-lg`                              |
| `--radius-xl`              | `rounded-xl`                              |

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

### Arbitrary value — парність дужок ОБОВ'ЯЗКОВА

Tailwind 4 JIT парсить `*-[...]` як arbitrary value. Якщо закриваюча `]` відсутня — клас **тихо НЕ генерується**, CSS просто не з'являється; помилки збірки немає.

```tsx
// ❌ Невидима помилка — фокус-ring не з'являється
hasError && 'border-destructive focus:ring-[hsl(0_86%_93%)',

// ✅ Закрита дужка — клас працює
hasError && 'border-destructive focus:ring-[hsl(0_86%_93%)]',
```

При ручному кодуванні: перевіряй парність `[`/`]`; довгий клас винось у змінну (`const ringErr = 'focus:ring-[hsl(0_86%_93%)]'`); `/sto-review` grep'ає незакриті дужки.

### Blob URL — `revokeObjectURL` тільки через setTimeout

`URL.revokeObjectURL(url)` синхронно після `a.click()` зриває завантаження у Chromium (URL відкликається до fetch blob'а).

```tsx
// ❌ Зриває .xlsx завантаження в Chromium
const url = URL.createObjectURL(blob);
a.href = url;
a.download = 'file.xlsx';
a.click();
URL.revokeObjectURL(url);

// ✅ Дай браузеру час почати fetch
const url = URL.createObjectURL(blob);
a.href = url;
a.download = 'file.xlsx';
a.click();
setTimeout(() => URL.revokeObjectURL(url), 100);
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

### Зміна schema.prisma ЗАВЖДИ потребує міграції

> Правка `schema.prisma` оновлює лише типи Prisma client — НЕ базу. TS компілюється,
> але runtime fail при insert/select нового значення. **Кожна зміна → нова папка у `migrations/`.**

```sql
-- ❌ Додати enum value тільки у schema.prisma (PIT/RAMP) → insert type='PIT' впаде в runtime
-- ✅ Окремий файл migrations/YYYYMMDDHHMMSS_add_lift_type_pit_ramp/migration.sql:
ALTER TYPE "LiftType" ADD VALUE IF NOT EXISTS 'PIT';
ALTER TYPE "LiftType" ADD VALUE IF NOT EXISTS 'RAMP';
-- ADD VALUE — окремий файл (Postgres забороняє ADD VALUE + використання у одній транзакції)
```

### Заборонені операції

Hard delete, пряме оновлення `StockItem`/`SettlementAccount`, запит без `orgId` — див. §2 Service (правила 1-4). Специфічне для Prisma:

```typescript
// ❌ findMany без take (необмежена вибірка)
prisma.stockMovement.findMany({ where: { orgId } }); // може повернути мільйони рядків
// ✅
prisma.stockMovement.findMany({ where: { orgId }, take: limit, skip: offset });
```

---

## SSE (Server-Sent Events) — Real-time дані без WebSocket

```typescript
// ❌ Polling (зайве навантаження)
useEffect(() => {
  const id = setInterval(() => apiFetch('/dashboard/summary').then(setData), 30_000);
  return () => clearInterval(id);
}, []);

// ✅ SSE з reconnect + AbortController cleanup
useEffect(() => {
  const es = new EventSource('/api/dashboard/stream', {
    // withCredentials потрібен якщо auth через cookie
  });
  es.onmessage = (e) => setData(JSON.parse(e.data));
  es.onerror = () => { es.close(); }; // браузер авто-реконектиться за spec
  return () => es.close();
}, []);

// Backend (NestJS + Fastify) — SSE endpoint:
// ❌ НЕ використовувати @Sse() декоратор NestJS з Fastify — несумісно
// ✅ Реалізувати через Fastify reply напряму:
@Get('stream')
async stream(@Req() req: FastifyRequest, @Res() reply: FastifyReply) {
  reply.raw.setHeader('Content-Type', 'text/event-stream');
  reply.raw.setHeader('Cache-Control', 'no-cache');
  reply.raw.setHeader('Connection', 'keep-alive');
  reply.raw.flushHeaders();

  const send = (data: unknown) => reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);

  const interval = setInterval(async () => {
    const kpi = await this.dashboardService.getKpi(orgId);
    send(kpi);
  }, 30_000);

  req.raw.on('close', () => clearInterval(interval));
}
```

**Правила SSE:**

- Endpoint захищений JWT (НЕ `@Public()`) — token у query param або Authorization header
- Завжди `req.raw.on('close', cleanup)` — прибирати interval/subscription при відключенні клієнта
- Fallback у frontend: `if (!window.EventSource) { /* polling fallback */ }`
- SSE — тільки server→client; для client→server — окремий REST endpoint

---

## Optimistic UI — миттєвий відгук без очікування API

```typescript
// ❌ Блокуючий UX — кнопка disabled, чекаємо відповіді
const handleTransition = async (id: string, status: string) => {
  setSaving(id);
  await apiFetch(`/work-orders/${id}/transition`, {
    method: 'POST',
    body: JSON.stringify({ status }),
  });
  await load();
  setSaving(null);
};

// ✅ Optimistic update — відразу показуємо новий стан, rollback при помилці
const handleTransition = async (id: string, newStatus: string) => {
  const prev = items.find(i => i.id === id);
  // 1. Одразу оновлюємо UI
  setItems(items => items.map(i => (i.id === id ? { ...i, status: newStatus } : i)));
  try {
    await apiFetch(`/work-orders/${id}/transition`, {
      method: 'POST',
      body: JSON.stringify({ status: newStatus }),
    });
    // 2. Refetch для консистентності (side-effects на сервері)
    await load();
  } catch (e) {
    // 3. Rollback при помилці
    setItems(items => items.map(i => (i.id === id ? { ...i, status: prev!.status } : i)));
    if (features.toastEnabled)
      toast.error(`Помилка: ${e instanceof Error ? e.message : 'Невідома помилка'}`);
  }
};
```

**Правила Optimistic UI:**

- Зберігати `prev` state ПЕРЕД мутацією для rollback
- `setItems` з functional updater (не closure value) — щоб не затерти паралельні зміни
- Завжди робити `load()` після успіху — side-effects на сервері можуть змінити інші поля
- НЕ застосовувати до: фінансових операцій, FSM-переходів з критичними side-effects (WRITEOFF, CHARGE)

---

## Polymorphic entities — Comments, AuditLog, Media

```typescript
// Polymorphic relation через entityType + entityId (без FK):
model Comment {
  id          String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId       String   @db.Uuid
  entityType  String   // 'WorkOrder' | 'Counterparty' | 'Vehicle'
  entityId    String   @db.Uuid
  body        String
  authorId    String   @db.Uuid
  createdAt   DateTime @default(now())
  // НЕМАє deletedAt, updatedAt, syncVersion — append-only

  @@index([orgId, entityType, entityId, createdAt])
}

// ❌ НЕ використовувати nullable FK для polymorphism:
// workOrderId String? + counterpartyId String? — кожен новий тип = нова міграція

// ✅ entityType + entityId + @@index
// При запиті: WHERE "orgId" = $orgId AND "entityType" = 'WorkOrder' AND "entityId" = $id
```

**Правила polymorphic:**

- Завжди composite index `[orgId, entityType, entityId, createdAt]` — без нього повний scan
- `entityType` — константи в `@sto/shared/constants` (не magic strings у сервісах)
- Tenant isolation: завжди фільтрувати по `orgId` (entityId може випадково збігтись між org-ами)
- Append-only сутності (`Comment`, `AuditEvent`, `WorkOrderMedia`) — без `deletedAt`; hard limit по кількості (take: 100)

---

## Webhook pattern — вихідні нотифікації

```typescript
// Не блокувати основну транзакцію — webhook через BullMQ:
// ❌
await this.webhookService.deliver('WO_STATUS_CHANGED', payload); // може timeout 5s

// ✅
await this.webhookQueue.add(
  'deliver',
  { event: 'WO_STATUS_CHANGED', orgId, payload },
  {
    attempts: 5,
    backoff: { type: 'exponential', delay: 60_000 },
  },
);

// Processor — HMAC-підпис для безпеки:
const signature = crypto
  .createHmac('sha256', endpoint.secret)
  .update(JSON.stringify(payload))
  .digest('hex');

await fetch(endpoint.url, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-STO-Signature': `sha256=${signature}`,
    'X-STO-Event': event,
  },
  body: JSON.stringify(payload),
  signal: AbortSignal.timeout(10_000), // обов'язковий timeout
});
```

**Правила Webhook:**

- HMAC-підпис (`X-STO-Signature`) — клієнт верифікує через той самий secret
- `AbortSignal.timeout(10_000)` — без цього зависаємо на повільному клієнті
- Зберігати `WebhookDelivery` з response code і body (max 1KB) — для debug UI
- Max 5 спроб (менше ніж SMS/ПРРО) — webhook не фінансово-критичний
- `endpoint.isActive = false` якщо 5 поспіль провалів — авто-деактивація щоб не спамити

---

## Offline-first / BullMQ

```typescript
// ❌ Прямий виклик зовнішнього API
await this.smsService.send(phone, message); // впаде без інтернету

// ✅ Через BullMQ чергу — retry при відновленні
await this.smsQueue.add(
  'send',
  { phone, message },
  {
    attempts: 10,
    backoff: { type: 'exponential', delay: 60_000 },
  },
);
```

Зовнішні API що завжди через чергу: **TurboSMS**, **Checkbox (ПРРО)**, **постачальники прайсів**, **Cloud Sync**.

---

## Безпека

Cross-tenant scoping (`orgId` у кожному запиті) — див. §2 Service правило 1.

```typescript
// ❌ Сирий SQL з інтерполяцією
await this.prisma.$queryRaw(`SELECT * FROM users WHERE name = '${name}'`);

// ✅ Параметризований
await this.prisma.$queryRaw`SELECT * FROM users WHERE name = ${name}`;

// ❌ Raw SQL зі snake_case — Postgres folds unquoted identifiers до lowercase
// і НЕ знайде колонок Prisma (які створені double-quoted camelCase, бо schema без @map)
await this.prisma.$queryRaw`
  SELECT * FROM stock_items
  WHERE org_id = ${orgId}::uuid AND deleted_at IS NULL
`; // ← throws: column "org_id" does not exist

// ✅ Raw SQL з camelCase у подвійних лапках
await this.prisma.$queryRaw`
  SELECT * FROM stock_items
  WHERE "orgId" = ${orgId}::uuid AND "deletedAt" IS NULL
  LIMIT 500
`;

// ❌ Чутливі поля в response DTO
return { id, phone, edrpou, rateScheme, passwordHash }; // ← ніколи!

// ✅ Тільки потрібні поля
return { id, firstName, lastName, phone };
```

---

## Коментарі — коли і як

### ЗАБОРОНЕНО (видаляти при code review)

```typescript
// ❌ Bug/Issue/PR reference — не належить коду, належить commit message
// Bug #123: виправлено N+1 запит
// Fix #456: додано перевірку null
// Cycle 2/3 step 3 — ...

// ❌ Що робить очевидний код
// Знаходимо замовлення
const wo = await prisma.workOrder.findFirst(...)
// Повертаємо результат
return result;
// Фільтруємо видалені
where: { deletedAt: null }
// Increment counter
counter++;

// ❌ TODO без конкретного WHY або дедлайну
// TODO: рефакторити
// TODO: покращити продуктивність
// FIXME: не знаю чому це потрібно
```

### ДОЗВОЛЕНО (корисні коментарі)

```typescript
// ✅ Прихований constraint або інваріант
// SettlementAccount — singleton per counterparty, ніколи не видаляється (немає deletedAt)
const account = await prisma.settlementAccount.findFirst({ where: { counterpartyId } });

// ✅ Workaround з причиною (платформний баг, обмеження версії)
// SWC не резолвить tsconfig paths на Windows — залишати tsc builder

// ✅ DST/timezone пастка
// Kyiv offset +02/+03 залежно від DST — завжди Intl.DateTimeFormat, ніколи hardcode

// ✅ Security reasoning де неочевидно
// getOrThrow (не get) — fallback до відомого рядка дозволяє auth bypass в prod

// ✅ Postgres-специфічна поведінка
// ADD VALUE — окремий файл міграції: Postgres забороняє ADD VALUE + використання в одній транзакції
// camelCase у подвійних лапках: Postgres без quotes folds до lowercase (orgId → orgid)

// ✅ Performance invariant де неочевидно
// Module-level singleton: new Intl.DateTimeFormat() дорогий (locale init) — не в циклі

// ✅ Race condition guard
// Refs ensure handleModalClose sees sync state, not stale closure

// ✅ Явний timeout (пояснити чому нестандартний)
// explicit timeout 10s — COMPLETED транзакція робить N writeoff + N release + 1 charge
// при 50+ запчастинах це може зайняти > 5s default
await prisma.$transaction(async tx => { ... }, { timeout: 10_000 });

// ✅ TODO з конкретним WHY і умовою коли виправити
// Multi-branch gap: single-branch assumption — для multi-branch orgs потрібен resolve
// per-vehicle by lastWorkOrderBranchId або Organisation-level SMS config

// ✅ regression guard В ТЕСТАХ (тільки в *.spec.ts / *.test.ts)
// regression guard: якщо видалиш цей тест, Bug #NNN відтвориться мовчки
```

---

## Checklist перед здачею коду

```
TypeScript
  [ ] Немає `any` типів
  [ ] Немає `React.X` namespace без імпорту
  [ ] Немає `console.log`
  [ ] Enums з Prisma/shared, не magic strings
  [ ] Немає `// Bug #NNN:` коментарів (належать commit message, не коду)
  [ ] Немає коментарів що пояснюють ЩО (// Знаходимо, // Повертаємо, // Filter deleted)
  [ ] TODO залишені тільки якщо є конкретний WHY (обмеження, constraint, дедлайн)

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

UX/UI Features
  [ ] toast.X завжди за `if (features.toastEnabled)`
  [ ] Fallback на setError коли toast вимкнено
  [ ] useDirtyForm: resetDirty() після успішного збереження
  [ ] useInlineEdit: commitEdit завжди .catch(() => {})
  [ ] useBulkSelect: Promise.allSettled, не Promise.all
  [ ] bulkSelect.clear() + load() в finally-логіці bulk-операцій
  [ ] indeterminate checkbox через useRef+useEffect, не inline ref callback
  [ ] colSpan у loading/empty rows враховує bulkActionsEnabled
  [ ] useSavedFilters: Array.isArray guard при читанні localStorage
  [ ] NotificationCenter delete button: group/group-hover + focus:opacity-100
  [ ] onKeyDown на role="button" обгортках: guard e.target !== e.currentTarget
  [ ] Collapsible секція поза Modal: AnimatedBody з @/components/ui/modal, не maxHeight magic number

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

## §14 Модульність і Універсальність UI

> **Правило:** Перш ніж писати inline-логіку в page.tsx — запитай себе: "Це буде потрібно ще хоча б раз?"  
> Якщо так — одразу виносити в компонент. Один раз — inline припустимо.

### Коли виносити в компонент

| Патерн                            | Ознаки для винесення                      | Куди                            |
| --------------------------------- | ----------------------------------------- | ------------------------------- |
| Picker зі списком + пошуком       | `items[]` + `onSelect` + пошукове поле    | `<PickerModal<T>>`              |
| Форма створення/редагування       | 3+ поля + збереження + валідація          | `<XxxForm>` окремий файл        |
| Список з CRUD                     | таблиця + кнопки edit/delete              | `<XxxList>` або `<DataTable>`   |
| Підтвердження дії                 | "Видалити?", "Скасувати?"                 | `<ConfirmDialog>` (вже є)       |
| Бейдж статусу                     | кольоровий статус + лейбл                 | `<StatusBadge>`                 |
| Бейдж терміну (прострочено/скоро) | дата + поріг днів + червоний/жовтий badge | `<ExpiryBadge>` + `daysUntil()` |

### ExpiryBadge — канонічний бейдж "прострочено / скоро"

> **Шлях:** `apps/web/src/components/ui/expiry-badge.tsx` + helper `daysUntil()` у `lib/utils.ts`
> Будь-яка логіка "скільки днів до дати → червоний/жовтий бейдж" (страховка, техогляд, ТО, гарантія).

```tsx
// ✅ Один компонент — конфігуровані лейбли + поріг
import { ExpiryBadge } from '@/components/ui/expiry-badge';
<ExpiryBadge date={vehicle.insuranceExpiry} nowMs={today?.getTime() ?? 0} expiredLabel="Страховка прострочена" />
<ExpiryBadge date={sc.nextMaintenanceDate} nowMs={nowMs} expiredLabel="Прострочено" soonLabel="Незабаром" soonDays={14} />

// ✅ Лише обчислення без бейджа — helper
import { daysUntil } from '@/lib/utils';
const diff = daysUntil(date, nowMs);            // number | null (null = немає дати / nowMs=0)
const isSoon = diff !== null && diff <= 30;

// ❌ НЕ inline-IIFE: дубльована математика дати + червоний/жовтий <span> у JSX
{today && (() => {
  const diffDays = Math.ceil((new Date(date).getTime() - today.getTime()) / 86_400_000);
  if (diffDays < 0) return <span className="...bg-destructive-subtle...">Прострочено</span>;
  if (diffDays <= 30) return <span className="...bg-warning-subtle...">Скоро</span>;
  return null;
})()}
```

> `nowMs` завжди з `useState`/`useEffect` (SSR-safe), ніколи `new Date()` у render. `nowMs=0` → бейдж не рендериться (дані ще не готові).

### PickerModal — канонічний компонент для вибору зі списку

> **Шлях:** `apps/web/src/components/ui/picker-modal.tsx`  
> Використовується коли потрібно вибрати одну сутність зі списку з пошуком по реквізитах.

```tsx
// ✅ Завжди використовуй PickerModal для вибору сутності зі списку
import { PickerModal } from '@/components/ui/picker-modal';

<PickerModal<BankAccount>
  open={pickerOpen}
  onClose={() => setPickerOpen(false)}
  title="Оберіть банківський рахунок"
  items={bankAccounts}
  selectedId={form.bankAccountId}
  searchKeys={['name', 'ibanUA', 'bankName', 'mfo', 'edrpou']}
  searchPlaceholder="Пошук за назвою, IBAN, МФО..."
  emptyText="Рахунки не додано"
  onSelect={(b) => { setForm(f => ({ ...f, bankAccountId: b.id })); }}
  renderItem={(b) => (
    <>
      <div className="font-medium text-foreground text-sm">{b.name}</div>
      <div className="font-mono text-xs text-muted-foreground">{b.ibanUA}</div>
    </>
  )}
/>

// ❌ НЕ робити inline Modal зі своїм пошуком
<Modal open={open} ...>
  <Input value={q} onChange={...} />
  {items.filter(...).map(item => <button .../>)}
</Modal>
```

**Тригер поле — завжди через `EntityPickerField`** (повний патерн і заборона ручної кнопки — §24).

### Заборонені inline-патерни

```tsx
// ❌ Пошук реалізований через IIFE в JSX
{
  (() => {
    const q = query.trim().toLowerCase();
    const filtered = items.filter(i => i.name.toLowerCase().includes(q));
    return filtered.map(i => <button key={i.id}>...</button>);
  })();
}

// ❌ Стан picker-модалу дублюється для кожного поля (pickerQuery1, pickerQuery2...)
const [pickerQuery, setPickerQuery] = useState(''); // не потрібен — PickerModal керує сам

// ❌ Логіка форми живе у page.tsx якщо форма > 5 полів
// → виносити в src/components/{domain}/{Domain}Form.tsx
```

### Checklist перед здачею UI-коду

```
Компоненти
  [ ] Picker зі списком → <SearchPickerModal<T>> або <PickerModal<T>>
  [ ] Поле-посилання → <EntityPickerField> (НЕ кастомна кнопка з Search іконкою)
  [ ] Лупа у EntityPickerField → відкриває *EditModal, НЕ router.push/window.open
  [ ] Форма редагування об'єкта → окремий *EditModal компонент (не inline у page.tsx)
  [ ] *EditModal зареєстрований у реєстрі §24.4
  [ ] Inline IIFE `{(() => {...})()}` у JSX → замінити компонентом
  [ ] Форма > 5 полів у page.tsx → виносити в окремий файл
  [ ] Підтвердження дії → <ConfirmDialog>

Стан
  [ ] Немає дубльованих query/loading стейтів для однотипних picker-ів
  [ ] pickerQuery НЕ є зовнішнім стейтом — SearchPickerModal/PickerModal керує пошуком сам
  [ ] lazy fetch у openDetail() — не у useEffect на mount
```

---

## §25 — DRY: хуки і компоненти як єдине місце правди

> **Правило:** Якщо один і той самий блок коду (useState+useEffect, JSX-секція) зустрічається у 2+ файлах — виносити в хук або компонент. Завжди.

---

### §25.1 — useBulkIndeterminate: замість 7-рядкового блоку

**Проблема:** у кожній list-сторінці дублювалось:

```ts
const bulkSelect = useBulkSelect(items);
const selectAllRef = useRef<HTMLInputElement | null>(null);
useEffect(() => {
  if (selectAllRef.current) selectAllRef.current.indeterminate = bulkSelect.someSelected;
}, [bulkSelect.someSelected]);
```

**Рішення:** `hooks/useBulkIndeterminate.ts`

```ts
// ✅ Один рядок замість 7
const { selectAllRef, ...bulkSelect } = useBulkIndeterminate(items);
```

**Правило:** `useBulkIndeterminate` завжди після React Query виклику — так `items` вже має стабільну ref.

---

### §25.2 — useCachedRefData: замість 25-рядкового ref-cache патерну

**Проблема:** паттерн `getCached → show stale → fetch → setCache → setState` повторювався у 5+ місцях.

**Рішення:** `hooks/useCachedRefData.ts`

```ts
// ✅ Замість 25 рядків — 1 рядок
const { data: branches } = useCachedRefData<Branch[]>('cache:branches', '/branches', []);

// З трансформом (якщо API повертає { items: T[] })
const { data: brands } = useCachedRefData(
  'cache:brands',
  '/brands?limit=200',
  [],
  raw => (raw as { items: Brand[] }).items,
);
```

**Коли НЕ використовувати:** якщо після завантаження є side-effect (`setForm(f => ({ ...f, branchId: bs[0].id }))`). В такому випадку залишати оригінальний `useEffect` з `getCached`/`setCache`.

---

### §25.3 — useListPage: спільна інфраструктура list-сторінок

**Проблема:** кожна list-сторінка повторювала 7+ хуків:

```ts
const features = useUiFeatures();
const [page, setPage] = useState(1);
const [showDeleted, setShowDeleted] = useState(false);
const tableColumns = useTableColumns(pageKey, COLUMNS);
const { dragProps } = useColumnDrag(...);
const detailPanel = useDetailPanel(pageKey);
const panelConfig = useDetailPanelConfig(`${pageKey}-panel`);
const savedFilters = useSavedFilters<TFilters>(pageKey);
const [activeSavedFilterId, setActiveSavedFilterId] = useState(null);
```

**Рішення:** `hooks/useListPage.ts` — один виклик замість 9:

```ts
// ✅ Generic TFilters для типізованого savedFilters
const {
  page, setPage, resetPage,
  showDeleted, setShowDeleted,
  activeSavedFilterId, setActiveSavedFilterId,
  tableColumns: { visibleColumns, orderedColumns, toggle: toggleCol, ... },
  dragProps,
  detailPanel, panelConfig,
  savedFilters: { saved, save, remove },
  features,
  limit,
} = useListPage<InvoiceFilters>('invoices', INVOICE_COLUMNS, { defaultLimit: 20 });
```

**Порядок викликів (обов'язковий):**

```ts
// 1. useListPage — не залежить від items
const lp = useListPage<TFilters>(pageKey, COLUMNS);

// 2. Специфічні фільтри сторінки
const [status, setStatus] = useState('');

// 3. React Query — використовує page/limit/showDeleted з useListPage
const { data } = useXxx({ page: lp.page, limit: lp.limit, ... });
const items = data?.items ?? EMPTY_ITEMS;

// 4. useBulkIndeterminate — ПІСЛЯ items (стабільна ref)
const { selectAllRef, ...bulkSelect } = useBulkIndeterminate(items);
```

---

### §25.4 — Розбиття моноліту: коли файл > 400 рядків

**Правило:** файл > 400 рядків → шукати природні межі для розбиття.

**Рецепт для великих компонентів:**

```
page.tsx (1500+ рядків)
  ↓ виносити
hooks/useXxxState.ts     ← весь useState, useEffect, handlers
XxxSection.tsx           ← окрема секція JSX (таблиця, галерея, etc.)
XxxModal.tsx             ← модальна форма в components/ui/
page.tsx (200-400 рядків) ← тільки orchestration + рендер view-режимів
```

**Конкретні патерни (реалізовано в STO ERP):**

| Компонент                         | До          | Після                                                                |
| --------------------------------- | ----------- | -------------------------------------------------------------------- |
| `GoodEditModal.tsx`               | 1352 рядки  | 522 (контейнер) + `GoodBarcodeTab` + `GoodBatchesTab` + `GoodUoMTab` |
| `work-orders/[id]/PageClient.tsx` | 1579 рядків | 1252 (orchestrator) + 4 `*Section.tsx`                               |
| `calendar/page.tsx`               | 1518 рядків | 239 (thin render) + `useCalendarState.ts` + `CalendarDayGrid.tsx`    |

**Правило для tab-компонентів:**

```ts
// Кожна ModalTabs вкладка → окремий компонент
// Props: goodId + orgId + onCountChange (для badge у ModalTabs)
<GoodBarcodeTab goodId={good.id} onCountChange={n => setBarcodeCount(n)} />
<GoodBatchesTab goodId={good.id} />
<GoodUoMTab goodId={good.id} onChanged={() => refetch()} />
```

**Підхід для секцій сторінки:**

- Props-drilling (не Context) — дані завантажені в orchestrator, передаємо явно
- `onChanged` callback → orchestrator робить refetch або оновлює стан
- Кожна секція — самодостатня для рендеру, не для fetch

---

### §25.5 — Константи в одному місці: packages/shared

**Дублювати заборонено.** Всі labels/badges для статусів і типів — в `packages/shared/src/constants/statuses.ts`.

| Що                                          | Де НЕ визначати                                        | Де визначати  |
| ------------------------------------------- | ------------------------------------------------------ | ------------- |
| `WO_STATUS_LABELS`, `INVOICE_STATUS_LABELS` | `page.tsx`                                             | `@sto/shared` |
| `COUNTERPARTY_TYPE_LABELS/BADGE`            | `counterparties/page.tsx`, `CounterpartyEditModal.tsx` | `@sto/shared` |
| `CONTRACT_TYPE_LABELS`                      | `[id]/PageClient.tsx`                                  | `@sto/shared` |
| `GOOD_TYPE_LABELS/BADGE`                    | `GoodsTab.tsx`                                         | `@sto/shared` |

```ts
// ✅ Завжди
import { COUNTERPARTY_TYPE_LABELS, COUNTERPARTY_TYPE_BADGE } from '@sto/shared';
const TYPE_LABELS = COUNTERPARTY_TYPE_LABELS; // alias для зворотної сумісності

// ❌ НЕ визначати inline
const TYPE_LABELS: Record<string, string> = { CLIENT: 'Клієнт', ... };
```

---

### §25.6 — Backend: спільні utils замість дублікатів

```ts
// ✅ common/utils/math.ts
import { safeCoeff } from '../../common/utils/math';
// Замість копій функції в work-orders.service.ts та invoices.service.ts

// ✅ common/utils/fsm.ts
import { assertFsmTransition } from '../../common/utils/fsm';
assertFsmTransition(WORK_ORDER_TRANSITIONS, wo.status, newStatus);
// Замість 4-рядкового блоку в 4 сервісах
```

**Що іде в `common/utils/`:**

- Математичні хелпери (`safeCoeff`)
- FSM валідація (`assertFsmTransition`)
- Дата/час (`kyivToday` — вже є)
- Security guards (`validatePublicUrl` — вже є)

**Що НЕ іде в `common/`:** бізнес-логіка (вона залишається в модулях).

---

### §25.7 — Checklist DRY-рефакторингу

```
Перед написанням нового коду:
  [ ] Чи є цей паттерн вже в hooks/ ? Якщо так — використати
  [ ] Чи є ця константа вже в @sto/shared ? Якщо так — імпортувати
  [ ] Чи буде ця логіка потрібна ще раз? Якщо так — виносити зразу

Після написання:
  [ ] Файл > 400 рядків → знайти природні межі для розбиття
  [ ] Однаковий блок 2+ разів → витягти в хук або компонент
  [ ] Label/badge константа не в shared → перенести
```

---

## §18 — Modal + ModalTabs для 1-N зв'язків

### §18.1 — Структура Edit Modal з ModalTabs

Коли сутність має 1+ дочірніх колекцій (контрагент → авто, товар → штрихкоди), організуй edit modal за цим паттерном:

```tsx
// ✅ Правильна організація: основна форма + ModalTabs нижче
<Modal open={modal} onClose={closeModal} size="lg" title="Редагування X">
  {/* 1) Основні поля форми — завжди видимі */}
  <form className="space-y-4" onSubmit={e => e.preventDefault()}>
    <Input label="Назва" value={form.name} onChange={...} />
    {/* ...інші поля... */}
    {error && <p className="text-sm text-destructive-text">{error}</p>}
  </form>

  {/* 2) ModalTabs — тільки при редагуванні (не при створенні) */}
  {editingItem && (
    <ModalTabs
      tabs={[
        {
          key: 'children',
          label: 'Дочірні об'єкти',
          icon: <SomeIcon className="h-3.5 w-3.5" />,
          count: modalChildren.length,
          content: (
            <div className="space-y-3">
              {/* Loading / Error / Empty / List */}
            </div>
          ),
        },
        // ... інші вкладки
      ]}
    />
  )}

  {/* 3) Footer кнопки — після ModalTabs, у Modal footer */}
</Modal>
```

**State для дочірньої колекції:**

```ts
// По одному блоку на кожну дочірню колекцію:
const [modalChildren, setModalChildren] = useState<Child[]>([]);
const [modalChildrenLoading, setModalChildrenLoading] = useState(false);
const [childError, setChildError] = useState('');
const modalChildReqRef = useRef(0); // race guard (обов'язковий!)
```

**PATCH + оновлення списку після мутації:**

```ts
// Після успішного PATCH основних даних:
setItems(prev => prev.map(i => (i.id === editingItem.id ? { ...i, ...updated } : i)));
// Після POST нового дочірнього елемента:
setModalChildren(prev => [...prev, created]);
// Після DELETE дочірнього елемента:
setModalChildren(prev => prev.filter(c => c.id !== deletedId));
```

### §18.2 — Loading/Error в контенті вкладки

Loading і error показуються **у tab.content**, не на рівні ModalTabs:

```tsx
content: (
  <div className="space-y-3">
    {/* Loading state */}
    {childrenLoading && (
      <div className="py-6 text-center text-sm text-muted-foreground">Завантаження...</div>
    )}

    {/* Error state */}
    {!childrenLoading && childError && (
      <div className="rounded-lg border border-destructive/30 bg-destructive-subtle px-3 py-2 text-sm text-destructive-text">
        {childError}
      </div>
    )}

    {/* Empty state */}
    {!childrenLoading && !childError && children.length === 0 && (
      <p className="text-[13px] text-muted-foreground text-center py-4">Нічого не знайдено</p>
    )}

    {/* List */}
    {!childrenLoading && !childError && children.length > 0 && (
      <div className="rounded-xl border border-border overflow-hidden">
        <table className="w-full text-[13px]">
          {/* ... */}
        </table>
      </div>
    )}
  </div>
),
```

**count у вкладці** — обчислюється з поточного state (не від API):

```tsx
count: modalChildren.length,  // оновлюється в реальному часі при add/delete
```

**Умовні вкладки** (показуємо лише якщо дані завантажені):

```tsx
tabs={[
  mainTab,
  ...(editingItem ? [childrenTab] : []),
  ...(editingItem && showBatches ? [batchesTab] : []),
]}
```

### §18.3 — Race guard + скидання стану при відкритті

`openEdit` в event handler → race guard: `const reqId = ++modalChildReqRef.current` + перевірка `if (modalChildReqRef.current !== reqId) return` в `.then/.catch/.finally`.

- Скидати `setModalChildren([])` + `setChildError('')` при відкритті (до fetch)
- Декілька колекцій → окремий reqRef для кожної; fetch паралельно через `Promise.all`
- ❌ `.catch(() => {})` — ковтає помилку; завжди `setChildError(err.message)`

### §18.4 — AnimatedBody: плавна зміна висоти Modal та collapsible-секцій

`<Modal>` анімує висоту автоматично. Для collapse-секцій поза Modal: `import { AnimatedBody } from '@/components/ui/modal'`; `{isOpen && <AnimatedBody className="px-4 py-3">{children}</AnimatedBody>}`.

- ❌ `maxHeight: '900px'` — magic number; ❌ `transition: 'max-height ...'` без ResizeObserver
- ✅ Для анімації 0↔контент з close: `outerRef`+`innerRef` + `ResizeObserver` + rAF закриття
- Приклад: `apps/web/src/app/calendar/page.tsx` (showAdd → formMounted/formVisible)

---

## §15 Schema-driven UI (metadata-driven rendering)

> **Правило:** Будь-який список полів для відображення в UI **ніколи не хардкодиться** в page.tsx.  
> Поля описуються один раз у схемі поряд з TypeScript типом — і рендеряться автоматично.

### Коли застосовувати

| Сценарій                              | Рішення                                            |
| ------------------------------------- | -------------------------------------------------- |
| Detail Panel з 3+ полями              | `PanelFieldDef<T>[]` + `buildPanelFields()`        |
| Конфігурований список реквізитів      | schema + `useDetailPanelConfig`                    |
| Нова сторінка з інформаційною панеллю | Схема в `lib/panel-schema.ts`, НЕ масив у page.tsx |

### Структура

**`apps/web/src/lib/panel-schema.ts`** — єдине місце правди для всіх схем.

```typescript
// 1. Схема — satisfies гарантує що key існує в типі T
export const INVOICE_PANEL_SCHEMA = [
  { key: 'status',          label: 'Статус',       always: true }, // always=true — не ховати
  { key: 'counterpartyName',label: 'Контрагент' },
  { key: 'amount',          label: 'Сума',          type: 'money' }, // auto fmtMoney()
  { key: 'dueDate',         label: 'Термін оплати', type: 'date' },  // auto fmtDate()
  { key: 'notes',           label: 'Нотатки' },
] as const satisfies readonly PanelFieldDef<Invoice>[];

// 2. Рендеринг у page.tsx — замість N окремих <PanelField>
{buildPanelFields(inv, INVOICE_PANEL_SCHEMA, panelConfig.config, {
  // renderOverrides — тільки для полів що потребують Badge/кольорів
  status: v => <Badge variant={STATUS_BADGE[String(v)]}>{STATUS_LABELS[String(v)]}</Badge>,
}).map(f => (
  <PanelField key={f.key} fieldKey={f.key} label={f.label} value={f.value} hidden={f.hidden} />
))}

// 3. configFields у <DetailPanel> — через schemaToPanelConfigFields
<DetailPanel
  configFields={schemaToPanelConfigFields(INVOICE_PANEL_SCHEMA, panelConfig.config)}
  onToggleField={panelConfig.toggleField}
  onReorderFields={panelConfig.reorderFields}
  onReset={panelConfig.reset}
/>
```

### Типи полів (type)

| type             | Форматування                            |
| ---------------- | --------------------------------------- |
| `text` (default) | `String(value)`                         |
| `money`          | `fmtMoney(value) + ' ₴'`                |
| `date`           | `fmtDate(value)`                        |
| `datetime`       | `fmtDateTime(value)`                    |
| `number`         | `String(value)`                         |
| `node`           | власний `render()` або `renderOverride` |

### renderOverrides vs render у схемі

- **`renderOverrides`** (передається в `buildPanelFields`) — для per-сторінкової кастомізації (Badge, кольори що залежать від локальних констант)
- **`render` у схемі** — для кастомізації що не залежить від page-контексту (уникай, бо schema.ts не має доступу до React компонентів)

### useDetailPanelConfig — що повертає

```typescript
const panelConfig = useDetailPanelConfig('invoices-panel'); // ключ унікальний per-сторінка

panelConfig.config; // { hiddenFields: string[], fieldOrder: string[] }
panelConfig.isFieldHidden; // (key) => boolean — для прямих перевірок
panelConfig.toggleField; // (key) => void
panelConfig.reorderFields; // (newOrder: string[]) => void
panelConfig.reset; // () => void
```

Стан зберігається в `localStorage` + синхронізується з API `/user-preferences/{pageKey}`.

### Як додати нове поле в майбутньому

Тільки в `lib/panel-schema.ts` — додати рядок у відповідну схему:

```typescript
{ key: 'newField', label: 'Нова назва', type: 'text' }
```

Поле автоматично з'являється в панелі, доступне для toggle/reorder — **жодних змін у page.tsx**.

### ❌ Заборонено

```typescript
// ❌ Хардкод масиву полів у page.tsx
const MY_PANEL_FIELDS = [
  { key: 'status', label: 'Статус' },
  { key: 'amount', label: 'Сума' },
] as const;

// ❌ Вручну перебирати поля без buildPanelFields
<PanelField hidden={panelConfig.isFieldHidden('status')} fieldKey="status" label="Статус" value={...} />
<PanelField hidden={panelConfig.isFieldHidden('amount')} fieldKey="amount" label="Сума" value={...} />
// (якщо полів 5+ — це вже порушення)
```

### ✅ Правильно

```typescript
// ✅ Схема в lib/panel-schema.ts, рендер через buildPanelFields
{buildPanelFields(record, MY_SCHEMA, panelConfig.config).map(f => (
  <PanelField key={f.key} fieldKey={f.key} label={f.label} value={f.value} hidden={f.hidden} />
))}
```

---

## §16 SharedStatusConstants — єдине місце для статусів

`STATUS_LABELS`, `STATUS_BADGE`, `PRIORITY_LABELS` — тільки в `packages/shared/src/constants/statuses.ts`. `Record<WorkOrderStatus, string>` → compile-error при пропущеному статусі.
`import { WO_STATUS_LABELS, WO_STATUS_BADGE } from '@sto/shared'` — НЕ inline у page.tsx.

---

## §17 usePaginatedList — generic API hook factory

Новий list-хук: `return usePaginatedList<WorkOrder, WorkOrdersFilter>('/work-orders', filters)` — НЕ вручну URLSearchParams boilerplate. Файл: `apps/web/src/hooks/api/usePaginatedList.ts`

---

## §19 FSMButtons — shared компонент FSM-переходів

> **Правило:** Кнопки FSM-переходів не рендеряться inline у page.tsx. Використовується `<FSMButtons>`.

### ❌ Заборонено

```typescript
// ❌ Дублювання логіки у кожній сторінці
{STATUS_TRANSITIONS[item.status]?.map(s => (
  <Button key={s} variant={s === 'CANCELLED' ? 'destructive' : 'outline'} onClick={() => handleTransition(s)}>
    {TRANSITION_LABELS[s]}
  </Button>
))}
```

### ✅ Правильно

```tsx
// apps/web/src/components/ui/fsm-buttons.tsx
<FSMButtons
  status={wo.status}
  transitions={WO_FSM_TRANSITIONS}
  labels={WO_TRANSITION_LABELS}
  onTransition={handleTransition}
  loading={saving}
/>
```

**Файл:** `apps/web/src/components/ui/fsm-buttons.tsx`

---

## §20 useApiMutation — wrapper для мутацій

Нова форма/дія: `const { mutate, saving, error } = useApiMutation(fn, { onSuccess: load, successMsg: 'Збережено' })` — НЕ вручну saving/error state + try/catch. Файл: `apps/web/src/hooks/useApiMutation.ts`

---

## §21 Shared Zod validators

> **Правило:** Валідаційні правила (email, телефон, IBAN) не пишуться regex inline. Є `@sto/shared` validators.

### ✅ Правильно

```typescript
// packages/shared/src/schemas/validators.ts
export const phoneUaSchema = z.string().regex(/^\+380\d{9}$/, 'Невірний формат телефону');
export const emailSchema = z.string().email('Невірний email');
export const ibanUaSchema = z.string().regex(/^UA\d{27}$/, 'Невірний IBAN');

// У фронт-формі:
import { phoneUaSchema } from '@sto/shared';
const schema = z.object({ phone: phoneUaSchema });

// На бекенді (DTO):
import { PHONE_UA_REGEX } from '@sto/shared';
@Matches(PHONE_UA_REGEX, { message: 'Невірний формат телефону' })
phone: string;
```

**Файл-джерело правди:** `packages/shared/src/schemas/validators.ts`

---

## §22 useApiError — централізований handler помилок

`const { error, handleError, clearError } = useApiError()` — НЕ вручну `useState('')` + `catch(e) { setError(e.message) }`. Файл: `apps/web/src/hooks/useApiError.ts`

---

## §23 TableContainer — контейнер таблиці зі sticky-шапкою

### Правило

**ЗАВЖДИ** загортати `<Table>` у `<TableContainer>` замість inline div.

### ❌ Заборонено

```tsx
<div className="flex-1 min-h-0 min-w-0 overflow-auto bg-surface border border-border rounded-xl">
  <Table>...</Table>
</div>
```

### ✅ Правильно

```tsx
import { TableContainer } from '@/components/ui/table-container';

<div className="flex flex-1 min-h-0">
  <TableContainer>
    <Table>
      <TableHeader>...</TableHeader>
      <TableBody>...</TableBody>
    </Table>
  </TableContainer>
</div>;
```

### Чому

`TableContainer` додає клас `table-scroll-container`, який вирішує два візуальних баги шапки (CSS у globals.css):

```css
:root {
  --table-thead-h: 33px;
}
/* 1. Трек скролбара починається нижче шапки */
.table-scroll-container::-webkit-scrollbar-track {
  margin-top: var(--table-thead-h);
}
/* 2. Гатер скролбара = колір шапки, рядки перекривають до surface */
.table-scroll-container {
  background-color: var(--color-secondary);
}
.table-scroll-container tbody {
  background-color: var(--color-surface);
}
```

❌ Без `TableContainer` — справа від шапки білий простір (видно фон контейнера).  
✅ З `TableContainer` — фон за скролбаром збігається з кольором thead.

### Props

| Prop             | Default | Опис                                        |
| ---------------- | ------- | ------------------------------------------- |
| `constrainWidth` | `true`  | Додає `min-w-0` для правильного flex-shrink |
| `className`      | —       | Перевизначення стилів                       |

```tsx
{/* Без min-w-0 (рідко, тільки без DetailPanel поряд) */}
<TableContainer constrainWidth={false}>

{/* Кастомний стиль */}
<TableContainer className="rounded-none border-0">
```

### Висота шапки змінилась?

Якщо thead має нестандартну висоту (двохрядкова шапка, інший padding) — перевизначи CSS-змінну на конкретному контейнері:

```tsx
<TableContainer style={{ '--table-thead-h': '52px' } as React.CSSProperties}>
```

---

## §24 — EntityPickerField + \*EditModal: стандарт поля-посилання

> **Правило:** будь-яке поле форми що посилається на інший об'єкт (контрагент, товар, наряд, співробітник тощо) **ЗАВЖДИ** реалізується через `EntityPickerField` + `*EditModal` + `SearchPickerModal`.  
> Старий патерн «велика кнопка з іконкою Search всередині» — **заборонений**.

---

### §24.1 — EntityPickerField — єдиний UI-контрол для reference-поля

```tsx
// apps/web/src/components/ui/entity-picker-field.tsx
interface EntityPickerFieldProps {
  display: string; // текст обраного запису або ''
  placeholder?: string; // 'Обрати...'
  disabled?: boolean;
  hidePick?: boolean; // true =ховати кнопку ... (read-only режим)
  onOpenDetail?: () => void; // undefined → кнопка 🔍 disabled
  onPick: () => void; // відкрити SearchPickerModal
  onClear: () => void; // очистити вибір
}
```

**Візуальна схема:**

```
[ Іван Коваль                   × 🔍 … ]
  ↑ display або placeholder     ↑ ↑ ↑
                                │ │ └─ onPick → SearchPickerModal
                                │ └─── onOpenDetail → *EditModal (disabled якщо нема)
                                └───── onClear (hidden якщо display = '')
```

**Кнопка `UserPlus` / `FilePlus` (створення нового)** — додається ЗОВНІ поля, праворуч:

```tsx
<div className="flex items-center gap-1">
  <div className="flex-1 min-w-0">
    <EntityPickerField ... />
  </div>
  <Button variant="outline" size="sm" onClick={openCreateWizard} className="h-9 w-9 p-0 shrink-0">
    <UserPlus className="h-4 w-4" />
  </Button>
</div>
```

---

### §24.2 — \*EditModal — стандарт компонента редагування об'єкта

Кожна сутність через лупу → окремий `*EditModal.tsx` у `apps/web/src/components/ui/`.

Props: `{ open, entity: XxxForModal | null, onClose, onSaved }` — `null` = режим створення.

Внутрішня структура:

1. `useEffect([open, entity?.id])` — синхронізація форми, `dirty.resetDirty()`, `setError('')`
2. `useEffect([open, entity?.id])` — завантаження дочірніх з race guard (`reqRef.current`)
3. `handleClose` → `dirty.confirmClose()` перед `onClose()`
4. `<DirtyConfirmDialog {...dirty.dialogProps} />` + `<ConfirmDialog {...confirmProps} />` у return

---

### §24.3 — Повний патерн: reference-поле у формі

```ts
// State
const [cpPickerOpen, setCpPickerOpen] = useState(false);
const [cpDetailOpen, setCpDetailOpen] = useState(false);
const [cpDetailData, setCpDetailData] = useState<CounterpartyForModal | null>(null);

// lazy fetch
const openCpDetail = useCallback(async () => {
  if (!form.counterpartyId) return;
  const cp = await apiFetch<CounterpartyForModal>(`/counterparties/${form.counterpartyId}`);
  setCpDetailData(cp); setCpDetailOpen(true);
}, [form.counterpartyId]);

// JSX
<EntityPickerField
  display={form.counterpartyDisplay} placeholder="Обрати контрагента..."
  onOpenDetail={form.counterpartyId ? openCpDetail : undefined}
  onPick={() => setCpPickerOpen(true)}
  onClear={() => setForm(f => ({ ...f, counterpartyId: '', counterpartyDisplay: '' }))}
/>
<SearchPickerModal<CpItem> open={cpPickerOpen} onClose={() => setCpPickerOpen(false)}
  title="Оберіть контрагента" selectedId={form.counterpartyId}
  fetchItems={fetchCpItems}
  onSelect={item => { setForm(f => ({ ...f, counterpartyId: item.id, counterpartyDisplay: item.primary })); setCpPickerOpen(false); }}
/>
<CounterpartyEditModal open={cpDetailOpen} counterparty={cpDetailData}
  onClose={() => setCpDetailOpen(false)}
  onSaved={u => { setForm(f => ({ ...f, counterpartyDisplay: u.companyName ?? '' })); setCpDetailOpen(false); }}
/>
```

---

### §24.4 — Реєстр \*EditModal компонентів

| Компонент                  | Файл                              | Відкривається для                  |
| -------------------------- | --------------------------------- | ---------------------------------- |
| `CounterpartyEditModal`    | `ui/CounterpartyEditModal.tsx`    | контрагент (клієнт / постачальник) |
| `GoodEditModal`            | `ui/GoodEditModal.tsx`            | товар / запчастина                 |
| `EmployeeEditModal`        | `ui/EmployeeEditModal.tsx`        | співробітник                       |
| `WorkOrderAddLineModal`    | `ui/WorkOrderAddLineModal.tsx`    | додавання роботи до наряду         |
| `WorkOrderAddPartModal`    | `ui/WorkOrderAddPartModal.tsx`    | додавання запчастини до наряду     |
| `PurchaseOrderCreateModal` | `ui/PurchaseOrderCreateModal.tsx` | замовлення постачальнику           |
| `InvoiceCreateModal`       | `ui/InvoiceCreateModal.tsx`       | рахунок                            |
| `StockDocumentCreateModal` | `ui/StockDocumentCreateModal.tsx` | документ складу                    |

> При додаванні нової сутності — додай рядок у цю таблицю.

---

### §24.5 — Заборонені патерни

```tsx
// ❌ Пряме посилання через window.open або router.push з форми
onClick={() => window.open(`/counterparties/${id}`, '_blank')}
onClick={() => router.push(`/counterparties/${id}`)}
// ✅ Замість цього — openDetail() → *EditModal

// ❌ Велика кнопка з іконкою Search всередині (старий патерн)
<button onClick={() => setPickerOpen(true)} className="flex-1 flex items-center justify-between ...">
  <span>{display || 'Обрати...'}</span>
  <Search className="h-3.5 w-3.5" />
</button>
// ✅ Замість цього — EntityPickerField

// ❌ Inline форма редагування > 5 полів у page.tsx
<Modal open={editModal} ...>
  <Input label="Назва" ... />
  <Input label="Телефон" ... />
  ...300 рядків JSX...
</Modal>
// ✅ Виноси в окремий *EditModal компонент

// ❌ detailHref prop (застарілий, видалений)
<EntityPickerField detailHref="/counterparties/123" />
// ✅ onOpenDetail callback
<EntityPickerField onOpenDetail={form.counterpartyId ? openCpDetail : undefined} />
```

---

### §24.6 — Checklist для нового reference-поля

```
[ ] Поле відображається через EntityPickerField, не через кастомну кнопку
[ ] Кнопка … відкриває SearchPickerModal для пошуку і вибору
[ ] Кнопка 🔍 disabled якщо нема вибраного (onOpenDetail = undefined)
[ ] Кнопка 🔍 робить lazy fetch + відкриває *EditModal
[ ] Кнопка × очищає вибір (hidden якщо display = '')
[ ] Якщо є дія "створити новий" — кнопка UserPlus/FilePlus ЗОВНІ поля
[ ] *EditModal для цього типу об'єкта існує в реєстрі §24.4
[ ] onSaved оновлює display у батьківській формі
[ ] TypeScript 0 errors
```

---

## §26 Settings Tab — стандарт вкладки налаштувань

### Структура файлу

```
apps/web/src/app/(app)/settings/
├── page.tsx          ← реєстрація вкладки (Tab type + TABS array + рендер)
├── shared.ts         ← OrgSettings / BranchSettings типи
└── XxxTab.tsx        ← окремий файл на кожну вкладку
```

**Реєстрація вкладки в `page.tsx`:**

```typescript
// 1. dynamic import (ssr: false — всі вкладки налаштувань)
const DocumentsTab = dynamic(() => import('./DocumentsTab'), { ssr: false });

// 2. розширити Tab union
type Tab = 'numbers' | 'workdays' | 'documents' | ...;

// 3. додати до TABS array (порядок = порядок у UI)
{ key: 'documents', label: 'Налаштування документів' },

// 4. рендер
{tab === 'documents' && <DocumentsTab />}
```

### Шаблон вкладки (XxxTab.tsx)

```tsx
'use client';
import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import { toast } from '@/lib/toast';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { type OrgSettings } from './shared';

// Toggle — локальний компонент (не виноси в shared, кожна вкладка незалежна)
function Toggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors',
        checked ? 'bg-primary' : 'bg-border',
        disabled && 'opacity-50 cursor-not-allowed',
      )}
    >
      <span
        className={cn(
          'inline-block h-4 w-4 rounded-full bg-surface shadow transform transition-transform mt-0.5',
          checked ? 'translate-x-4' : 'translate-x-0.5',
        )}
      />
    </button>
  );
}

export default function XxxTab() {
  const features = useUiFeatures();
  const [orgSettings, setOrgSettings] = useState<OrgSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    apiFetch<OrgSettings>('/settings/organisation')
      .then(setOrgSettings)
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : 'Помилка завантаження налаштувань'),
      );
  }, []);

  const save = async () => {
    if (!orgSettings) return;
    setSaving(true);
    setError('');
    try {
      const updated = await apiFetch<OrgSettings>('/settings/organisation', {
        method: 'PATCH',
        body: JSON.stringify({ fieldA: orgSettings.fieldA }),
      });
      setOrgSettings(updated);
      if (features.toastEnabled) toast.success('Збережено');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Помилка збереження';
      setError(msg);
      if (features.toastEnabled) toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  if (!orgSettings) return null;

  return (
    <div className="bg-surface rounded-xl border border-border p-6 space-y-6">
      {error && (
        <div className="text-sm text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg p-3">
          {error}
        </div>
      )}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-foreground">Назва секції</h2>

        {/* Рядок налаштування з Toggle */}
        <div
          className="flex items-center justify-between gap-4 py-2 border-b border-border last:border-0"
          title="Розширений опис для tooltip при наведенні"
        >
          <div>
            <p className="text-sm font-medium text-foreground">Назва налаштування</p>
            <p className="text-xs text-muted-foreground mt-0.5">Короткий опис під назвою</p>
          </div>
          <Toggle
            checked={orgSettings.fieldA ?? false}
            onChange={v => setOrgSettings({ ...orgSettings, fieldA: v })}
          />
        </div>
      </section>

      <div>
        <Button onClick={() => void save()} disabled={saving}>
          {saving ? 'Збереження...' : 'Зберегти'}
        </Button>
      </div>
    </div>
  );
}
```

### Правила

```
✅ Toggle (синій перемикач) — для boolean налаштувань
✅ title на рядку div — tooltip при наведенні з повним описом
✅ Короткий опис під назвою (text-xs text-muted-foreground)
✅ border-b border-border last:border-0 — розділювач між рядками
✅ if (!orgSettings) return null — не рендерити поки не завантажено
✅ features.toastEnabled — перевірка перед toast
✅ PATCH тільки змінені поля (не весь об'єкт)

❌ НЕ input type="checkbox" для boolean налаштувань — тільки Toggle
❌ НЕ зберігати автоматично onChange — завжди кнопка "Зберегти"
❌ НЕ виносити Toggle у shared — локальний компонент у файлі вкладки
```

### Додавання нового boolean поля

1. `schema.prisma` → `OrganisationSettings`: `newField Boolean @default(true/false)`
2. `db push` (dev) або міграція (prod)
3. `settings.dto.ts` → `UpdateOrganisationSettingsDto` + `OrganisationSettingsResponseDto`
4. `settings.service.ts` → параметр inline-типу `mapOrganisationSettings()` + return об'єкт
5. `settings/shared.ts` → `OrgSettings` тип
6. Новий або існуючий `XxxTab.tsx` → Toggle

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
