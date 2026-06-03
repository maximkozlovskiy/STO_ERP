# STO ERP — Довідник термінів

> Пояснення всіх технічних термінів, які використовуються в проекті та в роботі з Claude Code.
> Організовано за логічними блоками: від бази даних до UI.

---

## 1. База даних і Prisma

### Schema

**Файл:** `packages/database/prisma/schema.prisma`

Головний опис структури бази даних. Містить:

- **моделі** (таблиці) — `model WorkOrder { ... }`
- **enum-и** — `enum WorkOrderStatus { DRAFT APPROVED ... }`
- **зв'язки** між таблицями — `relation`
- **індекси** — `@@index([orgId, deletedAt])`

Prisma читає schema і генерує SQL-міграцію та TypeScript-типи.

---

### Migration (Міграція)

SQL-скрипт що змінює структуру БД: додає таблиці, колонки, індекси.

```bash
# Створити і застосувати нову міграцію
cd packages/database
npx prisma migrate dev --name add_document_date_indexes

# Застосувати існуючі міграції (на production)
npx prisma migrate deploy
```

**Де зберігаються:** `packages/database/prisma/migrations/YYYYMMDDHHMMSS_name/migration.sql`

**Правило:** ніколи не редагувати вже застосовану міграцію — завжди створювати нову.

---

### Prisma Generate

Генерує TypeScript-клієнт з поточної schema. Потрібно запускати після кожної зміни schema.

```bash
npx prisma generate
```

**Що генерується:** `node_modules/.prisma/client/` — JS/TS файли з типами для всіх моделей.

**Partial generate** — термін коли generate застосовується частково (наприклад, тільки після міграції). Якщо API або Next.js сервер запускався зі старим клієнтом, він не знає про нові поля — потрібен **перезапуск сервера**.

---

### Prisma Client

Типобезпечний ORM-клієнт для роботи з БД. Замість сирого SQL:

```typescript
// Prisma Client — зрозуміло, TypeScript знає типи
const orders = await prisma.workOrder.findMany({
  where: { orgId, status: 'DRAFT', deletedAt: null },
  orderBy: { createdAt: 'desc' },
  take: 20,
});

// Сирий SQL — тільки для складних запитів
const result = await prisma.$queryRaw`SELECT ...`;
```

---

### Seed (Сід)

Скрипт що наповнює БД початковими даними.

**Файл:** `packages/database/prisma/seed.ts`

```bash
npx prisma db seed
```

Використовується для: тестових даних в dev, початкових довідників (організація, категорії, шаблони нумерації).

**Ідемпотентний** — можна запускати багато разів, дані не дублюються (використовує `upsert`).

---

### Upsert

Операція "вставити або оновити". Якщо запис існує — оновлює, якщо ні — створює.

```typescript
await prisma.organisation.upsert({
  where: { id: orgId },
  create: { id: orgId, name: 'СТО Сервіс' },
  update: { name: 'СТО Сервіс' },
});
```

---

### Soft Delete (М'яке видалення)

Замість фізичного видалення рядка з БД — записуємо дату видалення в поле `deletedAt`.

```typescript
// ❌ Фізичне видалення — ЗАБОРОНЕНО в проекті
await prisma.workOrder.delete({ where: { id } });

// ✅ Soft delete — правильно
await prisma.workOrder.update({
  where: { id },
  data: { deletedAt: new Date() },
});

// Фільтрація — завжди виключаємо видалені
where: {
  deletedAt: null;
}
```

**Навіщо:** зберігаємо історію, можна відновити, sync між пристроями.

---

### Index (Індекс)

Структура в БД що прискорює пошук по колонці. Без індексу — повний перебір таблиці (slow).

```prisma
// Приклад в schema.prisma
@@index([orgId, status, deletedAt])          // для фільтрації по статусу
@@index([orgId, documentDate, deletedAt])    // для сортування по даті
@@index([orgId, deletedAt, createdAt])       // covering index — sort без окремого Sort node
```

**Covering index** — індекс що містить всі потрібні колонки для запиту, Postgres не звертається до основної таблиці.

---

### Decimal vs Float

- `Decimal` — точна десяткова арифметика (фінанси, ціни)
- `Float` — наближена арифметика (нормо-години, коефіцієнти)

```prisma
totalAmount  Decimal  @db.Decimal(12, 2)  // гроші — завжди Decimal
normoHours   Float                        // години — Float OK
```

---

### @db.Date vs DateTime

