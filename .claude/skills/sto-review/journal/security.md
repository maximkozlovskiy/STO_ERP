# sto-review — журнал: security

> Архів реальних випадків (дата — назва — §N + Сигнал / Grep / Фікс / Severity).
> Не читати цілком — шукати за ключовим словом. Чекліст секції: `../sections/security.md`.

### 2026-10-30 — Спільний блок із кнопками вужчих `@Roles` у картці, яку відкриває ширша роль — §2

**Сигнал:** рев'ю блоку 4 автоматизації. `EmployeeTelegramSubscription` у вкладці «Telegram» картки
працівника отримував `canManage` завжди: коментар казав «картка — лише OWNER / ADMIN», а сторінка
«Співробітники» пускає й RECEPTIONIST (`useRequireAuth(['OWNER','ADMIN','RECEPTIONIST'])`, `GET
employees/:id` теж). Кнопки «Отримати посилання» / «Відписати» кличуть `employees/:id/telegram-*`
з `@Roles('OWNER','ADMIN')` → приймальник бачив кнопки й отримував 403. **Grep:** для нового блоку
з `canManage` / `canEdit` — `grep -rn "<Блок" apps/web/src` → кожне місце вставки → `useRequireAuth`
сторінки, що відкриває картку, проти `@Roles` endpoint-ів кнопок. **Фікс:** блок сам звужує
`canManage` за роллю (`EMPLOYEE_LINK_ROLES`), RECEPTIONIST бачить лише статус; тест
`EmployeeTelegramSubscription.test.tsx` (мутація перевірена). **Severity:** IMPORTANT

### 2026-10-30 — Повторюваний job довший за `every` перекривається сам із собою — §2.5

**Сигнал:** опитування Telegram-бота — `repeat: { every: 3_000 }`, `@Processor({ concurrency: 4 })`,
тайм-аут HTTP 10 с. BullMQ 5 ставить наступну ітерацію в момент, коли поточна стає АКТИВНОЮ
(`worker.js` → `updateRepeatableJob` у `nextJobFromJobData`), тож повільний тік перекривався наступним
у сусідньому слоті: обидва з тим самим offset — бот відповідав на `/start` двічі. «Ідемпотентна
обробка» рятувала дані, але не повідомлення назовні.
**Grep:** `grep -rn "every:" apps/api/src/modules --include="*.scheduler.ts"` → для кожного: процесор
цієї черги з `concurrency > 1` і можливою тривалістю job-а > `every` → захист від перекриття.
**Фікс:** `Set` організацій із тіком у польоті в сервісі (`TelegramBotService.poll` → `pollOnce`);
тест — два одночасні `poll` при незавершеному `getUpdates`.
**Severity:** IMPORTANT — дубль зовнішніх повідомлень.

### 2026-10-30 — Формат секрету перевіряє лише DTO, а в клієнт є інший вхід — §2.3

**Сигнал:** токен бота підставляється в ШЛЯХ запиту (`/bot<token>/getMe`); формат перевіряв лише
`ConnectTelegramBotDto`, а загальний `POST /notifications/providers/:code/verify` (код `telegram-bot`)
передавав у той самий клієнт довільний `apiKey` з тіла.
**Grep:** `grep -rn "\${[a-zA-Z.]*\(token\|apiKey\)[a-zA-Z.]*}/" apps/api/src/modules --include="*.ts" | grep -v spec`
→ секрет у шляху URL: перевірка формату в самому клієнті, не лише в DTO одного маршруту.
**Фікс:** `TELEGRAM_BOT_TOKEN_RE` у `telegram-api.client.ts`, `call()` відмовляє до `fetch` (401);
DTO імпортує той самий регекс.
**Severity:** IMPORTANT — інваріант «формат до підстановки в шлях» обходився другим маршрутом.

### 2026-10-25 — Upload-ендпоінт довіряє клієнтському `part.mimetype` — §2.3.1

