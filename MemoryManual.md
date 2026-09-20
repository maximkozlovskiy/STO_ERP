# MemoryManual — STO ERP

> Тонкий вхідний файл. Читається loop-ом щогодини і на початку кожної сесії.
> Містить ТІЛЬКИ поточний стан + останній commit + посилання на довідники.
> Вся історія → `CHANGELOG.md`. Патерни → `docs/PATTERNS.md`. Правила → `docs/BUSINESS-RULES.md`.

---

## Поточний стан

```
Дата:       2026-09-21 (review bank-statements UI-реорг вкладки+перенос рахунків — 1 fix async-guard)
Фаза:       Аудит стеку ЗАКРИТО (FRONT+BACKEND+ДАНІ/ІНФРА+RLS ADR-010). Опційні техпункти: prismaSchemaFolder
            +typedSql-інфра (гібрид) ГОТОВО; Node 20→22 LTS ГОТОВО. Лишилось опційне: NestJS 11 (окремий
            блок — тягне Fastify 5 + 5 плагінів + bull-board, потребує E2E; свідомо відкладено).
            PHASES.md хвости: EAS Build (mobile), фінальний smoke-test на чистій VM (МУСИТЬ `docker compose
            build` ОБИДВА образи на node:22-alpine — ловить native-ABI recompile sharp/bcrypt/argon).
TypeScript: ✅ 0 errors (shared + api + web, tsc --noEmit --incremental false)
Тести:      api 2613/2613 (+17 bank-statements: parser 11 нових + reconciliation 12→18) · web 837 component · E2E 343/343
            (+6 bank-statements smoke, повний auth-gated seeded DB; 2 flaky work-orders pass-on-retry, pre-existing).
            (backend-i18n повний: усі *-schema.spec + money/FSM byte-identity green; parity uk===en.)
HEAD:       backend-i18n ПОВНІСТЮ ЗАВЕРШЕНО — 0 захардкодженого укр у throws/zod/class-validator/filter (29eaad2f)
i18n:       Багатомовність uk/en ЗАВЕРШЕНА повністю (front+back): (1) УВЕСЬ (app) UI — 28 web-namespaces,
            2612 ключів×2 (react-i18next, output:export/offline, MP-F7). (2) Backend ПОВНІСТЮ: Accept-Language
            (web getCurrentLocale)→tenant-ALS getLocale()→translate у КОЖНОМУ seam. @sto/shared/i18n каталог
            (~550 keys: 87 zod/v.* + 472 err.*, translateValidation/translateError alias, uk BYTE-IDENTICAL,
            offline). Локалізовано: (a) zod-messages=KEYS → api ZodValidationPipe + web i18nZodResolver(рекурс.)
            + validateContactFields; (b) 693 exception-throws у ~85 сервісах → translateError('err.<module>.*',
            getLocale()) (черги #1-#5, коміти 42cfad62..b79ecd3a); (c) http-exception.filter Prisma-строки →
            err.prisma.*/err.internal (mapPrismaErrorToHttp повертає {status,key,params}); (d) class-validator:
            validation-error.factory CV_TEMPLATE_KEYS(30 err.cv) + 65 inline @IsX({message}) DTO→err.dto.*(48)
            (29eaad2f). CRM BOTH="Клієнт - Постачальник" уніфіковано. enumLabel-обгортки (statuses.ts — backend
            PDF свідомо лишається укр.). Pre-existing mojibake у employees/services/settings.dto — скопійовано
            verbatim заради byte-identity (окремий дефект, поза scope).
Review(bank-statements UI-реорг): 2026-09-21 (auto, 6245e629, скоуп 937fc0ee) — 1 fix (§3.1 async-guard).
            Вкладковий bank-statements (tab-shell за cash-зразком) + перенос BankAccountsTab з ndi/ + колонка
            «Рахунок» (backend include join). ЧИСТО: page.tsx Suspense+dynamic ssr:false+?tab= через
            useSearchParams/router.replace, invalid-tab guard (TABS.some), useRequireAuth у shell — коректно,
            SSG-safe (усе 'use client', output:export не ламається); backend include bankAccount{name,ibanUA}
            = single join (N+1 немає), mapper nullable-safe (?? null); DTO↔web interface parity; colSpan 7 у
            ВСІХ станах (loading/empty/rows); i18n 100% parity uk/en (page.tabs/columns.account + ndi
            autoPullBadge/providerAny); ndi 7→6 вкладок без мертвих посилань; import ../ndi/types валідний;
            BankAccountsTab move 91% similarity (ref-cache+apiFetch логіка інтактна, Bug #766-клас НЕ регрес).
            Fix: додано cancelled-flag guard на 4 setState-гілки useEffect (Promise.all+providers) — патерн
            перенесено з ndi без guard (React-Query не викор.). a11y вкладок = plain <button> як cash-shell
            (консистентно з codebase-нормою, не регрес). api tsc 0 / web tsc 0; bank-statements suite 15 pass.
Review(bank-statements prev): 2026-09-20 (auto, HEAD 7221773a) — 1 дефект (§1) виправлено. Скоуп
            fe23cbb4+3e57a9e5+98685622 (backend+UI+sync-fix): schema BankTransaction/enums/Counterparty.iban,
            bank-reconciliation.service, payments settlementType(PREPAYMENT/REFUND), controller, 4 web-файли.
            Fix: React.ChangeEvent → named import у BankStatementImportModal. ПЕРЕВІРЕНО ЧИСТО:
            matchTransaction CAS(status=UNMATCHED,paymentId=null)→create→link idempotent (orphan-Payment
            вікно benign — retry=Conflict, no double-charge); PREPAYMENT/REFUND BALANCE_SIGN=−1 коректний,
            default ??'PAYMENT' зберігає всіх наявних callers; applyImport createMany skipDuplicates
            (externalId-idem)+amountBase по валюті рахунку+$transaction timeout; resolveBatch ≤4 findMany
            (in-bounded lookup — take НЕ додавати, зламає Map); tenant orgId у КОЖНОМУ where (guard fail-closed
            покриває, BankTransaction НЕ exempt); міграція ручна ADD VALUE+DDL разом=6 прецедентів PG16-ok;
            iban backfill regex безпечний; i18n 89/89 uk=en, усі t()-ключі резолвляться. Suggestion (НЕ
            фіксовано, не trivial): ₴ хардкод у 4 місцях UI — tx.currencyId може бути USD/EUR (MVP UAH-focus).
            api tsc 0 / web tsc 0 (baseline не регресовано).
Sync(bank-statements): 2026-09-20 (auto, 98685622) — 1 виправлено. PaginatedBankTransactionsDto
            +list() бракували page/limit (усі інші Paginated*Dto в проекті мають {items,total,page,limit} —
            матчить web PaginatedResponse<T> у usePaginatedList). URL/методи/DTO-поля/enum-и (matchType,
            status, previewMatchStatus)/column-mapping — усе інше вже було 1:1. api 2596/2596 · web 837/837 · tsc 0/0.
Sync(backend-i18n): 2026-09-19 (auto, cfbd30f0) — 0 mismatches. 400-контракт незмінний; header round-trip
            (getCurrentLocale→'uk'/'en', Fastify lowercase); key-consistency (84 schema keys ⊆ 87 catalog).
Sync(full-branch cycle 2/3): 2026-09-19 (auto, 0 fixes, коміт не потрібен) — re-verify cycle 1 fixes
            + delta-sweep 911fe19d..HEAD (8 реальних файлів: cash-registers/cash getBalances batch,
            dead-letter NaN-guard, DeadLetterTab per-row loading, api-client/auth-context simplify-refactor).
            Усе інтактно: DeadLetterService.findAll {items,total} DTO-shape byte-identical після NaN-guard
            (лише safePage/safeLimit математика, поля мапінгу не чіплялись) ↔ useDeadLetter.ts DeadLetterJob
            interface field-by-field match; 5 Accept-Language сайтів (tryRefresh/login/refresh/logout/
            logout-all/booking) усі досі через buildHeaders()/inline getCurrentLocale() — simplify-refактор
            13f9ee41 чіпав лише error-body parsing (throwFromResponse), headers-код не зачеплено. НАЙВИЩИЙ
            РИЗИК cash-registers findAll (getBalances batch, 38da9dd9): CashService.getBalances() Map<string,
            number> ↔ getBalance() number — identical type; frontend CashRegister.balance:number unchanged.
            0 інших contract-розбіжностей на гілці (endpoint↔UI, URL, interface↔DTO) — spot-checked provider-
            registry/payments/notifications (Cycle 1 verified, no new touches). tsc shared+api+web 0. Коміт
            не потрібен (0 фіксів).
Sync(full-branch cycle 1/3): 2026-09-19 (auto, 911fe19d) — full-branch sweep dafacc8b..HEAD (652 файли).
            Знайдено+виправлено: (1) 6 raw-fetch сайтів (api-client tryRefresh, auth/context.tsx
            refresh/login/logout/logoutAll, booking/page.tsx publicFetch) НЕ слали Accept-Language →
            resolveLocale дефолтить 'uk' без header → EN-користувачі бачили укр. помилки на
            login/refresh/logout/booking. useWorkOrderActions.ts public export fetch залишено (blob,
            без JSON error body — Accept-Language не load-bearing). (2) DeadLetterController
            (GET /dead-letter, PATCH /:id/resolve) — 0 frontend-споживачів, лише bull-board (dev-only,
            /admin/queues відсутній у prod) → доданий мінімальний settings-tab (useDeadLetter hook +
            DeadLetterTab: список/фільтр/resolve, uk+en i18n). Перевірено чисто: provider-registry
            (fiscal/payment-gateways/delivery/notification-providers) — усі 5 routes + shape матчать;
            payments/supplier-payments/cash-shifts/payment-methods — повністю wired. tsc web 0 / api 0
            (api файли не чіплялись). web suite 824/824 без регресій.
Review(backend-i18n): 2026-09-19 (auto, cfbd30f0) — 0 defects. ПОВНИЙ byte-identity аудит 87 keys +
            структурний діф 11 схем (0 logic drift на money/FSM — лише Prettier reflow). i18nZodResolver
            рекурсія OK; getLocale default 'uk'; header parse safe; buildHeaders spread-order OK.
Tester(backend-i18n): 2026-09-19 (auto, cfbd30f0) — Bug #763 (MEDIUM, fixed 28c149bf): i18nZodResolver
            skip-list `key==='type'` збігся з ІМЕНЕМ поля (counterparty/stock-doc type:z.enum) → errors.type
            лишалось raw-key. Fix: skip лише 'message'/'ref'. api 2549, web 824. Live HTTP SKIP (endpoints
            за JwtGuard, seed-креденшел відхилено, brute заборонено) → real-pipe+real-ALS integration:
            uk byte-identical «(поле "x")» + en «(field "x")» + no-header→uk + concurrent-locale isolation.
Tester(i18n): 2026-09-18 (auto, коміти 7cc36318+585bfa89) — Bug #762 (MEDIUM, fixed db571dd2): section-
            headers сайдбару не перекладались live (dead NAV_SECTION_KEYS — TopShell рендерив сирий
            group.label без t()). web 821/821, api settings 59/59. Live auth-path SKIPPED (dev-БД не
            demo-seed, forge-JWT заблоковано harness — правильно); pre-auth live: html lang=en + 0
            catalog-fetch перевірено у браузері.
Review(i18n): 2026-09-18 (auto, коміт 7cc36318, 67 файлів) — 0 Critical/0 Important, 3 Suggestion.
            tsc web 0; i18n+useLanguage vitest 12/12. Інфра чиста: format.ts memoByLocale коректний
            (per-locale rebuild, ISO-хелпери sv-SE/en-CA locale-INDEPENDENT); useLanguage дзеркалить
            useNavConfig (localeRef, abort-dedup PUT, cancelled-guard, TTL-skip+I18nProvider applyLocale
            покриває format-registry); tEnum fallback-ланцюг коректний (defaultValue:''→shared map→code,
            null/''→'—'); no-flash (config sync-read + inline head-script + suppressHydrationWarning);
            static-export shells (payments/[id], estimate/[token]) правильні, EstimateClient 'use client'
            інтакт; 0 runtime catalog-fetch (i18next-http-backend відсутній, статичні import→offline OK);
            settings DTO language @IsIn(['uk','en']) + міграція 20260918100000 присутня. SUGGESTION:
            (1) imperative enum-wrappers (woStatusLabel тощо) + format.ts НЕ підписані на languageChanged →
            відкрита list-сторінка НЕ оновлює мітки live при зміні мови до ре-маунту (свідомий trade-off
            ради мін. churn; Settings-селектор оновлюється, навігація ре-монтує); (2) counterparties/[id]
            local TYPE_LABELS[cp.type] лишився сирим хоча counterpartyTypeLabel існує (у scope ~170
            un-migrated, future work); (3) — . Правок не потребує.
Review:     2026-09-18 (auto, Node 20→22 LTS, коміт d85deb73) — 0 проблем, bump повний+консистентний.
            Стрáглерів немає (усі node:20-hits у lockfile/archive/disk-check). @types/node вже ^22.
            engines-only diff, @nestjs/fastify не зачеплено. FLAG: VM smoke-test МУСИТЬ `docker compose
            build` обидва образи (native-ABI recompile sharp/bcrypt/argon ловить лише реальний build).
Review(prismaSchemaFolder): 2026-09-18 (auto, коміт 44b45b28) — 0 проблем. ZERO drift:
            block-sets byte-identical (45 enums+98 models), validate OK, migrate status up-to-date/138.
            SyncJobStatus+ExpenseCategoryType релоковано у 01_enums (cross-file refs резолвляться).
            typedSql inert; dashboard.service.ts НЕ чіпано; Dockerfile plain generate (offline-safe).
Tester:     2026-09-18 (auto, той самий коміт 44b45b28) — CLEAN 0 багів. api 2539/2539 baseline preserved;
            seeds path-agnostic (bare new PrismaClient); 0 функціональних old-path refs; typedSql inert.
            Нотатка (pre-existing, не в scope): @sto/database exports вказує на неіснуючий path — harmless
            (ніхто не імпортує @sto/database, всі через @prisma/client).
Review(попередній): 2026-09-17 (auto, аудит Дані/Інфра — append-only ledger тригери, коміт 7ac27c41) — 1 IMPORTANT
            (ledger integrity). stock_movements-тригер дозволяв «batchId серед іншого»: перелік IS NOT
            DISTINCT НЕ покривав price/notes/createdBy/unitOfMeasureId → ledger-money-поле price мутабельне
            разом із batchId. Fix (коміт 31c5ec2): (to_jsonb(NEW)-'batchId')=(to_jsonb(OLD)-'batchId') —
            авто-покриває всі + майбутні колонки; переприкладено на dev-БД; +behavioral-регрес. Решта ЧИСТО:
            settlement_transactions повна заборона ✓; Payment/StockBatch правильно виключені; єдиний prod-UPDATE
            (inventory.service:329 batchId у createMovement-tx) ✓; реверс RETURN = компенсуючий запис (не DELETE).
Review(попередній): 2026-09-17 (non-root Docker api+web, коміт 136f5d55) — 1 CRITICAL
            (латентний, pre-existing, у фокусі рев'ю offline-migrate). `prisma` CLI був devDep @sto/database
            → `pnpm prune --prod` у api runner-stage видаляв його → installer `docker compose exec/run api
            npx prisma migrate deploy` (First-Run/Update) фолбечив на registry-fetch → offline провал
            міграції. Fix: prisma dev→prod dependency (та сама ^5.22.0) → prune зберігає CLI → npx резолвить
            локально без мережі від USER node. Lockfile 3 рядки (--frozen-lockfile passes), db tsc 0.
            Решта фокусу ЧИСТО: chown ПІСЛЯ install/generate/prune + USER перед CMD; nginx-unprivileged
            uid101/:8080 default, COPY заміщає conf.d default.conf; порти узгоджені у 4 live-файлах (8080)
            + ADR-002; release.yml docker save sto-web цілим; dev-compose не білдить; run --rm/exec обидва
            від node; runtime FS-writes → MinIO/stdout/tmp (не local FS під root).
Tester:     2026-09-17 (auto, аудит backend #3 API-версіонування, коміт d0e3e42c) — 1 HIGH: сторінка
            /estimate/[token] (публічний кошторис, SMS/email share-лінк) через СПІЛЬНИЙ publicFetch форсила
            /api/v1 → била /api/v1/public/work-orders/:token → routing-404, хоча public-контролер VERSION_NEUTRAL
            під /api/public/... → кожен share-лінк «Посилання не дійсне». Fix: publicNeutralFetch → /api
            (дзеркалить бек VERSION_NEUTRAL). Live-перевірено: routing (v1 vs neutral), auth flow E2E
            (login/refresh/logout cookie path /api/v1/auth), health-neutral, bull-board/swagger, +3 URL-regres.
Sync:       2026-09-17 (auto, аудит backend #3 API-версіонування, коміт 8c2d5aa8→ecb688e2) — 1 КРИТИЧНИЙ
            bug: AuthController не VERSION_NEUTRAL → /auth/* переїхав на /api/v1/auth/*, але web
            AuthProvider (login/refresh/logout/logout-all, 4× fetch) і backend refresh-cookie path
            лишились на старому /api/auth → сесії/логін/логаут мовчки ламались (cookie path-mismatch
            додатково приховав би баг навіть після фіксу URL). Fix: context.tsx 4× URL → /api/v1/auth/*;
            auth.service.ts cookie path (set+2×clear) → /api/v1/auth; auth.spec.ts асерти; e2e
            route-глоби **/api/auth/** → **/api/v1/auth/** (api-errors, inventory×2 — інакше мокали
            не перехоплювали, тест бив по живому бекенду); mobile upload.ts окремий BASE_URL без /v1
            (photo upload 404). Перевірено чисто: health/public-work-orders VERSION_NEUTRAL коректні,
            payments — без inbound callback (ADR-005 BullMQ-only, немає version-neutral прогалини),
            webhooks.controller — власний guarded CRUD (не зовнішній inbound), Caddyfile /api/* wildcard
            без змін. api+web tsc 0, api-suite 165/2521 green.
Tester:     2026-09-17 (auto, аудит backend #2 DLQ) — 2 виправлено: (#759 HIGH over-redaction) плоский regex
            матчив короткі підрядки auth|sign|pass|key будь-де → редагував діагностичні поля (authorId/
            assignee/passenger/signedBy/bypass/keyword) → нищив цінність DLQ; fix: токен-орієнтований
            isSensitiveKey() (сильні терміни всюди, слабкі лише з компаньйон-токеном apiKey/authToken).
            (#760 MEDIUM тиха втрата) BigInt у job.data → Prisma JSONB throw → fail-open ковтав → DLQ-рядок
            ТИХО втрачено; fix: JSON-safe нормалізація (BigInt→String/Date→ISO/cyclic→CIRCULAR). Capture по
            12 чергах + checkbox delegate + tenant-404 + fail-open + runUnscoped ALS — чисто. api-suite 2521.
Tester-env: 2026-09-17 (auto, аудит backend #1 env-валідація) — 2 MEDIUM виправлено: (#757) dev-UX —
            NOTIFICATION_ENC_KEY.min(32) always-on строгіший за споживача (EncryptionService SHA-256
            приймає будь-яку довжину) → короткий dev-ключ валив старт; fix: min32 лише prod-gated.
            (#758) агрегація — prod-strict у object-level superRefine, Zod пропускає його при base-parse
            issue → одна format-помилка (PORT='nope') ховала ВЕСЬ перелік відсутніх prod-секретів
            (нищить installer-діагностику); fix: checkProdStrict() незалежно по сирому config, issues
            злиті вручну. Решта чисто (dev-деплой .env.dev проходить, prod-strict повнота, coerce.number
            наслідки). +5 регрес-тестів (20 env). api-suite 2499/2499.
Review:     2026-09-17 (auto, аудит backend #2 DLQ, коміт 9a0114c1) — 1 HIGH + 1 IMPORTANT + 1 SUGGESTION.
            HIGH: webhooks-черга носить `secret: ep.secret` у job.data → DeadLetterService.capture
            персистив увесь job.data у dead_letter_jobs.payload plaintext (secrets-at-rest). Fix:
            рекурсивний key-based sanitizePayload() (secret/token/apiKey/password/... → [REDACTED])
            перед записом + регрес-тест. IMPORTANT: resolve() findFirst({id,orgId})→update({where:{id}})
            без orgId (модель TENANT_EXEMPT, guard не страхує) → updateMany({where:{id,orgId}})+404.
            SUGGESTION: dead_letter_jobs → sync-exclusion коментар. Аудит 11 інших черг — секретів
            у job.data немає. 12/12 процесорів консистентні, міграція additive/idempotent, типи↔Prisma.
            +2 нові патерни у sto-review (§2.5 DLQ-writer secret-persist HIGH; §2.2 exempt-model resolve).
Review:     2026-09-17 (auto, аудит backend #1, коміт 7bdf2ae7) — 1 Important: MINIO_PORT — hard-dep
            (files.service getOrThrow у конструкторі), був відсутній у prod-strict → додано requireInProd.
Review:     2026-09-17 (auto, аудит backend #1, коміт 7bdf2ae7) — env.schema.ts fail-fast env-валідація
            перевірено: ВСІ споживані змінні (process.env.* + configService.get) покриті, prod-strict/
            dev-lenient коректний, .passthrough() зберігає POSTGRES_*/NEXT_PUBLIC_* і НЕ маскує typo
            (superRefine ловить правильне ім'я), NOTIFICATION_ENC_KEY порожнє=off/prod-required коректно.
            ConfigService.get() читає validated Env ПЕРШИМ → coerce.number на PORT/MINIO_PORT — єдиний
            споживач parseInt(MINIO_PORT) безпечний. 1 Important gap: MINIO_PORT — hard-dep (files.service
            getOrThrow у конструкторі), але був відсутній у prod-strict наборі → додано requireInProd +
            тест (15 env-тестів). api tsc 0, api-suite 2494/2494.
Tester:     2026-09-17 (auto, Фаза 5) — 0 продакшн-багів; shim-міграція без регресій у 9 зонах ризику
            (SHIM цілісність, гроші/idempotency Bug #755 retry-dedup runtime-підтверджено, UA-кома гейт,
            nullable clear, status-conditional PATCH, actualHours recalc, calendar-sync, dirty-guard, stock-totals).
            +2 runtime-guard тести (retry-dedup + double-submit через реальний RHF shim), +skill test-authoring
            патерн (RHF+.uuid() placeholder-фікстури тихо блокують submit) (8a55bf62/9968a39f).
Review:     2026-09-17 (auto, Фаза 5, коміт d8a569aa) — 1 Important виправлено: WorkOrder FORM-схема
            (workOrderFormSchema, гейт submit через safeParse(getValues())) валідувала числові поля
            через numericString/z.coerce.number (Number('1,5')=NaN) → легітимний UA-ввід «1,5» у
            quantity/normoHours/price/plannedHours/actualHours мовчки блокував submit хибним zod-issue,
            хоча локальні add-гейти (toNumberOrUndefined, comma-aware) кому приймали. Fix: новий
            optionalMoneyNumber() + moneyString у FORM-схемі (endpoint-схеми без змін — payload numeric
            JSON). SHIM-архітектура (form/setForm/lines/parts як watch()/setValue/replace bridge, Bug #755
            retry-dedup, nullable clear-семантика, RHF isDirty bridge, canEdit/canEditActual) — звірено
            чисто, регресій немає. Новий патерн → sto-review §8.2 + Накопичені підходи (eb667b51).
Sync:       2026-09-17 (Фаза 5, коміти cd4b58c0/a61f990a) — 1 баг знайдено й виправлено: save() header PATCH
            слав `undefined` (omit) замість `null` (очистити) коли користувач очищав "Підйомник" (Select →
            "— Без підйомника —") або datetime-local "Плановий початок/кінець". workOrderUpdateSchema.liftId/
            plannedAt/dueDate явно nullable (null очищає, undefined лишає) — сервіс так само розрізняє, але
            форма не мала способу виразити "очистив" через існуючий `|| undefined`/localDateTimeToISO('')
            (обидва повертають undefined на порожньому вводі). Fix: liftId → `|| null`; plannedAt/dueDate →
            fallback (form.plannedStartAt ? undefined : null), що відрізняє "не чіпали" від "очистили". Решта
            звірено чисто: header/line/part zod-схеми ↔ DTO field-by-field (validation-parity @Min/@IsEnum/
            @IsUUID/@IsISO8601 збігається), WORK_ORDER_PRIORITY/REPAIR_CATEGORY_VALUES = Prisma enum точно,
            multi-request архітектура (header POST /work-orders, lines/parts окремими /lines /parts) — фронт
            шле саме туди, shim-payload (form.*/toNumberOrUndefined comma-aware) відповідає бек-очікуванням,
            useWorkOrders interface ↔ WorkOrderResponseDto/Line/Part DTO — усі поля збігаються.
Prev HEAD:  50567fd8 fix(tester): Bug #756 — стабілізація flaky DocumentCreateModals (RHF-модалки) timeout:2000
Tester:     2026-09-17 (auto, Фаза 4) — 0 продакшн-багів. Ручний аудит усіх 4 модалок: useFieldArray
            identity/mutation (PO editingKey=field.id, commitEdit/update/remove/append коректні, display-поля
            збережені), гроші/idempotency (moneyString UA-кома, lines у $transaction, savingRef, createdIdRef),
            dirty-guard (Bug #639), edit-load reset()→clean, cross-field (sourceType↔account, TRANSFER),
            PO складні флоу (receive/pricing/Excel/multicurrency) — усе чисто. Єдиний фікс Bug #756 (LOW,
            лише тест): DocumentCreateModals flaky під паралельним suite (async-flush starvation важких
            RHF-модалок) → explicit timeout:2000 на всі async-асерти; продакшн НЕ чіпано.
Review:     2026-09-17 (auto, Фаза 4, коміт cf7de79c) — 1 Important + 2 Suggestion виправлено:
            (I) PurchaseOrderCreateModal handleCreate/handleSave показували хардкод «Оберіть постачальника
            та склад» на будь-який safeParse-фейл; кнопка вже гарантує supplier+warehouse → реальний фейл
            майже завжди у рядку (порожня ціна/кількість) → оманливе повідомлення. Fix: firstSchemaError()
            бере перший zod-issue.message зі схеми (усі українські) + префікс «Рядок N:» для line-items;
            тип zod-error без прямого import zod (web не має його прямою залежністю). (S) мертвий import
            POLine у PO (лишок RHF-міграції). (S) allowedTransitions у StockDoc загорнуто в useMemo (як у PO)
            — referential stability + усунено exhaustive-deps warning. sto-dev/sto-review оновлено новим
            патерном (safeParse misleading-error §8.2). Решта Фази 4 чиста: isDirty-міст (markDirty/resetDirty
            else-гілка не конфліктує з save-flow), усі auto-select {shouldDirty:false} (Bug #639), useFieldArray
            identity (editingKey=field.id, update/remove/append за index, display-поля через cast), WEB-H3
            savingRef синхронний у всіх 4 (handleSubmit ставить ref СИНХРОННО на вході onValid до першого await;
            PO через safeParse-хендлери), createdIdRef retry-safety (SupplierPayment) збережена, Controller
            field.value {}-cast + exactOptionalPropertyTypes ok, ukrainian errors + h-8 alignment. Контролери
            4 модулів чисті (guards/roles/ParseUUIDPipe). Sync-агент пройшов чисто ПЕРЕД review (0 розбіжностей).
Prev HEAD:  675d6b4c fix(sync): invoiceType 'INVOICE' поза UI-enum ламав редагування рахунків з наряду
Sync:       2026-09-16 (Фаза 3, коміти 6157d9fe/107daec7) — 1 баг знайдено й виправлено: createFromWorkOrder
            (основний шлях створення рахунку) не ставив invoiceType → Prisma @default("INVOICE"), яке поза
            UI-enum STANDARD/PREPAYMENT/CREDIT_NOTE. При редагуванні такого рахунку reset() писав 'INVOICE'
            у форму (?? 'STANDARD' не спрацьовує — truthy), zodResolver валив submit. Fix: normalizeInvoiceType()
            у InvoiceCreateModal (будь-яке значення поза enum → 'STANDARD' при завантаженні) + бек тепер явно
            ставить invoiceType='STANDARD' і у createFromWorkOrder, і у ручному create()-дефолті. Решта
            звірено синхронно: header POST/PATCH окремо від lines POST/DELETE, validation-parity dueDate/
            documentDate/amount/quantity/unitPrice/vatRate = class-validator DTO (декоративні після
            ZodValidationPipe-міграції, але типи звірені), useFieldArray _key/id локальні (не у payload),
            retry-safety (createdInvoiceRef/initialLineIdsRef) збережена.
Prev HEAD:  b003d98a fix(review): прибрано мертвий import hasCounterpartyName у CounterpartyEditModal
Review:     2026-09-16 (auto, коміти ab169ab0..9905f947 Counterparty+Vehicle zod+RHF+enum-канонізація) — 1 Suggestion виправлено:
            осиротілий import hasCounterpartyName у CounterpartyEditModal (name-by-type тепер лише
            через zodResolver counterpartyFormSchema.superRefine). Решта чисто: update-схема partial()
            без superRefine — merged name-by-type робить сервіс (counterparties.service:315-322 ефективний
            post-PATCH type); vehicle customerGarageId optional у формі / required у vehicleCreateSchema,
            обидва create-консюмери гарантують гараж (query або garage auto-create), update дропає гараж;
            optionLabel fallback на raw value (fuel/transmission/drive/body = String?, НЕ Prisma enum →
            міграція без ADD VALUE, VAN досяжний, unmapped лишається raw); два незалежні useForm у модалці
            не конфліктують; savingRef WEB-H3, currentCpIdRef tenant-guard, rhfDirty→useDirtyForm міст
            (з else — vehicle-tab має власний save-flow) — усе коректне; прибрані validateCounterpartyForm/
            formToPatch + локальні vehicle enum-константи (2 сторінки) без осиротілих імпортів. tester
            рекомендовано (архіт. зміна + DB-міграція + вкладені модалки). Prev review нижче:
Review-prev1: 2026-09-16 (auto, коміт eb3582cb Employee zod+RHF) — 1 Suggestion (латентний) виправлено:
            percent/ratePerHour/fixedMonthly/bonusPercent = numericString() (обовʼязкове z.number())
            → ПОРОЖНЄ будь-яке (навіть приховане неактивне за rateType) → NaN → не-локалізоване
            "Expected number, received nan" блокувало сабміт. Fix: flatRateNumber() (number|NaN),
            фінітність АКТИВНОГО поля гейтить superRefine з локалізованим меседжем. +2 регрес-тести.
            Решта чисто: superRefine діапазони коректні (percent 1..100, ratePerHour>=0, bonus 0..100),
            grantAccess→loginEmail+password+minlen, useForm<Input,_,Values> коерсить числа, rhfDirty→
            markDirty БЕЗ else (не тре assignment-dirty, reset не вмикає dirty), rateSchemeSchema
            реекспорт без циклів, Controller PhoneInput/DatePicker value/onChange коректні,
            ZodValidationPipe дзеркалить 400-контракт. Prev review нижче:
Review-prev: 2026-09-16 (auto, коміт 46fab8c9 raw-preview) — 1 Suggestion виправлено:
            cellText для формули з result-об'єктом ({result:{error}}) давав «[object Object]»
            → тепер result рекурсується через cellText; гілку 'error' піднято перед 'result'.
            +тест (#DIV/0!). Решта чисто: RBAC OWNER/ADMIN/XLSX_MANAGER на endpoint, БД/orgId
            не чіпає, limit clamp 1..100, totalRows=actualRowCount, 1-based row.values, XSS
            неможливий (React екранує cells/title), тиха деградація onError, reset rawPreview
            при виборі/відкритті, tabular-nums, множина рядок/рядків, sticky шапка+перший стовпець.
Prev:       d91fe897 (auto) — generic Excel-import FRONTEND: 2 Important
            виправлено. (1) handlePreview/handleApply мали лише disabled={isPending} без
            синх-guard → подвійний клік у одному тіку = дубль preview/apply (Bug #630 клас);
            (2) savedMapping-effect затирав введені колонки при react-query refetch →
            mappingAppliedRef (раз за відкриття). Решта чисто: onClose стабільний (useCallback
            у батьках), cache invalidation коректний (PO/SD keys за docType + mapping detail),
            FormData не шле порожні колонки, apply-payload = whitelist DTO (0 зайвих полів).
            web tsc 0, 15/15 модалок зелені.
            Попередній BACKEND review (HEAD f509cd8b): 0 проблем.
```

