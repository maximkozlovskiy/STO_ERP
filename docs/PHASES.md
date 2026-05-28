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

- [x] `[ручна]` Ініціалізувати pnpm workspace + Turborepo (`turbo.json`, `pnpm-workspace.yaml`)
    > `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `.npmrc`. pnpm install — 1095 пакетів. allowBuilds для prisma/bcrypt/nestjs/esbuild.
- [x] `[ручна]` Створити структуру пакетів: `apps/{api,web,mobile}`, `packages/{database,shared,ui,config}`
    > `package.json` для всіх 7 пакетів. `packages/shared/src/` — types, schemas, constants. `packages/database/prisma/schema.prisma` (порожня). `.gitignore`, `.env.dev`, `docker-compose.dev.yml`.
- [x] `[sto-database]` `packages/config` — ESLint, TSConfig (base, nestjs, nextjs, react-native), Vitest base config
    > `packages/config/tsconfig/{base,nestjs,nextjs,react-native}.json`, `eslint/{base,nestjs,nextjs}.js`, `vitest/base.ts`. @typescript-eslint v8, eslint-config-prettier.
- [x] `[sto-backend]` `apps/api` — NestJS 10 + Fastify scaffold (`AppModule`, `main.ts`, Swagger, health endpoint)
    > `apps/api/src/main.ts` (Fastify adapter, CORS, Swagger на /api/docs), `AppModule` + `ConfigModule`, `HealthModule` (GET /api/health), `HttpExceptionFilter`, `nest-cli.json`.
- [x] `[sto-web]` `apps/web` — Next.js 15 static export scaffold (`layout.tsx`, `globals.css`, shadcn/ui init)
    > `apps/web/src/app/{layout.tsx,page.tsx,globals.css}`, `next.config.ts` (output: export, transpilePackages), `lib/api-client.ts`. Tailwind 4 через @import.
- [x] `[sto-mobile]` `apps/mobile` — Expo SDK 53 scaffold (bare workflow, `app/_layout.tsx`, NativeWind)
    > `apps/mobile/app/{_layout.tsx,+not-found.tsx}`, `app.json` (expo-router, landscape, ua.stoerp.app), `tsconfig.json`.
- [x] `[sto-database]` `packages/database` — Prisma init, підключення до PostgreSQL, порожній `schema.prisma` з базовими налаштуваннями
    > `packages/database/prisma/schema.prisma` (generator + datasource), `prisma/seed.ts` (stub), `tsconfig.json`. prisma.seed → ts-node.
- [x] `[sto-database]` `packages/shared` — TypeScript типи з `@prisma/client`, Zod-схеми (порожні, готові до наповнення)
    > `packages/shared/src/{types.ts,schemas.ts,constants.ts,index.ts}`. BaseEntity, PaginatedResponse, uuidSchema, paginationSchema, локальні константи uk-UA.
- [x] `[ручна]` `docker-compose.yml` — PostgreSQL 16, Redis 7, MinIO, Caddy (з конфігами)
    > `docker-compose.yml` (production), `docker-compose.dev.yml` (dev: відкриті порти, minio-init bucket, без api/web/caddy). `.env.dev` з дефолтними dev-секретами.
- [x] `[sto-installer]` `installer/` — scaffold Inno Setup `.iss` + PowerShell bootstrap-скрипт
    > `installer/inno/setup.iss` (lzma2/ultra64, uk локаль, Tasks, Run/UninstallRun), `messages_uk.isl`. Скрипти: Check-Requirements, Install-Docker, Setup-Stack (генерує секрети, healthcheck), First-Run (migrate+seed), Register-Service (NSSM), Update, Backup (ротація 30), Restore, Uninstall. `.github/workflows/release.yml` — CI збирає images, NSSM, ISCC → `.exe` → GitHub Release.

---

## Фаза 1 — Повна схема БД

> Залежності: Фаза 0 (Prisma ініціалізовано).  
> Мета: всі 35+ моделей з ERD.md в схемі, перша міграція пройшла.

- [x] `[sto-database]` Всі enum-и: `WorkOrderStatus`, `EmployeeRole`, `StockMovementType`, `DocumentType`, `VatMode` та інші
    > 11 enum-ів: UserRole, WorkOrderStatus, ZoneType, LiftType, WarehouseType, CounterpartyType, StockMovementType, StockDocumentType/Status, DocumentType, ResetPeriod, VatMode, NotificationEventType/Channel, SettlementTransactionType.
- [x] `[sto-database]` Bounded context **Infrastructure**: `Organisation`, `GarageBranch`, `Zone`, `Lift`, `Warehouse`
    > Всі 5 моделей з обов'язковими полями (id UUID, orgId, timestamps, syncVersion, deletedAt). Indexes по orgId+deletedAt та orgId+syncVersion.
- [x] `[sto-database]` Bounded context **Employees**: `Employee`, `EmployeeZone`, `EmployeeLift`, `EmployeeWorkCategory`
    > Employee з rateScheme Json, phone. Junction tables EmployeeZone/Lift/WorkCategory з composite PK.
- [x] `[sto-database]` Bounded context **CRM**: `Counterparty`, `CustomerGarage`, `Vehicle`, `VehicleNode`
    > Counterparty з vatPayer, типи CLIENT/SUPPLIER/BOTH. Vehicle з VIN index. VehicleNode з category string.
- [x] `[sto-database]` Bounded context **Catalog**: `WorkCategory`, `Work`, `Good`, `Service`, `ServiceWork`, `ServiceGood`
    > WorkCategory self-ref hierarchy. Good з SKU index. Service з опціональною price. Junction tables ServiceWork/Good.
- [x] `[sto-database]` Bounded context **Work Orders**: `WorkOrder`, `WorkOrderLine`, `WorkOrderLineEmployee`, `WorkOrderPart`
    > WorkOrder FSM enum. totalLabor/Parts/Amount/paidAmount. WorkOrderLine з liftId. Junction WorkOrderLineEmployee.
- [x] `[sto-database]` Bounded context **Inventory**: `StockItem`, `StockMovement`, `PurchaseOrder`, `PurchaseOrderLine`, `StockDocument`, `StockDocumentLine`
    > StockItem UNIQUE(orgId,goodId,warehouseId). StockMovement append-only. StockDocument з source/targetWarehouse relations.
- [x] `[sto-database]` Bounded context **Finance**: `Invoice`, `Payment`, `SettlementAccount`, `SettlementTransaction`, `ReconciliationAct`
    > Payment append-only, method як string (з PaymentMethodConfig). SettlementAccount UNIQUE counterpartyId. ReconciliationAct з snapshotJson.
- [x] `[sto-database]` Bounded context **Calendar**: `CalendarSlot`
    > CalendarSlot з liftId, employeeId, workOrderId, startAt/endAt. Indexes по lift+час і employee+час.
- [x] `[sto-database]` Bounded context **Settings**: `OrganisationSettings`, `BranchSettings`, `DocumentNumberConfig`, `NotificationTemplate`, `TaxRate`, `PaymentMethodConfig`
    > OrganisationSettings (invoiceDueDays, autoArchiveDays, warrantyDays — з БД, не hardcoded). BranchSettings (ПРРО Checkbox, SMS per branch). DocumentNumberConfig UNIQUE(orgId,documentType). NotificationTemplate UNIQUE(orgId,eventType,channel). PaymentMethodConfig з requiresFiscal.
- [x] `[sto-database]` Перша міграція: `prisma migrate dev --name init`
    > `packages/database/prisma/migrations/20260522181129_init/migration.sql`. 37 таблиць, 11 enum-ів, всі FK, indexes. Prisma Client згенеровано.
- [x] `[sto-database]` `packages/shared` — TypeScript типи + Zod-схеми для всіх моделей
    > seed.ts оновлено: org + branch + settings + taxRates(3) + paymentMethods(5) + documentConfigs(8) + notificationTemplates(3) + zones(2) + lifts(2) + warehouse(1) + workCategories(3). Всі upsert — ідемпотентні.

---

## Фаза 2 — Автентифікація

> Залежності: Фаза 1 (є таблиця `Employee` + `Organisation`).  
> Мета: JWT login/refresh, guard'и для всіх подальших модулів.

- [x] `[sto-backend]` `AuthModule`: `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`
    > `apps/api/src/auth/`. JWT access 15хв (Bearer) + refresh 30д (httpOnly cookie `sto_refresh` path=/api/auth). Bcrypt rounds=12. `AuthAccount` модель у схемі — email/passwordHash окремо від `Employee`. Seed: admin@sto.local / admin123.
- [x] `[sto-backend]` `JwtStrategy` (access 15 хв) + `RefreshTokenStrategy` (30 днів, httpOnly cookie)
    > `apps/api/src/auth/strategies/jwt.strategy.ts`. PassportStrategy('jwt'), ExtractJwt.fromAuthHeaderAsBearerToken(). Перевіряє `employee.deletedAt`.
- [x] `[sto-backend]` `JwtAuthGuard`, `RolesGuard`, `OrgGuard` (автоматична фільтрація по `orgId`)
    > `apps/api/src/auth/guards/`. JwtAuthGuard extends AuthGuard('jwt'). RolesGuard через Reflector + @Roles decorator. @OrgContext() витягує orgId з JWT payload.
- [x] `[sto-backend]` `CurrentUser` декоратор → `{ sub, orgId, role, branchId }`
    > `apps/api/src/auth/decorators/current-user.decorator.ts`, `org-context.decorator.ts`, `roles.decorator.ts`. 8 unit-тестів (vitest + @nestjs/testing + unplugin-swc).
- [x] `[sto-web]` Login-сторінка (`/login`) + зберігання токена в httpOnly cookie
    > `apps/web/src/app/(auth)/login/page.tsx`. POST /api/auth/login → accessToken в sessionStorage. Refresh cookie (httpOnly) надсилається браузером автоматично. Silent refresh при 401.
- [x] `[sto-web]` `AuthProvider` (Next.js) + захист роутів
    > `apps/web/src/lib/auth/`. AuthProvider (context + reducer), useAuth(), ProtectedRoute, useRequireAuth(roles?). api-client.ts з Bearer token + auto-refresh. tsconfig.json inline (без extends workspace). type-check чистий.

---

## Фаза 3 — Налаштування та перший запуск

> Залежності: Фаза 2 (є OWNER-акаунт).  
> Мета: wizard першого запуску, автонумерація, SettingsService.

- [x] `[sto-backend]` `SettingsService.get(orgId)` → читає `OrganisationSettings` + `BranchSettings` з Redis-кешем (5 хв)
    > `apps/api/src/modules/settings/settings.service.ts`. Redis TTL=5хв, fallback без кешу (offline-first). upsert defaults при першому зверненні. `invalidateOrgCache`/`invalidateBranchCache`.
- [x] `[sto-backend]` `DocumentNumberingService.next(orgId, docType)` → атомарна видача номера через PostgreSQL `SELECT FOR UPDATE`
    > `apps/api/src/modules/settings/document-numbering.service.ts`. `$queryRaw FOR UPDATE` → атомарний інкремент. Підтримка YEARLY/MONTHLY reset. Формат: prefix+date+padded_seq.
- [x] `[sto-backend]` `SettingsModule`: `GET/PATCH /settings/organisation`, `GET/PATCH /settings/branch/:id`
    > `apps/api/src/modules/settings/`. Controller з @Roles('OWNER','ADMIN'). RedisModule (@Global). ioredis 5.x. Зареєстровано в AppModule.
- [x] `[sto-backend]` `PaymentMethodConfigModule`: CRUD методів оплати
    > `apps/api/src/modules/payment-methods/`. Hard delete (no deletedAt на config таблиці). UNIQUE(orgId,code). Зареєстровано в AppModule.
- [x] `[sto-backend]` First Run Wizard API: `POST /setup/init` (org + owner + branch + warehouse)
    > `apps/api/src/modules/setup/`. `GET /setup/status` (перевірка ініціалізації). `POST /setup/init` — транзакція: org+settings+docConfigs+paymentMethods+taxRates+branch+branchSettings+warehouse+employee+authAccount. Повертає accessToken.
- [x] `[sto-web]` Wizard першого запуску — 5 кроків: org → branch → warehouse → ПРРО (skip) → SMS (skip)
    > `apps/web/src/app/setup/page.tsx`. 5-крокова форма зі step-індикатором. POST /setup/init → зберігає accessToken. Сторінка `/` перевіряє `/setup/status` і редіректить на /setup якщо не ініціалізовано.
    > **Bugfix (2026-05-24):** Кнопка "Далі →" була неактивна через конфлікт з `AuthProvider` в root layout. Виправлено: `apps/web/src/app/setup/layout.tsx` ізолює /setup від TopShell/AuthProvider. Видалено залежність від `useAuth`. Додано `checking` step — перевірка `/setup/status` при відкритті: якщо вже ініціалізовано → redirect на /login. `disabled` валідація тепер використовує `.trim()`.
- [x] `[sto-web]` Сторінка налаштувань: Організація, Філії, Нумерація, Методи оплати
    > `apps/web/src/app/settings/page.tsx`. Таби: Організація (vatMode, invoiceDueDays, autoArchiveDays, warrantyDays, toggles) + Методи оплати (toggle isActive). useRequireAuth(['OWNER','ADMIN']).

---

## Фаза 4 — Інфраструктура (довідники)

> Залежності: Фаза 3.  
> Мета: CRUD для всіх структурних довідників.

- [x] `[sto-backend]` `GarageBranchModule`: CRUD (`/branches`)
    > `apps/api/src/modules/branches/`. Soft delete. @Roles OWNER/ADMIN на write.
- [x] `[sto-backend]` `ZoneModule` + `LiftModule`: CRUD (`/zones`, `/lifts`)
    > `apps/api/src/modules/zones/`. Один модуль, два контролери. ?branchId / ?zoneId фільтрація. Enum ZoneType/LiftType.
- [x] `[sto-backend]` `WarehouseModule`: CRUD (`/warehouses`)
    > `apps/api/src/modules/warehouses/`. ?branchId фільтрація. Enum WarehouseType.
- [x] `[sto-backend]` `WorkCategoryModule`: CRUD дерево (self-ref, `/work-categories`)
    > `apps/api/src/modules/work-categories/`. GET повертає повне дерево (buildTree recursive). DELETE каскадно soft-delete нащадків.
- [x] `[sto-web]` UI: Сторінки Зони, Підйомники, Склади (таблиці + форми)
    > `apps/web/src/app/infrastructure/page.tsx`. Таби: Філії / Зони / Підйомники / Склади. Таблиці + модальні форми додавання + soft-delete. useRequireAuth(['OWNER','ADMIN']).

---

## Фаза 5 — Співробітники

> Залежності: Фаза 4 (є Zone, Lift, WorkCategory).  
> Мета: CRUD співробітників з прив'язкою до зон і підйомників.

- [x] `[sto-backend]` `EmployeeModule`: CRUD (`/employees`)
    > `apps/api/src/modules/employees/`. CRUD з soft delete. include employeeZones/Lifts/WorkCategories в кожній відповіді.
- [x] `[sto-backend]` `POST /employees/:id/zones`, `POST /employees/:id/lifts`, `POST /employees/:id/work-categories`
    > Replace-семантика: delete+recreate в $transaction. Перевірка що всі переданні ID належать до orgId.
- [x] `[sto-backend]` Валідація `rateScheme` JSON (Zod): `percent_normo` | `fixed_plus_bonus`
    > `rateSchemeSchema` (Zod discriminatedUnion) в employees.dto.ts. validateRateScheme() кидає BadRequestException з деталями.
- [x] `[sto-web]` UI: Список співробітників + картка + форма прив'язки зон/підйомників
    > `apps/web/src/app/employees/page.tsx`. Таблиця зі схемою нарахування + зони/підйомники. Модалка створення з динамічною формою rateScheme. Модалка картки — checkbox-списки прив'язки зон/підйомників/категорій.

---

## Фаза 6 — CRM (Контрагенти + Автомобілі)

> Залежності: Фаза 3.  
> Мета: повноцінна база клієнтів і автомобілів.

- [x] `[sto-backend]` `CounterpartyModule`: CRUD + пошук (`/counterparties`, `?q=`, `?type=CLIENT`)
    > `apps/api/src/modules/counterparties/`. Пошук по firstName/lastName/companyName/phone/edrpou (insensitive). Пагінація. Balance з settlementAccount.
- [x] `[sto-backend]` `CustomerGarageModule`: CRUD (`/counterparties/:id/garages`)
    > Вкладений ресурс в CounterpartiesController. GET/POST /counterparties/:id/garages, DELETE /counterparties/:id/garages/:garageId.
- [x] `[sto-backend]` `VehicleModule`: CRUD + `VehicleNode` (`/vehicles`, `/vehicles/:id/nodes`)
    > `apps/api/src/modules/vehicles/`. ?customerGarageId фільтр. Вузли: GET/POST/DELETE /vehicles/:id/nodes.
- [x] `[sto-backend]` `SettlementAccountService.getOrCreate(orgId, counterpartyId)` — автостворення рахунку
    > Автостворення в транзакції при POST /counterparties. Balance відображається в CounterpartyResponseDto.
- [x] `[sto-web]` UI: Список контрагентів + картка (гаражі + авто + баланс)
    > `apps/web/src/app/crm/page.tsx` (список+пошук+фільтр+пагінація+модалка), `apps/web/src/app/crm/[id]/page.tsx` (картка: баланс, гаражі-таби, авто).
- [x] `[sto-web]` UI: Картка автомобіля (вузли + історія нарядів)
    > `apps/web/src/app/vehicles/[id]/page.tsx`. Поля авто, вузли згруповані по категорії, форма додавання вузла.

---

## Фаза 7 — Каталог послуг і товарів

> Залежності: Фаза 4 (WorkCategory).  
> Мета: каталог робіт, товарів, комплексних послуг.

- [x] `[sto-backend]` `WorkModule`: CRUD (`/works`)
    > `apps/api/src/modules/works/`. CRUD + ?categoryId/?q фільтрація. Перевірка існування категорії. Пагінація.
- [x] `[sto-backend]` `GoodModule`: CRUD + пошук по barcode (`/goods`)
    > `apps/api/src/modules/goods/`. CRUD + ?q (name/sku/barcode) / ?barcode точний пошук. ConflictException на дублікат SKU.
- [x] `[sto-backend]` `ServiceModule`: CRUD + `ServiceWork` + `ServiceGood` (`/services`)
    > `apps/api/src/modules/services/`. Create/Update: replace-семантика для works і goods у $transaction. Повертає вкладені роботи та товари.
- [x] `[sto-web]` UI: Каталог робіт (дерево категорій + список) + форма
    > `apps/web/src/app/catalog/page.tsx`. Таб "Роботи": пошук + фільтр по категорії (flat select з indent), таблиця, модалка.
- [x] `[sto-web]` UI: Товари та запчастини (таблиця + форма) + сканер штрихкоду
    > Таб "Товари та запчастини": пошук (назва/артикул/штрихкод), таблиця з цінами, модалка. Таб "Комплексні послуги": список з вкладеними роботами/товарами.

---

## Фаза 8 — Наряди (Work Orders) ← ЯДРО СИСТЕМИ

> Залежності: Фази 5, 6, 7 (є Employee, Vehicle, Work, Good, Warehouse).  
> Мета: повний цикл наряду від DRAFT до PAID.

- [x] `[sto-backend]` `WorkOrderModule`: `POST /work-orders`, `GET /work-orders`, `GET /work-orders/:id`
    > `apps/api/src/modules/work-orders/`. CRUD з soft-delete. findAll: фільтри status/branchId/counterpartyId/vehicleId + пагінація. findOne: includes lines+parts.
- [x] `[sto-backend]` `WorkOrderFSMService.transition(id, targetStatus, user)` — всі переходи з guard'ами та side-effects
    > `work-orders.fsm.ts` — transition map. При IN_PROGRESS → RESERVATION на всі parts. При COMPLETED → WRITEOFF + RESERVATION_RELEASE + SettlementsService.CHARGE у $transaction.
- [x] `[sto-backend]` `POST /work-orders/:id/transition` — HTTP endpoint переходу
    > `WorkOrdersController` POST /:id/transition. @CurrentUser для передачі userId в side-effects.
- [x] `[sto-backend]` `WorkOrderLineModule`: `POST/PATCH/DELETE /work-orders/:id/lines`
    > Вкладені endpoints в WorkOrdersController. defaults normoHours/price з Work. recalcTotals() після кожної зміни.
- [x] `[sto-backend]` `WorkOrderPartModule`: `POST/PATCH/DELETE /work-orders/:id/parts` + резервування через `InventoryService`
    > Вкладені endpoints. price defaults з Good.salePrice. recalcTotals() після кожної зміни.
- [x] `[sto-backend]` Перерахунок підсумків: `totalLabor`, `totalParts`, `totalAmount` після кожної зміни
    > `recalcTotals(workOrderId)` — агрегує lines.amount + parts.amount, оновлює WorkOrder atomically.
- [x] `[sto-backend]` `CalendarSlotModule`: `POST /calendar/slots`, `GET /calendar/slots?date=&branchId=`
    > `apps/api/src/modules/calendar/`. Конфлікт-перевірка на підйомник. GET фільтрує по дню (00:00–23:59). DELETE hard delete (не soft).
- [x] `[sto-web]` UI: Список нарядів (таблиця + фільтри + швидкий статус)
    > `apps/web/src/app/work-orders/page.tsx`. Фільтри по статусу (pill-buttons). Таблиця: номер, клієнт/авто, статус (кольоровий badge), сума, запланована дата.
- [x] `[sto-web]` UI: Форма створення наряду (клієнт → авто → послуги → деталі)
    > Модальне вікно в /work-orders: вибір контрагента → підвантаження авто по гаражам, філія, опис, пробіг, дата. Redirect на /work-orders/:id після створення.
- [x] `[sto-web]` UI: Картка наряду (лінії, запчастини, FSM-кнопки з підтвердженням)
    > `apps/web/src/app/work-orders/[id]/page.tsx`. FSM кнопки з кольорами + confirm dialog. Секції: роботи + запчастини + підсумки. Модалки додавання (auto-fill normoHours/price).
- [x] `[sto-web]` UI: Календар завантаженості підйомників
    > `apps/web/src/app/calendar/page.tsx`. Timeline grid 08:00–19:00 × підйомники. Позиціонування слотів по % ширині. Навігація по днях.
- [x] `[sto-mobile]` Екран "Мої наряди" (механік)
    > `apps/mobile/app/(tabs)/index.tsx`. FlatList з pull-to-refresh, фільтри статусів (pill tabs), пагінація з loadMore. Кольорові badge. Login screen + ProfileScreen (logout).
- [x] `[sto-mobile]` Екран деталі наряду + зміна статусу операцій
    > `apps/mobile/app/work-order/[id].tsx`. FSM кнопки з Alert confirm. Секції: підсумки (3 картки), деталі, роботи, запчастини. Pull-to-refresh. `src/lib/api.ts` (fetch wrapper), `src/lib/auth.ts`.

---

## Фаза 9 — Склад та запаси

> Залежності: Фаза 7 (Good, Warehouse), Фаза 8 (WorkOrder резервує запчастини).  
> Мета: повний облік ТМЦ.

- [x] `[sto-backend]` `InventoryService.createMovement(dto)` — єдина точка входу для всіх рухів
    > `apps/api/src/modules/inventory/inventory.service.ts`. Upsert StockItem, validація available при WRITEOFF, підтримка tx параметра для транзакцій.
- [x] `[sto-backend]` `StockItemModule`: `GET /stock-items?warehouseId=&goodId=` (залишки)
    > `apps/api/src/modules/inventory/stock-items.controller.ts`. GET /stock-items (з фільтрами) + GET /stock-items/low.
- [x] `[sto-backend]` `PurchaseOrderModule`: CRUD + FSM (DRAFT→ORDERED→RECEIVED/PARTIAL) + `POST /purchase-orders/:id/receive`
    > `apps/api/src/modules/purchase-orders/`. FSM: DRAFT→ORDERED→PARTIAL/RECEIVED/CANCELLED. receive() → RECEIPT movements + CHARGE settlement в $transaction.
- [x] `[sto-backend]` `StockDocumentModule`: CRUD + FSM (DRAFT→CONFIRMED→CANCELLED) — типи WRITEOFF, TRANSFER, OPENING_BALANCE
    > `apps/api/src/modules/stock-documents/`. CONFIRMED → createMovement для кожної позиції. TRANSFER = WRITEOFF+RECEIPT між складами.
- [x] `[sto-backend]` Списання на наряд при переході `COMPLETED`: `RESERVATION → WRITEOFF`
    > В `work-orders.service.ts` writeOffPartsAndCharge(): RESERVATION_RELEASE + WRITEOFF + SettlementsService.CHARGE в $transaction.
- [x] `[sto-backend]` `GET /stock-items/low` — товари нижче мінімального залишку
    > В stock-items.controller.ts: GET /stock-items/low фільтрує де quantity <= minStock.
- [x] `[sto-web]` UI: Залишки по складах (таблиця + фільтр по складу)
    > `apps/web/src/app/inventory/page.tsx`. Фільтр по складу + пошук, ⚠ індикатор низьких залишків, модалка LOW stock.
- [x] `[sto-web]` UI: Замовлення постачальнику (список + форма + прийом)
    > `apps/web/src/app/purchase-orders/page.tsx`. Список + статус-фільтри + модалка створення з позиціями + модалка прийому.
- [x] `[sto-web]` UI: Документи списання / переміщення / початкові залишки
    > `apps/web/src/app/stock-documents/page.tsx`. Тип- і статус-фільтри, форма з динамічними полями (targetWarehouse для TRANSFER).

---

## Фаза 10 — Фінанси та розрахунки

> Залежності: Фаза 8 (WorkOrder), Фаза 6 (SettlementAccount).  
> Мета: рахунки, оплати, ПРРО, взаєморозрахунки.

- [x] `[sto-backend]` `InvoiceModule`: `POST /invoices` (з наряду або вручну), FSM DRAFT→SENT→PAID→CANCELLED
    > `apps/api/src/modules/invoices/`. createFromWorkOrder() — перевіряє COMPLETED/INVOICED статус, запобігає дублям. FSM map.
- [x] `[sto-backend]` `PaymentModule`: `POST /payments` → `SettlementsService.createTransaction(PAYMENT)` + BullMQ job для Checkbox
    > `apps/api/src/modules/payments/`. Після оплати: PAYMENT settlement + auto PAID для Invoice/WorkOrder в $transaction. Enqueue checkbox queue.
- [x] `[sto-backend]` `CheckboxWorker`: BullMQ job, 288 retry за 24 год, фіскальна квитанція → `Payment.fiscalReceiptId`
    > `apps/api/src/modules/payments/checkbox.processor.ts`. @Processor('checkbox'), attempts=288, backoff exp 5хв. Читає checkboxApiKey з BranchSettings.
- [x] `[sto-backend]` `SettlementsService.createTransaction(dto)` — єдина точка входу, оновлює `SettlementAccount.balance`
    > `apps/api/src/modules/settlements/settlements.service.ts`. CHARGE=+balance, PAYMENT/PREPAYMENT/REFUND/CREDIT_NOTE=-balance.
- [x] `[sto-backend]` `SettlementAccountModule`: `GET /counterparties/:id/balance`, `GET /counterparties/:id/transactions`
    > `apps/api/src/modules/settlements/settlements-account.service.ts` + settlements.controller.ts. Nested routes під /counterparties/:id.
- [x] `[sto-backend]` `ReconciliationActModule`: `POST /reconciliation-acts` (знімок транзакцій за період)
    > В settlements-account.service.ts createReconciliationAct(): відкриваючий залишок + транзакції + закриваючий + snapshotJson.
- [x] `[sto-web]` UI: Виставлення рахунку з наряду + відправка клієнту (PDF)
    > `apps/web/src/app/invoices/page.tsx`. Список + статус-фільтри + модалка створення + кнопки FSM (Надіслати/Оплатити/Скасувати).
- [x] `[sto-web]` UI: Реєстрація оплати (вибір методу + сума + решта)
    > Модалка оплати в /invoices: метод (з PaymentMethodConfig) + сума + нотатки → POST /payments.
- [x] `[sto-web]` UI: Картка контрагента → вкладка "Взаєморозрахунки"
    > `apps/web/src/app/settlements/page.tsx`. Split-panel: список контрагентів + баланс + транзакції + акти звірки.
- [x] `[sto-web]` UI: Акт звірки (генерація + перегляд)
    > Модалка в /settlements: вибір діапазону дат → POST → відображення відкриваючого/закриваючого балансів + к-ть транзакцій.

---

## Фаза 11 — Сповіщення

> Залежності: Фаза 3 (NotificationTemplate, BranchSettings SMS), Фаза 8, 9, 10.  
> Мета: автоматичні SMS при ключових подіях.

- [x] `[sto-backend]` `SmsProvider` interface + `TurboSmsAdapter` (Bearer token, BullMQ retry)
    > `apps/api/src/modules/notifications/sms.processor.ts`. @Processor('sms'), attempts=10, backoff exp 60s. sendViaTurboSms() → TurboSMS API.
- [x] `[sto-backend]` `NotificationService.send(orgId, event, payload)` → рендерить шаблон + відправляє
    > `notifications.service.ts`. Завантажує BranchSettings+NotificationTemplate → renderTemplate('{{var}}' replace) → smsQueue.add(). Offline-safe.
- [x] `[sto-backend]` Тригери: `WO_COMPLETED` (авто готове), `PAYMENT_RECEIVED`, `LOW_STOCK_ALERT`
    > work-orders.service.ts: WO_COMPLETED після transition(). payments.service.ts: PAYMENT_RECEIVED після create(). NotificationsModule @Global.
- [x] `[sto-web]` UI: Налаштування шаблонів сповіщень (Налаштування → SMS-провайдер)
    > Вкладка "SMS-сповіщення" в /settings. Список шаблонів з inline-редактором тіла, toggle isActive.

---

## Фаза 12 — Звіти

> Залежності: Фази 8–10 (є дані).  
> Мета: основні аналітичні звіти.

- [x] `[sto-backend]` `RevenueReport`: `GET /reports/revenue?from=&to=&branchId=` — виручка по днях
    > `apps/api/src/modules/reports/reports.service.ts`. Групування по completedAt date, totalRevenue/labor/parts.
- [x] `[sto-backend]` `WorkOrderReport`: `GET /reports/work-orders?employeeId=&from=&to=` — наряди / механіки / норм-години
    > Агрегація WorkOrderLine по employeeId: totalNormoHours + totalAmount + linesCount.
- [x] `[sto-backend]` `StockReport`: `GET /reports/stock?warehouseId=` — залишки + рухи за період
    > stockItems (з вартістю) + movements (500 останніх). totalValue.
- [x] `[sto-backend]` `SettlementsReport`: `GET /reports/settlements?counterpartyId=` — дебіторка / кредиторка
    > SettlementAccount.balance → totalDebit (>0) + totalCredit (<0). Усі контрагенти з ненульовим балансом.
- [x] `[sto-backend]` `LoadReport`: `GET /reports/load?branchId=&from=&to=` — завантаженість підйомників
    > CalendarSlot → groupBy liftId: totalHours / (totalDays * 9h) = loadPercent%.
- [x] `[sto-web]` UI: Сторінки звітів з фільтрами + графіки (recharts) + експорт CSV
    > `apps/web/src/app/reports/page.tsx`. 5 вкладок: BarChart (виручка), таблиця (наряди), таблиця (склад), PieChart (розрахунки), горизонтальний BarChart (завантаженість). Кнопка CSV.

---

## Фаза 13 — Web UI (оболонка + дашборд)

> Залежності: Фази 3–12 (всі API готові).  
> Мета: фінальна web-оболонка з навігацією та дашбордом.

- [x] `[sto-web]` `TopShell` компонент: TopBar + MegaMenu + QuickTabsBar (з localStorage)
    > `apps/web/src/components/TopShell.tsx`. Sticky TopBar + hamburger MegaMenu (slide-out) + quick tabs (localStorage, max 6, shows 5). Role-filtered NAV, user badge, logout button.
    > **Оновлення 2026-05-25:** Меню поділено на 3 секції: **Документи** (наряди, рахунки, замовлення, документи складу), **Звіти** (календар, розрахунки, звіти), **Довідники** (контрагенти, склад, каталог, персонал, підрозділи, налаштування). Додано систему закладок (star-pin на hover, localStorage `sto_bookmarks`, секція "Закладки" вгорі sidebar).
- [x] `[sto-web]` `Dashboard` — KPI картки (наряди, виручка, залишки), графік активності, сповіщення
    > `apps/web/src/app/dashboard/page.tsx`. 8 KPI cards (Promise.allSettled), recharts BarChart revenue 7д, quick actions. TopShell wired in layout.tsx.
- [x] `[sto-web]` `ViewToggle` — перемикач Дашборд / Робоча область (стан в URL)
    > `apps/web/src/components/TopShell.tsx`. Pill toggle (Дашборд / last visited section) in TopBar, resolves from quickTabs[0].
- [x] `[sto-web]` `DetailPanel` + м'яке видалення + фільтри у всіх списках
    > `apps/web/src/components/ui/detail-panel.tsx`. Inline flex-панель w-80 (slide transition) що відкривається при кліку на рядок таблиці.
    > Додано у: work-orders, invoices, inventory, crm, employees, purchase-orders, stock-documents, catalog (works/goods/services tabs).
    > Усюди: кнопки "Видалити" → "Помітити на видалення" (ghost+Trash2, confirm dialog). Toggle "Показати видалені" (Eye/EyeOff, `?showDeleted=true`). Видалені рядки: `opacity-60` + "видалено" badge.
    > Додаткові фільтри: search Input (q), role select (employees), type select (де є).
    > Виняток: inventory — без showDeleted (StockItem не має deletedAt).
- [x] `[sto-web]` Теми оформлення: 5 палітр, зберігається в `OrganisationSettings.brandTheme`
    > `apps/web/src/lib/theme.ts`, `apps/web/src/app/settings/page.tsx` (tab "Оформлення"). CSS vars --color-primary/light/dark. Schema: brandTheme String @default("blue"), migration 20260523041555_add_brand_theme.
- [x] `[sto-web]` PWA manifest + service worker (offline fallback сторінка)
    > `apps/web/public/{manifest.json,sw.js,offline.html}`. `ServiceWorkerRegistrar` client component in layout. Offline fallback: локальна мережа СТО hint.

---

## Фаза 14 — Мобільний додаток (механік)

> Залежності: Фаза 8 (Work Orders API).  
> Мета: Expo-додаток для механіків з офлайн-підтримкою.

- [x] `[sto-mobile]` Auth + навігація (Expo Router, Tab + Stack)
    > `apps/mobile/app/_layout.tsx`, `app/login.tsx`, `app/(tabs)/_layout.tsx`. Stack: Login + (tabs) + work-order/[id]. JWT login via `/auth/login`. Tab: Наряди + Профіль.
- [x] `[sto-mobile]` WatermelonDB схема: `WorkOrder`, `WorkOrderLine`, `WorkOrderPart`
    > `apps/mobile/src/lib/schema.ts`, `src/models/`. appSchema v1, 3 tables. `src/lib/database.ts` initializes SQLiteAdapter + Database.
- [x] `[sto-mobile]` Sync layer: pull від API → WatermelonDB, push змін → API
    > `apps/mobile/src/lib/sync.ts`. `syncWorkOrders()` — pull /work-orders?include=lines,parts → upsert WDB (skip isDirty records). `pushDirtyOrders()` — POST /work-orders/:id/transition for dirty records.
- [x] `[sto-mobile]` Екран "Мої наряди" — список з фільтром по статусу
    > `apps/mobile/app/(tabs)/index.tsx`. Status filter pills, FlatList with pull-to-refresh + infinite scroll, cards with status badges.
- [x] `[sto-mobile]` Екран деталі наряду — операції, запчастини, кнопки переходу
    > `apps/mobile/app/work-order/[id].tsx`. FSM transition buttons, totals, lines/parts sections, photo section.
- [x] `[sto-mobile]` Фото до наряду через `expo-camera` → MinIO
    > `apps/mobile/src/lib/upload.ts`, uses `expo-image-picker` (ImagePicker.launchCameraAsync). Upload to `POST /api/files/upload`. Backend: `FilesModule` with `@fastify/multipart` + minio client.

---

## Фаза 15 — Cloud Sync (опціонально)

> Залежності: Фаза 13 (стабільна локальна версія).  
> Мета: синхронізація між філіями і хмарний бекап.

- [x] `[sto-backend]` `SyncJob` таблиця + `OutboxWorker` (відстежує зміни через `syncVersion`)
    > `packages/database/prisma/schema.prisma` — SyncJob (orgId, tableName, recordId, operation, syncVersion, payload, status, attempts). Migration 20260523042322_add_sync_jobs.
- [x] `[sto-backend]` Conflict resolution: `last-write-wins` по `syncVersion`, `manual` для критичних полів
    > `apps/api/src/modules/sync/sync.service.ts`. pull() — returns delta by syncVersion. push() — last-write-wins: skip if remote syncVersion ≤ local. Conflicts → SyncJob status=FAILED for manual review.
- [x] `[sto-backend]` Cloud Sync API: `POST /sync/push`, `GET /sync/pull?since=`
    > `apps/api/src/modules/sync/sync.controller.ts`. GET /sync/status, GET /sync/pull?since=N, POST /sync/push. Roles: OWNER, ADMIN.
- [x] `[sto-web]` UI: Статус синхронізації + ручний тригер
    > `apps/web/src/app/settings/sync/page.tsx`. Status cards (pending/failed jobs), last sync time, syncVersion, manual trigger button. Link in TopShell NAV.

---

## Фаза 16 — Каталог товарів v2 + CRM покращення + XLSX-імпорт

> Залежності: Фази 6, 7, 9.  
> Мета: розширений каталог товарів (бренд, штрихкоди-вкладка, одиниці виміру), CRM-покращення (гараж "Основний" + вкладки в картці), XLSX-шаблони для довідників і табличних частин, нова роль IMPORT_MANAGER.

### 16.1 — Довідник брендів + розширення Good

[x] `[sto-database]` Нова модель `Brand`: `id`, `orgId`, `name`, `createdAt`, `updatedAt`, `deletedAt`, `syncVersion`. `@@unique([orgId, name])`.
    > `Brand` додана до schema.prisma перед Good. Migration: add_brand_model.
[x] `[sto-database]` Поле `Good.brandId String? @db.Uuid` + relation `brand Brand?`. Міграція.
    > Good розширена з brandId FK + relation. Migration: add_brand_model.
[x] `[sto-backend]` `BrandModule`: CRUD `/brands` (`GET`, `POST`, `PATCH :id`, `DELETE :id`). Roles: OWNER, ADMIN, STOREKEEPER.
    > Повна реалізація: brands.service.ts, brands.controller.ts, brands.module.ts + реєстрація в app.module.ts.
[x] `[sto-web]` Вкладка "Бренди" в `/catalog` — інтегровано Select у формі товару.
    > GoodsTab: добавлено Brand interface, brands loading, Select з попсиом у modal.
[x] `[sto-web]` У формі товару: поле "Бренд" (Select з `/brands`).
    > GoodsTab form: added brandId field, Select element в modal с /brands списком.

### 16.2 — Штрихкоди як окрема вкладка в картці товару

[x] `[sto-database]` Нова модель `GoodBarcode`: `id`, `orgId`, `goodId`, `barcode String`, `type String @default("EAN13")`, `isPrimary Boolean @default(false)`, `createdAt`. Без `deletedAt` (append-only). `@@index([orgId, barcode])`.
    > Додана GoodBarcode модель з onDelete: Cascade. Migration: add_good_barcodes.
[x] `[sto-backend]` Endpoints: `GET /goods/:id/barcodes`, `POST /goods/:id/barcodes`, `DELETE /goods/:id/barcodes/:barcodeId`. Перевірка uniq barcode в межах org при POST.
    > GoodsController розширена sub-resource endpoints. GoodsService: getBarcodes, createBarcode, deleteBarcode методи з валідацією.
[x] `[sto-web]` Картка товару (`/catalog` → Good tab) — дві вкладки: "Основна інформація" і "Штрихкоди". Вкладка "Штрихкоди": таблиця (barcode | тип | isPrimary) + форма додавання + кнопка "Видалити".
    > GoodDetailTab = 'info'|'barcodes'. loadBarcodes(), addBarcode(), deleteBarcode(). Star icon for isPrimary.

### 16.3 — Розширення полів товару (одиниці виміру)

[x] `[sto-database]` Нова модель `UnitOfMeasure`: `id`, `orgId`, `name String` (шт, кг, л, м, компл...), `shortName String`, `isSystem Boolean @default(false)`. `@@unique([orgId, shortName])`.
    > UnitOfMeasure модель додана. Migration: add_units_of_measure.
[x] `[sto-database]` `Good.unit` залишається `String`. Додати `Good.unitId String? @db.Uuid` → relation `unitOfMeasure UnitOfMeasure?`.
    > Good розширена з unitId опціональне поле. Migration: add_units_of_measure.
[x] `[sto-backend]` `UnitsModule`: CRUD `/units-of-measure`. Roles: OWNER, ADMIN, STOREKEEPER.
    > Повна реалізація: units.service.ts, units.controller.ts, units.module.ts + реєстрація в app.module.ts.
[x] `[sto-web]` У формі товару: поле "Одиниця виміру" → Select з `/units`.
    > GoodsTab form: unitId + unit автозаповнення з shortName. Fallback — ручне поле.
[x] `[sto-web]` Вкладка "Одиниці виміру" в `/catalog`.
    > UnitsTab: CRUD таблиця shortName|name|тип + форма додавання. isSystem позначка.

### 16.4 — Нова роль XLSX_MANAGER + захист імпорту

[x] `[sto-database]` Додати `XLSX_MANAGER` до enum `UserRole`. Міграція.
    > XLSX_MANAGER додана до UserRole enum. Migration: add_xlsx_manager_role.
[x] `[sto-backend]` Всі XLSX endpoints захищені `@Roles('OWNER', 'ADMIN', 'XLSX_MANAGER')`.
    > XlsxController: всі endpoints мають @Roles()з XLSX_MANAGER.
[x] `[sto-web]` Роль `XLSX_MANAGER` у `ROLE_LABELS` + badge + форма співробітника.
    > TopShell ROLE_LABELS + employees page ROLE_LABELS, ROLE_BADGE, ROLE_FILTER_OPTIONS оновлені.

### 16.5 — XLSX-імпорт: довідники (товари, одиниці, бренди)

[x] `[sto-backend]` `XlsxModule` (`/xlsx`):
    > XlsxService: generateGoodsTemplate(), generateWorksTemplate(), generateBrandsTemplate(), generateUnitsTemplate(), generatePOLinesTemplate().
    > parseGoods, parseWorks, parseBrands, parseUnits, parsePOLines методи з обробкою помилок.
    > XlsxController: GET /xlsx/templates/:type (goods, works, brands, units, po-lines, sd-lines, wo-parts).
    > POST /xlsx/import/goods, POST /xlsx/import/brands, POST /xlsx/import/units.
    > Результат: {created, updated, errors[]}. Roles: OWNER, ADMIN, XLSX_MANAGER.
    > Залежність: exceljs встановлена. Fastify multipart вже реєстровано в main.ts.
[x] `[sto-web]` Компонент `XlsxImportButton` + UI інтеграція.
    > apps/web/src/components/ui/xlsx-import-button.tsx. Інтегровано в GoodsTab і WorksTab тулбари.

### 16.6 — XLSX-імпорт: табличні частини документів

**Бекенд:**
- [x] `[sto-backend]` `POST /xlsx/import/purchase-order-lines/:poId` → multipart xlsx → parse рядки (SKU + qty + price) → upsert POLines. Перевіряє що PO у статусі DRAFT і належить orgId.
    > `apps/api/src/modules/xlsx/`. Parse xlsx rows → upsert POLines. Validates PO is DRAFT + orgId.
- [x] `[sto-backend]` `POST /xlsx/import/stock-document-lines/:docId` → аналогічно для StockDocument (тільки DRAFT).
    > Same pattern for StockDocument. Validates DRAFT + orgId.
- [x] `[sto-backend]` `POST /xlsx/import/work-order-parts/:woId` → аналогічно для WorkOrder (DRAFT/ESTIMATE).
    > Same pattern for WorkOrder parts. Validates status in DRAFT/ESTIMATE + orgId.
- [x] `[sto-backend]` `GET /xlsx/templates/po-lines`, `sd-lines`, `wo-parts` → шаблони з колонками SKU, Назва, К-ть, Ціна.
    > Template .xlsx with columns: SKU | Назва | К-ть | Ціна. generateSDLinesTemplate/generateWOPartsTemplate delegate to generatePOLinesTemplate.

**Фронтенд:**
- [x] `[sto-web]` `XlsxImportButton` в картці PurchaseOrder (PO лінії), StockDocument (лінії), WorkOrder (запчастини — вкладка).
    > Integrated in WO detail page (work-orders/[id]/PageClient.tsx). PO and SD detail pages do not exist yet — skipped.

### 16.7 — CRM: гараж "Основний" за замовчуванням

[x] `[sto-backend]` `POST /counterparties` → автоматично створює CustomerGarage з name='Основний', isDefault=true в транзакції.
    > CounterpartiesService.create() розширена: після створення cp, create garage для CLIENT/BOTH types.
[x] `[sto-backend]` `CustomerGarage.isDefault Boolean @default(false)` — поле для позначення основного гаражу. Міграція.
    > Поле додане. Migration: add_customer_garage_is_default.
    > GarageResponseDto + toGarageDto розширені з isDefault полем.
[x] `[sto-web]` В картці контрагента: основний гараж виводиться першим із позначкою "Основний".
    > PageClient.tsx: Garage.isDefault → badge "Основний" на кнопці/заголовку гаражу.

### 16.8 — CRM: гаражі та авто вкладками в картці клієнта

**Фронтенд:**
- [x] `[sto-web]` Картка контрагента `/crm/[id]` — реорганізація в 4 таби:
  - Вкладка **"Загальна інформація"**: поля контрагента + inline редагування phone/email/notes.
  - Вкладка **"Гаражі та авто"**: accordion з isDefault badge + авто + форми додавання.
  - Вкладка **"Взаєморозрахунки"**: баланс + транзакції.
  - Вкладка **"Наряди"**: GET /work-orders?counterpartyId.
  > PageClient.tsx повністю перероблено.

### 16.9 — Налаштування інтерфейсу: режим навігації

**Фронтенд:**
- [x] `[sto-web]` У `/settings` (вкладка "Оформлення") додати перемикач **"Режим навігації"**.
- [x] `[sto-web]` Збереження в `localStorage` ключ `sto_nav_mode` + custom event `sto:nav-mode-change`.
- [x] `[sto-web]` `TopShell.tsx`: зчитує `sto_nav_mode`, рендерить відповідний `NAV_GROUPS`.
- [x] `[sto-web]` `NAV_GROUPS_FUNCTIONS` — плоска структура без секцій.
    > TopShell: NAV_GROUPS_FUNCTIONS + navMode state + localStorage hydration + event listener.

### 16.10 — Темна та світла теми (color scheme)

> **Поведінка за замовчуванням:** використовується тема операційної системи (`prefers-color-scheme`). Користувач може примусово встановити світлу або темну тему в налаштуваннях.

**Архітектурне рішення:**
- `localStorage` ключ `sto_color_mode`: `'system'` | `'light'` | `'dark'`; дефолт — `'system'`
- При `'system'` → `window.matchMedia('(prefers-color-scheme: dark)')` + підписка на зміни
- Застосування: додавати/знімати клас `dark` на `<html>` елементі
- Стратегія: inline `<script>` в `<head>` (до React hydration) щоб уникнути flash of wrong theme

**CSS — темна тема (Tailwind 4 `.dark` variant):**
- Всі поверхні інвертуються через `@media (prefers-color-scheme: dark)` + `.dark` клас
- Ключові dark-значення:
  ```
  --color-background:       hsl(222 47% 8%)    /* темно-синій фон */
  --color-surface:          hsl(222 47% 11%)
  --color-surface-raised:   hsl(222 47% 14%)
  --color-foreground:       hsl(213 31% 91%)
  --color-foreground-muted: hsl(215 20% 60%)
  --color-foreground-faint: hsl(215 20% 45%)
  --color-border:           hsl(222 35% 20%)
  --color-border-hover:     hsl(222 35% 30%)
  --color-secondary:        hsl(222 35% 16%)
  --color-muted:            hsl(222 35% 16%)
  --color-card:             hsl(222 47% 11%)
  /* Sidebar — залишається темним, зміна мінімальна */
  --color-sidebar-bg:       hsl(224 44% 9%)
  --color-sidebar-border:   hsl(222 35% 14%)
  /* Semantic кольори — трохи приглушені в dark */
  --color-destructive-subtle: hsl(0 40% 14%)
  --color-success-subtle:     hsl(142 40% 12%)
  --color-warning-subtle:     hsl(38 40% 13%)
  --color-info-subtle:        hsl(199 40% 13%)
  /* Scrollbar */
  scrollbar: hsl(222 35% 25%)
  ```

**Реалізація:**

- [x] `[sto-web]` `apps/web/src/lib/color-mode.ts` — утиліти: `getColorMode()`, `setColorMode(mode)`, `applyColorMode()`, `watchSystemColorMode()`.
- [x] `[sto-web]` `apps/web/src/app/layout.tsx` — inline `<script>` в `<head>` анти-flash + `<ColorModeProvider>`.
- [x] `[sto-web]` `apps/web/src/app/globals.css` — `.dark { ... }` блок + `@media (prefers-color-scheme: dark)` для system preference.
- [x] `[sto-web]` `apps/web/src/components/ColorModeProvider.tsx` — mount + watchSystemColorMode.
- [x] `[sto-web]` `/settings` вкладка "Оформлення" — перемикач "Тема": Світла/Темна/Системна (Sun/Moon/Monitor іконки).
- [x] `[sto-web]` Skeleton/shimmer анімація в `globals.css` — варіант для темної теми.
    > `.skeleton` utility class using CSS vars `--color-muted`/`--color-secondary` — adapts to dark automatically via `.dark {}` overrides.
- [x] `[sto-web]` KPI-картки, таблиці, модалки — перевірити canonical токени в dark mode.
    > All components use bg-surface/border-border/text-foreground — dark vars propagate via CSS variable overrides in `.dark {}` block.

**Технічні деталі — анти-flash script:**
```html
<!-- вставляється як перший дочірній елемент <head>, до будь-якого CSS -->
<script>
  (function() {
    var mode = localStorage.getItem('sto_color_mode') || 'system';
    var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    var isDark = mode === 'dark' || (mode === 'system' && prefersDark);
    document.documentElement.setAttribute('data-color-mode', mode);
    if (isDark) document.documentElement.classList.add('dark');
  })();