- `DateTime` — дата + час (timestamp): `2026-06-03T14:30:00Z`
- `@db.Date` — тільки дата без часу: `2026-06-03`

```prisma
documentDate  DateTime  @default(now()) @db.Date   // дата документа — без часу
createdAt     DateTime  @default(now())             // момент створення — з часом
```

---

### OrgId (Tenant Isolation)

Кожен запит до БД обов'язково фільтрується по `orgId` — ідентифікатору організації. Захист від витоку даних між клієнтами (мультитенантність).

```typescript
// ЗАВЖДИ додаємо orgId у where
const docs = await prisma.invoice.findMany({
  where: { orgId, deletedAt: null }, // orgId — обов'язково
});
```

---

## 2. Backend (NestJS)

### DTO (Data Transfer Object)

TypeScript-клас що описує структуру вхідних/вихідних даних API. Містить валідацію.

```typescript
export class CreateWorkOrderDto {
  @IsUUID() vehicleId!: string;
  @IsOptional()
  @IsString()
  description?: string;
  @IsDateString() documentDate?: string;
}
```

**Декоратори валідації:** `@IsUUID()`, `@IsString()`, `@IsOptional()`, `@IsEnum()`, `@Min()`, `@Max()` — з бібліотеки `class-validator`.

---

### Pipe / ValidationPipe

NestJS middleware що автоматично валідує та трансформує вхідні дані через DTO.

```typescript
// main.ts — глобальна валідація
app.useGlobalPipes(
  new ValidationPipe({
    whitelist: true, // видаляє поля не описані в DTO
    forbidNonWhitelisted: true,
    transform: true, // перетворює рядки в числа, дати і т.д.
  }),
);
```

**whitelist: true** — якщо клієнт надіслав поле якого немає в DTO — воно мовчки ігнорується.

---

### Guard

NestJS перехоплювач що перевіряє чи має запит право на виконання.

- `JwtAuthGuard` — перевіряє JWT токен
- `RolesGuard` — перевіряє роль користувача
- `BranchAccessGuard` — перевіряє доступ до філії

```typescript
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('OWNER', 'ADMIN')
@Patch(':id')
update(@Param('id') id: string, @Body() dto: UpdateDto) { ... }
```

---

### Decorator (Декоратор)

TypeScript-анотація що додає поведінку до класу, методу або параметру.

```typescript
@ApiPropertyOptional()    // документація Swagger
@IsOptional()             // валідація: поле необов'язкове
@Transform(emptyToUndefined) // трансформація: '' → undefined
@IsIn(['asc', 'desc'])    // валідація: тільки ці значення
```

---

### emptyToUndefined

Власний трансформ що конвертує порожній рядок `''` в `undefined`.

**Проблема:** фронтенд часто надсилає `""` коли поле очищено (select/input). `@IsOptional()` пропускає лише `undefined`/`null`, а не порожній рядок.

```typescript
export const emptyToUndefined = ({ value }) => value === '' ? undefined : value;

// Використання:
@IsOptional()
@Transform(emptyToUndefined)
@IsUUID()
branchId?: string;
```

---

### FSM (Finite State Machine) / Машина станів

Система переходів між статусами документа. Кожен перехід явно дозволений або заборонений.

```typescript
// Наряд: DRAFT → ESTIMATE → APPROVED → IN_PROGRESS → COMPLETED → INVOICED → PAID
const TRANSITIONS: Record<WorkOrderStatus, WorkOrderStatus[]> = {
  DRAFT: ['ESTIMATE', 'APPROVED'],
  APPROVED: ['IN_PROGRESS', 'ON_HOLD'],
  COMPLETED: ['INVOICED'],
  // ...
};
```

**Правило:** тільки через `WorkOrdersService.transition()` — ніколи напряму `status = 'PAID'`.

---

### BullMQ / Queue (Черга)

Система відкладеного виконання завдань через Redis. Для зовнішніх API (SMS, ПРРО) щоб система працювала офлайн.

```typescript
// Додати завдання в чергу
await this.smsQueue.add('send', { phone, message }, {
  attempts: 10,
  backoff: { type: 'exponential', delay: 60_000 },
});

// Worker обробляє завдання
@Processor('sms')
export class SmsProcessor {
  @Process('send')
  async handle(job: Job) { ... }
}
```

---

### @SkipThrottle

Декоратор що вимикає rate-limiting для конкретного endpoint.

```typescript
@SkipThrottle()
@Post('refresh')
refresh() { ... }  // /auth/refresh — часто викликається, не повинен блокуватися
```

