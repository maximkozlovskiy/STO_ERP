# STO ERP — План реалізації

> **Джерело правди про поточний прогрес.**  
> Після завершення кожного завдання — поставити `[x]` замість `[ ]`.  
> `sto-context` читає цей файл на початку кожної сесії і звітує про стан.

---

## Як читати цей файл

```
[ ] — не розпочато
[~] — в процесі (розпочато, але не завершено)
[x] — завершено
```

Перед кожним завданням вказано скіл, який його виконує:  
`[sto-database]`, `[sto-backend]`, `[sto-web]`, `[sto-mobile]` тощо.

### Формат нотатки після виконання

Одразу під кожним закресленим завданням — коротка нотатка для Claude Code:

```
[x] `[sto-database]` Назва задачі
    > Ключові файли: `path/to/file.ts`. Що зроблено / важливі рішення одним реченням.
```

**Приклади:**
```
[x] `[sto-backend]` `AuthModule`: POST /auth/login, POST /auth/refresh, POST /auth/logout
    > `apps/api/src/auth/`. JWT access 15хв (Bearer) + refresh 7д (httpOnly cookie). Bcrypt rounds=12.

[x] `[sto-database]` Перша міграція: prisma migrate dev --name init
    > `packages/database/prisma/migrations/20260522_init/`. 35 таблиць, усі enum-и. ~4 сек.

[x] `[sto-web]` Login-сторінка + AuthProvider
    > `apps/web/src/app/(auth)/login/page.tsx`. Middleware захищає всі роути крім /login та /setup.
```

> Нотатки пише **Claude автоматично** після завершення задачі — розробнику нічого робити не треба.  
> `sto-context` читає нотатки поряд із задачами — має повний контекст без читання коду.

---

## Фаза 0 — Bootstrap (монорепо + інфраструктура)

> Залежності: немає. Старт проєкту.  
> Мета: порожній, але запускаємий monorepo з усіма конфігами.

- [ ] `[ручна]` Ініціалізувати pnpm workspace + Turborepo (`turbo.json`, `pnpm-workspace.yaml`)
- [ ] `[ручна]` Створити структуру пакетів: `apps/{api,web,mobile}`, `packages/{database,shared,ui,config}`
- [ ] `[sto-database]` `packages/config` — ESLint, TSConfig (base, nestjs, nextjs, react-native), Vitest base config
- [ ] `[sto-backend]` `apps/api` — NestJS 10 + Fastify scaffold (`AppModule`, `main.ts`, Swagger, health endpoint)
- [ ] `[sto-web]` `apps/web` — Next.js 15 static export scaffold (`layout.tsx`, `globals.css`, shadcn/ui init)
- [ ] `[sto-mobile]` `apps/mobile` — Expo SDK 53 scaffold (bare workflow, `app/_layout.tsx`, NativeWind)
- [ ] `[sto-database]` `packages/database` — Prisma init, підключення до PostgreSQL, порожній `schema.prisma` з базовими налаштуваннями
- [ ] `[sto-database]` `packages/shared` — TypeScript типи з `@prisma/client`, Zod-схеми (порожні, готові до наповнення)
- [ ] `[ручна]` `docker-compose.yml` — PostgreSQL 16, Redis 7, MinIO, Caddy (з конфігами)
- [ ] `[sto-installer]` `installer/` — scaffold Inno Setup `.iss` + PowerShell bootstrap-скрипт

---

## Фаза 1 — Повна схема БД

> Залежності: Фаза 0 (Prisma ініціалізовано).  
> Мета: всі 35+ моделей з ERD.md в схемі, перша міграція пройшла.

