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
- **Джерело:** (1) файловий імпорт CSV/XLSX (offline, `source=FILE_IMPORT`); (2) Privat24 Merchant API
  auto-pull (`source=PRIVAT24_API`, ProviderKind.BANK — Фаза 4, ГОТОВО; enable потребує мерчант-доступу).

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

Сторінка `bank-statements/page.tsx` (список UNMATCHED + фільтр + пагінація) + `MatchBankTransactionModal`
(контрагент+тип+опц.invoice) + `BankStatementImportModal` (3-крок wizard: рахунок+файл → колонки → preview
→ apply). Nav — «Банківські платежі» (Landmark, section settlements). Хук `useBankStatements`.

## Privat24 auto-pull (Фаза 4, ГОТОВО — enable потребує мерчант-доступу)

Автоматичне підтягування виписки з Privat24 Merchant API через чергу (offline-first).

- **Прапор pull:** `BankAccount.autoPullEnabled` — тягнути ЛИШЕ відмічені рахунки (Autoclient-креди
  per-IBAN); `BankAccount.lastPulledAt` — курсор вікна дат. Інтервал — `OrganisationSettings.
bankStatementPollIntervalMinutes` (clamp [15,1440]).
- **Provider-шар** (`providers/`, за DELIVERY-зразком): `bank-provider.interface` (BankStatementProvider +
  BANK_STATEMENT_PROVIDERS Symbol), `privat24.client` (POST /statements/transactions, id+token заголовки,
  DD-MM-YYYY, followId-пагінація MAX_PAGES=200; SSRF validatePublicUrl + timeout 10s + redirect:manual +
  reject-3xx + redactSecrets), `privat24.provider` (**захисна mapTx**: fallback-ключі REF/OSND/SUM/TRANTYPE,
  credit-only фільтр, skip невалідних, rawData для діагностики), `bank-provider-registry`.
- **Scheduler-ЛЕАФ** (`bank-statement-pull.module` — лише queue+scheduler; розриває цикл: SettingsModule
  імпортує леаф, не важкий BankStatementsModule що тягне PaymentsModule): repeat.every interval*60с,
  jobId `bank-pull-${orgId}`, reschedule, enqueueImmediate.
- **Processor** (@Processor 'bank-statement-polling' concurrency:2, extends DeadLetterWorkerHost):
  runWithTenant → findMany autoPullEnabled → resolveActive('BANK') → integrationLog.wrap(fetchStatements)
  → applyImport(PRIVAT24_API) → авто-матч ЛИШЕ confidence===1 → lastPulledAt-курсор. **Per-account
  isolation** (весь хвіст applyImport+match+cursor у log-and-continue try/catch — Bug #768: збій одного
  рахунку не пропускає інших; курсор НЕ рухається на збої applyImport → 0 втрати, наступний pull повторить
  ідемпотентно). @OnWorkerEvent('failed')→DLQ.
- **Config:** `bank-statement-providers.controller` (kind BANK, generic ProviderConfigService — credentials
  шифрується авто; verify/branch-CRUD/activate/**pull-now**). Web: BankStatementsTab (ProviderRegistryPanel
  - інтервал + «Підтягнути зараз»). autoPullEnabled toggle per-рахунок — API готовий, UI-toggle окремий таск.
- **MANUAL-VERIFY** (потребує мерчант-доступу): GET-vs-POST, точні поля response (REF/OSND/TRANTYPE-код/SUM/
  payer*), signature. Захисна нормалізація + rawData + integration-log → діагностика на живих даних без падінь.
- **Offline:** pull ТІЛЬКИ через чергу; нема інтернету→job падає→retry/backoff→DLQ; файловий імпорт працює завжди.

## Sync / Tenant

- `bank_transactions` СВІДОМО поза `PULL_TABLES` (sync.service) — payer PII (payerName/payerIban/purpose),
  серверна реконсиляція, mobile не потрібна.
- Має `orgId` → fail-closed tenant-guard покриває; ручні `where:{orgId}` теж присутні скрізь.

## Тех-борг / ВІДКЛАДЕНО

- **Мультивалютний UI:** сума показується з хардкод `₴` (MVP UAH-focus); currency-aware форматування
  потребує lookup валюти транзакції.
- **autoPullEnabled toggle per-рахунок** у сторінці bank-accounts — API готовий (DTO+service), UI-toggle
  окремий дрібний фронт-таск.
- **Privat24 mapping MANUAL-VERIFY** — точні назви полів response звірити на живому мерчант-акаунті
  (захисна нормалізація зараз толерантна до різних назв).
