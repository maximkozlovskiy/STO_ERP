# Cash / Каса — Dossier

> Рух готівки в касах: внесення (cash-in) та видача (cash-out), баланс каси, статті витрат.
> ЄДИНА точка руху готівки — `CashService.createOperation` (аналог `SettlementsService.createTransaction`).

---

## Prisma моделі

```prisma
enum CashDirection { IN OUT }
enum CashOperationReason {
  SALE_PAYMENT    // оплата клієнта готівкою (авто з payments)
  REFUND          // повернення клієнту
  PAYROLL         // виплата ЗП (авто з payroll)
  SUPPLIER_PAYMENT // оплата постачальнику
  EXPENSE         // витрата (стаття витрат)
  COLLECTION      // інкасація / виїмка
  MANUAL_IN MANUAL_OUT
}

model CashRegister {           // + до наявних полів:
  isFiscal       Boolean @default(false)  // фіскальна → операції лише у відкриту зміну + ПРРО
  initialBalance Decimal @default(0) @db.Decimal(12,2)
  operations     CashOperation[]
}

// Append-only (шаблон SettlementTransaction: без deletedAt/updatedAt/syncVersion).
model CashOperation {
  id, orgId, cashRegisterId, cashShiftId?  // cashShiftId — для фіскальної каси
  direction CashDirection, amount Decimal(12,2)   // amount>0, знак з direction
  reason CashOperationReason
  expenseCategoryId?  // стаття (для EXPENSE)
  counterpartyId?, employeeId?  // клієнт/постачальник | співробітник (PAYROLL)
  documentType?, documentId?    // 'Payment' | 'PayrollPeriod'
  notes?, createdBy?, createdAt
  // @@index([orgId,cashRegisterId,createdAt]) [orgId,cashShiftId] [orgId,reason,createdAt]
}

model ExpenseCategory {        // довідник статей витрат (per-org, дзеркалить GoodStatus)
  id, orgId, name, syncVersion, createdAt, updatedAt, deletedAt?
  // @@unique([orgId,name])
}
```

`CashOperation` — append-only, не у SYNC_VERSION_MODELS; у audit-whitelist. `ExpenseCategory` — у SYNC.

---

## Баланс

`balance = initialBalance + Σ(IN.amount) − Σ(OUT.amount)` (SQL-агрегат, `CashService.getBalance`).
Рахується **свіжим поза кешем** (findAll/findOne кешують лише статичну частину каси; balance — завжди актуальний).

---

## Фіскальна / нефіскальна каса

- **Фіскальна** (`isFiscal=true`): операції з готівкою лише у **відкриту зміну** (`CashShift`); createOperation
  знаходить OPEN-зміну каси або кидає 400. Наявний ПРРО-потік (sellReceipt у зміну) не зачеплено.
- **Нефіскальна**: постійний залишок, операції без зміни (`cashShiftId=null`).

---

## API Endpoints

**Каси** (`/api/cash-registers`) — OWNER/ADMIN CRUD; список/баланс/операції — +ACCOUNTANT/RECEPTIONIST:

| Метод             | URL                              | Дія                                            |
| ----------------- | -------------------------------- | ---------------------------------------------- |
| GET               | `/cash-registers`                | Список кас (+ isFiscal/initialBalance/balance) |
| POST/PATCH/DELETE | `/cash-registers[/:id]`          | CRUD (OWNER/ADMIN)                             |
| GET               | `/cash-registers/:id/balance`    | Поточний залишок                               |
| GET               | `/cash-registers/:id/operations` | Історія операцій (limit, q, dateFrom, dateTo)  |
| POST              | `/cash-registers/:id/operations` | Ручна IN/OUT (OWNER/ADMIN/ACCOUNTANT)          |

**Статті витрат** (`/api/expense-categories`) — GET OWNER/ADMIN/ACCOUNTANT; CRUD OWNER/ADMIN
(GET/POST/PATCH/DELETE/`:id/restore`).

---

## Інтеграції

- **Payments** (`payments.service.create`): оплата клієнта method=cash (`sourceType=CASH_REGISTER`) →
  авто cash-in `reason=SALE_PAYMENT` у **ту саму `$transaction`** що Payment+settlements. Фіскальна каса
  без зміни → 400 → повний відкат оплати.
