# sto-review — журнал: web

> Архів реальних випадків (дата — назва — §N + Сигнал / Grep / Фікс / Severity).
> Не читати цілком — шукати за ключовим словом. Чекліст секції: `../sections/web.md`.

### 2026-05-28 — memo() з fresh array/object prop — §3.1/§7

**Сигнал:** `memo(Component)` де батько передає inline `.filter()/.map()/{}` → нова референція кожен рендер → memo не спрацьовує.
**Фікс:** `useMemo` Map у батьку; stable empty constant замість `[]` default.
**Severity:** SUGGESTION — виправлений memo дає 50-200ms на drag/filter.

### 2026-05-28 — GET dedup + AbortSignal shared promise — §8.1

**Сигнал:** in-flight GET dedup keyed on `path` без guard `!init?.signal` → abort одного caller вбиває інших.
**Фікс:** `if (method === 'GET' && !init?.signal) { ...dedup... }`.
**Severity:** IMPORTANT — silent abort для не-aborted callers.

### 2026-05-28 — apiFetch message: string[] у всіх helpers — §8.1

**Сигнал:** fix `Array.isArray(message)` у `apiFetch`, але `apiBlobFetch`/`apiMultipartFetch` без нього.
**Фікс:** оновити всі три синхронно в одному коміті.
**Severity:** IMPORTANT — `[object Object]` або лише перший елемент при 400 validation.

### 2026-05-28 — closest() на data-атрибут якого бібліотека не ставить — §3.1/§8

**Сигнал:** `target.closest('[data-dnd-draggable]')` — dnd-kit `attributes` ставить лише `role/aria-*/tabindex`, НЕ `data-dnd-*`.
**Фікс:** власний стабільний маркер на корінь (`data-calendar-slot`) → один `closest()` покриває всіх дітей.
**Severity:** IMPORTANT — guard не працює, конкуруючі pointer-жести; німа degradation.

### 2026-05-28 — leave/cancel handler скидає лише частину pointer-режимів — §3.1

**Сигнал:** `onPointerLeave` коментар "cancel drawing/resize", але тіло скидає лише `drawingRef`, не `resizing/resizePreview`.
**Фікс:** скинути ВСІ режими: `if (drawing){...}; if (resizing){ setResizing(null); setResizePreview(null); }`.
**Severity:** IMPORTANT — застрягла UI-операція, фантомний preview.

### 2026-05-30 — close-animation rAF без id-capture + missing unmount cleanup — §3.1

**Сигнал:** `requestAnimationFrame(() => outer.style.height='0px')` у close-branch toggle-ефекту; id не зберігається; rapid toggle лишає pending rAF.
**Фікс:** `rafRef.current = requestAnimationFrame(...)`; на старті toggle `if (rafRef.current !== null) cancelAnimationFrame(...)`; cleanup у dedicated unmount-effect.
**Severity:** IMPORTANT — visual glitch (height=0 на щойно-відкриту форму) + "setState on unmounted".

### 2026-05-30 — fire-and-forget PUT у hook без AbortController → out-of-order writes — §8.2

**Сигнал:** `apiFetch('/x', { method: 'PUT', body }).catch(() => {})` без AbortController; серверний стан гоняється (out-of-order).
**Фікс:** `abortRef.current?.abort(); ac = new AbortController(); abortRef.current = ac;` → `{ signal: ac.signal }`.
**Severity:** IMPORTANT — server-state drift; між-сесійна неузгодженість.

### 2026-05-30 — rAF у persistent effect (не toggle) без id-capture — §3.1

**Сигнал:** `useEffect(() => { requestAnimationFrame(() => style.X = Y) }, [])`, id НЕ у ref → unmount під час pending rAF мутує detached DOM.
**Фікс:** `rafRef = useRef<number|null>(null)` → `rafRef.current = requestAnimationFrame(...)`; cleanup `if (rafRef.current !== null) cancelAnimationFrame(...)`.
**Severity:** IMPORTANT — "ghost" DOM mutation; ризиково для AnimatedBody/Drawer/collapse.

