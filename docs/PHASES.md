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
- [ ] `[sto-backend]` `POST /xlsx/import/purchase-order-lines/:poId` → multipart xlsx → parse рядки (SKU + qty + price) → upsert POLines. Перевіряє що PO у статусі DRAFT і належить orgId.
- [ ] `[sto-backend]` `POST /xlsx/import/stock-document-lines/:docId` → аналогічно для StockDocument (тільки DRAFT).
- [ ] `[sto-backend]` `POST /xlsx/import/work-order-parts/:woId` → аналогічно для WorkOrder (DRAFT/ESTIMATE).
- [ ] `[sto-backend]` `GET /xlsx/templates/po-lines`, `sd-lines`, `wo-parts` → шаблони з колонками SKU, Назва, К-ть, Ціна.

**Фронтенд:**
- [ ] `[sto-web]` `XlsxImportButton` в картці PurchaseOrder (PO лінії), StockDocument (лінії), WorkOrder (запчастини — вкладка).

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
- [ ] `[sto-web]` Skeleton/shimmer анімація в `globals.css` — варіант для темної теми.
- [ ] `[sto-web]` KPI-картки, таблиці, модалки — перевірити canonical токени в dark mode.

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

## Фаза 17 — Installer та Production

> Залежності: Фази 13–16.  
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
| 16 | Каталог v2 + CRM + XLSX-імпорт | ⬜ не розпочато (27 задач) |
| 17 | Installer та Production | ⬜ не розпочато (7 задач) |

> Оновлюється автоматично після кожного завершеного завдання.  
> Статус таблиці: ⬜ не розпочато / 🔄 в процесі / ✅ завершено

---

## Виправлення (Code Review 2026-05-24)

Автоматичний /sto-review виявив і виправив наступні баги:

| Файл | Тип | Проблема | Виправлення |
|------|-----|---------|-------------|
| `apps/api/src/modules/reports/reports.service.ts` | Critical | Hardcoded `+03:00` DST offset — неправильно взимку (+02:00) | Додано `kyivOffsetMs()` через `Intl.DateTimeFormat` |
| `apps/api/src/modules/purchase-orders/purchase-orders.service.ts` | Critical | `receive()` створював `PAYMENT` settlement замість `CHARGE` — борг до постачальника не фіксувався | Змінено `type: 'PAYMENT'` → `type: 'CHARGE'` |
| `apps/api/src/auth/auth.spec.ts` | Test | Тест логіну падав з ForbiddenException: mock `authAccount` не мав `orgId` | Додано `orgId: 'org-1'` в mock |
| `apps/api/src/auth/auth.spec.ts` | Test | Тест refresh падав: ConfigService mock не мав `getOrThrow` | Додано `getOrThrow` в ConfigService mock |
| `apps/web/src/app/purchase-orders/page.tsx` | UI | Кнопка "Підтвердити прийом" не блокувалась під час запиту | Додано `disabled={saving}` |
| `apps/web/src/app/stock-documents/page.tsx` | UI | FSM-кнопки не блокувались під час запиту | Додано `disabled={saving}` на обидві кнопки |
| `apps/web/src/app/setup/page.tsx` | Critical | Кнопка "Далі →" завжди неактивна через конфлікт з `AuthProvider` в root layout | Ізольовано в окремий layout, видалено `useAuth`, додано `checking` step |
