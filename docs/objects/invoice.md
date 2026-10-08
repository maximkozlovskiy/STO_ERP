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

**Важливо:** `PARTIALLY_PAID` виставляється **лише** частковим платежем
(`PaymentsService.create`), а НЕ через FSM-endpoint. FSM-перехід у `PARTIALLY_PAID`
відсутній у мапі навмисно (`SENT → [PAID, CANCELLED]`).

---

## API Endpoints (`/api/invoices`)

| Метод  | URL                                                  | Дія                                                                                                                                                             |
| ------ | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/invoices`                                      | Список (фільтри: status, counterpartyId, dateFrom, dateTo)                                                                                                      |
| GET    | `/api/invoices/:id`                                  | Деталь з lines                                                                                                                                                  |
| POST   | `/api/invoices`                                      | Створити рахунок (lines у body)                                                                                                                                 |
| POST   | `/api/invoices/from-work-order/:workOrderId`         | Створити з наряду (auto-fill lines)                                                                                                                             |
| POST   | `/api/invoices/from-work-order/:workOrderId/refresh` | Оновити рядки з наряду                                                                                                                                          |
| GET    | `/api/invoices/from-work-order/:workOrderId/find`    | Знайти існуючий рахунок по наряду (lightweight: `{ id, number, status: InvoiceStatus, amount, documentDate: string \| null }` або `null`); виключає `CANCELLED` |
| PATCH  | `/api/invoices/:id`                                  | Оновити (тільки DRAFT)                                                                                                                                          |
| POST   | `/api/invoices/:id/transition`                       | FSM перехід                                                                                                                                                     |
| POST   | `/api/invoices/:id/clone`                            | Клонувати рахунок                                                                                                                                               |
| GET    | `/api/invoices/:id/pdf`                              | Завантажити PDF                                                                                                                                                 |
| DELETE | `/api/invoices/:id`                                  | Soft-delete                                                                                                                                                     |
| POST   | `/api/invoices/:id/lines`                            | Додати рядок                                                                                                                                                    |
| PATCH  | `/api/invoices/:id/lines/:lineId`                    | Оновити рядок                                                                                                                                                   |
| DELETE | `/api/invoices/:id/lines/:lineId`                    | Видалити рядок                                                                                                                                                  |

---

## UI (Web)

| Компонент / сторінка  | Файл                                           |
| --------------------- | ---------------------------------------------- |
| Список                | `app/(app)/invoices/page.tsx`                  |
| Модалка створення     | `components/ui/InvoiceCreateModal.tsx`         |
| Detail Panel schema   | `lib/panel-schema.ts` → `INVOICE_PANEL_SCHEMA` |
| Hook (TanStack Query) | `hooks/api/useInvoices.ts`                     |

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
  (тотали наряду не відповідають рядкам), а не вирівнювання. «Оновити з наряду»
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
- **BR-INV-012**: **Ручний PAID** (`transition` → `PAID`): синхронізує `paidAmount = amount` (щоб «залишок» був 0).
  Для **standalone**-рахунку (`workOrderId = null`, CHARGE нараховано при `SENT`) у тій самій
  транзакції створює **дзеркальний `PAYMENT`-settlement** на непокритий залишок
  (`amount − paidAmount`, `documentType: 'Invoice'`) — він закриває CHARGE у леджері, тож баланс
  контрагента не показує борг за рахунком у статусі «PAID» (Bug #675). Раніше зроблені часткові
  оплати не подвоюються: проводка лише на залишок, а при нульовому залишку її немає.
  Для **WO-рахунку** `PAYMENT` НЕ створюється (його CHARGE нараховано при COMPLETED наряду, оплата
  йде окремо через `payments`) — інакше подвійний облік. Рядок `Payment` ручний перехід не створює
  в жодному випадку: це закриття боргу в леджері, а не запис про отримані гроші (без каси, ПРРО
  і рахунку-призначення). Звичайний шлях погашення — реєстрація платежу (кнопка «Оплатити»).

### Рахунок-призначення платежу (`Payment.sourceType`)

- **BR-INV-013**: `Payment` знає, **куди фізично лягли гроші**: `sourceType` (`BANK_ACCOUNT`/`CASH_REGISTER`) +
  `bankAccountId`/`cashRegisterId`. Джерело: DTO явно → інакше дефолт з `PaymentMethodConfig`
  (`defaultSourceType`/`defaultBankAccountId`/`defaultCashRegisterId`) → інакше `null`.
- **BR-INV-014**: Валідація (`resolveDestinationAccount`): рахунок мусить бути в межах org (не крос-tenant) і живий.
  **Явний** з DTO невалідний рахунок → 4xx; **дефолт з config** що з тих пір видалено (stale) →
  тихо `null` (offline-first: не валимо легітимний платіж через застарілий конфіг).
- **BR-INV-015**: Source-link — **опційна метадані**; борг/settlement від нього не залежать (два різні виміри).
- **BR-INV-016**: FK `ON DELETE SET NULL` (рахунки нормально soft-delete-яться; hard-delete лишає Payment з
  `null`-source, зберігаючи суму й settlement).
- **BR-INV-017**: Рядок рахунку, доданий чи змінений вручну, рахує ПДВ за режимом організації:
  «ПДВ у ціні» — ПДВ виділяється із суми рядка (сума рядка = кількість × ціна), інакше —
  нараховується зверху. Без ПДВ в організації ставка за замовчуванням 0; ставка, явно передана в
  запиті, нараховується зверху

---

## Аспекти і тести, що їх стережуть

Правите один аспект — ганяєте один файл:

```bash
cd apps/api && npx vitest run src/modules/invoices/<файл>.spec.ts
```

**Модуль:** `apps/api/src/modules/invoices/`

| Аспект                                  | Тест                                       | Кейсів |
| --------------------------------------- | ------------------------------------------ | ------ |
| BullMQ-processor                        | `invoice-overdue.processor.spec.ts`        | 4      |
| HTTP-контракт (DTO, статуси, валідація) | `invoices.contract.spec.ts`                | 27     |
| create defaults (номер, invoiceType)    | `invoices.create-defaults.spec.ts`         | 5      |
| create from work order                  | `invoices.create-from-work-order.spec.ts`  | 13     |
| dto and linked docs                     | `invoices.dto-and-linked-docs.spec.ts`     | 8      |
| due date                                | `invoices.due-date.spec.ts`                | 7      |
| find by work order                      | `invoices.find-by-work-order.spec.ts`      | 5      |
| line totals (recalcTotals на бекенді)   | `invoices.line-totals.spec.ts`             | 12     |
| refresh from work order                 | `invoices.refresh-from-work-order.spec.ts` | 15     |
| transition settlements                  | `invoices.transition-settlements.spec.ts`  | 10     |
| update: зміна контрагента (org, роль)   | `invoices.update-counterparty.spec.ts`     | 5      |
| рядки рахунку з наряду (чиста функція)  | `invoices.work-order-lines.spec.ts`        | 22     |

Разом: **133** кейсів (цифри з `vitest --reporter=json`, не з grep).

Правило → тест (мітки `// guards:`) для правил про суму з наряду і ПДВ рядка:

