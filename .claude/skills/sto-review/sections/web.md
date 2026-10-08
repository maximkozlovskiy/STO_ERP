# sto-review — секція: Web: React, Next.js, memory leaks (§3, §8)

> Частина скіла `sto-review`. Алгоритм і матриця «тип зміни → секції» — у `../SKILL.md`.
> Читати цілком, коли матриця призначила хоч один § цього файла.
> Реальні випадки з детекторами: `../journal/web.md` (шукати, не читати цілком).

### §3 Memory Leaks

#### §3.1 React Hooks

```bash
# addEventListener/setInterval/setTimeout без cleanup
grep -rn "addEventListener\|setInterval\|setTimeout\b" apps/web/src/ --include="*.tsx" --include="*.ts" \
  | grep -v "clearTimeout\|clearInterval\|removeEventListener\|spec" | head -20
# debounceRef без clearTimeout у cleanup
grep -rn "debounceRef\|pollRef\|timerRef" apps/web/src/ --include="*.tsx" | grep -v "clearTimeout\|spec"
# fetch без cancelled flag або AbortController
grep -rn "apiFetch\|apiBlobFetch" apps/web/src/app/ --include="*.tsx" -B2 | grep "useEffect" | head -20
# Статичні константи у render body (нова RegExp/Set/Map кожен рендер)
grep -rnE "^\s+const [A-Z_]+\s*=\s*(\/|new (Set|Map|RegExp))" apps/web/src/app --include="*.tsx"
# memo з inline array/object prop (memo марний)
grep -rnE "<[A-Z][A-Za-z]+[^>]*=\{[a-zA-Z.]+\.(filter|map|slice)\(" apps/web/src/app --include="*.tsx"
# closest()/matches() на data-атрибут якого бібліотека НЕ ставить (dnd-kit attributes = role/aria-*)
grep -rnE "closest\(['\"]?\[data-(dnd-draggable|dnd|rdnd)" apps/web/src/ --include="*.tsx"
# pointer interaction state — leave-handler має скидати ВСІ режими
grep -rn "onPointerLeave\|PointerLeave" apps/web/src/app --include="*.tsx"
# requestAnimationFrame без id-capture (cancelAnimationFrame неможливий)
grep -rnE "^\s*requestAnimationFrame\(" apps/web/src/app apps/web/src/components --include="*.tsx"
# imperative style.* мутації у callback (rAF/RO/setTimeout) — перевірити unmount cleanup
grep -rnE "\.style\.(height|transition|marginBottom|opacity|transform)\s*=" apps/web/src/app --include="*.tsx"
# Anchored popup useLayoutEffect deps [anchorRef] — стейл позиція при re-open
grep -rnE "useLayoutEffect\(.*\}, \[anchorRef\]\)" apps/web/src/components/ui --include="*.tsx"
# Nested overlay Esc handler у bubble-фазі — закриває батьківський Modal
grep -rnE "document\.addEventListener\(['\"]keydown" apps/web/src/components/ui --include="*.tsx" --include="*.ts"
# Портальний попап (createPortal) БЕЗ власного Esc — у <Modal> Escape закриє модалку, а не попап
# (tooltip.tsx у виводі — норма: неінтерактивний)
grep -rl "createPortal" apps/web/src/components/ui --include="*.tsx" | grep -v __tests__ \
  | xargs -d '\n' grep -L "keydown\|onKeyDown\|<Modal\|useFocusTrap"
# Spread SyntheticEvent з заміною target — ламає прототип
grep -rnE "\{\s*\.\.\.e\s*,\s*target:\s*\{\s*\.\.\.e\.target" apps/web/src/ --include="*.tsx" --include="*.ts"
# Skip-first-run ref поруч з toggle-useEffect — перевірити скидання у parent-key useEffect (дубль-fetch на switch)
grep -rnE "(Loaded|Mounted|Inited|SkipFirst)Ref\s*=\s*useRef\(false\)" apps/web/src/ --include="*.tsx"
# Side-effect (apiFetch/fetch) ВСЕРЕДИНІ state-updater setX(prev => {...}) — updater має бути ЧИСТИМ (StrictMode double-invoke → дубль-GET)
grep -rnE "set[A-Z][A-Za-z]*\((prev|cur|p)\s*=>" apps/web/src/app apps/web/src/components --include="*.tsx" -A4 \
  | grep -E "apiFetch|apiBlobFetch|fetch\(" | head -10
```

