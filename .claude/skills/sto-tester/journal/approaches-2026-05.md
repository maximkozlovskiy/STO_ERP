# sto-tester — журнал підходів, 2026-05

> Не читати цілком — шукати за ключовим словом.

### 2026-05-31 — Prefetch queryKey ↔ page queryKey shape mismatch (Bug #281) — frontend / react-query

**Сигнал:** TopShell `prefetchQuery({queryKey:xKeys.list({})})` але сторінка `useX({page:1,limit:20,status:'',q:'',showDeleted:false})` → різні hash → double-fetch. Default first-mount state=повний об'єкт, НЕ `{}`.

```bash
# для кожного prefetchQuery → знайти споживача → порівняти shape (всі keys+значення)
```

**Severity:** MEDIUM (silent performance).

### 2026-05-31 — SSRF: validatePublicUrl + redirect:'manual' обов'язково разом (Bug #273) — backend / security

**Сигнал:** `fetch(userUrl)` з `validatePublicUrl` але без `redirect:'manual'` → attacker.com 302→`169.254.169.254`→default fetch слідує з Authorization header→metadata bypass. ОБИДВА шари обов'язкові.

```bash
for f in $(grep -l "validatePublicUrl\|branchSettings\.\|dto\.url\|dto\.webhookUrl\|endpoint\.url" apps/api/src/modules --include="*.ts" -r | grep -v spec); do grep -q "fetch(" "$f" && ! grep -q "redirect:\s*'manual'" "$f" && echo "BUG #273 MISSING: $f"; done
```

**Фікс:** обидва шари + перевірка response.status у [300,400)→throw. Contract-тест (checkbox.processor pattern: `301/302→throw+НЕ оновлює DB`).
**Severity:** CRITICAL (admin→cloud metadata).
**Де ще:** будь-який новий outbound fetch (Checkbox, ПРРО, SMS, OAuth callback, postal). Родич #652 (secret at-rest), #683-#687 (client tests).

### 2026-05-31 — Dead-feature: service реалізований але ніколи не викликається (Bugs #267, #268) — backend

**Сигнал:** `@Injectable` з `@InjectQueue`/`@Processor` але 0 callsites поза self-module+spec → бали/cost не нараховуються. Парний сигнал: UI tab/sidebar для фічі АЛЕ нема trigger.

```bash
grep -rl "InjectQueue\|@Processor" apps/api/src/modules --include="*.ts"
# для кожного method: grep -rln "\.<method>(" apps/api/src --include="*.ts" | grep -v "spec\|<own-module>" → 0 = bug
```

**Фікс:** виклик у trigger service (`.catch(warn)` non-blocking)+import Module+DI.
**Severity:** HIGH якщо розрекламована (`loyalty.queueEarn` ніколи з payments); MEDIUM admin/internal.

### 2026-05-31 — Frontend hint обіцяє backend behavior що не реалізований (Bug #266) — frontend / UX

**Сигнал:** `"буде автоматично застосовано"` але POST body не містить поля що реалізує обіцяне.

```bash
grep -rnE "буде (додано|застосовано|скопійовано|створено|нараховано|використано|враховано|оновлено)|автоматично" apps/web/src --include="*.tsx"
```

**Фікс:** реалізувати backend АБО переписати hint чесно.
**Severity:** HIGH.

### 2026-05-31 — Mass DTO migration variant audit (Bugs #257-#265, #215) — backend / dto-validation

**Сигнал:** sprint `@Transform(emptyToUndefined)` для `@IsDateString` пропускає `@IsISO8601`, `@IsDate`, `@IsEnum([lit])`, `@IsUUID('4',{each:true})`, `@Matches(regex)` та inline 1-рядкові форми + `extends PartialType(X)` chains. КОЖЕН validator що відхиляє `''` потребує `@Transform(emptyToUndefined)` якщо optional. Плюс variant-форми (`@IsUUID('4',{message})`).

