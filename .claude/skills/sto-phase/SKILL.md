---
name: sto-phase
description: >
  Phase review and implementation skill for STO ERP. Reads PHASES.md, finds the next unchecked [ ] task group (by block: B1, B2, F3, etc.), implements all sub-tasks (database → backend → frontend), marks them [x], then runs QA. Use when the user says "реалізуй фазу", "наступний блок", "реалізуй все", "продовжуємо", or when resuming work after a session break. Automatically chains: sto-database → sto-backend → sto-web → sto-review-agent → sto-tester-agent.
model: claude-sonnet-4-6
---

# sto-phase — Phase Implementation Skill

## Режим Auto (ОБОВ'ЯЗКОВО)

Реалізуй блок повністю, без питань. Алгоритм:

```
1. Крок 0 — Контекст (всі 3 файли паралельно)
2. Крок 1 — Знайти наступний блок
3. Крок 2 — Реалізація: database → backend → frontend
4. Крок 3 — Позначити [x] + git commit
5. Крок 4 — QA: sto-review-agent → sto-tester-agent
6. Крок 5 — Оновити MemoryManual.md
7. Повторити з Кроку 1 якщо є ще незавершені блоки (або зупинитись, якщо юзер просив лише 1)
```

> Не питай дозволу між кроками. Фіксуй що робиш — одне речення перед кожним кроком.

---

## Крок 0 — Контекст (ЗАВЖДИ ПЕРШИМ)

Паралельно читай:

```bash
# 1. Поточний стан коду
cat MemoryManual.md

# 2. Прогрес фаз — знайти першу [ ] групу
grep -n "\[ \]\|\[x\]" docs/PHASES.md | head -100

# 3. User preferences
cat .claude/memory/MEMORY.md
```

Виведи статус-блок перед початком роботи:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🚀 STO PHASE — РЕАЛІЗАЦІЯ
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Блок:     [Назва блоку, напр. "B12 — Фотозвіт у Web"]
Задачі:   [N tasks]
Залежить: [які модулі/міграції потрібні]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## Крок 1 — Визначення блоку для реалізації

### Якщо аргумент переданий (`/sto-phase B12` або `/sto-phase F9`)

Реалізуй вказаний блок. Знайди всі його `[ ]` задачі у PHASES.md за заголовком секції.

### Якщо аргумент не переданий

Знайди **перший блок** де є хоча б одна `[ ]` задача, рухаючись по пріоритету:

```
Пріоритет (від вищого до нижчого):
1. Блоки з [~] (в процесі) — завершити першим
2. Фаза 21: B12 → B11 → B9 → B8 → B5 → B4 → B3 → B2 → B1
3. Фаза 22: F9 → F4 → F5 → F3 → F2 → F7 → F11
4. Фаза 18 (Installer): окремий порядок — /health → prod build → Backup.ps1 → Update.ps1 → Inno Setup
```

Якщо блок великий (>5 задач на різних шарах) — **реалізуй за один раз** (database + backend + frontend).

---

## Крок 2 — Реалізація

### 2.1 Database (якщо є `[sto-database]` задача)

```
1. Прочитай packages/database/prisma/schema.prisma — перевір чи модель вже існує
2. Якщо не існує — додай модель дотримуючись обов'язкових полів:
   - id String @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
   - orgId String @db.Uuid
   - createdAt DateTime @default(now())
   - updatedAt DateTime @updatedAt  ← тільки якщо не append-only
   - deletedAt DateTime?  ← тільки якщо soft-delete потрібен
   - syncVersion BigInt @default(0)  ← тільки якщо sync-ready
3. Додай @@index([orgId, deletedAt]) і @@index([orgId, syncVersion])
4. pnpm --filter @sto/database prisma migrate dev --name <block-name>
5. ПЕРЕВІР: міграція не дропає GIN-індекси (grep "DROP INDEX" migration.sql)
   Якщо дропає — ВИДАЛИ DROP команди з migration.sql і додай CREATE INDEX IF NOT EXISTS
```

**Append-only таблиці** (без `updatedAt`, `deletedAt`, `syncVersion`): `AuditEvent`, `LoyaltyTransaction`, `WebhookDelivery`.

**Обов'язкові sync поля** тільки для таблиць що синхронізуються з мобільним: `WorkOrder`, `Good`, `Counterparty`, `Vehicle`, `Employee` тощо. Нові таблиці `WorkOrderMedia`, `Comment`, `Warranty` тощо — **теж sync-ready**.