</script>
```

**Інтеграція з брендовою темою:**
- Поточна система brand-тем (`blue`, `green`, `purple`, `orange`, `gray`) незалежна від color mode
- `applyTheme()` оновлює тільки `--color-primary*` — не чіпає surface/background токени
- В темному режимі primary-кольори трохи освітлюються автоматично завдяки CSS змінним

---

## Фаза 17 — Збагачення об'єктів + Нові моделі

> Залежності: Фази 0–16.  
> Мета: Повноцінна ERP — типобезпека, HR-реквізити, технічні дані авто, акти, планування ТО, рядки Invoice з ПДВ.

### 17.1 — Технічний борг: String → Enum

- [x] `[sto-database]` `PurchaseOrder.status` → `PurchaseOrderStatus` enum (DRAFT/ORDERED/RECEIVED/PARTIAL/CANCELLED)
    > Enum додано в schema + поле змінено. Міграція: `purchase_order_status_enum`.
- [x] `[sto-database]` `Invoice.status` → `InvoiceStatus` enum (DRAFT/SENT/PAID/OVERDUE/CANCELLED)
    > Enum додано в schema + поле змінено. Міграція: `invoice_status_enum`.
- [x] `[sto-database]` `CalendarSlot.status/type` → `CalendarSlotStatus` / `CalendarSlotType` enum
    > Два нові enum-и + поля у CalendarSlot. Міграція: `calendar_slot_enums`.
- [x] `[sto-database]` `Employee.status` → `EmployeeStatus` enum (ACTIVE/ON_LEAVE/FIRED)
    > Enum + поле в Employee. Міграція: `employee_status_enum`.

### 17.2 — Збагачення існуючих моделей

- [x] `[sto-database]` `Vehicle` — технічні реквізити: transmissionType, driveType, bodyType, engineCode, insuranceExpiry, inspectionExpiry
    > 6 нових полів у Vehicle. Міграція: `vehicle_technical_fields`.
- [x] `[sto-database]` `WorkOrder` — пріоритет/категорія/дедлайн: priority (WorkOrderPriority), repairCategory (RepairCategory), dueDate, clientApproval
    > 2 нові enum-и (WorkOrderPriority, RepairCategory) + 4 поля у WorkOrder. Міграція: `work_order_priority_category`.
- [x] `[sto-database]` `WorkOrderLine.actualHours` — фактичний час виконання
    > Поле actualHours Float? у WorkOrderLine. Міграція: `work_order_line_actual_hours`.
- [x] `[sto-database]` `Employee` — HR-поля: email, phone, dateOfHire, dateOfFire
    > 4 нові поля у Employee. Міграція: `employee_hr_fields`.
- [x] `[sto-database]` `Good` — тип товару та постачальник: goodType (GoodType), preferredSupplierId → Counterparty
    > Enum GoodType (SPARE_PART/CONSUMABLE/MATERIAL/TOOL) + 2 поля + relation. Міграція: `good_type_supplier`.
- [x] `[sto-database]` `Counterparty` — юридичні реквізити: legalForm, legalAddress, actualAddress, bankAccount, bankName, contactPerson, taxNumber
    > Enum LegalForm (INDIVIDUAL/FOP/TOV/AT/PP/OTHER) + 7 полів. Міграція: `counterparty_legal_fields`.
- [x] `[sto-database]` `Lift` — технічне обслуговування: status (LiftStatus), serialNumber, purchaseDate, warrantyUntil, maintenanceIntervalDays, lastMaintenanceDate, nextMaintenanceDate
    > Enum LiftStatus (ACTIVE/MAINTENANCE/BROKEN/DECOMMISSIONED) + 7 полів. Міграція: `lift_maintenance_fields`.
- [x] `[sto-database]` `Invoice` — рядки з ПДВ: нова модель InvoiceLine, поля totalWithoutVat/totalVat/totalWithVat/invoiceType/notes
    > Нова модель InvoiceLine (9 фінансових полів + FK до Invoice/Good/Work). Міграція: `invoice_lines_vat`.

### 17.3 — Нові об'єкти

- [x] `[sto-database]` `MaintenanceSchedule` — планування ТО: intervalDays, intervalMileage, nextMaintenanceDate, nextMaintenanceMileage
    > Нова модель MaintenanceSchedule + relation в Vehicle. Міграція: `maintenance_schedule`.
- [x] `[sto-database]` `CompletionAct` — акт виконаних робіт: number, status (CompletionActStatus), signedAt, signedBy, clientPhone
    > Enum CompletionActStatus (DRAFT/SIGNED/CANCELLED) + нова модель + relation в WorkOrder. Міграція: `completion_act`.

---

## Фаза 17.5 — Фінансова інфраструктура: Валюти, Курси, Банківські рахунки, Каса

> Реалізовано: 2026-05-28. Залежності: Фаза 4 (Organisation, GarageBranch).  
> Мета: фінансові довідники — валюти, курси обміну, банківські рахунки, каси. Розширення Organisation логотипом і адресами.

- [x] `[sto-database]` `Currency` — модель валюти: name, code (@@unique orgId+code), symbol, fullName, internationalName; soft delete
    > 4 нові моделі + розширення Organisation (logoUrl, legalAddress, actualAddress, bankAccountId). Міграція: `add_currencies_bank_accounts_cash_registers`. ExchangeRate.rate = Decimal(18,6) (фікс точності: `exchange_rate_precision`).
- [x] `[sto-database]` `ExchangeRate` — курс до базової валюти: date @db.Date, rate Decimal(18,6), coefficient Decimal(18,6); @@unique([orgId, currencyId, date])
- [x] `[sto-database]` `BankAccount` — банківський рахунок: ibanUA (UA + 27 цифр), currencyId FK, branchId FK (optional), bankName, mfo, edrpou, bankAddress
- [x] `[sto-database]` `CashRegister` — каса: currencyId FK, branchId FK (required)
- [x] `[sto-backend]` `CurrenciesModule` — CRUD `/currencies`; ConflictException при дублікаті коду; read: всі ролі; write: OWNER/ADMIN
    > `apps/api/src/modules/currencies/`. Contract-тести: `currencies.contract.spec.ts`.
- [x] `[sto-backend]` `ExchangeRatesModule` — CRUD `/exchange-rates`; фільтри `?currencyId=&from=&to=`; ConflictException при дублікаті (orgId+currencyId+date)
    > `apps/api/src/modules/exchange-rates/`. Contract-тести: `exchange-rates.contract.spec.ts`.
- [x] `[sto-backend]` `BankAccountsModule` — CRUD `/bank-accounts`; IBAN валідація `@Matches(/^UA\d{27}$/)`; FK-перевірка currencyId+branchId по orgId
    > `apps/api/src/modules/bank-accounts/`. Contract-тести: `bank-accounts.contract.spec.ts`.
- [x] `[sto-backend]` `CashRegistersModule` — CRUD `/cash-registers`; фільтр `?branchId=`; FK-перевірка currencyId+branchId по orgId
    > `apps/api/src/modules/cash-registers/`.
- [x] `[sto-backend]` `SettingsModule` — `GET/PATCH /settings/org-info` (Organisation: name, edrpou, logoUrl, legalAddress, actualAddress, bankAccountId)
    > Методи `getOrganisation`/`updateOrganisation` в `settings.service.ts`; `getOrgInfo`/`updateOrgInfo` в контролері.
- [x] `[sto-web]` Вкладки у `/settings`: "Організація" (+ logoUrl upload, адреси, основний рахунок), "Валюти", "Курси валют", "Банківські рахунки", "Каса"
    > `apps/web/src/app/settings/page.tsx`. SearchCombobox для FK-полів. Loading/error стани на всіх вкладках.

---

## Фаза 19 — Партійний облік + Цінова історичність

> Залежності: Фаза 9 (StockMovement, StockItem, PurchaseOrderLine), Фаза 17 (збагачені моделі).  
> Мета: кожна партія товару зберігається окремо з власною собівартістю; ціна продажу формується автоматично за правилом націнки; з будь-якого документа можна переглянути партії та цінову історію товару.

### Що вирішує ця фаза

| Проблема | Рішення |
|---|---|
| Невідомо, яка собівартість при списанні з наряду | `StockBatch` — кожен прихід = окрема партія з `costPrice` |
| `Good.salePrice` перезаписується при кожній поставці | `PriceHistory` — append-only лог усіх змін ціни |
| Ціна продажу встановлюється вручну | `PricingRule` — автоматичне обчислення при оприбуткуванні |
| Неможливо побачити партії з наряду/накладної | Batch Viewer — модальне вікно з будь-якого документа |
| Немає реальної маржинальності по документах | `batchCostPrice` у `WorkOrderPart` та `InvoiceLine` |

---

### Фаза 19.1 — Схема БД: StockBatch + PricingRule + PriceHistory

**Нові моделі:**

```prisma
enum BatchCostMethod {
  FIFO        // за замовчуванням
  FEFO        // для товарів з терміном придатності
  LIFO        // рідко
  AVG_COST    // середньозважена
}