- [ ] `[sto-database]` Всі enum-и: `WorkOrderStatus`, `EmployeeRole`, `StockMovementType`, `DocumentType`, `VatMode` та інші
- [ ] `[sto-database]` Bounded context **Infrastructure**: `Organisation`, `GarageBranch`, `Zone`, `Lift`, `Warehouse`
- [ ] `[sto-database]` Bounded context **Employees**: `Employee`, `EmployeeZone`, `EmployeeLift`, `EmployeeWorkCategory`
- [ ] `[sto-database]` Bounded context **CRM**: `Counterparty`, `CustomerGarage`, `Vehicle`, `VehicleNode`
- [ ] `[sto-database]` Bounded context **Catalog**: `WorkCategory`, `Work`, `Good`, `Service`, `ServiceWork`, `ServiceGood`
- [ ] `[sto-database]` Bounded context **Work Orders**: `WorkOrder`, `WorkOrderLine`, `WorkOrderLineEmployee`, `WorkOrderPart`
- [ ] `[sto-database]` Bounded context **Inventory**: `StockItem`, `StockMovement`, `PurchaseOrder`, `PurchaseOrderLine`, `StockDocument`, `StockDocumentLine`
- [ ] `[sto-database]` Bounded context **Finance**: `Invoice`, `Payment`, `SettlementAccount`, `SettlementTransaction`, `ReconciliationAct`
- [ ] `[sto-database]` Bounded context **Calendar**: `CalendarSlot`
- [ ] `[sto-database]` Bounded context **Settings**: `OrganisationSettings`, `BranchSettings`, `DocumentNumberConfig`, `NotificationTemplate`, `TaxRate`, `PaymentMethodConfig`
- [ ] `[sto-database]` Перша міграція: `prisma migrate dev --name init`
- [ ] `[sto-database]` `packages/shared` — TypeScript типи + Zod-схеми для всіх моделей

---

## Фаза 2 — Автентифікація

> Залежності: Фаза 1 (є таблиця `Employee` + `Organisation`).  
> Мета: JWT login/refresh, guard'и для всіх подальших модулів.

- [ ] `[sto-backend]` `AuthModule`: `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`
- [ ] `[sto-backend]` `JwtStrategy` (access 15 хв) + `RefreshTokenStrategy` (7 днів, httpOnly cookie)
- [ ] `[sto-backend]` `JwtAuthGuard`, `RolesGuard`, `OrgGuard` (автоматична фільтрація по `orgId`)
- [ ] `[sto-backend]` `CurrentUser` декоратор → `{ userId, orgId, role, branchId }`
- [ ] `[sto-web]` Login-сторінка (`/login`) + зберігання токена в httpOnly cookie
- [ ] `[sto-web]` `AuthProvider` (Next.js) + middleware для захисту роутів

---

## Фаза 3 — Налаштування та перший запуск

> Залежності: Фаза 2 (є OWNER-акаунт).  
> Мета: wizard першого запуску, автонумерація, SettingsService.

- [ ] `[sto-backend]` `SettingsService.get(orgId)` → читає `OrganisationSettings` + `BranchSettings` з Redis-кешем (5 хв)
- [ ] `[sto-backend]` `DocumentNumberingService.next(orgId, docType)` → атомарна видача номера через PostgreSQL `SELECT FOR UPDATE`
- [ ] `[sto-backend]` `SettingsModule`: `GET/PATCH /settings/organisation`, `GET/PATCH /settings/branch/:id`
- [ ] `[sto-backend]` `PaymentMethodConfigModule`: CRUD методів оплати
- [ ] `[sto-backend]` First Run Wizard API: `POST /setup/init` (org + owner + branch + warehouse)
- [ ] `[sto-web]` Wizard першого запуску — 5 кроків: org → branch → warehouse → ПРРО (skip) → SMS (skip)
- [ ] `[sto-web]` Сторінка налаштувань: Організація, Філії, Нумерація, Методи оплати

---

## Фаза 4 — Інфраструктура (довідники)

> Залежності: Фаза 3.  
> Мета: CRUD для всіх структурних довідників.

- [ ] `[sto-backend]` `GarageBranchModule`: CRUD (`/branches`)
- [ ] `[sto-backend]` `ZoneModule` + `LiftModule`: CRUD (`/zones`, `/lifts`)
- [ ] `[sto-backend]` `WarehouseModule`: CRUD (`/warehouses`)
- [ ] `[sto-backend]` `WorkCategoryModule`: CRUD дерево (self-ref, `/work-categories`)
- [ ] `[sto-web]` UI: Сторінки Зони, Підйомники, Склади (таблиці + форми)

---

## Фаза 5 — Співробітники

> Залежності: Фаза 4 (є Zone, Lift, WorkCategory).  
> Мета: CRUD співробітників з прив'язкою до зон і підйомників.