### 2.2 Backend (якщо є `[sto-backend]` задача)

Дотримуйся структури модуля:

```
apps/api/src/modules/{domain}/
├── {domain}.module.ts
├── {domain}.controller.ts
├── {domain}.service.ts
├── {domain}.dto.ts
└── {domain}.spec.ts
```

**Обов'язкові правила:**

```typescript
// Controller
@Controller('{domain}')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiTags('{domain}')
export class XController {
  // @Roles завжди на кожному методі
  // orgId: string = req['user'].orgId — через @CurrentUser()
  // Повертає тільки Dto, ніколи Prisma-об'єкт напряму
}

// Service
// findMany завжди з: where: { orgId, deletedAt: null }, take: N
// Soft delete: { deletedAt: new Date() }, ніколи .delete()
// Append-only таблиці: ніколи .update() або .delete()
// List endpoint: завжди { items, total } — ніколи bare array
```

**Спеціальні правила по блоках:**

| Блок | Критичні правила |
|---|---|
| B12 WorkOrderMedia | MinIO через `FilesService.upload()` (вже є); signed URL через `FilesService.getSignedUrl(key, 3600)`; multipart через `@nestjs/platform-fastify` `req.file()`; max 10MB перевіряти; JPEG/PNG/HEIC/PDF |
| B11 AuditEvent | Append-only (без updatedAt/deletedAt/syncVersion); `diff` = JSON.stringify({ old: pick(oldData, changed), new: pick(newData, changed) }); викликати з WO/Invoice/Employee service через `.record()` — не через interceptor |
| B9 SSE Dashboard | `@Sse('/stream')` + `Observable` + `interval(30000)` pipe; JWT guard через query param `token` (EventSource не підтримує headers); fallback endpoint `GET /dashboard/summary` для polling |
| B8 FollowUp | BullMQ CRON `{ repeat: { cron: '0 9 * * *', tz: 'Europe/Kyiv' } }`; читати `followUpDays` з `OrganisationSettings`; SMS через `NotificationService.send()` з шаблоном `FOLLOWUP_REMINDER` |
| B5 Webhooks | `OutboundWebhookProcessor` підписується на NestJS events через `@OnEvent()`; HMAC-SHA256 підпис payload в `X-STO-Signature` header; attempts=5, exponential backoff |
| B4 Loyalty | `earn()` і `redeem()` через BullMQ — не в основній tx; `redeem()` створює `SettlementsService.createTransaction(CREDIT_NOTE)` |
| B3 Warranty | Auto-create при WO `COMPLETED` у `work-orders.service.ts` transition handler; `warrantyDays` читати з `SettingsService.get(orgId)` |
| B2 Booking | `GET /booking/availability` — `@Public()`; `POST /booking/request` — `@Public()`; SMS підтвердження через BullMQ |
| B1 Inspection | `POST /work-orders/:id/inspection` — якщо CRITICAL point → `prisma.workOrderLine.createMany()` з відповідними Work з каталогу |
| F4 Clone WO | Клонувати лінії і запчастини, але БЕЗ: payments, reservations, media, completion acts; новий статус = DRAFT; новий номер через `DocumentNumberService.next()` |

### 2.3 Frontend (якщо є `[sto-web]` задача)

**Обов'язкові правила:**

```typescript
// Кожна сторінка/секція:
// - loading стан: <Spinner />
// - empty стан: "Немає даних" або <EmptyState />
// - error стан: div з text-destructive-text bg-destructive-subtle
// - cancelled flag pattern для useEffect з fetch:
useEffect(() => {
  let cancelled = false;
  apiFetch('/endpoint').then(d => { if (!cancelled) setState(d); });
  return () => { cancelled = true; };
}, []);
```

**Tailwind:**
- Тільки canonical токени: `bg-surface`, `border-border`, `text-foreground`, `text-muted-foreground`
- НЕ inline HSL: `text-[hsl(...)]` — тільки `text-destructive-text`, `text-success`, `text-warning`
- НЕ `(--color-X)` shorthand — тільки `bg-primary`, `border-primary` тощо

**Спеціальні правила по блоках:**