### 2026-05-29 — event-handler fetch без request-token + stale похідний id — §8.2

**Сигнал:** `openEdit(item)/openCard/onSelect` (обробник події, НЕ useEffect) робить `apiFetch(...).then(setState)`; при повторному відкритті для іншого id стара in-flight резолвиться пізніше.
**Grep:** `grep -rnE "const (open|load|select)[A-Z]\w* = (async )?\(" apps/web/src/app --include="*.tsx"` + apiFetch у тілі.
**Фікс:** `const reqId = ++ref.current;` на старті; `if (ref.current !== reqId) return` перед кожним setState; скинути похідні id до fetch.
**Severity:** IMPORTANT — stale-data race + крос-сутнісна мутація на fetch-failure.

### 2026-05-31 — Per-item line.id-keyed onSelect sub-resource race — §8.2

**Сигнал:** `lines.map((l,i) => onSelect={async g => { setLines(...); const sub = await apiFetch(`/x/${g.id}/Y`); setLines(ls => ls.map((x,idx) => idx===i ? {...x, sub} : x)) }})` — race при швидкому перевиборі товару в рядку.
**Фікс:** capture `selectedGoodId = g.id`; скинути похідний стан одразу; після await перевірити `if (ls[idx]?.goodId !== selectedGoodId) return ls`.
**Severity:** IMPORTANT — silent UI inconsistency (UoM товару Y на товар X → невірний коефіцієнт/quantity).

### 2026-05-31 — Видалили manual `*` припустивши що компонент додає його, а компонент кастомний — §8

**Сигнал:** `fix: прибрати ручні зірочки — Input/Select додають * через required` чіпає й inline Field/Select у файлі, які required-маркера НЕ рендерять.
**Grep:** `grep -rn "function Field\|const Field\|function Select" apps/web/src/app --include="*.tsx"`.
**Фікс:** додати `required?: boolean` у props inline-Field → `{required && <span className="ml-0.5 text-destructive">*</span>}` + `aria-required`.
**Severity:** IMPORTANT — UX regression: користувач не бачить required-маркера.

### 2026-05-31 — Modal/Lightbox без Escape + role=dialog + aria-modal — §8 (a11y)

**Сигнал:** `<div className="fixed inset-0 z-50">` (lightbox/overlay) без `role="dialog"`, `aria-modal="true"`, `aria-label`, без Escape handler.
**Grep:** `grep -rnE "className=['\"]fixed inset-0.*z-50" apps/web/src --include="*.tsx"`.
**Severity:** IMPORTANT — недоступно клавіатурі; ARIA не озвучує "dialog opened".

### 2026-06-03 — Animation wrapper `if (!open) return null` ламає exit-анімацію Modal — §8/§3.1

**Сигнал:** обгортка (`ConfirmDialog`, custom dialog) рендерить `<Modal open={open}>` але має власний `if (!open) return null` ПЕРЕД return → unmount раніше за exit-анімацію.
**Grep:** `grep -rn "if (!open) return null" apps/web/src/components/ui --include="*.tsx"` (детектор у §8.5).
**Фікс:** прибрати `if (!open) return null` з wrapper; Modal сам обробляє visibility через useAnimatedPresence. Дорогий body → `{open && <HeavyContent/>}` всередині Modal.
**Severity:** CRITICAL — повна втрата exit-анімації; ламає useAnimatedPresence invariant.

### 2026-06-09 — Anchored popup useLayoutEffect deps `[anchorRef]` → stale position on re-open — §3.1/§8

**Сигнал:** попап читає `anchorRef.current.getBoundingClientRect()` у `useLayoutEffect(..., [anchorRef])`. `anchorRef` — стабільний, deps не тригерять реколк при новому anchor.
**Grep:** `grep -rnE "useLayoutEffect\(.*\}, \[anchorRef\]\)" apps/web/src/components/ui --include="*.tsx"` (детектор у §3.1).
**Фікс:** додати payload у deps (`preview`/`item`/`data`): `useLayoutEffect(..., [anchorRef, preview])`.
**Severity:** IMPORTANT — попап вирівнюється до неправильного рядка.

