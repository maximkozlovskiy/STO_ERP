# Invoice — Dossier

> Рахунок клієнту. Може бути прив'язаний до наряду або виставлений окремо.

---

## Prisma модель

```prisma
model Invoice {
  id              String        @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId           String        @db.Uuid
  counterpartyId  String        @db.Uuid
  workOrderId     String?       @db.Uuid
  number          String
  amount          Decimal       @db.Decimal(12, 2)
  status          InvoiceStatus @default(DRAFT)
  dueDate         DateTime?
  invoiceType     String        @default("INVOICE")
  notes           String?
  paidAmount      Decimal       @default(0) @db.Decimal(12, 2)
  totalWithoutVat Decimal       @default(0) @db.Decimal(12, 2)
  totalVat        Decimal       @default(0) @db.Decimal(12, 2)
  totalWithVat    Decimal       @default(0) @db.Decimal(12, 2)
  currencyId      String?       @db.Uuid   // мультивалюта Фаза 3: валюта документа
  totalAmountBase Decimal?      @db.Decimal(12, 2) // amount у БАЗОВІЙ валюті org по курсу на documentDate
  rateUsed        Decimal?      @db.Decimal(18, 6)
  documentDate    DateTime      @default(now()) @db.Date
  syncVersion     BigInt        @default(0)
  createdAt       DateTime      @default(now())
  updatedAt       DateTime      @updatedAt
  deletedAt       DateTime?
}
```

> **Мультивалюта (Фаза 3, 2026-09-14):** `amount`/`paidAmount`/`total*` тепер у **валюті документа**
> (`currencyId`; nullable → base UAH для історичних). `totalAmountBase`/`rateUsed` — тотал у базовій
> валюті по курсу на `documentDate` (recalcTotals; fallbackToLatest). createFromWorkOrder успадковує
> валюту наряду. Standalone CHARGE (SEND) і mirror PAYMENT (manual→PAID) пробрасують `currencyId`+`date`
> у settlement → борг у base. **Оплата рахунку має бути у ТІЙ САМІЙ валюті** (payments.service: валюта
> оплати == валюта рахунку, інакше 400; overpay/paidAmount порівнюються у валюті документа). Іновалютний
> рахунок структурно нефіскалізовний. FX-різниці — поза Фазою 3.

**Відносини:**

- → `Counterparty` (M:1 через `counterpartyId`)
- → `WorkOrder` (M:1 через `workOrderId`, optional — рахунок може бути без наряду)
- ← `Payment[]` (платежі по рахунку)
- ← `InvoiceLine[]` (рядки: роботи + товари)

**Індекси:**

- `(orgId, status, deletedAt)` — список по статусу
- `(orgId, workOrderId, deletedAt, createdAt)` — covering для getLinkedDocuments (WO Documents tab)

---

## FSM

```
DRAFT → SENT → PARTIALLY_PAID → PAID
      ↘ CANCELLED   ↘ PAID       ↘ CANCELLED
OVERDUE → PAID / CANCELLED
```

| Статус           | Значення                                      |
| ---------------- | --------------------------------------------- |
| `DRAFT`          | Чернетка, редагується                         |
| `SENT`           | Надіслано клієнту                             |
| `PARTIALLY_PAID` | Частково оплачено (`0 < paidAmount < amount`) |
| `PAID`           | Оплачено (`paidAmount >= amount`)             |
| `OVERDUE`        | Прострочено (dueDate < today)                 |
| `CANCELLED`      | Скасовано                                     |

**FSM файл:** `apps/api/src/modules/invoices/invoices.service.ts` (`INV_TRANSITIONS`),
дзеркалить `INVOICE_STATUS_TRANSITIONS` у `@sto/shared`.

**Сторно оплати (BR-CASH-024):** `PAID` / `PARTIALLY_PAID` → `PARTIALLY_PAID` (залишилась інша
оплата, `paidAmount > 0`) або `SENT` (`paidAmount` стало 0) — теж не через FSM-endpoint, а запис
статусу й `paidAmount` у `PaymentsService.reverse` (CAS по прочитаних `paidAmount` і статусу). Сторнована
оплата не входить у «сплачено» рахунку (відбір `reversedAt: null`), але видна в «Пов'язаних документах»
з позначкою `reversedAt`. Скасований рахунок сторно оплати не приймає (400).

**Важливо:** `PARTIALLY_PAID` виставляється **лише** частковим платежем
(`PaymentsService.create`), а НЕ через FSM-endpoint. FSM-перехід у `PARTIALLY_PAID`
відсутній у мапі навмисно (`SENT → [PAID, CANCELLED]`).

