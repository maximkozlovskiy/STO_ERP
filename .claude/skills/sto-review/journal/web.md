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

### 2026-10-07 — recharts Tooltip без фону на токенах → нечитабельна підказка в темній темі — §8.2

**Сигнал:** `<Tooltip contentStyle={{ border, borderRadius, fontSize }}>` без `backgroundColor`/`color`. `DefaultTooltipContent` recharts 3 має типові `backgroundColor: '#fff'` і колір лише для рядків значень; підпис (`recharts-tooltip-label`) кольору не має й успадковує `color` сторінки — у темній темі це світлий текст на білому. Скопійовано зі взірця (`RevenueChart`) у новий `MileageChart`; компонентний тест графік стабив, тож рендер ніхто не бачив.
**Grep:** `grep -rn "<Tooltip" -A8 apps/web/src --include="*.tsx" | grep backgroundColor` — кожен `<Tooltip` recharts має дати рядок. `ReportsCharts.tsx` досі на типових стилях і hex-кольорах (свідомо не чіпано цим проходом).
**Фікс:** `backgroundColor: 'var(--color-surface-raised)', color: 'var(--color-foreground)'` у `contentStyle`. Тест реального рендера: підмінити ЛИШЕ `ResponsiveContainer` (у jsdom розмір 0) на `cloneElement(children, { width, height })` — решта recharts справжня, і `.recharts-default-tooltip` присутній у DOM навіть без наведення.
**Severity:** IMPORTANT.

### 2026-10-07 — Похідний query-key поза cross-cache інвалідатором — §8.2

**Сигнал:** новий хук `useVehicleMileage` (`staleTime` 60 с) читає дані, збудовані з нарядів, але `invalidateWorkOrderSideEffects` його ключа не знав: наряд завершили або скасували → картка авто, відкрита протягом хвилини, показує стару історію (скасований запис на місці, дата не `completedAt`).
**Grep:** `grep -rn "Keys = {" apps/web/src/hooks/api` → для кожного ключа `grep -rn "<ім'я>Keys" apps/web/src/lib/cache-invalidation.ts apps/web/src/hooks`.
**Фікс:** `void qc.invalidateQueries({ queryKey: vehicleMileageKeys.all })` у хелпері, який уже викликають усі точки переходу наряду.
**Severity:** SUGGESTION — застаріле до `staleTime`, не втрата даних.

### 2026-10-09 — Підпис поля у `<span>` поруч замість `label=` — §8.7

**Сигнал:** фіча «пошук і відбір за датою» перевела фільтри оплат із `<DatePickerInput label=…>` на рядок «підпис-span + поле»; ту саму розмітку скопійовано на банк і касу (взірець — складські документи). `DatePickerInput` не мав способу дати полю назву без видимого `label`, тож чотири екрани лишились із двома полями дати без доступної назви.
**Grep:** `grep -rn "<DatePickerInput" -A6 apps/web/src/app --include="*.tsx"` → кожне поле має `label=` або `ariaLabel=`.
**Фікс:** проп `ariaLabel` у `DatePickerInput`; спільний `<DateRangeFilter from to onFromChange onToChange fromLabel toLabel>` замість чотирьох копій блоку; тест `DateRangeFilter.test.tsx` шукає поля через `getByLabelText`.
**Severity:** SUGGESTION (a11y) — для оплат це регресія: до фічі поля мали `label`.

### 2026-10-12 — Прапорець «вкладене відкрито», знятий в ефекті, пропускає Escape до батьківської модалки — §3.1

**Сигнал:** форма правила ціноутворення: «Додати товар» → клік по товару → Escape закривав і вибір, і форму (у браузері; у jsdom не відтворюється). Поруч: форма слала `goodIds` при кожному збереженні й не читала список, коли `goodsCount` у рядку таблиці 0.
**Grep:** `grep -rn "OverlayOpenChange\|overlayOpenRef" apps/web/src --include="*.tsx"` → прапорець знімається через `setTimeout`, не синхронно.
**Фікс:** зняття прапорця після події; регресія — лише E2E. Дочірній список у PATCH — тільки після зміни користувачем; повний список читати при кожному відкритті форми.
**Severity:** IMPORTANT (втрата незбереженого списку)

### 2026-10-13 — Масова кнопка вимикає сама себе й губить фокус; тест сканера зелений завжди — §8.5

