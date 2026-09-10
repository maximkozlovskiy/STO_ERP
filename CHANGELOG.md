# CHANGELOG — STO ERP

> Журнал комітів по фічах. Append-only. Найновіше — зверху.
> Архівується раз на фазу: старі записи переносяться у `docs/archive/CHANGELOG-phaseN.md`.

---

## 2026-09-10 — T26: E2E-діагностика + A1-gap fix (WO detail)

### 52a34fc4 fix(work-orders): findOne goodUoM.findMany без orgId → tenant-guard 500

E2E (estimate-share+work-orders-features) виявив 13 фейлів. Діагноз: **12 = env** (web-сервер без
`NEXT_PUBLIC_E2E=1` → auth-hatch off → login-redirect; dev-setup, не баг), **1 = реальний backend-баг**:
`GET /work-orders/:id` 500-ив на наряді з UoM-запчастиною — A1 tenant-guard ловив `goodUoM.findMany` БЕЗ
orgId у detail/toDto (3-й екземпляр гапу після fetchPartCoefficients). Наслідок: edit-модал застрягав у
create-стані (нема «Виставити рахунок»). Fix +orgId. Share/export — у runUnscoped, не зачеплені.
tsc api 0 · work-orders 130 · live 500→200 · E2E 16/16 green. Skill +2 gotcha (NEXT_PUBLIC_E2E-hatch, UoM-detail-500).

---

## 2026-09-10 — A3-modal: 2 low-risk хуки з CreateWorkOrderModal (3708р God-компонент)

### 684f60b2 refactor(work-orders): винести useReferenceData

6 довідників + org-settings + *ById-мапи + loadVehicles/loadContracts (race-guard) → self-contained хук.
vehicle auto-select-single → колбек onSingleVehicle (хук form-agnostic). Логіку перенесено ДОСЛІВНО.

### f3fdb1f5 refactor(work-orders): винести useStockTotals

stock-totals кеш parts-таблиці → хук. Bug #452-454 збережено ДОСЛІВНО (Set-dedup goodId-ів, стабільний
sort ключа, skip-fetch на порожньому наборі, catch без throw).

CreateWorkOrderModal 3708→3524р (−184). tsc web 0 · 11 modal-тестів green · повна web-suite 717/717 ·
ref-data+stock-totals endpoints→200 live. Крок 3 (useWorkOrderActions: invoice+rollback) відкладено —
не покритий тестами + Playwright MCP down → click-верифікація недоступна.

---

## 2026-09-10 — A3: винесено stock+settlement side-effects у WorkOrderStockEffectsService

### e8ae4d70 refactor(work-orders): A3 — WorkOrderStockEffectsService

God-об'єкт WorkOrdersService (1847р): transition() змішував FSM-логіку з transaction-critical stock+
settlement fan-out. Винесено у окремий bounded context (дзеркалить A2-events / A3-Share).

- **NEW WorkOrderStockEffectsService** — reserveParts / releasePartReservations / writeOffPartsAndCharge /
  returnPartsAndCredit + fetchPartCoefficients. Тіла перенесено ДОСЛІВНО (git-diff: byte-identical окрім
  fetchPartCoeff orgId-фіксу). Deps prisma+inventory+settlements переїхали сюди.
- **WorkOrdersService** 1847→1595р, constructor 8→6 (inventory/settlements більше не інжектяться); transition()
  делегує 4 виклики у this.stockEffects.* (той самий tx). module +provider.
- **Латентний A1-баг закрито:** fetchPartCoefficients робив goodUoM.findMany БЕЗ orgId → після A1-guard FSM-
  перехід із UoM-запчастиною 500-ив (TenantIsolationError) + крос-tenant коефіцієнт. +orgId у where. Mutation-verified.

tsc 0 · suite 2101/2101 green (136 files) · lint 0 · LIVE FSM-smoke (clone→ESTIMATE→APPROVED→IN_PROGRESS→
COMPLETED→CANCELLED усі 201, 0 TenantIsolationError, side-effects застосовані — behavior-identical наживо).

### 13f4a474 test(work-orders): A3 QA gap-closure

QA (review→tester). Review: 0 проблем (byte-identity незалежно підтверджено). Tester: 0 A3-багів + закрив
unit-only-прогалину — NEW work-order-stock-effects.integration.spec.ts (real guarded client vs dev-БД,
mutation-verified: реверс orgId-фіксу відтворює оригінальний баг наживо для writeOff І reserve) + 4 unit
(zero-total throw на COMPLETED, coeff=0 safeCoeff→1 division-guard) + LIVE UoM-transition (WO з alt-UoM part
coeff=10 → COMPLETED усі 201, coeff-конвертовані рухи, 0 TenantIsolationError). Suite 2101→2109. **T25 (новий,
не A3):** GoodUoM.coefficient напрямок конверсії потребує продуктового уточнення (pre-existing).

---

## 2026-09-10 — A1: tenant-isolation GUARD (fail-closed) увімкнено

### c6a1a9eb feat(tenant): A1 — ALS + Prisma $extends guard проти крос-tenant витоку

Захист tenant-ізоляції як defense-in-depth (НЕ заміна 1828 ручних where:{orgId} — вони коректні).
Prisma-запит на tenant-модель без orgId/branchId-фільтра тепер КИДАЄ `TenantIsolationError` (тихий
крос-tenant витік → гучний 500). Ловить МАЙБУТНІ пропуски.

- **ALS-міст** (`common/tenant/tenant-context.ts` + global interceptor): request.user.orgId → scope на
  весь ланцюг handler→service→prisma. `runUnscoped`/`runWithTenant` (await ВСЕРЕДИНІ — lazy-PrismaPromise
  назовні виконався б поза scope).
- **Guard** (`prisma/tenant-guard.extension.ts`, OUTERMOST у prisma.service): `whereHasTenantScope`
  приймає top-level orgId/branchId + composite-ключ з вкладеним токеном (branchId_channel тощо) +
  AND-рекурсію; OR без sibling → throw. create без orgId → стемп з ambient або throw. Exempt: 6 junction
  - PricingRuleTier/WebhookDelivery/LoyaltyTransaction/SystemTemplate + Organisation.
- **Allowlist**: login/setup/share/for-each-active-org + 12 BullMQ-процесорів обгорнуто (10 org-scoped
  через runWithTenant({orgId: job.data.orgId}), 2 глобальні через runUnscoped).
- **http-exception.filter**: TenantIsolationError → лог model+op server-side, клієнту generic 500.
- **Реальне покриття**: `tenant-guard.integration.spec.ts` (12 тестів проти живої dev-БД — юніти мокають
  Prisma, guard у них не виконується). +interceptor unit (4) +whereHasTenantScope unit (15).

tsc api 0 · suite 2079/2079 green · lint 0 · boot-smoke чистий (login→CRUD→reports→payments 200,
0 TenantIsolationError; interceptor→service ALS-propagation підтверджено наживо).

### fa2508dd fix(tenant): review — 29 latent-сайтів + 2-й share-шлях + upsert-refine

sto-review-agent: guard проти всієї бази. 29 `.update({where:{id}})` на tenant-моделях без orgId → +orgId
(defense-in-depth, id вже org-fetched → no-op). EstimateExportService (DOCX-share) → runUnscoped. Guard
upsert-refine: upsert.where=unique→1 рядок, create стемпить orgId (закрив loyalty upsert без міграції схеми).

### c36900db fix(tenant): Bug #721 CRITICAL — guard приймав негований orgId-фільтр як scope

sto-tester-agent знайшов defeat fail-closed: `{orgId:{not:X}}`/`{NOT:{orgId}}`/`{orgId:{notIn}}`/діапазони
матчать ЧУЖІ tenant-и, а guard пропускав їх (leak замість throw). Fix: `isPositiveTenantBinding` — scope
лише позитивна рівність (scalar/`{in:[non-empty]}`/`{equals}`); негація/діапазон/null → fail-closed.
LOGICAL_KEYS виключено з composite-scan. +25 mutation-verified тестів. Suite 2099/2099 green.

---

## 2026-09-10 — GAPS deploy+reliability пакет: T16 + T23 + T12

### 34e2fb63 perf/fix(deploy+followup): T16 compose-ліміти + T23 backup BOM-фікс + T12 cursor-пагінація

- **T16 docker-compose**: `mem_limit`/`cpus` на КОЖЕН сервіс (compose v2 non-swarm читає top-level;
  `deploy.resources` ігнорується поза swarm). postgres 1g/1.0, redis 512m/0.5 (+`--maxmemory 400mb
--maxmemory-policy noeviction` — BullMQ-черги не можна тихо витісняти), minio 512m/0.5, api 1g/1.5,
  web/caddy 256m/0.5. + healthcheck web/caddy (`wget :80`) + caddy `depends_on: condition:service_healthy`.
- **T23 Backup/Restore.ps1**: pg_dump ВСЕРЕДИНІ контейнера у файл + `docker cp` (без PowerShell-pipe →
  без UTF-8 BOM на PS 5.1, що спотикав psql на 1-му рядку restore). `--clean --if-exists` → restore у
  непорожню БД без duplicate-key. Restore: `docker cp` дампу у контейнер + `psql -f -v ON_ERROR_STOP=1`.
- **T12 followup.processor**: cursor-пагінація (keyset `id`, `PAGE_SIZE=500`, `MAX_PAGES=200`) замість
  hard-cap `take:1000`, що ТИХО губив ТО-нагадування для автопарків >1000. Recipients дедуплікуються
  інкрементально (у пам'яті лише одна сторінка raw + унікальні-за-phone → OOM-захист збережено без втрати
  даних). +новий multi-page тест (сторінка 500 → коротка 3, перевіряє cursor advance + збір усіх 503).

tsc api 0 · api-suite 2048/2048 green (132 files) · lint 0 · PS 5.1 AST-parse OK (Backup/Restore/Setup).

---

## 2026-09-09 — 3 backlog-пункти закрито: Docker tag-mismatch + C1b audit + D3 bull-board

### c4f38c1c feat(bull-board): D3 — admin UI черг BullMQ за auth (OWNER/ADMIN, non-prod)

bull-board для перегляду/ретраю BullMQ-джобів. Fastify-plugin через `@bull-board/nestjs`; 12 черг
(sms, followup, idempotency-purge, nbu-fetch, loyalty, invoice-overdue, reconciliation,
nova-poshta-polling, integration-log-purge, outbound-webhook, checkbox, payment-polling) реєструються
локально в модулі (forFeature резолвить Queue-токен; registerQueue ідемпотентний).

- **Безпека, 2 шари**: (1) монтується ЛИШЕ non-prod — `register()` повертає порожній модуль у prod
  (роут відсутній, як Swagger; prod-CSP `default-src 'none'` зламав би UI); (2) non-prod роут
  `/api/admin/queues` захищено глобальним Fastify `onRequest`-хуком `registerBullBoardGuard` (main.ts):
  bearer-JWT + OWNER/ADMIN, звірка як у JwtStrategy (secret, tokenVersion-revocation, роль). Nest
  middleware/@UseGuards не працюють — plugin-роути обходять Nest-pipeline (live: 200 без токена).
- **Версії**: `@bull-board/*@5.23.0` — остання Fastify-4-сумісна лінійка (`@fastify/view@^8`,
  `@fastify/static@^6`); v6+/v9 → `@fastify/static@^8` → Fastify 5 → FST_ERR на старті. + override
  `fastify:4.28.1` (свіжий resolve дублював 4.29.1 → TS2345 у main.ts).
- Live-verified: no-token→401, bad→401, MECHANIC→403, OWNER→200 (UI+API), prod→404. api-suite 2008/2008.

### 8fd24a04 / 21fa5423 / a64f6913 / 2be5adbf feat(audit): C1b — аудит counterparties/settings/pricing

Розширення C1a-патерну (AuditService.record) на головні сутності + фікс read-whitelist:

- **Counterparty** (service): create/update/remove +`userId?` + best-effort record (update передає
  `existing` як old-data). Controller +`@CurrentUser`. Module +AuditModule.
- **Settings**: helper `auditSettings`; updateOrganisation/updateBranch/createTaxRate/updateTaxRate/
  deleteTaxRate +record (entityType OrganisationSettings/BranchSettings/TaxRate).
- **Pricing-rules**: AuditService прямо в контролері (inline CRUD не рефакторено), helper `auditRule`.
- **Whitelist-фікс** (audit.controller): `AUDIT_ENTITY_TYPES` +Payment/OrganisationSettings/
  BranchSettings/TaxRate/PricingRule — read-endpoint GET /audit віддавав 400 на ці типи (запис
  працював, читання блокувалось; латентно й для C1a Payment).
- Live-verified: Counterparty CREATE + OrganisationSettings PATCH audit (diff/user/timestamp),
  TaxRate query 400→200.

### 1e1aca97 fix(docker): tag-mismatch — offline-install падав

Розрив image-ref між CI/compose/installer: compose шукав `ghcr.io/your-org/sto-api:${VERSION:-latest}`,
installer `docker load`-ив `sto-api:<version>` (без префікса, інший тег), app-образи в ghcr не пушились
→ offline `docker compose up` не знаходив образ.

- **docker-compose.yml**: `image: sto-api:${VERSION:-latest}` / `sto-web:…` (прибрано ghcr-префікс).
- **Setup-Stack.ps1**: +`-Version` param → `.env VERSION=$Version`; при наявному .env оновлює лише
  VERSION без регенерації секретів. **setup.iss**: +`-Version "{#AppVersion}"`. **Update.ps1**:
  rollback `up -d` локального тега першою спробою, `pull` — лише fallback.
- **release.yml**: прибрано безцільний docker/login-action; minio пінований `RELEASE.2024-01-16…`.
- Live-verified (WSL): `VERSION=1.2.3 docker compose config` → локальні теги.

## 2026-09-09 — Backlog-фічі: Warranties UI + Loyalty config tab (frontend-only)

Закриття 2 backlog-пунктів (backend-готові, без UI). Обидва frontend-only, 0 змін API/схеми.

**Loyalty config** (461e06df): settings-таб «Лояльність» — toggle `loyaltyEnabled` + умовні числові поля
earnPer/earnPoints/redeemRate з clamp + inline-семантикою; PATCH /settings/organisation (лише 4 поля).
Шаблон FollowupTab.

**Warranties UI** (6b7b9317):

- useWarranties.ts — спільний тип Warranty (усунуто локальний дубль у counterparties, B6) + хуки
  byWorkOrder/byCounterparty/expiring (useQuery) + create/claim (mutation).
