# BUG_REPORT.md — STO ERP

Дата: 2026-05-25
Сесія: tester cycle після review cycle 2 (post 08e1481 + ce81b93)

## Результат: 0 нових багів

Baseline (повторно перевірений 2026-05-25):
- `tsc` (web, api, shared) — ✅ 0 errors
- Unit + contract + property API — ✅ 67/67 passed (8 файлів)
- Component (web vitest) — ✅ 42/42 passed (4 файли)
- E2E (Playwright) — ⏭ skipped (dev server `http://localhost:3001` офлайн)

Перевірено статичним аналізом — все чисто:
- Review cycle 2 правки на місці (`dashboard/page.tsx` cancelled guard, видалені `ChevronRight` у TopShell + `Button` у dashboard)
- FSM нарядів через `WORK_ORDER_TRANSITIONS`, IN_PROGRESS/COMPLETED side-effects у `$transaction`
- Inventory raw SQL використовує `"orgId"`, `"deletedAt"`, `"minStock"` у подвійних лапках (camelCase Postgres ідентифікатори)
- DocumentNumberService raw SQL — те саме (`"currentSeq"`, `"resetPeriod"`, `"lastResetYear"`, `"updatedAt"`) + `LIMIT 1` + `FOR UPDATE`
- `MaintenanceSchedule.findUpcoming` фільтрує `vehicle: { deletedAt: null }` — soft-deleted vehicles не з'являються в дашборді
- `settlementAccount.update` лише у `SettlementsService.createTransaction` — інших викликів немає
- Hard delete лише `goodBarcode.delete` (модель без `deletedAt` — legitimate)
- Нема silent `.catch(() => {})` в API
- TopShell має render-blocking auth guard для не-public роутів + `useEffect` redirect
- Tailwind 4 — нема `border-(--color-...)` / `ring-(--color-...)` / `bg-(--color-...)`; всі inline `var(--color-...)` тільки у Recharts SVG props (третя сторона, не приймає Tailwind класи)
- Blob URL revoke з `setTimeout(...100)` у `reports/page.tsx` + `xlsx-import-button.tsx`

---

## Попередня сесія (post-theme/hydration + sidebar collapse refactor, commits a41ba77, 3b0af99)

Baseline:
- `tsc` (web, api, shared) — 0 errors
- Unit tests — 67/67 passed (включно з contract: auth, work-orders; property-based: fsm, inventory, settlements)
- fast-check OK, @testing-library/react OK (`apps/web/vitest.config.mts` присутній — компонентні тести запускаються), playwright OK

---

## Bug #1 — [HIGH] Незакрита квадратна дужка у `focus:ring-[hsl(...)` Input

**Файл:** `apps/web/src/components/ui/input.tsx:47`
**Severity:** HIGH
**Категорія:** frontend

**Опис:**
У класі для стану помилки відсутня закриваюча квадратна дужка:
```tsx
hasError && 'border-destructive focus:ring-[hsl(0_86%_93%)',  // <- немає `]`
```
У сусідньому `select.tsx:41` той самий клас написаний правильно: `focus:ring-[hsl(0_86%_93%)]`.

**Очікувана поведінка:**
При фокусі на Input з помилкою — навколо поля рожевий ring (як у Select).

**Фактична поведінка:**
Tailwind 4 JIT не парсить arbitrary value без закриваючого `]` і не генерує клас → ring не з'являється на помилковому стані. Візуальна неконсистентність між Input і Select.

**Статус:** [x] виправлено

---

## Bug #2 — [MEDIUM] Синхронний `URL.revokeObjectURL` після `a.click()` у XlsxImportButton

**Файл:** `apps/web/src/components/ui/xlsx-import-button.tsx:61`
**Severity:** MEDIUM
**Категорія:** frontend / memory

**Опис:**
```ts
a.click();
URL.revokeObjectURL(url);  // <- викликається миттєво
```
Браузер може не встигнути почати завантаження blob до того як URL уже відкликаний. У Chromium це періодично зриває скачування .xlsx шаблону.

**Очікувана поведінка:**
Дотримуватись патерну з reports/page.tsx:142 — `setTimeout(() => URL.revokeObjectURL(url), 100)`.

**Фактична поведінка:**
Іноді при першому кліку завантаження не починається; повторний клік працює (бо blob вже у кеші браузера).

**Статус:** [x] виправлено

---

## Bug #3 — [LOW] Невикористаний імпорт `GripVertical` у Dashboard

**Файл:** `apps/web/src/app/dashboard/page.tsx:9`
**Severity:** LOW
**Категорія:** typescript / code-quality

**Опис:**
`GripVertical` імпортовано з lucide-react, але не використовується в JSX (drag handle не реалізовано в QA-конфігураторі — він використовує `Check` замість grip).

**Очікувана поведінка:**
0 невикористаних імпортів — інакше bundle size + ESLint warning.

**Фактична поведінка:**
Імпорт + ~0.5KB у chunk без причини; ESLint `no-unused-vars` не падає бо TS-only warning.

**Статус:** [x] виправлено

---