**Backlog тех-боргу (усе 🟢):** TD1 currencyId NOT NULL + seed base-валюти; TD2 schema-integrity
guard + self-heal trgm проти db push; TD3 консолідація (pagination/kyiv-date utils, DTO-мапери,
4 скіли стиснуто, декомпозиції CreateWorkOrderModal + PurchaseOrderCreateModal, sto-tester split).

**3 QA-цикли (sto-sync→review→tester→optimize→e2e→simplify→code-review→security-review):**
знайдено+виправлено ~30 issue (найвагоміше — цикл-3 code-review зловив, що optimize-RTT-фікс
`updateSaved` порушив A1 tenant-guard → feature dead-on-arrival, виправлено `where:{id,orgId,
deletedAt:null}` + перевірено наживо). 0 security-вразливостей у всіх 3 циклах. Нові фічі, дороблені
у циклах: XLSX-import UI, pricing apply-all, maintenance-schedule edit, expense-category restore,
saved-report rename. Спільний `lib/download.ts` helper. Відкладено: Bug #747 (WorkOrder-модалка не
закривається на dirty-on-open, передіснуючий, test.fixme + BUG_REPORT).

---

## Останній commit

```
Sync bank-statements (monobank+DBF+multi-bank) — 2026-09-21, HEAD 77ad954d:
  77ad954d fix(sync): BankStatementImportModal file input accept=".csv,.xlsx,.xls" — backend
        bank-statement-parser.service.assertSupported() приймає .csv/.xlsx/.dbf (не .xls). UI не
        давав вибрати .dbf попри те що backend вже парсить DBF (providers/mono-статистика +
        multi-bank коміт f98fadb6). Виправлено accept → ".csv,.xlsx,.dbf". Перевірено ЧИСТО:
        BankAccount.provider (DTO Create/Update/Response) ↔ web types.ts інтерфейс ↔ BankAccountsTab
        форма (Select провайдера + autoPullEnabled toggle) — усі 3 боки узгоджені; GET
        /bank-statement-providers [privat24,monobank] ↔ BankAccountsTab dropdown + settings/
        BankStatementsTab обидва Array.isArray-guard є; monobank creds (token+accountId) у
        BankStatementsTab.bankProviders ↔ MonobankStatementProvider.creds() читає ті ж ключі.
        MANUAL-VERIFY mono/DBF-мапінг НЕ чіпався (навмисно). tsc: web 0/837 · api 0/2694.
  Sync bank-statements (Фаза 4 Privat24 auto-pull) — 2026-09-20, HEAD d409945f:
  d409945f fix(sync): BankAccount web interface (apps/web/.../ndi/types.ts) не мала autoPullEnabled/
        lastPulledAt — type-drift проти BankAccountResponseDto (commit 4eead7eb). Поля додані як
        optional (UI-toggle ще нема, лише type-parity). Перевірено ЧИСТО: bank-statement-providers.
        controller (GET list, POST :code/verify, GET/PATCH branch/:branchId, POST branch/:branchId/
        activate, POST pull-now) ↔ BankStatementsTab.tsx+ProviderRegistryPanel — endpoints/payload
        shapes збігаються (ProviderConfigView ідентичний provider-config.service.ts). OrganisationSettings.
        bankStatementPollIntervalMinutes — узгоджено web/DTO/response обидва боки. tsc: web 0 · api 0.
  Tester bank-statements bug hunt — 2026-09-20, HEAD 2b3e0c64:
  2b3e0c64 fix(tester): Bug #767 [MEDIUM] parseDate rollover guard + bank-statements покриття.
        Bug #767: bank-statement-parser.parseDate тихо «перекочував» неіснуючі дати (31.02→03.03,
        31.04→05.01) — JS Date overflow без round-trip guard → зіпсована operationDate реальної
        банк-транзакції (визначає курс amountBase). Фікс: звірка getUTC*-компонентів з входом → null.
        +bank-statement-parser.service.spec.ts (NEW 11 тестів — раніше 0 на 261-рядковий парсер файл→гроші).
        +bank-reconciliation 12→18 (INVOICE→PAYMENT+invoiceId+amount; guards CAS-untouched; previewImport
        дедуп; applyImport 404+amountBase). +e2e/bank-statements.spec.ts (NEW 6: рендер/фільтр/import-wizard/
        повний ignore-flow seed→apply→IGNORED). SKILL +Bug #767 date-rollover патерн.
        ENV-урок: running API/web стартували ДО фічі → 404 на нових роутах; перезапуск підхопив модуль.
  Suite: api tsc 0/2613 · web tsc 0/837 component · shared 0 · E2E 343/343 (+6 bank, 2 flaky retry-pass).
  Попередні — full-branch cycle 3/3 FINAL — 2026-09-19, HEAD 46392fcd:
  46392fcd docs(tester): cycle 3/3 (FINAL) — валідаційний прохід, НУЛЬ нових багів. Реліз-гейт GREEN.
        Функціональний diff be48551d..HEAD = 3 frontend файли: f53e7c1d CreateWorkOrderModal мігровано на
        onAutoDefault prop (той самий dirty-guard патерн що Invoice/PO, Bug #766-class consistency);
        8835afaa PO receiveQtys key уніфіковано на field.id (усі 3 сайти); db3f5254 CurrencySelect регрес-тест.
        Валідовано: WO-модалка non-dirty on open + currency auto-default + user-change dirties (доведено
        CurrencySelect.test.tsx 3 інваріанти). Backend/schema дрейф за ВСІ 3 цикли = 0 (git diff порожній).
        Bug #764/#765/#766 фікси тримаються. E2E ПЕРЕзапущено на свіжому NEXT_PUBLIC_E2E=1 сервері.
  Попередні: be48551d Bug #765 PO receive key-mismatch (CRITICAL) + #766 currency dirty-guard (HIGH/UX);
        ac535ff4 skills +RHF field.id key-mismatch +currency dirty-guard +E2E-flag prereq.
  Suite: api tsc 0/2573 · web tsc 0/834 component · shared 0 · E2E 339/339 (0 fail, 0 skip, 0 flaky, 2.8m).

Optimize full-branch cycle 1/3 — 2026-09-19, HEAD 38da9dd9:
  38da9dd9 perf(cash-registers): findAll рахував balance ЧЕРЕЗ cash.getBalance() у map(async) — N+1
        (3 запити/касу: findFirst + 2 aggregate → до 3×N=600 при take:200), введено на цій гілці
        (origin/main віддавав кешовані items без balance) + обходив ref-кеш на КОЖНОМУ запиті.
        Fix: CashService.getBalances(orgId, initials) — ОДИН groupBy по (cashRegisterId, direction)
        з cashRegisterId IN [ids]; семантика byte-identical (initial+ΣIN−ΣOUT, roundMoney);
        initialBalance уже у кеш-DTO (реєстри не перечитуються); index-covered
        (orgId,cashRegisterId,createdAt) prefix. +3 тести. tsc api/web 0, cash 43/43.
  Решта гілки (~340 файлів) — механічне i18n string-wrapping (translateError/getLocale) — НЕ perf.
  Нова DLQ (dead-letter.service.findAll) — вже оптимальна (Promise.all findMany+count, take:200,
        0 N+1, 0 include). buildHeaders getCurrentLocale() — module-var read, не localStorage.

Review аудит Дані/Інфра — append-only ledger тригери — 2026-09-17, HEAD 31c5ec2:
  31c5ec2 fix(review): forbid_mutation_stock_movements — перелік IS NOT DISTINCT (id/orgId/goodId/
        warehouseId/type/quantity/documentType/documentId/createdAt) НЕ покривав price/notes/createdBy/
        unitOfMeasureId → UPDATE «batchId + price» проскакував (мутація ledger-money). Замінено на
        (to_jsonb(NEW)-'batchId')=(to_jsonb(OLD)-'batchId') (core PG, авто-покриває майбутні колонки).
        Функцію переприкладено на dev-БД (правка застосованої міграції Prisma не переприкладає).
        +behavioral-регрес (batchId+price → reject). Патерн → sto-database + sto-review (to_jsonb whole-row).
  7ac27c41 (pre-review) feat(db): 2 plpgsql BEFORE ROW тригери — settlement_transactions повна заборона
        UPDATE+DELETE; stock_movements DELETE-заборона + одноразовий batchId NULL→value. schema-integrity
        existence-check (pg_trigger NOT tgisinternal) + append-only behavioral-spec. Idempotent (DROP IF EXISTS).
  api tsc 0. append-only 5 + schema-integrity 8 = 13/13 · inventory.service 58/58.

Аудит стеку BACKEND #3 — URI-версіонування /api/v1 — 2026-09-17, HEAD f1f9ed85:
  8c2d5aa8 feat: enableVersioning({type:URI, defaultVersion:'1'}) → бізнес-роути /api/v1/*. health +
        public/work-orders VERSION_NEUTRAL (fixed-URL консюмери: docker healthcheck, SMS/email share).
        Клієнти → /api/v1: web api-client/booking, mobile BASE_URL, 29 e2e. Caddy /api/* — без змін.
  ecb688e2 sync CRITICAL: AuthController (не neutral) → /auth переїхав /api/v1/auth, але web AuthProvider
        (4× raw fetch) + refresh-cookie path лишились /api/auth → auth мовчки зламаний. Fix: context.tsx +
        cookie path (set+2×clear) → /api/v1/auth; mobile upload.ts BASE_URL → /v1; e2e route-globs.
  d0e3e42c tester HIGH #761: /estimate/[token] через спільний publicFetch форсив /api/v1 → public-роут
        (VERSION_NEUTRAL, /api/public/...) 404 → share-лінки «недійсні». Fix: publicNeutralFetch → /api.
  Паттерн MP-B12 (docs/PATTERNS): version-neutral винятки + 3 клас-баги (raw-fetch bypass, cookie-path
        coupling, спільний client-префікс маскує neutral/versioned). GOTCHAS: cookie-path/версія coupling.
  api+web tsc 0. api-suite 2521/2521, web lib 153 (+3 URL-regres). Live-verified routing/auth/health.

Аудит стеку BACKEND #2 — централізований DLQ для BullMQ — 2026-09-17, HEAD a120de94:
  ee57f38c feat: DeadLetterJob (TENANT_EXEMPT, orgId nullable, міграція additive) + DeadLetterWorkerHost
        (base, deadLetterOnFailed терминальний гейт) вбудовано у 12 черг + checkbox delegate. Capture у
        процесі (@OnWorkerEvent('failed')), НЕ QueueEvents (несе лише jobId/reason + removeOnFail евіктить).
        Controller GET/PATCH /dead-letter. @Global DeadLetterModule.
  9a0114c1 review: HIGH secrets-at-rest (webhooks secret:ep.secret у payload plaintext) → sanitizePayload();
        IMPORTANT resolve() race → updateMany({id,orgId})+404.
  0eea48ca tester: #759 HIGH over-redaction (плоский regex auth|sign|pass|key редагував authorId/assignee/
        passenger) → токен-орієнтований isSensitiveKey(); #760 MEDIUM BigInt→JSONB throw→тиха втрата DLQ →
        JSON-safe нормалізація.
  Паттерн MP-B11 (docs/PATTERNS): durable DLQ, 3 клас-баги (secrets/non-JSON/tenant-exempt-write).
  Follow-up v1.1: dead-letter-purge (лише resolved past-cutoff). tsc api 0, api-suite 2521/2521.

Аудит стеку BACKEND #1 — fail-fast env-валідація (zod) — 2026-09-17, HEAD 4795a13a:
  123deff2 env.schema.ts: zod-схема всіх env API + validateEnv() → ConfigModule.forRoot({validate}).
        Контейнер із кривим/неповним .env падає НА СТАРТІ з агрегованим переліком, не на першому
        запиті. prod-strict/dev-lenient: формат валідуємо завжди, prod-критичні секрети (DATABASE_URL,
        JWT ≥32, MinIO endpoint/port/keys/bucket, ENC_KEY) required лише у NODE_ENV=production.
        .passthrough() зберігає POSTGRES_*/NEXT_PUBLIC_*. Централізує розсіяний getOrThrow-fail-fast.
  7bdf2ae7 review: MINIO_PORT — hard-dep (files.service getOrThrow у конструкторі) → додано prod-strict.
  1feb3e15 tester: #757 min(32) always-on строгіший за EncryptionService (SHA-256 будь-яка довжина) →
        min32 лише prod-gated. #758 prod-strict у object-superRefine короткозамикався при format-issue →
        винесено checkProdStrict() незалежно, issues злиті вручну (installer-діагностика ціла).
tsc api 0. env.schema.spec 20/20, api-suite 2499/2499. Далі backend-розділ: DLQ / API-версіонування.

Аудит #1 Фаза 5 — WorkOrder на zod+RHF (найскладніша, ЗАВЕРШУЄ аудит #1) — 2026-09-17, HEAD 9968a39f:
  <бек> work-order.schema (header/line/part + form) + 6 endpoint-ів (create/update, lines POST/PATCH,
        parts POST/PATCH) → ZodValidationPipe. Nullable-семантика update. FIX (spec): nullable() з
        z.coerce.number() коерсив null→0 → plannedHours:null тихо ставив 0; fix z.union([z.null(),inner]).
  a61f990a <фронт> CreateWorkOrderModal RHF+useFieldArray через SHIM (form/lines/parts = watch()-відбиток;
        setter-и diff getValues()+setValue/replace) → money-логіка (~700р) byte-for-byte. Bug #755 retry-dedup
        (postedLineKeysRef/postedPartKeysRef). Архітектура як Invoice (header тіло, lines/parts окремі endpoint).
  252af5fc <sync> save() слав undefined замість null для liftId/plannedAt/dueDate → clear мовчки не зберігався.
  d8a569aa <review> FORM-схема відхиляла UA-кому '1,5' (numericString→NaN) → safeParse-гейт блокував submit;
        fix optionalMoneyNumber()/moneyString у form-схемах (endpoint не чіпано). ⚠️ Той самий кома-клас
        латентний у Invoice/PO/StockDoc/SupplierReturn FORM-схемах (PO parseFloat('1,5')=1 тихе усічення) —
        поза scope Ф5, кандидат на наступний фікс.
  8a55bf62 <tester> 0 багів; +2 runtime-guard тести (retry-dedup + double-submit через RHF shim).
tsc shared+api+web 0. api 2479/2479, web 343/343, work-order-schema 17/17, WO module 131/131.

Аудит #1 Фаза 4 — 4 документ-модалки на zod+RHF зі спільними схемами — 2026-09-17, HEAD 50567fd8:
  eb063aaa SupplierPayment: supplier-payment.schema (sourceType↔account superRefine, moneyString()
           UA-кома), controller ZodValidationPipe, RHF-модалка +dirty-guard (нового не було).
  6f863a95 StockDocument: stock-document.schema (TRANSFER superRefine Bug #462), RHF+useFieldArray
           (lines у тілі $transaction, без окремого /lines-endpoint).
  89d9ff98 SupplierReturn: supplier-return.schema (price required, purchaseOrderId create-only),
           RHF+useFieldArray з INLINE-редагуванням рядків (register(lines.N.quantity)), unitOfMeasureId.
  40c6cec8 PurchaseOrder (найскладніша, 1981р): purchase-order.schema (contractId/trackingNumber
           nullable update), RHF+useFieldArray; receive/Excel/pricing/multicurrency/create-then-edit
           збережено. FIX (review): inline-edit editingKey=field.id (не line._key) — edit-row інакше
           не активувалась (жоден тест не ганяв inline-edit → спіймано у review перед комітом).
  cf7de79c review-фікс: firstSchemaError() у PO (змістовна line-item помилка замість хардкоду) +
           allowedTransitions у StockDoc у useMemo. 50567fd8 tester Bug #756 (flaky test → timeout:2000).
  Патерн MP-F6/MP-F6.1: спільна zod-схема = ЄДИНЕ джерело валідації web↔api (ZodValidationPipe на беку +
  zodResolver на фронті). Усі рядки-документи (StockDoc/SR/PO) шлють lines У ТІЛІ (атомарно), на відміну
  від Invoice (окремий /lines-endpoint + retry). QA: sync чисто → review 3 фікси → tester 0 продакшн-багів.
tsc shared+api+web 0. api 2462/2462, web 793/793, 4 schema-специ 38/38.

Аудит #1 Фаза 1 — Employee на zod + react-hook-form — 2026-09-16, HEAD 2f974834:
  eb3582cb feat(forms): Employee на zod + RHF — employeeFormSchema (superRefine крос-польові),
           rateSchemeSchema перенесено у @sto/shared (реекспорт з api dto), numericString()
           валідатор, controller create/update через ZodValidationPipe, EmployeeEditModal на
           RHF+zodResolver (Controller для PhoneInput/DatePickerInput, міст rhfDirty→markDirty).
  2f974834 review-фікс: flatRateNumber() — приховані неактивні числові поля (за rateType) не
           блокують сабміт не-локалізованим NaN-меседжем; фінітність активного поля у superRefine.
tsc shared+api+web 0. employee-schema 15/15, employees 27/27, EmployeeEditModal 4/4.

Generic Excel-імпорт товарів (FRONTEND) — 2026-09-15, HEAD d91fe897 (3 коміти):
  b913ab48 useExcelImport хуки (preview multipart / apply JSON / counterparty mapping GET+PUT)
           + ExcelImportWizard.tsx (generic ui/, 2-крокова модалка matched/ambiguous/notFound)
  03a098c9 підключення майстра до PurchaseOrderCreateModal + StockDocumentCreateModal
           («Завантажити з Excel» поряд з XlsxImportButton, стабільний onClose)
  d91fe897 review-фікс: синх double-submit guard (handlePreview/handleApply) + once-per-open
           застосування savedMapping (mappingAppliedRef проти react-query refetch-clobber)
web tsc 0 (--incremental false — фантомна PricingRulesClient обходиться), 15/15 модалок зелені.

Generic Excel-імпорт товарів (BACKEND) — 2026-09-15, HEAD 5f3ae56c (3 feature-коміти):
  a4e93da8 normalizeArticle util + skuNormalized/normalizedSynonym SOT + resolveByNameOrSynonym
  228ebadb xlsx adapter registry (PO/SD) + previewImport/applyImport + DTO + controller (DI-drift #724)
  5f3ae56c CounterpartyImportMapping module (GET/PUT /counterparties/:id/import-mapping)
DB-крок був окремим комітом 44e17aba (schema). tsc 0, 297+288 тестів зелені.
Деталі → CHANGELOG.md.
```

