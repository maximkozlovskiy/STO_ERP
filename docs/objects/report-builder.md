# Report Builder — Dossier

> Конструктор звітів: самообслуговуваний динамічний звіт (drag полів, фільтри, ієрархічне
> групування ≤5, поля зв'язків `Контрагент.Тип`, підсумки, збереження, експорт).

## Ключові факти

- **Метадата-реєстр** (`report-registry.ts`) — ЄДИНЕ ДЖЕРЕЛО ПРАВДИ. Описує сутності: `fields[]`
  ({key, label, type, prismaPath, enumName?, aggregations[], filterable, groupable, stateNotFlow?,
  signedByType?}), `relations[]` ({prismaPath, depth, advanced, targetHasSoftDelete}), прапорці
  `hasSoftDelete`/`profile: FULL|APPEND_ONLY`, `dateField`. Живить і backend-білдер, і фронт
  (`GET /reports/builder/metadata`).
- **9 сутностей:** WorkOrder (Наряди), WorkOrderPart (Запчастини), PurchaseOrderLine (Закупівлі),
  Invoice (Рахунки), Payment (Платежі, append-only), SettlementTransaction (Розрахунки, append-only),
  StockMovement (Рухи, append-only, знакова quantity), StockBatch (Партії, append-only), StockItem
  (Залишки). Розширення = один запис у REGISTRY, движок не міняється.
- **Профілі:** FULL (deletedAt-інжекція) vs APPEND_ONLY (без deletedAt — Payment/StockMovement/
  SettlementTransaction/StockBatch; звірено регрес-тестом registry.spec, бо StockBatch не має deletedAt).
- **3 компоненти движка:** `report-query.builder.ts` (config→Prisma findMany),
  `report-aggregator.ts` (JS-групування ≤5 + агрегації), `report-builder.service.ts` (оркестрація
  - SavedReport CRUD).

## Безпека (injection неможливий за побудовою)

- Користувач передає ЛИШЕ `field.key`/`entity.key` — вони резолвляться у реєстрові `prismaPath`
  (літерали у коді) через `getEntity`/`getField` з `Object.prototype.hasOwnProperty.call`-guard
  (захист від `__proto__`/`constructor`/`toString`, як `buildSortOrderBy`).
- Жоден ключ Prisma (`where`/`include`/`select`/`orderBy`) не походить із вводу. Значення фільтрів
  параметризує Prisma-клієнт. Enum-значення + `op` — з фіксованих whitelist.
- `orgId` інжектиться у КОЖЕН `where`; `deletedAt:null` — лише де `hasSoftDelete`; nested
  `deletedAt` на relation-хопах у WHERE (Bug #607).

## Prisma-нюанси (баги live-верифікації)

- **to-one relation НЕ приймає `where` у include** → Prisma "Unknown argument where". Усі relations
  тут belongs-to → soft-delete relation-колонок пропущено (рядок уже відфільтрований по кореневому
  deletedAt). Фікс 13861792.
- **`include`+`select` на одному рівні заборонено** (Bug #617). relation-branch будується ПОВНІСТЮ
  через nested `select` (`{good:{select:{name:true, brand:{select:{name:true}}}}}`), корінь — `include`.

## Pivot-модель (детальні рядки + агрегати)

Конструктор — справжній pivot, не лише group-by:

- **Без groupBy** → плоска таблиця детальних рядків (`result.detailRows`, проєкція columns).
- **З groupBy** → дерево груп; на листі детальні рядки (`node.rows`) розгортаються.
- **Авто-SUM:** числова колонка без явної агрегації → авто-SUM (`effectiveAggregations` у service).
  Response несе ефективні `aggregations` (явні + авто), збагачені `{type,label}` (Bug #620 — щоб
  форматувати MIN/MAX-дати навіть коли поле не в columns).
- **Сортування груп** за агрегатом: `sortByAggregate {alias, dir}`; клік по заголовку агрегату у UI.
  `∅`-група бере участь у sort-by-agg (не форсується в кінець). `hasOwnProperty`-guard на alias
  (proto-injection).
- `includeRows` завжди true (інакше «детальний звіт» неможливий).

## Агрегації (report-aggregator)

- SUM/AVG/MIN/MAX per-field; COUNT НЕ пропонується per-field (дублює group.count) — кількість
  записів через `node.count`/`rowCount`.
- **balance** → лише AVG/MIN/MAX (`stateNotFlow` → SUM=400 — стан, не потік).
- **знакова quantity** (`signedByType`) → знак за сусіднім type: WRITEOFF/RESERVATION_RELEASE = −,
  RECEIPT = +. **НЕ-фізичні рухи** (RESERVATION/RESERVATION_RELEASE, quantityDelta=0) → виключені
  з SUM (Bug #619 — інакше фантомні резервування спотворювали нетто). Cross-invariant:
  `stockMovement.SUM_quantity == stockItem.SUM_quantity`.
- StockMovement.quantity `filterable:false` — фільтр по знаковому вводить в оману; для «прихід/
  списання» — фільтр/групування по `type`.
- **grandTotals** — незалежний прохід по всій вибірці (AVG grand ≠ середнє груп — SQL-семантика).
- **ІНВАРІАНТ:** `Σ(листкові SUM) == grandTotal` — live-verified усі 9 сутностей, diff=0.
- `take` cap 5000 (`REPORT_TAKE_CAP`), `truncated = rowCount >= cap` → UI-банер.

## API Endpoints (`/api/reports/builder`)

| Метод            | URL              | Дія                                            |
| ---------------- | ---------------- | ---------------------------------------------- |
| GET              | `/metadata`      | Реєстр для фронта (сутності/поля/зв'язки/enum) |
| POST             | `/run`           | Ad-hoc звіт (ReportRunDto → tree+grandTotals)  |
| GET              | `/saved`         | Список збережених                              |
| POST             | `/saved`         | Зберегти (dry-run buildQuery перед create)     |
| GET              | `/saved/:id/run` | Запустити збережений                           |
| GET/PATCH/DELETE | `/saved/:id`     | Деталь / оновити / soft-delete                 |

Ролі: `OWNER`, `ADMIN`, `ACCOUNTANT`. Route ordering: специфічні перед `:id`.

## UI (Web)

| Компонент             | Файл                                                           |
| --------------------- | -------------------------------------------------------------- |
| Вкладка «Конструктор» | `app/(app)/reports/ReportBuilder.tsx` (палітра+3 зони+таблиця) |
| Хуки                  | `hooks/api/useReportBuilder.ts`                                |

Native HTML5 drag (палітра→зона); ієрархічна таблиця з розгортанням + tfoot-підсумки; експорт
CSV/XLSX клієнтський (SpreadsheetML).

## Prisma модель

`SavedReport` (FULL-профіль): `orgId, name, entity, config Json, createdBy?, syncVersion, стандартні
поля`. Міграція `20260903120000_add_saved_reports`. `@@index([orgId, deletedAt])`.

→ [docs/ARCHITECTURE.md](../ARCHITECTURE.md) · [docs/objects/settlements.md](settlements.md)
