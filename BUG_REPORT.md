# BUG_REPORT.md — STO ERP

Дата: 2026-05-25
Сесія: post-theme/hydration + sidebar collapse refactor (commits a41ba77, 3b0af99)

Baseline:
- `tsc` (web, api, shared) — 0 errors
- Unit tests — 67/67 passed (включно з contract: auth, work-orders; property-based: fsm, inventory, settlements)
- fast-check OK, @testing-library/react OK (але `apps/web/vitest.config.ts` відсутній — компонентні тести не запускаються), playwright OK

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
