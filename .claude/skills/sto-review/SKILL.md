---
name: sto-review
description: >
  Perform a thorough code review of STO ERP changes. Use when the user says "зроби code review", "перевір код", "review PR", or after implementing a feature. Reviews cover: correctness, security, memory leaks, performance, TypeScript quality, NestJS/Next.js/Expo conventions, business rule compliance, sync-readiness.
model: opus
bypassPermissions: true
---

# sto-review — Code Review Skill

## Режим Auto (ОБОВ'ЯЗКОВО)

**Все виконується без питань, без дозволу між кроками.** Фіксуй одним реченням що робиш.

```
0. Контекст (git diff + scope)      4. tsc 0 errors + git commit
1. §1 TypeScript (завжди)           5. Оновити MemoryManual.md
2. Секції за матрицею типу зміни    6. Самовдосконалення: записати нові підходи
3. Виправити всі знайдені проблеми
```

---

## Крок 0 — Контекст

```bash
git diff HEAD --name-only | head -30
CHANGED=$(git diff HEAD --name-only | wc -l); echo "Змінено файлів: $CHANGED"
cat MemoryManual.md | head -50
```

**Агрегати зі scope → читай відповідні дос'є паралельно:**

| Ключові слова у змінених файлах            | Читати                           |
| ------------------------------------------ | -------------------------------- |
| `work-order`, `WorkOrder`, `work-orders.`  | `docs/objects/work-order.md`     |
| `invoice`, `Invoice`                       | `docs/objects/invoice.md`        |
| `purchase-order`, `PurchaseOrder`          | `docs/objects/purchase-order.md` |
| `stock-document`, `StockDocument`          | `docs/objects/stock-document.md` |
| `counterpart`, `Counterparty`              | `docs/objects/counterparty.md`   |
| `good`, `Good`, `catalog`                  | `docs/objects/good.md`           |
| `work-categor`, `Work`, `works.`           | `docs/objects/work.md`           |
| `calendar`, `CalendarSlot`                 | `docs/objects/calendar.md`       |
| `stock-item`, `StockMovement`, `inventory` | `docs/objects/inventory.md`      |
| `settlement`, `transaction`, `payment`     | `docs/objects/settlements.md`    |

Scope торкається `*.service.ts` → також `docs/BUSINESS-RULES.md`. Нова сторінка/компонент → також `docs/GOTCHAS.md`.

**Матриця: тип зміни → секції**

| Тип зміни              | Обов'язкові секції            | Пропустити           |
| ---------------------- | ----------------------------- | -------------------- |
| Новий `@Controller`    | §1, §2.1, §2.2, §2.3, §4, §13 | §3, §6, §9, §10, §11 |
| Новий `*.service.ts`   | §1, §4, §5, §6, §7.1          | §2, §8               |
| Нова Prisma модель     | §1, §6, §9                    | §2, §3, §5, §8       |
| Зміна `toResponseDto`  | §1, §13                       | всі інші             |
| Нова `page.tsx`        | §1, §3.1, §8                  | §2, §4, §5, §6, §9   |
| Новий `*.dto.ts`       | §1, §2.3, §2.4                | §3, §4, §5, §6       |
| Зміна BullMQ           | §1, §2.5, §10                 | §3, §4, §6, §8       |
| Новий `use*.ts` хук    | §1, §3.1                      | §2, §4, §5, §6, §9   |
| Новий `components/ui/` | §1, §8.5                      | §2, §4, §5, §6, §9   |
| Config / docs / tests  | §1 (tsc) — тільки             | всі інші             |

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

## Крок 1 — §1 TypeScript (завжди)

