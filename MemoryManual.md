# MemoryManual — STO ERP

> Тонкий вхідний файл. Читається loop-ом щогодини і на початку кожної сесії.
> Містить ТІЛЬКИ поточний стан + останній commit + посилання на довідники.
> Вся історія → `CHANGELOG.md`. Патерни → `docs/PATTERNS.md`. Правила → `docs/BUSINESS-RULES.md`.

---

## Поточний стан

```
Дата:       2026-06-15
Фаза:       Активна розробка (CHANGELOG.md → docs/PHASES.md)
TypeScript: api ✅ 0 errors | web ✅ 0 errors | shared ✅ 0 errors
Тести:      API 834/834 | Web 423/423 | E2E 236 passed / 9 skipped / 0 failed
```

---

## Останній commit

```
9e656cd4  fix(supplier-returns): review fixes — WRITEOFF qty sign, REFUND vs PAYMENT,
          /goods + /warehouses endpoints, DocumentType convention, DocumentNumberConfig backfill
28edc08c  feat(supplier-returns): full backend + frontend for supplier returns
f321d07d  docs: restructure MemoryManual — object dossiers + spec template + B1-B7 patterns
e64bca47  docs: restructure MemoryManual into layered docs (ARCHITECTURE/PATTERNS/BUSINESS-RULES/CHANGELOG)
cc2cd2e1  fix(tester): Bugs #487-#490 — post-cycle3 spec gaps + BALANCE_SIGN exhaustiveness
93473ad7  refactor(simplify): deduplicateBy<T> utility + BALANCE_SIGN lookup table
```

Latest review: 2026-06-15 (auto, HEAD 9e656cd4) — supplier-returns critical/important fixes

Повна історія → [CHANGELOG.md](CHANGELOG.md)

---

## Нові файли/утиліти (з останніх сесій)

| Файл                                        | Що                                                 |
| ------------------------------------------- | -------------------------------------------------- |
| `apps/api/src/common/utils/array.ts`        | `deduplicateBy<T>(arr, key)` — Map last-wins dedup |
| `apps/web/src/lib/utils.ts`                 | `toIdMap<T extends {id}>`, `calcVatTotals`         |
| `packages/shared/src/constants/statuses.ts` | RECEIPT у STOCK_DOC_TYPE_LABELS/BADGE              |

---

## Активні особливості поточного коду

- `StockDocumentType.RECEIPT` — повністю додано: Prisma enum + DTO + service + frontend tabs
- `deduplicateBy(plan, u => u.goodId)` — у PO/xlsx applyPricing ПЕРЕД `Promise.all`
- `BALANCE_SIGN: Record<SettlementTransactionType, 1|-1>` — exhaustive (без Partial<>)
- `Promise.all` для per-line writes у SD transition/PO receive (disjoint rows — safe)
- work-orders.service.ts parts loops — **sequential** (shared StockItem composite key — unsafe to parallelize)
- CalendarSlot.parentSlotId — split-day continuation invariant (не колапсувати через updateMany)

---

## Довідники (читати за потреби)

| Файл                                                 | Коли читати                                                                    |
| ---------------------------------------------------- | ------------------------------------------------------------------------------ |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)         | API модулі (28), Prisma моделі (41), утиліти, sync                             |
| [docs/PATTERNS.md](docs/PATTERNS.md)                 | UI компоненти, hooks, B1-B7, EntityPickerField                                 |
| [docs/BUSINESS-RULES.md](docs/BUSINESS-RULES.md)     | FSM, інвентар, розрахунки, тенант-ізоляція                                     |
| [docs/GOTCHAS.md](docs/GOTCHAS.md)                   | Відомі пастки — читати перед новою фічею                                       |
| [CHANGELOG.md](CHANGELOG.md)                         | Журнал комітів по фічах                                                        |
| [docs/PHASES.md](docs/PHASES.md)                     | Поточна фаза і задачі                                                          |
| [docs/objects/](docs/objects/)                       | Дос'є агрегатів: WO, Invoice, PO, StockDoc, Counterparty, Good, Work, Calendar |
| [docs/specs/\_TEMPLATE.md](docs/specs/_TEMPLATE.md)  | Шаблон специфікації нової фічі                                                 |
| [.claude/memory/MEMORY.md](.claude/memory/MEMORY.md) | User preferences                                                               |

---

## Правило оновлення (для агентів)

Після кожного коміту — оновити **тільки** цей файл:

1. `Останній commit` → нові хеші (5–6 рядків)
2. `Поточний стан` → TypeScript статус, дата, тести
3. `Нові файли/утиліти` → якщо з'явились нові
4. `Активні особливості` → якщо щось змінилось у логіці

**НЕ** додавати сюди деталі рішень, full bug descriptions, список виправлень.  
Деталі → `CHANGELOG.md` (append, 3–5 рядків max per commit).  
Патерн/правило → відповідний довідник (одне місце правди).
