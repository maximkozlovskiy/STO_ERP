# sto-review — журнал: perf-queue

> Архів реальних випадків (дата — назва — §N + Сигнал / Grep / Фікс / Severity).
> Не читати цілком — шукати за ключовим словом. Чекліст секції: `../sections/perf-queue.md`.

### 2026-05-29 — Promise.all(days.map(apiFetch)) fan-out без cap і abort — §7.2

**Сигнал:** `Promise.all(days.map(d => apiFetch(...)))` — масив з діапазону; немає cap, немає AbortController при зміні параметра.
**Фікс:** (1) `ref.current?.abort(); ref.current = ac = new AbortController();` → `{ signal }` у кожен fetch → `if (ac.signal.aborted) return`; (2) cap довжини.
**Severity:** IMPORTANT — stale-data race + перевантаження.

### 2026-06-03 — `new Date().toISOString().slice(0,10)` для local date в Kyiv — UTC vs local — §7.2/§8.3

**Сигнал:** `new Date().toISOString().slice(0, 10)` у render/useState як default дата → UTC, а не Kyiv.
**Grep:** `grep -rn "toISOString().slice(0, 10)" apps/web/src/app --include="*.tsx"`.
**Фікс:** `const KYIV_YMD = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv' }); const kyivToday = () => KYIV_YMD.format(new Date());`.
**Severity:** IMPORTANT — між midnight і 2-3 AM фільтр "сьогодні" показує вчора.

### 2026-10-02 — растеризація недовіреного PDF без стелі площі полотна → decompression-bomb/OOM — §7.1/§2

**Сигнал:** `createCanvas(viewport.width, viewport.height)` де viewport = `page.getViewport({scale})`, а scale = DPI/72 — розмір похідний від MediaBox PDF (user-controlled). PDF може оголосити крихітний потік вмісту + гігантський MediaBox (до 14400×14400 pt) → полотно ~40000² px ≈ 25 ГБ RGBA, alloc СИНХРОННИЙ у createCanvas ДО таймауту → OOM (mem_limit: 1g). Ліміт завантаження (25 МБ) безсилий — малий файл, величезний MediaBox. Таймаути теж — alloc синхронний, не дає event loop шансу.
**Grep:** `grep -rn "createCanvas\|getViewport\|new Image\|sharp(" apps/api/src --include="*.ts" | grep -v spec` → кожна растеризація/decode user-файлу без clamp площі.
**Фікс:** базовий viewport (scale=1) → `clampScaleToArea(baseW, baseH, scale) = area<=MAX ? scale : scale*√(MAX/area)` (площа ∝ scale²) під `MAX_CANVAS_PIXELS` (~40 млн px ≈ 160 МБ RGBA; A4@200=3.9 млн — норма не зачеплена). Регрес-тест: 10000×10000 pt @ 400 DPI → площа ≤ стелі.
**Severity:** CRITICAL — OOM/DoS від одного завантаженого файлу. Sample: pdf-rasterizer.rasterizePdfPages (ce52e337).