### 2026-06-09 — Nested overlay Esc handler → закриває весь вкладений ланцюг (parent Modal теж) — §3.1/§8 (a11y)

**Сигнал:** вкладений overlay додає `document.addEventListener('keydown', h)` у bubble-фазі для Esc; батьківський Modal теж слухає Esc → обидва закриваються.
**Grep:** `grep -rnE "document\.addEventListener\(['\"]keydown" apps/web/src/components/ui` (детектор у §3.1).
**Фікс:** handler у capture phase + `stopImmediatePropagation()`.
**Severity:** IMPORTANT — користувач втрачає незбережені зміни parent-modal; порушує "Esc closes ONLY topmost".

### 2026-06-12 — Ad-hoc `<div className="fixed inset-0 z-[N]">` confirm замість useConfirm — §8/§8.5 (a11y)

**Сигнал:** inline `{pending && <div className="fixed inset-0 z-[70]">…<Button>Так/Ні</Button></div>}` у файлі що вже імпортує `useConfirm`+`ConfirmDialog`. Немає `role="dialog"`, aria, Escape, focus trap, exit-animation.
**Grep:** `grep -rnE "fixed inset-0.*z-\[?[0-9]+" apps/web/src --include="*.tsx"` → якщо у файлі є `useConfirm` import → заміна.
**Фікс:** `const ok = await confirm({ title, message }); if (ok) { ... }`.
**Severity:** IMPORTANT — порушує a11y + useAnimatedPresence.

### 2026-06-14 — Нова `<col>` у `<colgroup>` без інкременту `tfoot colSpan` → totals у неправильній колонці — §8/§8.6

**Сигнал:** feat додає колонку (`<col>` + `<th>` + `<td>` у всіх modes), але `<tfoot>` лишив старий `colSpan`. Layout зсувається → totals не у своїх комірках. Empty-state colSpan оновлюють (видно), а tfoot пропускають.
**Grep:** `grep -n "colSpan" <modal>.tsx` — формула: `colSpan + (cells після нього у row) === count(<col>)`. Детектор у §8.6 (git diff `+<col>`).
**Фікс:** інкрементнути ВСІ `colSpan` у `<tfoot>` + `<tbody>` empty-state row до count(`<col>`).
**Severity:** CRITICAL — visible layout bug при додаванні parts.

### 2026-06-14 — `apiFetch().catch(() => {})` у новому useEffect — silent stale-data race — §3.1/§8.2

**Сигнал:** `void apiFetch<T[]>('/x/bulk?ids=...').then(rows => setState(new Map(...))).catch(() => {})` без `cancelled` flag; Map лише з повернених рядків → `map.get(id)` undefined → `'—'` замість `0`.
**Grep:** `grep -rnE "useEffect\(\(\) => \{" apps/web/src/components/ui --include="*.tsx" -A20` + apiFetch + `.then(setState)`.
**Фікс:** `let cancelled = false; ...then(rows => { if (cancelled) return; const next = new Map(ids.map(id => [id, 0])); for (const r of rows) next.set(r.id, r.value); setState(next); }).catch(err => { if (cancelled) return; console.error(...) }); return () => { cancelled = true };`. Pre-init з `0`.
**Severity:** IMPORTANT — race + silent server-error blackout + UX edge (`'—'` замість `0`).

### 2026-06-05 — Partial `setPage(1)→resetPage()` migration: inline JSX handlers пропущено — §8.2/§8.6

**Сигнал:** `useListPage` експортує `setPage` і `resetPage`; `applyFilter` мігровано на `resetPage()`, а 5 inline handlers досі `setPage(1)`.
**Grep:** детектор у §8.6 (`useListPage<` файли з обома `setPage(1)` + `resetPage()`).
**Фікс:** inline handlers → `resetPage()`; `setPage` лишити (потрібен для `<Pagination onChange={setPage}>`).
**Severity:** SUGGESTION — DRY inconsistency; ризик regression якщо resetPage отримає side-effect.

