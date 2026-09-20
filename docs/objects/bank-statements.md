# Bank Statements — Dossier

> Вхідні банківські платежі БЕЗ прив'язки до рахунку (Invoice): аванси, оплати послуг без наряду,
> повернення, помилкові перекази. Staging-модель `BankTransaction` → рознесення на контрагента → `Payment`.

## Ключові факти

- **`BankTransaction`** (staging, 08_finance.prisma) — сирі вхідні надходження. НЕ append-only на рівні
  статусу (status/matchedType/counterpartyId/paymentId/ignoreReason мутуються через **CAS updateMany**),
  але грошовий факт іммутабельний. `Payment` створюється ЛИШЕ після рознесення (як OnlinePaymentIntent→Payment).
- **`Payment.counterpartyId` лишається NOT NULL** — «непрознесені» надходження живуть у BankTransaction
  (counterpartyId там nullable), НЕ як Payment без контрагента.
- **Ідемпотентність (2 рубежі):** `@@unique([orgId, bankAccountId, externalId])` (повторний імпорт/pull
  не дублює) + `BankTransaction.paymentId @unique` (1 Payment на транзакцію).
- **Джерело:** (1) файловий імпорт **CSV/XLSX/DBF** (offline, `source=FILE_IMPORT`; DBF для Ощад/Райф/ПУМБ,
  win1251); (2) API auto-pull — **Privat24** (`PRIVAT24_API`) + **monobank** (`MONOBANK_API`). Enable потребує
  мерчант-доступу/токена.
- **Multi-bank:** орг може мати рахунки в кількох банках одночасно. `BankAccount.provider` (код банку:
  privat24|monobank) визначає, ЧЕРЕЗ ЯКИЙ API тягнути виписку цього рахунку. Processor резолвить провайдер
  per-рахунок через `resolveByCode(acc.provider)` (НЕ фільтрує по enabled → кілька банків співіснують;
  дзеркалить CashRegister.fiscalProvider). null=не auto-pull/legacy (fallback resolveActive).

## FSM статусу BankTransaction

```
UNMATCHED ──match(counterparty,type)──▶ MATCHED  (створює Payment, paymentId лінк)
UNMATCHED ──ignore(reason)───────────▶ IGNORED  (Payment НЕ створюється)
```

Переходи — ТІЛЬКИ через CAS `updateMany where status=UNMATCHED, paymentId=null`. count===0 → Conflict/NotFound.

## Матчинг контрагента (BankReconciliationService.resolveBatch — BULK, ≤4 findMany/батч)

| Пріоритет | Ознака                                 | Джерело збігу                   | confidence | matchType            |
| --------- | -------------------------------------- | ------------------------------- | ---------- | -------------------- |
| 1         | `payerIban` (нормалізований UPPERCASE) | `Counterparty.iban` (exact 1)   | 1.0        | SERVICE              |
| 2         | `payerEdrpou`                          | `Counterparty.edrpou` (exact 1) | 0.9        | SERVICE              |
| 3         | `purpose` (regex № рахунку)            | `Invoice.number`                | 0.7        | INVOICE (+invoiceId) |
| 3         | `purpose` (regex № наряду/WO-)         | `WorkOrder.number`              | 0.7        | SERVICE              |
| —         | інакше                                 | —                               | —          | notFound (ручне)     |

`>1` збіг на будь-якому кроці → `ambiguous` (кандидати для UI). Оператор завжди може перевизначити тип.

## Проводка на баланс (matchTransaction → PaymentsService.create)

matchType → `settlementType` у Payment (нове опційне поле CreatePaymentDto, default PAYMENT):

- `PREPAYMENT` → SettlementTransaction **PREPAYMENT** (знак −1, аванс) — задіює наявний невикористаний тип.
- `REFUND` → **REFUND** (−1).
- `SERVICE` / `INVOICE` / `OTHER` → **PAYMENT** (−1).

Порядок (payments.create відкриває ВЛАСНУ транзакцію — НЕ обгортати): (1) CAS-mark MATCHED →
(2) payments.create → (3) link paymentId. На помилці create — відкат status=UNMATCHED (retriable).
Orphan-Payment (create ok, link fail) benign: retry натрапляє на CAS-Conflict, без double-charge.

## Файловий імпорт (BankStatementParserService + reconciliation-service)

- Парсер: ExcelJS (.xlsx) / csv-parse (.csv), UA-кома-роздільник, дата DD.MM.YYYY+ISO, нормалізація IBAN.
- `rawPreview` — сира сітка для column-mapping (формати банків різняться). `previewImport` — dry-run
  matched/ambiguous/notFound + дедуп-check по externalId (matchStatus='duplicate'). `applyImport` —
  createMany skipDuplicates, status=UNMATCHED; `amountBase` через resolveBaseConversion по валюті рахунку.

## API Endpoints (bank-statements.controller, ролі OWNER/ADMIN/ACCOUNTANT)

| Метод | Шлях                                       | Призначення                        |
| ----- | ------------------------------------------ | ---------------------------------- |
| POST  | `/bank-statements/import/raw-preview`      | сира сітка (multipart)             |
| POST  | `/bank-statements/import/preview`          | dry-run матч (multipart + mapping) |
| POST  | `/bank-statements/import/apply`            | створити UNMATCHED-транзакції      |
| GET   | `/bank-statements/transactions`            | список (status/page/limit)         |
| POST  | `/bank-statements/transactions/:id/match`  | рознести → Payment                 |
| POST  | `/bank-statements/transactions/:id/ignore` | позначити IGNORED                  |

## UI (Web)

Сторінка `bank-statements/page.tsx` — **вкладкова** (tab-shell за cash-зразком: Suspense+dynamic ssr:false,
`?tab=` через useSearchParams+router.replace):

