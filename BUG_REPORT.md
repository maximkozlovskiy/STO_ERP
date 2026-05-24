# BUG_REPORT.md — STO ERP

Дата: 2026-05-24
Сесія: /sto-tester auto pass після /sto-review циклу

---

## Bug #1 — [MEDIUM] SettlementsService.createTransaction не валідує amount

**Файл:** `apps/api/src/modules/settlements/settlements.service.ts:19`
**Severity:** MEDIUM
**Категорія:** business-logic

**Опис:**
`createTransaction()` приймає `amount: number` без internal валідації. Якщо викликати з `amount <= 0` (наприклад, з нового місця в коді що забуло DTO `@Min(0.01)`), створиться transaction з нульовим/від'ємним балансом → корупція даних. Defense-in-depth відсутнє.

**Очікувана поведінка:**
Кидати `BadRequestException('Сума транзакції повинна бути більшою за нуль')` при `amount <= 0`.

**Фактична поведінка:**
Запис створюється з будь-яким числом; баланс декрементується/інкрементується некоректним значенням.

**Статус:** [x] виправлено

---

## Bug #2 — [MEDIUM] InventoryService.findLowStockItems raw SQL без LIMIT

**Файл:** `apps/api/src/modules/inventory/inventory.service.ts:132`
**Severity:** MEDIUM
**Категорія:** performance / memory-leak

**Опис:**
`$queryRaw` SELECT тягне всі `stock_items` що мають `min_stock` IS NOT NULL і `quantity <= min_stock`. При корумпованому seed або багатотисячному каталозі — OOM. Сторінка дашборду викликає цей endpoint.

**Очікувана поведінка:**
Додати `LIMIT 500` у raw query — це safety guard, узгоджується з нашим правилом `take: 500` для list endpoints.

**Фактична поведінка:**
Запит без обмеження.

**Статус:** [x] виправлено

---

## Bug #3 — [LOW] Reports CSV export leaks blob URL

**Файл:** `apps/web/src/app/reports/page.tsx:141`
**Severity:** LOW
**Категорія:** memory-leak / frontend

**Опис:**
Після `URL.createObjectURL(blob)` немає виклику `URL.revokeObjectURL(url)`. Кожен експорт CSV додає blob URL що тримається в пам'яті браузера до перезавантаження сторінки.

**Очікувана поведінка:**
Після `a.click()` викликати `setTimeout(() => URL.revokeObjectURL(url), 100)` (timeout щоб дочекатись початку завантаження).

**Фактична поведінка:**
Blob URL ніколи не звільняється.

**Статус:** [x] виправлено

---

## Bug #4 — [LOW] Stock-documents / purchase-orders relation includes без take

**Файл:** `apps/api/src/modules/stock-documents/stock-documents.service.ts:46`, `purchase-orders.service.ts:44,59,93,127,153`
**Severity:** LOW
**Категорія:** performance / database

**Опис:**
`include: { lines: { where: { deletedAt: null } } }` — Prisma підтримує `take` на relation queries, але його немає. Per наш policy (`take: 1000` навіть на FK-bounded запитах як safety guard) — потрібно додати.

**Очікувана поведінка:**
`include: { lines: { where: ..., take: 1000 } }`

**Фактична поведінка:**
Без ліміту.

**Статус:** [x] виправлено

---

## Bug #5 — [MEDIUM] Відсутні unit-тести для InventoryService

**Файл:** `apps/api/src/modules/inventory/inventory.service.spec.ts` (відсутній)
**Severity:** MEDIUM
**Категорія:** test-coverage

**Опис:**
`InventoryService` — центральний компонент для всіх рухів запасів, з кількома critical guards: `quantity=0`, `available < qty`, `RESERVATION_RELEASE > reserved`, `RESERVATION_RELEASE з positive qty`. Жоден з цих guards не покритий тестом. Регресія тут = фінансова катастрофа.

**Очікувана поведінка:**
Створити `inventory.service.spec.ts` з тестами для кожного guard.

**Фактична поведінка:**
Тестів немає.

**Статус:** [x] виправлено

---

## Bug #6 — [MEDIUM] Відсутні unit-тести для SettlementsService

**Файл:** `apps/api/src/modules/settlements/settlements.service.spec.ts` (відсутній)
**Severity:** MEDIUM
**Категорія:** test-coverage

**Опис:**
`SettlementsService.createTransaction` керує балансами рахунків — критична фінансова логіка. Логіка signed balance (CHARGE+, PAYMENT/PREPAYMENT/REFUND/CREDIT_NOTE−) без тестів.

**Очікувана поведінка:**
Створити `settlements.service.spec.ts` з тестами на:
- CHARGE інкрементує balance
- PAYMENT/PREPAYMENT/REFUND/CREDIT_NOTE декрементують balance
- немає account → NotFoundException
- amount <= 0 → BadRequestException (після Bug #1 фіксу)

**Фактична поведінка:**
Тестів немає.

**Статус:** [x] виправлено

---