- [ ] `addEventListener` → `return () => removeEventListener`
- [ ] `setInterval` / `setTimeout` → `return () => clearInterval / clearTimeout`
- [ ] `debounceRef.current` → `clearTimeout` у cleanup (HTTP запит стартує навіть якщо mounted=false)
- [ ] `useEffect` з `apiFetch` → `let cancelled=false; ... if (!cancelled) setState(...); return () => { cancelled=true }`
- [ ] Stateless константи (RegExp, Set, Map) → module-level, не у render body
- [ ] `memo(Component)` → пропси стабільні референції (через `useMemo` Map, не inline `.filter()`)
- [ ] Inline `ref={el => el.indeterminate = x}` → `useRef` + `useEffect([dep])` (крихко при React Compiler)
- [ ] `target.closest('[data-X]')` → атрибут реально рендериться у DOM (dnd-kit НЕ ставить `data-dnd-draggable`); додати власний `data-Y` маркер
- [ ] `onPointerLeave` → скидає **ВСІ** pointer-режими (drawing **і** resizing)
- [ ] `requestAnimationFrame` що мутує DOM/state → id у `useRef<number|null>(null)`; `cancelAnimationFrame` на toggle + у unmount `useEffect(() => () => {...}, [])`
- [ ] Pair `setTimeout` + `rAF` для анімації → обидва id у refs; cleanup у dedicated unmount-effect
- [ ] `<Input>` wrapper з mask → НЕ `{ ...e, target: {...e.target, value: X} }` (ламає SyntheticEvent прототип); мутувати `e.target.value` напряму
- [ ] Skip-first-run ref (`*LoadedRef`) у toggle-useEffect → parent-key useEffect (фаєрить при зміні CP/entity-id) скидає `ref.current = false` (інакше дубль-fetch при switch — main + toggle); ref-декларація перед useEffect що її використовує (TDZ при refactor)
- [ ] Side-effect (`apiFetch`/`fetch`) НЕ всередині state-updater `setX(prev => {...})` — updater чистий; StrictMode double-invoke дублює запит. toggle-рішення (клік по вже-вибраному → закрити) через синх `selectedIdRef`, не читання `prev` в updater-і. Sample (audit 6405c3a9): `selectPO` робив довантаження у `setSelectedPO(prev => { apiFetch(...); return po })`

#### §3.2 Backend

```bash
grep -rn "findMany(" apps/api/src/ --include="*.ts" | grep -v "take:\|spec"
```

