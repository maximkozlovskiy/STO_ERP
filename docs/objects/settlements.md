# Settlements — Dossier

> Розрахунки з контрагентами: рахунки, баланс, акти звірки.

_Stub — заповнити при роботі з settlements модулем._

## Ключові факти

- `SettlementAccount` — balance per counterparty (немає `deletedAt`); **balance у БАЗОВІЙ валюті org**
  (семантично, з мультивалюти Фаза 2 — історично вже був UAH)
- `SettlementTransaction` — append-only (немає `deletedAt`)
- Мутація ТІЛЬКИ через `SettlementsService.createTransaction()`
- **Мультивалюта (Фаза 2, 2026-09-14):** `SettlementTransaction` += `currencyId?`/`amountBase?`/`rateUsed?`
  (nullable, backfill=UAH rate=1, FK→Currency ON DELETE SET NULL). `amount` — у валюті транзакції;
  `amountBase` — у base по курсу на дату. **`balanceDelta = BALANCE_SIGN[type] × amountBase`** (НЕ amount!)
  → різновалютні борги зводяться у base. `createTransaction` DTO += опційний `currencyId`: якщо не задано
  або == base → rate=1, amountBase=amount (7 UAH-викликачів — invoice/WO/PO/supplier — БЕЗ змін; лише
  `Payment` передає валюту рахунку). Курс через `ExchangeRatesService.resolveBaseConversion` (немає курсу
  на дату → 400). Акт звірки: `periodDelta` від `amountBase`; snapshotJson += `amountBase`; PDF у base.
  Курсові різниці — поза Фазою 2.
- **Вісь балансу (ЄДИНА):** `balance>0` = дебіторська (нам винні), `balance<0` = кредиторська
  (ми винні). Джерело правди знаку — `BALANCE_SIGN: Record<SettlementTransactionType, 1|-1>`
  (settlements.service.ts, **exported** — reconciliation act переюзує, НЕ копіює).
- **Клієнтські vs постачальницькі типи РОЗДІЛЕНІ** (знак протилежний для того самого руху,
  тому НЕ можна переюзати CHARGE/PAYMENT для постачальника):

