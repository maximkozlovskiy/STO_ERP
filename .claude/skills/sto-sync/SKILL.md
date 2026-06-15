---
name: sto-sync
description: >
  Синхронізація фронт ↔ бек для STO ERP. Перевіряє три напрямки розбіжностей:
  (1) є API — немає UI, (2) фронт кличе неіснуючий/неправильний endpoint,
  (3) TypeScript interface у page.tsx не збігається з toResponseDto() у сервісі.
  Виправляє всі знайдені розбіжності автоматично. Запускати: після /sto-phase
  коли блок має і backend і frontend зміни; або коли юзер каже "синхронізуй",
  "API не відповідає", "фронт не бачить даних", "типи розходяться".
  Завжди ПІСЛЯ sto-backend + sto-web, ПЕРЕД sto-review + sto-tester.
model: claude-sonnet-4-6
bypassPermissions: true
---

# sto-sync — API/Frontend Synchronization Skill

## Режим Auto (ОБОВ'ЯЗКОВО)

Знаходь розбіжності → виправляй одразу → без питань.

```
0. Крок 0 — Контекст: MemoryManual + визнач агрегати зі scope
1. Крок 1 — Direction 1: бек→фронт (є API — немає UI)
2. Крок 2 — Direction 2: фронт→бек (неправильні endpoint URLs)
3. Крок 3 — Direction 3: контракт типів (interface vs toResponseDto)
4. Крок 4 — pnpm tsc --noEmit --incremental false → 0 errors
5. Крок 5 — git commit -m "fix(sync): ..."
6. Крок 6 — Оновити MemoryManual.md
```

> Не питай дозволу — виправляй і комітай автоматично.

---

## Крок 0 — Контекст

```bash
cat MemoryManual.md | head -50
git diff HEAD --name-only | head -30
```

Визнач агрегати зі scope → читай відповідні дос'є (`docs/objects/<entity>.md`).
Дос'є містять еталонні endpoint paths і TypeScript-контракти — це основа для Direction 2 і 3.

**Lookup:** `WorkOrder→work-order.md` | `Invoice→invoice.md` | `PurchaseOrder→purchase-order.md` | `StockDocument→stock-document.md` | `Counterparty→counterparty.md` | `Good→good.md` | `Work→work.md` | `CalendarSlot→calendar.md` | `StockItem→inventory.md` | `Settlement→settlements.md`

---

## Крок 1 — Direction 1: Бек → Фронт (відсутній UI)

```bash
# Список backend модулів
ls apps/api/src/modules/

# Список web сторінок
ls apps/web/src/app/
```

Для кожного backend модуля знайди відповідний UI:

| Якщо модуль є, але...                         | Куди додати UI                                    |
| --------------------------------------------- | ------------------------------------------------- |
| Немає сторінки зовсім                         | Нова сторінка `app/(dashboard)/{domain}/page.tsx` |
| Немає вкладки у батьківській                  | Нова вкладка у деталях батьківської сутності      |
| Довідник (payment-methods, tax-rates, brands) | Вкладка у `/settings` або `/catalog`              |

**Відомі виключення** (backend модулі без власного UI — це норма):

- `auth/` — немає сторінки, логін через `/login`
- `sync/` — немає сторінки, мобільний sync endpoint
- `health/` — немає сторінки, docker healthcheck
- `files/` — немає сторінки, upload helper
- `notifications/` — немає окремої сторінки, вбудований у sidebar

---

## Крок 2 — Direction 2: Фронт → Бек (неправильні URLs)

```bash
# Всі apiFetch виклики у фронтенді
grep -rn "apiFetch(" apps/web/src/ --include="*.tsx" --include="*.ts" | grep -v "lib/api-client"

# Реальні маршрути бекенду
grep -rn "@Controller\|@Get\|@Post\|@Patch\|@Delete\|@Put" apps/api/src/modules/ --include="*.controller.ts"
```

### Критичні патерни розбіжностей

```typescript
// ❌ Query param замість path param для nested resource
apiFetch(`/settlements?counterpartyId=${id}`)
// ✅ Path param як у контролері @Controller('counterparties/:counterpartyId')
apiFetch(`/counterparties/${id}/transactions`)

// ❌ Очікує bare array
const items = await apiFetch('/work-orders');
items.map(...)
// ✅ List endpoint завжди { items, total }
const { items } = await apiFetch('/work-orders');
items.map(...)

// ❌ Plural/singular mismatch
apiFetch('/work-order')   // контролер: @Controller('work-orders')
// ✅
apiFetch('/work-orders')

// ❌ Зайвий /api префікс (якщо apiClient вже додає)
apiFetch('/api/work-orders')
// ✅
apiFetch('/work-orders')
```

