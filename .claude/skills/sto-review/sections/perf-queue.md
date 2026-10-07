# sto-review — секція: Продуктивність, офлайн, черги, конфігурованість (§7, §10, §11)

> Частина скіла `sto-review`. Алгоритм і матриця «тип зміни → секції» — у `../SKILL.md`.
> Читати цілком, коли матриця призначила хоч один § цього файла.
> Реальні випадки з детекторами: `../journal/perf-queue.md` (шукати, не читати цілком).

### §7 Performance

#### §7.1 Backend

```bash
# Послідовні незалежні запити (sequential → parallel)
grep -rn "const .* = await.*findFirst" apps/api/src/modules/ --include="*.service.ts" -A3 \
  | grep -B1 "await.*findFirst" | grep -v spec | head -20
# Blocking sync у async context
grep -rn "readFileSync\|writeFileSync\|existsSync" apps/api/src/ --include="*.ts"
# Bulk-apply: per-iteration $transaction([...]) + per-iteration calculate*() (N окремих TX замість 1 batched)
for f in $(grep -rl "for.*of.*\(lines\|items\|rows\|goods\)" apps/api/src/modules/ --include="*.service.ts" | grep -v spec); do
  has_calc=$(grep -c "await.*calculate\|await.*\.compute" "$f")
  has_arr_tx=$(grep -c "await this\.prisma\.\$transaction(\[" "$f")
  [ "$has_calc" -gt 0 ] && [ "$has_arr_tx" -gt 0 ] && echo "BULK-APPLY suspect: $f"
done
```

- [ ] Незалежні запити → `Promise.all([...])` (не sequential `await`)
- [ ] Важкі операції (PDF, масовий import) → BullMQ, не request handler
- [ ] Немає `fs.readFileSync` у request handlers
- [ ] **Bulk-apply:** `for (const line of lines)` → calc prefetched перед loop; updates batched у `$transaction(async tx, { timeout: N })` — НЕ per-iteration `$transaction([...])` (array-form default 5s timeout)
- [ ] **Растеризація/декодування НЕДОВІРЕНОГО вхідного файлу (PDF→canvas, image decode) → ЖОРСТКА стеля площі в пікселях ПЕРЕД alloc (decompression-bomb).** Ліміт розміру завантаження (25 МБ) НЕ рятує: PDF може оголосити крихітний потік вмісту й гігантський MediaBox (спек до 14400×14400 pt) → при DPI 200 scale≈2.78 полотно ~40000² ≈ 25 ГБ RGBA, виділяється СИНХРОННО у `createCanvas` ДО будь-якого таймауту → миттєвий OOM (mem_limit: 1g). Таймаути безсилі — alloc синхронний. Fix: базовий viewport (scale=1) → `clampScaleToArea(w,h,scale)` = `scale*√(MAX_PX/area)` під стелю (~40 млн px ≈ 160 МБ RGBA; A4@200=3.9 млн — норма не зачеплена). Grep: `grep -rn "createCanvas\|getViewport\|new Image\|sharp(" apps/api/src --include="*.ts" | grep -v spec` → кожна растеризація з user-controlled розміром без clamp = CRITICAL. Sample: pdf-rasterizer.rasterizePdfPages (ce52e337)

#### §7.2 Frontend

```bash
# new Date() у render path (hydration mismatch)
grep -rn "new Date()\|Date\.now()" apps/web/src/app/ --include="*.tsx" | grep -v "useEffect\|getTime\|setDate\|//\|spec"
# key={i} у re-sortable lists
grep -rn "key={i}\|key={index}" apps/web/src/app/ --include="*.tsx" | head -10
# Per-item fan-out: Promise.all(days/ids.map(apiFetch)) без cap і без AbortController
grep -rnE "Promise\.all\(\s*[a-zA-Z]+\.map\(" apps/web/src/app/ --include="*.tsx" -A2 | grep -i "apiFetch" | head -10
```

- [ ] `new Date()` у render → `useState('')` + `useEffect(() => setX(new Date()), [])`
- [ ] `key={i}` у списках з filter/sort → `key={item.id}` або stable derived key
- [ ] Важкі обчислення у render → `useMemo`
- [ ] `createPortal` → `mounted` guard
- [ ] `Promise.all(arr.map(apiFetch))` fan-out → cap(`MAX_N`) + `AbortController`-ref: `.abort()` попередню партію; `if (signal.aborted) return` перед setState

---

### §10 Offline-First

- [ ] Зовнішні API → тільки через BullMQ
- [ ] Конфігурація (терміни, ліміти, шаблони) → `SettingsService.get(orgId)`, не hardcode

---

### §11 Configuration over Hardcode

```bash
# Magic numbers у сервісах
grep -rn "= [0-9]\{2,\}" apps/api/src/modules/ --include="*.ts" | grep -v "spec\|take:\|skip:\|1000\|200\|100\|60_000\|300_000" | head -15
# Hardcoded шаблони повідомлень
grep -rn "\"Шановний\|\"Ваш наряд\|\"Рахунок №\|'Дякуємо" apps/api/src/ --include="*.ts" | grep -v spec
```

- [ ] `invoiceDueDays`, `autoArchiveDays`, `warrantyDays` → `SettingsService.get(orgId)`
- [ ] SMS/Viber/Email шаблони → `NotificationTemplate`, не рядкові літерали
- [ ] Способи оплати → `PaymentMethodConfig`; ставки ПДВ → `TaxRate`

---
