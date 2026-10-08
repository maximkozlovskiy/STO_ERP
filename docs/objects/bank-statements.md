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

| Метод | Шлях                                       | Призначення                                            |
| ----- | ------------------------------------------ | ------------------------------------------------------ |
| POST  | `/bank-statements/import/raw-preview`      | сира сітка (multipart)                                 |
| POST  | `/bank-statements/import/preview`          | dry-run матч (multipart + mapping)                     |
| POST  | `/bank-statements/import/apply`            | створити UNMATCHED-транзакції                          |
| GET   | `/bank-statements/transactions`            | список (status/direction/q/dateFrom/dateTo/page/limit) |
| POST  | `/bank-statements/transactions/:id/match`  | рознести → Payment                                     |
| POST  | `/bank-statements/transactions/:id/ignore` | позначити IGNORED                                      |

## UI (Web)

Сторінка `bank-statements/page.tsx` — один рядок вкладок, як на «Купівлі» і «Складі» (рішення
власника 2026-10-08): зліва розрізи списку платежів за напрямком, праворуч — «Банк. рахунки».

- **[Всі] / [Вхідні] / [Вихідні]** — той самий `BankTransactionsTab` із фільтром `direction`
  (`?direction=IN|OUT`, без параметра — усі). Колонки: дата / платник / **Рахунок**
  (bankAccountName ?? скорочений IBAN, join у list()) / призначення / сума / статус; фільтр статусу
  і кнопка «Імпорт виписки» в одному рядку; пагінація; `MatchBankTransactionModal`
  (контрагент+тип+опц.invoice); `BankStatementImportModal` (3-крок wizard: рахунок+файл → колонки →
  preview → apply). **«Вихідні» поки завжди порожні:** імпорт кладе лише `direction=IN`
  (BR-BANK-001) — вкладка і фільтр готові до появи імпорту вихідних платежів.
- **[Банк. рахунки]** (`?tab=accounts`, остання вкладка рядка) `BankAccountsTab` (перенесено з НДІ)
  — CRUD банк-рахунків; форма += provider-dropdown
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

## Бізнес-правила (BR-BANK)

> Правила виведено з коду 2026-10-08, власником не затверджені.

- **BR-BANK-001**: Імпорт виписки (файл або auto-pull) лише кладе рядки у staging `BankTransaction`: `direction=IN`, `status=UNMATCHED`, валюта = валюта банківського рахунку, `amountBase`/`rateUsed` — через `ExchangeRatesService.resolveBaseConversion` на дату операції; `source` = `FILE_IMPORT` для файлу, `PRIVAT24_API` / `MONOBANK_API` для auto-pull. `Payment` на етапі імпорту не створюється.
- **BR-BANK-002**: Імпорт ідемпотентний: той самий `externalId` у тому самому банківському рахунку не заводиться двічі (`createMany` зі `skipDuplicates` на унікальному ключі `orgId + bankAccountId + externalId`); результат — `{created, skipped = рядків − created}`. Прев'ю позначає вже імпортований рядок `duplicate` (перекриває авто-матч) і шукає його лише у своєму рахунку.
- **BR-BANK-003**: Дата операції ніколи не «перекочується»: неіснуюча дата (31.02, 29.02 невисокосного року) у файлі чи у відповіді Privat24 відкидає рядок, а в `import/apply` неіснуюча або нерозбірна дата дає 400 до будь-якого запису (дата визначає курс для `amountBase`).
- **BR-BANK-004**: Авто-матч рядка з контрагентом іде каскадом, перший збіг виграє: IBAN платника → `SERVICE`, confidence 1.0; ЄДРПОУ → `SERVICE`, 0.9; номер рахунку-фактури у призначенні → `INVOICE` + `invoiceId`, 0.7; номер наряду у призначенні → `SERVICE`, 0.7; інакше `notFound`.
- **BR-BANK-005**: Більше одного контрагента з тим самим IBAN або ЄДРПОУ → `ambiguous` зі списком кандидатів: контрагент не вгадується, і каскад для цього рядка далі не йде.
- **BR-BANK-006**: IBAN платника порівнюється і зберігається нормалізованим — UPPERCASE, без пробілів (файловий парсер, `applyImport`, `resolveBatch`); порожній → `null`.
- **BR-BANK-007**: Статус рядка змінюється лише з `UNMATCHED` і лише атомарним CAS (`updateMany where status=UNMATCHED, paymentId=null`): `match` → `MATCHED` (+ контрагент, тип), `ignore` → `IGNORED` (+ причина, без `Payment`). Повторна спроба на вже обробленому рядку → 409, неіснуючий рядок → 404.
- **BR-BANK-008**: Рознесення створює рівно один `Payment` і лише через `PaymentsService.create`: сума = сума рядка (не з запиту), `method=bank`, `sourceType=BANK_ACCOUNT`, рахунок = рахунок рядка; `settlementType`: `PREPAYMENT` → PREPAYMENT, `REFUND` → REFUND, `SERVICE` / `INVOICE` / `OTHER` → PAYMENT; `invoiceId` передається лише для типу `INVOICE`. Id платежу записується у `paymentId` рядка.
- **BR-BANK-009**: Якщо `PaymentsService.create` впав — рядок повертається в `UNMATCHED` (контрагент і тип очищуються; лише поки `paymentId` порожній), оригінальна помилка віддається клієнту, рядок можна рознести повторно.
- **BR-BANK-010**: Вхід рознесення перевіряється ДО захоплення рядка: тип `INVOICE` без `invoiceId` → 400; контрагент або рахунок-фактура не знайдені → 404; рахунок-фактура виписана на іншого контрагента → 400 (BR-PAY-016); рядок і платежі при цьому не чіпаються.
- **BR-BANK-011**: Auto-pull сам розносить лише впевнений збіг — `matched` з confidence = 1 (IBAN) і відомим контрагентом; збіги за ЄДРПОУ чи призначенням, `ambiguous` і `notFound` лишаються `UNMATCHED` для ручного рознесення.
- **BR-BANK-012**: Auto-pull обробляє лише рахунки з `autoPullEnabled`; збій одного рахунку (API банку, імпорт, матч) не зупиняє інші; курсор `lastPulledAt` рухається лише після успішного імпорту або порожнього вікна — після збою імпорту вікно буде повторене.
- **BR-BANK-013**: З банківських API у staging потрапляють лише вхідні (credit) проводки з додатною сумою; monobank віддає суму в копійках — вона ділиться на 100.
- **BR-BANK-014**: Межі запитів `import/apply`, `match`, `ignore` (DTO): не більше 1000 рядків за запит; сума рядка ≥ 0.01; `externalId` і дата операції обов'язкові; `bankAccountId` — UUID; тип рознесення — лише з переліку (`SERVICE` / `PREPAYMENT` / `INVOICE` / `REFUND` / `OTHER`); ігнорування — лише з непорожньою причиною.
- **BR-BANK-015**: Доступ: імпорт, список, рознесення й ігнорування — лише `OWNER` / `ADMIN` / `ACCOUNTANT`; змінювати налаштування банк-провайдера (зберегти, активувати) — лише `OWNER` / `ADMIN`; бухгалтер може їх переглядати, перевіряти ключі й запускати «Підтягнути зараз».
- **BR-BANK-016**: Tenant: кожен запит модуля фільтрується по `orgId`; банківський рахунок імпорту, контрагент, рахунок-фактура й рядок виписки шукаються лише у своїй організації й лише невидалені — чужий або видалений → 404.

