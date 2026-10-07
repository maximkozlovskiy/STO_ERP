# sto-review — секція: Безпека (§2)

> Частина скіла `sto-review`. Алгоритм і матриця «тип зміни → секції» — у `../SKILL.md`.
> Читати цілком, коли матриця призначила хоч один § цього файла.
> Реальні випадки з детекторами: `../journal/security.md` (шукати, не читати цілком).

### §2 Security

#### §2.1 Auth & Guards

```bash
# Контролери без @UseGuards
grep -rn "@Controller" apps/api/src/ --include="*.controller.ts" | grep -v "UseGuards\|@Public"
# Endpoints без @Roles
grep -rn "@Get\|@Post\|@Patch\|@Delete" apps/api/src/modules/ --include="*.controller.ts" -A1 | grep -v "@Roles\|@Public\|spec" | head -20
```

- [ ] Кожен `@Controller` має `@UseGuards(JwtAuthGuard, RolesGuard)` або явний `@Public()`
- [ ] `@Roles(...)` на кожному методі — без `@Roles` RolesGuard пропускає всіх авторизованих (включно з MECHANIC до cost даних!)
- [ ] `costPrice`, `purchasePrice`, `salePrice`, `priceHistory`, `margin` → тільки `OWNER/ADMIN/STOREKEEPER/ACCOUNTANT`
- [ ] `/setup/init` → перевіряє `isAlreadyInitialized()` (anti-replay)
- [ ] `@CurrentUser()` повертає `{ sub, orgId, role }` — не `any`; у контролерах `user.id`, не `user.sub` (jwt.strategy.ts повертає `{ id, orgId, role }`)
- [ ] Restore-endpoint (`POST :id/restore`) → ролі ІДЕНТИЧНІ delete-endpoint (асиметрія = роль «undo»-ить видалення, яке сама не мала права зробити)

#### §2.2 Tenant Isolation

```bash
grep -rn "findFirst\|findMany\|findUnique\|\.update(\|\.delete(" apps/api/src/modules/ --include="*.service.ts" \
  | grep -v "orgId\|spec\|//.*find" | head -20
```