---

### OrgContext / CurrentUser

Кастомні декоратори що витягують дані з JWT токена.

```typescript
@Get()
findAll(
  @OrgContext() orgId: string,        // витягує orgId з токена
  @CurrentUser() user: JwtPayload,    // { sub, orgId, role, branchId }
) { ... }
```

---

### Swagger / @ApiProperty

Автоматична документація API. Доступна на `http://localhost:3000/api/docs`.

```typescript
@ApiPropertyOptional({ description: 'Дата документа (YYYY-MM-DD)' })
documentDate?: string;
```

---

## 3. Frontend (Next.js)

### `'use client'`

Директива Next.js що позначає компонент як клієнтський (виконується в браузері).

```typescript
'use client';
// Далі можна використовувати useState, useEffect, onClick і т.д.
```

**Без директиви** — Server Component (рендериться на сервері, не може мати стан).

---

### Layout

Файл `layout.tsx` що обгортає всі сторінки в директорії. Рендериться один раз, не перезавантажується при навігації.

```
app/
├── layout.tsx          ← root layout: html, body, ColorModeProvider
├── (app)/
│   ├── layout.tsx      ← authenticated layout: TopShell, auth guard
│   └── work-orders/
│       └── page.tsx
└── (auth)/
    ├── layout.tsx      ← isolated layout: без TopShell
    └── login/
        └── page.tsx
```

**Ізольований layout** (`/setup`, `/login`) — окремий `layout.tsx` без `AuthProvider`/`TopShell`. Без нього setup-сторінка отримає auth guard і зациклиться.

---

### page.tsx vs PageClient.tsx

- `page.tsx` — серверний або тонкий клієнтський wrapper
- `PageClient.tsx` — складна клієнтська логіка (useState, fetch, форми)

Розділення потрібне для Server Components (SEO, швидший initial load).

---

### Static Export

Next.js генерує статичні HTML/JS файли замість SSR-сервера.

```javascript
// next.config.ts
output: 'export'; // генерує /out директорію зі статикою
```

**Навіщо в проекті:** файли `apps/api/public/` роздаються NestJS/Caddy без окремого Node.js процесу для фронту.

---

### App Router vs Pages Router

Два режими Next.js. Проект використовує **App Router** (`app/` директорія).

- Файл `page.tsx` = сторінка
- Файл `layout.tsx` = обгортка
- Файл `loading.tsx` = скелетон завантаження
- Папка `[id]/` = динамічний маршрут

---

### Route Groups `(app)` / `(auth)`

Папки в дужках не впливають на URL, але дозволяють мати різні layouts.

```
app/(app)/work-orders/page.tsx  → URL: /work-orders
app/(auth)/login/page.tsx       → URL: /login
```

---

### Suspense + Fallback

Відображає loading-стан поки компонент завантажується.

```typescript
export default function Page() {
  return (
    <Suspense fallback={<Spinner />}>
      <HeavyComponent />
    </Suspense>
  );
}
```

---

## 4. Стан і хуки (React/TanStack Query)

### useState

Локальний стан компонента. Перерендер при зміні.

```typescript
const [page, setPage] = useState(1);
const [modal, setModal] = useState(false);
```

---

### useEffect

Побічні ефекти: fetch при монтуванні, підписки, таймери.

```typescript
useEffect(() => {
  let cancelled = false;
  loadData().then(data => {
    if (!cancelled) setData(data);
  });
  return () => {
    cancelled = true;
  }; // cleanup при unmount
}, [dependency]);
```

**AbortController** — правильний спосіб скасувати fetch при unmount.

---

### useCallback / useMemo

Мемоізація функцій і значень. Запобігає зайвим ре-рендерам.

```typescript
// useCallback — мемоізує функцію
const load = useCallback(() => apiFetch('/items'), [dependency]);

// useMemo — мемоізує результат обчислення
const sortedItems = useMemo(() => [...items].sort((a, b) => a.name.localeCompare(b.name)), [items]);
```

---

### useRef

Зберігає значення між рендерами БЕЗ перерендеру при зміні. Також для доступу до DOM елементів.

```typescript
const abortRef = useRef<AbortController | null>(null);
const inputRef = useRef<HTMLInputElement>(null);
```

---

### TanStack Query (useQuery / useMutation)

Бібліотека для серверного стану: кешування, refetch, loading/error стани.

