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

→ [docs/BUSINESS-RULES.md](../BUSINESS-RULES.md) · [docs/objects/supplier-payment.md](supplier-payment.md)
