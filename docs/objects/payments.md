# Payment — Dossier

> Платіж клієнта: реєстрація, привʼязка до Invoice/WorkOrder, проведення у settlement-ledger,
> фіскалізація (ПРРО), онлайн-оплата (QR-еквайринг) і касова зміна (cash-shift).

---

## Prisma модель

```prisma
// Append-only — ніколи не редагується (окрім delivery-метаданих fiscalStatus/fiscalError/…)
model Payment {
  id              String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId           String   @db.Uuid
  counterpartyId  String   @db.Uuid
  workOrderId     String?  @db.Uuid
  invoiceId       String?  @db.Uuid
  amount          Decimal  @db.Decimal(12, 2)
  method          String                              // код PaymentMethodConfig (cash, monobank_qr, …)
  notes           String?
  fiscalReceiptId String?                             // id чека у ПРРО (заповнюється при DONE)
  fiscalStatus    FiscalReceiptStatus?                // null | QUEUED | DONE | FAILED | SKIPPED
  fiscalError     String?
  sourceType      PaymentSourceType?                  // BANK_ACCOUNT | CASH_REGISTER
  bankAccountId   String?  @db.Uuid
  cashRegisterId  String?  @db.Uuid
  onlinePaymentIntentId String? @unique @db.Uuid      // лінк на OnlinePaymentIntent (idempotency)
  syncVersion     BigInt   @default(0)
  createdAt       DateTime @default(now())
  // немає deletedAt, updatedAt — append-only грошова операція
}
```

**Відносини:** → `Counterparty`, → `WorkOrder?`, → `Invoice?`, → `BankAccount?`, → `CashRegister?`.

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

| Метод | URL                              | Дія                                                                             | Ролі                                   |
| ----- | -------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------- |
| GET   | `/api/payments`                  | Список (page, limit, counterpartyId, dateFrom, dateTo, method, fiscalStatus)    | OWNER, ADMIN, ACCOUNTANT, RECEPTIONIST |
| GET   | `/api/payments/:id`              | Деталь                                                                          | OWNER, ADMIN, ACCOUNTANT, RECEPTIONIST |
| POST  | `/api/payments`                  | Реєстрація платежу (`CreatePaymentDto`, `IdempotencyInterceptor`)               | OWNER, ADMIN, ACCOUNTANT, RECEPTIONIST |
| POST  | `/api/payments/:id/retry-fiscal` | Повторна фіскалізація (лише `FAILED` + `fiscalReceiptId=null`); throttle 10/60с | OWNER, ADMIN, ACCOUNTANT               |

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

| Компонент / сторінка           | Файл                                                                |
| ------------------------------ | ------------------------------------------------------------------- |
| Список платежів + retry-fiscal | `app/(app)/payments/page.tsx`, `[id]/PageClient.tsx`                |
| Каса (cash-shift open/close)   | `app/(app)/cash/page.tsx`, `hooks/api/useCashShift.ts`              |
| QR-оплата (online-payment)     | `components/ui/QrPaymentModal.tsx`, `hooks/api/useOnlinePayment.ts` |
| ПРРО-провайдери (налаштування) | `app/(app)/settings/FiscalTab.tsx`, `ProviderRegistryPanel.tsx`     |
| Довідник способів оплати       | `/api/payment-methods` (окремий модуль `payment-methods`)           |

---

## Бізнес-правила

### `create()` — реєстрація платежу