```typescript
// useQuery — отримати дані
const { data, isLoading, error } = useWorkOrders({ page, status });

// useMutation — змінити дані
const mutation = useMutation({
  mutationFn: dto => apiFetch('/work-orders', { method: 'POST', body: JSON.stringify(dto) }),
  onSuccess: () => queryClient.invalidateQueries({ queryKey: ['work-orders'] }),
});
```

**queryKey** — унікальний ключ кешу. При `invalidateQueries` — дані перезавантажуються.

**staleTime** — скільки часу вважати дані свіжими (не refetch).

---

### Toggle

Перемикання boolean стану між `true`/`false`.

```typescript
// Простий toggle
setShowDeleted(prev => !prev);

// Toggle з useCallback
const togglePanel = useCallback(() => setOpen(v => !v), []);
```

У контексті колонок — `toggle('columnKey')` вмикає/вимикає видимість колонки.

---

### Debounce

Затримка виконання функції до завершення введення. Використовується для пошуку.

```typescript
const [search, setSearch] = useState('');
const debouncedSearch = useDebounce(search, 300); // чекає 300ms після останнього символу

// Тільки debouncedSearch передається в API запит
const { data } = useWorkOrders({ q: debouncedSearch });
```

---

### Optimistic Update

Відображаємо зміну в UI одразу, не чекаючи відповіді API. Rollback при помилці.

```typescript
// Відразу показуємо новий статус
setWo(prev => ({ ...prev, status: 'APPROVED' }));
// Відправляємо запит
try {
  const updated = await apiFetch(`/work-orders/${id}/transition`, ...);
  setWo(updated); // заміняємо точними даними
} catch {
  setWo(original); // rollback
}
```

---

### useSortState

Власний хук для стану сортування таблиці.

```typescript
const { sort, toggle } = useSortState('createdAt', 'desc');
// sort = { sortBy: 'createdAt', sortDir: 'desc' }
// toggle('documentDate') → { sortBy: 'documentDate', sortDir: 'asc' }
// toggle('documentDate') ще раз → { sortBy: 'documentDate', sortDir: 'desc' }
```

---

## 5. TypeScript

### tsc --noEmit

Перевірка типів без генерації файлів. Аналог "compile and check errors".

```bash
cd apps/api && npx tsc --noEmit   # перевірка бекенду
cd apps/web && npx tsc --noEmit   # перевірка фронтенду
```

**0 errors** — обов'язкова умова перед кожним комітом.

---

### Type Assertion (`as`)

Примусове вказання типу. Використовувати обережно — обходить перевірку.

```typescript
// ❌ Небезпечно — cast обходить типізацію
const date = (wo as any).documentDate;

// ✅ Правильно — додати поле до типу
type WoParam = { documentDate?: Date | null; ... };
function toDto(wo: WoParam) { ... }
```

---

### Nullable vs Optional

- `string | null` — значення є, але може бути `null`
- `string | undefined` або `string?` — поле може бути відсутнє

```typescript
deletedAt?: Date | null;  // відсутнє (не повернули) АБО null (не видалено) АБО Date (видалено)
```

---

### Record<K, V>

Об'єкт з відомими ключами типу `K` і значеннями типу `V`.

```typescript
const LABELS: Record<WorkOrderStatus, string> = {
  DRAFT: 'Чернетка',
  APPROVED: 'Затверджено',
  // TypeScript змусить вказати всі значення enum
};
```

---

### Generic (Узагальнення)

Функція або тип що працює з будь-яким типом.

```typescript
// Generic функція
function usePaginatedList<T>(url: string, filters: object) {
  return useQuery<PaginatedResponse<T>>(...);
}

// Використання
const { data } = usePaginatedList<WorkOrder>('/work-orders', filters);
```

---

## 6. CSS і Tailwind

### page-fill vs page-container

Два CSS класи для layout сторінок.

```css
.page-fill {
  flex: 1 1 0; /* займає весь <main> */
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden; /* scroll — всередині елементів */
}

.page-container {
  padding: 1rem 1.5rem;
  max-width: 96rem;
  margin: 0 auto;
  overflow-y: auto; /* scroll — на самому елементі */
}
```

- `page-fill` — сторінки-списки (таблиці), дашборд, календар — займають весь viewport
- `page-container` — застарілий паттерн (scroll на зовнішньому контейнері)

---

### flex-1 min-h-0

Пара класів для flex-дітей що мають займати весь простір і правильно скролити.