- **[Список платежів]** `BankTransactionsTab` — список транзакцій (колонки: дата/платник/призначення/сума/
  **Рахунок**(bankAccountName ?? скорочений IBAN, join у list())/статус) + фільтр + пагінація + `MatchBankTransactionModal`
  (контрагент+тип+опц.invoice) + `BankStatementImportModal` (3-крок wizard: рахунок+файл → колонки → preview → apply).
- **[Банк. рахунки]** `BankAccountsTab` (перенесено з НДІ) — CRUD банк-рахунків; форма += provider-dropdown
  «Банк для auto-pull» + autoPullEnabled toggle; у списку **Badge «Авто-pull: <банк>»** для відмічених рахунків.
  Ref-cache+apiFetch (НЕ React-Query). Тип з `../ndi/types`, namespace `ndi`.

Nav — «Банківські платежі» (Landmark, section settlements). Хуки `useBankStatements`, `/bank-accounts`.
НДІ більше НЕ має вкладки «Банк. рахунки» (перенесено сюди).

## API auto-pull (Privat24 + monobank, ГОТОВО — enable потребує токена)

Автоматичне підтягування виписки з банк-API через чергу (offline-first). Реєстр провайдерів
(`BANK_STATEMENT_PROVIDERS`) — додати банк = один provider-клас (Open/Closed).

- **Прапор pull:** `BankAccount.autoPullEnabled` (тягнути ЛИШЕ відмічені) + `BankAccount.provider` (код банку
  per-рахунок) + `BankAccount.lastPulledAt` (курсор). Інтервал — `OrganisationSettings.bankStatementPollIntervalMinutes`
  (clamp [15,1440]).
- **Provider-шар** (`providers/`, за DELIVERY-зразком): interface `BankStatementProvider {fetchStatements, verifyCredentials}`
  - registry. Спільний HTTP-каркас: SSRF `validatePublicUrl` + timeout 10s + redirect:manual + reject-3xx +
    `redactSecrets`. Кожен provider має **захисну mapTx** (fallback-ключі, credit-only фільтр, skip невалідних, rawData):
  * **privat24** — POST /statements/transactions, id+token, DD-MM-YYYY, followId-пагінація (MAX_PAGES=200). Поля REF/OSND/SUM/TRANTYPE.
  * **monobank** — GET /personal/statement/{account}/{unixFrom}/{unixTo}, **X-Token**; **WINDOWING** (≤31д/запит,
    MAX_WINDOWS=12; rate-limit sleep 60с МІЖ шматками лише backfill, у воркері). **amount=minor/100** (МІНОР-ОДИНИЦІ —
    money-critical!); поля id/time(Unix)/counterName/counterIban/counterEdrpou/comment. account=mono id (не IBAN, дефолт '0').
- **Scheduler-ЛЕАФ** (`bank-statement-pull.module` — лише queue+scheduler; розриває цикл: SettingsModule імпортує
  леаф, не важкий BankStatementsModule): repeat.every, jobId `bank-pull-${orgId}`, reschedule, enqueueImmediate.
- **Processor** (@Processor 'bank-statement-polling' concurrency:2, DeadLetterWorkerHost): runWithTenant → findMany
  autoPullEnabled → **`resolveByCode(acc.provider)` з fallback resolveActive** (multi-bank per-account) →
  integrationLog.wrap(fetchStatements) → applyImport(`providerToSource(provider)`) → авто-матч ЛИШЕ confidence===1
  → lastPulledAt. **Per-account isolation** (весь хвіст у try/catch — Bug #768: збій 1 рахунку не пропускає інших;
  курсор НЕ рухається на збої applyImport → 0 втрати). @OnWorkerEvent('failed')→DLQ.
- **Config:** `bank-statement-providers.controller` (kind BANK, generic ProviderConfigService — credentials
  шифрується авто; verify/branch-CRUD/activate/pull-now). Web: BankStatementsTab (провайдери+інтервал+«Підтягнути
  зараз»); BankAccountsTab (dropdown «Банк для auto-pull» + autoPullEnabled toggle per-рахунок).
- **MANUAL-VERIFY** (потребує токена/живих даних): privat24 GET-vs-POST + поля + signature; monobank account-id
  резолв (дефолт '0'/client-info) + точний rate-limit; DBF-поля/encoding (win1251/cp866) на живих файлах. Захисна
  нормалізація + rawData + integration-log → діагностика без падінь.
- **Offline:** pull ТІЛЬКИ через чергу (windowing sleep у воркері); нема інтернету→job→retry/backoff→DLQ;
  файловий імпорт (CSV/XLSX/DBF) працює завжди. DBF-парсер — dbffile (pure-JS) через temp-файл (cleanup у finally).

## Sync / Tenant

- `bank_transactions` СВІДОМО поза `PULL_TABLES` (sync.service) — payer PII (payerName/payerIban/purpose),
  серверна реконсиляція, mobile не потрібна.
- Має `orgId` → fail-closed tenant-guard покриває; ручні `where:{orgId}` теж присутні скрізь.

## Тех-борг / ВІДКЛАДЕНО

- **Мультивалютний UI:** сума показується з хардкод `₴` (MVP UAH-focus); currency-aware форматування
  потребує lookup валюти транзакції.
- **Укргазбанк API** — ВІДКЛАДЕНО (нема публічної документації; звірити на живому доступі або чекати
  Open Banking НБУ). Архітектура готова додати (один provider-клас).
- **API mapping MANUAL-VERIFY** — точні поля response звірити на живих даних: privat24 (REF/OSND/TRANTYPE),
  monobank (account-id резолв, rate-limit), DBF-поля/encoding Ощад/Райф/ПУМБ (win1251/cp866). Захисна
  нормалізація толерантна до різних назв.