---

## Нові файли/утиліти (з останніх сесій)

| Файл                                                                                     | Що                                                                                          |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `apps/web/src/lib/download.ts`                                                           | `downloadBlob`/`downloadUrl` — SOT браузер-завантаження (attached anchor + deferred revoke) |
| `apps/api/src/common/utils/pagination.ts`                                                | `calculatePagination` (NaN-guard + cap)                                                     |
| `apps/api/src/common/utils/kyiv-date.ts`                                                 | Kyiv-date утиліти (DST-aware)                                                               |
| `apps/api/src/prisma/schema-integrity.integration.spec.ts`                               | TD2 guard: manual-SQL конструкти (partial-unique/trgm/EXCLUDE/CHECK) живі у БД              |
| `apps/api/src/modules/work-orders/work-order-dto.mapper.ts`                              | Винесені WorkOrder DTO-мапери (cost-price role-mask)                                        |
| `apps/web/src/components/ui/work-order/{InvoiceConflictDialog,PlannedActualMetrics}.tsx` | Виділені суб-компоненти CreateWorkOrderModal                                                |
| `apps/web/src/components/ui/purchase-order/{types,RulePricerModal}.tsx`                  | Виділені з PurchaseOrderCreateModal                                                         |
| `.claude/skills/sto-tester/sto-tester-approaches.md`                                     | Журнал патернів багів (винесено зі SKILL.md)                                                |
| `apps/api/src/common/utils/normalize-article.ts`                                         | `normalizeArticle` — upper + strip non-alnum (SOT skuNormalized/normalizedSynonym)          |
| `apps/api/src/modules/xlsx/document-line-import.adapter.ts`                              | Generic import: PO/StockDocument адаптери + registry (loadDoc/assertDraft/replaceLines)     |
| `apps/api/src/modules/xlsx/import.dto.ts`                                                | PreviewImportDto (multipart) + ApplyImportDto (@ArrayMaxSize 1000)                          |
| `apps/api/src/modules/counterparty-import-mappings/`                                     | Персист мапінгу колонок Excel per-контрагент (GET/PUT, upsert по @unique)                   |

