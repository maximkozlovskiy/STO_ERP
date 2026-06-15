# CalendarSlot — Dossier

> Слот у календарі підйомника/механіка.

_Stub — заповнити при роботі з calendar модулем._

## Ключові факти

- `parentSlotId` — split-day continuation invariant: `parent.endAt < child.startAt`
- `workOrderId` (optional) + `counterpartyId` (optional, або через WO)
- Conflict check обов'язковий для БУДЬ-ЯКОГО методу що мутує `startAt/endAt`
- При cascade-update: (1) soft-delete continuations; (2) update parent; (3) recreate child якщо range > WORK_DAY_END_H
- `excludeWorkOrderId` у conflict probe (власний WO не є конфліктом)
- Endpoint: `/api/calendar/slots`

→ [docs/BUSINESS-RULES.md](../BUSINESS-RULES.md)
