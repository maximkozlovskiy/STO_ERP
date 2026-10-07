# WorkOrder — Dossier

> Основний агрегат STO ERP. Наряд на ремонт авто.

---

## Prisma модель

```prisma
model WorkOrder {
  id               String           @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  orgId            String           @db.Uuid
  number           String           // авто-генерується DocumentNumberService.next()
  status           WorkOrderStatus  @default(DRAFT)
  priority         WorkOrderPriority @default(NORMAL)
  vehicleId        String?          @db.Uuid
  counterpartyId   String?          @db.Uuid
  branchId         String           @db.Uuid
  liftId           String?          @db.Uuid
  plannedHours     Decimal?         @db.Decimal(8,2)
  actualHours      Decimal?         @db.Decimal(8,2)
  description      String?
  completedAt      DateTime?
  createdAt        DateTime         @default(now())
  updatedAt        DateTime         @updatedAt
  deletedAt        DateTime?
  syncVersion      BigInt           @default(0)

  lines            WorkOrderLine[]
  parts            WorkOrderPart[]
  calendarSlots    CalendarSlot[]
  invoices         Invoice[]
}
```

**Відносини:**

- → `Vehicle` (M:1 через `vehicleId`, optional)
- → `Counterparty` (M:1 через `counterpartyId`, optional)
- → `GarageBranch` (M:1 через `branchId`)
- → `Lift` (M:1 через `liftId`, optional)
- ← `WorkOrderLine[]` (роботи)
- ← `WorkOrderPart[]` (запчастини)
- ← `CalendarSlot[]` (слоти календаря)
- ← `Invoice[]` (рахунки)
- → `Currency` (M:1 через `currencyId`, optional — мультивалюта Фаза 3)

> **Мультивалюта (Фаза 3, 2026-09-14):** WorkOrder += `currencyId`/`totalAmountBase`/`rateUsed`.
> `totalAmount`/`totalLabor`/…/`paidAmount` — у **валюті наряду**; `totalAmountBase` — тотал у базовій
> валюті org по курсу на `documentDate` (recalcTotals; fallbackToLatest). CHARGE (COMPLETED) і
> CREDIT_NOTE (COMPLETED→CANCELLED) пробрасують `currencyId`+`date` у settlement → борг у base. Оплата
> наряду має бути у валюті наряду (WO.paidAmount += сума у валюті). FX-різниці — поза Фазою 3.

---

## FSM

```
DRAFT → ESTIMATE → APPROVED → IN_PROGRESS → ON_HOLD
                 ↘ CANCELLED    ↘ CANCELLED    ↘ CANCELLED
                                               ↓
                                         IN_PROGRESS ← (ON_HOLD)
                                               ↓
                                          COMPLETED → INVOICED → PAID → ARCHIVED
                                         ↘ CANCELLED
```

> COMPLETED→CANCELLED (C2) реверсує склад+борг (див. side-effects). INVOICED/PAID/ARCHIVED
> **незворотні** (там уже рахунок/гроші) — CANCELLED з них заборонено FSM.

Файл FSM: `apps/api/src/modules/work-orders/work-orders.fsm.ts`

> **A3:** stock+settlement side-effects переходів винесено з `WorkOrdersService.transition` у
> `WorkOrderStockEffectsService` (`work-order-stock-effects.service.ts`): `reserveParts` /
> `releasePartReservations` / `writeOffPartsAndCharge` / `returnPartsAndCredit`. `transition()` делегує їх,
> передаючи той самий `tx` — ефекти лишаються атомарними зі зміною статусу.

| Перехід                        | Side-effects (у `$transaction`)                                                                                                                                                                                                                                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| → `IN_PROGRESS`                | `InventoryService.createMovement(RESERVATION)` для кожної запчастини (sequential for-loop)                                                                                                                                                                                                                                                        |
| → `COMPLETED`                  | RESERVATION_RELEASE → WRITEOFF → `SettlementsService.createTransaction(CHARGE)` (у цьому порядку)                                                                                                                                                                                                                                                 |
| → `CANCELLED` з IN_PROGRESS    | `InventoryService.createMovement(RESERVATION_RELEASE)` для кожної запчастини                                                                                                                                                                                                                                                                      |
| → `CANCELLED` з ON_HOLD        | `InventoryService.createMovement(RESERVATION_RELEASE)` для кожної запчастини                                                                                                                                                                                                                                                                      |
| → `CANCELLED` з COMPLETED (C2) | `returnPartsAndCredit`: per part `createMovement(RETURN, +baseQty)` (StockItem++ + `returnToBatch` у ті самі партії) → один `SettlementsService.createTransaction(CREDIT_NOTE)` = сума CHARGE. Реверс `writeOffPartsAndCharge`. Резерв НЕ відновлюється (на COMPLETED уже знято). Single-shot через in-tx status re-read + термінальний CANCELLED |

