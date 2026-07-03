# Settlements — Dossier

> Розрахунки з контрагентами: рахунки, баланс, акти звірки.

_Stub — заповнити при роботі з settlements модулем._

## Ключові факти

- `SettlementAccount` — balance per counterparty (немає `deletedAt`)
- `SettlementTransaction` — append-only (немає `deletedAt`)
- Мутація ТІЛЬКИ через `SettlementsService.createTransaction()`
- `BALANCE_SIGN: Record<SettlementTransactionType, 1|-1>` — exhaustive (без Partial<>)
- CHARGE = борг виник (отримали товар/послугу) → баланс збільшується
- PAYMENT = гроші надійшли/сплачені → баланс зменшується

## Джерела транзакцій

| Тип     | Хто пише                                                     | Контрагент            |
| ------- | ------------------------------------------------------------ | --------------------- |
| CHARGE  | `WorkOrder` COMPLETED, `PurchaseOrder.receive`               | клієнт / постачальник |
| PAYMENT | `Payment` (клієнт), `SupplierPayment.confirm` (постачальник) | клієнт / постачальник |
| REFUND  | `SupplierReturn.confirm`                                     | постачальник          |

> Оплата постачальнику закривається документом [SupplierPayment](supplier-payment.md) →
> `SettlementTransaction(PAYMENT)`. Клієнтський `Payment` для цього не підходить
> (Checkbox + лояльність — тільки для клієнтських продажів).

→ [docs/BUSINESS-RULES.md](../BUSINESS-RULES.md) · [docs/objects/supplier-payment.md](supplier-payment.md)