- [ ] Кожен `findFirst` / `findMany` / `update` / `delete` містить `orgId`
- [ ] **`update`/`updateMany`/`delete`/`deleteMany`({where:{id}}) БЕЗ orgId → A1 tenant-guard кине 500** (клас #747/updateSaved/changePassword/brands/loyalty). Unit-специ мокають Prisma → guard не спрацьовує → баг проходить зелено! Захист: `tenant-guard-static.spec.ts` (статичний CI-детектор, має лишатись зелений). Grep: `grep -rnE "\.(update|updateMany|delete)\(\{\s*where:\s*\{\s*id[,}]" apps/api/src/modules --include=*.service.ts | grep -v spec` → кожен match без orgId/branchId = баг (окрім TENANT_EXEMPT_MODELS). «getX({orgId}) вище» НЕ рятує — guard оцінює кожен виклик окремо. Verify LIVE (curl), не лише спеки
- [ ] `@Param('id')` ніколи без перевірки належності до `orgId`
- [ ] PATCH/UPDATE з FK body-полем (`goodId`, `vehicleId`) → валідує що FK belongs to `orgId`
- [ ] FK у sync push (`customerGarageId`, `liftId`, `employeeId`) → `validateForeignKeys(orgId, ...)`

#### §2.3 Injection & Input Validation

```bash
# Рядкова інтерполяція у queryRaw
grep -rn "queryRaw\|executeRaw" apps/api/src/ --include="*.ts" | grep -v "Prisma\.sql\|plainto_tsquery\|spec"
# ParseUUIDPipe відсутній (@Param)
grep -rn "@Param('id')\|@Param(\"id\")" apps/api/src/ --include="*.controller.ts" | grep -v "ParseUUIDPipe\|spec"
# @Query('...Id') UUID-ідентифікатор БЕЗ ParseUUIDPipe (той самий 500-vs-400 ризик що @Param)
grep -rnE "@Query\((['\"])[a-zA-Z]*[Ii]d\1\s*\)" apps/api/src/ --include="*.controller.ts" | grep -v "ParseUUIDPipe\|spec"
# process.env напряму в сервісах
grep -rn "process\.env\." apps/api/src/ --include="*.ts" | grep -v "main.ts\|spec"
# Enum-DTO поле валідоване @IsString замість @IsEnum → Prisma enum 500
grep -rnE "^\s*@IsString\(\)" apps/api/src/modules --include="*.dto.ts" -A1 \
  | grep -E ":\s*[A-Z][a-zA-Z]*(Type|Status|Direction|Reason|Kind|Mode|Method)\b" | grep -v spec
# Ручна enum-валідація через `in` → прототипні ключі проходять guard → Prisma 500
grep -rnE "\b(in)\s+[A-Z][a-zA-Z]*(Type|Status|Direction|Reason|Kind|Mode|Method)\b" \
  apps/api/src/modules --include="*.controller.ts" --include="*.service.ts" | grep -v spec
```

- [ ] `$queryRaw` — тільки tagged template або `Prisma.sql` (не рядкова інтерполяція)
- [ ] **DTO-поле, чий тип — Prisma enum → `@IsEnum(TheEnum)`, НЕ `@IsString()`.** `@IsString()` пропускає будь-який рядок → значення долітає до enum-колонки у `create/update` → Postgres `invalid input value for enum` → HTTP 500 (не-i18n) замість 400. Стандарт codebase — `@IsEnum` (77+ вжитків: cash.dto `direction`/`reason`, payments.dto). Sample: `CreateExpenseCategoryDto.type` мав `@IsString()`. (Деталі: запис 2026-09-12)
- [ ] `@Param(':id')` → `ParseUUIDPipe` (не `version: '4'` — тести часто мають UUID v0)
- [ ] **`@Query('xxxId')` що потрапляє у Prisma `where: { id }` на `@db.Uuid` → `ParseUUIDPipe`** (optional → `new ParseUUIDPipe({ optional: true })`). Невалідний UUID інакше → `P2023 invalid input syntax for type uuid` → HTTP 500. Sample: cash-shift.controller `open` `@Query('cashRegisterId')`
- [ ] **Ручна enum/whitelist-валідація → `Object.prototype.hasOwnProperty.call(Enum, value)`, НЕ `value in Enum`.** `in` резолвить прототипні ключі: `'constructor' in Enum === true` (так само `toString`/`valueOf`/`hasOwnProperty`/`isPrototypeOf`) → `?type=constructor` проходить guard → Prisma enum-колонка → `P2009 invalid enum` → HTTP 500. Той самий клас що `buildSortOrderBy` hasOwnProperty-fix. Sample: stock-items.controller `movements`. (Деталі: запис 2026-09-13)
- [ ] `process.env` тільки у `main.ts` та конфіг-файлах — сервіси → `ConfigService`
- [ ] Немає `eval()`, `new Function()`, `child_process.exec()`

#### §2.4 Витік даних

```bash
grep -rn "passwordHash\|apiKey\b\|secret\b" apps/api/src/modules/ --include="*.dto.ts"
# Body-borne credential → error/log echo-vector: credential у request BODY (не заголовок) +
# `await response.text()` у Error.message. Провайдер що ЕХО-не запит у 4xx → секрет тече у лог/IntegrationLog.
grep -rnE "body:\s*(JSON\.stringify\()?\{[^}]*(apiKey|token|pin_?[Cc]ode|privateKey|secret|password)" \
  apps/api/src/modules --include="*.ts" | grep -v spec
grep -rnE "throw new Error\(`[^`]*\$\{(await )?(response|res)\.text\(\)" apps/api/src/modules --include="*.ts" | grep -v spec
```

- [ ] `passwordHash`, `apiKey`, `secret` відсутні у `*ResponseDto`
- [ ] `phone`, `edrpou`, `email` у `PULL_FIELD_BLACKLIST` (sync)
- [ ] **Body-borne credential + `response.text()` у Error.message → `redactSecrets(text, [secret])`.** Секрети у ЗАГОЛОВКАХ (Bearer/X-Token) безпечні (не серіалізуємо заголовки). Але credential у request BODY (Nova Poshta `apiKey`, Checkbox `pin_code`/`licenseKey`) + `${await response.text()}` у throw → провайдер що ЕХО-не запит у 4xx зіллє секрет у Error.message → `IntegrationLog.error`. Логер (`IntegrationLogService.wrap`) секрет-сліпий → redaction МУСИТЬ бути на рівні клієнта. `redactSecrets(...)` (`apps/api/src/common/utils/redact.ts` — ігнорує <6-символьні). LiqPay-стиль (body=base64+signature без сирого privateKey) — безпечний. Sample: audit IntegrationLog (1bc106f8)

#### §2.5 BullMQ Queue Safety

```bash
grep -rn "\.add(" apps/api/src/ --include="*.ts" | grep -v "attempts\|spec"
# Прямі HTTP поза чергою
grep -rn "axios\|node-fetch\|https\.request\|http\.request" apps/api/src/modules/ --include="*.ts" | grep -v "spec\|queue\|processor"
# @Process без concurrency (Bull default=1 → серіалізація I/O: 100 jobs × 15s = 1500s стіни)
grep -rn "@Process(" apps/api/src/ --include="*.processor.ts" | grep -v "concurrency\|spec"
# .add() ПІСЛЯ закоміченої $transaction без .catch() — enqueue-fail валить успішну фін-операцію (Redis-down=норма)
grep -rnE "await this\.[a-zA-Z]+[Qq]ueue\.add\(" apps/api/src/modules --include="*.service.ts" -A12 \
  | grep -L "\.catch(" 2>/dev/null; \
grep -rnE "await this\.[a-zA-Z]+[Qq]ueue\.add\(" apps/api/src/modules --include="*.service.ts"
```

- [ ] Кожен `.add()` → `attempts ≥ 10`, `backoff: { type: 'exponential' }`
- [ ] **`.add()` де `job.data` містить секрет (apiKey/token/creds/пароль) → `removeOnFail: N`** (bounded; інакше невдалі jobs осідають у Redis назавжди → секрет живе безстроково + ріст памʼяті). Grep: `grep -rn "\.add(" apps/api/src --include="*.ts" -A8 | grep -iE "apiKey|token|secret|creds|password"` → перевірити `removeOnFail`
- [ ] **Централізований writer job.data → durable-БД (DLQ/audit-таблиця/IntegrationLog) МУСИТЬ редагувати sensitive-ключі перед persist (secrets-at-rest).** Конвенція «секрети не у job.data» НЕ гарантована по ВСІХ чергах: webhooks-черга носить `secret: ep.secret` (підписний ключ) у payload. Якщо будь-який компонент пише `job.data` цілком у постійне сховище (`DeadLetterService.capture` → `payload JSONB`), секрет осяде plaintext назавжди. Fix: рекурсивний **key-based** редактор перед записом (`sanitizePayload`: case-insensitive `/secret|token|password|api[-_]?key|credential|authorization|private[-_]?key|pin[-_]?code|signature/` → `[REDACTED]`; не мутує вхід; обмежений глибиною проти циклів). Відрізняється від `redactSecrets` (value-based, коли значення секрету у скоупі) — тут writer НЕ має значень, тож редагуємо за ІМЕНЕМ ключа. Grep: `grep -rnE "payload:\s*\(?job\.data|payload:\s*job\.data|\.\.\.job\.data" apps/api/src --include="*.ts" | grep -v spec` → кожен persist job.data у БД без sanitize = HIGH. Severity: HIGH
- [ ] **One-off/manual `.add()` (enqueueImmediate/«зробити зараз») у scheduler з repeatable-сіблінгами → `jobId` (дедуп спаму) + `removeOnFail: N`, як repeatable-сіблінги у ТОМУ Ж файлі.** Без `removeOnFail` manual-jobs ростуть у Redis; без `jobId` спам кнопки = дублі. `jobId` ОКРЕМИЙ від repeatable (`<x>-now-<org>`, не `<x>-<org>`). Grep: `grep -rn "\.add(" apps/api/src/modules/**/*.scheduler.ts -A8`. Severity: IMPORTANT
- [ ] ПРРО: `attempts: 288`, `backoff: { delay: 300_000 }` (24 год)
- [ ] SMS: `attempts: 10`, `backoff: { delay: 60_000 }`
- [ ] Процесори → `try/catch` + `throw err` (щоб BullMQ retry спрацював)
- [ ] Ніяких прямих HTTP до зовнішніх API поза чергою
- [ ] **`@Process(name)` → `@Process({ name, concurrency: N })`**: HTTP I/O → `3-5`, DB write → `3`, batch fan-out → `1`
- [ ] **`.add()` ПІСЛЯ закоміченої `$transaction` → `.catch()` (non-blocking), НЕ голий `await`.** Коли фін/доменна операція закомічена (Payment+settlement+FSM), а enqueue йде ПІСЛЯ tx, голий `await queue.add()` при Redis-down кидає → HTTP 500 попри успіх + сутність зависає у `QUEUED` навічно. Offline-first (CLAUDE.md §3). Fix: `.catch(async err => { logger.warn(...); await entity.update({ status → FAILED, error: 'Черга недоступна' }) })` — дзеркалить `loyalty.queueEarn`/`notifications.send`. Severity: IMPORTANT
- [ ] **Зовнішній connection/transport/pool у provider (nodemailer `createTransport`, БД-конект, socket) → `close()`/`dispose()` у `finally`, НЕ лише на success-гілці.** Створити ресурс ДО `try`; закрити у `finally`. Інакше кинутий виклик лишає сокет висіти → `concurrency=N × attempts=10` = десятки leaked-сокетів. Дзеркалить `clearTimeout(timer)` у `finally` (§7 AbortController). Grep: `grep -rnE "createTransport|\.connect\(|new (Pool|Client)\(" apps/api/src/modules --include="*.ts" | grep -v spec` → парний `close()`/`end()`/`dispose()` у `finally`

#### §2.6 Sentry

```bash
head -3 apps/api/src/main.ts | grep "instrument"
grep -n "enabled" apps/api/src/instrument.ts apps/web/src/lib/sentry.ts 2>/dev/null
grep -n "captureException\|status >= 500" apps/api/src/common/filters/http-exception.filter.ts
grep -n "SentryProvider" apps/web/src/app/layout.tsx apps/web/src/app/\(setup\)/layout.tsx 2>/dev/null
```

- [ ] `instrument.ts` — перший import у `main.ts`
- [ ] `enabled: NODE_ENV === 'production' && !!dsn`
- [ ] `captureException` тільки при `status >= 500`; 4xx — ніколи
- [ ] `SentryProvider` у root layout, **відсутній** у setup layout

---