- WarrantySection у картці наряду (гейт від COMPLETED): список by-work-order з 3-стан бейджами
  (Активна/Пред'явлена/Закінчилась), «Пред'явити» (claim у поточний наряд), «+ Гарантія».
- WarrantyCreateModal — POST /warranties (expiresAt DatePickerInput, description).
- Dashboard-widget «Гарантії, що закінчуються» (30 днів).

QA: review 1 IMPORTANT (abe63125 — WarrantyCreateModal date TZ off-by-one: local-parse `T00:00:00`
.toISOString() зсував дату на -1 у UTC+3 → `T23:59:59Z` + addDaysISO). Tester Bug #718 MEDIUM
(deb037ec — create/claim не інвалідували dashboard expiring-widget, окреме key-дерево →
invalidateWarrantyAffected хелпер). Live-verified проти реальної БД: create→claim→400-reclaim,
loyalty PATCH persist, expiring endpoint. web 710 тестів (+10). tsc web 0.

**Міграції хардненингу застосовано** (Docker піднято): add_auth_token_version_and_lockout +
add_idempotency_key. Live-verified: session-revocation (logout-all→401), idempotency (same-key→same-payment).

---

## 2026-09-09 — Технічний хардненинг-бэклог (пост-QA): data-integrity / auth / observability / security / installer

Реалізація затвердженого бэклогу (окрім over-engineering + 2 великих спірних L). Per-секція QA
(review→tester), автономно. 13 feature-комітів + review/tester фікси. tsc api+web+shared 0.

**B — auth** (575875db): session revocation через AuthAccount.tokenVersion (JWT payload + jwt.strategy/
refresh порівнюють → mismatch=401); POST /auth/logout-all (bump version = вийти всюди); changePassword
bump; brute-force lockout (failedAttempts/lockedUntil, 5 спроб→15хв, перевірка ПЕРЕД bcrypt); password
policy min 8 (setup); web logoutAll + кнопка. review CLEAN.

**A — data-integrity:**

- A1 (410e1b77/24f0cd23/193c79f6): IdempotencyKey таблиця + RESERVE-FIRST interceptor на 6 create-POST
  (insert перед handler; P2002→replay/422/409; release-on-throw) → дедуплікація offline-retry без дублів;
  global purge scheduler. review CLEAN.
- A2 (71f0fdc6): soft-delete guard gap-fill (vehicles active-WO / goods stock-balance; counterparties/
  warehouses/employees уже мали) → 0 orphaned records.
- A3 (2883553f + fix 124b0795): per-org reconciliation scheduler (read-only drift-detection: stock/
  balance×BALANCE_SIGN/paidAmount, keyset-пагінація проти OOM). review-фікс: unbounded findMany→keyset.
- A4 (bd57a70e/7e1a373f): mileage max-wins у sync (монотонний пробіг, обидві LWW-гілки); CI-guard
  проти деструктивних міграцій (лише нові файли, `-- destructive-ok:` escape).

**C1a — audit** (96796b17): AuditService.record() у payments+invoices create (userId уже threaded).
C1b (counterparties/inventory/settings) відкладено — потребує controller+signature плумбінг.

**D — observability** (a7bb97c0): health /live (без залежностей — container-healthcheck б'є сюди,
уникає cascade) vs /ready (DB+Redis+MinIO+черга→degraded); docker-compose log rotation (x-logging
10m×5 на 6 сервісів). D3 bull-board відкладено (потребує Docker для auth-тесту).

**E — security/UX** (6545b48e): CSP prod (main.ts default-src 'none' + Caddyfile SPA-CSP); focus-trap
useFocusTrap у Modal (Tab-cycle+restore, WCAG); SectionErrorBoundary (money/media секції ізольовані).
next/image+bundle-analyzer свідомо пропущено (static-export+unoptimized+signed-URL / dev-only).

**F — installer** (e98d3324 + fix 98f8f115/36a1e4a7): Update.ps1 rollback (fix VERSION перед pull,
migrate через run --rm поки старі живі, health /live→таймаут→rollback+exit 1, усі fail-гілки exit 1);
Register-ScheduledTasks (backup УВІМК/update ВИМК opt-in). Закриває ADR-007. Tester-фікси: #716
same-tag rollback no-op guard, #717 UTF-8 BOM на всі 10 скриптів (PS 5.1 мохібейк).

Tester фінальний: 2 MEDIUM (#716/#717 installer) виправлено; D/E/C1a/A CLEAN. Broader infra-mismatch
(release.yml :version-теги vs compose/.env :latest) — задокументовано для наступного проходу.

---

## 2026-09-09 — review Цикл 1 Фаза 2: повний pre-prod code review (R1-R3 scope)

Повний чекліст sto-review по scope R1-R3 (payments/purchase-orders/work-orders/suppliers/
invoices/loyalty/inventory/integration-logs/4 scheduler + frontend). Backend money-flow —
зразковий: усі задокументовані патерни (CAS-first, Bug #688 idempotency, secret-redact,
cross-tenant FK-guard, cross-kind config-guard) уже застосовані у R1-R3. 3 фікси.

### 21365cff fix(review): toast-guard fallback + nbu manual enqueue removeOnFail/jobId

- **§8.5 (Important)** — `counterparties/page.tsx`: усі 6 `toast.*` тепер під
  `features.toastEnabled` + новий `actionError`-банер як fallback. Раніше 0 з 6 захищені →
  коли toast вимкнено, помилки delete/bulk-delete/save-filter зникали безслідно (`queryError`
  покриває лише завантаження списку, не мутації).
- **§8.5 (Important)** — `invoices/page.tsx`: 2 останні незахищені `toast.*` у delete-handler
  (з 6) під guard + `setError` fallback — консистентно з bulk-cancel у тому ж файлі.
- **§2.5 (Suggestion→Important)** — `nbu-fetch.scheduler.ts` `enqueueImmediate`: +`jobId`
  (`nbu-fetch-now-<org>`, дедуп спаму кнопки «оновити зараз») +`removeOnFail: 200` (bounded
  Redis-retention — раніше єдиний з трьох `.add()` у файлі без обох, невдалі manual-jobs росли
  безмежно).

tsc api ✅ 0 + web ✅ 0. Тести: exchange-rates 12 + payment-polling 19 + provider-config 24 зелено.

---

## 2026-09-09 — QA Цикл 2: повний 8-фазний прогін (0 HIGH / 0 функц. дефектів — спадна крива)

Другий послідовний QA-цикл на HEAD Цикла 1. Кожна фаза — свіжий/ширший кут, ніж Ц1. Результат
підтверджує зрілість коду: серйозні баги вичерпані (R1-R3 + Ц1), Ц2 ловить лише консистентність+perf.

- **Ф1 sync** (e6293596) — ширший scope (усі контролери). **Bug #715 (MED)**: SettlementsTabContent
  TX_COLORS не збігався з бековим BALANCE_SIGN (REFUND=warning, CREDIT_NOTE=muted замість success −1)
  → cross-page колір-drift vs картка контрагента → text-success. +2 backlog (warranties/loyalty-config
  UI — pre-existing net-new фічі, винесено власнику). Direction 2 (URL) + secret-leak — CLEAN.
- **Ф2 review** (9c6e2c73) — 0 фіксів. Верифіковано усі 5 фіксів Ц1 CORRECT (CAS-claim вікна #711,
  EPSILON-напрям #712, P2002-scope #714, DEFAULT_JOB_OPTS merge — 0 completed-job reads).
- **Ф3 tester** (13fe809c, 7fc875f4) — 0 функц. дефектів (5 нових кутів: redact edge / offline-queue /
  FSM boundary / settlements-color / integration-logs authz — усі захищені). Підняв settlements-канон у
  @sto/shared (SETTLEMENT_BALANCE_SIGN + похідні) з cross-layer invariant-guard проти майбутнього drift.
- **Ф4 optimize** (59eb57f2, b77e4af8, b7f72849, 48167e96) — 2: Payment covering-index
  (orgId,fiscalStatus,createdAt)+migration під /payments FAILED-фільтр; React.memo на RevenueChart
  (SSE-tick reconcile). Широкий sweep reports/dashboard/settlements/work-orders — CLEAN.
- **Ф5 e2e** — 52/52 Playwright (settlements/dashboard/reports-filters/counterparty/console-errors).
- **Ф6 simplify** — CLEAN (код Ц2 уже на правильній глибині; backend/shared BALANCE_SIGN дубль +
  invariant-тест — навмисне defense-in-depth, не колапсувати: інакше слабша типізація/інверсія залежності).
- **Ф7 code-review --fix** (41337174) — 2 косметика: residual cross-page drift #715 недоловив —
  color-token (text-destructive→text-destructive-text) + minus-glyph (ASCII '-'→U+2212 '−').
- **Ф8 security-review** — 0 vulns (settlements/counterparty рендерять поля як React-escaped JSX,
  індекс non-unique orgId-leading, shared-константи без секретів).

Підсумок: tsc api+web+shared 0, api 1981 + web 696 green. **QA зупинено після Ц2** — 0 HIGH/0 функц.
дефектів + 4 фази верифікації поспіль чисто; Ц3 зайвий (рішення власника).

---

## 2026-09-09 — QA Цикл 1: повний 8-фазний прогін (sync→review→tester→optimize→e2e→simplify→code-review→security)

Повний послідовний QA-цикл на pre-prod-хардненому коді (R1-R3). Фікси одразу, коміт per-фаза.

- **Ф1 sync** — CLEAN (0 розбіжностей API↔UI у 3 напрямах).
- **Ф2 review** (21365cff, 3419fd76, 2c0c03a6) — 2 Important: ungated toast у counterparties (6/6)
  - invoices (2/6) → guard + actionError-банер; nbu enqueueImmediate без jobId/removeOnFail → додано.
- **Ф3 tester** (833f8b8e…55aa8667) — **2 HIGH**: Bug #711 cash-shift.close() подвійний Z-звіт
  (stale-read→CAS-claim перед зовнішнім Z + revert); Bug #712 PO over-receipt (прийом 100 на
  замовлені 10 — CAS ≠ бізнес-max, fail-fast стеля з EPSILON). +MED #713 checkbox DONE-write CAS,
  +LOW #714 nbu P2002-idempotent. +10 тестів, усі mutation-verified.
- **Ф4 optimize** (fee0e361, a25c0115) — covering-index integration_logs (orgId,provider,createdAt)
  - additive міграція; useCallback на invoices payment-Modal onClose (listener-thrashing).
- **Ф5 e2e** — 93/93 Playwright passed (прямий npx, без MCP): smoke + cross-cache-invalidation +
  counterparty-detail + invoices FSM/оплата/фільтри/soft-delete/bulk + payments + console-errors.
- **Ф6 simplify** (8a99679c) — DEFAULT_JOB_OPTS спільний для 11 BullMQ черг (removeOnFail cap на
  registerQueue-шарі замість ~11 .add()-сайтів). Backend/frontend решта — CLEAN.
- **Ф7 code-review --fix** — 0 багів (1 false positive: cashShift update tenant-where відхилено).
- **Ф8 security-review** — 0 vulns (tenant-isolation усіх нових updateMany/findFirst з orgId; 0 raw
  SQL/SSRF/secret-leak; redact/integration-log service незмінні у range).

Підсумок: tsc api+web 0, api 1979 + web 696 green. HIGH-баги лише у щойно-доданих CAS/receive
шляхах (тепер закриті); 4 фази верифікації поспіль — чисто.

---

## 2026-09-09 — audit R3: перед-прод третій раунд (frontend IDOR/derived-fields + ops/lifecycle)

Третій раунд аудиту (кут: authz/IDOR, frontend derived-consistency, ops/queue-lifecycle). 3
паралельні агенти + власна верифікація. Ядро (money-CAS, tenant, secrets) з R1/R2 підтверджено;
знайдено frontend-consistency + queue-lifecycle дефекти.

### b5ab13f6 fix(pre-prod-r3): cache-invalidation + ПДВ-прев'ю + тип-aware баланс + queue caps

- **WEB-R3-1/2/3** — крос-ресурс інвалідація платежу. invoices-сторінка (handlePay/QR-onPaid),
  useCreatePayment, invoice-transition інвалідували лише власний ключ → баланс контрагента/WO/
  список платежів застарівали до staleTime. Новий спільний `invalidatePaymentSideEffects`.
- **WEB-R3-4** — InvoiceCreateModal прев'ю «Разом» = Σ(qty×unitPrice) БЕЗ ПДВ → заниження для
  EXCLUSIVE-орг. Тепер бере авторитетний per-line `priceWithVat` (правильно і для INCLUSIVE — не
  подвоює). Нові ручні рядки без backend-розрахунку → qty×unitPrice (backend додасть ПДВ).
- **WEB-R3-5** — колір балансу контрагента фарбувався лише за знаком → борг КЛІЄНТА (balance>0)
  зеленим замість destructive. Тип-aware `settlementBalanceTone(balance, cp.type)` у панелі І таблиці.
- **WEB-R3-6** — QrPaymentModal `onPaid` міг спрацювати повторно (refetch/reopen дає PAID знову) →
  латч `useRef`, скид на відкриття → рівно раз.
- **F1** — `removeOnFail:200` на 4 repeatable scheduler-и (followup/nbu-fetch/invoice-overdue/
  integration-log-purge): без cap failed-set у Redis росте безмежно (offline-БД на ПК СТО).
- **F2** — payment-polling: стеля `pollAttempts` (~2год) для наміру БЕЗ expiresAt (wall-clock guard
  його б не закрив) → шлюз навічно pending більше не крутить 5с-цикл вічно → EXPIRED. Mutation-verified.
- **fix** — integration-log-purge processor-тести: wall-clock delta біля добової межі давав flaky
  ~21h замість ~24h → точне порівняння з Kyiv-семантикою коду (`addDaysKyiv`).

tsc web+api 0. api 1969 + web 696 green.

---

## 2026-09-08 — audit R2: перед-прод другий раунд (concurrency/idempotency/derived-fields)

Другий раунд аудиту (глибше: concurrency/idempotency, derived-field consistency, regression). 3
паралельні агенти + власна верифікація. Знайшов **3 HIGH СІБЛІНГИ** раунд-1 PO-receive бага +
MEDIUM-и. Ядро підтверджено: Σ-інваріант, batch-consume, LWW-sync, encrypted-secrets, gold-standard
CAS-сайти (stock-documents/completion-acts/invoices) — CLEAN.

### 09391226 fix(review): getAvgCost tx-read у consumeBatch AVG_COST-гілці (audit-r2 sibling)

Верифікація fa65a312+51c8cc5b (sto-review-agent): усі 7 фіксів CORRECT & COMPLETE, дзеркалять
gold-standard CAS точно, no regression. Знайдено 1 латентний сіблінг getAvgCost tx-read фіксу —
`batch.service.consumeBatch:190` AVG_COST-гілка досі кликала `getAvgCost` без tx (недосяжно з
прод-викликачів: inventory.service завжди передає 'FIFO' у consumeBatch, але consumeBatch —
внутрішня поверхня). `db = tx` вже у скоупі → передано; zero-cost, закриває пастку для майбутніх
викликачів. tsc api 0, повна suite 1968 зелено.

### fa65a312 fix: stale-read→CAS у 3 FSM-переходах + date-400

- **HIGH×3** — work-orders.transition(COMPLETED) / supplier-payments.confirm / supplier-returns.confirm
  усі мали stale-read guard (re-read+throw, НЕ CAS) → concurrent → подвійний CHARGE / SUPPLIER_PAYMENT /
  WRITEOFF+REFUND. Коментарі посилались на «supplier-payments.confirm CAS» як еталон, але той його не
  мав (phantom). Fix: CAS `updateMany where status=expected` ПЕРШИМ, count=0→throw.
- **MEDIUM (self-regression)** — integration-logs findAll date @Query invalid→Prisma 500 → parseDateOr400.

### 51c8cc5b fix: loyalty quantize + reserved-guard + getAvgCost tx (MEDIUM)

- loyalty redeem/earn квантують points до 2dp → balance не розходиться з Σ(ledger).
- inventory reserved≤quantity guard і на quantityDelta<0 (пряме WRITEOFF нижче reserved).
- getAvgCost читає через tx (AVG_COST COGS бачить uncommitted RECEIPT тієї ж tx).

Усі mutation-verified. tsc api 0, повна API-suite 1962→1968 зелено. Лишок round-2 — LOW (cash-shift
close CAS, checkbox non-atomic, JSON.parse guard, PO transition CAS): задокументовано, non-blocking.

---

## 2026-09-08 — audit: перед-прод перевірка тех-боргу + логічних помилок (3 HIGH + money/security)

Широкий read-only аудит по всьому проєкту (3 паралельні агенти: money/inventory/FSM · offline/
черги/scheduler/sync · security/tenant/config) + власна верифікація кожної знахідки. Ядро визнано
дуже добре захищеним (settlement-знаки, Σ-інваріант, C2-реверс, double-charge, FSM-симетрія, cloud-
sync — CLEAN). Виправлено реальні дефекти:

### 41be8e14 fix(audit): PO receive CAS + cross-tenant goodId guard (HIGH×2)

- **H1 (money+stock):** PO receive() мав stale-read guard, НЕ CAS → 2 concurrent/дубльовані receive()
  подвоювали залишок + борг постачальнику. Fix: per-line CAS на received-delta.
- **cross-tenant (HIGH):** PO+stock-doc create/update писали lines[].goodId сирим (не валідований з
  orgId) → org A підсунула б goodId org B → крос-tenant рух складу. Fix: validateLineGoodIds (обидва).

### f2a35705 fix(audit): VAT config + TurboSMS token-redact + SSRF parity (MEDIUM/LOW)

- **M5 (money):** invoices.addLine хардкод `?? 20` → NONE-org отримував 20% ПДВ. Fix: getDefaultVatRate.
- **secret leak:** turbosms error без redactSecrets (токен у body) → ехо-4xx витік би у NotificationLog.
  Fix: redactSecrets + повний SSRF-guard-набір на turbosms/esputnik/nbu.

### 21d517c6 fix(audit): booking duration + Kyiv weekday + confirm CAS/orphan (HIGH)

- **H2:** availability блокувала confirmed-заявку вікном тривалості поточного запиту → double-booking.
  Fix: skip матеріалізованих (вже у busyCalendarSlots). **H3:** confirm CAS на stale-статусі + orphan-
  слот → CAS на 'PENDING' + cleanup. **M3:** weekday .getDay()→Kyiv.

Кожен фікс — mutation-verified regression. tsc api 0, повна API-suite 1962 зелено. Відкладено (non-
blocking, задокументовано): M2 Kyiv date-range list-фільтри, M1 supplier-overpay guard, M4 bankAccount
role-gate, migration IF NOT EXISTS (вже застосована).

---

## 2026-09-08 — feat: IntegrationLog — логи зовнішніх обмінів (metadata-only) + UI + retention

Жоден зовнішній обмін (LiqPay/Checkbox/Вчасно/Нова Пошта/monobank) раніше не залишав сліду.
Тепер кожен HTTP-обмін пишеться у append-only `IntegrationLog` — МЕТАДАНІ ЛИШЕ (без тіл, без
секретів), з UI-вкладкою й щоденним retention-очищенням. Узгоджено: усі 5 провайдерів, метадані,
нова таблиця+UI, scheduler-очищення N днів. QA: sync CLEAN → review (2 фікси) → tester (2 баги).

### ba4784c6 feat backend

Seam `IntegrationLogService.wrap<T>(ctx, fn)` — обгортка виклику провайдера у процесорах/сервісах
(де orgId/branchId/provider/operation/documentId у скоупі; на fetch-рівні їх нема). Таймінг +
fire-and-forget запис + RE-THROW (control flow незмінний → лог не зриває money/fiscal). 10 wrap-
сайтів. GET /integration-logs (OWNER/ADMIN, фільтри). Purge scheduler (03:00, forEachActiveOrg) +
processor (orgId-scoped deleteMany, clamp[1,365]). Міграція 20260908160000 + OrganisationSettings.
integrationLogRetentionDays. +14 тестів (secret-hygiene, fire-and-forget, purge).

### d5c656e5 feat frontend

useIntegrationLogs hook + вкладка «Логи інтеграцій» (таблиця/фільтри/пагінація/retention-поле).

### c0ea923b fix(tester): #709 PIN-leak + #710 pagination NaN

- **#709 HIGH (security):** redactSecrets поріг `<6` НЕ маскував 4-значний Checkbox pin_code
  (реальний касирський PIN = 4 цифри) → витік би у IntegrationLog.error при ехо-4xx. Знижено до `<3`.
- **#710 LOW:** NaN page/limit (`?page=abc`) → Prisma skip/take=NaN → HTTP 500. NaN-guard у
  спільному calculatePagination (захищає всі 20+ list-endpoints). +regression (redact/checkbox/pagination).

---

## 2026-09-08 — review: IntegrationLog (secret-hygiene defense-in-depth + a11y)

### 1bc106f8 fix(review): IntegrationLog — redact body-borne секретів + a11y на фільтрах

Code review фічі IntegrationLog (ba4784c6 backend + d5c656e5 frontend). Secret-hygiene,
fire-and-forget, orgId-scope purge, control-flow equivalence (10 wrap-сайтів, checkbox 401-retry),
scheduler (mirror nbu-fetch) — усе підтверджено чистим. 2 захисних фікси:

- `redactSecrets()` util + застосування у Nova Poshta та Checkbox клієнтах. `wrap()` свідомо
  секрет-сліпий; `error`=response-body провайдера. Але NP шле сирий apiKey у JSON-body,
  Checkbox — pin_code+licenseKey у body sign-in → якщо провайдер ЕХО-не запит у 4xx, `response.text()`
  витік би у IntegrationLog.error. Redaction на рівні клієнта (де секрет у скоупі). monobank/LiqPay/
  Вчасно шлють creds у ЗАГОЛОВКАХ → не зачеплені.
- a11y: aria-label на select-фільтрах (Провайдер/Статус) IntegrationLogsTab.
- redact.spec.ts (5 тестів).

tsc api/web 0. nova-poshta+checkbox+integration-log 99 зелено, redact 5 зелено.

---

## 2026-09-08 — fix: звірка інтеграцій з живою докою (Вчасно v3 + Нова Пошта mapStatus) + INTEGRATIONS.md

Аудит mock-first інтеграцій проти офіційної доки + пошук публічних sandbox-кредів. Усі 5
провайдерів дають безкоштовний self-service тест-доступ без податкових/еквайрингових договорів
(деталі + джерела → `docs/INTEGRATIONS.md`, memory `reference_integration_sandbox`).

### 8e6c8f78 fix(delivery): Нова Пошта mapStatus — термінальні 102/106

Коди 102 (відмова відправника) і 106 (зворотна доставка) — термінальні, але падали у
default→IN_TRANSIT → nova-poshta-polling опитував би НП нескінченно. Виправлено на RETURNED
(TERMINAL зупиняє self-re-enqueue). +31 тест (кожен код + інваріант термінальності).

### 74fa2254 fix(fiscal): Вчасно.Каса — переписано під Cloud API v3

Попередній shape був повністю хибний (v1 REST `/api/v1/shifts/open|receipts/sell` + Bearer →
401/404). Реальний API: ЄДИНИЙ `POST /api/v3/fiscal/execute` з `task`-кодами (0/1/11/18),
auth = сирий токен без `Bearer`. Контракт FiscalProvider незмінний, зміни ізольовані в одному
файлі. +11 тестів (endpoint/task/raw-token/копійки/401/3xx). Точні імена полів чека продажу —
фіналізувати на живій тест-касі. LiqPay/Checkbox/monobank підтверджені коректними (косметика).

---

## 2026-09-08 — feat: C2 — повернення запчастин + сторно боргу при скасуванні завершеного наряду

Раніше COMPLETED-наряд не можна було скасувати (FSM), тож `returnToBatch` (готовий, але
неприв'язаний метод) не мав виклику. Тепер `COMPLETED→CANCELLED` повертає списані запчастини
на склад і сторнує борг. Backend + shared-константи (без web-компонентів). QA: review (1 CRITICAL
sync-gap виправлено) → tester (0 runtime-багів, 2 test-gaps закрито). Повна suite 1862→усі зелено.

### 24fc5f94 feat(work-orders): C2 ядро

- schema/міграція 20260908140000: `StockMovementType += RETURN` (окрема additive-міграція).
- inventory.service: RETURN-гілка у createMovement — StockItem++ + `restoreBatchesForReturn`
  (агрегація негативних BatchConsumption по batchId → `returnToBatch` раз на партію; guard проти
  недоповернення через per-line idempotency). Guards: neg-qty / missing doc refs → 400.
- work-orders.fsm: `COMPLETED: ['INVOICED','CANCELLED']`.
- work-orders.service: `returnPartsAndCredit` — реверс `writeOffPartsAndCharge` (per part RETURN +
  один CREDIT_NOTE). Wired у CANCELLED-гілку під guard `wo.status==='COMPLETED'`. Single-shot.
- Тести +11 (RETURN per-part, CREDIT_NOTE, coeff, shared-batch агрегація, WRITEOFF→RETURN
  round-trip інваріант, FSM COMPLETED→CANCELLED).

### c50d5bb3 fix(review): sync-gap FSM-мапа (CRITICAL) + take-cap

Frontend `WO_STATUS_TRANSITIONS.COMPLETED` лишався `['INVOICED']` → кнопка «Скасувати» не
рендерилась для завершеного наряду → C2 був би UI-dead-code. Синхронізовано shared-мапу +
`take:5000` на restore-запиті.

### 299780ad test(tester): C2 regression guards #705–#706

- #705 (MEDIUM, test-drift): fsm-buttons.test мав сталу локальну FSM-фікстуру (пре-C2) → додано
  describe що імпортує ФАКТИЧНУ shared-мапу й асертить кнопку «Скасувати» + незворотність INVOICED/PAID.
- #706 (MEDIUM, coverage-gap): shared-batch агрегація перевірялась лише через мок `toHaveBeenCalledTimes(1)`
  → новий stateful `return-roundtrip.invariants.spec` з in-memory Prisma-store + РЕАЛЬНІ Inventory+Batch
  сервіси доводить `Σ remainingQty==StockItem.quantity` (+ демонстрація недоповернення без агрегації).

> **Follow-up (поза C2):** WO скасований з COMPLETED стає soft-delete-able — безпечно (рухи нетяться
> до нуля). Пре-існуючий design-ризик: мутабельний `GoodUoM.coefficient` між COMPLETED і CANCELLED
> (той самий розрив у reserve↔release) — не введений C2.

---

## 2026-09-08 — refactor: закриття технічного боргу (config-over-hardcode §13 + scheduler + multi-branch)

Пакет усунення реального тех-боргу (працювало, але не ідеально). Backend + DB only, без
фронтенду й без інтеграцій (vchasno/liqpay/checkbox/nova-poshta не чіпались). Full API suite
1809→1832 (+23 regression). tsc api 0.

### 2d7c672e reports — laborCostRatio config-over-hardcode (§13)

Хардкод `LABOR_COST_RATIO=0.4` у reports.service → `OrganisationSettings.laborCostRatio`
Decimal(4,3) default 0.4 per-org (звіт рентабельності). Міграція 20260908120000 (ADD COLUMN
IF NOT EXISTS, zero-config). DEFAULT_LABOR_COST_RATIO fallback + clamp [0,1] + try/catch→дефолт.

### 60996a07 invoices — дефолтний dueDate за invoiceDueDays (§13)

`OrganisationSettings.invoiceDueDays` (7) раніше не застосовувався. Тепер за відсутності
явного dueDate → `documentDate + invoiceDueDays` (Kyiv DST-aware addDaysKyiv), у create() і
createFromWorkOrder() (обчислення поза Serializable tx). autoArchiveDays — TODO-нотатка (без
споживача, auto-archive scheduler ще нема).

### 9dccf8c4 calendar — межі робочого дня day-split з BranchSettings per-branch (§13)

Хардкод 8..20 day-split → `BranchSettings.workStartTime/workEndTime` per-branch (резолв через
lift.zone.branchId). parseHour("HH:mm") + resolveWorkHours() з fallback (без ліфта / без
settings / workEnd≤workStart / помилка). +2 дискримінуючі тести.

### 3e45c69a scheduler — спільний forEachActiveOrg cursor-пагінація (Bug #107)

FollowUp/Overdue/NBU дублювали `findMany({take:1000})` + warning → cloud >1000 орг тихо не
охоплювались. Винесено keyset-обхід активних орг батчами по 500 (skip:1+cursor). NBU
prefetch-ить nbuFetchHour per-batch. +5 тестів пагінації.

### c0ab3059 notifications — followup SMS per-branch конфіг (multi-branch C3)

Followup слав усі SMS через «найстарішу» філію → клієнт з філії B отримував SMS через
провайдер філії A. Тепер кожен отримувач шле через конфіг СВОЄЇ філії (lastWO.branchId),
fallback для авто без наряду; resolveConfig memoized per унікальну філію (0 DB reads у
fan-out); отримувачі без конфігу філії — skipped. +1 multi-branch тест.

### 9ba2e594 booking — усунено stale doc-drift (CAL-H3/H4 реалізовано)

ConfirmBookingDto коментар стверджував TODO про BookingRequest→lift link — насправді link
існує й confirm() матеріалізує слот на ліфті. Тільки коментар.

---

## 2026-09-08 — feat: 4 відкладені пункти (returnToBatch / OVERDUE / Bug #675 / booking per-lift)

Реалізація пунктів, що аудит логічних помилок свідомо не чіпав (dead code / незроблені фічі /
задокументовані tradeoff). Кожен пройшов QA (sync 0 / review / tester).

### 009e7a7a inventory — returnToBatch: CAS + верхній cap + ідемпотентність

Готовий, але незахищений метод зворотного руху партій отримав захист (дзеркалить consumeBatch):
CAS `updateMany where remainingQty ≤ receivedQty − qty` (не даємо remaining>received) + orgId +
ідемпотентність findFirst return-consumption по (batch,document). Без міграції.

### ad7c9b72 invoices — OVERDUE-статус (BullMQ scheduler)

OVERDUE був недосяжний (нема writer'а), хоча dashboard/reports уже фільтрували. Новий per-org
repeatable job 06:00 Kyiv → updateMany SENT/PARTIALLY_PAID з dueDate<сьогодні→OVERDUE (системний
перехід, оминає FSM). payments/online-payment гейт +OVERDUE (прострочений рахунок оплачуваний).

### 35c9c634 + 7836d1ff invoices — Bug #675: ручний PAID → дзеркальний PAYMENT (money-critical)

Standalone-рахунок отримує CHARGE на SEND, але ручний →PAID писав лише paidAmount без PAYMENT →
у леджері висів борг попри PAID. Fix: PAID-гілка transition() створює PAYMENT на непокритий залишок
ЛИШЕ для standalone (workOrderId=null); WO-рахунок не чіпаємо (CHARGE через COMPLETED). CAS перед
settlement; PAID термінальний → рівно один раз. review-fix: +tx timeout 10s (2 settlement-write).

### 907f8a44 + 635b2b37 booking — per-lift слоти (CAL-H3/H4)

Раніше CONFIRMED-заявка блокувала весь HH:MM на ВСІХ ліфтах; confirm() не матеріалізував слот.
Fix: BookingRequest +liftId (міграція 20260908100000); getAvailability блокує саме обраний ліфт;
confirm() матеріалізує CalendarSlot(BOOKED) через calendar.createSlot (конфлікт-чек+split+EXCLUDE);
create() cross-tenant lift-guard; фронт-віджет шле liftId. **tester Bug #699**: cancel() тепер
звільняє матеріалізований слот (інакше скасування назавжди блокувало ліфт — lifecycle-асиметрія).

### deploy

`prisma migrate deploy`: 20260907160000 (liqpay_qr), 20260907180000 (loyalty idempotency),
20260908100000 (booking lift). Усі additive/idempotent, застосовані на dev-БД.

---

## 2026-09-07 — fix(review): 0d0d1656 code review циклу (реєстри провайдерів + QR-оплата)

Прямий (без субагента) повний чекліст по фічах реєстрів ПРРО/еквайрингу/доставки + QR-оплата + sync-фікс garageName. **3 фікси (0 CRITICAL / 2 IMPORTANT / 1 SUGGESTION):**

- **IMPORTANT §2.5** — `online-payment.service`: `pollQueue.add()` після закомічених intent+gateway-рахунку був голим `await` → Redis-down валив би вже-створений намір HTTP-500 (QR/pageUrl уже показано касиру). Fix: `.catch()`+`logger.error` (offline-first, дзеркалить delivery/payment-polling процесори).
- **IMPORTANT §8.5** — `purchase-orders/page.tsx`: `markDeleted` + supplier-return delete мали 3 негейтнуті `toast.success/error` (решта 7 у файлі гейтнуті `features.toastEnabled`) → toast crash/no-op при вимкненій фічі. Гейтнуто всі 3.
- **SUGGESTION §1** — `schema.prisma`: коментарі `BranchProviderConfig.kind/provider` лишались `FISCAL|PAYMENT` / `checkbox|vchasno|monobank|liqpay` після додавання DELIVERY/nova-poshta → `+= DELIVERY / nova-poshta` (comment-only, без міграції).

Решта чекліста CLEAN: SSRF-guard у всіх external clients, credentials у ENCRYPTED_FIELDS + write-only + виключено з sync, tenant-isolation скрізь, провайдер-коди end-to-end консистентні, processors concurrency+cap+idempotent, міграції з окремим ADD VALUE для DELIVERY. tsc api+web ✅ 0.

---

## 2026-09-07 — fix(sync): 5ca1f8a9 повний sync-аудит (Direction 1/2/3)

Прямий (без субагента) повний sync-аудит на HEAD 58f71bb8, фокус на нових модулях (delivery-providers, fiscal-providers, payment-gateways, online-payments, cash-shift). Direction 1 і 3 — 0 розбіжностей. Direction 2 — 1 фікс: `vehicles/new` викликав неіснуючий `GET /customer-garages/:id` (гаражі мають лише list-endpoint без by-id маршруту) → завжди 404, назва гаража не показувалась. Fix: `garageName` передається у query з картки контрагента (об'єкт вже в пам'яті), прибрано мертвий fetch/state/невикористаний імпорт. tsc api+web ✅ 0.

---

## 2026-09-07 — feat: інтеграція Нової Пошти — трекінг доставки у документі купівлі (PurchaseOrder)

Служба доставки як delivery-провайдер через існуючий registry (`ProviderKind=DELIVERY`). Щойно у документі купівлі вказано номер накладної (ЕН) → self-re-enqueuing polling Нової Пошти оновлює статус доставки автоматично. Інтервал опитування (хв) — у налаштуваннях.

### 917140dc db + delivery — схема + backend

- **Schema**: `enum DeliveryStatus {PENDING IN_TRANSIT ARRIVED DELIVERED RETURNED NOT_FOUND}`; `PurchaseOrder +trackingNumber/deliveryStatus/deliveryStatusRaw/deliveryStatusUpdatedAt +@@index([orgId,deliveryStatus,deletedAt])`; `ProviderKind +DELIVERY`; `OrganisationSettings +deliveryPollIntervalMinutes(30, clamp[5,1440])`. Міграція `20260907140000` additive/idempotent.
- **DeliveryProvider** interface + `NovaPoshtaClient` (POST `/v2.0/json/` TrackingDocument.getStatusDocuments; SSRF+redirect:manual+timeout+reject-3xx) + `NovaPoshtaProvider` (mapStatus StatusCode НП→DeliveryStatus; невідомий→IN_TRANSIT) + registry.
- **NovaPoshtaPollingProcessor**: self-re-enqueue delay з `OrganisationSettings.deliveryPollIntervalMinutes` (НЕ hardcoded); jobId-дедуп `np-poll-<poId>` single-flight; зупинка на термінальному/зникненні ЕН/видаленні PO/`MAX_POLL_ATTEMPTS=480`; оновлює ЛИШЕ delivery-метадані (НЕ FSM закупівлі). `job.data` без ЕН/секретів → zombie-job re-read з БД.
- **DeliveryTrackingService** (enqueueInitial + pollDelayMs clamp); `PurchaseOrdersService` create/update enqueue при вказанні/зміні ЕН, скидання при очищенні; DRAFT-guard перед trackingUpdate.
- `DeliveryProvidersController` (list/verify/branch-config/activate) через `ProviderConfigService` (kind=DELIVERY); creds write-only, apiKey шифрується (`BranchProviderConfig.credentials`).
- DTO +trackingNumber (create @MaxLength; update nullable→очистити); toDto +delivery-поля; settings +deliveryPollIntervalMinutes.

### c7424745 web — ЕН + статус доставки + вкладка «Доставка»

- `PurchaseOrderCreateModal` +поле «Накладна (ЕН)»; create шле undefined, update шле null при очищенні (зупиняє трекінг); dirty-baseline/reset/load оновлено.
- `panel-schema` +trackingNumber/deliveryStatus (бейдж з кольором + тултип deliveryStatusRaw); `DELIVERY_STATUS_LABELS/BADGE` (укр.); PO page renderOverride null-safe («—»).
- `DeliveryTab` (NEW): `ProviderRegistryPanel` (delivery-providers, Нова Пошта apiKey) + інтервал опитування (хв) → PATCH /settings/organisation; settings-таб «Доставка».

### 490822b4 review — 2 фікси (0 critical, money/security CLEAN)

- **IMPORTANT** cross-kind leak: `legacyFromBranchSettings` мала `if FISCAL{} else PAYMENT` безумовно — `kind=DELIVERY` повертав monobank-конфіг чужого kind. Fix: `if (kind !== 'PAYMENT') return null`.
- **SUGGESTION**: polling `update` без `deletedAt:null` → soft-deleted PO міг отримати оновлення delivery. Fix: `updateMany({...,deletedAt:null})`.

### be199e01 tester — 0 логічних дефектів, 3 test-gap (#696-#698)

- Фіче-код КОРЕКТНИЙ (весь edge-набір: normalizeTracking, DRAFT-guard порядок, mapStatus рядок/невідомий, zombie-job re-read, clamp, cross-kind). Закрито coverage-gap: PO create/update+trackingNumber (13), DeliveryTrackingService (11), zombie-job/jobId (+2). API 1808. Mutation-verified.

### deploy — застосувати на проді

`prisma migrate deploy` для `20260907140000_nova_poshta_delivery` (additive: enum DeliveryStatus, ProviderKind+=DELIVERY, 4 PO-поля + index, deliveryPollIntervalMinutes).

---

## 2026-09-07 — feat: registry провайдерів ПРРО (Checkbox+Вчасно) і еквайрингу (monobank+LiqPay) + вибір активного per-branch

Дзеркалить provider-registry сповіщень для фіскалізації та еквайрингу: кілька провайдерів на філію, активний обирається ексклюзивно (лише 1 per kind). Секрети шифруються at-rest; legacy read-fallback на старі BranchSettings-колонки → вже-налаштовані філії працюють без міграції даних.

### 9df90aad db — BranchProviderConfig (спільна схема)

- `enum ProviderKind {FISCAL PAYMENT}`; `model BranchProviderConfig` (kind/provider/enabled/apiUrl/credentials/shiftMode, `@@unique([branchId,kind,provider])`); `CashShift +provider` (яким ПРРО-провайдером відкрито зміну).
- `credentials` = JSON-рядок секретів, шифрується at-rest ЦІЛИМ полем (`ENCRYPTED_FIELDS['BranchProviderConfig']=['credentials']`); виключено з `PULL_TABLES`/`PUSH_SAFE_TABLES`.
- Міграція `20260907120000` additive/idempotent (enum-guard, ADD COLUMN/CREATE TABLE IF NOT EXISTS, сід не-секретних конфігів з BranchSettings, `credentials NULL` → legacy-fallback).

### a4729dd0 payments — registry платіжних шлюзів (monobank + LiqPay)

- `PaymentGateway` interface + `PaymentGatewayRegistry`; `MonobankGateway` (обгортка parity) + `LiqpayGateway` (новий: data+signature SHA1, checkout-URL як QR, status action=status, SSRF/3xx/timeout).
- `online-payment.service`/`payment-polling.processor` → `registry.get(intent.gateway)`; `intent.gateway` = активний шлюз (не хардкод); **money-critical CAS/Bug#688-idempotency/reconcile збережено ДОСЛІВНО**.
- `PaymentGatewaysController` (list/verify/branch-config/activate); creds write-only.

### 025d9f36 payments — registry провайдерів ПРРО (Checkbox + Вчасно.Каса)

- `FiscalProvider` interface + `FiscalUnauthorizedError` (провайдер-агностичний); `CheckboxProvider` (обгортка parity) + `VchasnoProvider` (новий: Bearer-токен, shift/sell, SSRF/401).
- `cash-shift.service`/`checkbox.processor` через registry; `CashShift.provider` фіксує чим відкрито; `ensureToken` резолвить `resolveByCode(shift.provider)` (не «активний»).
- `ProviderConfigService` (resolveActive/resolveByCode + legacy-fallback + getBranchConfigs/upsert/activate); `FiscalProvidersController`.

### 7c347330 web — панелі вибору активного провайдера + QR без хардкоду monobank

- `ProviderRegistryPanel` (спільна, параметризована kind/endpoint) — картки, Switch ексклюзивної активації, модалка кредів write-only з verify; `FiscalTab` → дві панелі (ПРРО + еквайринг).
- `QrPaymentModal` заголовок «QR-оплата» (працює для будь-якого шлюзу).

### 5ef0dbd1 review + 6ab4e28d tester — money/security CLEAN + Bug #692 (CRITICAL)

- **Review** (5ef0dbd1): 0 critical/important; усі 7 money/security-critical напрямів CLEAN; прибрано dead logger у LiqpayGateway.
- **Tester** (6ab4e28d): **Bug #692 CRITICAL** — сід міграції створює `enabled=true` рядок з `credentials=NULL`, а `resolveActive` повертав його одразу без hasCreds-guard → не доходив до legacy-fallback де реальні секрети → після `prisma migrate deploy` тихий повний fiscal+money outage на вже-налаштованих філіях (зміна не відкривається, чек не б'ється, QR не створюється). Сигнал: асиметрія з `resolveByCode` (той мав guard). Fix: `resolveActive` падає у legacy-fallback для того ж провайдера при порожніх кредах. +12 тестів (#693-#695). API 1745.

### deploy — застосувати на проді

`prisma migrate deploy` для `20260907120000_branch_provider_config` (additive: enum, ADD COLUMN cash_shifts.provider, CREATE TABLE branch_provider_configs, сід не-секретних конфігів).

---

## 2026-09-07 — fix(tester): QR-оплата monobank — Bug #688 double-charge idempotency-link

### eabcc465 payments — Bug #688 (CRITICAL) idempotency-лінк проти double-charge + тести #689-#691

Bug hunt фічі «QR-оплата monobank» (feat 7c08833c + sync 14c18a0e + review 025bf77f). 1 CRITICAL знайдено+виправлено + 4 test-gap закрито (усі нові файли фічі мали 0 тестів). API 1695/107files (+57), web 695/69files (+11).

- **Bug #688 CRITICAL (money/double-charge)**: `finalizePayment` не був ідемпотентний до `payments.create`. Три write-и money-flow (CAS `PENDING→PAID` → `payments.create` → `intent.update({paymentId})`) не атомарні. Вікно: `create` комітиться, потім link-write `update({paymentId})` падає (транзієнт) → намір лишається `PAID+paymentId=null` → наступний reconcile-poll бачить те саме → `payments.create` ВДРУГЕ → дубль Payment + дубль settlement + подвійний `invoice.paidAmount` = тихий double-charge клієнта. `jobId` single-flight не рятує (вікно послідовне, не конкурентне). Іронія: сам review-fix reconcile-гілки (доданий щоб не втратити гроші після падіння) породив дзеркальний баг — подвоїти гроші.
- **Fix**: `Payment.onlinePaymentIntentId String? @unique @db.Uuid` (additive nullable міграція `20260907000000_payment_online_intent_link`) → БД боронить другий INSERT (P2002). У `finalizePayment`: (1) pre-create `findFirst({orgId, onlinePaymentIntentId})` — якщо запис уже є, лише до-лінковуємо; (2) на P2002 (гонка) — дістаємо winner і лінкуємо. Mutation-verified вимкненням pre-guard.
- **Test-gap**: #689 `monobank.client.spec` NEW 26 (createInvoice/getStatus-мапінг усіх 8 статусів, X-Token, SSRF, 3xx, timeout); #690 `online-payment.service.spec` NEW 13 (createIntent guards/ordering/no-poll-on-fail, getIntent без секретів); #691 `payment-polling.processor.spec` NEW 18 (CAS once-only, crash-recovery reconcile, terminal states, tenant); frontend `QrPaymentModal.test` NEW 8 + `FiscalTab` +3 (monobank write-only round-trip).
- Verified CLEAN: MonobankClient (SSRF/3xx/timeout/X-Token/мапінг), createIntent-guards, CAS once-only + orgId, wall-clock-expiry без monobank-виклику, finalize cap MAX=360, токен write-only.

### 99f5f513 skills — sto-tester: підхід «non-atomic idempotency-link double-create»

- Новий детектор: після write-послідовності A→B→C де C — link-write, а reconcile-гілка перечитує стан і повторює A→C, перевіряти що A ідемпотентний (DB `@unique` guard + pre-check + P2002-recovery), інакше падіння між A і C → повторний A = дубль.

### deploy — міграцію застосувати на проді

`prisma migrate deploy` для `20260907000000_payment_online_intent_link` (additive: `ADD COLUMN onlinePaymentIntentId` nullable + `CREATE UNIQUE INDEX IF NOT EXISTS`).

---

## 2026-09-07 — feat(payments) + fix(review): QR-оплата monobank Acquiring (online payment)

### 7c08833c payments/web — QR-оплата monobank (intent + QR + polling + auto-Payment)

Онлайн-оплата рахунку через QR monobank Acquiring. Offline-first: клієнт сканує QR (monobank `pageUrl`) і платить на стороні monobank, сервер лише опитує `invoice/status` — 0 публічних endpoint, оминає NAT/webhook.

- **Schema**: `enum OnlinePaymentStatus {PENDING PAID FAILED EXPIRED}`; `model OnlinePaymentIntent` (gateway/gatewayInvoiceId/pageUrl/amount/counterpartyId/invoiceId?/status/paymentId?/error?/expiresAt?); `BranchSettings +monobankToken (secret, encrypted) +monobankApiUrl`. Міграція `20260906240000_online_payment_intent` (+`requiresFiscal=true` для `monobank_qr`).
- **Backend**: `MonobankClient` (createInvoice→pageUrl / getStatus→мапінг; SSRF+redirect:manual+3xx-reject+AbortController 10s); `OnlinePaymentService.createIntent` (invoice SENT/PARTIALLY_PAID, amount=залишок, overpay-guard, intent PENDING→monobank→enqueue poll `payment-poll-${id}`); `PaymentPollingProcessor` (self-re-enqueuing delayed poll, CAS PENDING→PAID → `payments.create` рівно раз, wall-clock expiry); `POST/GET /online-payments` (@Throttle 20/60s, roles OWNER/ADMIN/ACCOUNTANT/RECEPTIONIST).
- **Frontend**: `useOnlinePayment` (create + poll refetchInterval 3000 gated on active); `QrPaymentModal` (`qrcode.react` QRCodeSVG); invoices-сторінка `method==='monobank_qr'` → «Показати QR».

### 025bf77f payments — MONEY-CRITICAL: реконсиляція вікна збою CAS→Payment

- **CRITICAL crash-window (silent money-loss)**: CAS комітить PAID, потім crash до `payments.create`/`paymentId`-write → наступний poll early-return на `status!==PENDING` → гроші в monobank, а Payment ніколи не створений. Fix: reconciliation-гілка (intent `PAID && paymentId==null` → `finalizePayment`), спільний `finalizePayment()`, jobId-deduped single-flight, `MAX_FINALIZE_ATTEMPTS=360` cap. Решта review CLEAN.

---

## 2026-09-07 — fix(sync): QR-оплата monobank — polling gate stuck on initial status

### 14c18a0e payments/web — sync-check QR-оплати monobank (online-payment + monobank.client + useOnlinePayment + QrPaymentModal + FiscalTab)

Sync-check фічі «QR-оплата monobank» (online-payment.controller/service, monobank.client, useOnlinePayment.ts, QrPaymentModal.tsx, FiscalTab.tsx monobank-секція). 1 фікс (frontend), решта напрямів CLEAN.

- **Fix**: `QrPaymentModal` гейтив polling (`useOnlineIntentStatus` enabled) через `isPending = intent?.status === 'PENDING'`, де `intent` — одноразовий стан зі створення наміру, ніколи не оновлюваний після PAID/FAILED/EXPIRED → полінг тривав безкінечно навіть після термінального статусу (всупереч задокументованому «на терміналі зупиняємось»). Fix: окремий `live` state зберігає останній polled статус; гейт і відображуваний `status` тепер похідні від `live ?? intent`; `live` скидається разом з `intent` при відкритті модалки/новому наміру.
- CLEAN верифіковано: OnlineIntent (frontend) field-for-field = OnlineIntentDto (backend); apiFetch URLs POST/GET `/online-payments[/:id]` збігаються з контролером; **security round-trip** — `monobankToken` write-only, `mapBranchSettings` (спільний для GET і PATCH branch-settings) ніколи не повертає сирий токен, лише `hasMonobankToken:boolean`; `qrcode.react` встановлено і імпортується коректно; ролі POST/GET `/online-payments` (OWNER/ADMIN/ACCOUNTANT/RECEPTIONIST) збігаються з invoices-сторінкою; `monobank_qr` присутній у payment-methods seed і setup.service.
- tsc api+web ✅ 0.

---

## 2026-09-06 — fix(review): ПРРО Крок 2 — гонка double-OPEN + tenant-scope refreshToken + branch-scope pending

### b8747f15 payments — code review ПРРО Крок 2 (касова зміна + PIN-token + реальні чеки)

Security-sensitive review фічі «CashShift + cashier PIN-token + реальні чеки Checkbox» (feat 0cfa27d5). 3 фікси (0 CRITICAL / 2 IMPORTANT / 1 SUGGESTION); криптографія токена, SSRF, offline, tenant, ролі — перевірено CLEAN.

- **IMPORTANT** гонка double-OPEN: `open()` робив findFirst-then-create без DB-constraint. Під AUTO_OPEN у processor (concurrency:3) два платежі одного branch без відкритої зміни проходили guard одночасно → ДВІ OPEN-зміни + два фіскальних shift-и у Checkbox. Fix: частковий unique `cash_shifts_one_open_per_register_uq` (WHERE status='OPEN' AND deletedAt IS NULL) + P2002-recovery у `open()` → повертає зміну-переможця (processor продовжує у неї, не падає).
- **IMPORTANT** `refreshToken` робив `update({ where: { id } })` без orgId (§2.2) → `updateMany({ id, orgId })` (tenant-scoped no-op на чужий shiftId, не безумовна інвалідація токена по глобальному id).
- **SUGGESTION** `pendingReceipts` рахувався org-wide → скоуплено до branchId зміни (Payment→workOrder.branchId), інакше картка однієї каси показувала QUEUED-чеки всіх філій.
- CLEAN верифіковано: токен at-rest шифрується (ENCRYPTED_FIELDS, encrypt create+update / decrypt-on-read через $extends незалежно від select), toDto НЕ повертає токен, ніде не логується; PIN/licenseKey тільки для sign-in; SSRF (validatePublicUrl+redirect:manual+AbortController 10s/15s+reject-3xx, дзеркало webhooks/settings); offline→throw без phantom-зміни; 401→refreshToken→retry-once; MANUAL no-shift→QUEUED-wait (не FAILED передчасно); ролі nav==controller==page; укр. Оцінено-прийнятно: ensureToken/refreshToken concurrency last-write-wins (Checkbox видає новий токен per sign-in — ідемпотентно, без корупції).
- tsc api/web 0, checkbox.processor 12/12.

---

## 2026-09-06 — fix(review): EmailProvider transport.close() у finally (leak на error-path)

### 53b62596 notifications — code review Email-канал + генералізація recipient

Code review фічі «Email через SMTP (nodemailer) + генералізація recipient» (feat 0f4d3f4f + fix 82f505a3). 1 фікс (0 CRITICAL / 1 IMPORTANT resource-leak / 0 SUGGESTION); решта 8 напрямів CLEAN.

- **IMPORTANT** `EmailProvider.send()`/`verifyCredentials()` закривали nodemailer-transport лише на success-гілці → кинутий `sendMail`/`verify` (SMTP timeout/auth-фейл/ECONNREFUSED) лишав TCP-сокет висіти; `concurrency=3 × attempts=10` = десятки leaked-сокетів. Fix: transport створюється ДО `try`, `close()` у `finally` на обох шляхах. +2 leak-guard тести.
- CLEAN верифіковано: recipient per-channel (EMAIL→email, else→phone; wrong-locator неможливий; empty chain→no job); SMTP JSON у apiKey (JSON.parse толерантний, 0 injection, pass шифрується at-rest, не тече у GET/логи); maskRecipient без index-error; міграція idempotent rename; parity SMS/Viber/TG; offline timeouts 10s + BullMQ retry; tenant/укр/payments-guard phone||email; frontend openCreds скидає SMTP-стейт (0 stale pass), pass write-only.
- Skill +§2.5 детектор «external-transport `close()` у finally». tsc api/web 0, notifications 126/126 (+2).

---

## 2026-09-06 — fix(review): ексклюзивність провайдера — гейт per-channel Switch + empty-state guard + a11y

### c441606f notifications — інваріант «активний лише 1 провайдер»

Code review фічі «ексклюзивна активація провайдера» (feat ad304c88). 3 фікси (0 CRITICAL / 2 IMPORTANT / 1 SUGGESTION); решта 7 напрямів CLEAN.

- **IMPORTANT** інваріант ексклюзивності ламався per-channel Switch: `activateProvider` атомарно (array-form `$transaction`, обидва `updateMany` мають `orgId`+`branchId`+`deletedAt:null` — tenant-safe) встановлює «активний лише 1», але per-channel `toggleEnabled` міг увімкнути окремий канал ІНШОГО провайдера → `resolveConfig` (фільтр `enabled:true` по всіх провайдерах) взяв би два провайдери у fallback-ланцюг. Fix: `toggleEnabled` гейтить `enabled && c.provider !== activeProvider`; Switch каналу неактивного провайдера `disabled`.
- **IMPORTANT** empty-state no-op: активація провайдера без жодного каналу → `updateMany` 0 рядків + хибний success-toast + Switch відскок. Fix: guard `channels.some(c=>c.provider===code)` перед POST.
- **SUGGESTION** a11y: `role=button` картки провайдера `focus:ring`→`focus-visible:ring-inset` (§14, коміт 6c8eeff5).

Верифіковано ЧИСТИМ: tenant-scope обох updateMany, атомарність array-form (0/2 active неможливо), activateProvider не торкається apiKey, Switch — сиблінг role=button (не nested-interactive), tabIndex+onKeyDown Enter&Space+aria-label (WCAG 2.1.1). tsc api/web 0.

---

## 2026-09-06 — fix(review): Phase 3 «мульти-канал сповіщень» — atomic upsert + orgId-scope + UX

### ff0c009f notifications Phase 3 — atomic upsert, orgId-scope, verify guard, UX

Code review Phase 3 (feat ab6bda3e — UI-панель провайдерів + verify-endpoint + creds-modal + Switch + пріоритет каналів). 5 фіксів (0 CRITICAL / 3 IMPORTANT / 2 SUGGESTION):

- **IMPORTANT** `upsertBranchChannel`: findFirst-then-create → atomic `prisma.upsert` по `@@unique([branchId,channel])`. Усуває (а) `update({ where:{ id } })` без orgId у where (defence-in-depth), (б) гонку двох одночасних PATCH на той самий (branchId,channel) → P2002/500 або дубль. apiKey write-only + reactivate soft-deleted збережено.
- **IMPORTANT** `saveCreds` показував «Креди збережено» + закривав модалку навіть при збої PATCH (patchChannel ковтав помилку). patchChannel тепер повертає boolean; success-гілка гейтиться на ok.
- **IMPORTANT** priority-swap: другий PATCH лише після успіху першого + блок конкурентних move → уникнення двох каналів з однаковим priority.
- **SUGGESTION** verify `@Param('code')` guard length<=64 (не проходить ValidationPipe).
- **SUGGESTION** Switch `focus:ring` → `focus-visible:ring` (a11y).

Верифіковано чистим: verifyProvider без orgId безпечно (Map-lookup + зовнішній HTTP з body-apiKey, 0 DB); getBranchChannels apiKey→hasApiKey; apiKey не логується; throttle 5/60s; take на всіх findMany; Switch role=switch+aria-checked+keyboard OK. tsc api/web ✅ 0.

---

## 2026-09-06 — fix(review): Phase 2 «мульти-канал сповіщень» — removeOnFail + take + sync-notes

### d76372fc removeOnFail на SMS-чергах (apiKey у job.data) + take + sync-exclusion notes

Code review Phase 2 (feat e21bd702 fallback-engine + Viber + NotificationLog, 39066748 schema).

- **IMPORTANT:** `removeOnFail: 200` на обидва enqueue-сайти SMS-черги
  (`notifications.service.sendWithConfig` + `sms.processor.tryNext`). `job.data.chain` несе
  apiKey провайдера у відкритому вигляді — без removeOnFail невдалі jobs (останній канал
  reject→throw після 10 ретраїв) залишались у Redis назавжди → секрет живе безстроково +
  ріст памʼяті. Обмежене вікно як у webhooks-черзі.
- `take: 20` на `notificationChannelConfig.findMany` + `notificationTemplate.findMany` у
  `resolveConfig` (обмежені @@unique, §1 defence-in-depth).
- `sync.service`: коментар про ВИКЛЮЧЕНІ з sync таблиці (notification_channel_configs=apiKey,
  notification_logs=phone/append-only, branch_settings=smsApiKey) — щоб не потрапили у PULL_TABLES.

Верифіковано ЧИСТИМ: fallback chainIndex-семантика (retry повторює саме chain[chainIndex],
не рестартує з 0, не пропускає канали, no infinite-loop); orgId на всіх нових запитах;
apiKey не тече у response/логи; повідомлення українською; N+1 у template-fetch відсутній.
tsc api 0, notifications 27/27.

---

## 2026-09-06 — feat(api): provider-registry сповіщень + fix PAYMENT_RECEIVED (Phase 1a з фічі «мульти-канал»)

### 12f4b145 provider-registry + PAYMENT_RECEIVED fix

Перша фаза великої фічі «мульти-провайдер / мульти-канал сповіщень з fallback»
(повний план: `~/.claude/plans/sleepy-spinning-zephyr.md`). Ця фаза — фундамент без
зміни поведінки SMS:

- NEW `notifications/providers/`: `NotificationProvider` interface, `TurboSmsProvider`
  (SMS + `verifyCredentials` через /user/balance), `NotificationProviderRegistry`.
- `sms.processor`: switch `provider==='turbosms'` → `registry.get(provider)` (extensible seam).
- **Fix latent bug:** payments `PAYMENT_RECEIVED` не мав `branchId` → SMS про оплату НІКОЛИ
  не слалась; тепер branchId = наряд.branchId або найстаріша філія org.
- Тести: TurboSMS provider 7 + registry; parity notifications+payments 28/28. tsc api 0.

**СТАТУС ФІЧІ — ПРИЗУПИНЕНО на Phase 1a.** Залишилось (робити з повним QA-ланцюгом
після відновлення subagent-доступу — org тимчасово вимкнув Claude для subagent-моделі):

- **Phase 2:** NotificationLog + NotificationChannelConfig (міграції) + Viber-канал у
  TurboSmsProvider + fallback-engine (BullMQ chainIndex, send-result fallback).
- **Phase 3:** UI-панель провайдерів у NotificationsTab + `POST /settings/notification-providers/:code/verify`
  (токен+баланс) + creds-modal + пріоритет каналів (up/down) + Switch-примітив.
- **Phase 4:** шифрування кредів at-rest (AES-256-GCM, ключ від інсталятора) — закриває H-2.

## 2026-09-06 — feat: PO-пікер (джерело) у create StockDocument/SupplierReturn (Phase D2)

Опціональний пікер «Замовлення (джерело)» у create-модалках StockDocument та
SupplierReturn — заповнює нульовий FK `purchaseOrderId` (міграція 20260905130000).
Додатково й опціонально: документ без PO створюється нормально.

- **Backend DTO:** `CreateStockDocumentDto`/`CreateSupplierReturnDto` +
  `@IsOptional() @IsUUID() purchaseOrderId?`; response DTO + `purchaseOrderId` +
  `purchaseOrderNumber` (join `purchaseOrder.select.number`).
- **Backend service:** `create()` персистить `purchaseOrderId: dto.purchaseOrderId ?? null`;
  опц. FK-guard — коли задано, `purchaseOrder.findFirst` (orgId+deletedAt:null) інакше
  `BadRequestException('Замовлення не знайдено')`. Guard пропускається якщо undefined.
- **Frontend:** обидві модалки — `EntityPickerField` «Замовлення (джерело)» + окремий
  `SearchPickerModal` (`/purchase-orders?q=&limit=30`). SR скоупить список до обраного
  постачальника client-side (endpoint не приймає `?supplierId=`). Create-only: у edit
  пікер disabled, номер лишається read-only. Dirty-детектор: SR — `purchaseOrderId` у deps;
  StockDoc — id живе у `form` (вже покритий `[form,lines,open]`).
- **Тести:** +3 service-spec на модуль (persist / null / invalid→BadRequest). API 78/78 у
  двох модулях, web 9/9 (dirty-guard SR 2/2 + document 2/2 — чистий open не брудниться).

---

## 2026-09-05 — feat: «Пов'язані документи» для всіх документів + навігація (Phases A–B)

Розширення фічі «пов'язані документи» (раніше лише у Наряді) на всі документи +
можливість переходити до пов'язаного документа. Фазами A→B→C→D.

**Phase A — фундамент** (commits 5433f932-контекст, далі):

- Узагальнено `LinkedDocumentsPanel` → config-driven (`config`+`entityId`); кожна
  сутність постачає `LinkedEntityConfig {fetchPath, sections[{key,title,icon,mapRow}]}`.
- NEW `lib/linked-nav.ts` (`useLinkedNav`): навігація routed ([id]) для WO/SP/Counterparty,
  deep-link `?open=<id>` для модальних (invoices/PO/stock), `?openReturn=` для supplier-return.
- NEW `lib/linked-configs.tsx`: `workOrderLinkedConfig` (дзеркало 1:1) + Phase-B конфіги.
- **Фікс латентного 404**: клік по рахунку у панелі → `/invoices?open=<id>` замість
  window.open на неіснуючий `/invoices/:id`.
- Deep-link `?open=`/`?openReturn=` додано у invoices (Suspense-wrap)/stock-documents/PO.

**Phase B — Invoice / PurchaseOrder / SupplierPayment** (прямі-FK, найбільша цінність):

- Backend (commit 00449f17): `GET :id/linked-documents` + `POST linked-counts` у 3 модулях,
  дзеркалить WO (orgId+deletedAt, take:500, Decimal→Number, groupBy zero-init counts,
  route-ordering перед `:id`, `LinkedCountsDto {ids}`). Payment без deletedAt (append-only).
  Форми: Invoice `{workOrder,payments,counterparty}`, PO `{supplierPayments,counterparty}`,
  SP `{purchaseOrder,counterparty,account}`. Тести: invoices 47, PO 79, SP 62.
- Frontend: конфіги (commit ffada58e) + badge-колонка «Зв'язки» у списках + вкладка/попап.

**QA-ланцюг** (sync→review→tester):

- sync: 0 розбіжностей (endpoints/keys/counts/roles/deep-links усі збігаються).
- review: 0 проблем (orgId+soft-delete, zero-init counts, Decimal→Number, hook-order, a11y).
- tester: **Bug #641 (MEDIUM, виправлено)** — `getLinkedCounts` рахував за наявністю FK,
  а `getLinkedDocuments` фільтрує `deletedAt:null` → soft-deleted контрагент/рахунок/PO
  (досяжно: delete-guard блокує лише _відкриті_ документи, тож PAID-рахунок може
  посилатися на видаленого контрагента) давав badge «1» над порожньою секцією. Fix:
  counts рахують лише живі записи (batched findMany deletedAt:null, без N+1). Commit 2ad6318f.
  Bug #642 (LOW) — mount-once `?open=` не реоткриває модалку при self-navigation на ту саму
  сторінку; наразі недосяжно (жоден конфіг так не навігує) → задокументовано як known-limit.

**Phase C — Counterparty** (commit aa152fb7): вкладка «Документи» у деталі контрагента —
рахунки / замовлення постачальнику / оплати постачальнику / повернення постачальнику з
переходом. Backend `GET counterparties/:id/linked-documents` + `getLinkedCounts` (4 секції,
orgId+deletedAt:null, Decimal→Number, groupBy deletedAt:null — count==detail). Тести:
service +4, contract +2 (route-ordering, non-UUID 400).

**Phase D — StockDocument + SupplierReturn** (повна, зі схемою):

- D1 (commit 53c0e7b0): nullable FK `purchaseOrderId` + covering-індекси + reciprocal
  relations; additive/idempotent; backfill неможливий (задокументовано).
- D3+D4 (8d898757): backend linked-documents (StockDoc `{purchaseOrder,warehouses}`,
  SR `{purchaseOrder,counterparty,warehouse}`) + badge-колонка/попап/секція + навігація.
- D2 (6bd007f6): опційний PO-пікер (джерело) у create-модалках StockDoc/SupplierReturn;
  персистить `purchaseOrderId` (create-only, FK-guard tenant-scoped); dirty-guard оновлено.

**QA-ланцюг Phase D** (sync→review→tester):

- sync: 0 розбіжностей.
- review: **1 Important (виправлено, 8db8a589)** — `getLinkedCounts` рахував за наявністю
  FK, а detail фільтрує deletedAt:null → soft-deleted PO/склад/постачальник давали badge
  «1» над порожньою секцією (повтор Bug #641 у нових модулях). Fix: counts рахують лише
  живі записи.
- tester: **Bug #643 (HIGH, виправлено, 53e45efd)** — deep-link `?openReturn=<id>` виставляв
  лише `editId`, але SR-модалка (`open={srCreateOpen}`) лишалась закрита → уся навігація до
  повернень постачальнику з панелей була тихо неробоча. Fix: `resolvePurchaseOrdersDeepLink`
  - ефект виставляє обидва setter-и. Item 3 (guard↔tx race при soft-delete PO) — прийнятний
    розрив (UI ховає stale через deletedAt-фільтр).

Тести: Web 554, linked-doc API-модулі 351, tsc api+web+shared 0.

## 2026-09-05 — feat(web): UX-фічі списків/модалок (Подання, індикатори, guard, клавіатура, дублювання)

### 15d54839 fix(tester): Bugs #637-#640 (QA-ланцюг UX-фіч)

Bug hunt по 6 UX-фічах — 4 баги знайдено й виправлено (0 CRITICAL / 2 HIGH / 1 MEDIUM /
1 LOW), усі з дискримінуючими регрес-тестами:

- **#637 (HIGH) clone double-submit** — `handleClone` у списку нарядів був гейтований лише
  `useState cloningId`: два синхронні кліки в один тік читали `null` до ре-рендеру → 2 POST
  `/clone` → 2 дублі. Fix: новий hook `useSubmitGuard` (`inFlightRef` синхронний). Тест
  native `.click()`×2 + vulnerable-harness.
- **#639 (HIGH) dirty-guard false positive** — baseline озброюється `setTimeout(0)`, але
  async-завантаження `/warehouses`+`/branches` та авто-вибір єдиного складу лендяться ПІСЛЯ
  → програмний `setWarehouseId` трипив dirty-детектор → фальшивий діалог «незбережені зміни»
  на чистій формі. 4 модалки (SupplierReturn/PO/Stock/WorkOrder; Invoice імунний). Fix:
  `autoWarehouseRef`/`autoBranchRef`/`autoDefaultsRef` пропускають рівно цей auto-select.
- **#638 (MEDIUM) nested Ctrl+Enter** — scope-check коректний, але не покритий; +2 stacked-modal
  регрес-тести.
- **#640 (LOW)** — «фільтр»→«подання» rename був неконсистентний (SaveFilterButton placeholder);
  виправлено + оновлено stale-тест.

Web ✅ 540/540, tsc web 0. Self-improvement: sto-tester SKILL — новий патерн async-default
dirty-guard false-positive + розширено double-submit «де шукати ще» (list-row handlers +
useSubmitGuard).

### 911590ca feat(web): «Створити на основі» у рядку списку нарядів (Ф8)

Дія-дублювання прямо зі списку work-orders через наявний `POST /work-orders/:id/clone`
(копіює позиції у новий DRAFT-наряд, новий номер, actualHours скинуто). Після clone —
відкриває копію в edit-модалці + інвалідує список; guard `cloningId` проти подвійного кліку.
Ф8 вже була для Invoice (список «Дублювати») і WorkOrder detail — цей коміт додає швидкий
доступ зі списку. PO/Stock не мають clone-endpoint (поза скоупом).

### 5433f932 feat(web): UX подання/індикатори/guard/клавіатура

6 узгоджених UX-фіч для списків документів/об'єктів і модалок:

- **Ф1 Збережені Подання** — `SavedFilter` тепер несе `columns+order+sort` (back-compat зі
  старими записами; guard на `undefined`). `useTableColumns.setVisible()` + `useSortState.set()`
  для відновлення вигляду. work-orders save/apply знімає й відновлює повний вигляд.
  `SavedFiltersBar` перейменовано на «подання» (UI-текст).
- **Ф4 Кольорові індикатори рядка** — новий `lib/row-status.ts` (чиста, enum-агностична
  `rowStatusTone → overdue/today/debt/none` + `border-class`; `none`=прозора рамка зберігає
  вирівнювання). Застосовано у work-orders/invoices/purchase-orders. supplier-payments
  пропущено — немає дедлайну/балансу (рейка була б інертна).
- **Ф5 Unsaved-guard** у 5 великих create-модалках (WorkOrder/Invoice/PO/Stock/SupplierReturn):
  `useDirtyForm` через baseline-ефект (mark-on-change після осідання стану) замість десятків
  точкових markDirty; `confirmClose` у `onClose`; `resetDirty` на save-success.
- **Ф6 Ctrl+Enter/Cmd+Enter → submit** у `modal.tsx` (гейт `keyboardShortcutsEnabled`, scoped
  на панель проти подвоєння у вкладених модалках; onSubmit у ref). `onSubmit` прокинуто у
  5 модалок (`isEditMode ? save : create` — відповідає видимій кнопці).
- **Ф7 Вкладка «Зв'язки»** — вже присутня: WorkOrder-модалка має вкладку «Документи»
  (LinkedDocumentsPanel + count-badges), Counterparty detail — реляційні вкладки. Інші
  сутності не мають linked-documents endpoint (бекенд-скоуп, поза UX-поліруванням).
- **Ф8 «Створити на основі»** — див. 911590ca (WO список) + наявні Invoice/WO-detail.

Тести: row-status 10, useSavedFilters +3 (view round-trip + back-compat), modal +4
(Ctrl/Cmd+Enter, no-modifier, no-op). Наявні double-submit тести модалок зелені. tsc web 0.

---

## 2026-09-05 — fix(review): UI-гейтинг isSystem для валют/методів оплати (аудит 635c8816)

### 9af68c61 fix(review): UI-гейтинг isSystem для валют і методів оплати

Аудит коміту 635c8816 (audit-round3: isSystem-захист Currency + PaymentMethodConfig).
Бекенд + міграція + seed + 9 тестів — **повністю коректні** (backfill codes = seed,
міграція ідемпотентна й безпечна на наявних/soft-deleted даних; guards блокують delete +
rename/code системних, лишають NBU/isActive/requiresFiscal; resurrection зберігає
isSystem; таблиці поза sync). **1 IMPORTANT знайдено/виправлено:**

- Коміт заявляв «UI гейтить delete/edit», але frontend interfaces не містили isSystem і
  UI нічого не гейтив: кнопка delete UAH/Готівки активна; PATCH незміненого name/code
  системного запису → 400 (guard перевіряє `!== undefined`, не факт зміни).
- Fix: +isSystem?:boolean у ndi/types.ts Currency + ndi|settings/shared.ts PaymentMethod;
  CurrenciesTab+PaymentsTab (ndi) — badge, delete прихований, name(+code) disabled,
  save не надсилає заблоковані поля для системних; toggle isActive лишається;
  settings/PaymentsTab (dead) — дзеркалено body-omit. Дзеркалить UnitsTab.
- tsc web/api/shared 0; API currencies+payment specs 12/12.

---

## 2026-09-04 — fix(review): WEB-M13 lost-update у useDetailPanelConfig (аудит audit-wave5)

### b6277a8f fix(review): WEB-M13 lost-update у useDetailPanelConfig (value-based setState)

Аудит коміту 99ea2ce9 (audit-wave5). Перевірено КОРЕКТНІСТЬ 5 пунктів — 4 бездоганні
(MD-H1 FK/статуси, MD-H2 VIN excludeId/empty-skip, MD-M2 isSystem-order/visited-set/self-parent,
WEB-M9 fmtMoney/fmtInt). **1 регресія знайдена/виправлена:**

- WEB-M13: перехід `setConfig(prev=>next)` → `setConfig(next)` з `config` у замиканні
  (deps [config,persist]) увів lost-update — два швидкі toggle в одному tick (до re-render)
  читали стейл-`config`, другий губив зміну першого. Обмін дубль-PUT (StrictMode) на втрату
  даних. Fix: `configRef.current` тримає останній config; мутатори читають/пишуть ref
  синхронно → чейнінг; persist() лишається поза updater (StrictMode-фікс збережено).
- +1 регрес-тест (2 toggle в одному act() → обидва поля; буга-версія давала лише один).
- tsc web/api 0, web 498→499, affected API 65/65.

---

## 2026-09-04 — fix(tester): Bug #629 — квантування похідних грошей у звітах (Хвиля 3 LIVE-аудит)

### eefa72ec fix(tester): Bug #629 — квантування похідних грошей у звітах (roundMoney)

Хвиля 3 LIVE-аудит (de35bf31+f7a935db): усі 6 фокус-пунктів PASS — roundMoney (38 edge),
Σ==total (LIVE invoice 100.10×3×20→360.36 узгоджено), WO-H1 CHARGE (LIVE 144=in-tx re-read),
PO receivedAmount→SUPPLIER_CHARGE (LIVE 99.99 exact), addDaysKyiv (6 DST-кейсів), регресії
(255 money-тестів + усі VAT-режими). **1 баг знайдено поза скоупом хвилі:**

- `reports.service` похідні гроші БЕЗ roundMoney: `totalCostLabor=totalLabor×0.4`
  (3520.30×0.4=1408.1200000000001), Σ-reduce (revenue/workOrders/settlements totals),
  різниця vat.net — float-дрейф, маскується fmt() на екрані, але просочується СИРИМ у
  CSV-експорт «Рентабельність» + JSON API. Fix: roundMoney на кожне похідне money-поле.
- Test-gap: reports.service.spec.ts (5 тестів; раніше 0 unit на весь ReportsService).
- SKILL.md: +§1.1 checklist (#629) + approach «money×дріб/reduce/різниця сирим у export/JSON».
- API tsc 0, тести 1183→1188.

## 2026-09-04 — fix(review): roundMoney на решті грошових шляхів (аудит de35bf31)

### f7a935db fix(review): roundMoney на решті грошових шляхів (completion-act PDF, PO/SR/loyalty/xlsx/reports)

Аудит wave-3 (de35bf31): roundMoney коректний (half-away-from-zero, +1e-9 не ламає великі
суми, від'ємні симетричні, Number.isFinite→0); WO-H1 in-tx re-read, addDaysKyiv, dateTo для
@db.Date — усе коректно; подвійне округлення НЕ дає розходження Σ(рядки)↔total. **0 багів у коміті.**

Закрито 9 залишкових un-rounded грошових результатів поза скоупом хвилі:

- completion-acts: `amount` позиції + PDF total (юридичний акт) через roundMoney
- invoices: 3× `priceWithVat = priceWithoutVat + vatAmount` (асиметрія з addLine)
- purchase-orders: totalAmount/totalVat, **receivedAmount (живить SUPPLIER_CHARGE)**, display amount
- supplier-returns: totalAmount (create+update) + display amount
- loyalty: discountAmount; xlsx: import amount; reports: stock-value value + totalValue

API tsc 0, тести 1183/1183.

## 2026-09-03 (c) — fix: конструктор звітів — фідбек користувача (5 проблем)

- **Згортання панелей:** кнопка «Згорнути/Налаштування» + авто-згортання після «Запустити»,
  звіт на всю ширину.
- **Легенда кольорів** чіпів під палітрою (число/статус/дата/текст).
- **Переклад enum** мовою інтерфейсу (CHARGE→«Нарахування») у рядках/групах/фільтрах.
  +2 shared-мапи (STOCK_MOVEMENT_TYPE_LABELS, SETTLEMENT_TX_TYPE_LABELS); response columns += enumName.
- **Групування по датах:** date-поля тепер groupable; нормалізація ключа по ДНЮ (не по секунді).
- Короткі заголовки агрегатів («Σ Сума» замість «Сума: Сума»).

**QA-ланцюжок:** sync 1 (enumName у backend-інтерфейсі) / review **1 CRITICAL** (date-групування
було по UTC-дню → операція о 01:30 Kyiv потрапляла у попередній день; fix — KYIV_YMD, +2 DST-тести
літо/зима) / tester 0 багів (live: ~25 cross-midnight записів — server == client Kyiv-день, інваріант
Σ==grandTotal). API 1149→1151, Web 495, tsc 0. Коміти 189e2510/089b790e/a9112413.

---

## 2026-09-03 (b) — fix: конструктор звітів — pivot-модель (логічний аудит)

Логічний аудит виявив розбіжність: UI обіцяв pivot (колонки+детальні рядки+групування), а
рушій вмів лише group-by+aggregate. Виправлено 4 діри + supporting:

- **#1 авто-SUM:** числова колонка без явної агрегації губилась → `effectiveAggregations` авто-SUM.
- **#5 детальні рядки:** були недосяжні → `detailRows` (плоскі) + `node.rows` (на листі),
  `includeRows` завжди. Тепер видно і колонки-значення, і окремі записи.
- **#6 сортування:** групи лише за алфавітом → `sortByAggregate` (клік по заголовку агрегату,
  toggle asc/desc); `∅` бере участь; `hasOwnProperty`-guard на alias (proto-injection, review).
- **#3 знакова quantity:** фільтр брав сире, SUM — знакове → `filterable:false`, фільтр по type.
- COUNT прибрано з нечислових полів (дублював group.count).

**QA-ланцюжок (live):** sync 1 (date-agg рендерився як гроші) / review 6 (4 IMPORTANT: quantity
як гроші, stale agg/sort, a11y aria-sort, **sortNodes proto-guard**; 2 suggest) / tester 2 HIGH
(**Bug #619** SUM(quantity) рахував резервування як фізичні → нетто 37 замість 57, cross-verified
`stockMovement.SUM==stockItem.SUM=57`; **Bug #620** date-агрегат як гроші коли поле не в columns).

Інваріант `Σлистків==grandTotal` — live-verified усі 9 сутностей diff=0. API 1130→1148, Web 495,
tsc 0. Коміти 611cb157/78aa9277/eee7cb8e/7ce451f9/5d79db82.

---

## 2026-09-03 (a) — feat: конструктор звітів (Report Builder)

### b6301d0e feat(report-builder): backend движок · 320e1e0a frontend

Самообслуговуваний конструктор звітів на `/reports` → вкладка «Конструктор»: перетягування
полів у колонки, фільтри, **ієрархічне групування до 5 рівнів** (контрагент → товари під ним),
поля зв'язаних обʼєктів через крапку (`Контрагент.Тип`), підсумки, збереження, експорт CSV/XLSX.

**Backend** (`apps/api/src/modules/report-builder/`):

- **report-registry.ts** — метадата-реєстр (ЄДИНЕ ДЖЕРЕЛО ПРАВДИ): WorkOrder, WorkOrderPart,
  PurchaseOrderLine (поля/зв'язки/агрегації/прапорці hasSoftDelete/stateNotFlow/signedByType).
- **report-query.builder.ts** — config→Prisma findMany з whitelist; `hasOwnProperty`-guard проти
  proto-injection; orgId+deletedAt інжектяться (deletedAt лише FULL); nested deletedAt (Bug #607);
  relation-поля через include+select; **injection неможливий за побудовою** (усі ключі — реєстрові
  літерали, ввід лише field.key).
- **report-aggregator.ts** — JS-групування ≤5 рівнів: SUM/COUNT/AVG/MIN/MAX; balance-SUM guard;
  знакова quantity; grandTotals незалежним проходом (AVG≠середнє груп).
- SavedReport модель + міграція `20260903120000_add_saved_reports`. Endpoints
  `/reports/builder/{metadata,run,saved*}`, ролі OWNER/ADMIN/ACCOUNTANT.
- normalizeKyivDateRange винесено у kyiv-date.ts (reuse з reports.service).

**Frontend**: вкладка «Конструктор» (ReportBuilder.tsx) — палітра чіп-токенів (native HTML5 drag),
3 drop-зони (Колонки/Групування/Фільтри), агрегація на числові колонки, фільтри op+value,
ієрархічна таблиця з розгортанням + tfoot-підсумки, збережені звіти, експорт CSV+XLSX.
useReportBuilder хуки.

**v1 = каркас + 3 сутності**; реєстр розширюваний (нова сутність = один запис, движок не міняється).

### QA-ланцюжок (live, docker піднято 2026-09-03)

- **sync (463da2ad)** — 3 розбіжності виправлено: +useRunSavedReport хук, фільтр-op `in` без UI-опції
  (тепер multi-select для enum / масив через кому), SavedReport.createdBy у типі.
- **review (0fb4d368)** — 1 IMPORTANT (Modal exit-анімація подвійний guard) + 3 SUGGESTION
  (named React imports, a11y: клікабельний рядок → inner button + aria-expanded + focus-visible,
  memo для palette/usedKeys). Backend 0 findings (injection неможливий, tenant/soft-delete/DoS ✓).
- **tester (a29ae594)** — **Bug #617 CRITICAL**: `mergeIncludePath` для комбо `good.name`+`good.brand.name`
  генерував Prisma-заборонений `include`+`select` на одному рівні → 400. Fix: relation-branch повністю
  через nested `select`. **Bug #618 LOW-DX**: PrismaClientValidationError мовчки → 400 без логу
  (тепер logger.warn з причиною). +3 regression.

**ФІНАНСОВИЙ ІНВАРІАНТ (live, 8 сценаріїв):** Σ(листкові aggregates) == grandTotal, diff=0 —
1-5 рівнів групування × усі 3 сутності (workOrder 30478, workOrderPart 3700, purchaseOrderLine
vatAmount 26760.6 / receivedQty 301). Валідації тримаються (proto-injection, whitelist, enum,
groupBy>5, дати, SUM-on-price, tenant, nested deletedAt Bug #607).

Fix під час live-верифікації (13861792): прибрано `where` з nested include (to-one relation →
Prisma "Unknown argument where"). +22 юніт/hook + 3 regression + 2 E2E. API 1112→1132, Web 491→495,
tsc 0/0. UI live-перевірено (палітра+зони), native HTML5 drag Playwright не симулює (обмеження PW).

---

## 2026-09-02 (g) — feat: drill-down документів у графіку оплат постачальникам

### 2d960bc9 feat(supplier-payments): drill-down документів у графіку оплат

Клік по клітинці/колонці «Графіка оплат» → панель під таблицею зі списком PO, по яких
виникає ця оплата (№ · дата оплати · сума · залишок · перехід на PO). Тригери: клітинка
постачальник×день, рядок «Разом» (усі постачальники), бакети «Протерміновані»/«Планові».

**Backend:** винесено ЄДИНИЙ private `computeScheduleAllocations` (FIFO-налив боргу на PO +
кредит-ліміт зі збереженням per-PO алокацій). `getSchedule` → тонка обгортка (DTO незмінний),
новий `getScheduleDocuments` фільтрує алокації по бакету → **Σ allocated панелі == сума клітинки
за конструкцією** (немає sibling-drift). Новий `GET /supplier-payments/schedule/documents`
(date XOR target, supplierId опційний) перед `:id`.

**Frontend:** `useSupplierPaymentDocuments` (enabled лише при кліку), клікабельні клітинки з сумою,
підсвічування активної, панель під таблицею, reuse `PurchaseOrderCreateModal` для переходу на PO.

### QA-ланцюжок

- **sync** — 0 розбіжностей (контракт узгоджений).
- **review (c7708711)** — 1 IMPORTANT: a11y — `role="button"` клітинки без `tabIndex`+`onKeyDown`
  (WCAG 2.1.1, keyboard-only не міг відкрити drill-down). Fix: `activateOnKey` + focus-visible ring.
- **tester (4ff47b9d)** — Bug #616 MEDIUM: новий `date` DTO мав `@Matches(YMD_RE)` без
  `@IsDateString({strict})` → семантично-невалідні дати (`2026-99-99`) → silent-empty замість 400
  (sibling-drift Bug #595 у тому ж файлі). Fix + 6 regression. **Live-інваріант консистентності:
  18/18 клітинок, 0 mismatches.**

API 1106→1112, Web 491, tsc 0/0, E2E +1.

---

## 2026-09-02 (f) — QA-цикл 3 фінальний: КОНВЕРГЕНЦІЯ (0 findings)

### review cycle 3 final — 0 findings

Незалежний фінальний прохід на HEAD 3f3a0a32 (26 файлів у diff 74bf41b6..HEAD). Перевірено:

- **createMovement no-tx self-wrap** (inventory.service.ts:87-91): recursive `$transaction(inner => this.createMovement(orgId, dto, innerTx))` — на 2-му проходженні `tx` defined → wrapper skip (0 подвійна обгортка). Всі inner-writes через `db=tx`. `getAvgCost` через `this.prisma` — read-only snapshot ДО списання (задокументовано). 15s timeout адекватний.
- **DB CHECK migration 20260902210000**: clamp idempotent (WHERE quantity<0), DO-guard IF NOT EXISTS на pg_constraint idempotent, імена унікальні (grep = 1 match), `isActive=false` при `remainingQty<0` — broken batch → deactivate (логічно).
- **sumLineTotals** (vat.ts:45): `unknown`-типізація приймає Prisma.Decimal і plain number; `Number()` коерсія коректна. Обидва callsites (invoices.clone:338, refreshFromWorkOrder:698) передають об'єкти з 3 полями.
- **Cross-cutting**: 0 `React.X`, 0 `console.log`, 0 `: any`, 0 BOM, всі findMany з `take`, всі $transaction з timeout, 0 hard-delete у зачеплених сервісах, 0 sentinel.

Baseline тримається: API 1095/1095, Web 488/488, TSC api ✅ 0 / web ✅ 0. Не з цієї сесії (pre-existing SUGGESTION, не блокатор): `fetchPartCoefficients` в work-orders.service:1559 без orgId — UUID PK, атака неможлива, залишено на майбутнє.

### Решта фінального циклу 3 — усе чисто

- **tester (247f33cb)** — 0 активних багів + **жива DB-верифікація конвергенції**: CHECK-constraints реально кидають 23514 на негативний INSERT/UPDATE (не тільки app-guard); rollback тримає атомарність на mixed ORM+raw; `Σ remainingQty==quantity` для 8 пар = 0 mismatch; `balance==Σ signed(tx)` для 222 акаунтів = 0 mismatch. SKILL +1 «Live-DB probe» + застереження: semantic-мапу (BALANCE_SIGN) читати з коду, не hardcode-ити у probe (дало 8 phantom mismatch).
- **optimize** — 0 findings, 0 комітів (сигнал конвергенції). Self-wrap не додає RTT на hot-path (all callers pass tx), CHECK — inline per-row 0 I/O, sumLineTotals single-pass збережено.
- **e2e** — 74/74 фінансові спеки green.
- **simplify** (4-angle convergence sweep) — 0 нових findings; sumLineTotals єдиний 3-field reduce-triple, null-контракт уніфікований.
- **code-review --fix** — 0 нових багів; 4 cross-cycle interaction-гіпотези очищені (CHECK vs transient-negative; self-wrap vs non-tx callers; nested $transaction; float-rounding clamp).
- **security-review** — 0 findings; ключове: 23514 CHECK-violation → generic HTTP 500 «Внутрішня помилка сервера» (raw PG-текст лише у logger, не у client → 0 leak table/column/constraint names); self-wrap DoS HTTP-недосяжний; cost-поля виключені з MECHANIC-проєкцій.

**Підсумок 3 циклів QA:** cycle 1 — 1 CRITICAL (AVG_COST sentinel) + altitude fix ''→null; cycle 2 — 1 HIGH (Bug #613 concurrency) + 3-рівневий backstop + no-tx self-wrap; cycle 3 — 0 findings (конвергенція, empirical live-DB evidence). API 1057→1095 (+38 regression-guards), Web 488. 19 комітів.

---

## 2026-09-02 (e) — Повний QA-цикл 2 (sync/review/tester/optimize/e2e/simplify/code-review/security)

### cbebc2f5 fix(tester): Bug #613 — concurrent WRITEOFF race guard (HIGH)

`createMovement` pre-check `available >= |qty|` читав STALE snapshot без row-lock → два concurrent WRITEOFF
того самого товару обидва проходили → `StockItem.quantity`/`StockBatch.remainingQty` могли стати від'ємними
(немає CHECK). Fix: (a) post-upsert re-check через `.select({quantity,reserved})` (RETURNING, 0 RTT) → throw
→ rollback; (b) `stockBatch.update({decrement})` → `updateMany({where:{remainingQty:{gte:take}}})` atomic
conditional decrement, count=0 → throw. +5 regression + mid-life switch invariants (#614).

### 33008171 perf(optimize): single-pass aggregation

getSchedule byDateSum inline + invoices totals single-pass. Concurrency-фікс concept-верифіковано:
`.select` на upsert = RETURNING (0 extra RTT), updateMany count у response — фікс НЕ ослаблений.

### 76a7d0fa refactor(simplify): DB-CHECK backstop + sumLineTotals (altitude+reuse)

Міграція 20260902210000: CHECK `stock_items(quantity>=0 AND reserved>=0)` + `stock_batches(remainingQty>=0)`
як джерело-правди на рівні БД (ловить будь-який забутий/майбутній writer, зокрема sync-merge). App-guard
лишається (локалізоване повідомлення + CAS-retry) — defense-in-depth на 3 рівнях. `sumLineTotals` винесено
у vat.ts (обидва invoice-сайти). Post-upsert check гейтимо за знаком дельти.

### 8636a7db fix(review): createMovement no-tx self-wrap у $transaction

Latent gap: multi-write createMovement (movement+consume+upsert+consumption) у no-tx гілці не обгортав
у транзакцію → throw лишив би orphan-записи. Fix: `if (!tx) return $transaction(inner => …)`. +2 regression.

### 3f3a0a32 fix(security): orgId у consumeBatch updateMany (defense-in-depth)

CLAUDE.md #6 — orgId у where updateMany (атака неможлива, id — UUID PK з orgId-scoped findMany).

**Пройдено чисто:** sync 0 · review 0 · e2e 59/59 · security 0 findings. API 1095/1095, Web 488/488, tsc 0/0.

---

## 2026-09-02 (d) — Повний QA-цикл 1 (sync/review/tester/optimize/e2e/simplify/code-review/security)

### 184b257a fix(review): AVG_COST sentinel batchId='' пробивав UUID FK (CRITICAL)

`BatchService.consumeBatch(AVG_COST)` повертав `[{batchId:'', …}]`; `createMovement` + `writeOffPartsAndCharge`
писали `''` у `@db.Uuid` → Postgres "invalid input syntax for type uuid" → WRITEOFF/WO COMPLETED падав
на всіх org з costMethod=AVG_COST. Fix: truthy-guard у 2 write-шляхах + 2 regression-specs.

### 1350cb3f perf(optimize): consume hot-path index + PO list nowMs memo

Covering index `stock_batches(orgId,goodId,warehouseId,isActive,createdAt)` усуває external sort на кожній
сторінці FIFO/LIFO consumeBatch (migration 20260902200000). `nowMs=useMemo` замість per-row `getTime()` у
purchase-orders списку.

### 58e522ef fix(e2e): supplier-payment stale sign-assertion

E2E `supplier-payments.spec.ts:181` стверджував стару семантику (PAYMENT, balanceBefore−200). Після переходу
на SUPPLIER_PAYMENT (BALANCE_SIGN=+1) баланс постачальника (відʼємний = «ми винні») підіймається до 0 →
assertion `balanceBefore+200`, тип транзакції `SUPPLIER_PAYMENT`.

### 02559610 refactor(simplify): sentinel batchId ''→null у джерелі + reuse BALANCE_SIGN

Altitude-фікс (4 simplify-агенти): `BatchConsumeResult.batchId` `string→string|null`; AVG_COST-агрегат повертає
`null`, який напряму лягає у nullable uuid → обидва call-site гейти згортаються у плоский тернар без truthy-обгортки
й дубльованого коментаря. `batch.invariants.spec` реюзає ЕКСПОРТОВАНУ `BALANCE_SIGN` (інверсія знаку у прод
тепер впаде тут). Прибрано неможливий `fc.pre` + JS-тавтологію.

**Пройдено чисто:** sync 0 розбіжностей · code-review 0 correctness-багів · security-review 0 (tenant isolation,
$queryRaw параметризований, consume-loop обмежений, e2e-JWT — прострочений local fixture). API 1083/1083, Web
488/488, tsc 0/0.

---

## 2026-09-02 (c)

### test(invariants): +24 property-based тести — FIFO/AVG/BALANCE/TRANSFER (Bug #612)

**Контекст:** bug hunt циклу 1 на feat/supplier-payments сфокусований на 5 фінансово-чутливих
інваріантах (партійне FIFO/FEFO/LIFO/AVG списання; supplier balance sign 8 типів; FIFO-графік оплат;
TRANSFER cost-carry; AVG_COST sentinel edge-cases). **0 нових активних багів** — усі 5 областей
уже покриті recent commits (#606-#611 + #597-#600).

**Додано** `apps/api/src/modules/inventory/batch.invariants.spec.ts` (24 property-based тести):

1. **BatchService — consume invariants** (10): Σ consumed==qty; масовий баланс; нема партій у мінус;
   remainingQty=0→isActive=false; FIFO/LIFO order; нестача → error БЕЗ мутації (all-or-nothing);
   AVG_COST sentinel форма; single-vs-span batchId fixation; cross-method Σ==qty.
2. **SupplierPayments.getSchedule — FIFO invariants** (5): Σ bucket==payable; надлишок→overdue; FIFO
   строгий порядок закриття PO; кредит-ліміт planned→dates-desc→overdue; ліміт≥payable→усе 0.
3. **BALANCE_SIGN — supplier cycle** (5): SUPPLIER_CHARGE→balance=-X; повний цикл→0;
   payable=max(0,-balance); частковий X-Y; SUPPLIER_REFUND має ТОЙ САМИЙ знак що SUPPLIER_PAYMENT.
4. **StockDocument TRANSFER — cost-carry** (4): weightedCostPrice→target.price; null→fallback;
   **0 (free sample) через `??` НЕ падає у fallback** (документує `||` як БАГ).

Всі 24 PASS з першого запуску. API tests 1059→1083, TS 0/0.

---

## 2026-09-02 (b)

### feat(inventory): підключення партійного FIFO-списання + COGS до розходів

**Баг (виявлено при перевірці собівартості/партійності):** `consumeBatch` (FIFO/FEFO/LIFO/AVG,
написаний і протестований) — **0 викликів** з реальних розходів («мертвий код»). Партії лише
створювались (RECEIPT), `remainingQty` монотонно ріс (розсинхрон із StockItem.quantity), COGS у
наряді = ціна ПРОДАЖУ (не собівартість), `WorkOrderPart.batchCostPrice` завжди NULL → звіт
рентабельності брав `Good.purchasePrice` (неточна маржа), налаштування «Метод списання партій»
(FIFO/FEFO/LIFO/Середній у НДІ→Організація) ігнорувалось.

**Рішення — ЦЕНТРАЛІЗАЦІЯ у `createMovement`** (CLAUDE.md: stock тільки через неї):

- `createMovement`: `void → CreateMovementResult{movementId, consumed[], weightedCostPrice}`;
  на розході (`quantityDelta<0`, не reservation) викликає `consumeBatch` за `costMethod` з
  `OrganisationSettings` (Redis-кеш, fallback FIFO), рахує зважену COGS, проставляє
  `StockMovement.batchId` при single-batch.
- AVG_COST: `weightedCostPrice=getAvgCost`, але фізичний декремент партій — FIFO (інваріант
  `Σ remainingQty == quantity`).
- `consumeBatch`: `take:100 → while-пагінація` (span >100 партій).
- work-orders `writeOff`: фіксує `batchCostPrice`+`batchId` у `WorkOrderPart`; прибрано `price=part.price`.
- stock-documents TRANSFER: послідовно writeoff→receipt, перенос собівартості джерела на цільову партію.
- reports profitability: код без змін — `batchCostPrice` тепер заповнюється → маржа точна.
- `inventory.module += SettingsModule` (без circular DI).
- **reconcile-міграція** `20260902130000` для ПРОД (FIFO-доспоживає надлишок remainingQty; no-op на чистій БД).

**QA:** review 0 findings (10 фінансових інваріантів перевірено); tester 0 runtime-багів
(14 live-сценаріїв: FIFO/LIFO/FEFO/AVG, TRANSFER cost-carry, наряд COGS, нестача, інваріант) +
Bugs #609-#611 (3 regression-coverage gaps → +10 тестів: COGS-writeback, TRANSFER cost-carry, orderBy method).

**Dev:** партійні тестові дані скинуто (роздуті від непрацюючого списання).
Live: RECEIPT 10×100+10×120→avgCost 110; WRITEOFF 15 FIFO span→партія1 0/10 inactive, партія2 5/10,
COGS 1600; StockItem.quantity=5 == Σremaining=5. API vitest 1057/1057, tsc 0/0.
Коміти 19f81ccb + 2027fa85.

---

## 2026-09-02

### fix(settlements): виправлення знаку балансу постачальника — графік оплат оживає

**Баг (виявлено при створенні тестових даних для календаря оплат):** `receive()` PO писав
`CHARGE(+1)` постачальнику → баланс ДОДАТНИЙ (наче він винен НАМ), хоча ми отримали товар і
винні ЙОМУ. Графік оплат (фільтр `balance<0`) і звіт «Взаєморозрахунки» не бачили проведених
PO — feature фактично мертва (усі 8 SUPPLIER-акаунтів мали `balance>0`).

**Корінь:** `CHARGE`/`PAYMENT` dual-use (клієнт+постачальник) з протилежною семантикою.
**Рішення (варіант C):** окремі постачальницькі типи — `SUPPLIER_CHARGE(−1)`,
`SUPPLIER_PAYMENT(+1)`, `SUPPLIER_REFUND(+1)`. Клієнтські `CHARGE(+1)`/`PAYMENT(−1)` незмінні.
Знак лишається чистою функцією від `type` (BALANCE_SIGN — exported single source).

- **Backend:** enum += 3; BALANCE_SIGN += 3 (exported); 3 writer'и (receive/supplier-payment/
  supplier-return); reconciliation act переюзує BALANCE_SIGN (усунуто 2-гу копію осі).
- **Frontend:** TX_LABELS/COLORS + `settlementBalanceTone()` (lib/utils) + BALANCE_UP_TYPES —
  консолідовано 5 копій осі знаку (SettlementsTabContent + картка контрагента).
- **Міграції (2 окремі):** ADD VALUE ×3; backfill re-type історичних txs по documentType +
  recompute `balance=Σ signed(tx)` + syncVersion++.
- **QA:** sync 0, review 1 (5-та копія осі у картці — виправлено), tester 3
  (#606 інверсія кольору→спільний хелпер; #607 звіт не фільтрував deleted CP; #608 exhaustive
  runtime-assert на BALANCE_SIGN знаки).

**Клієнти НЕ зачеплені** (documentType строго розділені; client-balances незмінні). **Звіт
коректніший** (8 постачальників з фальшивого totalDebit → totalCredit). **Live-інваріант:**
`balance==Σ signed(tx)` для 139/139 контрагентів. Графік ожив: 7 постачальників по колонках.
API vitest 1043/1043, web 488/488, tsc 0/0.
Коміти 23ce9109 + 484f6b92 + d2ae2e7e.

---

## 2026-09-01 (e)

### feat(counterparties): після створення картка лишається відкритою в edit-режимі

- **Запит користувача**: при створенні контрагента модалка після «Зберегти» закривалась —
  щоб додати авто/договори, треба було знову відкривати (вже редагування).
- Тепер після create картка **лишається відкритою** і перемикається в edit-режим
  (з'являються вкладки Авто/Договори/Історія), як при редагуванні.
- `onSaved(cp, isNew)` — новий 2-й параметр (create→true, update→false). Головний список
  (`counterparties/page`) при `isNew` НЕ закриває, а `setEditingCp({balance:0, ...cp})` →
  `counterparty` proc заповнюється → `isEdit=true` → вкладки. Модалка не ремаунтиться, форма
  ре-синхронізується з backend-response через наявний useEffect.
- CalendarSlotModal/PurchaseOrderCreateModal/RuleFormModal/GoodEditModal onSaved ігнорують
  `isNew` (усі edit-only, create через них неможливий) — TS-safe, не зламано.
- toast «Контрагента створено — тепер можна додати авто та договори».
- QA: review 0 findings. web tsc 0. Коміт 9d61dfaa.

---

## 2026-09-01 (d)

### feat(counterparties): назва контрагента обов'язкова (гнучко — компанія АБО ПІБ)

- **Запит користувача**: поле «Назва» при створенні контрагента зробити обов'язковим.
- Раніше усі name-поля `@IsOptional` → можна було зберегти контрагента без імені
  (у списку показувалось «(без імені)»).
- **Правило** (гнучко, cross-field): має бути `companyName` АБО `firstName`/`lastName`.
  Для SUPPLIER (видно лише «Назва компанії») — обов'язкова назва компанії (required-мітка).
- **Backend** (`counterparties.service`): `hasCounterpartyName()` guard у `create(dto)` +
  `update` (merged-стан: PATCH частковий → перевіряємо результат `dto.X ?? existing.X`, тож
  очищення останньої назви теж → 400). Guard стоїть ДО `documentNumberService.next()` (номер
  не витрачається на fail-path). `BadRequestException`.
- **Frontend** (`CounterpartyEditModal`): guard у create/update + disabled кнопки «Зберегти» +
  inline-помилка + required-мітка для SUPPLIER.
- **Review-fix (de2d692e)**: `CalendarSlotModal` (2-й entry-point створення контрагента у
  майстрі запису) мав власний guard без `.trim()` + інше повідомлення → синхронізовано всі
  3 точки (whitespace-only назва тепер відхиляється однаково).
- QA: review 1 fixed. Live: create без назви→400, з companyName/firstName→201, update-очистити→400.
  api+web tsc 0, vitest 48/48 counterparties + 488/488 web. Коміти ee23c53a + de2d692e.

---

## 2026-09-01 (c)

### feat(counterparties): галка «Показувати видалені» + відновлення договорів і авто

- **Запит користувача**: бачити soft-deleted договори/авто у формі контрагента (як галка
  у списках) + можливість відновлювати.
- **Backend**: `findContracts` + vehicles `findAll` += `showDeleted` param (умовний
  `deletedAt:null`); `VehicleResponseDto` += `deletedAt`. Нові restore-endpoints:
  `POST /counterparties/:id/contracts/:cid/restore` + `POST /vehicles/:id/restore`
  (atomic `updateMany` з `NOT:{deletedAt:null}`, еталон brands). Ролі OWNER/ADMIN
  (= delete). `restoreContract` ставить `isPrimary=false` (уникнення дубля-головного).
- **Frontend** (CounterpartyEditModal): галки на вкладках Договори/Авто; видалені рядки
  приглушені + бейдж «Видалено»; кнопка «Відновити» (RotateCcw). Окремі toggle-useEffect
  (both directions, skip-first-run ref). ModalContract/Vehicle += deletedAt.
- **Review (03a93799)**: dedupe toggle-fetch при CP-switch (ref reset) + role parity
  (restore contract OWNER/ADMIN, не RECEPTIONIST).
- **Bugs #601-#605 (8c047275, sto-tester)**:
  - #601/#602 HIGH: `vehicles.restore` не перевіряв ланцюг parent'ів — відновлення авто
    у видалений гараж/контрагент → orphan «зомбі» (невидиме у findAll). Fix: nested-select
    guard garage.deletedAt + counterparty.deletedAt → BadRequest з підказкою.
  - #603 HIGH: `restoreContract` без CP-existence guard (асиметрія із sibling-методами). Fix.
  - #604/#605 MEDIUM: мок без restoreContract + 0 регрес-тестів. Fix: новий
    `vehicles.service.spec.ts` (13) + 7 на договори + contract-spec.
- QA: sync 0, review 2 fixed, tester 5 fixed. API vitest 1035/1035 (+20), tsc 0/0.
  Live: DELETE→showDeleted=true бачить (deletedAt)→restore(201, deletedAt=null,
  contract isPrimary=false); orphan garage/cp → 400; happy → 201.
  Коміти c30c22bd + 03a93799 + 8c047275.

---

## 2026-09-01

### feat(counterparties): редагування + soft-delete договору у формі контрагента

- **Запит користувача** (скріншот): рядок договору (вкладка «Договори») мав лише 4
  колонки (Номер/Тип/Початок/Завершення) без жодних дій.
- Додано кнопки у рядок (opacity-on-hover): **олівець** (редагувати) + **кошик**
  (soft-delete з `useConfirm`). Backend уже мав `PATCH`/`DELETE
/counterparties/:id/contracts/:contractId` — чиста frontend-робота.
- `editingContractId` керує режимом create/edit; `startEditContract(c)` prefill'ить
  форму; `saveContract()` об'єднує POST/PATCH; кнопка «Оновити»/«Зберегти».
- `deleteContract(c)` — optimistic filter + промоут наступного головного ТОГО Ж
  `contractType` (дзеркалить бековий `$transaction` promote); isPrimary optimistic
  scoped по `contractType` (дзеркалить бековий `swapType`-scope, коректно для BOTH).
- Усі handler'и з tenant-guard (`cpIdAtStart` + `currentCpIdRef`, Bug #370-патерн).
- Review 1 SUGGESTION (уточнено коментар promote-primary) fixed. Live:
  CREATE→PATCH(defer 7→14 + endDate)→DELETE(204, gone) ✓. web tsc 0.
  Коміти 407dac38 + 331faa26.

### feat(counterparties): редагування авто у формі контрагента

- **Запит користувача** (скріншот): рядок авто (вкладка «Авто») мав лише кнопку
  видалення — додано **олівець** (редагувати), дзеркалить рядок договорів.
- `editingVehicleId` керує режимом create/edit; `startEditVehicle(v)` prefill'ить
  форму; `saveVehicle()` об'єднує POST/PATCH — PATCH БЕЗ `customerGarageId` (гараж уже
  існує, лише POST auto-створює). `Vehicle` тип += `vin` (потрібен для prefill).
- `deleteVehicle`: якщо редагували видалене авто → `resetVehicleForm`. tenant-guard.
- Backend уже мав `PATCH /vehicles/:id` — чиста frontend-робота. Review 0 findings.
  Live: CREATE→PATCH(model/year/plate/vin)→DELETE(204) ✓. web tsc 0. Коміт 84488164.

---

## 2026-08-31 (b)

### fix(counterparties): вид договору — завжди редагований select, фільтр за типом

- **Баг** (скріншот користувача): для SUPPLIER/CLIENT поле «Вид договору» у формі
  додавання договору було СТАТИЧНИМ нередагованим блоком (`<Select>` рендерився лише
  для `type===BOTH`); submit примусово перевизначав `contractType` за типом контрагента,
  ігноруючи вибір.
- **Вимога**: не блокувати поле — завжди `<Select>`, лише фільтрувати пункти за типом +
  дефолт. SUPPLIER → лише «Купівля» (дефолт); CLIENT → лише «Продаж» (дефолт); BOTH →
  обидва + порожній placeholder (явний вибір).
- Хелпери `contractTypesForCounterparty(cpType)` + `defaultContractType(cpType)`; рендер
  завжди `<Select>` з фільтрованими опціями (`CONTRACT_TYPE_LABELS`); `onClick` «Додати
  договір» виставляє дефолт; submit `resolvedType = вибір || дефолт`.
- Файл `CounterpartyEditModal.tsx`. Review 0 findings. web tsc 0.

---

## 2026-08-31

### feat(supplier-payments): FIFO-графік оплат по документах + колонки оплати у списку купівлі

**Baseline-баг (2aea04e4):** графік показував 30953₴ по постачальнику, звіт «Взаєморозрахунки» — 47₴.
Причина: графік реконструював борг із `Σ PurchaseOrder.totalAmount − PO-linked платежі`, ігноруючи
фактичний `SettlementAccount.balance` (враховує повернення, unlinked-платежі, коригування). Фікс:
авторитетне джерело суми = `SettlementAccount.balance` (payable = `−balance` для `balance<0`).

**FIFO-розподіл (282d5fba):** пропорційне масштабування балансу → FIFO-налив. payable «наливається»
на непогашені RECEIVED/PARTIAL PO по черзі від найстарішого (`orderBy paymentDate asc nulls first`);
`take = min(po.outstanding, remaining)`; кожен PO → своя колонка (overdue/byDate/planned) з реальним
залишком; PO, до яких борг не дійшов = оплачені (не показуються); надлишок понад ΣPO → overdue.
Прибрало мікро-частки масштабування — осмислені суми документів. Підсумок = balance.

**Список купівлі (282d5fba+05ebbeb1):** +колонка «Дата оплати» (сортовна) + «Днів до оплати»
(`ExpiryBadge` «N дн.»/«Прострочено N дн.», лише де `outstanding>0`). Backend: `findAll` += groupBy
CONFIRMED-платежів → `outstanding` у PO list DTO; `PO_SORT_FIELDS` + `PurchaseOrderQueryDto.sortBy`
whitelist += `paymentDate`.

**Bugs #598-#600 (441c04aa, sto-tester):**

- #598 MEDIUM: `sortBy=paymentDate&desc` виносив null-date PO наверх (Postgres NULLS FIRST для DESC).
  `buildSortOrderBy` += `nullableFields?: Set` → для nullable-field `{ sort, nulls:'last' }`.
- #599 MEDIUM: `getSchedule` включав CLIENT-типу counterparty з `balance<0` як «постачальника»
  (semantic contamination) → filter `counterparty.type in [SUPPLIER,BOTH]`.
- #600 LOW: docstring «завжди узгоджений зі звітом» неправда (divergence на deleted/CLIENT
  counterparty, звіт не фільтрує) → переписаний як задокументований trade-off.

QA: sync 0 розбіжностей, review 0 findings, tester 3 fixed. +16 регрес-тестів (12 pagination
nullable + 4 PO outstanding). API vitest 1015/1015, web 488/488, tsc 0/0. Live: FDGD −1600 → графік
1600 (= звіт); DESC-sort дати зверху; CLIENT відфільтрований.

---

## 2026-08-29

### feat(supplier-payments): графік оплат постачальникам + PurchaseOrder.paymentDate

- Нова колонка `PurchaseOrder.paymentDate` (`@db.Date`, nullable) + міграція
  `20260820120000_add_po_payment_date`. Редаговане поле «Дата оплати» у PO-модалці.
- Авто-заповнення `paymentDate` у `receive()` при повному отриманні (RECEIVED):
  `сьогодні + CounterpartyContract.paymentDeferDays`. Ручне значення не перезаписується.
- `GET /supplier-payments/schedule?from=&to=` — шахматка боргів по датах. Джерело:
  RECEIVED/PARTIAL PO з `outstanding = totalAmount − Σ CONFIRMED SupplierPayment`.
  Bucket за `paymentDate`: null/минуле → overdue, у 20-денному вікні → byDate[дата],
  далі → planned. Кредит-ліміт договору віднімається з найпізніших (planned→дати→overdue).
- Вкладка «Список / Графік оплат» на `/supplier-payments` (URL `?tab=schedule`) +
  компонент `SupplierPaymentScheduleTab` (Протерміновані червоні / дати DD.MM жовті /
  Планові зелені / рядок «Разом»).
- Тести: +5 `getSchedule` (bucket/outstanding/кредит-ліміт), +2 PO `receive()` auto-fill,
  +1 E2E вкладки. Файли: `schema.prisma`, `purchase-orders.{dto,service}.ts`,
  `supplier-payments.{controller,dto,service}.ts`, `PurchaseOrderCreateModal.tsx`,
  `useSupplierPayments.ts`, `supplier-payments/page.tsx` + `SupplierPaymentScheduleTab.tsx`,
  `lib/format.ts` (addDaysISO), `common/utils/kyiv-date.ts` (addDaysKyiv).

---

## 2026-07-03

### d27e1f14 fix(tester): Bug #590 — useConfirmSupplierPayment invalidates counterparties

- `useConfirmSupplierPayment.onSuccess` тепер додатково інвалідує `counterpartiesKeys.all` (Bug #590 HIGH)
- `confirm()` пише settlement PAYMENT через SettlementsService → баланс постачальника у settlementAccount.balance змінюється; без invalidate CRM/counterparties list показував стару balance до staleTime=30s
- `useCancelSupplierPayment` навмисно НЕ інвалідує counterparties (cancel з DRAFT не пише settlement) — inline-коментар документує асиметрію
- Bug #591 MEDIUM: додано `apps/web/src/hooks/api/useSupplierPayments.test.tsx` (10 тестів, аналог useInvoices.test.tsx): queryKey factory shape × 4, list URL params + enabled-gate × 2, create/confirm/cancel/delete invalidate × 4; ключовий regression-guard для Bug #590 (assert counterpartiesKeys.all у invalidateQueries) + пара для cancel (assert NOT invalidates counterparties)
- Verification: tsc clean; web vitest 481/481 (+10 vs baseline 471); api vitest 976/976 (no regression)

### 48ad57a6 feat(supplier-payments): document + endpoint for paying suppliers

- Нова модель `SupplierPayment` (гілка `feat/supplier-payments`) — закриває борг перед постачальником, який раніше накопичувався (`PurchaseOrder.receive` → CHARGE), але не мав чим оплачуватись (клієнтський `Payment` заточений під Checkbox + лояльність)
- Enum-и `SupplierPaymentStatus` (DRAFT/CONFIRMED/CANCELLED) + `PaymentSourceType` (BANK_ACCOUNT/CASH_REGISTER); `SUPPLIER_PAYMENT` у `DocumentType` (prefix `ОПП`)
- FSM DRAFT→CONFIRMED: при проведенні пише `SettlementTransaction(PAYMENT)` через `SettlementsService.createTransaction()` (re-read статусу в `$transaction` — race-safe); джерело коштів обов'язкове (bank АБО cash), опційна прив'язка до PurchaseOrder; БЕЗ Checkbox/loyalty
- API `/supplier-payments` (GET/POST/PATCH/DELETE + confirm/cancel), ролі OWNER/ADMIN/ACCOUNTANT; web: список + `SupplierPaymentCreateModal` + nav «Оплати постачальникам»
- Міграції `20260703100000_add_supplier_payment` + `20260703100001_seed_supplier_payment_doc_numbers` (backfill enum-value в окремій міграції — Postgres не дозволяє ADD VALUE + use у тій же tx)
- Дос'є `docs/objects/supplier-payment.md` (BR-SUPPAY-001..008)

### d699d0ae fix(sync) + 951506b7 fix(review) + 92390dbc fix(tester): SupplierPayment QA

- sync: `/bank-accounts` + `/cash-registers` повертають `{ items, total }`, не голий масив — виправлено typing + destructuring; прибрано неіснуючі `deletedAt` поля з local interfaces
- review: §8.2 paired FK — `onClear` постачальника скидає й прив'язку PO (orphan reference)
- tester: **Bug #588 (HIGH)** — `update()` лишав orphan `purchaseOrderId` після зміни `supplierId` для API-only clients (UI робив auto-clear) → cross-supplier linkage; fix авто-очищає PO; +6 regression тестів (16/16 spec, API 976/976)

---

## 2026-06-20

### <next> perf(optimize): Цикл 3/3 step 4 — covering index booking_requests(orgId,branchId,status,requestedDate)

- Аудит-результат: `BookingService.getAvailability()` (публічний widget hot-path без auth) фільтрує по orgId + branchId + status='CONFIRMED' + requestedDate range + deletedAt
- Існуючі індекси `(orgId,status,deletedAt)` + `(orgId,deletedAt,createdAt)` покривали лише префікс — branchId equality + requestedDate range фолбекали на per-row heap filter
- Migration `20260620100000_add_booking_request_availability_index` додає `(orgId, branchId, status, requestedDate)` — equality columns першими, range column останнім → single index-range scan без heap re-filter
- Сигнал з накопичених підходів (Trgm index drift, Reverse-FK index miss) застосовано: новий public endpoint з multi-field WHERE без супутнього compound index — patern drift детектовано і виправлено
- Інші перевірки чисті: loyalty `getTransactions()` має take:50+count parallel; maintenance-schedules — `(orgId,vehicleId,deletedAt)` і `(orgId,nextMaintenanceDate)` покривають findAll/findUpcoming; booking `getAvailability()` усі 5 queries паралельні через Promise.all + module-level Intl singletons; counterparties PageClient — tab-guard на effects, малі списки без потреби memo
- TS green (api 0 errors, web 0 errors)

### 0b60970c fix(review): align SupplierReturn modal FSM with backend SR_TRANSITIONS

- Post-redesign (0bcc7365 PO-style copy) drift: frontend STATUS_TRANSITIONS не відповідав backend SR_TRANSITIONS у supplier-returns.service.ts — `DRAFT:[CONFIRMED]` губив CANCELLED; `CONFIRMED:[CANCELLED]` додавав неіснуючий перехід (бек: `CONFIRMED:[]`)
- `statusPrevStep` був хардкодом `status==='CONFIRMED' ? 'DRAFT' : null` — у SR немає back-transition
- Фікс: `STATUS_TRANSITIONS = { DRAFT:[CONFIRMED,CANCELLED], CONFIRMED:[], CANCELLED:[] }`, `statusPrevStep: null`, next-step віддає перевагу не-CANCELLED forward (CONFIRMED) із fallback
- TS green (web 0 errors)

---

## 2026-06-19

### a257dc8c fix(tester): bugs #541-#543 — regression-guards for include drift + dead-code cleanup

- #541 LOW backend regression-coverage: PO_LINE_GOOD_INCLUDE / PART_GOOD_INCLUDE drift would not fail any test → extended mock fixtures у `work-orders.role-gate.spec.ts` (findOne+addPart) і `purchase-orders.service.spec.ts` (transition→findOne) з повним shape (internalCode/sku/brand) + асерції що поля потрапляють у DTO
- #542 LOW frontend regression-coverage: новий `WorkOrderPartsSection.test.tsx` (4 кейси) guards sub-line render — all 3, lone brand, all null no-render, empty parts empty-state
- #543 MEDIUM frontend dead-code: видалено onShowBatches prop + Layers import + button з WorkOrderPartsSection (PageClient ніколи не передавав callback з extraction commit e880a2f3 2026-06-05, silent UX no-op ~14 days)
- Тести: API 928/928 → 931/931 (+3); Web 434/434 → 438/438 (+4); TS green

### 9ea58b9e feat(goods): add internalCode (sequential internal good code)

- GOOD_INTERNAL_CODE в DocumentType enum + seed config (prefix T, NEVER reset)
- internalCode поле на Good + міграція 20260619140000
- GoodsService генерує internalCode при create через DocumentNumberService
- GoodsService: brand включений у всі відповіді (brandName в GoodResponseDto)
- PurchaseOrderLineResponseDto: goodInternalCode, goodBrandName
- WorkOrderPartResponseDto: goodInternalCode, goodSku, goodBrandName
- UI: GoodPickerModal, GoodsTab, GoodEditModal, PurchaseOrderCreateModal, CreateWorkOrderModal — показ код · артикул · бренд

### d1a12539 fix(review): PO/WO include drift + GoodPickerModal brandName mapping

### 34259b7a fix(tester): bugs #533-#540 — internalCode session + backfill migration 20260619140001

---

## 2026-06-17

### fe9c741c fix(review): VAT report filters + broken endpoint + VatMode typing

- CRITICAL (UI dead code): `PurchaseOrderCreateModal` викликав `/organisations/my` —
  endpoint НЕ існує (backend має `/settings/organisation`). Silent `.catch(() => {})`
  ховав факт що `vatMode`/`vatRate` ніколи не сетяться → ПДВ-колонка/рядок ніколи не
  показувались. Замінено на `/settings/organisation` + `/settings/tax-rates` (resolve
  rate by `defaultVatRateId` або `isDefault`); error → `console.error`. Симетрія з
  `CreateWorkOrderModal.tsx:597`
- CRITICAL (звітність): `ReportsService.vatReport()` агрегував ВСІ Invoice (включно з
  DRAFT/CANCELLED) і ВСІ PurchaseOrder крім CANCELLED (включно з DRAFT/ORDERED). За
  податковим обліком (1) sales VAT — лише виставлені рахунки (SENT/PAID/OVERDUE);
  DRAFT не є податковою подією, CANCELLED анульовано; (2) purchase VAT credit виникає
  лише після фактичної поставки (PARTIAL/RECEIVED), бо DRAFT/ORDERED не отримано.
  Додано `status: { in: [...] }` фільтри
- IMPORTANT (TS contract): `SettingsService.getDefaultVatRate()` повертав
  `{ vatMode: string; vatRate: number }` (bare string) → консумери писали
  `as 'NONE' | 'EXCLUSIVE' | 'INCLUSIVE'` каст. Тепер `vatMode: VatMode` (Prisma enum),
  drops 2 cast sites у purchase-orders.service.ts
- IMPORTANT (DRY): `vat.ts` мав local `type VatMode = 'NONE' | 'EXCLUSIVE' | 'INCLUSIVE'`
  замість Prisma `VatMode`. Імпорт з `@prisma/client` робить DRY single-source
- IMPORTANT (TS): `reports.service.ts` мав ugly `(invoicedAgg._sum as { totalVat?: unknown }).totalVat`
  cast. Prisma `_sum.totalVat: Decimal | null` доступний directly без касту

### test(tester): Bugs #530-#532 — Cycle 2 final regression-guards (14 нових тестів)

- Bug #530 (HIGH): public DTO leak guard для findByShareToken — costPrice/batchCostPrice/orgId/sensitive поля ВІДСУТНІ
- Bug #531 (MEDIUM): recalcTotals defensive `take: 1000` cap — regression-guard від видалення/зниження
- Bug #532 (LOW): Cycle 2 simplify audit — clean, без cleanup-debt
- 9 тестів у work-orders.share-public.spec.ts: hasOwnProperty whitelist, Promise.all parallel, skip empty uomIds
- 5 тестів у work-orders.recalc-cap.spec.ts: exact take:1000, narrow select, boundary 1000 рядків
- SKILL.md: 2 нові накопичені підходи — public DTO leak whitelist + defensive cap regression-guard
- API tests: 908 → 922 (+14, 100% green)

### 6d35157a fix(review): role-gate part.costPrice + UI cleanups

- §2.1 CRITICAL: GET /work-orders/:id повертав WorkOrderPartResponseDto.costPrice (batchCostPrice)
  для MECHANIC/RECEPTIONIST — порушував field-visibility інваріант goods/price-history
- service: COST_PRICE_VISIBLE_ROLES (OWNER/ADMIN/STOREKEEPER/ACCOUNTANT) + canSeeCostPrice() guard
- toPartDto(part, userRole?) — emit costPrice лише для дозволених ролей; fail-closed default
- controller: findOne(@CurrentUser() user: {role}) → передається у service
- WO list page: simplify hasActual = abs(totalActualLabor - totalLabor) ≥ 0.01 (totalParts cancels)
- CreateWorkOrderModal: align new-input cost cell з view/edit (text-left tabular-nums)
- skills: новий шаблон sto-review для nested-DTO role-gated полів + UI mode alignment

### 99f0e406 fix(tester): Bugs #506-#510 — totalActualLabor regression-guard + UI sync

- Bug #506/#510 (MEDIUM): PageClient.tsx не відображав різницю план/факт + дублював interface без totalActualLabor
- Bug #507 (HIGH): відсутні regression-тести для нової формули → додано work-orders.recalc-totals.spec.ts (6 тестів)
- Bug #508 (MEDIUM): публічний estimate показував totalActualLabor+totalParts замість totalLabor+totalParts (кошторис = план)

### ca5aef48 fix(review): line totals + invoice refresh + completion act on actualHours

- WO PDF рядків: `total = actualHours ?? normoHours × price` (не l.amount = normoHours × price)
- invoices.refreshFromWorkOrder: SUM з `actualHours ?? normoHours` симетрично з createFromWorkOrder
- completion-acts.buildLines: акт виконаних робіт тепер показує actualHours і фактичну суму
- EstimatePublicDto — без змін (SHAREABLE статуси де actualHours=null → totalAmount незмінний)

### 0665024c feat(work-orders): invoice/totalAmount on actual labor (actualHours ?? normoHours × price)

- WorkOrder.totalActualLabor (новий Decimal 12,2) = SUM((actualHours ?? normoHours) × price)
- totalAmount = totalActualLabor + totalParts (не totalLabor + totalParts)
- Migration: 20260617140000_add_total_actual_labor
- Invoice.createFromWorkOrder автоматично отримує правильну суму через wo.totalAmount

### 527011c9 fix(tester): Bugs #521-#525 — actualHours feature critical bugs

- Bug #521 (CRITICAL): UpdateWorkOrderLineDto відхиляв null actualHours → 400 при save() з порожнім Год (факт.)
- Bug #522 (CRITICAL): canEdit ∩ canEditActual = ∅ — Год (факт.) ніколи не можна було зберегти через FSM-конфлікт
- Bug #523 (HIGH): default drift recalcPlannedHoursFromLines між DocumentsTab (true) і WO Modal (false)
- Bug #524 (MEDIUM): actualTotals.hasAny=true при порожніх actualHours (fallback на normoHours) — tfoot дублював рядок
- Bug #525 (HIGH): computedActualHours=null при lines.length=0 коли recalcEnabled → data loss (overwrote existing value)

### ac2ced81 fix(review): recalcActualHoursFromLines contract mock + actualTotals toNumberOrUndefined

- settings.contract.spec.ts: додано recalcActualHoursFromLines у freshOrgRow() мок
- actualTotals useMemo: parseFloat → toNumberOrUndefined (узгодженість з save())

### 5d526ba9 feat(work-orders): recalcActualHoursFromLines setting + actual sum fallback to normoHours

- Нове поле recalcActualHoursFromLines в OrganisationSettings (Prisma + міграція + DTO + service)
- DocumentsTab: toggle "Перераховувати фактичні нормогодини по роботах"
- CreateWorkOrderModal: колонка "Год (факт.)", "Сума (факт.) = (ah ?? nh) × price", PATCH existing lines, computedActualHours

### 62785537 feat(work-orders): actual hours column in lines table

- Колонка "Год (факт.)" — editable в IN_PROGRESS/ON_HOLD, read-only інакше
- ARROW_SKIP_STATUSES: ON_HOLD/ARCHIVED/CANCELLED виключені зі стрілкової навігації

## 2026-06-16

### 7ec6dead docs(skills): add 3 new patterns to sto-tester (Bugs #515, #517, #518)

- Time-of-day DTO без @Matches regex + cross-field guard (Bug #515)
- jsdom URL.createObjectURL stub missing → vitest exit 1 shadow error (Bug #518)
- Dead exports у \*.utils.ts після refactor на dynamic config (Bug #517)

### 27854f05 perf(calendar): merge mount effects + statsTab useMemo

- useCalendarState: 2 окремих mount useEffect → 1 Promise.all (1 мережева хвиля)
- CalendarStatsTab: days, periodLabel, liftStats, totalMinAll — усе у useMemo

### e3a044df docs(skills): add settings/config endpoint cache pattern to sto-optimize

- Новий патерн у sto-optimize SKILL.md: read-endpoint без Redis при high-mount-frequency

### 3d8f4ad5 perf(calendar): Redis cache work-hours + statsTab single-pass aggregation (Bug #520)

- getWorkHours(): Redis TTL 60s (key=settings:work-hours:{orgId}) + conditional invalidation у updateBranchSettings
- CalendarStatsTab: liftStats bucket-by-liftId Map, O(N×M) → O(N+M), 30k Date allocs/render → 0

### add05f53 fix(tester): DTO regex, dead exports, jsdom stubs, spec coverage (Bugs #515-#518)

- settings.dto.ts: @Matches(HH_MM_RE) на workStartTime/workEndTime + cross-field guard
- calendar.utils.ts: видалено dead exports HOURS/TOTAL_HOURS/WINDOW_START/WINDOW_END/pxToHours
- setup.ts: typeof-guard stubs для URL.createObjectURL/revokeObjectURL
- settings.contract.spec.ts: +13 тестів для GET /settings/work-hours + PATCH validation

### b7bbd0d3 perf(optimize): EMPTY_BOOKINGS module-level + skill improvement

- CalendarDayGrid: `useMemo<BookingSlot[]>(() => [], [])` → module-level `EMPTY_BOOKINGS` (0 hook slot, 0 alloc per mount)
- optimize SKILL.md: додано 2 патерни — bucket-by-FK для date-overlap loops, module-level empty collection

### c4f6ab06 perf(optimize): GoodPickerModal stable refs + lift qty IIFE

- `setStockMap(new Map())` → module-level `EMPTY_STOCK_MAP` stable reference
- qty IIFE у `.map()` row → `const qty = stockMap.get(item.id) ?? 0` (1 alloc/row замість 1/render)

### 50cd6434 perf(optimize): bucket busy slots by liftId in getAvailability + useCalendarState

- `getAvailability()`: O(T×L×B) → O(T×L×avg(B/L)) + pre-parsed `startMs/endMs` (0 Date allocs у hot-path)
- `useCalendarState.load()` booking→lift assignment: Map pre-bucketed, 0 Date allocs для PENDING bookings

### 6987c7fa fix(tester): Bug #511-#514 — booking DST-safe bookedTimes + calendar race + clamp + workhours guard

- Bug #511 [CRITICAL]: bookedTimes використовував getUTCHours() → KYIV_HM_FMT.format() (DST-safe)
- Bug #512 [HIGH]: lifts.length додано до load() useEffect deps (race condition fix)
- Bug #513 [MEDIUM]: BookingSlotBlock left/width clamped (Math.max/min)
- Bug #514 [MEDIUM]: create() валідує requestedDate проти workDays + [workStart,workEnd)

### feat(session): booking widget + calendar bookings display + WO status on slots

- /booking: дедуплікація слотів (Map<timeKey>), телефон normalize перед POST, BranchSettings інтеграція
- /bookings admin: fmtDateTime для requestedDate (час + дата)
- CalendarSlotModal: підйомник обов'язковий (required validation + \*)
- GoodPickerModal: GET /goods/stock-totals → "N на складі" / "немає на складі" per item
- CalendarDayGrid: BookingSlotBlock (PENDING bookings, green dashed, read-only)
- CalendarSlot: workOrderStatus через всі шари (DB select → DTO → frontend → рендер)

### f337e4e9 revert(api): nest tsc builder + @sto/shared CJS build fix

- Reverted `nest start --builder swc` → `nest start --watch` (tsc builder): SWC on Windows emits `tsconfig paths` aliases as literal strings in dist JS, breaking monorepo resolution
- `packages/shared/tsconfig.cjs.json` (new): builds `@sto/shared` as CommonJS to `dist/cjs/`
- `packages/shared/package.json`: `main` → `./dist/cjs/index.js` (was raw `.ts`)
- `apps/api/tsconfig.json`: `rootDir: "src"` (was `"../.."`), removed `paths`, `baseUrl: "."` kept
- `apps/api/nest-cli.json`: removed `builder: "swc"`, reverted to default tsc

---

### aa3b03c5 fix(review): invoice section — deferred revokeObjectURL + shared labels + narrow types

- WO card `downloadInvoicePdf`: `setTimeout(() => URL.revokeObjectURL(url), 100)` + `appendChild(a)` / `removeChild(a)` — mirrors `downloadPdf` / `downloadActPdf` pattern (Bug #77 hardening).
- Filename now uses invoice number (`invoice-${number}.pdf`) instead of UUID.
- Status badge: replaced 5-branch hardcoded ternary with `INVOICE_STATUS_LABELS[invoiceRef.status]` (`@sto/shared`). Eliminates divergent local "Відправлено" vs shared "Надіслано" for SENT.
- 5 inline duplicates of `{ id, number, status, amount, documentDate }` → single `InvoiceRef` interface + `InvoicePayload` helper type.
- `findByWorkOrder()` return type: `status: string` → `status: InvoiceStatus` literal union.

---

## 2026-06-15

### cc2cd2e1 fix(tester): Bugs #487-#490 — post-cycle3 spec gaps + BALANCE_SIGN exhaustiveness

- array.spec.ts: 9 кейсів для `deduplicateBy<T>`
- BALANCE_SIGN: `Partial<Record>` → плоский `Record` (TS-exhaustive)
- regression-guards для deduplicateBy у PO/xlsx/pricing
- стаб `$transaction` mock у pricing.service.spec.ts виправлено

### 93473ad7 refactor(simplify): Cycle 3 — deduplicateBy<T> shared utility + BALANCE_SIGN lookup table

- `apps/api/src/common/utils/array.ts` NEW: `deduplicateBy<T>(arr, key)`
- purchase-orders.service.ts + xlsx.service.ts: call-sites → `deduplicateBy(plan, u => u.goodId)`
- settlements.service.ts: 5-branch if/else → `BALANCE_SIGN: Record<SettlementTransactionType, 1|-1>` lookup

### 4648446b docs(memory): update MemoryManual after Cycle 3 simplify

### c24014ed refactor(simplify): Cycle 3 — readonly FSM arrays, toIdMap/calcVatTotals helpers, dep fix

- work-orders.fsm.ts: все → `readonly WorkOrderStatus[] + Object.freeze`
- apps/web/src/lib/utils.ts: `toIdMap<T extends {id}>` + `calcVatTotals` helpers
- CreateWorkOrderModal: 6 useMemo Map blocks → toIdMap(), 2 reduce blocks → calcVatTotals()
- useMemo deps: `[currentStatus, isEditMode]` (allowedTransitions derived, redundant dep removed)

### 4400dfb7 docs(skills): branching ternary inside Promise.all + tenant-guard patterns to sto-optimize

### f23abfd3 perf(optimize): tier-merger contract Promise.all + settlements parallel write + ReconciliationAct covering index

- purchase-orders.service.ts create(): contract resolution merged into Promise.all 3rd slot
- settlements.service.ts createTransaction(): `Promise.all([create, update])` inside $transaction
- ReconciliationAct: `@@index([orgId, counterpartyId])` → covering `@@index([orgId, counterpartyId, createdAt])`

### 852d5fa4 fix(review): defense-in-depth orgId tenant guard on tx.X.update writes (pricing+SD)

- pricing.service.ts: `tx.good.update({ id })` → `tx.good.updateMany({ id, orgId, deletedAt: null })`
- stock-documents.service.ts: `tx.stockDocumentLine.update({ id: line.id })` → `{ id: line.id, orgId }`

### e33a5b58 docs(skills): chunked bulk-update + dedup pattern to sto-optimize

### 8fff4289 perf(optimize): parallelize chunked good.update loops with dedup safety

- pricing.service.ts applyRuleToGoods: for-loop → `Promise.all(chunk.map(...))`
- purchase-orders.service.ts applyPricing: dedup + `Promise.all`
- xlsx.service.ts applyPricingFromList: dedup + `Promise.all`

### a26cd68a fix(review): purchase-orders dedup lineId guard + drop redundant StockDocumentType casts

- receive(): pre-$transaction `Set` dedup guard → `BadRequestException` (Bug #483)
- stock-documents.service.ts: зайві `as StockDocumentType` касти видалено

### 705e25e7 refactor(simplify): cleanup after /simplify review

- TYPE_FILTERS/STATUS_FILTERS → module-level `Object.freeze(['', ...Object.keys(LABELS)])`
- @IsEnum(StockDocumentType) → Prisma enum import (not hardcoded array)
- stock-documents/page.tsx: aliases TYPE_LABELS/STATUS_LABELS видалено

### 147cd3fe test(e2e): add coverage for RECEIPT tab and purchase-orders edit-mode

### 46b5df7f perf(optimize): parallel FK guards + per-line writes in PO/SD services

- purchase-orders.service.ts update(): 3 sequential findFirst → `Promise.all`
- stock-documents.service.ts transition(): createMovement + updateLine → `Promise.all` per line
- purchase-orders.service.ts receive(): createMovement + updateLine → `Promise.all` per line

### 96579181 test(purchase-orders): Bug #481-#482 — FSM transition regression guards (+23 tests)

### 821de2d2 fix(sync): align StockDoc interface with StockDocumentResponseDto

### f59c6a47 test(stock-documents): Bug #478-#480 — regression guards for RECEIPT type (+22 tests)

### a067ec21 fix(review): CRITICAL — expose RECEIPT in stock-documents type tabs

### d059b9a9 feat(stock-documents): add RECEIPT type (Оприбуткування)

- STOCK_DOC_TYPE_LABELS/BADGE: `RECEIPT: 'Оприбуткування'` / `'success'`
- stock-documents.dto.ts: @IsEnum(StockDocumentType) + `type!: StockDocumentType`
- stock-documents.service.ts: `MOVEMENT_TYPES.RECEIPT`, `docTypeMap.RECEIPT = 'STOCK_RECEIPT'`

### 65552dcb test(purchase-orders): Bug #473-#477 — regression guards for update() contract resolution

### 32c6115f fix(review): purchase-orders contract clear + stale-contract guard on supplier change

- CRITICAL: auto-clear stale contract when supplierId changes
- IMPORTANT: SearchPickerModal onSelect clear contractId/contractNumber
- IMPORTANT: handleSave `contractId: contractId ?? null`

### 115fea9e feat(purchase-orders): editable supplier/warehouse/contract in DRAFT, FSM arrows, receivedQty column

---

## 2026-06-14

### 355fb445 fix(e2e): align spec locators with redesigned modals + fix Modal id collision (Bugs #467-#472)

- Modal.tsx: useId() per instance (was fixed `id="modal-title"`)

### 0b144de9 fix(tester): Bugs #459-#466 — modal contract fixes + baseline spec restore

- PurchaseOrderCreateModal: lines у body POST /purchase-orders (не POST /lines)
- InvoiceCreateModal: initialLineIdsRef snapshot + DELETE /invoices/:id/lines/:lineId для removed
- StockDocumentCreateModal: TRANSFER targetWarehouseId validation
- InvoiceCreateModal: computedTotal = sum(qty\*unitPrice)

### d08efb8d fix(review): surface ref-load errors + fix stale-closure auto-select in PO/StockDoc modals

### 71677c94 fix(sync): align modal interfaces and endpoints with backend API contracts

### 4a05d7c7 fix(review): pricing leak + types + per-warehouse stock

- CRITICAL: MECHANIC роль видалено з GET /stock-items/by-batch (costPrice/salePrice PII)
- ConsumptionRow type tightened (non-null alignment with schema)
- goods.service.stockTotals(): `take: 2000`
- CreateWorkOrderModal: `setStockWarehouseMap(new Map())` на reset

### fd8be3b3 perf(inventory): parallelize batch.service writes

### c4b249f2 perf(inventory): optimize 3-view report (DB indexes + memo + parallel FK guards)

- Додано 3 covering indexes: `stock_movements(orgId, goodId, createdAt)` + `(orgId, createdAt)` + `stock_batches(orgId, createdAt)`

### 1752a75 fix(inventory): Fragment keys + MOVEMENT_TYPE_LABELS enum sync + Intl singleton + relation soft-delete filters

### a5f01d37 feat(inventory): add 3-view stock report (По товарах / По документах / По партіях)

### c0879445 fix(review): stock-totals column — tfoot colSpan, race guard, UUID validation

### 0618c621 feat(work-orders): add "К-т на складі" column to parts table

### 94de0b34 fix(calendar): correct WO prefill from calendar slot (Bug #448)

- WINDOW*END * 60 замість hardcoded `19 _ 60`
- plannedHours у CreateWOPrefill interface

### af09a681 fix(tester): Bugs #449, #451 — regression tests + date='' guard

---

## 2026-06-12

### fef027b0 fix(review): calendar comment drift, silent sync failure, DocumentsTab PATCH/label

### 7640de9b fix(review): calendar sync — endAt>startAt guard, parent-only update, ConfirmDialog reuse

### fba87ce4 fix(tester): Bugs #444, #446, #447 — calendar sync hardening + settings coverage

### 29fc97f0 fix(settings): syncCalendarSlotWithPlannedHours in DocumentsTab PATCH body

### 307d1e39 feat(settings): add syncCalendarSlotWithPlannedHours setting

### e266f4a2 fix(settings): Toggle style for recalcPlannedHoursFromLines, default true

### 8778d3f1 feat(settings): add 'Налаштування документів' tab with plannedHours recalc toggle

### 50c550bd fix(review): WO completion deadlock, kyivOffsetMs unit, dashboard TO overdue

### 1d9cd19d fix(review): calendar contract spec + MECHANIC PII defense-in-depth

### 11c8ded7 fix(security): strip PII from GET /calendar/slots for MECHANIC role

### 86d22367 fix(review): drop counterpartyId from checkConflicts response

### 9d87c119 fix(security): strip PII from checkConflicts response

---

## 2026-06-11

### c24014ed refactor(simplify): Cycle 3 (prev) — readonly FSM arrays, toIdMap/calcVatTotals

### 51c22418 test(e2e): plannedHours/actualHours E2E specs

### 2a8da05a perf(optimize): CreateWorkOrderModal twin-scan reduce + N×M finds → useMemo Maps

### f1d3f805 docs(skills): optimize skill files — reduce total size by 46%

### f3633cd7 chore: remove leftover .bak file

---

## 2026-06-10 (Calendar sync + plannedHours)

### 231b0be2 test(e2e): Bug #486 — estimate-share self-seeding pattern

- beforeAll: clone DRAFT WO → transition to ESTIMATE
- afterAll: ESTIMATE → CANCELLED → DELETE (FSM-aware cleanup)

### 493c46ad docs(memory+skills): record self-seeding pattern

### 747cc445 perf(optimize): dashboard kyivToday hoist + calendar sync spec

### 294a5ed6 docs(skills): 2 perf patterns to sto-optimize

### 4d7eef47 docs(memory): update after review fef027b0

---

## Попередні фази (довідка)

### Inventory 3-view (a5f01d37)

Звіт «По товарах / По документах / По партіях» з DB covering indexes.

### PurchaseOrder edit-mode (115fea9e)

Editable supplier/warehouse/contract у DRAFT, FSM arrows завжди видимі, receivedQty column.

### StockDocuments (d059b9a9)

RECEIPT тип (Оприбуткування): 3 файли, без міграції (enum вже був у Prisma).

### Pricing: brand markup + COST_TIER (fdcf7ea)

`PricingRuleType.COST_TIER`, `brandId` у PricingRule, `PricingRuleTier` модель.  
Міграція: `20260530100000_add_pricing_brand_cost_tier`.

### UserPreference + Detail Panel Config (5d003e4)

`UserPreference` модель, `GET/PUT /user-preferences/:key`, `useDetailPanelConfig(pageKey)`.  
Міграція: `20260530200000_add_user_preferences`.

### CounterpartyContract (4f7a9be)

Contract entity + PURCHASE/SALE types + auto-primary promote + DocumentNumberService.

### TabBar — taskbar для згорнутих модалок (6f9515c6–f2ef7758)

`TabBarContext`, `useTabBar`, dedupe by (modalKey + identity-keys), fetch race guard.

### CreateWorkOrderModal — inline таблиці (eb929140)

Роботи + Товари pre-save рядки, toNumberOrUndefined(), close-guard Bug #381.

### PhoneInput — маска +38 (0XX) XXX-XX-XX (225ff70)

### AnimatedBody — плавна зміна висоти Modal (b5add44)

### useDirtyForm — async confirmClose + DirtyConfirmDialog (921afb7)

### Detail Panel System — useDetailPanel + DetailPanelToggle (f529d0f)

### ModalTabs — нижній таб-секція модалок (6b886ae)
