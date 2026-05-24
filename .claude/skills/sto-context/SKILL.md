---
name: sto-context
description: >
  STO ERP project context — master skill. Load at the start of every session or whenever you need the project architecture, conventions, domain model, monorepo structure, or tech stack. Use when the user mentions "STO ERP", "наш проект", "erp для сто", or works on any monorepo package. All other sto-* skills rely on this context.
---

# STO ERP — Project Context


## ⚡ ПЕРШИЙ КРОК: перевір поточний прогрес

**До будь-якої відповіді** виконай наступне — **три файли паралельно**:

1. Прочитай `MemoryManual.md` — актуальна карта коду, gotchas, changelog
2. Прочитай `docs/PHASES.md` — знайди **першу задачу з `[ ]`**
3. Прочитай `.claude/memory/MEMORY.md` — user preferences та feedback

З `docs/PHASES.md` збери **нотатки** `>` під останніми `[x]` задачами поточної фази — це контекст що вже зроблено.

Виведи блок статусу:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📍 ПОТОЧНИЙ СТАН STO ERP
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Фаза:     [Номер та назва фази]
Задача:   [Текст першої незакресленої задачі]
Скіл:     /[назва скіла або "ручна"]
Прогрес:  [N виконано] / [Total задач]

Нещодавно зроблено:
  ✓ [Остання [x] задача] — [її нотатка >]
  ✓ [Передостання [x] задача] — [її нотатка >]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

5. Якщо є задачі з `[~]` — відображай їх першими зі статусом "⏳ в процесі" і показуй нотатку
6. Якщо **всі задачі фази завершені** (`[x]`) — **ОБОВ'ЯЗКОВО зроби git commit** перед переходом до наступної фази (див. правило нижче)
7. Після блоку статусу **запитай**: "Продовжуємо з цієї задачі, чи є інше завдання?"

> **ПРАВИЛО: коміт після кожної фази**  
> Коли остання задача фази відмічена `[x]` — одразу виконай git commit без додаткового запиту:
> ```bash
> git status
> git add apps/ packages/ docs/PHASES.md docker-compose*.yml CLAUDE.md
> git commit -m "feat(phaseN): <назва фази>"
> ```
> Не чекати підтвердження від користувача. Якщо є незакомічені зміни з попередніх фаз — включити їх теж.

> Якщо `docs/PHASES.md` не знайдено — повідом про це і зупинись.  
> Нотатки `>` — це головний контекст для розуміння що вже реалізовано. Читай їх уважно.

---

STO ERP — гібридна ERP-система для автосервісів України.

## НЕЗМІННА АРХІТЕКТУРНА ВИМОГА

> **Система повністю функціонує БЕЗ інтернету.**
> Cloud-синхронізація — опціональна надбудова, не залежність.
> Розгортання — через Windows installer (.exe) на локальний ПК/сервер СТО.

Це означає:
- Всі сервіси (API, БД, черги, файли) — локально в Docker Compose
- Відсутність інтернету не порушує жодну бізнес-функцію
- Зовнішні API (SMS, ПРРО, постачальники) — завжди через BullMQ чергу: якщо offline → retry при відновленні
- installer `.exe` містить усе необхідне, включно з Docker images

---

## Deployment Model

```
┌──────────────────────────────────────────────────┐
│   ЛОКАЛЬНИЙ СЕРВЕР / ПК СТО  (Windows 10/11)      │
│                                                   │
│   STO-ERP-Setup.exe  (одноразова інсталяція)      │
│     ├── встановлює Docker Desktop (якщо немає)    │
│     ├── розгортає Docker Compose stack:           │
│     │     api      :3000  (NestJS)                │
│     │     web      :80    (Next.js static)        │
│     │     postgres :5432  (PostgreSQL 16)         │
│     │     redis    :6379  (Redis 7)               │
│     │     minio    :9000  (MinIO — файли)         │
│     │     caddy    :80/443 (reverse proxy)        │
│     └── створює Windows service "STO ERP"        │
│                                                   │
│   Доступ у локальній мережі СТО:                  │
│     http://sto.local  або  http://<IP-сервера>    │
│   Планшети механіків — через WiFi ЛАН             │
└───────────────────────┬──────────────────────────┘
                        │ HTTPS (тільки якщо є інтернет)
                        ▼ ОПЦІОНАЛЬНО
                 Cloud Sync Hub
         (backup + client portal + multi-branch)
```

---

## Monorepo Structure

```
sto-erp/
├── apps/
│   ├── api/         NestJS 10 + Fastify      (port 3000)
│   ├── web/         Next.js 15 static export  (port 80)
│   └── mobile/      Expo SDK 53 + RN          (offline-first, WatermelonDB)
├── packages/
│   ├── database/    Prisma 5 + PostgreSQL 16
│   ├── shared/      TypeScript types, Zod schemas, constants
│   ├── ui/          Shared React components (shadcn/ui)
│   └── config/      ESLint, TSConfig, Vitest
├── installer/
│   ├── inno/        Inno Setup scripts (.iss)
│   ├── scripts/     PowerShell: install, update, backup, restore
│   ├── assets/      Icons, license, splash
│   └── bundle/      Docker images (.tar.gz) — gitignored, CI-generated
├── docker-compose.yml        ← production (on-prem)
├── docker-compose.dev.yml    ← local development
├── docs/architecture/        ← ADR files
└── CLAUDE.md
```

