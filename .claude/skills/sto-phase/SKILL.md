---
name: sto-phase
description: >
  Phase review and implementation skill for STO ERP. Reads PHASES.md, finds the next unchecked [ ] task group (by block: B1, B2, F3, etc.), implements all sub-tasks (database → backend → frontend), marks them [x], then runs QA. Use when the user says "реалізуй фазу", "наступний блок", "реалізуй все", "продовжуємо", or when resuming work after a session break. Automatically chains: sto-database → sto-backend → sto-web → sto-sync-agent (if both backend+frontend changed) → sto-review-agent → sto-tester-agent.
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
# 1. Поточний стан коду (MemoryManual.md читається ТУТ — sub-skills його не перечитують)
cat MemoryManual.md

# 2. Прогрес фаз — знайти першу [ ] групу
grep -n "\[ \]\|\[x\]" docs/PHASES.md | head -100

# 3. User preferences
cat .claude/memory/MEMORY.md
```

> **Sub-skills (sto-database, sto-backend, sto-web)** мають у своїх Before Starting "Read MemoryManual.md". При виклику з sto-phase **пропускай цей крок в sub-skills** — він вже виконаний тут. Це зменшує подвійне читання одного файлу.

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

> Правила написання коду — в окремих скілах. Читай їх перед написанням, не дублюй тут.

### 2.1 Database (якщо є `[sto-database]` задача)

→ Читай **`sto-database`** скіл для повних правил.

Швидкий чеклист:
```
1. Прочитай schema.prisma — перевір чи модель вже існує
2. Додай модель з обов'язковими полями (id UUID, orgId, createdAt, updatedAt, deletedAt, syncVersion)
3. pnpm --filter @sto/database prisma migrate dev --name <block-name>
4. ПЕРЕВІР: grep "DROP INDEX" migration.sql — якщо є GIN-індекси, видали DROP команди
```

### 2.2 Backend (якщо є `[sto-backend]` задача)

→ Читай **`sto-backend`** + **`sto-dev`** скіли для повних правил.

Швидкий чеклист:
```
1. Структура: {domain}.module.ts / .controller.ts / .service.ts / .dto.ts / .spec.ts
2. Controller: @UseGuards + @Roles на кожному методі, повертає тільки Dto
3. Service: findMany з orgId + deletedAt: null + take: N; soft delete; { items, total }
4. Зареєструй модуль у app.module.ts
```

**Специфіка блоків** (критичні деталі яких немає в sto-backend):

| Блок | Критичні деталі |
|---|---|
| B12 WorkOrderMedia | MinIO через `FilesService.upload()`; signed URL `getSignedUrl(key, 3600)`; multipart `req.file()`; max 10MB; JPEG/PNG/HEIC/PDF |
| B11 AuditEvent | Append-only; `diff` = JSON.stringify({old, new}); викликати через `.record()` — не через interceptor |
| B9 SSE Dashboard | `@Sse('/stream')` + `Observable`; JWT через query param `token`; fallback `GET /dashboard/summary` |
| B8 FollowUp | BullMQ CRON `'0 9 * * *'` + `tz: 'Europe/Kyiv'`; `followUpDays` з OrganisationSettings |
| B5 Webhooks | `@OnEvent()` + HMAC-SHA256 в `X-STO-Signature`; attempts=5 |
| B4 Loyalty | `earn()` і `redeem()` через BullMQ; `redeem()` → `SettlementsService.createTransaction(CREDIT_NOTE)` |
| B3 Warranty | Auto-create при WO `COMPLETED`; `warrantyDays` з `SettingsService.get(orgId)` |
| B2 Booking | `/availability` + `/request` — `@Public()`; SMS через BullMQ |
| B1 Inspection | CRITICAL point → `prisma.workOrderLine.createMany()` з каталогу |
| F4 Clone WO | БЕЗ: payments, reservations, media; статус=DRAFT; номер через `DocumentNumberService.next()` |

### 2.3 Frontend (якщо є `[sto-web]` задача)

→ Читай **`sto-web`** + **`sto-dev`** скіли для повних правил.

Швидкий чеклист:
```
1. loading / empty / error стани на кожній сторінці
2. useEffect з fetch → cancelled flag або AbortController
3. Tailwind: тільки canonical токени, без inline HSL, без (--color-X)
4. URL.revokeObjectURL → setTimeout(..., 100)
```

**Специфіка блоків** (критичні деталі яких немає в sto-web):

| Блок | Критичні деталі |
|---|---|
| B12 Media Gallery | `<input type="file" accept="image/*" multiple />` + onDrop; lightbox через state; `URL.revokeObjectURL` |
| B11 Audit | Стрічка під коментарями; формат: "Іван змінив статус DRAFT → IN_PROGRESS о 14:32 21.05.2026" |
| B9 SSE | `EventSource` з cleanup `es.close()`; reconnect onerror + setTimeout 5s; fallback якщо `!window.EventSource` |
| F9 DatePicker | `react-day-picker` v9 + `date-fns` uk; `weekStartsOn: 1`; display `DD.MM.YYYY`, value `YYYY-MM-DD` |
| F4 Clone | Після clone → `router.push('/work-orders/' + newId)` |
| F5 Print | `@media print` в globals.css; кнопка "Друк" у WO і Invoice |
| F3 Optimistic | `useOptimisticMutation<T>` хук; FSM-кнопки WO + оплата Invoice |
| F2 Calendar DnD | `@dnd-kit/core`; drop → `PATCH /calendar/slots/:id`; ghost slot під час drag |

---

## Крок S — Синхронізація фронт ↔ бек

> Деталі і чеклист — у **`sto-sync`** скілі: `.claude/skills/sto-sync/SKILL.md`
> Або запусти агент: `Agent(subagent_type="sto-sync-agent")`

Виклик: `/sto-phase sync` або `/sto-sync`, або юзер каже "синхронізуй фронт з беком".
Запускається автоматично у Кроці 4 коли блок містить і backend і frontend задачі.

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
# 1. Синхронізація фронт ↔ бек (перед QA — щоб review/tester бачили вже виправлений контракт)
# Запустити /sto-sync автоматично якщо блок містив і backend і frontend зміни
# Ознака: є [sto-backend] І [sto-web] задачі у тому самому блоці
Agent(subagent_type="sto-sync-agent", description="sync after <block>")  # якщо є і backend і frontend

# 2. Code review
Agent(subagent_type="sto-review-agent", description="review after <block>")

# 3. Bug hunt
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