- [ ] `[sto-backend]` `EmployeeModule`: CRUD (`/employees`)
- [ ] `[sto-backend]` `POST /employees/:id/zones`, `POST /employees/:id/lifts`, `POST /employees/:id/work-categories`
- [ ] `[sto-backend]` Валідація `rateScheme` JSON (Zod): `percent_normo` | `fixed_plus_bonus`
- [ ] `[sto-web]` UI: Список співробітників + картка + форма прив'язки зон/підйомників

---

## Фаза 6 — CRM (Контрагенти + Автомобілі)

> Залежності: Фаза 3.  
> Мета: повноцінна база клієнтів і автомобілів.

- [ ] `[sto-backend]` `CounterpartyModule`: CRUD + пошук (`/counterparties`, `?q=`, `?type=CLIENT`)
- [ ] `[sto-backend]` `CustomerGarageModule`: CRUD (`/counterparties/:id/garages`)
- [ ] `[sto-backend]` `VehicleModule`: CRUD + `VehicleNode` (`/vehicles`, `/vehicles/:id/nodes`)
- [ ] `[sto-backend]` `SettlementAccountService.getOrCreate(orgId, counterpartyId)` — автостворення рахунку
- [ ] `[sto-web]` UI: Список контрагентів + картка (гаражі + авто + баланс)
- [ ] `[sto-web]` UI: Картка автомобіля (вузли + історія нарядів)

---

## Фаза 7 — Каталог послуг і товарів

> Залежності: Фаза 4 (WorkCategory).  
> Мета: каталог робіт, товарів, комплексних послуг.

- [ ] `[sto-backend]` `WorkModule`: CRUD (`/works`)
- [ ] `[sto-backend]` `GoodModule`: CRUD + пошук по barcode (`/goods`)
- [ ] `[sto-backend]` `ServiceModule`: CRUD + `ServiceWork` + `ServiceGood` (`/services`)
- [ ] `[sto-web]` UI: Каталог робіт (дерево категорій + список) + форма
- [ ] `[sto-web]` UI: Товари та запчастини (таблиця + форма) + сканер штрихкоду

---

## Фаза 8 — Наряди (Work Orders) ← ЯДРО СИСТЕМИ

> Залежності: Фази 5, 6, 7 (є Employee, Vehicle, Work, Good, Warehouse).  
> Мета: повний цикл наряду від DRAFT до PAID.

- [ ] `[sto-backend]` `WorkOrderModule`: `POST /work-orders`, `GET /work-orders`, `GET /work-orders/:id`
- [ ] `[sto-backend]` `WorkOrderFSMService.transition(id, targetStatus, user)` — всі переходи з guard'ами та side-effects
- [ ] `[sto-backend]` `POST /work-orders/:id/transition` — HTTP endpoint переходу
- [ ] `[sto-backend]` `WorkOrderLineModule`: `POST/PATCH/DELETE /work-orders/:id/lines`
- [ ] `[sto-backend]` `WorkOrderPartModule`: `POST/PATCH/DELETE /work-orders/:id/parts` + резервування через `InventoryService`
- [ ] `[sto-backend]` Перерахунок підсумків: `totalLabor`, `totalParts`, `totalAmount` після кожної зміни
- [ ] `[sto-backend]` `CalendarSlotModule`: `POST /calendar/slots`, `GET /calendar/slots?date=&branchId=`
- [ ] `[sto-web]` UI: Список нарядів (таблиця + фільтри + швидкий статус)
- [ ] `[sto-web]` UI: Форма створення наряду (клієнт → авто → послуги → деталі)
- [ ] `[sto-web]` UI: Картка наряду (лінії, запчастини, FSM-кнопки з підтвердженням)
- [ ] `[sto-web]` UI: Календар завантаженості підйомників
- [ ] `[sto-mobile]` Екран "Мої наряди" (механік)
- [ ] `[sto-mobile]` Екран деталі наряду + зміна статусу операцій

---

## Фаза 9 — Склад та запаси

> Залежності: Фаза 7 (Good, Warehouse), Фаза 8 (WorkOrder резервує запчастини).  
> Мета: повний облік ТМЦ.