- Валідація: `counterparty` існує (org-scoped); якщо `workOrderId` — WO має бути в статусі `INVOICED`.
- **Рахунок-призначення** (`resolveDestinationAccount`): DTO явно → сувора валідація (4xx на невалідний);
  дефолт з `PaymentMethodConfig` → best-effort (stale конфіг → тихо `null`, не валимо платіж). Деталі — [invoice.md](invoice.md#рахунок-призначення-платежу-paymentsourcetype) («Рахунок-призначення платежу»).
- **Часткова оплата Invoice** (у `$transaction`): дозволені статуси `SENT`/`PARTIALLY_PAID`/`OVERDUE`;
  overpay (`amount > remaining`) → 400; CAS по `paidAmount` → `PAID`/`PARTIALLY_PAID`; `count=0`
  (гонка) → rollback. Повна механіка — [invoice.md](invoice.md#часткова-оплата-модель-грошей-фаза-1) («Часткова оплата»).
- **Settlement:** у тій самій `$transaction` → `SettlementsService.createTransaction(PAYMENT)`
  (борг клієнта ↓). Ніколи не змінює баланс напряму. Знак/семантика — [settlements.md](settlements.md).
- Якщо `workOrderId`: `workOrder.paidAmount += amount`; після tx — best-effort FSM `INVOICED → PAID`.

### Side-effects після `create` (усі поза транзакцією, best-effort)

| Ефект         | Умова / деталь                                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Фіскалізація  | якщо `method.requiresFiscal` → job `fiscal-receipt` у черзі `checkbox`; enqueue-fail → `fiscalStatus=FAILED`             |
| Лояльність    | `LoyaltyService.queueEarn(orgId, counterpartyId, amount, payment.id)` → нарахування балів; див. [loyalty.md](loyalty.md) |
| WorkOrder FSM | `INVOICED → PAID` (best-effort, лише лог при провалі)                                                                    |
| Сповіщення    | `PAYMENT_RECEIVED` (якщо є phone/email)                                                                                  |
| Audit         | `audit.record('Payment', …, 'CREATE')`                                                                                   |

### Онлайн-оплата (QR-еквайринг)

- `createIntent()`: резолвить активний `PAYMENT`-провайдер (`resolveActive(orgId, branchId, 'PAYMENT')`);
  немає → 400. Створює `OnlinePaymentIntent` (`PENDING`, `expiresAt = now+15хв`) **першим** — його `id`
  = стабільний `reference`. Викликає `gateway.createInvoice()` → `gatewayInvoiceId`, `pageUrl` (QR).
- Enqueue у чергу `payment-polling` (`jobId=payment-poll-<intentId>`, single-flight). `PaymentPollingProcessor`
  (concurrency 3, self-re-enqueue) опитує gateway: `paid` → **CAS** `PENDING→PAID` → `finalizePayment`.
  Стелі: `MAX_POLL_ATTEMPTS=1440`, finalize `MAX_FINALIZE_ATTEMPTS=360`, `expiresAt` past → `EXPIRED`.
- **`finalizePayment` idempotency:** спершу шукає Payment по `onlinePaymentIntentId`; якщо є — лише
  релінкує. Інакше `payments.create({ method: '<gateway>_qr', onlinePaymentIntentId })`. `P2002` на
  `@unique onlinePaymentIntentId` → знаходить наявний і лінкує (без подвійного списання, Bug #688).
- Frontend polls **наш** `/online-payments/:id`, не gateway напряму.

### Касова зміна (cash-shift)

- `open()`: резолвить активний FISCAL-провайдер; бере активну касу філії; **one-open-per-register**
  guard (pre-check + partial-unique `cash_shifts_one_open_per_register_uq` як race-backstop → повертає
  переможця). `provider.signIn` (PIN→token) + `provider.openShift` → `checkboxShiftId`. Токен шифрується.
- `close()`: **CAS-claim** `OPEN→CLOSED` **до** зовнішнього виклику (Bug #711 — проти подвійного Z-звіту);
  `count=0` → «Зміна вже закрита». Потім `provider.closeShift` → `zReportId`; при провалі — revert CLOSED→OPEN.
- `getCurrent`: рахує `pendingReceipts` = платежі з `fiscalStatus=QUEUED` у межах філії (через `workOrder.branchId`).

### Провайдери (`BranchProviderConfig`)

- **Ексклюзивна активація** (`activate`): у `$transaction` — усі інші того ж `kind` → `enabled:false`,
  target → `enabled:true`. Рівно 1 enabled per kind per branch. Target мусить мати збережені креденшели.
- **Legacy fallback**: якщо немає enabled-конфігу — читає `BranchSettings` (checkbox: `checkboxLicenseKey/
PinCode/CashRegisterId`; monobank: `monobankToken/ApiUrl`). Лише FISCAL(checkbox) і PAYMENT(monobank).
- `credentials` — JSON-рядок, шифрується at-rest (`prisma.service ENCRYPTED_FIELDS`); write-only у API
  (GET-и повертають лише `hasCredentials`). `BranchProviderConfig` виключено з PULL_TABLES (містить секрети).

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

→ [docs/BUSINESS-RULES.md](../BUSINESS-RULES.md)