**Сигнал:** вікно вибору товарів правила: Enter на «Відмітити всі показані» → кнопка отримує `disabled` → `document.activeElement` стає `<body>` (Chromium), користувач клавіатури губить місце. Лічильник `aria-live` з текстом «3 / 50» озвучувався на кожен клік без змісту. Тест «сканер доданий товар не знімає» тиснув Enter із порожнім запитом — обробник виходив одразу, мутація «сканер через clickGood» його не валила. Обробники списку читали `goods` із замикання: два виклики до рендера затирали один одного (реальні кліки — ні, програмні й відкладена відповідь — так).
**Grep:** `grep -rnE "disabled=\{[a-zA-Z]+\.length === 0\}" apps/web/src --include="*.tsx"`; `grep -rn "aria-live" apps/web/src --include="*.tsx"` → текст області зрозумілий без екрана.
**Фікс:** `aria-disabled` + перевірка в `onClick`; видимий лічильник `aria-hidden`, поруч `role="status"` із реченням; список — через ref, що оновлюється в момент зміни; тести сканера з контрольним кейсом і двома шляхами Enter.
**Severity:** IMPORTANT (фокус) / SUGGESTION (решта)

### 2026-10-13 — Дві пастки фокуса на document: Tab у вкладеній модалці стрибає на «Закрити» — §3.1

**Сигнал:** форма правила → «Додати товар»: Tab із будь-якого елемента вікна вибору ставив фокус на «Закрити», Shift+Tab — на «Готово». Нижня модалка чує Tab першою, бачить фокус поза своєю панеллю і тягне на свій край; верхня — на свій. jsdom цього не показує: `offsetParent` там `null`, а пастка вмикається лише на відкритті вже змонтованої модалки.
**Grep:** `grep -rn "container.contains(activeEl)" apps/web/src/hooks` → гілка «втік» мусить пропускати фокус у панелі іншої пастки (`data-focus-trap`).
**Фікс:** `useFocusTrap` позначає панель і відступає, якщо фокус у чужій; тест `modal.test.tsx` «Tab у вкладеній модалці» (з підміною `offsetParent`). Перевіряти клавіатуру вкладених вікон у браузері.
**Severity:** IMPORTANT (a11y: вміст вкладеної модалки недосяжний із клавіатури)

### 2026-10-13 — Вибір за id, рядок зі списку: панель відкривається сама після пагінації — §8.5