**Сигнал:** безпековий Етап 4 захистив `files.controller` (тип за магічними байтами), але
сусідній upload — медіа наряду `/work-orders/:id/media` → `work-order-media.service.upload` —
лишився на `mimetype = part.mimetype` з контролера. Клієнт бреше `Content-Type` + розширенням
(.exe/.html → .png, multipart `image/png`) → whitelist mime І whitelist розширень проходять,
файл лягає в MinIO й DB з брехливим `Content-Type`, signedUrl роздає його під тим типом
(content-spoofing / stored XSS). Whitelist розширень — ДРУГИЙ бар'єр, не заміна детекту за байтами.
**Grep:** `grep -rn "part\.mimetype" apps/api/src/modules --include="*.ts" | grep -v spec` →
кожен match перевірити проти `detectMimeFromBuffer`/`isDetectedImage`; і хто пише `'Content-Type'`
/ `mimeType:` у сховище/DB — бере КАНОНІЧНИЙ тип із сигнатури, не клієнтський.
**Фікс:** у `work-order-media.service.upload` — `detectMimeFromBuffer(file.buffer)` → лише
`isDetectedImage || application/pdf`, інакше 400; у `uploadRaw` і `workOrderMedia.create` — канонічний
mime. Регресійні кейси: HTML-байти з заявленим image/png → 400; збережений mime = канонічний (не клієнтський).
**Урок:** коли хардениться ОДИН upload-ендпоінт — у ТОМУ Ж проході пройти всі сусідні (grep `part.mimetype`).
**Severity:** CRITICAL

### 2026-10-24 — SSRF: текстова `validatePublicUrl` не ловить DNS-rebinding — §2.3/§2.4

**Сигнал:** клієнт зовнішнього API або write-path (збереження адреси провайдера) валідує
`apiUrl` лише текстом (`validatePublicUrl`) → публічне ім'я, що резолвиться у приватну адресу
(`127.0.0.1.nip.io`, власний DNS-запис, DNS-rebinding) проходить, бо текст легітимний. Resolved-
перевірка (після DNS) потрібна І при збереженні (400), І перед КОЖНИМ запитом (defense-in-depth,
бо адреса могла перерезолвитись між save і delivery — webhooks-процесор, scheduled polling).
**Grep:** `grep -rn "validatePublicUrl\b" apps/api/src/modules --include="*.ts" | grep -v "Resolved\|spec"`
→ кожен збіг у клієнті провайдера / write-path, що бере адресу ВІД КОРИСТУВАЧА (не хардкод-константа
на кшталт `NBU_URL`/`ESPUTNIK_BASE`), має бути `await validatePublicUrlResolved(url, lookup)`.
**Фікс:** `validatePublicUrlResolved(raw, lookup)` (`common/utils/url-guard.ts`): резолвить ім'я й
ганяє КОЖНУ адресу через блок-лист. `HostLookup` інжектиться спільним DI-токеном `HOST_LOOKUP`
(глобальний `CommonModule`, дефолт `lookupAllAddresses`) — бо перевірка викликається з HTTP-шляху,
де 4-й аргумент не передати; тест-модуль підставляє фейк (`common/testing/host-lookup.ts`), тож
unit/contract не ходять у мережу (усуває flaky `settings.contract.spec`, що резолвив `api.checkbox.ua`).
Перевірити wiring: кожен Nest-test-module, що реєструє SSRF-consumer РЕАЛЬНИМ провайдером (не
`useValue`-мок, не `new X(fakeLookup)`), має `{ provide: HOST_LOOKUP, useValue: publicHostLookup }`
або імпорт `@Global CommonModule`. Delivery-гілка config-блоку (SSRF-кандидат) — НЕ re-throw
(лог FAILED + `return`): BullMQ-retry на config-помилку безглуздий.
**Severity:** CRITICAL (SSRF у внутрішню мережу / cloud-metadata) для write+request; IMPORTANT — flaky-fix.

### 2026-05-30 — `@Param('key')` без validation — нескінченний рядок у Prisma where — §2.3

**Сигнал:** `@Param('key') key: string` (не uuid) → `prisma.X.findFirst({ where: { key } })`. ValidationPipe не валідує `@Param`.
**Фікс:** guard `ensureValidKey(key)` що кидає `BadRequestException` при `length > N` (узгоджено з MaxLength у DTO), викликається на початку handler.
**Severity:** IMPORTANT — DoS vector + log pollution; порушує defence-in-depth.