**Скасування виставленого standalone-рахунку (BR-INV-022):** `transition` → `CANCELLED` для
рахунку без наряду, який уже проходив `SENT` (тобто мав нарахований `CHARGE`), постить
компенсуючий `CREDIT_NOTE` на **непогашений залишок** (`amount − paidAmount`) у тій самій
транзакції після зміни статусу — інакше борг лишився б у леджері назавжди. `DRAFT → CANCELLED`
нічого не сторнує (`CHARGE` ще не було). Рахунок наряду цю гілку не зачіпає — його сторнує
WO-шлях `returnPartsAndCredit`.

---

## API Endpoints (`/api/invoices`)

| Метод  | URL                                                  | Дія                                                                                                                                                                    |
| ------ | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/invoices`                                      | Список (фільтри: status, statuses — кілька через кому, counterpartyId, q, dateFrom, dateTo, showDeleted)                                                               |
| GET    | `/api/invoices/:id`                                  | Деталь з lines                                                                                                                                                         |
| GET    | `/api/invoices/:id/lines-summary`                    | Зведення по табличних частинах: роботи / товари / інше (BR-WO-009 у `work-order.md`); ролі — як у списку                                                               |
| POST   | `/api/invoices`                                      | Створити рахунок (lines у body)                                                                                                                                        |
| POST   | `/api/invoices/from-work-order/:workOrderId`         | Створити з наряду (auto-fill lines)                                                                                                                                    |
| POST   | `/api/invoices/from-work-order/:workOrderId/refresh` | Оновити рядки з наряду                                                                                                                                                 |
| GET    | `/api/invoices/from-work-order/:workOrderId/find`    | Знайти існуючий рахунок по наряду (lightweight: `{ id, number, status: InvoiceStatus, amount, documentDate: string \| null }` або `null`); виключає `CANCELLED`        |
| PATCH  | `/api/invoices/:id`                                  | Оновити (тільки DRAFT)                                                                                                                                                 |
| POST   | `/api/invoices/:id/transition`                       | FSM перехід                                                                                                                                                            |
| POST   | `/api/invoices/:id/clone`                            | Клонувати рахунок                                                                                                                                                      |
| GET    | `/api/invoices/:id/pdf`                              | PDF рахунку: шапка з логотипом і реквізитами організації; «Реквізити для оплати» (одержувач, ЄДРПОУ, IBAN, банк, МФО) — коли в НДІ задано основний банківський рахунок |
| DELETE | `/api/invoices/:id`                                  | Soft-delete                                                                                                                                                            |
| POST   | `/api/invoices/:id/lines`                            | Додати рядок                                                                                                                                                           |
| PATCH  | `/api/invoices/:id/lines/:lineId`                    | Оновити рядок (лише DRAFT): опис, кількість, ціна, ставка ПДВ, порядок; товар, робота й одиниця не міняються (BR-INV-017, BR-INV-024)                                  |
| DELETE | `/api/invoices/:id/lines/:lineId`                    | Видалити рядок                                                                                                                                                         |

---

## UI (Web)

| Компонент / сторінка  | Файл                                           |
| --------------------- | ---------------------------------------------- |
| Список                | `app/(app)/invoices/page.tsx`                  |
| Модалка створення     | `components/ui/InvoiceCreateModal.tsx`         |
| Detail Panel schema   | `lib/panel-schema.ts` → `INVOICE_PANEL_SCHEMA` |
| Hook (TanStack Query) | `hooks/api/useInvoices.ts`                     |

**Друк.** У боковій панелі списку поруч із «Завантажити PDF» — «Друкувати PDF» (`printPdf` з
`lib/download.ts`: вікно друку відкривається до запиту PDF); для рахунку, позначеного на
видалення, обидві сховано (BR-WO-012). З наряду — «Друк рахунку» в картці й на сторінці наряду
(див. [work-order.md](work-order.md), BR-WO-013). Шапку й реквізити PDF будує
`OrgPrintInfoService` (модуль `pdf`) — та сама шапка, що в наряді й актах. Дата друкованого
рахунку — дата документа (`documentDate`, як у списку), а не мітка створення запису.

**Рядки чернетки.** У картці рахунку в статусі «Чернетка» кількість і ціна кожного рядка — поля
вводу; змінений збережений рядок іде `PATCH`-ем (той самий рядок, BR-INV-024), сума рядка й «Разом»
перераховуються одразу (сума з ПДВ — пропорційно, ставка рядка та сама: `lib/invoice-line-total.ts`).
Кнопка видалення рядка має підпис «Видалити позицію: …» і видима з клавіатури.

---

## Бізнес-правила (BR-INV)

- **BR-INV-001**: Номер авто-генерується: `DocumentNumberService.next(orgId, 'INVOICE')`
- **BR-INV-002**: Рахунок із наряду (`POST /from-work-order/:id`) одразу, у тій самій транзакції,
  отримує рядки — роботи й запчастини наряду — і суму, що дорівнює сумі наряду до сплати
  (`amount = totalWithVat = wo.totalAmount`, `totalWithoutVat = wo.totalNet`): саме її вже
  нараховано клієнтові боргом. Режим ПДВ рядків визначає сам наряд, а не поточні налаштування:
  наряд без ПДВ у сумі дає рядки без ПДВ. Наряд рахує ПДВ від суми, рядки — кожен від себе, тож
  різницю в копійки забирає останній рядок (якщо він нульовий або від різниці став би від'ємним —
  найближчий попередній ненульовий); різниця понад копійку на рядок — помилка 400
  (тотали наряду не відповідають рядкам), а не вирівнювання. **Ставка ПДВ рядків — до копійки з
  нарядом** (рішення власника 2026-10-30, TECH-DEBT (б) №6): лише ставка з довідника податків
  організації (`TaxRate`, зокрема вимкнені — ставку могли вимкнути після завершення наряду), що за
  формулою наряду дає рівно його ПДВ: `calcVatOnBase(база, ставка, режим) = totalAmount − totalNet`,
  де база — `totalNet` («ПДВ зверху») або `totalAmount` («ПДВ у ціні»), BR-WO-007. Першою пробується
  ставка за замовчуванням (налаштування), далі решта довідника; ставка поза довідником не береться.
  Такої ставки немає (ПДВ наряду 140,07 на 700 — «20,01 %», або на копійку більший за 20 %) → 400
  `err.invoice.workOrderVatRateUnknown` («ПДВ наряду (≈13 %) не відповідає жодній ставці з довідника
  податків… Додайте ставку 13 % в НДІ → Ставки ПДВ (можна вимкненою)»), рахунок не створюється
  (раніше ставка виводилась із тоталів, а копійку ПДВ забирав останній рядок). Помилка називає
  наближену ставку наряду (частка ПДВ від суми без ПДВ) і дію в довіднику: завершений наряд не
  редагується й назад у роботу не переходить, тож «перерахувати наряд» неможливо (Bug #1030). «Оновити з наряду»
  (`POST /from-work-order/:id/refresh`, лише DRAFT) будує рядки тим самим кодом і оновлює також
  суму в базовій валюті та курс
- **BR-INV-003**: `invoiceType` — UI-enum `STANDARD`/`PREPAYMENT`/`CREDIT_NOTE` (`INVOICE_TYPE_VALUES`/
  `INVOICE_TYPE_LABELS` у `@sto/shared`). Prisma-колонка має `@default("INVOICE")` (legacy,
  поза enum-ом) — тому `create()` і `createFromWorkOrder()` в `invoices.service.ts` ЗАВЖДИ
  ставлять `invoiceType` явно (`'STANDARD'`), ніколи не покладаються на DB-дефолт.
  `InvoiceCreateModal` при завантаженні рахунку нормалізує будь-яке значення поза enum-ом
  (старі рядки з БД) на `'STANDARD'` через `normalizeInvoiceType()` — інакше zodResolver
  валить submit формою `invoiceFormSchema` (fix 675d6b4c, Аудит #1 Фаза 3).
- **BR-INV-004**: `dueDate` контролюється `invoiceDueDays` з `SettingsService.get(orgId)` — не хардкодиться
- **BR-INV-005**: `OVERDUE` встановлюється автоматично (scheduler або при відкритті списку)
- **BR-INV-006**: При оплаті → `SettlementsService.createTransaction(PAYMENT)` (не пряма зміна балансу)
- **BR-INV-007**: `InvoiceLine`: кожен рядок має `vatRate`, `priceWithoutVat`, `vatAmount`, `priceWithVat`
- **BR-INV-008**: Підсумки рахунку рахує **бекенд**, не фронт. Після кожної зміни рядка
  (`addLine`/`updateLine`/`removeLine`) `InvoicesService.recalcTotals()` бере
  `invoiceLine.aggregate(_sum)` → `totalWithoutVat`/`totalVat`/`totalWithVat` і ставить
  `amount = totalWithVat`. Web ці суми показує, а не обчислює: сторінка `/invoices` виводить поля з
  API; `InvoiceCreateModal` для прев'ю «Разом» складає `priceWithVat` рядків, повернутий API, а для
  ще не збереженого рядка — `quantity × unitPrice` (ПДВ додасть бекенд при збереженні).
  `calcVatTotals()` з `apps/web/src/lib/utils.ts` рахунок **не використовує** — єдиний споживач
  `CreateWorkOrderModal`.

### Часткова оплата (модель грошей, Фаза 1)

- **BR-INV-009**: `paidAmount` — **авторитетна колонка** сплаченого. Оновлюється транзакційно при кожному
  платежі. `toDto` читає її; фолбек на `sum(payments)` лише коли колонки немає у вибірці.
- **BR-INV-010**: **Оплата** (`PaymentsService.create` з `invoiceId`): дозволена лише для
  `SENT`/`PARTIALLY_PAID`/`OVERDUE` (прострочений рахунок усе ще належить сплатити; збігається з
  BR-PAY-003 у [payments.md](payments.md)), інакше 400;
  переплата (`amount > amount − paidAmount`) → 400. Атомарно: **CAS** `updateMany({ where:
paidAmount = прочитане }, data: paidAmount += amount, status: newPaid>=amount ? PAID :
PARTIALLY_PAID)`. `count=0` (гонка паралельного платежу) → throw → rollback усього
  (Payment + PAYMENT-settlement) у тій самій `$transaction`. **FIN-C1 інваріант** — під
  ReadCommitted захищає оптимістичний CAS по `paidAmount`, не рівень ізоляції.
- **BR-INV-011**: **Ledger:** кожен частковий платіж створює один `PAYMENT`-settlement своєї суми
  (`BALANCE_SIGN[PAYMENT] = −1`) → борг зменшується рівно на суму кожного платежу; подвійного
  списання немає.
- **BR-INV-012**: **Ручний PAID** (`transition` → `PAID`): синхронізує `paidAmount = amount` (щоб «залишок» був 0). Лише для рахунку без наряду — рахунок наряду закривається оплатою (BR-INV-019).
  Для **standalone**-рахунку (`workOrderId = null`, CHARGE нараховано при `SENT`) у тій самій
  транзакції створює **дзеркальний `PAYMENT`-settlement** на непокритий залишок
  (`amount − paidAmount`, `documentType: 'Invoice'`) — він закриває CHARGE у леджері, тож баланс
  контрагента не показує борг за рахунком у статусі «PAID» (Bug #675). Раніше зроблені часткові
  оплати не подвоюються: проводка лише на залишок, а при нульовому залишку її немає.
  Для **WO-рахунку** `PAYMENT` НЕ створюється (його CHARGE нараховано при COMPLETED наряду, оплата
  йде окремо через `payments`) — інакше подвійний облік. Рядок `Payment` ручний перехід не створює
  в жодному випадку: це закриття боргу в леджері, а не запис про отримані гроші (без каси, ПРРО
  і рахунку-призначення). Звичайний шлях погашення — реєстрація платежу (кнопка «Оплатити»).
  CAS-перехід у `PAID` має у `where` і `status`, і **`paidAmount`** (дзеркалить `payments.service`,
  `work-order-invoice-mirror`): дзеркальний `PAYMENT` рахується зі стального `paymentRemaining`
  (прочитаного поза транзакцією), тож без `paidAmount` у `where` паралельна оплата через
  `payments`-модуль не детектилась би — `updateMany` затер би `paidAmount = amount` і створив
  фантомний кредит клієнта в леджері (аудит логіки 2026-10-24, F6). `count === 0` → той самий
  `err.invoice.statusChanged`, жодного дзеркального PAYMENT.

### Рахунок-призначення платежу (`Payment.sourceType`)

- **BR-INV-013**: `Payment` знає, **куди фізично лягли гроші**: `sourceType` (`BANK_ACCOUNT`/`CASH_REGISTER`) +
  `bankAccountId`/`cashRegisterId`. Джерело: DTO явно → інакше дефолт з `PaymentMethodConfig`
  (`defaultSourceType`/`defaultBankAccountId`/`defaultCashRegisterId`) → інакше `null`. Id без `sourceType`
  у запиті задає й тип (каса → `CASH_REGISTER`, рахунок → `BANK_ACCOUNT`).
- **BR-INV-014**: Валідація (`resolveDestinationAccount`): рахунок мусить бути в межах org (не крос-tenant) і живий.
  **Явний** з DTO невалідний рахунок → 4xx; **дефолт з config** що з тих пір видалено (stale) →
  тихо `null` (offline-first: не валимо легітимний платіж через застарілий конфіг). Виняток — готівка:
  без каси вона не приймається (BR-PAY-019 у [payments.md](payments.md)), тож застаріла каса
  за замовчуванням у «Готівки» дає 400. Задають замовчування в НДІ → «Оплата» (`PATCH /payment-methods/:id`).
- **BR-INV-015**: Source-link (куди лягли гроші) борг/settlement не змінює — це різні виміри. Але оплата без нього не пишеться: готівка — з касою (BR-PAY-019), безготівкова — з банківським рахунком чи касою способу (BR-PAY-023); без призначення лишаються лише онлайн-оплати від шлюзу й історичні записи.
- **BR-INV-016**: FK `ON DELETE SET NULL` (рахунки нормально soft-delete-яться; hard-delete лишає Payment з
  `null`-source, зберігаючи суму й settlement).
- **BR-INV-017**: Рядок рахунку, доданий чи змінений вручну, рахує ПДВ за режимом організації:
  «ПДВ у ціні» — ПДВ виділяється із суми рядка (сума рядка = кількість × ціна), інакше —
  нараховується зверху. Без ПДВ в організації ставка за замовчуванням 0; ставка, явно передана в
  запиті, нараховується зверху
- **BR-INV-018**: **Рахунок наряду — дзеркало наряду** (рішення власника 2026-10-15). Для активного рахунку з
  `workOrderId` `paidAmount = min(paidAmount наряду, amount)`; статус: SENT / PARTIALLY_PAID / OVERDUE / PAID
  → PAID при повній сумі, PARTIALLY_PAID при частковій, SENT (OVERDUE лишається OVERDUE) при нулі; DRAFT і
  CANCELLED статус не змінюють, але DRAFT теж показує сплачене; на DRAFT → SENT статус береться за сплаченим.
  Перераховується в тій самій транзакції після кожної зміни `paidAmount` наряду (оплата, сторно) і при
  створенні, оновленні з наряду, перерахунку й відправці рахунку (`syncWorkOrderInvoicePaid`). Нічна звірка
  для рахунку наряду очікує `min(Σ оплат наряду без сторно, amount)`, а для наряду — `paidAmount = Σ оплат`
- **BR-INV-019**: **Ручний «Оплачено» для рахунку наряду** → 400 «Рахунок наряду закривається оплатою —
  скористайтесь «Оплатити»»; web цього переходу для рахунку наряду не показує
- **BR-INV-020**: **Рахунок з наряду переносить сплачене**: створений рахунок одразу має `paidAmount` за
  BR-INV-018. Створення дозволене й для наряду «Оплачено» (`WO_INVOICE_CREATABLE_STATUSES`) — повністю
  сплачений наряд стає «Оплачено» ще до рахунку; такий рахунок — чернетка зі сплаченим = сума
- **BR-INV-022**: **Скасування виставленого standalone-рахунку → `CREDIT_NOTE` на непогашений залишок** (MV-H1, 2026-10-25). `transition` → `CANCELLED` для рахунку без наряду (`workOrderId = null`), який уже був у `SENT`/`PARTIALLY_PAID`/`OVERDUE` (отже, мав нарахований `CHARGE`), постить компенсуючий `CREDIT_NOTE` на `amount − paidAmount` у тій самій транзакції після CAS-flip статусу — борг у леджері обнуляється на непогашене, часткові оплати лишаються. `DRAFT → CANCELLED` не постить проводку (`CHARGE` нараховується лише на `DRAFT → SENT`). Конверсія `CREDIT_NOTE` дзеркалить курс оригінальної `CHARGE` (залишок × `rateUsed` оригіналу), legacy без збереженого курсу — ре-конвертація за датою документа (`fallbackToLatest`), як WO-шлях `returnPartsAndCredit`. Рахунок наряду цю гілку не зачіпає. `createdBy` — користувач переходу (F10)
- **BR-INV-023**: **Рахунок без рядків не виставляється** (рішення власника 2026-10-29; РАХ-2026-004310 мав суму 100,00 без жодного рядка). Перехід `DRAFT → SENT` для рахунку без рядків (`InvoiceLine` — 0) → 400 `err.invoice.noLinesToIssue`, і для standalone, і для рахунку наряду; `DRAFT → CANCELLED` дозволено. Перевірка — до CAS-переходу й до `CHARGE` (FIN-C2). Чернетка з сумою без рядків лишається можливою (створення двокрокове: `POST /invoices`, далі рядки). Уже виставлені без рядків рахунки не змінюються. Web: «Виставити» неактивна з підказкою, поки рядків немає
- **BR-INV-024**: **Картка рахунку: спершу додати й змінити рядки, потім видалити** (як BR-WO-035 наряду; чистка API 2026-10-30). «Зберегти зміни» чернетки: `PATCH` шапки → `POST` нових рядків → `PATCH` збережених рядків, змінених у картці (кількість і ціна правляться на місці, прапорець `_dirty`), → `DELETE` прибраних — останнім. Усе послідовно: кожен запит перераховує суми рахунку (`recalcTotals` без транзакції, паралельні запити губили б суму). Раніше `DELETE` ішов першим, а змінити рядок можна було лише видаленням і новим рядком. Збій `POST` нічого не видаляє; відмова одного `DELETE` не зупиняє решти, невидалені лишаються на повтор, помилка — у картці (картка не закривається). Повторне «Зберегти» не задвоює вже додані рядки (Bug #755) і шле ті самі `PATCH` (ідемпотентні); доданий рядок отримує у формі `id` з відповіді `POST`, тож якщо після збою його прибрати перед повтором — повтор його видаляє (`DELETE`), а не лишає сиротою на сервері. Схема оновлення рядка (`invoiceLineUpdateSchema`) не містить `goodId`/`workId`/`unitOfMeasureId` — `updateLine` їх не застосовує, тож контракт їх і не обіцяє (зайві поля мовчки відкидаються). Рядки рахунку (картка, дублювання, друк) упорядковано `sortOrder`, далі `createdAt`, `id`: ручні рядки мають `sortOrder` 0, і без вторинного ключа змінений на місці рядок перескакував у кінець (Bug #1013). Помилка збереження — над шапкою картки: «Додати» шапку згортає (Bug #1014). Прев'ю зміненого рядка рахує ПДВ, як `updateLine`: сума з ПДВ дорівнювала сумі рядка → нова сума, інакше нова сума + ПДВ за ставкою рядка, округлений окремо (Bug #1015). (`InvoiceCreateModal.handleSave`)
- **BR-INV-026**: **Картка рахунку: «Оплачено» — вікно оплати** (рішення власника 2026-10-31). Крок
  «Оплачено» у статусах картки рахунку без наряду (стрілка «▶» і пункт меню статусу «Оплатити»)
  відкриває те саме вікно оплати, що «Оплатити» в бічній панелі списку (`ClientPaymentModal`: спосіб,
  каса / рахунок, сума — залишок, ключ ідемпотентності), — `POST /payments`, а не перехід. Після оплати
  картка лишається відкритою зі статусом від сплаченого («Оплачено» / «Частково оплачено») і оновлює
  список (`onSaved`). Ручного переходу в PAID без грошей (з дзеркальною проводкою, BR-INV-012) з
  картки більше немає; маршрут `POST /invoices/:id/transition {PAID}` лишається для інших клієнтів API
  (старі рахунки, закриті вручну, — TECH-DEBT (б) №53, лишити). Крок показується лише ролям, що
  реєструють оплату (`PAYMENT_CREATE_ROLES`), і не показується рахунку наряду (BR-INV-019). QR-оплата
  з картки не пропонується — вона в списку рахунків.
- **BR-INV-025**: **«Прострочено» одразу** (рішення власника 2026-10-30, TECH-DEBT (б) №44). Статус виставленого рахунку від сплаченого — одна формула `invoiceStatusForPaid` (`invoices/invoice-paid-status.ts`) для оплати рахунку без наряду, сторно й дзеркала рахунку наряду (`mirroredInvoiceStatus`, у `syncWorkOrderInvoicePaid` читається й `dueDate`): сплачено повністю → «Оплачено»; інакше, якщо термін минув (`dueDate` раніше за київську дату сьогодні — та сама умова, що в нічній позначці `invoice-overdue.processor`), → «Прострочено»; частково → «Частково оплачено»; нічого → «Виставлено» («Прострочено» з нулем ним і лишається). Часткова оплата чи сторно простроченого рахунку не повертають його в «Частково оплачено» / «Виставлено» до ночі. Чернетка й скасований не змінюються.
- **BR-INV-021**: **Одиниця рядка — як у наряді** (Bug #868, 2026-10-22). Рядок рахунку з наряду отримує одиницю рядка запчастини наряду (`unitOfMeasureId` — `UnitOfMeasure.id`), кількість і ціна — у тій самій одиниці; клонування рахунку її зберігає. Картка й друкований рахунок показують одиницю рядка, коефіцієнт — з пари (товар, одиниця) у `GoodUoM`; без одиниці рядка — базова одиниця товару. Ручний рядок (`POST /invoices/:id/lines`) приймає `unitOfMeasureId` як `UnitOfMeasure.id` — так само, як рядок наряду; одиниця, якої немає в товару, — 404. Роботи йдуть у годинах (факт, інакше норма): рядок роботи (`workId`) без власної одиниці картка й друкований рахунок показують з «год» (`WORK_UNIT_SHORT_NAME` у `@sto/shared`, рішення власника 2026-10-22; раніше друкувалось «шт»), ручний рядок без товару й роботи друкується «шт»

---

## Аспекти і тести, що їх стережуть

Правите один аспект — ганяєте один файл:

```bash
cd apps/api && npx vitest run src/modules/invoices/<файл>.spec.ts
```

**Модуль:** `apps/api/src/modules/invoices/`

| Аспект                                                                                        | Тест                                       | Кейсів |
| --------------------------------------------------------------------------------------------- | ------------------------------------------ | ------ |
| BullMQ-processor: OVERDUE за фільтром, подія на кожен рахунок (BR-INV-005, BR-AUT-060)        | `invoice-overdue.processor.spec.ts`        | 6      |
| HTTP-контракт (DTO, статуси, валідація)                                                       | `invoices.contract.spec.ts`                | 45     |
| документ, позначений на видалення, — лише перегляд (BR-WO-012)                                | `invoices.with-deleted.spec.ts`            | 13     |
| create defaults (номер, invoiceType)                                                          | `invoices.create-defaults.spec.ts`         | 5      |
| create from work order; ставка ПДВ з довідника (BR-INV-002)                                   | `invoices.create-from-work-order.spec.ts`  | 16     |
| dto and linked docs                                                                           | `invoices.dto-and-linked-docs.spec.ts`     | 14     |
| due date                                                                                      | `invoices.due-date.spec.ts`                | 7      |
| find by work order                                                                            | `invoices.find-by-work-order.spec.ts`      | 5      |
| line totals (recalcTotals на бекенді)                                                         | `invoices.line-totals.spec.ts`             | 19     |
| список: відбір за датою документа                                                             | `invoices.list-date-filter.spec.ts`        | 6      |
| список: відбір за контрагентом, статусами, пошук                                              | `invoices.list-filters.spec.ts`            | 7      |
| refresh from work order                                                                       | `invoices.refresh-from-work-order.spec.ts` | 16     |
| transition settlements; виставлення без рядків (BR-INV-023)                                   | `invoices.transition-settlements.spec.ts`  | 23     |
| рахунок наряду — дзеркало наряду, подія зміни статусу (BR-INV-018, 020, 023, 025, BR-AUT-060) | `work-order-invoice-mirror.spec.ts`        | 38     |
| статус від сплаченого: «Прострочено» одразу (BR-INV-025)                                      | `invoice-paid-status.spec.ts`              | 14     |
| update: зміна контрагента (org, роль)                                                         | `invoices.update-counterparty.spec.ts`     | 5      |
| рядки рахунку з наряду (чиста функція); ставка ПДВ до копійки з нарядом                       | `invoices.work-order-lines.spec.ts`        | 30     |
| друкований рахунок: реквізити своєї організації, дата, валюта, 404                            | `invoices.pdf.spec.ts`                     | 4      |
| одиниця рядка як у наряді (Bug #868), робота — «год»; порядок рядків (BR-INV-024)             | `invoices.line-units.spec.ts`              | 9      |

Разом: **281** кейс (цифри з `vitest --reporter=json`, не з grep).

Правило → тест для BR-INV-026 — «Оплачено» в картці рахунку (мітки `// guards:`):