### Константи (з `@sto/shared`)

```typescript
WO_EDITABLE_STATUSES = ['DRAFT', 'ESTIMATE', 'APPROVED'] as readonly WorkOrderStatus[];
WO_SHAREABLE_STATUSES = ['DRAFT', 'ESTIMATE', 'APPROVED'] as readonly WorkOrderStatus[];
WO_INVOICEABLE_STATUSES = ['COMPLETED', 'INVOICED'] as readonly WorkOrderStatus[];
WO_DELETABLE_STATUSES = ['DRAFT', 'CANCELLED'] as readonly WorkOrderStatus[];
```

---

## API Endpoints (`/api/work-orders`)

| Метод  | URL                               | Дія                                               |
| ------ | --------------------------------- | ------------------------------------------------- |
| POST   | `/api/work-orders`                | Створити наряд (lines у body)                     |
| GET    | `/api/work-orders`                | Список (фільтри: status, branchId, q, date range) |
| GET    | `/api/work-orders/:id`            | Деталь з lines + parts                            |
| PATCH  | `/api/work-orders/:id`            | Оновити (WO_EDITABLE_STATUSES)                    |
| POST   | `/api/work-orders/:id/transition` | FSM перехід                                       |
| POST   | `/api/work-orders/:id/clone`      | Клонувати наряд                                   |
| POST   | `/api/work-orders/:id/share`      | Поширити кошторис                                 |
| GET    | `/api/work-orders/:id/parts`      | Запчастини наряду                                 |
| POST   | `/api/work-orders/:id/parts`      | Додати запчастину                                 |
| PATCH  | `/api/work-orders/:id/parts/:pId` | Оновити запчастину                                |
| DELETE | `/api/work-orders/:id/parts/:pId` | Видалити запчастину                               |
| GET    | `/api/work-orders/:id/lines`      | Роботи наряду                                     |
| DELETE | `/api/work-orders/:id`            | Soft-delete (тільки WO_DELETABLE_STATUSES)        |

---

## UI (Web)

| Компонент / сторінка          | Файл                                             |
| ----------------------------- | ------------------------------------------------ |
| Список                        | `app/(app)/work-orders/page.tsx`                 |
| Деталь (картка)               | `app/(app)/work-orders/[id]/PageClient.tsx`      |
| Модалка створення/редагування | `components/ui/CreateWorkOrderModal.tsx`         |
| Detail Panel schema           | `lib/panel-schema.ts` → `WO_PANEL_SCHEMA`        |
| FSM кнопки                    | `components/ui/fsm-buttons.tsx` → `<FSMButtons>` |

**Картка наряду — секції (PageClient.tsx, у порядку рендеру):**

1. Заголовок + статус-бейдж + FSM кнопки
2. Метадані (клієнт, авто, склад, відповідальний)
3. Підсумки (плановані/фактичні години, сума, оплачено)
4. **Акт виконаних робіт** (`WO_INVOICEABLE_STATUSES` гейт)
5. **Рахунок** (`WO_INVOICEABLE_STATUSES` гейт + `invoiceRef !== undefined`) — використовує `INVOICE_STATUS_LABELS` з `@sto/shared`; `InvoiceRef` interface = `{ id, number, status: InvoiceStatus, amount, documentDate }`. Endpoint `/invoices/from-work-order/:id/find` для preload + `POST /invoices/from-work-order/:id` (create) + `/refresh` (DRAFT only) + `/pdf` (download)
6. Роботи (`WorkOrderLinesSection`)
7. Запчастини (`WorkOrderPartsSection`)
8. Огляд авто
9. Медіа
10. Audit log
11. Коментарі

---

## Бізнес-правила (BR-WO)