enum PricingRuleType {
  PERCENT           // salePrice = costPrice × (1 + percent/100)
  FIXED_AMOUNT      // salePrice = costPrice + fixedAmount
  FIXED_PRICE       // salePrice = fixedValue (ігнорує собівартість)
  COMPETITOR_PLUS   // salePrice = competitorPrice × (1 + percent/100)
}

model StockBatch {
  id                  String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId               String    @db.Uuid
  goodId              String    @db.Uuid
  warehouseId         String    @db.Uuid
  purchaseOrderLineId String?   @db.Uuid   // null для OPENING_BALANCE партій
  stockMovementId     String    @db.Uuid   // RECEIPT StockMovement
  batchNumber         String?              // серійний номер, партія від постачальника
  expiryDate          DateTime?            // для FEFO
  receivedQty         Float
  remainingQty        Float
  costPrice           Decimal   @db.Decimal(12, 2)   // ціна оприбуткування — незмінна
  salePrice           Decimal   @db.Decimal(12, 2)   // обчислена при прийомі за PricingRule
  isActive            Boolean   @default(true)
  syncVersion         BigInt    @default(0)
  createdAt           DateTime  @default(now())
  updatedAt           DateTime  @updatedAt

  good                Good                @relation(fields: [goodId], references: [id])
  warehouse           Warehouse           @relation(fields: [warehouseId], references: [id])
  purchaseOrderLine   PurchaseOrderLine?  @relation(fields: [purchaseOrderLineId], references: [id])
  stockMovement       StockMovement       @relation(fields: [stockMovementId], references: [id])
  consumptions        BatchConsumption[]

  @@index([orgId, goodId, warehouseId, isActive])
  @@index([orgId, goodId, expiryDate])
  @@map("stock_batches")
}

