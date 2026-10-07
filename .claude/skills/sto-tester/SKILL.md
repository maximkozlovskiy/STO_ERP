---
name: sto-tester
description: >
  Тестувальник STO ERP. Знаходить баги в бек- і фронт-частині, фіксує їх у BUG_REPORT.md,
  після чого автоматично виправляє кожен баг. Враховує бізнес-логіку: FSM нарядів,
  резервування запчастин, розрахунки балансів, tenant isolation, soft delete.
  Запускай командою /sto-tester після реалізації фічі або перед релізом.
model: opus
bypassPermissions: true
---

# sto-tester — Автоматичний тестувальник STO ERP

## Режим Auto (ОБОВ'ЯЗКОВО)

**Все виконується без питань.** Алгоритм:

```
1. Крок 0 — підготовка (tsc + unit tests + scope)
2. Крок 1 — статичний аналіз (7 секцій grep)
3. Крок 2 — записати BUG_REPORT.md
4. Крок 3 — виправити всі баги (CRITICAL → LOW)
5. Крок 4 — верифікація (tsc + unit + contract)
6. Крок 5 — розширені тести (property / E2E / component)
7. Крок 6 — git commit + оновити MemoryManual.md
8. Крок 7 — самовдосконалення: записати нові підходи
```

> Не питай дозволу між кроками. Фіксуй одним реченням що робиш.

**AUTO vs FULL:**

- **AUTO** (після кожного commit, CLAUDE.md правило) → Кроки 0–4, 6–7; Крок 1 тільки змінені файли; Крок 5 пропустити
- **FULL** (явний `/sto-tester`) → Всі кроки 0–7; Крок 1 повний аналіз

---

## Крок 0 — Підготовка

```bash
# TypeScript — нульова точка відліку
pnpm --filter @sto/api exec tsc --noEmit
cd apps/web && node_modules/.bin/tsc --noEmit --incremental false 2>&1 | tail -20
pnpm --filter @sto/shared exec tsc --noEmit

# ЩО ЗАПУСКАТИ — каже селектор (AUTO). Він дивиться і в api, і в web, тож червоний
# web-тест не лишиться невидимим, як бувало при запуску лише @sto/api.
python scripts/affected-tests.py            # робоче дерево; для діапазону: --base <sha>
# → виконати надруковані команди API / WEB / E2E як є (E2E йде на власному сервері :3002,
#   dev-сервер :3001 не чіпати). Рядки «ІНШЕ:» — теж команди до виконання (тест селектора,
#   гейти, `cd packages/shared && npx vitest run`), а не довідка.
#   · Команди з `&&` — для Git Bash; у Windows PowerShell 5.1 `&&` — помилка парсера.
#   · Вердикт: `<команда> 2>&1 | bash ../../scripts/verdict.sh "мітка"` (після `cd apps/…`
#     шлях до скрипта вже відносний). `--reporter=json` підсумку не друкує → «НЕ РОЗПІЗНАНО».
#   · Поки йде Playwright — не правити `apps/api/src` і `packages/shared`: `nest --watch`
#     перезапустить API, і globalSetup впаде з `ECONNREFUSED 127.0.0.1:3000`.
#   · Після E2E повернути `apps/web/next-env.d.ts` на `.next` (docs/GOTCHAS.md, 2026-10-07).
# «ПОВНИЙ ПРОГІН ПОТРІБЕН: так» АБО режим FULL → повні набори:
#   pnpm --filter @sto/api test --run 2>&1 | tail -30
#   pnpm --filter @sto/web exec vitest run 2>&1 | tail -10

# Scope (AUTO: тільки змінені файли; FULL: весь проєкт)
git diff HEAD --name-only | head -30
cat MemoryManual.md | head -50
```

**Визнач агрегати зі scope → читай відповідні дос'є (бізнес-правила для тест-кейсів):**