### 2026-05-30 — Soft-delete update без orgId у where → race-window для cross-session reuse — §2.2/§5

**Сигнал:** `findFirst({ id, orgId })` перевірка → потім `update({ where: { id } })` БЕЗ orgId у where.
**Фікс:** `updateMany({ where: { id, orgId, ...filters } })` + `findFirstOrThrow({ where: { id, orgId }, include })` для повернення relations.
**Severity:** IMPORTANT — defence-in-depth gap, race-window для multi-session writes.

### 2026-09-17 — DLQ/audit-writer персистить job.data з секретом у БД plaintext — §2.5

**Сигнал:** централізований writer (`DeadLetterService.capture`) пише `payload: job.data` цілком у durable-таблицю (`dead_letter_jobs.payload JSONB`). Конвенція «секрети не у job.data» НЕ по всіх чергах: webhooks-черга носить `secret: ep.secret` (підписний ключ) → секрет осідає at-rest назавжди.
**Grep:** `grep -rnE "payload:\s*\(?job\.data|\.\.\.job\.data" apps/api/src --include="*.ts" | grep -v spec` → кожен persist job.data у БД без sanitize.
**Фікс:** рекурсивний key-based `sanitizePayload()` перед записом (case-insensitive `secret|token|password|api[-_]?key|credential|authorization|private[-_]?key|pin[-_]?code|signature` → `[REDACTED]`; не мутує вхід; глибина-cap проти циклів). Відмінність від value-based `redactSecrets` — writer не має значень секретів, тож редагуємо за ІМЕНЕМ ключа.
**Severity:** HIGH — secrets-at-rest (підписний ключ вебхука у БД відкритим текстом).

### 2026-09-17 — TENANT_EXEMPT-модель: findFirst({id,orgId})→update({where:{id}}) без orgId — §2.2

**Сигнал:** DLQ `resolve()` робив orgId-гейт через `findFirst({id,orgId})`, потім `update({where:{id}})` БЕЗ orgId. Модель TENANT_EXEMPT → guard не додає scope автоматично (тому в ALLOWLIST) → race-вікно на крос-tenant запис між check і write.
**Фікс:** `updateMany({ where: { id, orgId } })` + `count===0 → 404` — orgId у самому write-where. Дзеркалить документований patch-стандарт (запис 2026-05-30).
**Severity:** IMPORTANT — defence-in-depth gap для exempt-моделей (guard їх НЕ страхує).

### 2026-05-30 — Buffer.buffer as ArrayBuffer ігнорує byteOffset/byteLength → читання з пулу — §2.3/§1

**Сигнал:** `library.load(buffer.buffer as ArrayBuffer)` (ExcelJS/jszip). `Buffer.allocUnsafe` (multipart uploads) — view над пулом → `.buffer` повертає весь пул.
**Grep:** `grep -rn "\.buffer as ArrayBuffer" apps/api/src` — перевірити byteOffset гарантії.
**Фікс:** helper `toArrayBuffer(buf) { return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer; }`.
**Severity:** CRITICAL — silent data corruption на uploaded xlsx (лише на проді коли pool заповнений; dev часто byteOffset=0).

### 2026-05-30 — SSE/EventSource + global ThrottlerGuard → reconnect-loop вичерпує rate-limit — §2/§4

**Сигнал:** `@Sse()` endpoint + global `ThrottlerGuard` без `@SkipThrottle()`; frontend auto-reconnect + native EventSource reconnect.
**Фікс:** `@SkipThrottle()` на SSE-endpoint (опційно `@Throttle({ default: { ttl: 60_000, limit: 5 } })`).
**Severity:** IMPORTANT — degradation при network instability, потенційний DoS за NAT.

### 2026-05-30 — Cache-Control: public на JWT-захищеному endpoint → cross-tenant витік через shared cache — §2/§2.2

**Сигнал:** `@Header('Cache-Control', 'public, max-age=N')` на endpoint з `@UseGuards(JwtAuthGuard, RolesGuard)` → proxy/CDN шарить per-tenant дані.
**Grep:** `grep -rn "Cache-Control.*public" apps/api/src/modules --include="*.controller.ts"`.
**Фікс:** `Cache-Control: private, max-age=N, stale-while-revalidate=M`.
**Severity:** CRITICAL — cross-tenant data leak при невірно налаштованому proxy.

