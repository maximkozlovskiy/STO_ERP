# Payment — Dossier

> Платіж клієнта: реєстрація, привʼязка до Invoice/WorkOrder, проведення у settlement-ledger,
> фіскалізація (ПРРО), онлайн-оплата (QR-еквайринг) і касова зміна (cash-shift).

---

## Prisma модель

```prisma
// Append-only — ніколи не редагується (окрім delivery-метаданих fiscalStatus/fiscalError/… і
// одноразової позначки сторно reversedAt/reversalCashOperationId, BR-CASH-024)
model Payment {
  id              String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId           String   @db.Uuid
  counterpartyId  String   @db.Uuid
  workOrderId     String?  @db.Uuid
  invoiceId       String?  @db.Uuid
  amount          Decimal  @db.Decimal(12, 2)          // у валюті оплати (currencyId — з рахунку-призначення)
  currencyId      String?  @db.Uuid                    // мультивалюта Фаза 2 (валюта рахунку bank/cash)
  amountBase      Decimal? @db.Decimal(12, 2)          // у БАЗОВІЙ валюті org по курсу на дату (backfill=UAH)
  rateUsed        Decimal? @db.Decimal(18, 6)          // застосований курс (base за 1×coeff)
  method          String                              // код PaymentMethodConfig (cash, monobank_qr, …)
  notes           String?
  fiscalReceiptId String?                             // id чека у ПРРО (заповнюється при DONE)
  fiscalStatus    FiscalReceiptStatus?                // null | QUEUED | DONE | FAILED | SKIPPED
  fiscalError     String?
  sourceType      PaymentSourceType?                  // BANK_ACCOUNT | CASH_REGISTER
  bankAccountId   String?  @db.Uuid
  cashRegisterId  String?  @db.Uuid
  onlinePaymentIntentId String? @unique @db.Uuid      // лінк на OnlinePaymentIntent (idempotency)
  reversedAt      DateTime?                           // оплату сторновано з каси (BR-CASH-024); пишеться ОДИН раз (CAS)
  reversalCashOperationId String? @db.Uuid            // рядок каси-сторно
  syncVersion     BigInt   @default(0)
  createdAt       DateTime @default(now())
  // немає deletedAt, updatedAt — append-only грошова операція
}
```

**Відносини:** → `Counterparty`, → `WorkOrder?`, → `Invoice?`, → `BankAccount?`, → `CashRegister?`, → `Currency?`.

> **Мультивалюта (Фаза 2, 2026-09-14):** `PaymentsService.create` бере валюту з рахунку-призначення
> (bank/cash `currencyId`), конвертує суму у base (`ExchangeRatesService.resolveBaseConversion`, курс
> на дату; немає курсу → 400) і пише `currencyId`/`amountBase`/`rateUsed`. У `settlements.createTransaction`
> передається `currencyId` → борг лягає у base. **Loyalty** нараховує від `amountBase` (не `amount`).
> **Інваріант «фіскальна каса = UAH»:** оплата у фіскальну касу/метод у не-базовій валюті → 400 (ПРРО
> фіскалізує лише у base). Оплата без рахунку-призначення → base (rate=1). Курсові різниці — поза Фазою 2.

**Індекси:** `(orgId, workOrderId)`, `(orgId, counterpartyId, createdAt)`, `(orgId, createdAt)`,
`(orgId, invoiceId)` (covering для `getLinkedCounts`), `(orgId, fiscalStatus, createdAt)`
(фільтр за fiscalStatus — пошук FAILED-чеків), `(orgId, syncVersion)`.

### Супутні моделі

```prisma
model PaymentMethodConfig {   // довідник способів оплати (per-org)
  code, name, isActive, isSystem, sortOrder
  requiresFiscal Boolean      // TRUE → платіж цим методом фіскалізується
  defaultSourceType PaymentSourceType?    // мапінг method → куди лягають гроші (підказка)
  defaultBankAccountId / defaultCashRegisterId  // @@unique([orgId, code])
}

model OnlinePaymentIntent {   // намір QR-оплати (soft-delete є)
  gateway (default 'monobank'), gatewayInvoiceId, pageUrl, amount, counterpartyId,
  invoiceId?, workOrderId?, status OnlinePaymentStatus @default(PENDING),
  paymentId? (лінк створеного Payment), error?, expiresAt?
}

model BranchProviderConfig {  // конфіг провайдера per-branch per-kind (ПРРО/еквайринг/доставка)
  kind ProviderKind, provider, enabled, apiUrl?,
  credentials?  // JSON-рядок секретів, шифрується at-rest (ENCRYPTED_FIELDS)
  shiftMode ShiftMode @default(MANUAL)  // лише FISCAL
  @@unique([branchId, kind, provider])  // рівно 1 enabled per kind (ексклюзивна активація)
}

model CashShift {             // касова зміна ПРРО
  branchId, cashRegisterId, provider (default 'checkbox'), checkboxShiftId?,
  status CashShiftStatus @default(OPEN), openedById?, openedAt, closedAt?, zReportId?,
  checkboxAccessToken? (шифрується), tokenExpiresAt?
  // partial-unique cash_shifts_one_open_per_register_uq WHERE status='OPEN' AND deletedAt IS NULL
}
```

> Модель `Invoice` (`paidAmount`, часткова оплата) — див. [invoice.md](invoice.md).
> Settlement-ledger (`SettlementTransaction`, `BALANCE_SIGN`) — див. [settlements.md](settlements.md).