- `invoices.work-order-lines.spec.ts` — BR-INV-002: `buildInvoiceLinesFromWorkOrder` на числах — три
  режими ПДВ, Σ рядків = тотали наряду, тотожність рядка, копійка в останній рядок, межа допуску
  (копійка на рядок), режим і ставка з наряду, а не з налаштувань, `WorkOrderTotalsMismatchError`,
  порядок і `sortOrder`; один кейс property-based (fast-check) на тоталах, порахованих як у наряді.
- `invoices.create-from-work-order.spec.ts` — BR-INV-002: рядки й суми пишуться клієнтом тієї
  самої транзакції, що створила рахунок; `amount = totalWithVat = wo.totalAmount`; розбіжність
  тоталів → 400 зсередини транзакції; base-сума і курс.
- `invoices.refresh-from-work-order.spec.ts` — BR-INV-002: «Оновити з наряду» тим самим кодом,
  оновлення `totalAmountBase` / `rateUsed`; розбіжність → 400 після `deleteMany` у транзакції.
- `invoices.line-totals.spec.ts` — BR-INV-017: `addLine` / `updateLine` у трьох режимах організації.

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

Web-половина правила про підсумки (прев'ю «Разом» у `InvoiceCreateModal`: сума `priceWithVat`
рядків з API, для незбереженого рядка — `quantity × unitPrice`) тесту не має: розрахунок живе в
`useMemo` компонента, потрібен компонентний тест. Бекенд-половину стереже
`invoices.line-totals.spec.ts`.

Web-половина правила про `invoiceType` (нормалізація значення поза enum-ом у `InvoiceCreateModal`
через `normalizeInvoiceType()`) тесту не має: функція не експортована, потрібен компонентний тест.

→ [docs/BUSINESS-RULES.md](../BUSINESS-RULES.md)
