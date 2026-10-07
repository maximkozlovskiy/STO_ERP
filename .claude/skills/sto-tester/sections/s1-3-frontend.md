# sto-tester — §1.3 — Frontend (Next.js)

> Частина скіла `sto-tester`. Алгоритм і матриця — у `../SKILL.md`.
> Це ПОВНИЙ перелік пунктів секції: короткі — дослівно, довгі — заголовком із кодом
> `T1.3-NNN`. Прочитай файл цілком, познач пункти, що стосуються diff-у, і дістань їхній
> повний текст (сигнал, grep-детектор, фікс) із `../journal/details-1-3.md`:
>
> ```bash
> awk '/T1.3-(007|012) -->/{f=1;next} /<!-- T1\./{f=0} f' .claude/skills/sto-tester/journal/details-1-3.md
> ```

### §1.3 — Frontend (Next.js)

> **Фронтенд-пункти, що лежать в інших секціях** (матриця для `page.tsx`/хука їх не призначає —
> переглянь заголовки й там): §1.1 — `T1.1-011`, `-012`, `-021`, `-037`, `-039`, `-040`;
> §1.2 — `T1.2-013`, `-015`, `-018`, `-019`, `-020`, `-021`.

```bash
# Bug #567 — E2E sessionStorage не restored Playwright-ом: будь-який рефактор
# AuthProvider або setup-auth.ts може непомітно зламати E2E auth state.
# Перевірити обидві сторони escape-hatch:
grep -n "sto_e2e_skip_refresh\|sto_e2e_access_token" apps/web/src/lib/auth/context.tsx
# Має бути 2+ matches (reducer init copy + useEffect skip)
grep -n "sto_e2e_skip_refresh\|sto_e2e_access_token" apps/web/e2e/setup-auth.ts
# Має бути 2+ matches (write skip_refresh + write access_token mirror)
# Якщо хоч в одному файлі 0 — E2E зламається на 100% тестів (всі побачать login)

# Bug #506/#510 — Дублюючі interface declarations (hook vs PageClient inline)
# Кожен дубльований тип = ризик дрейфу при додаванні нового поля у бекенді.
grep -rEn "^interface (WorkOrder|Invoice|Counterparty|Vehicle|Good|Warehouse|Employee) " apps/web/src --include="*.ts*"
# Якщо >1 match для одного імені — перевірити що локальний дублікат містить всі поля з hook.

# .catch(() => {}) на fetch — ховає помилки
grep -rn "\.catch(() => {})" apps/web/src/app --include="*.tsx"

# loading оголошений але setLoading(true) відсутній
grep -rn "const \[loading.*false" apps/web/src/app --include="*.tsx" | head -10
# → для кожного перевірити чи є setLoading(true) перед fetch

# cancelled flag відсутній
grep -rn "useEffect" apps/web/src/app --include="*.tsx" -A 10 | grep "apiFetch\|apiMultipartFetch" | grep -v "cancelled\|mounted" | head -10

# Async-init Select race
grep -rn "value=\{form\." apps/web/src/app --include="*.tsx" | grep -v "//\|onChange" | head -20
# Для кожного — перевірити що опції завантажуються async і є sync useEffect автовибору

# SSR-safe date (new Date() у render = hydration mismatch)
grep -rn "new Date()\|Date\.now()" apps/web/src/app --include="*.tsx" | grep -v "useEffect\|getTime\|setDate\|//\|spec" | head -10

# key={i} у списках з filter/sort
grep -rn "key={i}\|key={index}" apps/web/src/app --include="*.tsx" | head -10

# apiFetch у PUBLIC_ROUTES сторінках (public pages мають publicFetch)
grep -rn "apiFetch\|apiBlobFetch" apps/web/src/app --include="*.tsx" | grep -E "booking|setup" | head -5

# Bug #606 — guard-order у click-shortcut «add-to-collection» helper: limit/permission-guard кидає toast на ПОВТОРНИЙ клік по вже-активному елементу.
# Для будь-якого helper типу addToZone/addToList/pushToSelection — перевірити що includes/has() коротшить ПЕРЕД limit/permission.
grep -rEn "\.includes\(key\)|\.has\(key\)|\.some\(.*===\s*key" apps/web/src --include="*.tsx" -B 3 -A 3 | grep -B 4 -A 2 "toast\.warning\|toast\.error" | head -60
# Для кожного match: якщо limit-check/permission-check стоїть ВИЩЕ за unique-check → повторний клік по вже-активній кнопці кине misleading toast.
# Правильно: `if (list.includes(key)) return;` — ПЕРШИМ, ЛИШЕ ПОТІМ `if (list.length >= LIMIT) return toast(...)`.

# Bug #620 — форматер шукає тип поля у `columns` list але поле може бути ВНЕ columns
# (aggregation-only, footer-only, computed metric) → fallback на fmtMoney/String → візуальний баг.
grep -rEn "cols\??\.find\(.*key\s*===|columns\.find\(.*key\s*===" apps/web/src --include="*.tsx" -B 2 -A 6 | head -40
# Для кожного match — перевірити:
# 1. Чи можливий сценарій де fieldKey ВНЕ cols/columns (агрегати, footer totals)?
# 2. Чи backend response має ще один array з type/label (aggregations, metrics)?
# 3. Якщо так — форматер має шукати спочатку у ньому, fallback на cols.

# React.X без named import
grep -rn "React\.\(ReactNode\|CSSProperties\|ChangeEvent\|MouseEvent\|FormEvent\)" apps/web/src/ --include="*.tsx" | grep -v "//\|spec" | head -10

# Timeline/drag px→time converter без clamp у видиме вікно → Invalid Date (Bug #157)
grep -rn "decimalHoursTo\|pxToHours\|pxToDecimal\|clientX.*-.*rect\|getBoundingClientRect" apps/web/src/app --include="*.tsx" -l | head -10
# → для кожного timeline/calendar/gantt: чи resize/drag clamp-ить результат у [WINDOW_START, WINDOW_END] ПЕРЕД new Date()
grep -rn "new Date(\`\${.*}T\${\|toISOString()" apps/web/src/app --include="*.tsx" | grep -iE "calendar|timeline|slot|gantt|schedule" | head -10

# Swallowed-fetch що годує ОБОВ'ЯЗКОВИЙ select / disabled-guard (Bug #159) — escalate severity
grep -rn "\.catch(() => {})" apps/web/src/app --include="*.tsx" -B3
# → для кожного: чи setX(...) у .then() рендериться у <Select required> АБО у disabled={!state}?
#   якщо так — порожня помилка блокує workflow без feedback (MEDIUM, не LOW)

# Bug #401: FE canShare/canEdit/canDelete асиметричний з backend X_STATUSES константою
# (FE масив ⊂ BE → silent UX обмеження; FE ⊃ BE → false promise → 400).
grep -rnE "const can(Share|Edit|Delete|Reserve|Transition)\s*=" apps/web/src --include="*.tsx" --include="*.ts" | head -10
# Для кожного match — знайти відповідну backend константу:
grep -rnE "(SHAREABLE|EDITABLE|DELETABLE|RESERVATION_ACTIVE)_STATUSES\s*[:=]" apps/api/src/modules --include="*.ts"
# Звірити масиви: BE — single source of truth, FE має бути дзеркальним підмножиною (або тотожним).

# Bug #728: новий тип discriminated-union / enum доданий у backend Zod + read-модель + labels,
# але WRITE-форма (create/edit модалка) його НЕ підтримує → значення недоступне користувачу.
# Сигнал: backend `z.discriminatedUnion('type', [...])` / enum має N варіантів, а форма-білдер
# (buildRateScheme / buildX / EMPTY_FORM / <Select> опції) — менше.
# Крок 1: порахувати варіанти у backend union/enum:
grep -rnE "z\.literal\('|z\.enum\(\[" apps/api/src/modules --include="*.dto.ts" | grep -iE "type|scheme|kind|mode" | head -20
# Крок 2: для КОЖНОГО union/enum знайти write-форму (модалку) що його будує:
grep -rnE "build[A-Z][A-Za-z]*Scheme|EMPTY_FORM|rateType|===\s*'(percent_normo|per_normo_hour|fixed_plus_bonus)'" apps/web/src/components --include="*.tsx" | head -20
# Звірити: чи форма має гілку + input + label + edit-гідрацію для ВСІХ backend-варіантів?
# Пропущений варіант = HIGH (нова можливість фічі недоступна з UI; edit наявного губить тип).
# 4 місця мають бути оновлені разом: LABELS-мапа, EMPTY_FORM поле, edit-гідрація (читання rs.params.*),
# build-функція (гілка+валідація), JSX-input. Пропуск будь-якого = мовчазний write-path gap.

# Bug #729: query-хук фаєрить роль-обмежений GET, бо `enabled` не гейтиться роллю
# (UI-видимість кнопки/вкладки/модалки гейтнули, а сам data-fetch — ні → фонове 403 × retry).
# Сигнал: компонент видимий нижчій ролі (вкладка/сторінка з roles включає RECEPTIONIST/MECHANIC),
# але викликає useQuery-хук БЕЗ enabled-гейта до ендпоінта, чий backend @Roles вимагає вищу роль.
# Крок 1: знайти безумовні query-хуки у компонентах з рольовим prop (canOperate/canManage/canEdit):
grep -rnE "use[A-Z][A-Za-z]*\(\)" apps/web/src/app --include="*.tsx" | grep -vE "enabled|useState|useRef|useMemo|useAuth|useRouter|useSearchParams|useEffect|useCallback|useContext" | head -20
# Крок 2: для компонента з canOperate/canManage/canX — для КОЖНОГО query-хука звірити @Roles ендпоінта:
grep -rn "canOperate\|canManage\|canEdit\|canView" apps/web/src/app --include="*.tsx" -l | head
grep -rnE "@Roles\('OWNER'" apps/api/src/modules --include="*.controller.ts" | grep -vE "RECEPTIONIST|ACCOUNTANT" | head -20
# Якщо хук б'є ендпоінт де RECEPTIONIST відсутній у @Roles, а компонент видимий RECEPTIONIST → 403-fetch.
# Fix: додати `enabled`-параметр у хук + передати рольовий prop (`useX(false, canOperate)`).
# Live-доказ: DB-flip ролі (`employee.role=RECEPTIONIST`) → login → curl ендпоінт → 403 = баг.
# Регресія: component-тест мокає хук і асертить `toHaveBeenCalledWith(..., canOperate)` для обох гілок.

# Bug #752: derived-лічильник/індикатор рахує ІНШИМ предикатом, ніж action-фільтр →
# оманливе UX + увімкнена дія, що no-op-ить (toast «нічого нема» попри N обраних).
# Патерн: `<count>Count = items.filter(<predicate-A>).length` показується користувачу
# («Обрано: N»), а submit-handler збирає payload через СТРОГІШИЙ <predicate-B>
# (`if (!row.selectedId) continue` / `if (!name) continue` / скіп ambiguous без вибору).
# Кнопка disabled лише за `<count>Count === 0` (predicate-A) → активна коли predicate-B дає 0.
# Сигнал: handler-цикл з кількома `continue`, а лічильник/`disabled` дивиться лише перший.
grep -rnE "\.filter\(\w+ => \w+\??\.(included|selected|checked|active)" apps/web/src --include="*.tsx" | head -20
# Для КОЖНОГО filter-лічильника знайти submit-handler цього ж компонента:
grep -rnE "for \(const \w+ of \w+\)" apps/web/src/components --include="*.tsx" -A 12 | grep -E "continue;" | head -20
# Якщо handler має continue-и (skip ambiguous без товару / notFound без назви / !selectedId),
# яких predicate-лічильника НЕ враховує → лічильник бреше + disabled-guard дірявий.
# Fix: винести спільний `isRowApplyable(row,res)` predicate → лічильник, handler і disabled
# використовують ОДНЕ джерело правди; показати readyCount окремо коли != includedCount.
# Регресія: ambiguous-included-без-товару / notFound-порожній → «до імпорту: 0», кнопка disabled, POST 0×.

# Мертвий стан/handler після рефактору inline→shared-component (Bug #160)
# для кожного useState/useCallback з префіксом фічі (woSearch/woOptions...) перевірити чи setter
# викликається ПОЗА reset-ефектом і чи value читається у JSX. tsc без noUnusedLocals НЕ ловить.
grep -rn "const \[\(wo\|cp\|search\|inline\)[A-Za-z]*," apps/web/src/app --include="*.tsx" | head -20

# apiFetch generic type mismatch — fetch<T[]> але endpoint повертає {items,total} (Bug #181)
# Стандарт STO ERP list endpoint = { items, total }. Виняток: /branches = bare array.
# Шукати apiFetch<X[]> де X — не пагінований примітив; перевірити контролер.
grep -rn "apiFetch<[A-Za-z]*\[\]>" apps/web/src/app --include="*.tsx" | grep -v "//\|spec" | head -20
# → для кожного: прочитати controller.ts endpoint — повертає масив чи {items,total}?
# Known bare-array endpoints: /branches (fbe66ad — спеціальний випадок, довідник)
# Known {items,total} endpoints: /brands, /goods, /pricing-rules, /work-orders, /invoices, /counterparties, ...

# FormData надсилається через apiFetch (а не apiMultipartFetch) → CRITICAL (Bug #197) — фіча мертва
# apiFetch ЖОРСТКО ставить Content-Type: application/json → browser НЕ може автоматично виставити multipart boundary
# → fastify-multipart кидає "the request is not multipart" → upload завжди валиться
grep -rn "apiFetch\b.*body:\s*\(fd\|formData\|new FormData\)" apps/web/src --include="*.tsx" | head -10
grep -rn "body: \(fd\|formData\)" apps/web/src --include="*.tsx" -B3 | grep -E "apiFetch\b" | head -10
# → кожен match — обов'язково замінити на apiMultipartFetch

# Next.js App Router error.tsx з bare `error: Error` без `& { digest?: string }` (Bug #206)
# Docs: https://nextjs.org/docs/app/api-reference/file-conventions/error
grep -rn "error.*:\s*Error[^&]" apps/web/src/app --include="error.tsx" | grep -v "digest" | head -5

# Нова browser-API залежність без jsdom-стабу (Bug #177) → каскадне падіння всіх тестів які монтують shared-компонент
# tsc мовчить (типи в lib.dom.d.ts), prod працює (браузер має API), jsdom — НІ.
grep -rnE "new (ResizeObserver|IntersectionObserver|MutationObserver|PerformanceObserver)\(|window\.matchMedia\(|navigator\.(clipboard|share|wakeLock|geolocation|mediaDevices)|crypto\.subtle|new Notification\(" apps/web/src/components/ui apps/web/src/app --include="*.tsx" -l | while read f; do
  # для кожного знайденого API — перевірити чи setup.ts його стабає
  for api in ResizeObserver IntersectionObserver MutationObserver PerformanceObserver matchMedia; do
    if grep -q "$api" "$f" && ! grep -q "$api" apps/web/src/__tests__/setup.ts; then
      echo "JSDOM STUB MISSING: $f uses $api but apps/web/src/__tests__/setup.ts does not stub it"
    fi
  done
done

# Bug #630 — concurrent double-submit у create-модалці: submit-handler захищений ЛИШЕ
# `disabled={saving}` без синхронного savingRef-guard першим рядком.
# `disabled` спирається на re-render React МІЖ подіями кліку → два click-и в одному tick
# (швидкий double-click / синтетичні події / Enter-repeat) обидва входять до застосування
# disabled → 2 POST → 2 документи. Idempotency-ref (createdIdRef/createdInvoiceRef) НЕ рятує
# (виставляється лише ПІСЛЯ await першого POST — другий click вже пройшов).
grep -rln "const handleCreate\|const handleSave\|const create =\|const save = async\|const update = async\|async function handleCreate" apps/web/src/components/ui --include="*Modal.tsx" | while read f; do
  # модалка має savingRef АБО лише disabled={saving}? і чи save/create-handler гейтить на savingRef?
  if grep -qE "setSaving(Both)?\(true\)" "$f" && ! grep -qE "if \(saving(Ref|_?ref)?\.current" "$f"; then
    echo "DOUBLE-SUBMIT RISK (no savingRef guard at all): $f"
  fi
done
# КОВЕРІДЖ: перевіряти НЕ ЛИШЕ великі документні модалки, а Й edit-модалки довідників
# (Counterparty/Employee/Good/Unit/Brand/Category). Bug #632-#634: submit-кнопка
# `<Button onClick={save} loading={saving} disabled={!field}>` — `disabled` БЕЗ saving →
# гейт лише async (loading через re-render), same-tick race незахищений → дубль master-data.
grep -rln "loading={saving}" apps/web/src/components/ui --include="*Modal.tsx" | while read f; do
  # кнопка має loading={saving} але disabled БЕЗ saving/loading і немає savingRef → vulnerable
  if grep -qE "disabled=\{![^}]*\}" "$f" && ! grep -qE "if \(saving(Ref)?\.current" "$f"; then
    echo "DOUBLE-SUBMIT RISK (loading-only gate, no sync ref): $f"
  fi
done
# Точніша перевірка (ручна): для КОЖНОГО create/save async-handler переконатись, що ПЕРШИЙ
# рядок = `if (savingRef.current [|| transitioningRef.current]) return;` ПЕРЕД будь-яким await.
# Модалка може мати savingRef і використовувати його у edit/transition-handler, АЛЕ забути у create.
```

