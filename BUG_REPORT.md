# BUG_REPORT.md — STO ERP

Дата: 2026-05-25
Сесія: tester cycle 4 (Phase 17 final sweep — completion-acts, maintenance-schedules, work-orders FSM + priority/repairCategory)

## Baseline (cycle 4 — чиста перевірка)

- `tsc` web/api — ✅ 0 errors
- Unit + contract + property API — ✅ 67/67 passed (8 файлів)
- E2E Playwright — ⏭ skipped (dev server офлайн)

## Знайдено багів у cycle 4: 0

Статичний sweep покрив:
- completion-acts.service.ts — orgId/deletedAt/toDto/no-hard-delete ✅
- maintenance-schedules.service.ts — vehicle relation-filter/selective-recalc/no-hard-delete ✅
- work-orders.service.ts — FSM via WORK_ORDER_TRANSITIONS/priority+repairCategory/side-effects ✅
- Frontend raw fetch() — тільки setup/page.tsx + auth/context.tsx (intentional, pre-auth) ✅
- new Date() в render path — усі існуючі useEffect/onClick/state-dependent ✅
- addEventListener cleanup — TopShell + Modal мають removeEventListener ✅
- Blob URL — reports/page.tsx + xlsx-import-button.tsx мають setTimeout+revokeObjectURL ✅
- Inline HSL colors — 0 нових; попередньо виправлені bugs #1-#5 не регресували ✅
- Append-only tables (StockMovement, SettlementTransaction) — ніяких update/delete ✅
- Raw SQL casing — document-number + inventory використовують camelCase з лапками ✅
- Tenant isolation (orgId) — всі findMany/findFirst/update мають orgId ✅
- Soft delete (deletedAt: null) — всі запити на soft-deletable моделях ✅

---

## Попередні сесії — cycle 3 (Tailwind canonical tokens)

Дата: 2026-05-25
Сесія: tester cycle 3 (фінальна верифікація після review cycle 2 + ce81b93/637557c)

### Baseline (cycle 3 reverify)

- `tsc` web/api/shared — ✅ 0 errors
- Unit + contract + property API — ✅ 67/67 passed (8 файлів)
- Component (web vitest) — ✅ 42/42 passed (4 файли)
- E2E Playwright — ⏭ skipped (dev server офлайн)

## Перевірений focus list циклу 3 (статичний sweep)

- `dashboard/page.tsx` `cancelled` guard — ✅ застосовано до всіх setState шляхів (loadData)
- `TopShell.tsx` — ✅ `sto:nav-mode-change` listener має removeEventListener у cleanup
- `color-mode.ts` — ✅ `watchSystemColorMode` повертає `() => mq.removeEventListener(...)`
- `ColorModeProvider.tsx` — ✅ useEffect `return watchSystemColorMode()` (cleanup підписується)
- `Modal.tsx` — ✅ `keydown` listener + `document.body.style.overflow` cleanup; `mounted` guard на createPortal
- `xlsx-import-button.tsx` — ✅ `setTimeout(() => URL.revokeObjectURL(url), 100)` після `a.click()`
- `reports/page.tsx` blob export — ✅ той самий `setTimeout(100)` патерн
- `settlementAccount.update` — ✅ тільки у `SettlementsService.createTransaction` (defense-in-depth)
- Hard delete — ✅ тільки `goodBarcode.delete` (модель без `deletedAt`)
- Raw SQL identifier casing — ✅ `inventory.service.ts` + `document-number.service.ts` обидва використовують `"orgId"`, `"deletedAt"`, `"minStock"`, `"currentSeq"`, `"resetPeriod"`, `"lastResetYear"`, `"updatedAt"` у подвійних лапках (camelCase Postgres ідентифікатори)
- `MaintenanceSchedule.findUpcoming` — ✅ фільтрує `vehicle: { deletedAt: null }`
- Сторінки `catalog/employees/infrastructure/settings/stock-documents/reports/sync` — ✅ всі мають loading/error/empty стани

---

## Знайдено новий клас багів — Tailwind canonical tokens

Cycle 3 виявив систематичну невідповідність: 15+ файлів використовують inline `text-[hsl(0_84%_42%)]`, `border-[hsl(0_84%_80%)]`, `text-[hsl(142_71%_30%)]`, `text-[hsl(199_89%_30%)]`, `text-[hsl(38_92%_30%)]` замість канонічних токенів `text-destructive-text`, `border-destructive-border`, `text-success-text`, `text-info-text`, `text-warning-text` (які вже визначені в `@theme` блоці `globals.css`).

**Чому це баг (не cosmetics):**
- Hardcoded HSL **не змінюється у dark mode** — у `.dark { }` блоці токени `--color-destructive-text` перевизначені на `hsl(0 84% 72%)`, але inline `text-[hsl(0_84%_42%)]` залишається темно-червоним → 1.8:1 контраст на темному фоні (WCAG fail).
- Дублювання — будь-яка зміна палітри (rebrand, redesign) вимагає grep+replace по 15+ файлах замість редагування одного `globals.css`.
- /sto-dev і /sto-review експліцитно вимагають canonical Tailwind tokens, але checklist досі не мав grep на `text-[hsl(`.

---

## Bug #1 — [MEDIUM] Інлайн `text-[hsl(0_84%_42%)]` замість `text-destructive-text` у error banner-ах

**Файли:**
- `apps/web/src/app/(auth)/login/page.tsx:114`
- `apps/web/src/app/crm/page.tsx:121,313`
- `apps/web/src/app/inventory/page.tsx:85`
- `apps/web/src/app/invoices/page.tsx:168`
- `apps/web/src/app/purchase-orders/page.tsx:195`
- `apps/web/src/app/reports/page.tsx:97`
- `apps/web/src/app/settings/page.tsx:184`
- `apps/web/src/app/settings/sync/page.tsx:83`
- `apps/web/src/app/settlements/page.tsx:112`
- `apps/web/src/app/setup/page.tsx:166`
- `apps/web/src/app/stock-documents/page.tsx:172`
- `apps/web/src/app/calendar/page.tsx:126,157`
- `apps/web/src/app/vehicles/[id]/PageClient.tsx:75,88`

**Severity:** MEDIUM
**Категорія:** frontend / a11y (dark mode contrast)

**Опис:**
У всіх error banner-ах (і деяких inline ерор-текстах) рядки виглядають так:
```tsx
<div className="text-[13px] text-[hsl(0_84%_42%)] bg-destructive-subtle border border-[hsl(0_84%_80%)] rounded-lg ...">
```
Тоді як `globals.css` уже визначає `--color-destructive-text` (та `border`), і dark-mode перевизначає їх. Inline HSL не перемикається.

**Очікувана поведінка:**
```tsx
<div className="text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg ...">
```

**Фактична поведінка:**
У dark mode error banner має темно-червоний текст на темному background → погано читається; у light mode візуально однаково, але порушує single-source-of-truth.

**Статус:** [x] виправлено — всі 13 згаданих файлів використовують `text-destructive-text` + `border-destructive-border`. Tsc/тести зелені.

---

## Bug #2 — [MEDIUM] Інлайн `border-[hsl(0_84%_80%)]` замість `border-destructive-border`