```typescript
<div className="flex flex-col h-full">
  <header className="shrink-0">...</header>
  <div className="flex-1 min-h-0 overflow-y-auto">...</div>
  {/* flex-1 = grow, min-h-0 = дозволяє shrink нижче content height */}
</div>
```

**Без `min-h-0`** — flex item не може бути менше свого контенту → overflow не працює.

---

### shrink-0

Заборонити елементу зменшуватися. Для хедерів і footer що мають фіксований розмір.

```typescript
<div className="page-header shrink-0">...</div>
<div className="flex-1 min-h-0 overflow-auto">...</div>
```

---

### CSS Custom Properties (змінні)

```css
--color-primary: hsl(221 83% 53%);
--spacing-page-x: 1.5rem;
```

Tailwind 4 використовує CSS vars замість конфіг-файлу:

```typescript
className = 'bg-(--color-primary)'; // Tailwind 4 синтаксис
```

---

### Dark Mode / `.dark` клас

Темна тема вмикається додаванням класу `dark` на `<html>`.

```css
.dark {
  --color-background: hsl(222 47% 8%);
}
```

```typescript
// Застосування теми
document.documentElement.classList.add('dark');
```

---

### kpi-card-blue / kpi-card-red

CSS-класи для KPI карток на дашборді. Кожен задає CSS змінні через `@layer`.

```css
.kpi-card-blue {
  --kpi-bg: hsl(213 100% 97%);
  --kpi-icon: hsl(213 94% 56%);
}
.kpi-card-red {
  --kpi-bg: hsl(0 100% 97%);
  --kpi-icon: hsl(0 72% 51%);
}
```

---

### contain: paint

CSS оптимізація для таблиць всередині `page-fill`. Кліпає overflow по border-radius без блокування scroll.

```css
.page-fill .rounded-xl {
  contain: paint;
}
```

---

## 7. Архітектурні паттерни

### Offline-First

Система повністю функціонує без інтернету. Зовнішні API (SMS, ПРРО) — через BullMQ чергу з retry.

```
Без інтернету → BullMQ зберігає завдання в Redis → При відновленні → Worker відправляє
```

---

### Append-Only Log

Деякі таблиці тільки додають записи, ніколи не змінюють.

```
StockMovement   — кожен рух товару
SettlementTransaction — кожна фінансова операція
PriceHistory    — кожна зміна ціни
BatchConsumption — кожне списання партії
```

**Навіщо:** аудит, відновлення стану, синхронізація.

---

### Outbox Pattern

Шаблон для надійної відправки подій при зміні даних.

```
1. В тій самій транзакції: оновити дані + записати SyncJob
2. Worker читає SyncJob і відправляє на Cloud Sync Hub
3. При успіху — SyncJob.status = DONE
4. При помилці — retry
```

---

### Tenant Isolation

Багатоорендна архітектура де всі дані ізольовані по `orgId`. Одна БД — багато організацій.

```typescript
// Кожен запит — тільки дані своєї організації
where: { orgId: '...', deletedAt: null }
```

---

### Compound Where

Prisma update/delete з повним набором умов для атомарного захисту.

```typescript
// Замість findFirst() + update() — одна операція, безпечно при race conditions
await prisma.workOrder.updateMany({
  where: { id, orgId, deletedAt: null, status: 'DRAFT' },
  data: { status: 'APPROVED' },
});
```

---

## 8. Тестування

### Unit Test

Тест одного модуля в ізоляції (mock залежності).

```typescript
// Тестуємо сервіс без реальної БД
it('should return 404 if not found', () => {
  prismaMock.workOrder.findFirst.mockResolvedValue(null);
  expect(service.findOne('org1', 'invalid-id')).rejects.toThrow(NotFoundException);
});
```

---

### Contract Test

Тест що контролер правильно делегує виклики сервісу з правильними параметрами.

```typescript
it('forwards sortBy to service', async () => {
  await controller.findAll({ sortBy: 'documentDate', sortDir: 'asc' });
  expect(service.findAll).toHaveBeenCalledWith(
    orgId,
    expect.objectContaining({
      sortBy: 'documentDate',
      sortDir: 'asc',
    }),
  );
});
```

---

### E2E Test (Playwright)

Тест реального браузера: навігація, кліки, перевірка DOM.

```typescript
test('сортування по даті', async ({ page }) => {
  await page.goto('/work-orders');
  await page.locator('th:has-text("Дата документа")').click();
  // перевіряємо що стрілка з'явилась
  await expect(page.locator('th:has-text("Дата документа") svg')).toBeVisible();
});
```

---

### storageState