**Сигнал:** нові бокові панелі складу й повернень зберігають `selectedDocId`, а документ беруть `docs.find(...)`. Рядок пішов зі сторінки (пагінація, фільтр, вкладка-тип) → панель закрилась, але id лишився; рядок повернувся — панель відкрилась без кліку.
**Grep:** `grep -rnE "\.find\([a-z]+ => [a-z]+\.id === selected[A-Za-z]*Id\)" apps/web/src/app` → поруч має бути ефект скидання id, умова якого містить прапорець завантаження списку (без нього вибір скинеться ще під час завантаження наступної сторінки — це нормально, але без `!loading` скидається й на першому рендері з порожнім кешем).
**Фікс:** `useEffect(() => { if (id && !loading && !selected) setId(null) }, [id, selected, loading])`; тест міняє вміст списку туди й назад і перевіряє, що панель не з'явилась, а клік її ВІДКРИВАЄ (контроль, що вибір справді скинуто).
**Severity:** SUGGESTION (UX: панель з'являється без дії користувача)

### 2026-10-13 — «Лише перегляд» закрито через canEdit, а решта кнопок лишилась — §8.5

**Сигнал:** картка видаленого документа ховала збереження й переходи, але: «Друк» / «Зберегти як»
наряду йшли на сервер (share-token → 404); поле клієнта в наряді не мало `disabled` (хрестик
очищав його); секції рахунку, гарантії, фото на сторінці наряду й дії панелі рахунків про
`deletedAt` не знали. Знайдено лише переліком видимих кнопок у браузері, не читанням коду.
**Grep:** `grep -rn "EntityPickerField" -A22 apps/web/src/components/ui/*Modal.tsx | grep -c "disabled="`
проти кількості полів шапки; `grep -n "isDeleted" <сторінка>` → кожна дочірня секція з власними
запитами отримує `readOnly`. **Фікс:** `disabled={!canEdit}` на підборі; `readOnly` у секції;
серверний друк під `!isDeleted`. **Severity:** IMPORTANT

### 2026-10-13 — Картка документа без захисту від пізньої відповіді — §8.2

**Сигнал:** `loadPo` / завантаження повернення робили `.then(data => reset(...))` без токена:
відкрив A, закрив, відкрив B — пізня відповідь A заповнює форму B (і знімає позначку «видалено»).
У поверненні до відповіді стояли статус і рядки попереднього документа з активним «Підтвердити».
**Фікс:** `loadReqRef` + `isStale()` (взірець — `StockDocumentCreateModal`), прапорець
`notLoaded = isEdit && loadedId !== editId`. Тест: відкладений проміс A, `rerender` з B, потім
resolve A. **Severity:** IMPORTANT

### 2026-10-13 — «in на мапі»: перевірка рядка ззовні оператором `in` — §8.2

**Сигнал:** `defaultType && defaultType in STOCK_DOC_TYPE_LABELS ? (defaultType as T) : undefined`
у `StockDocumentCreateModal` (989040af). `in` бачить успадковані ключі (`toString`,
`constructor`), тож рядок проходить перевірку, приводиться до типу форми і стає значенням
`<select>`, якого немає серед варіантів. Зі сторінки складу недосяжно (там `Set` власних
ключів), але картка — спільний компонент.
**Grep:** `grep -rnE "[a-zA-Z.]+ in [A-Z][A-Z_]+\b" apps/web/src | grep -v "for (const"`
**Фікс:** `Object.keys(MAP).includes(v)` (або `Set` на рівні модуля); тест із `'toString'`.
**Severity:** SUGGESTION

### 2026-10-14 — Модалка, змонтована відкритою, не тримає фокус; панель-копія відстає — §8.5

**Сигнал:** картка документа, відновлена з вкладки (`RestoredDocumentModal`), монтується одразу
з `open`. `Modal` на першому рендері повертає `null` (чекає `mounted`), тож `useFocusTrap`
запускався з порожнім `panelRef` і більше не перезапускався (`[active, containerRef]` не
міняються): фокус лишався на сторінці, Tab ішов по ній 45 разів із 45. Те саме в будь-якому
`{x && <Modal open />}`. Компонентний тест на заглушках цього не бачить — лише браузер.
Друге: сторінка тримала копію вибраного документа в стані панелі й оновлювала її лише у
власному `onSaved`; картка з вкладки змінила статус — рядок «Надіслано», панель «Чернетка» з
дією «Надіслати».
**Grep:** `grep -rn "useFocusTrap(" apps/web/src` → умова містить `mounted`;
`grep -rn "const \[selected[A-Za-z]*, setSelected" apps/web/src/app`.
**Фікс:** `useFocusTrap(panelRef, visible && mounted)`; `useSelectedRowRefresh` на сторінках
рахунків, закупівель, нарядів. **Severity:** IMPORTANT

Третє: `DocLinesHeader` без `flex-wrap` на 390 px виносив «Додати» складського документа за край
картки (x 509–570 при ширині 390) — раніше кнопка стояла під таблицею ліворуч і була досяжна.

### 2026-10-14 — «Створити → провести → скасувати» на клієнті й загублена відповідь — §8.2

**Сигнал:** `SupplierPaymentCreateModal`: помилка `confirm` → `cancel` у `catch {}` → показ помилки.
Якщо сервер оплату провів, а відповідь не дійшла, `cancel` відмовляє (проведену не скасувати), відмова
ковтається, і повторний клік створює й проводить другу оплату. **Фікс:** `settlePayment` читає стан
документа; `pendingIdRef` тримає оплату з невідомою долею до з'ясування. **Severity:** IMPORTANT

### 2026-10-14 — Посилання з каси на замовлення для ролі без доступу — §8.4

**Сигнал:** номер замовлення-підстави в історії каси був кнопкою для всіх ролей: бухгалтер потрапляв
на графік оплат без картки, приймальня — на `/403`. **Фікс:** проп `canOpenPurchaseOrders`, решті —
текст. **Severity:** IMPORTANT

### 2026-10-14 — повний текст пункту «Date-picker → ISO» (перенесено із секції заради ліміту розміру) — §8.6

**Date-picker `YYYY-MM-DD` → ISO конверсія без LOCAL-parse.** `new Date(`${d}T00:00:00`).toISOString()` парсить рядок у TZ **браузера**, потім у UTC → у браузерах з додатнім offset (Kyiv UTC+3) дата зсувається на **-1 день** (`2026-09-10T00:00:00` local → `2026-09-09T21:00:00Z`). Day-based min/max арифметика → канонічний `addDaysISO(kyivToday(), N)` (UTC-математика, `lib/format.ts`), НЕ ручний `new Date + setDate + toISOString().slice`. Payload «до кінця дня» → `${d}T23:59:59Z`(UTC end-of-day). Sample:`WarrantyCreateModal` (abe63125). (Деталі: запис 2026-09-09)

### 2026-10-14 — повний текст пункту «FORM-схема кома-aware» (перенесено із секції заради ліміту розміру) — §8.2

**FORM-схема (`*FormSchema`) валідує СИРИЙ рядковий стан форми → числові поля мусять бути кома-aware (UA `1,5`).** Коли модалка гейтить submit через `safeParse(getValues())`, а числові інпути (quantity/price/normoHours/hours) — вільний рядок, поля схеми з `numericString()`/`z.coerce.number()` (обидва роблять `Number(v)`; `Number('1,5')=NaN`) ВІДХИЛЯЮТЬ легітимний UA-десятковий роздільник → submit блокується хибним zod-issue («Кількість повинна бути більшою за нуль»), хоча значення валідне. Локальні гейти (`toNumberOrUndefined`, що робить `.replace(',', '.')`) кому приймають → розсинхрон гейт↔payload. Fix: у FORM-схемі — `moneyString()` (обов'язкове) / `optionalMoneyNumber()` (опційне) / inline `typeof v==='string'?Number(v.replace(',','.')):v` preprocess. ENDPOINT-схеми (той самий файл, споживає контролер) лишаються `numericString`/`coerce` — там payload вже numeric JSON. `parseFloat('1,5')=1` (тихе усічення) — теж баг, ще гірший. Grep: `grep -rn "safeParse(getValues())" apps/web/src` → для кожної модалки перевірити чи її `*FormSchema` числові поля кома-aware; `grep -nE "numericString\(\)|z\.coerce\.number" packages/shared/src/schemas/forms/*.schema.ts` → кожне у _Form_-схемі = підозра. Sample: work-order.schema FORM quantity/normoHours/price (d8a569aa). Severity: IMPORTANT — fail-closed, блокує легітимний submit для UA-локалі

### 2026-10-14 — Вікно оплати пропонувало каси іншої валюти — §8.2

**Сигнал:** поле «Каса» вікна «Оплатити» рахунку брало всі каси; валюта оплати — валюта каси, і сервер відхиляє оплату в касу іншої валюти, ніж рахунок («Валюта оплати має збігатися з валютою рахунку»). Замовчування способу в доларовій касі заповнювало поле касою, яку сервер гарантовано відхилить. **Фікс:** фільтр `(r.currencyCode || baseCode) === (invoice.currencyCode || baseCode)`; запасна опція «замовчування поза першими 200» додається, лише коли каси немає в переліку взагалі, а не коли її відсіяв фільтр. **Severity:** SUGGESTION

### 2026-10-14 — Прибрана опція `<select>` ховала вже збережене значення — §8.2

**Сигнал:** правило заборонило варіант («Готівка» → банківський рахунок, BR-PAY-019), і опцію
прибрали з `<select>` умовою `{!cashOnly && <option …>}`. Значення, збережене ДО правила, лишилось
у стані форми, але опції для нього немає: браузер показує першу опцію («— не вказано —»), а вибрати
саме її не дає — вибір уже показаної опції `change` не породжує. Зняти застаріле значення можна
було лише обхідним шляхом. jsdom цього не видно: `fireEvent.change` викликає `onChange` завжди.
**Grep:** `grep -rnE "\{!\w+ && <option" apps/web/src --include=*.tsx` → для кожної умовної опції
перевірити, чи поточне `value` може бути саме нею (дані з БД, створені до правила).
**Фікс:** коли поточне значення — заборонена опція, лишати її `disabled` з поясненням
(`errorMessage`); тест перевіряє `select.value`, а не лише перелік опцій. Sample: `ndi/PaymentsTab.tsx`
(e4660f70). **Severity:** IMPORTANT

### 2026-10-15 — Форма шле незмінений FK, який могли видалити; рольовий гейт пропом без тесту — §8.2

**Сигнал 1:** НДІ → «Реквізити» шле в кожному PATCH `bankAccountId` з форми. Збережений основний
рахунок видалили — форма показує «Рахунок недоступний (видалений)», а сервер на кожне збереження
відповідає 404 «рахунок не знайдено»: телефон, e-mail, ІПН не зберігаються, доки користувач сам не
здогадається скинути вибір рахунку. Серверна половина цього ж класу — `sections/api.md` (перевірка
FK з наявного стану робить запис нередагованим).
**Grep:** `grep -rnE "[a-zA-Z]+Id: [a-zA-Z]+Form\.[a-zA-Z]+Id \|\| null" apps/web/src --include=*.tsx`
→ для кожного: чи сервер перевіряє FK (`findFirst … deletedAt: null` → 404) і чи може збережене
значення зникнути. **Фікс:** шлемо поле лише коли його змінили (`changed ? value || null : undefined`);
тест — збережений id відсутній у списку, правиться інше поле, у тілі PATCH ключа немає
(`OrgInfoTab.tsx`, 75744449).

**Сигнал 2:** «Друк рахунку» в `InvoiceSection` гейтився пропом `canPrint`, який сторінка рахувала з
ролі. Тест компонента перевіряв лише проп, а сторінка тестів не має: мутація `canPrint` → `true`
у `PageClient` вижила (механік бачив би кнопку, сервер — 403). **Фікс:** гейт ролі — у самому
компоненті (`useAuth()` + константа ролей), тест мокає `@/lib/auth` і перебирає ролі.
**Severity:** IMPORTANT

### Enum-axis розширення — повний текст пункту §8.2 (перенесено з `sections/web.md` 2026-10-15)

**Enum-axis розширення → знайти ВСІ inline списки TX_TYPES (sibling-drift)**: коли розширюється enum-value що впливає на знак/колір/семантику (`SettlementTransactionType` += SUPPLIER_CHARGE/PAYMENT/REFUND), оновлення однієї TX_LABELS/COLORS/BALANCE_UP-мапи НЕ достатньо. Grep за старими values (`['PAYMENT','PREPAYMENT','REFUND','CREDIT_NOTE']`, `type === 'CHARGE'`, `.includes(t.type)`, `TX_COLORS`, `TX_LABELS`) по apps/web/src → кожна копія оновлюється ідентично (module-level Set + коментар-посилання на бекове BALANCE_SIGN як SSOT). Sample: 23ce9109 оновив SettlementsTabContent, але sibling `counterparties/[id]/PageClient.tsx:1331,1336` мав власну inline-копію без SUPPLIER_CHARGE → отримання товару малювалось «+ red». Правило: після 3-го consumer → shared helper у `lib/utils.ts`. Grep: `grep -rnE "\.includes\(t\.type\)" apps/web/src`, `grep -rn "TX_LABELS\|TX_COLORS" apps/web/src`

### 2026-10-15 — `aria-label` на span без ролі; лічильники під `opacity-60` і на heat-map — §8.5

**Сигнал:** вид «Місяць» (BR-CAL-008) показував у кнопці дня категорії як `<span aria-label="Прострочено: 2"><Icon aria-hidden/>2</span>`. Назва на `span` (роль generic) заборонена ARIA 1.2 — назва кнопки збирається з вмісту, і читач озвучує «14 2 1» без категорій. Тест `getByLabelText` її знаходив і був зелений. Окремо: `opacity-60` на кнопці минулого дня гасив і лічильники — «прострочено» стоїть саме в минулих днях; на фоні 50% primary (світла тема) контраст кольорів категорій 2.2–3.3:1, з `opacity-60` — 1.5–2.1:1.
**Grep:** `grep -rn -A8 "<span$" apps/web/src --include=*.tsx | grep aria-label=`; `grep -rnE "<span[^>]*aria-label=" apps/web/src --include=*.tsx | grep -v role=`
**Фікс:** `role="img"` на значку з числом (діти стають презентаційними, дубля «2» немає); тест `getByRole('img', { name })`. Блідість минулого дня — фоном (`alpha × 0.6`) і числом дня, не `opacity` всієї кнопки; рядок лічильників — на підкладці `bg-surface` (≥ 4.4:1 в обох темах). Sample: `calendar/CalendarMonthView.tsx`. **Severity:** IMPORTANT

### 2026-10-15 — легенда «?» календаря: `role="dialog"` без фокусу й без закриття за фокусом; знімок «відкрито з місяця» не скидався; пізня відповідь дня — §8.5, §3.1

**Сигнал:** (1) `CalendarLegend` — панель `role="dialog"` під кнопкою, Escape і клік поза — на `document`; фокус у панель не переходив, вихід фокусу (Tab на картку місяця, відкриття форми) легенду не закривав — вона лишалась над сторінкою, і Escape, призначений модалці, закривав обидві. (2) `useCalendarState`: `monthEditSlot` (знімок запису для правила «минулий за `endAt`», BR-CAL-009) скидали лише `handleModalClose`/`handleModalSaved`; кнопка «+ Слот» закриває форму через `setShowAdd`, і пізніше той самий запис із виду «День» отримував правило місяця. (3) `load` дня без токена запиту; довантаження наступного дня (кінець ланцюжка, BR-CAL-008) додало третій запит у `Promise.all` — пізня відповідь попереднього дня при швидкому «‹ ›» перезаписувала новий.
**Grep:** `grep -rln 'role="dialog"' apps/web/src --include=*.tsx | xargs grep -L "onBlur\|useFocusTrap\|<Modal"`; `grep -n "const load = useCallback" -A4 apps/web/src/app --include=*.ts -r | grep -c "ReqRef\|cancelled"`
**Фікс:** (1) `panelRef.focus()` при відкритті, `tabIndex={-1}`, `onBlur` на корені: `relatedTarget` поза коренем → закрити (`null` — ні). (2) `handleEditSlot` скидає знімок, `openMonthSlot` ставить його після. (3) `loadReqRef` + `isStale()` у then/catch/finally. Тести доведені мутацією. Sample: `calendar/CalendarLegend.tsx`, `useCalendarState.ts` (review 60ec2d47). **Severity:** IMPORTANT (1, 3), SUGGESTION (2)

### 2026-10-18 — масова дія без правил одиночної; «дзеркальний» список статусів розійшовся — §8.5

**Сигнал:** сторінка «Купівля»: масове видалення замовлень, вже переданих постачальнику через API, давало
тост-помилку без підтвердження «скасуйте в кабінеті» і повтору з `force` (BR-SCON-014), хоча одиночне це
вміло; `SENT_EXTERNAL_STATUSES` у web без SENDING, а бекенд SENDING вважав відправленим.
**Grep:** `grep -rn "SENT_.*STATUSES" apps/api/src apps/web/src --include="*.ts"` — порівняти множини.
**Фікс:** `useSentOrderForce().runMany` — одне спільне підтвердження, повтор із force лише для відправлених;
SENDING у web-переліку; тести `SupplierApiOrderBlock.test.tsx`, `useSupplierApi.test.tsx`.
**Severity:** IMPORTANT

### 2026-10-18 — форма зміни запису не шле відкріплений наряд — §8

**Сигнал:** форма запису календаря очищує наряд (поле «×» чи зміна клієнта з діалогом «наряд буде
відкріплено»), а тіло PATCH має `workOrderId: form.workOrderId || undefined` — сервер зберігав
зв'язок. Після BR-WO-024 новий час такого запису ще й переносився у ВІДКРІПЛЕНИЙ наряд.
**Grep:** `grep -rnE "Id: form\.\w+ \|\| undefined" apps/web/src --include=*.tsx`
**Фікс:** `workOrderId: form.workOrderId || (editingSlotId ? null : undefined)`; тест — тіло PATCH
після «×» має `workOrderId: null` (мутацією підтверджено), API — `updateCalendarSlot` з `null` не
чіпає наряд. **Severity:** IMPORTANT

### 2026-10-19 — Причина блокування замість назви кнопки рядка — §8.5

**Сигнал:** у переліку «Без підйомника» заблокований кошик запису наряду (BR-WO-026) отримав
`aria-label` = текст причини; назва «Видалити слот 13:00–14:00» зникла, і два заблоковані записи
звучали для читача екрана однаково. Форма запису робила правильно — `aria-describedby`.
**Grep:** `grep -rn "aria-label={$" -A2 apps/web/src --include=*.tsx | grep -E "Hint \?\?|Locked \?\?"`
**Фікс:** `aria-label` — назва рядка; причина — `sr-only` з `useId()` + `aria-describedby`; тест —
`getByRole('button', { name: /^Видалити слот 13:00/ })` + `toHaveAccessibleDescription(hint)`.
Inline IIFE у JSX заодно винесено в іменований компонент (§8.6).
**Severity:** SUGGESTION

### 2026-10-21 — Запасний текст помилки в `.ts`-хуку без i18n — §8.2.2

**Сигнал:** `useCalendarState.ts` показував `toast.error(e instanceof Error ? e.message : 'Помилка переміщення слоту')`
(і ще три такі рядки) поруч із уже перекладеними `t('slot.errDeleteFallback')`; в en-інтерфейсі відмова
перетягування без причини давала український тост. Блоковий review його не бачив: grep §8.2.2 шукав
лише `*.tsx`. **Grep:** `grep -rnE "(toast\.[a-z]+|setError)\(.*: '[^']*[А-Яа-яІіЇїЄєҐґ]" apps/web/src --include="*.ts" | grep -v "__tests__\|\.test\."`
**Фікс:** ключі `calendar:slot.errLoad|errMoveFallback|errUpdateFallback`, `t` у залежностях колбеків;
en-тест на відмову PATCH без `Error`. **Severity:** SUGGESTION

### 2026-10-21 — Прапорець вікна вибору знову знятий в ефекті «бо під час події він ще true» — §3.1

**Сигнал:** Bug #923 (`CreateWorkOrderModal`, `nestedPickerOpenRef`) — фікс тестувальника знімав
прапорець у `useEffect` із коментарем «ref оновлюється після рендера, відкладене зняття не потрібне».
Це правда лише поки слухач картки стоїть першим; у браузері React рендерить між слухачами однієї
події (запис 2026-10-12). Чекліст §3.1 правило мав, але детектора не було.
**Grep:** `grep -rnE -B1 "^\s+[a-zA-Z]+OpenRef\.current = [a-zA-Z!][a-zA-Z.!]*;" apps/web/src --include=*.tsx | grep -A1 useEffect`
**Фікс:** `true` — одразу, `false` — `setTimeout(…, 0)` з `clearTimeout` у cleanup (повторне
відкриття до спрацювання). Тест: два синхронні `act(() => fireEvent.keyDown(…))` — рендер між
ними відтворює рендер між слухачами; мутація «зняти в ефекті» валить його. **Severity:** IMPORTANT

### 2026-10-22 — Автовибір за Float-залишком і без шляху на помилку — §8.2

**Сигнал:** BR-WO-029: склад рядка наряду обирається за `available > 0`, а залишок — сума Float по
рухах (dev-база: 2 рядки з дрейфом). `2.2 + 0.1 − 2.3 = 4e-16` → склад із підписом «0» обирався
сам. Окремо: вибір товару очищав склад і чекав відповіді `stock-totals`; запит упав → поле порожнє
назавжди (до правила склад був одразу).
**Grep:** `grep -rnE "available\s*>\s*0|quantity\s*-\s*[a-z.]*reserved" apps/web/src apps/api/src --include=*.ts --include=*.tsx | grep -v spec`
**Фікс:** округлення до 3 знаків, як `fmtQty` (і в api, і в web `freeOf`); на помилку запиту —
маркер `null` → правило «вільної немає» (основний), підписи без кількості. Тести з мутацією.
**Severity:** IMPORTANT

### 2026-10-22 — Перемикач з двох кнопок (одна ховається) губить фокус — §8.5

**Сигнал:** картка наряду (варіант A): «Згорнути» в секції шапки ховається разом із шапкою
(0fr + overflow-hidden — фокус лишається на невидимій кнопці), картка «Розгорнути» зникає
(`return null` — фокус на `<body>`).
**Grep:** `grep -rn "variant=\"card\"" apps/web/src --include=*.tsx | grep -v __tests__` → поруч
`toggleRef` і ефект фокусу.
**Фікс:** ref на обидві кнопки, прапорець «клік людини» (автозгортання фокус не забирає), ефект на
стан → `focus({ preventScroll: true })` на кнопку протилежної дії: без `preventScroll` фокус
прокручує анімований overflow-hidden контейнер, і верх шапки лишається зрізаним.
**Severity:** IMPORTANT

### 2026-10-22 — Перелік вужчий за дію: вікно оплати й `GET /bank-accounts` — §8.4

**Сигнал:** BR-PAY-023 додав у `ClientPaymentModal` обов'язкове поле «Рахунок» із переліком
`useBankAccountOptions` (`GET /bank-accounts` — OWNER/ADMIN/ACCOUNTANT). Оплату ж створює й
RECEPTIONIST (`POST /payments`). Для нього перелік — 403: «Не вдалося завантажити рахунки», поле
порожнє, кнопка неактивна — безготівкову оплату приймальня не могла внести взагалі, навіть зі
способом, у якого є рахунок за замовчуванням. Тести вікна auth не мокали (роль не існувала), моки
`apiFetch` віддавали рахунки будь-кому.
**Grep:** `git diff <base> -- apps/web/src | grep -nE "^\+.*use[A-Z][A-Za-z]*Options\("` → для
кожного хука: `@Roles` його GET проти `@Roles` дії вікна.
**Фікс:** `BANK_LIST_ROLES` — запит лише для ролей із переліком; рахунок способу додано в перелік із
назвою й валютою від `GET /payment-methods` (дзеркало каси за замовчуванням); без нього — пояснення
«способу не задано рахунку у валюті …». Тести з роллю RECEPTIONIST, мутації (без підстановки, без
гейту ролі) валять їх.
**Severity:** IMPORTANT

### 2026-10-22 — Запит за `?open=` вимикається разом із параметром — §8.5

**Сигнал:** вкладка «Гарантії»: `useWarrantyList({ id: linkId }, !!linkId)`, а `linkId` — з адреси,
яку вкладка відразу чистить (`router.replace`). Після звернення `warrantiesKeys.all` перечитує лише
активні запити; гарантія з посилання поза поточною сторінкою списку лишалась у панелі зі старим
станом і кнопкою «Звернення» (повтор — 400).
**Grep:** `grep -rlE "searchParams\.get\('open'\)" apps/web/src/app --include=*.tsx | xargs -d '\n' grep -nE "!!(link|open)[A-Za-z]*"`
**Фікс:** `linkedQueryId = linkId ?? (openedByLink ? selected?.id : undefined)` — запит живе, доки
рядок у панелі. Тест: `replace` у моку прибирає `open` з адреси, після звернення кнопки немає.
**Severity:** SUGGESTION

### 2026-10-22 — en-лічильник без plural і хук без 'use client' після i18n-міграції — §8.2.2

**Сигнал:** батч A компонентів (0c168423): en `"{{n}} works"`, `"{{n}} templates"` при uk в одній формі («{{n}} шаблонів») →
«1 templates»; `doc-lines-header.tsx` отримав `useTranslation` без `'use client'` (імпортери поки клієнтські, але
серверний `page.tsx` уже рендерить `Spinner` у `Suspense fallback`).
**Grep:** `grep -nE '"\{\{n\}\} [a-z]+s"' apps/web/src/i18n/locales/en/*.json`; хук без директиви — цикл у `sections/web.md` §8.2.2.
**Фікс:** en «Works: {{n}}» / «Templates: {{n}}» (uk і паритет ключів не змінюються); `'use client'` у файл (e3b792e4).
**Severity:** SUGGESTION

### 2026-10-22 — Вбудована дитина картки лишилась українською (вдруге) — §8.2.2

**Сигнал:** батч B (d63c80d7) переклав `CreateWorkOrderModal`, `WorksTable`, `PartsTable`, а вбудований
`work-order/InvoiceConflictDialog` («Рахунок вже існує», три кнопки) лишився без `t()` — у en-картці
український діалог. Той самий клас, що `CategoryTree` у `GoodPickerModal` (2026-10-19): пункт чекліста
є, але виконавець батчу ганяв grep лише по файлах із diff-у.
**Grep (діти зміненого файла, де лишилась кирилиця поза коментарями):**
`F=<файл>; for f in $(grep -oE "from '(\./|@/components/)[^']+'" $F | sed -E "s/from '(@\/)?//;s/'//;s#^components#apps/web/src/components#;s#^\./#$(dirname $F)/#"); do for x in $f.tsx $f.ts; do [ -f "$x" ] && perl -0777 -CSD -ne 's{/\*.*?\*/}{}gs; s{(?<!:)//[^\n]*}{}g; print "$ARGV\n" if /\p{Cyrillic}/' "$x"; done; done`
(коментарі, і багаторядкові `{/* … */}`, вирізаються до пошуку; на `CreateWorkOrderModal` після фіксу — порожньо, на
`InvoiceConflictDialog` до фіксу — влучання)
**Фікс:** ключі `workOrders:invoice.conflict.*` (uk байт-у-байт) + `common:cancel`; локаль-тест uk/en із
мутацією (5d2e293e). **Severity:** IMPORTANT

### Перенесено з чекліста — Дві форми — одна сутність (field-desync) — §8.2

**Дві форми що редагують ОДНУ сутність → спільний контрольований компонент + ОДИН `formToPatch` (field-desync).** Коли сутність (Counterparty) редагується у ДВОХ місцях (EditModal + DetailPage inline-edit), кожне з власним state-shape/PATCH — набори полів дрейфують: одне поле «не чіпається» з одного місця й затирається з іншого. Fix (dedup 0c68a1cc): один controlled-компонент (`CounterpartyForm`) + хелпери (`emptyX`/`xToForm`/`formToPatch`/`validateX`) — обидва callsites шлють ІДЕНТИЧНЕ `formToPatch`-тіло. Перевірити: (1) немає залишків старих patch-об'єктів; (2) `formToPatch` порожні рядки → `undefined` (безпечно ЛИШЕ якщо бек `dto.X !== undefined ? dto.X : existing.X`; навмисне очищення → `''→null`); (3) після дедупу grep осиротілі імпорти/const у ОБОХ файлах (`PhoneInput`, локальні `TYPE_LABELS`-мапи) — tsc не ловить (немає `noUnusedLocals`), eslint лише `warn`. Sample cf6058cd
