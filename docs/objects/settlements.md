# Settlements — Dossier

> Розрахунки з контрагентами: рахунки, баланс, акти звірки.

_Stub — заповнити при роботі з settlements модулем._

## Ключові факти

- `SettlementAccount` — balance per counterparty (немає `deletedAt`)
- `SettlementTransaction` — append-only (немає `deletedAt`)
- Мутація ТІЛЬКИ через `SettlementsService.createTransaction()`
- **Вісь балансу (ЄДИНА):** `balance>0` = дебіторська (нам винні), `balance<0` = кредиторська
  (ми винні). Джерело правди знаку — `BALANCE_SIGN: Record<SettlementTransactionType, 1|-1>`
  (settlements.service.ts, **exported** — reconciliation act переюзує, НЕ копіює).
- **Клієнтські vs постачальницькі типи РОЗДІЛЕНІ** (знак протилежний для того самого руху,
  тому НЕ можна переюзати CHARGE/PAYMENT для постачальника):

| Тип                | Знак   | Хто пише                           | Семантика                               |
| ------------------ | ------ | ---------------------------------- | --------------------------------------- |
| `CHARGE`           | +1     | `WorkOrder` COMPLETED              | клієнт винен нам                        |
| `PAYMENT`          | −1     | `Payment` (клієнт заплатив нам)    | борг клієнта ↓                          |
| `PREPAYMENT`       | −1     | (клієнтський, наразі без writer'а) | —                                       |
| `REFUND`           | −1     | (клієнтський, наразі без writer'а) | —                                       |
| `CREDIT_NOTE`      | −1     | (клієнтський, наразі без writer'а) | —                                       |
| `SUPPLIER_CHARGE`  | **−1** | `PurchaseOrder.receive`            | отримали товар → МИ винні постачальнику |
| `SUPPLIER_PAYMENT` | **+1** | `SupplierPayment.confirm`          | заплатили постачальнику → наш борг ↓    |
| `SUPPLIER_REFUND`  | **+1** | `SupplierReturn.confirm`           | повернули товар → наш борг ↓            |

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