**Файли (ті ж що Bug #1, плюс):**
- Зустрічаються у кількох сторінках одночасно з Bug #1; також у деяких файлах border використано через `border-destructive/20`.

**Severity:** MEDIUM
**Категорія:** frontend

**Опис:**
Той самий принцип — `border-[hsl(0_84%_80%)]` повинно бути `border-destructive-border`. Виправлено в тому ж проході що Bug #1. Деякі сторінки мали `border-destructive/20` — їх теж замінено на `border-destructive-border` для консистентності.

**Статус:** [x] виправлено

---

## Bug #3 — [LOW] Інлайн `text-[hsl(142_71%_30%)]` замість `text-success-text` у CRM balance

**Файли:**
- `apps/web/src/app/crm/page.tsx:209,281`

**Severity:** LOW
**Категорія:** frontend / a11y

**Опис:**
Позитивний баланс контрагента відображається кольором `text-[hsl(142_71%_30%)]`. Має бути `text-success-text` (визначено у `globals.css`).

**Статус:** [x] виправлено — `crm/page.tsx:209,281` тепер використовують `text-success-text` / `text-destructive-text`.

---

## Bug #4 — [LOW] Інлайн `text-[hsl(199_89%_30%)]` замість `text-info-text` у invoice info banner

**Файл:**
- `apps/web/src/app/invoices/page.tsx:422`

**Severity:** LOW
**Категорія:** frontend

**Опис:**
Інформаційний банер payload використовує `text-[hsl(199_89%_30%)]`. Має бути `text-info-text`.

**Статус:** [x] виправлено

---

## Bug #5 — [LOW] Інлайн `text-[hsl(38_92%_30%)]` замість `text-warning-text` у inventory warning UI

**Файли:**
- `apps/web/src/app/inventory/page.tsx:95` (кнопка "Нижче мінімуму")
- `apps/web/src/app/inventory/page.tsx:205` (low-stock detail banner)

**Severity:** LOW
**Категорія:** frontend

**Опис:**
Жовто-теплий warning текст hardcoded як `text-[hsl(38_92%_30%)]`. В `globals.css` визначено `--color-warning-text: hsl(26 83% 30%)` (наближено), у dark mode `hsl(38 92% 65%)` — отже використати `text-warning-text` правильно для адаптивності.

**Статус:** [x] виправлено — `text-warning-text` + `border-warning-border` (кнопка "Нижче мінімуму" і low-stock banner у DetailPanel).

---

## Bug #6 — [LOW] Skill gap: відсутність checklist-перевірки на inline `text-[hsl(...)]` у /sto-review та /sto-tester

**Файли:**
- `.claude/skills/sto-tester/SKILL.md`
- `.claude/skills/sto-review/SKILL.md`
- `.claude/skills/sto-dev/SKILL.md`

**Severity:** LOW
**Категорія:** skill-improvement

**Опис:**
Bugs #1-#5 — це 15+ місць однакового паттерну, який не покритий жодним grep-ом у скілах. Cycle 3 знайшов цей клас через ручний sweep — потрібно додати автоматичний детект для майбутніх запусків.

**Очікувана поведінка:**
`/sto-review` і `/sto-tester` мають містити команду:
```bash
grep -rnE "text-\[hsl\(|border-\[hsl\(|bg-\[hsl\(|ring-\[hsl\(" apps/web/src/app apps/web/src/components --include="*.tsx"
# Кожен hit має бути замінений на canonical token або задокументований як виняток (unique design tone без токена)
```

**Винятки (acceptable):**
- `badge.tsx` purple variant — `bg-[hsl(270_100%_97%)] text-[hsl(262_83%_44%)] border-[hsl(270_88%_82%)]` (немає purple токена в `@theme`)
- `inventory/page.tsx:178,234` — `text-[hsl(25_95%_53%)]` для колонки reserved (унікальний помаранчевий, не входить в semantic palette)
- `button.tsx:41` — `hover:bg-[hsl(0_84%_52%)]` для destructive hover (немає `--color-destructive-hover` токена)
- `input.tsx:47`, `select.tsx:41` — `focus:ring-[hsl(0_86%_93%)]` для destructive focus ring (немає `--color-destructive-ring` токена)

**Статус:** [x] частково виправлено — gap задокументовано в BUG_REPORT.md з grep командою та переліком винятків. Edit на `.claude/skills/sto-tester/SKILL.md` був заблокований дозволами (потрібен ручний апдейт користувачем — додати checklist пункт + grep команду нижче в розділ "Tailwind 4 canonical classes" §1.3 sto-tester та §3.3 sto-review):

```markdown
- [ ] **Жодних inline `text-[hsl(...)]` / `border-[hsl(...)]` / `bg-[hsl(...)]` для семантичних кольорів** — використовуй токени з `@theme`: `text-destructive-text`, `border-destructive-border`, `text-success-text`, `text-warning-text`, `text-info-text`, `bg-destructive-subtle`, etc. Inline HSL не перемикається в dark mode і ламає WCAG контраст.
  ```bash
  grep -rnE "text-\[hsl\(|border-\[hsl\(|bg-\[hsl\(|ring-\[hsl\(" apps/web/src/app apps/web/src/components --include="*.tsx"
  ```
```

---

## Session 2026-05-25 — Phase 19 (StockBatch/BatchConsumption + PricingRule + Batch viewer)

Baseline:
- `tsc` web/api/shared — ✅ 0 errors
- API unit + contract + property: ✅ 88/88 passed (10 файлів)
- Зона аналізу: `apps/api/src/modules/inventory/{batch,pricing,pricing-rules}*`, `apps/api/src/modules/goods/goods.controller.ts`, `apps/web/src/components/ui/batch-viewer-modal.tsx`, `apps/web/src/app/pricing-rules/PricingRulesClient.tsx`, `apps/web/src/app/catalog/page.tsx`, `apps/web/src/app/work-orders/[id]/PageClient.tsx`, schema `StockBatch/BatchConsumption/PricingRule/PriceHistory`.

---

## Bug #14 — [CRITICAL] `BatchService.createFromReceipt` затирає `Good.salePrice` нульовою ціною при безкоштовному прийомі

**Файл:** `apps/api/src/modules/inventory/batch.service.ts:46-103`
**Severity:** CRITICAL
**Категорія:** business-logic

**Опис:**
Коли `createFromReceipt` викликається з `costPrice=0` (повернення товару, безкоштовний зразок, рекламний матеріал), `PricingService.calculateSalePrice` повертає `Math.max(0, costPrice * (1 + p/100)) = 0`. Далі код стрибає в гілку `if (Math.abs(salePrice - currentSalePrice) > 0.001)` і виконує `db.good.update({ data: { salePrice: 0 } })` — знищує існуючу ціну продажу товару.

**Очікувана поведінка:**
Якщо `costPrice <= 0` АБО розрахований `salePrice <= 0` — НЕ перезаписувати `Good.salePrice` (зберегти поточну ціну) і НЕ створювати запис у `PriceHistory`. Партія все одно створюється з `salePrice = Good.salePrice` поточним.

**Фактична поведінка:**
Безкоштовне оприбуткування скидає роздрібну ціну в 0 для всього магазину/складу. Наступний продаж пройде без націнки.

**Статус:** [x] виправлено

---

## Bug #15 — [HIGH] `InventoryService.createMovement` пропускає створення `StockBatch` при `RECEIPT` з `price=0` або `price=undefined`

**Файл:** `apps/api/src/modules/inventory/inventory.service.ts:71-82`
**Severity:** HIGH
**Категорія:** business-logic

**Опис:**
```ts
if (dto.type === 'RECEIPT' && dto.quantity > 0 && dto.price) {
  await this.batchService.createFromReceipt(...);
}
```
Якщо `price` не передано (undefined) або дорівнює 0 — batch НЕ створюється, але `StockMovement` і `StockItem.quantity` оновлюються. У результаті: фізично товар є на складі, але жодної партії не існує. Подальша `consumeBatch` з режимом FIFO/LIFO/FEFO кине `BadRequestException('Недостатньо партій для списання')` — UI заблокує продаж/списання, хоч кількість > 0.

**Очікувана поведінка:**
Або:
1. **Reject** — кидати `BadRequestException('Ціна оприбуткування обов\'язкова')` при `RECEIPT` без price; або
2. **Auto-batch** — створити партію з `costPrice = 0` (партію з нульовою собівартістю можна потім скорегувати); але не залишати quantity без партії.

Обрано підхід (1): `RECEIPT` з `quantity > 0` обов'язково потребує `price` (можна 0). Якщо `price` undefined → throw.

**Фактична поведінка:**
RECEIPT без price → quantity++, але немає батча → consumeBatch ламається.

**Статус:** [x] виправлено

---

## Bug #16 — [HIGH] `BatchesController.lookup` повертає `avgCost=0` при відсутності `warehouseId`

**Файл:** `apps/api/src/modules/inventory/batches.controller.ts:41`
**Severity:** HIGH
**Категорія:** business-logic

**Опис:**
```ts
this.batchService.getAvgCost(orgId, goodId, warehouseId ?? '')
```
Коли `warehouseId` не передано (catalog page), у запит йде порожній рядок `''`. `prisma.stockBatch.findMany({ where: { warehouseId: '' } })` нічого не знайде → `avgCost = 0`. UI у `BatchViewerModal` показує "Сер. собівартість: 0,00 ₴" і ховає блок Маржі (бо `data.avgCostPrice > 0`), хоч у товару є партії в інших складах.

**Очікувана поведінка:**
`getAvgCost(orgId, goodId, warehouseId?)`: якщо `warehouseId === undefined` → агрегувати по всіх складах. Інакше — по конкретному складу.

**Фактична поведінка:**
Catalog → "Партії" завжди показує середню собівартість 0 ₴, нульову маржу.

**Статус:** [x] виправлено

---

## Bug #17 — [HIGH] `PricingService.calculateSalePrice` застосовує правило з видаленим `Good` (soft-deleted)

**Файл:** `apps/api/src/modules/inventory/pricing.service.ts:16-30`
**Severity:** HIGH
**Категорія:** business-logic

**Опис:**
Правило `PricingRule { goodId: 'g-deleted', isActive: true, deletedAt: null }` залишається активним після soft-delete товару (`Good.deletedAt`). При повторному оприбуткуванні (resurrect товару через `InventoryService.createMovement` upsert із `deletedAt: null`) — старе правило застосовується, хоча менеджер його видалив разом з товаром.

Більш поширений випадок: видалений Good не повертає `pricingRule.good` у `findAll` (relation повертає null), тому в UI правило виглядає "Весь асортимент" замість "Товар: <Назва>". Це вводить менеджера в оману.

**Очікувана поведінка:**
1. При soft-delete товару — автоматично soft-delete пов'язаних `PricingRule` (де `goodId` дорівнює видаленому товару).
2. В `pricing-rules.controller.findAll` — фільтрувати `where: { OR: [{ goodId: null }, { good: { deletedAt: null } }] }`, щоб не показувати правила з видаленими товарами.
3. В `calculateSalePrice` — додати `OR` фільтр `{ goodId: null } | { good: { deletedAt: null } }`.

**Фактична поведінка:**
Видалені товари створюють "примарні" правила, які продовжують впливати на ціни. Список правил показує правила без імені товару (relation null) як "Весь асортимент".

**Статус:** [x] виправлено

---

## Bug #18 — [MEDIUM] `PricingRulesController.findAll` повертає голий масив (порушує API-контракт `{ items, total }`)

**Файл:** `apps/api/src/modules/inventory/pricing-rules.controller.ts:32-40`
**Severity:** MEDIUM
**Категорія:** api-contract

**Опис:**
Інші list-endpoints у проекті повертають `{ items, total, page, limit }`. `findAll` для pricing-rules — голий масив. Це порушує контракт із §1.1 SKILL.md ("Кожен list endpoint повертає `{ items, total, page?, limit? }`"). Майбутні консумери (експорт, sync, мобільний) очікують paginated shape.

**Очікувана поведінка:**
Повертати `{ items: PricingRuleDto[], total: number, page: 1, limit: 200 }`. Фронт оновити на `apiFetch<{ items: PricingRule[] }>(...)`.

**Фактична поведінка:**
Голий масив. Якщо доступ через TanStack Query кешує по shape — зміна формату ламає cache.

**Статус:** [x] виправлено

---

## Bug #19 — [MEDIUM] `PricingService.applyRuleToGoods` — `goodType: rule.goodType as never` приховує тип

**Файл:** `apps/api/src/modules/inventory/pricing.service.ts:81`
**Severity:** MEDIUM
**Категорія:** typescript

**Опис:**
```ts
...(rule.goodType ? { goodType: rule.goodType as never } : {}),
```
`as never` — анти-патерн, який вимикає перевірку типів. `Good.goodType` у схемі: `GoodType?` enum. Правильне рішення — кастувати до `Prisma.EnumGoodTypeFilter` або до `GoodType` (з імпорту `@prisma/client`).

**Очікувана поведінка:**
```ts
import { GoodType } from '@prisma/client';
...(rule.goodType ? { goodType: rule.goodType as GoodType } : {}),
```

**Фактична поведінка:**
`as never` маскує помилку: якщо `rule.goodType` міститиме нестандартне значення, Prisma кине runtime-помилку (P2009 invalid enum value), яка не вловиться TS.

**Статус:** [x] виправлено

---

## Bug #20 — [MEDIUM] `BatchService.consumeBatch` без `tx` параметра — non-atomic update + log

**Файл:** `apps/api/src/modules/inventory/batch.service.ts:106-175`
**Severity:** MEDIUM
**Категорія:** business-logic

**Опис:**
`consumeBatch` приймає опціональний `tx`. Якщо викликати без транзакції — кожне `update(stockBatch)` і `create(batchConsumption)` — окремі транзакції. Якщо процес упаде між update і create → `remainingQty` знижений, але `BatchConsumption` лог відсутній → партія "з'їдена" без сліду.

`returnToBatch` має той самий патерн. Обидва небезпечні без `tx`.

**Очікувана поведінка:**
Обернути цикл у `db.$transaction([...])` коли `tx` не передано. Або задокументувати в JSDoc "MUST be called within $transaction".

**Фактична поведінка:**
API дозволяє виклик без `tx`, що створює вікно неконсистентності.

**Статус:** [x] виправлено — додано JSDoc вимогу + assertion у dev (warning у logger).

---

## Bug #21 — [LOW] `BatchesController.lookup` повертає `null` замість `404 NotFoundException`

**Файл:** `apps/api/src/modules/inventory/batches.controller.ts:44`
**Severity:** LOW
**Категорія:** api-contract

**Опис:**
`if (!good) return null;` — інші endpoints використовують `throw new NotFoundException('Товар не знайдено')`. Зворотній 200 з `null` body змушує фронт перевіряти `data && data.good` замість стандартного error handling через `.catch`.

**Очікувана поведінка:**
`throw new NotFoundException('Товар не знайдено')`.

**Фактична поведінка:**
200 OK з body `null` — нестандартний контракт.

**Статус:** [x] виправлено

---

## Bug #22 — [LOW] `pricing-rules.dto.ts` — `CreatePricingRuleDto` не валідує що `goodId/goodCategory/goodType` взаємовиключні

**Файл:** `apps/api/src/modules/inventory/pricing-rules.dto.ts:21-35`
**Severity:** LOW
**Категорія:** api-contract

**Опис:**
DTO дозволяє створити правило з усіма трьома: `{ goodId: 'g1', goodCategory: 'X', goodType: 'SPARE_PART' }`. Алгоритм у `pricing.service` фактично використовує лише найспецифічніший (goodId), ігноруючи інші → менеджер заплутаний "чому category/type не діють".

**Очікувана поведінка:**
DTO-валідатор: `@ValidateIf((o) => !o.goodId) goodCategory?` і т.д. Або сервіс-рівень: якщо вказано `goodId`, ігнорувати `goodCategory/goodType` і встановити їх у null автоматично.

**Фактична поведінка:**
Менеджер може зберегти суперечливі поля.

**Статус:** [x] виправлено — backend нормалізує: `goodId` > `goodCategory` > `goodType`, нижчі рівні зануляються.

---

## Bug #23 — [LOW] `PricingRulesClient.tsx` — type `PercentValue=null` для FIXED_PRICE не закриває попередження

**Файл:** `apps/web/src/app/pricing-rules/PricingRulesClient.tsx:317-356`
**Severity:** LOW
**Категорія:** frontend

**Опис:**
При зміні типу правила з PERCENT на FIXED_PRICE — попередня `percentValue` залишається в формі (бо `RuleForm` зберігає всі поля string). При сабміті, навіть якщо UI ховає поле percentValue, до бекенду йде `percentValue: Number(form.percentValue) || undefined` — якщо рядок не порожній, надсилається. Бекенд ігнорує (бо `type=FIXED_PRICE`), але record у БД має зайве percentValue. Майбутній звіт за правилами покаже "FIXED_PRICE з percentValue=35%".

**Очікувана поведінка:**
При сабміті FIXED_PRICE — `percentValue: undefined`, `fixedAmount: undefined`. Для FIXED_AMOUNT — `percentValue/fixedPrice: undefined`. Тобто очищати неактуальні поля по типу.

**Фактична поведінка:**
"Сміття" в полях правила, видиме при API-перегляді.

**Статус:** [x] виправлено

---

## Bug #24 — [LOW] `batch-viewer-modal.tsx` `margin()` ділить на `sale`, повертає NaN при sale=0

**Файл:** `apps/web/src/components/ui/batch-viewer-modal.tsx:52-55`
**Severity:** LOW
**Категорія:** frontend

**Опис:**
```ts
function margin(sale: number, cost: number) {
  if (!cost) return null;
  return ((sale - cost) / sale * 100).toFixed(1);
}
```
Захищено від `cost=0`, але ділиться на `sale`. Якщо `sale=0` → `Infinity`/`NaN` → `"NaN%"` у UI.

**Очікувана поведінка:**
```ts
if (!sale || !cost) return null;
```

**Фактична поведінка:**
"NaN%" в маржі при некоректних даних.

**Статус:** [x] виправлено

---

## Bug #25 — [LOW] Відсутні contract тести для `pricing-rules` та `batches`

**Файл:** `apps/api/src/modules/inventory/` (немає `pricing-rules.contract.spec.ts`, `batches.contract.spec.ts`)
**Severity:** LOW
**Категорія:** test-coverage

**Опис:**
Нові контролери Phase 19 не мають `.contract.spec.ts` — порушення §1.4 SKILL.md.

**Статус:** [x] виправлено — додано contract-тести.

---

## Session 2026-05-25 — Phase 19 cycle 4 (BatchService + PricingService regression sweep)

Зона аналізу: усі зміни після `afcb6f7` — `BatchService`, `PricingService`,
`BatchesController`, `PricingRulesController`, `GoodsController` (нові sub-resources),
інтеграція з `InventoryService`, `StockDocumentsService` як споживач `createMovement(RECEIPT)`.

Baseline:
- `tsc` web/api/shared — ✅ 0 errors
- Unit/contract/property — ✅ 105/105 passed (12 файлів)

---

## Bug #26 — [HIGH] StockDocument RECEIPT/TRANSFER ламається коли `line.price` null

**Файл:** `apps/api/src/modules/stock-documents/stock-documents.service.ts:190,201,214`
**Severity:** HIGH
**Категорія:** business-logic (регресія від Bug #15)

**Опис:**
Bug #15 (`InventoryService.createMovement`) тепер кидає `BadRequestException('Ціна оприбуткування обов'язкова для створення партії')`, якщо `dto.type === 'RECEIPT' && (dto.price === undefined || dto.price === null)`.

Schema `StockDocumentLine.price` — `Decimal?` (nullable). Tак закладено, що документи переміщення/оприбуткування можуть створюватись без явної ціни (інвентаризація, внутрішнє переміщення).

`stock-documents.service.ts` передає `price: line.price ? Number(line.price) : undefined`. Коли `line.price === null` (типове значення для TRANSFER або документу без ціни) — передається `undefined` → InventoryService кидає виключення → CONFIRMED-перехід стокового документа падає.

**Очікувана поведінка:**
RECEIPT з відсутньою ціною дозволений: батч створюється з `costPrice = good.purchasePrice ?? 0`. Це робить безкоштовні зразки і TRANSFER-документи без ціни робочими, але батч-tracking не зламаний (батч з відомою або нульовою собівартістю).

**Фактична поведінка:**
`stockDocument.transition('CONFIRMED')` падає з 400 для TRANSFER або RECEIPT-стокового документа без ціни на рядку.

**Виправлення:** `InventoryService.createMovement` — якщо RECEIPT і price відсутня, fallback на `good.purchasePrice ?? 0`; залишити жорсткий guard лише на NaN.

**Статус:** [x] виправлено

---

## Bug #27 — [MEDIUM] `UpdatePricingRuleDto` без `@Min(0)` / `@Max(10000)` — PATCH bypass validation

**Файл:** `apps/api/src/modules/inventory/pricing-rules.dto.ts:100-122`
**Severity:** MEDIUM
**Категорія:** security / validation

**Опис:**
`CreatePricingRuleDto` має `@Min(0)` на `percentValue`, `fixedAmount`, `fixedPrice`, `roundTo` і `@Max(10000)` на `percentValue`. `UpdatePricingRuleDto` НЕ має цих обмежень.

Як наслідок: PATCH `/pricing-rules/:id` приймає від'ємне `percentValue` (наприклад, `-50` → `costPrice * (1 + -0.5) = costPrice * 0.5` → ціна вдвічі менша за собівартість), або `roundTo: -10`, або `fixedPrice: -100`.

**Очікувана поведінка:**
PATCH повинен мати ті самі межі, що й POST.

**Фактична поведінка:**
PATCH дозволяє від'ємні значення в payload — порушує бізнес-інваріант "ціна продажу ≥ 0".

**Статус:** [x] виправлено — додано `@Min(0)` / `@Max(10000)` + 3 contract тести.

---

## Bug #28 — [LOW] `GET /goods/:id/batches` і `/price-history` повертають bare array

**Файл:** `apps/api/src/modules/goods/goods.controller.ts:94-122`
**Severity:** LOW
**Категорія:** api-contract

**Опис:**
SKILL.md §1.1 "API Contract — list endpoints": "Кожен list endpoint повертає `{ items, total, page?, limit? }`". Нові sub-resource endpoints (`getBatches`, `getPriceHistory`) повертають голий масив. Frontend наразі споживає лише `/batches/lookup`, але невідповідність шейпу — джерело майбутніх багів.

**Очікувана поведінка:**
`{ items, total }` shape.

**Фактична поведінка:**
Bare array `[]` / `StockBatchDto[]`.

**Статус:** [x] виправлено — обидва endpoint-и тепер повертають `{ items, total }`.

---

## Bug #29 — [LOW] `PricingRulesClient` мовчки ковтає помилку завантаження товарів

**Файл:** `apps/web/src/app/pricing-rules/PricingRulesClient.tsx:313`
**Severity:** LOW
**Категорія:** frontend / error-handling

**Опис:**
```typescript
apiFetch<{ items: Good[] }>('/goods?limit=500')
  .then(r => { if (!cancelled) setGoods(r.items); })
  .catch(() => {});  // ← ковтаємо все
```
Порушує §1.1: "Catch не ковтає всі помилки". При API-failure форма правил рендериться з порожнім списком товарів — користувач не знає чому.

**Очікувана поведінка:**
Логувати помилку у `console.warn` або встановлювати окремий `goodsError` стан.

**Фактична поведінка:**
Тихий empty state без сигналу.

**Статус:** [x] виправлено — `console.warn` при failure (без блокування UI).

---

## Bug #30 — [LOW] `PricingRulesClient.load()` без cancellation flag — race на unmount

**Файл:** `apps/web/src/app/pricing-rules/PricingRulesClient.tsx:282-292,294-307`
**Severity:** LOW
**Категорія:** frontend / state-management

**Опис:**
Існує дублювання: `load` (useCallback) для refetch після create/update/delete, плюс окремий inline useEffect для initial fetch (з cancelled-flag). Refetch через `load()` НЕ має cancelled-flag — якщо користувач unmount-нув сторінку між POST і refetch, setState на unmounted → React warning + потенційний витік пам'яті.

**Очікувана поведінка:**
Один shared loader з cancellation, або відмова від setState після unmount через ref.

**Фактична поведінка:**
Дві паралельні версії, refetch може setState на unmounted.

**Статус:** [x] виправлено — додано `mountedRef`, `load` тепер єдина точка завантаження.

---

## Bug #31 — [LOW] `getBatches`/`getPriceHistory` без верифікації існування good

**Файл:** `apps/api/src/modules/goods/goods.controller.ts:97-103,108-122`
**Severity:** LOW
**Категорія:** api-contract / ux

**Опис:**
Endpoint `GET /goods/:id/batches` повертає `[]` коли goodId не існує або належить іншій орг. Те ж для price-history. Має бути 404, інакше фронт показує "Немає партій" замість "Товар не знайдено".

**Очікувана поведінка:**
`prisma.good.findFirst({ where: { id, orgId, deletedAt: null } })` → якщо null, кинути `NotFoundException`.

**Фактична поведінка:**
200 + порожній масив.

**Статус:** [x] виправлено — обидва endpoint-и перевіряють Good у org перед запитом.

---

## Session 2026-05-25 — Phase 19 cycle 5 (post-cycle-4 regression sweep)

### Baseline (cycle 5)

- `tsc` web/api/shared — ✅ 0 errors
- Unit + contract + property API — ✅ 111/111 passed (12 файлів)
- E2E Playwright — ⏭ skipped (dev server офлайн)

### Знайдено багів у cycle 5: 1

Статичний sweep cycle 4 фіксів покрив:
- `inventory.service.createMovement` — RECEIPT price fallback на good.purchasePrice ✅ (Bug #26 не регресував)
- `UpdatePricingRuleDto` — @Min(0)/@Max(10000) на percentValue/fixedAmount/fixedPrice ✅ (Bug #27 не регресував)
- `GoodsController.getBatches/getPriceHistory` — `{ items, total }` paginated shape + 404 коли good відсутній ✅ (Bug #28+#31 не регресували)
- `PricingRulesClient.tsx` — console.warn на goods fetch error + mountedRef guard ✅ (Bug #29+#30 не регресували)
- Append-only `StockMovement`/`BatchConsumption`/`PriceHistory`/`StockBatch` — ніяких update/delete ✅
- Raw SQL ідентифікатори (inventory.service findLowStockItems + document-number) — camelCase з лапками ✅
- Tenant isolation (orgId) у нових модулях — ✅
- Soft-delete `deletedAt: null` для `PricingRule`, `Good` relation у raw queries ✅
- Tailwind 4 canonical tokens — нових inline HSL немає (стара whitelist винятків актуальна) ✅

### Знайдений баг #32

---

## Bug #32 — [HIGH] `PricingRulesClient` запитує `/goods?limit=500` — порушує `@Max(200)` валідацію DTO

**Файл:** `apps/web/src/app/pricing-rules/PricingRulesClient.tsx:308`
**Severity:** HIGH
**Категорія:** business-logic + frontend (regression сцени Bug #29 виявив)

**Опис:**
`GoodQueryDto.limit` має `@Max(200)`, а сторінка правил надсилає `/goods?limit=500`. ValidationPipe з `forbidNonWhitelisted: true` і `whitelist: true` (`apps/api/src/main.ts:26-29`) відкидає запит з `400 Bad Request`. Після фіксу Bug #29 помилка більше не падає у toast — лише `console.warn`, тому проблема невидима для користувача. Менеджер відкриває форму "Нове правило", обирає поле "Конкретний товар (необов'язково)" і бачить порожній select → не може прив'язати правило до конкретного `goodId`.

Виявлено: cycle 5 регресійний sweep cycle 4 фіксу Bug #29 — error-handling став м'якішим і приховав цю валідаційну помилку, яка вже була у коді з самого початку Phase 19.

**Очікувана поведінка:**
Запит проходить ValidationPipe → список товарів завантажується → користувач може прив'язати правило до конкретного `goodId`.

**Фактична поведінка:**
ValidationPipe повертає `400 Bad Request: "limit must not be greater than 200"` → `console.warn` логує → state `goods` залишається `[]` → у formі правила select "Конкретний товар" має лише `— Не вказано —`.

**Виправлення:**
Замінити `/goods?limit=500` на `/goods?limit=200` (узгоджено з усіма іншими сторінками: dashboard, work-orders, stock-documents, invoices, purchase-orders, settlements — усі використовують `limit=200`).

**Статус:** [x] виправлено

---

## Session 2026-05-25 — Phase 19 cycle 6 (post-merge sweep)

### Baseline (cycle 6)

- `tsc` web/api/shared — ✅ 0 errors
- Unit + contract + property API — ✅ 111/111 passed (12 файлів)
- API:UP, WEB:UP, Docker postgres/redis/minio запущені

### Знайдено багів у cycle 6: 4 (1 HIGH, 2 MEDIUM, 1 LOW)

---

## Bug #33 — [HIGH] `PricingRule.goodType` приймає будь-який рядок, що валить `applyRuleToGoods` runtime exception

**Файл:** `apps/api/src/modules/inventory/pricing-rules.dto.ts:33-35,96-98` + `apps/api/src/modules/inventory/pricing.service.ts:84`
**Severity:** HIGH
**Категорія:** business-logic / validation

**Опис:**
DTO `CreatePricingRuleDto.goodType` / `UpdatePricingRuleDto.goodType` має лише `@IsString()` без enum-валідації. Сервіс `applyRuleToGoods` (line 84) кастить значення до `GoodType` для filter Good-таблиці:
```ts
...(rule.goodType ? { goodType: rule.goodType as GoodType } : {})
```
Якщо адміністратор створює правило з `goodType: 'CONSUMABLE_TYPO'` (опечатка) або через API напряму — endpoint POST `/pricing-rules/:id/apply-all` падає з `500 Internal Server Error`, бо Postgres повертає `invalid input value for enum GoodType: "CONSUMABLE_TYPO"`.

Узгоджується з §1.1 чеклістом: "DTO validators must match runtime contract". Frontend дає select з 4 опціями, але API не валідує і приймає будь-який рядок.

**Очікувана поведінка:**
DTO відхиляє некоректний `goodType` з `400 Bad Request: "goodType must be one of: SPARE_PART, CONSUMABLE, MATERIAL, TOOL"`.

**Фактична поведінка:**
DTO приймає, БД зберігає, `applyRuleToGoods` падає з 500.

**Виправлення:**
Замінити `@IsString()` на `@IsEnum(GoodType)` у обох DTO. Імпортувати `GoodType` з `@prisma/client`.

**Статус:** [x] виправлено

---

## Bug #34 — [MEDIUM] `InventoryService.findStockItems` не фільтрує soft-deleted `good` і `warehouse` у relation

**Файл:** `apps/api/src/modules/inventory/inventory.service.ts:139-153`
**Severity:** MEDIUM
**Категорія:** soft-delete / business-logic

**Опис:**
`findStockItems` фільтрує `StockItem.deletedAt: null`, але `include: { good, warehouse }` без relation-фільтра `deletedAt: null`. Якщо адмін soft-deleted товар або склад, відповідні `StockItem` записи все ще активні (StockMovement пишеться на видалений товар не повинен, але існуючий запас залишається). У результаті:
- сторінка `/inventory` показує позиції з soft-deleted товарами/складами
- `findLowStockItems` (raw SQL нижче) фільтрує `g.deletedAt IS NULL`/`w.deletedAt IS NULL` — є невідповідність між двома endpoint-ами одного модуля

Узгоджується з §1.1: "Relation-фільтри теж — якщо findMany рендериться в UI з FK на іншу soft-deletable модель, додати where: { relatedModel: { deletedAt: null } }".

**Очікувана поведінка:**
`/stock-items` повертає лише позиції з активними товарами і складами.

**Фактична поведінка:**
Видалений товар → позиція з ним рендериться у списку інвентаря.

**Виправлення:**
Додати в `where`:
```ts
good: { deletedAt: null, ...(q ? { name: { contains: q, mode: 'insensitive' } } : {}) },
warehouse: { deletedAt: null },
```

**Статус:** [x] виправлено

---

## Bug #35 — [MEDIUM] `PricingRulesController.update` не нормалізує scope при PATCH без `goodId`

**Файл:** `apps/api/src/modules/inventory/pricing-rules.controller.ts:107` (PATCH endpoint, `normalizeScope` помічник)
**Severity:** MEDIUM
**Категорія:** api-contract / business-logic

**Опис:**
`normalizeScope(dto)` коректно очищає менш специфічні поля **лише коли користувач явно передав `goodId`** у DTO. У PATCH-сценарії "змінити правило з `goodId=A` на `goodCategory=X`" клієнт надсилає `{ goodId: null, goodCategory: 'X' }` АБО `{ goodCategory: 'X' }` (без `goodId`). У другому випадку:
- `normalizeScope` бачить `clone.goodId === undefined` → falsy → переходить до `else if (clone.goodCategory)` → нулить `goodType`
- АЛЕ існуючий `goodId` у БД залишається!
- Результат: правило має одночасно `goodId` І `goodCategory` → у `applyRuleToGoods` спрацьовує `WHERE id = goodId AND category = goodCategory` → жоден товар не матчиться (ймовірно) → правило виглядає "немає товарів для застосування".

Frontend `buildPayload` (PricingRulesClient.tsx:322-338) обходить це, явно ставлячи `goodCategory: form.goodId ? undefined : ...`. Але якщо клієнт буде кастомний (мобільний/integration), баг проявиться. API-контракт має бути self-consistent.

**Очікувана поведінка:**
PATCH з `{ goodCategory: 'X' }` (без `goodId`) при правилі з раніше встановленим `goodId` → backend очищає `goodId` АБО кидає 400 "Не можна вказувати goodCategory без явного скасування goodId".

**Фактична поведінка:**
Тихо зберігаємо некоректний стан (goodId+goodCategory одночасно).

**Виправлення:**
В `update` PATCH: якщо `dto.goodCategory !== undefined` і `existing.goodId !== null` і `dto.goodId === undefined` → автоматично зануляти `goodId` у нормалізованому payload (merge існуючого з новим scope hierarchy).

Спрощений патч:
```ts
const merged = { ...existing, ...dto };
const normalized = this.normalizeScope(merged);
const cleanValues = this.cleanValuesForType(normalized);
```

**Статус:** [x] виправлено

---

## Bug #36 — [LOW] `Dashboard` типує відповідь `/stock-items/low` як `WorkOrderSummary[]`

**Файл:** `apps/web/src/app/dashboard/page.tsx:94`
**Severity:** LOW
**Категорія:** typescript / api-contract

**Опис:**
`apiFetch<WorkOrderSummary[]>('/stock-items/low')` — `WorkOrderSummary` має поля `status`, `completedAt`, `totalAmount`, які не існують у `LowStockItem` (повертається з `findLowStockItems`: `{ goodId, goodName, ..., quantity, minStock, deficit }`). У runtime код використовує лише `.length`, тому помилка не проявляється, але type-guard зламаний — будь-який доступ до `lowStock.value[0].status` пройде TS, але буде `undefined`.

**Очікувана поведінка:**
Окремий інтерфейс `LowStockItem` (або хоч `unknown[]`) для точного типу.

**Фактична поведінка:**
TypeScript "довіряє" неправильному типу — JIT-помилка очікує знайтися лише через runtime.

**Виправлення:**
Додати локальний `interface LowStockItem { goodId: string; goodName: string; quantity: number; minStock: number; deficit: number; ... }` і використати `apiFetch<LowStockItem[]>`.

**Статус:** [x] виправлено

---

## Session 2026-05-25 — Phase 19.2 tester sweep (Toast/UnsavedGuard/StockIndicator/UI features)

### Baseline

- `tsc` web/api/shared — ✅ 0 errors
- Unit + contract + property API — ✅ 111/111 passed (12 файлів)
- Component (web vitest) — ✅ 42/42 passed (4 файли)
- E2E Playwright — ⏭ (dev server офлайн на момент Кроку 0.1)

### Перевірені файли (Phase 19.2 deliverables)

- `apps/web/src/lib/toast.ts` — singleton store + subscribe API
- `apps/web/src/components/ui/toast.tsx` — ToastContainer (mounted у TopShell)
- `apps/web/src/hooks/useUiFeatures.ts` — fetch + cache + invalidate
- `apps/web/src/hooks/useDirtyForm.ts` — beforeunload + confirmClose
- `apps/web/src/app/work-orders/[id]/PageClient.tsx` — stock indicator + toasts
- `apps/web/src/app/settings/page.tsx` — `tab === 'ui'` з 10 togglе-ами
- `apps/api/src/modules/settings/settings.{controller,service,dto}.ts`

---

## Bug #37 — [HIGH] `useUiFeatures` cache не очищається при logout (cross-session витік)

**Файл:** `apps/web/src/lib/auth/context.tsx:110-123` (logout)
**Severity:** HIGH
**Категорія:** security / tenant-isolation

**Опис:**
Модульно-глобальний `cache` у `apps/web/src/hooks/useUiFeatures.ts:35` зберігається протягом усього life-cycle сторінки браузера. При logout одного користувача і login іншого (особливо інший org/role на кіоск-машині або тестовому стенді):

1. User A (Org X, ADMIN) логіниться → cache наповнюється UI features Org X.
2. User A робить logout → `cache` залишається в пам'яті, `cacheExpiresAt = Number.MAX_SAFE_INTEGER`.
3. User B (Org Y, RECEPTIONIST) логіниться → `useUiFeatures` повертає cached Org X features.
4. Тільки після подальшого `sto:ui-features-change` (явне натискання "Зберегти" у Налаштуваннях) кеш оновиться — або через TTL для failure-кейсу (60s), якщо `apiFetch` помилково 401.

Це не лише cross-session UX-проблема (B бачить не свої flag-и), а й tenant isolation bug — Org X конфігурація leak у браузер Org Y.

**Очікувана поведінка:**
`logout()` у `auth/context.tsx` повинен викликати `invalidateUiFeaturesCache()` (та будь-які інші per-tenant client-side кеші) перед `dispatch({ type: 'LOGOUT' })`.

**Фактична поведінка:**
Cache живе доти, поки сторінка не перезавантажиться (F5).

**Виправлення:**
В `logout()` (і у failed-refresh shortcut на line 78-80) очищати cache UI features. Зробити це через імпорт `invalidateUiFeaturesCache` напряму, або (краще) через `window.dispatchEvent(new CustomEvent('sto:logout'))` + слухач у `useUiFeatures.ts`.

**Статус:** [x] виправлено

---

## Bug #38 — [MEDIUM] `updateOrganisationSettings` не валідує ключі `uiFeatures` (можна записати довільний junk у JSON)

**Файл:** `apps/api/src/modules/settings/settings.dto.ts:88-91` + `settings.service.ts:58-79`
**Severity:** MEDIUM
**Категорія:** security / input-validation / DoS

**Опис:**
DTO `UpdateOrganisationSettingsDto.uiFeatures` декларовано як `Partial<UiFeatures>` (TypeScript-only), але виключно з `@IsObject()` декоратором — class-validator не звіряє ключі/типи. PATCH запит з тілом `{ uiFeatures: { evilKey: '<величезний рядок>', anotherKey: { nested: '...' } } }` пройде валідацію, потрапить у `parseUiFeatures` (`{ ...UI_FEATURES_DEFAULTS, ...stored }`) і запишеться у Postgres JSON колонку. При наступних PATCH (`{ ...currentFeatures, ...dto.uiFeatures }`) накопичується — DoS-вектор з необмеженим розміром JSON. Крім того, через `mapOrgSettings → uiFeatures: this.parseUiFeatures(s.uiFeatures)` всі junk-ключі повертаються у GET-відповіді й leak-аться у браузерах усіх admin-ів org-а.

**Очікувана поведінка:**
DTO повинен:
1. Білити список ключів (whitelist) — лише 10 boolean-ів з `UiFeatures`.
2. Або у `settings.service.ts` явно `pick`-ати дозволені ключі перед merge.

Validation помилка → 400.

**Фактична поведінка:**
Будь-яке тіло проходить, накопичується нескінченно, leak-ається на читання.

**Виправлення (мінімальне):**
У `settings.service.ts:64-68` замість `{ ...currentFeatures, ...dto.uiFeatures }` зробити whitelist pick через `UI_FEATURES_DEFAULTS` keys:
```ts
const allowedKeys = Object.keys(UI_FEATURES_DEFAULTS) as (keyof UiFeatures)[];
const sanitized: Partial<UiFeatures> = {};
for (const k of allowedKeys) {
  const v = (dto.uiFeatures as Partial<UiFeatures>)[k];
  if (typeof v === 'boolean') sanitized[k] = v;
}
updateData = { ...dto, uiFeatures: { ...currentFeatures, ...sanitized } };
```

Також ОНОВИТИ `parseUiFeatures` щоб whitelist-ати на read — захист від legacy junk у DB.

**Статус:** [x] виправлено

---

## Bug #39 — [MEDIUM] `useDirtyForm` хук створений, але не використовується у жодному компоненті

**Файл:** `apps/web/src/hooks/useDirtyForm.ts` + (нема callers)
**Severity:** MEDIUM
**Категорія:** dead-code / incomplete-feature

**Опис:**
Phase 19.2 вводить feature flag `unsavedGuardEnabled` (default true) і `useDirtyForm({ enabled: features.unsavedGuardEnabled })` hook. Hook коректно реалізовано (markDirty/resetDirty/confirmClose + beforeunload listener). Однак `grep -rn useDirtyForm apps/web` повертає **тільки сам файл hook-у** — жодна форма (`work-orders/[id]/PageClient.tsx`, `settings/page.tsx`, CRM modal-и тощо) не імпортує його.

Тобто toggle `unsavedGuardEnabled` у налаштуваннях фактично нічого не робить — користувач увімкне його і очікуватиме попередження про незбережені зміни, але система мовчить.

**Очікувана поведінка:**
Принаймні один modal/форма (типово LineModal / PartModal у WorkOrder PageClient, або templateEditor у Settings) має:
1. Імпортувати `useDirtyForm({ enabled: features.unsavedGuardEnabled })`.
2. Викликати `markDirty()` у onChange кожного поля.
3. Викликати `confirmClose()` у onClose обгортці і `resetDirty()` після успішного save.

**Фактична поведінка:**
Hook існує як dead code; feature toggle обіцяє функціонал, який не реалізовано.

**Виправлення:**
Підключити `useDirtyForm` хоча б у `WorkOrderCardPage` Line/Part modal — це продемонструє інтеграцію і виправдає feature flag.

**Статус:** [x] виправлено

---

## Bug #40 — [LOW] `useUiFeatures` другий useEffect не скасовує промісу при unmount

**Файл:** `apps/web/src/hooks/useUiFeatures.ts:76-83`
**Severity:** LOW
**Категорія:** react / memory-leak

**Опис:**
```ts
useEffect(() => {
  const handler = () => {
    invalidateUiFeaturesCache();
    loadFeatures().then(setFeatures);   // ← no cancelled guard
  };
  window.addEventListener('sto:ui-features-change', handler);
  return () => window.removeEventListener('sto:ui-features-change', handler);
}, []);
```

Якщо подія `sto:ui-features-change` спрацьовує, потім компонент unmount-иться до резолву `loadFeatures()` — `setFeatures` буде викликано на unmounted компоненті. React 18 не кидає помилку, але це індикатор leak-у і нелогічний state-update.

Перший useEffect має `cancelled` flag — другий не має.

**Очікувана поведінка:**
Симетричний `cancelled` guard у handler-і.

**Фактична поведінка:**
Можливий setState після unmount при швидкій навігації.

**Виправлення:**
```ts
useEffect(() => {
  let cancelled = false;
  const handler = () => {
    invalidateUiFeaturesCache();
    loadFeatures().then(f => { if (!cancelled) setFeatures(f); });
  };
  window.addEventListener('sto:ui-features-change', handler);
  return () => { cancelled = true; window.removeEventListener('sto:ui-features-change', handler); };
}, []);
```

**Статус:** [x] виправлено

---

## Bug #41 — [LOW] Settings module не має жодного contract/spec тесту

**Файл:** `apps/api/src/modules/settings/` (відсутні `*.spec.ts`, `*.contract.spec.ts`)
**Severity:** LOW
**Категорія:** test-coverage

**Опис:**
Новий endpoint `GET /settings/ui-features` доступний всім авторизованим ролям, повертає `UiFeatures` shape. Frontend `useUiFeatures` довіряє цьому контракту і кешує модульно. Відсутність contract-тесту означає що:
- Зміна `OrganisationSettingsResponseDto.uiFeatures` без оновлення мапінгу не буде помічена тестами.
- Не перевіряється, що `403/401` повертається при відсутньому токені.
- Не перевіряється partial-merge поведінка `PATCH /settings/organisation` з `uiFeatures`.

**Очікувана поведінка:**
Contract test у `apps/api/src/modules/settings/settings.contract.spec.ts` що покриває:
- `GET /settings/ui-features` → 200 + boolean keys
- `PATCH /settings/organisation { uiFeatures: { toastEnabled: false } }` → 200 + merged result
- `PATCH /settings/organisation { uiFeatures: { unknownKey: true } }` → 200 і unknownKey ВІДКИНУТО (після Bug #38 fix)

**Фактична поведінка:**
Coverage = 0% у settings module.

**Виправлення:**
Створити `settings.contract.spec.ts` з трьома тест-кейсами вище.

**Статус:** [x] виправлено

---

## Session 2026-05-25 — Command Palette + Keyboard Shortcuts (Group 2)

Дата: 2026-05-25
Сесія: tester sweep після review fixes (commit 5e74ffb) — `command-palette.tsx`, `commands.ts`, `useKeyboardShortcut.ts`, `useGlobalShortcuts.ts`, `TopShell.tsx`

### Baseline
- TypeScript web/api/shared — ✅ 0 errors
- Unit + contract + property API — ✅ 117/117 passed (13 файлів)
- Component (web vitest) — ✅ 42/42 passed (4 файли)

### Знайдено: 5 bugs (1 MEDIUM, 4 LOW)

---

## Bug #42 — [MEDIUM] CommandPalette: клік по backdrop НЕ закриває палітру

**Файл:** `apps/web/src/components/ui/command-palette.tsx:114-124`
**Severity:** MEDIUM
**Категорія:** frontend / UX

**Опис:**
Outer dialog `<div>` має `onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}`.
Всередині нього два дочірні елементи: backdrop (`<div className="absolute inset-0 bg-black/40 ...">`)
і panel (`<div className="relative ...">`). Backdrop `absolute inset-0` повністю покриває outer div візуально,
тому будь-який клік "поза панеллю" приземляється на backdrop, а не на outer div.

`e.target === e.currentTarget` буде `true` тільки якщо користувач клікнув по `pt-[10vh]` /
`px-4` padding-у outer div — але цей padding знаходиться під backdrop-ом і недоступний для pointer events.

**Очікувана поведінка:**
Клік по будь-якому місцю backdrop-у (поза панеллю) закриває палітру.

**Фактична поведінка:**
Палітра не закривається ні за яких обставин кліком миші — тільки через Escape або повторний Ctrl+K.

**Виправлення:**
Перемістити `onMouseDown` з outer div на backdrop div (бо саме backdrop отримує клік).
Або додати `onMouseDown` на сам backdrop:
```tsx
<div className="absolute inset-0 bg-black/40 ..." onMouseDown={onClose} aria-hidden="true" />
```

**Статус:** [x] виправлено

---

## Bug #43 — [LOW] CommandPalette: миша поверх результатів перезатирає клавіатурне виділення

**Файл:** `apps/web/src/components/ui/command-palette.tsx:162`
**Severity:** LOW
**Категорія:** frontend / UX

**Опис:**
Кожен результат має `onMouseEnter={() => setActiveIndex(idx)}`. Якщо курсор миші
випадково знаходиться над одним з елементів (а не над пошуком, де користувач набирає),
то після зміни запиту фільтрований список перебудовується і елементи зсуваються під курсор —
вмикається mouseEnter і перебивається активний індекс, який користувач керував стрілками.

Це класична UX-помилка: клавіатурна навігація має мати пріоритет над hover, поки користувач рухає мишею.

**Очікувана поведінка:**
`setActiveIndex` через `onMouseEnter` має спрацьовувати лише при **реальному русі миші**
(а не коли список зсувається під нерухомий курсор).

**Фактична поведінка:**
Користувач набирає `на`, ArrowDown тричі — індекс 3. Список перебудовується,
елемент 0 опиняється під курсором → індекс стрибає на 0.

**Виправлення:**
Замінити `onMouseEnter` на `onMouseMove` — браузер видає `mousemove` лише при реальному русі курсора:
```tsx
onMouseMove={() => { if (activeIndex !== idx) setActiveIndex(idx); }}
```
Перевірка `if (activeIndex !== idx)` уникає зайвих setState.

**Статус:** [x] виправлено

---

## Bug #44 — [LOW] CommandPalette: O(n²) рендер через `flatList.indexOf(cmd)` у кожній ітерації

**Файл:** `apps/web/src/components/ui/command-palette.tsx:156`
**Severity:** LOW
**Категорія:** frontend / performance

**Опис:**
У map-у груп для кожного `cmd` виконується `flatList.indexOf(cmd)` — це лінійний пошук.
Загальна складність рендеру: O(N²) де N — кількість команд у відфільтрованому списку.

Зараз N=17 (15 nav + 2 action), тож проблема прихована, але якщо хтось додасть 50+ команд
(глобальний пошук документів/контрагентів) — рендер стане помітно повільнішим.

**Очікувана поведінка:**
O(N) рендер: знайти індекс через `Map<Command, number>` або обчислити інкрементально під час map.

**Виправлення:**
Замість `flatList.indexOf(cmd)` побудувати `Map<Command, number>` перед рендером:
```tsx
const flatIndex = useMemo(() => {
  const map = new Map<Command, number>();
  flatList.forEach((cmd, i) => map.set(cmd, i));
  return map;
}, [flatList]);
```
Тоді `const idx = flatIndex.get(cmd)!;` — O(1).

**Статус:** [x] виправлено

---

## Bug #45 — [LOW] CommandPalette: a11y — відсутні role=listbox/option, aria-selected, aria-activedescendant

**Файл:** `apps/web/src/components/ui/command-palette.tsx:144-181`
**Severity:** LOW
**Категорія:** frontend / a11y

**Опис:**
Compose-палітра — це паттерн `combobox + listbox`. Поточна реалізація:
- Список результатів — звичайний `<div>`, без `role="listbox"`.
- Кнопки результатів — `<button>`, без `role="option"` і `aria-selected`.
- Інпут — без `aria-activedescendant` що вказує на поточний обраний пункт.

Screen readers (NVDA, JAWS, VoiceOver) не оголошують зміну активного пункту під час
ArrowDown/ArrowUp у текстовому полі.

**Очікувана поведінка:**
ARIA combobox pattern (`role="combobox"` на input, `aria-controls` → listbox id,
`aria-activedescendant` → id поточного option; кожен option має `role="option"`
і `aria-selected={isActive}`).

**Виправлення:**
1. Додати `role="listbox"` + `id` на контейнер результатів.
2. Кожна `<button>` отримує `role="option"`, `aria-selected={isActive}`, унікальний `id`.
3. Інпут — `role="combobox"`, `aria-controls={listboxId}`,
   `aria-activedescendant` що вказує на id активного option.

**Статус:** [x] виправлено

---

## Session 2026-05-26 — Group 3 (Saved Filters + Inline Edit) tester sweep

Базова перевірка:
- `tsc` web/api/shared — ✅ 0 errors
- Unit + contract + property API — ✅ 117/117 passed (13 файлів)
- Web component tests — ✅ 55/55 passed (5 файлів)

Аналіз зосереджений на нових файлах Group 3:
- `apps/web/src/hooks/useSavedFilters.ts`
- `apps/web/src/components/ui/saved-filters-bar.tsx`
- `apps/web/src/components/ui/inline-edit-cell.tsx`
- `apps/web/src/hooks/useInlineEdit.ts`
- `apps/web/src/app/work-orders/page.tsx` (інтеграція)
- `apps/api/src/modules/work-orders/work-orders.dto.ts` (nullable dueDate/plannedAt)
- `apps/api/src/modules/work-orders/work-orders.service.ts` (explicit null vs undefined)

Знайдено багів у cycle Group 3: 6

---

## Bug #47 — [HIGH] Validation messages з class-validator повертаються англійською (порушує UI правило)

**Файл:** `apps/api/src/main.ts:25` (`ValidationPipe` без `exceptionFactory`); проявляється скрізь де є DTO з `class-validator`.
**Severity:** HIGH
**Категорія:** frontend / i18n / contract

**Опис:**
Глобальний `ValidationPipe` не має `exceptionFactory` що локалізує повідомлення. Тому всі помилки валідації з class-validator повертаються англійською:
- `dueDate must be a valid ISO 8601 date string`
- `vehicleId must be a UUID`
- `quantity must be a number conforming to the specified constraints`

Це порушує правило проекту: "API помилки — українською" (CLAUDE.md §16).
Інлайн-редагування Group 3 особливо помітно показує цей баг: користувач пише "abc" у dueDate → бачить англійський тост.

**Очікувана поведінка:**
Кожне повідомлення валідації — українською зрозумілою мовою (e.g., `dueDate: дата має бути у форматі ISO 8601 (YYYY-MM-DD)`).

**Фактична поведінка:**
Англійський текст з class-validator потрапляє у toast користувача через `HttpExceptionFilter` без перекладу.

**Виправлення:**
Додати `exceptionFactory` у `ValidationPipe` що мапить імена помилок (constraint keys: `isUuid`, `isIso8601`, `isEnum`, `min`, `max`, `isNumber`, `isInt`, `isPositive`, `isString`, `isNotEmpty`, `isBoolean`, `isOptional`, `arrayMinSize` тощо) до укр. шаблонів за полем.

**Статус:** [ ] відкритий

---

## Bug #48 — [MEDIUM] Unhandled Promise rejection на call-сайтах `inlineEdit.commitEdit()`

**Файл:** `apps/web/src/app/work-orders/page.tsx:398`, `:436`
**Severity:** MEDIUM
**Категорія:** frontend / robustness

**Опис:**
`inlineEdit.commitEdit(value)` — асинхронна функція що `re-throws` помилку (для збереження edit state на retry). Виклики:

```ts
onChange={e => inlineEdit.commitEdit(e.target.value)}     // priority select
onCommit={v => inlineEdit.commitEdit(v)}                  // InlineEditCell
```

Обидва ігнорують Promise. Коли `onSave` (всередині `useInlineEdit`) робить `throw e` після фейлу API, неперехоплений reject спливає у `unhandledrejection` event → червона помилка в console (Next.js dev overlay може показати).

**Очікувана поведінка:**
Promise rejection обробляється на call-site (мовчазно, бо помилка вже показана toast в `onSave`).

**Фактична поведінка:**
`Uncaught (in promise) Error: dueDate must be a valid ISO 8601 date string` у консолі браузера + потенційний error overlay.

**Виправлення:**
Додати `.catch(() => {})` (тост вже показаний в `onSave`):
```ts
onChange={e => { inlineEdit.commitEdit(e.target.value).catch(() => {}); }}
onCommit={v => { inlineEdit.commitEdit(v).catch(() => {}); }}
```
Також відобразити це у патерні `useInlineEdit` — повертати "void" з `commitEdit` (вже не Promise) і всередині ловити, але передавати помилку через callback. Простіший варіант — `.catch(noop)` на місці.

**Статус:** [ ] відкритий

---

## Bug #49 — [MEDIUM] InlineEditCell не підтримує `type="date"` — dueDate редагується як plain text

**Файл:** `apps/web/src/components/ui/inline-edit-cell.tsx:12`, використання у `apps/web/src/app/work-orders/page.tsx:438`
**Severity:** MEDIUM
**Категорія:** frontend / UX

**Опис:**
`InlineEditCell` приймає `type?: 'text' | 'number'`. dueDate (поле дати) редагується з `type="text"` — без native date picker.
Користувач має вручну набирати `2026-05-25` без підказок. Будь-яке введення (наприклад `25/05/2026`, `tomorrow`, `abc`) проходить клієнт без перевірки і відхиляється сервером з англійським повідомленням (див. Bug #47).

**Очікувана поведінка:**
Для дати — native date picker (`<input type="date">`) з власним календарем браузера. Опціонально — `time-local` для plannedAt.

**Фактична поведінка:**
Text input, користувач має знати формат дати, помилки лише після server round-trip.

**Виправлення:**
Розширити union type: `type?: 'text' | 'number' | 'date' | 'datetime-local'`. Передавати у `<input type={type}>`. Тестами підтвердити що `date` рендериться без помилок і повертає ISO формат у `onChange`.

**Статус:** [ ] відкритий

---

## Bug #50 — [LOW] InlineViewCell без `aria-label` — screen readers не знають що редагується

**Файл:** `apps/web/src/components/ui/inline-edit-cell.tsx:96`
**Severity:** LOW
**Категорія:** accessibility

**Опис:**
```tsx
<span role="button" tabIndex={0} title="Натисніть для редагування" ...>
```
Має `title` атрибут (показується як tooltip), але NVDA/JAWS можуть його НЕ озвучити. WAI-ARIA вимагає `aria-label` або текстовий контент для `role="button"`. Якщо `children` — це Badge без тексту або іконка, скрін-рідер прочитає лише "клацабельний елемент".

**Очікувана поведінка:**
`aria-label="Редагувати <field>: <value>"` або принаймні `aria-label={\`Редагувати: \${value}\`}`.

**Фактична поведінка:**
Без aria-label — невідомо що це поле редагування.

**Виправлення:**
Прийняти опціональний пропс `ariaLabel?: string` і застосувати до span. Default = "Натисніть для редагування".

**Статус:** [ ] відкритий

---

## Bug #51 — [LOW] `useSavedFilters` не валідує тип збереженого значення (corruption defense)

**Файл:** `apps/web/src/hooks/useSavedFilters.ts:27-33`
**Severity:** LOW
**Категорія:** robustness

**Опис:**
```ts
const raw = localStorage.getItem(storageKey);
return raw ? (JSON.parse(raw) as SavedFilter<T>[]) : [];
```
`JSON.parse` повертає що завгодно — `null`, `{...}`, `42`, "string". Якщо інший таб або користувач вставив у DevTools `localStorage.setItem('sto_filters_work-orders', '{}')` — `read()` поверне `{}` як `SavedFilter<T>[]`. Потім `SavedFiltersBar.saved.map(...)` крашиться (`.map is not a function`) і компонент рендерить error boundary.

**Очікувана поведінка:**
Якщо парс повертає не-масив → повернути `[]` (як при `catch`).

**Фактична поведінка:**
Можливий runtime crash при corrupted localStorage.

**Виправлення:**
```ts
const parsed = JSON.parse(raw);
return Array.isArray(parsed) ? (parsed as SavedFilter<T>[]) : [];
```

**Статус:** [ ] відкритий

---

## Bug #52 — [LOW] Відсутні тести для нових Group 3 компонентів (SavedFiltersBar, InlineEditCell, useInlineEdit, useSavedFilters)

**Файл:** `apps/web/src/components/ui/__tests__/` (missing files)
**Severity:** LOW
**Категорія:** test-coverage

**Опис:**
Group 3 додав 4 нові примітиви UI без тестів. Існуючий патерн (`button.test.tsx`, `modal.test.tsx`, `command-palette.test.tsx`) показує що тести компонентів очікувані.

**Очікувана поведінка:**
- `saved-filters-bar.test.tsx` — empty state; рендер пресетів; клік Save → відкриває input; Enter зберігає; Esc закриває; Remove видаляє.
- `inline-edit-cell.test.tsx` — рендер з value; Enter commit; Escape cancel; Check/X кнопки; aria-labels.
- `useInlineEdit.test.tsx` — startEdit/commitEdit/cancelEdit; saving guard блокує double-commit; trimmed equal skips save.
- `useSavedFilters.test.tsx` — SSR-safe (initial []); hydrate з localStorage у useEffect; save/remove/rename; corruption defense.

**Фактична поведінка:**
0 тестів для Group 3 файлів.

**Виправлення:**
Додати 4 файли тестів вище. Покриття ≥80% для кожного хука/компонента.

**Статус:** [ ] відкритий

---

**Файл:** `apps/web/src/components/ui/command-palette.tsx:52-58`
**Severity:** LOW
**Категорія:** frontend / a11y

**Опис:**
При відкритті палітри фокус переноситься на input. При закритті (Escape, клік mouse, навігація
через Enter) фокус втрачається — переходить на `document.body`. Користувачі клавіатури і
screen-reader-ів очікують, що фокус повернеться до останнього елемента, що мав фокус до відкриття
(зазвичай це кнопка "Пошук..." у sidebar або у mobile header).

WAI-ARIA Authoring Practices для modal dialog вимагає `restore focus to element that opened the dialog`.

**Очікувана поведінка:**
При закритті палітри фокус повертається до елемента, що його викликав.

**Фактична поведінка:**
Фокус потрапляє на `<body>` — користувач втрачає контекст.

**Виправлення:**
Зберегти `document.activeElement` у `useRef` при відкритті; при закритті — `.focus()` на нього.

```tsx
const previousFocusRef = useRef<HTMLElement | null>(null);
useEffect(() => {
  if (open) {
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    const id = window.setTimeout(() => inputRef.current?.focus(), 50);
    return () => window.clearTimeout(id);
  } else {
    previousFocusRef.current?.focus?.();
  }
}, [open]);
```

**Статус:** [x] виправлено

---