```bash
grep -rn "@IsUUID(" apps/api/src/modules/ --include="*.dto.ts"   # обидва @X() і @X(arg,{each|message})
```

**Фікс:** пройти ВСІ варіанти validator-сімейства. Regression: 1 contract-spec `POST/PATCH з '' у X→201+service отримує undefined` (#244).
**Severity:** HIGH (фіча мертва коли фронт шле `''`; блокує dev/seed з не-v4 UUID).

### 2026-05-31 — Public endpoint: array-cap + tenant-FK audit (Bugs #251, #252) — backend / security

**Сигнал:** controller без `@UseGuards(JwtAuthGuard)` — DTO array без `@ArrayMaxSize`, UUID array без tenant-FK count guard.

```bash
for c in $(find apps/api/src/modules -name "*.controller.ts" -not -name "*.spec.*"); do ! grep -q "@UseGuards(JwtAuthGuard" "$c" && grep -q "@Get\|@Post\|@Patch\|@Delete\|@Sse" "$c" && echo "PUBLIC CTRL: $c"; done
```

Для кожного public: `@IsArray` має `@ArrayMaxSize`; `string[]/UUID[]` у service-create через `data:{...dto,fkList}` → `prisma.X.count({where:{id:{in:dto.field},orgId,deletedAt:null}})===dto.field.length`; `@IsString` має `@MaxLength`; external service→queue attempts≥10+backoff.
**Severity:** HIGH (DoS + cross-tenant linkage).

### 2026-05-31 — Inner DTO без class-validator декораторів (Bug #247) — backend / security

**Сигнал:** `@ValidateNested @Type(()=>InnerDto)` але InnerDto-поля `@ApiProperty() workId!:string` БЕЗ `@IsUUID/@IsNumber`. `@ValidateNested` вимагає що inner DTO САМ описує валідатори; без них pipe пропускає ВСІ значення.

```bash
grep -rn "@ApiProperty()" apps/api/src/modules --include="*.dto.ts" -A1 | grep -B1 "[a-z]!: string\|[a-z]!: number" | grep -v "@Is\|@Min\|@Max\|@Matches\|@Length"
```

**Severity:** HIGH (bypass validation + anti-DoS gap).

### 2026-05-31 — Shared helper без unit-тесту (Bug #243) — backend / test-coverage

**Сигнал:** `calculateXxx()` у 10+ endpoints без `*.spec.ts` → будь-яка зміна=10+ регресій.
**Severity:** HIGH.

### 2026-05-31 — DTO write-side asymmetry: nullable col без FSM persist (Bug #236) — backend / data-integrity

**Сигнал:** sprint додає `nullable colX?` у row-модель + `colX:l.colX??null` у toDto → у `transition()`/`receive()`/`applyPricing()` де обчислюється resolved value і пропагується у side-effect, ОБОВ'ЯЗКОВО парний `tx.<rowTable>.update({where:{id:line.id},data:{colX:resolvedValue}})` у $transaction. Інакше `findOne(id).lines[i].colX===null` назавжди → history має X, current NULL. Symmetric-write для #232 (read-side missing include).

```bash
grep -rnE "[a-z]*Id:\s*l\.[a-z]*Id\s*\?\?\s*null" apps/api/src/modules --include="*.service.ts"
```

**Severity:** HIGH (silent data integrity).

### 2026-05-31 — UoM conversion відсутня на submit (Bug #231) — frontend / data-corruption

**Сигнал:** UI перемикає UoM→display qty ×coefficient, submit шле `parseFloat(l.quantity)` без `*coefficient` → backend (base units) отримує display → silent corruption у stock movement.

```bash
grep -rnE "quantity:\s*parseFloat\(l\.quantity\)[^*]" apps/web/src/app --include="*.tsx" -B5 | grep -B5 "coefficient"
```

**Фікс:** `quantity:parseFloat(l.quantity)*(l.coefficient||1)`, `price:parseFloat(l.price)/(l.coefficient||1)`. Видно лише coeff!=1.
**Severity:** CRITICAL (release-blocker).

### 2026-05-31 — Prisma schema без парного migration (Bug #220) — database / release-blocker

**Сигнал:** `schema.prisma` modified без нового SQL у `migrations/` → runtime P2021. tsc+unit green (client з декларативної schema, mocks не б'ють DB).

```bash
schema_changes=$(git diff HEAD~5 HEAD --name-only -- "*/prisma/schema/*.prisma"); new_migrations=$(git diff HEAD~5 HEAD --name-only --diff-filter=A -- "*/migrations/"); [ -n "$schema_changes" ] && [ -z "$new_migrations" ] && echo "BUG #220"
```

Перевіряти: нова model→CREATE TABLE; field→ALTER TABLE ADD COLUMN; `@@index`→CREATE INDEX; `@@unique`→CREATE UNIQUE INDEX. Не покладатись на `prisma migrate dev` (потребує live DB); писати SQL вручну.
**Severity:** CRITICAL (runtime crash у production).

### 2026-05-31 — Sub-resource default-switch staleness у parent list (Bugs #226-#227) — frontend / state-sync

**Сигнал:** UoM modal `setDefault()`→backend `Good.unitId` змінено→FE parent-table не рефетчена. Auto-promote next-default: `removeUoM` пише `findFirst(orderBy:createdAt asc)+update({isDefault:true})`, оптимістичний filter невірний.

```bash
grep -rn "apiFetch.*method:.*'POST\|PATCH\|DELETE'" apps/web/src/app --include="*.tsx" | grep -E "/uoms|/barcodes|/categories|/tax-rates"
```

**Фікс:** success-handler викликає `load()` parent АБО invalidate `<parentKeys>.all`; replace optimistic filter на `refreshXs(parentId)`.
**Severity:** MEDIUM-HIGH.

### 2026-05-31 — Paired logger+middleware без спільного req-id source (Bug #216) — backend / observability

**Сигнал:** `CorrelationIdMiddleware` сетить `x-request-id`, pino-http `genReqId`→sequential int→cross-correlation мертва.

```bash
grep -n "genReqId\|reqId" apps/api/src   # Middleware є, genReqId нема → bug
```

**Фікс:** `genReqId: req => req.headers['x-request-id'] ?? randomUUID()`. Contract-тест: `X-Request-Id: <UUID>`→`JSON.parse(stdout).reqId===<UUID>`. Також #217: pino `redact` має покрити КОЖНЕ secret-поле DTO (`password`/`*Password`/`*Token`/`*Secret`/`apiKey`/`webhookSecret`, включно `ownerPassword`/`prroApiKey`), grep `grep -rnE "(password|Token|Secret|apiKey|webhookSecret)!?\??:.*string" apps/api/src/modules/**/*.dto.ts`.
**Severity:** HIGH (#216 production monitoring); MEDIUM #217 (HIGH коли з'явиться log-stmt зі spread body).

### 2026-05-30 — React Query cross-resource invalidation gap (Bugs #210-#212, #245, повторено #590) — frontend / react-query

**Сигнал:** `POST /invoices/:id/lines` side-effect оновлює StockMovement/settlements — але `invalidateQueries(inventoryKeys.all)`/`counterpartiesKeys.all` відсутній. Особливо FSM confirm-like (`use<X>Confirm`/`Complete`) що триггерять `settlements.createTransaction` → CRM balance застаріває.

```bash
grep -rln "createTransaction" apps/api/src/modules/*/*.service.ts   # для кожного знайти FE-хуки → onSuccess перевірити counterpartiesKeys.all
```

Reference-fix: `useCreatePayment`(#245), `useConfirmSupplierPayment`(#590).
**Severity:** MEDIUM (бізнес-метрика); HIGH коли впливає на balance-рішення; LOW UX.

### 2026-05-30 — React Query custom hook без тесту (Bug #214, #185, #213) — frontend / test-coverage

**Сигнал:** `apps/web/src/hooks/api/use*.ts` без `*.test.tsx`. Обов'язково: queryKey factory isolation, enabled-gate, URLSearchParams build, signal abort. Шаблон `useWorkOrders.test.tsx` (12 кейсів). Свіжий `QueryClient` per-test з `retry:false` (не реальний Provider). #213: migrated read-path але write-path raw apiFetch (mutation hook експортований, count usage=0) — bundle bloat, LOW.
**Severity:** MEDIUM.

### 2026-05-30 — error.tsx без & { digest?: string } (Bug #206, #207, #208) — frontend / typescript

```bash
grep -rn "error.*:\s*Error[^&]" apps/web/src/app --include="error.tsx" | grep -v "digest"
```

**Фікс:** `{error:Error&{digest?:string};reset:()=>void}`. Аналогічно layout.tsx/page.tsx/loading.tsx сигнатури. #207: decorative SVG що дублює semantic-текст→`aria-hidden="true"`. #208: `error.tsx`/`not-found.tsx` з інтерактивом→парний `*.test.tsx` (heading, message, reset, navigate, aria-hidden, digest-type-regression).
**Severity:** LOW (блокує моніторинг Sentry/Datadog `error.digest`).

### 2026-05-30 — Global APP_GUARD без skip-list для /health/SSE/webhooks (Bug #203) — backend / deploy

**Сигнал:** `{provide:APP_GUARD,useClass:ThrottlerGuard}`→`/health` 429→docker healthcheck→cascade restart.

```bash
grep -n "APP_GUARD\|useClass: ThrottlerGuard\|useClass: IpFilterGuard" apps/api/src/app.module.ts
```

**Фікс:** `@SkipThrottle()`/`@Public()` на health/metrics/SSE(`@Sse`)/webhooks(PRRO/payment)/batch-cron controllers.
**Severity:** CRITICAL (production cascade restart).

### 2026-05-30 — Defense-in-depth guard + stale fixtures (Bug #200) — backend / test-coverage

**Сигнал:** review-фікс додав `if(entity.status!==ALLOWED)throw`→spec мокає `findFirst` БЕЗ `status`→undefined≠ALLOWED→guard кидає→ВСІ тести fail. Або рефактор `X()→Y()` а spec ще мокає СТАРИЙ виклик (тест проходить випадково).

```bash
grep -n "findFirst.mockResolvedValueOnce({" *.spec.ts   # додати status:<ALLOWED>
```

**Severity:** MEDIUM (red baseline blocks CI). Принцип: spec мокає ТЕ ЩО справді викликається.

### 2026-05-30 — FormData через apiFetch замість apiMultipartFetch (Bug #197) — frontend / api-contract

**Сигнал:** `apiFetch` жорстко ставить `Content-Type: application/json` → FormData → browser не виставить boundary → `the request is not multipart`→upload завжди валиться. Фіча повністю мертва.

```bash
grep -rn "apiFetch\b.*body:\s*\(fd\|formData\|new FormData\)" apps/web/src --include="*.tsx"
```

**Фікс:** `apiMultipartFetch(path, formData)` (БЕЗ ручного method).
**Severity:** CRITICAL.

### 2026-05-30 — Nullable cost-input → calculateSalePrice → salePrice=0 (Bug #198) — backend / data-corruption

**Сигнал:** `0*(1+pct/100)=0`→`Good.salePrice` затирається у 0 для товарів без собівартості. `Good.purchasePrice` nullable.

```bash
grep -rn "calculateSalePrice\|purchasePrice ?? 0\|purchasePrice ?? null" apps/api/src/modules --include="*.ts"
```

**Фікс:** `if(good.purchasePrice==null||Number(good.purchasePrice)<=0)` skip (push у notFound, НЕ оновлювати salePrice). Виняток `FIXED_PRICE`.
**Severity:** CRITICAL (silent data corruption).

### 2026-05-30 — Boolean prop без inverse-condition test (Bug #194) — frontend / test-coverage

**Сигнал:** новий `propX?:boolean` — тест лише default (false). Інверсія guard (`!hideX`→`!!hideX`) проходить зеленою.

```bash
grep -nE "^\s+\w+\?: boolean" apps/web/src/components/ui/*.tsx   # після diff
```

**Фікс:** 2 кейси: inverse-стан активує/блокує; inverse не зачіпає інших елементів.
**Severity:** MEDIUM (критично для prop що вмикає UX-режим у N сторінках).

### 2026-05-30 — fastify-multipart FastifyError → 406 замість 400 (Bug #192) — backend / api-contract

```bash
grep -rn "await req.file()" apps/api/src/modules --include="*.controller.ts"   # має бути у try/catch
```

**Фікс:** try/catch `FastifyError→throw new BadRequestException('Неправильний формат запиту')`. Contract: `POST без multipart→400+укр`.
**Severity:** HIGH.

### 2026-05-30 — prisma.X.update({where:{id}}) без orgId (Bug #191) — backend / tenant-isolation

```bash
grep -rn "\.update({ where: { id:" apps/api/src/modules --include="*.service.ts" | grep -v "orgId"
```

**Фікс:** `updateMany({where:{id,orgId,deletedAt:null}})` + опц. `if(count===0)throw NotFound`.
**Severity:** LOW (profilatic) до HIGH (з prep-неперевіреним id).

### 2026-05-30 — Boundary-кейси для COST_TIER (Bug #184) — backend / test-coverage

**Сигнал:** `min<=cost<max` — нема тестів на межах (`cost===min`,`cost===max`,`cost===0`,out-of-range). Boundary документує contract і ловить інверсію `<=`/`<`.
**Severity:** MEDIUM.

### 2026-05-30 — Cross-tenant FK не покритий у contract-spec (Bug #186) — backend / security

**Сигнал:** optional FK валідується у service, contract spec нема кейс `POST з FK чужої org→404`.
**Фікс:** (а) FK з ЦІЄЇ org→201+findFirst `{id,orgId,deletedAt:null}`; (б) FK чужої org→404+create НЕ викликаний; (в) PATCH чужа org→404+update НЕ викликаний.
**Severity:** HIGH.

### 2026-05-30 — apiFetch generic type mismatch: T[] але endpoint повертає {items,total} (Bug #181) — frontend

**Сигнал:** `apiFetch<X[]>` де endpoint повертає `{items,total}` (стандарт STO list). Виняток: `/branches`=bare array.

```bash
grep -rn "apiFetch<[A-Za-z]*\[\]>" apps/web/src/app --include="*.tsx" | grep -v "//\|spec"
```

Known bare: /branches. Known {items,total}: /brands, /goods, /pricing-rules, /work-orders, /invoices, /counterparties.
**Severity:** HIGH (runtime TypeError).

### 2026-05-30 — Bulk-apply scope-inconsistency після нового scope-поля (Bug #178, #179) — backend / business-logic

**Сигнал:** `PricingRule` нове scope-поле (goodId/goodCategory/goodType/brandId), `applyRuleToGoods where` не включає→правило до зайвих товарів. #179: brandId priority over goodType.

```bash
grep -n "brandId\|goodCategory\|goodType\|goodId" apps/api/src/modules/inventory/pricing.service.ts | grep "where\|rule\."
```

**Severity:** HIGH (неправильна salePrice у БД).

### 2026-05-29 — Browser-API без jsdom-стабу → cascade test failure (Bug #177) — frontend / test-coverage

**Сигнал:** новий `new (ResizeObserver|IntersectionObserver|MutationObserver|PerformanceObserver)`, `matchMedia`, `navigator.(clipboard|share|geolocation|mediaDevices)`, `crypto.subtle`, `Notification` без jsdom-стабу→cascade всіх тестів що монтують shared-компонент. tsc мовчить, prod працює.

```bash
grep -rnE "new (ResizeObserver|IntersectionObserver|MutationObserver)" apps/web/src/components --include="*.tsx" -l | while read f; do grep -q "ResizeObserver" apps/web/src/__tests__/setup.ts || echo "STUB MISSING: $f"; done
```

**Фікс:** noop-стаб під guard `typeof globalThis.X==='undefined'` у setup.ts.
**Severity:** HIGH.

### 2026-05-29 — [x] виправлено без парного code-diff → хибно-зелений — process

**Сигнал:** `git log -5 --stat | grep "fix(tester)"` чіпає тільки `*.md`→фікси у коді відсутні.
**Severity:** CRITICAL (hides blockers).

### 2026-05-29 — Container healthcheck несумісний з базовим образом (Bugs #164, #165, #166, #167, #168, #170) — backend / deploy

**Сигнал:** `curl` у alpine без curl; `wget` у minio/minio (лише `mc`).

```bash
grep -nE "curl|wget" docker-compose*.yml | grep -i "healthcheck\|test:"
docker run --rm --entrypoint sh <image> -c "command -v curl; command -v wget; command -v mc"
```

**Фікс:** minio→`["CMD","mc","ready","local"]`+пін RELEASE-тег (#170); node→`node -e http.get`; шлях узгоджений з `setGlobalPrefix` (`/api/health`). Root `.dockerignore` якщо `COPY . .` (#166). build-скрипт не у мертвий шлях (#167 `apps/api/public` без `@fastify/static`); `$PSScriptRoot` fallback. nginx `_next/static` immutable+gzip_types svg/js (#168). blast-radius `depends_on: service_healthy`.
**Severity:** CRITICAL (service ніколи healthy→cascade restart).

### 2026-05-29 — Query-shape фікс (relation-ім'я) без service-spec (Bug #163, #171) — backend / test-coverage

**Сигнал:** `fix: customerGarage→customerGarages` — contract spec мокає service→не ловить `PrismaClientValidationError`.
**Фікс:** service-spec з `PrismaService useValue:{model:{findMany:vi.fn()},$transaction:ops=>Promise.all(ops)}`→assert `findMany.mock.calls[0][0].where` (правильні relation-імена + nested `deletedAt:null` + `orgId`). ОБИДВА напрями: нове ім'я присутнє AND старе відсутнє.
**Severity:** HIGH (runtime P2028).

### 2026-05-28 — Optional FK у spread без org-scoped validation (Bugs #90, #161) — backend / tenant-isolation

**Сигнал:** `data:{...dto}` де `dto.brandId?:string` — service не робить `findFirst({id:dto.brandId,orgId,deletedAt:null})` ПЕРЕД create. Prisma FK перевіряє глобальне існування, НЕ orgId; P2003 ловить лише неіснуючий, не cross-tenant.

```bash
grep -rn "Id?: string" apps/api/src/modules --include="*.dto.ts" | grep -iE "brand|unit|supplier|counterparty|vehicle|branch|warehouse|category|account"
grep -rn "data: { \.\.\.dto\|data: dto\b" apps/api/src/modules --include="*.service.ts" | grep -v spec
```

**Severity:** HIGH.

### 2026-05-28 — Swallowed fetch годує обов'язковий Select → заблокований workflow (Bug #159) — frontend

```bash
grep -rn "\.catch(() => {})" apps/web/src/app --include="*.tsx" -B3
```

**Сигнал:** `.catch(()=>{})` ховає помилку списку у `<Select required>`/`disabled={!state}` → порожній список=заблокований workflow без feedback (MEDIUM не LOW).
**Фікс:** `errorState`+inline `<p>` під контролом.

### 2026-05-28 — Мертвий стан/handler після inline→shared-component рефактору (Bug #160) — frontend

**Сигнал:** setter викликається ТІЛЬКИ у reset-ефекті (`if(!open)setX('')`), value ніде не читається у JSX; handler визначено не викликано. tsc без `noUnusedLocals` мовчить.

```bash
grep -rn "const \[\(wo\|cp\|search\|inline\)[A-Za-z]*," apps/web/src/app --include="*.tsx"
```

**Фікс:** видалити повністю (включно cleanup orphaned timeoutRef).
**Severity:** LOW.

### 2026-05-28 — Timeline drag/resize px→time без clamp → Invalid Date (Bug #157) — frontend

```bash
grep -rn "decimalHoursTo\|pxToHours\|pxToDecimal\|clientX.*-.*rect\|getBoundingClientRect" apps/web/src/app --include="*.tsx" -l
```

**Фікс:** clamp у `[WINDOW_START,WINDOW_END]` ПЕРЕД `new Date(...).toISOString()` (інакше `"24:30"`/`"-1:00"`→RangeError→handler мовчки падає). Resize-гілка ОКРЕМО від draw (draw через `pxToDecimalHours`, resize рахує delta clamp проти протилежного краю).
**Severity:** HIGH.

### 2026-05-28 — Стала spec після рефактору сервісу (Bugs #153-#155) — backend / test-coverage

**Сигнал:** нова `private readonly X:Type` у конструкторі→`{provide:Type,useValue:mock}` відсутній у spec→NestJS DI fail на ВСІХ тестах. Cache-мок: `CacheService.get→mockResolvedValue(null)`; `set/del/delPattern`→no-op. Якщо `create/update` спрощено N→1 findFirst→spec мокає РІВНО стільки.
**Severity:** MEDIUM (baseline red).

### 2026-05-28 — Soft-delete resurrection / P2002 — backend / unique constraints

**Сигнал:** `create()` без resurrection→P2002.
**Фікс:** `findFirst({NOT:{deletedAt:null}})`→`update({...dto,deletedAt:null})`.
**Severity:** HIGH.

### 2026-05-28 — @db.Date timezone mismatch — backend / date handling

**Сигнал:** `@db.Date` зберігає UTC-midnight→при читанні Kyiv (+3)→вчора.
**Фікс:** `DateTime`+normalize kyivMidnight(); або `@db.Date` лише для calendar-independent.
**Severity:** HIGH.

### 2026-05-28 — $transaction(array,{timeout}) не підтримується Prisma 5 — backend

**Сигнал:** `$transaction([op1,op2],{timeout})`→`TypeError: Option not supported`.
**Фікс:** callback-form `$transaction(async(tx)=>{...},{timeout})`.
**Severity:** HIGH.

### 2026-05-28 — BigInt у payload spread → JSON.stringify 500 (#195) — backend / sync

```bash
grep -rn "syncVersion\b" apps/api/src/modules --include="*.service.ts" | grep -v "Number(\|toNumber()"
```

**Фікс:** `syncVersion:Number(row.syncVersion)` у toDto.
**Severity:** HIGH.

### 2026-05-28 — CRON findMany без deletedAt:null на Organisation — backend

```bash
grep -rn "findMany.*Organisation\|findFirst.*Organisation" apps/api/src --include="*.ts" | grep -v "deletedAt"
```

**Severity:** MEDIUM.

### 2026-05-28 — Playwright fullyParallel + Next.js dev → SyntaxError race — E2E

**Сигнал:** `fullyParallel:true`→workers mount Next.js dev паралельно→`SyntaxError`.
**Фікс:** `fullyParallel:false` або `workers:1` для dev.
**Severity:** HIGH.

### 2026-05-28 — .catch(() => {}) ховає loading/error стан — frontend

```bash
grep -rn "\.catch(() => {})" apps/web/src/app --include="*.tsx"
```

**Фікс:** `.catch((e)=>{if(!cancelled)setError(e.message)})`.
**Severity:** MEDIUM.