| Ключові слова у змінених файлах   | Читати                                                           |
| --------------------------------- | ---------------------------------------------------------------- |
| `work-order`, `WorkOrder`         | `docs/objects/work-order.md` (FSM transitions + side-effects)    |
| `invoice`, `Invoice`              | `docs/objects/invoice.md` (from-work-order flow, calcVatTotals)  |
| `purchase-order`, `PurchaseOrder` | `docs/objects/purchase-order.md` (receive() invariants)          |
| `stock-document`, `StockDocument` | `docs/objects/stock-document.md` (type→movement map)             |
| `counterpart`, `Counterparty`     | `docs/objects/counterparty.md` (isPrimary promote)               |
| `good`, `Good`                    | `docs/objects/good.md` (pricing hierarchy, GoodUoM guard)        |
| `work`, `Work`, `WorkCategory`    | `docs/objects/work.md`                                           |
| `calendar`, `CalendarSlot`        | `docs/objects/calendar.md` (split-day invariant, conflict check) |
| `stock-item`, `StockMovement`     | `docs/objects/inventory.md` (createMovement only)                |
| `settlement`, `transaction`       | `docs/objects/settlements.md` (createTransaction only)           |

Дос'є містять **бізнес-інваріанти** — саме їх порушення і є багами, які треба шукати.

TS або unit (API **і** web) червоні → зафіксуй як Bug #0, виправ ПЕРШИМ. Червоний baseline-тест (навіть не зачеплений scope-коммітами) — release-blocker: ховає регресії за шумом і блокує наступні сесії.

**ОБОВ'ЯЗКОВО: перевірити `[x]`-маркери попередніх сесій проти реального стану файлів.**
Попередня сесія могла позначити баги `[x] виправлено`, але закомітити лише docs (`MemoryManual.md`/`BUG_REPORT.md`) — фікси у коді відсутні. `[x]` без парного diff = хибно-зелений, гірший за відкритий баг (приховує блокер).

```bash
# Для кожного нещодавнього [x]-бага у BUG_REPORT.md що згадує конкретний файл:рядок —
# перевірити чи фікс РЕАЛЬНО у файлі (не довіряти статусу).
git log --oneline -5 --stat   # останній "fix(tester)" commit змінив код, чи лише *.md?
# якщо останній tester-commit чіпає ТІЛЬКИ MemoryManual.md/BUG_REPORT.md → фікси не застосовані
grep -n "Статус.*\[x\]" BUG_REPORT.md | tail -10   # звірити кожен з grep по реальному файлу
```

Якщо `[x]`-баг не виправлений у коді → переклас на відкритий, виправити РЕАЛЬНО, додати meta-bug про хибний маркер.

**ОБОВ'ЯЗКОВО після route group / app router рефакторингу — очистити `.next/` cache (Bug #291)**

Будь-який commit що рухає сторінки між route-group folders у Next.js App Router (`app/X/page.tsx` → `app/(group)/X/page.tsx`) інвалідує `apps/web/.next/` dev-cache: webpack chunk-id-и зберігаються у `webpack-runtime.js` як числа (`./726.js`), а нова структура має інші chunk-id-и → старий `webpack-runtime.js` шукає файл якого нема → CRITICAL 500 на ВСІХ chunks → React не гідрується → ніяких client-side guards (TopShell auth redirect, AuthProvider, useRequireAuth) не виконуються. TS green, unit tests green, але живий dev server повертає `<html>` без JS — користувач застряг на захищеному URL без auth.

```bash
# Detect route group rename pattern у diff:
git diff HEAD~5 HEAD --name-status | grep -E "^R.*app/.*[/(].*/.*page\.tsx"

# Або просто перевірити чи були переміщення з/в route-group folders:
git log -1 --stat HEAD~5..HEAD | grep -E "app/\{ =>|app/.* => app/\("

# Якщо знайдено rename pattern — ОБОВ'ЯЗКОВО:
test -d apps/web/.next && rm -rf apps/web/.next apps/web/tsconfig.tsbuildinfo

# Перезапустити web dev server (порт 3001) перед запуском E2E
# Перевірити що chunks повертають 200:
curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/_next/static/chunks/main-app.js
# Якщо 500 — cache не очистився, retry rm + restart
```

