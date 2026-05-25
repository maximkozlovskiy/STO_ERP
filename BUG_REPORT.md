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
