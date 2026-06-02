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

## UX/UI Features System (Phase 20)

> STO ERP підтримує 10 UX-прапорців у `OrganisationSettings.uiFeatures` (JSON, per-org).
> Всі прапорці за замовчуванням `true`. Читаються через `useUiFeatures()` хук.

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
// apps/web/src/hooks/useUiFeatures.ts
import { useUiFeatures } from '@/hooks/useUiFeatures';

// В компоненті:
const features = useUiFeatures();
if (features.toastEnabled) toast.success('Збережено');

// ОБОВ'ЯЗКОВО: всі прапорці захищають свій функціонал
{features.bulkActionsEnabled && <BulkActionsBar ... />}
```

**Правила useUiFeatures:**

- Module-level cache з TTL: один fetch на всю сесію, не на кожен mount
- Endpoint: `GET /settings/ui-features` — доступний ВСІМ ролям (не тільки OWNER/ADMIN)
- При помилці — кешує `DEFAULTS` на 60 сек щоб не спамити backend
- Очищення при logout: слухає `sto:logout` event → скидає до `DEFAULTS`
- Інвалідація після зміни налаштувань: `invalidateUiFeaturesCache()` → dispatch `sto:ui-features-change`

### Toast — сповіщення після мутацій

```typescript
// apps/web/src/lib/toast.ts
import { toast } from '@/lib/toast';

// ✅ Завжди перевіряй прапорець
if (features.toastEnabled) toast.success('Збережено');
if (features.toastEnabled) toast.error(`Помилка: ${e.message}`);
if (features.toastEnabled) toast.warning('Залишок < мінімального рівня');
if (features.toastEnabled) toast.info('Синхронізацію завершено');

// ❌ Не використовуй напряму без прапорця
toast.success('...');  // може бути вимкнено в налаштуваннях

// ✅ Резервний варіант коли toast вимкнено
try {
  await apiFetch(...);
  if (features.toastEnabled) toast.success('Збережено');
} catch (e) {
  const msg = e instanceof Error ? e.message : 'Помилка';
  if (features.toastEnabled) toast.error(msg);
  else setError(msg);  // fallback у inline error display
}
```

**ToastContainer** монтується в `TopShell.tsx` — підключати в новому layout не потрібно.

### useDirtyForm — захист від випадкового закриття

```typescript
// apps/web/src/hooks/useDirtyForm.ts
const { isDirty, markDirty, resetDirty, confirmClose } = useDirtyForm({
  enabled: features.unsavedGuardEnabled,
});

// onChange будь-якого поля:
onChange={e => { setForm(f => ({ ...f, name: e.target.value })); markDirty(); }}

// У кнопці "Скасувати":
onClick={async () => {
  if (await confirmClose()) { resetDirty(); setModal(false); }
}}

// Після успішного збереження:
onSave: async () => {
  await apiFetch(...);
  resetDirty();  // ОБОВ'ЯЗКОВО — скидає брудний стан
}
```

**Правила useDirtyForm:**

- `isDirtyRef` (useRef) — для синхронного `beforeunload` обробника
- `isDirty` (useState) — для React рендерингу (кнопка Скасувати показує "Є зміни")
- `confirmClose()` — повертає `Promise<boolean>`: `true` якщо можна закривати

### useInlineEdit — редагування у таблиці

```typescript
// apps/web/src/hooks/useInlineEdit.ts
const inlineEdit = useInlineEdit({
  enabled: features.inlineEditEnabled,
  onSave: async (rowId, field, value) => {
    await apiFetch(`/work-orders/${rowId}`, {
      method: 'PATCH',
      body: JSON.stringify({ [field]: value === '' ? null : value }),
    });
    if (features.toastEnabled) toast.success('Збережено');
    load(); // оновити список
  },
});