- **Payroll** (`payroll.service.pay(cashRegisterId?)`): виплата ЗП → cash-out `reason=PAYROLL` по кожному
  співробітнику у `$transaction`. Без каси — лише фіксація `paidAmount` (без руху готівки).

---

## UI (Web)

Сторінка «Каса» (`/cash`) — вкладки: **Операції** (перемикач кас + баланс + внести/видати + історія +
зміна для фіскальної) · **Каси** (CRUD) · **Статті витрат** (CRUD). Вкладки/кнопки гейтуються за роллю
(RECEPTIONIST — лише перегляд «Операції»). Payroll pay-модалка — вибір каси для видачі ЗП готівкою.

| Компонент        | Файл                                                                                          |
| ---------------- | --------------------------------------------------------------------------------------------- |
| Сторінка/вкладки | `app/(app)/cash/page.tsx` + `CashOperationsTab`/`CashRegistersTab`/`ExpenseCategoriesTab.tsx` |
| Hooks            | `hooks/api/useCash.ts`, `hooks/api/useExpenseCategories.ts`                                   |

---

## Інваріанти

1. **Рух готівки лише через `CashService.createOperation`** — append-only, atomic, приймає зовнішній tx.
   Виправлення — сторно-операцією протилежного напряму (не edit/delete).
2. Гроші: `Decimal(12,2)` + `roundMoney`; `amount>0`; знак з `direction`. Баланс не кешується стейл.
3. Tenant-isolation: orgId у кожному запиті; операція валідує касу/статтю/counterparty належать org.
4. Employee ≠ counterparty → ЗП саме касовою операцією (не через SettlementAccount).

→ [docs/objects/payroll.md](payroll.md) · [docs/objects/settlements.md](settlements.md)

---

## Бізнес-правила (BR-CASH)

> Правила виведено з коду 2026-10-08, власником не затверджені.