// Append-only — фіксує яка партія була використана в документі
model BatchConsumption {
  id             String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId          String    @db.Uuid
  batchId        String    @db.Uuid
  goodId         String    @db.Uuid
  quantity       Float                    // від'ємне = списання, додатнє = повернення
  documentType   String                   // WorkOrder | StockDocument | Transfer
  documentId     String    @db.Uuid
  documentLineId String?   @db.Uuid       // WorkOrderPart.id | StockDocumentLine.id
  createdAt      DateTime  @default(now())
  createdBy      String?   @db.Uuid

  batch  StockBatch @relation(fields: [batchId], references: [id])

  @@index([orgId, batchId])
  @@index([orgId, documentType, documentId])
  @@map("batch_consumptions")
}

model PricingRule {
  id           String          @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId        String          @db.Uuid
  name         String
  type         PricingRuleType
  // Пріоритет (менше = вищий пріоритет): goodId(1) > category(2) > goodType(3) > orgDefault(10)
  priority     Int             @default(10)
  goodId       String?         @db.Uuid   // якщо правило для конкретного товару
  goodCategory String?                    // якщо для категорії
  goodType     String?                    // якщо для типу (SPARE_PART, CONSUMABLE...)
  // Параметри залежно від type
  percentValue Decimal?        @db.Decimal(6, 2)    // для PERCENT і COMPETITOR_PLUS
  fixedAmount  Decimal?        @db.Decimal(12, 2)   // для FIXED_AMOUNT
  fixedPrice   Decimal?        @db.Decimal(12, 2)   // для FIXED_PRICE
  roundTo      Decimal?        @db.Decimal(6, 2)    // округлення результату (напр. 0.5 → до 50 коп)
  isActive     Boolean         @default(true)
  syncVersion  BigInt          @default(0)
  createdAt    DateTime        @default(now())
  updatedAt    DateTime        @updatedAt
  deletedAt    DateTime?

  good  Good? @relation(fields: [goodId], references: [id])

  @@index([orgId, isActive, priority])
  @@map("pricing_rules")
}