### 2026-06-15 — Новий enum-value не підхоплений жорстко-закодованим масивом на фронті — §8

**Сигнал:** backend додає enum value + оновлює `*_LABELS` у `@sto/shared`, але фронт-таби з локального хардкоду (`['', 'WRITEOFF', 'TRANSFER', 'OPENING_BALANCE']` — RECEIPT відсутній).
**Grep:** `grep -rnE "'WRITEOFF',\s*'TRANSFER',\s*'OPENING_BALANCE'" apps/web/src/`; `grep -rn "STOCK_DOC_TYPE_LABELS\|WO_STATUS_LABELS" apps/web/src --include="*.tsx"`.
**Фікс:** `['', ...Object.keys(STOCK_DOC_TYPE_LABELS)]` — майбутні значення автоматично.
**Severity:** CRITICAL — фіча відвантажена, але не доступна в UI; TS green (не повний union не ловиться).

### 2026-06-15 — Tab buttons з `focus:outline-none` без `focus-visible:*` заміни — §8.5/§1

**Сигнал:** кастомний `<button>` (tab-bar) додає `focus:outline-none` без `focus-visible:ring-*`. Keyboard-only юзер не бачить focus. WCAG 2.1.1/2.4.7.
**Grep:** `grep -rnE "focus:outline-none" apps/web/src/app --include="*.tsx" | grep -v "focus-visible:\|focus:ring-"`.
**Фікс:** `focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:rounded-sm`.
**Severity:** IMPORTANT — WCAG fail; keyboard-only не орієнтується.

### 2026-06-15 — `router.replace(url)` без `{ scroll: false }` для URL sync — §8

**Сигнал:** `router.replace(`?${params.toString()}`)` без опцій. Next App Router скролить до top навіть при cosmetic query-update.
**Grep:** `grep -rnE "router\.(replace|push)\(" apps/web/src/app --include="*.tsx" | grep -v "scroll:\s*false"`.
**Фікс:** `router.replace(..., { scroll: false })` для filter/tab sync (реальна навігація — scroll-to-top нормальний).
**Severity:** IMPORTANT — UX: втрата scroll-контексту.

### 2026-06-16 — Hardcoded status labels поряд із готовим shared `*_STATUS_LABELS` — §8/§1 DRY

**Сигнал:** status badge через 5-гілковий ternary з рядковими літералами, хоча `@sto/shared` вже експортує `INVOICE_STATUS_LABELS`/`WO_STATUS_LABELS`. Risk: divergence (`'Відправлено'` vs shared `'Надіслано'`).
**Grep:** `grep -rnE "status === ['\"]DRAFT['\"]\s*\?\s*['\"][А-Яа-я]" apps/web/src/app --include="*.tsx"`; `grep -n "_STATUS_LABELS" packages/shared/src/constants/statuses.ts`.
**Фікс:** `import { INVOICE_STATUS_LABELS } from '@sto/shared'` → `{LABELS[status] ?? status}`.
**Severity:** IMPORTANT — divergence UA-назв між сторінками; порушує SSOT.

### 2026-06-15 — Dead code після onClick refactor: orphan `selectX/toggleSelectX` — §8/§1

**Сигнал:** пара `selectDoc`+`toggleSelectDoc` для DetailPanel; onClick змінено на `setEditingDocId(doc.id)`, але функції лишились orphan → `selectedDoc` завжди null → panel порожній. TS green.
**Grep:** `grep -rnE "const (select|toggle)[A-Z][A-Za-z]+ = useCallback" apps/web/src/app --include="*.tsx" -A1` → для кожної `grep -n "<fn>(" <file>`; якщо лише декларація → dead.
**Фікс:** видалити мертві функції; або додати окремий `onSelect` handler якщо DetailPanel потрібен.
**Severity:** IMPORTANT — broken feature без TS/runtime error; dead code = шум.

