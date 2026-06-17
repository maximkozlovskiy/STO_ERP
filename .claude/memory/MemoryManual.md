# STO ERP — Memory Manual

## Останній commit

01e4abbe docs(memory): post-review cycle 2 — 0 problems at HEAD d3771b77
Дата: 2026-06-17

## Поточний стан проєкту (Cycle 2 final tester)

TypeScript: 0 errors (web + api)
API tests: 922/922 passed (66 файлів) — +14 з попереднього стану
Web tests: 434/434 passed (40 файлів)
Git: main, HEAD = 01e4abbe (буде оновлено commit-ом сесії)

## Cycle 2 final tester — додані regression-guards

### Bug #530 — public DTO leak guards для findByShareToken

**Файл:** `apps/api/src/modules/work-orders/work-orders.share-public.spec.ts` (новий, 9 тестів)
**Захищає:** EstimatePublicDto не повинен витікати `costPrice`, `batchCostPrice`, `warehouseId`, `goodId`, `orgId`, `paidAmount`, `syncVersion`, `contractId`, `shareToken`, `createdAt`, `updatedAt`.
**Перевіряє:** Promise.all parallel між org та goodUoMs; skip goodUoM.findMany якщо uomIds empty; точний whitelist `{id, goodName, quantity, unitShortName, price, amount}` для parts[].

### Bug #531 — recalcTotals defensive `take: 1000` cap

**Файл:** `apps/api/src/modules/work-orders/work-orders.recalc-cap.spec.ts` (новий, 5 тестів)
**Захищає:** `tx.workOrderLine.findMany` всередині recalcTotals — від unbounded findMany (regression до видалення `take`) та silent truncation (regression до зниженого `take`).
**Перевіряє:** exact `take: 1000`, narrow select `{amount, actualHours, normoHours, price}`, boundary 1000 рядків, mixed actualHours/null коректний single-pass reduce.

### Bug #532 — Cycle 2 simplify audit: clean

**Висновок:** жодних cleanup-debt. `canSeeCostPrice` використовує O(1) Set lookup; `COST_PRICE_VISIBLE_ROLES` правильно module-private; Promise.all паралельні запити; `take: 1000` єдиний у private helper.

## SKILL.md (sto-tester) — нові accumulated approaches

1. **Public DTO leak whitelist test (Bug #530)** — підхід до regression-guard для будь-якого public endpoint без auth. Сильніший за TS bound (`hasOwnProperty` check).
2. **Defensive take/limit cap regression-guard (Bug #531)** — pattern для defense-in-depth caps що не випливають з business requirement.

## Активні особливості

- soft-delete скрізь
- WorkOrder FSM через transition map
- Decimal → Number при DTO serialization
- costPrice (batch cost) role-gated: OWNER/ADMIN/STOREKEEPER/ACCOUNTANT (fail-closed для невідомих ролей)
- EstimatePublicDto whitelist: id, goodName, quantity, unitShortName, price, amount
- recalcTotals: defensive `take: 1000` cap + single-pass reduce
- findByShareToken: Promise.all([org, goodUoMs]) tier merger

## Документація

- `BUG_REPORT.md` — сесія 2026-06-17 (Bugs #530-#532)
- `.claude/skills/sto-tester/SKILL.md` — оновлено секцію "Накопичені підходи"
