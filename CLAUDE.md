# STO ERP — Claude Code Instructions

## Проект
STO ERP — гібридна ERP-система для автосервісів України.
**Головна вимога: повна офлайн-незалежність.** Система працює без інтернету.
Розгортання через Windows installer (.exe) на локальний ПК/сервер СТО.

## Середовище розробки
- **ОС:** Windows 10/11 + WSL2
- **IDE:** VSCode + Git Bash terminal
- **Мова інтерфейсу:** У��раїнська (кирилиця)
- **Пакетний менеджер:** pnpm (workspaces + Turborepo)

## Monorepo структура
```
sto-erp/
├── apps/
│   ├── api/          @sto/api       — NestJS 10 + Fastify (port 3000)
│   ├── web/          @sto/web       — Next.js 15 static export (port 80)
│   └── mobile/       @sto/mobile    — Expo SDK 53 + RN (offline-first)
├── packages/
│   ├── database/     @sto/database  — Prisma 5 + PostgreSQL 16
│   ├── shared/       @sto/shared    — TypeScript types, Zod schemas
│   ├── ui/           @sto/ui        — Shared React components
│   └── config/                      — ESLint, TSConfig, Vitest
├── installer/                       — Inno Setup + PowerShell
├── docs/architecture/               — ADR файли
├── docker-compose.yml               — production on-prem
├── docker-compose.dev.yml           — local development
└── CLAUDE.md
```

## Скіли — завантажувати на початку сесії
```
/sto-context    <- ЗАВЖДИ ПЕРШИМ
/sto-analyst    <- для вимог та бізнес-процесів
/sto-feature    <- для планування фічей
/sto-architect  <- для архітектурних рішень (ADR)
/sto-database   <- для змін Prisma schema
/sto-backend    <- для NestJS модулів (читай /sto-dev перед написанням)
/sto-web        <- для Next.js UI (читай /sto-dev перед написанням)
/sto-mobile     <- для Expo додатку
/sto-dev        <- стандарти написання коду: TS, NestJS, Next.js, Tailwind, Prisma
/sto-review     <- для code review (перевіряє що /sto-dev дотриманий)
/sto-tester     <- для тестування: знаходить баги, фіксує, виправляє
/sto-installer  <- для Windows installer
/sto-git        <- для git: commit, branch, changelog, статус
/sto-phase      <- реалізує наступний блок фаз (database→backend→frontend→QA), автоматично
```

## Типовий workflow нової фічі

> **ПРАВИЛО: план мод обов'язковий перед реалізацією**
> 1. **Перед** будь-яким новим функціоналом — увійти в план мод (`/plan` або `EnterPlanMode`)
> 2. Узгодити план з користувачем (кроки, файли, рішення)
> 3. Після підтвердження — вийти з плану (`ExitPlanMode`) і реалізувати
> 4. Під час реалізації план мод **вимкнений** — просто пишемо код
>
> Це правило НЕ стосується: дрібних фіксів (1–2 файли), виправлення багів, оновлення документації.

> **ПРАВИЛО: dev-сервер обов'язковий при будь-яких змінах коду**
> Перед початком реалізації — переконатись що запущені **всі три сервери**:
> ```bash
> docker-compose -f docker-compose.dev.yml up -d   # БД + Redis + MinIO
> pnpm --filter @sto/api dev                        # API  → http://localhost:3000
> pnpm --filter @sto/web dev                        # Web  → http://localhost:3001
> ```
> Після кожної зміни UI — **перевірити у браузері** (не тільки tsc). Якщо сервер впав — перезапустити перед наступним кроком.
>
> Це правило стосується: нові сторінки, зміни компонентів, нові API endpoints, будь-які зміни що впливають на UI.

```
/plan (EnterPlanMode)
  ↓ узгодження
ExitPlanMode
  ↓ запуск dev-серверів
  ↓ реалізація + перевірка у браузері після кожного кроку
/sto-context -> /sto-analyst -> /sto-feature -> /sto-database -> /sto-dev -> /sto-backend -> /sto-web -> /sto-review -> /sto-tester
```