| Блок | Критичні правила |
|---|---|
| B12 Media Gallery | drag-and-drop: `<input type="file" accept="image/*" multiple />` + onDrop handler; lightbox через simple state (показувати повне фото); `URL.revokeObjectURL` після завантаження |
| B11 Audit | Стрічка у DetailPanel під коментарями; формат: "Іван змінив статус DRAFT → IN_PROGRESS о 14:32 21.05.2026" |
| B9 SSE | `EventSource` у `useEffect` з cleanup `es.close()`; reconnect через `es.onerror` + setTimeout 5s; fallback polling якщо `!window.EventSource` |
| F9 DatePicker | `react-day-picker` v9 + `date-fns` uk locale; popover через `@headlessui/react` Popover або власний; тиждень з понеділка `weekStartsOn: 1`; формат display `DD.MM.YYYY`, value `YYYY-MM-DD` для API |
| F4 Clone | Після clone — `router.push('/work-orders/' + newId)` |
| F5 Print | `@media print { .no-print { display: none !important; } .print-full { width: 100% !important; } }` в globals.css; кнопка "Друк" у картці WO і Invoice |
| F3 Optimistic | `useOptimisticMutation<T>(mutationFn, { onOptimisticUpdate, onRollback })` хук; застосувати до FSM-кнопок у WO card + оплата Invoice |
| F2 Calendar DnD | `@dnd-kit/core` + `@dnd-kit/sortable`; при drop → `PATCH /calendar/slots/:id { startAt, endAt }`; показати ghost slot під час drag |

---

## Крок S — Синхронізація фронт ↔ бек (запускати окремо або після Кроку 2)

> Виклик: `/sto-phase sync` або якщо юзер каже "синхронізуй фронт з беком".

### Алгоритм

```
1. Скласти матрицю: backend modules ↔ frontend pages/tabs
2. Перевірити Direction 1: бек→фронт (є API — немає UI)
3. Перевірити Direction 2: фронт→бек (фронт кличе неіснуючий/неправильний endpoint)
4. Перевірити Direction 3: контракт типів (interface vs toResponseDto())
5. Виправити всі знайдені розбіжності
6. pnpm tsc --noEmit — 0 errors
7. git commit -m "fix(sync): ..."
```

### Direction 1 — Бек → Фронт (відсутній UI)

```bash
# Список модулів без відповідної сторінки/вкладки
ls apps/api/src/modules/
ls apps/web/src/app/
```

Для кожного модуля без UI — визначити куди додати:
- Нова сторінка → якщо це основна сутність (список + деталі)
- Нова вкладка → якщо це підлегла сутність (вкладка у деталях батьківської сторінки)
- Вкладка в налаштуваннях → якщо це довідник (payment-methods, tax-rates, notification-templates, brands)

### Direction 2 — Фронт → Бек (неправильні endpoint URLs)

```bash
# Знайти всі apiFetch виклики
grep -rn "apiFetch(" apps/web/src/ --include="*.tsx" --include="*.ts" | grep -v "lib/api-client"

# Звірити кожен URL з реальними @Controller + @Get/@Post маршрутами
grep -rn "@Controller\|@Get\|@Post\|@Patch\|@Delete\|@Put" apps/api/src/modules/ --include="*.controller.ts"
```

**Критичні патерни:**
- `@Controller('counterparties/:counterpartyId')` → URL = `/counterparties/${id}/transactions`, **НЕ** `/settlements?counterpartyId=...`
- Nested controllers завжди мають складний URL: `/parent/:parentId/child`
- `{ items, total }` на всіх list endpoints — фронт ніколи не очікує bare array

### Direction 3 — Контракт типів

```bash
# Знайти всі interface у page.tsx / PageClient.tsx
grep -rn "^interface " apps/web/src/app/ --include="*.tsx"

# Знайти відповідні toResponseDto() у сервісах
grep -rn "toResponseDto\|toDto\|mapToDto" apps/api/src/modules/ --include="*.service.ts" --include="*.ts" | grep -v "spec"
```

**Часті розбіжності:**
- `user.sub` у backend — завжди `user.id` (AuthenticatedUser interface)
- `description` у фронтенді → може бути `notes` у бекенді (перевіряй Prisma schema)
- Сума як `number` у фронтенді → `Decimal` у Prisma → `Number(t.amount)` при серіалізації
- `PAYMENT/PREPAYMENT/REFUND/CREDIT_NOTE` = зменшення балансу (зелений), `CHARGE` = борг (червоний)