---

## Аспекти і тести, що їх стережуть

Правите один аспект — ганяєте один файл:

```bash
cd apps/api && npx vitest run src/modules/bank-statements/<файл>.spec.ts
```

**Модуль:** `apps/api/src/modules/bank-statements/`

| Аспект                         | Тест                                            | Кейсів |
| ------------------------------ | ----------------------------------------------- | ------ |
| авто-матч з контрагентом       | `bank-reconciliation.auto-match.spec.ts`        | 5      |
| імпорт у staging               | `bank-reconciliation.import.spec.ts`            | 5      |
| рознесення / ігнорування (FSM) | `bank-reconciliation.posting.spec.ts`           | 17     |
| сервісна логіка                | `bank-reconciliation.service.spec.ts`           | 27     |
| парсер файлу виписки           | `bank-statement-parser.service.spec.ts`         | 17     |
| контролер провайдерів          | `bank-statement-providers.controller.spec.ts`   | 7      |
| BullMQ-processor               | `bank-statement-pull.processor.spec.ts`         | 20     |
| scheduler                      | `bank-statement-pull.scheduler.spec.ts`         | 4      |
| DTO-межі запитів               | `bank-statement.dto.spec.ts`                    | 9      |
| доступ (ролі)                  | `bank-statements.controller.spec.ts`            | 8      |
| HTTP-клієнт                    | `providers/mono-statement.client.spec.ts`       | 13     |
| провайдер                      | `providers/monobank-statement.provider.spec.ts` | 17     |
| HTTP-клієнт                    | `providers/privat24.client.spec.ts`             | 10     |
| провайдер                      | `providers/privat24.provider.spec.ts`           | 15     |
| purpose parser                 | `purpose-parser.spec.ts`                        | 11     |

Спільний сетап аспектних спеків `bank-reconciliation.*` — `bank-reconciliation.spec-fixture.ts` (фабрики моків).

Разом: **185** кейсів (цифри з `vitest --reporter=json`, не з grep).

**Чого тут НЕМА.** HTTP-контракту (`*.contract.spec.ts`) немає: що `ValidationPipe` і `RolesGuard` справді спрацьовують на маршрутах (статуси 400/403), покриває лише E2E — unit-спеки перевіряють самі декоратори DTO та metadata ролей.
Integration-спеку (`*.integration.spec.ts`) немає, тому лише на моках, без справжньої БД, лишаються: унікальний індекс `orgId + bankAccountId + externalId` і `paymentId @unique` (unit стереже прапорець `skipDuplicates`, а не сам індекс); гонка двох одночасних рознесень одного рядка (CAS перевірено за формою `where`, не конкурентно); сирітський `Payment`, якщо платіж створено, а запис `paymentId` у рядок упав.
Файловий парсер за знаком суми не фільтрує (від'ємні й нульові рядки доходять до прев'ю) — тесту на це свідомо немає: поведінка схожа на недогляд, а не на правило.