### 2026-06-17 — Column alignment inconsistency: новий `<td>` `text-center` при `text-left` братів — §8.6

**Сигнал:** нова колонка у 3 modes (view/edit/new-input) — view/edit `text-left`, new-input `text-center` (для самотнього `—`).
**Grep:** `grep -rnE "px-2 py-1.5 text-(left|center|right)" apps/web/src/components/ui --include="*.tsx"`.
**Фікс:** уніфікувати з view-mode alignment (header задає істину).
**Severity:** SUGGESTION — UX inconsistency.

### 2026-06-17 — Frontend apiFetch до неіснуючого endpoint + silent `.catch(()=>{})` — §8.1/§8.2

**Сигнал:** UI-секція (VAT row) залежить від `apiFetch<{...}>('/X/Y')` де `/X/Y` НЕ існує у backend; робочий патерн того ж призначення поруч (`/settings/organisation`). Silent `.catch(() => {})` ховає що setVatMode ніколи не викликається → UI-блок тихо не рендериться.
**Grep:** цикл-детектор MISSING-endpoint (див. нижче); `grep -rnE "\.catch\(\(\) => \{\}\)" apps/web/src/`.
**Фікс:** реюзнути робочий URL; `.catch(err => console.error('[Component] X failed', err))`; explicit resolve через дод. endpoint якщо shape різниться (`defaultVatRate` vs `defaultVatRateId`).
**Severity:** CRITICAL — silent UI dead code; feature-flag drift.

### 2026-09-02 — `role="button"` без `tabIndex={0}` + `onKeyDown` (Enter/Space) → keyboard-broken drill-down — §8/§14 a11y

**Сигнал:** drill-down UI (клітинка шахматки, `<tr onClick>`, dashboard-плитка) додає `role="button"` + `cursor-pointer`, але забуває `tabIndex={0}` + `onKeyDown`. Keyboard-only юзер не активує. WCAG 2.1.1. Еталон — `inline-edit-cell.tsx`. (Знайдено у SupplierPaymentScheduleTab.tsx).
**Grep:**

```bash
grep -rnE "role=['\"]button['\"]" apps/web/src/ --include="*.tsx" -B2 -A5 | grep -v "onKeyDown\|tabIndex\|inline-edit-cell\|<button"
grep -rnE "<tr[^>]*onClick=" apps/web/src/ --include="*.tsx" -A3 | grep -v "onKeyDown\|role=\|tabIndex"
grep -rnE "cursor-pointer" apps/web/src/ --include="*.tsx" -B3 -A3 | grep -B3 -A3 "onClick" | grep -v "role=\"button\"\|<button\|tabIndex"
```

**Фікс:** module-level `function activateOnKey(onClick) { return e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }; }` → `role="button" tabIndex={0} onKeyDown={activateOnKey(handler)}` + `focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary`. Для `<tr>` — `aria-label="Відкрити X"`. Опціональний handler → всі 3 атрибути conditional (`clickable ? 0 : undefined`).
**Severity:** IMPORTANT — WCAG fail; latent regression у кожній новій heatmap/шахматка UI.

### 2026-09-06 — error-swallowing wrapper резолвиться → caller показує хибний success — §8.2

**Сигнал:** shared-мутатор (`patchChannel`/`saveX`) має внутрішній `try/catch`, що `setError`+`toast.error` і **резолвиться** (не re-throw). Caller (`saveCreds`/submit) робить `await wrapper(...)` у власному `try` → беззастережно `toast.success('Збережено')` + `closeModal()`. Wrapper проковтнув помилку → caller завжди думає що успіх → toast «збережено» + модалка закрита навіть коли PATCH впав. Аналогічно ланцюг залежних мутацій (priority-swap: 2 послідовні PATCH) виконує 2-й крок навіть коли 1-й впав → часткова неконсистентність.
**Grep:**