---

## Enums

- **`FiscalReceiptStatus`:** `QUEUED` (у черзі) · `DONE` (чек пробито) · `FAILED` (вичерпано ретраї) · `SKIPPED` (ПРРО вимкнено на філії). `null` = метод без `requiresFiscal`.
- **`OnlinePaymentStatus`:** `PENDING` · `PAID` · `FAILED` · `EXPIRED`.
- **`ProviderKind`:** `FISCAL` (ПРРО) · `PAYMENT` (еквайринг) · `DELIVERY` (Нова Пошта).
- **`ShiftMode`:** `MANUAL` (касир вручну) · `AUTO_OPEN` (авто-відкриття перед першим чеком).
- **`PaymentSourceType`:** `BANK_ACCOUNT` · `CASH_REGISTER`.

---

## FSM — fiscalStatus (ПРРО)

Не бізнес-FSM платежу (Payment append-only), а delivery-статус фіскального чека. Оновлюється
processor-ом черги `checkbox`.

```
create (requiresFiscal) → QUEUED ──(sellReceipt ok)──→ DONE   (fiscalReceiptId заповнено)
                             │  ├─(ПРРО не налаштовано)→ SKIPPED
                             │  └─(MANUAL без відкритої зміни)→ лишається QUEUED (throw → retry)
                             └─(вичерпано всі attempts / enqueue-fail)→ FAILED
FAILED ──(POST /:id/retry-fiscal, лише коли fiscalReceiptId=null)──→ QUEUED
create (метод без requiresFiscal) → null
```

| Перехід        | Тригер / умова                                                                                        |
| -------------- | ----------------------------------------------------------------------------------------------------- |
| → `QUEUED`     | `create` з `requiresFiscal` метода; або `retryFiscal` після FAILED                                    |
| → `DONE`       | `CheckboxProcessor` пробив чек → пише `fiscalReceiptId`                                               |
| → `SKIPPED`    | ПРРО не налаштовано на філії (конфіг-стан, не помилка)                                                |
| stays `QUEUED` | MANUAL-режим без відкритої зміни — чек чекає (throw → retry дренить)                                  |
| → `FAILED`     | вичерпано **всі** attempts (`attemptsMade >= opts.attempts`); або Redis-enqueue провалився при create |

Черга `checkbox`: `attempts: 288`, exponential backoff `300_000` мс (5 хв ≈ 24 год ретраїв —
офлайн-незалежність ПРРО). Один `CheckboxProcessor` (concurrency 3) обслуговує **обидва** ПРРО-
провайдери (Checkbox і Вчасно) — резолвить активний FISCAL-провайдер через registry попри назву черги.

---

## API Endpoints

Усі під guard `JwtAuthGuard + RolesGuard`. Префікс `/api`.

### `/api/payments` (`PaymentsController`)