### 2026-05-31 — Inline lambda decorator повторений 10+ разів — §2.3/§1 DRY

**Сигнал:** `@Transform(({ value }) => value === '' ? undefined : value)` 20+ разів через grep.
**Grep:** `grep -rn "@Transform\b" apps/api/src/modules/ --include="*.dto.ts" | wc -l` → якщо > 10.
**Фікс:** `apps/api/src/common/transforms/<name>.ts` named export → `@Transform(emptyToUndefined)`; прибрати dead imports.
**Severity:** IMPORTANT — hot-reload + readability; кожна нова DTO копіює застарілу версію.

### 2026-05-31 — Controller з `@UseGuards` без `@Roles` на методах → RolesGuard no-op — §2.1

**Сигнал:** `@Controller` має `@UseGuards(JwtAuthGuard, RolesGuard)`, але метод без `@Roles(...)`. `RolesGuard` повертає `true` коли `required.length === 0`.
**Grep:** `grep -B5 "@Get\|@Post\|@Patch\|@Delete" *.controller.ts | grep -v "@Roles\|@Public"`.
**Фікс:** explicit `@Roles(...)` з повним переліком або `@Public()`.
**Severity:** IMPORTANT — інваріант "RolesGuard перевіряє" порушений → майбутній field-add = silent privilege escalation.

### 2026-06-02 — Per-param `@Query('x')` без DTO → cap-less pagination + missing validation — §2.3/§4

**Сигнал:** `@Query('page') page = '1', @Query('limit') limit = '50'` (string defaults) + `Number(page)` у handler; немає cap на limit.
**Grep:** `grep -rn "@Query('[a-z]" apps/api/src/modules --include="*.controller.ts"`.
**Фікс:** `*QueryDto` як works/goods (`@Type(() => Number) @IsNumber() @Min(1) page = 1`, `@IsPositive() @Max(200) limit = 50`).
**Severity:** IMPORTANT — DoS вектор + inconsistency з сусідніми модулями.

### 2026-06-14 — Bulk lookup без UUID-validation на `@Query('ids')` → 500 замість 400 — §2.3

**Сигнал:** `@Query('ids') ids: string` → `ids.split(',')` → `findMany({ where: { goodId: { in } } })`. Postgres `@db.Uuid` відхиляє non-UUID → 500 non-i18n. `ParseUUIDPipe` не працює на split-out items.
**Grep:** `grep -rnE "@Query\('ids'\)" apps/api/src/modules --include="*.controller.ts"`.
**Фікс:** `const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;` → після split `const invalid = ids.find(id => !UUID_RE.test(id)); if (invalid) throw BadRequestException`. `ids?: string` (optional).
**Severity:** IMPORTANT — 500 замість 400; Prisma error у Sentry.

### 2026-06-17 — Нове `costPrice`/`purchasePrice` у nested DTO без role gate — §2.1

**Сигнал:** feat додає `costPrice/purchasePrice/margin/batchCostPrice` у nested DTO (`WorkOrderPartResponseDto`), а parent endpoint дозволяє `MECHANIC/RECEPTIONIST`. `toPartDto` мапить безумовно → field-level leak (RolesGuard на endpoint пропускає).
**Grep:** `grep -rnE "(costPrice|purchasePrice|margin|batchCostPrice)\??:" apps/api/src/modules --include="*.dto.ts"`; `grep -rn "canSeeCostPrice\|COST_PRICE_VISIBLE_ROLES" apps/api/src/modules`.
**Фікс:** `const COST_PRICE_VISIBLE_ROLES = new Set(['OWNER','ADMIN','STOREKEEPER','ACCOUNTANT']); const canSeeCostPrice = r => !!r && COST_PRICE_VISIBLE_ROLES.has(r);` → `toPartDto(part, userRole)` → `costPrice: canSeeCostPrice(userRole) ? Number(...) : undefined`. Internal callers fail-closed.
**Severity:** CRITICAL — financial data leak до MECHANIC/RECEPTIONIST; tsc + ручний тест мовчать.