```bash
grep -rnE "const (patch|save|update|toggle)[A-Za-z]* = (async )?\(" apps/web/src/app --include="*.tsx" -A25 \
  | grep -E "catch|toast\.success|return true|return false" | head -30
```

**Фікс:** wrapper повертає `boolean` (`return true`/`return false` у catch); caller гейтить `const ok = await wrapper(...); if (!ok) return;` перед success-toast/close. Ланцюг залежних мутацій — 2-й крок лише `if (ok)`; in-flight guard (`movingId`) проти конкурентних запусків.
**Severity:** IMPORTANT — хибний UX-сигнал + часткова неконсистентність у dependent-write ланцюгах.

### 2026-09-06 — exclusivity-action + сусідній per-item toggle що мовчки ламає інваріант — §8.2/§5

**Сигнал:** нова дія встановлює «ексклюзивно лише один X активний» (activate-provider, set-default-account, pin-single) через bulk-mutation (`updateMany others=false, updateMany chosen=true`), АЛЕ у тому ж UI лишається старий per-item toggle (`Switch`/checkbox) що редагує те саме поле (`enabled`/`isDefault`) на БУДЬ-ЯКОМУ елементі. Юзер вмикає item іншої групи → інваріант «лише один» тихо порушено. Downstream (`resolveConfig` фільтрує `enabled:true` по ВСІХ) бере два → подвійна поведінка. TS зелений.
**Grep:**

```bash
grep -rlE "activate[A-Z]|setDefault|setPrimary|isExclusive|updateMany.*enabled" apps/web/src/app --include="*.tsx" \
  | xargs grep -lE "toggle[A-Z]|onChange.*enabled|checked=\{" 2>/dev/null
grep -rnE "= [a-zA-Z]+\.find\(c? => c?\.(enabled|isDefault|active)\)\??\.[a-zA-Z]+ \?\? null" apps/web/src --include="*.tsx"
```

**Фікс:** per-item toggle гейтить інваріант — увімкнути item можна лише якщо він у активній групі (`if (enable && item.group !== activeGroup) { setError(...); return; }`); toggle неактивної групи `disabled`. Вимкнути item активної групи — дозволено. Активація іншої групи — лише через exclusivity-action. Empty-state guard на самій exclusivity-action: якщо група не має жодного item → bulk-mutation матчить 0 рядків = no-op + хибний success-toast → перевірити `items.some(i => i.group === chosen)` перед викликом.
**Severity:** IMPORTANT — тихе порушення інваріанта; downstream бере два «ексклюзивні»; UX хибний success на no-op.

### 2026-09-06 — оптимістичний status-flip після mutation ігнорує проміжний стан (partial) — §8.2

**Сигнал:** після успішного POST (оплата/крок FSM) фронт оптимістично ставить **фінальний** статус (`setSelectedX(prev => ({ ...prev, status: 'PAID' }))`), припускаючи що mutation завжди веде у фінал. Але backend має **проміжний** стан (`PARTIALLY_PAID` коли `paidAmount < amount`) → частковий платіж лишає рахунок частковим, а панель показує PAID → ховає кнопку «Оплатити». `invalidateQueries` виправить після refetch, але оптимістичне значення хибне у вікні до refetch (і повністю хибне якщо refetch впаде).
**Grep:** `grep -rnE "set[A-Z][a-zA-Z]*\(prev =>.*status: '[A-Z_]+'" apps/web/src/app --include="*.tsx"` — для кожного оптимістичного status-flip чи враховано проміжні стани.
**Фікс:** обчислити результуючий статус **тією самою логікою що backend** (з тим самим epsilon): `const optimistic = newPaidTotal >= amount - 1e-9 ? 'PAID' : 'PARTIALLY_PAID'`; оновити і похідні поля (`paidAmount`).
**Severity:** IMPORTANT — хибний UI-стан ховає потрібну дію (partial payment → кнопка «Оплатити» зникає); гроші-критичний UX.

### 2026-09-09 — date-picker YYYY-MM-DD → ISO через local-parse → off-by-one на межі дня — §8.6