Playwright механізм збереження стану авторизації (cookies, localStorage, sessionStorage) між тестами.

```json
// e2e/.auth/admin.json
{ "cookies": [...], "origins": [{ "localStorage": [{ "name": "sto_access_token", "value": "..." }] }] }
```

---

### Regression Test

Тест що перевіряє старий баг більше не відтворюється.

---

### Mock

Підміна залежності тестовою версією.

```typescript
const prismaMock = { workOrder: { findMany: vi.fn() } };
```

---

## 9. Git і DevOps

### Commit Message Convention

```
feat(ui): додати сортування колонок         ← нова функціональність
fix(api): виправити timezone в documentDate  ← виправлення бага
refactor(db): оптимізувати індекси           ← рефакторинг без зміни поведінки
test(e2e): покрити stock-documents           ← тільки тести
docs(skills): оновити sto-dev checklist      ← документація
perf(optimize): N+1 у work-orders service    ← продуктивність
```

---

### Stash (git stash)

Тимчасово зберігає незакомічені зміни.

```bash
git stash        # зберегти зміни
git stash pop    # відновити зміни
```

Використовується lint-staged (pre-commit hook) автоматично.

---

### lint-staged / pre-commit hook

Автоматичний запуск prettier перед кожним комітом. Форматує тільки staged файли.

---

### Hot Reload / HMR

Автоматичне оновлення коду в браузері або сервері при зміні файлів.

- **Next.js** — HMR через webpack, браузер оновлюється без перезавантаження
- **NestJS** — webpack watch, сервер перезапускається при зміні

**Stale bundle проблема:** якщо HMR не спрацював — сервер виконує старий код. Вирішення — перезапуск сервера і очищення `.next/` кешу.

---

## 10. Специфіка проекту

### kyivToday()

Функція що повертає сьогоднішню дату в київському часовому поясі у форматі `YYYY-MM-DD`.

```typescript
const KYIV_YMD = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv' });
const kyivToday = () => KYIV_YMD.format(new Date());
// '2026-06-03'
```

**Навіщо:** `new Date().toISOString().slice(0, 10)` повертає UTC дату, а між 00:00-03:00 за Києвом вона буде вчорашньою.

---

### SortableHead

Компонент заголовку таблиці з підтримкою сортування.

```typescript
<SortableHead sortKey="documentDate" currentSort={sort} onSort={toggle}>
  Дата документа
</SortableHead>
// Натискання: ↓ desc → ↑ asc → ↓ desc ...
// Нова колонка: завжди починає з asc
```

---

### apiFetch

Централізований HTTP-клієнт з автоматичним Bearer token та refresh.

```typescript
const data = await apiFetch<WorkOrder[]>('/work-orders?limit=20');
// автоматично:
// - додає Authorization: Bearer {token}
// - при 401 робить refresh і повторює запит
// - кидає Error з повідомленням від API
```

**Заборонено:** `fetch()`, `axios` напряму — тільки `apiFetch`.

---

### EMPTY_ITEMS

Module-level frozen порожній масив для stable reference.

```typescript
// apps/web/src/hooks/api/usePaginatedList.ts
export const EMPTY_ITEMS = Object.freeze([]);

// Використання замість inline []
const items = data?.items ?? (EMPTY_ITEMS as unknown as WorkOrder[]);
// Уникає Bug #328: fresh [] literal кожен рендер → useBulkSelect effect race
```

---

### panel-schema.ts / buildPanelFields()

Schema-driven підхід для Detail Panel. Поля ніколи не хардкодяться — описуються у схемі.

```typescript
// lib/panel-schema.ts
export const WORK_ORDER_PANEL_SCHEMA = {
  fields: [
    { key: 'status', label: 'Статус', type: 'badge', defaultVisible: true },
    { key: 'documentDate', label: 'Дата документа', type: 'date', defaultVisible: true },
  ],
};

// Рендеринг — автоматичний
const fields = buildPanelFields(schema, wo);
```

---

### BUG_REPORT.md

Файл де фіксуються знайдені баги. Ведеться автоматично агентами `sto-tester`.

```markdown
## Bug #340 [HIGH] — ...

**Файл:** apps/api/src/...
**Причина:** ...
**Виправлення:** ...
```

---

### MemoryManual.md

Живий документ з поточним станом проекту. Читається Claude на початку кожної сесії.

```markdown
## Останній commit

## TypeScript: ✅ 0 errors

## Unit+Contract: ✅ 594/594

## Latest tester / review
```
