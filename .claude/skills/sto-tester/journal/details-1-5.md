# sto-tester — повні тексти пунктів §1.5 — Тест-покриття Backend

> Не читати цілком. Перелік пунктів — `../sections/s1-5-test-coverage-backend.md`; звідси беруться лише
> ті, чий код `T1.5-NNN` обрано за diff-ом.

<!-- T1.5-001 -->

- [ ] **Змінено `scripts/affected-tests.py` або додано тест нового виду (Bugs #785–#788):** селектор
      бачить лише граф імпортів і маршрути. Питати про кожен новий тест «чим він прив'язаний до
      коду»: читає файли з диска → має бути в `scanning_specs()`; лежить у `packages/<name>` →
      у виводі має бути `ІНШЕ: cd packages/<name> && npx vitest run`; E2E ходить в API напряму →
      `specs_calling()`. Перевірка — мутаційна, проти повного прогону як оракула (не пробами
      «для X вибрано X»): `→ journal/approaches-2026-10.md`, запис 2026-10-07 про селектор.
      Детектор кандидатів: `grep -rlE "readFileSync|readdirSync|import\.meta\.glob" apps/*/src packages/*/src --include=*.spec.ts --include=*.test.ts --include=*.test.tsx`

<!-- T1.5-002 -->

- [ ] **Defense-in-depth status guard + stale fixtures (Bug #200):** review-фікс додав `if (entity.status !== ALLOWED_A && entity.status !== ALLOWED_B) throw BadRequestException(...)` у сервісі, але парний spec мокає `findFirst` БЕЗ поля `status` → undefined ≠ ALLOWED → guard кидає на ВСЕ існуючих тестах → release-blocker baseline. Grep: `grep -n "findFirst.mockResolvedValueOnce({" *.spec.ts` → для кожного мока у сервісі що додав status guard → перевірити чи fixture містить `status: <ALLOWED_STATUS>`. Якщо нове guard перевіряє додаткові поля (deletedAt, isActive, ownerId) — той самий патерн. Профілактично після кожного review-commit що додав early-throw guard у service.X — пройти всі `findFirst.mockResolvedValueOnce(...)` у відповідній spec і додати потрібні поля.

<!-- T1.5-003 -->

- [ ] **Refactored public method usage + stale mock (Bug #200):** рефактор сервісу замінив виклик `private/inline X()` на нову public method `Y()` (наприклад `calculateSalePrice` → `getActiveRulesForOrg + computePriceFromRules`). Парний spec ще мокає СТАРИЙ виклик (`pricingService.calculateSalePrice.mockResolvedValueOnce(...)`) — тест проходить **випадково** бо `Y` не викликається насправді. Регресія: майбутній рефактор поверне виклик `X` → тест зелений але реальна логіка зламана. Grep: `git diff HEAD~1 -- service.ts` шукає `+ this.X.Y(` + перевірити що spec мок названо `Y` а не `Z`. Принцип: spec повинна мокати ТЕ ЩО СПРАВДІ викликається — не успадковане.

<!-- T1.5-004 -->

- [ ] **Controller arg-count drift у `toHaveBeenCalledWith` форвардингу (Bug #340):** feature-commit що додає `sortBy`/`sortDir`/`branchId`/інший новий query-param у `*.dto.ts` зазвичай також редагує controller щоб прокинути `query.NEW` як додатковий positional arg у `this.service.findAll(orgId, ...args, query.NEW)`. Існуючі regression-guard contract specs (Bug #339 patten) асертять `toHaveBeenCalledWith(orgId, ...8 args)` — після рефактору controller передає 9-10 args → AssertionError на КОЖНОМУ існуючому contract spec тому ж модулю. tsc green (TypeScript не перевіряє кількість positional args при варіадичному передаванні всередині `.then(query => service.X(orgId, query.A, query.B, ...))`). Grep для виявлення pre-commit: `git diff HEAD~N HEAD -- "*.controller.ts" | grep -E "^\+.*service\.findAll\(.*\bquery\.[a-zA-Z]+\b"` — кожен новий `query.X` arg → перевірити **усі** `*.contract.spec.ts` у тому ж модулі на `toHaveBeenCalledWith` з фіксованою кількістю args і додати `undefined` для нових parametrів. Альтернатива (безпечніший pattern для майбутнього): передавати **об'єкт** `{ page, limit, ..., sortBy, sortDir }` замість positional args → нові поля не ламають existing specs (вони асертять об'єкт, додаткові поля у новому об'єкті НЕ матчаться assertion'ом якщо використовується `expect.objectContaining({...})`). Severity: MEDIUM (release-blocker — baseline червоний → tester-сесії неможливі). Boundary-check: після КОЖНОГО `feat(api|ui): add X filter`/`feat(api|ui): add X sorting` commit що чіпає controller — пройти `*.contract.spec.ts` того ж модулю.

<!-- T1.5-005 -->

- [ ] **Stale mock після додавання cascade-helper у service-method (Bug #340):** review-fix що додає каскадну логіку через helper-метод (`getDescendantIds`, `getAncestorIds`, `getLinkedRecords`) у існуючий service-метод (`toggleActive`/`deactivate`/`archive`/`remove`) часто додає НОВИЙ Prisma call (`findMany`, `count`, `groupBy`) ВСЕРЕДИНІ helper-а. Існуючі spec що мокали лише top-level Prisma calls (наприклад `updateMany` + `findFirstOrThrow`) тепер ловлять `TypeError: X is not iterable`/`Cannot read property 'length' of undefined` бо helper отримує `undefined` від unmocked `findMany`. Grep: `git diff HEAD~N HEAD -- "*.service.ts" | grep -E "^\+.*await this\.(getDescendantIds|getAncestorIds|getLinkedX|expandX|cascade)"` → для кожного нового helper-виклику читати helper-метод і знайти усі Prisma read-ops → у відповідному `*.spec.ts` додати `prisma.<model>.findMany.mockResolvedValueOnce([])` (порожній цаскад = mock default) ПЕРЕД викликом service-методу. Severity: MEDIUM. Парне з Bug #200 (Defense-in-depth status guard) — той самий принцип «новий read у сервісі → новий mock у spec».

<!-- T1.5-006 -->

- [ ] **Dedup invariant додано після simplify-to-Promise.all БЕЗ regression-guard (Bug #489):** simplify/optimize-цикл що замінив sequential `for-loop { await tx.X.update(...) }` на `await Promise.all(plan.map(u => tx.X.update(...)))` І додав `const dedupedPlan = deduplicateBy(plan, u => u.pk)` ПЕРЕД Promise.all → ПОТРЕБУЄ regression-guard у парному `*.service.spec.ts`. Без нього refactor що дропне `deduplicateBy` (наприклад «бачу dead code на унікальному масиві») пройде CI зеленим, а production-дані з duplicate-PK (PO multi-lot lines на той самий goodId, xlsx-import з повтором SKU) → race-deterministic ОДНОГО winner серед N writes на той самий PK → silent data corruption. Grep: `grep -rn "deduplicateBy\|new Map(.*\.map.*=> \[" apps/api/src/modules --include="*.service.ts" -l` → для кожного service знайти парний spec → `grep -cE "deduplicate|duplicate.*(goodId|lineId|id)" $spec` = 0 → bug. Regression-guard test: 2 entries з ОДНИМ PK + різні compute results → `expect(prisma.<model>.updateMany).toHaveBeenCalledTimes(1)` (НЕ 2!) + `data: { <field>: <last-value> }` (last-wins). Severity MEDIUM.

<!-- T1.5-007 -->

- [ ] **Widened return-type service method + stale 2-field mock/assert у paired spec (Bug #508-#509):** будь-який commit що розширює сигнатуру service-методу (`Promise<{ id, number }>` → `Promise<{ id, number, status, amount, documentDate }>`) АБО розширює `select`-clause у Prisma read І додає mapping (Number(decimal), date.toISOString()) ОБОВ'ЯЗКОВО оновлює: (а) `*.service.spec.ts` mock щоб `mockResolvedValue` повертав ВСІ нові поля з реалістичними значеннями (Decimal/Date типи якщо service map їх перетворює); (б) `*.service.spec.ts` assert через `expect(result).toEqual({...5-полевий-shape...})` (НЕ `expect.objectContaining` що дозволяє регресію видалення полів); (в) `*.contract.spec.ts` `serviceMock.X.mockResolvedValueOnce({ all-fields })` + `expect(res.json()).toEqual({...})` (НЕ `toMatchObject({ id, number })` — підмножина не блокує регресію). Без оновлення: service mock повертає 2 поля → service map дає `NaN` для `Number(undefined)`, `null` для `(undefined).toISOString()`, `undefined` для нових полів → unit test червоний з cryptic message `expected { …(5) } to deeply equal { …(2) }` — release-blocker baseline. Парне для contract spec: `toMatchObject({ id, number })` пропускає `undefined`/`null` у нових полях → contract spec проходить АЛЕ silently не покриває нові wire fields → refactor що видалить status/amount/documentDate з `select` пройде CI green → FE отримує undefined → status badge сирий код. Sprint-pattern: тестова симуляція оновлюється з 1-2 commit'ам лагом vs implementation. Grep для виявлення: `git diff HEAD~3 HEAD -- "*.service.ts" | grep -E "^\+\s+(status|amount|documentDate|[a-z]+At):\s*(true|inv\.|Number|\.toISOString)"` → для кожного match у select/mapping → перевірити mock у `*.service.spec.ts` + asserts у contract+service spec на повний shape. Парне з Bug #390 (stale regression-guard після URL/payload-format fix). Severity HIGH (baseline-blocker якщо unit; MEDIUM regression-guard gap якщо contract).

<!-- T1.5-008 -->

- [ ] **Stale `$transaction` callback mock (Bug #489 sub-pattern):** spec мок `$transaction: vi.fn(async (ops: unknown[]) => ops)` (повертає arg напряму) НЕ виконує callback-форму `$transaction(async tx => { ... })` — INNER логіка $transaction body МОВЧКИ пропускається. ВСІ assert-и на `tx.X.updateMany`/`tx.priceHistory.createMany`/`tx.<model>.X` у тестах **проходять як зелені без виклику** → defense-in-depth orgId guards, dedup invariants, FSM side-effects не покриті. Шаблон правильного моку: розпізнавати ОБИДВІ форми + виконувати callback з `prisma` як `tx`:

<!-- T1.5-009 -->

- [ ] Fix що змінив **relation-ім'я** (`customerGarage`→`customerGarages`), **форму вкладеного `where`** (`some`/`every`/nested `OR`), `include`/`select` shape, або `mode: 'insensitive'` → це **runtime `PrismaClientValidationError`**, який mock-based contract spec (`{ provide: Service, useValue: serviceMock }`) НЕ виконує. Потрібен **service-spec** який будує реальний `where` через `{ provide: PrismaService, useValue: { model: { findMany: vi.fn() }, $transaction: ops => Promise.all(ops) } }` і асертить форму `findMany.mock.calls[0][0].where` (правильні relation-імена + nested `deletedAt: null` + tenant `orgId`). Перевіряти ОБИДВА напрями: правильне ім'я присутнє AND singular/старе ім'я відсутнє

<!-- T1.5-010 -->

- [ ] **Нові query-param фільтри (dateFrom, dateTo, branchId, q...) у існуючому QueryDto (Bugs #338, #339):** перевірити що відповідний `*.contract.spec.ts` має тест `toHaveBeenCalledWith(..., paramValue)` або `queryArg.param === value` (залежно від spread vs object). Якщо contract spec відсутня — створити. Grep: `git diff HEAD~5 HEAD --name-only | grep "\.dto\.ts$"` → для кожного QueryDto знайти spec → перевірити покриття нових полів.

<!-- T1.5-011 -->

- [ ] **Boundary-кейси для діапазонних правил (COST_TIER, sliding-scale, age-brackets, tax-brackets):** будь-яке правило з `min <= x < max` (або `<=`/`>=`) має тести точно НА межі (`x === min`, `x === max`), на нулі (`x === 0`), і за межами (`x < минімум`, `x > максимум`). Реалізація працює, але регресія `<=`/`<` беззвучно змінить semantics — рідко-проходимий код. Boundary-тест документує contract і ловить інверсію оператора (Bug #184)

<!-- T1.5-012 -->

- [ ] **Cross-tenant FK contract test для optional FK у payload:** якщо контролер валідує optional FK через `findFirst({id, orgId})` перед write (Bug #161 патерн) → contract spec має асертити: (а) POST з FK з ЦІЄЇ org → 201 + `findFirst` викликаний з правильним `{id, orgId, deletedAt:null}`; (б) POST з FK з ЧУЖОЇ org → 404 + `create` НЕ викликаний; (в) PATCH з FK з ЧУЖОЇ org → 404 + `update` НЕ викликаний. Без цих тестів регресія (видалення org-scoped перевірки під рефактор) пройде CI зеленою → cross-tenant linkage у проді без error (Bug #186)

<!-- T1.5-013 -->

- [ ] **Integration-спек на dev-БД видаляє/змінює рядки за ПРИРОДНИМ ключем, а не за власним `id` (Bug #782):** `cleanup()` виду `DELETE ... WHERE "branchId" = <findFirst()> AND <enum-поле> IN (...)` стирає справжні дані розробника — набір при цьому зелений. Назва константи `TEST_*` не ізолює, якщо значення доменне (enum/код) і на нього є `@@unique`. Детектор дає КАНДИДАТІВ (видалення не за `id`), кожен перевірити очима: маркер унікальний для тесту? видалення всередині транзакції з відкатом?
