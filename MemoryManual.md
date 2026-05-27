# MemoryManual — STO ERP

> Живий документ. Оновлюється автоматично після кожного git commit.
> Читається на початку кожної сесії разом із `CLAUDE.md` і `.claude/memory/`.
> Мета: швидка орієнтація в коді та оптимізація роботи Claude Code.

---

## Останній commit

```
f11f028 fix(tester): cycle-2 — booking public widget, webhooks SSRF, inspection DoS
d484866 docs(memory): record /sto-review cycle-1 gotchas (commit e4ce8b1)
e4ce8b1 fix(review): cycle-1 — @CurrentUser sub→id, loyalty race, migrations trgm defense
```

Дата: 2026-05-27

## Поточний стан проєкту
```
TypeScript:      ✅ 0 errors        (apps/web + apps/api + shared)
Unit:            ✅ 164/164 passed  (18 файлів)
Contract:        ✅ 18 файлів covered
Property-based:  ✅ inventory + settlements + work-orders.fsm invariants (3 файли)
Components:      ✅ 139/139 passed  (13 файлів — Button, Modal, Select, CommandPalette, etc.)
E2E (Playwright): ⏭ skipped (dev сервер offline на момент запуску)
Build:           ✅ @sto/api build OK (webpack 14.7s)
Tester cycle-2:  9 багів виправлено (3 CRITICAL, 1 HIGH, 2 MEDIUM, 3 LOW)
```

### Gotcha — /sto-tester cycle-2 (2026-05-27, commit f11f028, bugs #111-#119)