### Чеклист синхронізації

- [ ] Кожен backend модуль має відповідний UI (сторінка / вкладка / секція)
- [ ] Кожен `apiFetch(url)` у фронтенді відповідає реальному endpoint у контролері
- [ ] Nested controller URLs використовуються правильно (не query params замість path params)
- [ ] Всі `interface` у page.tsx відповідають `toResponseDto()` полям (назви + типи)
- [ ] `user.sub` → `user.id` у всіх контролерах
- [ ] List endpoints: `{ items, total }` (не bare array) — фронт використовує `r.items`
- [ ] Знаки транзакцій: PAYMENT/PREPAYMENT/REFUND/CREDIT_NOTE = '-' (виплата), CHARGE = '+' (борг)
- [ ] `pnpm tsc --noEmit --incremental false` — 0 errors після всіх виправлень

---

## Крок 3 — Позначити [x] + git commit

Після успішної реалізації кожної задачі:

```bash
# 1. Позначити в PHASES.md
# Знайти рядок і замінити [ ] на [x]
sed -i 's/- \[ \] \[sto-...\] <текст задачі>/- [x] .../' docs/PHASES.md
# (використовуй Edit tool — точний рядок)

# 2. TypeScript перевірка
pnpm --filter @sto/web exec tsc --noEmit --incremental false
pnpm --filter @sto/api exec tsc --noEmit

# 3. Commit
git add apps/ packages/ docs/PHASES.md
git commit -m "feat(<block>): <назва блоку> — <коротко що додано>"
```

---

## Крок 4 — Автоматичне QA

Після коміту — **без запиту** запустити послідовно:

```python
# Code review
Agent(subagent_type="sto-review-agent", description="review after <block>")
# після завершення:
Agent(subagent_type="sto-tester-agent", description="test after <block>")
```

---

## Крок 5 — Оновити MemoryManual.md

Після фінального QA-коміту — оновити в `MemoryManual.md`:

```markdown
## Останній commit
<hash> <commit message>
Дата: YYYY-MM-DD

## Поточний стан проєкту
TypeScript: ✅ 0 errors  (або ❌ N errors)
```

Якщо новий блок додав нові gotchas або змінив архітектуру — дописати у відповідний розділ.

---

## Контрольний список перед відміткою [x]

- [ ] Prisma модель відповідає spec у PHASES.md
- [ ] Міграція застосована і НЕ дропає GIN індекси
- [ ] Controller має `@UseGuards` + `@Roles` на кожному методі
- [ ] Кожен `findMany` має `orgId` + `deletedAt: null` + `take: N`
- [ ] List endpoint повертає `{ items, total }` — не bare array
- [ ] Frontend має loading/empty/error стани
- [ ] `useEffect` з fetch має cancelled-flag або AbortController
- [ ] `URL.revokeObjectURL` обгорнуто в `setTimeout(..., 100)`
- [ ] Blob PDF downloads через `apiBlobFetch` (не raw fetch)
- [ ] Tailwind: тільки canonical токени, без inline HSL
- [ ] `pnpm tsc --noEmit --incremental false` — 0 errors
- [ ] `git commit` зроблено

---

## Пріоритетна таблиця залишкових блоків

| Блок | Назва | Задач | Складність |
|---|---|---|---|
| B12 | Фотозвіт (WorkOrderMedia) | 3 | MEDIUM |
| B11 | Audit Log | 3 | MEDIUM |
| B9+F7 | SSE Dashboard | 4 | MEDIUM |
| B8 | FollowUp CRON | 3 | LOW |
| B5 | Webhooks | 3 | MEDIUM |
| B4 | Loyalty | 3 | HIGH |
| B3 | Warranty | 3 | MEDIUM |
| B2 | Booking | 3 | HIGH |
| B1 | Inspection Report | 3 | MEDIUM |
| F9 | DatePickerInput | 1 | LOW |
| F4 | Clone WO/Invoice | 2 | LOW |
| F5 | Print CSS | 1 | LOW |
| F3 | useOptimisticMutation | 1 | LOW |
| F2 | Calendar DnD | 1 | MEDIUM |
| F11 | SyncIndicator offline | 1 | LOW |
| B10 (залишок) | Employee branches UI | 1 | LOW |
| Фаза 18 | Installer | 7 | HIGH |