- [ ] Concurrent double-submit у create/save-модалці (Bug #630, #632-#634) — `T1.3-001`
- [ ] Multi-request submit — per-row idempotency, не лише per-header (Bug #755, HIGH/гроші) — `T1.3-002`
- [ ] Кожен list-fetch в `useEffect` має: `let cancelled=false` + `return () => {cancelled=true}`; `setLoading(true)` перед; `.finally(() => !cancelled && setLoading(false))`; `.catch((e) => !cancelled && setError(...))`; у JSX `{loading && <Spinner/>}` + `{!loading && items.length===0 && <Empty/>}`
- [ ] `new Date()` у render path → `useState<Date|null>(null)` + `useEffect(() => setToday(new Date()), [])`
- [ ] `key={i}` у списках де можлива re-order/filter → `key={item.id}` або stable derived key
- [ ] PUBLIC_ROUTES (`/booking`, `/setup`, `/login`, `/403`) → `publicFetch`, не `apiFetch`
- [ ] `import type { ReactNode, ChangeEvent, MouseEvent } from 'react'` (не `React.ReactNode`)
- [ ] `setTimeout` / `setInterval` у `useEffect` → `clearTimeout` / `clearInterval` у cleanup
- [ ] Timeline/gantt drag/resize: px→години без clamp у вікно → Invalid Date у `toISOString()` — `T1.3-003`
- [ ] Swallowed-fetch що годує **обов'язковий** контрол — `T1.3-004`
- [ ] Swallowed-fetch у read-only panel мапиться у empty-state (Bug #414) — `T1.3-005`
- [ ] FE canX status-whitelist симетричний з backend X_STATUSES (Bug #401) — `T1.3-006`
- [ ] Мертвий стан після inline→shared-component рефактору — `T1.3-007`
- [ ] Next.js App Router convention-файли — точна сигнатура (Bug #206) — `T1.3-008`
- [ ] Decorative SVG/icon без `aria-hidden="true"` (Bug #207) — `T1.3-009`
- [ ] App Router convention-файли з інтерактивом (`useEffect`/`onClick`/`'use client'`) → парний `*.test.tsx` (Bug #208) — `T1.3-010`
- [ ] FormData upload через `apiFetch` замість `apiMultipartFetch` (Bug #197) → CRITICAL — `T1.3-011`
- [ ] React Query cross-resource invalidation audit (Bug #210-#212, повторено у #590) — `T1.3-012`
- [ ] Same-data-другий-namespace invalidation gap: dashboard/summary-віджет читає окремий query-namespace, який мутація ресурсу НЕ чіпає (Bug #718) — `T1.3-013`
- [ ] Новий query-хук ПОХІДНИХ даних (історія/зведення, зібране з чужого ресурсу) зі `staleTime` > 0: перелічити ВСІ місця, що міняють джерело (сторінка без useMutation, модалки створення, інші пристрої), і пройти в браузері шлях «побачив → перейшов за посиланням із цього ж блоку → виправив → Назад». Якщо місць більше, ніж інвалідацій, — `staleTime: 0` (Bug #799)
- [ ] React Query migration completeness: mutation hooks експортовані але не використовуються (Bug #213) — `T1.3-014`
- [ ] React Query custom hook без `*.test.tsx` (Bug #214) — `T1.3-015`
- [ ] Token-guard debouncer: early-return гілка інкрементує reqId (Bug #396) — `T1.3-016`
- [ ] Conflict-check endpoint: parent-context потребує `excludeParentId` (Bug #397) — `T1.3-017`
- [ ] Read-only DTO degraded-form: contract drift (Bug #398) — `T1.3-018`
- [ ] UoM display-vs-base mismatch на submit (Bug #231) — `T1.3-019`
- [ ] Local FE interface ↔ backend ResponseDto field-list symmetry (Bug #434) — `T1.3-020`
- [ ] Mass DTO field migration completeness — include audit (Bug #232) — `T1.3-021`
- [ ] Frontend hint обіцяє backend behavior якого немає (Bug #266) — `T1.3-022`
- [ ] `useState(initializer)` з React Query error як initializer (Bug #278) — `T1.3-023`
- [ ] Prefetch queryKey ↔ page queryKey shape mismatch (Bug #281) — `T1.3-024`
- [ ] Sub-resource default-flag mutation → parent-list staleness (Bug #226-#227) — `T1.3-025`
- [ ] Filter pill chicken-and-egg для soft-delete UI (Bug #295) — `T1.3-026`
- [ ] AbortController у `useEffect` для filter-toggle race (Bug #301) — `T1.3-027`
- [ ] In-flight guard для async-кнопок без overlay-блокування (Bug #303) — `T1.3-028`
- [ ] Input-mask wrapper re-extracts digits from formatted prefix (Bug #369) — `T1.3-029`
- [ ] Toggle-state UI desync: highlight/cursor не gated на enabled-flag (Bugs #310-#311) — `T1.3-030`
- [ ] Dead `/X/new` маршрут у keyboard shortcut / Command Palette (Bug #354) — `T1.3-031`
- [ ] `usePaginatedList` queryKey shape ↔ `xKeys.list()` factory shape mismatch (Bug #355 — Bug #281 шаблон, глибинна варіація) — `T1.3-032`
- [ ] TopShell prefetch payload-shape ↔ page first-mount filter object (Bug #356 — Bug #281 шаблон, sortBy/dateFrom defaults) — `T1.3-033`
- [ ] Imperative `.focus()`/`.scrollIntoView()`/`.select()` на conditionally-rendered ref у click-handler (Bug #386) — `T1.3-034`
- [ ] Non-type-aware name/required guard рахує значення УМОВНО-ПРИХОВАНОГО поля як валідне (Bug #739) — `T1.3-035`
- [ ] Sequential FE mutation chain without rollback on later-step failure (Bug #404) — `T1.3-036`
- [ ] Inline ad-hoc modal/dialog без використання shared `<Modal>` (Bug #408) — `T1.3-037`
- [ ] Hardcoded `0`/`false`/`null` у side-channel mutation що дублює canonical create (Bug #406) — `T1.3-038`
- [ ] `useState` guard у async handler з pending `await` між set і guard-read (Bug #430) — `T1.3-039`
- [ ] `vi.mock(...)` зі shared lib НЕ оновлений після refactor-extract (Bug #429) — `T1.3-040`
- [ ] Behavior-change fix + stale regression-guard який асертить СТАРУ (виправлену) поведінку (Bug #648) — `T1.3-041`
- [ ] `setX(value)` викликається, але `x` не читається у JSX (Bug #497, sub-patern Bug #160) — `T1.3-042`
- [ ] `mutateAsync()` у inline click-handler без try/catch — silent failure (Bug #499) — `T1.3-043`
- [ ] Dead state cleanup у paired файлах після review (Bug #496, paired with Bug #341) — `T1.3-044`
- [ ] URL deep-link writer без парного reader (Bug #596) — `T1.3-045`
- [ ] Review-fix completeness audit для крос-файлових патернів (Bug #341) — `T1.3-046`
- [ ] Хардкоджений label службової/обчисленої колонки колізує з користувацьким полем даних тієї ж назви (Bug #626) — `T1.3-047`
- [ ] Застарілий коментар після інверсії доменного арифм. оператора `/`↔`*` у ІНШОМУ шарі (Bug #737) — `T1.3-048`

- [ ] Клавіатурний обробник (Escape/Enter) на ОДНОМУ елементі складеного віджета (Bug #783; детектор і перевірка — одразу під пунктом, у журналі їх нема) — `T1.3-049`

  ```bash
  grep -rlE "set[A-Za-z]*Open\(false\)" apps/web/src/components/ui --include=*.tsx | grep -v __tests__ \
    | xargs grep -lE "key === 'Escape'" | xargs grep -LE "addEventListener\('keydown'"
  ```

  Перевірка в браузері для КОЖНОГО способу відкрити попап (фокус у полі / клік по кнопці / Tab усередину): Escape → попап закрито, `[role="dialog"]` на місці. Фікс — capture-слухач на `document` зі `stopImmediatePropagation()`, доки попап відкритий.

- [ ] Новий спосіб ЗАКРИТИ віджет створює стан, з якого старий спосіб ВІДКРИТИ не працює (Bug #784) — `T1.3-050`

---