// В JSX — текстовий/числовий input:
{inlineEdit.isEditing(row.id, 'field') ? (
  <InlineEditCell
    value={inlineEdit.editing?.value ?? row.field}
    saving={inlineEdit.saving}
    onCommit={v => { void inlineEdit.commitEdit(v).catch(() => {}); }}
    onCancel={inlineEdit.cancelEdit}
    type="text"
  />
) : (
  <InlineViewCell
    value={row.field}
    enabled={features.inlineEditEnabled}
    onClick={() => inlineEdit.startEdit(row.id, 'field', row.field)}
  >
    {row.field}
  </InlineViewCell>
)}

// Для enum (select) — uncontrolled pattern:
{inlineEdit.isEditing(row.id, 'priority') ? (
  <select
    defaultValue={inlineEdit.editing?.value ?? row.priority}
    onChange={e => { void inlineEdit.commitEdit(e.target.value).catch(() => {}); }}
    onBlur={() => inlineEdit.cancelEdit()}
    onKeyDown={e => { if (e.key === 'Escape') inlineEdit.cancelEdit(); }}
    disabled={inlineEdit.saving}
    autoFocus
    className="rounded border border-primary bg-surface text-[12px] px-1.5 py-0.5 outline-none disabled:opacity-50"
  >
    {OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
  </select>
) : (...)}
```

**Правила useInlineEdit:**

- `savingRef` всередині хука запобігає подвійному коміту (blur + click обидва фаєряться)
- `commitEdit` re-throws після показу toast → call-сайт ЗАВЖДИ `.catch(() => {})`
- `defaultValue` (uncontrolled) для `<select>` — контрольований `value` "відскакує" візуально при in-flight save
- `inputRef.current?.select()` обгорнутий у try/catch — date inputs кидають `InvalidStateError`

### useBulkSelect — множинний вибір у таблиці

```typescript
// apps/web/src/hooks/useBulkSelect.ts
const bulkSelect = useBulkSelect(data?.items ?? []);

// КРИТИЧНО: useBulkSelect автоматично прибирає stale IDs при зміні items
// (при пагінації / фільтрації / refetch — обрані ID з попередньої сторінки зникають)

// TableHeader:
{features.bulkActionsEnabled && (
  <TableHead className="w-9 pr-0">
    <input
      type="checkbox"
      ref={selectAllRef}   // useRef<HTMLInputElement>(null) + useEffect для indeterminate
      checked={bulkSelect.allSelected}
      onChange={bulkSelect.toggleAll}
      aria-label="Вибрати всі"
    />
  </TableHead>
)}

// Imperative indeterminate (НЕ через inline ref callback):
const selectAllRef = useRef<HTMLInputElement>(null);
useEffect(() => {
  if (selectAllRef.current) selectAllRef.current.indeterminate = bulkSelect.someSelected;
}, [bulkSelect.someSelected]);

// BulkActionsBar — ЗАВЖДИ Promise.allSettled для множинних мутацій:
const bulkActions = useMemo<BulkAction[]>(() => [
  {
    id: 'cancel', label: 'Скасувати', variant: 'destructive',
    onClick: async (ids) => {
      const results = await Promise.allSettled(
        ids.map(id => apiFetch(`/resource/${id}/transition`, {
          method: 'POST', body: JSON.stringify({ status: 'CANCELLED' }),
        }))
      );
      const ok = results.filter(r => r.status === 'fulfilled').length;
      bulkSelect.clear();
      load();  // в finally-логіці — завжди reload
      if (features.toastEnabled) {
        if (ok === ids.length) toast.success(`Скасовано ${ok}`);
        else toast.warning(`Скасовано ${ok} з ${ids.length}. ${ids.length - ok} не змінено`);
      }
    },
  },
], [bulkSelect, features.toastEnabled, load]);
```

**Правила useBulkSelect + BulkActionsBar:**

- `Promise.allSettled` — ніколи `Promise.all` для bulk-мутацій (один 400 не зупиняє решту)
- `bulkSelect.clear()` + `load()` — ЗАВЖДИ, незалежно від кількості помилок
- colSpan у loading/empty rows: `features.bulkActionsEnabled ? cols + 1 : cols`
- `useMemo` для `bulkActions` array — щоб не перестворювати нову референцію на кожен render

### useSavedFilters — збережені пресети фільтрів

```typescript
// apps/web/src/hooks/useSavedFilters.ts
interface MyFilters extends Record<string, unknown> {
  statusFilter: string;
  search: string;
}
const { saved, save, remove } = useSavedFilters<MyFilters>('page-key');

// save повертає збережений пресет з .id:
const preset = save('Активні', { statusFilter: 'IN_PROGRESS', search: '' });
setActiveSavedFilterId(preset.id);
if (features.toastEnabled) toast.success(`Фільтр "${name}" збережено`);

// onApply:
const applyFilter = useCallback((preset: { id: string; filters: MyFilters }) => {
  setStatusFilter(preset.filters.statusFilter ?? '');
  setSearch(preset.filters.search ?? '');
  setPage(1);
  setActiveSavedFilterId(preset.id);
}, []);
```

**Правила useSavedFilters:**

- SSR-safe: `useState([])` → гідратація у `useEffect` з localStorage
- `Array.isArray` guard при читанні — захист від corruption localStorage (стара версія додатку)
- `pageKey` — унікальний per-page рядок (`'work-orders'`, `'inventory'`, `'employees'`)

### Hover-actions у рядках таблиці — канонічний патерн

Єдиний стандарт для кнопок дій (редагувати / видалити / відкрити) у рядках усіх списків.

```tsx
// ✅ ПРАВИЛЬНО — TableRow отримує group, кнопки opacity-0 → group-hover
<TableRow
  className={cn(
    'group transition-colors',
    isDeleted && 'opacity-60',
    detailPanel.enabled && 'cursor-pointer',
    isSelected && 'bg-primary/5',
  )}
>
  {/* ... колонки ... */}
  <TableCell className="text-right" onClick={e => e.stopPropagation()}>
    <div className="flex items-center justify-end gap-1">
      {/* Основна дія (відкрити деталі / edit modal) */}
      <Button
        variant="ghost"
        size="icon-sm"
        title="Редагувати"
        className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        onClick={() => openEdit(item)}
      >
        <Pencil className="h-3.5 w-3.5" />
      </Button>
      {/* Видалення — тільки для не-видалених */}
      {!isDeleted && (
        <Button
          variant="ghost"
          size="icon-sm"
          title="Позначити на видалення"
          className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-destructive/70 hover:text-destructive hover:bg-destructive/10"
          onClick={() => void markDeleted(item)}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  </TableCell>
</TableRow>
```

**Правила hover-actions:**

- `group` обов'язково на `<TableRow>` — без нього `group-hover` не працює
- `opacity-0 group-hover:opacity-100 focus-visible:opacity-100` — обидва стани (hover + keyboard nav)
- `onClick={e => e.stopPropagation()}` на `<TableCell>` — щоб не тригерило row-click (detail panel)
- `size="icon-sm"` — стандарт для icon-only кнопок у таблиці
- Trash2 завжди у умові `{!isDeleted && ...}` — видалений рядок не можна видалити повторно
- `markDeleted` завжди через `confirm({ variant: 'destructive' })` перед DELETE-запитом
- Для навігації до сторінки деталей — `ExternalLink` іконка замість `Pencil`
- Для додаткових специфічних дій (напр. "Розцінити") — окрема іконка `Zap` зліва від Pencil

**Де застосовується (всі списки-документи):**

- `work-orders/page.tsx` — ExternalLink (→ /work-orders/:id) + Trash2
- `invoices/page.tsx` — Pencil (відкрити detail panel) + Trash2
- `purchase-orders/page.tsx` — Zap (розцінити, умовно) + Pencil + Trash2
- `stock-documents/page.tsx` — Pencil (setShowDetail) + Trash2
- `crm/page.tsx` — Pencil (edit modal) + Trash2
- `employees/page.tsx` — Pencil (edit modal) + Trash2
- Усі catalog tabs (BrandsTab, GoodsTab, WorksTab, ServicesTab, UnitsTab) — Pencil + Trash2/RotateCcw

### NotificationCenter — сповіщення у sidebar

```typescript
// apps/web/src/components/ui/notification-center.tsx
import { useNotifications } from '@/components/ui/notification-center';

// Додати сповіщення програматично:
const { add } = useNotifications();
add('success', 'Наряд виконано', `#${wo.number} перейшов у статус "Виконано"`);
add('error', 'Помилка синхронізації', error.message);
add('warning', 'Низький залишок', `${good.name}: залишилось ${qty} шт.`);
```

**Правила NotificationCenter:**

- `group` клас на батьківській картці + `opacity-0 group-hover:opacity-100` на кнопці delete
- `focus:opacity-100` на кнопці — для клавіатурних користувачів
- `onKeyDown` на `role="button"` рядку — guard `if (e.target !== e.currentTarget) return`

### SyncIndicator — статус синхронізації

```typescript
// Диспетч статусу синхронізації з будь-якого місця:
window.dispatchEvent(
  new CustomEvent('sto:sync-status', {
    detail: { status: 'syncing' }, // 'idle' | 'syncing' | 'offline' | 'error'
  }),
);

// Після завершення:
window.dispatchEvent(new CustomEvent('sto:sync-status', { detail: { status: 'idle' } }));
```

**SyncIndicator** відображається автоматично у sidebar (wired у TopShell). Показується тільки коли `status !== 'idle'` або `lastSync !== null`.

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

При ручному кодуванні arbitrary values:

1. Завжди подвійно перевір парність `[` і `]` усередині рядка з класами
2. Якщо клас довгий — винеси в змінну: `const ringErr = 'focus:ring-[hsl(0_86%_93%)]'`
3. `/sto-review` має grep на незакриті дужки

### Blob URL — `revokeObjectURL` тільки через setTimeout

`URL.revokeObjectURL(url)` викликаний **синхронно** після `a.click()` зриває завантаження у Chromium (відкликає URL до того як браузер встигне fetch'нути blob).

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

```typescript
// ❌ Hard delete
prisma.workOrder.delete({ where: { id } });

// ❌ Пряме оновлення StockItem
prisma.stockItem.update({ data: { quantity: { decrement: qty } } });

// ❌ Пряме оновлення SettlementAccount
prisma.settlementAccount.update({ data: { balance: { decrement: amount } } });

// ❌ Запит без orgId
prisma.workOrder.findUnique({ where: { id } });

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

```typescript
// ❌ Cross-tenant — немає orgId у запиті
const invoice = await this.prisma.invoice.findUnique({ where: { id } });

// ✅ Завжди orgId
const invoice = await this.prisma.invoice.findFirst({ where: { id, orgId, deletedAt: null } });

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

**Тригер кнопка (стандартний вигляд):**

```tsx
// ✅ Кнопка-тригер для picker-модалу
const selected = items.find(i => i.id === form.entityId);
<div className="flex items-center gap-2">
  <button
    type="button"
    onClick={() => setPickerOpen(true)}
    className="flex-1 text-left px-3 py-2 rounded-lg border border-border bg-surface hover:border-primary transition-colors text-sm"
  >
    {selected ? (
      <span className="text-foreground">{selected.name}</span>
    ) : (
      <span className="text-muted-foreground">Оберіть...</span>
    )}
  </button>
  {form.entityId && (
    <button
      aria-label="Очистити"
      type="button"
      onClick={() => setForm(f => ({ ...f, entityId: '' }))}
      className="text-muted-foreground hover:text-destructive-text transition-colors"
    >
      <Trash2 className="w-4 h-4" />
    </button>
  )}
</div>;
```

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
  [ ] Picker зі списком → <PickerModal<T>> з src/components/ui/picker-modal.tsx
  [ ] Inline IIFE `{(() => {...})()}` у JSX → замінити компонентом
  [ ] Форма > 5 полів у page.tsx → виносити в окремий файл
  [ ] Підтвердження дії → <ConfirmDialog>

Стан
  [ ] Немає дубльованих query/loading стейтів для однотипних picker-ів
  [ ] pickerQuery НЕ є зовнішнім стейтом — PickerModal керує пошуком сам
```

---

## §14 — Modal + ModalTabs для 1-N зв'язків

### §14.1 — Структура Edit Modal з ModalTabs

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

### §14.2 — Loading/Error в контенті вкладки

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

### §14.3 — Race guard + скидання стану при відкритті

**Обов'язково:** openEdit запускається в event handler (не useEffect), тому повільний fetch попереднього об'єкта може перезаписати дані поточного.

```ts
const openEdit = (item: Item) => {
  setEditingItem(item);
  setForm({ ...extractFields(item) });
  dirty.resetDirty();
  setError('');

  // Скинути стан дочірніх колекцій при відкритті
  setModalChildren([]);
  setChildError('');

  setModal(true);

  // Race guard: кожне відкриття отримує унікальний token
  const reqId = ++modalChildReqRef.current;
  setModalChildrenLoading(true);
  apiFetch<Child[]>(`/items/${item.id}/children`)
    .then(data => {
      if (modalChildReqRef.current !== reqId) return; // стара відповідь — ігнорувати
      setModalChildren(data);
    })
    .catch(err => {
      if (modalChildReqRef.current !== reqId) return;
      setChildError(err instanceof Error ? err.message : 'Помилка завантаження');
    })
    .finally(() => {
      if (modalChildReqRef.current !== reqId) return;
      setModalChildrenLoading(false);
    });
};
```

**Якщо декілька дочірніх колекцій** — окремий reqRef для кожної:

```ts
const vehiclesReqRef = useRef(0);
const workOrdersReqRef = useRef(0);

// В openEdit — bump ОБИДВА перед стартом fetch
const vReqId = ++vehiclesReqRef.current;
const woReqId = ++workOrdersReqRef.current;

// Паралельний fetch двох колекцій:
Promise.all([
  apiFetch<Vehicle[]>(`/counterparties/${cp.id}/garages`).then(...),
  apiFetch<WorkOrder[]>(`/work-orders?counterpartyId=${cp.id}&limit=50`).then(...),
]);
```

**❌ Типові помилки:**

```ts
// ❌ Немає race guard — stale fetch перезаписує поточний CP
apiFetch<Child[]>(`/items/${item.id}/children`)
  .then(data => setModalChildren(data));  // без перевірки reqRef!

// ❌ Не скидати стан при відкритті — попередній CP залишається у вкладці
const openEdit = (cp) => {
  setEditingCp(cp);
  // setModalVehicles([]);  ← пропущено!
  setModal(true);
};

// ❌ catch без error state — юзер бачить порожній список замість помилки
.catch(() => {})  // ← ковтаємо помилку
```

### §14.4 — AnimatedBody: плавна зміна висоти Modal та collapsible-секцій

`AnimatedBody` вбудований у `<Modal>` — **всі `<Modal>` компоненти анімують висоту автоматично**, нічого окремо робити не потрібно.

Застосовуй `AnimatedBody` безпосередньо (імпорт з `@/components/ui/modal`) коли:

- Accordion / collapse-секція поза Modal
- Панель що розгортається при кліку (show/hide форми на сторінці)
- Будь-який контейнер де висота змінюється динамічно і `transition-all max-h-[Npx]` дає стрибок або потребує магічного числа

```tsx
import { AnimatedBody } from '@/components/ui/modal';

// ✅ Accordion / collapsible section
{
  isOpen && (
    <AnimatedBody className="px-4 py-3">
      {/* вміст довільної висоти — анімується автоматично */}
      <p>Рядок 1</p>
      <p>Рядок 2</p>
    </AnimatedBody>
  );
}
```

❌ НЕ використовувати:

- `maxHeight: '900px'` як magic number для collapse — стрибає при контенті більшому/меншому за число
- `transition: 'max-height ...'` без ResizeObserver — потребує підбору константи, ламається при зміні вмісту
- `transition-all` на контейнері з `overflow:hidden` — анімує всі CSS-властивості, важко передбачити

✅ Паттерн для collapse з анімацією 0 ↔ контент (коли потрібна анімація закриття до 0):

```tsx
// refs
const outerRef = useRef<HTMLDivElement>(null);
const innerRef = useRef<HTMLDivElement>(null);

// ResizeObserver — оновлює висоту при зміні вмісту
useEffect(() => {
  if (!mounted) return;
  const ro = new ResizeObserver(() => {
    if (outerRef.current && innerRef.current && isVisible) {
      outerRef.current.style.height = `${innerRef.current.scrollHeight}px`;
    }
  });
  if (innerRef.current) ro.observe(innerRef.current);
  return () => ro.disconnect();
}, [mounted, isVisible]);

// Анімація відкриття — ResizeObserver встановить реальну висоту
// Анімація закриття — вручну через rAF:
const closePanel = () => {
  const outer = outerRef.current;
  if (outer) {
    outer.style.height = `${outer.scrollHeight}px`; // закріпити
    requestAnimationFrame(() => {
      if (outerRef.current) {
        outerRef.current.style.transition = 'height 320ms cubic-bezier(0.4,0,0.6,1)';
        outerRef.current.style.height = '0px';
      }
    });
  }
  setVisible(false);
  setTimeout(() => setMounted(false), 420);
};

// JSX
{
  mounted && (
    <div
      ref={outerRef}
      style={{
        overflow: 'hidden',
        height: isVisible ? undefined : '0px',
        transition: isVisible ? 'height 480ms cubic-bezier(0.22,1,0.36,1)' : undefined,
      }}
    >
      <div ref={innerRef} className="px-4 py-3">
        {children}
      </div>
    </div>
  );
}
```

> Реальний приклад: `apps/web/src/app/calendar/page.tsx` — форма слоту (showAdd → formMounted/formVisible).

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

## §16 SharedStatusConstants — єдине місце для статусів, лейблів, badge-варіантів

> **Правило:** `STATUS_LABELS`, `STATUS_BADGE`, `PRIORITY_LABELS` і будь-які enum→string мапи **ніколи не оголошуються** inline у page.tsx. Єдине місце — `packages/shared/src/constants/statuses.ts`.

### Чому це важливо

`Record<WorkOrderStatus, string>` — TypeScript гарантує що при додаванні нового статусу в enum **compile-error** виникне одразу, а не при runtime. Inline-оголошення у 8 файлах → розсинхронізація при рефакторингу.

### ❌ Заборонено

```typescript
// ❌ У page.tsx — оголошення STATUS_LABELS
const STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Чернетка',
  IN_PROGRESS: 'В роботі',
  // легко пропустити новий статус
};
```

### ✅ Правильно

```typescript
// packages/shared/src/constants/statuses.ts
import { WorkOrderStatus, InvoiceStatus } from '@prisma/client';
export const WO_STATUS_LABELS: Record<WorkOrderStatus, string> = {
  DRAFT: 'Чернетка',
  ESTIMATE: 'Кошторис',
  APPROVED: 'Затверджено',
  IN_PROGRESS: 'В роботі',
  ON_HOLD: 'Призупинено',
  COMPLETED: 'Виконано',
  INVOICED: 'Виставлено',
  PAID: 'Оплачено',
  ARCHIVED: 'Архів',
  CANCELLED: 'Скасовано',
}; // ← compile-error якщо пропущено статус

// У page.tsx:
import { WO_STATUS_LABELS, WO_STATUS_BADGE } from '@sto/shared';
```

**Файл-джерело правди:** `packages/shared/src/constants/statuses.ts`  
**Re-export через:** `packages/shared/src/index.ts`

---

## §17 usePaginatedList — generic API hook factory

> **Правило:** Новий list-хук не пишеться з нуля. Використовується `usePaginatedList<T, F>()` factory.

### ❌ Заборонено

```typescript
// ❌ Повторення URLSearchParams boilerplate
export function useMyEntities(filters: MyFilter) {
  const params = new URLSearchParams({ page: String(filters.page ?? 1), ... });
  if (filters.status) params.set('status', filters.status);
  if (filters.q) params.set('q', filters.q);
  // ... 20 рядків одного й того самого
  return useQuery({ queryKey: ['my-entities', filters], queryFn: () => apiFetch(...) });
}
```

### ✅ Правильно

```typescript
// apps/web/src/hooks/api/usePaginatedList.ts
export function usePaginatedList<T, F extends Record<string, unknown>>(
  endpoint: string,
  filters: F,
  options?: { staleTime?: number; enabled?: boolean }
) { ... }

// Використання:
export function useWorkOrders(filters: WorkOrdersFilter) {
  return usePaginatedList<WorkOrder, WorkOrdersFilter>('/work-orders', filters);
}
```

**Файл:** `apps/web/src/hooks/api/usePaginatedList.ts`

---

## §18 useListPage — composable hook для list-сторінок

> **Правило:** Нова list-сторінка не підключає хуки вручну. Використовується `useListPage()`.

### Що композує

`useBulkSelect` + `useTableColumns` + `useDetailPanel` + `useDetailPanelConfig` + `useSavedFilters` + pagination state → ~200 рядків boilerplate → 5 рядків.

### ✅ Правильно

```typescript
// apps/web/src/hooks/useListPage.ts
const list = useListPage('work-orders', WO_COLUMNS, { defaultLimit: 20 });

// Доступно:
list.pagination; // { page, setPage, limit }
list.bulkSelect; // useBulkSelect result
list.detailPanel; // useDetailPanel result
list.panelConfig; // useDetailPanelConfig result
list.savedFilters; // useSavedFilters result
list.columns; // useTableColumns result
```

**Файл:** `apps/web/src/hooks/useListPage.ts`

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

> **Правило:** Нова форма або дія не пише `saving/error` стан вручну. Використовується `useApiMutation()`.

### ❌ Заборонено

```typescript
// ❌ 20 рядків boilerplate per-action
const [saving, setSaving] = useState(false);
const [error, setError] = useState('');
const handleCreate = async () => {
  setSaving(true);
  setError('');
  try {
    await apiFetch('/items', { method: 'POST', body: JSON.stringify(dto) });
    toast.success('Збережено');
    load();
  } catch (e) {
    setError(e instanceof Error ? e.message : 'Помилка');
  } finally {
    setSaving(false);
  }
};
```

### ✅ Правильно

```typescript
// apps/web/src/hooks/useApiMutation.ts
const {
  mutate: createItem,
  saving,
  error,
} = useApiMutation(
  (dto: CreateDto) => apiFetch('/items', { method: 'POST', body: JSON.stringify(dto) }),
  { onSuccess: load, successMsg: 'Збережено' },
);
```

**Файл:** `apps/web/src/hooks/useApiMutation.ts`

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

> **Правило:** `const [error, setError] = useState('')` не пишеться вручну. Є `useApiError()`.

### ❌ Заборонено

```typescript
// ❌ Розкид логіки помилок
const [error, setError] = useState('');
} catch (e) { setError(e instanceof Error ? e.message : 'Помилка'); }
// + 5 місць де потрібно clearError вручну
```

### ✅ Правильно

```typescript
// apps/web/src/hooks/useApiError.ts
const { error, handleError, clearError } = useApiError();
} catch (e) { handleError(e); } // → auto-локалізація + setError
```

**Файл:** `apps/web/src/hooks/useApiError.ts`

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