---

## Активні особливості поточного коду

- `StockDocumentType.RECEIPT` — повністю додано: Prisma enum + DTO + service + frontend tabs
- `deduplicateBy(plan, u => u.goodId)` — у PO/xlsx applyPricing ПЕРЕД `Promise.all`
- Generic Excel-імпорт: `XlsxService.previewImport/applyImport` + `DocumentLineImportAdapterRegistry`
  (docType→adapter). skuNormalized/normalizedSynonym пишуться ЛИШЕ у Goods/BrandsService (SOT).
  XlsxService конструктор: Prisma+Pricing+**Goods+Brands+registry** (DI-drift #724 — оновлювати всі специ)
- `BALANCE_SIGN: Record<SettlementTransactionType, 1|-1>` — exhaustive (з FX_GAIN:+1/FX_LOSS:−1)
- Мультивалюта: money-рядки carry amount+currencyId+amountBase+rateUsed; баланс/звіти у base;
  `requireBaseCurrencyId` fail-closed у WO/Invoice/PO create; currencyId NOT NULL на 4 документних таблицях
- `Promise.all` для per-line writes у SD transition/PO receive (disjoint rows — safe)
- work-orders.service.ts parts loops — **sequential** (shared StockItem composite key — unsafe to parallelize)
- **A1 tenant-guard** ($extends fail-closed): кожен guarded Prisma-виклик МУСИТЬ нести orgId/branchId
  у where (інакше TenantIsolationError) — і для update({where:{id,orgId}}), не лише findMany
- CalendarSlot.parentSlotId — split-day continuation invariant (не колапсувати через updateMany)
- BullMQ API: `@Processor('queue', { concurrency: N })` + `extends WorkerHost` + `async process(job: Job<T>)`
- SMS-канал через `NotificationsService.send(orgId, eventType, payload)` — НЕ прямий `smsQueue.add()`
- **NestJS SWC на Windows**: залишити tsc builder (`nest start --watch` без `--builder swc`)
- **`rootDir: "src"` у api tsconfig** — обов'язково (інакше dist/apps/api/src/main.js → MODULE_NOT_FOUND)
- **tsc web incremental cache** ламається → використовувати `npx tsc --noEmit --incremental false`
  (голий tsc дає фантомну PricingRulesClient-помилку)

---

## Довідники (читати за потреби)

| Файл                                                 | Коли читати                                                                                 |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)         | API модулі, Prisma моделі, утиліти, sync                                                    |
| [docs/PATTERNS.md](docs/PATTERNS.md)                 | UI компоненти, hooks, B1-B7, EntityPickerField + Мета-патерни MP-B1..B10/MP-F1..F5          |
| [docs/BUSINESS-RULES.md](docs/BUSINESS-RULES.md)     | FSM, інвентар, розрахунки, тенант-ізоляція                                                  |
| [docs/GOTCHAS.md](docs/GOTCHAS.md)                   | Відомі пастки — читати перед новою фічею                                                    |
| [docs/GAPS.md](docs/GAPS.md)                         | Реєстр прогалин/ризиків (G1-G15 бізнес, TD1-TD3 тех-борг)                                   |
| [CHANGELOG.md](CHANGELOG.md)                         | Журнал комітів по фічах                                                                     |
| [BUG_REPORT.md](BUG_REPORT.md)                       | Відкриті/закриті баги (#747 відкритий)                                                      |
| [docs/objects/](docs/objects/)                       | Дос'є агрегатів: WO, Invoice, PO, StockDoc, Counterparty, Good, Work, Calendar, Settlements |
| [.claude/memory/MEMORY.md](.claude/memory/MEMORY.md) | User preferences                                                                            |

---

## Правило оновлення (для агентів)

Після кожного коміту — оновити **тільки** цей файл:

1. `Останній commit` → нові хеші (5–6 рядків, ЗАМІНИТИ старі, не додавати)
2. `Поточний стан` → TypeScript статус, дата, тести
3. `Нові файли/утиліти` → якщо з'явились нові
4. `Активні особливості` → якщо щось змінилось у логіці

**НЕ** додавати сюди деталі рішень, full bug descriptions, список виправлень (файл має лишатись
~150 рядків). Деталі → `CHANGELOG.md` (append, 3–5 рядків max per commit).
Патерн/правило → відповідний довідник (одне місце правди).