- **BR-CASH-001**: Єдиний писар. Рядок журналу каси (`CashOperation`) створює лише `CashService.createOperation()`. Ніде більше в `apps/api/src` немає запису в `CashOperation` — ні через Prisma-делегат, ні вкладеним записом через `operations: { … }`, ні сирим SQL. Оплата клієнта готівкою, оплата постачальнику готівкою, виплата зарплати з каси й ручні операції йдуть через цей метод
- **BR-CASH-002**: Журнал лише дописується. У коді api немає зміни чи видалення `CashOperation`; у моделі немає `deletedAt` і `updatedAt`. Помилку виправляє зворотна операція протилежного напряму, а не правка рядка
- **BR-CASH-003**: Ізоляція організацій. Каса шукається за `id` + `orgId` серед невидалених (`deletedAt: null`): чужа або видалена каса дає 404 «Касу не знайдено» і в `createOperation`, і в `getBalance`. Стаття шукається так само (`id` + `orgId`, невидалена), відкрита зміна — за `orgId`. Операція пишеться з `orgId` викликача; агрегати залишку (`getBalance`, `getBalances`) та історія (`listOperations`) фільтруються за `orgId`
- **BR-CASH-004**: Сума операції додатна, знак несе `direction`. Сума округлюється до копійки до будь-яких перевірок; якщо після округлення вона не більша за нуль (`0`, від'ємна, менша за пів копійки, `NaN`, `Infinity`) → 400 «Сума має бути додатною», касу не читаємо, нічого не пишемо. У журнал `amount` пишеться додатним і для `IN`, і для `OUT`
- **BR-CASH-005**: Фіскальна каса (`isFiscal = true`) — операція лише у відкриту зміну. `createOperation` шукає невидалену зміну саме цієї каси зі статусом `OPEN`: немає → 400 «Для фіскальної каси відкрийте зміну перед операціями з готівкою», нічого не пишеться; є → її id пишеться в `cashShiftId`. Нефіскальна каса: зміну не шукають, `cashShiftId = null`. Правило діє і на авто-операції (оплата клієнта, оплата постачальнику, зарплата): відмова відкочує всю транзакцію викликача
- **BR-CASH-006**: Каса не йде в мінус. Перед видачею (`OUT`) читається поточний залишок; якщо `залишок − сума` менше нуля (порівняння з допуском −0,001, тож нестача в одну копійку вже блокує) → 400 «Недостатньо готівки в касі: доступно X, потрібно Y», нічого не пишеться. Видати рівно весь залишок можна. Внесення (`IN`) залишком не обмежується. Залишок читається тим самим клієнтом БД, яким пишеться операція, тож кілька видач в одній транзакції (зарплата по співробітниках) бачать уже списане попередніми
- **BR-CASH-007**: Стаття руху коштів на операції необов'язкова. Якщо задана — мусить існувати в цій організації (інакше 404 «Статтю не знайдено»), бути активною (вимкнена, `isActive = false` → 400 «Стаття вимкнена — оберіть активну») і відповідати напряму: `OUT` — лише стаття типу `EXPENSE` (інакше 400 «Для видачі оберіть статтю витрат»), `IN` — лише `INCOME` (інакше 400 «Для внесення оберіть статтю оприбуткування»)
- **BR-CASH-008**: Ручна операція з причиною `EXPENSE` вимагає статтю: без `expenseCategoryId` → 400 «Для витрати вкажіть статтю витрат», до каси не доходить. Для інших причин стаття необов'язкова. Перевірка є лише на ручному шляху (`createManual`)
- **BR-CASH-009**: Залишок каси = `initialBalance + Σ(IN.amount) − Σ(OUT.amount)` у валюті каси, округлений до копійки. Він щоразу рахується з журналу й окремо ніде не зберігається. Пакетний розрахунок для списку кас (`getBalances`) дає те саме одним запитом; каса без операцій має залишок `initialBalance`. `getBalance` для неіснуючої каси → 404 «Касу не знайдено»
- **BR-CASH-010**: Мультивалюта. Валюта операції — валюта каси (`CashRegister.currencyId`), викликач її не передає. Сума перераховується в базову валюту організації через `ExchangeRatesService.resolveBaseConversion(orgId, валюта каси, зараз, amount)`; у журнал пишуться `amount` (у валюті каси), `amountBase` і `rateUsed`. Якщо конвертація кидає помилку (немає курсу на дату) — вона йде викликачу, нічого не пишеться; тихого відкату на курс 1 немає. Залишок і перевірка «не в мінус» рахуються у валюті каси (`amount`), не в базовій
- **BR-CASH-011**: Атомарність. Якщо викликач передав свою транзакцію (`tx`) — пошук каси, статті, зміни, читання залишку й запис операції йдуть у ній, власна не відкривається (відкат оплати відкочує і рух готівки). Якщо не передав — читання залишку й запис ідуть у власній транзакції рівня `Serializable`; конфлікт серіалізації (`P2034`) повертається як 400 «Каса зайнята паралельною операцією — повторіть», інші помилки БД не перекладаються
- **BR-CASH-012**: Прив'язка до документа. `reason`, `counterpartyId`, `employeeId`, `documentType`, `documentId`, `notes`, `createdBy` пишуться в рядок журналу як передані, непередані — `null`. `documentType` — довільний рядок (`Payment`, `SupplierPayment`, `PayrollPeriod`), не enum; існування документа, контрагента і співробітника `createOperation` не перевіряє, причину з напрямом не звіряє. Ручна операція: автор — користувач запиту, документ і співробітник не задаються
- **BR-CASH-013**: Аудит. Операція з автором (`createdBy`) залишає в журналі аудиту запис `CREATE` (`CashOperation`, id операції, напрям, сума, причина); без автора — не залишає. Аудит пишеться після запису операції й поза транзакцією: його збій операцію не скасовує і помилки не дає
- **BR-CASH-014**: Ролі. Ручну операцію (`POST /cash-registers/:id/operations`) проводять OWNER, ADMIN, ACCOUNTANT. Список кас, залишок та історію операцій бачить ще й RECEPTIONIST. Картку однієї каси (`GET /cash-registers/:id`) — OWNER, ADMIN, ACCOUNTANT. Створювати, змінювати й видаляти касу можуть лише OWNER і ADMIN
- **BR-CASH-015**: Історія операцій каси віддається від найновіших до найстаріших, за замовчуванням 100 рядків, не більше 500 за запит (не число, нуль чи від'ємне в `limit` — ті самі 100); зсуву (пагінації) немає. У рядку: суми числами, дата в ISO, назва статті з довідника

---

## Аспекти і тести, що їх стережуть

Правите один аспект — ганяєте один файл:

```bash
cd apps/api && npx vitest run src/modules/cash/<файл>.spec.ts
```

**Модуль:** `apps/api/src/modules/cash/`

| Аспект                                                                 | Тест                            | Кейсів |
| ---------------------------------------------------------------------- | ------------------------------- | ------ |
| сервісна логіка: гілки createOperation, overdraft, залишок             | `cash.service.spec.ts`          | 28     |
| рядок журналу: сума, зміна, стаття, конфлікт, документ, аудит, історія | `cash.operation-record.spec.ts` | 34     |
| ізоляція організацій (умови запитів)                                   | `cash.tenant.spec.ts`           | 5      |
| єдиний писар і append-only (статичний сторож по вихідному коду)        | `cash.single-writer.spec.ts`    | 3      |
| ролі на маршрутах `/cash-registers`                                    | `cash.access.spec.ts`           | 8      |

Разом: **78** кейсів (цифри з `vitest --reporter=json`, не з grep). Спільний harness нових спеків — `cash.spec-fixture.ts`.

**Межі сторожів.** Мітка `// guards:` означає «порушення правила в коді валить цей тест» (кожну перевірено мутацією 2026-10-08), але не «правило стережеться повністю»:

- BR-CASH-001, BR-CASH-002 — сторож статичний (читає вихідний код): не бачить запису через змінну-делегат (`const d = tx.cashOperation; d.update(…)`) і вкладеного запису через зв'язок, крім прямого `operations: { … }`. На рівні БД заборони UPDATE/DELETE немає.
- BR-CASH-006, BR-CASH-011 — справжню конкуренцію (два одночасні `OUT` на той самий залишок → другий отримує 400) unit-тест із моком Prisma не відтворює: стережеться лише те, що запитано рівень `Serializable` і `P2034` перекладено в 400. Потрібен integration-спек.
- BR-CASH-012 — стережеться запис полів «як передані». Те, що існування контрагента, співробітника й документа не перевіряється і що причина не звіряється з напрямом, — відсутність захисту, тестом її не закріплено.
- BR-CASH-014 — ролі перевірено за метаданими `@Roles` контролера. Гейт вкладок і кнопок за роллю на сторінці `/cash` (`page.tsx`, `canOperate`/`canManage`) web-тестом не стережеться.
- Кейс `expenseCategoryId не належить org → 404` у `cash.service.spec.ts` мітки НЕ має свідомо: якщо прибрати всю валідацію статті, він лишається зеленим (404 тоді дає пошук каси в `getBalance`). Правило про статтю стереже кейс «стаття не знайдена → 404 «Статтю не знайдено»» у `cash.operation-record.spec.ts`, що звіряє текст помилки.

**Чого тут НЕМА.** Інваріантного спеку (`*.invariants.spec.ts`) немає: властивість «після будь-якої послідовності операцій залишок не від'ємний і дорівнює `initialBalance + ΣIN − ΣOUT`» property-тестом не стережеться.

HTTP-контракту ручної операції немає: валідацію `CreateCashOperationDto` (`amount` — додатне число, `direction`/`reason` — enum, `notes` до 500 символів, UUID статті й контрагента) і розбір `?limit=` не покриває жоден спек модуля.

Інтеграція з викликачами тут не стережеться: те, що готівкова оплата клієнта, оплата постачальнику й виплата зарплати викликають `createOperation` у своїй транзакції, перевіряють спеки модулів `payments`, `supplier-payments`, `payroll` (їхні дос'є).

Web: `CashPage.test.tsx` покриває лише віджет зміни фіскальної каси; модалку «внести/видати», перемикач кас і показ залишку компонентним тестом не покрито.