| Тип                | Знак   | Хто пише                           | Семантика                                         |
| ------------------ | ------ | ---------------------------------- | ------------------------------------------------- |
| `CHARGE`           | +1     | `WorkOrder` COMPLETED              | клієнт винен нам                                  |
| `PAYMENT`          | −1     | `Payment` (клієнт заплатив нам)    | борг клієнта ↓                                    |
| `PREPAYMENT`       | −1     | (клієнтський, наразі без writer'а) | —                                                 |
| `REFUND`           | −1     | (клієнтський, наразі без writer'а) | —                                                 |
| `CREDIT_NOTE`      | −1     | (клієнтський, наразі без writer'а) | —                                                 |
| `SUPPLIER_CHARGE`  | **−1** | `PurchaseOrder.receive`            | отримали товар → МИ винні постачальнику           |
| `SUPPLIER_PAYMENT` | **+1** | `SupplierPayment.confirm`          | заплатили постачальнику → наш борг ↓              |
| `SUPPLIER_REFUND`  | **+1** | `SupplierReturn.confirm`           | повернули товар → наш борг ↓                      |
| `FX_GAIN`          | **+1** | `PaymentsService` (invoice→PAID)   | курсовий прибуток → гасить від'ємний base-залишок |
| `FX_LOSS`          | **−1** | `PaymentsService` (invoice→PAID)   | курсовий збиток → гасить додатний base-залишок    |

> **Курсові різниці (Фаза 4, 2026-09-14, realized FX):** повна оплата іновалютного рахунку у своїй
> валюті лишає ненульовий base-залишок (CHARGE за курсом дати документа, PAYMENT — дати оплати).
> При `invoice→PAID` (не-базова валюта) PaymentsService рахує `fx = chargeBase − paidBase`, де
> **chargeBase = Σ CHARGE.amountBase з ЛЕДЖЕРА** по charge-документу (WorkOrder для WO-рахунку /
> Invoice для standalone — НЕ зі stored `totalAmountBase`, бо WO/invoice-тотал може дрейфувати),
> **paidBase = Σ Payment.amountBase** по invoiceId. Одна проводка `FX_GAIN`/`FX_LOSS` (amount=|fx| у
> base, **currencyId=null**) обнуляє залишок ТОЧНО. Skip: base-валюта / |fx|<0.005 / вже проведено
> (count-guard, idempotency). Акт звірки авто-включає FX (BALANCE_SIGN). **Клієнтський бік лише;**
> payables (SupplierPayment) + WO-direct + unrealized (переоцінка) — deferred.

> ⚠️ **Історія бага:** до 2026-09-02 `receive()` писав `CHARGE(+1)` постачальнику → баланс
> ставав ДОДАТНИМ (наче він винен нам), через що графік оплат (фільтр `balance<0`) не бачив
> проведених PO. Виправлено окремими постачальницькими типами + backfill-міграцією
> (`20260902120100`, re-type по documentType + recompute `balance=Σ signed(tx)`).
>
> **Frontend:** знак/колір транзакції та тон балансу — через спільний хелпер
> `settlementBalanceTone()` (lib/utils) + `BALANCE_UP_TYPES`, що дзеркалять `BALANCE_SIGN`
> (НЕ хардкодити `type==='CHARGE'` — було 5 копій осі, консолідовано).
>
> Оплата постачальнику закривається [SupplierPayment](supplier-payment.md) →
> `SUPPLIER_PAYMENT`. Клієнтський `Payment` не підходить (Checkbox+лояльність — лише клієнтські).
>
> **Мітка типу (label):** ЄДИНЕ джерело — shared `SETTLEMENT_TX_TYPE_LABELS`
> (`packages/shared/src/constants/statuses.ts`). Sync-аудит Фази 4 (2026-09-14) знайшов
> ЩЕ один локальний дубль, крім вже консолідованих `SettlementsTabContent`/`PageClient`:
> `PdfService.generateReconciliationActPdf` (backend, `pdf.service.ts`) мав власний
> `txTypeLabel()` object-literal лише на 5 клієнтських типів → `SUPPLIER_*`/`FX_GAIN`/`FX_LOSS`
> друкувались у PDF акту звірки як сирий enum-рядок. Виправлено — тепер імпортує
> `SETTLEMENT_TX_TYPE_LABELS` з `@sto/shared`. При додаванні нового
> `SettlementTransactionType` перевіряти ВСІ споживачі мітки: `SettlementsTabContent.tsx`,
> `counterparties/[id]/PageClient.tsx`, `ReportBuilder.tsx`, `pdf.service.ts`
> (`generateReconciliationActPdf`) — grep `SETTLEMENT_TX_TYPE_LABELS\|txTypeLabel` перед комітом.

→ [docs/BUSINESS-RULES.md](../BUSINESS-RULES.md) · [docs/objects/supplier-payment.md](supplier-payment.md)

---

## Бізнес-правила (BR-SETL)

> Правила виведено з коду 2026-10-07, власником не затверджені.

- **BR-SETL-001**: Єдиний писар. Баланс контрагента і журнал транзакцій змінює лише `SettlementsService.createTransaction()`. Ніде більше в `apps/api/src` немає запису в `SettlementAccount` чи `SettlementTransaction` — ні через Prisma-делегат, ні вкладеним записом через `settlementAccount: { … }`, ні сирим SQL. Єдиний виняток — створення рахунку з нульовим балансом у `CounterpartiesService.create` (BR-CP-012)
- **BR-SETL-002**: Одна транзакція — це рівно один рядок журналу (`SettlementTransaction`) і рівно одна зміна балансу (`SettlementAccount.balance += знак × amountBase`), обидва записи в одній транзакції БД. Якщо викликач передав свою транзакцію (`tx`) — обидва записи йдуть у ній і власна не відкривається (відкат документа відкочує і борг); якщо не передав — `createTransaction` відкриває власну `$transaction`
- **BR-SETL-003**: Знак впливу на баланс визначає лише тип транзакції (`BALANCE_SIGN`), сума завжди додатна. Баланс росте (+1): `CHARGE`, `SUPPLIER_PAYMENT`, `SUPPLIER_REFUND`, `FX_GAIN`. Баланс падає (−1): `PAYMENT`, `PREPAYMENT`, `REFUND`, `CREDIT_NOTE`, `SUPPLIER_CHARGE`, `FX_LOSS`. Вісь одна: `balance > 0` — контрагент винен нам, `balance < 0` — ми винні контрагенту. Кожен тип enum-а має знак ±1; копія таблиці для фронту (`SETTLEMENT_BALANCE_SIGN` у `@sto/shared`) збігається з бековою тип у тип
- **BR-SETL-004**: Сума транзакції — скінченне число, більше за нуль. `0`, від'ємне, `NaN`, `Infinity` → 400 «Сума транзакції повинна бути більшою за нуль», нічого не пишеться
- **BR-SETL-005**: Рахунок обов'язковий. Якщо в контрагента в цій організації немає `SettlementAccount`, `createTransaction` кидає NotFound «Розрахунковий рахунок контрагента не знайдено»; рахунок не дотворюється (парне правило — BR-CP-012)
- **BR-SETL-006**: Ізоляція організацій. Рахунок шукається за `orgId` + `counterpartyId`; зміна балансу несе `orgId` у `where`; рядок журналу пишеться з `orgId` викликача. Усі читання — баланс, журнал, транзакції періоду акта, список актів, акт для PDF — фільтруються за `orgId`
- **BR-SETL-007**: Мультивалюта. Баланс ведеться в базовій валюті організації. Без `currencyId` транзакція вважається базовою: курс 1, `amountBase = amount`, `currencyId = null`, курс не запитується. З `currencyId` сума перераховується через `ExchangeRatesService.resolveBaseConversion(orgId, currencyId, date ?? зараз, amount, fallbackToLatest ?? false)`; у журнал пишуться `amount` (у валюті транзакції), `amountBase` і `rateUsed`, а баланс змінюється на `amountBase`, не на `amount`. Якщо конвертація кидає помилку (немає курсу, немає валюти) — вона йде викликачу, журнал і баланс не чіпаються; тихого відкату на курс 1 немає
- **BR-SETL-008**: Прив'язка до документа. `documentType`, `documentId`, `notes`, `createdBy` пишуться в рядок журналу як передані. `documentType` — довільний рядок (назва моделі-джерела: `WorkOrder`, `Invoice`, `Payment`, …), не enum; існування документа `createTransaction` не перевіряє
- **BR-SETL-009**: Журнал лише дописується. У коді api немає зміни чи видалення `SettlementTransaction`; у моделей `SettlementTransaction` і `SettlementAccount` немає `deletedAt`. Помилку виправляє зворотна транзакція (напр. `CREDIT_NOTE` на суму `CHARGE` при сторно наряду), а не правка рядка
- **BR-SETL-010**: `createTransaction` не ідемпотентна. Повторний виклик із тими самими `documentType`/`documentId`/`type` створює другий рядок журналу і вдруге змінює баланс; унікального індексу на документ у журналі немає. Захист від подвійного нарахування — обов'язок викликача: умовна зміна статусу документа (CAS) у тій самій транзакції або перевірка «вже проведено» (count) перед викликом
- **BR-SETL-011**: Акт звірки. Закриваючий баланс = **поточний** баланс рахунку на момент формування акта (не баланс на кінець періоду). Відкриваючий = закриваючий − Σ `BALANCE_SIGN[type] × (amountBase ?? amount)` транзакцій періоду. Період — календарні дні Києва: від 00:00:00.000 дня `periodFrom` до 23:59:59.999 дня `periodTo` (з урахуванням літнього/зимового часу). В акт зберігається знімок рядків періоду (дата, тип, сума, сума в базовій валюті, валюта, документ) — подальші транзакції акт не змінюють. У дельту і знімок входить не більше 5000 транзакцій періоду
- **BR-SETL-012**: Акт звірки формується лише для наявного контрагента з рахунком: контрагента немає в цій організації або він видалений → NotFound «Контрагента не знайдено»; рахунку немає → NotFound «Розрахунковий рахунок не знайдено»; акт не створюється. PDF акта шукається за `id` + `orgId` + `counterpartyId`; не знайдено → NotFound «Акт звірки не знайдено»
- **BR-SETL-013**: Читання не падає на відсутньому рахунку: баланс контрагента без рахунку — `0`, журнал — порожня сторінка. Журнал віддається від найновіших, сторінками не більше 200 рядків; рядок несе суму у валюті транзакції, код валюти, суму в базовій валюті і курс (для рядків до мультивалюти — `null`)
- **BR-SETL-014**: Доступ. Баланс контрагента бачать `OWNER`, `ADMIN`, `ACCOUNTANT`, `RECEPTIONIST`. Журнал транзакцій і акти звірки (створення, список, PDF) — лише `OWNER`, `ADMIN`, `ACCOUNTANT`

---

## Аспекти і тести, що їх стережуть

Правите один аспект — ганяєте один файл:

```bash
cd apps/api && npx vitest run src/modules/settlements/<файл>.spec.ts
```

**Модуль:** `apps/api/src/modules/settlements/`

**Маршрути UI:** `/settlements`, `/counterparties`

| Аспект                                  | Тест                                     | Кейсів |
| --------------------------------------- | ---------------------------------------- | ------ |
| ролі доступу на маршрутах               | `settlements.access.spec.ts`             | 5      |
| читання балансу і журналу               | `settlements.account-read.spec.ts`       | 7      |
| інваріанти (property-based)             | `settlements.invariants.spec.ts`         | 18     |
| акт звірки                              | `settlements.reconciliation-act.spec.ts` | 9      |
| `createTransaction` (сервісна логіка)   | `settlements.service.spec.ts`            | 22     |
| єдиний писар балансу (статичний сторож) | `settlements.single-writer.spec.ts`      | 3      |

Разом: **64** кейси (цифри з `vitest --reporter=json`, не з grep).

Спільний сетап спеків `SettlementsAccountService` — `settlements.spec-fixture.ts` (factory).

Правило → тест (мітки `// guards:`):

- `settlements.single-writer.spec.ts` — BR-SETL-001, 009.
- `settlements.service.spec.ts` — BR-SETL-002, 003, 004, 005 (і BR-CP-012), 006, 007, 008.
- `settlements.invariants.spec.ts` — BR-SETL-003 (лише два кейси, що читають справжній `BALANCE_SIGN`).
- `settlements.reconciliation-act.spec.ts` — BR-SETL-006, 011, 012.
- `settlements.account-read.spec.ts` — BR-SETL-006, 013.
- `settlements.access.spec.ts` — BR-SETL-014.

**Чого тут НЕМА.** HTTP-контракту (`*.contract.spec.ts`) немає: DTO, статуси й валідацію покриває лише E2E.

Правило без unit-тесту:

- BR-SETL-010 — правило про ВІДСУТНІСТЬ захисту в `createTransaction`: «не нарахувати двічі» тримають викликачі (напр. умовна зміна статусу рахунку в `invoices.service.ts`, count-guard курсових різниць у `invoices`/`payments`/`supplier-payments`), кожен у своєму модулі й своїми тестами. У модулі `settlements` нема за що зачепити тест: закріплювати «другий виклик пише другий рядок» означало б стерегти відсутність захисту. Справжній сторож — унікальний індекс на документ у журналі або integration-спек двох одночасних проведень; ні того, ні того немає.

Прогалини, що не є окремим правилом:

- 15 із 18 кейсів `settlements.invariants.spec.ts` перевіряють **локальну модель** (`applyTransactions` із власними списками `BALANCE_INCREASING`/`BALANCE_DECREASING`), а не код продукту: якщо в `BALANCE_SIGN` перевернути знак, вони лишаться зеленими. Справжній знак стережуть два кейси цього файла й знакові кейси `settlements.service.spec.ts`.
- Атомарність пари «рядок журналу + зміна балансу» перевірено на моках: «обидва записи пішли в один tx-клієнт». Що відкат транзакції справді прибирає і рядок журналу, і зміну балансу, проти БД не ганяє ніхто — потрібен integration-спек.
- Append-only: відсутність `deletedAt` у схемі й заборону UPDATE/DELETE на рівні БД (тригер, права) не стереже ніщо; статичний сторож бачить лише код `apps/api/src` (не `seed.ts`, не міграції) і не бачить вкладений запис через зв'язок, крім прямого `settlementAccount: { … }`.
- Акт звірки: ліміт 5000 транзакцій на акт і успішна побудова PDF акта (`generateReconciliationPdf` → `PdfService`) тестами не покриті; у PDF перевірено лише «акт не знайдено».
- Узгодженість `balance = Σ знак × сума` на живих даних перевіряє нічна звірка модуля `reconciliation`, не цей модуль.
- Фронтовий тон і знак балансу (`settlementBalanceTone` у `apps/web/src/lib/utils.ts`) unit-тесту не мають; E2E `crud-settlement.spec.ts` лише відкриває сторінку й форму акта, причому кроки з `if (!visible) return` проходять мовчки.