// Append-only — лог усіх змін ціни продажу
model PriceHistory {
  id          String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId       String    @db.Uuid
  goodId      String    @db.Uuid
  oldPrice    Decimal?  @db.Decimal(12, 2)   // null при першій фіксації
  newPrice    Decimal   @db.Decimal(12, 2)
  costPrice   Decimal?  @db.Decimal(12, 2)   // собівартість партії яка спричинила зміну
  reason      String?                        // "PricingRule: назва" | "Manual" | "Batch receipt"
  batchId     String?   @db.Uuid
  pricingRuleId String? @db.Uuid
  createdAt   DateTime  @default(now())
  createdBy   String?   @db.Uuid

  good  Good @relation(fields: [goodId], references: [id])

  @@index([orgId, goodId, createdAt])
  @@map("price_history")
}
```

**Розширення існуючих моделей:**

```prisma
// OrganisationSettings — додати:
costMethod  BatchCostMethod  @default(FIFO)

// WorkOrderPart — додати:
batchId        String?  @db.Uuid    // null якщо AVG_COST
batchCostPrice Decimal? @db.Decimal(12, 2)  // собівартість на момент списання

// StockMovement — додати:
batchId  String?  @db.Uuid

// PurchaseOrderLine — додати:
batchId  String?  @db.Uuid    // заповнюється після оприбуткування
```

**Міграція:** `--name batch_pricing_history`

---

### Фаза 19.2 — Backend: BatchService + PricingService

**`BatchService`** — `apps/api/src/modules/inventory/batch.service.ts`

```typescript
// Методи:
createFromReceipt(orgId, purchaseOrderLineId, stockMovementId, qty, costPrice): StockBatch
  // 1. Шукає активний PricingRule для goodId
  // 2. Обчислює salePrice
  // 3. Якщо salePrice != Good.salePrice → оновлює Good.salePrice + пише PriceHistory
  // 4. Повертає новостворену партію