### 2026-09-06 — queue.add() ПІСЛЯ закоміченої tx без .catch() → 500 на успішній операції + stuck QUEUED — §2.5/§10

**Сигнал:** доменна/фінансова операція комітиться у `$transaction` (Payment+settlement+FSM), сутність отримує статус `QUEUED`/pending ВСЕРЕДИНІ tx, а enqueue робочого job-а йде голим `await this.Xqueue.add(...)` ПІСЛЯ commit — без `.catch()`. При Redis-down (нормальний offline-стан) `.add()` кидає → HTTP 500 попри те що гроші/статус вже закомічені, І сутність зависає у `QUEUED` навічно (жодного job-а → processor ніколи не переведе у DONE/FAILED). Сусідні enqueue (`loyalty.queueEarn`, `notifications.send`) вже non-blocking через `.catch()`. (ПРРО Крок 1: `checkboxQueue.add` для фіскального чеку.)
**Grep:** `grep -rnE "await this\.[a-zA-Z]+[Qq]ueue\.add\(" apps/api/src/modules --include="*.service.ts"` → чи виклик у ланцюгу `.catch(...)`; якщо enqueue ПІСЛЯ `$transaction` і голий — прапор.
**Фікс:** `.catch(async err => { logger.warn('enqueue failed: ...'); await this.prisma.entity.update({ where: { id, orgId }, data: { status: TERMINAL_FAILED, error: 'Черга недоступна' } }).catch(() => undefined) })` — знімає stuck-статус + не валить успішну операцію. Плюс `removeOnFail: N`. Дзеркалить offline-first (CLAUDE.md §3).
**Severity:** IMPORTANT — offline-first порушення (система стоїть без Redis) + lifecycle hole (навічно QUEUED); TS зелений, видно лише при Redis-down.

### 2026-09-06 — query-string фільтр каститься `as EnumType` без валідації → Prisma 500 — §2.3/§6

**Сигнал:** `@Query('x') x?: string` (raw string, ValidationPipe не чіпає per-param query без DTO) каститься прямо у Prisma enum: `where.x = opts.x as Prisma...['x']`. Довільне значення (`?fiscalStatus=garbage`, `?status=FOO`) доходить до Prisma → відхиляється → HTTP 500 (не-i18n, шум у Sentry) замість порожнього/400.
**Grep:** `grep -rnE "where\.[a-zA-Z]+ = opts\.[a-zA-Z]+ as Prisma" apps/api/src/modules --include="*.service.ts"`; `grep -rnE "as Prisma\.[A-Za-z]+WhereInput\['" apps/api/src/modules --include="*.service.ts"`.
**Фікс:** `const X_VALUES = new Set<string>(Object.values(SomeEnum));` (enum-driven, з `@prisma/client`) → `if (opts.x && X_VALUES.has(opts.x)) where.x = opts.x as ...;` — невідоме ігнорується.
**Severity:** IMPORTANT — 500 замість 400/порожнього; тривіальний DoS/шум через ручний query-параметр.

### 2026-09-07 — legacy/default-гілка резолвера повертає конфіг ЧУЖОГО kind (не-exhaustive if/else) — §2/§4

**Сигнал:** резолвер конфіга (`legacyFromBranchSettings`/`resolveX`) має `if (kind === 'FISCAL') {...}` а далі БЕЗУМОВНИЙ «дефолт»-блок (PAYMENT), який виконується для будь-якого не-FISCAL kind. Коли додається новий kind (`ProviderKind += DELIVERY`), він тихо потрапляє у PAYMENT-гілку → повертає креди/провайдера ЧУЖОГО kind (monobank для DELIVERY). Латентно маскується коли consumer робить `registry.get(wrongProvider)=null`.
**Grep:** `grep -rnE "if \(kind === '[A-Z]+'\)" apps/api/src/modules --include="*.service.ts" -A30` → для КОЖНОГО enum-значення явна гілка АБО explicit `return null`; фінальний блок не має бути «catch-all». Тригер: enum з `ADD VALUE` у diff + резолвер що читає той enum.
**Фікс:** явний guard перед «дефолт»-блоком: `if (kind !== 'PAYMENT') return null;` — або exhaustive `switch (kind)` з `default: return null`.
**Severity:** IMPORTANT — cross-kind config leak; tsc + happy-path мовчать, спливає лише при новому enum-значенні.