- `apps/web/src/components/ui/__tests__/InvoiceCreateModal.pay-step.test.tsx` (6) — «▶ Оплачено» і
  пункт меню «Оплатити» відкривають вікно оплати цього рахунку (сума, сплачене, платник, валюта),
  переходу немає; повна оплата → «Оплачено» й `onSaved`, часткова → «Частково оплачено», наступне
  вікно бачить нове сплачене; рахунку наряду й ролі без права оплати кроку немає;
- E2E `apps/web/e2e/client-payments.spec.ts` («картка рахунку: створити → «Надіслано» → «▶ Оплачено»…»)
  — рахунок створено й виставлено в картці через інтерфейс, «▶ Оплачено» → вікно → оплата в касу:
  рахунок PAID, рядок каси, залишок каси виріс, переходів — лише SENT; наступний кейс — картка на
  390 px без горизонтальної прокрутки, поля шапки одним стовпцем.

Правило → тест для BR-INV-024 — збереження рядків картки (web і контракт, мітки `// guards:`):

- `apps/web/src/components/ui/__tests__/InvoiceCreateModal.save-order.test.tsx` (6) — порядок
  POST → PATCH → DELETE, PATCH лише зміненого рядка, збій POST нічого не видаляє, відмова одного
  DELETE не зупиняє інших і повтор шле лише невидалений, прев'ю суми рядка й «Разом»; помилка — поза
  згорнутою шапкою (Bug #1014);
- `apps/web/src/lib/__tests__/invoice-line-total.test.ts` (6) — прев'ю суми рядка (новий, збережений,
  змінений — ПДВ за ставкою рядка, як `updateLine`; «ПДВ у ціні»; без ставки — пропорція);