- [ ] Route group rename detected у `git diff HEAD~N HEAD --name-status` → `rm -rf apps/web/.next` ПЕРЕД будь-якими TS/unit/E2E запусками. Інакше E2E падатиме з помилковим повідомленням (`expected /\/(login|setup)/, got /work-orders/`) яке маскує справжню проблему (webpack chunk 500). Перевірка часта і дешева.
- [ ] **E2E `toHaveURL(/…$/)` end-anchor без слеша у застосунку з `trailingSlash: true` (Bug #770):** новий tab-shell/wizard-тест на «повернення до default-tab / скидання `?tab=`» падає бо реальний canonical URL завжди `/<route>/` (слеш), а регекс `…<name>$` ніколи не матчить. Це STALE TEST (продукт коректний), НЕ баг продукту. Grep: `grep -rnE "toHaveURL\(/[^/]*\\$/" apps/web/e2e` при `grep -n "trailingSlash: true" apps/web/next.config.*` = хіт. Fix ТЕСТУ: `/\/route$/` → `/\/route\/$/` (не послаблювати до `\/?` — воно перестане перевіряти скидання query). Бонус: якщо fallback невалідного `?tab=xxx` без E2E — дописати. Підрядкові патерни (`/tab=X/`) безпечні; ризик лише end-anchor. Severity LOW. Деталі: «sto-tester-approaches.md» 2026-09-21 (Bug #770).

**AUTO: матриця що перевіряти за типом зміни**

| Тип зміни                      | Секції Кроку 1                                                            |
| ------------------------------ | ------------------------------------------------------------------------- |
| Новий `@Controller` / endpoint | §1.1 (tenant, soft delete), §1.2 (TS, API contract), §1.5 (contract spec) |
| Змінений `*.service.ts`        | §1.1 (business logic, FSM, inventory, settlements)                        |
| Нова `page.tsx` / зміна UI     | §1.3 (frontend стани, hydration, routing)                                 |
| Новий `*.dto.ts`               | §1.2 (validation guards, @IsUUID версія)                                  |
| `prisma/schema/*.prisma`       | §1.1 (soft delete fields, orgId), §1.2 (TS)                               |
| `components/ui/` only          | §1.3 (стани), §1.6 (a11y)                                                 |
| `hooks/**`, `lib/**` (web)     | §1.3                                                                      |
| BullMQ processor / scheduler   | §1.1, §1.2                                                                |
| Інше в `apps/api/src`          | §1.1, §1.2 — краще зайва секція, ніж жодної                               |
| Інше в `apps/web/src`          | §1.3                                                                      |
| Config / docs / тести          | §0 (tsc) — більше нічого                                                  |

---

## Спец-модель: тест шукається через дос'є (ОБОВ'ЯЗКОВО)

> Повна інструкція — `/sto-spec`. Тут лише те, що потрібно на цьому кроці.

1. **Знайти тест.** Агрегат → `docs/objects/<entity>.md` → секція «Аспекти і тести, що їх
   стережуть». Правиш один аспект — ганяєш ОДИН файл:
   `cd apps/api && npx vitest run src/modules/<mod>/<mod>.<аспект>.spec.ts`
2. **Додати тест.** В аспектний файл `<mod>.<аспект>.spec.ts`; `<mod>.service.spec.ts` НЕ
   створювати. Нове правило → `BR-XXX-NNN` у дос'є. Новий спек-файл → рядок у реєстрі дос'є.
3. **Після будь-якої зміни тестів — три гейти** (втрата кейсів · моноліти · реєстр):

   ```bash
   cd apps/api && npx vitest run --reporter=default --reporter=json --outputFile=.vitest-report.json
   python ../../scripts/check-spec-registry.py --from-report .vitest-report.json
   ```

   Гейт A каже «зник кейс» → тест утрачено: повернути його, а НЕ оновлювати baseline, щоб
   позеленити. Baseline оновлюється лише коли кейс додано/перейменовано свідомо:
   `python ../../scripts/spec-baseline.py .vitest-report.json --out test-baseline.json`
   — і його diff іде в той самий коміт.

4. **Вердикт** — лише `scripts/verdict.sh`; **цифра** — лише `scripts/measure.sh`.
5. **Що запускати для diff-у** — не вгадувати і не ганяти все: `python scripts/affected-tests.py`
   (діапазон: `--base <sha>`) друкує готові команди API / WEB / E2E / ІНШЕ. Повний прогін — лише
   коли скрипт сам каже «ПОВНИЙ ПРОГІН ПОТРІБЕН: так».

> **Межі цього блоку.** Через дос'є знаходяться лише спеки агрегатів —
> `apps/api/src/modules/<mod>/`. Інфраструктурні спеки (`src/prisma/*`, `src/common/*`),
> web-тести й E2E у реєстрах не названі — їх знаходить селектор із п. 5 (граф імпортів і
> маршрути), а не дос'є. Гейт A стереже лише api (`test-baseline.json`); web-тести не
> стереже жоден із трьох гейтів. `--gate-size` на успіху друкує `0 passed (0)` — це
> «монолітів 0», а не «нічого не перевірено».

## Крок 1 — Статичний аналіз (збір багів)

> AUTO: аналізуй ТІЛЬКИ файли з `git diff HEAD --name-only`.
> FULL: повний аналіз всіх секцій.

Кожен знайдений баг → запиши в BUG_REPORT.md (Крок 2 — шаблон нижче).

---

Чекліст кожної секції лежить в окремому файлі-переліку. За матрицею AUTO (Крок 0) визнач
потрібні § і прочитай **цілком** їхні переліки (кожен влазить в один Read). Довгі пункти там
стоять заголовком із кодом `T1.N-NNN`; повний текст обраних дістається з `journal/` однією
командою (вона наведена на початку кожного переліку). Решту секцій у режимі AUTO не читати.

| §    | Перелік (читати цілком)                   | Повні тексти (вибірково) | Пунктів                |
| ---- | ----------------------------------------- | ------------------------ | ---------------------- |
| §1.1 | `sections/s1-1-backend-logic.md`          | `journal/details-1-1.md` | 111 (з них 78 — кодом) |
| §1.2 | `sections/s1-2-api-quality.md`            | `journal/details-1-2.md` | 27 (з них 21 — кодом)  |
| §1.3 | `sections/s1-3-frontend.md`               | `journal/details-1-3.md` | 56 (з них 50 — кодом)  |
| §1.4 | `sections/s1-4-security.md`               | `journal/details-1-4.md` | 8 (з них 3 — кодом)    |
| §1.5 | `sections/s1-5-test-coverage-backend.md`  | `journal/details-1-5.md` | 18 (з них 13 — кодом)  |
| §1.6 | `sections/s1-6-test-coverage-frontend.md` | `journal/details-1-6.md` | 17 (з них 14 — кодом)  |
| §1.7 | `sections/s1-7-a11y-i18n.md`              | `journal/details-1-7.md` | 7 (з них 1 — кодом)    |

---

## Крок 2 — Фіксація в BUG_REPORT.md

Записуй **зразу після аналізу**, до виправлень:

```markdown
# BUG_REPORT.md — STO ERP

Дата: YYYY-MM-DD
Сесія: <коротко що тестувалось>

---

## Bug #N — [CRITICAL|HIGH|MEDIUM|LOW] Заголовок

**Файл:** `apps/api/src/modules/X/X.service.ts:145`
**Severity:** CRITICAL | HIGH | MEDIUM | LOW
**Категорія:** business-logic | security | typescript | frontend | test-coverage

**Опис:** Що не так і чому це баг.
**Очікувана поведінка:** Що має бути.
**Фактична поведінка:** Що є зараз.
**Статус:** [ ] відкритий / [x] виправлено
```

**Severity:**

- `CRITICAL` — втрата даних, неправильні фінанси, cross-tenant витік
- `HIGH` — порушення бізнес-правила (FSM, резерви), security
- `MEDIUM` — TypeScript помилка, відсутній тест критичної гілки
- `LOW` — UI стан (loading/empty), незручність

---

## Крок 3 — Автоматичне виправлення

```
Для кожного Bug #N (від CRITICAL до LOW):
  1. Прочитай файл з багом
  2. Застосуй мінімальний точковий фікс (не рефактор)
  3. pnpm --filter <package> exec tsc --noEmit → 0 errors
  4. Якщо відсутній тест → додай кейс у .spec.ts
  5. Відмітити [x] у BUG_REPORT.md
  6. git add <змінені файли> && git commit -m "fix(tester): Bug #N — <заголовок>"

Після останнього Bug:
  7. Оновити MemoryManual.md — одразу, без запиту
```

**Правила:**

- Мінімальний diff — не чіпай нічого крім проблемного місця
- Фікс потребує міграції БД → CRITICAL, повідоми користувача
- Фікс потребує змін у `@sto/shared` → оновлюй синхронно

---

## Крок 4 — Верифікація

```bash
# TypeScript — 0 errors
pnpm --filter @sto/api exec tsc --noEmit
pnpm --filter @sto/web exec tsc --noEmit --incremental false
pnpm --filter @sto/shared exec tsc --noEmit

# Тести — ті самі команди селектора, що й на Кроці 0 (після фіксів diff міг вирости,
# тому скрипт запускається ЗАНОВО, а не береться старий вивід)
python scripts/affected-tests.py

# Build
pnpm --filter @sto/api build 2>&1 | tail -10

# Contract тести
pnpm --filter @sto/api test --run --reporter=verbose 2>&1 | grep -E "contract|PASS|FAIL"
```

---

## Крок 5 — Розширені тести (лише режим FULL)

У режимі AUTO пропустити. У режимі FULL — прочитати `sections/step5-full-mode.md` і виконати.

---

## Крок 6 — Commit + MemoryManual.md

```bash
git add apps/ packages/ BUG_REPORT.md
git commit -m "fix(tester): <короткий підсумок всіх багів>"
```

Оновити `MemoryManual.md`:

```markdown
## Останній commit

<hash> fix(tester): <message>
Дата: YYYY-MM-DD
Latest tester: YYYY-MM-DD (<режим>, HEAD <hash>) — <N> баги: <перелік>.

## Поточний стан проєкту

TypeScript: ✅ 0 errors
Unit+Contract: ✅ N/N passed
Property-based: ✅ N passed (або ⏭ fast-check не встановлений)
Components: ✅ N passed (або ⏭ @testing-library не встановлений)
E2E (Playwright):✅ N passed (або ⏭ Playwright не встановлений)
```

---

## Крок 7 — Самовдосконалення (ОБОВ'ЯЗКОВО після кожного запуску)

Після виправлення кожного Bug #N — запитай себе:

> **"Цей баг передбачений існуючим пунктом §1.1–§1.7?"**

Якщо **НІ** — одразу оновити скіл:

1. Додати новий пункт у відповідний розділ SKILL.md (§1.1–§1.7) з grep-командою
2. Записати підхід у **`journal/approaches-YYYY-MM.md`** поточного місяця (найновіше зверху, формат нижче)
3. Commit: `docs(skills): add <баг> to sto-tester checklist`

**Що записувати:**

- Новий **тип бага** якого не було в чеклісті
- Новий **grep-сигнал** для автовиявлення
- **Причину** чому баг виникає (щоб знати де шукати наступного разу)
- **Severity** для калібрування пріоритетів

**Не записувати:** конкретні файли/рядки (вони змінюються); ready-made фікси (для цього є Крок 3).

### Формат запису

```
### [Дата] — [Тип бага] — [Область: backend / frontend / db / security]

**Сигнал:** ознака за якою баг можна знайти або відтворити
**Причина виникнення:** типова помилка розробника або edge case
**Підхід до виявлення:** загальний принцип пошуку (не grep, не файл)
**Підхід до фіксу:** загальний принцип виправлення
**Severity:** CRITICAL / HIGH / MEDIUM / LOW
**Де шукати ще:** суміжні модулі де той самий патерн може повторитись
```

---

## Накопичені підходи → окремий файл

> Журнал накопичених патернів багів винесено у **`journal/approaches-YYYY-MM.md`** (структурний split, TD3 —
> був ~2575 рядків, 68% файлу). Читай його ЗА ПОТРЕБОЮ: перед статичним аналізом (Крок 1), щоб звірити
> чи знайдений баг уже описаний, і на Кроці 7, щоб дописати новий патерн.
>
> `→ дивись journal/approaches-*.md` — формат запису (Сигнал/Фікс/Severity/Де ще) і всі bug-номери там.

---

Журнал розкладено за місяцями: `journal/approaches-YYYY-MM.md`. Цілком не читати — шукати:
`grep -n "<ключове слово>" .claude/skills/sto-tester/journal/approaches-*.md`. Новий запис —
у файл поточного місяця (зверху). Новий пункт чекліста — у перелік секції (довгий: текст у
`journal/details-1-N.md` з наступним вільним кодом, у перелік — рядок-заголовок із цим кодом).

## Що вже перевірено (не дублювати)

**Backend:** ✅ FSM transition map (work-orders.fsm.ts) · InventoryService guards (quantity=0, available<qty, RESERVATION_RELEASE) · SettlementsService guards (CHARGE↑, PAYMENT↓) · Soft-delete всі основні сервіси · Resurrection pattern (currencies, exchange-rates, brands, units, payment-methods) · Org-scoped FK validation перед write (goods brandId/unitId/preferredSupplierId #161, invoices/work-orders clone #90) · $transaction explicit timeout (всі interactive callbacks) · ParseUUIDPipe (всі :id) · Security headers (@fastify/helmet@11) · SSRF guard webhooks.processor (validatePublicUrl+redirect:'manual') · ArrayMaxSize (inspection.dto, webhook payload) · Deploy phase18: docker api healthcheck node-http /api/health (#164/#165), minio `mc ready local`+пін RELEASE (#170), root .dockerignore (#166), build-prod.ps1 export→apps/web/out+$PSScriptRoot fallback (#167), nginx \_next/static immutable+gzip_types svg/js (#168), /api/health публічний. minio/minio=лише mc (перевірено емпірично).

**Frontend:** ✅ cancelled flag (AuthProvider, всі mount-fetches) · SSR-safe today (useState(null)+useEffect) · apiFetch error array join · UUID validation client-side · aria-label на іконкових кнопках · React named imports · React Query Sprint B: QueryClient singleton (staleTime 30s, retry 1, refetchOnWindowFocus false), 5 query hooks (workOrders/invoices/counterparties/inventory/purchaseOrders) з queryKey factory, cross-resource invalidation (PO receive→inventory, PO apply-pricing→inventory, work-orders create→workOrders #210-#212), useWorkOrders.test.tsx як зразок (12 кейсів).

**Tests:** ✅ Contract specs: auth, work-orders, warehouses, counterparties, sync, settings, audit, pricing-rules, batches, currencies, bank-accounts, exchange-rates, cash-registers, calendar (GET/POST/PATCH/DELETE resize/drag) · Service specs (query-shape): goods (FK), counterparties (?q= plural customerGarages→vehicles #163), work-orders (findAll calendarSlots plural+take:1+deletedAt+orderBy asc; ?q= counterparty nested; employeeId some soft-delete #171) · Pricing: COST_TIER tier matching, brandId priority over goodType (#179) · Calendar timeline px→time clamp усі гілки; isEditingPast minHour-boundary · Property-based invariants: inventory, settlements, FSM (26 invariants) · Component tests: 148/148 (14 файлів) · E2E: 42/42 (smoke, console-errors serial, inventory, api-errors).