```bash
# Web — ОБОВ'ЯЗКОВО --incremental false (кеш приховує помилки)
cd apps/web && node_modules/.bin/tsc --noEmit --incremental false
pnpm --filter @sto/api exec tsc --noEmit
pnpm --filter @sto/shared exec tsc --noEmit

# React namespace без named import (→ VSCode errors, tsc може мовчати)
grep -rn "React\.\(ReactNode\|CSSProperties\|ChangeEvent\|FormEvent\|MouseEvent\|HTMLAttributes\|SVGAttributes\)" \
  apps/web/src/ --include="*.tsx" --include="*.ts" | grep -v "//\|spec"

# any типи
grep -rn ": any\b" apps/api/src/ apps/web/src/ --include="*.ts" --include="*.tsx" | grep -v "as unknown as\|spec"

# console.log у production коді
grep -rn "console\.log\b" apps/api/src/ apps/web/src/ --include="*.ts" --include="*.tsx" | grep -v "spec\|//.*console"

# Tailwind 4 — застарілі форми замість canonical tokens
grep -rn "\[var(--\|(--color-" apps/web/src/ --include="*.tsx" --include="*.ts"

# Tailwind 4 — inline HSL (не перемикається в dark mode)
grep -rnE "text-\[hsl\(|border-\[hsl\(|bg-\[hsl\(|ring-\[hsl\(" apps/web/src/app apps/web/src/components --include="*.tsx"

# Inline style rgba(var(--X-rgb))/hsl(var(--X)) — звірити що CSS var РЕАЛЬНО існує у globals.css.
# Токени --color-* зберігаються як hsl()/var() цілісні значення, НЕ як rgb/hsl-триплети →
# rgba(var(--color-primary), a) мовчки падає на fallback (або transparent). Тема-aware alpha = color-mix().
grep -rnE "rgba\(var\(--|hsla?\(var\(--" apps/web/src/ --include="*.tsx" --include="*.ts"
# Для кожного --X-rgb / --X у rgba(): grep "X" apps/web/src/app/globals.css — якщо немає → CRITICAL/IMPORTANT

# Pixel значення замість Tailwind scale
grep -rnE "(w|h|top|left|right|bottom|max-w|min-w|p|m|gap)-\[[0-9]+px\]" apps/web/src/ --include="*.tsx"

# Незакрита дужка у arbitrary value (JIT тихо не генерує клас)
grep -rnE "\b[a-z:]+-\[[^]]*$" apps/web/src/ --include="*.tsx" --include="*.ts"

# findMany без take (OOM ризик)
grep -rn "findMany(" apps/api/src/ --include="*.ts" | grep -v "take:\|spec"

# Пакети без tsconfig.json
for f in packages/*/package.json apps/*/package.json; do
  dir=$(dirname "$f"); [ -f "$dir/tsconfig.json" ] || echo "MISSING tsconfig: $dir"
done

# UTF-8 BOM у .ts/.tsx (Windows-редактор/PowerShell Out-File -Encoding utf8) — неконсистентно з codebase
for f in $(git diff HEAD~10 --name-only 2>/dev/null | grep -E "\.(ts|tsx)$"); do
  [ -f "$f" ] && [ "$(head -c 3 "$f" | od -An -tx1 | tr -d ' ')" = "efbbbf" ] && echo "BOM: $f"
done
```

**Автофікси:**

| Помилка                                       | Фікс                                                   |
| --------------------------------------------- | ------------------------------------------------------ |
| `React.ReactNode`                             | `import type { ReactNode } from 'react'` → `ReactNode` |
| `React.ChangeEvent<T>` / `React.FormEvent<T>` | `import type { ChangeEvent, FormEvent } from 'react'`  |
| `bg-(--color-X)` / `border-(--color-X)`       | Canonical token: `bg-X` / `border-X`                   |
| `w-[Npx]`                                     | Tailwind scale: M = N/4 (52px→w-13)                    |
| `flex-shrink-0`                               | `shrink-0`                                             |
| `URL.revokeObjectURL(url)` після `a.click()`  | `setTimeout(() => URL.revokeObjectURL(url), 100)`      |
| `findMany` без `take`                         | `take: 200` (list) або `take: 500` (sub-resources)     |

- [ ] `tsc --noEmit` → 0 errors (web `--incremental false`, api, shared)
- [ ] Немає `React.X` — тільки named imports з `'react'`
- [ ] Немає `any` (крім `as unknown as T`)
- [ ] Немає `console.log`
- [ ] Всі `findMany` мають `take: N`
- [ ] Canonical Tailwind tokens (не `[var(--...)]`, не inline HSL)
- [ ] Немає UTF-8 BOM (`ef bb bf`) у .ts/.tsx — Windows/PowerShell редактори додають мовчки; tsc толерує, але неконсистентно й ламає деякі парсери/JSON-імпорти

---

## Крок 2 — Секції за матрицею

Чекліст кожного § лежить в окремому файлі. За матрицею з Кроку 0 визнач потрібні § і
прочитай **цілком** відповідні файли секцій (кожен влазить в один Read). Інші не читай.

| §            | Файл секції              | Журнал реальних випадків |
| ------------ | ------------------------ | ------------------------ |
| §1           | цей файл, Крок 1         | `journal/ts.md`          |
| §2           | `sections/security.md`   | `journal/security.md`    |
| §3, §8       | `sections/web.md`        | `journal/web.md`         |
| §4, §5, §13  | `sections/api.md`        | `journal/api.md`         |
| §6, §9       | `sections/database.md`   | `journal/database.md`    |
| §7, §10, §11 | `sections/perf-queue.md` | `journal/perf-queue.md`  |