- [ ] `[sto-backend]` `InventoryService.createMovement(dto)` — єдина точка входу для всіх рухів
- [ ] `[sto-backend]` `StockItemModule`: `GET /stock-items?warehouseId=&goodId=` (залишки)
- [ ] `[sto-backend]` `PurchaseOrderModule`: CRUD + FSM (DRAFT→ORDERED→RECEIVED/PARTIAL) + `POST /purchase-orders/:id/receive`
- [ ] `[sto-backend]` `StockDocumentModule`: CRUD + FSM (DRAFT→CONFIRMED→CANCELLED) — типи WRITEOFF, TRANSFER, OPENING_BALANCE
- [ ] `[sto-backend]` Списання на наряд при переході `COMPLETED`: `RESERVATION → WRITEOFF`
- [ ] `[sto-backend]` `GET /stock-items/low` — товари нижче мінімального залишку
- [ ] `[sto-web]` UI: Залишки по складах (таблиця + фільтр по складу)
- [ ] `[sto-web]` UI: Замовлення постачальнику (список + форма + прийом)
- [ ] `[sto-web]` UI: Документи списання / переміщення / початкові залишки

---

## Фаза 10 — Фінанси та розрахунки

> Залежності: Фаза 8 (WorkOrder), Фаза 6 (SettlementAccount).  
> Мета: рахунки, оплати, ПРРО, взаєморозрахунки.

- [ ] `[sto-backend]` `InvoiceModule`: `POST /invoices` (з наряду або вручну), FSM DRAFT→SENT→PAID→CANCELLED
- [ ] `[sto-backend]` `PaymentModule`: `POST /payments` → `SettlementsService.createTransaction(PAYMENT)` + BullMQ job для Checkbox
- [ ] `[sto-backend]` `CheckboxWorker`: BullMQ job, 288 retry за 24 год, фіскальна квитанція → `Payment.fiscalReceiptId`
- [ ] `[sto-backend]` `SettlementsService.createTransaction(dto)` — єдина точка входу, оновлює `SettlementAccount.balance`
- [ ] `[sto-backend]` `SettlementAccountModule`: `GET /counterparties/:id/balance`, `GET /counterparties/:id/transactions`
- [ ] `[sto-backend]` `ReconciliationActModule`: `POST /reconciliation-acts` (знімок транзакцій за період)
- [ ] `[sto-web]` UI: Виставлення рахунку з наряду + відправка клієнту (PDF)
- [ ] `[sto-web]` UI: Реєстрація оплати (вибір методу + сума + решта)
- [ ] `[sto-web]` UI: Картка контрагента → вкладка "Взаєморозрахунки"
- [ ] `[sto-web]` UI: Акт звірки (генерація + перегляд)

---

## Фаза 11 — Сповіщення

> Залежності: Фаза 3 (NotificationTemplate, BranchSettings SMS), Фаза 8, 9, 10.  
> Мета: автоматичні SMS при ключових подіях.

- [ ] `[sto-backend]` `SmsProvider` interface + `TurboSmsAdapter` (Bearer token, BullMQ retry)
- [ ] `[sto-backend]` `NotificationService.send(orgId, event, payload)` → рендерить шаблон + відправляє
- [ ] `[sto-backend]` Тригери: `WO_COMPLETED` (авто готове), `PAYMENT_RECEIVED`, `LOW_STOCK_ALERT`
- [ ] `[sto-web]` UI: Налаштування шаблонів сповіщень (Налаштування → SMS-провайдер)

---

## Фаза 12 — Звіти

> Залежності: Фази 8–10 (є дані).  
> Мета: основні аналітичні звіти.

- [ ] `[sto-backend]` `RevenueReport`: `GET /reports/revenue?from=&to=&branchId=` — виручка по днях
- [ ] `[sto-backend]` `WorkOrderReport`: `GET /reports/work-orders?employeeId=&from=&to=` — наряди / механіки / норм-години
- [ ] `[sto-backend]` `StockReport`: `GET /reports/stock?warehouseId=` — залишки + рухи за період
- [ ] `[sto-backend]` `SettlementsReport`: `GET /reports/settlements?counterpartyId=` — дебіторка / кредиторка
- [ ] `[sto-backend]` `LoadReport`: `GET /reports/load?branchId=&from=&to=` — завантаженість підйомників
- [ ] `[sto-web]` UI: Сторінки звітів з фільтрами + графіки (recharts) + експорт CSV

---

## Фаза 13 — Web UI (оболонка + дашборд)

> Залежності: Фази 3–12 (всі API готові).  
> Мета: фінальна web-оболонка з навігацією та дашбордом.