### 2026-09-09 — one-off `.add()` без jobId/removeOnFail поруч із repeatable-сіблінгами — §2.5

**Сигнал:** scheduler має `enqueueRepeatable`/`reschedule` `.add()` з `jobId`+`removeOnFail: N`, але «manual»/«зробити зараз» `enqueueImmediate` `.add()` у тому ж файлі — БЕЗ обох. job.data без секрета (§2.5 secret-rule не спрацьовує), але: без `removeOnFail` невдалі manual-jobs ростуть у Redis; без `jobId` спам кнопки = дублі. (nbu-fetch.scheduler.ts `enqueueImmediate`.)
**Grep:** `grep -rn "\.add(" apps/api/src/modules/**/*.scheduler.ts -A8` → якщо співіснують `.add()` з `jobId`+`removeOnFail` і `.add()` без них — прапор.
**Фікс:** `jobId: '<x>-now-<org>'` (ОКРЕМИЙ від repeatable `<x>-<org>` — інакше конфлікт з cron-записом) + `removeOnFail: 200` (дзеркалить сіблінги).
**Severity:** IMPORTANT — Redis-ріст (unbounded failed-set) + duplicate manual fan-out; tsc зелений.

### 2026-09-12 — enum-DTO поле валідоване як @IsString замість @IsEnum → Prisma enum 500 — §2.3

**Сигнал:** optional/required DTO-поле, чий TS-тип — Prisma enum (`type?: ExpenseCategoryType`), декороване `@IsString()` (або лише `@IsOptional()`). `@IsString` пропускає будь-який рядок → значення долітає до enum-колонки у `create/update`.
**Grep:** `grep -rnE "^\s*@IsString\(\)" apps/api/src/modules --include="*.dto.ts" -A1 | grep -E ":\s*[A-Z][a-zA-Z]*(Type|Status|Direction|Reason|Kind|Mode|Method)\b"`.
**Фікс:** `@IsEnum(TheEnum)` замість `@IsString()` (стандарт codebase — 77+ вжитків: cash.dto `direction`/`reason`, payments.dto тощо).
**Severity:** IMPORTANT — `POST {type:"FOO"}` → Postgres `invalid input value for enum` → HTTP 500 (не-i18n) замість 400; tsc зелений. Sample: CreateExpenseCategoryDto.type (0fc2260d).

### 2026-09-13 — ручна enum-валідація через `in`-оператор пропускає прототипні ключі → Prisma 500 — §2.3

**Сигнал:** guard `if (type && !(type in SomeEnum)) throw new BadRequestException(...)` над query/param-значенням, що потім каститься у Prisma `where`. `in` перевіряє й прототипні ключі: `'constructor' in StockMovementType === true` (аналогічно `toString`/`valueOf`/`hasOwnProperty`/`isPrototypeOf`) → `?type=constructor` проходить guard.
**Grep:** `grep -rnE "\b(in)\s+[A-Z][a-zA-Z]*(Type|Status|Direction|Reason|Kind|Mode|Method)\b" apps/api/src/modules --include="*.controller.ts" --include="*.service.ts" | grep -v spec`.
**Фікс:** `Object.prototype.hasOwnProperty.call(SomeEnum, value)` замість `value in SomeEnum` (той самий клас, що `buildSortOrderBy` hasOwnProperty-fix у pagination.ts). Контракт-тест на `?type=constructor` → 400.
**Severity:** IMPORTANT — `?type=constructor` → Prisma enum-колонка → `P2009 invalid enum` → HTTP 500 замість 400; звичайний garbage (`?type=НЕВІДОМО`) 400-ить коректно, тож unit-тест з нормальним garbage ховає баг. Sample: stock-items.controller `movements` (71f01134).

### 2026-10-09 — Prisma `contains` не екранує `%` і `_` — §2.3