> `/sto-dev` читається **перед** `/sto-backend` і `/sto-web` — задає стандарти написання,  
> щоб `/sto-review` знаходив 0 проблем.

## Автономний вибір скілів (ОБОВ'ЯЗКОВО)

Коли отримуєш завдання на написання або зміну коду — **самостійно** вибирай і читай потрібні скіли без явної команди від користувача:

| Тип зміни | Читати |
|---|---|
| Будь-яка зміна коду | `MemoryManual.md` — першим завжди |
| Зміна `schema.prisma`, нова міграція | `/sto-database` SKILL.md |
| Новий NestJS модуль / сервіс / контролер | `/sto-backend` SKILL.md + `/sto-dev` SKILL.md |
| Зміна наявного сервісу чи DTO | `/sto-dev` SKILL.md (патерни) |
| Новий Next.js компонент / сторінка | `/sto-web` SKILL.md + `/sto-dev` SKILL.md |
| Зміна Expo / mobile | `/sto-mobile` SKILL.md |
| Новий Inno Setup / PowerShell скрипт | `/sto-installer` SKILL.md |

> Не чекай на `/sto-backend`, `/sto-web` тощо від користувача — якщо пишеш бекенд, сам читай скіл.  
> Виняток: якщо сам запит є скіл-командою (наприклад `/sto-database`) — скіл вже завантажений, не читай повторно.

## Агенти (project-level, запускати через Agent tool)

`.claude/agents/` містить готових агентів з власними системними промптами:

```
sto-review-agent   ← code review + авто-фікс (завжди через Agent tool)
sto-tester-agent   ← bug hunt + авто-фікс (завжди через Agent tool)
```

**ПРАВИЛО:** `/sto-review` і `/sto-tester` ЗАВЖДИ запускати через `Agent(subagent_type="sto-review-agent")` і `Agent(subagent_type="sto-tester-agent")` — НЕ як inline скіли. Це захищає основний контекст від переповнення і дозволяє паралельний запуск.

```python
# Послідовно (review → tester)
Agent(subagent_type="sto-review-agent", description="code review cycle N")
# після завершення:
Agent(subagent_type="sto-tester-agent", description="bug hunt cycle N")

# Паралельно (якщо review і tester незалежні):
# Надіслати обидва Agent() виклики в одному повідомленні
```

## Автоматичне QA після кожного завдання (ОБОВ'ЯЗКОВО)

Після завершення **будь-якого** завдання і git commit — **завжди автоматично**:
1. `Agent(subagent_type="sto-review-agent")` — code review, виправити всі знайдені проблеми
2. `Agent(subagent_type="sto-tester-agent")` — тести, BUG_REPORT.md, виправити всі баги
3. Оновити `MemoryManual.md` якщо з'явились нові gotchas або зміни архітектури

> Виняток: якщо сам запит був review або tester агент — не запускати рекурсивно.

## Безперервне вдосконалення скілів (ОБОВ'ЯЗКОВО)

Після кожного запуску `/sto-review` або `/sto-tester` — запитай себе:

> "Цей баг/проблема були охоплені існуючим чеклістом?"

Якщо **НІ** — одразу оновити відповідний скіл:
- Новий патерн помилки → додати до `/sto-dev` (❌/✅ приклад) + `/sto-review` (checklist item)
- Новий grep для автоматичного виявлення → додати bash команду в `/sto-review`
- Бізнес-логіка специфічна для STO ERP (FSM, інвентар, розрахунки) → `/sto-dev` Business Rules + `/sto-review`
- Tailwind/TS/Prisma паттерн → тільки `/sto-dev` (одне місце правди)
- Commit: `docs(skills): add <pattern> check to sto-dev/sto-review/sto-tester`

Скіли мають відображати **реальні баги які траплялись** — не гіпотетичні.

## Відновлення після ліміту / нова сесія