---

## Tech Stack

| Layer | Technology | Offline |
|-------|-----------|---------|
| Backend | NestJS 10 + Fastify | ✅ |
| Database | PostgreSQL 16 + Prisma 5 | ✅ |
| Queue/Cache | Redis 7 + BullMQ | ✅ |
| File Storage | MinIO | ✅ |
| Web UI | Next.js 15 (static export) | ✅ |
| UI Kit | shadcn/ui + Tailwind 4 | ✅ |
| Mobile | Expo SDK 53 + WatermelonDB | ✅ |
| Proxy | Caddy (self-signed local TLS) | ✅ |
| **Installer** | **Inno Setup + PowerShell** | ✅ |
| SMS | TurboSMS → BullMQ queue | ⚡ retry |
| ПРРО | Checkbox → BullMQ queue | ⚡ retry |
| Cloud Sync | Outbox → Sync Hub | 🔵 opt. |

---

## Offline Queue Pattern (ОБОВ'ЯЗКОВО для зовнішніх API)

```typescript
// ЗАВЖДИ через BullMQ — ніколи прямий виклик
await this.smsQueue.add('send', { phone, message }, {
  attempts: 10,
  backoff: { type: 'exponential', delay: 60_000 },
});

// BullMQ з Redis працює ЛОКАЛЬНО — черга не залежить від інтернету
// При відновленні з'єднання Redis retry запрацює автоматично
```

---

## Domain Model

### Infrastructure
- **Organisation** — тенант (одна локальна інсталяція = одна org)
- **GarageBranch** — філія СТО
- **Zone** — зона (MECHANICAL|BODY|TIRE|WASH|ELECTRICAL)
- **Lift** — підйомник/стенд
- **Warehouse** — склад (MAIN|WORKSHOP|TIRE_HOTEL|MOBILE)
- **Employee** — M:M → Zone, Lift, WorkCategory

### CRM
- **Counterparty** — клієнт або постачальник
- **CustomerGarage** — гараж клієнта
- **Vehicle** — авто (VIN, марка, модель, пробіг)
- **VehicleNode** — вузол авто

### Catalog
- **WorkCategory** → **Work** (норма-год) → **Service** (пакет)
- **Good** — запчастина / витратний матеріал

### Work Orders
- **WorkOrder** FSM: Draft→Estimate→Approved→InProgress→OnHold→Completed→Invoiced→Paid→Archived
- **WorkOrderLine** — робота + виконавець + підйомник + M:M асистенти
- **WorkOrderPart** — запчастина з резервуванням

### Inventory (append-only log)
- **StockItem** — поточний залишок
- **StockMovement** — кожен рух (RECEIPT|WRITEOFF|TRANSFER|RESERVATION)

### Finance (append-only log)
- **Invoice**, **Payment**, **SettlementAccount**, **SettlementTransaction**, **ReconciliationAct**

### Scheduling
- **CalendarSlot** — підйомник + механік + наряд + час

---

## Sync-Ready Fields (КОЖНА таблиця)

```prisma
id          String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
orgId       String    @db.Uuid
createdAt   DateTime  @default(now())
updatedAt   DateTime  @updatedAt
deletedAt   DateTime?
syncVersion BigInt    @default(0)
```

---

## Ukrainian UI Standards

- Мова: **uk-UA**, всі UI рядки — кирилиця
- Дата: `DD.MM.YYYY` → `21.05.2026`
- Час: `HH:mm` (24-год) → `14:30`
- Валюта: `1 250,00 ₴`
- Телефон: `+38 (067) 123-45-67`
- Timezone: `Europe/Kyiv`

---

## Critical Rules

1. **Offline-first**: система ПОВНІСТЮ працює без інтернету
2. **External API через BullMQ**: SMS, ПРРО, постачальники — тільки через чергу
3. **Soft delete**: `{ deletedAt: new Date() }` — ніколи `prisma.X.delete()`
4. **Append-only**: StockMovement і SettlementTransaction незмінні
5. **Stock via InventoryService.createMovement()** — ніколи напряму
6. **Settlement via SettlementsService.createTransaction()** — ніколи напряму
7. **WO FSM через transition map** — ніколи прямий запис статусу
8. **Installer**: `installer/` — окремий Inno Setup проєкт

---

## Key Files to Read Before Any Task

1. `packages/database/schema.prisma`
2. `packages/shared/src/types/index.ts`
3. `packages/shared/src/schemas/index.ts`
4. `docs/architecture/` — ADR файли
5. Відповідний `*.service.ts`

---

## Running (Development)

```bash
docker-compose -f docker-compose.dev.yml up -d
pnpm dev
# API:  http://localhost:3000/api/docs
# Web:  http://localhost:3001
# DB:   pnpm --filter @sto/database prisma studio
```