**Сигнал:** новий пошук `q` на п'яти списках (`stock-documents`, рухи складу, оплати, банк, каса) передавав текст користувача просто в `contains`. У завданні на review стояло «Prisma екранує — підтвердь»; перевірка на dev-базі спростувала: SQL — `"name" ILIKE ('%' || $1 || '%')`, параметр іде як є. `contains: '%'` і `contains: '_'` повернули всі рядки таблиці товарів, після `escapeLike` — нуль, як і `String.includes` по тих самих назвах.
**Grep:** `grep -rnE "contains: (search|q|query|term|dto\.|opts\.|filters\.)" apps/api/src/modules --include="*.service.ts" | grep -v "escapeLike\|spec"`.
**Фікс:** `const contains = { contains: escapeLike(search), mode: 'insensitive' as const }` — `escapeLike` подвоює `\` і ставить `\` перед `%` та `_` (зворотна коса — символ екранування LIKE за замовчуванням). У тесті — запит із `%_` і очікуваний екранований рядок.
**Як перевіряти твердження «бібліотека це робить сама»:** не з пам'яті й не з документації — увімкнути `log: [{ emit: 'event', level: 'query' }]` на PrismaClient, виконати запит і прочитати SQL; поруч контроль — той самий запит із заздалегідь відомою відповіддю.
**Severity:** IMPORTANT — неточний пошук і дорогий шаблон; не витік (tenant-умова не послаблюється). Старі пошуки (товари, контрагенти, наряди тощо) лишились без екранування — окремий прохід.

### 2026-10-15 — Список у query через кому губить повторений параметр — §2.3

**Сигнал:** sync додав у `GET /invoices` фільтр `statuses` з `@Transform`, що розбирає лише рядок
(`typeof value === 'string' ? value.split(',') : undefined`). Fastify віддає `?statuses=PAID&statuses=DRAFT`
масивом → трансформ повертає `undefined` → `@IsOptional` пропускає → відбору немає. Наживо (збірка
`955ae996`): `statuses=PAID,DRAFT` — 601 рахунок, `statuses=PAID&statuses=DRAFT` — 200 і всі 1614.
Контракт-тест перевіряв лише форму через кому, тож був зелений.
**Grep:** `grep -rn -A6 "@Transform" apps/api/src --include="*.dto.ts" | grep "split("` → у кожного збігу
є гілка `Array.isArray(value)`.
**Фікс:** `(Array.isArray(value) ? value : [value]).flatMap(v => typeof v === 'string' ? v.split(',') : [v])`
→ trim → порожні геть; не-рядок лишається в масиві, і `@IsEnum({ each: true })` дає 400 (fail-closed).
Взірець, що вже так робив, — `types` у `counterparties.dto.ts`. Тест контракту — з повтором параметра.
**Severity:** IMPORTANT — фільтр мовчки зникає; клієнт, що будує запит через `URLSearchParams.append`,
отримує зайві записи (у пікері рахунку — рахунки, які не можна оплатити). Sample: `invoices.dto.ts` (5d2df581).

### 2026-10-16 — Звужена за роллю відповідь, а спільний кеш вкладки зберігає повну — §2.4

**Сигнал:** `GET /employees` для MECHANIC віддає лише id та ім'я (`EmployeeLookupListDto`), але
картка й сторінка наряду писали в `cache:employees` (`sessionStorage`) рядки, як прийшли. Під
власником це повні `EmployeeResponseDto` (телефон, e-mail, `userId`); вихід кеш не чистить, тож
механік, що входить у тій самій вкладці, мав ці поля в `sessionStorage` (видно в devtools).
**Grep:** `grep -rn "setCache('cache:" apps/web/src --include="*.ts*"` → звірити ключ з ендпоінтами,
що мають `oneOf`/звужений DTO за роллю.
**Фікс:** у кеш — лише поля звуженої форми (`executorCacheRows` у `lib/work-order-mechanics.ts`),
тест на відсутність зайвих полів. Очищення `cache:*` при виході — окреме рішення власника.
**Severity:** IMPORTANT

### 2026-10-18 — Закупівельна ціна нової сутності під іншою назвою — §2.1

**Сигнал:** списки купівлі віддавали `expectedPrice` (очікувана закупівельна ціна позиції) у
`GET /purchase-list-items`, `GET /purchase-lists/:id`, `POST /purchase-lists/from-work-order`
(RECEPTIONIST) і `GET /purchase-list-items/by-work-order/:id` (MECHANIC), хоча `Good.purchasePrice`
цим ролям маскується (goods.service `PURCHASE_PRICE_VISIBLE_ROLES`). Чекліст §2.1 перелічував
знайомі імена (`costPrice`, `purchasePrice`) — нове поле під іншою назвою пройшло.
**Grep:** `git diff <base> -- apps/api/src | grep -nE "^\+.*(expected|purchase|unit|last)[A-Za-z]*(Price|Cost)\b"`
→ для кожного поля відповіді звірити ролі ендпоінтів.
**Фікс:** `maskItemCost(items, role)` у мапері (fail-closed: невідома роль → `null`), роль із
`@CurrentUser()` у сервіс. **Severity:** IMPORTANT

### 2026-10-18 — сталий jobId + removeOnFail: N блокує повтор — §2.5

**Сигнал:** `supplier-place-${poId}`, `supplier-catalog-${connectionId}` з `removeOnFail: 200`: після FAILED
«Відправити в API» і sweep викликали `add()` з тим самим id — BullMQ 5 (`addStandardJob`) повертав наявну
failed-задачу, нова не ставилась, замовлення висіло QUEUED.
**Grep:** `grep -rn -A8 "jobId:" apps/api/src/modules --include="*.ts" | grep -B6 "removeOnFail: [0-9]"`
**Фікс:** `removeOnFail: true` для перепостановлюваних задач або `getJob(id)?.remove()` перед `add`.
**Severity:** CRITICAL

### 2026-10-23 — Скидання ключа при зміні адреси обходиться через legacy-fallback — §2

**Сигнал:** 801d8ab1 скинув креди в `upsertConfig` при зміні `apiUrl`, але `resolveActive` для enabled-конфіга БЕЗ кредів брав legacy-ключ з `BranchSettings` і віддавав його з `apiUrl: cfg.apiUrl ?? legacy.apiUrl`. `PATCH /fiscal-providers/branch/:id {provider:'checkbox', apiUrl:'https://чужий', enabled:true}` (DTO приймає `enabled`, guard кредів є лише в `activate()`) — і наступне відкриття зміни несло legacy-ключ ліцензії на чужий сервер.
**Grep:** `grep -n "apiUrl: cfg.apiUrl ??" apps/api/src/modules/payments/provider-config.service.ts`
**Фікс:** legacy-ключ лише для своєї адреси: `if (cfg.apiUrl && !sameApiUrl(cfg.apiUrl, legacy.apiUrl)) return null`.
**Severity:** CRITICAL — обхід security-фіксу, write-only секрет виноситься без знання ключа.

### 2026-10-31 — Читання відповіді після коміту під ключем ідемпотентності — §2

**Сигнал:** `SupplierPaymentsService.createAndConfirm` (`POST /supplier-payments/pay`, Г2) проводив оплату в
транзакції, а відповідь брав `this.findOne()` уже після коміту. Збій цього читання = виняток обробника →
`IdempotencyInterceptor` знімає резервацію ключа → повтор вікна «Оплатити» з тим самим ключем створює й
проводить другу оплату (гроші з каси двічі).
**Grep:** `grep -rn -B2 -A12 "RequireIdempotencyKey()" apps/api/src/modules --include="*.controller.ts"` →
у методі сервісу після `await this.prisma.$transaction(` немає `this.findOne(`.
**Фікс:** читати рядок із `include` усередині тієї ж транзакції й віддавати `toDto` (тест
`supplier-payments.pay.spec.ts` «відповідь читається В транзакції», доведено мутацією).
**Severity:** IMPORTANT. Не виправлено (той самий клас, ширше за Г2): `POST /cash-registers/:id/operations`
читає рядок каси `readRowOf` ПІСЛЯ коміту оплати (клієнта й постачальнику) — збій читання звільняє ключ, і
повтор проведе другу оплату. `confirm` чернетки безпечний: повтор упирається в CAS статусу (400).
