# Counterparty — Dossier

> Контрагент: клієнт або постачальник.

_Stub — заповнити при роботі з CRM модулем._

## Ключові факти

- Endpoint: `/api/counterparties`
- Sub-resources: `/garages`, `/contracts`, `/contracts/:id/set-primary`
- `type`: INDIVIDUAL / COMPANY
- `role`: CLIENT / SUPPLIER / BOTH
- `isPrimary` у `CounterpartyContract` → promote при soft-delete
- `companyName` — fallback для search (similarity по companyName окремо від firstName+lastName)

→ [docs/BUSINESS-RULES.md](../BUSINESS-RULES.md)
→ [docs/PATTERNS.md](../PATTERNS.md) (EntityPickerField)