- `apps/api/src/modules/invoices/invoices.line-units.spec.ts`, `invoices.pdf.spec.ts` — порядок рядків
  картки й друку: `sortOrder`, `createdAt`, `id` (Bug #1013);
- `apps/web/src/components/ui/__tests__/InvoiceCreateModal.line-unit.test.tsx` (3) — у чернетці
  кількість — поле з одиницею рядка поруч (BR-INV-021);
- `apps/api/src/common/pipes/invoice-schema.spec.ts` (17) — схема оновлення рядка без
  `goodId`/`workId`/`unitOfMeasureId`, межі кількості й ціни (BR-INV-017);
- E2E `apps/web/e2e/invoice-line-edit.spec.ts` — рахунок із рядком через інтерфейс, у картці
  чернетки кількість 1 → 3: сума рядка й «Разом» до збереження, після — той самий рядок (id) і сума
  рахунку від сервера.

Правило → тест (мітки `// guards:`) для правил про суму з наряду і ПДВ рядка:

- `invoices.work-order-lines.spec.ts` — BR-INV-002: `buildInvoiceLinesFromWorkOrder` на числах — три
  режими ПДВ, Σ рядків = тотали наряду, тотожність рядка, копійка в останній рядок, межа допуску
  (копійка на рядок), режим і ставка з наряду, а не з налаштувань, `WorkOrderTotalsMismatchError`,
  порядок і `sortOrder`; один кейс property-based (fast-check) на тоталах, порахованих як у наряді.
  Ставка до копійки (TECH-DEBT (б) №6): 20,01 % і «20 % + копійка» → помилка «ставка», порожній
  довідник, ставка налаштувань поза довідником не береться, інша ставка довідника (14), дві ставки з
  однаковим ПДВ → з налаштувань, «ПДВ у ціні» — від суми до сплати. Мутації (2026-10-31): без
  перевірки `calcVatOnBase = ПДВ наряду` → 5 кейсів червоні; без фільтра «лише з довідника» → 2;
  довідник лише з активних ставок → червоніє кейс «вимкнена ставка» у create-from-work-order.
- `invoices.create-from-work-order.spec.ts` — BR-INV-002: рядки й суми пишуться клієнтом тієї
  самої транзакції, що створила рахунок; `amount = totalWithVat = wo.totalAmount`; розбіжність
  тоталів → 400 зсередини транзакції; base-сума і курс.
- `invoices.refresh-from-work-order.spec.ts` — BR-INV-002: «Оновити з наряду» тим самим кодом,
  оновлення `totalAmountBase` / `rateUsed`; розбіжність → 400 після `deleteMany` у транзакції.
- `invoices.line-totals.spec.ts` — BR-INV-017: `addLine` / `updateLine` у трьох режимах організації.
- `invoices.transition-settlements.spec.ts` — BR-INV-023: DRAFT → SENT без рядків → 400 до CAS і
  CHARGE (standalone і рахунок наряду), лічильника немає → 400 (fail-closed), CANCELLED дозволено;
  `work-order-invoice-mirror.spec.ts` — лічильник за рядками саме цього рахунку. Web-половину
  стереже `apps/web/src/components/ui/__tests__/InvoiceCreateModal.issue-without-lines.test.tsx`
  (3 кейси), браузерну — `apps/web/e2e/invoices.spec.ts` («Рахунки — FSM переходи»).

Правила оплати рахунку виконує `PaymentsService` (модуль `payments`), тому їхні сторожі живуть
у спеках того модуля, а не тут (реєстр цих файлів — у [payments.md](payments.md)):

- `apps/api/src/modules/payments/payments.money-model.spec.ts` — BR-INV-010, 011, 013, 014, 015;
- `apps/api/src/modules/payments/payments.idempotency.spec.ts` — BR-INV-010, 014.

**Розходження з кодом.** Правила, де дос'є каже одне, а код робить інше. Агент цього не «лагодить»: рішення —
виправити код чи переписати правило — за людиною. Поки запис тут, гейт D правило не блокує,
але показує окремим рядком.

_Немає._

**Чого тут НЕМА.** Інваріантного спеку (`*.invariants.spec.ts`) немає, хоча агрегат на шляху грошей або статусів: властивості на кшталт «фінальний статус без виходів» не стережуться нічим. Свідома прогалина — кандидат на окремий крок.

Правило без unit-тесту:

- Дію `ON DELETE SET NULL` на `Payment.bankAccountId`/`cashRegisterId` стереже integration-спек
  `apps/api/src/prisma/schema-integrity.integration.spec.ts` (читає `pg_constraint` живої БД; без
  БД кейс пропускається). Сам hard-delete рахунку чи каси з наявним платежем не відтворюється.

Web-половину правила про підсумки (прев'ю «Разом» у `InvoiceCreateModal`: сума `priceWithVat`
рядків з API, для незбереженого рядка — `quantity × unitPrice`, для зміненого — пропорційно)
стережуть `lib/__tests__/invoice-line-total.test.ts` і
`components/ui/__tests__/InvoiceCreateModal.total.test.tsx`; бекенд-половину —
`invoices.line-totals.spec.ts`.

Web-половина правила про `invoiceType` (нормалізація значення поза enum-ом у `InvoiceCreateModal`
через `normalizeInvoiceType()`) тесту не має: функція не експортована, потрібен компонентний тест.

→ [docs/BUSINESS-RULES.md](../BUSINESS-RULES.md)