| Метод | URL                              | Дія                                                                                   | Ролі                                   |
| ----- | -------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------- |
| GET   | `/api/payments`                  | Список (page, limit, counterpartyId, dateFrom, dateTo, method, fiscalStatus, q)       | OWNER, ADMIN, ACCOUNTANT, RECEPTIONIST |
| GET   | `/api/payments/:id`              | Деталь                                                                                | OWNER, ADMIN, ACCOUNTANT, RECEPTIONIST |
| POST  | `/api/payments`                  | Реєстрація платежу (`CreatePaymentDto`, `Idempotency-Key` обов'язковий — 400)         | OWNER, ADMIN, ACCOUNTANT, RECEPTIONIST |
| POST  | `/api/payments/:id/retry-fiscal` | Повторна фіскалізація (лише `FAILED` + `fiscalReceiptId=null`); throttle 10/60с       | OWNER, ADMIN, ACCOUNTANT               |
| POST  | `/api/payments/:id/reverse`      | Сторно безготівкової оплати `{ reason }` (BR-PAY-024, `Idempotency-Key` обов'язковий) | OWNER, ADMIN, ACCOUNTANT               |

`CreatePaymentDto`: `counterpartyId`, `amount` (Min 0.01), `method` (required); `workOrderId?`,
`invoiceId?`, `notes?`, `sourceType?`, `bankAccountId?`, `cashRegisterId?`.

### `/api/online-payments` (`OnlinePaymentController`)

| Метод | URL                        | Дія                                                           | Ролі                                   |
| ----- | -------------------------- | ------------------------------------------------------------- | -------------------------------------- |
| POST  | `/api/online-payments`     | Створити QR-намір (`{ invoiceId, amount? }`); throttle 20/60с | OWNER, ADMIN, ACCOUNTANT, RECEPTIONIST |
| GET   | `/api/online-payments/:id` | Статус наміру (frontend-polling нашого статусу)               | OWNER, ADMIN, ACCOUNTANT, RECEPTIONIST |

### `/api/cash-shifts` (`CashShiftController`)

| Метод | URL                          | Дія                                                           | Ролі                                   |
| ----- | ---------------------------- | ------------------------------------------------------------- | -------------------------------------- |
| GET   | `/api/cash-shifts/current`   | Поточна OPEN-зміна філії (`?branchId`) або null               | OWNER, ADMIN, ACCOUNTANT, RECEPTIONIST |
| POST  | `/api/cash-shifts/open`      | Відкрити зміну (`?branchId`; PIN→token→ПРРО); throttle 10/60с | OWNER, ADMIN, ACCOUNTANT, RECEPTIONIST |
| POST  | `/api/cash-shifts/:id/close` | Закрити зміну (Z-звіт); throttle 10/60с                       | OWNER, ADMIN, ACCOUNTANT, RECEPTIONIST |

### `/api/payment-gateways` (`PaymentGatewaysController`, `kind=PAYMENT`) · `/api/fiscal-providers` (`FiscalProvidersController`, `kind=FISCAL`)

Дзеркальні набори (ролі **OWNER, ADMIN**):

| Метод | URL (…= `payment-gateways` / `fiscal-providers`) | Дія                                                                |
| ----- | ------------------------------------------------ | ------------------------------------------------------------------ |
| GET   | `/api/…`                                         | Метадані провайдерів (`code`, `name`)                              |
| POST  | `/api/…/:code/verify`                            | Перевірка креденшелів (без реального чека/інвойсу); throttle 5/60с |
| GET   | `/api/…/branch/:branchId`                        | Конфіги філії (без сирих секретів, лише `hasCredentials`)          |
| PATCH | `/api/…/branch/:branchId`                        | Створити/оновити конфіг (creds write-only, пусте не перетирає)     |
| POST  | `/api/…/branch/:branchId/activate`               | Ексклюзивна активація (решта того ж kind → `enabled:false`)        |

---

## UI (Web)

| Компонент / сторінка           | Файл                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Платежі (сторінки немає)       | `/payments` → редирект у `/cash`; `/payments/<id>` без редиректу                                                                                                                                                                                                                                                                                                                                                                  |
| Чек і «Повторити» (FAILED)     | історія каси `cash/CashOperationsTab.tsx`; рядок оплати в «Пов'язаних документах» рахунку (`LinkedDocumentsPanel`, `fiscalStatus` з `GET /invoices/:id/linked-documents`)                                                                                                                                                                                                                                                         |
| Оплата клієнта готівкою        | форма каси `cash/CashOperationModal.tsx` (привід `SALE_PAYMENT` → `POST /payments`)                                                                                                                                                                                                                                                                                                                                               |
| Оплата з рахунку               | «Оплатити» у боковій панелі `invoices/page.tsx` → `POST /payments`; поле «Каса» для готівки (BR-PAY-019)                                                                                                                                                                                                                                                                                                                          |
| Оплата з наряду                | «Оплатити» у картці (`CreateWorkOrderModal.tsx`) і на сторінці наряду (`work-orders/[id]/PageClient.tsx`) → `POST /payments { workOrderId }` (BR-PAY-020)                                                                                                                                                                                                                                                                         |
| Вікно «Оплатити» (спільне)     | `components/ui/ClientPaymentModal.tsx`: спосіб, каса для готівки, каси за валютою, сума = залишок (від 0,01 до залишку, інакше помилка у вікні без запиту), ключ ідемпотентності на відкриття, QR лише для рахунку (для наряду — жодного `*_qr`, Bug #870)                                                                                                                                                                        |
| Сторно безготівкової оплати    | `components/ui/PaymentReversalModal.tsx` (два кроки, причина, ключ ідемпотентності на відкриття) і `useReversePayment` (`hooks/api/useBankStatements.ts`); дія «Сторнувати» в «Оплатах» «Пов'язаних документів» наряду й рахунку (`lib/linked-configs.tsx`, `dialogAction` у `LinkedDocumentsPanel`; касова — підказка «Сторнується в касі»), «Сторнувати оплату» на рядку `bank-statements/BankTransactionsTab.tsx` (BR-PAY-024) |
| Каса (cash-shift open/close)   | `app/(app)/cash/page.tsx`, `hooks/api/useCashShift.ts`                                                                                                                                                                                                                                                                                                                                                                            |
| QR-оплата (online-payment)     | `components/ui/QrPaymentModal.tsx`, `hooks/api/useOnlinePayment.ts`                                                                                                                                                                                                                                                                                                                                                               |
| ПРРО-провайдери (налаштування) | `app/(app)/settings/FiscalTab.tsx`, `ProviderRegistryPanel.tsx`                                                                                                                                                                                                                                                                                                                                                                   |
| Довідник способів оплати       | `/api/payment-methods` (окремий модуль `payment-methods`); НДІ → «Оплата» `ndi/PaymentsTab.tsx` — «Куди надходять кошти»                                                                                                                                                                                                                                                                                                          |

---

## Бізнес-правила (BR-PAY)

### `create()` — реєстрація платежу

- **BR-PAY-001**: Валідація: `counterparty` існує (org-scoped); якщо `workOrderId` — WO існує (org-scoped, не видалений; інакше 404 до транзакції) і його статус — у `WO_PAYABLE_STATUSES` (усі, крім «Скасовано», «Оплачено», «Архів»; рішення власника 2026-10-15), інакше 400 з назвою статусу. Наряд виводиться і з рахунку (BR-PAY-021). Якщо `invoiceId` — рахунок існує (org-scoped, не видалений; інакше 404 до транзакції, а видалений між перевіркою і транзакцією — 404 і відкат), а не оплата з посиланням на рахунок, якого немає (review 2026-10-15).
- **BR-PAY-002**: **Рахунок-призначення** (`resolveDestinationAccount`): DTO явно → сувора валідація (4xx на невалідний);
  дефолт з `PaymentMethodConfig` → best-effort (stale конфіг → тихо `null`, не валимо платіж; для готівки
  це 400 — BR-PAY-019). Запит із `cashRegisterId` (або `bankAccountId`) без `sourceType` — тип береться з
  id, а не зі способу оплати: інакше каса з запиту мовчки губилась (готівка → 400, інший спосіб — повз касу). Деталі — [invoice.md](invoice.md#рахунок-призначення-платежу-paymentsourcetype) («Рахунок-призначення платежу»).
  Замовчування задають у НДІ → «Оплата» → «Куди надходять кошти» (`POST/PATCH /payment-methods`:
  `defaultSourceType` + `defaultCashRegisterId` | `defaultBankAccountId`; каса лише з `CASH_REGISTER`, рахунок
  лише з `BANK_ACCOUNT`, інакше 400; тип без id → 400; чужа чи видалена каса/рахунок → 404; `null` знімає
  призначення, id іншого типу при зміні обнуляється; ролі OWNER, ADMIN). Відповідь `GET /payment-methods` несе
  ці поля, `defaultDestinationName` — назву живої каси чи рахунку — і `defaultDestinationCurrencyCode` — її
  валюту (два запити на весь список; кеш списку назв і валют не тримає).
- **BR-PAY-003**: **Часткова оплата Invoice** (у `$transaction`): дозволені статуси `SENT`/`PARTIALLY_PAID`/`OVERDUE`;
  overpay (`amount > remaining`) → 400; CAS по `paidAmount` → `PAID`/`PARTIALLY_PAID`; `count=0`
  (гонка) → rollback. Повна механіка — [invoice.md](invoice.md#часткова-оплата-модель-грошей-фаза-1) («Часткова оплата»).
- **BR-PAY-004**: **Settlement:** у тій самій `$transaction` → `SettlementsService.createTransaction(PAYMENT)`
  (борг клієнта ↓). Ніколи не змінює баланс напряму. Знак/семантика — [settlements.md](settlements.md).
- **BR-PAY-005**: Якщо є наряд: `workOrder.paidAmount += amount` у транзакції платежу (рядок наряду блокується ПЕРШИМ — раніше за рахунок); у тій самій транзакції при повній оплаті (BR-PAY-017) наряд у «Виставлено» стає «Оплачено», у «Виконано» — «Виставлено» → «Оплачено» без створення рахунку (BR-WO-016); події переходів — після коміту.

### Сторно оплати (BR-CASH-024, BR-PAY-024)

Сторно запускають два входи — обидва викликають той самий внутрішній
`PaymentsService.reverse(orgId, paymentId, ctx, tx)`: каса для оплат із касовим рядком (нижче) і
`POST /payments/:id/reverse` для безготівкових і старих оплат без призначення (BR-PAY-024). Каса
(`POST /cash-registers/:id/operations/:operationId/reverse` → `CashDeskService.reverse`) у тій самій
транзакції викликає внутрішній `PaymentsService.reverse(orgId, paymentId, ctx, tx)` (`ctx` — id рядка сторно,
причина, користувач). Що він робить, у порядку записів: CAS `reversedAt: null → now()` (друге сторно →
400; чек у черзі / `FAILED` одразу `SKIPPED`) → проводка `PAYMENT_CANCEL` / `PREPAYMENT_CANCEL` (за типом
проводки оригіналу, курс оригіналу, документ — рядок сторно каси) → «сплачено» рахунку і наряду мінус
сума (не нижче нуля) — спершу наряд, потім рахунок (той самий порядок блокувань, що в оплаті), статус
наряду PAID → INVOICED (`reopenPaidWorkOrderInTx`); рахунок наряду перераховується з наряду (дзеркало,
BR-INV-018), рахунок без наряду — PAID/PARTIALLY_PAID → PARTIALLY_PAID/SENT → списання нарахованих бонусів (`LoyaltyService.reverseEarn`, `EARN_REVERSAL`).
Відмови (400): чек уже пробито (`DONE` / є `fiscalReceiptId`), оплата не в базовій валюті, наряд в архіві,
рахунок скасовано (лише для оплати рахунку без наряду: рахунок наряду — дзеркало, його скасування сторно
оплати наряду не блокує).

Сторнована оплата **виключена** (`reversedAt: null` у відборі): із сум «сплачено», нічної звірки
(`reconciliation.processor`), курсових різниць, нарахування бонусів (джоб `earn` пропускає її) і
фіскальної черги (`checkbox.processor` пропускає). У відповідях `GET /payments` і пов'язаних документів
вона віддається з `reversedAt` / `reversalCashOperationId`; у конструкторі звітів — поле «Сторновано».

Тести касового сторно оплати — у реєстрі `cash.md` (`payments.reverse.spec.ts`,
`payments.reversal-excluded.spec.ts`); безготівкового (BR-PAY-024) — у реєстрі нижче
(`payments.reverse-noncash.spec.ts`, `payments.reverse-route.contract.spec.ts`).

### Side-effects після `create` (усі поза транзакцією, best-effort)

Перехід наряду в «Оплачено» серед них більше немає: він у транзакції оплати (BR-PAY-005); після
коміту — лише події TRANSITIONED для зроблених кроків (`WorkOrdersService.emitStatusSteps`).

| Ефект        | Умова / деталь                                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Фіскалізація | якщо `method.requiresFiscal` → job `fiscal-receipt` у черзі `checkbox`; enqueue-fail → `fiscalStatus=FAILED`             |
| Лояльність   | `LoyaltyService.queueEarn(orgId, counterpartyId, amount, payment.id)` → нарахування балів; див. [loyalty.md](loyalty.md) |
| Сповіщення   | `PAYMENT_RECEIVED` (якщо є phone/email)                                                                                  |
| Audit        | `audit.record('Payment', …, 'CREATE')`                                                                                   |

### Онлайн-оплата (QR-еквайринг)

- **BR-PAY-006**: `createIntent()`: резолвить активний `PAYMENT`-провайдер (`resolveActive(orgId, branchId, 'PAYMENT')`);
  немає → 400. Створює `OnlinePaymentIntent` (`PENDING`, `expiresAt = now+15хв`) **першим** — його `id`
  = стабільний `reference`. Викликає `gateway.createInvoice()` → `gatewayInvoiceId`, `pageUrl` (QR).
- **BR-PAY-007**: Enqueue у чергу `payment-polling` (перша задача — `jobId=payment-poll-<intentId>`). `PaymentPollingProcessor`
  (concurrency 3, self-re-enqueue) опитує gateway: `paid` → **CAS** `PENDING→PAID` → `finalizePayment`.
  **Кожен наступний крок — під новим `jobId`** (`payment-poll-<intentId>-p<крок>`, повтор finalize —
  `-f<спроба>`): BullMQ мовчки відкидає `add` з id задачі, яка ще існує, а активна задача існує до
  кінця `process` — зі спільним id ланцюг обривався після першого опитування (Bug #804).
  Збій самого опитування (шлюз недоступний, 5xx, таймаут) намір не кидає: ставиться наступне
  опитування з лічильником +1. **Намір закриває лише відповідь шлюзу або стеля опитувань, а не
  годинник:** після `expiresAt` шлюз питають ще раз — `paid` → Payment створюється, `pending` →
  `EXPIRED` «Час на оплату вичерпано»; шлюз недоступний → намір лишається `PENDING`, опитування
  раз на 60 с (клієнт міг заплатити, поки наш інтернет лежав). Стеля `MAX_POLL_ATTEMPTS=1440`
  (≈ доба після `expiresAt`) закриває намір як `EXPIRED`; якщо останнє опитування впало — з
  причиною «Статус оплати у шлюзі не підтверджено… перевірте оплату вручну». Finalize —
  `MAX_FINALIZE_ATTEMPTS=360`.
- **BR-PAY-008**: **`finalizePayment` idempotency:** спершу шукає Payment по `onlinePaymentIntentId`; якщо є — лише
  релінкує. Інакше `payments.create({ method: '<gateway>_qr', onlinePaymentIntentId })`. `P2002` на
  `@unique onlinePaymentIntentId` → знаходить наявний і лінкує (без подвійного списання, Bug #688).
- **BR-PAY-009**: Frontend polls **наш** `/online-payments/:id`, не gateway напряму.

### Касова зміна (cash-shift)

- **BR-PAY-010**: `open()`: резолвить активний FISCAL-провайдер; бере активну касу філії; **one-open-per-register**
  guard (pre-check + partial-unique `cash_shifts_one_open_per_register_uq` як race-backstop → повертає
  переможця). `provider.signIn` (PIN→token) + `provider.openShift` → `checkboxShiftId`. Токен шифрується.
- **BR-PAY-011**: `close()`: **CAS-claim** `OPEN→CLOSED` **до** зовнішнього виклику (Bug #711 — проти подвійного Z-звіту);
  `count=0` → «Зміна вже закрита». Потім `provider.closeShift` → `zReportId`; при провалі — revert CLOSED→OPEN.
- **BR-PAY-012**: `getCurrent`: рахує `pendingReceipts` = платежі з `fiscalStatus=QUEUED` у межах філії (через `workOrder.branchId`).

### Провайдери (`BranchProviderConfig`)

- **BR-PAY-013**: **Ексклюзивна активація** (`activate`): у `$transaction` — усі інші того ж `kind` → `enabled:false`,
  target → `enabled:true`. Рівно 1 enabled per kind per branch. Target мусить мати збережені креденшели.
- **BR-PAY-014**: **Legacy fallback**: якщо немає enabled-конфігу — читає `BranchSettings` (checkbox: `checkboxLicenseKey/
PinCode/CashRegisterId`; monobank: `monobankToken/ApiUrl`). Лише FISCAL(checkbox) і PAYMENT(monobank).
- **BR-PAY-015**: `credentials` — JSON-рядок, шифрується at-rest (`prisma.service ENCRYPTED_FIELDS`); write-only у API
  (GET-и повертають лише `hasCredentials`). `BranchProviderConfig` виключено з PULL_TABLES (містить секрети).
- **BR-PAY-016**: Рахунок закриває лише його платник: платіж із `invoiceId` приймається, тільки якщо
  контрагент платежу — контрагент цього рахунку, інакше 400 «Рахунок виписано на іншого
  контрагента…», рахунок і баланс не чіпаються. Перевірка стоїть у `PaymentsService.create`, тож діє
  для ручного платежу, рознесення банківської виписки й онлайн-оплати. Те саме для прямої оплати
  наряду (`workOrderId` без `invoiceId`): контрагент платежу мусить бути замовником наряду, інакше
  400 «Наряд оформлено на іншого контрагента…» ДО транзакції. Якщо вказано і рахунок, і наряд —
  платника визначає рахунок (його можна виписати на іншого платника, напр. страхову).
- **BR-PAY-017**: Наряд переходить у `PAID` лише коли оплачено всю суму до сплати
  (`paidAmount ≥ totalAmount`). Часткова оплата з `workOrderId` збільшує `paidAmount` і лишає наряд
  `INVOICED` — решту можна доплатити наступним платежем через наряд. Пряма оплата наряду (без
  `invoiceId`) не може перевищити залишок `totalAmount − paidAmount` → 400. `paidAmount` наряду
  пишеться в транзакції платежу умовно (CAS за прочитаним значенням): паралельний платіж → 400
  «повторіть», а не втрачене оновлення. Залишок обмежує будь-яку оплату наряду, зокрема аванс і оплату
  через рахунок наряду; наряд із сумою 0 оплати не приймає (400)
- **BR-PAY-018**: Відбір списку оплат за датою (`dateFrom` / `dateTo`) — це КИЇВСЬКА доба за
  міткою часу `createdAt` (мить, не дата без часу): межі включні, `dateFrom` = 00:00:00.000 за
  Києвом, `dateTo` = 23:59:59.999 за Києвом, з урахуванням переведення годинника. Оплата,
  створена 10.10 о 00:30 за Києвом (09.10 21:30 UTC), входить у відбір «10.10» і не входить у
  «09.10». Так само рахують добу каса й рухи складу. Списки документів із датою БЕЗ часу
  (`documentDate` наряду, рахунку, замовлення, повернення й оплати постачальнику) порівнюють
  календарні дати без зсуву на пояс
- **BR-PAY-019**: Оплата способом «Готівка» (`method = 'cash'`) мусить мати касу — з запиту
  (`sourceType: 'CASH_REGISTER'` + `cashRegisterId`) або касу за замовчуванням способу оплати. Перевірка
  стоїть у `PaymentsService.create` ПІСЛЯ розв'язання рахунку-призначення (BR-PAY-002): якщо після нього
  призначення не каса — каси не вказано, касу за замовчуванням видалено (застаріле замовчування мовчки
  знімається) або призначення — банківський рахунок — 400 «Для оплати готівкою вкажіть касу», до транзакції,
  без оплати й без руху балансу. Явна каса з запиту перемагає замовчування. Інші способи — BR-PAY-023
  (безготівкова оплата мусить мати банківський рахунок чи касу способу). Викликачі: каса (`CashDeskService`) передає касу явно; рознесення
  банківської виписки — спосіб `bank`; онлайн-оплата — `<шлюз>_qr`. Вікно «Оплатити» рахунку має поле «Каса»
  (див. [cash.md](cash.md#ui-web)). Так само способу «Готівка» не можна задати банківський рахунок за
  замовчуванням: `POST`/`PATCH /payment-methods` з `BANK_ACCOUNT` для `code = 'cash'` → 400 «Для готівки кошти
  надходять лише в касу», нічого не пишеться; НДІ цього варіанта для «Готівки» не показує (рішення власника
  2026-10-14; `PaymentMethodsService.resolveDestination`). Рахунок, збережений до правила, НДІ показує
  недоступною опцією з поясненням — змінити його можна на касу чи «не вказано»; запит без полів призначення
  (активність, фіскалізація) його не чіпає й проходить. Код `'cash'` — `CASH_METHOD_CODE` з `@sto/shared`.
- **BR-PAY-020**: **Аванс і оплата наряду — за статусом** (рішення власника 2026-10-15). Тип проводки
  оплати наряду визначає статус, прочитаний у транзакції (`woPaymentKind` з `@sto/shared`): «Чернетка»…
  «Призупинено» (`WO_PREPAYMENT_STATUSES`) — `PREPAYMENT` (борг ще не нараховано — це аванс),
  «Виконано» і «Виставлено» — `PAYMENT`. В обох випадках `Payment.workOrderId` заповнено і
  `paidAmount` наряду росте; аванс і пізніший борг (`CHARGE` при «Виконано») гасять одне одного на
  балансі без окремої проводки заліку. Повернення (`settlementType = REFUND`) з нарядом → 400.
- **BR-PAY-021**: **Оплата рахунку наряду — це оплата наряду.** Наряд платежу = `workOrderId` із
  запиту, інакше — наряд рахунку (сторінка рахунків, рознесення банківської виписки, онлайн-оплата
  дають лише `invoiceId`). Рахунок, що не належить наряду із запиту, або рахунок без наряду разом із
  `workOrderId` → 400 «Рахунок не належить до вказаного наряду». Оплата з наряду отримує `invoiceId`
  активного (не скасованого, не видаленого) рахунку наряду, якщо платник — контрагент рахунку.
  Статус такого рахунку оплату не обмежує (обмежує статус наряду), а його `paidAmount` і статус
  перераховуються з наряду (BR-INV-018). Шлях рахунку без наряду не змінюється (BR-PAY-003).
- **BR-PAY-022**: **Курсова різниця — за нарядом.** Для наряду в іноземній валюті курсова різниця
  проводиться, коли наряд сплачено повністю і борг уже нараховано («Виконано» / «Виставлено»; якщо
  все сплачено авансом — при переході в «Виконано»): нараховано — проводка `CHARGE` наряду,
  сплачено — Σ `amountBase` оплат наряду без сторно; документ — `WorkOrder`; повторно не проводиться
  (враховуються й попередні курсові проводки рахунків цього наряду).
- **BR-PAY-023**: **Безготівкова оплата — лише з призначенням** (рішення власника 2026-10-22). Оплата
  будь-яким способом, крім «Готівки», мусить мати призначення після розв'язання (BR-PAY-002): банківський
  рахунок із запиту чи за замовчуванням способу, або касу, коли вона — призначення способу за замовчуванням
  (картка через термінал із ПРРО). Без призначення — зокрема коли рахунок за замовчуванням видалено — 400
  «Безготівкова оплата: оберіть банківський рахунок…» до транзакції, без оплати й руху балансу (раніше такі
  оплати гасили борг, а на жодному рахунку грошей не було). Онлайн-оплата від шлюзу (`onlinePaymentIntentId`)
  під правило не підпадає. Наявні оплати без призначення не змінюються. Вікно «Оплатити» для безготівкового
  способу без каси показує обов'язкове поле «Рахунок» (рахунки у валюті документа), заповнене рахунком
  способу, доки касир не обрав інший; без рахунку кнопка оплати неактивна. Роль без `GET /bank-accounts`
  (RECEPTIONIST) переліку рахунків не запитує: поле пропонує рахунок способу (назва й валюта — з
  `GET /payment-methods`), а без нього пояснює, що способу не задано рахунку у валюті документа.
  Рознесення виписки й каса передають призначення самі. `PaymentsService.create`, `ClientPaymentModal`
- **BR-PAY-024**: **Сторно безготівкової оплати** (рішення власника 2026-10-22). `POST /payments/:id/reverse
{ reason }` сторнує оплату клієнта без касового рядка: на банківський рахунок (з вікна «Оплатити» чи з
  рознесення виписки) і стару оплату без призначення. Ролі — OWNER, ADMIN, ACCOUNTANT (як сторно в касі);
  причина обов'язкова, до 500 символів (`paymentReversalSchema` = `cashReversalSchema`); `Idempotency-Key` обов'язковий (без нього — 400, `RequiredIdempotencyInterceptor`).
  Відмови — 400 до першого запису: оплата в касі (`sourceType = CASH_REGISTER`, `cashRegisterId` або рядок
  каси `documentType = 'Payment'` у старої оплати без призначення — «сторнуйте касову операцію»,
  `err.payment.reversalCashRow`; одна функція `paymentsInCashDesk` дає й ознаку `inCashDesk` рядка оплати
  в «Пов'язаних документах», де замість кнопки тоді підказка «Сторнується в касі»); онлайн-оплата QR (`onlinePaymentIntentId`,
  `err.payment.reversalOnlineQr`); уже сторнована (`err.payment.alreadyReversed`); решта — як у BR-CASH-024
  (пробитий чек, іновалютна оплата, наряд в архіві, скасований рахунок без наряду). Наслідки — ті самі, що в
  касовому сторно (той самий `reverse`): проводка `PAYMENT_CANCEL` / `PREPAYMENT_CANCEL` з курсом оригіналу,
  «сплачено» й статуси наряду та рахунку, чек у черзі, бонуси; документ проводки сторно — сама оплата
  (`documentType = 'Payment'`), не касовий рядок. Оплата з рознесення виписки: у тій самій транзакції рядок
  виписки CAS MATCHED → UNMATCHED, `paymentId = null`, `unmatchReason/At/By` — рядок можна рознести заново
  (BR-BANK-040). Причину й автора сторно оплата зберігає (`reversalReason`, `reversedBy`) — для будь-якого
  сторно, касового теж. Дія «Сторнувати» — у «Пов'язаних документах» рахунку й наряду (рядок оплати) і на
  рознесеному вхідному рядку «Банківських платежів». `PaymentsService.reverseNonCash`, `PaymentReversalModal`

### Конкретні провайдери

| Kind    | code       | Обгортка / API                                                                                          |
| ------- | ---------- | ------------------------------------------------------------------------------------------------------- |
| FISCAL  | `checkbox` | `CheckboxClient` → Checkbox ПРРО REST (`api.checkbox.ua`): signinPinCode, shifts, receipts/sell         |
| FISCAL  | `vchasno`  | Вчасно.Каса — єдиний dispatcher `POST /api/v3/fiscal/execute` (task-коди 0/1/11/18), token без `Bearer` |
| PAYMENT | `monobank` | `MonobankClient` → monobank Acquiring (`api.monobank.ua`, `X-Token`): invoice/create, invoice/status    |
| PAYMENT | `liqpay`   | LiqPay v3: `data=base64(JSON)`, `signature=base64(SHA1(priv+data+priv))`, checkout-URL як QR            |

> Sandbox-креденшели та деталі інтеграцій — `docs/INTEGRATIONS.md`.

---

## Пов'язані об'єкти

- [invoice.md](invoice.md) — часткова оплата, `paidAmount` · [settlements.md](settlements.md) — ledger, `BALANCE_SIGN`
- [loyalty.md](loyalty.md) — earn при кожному платежі · [work-order.md](work-order.md) — FSM `INVOICED → PAID`

---

## Аспекти і тести, що їх стережуть

Правите один аспект — ганяєте один файл:

```bash
cd apps/api && npx vitest run src/modules/payments/<файл>.spec.ts
```

**Модуль:** `apps/api/src/modules/payments/`

**Маршрути UI:** `/cash`, `/invoices` (`/payments` — лише редирект)

| Аспект                                          | Тест                                                     | Кейсів |
| ----------------------------------------------- | -------------------------------------------------------- | ------ |
| сервісна логіка                                 | `cash-shift.service.spec.ts`                             | 31     |
| HTTP-клієнт                                     | `checkbox.client.spec.ts`                                | 31     |
| BullMQ-processor                                | `checkbox.processor.spec.ts`                             | 19     |
| fiscal provider registry                        | `fiscal/fiscal-provider-registry.spec.ts`                | 16     |
| провайдер                                       | `fiscal/vchasno.provider.spec.ts`                        | 29     |
| payment gateway registry                        | `gateways/payment-gateway-registry.spec.ts`              | 12     |
| HTTP-клієнт                                     | `monobank.client.spec.ts`                                | 26     |
| сервісна логіка                                 | `online-payment.service.spec.ts`                         | 15     |
| BullMQ-processor                                | `payment-polling.processor.spec.ts`                      | 26     |
| ланцюг опитування (Redis)                       | `payment-polling.queue.integration.spec.ts`              | 1      |
| fiscal gate                                     | `payments.fiscal-gate.spec.ts`                           | 8      |
| idempotency                                     | `payments.idempotency.spec.ts`                           | 7      |
| money model                                     | `payments.money-model.spec.ts`                           | 22     |
| multicurrency                                   | `payments.multicurrency.spec.ts`                         | 23     |
| query dto                                       | `payments.query-dto.spec.ts`                             | 43     |
| передумови + наряд                              | `payments.work-order.spec.ts`                            | 52     |
| політика повторів черг                          | `payments.queue-retry-policy.spec.ts`                    | 6      |
| сервісна логіка                                 | `provider-config.service.spec.ts`                        | 34     |
| upsert провайдера без `enabled` (лише activate) | `provider-upsert-dto.contract.spec.ts`                   | 8      |
| шифрування at-rest                              | `../../prisma/field-encryption.extension.spec.ts`        | 21     |
| шифрування (сервіс)                             | `../../common/crypto/encryption.service.spec.ts`         | 11     |
| готівка — через касу, безготівкова — з рахунком | `payments.cash-register-required.spec.ts`                | 14     |
| куди надходять кошти                            | `../payment-methods/payment-methods.destination.spec.ts` | 24     |
| HTTP-контракт способів                          | `../payment-methods/payment-methods.contract.spec.ts`    | 7      |
| системні способи оплати                         | `../payment-methods/payment-methods.service.spec.ts`     | 5      |
| сторно безготівкової оплати (BR-PAY-024)        | `payments.reverse-noncash.spec.ts`                       | 24     |
| HTTP-контракт сторно (BR-PAY-024)               | `payments.reverse-route.contract.spec.ts`                | 15     |

Разом: **490** кейсів — 422 у модулі + 32 у двох спеках шифрування + 36 у довіднику способів оплати
(`payment-methods`) поза ним; спеки сторно оплати (`payments.reverse*`) — у реєстрі cash.md. Цифри з
`vitest --reporter=json` (2026-10-15), не з grep.

**Чого тут НЕМА.** Інваріантного спеку (`*.invariants.spec.ts`) немає, хоча агрегат на шляху грошей або статусів: властивості на кшталт «фінальний статус без виходів» не стережуться нічим. Свідома прогалина — кандидат на окремий крок.

HTTP-контракт є лише в маршруту сторно `POST /payments/:id/reverse` (`payments.reverse-route.contract.spec.ts`);
решту маршрутів `/payments` (DTO, статуси, валідацію) покриває лише E2E. У довідника способів оплати контракт є — `../payment-methods/payment-methods.contract.spec.ts`.

Виключення `branch_provider_configs` з `PULL_TABLES` (друга половина правила про креденшели
провайдерів) unit-тестом не стережеться: список живе в `sync/`, там тестів на цю модель немає.

Шифрування at-rest стережеться лише для операцій, які розширення знає: `create`, `createMany`,
`update`, `updateMany`, `upsert` верхнього рівня. Перевірено пробою 2026-10-08 — повз шифрування
йдуть `createManyAndReturn`, `updateManyAndReturn`, обгортка `{ set: … }`, вкладений запис через
батьківську модель (`garageBranch.update({ data: { branchSettings: { update } } })`) і сирий SQL.
Продукт-код цими шляхами секрети зараз не пише, але й тесту, що заборонив би, немає.
Integration-спек `field-encryption.integration.spec.ts` ганяє round-trip на живій БД, проте на
власній копії розширення — зміну продуктового `ENCRYPTED_FIELDS` він не помічає.

Статичний сторож `payments.queue-retry-policy.spec.ts` тримає білий список відомих порушень правила
«зовнішнє API → attempts ≥ 10, exponential backoff» (черги `nbu-fetch`, `bank-statement-polling`,
`payment-polling`, `nova-poshta-polling`): код не правився, запис у списку — не дозвіл, а межа між
старим і новим. Чому `payment-polling` має `concurrency: 3`, у коді не записано — тест фіксує число.

→ [docs/BUSINESS-RULES.md](../BUSINESS-RULES.md)