- **BR-WO-001**: FSM: тільки через `WORK_ORDER_TRANSITIONS` map — ніколи прямий `update({ status })`
- **BR-WO-002**: RESERVATION → RELEASE → WRITEOFF порядок обов'язковий (guard `available >= qty`)
- **BR-WO-003**: WO parts loops — **sequential** for-loop (shared StockItem composite key — unsafe to parallelize)
- **BR-WO-004**: Номер авто-генерується: `DocumentNumberService.next(orgId, 'WorkOrder')`
- **BR-WO-005**: `plannedHours` / `actualHours` — Decimal(8,2), nullable

→ Детально у [docs/BUSINESS-RULES.md](../BUSINESS-RULES.md)

---

## Аспекти і тести, що їх стережуть

Правите один аспект — ганяєте один файл:

```bash
cd apps/api && npx vitest run src/modules/work-orders/<файл>.spec.ts
```

**Модуль:** `apps/api/src/modules/work-orders/`

| Аспект                                  | Тест                                           | Кейсів |
| --------------------------------------- | ---------------------------------------------- | ------ |
| handlers                                | `events/work-order.handlers.spec.ts`           | 10     |
| fsm parity                              | `fsm-parity.spec.ts`                           | 12     |
| статус у чужій транзакції + сторож FSM  | `work-order-status.spec.ts`                    | 19     |
| integration на живій БД                 | `work-order-stock-effects.integration.spec.ts` | 4      |
| сервісна логіка                         | `work-order-stock-effects.service.spec.ts`     | 19     |
| сервісна логіка                         | `work-orders-export.service.spec.ts`           | 4      |
| HTTP-контракт (DTO, статуси, валідація) | `work-orders.contract.spec.ts`                 | 22     |
| HTTP-контракт (DTO, статуси, валідація) | `work-orders.fsm.contract.spec.ts`             | 2      |
| інваріанти (property-based)             | `work-orders.fsm.invariants.spec.ts`           | 16     |
| нумерація (create/clone)                | `work-orders.numbering.spec.ts`                | 2      |
| recalc cap                              | `work-orders.recalc-cap.spec.ts`               | 5      |
| recalc totals                           | `work-orders.recalc-totals.spec.ts`            | 7      |
| рольовий доступ                         | `work-orders.role-gate.spec.ts`                | 24     |
| сервісна логіка                         | `work-orders.service.spec.ts`                  | 23     |
| share public                            | `work-orders.share-public.spec.ts`             | 9      |

Разом: **178** кейсів (цифри з `vitest --reporter=json`, не з grep).

**Розходження з кодом.** Правила, де дос'є каже одне, а код робить інше. Агент цього не «лагодить»: рішення —
виправити код чи переписати правило — за людиною. Поки запис тут, гейт D правило не блокує,
але показує окремим рядком.

- **BR-WO-005** — дос'є: `plannedHours`/`actualHours` — `Decimal(8,2)`, nullable; схема: `Float?`. Nullable-частина правдива й покрита тестами, тип — ні.

**Чого тут НЕМА.** Перевіряти при додаванні нового бізнес-правила — чи з'явився тест.

- Guard `available >= qty` живе в `InventoryService.createMovement` (модуль inventory). Спек порядку рухів наряду відтворює його моком-«журналом»; сам guard на живому складі перевіряє лише `work-order-stock-effects.integration.spec.ts`.
- Порядок рухів доведено на рівні `WorkOrderStockEffectsService`. Наскрізного unit-тесту «`transition()` → правильний метод ефектів» для COMPLETED і CANCELLED немає — лише для входу в IN_PROGRESS.
- Послідовність циклів перевірено для чотирьох методів `WorkOrderStockEffectsService`. Цикли в `recalcTotals` і `clone` рухів складу не створюють і цим не охоплені.
- Сторож прямого запису статусу наряду (`work-order-status.spec.ts`) — regex, не AST: не бачить делегат через псевдонім (`const wo = tx.workOrder`), динамічний делегат (`prisma[model]`, так пише sync push) і сирий SQL зі складеною назвою таблиці. Нелітеральний `data` він вважає порушенням.
- Нумерація: перевірено, що номер береться з `DocumentNumberService`; формат номера й унікальність під конкурентним створенням — зона модуля document-number.