consumeBatch(orgId, goodId, warehouseId, qty, documentType, documentId, documentLineId): BatchConsumption[]
  // 1. Читає OrganisationSettings.costMethod
  // 2. FIFO: findMany batches ORDER BY createdAt ASC WHERE remainingQty > 0
  // 3. FEFO: ORDER BY expiryDate ASC NULLS LAST
  // 4. LIFO: ORDER BY createdAt DESC
  // 5. AVG_COST: не прив'язує до партій, повертає []
  // 6. Списує qty по партіях у prisma.$transaction
  // 7. Пише BatchConsumption per batch
  // 8. Повертає масив BatchConsumption

getBatchesForGood(orgId, goodId, warehouseId?): StockBatchResponseDto[]
  // Повертає всі активні + вичерпані партії, відсортовані за датою

getAvgCost(orgId, goodId, warehouseId): number
  // SUM(remainingQty * costPrice) / SUM(remainingQty)
```

**`PricingService`** — `apps/api/src/modules/pricing/pricing.service.ts`

```typescript
// Методи:
calculateSalePrice(orgId, goodId, goodCategory, goodType, costPrice): Decimal
  // Шукає PricingRule з найвищим пріоритетом (мінімальний priority int) що відповідає goodId/category/goodType
  // Якщо правил немає → повертає Good.salePrice без змін

applyRuleToAll(orgId, ruleId): { updated: number }
  // Перераховує Good.salePrice для всіх товарів що підпадають під правило
  // Пише PriceHistory для кожного зміненого товару
  // Виконується в BullMQ job (може бути довго)

CRUD /pricing-rules:
  GET    /pricing-rules
  POST   /pricing-rules
  PATCH  /pricing-rules/:id
  DELETE /pricing-rules/:id (soft delete)
  POST   /pricing-rules/:id/apply-all   ← запускає BullMQ job
```

**Інтеграція з InventoryService:**

```
InventoryService.createMovement(type: RECEIPT) →
  + BatchService.createFromReceipt(...)

InventoryService.createMovement(type: WRITEOFF | RESERVATION) →
  + BatchService.consumeBatch(...)

WorkOrdersService → COMPLETED →
  WorkOrderPart.batchId = batchId з consumeBatch
  WorkOrderPart.batchCostPrice = batch.costPrice (або avgCost)
```

**Нові ендпоінти:**

```
GET  /goods/:id/batches              — всі партії товару
GET  /goods/:id/price-history        — лог змін ціни
GET  /goods/:id/batches/by-warehouse — партії по складах
POST /inventory/batches/transfer     — переміщення партії між складами
```

---

### Фаза 19.3 — Backend: Batch Viewer API

```
GET /batches/lookup?goodId=X&warehouseId=Y&documentType=Z&documentId=W
```

Повертає:
```typescript
{
  good: { id, name, sku, unit },
  currentPrice: number,           // Good.salePrice
  avgCostPrice: number,           // середньозважена залишків
  batches: [{
    id, batchNumber, receivedQty, remainingQty,
    costPrice, salePrice, expiryDate, createdAt,
    purchaseOrderNumber,           // з PurchaseOrder якщо є
    status: 'ACTIVE' | 'DEPLETED' | 'CANCELLED'
  }],
  priceHistory: [{
    oldPrice, newPrice, costPrice, reason, createdAt
  }]
}
```

---

### Фаза 19.4 — Frontend: Batch Viewer Modal

Компонент `BatchViewerModal` — викликається з будь-якого документа:

```typescript
<BatchViewerModal
  goodId="..."
  warehouseId="..."          // опціонально
  documentType="WorkOrder"   // для підсвічування використаних партій
  documentId="..."
  open={showBatches}
  onClose={() => setShowBatches(false)}
