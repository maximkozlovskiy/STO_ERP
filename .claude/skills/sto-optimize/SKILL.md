---
name: sto-optimize
description: >
  Performance optimization skill for STO ERP. Audits backend (NestJS/Prisma) and
  frontend (Next.js) for bottlenecks: N+1 queries, missing DB indexes, sequential
  fetches that could be parallel, bundle size, React re-renders, missing cache.
  Finds, fixes, and commits all issues automatically.
  Invoke: /sto-optimize
model: opus
bypassPermissions: true
---

# sto-optimize — Performance & Efficiency Skill

## Режим Auto (ОБОВ'ЯЗКОВО)

**Все виконується без питань.** Не питай дозволу між кроками; фіксуй одним реченням що робиш.

```
Крок 0 — контекст (git diff + MemoryManual)
Крок 1 — backend аудит   Крок 2 — frontend аудит   Крок 3 — DB (індекси)
Крок 4 — виправити все    Крок 5 — tsc 0 + commit   Крок 6 — MemoryManual.md
Крок 7 — самовдосконалення: нові підходи у "Накопичені підходи"
```

---

## Крок 0 — Контекст

```bash
git diff HEAD --name-only | head -30   # scope
cat MemoryManual.md | head -50          # стан проєкту
```

Визнач агрегати зі scope → читай дос'є (`docs/objects/<entity>.md`): існуючі індекси, відомі N+1 та кеш-патерни.

**Lookup:** `WorkOrder→work-order.md` | `Invoice→invoice.md` | `PurchaseOrder→purchase-order.md` | `Good→good.md` | `Counterparty→counterparty.md` | `CalendarSlot→calendar.md` | `StockItem→inventory.md`

**Аргумент** (`/sto-optimize backend|frontend|db`) → тільки відповідний крок. Без аргументу → всі.

---

> **Спец-модель.** Інваріанти агрегату й тести, що їх стережуть, — у `docs/objects/<entity>.md`
> (секція «Аспекти і тести, що їх стережуть»). Зачепив спек-файл → прогнати гейти:
> `python scripts/check-spec-registry.py --gate-size --gate-registry`. Деталі — `/sto-spec`.

## Крок 1 — Backend аудит → `sections/backend.md`

Винесено дослівно; читати цілком, коли задача цього стосується.

---

## Крок 2 — Frontend аудит → `sections/frontend.md`

Винесено дослівно; читати цілком, коли задача цього стосується.

---

## Крок 3 — DB аудит → `sections/db-and-tests.md`

Винесено дослівно; читати цілком, коли задача цього стосується.

---

## Крок 3b — Test-suite performance (vitest/jest) → `sections/db-and-tests.md`

Винесено дослівно; читати цілком, коли задача цього стосується.

---

## Крок 4 — Виправлення

Для кожної: прочитай файл → мінімальний точковий фікс → `pnpm --filter <package> exec tsc --noEmit` (0 errors) → якщо schema.prisma змінена: `cd packages/database && npx prisma db push --skip-generate`.

**Пріоритет:** (1) N+1/waterfall; (2) відсутні індекси; (3) sequential→parallel; (4) cache miss; (5) bundle/memo (найменший ризик).

---

## Крок 5 — TypeScript + Commit

```bash
pnpm --filter @sto/api exec tsc --noEmit
pnpm --filter @sto/web exec tsc --noEmit --incremental false
git add apps/ packages/
git commit -m "perf(optimize): <коротко що виправлено>"
```

---

## Крок 6 — Оновити MemoryManual.md

`## Останній commit` → `<hash> <message>` + `Дата`; `## Поточний стан` → `TypeScript: ✅ 0 errors`.

---

## Крок 7 — Самовдосконалення скіла (ОБОВ'ЯЗКОВО після кожної ітерації)

Запитай: **"Цей патерн вже покритий чеклістом? Чи новий тип неефективності вперше?"**

**Записуй** новий: тип (анти-патерн) · сигнал (grep/структура/назва) · причину · наслідок (запити/ms/kB).
**Не записуй:** конкретні файли/рядки · готові шаблони коду (Кроки 1-3) · те що вже в чеклісті.

**Формат** у "Накопичені підходи":

```
### [Дата] — [Тип] — [Де]
**Сигнал:** ознака для авто-пошуку   **Причина:** чому так пишуть
**Виявлення:** принцип пошуку   **Фікс:** принцип рішення
**Impact:** що змінилось   **Де шукати ще:** суміжні місця
```

**Оновлення чекліста** (якщо патерн підтверджений): grep-підрозділ у Крок 1/2/3 + запис у "Накопичені підходи" → коміт `docs(skills): add <pattern> to sto-optimize`.

---

## Накопичені підходи (оновлюється автоматично)

> Формат кожного запису: **Сигнал** (+grep) · **Причина** · **Виявлення** · **Фікс** · **Impact** · **Де шукати ще**. Записи від найновіших до найстаріших.

Журнал розкладено за місяцями: `journal/approaches-YYYY-MM.md`. Цілком не читати — шукати:
`grep -n "<ключове слово>" .claude/skills/sto-optimize/journal/approaches-*.md`. Новий запис — у файл
поточного місяця (зверху). Цей файл (ядро) не росте.
