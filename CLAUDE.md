# STO ERP — Claude Code Instructions

## Проєкт
STO ERP — гібридна ERP-система для автосервісів України.
**Головна вимога: повна офлайн-незалежність.** Система працює без інтернету.
Розгортання через Windows installer (.exe) на локальний ПК/сервер СТО.

## Середовище розробки
- **ОС:** Windows 10/11 + WSL2
- **IDE:** VSCode + Git Bash terminal
- **Мова інтерфейсу:** Українська (кирилиця)
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
/sto-context    ← ЗАВЖДИ ПЕРШИМ
/sto-analyst    ← для вимог та бізнес-процесів
/sto-feature    ← для планування фічей
/sto-architect  ← для архітектурних рішень (ADR)
/sto-database   ← для змін Prisma schema
/sto-backend    ← для NestJS модулів
/sto-web        ← для Next.js UI
/sto-mobile     ← для Expo додатку
/sto-review     ← для code review
/sto-installer  ← для Windows installer
```

## Типовий workflow нової фічі
```
/sto-context → /sto-analyst → /sto-feature → /sto-database → /sto-backend → /sto-web → /sto-review
```

## Критичні правила (ОБОВ'ЯЗКОВО)

### Офлайн-незалежність
1. **Зовнішні API** (SMS, ПРРО, прайси) — тільки через BullMQ чергу, ніколи прямий виклик
2. **Черга з retry** — attempts ≥ 10, backoff exponential; для ПРРО attempts=288 (24 год)
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
10. **Налаштування в БД** — терміни, ліміти, шаблони, способи оплати → моделі `OrganisationSettings`, `BranchSettings`, `NotificationTemplate`, `PaymentMethodConfig`, `TaxRate`
11. **ПРРО та SMS** → `BranchSettings` (per branch), НЕ тільки в `.env`
12. **Нумерація документів** → `DocumentNumberConfig`, ніяких hardcoded форматів у коді
13. **Ніяких magic numbers у коді** — `invoiceDueDays`, `autoArchiveDays`, `warrantyDays`, `slotDurationMinutes` читаються з БД через `SettingsService.get(orgId)`
14. **Шаблони повідомлень** — текст SMS/Viber/Email тільки з `NotificationTemplate`, не рядкові літерали у сервісах

### UI
10. **Весь UI** — українською мовою (кирилиця)
11. **Валідація** (Zod) — повідомлення українською
12. **API помилки** — українською

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
- Валюта: `₴` (UAH), формат: `1 250,00 ₴`
- Дата: `DD.MM.YYYY` | Час: `HH:mm` (24-год)
- Тиждень: починається з понеділка