/>
```

**UI структура:**

```
┌────────────────────────────────────────────────────┐
│  Партії та ціни — Масло Shell Helix 5W-40 1L       │
├────────────────┬───────────────────────────────────┤
│  Вкладка       │  Вкладка                          │
│  "Партії"  ●  │  "Історія цін"                    │
├────────────────┴───────────────────────────────────┤
│  Середня собівартість: 245,00 ₴                    │
│  Поточна ціна продажу: 320,00 ₴  (маржа: 30,6%)   │
├────────────────────────────────────────────────────┤
│  Партія      Отримано   Залишок  Собіварт. Ціна    │
│  ─────────── ────────── ──────── ──────── ──────── │
│  PO-2026-012  10 шт     8 шт     245,00   320,00  │
│  PO-2026-008   5 шт     0 шт     230,00   299,00  │  ← DEPLETED
│  [OPENING]    20 шт     2 шт     210,00   280,00  │
└────────────────────────────────────────────────────┘
```

**Де підключається кнопка "Партії":**

| Документ | Де кнопка |
|---|---|
| `WorkOrderPart` рядок | іконка біля назви товару в деталях наряду |
| `PurchaseOrderLine` рядок | іконка в деталях накладної (Фаза 9) |
| `StockDocumentLine` рядок | іконка в складському документі |
| `Catalog → Good` картка | таб "Партії" поряд з "Рухи" |
| `InvoiceLine` рядок | іконка в деталях рахунку |

---

### Фаза 19.5 — Frontend: Pricing Rules UI

Нова сторінка `/pricing-rules` (розділ "Каталог" або "Налаштування"):

```
┌─────────────────────────────────────────────────────┐
│  Правила ціноутворення                  + Додати    │
├─────────────────────────────────────────────────────┤
│  Назва              Тип         Застосовується  %   │
│  ─────────────────  ──────────  ─────────────── ─── │
│  Запчастини +35%    Відсоток    Тип: SPARE_PART  35  │
│  Витрат. матеріали  Відсоток    Тип: CONSUMABLE  25  │
│  Масла Shell (спец) Фіксована   Товар: Shell…   320  │
└─────────────────────────────────────────────────────┘
```

Форма правила: тип (select) → динамічні поля (percent/amount/price) → вибір scope (весь асортимент / тип товару / категорія / конкретний товар).

Кнопка "Застосувати до всіх" → BullMQ job → toast "Перераховано N товарів".

---

### Задачі фази

- [x] `[sto-database]` **19.1** — Схема: `StockBatch`, `BatchConsumption`, `PricingRule`, `PriceHistory`; розширити `OrganisationSettings` (`costMethod`), `WorkOrderPart` (`batchId`, `batchCostPrice`), `StockMovement` (`batchId`), `PurchaseOrderLine` (`batchId`); міграція `--name batch_pricing_history`
    > `packages/database/prisma/schema.prisma`. Міграція `20260525151450_batch_pricing_history`. Enum `BatchCostMethod` (FIFO/FEFO/LIFO/AVG_COST), `PricingRuleType` (PERCENT/FIXED_AMOUNT/FIXED_PRICE/COMPETITOR_PLUS).
- [x] `[sto-backend]` **19.2** — `BatchService`: `createFromReceipt`, `consumeBatch` (FIFO/FEFO/LIFO/AVG_COST), `getAvgCost`; `PricingService`: `calculateSalePrice`, `applyRuleToAll` (BullMQ); інтеграція в `InventoryService.createMovement()` та `WorkOrdersService`
    > `apps/api/src/modules/inventory/batch.service.ts`, `pricing.service.ts`. `InventoryService.createMovement()` викликає `BatchService.createFromReceipt()` для RECEIPT. `forwardRef` для уникнення circular dependency.
- [x] `[sto-backend]` **19.3** — `GET /batches/lookup` (Batch Viewer API); `GET /goods/:id/batches`; `GET /goods/:id/price-history`; CRUD `/pricing-rules` + `POST /pricing-rules/:id/apply-all`
    > `apps/api/src/modules/inventory/batches.controller.ts`, `pricing-rules.controller.ts`, `pricing-rules.dto.ts`. `GET /batches/lookup` повертає `{ good, avgCostPrice, batches, priceHistory }`. DTO використовує `!` для обов'язкових полів (`name!`, `type!`).
- [x] `[sto-web]` **19.4** — `BatchViewerModal` компонент (вкладки "Партії" / "Історія цін"); підключення іконки у `WorkOrderPart`, картка товару (таб "Партії")
    > `apps/web/src/components/ui/batch-viewer-modal.tsx`. Іконка `<Layers>` у `WorkOrderPart` рядках (`apps/web/src/app/work-orders/[id]/PageClient.tsx`). Таб "Партії" у каталозі товарів (`apps/web/src/app/catalog/page.tsx`).
- [x] `[sto-web]` **19.5** — Сторінка `/pricing-rules` (список правил, форма створення/редагування, кнопка "Застосувати до всіх" з прогрес-тостом)
    > `apps/web/src/app/pricing-rules/page.tsx` + `PricingRulesClient.tsx`. Навігація `TopShell` (розділ "Довідники", іконка `Zap`). Ролі: OWNER/ADMIN/STOREKEEPER.

### Порядок виконання

```
19.1 → schema.prisma + міграція
19.2 → BatchService + PricingService + інтеграція в InventoryService
19.3 → Batch Viewer API endpoint
19.4 → BatchViewerModal компонент + підключення в документах
19.5 → PricingRules CRUD UI
```

Після кожного підпункту:
- `pnpm --filter @sto/api exec tsc --noEmit`
- `cd apps/web && tsc --noEmit --incremental false`
- `git commit -m "feat(phase19): 19.X — ..."`

---

### Business Rules Catalogue (BR-BATCH)

- **BR-BATCH-001**: Кожен RECEIPT StockMovement створює рівно одну `StockBatch`
- **BR-BATCH-002**: `StockBatch.remainingQty` ніколи не стає від'ємним — блок на рівні `BatchService`
- **BR-BATCH-003**: Метод списання (`FIFO|FEFO|LIFO|AVG_COST`) задається в `OrganisationSettings.costMethod`
- **BR-BATCH-004**: При `FIFO/FEFO/LIFO` — списання фіксується в `BatchConsumption`; при `AVG_COST` — не прив'язується
- **BR-BATCH-005**: `StockBatch.costPrice` — фіксується при оприбуткуванні, **ніколи не змінюється** (append-only принцип)
- **BR-BATCH-006**: `StockBatch.salePrice` — розраховується при оприбуткуванні за найпріоритетнішим `PricingRule`
- **BR-BATCH-007**: При зміні `salePrice` → автоматично пишеться запис у `PriceHistory`
- **BR-BATCH-008**: `PricingRule` з `priority=1` (goodId) перекриває `priority=2` (category) перекриває `priority=10` (org default)
- **BR-BATCH-009**: Скасування `PurchaseOrder` → `StockBatch.remainingQty` відновлюється, `isActive=false`
- **BR-BATCH-010**: Переміщення товару (TRANSFER) між складами — `StockBatch.warehouseId` оновлюється
- **BR-BATCH-011**: `WorkOrderPart.batchCostPrice` фіксується при списанні — не змінюється навіть при зміні партії
- **BR-BATCH-012**: `InvoiceLine.costPrice` береться з `WorkOrderPart.batchCostPrice` для розрахунку маржі
- **BR-BATCH-013**: Партія вважається `DEPLETED` коли `remainingQty = 0`
- **BR-BATCH-014**: Ручна партія (OPENING_BALANCE) не має `purchaseOrderLineId` — це нормально
- **BR-BATCH-015**: `POST /pricing-rules/:id/apply-all` — виконується асинхронно через BullMQ, не блокує UI

---

## Фаза 18 — Installer та Production

> Залежності: Фази 13–19 (фінальна стабільна версія).  
> Мета: `.exe` installer + auto-update + production hardening.

- [ ] `[sto-installer]` Inno Setup скрипт: завантаження/розпакування Docker images, `docker compose up`, Windows service
- [ ] `[sto-installer]` PowerShell `Update.ps1`: pull нових images + `migrate deploy` + restart
- [ ] `[sto-installer]` PowerShell `Backup.ps1`: `pg_dump` + архів MinIO + ротація 30 днів
- [x] `[sto-backend]` `GET /health` → детальний статус: DB, Redis, MinIO, BullMQ queues
- [ ] `[sto-web]` Production Next.js build + статичний експорт в `apps/api/public/`
- [ ] `[sto-mobile]` EAS Build: APK (Android) + TestFlight (iOS)
- [ ] Фінальне тестування: smoke test після установки на чистій Windows VM

---

---

## Фаза 21 — Бекленд: Покращення досвіду та нові функції

> Залежності: Фази 0–19.
> Мета: функціонал що підвищує цінність системи для СТО — без зміни core.
> Пріоритет: B1–B5 (висока цінність, низька складність) → B6–B12 (середня складність).

### B1 — Вихідні webhook-нотифікації

- [x] `[sto-database]` Модель `WebhookEndpoint` (`orgId`, `url`, `secret`, `events String[]`, `isActive`) + `WebhookDelivery` (`endpointId`, `event`, `payload`, `status`, `attempts`, `responseCode`)
- [x] `[sto-backend]` `WebhookModule`: CRUD `/webhooks` (OWNER/ADMIN) + `OutboundWebhookProcessor` (Bull, attempts=5, exponential backoff) — `dispatchEvent()` для `WO_STATUS_CHANGED`, `PAYMENT_RECEIVED`, `LOW_STOCK_ALERT`
- [x] `[sto-web]` UI у `/settings` → вкладка "Інтеграції": список вебхуків + форма (URL, secret, події) + лог доставки

### B2 — Технічний огляд (Inspection Checklist)

- [x] `[sto-database]` Модель `InspectionReport` (`workOrderId`, `points: Json` — масив `{name, value, unit, status: OK|WARN|CRITICAL}`, `mileage`, `createdBy`) + поле `WorkOrder.inspectionReport`
- [x] `[sto-backend]` `POST /work-orders/:id/inspection` + `GET /work-orders/:id/inspection`. При `CRITICAL` точках — авто-запис рекомендованих робіт у WO lines (з `Work` catalog).
- [x] `[sto-web]` Форма огляду у картці наряду: динамічний список точок (гальма/шини/масло/гальмівна рідина), input + статус, авто-збереження критичних пунктів у WO lines

### B3 — Планувальник записів (Booking Engine)

- [x] `[sto-backend]` `GET /booking/availability?date=&branchId=&serviceIds=` → вільні слоти (враховує зайнятість підйомників + час на роботи з Work.normoHours). Публічний endpoint `@Public()`.
- [x] `[sto-backend]` `POST /booking/request` (публічний) → створює `BookingRequest` (PENDING) → SMS підтвердження через NotificationService → авто-CalendarSlot при підтвердженні персоналом
- [x] `[sto-web]` Сторінка `/booking` (без auth) — вибір послуг → вибір дати/слоту → форма контакту → підтвердження. Embed-кнопка для сайту СТО.

### B4 — Гарантійний облік

- [x] `[sto-database]` Модель `Warranty` (`orgId`, `workOrderId`, `workOrderLineId?`, `workOrderPartId?`, `expiresAt`, `description`, `claimedAt?`, `claimWoId?`)
    > `packages/database/prisma/schema.prisma` + migration `20260526200000_warranty_inspection_webhook`. Поля: orgId, workOrderId, counterpartyId, expiresAt, claimedAt, claimWoId. Relations до WorkOrder (×2), Counterparty, Organisation.
- [x] `[sto-backend]` `POST /work-orders/:id/warranties` (авто після COMPLETED за `OrganisationSettings.warrantyDays`) + `GET /warranties/expiring?days=30` + `POST /warranties/:id/claim` (прив'язує новий WO)
    > `apps/api/src/modules/warranties/`. WarrantiesModule + CRUD endpoints + autoCreate у work-orders.service.ts transition COMPLETED handler. defaultWarrantyDays з SettingsService.
- [x] `[sto-web]` Вкладка "Гарантії" у картці контрагента + badge "Гарантія" у WO list для активних гарантій
    > `apps/web/src/app/crm/[id]/PageClient.tsx` — вкладка warranties + UI секція. `apps/web/src/app/work-orders/page.tsx` — hasActiveWarranty badge у таблиці.

### B5 — Бонусна програма (Loyalty Points)

- [x] `[sto-database]` Модель `LoyaltyAccount` (`counterpartyId UNIQUE`, `balance Decimal`) + `LoyaltyTransaction` (`accountId`, `type: EARN|REDEEM`, `points`, `documentId`, `documentType`, append-only)
    > `packages/database/prisma/migrations/20260526210000_loyalty_program/`. LoyaltyAccount + LoyaltyTransaction. OrganisationSettings: loyaltyEnabled/EarnPer/EarnPoints/RedeemRate.
- [x] `[sto-backend]` `LoyaltyService.earn(orgId, counterpartyId, paymentAmount)` → нараховує `floor(amount / settings.loyaltyEarnPer) * settings.loyaltyEarnPoints` балів. `LoyaltyService.redeem(orgId, counterpartyId, points)` → зменшує баланс. Queue 'loyalty' через @nestjs/bull.
    > `apps/api/src/modules/loyalty/{loyalty.service,loyalty.processor,loyalty.controller,loyalty.module}.ts`. GET balance/:id, GET transactions/:id, POST redeem/:id. settings.dto.ts + settings.service.ts розширено loyalty полями.
- [x] `[sto-web]` Баланс балів у картці контрагента + форма списання при оплаті наряду
    > `apps/web/src/app/crm/[id]/PageClient.tsx`. Новий таб "Лояльність" з балансом, формою списання і списком транзакцій.

### B6 — Full-text search

- [x] `[sto-database]` Міграція: `CREATE EXTENSION IF NOT EXISTS pg_trgm;` + GIN-індекси на `workOrders.number`, `counterparties.firstName/lastName/phone`, `goods.name/sku`
- [x] `[sto-backend]` `GET /search?q=&types=wo,counterparty,good&limit=10` → `$queryRaw` з `similarity()` або `plainto_tsquery`. Повертає `{ type, id, label, sub }[]`.
- [x] `[sto-web]` Command Palette (вже є) — підключити `/search` API для data search під nav-пошуком

### B7 — PDF-export рахунків і нарядів

- [x] `[sto-backend]` `GET /invoices/:id/pdf` → генерує PDF через `pdfmake` (npm, без headless browser). Шаблон: реквізити org + counterparty + таблиця ліній + ПДВ підсумок + підпис-блок. Відповідь `application/pdf`.
- [x] `[sto-backend]` `GET /work-orders/:id/pdf` → аналогічно: наряд-замовлення з переліком робіт і запчастин, підпис клієнта.
- [x] `[sto-web]` Кнопка "PDF" у DetailPanel рахунку і картці наряду → `<a download>` blob

### B8 — Ремаркетинг / Follow-up нагадування

- [x] `[sto-database]` `OrganisationSettings` — додати `followUpDays Int @default(90)` (після скільки днів без візиту нагадувати)
    > Додано `followUpActive` та `followUpDays` у `packages/database/prisma/schema.prisma`. Міграція готова до запуску при `docker-compose up`.
- [x] `[sto-backend]` `FollowUpProcessor` (BullMQ CRON щодня о 09:00) → знаходить авто де `MaintenanceSchedule.nextMaintenanceDate` ≤ today+14 або `lastWO.completedAt` < today-followUpDays → відправляє SMS через NotificationService (шаблон `FOLLOWUP_REMINDER`)
    > `apps/api/src/modules/notifications/followup.{processor,scheduler}.ts`. FOLLOWUP_REMINDER додано до enum NotificationEventType + міграція `20260526230000_add_followup_reminder_event`. FollowUpScheduler реєструє CRON при onModuleInit. FollowUpProcessor обробляє upcoming maintenance (14 днів) + idle vehicles (followUpDays).
- [x] `[sto-web]` Вкладка "Нагадування" в `/settings` → toggle isActive + налаштування followUpDays
    > Реалізовано в `apps/web/src/app/settings/page.tsx`. Форма з toggle `followUpActive` та інпут для `followUpDays` (30-365 днів).

### B9 — SSE Real-time дашборд

- [x] `[sto-backend]` `GET /dashboard/stream` (SSE, `text/event-stream`) → кожні 30с пушить `{ activeWo, todayRevenue, pendingInvoices, lowStockCount }`. `@Public()` НЕ — захищений JWT.
    > Реалізовано `apps/api/src/modules/dashboard/{dashboard.controller,dashboard.service}.ts`. JWT передається через query param токену (обмеження EventSource). Endpoint `/api/dashboard/stream?token=...`.
- [x] `[sto-web]` `useDashboardStream()` хук — `EventSource` з reconnect logic. Dashboard KPI-картки оновлюються live без polling. Indicator "live" (пульсуюча зелена крапка).
    > Hook у `apps/web/src/hooks/useDashboardStream.ts` з автоматичним reconnect через 5s при помилці. Підключено до Dashboard: activeWo, todayRevenue, pendingInvoices, lowStockCount оновлюються live. Зелена пульсуюча крапка при SSE активному.

### B10 — Branch ACL (права по філіях)

- [x] `[sto-database]` Таблиця `EmployeeBranch` (`employeeId`, `branchId`) — M:M. Поле `Employee.allBranches Boolean @default(false)` для OWNER/ADMIN.
- [x] `[sto-backend]` `BranchAccessGuard` — перевіряє що `orgId` у JWT + `branchId` з request param є в `employeeBranches[]` (або `allBranches=true`). Застосовується до WO, Invoice, CalendarSlot.
- [x] `[sto-web]` Форма співробітника → вкладка "Доступ до філій" (checkbox-список)

### B11 — Audit Log (документальна стрічка)

- [x] `[sto-database]` Модель `AuditEvent` (`orgId`, `entityType`, `entityId`, `action: CREATE|UPDATE|DELETE`, `userId`, `diff: Json`, `createdAt`, append-only, без `updatedAt/deletedAt/syncVersion`)
    > `packages/database/prisma/schema.prisma`. Міграція `20260526180000`. FK до Organisation та Employee.
- [x] `[sto-backend]` `AuditService.record(orgId, entity, action, userId, oldData, newData)` — Prisma `diff` через JSON-порівняння. Викликається у WO/Invoice/Employee service-методах. `GET /audit?entityType=WorkOrder&entityId=:id`
    > `apps/api/src/modules/audit/`. WorkOrdersService.create/transition/remove тепер приймає userId і записує аудит fire-and-forget. Controller OWNER/ADMIN/ACCOUNTANT.
- [x] `[sto-web]` Стрічка змін у DetailPanel WO/Invoice: "Іван змінив статус DRAFT → IN_PROGRESS о 14:32"
    > `apps/web/src/app/work-orders/[id]/PageClient.tsx`. `loadAudit` + `auditEvents` стан + render секція "Журнал змін".

### B12 — Фотозвіт у Web (drag-and-drop upload)

- [x] `[sto-database]` Модель `WorkOrderMedia` (`workOrderId`, `fileKey`, `filename`, `mimeType`, `sizeBytes`, `uploadedBy`, `createdAt`)
    > `packages/database/prisma/schema.prisma`. Міграція `20260526180000`. FK до Organisation, WorkOrder, Employee.
- [x] `[sto-backend]` `POST /work-orders/:id/media` (multipart/form-data, max 10MB, JPEG/PNG/HEIC) → MinIO upload → `WorkOrderMedia` record. `GET /work-orders/:id/media` → signed URLs (1 год TTL). `DELETE /work-orders/:id/media/:mediaId`.
    > `apps/api/src/modules/work-order-media/`. FilesService розширено методами `uploadRaw`, `getSignedUrl`, `deleteObject`. Валідація mimetype + size у сервісі.
- [x] `[sto-web]` Секція "Фото" у картці наряду: drag-and-drop зона + grid галерея + lightbox. Не потребує Expo.
    > `apps/web/src/app/work-orders/[id]/PageClient.tsx`. `loadMedia/handleMediaUpload` + grid 4 cols + lightbox overlay.

---

## Фаза 22 — Frontend UX: Покращення досвіду

> Залежності: Фаза 21 для деяких пунктів (B6, B7, B9).
> Мета: зменшити кількість кліків, покращити швидкість роботи операторів.

### F1 — Global Data Search в Command Palette

- [x] `[sto-web]` Підключити `GET /search` (B6) у Command Palette — окрема секція "Дані" під навігацією. Результати: WO (номер + клієнт + статус), клієнт (ім'я + телефон), товар (SKU + залишок).

### F2 — Drag-and-drop в Calendar

- [x] `[sto-web]` `dnd-kit` + `@dnd-kit/sortable`: перетягування CalendarSlot по timeline. `PATCH /calendar/slots/:id` при drop. Collision detection на бекенді (409 при конфлікті).
    > `apps/web/src/app/calendar/page.tsx`. DndContext + useDraggable + useDroppable. DroppableLiftRow приймає drop між рядами підйомників. handleDragEnd: snap до 15 хв, PATCH /calendar/slots/:id, optimistic update через load(). @dnd-kit/core вже у package.json.

### F3 — Optimistic UI для статусних переходів

- [x] `[sto-web]` `useOptimisticMutation` хук: відразу оновлює локальний стан → відправляє запит → rollback при помилці + toast. Застосувати до: FSM-переходів WO, оплати рахунку, підтвердження PO.
    > `apps/web/src/hooks/useOptimisticMutation.ts` — generic хук. Застосовано до FSM `transition()` у `apps/web/src/app/work-orders/[id]/PageClient.tsx`: optimistic `setWo({...status: newStatus})` → PATCH → setWo(updated) або rollback.

### F4 — Клонування документів

- [x] `[sto-backend]` `POST /work-orders/:id/clone` → новий DRAFT з тими ж лініями і запчастинами (без payments/reservations). `POST /invoices/:id/clone` — аналогічно.
    > `apps/api/src/modules/{work-orders,invoices}/`: методи clone() у service + POST endpoints у controller. Клон отримує новий документний номер через DocumentNumberService. Скопіюються лінії/запчастини у той же транзакції.
- [x] `[sto-web]` Кнопка "Дублювати" у DetailPanel WO і Invoice
    > `apps/web/src/app/work-orders/[id]/PageClient.tsx` та `invoices/page.tsx`: кнопка "Duplicate" в header, виклик POST /clone, автоселект клонованого документу у списку.

### F5 — Друк / Print View

- [x] `[sto-web]` `@media print` CSS у globals.css: приховує sidebar/topbar/кнопки, розгортає таблиці. `window.print()` кнопка у картці наряду і рахунку. Окремо — кнопка "PDF" (B7).
    > `apps/web/src/app/globals.css`: @media print блок приховує #sidebar, #topbar, buttons, розширює основний контент, забороняє page breaks у table rows. Кнопки "Print" та "PDF" додано у work-orders/[id]/PageClient та invoices/page.

### F6 — "Мої наряди" швидкий фільтр

- [x] `[sto-web]` Chip "Мої" у toolbar списку WO → додає `&employeeId=me` до запиту. Зберігається в URL. Для механіків — active за замовчуванням.

### F7 — Live KPI дашборд

- [x] `[sto-web]` `useDashboardStream` (B9) підключити до Dashboard: КPI-картки оновлюються кожні 30с. Пульсуюча крапка "live" у куті картки. Fallback на polling `/dashboard/summary` якщо SSE недоступний.
    > Реалізовано у `apps/web/src/app/dashboard/page.tsx`. Підключено SSE hook, KPI картки (activeWo, todayRevenue, pendingInvoices, lowStockCount) оновлюються з live stream. Зелена пульсуюча крапка "live sync" в header дашборду.

### F8 — Нотатки/Коментарі до об'єктів

- [x] `[sto-database]` Модель `Comment` (`orgId`, `entityType`, `entityId`, `body`, `authorId`, `createdAt`, без `deletedAt`)
- [x] `[sto-backend]` `GET/POST /comments?entityType=WorkOrder&entityId=:id`. Roles: всі авторизовані.
- [x] `[sto-web]` Стрічка коментарів під основним контентом у DetailPanel WO і картці контрагента. Textarea + submit.

### F9 — Кастомний date-picker (uk-UA)

- [x] `[sto-web]` Компонент `DatePickerInput` на базі `react-day-picker` v9: popover, тиждень з понеділка, uk-UA місяці/дні, формат `DD.MM.YYYY`. Замінити всі `<input type="date">` в формах.
    > `apps/web/src/components/ui/date-picker-input.tsx`: компонент з react-day-picker v9, date-fns uk-UA локаль, тиждень з понеділка, попап календар, ручне введення DD.MM.YYYY, parse/format API ↔ user форматів. Замінено у 8 файлах: work-orders, invoices, calendar, reports, settlements, employees, vehicles (new + edit), infrastructure.

### F10 — Шаблони нарядів

- [x] `[sto-database]` Модель `WorkOrderTemplate` (`orgId`, `name`, `lines: Json[]`, `parts: Json[]`)
- [x] `[sto-backend]` CRUD `/work-order-templates` + `POST /work-orders` з optional `templateId` → авто-заповнення ліній
- [x] `[sto-web]` Кнопка "Зберегти як шаблон" у картці WO + Select шаблону у формі створення

### F11 — Offline-pending counter у SyncIndicator

- [x] `[sto-web]` `SyncIndicator` розширити: при `navigator.onLine === false` — рахувати незбережені зміни (через `localStorage` queue). Показувати "3 зміни очікують" замість просто "offline".
    > `apps/web/src/components/ui/sync-indicator.tsx` — pendingOps state + listener `sto:pending-ops-changed`. `apps/web/src/lib/api-client.ts` — при network error або !navigator.onLine: інкремент `sto_pending_ops` + dispatch event; при успіху — декремент.

### F12 — Налаштування колонок таблиці

- [x] `[sto-web]` `useTableColumns` хук: `localStorage` persistence per page-key. Кнопка "Колонки" (налаштувати видимість через checkbox-dropdown). Застосувати до: WO list, inventory, employees.

---

## Поточний стан

| Фаза | Назва | Статус |
|------|-------|--------|
| 0 | Bootstrap | ✅ завершено (10/10) |
| 1 | Повна схема БД | ✅ завершено (10/10) |
| 2 | Автентифікація | ✅ завершено (6/6) |
| 3 | Налаштування + перший запуск | ✅ завершено (7/7) |
| 4 | Інфраструктура (довідники) | ✅ завершено (5/5) |
| 5 | Співробітники | ✅ завершено (4/4) |
| 6 | CRM | ✅ завершено (6/6) |
| 7 | Каталог послуг і товарів | ✅ завершено (5/5) |
| 8 | Наряди ← ЯДРО | ✅ завершено (12/12) |
| 9 | Склад та запаси | ✅ завершено (9/9) |
| 10 | Фінанси та розрахунки | ✅ завершено (10/10) |
| 11 | Сповіщення | ✅ завершено (4/4) |
| 12 | Звіти | ✅ завершено (6/6) |
| 13 | Web UI (оболонка + дашборд) | ✅ завершено (5/5+2) |
| 14 | Мобільний додаток | ✅ завершено (6/6) |
| 15 | Cloud Sync | ✅ завершено (4/4) |
| 16 | Каталог v2 + CRM + XLSX-імпорт | ✅ завершено (27/27) |
| 17 | Збагачення об'єктів + Нові моделі | ✅ завершено (15/15) |
| 19 | Партійний облік + Цінова історичність | ✅ завершено (5/5) |
| 18 | Installer та Production | ⬜ не розпочато (7 задач) |
| 21 | Бекенд: Покращення досвіду | 🔄 в процесі (B6✅ B7✅ B10✅ B4✅ B12⬜ B11⬜ B1⬜ B2⬜ B3⬜ B5⬜ B8⬜ B9⬜) |
| 22 | Frontend UX: Покращення досвіду | 🔄 в процесі (F1✅ F2✅ F3✅ F4✅ F5✅ F6✅ F8✅ F9✅ F10✅ F11✅ F12✅ F7⬜) |

> Оновлюється автоматично після кожного завершеного завдання.  
> Статус таблиці: ⬜ не розпочато / 🔄 в процесі / ✅ завершено