### Перевірка nested controllers

```bash
# Знайти всі nested @Controller patterns
grep -rn "@Controller(" apps/api/src/modules/ --include="*.controller.ts" | grep "/"
# Для кожного — звірити з фронтендом
```

---

## Крок 3 — Direction 3: Контракт типів

```bash
# Всі interface у page.tsx
grep -rn "^interface " apps/web/src/app/ --include="*.tsx"

# Відповідні toResponseDto / toDto
grep -rn "toResponseDto\|toDto\|mapToDto" apps/api/src/modules/ --include="*.service.ts" | grep -v spec
```

### Найчастіші розбіжності

| Фронтенд `interface`  | Бекенд `toResponseDto()`       | Проблема                               |
| --------------------- | ------------------------------ | -------------------------------------- |
| `description: string` | `notes: string`                | Різні назви поля                       |
| `amount: number`      | `amount: Decimal` (Prisma)     | Потрібен `Number(x.amount)`            |
| `userId: string`      | `user.sub` у контролері        | Правильно: `user.id`                   |
| `status: string`      | `status: WorkOrderStatus`      | Фронт має використовувати enum         |
| `rateScheme: {...}`   | omitted у `findAll` (security) | Фронт: `rateScheme?: {...}` — optional |
| `items: T[]`          | `{ items, total }`             | Фронт деструктурує `data.items`        |

### Знаки транзакцій (КРИТИЧНО для фінансів)

```typescript
// CHARGE = клієнт нам ВИНЕН = позитивний баланс = показувати червоним (борг клієнта)
// PAYMENT / PREPAYMENT / REFUND / CREDIT_NOTE = зменшують борг = показувати зеленим

// ❌ Частий баг: CHARGE показують зеленим ("надійшла оплата")
// ✅ CHARGE = борг, PAYMENT = погашення боргу
```

### Optional поля при security-filtered response

```typescript
// Якщо бекенд omits поле в findAll (але повертає в findOne):
// ❌
interface Employee {
  rateScheme: { type: string; rate: number }; // обов'язкове, але findAll не повертає
}

// ✅
interface Employee {
  rateScheme?: { type: string; rate: number }; // optional — може бути відсутнім
}
// + guard у JSX: {emp.rateScheme && <span>{emp.rateScheme.type}</span>}
```

---

## Крок 4 — TypeScript перевірка

```bash
# Web — завжди з --incremental false (кеш приховує помилки)
cd apps/web && node_modules/.bin/tsc --noEmit --incremental false 2>&1 | tail -30

# API
pnpm --filter @sto/api exec tsc --noEmit 2>&1 | tail -20
```

Якщо є помилки — виправляй до 0 errors перед комітом.

---

## Крок 5 — Commit

```bash
git add apps/web/src/ apps/api/src/
git commit -m "fix(sync): align frontend interfaces with API contracts

- <список виправлень>"
```

---

## Крок 6 — Оновити MemoryManual.md

```markdown
## Останній commit

<hash> fix(sync): align frontend interfaces with API contracts
Дата: YYYY-MM-DD

## Поточний стан проєкту

TypeScript: ✅ 0 errors
```

---

## Чеклист синхронізації

- [ ] Кожен backend модуль має відповідний UI (сторінка / вкладка / секція)
- [ ] Кожен `apiFetch(url)` відповідає реальному endpoint у контролері
- [ ] Nested controller URLs: `/parent/:id/child` (не query params)
- [ ] Всі `interface` у page.tsx відповідають `toResponseDto()` (назви + типи)
- [ ] `user.sub` → `user.id` у всіх контролерах
- [ ] List endpoints: `{ items, total }` — фронт використовує `r.items`
- [ ] Decimal → `Number(x.amount)` при серіалізації
- [ ] CHARGE = борг (червоний), PAYMENT/REFUND = погашення (зелений)
- [ ] Security-filtered поля у фронтенді — optional (`field?: T`)
- [ ] `pnpm tsc --noEmit --incremental false` — 0 errors

---

## Коли запускати автоматично (з sto-phase)

`sto-sync` запускається автоматично у Кроці 4 `sto-phase` коли блок містить **і** `[sto-backend]` **і** `[sto-web]` задачі одночасно:

```
sto-phase flow:
  Крок 2.1 sto-database  →
  Крок 2.2 sto-backend   →
  Крок 2.3 sto-web       →
  Крок 3   git commit    →
  Крок 4a  sto-sync      ← АВТОМАТИЧНО якщо є і backend і frontend
  Крок 4b  sto-review    →
  Крок 4c  sto-tester    →
  Крок 5   MemoryManual
```

Якщо блок тільки backend або тільки frontend — `sto-sync` пропускається.