Журнал — архів уже знайдених випадків із детекторами. Цілком його не читати: шукати в
ньому (`grep -n "<ключове слово>" .claude/skills/sto-review/journal/<файл>.md`), коли
знахідка схожа на вже описану, і перед записом нового підходу.

---

## Крок 3 — Виправлення

```
Для кожної проблеми (Critical → Important → Suggestion):
  1. Прочитай файл
  2. Застосуй мінімальний точковий фікс
  3. pnpm --filter <package> exec tsc --noEmit → 0 errors
  4. Якщо fix потребує міграції → зафіксуй як CRITICAL, повідом після всіх інших правок
```

---

## Крок 4 — TypeScript + Commit

```bash
pnpm --filter @sto/api exec tsc --noEmit
(cd apps/web && node_modules/.bin/tsc --noEmit --incremental false)
python scripts/affected-tests.py     # → виконати надруковані команди API / WEB / E2E
git add apps/ packages/
git commit -m "fix(review): <коротко що виправлено>"
```

---

## Крок 5 — Оновити MemoryManual.md

```markdown
## Останній commit

<hash> fix(review): <message>
Дата: YYYY-MM-DD

## Поточний стан проєкту

TypeScript: ✅ 0 errors
Latest review: YYYY-MM-DD (<режим>, HEAD <hash>) — <підсумок>
```

---

## Крок 6 — Самовдосконалення (ОБОВ'ЯЗКОВО після кожного запуску)

Після виправлення кожної проблеми — запитай: **"Цей баг охоплений існуючим пунктом чекліста §1–§13?"** Якщо **НІ**:

1. Додати grep-команду у відповідний розділ
2. Додати checklist item
3. Записати підхід у "Накопичені підходи" нижче
4. Commit: `docs(skills): add <патерн> to sto-review`

**Розподіл:** `sto-review` = статичний аналіз (grep, tsc, код-аналіз); `sto-tester` = динамічні баги (runtime, browser, a11y, i18n, E2E).

**Формат запису:**

```
### YYYY-MM-DD — [Назва] — §N
**Сигнал:** ... **Grep:** ... **Фікс:** ... **Severity:** CRITICAL / IMPORTANT / SUGGESTION
```

---

## Output Format

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔍 CODE REVIEW — STO ERP
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Файлів перевірено: N
Знайдено проблем:  N (Critical: X / Important: Y / Suggestion: Z)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

### 🔴 Critical (must fix)
1. [файл:рядок] — що не так → як виправити

### 🟡 Important (should fix)
1. [файл:рядок] — що не так → як виправити

### 🔵 Suggestion (nice to have)
1. [файл:рядок] — пропозиція
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## Накопичені підходи (оновлюється автоматично)

> Формат: `дата — назва — §N` + **Сигнал / Grep / Фікс / Severity**. Grep наведено там, де це реальний детектор.

Записи лежать у `journal/<секція>.md` (таблиця відповідності — у Кроці 2). Новий запис
додавай у журнал тієї секції, чий § стоїть першим у його заголовку; новий пункт чекліста —
у файл секції. Цей файл (ядро) не росте.

## Карта секцій (quick reference)

| #   | Секція         | Стосується                                                     |
| --- | -------------- | -------------------------------------------------------------- |
| 1   | TypeScript     | api/, web/, packages/ — завжди                                 |
| 2   | Security       | Guards, tenant, injection, secrets, BullMQ, JWT, Sentry        |
| 3   | Memory Leaks   | web/ hooks; api/ DB connections                                |
| 4   | Architecture   | DI, events, error handling, list wrappers                      |
| 5   | Business Rules | FSM, inventory, settlements, soft delete, $transaction timeout |
| 6   | Database       | N+1, take, indexes, select vs include, resurrection            |
| 7   | Performance    | Parallel queries; SSR/hydration                                |
| 8   | Web Frontend   | API calls, UI states, SSR, auth, UX features, modularity       |
| 9   | Sync Readiness | PULL_TABLES, PUSH_SAFE, BLACKLIST                              |
| 10  | Offline-First  | BullMQ, зовнішні API                                           |
| 11  | Configuration  | Magic numbers, hardcoded templates                             |
| 13  | API Contract   | DTO ↔ interface, BigInt, dynamic model, polymorphic entityType |