Після відновлення (rate limit, новий контекст, нова сесія):
1. Прочитати `MemoryManual.md` — поточний стан коду
2. Прочитати `docs/PHASES.md` — де зупинились
3. Прочитати `.claude/memory/MEMORY.md` — preferences
4. Продовжити з місця зупинки без питань
5. Перезапустити щогодинний моніторинг: `/loop 1h` з промптом із `.claude/scheduled_tasks.json`

## Щогодинний моніторинг (loop)

Cron живе тільки в межах сесії. При ст��рті нової сесії — перезапустити через:
```
/loop 1h
```
Промпт дл�� loop знаходиться у `.claude/scheduled_tasks.json`.

Що роби��ь loop кожну годину:
- Читає `MemoryManual.md` + `PHASES.md` + `MEMORY.md`
- Якщо є `[~]` задача — продовжує виконання
- Якщо є незавершене QA — запус��ає `/sto-review` -> `/sto-tester` -> оновлює `MemoryManual.md`
- Якщо все чисто — виводить статус і чекає наступного тіку

## Критичні правила (ОБОВ'ЯЗКОВО)

### Офлайн-незалежність
1. **Зовнішні API** (SMS, ПРРО, прайси) — тільки через BullMQ чергу, ніколи прямий виклик
2. **Черга з retry** — attempts >= 10, backoff exponential; для ПРРО attempts=288 (24 год)
3. **Система не зупиняється** при відсутності інтернету

### База даних
4. **Кожна таблиця** має: `id` (UUID), `orgId`, `createdAt`, `updatedAt`, `deletedAt`, `syncVersion`
5. **Soft delete скрізь** — ніколи `prisma.X.delete()`, тільки `{ deletedAt: new Date() }`
6. **Кожен запит** фільтрується по `orgId` (tenant isolation)

### Бізнес-логіка
7. **Зміни залишків** — тільки через `InventoryService.createMovement()`
8. **Зміни балансу** — тільки через `SettlementsService.createTransaction()`
9. **FSM нарядів** — тільки через transition map у `WorkOrdersService.transition()`

### Конфігурованість (Configuration over Hardcode)
10. **Налаштування в БД** — терміни, ліміти, шаблони, способи оплати -> моде��і `OrganisationSettings`, `BranchSettings`, `NotificationTemplate`, `PaymentMethodConfig`, `TaxRate`
11. **ПРРО та SMS** -> `BranchSettings` (per branch), НЕ тільки в `.env`
12. **Нумерація документів** -> `DocumentNumberConfig`, ніяких hardcoded форматів у коді
13. **Ніяких magic numbers у коді** — `invoiceDueDays`, `autoArchiveDays`, `warrantyDays`, `slotDurationMinutes` читаються з БД через `SettingsService.get(orgId)`
14. **Шаблони повідомлень** — текст SMS/Viber/Email тільки з `NotificationTemplate`, не рядкові літерали у сервісах

### UI
15. **Весь UI** — українською мовою (кирилиця)
16. **Валідація** (Zod) — повідомлення українською
17. **API помилки** — українською

## ADR — прийняті архітектурні рішення
| Файл | Рішення |
|------|---------|
| ADR-001 | Local-first offline architecture |
| ADR-002 | Docker Compose як одиниця розгортання |
| ADR-003 | Inno Setup + PowerShell для Windows installer |
| ADR-004 | WatermelonDB для offline-first mobile |
| ADR-005 | BullMQ черга для зовнішніх API |
| ADR-006 | Опціональна cloud sync (Outbox Pattern) |
| ADR-007 | Стратегія автоматичного оновлення |

## Запуск (розробка)
```bash
docker-compose -f docker-compose.dev.yml up -d
pnpm dev
# API:    http://localhost:3000/api/docs
# Web:    http://localhost:3001
# Mobile: pnpm --filter @sto/mobile start
# DB:     cd packages/database && pnpm prisma studio
```

## Локаль та форматування
- Мова: `uk-UA` | Timezone: `Europe/Kyiv`
- Валюта: `UAH`, формат: `1 250,00 грн`
- Дата: `DD.MM.YYYY` | Час: `HH:mm` (24-год)
- Тиждень: починається з понеділка