- **Public widget pages ЗА ЖОДНИХ умов не повинні використовувати `apiFetch`** (Bug #111, booking/page.tsx). `apiFetch` на 401 робить `window.location.replace('/login')` що смертельно для публічної сторінки (`/booking` був у PUBLIC_ROUTES але викликав auth-guarded `/branches`). Канон: для будь-якої сторінки у TopShell `PUBLIC_ROUTES` — створити окремий `publicFetch` хелпер (звичайний `fetch` без token + без redirect) АБО окремий public endpoint `/api/booking/branches` під @Public (без JwtAuthGuard). Перевірити: grep `apiFetch` в усіх сторінках з PUBLIC_ROUTES — `/login`, `/setup`, `/booking`, `/403`. Якщо знаходить — це BUG.

- **`service['prisma']` bracket access обходить TS private** (Bug #112, booking.controller.ts). TS private — compile-time only; `service['prisma']` працює на рантаймі і компайл-чек проходить. Це anti-pattern бо: (1) circumvents API design (контролер мав би використовувати public метод сервісу), (2) делає рефакторинг ризиковим (приватний `prisma` field — internal contract, при заміні на DI чи repository pattern зламається). Канон: ВСІ controller→data звернення йдуть ТІЛЬКИ через public методи сервісу. grep `service\['` або `\['prisma'\]` — code smell, потребує refactor у service-level public API.

- **Soft-deleted `findFirst({ where: { id } })` без `deletedAt: null` — повторюваний шаблон** (Bug #112). Це Bug #95-pattern (Soft-deleted FK pre-check на clone), але у новому контексті — public lookups. Канон: ЖОДЕН `findFirst`/`findUnique`/`findMany` на soft-deletable моделі НЕ обходиться без `deletedAt: null` (виняток — admin tools/audit). grep `findFirst.*where:\s*\{\s*id` без `deletedAt` — кандидат на bug.

- **UTC "T...Z" hardcode для робочих годин — DST-naïve booking slots** (Bug #113, booking.service.ts). `new Date('2026-05-27T09:00:00.000Z')` = 12:00 Київ влітку, 11:00 Київ взимку. Канон для робочих годин: ISO offset з timezone-aware обчислення. `kyivOffsetForDate(date)` — мінімальний хелпер через `Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Kyiv' })` + `toLocaleString` round-trip обчислює `+02:00`/`+03:00`. Не покладатись на `new Date()` (server-local) і не на `Z` (UTC). Це 3-й DST-related баг у проекті (B8 followup processor, dst_kyiv feedback, тепер booking).

- **`@IsUrl({ require_tld: false })` = SSRF vector** (Bug #114, webhooks.dto.ts). `require_tld: false` дозволяє `localhost`, `192.168.*`, `10.*`, `169.254.*`, `[::1]`. Класичний SSRF на внутрішні Redis/Postgres/cloud-metadata. Канон: для ЛЮБОГО user-supplied URL що server потім fetch-ить — окремий `validatePublicUrl()` helper з блок-листом RFC1918/loopback/link-local/ULA/non-http(s). `apps/api/src/common/utils/url-guard.ts` — single source of truth. Defense-in-depth: ВАЛІДАЦІЯ І при create/update DTO, І в processor перед fetch (DNS rebinding mitigation). У processor для SSRF — НЕ re-throw (retry безглуздий, це config bug, не transient).

- **`@IsArray()` БЕЗ `@ArrayMaxSize(N)` = OOM DoS** (Bug #115, inspection.dto.ts). `class-validator` пропустить будь-який розмір; `ValidateNested({ each: true })` валідує **КОЖЕН** елемент → 1M елементів = 1M validation iterations + 1M heap allocations. Канон: для КОЖНОГО `@IsArray()` поля у DTO — `@ArrayMaxSize(N)` де N — реалістичний бізнес-потолок (50 inspection points, 100 WO parts, 500 invoice lines). grep `@IsArray()` без `@ArrayMaxSize` — патерн.

- **MinIO/S3 delete порядок: DB-row FIRST, then external** (Bug #116, work-order-media.service.ts). Інверсний порядок (file→row) при MinIO fail дає orphan DB record що в findAll генерує broken signedUrl → 404 для користувача. Правильно: row first (transient DB fail → file лишається, можна повторити), file second (transient MinIO fail → garbage у MinIO, але DB consistent, batch-cleanup пізніше). Те ж для будь-якої external storage: avatar deletion, audit log archival, external email service.

- **`@MaxLength` без `@MinLength` для search-style полів = short-query DoS** (Bug #117, search.dto.ts). `q='a'` тригерить `similarity(text, 'a') > 0.1` — match-ить майже все, але кожен match — heavy GIN-scan. Frontend filter `q.length >= 2` не достатньо — atacker може robust HTTP curl. Канон: `@MinLength(2)` обов'язково для search/filter/autocomplete полів.

- **Auth/refresh dup-ed у per-component fetch helpers** (Bug #118, xlsx-import-button.tsx). Це класична regression-risk: ОДНА change в `tryRefresh()` (cookie semantics, retry policy, redirect target) — БУДЕ забута у дублі. Канон: ЄДИНІ помічники — `apiFetch`, `apiBlobFetch`, `apiMultipartFetch` з `lib/api-client.ts`. grep `function tryRefresh\|async function fetchWithAuth` у `apps/web/src` поза `lib/api-client.ts` — code smell.

- **`@Query('xxxId') id: string` без `ParseUUIDPipe` на public endpoint = 500 spam** (Bug #119, booking.controller.ts). Невалідний UUID → P2023 → 500. На auth-guarded endpoint це internal log noise; на public endpoint — будь-хто може спамити 500-помилками і wear alerting. Канон для ВСІХ public endpoints (`@Public` декоратор або controller без JwtAuthGuard): runtime regex-validation (UUID, date YYYY-MM-DD) перед service call. ParseUUIDPipe як швидкий drop-in для UUID; для date — `@Matches` у DTO або inline regex.

- **`validatePublicUrl` helper** (apps/api/src/common/utils/url-guard.ts): нова canonical utility для SSRF defense. Блокує: loopback (127.0.0.0/8, ::1), RFC1918 (10/8, 172.16/12, 192.168/16), link-local (169.254/16, fe80::/10), ULA (fc00::/7), CGNAT (100.64/10), 0.0.0.0/8, "localhost"-style hostnames, non-http(s) schemes. Використовувати для будь-якого user-supplied URL що server потім touch-не: webhooks, image proxies, external API integrations, OAuth callbacks (whitelist домени).

### Gotcha — /sto-review cycle-1 (2026-05-27, commit e4ce8b1)

- **`@CurrentUser() user: { sub: string }` антипатерн — НЕ обмежується одним контролером, повторюється** (4 нових інстанси в auth/purchase-orders/stock-documents/payments). Bug #92 виправили лише для invoices та work-orders, проте grep `@CurrentUser.*sub` показав ще 4 controller-и де `user.sub` був тихо `undefined` (downstream `findFirst({ where: { id: undefined, orgId } })` повертає БУДЬ-який запис у org — у getMe користувач міг побачити іншого employee). Канон: ПІСЛЯ кожного fix цього патерну ОБОВ'ЯЗКОВО зробити global grep `@CurrentUser.*sub` і поправити всі — частковий fix залишає latent silent bugs. Додано до §1 grep-ів. Майбутній попереджувач: pre-commit hook `! grep -rn "@CurrentUser.*sub" apps/api/src --include="*.ts"`.
- **`@IsString()` на union-string type — `'OK' | 'WARN' | 'CRITICAL'` приймає будь-який рядок** (inspection.dto InspectionPointDto.status): TS-тип у DTO `'OK' | 'WARN' | 'CRITICAL'` — fiction для runtime. `class-validator` бачить тільки декоратори; `@IsString()` пропускає `'EVIL'`. Канон: для будь-якого `field!: 'A' | 'B' | 'C'` обов'язково `@IsIn(['A','B','C'])` (або генерувати const tuple + type from it). Додавати `@MaxLength` для всіх вільних `@IsString` полів — анти-DoS захист (без нього `notes: '...'.repeat(1_000_000)` стискає API request body).
- **Loyalty redeem race — `findFirst + balance check + decrement` всередині $transaction НЕ є атомарним** (loyalty.service.ts redeem): READ COMMITTED isolation дозволяє двом одночасним redeem-ам обидвом прочитати `balance=100`, обидвом передати check `balance >= 100`, обидвом decrement → final balance = -100. Канон для check-and-decrement на лічильниках/рахунках: `updateMany({ where: { id, balance: { gte: points } }, data: { balance: { decrement: points } } })` → Postgres UPDATE ... WHERE balance >= N — атомарний. Якщо `count === 0` — або записа немає, або балансу не вистачило (унифікований error path). Те ж стосується: stock decrement, loyalty wallet, prepayment redemption.
- **`total: items.length` після `take: N` — шаблонний баг #88 з пам'яті, повторюється в new code** (work-order-media.service.ts findAll): На media review був пропущений під час review #93 (фокус на `fileKey` витоці). Канон: grep `total: items.length` пробігати на КОЖНОМУ /sto-review циклі — це повторюваний шаблон з 4+ задокументованих інцидентів.
- **`React.ChangeEvent<...>` без імпорту `import type React` — VSCode помилка, tsc може мовчати** (date-picker-input.tsx): додано до §1 SKILL.md як одна з типових помилок. Канон: ЗАВЖДИ `import type { ChangeEvent } from 'react'` + use `ChangeEvent<HTMLInputElement>` без префікса. Те ж для `HTMLAttributes`, `SVGAttributes`, `MouseEvent`, `FormEvent`, `ReactNode`.
- **Migration без trgm-defense block — Prisma migrate dev silently DROPs B6 indexes** (4 нових міграції). Це 3-й цикл з тією ж проблемою (per Memory: 20260526113130, 20260526124850, тепер +4). Канон CRITICAL: КОЖНА нова `migration.sql` має ЗАКІНЧУВАТИСЬ `CREATE INDEX IF NOT EXISTS idx_*_trgm` блоком (повний список з 20260526061209_b6_trgm_gin_indexes). Без виключень — навіть для міграцій що не торкаються `goods`/`counterparties`/`work_orders`. Запропонувати pre-commit: `for m in $(git diff --name-only --cached | grep migration.sql$); do grep -q "idx_work_orders_number_trgm" "$m" || exit 1; done`.

### Gotcha — /sto-tester FULL on 3c6d233..fab5fd1 (2026-05-26, bugs #97-#110, B8 FollowUp CRON)

- **BullMQ scheduler + soft-deleted org = щоденне будіння мертвих tenants** (Bug #97, followup.scheduler.ts): `prisma.organisation.findMany({ select: { orgId: true } })` без `where: { deletedAt: null }` означає CRON-job для кожного клонованого/видаленого tenant'а. Канон: КОЖЕН `organisation.findMany` має `where: { deletedAt: null }` — нема жодного use-case коли потрібні deleted orgs (audit-trail використовує `findFirst` без soft-delete фільтра, не findMany).

- **`Organisation.id` vs `Organisation.orgId` — convention яка чекає першого розробника що зламає її** (Bug #98): Schema має ДВА UUID колонки на Organisation: `id` (PK) і `orgId` (sibling). Усі FK у проекті (counterparties, vehicles, garage_branches, organisation_settings, ...) REFERENCES `organisations(id)`. Колонка `orgId` дорівнює `id` лише завдяки конвенції в `setup.service.ts` де `update({ orgId: org.id })`. Канон: ВСЯ кодова база читає org через `findFirst({ where: { id: orgId } })` і `select: { id: true }` (підтверджено grep — `followup.scheduler.ts` був єдиним consumer-ом field `orgId`). Майбутньому розробнику зрозуміліше було б видалити `orgId` колонку взагалі і використовувати тільки `id`, але це міграційний ризик. На зараз — DEV-rule: ніколи не читати `Organisation.orgId`, тільки `Organisation.id`.

- **`new Date()` у CRON-processor + server-local arithmetic = DST/timezone landmines** (Bug #99, followup.processor.ts): На UTC-сервері (Docker default) і Kyiv-сервері (Windows on-prem) `setDate(d.getDate() + N)` поводиться по-різному біля DST-границь і опівночі. Канон для CRON-обчислень дат: завжди прив'язувати "today" anchor до фіксованого UTC-часу всередині Kyiv-дня: `today.setUTCHours(9, 0, 0, 0)` дає 11/12:00 Kyiv (стабільний полудень, ±1h DST не виштовхує за межі дня). Це найдешевший фікс — без `Intl.DateTimeFormat('Europe/Kyiv')` чи `kyivOffsetMs()`.

- **`findFirst` без `orderBy` для "primary" branch = non-deterministic SMS sender в multi-branch орг** (Bug #100): Postgres heap-order для `findFirst` нестабільний між запусками. У multi-branch орг (типовий продакшен-кейс — мережа СТО з 2-5 точками) це означає що ранкові SMS клієнтам можуть йти з імені різних branch-ів день у день. Канон: ЗАВЖДИ `orderBy` для будь-якого "primary/main/default" findFirst — мінімум `{ createdAt: 'asc' }` для "найперший створений", краще explicit `isMain/isPrimary` flag з partial unique index (див. Bug #69 для прикладу).

- **Prisma `none: { completedAt: { gte: cutoff } }` ВКЛЮЧАЄ авто з порожнім зв'язком** (Bug #101): SQL semantics `NOT EXISTS (subquery)` true коли SUBQUERY RESULT IS EMPTY. Тобто vehicle з 0 WO підпадає під `workOrders: { none: {...} }`. Для "тихих клієнтів" треба пара: `some: { completedAt: { lt: cutoff } }` (мав WO в минулому) + `none: { completedAt: { gte: cutoff } }` (нічого недавно). Інакше нагадування "ми скучили" летить новому клієнту що тільки зареєстрував авто.

- **`MaintenanceSchedule.nextMaintenanceDate { lte }` без `{ gte: today }` = SMS-спам на роки** (Bug #102): Якщо клієнт пропустив ТО 6 місяців тому і schedule не reset, CRON надсилав однакову SMS щодня з тієї дати. Канон для будь-яких reminder-CRON: `{ gte: today, lte: today + forecastDays }` — нагадуємо тільки про "скоро настане", не "давно пропущено". Для overdue maintenance — окремий процес/notification (escalation campaign), не той самий CRON.

- **Прихована залежність: feature вимагає `NotificationTemplate` яка не у migration/seed** (Bug #103): B8 додав FOLLOWUP_REMINDER enum, але `NotificationsService.send()` шукає `findFirst({ eventType, channel, isActive: true })` → null → return мовчки. Канон для будь-якого нового NotificationEventType: ОБОВ'ЯЗКОВО парна міграція з `INSERT NOT EXISTS` для існуючих orgs + seed.ts оновлення. Без template feature dead на свіжому інсталі.

- **`.catch()` per-iteration без re-throw на ВСІ-fail = BullMQ ніколи не retry-ть** (Bug #104): Класичний анти-pattern з SKILL §4.9.4. Per-message catch (один поганий phone не валить batch) — OK, але потрібен лічильник: якщо `sendErrors > 0 && sendSuccess === 0` → `throw lastError`. Інакше Redis-fail виглядає як success у логах, операційники не знають що щось зламано.

- **Migration SQL що містить ALTER TYPE + USE того TYPE в одному файлі краще розбити** (Bug #103 fix): Postgres вимагає commit-у ENUM-value перед використанням. Канон: ALTER TYPE у migration N, INSERT з новим value — у migration N+1. Інакше CI може фейлити з `ERROR: unsafe use of new value`.

- **`take: 5000` для CRON-batch на per-org — peak memory bomb** (Bug #106): 5000 records × {include vehicle, counterparty, workOrders[1]} ≈ 100MB heap per org. Multi-org concurrent execution (BullMQ default concurrency 5) = 500MB peak. Канон для periodic batches: explicit `MAX_*_PER_RUN` константи на топі файлу + warning при reach + TODO про cursor pagination. Дешевший за full pagination на цей етап.

- **`getRepeatableJobs` + `removeRepeatableByKey` + `add` = race window на кожен restart** (Bug #108): На API-рестарті віконце між delete і add (~50ms) — CRON втрачено якщо crash. BullMQ `jobId` сам дедуплікує — `add({ jobId: 'fixed-key' })` ідемпотентний. Канон: НЕ робити preliminary remove у onModuleInit, лише `add` з фіксованим jobId.

- **Migration без захисного `CREATE INDEX IF NOT EXISTS` для pg_trgm GIN — Prisma migrate dev мовчки drop-не** (зв'язок з gotcha від commit 7b899e4): `prisma migrate dev` додає `DROP INDEX` для raw-SQL trgm GIN indexes з `20260526061209_b6_trgm_gin_indexes` коли генерується НОВА міграція. Канон: новий міграція = пара `CREATE INDEX IF NOT EXISTS "idx_*_trgm"` block наприкінці для defense. Без цього B6 search падає на seq scan після КОЖНОЇ schema-change міграції. Тут — додано у `20260526230500_followup_reminder_default_template/migration.sql`.

- **Per-tenant SMS sender = per-branch — який branch обрати?** (Bug #100 deep dive): Multi-branch architecture B10 створила питання яке B8 не вирішила: SMS-sender (`senderName`, `smsApiKey`) живе на `BranchSettings`, але FollowUp реагує вище — на orgId-rivni. Tier-1 фікс: oldest branch. Tier-2 правильне рішення: або per-vehicle resolve через `lastWorkOrderBranchId` (потрібен новий FK), або brand-level SMS config окрема таблиця `OrganisationSmsConfig`. Розглянути для майбутньої feature.

- **CRON-processor unit-тести: 13 кейсів які стоять писати** (Bug #105, followup.processor.spec.ts шаблон): (1) followUpActive=false → no send, (2) no branch → no send, (3) soft-deleted vehicle/garage/counterparty фільтруються, (4) phone dedup один клієнт → 1 SMS, (5) no phone skip, (6) inactive vehicle з минулим WO → send, (7) vehicle never had WO → no send (defensive), (8) all-fail → throw для retry, (9) partial-fail → no throw, (10) formatName fallback, (11)-(13) DB-filter shape assertions (`expect.objectContaining({ where: ... })` для critical filters). Це baseline для будь-якого нового @Processor.

### Gotcha — /sto-tester FULL on e7e0c83..0aa4cb3 (2026-05-26, bugs #0a + #91-#96)

- **Baseline TS-помилка маскується пропущеним `mapXxx()` shape оновленням** (Bug #0a, settings.service.ts): попередня сесія додала `followUpActive`/`followUpDays` у DTO/Response, але приватний `mapOrgSettings` мав inline тип параметра — оновлення цього inline shape тихо пропустили. `tsc --noEmit` ламається на КОЖНОМУ запуску. Канон: коли додаєш поле у Response DTO + DB schema, обов'язково оновити: (a) DTO `OrganisationSettingsResponseDto`, (b) Request DTO `UpdateOrganisationSettingsDto` з валідацією, (c) **усі `mapXxx()` shape**-визначення, (d) seed/mock у contract тестах. Краще пара generic helper-ів типу `Pick<Prisma.OrganisationSettings, keyof OrganisationSettingsResponseDto>` ніж дублювати inline shape. Тестуй регресію — додав contract test `Bug #84 regression: followUp fields end-to-end` (4 кейси).

- **`@CurrentUser() user: { sub: string }` повторюється у нових контролерах попри попередню Gotcha** (Bug #92, invoices.controller.ts create + createFromWorkOrder): попередня сесія зафіксувала цей анти-паттерн для work-orders, але invoices, які `@CurrentUser` теж використовують, пропустили. Канон: загальний grep `@CurrentUser.*sub` як precommit check.
  ```bash
  grep -rn "@CurrentUser.*sub" apps/api/src --include="*.ts" && exit 1 || exit 0
  ```

- **Clone-операції — окремий клас invariantів** (Bugs #81, #82, #90, #91, #94, #96): дублювання сутності з релейтед records (lines/parts, FK на vehicle/counterparty/branch) має 6+ скритих pitfalls:
  1. **Totals** — Prisma defaults все обнуляють, обов'язково pre-compute (#81, #82).
  2. **workOrderId/parentId reference** — НЕ копіювати owning FK (один-до-одного зв'язок) (#91). Клон — самостійна сутність.
  3. **Soft-deleted FK** — pre-check кожен FK у `findFirst({ deletedAt: null })`, інакше P2003 → HTTP 500 замість дружнього 404 (#90).
  4. **State-related fields** — `actualHours`, `completedAt`, `paidAmount` мають reset до DRAFT-defaults (#94). НЕ копіювати "виконано/оплачено" у новий DRAFT.
  5. **AuditEvent** — клон ЦЕ create operation, потребує `audit.record('CREATE', ..., { clonedFromId })` (#96).
  6. **Document number sequence** — `docNumbers.next` поза `$transaction` → "дірка" у numbering при FK fail (#95, поки відкритий — LOW).

- **`apiMultipartFetch` — третій canonical fetch helper** (Bug #85, api-client.ts): тепер три варіанти silent-refresh:
  | Helper | Content-Type | Body | Returns |
  |---|---|---|---|
  | `apiFetch<T>(path, init?)` | application/json | string/JSON | `T` (parsed JSON) |
  | `apiBlobFetch(path, init?)` | (не задається) | (зазвичай undefined) | `Blob` |
  | `apiMultipartFetch<T>(path, formData, init?)` | (multipart/form-data automatic) | `FormData` | `T` (parsed JSON) |
  ВСІ роблять `tryRefresh()` при 401, `window.location.replace('/login')` при refresh fail. **Ніколи** не використовуй native `fetch(...)` напряму у компонентах — це обхід refresh+redirect logic.

- **AuditEvent `findByEntity` total мав bug-pattern `total: items.length` після `take: N`** (Bug #88): класична помилка пагінації — `total` cap-ується разом з items. Frontend думає що бачить ВСЕ. Канон: `$transaction([findMany, count])` де `count` без `take`/`skip`/`orderBy`. Той же патерн застосуй у будь-якому новому `findX` що має `take: N`. Grep:
  ```bash
  grep -rn "total: items.length\|total: .*\\.length" apps/api/src --include="*.service.ts"
  ```

- **DTO `fileKey` витік на frontend = least-privilege порушення** (Bug #93, work-order-media.dto.ts): внутрішній MinIO object path `org/<uuid>/work-orders/<uuid>/<uuid>.jpg` повертався у DTO, але frontend його не використовує (тільки signedUrl). Канон: response DTO містить **лише поля які реально потрібні UI**. Будь-яке поле що не споживається — кандидат на видалення (грeп у frontend).

- **`min`/`max` props у DatePickerInput треба ВЖИВАТИ, а не лише декларувати** (Bug #87): TS-інтерфейс мав `min?: string; max?: string`, але `DayPicker` не отримував `disabled={[...]}` matcher. Це класична TS-довірливість: тип проходить compile, runtime ігнорує. Канон: будь-який prop у TS interface — у JSX має бути спожитий. Lint-правило `react/no-unused-prop-types` від `eslint-plugin-react` ловить це. Без нього — code review.

- **`useEffect` для Escape handler лише при `lightboxUrl` truthy** (Bug #89, work-orders/[id]/PageClient.tsx): `useEffect(() => { ... }, [lightboxUrl])` з early-return `if (!lightboxUrl) return` робить subscribe тільки коли модалка відкрита, і автоматично unsubscribe при закритті. Канон для будь-якої наступної lightbox/popover/dropdown реалізації: pair з `role="dialog" aria-modal="true" aria-label="..."` І keydown listener у `useEffect([open])`. 

### Gotcha — /sto-review on e7e0c83..cdeb9f6 (2026-05-26, commit 7ee1db4)

- **EventSource не передає Bearer header — SSE авторизація через query token обов'язково має manual verify** (dashboard.controller.ts B9): нативний `EventSource` не підтримує custom headers, тому SSE endpoint не можна захистити стандартним `@UseGuards(JwtAuthGuard)` — guard очікує `Authorization: Bearer`. Канон: для SSE окремий endpoint який приймає `?token=<jwt>`, вручну викликає `jwtService.verify(token, { secret: config.getOrThrow('JWT_ACCESS_SECRET') })`, валідує `payload.sub && payload.orgId`, кидає `UnauthorizedException` інакше. **АЛЕ паралельний non-SSE endpoint (`/dashboard/summary`) ВСЕ ОДНО треба захистити** контролер-рівневим `@UseGuards(JwtAuthGuard, RolesGuard)` + `@Roles(...)` — інакше це open hole. Грeп `@Controller` без `@UseGuards` на рівні класу І без `@UseGuards` на кожному методі — це CRITICAL.
- **Hardcoded `'sto_token'` рядок як ключ sessionStorage = німий auth fail** (useDashboardStream.ts + work-orders/[id]/PageClient.tsx): канонічний ключ — `TOKEN_KEY = 'sto_access_token'` (експортується з `@/lib/auth`). Hardcoded `'sto_token'` ніколи не повертає валідний токен, але `sessionStorage.getItem` повертає `null` мовчки — fetch стартує без header, API відповідає 401, EventSource onerror зриває reconnect loop. Канон: ЗАВЖДИ `import { TOKEN_KEY } from '@/lib/auth'`. Grep на `sessionStorage.getItem.*sto_` без TOKEN_KEY — CRITICAL.
- **Env var drift `NEXT_PUBLIC_API_BASE` vs `NEXT_PUBLIC_API_URL`** (useDashboardStream.ts): в проекті прийнято `NEXT_PUBLIC_API_URL` (api-client.ts, auth/context.tsx, xlsx-import-button.tsx). Hook `useDashboardStream` шукав `NEXT_PUBLIC_API_BASE` що ніколи не існував → `localhost:3000` у проді, SSE не конектиться. Канон: одна канонічна env-змінна на API base URL, винесена у `lib/api-client.ts` як `export const API_URL`. Уникнути копі-паст hardcoded `process.env.NEXT_PUBLIC_API_*` у нових файлах — імпортуй з api-client.
- **Multipart file upload через нативний `fetch` потребує `/api` префіксу І `credentials: 'include'`** (work-orders/[id]/PageClient.tsx handleMediaUpload): `apiFetch` сам додає `/api`, але `apiFetch` не підтримує `FormData` (фіксує Content-Type у JSON). При використанні raw `fetch(${API_URL}/work-orders/...)` забули `/api` префікс І `credentials: 'include'` для refresh-cookie. Канон: коли upload вимагає `multipart/form-data` — `fetch(\`\${apiBase}/api/<path>\`, { credentials: 'include', headers: { Authorization: \`Bearer \${token}\` } })` БЕЗ Content-Type (браузер сам додасть boundary). Альтернатива: розширити `apiFetch` щоб detect-ив `FormData` body і пропускав Content-Type — TODO у follow-up.
- **`@CurrentUser() user: { sub: string }` тип-брехня** (work-orders.controller.ts transition/clone): `AuthenticatedUser` (jwt.strategy.ts) реально повертає `{ id, orgId, role }` — НЕ `{ sub }`. `sub` присутній лише у raw JWT payload. Анотація `{ sub: string }` ламає TS у боку розробника: TS приймає `user.sub` (поле є в типі), runtime повертає `undefined`. Будь-який downstream код що передає `userId` далі (audit, settlement.createTransaction) тихо отримує `undefined` → audit log skip, settlements creator missing. Канон: ЗАВЖДИ `@CurrentUser() user: { id: string }` для controllers що потребують auth user. Глобально grep `@CurrentUser.*sub` — це регулярний bug-pattern (8+ контролерів у проекті досі мають цю помилку).
- **Path traversal у multipart filename → object-storage** (work-order-media.service.ts upload): `file.filename.split('.').pop()` для extension без sanitization не дає traversal (`crypto.randomUUID()` робить шлях унікальним), АЛЕ `filename` зберігається в DB і повертається у DTO; HTML `<img alt={m.filename}>` міг би показати XSS-нерелевантне `../../etc/passwd.jpg`. Канон: `path.basename(filename.replace(/\\/g, '/'))` + control-char strip + 255-char cap + ext whitelist. Те ж стосується будь-яких file upload endpoints: `xlsx-import`, `attachment-upload`, custom logo upload.
- **`take: N` на `prisma.X.count()` — мовчки ігнорується** (dashboard.service.ts stockItem): `count()` повертає число, не масив — `take` параметр не входить у `Prisma.XCountArgs`. TS не ловить бо `count` приймає `{ where, ... }` без обмеження keys. Канон: НЕ передавати `take` у `count()` — нема ефекту, плутає reviewer. Якщо реально треба capped count — `take` у `findMany({ select: { id: true } }).then(r => r.length)`.
- **`(decimal as any).toNumber()` ховає тип Prisma.Decimal** (dashboard.service.ts revenue sum): Prisma `_sum.amount` повертає `Prisma.Decimal | null`. Cast `as any` → виклик `.toNumber()` працює, але type lost і null-check не gerada (NaN при null). Канон: `Number(decimalValue)` (працює і для Decimal і для null → NaN → треба guard) АБО `decimalValue != null ? Number(decimalValue) : 0`. Ніколи `as any` навколо Prisma результатів — використовуй `Number(x)` cast який TS розуміє через Decimal.toNumber вбудоване coercion.
- **`audit-log` endpoint без ParseUUIDPipe → P2023 → HTTP 500** (audit.controller.ts findByEntity): `@Query('entityId')` без `ParseUUIDPipe` приймає будь-який string, Prisma `where: { entityId: 'not-a-uuid' }` падає `PrismaClientKnownRequestError P2023`, NestJS повертає 500 замість 400. Канон: `@Query('xxxId', new ParseUUIDPipe())` для будь-якого param/query очікуваного UUID. Те ж для polymorphic `entityType` — whitelist у `@IsIn(...)` або in-controller `if (!ENTITY_TYPES.includes(entityType)) throw new BadRequestException(...)`.


### Gotcha — /sto-review on commit 7b899e4 (2026-05-26, d53b626)

- **Prisma auto-migrations silently DROP untracked indexes (pg_trgm GIN, custom raw-SQL).** Each `prisma migrate dev` re-generates a draft with `DROP INDEX "idx_*_trgm"` for the trigram GIN indexes created by `20260526061209_b6_trgm_gin_indexes` (raw SQL — Prisma schema parser doesn't see them). Two migrations have now repeated this mistake (`20260526113130_warehouse_is_main` was caught; `20260526124850_stock_document_receipt_work_warranty` was not until this review). **Canon:** every new migration must be diff-checked for `DROP INDEX "idx_.*_trgm"` and patched with `CREATE INDEX IF NOT EXISTS ...` defense block. Consider a pre-commit hook: `grep -L "DROP INDEX.*trgm" packages/database/prisma/migrations/*/migration.sql || exit 1`.
- **Nested-controller route + standalone frontend URL = path drift.** Frontend called `/api/settlements/reconciliation-acts/:id/pdf` while controller mounted at `@Controller('counterparties/:counterpartyId')`. Real route is `/api/counterparties/:cpId/reconciliation-acts/:actId/pdf`. **Canon:** when adding a new endpoint to a nested-prefix controller, grep frontend `apiFetch`/`apiBlobFetch` calls for the resource name and verify path prefix matches. Add cross-FK tenant isolation in service (`findFirst({ id, orgId, counterpartyId })`) — `@Param('counterpartyId')` alone doesn't validate it belongs to the act.
- **Cross-tenant FK validation on ADD-line / UPDATE endpoints** (invoices.addLine `goodId`/`workId`). The skill calls this out in §2.2, but it's easy to forget for sub-entity CRUD (lines, parts, comments). **Canon:** every endpoint that accepts an FK uuid in body — even on a child resource — must do `findFirst({ id, orgId })` before linking. The parent being in-org does NOT imply the new FK is in-org.
- **Soft-delete vs hard-delete for config tables**: `TaxRate` has no `deletedAt` but IS referenced (by `vatRate` decimal value) in past `InvoiceLine` rows. Hard delete loses audit trail. **Canon:** for config tables snapshotted into business records (rate copies, name copies), use `isActive=false` as soft-delete + reject delete on `isDefault=true`. Same pattern: `PaymentMethodConfig`, `NotificationTemplate`.
- **Magic-number cost ratio in financial reports** (reports.profitability `0.4` labor cost). Even when not yet wired to a DB setting, factor into named `const` with TODO comment — makes refactor to `OrganisationSettings.laborCostRatio` discoverable via grep.
- **Inline PATCH on every onChange** (settings/page.tsx docNumbers prefix/separator): fires DB write per keystroke. **Canon:** auto-save inputs use `onBlur`, not `onChange`. Surface errors in page-level `error` state instead of silent `.catch(() => {})`.
- **Enum-string `@Param` casting to Prisma enum at service layer** (settings.controller `documentType: string` → `documentType as DocumentType`). Invalid string passes controller, then either silently misses by `findFirst` (404) or P2009-crashes Prisma (500). Add `@IsIn(Object.values(EnumName))` on DTO fields cast to Prisma enums.

### Gotcha — /sto-tester FULL on commit 7b899e4 (2026-05-26, bugs #74–#80)

- **Cost fallback в звітності НІКОЛИ не дорівнює sale-price** (Bug #74, `reports.service.ts profitability()`): код мав `const cost = part.batchCostPrice ?? part.price` де `part.price` — це САЛЕ-ціна позиції WO. Коли `batchCostPrice IS NULL` (запчастина додана без батча), собівартість дорівнювала виручці і прибуток ≈ 0 — катастрофічно неправильно для P&L звітності. Канон: при будь-якому fallback на "cost" НІКОЛИ не використовувати sale-price. Послідовність: `batchCostPrice ?? good.purchasePrice ?? null`. Якщо все ще null — додавати позицію до `unknownCostPartsCount` лічильника, не до `totalCost`. Краще завищити прибуток (and surface that some parts are uncosted) ніж занизити підставою sale-price як cost.
- **Prisma `lt`/`gt` filter EXCLUDES NULL rows** (Bug #75, work-orders.service.ts mileage sync): `prisma.vehicle.updateMany({ where: { currentMileage: { lt: N } }, data: { currentMileage: N } })` НЕ оновлює рядки з `currentMileage IS NULL` (SQL: NULL vs число → UNKNOWN → row excluded). Канон: будь-який числовий "update if smaller OR if missing" — обов'язково `OR: [{ currentMileage: null }, { currentMileage: { lt: N } }]`. Те ж стосується дат: `updatedAt`, `lastSeenAt`, `dateOfLastService` — не покладатись на implicit NULL semantics у фільтрах.
- **PDF/Blob downloads повинні мати silent refresh як `apiFetch`** (Bug #77, settlements + work-orders pages): прямий `fetch(${apiBase}/api/...)` з ручним Bearer-токеном не робить retry після 401 — користувач отримує помилку замість файлу через 15 хв простою. Канон: винести `apiBlobFetch(path)` у `lib/api-client.ts` що дублює auth/refresh логіку `apiFetch` але повертає `Blob`. Використовувати ВСЮДИ де PDF/Excel/CSV downloads. Не дублювати inline fetch у компонентах — кожна inline-копія втрачає silent-refresh + redirect-on-logout логіку.
- **`||` має нижчий пріоритет за `?:`, призводить до dead-branch ternary** (Bug #76, invoices.recalcTotals): `const x = a || b ? c : c;` парситься як `(a || b) ? c : c` — обидві гілки `c`, конструкція безглузда. Якщо в код проходить тернарник з ідентичними `true`/`false` гілками — це 99% copy-paste артефакт. Канон: спрощувати негайно. Якщо потрібна реальна умова — писати її явно з parentheses і коментарем.
- **VAT/percent fields потребують `@Max(100)` поряд із `@Min(0)`** (Bug #78, invoices.dto.ts): `@IsNumber() @Min(0) vatRate?: number;` приймає 9999%. Канон: будь-яке поле що означає percent — і `@Min(0) і @Max(100)`. Стосується: `vatRate`, `discountPercent`, `marginPercent`, `loadPercent`, `tax` etc. Grep на `@IsNumber.*percent|vatRate|@Min\(0\)` без `@Max(100)` — це регулярний баг-шаблон.
- **Time math з `% 24` робить тихий wrap до попереднього дня** (Bug #79, calendar normoHours auto-end): `(h*60 + m + normoMin) % (24*60)` для 14:00 + 15h дає 05:00 — на тій же даті — раніше за початок. UX-проблема: фронт показує валідне з вигляду значення, API падає 400. Канон: для time-math у тому ж calendar-day — clamp до `23:59`: `Math.min(totalMin, 23*60 + 59)`. Wrap (`% 24`) — лише коли явно потрібен перехід на наступний день, що для слотів СТО недопустимо.
- **DELETE/cancel endpoint що повертає void → завжди `@HttpCode(HttpStatus.NO_CONTENT)`** (Bug #80, completion-acts cancel): NestJS за замовч. видає 200 + порожнє тіло, але REST-стандарт + UI-очікування — 204. Канон: коли метод повертає `Promise<void>` — додати `@HttpCode(HttpStatus.NO_CONTENT)`. Узгодженість з логаут/`removeSlot`/`removeLine` важлива для frontend (`apiFetch` перевіряє `status === 204` щоб не парсити JSON).

### Gotcha — /sto-review costMethod selector (2026-05-26, commit 18598d7)
- **Frontend enum literal drift from Prisma enum** (settings/page.tsx costMethod selector): Prisma enum `BatchCostMethod = { FIFO, FEFO, LIFO, AVG_COST }`. New UI shipped `[['FIFO', ...], ['LIFO', ...], ['AVERAGE', ...]]` — `AVERAGE` is not in the enum and `FEFO` is missing entirely. Backend `@IsEnum(BatchCostMethod)` returns 400 on any "Середній" pick → user can never change the default. Канон: when an enum is shared across the boundary, declare a literal-union type on the frontend (`type CostMethod = 'FIFO' | 'FEFO' | 'LIFO' | 'AVG_COST'`) and derive the option list from that single source of truth. NEVER let the field be typed `string` in the frontend `interface` — that defeats TS as a safety net for enum drift. Also: every Prisma enum that surfaces in UI needs a contract test that PATCHes each valid value AND asserts an invalid string 400s (regression guard).
- **List/option arrays in JSX should be `const OPTIONS = [...]` at module top, not inline `[as [string,string,string][]]`** — the inline tuple-literal cast hides typos behind verbose syntax. Canonical pattern: `const X_OPTIONS: { value: X; label: string; hint: string }[] = [...]; X_OPTIONS.map(...)`. Also makes the labels accessible to future i18n extraction.
- **Radio-group semantics on segmented buttons**: a vertically/horizontally stacked group of mutually exclusive `<button>`s is functionally a radio group. Wrap in `role="radiogroup"` with `aria-label`, give each option `role="radio"` and `aria-checked={selected}` — otherwise screen readers announce "10 buttons" without conveying mutual exclusivity.

### Gotcha — /sto-tester FULL on warehouse isMain feature (2026-05-26, baгs #69-#73)

- **Service-layer `updateMany; create` для single-flag-per-org НЕ є атомарним** (Bug #69, warehouses.service.ts): паттерн `await tx.warehouse.updateMany({ isMain: false }); await tx.warehouse.create({ isMain: true })` в одній `$transaction` НЕ дає DB-рівневого інваріанту. `updateMany` бере row-locks на EXISTING рядки; `create` додає новий — не конфліктує. Дві паралельні транзакції в `READ COMMITTED` обидві проходять. Результат: 2+ `isMain=true` в одній org. Канон: для будь-якого "тільки одна-Х-на-org/branch/контекст" — **partial unique index** на DB рівні: `CREATE UNIQUE INDEX ... ON tbl (orgId) WHERE flag = true AND deletedAt IS NULL`. Service-guard лишається для UX (миттєвий toggle), але інваріант — у БД. У сервісі обернути `Prisma.P2002` у `ConflictException` з UI-friendly повідомленням. Прийом застосуємо також до: `Counterparty.isPrimaryContact`, `Branch.isHeadquarters` (якщо з'явиться), `PaymentMethodConfig.isDefault` — будь-який "primary/default/main" flag.
- **MECHANIC-доступ до reference endpoints, які потрібні для WO parts** (Bug #70, warehouses.controller.ts): `WorkOrdersController.@Roles('OWNER','ADMIN','RECEPTIONIST','MECHANIC')` на POST /work-orders/:id/parts дозволяє MECHANIC додавати запчастини; модалка "Додати запчастину" викликає `GET /warehouses` для заповнення dropdown; `WarehousesController.findAll` мав `@Roles('OWNER','ADMIN','RECEPTIONIST','STOREKEEPER')` — без MECHANIC. Запит повертає 403, dropdown порожній, MECHANIC не може додати запчастину. Канон: коли роль X отримує WRITE на доменну сутність Y, перевірити що X має READ на ВСІ reference resources які UI використовує у формі для Y. Grep: `apiFetch.*/<resource>` у компонентах де можливі MECHANIC/role-X — porівняти з `@Roles` у відповідних контролерах.
- **`useEffect([])` для one-shot auto-fill не виконається після form reset** (Bug #71, work-orders/[id]/PageClient.tsx): `useEffect(() => { apiFetch('/warehouses').then(d => setPartForm(f => f.warehouseId ? f : {...f, warehouseId: mainW.id})) }, [])` спрацьовує лише раз. Якщо handler-saver обнуляє форму `setPartForm({...empty})`, наступне відкриття модалки покаже порожній dropdown — useEffect не re-fire. Канон: при reset форми зберегти "sticky" defaults: `setPartForm(f => ({ goodId:'', warehouseId: f.warehouseId, quantity:'1', price:'' }))` — explicitly preserve fields що мають "залипати" між послідовними інстансами модалки. Не використовувати `setForm({...empty})` для форм, що auto-fill-яться через mount-only useEffect.
- **Race-patron consistency: `f.x ? f : {...}` має бути ВСЮДИ де auto-select** (Bug #72, work-orders/page.tsx loadVehicles): review-фікс 83921d2 додав цей patron у branchId і warehouseId auto-selects, але пропустив `loadVehicles` (там guard є тільки на reqId staleness — а не на user's manual pick). Канон: при додаванні auto-select feature робити **сplit-screen sweep** — знайти grep-ом всі `setForm(f => ({ ...f, X: result }))` і застосувати один і той же patron `f.X ? f : {...}` синхронно. Pre-existing auto-selects, які приймають patron в окремому commit, ризик регресії.
- **Pre-existing failing tests маскуються у CI-output** (Bug #73, command-palette.test.tsx): тест `показує "Нічого не знайдено"` ламається тиху і безшумно після `feat(phases21-22)` що додав `apiFetch('/search')` debounce у компонент — у jsdom нема fetch, `dataLoading` лишається true, "empty state" не рендериться. 12/13 passed виглядає здорово для людини що дивиться лише на summary, але реально це регресія яка пройшла кілька commit-ів. Канон: будь-який тест що використовує `screen.getByText(...)` після `userEvent.type` має або (a) `vi.mock('@/lib/api-client', ...)` у файлі-тесті щоб контрольовано resolved-ить API виклики, або (b) `findByText` (async) — синхронні assertion-и проти post-debounce UI = flaky timer-залежність. `/sto-tester` тепер ЗАВЖДИ запускає `pnpm --filter @sto/web exec vitest run` у FULL mode і блокує на 0 failures, навіть якщо помилка не у файлах diff.


### Gotcha — /sto-review warehouse auto-select cycle (2026-05-26, commit fix(review): warehouse auto-select)
- **`prisma migrate dev` drops raw-SQL "drift" indexes silently** (migrations/20260526113130_warehouse_is_main): the trgm GIN indexes from `20260526061209_b6_trgm_gin_indexes` are created by hand-written `CREATE INDEX IF NOT EXISTS ...` *outside* schema.prisma. When the next `migrate dev` was generated for the unrelated `Warehouse.isMain` column, Prisma saw 6 indexes present in DB but not in schema → emitted `DROP INDEX` statements at the top of the auto-generated migration. This silently killed B6 fuzzy search (HTTP 200 still, just sequential scans on every search). Канон: every raw-SQL migration MUST be paired with **either** a corresponding schema.prisma directive (`@@index([...], type: Gin, ops: ...)` for trgm if supported) **or** the next auto-generated migration MUST be reviewed line-by-line for unexpected DROPs. The fix re-creates indexes idempotently inside the same migration, and updates the recorded checksum in `_prisma_migrations` so future `migrate dev` does not warn about drift.
- **Stale async response overrides user input** (work-orders/page.tsx loadVehicles): a counterparty change triggers a multi-step fetch (garages → vehicles per garage). If the user switches counterparty before the older fetch resolves, the older `length === 1` branch hijacks `form.vehicleId`. Канон: increment-on-call counter ref + guard at resolution (`if (reqId !== ref.current) return;`). The same pattern applies anywhere `setForm(f => ({ ...f, X: result }))` runs after an `await` whose source can re-fire faster than the network — counterparty/garage/vehicle cascades, dependent selects, search-driven combobox auto-select.
- **Auto-select effects must preserve manual user pick** (stock-documents, purchase-orders, work-orders, WO card part form): pattern `if (single) setForm(f => ({ ...f, x: single.id }))` looks innocent but clobbers a value the user has just typed/picked when the effect re-fires (modal re-opens, deps change, slow fetch resolves after re-mount). Канон: `setForm(f => (f.x ? f : { ...f, x: single.id }))` — only fill empty fields. Apply to every "default selection" code path; do not assume the field is always empty at effect time.
- **`findMany` ordering should reflect "canonical first" semantics** (warehouses.service.ts): adding an `isMain` boolean without bumping the `orderBy` means dropdowns still alphabetize, hiding the main warehouse below others. Канон: when a model gains a "primary/main/default" boolean flag, the default `findMany` order becomes `[{ isMain: 'desc' }, ...originalOrder]` so consumers naturally land on the canonical record.


### Gotcha — /sto-tester FULL pass 2026-05-26 after commit 8ed0a42 (Bug #68)

- **pdfmake v0.3.x server-side: Buffer descriptors crash, ONLY string paths work**: pdfmake's URLResolver does `font.normal.url.toLowerCase()` inside `Printer.resolveUrls`. If you pass a Buffer it reads `buffer.url` → `undefined.toLowerCase()` → `TypeError`. The correct server recipe is `pdfMake.setFonts(require('pdfmake/fonts/Roboto'))` — that module returns `{ Roboto: { normal: '/abs/path/Roboto-Regular.ttf', ... } }` pointing at the ttf files bundled inside `node_modules/pdfmake/fonts/Roboto/`. The legacy v0.1 vfs envelope (`{ pdfMake: { vfs } }`) does NOT exist in v0.3.9 — `pdfmake/build/vfs_fonts` is `module.exports = vfs;` (flat map), and feeding Buffers from that map still hits the URLResolver crash. Never trust an `as { ... }` cast on `require()` results without runtime smoke-testing.
- **Integration tests for any pdfmake-dependent code are mandatory**: tsc cannot validate the shape of `require()` output, and the URLResolver crash only fires on actual `getBuffer()`. The Bug #68 fix added `pdf.service.spec.ts` with three tests that generate real PDF buffers and assert `%PDF` magic — this is the cheapest guard against future regressions in font wiring or pdfmake upgrades.

### Gotcha — /sto-tester follow-up 2026-05-26 (commit fix(tester): Bugs #61-#67)

- **Raw SQL must mirror Prisma column names exactly**: schema field `StockItem.reserved` becomes Postgres column `"reserved"` (camelCase, double-quoted). Search service had `si."reservedQty"` which does not exist → `/search` 500 for every query (Promise.all rejected took down WO and counterparty buckets too). Also added missing `LEFT JOIN ... AND si."orgId" = ...` predicate plus GROUP BY g.id to prevent row multiplication when a good is in N warehouses.
- **`/branches` shape is `Branch[]` (plain array)** — NOT `{ items, total }`. employees/page.tsx assumed pagination envelope, fell back to `[]`, blocked B10 branch assignment. work-orders/page.tsx had the correct typing. Lesson: every contract refactor needs a sweep across ALL consumers, not just the one being edited.
- **NestJS `@Query()` without DTO silently drops params**: `forbidNonWhitelisted` only applies when a class is provided. `EmployeesController.findAll` accepted no DTO, so frontend's q/role/showDeleted were never read — UI filters looked working but did nothing. Pattern fix: every `findAll` that takes filters MUST have a typed `*QueryDto` annotation.
- **PDF endpoints need fetch+Bearer+Blob**, never bare `<a href>`. WO/PageClient had been fixed in the previous pass; invoices/page.tsx was missed and still used `<a href>` PLUS a bogus baseURL (`'http://localhost:3000/api'` fallback didn't match the env var convention used everywhere else).
- **Command palette data results need detail routes**: `r.push('/crm')` for a counterparty result loses the click context. Mapped each type to `{ list, detail?: (id) => string }` so `/crm/${id}` and `/work-orders/${id}` route correctly; goods still hit list (no detail page yet).
- **Tenant defense-in-depth even after findOne()**: `WorkOrderTemplatesService.update/remove` used `where: { id }` only. The preceding `findOne(orgId, id)` mitigated cross-tenant access, but any future refactor that drops findOne would silently leak. Pattern: always `where: { id, orgId }` for update/delete, regardless of preceding guards.
- **Template select that overwrites description**: setting `form.description = tpl.name` was confusing (looked like a noop, the user thought template feature was broken). Prefix with «Створено за шаблоном «...»» until full lines/parts auto-apply is implemented in a follow-up sprint.


### Gotcha — /sto-review Phases 21-22 cycle (2026-05-26, commit fix(review): ...)
- **TDZ у `useEffect` що читає `useRef`/`useState` оголошені нижче** (work-orders/page.tsx): рефакторинг "auto-init my-orders chip" зсунув `myOrdersInitRef = useRef(false)` нижче `useEffect` що його читає → `ReferenceError: Cannot access 'myOrdersInitRef' before initialization` при першому render для всіх ролей. Канон: ВСІ `useRef`/`useState` декларації йдуть ПЕРЕД будь-яким `useEffect`/`useCallback`/`useMemo` що їх читає. Не покладатися на JS hoisting — `let`/`const` не hoisted, виконання падає на стрічці `useEffect(...)`. Той самий ризик при додаванні нових ефектів зверху файлу під час інкрементальних feature builds.
- **F6 "Мої наряди" chip не фільтрує — `employeeId` відсутній у `WorkOrderQueryDto`** (work-orders.dto.ts): фронт надсилає `?employeeId=X` але `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })` повертає HTTP 400 "property employeeId should not exist". Філ не валідується тихо — endpoint крашиться. Канон: будь-який новий query-param фільтр на фронті → парний `@IsOptional() @IsUUID() field?` у DTO + handler у `findAll`. Перевірка: на кожен `apiFetch(\`?${param}\`)` має бути присутнє поле у відповідному `QueryDto`.
- **Polymorphic `entityType` casing mismatch** (comments F8): DTO whitelist `['WorkOrder', 'Counterparty', 'Vehicle', 'Invoice']` (PascalCase), фронт надсилав `'work_order'` (snake_case) → POST `400`, GET повертає `[]` (мовчки 0 матчів). Канон: експортувати `COMMENT_ENTITY_TYPES` константу з DTO і використовувати її у фронті через імпорт. Або принаймні задокументувати канонічну форму поряд із `@IsIn(...)`. Той самий ризик для будь-яких polymorphic discriminator strings — sync, audit, notifications.
- **pdfmake v0.3.x server-side API повністю відрізняється від UMD/browser** (pdf.service.ts): `require('pdfmake/build/pdfmake')` повертає browser bundle БЕЗ `PdfPrinter` класу → endpoint крашиться при першому виклику `new PdfPrinter(fonts)`. Канон для server (Node): `require('pdfmake')` (singleton) → `pdfMake.setFonts({...})` → `pdfMake.createPdf(docDef).getBuffer()` повертає `Promise<Buffer>`. Никогда `pdfmake/build/*` на бекенді.
- **`<a href>` download з JWT-guarded endpoint = HTTP 401** (PageClient.tsx downloadPdf): нативний браузерний download не може прикрутити `Authorization: Bearer` header. Канон: `fetch(url, { headers: { Authorization: \`Bearer \${token}\` } })` → `res.blob()` → `URL.createObjectURL(blob)` → `<a>` click → `setTimeout(revokeObjectURL, 100)`. Та сама проблема для будь-якого download endpoint захищеного `JwtAuthGuard`: PDF, Excel, ZIP, image-with-watermark.
- **`useState(() => localStorage.getItem(...))` lazy initializer крашить SSR + дає hydration mismatch** (useTableColumns.ts): Next.js static-export prerender виконує initializer на сервері де `localStorage` undefined → throw / hydration mismatch (server `defaults` ≠ client `stored`). Канон: ініціалізувати дефолтами, читати localStorage в `useEffect([])` після mount, defensive `typeof window !== 'undefined'` guard на write. Те саме для будь-якого hook що hydrate-ить state з storage: `useSavedFilters`, `useColumnOrder`, `useUserPreferences`.
- **Comment DELETE без author/role check = кожен може стерти будь-який коментар** (comments.service.ts): тільки `findFirst({ id, orgId })` потім `delete()` — будь-який авторизований у `orgId` може видалити comment колеги. Канон: `if (comment.authorId !== user.id && user.role !== 'OWNER' && user.role !== 'ADMIN') throw new ForbiddenException(...)`. Той самий патерн для будь-яких user-generated content: notes, attachments, files, reminders.
- **`Promise.all` + `slice(N)` для багатотипного пошуку дає non-deterministic ordering** (search.service.ts): `results.push(...items)` у `Promise.all` callbacks порядок залежить від latency окремих query → switch goods/wo раз від разу. Канон: `Promise.all(types.map(t => searchByType(t)))` → результат — массив **в порядку types** → `.flat().slice(0, limit)` детермінований.
- **B6 search by company name не покривається** (search.service.ts): початкова версія `similarity(firstName || ' ' || lastName, q)` — B2B клієнти невидимі. Канон: окрема similarity для `companyName` + label у respose має fallback на companyName.

### Gotcha — /sto-tester invoices/page sweep (2026-05-26, баги #58-#60, commit e867ba4)
- **Closure-check + functional-setter race у `handleTransition`** (Bug #58): `if (selectedInv?.id === inv.id) setSelectedInv(prev => ({...prev, status: newStatus}))` змішує JS-closure value (для перевірки `if`) і live React state (`prev` у setter). Якщо панель перемикається на іншу invoice між кліком і відповіддю API — newStatus застосовується до НОВОЇ invoice. Канон: ВСЯ перевірка має бути всередині функціонального setter — `setSelectedInv(prev => prev && prev.id === inv.id ? {...prev, status: newStatus} : prev)`. Той самий патерн потрібен скрізь де `if (selectedX) setSelectedX(prev => ...)` після `await` — детальні панелі, відкриті модалки, токенізовані selection.
- **Server-side side-effects не віддзеркалюються в selectedDetail** (Bug #59): `POST /payments` тригерить `invoice.status = 'PAID'` (PaymentsService:101), але клієнтський `handlePay` оновлює лише список через `load()` — DetailPanel показує застарілий SENT з активною кнопкою «Оплатити», що 400. Канон: після кожної мутації, що змінює статус через side-effect — оновити локально через functional setter ДО `load()`: `setSelectedInv(prev => prev && prev.id === id ? {...prev, status: 'PAID'} : prev)`. Шаблон: detail-panel-state-after-mutation = (mutate) → (sync local visible) → (refetch list).
- **VAT/totals defaults у Prisma = 0 рендеряться як «реальні» нулі** (Bug #60): `totalWithVat?: number` з API завжди present (default 0) для рахунків створених вручну без InvoiceLines. Перевірка `totalWithVat != null` truthy для 0 → секція «Підсумок» показує «Без ПДВ: 0,00 ₴ / ПДВ: 0,00 ₴ / З ПДВ: 0,00 ₴» поряд із `amount=1000 ₴`. Канон: для полів-сум з Prisma default 0 використовувати `(field ?? 0) > 0` як guard на рендер, не `!= null`. Те саме для будь-яких aggregated Decimal колонок: `totalAmount`, `totalLabor`, `totalParts`, `totalCost` — `> 0` фільтрує і undefined, і нулі.

### Gotcha — /sto-tester Phase 20 UX Groups 4-6 sweep (2026-05-26, баги #53-#57, commit 18f1d48)
- **`useBulkSelect` без pruning при зміні items → stale Set across pages** (Bug #53): Set обраних ID зберігається при пагінації/фільтрації/refetch, що дає невидимі вибори у count + хибний allSelected/someSelected + bulk actions проти невидимих ID. Канон: `useEffect(() => { setSelected(prev => prev ∩ visibleIds) }, [items])` з early-return `prev.size === 0`, щоб не тригерити re-render для порожньої виборки. Цей патерн обов'язковий для будь-якого хука що тримає `Set<string>` IDs прив'язаних до зовнішнього масиву.
- **`Promise.all` для bulk-операцій → fail-fast псує UX** (Bug #54): один FSM-invalid перехід (ARCHIVE з не-PAID, CANCEL з ARCHIVED/CANCELLED) реджектить ВЕСЬ батч; success-toast і `bulkSelect.clear()` не викликаються, але частина WO вже трансформувалась — UI неконсистентний. Канон: `Promise.allSettled` + рахунок fulfilled/rejected + ЗАВЖДИ викликати `clear()` і `load()` у `finally`-логіці + агрегований toast вигляду "Скасовано 3 з 5. 2 не змінено". Те саме для `bulkArchive`, `bulkRemove`, `bulkRestore`, `bulkExport` — будь-яка масова мутація.
- **Bulk-actions UI що не враховує FSM → завжди фейлить для частини selection** (Bug #55): `ARCHIVE` дозволено тільки з `PAID` (per `WORK_ORDER_TRANSITIONS`); інші 9 статусів повертатимуть 400. Аналогічно `CANCEL` з `IN_PROGRESS/COMPLETED/INVOICED/PAID/ARCHIVED/CANCELLED` неможливий. Мінімальний фікс — `Promise.allSettled` гасить регресію (#54). Якісне виправлення — disable / count-down кнопки на основі реальної кількості сумісних із FSM. TODO у follow-up: показувати "Архівувати (2 з 5)" або фільтрувати selection до compatible IDs перед mutation.
- **`onKeyDown` на `role="button"` рядку без `target !== currentTarget` guard → подвійне спрацювання** (Bug #56): Space на вкладеній `<button>` (наприклад X delete) нативно клікає кнопку АЛЕ keydown bubble-up до батьківського div з `onKeyDown` → друга дія (markRead) на щойно видаленому ID. Канон: `onKeyDown={e => { if (e.target !== e.currentTarget) return; ... }}` для всіх клавіатурних handler-ів на елементах-обгортках з інтерактивними нащадками.
- **Component coverage для Phase X нових компонентів — частина того ж sweep** (Bug #57): нові UI компоненти не отримують тестів автоматично в первинному PR — sto-review зосереджується на коді, не на test gaps. Канон: `/sto-tester` після кожного фічевого commit має grep-ом за `git diff --name-only HEAD~5..HEAD | grep components/ui` знайти нові файли і перевірити наявність `__tests__/<name>.test.tsx`; якщо відсутні — додати як LOW bug. Мін. coverage: рендер всіх variant пропс, всі callbacks (toggle/clear/onClick), edge cases (count=0, items=[], unread=12).

### Gotcha — /sto-review Group 4-6 cycle 1 (2026-05-26, commit f947021)
- **`opacity-0 hover:opacity-100` на тому ж елементі = unreachable** (notification-center per-row delete X): кнопка `opacity-0` має ефективну площу 0px, тож курсор не може приземлитись щоб `hover:` спрацював. Канон: показувати on-hover дочірнього елементу — додавати `group` на батьківську карточку, на дочірньому `opacity-0 group-hover:opacity-100`. Завжди дублювати `focus:opacity-100` щоб клавіатурні користувачі через Tab могли побачити кнопку.
- **`React.ReactNode` без `import React`** — tsc може мовчки пройти через next-env.d.ts глобали, але VSCode Next.js TS plugin суворіший і блимає червоним; також згідно sto-dev §1 — заборонено. Канон: `import type { ReactNode } from 'react'` + використовувати голий `ReactNode`. Той самий патерн для всіх React.X типів (`HTMLAttributes`, `ChangeEvent`, `SVGAttributes`).
- **HTMLInputElement.indeterminate через ref callback** — працює (інлайн arrow має нову identity на кожен render → React викликає cleanup + re-attach), але це implicit поведінка React 19 і легко зламати при додаванні React Compiler / memo. Канон: `const ref = useRef<HTMLInputElement>(null); useEffect(() => { if (ref.current) ref.current.indeterminate = X; }, [X]);` — explicit і future-proof.
- **`useMemo` для inline literal arrays що передаються у дочірні компоненти** — `const actions = [{ ... }]` створюється новою референцією на кожен рендер. Якщо дочка робить `useEffect` / `useMemo` з `actions` у deps — тригерить зайве. Канон: `useMemo(() => [...], [deps])` коли елементи містять `useCallback`-references.
- **Dead useEffect listener** — `addEventListener('event', () => {})` з no-op handler. Виглядає невинно, але алокує DOM-listener на кожен mount + плутає reviewer (намір незрозумілий). Канон: видаляти повністю якщо handler нічого не робить; якщо event used elsewhere — додати TODO коментар з реальним handler-кодом.

### Gotcha — Group 3 tester sweep (2026-05-26, баги #47-#52)
- **class-validator messages — повинні бути локалізовані глобальним `exceptionFactory`** (Bug #47): без нього кожне `@IsUUID`/`@IsISO8601`/`@IsEnum` повертає англійський текст у toast користувача, що порушує "UI українською" правило CLAUDE.md §16. Канон: створити `apps/api/src/common/pipes/validation-error.factory.ts` з мапою constraint-keys → укр. шаблонів і підключити у `main.ts:ValidationPipe({ exceptionFactory })`. Особливо помітно у inline-edit flows, де помилки валідації виходять прямо в toast.
- **`async commitEdit` що re-throws — call-сайти повинні мовчки ловити reject** (Bug #48): pattern де hook re-throws для збереження edit state на retry, але показ toast вже у `onSave`. Якщо `<select onChange={e => hook.commitEdit(e.target.value)}>` без `.catch` → unhandled Promise rejection у консолі + Next.js dev error overlay. Канон: `onChange={e => { void hook.commitEdit(e.target.value).catch(() => {}); }}`. Те саме для `onCommit`/`onSubmit`/`onBlur`-обгорток async re-throw API.
- **`<input type="text">` для дат — приховує помилку до server round-trip** (Bug #49): user типує "25/05/2026", "tomorrow", "abc" — все проходить frontend, бекенд кидає 400. Канон: для дат використовувати `<input type="date">` (native picker, YYYY-MM-DD enforced). Для inline-edit компонентів — приймати union `'text' | 'number' | 'date' | 'datetime-local'`. Додатково: `inputRef.current?.select()` кидає `InvalidStateError` для date/datetime-local → обгортати у try/catch.
- **`role="button"` БЕЗ `aria-label` коли children — Badge/icon** (Bug #50): `title` атрибут НЕ озвучується надійно у NVDA/JAWS. Якщо інтерактивний span має тільки візуальний контент (іконка, бейдж без текстового імені), screen reader прочитає "клацабельний елемент" без контексту. Канон: завжди передавати `aria-label={\`Редагувати: \${value}\`}` (або еквівалент дії). Не покладатися на `title` для accessibility.
- **localStorage corruption defense — Array.isArray на parsed payload** (Bug #51): `JSON.parse` повертає що завгодно (null, число, об'єкт). Якщо інший таб / devtools / стара версія додатку вставили `localStorage.setItem('sto_filters_x', '{}')` → наступний `.map()` у компоненті крашить error boundary. Канон: `Array.isArray(parsed) ? parsed : []`. Той самий захист для `boolean`/`number`/`string` cache — type guard перед використанням.
- **Component coverage для нових UI примітивів — обов'язково в межах PR**: будь-який новий компонент у `apps/web/src/components/ui/` ПОВИНЕН мати `__tests__/xxx.test.tsx` у тому ж commit (Bug #52). Hook у `apps/web/src/hooks/` — поряд `xxx.test.tsx`. Min coverage: рендер з усіма пропс-комбінаціями, кожен callback (onClick/onChange/onCommit/onCancel), keyboard навігація (Enter/Escape/Space), aria-attributes, edge cases (порожній стан, disabled, error). vitest config вже сканує `src/**/*.test.{ts,tsx}` — додавати тести в той самий PR що додає компонент.

### Gotcha — Command Palette tester sweep (2026-05-25, баги #42-#46)
- **Backdrop-click через `e.target === e.currentTarget`** — анти-патерн коли backdrop є дочірнім `absolute inset-0` сібінгом панелі: backdrop ВІЗУАЛЬНО покриває outer flex container, тож клік завжди приземляється на backdrop, а не на outer div → onClose ніколи не викликається. Канон: вішати `onMouseDown` НА САМ backdrop (`<div className="absolute inset-0 ..." onMouseDown={onClose} aria-hidden="true" />`), а не на outer dialog wrapper (Bug #42).
- **`onMouseEnter` vs `onMouseMove` у списках з клавіатурною навігацією**: `onMouseEnter` спрацьовує коли список зсувається ПІД нерухомий курсор (після фільтру/перебудови) → активний індекс стрибає, перебиваючи стрілки. Канон: `onMouseMove` (потребує реального руху курсора) + дешева guard `if (activeIndex !== idx) setActiveIndex(idx)` (Bug #43).
- **O(N²) flatList.indexOf у рендері** — для будь-якого list-у з груповим рендером, де треба знайти індекс у плоскому списку. Канон: `useMemo` побудувати `Map<Item, number>` один раз, в map-і груп брати `map.get(item)` за O(1) (Bug #44).
- **Combobox/Listbox ARIA pattern для command palette / autocomplete**: input має `role="combobox"`, `aria-controls={listboxId}`, `aria-activedescendant={activeOptionId}`, `aria-autocomplete="list"`. Контейнер результатів — `role="listbox"` + id. Кожен option — `role="option"`, `aria-selected={isActive}`, унікальний `id` (через `useId`, НЕ `Math.random` — non-deterministic + hydration risk). Без цього screen reader не оголошує зміну активного пункту під час ArrowDown/Up у текстовому полі (Bug #45).
- **Restore focus pattern для modal dialog**: WAI-ARIA вимагає повертати фокус на елемент-тригер після закриття. Канон: `previousFocusRef = useRef(null)`; у `useEffect` при `open=true` зберегти `document.activeElement`; при `open=false` — `setTimeout(() => previousFocusRef.current?.focus(), 0)` (defer один tick щоб модалка встигла unmount-нутись) (Bug #46).
- **jsdom не має `Element.prototype.scrollIntoView`** — компоненти що скролять активний елемент у видимість (palette, select, list virtualizer) крашать тести з `TypeError`. Канон: глобальний стуб у `apps/web/src/__tests__/setup.ts`: `Element.prototype.scrollIntoView = function () {}`.

### Gotcha — /sto-review Command Palette (2026-05-25, commit aed69c3)
- **Shift+/ vs '?'**: на US-розкладці `e.key` для Shift+/ → `'?'`, НЕ `'/'`. Hook що порівнює `e.key.toLowerCase() === mainKey` де `mainKey='/'` тихо не спрацьовує — ярлик `'?'` "є", але ніколи не фаєриться. Канон у `useKeyboardShortcut`: таблиця `SHIFT_ALIAS` (`'?':'/'`, `'!':'1'`, ...) + layout-independent fallback на `e.code` (`'Slash'`, `'KeyA'`, `'Digit1'`). Перевірити власноруч: Shift+/ показує help toast.
- **Modal + global shortcuts**: коли відкритий модальник з власним `window.addEventListener('keydown')`, БЕЗ `{ capture: true }` глобальні Alt+W/D/C/I/N все одно фаєряться у фоні (router.push під модалкою — UI лишається відкритим зі stale state). Канон: модальник реєструє listener з `{ capture: true }` + `e.stopPropagation()` на Escape; додатково — disable глобальних шорткатів через `enabled: !modalOpen` у parent.
- **useEffect deps з ре-обчислюваними масивами**: якщо у dep array є `flatList`/`filtered`/`groups`, що створюються через `.reduce`/`.map` у тілі компонента — listener видаляється/додається на КОЖНОМУ рендері. Канон: `useMemo` для всіх похідних колекцій + `useRef` для значень, які listener читає під час події (не пере-підписувати listener на кожному кадрі). Особливо болить для `addEventListener('keydown')` бо setState→render→re-subscribe створює гонку.
- **setTimeout у useEffect завжди має cleanup**: `setTimeout(() => ref.current?.focus(), 50)` без `clearTimeout` ламається коли `open` фліпає швидко. Канон: `const id = window.setTimeout(...); return () => window.clearTimeout(id);` навіть якщо інтервал малий.
- **Modal a11y baseline**: `role="dialog"` + `aria-modal="true"` + `aria-labelledby={titleId}` (sr-only `<h2>`) + `aria-hidden="true"` на декоративні іконки + Tab focus trap (preventDefault + .focus() назад на єдиний focusable). Без цього screen reader читає модалку як body content.

### Gotcha — Phase 19.2 tester sweep (2026-05-25, бaги #37-#41)
- **Module-level cache vs auth lifecycle** (Bug #37): React-хуки з модульно-глобальним `cache` (типу `useUiFeatures`) повинні очищатись при logout. Інакше на shared kiosk наступний користувач бачить кешовані flag-и попереднього орг. Канон: dispatch `sto:logout` Event у `AuthProvider.logout()` + кожен per-tenant cache hook слухає його і робить `invalidate() + setFeatures(DEFAULTS)`. Те саме треба робити для будь-яких client-side кешів (savedFilters, notifications counter, etc.).
- **JSON column whitelist** (Bug #38): Prisma JSON колонки + `@IsObject()` DTO = безмежний DoS-вектор. Канон: завжди ДВІ окремі функції — `parseFromDb()` (повертає повний об'єкт з defaults, чистить legacy junk) і `pickAllowedKeys(dto)` (повертає Partial лише з whitelisted keys + правильним type guard на value). Merge у service: `{ ...currentFromDb, ...pickedFromDto }`. **НЕ дзеркали defaults у pick — затре поля які користувач не змінював.**
- **Feature flag без consumer = dead code** (Bug #39): Якщо вводиш у `OrganisationSettings.uiFeatures` новий toggle (`unsavedGuardEnabled`), MUST у тому ж commit / phase підключити hook-консьюмер хоча б до одного реального компонента (мінімум до WorkOrder modal). Інакше toggle обіцяє функціонал, який не реалізовано. Канон: grep на `uiFeatures.<keyName>Enabled` повинен повертати ≥1 use site не у тестах/settings UI.
- **Симетричні useEffect cleanup-и** (Bug #40): Якщо в одному useEffect ввели `let cancelled = false` + check у `.then()`, ОБОВ'ЯЗКОВО додати такий guard і у всі сусідні useEffect-и (event handlers, post-event refetch). Patterns тримати ідентичними у межах файлу.
- **Settings module specs** (Bug #41): Кожен новий controller + DTO у `apps/api/src/modules/*` повинен супроводжуватись хоча б `*.contract.spec.ts`. Без нього: (a) контрактні зміни не помічаються, (b) authz регресії тихі, (c) `forbidNonWhitelisted: true` поведінка не верифікована. Settings контракт-тести використовують fresh Postgres row state per-beforeEach + redisMock без real Redis.

### Gotcha — /sto-review cycle 81534e0 (2026-05-25, Phase 19.2)
- **Role-gated GET endpoint, що споживає всі ролі** — критичний анти-патерн. `useUiFeatures` хук викликається на `/work-orders/[id]` (доступна RECEPTIONIST/MECHANIC/ACCOUNTANT), але `/settings/organisation` має `@Roles('OWNER', 'ADMIN')`. Кожна навігація = 403 в network logs. Канон: для UI-feature-flags / branding / theme — окремий endpoint `/settings/ui-features` з `@Roles` для ВСІХ авторизованих ролей. Те саме стосується будь-яких "загально-читальних" даних, що mount-у завантажуються глобальними хуками.
- **Module-level fetch cache MUST cache failures too** — інакше після першого 403/network-fail кожен mount компонента повторно стрілятиме у backend. Канон: на `.catch` зберігати DEFAULTS у `cache` з коротким TTL (наприклад, 60 сек), щоб recovery після зміни ролі/відновлення мережі залишився можливим.

### Gotcha — /sto-web review + tester cycle 7 (2026-05-25)
- **setup/page.tsx** — публічна сторінка не повинна імпортувати axios-клієнт із auth-interceptors; вона використовує `apiFetch` напряму (без Bearer). Для public endpoints `/setup/*` `apiFetch` правильний вибір (Bug #37-part).
- **mountedRef охоплення**: review cycle 3 підтвердив — після введення `mountedRef` в один файл треба відразу сканувати ВСІХ сусідів що завантажують дані при mount. Решта без guards: `work-orders/page.tsx`, `vehicles/[id]`, `employees/page.tsx`, `catalog/page.tsx` — заплановані на наступний цикл.
- **LowStockItem ≠ StockItem**: `/stock-items/low` повертає агрегований SQL-результат без `id/reserved/available/salePrice`. Завжди мати окремий тип для кожного endpoint (Bug #37-frontend).
- **vitest.config.ts для web**: без нього `pnpm --filter @sto/web test` не підхоплює `src/**/*.test.tsx` — 42 component тести мовчки пропускалися. Виправлено створенням конфігу.

### Gotcha — Phase 19 tester cycle 6 findings (2026-05-25)
- **DTO enum-валідація для FK полів-енумів**: Якщо BD стовпець — `enum` (Postgres ENUM), а DTO приймає `@IsString()`, runtime каст `value as Enum` у Prisma where ламається з `invalid input value for enum`. Канон: завжди `@IsEnum(EnumType)` + типізація `field?: EnumType` у DTO (Bug #33: `PricingRule.goodType`).
- **Relation soft-delete фільтри**: `findStockItems` фільтрував лише `StockItem.deletedAt`, але не `good.deletedAt`/`warehouse.deletedAt`. Узгоджуй з `findLowStockItems` raw SQL (там `g.deletedAt IS NULL`/`w.deletedAt IS NULL`). Канон: будь-який list endpoint з `include` повинен мати `deletedAt: null` фільтр у relation-where (Bug #34).
- **PATCH normalize з merge існуючого стану**: `normalizeScope(dto)` без merge існуючого — НЕ зачіпає поля, які клієнт не передав. PATCH `{ goodCategory: 'X' }` при існуючому `goodId` залишає suite goodId+goodCategory. Канон: `const merged = { ...dto, ...mergedScope }`, потім `normalizeScope(merged)` + explicit `null` для пониззених scope-полів у `UncheckedUpdateInput` (Bug #35).
- **TS interface для API response — не "вільне поле"**: `apiFetch<WrongType[]>` проходить TS, але приховує невідповідність контракту. Завжди писати окремий `interface FooDto { ... }` для кожної API-відповіді, навіть якщо runtime використовує лише `.length` (Bug #36).

### Gotcha — Phase 19 review cycle 4 findings (2026-05-25)
- mountedRef guard pattern: коли вводиш `mountedRef.current` для одного async handler (`load`), застосовуй ТОЙ САМИЙ guard до УСІХ інших async setState handlers у тому ж компоненті (`deleteRule`, `applyAll`, `updateRule`). Інакше навігація під час in-flight операції викличе setState на unmounted (Bug #30 був неповним).
- StockBatch — append-only без `deletedAt` (як StockMovement, SettlementTransaction). Додано до §5 виключень у SKILL.md.

### Gotcha — Phase 19 tester cycle 5 findings (2026-05-25)
- DTO `@Max(N)` ліміти на pagination-параметрах — звіряти на ВСІХ сторінках frontend. Сторінка може використовувати `limit=N+M`, ValidationPipe відкине запит з 400, а soft error-handling (`console.warn` замість throw) сховає проблему від QA. Канон: усі сторінки використовують один і той самий `limit=200` (Bug #32 = пост-фікс Bug #29 розкрив дефект, який жив з самого Phase 19).
- Soft error-handling після fetch — палиця з двома кінцями: захищає UX від rare API-failure, але приховує детермінований bug у параметрах запиту. При додаванні `console.warn`-fallback одразу перевіряти, чи запит сам по собі валідний (curl + ValidationPipe rules).

### Gotcha — Phase 19 tester cycle 4 findings (2026-05-25)
- Hard `BadRequestException` на відсутньому `RECEIPT.price` блокує StockDocument TRANSFER/RECEIPT, бо `StockDocumentLine.price` — `Decimal?`. Канон: fallback на `good.purchasePrice ?? 0`, guard лише на `NaN`. Не повторювати "захист" що ламає сусідній модуль (Bug #26 = регресія від Bug #15).
- При додаванні валідаторів у CreateDTO — **завжди дзеркалити** в UpdateDTO. PATCH без `@Min(0)`/`@Max(N)` зводить нанівець бізнес-інваріант (Bug #27: PATCH `percentValue: -50` → ціна вдвічі менша за собівартість).
- Sub-resource list endpoints (`/goods/:id/batches`, `/goods/:id/price-history`) повинні: (a) перевіряти існування parent у org → 404, (b) повертати `{ items, total }` shape. Bare array + порожній 200 ховає неіснуючий goodId.
- `.catch(() => {})` на fetch у `useEffect` — анти-патерн. Мінімум `console.warn`, щоб QA міг засікти API-failure. Не блокуй UI, але не мовчи.
- `useEffect` для initial-fetch ТА `useCallback load` для refetch після CRUD — дублікація. Один `load` з `mountedRef.current` guard; `useEffect(() => { setLoading(true); load(); }, [load])` для initial.



### Gotcha — Phase 19 cycle 3 review findings (2026-05-25)
- `new Date()` всередині IIFE `(() => { const now = new Date(); return list.map(...)})()` у render — все одно виконується на SSR pass (для 'use client' компонентів, які Next.js 15 pre-renders). Канонічний фікс: `const [nowMs, setNowMs] = useState(0); useEffect(() => setNowMs(Date.now()), []);` + guard `nowMs > 0` у render. Той самий патерн що у `work-orders/page.tsx`.
- `React.ChangeEvent<HTMLInputElement>` без `import type { ChangeEvent } from 'react'` — VSCode TS plugin падає з `Cannot find namespace 'React'`. Завжди іменовані імпорти типів подій з 'react', НЕ `React.*`.
- `@Query('xxxId') id: string` для UUID параметрів — обгорнути `ParseUUIDPipe()`. Без нього невалідний UUID → Prisma P2023 → HTTP 500. Не вказуй `version: '4'` явно (тести часто кидають UUIDs з версією 0 → 400).


### Gotcha — Phase 19 tester findings (2026-05-25)
- `BatchService.createFromReceipt`: при безкоштовному прийомі (`costPrice=0`) — НЕ перезаписувати `Good.salePrice` нулем; партія створюється з `salePrice = Good.salePrice` поточним. Пайтерн: `salePrice = (costPrice > 0 && computed > 0) ? computed : currentSalePrice`.
- `InventoryService.createMovement(RECEIPT, qty>0)` обов'язково має `price` (можна 0). Без price — кидати `BadRequestException`. Інакше quantity++ без батча, далі consumeBatch ламається в FIFO/LIFO/FEFO режимах.
- `getAvgCost(orgId, goodId, warehouseId?)` — третій параметр опціональний. Передавати `undefined` (не `''`) коли потрібна агрегація по всіх складах. Контролер: `getAvgCost(orgId, goodId, warehouseId)` — НЕ `warehouseId ?? ''`.
- `consumeBatch`/`returnToBatch` без `tx` — обертати у `prisma.$transaction(innerTx => self(...innerTx))` рекурсивно, щоб update + log було атомарним.
- `calculateSalePrice` + `findAll PricingRules` — фільтрувати правила, прив'язані до soft-deleted Good: `OR: [{ goodId: null }, { goodId, good: { deletedAt: null } }]`.
- `findAll` для нових list endpoints — завжди `{ items, total, page, limit }` (навіть якщо без реальної пагінації). Майбутні консумери очікують paginated shape.
- `as never` в `where` clause Prisma — анти-патерн. Використовуй явний enum: `goodType: x as GoodType`. Інакше runtime P2009 не вловиться TS.
- Scope-поля в pricing rules взаємовиключні: `goodId` > `goodCategory` > `goodType`. Backend нормалізує (`normalizeScope`), щоб менеджер не зберігав суперечливі дані.
- Value-поля для type обнуляти при PATCH: `PERCENT` зберігає лише `percentValue`, `FIXED_AMOUNT` — `fixedAmount`, `FIXED_PRICE` — `fixedPrice`. Backend `cleanValuesForType()` + frontend `buildPayload()`.
- `margin(sale, cost)` у фронті — захист від `sale=0`: `if (!sale || !cost) return null`. Інакше `NaN%` в UI.

### Gotcha — Phase 19 cycle 2 review findings (2026-05-25)
- `PATCH /pricing-rules/:id` має валідувати `dto.goodId` (cross-tenant attack): POST вже валідує, але UPDATE може змінити goodId на чужий orgId. Якщо updateDTO дозволяє змінити FK поле — перевіряти приналежність до orgId.
- Нова Prisma модель з `syncVersion` → додавати `@@index([orgId, syncVersion])` — без нього sync pull робить full-table scan на `where: { orgId, syncVersion: { gt: since } }`. Перевір кожну нову sync-ready таблицю.
- Icon-only `<Button>` з `title="..."` — потребує також `aria-label` (title HTML attr не завжди читається screen readers як accessible name). Icon-svg всередині → `aria-hidden="true"`.

### Gotcha — Phase 19 batch/pricing review findings (2026-05-25)
- `BatchesController.lookup` потребує `@Roles(...)` явно — без декоратора RolesGuard пропускає будь-кого авторизованого. Завжди додавати roles навіть на read-only endpoints де є cost/price дані.
- `applyRuleToGoods`-стиль операції: prefetch усіх rules один раз, обчислення в пам'яті, batch-update через `$transaction` чанками по 100. Не викликати `calculateSalePrice` в loop (внутрішнє findMany → N+1).
- Нові sync-ready моделі (з `syncVersion`) додавати в `PULL_TABLES` в sync.service.ts. Append-only логи (без syncVersion) — пропускати.
- Custom inline modals (поза `<Modal>` компонентом) — додавати `role="dialog"`, `aria-modal="true"`, `aria-labelledby` + клік на backdrop із `e.stopPropagation()` на body.

### Gotcha — Inline HSL не адаптується в dark mode (Bugs #1-#5)
`text-[hsl(0_84%_42%)]` працює в light mode але **не змінюється** коли `.dark { --color-destructive-text: hsl(0 84% 72%) }` спрацьовує. Завжди використовуй token-класи (`text-destructive-text`, `border-destructive-border`, `text-success-text`, `text-warning-text`, `text-info-text`) — вони підставляють CSS-змінну і автоматично перемикаються в dark mode.

**grep для виявлення регресій:**
```bash
grep -rnE "text-\[hsl\(|border-\[hsl\(|bg-\[hsl\(|ring-\[hsl\(" apps/web/src/app apps/web/src/components --include="*.tsx"
```
Допустимі винятки: purple badge variant (немає purple токена), inventory reserved orange `25_95%_53%`, button destructive hover `0_84%_52%`, input/select destructive focus ring `0_86%_93%`.

### Gotcha — Tailwind 4 arbitrary value must be fully closed (попередній цикл)
`focus:ring-[hsl(0_86%_93%)` (без `]`) **компілюється тихо**, але клас не з'являється в CSS бо JIT не парсить незакриту dynamic-value. Подвійно перевіряй парні `[...]` в усіх `*-[...]` класах при ручному кодуванні. /sto-review має grep на незакриті дужки.

### Gotcha — Blob URL revoke must defer past click()
`URL.revokeObjectURL(url)` викликаний **синхронно** після `a.click()` зриває завантаження в Chromium (іноді). Завжди `setTimeout(() => URL.revokeObjectURL(url), 100)`. Патерн уже застосований у reports/page.tsx — використовуй як еталон.

### Gotcha — useState(() => localStorage.getItem(...)) теж hydration mismatch (review 2026-05-25)
Lazy initializer з `localStorage` має ТУ Ж проблему що `useState(new Date())`: SSR повертає `[]`, клієнт відразу читає збережене → перший рендер клієнта НЕ збігається з server HTML → hydration mismatch warning + DOM patch. Канон: `useState(initialEmpty)` + `useEffect(() => setX(read()), [])`. Виявлено у `useSavedFilters.ts` після початкового feat-комміту.

### Gotcha — Inline edit Check/X button onMouseDown без onClick = no keyboard (review 2026-05-25)
`onMouseDown={e => { e.preventDefault(); commit(); }}` тримає фокус на інпуті (mouse path), але keyboard користувач, який tab'ом дійшов до Check кнопки, активує її через `Enter`/`Space` що генерує `click`, а не `mousedown`. Без `onClick` кнопка мертва для клавіатури. Канон: `onMouseDown` (mouse) + `onClick` (keyboard) — обидва. `useInlineEdit.savingRef` запобігає double-commit.

### Gotcha — Controlled select `value={editing.value}` зриває візуальний вибір при inline-edit (review 2026-05-25)
Якщо select має `value={editing.value}` де `editing.value` НЕ оновлюється при `onChange` (бо ми коммітимо одразу), React насильно повертає select до старого значення під час in-flight save → користувач бачить як його вибір "відскакує". Канон: для inline-edit select використовуй `defaultValue` (uncontrolled) + `onChange` -> `commitEdit(e.target.value)` + `disabled={saving}`.

### Gotcha — Prisma update з `dueDate ? new Date(dto.dueDate) : undefined` не дозволяє очистити поле (review 2026-05-25)
Прийнятий шаблон у багатьох сервісах: `field: dto.field ? transform(dto.field) : undefined`. Це робить поле **не очищуваним**: і коли DTO не передає поле (undefined), і коли передає `null` — Prisma отримує `undefined` і ПРОПУСКАЄ оновлення. Inline-edit з кнопкою "очистити" не працює. Канон у Update методах для nullable полів: `field: dto.field === undefined ? undefined : dto.field === null ? null : transform(dto.field)`. DTO має бути типу `string | null`, з `@IsOptional() @IsISO8601()` (валідація скіпається на null).

### Gotcha — onSave handler без try/catch ховає помилки від користувача (review 2026-05-25)
Хук `useInlineEdit` ловить помилку з `onSave` тільки щоб скинути `savingRef`, але НЕ показує її. Якщо викликаюча сторона теж не loger'ує — користувач бачить що нічого не сталося (без toast про помилку, без `error` state). Канон: `onSave: async (...) => { try { await apiFetch(...); toast.success(...); load(); } catch (e) { toast.error(msg); throw e; } }` — throw зберігає editing state для повторного спробування.

---

## Поточний стан проєкту

| Параметр | Значення |
|---|---|
| Фаза | **Фаза 17 — Enums, enriched models, MaintenanceSchedule + CompletionAct** (завершено + QA) |
| Прогрес | 17.1-17.3✅ backend + frontend + QA review |
| TypeScript | ✅ 0 errors (web + api + shared) — verified 2026-05-25 cycle 5 |
| Unit тести | ✅ 111/111 passed (включно з contract і property у 12 файлах) |
| Contract тести | ✅ 32/32 passed (auth: 9, work-orders: 6, pricing-rules: 13, batches: 4) |
| Property-based | ✅ 26/26 passed (fsm: 11, inventory: 7, settlements: 8) |
| Component тести | ✅ 42/42 passed (button: 12, select: 9, modal: 11, empty-state: 10) |
| E2E тести | ✅ 16/16 Playwright passed (smoke: 4, inventory: 5, api-errors: 8 — minus 1 dedup) |
| Build | ✅ API build OK (webpack 9.3s) |
| Dev сервер | Next.js на `http://localhost:3001`, API на `http://localhost:3000` |
| CSS | Tailwind 4 через `@tailwindcss/postcss` (postcss.config.mjs) |

### Test coverage closed this cycle (Bugs #10-#13)
- **Bug #10** — добавлено supertest + 15 contract тестів (auth + work-orders) використовуючи Fastify `app.inject()`
- **Bug #11** — встановлено fast-check@4 + 26 property-based тестів (FSM, inventory, settlements). Грошові суми зберігаються в integer cents щоб уникнути 32-bit float обмежень fast-check.
- **Bug #12** — встановлено @testing-library/react + @vitejs/plugin-react@4 (v6 несумісний з vitest 2.1 через Vite 6). Vitest config в `vitest.config.mts` (ESM). 42 component тести.
- **Bug #13** — додано `api-errors.spec.ts` + `inventory.spec.ts` (13 E2E тестів, error resilience + auth guard).

### Gotcha — @vitejs/plugin-react version pinning
- vitest@2.1 (uses Vite 5) **несумісний** з @vitejs/plugin-react@6 (requires Vite 6) — кидає `ERR_PACKAGE_PATH_NOT_EXPORTED` для `vite/internal`
- Рішення: pin @vitejs/plugin-react@^4.3.0
- Config file має бути `.mts` (не `.ts`) щоб подружитися з ESM-only плагіном

### Gotcha — fast-check float constraints
- `fc.float({ min: 0.01, max: 100_000 })` кидає "constraints.min must be a 32-bit float"
- Для грошових сум використовуй `fc.integer({ min: 1, max: 10_000_000 })` (центи)
- Це додатково усуває помилки округлення IEEE 754 у тестах

### Critical bugs fixed this session
- **Bug #7** — `DocumentNumberService.next()` використовував snake_case у raw SQL → ламав створення WO/Invoice/PO/StockDocument. Виправлено: camelCase з лапками + `LIMIT 1`.
- **Bug #8** — `InventoryService.findLowStockItems()` використовував snake_case → `GET /stock-items/low` 500. Виправлено: camelCase з лапками.

### Gotcha — Canonical Tailwind tokens for semantic colors (Phase 17)
`globals.css` defines `-text` and `-border` variants for all semantic colors for use on subtle backgrounds:
- `text-destructive-text` / `border-destructive-border` — dark red on `bg-destructive-subtle`
- `text-success-text` / `border-success-border` — dark green on `bg-success-subtle`
- `text-warning-text` / `border-warning-border` — dark amber on `bg-warning-subtle`
- `text-info-text` / `border-info-border` — dark teal on `bg-info-subtle`
Never use raw `text-[hsl(0_84%_42%)]` etc. — use the token. `badge.tsx` already updated.

### Gotcha — Recharts inline styles must use CSS var() not hsl()
Recharts `stroke`, `fill`, `tick.fill`, `contentStyle.border` are JS style strings.
Use `var(--color-border)` not `hsl(214 32% 91%)`, `var(--color-primary)` not `hsl(221 83% 53%)`,
`var(--color-muted-foreground)` not `hsl(215 16% 55%)`, `var(--color-primary-subtle)` not `hsl(214 95% 97%)`.

### Gotcha — MaintenanceSchedule API supports single vehicleId only
`GET /maintenance-schedules?vehicleId=X` accepts one vehicleId at a time.
To fetch schedules for multiple vehicles (e.g. CRM garage tab), fire parallel calls per vehicle
and merge results client-side. Do NOT fetch all org schedules and filter client-side.

### Gotcha — Контракт endpoints: завжди `{ items, total }`, ніколи bare array
- Усі list endpoints у проєкті повертають paginated shape `{ items, total, page?, limit? }` — `work-orders`, `invoices`, `purchase-orders`, `maintenance-schedules` (масив бо ≤200), `completion-acts` (тепер `{ items, total }` після Bug #1).
- Frontend всюди робить `apiFetch<{ items: X[] }>(...)` — якщо сервіс повертає bare array, `.items` → `undefined.length` → TypeError. У комбінації з `.catch(() => {})` баг ховається.
- При додаванні нового list endpoint — **завжди** обертай у paginated DTO навіть якщо `take` фіксовано.

### Gotcha — FSM bypass всередині cross-service transactions
- При підписанні CompletionAct авто-переводимо WO у `INVOICED`. Спокусливо зробити `tx.workOrder.update({ status: 'INVOICED' })` — це **обходить** FSM map. Окрім втрати валідації, такий код:
  1. Робить race vікно (читання act поза tx, write всередині)
  2. Дозволяє duplicate transitions якщо хтось паралельно перевів WO іншим шляхом
- Правильно: re-read entity **всередині** tx + явна перевірка status (`if (workOrder.status === 'COMPLETED')`) + єдиний `update`.

### Gotcha — Auto-side-effect помилки: log non-business, suppress only expected
- Фон. дія типу `this.invoices.createFromWorkOrder().catch(() => {})` ковтає ВСЕ. Згодом баг "чому рахунки не створюються?" дуже важко відловити.
- Шаблон: `.catch(e => { const msg = e.message; if (!msg.includes('очікувана_бізнес-помилка')) logger.warn(...) })`.

### Gotcha — Soft delete у relation filters
- `findMany({ where: { vehicle: { deletedAt: null }, ... } })` — Prisma підтримує relation-фільтри. Без цього widget "Наближається ТО" показує авто, які користувач уже видалив.
- Правило: будь-яка `findMany` що рендериться у UI через FK має додавати `relation: { deletedAt: null }`.

### Gotcha — Selective recalc у PATCH — recompute тільки коли input змінено
- ❌ BAD: `const next = dto.next ?? calc(...)` — будь-який PATCH перераховує і затирає існуюче значення (`calc` може дати null якщо інтервалу немає в БД).
- ✅ GOOD: `const shouldRecalc = INPUT_FIELDS.some(f => dto[f] !== undefined); const next = shouldRecalc ? calc(...) : existing.next`
- Стосується: MaintenanceSchedule.update (виправлено), будь-який інший derived field.

### Gotcha — Raw SQL camelCase identifiers
Prisma schema **без `@map`** → Postgres колонки double-quoted camelCase (`"orgId"`, `"goodId"`, `"deletedAt"`, `"minStock"`, тощо). Будь-який `$queryRaw` / `$executeRaw` повинен:
- Використовувати **camelCase з лапками**: `WHERE "orgId" = ${orgId}::uuid`
- Не покладатись на Postgres lowering (`org_id` → не знайде `"orgId"`)
- Перевірити проти `information_schema.columns` перед написанням

---

## Архітектура — де що живе

```
apps/
  api/                     NestJS 10 + Fastify  (port 3000)
    src/
      app.module.ts        ← реєстрація всіх модулів
      auth/                ← JWT (access 15хв Bearer + refresh 30д httpOnly cookie)
        auth.service.ts    ← login / refresh / logout
        auth.spec.ts       ← 8 unit-тестів (vitest)
        guards/            ← JwtAuthGuard, RolesGuard
        decorators/        ← @OrgContext(), @Roles(), @CurrentUser()
      prisma/
        prisma.service.ts  ← PrismaClient + soft-delete middleware (syncVersion auto-increment)
      modules/             ← 28 доменних модулів (по 1 на сутність)
  web/                     Next.js 15 static export  (port 3001)
    src/
      app/
        layout.tsx         ← AuthProvider → TopShell (всі маршрути захищені)
        globals.css        ← Tailwind 4 @theme токени + .page-* + .kpi-card-* класи
        (auth)/login/      ← публічний маршрут (split-panel layout)
        setup/             ← публічний маршрут (перший запуск)
        dashboard/         ← KPI-картки + recharts
        work-orders/       ← список + detail [id]/
        crm/               ← контрагенти + detail [id]/
        vehicles/          ← [id]/ detail
        calendar/          ← слоти підйомників/механіків
        inventory/         ← залишки
        purchase-orders/   ← замовлення постачальникам
        stock-documents/   ← списання / переміщення / початкові залишки
        invoices/          ← рахунки
        settlements/       ← розрахунки
        reports/           ← звіти
        catalog/           ← роботи, товари, послуги
        employees/         ← співробітники
        infrastructure/    ← філії, зони, підйомники, склади
        settings/          ← налаштування + sync/
        403/               ← сторінка помилки доступу
      components/
        TopShell.tsx       ← sidebar (3 секції: Документи/Звіти/Довідники) + bookmarks + avatar
        ui/
          button.tsx       ← Variant: primary|secondary|outline|ghost|destructive|link|default
          input.tsx        ← props: label, errorMessage, hint, leftElement, rightElement
          select.tsx       ← props: label, errorMessage, hint, placeholder
          badge.tsx        ← variants: default|success|warning|destructive|info|outline
          card.tsx         ← Card, CardHeader, CardContent, CardFooter
          modal.tsx        ← prop: footer (кнопки дій), title, children
          table.tsx        ← Table, Thead, Tbody, Tr, Th, Td
          spinner.tsx      ← розміри: xs|sm|md|lg + PageSpinner + InlineSpinner
          empty-state.tsx  ← розміри: sm|md|lg
          detail-panel.tsx ← inline flex panel w-80/w-0, slide transition, title + X close
      lib/
        api-client.ts      ← apiFetch<T>() з auto-refresh токена
        auth.ts            ← TOKEN_KEY, useAuth(), AuthProvider
packages/
  database/
    prisma/schema.prisma   ← 41 модель, 15 enum-ів
  shared/
    src/
      types.ts             ← BaseEntity, SyncRecord, PaginatedResponse, UserRole, ...
      schemas.ts           ← Zod схеми (uuidSchema, paginationSchema, ...)
      constants.ts         ← uk-UA locale, timezone, currency constants
```

---

## Всі API модулі (28)

| Модуль | Файл | Ключові методи |
|---|---|---|
| `branches` | `branches.service.ts` | findAll, findOne, create, update, delete (soft) |
| `calendar` | `calendar.service.ts` | findSlots, createSlot, updateSlot, deleteSlot — conflict check |
| `counterparties` | `counterparties.service.ts` | CRUD + garages sub-resource |
| `document-number` | `document-number.service.ts` | `next(orgId, type)` → генерує номер по `DocumentNumberConfig` |
| `employees` | `employees.service.ts` | CRUD + zones/lifts/categories M:M |
| `files` | `files.service.ts` | upload/download через MinIO |
| `goods` | `goods.service.ts` | CRUD + пошук по sku/barcode |
| `inventory` | `inventory.service.ts` | **`createMovement()`** ← ЄДИНА точка мутації stock |
| `invoices` | `invoices.service.ts` | CRUD + `markPaid()` |
| `notifications` | `notifications.service.ts` | BullMQ → SMS/Viber/Email через шаблони |
| `payment-methods` | `payment-methods.service.ts` | CRUD довідника способів оплати |
| `payments` | `payments.service.ts` | create → `SettlementsService.createTransaction(PAYMENT)` |
| `purchase-orders` | `purchase-orders.service.ts` | CRUD + confirm → stock RECEIPT |
| `reports` | `reports.service.ts` | revenue, stock-value, employee-performance |
| `services` | `services.service.ts` | CRUD пакетів послуг (Work+Good bundle) |
| `settings` | `settings.service.ts` + `document-numbering.service.ts` | get/set org settings, numbering config |
| `settlements` | `settlements.service.ts` + `settlements-account.service.ts` | **`createTransaction()`** ← ЄДИНА точка мутації balance |
| `setup` | `setup.service.ts` | `POST /setup` — перший запуск, seed org+admin |
| `stock-documents` | `stock-documents.service.ts` | WRITEOFF / TRANSFER / OPENING_BALANCE |
| `sync` | `sync.service.ts` | pull(since) + push(records) + getStatus() |
| `vehicles` | `vehicles.service.ts` | CRUD + vehicleNodes sub-resource |
| `warehouses` | `warehouses.service.ts` | CRUD |
| `work-categories` | `work-categories.service.ts` | CRUD ієрархії категорій |
| `work-orders` | `work-orders.service.ts` | CRUD + FSM `transition()` + lines + parts |
| `works` | `works.service.ts` | CRUD норм-годин |
| `zones` | `zones.service.ts` | CRUD + lifts sub-resource |

---

## Критичні бізнес-правила (завжди пам'ятати)

### FSM нарядів (`work-orders.fsm.ts`)
```
DRAFT → ESTIMATE → APPROVED → IN_PROGRESS → COMPLETED → INVOICED → PAID → ARCHIVED
         ↕            ↕          ↕
       DRAFT      CANCELLED  ON_HOLD ↔ IN_PROGRESS
                             CANCELLED
```
- `IN_PROGRESS`: `InventoryService.createMovement(RESERVATION)` для кожної запчастини
- `COMPLETED`: `createMovement(RESERVATION_RELEASE)` + `createMovement(WRITEOFF)` + `SettlementsService.createTransaction(CHARGE)` — у `$transaction`
- `CANCELLED` з `IN_PROGRESS`/`ON_HOLD`: `createMovement(RESERVATION_RELEASE)`
- Файл FSM: `apps/api/src/modules/work-orders/work-orders.fsm.ts`

### Інвентар — захисти в `inventory.service.ts`
- `qty = 0` → `BadRequestException`
- `RESERVATION_RELEASE` з `qty > 0` → `BadRequestException`
- `RESERVATION` якщо `available < qty` → `BadRequestException`
- `WRITEOFF` якщо `quantity < |qty|` → `BadRequestException`

### Розрахунки — дельти балансу (`settlements.service.ts`)
- `CHARGE` → `+amount` (клієнт нам винен)
- `PAYMENT`, `PREPAYMENT`, `REFUND`, `CREDIT_NOTE` → `-amount`

### Soft delete — винятки (БЕЗ `deletedAt`)
Ці моделі не мають поля `deletedAt` — не фільтрувати:
- `SettlementAccount`, `SettlementTransaction`, `StockMovement`, `Payment`, `WorkOrderLineEmployee`

### Tenant isolation
- Кожен `findFirst`/`findMany` — завжди `where: { orgId, ... }`
- `create` — `{ ...dto, orgId }` де `orgId` ОСТАННІЙ (щоб перезаписати forged field)

---

## Фаза 16 прогрес (поточна сесія, 2026-05-25)

### Завершено (backend)
- **16.1** — Brand model (CRUD /brands) + Good.brandId FK + UI Select у формі товару
  - Files: `packages/database/prisma/schema.prisma`, `apps/api/src/modules/brands/`
  - Migration: `20260524221751_add_brand_model`
  - UI: GoodsTab form з Brand Select
- **16.2** — GoodBarcode model + endpoints (GET/POST/DELETE /goods/:goodId/barcodes)
  - Migration: `20260524221943_add_good_barcodes`
  - Service: getBarcodes, createBarcode, deleteBarcode
- **16.3** — UnitOfMeasure model + UnitsModule (CRUD /units-of-measure)
  - Migration: `20260524222044_add_units_of_measure`
  - Good.unitId FK для зворотної сумісності
- **16.4** — XLSX_MANAGER role додана до UserRole enum
  - Migration: `20260524222133_add_xlsx_manager_role`
- **16.5** — XlsxModule (/xlsx) з exceljs
  - Templates: goods, works, brands, units, po-lines, sd-lines, wo-parts
  - Parse методи: parseGoods, parseWorks, parseBrands, parseUnits, parsePOLines
  - Import endpoints: POST /xlsx/import/goods, brands, units
  - Результат: {created, updated, errors[]}
- **16.7** — CRM default garage auto-creation
  - CounterpartiesService.create() → auto-create CustomerGarage(name='Основний', isDefault=true)
  - Migration: `20260524222539_add_customer_garage_is_default`

### Завершено (frontend, 2026-05-25 session 2)
- **16.2** ✅ — Barcodes DetailTab (info/barcodes tabs, add/delete, Star isPrimary icon)
- **16.3** ✅ — Units select у GoodsTab form + UnitsTab CRUD у /catalog
- **16.4** ✅ — XLSX_MANAGER у ROLE_LABELS (TopShell + employees page)
- **16.5** ✅ — XlsxImportButton component + toolbar integration у GoodsTab, WorksTab
- **16.7** ✅ — isDefault badge у гаражах (CRM card)
- **16.8** ✅ — CRM /crm/[id]/PageClient повністю 4 таби з inline edit, accordion garages
- **16.9** ✅ — Nav mode toggle (NAV_GROUPS_FUNCTIONS + navMode state + localStorage)
- **16.10** ✅ — color-mode.ts + ColorModeProvider + anti-flash script + dark CSS vars + settings UI

### TODO (залишилось)
- **16.6** — XLSX import для PO/SD/WO лінійок (бекенд + фронтенд)
- **16.10** — Skeleton dark variant у globals.css

## Архітектура змін Фаза 16

### 16.1 Довідник брендів + розширення Good
- Нова модель `Brand` (orgId, name unique per org)
- `Good.brandId` (optional FK → Brand)
- `BrandModule` CRUD `/brands`
- У формі товару: Select бренду + inline "+ Новий бренд"

### 16.2 Штрихкоди — окрема вкладка в картці товару
- Нова модель `GoodBarcode` (goodId, barcode, type, isPrimary). Append-only (без deletedAt).
- `@@index([orgId, barcode])` для швидкого пошуку по скануванню
- В `/catalog` Goods tab: розгортається модалка/слайд з 2 вкладками "Основна" + "Штрихкоди"
- Endpoints: `GET/POST/DELETE /goods/:id/barcodes`

### 16.3 Одиниці виміру
- Нова модель `UnitOfMeasure` (orgId, name, shortName unique per org, isSystem). Seed: шт, кг, л, м, компл, пара, набір, уп, рул, м²
- `Good.unitId` (optional FK) + зворотна сумісність з `Good.unit String`
- `UnitsModule` CRUD `/units-of-measure`
- Select у формі товару

### 16.4 Нова роль XLSX_MANAGER
- Додати до `UserRole` enum значення `XLSX_MANAGER`
- Захист всіх XLSX-endpoints через `@Roles('OWNER', 'ADMIN', 'XLSX_MANAGER')`
- UI: роль відображається в `ROLE_LABELS`, доступна при створенні співробітника

### 16.5 XLSX-імпорт довідників
- `XlsxModule` (`/xlsx`), використовує **exceljs** (npm)
- `GET /xlsx/templates/:type` — завантажити шаблон (goods | works | brands | units)
- `POST /xlsx/import/:type` — multipart .xlsx → upsert + відповідь `{ created, updated, errors }`
- Компонент `XlsxImportButton` — пара кнопок "Шаблон" + "Імпорт" з результатом toast
- Інтегрувати у `/catalog` (Товари, Роботи, Бренди вкладки)

### 16.6 XLSX-імпорт табличних частин
- `POST /xlsx/import/purchase-order-lines/:poId` — SKU+qty+price → POLines (тільки DRAFT)
- `POST /xlsx/import/stock-document-lines/:docId` — аналогічно StockDocument (DRAFT)
- `POST /xlsx/import/work-order-parts/:woId` — аналогічно WorkOrder (DRAFT/ESTIMATE)
- Шаблони: `GET /xlsx/templates/po-lines`, `sd-lines`, `wo-parts`
- `XlsxImportButton` в картці PO, StockDoc, WorkOrder

### 16.7 CRM — гараж "Основний" за замовчуванням
- `CustomerGarage.isDefault Boolean @default(false)` — нове поле, міграція
- `POST /counterparties` автоматично створює гараж з назвою "Основний" і `isDefault: true`
- Основний гараж відображається першим із позначкою в UI

### 16.8 CRM — картка клієнта (вкладки)
- `/crm/[id]` реорганізована в 4 вкладки:
  1. **Загальна інформація** — поля + редагування inline
  2. **Гаражі та авто** — accordion гаражів, у кожному список авто + "Додати авто", форма "Додати гараж"
  3. **Взаєморозрахунки** — баланс + транзакції
  4. **Наряди** — наряди цього контрагента

### 16.9 Налаштування навігації
- `localStorage` ключ `sto_nav_mode`: `'sections'` | `'functions'`
- Режим **"По розділах"** (default): Документи / Звіти / Довідники (поточний)
- Режим **"По функціях"**: плоска структура без секцій, порядок: Дашборд, Наряди, Календар, CRM, Склад, Замовлення, Документи складу, Рахунки, Розрахунки, Звіти, Каталог, Персонал, Підрозділи, Налаштування, Cloud Sync
- Перемикач у `/settings` вкладка "Оформлення"
- `TopShell.tsx` зчитує `sto_nav_mode` через useEffect (SSR-safe)

---

## UI Patterns (2026-05-25)

### Navigation структура TopShell
```
Секція "Документи":  /work-orders, /invoices, /purchase-orders, /stock-documents
Секція "Звіти":      /calendar, /settlements, /reports (OWNER/ADMIN/ACCOUNTANT)
Секція "Довідники":  /crm, /inventory, /catalog, /employees, /infrastructure, /settings, /settings/sync
```
- `ALL_NAV_ITEMS` — flat array для bookmark lookup
- `BOOKMARKS_KEY = 'sto_bookmarks'` — localStorage, SSR-safe (useState([]) → useEffect hydrate)
- Star button: `opacity-0 group-hover:opacity-100`, `fill-current` коли активна

### DetailPanel — патерн використання
```tsx
import { DetailPanel } from '@/components/ui/detail-panel';

// State
const [selectedItem, setSelectedItem] = useState<Item | null>(null);

// Layout (після таблиці або навколо)
<div className="flex gap-0">
  <div className="flex-1 min-w-0 overflow-auto border border-border rounded-xl">
    <Table>
      <TableBody>
        {items.map(item => (
          <TableRow key={item.id} onClick={() => setSelectedItem(s => s?.id === item.id ? null : item)}>
            ...
            <TableCell>
              <Button onClick={e => { e.stopPropagation(); /* action */ }}>...</Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  </div>
  <DetailPanel
    open={!!selectedItem}
    onClose={() => setSelectedItem(null)}
    title={selectedItem?.name ?? ''}
  >
    {/* detail content */}
  </DetailPanel>
</div>
```

### Soft Delete UI — патерн
- **Немає кнопки "Видалити"** — лише "Помітити на видалення"
- Кнопка: `variant="ghost"` + `Trash2` icon + `text-muted-foreground hover:text-destructive hover:bg-destructive/10`
- Confirm: `'Помітити X на видалення?'` (не "Видалити X?")
- Toggle "Показати видалені": Eye/EyeOff icon, `?showDeleted=true` у API params
- Видалені рядки: `opacity-60` + Badge variant="secondary" "видалено"
- Виняток: `StockItem`, `StockMovement`, `SettlementTransaction`, `Payment`, `WorkOrderLineEmployee` — не мають `deletedAt`

---

## Design System (Tailwind 4)

### Ключові токени (`globals.css` → `@theme`)
```
--color-brand-{50..900}    ← синя шкала (primary)
--color-primary            = brand-600 (#2563eb)
--color-primary-hover      = brand-700
--color-sidebar-bg         = hsl(224 44% 13%)   ← темно-синій sidebar
--color-sidebar-fg         = hsl(213 31% 85%)
--color-border             = hsl(214 32% 91%)
--color-border-hover       = hsl(214 32% 80%)
```

### Canonical Tailwind 4 синтаксис (IDE перевіряє!)
```
✅ border-border           ❌ border-(--color-border)
✅ ring-brand-100          ❌ ring-(--color-brand-100)
✅ hover:border-border-hover ❌ hover:border-(--color-border-hover)
✅ bg-secondary            ❌ bg-(--color-secondary)
```
Виключення: якщо токен НЕ в `@theme` (кастомний hsl) — тоді `bg-[hsl(...)]`.

### Утилітні CSS-класи
```css
.page-container    ← max-w + padding для всіх сторінок
.page-header       ← flex row між заголовком та діями
.page-title        ← h1 стиль
.page-subtitle     ← підзаголовок muted
.kpi-card-blue/green/amber/red/violet/teal  ← кольори KPI-карток
```

### Button variants
`primary` | `secondary` | `outline` | `ghost` | `destructive` | `link` | `default` (= outline)

---

## Prisma — всі 41 моделей

**Infrastructure:** Organisation, GarageBranch, Zone, Lift, Warehouse, BranchSettings, OrganisationSettings, DocumentNumberConfig, TaxRate, PaymentMethodConfig, NotificationTemplate

**Auth:** AuthAccount

**CRM:** Counterparty, CustomerGarage, Vehicle, VehicleNode

**Catalog:** WorkCategory, Work, Good, Service, ServiceWork, ServiceGood

**Employees:** Employee, EmployeeZone, EmployeeLift, EmployeeWorkCategory

**Work Orders:** WorkOrder, WorkOrderLine, WorkOrderLineEmployee, WorkOrderPart

**Inventory:** StockItem, StockMovement, StockDocument, StockDocumentLine, PurchaseOrder, PurchaseOrderLine

**Finance:** Invoice, Payment, SettlementAccount, SettlementTransaction, ReconciliationAct

**Scheduling:** CalendarSlot

**Sync:** SyncJob

### Обов'язкові поля КОЖНОЇ моделі
```prisma
id          String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
orgId       String   @db.Uuid
createdAt   DateTime @default(now())
updatedAt   DateTime @updatedAt
deletedAt   DateTime?
syncVersion BigInt   @default(0)
```

---

## Синхронізація (`sync.service.ts`)

- **Pull tables** (read-only для клієнта): `work_orders`, `work_order_lines`, `work_order_parts`, `counterparties`, `vehicles`, `customer_garages`, `stock_items`, `invoices`, `payments`, `calendar_slots`
- **Push-safe tables**: `counterparties`, `vehicles`, `customer_garages`, `calendar_slots`
- **Pull blacklist**: `counterparties → phone, edrpou, email` (не відправляти на мобільний)
- **Push whitelist**: по таблиці — тільки дозволені поля проходять
- **Delta-sync**: `WHERE orgId = ? AND syncVersion > ?`
- **FK validation при push**: `liftId`, `employeeId`, `workOrderId` → перевірка по `orgId`

---

## Автоматичний QA флоу (після кожного завдання)

```
завдання виконано + git commit
        │
        ▼
  /sto-review (auto)
  — code review, фіксує всі знайдені проблеми
        │
        ▼
  /sto-tester (auto)
  — BUG_REPORT.md, фіксує всі баги
        │
        ▼
  MemoryManual.md update
  — нові gotchas / зміни архітектури
        │
        ▼
  git commit "docs(memory): ..."
```

> Не запускається рекурсивно якщо запит сам по собі був `/sto-review` або `/sto-tester`.

## Щогодинний моніторинг (loop)

- **Cron**: кожну годину о :13 (налаштовано через CronCreate)
- **Файл промпту**: `.claude/scheduled_tasks.json`
- **Дія**: читає `MemoryManual.md` + `PHASES.md` + `MEMORY.md`, визначає стан, продовжує або запускає QA
- **Обмеження**: cron живе тільки в рамках сесії. При старті нової сесії — `/loop 1h`

## Скіли Claude Code

| Скіл | Коли використовувати |
|---|---|
| `/sto-context` | **ЗАВЖДИ ПЕРШИМ** — читає `docs/PHASES.md`, показує статус |
| `/sto-analyst` | Вимоги, user stories, бізнес-процеси |
| `/sto-feature` | Планування нової фічі (до коду) |
| `/sto-architect` | ADR, архітектурні рішення |
| `/sto-database` | Зміни `schema.prisma`, міграції |
| `/sto-backend` | NestJS модуль (DTO + Service + Controller + spec) |
| `/sto-web` | Next.js сторінки і компоненти |
| `/sto-mobile` | Expo / React Native |
| `/sto-review` | Code review + TypeScript errors (`tsc --noEmit`) |
| `/sto-tester` | Автотестування: знаходить баги → `BUG_REPORT.md` → фіксить |
| `/sto-installer` | Inno Setup + PowerShell installer |
| `/sto-git` | Commits, branches, changelog |

**Workflow нової фічі:**
```
/sto-context → /sto-analyst → /sto-feature → /sto-database → /sto-backend → /sto-web → /sto-review → /sto-tester
```

---

## Відомі пастки (gotchas)

| # | Пастка | Правильно |
|---|---|---|
| 1 | `Button asChild` — не підтримується | Використовуй `<Link>` з inline Tailwind |
| 2 | `deletedAt: null` у `SettlementAccount` — поля немає | Не додавати фільтр на цих моделях |
| 3 | Tailwind 4: `border-(--color-border)` не canonical | `border-border` якщо токен є в `@theme` |
| 4 | `orgId` у `create` йде ОСТАННІМ | `{ ...dto, orgId }` — щоб перекрити forged field |
| 5 | Timezone Київ — не хардкодити `+03:00` | `kyivOffsetMs()` через `Intl.DateTimeFormat` (DST) |
| 6 | `setup/` маршрут — без `AuthProvider` shell | Окремий `layout.tsx` без `TopShell` |
| 7 | Пряме `prisma.stockItem.update` — заборонено | Тільки `InventoryService.createMovement()` |
| 8 | Пряме `prisma.settlementAccount.update` — заборонено | Тільки `SettlementsService.createTransaction()` |
| 9 | `postcss.config.mjs` — критичний файл | Без нього Tailwind 4 не генерує CSS у Next.js |
| 10 | `Select placeholder` — НЕ нативний HTML атрибут | Рендериться як `<option value="" disabled>` |
| 11 | Hydration mismatch: `border-primary` у spinner на root page | SSR резолвить у `border-blue-600`, клієнт лишає `border-primary` → різні рядки. Фікс: `border-(--color-primary)` — CSS var-синтаксис identity-stable на обох сторонах |
| 12 | `new Date().toLocaleDateString(...)` у render path | SSR рендерить у UTC, клієнт у Europe/Kyiv → mismatch. Фікс: `useEffect(() => setState(...), [])` |
| 13 | `createPortal(…, document.body)` без SSR-гарду | `document` відсутній під час prerender. Фікс: `const [mounted, setMounted] = useState(false); useEffect(() => setMounted(true), [])` |
| 14 | Глобальний `saving` стан у списку | Всі рядки таблиці потрапляють у loading. Фікс: `savingId: string | null` — по одному рядку |
| 15 | `transition()` без `$transaction` | Між findFirst і update може змінитись статус (race condition). Фікс: загорнути обидва у `prisma.$transaction` |
| 16 | `RESERVATION_RELEASE` без перевірки `reserved >= qty` | Від'ємний резерв у StockItem. Фікс: перевірити `Math.abs(dto.quantity) > reserved` |
| 17 | `React.ReactNode` без імпорту → 56 VSCode помилок | Next.js TS plugin суворіший ніж plain `tsc`. Фікс: `import type { ReactNode } from 'react'` і `ReactNode` напряму. Grep: `grep -rn "React\." apps/web/src/ --include="*.tsx"` |
| 18 | `tsc --noEmit` приховує помилки через `incremental` кеш | `Check time: 0.00s` — кеш пропускає перевірку. Фікс: `tsc --noEmit --incremental false` |

---

## Команди розробки

```bash
# Запуск (dev)
docker-compose -f docker-compose.dev.yml up -d   # DB + Redis + MinIO
pnpm dev                                          # API :3000 + Web :3001

# TypeScript перевірка
pnpm --filter @sto/web exec tsc --noEmit
pnpm --filter @sto/api exec tsc --noEmit

# Тести
pnpm --filter @sto/api test --run

# Prisma
pnpm --filter @sto/database prisma migrate dev --name <name>
pnpm --filter @sto/database prisma studio

# Build
pnpm --filter @sto/api build
pnpm --filter @sto/web build
```

---

## Changelog (останні коміти)

| Hash | Опис |
|---|---|
| `f70c7c7` | docs(tester): record Bugs #61-#67 from /sto-tester FULL pass + update MemoryManual |
| `aef124b` | fix(tester): Bugs #61-#67 — search reservedQty column, /branches shape mismatch, invoice PDF Bearer fetch, employees filter DTO, palette deep-link, WO template orgId scope + description prefix |
| `4cc4e6f` | fix(review): Phases 21-22 — TDZ, broken pdfmake, employeeId filter, polymorphic entityType, comment DELETE auth, SSR-unsafe localStorage, search ordering |
| `ef146d3` | feat(phases21-22): B6 search, B7 PDF, B10 branch ACL, F1-F2-F6-F8-F10-F12 UX features |
| `c938dc0` | fix(review): invoices page — mountedRef guards on all setState-after-await, selectTokenRef to drop stale detail responses on fast row-switching |
| `a60d3d3` | fix(review): Group 3 — SSR safety (useSavedFilters), a11y (Check/X onClick), nullable dueDate, uncontrolled priority select |
| `aed69c3` | fix(review): Command Palette + keyboard shortcuts — 7 issues (shift+/, useMemo deps, focus trap, a11y) |
| `bef35b7` | fix(tester): 6 bugs (settlement validate, low-stock LIMIT, CSV revoke, take, +tests) |
| `9295d6e` | fix(review): N+1 work-categories descendants + dead findOneDetail |
| `4910014` | docs(skills): hydration trap useState(new Date()) + missing tsconfig check |
| `183f20d` | fix(review): hydration mismatches + process.env in service + missing tsconfigs |
| `a11580d` | fix(api): take:1000 safety guard on FK-bounded findMany |
| `00cb288` | chore(claude): simplify settings.local.json — wildcard bash permissions |
| `be1be58` | docs(memory): update MemoryManual after review pass |
| `8cbbcb3` | fix(review): take limits on list/report queries + canonical shadow-xs |
| `6bbcb58` | feat(workflow): continuous skill self-improvement after every review/test |
| `2d34e4d` | feat(skills): overhaul sto-review — 11 sections: memory leaks, security, perf |
| `f317ae5` | fix(web): remove React namespace (56 VSCode errors) + skill auto-mode + models |
| `f2c8a9c` | fix(review): apply sto-review auto-fix pass — 11 bugs resolved |
| `ec6acac` | fix(web): fix hydration mismatch on root page spinner |
| `394156d` | feat(workflow): hourly loop + auto QA after every task |
| `d9ebecd` | docs(memory): add MemoryManual.md + wire into session flow |
| `11b468b` | feat(skills): add /sto-tester skill |
| `900c24b` | fix(web): Button 'default' variant + Select placeholder prop |
| `a6cafd5` | fix(web): postcss.config.mjs — Tailwind 4 CSS processing |
| `29cb3da` | feat(web): redesign crm, work-orders, calendar, dashboard, vehicles |
| `c57e85b` | fix(review): remove as any from auth.spec.ts |
| `f511ea8` | fix(review): Tailwind tokens in 403, setup, root, auth pages |
| `aa79a5b` | fix(review): Tailwind tokens in settings, calendar, detail pages |
| `df612e7` | feat(web): redesign catalog, employees, infrastructure, reports, settlements |
| `d415d8a` | fix(review): Tailwind tokens in settlements and reports |
| `27fbb06` | fix(review): any types + Tailwind tokens across web pages |
| `5802de7` | feat(web): full UI redesign — design system, components, pages |
| `b203ab0` | fix(services): validate workId/goodId FK ownership |
| `ebb31f3` | fix(web): NaN/invalid numeric input guards |
| `4bce74e` | fix(web): form validation + modal error guard |
| `bd8558f` | fix(review): DTO spread orgId override + zero-amount charge guard |

---

*Файл генерується автоматично. Не редагувати вручну.*