- [ ] `[sto-web]` `TopShell` компонент: TopBar + MegaMenu + QuickTabsBar (з localStorage)
- [ ] `[sto-web]` `Dashboard` — KPI картки (наряди, виручка, залишки), графік активності, сповіщення
- [ ] `[sto-web]` `ViewToggle` — перемикач Дашборд / Робоча область (стан в URL)
- [ ] `[sto-web]` Теми оформлення: 5 палітр, зберігається в `OrganisationSettings.brandTheme`
- [ ] `[sto-web]` PWA manifest + service worker (offline fallback сторінка)

---

## Фаза 14 — Мобільний додаток (механік)

> Залежності: Фаза 8 (Work Orders API).  
> Мета: Expo-додаток для механіків з офлайн-підтримкою.

- [ ] `[sto-mobile]` Auth + навігація (Expo Router, Tab + Stack)
- [ ] `[sto-mobile]` WatermelonDB схема: `WorkOrder`, `WorkOrderLine`, `WorkOrderPart`
- [ ] `[sto-mobile]` Sync layer: pull від API → WatermelonDB, push змін → API
- [ ] `[sto-mobile]` Екран "Мої наряди" — список з фільтром по статусу
- [ ] `[sto-mobile]` Екран деталі наряду — операції, запчастини, кнопки переходу
- [ ] `[sto-mobile]` Фото до наряду через `expo-camera` → MinIO

---

## Фаза 15 — Cloud Sync (опціонально)

> Залежності: Фаза 13 (стабільна локальна версія).  
> Мета: синхронізація між філіями і хмарний бекап.

- [ ] `[sto-backend]` `SyncJob` таблиця + `OutboxWorker` (відстежує зміни через `syncVersion`)
- [ ] `[sto-backend]` Conflict resolution: `last-write-wins` по `syncVersion`, `manual` для критичних полів
- [ ] `[sto-backend]` Cloud Sync API: `POST /sync/push`, `GET /sync/pull?since=`
- [ ] `[sto-web]` UI: Статус синхронізації + ручний тригер

---

## Фаза 16 — Installer та Production

> Залежності: Фаза 13–14 (фінальні збірки).  
> Мета: `.exe` installer + auto-update + production hardening.

- [ ] `[sto-installer]` Inno Setup скрипт: завантаження/розпакування Docker images, `docker compose up`, Windows service
- [ ] `[sto-installer]` PowerShell `Update.ps1`: pull нових images + `migrate deploy` + restart
- [ ] `[sto-installer]` PowerShell `Backup.ps1`: `pg_dump` + архів MinIO + ротація 30 днів
- [ ] `[sto-backend]` `GET /health` → детальний статус: DB, Redis, MinIO, BullMQ queues
- [ ] `[sto-web]` Production Next.js build + статичний експорт в `apps/api/public/`
- [ ] `[sto-mobile]` EAS Build: APK (Android) + TestFlight (iOS)
- [ ] Фінальне тестування: smoke test після установки на чистій Windows VM

---

## Поточний стан

| Фаза | Назва | Статус |
|------|-------|--------|
| 0 | Bootstrap | ⬜ не розпочато |
| 1 | Повна схема БД | ⬜ не розпочато |
| 2 | Автентифікація | ⬜ не розпочато |
| 3 | Налаштування + перший запуск | ⬜ не розпочато |
| 4 | Інфраструктура (довідники) | ⬜ не розпочато |
| 5 | Співробітники | ⬜ не розпочато |
| 6 | CRM | ⬜ не розпочато |
| 7 | Каталог послуг і товарів | ⬜ не розпочато |
| 8 | Наряди ← ЯДРО | ⬜ не розпочато |
| 9 | Склад та запаси | ⬜ не розпочато |
| 10 | Фінанси та розрахунки | ⬜ не розпочато |
| 11 | Сповіщення | ⬜ не розпочато |
| 12 | Звіти | ⬜ не розпочато |
| 13 | Web UI (оболонка + дашборд) | ⬜ не розпочато |
| 14 | Мобільний додаток | ⬜ не розпочато |
| 15 | Cloud Sync | ⬜ опціонально |
| 16 | Installer та Production | ⬜ не розпочато |

> Оновлюється автоматично після кожного завершеного завдання.  
> Статус таблиці: ⬜ не розпочато / 🔄 в процесі / ✅ завершено