- [ ] `findMany` без `take` — потенційний OOM
- [ ] **Full-scan job (reconciliation/audit/drift-detection/per-org invariant-check) що МУСИТЬ покрити ВСІ рядки → keyset-пагінація, НЕ голий `take: N`.** У list-endpoint `take: N` коректний. Але у job-і, що звіряє інваріанти по всій орг, `take: N` тихо ОБРІЗАЄ скан → дрейф за рядком N непомічений = хибна впевненість (гірше за OOM). Fix: keyset-loop по `id` (еталон `forEachActiveOrg`, Bug #107): `orderBy:{id:'asc'}, take: BATCH, ...(cursor ? {skip:1, cursor:{id}} : {})`, `if (rows.length < BATCH) break`. Агрегати (`groupBy`/`_sum`) — SQL-side → пагінація НЕ потрібна. Sample: A3 reconciliation.processor. Grep: `grep -rn "findMany(" apps/api/src/**/*.processor.ts apps/api/src/**/*.scheduler.ts | grep -v take`
- [ ] Немає `new PrismaClient()` поза `PrismaService`
- [ ] `$transaction` має `{ timeout: N }` (5000–15000ms)
- [ ] Prisma `include` без циклічних зв'язків (A → B → A)

---

### §8 Web Frontend

#### §8.1 API Calls

```bash
# Прямий fetch без apiFetch
grep -rn "fetch(" apps/web/src/ --include="*.tsx" --include="*.ts" | grep -v "apiFetch\|api-client\|auth/context\|spec"
# apiBlobFetch / apiMultipartFetch без Array.isArray message guard
grep -n "message?: string\b\|message: string\b" apps/web/src/lib/api-client.ts
```

- [ ] Всі API → `apiFetch` / `apiBlobFetch` / `apiMultipartFetch` (не прямий `fetch`)
- [ ] Всі три helpers мають `Array.isArray(body.message) ? body.message.join('; ') : body.message`
- [ ] GET dedup у `api-client` → guard `!init?.signal` (abort одного caller не вбиває інших)
- [ ] Manifest static assets фізично існують у `public/`:
  ```bash
  jq -r '.icons[].src' apps/web/public/manifest.json 2>/dev/null \
    | while read p; do [ -f "apps/web/public${p}" ] || echo "MISSING: $p"; done
  ```

#### §8.2 UI Стани

```bash
# .catch(() => {}) на fetch — ховає помилки
grep -rn "\.catch(() => {})" apps/web/src/app/ --include="*.tsx"
# loading оголошений але setLoading(true) відсутній (для кожного — перевірити setLoading(true) перед fetch)
grep -rn "const \[loading.*false" apps/web/src/app/ --include="*.tsx" | head -10
# saving глобальний замість per-row
grep -rn "saving\b" apps/web/src/app/ --include="*.tsx" | grep "useState(false)" | head -5
# Paired display-name FK — обидва не скидаються разом
grep -rnE "setForm\(.*Id: ['\"]['\"]" apps/web/src/app/ --include="*.tsx"
# Event-handler fetch (openEdit/openCard/onSelect) що setState після resolve — без request-token guard
grep -rnE "const (open|load|select|fetch)[A-Z][A-Za-z]* = (async )?\(" apps/web/src/app/ --include="*.tsx" -A30 \
  | grep -E "apiFetch" | head -20
# Для кожного handler-fetch: re-виклик для іншого id → token-ref/AbortController + reset похідного стану на старті
```

- [ ] Кожен list-fetch: `setLoading(true)` перед; `.catch(setError)`; `.finally(() => setLoading(false))`; `{!loading && items.length===0 && <EmptyState/>}`
- [ ] `saving: boolean` → `savingId: string | null` (per-row, не глобальний)
- [ ] `error` page-level ≠ `formError` (не перезаписувати)
- [ ] Paired FK state (`counterpartyId` + `counterpartyDisplayName`) → скидати **обидва** на onClose/POST success/onClear
- [ ] Fetch у обробнику події → token-ref (`++ref.current`; `if (ref.current !== reqId) return`) + скинути похідний стан
- [ ] **Ручний `safeParse(getValues())` у submit-хендлері (useFieldArray-модалка без `handleSubmit`) → `!success`-гілка показує ПЕРШИЙ zod-issue.message, НЕ хардкод про шапку.** Кнопка вже `disabled={!supplierId||!warehouseId}` → реальний фейл майже завжди у рядку (порожня ціна/кількість) → хардкод «Оберіть постачальника» вводить в оману. Fix: `firstSchemaError(err)` = `err.issues[0].message` + префікс `Рядок N:` для `path[0]==='lines'`. Grep: `grep -rn "safeParse(getValues())" apps/web/src/components --include="*.tsx"`. Sample: PurchaseOrderCreateModal (cf7de79c)
- [ ] **FORM-схема (`*FormSchema`) валідує СИРИЙ рядковий стан форми → числові поля мусять бути кома-aware (UA `1,5`).** Коли модалка гейтить submit через `safeParse(getValues())`, а числові інпути (quantity/price/normoHours/hours) — вільний рядок, поля схеми з `numericString()`/`z.coerce.number()` (обидва роблять `Number(v)`; `Number('1,5')=NaN`) ВІДХИЛЯЮТЬ легітимний UA-десятковий роздільник → submit блокується хибним zod-issue («Кількість повинна бути більшою за нуль»), хоча значення валідне. Локальні гейти (`toNumberOrUndefined`, що робить `.replace(',', '.')`) кому приймають → розсинхрон гейт↔payload. Fix: у FORM-схемі — `moneyString()` (обов'язкове) / `optionalMoneyNumber()` (опційне) / inline `typeof v==='string'?Number(v.replace(',','.')):v` preprocess. ENDPOINT-схеми (той самий файл, споживає контролер) лишаються `numericString`/`coerce` — там payload вже numeric JSON. `parseFloat('1,5')=1` (тихе усічення) — теж баг, ще гірший. Grep: `grep -rn "safeParse(getValues())" apps/web/src` → для кожної модалки перевірити чи її `*FormSchema` числові поля кома-aware; `grep -nE "numericString\(\)|z\.coerce\.number" packages/shared/src/schemas/forms/*.schema.ts` → кожне у _Form_-схемі = підозра. Sample: work-order.schema FORM quantity/normoHours/price (d8a569aa). Severity: IMPORTANT — fail-closed, блокує легітимний submit для UA-локалі
- [ ] **Cross-field guard на беку → знайти ВСІ frontend-entry-points**: коли додано backend-cross-field валідацію (`hasCounterpartyName`), grep `POST /<endpoint>` по apps/web/src → **кожен** callsite має власний frontend guard з ідентичною логікою (**trim + OR + одне повідомлення**). Sample: guard у CounterpartyEditModal, але CalendarSlotModal-wizard мав власний `!x && !y` без trim → whitespace-only обходило. Grep: `grep -rn "'/counterparties'" apps/web/src`
- [ ] **Дві форми що редагують ОДНУ сутність → спільний контрольований компонент + ОДИН `formToPatch` (field-desync).** Коли сутність (Counterparty) редагується у ДВОХ місцях (EditModal + DetailPage inline-edit), кожне з власним state-shape/PATCH — набори полів дрейфують: одне поле «не чіпається» з одного місця й затирається з іншого. Fix (dedup 0c68a1cc): один controlled-компонент (`CounterpartyForm`) + хелпери (`emptyX`/`xToForm`/`formToPatch`/`validateX`) — обидва callsites шлють ІДЕНТИЧНЕ `formToPatch`-тіло. Перевірити: (1) немає залишків старих patch-об'єктів; (2) `formToPatch` порожні рядки → `undefined` (безпечно ЛИШЕ якщо бек `dto.X !== undefined ? dto.X : existing.X`; навмисне очищення → `''→null`); (3) після дедупу grep осиротілі імпорти/const у ОБОХ файлах (`PhoneInput`, локальні `TYPE_LABELS`-мапи) — tsc не ловить (немає `noUnusedLocals`), eslint лише `warn`. Sample cf6058cd
- [ ] **Enum-axis розширення → знайти ВСІ inline списки TX_TYPES (sibling-drift)**: коли розширюється enum-value що впливає на знак/колір/семантику (`SettlementTransactionType` += SUPPLIER_CHARGE/PAYMENT/REFUND), оновлення однієї TX_LABELS/COLORS/BALANCE_UP-мапи НЕ достатньо. Grep за старими values (`['PAYMENT','PREPAYMENT','REFUND','CREDIT_NOTE']`, `type === 'CHARGE'`, `.includes(t.type)`, `TX_COLORS`, `TX_LABELS`) по apps/web/src → кожна копія оновлюється ідентично (module-level Set + коментар-посилання на бекове BALANCE_SIGN як SSOT). Sample: 23ce9109 оновив SettlementsTabContent, але sibling `counterparties/[id]/PageClient.tsx:1331,1336` мав власну inline-копію без SUPPLIER_CHARGE → отримання товару малювалось «+ red». Правило: після 3-го consumer → shared helper у `lib/utils.ts`. Grep: `grep -rnE "\.includes\(t\.type\)" apps/web/src`, `grep -rn "TX_LABELS\|TX_COLORS" apps/web/src`

- [ ] **recharts `<Tooltip>` → `contentStyle` із `backgroundColor` і `color` на токенах теми.** Типовий фон підказки — білий, а підпис успадковує колір сторінки → у темній темі світлий текст на білому. Grep: `grep -rn "<Tooltip" -A8 apps/web/src --include="*.tsx" | grep -c backgroundColor` проти кількості `<Tooltip`. Sample: `MileageChart`, `RevenueChart` (journal 2026-10-07)
- [ ] **Новий `use*`-хук, чиї дані ПОХІДНІ від іншого агрегату (історія з нарядів, зведення з платежів) → його ключ додано у відповідний хелпер `lib/cache-invalidation.ts`.** Інакше сторінка, відкрита в межах `staleTime` після мутації джерела, показує старе. Grep: `grep -rn "Keys = {" apps/web/src/hooks/api` → кожен ключ має споживача в `cache-invalidation.ts` або власну мутацію. Sample: `vehicleMileageKeys` (journal 2026-10-07)

#### §8.2.1 Select race

```bash
grep -rnE "setForm.*[a-zA-Z]+Id:\s*['\"]['\"]|useState\(\{[^}]*[a-zA-Z]+Id:\s*['\"]['\"]" \
  apps/web/src/app/ --include="*.tsx" | grep -v "SearchCombobox"
```

- [ ] `<Select value={form.xxxId}>` де options асинхронні → `useEffect` синхронізація: `if (!form.xxxId && options[0]) setForm(f => ({...f, xxxId: options[0].id}))`

#### §8.2.2 i18n — двомовність uk/en (патерн MP-F7/MP-F7b)

```bash
# Хардкод-кирилиця у НОВОМУ/зміненому UI (має бути t()) — виключаємо коментарі/em-dash/₴/defaultValue
grep -rnE "'[^']*[А-Яа-яІіЇїЄєҐґ][^']*'|>[^<]*[А-Яа-яІіЇїЄєҐґ][^<]*<" apps/web/src/app apps/web/src/components \
  --include="*.tsx" | grep -vE "__tests__|// |'—'|₴|defaultValue|labelKey"
# zod-повідомлення інлайн-рядком (мають бути KEY 'v.*')
grep -rnE "\.(min|max|regex|email|refine)\([^)]*['\"][А-Яа-яІіЇїЄєҐґ]" packages/shared/src/schemas
# zodResolver напряму (має бути i18nZodResolver)
grep -rn "zodResolver(" apps/web/src --include="*.tsx" | grep -v "i18nZodResolver\|__tests__"
```

- [ ] Новий user-facing текст → `t('<ns>:<key>')`, НЕ хардкод-кирилиця (enum → `*Label()`-обгортка з `@/i18n/enumLabel`)
- [ ] Новий namespace зареєстровано у `i18n/resources.ts` + `config.ts` ns[]; uk/en leaf-key parity (flatten+compare)
- [ ] Мігрований рядок: uk-значення BYTE-IDENTICAL до оригіналу (тести асертять; звірити проти `git show <sha>~1`)
- [ ] Новий validation-key → у `messages.uk` + `messages.en` + `VALIDATION_KEYS` (guard: `validation-i18n-parity.spec`)
- [ ] Форми: `i18nZodResolver` (не `zodResolver`); recursive tree-walk skip-list не пропускає ім'я поля (`type`/`name`/`root`) — Bug #763
- [ ] Dead-translation: новий ключ-мапа має споживача (`t()` у рендері), інакше mute-гілка (Bug #762)
- [ ] `@sto/shared` змінено → `pnpm --filter @sto/shared build` перед api tsc (api на dist/cjs)

#### §8.3 Hydration Safety

```bash
grep -rn "localStorage\|sessionStorage\|window\.\|document\." apps/web/src/ \
  --include="*.tsx" --include="*.ts" | grep -v "useEffect\|'use client'\|spec"
```

- [ ] `localStorage` / `window.*` / `document.*` тільки в `useEffect` або `'use client'`
- [ ] `useState(() => localStorage.getItem(...))` → `useState(defaults)` + `useEffect` для read
- [ ] `useState(new Date())` → `useState('')` + `useEffect(() => setX(formatDate(new Date())), [])`
- [ ] `createPortal` → `mounted` guard

#### §8.4 Routing & Auth

```bash
# Таб-обгортка з розширеним useRequireAuth (union ролей заради ОДНОГО табу) — інші таби можуть 403-ити
grep -rnE "useRequireAuth\(\[[^]]*,[^]]*,[^]]*,[^]]*\]" apps/web/src/app --include="*.tsx"
```

- [ ] Захищені сторінки → `useRequireAuth(roles)` або redirect
- [ ] **Таб-обгортка що РОЗШИРЮЄ `useRequireAuth` guard заради одного табу → кожен інший таб gated за роллю, default-таб форсується на дозволений.** Патерн (audit 305ee759): «Склад» об'єднала «Документи складу» (`@Roles=OWNER/ADMIN/STOREKEEPER`) + «Залишки» (дозволяє RECEPTIONIST) під `['OWNER','ADMIN','STOREKEEPER','RECEPTIONIST']`. Наслідок: RECEPTIONIST проходить guard, але default-таб «Документи складу» 403-ить → банер помилки + порожні таблиці. Не витік (backend 403-ить коректно) — broken UX. Fix: `canSeeTab = ROLES.includes(employee.role)` дзеркалить `@Roles` кожного табу; приховати недозволені (`.filter`) + форсувати `activeTab`. Звірити ролі кожного inner-таба з `@Roles` його endpoints (`grep "@Roles" <controller>`)
- [ ] `/setup` має окремий `layout.tsx` без `AuthProvider`/`TopShell`
- [ ] PUBLIC_ROUTES (`/booking`, `/setup`, `/login`, `/403`) → `publicFetch`, не `apiFetch`

#### §8.5 UX Features

```bash
# toast без features.toastEnabled guard
grep -rn "toast\." apps/web/src/app/ apps/web/src/components/ --include="*.tsx" | grep -v "features\.toastEnabled\|// toast\|ToastContainer"
# Promise.all для bulk-мутацій (має бути allSettled)
grep -rn "Promise\.all(" apps/web/src/ --include="*.tsx" | grep -i "bulk\|map.*apiFetch" | grep -v "allSettled"
# indeterminate через inline ref (крихко)
grep -rn "indeterminate" apps/web/src/ --include="*.tsx" | grep -v "useEffect\|useRef\|//"
# Hover-only кнопки без focus-visible/focus → невидимі при Tab (WCAG 2.1.1); виключаємо pointer-events-none overlays
grep -rn "group-hover:opacity-100" apps/web/src/ --include="*.tsx" | grep -v "focus-visible:opacity-100\|focus:opacity-100\|pointer-events-none"
# Animation wrapper з власним if (!open) return null ламає exit-анімацію Modal
for f in $(grep -rl "if (!open) return null" apps/web/src/components/ui --include="*.tsx"); do
  has_modal_wrapper=$(grep -c "<Modal\b\|<PickerModal\b\|<SearchPickerModal\b" "$f")
  [ "$has_modal_wrapper" -gt 0 ] && echo "EXIT-ANIM BUG: $f має if(!open) перед <Modal>"
done
# Глобальний [data-state] селектор у globals.css без скоп-маркера (Radix/HeadlessUI використовують data-state як публічний контракт)
grep -nE "^\[data-state=" apps/web/src/app/globals.css | grep -v "data-animate"
# СТАНДАРТ списків: сторінка з <DetailPanel> МУСИТЬ мати <DetailPanelToggle> (Bug #496/#505)
for f in $(grep -rl "<DetailPanel\b" apps/web/src/app --include="*.tsx" | grep -v "detail-panel-toggle"); do
  grep -q "DetailPanelToggle" "$f" || echo "MISSING TOGGLE: $f має DetailPanel без DetailPanelToggle"
done
```

- [ ] Список із `<DetailPanel>` → має `<DetailPanelToggle>` (enabled/toggle з `useListPage().detailPanel` або `useDetailPanel(key)`); row onClick і панель гейтяться `detailPanel.enabled`
- [ ] `toast.X(...)` → `if (features.toastEnabled)`; fallback: `setError(msg)`
- [ ] Bulk-мутації → `Promise.allSettled` + `bulkSelect.clear()` + `load()` у finally
- [ ] `indeterminate` → `useRef` + `useEffect([dep])`, не inline `ref={el => el.indeterminate = x}`
- [ ] `useBulkSelect` → items prop оновлюється при `setData`
- [ ] Hover-only кнопки → `group-hover:opacity-100` **+ `focus-visible:opacity-100`** (виняток: `pointer-events-none` декоративні)

#### §8.6 Модульність UI

```bash
# Inline IIFE у JSX
grep -rnE "\{\(\(\) =>" apps/web/src/app/ --include="*.tsx"
# Нова <col> у <colgroup> але tfoot colSpan не оновлений (порівняти кількість <col> з colSpan-ами у tfoot/empty-state)
git diff HEAD~5 --unified=0 apps/web/src/components --include="*.tsx" 2>/dev/null | grep -E "^\+\s+<col\b"
# Дубльована date badge математика
grep -rn "86_400_000\|diffDays" apps/web/src/app/ --include="*.tsx" | grep -v "lib/utils\|expiry-badge"
# Date-picker YYYY-MM-DD → ISO через LOCAL-parse + toISOString() (off-by-one на межі дня; Kyiv UTC+3 → -1)
grep -rnE "new Date\(\`?\\\$?\{[a-zA-Z]+\}?T00:00:00\`?\)" apps/web/src --include="*.tsx" --include="*.ts"
grep -rnE "\.setDate\(.*getDate\(\) ?\+|\.setDate\(.*getDate\(\) ?-" apps/web/src/app apps/web/src/components --include="*.tsx"
# Власний picker не через picker-modal.tsx
grep -rn "<Modal" apps/web/src/app/ --include="*.tsx" -l
# Partial helper-migration: файл використовує і setPage(1) і resetPage() одночасно
for f in $(grep -rl "useListPage<" apps/web/src/app --include="*.tsx"); do
  has_set=$(grep -c "setPage(1)" "$f"); has_reset=$(grep -c "resetPage()" "$f")
  [ "$has_set" -gt 0 ] && [ "$has_reset" -gt 0 ] && echo "MIXED: $f (setPage(1)=$has_set, resetPage()=$has_reset)"
done
```

- [ ] FK-поле зі списком (готовий масив) → `<PickerModal<T>>`, не власний Modal зі своїм query-станом
- [ ] Великий датасет + сервер-пошук → `<SearchCombobox<T>>`
- [ ] Inline IIFE `{(() => {...})()}` → іменована функція; pointless wrapper навколо `.map()` → прибрати IIFE
- [ ] "Прострочено/скоро" badge → `<ExpiryBadge>` + `daysUntil()`, не inline `Math.ceil(.../86_400_000)`
- [ ] **Date-picker `YYYY-MM-DD` → ISO конверсія без LOCAL-parse.** `new Date(`${d}T00:00:00`).toISOString()` парсить рядок у TZ **браузера**, потім у UTC → у браузерах з додатнім offset (Kyiv UTC+3) дата зсувається на **-1 день** (`2026-09-10T00:00:00` local → `2026-09-09T21:00:00Z`). Day-based min/max арифметика → канонічний `addDaysISO(kyivToday(), N)` (UTC-математика, `lib/format.ts`), НЕ ручний `new Date + setDate + toISOString().slice`. Payload «до кінця дня» → `${d}T23:59:59Z`(UTC end-of-day). Sample:`WarrantyCreateModal` (abe63125). (Деталі: запис 2026-09-09)
- [ ] Однаковий helper 2+ рази → `lib/utils.ts`
- [ ] **Module-level константи класів, скопійовані зі сторінки-еталона (`TAB_CLASS`/`TAB_ACTIVE`/`TAB_IDLE`) → спільний модуль, не друга копія.** «Зроби як на Складі» = імпортувати ті самі класи з `lib/page-tabs.ts`. Grep: `grep -rnE "^const TAB_(CLASS|ACTIVE|IDLE)" apps/web/src/app` → має бути порожньо. Sample: `bank-statements/page.tsx` проти `stock-documents/page.tsx` (review 37a6330d)
- [ ] **Новий union у `hooks/api/*.ts` для query-фільтра (`'IN' | 'OUT'`) → вивести зі згенерованого (`Entity['field']` з `ApiSchema<…>`), не писати руками.** Рукописний union мовчки відстає від enum-а беку. Grep: `git diff <base> -- apps/web/src/hooks/api | grep -E "^\+export type .*= '[A-Z_]+' \|"`. Sample: `BankTxDirection` (review 37a6330d)
- [ ] **Export/render parity (екран↔файл):** окремий `exportCell`/`toCsvCell` поруч із екранним `fmtCell`/`renderCell` → ТІ САМІ лейбли для КОЖНОГО `type` (enum, boolean, date). Grep обидва, порівняй гілки по-типах: пропущена гілка = мовчазна розбіжність. Sample (audit e4f2ed2e): `exportCell` без `boolean`-гілки → boolean-колонка експортувалась "true"/"false" (англ.), екран давав «Так/Ні». Виняток — числове форматування: у файлі число raw для XLSX `ss:Type=Number` (значення те саме, лише без grouping/decimals), НЕ розбіжність лейблів. Grep: `grep -nE "function (export|toCsv|toXlsx)[A-Za-z]*Cell" apps/web/src`

---