**Сигнал:** `new Date(`${d}T00:00:00`).toISOString()` де `d` — рядок з date-picker. Парсинг `T00:00:00` (без `Z`) у TZ **браузера**, `.toISOString()` → UTC. У браузерах з додатнім offset (Kyiv UTC+3) `2026-09-10T00:00:00` local → `2026-09-09T21:00:00Z` → дата на **-1 день**. Той самий баг у ручній min/max арифметиці (`new Date(...); setDate(getDate()+1); toISOString().slice(0,10)`).
**Grep:** `grep -rnE "new Date\(\`?\\\$?\{[a-zA-Z]+\}?T00:00:00\`?\)" apps/web/src`+`grep -rnE "\.setDate\(.*getDate\(\) ?[+-]" apps/web/src/app apps/web/src/components`.
**Фікс:** day-арифметика → канонічний `addDaysISO(kyivToday(), N)`(UTC-математика,`lib/format.ts`); payload «кінець дня» → `${d}T23:59:59Z`.
**Severity:** IMPORTANT — німа data-corruption (дата на день раніше), tsc зелений; лише у певних TZ. Sample: WarrantyCreateModal (abe63125).

### 2026-09-17 — Ручний `safeParse(getValues())` у submit-хендлері з хардкод-помилкою ігнорує line-item фейли — §8.2

**Сигнал:** модалка з `useFieldArray` не використовує `handleSubmit`, а читає значення вручну (`schema.safeParse(getValues())`) щоб зберегти контракт «повертає id». На `!parsed.success` показує **єдине хардкод-повідомлення** про шапкові поля (напр. `setError('Оберіть постачальника та склад')`). Але сабміт-кнопка вже `disabled={!supplierId || !warehouseId}` → шапка гарантовано валідна на кліку → реальний фейл майже завжди у РЯДКУ (порожня ціна/кількість-0/невалідний рядок), а користувач бачить оманливе «оберіть постачальника» і не знає, який рядок виправити.
**Grep:** `grep -rn "safeParse(getValues())" apps/web/src/components --include="*.tsx"` → для кожного: чи `!success`-гілка показує ПЕРШИЙ zod-issue.message, чи хардкод. Хардкод при схемі з `lines`-масивом = баг.
**Фікс:** `firstSchemaError(err)` — `err.issues[0].message` (усі повідомлення схеми вже українські), а для line-item (`path[0]==='lines' && typeof path[1]==='number'`) префіксувати `Рядок ${path[1]+1}: `. Тип zod-error без прямого `import {z} from 'zod'` (web не має zod прямою залежністю): `Extract<ReturnType<typeof schema.safeParse>, {success:false}>['error']`.
**Severity:** IMPORTANT — оманлива помилка блокує сабміт без вказівки, що насправді не так. Sample: PurchaseOrderCreateModal handleCreate/handleSave (cf7de79c).

### 2026-10-07 — Портальний попап без власного Esc → Escape закриває модалку-батька — §3.1/§8 (a11y)

**Сигнал:** компонент рендерить попап через `createPortal(..., document.body)` і не має жодного keydown-обробника (`datetime-picker-input.tsx`). Усередині `<Modal>` (слухає Escape на `document`, bubble) перше натискання закривало всю модалку з формою. Дзеркало запису 2026-06-09: там обробник був, але у bubble-фазі; тут його не було взагалі.
**Grep:** детектор у §3.1 (`createPortal` без `keydown|onKeyDown`).
**Фікс:** `useEffect` поки `open`: `document.addEventListener('keydown', h, true)` + `e.stopImmediatePropagation()` + закрити попап. `onKeyDown` на інпуті не досить — фокус може бути в елементі порталу. Для НЕпортального попапа всередині порталу модалки (`date-picker-input.tsx`) синтетичний `e.stopPropagation()` працює лише тому, що React вішає слухачі на контейнер порталу (`body`) — перевіряти в браузері, не лише в jsdom.
**Severity:** IMPORTANT.
