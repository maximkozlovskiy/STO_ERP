# Settlements — Dossier

> Розрахунки з контрагентами: рахунки, баланс, акти звірки.

_Stub — заповнити при роботі з settlements модулем._

## Ключові факти

- `SettlementAccount` — balance per counterparty (немає `deletedAt`)
- `SettlementTransaction` — append-only (немає `deletedAt`)
- Мутація ТІЛЬКИ через `SettlementsService.createTransaction()`
- `BALANCE_SIGN: Record<SettlementTransactionType, 1|-1>` — exhaustive (без Partial<>)
- CHARGE = борг виник (отримали товар/послугу) → баланс збільшується
- PAYMENT = гроші надійшли → баланс зменшується

→ [docs/BUSINESS-RULES.md](../BUSINESS-RULES.md)
